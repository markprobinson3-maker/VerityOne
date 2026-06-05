/**
 * Federation activity retention helper —
 * VO-FEDERATION-ACTIVITY-DASHBOARD-PR-1 (rung 7b impl).
 *
 * Invoked by the supercron T1 pass `federation_activity_retention`.
 * Deletes rows from `federation_activity` older than the install-wide
 * retention window. Defaults to 30 days, clamped to `[30, 180]` per the
 * rung-6 locked policy.
 *
 * Rung 7b retention is configurable via one install-wide `graph_state`
 * key, matching the existing `lifecycle_dormancy_age_days` pattern (see
 * `db/reactor-schema.sql:440`). Operators can set
 * `federation_activity_retention_days` in `graph_state`; the clamp
 * ensures no one can configure unbounded retention or a window shorter
 * than the rung-6 floor. Per-tenant retention is deliberately deferred
 * in the rung-6 amendment.
 *
 * Uses `idx_fa_ts_retention` (single-column index on `ts`) for an
 * index-scan DELETE regardless of tenant count.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;

export const GRAPH_STATE_KEY = "federation_activity_retention_days";

/**
 * Bound the retention DELETE so a large backlog cannot run as one unbounded,
 * lock-holding statement. Each batch is its own short transaction with a
 * lock/statement budget — mirroring the batch-size pattern proven in
 * oauth-client-retention.ts. The iteration cap is a runaway backstop;
 * RETENTION_MAX_BATCHES * RETENTION_DELETE_BATCH_SIZE rows is the most a
 * single run will delete (the next cron pass continues any remainder).
 */
export const RETENTION_DELETE_BATCH_SIZE = 5000;
export const RETENTION_MAX_BATCHES = 200;
export const RETENTION_LOCK_TIMEOUT = "30s";
export const RETENTION_STATEMENT_TIMEOUT = "60s";

export interface RetentionResult {
  deleted: number;
  retention_days: number;
  dry_run: boolean;
  disabled: boolean;
}

/**
 * Read the install-wide retention window (in days) from `graph_state`.
 * Falls back to `DEFAULT_RETENTION_DAYS` when the key is absent or malformed.
 * Clamps to `[MIN_RETENTION_DAYS, MAX_RETENTION_DAYS]` so a typo
 * cannot produce an unbounded-retention or too-short retention
 * configuration.
 */
export async function readInstallRetentionDays(sql: SqlTag): Promise<number> {
  let raw: unknown = null;
  try {
    const [row] = await sql`
      SELECT value FROM graph_state WHERE key = ${GRAPH_STATE_KEY}
    `;
    raw = row?.value;
  } catch (err: any) {
    // graph_state may not exist in a fresh install (relation_does_not_exist,
    // 42P01) — fall back to the default. Re-throw anything else (a real
    // connectivity / permission failure) so a transient error is NOT silently
    // masked as the default, which could otherwise delete more rows than the
    // operator's configured (higher) retention window intends.
    if (err?.code === "42P01") return DEFAULT_RETENTION_DAYS;
    throw err;
  }
  if (raw === null || raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (parsed > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return Math.floor(parsed);
}

/**
 * Run the retention DELETE. Honors `VERITY_FEDERATION_ACTIVITY_RETENTION=off`
 * (short-circuits to disabled) and `dryRun` (counts what would be
 * deleted without writing).
 */
export async function runFederationActivityRetention(
  sql: SqlTag,
  opts: { dryRun?: boolean } = {},
): Promise<RetentionResult> {
  if (process.env.VERITY_FEDERATION_ACTIVITY_RETENTION === "off") {
    return { deleted: 0, retention_days: 0, dry_run: false, disabled: true };
  }

  const retention_days = await readInstallRetentionDays(sql);
  const dry_run = opts.dryRun === true;

  if (dry_run) {
    const [row] = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM federation_activity
      WHERE ts < now() - (${retention_days}::int * interval '1 day')
    `;
    return {
      deleted: row?.cnt ?? 0,
      retention_days,
      dry_run: true,
      disabled: false,
    };
  }

  // Batched, lock-budgeted delete. A single unbounded DELETE over an aged /
  // high-volume federation_activity table holds row locks and WAL for an
  // arbitrary duration with no statement_timeout to bound it; batching with a
  // per-transaction lock/statement budget keeps each pass interruptible and
  // contention-friendly (it yields to live writers between batches).
  let deleted = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const removed = await sql.begin(async (tx: any) => {
      await tx`SET LOCAL lock_timeout = '30s'`;
      await tx`SET LOCAL statement_timeout = '60s'`;
      const [row] = await tx`
        WITH doomed AS (
          SELECT ctid
          FROM federation_activity
          WHERE ts < now() - (${retention_days}::int * interval '1 day')
          LIMIT ${RETENTION_DELETE_BATCH_SIZE}
        ),
        deleted AS (
          DELETE FROM federation_activity
          WHERE ctid IN (SELECT ctid FROM doomed)
          RETURNING id
        )
        SELECT COUNT(*)::int AS cnt FROM deleted
      `;
      return Number(row?.cnt ?? 0);
    });
    deleted += removed;
    // Last batch was short → the eligible set is exhausted for this run.
    if (removed < RETENTION_DELETE_BATCH_SIZE) break;
  }

  return {
    deleted,
    retention_days,
    dry_run: false,
    disabled: false,
  };
}
