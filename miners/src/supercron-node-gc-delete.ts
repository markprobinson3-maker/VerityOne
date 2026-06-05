export type NodeDeletePreCascadeAction = "delete";
export type NodeDeleteAutomaticCascadeAction = "cascade_delete" | "cascade_set_null";
export type NodeGcCascadeDeleteAction = NodeDeletePreCascadeAction | NodeDeleteAutomaticCascadeAction;

export interface NodeDeletePreCascadeTable {
  table: string;
  addrColumn: string;
  action: NodeDeletePreCascadeAction;
  source: string;
}

export const NODE_DELETE_PRE_CASCADE_TABLES = [
  {
    table: "collapse_events",
    addrColumn: "node_addr",
    action: "delete",
    source: "db/foundation-rung-f10-runtime-parity.sql:127",
  },
] as const satisfies readonly NodeDeletePreCascadeTable[];

export interface NodeDeleteAutomaticCascadeEffect {
  table: string;
  column: string;
  action: NodeDeleteAutomaticCascadeAction;
  alias: string;
  source: string;
}

export const NODE_DELETE_AUTO_CASCADE_EFFECTS = [
  {
    table: "nodes",
    column: "parent_addr",
    action: "cascade_set_null",
    alias: "nodes_parent_addr_set_null",
    source: "db/schema.sql:67",
  },
  {
    table: "edges",
    column: "from_addr/to_addr",
    action: "cascade_delete",
    alias: "edges_deleted",
    source: "db/schema.sql:103-104",
  },
  {
    table: "memory_registry",
    column: "addr",
    action: "cascade_delete",
    alias: "memory_registry_deleted",
    source: "db/memory-lifecycle-foundation.sql:8",
  },
  {
    table: "memory_registry",
    column: "supersedes_addr",
    action: "cascade_set_null",
    alias: "memory_registry_supersedes_addr_set_null",
    source: "db/memory-lifecycle-foundation.sql:19",
  },
  {
    table: "memory_registry",
    column: "superseded_by_addr",
    action: "cascade_set_null",
    alias: "memory_registry_superseded_by_addr_set_null",
    source: "db/memory-lifecycle-foundation.sql:20",
  },
  {
    table: "node_publications",
    column: "source_addr",
    action: "cascade_delete",
    alias: "node_publications_source_deleted",
    source: "db/publication-bridge.sql:6",
  },
  {
    table: "node_publications",
    column: "target_addr",
    action: "cascade_set_null",
    alias: "node_publications_target_addr_set_null",
    source: "db/publication-bridge.sql:8",
  },
  {
    table: "file_index",
    column: "node_addr",
    action: "cascade_delete",
    alias: "file_index_deleted",
    source: "db/source-refs-schema.sql:63",
  },
] as const satisfies readonly NodeDeleteAutomaticCascadeEffect[];

