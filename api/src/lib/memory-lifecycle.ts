/**
 * Memory lifecycle operations — create, update, supersede, retract, forget, expire.
 *
 * All mutations go through these functions so that the memory_registry and
 * memory_events tables stay in sync with the graph.
 */

import type { Sql } from "postgres";
import type { MemoryKind, MemoryStatus, SourceKind } from "./memory-contract";

// ── Types ──

export interface RegistryInsert {
  addr: string;
  tenantId: string;
  kind: MemoryKind;
  sourceKind: SourceKind;
  sourceRef?: string;
  acceptedByUser: boolean;
  effectiveAt?: string;
  expiresAt?: string;
  supersedesAddr?: string;
}

export type EventType =
  | "created"
  | "updated"
  | "superseded"
  | "retracted"
  | "archived"
  | "expired"
  | "validated"
  | "conflict_detected"
  | "conflict_resolved";

export const AUTOMATED_DORMANCY_PROTECTED_KINDS = new Set([
  "decision",
  "preference",
  "correction",
  "vision",
]);

export const AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGES = new Set([
  "permanent",
  "consolidated",
]);

export const AUTOMATED_DORMANCY_PROTECTED_KIND_LIST = [...AUTOMATED_DORMANCY_PROTECTED_KINDS];
export const AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST = [...AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGES];

export function isProtectedMemoryForAutomatedDormancy(row: {
  kind?: string | null;
  status?: string | null;
  source_kind?: string | null;
  accepted_by_user?: boolean | null;
  pinned?: boolean | null;
  substance?: Record<string, unknown> | null;
}): boolean {
  if (row.status && row.status !== "active") return true;
  if (row.accepted_by_user === true) return true;
  if (row.source_kind === "user_accepted") return true;
  if (row.kind && AUTOMATED_DORMANCY_PROTECTED_KINDS.has(row.kind)) return true;
  if (row.pinned === true) return true;

  const maturityStage = row.substance?.maturity_stage;
  return typeof maturityStage === "string"
    && AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGES.has(maturityStage);
}

// ── Registry operations ──

export async function insertRegistry(sql: Sql, insert: RegistryInsert): Promise<void> {
  await sql`
    INSERT INTO memory_registry (addr, tenant_id, kind, status, accepted_by_user, source_kind, source_ref, effective_at, expires_at, supersedes_addr)
    VALUES (
      ${insert.addr},
      ${insert.tenantId},
      ${insert.kind},
      'active',
      ${insert.acceptedByUser},
      ${insert.sourceKind},
      ${insert.sourceRef || null},
      ${insert.effectiveAt || new Date().toISOString()},
      ${insert.expiresAt || null},
      ${insert.supersedesAddr || null}
    )
    ON CONFLICT (addr) DO UPDATE SET
      kind = EXCLUDED.kind,
      status = 'active',
      accepted_by_user = EXCLUDED.accepted_by_user,
      source_kind = EXCLUDED.source_kind,
      updated_at = now()
  `;

  // Supersession of the previous memory is intentionally not performed here.
  // Call transitionMemoryLifecycle* after the new registry row exists so the
  // old memory's node, registry, event log, and journal move together.
}

export async function updateRegistryStatus(
  sql: Sql,
  addr: string,
  tenantId: string,
  status: MemoryStatus,
): Promise<void> {
  await sql`
    UPDATE memory_registry
    SET status = ${status}, updated_at = now()
    WHERE addr = ${addr} AND tenant_id = ${tenantId}
  `;
}

// ── Event logging ──

/**
 * F9: optional `correlationId` is passed via the options object so
 * future fields (e.g. session_id) can land without positional drift.
 * The id is written to the new `memory_events.correlation_id` column,
 * not duplicated into `event_data` (column is the canonical source).
 */
export interface LogEventOptions {
  correlationId?: string | null;
  createdAt?: string | Date | null;
}

