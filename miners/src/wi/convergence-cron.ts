/**
 * World Ingestor V2 — Convergence Scanner Cron.
 * Entry point for orphan convergence scanning. Run every 30 min via cron/systemd.
 *
 * Usage: bun run miners/src/wi/convergence-cron.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dir, "../../../.env") });

import { runConvergenceScan } from "./convergence";
import { loadParams } from "./config";

async function main() {
  await loadParams();

  console.log("[WI Convergence] Starting scan...");
  const result = await runConvergenceScan();
  console.log(`[WI Convergence] Done: ${result.detected} detected, ${result.promoted} promoted, ${result.decayed} decayed`);

  process.exit(0);
}

main().catch(err => {
  console.error(`[WI Convergence] Fatal: ${err.message}`);
  process.exit(1);
});
