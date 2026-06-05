/**
 * World Ingestor V2 — Persistent Queue Processor.
 * - enqueue(url, opts) — INSERT into wi_queue
 * - dequeue() — SELECT pending, ordered by priority
 * - processQueue() — loop: dequeue → pipeline → update status
 * - queueStatus() — count by status
 */

import { sql, loadParams, SOURCE_REGISTRY, SOURCE_DETECTION_RULES } from "./config";
import { receive } from "./receive";
import { extract } from "./extract";
import { route } from "./route";
import { enrichInline } from "./enrich";
import { markWISourceHistoryFailed } from "./source-history";

// ============================================================
// ENQUEUE
// ============================================================

function detectSourceTypeFromUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const rule of SOURCE_DETECTION_RULES) {
      if (rule.test(url, u.hostname, u.pathname)) return rule.type;
    }
  } catch { /* ignore */ }
  return "web";
}

/** Derive queue priority from SOURCE_REGISTRY importance_bias.
 *  importance_bias ranges from -10 (reddit) to +20 (arxiv).
 *  Maps to priority 1-10 (lower = higher priority in the queue).
 *  Only used when no explicit priority is provided.
 */
function derivePriority(sourceType: string): number {
  const profile = SOURCE_REGISTRY[sourceType];
  if (!profile) return 5;
  // importance_bias range: -10 to +20 → priority 1 (highest) to 8 (lowest)
  // Higher bias = lower priority number = processed sooner
  return Math.max(1, Math.min(8, Math.round(5 - profile.importance_bias / 5)));
}

export async function enqueue(url: string, opts: {
  priority?: number;
  submittedBy?: string;
  sourceType?: string;
} = {}): Promise<string> {
  const sourceType = opts.sourceType || detectSourceTypeFromUrl(url);
  const priority = opts.priority ?? derivePriority(sourceType);
  const submittedBy = opts.submittedBy ?? "cli";

  const [row] = await sql`
    INSERT INTO wi_queue (url, source_type, priority, status, submitted_by)
    VALUES (${url}, ${sourceType}, ${priority}, 'pending', ${submittedBy})
    RETURNING id
  `;

  return row.id;
}

// ============================================================
// DEQUEUE
// ============================================================

export async function dequeue(): Promise<Array<{ id: string; url: string; source_type: string | null }>> {
  const params = await loadParams();

  // Check how many are currently processing
  const [active] = await sql`
    SELECT COUNT(*) AS n FROM wi_queue WHERE status = 'processing'
  `;
  const activeCount = parseInt(active.n);
  const available = params.parallelLimit - activeCount;

  if (available <= 0) return [];

  // SELECT and UPDATE in one go — prevents race conditions
  const items = await sql`
    UPDATE wi_queue SET
      status = 'processing',
      started_at = now()
    WHERE id IN (
      SELECT id FROM wi_queue
      WHERE status = 'pending'
      ORDER BY priority ASC, submitted_at ASC
      LIMIT ${available}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, source_type
  `;

  return items as any;
}

// ============================================================
// PROCESS QUEUE — main loop
// ============================================================

export async function processQueue(): Promise<{ processed: number; failed: number }> {
  let processed = 0, failed = 0;

  // First: reset stale processing items
  await sql`
    UPDATE wi_queue SET
      status = 'pending',
      started_at = null
    WHERE status = 'processing' AND started_at < now() - interval '15 minutes'
  `;

  const items = await dequeue();
  if (items.length === 0) return { processed: 0, failed: 0 };

  // Process each item
  await Promise.all(items.map(async (item) => {
    let source: Awaited<ReturnType<typeof receive>> | null = null;
    try {
      const params = await loadParams();
      source = await receive(item.url, {});
      const atoms = await extract(source.textParts, source.runId, source.sourceType, source.title);

      // Inline enrichment if enabled (queue items process one at a time)
      let enrichedAtoms;
      if (params.enrichmentEnabled && atoms.length > 0) {
        enrichedAtoms = await enrichInline(atoms, source.runId, source.sourceUrl, source.sourceType);
      }

      const result = await route(atoms, source.runId, {
        sourceUrl: source.sourceUrl,
        sourceType: source.sourceType,
        sourceHash: source.sourceHash,
        title: source.title,
        enrichedAtoms,
      });

      await sql`
        UPDATE wi_queue SET
          status = 'done',
          completed_at = now(),
          run_id = ${result.runId}
        WHERE id = ${item.id}
      `;
      processed++;
    } catch (err: any) {
      await markWISourceHistoryFailed({
        runId: source?.runId,
        sourceId: item.url,
        lastError: err.message,
      }).catch(() => {});

      const params = await loadParams();

      // Check retry count
      const [qItem] = await sql`
        SELECT retry_count FROM wi_queue WHERE id = ${item.id}
      `;
      const retryCount = qItem?.retry_count || 0;

      if (retryCount < params.maxRetries) {
        // Reset to pending with backoff (5 min per retry)
        await sql`
          UPDATE wi_queue SET
            status = 'pending',
            started_at = null,
            retry_count = retry_count + 1,
            error_message = ${err.message}
          WHERE id = ${item.id}
        `;
      } else {
        await sql`
          UPDATE wi_queue SET
            status = 'failed',
            completed_at = now(),
            error_message = ${err.message}
          WHERE id = ${item.id}
        `;
      }
      failed++;
    }
  }));

  return { processed, failed };
}

// ============================================================
// QUEUE STATUS
// ============================================================

export async function queueStatus(): Promise<{
  pending: number;
  processing: number;
  done: number;
  failed: number;
  cancelled: number;
  total: number;
  oldestPending: string | null;
}> {
  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'processing') AS processing,
      COUNT(*) FILTER (WHERE status = 'done') AS done,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
      COUNT(*) AS total
    FROM wi_queue
  `;

  const [oldest] = await sql`
    SELECT submitted_at::text FROM wi_queue
    WHERE status = 'pending'
    ORDER BY priority ASC, submitted_at ASC
    LIMIT 1
  `;

  return {
    pending: parseInt(counts.pending),
    processing: parseInt(counts.processing),
    done: parseInt(counts.done),
    failed: parseInt(counts.failed),
    cancelled: parseInt(counts.cancelled),
    total: parseInt(counts.total),
    oldestPending: oldest?.submitted_at || null,
  };
}

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

export async function cancelQueueItem(id: string): Promise<boolean> {
  const result = await sql`
    UPDATE wi_queue SET status = 'cancelled', completed_at = now()
    WHERE id = ${id} AND status = 'pending'
  `;
  return result.count > 0;
}

export async function flushQueue(): Promise<number> {
  const result = await sql`
    UPDATE wi_queue SET status = 'cancelled', completed_at = now()
    WHERE status = 'pending'
  `;
  return result.count;
}
