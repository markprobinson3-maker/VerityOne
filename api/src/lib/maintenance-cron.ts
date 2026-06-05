/**
 * Tenant-default in-api maintenance cron.
 *
 * Runs a lightweight supercron T1 pass on an hourly interval inside the api
 * process. The startup tick fires ~5 seconds after HTTP listener becomes
 * ready (deterministic, no jitter) so `vo doctor` and `/ops/runtime` against
 * a fresh tenant-default install always find a maintenance-cron heartbeat
 * within ~10 seconds of boot. Subsequent ticks run every 60 minutes with
 * ±5 min jitter.
 *
 * Per docs/VO-RUNTIME-PROFILES.md:
 *   - tenant-default only (the full profile uses supercron --watch under
 *     the runtime-supervisor instead)
 *   - T1 only: SQL-only tier, no LLM, no vector work
 *   - writes a `maintenance-cron` heartbeat row every tick (startup + interval)
 *   - only one pass at a time (guard flag)
 *   - on error: logs + error heartbeat, does NOT crash the api process
 *
 * Implementation: spawns `bun run miners/src/supercron.ts --tier 1` as a
 * short-lived child. This avoids coupling the api process to supercron's
 * imports and gives us process-level isolation (a crashing T1 pass cannot
 * take down the api). The child's output is captured and discarded; the
 * tick's success/failure is observed via the child exit code.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type postgres from "postgres";
import { resolveTenantSettings } from "./runtime-profile";
import { readTenantDefaultSupercronEnabled } from "./supercron-kill-switch";

const WORKER_NAME = "maintenance-cron";
const TREND_WORKER_NAME = "trend-maintenance-cron";
const ROLE = "maintenance";
const MODE = "cron";

const STARTUP_TICK_DELAY_MS = 5_000; // ~5s after HTTP ready
const TREND_STARTUP_TICK_DELAY_MS = STARTUP_TICK_DELAY_MS + 1_000;
const INTERVAL_BASE_MS = 60 * 60 * 1000; // 60 min
const INTERVAL_JITTER_MS = 5 * 60 * 1000; // ±5 min
const TICK_TIMEOUT_MS = 15 * 60 * 1000; // 15 min hard cap per tick
const TREND_INTERVAL_BASE_MS = 10 * 60 * 1000; // 10 min
const TREND_INTERVAL_JITTER_MS = 2 * 60 * 1000; // ±2 min
const TREND_TICK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard cap per tick
const T1_KILL_SWITCH_POLL_MS = 5_000;

// heartbeat_interval_ms / stale_after_ms columns have CHECK > 0 — the
// heartbeat is logical ("how often should this worker beat") and for a cron
// that beats once an hour we advertise the interval + stale threshold the
// ops/runtime handler compares against.
const HEARTBEAT_INTERVAL_ADVERTISED_MS = INTERVAL_BASE_MS;
const HEARTBEAT_STALE_AFTER_ADVERTISED_MS = 90 * 60 * 1000; // 90 min (matches /ops/runtime warning)
const TREND_HEARTBEAT_INTERVAL_ADVERTISED_MS = TREND_INTERVAL_BASE_MS;
const TREND_HEARTBEAT_STALE_AFTER_ADVERTISED_MS = 30 * 60 * 1000;

const HOST = hostname();
const INSTANCE_ID = `${HOST}:${process.pid}:maintenance-cron`;
const TREND_INSTANCE_ID = `${HOST}:${process.pid}:trend-maintenance-cron`;

interface MaintenanceCronHandle {
  stop(): void;
}

function pickIntervalMs(): number {
  const jitter = Math.floor((Math.random() * 2 - 1) * INTERVAL_JITTER_MS);
  return INTERVAL_BASE_MS + jitter;
}

function pickTrendIntervalMs(baseMs = TREND_INTERVAL_BASE_MS): number {
  const jitter = Math.floor((Math.random() * 2 - 1) * TREND_INTERVAL_JITTER_MS);
  return Math.max(60_000, baseMs + jitter);
}

function writeHeartbeat(
  sql: ReturnType<typeof postgres>,
  workerName: string,
  instanceId: string,
  intervalMs: number,
  staleAfterMs: number,
  status: "starting" | "running" | "idle" | "error",
  metadata: Record<string, unknown>,
  lastError: string | null,
  stopped: boolean,
): Promise<void> {
  // Direct insert-or-update — mirrors miners/src/lib/worker-heartbeat.ts
  // persistent path but without the continuous interval machinery. The
  // CHECK constraint on heartbeat_interval_ms/stale_after_ms forbids zero,
  // so we advertise the logical cron interval even though the cron isn't
  // running continuously.
  return sql`
    INSERT INTO worker_heartbeats (
      worker_name, instance_id, role, status, pid, hostname, mode,
      supervisor_session, heartbeat_interval_ms, stale_after_ms, metadata,
      last_error, started_at, last_heartbeat, stopped_at, updated_at
    )
    VALUES (
      ${workerName}, ${instanceId}, ${ROLE}, ${status}, ${process.pid}, ${HOST}, ${MODE},
      ${process.env.VERITY_SUPERVISOR_SESSION || null},
      ${intervalMs}, ${staleAfterMs},
      ${sql.json(metadata as any)}, ${lastError},
      now(), now(), ${stopped ? sql`now()` : null}, now()
    )
    ON CONFLICT (worker_name, instance_id) DO UPDATE SET
      status = EXCLUDED.status,
      metadata = EXCLUDED.metadata,
      last_error = EXCLUDED.last_error,
      last_heartbeat = now(),
      stopped_at = CASE WHEN ${stopped} THEN now() ELSE worker_heartbeats.stopped_at END,
      updated_at = now()
  `.then(() => undefined);
}

/**
 * Spawn a short-lived supercron child.
 * Resolves to the exit code and captures stderr for the heartbeat's
 * last_error field on non-zero exits.
 */