export async function logEvent(
  sql: Sql,
  addr: string,
  tenantId: string,
  eventType: EventType,
  actor: string | null,
  eventData?: Record<string, unknown>,
  opts: LogEventOptions = {},
): Promise<void> {
  const createdAt = opts.createdAt instanceof Date
    ? opts.createdAt.toISOString()
    : opts.createdAt ?? null;
  await sql`
    INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id, created_at)
    VALUES (
      ${addr}, ${tenantId}, ${eventType},
      ${sql.json((eventData || {}) as any)}, ${actor},
      ${opts.correlationId ?? null},
      COALESCE(${createdAt}::timestamptz, now())
    )
  `;
}

export const MEMORY_LIFECYCLE_TRANSITION_STATUS_LIST = [
  "superseded",
  "retracted",
  "archived",
  "expired",
] as const;

const MEMORY_LIFECYCLE_TRANSITION_STATUSES = new Set<string>(
  MEMORY_LIFECYCLE_TRANSITION_STATUS_LIST,
);

export type MemoryLifecycleTransitionStatus =
  typeof MEMORY_LIFECYCLE_TRANSITION_STATUS_LIST[number];

/**
 * Canonical refusal messages returned in MemoryLifecycleTransitionResult.error. Callers that
 * branch on a refusal (e.g. conflict-resolution's mapTransitionError) MUST compare against
 * these constants — never a hand-typed substring — so a message reword is a compile-time break,
 * not a silently mis-classified destructive refusal.
 */
export const MEMORY_LIFECYCLE_ERROR = {
  PROTECTED_FROM_DORMANCY: "Memory is protected from automated dormancy",
  SUPERSEDING_NOT_FOUND_OR_INACTIVE: "Superseding memory not found or inactive",
  ALREADY_DORMANT: "Memory is already dormant",
} as const;

export interface MemoryLifecycleTransitionInput {
  addr: string;
  tenantId: string;
  status: MemoryLifecycleTransitionStatus;
  actor: string;
  reason?: string | null;
  supersededByAddr?: string | null;
  correlationId?: string | null;
  eventData?: Record<string, unknown>;
  enforceProtectedGuard?: boolean;
  proposalId?: number;
}

export interface MemoryLifecycleTransitionResult {
  ok: boolean;
  addr: string;
  status?: string;
  changed?: boolean;
  eventWritten?: boolean;
  error?: string;
}

/**
 * Standalone lifecycle transition wrapper. It opens `sql.begin`; if callers
 * pass an existing postgres.js transaction handle, postgres.js creates a
 * savepoint. Call transitionMemoryLifecycleInTx directly when the lifecycle
 * mutation must be part of a larger all-or-nothing transaction.
 */
export async function transitionMemoryLifecycle(
  sql: Sql,
  input: MemoryLifecycleTransitionInput,
): Promise<MemoryLifecycleTransitionResult> {
  return await sql.begin(async (tx: any) => transitionMemoryLifecycleInTx(tx, input));
}

