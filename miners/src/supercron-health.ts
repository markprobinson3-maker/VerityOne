import type { SqlLike } from "./supercron-budget-policy";

export interface MemoryHealthSnapshot {
  active_registry_dormant_nodes: number;
  active_registry_dormant_without_events: number;
  inactive_registry_active_nodes: number;
  memory_nodes_without_registry: number;
  registry_rows_without_node_rows: number;
  duplicate_edge_groups: number;
  self_loop_edges: number;
  edges_touching_inactive_endpoints: number;
  edges_missing_discovered_by: number;
  active_duplicate_assertions: number;
  active_memories_with_zero_edges: number;
  pending_review_count: number;
  lifecycle_mutations_without_events: number;
  // Memory-Health PR 6: the two metrics that complete the FIVE-metric snapshot —
  // duplicate/semantic conflict PRESSURE (unresolved memory_conflicts; PR 4 drives
  // it down) and embedding/index FOOTPRINT debt (live memories whose embedding lags
  // their content). Both are DEBT counters: visible + warn-on-increase, NEVER an
  // absolute invariant (no fail-closed, no unsafe auto-repair).
  unresolved_conflicts: number;
  stale_embedding_memories: number;
}

export type MemoryHealthDeltas = MemoryHealthSnapshot;

export interface GoldenQueryQualitySummary {
  golden_pass_rate: number | null;
  golden_cases_run: number;
  golden_cases_failed: number;
  golden_cases_errored: number;
  golden_cases_skipped: number;
  golden_cases_total: number;
  golden_cases_unscanned: number;
  regressed_cases_total: number;
  regressed_cases: string[];
}

export interface QualityPassSummary {
  name: string;
  skipped?: boolean;
  details?: Record<string, unknown>;
}

export interface QualityReport {
  before: MemoryHealthSnapshot;
  after: MemoryHealthSnapshot;
  delta: MemoryHealthDeltas;
  warnings: string[];
  pass_errors: { name: string; error: string }[];
  cooldown_events: { name: string; error: string }[];
  cooldown_overrides: string[];
  audit_events_written: number;
  snapshot_overhead_ms: number;
  snapshot_skipped: boolean;
  cycle_spend_micro?: number;
  cycle_remaining_micro?: number;
  cycle_daily_spend_micro?: number;
  cycle_manual_spend_micro?: number;
  golden_pass_rate: number | null;
  golden_cases_run: number;
  golden_cases_failed: number;
  golden_cases_errored: number;
  golden_cases_skipped: number;
  golden_cases_total: number;
  golden_cases_unscanned: number;
  regressed_cases_total: number;
  regressed_cases: string[];
  degraded: boolean;
  degraded_reason: string | null;
  error_fields?: Record<string, unknown>;
}

const NON_DEGRADING_PASS_ERRORS = new Set(["model_cooldown"]);

const HEALTH_KEYS: (keyof MemoryHealthSnapshot)[] = [
  "active_registry_dormant_nodes",
  "active_registry_dormant_without_events",
  "inactive_registry_active_nodes",
  "memory_nodes_without_registry",
  "registry_rows_without_node_rows",
  "duplicate_edge_groups",
  "self_loop_edges",
  "edges_touching_inactive_endpoints",
  "edges_missing_discovered_by",
  "active_duplicate_assertions",
  "active_memories_with_zero_edges",
  "pending_review_count",
  "lifecycle_mutations_without_events",
  "unresolved_conflicts",
  "stale_embedding_memories",
];

const ABSOLUTE_INVARIANTS: Partial<Record<keyof MemoryHealthSnapshot, number>> = {
  active_registry_dormant_nodes: 0,
  inactive_registry_active_nodes: 0,
  lifecycle_mutations_without_events: 0,
};

const GOLDEN_QUERY_PASS_RATE_MINIMUM = 0.8;
const GOLDEN_QUERY_LOW_COVERAGE_PCT = 0.5;