export interface NodeGcCascadeDeleteCount {
  table: string;
  column?: string;
  rows: number;
  action?: NodeGcCascadeDeleteAction;
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readNodeDeleteAutomaticCascadeCounts(tx: any, addr: string): Promise<NodeGcCascadeDeleteCount[]> {
  const rows = await tx`
    SELECT
      (SELECT count(*)::int FROM nodes WHERE parent_addr = ${addr}) AS nodes_parent_addr_set_null,
      (SELECT count(*)::int FROM edges WHERE from_addr = ${addr} OR to_addr = ${addr}) AS edges_deleted,
      (SELECT count(*)::int FROM memory_registry WHERE addr = ${addr}) AS memory_registry_deleted,
      (SELECT count(*)::int FROM memory_registry WHERE supersedes_addr = ${addr}) AS memory_registry_supersedes_addr_set_null,
      (SELECT count(*)::int FROM memory_registry WHERE superseded_by_addr = ${addr}) AS memory_registry_superseded_by_addr_set_null,
      (SELECT count(*)::int FROM node_publications WHERE source_addr = ${addr}) AS node_publications_source_deleted,
      (SELECT count(*)::int FROM node_publications WHERE target_addr = ${addr}) AS node_publications_target_addr_set_null,
      (SELECT count(*)::int FROM file_index WHERE node_addr = ${addr}) AS file_index_deleted
  `;
  const row = rows[0] ?? {};
  return NODE_DELETE_AUTO_CASCADE_EFFECTS.map((effect) => ({
    table: effect.table,
    column: effect.column,
    rows: countValue(row[effect.alias]),
    action: effect.action,
  }));
}

export async function cascadeDeleteNode(
  tx: any,
  addr: string,
  tenantSpaceId: string,
): Promise<NodeGcCascadeDeleteCount[]> {
  const results: NodeGcCascadeDeleteCount[] = [];
  // SAFETY: table/column identifiers come only from the literal
  // NODE_DELETE_PRE_CASCADE_TABLES constant. Never accept operator input here.
  for (const { table, addrColumn, action } of NODE_DELETE_PRE_CASCADE_TABLES) {
    const changed = await tx`
      DELETE FROM ${tx(table)}
      WHERE ${tx(addrColumn)} = ${addr}
      RETURNING 1
    `;
    results.push({ table, column: addrColumn, rows: changed.length, action });
  }

  const automaticCascadeCounts = await readNodeDeleteAutomaticCascadeCounts(tx, addr);

  const nodeDeleted = await tx`
    DELETE FROM nodes
    WHERE addr = ${addr}
      AND space_id = ${tenantSpaceId}
    RETURNING 1
  `;
  results.push(...automaticCascadeCounts);
  results.push({ table: "nodes", column: "addr", rows: nodeDeleted.length, action: "delete" });
  return results;
}

export interface NodeGcApplyPredicateRow {
  node_type?: unknown;
  visibility?: unknown;
  dormant_at: unknown;
  query_hits: unknown;
  last_queried: unknown;
  pinned: unknown;
  maturity_stage: unknown;
  registry_kind: unknown;
  registry_status: unknown;
  accepted_by_user: unknown;
  source_kind: unknown;
  edge_count: unknown;
}

export interface NodeGcApplyPredicateOptions {
  now: Date;
  dormantDays: number;
  lastQueriedGraceDays: number;
  safeLifecycleStates: readonly string[];
  protectedMaturityStages: readonly string[];
  protectedKinds: readonly string[];
}

export interface NodeGcApplyPredicateEvaluation {
  holds: boolean;
  field: string | null;
  observed: unknown;
  rejectionReason: string | null;
  snapshot: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function textValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function snapshotDate(value: unknown): string | null {
  const date = dateValue(value);
  return date ? date.toISOString() : null;
}

export function observedText(value: unknown): string {
  if (value == null) return "null";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function observedReasonText(value: unknown): string {
  return observedText(value).slice(0, 80);
}

function evaluationSnapshot(options: NodeGcApplyPredicateOptions): Record<string, unknown> {
  return {
    evaluation_dormant_days: options.dormantDays,
    evaluation_last_queried_grace_days: options.lastQueriedGraceDays,
    evaluation_safe_lifecycle_states: options.safeLifecycleStates,
    evaluation_protected_maturity_stages: options.protectedMaturityStages,
    evaluation_protected_kinds: options.protectedKinds,
  };
}

function drift(
  field: string,
  observed: unknown,
  snapshot: Record<string, unknown>,
): NodeGcApplyPredicateEvaluation {
  return {
    holds: false,
    field,
    observed,
    rejectionReason: `predicate_drift_at_apply_time:${field}:${observedReasonText(observed)}`,
    snapshot,
  };
}

export function evaluateNodeGcApplyPredicate(
  row: NodeGcApplyPredicateRow | null,
  options: NodeGcApplyPredicateOptions,
): NodeGcApplyPredicateEvaluation {
  if (!row) {
    const snapshot = {
      node_exists: false,
      ...evaluationSnapshot(options),
    };
    return drift("node_exists", "missing", snapshot);
  }

  const dormantAt = dateValue(row.dormant_at);
  const queryHits = numberValue(row.query_hits);
  const lastQueried = dateValue(row.last_queried);
  const edgeCount = numberValue(row.edge_count);
  const nodeType = textValue(row.node_type);
  const visibility = textValue(row.visibility);
  const pinned = row.pinned === true || row.pinned === "true";
  const maturityStage = textValue(row.maturity_stage);
  const registryKind = textValue(row.registry_kind);
  const registryStatus = textValue(row.registry_status);
  const acceptedByUser = row.accepted_by_user === true || row.accepted_by_user === "true";
  const sourceKind = textValue(row.source_kind);
  const dormantCutoff = options.now.getTime() - options.dormantDays * DAY_MS;
  const lastQueriedCutoff = options.now.getTime() - options.lastQueriedGraceDays * DAY_MS;
  const snapshot = {
    node_exists: true,
    node_type: nodeType,
    visibility,
    dormant_at: snapshotDate(row.dormant_at),
    query_hits: queryHits,
    last_queried: snapshotDate(row.last_queried),
    pinned,
    maturity_stage: maturityStage,
    registry_kind: registryKind,
    registry_status: registryStatus,
    accepted_by_user: acceptedByUser,
    source_kind: sourceKind,
    edge_count: edgeCount,
    ...evaluationSnapshot(options),
  };

  if (nodeType !== "memory") return drift("node_type", nodeType, snapshot);
  if (visibility === "deleted") return drift("visibility", visibility, snapshot);
  if (!dormantAt || dormantAt.getTime() >= dormantCutoff) return drift("dormant_at", row.dormant_at, snapshot);
  if (edgeCount !== 0) return drift("edge_count", edgeCount, snapshot);
  if (pinned) return drift("pinned", pinned, snapshot);
  if (options.protectedMaturityStages.includes(maturityStage)) return drift("maturity_stage", maturityStage, snapshot);
  if (!options.safeLifecycleStates.includes(registryStatus)) return drift("registry_status", registryStatus, snapshot);
  if (acceptedByUser) return drift("accepted_by_user", acceptedByUser, snapshot);
  if (sourceKind === "user_accepted") return drift("source_kind", sourceKind, snapshot);
  if (options.protectedKinds.includes(registryKind)) return drift("registry_kind", registryKind, snapshot);
  if (queryHits !== null && queryHits !== 0) return drift("query_hits", queryHits, snapshot);
  if (lastQueried && lastQueried.getTime() >= lastQueriedCutoff) return drift("last_queried", row.last_queried, snapshot);

  return {
    holds: true,
    field: null,
    observed: null,
    rejectionReason: null,
    snapshot,
  };
}
