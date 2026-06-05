/**
 * Federation sync-health vocabulary —
 * VO-SYNC-HEALTH-DASHBOARD-PR-1 (rung 3).
 *
 * A SHARED 5-state enum + two derivation functions (one per
 * rendering side) so local `/dashboard/account` and hosted
 * `/my/account` use the same freshness vocabulary. The ladder's
 * non-negotiable "No dashboard claims 'synced' without a hosted
 * mirror timestamp" is enforced structurally: `fresh` is
 * unreachable on the local side without a non-null
 * `hostedLastSyncAt`, and on the hosted side without a non-null
 * `lastSyncAt`.
 *
 * The enum is intentionally 5 values (4 sad + 1 happy), not 4.
 * The rung-3 ladder entry lists the 4 failure modes an operator
 * needs to distinguish (offline / disabled / error / never); the
 * fifth (`fresh`) is the residual "everything is fine" state.
 * Without an explicit happy-state enum value, callers would have
 * to represent "ok" as a null/absence, and the fresh-requires-
 * hosted-timestamp invariant becomes a comment instead of a type
 * guarantee. Naming it gives the drift guard something to pin.
 */

export const SYNC_HEALTH_STATES = [
  "offline",
  "disabled",
  "error",
  "never",
  "fresh",
] as const;

export type SyncHealthState = (typeof SYNC_HEALTH_STATES)[number];

/**
 * Stale threshold for the shared `offline` derivation. Any
 * hosted `last_sync_at` older than this (against the caller's
 * now) tips the node into `offline` on both local and hosted
 * dashboards. Matches the default sync-scheduler cadence with
 * generous headroom so a single missed push does not fire the
 * badge; two missed pushes does.
 */
export const SYNC_HEALTH_STALE_THRESHOLD_SECONDS = 900;

// ── Local-side derivation ────────────────────────────────────

/** Inputs the local `/dashboard/account` handler already has
 *  on hand (via `getSyncStatus()` + the existing hosted_nodes
 *  read). The derivation is pure — no I/O, no clock unless the
 *  caller passes `nowMs`. */
export interface LocalSyncHealthInput {
  /** Link status === 'active' AND sync token claimed. Captures
   *  both "no tenant link yet" and "link exists but no token"
   *  as the same surface concern: the local side has nothing to
   *  sync with. */
  syncConfigured: boolean;
  /** `~/.vo/sync-state.json#last_attempt_at`; null when the
   *  exporter has never run. */
  lastAttemptAt: string | null;
  /** `~/.vo/sync-state.json#last_result`. Known values (see
   *  `resultToStatus` in sync-exporter.ts):
   *  "success" | "nothing_to_export" | "all_filtered" |
   *  "disabled" | "not_configured" | "auth_error" | "conflict" |
   *  "hosted_error" | "network_error" | "unknown". */
  lastResult: string | null;
  /** `hosted_nodes.last_sync_at` for the local node's own row.
   *  null when no successful sync has been observed by hosted,
   *  even if the local side thinks it pushed. */
  hostedLastSyncAt: string | null;
  /** Optional test clock. Defaults to `Date.now()`. */
  nowMs?: number;
}

/** Local result strings that do not independently mean
 *  "the last attempt failed." `network_error` is handled
 *  separately (→ `offline`); every other unknown/non-success
 *  string maps to `error` so newly introduced exporter
 *  failure reasons cannot accidentally render as fresh. */
const LOCAL_NON_ERROR_RESULTS = new Set<string>([
  "success",
  "nothing_to_export",
  "all_filtered",
  "disabled",
  "not_configured",
]);

export function computeLocalSyncHealth(input: LocalSyncHealthInput): SyncHealthState {
  // `disabled` wins even if the exporter ran historically — a
  // user who turned sync off expects the badge to say so
  // immediately, not to show a stale "fresh" until the next
  // attempt reclassifies.
  if (!input.syncConfigured) return "disabled";

  if (input.lastResult === "network_error") return "offline";
  if (input.lastResult && !LOCAL_NON_ERROR_RESULTS.has(input.lastResult)) return "error";

  // Structural invariant — cannot claim fresh without hosted
  // evidence. The local exporter may have returned "success"
  // but if hosted has not yet acknowledged a sync, we still
  // report `never` (not `fresh`). Drift-guarded + unit-tested.
  if (!input.hostedLastSyncAt) return "never";

  const now = input.nowMs ?? Date.now();
  const ts = new Date(input.hostedLastSyncAt).getTime();
  if (!Number.isFinite(ts)) return "error";
  const ageSeconds = (now - ts) / 1000;
  if (ageSeconds > SYNC_HEALTH_STALE_THRESHOLD_SECONDS) return "offline";

  return "fresh";
}

// ── Hosted-side derivation ───────────────────────────────────

/** Inputs the hosted `/my/account` handler already has on hand
 *  via the `hosted_nodes` row SELECT. Pure derivation; clock is
 *  injectable via `nowMs` for deterministic tests. */
export interface HostedSyncHealthInput {
  /** `hosted_nodes.sync_status` — the CHECK constraint limits
   *  this to 'never' | 'syncing' | 'paused' | 'error'. */
  syncStatus: "never" | "syncing" | "paused" | "error";
  /** `hosted_nodes.last_sync_at` — null when no sync has been
   *  observed by hosted for this node. */
  lastSyncAt: string | null;
  /** Optional test clock. Defaults to `Date.now()`. */
  nowMs?: number;
}

export function computeHostedSyncHealth(input: HostedSyncHealthInput): SyncHealthState {
  // Explicit paused = operator disabled hosted-side ingest.
  if (input.syncStatus === "paused") return "disabled";
  // Recorded error takes precedence over staleness — a 500 from
  // last push is more useful than "maybe the node left."
  if (input.syncStatus === "error") return "error";
  if (input.syncStatus === "never") return "never";

  // syncing (or any future healthy state) — freshness gates the
  // happy path. No `last_sync_at` → `never` even if the status
  // column claims 'syncing' (hosted has not confirmed a push
  // yet; structural invariant).
  if (!input.lastSyncAt) return "never";

  const now = input.nowMs ?? Date.now();
  const ts = new Date(input.lastSyncAt).getTime();
  if (!Number.isFinite(ts)) return "error";
  const ageSeconds = (now - ts) / 1000;
  if (ageSeconds > SYNC_HEALTH_STALE_THRESHOLD_SECONDS) return "offline";

  return "fresh";
}
