/**
 * Canonical maturity progression — single source of truth for
 * `nodes.substance->>'maturity_stage'` writes.
 *
 * F12 (rung 12 of VO-FOUNDATION-HARDENING-LADDER-1) consolidates the two
 * pre-existing promotion state machines (`api/scripts/maturity-cycle.ts`
 * and `miners/src/supercron.ts` consolidation block) into this single
 * helper. Thresholds move from hardcoded literals to `graph_state` config
 * keys (with documented defaults) so operators can tune without redeploy.
 *
 * Read-side coalescing (NULL/missing/unknown -> 'encoded') lives in
 * `coalesceMaturityStage()` in `@verity-one/graph-shape`. Throwing belongs
 * at the write boundary (this file), not at read coalescing.
 *
 * The DB-level CHECK constraint `nodes_maturity_stage_check` enforces the
 * canonical 9-stage enum at the storage layer; this helper enforces
 * legal state transitions on top of that.
 */

import type postgres from "postgres";
import {
  VALID_MATURITY_STAGES,
  isValidMaturityStage,
  type KnownMaturityStage,
} from "@verity-one/graph-shape";

type SqlTag = ReturnType<typeof postgres>;

// ── Threshold configuration ─────────────────────────────────────────
// Defaults match the pre-F12 hardcoded behavior in
// `api/scripts/maturity-cycle.ts` and `miners/src/supercron.ts`.
// Operator overrides live in `graph_state` under the `maturity.*` namespace.

export interface MaturityThresholds {
  proven_min_query_hits: number;
  proven_min_success: number;
  graduated_min_query_hits: number;
  graduated_min_success: number;
  consolidated_min_age_days: number;
  consolidated_min_query_hits: number;
}

const DEFAULT_THRESHOLDS: MaturityThresholds = {
  proven_min_query_hits: 20,
  proven_min_success: 3,
  graduated_min_query_hits: 50,
  graduated_min_success: 10,
  consolidated_min_age_days: 7,
  consolidated_min_query_hits: 3,
};

const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as (keyof MaturityThresholds)[];

