/**
 * Project-association apply slice (Memory-Health-Persistence PR 3).
 *
 * The detection + proposal side already exists (supercron pass3cProjectAssociationDoctor:
 * it inserts pending `node_edit` proposals with payload.action='project_association',
 * confidence 0.9 for keyword_explicit / 0.7 for keyword_inferred). THIS is the deferred
 * apply slice, mirroring miners/src/lib/registry-reconciliation.ts.
 *
 * It applies ONLY HIGH-CONFIDENCE, REVIEWED proposals (status='approved', confidence
 * >= PROJECT_ASSOCIATION_MIN_APPLY_CONFIDENCE, and — when payload.requires_review —
 * reviewed by a human, not the auto-actor). Each apply, inside ONE transaction:
 *   - re-qualifies the memory (still active + still has NO project_addr — never clobber
 *     a concurrently-set association),
 *   - sets substance.project_addr,
 *   - writes the canonical `part_of` graph edge (memory -> project root),
 *   - logs a durable audit event recording prior_project_addr (so it is REVERSIBLE),
 *   - marks the proposal applied.
 * A failed re-qualification REJECTS the proposal with a reason (never a silent skip).
 *
 * Safety (verified): recall scopes on substance.project_addr ONLY (part_of is
 * navigation); a NULL-project memory always stays visible in tenant-wide recall, and
 * the doctor's keyword classifier only proposes for memories that explicitly name a
 * project — so this never hides a legitimately tenant-wide memory. project_addr is NOT
 * part of the embedding text, so no re-embedding is required.
 *
 * Reversibility: reverseProjectAssociationInTx removes project_addr + the part_of edge
 * and writes a rollback event whose correlation_id matches the doctor's 30-day
 * re-proposal suppression pattern (`supercron-%-project-association-rollback`).
 */

import { logEvent } from "../../../api/src/lib/memory-lifecycle";
import { writeEdge, deleteEdge } from "../../../api/src/lib/edge-mutations";

/** Minimum proposal confidence eligible for the auto-apply path (keyword_explicit). */
export const PROJECT_ASSOCIATION_MIN_APPLY_CONFIDENCE = 0.9;
/** Per-run cap, matching the registry-reconciliation apply slice. */
export const PROJECT_ASSOCIATION_APPLY_BATCH_LIMIT = 20;
/** Confidence stamped on the part_of edge an apply creates (matches /associate-memory-project). */
const PART_OF_EDGE_CONFIDENCE = 0.95;

