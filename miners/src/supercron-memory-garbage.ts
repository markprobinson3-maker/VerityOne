/**
 * Audited tenant-memory garbage sweep (Memory-Health-Persistence PR 1).
 *
 * Replaces SuperCron's former SILENT `DELETE FROM nodes` of tenant memory (the
 * pass3 "3e" tenant-garbage pass) with two AUDITED, non-bypassing paths. No tenant
 * memory is ever silently mutated or hard-deleted again: every action writes an
 * audit row, and the only hard delete is the proven-garbage purge — itself audited.
 *
 *   (a) PURGE — proven-unrecoverable injection/fuzz garbage (markup/script/
 *       task-notification/UNION-SELECT prefixes). The plan permits a hard delete
 *       ONLY for "proven unrecoverable fuzz/security garbage", so we keep the
 *       delete but make it auditable: a durable memory_events row is written
 *       BEFORE the node is removed. F12 (lifecycle-audit-durability) dropped the
 *       memory_events→nodes cascading FK, so that audit row OUTLIVES the deletion
 *       as operator history. The registry row cascades away with the node. The
 *       event stays inside the canonical EventType vocabulary ('retracted'); the
 *       event_data records that the concrete action was a purge.
 *
 *   (b) ARCHIVE — too-short-but-NOT-proven-garbage (description below
 *       `minDescriptionChars`, no injection pattern). A terse memory is not proven
 *       unrecoverable, so it is ARCHIVED (recoverable), never hard-deleted. This
 *       routes through the canonical forgetMemory() helper, which moves the node
 *       (dormant_at + substance.status='archived'), the registry (status='archived'),
 *       and the audit event ('archived') ATOMICALLY — the exact contract the
 *       lifecycle-atomicity invariants require.
 *
 * Read-side scoping is the canonical tenant scope (space_id LIKE 'tenant:%'),
 * matching memory-health-baseline.ts and lifecycle-atomicity.ts.
 */

import type postgres from "postgres";
import { forgetMemory } from "../../api/src/lib/memory-forget";

type SqlTag = ReturnType<typeof postgres>;

/** Default below-which a description counts as "too short" (matches the legacy 3e cut). */
export const TENANT_GARBAGE_MIN_DESCRIPTION_CHARS = 25;
/** Audit actor stamped on purge events + archive events written by the sweep. */
export const TENANT_GARBAGE_SWEEP_ACTOR = "SUPERCRON";

export interface TenantGarbageSweepOptions {
  /** Audit actor for the purge event + the forgetMemory archive event. */
  actor?: string;
  /** Descriptions shorter than this (and not injection garbage) are archived, not purged. */
  minDescriptionChars?: number;
}

export interface TenantGarbageSweepResult {
  /** Proven injection/fuzz garbage: audited, then hard-deleted. */
  purged: number;
  /** Too-short, unproven memory: archived via forgetMemory (recoverable). */
  archived: number;
}

/**
 * The "proven unrecoverable" injection/fuzz predicate over the `n` (nodes) alias.
 *
 * Deliberately NARROW: only descriptions that are unambiguously injection/fuzz
 * artifacts — XSS (`<script`), agent-transcript prompt-injection (`<task-notification`),
 * and SQLi (`UNION SELECT`). A bare `<` prefix is NOT proof of injection (it
 * false-positives on legitimate prose like "<3 love it", "< less than", or a quoted
 * snippet), so it is intentionally excluded — such content falls to the RECOVERABLE
 * archive branch instead of the unrecoverable purge. COALESCE so a NULL description
 * evaluates to FALSE (never NULL), keeping the archive branch's `NOT (...)` from
 * silently dropping empty-description rows.
 */
function securityGarbagePredicate(sql: SqlTag): any {
  return sql`(
    COALESCE(n.substance->>'description', '') LIKE '<script%'
    OR COALESCE(n.substance->>'description', '') LIKE '<task-notification%'
    OR COALESCE(n.substance->>'description', '') LIKE '%UNION SELECT%'
  )`;
}

/**
 * Sweep tenant-memory garbage with full auditability. Returns the per-category
 * counts. Read-only on non-garbage memory. The purge audit + delete commit
 * together in one transaction; archives go through forgetMemory (its own tx each).
 */
export async function sweepTenantMemoryGarbage(
  sql: SqlTag,
  opts: TenantGarbageSweepOptions = {},
): Promise<TenantGarbageSweepResult> {
  const actor = opts.actor ?? TENANT_GARBAGE_SWEEP_ACTOR;
  const minChars = opts.minDescriptionChars ?? TENANT_GARBAGE_MIN_DESCRIPTION_CHARS;
  const sec = securityGarbagePredicate(sql);

  // (a) PURGE proven injection/fuzz garbage — ONE data-modifying CTE so the audit
  //     and the delete share a SINGLE snapshot: the audited set is exactly the
  //     deleted set, even if a concurrent writer commits new garbage mid-sweep
  //     (separate INSERT-then-DELETE statements run under READ COMMITTED would not
  //     guarantee that). Postgres runs a data-modifying CTE to completion even when
  //     the primary query reads only `d`, so the audit row is always written. Only
  //     LIVE garbage is purged (dormant_at NULL, visibility live) so an already-
  //     archived, recoverable memory is never silently converted into a hard delete.
  const [{ cnt: purgedCnt }] = await sql`
    WITH d AS (
      DELETE FROM nodes n
      WHERE n.node_type = 'memory'
        AND n.space_id LIKE 'tenant:%'
        AND n.dormant_at IS NULL
        AND n.visibility <> 'deleted'
        AND ${sec}
      RETURNING n.addr, n.space_id
    ), ev AS (
      INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor)
      SELECT d.addr, substring(d.space_id from 8), 'retracted',
             jsonb_build_object(
               'action', 'purged',
               'reason', 'supercron_security_fuzz_garbage',
               'pass', 'memory_lifecycle.3e'
             ),
             ${actor}
      FROM d
    )
    SELECT count(*)::int AS cnt FROM d
  `;
  const purged = Number(purgedCnt ?? 0);

  // (b) ARCHIVE too-short, non-security memory — recoverable, via the canonical
  //     forgetMemory() helper (atomic node dormant + registry 'archived' + event).
  const shortRows = await sql`
    SELECT n.addr AS addr, substring(n.space_id from 8) AS tenant_id
    FROM nodes n
    WHERE n.node_type = 'memory'
      AND n.space_id LIKE 'tenant:%'
      AND n.dormant_at IS NULL
      AND n.visibility <> 'deleted'
      AND NOT ${sec}
      AND LENGTH(COALESCE(n.substance->>'description', '')) < ${minChars}
  `;
  let archived = 0;
  for (const row of shortRows) {
    const r = await forgetMemory(sql, String(row.tenant_id), String(row.addr), actor);
    if (r.ok) archived += 1;
    // A concurrent dormancy/delete race can make forget a no-op; surface the skip
    // rather than swallowing it (mirrors the consolidation pass's per-row logging).
    else console.error(`[supercron] garbage-archive forgetMemory skipped ${row.addr}: ${r.error}`);
  }

  return { purged, archived };
}
