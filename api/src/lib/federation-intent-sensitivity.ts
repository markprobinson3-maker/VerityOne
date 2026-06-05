/**
 * Federation remote-intent sensitivity registry —
 * VO-REMOTE-INTENT-QUEUE-HARDENING-PR-1 (rung 5).
 *
 * Canonical list of (category, command_type) pairs whose
 * payloads carry sensitive material and must be encrypted
 * at rest in `remote_commands.payload` and cleared after
 * terminal result, cancel, or maintenance expiry.
 *
 * Today these command families are sensitive:
 *
 *   ("providers", "set_key") — provider API key payloads.
 *   ("routines", "day_journal.*") — journal text, tags, dates,
 *   routine config, and retraction targets.
 *
 * The registry exists so any new sensitive command type
 * has to register here FIRST before it can ship. A drift
 * test in federation-intent-sensitivity.test.ts asserts
 * that every registered pair is honored by the queue
 * module's encryption helper. If a command type should be
 * sensitive but is not registered, the test fails CI.
 *
 * Sensitivity is not a hosted-write allowlist. Hosted MCP write
 * permission is narrower and lives in hosted-mcp-write-scope.ts;
 * staged or non-hosted remote commands can still be sensitive here
 * so accidental queueing encrypts and scrubs their payloads.
 *
 * Non-sensitive commands (settings toggles, model choice,
 * agent policy, schedule routines) store plaintext payloads at
 * rest. That is a deliberate choice: those payloads do
 * not contain secrets; instrumenting them with encryption
 * would add complexity without a security benefit.
 */

/**
 * One entry per sensitive command.
 */
export type SensitiveIntentStatus = "active" | "staged";

export interface SensitiveIntent {
  category: string;
  commandType: string;
  /**
   * `active` means the command is queueable today. `staged` means the
   * command is intentionally not queueable yet, but legacy/accidental rows
   * must still be encrypted and scrubbed.
   */
  status: SensitiveIntentStatus;
  /**
   * Operator-readable rationale. Explains WHY the payload
   * needs encryption — useful when a reviewer asks "could
   * we remove this?".
   */
  reason: string;
}

export const SENSITIVE_INTENTS: ReadonlyArray<SensitiveIntent> = [
  {
    category: "providers",
    commandType: "set_key",
    status: "active",
    reason:
      "payload contains a provider API key (Anthropic, OpenAI, etc.) that must not persist in plaintext.",
  },
  {
    category: "routines",
    commandType: "day_journal.entry_create",
    status: "active",
    reason:
      "payload contains raw VOJ command text and target-day metadata for a tenant journal entry.",
  },
  {
    category: "routines",
    commandType: "day_journal.entry_retract",
    status: "active",
    reason:
      "payload identifies tenant journal entries and retraction intent; hosted storage must not retain it in plaintext.",
  },
  {
    category: "routines",
    commandType: "day_journal.routine_dry_run",
    status: "staged",
    reason:
      "payload may carry routine config and target-day metadata for a tenant journal preview.",
  },
  {
    category: "routines",
    commandType: "day_journal.routine_run",
    status: "staged",
    reason:
      "payload carries manual routine-run target metadata for tenant day-journal mutation intent.",
  },
];

/**
 * Pre-computed lookup set for fast `isSensitiveIntent`
 * checks. `category|commandType` is delimiter-joined so
 * the set stays small and lookup stays O(1).
 */
const SENSITIVE_KEYS = new Set(
  SENSITIVE_INTENTS.map((s) => `${s.category}|${s.commandType}`),
);

/**
 * True if the (category, commandType) pair is registered
 * as sensitive. Callers MUST use this helper rather than
 * re-implementing the check; the queue module now also
 * imports this as the single source of truth.
 */
export function isSensitiveIntent(
  category: string,
  commandType: string,
): boolean {
  return SENSITIVE_KEYS.has(`${category}|${commandType}`);
}

/**
 * Return every registered sensitive intent. Used by drift
 * tests and by audit / hygiene sweeps in rung 12e.
 */
export function listSensitiveIntents(): ReadonlyArray<SensitiveIntent> {
  return SENSITIVE_INTENTS;
}

// ── Conflict signal contract ──────────────────────────────

/**
 * Structured conflict signal a local node reports on
 * `POST /remote/result` when it detects that its state has
 * diverged from what the hosted queue snapshotted. The
 * hosted side records this signal in
 * `remote_commands.result` JSONB verbatim; dashboards can
 * then render "applied with conflict" separately from
 * "applied cleanly."
 *
 * This is contract-only: no schema change. Local is the
 * authority and wins on conflict; this signal is purely
 * so the outcome is observable.
 */
export interface ConflictSignal {
  conflict: true;
  reason: "local_changed_since_queued" | "schema_mismatch" | "precondition_failed";
  /** Short operator-readable detail. Must not carry raw
   *  payload fields — only names/identifiers. */
  detail: string;
}

/**
 * Typed helper for a local node to construct a conflict
 * signal. Keeps callers from hand-rolling the shape and
 * accidentally leaking payload fields into `detail`.
 */
export function buildConflictSignal(
  reason: ConflictSignal["reason"],
  detail: string,
): ConflictSignal {
  return { conflict: true, reason, detail };
}

/**
 * True if a result envelope carries a conflict signal.
 * Dashboard / activity renderers use this to route
 * display; rung 5's proof runner uses it to assert the
 * contract.
 */
export function isConflictResult(result: unknown): result is ConflictSignal {
  if (typeof result !== "object" || result === null) return false;
  const obj = result as Record<string, unknown>;
  return (
    obj.conflict === true &&
    typeof obj.reason === "string" &&
    ["local_changed_since_queued", "schema_mismatch", "precondition_failed"].includes(
      obj.reason,
    ) &&
    typeof obj.detail === "string"
  );
}
