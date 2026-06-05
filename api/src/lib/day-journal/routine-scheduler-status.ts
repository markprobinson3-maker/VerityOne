export const DAY_JOURNAL_ROUTINE_SCHEDULER_WORKER_NAME = "day-journal-routine-scheduler";

export type DayJournalRoutineSchedulerStatus =
  | "active"
  | "disabled"
  | "stale"
  | "stopped"
  | "error"
  | "missing"
  | "unavailable";

export type DayJournalRoutineSchedulerStatusSummary = {
  worker_name: typeof DAY_JOURNAL_ROUTINE_SCHEDULER_WORKER_NAME;
  status: DayJournalRoutineSchedulerStatus;
  raw_status: string | null;
  last_heartbeat_at: string | null;
  heartbeat_interval_ms: number | null;
  stale_after_ms: number | null;
  last_error: string | null;
  instance_status_counts?: Partial<Record<DayJournalRoutineSchedulerStatus, number>>;
};

type WorkerHeartbeatRow = {
  status?: unknown;
  last_heartbeat?: unknown;
  heartbeat_interval_ms?: unknown;
  stale_after_ms?: unknown;
  last_error?: unknown;
  metadata?: unknown;
};

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestampIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonObjectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function summarizeDayJournalRoutineSchedulerHeartbeat(
  row: WorkerHeartbeatRow | null | undefined,
  nowMs = Date.now(),
): DayJournalRoutineSchedulerStatusSummary {
  const lastHeartbeatAt = timestampIso(row?.last_heartbeat);
  const staleAfterMs = numberValue(row?.stale_after_ms);
  const rawStatus = typeof row?.status === "string" ? row.status : null;
  const metadata = jsonObjectValue(row?.metadata);
  const disabledByEnv = rawStatus === "stopped" && metadata.phase === "scheduler_disabled";
  const heartbeatAgeMs = lastHeartbeatAt ? nowMs - Date.parse(lastHeartbeatAt) : null;
  const stale = heartbeatAgeMs === null || staleAfterMs === null || heartbeatAgeMs > staleAfterMs;
  let status: DayJournalRoutineSchedulerStatus = "missing";
  if (row) {
    if (rawStatus === "error") status = "error";
    else if (disabledByEnv) status = "disabled";
    else if (rawStatus === "stopped") status = "stopped";
    else if (stale) status = "stale";
    else status = "active";
  }
  return {
    worker_name: DAY_JOURNAL_ROUTINE_SCHEDULER_WORKER_NAME,
    status,
    raw_status: rawStatus,
    last_heartbeat_at: lastHeartbeatAt,
    heartbeat_interval_ms: numberValue(row?.heartbeat_interval_ms),
    stale_after_ms: staleAfterMs,
    last_error: typeof row?.last_error === "string" && row.last_error ? row.last_error : null,
  };
}

function heartbeatSortValue(summary: DayJournalRoutineSchedulerStatusSummary): number {
  if (!summary.last_heartbeat_at) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(summary.last_heartbeat_at);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function mostRecentHeartbeat(
  summaries: DayJournalRoutineSchedulerStatusSummary[],
): DayJournalRoutineSchedulerStatusSummary {
  return summaries
    .slice()
    .sort((a, b) => heartbeatSortValue(b) - heartbeatSortValue(a))[0];
}

function instanceStatusCounts(
  summaries: DayJournalRoutineSchedulerStatusSummary[],
): Partial<Record<DayJournalRoutineSchedulerStatus, number>> {
  const counts: Partial<Record<DayJournalRoutineSchedulerStatus, number>> = {};
  for (const summary of summaries) {
    counts[summary.status] = (counts[summary.status] || 0) + 1;
  }
  return counts;
}

function rollupCandidateSummaries(
  summaries: DayJournalRoutineSchedulerStatusSummary[],
): DayJournalRoutineSchedulerStatusSummary[] {
  for (const status of ["error", "stopped", "stale", "missing"] as const) {
    const matches = summaries.filter((summary) => summary.status === status);
    if (matches.length > 0) return matches;
  }
  const active = summaries.filter((summary) => summary.status === "active");
  if (active.length > 0) return active;
  return summaries;
}

export function summarizeDayJournalRoutineSchedulerHeartbeats(
  rows: WorkerHeartbeatRow[] | null | undefined,
  nowMs = Date.now(),
): DayJournalRoutineSchedulerStatusSummary {
  if (!rows || rows.length === 0) return summarizeDayJournalRoutineSchedulerHeartbeat(null, nowMs);
  const summaries = rows.map((row) => summarizeDayJournalRoutineSchedulerHeartbeat(row, nowMs));
  const counts = instanceStatusCounts(summaries);
  return { ...mostRecentHeartbeat(rollupCandidateSummaries(summaries)), instance_status_counts: counts };
}

export async function readDayJournalRoutineSchedulerStatus(
  sql: any,
  nowMs = Date.now(),
): Promise<DayJournalRoutineSchedulerStatusSummary> {
  try {
    const rows = await sql`
      SELECT status, last_heartbeat, heartbeat_interval_ms, stale_after_ms, last_error, metadata
      FROM worker_heartbeats
      WHERE worker_name = ${DAY_JOURNAL_ROUTINE_SCHEDULER_WORKER_NAME}
      ORDER BY last_heartbeat DESC NULLS LAST
      LIMIT 20
    `;
    return summarizeDayJournalRoutineSchedulerHeartbeats(rows, nowMs);
  } catch {
    return {
      worker_name: DAY_JOURNAL_ROUTINE_SCHEDULER_WORKER_NAME,
      status: "unavailable",
      raw_status: null,
      last_heartbeat_at: null,
      heartbeat_interval_ms: null,
      stale_after_ms: null,
      last_error: null,
    };
  }
}
