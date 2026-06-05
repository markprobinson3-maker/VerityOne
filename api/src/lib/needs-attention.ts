/**
 * Needs-Attention aggregator — the single ranked "what needs attention right now"
 * operator surface (Tier-2 harness-first OS, PR 7: contract-first, NO new table).
 *
 * The plan asks for ONE surface that tells an operator what needs attention in
 * under 60 seconds. This module covers the ACTION-NEEDED signals the plan names —
 * conflicts, stale high-value memories, pending approvals, failed workflows,
 * low-confidence routes, and degraded routine outputs — each of which VO already
 * computes. #65's `selectReviewQueue` already produces a ranked, deduped,
 * severity-floored feed for the memory-side axes (conflicts, lifecycle tears,
 * stale, source-promotion, edge quality). (The plan's "recent decisions" panel is
 * recent-ACTIVITY context, not something that needs action — it belongs with the
 * briefing / activity surfaces and is intentionally NOT lifted here.) Per the
 * Tier-2 rule ("classify/normalize OVER existing structures;
 * do NOT add redundant tables") this module is a PURE, DETERMINISTIC aggregator
 * that lifts those ALREADY-COMPUTED outputs into one canonical, ranked
 * `AttentionItem[]`. It adds NO store, NO route, and NO LLM call.
 *
 * It COMPOSES the lower primitives rather than re-deriving them:
 *   - #65 `ReviewQueue` packets   → the memory-side review axes (do NOT re-map
 *     conflicts/atomicity/stale directly — that double-counts and undoes the
 *     drift/precision filtering the review queue already did)
 *   - #64 `WorkflowRun`           → failed / rejected / expired / pending-approval runs
 *   - degraded `QualityReport`    → degraded maintenance routine
 *   - degraded `RecallResult` posture → low-confidence routes
 *   - the existing `NeedsAttentionRow` dashboard seams → folded in, not replaced
 *
 * `AttentionItem` is a SUPERSET of dashboard-overview.ts's `NeedsAttentionRow`
 * (it keeps `message` + a `nav` target so the existing "Needs Attention" card
 * renders) plus the Tier-2 dimensions (source primitive, category, identifier-only
 * `addrs`, recommended action, approval). It reuses #65's `ReviewSeverity` /
 * `ReviewApproval` vocabularies (the dominant Tier-2 axes) and #60's typed-unknown
 * vocabulary. Identifier-only output (addrs, never memory content). The actual
 * route wiring (feeding `getDashboardOverview` / a `/today` surface) is DEFERRED.
 */

import { createHash } from "node:crypto";
import { EVENT_UNKNOWN_REASONS, type EventUnknownReason } from "./event-envelope";
import {
  REVIEW_APPROVALS,
  REVIEW_SEVERITIES,
  type ReviewApproval,
  type ReviewKind,
  type ReviewPacket,
  type ReviewQueue,
  type ReviewSeverity,
} from "./review-queue";
import type { WorkflowRun } from "./workflow-run";

// ── Vocabularies ──────────────────────────────────────────────────────────────

/** Severity / approval reuse #65's axes verbatim — one vocabulary across Tier-2. */
export type AttentionSeverity = ReviewSeverity; // "high" | "medium" | "low"
export type AttentionApproval = ReviewApproval; // "auto" | "recommended" | "required"

/** Which primitive (or existing surface) produced an item — its provenance. */
export type AttentionSource =
  | "review_queue"   // a #65 ReviewPacket
  | "workflow_run"   // a #64 WorkflowRun
  | "recall"         // a degraded/research_needed RecallResult
  | "quality_report" // a degraded supercron QualityReport
  | "dashboard";     // an existing dashboard-overview NeedsAttentionRow seam

export const ATTENTION_SOURCES: readonly AttentionSource[] = [
  "review_queue", "workflow_run", "recall", "quality_report", "dashboard",
] as const;

