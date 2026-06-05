/**
 * Schedule run history (VO-ROUTINE-RUN-HISTORY-PR-1)
 *
 * Records a single run outcome in vi_schedule_runs and prunes the global
 * history to RUN_HISTORY_LIMIT rows. Retention is GLOBAL, not per-schedule:
 * latest 50 runs total, newest first. Keeps the hosted mirror payload
 * bounded regardless of schedule count.
 *
 * This is a summary-only record. It does NOT store raw adapter output,
 * stdout/stderr, or atom payloads. Error text is truncated to 500 chars
 * to match the existing vi_schedules.last_error convention.
 */
import type { Sql } from "postgres";

export type TriggerKind = "scheduler" | "manual" | "remote_command";

export interface ScheduleRunRecord {
  schedule_id: number;
  adapter_name: string;
  trigger_kind: TriggerKind;
  status: "success" | "error";
  atoms_count?: number | null;
  cost_usd?: number | null;
  error?: string | null;
  source_input?: string | null;
  started_at: Date;
  completed_at?: Date | null;
  duration_ms?: number | null;
}

export const RUN_HISTORY_LIMIT = 50;
export const ERROR_MAX_LEN = 500;

/**
 * Insert one run summary and prune back to the global 50-row cap.
 * Returns the inserted row id and the count of pruned rows (for tests).
 * Callers should not throw if this fails — history is best-effort and
 * must never break the scheduler's primary execution path.
 */
export async function recordScheduleRun(
  sql: Sql<any>,
  rec: ScheduleRunRecord,
): Promise<{ id: number; pruned: number }> {
  const errorTrimmed = rec.error ? rec.error.slice(0, ERROR_MAX_LEN) : null;
  const [row] = await sql`
    INSERT INTO vi_schedule_runs (
      schedule_id, adapter_name, trigger_kind, status,
      atoms_count, cost_usd, error, source_input,
      started_at, completed_at, duration_ms
    ) VALUES (
      ${rec.schedule_id}, ${rec.adapter_name}, ${rec.trigger_kind}, ${rec.status},
      ${rec.atoms_count ?? null}, ${rec.cost_usd ?? null},
      ${errorTrimmed}, ${rec.source_input ?? null},
      ${rec.started_at}, ${rec.completed_at ?? null}, ${rec.duration_ms ?? null}
    )
    RETURNING id
  `;

  // Global retention cap — newest first by started_at then id (tiebreaker).
  const pruned = await sql`
    DELETE FROM vi_schedule_runs
    WHERE id NOT IN (
      SELECT id FROM vi_schedule_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ${RUN_HISTORY_LIMIT}
    )
    RETURNING id
  `;

  return { id: row.id, pruned: pruned.length };
}

/**
 * Load the latest run summaries, newest first. Used by both
 * /dashboard/routines (local) and the sync-exporter governance snapshot
 * (mirrored to hosted). Limit defaults to the global retention cap.
 */
export async function listRecentScheduleRuns(
  sql: Sql<any>,
  limit: number = RUN_HISTORY_LIMIT,
): Promise<Array<Record<string, any>>> {
  const safeLimit = Math.max(1, Math.min(RUN_HISTORY_LIMIT, Math.floor(limit)));
  const rows = await sql`
    SELECT id, schedule_id, adapter_name, trigger_kind, status,
           atoms_count, cost_usd, error, source_input,
           started_at, completed_at, duration_ms
    FROM vi_schedule_runs
    ORDER BY started_at DESC, id DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((r: any) => ({
    id: r.id,
    schedule_id: r.schedule_id,
    adapter_name: r.adapter_name,
    trigger_kind: r.trigger_kind,
    status: r.status,
    atoms_count: r.atoms_count,
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    error: r.error,
    source_input: r.source_input,
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    completed_at: r.completed_at instanceof Date ? r.completed_at.toISOString() : r.completed_at,
    duration_ms: r.duration_ms,
  }));
}
