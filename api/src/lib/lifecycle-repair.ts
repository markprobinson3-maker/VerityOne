/**
 * Operator/tenant lifecycle repair — reconcile a torn registry↔node pair (Operator-Apply
 * ladder, OA4).
 *
 * lifecycle-atomicity.ts gates TWO torn classes (both must stay 0):
 *   - active_registry_dormant_node  (inv1): memory_registry.status='active' but the node is
 *     already dead (dormant_at set, or visibility dormant/deleted/merged). Recall ALREADY
 *     excludes the dead node, so the only thing wrong is the registry bookkeeping. The safe
 *     repair is to PARK the registry at a terminal status ('archived') so the two agree.
 *     NON-destructive: nothing live is hidden — the memory was already gone from recall.
 *   - recall_eligible_inactive_registry (inv2): registry retired but the node is still
 *     recall-eligible. This is AMBIGUOUS and has NO auto-safe repair: restoring the registry
 *     to 'active' could resurrect a deliberately-superseded memory, and dormant-ing the live
 *     node is destructive. OA4 deliberately REFUSES inv2 (requires_decision) and routes the
 *     operator to the destructive retire rung for a per-item choice.
 *
 * So OA4 auto-repairs inv1 ONLY, registry-side ONLY (via updateRegistryStatus + a logged
 * 'archived' event) — it never mutates a node. Tenant-scoped, dry-run-FIRST (the caller must
 * pass dry_run:false to apply), and idempotent (the apply re-checks the torn predicate inside
 * the tx, so a concurrent change can never land a stale repair).
 */

import type { Sql } from "postgres";

import { logEvent, updateRegistryStatus } from "./memory-lifecycle";

/** The terminal status the inv1 repair parks a dead node's registry at. 'archived' = retired
 *  without claiming a successor; precise supersession linkage is the SuperCron
 *  registry-reconciliation proposal path's job (it reads memory_events). */
export const LIFECYCLE_REPAIR_TERMINAL_STATUS = "archived" as const;

/** The two ways to resolve an inv2 (retired-registry-over-live-node) torn pair. OA4 does NOT
 *  apply either — they are ROUTING HINTS surfaced with a requires_decision result so the
 *  operator can take the choice to the destructive retire rung (restore the registry to
 *  active, or dormant the live node). Canonical list lives here so the route never drifts. */
export const REPAIR_DECISION_OPTIONS = ["restore_registry_active", "retire_node_dormant"] as const;

export type LifecycleTornClass =
  | "active_registry_dormant_node"
  | "recall_eligible_inactive_registry"
  | "consistent";

/** PURE: classify the registry↔node pair. retired = any non-active registry status; a node is
 *  "dead" when dormant_at is set or its visibility is dormant/deleted/merged (the exact
 *  lifecycle-atomicity predicate). */
export function classifyLifecycle(opts: { registryStatus: string; nodeDead: boolean }): LifecycleTornClass {
  const retired = opts.registryStatus !== "active";
  if (opts.registryStatus === "active" && opts.nodeDead) return "active_registry_dormant_node";
  if (retired && !opts.nodeDead) return "recall_eligible_inactive_registry";
  return "consistent";
}

export interface RepairPlan {
  torn_class: LifecycleTornClass;
  from_status: string;
  /** the registry status the repair would set; null when there is no safe auto-repair
   *  (inv2 / already-consistent). */
  to_status: string | null;
}

export type RepairOutcome =
  | "dry_run"            // inv1 detected; preview only (no mutation)
  | "repaired"           // inv1 applied (registry parked at the terminal status)
  | "already_consistent" // not torn (or a concurrent change healed it before apply)
  | "requires_decision"; // inv2 — ambiguous, routed to the destructive retire rung

export type RepairMemoryResult =
  | { ok: true; outcome: RepairOutcome; plan: RepairPlan }
  | { ok: false; reason: "not_found" };

/**
 * Detect the torn class for ONE addr in `tenantId` and (for inv1, when not a dry run) apply
 * the safe registry reconciliation. Tenant-scoped — a caller can only repair its OWN tenant's
 * memory; an addr with no registry row in the tenant is not_found. Never mutates a node.
 */
export async function repairMemoryLifecycle(
  sql: Sql,
  opts: { addr: string; tenantId: string; dryRun: boolean; repairedBy: string },
): Promise<RepairMemoryResult> {
  // INNER JOIN by design: OA4 only reconciles inv1/inv2, both of which require a registry AND
  // a node. A registry-without-node orphan (a third corruption class) simply falls through to
  // not_found here — out of scope for this rung, not silently mis-repaired.
  const [row] = await sql`
    SELECT r.status AS registry_status,
           (n.dormant_at IS NOT NULL OR n.visibility IN ('dormant', 'deleted', 'merged')) AS node_dead
    FROM memory_registry r
    JOIN nodes n ON n.addr = r.addr
    WHERE r.addr = ${opts.addr} AND r.tenant_id = ${opts.tenantId}
  `;
  if (!row) return { ok: false, reason: "not_found" };

  const tornClass = classifyLifecycle({ registryStatus: row.registry_status, nodeDead: row.node_dead });

  if (tornClass === "consistent") {
    return { ok: true, outcome: "already_consistent", plan: { torn_class: tornClass, from_status: row.registry_status, to_status: null } };
  }
  if (tornClass === "recall_eligible_inactive_registry") {
    return { ok: true, outcome: "requires_decision", plan: { torn_class: tornClass, from_status: row.registry_status, to_status: null } };
  }

  // inv1 — safe registry reconciliation.
  const plan: RepairPlan = { torn_class: tornClass, from_status: row.registry_status, to_status: LIFECYCLE_REPAIR_TERMINAL_STATUS };
  if (opts.dryRun) return { ok: true, outcome: "dry_run", plan };

  let applied = false;
  await sql.begin(async (tx: any) => {
    // Re-check the inv1 predicate INSIDE the tx — idempotent: if a concurrent change already
    // healed it (registry no longer active, or node came back), we write nothing.
    const guard = await tx`
      SELECT 1
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.addr = ${opts.addr} AND r.tenant_id = ${opts.tenantId}
        AND r.status = 'active'
        AND (n.dormant_at IS NOT NULL OR n.visibility IN ('dormant', 'deleted', 'merged'))
    `;
    if (guard.length === 0) return;
    await updateRegistryStatus(tx as Sql, opts.addr, opts.tenantId, LIFECYCLE_REPAIR_TERMINAL_STATUS);
    await logEvent(tx as Sql, opts.addr, opts.tenantId, "archived", opts.repairedBy, {
      reason: "lifecycle_repair",
      torn_class: tornClass,
      from_status: plan.from_status,
    });
    applied = true;
  });

  return { ok: true, outcome: applied ? "repaired" : "already_consistent", plan };
}