/** The operator panel an item belongs to (the plan PR7 panels). */
export type AttentionCategory =
  | "conflict"
  | "stale"
  | "pending_approval"
  | "failed_workflow"
  | "low_confidence"
  | "degraded_routine"
  | "review"
  | "system";

export const ATTENTION_CATEGORIES: readonly AttentionCategory[] = [
  "conflict", "stale", "pending_approval", "failed_workflow",
  "low_confidence", "degraded_routine", "review", "system",
] as const;

/** Why a candidate item did NOT make the surface — caps are never silent. */
export type AttentionDropReason = "duplicate" | "below_severity_floor" | "over_cap" | "corrupt_item";
export const ATTENTION_DROP_REASONS: readonly AttentionDropReason[] = [
  "duplicate", "below_severity_floor", "over_cap", "corrupt_item",
] as const;

// ── The item ─────────────────────────────────────────────────────────────────

/** Navigation target so the existing dashboard "Needs Attention" card stays clickable. */
export interface AttentionNav {
  tab: string;
  filter: string;
  label: string;
}

export interface AttentionItem {
  source: AttentionSource;
  category: AttentionCategory;
  severity: AttentionSeverity;
  /** Operator-readable summary. Identifier-only — never memory content. */
  message: string;
  /** Owning tenant. Null only with a matching `unknowns.tenant_id` reason. */
  tenant_id: string | null;
  /** Identifier-only scope (addrs / node refs). May be empty for operator-wide signals. */
  addrs: string[];
  /** What the operator should do about it. */
  recommended_action: string;
  approval: AttentionApproval;
  /** Dashboard navigation target, or null for items without one. */
  nav: AttentionNav | null;
  /** Natural dedup token; cryptographic key via attentionItemIdempotencyKey(). */
  idempotency_key: string;
  unknowns: {
    tenant_id?: EventUnknownReason;
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

export interface AttentionDrop {
  reason: AttentionDropReason;
  count: number;
}

export interface NeedsAttention {
  tenant_id: string | null;
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generated_at: string;
  /** Ranked: severity, then source, then idempotency key. */
  items: AttentionItem[];
  by_severity: Record<AttentionSeverity, number>;
  by_category: Record<AttentionCategory, number>;
  /** What was excluded and why — caps are never silent. */
  dropped: AttentionDrop[];
}

// ── Construction ─────────────────────────────────────────────────────────────

export interface BuildAttentionItemInput {
  source: AttentionSource;
  category: AttentionCategory;
  severity: AttentionSeverity;
  message: string;
  idempotency_key: string;
  tenant_id?: string | null;
  addrs?: string[];
  recommended_action?: string;
  approval?: AttentionApproval;
  nav?: AttentionNav | null;
  unknowns?: AttentionItem["unknowns"];
}

/**
 * Build an AttentionItem with conservative defaults: approval `auto`, no nav, no
 * addrs. Null tenant gets a default typed reason so the validator passes for a
 * genuinely operator-wide signal (a degraded routine, a broken recall path).
 */
export function buildAttentionItem(input: BuildAttentionItemInput): AttentionItem {
  const tenant_id = input.tenant_id ?? null;
  const unknowns: AttentionItem["unknowns"] = { ...(input.unknowns ?? {}) };
  if (tenant_id === null && unknowns.tenant_id === undefined) unknowns.tenant_id = "not_applicable";

  return {
    source: input.source,
    category: input.category,
    severity: input.severity,
    message: input.message,
    tenant_id,
    addrs: input.addrs ? [...input.addrs] : [], // copy — never alias the caller's array
    recommended_action: input.recommended_action ?? "Review this item.",
    approval: input.approval ?? "auto",
    nav: input.nav ?? null,
    idempotency_key: input.idempotency_key,
    unknowns,
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

function normalizeKeyPart(label: string, value: string): string {
  const trimmed = (value ?? "").normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError(`needs-attention ${label} must be a bounded non-empty string without NUL bytes.`);
  }
  return trimmed;
}

/**
 * Deterministic dedup key (sha256 hex), scoped by tenant + source + natural token.
 * Two items with the same tenant, source, and token hash identically, so the same
 * concern never surfaces twice within a tenant — while two different sources that
 * happen to share a token stay distinct. Mirrors workflowRunIdempotencyKey.
 */
export function attentionItemIdempotencyKey(item: AttentionItem): string {
  const scope = item.tenant_id ? normalizeKeyPart("tenant_id", item.tenant_id) : "global";
  const source = normalizeKeyPart("source", item.source);
  const key = normalizeKeyPart("idempotency_key", item.idempotency_key);
  const seed = [scope, source, key].join("\x00");
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface AttentionItemValidation {
  ok: boolean;
  errors: string[];
}

/** Hard ceiling on addrs one item may carry — keeps an item's scope identifier-bounded. */
export const MAX_ATTENTION_ADDRS = 8;

function isCleanAddr(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.normalize("NFC").trim();
  return trimmed.length > 0 && !value.includes("\0") && value.length <= 256;
}

/**
 * Validate an AttentionItem's contract: enum/shape checks, a bounded
 * identifier-only addr set, a well-formed nav target, and the core invariant that
 * tenant_id may be null ONLY with a typed `unknowns` reason.
 */
export function validateAttentionItem(item: AttentionItem): AttentionItemValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  inEnum(item.source, ATTENTION_SOURCES, "source");
  inEnum(item.category, ATTENTION_CATEGORIES, "category");
  inEnum(item.severity, REVIEW_SEVERITIES, "severity");
  inEnum(item.approval, REVIEW_APPROVALS, "approval");

  if (!item.message) errors.push("message is required");
  if (!item.recommended_action) errors.push("recommended_action is required");
  if (!item.idempotency_key) errors.push("idempotency_key is required");

  // Scope — identifier-only and bounded. May be empty (operator-wide signals).
  if (!Array.isArray(item.addrs)) {
    errors.push("addrs must be an array");
  } else if (item.addrs.length > MAX_ATTENTION_ADDRS) {
    errors.push(`addrs exceeds the ${MAX_ATTENTION_ADDRS} ceiling`);
  } else if (!item.addrs.every(isCleanAddr)) {
    errors.push("addrs must all be bounded, non-empty, NUL-free strings");
  }

  if (item.nav !== null) {
    if (!item.nav || !item.nav.tab || !item.nav.filter || !item.nav.label) {
      errors.push("nav must be null or carry tab/filter/label");
    }
  }

  if (item.tenant_id === null) {
    const reason = item.unknowns?.tenant_id;
    if (!reason) errors.push("tenant_id is null without an unknowns.tenant_id reason");
    else if (!EVENT_UNKNOWN_REASONS.includes(reason)) errors.push(`unknowns.tenant_id "${reason}" is not a valid reason`);
  }

  return { ok: errors.length === 0, errors };
}

// ── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_RANK: Record<AttentionSource, number> = {
  workflow_run: 0, review_queue: 1, quality_report: 2, recall: 3, dashboard: 4,
};

/** Rank a severity with a safe fallback so an unexpected value never yields NaN. */
function severityRank(s: AttentionSeverity): number {
  return SEVERITY_RANK[s] ?? SEVERITY_RANK.low;
}

/**
 * Collapse the 3-level attention severity onto the existing dashboard card's
 * 2-level red|amber so the "Needs Attention" UI keeps rendering unchanged.
 */
export function attentionSeverityToDashboard(severity: AttentionSeverity): "red" | "amber" {
  return severity === "high" ? "red" : "amber";
}

// ── Mappers: lift already-computed primitive outputs into AttentionItems ───────

const REVIEW_KIND_TO_CATEGORY: Record<ReviewKind, AttentionCategory> = {
  contradiction_review: "conflict",
  stale_conflict_review: "stale",
  edge_quality_review: "review",
  source_promotion_review: "review",
};

/**
 * Lift a #65 ReviewPacket into an AttentionItem. Severity and approval pass
 * through verbatim (same vocabularies); the reason is already identifier-only.
 * The packet's idempotency_key is the natural dedup token.
 */
export function fromReviewPacket(packet: ReviewPacket): AttentionItem {
  const category = REVIEW_KIND_TO_CATEGORY[packet.review_kind] ?? "review";
  return buildAttentionItem({
    source: "review_queue",
    category,
    severity: packet.severity,
    message: packet.reason,
    tenant_id: packet.scope.tenant_id,
    addrs: packet.scope.target_addrs.slice(0, MAX_ATTENTION_ADDRS), // self-bounding, independent of #65's cap
    recommended_action: `Review (${packet.verification.approval} approval): ${packet.output_schema.verdicts.join(" / ")}`,
    approval: packet.verification.approval,
    nav: { tab: "review", filter: packet.review_kind, label: "Review" },
    idempotency_key: packet.idempotency_key,
    unknowns: packet.unknowns,
  });
}

/**
 * Lift a #64 WorkflowRun into an AttentionItem — but ONLY when it needs attention:
 * a failed/rejected run (high), an expired run (medium), or a run awaiting
 * approval (medium). Healthy / in-flight / cancelled runs return null. A terminal
 * failure takes precedence over a stale pending-approval state (you investigate it,
 * you do not approve it), so approval is tied to the chosen branch — only a genuine
 * pending-approval item asks for sign-off. Message is identifier-only (kind + run
 * id + status), never the run's free-text label.
 */
export function fromWorkflowRun(run: WorkflowRun): AttentionItem | null {
  const isError = run.status === "failed" || run.status === "rejected";
  const isExpired = run.status === "expired";
  const isPendingApproval = run.approval_state === "pending";

  let category: AttentionCategory;
  let severity: AttentionSeverity;
  let action: string;
  let approval: AttentionApproval;
  if (isError) {
    category = "failed_workflow"; severity = "high"; approval = "auto";
    action = `Investigate the ${run.status} ${run.source_ledger} run.`;
  } else if (isExpired) {
    category = "failed_workflow"; severity = "medium"; approval = "auto";
    action = "The run expired before completing — re-issue it if still needed.";
  } else if (isPendingApproval) {
    category = "pending_approval"; severity = "medium"; approval = "required";
    action = "Approve or reject this pending run.";
  } else {
    return null; // healthy, in-flight, cancelled, or succeeded — not attention
  }

  // Carry only node-ref artifacts as identifier-only scope.
  const addrs = run.artifacts.filter((a) => a.kind === "node").map((a) => a.ref).slice(0, MAX_ATTENTION_ADDRS);

  return buildAttentionItem({
    source: "workflow_run",
    category,
    severity,
    message: `${run.kind} run ${run.run_id} (${run.source_ledger}) is ${run.status}`,
    tenant_id: run.tenant_id,
    addrs,
    recommended_action: action,
    approval,
    nav: null,
    idempotency_key: `workflow_run:${run.source_ledger}:${run.run_id}`,
    unknowns: run.tenant_id === null ? { tenant_id: run.unknowns?.tenant_id ?? "not_applicable" } : {},
  });
}

export interface RecallAttentionSignal {
  /** RecallResult.explanation.posture (a fixed enum — safe to surface). The
   *  free-text posture_note is deliberately NOT accepted: it is never echoed, so
   *  the identifier-only contract cannot be broken by a content-bearing field. */
  posture: string;
}

/**
 * Lift a degraded recall posture into a low-confidence-route attention item.
 * `degraded` (recall broke) is high; `research_needed` (weak coverage) is low.
 * Other postures return null. Per-query/ephemeral — the caller passes the recall
 * it wants surfaced. Message is templated (never echoes the query text).
 */
export function fromRecallPosture(signal: RecallAttentionSignal, tenantId: string | null): AttentionItem | null {
  if (signal.posture !== "degraded" && signal.posture !== "research_needed") return null;
  const degraded = signal.posture === "degraded";
  return buildAttentionItem({
    source: "recall",
    category: "low_confidence",
    severity: degraded ? "high" : "low",
    message: `recall posture is "${signal.posture}"`,
    tenant_id: tenantId,
    addrs: [],
    recommended_action: degraded
      ? "Recall could not ground — investigate the recall path before relying on results."
      : "Weak memory coverage — gather fresh evidence before acting.",
    approval: "auto",
    nav: null,
    idempotency_key: `recall:${signal.posture}`,
  });
}

export interface QualityAttentionSignal {
  degraded: boolean;
  degraded_reason?: string | null;
  warnings?: string[];
}

/**
 * Lift a degraded supercron QualityReport into attention items — one per warning
 * (an `absolute_invariant_breach:*` warning is high, the rest medium). Falls back
 * to a single headline item from degraded_reason when no warnings are listed.
 * Returns [] when the report is not degraded. Operator-wide (no addr scope).
 */
export function fromQualityReport(signal: QualityAttentionSignal, tenantId: string | null): AttentionItem[] {
  if (!signal.degraded) return [];
  const warnings = signal.warnings ?? [];
  const make = (severity: AttentionSeverity, message: string, key: string) =>
    buildAttentionItem({
      source: "quality_report",
      category: "degraded_routine",
      severity,
      message,
      tenant_id: tenantId,
      addrs: [],
      recommended_action: "Inspect the degraded maintenance run before scheduling another mutating cycle.",
      approval: "auto",
      nav: null,
      idempotency_key: key,
    });

  if (warnings.length === 0) {
    return [make("medium", signal.degraded_reason || "maintenance routine degraded", "quality_report:degraded")];
  }
  // Dedup identical warnings at the source (Set preserves first-seen order → deterministic).
  return [...new Set(warnings)].map((w) =>
    make(w.startsWith("absolute_invariant_breach:") ? "high" : "medium", w, `quality_report:${w}`),
  );
}

/**
 * Fold an existing dashboard-overview `NeedsAttentionRow` into the canonical
 * shape so the ~20 honest dashboard seams join the same ranked surface (red→high,
 * amber→medium). The row's message/nav are already operator-safe.
 */
export function fromNeedsAttentionRow(
  row: { type: string; message: string; severity: "red" | "amber"; tab: string; filter: string; label: string },
  tenantId: string | null,
): AttentionItem {
  return buildAttentionItem({
    source: "dashboard",
    category: "system",
    severity: row.severity === "red" ? "high" : "medium",
    message: row.message,
    tenant_id: tenantId,
    addrs: [],
    recommended_action: row.label,
    approval: "auto",
    nav: { tab: row.tab, filter: row.filter, label: row.label },
    // type+filter so genuinely distinct seams (e.g. per-project rows) don't collapse.
    idempotency_key: `dashboard:${row.type}:${row.filter}`,
  });
}

// ── Aggregator ───────────────────────────────────────────────────────────────

export interface NeedsAttentionInput {
  tenantId: string | null;
  /** A #65 ReviewQueue (its packets are lifted; do NOT also pass the raw sources). */
  reviewQueue?: ReviewQueue | null;
  /** #64 WorkflowRuns (healthy ones are filtered out). */
  workflowRuns?: WorkflowRun[];
  /** A degraded recall posture to surface (per-query). */
  recall?: RecallAttentionSignal | null;
  /** A degraded supercron QualityReport. */
  quality?: QualityAttentionSignal | null;
  /** Existing dashboard-overview needs_attention rows to fold in. */
  dashboardRows?: Array<{ type: string; message: string; severity: "red" | "amber"; tab: string; filter: string; label: string }>;
}

export interface NeedsAttentionOptions {
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generatedAt: string;
  /** Hard cap on surfaced items (default 50). */
  maxItems?: number;
  /** Drop items below this severity (default "low" = keep all). */
  severityFloor?: AttentionSeverity;
}

const DEFAULT_MAX_ITEMS = 50;

function finiteOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value as number) ? Math.max(0, Math.trunc(value as number)) : fallback;
}

