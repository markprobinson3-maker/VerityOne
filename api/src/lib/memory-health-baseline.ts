/**
 * Memory-health baseline — the scoreboard the persistence ladder repairs against
 * (Memory-Health-Persistence PR 0).
 *
 * A read-only SCOREBOARD that freezes the memory-health model so the later
 * persistence-ladder PRs (SuperCron mutation closure, /memory/update gating,
 * project-association repair, conflict-queue closure, scalable diagnostics) have
 * a stable before/after. The endgame frame: a world-class agentic memory needs a
 * scoreboard that cannot move when the story is inconvenient — otherwise every
 * later "improvement" is just an action count.
 *
 * It draws a hard line the rest of the ladder must respect:
 *
 *   INVARIANTS — registry↔node CONSISTENCY guarantees that MUST read 0. A non-zero
 *   value means a registry row DISAGREES with its node: a lifecycle transition was
 *   half-applied (the node moved but the registry didn't, or vice-versa). These
 *   GATE: `healthy` is false if any invariant is non-zero. They reuse the EXACT SQL
 *   shapes of lifecycle-atomicity.ts's `active_registry_dormant_node` /
 *   `recall_eligible_inactive_registry` torn classes. Both are genuinely 0 on the
 *   live graph — registry/node lifecycle consistency is currently clean.
 *
 *   DEBT — backlog counters that are non-zero TODAY and shrink as the ladder lands.
 *   They are REPORTED, never gated: debt drifts run-to-run and must never be able to
 *   fail a release or a maintenance pass. Treating debt as a gate would make every
 *   later "improvement" a moving target. Three counters:
 *     - projectless_active_memory    — active memory with no project_addr (PR 3
 *       drives it down).
 *     - unresolved_conflicts         — detected conflicts not yet resolved (PR 4).
 *     - live_memory_without_registry — LIVE memory (dormant_at null, live
 *       visibility) with NO registry row at all: lifecycle-UNTRACKED, not torn.
 *       lifecycle-atomicity.ts classifies this as DRIFT (a tolerated baseline), and
 *       it is non-zero on the live graph — e.g. 6 tenant-zero memories written
 *       2026-05-13..19 skipped registry creation (NOT ancient pre-registry: the
 *       registry has rows both before and after those dates). The plan's baseline
 *       SQL measured this as 0 only because it ALSO required substance.tenant_id to
 *       be set; under the canonical space_id scope these untracked memories are real
 *       backfill debt, NOT a hard breach — so it is reported as debt, not gated.
 *       (PR 6 promotes debt into the five-metric snapshot.)
 *     - registry_without_created_event — a registry row with NO `created` memory_event
 *       (the audit ledger cannot replay its creation). Non-zero today (e.g. a
 *       2026-05-13 bulk import that skipped event logging); the MQ ladder backfills a
 *       synthetic created event. Audit-trail debt, NOT a torn state — reported.
 *     - cross_tenant_registry — a registry row whose tenant_id disagrees with its
 *       node's `tenant:<id>` space (a tenant-isolation anomaly). Non-zero today only
 *       from retracted isolation-test pollution; the MQ ladder removes it. Reported as
 *       debt until it reaches 0, after which it can be promoted to a gating invariant
 *       (it must NOT gate while non-zero, or it would fail every release/maintenance
 *       pass the gate guards).
 *
 * Per the Tier-2 rule (classify/normalize OVER existing structures; add NO table,
 * NO write path) this is SELECT-only and returns COUNTS ONLY — never addrs,
 * labels, or substance — so it can run on any operator surface without disclosing
 * private memory content. (lifecycle-atomicity.ts is the companion that returns a
 * bounded identifier SAMPLE for repair targeting; this returns the scoreboard.)
 */

import type { Sql } from "postgres";

// ── Counters ─────────────────────────────────────────────────────────────────

/** Registry↔node CONSISTENCY invariants that MUST read 0; any non-zero gates `healthy`. */
export type MemoryHealthInvariant =
  | "active_registry_dormant_node"
  | "recall_eligible_inactive_registry";

/** The stable, ordered invariant set (a deliberate change pinned by the drift guard). */
export const MEMORY_HEALTH_INVARIANTS: readonly MemoryHealthInvariant[] = [
  "active_registry_dormant_node",
  "recall_eligible_inactive_registry",
] as const;

/** Backlog counters — REPORTED but NEVER gated; they shrink as the ladder lands. */
export type MemoryHealthDebtCounter =
  | "projectless_active_memory"
  | "unresolved_conflicts"
  | "live_memory_without_registry"
  | "registry_without_created_event"
  | "cross_tenant_registry";

