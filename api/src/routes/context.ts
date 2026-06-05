/**
 * /context — Unified agent context endpoint
 * 
 * One call gives an agent exactly what it needs:
 * 1. Registry overview (what pyramids exist)
 * 2. Relevant nodes from semantic search
 * 3. Related edges (connections between found nodes)
 * 4. Source references (MD files, code, skills they can drill into)
 * 5. TOC slice (structural position of relevant knowledge)
 * 
 * Design principle: lean context that grows only when needed.
 * Start with ~500 tokens, agent can drill deeper via follow-up calls.
 * 
 * Usage:
 *   GET  /context?q=feedback+loops&depth=shallow   → ~500 token overview
 *   GET  /context?q=feedback+loops&depth=deep       → ~2000 tokens with substance
 *   GET  /context?q=feedback+loops&depth=full       → everything including source refs
 *   POST /context { task: "design a feedback loop", pyramids: ["META","PROJECTS"] }
 */

import { Hono } from "hono";
import { sql } from "../db";
import { embedQuery, toVectorStr } from "../lib/embed";
import { roundFloat, clampInt, clampFloat, splitQuery, parseJsonField } from "../lib/utils";
import { withResolvedKinds, type SourceRef } from "../lib/source-refs";
import {
  allowedRegistryAccessLevels,
  assertAgentSelfOrOperator,
  getAccessContext,
  hasBetaAccess,
  isOperator,
  resolveAgentTenant,
  type AccessContext,
} from "../lib/access";
import { filterReadableNodes } from "../lib/public-graph";
import { formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { buildRetrievalPatterns, detectRetrievalIntent, rerankRetrievalRows, summarizeRetrievalIntent, TRUTH_PYRAMIDS } from "../lib/retrieval-intent";
import { compileRecall } from "../lib/recall-compiler";
import { selectRelevantSkills } from "../lib/skill-retrieval";
// F12: canonical maturity_stage origin.
import { coalesceMaturityStage, type KnownPyramidId } from "@verity-one/graph-shape";
import { GLOBAL_SPACE_ID, tenantSpaceId } from "../lib/spaces";
import { selectVisibleGraphCounts, selectVisiblePyramidSummaries } from "../lib/visible-graph";
import { checkGuards, type Guard } from "../lib/guards";
import { errorJson, ApiError } from "../lib/error-envelope";
import { callOptionalMinerFlashLite } from "../lib/miner-llm-bridge";

const context = new Hono();
const ALPHA_OMEGA_ADDR = "AO.0.0.0";

// ============================================================
// Query rewriting: detect problem-description queries, extract nouns
// ============================================================

const PROBLEM_TERMS = /\b(failing|failed|broken|error|issue|not working|doesn't work|can't|cannot|trouble|troubleshoot|problem|wrong|stuck|crash|hang|timeout)\b/i;
const queryRewriteCache = new Map<string, { rewritten: string; ts: number }>();
const REWRITE_CACHE_TTL_MS = 3600_000; // 1 hour
const REWRITE_MAX_CACHE = 500;

async function maybeRewriteQuery(q: string): Promise<{ query: string; rewritten: boolean; original?: string }> {
  const normalized = q.trim().toLowerCase();

  // Only rewrite if query contains problem-description terms
  if (!PROBLEM_TERMS.test(normalized)) {
    return { query: q, rewritten: false };
  }

  // Check cache
  const cached = queryRewriteCache.get(normalized);
  if (cached && Date.now() - cached.ts < REWRITE_CACHE_TTL_MS) {
    return { query: cached.rewritten, rewritten: true, original: q };
  }

  // Extract nouns via Flash Lite (cheap, fast, 15s timeout)
  try {
    const result = await callOptionalMinerFlashLite(
      `Extract the key technology/tool/concept nouns from this query. Return ONLY the nouns as a space-separated string, no explanations. Remove problem words (failing, broken, error, etc).\n\nQuery: "${q}"\n\nNouns:`,
      { temperature: 0, maxTokens: 50, timeoutMs: 3000 },
    );
    if (!result) return { query: q, rewritten: false };
    const rewritten = result.trim().replace(/[^a-zA-Z0-9\s.+#-]/g, "").slice(0, 200);
    if (rewritten.length >= 3 && rewritten !== normalized) {
      // Evict oldest if cache full
      if (queryRewriteCache.size >= REWRITE_MAX_CACHE) {
        const oldest = [...queryRewriteCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) queryRewriteCache.delete(oldest[0]);
      }
      queryRewriteCache.set(normalized, { rewritten, ts: Date.now() });
      return { query: rewritten, rewritten: true, original: q };
    }
  } catch {
    // LLM unavailable — fall through to original query
  }

  return { query: q, rewritten: false };
}

// Depth levels control how much context is returned
type Depth = "shallow" | "deep" | "full";

interface ContextRequest {
  q?: string;             // search query or task description
  task?: string;          // alias for q
  pyramids?: string[];    // filter to specific pyramids
  type?: string | null;   // filter node_type
  depth?: Depth;          // shallow (~500tok), deep (~2000tok), full (everything)
  limit?: number;         // max nodes to return
  min_confidence?: number;// filter out low-confidence nodes (default: 0)
  visibility?: string;    // "public" (default) or "all" (includes private)
  edge_types?: string[];  // filter edges to specific types
  domain?: string | null; // domain context for domain-scoped confidence
  brief?: boolean;        // when true, add ~20-token heat summary
  compact?: boolean;      // when true, return a ~90% smaller response (GET ?compact=true)
  query?: Record<string, string | undefined>; // raw query-param bag (temporal boost flag, etc.)
}

const VALID_DEPTHS: Depth[] = ["shallow", "deep", "full"];

function dedupeByAddr<T extends { addr?: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const addr = `${row.addr || ""}`;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    out.push(row);
  }
  return out;
}

// GET /context?q=...&depth=shallow&min_confidence=0.5&visibility=public
context.get("/", async (c) => {
  try {
  const q = (c.req.query("q") || c.req.query("task") || "").replace(/\0/g, "");
  if (!q) return errorJson(c, "invalid_request", { message: "q parameter required" });
  const rawDepth = c.req.query("depth") || "shallow";
  if (!VALID_DEPTHS.includes(rawDepth as Depth)) {
    return errorJson(c, "invalid_request", { message: `Invalid depth: '${rawDepth}'. Must be one of: ${VALID_DEPTHS.join(", ")}` });
  }
  const depth = rawDepth as Depth;
  const pyramids = splitQuery(c.req.query("pyramids"));
  const defaultLimit = depth === "shallow" ? 5 : depth === "deep" ? 7 : 10;
  const limit = clampInt(c.req.query("limit"), defaultLimit, 1, 100);
  const min_confidence = clampFloat(c.req.query("min_confidence"), 0, 0, 1.0);
  const visibility = c.req.query("visibility") || "public";
  const edge_types = splitQuery(c.req.query("edge_types"));
  const type = c.req.query("type") || null;
  const domain = c.req.query("domain") || null;
  const brief = c.req.query("brief") === "true";
  const compact = c.req.query("compact") === "true";
  const debug = c.req.query("debug") === "true";
  const agent = c.req.query("agent") || null;
  if (visibility === "all" && !isOperator(c)) {
    return errorJson(c, "operator_required", { message: "visibility=all is operator-only" });
  }
  if (agent) {
    if (!hasBetaAccess(c)) {
      return errorJson(c, "unauthorized", { message: "Authenticated access required when agent is provided" });
    }
    if (!assertAgentSelfOrOperator(c, agent)) {
      return errorJson(c, "forbidden", { message: "Forbidden" });
    }
  }
  const access = getAccessContext(c);
  const correlationId = ((c as any).get("correlation_id") as string | undefined) ?? null;

  const result: Record<string, any> = await buildContext(
    { q, depth, pyramids, type, limit, min_confidence, visibility, edge_types, domain, brief, compact, debug, agent } as any,
    access,
    allowedRegistryAccessLevels(c),
    hasBetaAccess(c),
    correlationId,
  );

  // Agent tracking — fire-and-forget, zero added latency
  if (agent && result.sections?.nodes?.length > 0) {
    const nodes = result.sections.nodes;
    const topSim = nodes[0]?.relevance || null;
    const latencyMs = result.ms;
    const outcome = result.out_of_scope ? "redirect" : topSim >= 0.68 ? "useful" : "noise";
    const alphaOmegaIndex = nodes.findIndex((n: any) => n.addr === ALPHA_OMEGA_ADDR);
    trackAgent(resolveAgentTenant(c, agent), agent, q, nodes, latencyMs);
    logPathEvent({
      agent,
      endpoint: "/context",
      query: q,
      addrs: nodes.map((n: any) => n.addr),
      topAddr: nodes[0]?.addr,
      latencyMs,
      relevanceScore: topSim,
      outcome,
      alphaOmegaPresent: alphaOmegaIndex !== -1,
      alphaOmegaRank: alphaOmegaIndex === -1 ? null : alphaOmegaIndex + 1,
    });
  }

  return c.json(result);
  } catch (err: any) {
    console.error("[/context GET] error:", err?.message || err);
    return errorJson(c, "service_unavailable", { message: "Service temporarily unavailable" });
  }
});

// POST /context { task: "...", depth: "deep" }
context.post("/", async (c) => {
  try {
  let body: ContextRequest;
  try {
    body = await c.req.json<ContextRequest>();
  } catch {
    return errorJson(c, "invalid_request", { message: "Invalid JSON body" });
  }
  const q = (body.q || body.task || "").replace(/\0/g, "");
  if (!q) return errorJson(c, "invalid_request", { message: "q parameter required" });
  const depth = body.depth || "shallow";
  const limit = body.limit || (depth === "shallow" ? 5 : depth === "deep" ? 7 : 10);
  const agent = (body as any).agent || null;
  const debug = !!(body as any).debug;
  if ((body.visibility || "public") === "all" && !isOperator(c)) {
    return errorJson(c, "operator_required", { message: "visibility=all is operator-only" });
  }
  if (agent) {
    if (!hasBetaAccess(c)) {
      return errorJson(c, "unauthorized", { message: "Authenticated access required when agent is provided" });
    }
    if (!assertAgentSelfOrOperator(c, agent)) {
      return errorJson(c, "forbidden", { message: "Forbidden" });
    }
  }
  const access = getAccessContext(c);
  const correlationId = ((c as any).get("correlation_id") as string | undefined) ?? null;

  const result: Record<string, any> = await buildContext({
    q, depth, limit,
    pyramids: body.pyramids || [],
    type: (body as any).type || null,
    min_confidence: body.min_confidence || 0,
    visibility: body.visibility || "public",
    edge_types: body.edge_types || [],
    domain: (body as any).domain || null,
    brief: (body as any).brief || false,
    debug,
    agent,
  } as any, access, allowedRegistryAccessLevels(c), hasBetaAccess(c), correlationId);

  // Agent tracking — fire-and-forget, zero added latency
  if (agent && result.sections?.nodes?.length > 0) {
    const nodes = result.sections.nodes;
    const topSim = nodes[0]?.relevance || null;
    const latencyMs = result.ms;
    const outcome = result.out_of_scope ? "redirect" : topSim >= 0.68 ? "useful" : "noise";
    const alphaOmegaIndex = nodes.findIndex((n: any) => n.addr === ALPHA_OMEGA_ADDR);
    trackAgent(resolveAgentTenant(c, agent), agent, q, nodes, latencyMs);
    logPathEvent({
      agent,
      endpoint: "/context",
      query: q,
      addrs: nodes.map((n: any) => n.addr),
      topAddr: nodes[0]?.addr,
      latencyMs,
      relevanceScore: topSim,
      outcome,
      alphaOmegaPresent: alphaOmegaIndex !== -1,
      alphaOmegaRank: alphaOmegaIndex === -1 ? null : alphaOmegaIndex + 1,
    });
  }

  return c.json(result);
  } catch (err: any) {
    console.error("[/context POST] error:", err?.message || err);
    return errorJson(c, "service_unavailable", { message: "Service temporarily unavailable" });
  }
});

async function buildContext(
  req: ContextRequest & { limit: number; debug?: boolean; agent?: string | null },
  access: AccessContext,
  accessLevels: string[],
  includeSensitiveRefs: boolean,
  correlationId: string | null = null,
) {
  const startMs = Date.now();
  const sections: any = {};
  const accessScope = access.scope;
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
  const tenantMemorySpaceId = spaceIds.find((s: string) => s.startsWith("tenant:")) || null;
  const queryIntent = detectRetrievalIntent(req.q || "");
  const queryPatterns = buildRetrievalPatterns(req.q || "");

  // 1. Registry overview (always included, very cheap)
  const registry = await selectVisiblePyramidSummaries({
    scope: accessScope,
    accessLevels,
    spaceIds,
  });
  sections.registry = registry.map((r: any) => ({
    id: r.pyramid_id,
    label: r.label,
    nodes: r.node_count,
    edges: r.edge_count,
    access: r.access_level,
  }));

  // If no query, return consistent shape with hint
  if (!req.q) {
    const counts = await selectVisibleGraphCounts({
      scope: accessScope,
      accessLevels,
      spaceIds,
    });
    const [avgConfidence] = accessScope === "operator"
      ? await sql`
          SELECT ROUND(AVG(confidence)::numeric, 3) AS avg_confidence
          FROM nodes
          WHERE visibility <> 'deleted'
        `
      : await sql`
          SELECT ROUND(AVG(n.confidence)::numeric, 3) AS avg_confidence
          FROM nodes n
          JOIN registry r ON r.pyramid_id = n.pyramid_id
          WHERE n.space_id = ANY(${spaceIds}::text[])
            AND n.visibility <> 'deleted'
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
            )
        `;
    const stats = {
      total_nodes: Number(counts.total_nodes),
      total_edges: Number(counts.total_edges),
      avg_confidence: avgConfidence?.avg_confidence,
    };
    sections.nodes = [];
    sections.edges = [];
    sections.stats = stats;
    sections.hint = "Provide ?q=<your task> to get relevant knowledge context";
    return {
      ok: true,
      depth: req.depth,
      query: null,
      node_count: 0,
      sections,
      ontology: sections.ontology || null,
      ...(req.debug ? { retrieval_debug: { query_mode: queryIntent.mode } } : {}),
      ms: Date.now() - startMs,
    };
  }

  // 2a. Temporal/recall shortcut — use recall compiler for tenant memory injection
  let temporalMemories: any[] = [];
  let memorySummary: {
    recall_id: string;
    recall_telemetry_unavailable?: boolean;
    confidence: any;
    fresh_research_needed: string | null;
    error_recovered?: boolean;
    recovery_reason?: string | null;
  } | null = null;
  if ((queryIntent.temporal || queryIntent.recall) && tenantMemorySpaceId && access.tenantId) {
    try {
      const recallResult = await compileRecall(sql, {
        query: req.q || "",
        tenantId: access.tenantId,
        spaceId: tenantMemorySpaceId,
        agentId: access.agentId,
        limit: Math.min(req.limit, 10),
      });

      if (recallResult.error_recovered) {
        console.warn("[context/recall] compiler degraded, using fallback if needed:", recallResult.recovery_reason);
      }

      const recalledMemories = recallResult.primary_memories.concat(recallResult.supporting_memories);
      if (recalledMemories.length > 0) {
        // Map recall results back to the format searchResults expects
        temporalMemories = recalledMemories.map((m) => {
          const isOverlay = m.federation?.authority === "public_overlay";
          return {
            addr: m.addr,
            label: m.label,
            node_type: "memory",
            confidence: 0.80,
            space_id: isOverlay ? `overlay:${access.tenantId}` : tenantMemorySpaceId,
            updated_at: m.created_at,
            created_at: m.created_at,
            description: m.assertion,
            memory_type: m.kind,
            maturity_stage: coalesceMaturityStage(undefined),
            quick_start: null,
            pyramid_id: "PROJECTS",
            visibility: isOverlay ? "public" : "private",
            federation_authority: isOverlay ? "public_overlay" : "tenant_local",
            // Carry the recall compiler's composite score for injection priority
            _recall_score: m.composite_score,
          };
        });
      } else if (recallResult.error_recovered) {
        temporalMemories = await sql`
          SELECT addr, label, node_type, confidence, space_id, visibility, updated_at, created_at,
            substance->>'description' as description,
            substance->>'memory_type' as memory_type,
            COALESCE(substance->>'maturity_stage', 'encoded') as maturity_stage,
            substance->'quick_start' as quick_start
          FROM nodes
          WHERE space_id = ${tenantMemorySpaceId}
            AND node_type = 'memory'
            AND dormant_at IS NULL
            AND visibility <> 'deleted'
          ORDER BY created_at DESC
          LIMIT ${Math.min(req.limit, 10)}
        `;
      }
      memorySummary = {
        recall_id: recallResult.recall_id,
        recall_telemetry_unavailable: recallResult.recall_telemetry_unavailable,
        confidence: recallResult.confidence,
        fresh_research_needed: recallResult.fresh_research_needed,
        error_recovered: recallResult.error_recovered,
        recovery_reason: recallResult.recovery_reason,
      };
    } catch (e: any) {
      console.error("[context/recall] compiler error, falling back to recency:", e?.message);
      // Fallback to simple recency query if recall compiler fails
      temporalMemories = await sql`
        SELECT addr, label, node_type, confidence, space_id, visibility, updated_at, created_at,
          substance->>'description' as description,
          substance->>'memory_type' as memory_type,
          COALESCE(substance->>'maturity_stage', 'encoded') as maturity_stage,
          substance->'quick_start' as quick_start
        FROM nodes
        WHERE space_id = ${tenantMemorySpaceId}
          AND node_type = 'memory'
          AND dormant_at IS NULL
          AND visibility <> 'deleted'
        ORDER BY created_at DESC
        LIMIT ${Math.min(req.limit, 10)}
      `;
    }
  }

  // 2. Query rewriting (detect problem-description queries, extract nouns for better embedding match)
  const rewrite = await maybeRewriteQuery(req.q || "");
  const searchQuery = rewrite.query;

  // 2b. Semantic search (using rewritten query if applicable)
  const embedding = await embedQuery(searchQuery);
  const vecStr = toVectorStr(embedding);

  // Parse filter params
  const minConfidence = clampFloat(req.min_confidence, 0, 0, 1.0);
  const visibility = req.visibility || "public";

  // Fetch adaptive heat weight ONCE per request
  const [hwRow] = await sql`SELECT heat_weight() as w`;
  const hw = parseFloat(hwRow.w);

  // All depths get description + node_type + freshness + quick_start + provides
  const baseFields = sql`
    n.addr, n.pyramid_id, n.label, n.layer, n.depth, n.confidence, n.resonance, n.node_type,
    n.stimulus_heat, n.resonance_structural, n.resonance_components, n.confidence_by_domain, n.source_context,
    n.space_id,
    n.substance->>'description' as description,
    n.substance->'quick_start' as quick_start,
    n.substance->'provides' as provides,
    n.substance->'grounding_principles' as grounding_principles,
    n.substance->'heuristic_injections' as heuristic_injections,
    n.substance->'truth_injections' as truth_injections,
    n.substance->'failure_patterns' as failure_patterns,
    n.substance->>'slug' as slug,
    n.substance->>'memory_type' as memory_type,
    n.query_hits, n.parent_addr, n.updated_at, n.visibility,
    r.access_level`;
  const semanticSimilarityField = sql`1 - (n.embedding_hv <=> ${vecStr}::halfvec) as similarity`;

  const deepFields = req.depth !== "shallow"
    ? sql`, n.substance->'readiness' as readiness, n.substance->'runbook' as runbook, n.substance->'key_rules' as key_rules, n.substance->'references' as refs, n.source_refs, n.provenance`
    : sql``;

  const trendLifecycleClause = sql`
    AND (
      (n.node_type IS DISTINCT FROM 'trend'
        OR COALESCE(n.source_context->'trend'->>'lifecycle', 'emerging') != 'emerging')
      AND n.node_type IS DISTINCT FROM 'changelog'
    )`;

  const typeClause = req.type
    ? sql`AND n.node_type = ${req.type}`
    : sql``;

  // Space-isolated retrieval: global and tenant spaces are queried independently
  // and merged. This mirrors the target architecture where public knowledge lives
  // on a shared server and private knowledge lives on the tenant's device.
  const globalVisibility = sql`
    AND n.space_id = ${GLOBAL_SPACE_ID}
    AND n.visibility = 'public'
    AND r.access_level = ANY(${accessLevels}::text[])`;

  const tenantVisibility = tenantMemorySpaceId
    ? sql`AND n.space_id = ${tenantMemorySpaceId} AND n.visibility <> 'deleted'`
    : null;

  const operatorVisibility = accessScope === "operator"
    ? req.visibility === "all" ? sql`AND n.visibility <> 'deleted'` : sql`AND n.visibility = ${req.visibility || "public"} AND n.visibility <> 'deleted'`
    : null;

  // Unified visibility clause for fallback/supplemental queries that can't be split
  const visibilityClause = operatorVisibility || (tenantMemorySpaceId
    ? sql`AND n.space_id = ANY(${spaceIds}::text[]) AND n.visibility <> 'deleted' AND (n.space_id <> ${GLOBAL_SPACE_ID} OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))`
    : globalVisibility);

  const pyramidClause = req.pyramids && req.pyramids.length > 0
    ? sql`AND n.pyramid_id = ANY(${req.pyramids})`
    : sql``;

  const searchLimit = Math.min(req.limit * 4, 200);

  async function searchSpace(visClause: any, limit: number) {
    return sql`
      SELECT ${baseFields}, ${semanticSimilarityField} ${deepFields}
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.embedding_hv IS NOT NULL
        AND n.confidence >= ${minConfidence}
        AND n.visibility <> 'deleted'
        ${visClause}
        ${pyramidClause}
        ${typeClause}
        ${trendLifecycleClause}
      ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
      LIMIT ${limit}`;
  }

  // Primary semantic search — space-isolated for tenant queries
  let searchResults;
  if (operatorVisibility) {
    searchResults = await searchSpace(operatorVisibility, searchLimit);
  } else if (tenantVisibility) {
    const [globalResults, tenantResults] = await Promise.all([
      searchSpace(globalVisibility, searchLimit),
      searchSpace(tenantVisibility, Math.min(req.limit * 2, 80)),
    ]);
    const seen = new Set<string>();
    searchResults = [];
    for (const row of [...tenantResults, ...globalResults]) {
      if (!seen.has(row.addr)) { seen.add(row.addr); searchResults.push(row); }
    }
  } else {
    searchResults = await searchSpace(globalVisibility, searchLimit);
  }

  const topSemanticSimilarity = searchResults.length > 0
    ? Math.max(...searchResults.map((row: any) => parseFloat(row.similarity) || 0))
    : 0;

  if (searchResults.length === 0 || topSemanticSimilarity < 0.45) {
    const textRankExpr = sql`
      CASE
        WHEN lower(n.label) = lower(${req.q}) THEN 4
        WHEN n.label ILIKE ${req.q + "%"} THEN 3
        WHEN n.label ILIKE ${"%" + req.q + "%"} THEN 2
        WHEN n.substance::text ILIKE ${"%" + req.q + "%"} THEN 1
        ELSE 0
      END
    `;

    if (req.pyramids && req.pyramids.length > 0) {
      searchResults = await sql`
        SELECT ${baseFields},
          CASE
            WHEN lower(n.label) = lower(${req.q}) THEN 0.95
            WHEN n.label ILIKE ${req.q + "%"} THEN 0.9
            WHEN n.label ILIKE ${"%" + req.q + "%"} THEN 0.82
            ELSE 0.72
          END AS similarity
          ${deepFields}
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.pyramid_id = ANY(${req.pyramids})
          AND n.confidence >= ${minConfidence}
          ${visibilityClause}
          ${typeClause}
          ${trendLifecycleClause}
          AND (
            n.label ILIKE ${"%" + req.q + "%"}
            OR n.substance::text ILIKE ${"%" + req.q + "%"}
          )
        ORDER BY ${textRankExpr} DESC, n.confidence DESC
        LIMIT ${Math.min(req.limit * 4, 200)}`;
    } else {
      searchResults = await sql`
        SELECT ${baseFields},
          CASE
            WHEN lower(n.label) = lower(${req.q}) THEN 0.95
            WHEN n.label ILIKE ${req.q + "%"} THEN 0.9
            WHEN n.label ILIKE ${"%" + req.q + "%"} THEN 0.82
            ELSE 0.72
          END AS similarity
          ${deepFields}
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.confidence >= ${minConfidence}
          ${visibilityClause}
          ${typeClause}
          ${trendLifecycleClause}
          AND (
            n.label ILIKE ${"%" + req.q + "%"}
            OR n.substance::text ILIKE ${"%" + req.q + "%"}
          )
        ORDER BY ${textRankExpr} DESC, n.confidence DESC
        LIMIT ${Math.min(req.limit * 4, 200)}`;
    }
  }

  // BM25 blending for mid-range similarity: when semantic search finds something
  // but not confidently, supplement with keyword matches
  if (topSemanticSimilarity >= 0.45 && topSemanticSimilarity < 0.70 && queryPatterns.length > 0) {
    const keyTerms = (req.q || "").split(/\s+/).filter((t: string) => t.length >= 3).slice(0, 3);
    if (keyTerms.length > 0) {
      const pattern = "%" + keyTerms.join("%") + "%";
      const bm25Results = await sql`
        SELECT ${baseFields},
          0.68 AS similarity
          ${deepFields}
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.confidence >= ${minConfidence}
          ${visibilityClause}
          ${typeClause}
          ${trendLifecycleClause}
          AND (
            n.label ILIKE ${pattern}
            OR n.substance::text ILIKE ${pattern}
          )
        ORDER BY n.confidence DESC
        LIMIT 10
      `.catch(() => [] as any[]);
      searchResults = dedupeByAddr([...searchResults, ...bm25Results]);
    }
  }

  if (accessScope !== "operator") {
    searchResults = filterReadableNodes(searchResults, access);
  } else {
    searchResults = searchResults.slice();
  }

  // Inject tenant memories from recall compiler (or fallback) into search results
  const isRecallQuery = queryIntent.recall || queryIntent.temporal;
  if (temporalMemories.length > 0) {
    const existingAddrs = new Set(searchResults.map((r: any) => r.addr));
    for (const mem of temporalMemories) {
      if (!existingAddrs.has(mem.addr)) {
        // If recall compiler scored this, use composite_score mapped to similarity range
        // Otherwise fall back to maturity/recency heuristic
        let similarity: number;
        if (mem._recall_score != null) {
          // Map composite_score (0-1) to similarity range (0.70-1.10) for proper reranking
          similarity = parseFloat((0.70 + mem._recall_score * 0.40).toFixed(3));
          if (isRecallQuery) similarity = parseFloat((similarity * 1.2).toFixed(3));
        } else {
          const baseBoost = mem.maturity_stage === "consolidated" ? 0.92 : 0.85;
          const ageDays = (Date.now() - new Date(mem.created_at).getTime()) / 86400000;
          const recencyFactor = Math.max(0.70, 1 - 0.003 * ageDays);
          const recallMultiplier = isRecallQuery ? 1.3 : 1.0;
          similarity = parseFloat((baseBoost * recencyFactor * recallMultiplier).toFixed(3));
        }
        searchResults.unshift({ ...mem, similarity, pyramid_id: mem.pyramid_id || "PROJECTS" });
        existingAddrs.add(mem.addr);
      }
    }
  }

  if (
    queryPatterns.length > 0
    && queryIntent.targetPyramidId
    && !queryIntent.explicitMeta
    && !queryIntent.explicitLocal
  ) {
    let supplemental = await sql`
      WITH aligned_nodes AS (
        SELECT e.from_addr AS node_addr
        FROM edges e
        WHERE COALESCE(e.source_context->>'alignment_version', '') <> ''
          AND e.to_addr = ${queryIntent.targetParentAddr || ""}
      )
      SELECT ${baseFields},
        CASE
          WHEN n.parent_addr = ${queryIntent.targetParentAddr || ""} THEN 0.9
          ELSE 0.62
        END AS similarity
        ${deepFields}
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = ${queryIntent.targetPyramidId}
          OR n.parent_addr = ${queryIntent.targetParentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND n.confidence >= ${minConfidence}
        ${visibilityClause}
        ${typeClause}
        ${trendLifecycleClause}
        AND (
          n.label ILIKE ANY(${queryPatterns}::text[])
          OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
        )
      ORDER BY n.confidence DESC
      LIMIT ${Math.max(req.limit, 8)}
    `;
    if (accessScope !== "operator") supplemental = filterReadableNodes(supplemental, access) as typeof supplemental;
    searchResults = dedupeByAddr([...searchResults, ...supplemental]);
  }
  // Capability-name boost: if a node's `provides` array contains query terms,
  // bump its similarity so it survives downstream relevance filters.
  // This bridges the gap between /search (no filters) and /context (strict filters)
  // for capability-style queries like "deploy nextjs" or "send sms twilio".
  const queryTerms = (req.q || "").toLowerCase().split(/[\s+]+/).filter((t: string) => t.length > 2);
  if (queryTerms.length > 0) {
    for (const row of searchResults) {
      const provides = row.provides;
      if (Array.isArray(provides) && provides.length > 0) {
        const providesText = provides.join(" ").toLowerCase();
        const matchCount = queryTerms.filter((t: string) => providesText.includes(t)).length;
        if (matchCount > 0) {
          const boost = Math.min(0.08, matchCount * 0.03);
          row.similarity = String(Math.min(1.0, parseFloat(row.similarity) + boost));
        }
      }
    }
  }

  const rerankedResults = rerankRetrievalRows(req.q, searchResults);
  const topRejectedPolluters = rerankedResults
    .slice(req.limit, req.limit + 8)
    .filter((r: any) => ["OC", "META", "FN", "CC", "WD"].includes(`${r.pyramid_id || ""}`))
    .slice(0, 5)
    .map((r: any) => ({ addr: r.addr, label: r.label, pyramid_id: r.pyramid_id, similarity: roundFloat(r.similarity) }));
  searchResults = rerankedResults.slice(0, req.limit);

  // TRUTH FILTER: World and Heuristic nodes only surface when
  // an answer-capable node (FUNCTION, META, PROJECTS, etc.) is already
  // present with sufficient relevance. They reinforce and narrow — they
  // are never standalone answers.
  const TRUTH_RELEVANCE_THRESHOLD = 0.48;
  const TRUTH_STANDALONE_THRESHOLD = 0.65;
  const answerNodes = searchResults.filter(
    (r: any) => !TRUTH_PYRAMIDS.has(`${r.pyramid_id || ""}` as KnownPyramidId)
  );
  const bestAnswerRelevance = answerNodes.length > 0
    ? Math.max(...answerNodes.map((r: any) => parseFloat(r.similarity) || 0))
    : 0;
  const bestTruthRelevance = searchResults
    .filter((r: any) => TRUTH_PYRAMIDS.has(`${r.pyramid_id || ""}` as KnownPyramidId))
    .reduce((max: number, r: any) => Math.max(max, parseFloat(r.similarity) || 0), 0);
  if (bestAnswerRelevance < TRUTH_RELEVANCE_THRESHOLD && bestTruthRelevance < TRUTH_STANDALONE_THRESHOLD) {
    // No strong functional answer AND truth nodes are weak — drop reinforcement nodes
    searchResults = answerNodes;
  }
  // If truth nodes are strong (>= 0.65), they stand alone even without a functional companion
  // If answer nodes exist with good relevance, reinforcement nodes stay
  // (they earned their place by resonating with the query AND a functional answer exists)

  // Re-sort AFTER heat map is built so we can use live-decayed values
  // (moved below heat map fetch)

  // Increment query hits (fire-and-forget — deadlock-prone under concurrency)
  const addrs = searchResults.map((r: any) => r.addr);
  if (addrs.length > 0) {
    sql`SELECT increment_query_hits(${addrs}::text[])`.catch(() => {});
  }
  const bridgeContext = await selectOntologyBridgeContext(addrs, access, {
    anchorLimit: req.depth === "shallow" ? 3 : 5,
    bridgeLimit: req.depth === "shallow" ? 4 : 6,
    queryText: req.q,
  });

  // Batch fetch LIVE-DECAYED channel decomposition for all returned nodes
  // Uses compute_decay() to get fresh values — the graph breathes on every query
  let heatMap: Record<string, any> = {};
  if (addrs.length > 0) {
    const heatRows = await sql`
      SELECT
        sc.node_addr,
        COALESCE(SUM(compute_decay(
          s.created_at,
          COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
          COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
          sc.base_contribution
        )), 0) as live_heat,
        COALESCE(SUM(CASE WHEN sc.channel='confidence' THEN compute_decay(
          s.created_at,
          COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
          COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
          sc.base_contribution
        ) ELSE 0 END),0) as heat_confidence,
        COALESCE(SUM(CASE WHEN sc.channel='relevance' THEN compute_decay(
          s.created_at,
          COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
          COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
          sc.base_contribution
        ) ELSE 0 END),0) as heat_relevance,
        COALESCE(SUM(CASE WHEN sc.channel='interest' THEN compute_decay(
          s.created_at,
          COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
          COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
          sc.base_contribution
        ) ELSE 0 END),0) as heat_interest,
        COUNT(DISTINCT sc.stimulus_id) as heat_breadth,
        (SELECT s2.source FROM stimulus_contributions sc2 JOIN stimuli s2 ON s2.id=sc2.stimulus_id
         WHERE sc2.node_addr=sc.node_addr ORDER BY sc2.base_contribution DESC LIMIT 1) as heat_top_source
      FROM stimulus_contributions sc
      JOIN stimuli s ON s.id = sc.stimulus_id
      WHERE sc.node_addr = ANY(${addrs}) AND sc.base_contribution > 0.001
      GROUP BY sc.node_addr`;
    for (const row of heatRows) {
      heatMap[row.node_addr] = row;
    }
  }

  // Re-sort by blended score using LIVE-DECAYED heat values
  // External-reality queries should stay anchored to semantic relevance rather than internal graph heat.
  // Tenant-private nodes get a small affinity boost so personal memories surface alongside public knowledge.
  searchResults.sort((a: any, b: any) => {
    const heatA = heatMap[a.addr] ? parseFloat(heatMap[a.addr].live_heat) || 0 : 0;
    const heatB = heatMap[b.addr] ? parseFloat(heatMap[b.addr].live_heat) || 0 : 0;
    const relevanceWeight = queryIntent.externalReality ? 0.92 : 0.75;
    const heatWeight = queryIntent.externalReality ? 0.08 : 0.25;
    // Tenant affinity boost is gated: only apply when semantic similarity ≥ 0.30.
    // Without the gate, hot tenant nodes with low topic relevance displace on-topic public nodes
    // (observed: example nodes scoring 1.2+ for scheduling queries).
    const simA = parseFloat(a.similarity);
    const simB = parseFloat(b.similarity);
    const TENANT_SIM_GATE = 0.30;
    const tenantBoostA = tenantMemorySpaceId && a.space_id === tenantMemorySpaceId && simA >= TENANT_SIM_GATE ? 0.06 : 0;
    const tenantBoostB = tenantMemorySpaceId && b.space_id === tenantMemorySpaceId && simB >= TENANT_SIM_GATE ? 0.06 : 0;
    let scoreA = relevanceWeight * simA + heatWeight * (heatA * hw) + tenantBoostA;
    let scoreB = relevanceWeight * simB + heatWeight * (heatB * hw) + tenantBoostB;

    // Temporal boost: additive, only when ?temporal=true (Temporal Circle integration)
    // Max addition ~0.18 — not enough to override strong semantic match, enough to break ties
    if (req.query?.temporal === "true") {
      const orderBoostA = parseFloat(a.order_score) || 0;
      const orderBoostB = parseFloat(b.order_score) || 0;
      scoreA += orderBoostA * 0.08;
      scoreB += orderBoostB * 0.08;
    }

    return scoreB - scoreA;
  });

  // When there's a query, skip registry (saves ~200 tokens per call)
  // Agent already knows what pyramids exist from first call
  if (req.q) {
    delete sections.registry;
  }

  // 3. Format based on depth
  const layerLabel = (l: number) => l === 0 ? "L0" : l === 1 ? "L1" : "L2";

  const addHeatFields = (node: any, r: any) => {
    const hd = heatMap[r.addr];
    const sourceContext = parseJsonField<any>(r.source_context) || {};
    // Use LIVE-DECAYED heat (computed fresh) instead of stored stimulus_heat
    const heat = hd ? parseFloat(hd.live_heat) || 0 : 0;
    node.stimulus_heat = roundFloat(heat);
    node.live_resonance = roundFloat(parseFloat(r.resonance) + heat * hw);
    node.resonance_structural = roundFloat(parseFloat(r.resonance_structural) || 0);
    node.heat_confidence = roundFloat(parseFloat(hd?.heat_confidence) || 0);
    node.heat_relevance = roundFloat(parseFloat(hd?.heat_relevance) || 0);
    node.heat_interest = roundFloat(parseFloat(hd?.heat_interest) || 0);
    node.heat_breadth = parseInt(hd?.heat_breadth) || 0;
    node.heat_top_source = hd?.heat_top_source || null;

    // Domain-scoped confidence
    if (req.domain) {
      const domainMap = parseJsonField(r.confidence_by_domain) || {};
      node.domain_confidence = domainMap[req.domain] != null
        ? roundFloat(domainMap[req.domain])
        : roundFloat(r.confidence);
    }

    if (r.node_type === "trend") {
      node.trend = sourceContext.trend || null;
      node.lifecycle = sourceContext.trend?.lifecycle || "emerging";
      node.velocity = roundFloat(sourceContext.trend?.velocity || 0);
    }
  };

  if (req.depth === "shallow") {
    sections.nodes = searchResults.map((r: any) => {
      const node: any = {
        addr: r.addr,
        pyramid_id: r.pyramid_id,
        label: r.label,
        type: r.node_type,
        node_type: r.node_type,
        layer: layerLabel(r.layer),
        confidence: roundFloat(r.confidence),
        relevance: roundFloat(r.similarity),
        description: r.description ? r.description.slice(0, 400) : null,
        updated_at: r.updated_at,
      };
      // Memory nodes: preserve tenant-critical fields for compact serialization
      if (r.node_type === "memory") {
        node.memory_type = r.memory_type || null;
        node.space_id = r.space_id || null;
        node.visibility = r.visibility || null;
      }
      addHeatFields(node, r);
      if (["tool", "skill", "workflow"].includes(r.node_type) && r.quick_start) {
        node.quick_start = r.quick_start;
      }
      if (r.provides && Array.isArray(r.provides) && r.provides.length > 0) {
        node.provides = r.provides;
      }
      if (r.grounding_principles && Array.isArray(r.grounding_principles) && r.grounding_principles.length > 0) {
        node.grounding_principles = r.grounding_principles;
      }
      if (r.heuristic_injections && Array.isArray(r.heuristic_injections) && r.heuristic_injections.length > 0) {
        node.heuristic_injections = r.heuristic_injections.map((h: any) => h.injection || h);
      }
      if (r.truth_injections && Array.isArray(r.truth_injections) && r.truth_injections.length > 0) {
        node.truth_injections = r.truth_injections.map((t: any) => t.injection || t);
      }
      if (r.failure_patterns && Array.isArray(r.failure_patterns) && r.failure_patterns.length > 0) {
        node.failure_warnings = r.failure_patterns.map((fp: any) => `⚠️ ${fp.injection_text} [${fp.incidents} incident(s), cost: ${fp.cost}]`);
      }
      return node;
    });
  } else {
    // Deep/Full: everything + actionable fields + provenance
    sections.nodes = searchResults.map((r: any) => {
      const node: any = {
        addr: r.addr,
        pyramid_id: r.pyramid_id,
        label: r.label,
        type: r.node_type,
        node_type: r.node_type,
        layer: layerLabel(r.layer),
        confidence: roundFloat(r.confidence),
        relevance: roundFloat(r.similarity),
        description: r.description,
        updated_at: r.updated_at,
        visibility: r.visibility,
        space_id: r.space_id,
      };
      // Memory nodes: preserve memory_type for recall routing
      if (r.node_type === "memory") {
        node.memory_type = r.memory_type || null;
      }
      addHeatFields(node, r);
      // Provenance and source refs (deep+)
      if (r.provenance) {
        const prov = parseJsonField(r.provenance);
        node.provenance = {
          agent: prov.agent,
          source: prov.source,
          asserted: !prov.inferred, // true = from a known source, false = AI-inferred
        };
      }
      if (includeSensitiveRefs && r.source_refs) {
        const refs = parseJsonField(r.source_refs);
        if (Array.isArray(refs) && refs.length > 0) {
          // Stamp the closed source-ref kind (plan Q1=A) so the dashboard can
          // detect vault_file refs and render an "Open in Obsidian" link.
          node.source_refs = withResolvedKinds(refs as SourceRef[]);
        }
      }
      // Actionable fields for tools/skills/workflows/procedures/protocols
      if (["tool", "skill", "workflow", "procedure", "protocol"].includes(r.node_type)) {
        if (r.slug) node.slug = r.slug;
        if (r.provides) node.provides = r.provides;
        if (r.quick_start) node.quick_start = r.quick_start;
        if (r.runbook) node.runbook = r.runbook;
        if (r.key_rules) node.key_rules = r.key_rules;
        if (r.refs) node.references = r.refs;
        node.cost = r.readiness?.cost || "unknown";
      }
      if (r.grounding_principles && Array.isArray(r.grounding_principles) && r.grounding_principles.length > 0) {
        node.grounding_principles = r.grounding_principles;
      }
      if (r.heuristic_injections && Array.isArray(r.heuristic_injections) && r.heuristic_injections.length > 0) {
        node.heuristic_injections = r.heuristic_injections.map((h: any) => h.injection || h);
      }
      if (r.truth_injections && Array.isArray(r.truth_injections) && r.truth_injections.length > 0) {
        node.truth_injections = r.truth_injections.map((t: any) => t.injection || t);
      }
      if (r.failure_patterns && Array.isArray(r.failure_patterns) && r.failure_patterns.length > 0) {
        node.failure_warnings = r.failure_patterns.map((fp: any) => `⚠️ ${fp.injection_text} [${fp.incidents} incident(s), cost: ${fp.cost}]`);
      }
      return node;
    });
  }

  // Context Collapse: apply variant selection to returned nodes (parallelized)
  if (req.q && sections.nodes) {
    const agent = (req as any).agent || null;
    await Promise.all(sections.nodes.map((node: any) => collapseSubstance(node, req.q!, agent)));
  }

  // 4. Edges between found nodes
  if (addrs.length > 1) {
    const edgeLimit = req.depth === "shallow" ? 10 : 25;
    let edges;
    if (req.edge_types && req.edge_types.length > 0) {
      edges = await sql`
        SELECT from_addr, to_addr, edge_type, label, layer, confidence
        FROM edges 
        WHERE from_addr = ANY(${addrs})
          AND to_addr = ANY(${addrs})
          ${accessScope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}
          AND edge_type = ANY(${req.edge_types})
        ORDER BY confidence DESC
        LIMIT ${edgeLimit}`;
    } else {
      edges = await sql`
        SELECT from_addr, to_addr, edge_type, label, layer, confidence
        FROM edges 
        WHERE from_addr = ANY(${addrs})
          AND to_addr = ANY(${addrs})
          ${accessScope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}
        ORDER BY confidence DESC
        LIMIT ${edgeLimit}`;
    }

    sections.edges = edges.map((e: any) => {
      const heatFrom = heatMap[e.from_addr] ? parseFloat(heatMap[e.from_addr].live_heat) || 0 : 0;
      const heatTo = heatMap[e.to_addr] ? parseFloat(heatMap[e.to_addr].live_heat) || 0 : 0;
      const heatBoost = 1 + heatFrom + heatTo;
      return {
        from: e.from_addr,
        to: e.to_addr,
        type: e.edge_type,
        label: e.label,
        confidence: parseFloat(e.confidence),
        heat_boost: roundFloat(heatBoost),
      };
    });

    // Sort edges by heat-boosted confidence
    sections.edges.sort((a: any, b: any) => (b.confidence * b.heat_boost) - (a.confidence * a.heat_boost));

    // Interconnections: edges where BOTH endpoints are in the returned set (AND semantics)
    // Reveals internal structure of the subgraph, not just connections to the outside
    const interEdges = await sql`
      SELECT from_addr, to_addr, edge_type, label, confidence
      FROM edges
      WHERE from_addr = ANY(${addrs}) AND to_addr = ANY(${addrs})
        ${accessScope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}
      ORDER BY confidence DESC
      LIMIT ${edgeLimit}`;

    if (interEdges.length > 0) {
      sections.interconnections = interEdges.map((e: any) => ({
        from: e.from_addr,
        to: e.to_addr,
        type: e.edge_type,
        label: e.label,
        confidence: parseFloat(e.confidence),
      }));
    }
  }

  if (bridgeContext.anchors.length > 0 || bridgeContext.bridges.length > 0) {
    sections.bridges = formatOntologyBridgePayload(bridgeContext);
    sections.ontology = sections.bridges;
  }

  const skills = await selectRelevantSkills(req.q, {
    limit: req.depth === "shallow" ? 2 : 3,
    includeNeedsHuman: accessScope === "operator",
  });
  if (skills.length > 0) {
    sections.skills = skills.map((skill) => ({
      id: skill.id,
      content: skill.content,
      type: skill.skill_type || "skill",
      status: skill.status,
      source_url: skill.source_url,
      skill_path: skill.skill_path,
    }));
  }

  // 5. Source references (only in deep/full mode)
  if (includeSensitiveRefs && req.depth !== "shallow" && addrs.length > 0) {
    const refs = await sql`
      SELECT node_addr, file_path, file_type, line_start, line_end, excerpt
      FROM file_index
      WHERE node_addr = ANY(${addrs})
      ORDER BY node_addr, file_type`;

    if (refs.length > 0) {
      sections.sources = refs.map((r: any) => ({
        node: r.node_addr,
        path: r.file_path,
        type: r.file_type,
        lines: r.line_start ? `${r.line_start}-${r.line_end}` : null,
        excerpt: req.depth === "full" ? r.excerpt : null,
      }));
    }

    // Also check source_refs on the nodes themselves
    const nodeRefs = await sql`
      SELECT addr, source_refs FROM nodes 
      WHERE addr = ANY(${addrs})
        AND visibility <> 'deleted'
        AND source_refs != '[]'::jsonb
        ${accessScope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}`;

    if (nodeRefs.length > 0) {
      sections.node_sources = nodeRefs.map((r: any) => ({
        addr: r.addr,
        refs: r.source_refs,
      }));
    }
  }

  // 6. Drill hints (always included — tells the agent what's available)
  sections.drill = {
    node_detail: "/nodes/:addr — full node with all edges and source refs",
    subgraph: "/subgraph?root=ADDR&depth=2 — neighborhood around a node",
    insight: "/insight?q=QUESTION — multi-dimensional synthesis with citations",
    code: "source_refs on nodes contain file paths + line numbers for code drill-down",
    md: "file_index table maps MD file lines to nodes — query /context?depth=full for refs",
  };

  // Filter out low-relevance filler nodes
  // Lowered from 0.55 to 0.42 so capability-style queries (which often score
  // in the 0.45-0.55 range) are not silently dropped while /search returns them.
  const MIN_RELEVANCE = 0.42;
  const filteredResults = searchResults.filter((r: any) => parseFloat(r.similarity) >= MIN_RELEVANCE);
  
  // Update sections.nodes with filtered results if we had to trim
  if (filteredResults.length < searchResults.length && filteredResults.length > 0) {
    // Re-build nodes section from filtered results
    const filtered_addrs = filteredResults.map((r: any) => r.addr);
    sections.nodes = sections.nodes.filter((n: any) => filtered_addrs.includes(n.addr));
  }

  // Filter out low-relevance filler (anything below 0.35 similarity is noise)
  // Lowered from 0.45 to 0.35 to align with /search behavior — /search has no
  // floor and always returns top-N by vector distance.
  const RELEVANCE_FLOOR = 0.35;
  searchResults = searchResults.filter((r: any) => parseFloat(r.similarity) >= RELEVANCE_FLOOR);

  // Relevance warning when top result is below threshold
  const topRelevance = searchResults.length > 0
    ? parseFloat(parseFloat(searchResults[0].similarity).toFixed(3))
    : 0;
  const low_relevance = topRelevance < 0.6;

  // Semantic similarity fallback: if the graph has no strong match for ANY query,
  // and no internal override terms fired, reclassify as external_world.
  // This eliminates the need to manually add every possible external topic to EXTERNAL_REALITY_TERMS.
  const SEMANTIC_EXTERNAL_THRESHOLD = 0.65;
  if (
    queryIntent.mode !== "internal_system"
    && queryIntent.mode !== "external_world"
    && !queryIntent.explicitMeta
    && !queryIntent.explicitLocal
    && topSemanticSimilarity < SEMANTIC_EXTERNAL_THRESHOLD
    && topSemanticSimilarity > 0
  ) {
    queryIntent.mode = "external_world" as any;
    queryIntent.externalReality = true;
  }

  // For external_world queries, trust semantic similarity more than blended rank/heat,
  // since boosted ontology branches can look "relevant" without actually grounding the query.
  const externalCoverageLow = queryIntent.mode === "external_world"
    && (topSemanticSimilarity < 0.68 || topRelevance < 0.68);

  const rankingDebugSummary = {
    query_mode: queryIntent.mode,
    top_similarity: roundFloat(topRelevance),
    top_semantic_similarity: roundFloat(topSemanticSimilarity),
    external_reality: queryIntent.externalReality,
    heat_weight: roundFloat(hw),
  };

  // TENSION ENRICHMENT — surface dialectic tensions between returned nodes
  // Uses tension_meaning_boost() for scoring + direct edge_tensions query for details
  if (addrs.length > 0) {
    // Fetch meaning boosts (lightweight, ~20ms)
    const boosts = accessScope === "operator"
      ? await sql`SELECT * FROM tension_meaning_boost(${addrs}::text[])`
      : await sql`
          WITH tension_data AS (
            SELECT et.from_addr AS node_addr, et.tension, et.tension_type
            FROM edge_tensions et
            JOIN nodes nf ON nf.addr = et.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = et.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE et.resolved_at IS NULL
              AND et.from_addr = ANY(${addrs}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
            UNION ALL
            SELECT et.to_addr AS node_addr, et.tension, et.tension_type
            FROM edge_tensions et
            JOIN nodes nf ON nf.addr = et.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = et.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE et.resolved_at IS NULL
              AND et.to_addr = ANY(${addrs}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
          ),
          typed_boosts AS (
            SELECT
              node_addr,
              tension * CASE tension_type
                WHEN 'tradeoff' THEN 1.0
                WHEN 'paradox' THEN 0.8
                WHEN 'complement' THEN 0.6
                WHEN 'constraint' THEN 0.3
                WHEN 'contradiction' THEN -0.5
                ELSE 0.0
              END AS typed_boost,
              tension,
              tension_type
            FROM tension_data
          ),
          aggregated AS (
            SELECT
              node_addr,
              LEAST(
                MAX(typed_boost) * (1 + 0.1 * LN(GREATEST(COUNT(*)::numeric, 1))),
                0.5
              )::real AS meaning_boost,
              COUNT(*)::integer AS tension_count,
              (
                SELECT tension_type
                FROM typed_boosts tb2
                WHERE tb2.node_addr = typed_boosts.node_addr
                ORDER BY tb2.typed_boost DESC
                LIMIT 1
              ) AS top_tension_type
            FROM typed_boosts
            GROUP BY node_addr
          )
          SELECT node_addr AS addr, meaning_boost, tension_count, top_tension_type
          FROM aggregated
        `;
    const boostMap: Record<string, any> = {};
    for (const b of boosts) {
      boostMap[b.addr] = b;
    }

    // Apply meaning_boost to nodes
    if (sections.nodes) {
      for (const node of sections.nodes) {
        const b = boostMap[node.addr];
        if (b) {
          node.meaning_boost = roundFloat(b.meaning_boost);
          node.tension_count = b.tension_count;
          node.top_tension_type = b.top_tension_type;
        }
      }
    }

    // Fetch active tensions between returned nodes (deep/full only)
    if (req.depth !== "shallow") {
      const tensions = accessScope === "operator"
        ? await sql`
            SELECT et.from_addr, et.to_addr, et.tension, et.tension_type, et.synthesis, et.synthesis_confidence
            FROM edge_tensions et
            JOIN nodes nf ON nf.addr = et.from_addr
            JOIN nodes nt ON nt.addr = et.to_addr
            WHERE et.resolved_at IS NULL
              AND et.from_addr = ANY(${addrs}::text[])
              AND et.to_addr = ANY(${addrs}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
            ORDER BY et.tension DESC
            LIMIT 10`
        : await sql`
            SELECT et.from_addr, et.to_addr, et.tension, et.tension_type, et.synthesis, et.synthesis_confidence
            FROM edge_tensions et
            JOIN nodes nf ON nf.addr = et.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = et.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE et.resolved_at IS NULL
              AND et.from_addr = ANY(${addrs}::text[])
              AND et.to_addr = ANY(${addrs}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
            ORDER BY et.tension DESC
            LIMIT 10`;

      if (tensions.length > 0) {
        sections.tensions = tensions.map((t: any) => ({
          between: [t.from_addr, t.to_addr],
          type: t.tension_type,
          tension: parseFloat(parseFloat(t.tension).toFixed(3)),
          synthesis: t.synthesis || null,
          synthesis_confidence: t.synthesis_confidence ? parseFloat(parseFloat(t.synthesis_confidence).toFixed(3)) : null,
        }));
      }
    }
  }

  // AGENT FEEDBACK LOOP — fire-and-forget
  // Every /context query is a pulse. The graph feels agents using it.
  // Don't await — this runs in background, zero added latency.
  // F11: capture correlation_id BEFORE the async closure so the request id
  // makes it into the stimulus row even though the insert is fire-and-forget.
  if (req.q && addrs.length > 0) {
    const queryCorrelationId = correlationId;
    const queryAccess = access;
    const querySpaceId = queryAccess.tenantId ? tenantSpaceId(queryAccess.tenantId) : GLOBAL_SPACE_ID;
    (async () => {
      try {
        // Rate limit: max 1 agent stimulus per 60 seconds
        const [recent] = await sql`
          SELECT COUNT(*)::int as n FROM stimuli
          WHERE source = 'agent' AND stimulus_type = 'agent_query'
            AND created_at > now() - interval '60 seconds'`;
        if (recent.n === 0) {
          await sql`
            INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, decay_halflife_hours, peak_delay_hours, processed, correlation_id, space_id)
            VALUES ('agent', ${'aq_' + Date.now()}, 'agent_query', 0.3, ${('Agent queried: ' + req.q).slice(0, 500)}, 4, 0, false, ${queryCorrelationId}, ${querySpaceId})
            ON CONFLICT (source, source_id) DO NOTHING`;
        }
      } catch (_) { /* silent — never block the response */ }
    })();
  }

  // Optional brief heat summary (~20 tokens, only when ?brief=true)
  let briefSummary: string | undefined;
  if (req.brief && sections.nodes) {
    const heatedNodes = sections.nodes.filter((n: any) => n.stimulus_heat > 0);
    if (heatedNodes.length > 0) {
      const sources = [...new Set(heatedNodes.map((n: any) => n.heat_top_source).filter(Boolean))];
      briefSummary = `${heatedNodes.length} node${heatedNodes.length === 1 ? '' : 's'} heated by ${sources.join(', ') || 'stimuli'} in recent activity`;
    }
  }

  // --- v3: Regrounding (top 3 relevant heuristics for this query) ---
  let regrounding: any[] = [];
  if (req.q) {
    const heuristicResults = await sql`
      SELECT n.addr, n.label,
        COALESCE(n.substance->>'heuristic_text', n.substance->>'truth') AS heuristic_text,
        1 - (n.embedding_hv <=> ${vecStr}::halfvec) AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.pyramid_id = 'HEURISTIC' AND n.embedding_hv IS NOT NULL
        AND n.visibility <> 'deleted'
        ${accessScope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
      LIMIT 5`;
    regrounding = heuristicResults
      .filter((h: any) => parseFloat(h.similarity) > 0.55)
      .slice(0, 3)
      .map((h: any) => ({
        addr: h.addr,
        heuristic: h.heuristic_text,
        relevance: roundFloat(h.similarity),
      }));
  }

  // --- v3: Applicable schemas ---
  let applicable_schemas: any[] = [];
  if (req.q) {
    const schemaResults = await sql`
      SELECT n.addr, n.label, n.substance->>'schema_purpose' AS purpose,
        n.substance->>'when_active' AS when_active,
        1 - (n.embedding_hv <=> ${vecStr}::halfvec) AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.node_type = 'schema' AND n.embedding_hv IS NOT NULL
        AND n.visibility <> 'deleted'
        ${accessScope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
      LIMIT 3`;
    applicable_schemas = schemaResults
      .filter((s: any) => parseFloat(s.similarity) > 0.5)
      .map((s: any) => ({
        addr: s.addr,
        label: s.label,
        purpose: s.purpose,
        when_active: s.when_active,
        relevance: roundFloat(s.similarity),
      }));
  }

  // --- v3: Guards ---
  const guardResults = sections.nodes?.length > 0
    ? await checkGuards(
        { query: req.q, agentId: (req as any).agent, endpoint: "/context" },
        {
          nodes: sections.nodes.map((n: any) => ({
            addr: n.addr,
            similarity: n.relevance,
            confidence: n.confidence,
          })),
          topSimilarity: topRelevance,
          totalResults: searchResults.length,
        },
      )
    : [];

  // --- v3: Layer distribution ---
  const layerDist: Record<string, number> = {};
  if (sections.nodes) {
    for (const n of sections.nodes) {
      const pyramid = n.addr?.split(".")?.[0] || "unknown";
      layerDist[pyramid] = (layerDist[pyramid] || 0) + 1;
    }
  }

  // --- Section 15.1: confidence_grade ---
  // Guards and out_of_scope must override raw similarity scores
  // ONLY answer-capable nodes determine confidence. Reinforcement nodes
  // (WORLD, HEURISTIC) don't count — they can't answer questions alone.
  const hasG001 = guardResults.some((g: any) => g.id === "G-001");
  const answerOnlyResults = searchResults.filter(
    (r: any) => !TRUTH_PYRAMIDS.has(`${r.pyramid_id || ""}` as KnownPyramidId)
  );
  const topAnswerRelevance = answerOnlyResults.length > 0
    ? Math.max(...answerOnlyResults.map((r: any) => parseFloat(r.similarity) || 0))
    : 0;
  // Check if top displayed results are reinforcement-only (WD/HEURISTIC).
  // Even if an answer-capable node exists deeper in the list, agents see
  // the top 2-3 results first — if those are all WD stubs, cap at MEDIUM.
  const topDisplayed = searchResults.slice(0, 3);
  const topDisplayedAllReinforcement = topDisplayed.length > 0 && topDisplayed.every(
    (r: any) => TRUTH_PYRAMIDS.has(`${r.pyramid_id || ""}` as KnownPyramidId)
  );
  let confidence_grade: "HIGH" | "MEDIUM" | "LOW" | "OUTSIDE" =
    externalCoverageLow ? (topAnswerRelevance >= 0.50 ? "LOW" : "OUTSIDE")
    : hasG001 ? (topAnswerRelevance >= 0.50 ? "LOW" : "OUTSIDE")
    : answerOnlyResults.length === 0 ? "LOW"  // only reinforcement nodes found — no real answer
    : topAnswerRelevance >= 0.77 ? "HIGH"
    : topAnswerRelevance >= 0.65 ? "MEDIUM"
    : topAnswerRelevance >= 0.50 ? "LOW"
    : "OUTSIDE";
  // Downgrade if top displayed results are all reinforcement-only (WD/HEURISTIC)
  if (topDisplayedAllReinforcement && (confidence_grade === "HIGH" || confidence_grade === "MEDIUM")) {
    confidence_grade = "LOW";
  }

  // --- Section 15.2: coverage_honest (null when HIGH) ---
  const coverage_honest: string | null =
    confidence_grade === "HIGH" ? null
    : confidence_grade === "MEDIUM"
      ? `Partial coverage: top functional result is ${Math.round(topAnswerRelevance * 100)}% relevant. External sources recommended for specifics.`
    : confidence_grade === "LOW"
      ? `Weak coverage: best functional match is ${Math.round(topAnswerRelevance * 100)}% relevant. Likely outside my knowledge.`
      : "Outside my knowledge. Redirecting to external sources.";

  // --- Section 15.3: proven_paths (collaborative intelligence from agent journeys) ---
  let proven_paths: Array<{ endpoint: string; node_addr: string; label: string }> | null = null;
  if (req.q && addrs.length > 0) {
    try {
      const pathRows = await sql`
        SELECT DISTINCT ON (ape.addr_selected)
          ape.endpoint, ape.addr_selected AS node_addr, n.label
        FROM agent_path_events ape
        JOIN nodes n ON n.addr = ape.addr_selected
        WHERE ape.outcome IN ('actionable', 'useful')
          AND ape.addr_selected = ANY(${addrs})
          AND n.visibility <> 'deleted'
          AND ape.created_at > now() - interval '30 days'
        ORDER BY ape.addr_selected, ape.created_at DESC
        LIMIT 5`;
      if (pathRows.length > 0) {
        proven_paths = pathRows.map((r: any) => ({
          endpoint: r.endpoint,
          node_addr: r.node_addr,
          label: r.label,
        }));
      }
    } catch {
      // Non-fatal — skip if agent_path_events query fails
    }
  }

  // Inject corrections from unresolved edge_tensions
  if (sections.nodes && sections.nodes.length > 0) {
    try {
      const nodeAddrs = sections.nodes.map((n: any) => n.addr).filter(Boolean);
      if (nodeAddrs.length > 0) {
        const tensions = accessScope === "operator"
          ? await sql`
              SELECT et.id, et.from_addr, et.to_addr, et.tension_type, et.tension, et.synthesis, et.evidence
              FROM edge_tensions et
              JOIN nodes nf ON nf.addr = et.from_addr
              JOIN nodes nt ON nt.addr = et.to_addr
              WHERE (et.from_addr = ANY(${nodeAddrs}::text[]) OR et.to_addr = ANY(${nodeAddrs}::text[]))
                AND et.resolved_at IS NULL
                AND et.tension_type IN ('contradiction', 'constraint')
                AND nf.visibility <> 'deleted'
                AND nt.visibility <> 'deleted'
              ORDER BY et.tension DESC`
          : await sql`
              SELECT et.id, et.from_addr, et.to_addr, et.tension_type, et.tension, et.synthesis, et.evidence
              FROM edge_tensions et
              JOIN nodes nf ON nf.addr = et.from_addr
              JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
              JOIN nodes nt ON nt.addr = et.to_addr
              JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
              WHERE (et.from_addr = ANY(${nodeAddrs}::text[]) OR et.to_addr = ANY(${nodeAddrs}::text[]))
                AND et.resolved_at IS NULL
                AND et.tension_type IN ('contradiction', 'constraint')
                AND nf.space_id = ANY(${spaceIds}::text[])
                AND nt.space_id = ANY(${spaceIds}::text[])
                AND nf.visibility <> 'deleted'
                AND nt.visibility <> 'deleted'
                AND (
                  nf.space_id <> ${GLOBAL_SPACE_ID}
                  OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
                )
                AND (
                  nt.space_id <> ${GLOBAL_SPACE_ID}
                  OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
                )
              ORDER BY et.tension DESC`;

        if (tensions.length > 0) {
          const tensionMap = new Map<string, any[]>();
          const addrSet = new Set(nodeAddrs);
          for (const t of tensions) {
            for (const addr of [t.from_addr, t.to_addr]) {
              if (addrSet.has(addr)) {
                if (!tensionMap.has(addr)) tensionMap.set(addr, []);
                tensionMap.get(addr)!.push({
                  tension_id: t.id,
                  type: t.tension_type,
                  severity: t.tension,
                  warning: t.synthesis,
                  evidence: t.evidence,
                  resolved: false,
                });
              }
            }
          }
          for (const node of sections.nodes) {
            const corrections = tensionMap.get(node.addr);
            if (corrections) node.corrections = corrections;
          }
        }
      }
    } catch {
      // Non-fatal — skip if edge_tensions query fails
    }
  }

  // Compact mode: ~90% smaller response for token-constrained AI agents.
  // Strips full descriptions, removes ontology/bridges duplication, truncates to essentials.
  // Agents can follow up with /nodes/:addr for full detail on specific nodes.
  if (req.compact) {
    const compactNodes = (sections.nodes || []).map((n: any) => ({
      addr: n.addr,
      label: n.label,
      pyramid_id: n.pyramid_id || n.addr?.split(".")?.[0] || null,
      node_type: n.node_type || null,
      confidence: n.confidence,
      similarity: n.relevance,
      description: (n.description || "").slice(0, 200),
      quick_start: n.quick_start || null,
      ...(n.node_type === "memory" ? {
        memory_type: n.memory_type || null,
        space_id: n.space_id || null,
        visibility: n.visibility || null,
      } : {}),
      ...(n.failure_warnings ? { failure_warnings: n.failure_warnings } : {}),
    }));

    return {
      ok: true,
      query: req.q,
      ...(rewrite.rewritten ? { query_rewritten: rewrite.query, rewrite_note: "Problem-description query rewritten to noun-heavy form for better results" } : {}),
      node_count: searchResults.length,
      confidence_grade,
      ...(coverage_honest ? { coverage_honest } : {}),
      ...(low_relevance ? { low_relevance_warning: true } : {}),
      ...((externalCoverageLow || (confidence_grade === "LOW" && topAnswerRelevance < 0.65)) ? {
        out_of_scope: { recommended_next_step: "web_search" },
      } : {}),
      ...(regrounding.length > 0 ? { regrounding: regrounding.map((r: any) => ({
        addr: r.addr, label: r.label, heuristic: r.heuristic_text || r.heuristic || null,
      })) } : {}),
      ...(guardResults.length > 0 ? { warnings: guardResults } : {}),
      nodes: compactNodes,
      ms: Date.now() - startMs,
    };
  }

  return {
    ok: true,
    depth: req.depth,
    query: req.q,
    ...(rewrite.rewritten ? { query_rewritten: rewrite.query, rewrite_note: "Problem-description query rewritten to noun-heavy form for better results" } : {}),
    node_count: searchResults.length,
    ...(low_relevance ? { low_relevance_warning: true, note: `Top similarity ${topRelevance} is below 0.6 — results may not be relevant to your query` } : {}),
    ...(isRecallQuery && temporalMemories.length > 0 ? {
      recall_surfaced: true,
      ...(memorySummary ? {
        memory_summary: {
          recall_id: memorySummary.recall_id,
          ...(memorySummary.recall_telemetry_unavailable ? { recall_telemetry_unavailable: true } : {}),
          recall_confidence: memorySummary.confidence,
          fresh_research_needed: memorySummary.fresh_research_needed,
          ...(memorySummary.error_recovered ? {
            error_recovered: true,
            recovery_reason: memorySummary.recovery_reason || "compiler_error",
          } : {}),
        },
      } : {}),
    } : {}),
    ...((externalCoverageLow || (confidence_grade === "LOW" && topAnswerRelevance < 0.65 && !externalCoverageLow)) ? {
      out_of_scope: {
        query_mode: externalCoverageLow ? queryIntent.mode : "inferred_external",
        in_graph_coverage: "low",
        reason: externalCoverageLow
          ? "This looks like a live/external factual question not yet represented well enough inside Verity One."
          : "Low confidence with weak relevance — results are likely noise. Treat as out of scope.",
        recommended_next_step: "web_search",
        recommended_tools: ["web_search", "web_fetch", "external_api"],
      },
    } : {}),
    confidence_grade,
    ...(coverage_honest ? { coverage_honest } : {}),
    ...(proven_paths ? { proven_paths } : {}),
    ...(briefSummary ? { brief: briefSummary } : {}),
    ...(regrounding.length > 0 ? { regrounding } : {}),
    ...(applicable_schemas.length > 0 ? { applicable_schemas } : {}),
    ...(guardResults.length > 0 ? { warnings: guardResults } : {}),
    ...(req.debug ? {
      retrieval_debug: {
        ...summarizeRetrievalIntent(queryIntent),
        ...rankingDebugSummary,
        top_rejected_polluters: topRejectedPolluters,
        layer_distribution: layerDist,
      },
    } : {}),
    layer_distribution: layerDist,
    sections,
    ontology: sections.ontology || null,
    ms: Date.now() - startMs
  };
}

/** Context Collapse: select best substance variant based on query context.
 *  Observer effect: each collapse micro-boosts the selected variant's weight
 *  and micro-decays others. */
async function collapseSubstance(node: any, query: string, agent?: string | null) {
  // Only collapse if node has variants
  if (!node.addr) return;

  const [row] = await sql`SELECT substance_variants FROM nodes WHERE addr = ${node.addr} AND visibility <> 'deleted'`;
  const variants = row?.substance_variants;
  if (!Array.isArray(variants) || variants.length === 0) return;

  // Simple keyword overlap scoring (avoids embedding call per variant)
  const queryWords = new Set(query.toLowerCase().split(/\s+/));
  let bestIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < variants.length; i++) {
    const desc = (variants[i].description || "").toLowerCase();
    const words = desc.split(/\s+/);
    let overlap = 0;
    for (const w of words) {
      if (queryWords.has(w) && w.length > 3) overlap++;
    }
    const score = overlap * (variants[i].weight || 1.0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // Apply observer effect — micro-boost selected, micro-decay others
  if (bestScore > 0) {
    node.collapsed_variant = {
      index: bestIdx,
      description: variants[bestIdx].description,
      context: variants[bestIdx].context,
    };

    // Fire-and-forget: update weights and record collapse
    (async () => {
      try {
        for (let i = 0; i < variants.length; i++) {
          if (i === bestIdx) {
            variants[i].weight = Math.min(2.0, (variants[i].weight || 1.0) + 0.05);
          } else {
            variants[i].weight = Math.max(0.1, (variants[i].weight || 1.0) - 0.02);
          }
        }
        await sql`UPDATE nodes SET substance_variants = ${sql.json(variants)} WHERE addr = ${node.addr}`;

        const embHash = Buffer.from(query).toString("base64url").slice(0, 32);
        await sql`INSERT INTO collapse_events (node_addr, variant_index, query_embedding_hash, agent_id, context_summary)
          VALUES (${node.addr}, ${bestIdx}, ${embHash}, ${agent || null}, ${query.slice(0, 200)})`;
      } catch (_) { /* silent */ }
    })();
  }
}

/** Fire-and-forget agent identity tracking */
function extractRunId(agent: string): string | null {
  // Agents can embed run_id as "run-RUNID:agentid" prefix
  const match = agent.match(/^run-([^:]+):/);
  return match ? match[1] : null;
}

function logPathEvent(opts: {
  agent: string;
  endpoint: string;
  query?: string;
  addrs?: string[];
  topAddr?: string;
  latencyMs?: number;
  relevanceScore?: number;
  actionability?: string;
  confidence?: string;
  outcome?: string;
  alphaOmegaPresent?: boolean;
  alphaOmegaRank?: number | null;
}) {
  (async () => {
    try {
      const runId = extractRunId(opts.agent) || null;
      await sql`
        INSERT INTO agent_path_events
          (run_id, agent_id, endpoint, query, addr_selected, returned_addrs, latency_ms, relevance_score, actionability, confidence, outcome, alpha_omega_present, alpha_omega_rank)
        VALUES
          (${runId}, ${opts.agent}, ${opts.endpoint}, ${opts.query || null}, ${opts.topAddr || null},
           ${opts.addrs || []}, ${opts.latencyMs || null}, ${opts.relevanceScore || null},
           ${opts.actionability || null}, ${opts.confidence || null}, ${opts.outcome || "unknown"},
           ${opts.alphaOmegaPresent || false}, ${opts.alphaOmegaRank ?? null})`;
    } catch (_) { /* silent */ }
  })();
}

function trackAgent(tenantId: string, agent: string, query: string, nodes: any[], latencyMs?: number) {
  (async () => {
    try {
      await sql`SELECT touch_agent(${tenantId}, ${agent})`;

      const returnedAddrs = nodes.map((n: any) => n.addr);
      const domainHits: Record<string, number> = {};
      for (const n of nodes) {
        const domain = n.type || "general";
        domainHits[domain] = (domainHits[domain] || 0) + 1;
      }

      await sql`INSERT INTO agent_queries (tenant_id, agent_id, query, node_addrs_returned, domain_hits)
        VALUES (${tenantId}, ${agent}, ${query}, ${returnedAddrs}, ${sql.json(domainHits)})`;

      // Log returned addrs for feedback auto-close correlation
      await sql`INSERT INTO query_log (query, results_returned, top_addr, top_similarity, agent_id, returned_addrs)
        VALUES (${query}, ${returnedAddrs.length}, ${returnedAddrs[0] || null}, ${1.0}, ${agent}, ${sql.json(returnedAddrs)})`;

      await sql`SELECT update_domain_affinity(${tenantId}, ${agent}, ${sql.json(domainHits)})`;
      // MT14: update_top_nodes removed — top_nodes had no functional consumer and was
      // the only carrier of tenant-private node addrs at rest in agent_profiles.
    } catch (_) { /* silent — never block the response */ }
  })();
}

export { context };
