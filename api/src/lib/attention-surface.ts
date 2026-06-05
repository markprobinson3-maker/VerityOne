/**
 * Tenant attention surface (Tier-2 Harness-OS live wiring, LW5 — capstone).
 *
 * Composes the #66 needs-attention aggregator over the producers VO now persists,
 * for the Today/dashboard surface: the LW4 review_proposals ledger (the tenant's open
 * semantic reviews), the supercron quality signal (operator views), and the existing
 * dashboard-overview needs_attention rows — all ranked + deduped under the tenant's
 * #10 policy profile (LW3). This is the rung that makes LW3 + LW4 OBSERVABLE: a single
 * ranked attention feed an operator/agent reads to know "what needs me today".
 *
 * Read-only + additive: it READS review_proposals + supercron_runs + the caller's
 * already-built dashboard rows, and returns a NeedsAttention surface. It writes
 * nothing and applies nothing (aggregateAttention is pure). The existing
 * needs_attention rows are untouched — `attention` is a new field beside them.
 */

import type { Sql } from "postgres";

import {
  aggregateAttention,
  type NeedsAttention,
  type QualityAttentionSignal,
} from "./needs-attention";
import { resolvePolicyProfile } from "./policy-profile";
import { readTenantPolicyProfile, type TenantSettingsSql } from "./tenant-settings";
import { validateReviewPacket, type ReviewPacket, type ReviewQueue } from "./review-queue";

/** Mirror of dashboard-overview's (un-exported) NeedsAttentionRow — the seam #66 folds in. */
export type DashboardAttentionRow = {
  type: string;
  message: string;
  severity: "red" | "amber";
  tab: string;
  filter: string;
  label: string;
};

/** Bound on how many open reviews seed the surface (aggregateAttention then caps again). */
const REVIEW_QUEUE_READ_LIMIT = 50;

function emptyReviewQueue(tenantId: string | null, generatedAt: string): ReviewQueue {
  return {
    tenant_id: tenantId,
    generated_at: generatedAt,
    packets: [],
    budget: { total_micro: 0, allocated_micro: 0, packet_count: 0 },
    dropped: [],
  };
}

/**
 * Reconstruct a #65 ReviewQueue from the tenant's OPEN review_proposals (LW4). Each
 * row's payload IS the persisted ReviewPacket, so the queue is a faithful re-hydration
 * — no re-selection. Tenant-scoped + bounded; worst severity first.
 */
async function loadOpenReviewQueue(
  sql: Sql,
  tenantId: string | null,
  generatedAt: string,
): Promise<ReviewQueue> {
  if (!tenantId) return emptyReviewQueue(tenantId, generatedAt);
  const rows = await sql`
    SELECT payload
    FROM review_proposals
    WHERE tenant_id = ${tenantId} AND status = 'open'
      -- a DEFERRED proposal (OA1) stays 'open' but is snoozed until next_review_at —
      -- exclude it from the attention surface until that time, else defer is a no-op.
      AND (next_review_at IS NULL OR next_review_at <= now())
    ORDER BY (CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END), created_at DESC
    LIMIT ${REVIEW_QUEUE_READ_LIMIT}
  `;
  // Defend the overview against a corrupt/legacy payload: a row whose payload is not a
  // valid #65 packet would make fromReviewPacket throw and 500 the whole endpoint.
  // Validate + skip (never silent) so one bad row degrades to a dropped item, not an
  // outage. LW4 only persists validated packets, so this is defense-in-depth.
  const packets: ReviewPacket[] = [];
  for (const r of rows as any[]) {
    try {
      const packet = r.payload as ReviewPacket;
      if (validateReviewPacket(packet).ok) packets.push(packet);
      else console.warn("[attention-surface] skipped an invalid review_proposals.payload");
    } catch {
      console.warn("[attention-surface] skipped a malformed review_proposals.payload");
    }
  }
  return {
    tenant_id: tenantId,
    generated_at: generatedAt,
    packets,
    budget: { total_micro: 0, allocated_micro: 0, packet_count: packets.length },
    dropped: [],
  };
}

/** Terminal supercron states that are AT LEAST as bad as 'degraded' — error/timeout/
 *  failed grade worse ('red') than degraded ('amber') in supercron-status.ts. The
 *  attention surface must NOT go dark on these (it would hide the worst system health). */
const SUPERCRON_DEGRADED_STATUSES = new Set(["degraded", "error", "timeout", "failed"]);

interface SupercronRunRow {
  status: string;
  degraded_reason: string | null;
  quality_report: { warnings?: unknown; degraded_reason?: unknown } | null;
}

/**
 * PURE: map a supercron run row to a QualityAttentionSignal, or null when the run is
 * healthy. A run is attention-worthy when its status is degraded OR strictly worse
 * (error/timeout/failed), OR it carries a degraded_reason (column or quality_report) —
 * mirroring supercron-status.ts so the surface never goes dark precisely when the
 * maintenance subsystem is most broken.
 */
export function qualitySignalFromRun(row: SupercronRunRow | null | undefined): QualityAttentionSignal | null {
  if (!row) return null;
  const reasonFromReport = typeof row.quality_report?.degraded_reason === "string" ? row.quality_report.degraded_reason : null;
  const degradedReason = (row.degraded_reason ?? reasonFromReport ?? "").trim() || null;
  const isDegraded = SUPERCRON_DEGRADED_STATUSES.has(row.status) || degradedReason !== null;
  if (!isDegraded) return null;
  const warnings = Array.isArray(row.quality_report?.warnings)
    ? (row.quality_report!.warnings as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  return { degraded: true, degraded_reason: degradedReason, warnings };
}

/**
 * The latest supercron cycle's quality signal — non-null only when that cycle is
 * degraded or worse (operator-wide system health). Orders by id DESC to match
 * readSupercronStatus's tie-break (same "latest run" on equal started_at).
 */
async function loadSupercronQualitySignal(sql: Sql): Promise<QualityAttentionSignal | null> {
  const [row] = await sql`
    SELECT status, degraded_reason, quality_report
    FROM supercron_runs
    ORDER BY id DESC
    LIMIT 1
  `;
  return qualitySignalFromRun(row as SupercronRunRow | undefined);
}

export interface AttentionSurfaceOptions {
  tenantId: string | null;
  /** The caller's already-built dashboard needs_attention rows (the existing seam). */
  dashboardRows: DashboardAttentionRow[];
  /** Snapshot anchor. */
  generatedAt: string;
  /** Fold in the operator-wide supercron quality signal (operator views only). */
  includeQuality?: boolean;
}

/**
 * Build the ranked attention surface. Read-only; the only writes-capable thing it
 * touches is nothing — it READS review_proposals + supercron_runs and folds in the
 * supplied dashboard rows, then runs the PURE aggregator under the tenant's policy
 * needs_attention knobs. The three reads run concurrently.
 */
export async function buildAttentionSurface(
  sql: Sql,
  opts: AttentionSurfaceOptions,
): Promise<NeedsAttention> {
  const [profile, reviewQueue, quality] = await Promise.all([
    readTenantPolicyProfile(sql as unknown as TenantSettingsSql, opts.tenantId),
    loadOpenReviewQueue(sql, opts.tenantId, opts.generatedAt),
    opts.includeQuality ? loadSupercronQualitySignal(sql) : Promise.resolve(null),
  ]);
  const policy = resolvePolicyProfile(profile);
  return aggregateAttention(
    { tenantId: opts.tenantId, reviewQueue, quality, dashboardRows: opts.dashboardRows },
    { generatedAt: opts.generatedAt, ...policy.needs_attention },
  );
}