function runSupercronChild(
  repoRoot: string,
  args: string[],
  timeoutMs: number,
  shouldTerminate?: () => Promise<string | null>,
): Promise<{ exitCode: number; stderrTail: string; terminatedReason: string | null }> {
  return new Promise((resolvePromise) => {
    const child: ChildProcess = spawn(
      "bun",
      args,
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Prevent the child from trying to start its own maintenance cron
          // (defensive — supercron doesn't, but an explicit no-recurse marker
          // protects against future entrypoint drift).
          VERITY_MAINTENANCE_CRON_CHILD: "1",
        },
      },
    );

    const stderrChunks: Buffer[] = [];
    let terminatedReason: string | null = null;
    let checkingTerminate = false;
    let terminationSignaled = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      // Cap captured stderr at 16 KB so a chatty pass can't balloon memory
      if (stderrChunks.reduce((n, b) => n + b.length, 0) > 16 * 1024) {
        stderrChunks.length = 0;
        stderrChunks.push(Buffer.from("...stderr truncated..."));
      }
    });
    // Consume stdout so the pipe doesn't back-pressure.
    child.stdout?.on("data", () => undefined);

    const killTimer = setTimeout(() => {
      terminatedReason = "supercron_child_timeout";
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const terminatePoll = shouldTerminate
      ? setInterval(() => {
          if (checkingTerminate) return;
          checkingTerminate = true;
          void (async () => {
            try {
              const reason = await shouldTerminate();
              if (reason && !terminationSignaled && child.exitCode == null && child.signalCode == null) {
                terminationSignaled = true;
                terminatedReason = reason;
                stderrChunks.push(Buffer.from(reason));
                child.kill("SIGTERM");
              }
            } catch {
              if (!terminationSignaled && child.exitCode == null && child.signalCode == null) {
                terminationSignaled = true;
                terminatedReason = "supercron_tenant_default_gate_unavailable";
                stderrChunks.push(Buffer.from(terminatedReason));
                child.kill("SIGTERM");
              }
            } finally {
              checkingTerminate = false;
            }
          })();
        }, T1_KILL_SWITCH_POLL_MS)
      : null;
    terminatePoll?.unref?.();

    const childEvents = child as unknown as {
      once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
      once(event: "error", listener: (err: Error) => void): void;
    };

    childEvents.once("exit", (code) => {
      clearTimeout(killTimer);
      if (terminatePoll) clearInterval(terminatePoll);
      const stderrTail = Buffer.concat(stderrChunks).toString("utf-8").slice(-400);
      resolvePromise({ exitCode: code ?? -1, stderrTail, terminatedReason });
    });

    childEvents.once("error", (err) => {
      clearTimeout(killTimer);
      if (terminatePoll) clearInterval(terminatePoll);
      resolvePromise({ exitCode: -1, stderrTail: `spawn error: ${err.message}`, terminatedReason });
    });
  });
}

