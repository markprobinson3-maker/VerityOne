/**
 * Recall Compiler — dedicated scoring and ranking for memory recall.
 *
 * HARD INVARIANT: Recall confidence has NO actionability dimension.
 * Decisions, corrections, and preferences surface before runbooks.
 *
 * Scoring dimensions:
 *   - relevance: semantic similarity to query
 *   - freshness: how recent the memory is
 *   - provenance: user_accepted > agent_corrected > agent_inferred > system_generated
 *   - conflict_free: not superseded, retracted, or in active conflict
 */

import type { Sql } from "postgres";
import { embedQuery, toVectorStr } from "./embed";
import type { MemoryKind } from "./memory-contract";
import type { ResolvedFederatedMemoryMetadata } from "./federated-memory";
import { resolveFederationMetadata } from "./federated-memory";
import { storedConflictHasActionableAnchor } from "./memory-quality";
import { detectMemoryRoute, detectSemanticMemoryRoute, checkTenantMemoryPresence, type MemoryRoute } from "./memory-family-routing";
import { createRecallId, recordRecallOutcomeEvent } from "./recall-outcomes";

// ── Types ──

export interface RecallQuery {
  query: string;
  tenantId: string;
  spaceId: string;
  kinds?: MemoryKind[];
  /** Filter to memories associated with this tenant project (HARD filter — excludes others) */
  projectAddr?: string;
  /** Active project CONTEXT: memories whose project_addr matches get a ranking
   *  BOOST (not a filter), so project-backed memories are preferred without
   *  hiding legitimate tenant-wide (unscoped) memories. Distinct from the hard
   *  `projectAddr` filter; use this when recall should prefer-but-not-restrict. */
  projectContextAddr?: string;
  /** Agent-policy visible_projects: restrict project-backed memories to
   *  this set of addrs. Tenant-wide memories (no project_addr) are always
   *  visible. null/undefined = no restriction. */
  visibleProjectAddrs?: string[] | null;
  limit?: number;
  includeInactive?: boolean;
  timeoutMs?: number;
  embedding?: number[];
  /** Optional agent id for recall outcome telemetry attribution. */
  agentId?: string | null;
  /** Internal callers that do not expose recall_id should not write unreachable exposure packets. */
  suppressExposureEvent?: boolean;
  /** Golden-query probes and other eval callers must not write recall telemetry side effects. */
  suppressTelemetry?: boolean;
  /** Suppress imported overlay results. Set to true when recall_scope
   *  is "tenant_private" to honor the same boundary as public resonance. */
  suppressOverlays?: boolean;
}

export interface RecalledMemory {
  addr: string;
  label: string;
  kind: string;
  source: string;
  assertion: string;
  why_it_matters: string | null;
  relevance: number;
  freshness: number;
  provenance_score: number;
  conflict_free: boolean;
  composite_score: number;
  created_at: string;
  effective_at: string | null;
  superseded_by: string | null;
  status: string;
  federation: ResolvedFederatedMemoryMetadata;
  /** Tenant project this memory is associated with (null if unscoped) */
  project_addr: string | null;
  project_label: string | null;
  /** Terse structured explanation of why this memory was recalled and its current state */
  explanation: {
    /** Why this memory surfaced: rank factors in human-readable form */
    why_recalled: string;
    /** Lifecycle/conflict note if applicable (null if clean active memory) */
    lifecycle_note: string | null;
    /** Federation provenance in plain terms */
    provenance_label: string;
  };
}

export interface RecallConfidence {
  relevance: "high" | "medium" | "low";
  freshness: "high" | "medium" | "low";
  provenance: "high" | "medium" | "low";
  conflict_free: "high" | "medium" | "low";
  summary: string;
}

