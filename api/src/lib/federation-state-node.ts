/**
 * Federation node state machines —
 * VO-PLUS-FEDERATION-STATE-MACHINES-PR-1.
 *
 * Typed source-of-truth for the two node-level state
 * surfaces the VO+ federation pipeline tracks. Both live
 * on the `hosted_nodes` row for a given (account, tenant,
 * node_id) triple:
 *
 *   - `hosted_nodes.status`: the node's membership in the
 *     tenant. `active` means signed challenges are honored;
 *     `pending` means awaiting first-link approval;
 *     `revoked` means the node cannot act on behalf of the
 *     tenant until re-linked.
 *
 *   - `hosted_nodes.sync_status`: the node's sync-pipeline
 *     health. `never` means no sync attempts yet (default
 *     at insert), `syncing` means the last attempt entered
 *     the pipeline, `paused` means explicitly disabled by
 *     the operator, `error` means the last attempt failed
 *     and the token may still be valid.
 *
 * Both enums mirror their SQL CHECK constraints. A drift
 * test reads the SQL and fails CI on divergence.
 */

/**
 * Mirror of the `CHECK (status IN (...))` constraint on
 * `hosted_nodes.status`.
 */
export const NODE_STATUSES = ["active", "pending", "revoked"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * `revoked` is terminal for the specific (account, tenant,
 * node_id) row. A subsequent link produces a new row, not a
 * revive — rung 2's key-rotation flow relies on this.
 */
export const TERMINAL_NODE_STATUSES: ReadonlyArray<NodeStatus> = ["revoked"];

export const NODE_STATUS_TRANSITIONS: ReadonlyArray<{
  from: NodeStatus;
  to: NodeStatus;
  reason: string;
}> = [
  {
    from: "pending",
    to: "active",
    reason: "operator approves link, node signature verified",
  },
  {
    from: "active",
    to: "revoked",
    reason: "POST /account/nodes/:node_id/revoke or /account/unlink",
  },
  {
    from: "pending",
    to: "revoked",
    reason: "operator rejects or cancels pending node before approval",
  },
];

/**
 * Mirror of the `CHECK (sync_status IN (...))` constraint
 * on `hosted_nodes.sync_status`.
 */
export const SYNC_STATUSES = [
  "never",
  "syncing",
  "paused",
  "error",
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * Sync-status transitions are best-effort health signals,
 * not a hard lifecycle. A node can freely cycle between
 * `syncing` ↔ `error` and pause at any point. The
 * transition table captures the observed paths; any move
 * not listed is a bug (missing telemetry or stale row).
 *
 * `never` is the starting state at first insert. It is
 * only the source of transitions; it is never a target,
 * because a node that has attempted sync does not
 * retroactively forget.
 */
export const SYNC_STATUS_TRANSITIONS: ReadonlyArray<{
  from: SyncStatus;
  to: SyncStatus;
  reason: string;
}> = [
  {
    from: "never",
    to: "syncing",
    reason: "first successful sync attempt enters the pipeline",
  },
  {
    from: "never",
    to: "error",
    reason: "first sync attempt fails before committing any row",
  },
  {
    from: "never",
    to: "paused",
    reason: "operator disables sync before first attempt",
  },
  {
    from: "syncing",
    to: "syncing",
    reason: "subsequent batches keep the pipeline active",
  },
  {
    from: "syncing",
    to: "error",
    reason: "a batch fails after previously succeeding",
  },
  {
    from: "syncing",
    to: "paused",
    reason: "operator disables sync mid-stream",
  },
  {
    from: "error",
    to: "syncing",
    reason: "a subsequent batch succeeds and recovers the pipeline",
  },
  {
    from: "error",
    to: "paused",
    reason: "operator disables sync after repeated failures",
  },
  {
    from: "paused",
    to: "syncing",
    reason: "operator re-enables sync",
  },
];

export function isValidNodeStatusTransition(
  from: NodeStatus,
  to: NodeStatus,
): boolean {
  return NODE_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function isValidSyncStatusTransition(
  from: SyncStatus,
  to: SyncStatus,
): boolean {
  return SYNC_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