function runT1Pass(
  repoRoot: string,
  sql: ReturnType<typeof postgres>,
): Promise<{ exitCode: number; stderrTail: string; terminatedReason: string | null }> {
  return runSupercronChild(
    repoRoot,
    ["run", "miners/src/supercron.ts", "--tier", "1"],
    TICK_TIMEOUT_MS,
    async () => {
      const gate = await readTenantDefaultSupercronEnabled(sql);
      return gate.enabled ? null : "supercron_tenant_default_disabled_mid_run";
    },
  );
}

function runTrendPass(repoRoot: string): Promise<{ exitCode: number; stderrTail: string; terminatedReason: string | null }> {
  return runSupercronChild(
    repoRoot,
    ["run", "miners/src/supercron.ts", "--only", "trend_maintenance", "--once"],
    TREND_TICK_TIMEOUT_MS,
  );
}

/**
 * Start the tenant-default maintenance cron. Returns a handle with a
 * `stop()` method for graceful shutdown hooks.
 *
 * The first (startup) tick fires `STARTUP_TICK_DELAY_MS` after this function
 * is called — callers MUST only invoke this after the HTTP listener is ready
 * to accept traffic, so `vo doctor` and `/ops/runtime` consumers see the
 * heartbeat inside their ~10s window.
 */