/** The stable, ordered debt-counter set (a deliberate change pinned by the drift guard). */
export const MEMORY_HEALTH_DEBT_COUNTERS: readonly MemoryHealthDebtCounter[] = [
  "projectless_active_memory",
  "unresolved_conflicts",
  "live_memory_without_registry",
  "registry_without_created_event",
  "cross_tenant_registry",
] as const;

// ── Report shape ───────────────────────────────────────────────────────────────

export interface MemoryHealthBaseline {
  /** Tenant the baseline was scoped to, or null for an operator-wide scan. */
  tenant_id: string | null;
  /** DB clock at report time (a consistent snapshot anchor). */
  generated_at: string;
  /** Invariant counters — each MUST be 0 in a healthy graph. */
  invariants: Record<MemoryHealthInvariant, number>;
  /** Debt counters — reported only; they NEVER affect `healthy`. */
  debt: Record<MemoryHealthDebtCounter, number>;
  /** True iff EVERY invariant counter is 0. Debt counters NEVER affect this. */
  healthy: boolean;
  /** The non-zero invariants, in declared order (empty iff `healthy`). */
  breached_invariants: MemoryHealthInvariant[];
}

export interface MemoryHealthBaselineOptions {
  /** Scope to one tenant. Omit/null for an operator-wide scan of all tenants. */
  tenantId?: string | null;
}

/**
 * Pure roll-up of raw counters into a baseline. DB-free and deterministic (no
 * clock/random) so the foundation drift guard can exercise the gate logic without
 * a DB. The CONTRACT this pins: `healthy` depends on the invariants ALONE — debt
 * counters can be arbitrarily large without flipping it.
 */
export function summarizeMemoryHealth(
  invariants: Record<MemoryHealthInvariant, number>,
  debt: Record<MemoryHealthDebtCounter, number>,
  meta: { tenant_id: string | null; generated_at: string },
): MemoryHealthBaseline {
  const breached = MEMORY_HEALTH_INVARIANTS.filter((k) => (invariants[k] ?? 0) > 0);
  return {
    tenant_id: meta.tenant_id,
    generated_at: meta.generated_at,
    invariants,
    debt,
    healthy: breached.length === 0,
    breached_invariants: breached,
  };
}

// ── DB-backed scan ───────────────────────────────────────────────────────────

interface BaselineScope {
  /** Restricts registry-keyed SELECTs to the in-scope tenant (`r` alias). */
  regScope: any;
  /** Restricts node-keyed SELECTs to the in-scope memory spaces (`n` alias). */
  nodeScope: any;
  /** Restricts conflict-keyed SELECTs to the in-scope tenant. */
  conflictScope: any;
}

