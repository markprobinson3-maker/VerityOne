/**
 * Tenant Routine Plugin — the capability + admission contract that generalizes
 * day-node journal routines into opt-in, tenant-configured, budget-bounded
 * plugins (Tier-2 harness-first OS, PR 8: contract-first, NO new table).
 *
 * VO already has a working tenant-pluggable routine mechanism — the day-journal
 * routine registry (DayJournalRoutineDefinition: id/schedule/sensitivity/
 * routineClass/permissions/configSchema/run, registered per tenant in
 * tenant_day_journal_routines with enable/schedule/config/permission_grants).
 * It also already has the pure budget primitive (supercron-budget-policy's
 * evaluateBudgetCheck -> BudgetCheckResult) and the cooldown primitive
 * (PassCooldownState.cooldownTriggered). Per the Tier-2 rule ("classify/normalize
 * OVER existing structures; do NOT add redundant tables") this module does NOT
 * fork a parallel registry. It defines:
 *
 *   1. RoutinePluginSpec — a normalized capability descriptor that GENERALIZES
 *      DayJournalRoutineDefinition (lifts out the journal-specific run/payload
 *      fields) and adds the two things a tenant plugin needs that the journal
 *      definition lacks: a per-run BUDGET ceiling (micro-USD) and a typed
 *      OUTPUT_TARGET restricted to SAFE sinks.
 *   2. validateRoutinePlugin — encodes the PR8 acceptance as a hard invariant:
 *      a routine's output_target can only be a day node / workflow run / structured
 *      fact, NEVER an active memory (the "no noisy daily memories" guiding rule is
 *      not merely a convention — an active-memory sink is not even representable).
 *   3. evaluateRoutineAdmission — a PURE, DETERMINISTIC gate that unifies the
 *      dimensions that today live in separate places (enabled + schedule-due in
 *      the scheduler, budget in supercron, authority in routineNeedsScopedAuthority,
 *      permission grants on the tenant row) into ONE admission verdict: may this
 *      tenant routine run right now, within scope and budget?
 *
 * It is PURE and DB-free: it COMPOSES the already-computed OUTCOMES of the budget
 * and cooldown gates (the caller runs the DB loaders + evaluateBudgetCheck, then
 * passes the BudgetCheckResult-shaped signal in — mirroring how #66 takes an
 * already-computed ReviewQueue). It adds NO store, NO route, and NO LLM call;
 * registration (tenant_day_journal_routines) and execution (the scheduler) stay
 * where they are.
 */

import { createHash } from "node:crypto";

// ── Vocabularies (mirror DayJournalRoutineDefinition) ──────────────────────────

/** Data-sensitivity tier — mirrors DayJournalRoutineDefinition.sensitivity. */
export type RoutineSensitivity = "standard" | "personal" | "health" | "financial" | "calendar" | "email";
export const ROUTINE_SENSITIVITIES: readonly RoutineSensitivity[] = [
  "standard", "personal", "health", "financial", "calendar", "email",
] as const;

/** Whether a routine only reads/records context or also takes action. */
export type RoutineClass = "context_only" | "actionable";
export const ROUTINE_CLASSES: readonly RoutineClass[] = ["context_only", "actionable"] as const;

/** Capability a routine declares — mirrors the day-journal permission vocabulary. */
export type RoutinePermission =
  | "journal_write" | "network" | "local_files" | "calendar"
  | "email" | "browser" | "health" | "finance" | "llm";
export const ROUTINE_PERMISSIONS: readonly RoutinePermission[] = [
  "journal_write", "network", "local_files", "calendar", "email", "browser", "health", "finance", "llm",
] as const;

/**
 * The SAFE output sinks a routine may write to. This enum is the machine-enforced
 * form of the PR8 guiding principle ("routines write structured day-node journal
 * facts, not noisy daily memories"): an active-memory sink is deliberately NOT a
 * member, so a routine can never be configured to pollute recall.
 *   - day_node          → the day node's substance.journal.<path> (writeDayJournalEntry)
 *   - structured_fact   → the tenant_day_journal_entries audit/search index
 *   - workflow_run      → a WorkflowRun (#64) over existing run ledgers
 */