function intValue(row: Record<string, unknown> | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractGoldenQuerySummary(passResults: QualityPassSummary[]): GoldenQueryQualitySummary {
  const pass = passResults.find((r) => r.name === "golden_query");
  const details = pass?.details || {};
  const passRate = numberValue(details.golden_pass_rate);
  const regressed = Array.isArray(details.regressed_cases)
    ? details.regressed_cases.map((slug) => String(slug)).filter(Boolean).slice(0, 25)
    : [];
  return {
    golden_pass_rate: passRate,
    golden_cases_run: Math.max(0, Number(details.golden_cases_run || 0)),
    golden_cases_failed: Math.max(0, Number(details.golden_cases_failed || 0)),
    golden_cases_errored: Math.max(0, Number(details.golden_cases_errored || 0)),
    golden_cases_skipped: Math.max(0, Number(details.golden_cases_skipped || 0)),
    golden_cases_total: Math.max(0, Number(details.golden_cases_total || 0)),
    golden_cases_unscanned: Math.max(0, Number(details.golden_cases_unscanned || 0)),
    regressed_cases_total: Math.max(0, Number(details.regressed_cases_total || regressed.length)),
    regressed_cases: regressed,
  };
}

export async function collectMemoryHealthSnapshot(
  sql: SqlLike,
  tenantSpaceId?: string,
): Promise<MemoryHealthSnapshot> {
  // MT9: scope the snapshot to ONE tenant when tenantSpaceId (e.g. "tenant:acme") is
  // given — every node/edge/registry/conflict CTE filters on its space_id/tenant_id.
  // When unset (the operator-wide default), the `IS NULL OR` guard is always true, so
  // the snapshot is the original global report — byte-for-byte unchanged. `ts` filters
  // node/edge space_id; `tid` filters memory_registry/memory_conflicts tenant_id.
  // (pending_review_count reads the graph-wide `proposals` staging table, which carries
  // NO tenant column — it stays operator-wide; tenant-scoping it is deferred to MT10.)
  const ts = tenantSpaceId ?? null;
  const tid = tenantSpaceId ? tenantSpaceId.replace(/^tenant:/, "") : null;
  const [row] = await sql`
    WITH active_registry_dormant_nodes AS (
      SELECT count(*)::int AS cnt
      FROM memory_registry mr
      JOIN nodes n ON n.addr = mr.addr
      WHERE mr.status = 'active'
        AND n.visibility IN ('dormant', 'merged')
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
    ),
    active_registry_dormant_without_events AS (
      SELECT count(*)::int AS cnt
      FROM memory_registry mr
      JOIN nodes n ON n.addr = mr.addr
      WHERE mr.status = 'active'
        AND n.visibility IN ('dormant', 'merged')
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
        AND NOT EXISTS (
          SELECT 1
          FROM memory_events me
          WHERE me.addr = mr.addr
            AND me.tenant_id = mr.tenant_id
            AND me.event_type IN ('superseded', 'retracted', 'archived', 'expired')
        )
    ),
    inactive_registry_active_nodes AS (
      SELECT count(*)::int AS cnt
      FROM memory_registry mr
      JOIN nodes n ON n.addr = mr.addr
      WHERE mr.status <> 'active'
        AND n.dormant_at IS NULL
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
    ),
    memory_nodes_without_registry AS (
      SELECT count(*)::int AS cnt
      FROM nodes n
      LEFT JOIN memory_registry mr ON mr.addr = n.addr
      WHERE n.node_type = 'memory'
        AND mr.addr IS NULL
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
    ),
    registry_rows_without_node_rows AS (
      SELECT count(*)::int AS cnt
      FROM memory_registry mr
      LEFT JOIN nodes n ON n.addr = mr.addr
      WHERE n.addr IS NULL
        AND (${tid}::text IS NULL OR mr.tenant_id = ${tid})
    ),
    duplicate_edge_groups AS (
      SELECT count(*)::int AS cnt
      FROM (
        SELECT from_addr, to_addr, edge_type
        FROM edges
        WHERE (${ts}::text IS NULL OR space_id = ${ts})
        GROUP BY from_addr, to_addr, edge_type
        HAVING count(*) > 1
      ) d
    ),
    self_loop_edges AS (
      SELECT count(*)::int AS cnt
      FROM edges
      WHERE from_addr = to_addr
        AND (${ts}::text IS NULL OR space_id = ${ts})
    ),
    edges_touching_inactive_endpoints AS (
      SELECT count(*)::int AS cnt
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      JOIN nodes nt ON nt.addr = e.to_addr
      WHERE (nf.visibility IN ('dormant', 'merged')
         OR nt.visibility IN ('dormant', 'merged'))
        AND (${ts}::text IS NULL OR e.space_id = ${ts})
    ),
    edges_missing_discovered_by AS (
      SELECT count(*)::int AS cnt
      FROM edges
      WHERE btrim(COALESCE(provenance->>'discovered_by', '')) = ''
        AND (${ts}::text IS NULL OR space_id = ${ts})
    ),
    active_duplicate_assertions AS (
      SELECT COALESCE(sum(assertion_count - 1), 0)::int AS cnt
      FROM (
        SELECT lower(btrim(COALESCE(n.substance->>'description', n.label))) AS assertion_key,
          count(*) AS assertion_count
        FROM nodes n
        LEFT JOIN memory_registry mr ON mr.addr = n.addr
        WHERE n.node_type = 'memory'
          AND n.visibility NOT IN ('dormant', 'merged', 'deleted')
          AND COALESCE(mr.status, 'active') = 'active'
          AND (${ts}::text IS NULL OR n.space_id = ${ts})
          AND length(btrim(COALESCE(n.substance->>'description', n.label))) >= 20
          AND lower(btrim(COALESCE(n.substance->>'description', n.label))) NOT IN ('todo', 'note', 'untitled', 'memo')
        GROUP BY lower(btrim(COALESCE(n.substance->>'description', n.label)))
        HAVING count(*) > 1
      ) d
    ),
    active_memories_with_zero_edges AS (
      SELECT count(*)::int AS cnt
      FROM nodes n
      LEFT JOIN memory_registry mr ON mr.addr = n.addr
      LEFT JOIN edges e ON e.from_addr = n.addr OR e.to_addr = n.addr
      WHERE n.node_type = 'memory'
        AND n.visibility NOT IN ('dormant', 'merged', 'deleted')
        AND COALESCE(mr.status, 'active') = 'active'
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
      GROUP BY n.addr
      HAVING count(e.id) = 0
    ),
    active_memories_with_zero_edges_total AS (
      SELECT count(*)::int AS cnt FROM active_memories_with_zero_edges
    ),
    pending_review_count AS (
      SELECT count(*)::int AS cnt
      FROM proposals
      WHERE status = 'pending'
    ),
    lifecycle_mutations_without_events AS (
      SELECT count(*)::int AS cnt
      FROM memory_registry mr
      WHERE mr.status <> 'active'
        AND (${tid}::text IS NULL OR mr.tenant_id = ${tid})
        AND NOT EXISTS (
          SELECT 1
          FROM memory_events me
          WHERE me.addr = mr.addr
            AND me.tenant_id = mr.tenant_id
            AND me.event_type = mr.status
        )
    ),
    unresolved_conflicts AS (
      SELECT count(*)::int AS cnt
      FROM memory_conflicts
      WHERE status = 'detected'
        AND (${tid}::text IS NULL OR tenant_id = ${tid})
    ),
    stale_embedding_memories AS (
      -- embedding_at is NOT NULL (F7b); updated_at is nullable by schema (always
      -- populated in practice), so COALESCE so a NULL updated_at can never silently
      -- hide staleness. The 1s grace excludes sub-second same-write skew (embedding_at
      -- stamped fractionally before updated_at finalizes), not real (hours/days) staleness.
      SELECT count(*)::int AS cnt
      FROM nodes n
      WHERE n.node_type = 'memory'
        AND n.dormant_at IS NULL
        AND n.visibility <> 'deleted'
        AND (${ts}::text IS NULL OR n.space_id = ${ts})
        AND n.space_id LIKE 'tenant:%'
        AND n.embedding_at < COALESCE(n.updated_at, n.embedding_at) - interval '1 second'
    )
    SELECT
      (SELECT cnt FROM active_registry_dormant_nodes) AS active_registry_dormant_nodes,
      (SELECT cnt FROM active_registry_dormant_without_events) AS active_registry_dormant_without_events,
      (SELECT cnt FROM inactive_registry_active_nodes) AS inactive_registry_active_nodes,
      (SELECT cnt FROM memory_nodes_without_registry) AS memory_nodes_without_registry,
      (SELECT cnt FROM registry_rows_without_node_rows) AS registry_rows_without_node_rows,
      (SELECT cnt FROM duplicate_edge_groups) AS duplicate_edge_groups,
      (SELECT cnt FROM self_loop_edges) AS self_loop_edges,
      (SELECT cnt FROM edges_touching_inactive_endpoints) AS edges_touching_inactive_endpoints,
      (SELECT cnt FROM edges_missing_discovered_by) AS edges_missing_discovered_by,
      (SELECT cnt FROM active_duplicate_assertions) AS active_duplicate_assertions,
      (SELECT cnt FROM active_memories_with_zero_edges_total) AS active_memories_with_zero_edges,
      (SELECT cnt FROM pending_review_count) AS pending_review_count,
      (SELECT cnt FROM lifecycle_mutations_without_events) AS lifecycle_mutations_without_events,
      (SELECT cnt FROM unresolved_conflicts) AS unresolved_conflicts,
      (SELECT cnt FROM stale_embedding_memories) AS stale_embedding_memories`;

  return {
    active_registry_dormant_nodes: intValue(row, "active_registry_dormant_nodes"),
    active_registry_dormant_without_events: intValue(row, "active_registry_dormant_without_events"),
    inactive_registry_active_nodes: intValue(row, "inactive_registry_active_nodes"),
    memory_nodes_without_registry: intValue(row, "memory_nodes_without_registry"),
    registry_rows_without_node_rows: intValue(row, "registry_rows_without_node_rows"),
    duplicate_edge_groups: intValue(row, "duplicate_edge_groups"),
    self_loop_edges: intValue(row, "self_loop_edges"),
    edges_touching_inactive_endpoints: intValue(row, "edges_touching_inactive_endpoints"),
    edges_missing_discovered_by: intValue(row, "edges_missing_discovered_by"),
    active_duplicate_assertions: intValue(row, "active_duplicate_assertions"),
    active_memories_with_zero_edges: intValue(row, "active_memories_with_zero_edges"),
    pending_review_count: intValue(row, "pending_review_count"),
    lifecycle_mutations_without_events: intValue(row, "lifecycle_mutations_without_events"),
    unresolved_conflicts: intValue(row, "unresolved_conflicts"),
    stale_embedding_memories: intValue(row, "stale_embedding_memories"),
  };
}

export function computeMemoryHealthDeltas(
  before: MemoryHealthSnapshot,
  after: MemoryHealthSnapshot,
): MemoryHealthDeltas {
  const delta = {} as MemoryHealthDeltas;
  for (const key of HEALTH_KEYS) {
    delta[key] = after[key] - before[key];
  }
  return delta;
}

export function evaluateQualityReport(report: {
  before: MemoryHealthSnapshot;
  after: MemoryHealthSnapshot;
  delta: MemoryHealthDeltas;
  pass_results?: QualityPassSummary[];
  audit_events_written?: number;
  snapshot_overhead_ms?: number;
  snapshot_skipped?: boolean;
  cycle_spend_micro?: number;
  cycle_remaining_micro?: number;
  cycle_daily_spend_micro?: number;
  cycle_manual_spend_micro?: number;
  cooldown_overrides?: string[];
  thresholds?: {
    golden_pass_rate_min?: number;
    low_coverage_pct?: number;
  };
}): QualityReport {
  if (!report.before || !report.after || !report.delta) {
    throw new TypeError("evaluateQualityReport requires before, after, and delta snapshots");
  }

  const warnings: string[] = [];
  const passResults = report.pass_results || [];
  const goldenPassRateMinimum = Number.isFinite(report.thresholds?.golden_pass_rate_min)
    ? Number(report.thresholds?.golden_pass_rate_min)
    : GOLDEN_QUERY_PASS_RATE_MINIMUM;
  const goldenLowCoveragePct = Number.isFinite(report.thresholds?.low_coverage_pct)
    ? Number(report.thresholds?.low_coverage_pct)
    : GOLDEN_QUERY_LOW_COVERAGE_PCT;
  const goldenQuery = extractGoldenQuerySummary(passResults);
  const passIssues = passResults
    .filter((r) => typeof r.details?.error === "string")
    .map((r) => ({ name: r.name || "unknown", error: String(r.details?.error) }));
  const cooldownEvents = passIssues.filter((r) => NON_DEGRADING_PASS_ERRORS.has(r.error));
  const passErrors = passIssues.filter((r) => !NON_DEGRADING_PASS_ERRORS.has(r.error));

  for (const err of passErrors) {
    warnings.push(`pass_error[${err.name}]:${err.error}`);
  }
  for (const r of passResults) {
    const passWarnings = Array.isArray(r.details?.warnings)
      ? r.details.warnings.map((warning) => String(warning)).filter(Boolean).slice(0, 20)
      : [];
    for (const warning of passWarnings) {
      warnings.push(`pass_warning[${r.name || "unknown"}]:${warning}`);
    }
  }

  // Severity order: warnings[0] becomes degraded_reason for single-warning
  // runs, and the headline "first" warning for multi-warning runs. Pass
  // errors and pass warnings are added first, followed by registry/node drift,
  // edge-table drift, and lifecycle audit drift.
  for (const key of Object.keys(ABSOLUTE_INVARIANTS) as (keyof MemoryHealthSnapshot)[]) {
    const threshold = ABSOLUTE_INVARIANTS[key] ?? 0;
    const observed = report.after[key];
    if (observed > threshold) {
      warnings.push(`absolute_invariant_breach:${key}:${observed}`);
    }
  }
  if (
    goldenQuery.golden_cases_run > 0
    && goldenQuery.golden_pass_rate !== null
    && goldenQuery.golden_pass_rate < goldenPassRateMinimum
  ) {
    warnings.push(`absolute_invariant_breach:golden_pass_rate:${goldenQuery.golden_pass_rate.toFixed(3)}`);
  }
  const goldenCasesAttempted = goldenQuery.golden_cases_run + goldenQuery.golden_cases_skipped;
  if (goldenCasesAttempted > 0 && goldenQuery.golden_cases_skipped / goldenCasesAttempted > goldenLowCoveragePct) {
    warnings.push(`golden_query_low_coverage:${goldenQuery.golden_cases_skipped}/${goldenCasesAttempted}`);
  }

  const deltaWarnings: [keyof MemoryHealthDeltas, string][] = [
    ["active_registry_dormant_nodes", "active_registry_dormant_nodes_regressed"],
    ["active_registry_dormant_without_events", "active_dormant_without_lifecycle_event"],
    ["inactive_registry_active_nodes", "inactive_registry_active_nodes_regressed"],
    ["duplicate_edge_groups", "duplicate_edge_groups_increased"],
    ["self_loop_edges", "self_loop_edges_increased"],
    ["edges_touching_inactive_endpoints", "edges_touching_inactive_endpoints_increased"],
    ["lifecycle_mutations_without_events", "lifecycle_mutations_without_events_increased"],
    // PR 6 debt metrics — degrade the run when they REGRESS (rising conflict pressure /
    // embedding staleness) but are NOT absolute invariants (no fail-closed, no auto-repair).
    ["unresolved_conflicts", "unresolved_conflicts_increased"],
    ["stale_embedding_memories", "stale_embedding_memories_increased"],
  ];

  for (const [key, label] of deltaWarnings) {
    if (report.delta[key] > 0) warnings.push(`${label}:${report.delta[key]}`);
  }

  const auditEventsWritten = Number(report.audit_events_written || 0);
  const snapshotOverheadMs = Math.max(0, Number(report.snapshot_overhead_ms || 0));
  const snapshotSkipped = report.snapshot_skipped === true;
  const cycleSpendMicro = Math.max(0, Math.trunc(Number(report.cycle_spend_micro || 0)));
  const cycleRemainingMicro = Math.max(0, Math.trunc(Number(report.cycle_remaining_micro || 0)));
  const cycleDailySpendMicro = Math.max(0, Math.trunc(Number(report.cycle_daily_spend_micro || 0)));
  const cycleManualSpendMicro = Math.max(0, Math.trunc(Number(report.cycle_manual_spend_micro || 0)));
  const cooldownOverrides = Array.isArray(report.cooldown_overrides)
    ? report.cooldown_overrides.map((override) => String(override)).filter(Boolean).slice(0, 50)
    : [];
  if (report.delta.lifecycle_mutations_without_events > 0) {
    warnings.push("lifecycle_mutations_missing_events");
  }

  const degraded = warnings.length > 0;
  const degradedReason = degraded
    ? warnings.length === 1
      ? warnings[0]
      : `${warnings.length} warnings; first: ${warnings[0]}`
    : null;
  return {
    before: report.before,
    after: report.after,
    delta: report.delta,
    warnings,
    pass_errors: passErrors,
    cooldown_events: cooldownEvents,
    cooldown_overrides: cooldownOverrides,
    audit_events_written: auditEventsWritten,
    snapshot_overhead_ms: snapshotOverheadMs,
    snapshot_skipped: snapshotSkipped,
    cycle_spend_micro: cycleSpendMicro,
    cycle_remaining_micro: cycleRemainingMicro,
    cycle_daily_spend_micro: cycleDailySpendMicro,
    cycle_manual_spend_micro: cycleManualSpendMicro,
    golden_pass_rate: goldenQuery.golden_pass_rate,
    golden_cases_run: goldenQuery.golden_cases_run,
    golden_cases_failed: goldenQuery.golden_cases_failed,
    golden_cases_errored: goldenQuery.golden_cases_errored,
    golden_cases_skipped: goldenQuery.golden_cases_skipped,
    golden_cases_total: goldenQuery.golden_cases_total,
    golden_cases_unscanned: goldenQuery.golden_cases_unscanned,
    regressed_cases_total: goldenQuery.regressed_cases_total,
    regressed_cases: goldenQuery.regressed_cases,
    degraded,
    degraded_reason: degradedReason,
  };
}
