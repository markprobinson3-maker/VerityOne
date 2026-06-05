/**
 * Lightweight local day-journal routine scheduler.
 *
 * This is intentionally separate from semantic SuperCron. It only claims
 * enabled day-journal routine settings rows, creates/claims a scheduled run
 * row, then executes the routine outside the settings-row lock.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import { buildDayAddr } from "@verity-one/graph-shape";
import {
  canonicalizeJournalRequest,
  hashJournalRequest,
  validateDayJournalRoutineResult,
  type DayJournalRoutineResult,
} from "./validate";
import {
  defaultTargetPathForRoutine,
  getRoutine,
  listRoutines,
  type DayJournalRoutineContext,
  type DayJournalRoutineDefinition,
  type DayJournalRoutinePermission,
} from "./routines";
import { validateConfigForRoutine } from "./routine-config";
import {
  writeDayJournalEntry as defaultWriteDayJournalEntry,
  type WriteDayJournalEntryResult,
} from "./writer";
import { journalGovernance } from "../sync-journal-port";

type SqlTag = any;

const SCHEDULE_V1_RE = /^(daily|weekday|weekly:(mon|tue|wed|thu|fri|sat|sun))@([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DEFAULT_STARTUP_DELAY_MS = 15_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_LIMIT = 5;
const MAX_BATCH_LIMIT = 25;
const WORKER_NAME = "day-journal-routine-scheduler";
const HEARTBEAT_STALE_AFTER_MS = DEFAULT_INTERVAL_MS * 3;

type DueRoutineRow = {
  tenant_id?: unknown;
  routine_id?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  config?: unknown;
  permission_grants?: unknown;
  next_run_at?: unknown;
};

type ClaimedScheduledRun = {
  tenantId: string;
  spaceId: string;
  routine: DayJournalRoutineDefinition;
  targetPath: string;
  targetDate: string;
  dayAddr: string;
  targetTimezone: string;
  scheduledFireAt: string;
  nextRunAt: Date;
  runKey: string;
  runId: string;
  requestHash: string;
  requestCanonicalJson: string;
  config: Record<string, unknown>;
  permissionGrants: DayJournalRoutinePermission[];
  now: Date;
};

type SchedulerHeartbeatStatus = "running" | "idle" | "error" | "stopped";

type PreparedDueRoutineRun = {
  schedule: string;
  targetTimezone: string;
  scheduledFireAt: string;
  targetDate: string;
  dayAddr: string;
  targetPath: string;
  nextRunAt: Date;
  config: Record<string, unknown>;
  request: ReturnType<typeof buildScheduledRoutineRequest>;
};

type ClaimOutcome =
  | { kind: "claimed"; run: ClaimedScheduledRun }
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "orphan_disabled" };

export type DayJournalRoutineSchedulerTickResult = {
  ok: true;
  worker: typeof WORKER_NAME;
  stalled_count: number;
  claimed_count: number;
  attempted_count: number;
  succeeded_count: number;
  error_status_count: number;
  claim_failed_count: number;
  execute_failed_count: number;
  skipped_count: number;
  failed_count: number;
  orphan_disabled_count: number;
};

export type DayJournalRoutineSchedulerDeps = {
  now?: () => Date;
  instanceId?: string;
  maxDue?: number;
  writeDayJournalEntry?: (
    sql: SqlTag,
    input: Parameters<typeof defaultWriteDayJournalEntry>[1],
  ) => Promise<WriteDayJournalEntryResult>;
  logger?: Pick<Console, "log" | "error">;
  progressIntervalMs?: number;
  intervalMs?: number;
};

export type DayJournalRoutineSchedulerHandle = {
  stop: () => void;
};

class InvalidRoutineSettingsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InvalidRoutineSettingsError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function invalidRoutineSettings(message: string, cause?: unknown): InvalidRoutineSettingsError {
  return new InvalidRoutineSettingsError(message, cause === undefined ? undefined : { cause });
}

function sqlJson(sql: SqlTag, value: unknown): unknown {
  return (sql as any).json(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableInstanceId(): string {
  return `${WORKER_NAME}:${process.pid}:${sha256Hex(process.cwd()).slice(0, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "day_journal_routine_scheduler_error");
}

async function writeSchedulerHeartbeat(
  sql: SqlTag,
  input: {
    instanceId: string;
    status: SchedulerHeartbeatStatus;
    metadata?: Record<string, unknown>;
    lastError?: string | null;
    intervalMs?: number;
  },
): Promise<void> {
  const intervalMs = input.intervalMs || DEFAULT_INTERVAL_MS;
  const stopped = input.status === "stopped";
  await sql`
    INSERT INTO worker_heartbeats (
      worker_name, instance_id, role, status, pid, hostname, mode,
      supervisor_session, heartbeat_interval_ms, stale_after_ms, metadata,
      last_error, started_at, last_heartbeat, stopped_at, updated_at
    )
    VALUES (
      ${WORKER_NAME}, ${input.instanceId}, 'scheduler', ${input.status}, ${process.pid}, ${os.hostname()}, 'local',
      ${process.env.VERITY_SUPERVISOR_SESSION || null},
      ${intervalMs}, ${Math.max(intervalMs * 3, HEARTBEAT_STALE_AFTER_MS)},
      ${sqlJson(sql, input.metadata || {})}::jsonb,
      ${input.lastError ? input.lastError.slice(0, 4000) : null},
      now(), now(), ${stopped ? sql`now()` : null}, now()
    )
    ON CONFLICT (worker_name, instance_id) DO UPDATE SET
      status = EXCLUDED.status,
      heartbeat_interval_ms = EXCLUDED.heartbeat_interval_ms,
      stale_after_ms = EXCLUDED.stale_after_ms,
      metadata = EXCLUDED.metadata,
      last_error = EXCLUDED.last_error,
      last_heartbeat = now(),
      stopped_at = CASE WHEN ${stopped} THEN now() ELSE NULL END,
      updated_at = now()
  `;
}

async function writeSchedulerHeartbeatSafely(
  sql: SqlTag,
  logger: Pick<Console, "error"> | undefined,
  input: Parameters<typeof writeSchedulerHeartbeat>[1],
): Promise<void> {
  try {
    await writeSchedulerHeartbeat(sql, input);
  } catch (error) {
    logger?.error?.(
      "[day-journal-routine-scheduler] heartbeat write failed:",
      errorMessage(error),
    );
  }
}

function positiveBatchLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || Number(value) <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(Number(value), MAX_BATCH_LIMIT);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw invalidRoutineSettings("config must be a JSON object.", error);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw invalidRoutineSettings("config must be a JSON object.");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw invalidRoutineSettings("config must be a JSON object.");
}

function normalizeTimezone(value: unknown): string {
  const timezone = typeof value === "string" ? value.normalize("NFC").trim() : "UTC";
  if (!timezone || timezone.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(timezone)) {
    throw invalidRoutineSettings("timezone must be a bounded IANA timezone string.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidRoutineSettings("timezone must be a bounded IANA timezone string.", error);
    }
    throw error;
  }
  return timezone;
}

function normalizeSchedule(value: unknown, fallback: string): string {
  const schedule = typeof value === "string" ? value.normalize("NFC").trim() : fallback;
  if (!SCHEDULE_V1_RE.test(schedule)) {
    throw invalidRoutineSettings("schedule must match daily@HH:MM, weekday@HH:MM, or weekly:<day>@HH:MM.");
  }
  return schedule;
}

function normalizePermissionGrants(
  routine: DayJournalRoutineDefinition,
  value: unknown,
): DayJournalRoutinePermission[] {
  const raw = Array.isArray(value) ? value : [];
  const allowed = new Set(routine.permissions);
  const grants: DayJournalRoutinePermission[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !allowed.has(item as DayJournalRoutinePermission)) {
      throw new TypeError(`permission_grants contains permission not declared by routine: ${String(item)}`);
    }
    if (!grants.includes(item as DayJournalRoutinePermission)) grants.push(item as DayJournalRoutinePermission);
  }
  for (const permission of routine.permissions) {
    if (!grants.includes(permission)) {
      throw new TypeError(`permission_grants missing required routine permission: ${permission}`);
    }
  }
  return grants;
}

function timestampIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) throw invalidRoutineSettings("scheduled timestamp is invalid.");
  return date.toISOString();
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

export function computeNextDayJournalRoutineRunAt(schedule: string, timeZone: string, now: Date): Date {
  const normalizedSchedule = normalizeSchedule(schedule, schedule);
  const normalizedTimezone = normalizeTimezone(timeZone);
  const cadence = normalizedSchedule.slice(0, normalizedSchedule.indexOf("@"));
  const [hour, minute] = normalizedSchedule.slice(normalizedSchedule.lastIndexOf("@") + 1).split(":").map((part) => Number(part));
  const nowLocal = datePartsInTimezone(now, normalizedTimezone);
  const targetWeekday = cadence.startsWith("weekly:") ? cadence.slice("weekly:".length) : null;

  for (let offset = 0; offset <= 14; offset += 1) {
    const noon = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + offset, 12));
    const local = datePartsInTimezone(noon, normalizedTimezone);
    const weekday = local.weekday.slice(0, 3);
    if (cadence === "weekday" && (weekday === "sat" || weekday === "sun")) continue;
    if (targetWeekday && targetWeekday !== weekday) continue;
    const candidate = localDateTimeToUtc(local.year, local.month, local.day, hour, minute, normalizedTimezone);
    if (candidate && candidate.getTime() > now.getTime()) return candidate;
  }
  throw new TypeError("schedule did not produce a next run within 14 days.");
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = datePartsInTimezone(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dayAddrForTargetDate(targetDate: string): string {
  const [year, month, day] = targetDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  return buildDayAddr(year, Math.floor((date.getTime() - start.getTime()) / 86400000) + 1);
}

export function buildScheduledRoutineRequest(input: {
  tenantId: string;
  routineId: string;
  targetDate: string;
  dayAddr: string;
  targetPath: string;
  targetTimezone: string;
  scheduledFireAt: string;
  config: Record<string, unknown>;
  permissionGrants: string[];
}): { canonical: string; hash: string; runKey: string } {
  const runKeySeed = canonicalizeJournalRequest({
    kind: "scheduled_routine_run_key",
    routine_id: input.routineId,
    target_date: input.targetDate,
    target_path: input.targetPath,
    scheduled_fire_at: input.scheduledFireAt,
  });
  const runKey = `scheduled_${hashJournalRequest(input.tenantId, runKeySeed).slice(0, 32)}`;
  const canonical = canonicalizeJournalRequest({
    kind: "scheduled_routine",
    routine_id: input.routineId,
    target_date: input.targetDate,
    day_addr: input.dayAddr,
    target_path: input.targetPath,
    target_timezone: input.targetTimezone,
    scheduled_fire_at: input.scheduledFireAt,
    run_key: runKey,
    config_hash: sha256Hex(canonicalizeJournalRequest(input.config)),
    permission_snapshot_hash: sha256Hex(canonicalizeJournalRequest([...input.permissionGrants].sort())),
  });
  return {
    canonical,
    hash: hashJournalRequest(input.tenantId, canonical),
    runKey,
  };
}

function prepareDueRoutineRun(
  row: DueRoutineRow,
  routine: DayJournalRoutineDefinition,
  tenantId: string,
  now: Date,
): PreparedDueRoutineRun {
  const schedule = normalizeSchedule(row.schedule, routine.defaultSchedule);
  const targetTimezone = normalizeTimezone(row.timezone);
  const scheduledFireAt = timestampIso(row.next_run_at);
  const scheduledFireDate = new Date(scheduledFireAt);
  const targetDate = dateInTimezone(scheduledFireDate, targetTimezone);
  const dayAddr = dayAddrForTargetDate(targetDate);
  const targetPath = defaultTargetPathForRoutine(routine);
  const nextRunAt = computeNextDayJournalRoutineRunAt(schedule, targetTimezone, scheduledFireDate);
  let config: Record<string, unknown>;
  try {
    config = validateConfigForRoutine(routine, normalizeJsonObject(row.config));
  } catch (error) {
    if (error instanceof InvalidRoutineSettingsError) throw error;
    throw invalidRoutineSettings(errorMessage(error), error);
  }
  const request = buildScheduledRoutineRequest({
    tenantId,
    routineId: routine.id,
    targetDate,
    dayAddr,
    targetPath,
    targetTimezone,
    scheduledFireAt,
    config,
    permissionGrants: Array.isArray(row.permission_grants)
      ? row.permission_grants.filter((item): item is string => typeof item === "string")
      : [],
  });
  return {
    schedule,
    targetTimezone,
    scheduledFireAt,
    targetDate,
    dayAddr,
    targetPath,
    nextRunAt,
    config,
    request,
  };
}

async function disableInvalidRoutineSettings(
  tx: SqlTag,
  tenantId: string,
  routineId: string,
  spaceId: string,
): Promise<void> {
  await tx`
    UPDATE tenant_day_journal_routines
    SET enabled = false,
        next_run_at = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND routine_id = ${routineId}
  `;
  await journalGovernance(tx, `day_journal.routine.${routineId}.invalid_settings_disabled`, spaceId);
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

async function markRunFailed(sql: SqlTag, tenantId: string, runId: string, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error || "day_journal_routine_failed");
  const rows = await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        result = ${sqlJson(sql, { ok: false, error: message.slice(0, 4000) })}::jsonb,
        error = ${message.slice(0, 4000)},
        finished_at = now(),
        last_progress_at = now()
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status IN ('pending', 'running')
    RETURNING id
  `;
  if (rows.length > 0) return true;
  const [terminal] = await sql`
    SELECT id
    FROM tenant_day_journal_routine_runs
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status IN ('succeeded', 'failed', 'rejected', 'canceled')
    LIMIT 1
  `;
  return Boolean(terminal?.id);
}

async function markStalledRuns(
  sql: SqlTag,
  routines: DayJournalRoutineDefinition[],
  now: Date,
): Promise<number> {
  let stalled = 0;
  const routineIds = routines.map((routine) => routine.id);
  let maxRoutineTimeoutMs = DEFAULT_INTERVAL_MS;
  for (const routine of routines) {
    maxRoutineTimeoutMs = Math.max(maxRoutineTimeoutMs, routine.timeoutMs);
    const cutoff = new Date(now.getTime() - routine.timeoutMs).toISOString();
    const rows = await sql`
      UPDATE tenant_day_journal_routine_runs
      SET run_status = 'failed',
          result_status = 'error',
          result = ${sqlJson(sql, { ok: false, error: "stalled" })}::jsonb,
          error = 'stalled',
          finished_at = now(),
          last_progress_at = now()
      WHERE routine_id = ${routine.id}
        AND run_status = 'running'
        AND trigger = 'schedule'
        AND dry_run = false
        AND COALESCE(last_progress_at, claimed_at, started_at) < ${cutoff}::timestamptz
      RETURNING id
    `;
    stalled += rows.length;
  }
  const unknownCutoff = new Date(now.getTime() - maxRoutineTimeoutMs).toISOString();
  const unknownRows = await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        result = ${sqlJson(sql, { ok: false, error: "stalled_unknown_routine" })}::jsonb,
        error = 'stalled_unknown_routine',
        finished_at = now(),
        last_progress_at = now()
    WHERE run_status = 'running'
      AND trigger = 'schedule'
      AND dry_run = false
      AND NOT (routine_id = ANY(${routineIds}::text[]))
      AND COALESCE(last_progress_at, claimed_at, started_at) < ${unknownCutoff}::timestamptz
    RETURNING id
  `;
  stalled += unknownRows.length;
  const pendingCutoff = new Date(now.getTime() - maxRoutineTimeoutMs).toISOString();
  const pendingRows = await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        result = ${sqlJson(sql, { ok: false, error: "stalled_pending_claim" })}::jsonb,
        error = 'stalled_pending_claim',
        finished_at = now(),
        last_progress_at = now()
    WHERE run_status = 'pending'
      AND trigger IN ('manual', 'agent_command', 'hosted_command')
      AND dry_run = false
      AND started_at < ${pendingCutoff}::timestamptz
    RETURNING id
  `;
  stalled += pendingRows.length;
  return stalled;
}

async function markClaimFailed(tx: SqlTag, tenantId: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error || "day_journal_scheduler_claim_failed");
  await tx`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        result = ${sqlJson(tx, { ok: false, error: message.slice(0, 4000) })}::jsonb,
        error = ${message.slice(0, 4000)},
        finished_at = now(),
        last_progress_at = now()
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status IN ('pending', 'running')
  `;
}

async function touchRunProgress(sql: SqlTag, tenantId: string, runId: string): Promise<void> {
  await sql`
    UPDATE tenant_day_journal_routine_runs
    SET last_progress_at = now()
    WHERE id = ${runId}::uuid
      AND tenant_id = ${tenantId}
      AND run_status = 'running'
  `;
}

function startRunProgressHeartbeat(
  sql: SqlTag,
  run: Pick<ClaimedScheduledRun, "tenantId" | "runId" | "routine">,
  deps: DayJournalRoutineSchedulerDeps,
): () => void {
  const intervalMs = deps.progressIntervalMs
    ? Math.max(1, deps.progressIntervalMs)
    : Math.max(1_000, Math.min(10_000, Math.floor(run.routine.timeoutMs / 3)));
  const timer = setInterval(() => {
    touchRunProgress(sql, run.tenantId, run.runId).catch((error) => {
      deps.logger?.error?.(
        "[day-journal-routine-scheduler] failed to touch run progress:",
        errorMessage(error),
      );
    });
  }, intervalMs);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}

async function advanceRoutineSchedule(
  sql: SqlTag,
  input: {
    tenantId: string;
    routineId: string;
    scheduledFireAt: string;
    nextRunAt: Date;
  },
): Promise<void> {
  await sql`
    UPDATE tenant_day_journal_routines
    SET last_scheduled_at = ${input.scheduledFireAt}::timestamptz,
        next_run_at = ${input.nextRunAt.toISOString()}::timestamptz,
        updated_at = now()
    WHERE tenant_id = ${input.tenantId}
      AND routine_id = ${input.routineId}
      AND enabled = true
      AND next_run_at = ${input.scheduledFireAt}::timestamptz
  `;
}

async function claimDueRuns(
  sql: SqlTag,
  now: Date,
  maxDue: number,
  instanceId: string,
  logger: Pick<Console, "error"> | undefined,
): Promise<ClaimOutcome[]> {
  return await sql.begin(async (tx: SqlTag) => {
    const dueRows = await tx`
      SELECT tenant_id, routine_id, schedule, timezone, config, permission_grants, next_run_at
      FROM tenant_day_journal_routines
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${now.toISOString()}::timestamptz
      ORDER BY next_run_at ASC, tenant_id ASC, routine_id ASC
      LIMIT ${maxDue}
      FOR UPDATE SKIP LOCKED
    `;
    const outcomes: ClaimOutcome[] = [];

    for (const row of dueRows as DueRoutineRow[]) {
      const tenantId = String(row.tenant_id || "");
      const routineId = String(row.routine_id || "");
      const spaceId = `tenant:${tenantId}`;
      const routine = getRoutine(routineId);
      if (!routine) {
        await tx`
          UPDATE tenant_day_journal_routines
          SET enabled = false,
              next_run_at = NULL,
              updated_at = now()
          WHERE tenant_id = ${tenantId}
            AND routine_id = ${routineId}
        `;
        await journalGovernance(tx, `day_journal.routine.${routineId}.orphan_disabled`, spaceId);
        outcomes.push({ kind: "orphan_disabled" });
        continue;
      }

      let prepared: PreparedDueRoutineRun;
      try {
        prepared = prepareDueRoutineRun(row, routine, tenantId, now);
      } catch (error) {
        logger?.error?.(
          `[day-journal-routine-scheduler] failed to prepare routine ${routineId} for tenant ${tenantId}:`,
          errorMessage(error),
        );
        if (!(error instanceof InvalidRoutineSettingsError)) throw error;
        await disableInvalidRoutineSettings(tx, tenantId, routineId, spaceId);
        outcomes.push({ kind: "failed" });
        continue;
      }
      const {
        schedule,
        targetTimezone,
        scheduledFireAt,
        targetDate,
        dayAddr,
        targetPath,
        nextRunAt,
        config,
        request,
      } = prepared;

      const [inserted] = await tx`
        INSERT INTO tenant_day_journal_routine_runs (
          tenant_id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
          trigger, run_key, scheduled_fire_at, scheduler_instance, actor, request_hash,
          permission_snapshot, dry_run, run_status, claimed_at, last_progress_at
        ) VALUES (
          ${tenantId}, ${routine.id}, ${targetPath}, ${targetDate}, ${targetTimezone}, ${dayAddr},
          'schedule', ${request.runKey}, ${scheduledFireAt}::timestamptz, ${instanceId}, ${WORKER_NAME}, ${request.hash},
          ${sqlJson(tx, {
            permissions: Array.isArray(row.permission_grants) ? row.permission_grants : [],
            schedule,
            timezone: targetTimezone,
            scheduled_fire_at: scheduledFireAt,
          })}::jsonb,
          false, 'running', now(), now()
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      let runId = inserted?.id ? String(inserted.id) : null;
      if (!runId) {
        const [recovered] = await tx`
          UPDATE tenant_day_journal_routine_runs
          SET run_status = 'running',
              target_date = ${targetDate},
              target_timezone = ${targetTimezone},
              day_addr_at_run = ${dayAddr},
              scheduled_fire_at = ${scheduledFireAt}::timestamptz,
              request_hash = ${request.hash},
              permission_snapshot = ${sqlJson(tx, {
                permissions: Array.isArray(row.permission_grants) ? row.permission_grants : [],
                schedule,
                timezone: targetTimezone,
                scheduled_fire_at: scheduledFireAt,
              })}::jsonb,
              result_status = NULL,
              result = NULL,
              error = NULL,
              finished_at = NULL,
              claimed_at = now(),
              last_progress_at = now(),
              scheduler_instance = ${instanceId}
          WHERE tenant_id = ${tenantId}
            AND routine_id = ${routine.id}
            AND target_date = ${targetDate}
            AND target_path = ${targetPath}
            AND run_key = ${request.runKey}
            AND dry_run = false
            AND trigger = 'schedule'
            AND run_status = 'failed'
            AND error IN ('stalled', 'stalled_unknown_routine')
          RETURNING id
        `;
        runId = recovered?.id ? String(recovered.id) : null;
      }
      if (!runId) {
        const [recoveredByScheduledFire] = await tx`
          UPDATE tenant_day_journal_routine_runs AS runs
          SET run_status = 'running',
              target_date = ${targetDate},
              target_timezone = ${targetTimezone},
              day_addr_at_run = ${dayAddr},
              run_key = ${request.runKey},
              request_hash = ${request.hash},
              permission_snapshot = ${sqlJson(tx, {
                permissions: Array.isArray(row.permission_grants) ? row.permission_grants : [],
                schedule,
                timezone: targetTimezone,
                scheduled_fire_at: scheduledFireAt,
              })}::jsonb,
              result_status = NULL,
              result = NULL,
              error = NULL,
              finished_at = NULL,
              claimed_at = now(),
              last_progress_at = now(),
              scheduler_instance = ${instanceId}
          WHERE runs.tenant_id = ${tenantId}
            AND runs.routine_id = ${routine.id}
            AND runs.target_path = ${targetPath}
            AND runs.scheduled_fire_at = ${scheduledFireAt}::timestamptz
            AND runs.dry_run = false
            AND runs.trigger = 'schedule'
            AND runs.run_status = 'failed'
            AND runs.error IN ('stalled', 'stalled_unknown_routine')
            AND NOT EXISTS (
              SELECT 1
              FROM tenant_day_journal_routine_runs AS existing
              WHERE existing.tenant_id = ${tenantId}
                AND existing.routine_id = ${routine.id}
                AND existing.target_date = ${targetDate}::date
                AND existing.target_path = ${targetPath}
                AND existing.run_key = ${request.runKey}
                AND existing.dry_run = false
                AND existing.id <> runs.id
            )
          RETURNING id
        `;
        runId = recoveredByScheduledFire?.id ? String(recoveredByScheduledFire.id) : null;
      }

      if (!runId) {
        const [existing] = await tx`
          SELECT id, run_status
          FROM tenant_day_journal_routine_runs
          WHERE tenant_id = ${tenantId}
            AND routine_id = ${routine.id}
            AND target_path = ${targetPath}
            AND dry_run = false
            AND trigger = 'schedule'
            AND (
              (target_date = ${targetDate}::date AND run_key = ${request.runKey})
              OR scheduled_fire_at = ${scheduledFireAt}::timestamptz
            )
          ORDER BY
            CASE WHEN target_date = ${targetDate}::date AND run_key = ${request.runKey} THEN 0 ELSE 1 END,
            started_at DESC
          LIMIT 1
          FOR UPDATE
        `;
        if (["succeeded", "failed", "rejected", "canceled"].includes(String(existing?.run_status || ""))) {
          await advanceRoutineSchedule(tx, {
            tenantId,
            routineId: routine.id,
            scheduledFireAt,
            nextRunAt,
          });
        }
        outcomes.push({ kind: "skipped" });
        continue;
      }

      let permissionGrants: DayJournalRoutinePermission[];
      try {
        permissionGrants = normalizePermissionGrants(routine, row.permission_grants);
      } catch (error) {
        await markClaimFailed(tx, tenantId, runId, error);
        await advanceRoutineSchedule(tx, {
          tenantId,
          routineId: routine.id,
          scheduledFireAt,
          nextRunAt,
        });
        outcomes.push({ kind: "failed" });
        continue;
      }

      outcomes.push({
        kind: "claimed",
        run: {
          tenantId,
          spaceId,
          routine,
          targetPath,
          targetDate,
          dayAddr,
          targetTimezone,
          scheduledFireAt,
          nextRunAt,
          runKey: request.runKey,
          runId,
          requestHash: request.hash,
          requestCanonicalJson: request.canonical,
          config,
          permissionGrants,
          now,
        },
      });
    }
    return outcomes;
  });
}

async function executeClaimedRun(
  sql: SqlTag,
  run: ClaimedScheduledRun,
  deps: DayJournalRoutineSchedulerDeps,
): Promise<{ ok: boolean; terminal: boolean; errorStatus: boolean }> {
  const writeDayJournalEntry = deps.writeDayJournalEntry || defaultWriteDayJournalEntry;
  const stopProgressHeartbeat = startRunProgressHeartbeat(sql, run, deps);
  try {
    const rawResult = await runRoutineWithTimeout(run.routine, {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      routineId: run.routine.id,
      targetDate: run.targetDate,
      dayAddr: run.dayAddr,
      targetPath: run.targetPath,
      targetTimezone: run.targetTimezone,
      dryRun: false,
      config: run.config,
      permissions: [...run.permissionGrants],
      runId: run.runId,
      now: run.now,
    });
    const validation = validateDayJournalRoutineResult(rawResult);
    if (!validation.ok) throw new TypeError(`routine_result_invalid: ${validation.error}`);
    const result = validation.result;
    assertRoutineResultMatchesInvocation(result, run.routine, run.targetPath, run.targetDate);

    const written = await writeDayJournalEntry(sql, {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      targetDate: run.targetDate,
      dayAddr: run.dayAddr,
      targetTimezone: run.targetTimezone,
      result,
      actor: WORKER_NAME,
      runId: run.runId,
      requestHash: run.requestHash,
      requestCanonicalJson: run.requestCanonicalJson,
      requestKind: "scheduled_routine",
      sensitivity: run.routine.sensitivity,
      routineClass: run.routine.routineClass,
      mutationKind: "routine_run",
    });
    if (!written.ok) {
      deps.logger?.error?.(
        "[day-journal-routine-scheduler] routine write failed:",
        `${written.code}${written.hint ? `: ${written.hint}` : ""}`,
      );
      return { ok: false, terminal: true, errorStatus: false };
    }
    return { ok: true, terminal: true, errorStatus: result.status === "error" };
  } catch (error) {
    let terminal = false;
    await markRunFailed(sql, run.tenantId, run.runId, error).then((markedTerminal) => {
      terminal = markedTerminal;
    }).catch((markError) => {
      deps.logger?.error?.(
        "[day-journal-routine-scheduler] failed to mark run failed:",
        markError instanceof Error ? markError.message : String(markError),
      );
    });
    return { ok: false, terminal, errorStatus: false };
  } finally {
    stopProgressHeartbeat();
  }
}

export async function runDayJournalRoutineSchedulerTick(
  sql: SqlTag,
  deps: DayJournalRoutineSchedulerDeps = {},
): Promise<DayJournalRoutineSchedulerTickResult> {
  const now = deps.now ? deps.now() : new Date();
  const instanceId = deps.instanceId || stableInstanceId();
  const logger = deps.logger || console;
  const maxDue = positiveBatchLimit(deps.maxDue);
  const heartbeatIntervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  await writeSchedulerHeartbeatSafely(sql, logger, {
    instanceId,
    status: "running",
    metadata: {
      phase: "tick",
      max_due: maxDue,
    },
    intervalMs: heartbeatIntervalMs,
  });
  try {
    const routines = listRoutines();
    const stalledCount = await markStalledRuns(sql, routines, now);
    const outcomes = await claimDueRuns(sql, now, maxDue, instanceId, logger);
    let attemptedCount = 0;
    let succeededCount = 0;
    let errorStatusCount = 0;
    let executeFailedCount = 0;
    const claimFailedCount = outcomes.filter((outcome) => outcome.kind === "failed").length;
    const skippedCount = outcomes.filter((outcome) => outcome.kind === "skipped").length;
    const orphanDisabledCount = outcomes.filter((outcome) => outcome.kind === "orphan_disabled").length;

    for (const outcome of outcomes) {
      if (outcome.kind !== "claimed") continue;
      attemptedCount += 1;
      const execution = await executeClaimedRun(sql, outcome.run, { ...deps, logger });
      if (execution.ok) {
        succeededCount += 1;
        if (execution.errorStatus) errorStatusCount += 1;
      } else {
        executeFailedCount += 1;
      }
      if (execution.terminal) {
        await advanceRoutineSchedule(sql, {
          tenantId: outcome.run.tenantId,
          routineId: outcome.run.routine.id,
          scheduledFireAt: outcome.run.scheduledFireAt,
          nextRunAt: outcome.run.nextRunAt,
        });
      }
    }

    const result: DayJournalRoutineSchedulerTickResult = {
      ok: true,
      worker: WORKER_NAME,
      stalled_count: stalledCount,
      claimed_count: outcomes.filter((outcome) => outcome.kind === "claimed").length,
      attempted_count: attemptedCount,
      succeeded_count: succeededCount,
      error_status_count: errorStatusCount,
      claim_failed_count: claimFailedCount,
      execute_failed_count: executeFailedCount,
      skipped_count: skippedCount,
      failed_count: claimFailedCount + executeFailedCount + errorStatusCount,
      orphan_disabled_count: orphanDisabledCount,
    };
    await writeSchedulerHeartbeatSafely(sql, logger, {
      instanceId,
      status: "idle",
      metadata: {
        phase: "tick_complete",
        stalled_count: result.stalled_count,
        claimed_count: result.claimed_count,
        attempted_count: result.attempted_count,
        succeeded_count: result.succeeded_count,
        error_status_count: result.error_status_count,
        claim_failed_count: result.claim_failed_count,
        execute_failed_count: result.execute_failed_count,
        skipped_count: result.skipped_count,
        failed_count: result.failed_count,
        orphan_disabled_count: result.orphan_disabled_count,
      },
      intervalMs: heartbeatIntervalMs,
    });
    return result;
  } catch (error) {
    await writeSchedulerHeartbeatSafely(sql, logger, {
      instanceId,
      status: "error",
      metadata: {
        phase: "tick_failed",
      },
      lastError: errorMessage(error),
      intervalMs: heartbeatIntervalMs,
    });
    throw error;
  }
}

export function startDayJournalRoutineScheduler(
  sql: SqlTag,
  deps: DayJournalRoutineSchedulerDeps & {
    startupDelayMs?: number;
  } = {},
): DayJournalRoutineSchedulerHandle {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const logger = deps.logger || console;
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const instanceId = deps.instanceId || stableInstanceId();
  let disabledByEnv = false;

  const schedulerDisabledByEnv = () => process.env.VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER === "off";
  const writeEnvDisabledHeartbeat = () => {
    disabledByEnv = true;
    void writeSchedulerHeartbeatSafely(sql, logger, {
      instanceId,
      status: "stopped",
      metadata: {
        phase: "scheduler_disabled",
        env_flag: "VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER=off",
      },
      intervalMs,
    });
  };

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      tick().catch((error) => {
        logger.error("[day-journal-routine-scheduler] tick failed:", error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || running) return;
    if (schedulerDisabledByEnv()) {
      logger.log("  Day-journal routine scheduler: inactive (VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER=off)");
      writeEnvDisabledHeartbeat();
      return;
    }
    running = true;
    try {
      await runDayJournalRoutineSchedulerTick(sql, { ...deps, logger, instanceId });
    } finally {
      running = false;
      if (!stopped) schedule(intervalMs);
    }
  };

  if (schedulerDisabledByEnv()) {
    logger.log("  Day-journal routine scheduler: inactive (VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER=off)");
    writeEnvDisabledHeartbeat();
  } else {
    logger.log(`  Day-journal routine scheduler: active (first run in ${startupDelayMs / 1000}s, then every ${intervalMs / 1000}s)`);
    schedule(startupDelayMs);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void writeSchedulerHeartbeatSafely(sql, logger, {
        instanceId,
        status: "stopped",
        metadata: disabledByEnv
          ? {
              phase: "scheduler_disabled",
              env_flag: "VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER=off",
            }
          : { phase: "stopped" },
        intervalMs,
      });
    },
  };
}