export type RoutineOutputTarget = "day_node" | "structured_fact" | "workflow_run";
export const ROUTINE_OUTPUT_TARGETS: readonly RoutineOutputTarget[] = [
  "day_node", "structured_fact", "workflow_run",
] as const;

/** Dry-run capability — mirrors DayJournalRoutineDefinition.dryRunMode. */
export type RoutineDryRunMode = "hosted_metadata_ok" | "local_required";
export const ROUTINE_DRY_RUN_MODES: readonly RoutineDryRunMode[] = ["hosted_metadata_ok", "local_required"] as const;

/** Authority a routine requires to run — extends routineNeedsScopedAuthority. */
export type RoutineAuthority = "tenant" | "scoped";
export const ROUTINE_AUTHORITIES: readonly RoutineAuthority[] = ["tenant", "scoped"] as const;

/** Why a routine was NOT admitted to run — surfaced so the gate is never silent. */
export type RoutineAdmissionBlockReason =
  | "not_enabled"
  | "not_due"
  | "in_cooldown"
  | "over_budget"
  | "missing_permission_grant"
  | "outside_active_hours"
  | "needs_scoped_authority";
export const ROUTINE_ADMISSION_BLOCK_REASONS: readonly RoutineAdmissionBlockReason[] = [
  "not_enabled", "not_due", "in_cooldown", "over_budget",
  "missing_permission_grant", "outside_active_hours", "needs_scoped_authority",
] as const;

// ── Grammar (reused verbatim from the day-journal contract) ────────────────────

