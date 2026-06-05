/**
 * Memory forget/archive — hide a memory from recall without marking it invalid.
 *
 * Sets dormant_at, status=archived, and logs an archive event.
 * Node mutation + registry update + event logging are atomic (sql.begin).
 * Sync journal is best-effort outside the transaction, matching
 * approveMemory() and retractMemory().
 *
 * Unlike retract, forget does NOT require dormant_at IS NULL — an
 * already-dormant memory can be re-archived (e.g. retracted → archived).
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface ForgetResult {
  ok: boolean;
  addr: string;
  status?: string;
  error?: string;
}

export async function forgetMemory(
  sql: SqlTag,
  tenantId: string,
  addr: string,
  actor: string,
  opts: { correlationId?: string | null } = {},
): Promise<ForgetResult> {
  const tenantSpaceId = `tenant:${tenantId}`;

  // 1. Load the memory row (no dormant_at filter — archive is idempotent)
  const [existing] = await sql`
    SELECT addr, substance->>'project_addr' as project_addr
    FROM nodes
    WHERE addr = ${addr} AND space_id = ${tenantSpaceId} AND node_type = 'memory'
      AND visibility <> 'deleted'
  `;
  if (!existing) {
    return { ok: false, addr, error: "Memory not found" };
  }

  // 2. Atomic: node update + registry update + audit event.
  //    All three must succeed or none commit.
  const { logEvent } = await import("./memory-lifecycle");

  try {
    await sql.begin(async (tx: any) => {
      // Node mutation
      const updatedRows = await tx`
        UPDATE nodes SET
          substance = substance || ${tx.json({
            status: "archived",
            archived_at: new Date().toISOString(),
          })}::jsonb,
          dormant_at = now(),
          updated_at = now()
        WHERE addr = ${addr}
          AND space_id = ${tenantSpaceId}
          AND node_type = 'memory'
          AND visibility <> 'deleted'
        RETURNING addr
      `;
      if (updatedRows.length === 0) {
        throw new Error("STALE_MEMORY_FORGET_TARGET");
      }

      // Registry update (0 affected rows OK — pre-registry memories)
      await tx`
        UPDATE memory_registry SET
          status = 'archived',
          updated_at = now()
        WHERE addr = ${addr} AND tenant_id = ${tenantId}
      `;

      // Audit event — must succeed for the transaction to commit
      await logEvent(tx, addr, tenantId, "archived", actor, undefined, { correlationId: opts.correlationId ?? null });

      // F11: sync journal tombstone inside the transaction. Best-effort: a
      // journal failure logs without rolling back the archive.
      const { tryJournalMemoryInTx } = await import("./sync-journal-port");
      await tryJournalMemoryInTx(tx as any, "tombstone", addr, tenantSpaceId, existing.project_addr, "[memory-forget]");
    });
  } catch (error) {
    if ((error as Error).message === "STALE_MEMORY_FORGET_TARGET") {
      return { ok: false, addr, error: "Memory changed or was deleted while archive was being applied" };
    }
    throw error;
  }

  return { ok: true, addr, status: "archived" };
}
