// Add proposal-only lifecycle actions here when they ship. Drift tests require
// an explicit update for any action-list change. Pending design note: PR 8 P2-4
// may add confidence-promotion review once the pass6 source work item generator
// exists.
export const LIFECYCLE_PROPOSAL_ACTIONS = [
  "tenant_memory_supersession",
  "memory_merge",
] as const;

export const MEMORY_MERGE_ACTION = "memory_merge";

// Chronic baseline conditions should not hold /ops/runtime in permanent warn.
// Nonzero thresholds below are inclusive: a value at the threshold warns.
export const SUPERCRON_DEGRADED_RUNS_24H_WARN_THRESHOLD = 3;
// Any explicit failed run row pages. Note: cycles that crash via uncaught
// exception can still produce no supercron_runs row; rely on supervisor
// heartbeat/log inspection for those until the catch-path persistence fix lands.
export const SUPERCRON_FAILED_RUNS_24H_CRITICAL_THRESHOLD = 0;
export const LIFECYCLE_PROPOSAL_BACKLOG_WARN_THRESHOLD = 50;
export const MEMORY_MERGE_HOLD_QUEUE_WARN_THRESHOLD = 50;
export const EDGE_PROVENANCE_DEBT_WARN_THRESHOLD = 1000;
