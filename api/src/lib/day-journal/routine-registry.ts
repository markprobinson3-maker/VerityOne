import { canonicalizeJournalRequest, type DayJournalRoutineResult } from "./validate";

export type DayJournalRoutineSensitivity =
  | "standard"
  | "personal"
  | "health"
  | "financial"
  | "calendar"
  | "email";

export type DayJournalRoutineClass = "context_only" | "actionable";

export type DayJournalRoutineDryRunMode = "hosted_metadata_ok" | "local_required";

export type DayJournalRoutinePermission =
  | "journal_write"
  | "network"
  | "local_files"
  | "calendar"
  | "email"
  | "browser"
  | "health"
  | "finance"
  | "llm";

export interface DayJournalRoutineContext {
  tenantId: string;
  spaceId: string;
  routineId: string;
  signal: AbortSignal;
  targetDate: string;
  dayAddr: string;
  targetPath: string;
  targetTimezone: string;
  dryRun: boolean;
  config: Record<string, unknown>;
  permissions: DayJournalRoutinePermission[];
  idempotencyKey?: string;
  runId?: string;
  now: Date;
}

export type DayJournalRoutineDefinition = {
  id: string;
  label: string;
  description: string;
  domain: string;
  sensitivity: "standard" | "personal" | "health" | "financial"
             | "calendar" | "email";
  routineClass: "context_only" | "actionable";
  defaultSchedule: string;
  defaultEnabled: false;
  payloadSizeLimitBytes: number;
  payloadPreviewLimitBytes: number;
  timeoutMs: number;
  dryRunMode: "hosted_metadata_ok" | "local_required";
  permissions: Array<
    | "journal_write" | "network" | "local_files" | "calendar"
    | "email" | "browser" | "health" | "finance" | "llm"
  >;
  configSchema: Record<string, unknown>;
  run: (ctx: DayJournalRoutineContext) => Promise<DayJournalRoutineResult>;
};

export const DAY_JOURNAL_BASE_ROUTINE_PERMISSION: DayJournalRoutinePermission = "journal_write";

export const DAY_JOURNAL_ROUTINE_PERMISSIONS: readonly DayJournalRoutinePermission[] = Object.freeze([
  "journal_write",
  "network",
  "local_files",
  "calendar",
  "email",
  "browser",
  "health",
  "finance",
  "llm",
]);

export const DAY_JOURNAL_SCOPED_AUTHORITY_PERMISSIONS: readonly DayJournalRoutinePermission[] = Object.freeze(
  DAY_JOURNAL_ROUTINE_PERMISSIONS.filter((permission) => permission !== DAY_JOURNAL_BASE_ROUTINE_PERMISSION),
);

export function routineNeedsScopedAuthority(
  def: Pick<DayJournalRoutineDefinition, "dryRunMode" | "sensitivity" | "permissions">,
  action: "dry-run" | "run",
): boolean {
  return (action === "dry-run" && def.dryRunMode === "local_required")
    || def.sensitivity !== "standard"
    || def.permissions.some((permission) => permission !== DAY_JOURNAL_BASE_ROUTINE_PERMISSION);
}

