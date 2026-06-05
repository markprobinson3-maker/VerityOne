/**
 * Operator/tenant resolution of #65 review proposals (Operator-Apply ladder, OA1).
 *
 * LW4 persists review packets into review_proposals and LW5 surfaces them on the
 * dashboard attention feed; this is the action half — letting the owner transition a
 * proposal out of `open`:
 *   - resolve  → status='resolved'  (the review was acted on / accepted)
 *   - dismiss  → status='dismissed' (not worth pursuing)
 *   - defer    → stays 'open', snoozed via next_review_at (re-surface later)
 *
 * Status-transition ONLY — it never mutates a memory/node/edge (the graph-mutating
 * applies are later OA rungs). The write is tenant-scoped (a caller can only resolve
 * its OWN tenant's proposals) and only acts on an `open` proposal (idempotent: a
 * re-resolve of an already-closed proposal is a no-op, reported as not-found-or-closed).
 */

import type { Sql } from "postgres";

export const REVIEW_PROPOSAL_ACTIONS = ["resolve", "dismiss", "defer"] as const;
export type ReviewProposalAction = (typeof REVIEW_PROPOSAL_ACTIONS)[number];

export function isReviewProposalAction(v: unknown): v is ReviewProposalAction {
  return typeof v === "string" && (REVIEW_PROPOSAL_ACTIONS as readonly string[]).includes(v);
}

const DEFAULT_DEFER_DAYS = 7;
const MAX_DEFER_DAYS = 365;

export interface ReviewProposalTransition {
  /** The post-transition status. defer keeps it 'open' (a snooze, not a close). */
  status: "resolved" | "dismissed" | "open";
  /** When to re-surface a deferred proposal; null for resolve/dismiss. */
  next_review_at: string | null;
}

/**
 * PURE: compute the status + next_review_at for an action. defer clamps its window to
 * [1, 365] days off the caller's snapshot anchor (no clock here). resolve/dismiss close
 * the proposal and clear next_review_at.
 */
export function planReviewProposalTransition(
  action: ReviewProposalAction,
  opts: { generatedAt: string; deferDays?: number },
): ReviewProposalTransition {
  if (action === "resolve") return { status: "resolved", next_review_at: null };
  if (action === "dismiss") return { status: "dismissed", next_review_at: null };
  const raw = opts.deferDays;
  const days = typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 1), MAX_DEFER_DAYS)
    : DEFAULT_DEFER_DAYS;
  const next = new Date(new Date(opts.generatedAt).getTime() + days * 86_400_000);
  return { status: "open", next_review_at: next.toISOString() };
}

/** Discriminated union (matches OA3/OA4/retire): a `proposal` is present IFF ok, a `reason` IFF
 *  not — the type forbids the ok:false-with-proposal shape, so callers never need a non-null
 *  assertion. The single non-disambiguating reason is DELIBERATE: not revealing WHICH of
 *  absent / foreign-tenant / already-closed matched prevents cross-tenant id enumeration (OA1 is
 *  tenant-scoped). OA2 can afford granular reasons because it is operator-domain (graph-wide). */
export type ResolveReviewProposalResult =
  | { ok: true; proposal: { id: number; status: string; next_review_at: string | null } }
  | { ok: false; reason: "not_found_or_closed" };

/**
 * Apply a resolution to ONE open review proposal owned by `tenantId`. Tenant-scoped +
 * open-only in the WHERE, so a caller can never transition another tenant's proposal or
 * re-close a closed one. Returns the updated row, or not_found_or_closed when the
 * scoped/open predicate matched nothing.
 */
export async function resolveReviewProposal(
  sql: Sql,
  opts: { id: number; tenantId: string; action: ReviewProposalAction; deferDays?: number; generatedAt: string },
): Promise<ResolveReviewProposalResult> {
  const t = planReviewProposalTransition(opts.action, { generatedAt: opts.generatedAt, deferDays: opts.deferDays });
  const rows = await sql`
    UPDATE review_proposals
    SET status = ${t.status}, next_review_at = ${t.next_review_at}, updated_at = now()
    WHERE id = ${opts.id}
      AND tenant_id = ${opts.tenantId}
      AND status = 'open'
    RETURNING id, status, next_review_at
  `;
  if (rows.length === 0) return { ok: false, reason: "not_found_or_closed" };
  // review_proposals.id is BIGINT — postgres.js returns it as a STRING. Coerce so the API
  // contract carries a numeric id (matches OA3's closeConflict; the route bounds the inbound id).
  const row = rows[0] as { id: string | number; status: string; next_review_at: string | null };
  return { ok: true, proposal: { id: Number(row.id), status: row.status, next_review_at: row.next_review_at } };
}
