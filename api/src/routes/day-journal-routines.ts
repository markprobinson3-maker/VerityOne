import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildDayAddr } from "@verity-one/graph-shape";
import { sql as defaultSql } from "../db";
import { getAccessContext } from "../lib/access";
import { auditMutation, type ActorKind } from "../lib/audit";
import { errorJson } from "../lib/error-envelope";
import { enforceWritePermission } from "../lib/tenant-settings-middleware";
import {
  prepareManualJournalEntryCreate,
  prepareManualJournalEntryRetract,
  type ManualEntryError,
} from "../lib/day-journal/manual-entry";
import { validateConfigForRoutine } from "../lib/day-journal/routine-config";
import {
  writeDayJournalEntry as defaultWriteDayJournalEntry,
  type WriteDayJournalEntryErrorCode,
  type WriteDayJournalEntryInput,
  type WriteDayJournalEntryResult,
} from "../lib/day-journal/writer";
import {
  canonicalizeJournalRequest,
  hashJournalRequest,
  validateDayJournalRoutineResult,
  type DayJournalEntrySensitivity,
  type DayJournalRoutineResult,
  type DayJournalRoutineStatus,
} from "../lib/day-journal/validate";
import {
  defaultTargetPathForRoutine,
  getRoutine,
  listRoutines,
  routineNeedsScopedAuthority,
  type DayJournalRoutineContext,
  type DayJournalRoutineDefinition,
  type DayJournalRoutinePermission,
} from "../lib/day-journal/routines";
import { journalGovernance } from "../lib/sync-journal-port";