const ROUTINE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SAFE_SEGMENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SCHEDULE_V1_RE = /^(daily|weekday|weekly:(mon|tue|wed|thu|fri|sat|sun))@([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_ROUTINE_PAYLOAD_BYTES = 65536;
const MAX_ROUTINE_PAYLOAD_PREVIEW_BYTES = 4096;
const MAX_TARGET_PATH_CHARS = 256;
const FORBIDDEN_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const PERMISSIONS = new Set<DayJournalRoutinePermission>(DAY_JOURNAL_ROUTINE_PERMISSIONS);
const SENSITIVITIES = new Set<DayJournalRoutineSensitivity>(["standard", "personal", "health", "financial", "calendar", "email"]);
const ROUTINE_CLASSES = new Set<DayJournalRoutineClass>(["context_only", "actionable"]);
const DRY_RUN_MODES = new Set<DayJournalRoutineDryRunMode>(["hosted_metadata_ok", "local_required"]);

const registry = new Map<string, DayJournalRoutineDefinition>();

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty trimmed string without NUL bytes.`);
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function assertSafeTargetSegment(name: string, value: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) throw new TypeError(`${name} must be a safe target-path segment.`);
  if (FORBIDDEN_TARGET_SEGMENTS.has(value)) {
    throw new TypeError(`${name} must not be a forbidden target-path segment.`);
  }
}

function assertRoutineDefinition(def: DayJournalRoutineDefinition): void {
  assertNonEmptyString("id", def.id);
  if (!ROUTINE_ID_RE.test(def.id)) {
    throw new TypeError("routine id must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$/.");
  }
  const idSegments = def.id.split(".");
  if (idSegments.length > 8) {
    throw new TypeError("routine id produces a default target_path with more than 8 child segments.");
  }
  for (const segment of idSegments) {
    assertSafeTargetSegment("routine id segment", segment);
  }
  assertNonEmptyString("label", def.label);
  assertNonEmptyString("description", def.description);
  assertNonEmptyString("domain", def.domain);
  assertSafeTargetSegment("domain", def.domain);
  if (`journal.${def.domain}.${idSegments.slice(1).join(".")}`.length > MAX_TARGET_PATH_CHARS) {
    throw new TypeError("routine id and domain produce a default target_path longer than 256 characters.");
  }
  if (!SENSITIVITIES.has(def.sensitivity)) throw new TypeError("sensitivity must be a registered day-journal sensitivity.");
  if (!ROUTINE_CLASSES.has(def.routineClass)) throw new TypeError("routineClass must be declared.");
  if (!DRY_RUN_MODES.has(def.dryRunMode)) throw new TypeError("dryRunMode must be declared.");
  if (def.defaultEnabled !== false) {
    throw new TypeError("defaultEnabled !== false is forbidden for day-journal routines.");
  }
  if (!SCHEDULE_V1_RE.test(def.defaultSchedule)) {
    throw new TypeError("defaultSchedule must match the v1 schedule grammar.");
  }
  assertPositiveInteger("payloadSizeLimitBytes", def.payloadSizeLimitBytes);
  assertPositiveInteger("payloadPreviewLimitBytes", def.payloadPreviewLimitBytes);
  if (def.payloadSizeLimitBytes > MAX_ROUTINE_PAYLOAD_BYTES) {
    throw new TypeError("payloadSizeLimitBytes must not exceed the v1 journal payload cap.");
  }
  if (def.payloadPreviewLimitBytes > MAX_ROUTINE_PAYLOAD_PREVIEW_BYTES) {
    throw new TypeError("payloadPreviewLimitBytes must not exceed the v1 journal preview cap.");
  }
  if (def.payloadPreviewLimitBytes > def.payloadSizeLimitBytes) {
    throw new TypeError("payloadPreviewLimitBytes must not exceed payloadSizeLimitBytes.");
  }
  assertPositiveInteger("timeoutMs", def.timeoutMs);
  if (!Array.isArray(def.permissions) || def.permissions.length === 0) {
    throw new TypeError("permissions must be a non-empty array.");
  }
  const seenPermissions = new Set<DayJournalRoutinePermission>();
  for (const permission of def.permissions) {
    if (!PERMISSIONS.has(permission)) throw new TypeError(`unknown day-journal routine permission: ${permission}`);
    if (seenPermissions.has(permission)) throw new TypeError(`duplicate day-journal routine permission: ${permission}`);
    seenPermissions.add(permission);
  }
  if (!def.permissions.includes("journal_write")) {
    throw new TypeError("day-journal routines must declare journal_write permission.");
  }
  if (!def.configSchema || typeof def.configSchema !== "object" || Array.isArray(def.configSchema)) {
    throw new TypeError("configSchema must be an object.");
  }
  try {
    canonicalizeJournalRequest(def.configSchema);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`configSchema must be JSON-serializable canonical request material: ${reason}`);
  }
  if (typeof def.run !== "function") throw new TypeError("run must be a function.");
}

export function registerRoutine(def: DayJournalRoutineDefinition): void {
  assertRoutineDefinition(def);
  if (registry.has(def.id)) {
    throw new Error(`day-journal routine already registered: ${def.id}`);
  }
  const configSchema = deepFreeze(JSON.parse(canonicalizeJournalRequest(def.configSchema)) as Record<string, unknown>);
  registry.set(def.id, Object.freeze({
    ...def,
    permissions: Object.freeze([...def.permissions]),
    configSchema,
  }) as DayJournalRoutineDefinition);
}

export function getRoutine(id: string): DayJournalRoutineDefinition | undefined {
  return registry.get(id);
}

export function listRoutines(): DayJournalRoutineDefinition[] {
  return [...registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function defaultTargetPathForRoutine(def: Pick<DayJournalRoutineDefinition, "id" | "domain">): string {
  if (!ROUTINE_ID_RE.test(def.id)) throw new TypeError("routine id must match the day-journal routine id shape.");
  const idSegments = def.id.split(".");
  if (idSegments.length > 8) throw new TypeError("routine id produces a default target_path with more than 8 child segments.");
  for (const segment of idSegments) {
    assertSafeTargetSegment("routine id segment", segment);
  }
  assertSafeTargetSegment("domain", def.domain);
  const suffix = idSegments.slice(1).join(".");
  if (!suffix) throw new TypeError("routine id must include at least one child segment.");
  const targetPath = `journal.${def.domain}.${suffix}`;
  if (targetPath.length > MAX_TARGET_PATH_CHARS) {
    throw new TypeError("routine id and domain produce a default target_path longer than 256 characters.");
  }
  return targetPath;
}
