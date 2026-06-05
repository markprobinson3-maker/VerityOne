/**
 * Verity Ingest — Stage 1: RECEIVE
 *
 * Detect source, extract content, dedup, advisory lock, heartbeat.
 */

import { sql, EXIT, type IngestContext, type SourceProfile } from "./config";
import { detectSourceType, getSourceProfile, extractContent, chunkText } from "./sources";

/**
 * RECEIVE: Source detection → extraction → dedup → lock → context
 */
export async function receive(
  input: string,
  flags: IngestContext["flags"]
): Promise<IngestContext> {
  // 1. Detect source type
  const sourceType = detectSourceType(input);
  const profile = getSourceProfile(sourceType);
  console.log(`[RECEIVE] Source type: ${sourceType} (bias: ${profile.importance_bias > 0 ? "+" : ""}${profile.importance_bias})`);

  // 2. Extract text via adapter
  console.log(`[RECEIVE] Extracting content...`);
  const { text, title, source_id } = await extractContent(input, sourceType);
  console.log(`[RECEIVE] Extracted: "${title}" (${text.length} chars)`);

  // 3. SHA-256 hash of full content
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  const source_hash = hasher.digest("hex");

  // 4. Check source_history for duplicate
  if (!flags.re_ingest) {
    const [existing] = await sql`
      SELECT ingest_batch_id, ingested_at, rolled_back
      FROM source_history
      WHERE source_hash = ${source_hash} AND rolled_back = false`;

    if (existing) {
      throw new Error(`Duplicate source (batch ${existing.ingest_batch_id}, ingested ${existing.ingested_at}). Use --re-ingest to override. (exit ${EXIT.DUPLICATE_SOURCE})`);
    }
  }

  // 5. Advisory lock
  if (!flags.dry_run) {
    await acquireLock();
  }

  // 6. Chunk the text
  const chunks = chunkText(text);
  console.log(`[RECEIVE] Chunked into ${chunks.length} chunks (~${Math.round(text.split(/\s+/).length / chunks.length)} words each)`);

  // 7. Build IngestContext
  const batch_id = `vi:${Date.now()}:${source_hash.slice(0, 8)}`;
  const liveIngestOptIn = String(process.env.VO_LIVE_INGEST_OPT_IN || "").trim() === "1";
  const target_tenant_id = liveIngestOptIn
    ? String(process.env.VO_LIVE_INGEST_TENANT_ID || "").trim() || undefined
    : undefined;
  const target_space_id = liveIngestOptIn
    ? String(process.env.VO_LIVE_INGEST_SPACE_ID || "").trim() || "global"
    : "global";

  return {
    batch_id,
    target_tenant_id,
    target_space_id,
    source_id,
    source_type: sourceType,
    source_title: title,
    source_hash,
    profile,
    chunks,
    raw_atoms: [],
    validated_atoms: [],
    scored_atoms: [],
    classified_atoms: [],
    flags,
    stats: {
      chunks_processed: 0,
      atoms_extracted: 0,
      atoms_validated: 0,
      atoms_embedded: 0,
      atoms_deduped: 0,
      auto_on: 0,
      auto_in: 0,
      queued: 0,
      cost_usd: 0,
      flash_calls: 0,
      embed_calls: 0,
    },
  };
}

// ============================================================
// ADVISORY LOCK — pg_try_advisory_lock(42)
// ============================================================

const LOCK_ID = 42;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 120_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function acquireLock(): Promise<void> {
  // Check for stale lock
  const [heartbeat] = await sql`
    SELECT holder_pid, last_heartbeat FROM vi_lock_heartbeat WHERE lock_id = ${LOCK_ID}`;

  if (heartbeat) {
    const age = Date.now() - new Date(heartbeat.last_heartbeat).getTime();
    if (age > STALE_THRESHOLD_MS) {
      console.log(`[RECEIVE] Releasing stale lock (pid ${heartbeat.holder_pid}, ${Math.round(age / 1000)}s old)`);
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
      await sql`DELETE FROM vi_lock_heartbeat WHERE lock_id = ${LOCK_ID}`;
    }
  }

  // Try to acquire
  const [result] = await sql`SELECT pg_try_advisory_lock(${LOCK_ID}) as acquired`;
  if (!result.acquired) {
    throw new Error(`Another ingestion is running. Use --stats to check status. (exit 6)`);
  }

  // Write heartbeat
  const pid = process.pid;
  await sql`
    INSERT INTO vi_lock_heartbeat (lock_id, holder_pid, last_heartbeat)
    VALUES (${LOCK_ID}, ${pid}, now())
    ON CONFLICT (lock_id) DO UPDATE SET holder_pid = ${pid}, last_heartbeat = now()`;

  _lockAcquired = true;

  // Start heartbeat timer
  heartbeatTimer = setInterval(async () => {
    try {
      await sql`UPDATE vi_lock_heartbeat SET last_heartbeat = now() WHERE lock_id = ${LOCK_ID}`;
    } catch {}
  }, HEARTBEAT_INTERVAL_MS);
}

let _lockAcquired = false;

export async function releaseLock(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!_lockAcquired) return;
  try {
    await sql`DELETE FROM vi_lock_heartbeat WHERE lock_id = ${LOCK_ID}`;
    await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
    _lockAcquired = false;
  } catch {}
}
