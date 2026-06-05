import { sql } from "./config";

export interface WISourceHistoryCounts {
  atomCount: number;
  onCount: number;
  inCount: number;
  queueCount: number;
}

export interface FinalizeWISourceHistoryInput {
  runId: string;
  status: "done" | "failed";
  atomsExtracted: number;
  newNode: number;
  heat: number;
  skill: number;
  costUsd: number;
  lastError?: string | null;
}

export function buildWISourceHistoryCounts(
  atomsExtracted: number,
  newNode: number,
  heat: number,
  skill: number,
): WISourceHistoryCounts {
  return {
    atomCount: atomsExtracted,
    onCount: newNode,
    inCount: heat,
    // WI skill proposals are the closest analogue to queued review work.
    queueCount: skill,
  };
}

export async function finalizeWISourceHistory(input: FinalizeWISourceHistoryInput): Promise<void> {
  const counts = buildWISourceHistoryCounts(
    input.atomsExtracted,
    input.newNode,
    input.heat,
    input.skill,
  );

  await sql`
    UPDATE source_history
    SET status = ${input.status},
        atom_count = ${counts.atomCount},
        on_count = ${counts.onCount},
        in_count = ${counts.inCount},
        queue_count = ${counts.queueCount},
        cost_usd = ${input.costUsd},
        last_error = ${input.lastError ?? null},
        updated_at = now()
    WHERE ingest_batch_id = ${input.runId}
  `;
}

export async function markWISourceHistoryFailed(input: {
  runId?: string | null;
  sourceId?: string | null;
  lastError: string;
}): Promise<void> {
  if (input.runId) {
    await sql`
      UPDATE source_history
      SET status = 'failed',
          last_error = ${input.lastError},
          updated_at = now()
      WHERE ingest_batch_id = ${input.runId}
    `;
    return;
  }

  if (input.sourceId) {
    await sql`
      UPDATE source_history
      SET status = 'failed',
          last_error = ${input.lastError},
          updated_at = now()
      WHERE status = 'processing'
        AND source_id = ${input.sourceId}
        AND updated_at > now() - interval '30 minutes'
    `;
  }
}