export interface RecallResult {
  /** Stable packet id returned to agents so later /signal/recall feedback can attach outcomes. */
  recall_id: string;
  /** True when no exposure packet is available for later outcome signals. */
  recall_telemetry_unavailable?: boolean;
  /** True when the caller deliberately requested a side-effect-free recall. */
  recall_telemetry_suppressed?: boolean;
  /** True when recall telemetry was attempted but could not be persisted. */
  recall_telemetry_failed?: boolean;
  primary_memories: RecalledMemory[];
  supporting_memories: RecalledMemory[];
  /** Internal: the query embedding computed during recall. Used by public
   *  resonance enrichment to avoid a second embedding call. Not serialized
   *  in the HTTP response. */
  _embedding?: number[];
  changes_since: Array<{ addr: string; label: string; event_type: string; created_at: string }>;
  conflicts: Array<{ addr_a: string; addr_b: string; conflict_type: string; description: string | null }>;
  stale: Array<{ addr: string; label: string; days_old: number }>;
  fresh_research_needed: string | null;
  confidence: RecallConfidence;
  next_move: string | null;
  error_recovered: boolean;
  recovery_reason: string | null;
  /** Packet-level explanation: what was considered and what was excluded */
  explanation: {
    /** How many candidate memories were scored */
    candidates_scored: number;
    /** How many were excluded from the result (stale, retracted, low-relevance) */
    excluded_count: number;
    /** Why memories were excluded, grouped by reason */
    excluded_reasons: string[];
    /** Memory vs research posture */
    posture: "memory_backed" | "partial_memory" | "research_needed" | "degraded";
    /** One-sentence posture explanation for agents */
    posture_note: string;
    /** Which routing method selected the family (if any) */
    routing_method: "keyword" | "semantic" | "none";
    /** Which family was routed to (null if no routing) */
    routed_family: string | null;
  };
}

export interface RecallCompilerDeps {
  embedQueryFn: (text: string) => Promise<number[]>;
  nowMs: () => number;
}

// ── Scoring ──

const PROVENANCE_SCORES: Record<string, number> = {
  user_accepted: 1.0,
  agent_corrected: 0.85,
  agent_inferred: 0.6,
  system_generated: 0.4,
};

const KIND_PRIORITY: Record<string, number> = {
  correction: 1.0,
  decision: 0.95,
  preference: 0.9,
  pattern: 0.8,
  context: 0.7,
  digest: 0.6,
  vision: 0.5,
  changelog: 0.3,
};

function provenanceScore(source: string | null): number {
  return PROVENANCE_SCORES[source || "agent_inferred"] || 0.5;
}

function kindBoost(kind: string | null): number {
  return KIND_PRIORITY[kind || "context"] || 0.5;
}

function freshnessScore(createdAt: string | null, nowMs = Date.now()): number {
  if (!createdAt) return 0.5;
  const ageMs = nowMs - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 1.0;
  if (ageDays < 7) return 0.9;
  if (ageDays < 30) return 0.75;
  if (ageDays < 90) return 0.5;
  return 0.3;
}

// ── Explanation helpers ──

