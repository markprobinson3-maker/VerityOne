/**
 * World Ingestor V2 — Queue Processor Cron.
 * Entry point for queue processing. Run every 2 min via cron/systemd.
 *
 * Usage: bun run miners/src/wi/queue-cron.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dir, "../../../.env") });

import { processQueue, queueStatus } from "./queue";
import { loadParams } from "./config";
import { processPool, poolStatus } from "./enrich";

async function main() {
  const params = await loadParams();

  // 1. Process queue
  const status = await queueStatus();
  if (status.pending > 0 || status.processing > 0) {
    console.log(`[WI Queue] ${status.pending} pending, ${status.processing} processing`);
    const result = await processQueue();
    console.log(`[WI Queue] Processed: ${result.processed}, Failed: ${result.failed}`);
  }

  // 2. Process enrichment pool (if enabled and has pending atoms)
  if (params.enrichmentEnabled) {
    const pool = await poolStatus();
    if (pool.pending > 0 || pool.enriched > 0) {
      console.log(`[WI Pool] ${pool.pending} pending, ${pool.enriched} enriched (ready to route)`);
      const poolResult = await processPool();
      console.log(`[WI Pool] Enriched: ${poolResult.enriched}, Routed: ${poolResult.routed}, Cleaned: ${poolResult.cleaned}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`[WI Queue] Fatal: ${err.message}`);
  process.exit(1);
});
