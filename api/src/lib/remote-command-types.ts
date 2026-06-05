/**
 * Remote command types and validation.
 *
 * Defines remote command categories, per-category command types,
 * payload validation, and status lifecycle for the remote command queue.
 */

import { HOSTED_SYNC_PROJECTION_PAYLOAD_KEYS } from "./tenant-sync-preferences";
import { parseExplicitVoCommand } from "./day-journal/validate";

// ── Categories ────────────────────────────────────────────────────────

export const COMMAND_CATEGORIES = [
  "memory_lifecycle",
  "structure",
  "settings",
  "account_sync",
  "providers",
  "routines",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

// ── Command types per category ────────────────────────────────────────

export const MEMORY_LIFECYCLE_TYPES = ["approve", "retract", "promote"] as const;
export const STRUCTURE_TYPES = [
  "pyramid_create", "pyramid_rename", "pyramid_delete", "pyramid_describe",
  "project_create", "project_rename", "project_archive", "project_describe",
] as const;
export const SETTINGS_TYPES = ["setting_toggle", "agent_policy"] as const;
export const ACCOUNT_SYNC_TYPES = [
  "drive_revoke",
  "sync_start",
  "sync_stop",
  "mirror_enable",
  "mirror_disable",
  "project_remove_from_vow",
] as const;
export const PROVIDER_TYPES = ["set_key", "remove_key", "set_default_model", "validate_provider", "set_agent_override", "clear_agent_override", "clear_default_model"] as const;

// Hosted MCP rung 9 allows only explicit day-journal entry intents under
// `routines`. Routine dry-run/run commands stay out of the remote-command
// vocabulary until a future rung ships their queue, worker, and rollback
// contract end to end.
export const ROUTINE_TYPES = [
  "schedule_enable", "schedule_disable", "schedule_trigger",
  "schedule_create", "schedule_delete", "schedule_edit",
  "day_journal.entry_create", "day_journal.entry_retract",
] as const;
export const STAGED_DAY_JOURNAL_ROUTINE_COMMAND_TYPES = [
  "day_journal.routine_dry_run",
  "day_journal.routine_run",
] as const;

// Categories whose entire command set is safe for hosted write intent.
export const WRITE_INTENT_FULL_CATEGORIES = ["memory_lifecycle", "structure"] as const;
export const WRITE_INTENT_ROUTINE_TYPES = ["day_journal.entry_create", "day_journal.entry_retract"] as const;
// All categories with any hosted write-intent surface. Use
// WRITE_INTENT_FULL_CATEGORIES when every command type in the category is
// writable; use WRITE_INTENT_ROUTINE_TYPES for the scoped routines exception.
export const WRITE_INTENT_CATEGORIES = [...WRITE_INTENT_FULL_CATEGORIES, "routines"] as const;

export type MemoryLifecycleType = (typeof MEMORY_LIFECYCLE_TYPES)[number];
export type StructureType = (typeof STRUCTURE_TYPES)[number];
export type SettingsType = (typeof SETTINGS_TYPES)[number];
export type AccountSyncType = (typeof ACCOUNT_SYNC_TYPES)[number];
export type ProviderType = (typeof PROVIDER_TYPES)[number];
export type RoutineType = (typeof ROUTINE_TYPES)[number];
export type CommandType = MemoryLifecycleType | StructureType | SettingsType | AccountSyncType | ProviderType | RoutineType;

export interface CommandTypePair {
  category: CommandCategory;
  commandType: CommandType;
}

const TYPE_MAP: Record<CommandCategory, readonly string[]> = {
  memory_lifecycle: MEMORY_LIFECYCLE_TYPES,
  structure: STRUCTURE_TYPES,
  settings: SETTINGS_TYPES,
  account_sync: ACCOUNT_SYNC_TYPES,
  providers: PROVIDER_TYPES,
  routines: ROUTINE_TYPES,
};

// ── Status lifecycle ──────────────────────────────────────────────────
//
// Transitions:
//   queued → claimed → applied | rejected | failed   (worker path)
//   queued → canceled                                 (user-initiated)
//   queued|claimed → expired                          (maintenance timeout)
//
// `canceled` is a distinct terminal state, NOT an alias for `rejected`.
// `rejected` means the worker ran dispatch logic and refused to apply;
// `canceled` means the owning hosted account withdrew the command before
// any worker claimed it. Keeping them separate preserves the audit trail.
// American spelling everywhere.

export const COMMAND_STATUSES = ["queued", "claimed", "applied", "rejected", "failed", "canceled", "expired"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** Terminal statuses — no further transitions. */
export const TERMINAL_STATUSES = ["applied", "rejected", "failed", "canceled", "expired"] as const;

export const HOSTED_SYNC_PROJECTION_KEYS = HOSTED_SYNC_PROJECTION_PAYLOAD_KEYS;

export const REMOTE_COMMAND_ORIGIN_SESSION_TYPES = [
  "hosted-browser-session",
  "hosted-mcp-agent",
] as const;
export type RemoteCommandOriginSessionType = (typeof REMOTE_COMMAND_ORIGIN_SESSION_TYPES)[number];

// ── Command row ───────────────────────────────────────────────────────

export interface RemoteCommandRow {
  id: string;
  tenant_id: string;
  account_id: string;
  category: CommandCategory;
  command_type: CommandType;
  target_node_id: string | null;
  payload: Record<string, unknown>;
  status: CommandStatus;
  claimed_at: string | null;
  claimed_by: string | null;
  result: Record<string, unknown> | null;
  idempotency_key: string | null;
  origin_session_type: RemoteCommandOriginSessionType;
  origin_session_id: string | null;
  origin_credential_id: string | null;
  origin_actor_label: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export const NODE_TARGETED_COMMAND_TYPES = [
  { category: "account_sync", commandType: "drive_revoke" },
] as const satisfies ReadonlyArray<CommandTypePair>;

export const ACCOUNT_SCOPED_COMMAND_TYPES = COMMAND_CATEGORIES.flatMap((category) =>
  TYPE_MAP[category].map((commandType) => ({ category, commandType: commandType as CommandType })),
).filter((pair) => !NODE_TARGETED_COMMAND_TYPES.some((nodeTargeted) =>
  nodeTargeted.category === pair.category && nodeTargeted.commandType === pair.commandType
)) as ReadonlyArray<CommandTypePair>;

export function isNodeTargetedCommand(
  category: string,
  commandType: string,
): category is (typeof NODE_TARGETED_COMMAND_TYPES)[number]["category"] {
  return NODE_TARGETED_COMMAND_TYPES.some((pair) =>
    pair.category === category && pair.commandType === commandType
  );
}

export function isAccountScopedCommand(
  category: string,
  commandType: string,
): boolean {
  return ACCOUNT_SCOPED_COMMAND_TYPES.some((pair) =>
    pair.category === category && pair.commandType === commandType
  );
}

// ── Validation ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * schedule_id must be a positive integer. Accepts numbers and strings
 * of all-digits (hosted form POSTs send scalars as strings). Rejects:
 *   - NaN           (produced by `parseInt("abc")` in the form handler)
 *   - negatives / 0 (serial IDs start at 1)
 *   - non-integers  (1.5, Infinity)
 *   - non-digit strings ("abc", "42x", "  ", "")
 *   - any other type (boolean, object, null, undefined)
 *
 * Without this guard, the hosted POST handler's `parseInt(scheduleId)`
 * would produce NaN on bad input, NaN is typeof "number", and the
 * old shape check would accept it — letting malformed schedule_edit
 * rows queue and fail later in the worker instead of being rejected
 * honestly at submit time.
 */
function isValidScheduleId(v: unknown): boolean {
  if (typeof v === "number") {
    return Number.isInteger(v) && v > 0;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0 || !/^\d+$/.test(t)) return false;
    const n = Number(t);
    return Number.isInteger(n) && n > 0;
  }
  return false;
}

const DAY_JOURNAL_DAY_ADDR_RE = /^TMP\.([0-9]{4})\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$/;
const DAY_JOURNAL_MANUAL_ENTRY_KEY_RE = /^entry_[0-9]{8}_[a-f0-9]{16}$/;

function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function isValidDayAddr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(DAY_JOURNAL_DAY_ADDR_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const dayOfYear = Number(match[2]);
  const date = new Date(Date.UTC(year, 0, dayOfYear));
  return date.getUTCFullYear() === year;
}

function targetDateFromDayAddr(value: string): string | null {
  if (!isValidDayAddr(value)) return null;
  const match = value.match(DAY_JOURNAL_DAY_ADDR_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const dayOfYear = Number(match[2]);
  return new Date(Date.UTC(year, 0, dayOfYear)).toISOString().slice(0, 10);
}

function hasDayJournalTarget(p: Record<string, unknown>, commandType: string): ValidationResult | null {
  const hasTargetDate = p.target_date !== undefined;
  const hasDayAddr = p.day_addr !== undefined;
  if (!hasTargetDate && !hasDayAddr) {
    return { valid: false, error: `${commandType} requires target_date or day_addr` };
  }
  if (hasTargetDate && !isRealIsoDate(p.target_date)) {
    return { valid: false, error: `${commandType} target_date must be a real YYYY-MM-DD date` };
  }
  if (hasDayAddr && !isValidDayAddr(p.day_addr)) {
    return { valid: false, error: `${commandType} day_addr must be a TMP.YYYY.DDD address` };
  }
  if (hasTargetDate && hasDayAddr && typeof p.target_date === "string" && typeof p.day_addr === "string") {
    const addrDate = targetDateFromDayAddr(p.day_addr);
    if (addrDate !== p.target_date) {
      return { valid: false, error: `${commandType} target_date and day_addr must refer to the same day` };
    }
  }
  return null;
}

function validateParsedDayJournalCreateOptions(
  p: Record<string, unknown>,
  parsed: Extract<ReturnType<typeof parseExplicitVoCommand>, { kind: "journal_create" }>,
): ValidationResult | null {
  if (parsed.options.target_date) {
    if (typeof p.target_date === "string" && p.target_date !== parsed.options.target_date) {
      return { valid: false, error: "day_journal.entry_create target_date must match command_text --date" };
    }
    if (typeof p.day_addr === "string") {
      const addrDate = targetDateFromDayAddr(p.day_addr);
      if (addrDate !== parsed.options.target_date) {
        return { valid: false, error: "day_journal.entry_create day_addr must match command_text --date" };
      }
    }
  }
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string")) {
      return { valid: false, error: "day_journal.entry_create tags must be a string array matching command_text --tags" };
    }
    const top = p.tags;
    const parsedTags = parsed.options.tags;
    if (
      top.length !== parsedTags.length ||
      !top.every((t, i) => t === parsedTags[i])
    ) {
      return { valid: false, error: "day_journal.entry_create tags must match command_text --tags" };
    }
  }
  return null;
}

function validateDayJournalIdempotencyKey(p: Record<string, unknown>, commandType: string): ValidationResult | null {
  if (typeof p.idempotency_key !== "string") {
    return { valid: false, error: `${commandType} requires idempotency_key (string)` };
  }
  const key = p.idempotency_key.normalize("NFC").trim();
  if (!key || key.includes("\0") || key.length > 256) {
    return { valid: false, error: `${commandType} idempotency_key must be a bounded non-empty string without NUL bytes` };
  }
  p.idempotency_key = key;
  return null;
}

function validateOptionalDayJournalTargetTimezone(p: Record<string, unknown>, commandType: string): ValidationResult | null {
  if (p.target_timezone === undefined) return null;
  if (
    typeof p.target_timezone !== "string" ||
    p.target_timezone.trim() !== p.target_timezone ||
    p.target_timezone.length === 0 ||
    p.target_timezone.length > 128 ||
    /[\0\r\n]/.test(p.target_timezone)
  ) {
    return { valid: false, error: `${commandType} target_timezone must be a safe timezone string` };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: p.target_timezone }).format(new Date(0));
  } catch {
    return { valid: false, error: `${commandType} target_timezone must be a valid IANA time zone` };
  }
  return null;
}