function ageDaysLabel(createdAt: string | null, nowMs: number): string {
  if (!createdAt) return "unknown age";
  const days = Math.round((nowMs - new Date(createdAt).getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1 day old";
  if (days < 7) return `${days} days old`;
  if (days < 30) return `${Math.round(days / 7)} weeks old`;
  return `${Math.round(days / 30)} months old`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "user_accepted": return "user-accepted";
    case "agent_corrected": return "agent-corrected";
    case "agent_inferred": return "agent-inferred";
    case "system_generated": return "system-generated";
    default: return source || "unknown";
  }
}

function authorityLabel(federation: ResolvedFederatedMemoryMetadata): string {
  switch (federation.authority) {
    case "tenant_local": return "tenant-local memory";
    case "tenant_shared": return "shared tenant memory";
    case "public_overlay": return `public overlay${federation.upstream_origin ? ` from ${federation.upstream_origin}` : ""}`;
    default: return "unknown origin";
  }
}

function lifecycleNote(status: string, supersededBy: string | null, conflictFree: boolean): string | null {
  if (status === "superseded" && supersededBy) return `Superseded by ${supersededBy}. A newer version exists.`;
  if (status === "superseded") return "Superseded by a newer memory.";
  if (status === "retracted") return "Retracted. This memory was explicitly marked invalid.";
  if (status === "archived") return "Archived. Hidden from default recall.";
  if (status === "expired") return "Expired. Past its expiry date.";
  if (!conflictFree) return "In conflict with another memory. Review before acting.";
  return null;
}

function buildWhyRecalled(
  relevance: number,
  kind: string,
  source: string,
  createdAt: string | null,
  federation: ResolvedFederatedMemoryMetadata,
  nowMs: number,
): string {
  const parts: string[] = [];
  parts.push(`relevance=${(relevance * 100).toFixed(0)}%`);
  parts.push(ageDaysLabel(createdAt, nowMs));
  parts.push(sourceLabel(source));
  if (federation.authority !== "tenant_local") {
    parts.push(authorityLabel(federation));
  }
  return `Matched as ${kind}. ${parts.join(", ")}.`;
}

/** Additive ranking boost for a memory whose project_addr matches the active
 *  project context (RecallQuery.projectContextAddr). PREFER, not dominate:
 *  since relevance is weighted 0.35, this 0.05 boost only flips a project match
 *  over a tenant-wide memory whose relevance is at most ~0.05/0.35 ≈ 0.14 higher
 *  — enough to win near-ties, but a clearly-more-relevant tenant-wide memory
 *  (the case that protects tenant truth) still outranks a weak project match. */
export const PROJECT_CONTEXT_BOOST = 0.05;

export interface MemoryScoreParts {
  relevance: number;
  freshness: number;
  prov: number;
  kind: number;
  conflictFree: boolean;
  /** memory's project_addr matches the active project context (RecallQuery.projectContextAddr) */
  projectMatch: boolean;
}

/** Canonical recall composite — weighted blend (NO actionability) plus an
 *  additive project-context boost. Shared by the tenant + overlay scorers so
 *  the two never drift, and pure so the weighting is unit-testable. */
export function composeMemoryScore(p: MemoryScoreParts): number {
  return (
    p.relevance * 0.35 +
    p.freshness * 0.20 +
    p.prov * 0.20 +
    p.kind * 0.15 +
    (p.conflictFree ? 0.10 : 0)
  ) + (p.projectMatch ? PROJECT_CONTEXT_BOOST : 0);
}

function gradeLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

const DEFAULT_RECALL_TIMEOUT_MS = 3_000;
const DEFAULT_RECALL_DEPS: RecallCompilerDeps = {
  embedQueryFn: embedQuery,
  nowMs: () => Date.now(),
};

class RecallTimeoutError extends Error {
  stage: string;

  constructor(stage: string, timeoutMs: number) {
    super(`Recall timed out during ${stage} after ${timeoutMs}ms`);
    this.name = "RecallTimeoutError";
    this.stage = stage;
  }
}

function safeRemainingMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new RecallTimeoutError(stage, timeoutMs)), timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

function buildRecoveredRecallResult(
  recallId: string,
  reason: string,
  freshResearchNeeded: string,
  nextMove: string,
  summary: string,
): RecallResult {
  return {
    recall_id: recallId,
    recall_telemetry_unavailable: true,
    primary_memories: [],
    supporting_memories: [],
    changes_since: [],
    conflicts: [],
    stale: [],
    fresh_research_needed: freshResearchNeeded,
    confidence: {
      relevance: "low",
      freshness: "low",
      provenance: "low",
      conflict_free: "low",
      summary,
    },
    next_move: nextMove,
    error_recovered: true,
    recovery_reason: reason,
    explanation: {
      candidates_scored: 0,
      excluded_count: 0,
      excluded_reasons: [`Recall degraded: ${reason}`],
      posture: "degraded",
      posture_note: freshResearchNeeded,
      routing_method: "none",
      routed_family: null,
    },
  };
}

// ── Main compiler ──

export async function compileRecall(sql: Sql, query: RecallQuery): Promise<RecallResult> {
  return compileRecallWithDeps(sql, query, DEFAULT_RECALL_DEPS);
}

