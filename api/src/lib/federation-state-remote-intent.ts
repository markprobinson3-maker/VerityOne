/**
 * Federation remote-intent state machine —
 * VO-PLUS-FEDERATION-STATE-MACHINES-PR-1.
 *
 * Typed source-of-truth for the `remote_commands.status`
 * lifecycle. The same enum already exists at
 * `api/src/lib/remote-command-types.ts` as
 * `COMMAND_STATUSES` — this module re-exports it from the
 * canonical location and adds a transition table the
 * federation-ladder drift guard can pin.
 *
 * Keeping a single source-of-truth for the statuses (in
 * `remote-command-types.ts`) and a transition table (here)
 * means handler code and dashboard rendering continue to
 * import the same enum, while the federation-ladder drift
 * guard reads this module's transition table to confirm
 * lifecycle moves stay legal.
 */

import {
  COMMAND_STATUSES,
  TERMINAL_STATUSES,
  type CommandStatus,
} from "./remote-command-types";

export { COMMAND_STATUSES, TERMINAL_STATUSES };
export type RemoteIntentStatus = CommandStatus;

/**
 * Re-exported for drift-guard and symmetry with the other
 * federation-state modules.
 */
export const REMOTE_INTENT_STATUSES = COMMAND_STATUSES;
export const TERMINAL_REMOTE_INTENT_STATUSES = TERMINAL_STATUSES;

/**
 * Remote-intent command lifecycle:
 *
 *   queued → claimed → applied          (local applied success)
 *   queued → claimed → rejected         (local rejected intent)
 *   queued → claimed → failed           (local attempted and failed)
 *   queued → canceled                   (operator cancels before claim)
 *   queued → expired                    (maintenance timeout before claim)
 *   claimed → expired                   (maintenance timeout after stale claim)
 *
 * `canceled` is only reachable from `queued`; once a local
 * node has `claimed` a command, cancellation is refused.
 * Terminal states (applied, rejected, failed, canceled, expired)
 * have no outgoing transitions.
 */
export const REMOTE_INTENT_TRANSITIONS: ReadonlyArray<{
  from: RemoteIntentStatus;
  to: RemoteIntentStatus;
  reason: string;
}> = [
  {
    from: "queued",
    to: "claimed",
    reason: "local node claims the command via POST /remote/claim",
  },
  {
    from: "claimed",
    to: "applied",
    reason: "local node reports successful apply via POST /remote/result",
  },
  {
    from: "claimed",
    to: "rejected",
    reason: "local node declines the command via POST /remote/result",
  },
  {
    from: "claimed",
    to: "failed",
    reason: "local node attempts apply but the attempt errors",
  },
  {
    from: "queued",
    to: "canceled",
    reason: "operator cancels command before any local claim",
  },
  {
    from: "queued",
    to: "expired",
    reason: "hosted maintenance marks an unclaimed command past expires_at",
  },
  {
    from: "claimed",
    to: "expired",
    reason: "hosted maintenance marks a stale claimed command past expires_at",
  },
];

export function isValidRemoteIntentTransition(
  from: RemoteIntentStatus,
  to: RemoteIntentStatus,
): boolean {
  return REMOTE_INTENT_TRANSITIONS.some(
    (t) => t.from === from && t.to === to,
  );
}
