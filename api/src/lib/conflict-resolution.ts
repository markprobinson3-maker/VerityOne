/**
 * Operator/tenant DESTRUCTIVE conflict resolution — retire the losing memory (Operator-Apply
 * ladder; the destructive half deferred from OA3 conflict closure).
 *
 * OA3 closeConflict only closes the conflict RECORD; the contradiction's two memories both
 * stay live. This rung actually resolves the contradiction: the operator picks the WINNER of a
 * detected conflict, and the LOSER is retired by superseding it with the winner (its node goes
 * dormant + its registry status becomes 'superseded', moved together atomically by
 * transitionMemoryLifecycleInTx so no torn lifecycle invariant is created), and the conflict
 * is marked resolved — all in ONE transaction.
 *
 * Safety rails (this is the first API surface that retires a memory):
 *   - DRY-RUN is the DEFAULT: the preview is READ-ONLY (it never runs the mutation, not even
 *     rolled back) and reports exactly what apply would do or why it would refuse.
 *   - Protected memories are NEVER auto-retired: transitionMemoryLifecycleInTx enforces the
 *     protected-dormancy guard (enforceProtectedGuard:true) and the preview mirrors it.
 *   - Reversible + audited: a superseded memory can be restored (dormant_at cleared, status
 *     reset); every apply writes a lifecycle event + an admin audit row.
 *   - Tenant-scoped + detected-only: a caller can only resolve its OWN tenant's open conflict.
 */

import type { Sql } from "postgres";

import { MEMORY_LIFECYCLE_ERROR, isProtectedMemoryForAutomatedDormancy, transitionMemoryLifecycleInTx } from "./memory-lifecycle";

/** Thrown inside the apply tx to force a rollback (transition refused, or the conflict was no
 *  longer detected when we went to resolve it). Carries the reason the caller should report. */
class ConflictResolveRollback extends Error {
  constructor(readonly result: { reason: "not_found" | "loser_protected" | "winner_not_eligible" | "transition_failed"; detail?: string }) {
    super("__conflict_resolve_rollback__");
  }
}

export type ResolveWinnerOutcome =
  | "dry_run"         // preview: the loser WOULD be superseded by the winner
  | "resolved"        // applied: loser retired (superseded), conflict resolved
  | "already_retired"; // the loser was already dead → the conflict is just closed (no retirement)

export type ResolveConflictWithWinnerResult =
  | { ok: true; outcome: ResolveWinnerOutcome; winner: string; loser: string }
  | {
      ok: false;
      reason:
        | "not_found"            // no detected conflict with this id in this tenant
        | "winner_not_in_pair"   // winner_addr is neither addr_a nor addr_b
        | "loser_protected"      // the loser is a protected memory (never auto-retired)
        | "winner_not_eligible"  // the winner is not a live, active memory to supersede with
        | "transition_failed";   // the lifecycle transition refused at apply (race / guard)
      detail?: string;
    };

interface MemoryState {
  exists: boolean;
  dead: boolean; // dormant_at set OR visibility dormant/deleted/merged OR registry not active
  protectedMemory: boolean;
}

async function loadMemoryState(sql: Sql, addr: string, tenantId: string): Promise<MemoryState> {
  // Tenant-isolated by construction: the registry JOIN is filtered by r.tenant_id and the node
  // by space_id = 'tenant:<id>', so a foreign-tenant (or missing) addr matches nothing and
  // returns {exists:false, dead:true} — a foreign winner reads as ineligible, a foreign loser
  // as already-dead. Read-only.
  const [row] = await sql`
    SELECT
      (n.dormant_at IS NOT NULL OR n.visibility IN ('dormant', 'deleted', 'merged')) AS node_dead,
      n.pinned, n.substance,
      r.status AS reg_status, r.kind, r.source_kind, r.accepted_by_user
    FROM nodes n
    JOIN memory_registry r ON r.addr = n.addr AND r.tenant_id = ${tenantId}
    WHERE n.addr = ${addr} AND n.space_id = ${`tenant:${tenantId}`} AND n.node_type = 'memory'
  `;
  if (!row) return { exists: false, dead: true, protectedMemory: false };
  const dead = row.node_dead === true || row.reg_status !== "active";
  return {
    exists: true,
    dead,
    protectedMemory: isProtectedMemoryForAutomatedDormancy({
      kind: row.kind,
      status: row.reg_status,
      source_kind: row.source_kind,
      accepted_by_user: row.accepted_by_user,
      pinned: row.pinned,
      substance: row.substance,
    }),
  };
}

/** Map a transitionMemoryLifecycleInTx refusal to a caller reason via EXACT constant equality
 *  (a message reword breaks the build, not the classification — see MEMORY_LIFECYCLE_ERROR). */
function mapTransitionError(error: string | undefined): "loser_protected" | "winner_not_eligible" | "transition_failed" {
  if (error === MEMORY_LIFECYCLE_ERROR.PROTECTED_FROM_DORMANCY) return "loser_protected";
  if (error === MEMORY_LIFECYCLE_ERROR.SUPERSEDING_NOT_FOUND_OR_INACTIVE) return "winner_not_eligible";
  return "transition_failed";
}