export async function loadMaturityThresholds(sql: SqlTag): Promise<MaturityThresholds> {
  const namespacedKeys = THRESHOLD_KEYS.map((k) => `maturity.${k}`);
  const rows = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key = ANY(${namespacedKeys}::text[])
  `;
  const overrides = new Map<string, string>(
    rows.map((row: any) => [String(row.key), String(row.value)]),
  );
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of THRESHOLD_KEYS) {
    const raw = overrides.get(`maturity.${k}`);
    if (raw == null) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      out[k] = parsed;
    }
  }
  return out;
}

// ── State machine ──────────────────────────────────────────────────
// Edges:
//   discovery -> encoded
//   encoded -> enriched | consolidated | repair
//   enriched -> proven | repair
//   proven -> graduated | repair
//   graduated -> repair
//   consolidated -> repair | permanent
//   archived -> encoded (operator resurrection)
//   permanent -> repair (operator only)
//   repair -> encoded | enriched | proven | graduated | consolidated
//     (operator clears the flag back into the live progression)
//
// Transitions to `archived` are allowed from any non-terminal stage.
// Transitions to `permanent` are allowed from any non-terminal stage
// (operator-pinned bedrock).

const TRANSITIONS: Record<KnownMaturityStage, ReadonlySet<KnownMaturityStage>> = {
  discovery: new Set(["encoded", "archived", "permanent", "repair"]),
  encoded: new Set(["enriched", "consolidated", "archived", "permanent", "repair"]),
  enriched: new Set(["proven", "archived", "permanent", "repair"]),
  proven: new Set(["graduated", "archived", "permanent", "repair"]),
  graduated: new Set(["archived", "permanent", "repair"]),
  consolidated: new Set(["archived", "permanent", "repair"]),
  archived: new Set(["encoded"]),
  permanent: new Set(["repair"]),
  repair: new Set([...VALID_MATURITY_STAGES.filter((s) => s !== "repair")]),
};

export function isLegalTransition(from: KnownMaturityStage, to: KnownMaturityStage): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.has(to) ?? false;
}

// ── Eligibility (pure) ─────────────────────────────────────────────
// Given a node snapshot + thresholds, returns the next legal target stage
// the node qualifies for, or null if no auto-promotion fires. Used by
// `maturity-cycle.ts` and `supercron.ts` consolidation; pure so it can be
// unit-tested without DB.

export interface MaturityCandidate {
  current: KnownMaturityStage;
  query_hits: number;
  success_count: number;
  failure_count: number;
  has_quick_start: boolean;
  age_days: number;
  is_memory: boolean;
}

export function eligibleMaturityTarget(
  node: MaturityCandidate,
  t: MaturityThresholds,
): KnownMaturityStage | null {
  // Repair fires from any non-terminal stage when failure pressure is high.
  if (
    node.current !== "permanent"
    && node.current !== "repair"
    && node.failure_count >= 3
  ) {
    return "repair";
  }
  // Memory consolidation: encoded memory nodes mature past 7d + 3 hits.
  if (
    node.is_memory
    && node.current === "encoded"
    && node.age_days >= t.consolidated_min_age_days
    && node.query_hits >= t.consolidated_min_query_hits
  ) {
    return "consolidated";
  }
  // Forward progression for non-memory nodes.
  if (
    node.current === "enriched"
    && node.query_hits >= t.proven_min_query_hits
    && node.success_count >= t.proven_min_success
  ) {
    return "proven";
  }
  if (
    node.current === "proven"
    && node.query_hits >= t.graduated_min_query_hits
    && node.success_count >= t.graduated_min_success
    && node.has_quick_start
  ) {
    return "graduated";
  }
  return null;
}

// ── Write ──────────────────────────────────────────────────────────

export class InvalidMaturityTransitionError extends Error {
  constructor(
    public readonly addr: string,
    public readonly from: KnownMaturityStage,
    public readonly to: KnownMaturityStage,
  ) {
    super(`Illegal maturity transition for ${addr}: ${from} -> ${to}`);
    this.name = "InvalidMaturityTransitionError";
  }
}

export interface AdvanceMaturityOpts {
  reason?: string;
  /** When supplied, advanceMaturity uses this transaction handle instead of `sql`. */
  tx?: SqlTag;
  /** Optional Hono context for F9 audit row. If absent, the helper writes a system audit row. */
  c?: any;
}

export interface AdvanceMaturityResult {
  ok: boolean;
  addr: string;
  previous_stage: KnownMaturityStage;
  new_stage: KnownMaturityStage;
  /** False if the node already had `targetStage` (idempotent). */
  changed: boolean;
}

/**
 * Advance a node's maturity_stage to the target. Validates the transition
 * is legal under the F12 state machine. Throws
 * `InvalidMaturityTransitionError` on illegal transitions or non-canonical
 * inputs. Idempotent when the target equals the current stage.
 *
 * Audit semantics: if a Hono context is supplied via `opts.c`, an F9
 * `auditMutation` row is emitted with the request's correlation_id.
 * Without a context, the helper writes a node mutation only — the caller
 * (cron / supercron) is responsible for any system-side audit telemetry.
 */
export async function advanceMaturity(
  sql: SqlTag,
  addr: string,
  targetStage: KnownMaturityStage,
  opts: AdvanceMaturityOpts = {},
): Promise<AdvanceMaturityResult> {
  if (!isValidMaturityStage(targetStage)) {
    throw new InvalidMaturityTransitionError(addr, "encoded", targetStage as any);
  }

  const tx = opts.tx ?? sql;

  const [row] = await tx`
    SELECT substance->>'maturity_stage' AS current_raw
    FROM nodes
    WHERE addr = ${addr}
      AND visibility <> 'deleted'
  `;
  if (!row) {
    throw new Error(`advanceMaturity: node not found: ${addr}`);
  }

  const previous = isValidMaturityStage(row.current_raw)
    ? (row.current_raw as KnownMaturityStage)
    : "encoded";

  if (previous === targetStage) {
    return { ok: true, addr, previous_stage: previous, new_stage: targetStage, changed: false };
  }

  if (!isLegalTransition(previous, targetStage)) {
    throw new InvalidMaturityTransitionError(addr, previous, targetStage);
  }

  await tx`
    UPDATE nodes
    SET substance = jsonb_set(
          COALESCE(substance, '{}'::jsonb),
          '{maturity_stage}',
          to_jsonb(${targetStage}::text),
          true
        ),
        updated_at = now()
    WHERE addr = ${addr}
      AND visibility <> 'deleted'
  `;

  if (opts.c) {
    try {
      const { auditMutation } = await import("./audit");
      await auditMutation(opts.c, sql, {
        kind: "admin_action",
        tenantId:
          (opts.c.get?.("access")?.tenantId as string | undefined)
          ?? process.env.VERITY_DEFAULT_TENANT_ID
          ?? "system",
        actor: (opts.c.get?.("access")?.agentId as string | undefined) ?? "operator",
        operation: "maturity_advance",
        eventData: {
          addr,
          previous_stage: previous,
          new_stage: targetStage,
          ...(opts.reason ? { reason: opts.reason } : {}),
        },
      });
    } catch (e: any) {
      console.error("[maturity] audit emit failed:", e?.message);
    }
  }

  return { ok: true, addr, previous_stage: previous, new_stage: targetStage, changed: true };
}

/**
 * Direct write — bypasses the state-machine check. Reserved for backfills
 * and recovery operators who deliberately need to set a stage outside the
 * legal transitions (e.g., correcting bad data). Drift guard pins this
 * helper as the only allowed bypass; routine code MUST use
 * `advanceMaturity()`.
 */
export async function writeMaturityStage(
  sql: SqlTag,
  addr: string,
  stage: KnownMaturityStage,
): Promise<void> {
  if (!isValidMaturityStage(stage)) {
    throw new Error(`writeMaturityStage: invalid stage ${stage}`);
  }
  await sql`
    UPDATE nodes
    SET substance = jsonb_set(
          COALESCE(substance, '{}'::jsonb),
          '{maturity_stage}',
          to_jsonb(${stage}::text),
          true
        ),
        updated_at = now()
    WHERE addr = ${addr}
      AND visibility <> 'deleted'
  `;
}
