// Open-core stub. The VO+ implementation ships separately.
/**
 * Background grant renewal — disabled in open-core.
 *
 * In the open-core build there are no customer-managed tenant key-authority
 * grants to renew, so this module ships as a no-op stub. Starting the loop
 * registers no timers and returns an inert handle whose stop() is a no-op.
 *
 * The full background-renewal implementation ships separately in VO+.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

/**
 * Start the background grant renewal loop.
 *
 * Open-core stub: does nothing and returns an inert handle. Safe to call;
 * the returned handle exposes a no-op stop().
 */
export function startGrantRenewalLoop(_sql: SqlTag): { stop: () => void } {
  return {
    stop: () => {
      /* no-op: grant renewal is disabled in open-core */
    },
  };
}

/**
 * Stop the background grant renewal loop.
 *
 * Open-core stub: no loop runs, so this is a no-op.
 */
export function stopGrantRenewalLoop(): void {
  /* no-op: grant renewal is disabled in open-core */
}
