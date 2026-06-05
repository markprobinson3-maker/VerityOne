/**
 * Local overlay pull scheduler — automated background overlay sync loop.
 *
 * Runs inside the local api process. Periodically calls the existing
 * `pullAndImportOverlays()` to fetch signed public overlays from the
 * federation feed.
 *
 * Activation: `public_overlay_sync = "pull"` in tenant config AND
 * overlay state exists (federation registration completed).
 *
 * The scheduler is a simple in-process timer. No distributed
 * coordination, no external job manager, no separate daemon.
 * Mirrors the sync-scheduler.ts pattern.
 *
 * Disable via `VERITY_OVERLAY_SCHEDULER=off` env for tests/scripts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type postgres from "postgres";
import { pullAndImportOverlays, loadOverlayState } from "./overlay-import";
import { resolveConfigPath, resolveTenantSettings } from "./runtime-profile";

type SqlTag = ReturnType<typeof postgres>;

// ── Constants ────────────────────────────────────────────────────────

const STARTUP_DELAY_MS = 30_000;           // 30s after HTTP ready (longer than sync)
const BASE_INTERVAL_MS = 10 * 60_000;     // 10 minutes steady-state
const MIN_BACKOFF_MS = 2 * 60_000;        // 2 min on first failure
const MAX_BACKOFF_MS = 60 * 60_000;       // 1 hour ceiling
const BACKOFF_MULTIPLIER = 2;
const RECHECK_INTERVAL_MS = 5 * 60_000;   // 5 min re-check when inactive

// ── Scheduler state ─────────────────────────────────────────────────

export interface OverlaySchedulerMeta {
  scheduler_active: boolean;
  scheduler_running: boolean;
  next_attempt_at: string | null;
  consecutive_failures: number;
  last_scheduler_result: string | null;
  last_scheduler_error: string | null;
}

function schedulerStatePath(): string {
  return path.join(path.dirname(resolveConfigPath()), "overlay-scheduler-state.json");
}

export function readOverlaySchedulerMeta(): OverlaySchedulerMeta | null {
  try {
    return JSON.parse(fs.readFileSync(schedulerStatePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeSchedulerMeta(meta: Partial<OverlaySchedulerMeta>): void {
  const p = schedulerStatePath();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { /* fresh */ }
  const merged = { ...existing, ...meta };
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * Check if the overlay scheduler should be active. Exported for testing.
 * Checks: env escape hatch, machine setting, overlay state presence.
 */
export function checkSchedulerPreconditions(): { active: boolean; reason: string } {
  if (process.env.VERITY_OVERLAY_SCHEDULER === "off") {
    return { active: false, reason: "disabled_by_env" };
  }
  try {
    const settings = resolveTenantSettings();
    if (settings.public_overlay_sync !== "pull") {
      return { active: false, reason: `public_overlay_sync=${settings.public_overlay_sync}` };
    }
  } catch {
    return { active: false, reason: "settings_unavailable" };
  }
  if (!loadOverlayState()) {
    return { active: false, reason: "overlay_state_missing" };
  }
  return { active: true, reason: "ready" };
}

function nextAttemptAt(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function computeBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, Math.max(0, consecutiveFailures - 1)),
    MAX_BACKOFF_MS,
  );
}

interface SchedulerTickOutcome {
  ran: boolean;
  result: "inactive" | "success" | "failure" | "exception";
  error?: string;
  consecutive_failures: number;
  next_delay_ms: number;
  meta: Partial<OverlaySchedulerMeta>;
}

