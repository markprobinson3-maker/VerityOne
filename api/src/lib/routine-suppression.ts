/**
 * Operator routine suppression (Operator-Apply ladder, OA6).
 *
 * Lets an operator transiently MUTE a noisy recurring routine (a SuperCron pass) for a window.
 * SuperCron checks isRoutineSuppressed before running a pass and skips a suppressed one; the
 * check is wired FAIL-OPEN on the caller side (a check failure runs the pass), so this can never
 * halt the cron. DEFAULT-SAFE: with no suppression rows, behaviour is unchanged.
 *
 * Shared between workspaces: the /ops write/read surface (api) and SuperCron's pass dispatcher
 * (miners) both import this.
 */

import type { Sql } from "postgres";

const MAX_SUPPRESSION_HOURS = 24 * 30; // 30 days

export interface RoutineSuppressionRow {
  id: number;
  tenant_id: string | null;
  routine_name: string;
  suppressed_until: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}

/**
 * True iff an ACTIVE suppression covers (routineName, tenantId): suppressed_until is in the
 * future, the routine matches, and the row is either global (tenant_id IS NULL) or scoped to
 * this tenant. A global suppression mutes the routine for every tenant.
 */
export async function isRoutineSuppressed(
  sql: Sql,
  opts: { routineName: string; tenantId?: string | null },
): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM supercron_routine_suppression
    WHERE routine_name = ${opts.routineName}
      AND suppressed_until > now()
      AND (tenant_id IS NULL OR tenant_id = ${opts.tenantId ?? null})
    LIMIT 1
  `;
  return Boolean(row);
}

/** Create a suppression that mutes `routineName` until now + durationHours (clamped [1, 30d]). */
export async function createRoutineSuppression(
  sql: Sql,
  opts: { routineName: string; tenantId?: string | null; durationHours: number; reason?: string | null; createdBy: string },
): Promise<RoutineSuppressionRow> {
  const raw = Number(opts.durationHours);
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_SUPPRESSION_HOURS) : 1;
  const [row] = await sql`
    INSERT INTO supercron_routine_suppression (tenant_id, routine_name, suppressed_until, reason, created_by)
    VALUES (${opts.tenantId ?? null}, ${opts.routineName}, now() + make_interval(hours => ${hours}), ${opts.reason ?? null}, ${opts.createdBy})
    RETURNING id, tenant_id, routine_name, suppressed_until::text AS suppressed_until, reason, created_by, created_at::text AS created_at
  `;
  const id = Number((row as any).id);
  // Fail fast rather than silently lose precision if the BIGSERIAL ever exceeds 2^53.
  if (!Number.isSafeInteger(id)) throw new Error("routine suppression id exceeds safe integer range");
  return { ...(row as any), id } as RoutineSuppressionRow;
}

/** List every currently-active suppression (suppressed_until in the future). */
export async function listActiveSuppressions(sql: Sql): Promise<RoutineSuppressionRow[]> {
  const rows = await sql`
    SELECT id, tenant_id, routine_name, suppressed_until::text AS suppressed_until, reason, created_by, created_at::text AS created_at
    FROM supercron_routine_suppression
    WHERE suppressed_until > now()
    ORDER BY suppressed_until DESC
  `;
  return (rows as any[]).map((r) => {
    const id = Number(r.id);
    if (!Number.isSafeInteger(id)) throw new Error("routine suppression id exceeds safe integer range");
    return { ...r, id };
  });
}

/** Un-suppress: expire an active suppression NOW. Idempotent — only an active row is affected;
 *  returns false if there was no active suppression with this id. */
export async function expireRoutineSuppression(sql: Sql, opts: { id: number }): Promise<boolean> {
  const rows = await sql`
    UPDATE supercron_routine_suppression SET suppressed_until = now()
    WHERE id = ${opts.id} AND suppressed_until > now()
    RETURNING id
  `;
  return (rows as any[]).length > 0;
}