type SqlTag = any;
const DAY_JOURNAL_REQUEST_MAX_BODY_BYTES = 128 * 1024;
const DAY_JOURNAL_PREVIEW_RESPONSE_MAX_BYTES = 64 * 1024;
const DAY_JOURNAL_TEXT_ECHO_MAX_CHARS = 4096;
const DAY_JOURNAL_DEFAULT_LIMIT = 50;
const DAY_JOURNAL_MAX_LIMIT = 100;
const DAY_JOURNAL_MAX_OFFSET = 10_000;
const DAY_JOURNAL_RUN_DETAIL_ENTRY_LIMIT = 50;
const DAY_JOURNAL_EXPORT_MAX_RANGE_DAYS = 366;
const ROUTINE_RUN_IDEMPOTENCY_NAMESPACE = "manual_routine";
const ROUTINE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const DAY_ADDR_RE = /^TMP\.([0-9]{4})\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEDULE_V1_RE = /^(daily|weekday|weekly:(mon|tue|wed|thu|fri|sat|sun))@([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const JOURNAL_DOMAIN_RE = /^[a-z][a-z0-9_]{0,63}$/;
const JOURNAL_QUERY_CONTROL_RE = /[\u0001-\u001F\u007F-\u009F]/;
const ENABLEMENT_DRY_RUN_SUCCESS_STATUSES = new Set(["ok", "partial"]);
const DAY_JOURNAL_SENSITIVITIES: DayJournalEntrySensitivity[] = [
  "standard",
  "personal",
  "health",
  "financial",
  "calendar",
  "email",
];

function isDayJournalSensitivity(value: string): value is DayJournalEntrySensitivity {
  return DAY_JOURNAL_SENSITIVITIES.includes(value as DayJournalEntrySensitivity);
}

export interface DayJournalRouteDeps {
  sql?: SqlTag;
  writeDayJournalEntry?: (
    sql: SqlTag,
    input: WriteDayJournalEntryInput,
  ) => Promise<WriteDayJournalEntryResult>;
  now?: () => Date;
  defaultTimezoneForTenant?: (tenantId: string) => Promise<string | null>;
}

type RoutineSettingsRow = {
  routine_id?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  config?: unknown;
  permission_grants?: unknown;
  last_dry_run_at?: unknown;
  last_dry_run_status?: unknown;
  last_scheduled_at?: unknown;
  next_run_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type RunRow = {
  id?: unknown;
  tenant_id?: unknown;
  routine_id?: unknown;
  target_path?: unknown;
  target_date?: unknown;
  target_timezone?: unknown;
  day_addr_at_run?: unknown;
  trigger?: unknown;
  run_key?: unknown;
  scheduled_fire_at?: unknown;
  claimed_at?: unknown;
  last_progress_at?: unknown;
  actor?: unknown;
  dry_run?: unknown;
  run_status?: unknown;
  result_status?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  result?: unknown;
  error?: unknown;
};

type EntryRow = {
  id?: unknown;
  entry_key?: unknown;
  day_addr?: unknown;
  target_date?: unknown;
  target_timezone?: unknown;
  routine_id?: unknown;
  target_path?: unknown;
  project_addr?: unknown;
  schema?: unknown;
  sensitivity?: unknown;
  routine_class?: unknown;
  result_status?: unknown;
  entry_state?: unknown;
  captured_at?: unknown;
  tags?: unknown;
  payload_preview?: unknown;
  payload_hash?: unknown;
  source_refs?: unknown;
  latest_run_id?: unknown;
  request_hash?: unknown;
  last_mutation_kind?: unknown;
  updated_at?: unknown;
};

const WRITER_ERROR_MESSAGE: Record<WriteDayJournalEntryErrorCode, string> = {
  entry_was_retracted: "Journal entry was retracted and cannot be recreated by replay.",
  idempotency_conflict: "Idempotency key conflicts with a different journal write.",
  entry_key_collision: "Journal entry key collides with an existing entry.",
  entry_not_found: "Journal entry not found.",
  day_node_missing: "Target day node is missing or inaccessible.",
};

function invalidParams(c: any, message: string, details?: Record<string, unknown>): Response {
  return errorJson(c, "invalid_params", {
    message,
    ...(details ? { details } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("idempotency_key must be a string.");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.includes("\0") || normalized.length > 256) {
    throw new TypeError("idempotency_key must be a bounded non-empty string without NUL bytes.");
  }
  return normalized;
}

function hashIdempotencyKey(tenantId: string, namespace: string, key: string): string {
  return sha256Hex([tenantId.normalize("NFC"), namespace.normalize("NFC"), normalizeIdempotencyKey(key)].join("\x00"));
}

function routineRunIdempotencyNamespace(actor: string): string {
  return `${ROUTINE_RUN_IDEMPOTENCY_NAMESPACE}.actor_${sha256Hex(actor.normalize("NFC"))}`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isJsonObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isJsonObject(value) ? value as Record<string, unknown> : {};
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function timestampIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value);
  return ISO_DATE_RE.test(raw.slice(0, 10)) ? raw.slice(0, 10) : null;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isoDateEpochDay(value: string): number {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function assertExportDateRange(startDate: string, endDate: string): void {
  const days = isoDateEpochDay(endDate) - isoDateEpochDay(startDate) + 1;
  if (days > DAY_JOURNAL_EXPORT_MAX_RANGE_DAYS) {
    throw new TypeError(`date range must be <= ${DAY_JOURNAL_EXPORT_MAX_RANGE_DAYS} days for export.`);
  }
}

function dayAddrForTargetDate(targetDate: string): string {
  if (!isValidIsoDate(targetDate)) throw new TypeError("target_date must be today or a real YYYY-MM-DD date.");
  const [year, month, day] = targetDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  return buildDayAddr(year, Math.floor((date.getTime() - start.getTime()) / 86400000) + 1);
}

function assertDayAddr(value: string): void {
  if (!DAY_ADDR_RE.test(value)) throw new TypeError("day addr must be canonical TMP.YYYY.DDD.");
}

function targetDateFromDayAddr(value: string): string {
  assertDayAddr(value);
  const [, yearRaw, doyRaw] = value.match(DAY_ADDR_RE)!;
  const year = Number(yearRaw);
  const doy = Number(doyRaw);
  const date = new Date(Date.UTC(year, 0, doy));
  const targetDate = date.toISOString().slice(0, 10);
  if (dayAddrForTargetDate(targetDate) !== value) throw new TypeError("day addr must be canonical TMP.YYYY.DDD.");
  return targetDate;
}

function datePartsInTimezone(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const hourRaw = Number(byType.get("hour"));
  if (!Number.isInteger(hourRaw) || hourRaw < 0 || hourRaw > 23) {
    throw new TypeError("timezone formatter produced an invalid hour.");
  }
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    hour: hourRaw,
    minute: Number(byType.get("minute")),
    weekday: String(byType.get("weekday") || "").toLowerCase(),
  };
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = datePartsInTimezone(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function normalizeTimezone(value: unknown, fallback = "UTC"): string {
  let timezone: string;
  if (value === undefined) {
    timezone = fallback;
  } else {
    if (typeof value !== "string") throw new TypeError("timezone must be a bounded IANA timezone string.");
    timezone = value.normalize("NFC").trim();
  }
  if (!timezone || timezone.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(timezone)) {
    throw new TypeError("timezone must be a bounded IANA timezone string.");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  return timezone;
}

function normalizeTenantId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("tenant_id must be a tenant slug.");
  const normalized = value.normalize("NFC").trim();
  if (!TENANT_ID_RE.test(normalized)) throw new TypeError("tenant_id is invalid.");
  return normalized;
}

function normalizeSchedule(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new TypeError("schedule must be a string.");
  return value.normalize("NFC").trim();
}

function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 2; i += 1) {
    const actual = datePartsInTimezone(guess, timeZone);
    const wantedMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60000;
    const actualMinutes = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute) / 60000;
    guess = new Date(guess.getTime() + (wantedMinutes - actualMinutes) * 60000);
  }
  return earliestMatchingLocalMinute(guess, year, month, day, hour, minute, timeZone);
}

function earliestMatchingLocalMinute(
  near: Date,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const start = near.getTime() - 3 * 60 * 60_000;
  const end = near.getTime() + 3 * 60 * 60_000;
  for (let t = start; t <= end; t += 60_000) {
    const candidate = new Date(t);
    const actual = datePartsInTimezone(candidate, timeZone);
    if (
      actual.year === year
      && actual.month === month
      && actual.day === day
      && actual.hour === hour
      && actual.minute === minute
    ) {
      return candidate;
    }
  }
  return null;
}

function computeNextRunAt(schedule: string, timeZone: string, now: Date): Date {
  const match = schedule.match(SCHEDULE_V1_RE);
  if (!match) throw new TypeError("schedule must match daily@HH:MM, weekday@HH:MM, or weekly:<day>@HH:MM.");
  const cadence = match[1];
  const [hour, minute] = schedule.slice(schedule.lastIndexOf("@") + 1).split(":").map((part) => Number(part));
  const nowLocal = datePartsInTimezone(now, timeZone);
  const targetWeekday = cadence.startsWith("weekly:") ? cadence.slice("weekly:".length) : null;
  const weekdayNames: Record<string, string> = {
    mon: "mon",
    tue: "tue",
    wed: "wed",
    thu: "thu",
    fri: "fri",
    sat: "sat",
    sun: "sun",
  };

  for (let offset = 0; offset <= 14; offset += 1) {
    const noon = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + offset, 12));
    const local = datePartsInTimezone(noon, timeZone);
    const weekday = local.weekday.slice(0, 3);
    if (cadence === "weekday" && (weekday === "sat" || weekday === "sun")) continue;
    if (targetWeekday && weekdayNames[targetWeekday] !== weekday) continue;
    const candidate = localDateTimeToUtc(local.year, local.month, local.day, hour, minute, timeZone);
    if (candidate && candidate.getTime() > now.getTime()) return candidate;
  }
  throw new TypeError("schedule did not produce a next run within 14 days.");
}

function parsePositiveIntParam(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new TypeError(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (value > DAY_JOURNAL_MAX_LIMIT) throw new TypeError(`${name} must be <= ${DAY_JOURNAL_MAX_LIMIT}.`);
  return value;
}

function parseOffsetParam(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError("offset must be a non-negative integer.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError("offset must be a safe integer.");
  if (value > DAY_JOURNAL_MAX_OFFSET) throw new TypeError(`offset must be <= ${DAY_JOURNAL_MAX_OFFSET}.`);
  return value;
}

function paginationJson(limit: number, offset: number, visibleTotal: number, returned: number): Record<string, unknown> {
  const nextOffset = offset + returned;
  const hasMore = nextOffset < visibleTotal;
  return {
    limit,
    offset,
    visible_total: visibleTotal,
    returned,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
  };
}

function setPrivateReadHeaders(c: any): void {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Authorization");
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateJournalQueryFilter(q: string | null): void {
  if (q && (q.includes("\0") || q.length > 1000 || JOURNAL_QUERY_CONTROL_RE.test(q))) {
    throw new TypeError("q must be <= 1000 characters without control characters.");
  }
}

function parseRoutineIdFilter(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const normalized = raw.normalize("NFC");
  if (normalized !== normalized.trim() || !ROUTINE_ID_RE.test(normalized)) {
    throw new TypeError("routine_id must be a dotted safe slug.");
  }
  return normalized;
}

function parseJournalDomainFilter(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const normalized = raw.normalize("NFC");
  if (normalized !== normalized.trim() || !JOURNAL_DOMAIN_RE.test(normalized)) {
    throw new TypeError("domain must be a safe journal domain slug.");
  }
  return normalized;
}

function sqlLikeLiteralPattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function journalDomainLikePattern(domain: string | null): string | null {
  return domain ? `journal.${sqlLikeLiteralPattern(domain)}.%` : null;
}

function parseExportFormat(raw: string | undefined): "json" | "markdown" {
  const normalized = (raw || "json").normalize("NFC").trim().toLowerCase();
  if (normalized === "json") return "json";
  if (normalized === "markdown" || normalized === "md") return "markdown";
  throw new TypeError("format must be json or markdown.");
}

function responseTextPreview(value: string): { value: string; truncated: boolean } {
  if (codePointLength(value) <= DAY_JOURNAL_TEXT_ECHO_MAX_CHARS) return { value, truncated: false };
  return { value: Array.from(value).slice(0, DAY_JOURNAL_TEXT_ECHO_MAX_CHARS).join(""), truncated: true };
}

function visibleSensitivitiesForRead(c: any): DayJournalEntrySensitivity[] {
  const access = getAccessContext(c);
  // PR10 class-scoped day_journal:<class>:read grants are not modeled in AccessContext yet.
  // Until they are, non-operator read surfaces fail closed to standard entries only.
  return access.scope === "operator" ? [...DAY_JOURNAL_SENSITIVITIES] : ["standard"];
}

function canonicalConfig(value: Record<string, unknown>): string {
  return canonicalizeJournalRequest(value);
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function assertAllowedBodyFields(body: Record<string, unknown>, allowed: readonly string[], routeName: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(body).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) {
    throw new TypeError(`${routeName} does not accept field: ${extra[0]}`);
  }
}

function routineDefinitionJson(def: DayJournalRoutineDefinition): Record<string, unknown> {
  return {
    id: def.id,
    label: def.label,
    description: def.description,
    domain: def.domain,
    sensitivity: def.sensitivity,
    routine_class: def.routineClass,
    default_schedule: def.defaultSchedule,
    default_enabled: def.defaultEnabled,
    payload_size_limit_bytes: def.payloadSizeLimitBytes,
    payload_preview_limit_bytes: def.payloadPreviewLimitBytes,
    timeout_ms: def.timeoutMs,
    dry_run_mode: def.dryRunMode,
    permissions: [...def.permissions],
    config_schema: def.configSchema,
    target_path: defaultTargetPathForRoutine(def),
  };
}

function settingsJson(
  row: RoutineSettingsRow | undefined,
  def: DayJournalRoutineDefinition,
  fallbackTimezone = "UTC",
): Record<string, unknown> {
  return {
    enabled: Boolean(row?.enabled),
    schedule: typeof row?.schedule === "string" ? row.schedule : def.defaultSchedule,
    timezone: typeof row?.timezone === "string" ? row.timezone : fallbackTimezone,
    config: normalizeJsonObject(row?.config),
    permission_grants: Array.isArray(row?.permission_grants) ? row.permission_grants : [],
    last_dry_run_at: timestampIso(row?.last_dry_run_at),
    last_dry_run_status: row?.last_dry_run_status || null,
    last_scheduled_at: timestampIso(row?.last_scheduled_at),
    next_run_at: timestampIso(row?.next_run_at),
    created_at: timestampIso(row?.created_at),
    updated_at: timestampIso(row?.updated_at),
  };
}

function runRowJson(row: RunRow, opts: { includeAuditFields?: boolean } = {}): Record<string, unknown> {
  return {
    id: String(row.id || ""),
    routine_id: String(row.routine_id || ""),
    target_path: String(row.target_path || ""),
    target_date: dateIso(row.target_date),
    target_timezone: String(row.target_timezone || ""),
    day_addr: String(row.day_addr_at_run || ""),
    trigger: String(row.trigger || ""),
    run_key: String(row.run_key || ""),
    scheduled_fire_at: timestampIso(row.scheduled_fire_at),
    claimed_at: timestampIso(row.claimed_at),
    last_progress_at: timestampIso(row.last_progress_at),
    actor: opts.includeAuditFields ? (row.actor || null) : null,
    dry_run: Boolean(row.dry_run),
    run_status: String(row.run_status || ""),
    result_status: row.result_status || null,
    started_at: timestampIso(row.started_at),
    finished_at: timestampIso(row.finished_at),
    result: opts.includeAuditFields ? normalizeJsonObject(row.result) : {},
    error: opts.includeAuditFields ? (row.error || null) : null,
  };
}

function entryRowJson(row: EntryRow, opts: { includeAuditFields?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entry_key: String(row.entry_key || ""),
    day_addr: String(row.day_addr || ""),
    target_date: dateIso(row.target_date),
    target_timezone: String(row.target_timezone || ""),
    routine_id: String(row.routine_id || ""),
    target_path: String(row.target_path || ""),
    project_addr: row.project_addr || null,
    schema: String(row.schema || ""),
    sensitivity: String(row.sensitivity || ""),
    routine_class: String(row.routine_class || ""),
    result_status: String(row.result_status || ""),
    entry_state: String(row.entry_state || ""),
    captured_at: timestampIso(row.captured_at),
    tags: Array.isArray(row.tags) ? row.tags : [],
    payload_preview: normalizeJsonObject(row.payload_preview),
    source_refs: normalizeJsonArray(row.source_refs),
    latest_run_id: row.latest_run_id || null,
    updated_at: timestampIso(row.updated_at),
  };
  if (opts.includeAuditFields) {
    out.id = row.id || null;
    out.payload_hash = row.payload_hash || null;
    out.request_hash = row.request_hash || null;
    out.last_mutation_kind = row.last_mutation_kind || null;
  }
  return out;
}

function capEntryPreviews(entries: Array<Record<string, unknown>>): {
  entries: Array<Record<string, unknown>>;
  preview_truncated: boolean;
  source_refs_truncated: boolean;
} {
  const encoder = new TextEncoder();
  let used = 0;
  let preview_truncated = false;
  let source_refs_truncated = false;
  const capped = entries.map((entry) => {
    const preview = normalizeJsonObject(entry.payload_preview);
    const previewBytes = encoder.encode(JSON.stringify(preview)).byteLength;
    const sourceRefs = normalizeJsonArray(entry.source_refs);
    const sourceRefsBytes = encoder.encode(JSON.stringify(sourceRefs)).byteLength;
    const next: Record<string, unknown> = { ...entry, payload_preview: preview, source_refs: sourceRefs };
    if (used + previewBytes > DAY_JOURNAL_PREVIEW_RESPONSE_MAX_BYTES) {
      preview_truncated = true;
      next.payload_preview = { truncated: true };
    } else {
      used += previewBytes;
    }
    if (used + sourceRefsBytes > DAY_JOURNAL_PREVIEW_RESPONSE_MAX_BYTES) {
      source_refs_truncated = true;
      next.source_refs = [];
      next.source_refs_truncated = true;
    } else {
      used += sourceRefsBytes;
    }
    return next;
  });
  return { entries: capped, preview_truncated, source_refs_truncated };
}

function markdownText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .trim();
}

function markdownJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2).replace(/```/g, "'''");
}

function journalExportFilename(startDate: string, endDate: string, format: "json" | "markdown"): string {
  return `day-journal-${startDate}_${endDate}.${format === "json" ? "json" : "md"}`;
}

function auditSafeJournalFilters(filters: {
  start_date: string;
  end_date: string;
  routine_id: string | null;
  domain: string | null;
  tag: string | null;
  sensitivity: string | null;
  q: string | null;
}): Record<string, unknown> {
  return {
    start_date: filters.start_date,
    end_date: filters.end_date,
    routine_id: filters.routine_id,
    domain: filters.domain,
    tag: filters.tag,
    sensitivity: filters.sensitivity,
    q: filters.q ? {
      present: true,
      length: filters.q.length,
      sha256: sha256Hex(filters.q),
    } : null,
  };
}

function buildJournalMarkdownExport(input: {
  tenantId: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  visibleTotal: number;
  filters: Record<string, unknown>;
  entries: Array<Record<string, unknown>>;
  previewTruncated: boolean;
  sourceRefsTruncated: boolean;
}): string {
  const lines: string[] = [
    "# Day Journal Export",
    "",
    `- Tenant: ${markdownText(input.tenantId)}`,
    `- Date range: ${input.startDate} to ${input.endDate}`,
    `- Generated: ${input.generatedAt}`,
    `- Visible entries: ${input.visibleTotal}`,
    `- Returned entries: ${input.entries.length}`,
    `- Preview truncated: ${input.previewTruncated ? "yes" : "no"}`,
    `- Source refs truncated: ${input.sourceRefsTruncated ? "yes" : "no"}`,
    "",
    "## Filters",
    "",
    "```json",
    markdownJson(input.filters),
    "```",
    "",
  ];

  if (input.entries.length === 0) {
    lines.push("No visible journal entries matched this export.");
    return `${lines.join("\n")}\n`;
  }

  let currentDate = "";
  for (const entry of input.entries) {
    const targetDate = markdownText(entry.target_date) || "unknown-date";
    if (targetDate !== currentDate) {
      currentDate = targetDate;
      lines.push(`## ${targetDate}`, "");
    }
    const title = [
      markdownText(entry.captured_at) || "unknown-time",
      markdownText(entry.routine_id) || "unknown-routine",
      markdownText(entry.entry_key) || "unknown-entry",
    ].join(" / ");
    lines.push(`### ${title}`, "");
    lines.push(`- Target path: ${markdownText(entry.target_path)}`);
    lines.push(`- Routine class: ${markdownText(entry.routine_class)}`);
    if (entry.routine_class === "context_only") {
      lines.push("- Context policy: context-only; do not treat as an action instruction without corroborating evidence.");
    }
    lines.push(`- Sensitivity: ${markdownText(entry.sensitivity)}`);
    lines.push(`- Entry state: ${markdownText(entry.entry_state)}`);
    lines.push(`- Result status: ${markdownText(entry.result_status)}`);
    lines.push(`- Run: ${markdownText(entry.latest_run_id) || "none"}`);
    const tags = Array.isArray(entry.tags) ? entry.tags.map(markdownText).filter(Boolean).join(", ") : "";
    lines.push(`- Tags: ${tags || "none"}`);
    lines.push("");
    lines.push("Payload preview:");
    lines.push("");
    lines.push("```json");
    lines.push(markdownJson(entry.payload_preview));
    lines.push("```");
    const sourceRefs = Array.isArray(entry.source_refs) ? entry.source_refs : [];
    if (sourceRefs.length > 0) {
      lines.push("");
      lines.push("Source refs:");
      lines.push("");
      lines.push("```json");
      lines.push(markdownJson(sourceRefs));
      lines.push("```");
    } else if (entry.source_refs_truncated === true) {
      lines.push("");
      lines.push("Source refs: truncated by response budget.");
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function validatePermissionGrants(
  def: DayJournalRoutineDefinition,
  value: unknown,
  opts: { requireExplicit?: boolean } = {},
): DayJournalRoutinePermission[] {
  if (value === undefined && opts.requireExplicit) {
    throw new TypeError("permission_grants must explicitly include every routine permission.");
  }
  const grants = value === undefined ? [...def.permissions] : value;
  if (!Array.isArray(grants)) throw new TypeError("permission_grants must be an array.");
  const allowed = new Set(def.permissions);
  const out: DayJournalRoutinePermission[] = [];
  for (const grant of grants) {
    if (typeof grant !== "string" || !allowed.has(grant as DayJournalRoutinePermission)) {
      throw new TypeError(`permission_grants contains permission not declared by routine: ${String(grant)}`);
    }
    if (!out.includes(grant as DayJournalRoutinePermission)) out.push(grant as DayJournalRoutinePermission);
  }
  for (const required of def.permissions) {
    if (!out.includes(required)) throw new TypeError(`permission_grants missing required routine permission: ${required}`);
  }
  return out;
}

function validateRoutineResultOrThrow(input: unknown): DayJournalRoutineResult {
  const validation = validateDayJournalRoutineResult(input);
  if (!validation.ok) throw new TypeError(`routine_result_invalid: ${validation.error}`);
  return validation.result;
}

function dryRunPayloadPreview(result: DayJournalRoutineResult): Record<string, unknown> {
  return dryRunResultSummary(result);
}

function dryRunResultSummary(result: DayJournalRoutineResult): Record<string, unknown> {
  return {
    ok: result.ok,
    routine_id: result.routine_id,
    schema: result.schema,
    target_path: result.target_path,
    captured_at: result.captured_at,
    session_date: result.session_date || null,
    status: result.status,
    ...(result.summary_line ? { summary_line: result.summary_line } : {}),
    ...(result.tags ? { tags: [...result.tags] } : {}),
    ...(result.project_addr ? { project_addr: result.project_addr } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function dryRunWriteSummary(status: DayJournalRoutineStatus): string {
  return status === "ok" || status === "partial"
    ? "tenant_day_journal_entries via writeDayJournalEntry on run"
    : `run history only; no active journal entry for status=${status} on run`;
}

function isPendingImplementationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /^not_implemented_until_pr[0-9]+$/.test(message);
}

function isRoutineResultInvalidError(error: unknown): boolean {
  return error instanceof TypeError && error.message.startsWith("routine_result_invalid:");
}

function assertRoutineResultMatchesInvocation(
  result: DayJournalRoutineResult,
  routine: DayJournalRoutineDefinition,
  targetPath: string,
  targetDate: string,
): void {
  if (result.routine_id !== routine.id) {
    throw new TypeError(`routine_result_mismatch: routine_id ${result.routine_id} did not match ${routine.id}`);
  }
  if (result.target_path !== targetPath) {
    throw new TypeError(`routine_result_mismatch: target_path ${result.target_path} did not match ${targetPath}`);
  }
  if (result.session_date && result.session_date !== targetDate) {
    throw new TypeError(`routine_result_mismatch: session_date ${result.session_date} did not match ${targetDate}`);
  }
}

async function runRoutineWithTimeout(
  routine: DayJournalRoutineDefinition,
  ctx: Omit<DayJournalRoutineContext, "signal">,
): Promise<DayJournalRoutineResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeoutError = new Error(`routine_timeout: ${routine.id} exceeded ${routine.timeoutMs}ms`);
  try {
    return await Promise.race([
      routine.run({ ...ctx, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(timeoutError);
          controller.abort(timeoutError);
        }, routine.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function requestMaterial(input: {
  routineId: string;
  actor: string;
  targetDate: string;
  dayAddr: string;
  targetPath: string;
  targetTimezone: string;
  idempotencyKey?: string;
}): Record<string, unknown> {
  return {
    kind: "routine_run",
    trigger: "manual",
    routine_id: input.routineId,
    actor: input.actor,
    target_date: input.targetDate,
    day_addr: input.dayAddr,
    target_path: input.targetPath,
    target_timezone: input.targetTimezone,
    ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
  };
}

function canonicalRequestHash(tenantId: string, body: Record<string, unknown>): { canonical: string; hash: string } {
  const canonical = canonicalizeJournalRequest(body);
  return { canonical, hash: hashJournalRequest(tenantId, canonical) };
}

type InsertRunConflictCode = "conflict" | "idempotency_conflict";

const STALLED_PENDING_CLAIM_ERROR = "stalled_pending_claim";

function existingRunConflict(existing: {
  id?: unknown;
  run_status?: unknown;
  error?: unknown;
  request_hash?: unknown;
}, requestHash: string): { ok: false; code: InsertRunConflictCode; message: string } {
  if (existing.request_hash && existing.request_hash !== requestHash) {
    return { ok: false, code: "idempotency_conflict", message: "day_journal_routine_run_idempotency_conflict" };
  }
  if (existing.run_status === "pending") {
    return { ok: false, code: "conflict", message: "day_journal_routine_run_already_pending" };
  }
  if (existing.run_status === "running") {
    return { ok: false, code: "conflict", message: "day_journal_routine_run_already_running" };
  }
  return {
    ok: false,
    code: "conflict",
    message: `day_journal_routine_run_already_terminal: ${existing.run_status || "unknown"}`,
  };
}

function isRecoverableStalledPendingRun(existing: {
  id?: unknown;
  run_status?: unknown;
  error?: unknown;
  request_hash?: unknown;
}, requestHash: string): boolean {
  return Boolean(
    existing.id
    && existing.run_status === "failed"
    && existing.error === STALLED_PENDING_CLAIM_ERROR
    && existing.request_hash === requestHash,
  );
}

async function insertRunRow(sql: SqlTag, input: {
  tenantId: string;
  routine: DayJournalRoutineDefinition;
  permissionGrants: DayJournalRoutinePermission[];
  idempotencyNamespace: string;
  targetPath: string;
  targetDate: string;
  dayAddr: string;
  targetTimezone: string;
  runKey: string;
  requestHash: string;
  idempotencyKey: string;
  actor: string;
}): Promise<{ ok: true; id: string } | { ok: false; code: InsertRunConflictCode; message: string }> {
  async function recoverStalledPendingRun(existing: {
    id?: unknown;
    run_status?: unknown;
    error?: unknown;
    request_hash?: unknown;
  }): Promise<{ ok: true; id: string } | null> {
    if (!isRecoverableStalledPendingRun(existing, input.requestHash)) return null;
    const [recovered] = await sql`
      UPDATE tenant_day_journal_routine_runs
      SET run_status = 'pending',
          result_status = NULL,
          result = NULL,
          error = NULL,
          started_at = now(),
          finished_at = NULL,
          claimed_at = NULL,
          last_progress_at = NULL,
          actor = ${input.actor},
          permission_snapshot = ${sql.json({ permissions: input.permissionGrants })}::jsonb
      WHERE id = ${String(existing.id)}::uuid
        AND tenant_id = ${input.tenantId}
        AND routine_id = ${input.routine.id}
        AND run_status = 'failed'
        AND error = ${STALLED_PENDING_CLAIM_ERROR}
        AND request_hash = ${input.requestHash}
      RETURNING id
    `;
    return recovered?.id ? { ok: true, id: String(recovered.id) } : null;
  }

  const idempotencyKeySha256 = hashIdempotencyKey(input.tenantId, input.idempotencyNamespace, input.idempotencyKey);
  const [idempotencyExisting] = await sql`
    SELECT id, run_status, error, request_hash
    FROM tenant_day_journal_routine_runs
    WHERE tenant_id = ${input.tenantId}
      AND idempotency_namespace = ${input.idempotencyNamespace}
      AND idempotency_key_sha256 = ${idempotencyKeySha256}
      AND dry_run = false
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `;
  if (idempotencyExisting?.id) {
    const recovered = await recoverStalledPendingRun(idempotencyExisting);
    if (recovered) return recovered;
    return existingRunConflict(idempotencyExisting, input.requestHash);
  }

  const [row] = await sql`
    INSERT INTO tenant_day_journal_routine_runs (
      tenant_id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
      trigger, run_key, actor, idempotency_namespace, idempotency_key_sha256, request_hash,
      permission_snapshot, dry_run, run_status
    ) VALUES (
      ${input.tenantId}, ${input.routine.id}, ${input.targetPath}, ${input.targetDate}, ${input.targetTimezone}, ${input.dayAddr},
      'manual', ${input.runKey}, ${input.actor}, ${input.idempotencyNamespace}, ${idempotencyKeySha256}, ${input.requestHash},
      ${sql.json({ permissions: input.permissionGrants })}::jsonb, false, 'pending'
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (row?.id) return { ok: true, id: String(row.id) };

  const [idempotencyRace] = await sql`
    SELECT id, run_status, error, request_hash
    FROM tenant_day_journal_routine_runs
    WHERE tenant_id = ${input.tenantId}
      AND idempotency_namespace = ${input.idempotencyNamespace}
      AND idempotency_key_sha256 = ${idempotencyKeySha256}
      AND dry_run = false
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `;
  if (idempotencyRace?.id) {
    const recovered = await recoverStalledPendingRun(idempotencyRace);
    if (recovered) return recovered;
    return existingRunConflict(idempotencyRace, input.requestHash);
  }

  const [existing] = await sql`
    SELECT id, run_status, error, request_hash
    FROM tenant_day_journal_routine_runs
    WHERE tenant_id = ${input.tenantId}
      AND routine_id = ${input.routine.id}
      AND target_date = ${input.targetDate}
      AND target_path = ${input.targetPath}
      AND run_key = ${input.runKey}
      AND dry_run = false
    LIMIT 1
  `;
  if (!existing?.id) throw new Error("failed_to_insert_day_journal_routine_run");
  const recovered = await recoverStalledPendingRun(existing);
  if (recovered) return recovered;
  return existingRunConflict(existing, input.requestHash);
}

async function claimRunRow(sql: SqlTag, tenantId: string, runId: string): Promise<void> {
  const rows = await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'running',
        claimed_at = now(),
        last_progress_at = now()
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status = 'pending'
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error("failed_to_claim_day_journal_routine_run");
}

async function markRunFailed(sql: SqlTag, tenantId: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error || "day_journal_routine_failed");
  await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        result = ${sql.json({ ok: false, error: message.slice(0, 4000) })}::jsonb,
        error = ${message.slice(0, 4000)},
        finished_at = now(),
        last_progress_at = now()
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status IN ('pending', 'running')
  `;
}

async function markRunFailedSafely(sql: SqlTag, tenantId: string, runId: string, error: unknown): Promise<void> {
  try {
    await markRunFailed(sql, tenantId, runId, error);
  } catch (markError) {
    const reason = markError instanceof Error ? markError.message : String(markError || "unknown error");
    console.error("day-journal-routes: failed to mark routine run failed:", reason);
  }
}

function jsonRouteError(c: any, err: ManualEntryError): Response {
  return errorJson(c, err.code, {
    message: err.error,
    ...(err.hint ? { hint: err.hint } : {}),
    ...(err.details ? { details: err.details } : {}),
  });
}

function writerErrorResponse(
  c: any,
  result: Extract<WriteDayJournalEntryResult, { ok: false }>,
  opts: { requestHash?: string; generatedIdempotencyKey?: string } = {},
): Response {
  const details = {
    ...(opts.requestHash ? { request_hash: opts.requestHash } : {}),
    ...(opts.generatedIdempotencyKey ? { generated_idempotency_key: opts.generatedIdempotencyKey } : {}),
  };
  return errorJson(c, result.code, {
    message: WRITER_ERROR_MESSAGE[result.code] || result.code,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(result.hint ? { hint: result.hint } : {}),
  });
}

async function readDefaultTimezone(sql: SqlTag, tenantId: string): Promise<string | null> {
  const [row] = await sql`
    SELECT COALESCE(metadata->'circle'->>'timezone', metadata->>'timezone') AS timezone
    FROM tenants
    WHERE tenant_id = ${tenantId}
  `;
  return typeof row?.timezone === "string" && row.timezone.trim() ? row.timezone : null;
}

function requireJson(c: any): Response | null {
  const mediaType = (c.req.header("content-type") || "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" });
  }
  return null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readJsonObject(c: any): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const declaredContentLength = Number(c.req.header("content-length") || "0");
  if (Number.isFinite(declaredContentLength) && declaredContentLength > DAY_JOURNAL_REQUEST_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: "Day journal request body is too large.",
        details: { max_bytes: DAY_JOURNAL_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Body is not valid JSON" }) };
  }
  if (utf8ByteLength(raw) > DAY_JOURNAL_REQUEST_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: "Day journal request body is too large.",
        details: { max_bytes: DAY_JOURNAL_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }

  let body: unknown;
  try {
    body = raw === "" ? null : JSON.parse(raw);
  } catch {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Body is not valid JSON" }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Body must be a JSON object" }) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

export function createDayJournalRoute(deps: DayJournalRouteDeps = {}) {
  const route = new Hono();
  const sql = deps.sql || defaultSql;
  const writeDayJournalEntry = deps.writeDayJournalEntry || defaultWriteDayJournalEntry;

  async function contextFor(c: any, body?: Record<string, unknown>) {
    const access = getAccessContext(c);
    let requestedTenantId: string | null;
    try {
      const queryTenantId = normalizeTenantId(c.req.query("tenant_id"));
      const bodyTenantId = normalizeTenantId(body?.tenant_id);
      if (queryTenantId && bodyTenantId && queryTenantId !== bodyTenantId) {
        return {
          ok: false as const,
          response: invalidParams(c, "tenant_id query and body values must match."),
        };
      }
      requestedTenantId = bodyTenantId || queryTenantId;
    } catch (error) {
      return {
        ok: false as const,
        response: invalidParams(c, error instanceof Error ? error.message : String(error)),
      };
    }

    const tenantId = access.scope === "operator" ? (requestedTenantId || access.tenantId) : access.tenantId;
    if (access.scope !== "operator" && requestedTenantId && requestedTenantId !== access.tenantId) {
      return {
        ok: false as const,
        response: errorJson(c, "forbidden", { message: "tenant_id does not match authenticated tenant." }),
      };
    }
    if (!tenantId) {
      return { ok: false as const, response: errorJson(c, "tenant_required", { message: "Tenant context required" }) };
    }
    if (!TENANT_ID_RE.test(tenantId)) {
      return { ok: false as const, response: errorJson(c, "tenant_slug_invalid", { message: "Tenant id is invalid." }) };
    }
    const defaultTimezone = deps.defaultTimezoneForTenant
      ? await deps.defaultTimezoneForTenant(tenantId)
      : await readDefaultTimezone(sql, tenantId).catch(() => null);
    return {
      ok: true as const,
      context: {
        tenantId,
        spaceId: `tenant:${tenantId}`,
        actor: access.agentId || (access.scope === "operator" ? "day-journal-operator" : "day-journal-route"),
        defaultTimezone: defaultTimezone || "UTC",
        now: deps.now ? deps.now() : new Date(),
      },
    };
  }

  function requireManagePermission(c: any): Response | null {
    const access = getAccessContext(c);
    if (access.scope === "operator") return null;
    return errorJson(c, "operator_required", {
      message: "day_journal_manage_required",
      hint: "Routine enable, disable, config, schedule, and permission changes require local manage authority.",
    });
  }

  function requireRoutineExecutionPermission(
    c: any,
    routine: DayJournalRoutineDefinition,
    action: "dry-run" | "run",
  ): Response | null {
    const access = getAccessContext(c);
    if (access.scope === "operator") return null;
    if (!routineNeedsScopedAuthority(routine, action)) return null;
    return errorJson(c, "operator_required", {
      message: "day_journal_routine_execution_requires_operator",
      hint:
        "This routine declares sensitivity or external permissions. " +
        "Until day_journal:<class> policy scopes ship, local routine dry-run and run-now require operator authority.",
    });
  }

  function routineOr404(c: any, id: string): DayJournalRoutineDefinition | Response {
    const routine = getRoutine(id);
    if (!routine) {
      return errorJson(c, "not_found", {
        message: "Day journal routine not found.",
        details: { routine_id: id },
      });
    }
    return routine;
  }

  async function routineTarget(
    body: Record<string, unknown>,
    ctx: { defaultTimezone: string; now: Date },
    routine: DayJournalRoutineDefinition,
  ): Promise<{ targetDate: string; dayAddr: string; targetPath: string; targetTimezone: string }> {
    const targetTimezone = normalizeTimezone(body.target_timezone, ctx.defaultTimezone);
    const dayAddr = body.day_addr === undefined ? null : String(body.day_addr);
    if (dayAddr !== null) assertDayAddr(dayAddr);
    const rawTargetDate = body.target_date === undefined
      ? (dayAddr === null ? "today" : targetDateFromDayAddr(dayAddr))
      : body.target_date;
    if (typeof rawTargetDate !== "string") throw new TypeError("target_date must be today or YYYY-MM-DD.");
    const targetDate = rawTargetDate === "today" ? dateInTimezone(ctx.now, targetTimezone) : rawTargetDate;
    if (!isValidIsoDate(targetDate)) throw new TypeError("target_date must be today or a real YYYY-MM-DD date.");
    const resolvedDayAddr = dayAddr === null ? dayAddrForTargetDate(targetDate) : dayAddr;
    if (targetDateFromDayAddr(resolvedDayAddr) !== targetDate) {
      throw new TypeError("day_addr and target_date refer to different days.");
    }
    return {
      targetDate,
      dayAddr: resolvedDayAddr,
      targetPath: defaultTargetPathForRoutine(routine),
      targetTimezone,
    };
  }

  async function updateDryRunMarker(
    tenantId: string,
    routine: DayJournalRoutineDefinition,
    settingsTimezone: string,
    config: Record<string, unknown>,
    permissionGrants: DayJournalRoutinePermission[],
    resultStatus: DayJournalRoutineStatus | "failed" | "rejected",
  ): Promise<void> {
    await sql`
      INSERT INTO tenant_day_journal_routines (
        tenant_id, routine_id, enabled, schedule, timezone, config, permission_grants,
        last_dry_run_at, last_dry_run_status
      ) VALUES (
        ${tenantId}, ${routine.id}, false, ${routine.defaultSchedule}, ${settingsTimezone},
        ${sql.json(config as any)}::jsonb, ${permissionGrants}::text[], now(), ${resultStatus}
      )
      ON CONFLICT (tenant_id, routine_id) DO UPDATE
      SET last_dry_run_at = now(),
          last_dry_run_status = EXCLUDED.last_dry_run_status,
          config = CASE
            WHEN tenant_day_journal_routines.enabled THEN tenant_day_journal_routines.config
            ELSE EXCLUDED.config
          END,
          timezone = CASE
            WHEN tenant_day_journal_routines.enabled THEN tenant_day_journal_routines.timezone
            ELSE EXCLUDED.timezone
          END,
          permission_grants = CASE
            WHEN tenant_day_journal_routines.enabled THEN tenant_day_journal_routines.permission_grants
            ELSE EXCLUDED.permission_grants
          END,
          updated_at = now()
    `;
  }

  async function readRoutineSettings(
    db: SqlTag,
    tenantId: string,
    routine: DayJournalRoutineDefinition,
  ): Promise<RoutineSettingsRow | undefined> {
    const [settings] = await db`
      SELECT enabled, timezone, config, permission_grants
      FROM tenant_day_journal_routines
      WHERE tenant_id = ${tenantId}
        AND routine_id = ${routine.id}
      LIMIT 1
    `;
    return settings;
  }

  async function loadEnabledRoutineSettings(
    db: SqlTag,
    c: any,
    tenantId: string,
    routine: DayJournalRoutineDefinition,
  ): Promise<
    | {
        ok: true;
        config: Record<string, unknown>;
        permissionGrants: DayJournalRoutinePermission[];
        schedule: string;
        timezone: string;
      }
    | { ok: false; response: Response }
  > {
    const [settings] = await db`
      SELECT enabled, schedule, timezone, config, permission_grants
      FROM tenant_day_journal_routines
      WHERE tenant_id = ${tenantId}
        AND routine_id = ${routine.id}
      LIMIT 1
      FOR UPDATE
    `;
    if (!settings?.enabled) {
      return {
        ok: false,
        response: errorJson(c, "conflict", {
          message: "Day journal routine is not enabled for this tenant.",
          hint: "Enable the routine with explicit permission_grants before running it.",
        }),
      };
    }
    try {
      return {
        ok: true,
        schedule: normalizeSchedule(settings.schedule, routine.defaultSchedule),
        timezone: normalizeTimezone(settings.timezone, "UTC"),
        config: validateConfigForRoutine(routine, normalizeJsonObject(settings.config)),
        permissionGrants: validatePermissionGrants(routine, settings.permission_grants, { requireExplicit: true }),
      };
    } catch (error) {
      const reason = errorMessage(error);
      return {
        ok: false,
        response: errorJson(c, "conflict", {
          message: "Enabled day journal routine settings are invalid.",
          details: { reason },
        }),
      };
    }
  }

  route.get("/routines", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    const rows: RoutineSettingsRow[] = await sql`
      SELECT routine_id, enabled, schedule, timezone, config, permission_grants,
             last_dry_run_at, last_dry_run_status, last_scheduled_at, next_run_at, created_at, updated_at
      FROM tenant_day_journal_routines
      WHERE tenant_id = ${ctx.context.tenantId}
    `;
    const settingsById = new Map(rows.map((row: RoutineSettingsRow) => [String(row.routine_id), row]));
    return c.json({
      ok: true,
      authority: "local_authority",
      routines: listRoutines().map((def) => ({
        ...routineDefinitionJson(def),
        settings: settingsJson(settingsById.get(def.id), def, ctx.context.defaultTimezone),
      })),
    });
  });

  route.post("/routines/:id/enable", async (c) => {
    const manageDenied = requireManagePermission(c);
    if (manageDenied) return manageDenied;
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const routine = routineOr404(c, c.req.param("id"));
    if (routine instanceof Response) return routine;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    try {
      assertAllowedBodyFields(
        read.body,
        ["tenant_id", "schedule", "timezone", "config", "permission_grants", "override_dry_run"],
        "routine enable",
      );
      if (read.body.override_dry_run !== undefined && typeof read.body.override_dry_run !== "boolean") {
        throw new TypeError("override_dry_run must be a boolean.");
      }
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    let schedule: string;
    let targetTimezone: string;
    let config: Record<string, unknown>;
    let permissionGrants: DayJournalRoutinePermission[];
    let nextRunAt: Date;
    try {
      schedule = normalizeSchedule(read.body.schedule, routine.defaultSchedule);
      if (!SCHEDULE_V1_RE.test(schedule)) throw new TypeError("schedule must match daily@HH:MM, weekday@HH:MM, or weekly:<day>@HH:MM.");
      targetTimezone = normalizeTimezone(read.body.timezone, ctx.context.defaultTimezone);
      config = validateConfigForRoutine(routine, read.body.config);
      permissionGrants = validatePermissionGrants(routine, read.body.permission_grants, { requireExplicit: true });
      nextRunAt = computeNextRunAt(schedule, targetTimezone, ctx.context.now);
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }

    const [existing] = await sql`
      SELECT enabled, schedule, timezone, config, permission_grants, last_dry_run_at, last_dry_run_status
      FROM tenant_day_journal_routines
      WHERE tenant_id = ${ctx.context.tenantId}
        AND routine_id = ${routine.id}
      LIMIT 1
    `;
    const lastDryRunAt = timestampIso(existing?.last_dry_run_at);
    let dryRunMatchesRequestedSettings = false;
    let existingSettingsMatchRequested = false;
    try {
      const existingSchedule = normalizeSchedule(existing?.schedule, routine.defaultSchedule);
      const existingTimezone = normalizeTimezone(existing?.timezone, ctx.context.defaultTimezone);
      const dryRunConfig = validateConfigForRoutine(routine, normalizeJsonObject(existing?.config));
      const dryRunPermissionGrants = validatePermissionGrants(routine, existing?.permission_grants, { requireExplicit: true });
      dryRunMatchesRequestedSettings = canonicalConfig(dryRunConfig) === canonicalConfig(config)
        && sameStringSet(dryRunPermissionGrants, permissionGrants)
        && existingTimezone === targetTimezone;
      existingSettingsMatchRequested = existingSchedule === schedule && dryRunMatchesRequestedSettings;
    } catch {
      dryRunMatchesRequestedSettings = false;
      existingSettingsMatchRequested = false;
    }
    const hasRecentDryRun = !!lastDryRunAt
      && ENABLEMENT_DRY_RUN_SUCCESS_STATUSES.has(String(existing?.last_dry_run_status || ""))
      && dryRunMatchesRequestedSettings
      && (ctx.context.now.getTime() - new Date(lastDryRunAt).getTime()) <= 24 * 60 * 60 * 1000;
    const overrideDryRun = read.body.override_dry_run === true && getAccessContext(c).scope === "operator";
    if (!hasRecentDryRun && !overrideDryRun) {
      return errorJson(c, "conflict", {
        message: "A successful routine dry-run preview with matching config, permission_grants, and timezone from the last 24 hours is required before enablement.",
        hint: "Call POST /day-journal/routines/:id/dry-run first, or use an operator-only override.",
      });
    }

    const row = await sql.begin(async (tx: SqlTag) => {
      const [updated] = await tx`
        INSERT INTO tenant_day_journal_routines (
          tenant_id, routine_id, enabled, schedule, timezone, config, permission_grants, next_run_at
        ) VALUES (
          ${ctx.context.tenantId}, ${routine.id}, true, ${schedule}, ${targetTimezone}, ${sql.json(config as any)}::jsonb,
          ${permissionGrants}::text[], ${nextRunAt.toISOString()}::timestamptz
        )
        ON CONFLICT (tenant_id, routine_id) DO UPDATE
        SET enabled = true,
            schedule = EXCLUDED.schedule,
            timezone = EXCLUDED.timezone,
            config = EXCLUDED.config,
            permission_grants = EXCLUDED.permission_grants,
            next_run_at = EXCLUDED.next_run_at,
            last_dry_run_at = NULL,
            last_dry_run_status = NULL,
            updated_at = now()
        RETURNING routine_id, enabled, schedule, timezone, config, permission_grants,
                  last_dry_run_at, last_dry_run_status, last_scheduled_at, next_run_at, created_at, updated_at
      `;
      await journalGovernance(tx, `day_journal.routine.${routine.id}`, ctx.context.spaceId);
      return updated;
    });
    return c.json({
      ok: true,
      authority: "local_authority",
      routine: routineDefinitionJson(routine),
      settings: settingsJson(row, routine, ctx.context.defaultTimezone),
      enablement: {
        override_dry_run: overrideDryRun,
        was_enabled: Boolean(existing?.enabled),
        validated_by_dry_run_at: lastDryRunAt,
        validated_by_dry_run_status: existing?.last_dry_run_status || null,
        validated_matching_settings: dryRunMatchesRequestedSettings,
        changed: !Boolean(existing?.enabled) || !existingSettingsMatchRequested,
        next_run_at: timestampIso(row?.next_run_at),
      },
    });
  });

  route.post("/routines/:id/disable", async (c) => {
    const manageDenied = requireManagePermission(c);
    if (manageDenied) return manageDenied;
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const routine = routineOr404(c, c.req.param("id"));
    if (routine instanceof Response) return routine;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    try {
      assertAllowedBodyFields(read.body, ["tenant_id"], "routine disable");
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    const { row, wasEnabled, changed } = await sql.begin(async (tx: SqlTag) => {
      const [before] = await tx`
        SELECT enabled
        FROM tenant_day_journal_routines
        WHERE tenant_id = ${ctx.context.tenantId}
          AND routine_id = ${routine.id}
        LIMIT 1
        FOR UPDATE
      `;
      if (!before) {
        return { row: undefined, wasEnabled: false, changed: false };
      }
      const [updated] = await tx`
        UPDATE tenant_day_journal_routines
        SET enabled = false,
            next_run_at = NULL,
            last_dry_run_at = NULL,
            last_dry_run_status = NULL,
            updated_at = now()
        WHERE tenant_id = ${ctx.context.tenantId}
          AND routine_id = ${routine.id}
        RETURNING routine_id, enabled, schedule, timezone, config, permission_grants,
                  last_dry_run_at, last_dry_run_status, last_scheduled_at, next_run_at, created_at, updated_at
      `;
      await journalGovernance(tx, `day_journal.routine.${routine.id}`, ctx.context.spaceId);
      return { row: updated, wasEnabled: Boolean(before.enabled), changed: Boolean(before.enabled) };
    });
    return c.json({
      ok: true,
      authority: "local_authority",
      routine: routineDefinitionJson(routine),
      settings: settingsJson(row, routine, ctx.context.defaultTimezone),
      disablement: {
        was_enabled: wasEnabled,
        changed,
      },
    });
  });

  route.post("/entries/dry-run", async (c) => {
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    const prepared = prepareManualJournalEntryCreate(read.body, ctx.context, { dryRun: true });
    if (!prepared.ok) return jsonRouteError(c, prepared);
    const commandText = responseTextPreview(prepared.command_text);
    const body = responseTextPreview(prepared.body);
    return c.json({
      ok: true,
      dry_run: true,
      authority: "local_authority",
      command_text: commandText.value,
      command_text_truncated: commandText.truncated,
      body: body.value,
      body_truncated: body.truncated,
      target_date: prepared.target_date,
      day_addr: prepared.day_addr,
      target_timezone: prepared.target_timezone,
      sensitivity: prepared.sensitivity,
      tags: prepared.tags,
      entry_key: prepared.entry_key,
      target_path: prepared.target_path,
      request_hash: prepared.request_hash,
      requires_idempotency_key: prepared.entry_key === null,
    });
  });

  // No-write agents see 403 before command parsing; authorized callers get reserved_command refusals.
  route.post("/entries", enforceWritePermission(sql), async (c) => {
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    const prepared = prepareManualJournalEntryCreate(read.body, ctx.context);
    if (!prepared.ok) return jsonRouteError(c, prepared);
    const result = await writeDayJournalEntry(sql, prepared.writer_input!) as
      | {
          ok: true;
          day_addr: string;
          entry_key: string | null;
          target_path: string;
          entry_state: "active" | "retracted" | "redacted" | "none";
          routine_id?: string;
          sensitivity?: DayJournalEntrySensitivity;
          tags?: string[];
        }
      | { ok: false; code: WriteDayJournalEntryErrorCode; hint?: string };
    if (!result.ok) return writerErrorResponse(c, result, { requestHash: prepared.request_hash });
    return c.json({
      ok: true,
      authority: "local_authority",
      routine_id: result.routine_id || "manual.tenant_entry",
      day_addr: result.day_addr,
      entry_key: result.entry_key,
      target_path: result.target_path,
      entry_state: result.entry_state,
      target_date: prepared.target_date,
      target_timezone: prepared.target_timezone,
      sensitivity: result.sensitivity || prepared.sensitivity,
      tags: result.tags || prepared.tags,
      request_hash: prepared.request_hash,
    });
  });

  route.post("/entries/:entry_key/retract", enforceWritePermission(sql), async (c) => {
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    try {
      assertAllowedBodyFields(read.body, ["tenant_id", "idempotency_key", "reason"], "manual entry retract");
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const prepared = prepareManualJournalEntryRetract({
      ...read.body,
      entry_key: c.req.param("entry_key"),
    }, ctx.context);
    if (!prepared.ok) return jsonRouteError(c, prepared);
    const result = await writeDayJournalEntry(sql, prepared.writer_input);
    if (!result.ok) {
      if (result.code === "entry_was_retracted") {
        const [existing] = await sql`
          SELECT day_addr, target_path, entry_state
          FROM tenant_day_journal_entries
          WHERE tenant_id = ${ctx.context.tenantId}
            AND entry_key = ${prepared.entry_key}
            AND entry_state IN ('retracted', 'redacted')
          LIMIT 1
        `;
        if (existing) {
          // The response reflects the existing terminal state; an operator-redacted entry stays redacted even when the caller requested retract.
          return c.json({
            ok: true,
            authority: "local_authority",
            day_addr: String(existing.day_addr),
            entry_key: prepared.entry_key,
            target_path: String(existing.target_path),
            entry_state: existing.entry_state === "redacted" ? "redacted" : "retracted",
            request_hash: prepared.request_hash,
          });
        }
      }
      return writerErrorResponse(c, result, { requestHash: prepared.request_hash });
    }
    return c.json({
      ok: true,
      authority: "local_authority",
      day_addr: result.day_addr,
      entry_key: result.entry_key,
      target_path: result.target_path,
      entry_state: result.entry_state,
      request_hash: prepared.request_hash,
    });
  });

  route.post("/routines/:id/dry-run", enforceWritePermission(sql), async (c) => {
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const routine = routineOr404(c, c.req.param("id") || "");
    if (routine instanceof Response) return routine;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    let target: { targetDate: string; dayAddr: string; targetPath: string; targetTimezone: string };
    let config: Record<string, unknown>;
    let permissionGrants: DayJournalRoutinePermission[];
    let settingsTimezone: string;
    let markerTimezone: string;
    try {
      assertAllowedBodyFields(
        read.body,
        ["tenant_id", "target_date", "day_addr", "target_timezone", "config", "permission_grants"],
        "routine dry-run",
      );
      const executionDenied = requireRoutineExecutionPermission(c, routine, "dry-run");
      if (executionDenied) return executionDenied;
      if (
        read.body.config !== undefined
        || read.body.permission_grants !== undefined
        || read.body.target_timezone !== undefined
      ) {
        const settingsOverrideDenied = requireManagePermission(c);
        if (settingsOverrideDenied) return settingsOverrideDenied;
      }
      const settings = await readRoutineSettings(sql, ctx.context.tenantId, routine);
      settingsTimezone = normalizeTimezone(settings?.timezone, ctx.context.defaultTimezone);
      target = await routineTarget(read.body, { ...ctx.context, defaultTimezone: settingsTimezone }, routine);
      markerTimezone = read.body.target_timezone !== undefined && !settings?.enabled ? target.targetTimezone : settingsTimezone;
      config = validateConfigForRoutine(
        routine,
        read.body.config === undefined ? normalizeJsonObject(settings?.config) : read.body.config,
      );
      permissionGrants = validatePermissionGrants(
        routine,
        read.body.permission_grants === undefined ? settings?.permission_grants : read.body.permission_grants,
        { requireExplicit: true },
      );
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }

    try {
      const result = validateRoutineResultOrThrow(await runRoutineWithTimeout(routine, {
        tenantId: ctx.context.tenantId,
        spaceId: ctx.context.spaceId,
        routineId: routine.id,
        targetDate: target.targetDate,
        dayAddr: target.dayAddr,
        targetPath: target.targetPath,
        targetTimezone: target.targetTimezone,
        dryRun: true,
        config,
        permissions: [...permissionGrants],
        now: ctx.context.now,
      }));
      assertRoutineResultMatchesInvocation(result, routine, target.targetPath, target.targetDate);
      const targetTimezoneMatchesSettings = target.targetTimezone === markerTimezone;
      const markerStatus = targetTimezoneMatchesSettings ? result.status : "rejected";
      await updateDryRunMarker(ctx.context.tenantId, routine, markerTimezone, config, permissionGrants, markerStatus);
      return c.json({
        ok: true,
        dry_run: true,
        authority: "local_authority",
        routine: routineDefinitionJson(routine),
        target_date: target.targetDate,
        day_addr: target.dayAddr,
        target_path: target.targetPath,
        target_timezone: target.targetTimezone,
        status: result.status,
        payload_preview: dryRunPayloadPreview(result),
        would_write: dryRunWriteSummary(result.status),
        dry_run_marker: {
          updated: true,
          enable_window_started: ENABLEMENT_DRY_RUN_SUCCESS_STATUSES.has(result.status) && targetTimezoneMatchesSettings,
          settings_timezone: markerTimezone,
          target_timezone_matches_settings: targetTimezoneMatchesSettings,
        },
        result: dryRunResultSummary(result),
      });
    } catch (error) {
      await updateDryRunMarker(ctx.context.tenantId, routine, markerTimezone, config, permissionGrants, "failed").catch(() => {});
      if (isPendingImplementationError(error)) {
        return errorJson(c, "not_implemented", {
          message: "Day journal routine implementation is pending.",
          details: { routine_id: routine.id },
        });
      }
      if (isRoutineResultInvalidError(error)) {
        return errorJson(c, "validation_failed", {
          message: "Day journal routine returned an invalid result.",
          details: { reason: errorMessage(error) },
        });
      }
      return errorJson(c, "bad_gateway", {
        message: "Day journal routine dry-run failed.",
      });
    }
  });

  route.post("/routines/:id/run", enforceWritePermission(sql), async (c) => {
    const unsupported = requireJson(c);
    if (unsupported) return unsupported;
    const routine = routineOr404(c, c.req.param("id") || "");
    if (routine instanceof Response) return routine;
    const read = await readJsonObject(c);
    if (!read.ok) return read.response;
    const ctx = await contextFor(c, read.body);
    if (!ctx.ok) return ctx.response;
    const executionDenied = requireRoutineExecutionPermission(c, routine, "run");
    if (executionDenied) return executionDenied;
    let idempotencyKey: string;
    try {
      assertAllowedBodyFields(
        read.body,
        [
          "tenant_id",
          "target_date",
          "day_addr",
          "target_timezone",
          "config",
          "permission_grants",
          "idempotency_key",
          "generate_idempotency_key",
        ],
        "routine run",
      );
      if (read.body.generate_idempotency_key !== undefined && typeof read.body.generate_idempotency_key !== "boolean") {
        throw new TypeError("generate_idempotency_key must be a boolean.");
      }
      if (read.body.generate_idempotency_key === true && read.body.idempotency_key !== undefined) {
        throw new TypeError("Use idempotency_key or generate_idempotency_key, not both.");
      }
      if (read.body.config !== undefined) {
        throw new TypeError("config overrides are dry-run-only; update routine settings before running.");
      }
      if (read.body.permission_grants !== undefined) {
        throw new TypeError("permission_grants overrides are dry-run-only; update routine settings before running.");
      }
      if (read.body.target_timezone !== undefined) {
        throw new TypeError("target_timezone overrides are dry-run-only; update routine settings before running.");
      }
      idempotencyKey = read.body.generate_idempotency_key === true
        ? normalizeIdempotencyKey(`routine_${randomUUID()}`)
        : normalizeIdempotencyKey(read.body.idempotency_key);
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const generatedIdempotencyKey = read.body.generate_idempotency_key === true ? idempotencyKey : undefined;
    const idempotencyNamespace = routineRunIdempotencyNamespace(ctx.context.actor);

    const prepared = await sql.begin(async (tx: SqlTag) => {
      const settings = await loadEnabledRoutineSettings(tx, c, ctx.context.tenantId, routine);
      if (!settings.ok) return { ok: false as const, response: settings.response };
      let resolvedTarget: { targetDate: string; dayAddr: string; targetPath: string; targetTimezone: string };
      try {
        resolvedTarget = await routineTarget(read.body, { ...ctx.context, defaultTimezone: settings.timezone }, routine);
      } catch (error) {
        return {
          ok: false as const,
          response: invalidParams(c, error instanceof Error ? error.message : String(error)),
        };
      }
      const request = requestMaterial({
        routineId: routine.id,
        actor: ctx.context.actor,
        targetDate: resolvedTarget.targetDate,
        dayAddr: resolvedTarget.dayAddr,
        targetPath: resolvedTarget.targetPath,
        targetTimezone: resolvedTarget.targetTimezone,
        idempotencyKey,
      });
      const hashed = canonicalRequestHash(ctx.context.tenantId, request);
      const runKey = `routine_run_${hashed.hash.slice(0, 32)}`;
      const inserted = await insertRunRow(tx, {
        tenantId: ctx.context.tenantId,
        routine,
        permissionGrants: settings.permissionGrants,
        idempotencyNamespace,
        targetPath: resolvedTarget.targetPath,
        targetDate: resolvedTarget.targetDate,
        dayAddr: resolvedTarget.dayAddr,
        targetTimezone: resolvedTarget.targetTimezone,
        runKey,
        requestHash: hashed.hash,
        idempotencyKey,
        actor: ctx.context.actor,
      });
      if (!inserted.ok) {
        return {
          ok: false as const,
          response: errorJson(c, inserted.code, {
            details: {
              reason: inserted.message,
              run_key: runKey,
              request_hash: hashed.hash,
              ...(generatedIdempotencyKey ? { generated_idempotency_key: generatedIdempotencyKey } : {}),
            },
          }),
        };
      }
      return {
        ok: true as const,
        target: resolvedTarget,
        config: settings.config,
        permissionGrants: settings.permissionGrants,
        canonical: hashed.canonical,
        hash: hashed.hash,
        runId: inserted.id,
      };
    });
    if (!prepared.ok) return prepared.response;
    const { target, config, permissionGrants, canonical, hash, runId } = prepared;

    let result: DayJournalRoutineResult;
    try {
      await claimRunRow(sql, ctx.context.tenantId, runId);
      result = validateRoutineResultOrThrow(await runRoutineWithTimeout(routine, {
        tenantId: ctx.context.tenantId,
        spaceId: ctx.context.spaceId,
        routineId: routine.id,
        targetDate: target.targetDate,
        dayAddr: target.dayAddr,
        targetPath: target.targetPath,
        targetTimezone: target.targetTimezone,
        dryRun: false,
        config,
        permissions: [...permissionGrants],
        idempotencyKey,
        runId,
        now: ctx.context.now,
      }));
      assertRoutineResultMatchesInvocation(result, routine, target.targetPath, target.targetDate);
    } catch (error) {
      await markRunFailedSafely(sql, ctx.context.tenantId, runId, error);
      if (isPendingImplementationError(error)) {
        return errorJson(c, "not_implemented", {
          message: "Day journal routine implementation is pending.",
          details: {
            run_id: runId,
            routine_id: routine.id,
            ...(generatedIdempotencyKey ? { generated_idempotency_key: generatedIdempotencyKey } : {}),
          },
        });
      }
      if (isRoutineResultInvalidError(error)) {
        return errorJson(c, "validation_failed", {
          message: "Day journal routine returned an invalid result.",
          details: {
            run_id: runId,
            reason: errorMessage(error),
            ...(generatedIdempotencyKey ? { generated_idempotency_key: generatedIdempotencyKey } : {}),
          },
        });
      }
      return errorJson(c, "bad_gateway", {
        message: "Day journal routine run failed.",
        details: {
          run_id: runId,
          ...(generatedIdempotencyKey ? { generated_idempotency_key: generatedIdempotencyKey } : {}),
        },
      });
    }

    let writeResult: Awaited<ReturnType<typeof writeDayJournalEntry>>;
    try {
      writeResult = await writeDayJournalEntry(sql, {
        tenantId: ctx.context.tenantId,
        spaceId: ctx.context.spaceId,
        targetDate: target.targetDate,
        dayAddr: target.dayAddr,
        targetTimezone: target.targetTimezone,
        result,
        actor: ctx.context.actor,
        runId,
        idempotencyKey,
        idempotencyNamespace,
        requestHash: hash,
        requestCanonicalJson: canonical,
        requestKind: "routine_run",
        sensitivity: routine.sensitivity,
        routineClass: routine.routineClass,
        mutationKind: "routine_run",
      });
    } catch (error) {
      await markRunFailedSafely(sql, ctx.context.tenantId, runId, error);
      return errorJson(c, "bad_gateway", {
        message: "Day journal routine write failed.",
        details: {
          run_id: runId,
          ...(generatedIdempotencyKey ? { generated_idempotency_key: generatedIdempotencyKey } : {}),
        },
      });
    }
    if (!writeResult.ok) {
      const message = `routine write failed: ${writeResult.code}${writeResult.hint ? `: ${writeResult.hint}` : ""}`;
      await markRunFailedSafely(sql, ctx.context.tenantId, runId, new Error(message));
      return writerErrorResponse(c, writeResult, { requestHash: hash, generatedIdempotencyKey });
    }

    return c.json({
      ok: true,
      authority: "local_authority",
      routine_id: routine.id,
      run_id: runId,
      request_hash: hash,
      ...(read.body.generate_idempotency_key === true ? { generated_idempotency_key: idempotencyKey } : {}),
      day_addr: writeResult.day_addr,
      target_path: writeResult.target_path,
      entry_key: writeResult.entry_key,
      entry_state: writeResult.entry_state,
      ...(writeResult.entry_key === null ? { entry_status: writeResult.result_status } : {}),
    });
  });

  route.get("/runs", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    const includeRunAudit = requireManagePermission(c) === null;
    let limit: number;
    let offset: number;
    try {
      limit = parsePositiveIntParam(c.req.query("limit"), DAY_JOURNAL_DEFAULT_LIMIT, "limit");
      offset = parseOffsetParam(c.req.query("offset"));
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    let routineId: string | null;
    const targetDate = c.req.query("target_date") || null;
    try {
      routineId = parseRoutineIdFilter(c.req.query("routine_id"));
      if (targetDate && !isValidIsoDate(targetDate)) throw new TypeError("target_date must be a real YYYY-MM-DD date.");
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const [countRow] = await sql`
      SELECT count(*)::bigint AS total
      FROM tenant_day_journal_routine_runs
      WHERE tenant_id = ${ctx.context.tenantId}
        AND dry_run = false
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${targetDate}::date IS NULL OR target_date = ${targetDate}::date)
    `;
    const rows = await sql`
      SELECT id, tenant_id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
             trigger, run_key, scheduled_fire_at, claimed_at, last_progress_at, actor, dry_run,
             run_status, result_status, started_at, finished_at, result, error
      FROM tenant_day_journal_routine_runs
      WHERE tenant_id = ${ctx.context.tenantId}
        AND dry_run = false
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${targetDate}::date IS NULL OR target_date = ${targetDate}::date)
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    const visibleTotal = Number(countRow?.total || 0);
    setPrivateReadHeaders(c);
    return c.json({
      ok: true,
      authority: "local_authority",
      visible_total: visibleTotal,
      pagination: paginationJson(limit, offset, visibleTotal, rows.length),
      runs: rows.map((row: RunRow) => runRowJson(row, { includeAuditFields: includeRunAudit })),
    });
  });

  route.get("/runs/:id", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    const runId = c.req.param("id");
    if (!UUID_RE.test(runId)) return invalidParams(c, "run id must be a UUID.");
    let entriesLimit: number;
    let entriesOffset: number;
    try {
      entriesLimit = parsePositiveIntParam(c.req.query("entries_limit"), DAY_JOURNAL_RUN_DETAIL_ENTRY_LIMIT, "entries_limit");
      entriesOffset = parseOffsetParam(c.req.query("entries_offset"));
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const [run] = await sql`
      SELECT id, tenant_id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
             trigger, run_key, scheduled_fire_at, claimed_at, last_progress_at, actor, dry_run,
             run_status, result_status, started_at, finished_at, result, error
      FROM tenant_day_journal_routine_runs
      WHERE tenant_id = ${ctx.context.tenantId}
        AND id = ${runId}::uuid
        AND dry_run = false
      LIMIT 1
    `;
    if (!run) return errorJson(c, "not_found", { message: "Day journal routine run not found." });
    const includeAuditEntries = requireManagePermission(c) === null;
    const visibleSensitivities = visibleSensitivitiesForRead(c);
    const entries = await sql`
      SELECT id, entry_key, day_addr, target_date, target_timezone, routine_id, target_path, project_addr,
             schema, sensitivity, routine_class, result_status, entry_state, captured_at, tags,
             payload_preview, payload_hash, source_refs, latest_run_id, request_hash, last_mutation_kind, updated_at
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND latest_run_id = ${runId}::uuid
        AND (${includeAuditEntries}::boolean OR entry_state = 'active')
        AND sensitivity = ANY(${visibleSensitivities}::text[])
      ORDER BY captured_at DESC, entry_key DESC
      LIMIT ${entriesLimit}
      OFFSET ${entriesOffset}
    `;
    const capped = capEntryPreviews(entries.map((row: EntryRow) => entryRowJson(row, { includeAuditFields: includeAuditEntries })));
    setPrivateReadHeaders(c);
    return c.json({
      ok: true,
      authority: "local_authority",
      run: runRowJson(run, { includeAuditFields: includeAuditEntries }),
      entry_pagination: { limit: entriesLimit, offset: entriesOffset, returned: entries.length },
      entries: capped.entries,
      preview_truncated: capped.preview_truncated,
      source_refs_truncated: capped.source_refs_truncated,
    });
  });

  route.get("/day/:addr", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    const addr = c.req.param("addr");
    let targetDate: string;
    try {
      targetDate = targetDateFromDayAddr(addr);
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const [day] = await sql`
      SELECT addr, substance->'journal' AS journal
      FROM nodes
      WHERE addr = ${addr}
        AND space_id = ${ctx.context.spaceId}
        AND node_type = 'day'
        AND visibility <> 'deleted'
      LIMIT 1
    `;
    if (!day) return errorJson(c, "not_found", { message: "Day journal not found." });
    const visibleSensitivities = visibleSensitivitiesForRead(c);
    const includeJournalSubstance = requireManagePermission(c) === null;
    const entries = await sql`
      SELECT entry_key, day_addr, target_date, target_timezone, routine_id, target_path, project_addr,
             schema, sensitivity, routine_class, result_status, entry_state, captured_at, tags,
             payload_preview, source_refs, latest_run_id, updated_at
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND day_addr = ${addr}
        AND entry_state = 'active'
        AND sensitivity = ANY(${visibleSensitivities}::text[])
      ORDER BY captured_at DESC, entry_key DESC
    `;
    const capped = capEntryPreviews(entries.map((row: EntryRow) => entryRowJson(row)));
    setPrivateReadHeaders(c);
    return c.json({
      ok: true,
      authority: "local_authority",
      day_addr: addr,
      target_date: targetDate,
      journal: includeJournalSubstance ? normalizeJsonObject(day.journal) : {},
      journal_redacted: !includeJournalSubstance,
      entries: capped.entries,
      preview_truncated: capped.preview_truncated,
      source_refs_truncated: capped.source_refs_truncated,
    });
  });

  route.get("/export", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    let limit: number;
    let offset: number;
    let format: "json" | "markdown";
    try {
      limit = parsePositiveIntParam(c.req.query("limit"), DAY_JOURNAL_DEFAULT_LIMIT, "limit");
      offset = parseOffsetParam(c.req.query("offset"));
      format = parseExportFormat(c.req.query("format"));
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }

    const startDate = c.req.query("start_date") || null;
    const endDate = c.req.query("end_date") || null;
    let routineId: string | null;
    let domain: string | null;
    const tag = c.req.query("tag") || null;
    const sensitivity = c.req.query("sensitivity") || null;
    const q = c.req.query("q") || null;
    try {
      if (!startDate || !endDate) throw new TypeError("start_date and end_date are required for export.");
      if (!isValidIsoDate(startDate)) throw new TypeError("start_date must be a real YYYY-MM-DD date.");
      if (!isValidIsoDate(endDate)) throw new TypeError("end_date must be a real YYYY-MM-DD date.");
      if (startDate > endDate) throw new TypeError("start_date must be <= end_date.");
      assertExportDateRange(startDate, endDate);
      routineId = parseRoutineIdFilter(c.req.query("routine_id"));
      domain = parseJournalDomainFilter(c.req.query("domain"));
      if (tag && !/^[a-z0-9_-]{1,64}$/.test(tag)) throw new TypeError("tag must be a safe journal tag.");
      if (sensitivity && !isDayJournalSensitivity(sensitivity)) {
        throw new TypeError("sensitivity is not a day-journal sensitivity.");
      }
      validateJournalQueryFilter(q);
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }

    const qPattern = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const domainPattern = journalDomainLikePattern(domain);
    const visibleSensitivities = visibleSensitivitiesForRead(c);
    const includeAuditFields = requireManagePermission(c) === null;

    const [countRow] = await sql`
      SELECT count(*)::bigint AS total
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND entry_state = 'active'
        AND target_date >= ${startDate}::date
        AND target_date <= ${endDate}::date
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${domainPattern}::text IS NULL OR target_path LIKE ${domainPattern} ESCAPE '\\')
        AND (${tag}::text IS NULL OR tags @> ARRAY[${tag}]::text[])
        AND (${sensitivity}::text IS NULL OR sensitivity = ${sensitivity})
        AND sensitivity = ANY(${visibleSensitivities}::text[])
        AND (${qPattern}::text IS NULL OR payload_preview::text ILIKE ${qPattern} ESCAPE '\\')
    `;
    const rows = await sql`
      SELECT id, entry_key, day_addr, target_date, target_timezone, routine_id, target_path, project_addr,
             schema, sensitivity, routine_class, result_status, entry_state, captured_at, tags,
             payload_preview, payload_hash, source_refs, latest_run_id, request_hash, last_mutation_kind, updated_at
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND entry_state = 'active'
        AND target_date >= ${startDate}::date
        AND target_date <= ${endDate}::date
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${domainPattern}::text IS NULL OR target_path LIKE ${domainPattern} ESCAPE '\\')
        AND (${tag}::text IS NULL OR tags @> ARRAY[${tag}]::text[])
        AND (${sensitivity}::text IS NULL OR sensitivity = ${sensitivity})
        AND sensitivity = ANY(${visibleSensitivities}::text[])
        AND (${qPattern}::text IS NULL OR payload_preview::text ILIKE ${qPattern} ESCAPE '\\')
      ORDER BY target_date ASC, captured_at ASC, entry_key ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    const capped = capEntryPreviews(rows.map((row: EntryRow) => entryRowJson(row, { includeAuditFields })));
    const visibleTotal = Number(countRow?.total || 0);
    const filters = { start_date: startDate, end_date: endDate, routine_id: routineId, domain, tag, sensitivity, q };
    const body = {
      ok: true,
      authority: "local_authority",
      export_format: format,
      generated_at: ctx.context.now.toISOString(),
      visible_total: visibleTotal,
      pagination: paginationJson(limit, offset, visibleTotal, capped.entries.length),
      filters,
      entries: capped.entries,
      preview_truncated: capped.preview_truncated,
      source_refs_truncated: capped.source_refs_truncated,
      context_only_notice: "context_only entries are historical context, not action instructions without additional evidence.",
    };
    const access = getAccessContext(c);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: ctx.context.tenantId,
      actor: ctx.context.actor,
      actorKind: (access.scope === "operator" ? "operator_token" : "tenant_session") as ActorKind,
      operation: "day_journal_export",
      eventData: {
        start_date: startDate,
        end_date: endDate,
        filters: auditSafeJournalFilters(filters),
        format,
        visible_total: visibleTotal,
        returned: capped.entries.length,
        preview_truncated: capped.preview_truncated,
        source_refs_truncated: capped.source_refs_truncated,
        includes_audit_fields: includeAuditFields,
      },
    }, { durability: "required" });

    const filename = journalExportFilename(startDate, endDate, format);
    if (format === "markdown") {
      return new Response(buildJournalMarkdownExport({
        tenantId: ctx.context.tenantId,
        startDate,
        endDate,
        generatedAt: body.generated_at,
        visibleTotal,
        filters,
        entries: capped.entries,
        previewTruncated: capped.preview_truncated,
        sourceRefsTruncated: capped.source_refs_truncated,
      }), {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "Vary": "Authorization",
        },
      });
    }

    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    setPrivateReadHeaders(c);
    return c.json(body);
  });

  route.get("/search", async (c) => {
    const ctx = await contextFor(c);
    if (!ctx.ok) return ctx.response;
    let limit: number;
    let offset: number;
    try {
      limit = parsePositiveIntParam(c.req.query("limit"), DAY_JOURNAL_DEFAULT_LIMIT, "limit");
      offset = parseOffsetParam(c.req.query("offset"));
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }

    const startDate = c.req.query("start_date") || null;
    const endDate = c.req.query("end_date") || null;
    let routineId: string | null;
    let domain: string | null;
    const tag = c.req.query("tag") || null;
    const sensitivity = c.req.query("sensitivity") || null;
    const q = c.req.query("q") || null;
    try {
      routineId = parseRoutineIdFilter(c.req.query("routine_id"));
      domain = parseJournalDomainFilter(c.req.query("domain"));
      if (startDate && !isValidIsoDate(startDate)) throw new TypeError("start_date must be a real YYYY-MM-DD date.");
      if (endDate && !isValidIsoDate(endDate)) throw new TypeError("end_date must be a real YYYY-MM-DD date.");
      if (startDate && endDate && startDate > endDate) throw new TypeError("start_date must be <= end_date.");
      if (tag && !/^[a-z0-9_-]{1,64}$/.test(tag)) throw new TypeError("tag must be a safe journal tag.");
      if (sensitivity && !isDayJournalSensitivity(sensitivity)) {
        throw new TypeError("sensitivity is not a day-journal sensitivity.");
      }
      validateJournalQueryFilter(q);
    } catch (error) {
      return invalidParams(c, error instanceof Error ? error.message : String(error));
    }
    const qPattern = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const domainPattern = journalDomainLikePattern(domain);
    const visibleSensitivities = visibleSensitivitiesForRead(c);

    const [countRow] = await sql`
      SELECT count(*)::bigint AS total
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND entry_state = 'active'
        AND (${startDate}::date IS NULL OR target_date >= ${startDate}::date)
        AND (${endDate}::date IS NULL OR target_date <= ${endDate}::date)
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${domainPattern}::text IS NULL OR target_path LIKE ${domainPattern} ESCAPE '\\')
        AND (${tag}::text IS NULL OR tags @> ARRAY[${tag}]::text[])
        AND (${sensitivity}::text IS NULL OR sensitivity = ${sensitivity})
        AND sensitivity = ANY(${visibleSensitivities}::text[])
        AND (${qPattern}::text IS NULL OR payload_preview::text ILIKE ${qPattern} ESCAPE '\\')
    `;
    const rows = await sql`
      SELECT entry_key, day_addr, target_date, target_timezone, routine_id, target_path, project_addr,
             schema, sensitivity, routine_class, result_status, entry_state, captured_at, tags,
             payload_preview, source_refs, latest_run_id, updated_at
      FROM tenant_day_journal_entries
      WHERE tenant_id = ${ctx.context.tenantId}
        AND entry_state = 'active'
        AND (${startDate}::date IS NULL OR target_date >= ${startDate}::date)
        AND (${endDate}::date IS NULL OR target_date <= ${endDate}::date)
        AND (${routineId}::text IS NULL OR routine_id = ${routineId})
        AND (${domainPattern}::text IS NULL OR target_path LIKE ${domainPattern} ESCAPE '\\')
        AND (${tag}::text IS NULL OR tags @> ARRAY[${tag}]::text[])
        AND (${sensitivity}::text IS NULL OR sensitivity = ${sensitivity})
        AND sensitivity = ANY(${visibleSensitivities}::text[])
        AND (${qPattern}::text IS NULL OR payload_preview::text ILIKE ${qPattern} ESCAPE '\\')
      ORDER BY target_date DESC, captured_at DESC, entry_key DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    const capped = capEntryPreviews(rows.map((row: EntryRow) => entryRowJson(row)));
    setPrivateReadHeaders(c);
    const visibleTotal = Number(countRow?.total || 0);
    return c.json({
      ok: true,
      authority: "local_authority",
      visible_total: visibleTotal,
      pagination: paginationJson(limit, offset, visibleTotal, capped.entries.length),
      filters: { start_date: startDate, end_date: endDate, routine_id: routineId, domain, tag, sensitivity, q },
      entries: capped.entries,
      preview_truncated: capped.preview_truncated,
      source_refs_truncated: capped.source_refs_truncated,
    });
  });

  return route;
}

export default createDayJournalRoute();
