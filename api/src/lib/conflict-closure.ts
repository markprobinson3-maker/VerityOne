/**
 * Operator/tenant closure of detected memory conflicts (Operator-Apply ladder, OA3).
 *
 * detectMemoryConflicts records active-active contradictions as memory_conflicts rows
 * with status='detected'; getActiveConflicts + recall surface exactly those. This is the
 * action half — letting the owner close ONE conflict out of `detected`:
 *   - resolve  → status='resolved'  (reviewed/adjudicated; stop warning on it)
 *   - dismiss  → status='dismissed' (a false positive — not a real contradiction)
 *
 * Status-transition ONLY. It NEVER retires or mutates either memory — both addr_a and
 * addr_b stay exactly as they were. Actually erasing the contradiction by retiring the
 * losing memory is the DESTRUCTIVE half and lives in a separate, dry-run'd OA rung; OA3
 * deliberately stops at closing the conflict record so an operator can clear the queue
 * (and the recall conflict warnings) without any irreversible graph mutation.
 *
 * The write is tenant-scoped (a caller can only close its OWN tenant's conflicts) and
 * detected-only (idempotent: re-closing an already resolved/dismissed conflict matches
 * nothing and is reported not_found_or_closed — it can never flip a closed row).
 * resolved_by records the human/operator actor straight into the row for audit.
 */

import type { Sql } from "postgres";

export const CONFLICT_CLOSE_ACTIONS = ["resolve", "dismiss"] as const;
export type ConflictCloseAction = (typeof CONFLICT_CLOSE_ACTIONS)[number];

export function isConflictCloseAction(v: unknown): v is ConflictCloseAction {
  return typeof v === "string" && (CONFLICT_CLOSE_ACTIONS as readonly string[]).includes(v);
}

/** resolve → resolved (adjudicated); dismiss → dismissed (false positive). The two
 *  terminal states match the convention the automated helpers already set
 *  (dismissRetiredEndpointConflicts → 'dismissed', resolveConflict → 'resolved'); OA3 is
 *  the operator-driven equivalent that lets a human pick which terminal state applies. */
export function conflictCloseStatus(action: ConflictCloseAction): "resolved" | "dismissed" {
  return action === "resolve" ? "resolved" : "dismissed";
}

/** Discriminated union: a `conflict` is present IFF ok, a `reason` IFF not — the type
 *  itself forbids the ok:false-with-conflict (or ok:true-with-reason) shape, so callers
 *  never need a non-null assertion to read the closed row. */
export type CloseConflictResult =
  | { ok: true; conflict: { id: number; status: string } }
  /** not_found_or_closed: the conflict is absent, owned by another tenant, or already
   *  closed. Never leaks another tenant's data — the scope is in the WHERE. */
  | { ok: false; reason: "not_found_or_closed" };

/**
 * Close ONE detected conflict owned by `tenantId`. Tenant-scoped + detected-only in the
 * WHERE, so a caller can never close another tenant's conflict or re-close a closed one.
 * Stamps resolved_by + resolved_at and RETURNs only (id, status) — never the addrs or
 * timestamps, so the HTTP response cannot leak conflict internals. Returns the updated
 * row, or not_found_or_closed when the scoped/detected predicate matched nothing.
 *
 * SAFETY (the OA3 non-destructive invariant): this function ONLY updates
 * memory_conflicts.status/resolved_by/resolved_at. It MUST NOT call
 * transitionMemoryLifecycle, any retire/dormant helper, or anything that mutates
 * nodes/edges/memory_registry — retiring the losing memory is a separate, dry-run'd rung.
 * The foundation-state-drift OA3 pins assert this file stays free of those calls.
 */
export async function closeConflict(
  sql: Sql,
  opts: { id: number; tenantId: string; action: ConflictCloseAction; resolvedBy: string },
): Promise<CloseConflictResult> {
  const status = conflictCloseStatus(opts.action);
  const rows = await sql`
    UPDATE memory_conflicts
    SET status = ${status}, resolved_by = ${opts.resolvedBy}, resolved_at = now()
    WHERE id = ${opts.id}
      AND tenant_id = ${opts.tenantId}
      AND status = 'detected'
    RETURNING id, status
  `;
  if (rows.length === 0) return { ok: false, reason: "not_found_or_closed" };
  // memory_conflicts.id is BIGINT — postgres.js hands it back as a STRING. Coerce to a
  // number so the returned shape matches the declared type and the HTTP response carries a
  // clean numeric id (the route already bounds the inbound id at MAX_SAFE_INTEGER).
  const row = rows[0] as { id: string | number; status: string };
  return { ok: true, conflict: { id: Number(row.id), status: row.status } };
}