export async function transitionMemoryLifecycleInTx(
  tx: Sql,
  input: MemoryLifecycleTransitionInput,
): Promise<MemoryLifecycleTransitionResult> {
  const tenantSpaceId = `tenant:${input.tenantId}`;
  if (!MEMORY_LIFECYCLE_TRANSITION_STATUSES.has(input.status as string)) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: `Invalid lifecycle status: ${input.status}` };
  }
  if (input.status === "superseded" && !input.supersededByAddr) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: "Superseding memory is required" };
  }
  if (input.addr === input.supersededByAddr) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: "Memory cannot supersede itself" };
  }

  const [{ now: transitionAt }] = await tx`SELECT clock_timestamp()::text AS now`;
  const lockedAddrs = input.status === "superseded"
    ? [input.addr, input.supersededByAddr as string].sort()
    : [input.addr];

  const lockedNodes = await tx`
    SELECT addr, dormant_at, pinned, substance, substance->>'project_addr' AS project_addr
    FROM nodes
    WHERE addr = ANY(${lockedAddrs}::text[])
      AND space_id = ${tenantSpaceId}
      AND node_type = 'memory'
      AND visibility <> 'deleted'
    ORDER BY addr
    FOR UPDATE
  `;
  const existing = lockedNodes.find((row: any) => row.addr === input.addr);
  if (!existing) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: "Memory not found" };
  }
  if (existing.dormant_at) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: MEMORY_LIFECYCLE_ERROR.ALREADY_DORMANT };
  }

  const lockedRegistryRows = await tx`
    SELECT addr, status, kind, source_kind, accepted_by_user
    FROM memory_registry
    WHERE addr = ANY(${lockedAddrs}::text[])
      AND tenant_id = ${input.tenantId}
    ORDER BY addr
    FOR UPDATE
  `;
  const existingRegistry = lockedRegistryRows.find((row: any) => row.addr === input.addr);
  if (!existingRegistry || existingRegistry.status !== "active") {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: "Memory registry missing or inactive" };
  }

  if (input.enforceProtectedGuard === true && isProtectedMemoryForAutomatedDormancy({
    kind: existingRegistry.kind,
    source_kind: existingRegistry.source_kind,
    accepted_by_user: existingRegistry.accepted_by_user,
    pinned: existing.pinned,
    substance: existing.substance,
  })) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: MEMORY_LIFECYCLE_ERROR.PROTECTED_FROM_DORMANCY };
  }

  if (input.status === "superseded") {
    const successor = lockedNodes.find((row: any) => row.addr === input.supersededByAddr);
    const successorRegistry = lockedRegistryRows.find((row: any) => row.addr === input.supersededByAddr);
    if (!successor || successor.dormant_at || !successorRegistry || successorRegistry.status !== "active") {
      return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: MEMORY_LIFECYCLE_ERROR.SUPERSEDING_NOT_FOUND_OR_INACTIVE };
    }
  }

  const normalizedReason = input.reason || null;
  const substancePatch: Record<string, unknown> = {
    lifecycle_status: input.status,
    [`${input.status}_at`]: transitionAt,
  };
  if (input.reason !== undefined) {
    substancePatch[`${input.status}_reason`] = normalizedReason;
  }
  if (input.status === "superseded") {
    substancePatch.superseded_by = input.supersededByAddr;
    substancePatch.superseded_by_addr = input.supersededByAddr;
  }
  if (input.proposalId !== undefined) {
    substancePatch.lifecycle_proposal_id = input.proposalId;
  }

  const updated = await tx`
    UPDATE nodes SET
      substance = substance || ${tx.json(substancePatch as any)}::jsonb,
      dormant_at = COALESCE(dormant_at, ${transitionAt}::timestamptz),
      visibility = 'dormant',
      updated_at = ${transitionAt}::timestamptz
    WHERE addr = ${input.addr}
      AND space_id = ${tenantSpaceId}
      AND node_type = 'memory'
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
  `;
  if (updated.count === 0) {
    return { ok: false, addr: input.addr, changed: false, eventWritten: false, error: "Memory not transitioned" };
  }

  await tx`
    UPDATE memory_registry SET
      status = ${input.status},
      superseded_by_addr = CASE
        WHEN ${input.status} = 'superseded' THEN ${input.supersededByAddr ?? null}
        ELSE superseded_by_addr
      END,
      updated_at = ${transitionAt}::timestamptz
    WHERE addr = ${input.addr}
      AND tenant_id = ${input.tenantId}
  `;

  await logEvent(tx, input.addr, input.tenantId, input.status, input.actor, {
    ...(input.eventData ?? {}),
    reason: normalizedReason,
    ...(input.status === "superseded" ? { superseded_by_addr: input.supersededByAddr } : {}),
    ...(input.proposalId !== undefined ? { proposal_id: input.proposalId } : {}),
  }, { correlationId: input.correlationId ?? null, createdAt: transitionAt });

  // Dynamic import keeps sync-journal from becoming part of the
  // memory-lifecycle module's eager dependency graph.
  const { tryJournalMemoryInTx } = await import("./sync-journal-port");
  await tryJournalMemoryInTx(tx as any, "tombstone", input.addr, tenantSpaceId, existing.project_addr, "[memory-lifecycle]");

  return { ok: true, addr: input.addr, status: input.status, changed: true, eventWritten: true };
}

// ── Conflict operations ──