/**
 * Resolve ONE detected conflict by retiring the loser in favour of `winnerAddr`. Read-only when
 * dryRun; otherwise atomically supersedes the loser by the winner and marks the conflict
 * resolved. Tenant-scoped + detected-only; protected losers and ineligible winners are refused.
 */
export async function resolveConflictWithWinner(
  sql: Sql,
  opts: { id: number; tenantId: string; winnerAddr: string; dryRun: boolean; resolvedBy: string },
): Promise<ResolveConflictWithWinnerResult> {
  // Bound the actor recorded into the audit/event trail (the route derives it from the token,
  // but guard against a corrupt/oversized agentId corrupting the trail).
  if (typeof opts.resolvedBy !== "string" || opts.resolvedBy.length === 0 || opts.resolvedBy.length > 256) {
    return { ok: false, reason: "transition_failed", detail: "invalid actor" };
  }
  // addr_a/addr_b are immutable once a conflict is detected, so this early fetch stays valid for
  // the rest of the call; the destructive apply re-asserts status='detected' under the tx.
  const [conflict] = await sql`
    SELECT addr_a, addr_b FROM memory_conflicts
    WHERE id = ${opts.id} AND tenant_id = ${opts.tenantId} AND status = 'detected'
  `;
  if (!conflict) return { ok: false, reason: "not_found" };
  if (opts.winnerAddr !== conflict.addr_a && opts.winnerAddr !== conflict.addr_b) {
    return { ok: false, reason: "winner_not_in_pair" };
  }
  const loser = opts.winnerAddr === conflict.addr_a ? conflict.addr_b : conflict.addr_a;

  const loserState = await loadMemoryState(sql, loser, opts.tenantId);

  // Loser already dead → the contradiction is gone; resolving the conflict needs no retirement.
  if (loserState.dead) {
    if (!opts.dryRun) {
      await sql`
        UPDATE memory_conflicts SET status = 'resolved', resolved_by = ${opts.resolvedBy}, resolved_at = now()
        WHERE id = ${opts.id} AND tenant_id = ${opts.tenantId} AND status = 'detected'
      `;
    }
    return { ok: true, outcome: "already_retired", winner: opts.winnerAddr, loser };
  }

  // Preview-side guards (mirror the authoritative apply-side guards in
  // transitionMemoryLifecycleInTx; the FOR UPDATE locks there serialize any concurrent change to
  // the loser/winner between this preview and the apply, so a dry run's verdict cannot silently
  // go stale under the apply).
  if (loserState.protectedMemory) return { ok: false, reason: "loser_protected" };
  const winnerState = await loadMemoryState(sql, opts.winnerAddr, opts.tenantId);
  if (!winnerState.exists || winnerState.dead) return { ok: false, reason: "winner_not_eligible" };

  if (opts.dryRun) return { ok: true, outcome: "dry_run", winner: opts.winnerAddr, loser };

  // Apply: retire the loser (supersede by winner) AND close the conflict, atomically in ONE tx.
  //  - The transition's own guards (protected, winner-live, locks) are AUTHORITATIVE — a refusal
  //    (e.g. a race since the preview) rolls the whole tx back; the loser is NOT retired.
  //  - The conflict UPDATE is COUNT-CHECKED: if the conflict is no longer 'detected' (a concurrent
  //    close — e.g. OA3 dismissed it as a false positive — landed between our fetch and here), we
  //    roll back so we NEVER retire a memory for a conflict that is no longer detected.
  let failure: ConflictResolveRollback["result"] | null = null;
  await sql.begin(async (tx: any) => {
    const t = await transitionMemoryLifecycleInTx(tx as Sql, {
      addr: loser,
      tenantId: opts.tenantId,
      status: "superseded",
      supersededByAddr: opts.winnerAddr,
      actor: opts.resolvedBy,
      reason: "conflict_resolution",
      enforceProtectedGuard: true,
      eventData: { conflict_id: opts.id, winner_addr: opts.winnerAddr },
    });
    if (!t.ok) throw new ConflictResolveRollback({ reason: mapTransitionError(t.error), detail: t.error });
    const closed = await tx`
      UPDATE memory_conflicts SET status = 'resolved', resolved_by = ${opts.resolvedBy}, resolved_at = now()
      WHERE id = ${opts.id} AND tenant_id = ${opts.tenantId} AND status = 'detected'
      RETURNING id
    `;
    if (closed.length === 0) {
      throw new ConflictResolveRollback({ reason: "not_found", detail: "conflict no longer detected at apply" });
    }
  }).catch((e: unknown) => {
    if (e instanceof ConflictResolveRollback) { failure = e.result; return; }
    // A real (unexpected) error — the tx already rolled back; surface it with context.
    console.error(`[conflict-resolution] apply failed for conflict ${opts.id} (winner ${opts.winnerAddr}):`, e);
    throw e;
  });

  if (failure) return { ok: false, ...(failure as ConflictResolveRollback["result"]) };
  return { ok: true, outcome: "resolved", winner: opts.winnerAddr, loser };
}
