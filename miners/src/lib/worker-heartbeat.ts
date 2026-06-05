import { hostname } from "node:os";

export type WorkerHeartbeatStatus = "starting" | "running" | "idle" | "idle_off_hours" | "stopping" | "stopped" | "error";

type WorkerHeartbeatOptions = {
  sql: any;
  workerName: string;
  role: string;
  mode?: string | null;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  metadata?: Record<string, unknown>;
};

type WorkerHeartbeatUpdate = {
  status?: WorkerHeartbeatStatus;
  metadata?: Record<string, unknown>;
  error?: string | null;
  stopped?: boolean;
};

export type WorkerHeartbeatHandle = {
  instanceId: string;
  beat: (update?: WorkerHeartbeatUpdate) => Promise<void>;
  stop: (update?: Omit<WorkerHeartbeatUpdate, "stopped">) => Promise<void>;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const RETENTION_DAYS = 7;

function trimError(error: unknown): string | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function closeDeadWorkerHeartbeats(sql: any): Promise<number> {
  const rows = await sql`
    SELECT worker_name, instance_id, pid
    FROM worker_heartbeats
    WHERE stopped_at IS NULL
  `;
  let closed = 0;
  for (const row of rows) {
    const pid = parseInt(row.pid || 0);
    if (pidAlive(pid)) continue;
    await sql`
      UPDATE worker_heartbeats
      SET status = 'stopped',
        stopped_at = now(),
        updated_at = now(),
        last_error = COALESCE(last_error, 'closed by dead-heartbeat sweep')
      WHERE worker_name = ${row.worker_name}
        AND instance_id = ${row.instance_id}
        AND stopped_at IS NULL
    `;
    closed++;
  }
  return closed;
}

export function startWorkerHeartbeat(options: WorkerHeartbeatOptions): WorkerHeartbeatHandle {
  const sql = options.sql;
  const intervalMs = Math.max(1_000, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const staleAfterMs = Math.max(intervalMs * 2, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const host = hostname();
  const instanceId = `${host}:${process.pid}:${Date.now()}`;
  let metadata = {
    ...(options.metadata || {}),
    supervisor_session: process.env.VERITY_SUPERVISOR_SESSION || null,
  } as Record<string, unknown>;
  let status: WorkerHeartbeatStatus = "running";
  let lastError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let pending: Promise<void> | null = null;

  async function cleanupOldRows(): Promise<void> {
    await sql`
      DELETE FROM worker_heartbeats
      WHERE (
        stopped_at IS NOT NULL
        AND stopped_at < now() - (${RETENTION_DAYS} * interval '1 day')
      ) OR (
        stopped_at IS NULL
        AND last_heartbeat < now() - (${RETENTION_DAYS} * interval '1 day')
      )
    `;
  }

  async function write(update?: WorkerHeartbeatUpdate): Promise<void> {
    if (closed) return;
    if (update?.status) status = update.status;
    if (update?.metadata) metadata = { ...metadata, ...update.metadata };
    if (Object.prototype.hasOwnProperty.call(update || {}, "error")) {
      lastError = trimError(update?.error);
    }

    await sql`
      INSERT INTO worker_heartbeats (
        worker_name, instance_id, role, status, pid, hostname, mode, supervisor_session,
        heartbeat_interval_ms, stale_after_ms, metadata, last_error,
        started_at, last_heartbeat, stopped_at, updated_at
      )
      VALUES (
        ${options.workerName},
        ${instanceId},
        ${options.role},
        ${status},
        ${process.pid},
        ${host},
        ${options.mode ?? null},
        ${process.env.VERITY_SUPERVISOR_SESSION || null},
        ${intervalMs},
        ${staleAfterMs},
        ${sql.json(metadata)},
        ${lastError},
        COALESCE(
          (
            SELECT started_at
            FROM worker_heartbeats
            WHERE worker_name = ${options.workerName}
              AND instance_id = ${instanceId}
          ),
          now()
        ),
        now(),
        ${update?.stopped ? new Date().toISOString() : null},
        now()
      )
      ON CONFLICT (worker_name, instance_id) DO UPDATE SET
        status = EXCLUDED.status,
        pid = EXCLUDED.pid,
        hostname = EXCLUDED.hostname,
        mode = EXCLUDED.mode,
        supervisor_session = EXCLUDED.supervisor_session,
        heartbeat_interval_ms = EXCLUDED.heartbeat_interval_ms,
        stale_after_ms = EXCLUDED.stale_after_ms,
        metadata = EXCLUDED.metadata,
        last_error = EXCLUDED.last_error,
        last_heartbeat = now(),
        stopped_at = EXCLUDED.stopped_at,
        updated_at = now()
    `;
  }

  function enqueue(update?: WorkerHeartbeatUpdate): Promise<void> {
    pending = (pending || Promise.resolve())
      .then(() => write(update))
      .catch((error) => {
        console.error(`[heartbeat:${options.workerName}] ${trimError(error)}`);
      });
    return pending;
  }

  void cleanupOldRows();
  void enqueue({ status: "running" });

  timer = setInterval(() => {
    void enqueue({ status });
  }, intervalMs);

  return {
    instanceId,
    beat: async (update?: WorkerHeartbeatUpdate) => {
      await enqueue(update);
    },
    stop: async (update?: Omit<WorkerHeartbeatUpdate, "stopped">) => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await enqueue({
        status: update?.status || "stopped",
        metadata: update?.metadata,
        error: update?.error,
        stopped: true,
      });
      await pending;
    },
  };
}
