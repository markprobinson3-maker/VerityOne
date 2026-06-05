/**
 * Lifecycle atomicity report (Tier-2 PR3).
 *
 * A memory write is atomic across three structures that MUST move together:
 *   - the graph `nodes` row (node_type='memory', visibility/dormant_at),
 *   - the `memory_registry` row (status, supersession, expiry, tenant_id),
 *   - the `memory_events` ledger (every lifecycle step logs an event).
 *
 * `transitionMemoryLifecycleInTx` (./memory-lifecycle.ts) moves all three in
 * one transaction, so in a healthy graph they never disagree. A *torn*
 * transition — a crash, a partial migration, a direct DB edit, or a bug — leaves
 * them inconsistent: a registry that says "retracted" over a node that recall
 * still serves, an active registry over a tombstoned node, a memory with no
 * event trail, a registry whose tenant no longer matches its node's space.
 *
 * Per the Tier-2 rule ("classify/normalize OVER existing structures; do NOT add
 * redundant tables") this module adds NO table and NO write path. It is a
 * read-only diagnostic: a set of SELECTs over the existing structures, each
 * proving one atomicity invariant, returning counts + a bounded sample of
 * offending addresses. The sample carries IDENTIFIERS ONLY (addr + tenant_id) —
 * never label/substance/description — so an operator surface can show it without
 * disclosing private memory content. Repair is a deliberate, audited follow-up;
 * this report is the evidence that drives it.
 */

import type { Sql } from "postgres";

// ── Classes ──────────────────────────────────────────────────────────────────

/** The atomicity invariants this report checks (one read-only SELECT each). */
export type AtomicityClass =
  | "node_without_registry"
  | "registry_without_node"
  | "active_registry_dormant_node"
  | "recall_eligible_inactive_registry"
  | "node_visibility_dormancy_mismatch"
  | "missing_lifecycle_events"
  | "expired_not_transitioned"
  | "tenant_space_mismatch"
  | "superseded_without_successor"
  | "asymmetric_supersession";

/**
 * How serious a non-zero count is:
 *   - `invariant`: a foreign-key/structural guarantee that should ALWAYS be 0;
 *     a non-zero value means the schema constraint was bypassed.
 *   - `torn`: a half-applied lifecycle transition — the structures disagree in a
 *     way that affects what recall serves or how a tenant is scoped. Repairable.
 *   - `drift`: a softer inconsistency that the next maintenance cycle would
 *     normally heal (e.g. an expiry not yet swept).
 */
export type AtomicitySeverity = "invariant" | "torn" | "drift";

/** Scope fragments, precomputed once per report from the optional tenant id. */
interface AtomicityScope {
  /** Restricts node-keyed SELECTs to the in-scope memory spaces (`n` alias). */
  nodeScope: any;
  /** Restricts registry-keyed SELECTs to the in-scope tenant (`r` alias). */
  regScope: any;
}

interface AtomicityClassDef {
  key: AtomicityClass;
  severity: AtomicitySeverity;
  description: string;
  /** Build the inner SELECT producing exactly `addr` + `tenant_id`. */
  build: (sql: Sql, scope: AtomicityScope) => any;
}

/**
 * Class definitions, in report order. Each `build` returns a SELECT that yields
 * `(addr, tenant_id)` for every row violating that class's invariant; the runner
 * wraps it to get a window count + a bounded sample. Adding/removing a class is a
 * deliberate change pinned by the foundation drift guard.
 */
