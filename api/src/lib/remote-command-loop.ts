// Open-core stub. The VO+ implementation ships separately.
//
// In VO+, this module runs a background loop that polls a hosted command
// queue over HTTP, claims and dispatches commands locally, and posts
// results back. The open-core local node has no hosted queue to poll, so
// this stub is intentionally disabled: every entry point is a safe no-op
// that returns a graceful, type-compatible value. No network calls, no
// timers, no sync, no crypto.

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

/** Handle returned by {@link startRemoteCommandLoop}. `stop()` is a no-op here. */
export interface RemoteCommandHandle {
  stop(): void;
}

/**
 * Disabled in open-core. Returns the empty sweep stats so any caller that
 * reads the counters gets zeros instead of crashing. Performs no work.
 */
export async function processTenantCommands(
  _sql: SqlTag,
  _tenantId: string,
  _hostedUrl: string,
  _syncToken: string,
): Promise<{ processed: number; applied: number; rejected: number; failed: number }> {
  return { processed: 0, applied: 0, rejected: 0, failed: 0 };
}

/**
 * Disabled in open-core. Returns a handle whose `stop()` is a no-op, so the
 * boot path (which registers SIGINT/SIGTERM handlers calling `handle.stop()`)
 * works unchanged. Starts no timer and contacts no hosted endpoint.
 */
export function startRemoteCommandLoop(
  _sql: SqlTag,
  _tenantId: string,
  _hostedUrl: string,
  _syncToken: string,
): RemoteCommandHandle {
  return {
    stop() {
      /* no-op: nothing to stop in open-core */
    },
  };
}
