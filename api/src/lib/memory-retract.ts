/**
 * Memory retraction — mark a memory as invalid and remove from active recall.
 *
 * Sets dormant_at, status=retracted, and logs a retraction event.
 * Node mutation + registry update + event logging are atomic (sql.begin).
 * Sync journal is best-effort inside the transaction via a savepoint, matching
 * the F11 lifecycle helper contract.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface RetractResult {
  ok: boolean;
  addr: string;
  status?: string;
  error?: string;
}

export async function retractMemory(
  sql: SqlTag,
  tenantId: string,
  addr: string,
  actor: string,
  reason?: string,
  opts: {
    correlationId?: string | null;
    extraSubstance?: Record<string, unknown>;
    extraEventData?: Record<string, unknown>;
  } = {},
): Promise<RetractResult> {
  const tenantSpaceId = `tenant:${tenantId}`;

  // 1. Load the memory row (must be non-dormant)
  const [existing] = await sql`
    SELECT addr,
      provenance->>'remote_origin' as remote_origin,
      provenance->>'remote_client_class' as remote_client_class,
      provenance->>'remote_request_id' as remote_request_id,
      substance->>'project_addr' as project_addr
    FROM nodes
    WHERE addr = ${addr} AND space_id = ${tenantSpaceId} AND node_type = 'memory' AND dormant_at IS NULL
      AND visibility <> 'deleted'
  `;
  if (!existing) {
    return { ok: false, addr, error: "Memory not found or already retracted" };
  }

  // 2. Build event data (preserve remote provenance for observability)
  const eventData: Record<string, unknown> = {
    reason: reason || null,
    ...(opts.extraEventData ?? {}),
  };
  if (existing.remote_origin) {
    eventData.original_remote_origin = existing.remote_origin;
    eventData.original_remote_client_class = existing.remote_client_class;
    eventData.original_remote_request_id = existing.remote_request_id;
  }

  // 3. Atomic: node update + registry update + audit event.
  //    All three must succeed or none commit. If the event insert fails,
  //    the node stays non-dormant and the caller sees an error.
  const { logEvent } = await import("./memory-lifecycle");

  try {
    await sql.begin(async (tx: any) => {
      // Node mutation
      const updatedRows = await tx`
        UPDATE nodes SET
          substance = substance || ${tx.json({
            status: "retracted",
            retracted_at: new Date().toISOString(),
            retracted_reason: reason || null,
            ...(opts.extraSubstance ?? {}),
          })}::jsonb,
          dormant_at = now(),
          updated_at = now()
        WHERE addr = ${addr}
          AND space_id = ${tenantSpaceId}
          AND node_type = 'memory'
          AND dormant_at IS NULL
          AND visibility <> 'deleted'
        RETURNING addr
      `;
      if (updatedRows.length === 0) {
        throw new Error("STALE_MEMORY_RETRACT_TARGET");
      }

      // Registry update (0 affected rows OK — pre-registry memories)
      await tx`
        UPDATE memory_registry SET
          status = 'retracted',
          updated_at = now()
        WHERE addr = ${addr} AND tenant_id = ${tenantId}
      `;

      // Audit event — must succeed for the transaction to commit
      await logEvent(tx, addr, tenantId, "retracted", actor, eventData, { correlationId: opts.correlationId ?? null });

      // F11: sync journal tombstone inside the transaction. Best-effort: a
      // journal failure logs without rolling back the retract.
      const { tryJournalMemoryInTx } = await import("./sync-journal-port");
      await tryJournalMemoryInTx(tx as any, "tombstone", addr, tenantSpaceId, existing.project_addr, "[memory-retract]");
    });
  } catch (error) {
    if ((error as Error).message === "STALE_MEMORY_RETRACT_TARGET") {
      return { ok: false, addr, error: "Memory changed or was deleted while retraction was being applied" };
    }
    throw error;
  }

  return { ok: true, addr, status: "retracted" };
}