export async function detectConflict(
  sql: Sql,
  tenantId: string,
  addrA: string,
  addrB: string,
  conflictType: string,
  description: string | null,
): Promise<number> {
  // Memory-Health PR 4: canonicalize the pair order (addr_a < addr_b) so (A,B) and
  // (B,A) collapse to the SAME row under UNIQUE(addr_a, addr_b, conflict_type) — a
  // reverse-order duplicate conflict row can never be inserted. A self-conflict (an
  // addr against itself) is meaningless, so skip it. This is THE canonical writer:
  // all conflict inserts route through here (the /memory/create path calls it too).
  // NOTE: after canonicalization addr_a/addr_b carry NO new-vs-existing direction —
  // they are simply the lexically-smaller/larger endpoint. Consumers must treat the
  // pair symmetrically (getActiveConflicts, recall, review-queue already do).
  if (!addrA || !addrB || addrA === addrB) return 0;
  const [a, b] = addrA < addrB ? [addrA, addrB] : [addrB, addrA];
  const [row] = await sql`
    INSERT INTO memory_conflicts (tenant_id, addr_a, addr_b, conflict_type, description)
    VALUES (${tenantId}, ${a}, ${b}, ${conflictType}, ${description})
    ON CONFLICT (addr_a, addr_b, conflict_type) DO NOTHING
    RETURNING id
  `;
  return row?.id || 0;
}

/**
 * Auto-dismiss detected conflicts where EITHER endpoint is retired (dormant/deleted/
 * merged) or no longer exists. Keeps the conflict queue — and the recall conflict
 * warnings (which filter status='detected') — to ACTIVE-ACTIVE contradictions, so a
 * conflict whose other side was retired stops degrading agent trust posture.
 * status='dismissed' is a distinct terminal state from resolveConflict's 'resolved'.
 * Returns the number dismissed. Scope to a tenant via opts.tenantId.
 */
export async function dismissRetiredEndpointConflicts(
  sql: Sql,
  opts: { tenantId?: string } = {},
): Promise<number> {
  const tenantScope = opts.tenantId ? sql`AND c.tenant_id = ${opts.tenantId}` : sql``;
  // Dismiss when EITHER endpoint is not a LIVE node — i.e. there is no node row for it
  // in the conflict's OWN tenant space that recall would surface. The live predicate
  // is recall's exact candidate eligibility (dormant_at IS NULL AND visibility <>
  // 'deleted'; recall-compiler.ts), so "dismissed == not-both-recall-eligible" holds
  // precisely — a merged-but-still-recall-eligible memory's conflict is NOT dropped.
  // It covers retired (dormant) AND missing endpoints. The n.space_id = tenant:<id>
  // join scopes liveness to the conflict's own tenant (defense-in-depth: node addrs
  // are global PKs, so this only matters if a foreign-tenant addr ever leaked into a
  // conflict row). Surviving 'detected' rows are exactly the active-active pairs.
  const rows = await sql`
    UPDATE memory_conflicts c
    SET status = 'dismissed', resolved_by = 'auto:retired_endpoint', resolved_at = now()
    WHERE c.status = 'detected'
      ${tenantScope}
      AND (
        NOT EXISTS (
          SELECT 1 FROM nodes n
          WHERE n.addr = c.addr_a AND n.space_id = ('tenant:' || c.tenant_id)
            AND n.dormant_at IS NULL AND n.visibility <> 'deleted'
        )
        OR NOT EXISTS (
          SELECT 1 FROM nodes n
          WHERE n.addr = c.addr_b AND n.space_id = ('tenant:' || c.tenant_id)
            AND n.dormant_at IS NULL AND n.visibility <> 'deleted'
        )
      )
    RETURNING id
  `;
  return rows.length;
}

export async function resolveConflict(
  sql: Sql,
  conflictId: number,
  resolvedBy: string,
): Promise<void> {
  await sql`
    UPDATE memory_conflicts
    SET status = 'resolved', resolved_by = ${resolvedBy}, resolved_at = now()
    WHERE id = ${conflictId}
  `;
}

// ── Query helpers ──