async function executeSchedulerTick(
  sqlConn: SqlTag,
  consecutiveFailures: number,
): Promise<SchedulerTickOutcome> {
  const preconds = checkSchedulerPreconditions();
  if (!preconds.active) {
    return {
      ran: false,
      result: "inactive",
      consecutive_failures: consecutiveFailures,
      next_delay_ms: RECHECK_INTERVAL_MS,
      meta: {
        scheduler_active: false,
        scheduler_running: false,
        next_attempt_at: nextAttemptAt(RECHECK_INTERVAL_MS),
        last_scheduler_result: "inactive",
      },
    };
  }

  writeSchedulerMeta({ scheduler_running: true, scheduler_active: true });

  try {
    const result = await pullAndImportOverlays(sqlConn, { limit: 50, maxPages: 5 });
    if (result.ok) {
      return {
        ran: true,
        result: "success",
        consecutive_failures: 0,
        next_delay_ms: BASE_INTERVAL_MS,
        meta: {
          scheduler_active: true,
          scheduler_running: false,
          consecutive_failures: 0,
          next_attempt_at: nextAttemptAt(BASE_INTERVAL_MS),
          last_scheduler_result: result.items_imported > 0
            ? `success: ${result.items_imported} items imported`
            : "success: no new items",
          last_scheduler_error: null,
        },
      };
    }

    const newFailures = consecutiveFailures + 1;
    const backoffMs = computeBackoffMs(newFailures);
    return {
      ran: true,
      result: "failure",
      error: result.error,
      consecutive_failures: newFailures,
      next_delay_ms: backoffMs,
      meta: {
        scheduler_active: true,
        scheduler_running: false,
        consecutive_failures: newFailures,
        next_attempt_at: nextAttemptAt(backoffMs),
        last_scheduler_result: "failure",
        last_scheduler_error: result.error || "unknown error",
      },
    };
  } catch (e) {
    const newFailures = consecutiveFailures + 1;
    const backoffMs = computeBackoffMs(newFailures);
    return {
      ran: true,
      result: "exception",
      error: (e as Error).message,
      consecutive_failures: newFailures,
      next_delay_ms: backoffMs,
      meta: {
        scheduler_active: true,
        scheduler_running: false,
        consecutive_failures: newFailures,
        next_attempt_at: nextAttemptAt(backoffMs),
        last_scheduler_result: "exception",
        last_scheduler_error: (e as Error).message,
      },
    };
  }
}

/**
 * Run one scheduler tick deterministically. Exported for testing.
 * Checks preconditions, calls pullAndImportOverlays if active,
 * records success/failure metadata, and returns the outcome.
 * Does NOT schedule a next tick or interact with timers.
 */
export async function runSchedulerTick(
  sqlConn: SqlTag,
): Promise<{ ran: boolean; result?: string; error?: string; consecutive_failures: number }> {
  let consecutiveFailures = 0;
  try {
    const existing = readOverlaySchedulerMeta();
    consecutiveFailures = existing?.consecutive_failures || 0;
  } catch { /* */ }

  const outcome = await executeSchedulerTick(sqlConn, consecutiveFailures);
  writeSchedulerMeta(outcome.meta);
  return {
    ran: outcome.ran,
    result: outcome.result,
    error: outcome.error,
    consecutive_failures: outcome.consecutive_failures,
  };
}

// ── Scheduler handle ────────────────────────────────────────────────

export interface OverlaySchedulerHandle {
  stop: () => void;
}

// ── Main ────────────────────────────────────────────────────────────

export function startOverlayScheduler(sql: SqlTag): OverlaySchedulerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;
  let nextTickAt = 0;
  let backoffUntil = 0;

  function scheduleAt(delayMs: number): void {
    if (timer) clearTimeout(timer);
    nextTickAt = Date.now() + delayMs;
    timer = setTimeout(() => { tick().catch(() => {}); }, delayMs);
  }

  async function tick(): Promise<void> {
    if (stopped || running) return;

    running = true;
    try {
      const outcome = await executeSchedulerTick(sql, consecutiveFailures);
      consecutiveFailures = outcome.consecutive_failures;
      if (outcome.result !== "inactive" && outcome.consecutive_failures > 0) {
        backoffUntil = Date.now() + outcome.next_delay_ms;
      } else {
        backoffUntil = 0;
      }
      writeSchedulerMeta(outcome.meta);
      scheduleAt(outcome.next_delay_ms);
    } finally {
      running = false;
    }
  }

  // Initial schedule: startup delay then first tick
  const initialDelay = STARTUP_DELAY_MS;
  writeSchedulerMeta({
    scheduler_active: false,
    scheduler_running: false,
    consecutive_failures: 0,
    next_attempt_at: nextAttemptAt(initialDelay),
    last_scheduler_result: "startup_pending",
    last_scheduler_error: null,
  });
  scheduleAt(initialDelay);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      writeSchedulerMeta({ scheduler_active: false, scheduler_running: false, next_attempt_at: null });
    },
  };
}