async function countOf(sql: Sql, query: any): Promise<number> {
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM (${query}) sub`;
  return Number(c);
}

/**
 * Compute the memory-health baseline against the live graph. Read-only — runs only
 * SELECTs, mutates nothing, returns COUNTS ONLY (no addrs/labels/content). Scope
 * to a tenant via `opts.tenantId`, or omit it for an operator-wide scan.
 *
 * NOTE on scope: the two gating invariants are registry-keyed (regScope on
 * `r.tenant_id`), so an operator-wide scan counts every tenant's registry rows;
 * drill into a specific tenant to localize a breach. Both invariants are hard
 * zeros on the live graph today (registry/node lifecycle consistency is clean);
 * the debt counters are EXPECTED to be non-zero — that is the backlog the ladder
 * works down.
 */
export async function memoryHealthBaseline(
  sql: Sql,
  opts: MemoryHealthBaselineOptions = {},
): Promise<MemoryHealthBaseline> {
  const tenantId = opts.tenantId ?? null;
  const scope: BaselineScope = {
    regScope: tenantId ? sql`AND r.tenant_id = ${tenantId}` : sql``,
    nodeScope: tenantId
      ? sql`AND n.space_id = ${`tenant:${tenantId}`}`
      : sql`AND n.space_id LIKE 'tenant:%'`,
    conflictScope: tenantId ? sql`AND tenant_id = ${tenantId}` : sql``,
  };

  const [{ now }] = await sql`SELECT clock_timestamp()::text AS now`;

  // Invariant 1 — registry 'active' over a dormant/tombstoned node. Same shape as
  // lifecycle-atomicity.ts's `active_registry_dormant_node` torn class.
  const inv_active_dormant = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.status = 'active'
        AND (n.dormant_at IS NOT NULL OR n.visibility IN ('dormant', 'deleted', 'merged'))
        ${scope.regScope}
    `,
  );

  // Invariant 2 — registry retired (superseded/retracted/archived/expired) but the
  // node is still recall-eligible. Same shape as `recall_eligible_inactive_registry`.
  const inv_recall_eligible_inactive = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.status IN ('superseded', 'retracted', 'archived', 'expired')
        AND n.dormant_at IS NULL
        AND n.visibility NOT IN ('dormant', 'deleted', 'merged')
        ${scope.regScope}
    `,
  );

  // Debt — live memory with NO registry row (lifecycle-UNTRACKED, not torn).
  // Tighter than lifecycle-atomicity's `node_without_registry` drift class:
  // restricted to recall-eligible nodes (dormant_at null, live visibility). It is
  // NON-ZERO on the live graph (e.g. 6 tenant-zero memories from 2026-05-13..19
  // that skipped registry creation), so it is reported as DEBT — a registry-backfill
  // backlog — NOT gated. (The plan's baseline SQL read 0 only because it also
  // required substance.tenant_id to be set; the canonical space scope sees them.)
  const debt_live_without_registry = await countOf(
    sql,
    sql`
      SELECT 1
      FROM nodes n
      LEFT JOIN memory_registry r ON r.addr = n.addr
      WHERE n.node_type = 'memory'
        AND n.dormant_at IS NULL
        AND n.visibility NOT IN ('dormant', 'deleted', 'merged')
        AND r.addr IS NULL
        ${scope.nodeScope}
    `,
  );

  // Debt — projectless active memory: an active-registry, RECALL-ELIGIBLE memory
  // whose substance carries no project_addr. The dormant_at/visibility predicate
  // is required so a dormant-but-active-registry row (already an invariant-1
  // breach) is not ALSO double-counted here. Large today; PR 3 drives it down.
  const debt_projectless = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.status = 'active'
        AND n.dormant_at IS NULL
        AND n.visibility NOT IN ('dormant', 'deleted', 'merged')
        AND COALESCE(n.substance->>'project_addr', '') = ''
        ${scope.regScope}
    `,
  );

  // Debt — unresolved conflicts. An OPEN conflict is `status = 'detected'` — the
  // canonical definition used by getActiveConflicts (memory-lifecycle.ts) and the
  // recall compiler. (resolveConflict sets status='resolved' + resolved_at; a
  // future 'dismissed' transition may set status without resolved_at, so status —
  // not resolved_at — is the authoritative open-signal.) PR 4 drives it down.
  const debt_conflicts = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_conflicts
      WHERE status = 'detected'
        ${scope.conflictScope}
    `,
  );

  // Debt — registry row with NO `created` memory_event (the audit ledger cannot
  // replay its creation). NOT EXISTS over the matching addr+tenant created event,
  // scoped to the in-scope tenant's registry rows. MQ ladder backfills a synthetic
  // created event for these. Audit-trail debt, not a torn state.
  const debt_registry_without_created = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_registry r
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_events e
        WHERE e.addr = r.addr AND e.tenant_id = r.tenant_id AND e.event_type = 'created'
      )
      ${scope.regScope}
    `,
  );

  // Debt — cross-tenant registry: a registry row whose tenant_id disagrees with its
  // node's `tenant:<id>` space (registry.tenant_id <> the node's owning tenant). A
  // tenant-isolation anomaly. Scoped by the NODE space (so a tenant scan surfaces
  // foreign registry rows polluting THEIR nodes). MQ ladder removes these.
  const debt_cross_tenant_registry = await countOf(
    sql,
    sql`
      SELECT 1
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE n.space_id LIKE 'tenant:%'
        AND n.space_id <> ('tenant:' || r.tenant_id)
        ${scope.nodeScope}
    `,
  );

  // The SQL-to-key wiring below (which counter feeds which key) is pinned by the
  // LIVE per-invariant/per-debt fixtures in memory-health-baseline.test.ts — the
  // DB-free drift guard only pins the key SETS and the pure gate logic.
  return summarizeMemoryHealth(
    {
      active_registry_dormant_node: inv_active_dormant,
      recall_eligible_inactive_registry: inv_recall_eligible_inactive,
    },
    {
      projectless_active_memory: debt_projectless,
      unresolved_conflicts: debt_conflicts,
      live_memory_without_registry: debt_live_without_registry,
      registry_without_created_event: debt_registry_without_created,
      cross_tenant_registry: debt_cross_tenant_registry,
    },
    { tenant_id: tenantId, generated_at: now as string },
  );
}