export async function getActiveMemoryCount(
  sql: Sql,
  tenantId: string,
): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int as count FROM memory_registry
    WHERE tenant_id = ${tenantId} AND status = 'active'
  `;
  return row?.count || 0;
}

export async function getMemoryEvents(
  sql: Sql,
  addr: string,
  tenantId: string,
  limit = 20,
): Promise<Array<{ event_type: string; event_data: unknown; actor: string; created_at: string }>> {
  // Scope events to the caller's tenant. `addr` is a global PK on nodes, but
  // memory_events carries its own tenant_id and is NOT FK-bound to the owning
  // node, so an addr can accrue events from another tenant. Filtering by
  // tenant_id prevents a tenant from reading another tenant's lifecycle events.
  return sql`
    SELECT event_type, event_data, actor, created_at
    FROM memory_events
    WHERE addr = ${addr}
      AND tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/**
 * List recent lifecycle events across the entire tenant, joined with
 * memory node metadata. For the dashboard activity feed.
 *
 * Tenant-scoped by construction: filters on memory_events.tenant_id
 * AND joins to nodes via space_id = 'tenant:<tenantId>'.
 */
/**
 * Filter a list of mirrored activity rows against the tenant's
 * pyramid-ceiling `managed_project_addrs`. Used by:
 *   - sync-exporter.ts      — export-side filter (mirror never contains forbidden rows)
 *   - /portal/activity      — route-side defense-in-depth before JSON output
 *   - /my/activity          — route-side defense-in-depth before HTML output
 *
 * Single source of truth so the three surfaces cannot drift.
 *
 * Rules: when `managedAddrs === null`, no pyramid ceiling is active — pass
 * every row through. When `managedAddrs` is a string[], fail closed unless the
 * row has a non-empty `project_addr` that is in the allowlist. This matches
 * memory list/detail and review visibility under an active managed-project
 * ceiling.
 */
export function filterActivityByManagedAddrs<
  T extends { project_addr?: string | null }
>(rows: readonly T[], managedAddrs: string[] | null): T[] {
  if (!Array.isArray(rows)) return [];
  if (managedAddrs === null) return rows.slice();
  const allow = new Set(managedAddrs);
  return rows.filter((r) => {
    const p = r.project_addr;
    return typeof p === "string" && p.length > 0 && allow.has(p);
  });
}

export async function listRecentTenantEvents(
  sql: Sql,
  tenantId: string,
  limit: number = 50,
  projectAddr?: string | null,
): Promise<Array<{
  addr: string;
  label: string | null;
  kind: string | null;
  event_type: string;
  actor: string | null;
  created_at: string;
  event_data: unknown;
  project_addr: string | null;
}>> {
  const spaceId = `tenant:${tenantId}`;
  const projectFilter = projectAddr
    ? sql`AND n.substance->>'project_addr' = ${projectAddr}`
    : sql``;
  return sql`
    SELECT
      e.addr,
      n.label,
      n.substance->>'memory_type' as kind,
      e.event_type,
      e.actor,
      e.created_at,
      e.event_data,
      n.substance->>'project_addr' as project_addr
    FROM memory_events e
    -- MT13: INNER join — only surface events whose addr maps to a LIVE node in the
    -- caller's space. memory_events has no FK to nodes, so a stale/orphan event (node
    -- deleted, or addr reused by another tenant) must NOT surface its addr here. A LEFT
    -- join returned e.addr with a null node, leaking a reused addr now owned elsewhere.
    JOIN nodes n
      ON n.addr = e.addr
      AND n.space_id = ${spaceId}
      AND n.visibility <> 'deleted'
    WHERE e.tenant_id = ${tenantId}
    ${projectFilter}
    ORDER BY e.created_at DESC
    LIMIT ${limit}
  `;
}

export async function getActiveConflicts(
  sql: Sql,
  tenantId: string,
  limit = 10,
): Promise<Array<{ id: number; addr_a: string; addr_b: string; conflict_type: string; description: string; detected_at: string }>> {
  return sql`
    SELECT id, addr_a, addr_b, conflict_type, description, detected_at
    FROM memory_conflicts
    WHERE tenant_id = ${tenantId} AND status = 'detected'
    ORDER BY detected_at DESC
    LIMIT ${limit}
  `;
}
