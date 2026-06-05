import {
  ACCOUNT_SCOPED_COMMAND_TYPES,
  NODE_TARGETED_COMMAND_TYPES,
  type CommandTypePair,
} from "./remote-command-types";
import { isSensitiveIntent, listSensitiveIntents } from "./federation-intent-sensitivity";

export type RemoteCommandPayloadExpiryAction = "scrub" | "preserve";

export interface RemoteCommandPayloadExpiryPolicy extends CommandTypePair {
  action: RemoteCommandPayloadExpiryAction;
}

const ALL_COMMAND_TYPE_PAIRS = [
  ...ACCOUNT_SCOPED_COMMAND_TYPES,
  ...NODE_TARGETED_COMMAND_TYPES,
] as const;

export const REMOTE_COMMAND_PAYLOAD_EXPIRY_POLICY: ReadonlyArray<RemoteCommandPayloadExpiryPolicy> =
  ALL_COMMAND_TYPE_PAIRS.map((pair) => ({
    ...pair,
    action: isSensitiveIntent(pair.category, pair.commandType) ? "scrub" : "preserve",
  }));

// Exported for drift guards and one-off migration tooling that need to
// distinguish currently queueable sensitive commands from staged/legacy
// sensitive commands. Runtime lifecycle scrub uses
// REMOTE_COMMAND_SCRUB_PAIR_KEYS below.
export const REMOTE_COMMAND_QUEUEABLE_SENSITIVE_PAIR_KEYS = REMOTE_COMMAND_PAYLOAD_EXPIRY_POLICY
  .filter((pair) => pair.action === "scrub")
  .map((pair) => `${pair.category}:${pair.commandType}`);

// Full runtime scrub set. This is exactly the sensitive-intent registry,
// including staged or legacy command types that are not currently queueable,
// so cancel, apply, and maintenance cleanup can still clear payloads if
// such rows exist.
export const REMOTE_COMMAND_SCRUB_PAIR_KEYS = listSensitiveIntents()
  .map((pair) => `${pair.category}:${pair.commandType}`);

export function shouldScrubRemoteCommandPayload(category: string, commandType: string): boolean {
  return REMOTE_COMMAND_SCRUB_PAIR_KEYS.includes(`${category}:${commandType}`);
}

/** @deprecated Use REMOTE_COMMAND_SCRUB_PAIR_KEYS. */
export const REMOTE_COMMAND_EXPIRE_SCRUB_PAIR_KEYS = REMOTE_COMMAND_SCRUB_PAIR_KEYS;

/** @deprecated Use shouldScrubRemoteCommandPayload. */
export function shouldScrubPayloadOnExpire(category: string, commandType: string): boolean {
  return shouldScrubRemoteCommandPayload(category, commandType);
}
