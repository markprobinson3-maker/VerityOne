/**
 * Memory approval — explicit human trust-level upgrade.
 *
 * Upgrades an existing tenant-local memory from `agent_inferred` to
 * `user_accepted` via in-place mutation. Does not create a new row.
 * Preserves `promoted_from` linkage, content, and embedding.
 *
 * Not overlay-specific: any tenant-local `agent_inferred` memory
 * can be approved.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface ApprovalResult {
  ok: boolean;
  approved: boolean;
  already_approved: boolean;
  addr: string;
  source_kind?: string;
  error?: string;
}

export async function approveMemory(
  sql: SqlTag,
  tenantId: string,
  addr: string,
  caller: { actor: string; isHuman: boolean },
  reason?: string,
  opts: { correlationId?: string | null } = {},
): Promise<ApprovalResult> {
  // 1. Only human callers can produce user_accepted
  if (!caller.isHuman) {
    return { ok: false, approved: false, already_approved: false, addr, error: "Approval requires human operator authority. Use CLI: vo memory approve <addr>" };
  }

  const tenantSpaceId = `tenant:${tenantId}`;

  // 2. Load the memory row
  const [row] = await sql`
    SELECT addr, substance, dormant_at, node_type
    FROM nodes
    WHERE addr = ${addr} AND space_id = ${tenantSpaceId}
      AND visibility <> 'deleted'
  `;
  if (!row) {
    return { ok: false, approved: false, already_approved: false, addr, error: "Memory not found in this tenant's space." };
  }
  if (row.node_type !== "memory") {
    return { ok: false, approved: false, already_approved: false, addr, error: "Only memory nodes can be approved." };
  }
  if (row.dormant_at) {
    return { ok: false, approved: false, already_approved: false, addr, error: "Cannot approve a dormant/retracted/archived memory." };
  }

  const substance = (row.substance || {}) as Record<string, unknown>;
  const currentSourceKind = substance.source_kind as string;

  // 3. Idempotency: already user_accepted
  if (currentSourceKind === "user_accepted") {
    return { ok: true, approved: false, already_approved: true, addr, source_kind: "user_accepted" };
  }

  // 4. Only agent_inferred can be upgraded
  if (currentSourceKind !== "agent_inferred") {
    return { ok: false, approved: false, already_approved: false, addr, error: `Cannot approve: source_kind is "${currentSourceKind}", not "agent_inferred".` };
  }

  // 5. In-place mutation: upgrade trust level + add approval metadata
  const approvalMeta = {
    approved_by: caller.actor,
    approved_at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };

  // 5–7. Atomic: node update + registry update + audit event.
  // All three must succeed or none commit. If the event insert fails,
  // the node stays agent_inferred and the caller sees an error.
  const { logEvent } = await import("./memory-lifecycle");

  try {
    await sql.begin(async (tx: any) => {
      // Node substance upgrade
      const updatedRows = await tx`
        UPDATE nodes SET
          substance = substance
            || jsonb_build_object('source_kind', 'user_accepted')
            || jsonb_build_object('accepted_by_user', true)
            || jsonb_build_object('approval', ${tx.json(approvalMeta)}::jsonb),
          updated_at = now()
        WHERE addr = ${addr}
          AND space_id = ${tenantSpaceId}
          AND node_type = 'memory'
          AND visibility <> 'deleted'
        RETURNING addr
      `;
      if (updatedRows.length === 0) {
        throw new Error("STALE_MEMORY_APPROVE_TARGET");
      }

      // Registry upgrade (0 affected rows OK — pre-registry memories)
      await tx`
        UPDATE memory_registry SET
          source_kind = 'user_accepted',
          accepted_by_user = true,
          updated_at = now()
        WHERE addr = ${addr} AND tenant_id = ${tenantId}
      `;

      // Audit event — must succeed for the transaction to commit
      await logEvent(
        tx,
        addr,
        tenantId,
        "validated",
        caller.actor,
        {
          action: "approval",
          previous_source_kind: "agent_inferred",
          new_source_kind: "user_accepted",
          approved_at: approvalMeta.approved_at,
          ...(reason ? { reason } : {}),
        },
        { correlationId: opts.correlationId ?? null },
      );

      // F11: sync journal upsert inside the transaction. Best-effort error
      // handling — journal failure logs without rolling back the approval.
      const { tryJournalMemoryInTx } = await import("./sync-journal-port");
      await tryJournalMemoryInTx(tx as any, "upsert", addr, `tenant:${tenantId}`, null, "[memory-approve]");
    });
  } catch (error) {
    if ((error as Error).message === "STALE_MEMORY_APPROVE_TARGET") {
      return { ok: false, approved: false, already_approved: false, addr, error: "Memory changed or was deleted while approval was being applied." };
    }
    throw error;
  }

  return { ok: true, approved: true, already_approved: false, addr, source_kind: "user_accepted" };
}