export async function compileRecallWithDeps(
  sql: Sql,
  query: RecallQuery,
  deps: RecallCompilerDeps,
): Promise<RecallResult> {
  const recallId = createRecallId();
  const timeoutMs = Number.isFinite(query.timeoutMs)
    ? Math.max(250, Math.min(Number(query.timeoutMs), 10_000))
    : DEFAULT_RECALL_TIMEOUT_MS;
  const deadlineMs = deps.nowMs() + timeoutMs;
  const limit = Math.min(query.limit || 15, 50);

  // Memory-family routing + embedding (routing may use the embedding for semantic fallback)
  let memoryRoute: MemoryRoute | null = null;
  let effectiveKinds = query.kinds;
  let embedding: number[];
  try {
    embedding = Array.isArray(query.embedding) && query.embedding.length > 0
      ? query.embedding
      : await withTimeout(
          deps.embedQueryFn(query.query),
          safeRemainingMs(deadlineMs),
          "embedding",
        );
  } catch (error: any) {
    const message = error instanceof RecallTimeoutError
      ? `Recall timed out while embedding the query. Proceed without tenant memory and verify with fresh research.`
      : `Embedding service unavailable. Proceed without tenant memory and verify with fresh research.`;
    console.error("[recall-compiler] embedding recovery:", error?.message || String(error));
    return buildRecoveredRecallResult(
      recallId,
      error instanceof RecallTimeoutError ? "timeout" : "embedding_unavailable",
      message,
      "Recall degraded. Use /context, /search, or fresh research instead of relying on tenant memory for this query.",
      `${message}${memoryRoute ? ` Routed family hint: ${(memoryRoute as unknown as MemoryRoute).families[0]?.label || "unknown"}.` : ""}`,
    );
  }

  // Route to memory family (keyword first, semantic fallback using the embedding we just computed)
  if (!effectiveKinds || effectiveKinds.length === 0) {
    memoryRoute = detectMemoryRoute(query.query);
    // Semantic fallback when keyword routing returns null/low
    if (!memoryRoute || memoryRoute.confidence === "low") {
      try {
        const semanticRoute = await withTimeout(
          detectSemanticMemoryRoute(embedding),
          safeRemainingMs(deadlineMs),
          "semantic_routing",
        );
        if (semanticRoute && (!memoryRoute || semanticRoute.confidence !== "low")) {
          memoryRoute = semanticRoute;
        }
      } catch {
        // Semantic routing failure is non-fatal
      }
    }
    if (memoryRoute && memoryRoute.confidence !== "low") {
      effectiveKinds = memoryRoute.targetKinds;
      try {
        const present = await withTimeout(
          checkTenantMemoryPresence(sql, query.spaceId, effectiveKinds),
          safeRemainingMs(deadlineMs),
          "family_presence_check",
        );
        memoryRoute.tenantMemoryPresent = present;
        if (!present && memoryRoute.fallbackPolicy !== "family_only") {
          effectiveKinds = undefined;
        }
      } catch {
        effectiveKinds = undefined;
      }
    }
  }

  const vecStr = toVectorStr(embedding);

  // 1. Fetch tenant memories by semantic similarity
  const dormantClause = query.includeInactive
    ? sql``
    : sql`AND n.dormant_at IS NULL`;
  const kindClause = effectiveKinds && effectiveKinds.length > 0
    ? sql`AND n.substance->>'memory_type' = ANY(${effectiveKinds}::text[])`
    : sql``;
  const projectClause = query.projectAddr
    ? sql`AND n.substance->>'project_addr' = ${query.projectAddr}`
    : sql``;
  // Agent-policy visible_projects enforcement: when set, only show
  // project-backed memories whose project_addr is in the allowed set.
  // Tenant-wide memories (no project_addr in substance) remain visible.
  const visibleProjectClause = (query.visibleProjectAddrs && query.visibleProjectAddrs.length > 0)
    ? sql`AND (n.substance->>'project_addr' IS NULL OR n.substance->>'project_addr' = ANY(${query.visibleProjectAddrs}::text[]))`
    : sql``;

  let rawMemories: any[];
  try {
    rawMemories = await withTimeout(sql`
      SELECT
        n.addr, n.label, n.confidence, n.created_at, n.updated_at, n.dormant_at,
        n.substance->>'description' as assertion,
        n.substance->>'memory_type' as kind,
        n.substance->>'source_kind' as source,
        n.substance->>'why_it_matters' as why_it_matters,
        n.substance->>'effective_at' as effective_at,
        COALESCE(n.substance->>'superseded_by_addr', n.substance->>'superseded_by') as superseded_by,
        COALESCE(n.substance->>'lifecycle_status', n.substance->>'status') as status,
        n.substance->>'accepted_by_user' as accepted_by_user,
        n.substance->'federation' as federation,
        n.substance->>'project_addr' as project_addr,
        1 - (n.embedding_hv <=> ${vecStr}::halfvec) as similarity
      FROM nodes n
      WHERE n.space_id = ${query.spaceId}
        AND n.node_type = 'memory'
        AND n.visibility <> 'deleted'
        AND n.embedding_hv IS NOT NULL
        ${dormantClause}
        ${kindClause}
        ${projectClause}
        ${visibleProjectClause}
      ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
      LIMIT ${limit * 2}
    `, safeRemainingMs(deadlineMs), "primary_memory_query");
  } catch (error: any) {
    console.error("[recall-compiler] primary query recovery:", error?.message || String(error));
    return buildRecoveredRecallResult(
      recallId,
      error instanceof RecallTimeoutError ? "timeout" : "compiler_error",
      "Recall could not retrieve tenant memories in time. Proceed without tenant memory and verify with fresh research.",
      "Recall degraded before memory candidates could be retrieved. Use /context, /search, or fresh research instead.",
      "Recall degraded before candidate retrieval completed.",
    );
  }

  // 1b. Query imported overlays from overlay:<tenantId> space.
  // Overlays are subordinate: they receive a provenance penalty and are
  // capped to the supporting list (never primary). Suppressed when
  // query.suppressOverlays is set (tenant_private recall scope).
  let overlayMemories: any[] = [];
  const overlaySpaceId = `overlay:${query.tenantId}`;

  if (!query.suppressOverlays) {
    try {
      // Check if overlay space exists before querying
      const [spaceExists] = await sql`
        SELECT 1 FROM graph_spaces WHERE space_id = ${overlaySpaceId}
      `;
      if (spaceExists) {
        // Apply the same scope filters as the tenant query: kind, project,
        // visible-projects, dormant. This prevents kind-scoped or
        // project-scoped recalls from surfacing unrelated overlays.
        // Overlay recall reads substance.memory_type and substance.source_kind
        // directly. Pre-serve startup normalization (in index.ts) guarantees
        // these fields exist on all imported overlay rows before any recall
        // request can be served. No COALESCE fallback needed.

        overlayMemories = await withTimeout(sql`
          SELECT
            n.addr, n.label, n.confidence, n.created_at, n.updated_at, n.dormant_at,
            n.substance->>'description' as assertion,
            n.substance->>'memory_type' as kind,
            n.substance->>'source_kind' as source,
            n.substance->>'why_it_matters' as why_it_matters,
            n.substance->>'effective_at' as effective_at,
            COALESCE(n.substance->>'superseded_by_addr', n.substance->>'superseded_by') as superseded_by,
            COALESCE(n.substance->>'lifecycle_status', n.substance->>'status') as status,
            n.substance->>'accepted_by_user' as accepted_by_user,
            n.substance->'federation' as federation,
            n.substance->>'project_addr' as project_addr,
            n.space_id as _space_id,
            1 - (n.embedding_hv <=> ${vecStr}::halfvec) as similarity
          FROM nodes n
          WHERE n.space_id = ${overlaySpaceId}
            AND n.visibility <> 'deleted'
            AND n.embedding_hv IS NOT NULL
            ${dormantClause}
            ${kindClause}
            ${projectClause}
            ${visibleProjectClause}
          ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
          LIMIT ${Math.min(limit, 6)}
        `, safeRemainingMs(deadlineMs), "overlay_memory_query");
      }
    } catch {
      // Overlay recall failure is non-fatal; tenant recall continues
    }
  }

  // 2. Score each memory (NO actionability dimension)
  const scored: RecalledMemory[] = rawMemories.map((m: any) => {
    const relevance = parseFloat(m.similarity) || 0;
    const freshness = freshnessScore(m.created_at, deps.nowMs());
    const prov = provenanceScore(m.source);
    const conflictFree = !m.dormant_at && !m.superseded_by && m.status !== "retracted";
    const kind = kindBoost(m.kind);
    // Prefer (not restrict) memories in the active project context.
    const projectMatch = !!query.projectContextAddr && m.project_addr === query.projectContextAddr;
    const composite = composeMemoryScore({ relevance, freshness, prov, kind, conflictFree, projectMatch });

    return {
      addr: m.addr,
      label: m.label,
      kind: m.kind || "context",
      source: m.source || "agent_inferred",
      assertion: m.assertion || "",
      why_it_matters: m.why_it_matters || null,
      relevance: parseFloat(relevance.toFixed(3)),
      freshness: parseFloat(freshness.toFixed(3)),
      provenance_score: parseFloat(prov.toFixed(3)),
      conflict_free: conflictFree,
      composite_score: parseFloat(composite.toFixed(3)),
      created_at: m.created_at,
      effective_at: m.effective_at || null,
      superseded_by: m.superseded_by || null,
      status: m.dormant_at ? (m.status || "archived") : m.superseded_by ? "superseded" : "active",
      federation: resolveFederationMetadata(m.federation),
      project_addr: m.project_addr || null,
      project_label: null, // resolved after scoring if needed
      explanation: {
        why_recalled: buildWhyRecalled(relevance, m.kind || "context", m.source || "agent_inferred", m.created_at, resolveFederationMetadata(m.federation), deps.nowMs()) + (projectMatch ? " · matches active project" : ""),
        lifecycle_note: lifecycleNote(
          m.dormant_at ? (m.status || "archived") : m.superseded_by ? "superseded" : "active",
          m.superseded_by,
          conflictFree,
        ),
        provenance_label: authorityLabel(resolveFederationMetadata(m.federation)),
      },
    };
  }).sort((a: RecalledMemory, b: RecalledMemory) => b.composite_score - a.composite_score);

  // 2b. Score imported overlay memories with a provenance penalty.
  // Overlays get 0.3 provenance (below system_generated=0.4) so they rank
  // below equivalent tenant-local matches. They are capped to supporting
  // only — never primary — so tenant-local truth always dominates.
  const OVERLAY_PROVENANCE_SCORE = 0.3;
  const scoredOverlays: RecalledMemory[] = overlayMemories.map((m: any) => {
    const relevance = parseFloat(m.similarity) || 0;
    const freshness = freshnessScore(m.created_at, deps.nowMs());
    const prov = OVERLAY_PROVENANCE_SCORE; // fixed subordinate provenance
    const conflictFree = !m.dormant_at && !m.superseded_by && m.status !== "retracted";
    const kind = kindBoost(m.kind || "context");
    const projectMatch = !!query.projectContextAddr && m.project_addr === query.projectContextAddr;
    const composite = composeMemoryScore({ relevance, freshness, prov, kind, conflictFree, projectMatch });

    const fed = resolveFederationMetadata(m.federation);
    // Force public_overlay authority even if metadata is missing
    if (fed.authority !== "public_overlay") {
      fed.authority = "public_overlay" as any;
      fed.sync_state = "public_overlay" as any;
    }

    return {
      addr: m.addr,
      label: m.label,
      kind: m.kind || "context",
      source: m.source || "system_generated",
      assertion: m.assertion || "",
      why_it_matters: m.why_it_matters || null,
      relevance: parseFloat(relevance.toFixed(3)),
      freshness: parseFloat(freshness.toFixed(3)),
      provenance_score: parseFloat(prov.toFixed(3)),
      conflict_free: conflictFree,
      composite_score: parseFloat(composite.toFixed(3)),
      created_at: m.created_at,
      effective_at: m.effective_at || null,
      superseded_by: m.superseded_by || null,
      status: "active",
      federation: fed,
      project_addr: m.project_addr || null,
      project_label: null,
      explanation: {
        why_recalled: buildWhyRecalled(relevance, m.kind || "context", "system_generated", m.created_at, fed, deps.nowMs()) + (projectMatch ? " · matches active project" : ""),
        lifecycle_note: null,
        provenance_label: authorityLabel(fed),
      },
    };
  }).sort((a: RecalledMemory, b: RecalledMemory) => b.composite_score - a.composite_score);

  // 3. Split into primary (tenant-local only) and supporting (tenant + overlays).
  // Overlays are never promoted to primary — tenant-local truth always dominates.
  const primary = scored.slice(0, 3);
  const tenantSupporting = scored.slice(3, 6);
  const overlaySlots = Math.max(0, 6 - primary.length - tenantSupporting.length);
  const overlaySupporting = scoredOverlays.slice(0, Math.max(overlaySlots, 3));
  // Merge: tenant supporting first, then top overlays, capped at 6 total supporting
  const supporting = [...tenantSupporting, ...overlaySupporting].slice(0, 6);

  // Resolve project labels for results that have project_addr
  const projectAddrs = [...new Set([...primary, ...supporting].map((m) => m.project_addr).filter(Boolean))] as string[];
  if (projectAddrs.length > 0) {
    try {
      const projectRows = await sql`
        SELECT addr, label FROM nodes
        WHERE addr = ANY(${projectAddrs}::text[])
          AND visibility <> 'deleted'
      `;
      const labelMap = new Map(projectRows.map((r: any) => [r.addr, r.label]));
      for (const m of [...primary, ...supporting]) {
        if (m.project_addr) m.project_label = labelMap.get(m.project_addr) || null;
      }
    } catch { /* non-fatal */ }
  }

  let recovered = false;
  let recoveryReason: string | null = null;

  // 3. Recent changes (events from last 7 days)
  let changesSince: RecallResult["changes_since"] = [];
  try {
    changesSince = await withTimeout(sql`
      SELECT me.addr, n.label, me.event_type, me.created_at
      FROM memory_events me
      JOIN nodes n ON n.addr = me.addr
      WHERE me.tenant_id = ${query.tenantId}
        -- MT13: the node must live in the CALLER's space. memory_events has no FK to
        -- nodes (audit durability), so a stale event whose addr was reused by another
        -- tenant would otherwise join to that tenant's node and leak its addr/label.
        AND n.space_id = ${query.spaceId}
        AND n.visibility <> 'deleted'
        AND me.created_at > now() - interval '7 days'
        AND me.event_type IN ('created', 'updated', 'superseded', 'retracted')
        -- A backfilled historical-creation record (MQ3) is NOT a recent change:
        -- its created_at is backdated to the original creation moment, so exclude it
        -- from the "recent changes" annotation rather than surfacing a repair as activity.
        AND (me.event_data->>'backfill') IS NULL
      ORDER BY me.created_at DESC
      LIMIT 10
    `, safeRemainingMs(deadlineMs), "changes_since_query");
  } catch {
    // Non-critical. Keep primary results and mark the response as recovered.
    recovered = true;
    recoveryReason = recoveryReason || "partial_results";
  }

  // 4. Active conflicts for the memories actually recalled. Tenant-wide
  // conflict banners are too noisy for agents; a recall packet should only
  // warn about contradictions attached to its primary/supporting memories.
  let conflicts: RecallResult["conflicts"] = [];
  const recalledConflictAddrs = [...new Set([...primary, ...supporting].map((m) => m.addr))];
  if (recalledConflictAddrs.length > 0) {
    try {
      const conflictRows = await withTimeout(sql`
        SELECT addr_a, addr_b, conflict_type, description
        FROM memory_conflicts
        WHERE tenant_id = ${query.tenantId}
          AND status = 'detected'
          AND (addr_a = ANY(${recalledConflictAddrs}::text[]) OR addr_b = ANY(${recalledConflictAddrs}::text[]))
        ORDER BY detected_at DESC
        LIMIT 5
      `, safeRemainingMs(deadlineMs), "conflicts_query");
      conflicts = conflictRows.filter((row: any) =>
        row.conflict_type !== "contradiction" ||
        storedConflictHasActionableAnchor(row.description),
      ) as unknown as RecallResult["conflicts"];
    } catch {
      recovered = true;
      recoveryReason = recoveryReason || "partial_results";
    }
  }

  // 5. Stale memories (older than 30 days, still active)
  const stale = scored
    .filter((m) => m.status === "active" && m.freshness < 0.6)
    .slice(0, 5)
    .map((m) => ({
      addr: m.addr,
      label: m.label,
      days_old: Math.round((deps.nowMs() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24)),
    }));

  // 6. Compute confidence
  const avgRelevance = primary.length > 0 ? primary.reduce((s, m) => s + m.relevance, 0) / primary.length : 0;
  const avgFreshness = primary.length > 0 ? primary.reduce((s, m) => s + m.freshness, 0) / primary.length : 0;
  const avgProvenance = primary.length > 0 ? primary.reduce((s, m) => s + m.provenance_score, 0) / primary.length : 0;
  const allConflictFree = primary.every((m) => m.conflict_free);

  const routeNote = memoryRoute
    ? ` Routed to family: ${memoryRoute.families[0]?.label || "unknown"} (${memoryRoute.confidence}).`
    : "";
  const confidence: RecallConfidence = {
    relevance: gradeLevel(avgRelevance),
    freshness: gradeLevel(avgFreshness),
    provenance: gradeLevel(avgProvenance),
    conflict_free: allConflictFree ? "high" : conflicts.length > 0 ? "low" : "medium",
    summary: primary.length === 0
      ? `No relevant tenant memories found.${routeNote}`
      : `${primary.length} memories found. Relevance: ${gradeLevel(avgRelevance)}, freshness: ${gradeLevel(avgFreshness)}, provenance: ${gradeLevel(avgProvenance)}.${routeNote}`,
  };

  // 7. Determine if fresh research is needed
  const freshResearchNeeded = avgRelevance < 0.5
    ? "Low semantic match to query. Prior memories may not cover this topic — consider fresh research."
    : null;

  // 8. Suggest next move
  const nextMove = primary.length === 0
    ? "No tenant memories match this query. Use /context or /search for public graph knowledge."
    : primary[0].relevance > 0.7
      ? `Review "${primary[0].label}" — strongest match. Check if still current.`
      : `Partial match found. Verify "${primary[0].label}" against current state before acting.`;

  const recalledAddrs = [...primary, ...supporting].map((m) => m.addr);
  let recallTelemetryUnavailable = false;
  // suppressExposureEvent is the legacy narrow switch for the
  // recall_outcome_events exposure row. suppressTelemetry is the broader
  // side-effect-free probe switch; today the exposure row is the only
  // compileRecall telemetry sink, so either flag suppresses this write.
  const suppressRecallTelemetry = query.suppressExposureEvent || query.suppressTelemetry;
  if (!suppressRecallTelemetry) {
    try {
      await recordRecallOutcomeEvent(sql, {
        recallId,
        tenantId: query.tenantId,
        spaceId: query.spaceId,
        agentId: query.agentId || null,
        query: query.query,
        eventType: "recalled",
        memoryAddrs: recalledAddrs,
        topAddr: primary[0]?.addr || supporting[0]?.addr || null,
        evidence: {
          primary_count: primary.length,
          supporting_count: supporting.length,
          candidates_scored: scored.length + scoredOverlays.length,
          avg_relevance: avgRelevance,
          posture: recovered ? "degraded" : freshResearchNeeded ? "research_needed" : primary.length === 0 ? "research_needed" : avgRelevance < 0.55 ? "partial_memory" : "memory_backed",
          routed_family: memoryRoute?.families?.[0]?.label || null,
        },
      });
    } catch (error: any) {
      recallTelemetryUnavailable = true;
      console.warn("[recall-compiler] recall outcome event skipped:", error?.message || String(error));
    }
  }

  return {
    recall_id: recallId,
    ...(suppressRecallTelemetry || recallTelemetryUnavailable ? { recall_telemetry_unavailable: true } : {}),
    ...(suppressRecallTelemetry ? { recall_telemetry_suppressed: true } : {}),
    ...(recallTelemetryUnavailable ? { recall_telemetry_failed: true } : {}),
    _embedding: embedding,
    primary_memories: primary,
    supporting_memories: supporting,
    changes_since: changesSince,
    conflicts,
    stale,
    fresh_research_needed: freshResearchNeeded,
    confidence,
    next_move: nextMove,
    error_recovered: recovered,
    recovery_reason: recoveryReason,
    explanation: {
      candidates_scored: scored.length + scoredOverlays.length,
      excluded_count: (scored.length + scoredOverlays.length) - primary.length - supporting.length,
      excluded_reasons: (() => {
        const reasons: string[] = [];
        const lowRelevance = scored.filter((m) => m.relevance < 0.4).length;
        const staleCount = stale.length;
        const conflictedCount = scored.filter((m) => !m.conflict_free).length;
        if (lowRelevance > 0) reasons.push(`${lowRelevance} low-relevance`);
        if (staleCount > 0) reasons.push(`${staleCount} stale (>30 days)`);
        if (conflictedCount > 0) reasons.push(`${conflictedCount} in conflict`);
        if (recovered) reasons.push("partial results due to timeout/error recovery");
        return reasons;
      })(),
      posture: (() => {
        if (recovered) return "degraded" as const;
        if (freshResearchNeeded) return "research_needed" as const;
        if (primary.length === 0) return "research_needed" as const;
        if (avgRelevance < 0.55) return "partial_memory" as const;
        return "memory_backed" as const;
      })(),
      posture_note: (() => {
        if (recovered) return "Recall was degraded by a timeout or service issue. Results may be incomplete.";
        if (primary.length === 0) return "No relevant tenant memories found. Use fresh research for this topic.";
        if (freshResearchNeeded) return `${freshResearchNeeded} Prior memories exist but may not fully cover this query.`;
        if (avgRelevance < 0.55) return "Partial memory coverage. Some relevant memories exist but fresh verification is recommended.";
        return "Strong tenant memory coverage. Prior decisions and context are available.";
      })(),
      routing_method: memoryRoute
        ? (typeof (memoryRoute as any).families?.[0]?.score === "number" && (memoryRoute as any).families[0].score < 1
            ? "semantic" : "keyword")
        : "none",
      routed_family: memoryRoute?.families?.[0]?.label || null,
    },
  };
}
