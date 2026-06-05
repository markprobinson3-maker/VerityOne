import type { MemoryStatus } from "../../../api/src/lib/memory-contract";
import { logEvent, updateRegistryStatus } from "../../../api/src/lib/memory-lifecycle";

const REGISTRY_RECONCILIATION_TERMINAL_STATUSES = ["superseded", "retracted", "archived", "expired"] as const;
type RegistryReconciliationTerminalStatus = Extract<MemoryStatus, typeof REGISTRY_RECONCILIATION_TERMINAL_STATUSES[number]>;

function jsonArray(value: unknown): any[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function jsonObject(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function isRegistryReconciliationTerminalStatus(value: string): value is RegistryReconciliationTerminalStatus {
  return (REGISTRY_RECONCILIATION_TERMINAL_STATUSES as readonly string[]).includes(value);
}

function registryReconciliationCorrelationId(proposal: { id: number; evidence: unknown }, suffix: "apply" | "rollback"): string {
  const evidence = jsonArray(proposal.evidence);
  const cycleNumber = evidence.find((entry) => entry && typeof entry === "object" && entry.cycle_number != null)?.cycle_number;
  const stableId = cycleNumber == null ? `proposal-${proposal.id}` : String(cycleNumber);
  return `supercron-${stableId}-registry-reconcile-${suffix}`;
}

async function recordRegistryReconciliationRollbackEvent(
  tx: any,
  proposal: { id: number; evidence: unknown },
  node: { addr: string; tenant_id: string },
  reason: string,
  actor: string,
): Promise<void> {
  const correlationId = registryReconciliationCorrelationId(proposal, "rollback");
  const [existing] = await tx`
    SELECT 1
    FROM memory_events
    WHERE addr = ${node.addr}
      AND tenant_id = ${node.tenant_id}
      AND correlation_id = ${correlationId}
    LIMIT 1`;
  if (existing) return;

  await tx`
    INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id)
    VALUES (
      ${node.addr},
      ${node.tenant_id},
      'supercron_rollback',
      ${tx.json({
        proposal_id: proposal.id,
        action: "registry_lifecycle_reconciliation",
        reason,
      })},
      ${actor},
      ${correlationId}
    )`;
}

export async function applyApprovedRegistryReconciliationProposals(db: any, actor = "qc-sentinel"): Promise<number> {
  let applied = 0;
  const [appliedAtColumn] = await db`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'proposals'
      AND column_name = 'applied_at'
    LIMIT 1`;
  if (!appliedAtColumn) {
    console.warn("[qc-sentinel] registry reconciliation disabled: proposals.applied_at column missing");
    return 0;
  }

  const proposals = await db`
    SELECT id
    FROM proposals
    WHERE proposal_type = 'node_edit'
      AND status = 'approved'
      AND payload->>'action' = 'registry_lifecycle_reconciliation'
    ORDER BY created_at ASC
    LIMIT 20`;

  for (const proposal of proposals) {
    try {
      const run = async (tx: any) => {
        const [locked] = await tx`
          SELECT id, target_addr, payload, evidence, reviewed_by
          FROM proposals
          WHERE id = ${proposal.id}
            AND status = 'approved'
            AND payload->>'action' = 'registry_lifecycle_reconciliation'
          FOR UPDATE SKIP LOCKED`;
        if (!locked) return;

        const payload = jsonObject(locked.payload);
        const terminalStatus = typeof payload.suggested_terminal_status === "string"
          ? payload.suggested_terminal_status.trim()
          : "";
        const expectedTenantId = typeof payload.tenant_id === "string" ? payload.tenant_id.trim() : "";
        if (!expectedTenantId) {
          const rejectionReason = "missing_tenant_id_in_payload";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
            WHERE id = ${locked.id}`;
          return;
        }
        const [node] = await tx`
          SELECT n.addr, n.space_id, n.visibility, mr.status AS registry_status,
                 mr.tenant_id AS registry_tenant_id,
                 substring(n.space_id from 8) AS tenant_id
          FROM nodes n
          JOIN memory_registry mr
            ON mr.addr = n.addr
            AND mr.tenant_id = ${expectedTenantId}
          WHERE n.addr = ${locked.target_addr}
            AND n.space_id LIKE 'tenant:%'
          FOR UPDATE OF n, mr`;
        if (!node) {
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', 'registry_or_node_not_found')
            WHERE id = ${locked.id}`;
          return;
        }
        if (!node.tenant_id || !String(node.tenant_id).length) {
          const rejectionReason = "empty_tenant_id_in_space_id";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(
            tx,
            locked,
            { addr: node.addr, tenant_id: expectedTenantId },
            rejectionReason,
            actor,
          );
          return;
        }
        if (node.tenant_id !== expectedTenantId || node.registry_tenant_id !== expectedTenantId) {
          const rejectionReason = "registry_reconciliation_tenant_mismatch";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object(
                  'rejection_reason',
                  ${rejectionReason},
                  'expected_tenant_id',
                  ${expectedTenantId},
                  'node_tenant_id',
                  ${node.tenant_id},
                  'registry_tenant_id',
                  ${node.registry_tenant_id}
                )
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(
            tx,
            locked,
            { addr: node.addr, tenant_id: expectedTenantId },
            rejectionReason,
            actor,
          );
          return;
        }
        if (payload.requires_review === true && (!locked.reviewed_by || locked.reviewed_by === actor)) {
          const rejectionReason = "registry_reconciliation_requires_operator_review";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(tx, locked, node, rejectionReason, actor);
          return;
        }
        const validStatuses = new Set(['superseded', 'retracted', 'archived', 'expired']);
        if (!validStatuses.has(terminalStatus) || !isRegistryReconciliationTerminalStatus(terminalStatus)) {
          const rejectionReason = terminalStatus === ""
            ? "missing_terminal_status"
            : `invalid_terminal_status: ${terminalStatus}`;
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(tx, locked, node, rejectionReason, actor);
          return;
        }
        if (node.registry_status !== "active" || !["dormant", "merged"].includes(String(node.visibility))) {
          const rejectionReason = "registry_reconciliation_stale";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object(
                  'rejection_reason',
                  ${rejectionReason},
                  'current_registry_status',
                  ${node.registry_status},
                  'current_node_visibility',
                  ${node.visibility}
                )
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(tx, locked, node, rejectionReason, actor);
          return;
        }

        let supersededByAddr = "";
        if (terminalStatus === "superseded") {
          const [event] = await tx`
            SELECT event_data
            FROM memory_events
            WHERE addr = ${locked.target_addr}
              AND event_type = 'superseded'
            ORDER BY created_at DESC
            LIMIT 1`;
          supersededByAddr = String(event?.event_data?.superseded_by_addr || event?.event_data?.new_memory_addr || "");
          if (!supersededByAddr) {
            const rejectionReason = "superseded_without_successor_in_events";
            await tx`
              UPDATE proposals
              SET status = 'rejected',
                  reviewed_by = COALESCE(reviewed_by, ${actor}),
                  reviewed_at = COALESCE(reviewed_at, NOW()),
                  payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
              WHERE id = ${locked.id}`;
            await recordRegistryReconciliationRollbackEvent(tx, locked, node, rejectionReason, actor);
            return;
          }
        }

        const applyCorrelationId = registryReconciliationCorrelationId(locked, "apply");
        const [existingApply] = await tx`
          SELECT 1
          FROM memory_events
          WHERE addr = ${node.addr}
            AND tenant_id = ${node.tenant_id}
            AND correlation_id = ${applyCorrelationId}
          LIMIT 1`;
        if (existingApply) {
          const rejectionReason = "duplicate_registry_reconciliation_apply_event";
          await tx`
            UPDATE proposals
            SET status = 'rejected',
                reviewed_by = COALESCE(reviewed_by, ${actor}),
                reviewed_at = COALESCE(reviewed_at, NOW()),
                payload = payload || jsonb_build_object('rejection_reason', ${rejectionReason})
            WHERE id = ${locked.id}`;
          await recordRegistryReconciliationRollbackEvent(tx, locked, node, rejectionReason, actor);
          return;
        }

        await updateRegistryStatus(tx, node.addr, node.tenant_id, terminalStatus);
        await logEvent(tx, node.addr, node.tenant_id, terminalStatus, actor, {
          reason: "registry_lifecycle_reconciliation",
          proposal_id: locked.id,
          ...(supersededByAddr ? { superseded_by_addr: supersededByAddr } : {}),
        }, { correlationId: applyCorrelationId });

        await tx`
          UPDATE proposals
          SET status = 'applied', applied_at = NOW()
          WHERE id = ${locked.id}`;
        applied++;
      };
      if (typeof db.begin === "function") {
        await db.begin(run);
      } else {
        await run(db);
      }
    } catch (error) {
      console.warn(`[qc-sentinel] failed to apply registry reconciliation proposal ${proposal.id}:`, (error as Error).message);
    }
  }

  return applied;
}
