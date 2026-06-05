/**
 * Local sync-journal pruning — removes rows safely behind the local
 * cursor for the active tenant space.
 *
 * Pruning is local-only housekeeping. It does not affect hosted mirror
 * state, does not require hosted auth, and does not advance the cursor.
 * The exporter owns cursor advancement; pruning only cleans up rows
 * that the cursor has already moved past.
 *
 * Safety rules:
 *   - Only delete rows where seq <= cutoff cursor
 *   - Only delete rows for the specified tenant space_id
 *   - Delete in bounded batches (default 1000)
 *   - Never delete rows for other tenants
 *   - If table does not exist, degrade cleanly
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

const DEFAULT_BATCH_SIZE = 1000;

export interface PruneResult {
  pruned: number;
  cutoff_cursor: number;
  space_id: string;
}

/**
 * Prune sync_journal rows that are safely behind the given cursor
 * for the specified tenant space. Returns the count of deleted rows.
 */
export async function pruneJournal(
  sql: SqlTag,
  cursor: number,
  spaceId: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<PruneResult> {
  if (cursor <= 0) {
    return { pruned: 0, cutoff_cursor: cursor, space_id: spaceId };
  }

  try {
    const deleted = await sql`
      DELETE FROM sync_journal
      WHERE seq IN (
        SELECT seq FROM sync_journal
        WHERE seq <= ${cursor} AND space_id = ${spaceId}
        ORDER BY seq
        LIMIT ${batchSize}
      )
    `;

    return {
      pruned: deleted.count,
      cutoff_cursor: cursor,
      space_id: spaceId,
    };
  } catch {
    // Table may not exist or query may fail — non-fatal
    return { pruned: 0, cutoff_cursor: cursor, space_id: spaceId };
  }
}