export function startMaintenanceCron(sql: ReturnType<typeof postgres>): MaintenanceCronHandle {
  const repoRoot = resolve(import.meta.dir, "..", "..", ".."); // api/src/lib → repo root

  let activeChild: "t1" | "trend" | null = null;
  let stopped = false;
  let nextTimer: NodeJS.Timeout | null = null;
  let nextTrendTimer: NodeJS.Timeout | null = null;

  // NOTE: intentionally NO pre-tick heartbeat write.
  //
  // Earlier drafts inserted a `status: "starting"` row here as a "safety
  // net" so /ops/runtime always saw a row. That masked the exact
  // "startup tick never fired" bug the design's uptime-based detection
  // branch in /ops/runtime was supposed to catch: if the first heartbeat
  // arrives before the tick runs, the absent-row branch stays cold
  // until the row ages past 90 min. The design's binding health model
  // relies on "api up >30s && no cron row → degraded", so we must let
  // the row be genuinely absent until the startup tick actually fires
  // and writes its own "running" heartbeat from inside tick() below.
  //
  // The startup tick fires ~5 seconds after this function is called,
  // which is well inside the 30-second startup grace window that
  // /ops/runtime uses for the degraded-signal threshold.

  async function writeT1Heartbeat(
    status: "starting" | "running" | "idle" | "error",
    metadata: Record<string, unknown>,
    lastError: string | null,
    stoppedRow: boolean,
  ): Promise<void> {
    return writeHeartbeat(
      sql,
      WORKER_NAME,
      INSTANCE_ID,
      HEARTBEAT_INTERVAL_ADVERTISED_MS,
      HEARTBEAT_STALE_AFTER_ADVERTISED_MS,
      status,
      metadata,
      lastError,
      stoppedRow,
    );
  }

  async function writeTrendHeartbeat(
    status: "starting" | "running" | "idle" | "error",
    metadata: Record<string, unknown>,
    lastError: string | null,
    stoppedRow: boolean,
  ): Promise<void> {
    return writeHeartbeat(
      sql,
      TREND_WORKER_NAME,
      TREND_INSTANCE_ID,
      TREND_HEARTBEAT_INTERVAL_ADVERTISED_MS,
      TREND_HEARTBEAT_STALE_AFTER_ADVERTISED_MS,
      status,
      metadata,
      lastError,
      stoppedRow,
    );
  }

  async function readTrendIntervalBaseMs(): Promise<number> {
    try {
      const [row] = await sql`
        SELECT value FROM graph_state
        WHERE key = 'reactor_revival.r5.trend_maintenance_interval_ms'
      `;
      const parsed = Number(row?.value);
      return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : TREND_INTERVAL_BASE_MS;
    } catch {
      return TREND_INTERVAL_BASE_MS;
    }
  }

  async function tick(reason: "startup" | "interval"): Promise<void> {
    if (stopped) return;
    if (activeChild) {
      console.error(`[maintenance-cron] skipping ${reason} tick — ${activeChild} pass still running`);
      await writeT1Heartbeat(
        "idle",
        { reason, skipped: "supercron_child_running", active_child: activeChild },
        null,
        false,
      ).catch(() => undefined);
      scheduleT1();
      return;
    }
    const startedAt = Date.now();
    activeChild = "t1";
    try {
      const gate = await readTenantDefaultSupercronEnabled(sql);
      if (!gate.enabled) {
        await writeT1Heartbeat(
          "idle",
          {
            reason,
            skipped: "supercron_tenant_default_disabled",
            switch_key: gate.key,
            switch_value: gate.value,
            checked_at: new Date(startedAt).toISOString(),
          },
          null,
          false,
        );
        console.log(
          `[maintenance-cron] skipping ${reason} tick — tenant-default supercron disabled via ${gate.key ?? "default"}`,
        );
        return;
      }

      await writeT1Heartbeat(
        "running",
        { reason, started_at: new Date(startedAt).toISOString() },
        null,
        false,
      );

      const { exitCode, stderrTail, terminatedReason } = await runT1Pass(repoRoot, sql);
      const durationMs = Date.now() - startedAt;
      if (stopped) return;

      if (terminatedReason === "supercron_tenant_default_disabled_mid_run") {
        await writeT1Heartbeat(
          "idle",
          {
            reason,
            stopped: "supercron_tenant_default_disabled_mid_run",
            last_tick_started_at: new Date(startedAt).toISOString(),
            last_tick_duration_ms: durationMs,
            last_exit_code: exitCode,
          },
          null,
          false,
        );
        console.log(`[maintenance-cron] ${reason} tick stopped by tenant-default supercron kill switch (${durationMs}ms)`);
      } else if (exitCode === 0) {
        await writeT1Heartbeat(
          "idle",
          {
            reason,
            last_tick_started_at: new Date(startedAt).toISOString(),
            last_tick_duration_ms: durationMs,
            last_exit_code: 0,
          },
          null,
          false,
        );
        console.log(`[maintenance-cron] ${reason} tick ok (${durationMs}ms)`);
      } else {
        const errMsg = `supercron --tier 1 exited with code ${exitCode}${stderrTail ? `: ${stderrTail}` : ""}`;
        await writeT1Heartbeat(
          "error",
          {
            reason,
            last_tick_started_at: new Date(startedAt).toISOString(),
            last_tick_duration_ms: durationMs,
            last_exit_code: exitCode,
          },
          errMsg.slice(0, 500),
          false,
        );
        console.error(`[maintenance-cron] ${reason} tick FAILED (${durationMs}ms): ${errMsg}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        if (!stopped) {
          await writeT1Heartbeat(
            "error",
            { reason, error: message },
            message.slice(0, 500),
            false,
          );
        }
      } catch {
        /* heartbeat write itself failed — already logged */
      }
      console.error(`[maintenance-cron] ${reason} tick threw: ${message}`);
    } finally {
      activeChild = null;
      scheduleT1();
    }
  }

  async function trendTick(reason: "startup" | "interval"): Promise<void> {
    if (stopped) return;
    const settings = resolveTenantSettings();
    if (!settings.trends_enabled) {
      await writeTrendHeartbeat(
        "idle",
        { reason, disabled: true, checked_at: new Date().toISOString() },
        null,
        false,
      ).catch(() => undefined);
      await scheduleTrend();
      return;
    }
    if (activeChild) {
      console.error(`[maintenance-cron] skipping trend ${reason} tick — ${activeChild} pass still running`);
      await writeTrendHeartbeat(
        "idle",
        { reason, skipped: "supercron_child_running", active_child: activeChild },
        null,
        false,
      ).catch(() => undefined);
      await scheduleTrend();
      return;
    }
    activeChild = "trend";
    const startedAt = Date.now();
    try {
      await writeTrendHeartbeat(
        "running",
        { reason, started_at: new Date(startedAt).toISOString() },
        null,
        false,
      );

      const { exitCode, stderrTail } = await runTrendPass(repoRoot);
      const durationMs = Date.now() - startedAt;

      if (exitCode === 0) {
        await writeTrendHeartbeat(
          "idle",
          {
            reason,
            last_tick_started_at: new Date(startedAt).toISOString(),
            last_tick_duration_ms: durationMs,
            last_exit_code: 0,
          },
          null,
          false,
        );
        console.log(`[maintenance-cron] trend ${reason} tick ok (${durationMs}ms)`);
      } else {
        const errMsg = `supercron --only trend_maintenance --once exited with code ${exitCode}${stderrTail ? `: ${stderrTail}` : ""}`;
        await writeTrendHeartbeat(
          "error",
          {
            reason,
            last_tick_started_at: new Date(startedAt).toISOString(),
            last_tick_duration_ms: durationMs,
            last_exit_code: exitCode,
          },
          errMsg.slice(0, 500),
          false,
        );
        console.error(`[maintenance-cron] trend ${reason} tick FAILED (${durationMs}ms): ${errMsg}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await writeTrendHeartbeat(
          "error",
          { reason, error: message },
          message.slice(0, 500),
          false,
        );
      } catch {
        /* heartbeat write itself failed — already logged */
      }
      console.error(`[maintenance-cron] trend ${reason} tick threw: ${message}`);
    } finally {
      activeChild = null;
      await scheduleTrend();
    }
  }

  function scheduleT1(): void {
    if (stopped) return;
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      void tick("interval");
    }, pickIntervalMs());
    nextTimer.unref?.();
  }

  async function scheduleTrend(): Promise<void> {
    if (stopped) return;
    if (nextTrendTimer) clearTimeout(nextTrendTimer);
    const intervalMs = await readTrendIntervalBaseMs();
    nextTrendTimer = setTimeout(() => {
      void trendTick("interval");
    }, pickTrendIntervalMs(intervalMs));
    nextTrendTimer.unref?.();
  }

  // Startup tick — fires deterministically ~5s after this function is called.
  const startupTimer = setTimeout(() => {
    void tick("startup");
  }, STARTUP_TICK_DELAY_MS);
  startupTimer.unref?.();

  const trendStartupTimer = setTimeout(() => {
    void trendTick("startup");
  }, TREND_STARTUP_TICK_DELAY_MS);
  trendStartupTimer.unref?.();

  return {
    stop(): void {
      stopped = true;
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
      if (nextTrendTimer) {
        clearTimeout(nextTrendTimer);
        nextTrendTimer = null;
      }
      clearTimeout(startupTimer);
      clearTimeout(trendStartupTimer);
      writeT1Heartbeat("idle", { reason: "stopped" }, null, true).catch(() => undefined);
      writeTrendHeartbeat("idle", { reason: "stopped" }, null, true).catch(() => undefined);
    },
  };
}