function rejectUnexpectedDayJournalFields(
  p: Record<string, unknown>,
  commandType: string,
  allowed: readonly string[],
): ValidationResult | null {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(p).find((key) => !allowedSet.has(key));
  return unexpected
    ? { valid: false, error: `${commandType} unexpected payload field: ${unexpected}` }
    : null;
}

/**
 * Validate a command's category, type, and payload shape.
 * Returns { valid: true } or { valid: false, error: "reason" }.
 */
export function validateCommand(
  category: string,
  commandType: string,
  payload: unknown,
): ValidationResult {
  if (!COMMAND_CATEGORIES.includes(category as CommandCategory)) {
    return { valid: false, error: `Invalid category: ${category}. Must be one of: ${COMMAND_CATEGORIES.join(", ")}` };
  }

  const validTypes = TYPE_MAP[category as CommandCategory];
  if (!validTypes.includes(commandType)) {
    if (
      category === "routines" &&
      (STAGED_DAY_JOURNAL_ROUTINE_COMMAND_TYPES as readonly string[]).includes(commandType)
    ) {
      return {
        valid: false,
        error: `${commandType} is staged for a future ladder rung and is not currently queueable`,
      };
    }
    return { valid: false, error: `Invalid command_type "${commandType}" for category "${category}". Must be one of: ${validTypes.join(", ")}` };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, error: "payload must be a JSON object" };
  }

  const p = payload as Record<string, unknown>;
  const hasOnlyPayloadKeys = (allowed: readonly string[]) => {
    const allowedSet = new Set([...allowed, ...HOSTED_SYNC_PROJECTION_PAYLOAD_KEYS]);
    return !Object.keys(p).some((key) => !allowedSet.has(key));
  };

  // Per-type payload validation
  switch (commandType) {
    // Memory lifecycle
    case "approve":
      if (typeof p.addr !== "string" || !p.addr) return { valid: false, error: "approve requires addr (string)" };
      break;
    case "retract":
      if (typeof p.addr !== "string" || !p.addr) return { valid: false, error: "retract requires addr (string)" };
      break;
    case "promote":
      if (typeof p.overlay_addr !== "string" || !p.overlay_addr) return { valid: false, error: "promote requires overlay_addr (string)" };
      break;

    // Structure
    case "pyramid_create":
      if (typeof p.label !== "string" || !p.label) return { valid: false, error: "pyramid_create requires label (string)" };
      if (p.sync_level !== undefined && p.sync_level !== "local_only" && p.sync_level !== "managed_mirror") {
        return { valid: false, error: "pyramid_create sync_level must be 'local_only' or 'managed_mirror'" };
      }
      break;
    case "pyramid_rename":
      if (typeof p.pyramid_id !== "string" || !p.pyramid_id) return { valid: false, error: "pyramid_rename requires pyramid_id (string)" };
      if (typeof p.label !== "string" || !p.label) return { valid: false, error: "pyramid_rename requires label (string)" };
      break;
    case "pyramid_delete":
      if (typeof p.pyramid_id !== "string" || !p.pyramid_id) return { valid: false, error: "pyramid_delete requires pyramid_id (string)" };
      break;
    case "pyramid_describe":
      if (typeof p.pyramid_id !== "string" || !p.pyramid_id) return { valid: false, error: "pyramid_describe requires pyramid_id (string)" };
      if (typeof p.description !== "string") return { valid: false, error: "pyramid_describe requires description (string)" };
      break;
    case "project_create":
      if (typeof p.label !== "string" || !p.label) return { valid: false, error: "project_create requires label (string)" };
      break;
    case "project_rename":
      if (typeof p.addr !== "string" || !p.addr) return { valid: false, error: "project_rename requires addr (string)" };
      if (typeof p.label !== "string" || !p.label) return { valid: false, error: "project_rename requires label (string)" };
      break;
    case "project_archive":
      if (typeof p.addr !== "string" || !p.addr) return { valid: false, error: "project_archive requires addr (string)" };
      break;
    case "project_describe":
      if (typeof p.addr !== "string" || !p.addr) return { valid: false, error: "project_describe requires addr (string)" };
      if (typeof p.description !== "string") return { valid: false, error: "project_describe requires description (string)" };
      break;

    // Settings
    case "setting_toggle": {
      // VO-DASHBOARD-HOSTED-SETTINGS-PR-1: tighten queue-time validation
      // to match the canonical local write contract in
      // `writeTenantSetting` — same WRITABLE_SETTINGS_KEYS membership +
      // same per-key value shape (boolean for vo_enabled, exact enum
      // for the four string settings). Without this, hosted Settings
      // would let users queue dead-on-arrival commands that only fail
      // later in dispatch. The shared `validateSettingValue` helper
      // is the single source of truth.
      if (typeof p.key !== "string" || !p.key) return { valid: false, error: "setting_toggle requires key (string)" };
      if (p.value === undefined) return { valid: false, error: "setting_toggle requires value" };
      const { validateSettingValue } = require("./runtime-profile");
      const r = validateSettingValue(p.key, p.value);
      if (!r.valid) return { valid: false, error: r.error };
      break;
    }
    case "agent_policy": {
      // VO-DASHBOARD-HOSTED-AGENT-POLICY-PR-1: tightened queue-time
      // validation to match the canonical `validatePolicyUpdate(...)`
      // contract used by `applyAgentPolicyPatch` in dispatch. Without
      // this, hosted could queue dead-on-arrival rows that only
      // failed later in dispatch. Shared validator = single source
      // of truth for `WRITABLE_POLICY_KEYS` + per-key shape:
      //   write_permission -> VALID_WRITE_PERMISSIONS
      //   recall_scope     -> VALID_RECALL_SCOPES
      //   visible_projects -> null | string[] (empty array normalized)
      if (typeof p.agent_id !== "string" || !p.agent_id) return { valid: false, error: "agent_policy requires agent_id (string)" };
      if (typeof p.key !== "string" || !p.key) return { valid: false, error: "agent_policy requires key (string)" };
      if (!("value" in p)) return { valid: false, error: "agent_policy requires value" };
      const { validatePolicyUpdate, WRITABLE_POLICY_KEYS } = require("./agent-policy");
      if (!(WRITABLE_POLICY_KEYS as readonly string[]).includes(p.key)) {
        return { valid: false, error: `agent_policy key must be one of: ${(WRITABLE_POLICY_KEYS as readonly string[]).join(", ")}` };
      }
      const r = validatePolicyUpdate({ [p.key]: p.value });
      if (r.errors.length > 0) {
        return { valid: false, error: r.errors.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join("; ") };
      }
      if (Object.keys(r.valid).length === 0) {
        return { valid: false, error: `agent_policy payload produced no valid fields after normalization` };
      }
      break;
    }

    // Account sync
    case "drive_revoke":
      if (p.tenant_id !== undefined && typeof p.tenant_id !== "string") {
        return { valid: false, error: "drive_revoke tenant_id must be a string when present" };
      }
      if (typeof p.node_id !== "string" || !p.node_id) {
        return { valid: false, error: "drive_revoke node_id must be a string" };
      }
      if (p.reason !== undefined && typeof p.reason !== "string") {
        return { valid: false, error: "drive_revoke reason must be a string when present" };
      }
      break;
    case "sync_start":
    case "sync_stop":
      if (Object.keys(p).some((key) =>
        key !== "reason" &&
        !HOSTED_SYNC_PROJECTION_PAYLOAD_KEYS.has(key)
      )) {
        return { valid: false, error: `${commandType} accepts only optional reason` };
      }
      if (p.reason !== undefined && typeof p.reason !== "string") {
        return { valid: false, error: `${commandType} reason must be a string when present` };
      }
      break;
    case "mirror_enable":
      if (!hasOnlyPayloadKeys(["project_addr"])) {
        return { valid: false, error: "mirror_enable accepts only project_addr" };
      }
      if (typeof p.project_addr !== "string" || !/^PJ\.[0-9]+(?:\.[0-9]+)*$/.test(p.project_addr)) {
        return { valid: false, error: "mirror_enable requires project_addr (PJ address string)" };
      }
      break;
    case "mirror_disable":
      if (!hasOnlyPayloadKeys(["project_addr", "keep_existing"])) {
        return { valid: false, error: "mirror_disable accepts only project_addr and keep_existing" };
      }
      if (typeof p.project_addr !== "string" || !/^PJ\.[0-9]+(?:\.[0-9]+)*$/.test(p.project_addr)) {
        return { valid: false, error: "mirror_disable requires project_addr (PJ address string)" };
      }
      if (typeof p.keep_existing !== "boolean") {
        return { valid: false, error: "mirror_disable requires keep_existing (boolean)" };
      }
      break;
    case "project_remove_from_vow":
      if (!hasOnlyPayloadKeys(["project_addr"])) {
        return { valid: false, error: "project_remove_from_vow accepts only project_addr" };
      }
      if (typeof p.project_addr !== "string" || !/^PJ\.[0-9]+(?:\.[0-9]+)*$/.test(p.project_addr)) {
        return { valid: false, error: "project_remove_from_vow requires project_addr (PJ address string)" };
      }
      break;

    // Providers
    case "set_key":
      if (typeof p.provider !== "string" || !p.provider) return { valid: false, error: "set_key requires provider (string)" };
      if (typeof p.key !== "string" || !p.key) return { valid: false, error: "set_key requires key (string)" };
      break;
    case "remove_key":
      if (typeof p.provider !== "string" || !p.provider) return { valid: false, error: "remove_key requires provider (string)" };
      break;
    case "set_default_model": {
      if (typeof p.task_type !== "string" || !p.task_type) return { valid: false, error: "set_default_model requires task_type (string)" };
      if (typeof p.provider !== "string" || !p.provider) return { valid: false, error: "set_default_model requires provider (string)" };
      if (typeof p.model !== "string" || !p.model) return { valid: false, error: "set_default_model requires model (string)" };
      // VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: enforce canonical
      // task_type at queue time. Same constraint as `clear_default_model`
      // — set/clear stay symmetric on what they accept. The helper layer
      // (`writeTaskRoute` → `assertCanonicalTask`) is the source of
      // truth, but rejecting at queue time avoids dead-on-arrival rows.
      const { CANONICAL_TASKS } = require("./provider-config");
      if (!CANONICAL_TASKS.includes(p.task_type.trim())) {
        return {
          valid: false,
          error: `set_default_model task_type must be one of: ${CANONICAL_TASKS.join(", ")}`,
        };
      }
      break;
    }
    case "validate_provider":
      // VO-REMOTE-COMMAND-PROVIDER-VALIDATE-PR-1.
      //   Narrow payload: `provider` only. No API key ever rides along —
      //   local VO reads the locally-stored key itself via readProviderKey()
      //   when the worker dispatches this command. Trim-rejecting the
      //   empty string catches accidentally-blank form submits.
      if (typeof p.provider !== "string" || p.provider.trim().length === 0) {
        return { valid: false, error: "validate_provider requires provider (non-empty string)" };
      }
      break;
    case "clear_default_model": {
      // VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1.
      //   Strict 1-field payload: canonical task_type only. NO
      //   provider/model/key/agent_id/task ever rides along.
      //   Idempotent semantics (already-clear → ok:true,
      //   cleared:false) live in clearTaskRoute(), not here.
      if (typeof p.task_type !== "string" || p.task_type.trim().length === 0) {
        return { valid: false, error: "clear_default_model requires task_type (non-empty string)" };
      }
      const { CANONICAL_TASKS } = require("./provider-config");
      if (!CANONICAL_TASKS.includes(p.task_type.trim())) {
        return {
          valid: false,
          error: `clear_default_model task_type must be one of: ${CANONICAL_TASKS.join(", ")}`,
        };
      }
      break;
    }
    case "clear_agent_override": {
      // VO-PROVIDER-AGENT-OVERRIDE-CLEAR-PR-1.
      //   Strict 2-field payload: agent_id + canonical task. NO
      //   provider/model/key/task_type ever rides along — the POST
      //   handler must build the payload with only these two fields.
      //   Idempotent semantics (clear-when-already-clear → ok:true,
      //   cleared:false) live in the canonical helper, not here.
      if (typeof p.agent_id !== "string" || p.agent_id.trim().length === 0) {
        return { valid: false, error: "clear_agent_override requires agent_id (non-empty string)" };
      }
      if (typeof p.task !== "string" || p.task.trim().length === 0) {
        return { valid: false, error: "clear_agent_override requires task (non-empty string)" };
      }
      const { CANONICAL_TASKS } = require("./provider-config");
      if (!CANONICAL_TASKS.includes(p.task.trim())) {
        return {
          valid: false,
          error: `clear_agent_override task must be one of: ${CANONICAL_TASKS.join(", ")}`,
        };
      }
      break;
    }
    case "set_agent_override": {
      // VO-REMOTE-COMMAND-PROVIDER-AGENT-OVERRIDE-PR-1.
      //   Strictly four non-empty string fields: agent_id, task, provider,
      //   model. No API key, no task_type alias, no batch. The hosted
      //   POST handler must carry ONLY these fields — the shared provider
      //   form's `key` input must never ride along.
      if (typeof p.agent_id !== "string" || p.agent_id.trim().length === 0) {
        return { valid: false, error: "set_agent_override requires agent_id (non-empty string)" };
      }
      if (typeof p.task !== "string" || p.task.trim().length === 0) {
        return { valid: false, error: "set_agent_override requires task (non-empty string)" };
      }
      if (typeof p.provider !== "string" || p.provider.trim().length === 0) {
        return { valid: false, error: "set_agent_override requires provider (non-empty string)" };
      }
      if (typeof p.model !== "string" || p.model.trim().length === 0) {
        return { valid: false, error: "set_agent_override requires model (non-empty string)" };
      }
      // Restrict task to the canonical task list. Without this the
      // queue would accept arbitrary strings and the helper would
      // persist them as non-canonical keys that the hosted UI cannot
      // select from its canonical-task <select>, creating
      // applied-but-unmanageable override state. Also defensive
      // against "foo,bar" path-split attempts — though the helper
      // now uses an array-typed jsonb path that wouldn't split
      // regardless, rejecting non-canonical tasks at queue time is
      // the simpler correctness guarantee.
      const { CANONICAL_TASKS } = require("./provider-config");
      const taskTrimmed = (p.task as string).trim();
      if (!CANONICAL_TASKS.includes(taskTrimmed)) {
        return {
          valid: false,
          error: `set_agent_override task must be one of: ${CANONICAL_TASKS.join(", ")}`,
        };
      }
      break;
    }

    // Routines
    case "schedule_enable":
    case "schedule_disable":
    case "schedule_trigger":
    case "schedule_delete":
      if (!isValidScheduleId(p.schedule_id)) {
        return { valid: false, error: `${commandType} requires schedule_id (positive integer)` };
      }
      break;
    case "schedule_create":
      if (typeof p.adapter_name !== "string" || !p.adapter_name) return { valid: false, error: "schedule_create requires adapter_name (string)" };
      break;
    case "schedule_edit": {
      // VO-REMOTE-COMMAND-SCHEDULE-EDIT-PR-1:
      //   The canonical PATCH route treats omitted fields as "keep current".
      //   Without a "must have at least one editable field" rule here, a
      //   queued `schedule_edit` with only `schedule_id` would succeed as
      //   a no-op and produce fake "applied" history — misleading the
      //   tenant into thinking something changed. Reject empty edits up
      //   front so worker dispatch never performs a no-op.
      if (!isValidScheduleId(p.schedule_id)) {
        return { valid: false, error: "schedule_edit requires schedule_id (positive integer)" };
      }
      if (p.source_input !== undefined && typeof p.source_input !== "string") {
        return { valid: false, error: "schedule_edit source_input must be a string" };
      }
      if (p.schedule_cron !== undefined && typeof p.schedule_cron !== "string") {
        return { valid: false, error: "schedule_edit schedule_cron must be a string" };
      }
      const hasSource = typeof p.source_input === "string" && p.source_input.trim().length > 0;
      const hasCron = typeof p.schedule_cron === "string" && p.schedule_cron.trim().length > 0;
      if (!hasSource && !hasCron) {
        return { valid: false, error: "schedule_edit requires at least one of source_input or schedule_cron" };
      }
      break;
    }
    case "day_journal.entry_create": {
      const allowed = [
        "command_text",
        "target_date",
        "day_addr",
        "target_timezone",
        "idempotency_key",
        "tags",
      ] as const;
      const unexpected = rejectUnexpectedDayJournalFields(p, commandType, allowed);
      if (unexpected) return unexpected;
      if (typeof p.command_text !== "string" || p.command_text.trim().length === 0) {
        return { valid: false, error: "day_journal.entry_create requires command_text (non-empty string)" };
      }
      if (p.command_text.includes("\0") || p.command_text.length > 16_384) {
        return { valid: false, error: "day_journal.entry_create command_text must be <= 16384 characters without NUL bytes" };
      }
      const parsed = parseExplicitVoCommand(p.command_text);
      if (parsed.kind !== "journal_create") {
        return { valid: false, error: "day_journal.entry_create command_text must parse as a VOJ journal command" };
      }
      const target = hasDayJournalTarget(p, commandType);
      if (target) return target;
      const idempotency = validateDayJournalIdempotencyKey(p, commandType);
      if (idempotency) return idempotency;
      const timezone = validateOptionalDayJournalTargetTimezone(p, commandType);
      if (timezone) return timezone;
      const parsedOptions = validateParsedDayJournalCreateOptions(p, parsed);
      if (parsedOptions) return parsedOptions;
      break;
    }
    case "day_journal.entry_retract": {
      const unexpected = rejectUnexpectedDayJournalFields(p, commandType, [
        "entry_key",
        "idempotency_key",
        "reason",
      ]);
      if (unexpected) return unexpected;
      if (typeof p.entry_key !== "string" || !DAY_JOURNAL_MANUAL_ENTRY_KEY_RE.test(p.entry_key)) {
        return { valid: false, error: "day_journal.entry_retract requires entry_key (manual day-journal entry key)" };
      }
      const idempotency = validateDayJournalIdempotencyKey(p, commandType);
      if (idempotency) return idempotency;
      if (p.reason !== undefined && (typeof p.reason !== "string" || p.reason.length > 512 || p.reason.includes("\0"))) {
        return { valid: false, error: "day_journal.entry_retract reason must be a string <= 512 characters without NUL bytes" };
      }
      break;
    }
  }

  return { valid: true };
}