function jsonArray(value: unknown): any[] {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

function jsonObject(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Stable correlation id for an apply/rollback, derived from the proposal's cycle_number
 *  (falls back to the proposal id). The rollback form matches the doctor's
 *  `supercron-%-project-association-rollback` 30-day re-proposal suppression LIKE. */
export function projectAssociationCorrelationId(
  proposal: { id: number; evidence: unknown },
  suffix: "apply" | "rollback",
): string {
  const evidence = jsonArray(proposal.evidence);
  const cycleNumber = evidence.find((e) => e && typeof e === "object" && e.cycle_number != null)?.cycle_number;
  const stableId = cycleNumber == null ? `proposal-${proposal.id}` : String(cycleNumber);
  return `supercron-${stableId}-project-association-${suffix}`;
}

export interface ProjectAssociationApplyDecision {
  decision: "apply" | "reject";
  reason?: string;
}

/**
 * Pure re-qualification decision for a locked project-association proposal. DB-free and
 * deterministic so it can be unit-tested and drift-pinned. The confidence threshold is a
 * SELECT-level filter (low-confidence approved proposals are left untouched, not rejected),
 * so it is intentionally not re-checked here.
 */
export function evaluateProjectAssociationApply(input: {
  payloadTenantId: string;
  proposedProjectAddr: string;
  nodeTenantId: string | null;
  nodeActive: boolean;
  nodeAlreadyHasProject: boolean;
  projectExists: boolean;
  reviewedBy: string | null;
  requiresReview: boolean;
  actor: string;
}): ProjectAssociationApplyDecision {
  if (!input.payloadTenantId) return { decision: "reject", reason: "missing_tenant_id_in_payload" };
  if (!input.proposedProjectAddr) return { decision: "reject", reason: "missing_proposed_project_addr" };
  if (!input.nodeTenantId || input.nodeTenantId !== input.payloadTenantId) return { decision: "reject", reason: "tenant_mismatch" };
  if (!input.nodeActive) return { decision: "reject", reason: "memory_not_active" };
  if (input.nodeAlreadyHasProject) return { decision: "reject", reason: "memory_already_associated" };
  if (!input.projectExists) return { decision: "reject", reason: "proposed_project_not_valid_in_tenant" };
  // requires_review => a human (not the auto-actor) must have approved it.
  if (input.requiresReview && (!input.reviewedBy || input.reviewedBy === input.actor)) {
    return { decision: "reject", reason: "requires_operator_review" };
  }
  return { decision: "apply" };
}

export interface ProjectAssociationApplyResult {
  applied: number;
  rejected: number;
  /** Set on a dry-run: how many approved high-confidence proposals WOULD be considered. */
  previewed?: number;
  dry_run?: boolean;
}

async function rejectProposal(tx: any, id: number, actor: string, reason: string): Promise<void> {
  // ::text casts so Postgres can type the params inside jsonb_build_object /
  // COALESCE (a bare string param there raises "could not determine data type").
  await tx`
    UPDATE proposals
    SET status = 'rejected',
        reviewed_by = COALESCE(reviewed_by, ${actor}::text),
        reviewed_at = COALESCE(reviewed_at, NOW()),
        payload = payload || jsonb_build_object('rejection_reason', ${reason}::text)
    WHERE id = ${id}`;
}

/**
 * Apply approved, high-confidence project-association proposals. Mirrors
 * applyApprovedRegistryReconciliationProposals. Read-only when opts.dryRun is set.
 */
export async function applyApprovedProjectAssociationProposals(
  db: any,
  opts: { actor?: string; minConfidence?: number; limit?: number; dryRun?: boolean } = {},
): Promise<ProjectAssociationApplyResult> {
  const actor = opts.actor ?? "qc-sentinel";
  const minConfidence = opts.minConfidence ?? PROJECT_ASSOCIATION_MIN_APPLY_CONFIDENCE;
  const limit = opts.limit ?? PROJECT_ASSOCIATION_APPLY_BATCH_LIMIT;

  const [appliedAtColumn] = await db`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'proposals' AND column_name = 'applied_at' LIMIT 1`;
  if (!appliedAtColumn) {
    console.warn("[qc-sentinel] project association apply disabled: proposals.applied_at column missing");
    return opts.dryRun ? { applied: 0, rejected: 0, dry_run: true, previewed: 0 } : { applied: 0, rejected: 0 };
  }

  const proposals = await db`
    SELECT id
    FROM proposals
    WHERE proposal_type = 'node_edit'
      AND status = 'approved'
      AND payload->>'action' = 'project_association'
      AND confidence >= ${minConfidence}
    ORDER BY created_at ASC
    LIMIT ${limit}`;

  if (opts.dryRun) {
    return { applied: 0, rejected: 0, previewed: proposals.length, dry_run: true };
  }

  let applied = 0;
  let rejected = 0;

  for (const proposal of proposals) {
    try {
      const run = async (tx: any) => {
        const [locked] = await tx`
          SELECT id, target_addr, payload, evidence, reviewed_by
          FROM proposals
          WHERE id = ${proposal.id}
            AND status = 'approved'
            AND payload->>'action' = 'project_association'
          FOR UPDATE SKIP LOCKED`;
        if (!locked) return;

        const payload = jsonObject(locked.payload);
        const payloadTenantId = String(payload.tenant_id ?? "").trim();
        const proposedProjectAddr = String(payload.proposed_project_addr ?? "").trim();
        const requiresReview = payload.requires_review === true;

        const [node] = await tx`
          SELECT n.addr, n.space_id, n.visibility, n.dormant_at,
                 substring(n.space_id from 8) AS tenant_id,
                 (n.substance ? 'project_addr') AS has_project
          FROM nodes n
          WHERE n.addr = ${locked.target_addr}
            AND n.node_type = 'memory'
            AND n.space_id LIKE 'tenant:%'
          FOR UPDATE OF n`;

        // Validate the proposed project in the SAME tenant space as the memory AND as
        // a real project root (PJ.0.1.* layer-1 addr). Tenant- + namespace-scoped so a
        // proposal can never associate a memory with a foreign tenant's project (which
        // would hide it from its own tenant + leak the foreign project's label) nor with
        // a non-project node (a memory's own addr is never PJ.0.1.*, so no self-loop).
        const [project] = (proposedProjectAddr && node)
          ? await tx`
              SELECT addr FROM nodes
              WHERE addr = ${proposedProjectAddr}
                AND space_id = ${node.space_id}
                AND addr LIKE 'PJ.0.1.%'
                AND dormant_at IS NULL`
          : [undefined];

        const decision = evaluateProjectAssociationApply({
          payloadTenantId,
          proposedProjectAddr,
          nodeTenantId: node ? String(node.tenant_id) : null,
          nodeActive: !!node && node.dormant_at == null && node.visibility !== "deleted",
          nodeAlreadyHasProject: !!node && node.has_project === true,
          projectExists: !!project,
          reviewedBy: locked.reviewed_by ? String(locked.reviewed_by) : null,
          requiresReview,
          actor,
        });

        if (decision.decision === "reject") {
          await rejectProposal(tx, locked.id, actor, decision.reason ?? "rejected");
          rejected++;
          return;
        }

        // Idempotency: never double-apply (one apply correlation_id per proposal).
        const applyCorrelationId = projectAssociationCorrelationId(locked, "apply");
        const [dup] = await tx`
          SELECT 1 FROM memory_events
          WHERE addr = ${node.addr} AND tenant_id = ${node.tenant_id} AND correlation_id = ${applyCorrelationId}
          LIMIT 1`;
        if (dup) {
          await rejectProposal(tx, locked.id, actor, "duplicate_project_association_apply_event");
          rejected++;
          return;
        }

        // Apply. The WHERE re-qualifies (active + still projectless) so a concurrent
        // association cannot be clobbered; 0 rows => stale => reject.
        const updated = await tx`
          UPDATE nodes
          SET substance = substance || ${tx.json({ project_addr: proposedProjectAddr })}::jsonb,
              updated_at = now()
          WHERE addr = ${node.addr}
            AND space_id = ${node.space_id}
            AND node_type = 'memory'
            AND dormant_at IS NULL
            AND visibility <> 'deleted'
            AND NOT (substance ? 'project_addr')
          RETURNING addr`;
        if (updated.length === 0) {
          await rejectProposal(tx, locked.id, actor, "memory_changed_during_apply");
          rejected++;
          return;
        }

        await writeEdge(
          tx,
          { fromAddr: node.addr, toAddr: proposedProjectAddr, edgeType: "part_of", confidence: PART_OF_EDGE_CONFIDENCE, spaceId: node.space_id },
          { tx },
        );

        await logEvent(tx, node.addr, String(node.tenant_id), "updated", actor, {
          action: "project_association",
          project_addr: proposedProjectAddr,
          prior_project_addr: null,
          proposal_id: locked.id,
        }, { correlationId: applyCorrelationId });

        await tx`UPDATE proposals SET status = 'applied', applied_at = NOW() WHERE id = ${locked.id}`;
        applied++;
      };
      if (typeof db.begin === "function") await db.begin(run);
      else await run(db);
    } catch (error) {
      console.warn(`[qc-sentinel] failed to apply project association proposal ${proposal.id}:`, (error as Error).message);
    }
  }

  return { applied, rejected };
}

/**
 * Reverse an applied project association: remove substance.project_addr, delete the
 * part_of edge, and write a rollback audit event (correlation_id matches the doctor's
 * 30-day re-proposal suppression pattern). Idempotent on the rollback event. Runs inside
 * the caller's transaction.
 */
export async function reverseProjectAssociationInTx(
  tx: any,
  input: { proposal: { id: number; evidence: unknown }; addr: string; tenantId: string; projectAddr: string; actor: string; reason?: string },
): Promise<void> {
  const tenantSpaceId = `tenant:${input.tenantId}`;
  const correlationId = projectAssociationCorrelationId(input.proposal, "rollback");

  // Idempotency FIRST: if this rollback already ran, do nothing (never re-mutate).
  const [existing] = await tx`
    SELECT 1 FROM memory_events
    WHERE addr = ${input.addr} AND tenant_id = ${input.tenantId} AND correlation_id = ${correlationId} LIMIT 1`;
  if (existing) return;

  // Re-qualify: only strip if the memory CURRENTLY points at this project (mirrors the
  // apply's re-qualify-in-WHERE so we never clobber a since-changed association).
  const stripped = await tx`
    UPDATE nodes SET substance = substance - 'project_addr', updated_at = now()
    WHERE addr = ${input.addr} AND space_id = ${tenantSpaceId} AND node_type = 'memory'
      AND substance->>'project_addr' = ${input.projectAddr}
    RETURNING addr`;
  if (stripped.length === 0) return; // association already changed/removed — nothing to reverse

  // Remove the part_of edge via the canonical helper (journaled symmetrically with the
  // apply's writeEdge), then record the rollback event.
  await deleteEdge(tx, input.addr, input.projectAddr, "part_of", { tx, spaceId: tenantSpaceId });
  await tx`
    INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id)
    VALUES (
      ${input.addr}, ${input.tenantId}, 'supercron_rollback',
      ${tx.json({ proposal_id: input.proposal.id, action: "project_association", reason: input.reason ?? "manual_rollback", project_addr: input.projectAddr })},
      ${input.actor}, ${correlationId}
    )`;
}
