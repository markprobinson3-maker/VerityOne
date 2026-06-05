/**
 * Verity Ingest — Internal Scheduler
 *
 * Runs inside the API process. No external crons.
 * Checks every 60s for due schedules, runs up to 3 per tick.
 */

import { loadAdapters, getAdapter, listAdapters } from "./adapters/registry";
import { runPipeline } from "./pipeline";
import { sql } from "./config";
import { CronExpressionParser } from "cron-parser";
import { recordScheduleRun, type TriggerKind } from "./schedule-history";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let subMinuteTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; intervalSeconds: number; nextRunAt: Date }>();
const pendingScheduleIds = new Set<number>();
const runningScheduleIds = new Set<number>();
const runQueue: number[] = [];
const MAX_CONCURRENT_SCHEDULE_RUNS = Math.max(1, parseInt(process.env.VERITY_VI_MAX_CONCURRENT_SCHEDULE_RUNS || "4", 10) || 4);

export function computeNextIntervalRunAt(scheduleId: number, intervalSeconds: number, now = Date.now()): Date {
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  const shardOffsetMs = ((scheduleId * 9_973) % intervalMs + intervalMs) % intervalMs;
  const nextMs = Math.floor((now - shardOffsetMs) / intervalMs + 1) * intervalMs + shardOffsetMs;
  return new Date(nextMs);
}

export async function startScheduler() {
  await loadAdapters();
  const count = listAdapters().length;
  console.log(`VI Scheduler started. ${count} adapters loaded.`);

  // Check every 60 seconds for due cron-based schedules
  schedulerInterval = setInterval(async () => {
    try {
      await syncSubMinuteTimers();
      await runDueSchedules();
    } catch (err) {
      console.error("Scheduler tick error:", err);
    }
  }, 60_000);

  // Seed next_run_at for any schedule missing it
  await seedNextRuns();

  // Start sub-minute interval timers
  await startSubMinuteTimers();
}

export function stopScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  for (const [, entry] of subMinuteTimers) clearTimeout(entry.timer);
  subMinuteTimers.clear();
}

async function runDueSchedules() {
  const due = await sql`
    SELECT * FROM vi_schedules
    WHERE enabled = true
      AND interval_seconds IS NULL
      AND next_run_at <= now()
    ORDER BY next_run_at ASC
    LIMIT 50
  `;

  for (const schedule of due) {
    enqueueSchedule(schedule.id);
  }
  await drainRunQueue();
}

