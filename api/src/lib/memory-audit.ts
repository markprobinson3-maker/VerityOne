/**
 * Memory audit snapshot — compact read-only provenance + lifecycle summary.
 *
 * Combines identity, trust state, promotion provenance, approval metadata,
 * and recent lifecycle events into one structured response. All fields
 * are directly derived from stored data — no inferred workflow states.
 */

import type postgres from "postgres";
import { classifyMemoryWriteQuality, type MemoryReviewCategory } from "./memory-quality";
import type { MemoryKind, SourceKind } from "./memory-contract";

type SqlTag = ReturnType<typeof postgres>;

export interface MemoryAuditSnapshot {
  addr: string;
  label: string;
  kind: string;
  source: string;
  accepted_by_user: boolean;
  status: string;
  // Derived trust state — directly from source_kind
  trust_state: "user_accepted" | "agent_inferred" | "agent_corrected" | "system_generated" | "unknown";
  // Derived origin — directly from promoted_from presence
  overlay_origin: boolean;
  // Provenance
  promoted_from: Record<string, unknown> | null;
  approval: Record<string, unknown> | null;
  federation: Record<string, unknown> | null;
  // Lifecycle
  recent_events: Array<{ event_type: string; actor: string | null; created_at: string; event_data: unknown }>;
  // Timestamps
  created_at: string;
  updated_at: string;
}

