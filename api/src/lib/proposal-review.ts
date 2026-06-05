/**
 * Operator approve/reject of graph proposals (Operator-Apply ladder, OA2).
 *
 * The legacy `proposals` table holds graph proposals of several types, but their apply
 * semantics are NOT uniform — and only some are gated on operator approval:
 *   - APPROVAL-GATED (proposal_type='node_edit'): the downstream appliers
 *     (qc-sentinel: tenant_memory_supersession, project_association via #77, registry
 *     reconciliation, memory_merge hold-queue) read `status='approved'`. For these,
 *     approve → eligible for the already-gated downstream apply; reject → never applied.
 *     OA2 is the human GATE in front of that apply (not the apply itself).
 *   - AUTO-MANAGED (tension / inference / archetype / bare edge): the miners apply or
 *     consume these straight from `status='pending'` on their OWN logic and NEVER read
 *     `status='approved'`. An operator approve would REMOVE them from that pending scan
 *     (dead-letter — the inverse of intent), so OA2 deliberately REFUSES them
 *     (not_operator_gated) rather than silently mislead.
 *
 * So OA2 binds node_edit proposals ONLY. Operator-domain: proposals have no tenant_id
 * (graph-wide), so the endpoint is operator-only (the /ops/* middleware enforces it).
 * Status-transition ONLY — it stamps reviewed_by/reviewed_at and never mutates a
 * node/edge. Pending-only: a re-review of an already approved/rejected/applied proposal
 * is a no-op (not_pending).
 */

import type { Sql } from "postgres";

export const PROPOSAL_REVIEW_ACTIONS = ["approve", "reject"] as const;
export type ProposalReviewAction = (typeof PROPOSAL_REVIEW_ACTIONS)[number];

export function isProposalReviewAction(v: unknown): v is ProposalReviewAction {
  return typeof v === "string" && (PROPOSAL_REVIEW_ACTIONS as readonly string[]).includes(v);
}

/** approve → approved (apply-eligible); reject → rejected (terminal). */
export function proposalReviewStatus(action: ProposalReviewAction): "approved" | "rejected" {
  return action === "approve" ? "approved" : "rejected";
}

/** The ONLY proposal type whose appliers gate on operator approval (status='approved'). */
export const OPERATOR_GATED_PROPOSAL_TYPE = "node_edit";

export interface ReviewProposalResult {
  ok: boolean;
  reason?:
    | "not_found"        // no proposal with this id
    | "not_operator_gated" // an auto-managed type (tension/inference/archetype/edge)
    | "not_pending";     // already approved/rejected/applied
  proposal?: { id: number; proposal_type: string; status: string };
}

/**
 * Transition ONE pending, operator-gated (node_edit) proposal to approved/rejected.
 * The UPDATE is atomic + triply guarded (id + status='pending' + the gated type), so a
 * re-review is a no-op and an auto-managed type can never be dead-lettered. On a miss it
 * does a single follow-up read to give the operator a SPECIFIC reason (graph-wide
 * operator-only surface, so no enumeration concern). Stamps reviewed_by + reviewed_at;
 * never mutates a node/edge.
 */
export async function reviewProposal(
  sql: Sql,
  opts: { id: number; action: ProposalReviewAction; reviewedBy: string },
): Promise<ReviewProposalResult> {
  const status = proposalReviewStatus(opts.action);
  const rows = await sql`
    UPDATE proposals
    SET status = ${status}, reviewed_by = ${opts.reviewedBy}, reviewed_at = now()
    WHERE id = ${opts.id} AND status = 'pending' AND proposal_type = ${OPERATOR_GATED_PROPOSAL_TYPE}
    RETURNING id, proposal_type, status
  `;
  if (rows.length > 0) {
    const row = rows[0] as { id: number; proposal_type: string; status: string };
    return { ok: true, proposal: row };
  }
  // Miss — classify so the operator gets a specific, actionable reason.
  const [info] = await sql`SELECT proposal_type, status FROM proposals WHERE id = ${opts.id}`;
  if (!info) return { ok: false, reason: "not_found" };
  if (info.proposal_type !== OPERATOR_GATED_PROPOSAL_TYPE) return { ok: false, reason: "not_operator_gated" };
  return { ok: false, reason: "not_pending" };
}