async function executeSchedule(schedule: any, triggerKind: TriggerKind = "scheduler") {
  const startedAt = new Date();
  const adapter = getAdapter(schedule.adapter_name);
  if (!adapter) {
    // Keep vi_schedules summary consistent with Recent Runs history:
    //   - last_run_at / total_runs reflect the attempt (even though it
    //     couldn't execute) so the schedule row no longer reads as
    //     "never run" while Recent Runs shows the adapter error.
    //   - next_run_at advances on the usual schedule so the scheduler
    //     tick doesn't busy-loop retrying and flooding history at 60s
    //     intervals. A broken adapter keeps failing on each cycle, not
    //     every tick.
    const nextRun = schedule.interval_seconds != null
      ? computeNextIntervalRunAt(schedule.id, schedule.interval_seconds)
      : computeNextRun(schedule.schedule_cron);
    await sql`
      UPDATE vi_schedules SET
        last_run_at = now(),
        last_status = 'error',
        last_error = 'Adapter not found',
        next_run_at = ${nextRun},
        total_runs = total_runs + 1,
        updated_at = now()
      WHERE id = ${schedule.id}
    `;
    // History: the run attempt happened, even if it couldn't be executed.
    // Best-effort — never break the scheduler's primary path.
    try {
      const completedAt = new Date();
      await recordScheduleRun(sql, {
        schedule_id: schedule.id,
        adapter_name: schedule.adapter_name,
        trigger_kind: triggerKind,
        status: "error",
        error: "Adapter not found",
        source_input: schedule.source_input || null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAt.getTime() - startedAt.getTime(),
      });
    } catch (e: any) {
      console.error("[SCHEDULER] Failed to record run history (missing adapter):", e?.message);
    }
    return;
  }

  try {
    console.log(`[SCHEDULER] Running: ${schedule.adapter_name} (schedule #${schedule.id})`);
    const result = await runPipeline({
      adapter,
      source: schedule.source_input || "",
      config: schedule.adapter_config || {},
    });
    const mergedConfig = {
      ...(schedule.adapter_config || {}),
      ...(result.source_title ? { feed_title: result.source_title } : {}),
    };

    const nextRun = schedule.interval_seconds != null
      ? computeNextIntervalRunAt(schedule.id, schedule.interval_seconds)
      : computeNextRun(schedule.schedule_cron);
    await sql`
      UPDATE vi_schedules SET
        last_run_at = now(),
        last_status = 'success',
        last_error = NULL,
        last_atoms_count = ${result.total_atoms},
        adapter_config = ${sql.json(mergedConfig)},
        next_run_at = ${nextRun},
        total_runs = total_runs + 1,
        total_atoms = total_atoms + ${result.total_atoms},
        total_cost_usd = total_cost_usd + ${result.cost_usd},
        updated_at = now()
      WHERE id = ${schedule.id}
    `;
    try {
      const completedAt = new Date();
      await recordScheduleRun(sql, {
        schedule_id: schedule.id,
        adapter_name: schedule.adapter_name,
        trigger_kind: triggerKind,
        status: "success",
        atoms_count: result.total_atoms ?? null,
        cost_usd: result.cost_usd ?? null,
        source_input: schedule.source_input || null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAt.getTime() - startedAt.getTime(),
      });
    } catch (e: any) {
      console.error("[SCHEDULER] Failed to record run history (success):", e?.message);
    }
  } catch (err: any) {
    const nextRun = schedule.interval_seconds != null
      ? computeNextIntervalRunAt(schedule.id, schedule.interval_seconds)
      : computeNextRun(schedule.schedule_cron);
    await sql`
      UPDATE vi_schedules SET
        last_run_at = now(),
        last_status = 'error',
        last_error = ${err.message?.slice(0, 500)},
        next_run_at = ${nextRun},
        total_runs = total_runs + 1,
        updated_at = now()
      WHERE id = ${schedule.id}
    `;
    console.error(`[SCHEDULER] Error running ${schedule.adapter_name}:`, err.message?.slice(0, 200));
    try {
      const completedAt = new Date();
      await recordScheduleRun(sql, {
        schedule_id: schedule.id,
        adapter_name: schedule.adapter_name,
        trigger_kind: triggerKind,
        status: "error",
        error: err?.message || String(err),
        source_input: schedule.source_input || null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAt.getTime() - startedAt.getTime(),
      });
    } catch (e: any) {
      console.error("[SCHEDULER] Failed to record run history (error):", e?.message);
    }
  }
}

function enqueueSchedule(scheduleId: number) {
  if (pendingScheduleIds.has(scheduleId) || runningScheduleIds.has(scheduleId)) return;
  pendingScheduleIds.add(scheduleId);
  runQueue.push(scheduleId);
}

async function drainRunQueue() {
  while (runningScheduleIds.size < MAX_CONCURRENT_SCHEDULE_RUNS && runQueue.length > 0) {
    const scheduleId = runQueue.shift();
    if (scheduleId == null) continue;
    pendingScheduleIds.delete(scheduleId);
    runningScheduleIds.add(scheduleId);
    void runQueuedSchedule(scheduleId);
  }
}

