/**
 * Verity Ingest — Pipeline Runner
 *
 * Callable pipeline for adapter-based ingestion (scheduler, webhook, CLI).
 * Wraps the 5-stage RECEIVE→ATOMIZE→WEIGH→SORT→DELIVER pipeline.
 */

import { sql, type IngestContext, type SourceProfile } from "./config";
import { getSourceProfile } from "./sources";
import { receive, releaseLock } from "./receive";
import { atomize } from "./atomize";
import { weigh } from "./weigh";
import { sort } from "./sort";
import { deliver } from "./deliver";
import type { ViAdapter, AdapterInput, AdapterOutput } from "./adapters/types";

export interface PipelineInput {
  adapter: ViAdapter;
  source: string;
  config?: Record<string, any>;
  webhook_payload?: any;
  dry_run?: boolean;
  force?: boolean;
}

export interface PipelineResult {
  batch_id: string;
  total_atoms: number;
  auto_on_count: number;
  auto_in_count: number;
  queued_count: number;
  cost_usd: number;
  source_title: string;
}

/**
 * Run the full VI pipeline using an adapter.
 *
 * The adapter handles extraction (Step 1a).
 * Then we feed chunks into the existing ATOMIZE→WEIGH→SORT→DELIVER stages.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { adapter, source, config, webhook_payload, dry_run = false, force = false } = input;
  const profile = getSourceProfile(adapter.source_type);

  console.log(`[PIPELINE] Adapter: ${adapter.name} (source_type: ${adapter.source_type})`);

  // 1. Run adapter extraction
  const adapterInput: AdapterInput = { source, config, webhook_payload };
  const output: AdapterOutput = await adapter.extract(adapterInput);

  if (output.chunks.length === 0) {
    console.log(`[PIPELINE] Adapter returned 0 chunks. Skipping.`);
    return { batch_id: "", total_atoms: 0, auto_on_count: 0, auto_in_count: 0, queued_count: 0, cost_usd: 0, source_title: output.title };
  }

  console.log(`[PIPELINE] Extracted: "${output.title}" (${output.chunks.length} chunks)`);

  // 2. SHA-256 hash of all chunk content for dedup
  const fullText = output.chunks.map(c => c.content).join("\n");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(fullText);
  const source_hash = hasher.digest("hex");

  // 3. Dedup check
  const [existing] = await sql`
    SELECT ingest_batch_id, ingested_at FROM source_history
    WHERE source_hash = ${source_hash} AND rolled_back = false`;
  if (existing) {
    console.log(`[PIPELINE] Duplicate source (batch ${existing.ingest_batch_id}). Skipping.`);
    return { batch_id: "", total_atoms: 0, auto_on_count: 0, auto_in_count: 0, queued_count: 0, cost_usd: 0, source_title: output.title };
  }

  // 4. Advisory lock (skip for dry run)
  if (!dry_run) {
    // We import acquireLock via receive, but for adapter pipeline
    // we build the context manually instead of calling receive()
  }

  // 5. Build IngestContext from adapter output
  const batch_id = `vi:${Date.now()}:${source_hash.slice(0, 8)}`;
  const ctx: IngestContext = {
    batch_id,
    source_id: output.source_id,
    source_type: adapter.source_type,
    source_title: output.title,
    source_hash,
    profile,
    chunks: output.chunks.map(c => c.content),
    chunk_metadata: output.chunks.map(c => c.metadata || null),
    raw_atoms: [],
    validated_atoms: [],
    scored_atoms: [],
    classified_atoms: [],
    flags: { dry_run, re_ingest: false, force },
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

  // 6. Run pipeline stages
  await atomize(ctx);
  await weigh(ctx);
  await sort(ctx);
  await deliver(ctx);

  return {
    batch_id: ctx.batch_id,
    total_atoms: ctx.classified_atoms.length,
    auto_on_count: ctx.stats.auto_on,
    auto_in_count: ctx.stats.auto_in,
    queued_count: ctx.stats.queued,
    cost_usd: ctx.stats.cost_usd,
    source_title: ctx.source_title,
  };
}