export const ATOMICITY_CLASS_DEFS: readonly AtomicityClassDef[] = [
  {
    key: "node_without_registry",
    severity: "drift",
    description:
      "memory node with no memory_registry row — lifecycle untracked (no status, supersession, or expiry). A non-zero baseline is expected and tolerated: memories predating registry adoption legitimately have no row (the approve/retract/forget/expiry paths treat '0 affected rows OK — pre-registry memories'). Surfaced as soft drift so newly untracked writes are visible without reading as torn transitions.",
    build: (sql, { nodeScope }) => sql`
      SELECT n.addr AS addr, split_part(n.space_id, ':', 2) AS tenant_id
      FROM nodes n
      LEFT JOIN memory_registry r ON r.addr = n.addr
      WHERE n.node_type = 'memory'
        AND n.visibility <> 'deleted'
        AND r.addr IS NULL
        ${nodeScope}
    `,
  },
  {
    key: "registry_without_node",
    severity: "invariant",
    description:
      "memory_registry row with no nodes row — should be impossible (addr FK is ON DELETE CASCADE); non-zero means the FK was bypassed.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      LEFT JOIN nodes n ON n.addr = r.addr
      WHERE n.addr IS NULL
        ${regScope}
    `,
  },
  {
    key: "active_registry_dormant_node",
    severity: "torn",
    description:
      "registry says 'active' but the node is dormant/tombstoned — the registry counts a memory that recall no longer serves.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.status = 'active'
        AND (n.dormant_at IS NOT NULL OR n.visibility IN ('dormant', 'deleted', 'merged'))
        ${regScope}
    `,
  },
  {
    key: "recall_eligible_inactive_registry",
    severity: "torn",
    description:
      "registry says superseded/retracted/archived/expired but the node is still live — recall keeps serving a memory that was retired (the most user-visible leak).",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE r.status IN ('superseded', 'retracted', 'archived', 'expired')
        AND n.dormant_at IS NULL
        AND n.visibility NOT IN ('dormant', 'deleted', 'merged')
        ${regScope}
    `,
  },
  {
    key: "node_visibility_dormancy_mismatch",
    severity: "drift",
    description:
      "node shows visibility='dormant' but has no dormant_at timestamp — a dormant display state with no retirement time. NOTE: dormant_at (not visibility) is the authoritative retired signal — recall filters on dormant_at, and retract/forget/expiry intentionally set dormant_at while leaving visibility unchanged. The reverse case (dormant_at set + live visibility) is therefore the NORMAL post-retract state and is deliberately NOT flagged here.",
    build: (sql, { nodeScope }) => sql`
      SELECT n.addr AS addr, split_part(n.space_id, ':', 2) AS tenant_id
      FROM nodes n
      WHERE n.node_type = 'memory'
        AND n.visibility = 'dormant'
        AND n.dormant_at IS NULL
        ${nodeScope}
    `,
  },
  {
    key: "missing_lifecycle_events",
    severity: "torn",
    description:
      "registry row with zero memory_events for its tenant — every lifecycle write logs at least a 'created' event, so an empty trail means the event was never written.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_events e
        WHERE e.addr = r.addr AND e.tenant_id = r.tenant_id
      )
        ${regScope}
    `,
  },
  {
    key: "expired_not_transitioned",
    severity: "drift",
    description:
      "registry is 'active' but its expires_at is in the past — the expiry sweep has not yet transitioned it to 'expired'.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      WHERE r.status = 'active'
        AND r.expires_at IS NOT NULL
        AND r.expires_at < now()
        ${regScope}
    `,
  },
  {
    key: "tenant_space_mismatch",
    severity: "torn",
    description:
      "registry's tenant_id does not match the owning node's space_id (tenant:<id>) — an isolation-relevant cross-tenant binding.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      JOIN nodes n ON n.addr = r.addr
      WHERE n.space_id <> ('tenant:' || r.tenant_id)
        ${regScope}
    `,
  },
  {
    key: "superseded_without_successor",
    severity: "torn",
    description:
      "registry status is 'superseded' but superseded_by_addr is null — the supersession recorded no successor.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      WHERE r.status = 'superseded'
        AND r.superseded_by_addr IS NULL
        ${regScope}
    `,
  },
  {
    key: "asymmetric_supersession",
    severity: "torn",
    description:
      "registry supersedes a target whose own row was not retired in step (target still 'active', or its superseded_by_addr does not point back) — a half-applied supersession.",
    build: (sql, { regScope }) => sql`
      SELECT r.addr AS addr, r.tenant_id AS tenant_id
      FROM memory_registry r
      JOIN memory_registry t
        ON t.addr = r.supersedes_addr
       AND t.tenant_id = r.tenant_id
      WHERE r.supersedes_addr IS NOT NULL
        AND (t.superseded_by_addr IS DISTINCT FROM r.addr OR t.status = 'active')
        ${regScope}
    `,
  },
];

/** The stable, ordered list of class keys. */
export const ATOMICITY_CLASSES: readonly AtomicityClass[] = ATOMICITY_CLASS_DEFS.map(
  (d) => d.key,
);

// ── Report shape ───────────────────────────────────────────────────────────────

export interface AtomicityClassResult {
  class: AtomicityClass;
  severity: AtomicitySeverity;
  description: string;
  /** Offending rows in this class AT OR AFTER the cursor (full class count when no
   *  cursor is given). Honest total — never just the returned page size. */
  count: number;
  /** Up to `sample_limit` offending addresses — IDENTIFIERS ONLY, no content.
   *  Stably ordered by addr so the page (and any cursor resumed from it) is
   *  deterministic — tests/consumers never depend on arbitrary live-data ordering. */
  sample_addrs: string[];
  /** True iff `count` exceeds the returned page (more offenders than `sample_addrs`)
   *  — so a sample is NEVER mistaken for the exhaustive set. Always set by the DB
   *  runner; optional so synthetic fixtures may omit it (treated as not-sampled). */
  sampled?: boolean;
  /** Keyset cursor: pass back as `opts.afterAddr` to fetch the next page of this
   *  class's offenders. Null when the page is exhaustive (`sampled` is false). */
  next_cursor?: string | null;
}

export interface LifecycleAtomicityReport {
  /** Tenant the report was scoped to, or null for an operator-wide scan. */
  tenant_id: string | null;
  /** DB clock at report time (a consistent snapshot anchor). */
  generated_at: string;
  sample_limit: number;
  /** Cursor this report resumed from (echoed back), or null for the first page. */
  after_addr: string | null;
  total_findings: number;
  clean: boolean;
  /** True iff ANY class was sampled (its page did not cover all offenders) — the
   *  report is then a PAGE, not the exhaustive set; resume per-class via next_cursor. */
  truncated: boolean;
  by_severity: Record<AtomicitySeverity, number>;
  classes: AtomicityClassResult[];
}

export interface LifecycleAtomicityOptions {
  /** Scope to one tenant. Omit/null for an operator-wide scan of all tenants. */
  tenantId?: string | null;
  /** Max offending addresses to return per class (1–200, default 20). Floored at 1:
   *  a 0-row page cannot observe count(*) OVER(), which would falsely read as clean. */
  sampleLimit?: number;
  /** Keyset cursor — return only offenders with addr > afterAddr. Use WITH `classKey`
   *  to resume one class unambiguously (each class has its own next_cursor; a bare
   *  afterAddr applied to all classes can only resume one). For a multi-class
   *  operator-wide walk, paginate each class separately via { classKey, afterAddr }. */
  afterAddr?: string | null;
  /** Scope the `afterAddr` cursor to a SINGLE class. When set, only that class
   *  resumes from afterAddr; every other class returns its first page (full count). */
  classKey?: AtomicityClass;
}

/**
 * Pure roll-up of per-class results into a report. DB-free and deterministic
 * (no clock/random) so the foundation drift guard can exercise it without a DB.
 */
export function summarizeAtomicity(
  classes: AtomicityClassResult[],
  meta: { tenant_id: string | null; generated_at: string; sample_limit: number; after_addr?: string | null },
): LifecycleAtomicityReport {
  const by_severity: Record<AtomicitySeverity, number> = { invariant: 0, torn: 0, drift: 0 };
  let total = 0;
  let truncated = false;
  for (const c of classes) {
    total += c.count;
    by_severity[c.severity] += c.count;
    if (c.sampled) truncated = true;
  }
  return {
    tenant_id: meta.tenant_id,
    generated_at: meta.generated_at,
    sample_limit: meta.sample_limit,
    after_addr: meta.after_addr ?? null,
    total_findings: total,
    clean: total === 0,
    truncated,
    by_severity,
    classes,
  };
}

async function runClass(
  sql: Sql,
  def: AtomicityClassDef,
  scope: AtomicityScope,
  sampleLimit: number,
  afterAddr: string | null,
): Promise<AtomicityClassResult> {
  const inner = def.build(sql, scope);
  // count(*) OVER() runs before LIMIT, so we get the count alongside a bounded,
  // STABLY-ORDERED (by addr) sample in a single round-trip. With a keyset cursor the
  // WHERE narrows to addr > afterAddr and the count is the remaining-from-cursor count.
  // The sample is addr-only by construction (the inner query's tenant_id column is
  // intentionally not selected outward) so no private memory content leaves the report.
  const cursor = afterAddr ? sql`WHERE sub.addr > ${afterAddr}` : sql``;
  const rows = await sql`
    SELECT count(*) OVER()::int AS total, sub.addr AS addr
    FROM (${inner}) sub
    ${cursor}
    ORDER BY sub.addr
    LIMIT ${sampleLimit}
  `;
  const count = rows.length > 0 ? Number(rows[0].total) : 0;
  const sample_addrs = rows.map((r: any) => r.addr as string);
  const sampled = count > sample_addrs.length;
  return {
    class: def.key,
    severity: def.severity,
    description: def.description,
    count,
    sample_addrs,
    sampled,
    next_cursor: sampled && sample_addrs.length > 0 ? sample_addrs[sample_addrs.length - 1] : null,
  };
}

/**
 * Run every atomicity class and roll the results into a report. Read-only — runs
 * only SELECTs, mutates nothing. Scope to a tenant via `opts.tenantId`, or omit
 * it for an operator-wide scan. Returns counts + a bounded identifier sample per
 * class (no private content), plus a `clean` flag and per-severity totals.
 */
export async function lifecycleAtomicityReport(
  sql: Sql,
  opts: LifecycleAtomicityOptions = {},
): Promise<LifecycleAtomicityReport> {
  const tenantId = opts.tenantId ?? null;
  // Floor at 1: a 0-row page cannot observe count(*) OVER(), so a sampleLimit of 0
  // would falsely report every class clean/exhaustive while hiding offenders.
  const sampleLimit = Math.min(Math.max(Math.trunc(opts.sampleLimit ?? 20), 1), 200);
  const afterAddr = opts.afterAddr && opts.afterAddr.length > 0 ? opts.afterAddr : null;
  const classKey = opts.classKey ?? null;
  const scope: AtomicityScope = {
    nodeScope: tenantId
      ? sql`AND n.space_id = ${`tenant:${tenantId}`}`
      : sql`AND n.space_id LIKE 'tenant:%'`,
    regScope: tenantId ? sql`AND r.tenant_id = ${tenantId}` : sql``,
  };

  const [{ now }] = await sql`SELECT clock_timestamp()::text AS now`;

  const classes: AtomicityClassResult[] = [];
  for (const def of ATOMICITY_CLASS_DEFS) {
    // The cursor scopes to one class when classKey is set (each class owns its own
    // next_cursor); otherwise it applies to every class (coherent only when a single
    // class is non-empty). This prevents a multi-class walk from silently skipping
    // offenders in a class whose cursor was not the one carried back.
    const classAfter = afterAddr && (!classKey || def.key === classKey) ? afterAddr : null;
    classes.push(await runClass(sql, def, scope, sampleLimit, classAfter));
  }

  return summarizeAtomicity(classes, {
    tenant_id: tenantId,
    generated_at: now as string,
    after_addr: afterAddr,
    sample_limit: sampleLimit,
  });
}