async function runQueuedSchedule(scheduleId: number) {
  try {
    const [schedule] = await sql`
      SELECT *
      FROM vi_schedules
      WHERE id = ${scheduleId}
        AND enabled = true
      LIMIT 1
    `;
    if (!schedule) return;
    await executeSchedule(schedule);
  } catch (err) {
    console.error(`[SCHEDULER] Queue run failed for schedule #${scheduleId}:`, err);
  } finally {
    runningScheduleIds.delete(scheduleId);
    await drainRunQueue();
  }
}

function computeNextRun(cronExpr: string): Date {
  try {
    const cron = CronExpressionParser.parse(cronExpr);
    return cron.next().toDate();
  } catch {
    // Fallback: 1 hour from now
    return new Date(Date.now() + 3600_000);
  }
}

async function seedNextRuns() {
  const unscheduled = await sql`
    SELECT id, schedule_cron FROM vi_schedules
    WHERE next_run_at IS NULL AND enabled = true AND interval_seconds IS NULL
  `;
  for (const s of unscheduled) {
    const next = computeNextRun(s.schedule_cron);
    await sql`UPDATE vi_schedules SET next_run_at = ${next} WHERE id = ${s.id}`;
  }
}

async function startSubMinuteTimers() {
  await syncSubMinuteTimers();
}

async function syncSubMinuteTimers() {
  const subMinute = await sql`
    SELECT * FROM vi_schedules
    WHERE enabled = true AND interval_seconds IS NOT NULL
  `;
  const activeIds = new Set<number>(subMinute.map((schedule: any) => schedule.id));

  for (const [scheduleId, entry] of subMinuteTimers.entries()) {
    if (!activeIds.has(scheduleId)) {
      clearTimeout(entry.timer);
      subMinuteTimers.delete(scheduleId);
      console.log(`[SCHEDULER] Removed sub-minute timer for schedule #${scheduleId}`);
    }
  }

  for (const schedule of subMinute) {
    const adapter = getAdapter(schedule.adapter_name);
    if (!adapter) continue;

    const existing = subMinuteTimers.get(schedule.id);
    if (existing && existing.intervalSeconds === schedule.interval_seconds) continue;
    if (existing) {
      clearTimeout(existing.timer);
      subMinuteTimers.delete(schedule.id);
    }

    const nextRunAt = computeNextIntervalRunAt(schedule.id, schedule.interval_seconds);
    const delayMs = Math.max(250, nextRunAt.getTime() - Date.now());
    const timer = setTimeout(async () => {
      enqueueSchedule(schedule.id);
      await drainRunQueue();
      await syncSubMinuteTimers();
    }, delayMs);

    subMinuteTimers.set(schedule.id, { timer, intervalSeconds: schedule.interval_seconds, nextRunAt });
    await sql`
      UPDATE vi_schedules
      SET next_run_at = ${nextRunAt}, updated_at = now()
      WHERE id = ${schedule.id}
    `;
    console.log(`[SCHEDULER] Interval timer: ${schedule.adapter_name} #${schedule.id} every ${schedule.interval_seconds}s next=${nextRunAt.toISOString()} concurrency=${MAX_CONCURRENT_SCHEDULE_RUNS}`);
  }
}

/**
 * Run a specific schedule by ID (for manual / remote-command triggers).
 * Callers pass the honest trigger kind so history attribution is correct:
 *   - "manual" — local dashboard / vi-schedules HTTP trigger
 *   - "remote_command" — dispatched by the hosted remote-command loop
 *   - "scheduler" — the internal tick (default is still "manual" for
 *     direct callers that forget to set it; scheduler-tick goes through
 *     runQueuedSchedule → executeSchedule(schedule) which already defaults
 *     to "scheduler").
 */
export async function runScheduleById(id: number, triggerKind: TriggerKind = "manual") {
  const [schedule] = await sql`SELECT * FROM vi_schedules WHERE id = ${id}`;
  if (!schedule) throw new Error(`Schedule #${id} not found`);
  await executeSchedule(schedule, triggerKind);
}