/**
 * Aggregate already-computed primitive outputs into ONE ranked AttentionItem[].
 * PURE — never touches the DB, never calls an LLM, never mutates the input. It
 * composes #65's ReviewQueue (it does NOT re-map the raw memory sources, which
 * would double-count), adds the two axes the queue does not cover (workflow runs
 * + degraded routine/recall), folds in the existing dashboard seams, dedups by
 * idempotency key, ranks by severity, and caps with a typed `dropped` tally —
 * so the same inputs always yield the same surface.
 */
export function aggregateAttention(input: NeedsAttentionInput, opts: NeedsAttentionOptions): NeedsAttention {
  const maxItems = finiteOption(opts.maxItems, DEFAULT_MAX_ITEMS);
  const severityFloor = opts.severityFloor ?? "low";
  const tenantId = input.tenantId;

  const drops: Record<AttentionDropReason, number> = { duplicate: 0, below_severity_floor: 0, over_cap: 0, corrupt_item: 0 };

  // 1. Lift every producer into candidate items. A corrupt persisted packet (e.g. a
  //    hand-edited review_proposals.payload with an empty/NUL/over-long idempotency_key,
  //    which validateReviewPacket does NOT bound) must not throw out of this PURE,
  //    "never throws" aggregator — it is dropped + tallied (corrupt_item), never silent.
  const candidates: AttentionItem[] = [];
  for (const p of input.reviewQueue?.packets ?? []) {
    try { candidates.push(fromReviewPacket(p)); }
    catch { drops.corrupt_item++; }
  }
  for (const run of input.workflowRuns ?? []) {
    const item = fromWorkflowRun(run);
    if (item) candidates.push(item);
  }
  if (input.recall) {
    const item = fromRecallPosture(input.recall, tenantId);
    if (item) candidates.push(item);
  }
  if (input.quality) candidates.push(...fromQualityReport(input.quality, tenantId));
  for (const row of input.dashboardRows ?? []) candidates.push(fromNeedsAttentionRow(row, tenantId));

  // 2. Severity floor.
  const floorRank = severityRank(severityFloor);
  const aboveFloor = candidates.filter((it) => {
    if (severityRank(it.severity) <= floorRank) return true;
    drops.below_severity_floor++;
    return false;
  });

  // 3. Stable total order: severity, then source, then idempotency key.
  aboveFloor.sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    const src = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (src !== 0) return src;
    return a.idempotency_key < b.idempotency_key ? -1 : a.idempotency_key > b.idempotency_key ? 1 : 0;
  });

  // 4. Dedup by idempotency key, then cap. Both tallied — never silent.
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const it of aboveFloor) {
    // Dedup on the tenant+source+token sha256 (not the raw token) so the documented
    // scoping actually governs collapsing — and cross-source token clashes stay distinct.
    // A corrupt idempotency token throws in normalizeKeyPart; drop + tally rather than
    // letting one bad item throw the whole surface (the "never throws" contract).
    let key: string;
    try { key = attentionItemIdempotencyKey(it); }
    catch { drops.corrupt_item++; continue; }
    if (seen.has(key)) { drops.duplicate++; continue; }
    if (items.length >= maxItems) { drops.over_cap++; continue; }
    seen.add(key);
    items.push(it);
  }

  const by_severity: Record<AttentionSeverity, number> = { high: 0, medium: 0, low: 0 };
  const by_category: Record<AttentionCategory, number> = {
    conflict: 0, stale: 0, pending_approval: 0, failed_workflow: 0,
    low_confidence: 0, degraded_routine: 0, review: 0, system: 0,
  };
  for (const it of items) {
    by_severity[it.severity]++;
    by_category[it.category]++;
  }

  const dropped: AttentionDrop[] = ATTENTION_DROP_REASONS
    .filter((r) => drops[r] > 0)
    .map((r) => ({ reason: r, count: drops[r] }));

  return { tenant_id: tenantId, generated_at: opts.generatedAt, items, by_severity, by_category, dropped };
}