export async function getMemoryAuditSnapshot(
  sql: SqlTag,
  tenantId: string,
  addr: string,
  eventLimit = 10,
): Promise<MemoryAuditSnapshot | null> {
  const spaceId = `tenant:${tenantId}`;

  const [row] = await sql`
    SELECT addr, label, dormant_at, created_at, updated_at,
      substance->>'memory_type' as kind,
      substance->>'source_kind' as source,
      substance->>'accepted_by_user' as accepted_by_user,
      COALESCE(substance->>'lifecycle_status', substance->>'status') as sub_status,
      COALESCE(substance->>'superseded_by_addr', substance->>'superseded_by') as superseded_by,
      substance->'promoted_from' as promoted_from,
      substance->'approval' as approval,
      substance->'federation' as federation
    FROM nodes
    WHERE addr = ${addr} AND space_id = ${spaceId} AND node_type = 'memory'
      AND visibility <> 'deleted'
  `;

  if (!row) return null;

  const status = row.dormant_at
    ? (row.sub_status || "archived")
    : row.superseded_by
      ? "superseded"
      : "active";

  const source = row.source || "unknown";
  const trustState = (["user_accepted", "agent_inferred", "agent_corrected", "system_generated"].includes(source)
    ? source
    : "unknown") as MemoryAuditSnapshot["trust_state"];

  // Recent lifecycle events — tenant-scoped to prevent cross-tenant leakage
  const events = await sql`
    SELECT event_type, event_data, actor, created_at
    FROM memory_events
    WHERE addr = ${addr} AND tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT ${eventLimit}
  `;

  return {
    addr: row.addr,
    label: row.label,
    kind: row.kind || "context",
    source,
    accepted_by_user: row.accepted_by_user === "true",
    status,
    trust_state: trustState,
    overlay_origin: row.promoted_from != null,
    promoted_from: row.promoted_from || null,
    approval: row.approval || null,
    federation: row.federation || null,
    recent_events: events as unknown as MemoryAuditSnapshot["recent_events"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Review queue: list approvable tenant memories ───────────────────

export interface ReviewableMemoryItem {
  addr: string;
  label: string;
  kind: string;
  source: string;
  accepted_by_user: boolean;
  overlay_origin: boolean;
  promoted_from: Record<string, unknown> | null;
  review_category: MemoryReviewCategory;
  review_priority: number;
  review_quality_reasons: string[];
  created_at: string;
  updated_at: string;
}

export interface ReviewableMemoryPage {
  items: ReviewableMemoryItem[];
  /** total reviewable (active, non-dormant, agent_inferred) memories for the tenant —
   *  the WHOLE backlog, so the operator can tell "queue empty" from "thousands unsurfaced". */
  total: number;
  /** true when more reviewable memories exist beyond this page */
  has_more: boolean;
  /** opaque keyset cursor ("<updated_at>|<addr>") to fetch the next page, or null at the end */
  next_cursor: string | null;
}

/**
 * One page of the tenant memory review backlog, keyset-paginated by (updated_at DESC,
 * addr ASC). Unlike the old fixed 2000-cap fetch, this surfaces the TOTAL backlog and a
 * cursor, so nothing past an arbitrary cap is invisible forever and the operator always
 * knows whether they are seeing the whole queue or a page of it.
 *
 * The reviewable predicate (`visibility <> 'deleted'` etc.) is inlined in BOTH the count
 * and the page query rather than shared via a fragment, so the visibility-guard drift
 * scanner can see it textually beside each nodes scan.
 */
export async function listReviewableMemories(
  sql: SqlTag,
  tenantId: string,
  limit = 20,
  afterCursor: string | null = null,
): Promise<ReviewableMemoryPage> {
  const spaceId = `tenant:${tenantId}`;

  // Keyset: rows strictly after the cursor in (updated_at DESC, addr ASC) order.
  let cursorClause = sql``;
  if (afterCursor) {
    const sep = afterCursor.lastIndexOf("|");
    const curUpdated = afterCursor.slice(0, sep);
    const curAddr = afterCursor.slice(sep + 1);
    if (sep > 0 && curUpdated && curAddr) {
      cursorClause = sql`AND (
        updated_at < ${curUpdated}::timestamptz
        OR (updated_at = ${curUpdated}::timestamptz AND addr > ${curAddr})
      )`;
    }
  }

  const [[{ total }], rows] = await Promise.all([
    sql`
      SELECT count(*)::int AS total
      FROM nodes
      WHERE space_id = ${spaceId}
        AND node_type = 'memory'
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
        AND substance->>'source_kind' = 'agent_inferred'
    `,
    sql`
      SELECT addr, label, created_at, updated_at,
        substance->>'description' as assertion,
        substance->>'why_it_matters' as why_it_matters,
        substance->>'evidence' as evidence,
        substance->>'memory_type' as kind,
        substance->>'source_kind' as source,
        substance->>'accepted_by_user' as accepted_by_user,
        substance->'promoted_from' as promoted_from,
        source_refs
      FROM nodes
      WHERE space_id = ${spaceId}
        AND node_type = 'memory'
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
        AND substance->>'source_kind' = 'agent_inferred'
        ${cursorClause}
      ORDER BY updated_at DESC, addr
      LIMIT ${limit + 1}
    `,
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((r: any) => {
    const quality = classifyMemoryWriteQuality({
      kind: (r.kind || "context") as MemoryKind,
      source: (r.source || "agent_inferred") as SourceKind,
      subject: r.label || undefined,
      assertion: r.assertion || r.label || "",
      whyItMatters: r.why_it_matters || undefined,
      evidence: r.evidence || undefined,
      sourceRefs: Array.isArray(r.source_refs) ? r.source_refs : undefined,
    });
    return {
      addr: r.addr,
      label: r.label,
      kind: r.kind || "context",
      source: r.source || "agent_inferred",
      accepted_by_user: r.accepted_by_user === "true",
      overlay_origin: r.promoted_from != null,
      promoted_from: r.promoted_from || null,
      review_category: quality.review_category,
      review_priority: quality.review_priority,
      review_quality_reasons: quality.reasons,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  const last = items[items.length - 1];
  const next_cursor = hasMore && last
    ? `${typeof last.updated_at === "string" ? last.updated_at : new Date(last.updated_at).toISOString()}|${last.addr}`
    : null;

  return { items, total: Number(total), has_more: hasMore, next_cursor };
}
