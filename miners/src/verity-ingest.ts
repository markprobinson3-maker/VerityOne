/**
 * Verity Ingest (VI) — Universal Intake Engine
 *
 * 5-stage pipeline: RECEIVE → ATOMIZE → WEIGH → SORT → DELIVER
 *
 * Usage:
 *   bun run miners/src/verity-ingest.ts <url_or_path>
 *   bun run miners/src/verity-ingest.ts --dry-run "https://example.com"
 *   bun run miners/src/verity-ingest.ts --batch sources.txt
 *   bun run miners/src/verity-ingest.ts --retry-pending
 *   bun run miners/src/verity-ingest.ts --review
 *   bun run miners/src/verity-ingest.ts --promote <id>
 *   bun run miners/src/verity-ingest.ts --demote <id>
 *   bun run miners/src/verity-ingest.ts --conflicts
 *   bun run miners/src/verity-ingest.ts --rollback <batch_id>
 *   bun run miners/src/verity-ingest.ts --stats [--today|--cost|--sources]
 *   bun run miners/src/verity-ingest.ts --queue
 */

import { sql, EXIT } from "./vi/config";
import { receive, releaseLock } from "./vi/receive";
import { atomize } from "./vi/atomize";
import { weigh } from "./vi/weigh";
import { sort } from "./vi/sort";
import { deliver } from "./vi/deliver";
import { handleReview } from "./vi/review";
import { handleRollback } from "./vi/rollback";
import { handleStats, handleQueue } from "./vi/stats";
import { readFileSync } from "fs";

const args = process.argv.slice(2);

// Flags
const DRY_RUN = args.includes("--dry-run");
const RE_INGEST = args.includes("--re-ingest");
const FORCE = args.includes("--force");

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  console.log("⚡ Verity Ingest v0.5\n");

  // ---- Command routing ----

  // --stats
  if (args.includes("--stats")) {
    const sub = args.includes("--today") ? "today"
      : args.includes("--cost") ? "cost"
      : args.includes("--sources") ? "sources"
      : "full";
    await handleStats(sub);
    await sql.end();
    return;
  }

  // --queue
  if (args.includes("--queue")) {
    await handleQueue();
    await sql.end();
    return;
  }

  // --review / --promote / --demote / --conflicts
  if (args.includes("--review") || args.includes("--promote") || args.includes("--demote") || args.includes("--conflicts")) {
    const promoteId = getArgValue("--promote");
    const demoteId = getArgValue("--demote");
    const quick = args.includes("--quick");
    const conflicts = args.includes("--conflicts");

    await handleReview({ promoteId, demoteId, quick, conflicts });
    await sql.end();
    return;
  }

  // --rollback
  const rollbackBatch = getArgValue("--rollback");
  if (rollbackBatch) {
    await handleRollback(rollbackBatch);
    await sql.end();
    return;
  }

  // --retry-pending
  if (args.includes("--retry-pending")) {
    await retryPending();
    await sql.end();
    return;
  }

  // --batch <file>
  const batchFile = getArgValue("--batch");
  if (batchFile) {
    const lines = readFileSync(batchFile, "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));

    console.log(`Batch: ${lines.length} sources from ${batchFile}\n`);
    for (let i = 0; i < lines.length; i++) {
      console.log(`\n═══ [${i + 1}/${lines.length}] ${lines[i]} ═══`);
      try {
        await ingestOne(lines[i]);
      } catch (err: any) {
        console.error(`  Failed: ${err.message}`);
      }
    }
    await sql.end();
    return;
  }

  // Positional argument: <url_or_path>
  const input = args.find(a => !a.startsWith("--"));
  if (!input) {
    printUsage();
    await sql.end();
    return;
  }

  try {
    await ingestOne(input);
  } catch (err: any) {
    console.error(`\nFatal: ${err.message}`);
    await releaseLock();
    process.exitCode = 1;
  }

  await sql.end();
}

// ============================================================
// CORE PIPELINE
// ============================================================

async function ingestOne(input: string): Promise<void> {
  const flags = { dry_run: DRY_RUN, re_ingest: RE_INGEST, force: FORCE };

  // Stage 1: RECEIVE
  const ctx = await receive(input, flags);

  // Stage 2: ATOMIZE
  await atomize(ctx);

  // Stage 3: WEIGH
  await weigh(ctx);

  // Stage 4: SORT
  await sort(ctx);

  // Stage 5: DELIVER
  await deliver(ctx);
}

// ============================================================
// RETRY PENDING — process vi_raw_queue entries
// ============================================================

async function retryPending(): Promise<void> {
  const pending = await sql`
    SELECT id, ingest_batch_id, source_id, source_type, content, chunk_index
    FROM vi_raw_queue WHERE status = 'pending' ORDER BY id`;

  if (pending.length === 0) {
    console.log("No pending items in vi_raw_queue.");
    return;
  }

  console.log(`Retrying ${pending.length} failed chunks...\n`);

  const { callFlash } = await import("./lib/llm");
  const { embedBatch, toVectorStr } = await import("../../api/src/lib/embed");

  let success = 0, failed = 0;

  for (const item of pending) {
    try {
      const prompt = `You are a precision knowledge extractor for an AI agent infrastructure team.

Extract atomic claims from the text. An atomic claim is the smallest unit
of meaning that can independently be true or false.

Types:
- CLAIM: Factual assertion
- FRAMEWORK: Named methodology
- ACTION: Concrete technique
- SIGNAL: Trend/movement

For each atom provide:
- content: Self-contained claim
- atom_type: CLAIM | FRAMEWORK | ACTION | SIGNAL
- source_excerpt: EXACT verbatim quote (10-50 words) supporting this atom
- temporality: EPHEMERAL | CURRENT | DURABLE

Rules:
- Max 15 atoms per chunk. Empty array is valid.

Return JSON array only.

---

TEXT:
${item.content}`;

      const raw = await callFlash(prompt, { temperature: 0.2, maxTokens: 4096, jsonMode: true });
      await sql`UPDATE vi_raw_queue SET status = 'processed' WHERE id = ${item.id}`;
      console.log(`  ✓ Chunk ${item.chunk_index} from batch ${item.ingest_batch_id}`);
      success++;
    } catch (err: any) {
      console.error(`  ✗ Chunk ${item.chunk_index}: ${err.message?.slice(0, 80)}`);
      failed++;
    }
  }

  console.log(`\nRetry complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================
// USAGE
// ============================================================

function printUsage(): void {
  console.log(`Usage:
  verity-ingest <url_or_path>              Ingest a URL or local file
  verity-ingest --dry-run <url_or_path>    Show what would happen, commit nothing
  verity-ingest --re-ingest <url_or_path>  Skip dedup check
  verity-ingest --force <url_or_path>      Skip budget gate
  verity-ingest --batch <file>             Process URLs from file (one per line)
  verity-ingest --retry-pending            Retry failed Flash calls from vi_raw_queue

  verity-ingest --review                   Show pending queue items
  verity-ingest --review --quick           Top 10 highest-scoring non-contradictions
  verity-ingest --promote <id>             Move queue item → staging_nodes
  verity-ingest --demote <id>              Move queue item → stimuli
  verity-ingest --conflicts                Show pending contradictions

  verity-ingest --rollback <batch_id>      Rollback a batch

  verity-ingest --stats                    Full history
  verity-ingest --stats --today            Today's activity
  verity-ingest --stats --cost             Cost breakdown
  verity-ingest --stats --sources          Per-source quality report
  verity-ingest --queue                    Queue depth + health`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
