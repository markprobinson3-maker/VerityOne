/**
 * Verity Ingest — Batch Rollback
 *
 * Reverses all effects of a VI batch:
 * 1. Delete from intake_queue
 * 2. Delete from stimuli
 * 3. Reject staging_nodes
 * 4. Reverse confidence deltas
 * 5. Mark source_history as rolled_back
 * 6. Log to mining_runs
 */

import { sql } from "./config";

export async function handleRollback(batchId: string): Promise<void> {
  console.log(`Rolling back batch: ${batchId}\n`);

  // Verify batch exists
  const [batch] = await sql`
    SELECT * FROM source_history WHERE ingest_batch_id = ${batchId}`;

  if (!batch) {
    console.error(`Batch not found: ${batchId}`);
    process.exit(1);
  }

  if (batch.rolled_back) {
    console.error(`Batch already rolled back: ${batchId}`);
    process.exit(1);
  }

  // 1. Delete from intake_queue
  const [queueResult] = await sql`
    DELETE FROM intake_queue WHERE ingest_batch_id = ${batchId}
    RETURNING id`;
  const queueDeleted = queueResult ? 1 : 0;
  const allQueueDeleted = await sql`DELETE FROM intake_queue WHERE ingest_batch_id = ${batchId}`;
  console.log(`  intake_queue: deleted (batch ${batchId})`);

  // 2. Delete from stimuli
  const stimuliDeleted = await sql`
    DELETE FROM stimuli WHERE source_id LIKE ${"vi:" + batchId + "%"}`;
  console.log(`  stimuli: deleted VI entries for batch`);

  // 3. Reject staging_nodes
  const stagingUpdated = await sql`
    UPDATE staging_nodes SET qc_status = 'rejected', qc_notes = 'Rolled back via VI rollback'
    WHERE source_context->>'vi_batch_id' = ${batchId} AND qc_status = 'pending'`;
  console.log(`  staging_nodes: rejected pending entries`);

  // 4. Reverse confidence deltas
  const deltas = await sql`
    SELECT node_addr, confidence_before, delta FROM confidence_deltas
    WHERE ingest_batch_id = ${batchId}
    ORDER BY id DESC`;

  for (const d of deltas) {
    await sql`UPDATE nodes SET confidence = ${d.confidence_before} WHERE addr = ${d.node_addr}`;
    console.log(`  confidence: ${d.node_addr} restored to ${d.confidence_before}`);
  }

  // 5. Mark source_history as rolled_back
  await sql`UPDATE source_history SET rolled_back = true WHERE ingest_batch_id = ${batchId}`;

  // 6. Log to mining_runs
  const [maxRun] = await sql`SELECT COALESCE(MAX(run_number), 0) + 1 as next FROM mining_runs`;
  await sql`INSERT INTO mining_runs (run_number, mode, nodes_checked, cost_usd, model_used, started_at, completed_at)
    VALUES (${maxRun.next}, 'verity-ingest', 0, 0, 'rollback', now(), now())`;

  console.log(`\nRollback complete for batch: ${batchId}`);
}