/** Dotted lowercase routine id, 2–8 segments (matches tenant_day_journal_routines CHECK). */
const ROUTINE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Per-segment safety cap (matches the day-journal registry SAFE_SEGMENT_RE + the SQL target_path CHECK). */
const SAFE_SEGMENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Segment names that must never appear in an id (prototype-pollution guard; mirrors the registry). */
const FORBIDDEN_ID_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
/** Schedule v1 grammar (matches the SQL CHECK): daily|weekday|weekly:<dow> @ HH:MM. */
const SCHEDULE_V1_RE = /^(daily|weekday|weekly:(mon|tue|wed|thu|fri|sat|sun))@([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_ROUTINE_ID_SEGMENTS = 8;

/** Per-run LLM budget ceiling bounds (micro-USD), aligned with the tenant daily-cap bounds. */
export const MIN_ROUTINE_BUDGET_MICRO = 0;
export const MAX_ROUTINE_BUDGET_MICRO = 2_000_000;

// ── The spec ───────────────────────────────────────────────────────────────────

export interface RoutinePluginSpec {
  /** Dotted lowercase id, e.g. "market.spy_qqq_close". */
  id: string;
  label: string;
  /** Cadence in the v1 schedule grammar (a default; the tenant row may override). */
  schedule: string;
  routine_class: RoutineClass;
  sensitivity: RoutineSensitivity;
  /** Declared capabilities; must include "journal_write". */
  permissions: RoutinePermission[];
  /** Where the routine's output lands — restricted to SAFE sinks (never active memory). */
  output_target: RoutineOutputTarget;
  /** Per-run LLM spend ceiling in integer micro-USD (0 = the routine uses no LLM). */
  budget_ceiling_micro: number;
  /** Dry-run capability; local_required raises the authority bar (mirrors the registry). */
  dry_run_mode: RoutineDryRunMode;
  /** Max wall-clock per run (ms). */
  timeout_ms: number;
  /** Routines are opt-in: this MUST be false; a tenant enables it on their own row. */
  default_enabled: false;
}

export interface BuildRoutinePluginInput {
  id: string;
  label?: string;
  schedule: string;
  routine_class?: RoutineClass;
  sensitivity?: RoutineSensitivity;
  permissions?: RoutinePermission[];
  output_target?: RoutineOutputTarget;
  budget_ceiling_micro?: number;
  dry_run_mode?: RoutineDryRunMode;
  timeout_ms?: number;
}

const DEFAULT_ROUTINE_TIMEOUT_MS = 30_000;
/** No LLM spend by default — a default routine records context, so it needs no budget. */
const DEFAULT_ROUTINE_BUDGET_MICRO = 0;

/**
 * Build a RoutinePluginSpec with conservative, safe defaults: context_only +
 * standard sensitivity, journal_write-only, day_node output, NO LLM budget,
 * hosted-metadata dry-run, and default_enabled pinned false (routines are always
 * opt-in). The permissions array is copied so the returned spec never aliases the
 * caller's input.
 */
export function buildRoutinePlugin(input: BuildRoutinePluginInput): RoutinePluginSpec {
  const permissions: RoutinePermission[] = input.permissions ? [...input.permissions] : ["journal_write"];
  return {
    id: input.id,
    label: input.label ?? input.id,
    schedule: input.schedule,
    routine_class: input.routine_class ?? "context_only",
    sensitivity: input.sensitivity ?? "standard",
    permissions,
    output_target: input.output_target ?? "day_node",
    budget_ceiling_micro: input.budget_ceiling_micro ?? DEFAULT_ROUTINE_BUDGET_MICRO,
    dry_run_mode: input.dry_run_mode ?? "hosted_metadata_ok",
    timeout_ms: input.timeout_ms ?? DEFAULT_ROUTINE_TIMEOUT_MS,
    default_enabled: false,
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

function normalizeKeyPart(label: string, value: string): string {
  const trimmed = (value ?? "").normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError(`routine-plugin ${label} must be a bounded non-empty string without NUL bytes.`);
  }
  return trimmed;
}

/**
 * Deterministic dedup key (sha256 hex) for a routine plugin, keyed on its id
 * alone — a routine's identity is its id, matching the registry's UNIQUE
 * (tenant_id, routine_id) contract (output_target/config are not identity).
 * Mirrors workflowRunIdempotencyKey.
 */
export function routinePluginIdempotencyKey(spec: RoutinePluginSpec): string {
  const seed = normalizeKeyPart("id", spec.id);
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface RoutinePluginValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a routine plugin's contract. Beyond enum/grammar checks this enforces
 * the PR8 invariants: a routine is opt-in (default_enabled false), always declares
 * journal_write, stays within the per-run budget ceiling, and — crucially — can
 * only target a SAFE output sink (the active-memory sink is not representable, so
 * "routines never write noisy daily memories" is structurally guaranteed).
 */
export function validateRoutinePlugin(spec: RoutinePluginSpec): RoutinePluginValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  if (!spec.id || !ROUTINE_ID_RE.test(spec.id)) {
    errors.push("id must be a dotted lowercase identifier (e.g. \"market.spy_qqq_close\")");
  } else {
    // Mirror the day-journal registry's per-segment guards so an ok() spec is always
    // registry-acceptable: <=8 segments, each <=64 chars, none a prototype-pollution name.
    const segments = spec.id.split(".");
    if (segments.length > MAX_ROUTINE_ID_SEGMENTS) errors.push(`id must have at most ${MAX_ROUTINE_ID_SEGMENTS} segments`);
    if (!segments.every((s) => SAFE_SEGMENT_RE.test(s))) errors.push("each id segment must be 1–64 chars matching [a-z][a-z0-9_]*");
    if (segments.some((s) => FORBIDDEN_ID_SEGMENTS.has(s))) errors.push("id segments must not be __proto__, prototype, or constructor");
  }
  if (!spec.label) errors.push("label is required");
  if (!spec.schedule || !SCHEDULE_V1_RE.test(spec.schedule)) {
    errors.push("schedule must match the v1 grammar (daily|weekday|weekly:<dow>@HH:MM)");
  }

  inEnum(spec.routine_class, ROUTINE_CLASSES, "routine_class");
  inEnum(spec.sensitivity, ROUTINE_SENSITIVITIES, "sensitivity");
  inEnum(spec.output_target, ROUTINE_OUTPUT_TARGETS, "output_target");
  inEnum(spec.dry_run_mode, ROUTINE_DRY_RUN_MODES, "dry_run_mode");

  if (!Array.isArray(spec.permissions) || spec.permissions.length === 0) {
    errors.push("permissions must be a non-empty array");
  } else {
    for (const p of spec.permissions) inEnum(p, ROUTINE_PERMISSIONS, "permissions[]");
    if (!spec.permissions.includes("journal_write")) {
      errors.push("permissions must include \"journal_write\"");
    }
    if (new Set(spec.permissions).size !== spec.permissions.length) {
      errors.push("permissions must not contain duplicates"); // matches the registry contract
    }
  }

  if (!Number.isInteger(spec.budget_ceiling_micro)
    || spec.budget_ceiling_micro < MIN_ROUTINE_BUDGET_MICRO
    || spec.budget_ceiling_micro > MAX_ROUTINE_BUDGET_MICRO) {
    errors.push(`budget_ceiling_micro must be an integer in [${MIN_ROUTINE_BUDGET_MICRO}, ${MAX_ROUTINE_BUDGET_MICRO}]`);
  }
  if (!(spec.timeout_ms > 0)) errors.push("timeout_ms must be > 0");

  // Routines are opt-in — a definition can never ship enabled-by-default.
  if (spec.default_enabled !== false) errors.push("default_enabled must be false (routines are opt-in)");

  return { ok: errors.length === 0, errors };
}

// ── Authority ──────────────────────────────────────────────────────────────────

/**
 * The authority a routine requires. EXTENDS day-journal's routineNeedsScopedAuthority:
 * it keeps that function's three scoped triggers — a local-required dry-run, a
 * non-standard sensitivity, or any permission beyond journal_write — and adds one
 * more (an `actionable` routine is always scoped), so it is never LESS strict than
 * the registry's gate (it never under-classifies a routine that the registry would
 * scope). Otherwise plain tenant authority suffices.
 */
export function requiredRoutineAuthority(
  spec: Pick<RoutinePluginSpec, "routine_class" | "sensitivity" | "permissions"> & { dry_run_mode?: RoutineDryRunMode },
): RoutineAuthority {
  const beyondJournalWrite = spec.permissions.some((p) => p !== "journal_write");
  const localRequired = spec.dry_run_mode === "local_required";
  if (spec.routine_class === "actionable" || localRequired || spec.sensitivity !== "standard" || beyondJournalWrite) {
    return "scoped";
  }
  return "tenant";
}

// ── Admission gate ───────────────────────────────────────────────────────────

/**
 * A budget outcome from supercron-budget-policy's evaluateBudgetCheck, passed in.
 * A structural subset of BudgetCheckResult ({allowed, reason, remainingMicro}) —
 * camelCase so a caller can pass a BudgetCheckResult through unmodified.
 */
export interface RoutineBudgetSignal {
  allowed: boolean;
  reason: string;
  remainingMicro: number;
}

export interface RoutineAdmissionState {
  /** From the tenant's routine row (tenant_day_journal_routines.enabled). */
  enabled: boolean;
  /** Caller-computed: is the routine due per its schedule + last run + now? */
  schedule_due: boolean;
  /** The tenant's granted permissions (tenant_day_journal_routines.permission_grants). */
  permission_grants: string[];
  /** Outcome of evaluateBudgetCheck(state, estimate) — omit when the routine uses no LLM. */
  budget?: RoutineBudgetSignal;
  /** PassCooldownState.cooldownTriggered — omit when no cooldown applies. */
  cooldown_triggered?: boolean;
  /** Caller-computed active-hours check — omit when the routine has no active-hours window. */
  within_active_hours?: boolean;
  /** Whether scoped authority has been granted (required only for scoped routines). */
  authority_granted?: boolean;
}

export interface RoutineAdmissionBlock {
  reason: RoutineAdmissionBlockReason;
  detail: string;
}

export interface RoutineAdmission {
  admit: boolean;
  /** The authority this routine requires (informational; needs_scoped_authority gates it). */
  required_authority: RoutineAuthority;
  /** Every reason the routine was held back — never silent. */
  blocked_by: RoutineAdmissionBlock[];
}

/**
 * Decide whether a tenant routine MAY run right now — PURE and deterministic,
 * never touches the DB, never calls an LLM, never mutates its inputs. It composes
 * the already-computed outcomes of the lower gates (the budget check, the cooldown
 * state) with the routine's own opt-in / cadence / permission / authority
 * requirements, and returns every blocking reason (admit = no blocks). The same
 * spec + state always yields the same verdict.
 */
export function evaluateRoutineAdmission(spec: RoutinePluginSpec, state: RoutineAdmissionState): RoutineAdmission {
  const blocked_by: RoutineAdmissionBlock[] = [];
  const required_authority = requiredRoutineAuthority(spec);

  if (!state.enabled) blocked_by.push({ reason: "not_enabled", detail: "routine is not enabled for this tenant" });
  if (!state.schedule_due) blocked_by.push({ reason: "not_due", detail: "not yet due per schedule" });
  if (state.cooldown_triggered === true) {
    blocked_by.push({ reason: "in_cooldown", detail: "suppressed by cooldown (recent runs did no useful work)" });
  }

  // Budget applies iff the routine declares an LLM spend ceiling (>0). The ceiling
  // is the bound actually enforced: there must be a budget check, it must pass, and
  // the tenant's remaining budget must cover a worst-case run up to the ceiling.
  if (spec.budget_ceiling_micro > 0) {
    if (!state.budget) {
      blocked_by.push({ reason: "over_budget", detail: "routine declares an LLM budget ceiling but no budget check was provided" });
    } else if (!state.budget.allowed) {
      blocked_by.push({ reason: "over_budget", detail: `budget check failed: ${state.budget.reason}` });
    } else if (state.budget.remainingMicro < spec.budget_ceiling_micro) {
      blocked_by.push({ reason: "over_budget", detail: `remaining ${state.budget.remainingMicro} micro < routine ceiling ${spec.budget_ceiling_micro} micro` });
    }
  }

  const grants = new Set(state.permission_grants);
  const missing = spec.permissions.filter((p) => !grants.has(p));
  if (missing.length > 0) {
    blocked_by.push({ reason: "missing_permission_grant", detail: `missing grants: ${missing.join(", ")}` });
  }

  if (state.within_active_hours === false) {
    blocked_by.push({ reason: "outside_active_hours", detail: "outside the configured active-hours window" });
  }
  if (required_authority === "scoped" && state.authority_granted !== true) {
    blocked_by.push({ reason: "needs_scoped_authority", detail: "routine requires scoped authority that has not been granted" });
  }

  return { admit: blocked_by.length === 0, required_authority, blocked_by };
}

// ── Mapper: generalize an existing day-journal routine into a plugin spec ──────

/**
 * Normalize an existing DayJournalRoutineDefinition (passed structurally — no
 * coupling to the day-journal module) into a RoutinePluginSpec, supplying the two
 * Tier-2 dimensions the journal definition lacks: a budget ceiling and an explicit
 * safe output target (a journal routine writes day-node facts → "day_node").
 * Proves the contract generalizes the existing structure rather than forking it.
 */
export function fromDayJournalRoutine(
  def: {
    id: string;
    label?: string;
    defaultSchedule: string;
    routineClass: RoutineClass;
    sensitivity: RoutineSensitivity;
    permissions: RoutinePermission[];
    dryRunMode?: RoutineDryRunMode;
    timeoutMs?: number;
  },
  opts: { budgetCeilingMicro?: number; outputTarget?: RoutineOutputTarget } = {},
): RoutinePluginSpec {
  return buildRoutinePlugin({
    id: def.id,
    label: def.label ?? def.id,
    schedule: def.defaultSchedule,
    routine_class: def.routineClass,
    sensitivity: def.sensitivity,
    permissions: [...def.permissions],
    output_target: opts.outputTarget ?? "day_node",
    budget_ceiling_micro: opts.budgetCeilingMicro ?? DEFAULT_ROUTINE_BUDGET_MICRO,
    dry_run_mode: def.dryRunMode ?? "hosted_metadata_ok",
    timeout_ms: def.timeoutMs ?? DEFAULT_ROUTINE_TIMEOUT_MS,
  });
}
