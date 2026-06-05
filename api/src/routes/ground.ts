import { Hono } from "hono";
import { NON_ACTIONABLE_PYRAMIDS, type KnownPyramidId } from "@verity-one/graph-shape";
import { errorJson } from "../lib/error-envelope";
import { sql } from "../db";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, resolveAgentTenant } from "../lib/access";
import { classifyNodeExecution, isBroadControlNode, isGenericMetaNode, isGovernanceNode, isSecurityIncidentNode, isSessionArtifactRow, queryHasGovernanceIntent, queryHasMetaIntent, queryHasSecurityIntent, scoreGroundActionCandidate, shouldAllowBroadControlNode } from "../lib/agentic-routing";
import { distillAgentTaskPrompt } from "../lib/agent-task-prompt";
import { deriveNodeGuidance, type NodeGuidance } from "../lib/node-guidance";
import { formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { ontologyGuidanceFor } from "../lib/ontology-guidance";
import { findBoundedReasoningPath } from "../lib/path-reasoning";
import { filterReadableNodes } from "../lib/public-graph";
import { recordGroundingGapSignals } from "../lib/grounding-gaps";
import { buildRetrievalPatterns, detectRetrievalIntent, rerankRetrievalRows } from "../lib/retrieval-intent";
import { checkGuardsSync } from "../lib/guards";
import { compileRecall } from "../lib/recall-compiler";
import { toActionPacket, type ActionPacket } from "../lib/action-packet";
import type { ResolvedFederatedMemoryMetadata } from "../lib/federated-memory";

function logGroundPathEvent(agent: string, goal: string, packet: any, latencyMs: number) {
  if (!agent) return;
  (async () => {
    try {
      const runId = agent.match(/^run-([^:]+):/)?.[1] || null;
      const topFunc = packet.functional_path?.[0]?.addr || null;
      const coverage = packet.in_graph_coverage;
      const outcome = coverage === "none" ? "out_of_coverage" : coverage === "low" ? "redirect" : topFunc ? "useful" : "dead_end";
      await sql`
        INSERT INTO agent_path_events
          (run_id, agent_id, endpoint, query, addr_selected, returned_addrs, latency_ms, confidence, actionability, outcome)
        VALUES
          (${runId}, ${agent}, ${"/ground"}, ${goal}, ${topFunc},
           ${(packet.functional_path || []).slice(0,5).map((n: any) => n.addr)},
           ${latencyMs}, ${packet.confidence?.level || null},
           ${packet.in_graph_coverage === "low" ? "dead_end" : "drilldown"}, ${outcome})`;
    } catch (_) {}
  })();
}
import { selectRelevantSkills } from "../lib/skill-retrieval";
import { parseJsonField, roundFloat } from "../lib/utils";
import { embedQuery, toVectorStr } from "../lib/embed";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { suggestDurableOntologyTarget } from "../lib/ontology";

const ground = new Hono();

type GroundFormat = "compact" | "full" | "tiny";

type GroundRow = {
  addr: string;
  pyramid_id: string;
  label: string;
  node_type?: string | null;
  confidence?: number | string | null;
  visibility?: string | null;
  space_id?: string | null;
  parent_addr?: string | null;
  source_context?: unknown;
  source_refs?: unknown;
  description?: string | null;
  quick_start?: unknown;
  runbook?: unknown;
  provides?: unknown;
  requires?: unknown;
  access_level?: string | null;
  similarity?: number | string | null;
};

type EnrichedGroundRow = GroundRow & { guidance: NodeGuidance };

const GENERIC_WORLD_BRANCHES = [
  "recovery & optimization",
  "governance & power",
  "policy, public systems & collective risk",
  "daos & collective coordination",
  "human-computer interaction",
  "ai architectures & reasoning",
  "data, knowledge & information systems",
  "machine learning & statistical models",
  "distributed ledgers & smart contracts",
];

const GENERIC_FUNCTION_BRANCHES = [
  "functional knowledge",
  "performance & efficiency",
  "autonomous knowledge loop",
  "graph maintenance",
  "priority displacement",
  "queue & steering",
  "trend detection",
];

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

function actionableNode(row: GroundRow): boolean {
  const nodeType = `${row.node_type || ""}`.toLowerCase();
  if (row.pyramid_id === "FUNCTION") return true;
  return ["tool", "skill", "workflow", "procedure", "protocol"].includes(nodeType);
}

function truthRank(posture: NodeGuidance["truth_posture"]): number {
  switch (posture) {
    case "grounded": return 5;
    case "partially_grounded": return 4;
    case "tenant_local": return 3;
    case "provisional": return 2;
    default: return 1;
  }
}

function quickStartPreview(raw: unknown): string | null {
  const parsed = parseJsonField<any>(raw);
  if (!parsed) return null;
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) return parsed.find((item) => typeof item === "string") || null;
  if (typeof parsed === "object") {
    for (const value of Object.values(parsed)) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function compactReason(row: EnrichedGroundRow): string {
  if (row.guidance.truth_posture === "grounded") return "Strong truth anchor.";
  if (row.guidance.truth_posture === "partially_grounded") return "Useful grounding with explicit evidence, but still constrained.";
  if (row.guidance.truth_posture === "tenant_local") return "Private operational memory; useful if it matches the current tenant context.";
  if (row.guidance.truth_posture === "provisional") return "Promising working hypothesis, not final truth.";
  return "Heuristic lead; use to continue search, not to anchor certainty.";
}

function lexicalOverlap(goal: string, row: GroundRow): number {
  const terms = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
  if (terms.length === 0) return 0;
  const haystack = `${row.label || ""} ${row.description || ""}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

function isGenericWorldBranch(row: GroundRow): boolean {
  if (row.pyramid_id !== "WORLD") return false;
  const label = `${row.label || ""}`.toLowerCase();
  return GENERIC_WORLD_BRANCHES.some((term) => label.includes(term));
}

function isGenericFunctionBranch(row: GroundRow): boolean {
  if (row.pyramid_id !== "FUNCTION") return false;
  const label = `${row.label || ""}`.toLowerCase();
  return GENERIC_FUNCTION_BRANCHES.some((term) => label.includes(term));
}

type ConfidenceLevel = "high" | "medium" | "low";

interface ThreePartConfidence {
  /** Did we land in the right memory neighborhood? */
  cluster: ConfidenceLevel;
  /** Does VO have meaningful prior memory advantage here? */
  memory_value: ConfidenceLevel;
  /** Is there enough in-cluster guidance for a concrete next step? */
  actionability: ConfidenceLevel;
  /** Legacy composite for backward compatibility */
  level: ConfidenceLevel;
  summary: string;
}

function packetConfidence(
  truths: EnrichedGroundRow[],
  functionalPath: EnrichedGroundRow[],
  reasoningPathFound: boolean,
  memoryContext: { recall_confidence?: { relevance?: string } } | null,
  topSimilarity: number,
  bestFuncOverlap: number,
): ThreePartConfidence {
  const groundedTruths = truths.filter((row) => row.guidance.truth_posture === "grounded").length;
  const constrainedTruths = truths.filter((row) => ["grounded", "partially_grounded"].includes(row.guidance.truth_posture)).length;
  const tenantMemories = truths.filter((row) => row.guidance.truth_posture === "tenant_local").length;
  const hasFunctional = functionalPath.length >= 1;
  const hasExecutable = functionalPath.some((row) => {
    const exec = classifyNodeExecution(row);
    return exec.kind === "executable";
  });

  // Cluster confidence: based on top semantic similarity + truth grounding + lexical overlap
  // High embedding similarity with zero lexical overlap = false positive, not real cluster match
  const cluster: ConfidenceLevel =
    topSimilarity >= 0.72 && constrainedTruths >= 1 ? "high" :
    topSimilarity >= 0.60 && bestFuncOverlap > 0.1 ? "medium" :
    topSimilarity >= 0.60 && bestFuncOverlap === 0 ? "low" :  // false positive: high sim, zero term overlap
    topSimilarity >= 0.60 ? "medium" : "low";

  // Memory value: does VO have special prior memory advantage?
  const memory_value: ConfidenceLevel =
    tenantMemories > 0 || (memoryContext && (memoryContext.recall_confidence?.relevance === "high" || memoryContext.recall_confidence?.relevance === "medium")) ? "high" :
    groundedTruths >= 2 || constrainedTruths >= 2 ? "medium" : "low";

  // Actionability: can we give a concrete next step?
  const actionability: ConfidenceLevel =
    hasExecutable && hasFunctional && reasoningPathFound ? "high" :
    hasFunctional ? "medium" : "low";

  // Legacy composite
  const level: ConfidenceLevel =
    cluster === "high" && actionability !== "low" ? "high" :
    cluster !== "low" && hasFunctional ? "medium" : "low";

  const parts = [
    `cluster=${cluster}`,
    `memory_value=${memory_value}`,
    `actionability=${actionability}`,
  ];
  const summary =
    level === "high" ? `Strong grounding and execution path. ${parts.join(", ")}.` :
    level === "medium" ? `Partial grounding, act carefully. ${parts.join(", ")}.` :
    `Weak grounding — verify before acting. ${parts.join(", ")}.`;

  return { cluster, memory_value, actionability, level, summary };
}

function scoreReasoningPath(
  truth: EnrichedGroundRow,
  func: EnrichedGroundRow,
  path: Awaited<ReturnType<typeof findBoundedReasoningPath>>,
): number {
  if (!path) return -Infinity;
  const avgEdgeConfidence = path.edges.length > 0
    ? path.edges.reduce((sum, edge) => sum + Number(edge.confidence || 0), 0) / path.edges.length
    : 0;
  const truthScore = truthRank(truth.guidance.truth_posture);
  const funcScore = Number(func.confidence || 0);
  const hopPenalty = Math.max(0, path.hops - 1) * 0.35;
  return (truthScore * 0.8) + funcScore + avgEdgeConfidence - hopPenalty;
}

ground.get("/", async (c) => {
  const goal = (c.req.query("goal") || c.req.query("task") || "").trim();
  const format = ((c.req.query("format") || "compact").trim().toLowerCase()) as GroundFormat;
  const agent = (c.req.query("agent") || "").trim();
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];

  if (!goal) {
    return errorJson(c, "invalid_request", {
      message: "goal parameter required",
      details: { example: "/ground?goal=design+dao+governance+workflow" },
    });
  }
  if (goal.length > 2000) {
    return errorJson(c, "invalid_request", { message: "goal too long (max 2000 chars)" });
  }
  if (!["compact", "full", "tiny"].includes(format)) {
    return errorJson(c, "invalid_request", { message: "format must be compact, full, or tiny" });
  }
  if (agent && !assertAgentSelfOrOperator(c, agent)) {
    return errorJson(c, "forbidden");
  }

  try {

  const startedAt = Date.now();
  const goalPrompt = distillAgentTaskPrompt(goal);
  const retrievalGoal = goalPrompt.retrievalQuery;
  const queryIntent = detectRetrievalIntent(retrievalGoal);
  const queryPatterns = buildRetrievalPatterns(retrievalGoal);
  const worldSuggestion = queryIntent.worldBias
    ? suggestDurableOntologyTarget({
        content: retrievalGoal,
        nodeType: "concept",
        actionability: 1,
        includeLocalPyramids: false,
      })
    : null;
  const functionSuggestion = queryIntent.actionBias
    ? suggestDurableOntologyTarget({
        content: retrievalGoal,
        nodeType: "workflow",
        actionability: 5,
        includeLocalPyramids: false,
      })
    : null;
  const finalCount = format === "compact" ? 8 : 12;
  const fetchLimit = finalCount * 4;
  let explicitWorldSeed: GroundRow | null = null;
  const explicitFunctionBridgeAddrs = new Set<string>();

  const embedding = await embedQuery(retrievalGoal);
  const vectorStr = toVectorStr(embedding);
  await sql.unsafe("SET LOCAL hnsw.ef_search = 200");

  let candidates = await sql`
    SELECT
      n.addr,
      n.pyramid_id,
      n.label,
      n.node_type,
      n.confidence,
      n.visibility,
      n.space_id,
      n.parent_addr,
      n.source_context,
      n.source_refs,
      r.access_level,
      n.substance->>'description' AS description,
      n.substance->'quick_start' AS quick_start,
      n.substance->'runbook' AS runbook,
      n.substance->'provides' AS provides,
      n.substance->'requires' AS requires,
      1 - (n.embedding_hv <=> ${vectorStr}::halfvec) AS similarity
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.embedding_hv IS NOT NULL
      AND n.confidence > 0.45
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND n.space_id = ANY(${spaceIds}::text[])
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
            )`}
    ORDER BY n.embedding_hv <=> ${vectorStr}::halfvec
    LIMIT ${fetchLimit}
  ` as GroundRow[];

  if (access.scope !== "operator") {
    candidates = filterReadableNodes(candidates, access);
  } else {
    candidates = candidates.slice();
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
      SELECT
        n.addr,
        n.pyramid_id,
        n.label,
        n.node_type,
        n.confidence,
        n.visibility,
        n.space_id,
        n.parent_addr,
        n.source_context,
        n.source_refs,
        r.access_level,
        n.substance->>'description' AS description,
        n.substance->'quick_start' AS quick_start,
        n.substance->'runbook' AS runbook,
        n.substance->'provides' AS provides,
        n.substance->'requires' AS requires,
        0.62::numeric AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = ${queryIntent.targetPyramidId}
          OR n.parent_addr = ${queryIntent.targetParentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND n.confidence > 0.4
        AND n.visibility <> 'deleted'
        AND (
          n.label ILIKE ANY(${queryPatterns}::text[])
          OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
        )
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.confidence DESC
      LIMIT ${Math.max(8, finalCount)}
    ` as GroundRow[];
    if (access.scope !== "operator") {
      supplemental = filterReadableNodes(supplemental, access);
    }
    candidates = dedupeByAddr([...candidates, ...supplemental]);
  }

  if (
    queryPatterns.length > 0
    && worldSuggestion?.pyramidId === "WORLD"
    && !queryIntent.explicitMeta
    && !queryIntent.explicitLocal
  ) {
    let worldSupplement = await sql`
      WITH aligned_nodes AS (
        SELECT e.from_addr AS node_addr
        FROM edges e
        WHERE COALESCE(e.source_context->>'alignment_version', '') <> ''
          AND e.to_addr = ${worldSuggestion.parentAddr || ""}
      )
      SELECT
        n.addr,
        n.pyramid_id,
        n.label,
        n.node_type,
        n.confidence,
        n.visibility,
        n.space_id,
        n.parent_addr,
        n.source_context,
        n.source_refs,
        r.access_level,
        n.substance->>'description' AS description,
        n.substance->'quick_start' AS quick_start,
        n.substance->'runbook' AS runbook,
        n.substance->'provides' AS provides,
        n.substance->'requires' AS requires,
        0.68::numeric AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = 'WORLD'
          OR n.parent_addr = ${worldSuggestion.parentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND n.confidence > 0.4
        AND n.visibility <> 'deleted'
        AND (
          n.label ILIKE ANY(${queryPatterns}::text[])
          OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
        )
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.confidence DESC
      LIMIT ${Math.max(8, finalCount)}
    ` as GroundRow[];
    if (access.scope !== "operator") {
      worldSupplement = filterReadableNodes(worldSupplement, access);
    }
    candidates = dedupeByAddr([...candidates, ...worldSupplement]);
  }

  if (
    queryPatterns.length > 0
    && functionSuggestion?.pyramidId === "FUNCTION"
    && !queryIntent.explicitMeta
    && !queryIntent.explicitLocal
  ) {
    let functionSupplement = await sql`
      WITH aligned_nodes AS (
        SELECT e.from_addr AS node_addr
        FROM edges e
        WHERE COALESCE(e.source_context->>'alignment_version', '') <> ''
          AND e.to_addr = ${functionSuggestion.parentAddr || ""}
      )
      SELECT
        n.addr,
        n.pyramid_id,
        n.label,
        n.node_type,
        n.confidence,
        n.visibility,
        n.space_id,
        n.parent_addr,
        n.source_context,
        n.source_refs,
        r.access_level,
        n.substance->>'description' AS description,
        n.substance->'quick_start' AS quick_start,
        n.substance->'runbook' AS runbook,
        n.substance->'provides' AS provides,
        n.substance->'requires' AS requires,
        0.67::numeric AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = 'FUNCTION'
          OR n.parent_addr = ${functionSuggestion.parentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND n.confidence > 0.4
        AND n.visibility <> 'deleted'
        AND (
          n.label ILIKE ANY(${queryPatterns}::text[])
          OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
        )
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.confidence DESC
      LIMIT ${Math.max(8, finalCount)}
    ` as GroundRow[];
    if (access.scope !== "operator") {
      functionSupplement = filterReadableNodes(functionSupplement, access);
    }
    candidates = dedupeByAddr([...candidates, ...functionSupplement]);
  }

  if (worldSuggestion?.parentAddr) {
    let ontologyWorldSeed = await sql`
      SELECT
        n.addr,
        n.pyramid_id,
        n.label,
        n.node_type,
        n.confidence,
        n.visibility,
        n.space_id,
        n.parent_addr,
        n.source_context,
        n.source_refs,
        r.access_level,
        n.substance->>'description' AS description,
        n.substance->'quick_start' AS quick_start,
        n.substance->'runbook' AS runbook,
        n.substance->'provides' AS provides,
        n.substance->'requires' AS requires,
        0.74::numeric AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.addr = ${worldSuggestion.parentAddr}
        AND n.visibility <> 'deleted'
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      LIMIT 1
    ` as GroundRow[];
    if (access.scope !== "operator") {
      ontologyWorldSeed = filterReadableNodes(ontologyWorldSeed, access);
    }
    explicitWorldSeed = ontologyWorldSeed[0] || null;

    let ontologyFunctionBridges = await sql`
      SELECT DISTINCT
        n.addr,
        n.pyramid_id,
        n.label,
        n.node_type,
        n.confidence,
        n.visibility,
        n.space_id,
        n.parent_addr,
        n.source_context,
        n.source_refs,
        r.access_level,
        n.substance->>'description' AS description,
        n.substance->'quick_start' AS quick_start,
        n.substance->'runbook' AS runbook,
        n.substance->'provides' AS provides,
        n.substance->'requires' AS requires,
        0.72::numeric AS similarity
      FROM edges e
      JOIN nodes n
        ON (
          (e.from_addr = ${worldSuggestion.parentAddr} AND n.addr = e.to_addr)
          OR
          (e.to_addr = ${worldSuggestion.parentAddr} AND n.addr = e.from_addr)
        )
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.pyramid_id = 'FUNCTION'
        AND n.visibility NOT IN ('dormant', 'deleted')
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.confidence DESC
      LIMIT 6
    ` as GroundRow[];
    if (access.scope !== "operator") {
      ontologyFunctionBridges = filterReadableNodes(ontologyFunctionBridges, access);
    }
    for (const row of ontologyFunctionBridges) {
      explicitFunctionBridgeAddrs.add(row.addr);
    }

    candidates = dedupeByAddr([...ontologyWorldSeed, ...ontologyFunctionBridges, ...candidates]);
  }

  const rerankedCandidates = rerankRetrievalRows(retrievalGoal, candidates);
  candidates = rerankedCandidates.slice(0, finalCount);
  const rejectedCandidates = rerankedCandidates.slice(finalCount, finalCount + 3);
  const topSimilarity = Number(candidates[0]?.similarity || 0);
  const retrievalMissWarning = topSimilarity > 0 && topSimilarity < 0.62
    ? `Top retrieval similarity ${topSimilarity.toFixed(3)} is weak for this goal; grounding may be semantically drifted.`
    : null;

  // Semantic similarity fallback: reclassify as external_world if graph has no strong match
  const SEMANTIC_EXTERNAL_THRESHOLD = 0.65;
  if (
    queryIntent.mode !== "internal_system"
    && queryIntent.mode !== "external_world"
    && !queryIntent.explicitMeta
    && !queryIntent.explicitLocal
    && topSimilarity < SEMANTIC_EXTERNAL_THRESHOLD
    && topSimilarity > 0
  ) {
    queryIntent.mode = "external_world" as any;
    queryIntent.externalReality = true;
  }

  const hitAddrs = candidates.map((row) => row.addr);
  if (hitAddrs.length > 0) {
    sql`SELECT increment_query_hits(${hitAddrs}::text[])`.catch(() => {});
  }
  if (agent) {
    sql`SELECT touch_agent(${resolveAgentTenant(c, agent)}, ${agent})`.catch(() => {});
  }

  const bridgeContext = await selectOntologyBridgeContext(hitAddrs, access, {
    anchorLimit: 4,
    bridgeLimit: 6,
    queryText: retrievalGoal,
  });
  const ontology = formatOntologyBridgePayload(bridgeContext);
  const skills = await selectRelevantSkills(retrievalGoal, {
    limit: format === "compact" ? 3 : 5,
    includeNeedsHuman: access.scope === "operator",
  });

  let enriched = candidates.map((row) => ({
    ...row,
    guidance: deriveNodeGuidance(row, ontology),
  }));

  if (queryIntent.mode === "external_world") {
    enriched = enriched.filter((row) => {
      const overlap = lexicalOverlap(retrievalGoal, row);
      if (isGenericWorldBranch(row) && overlap < 0.2) return false;
      if (isGenericFunctionBranch(row) && overlap < 0.2) return false;
      return true;
    });
  }

  const truths = enriched
    .filter((row) => !actionableNode(row) || row.pyramid_id === "WORLD")
    .sort((a, b) => {
      const truthDelta = truthRank(b.guidance.truth_posture) - truthRank(a.guidance.truth_posture);
      if (truthDelta !== 0) return truthDelta;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    })
    .slice(0, format === "compact" ? 4 : 6);

  // WORLD/HEURISTIC/TRUTH/TN nodes are truth sources, not action targets.
  // Exclude them from functional candidates so agents never get routed
  // to philosophical concepts or trend nodes as their "next action."
  // NON_ACTIONABLE_PYRAMIDS is canonical in @verity-one/graph-shape.
  const scoredFunctionalCandidates = enriched
    .filter((row) => {
      if (NON_ACTIONABLE_PYRAMIDS.has(row.pyramid_id as KnownPyramidId)) return false;
      const execution = classifyNodeExecution(row);
      return actionableNode(row) || row.pyramid_id === "FUNCTION" || execution.kind !== "none";
    })
    .map((row) => ({
      row,
      execution: classifyNodeExecution(row),
      score: scoreGroundActionCandidate(retrievalGoal, row, queryIntent),
    }))
    .filter(({ row, execution, score }) => {
      if (explicitFunctionBridgeAddrs.has(row.addr)) return true;
      if (execution.kind === "executable") return true;
      if (score >= 0.2 && !isSessionArtifactRow(row)) return true;
      return false;
    })
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.08) return b.score - a.score;
      const aExactish = (a.row.label || "").toLowerCase().includes("cron") && retrievalGoal.toLowerCase().includes("cron") ? 1 : 0;
      const bExactish = (b.row.label || "").toLowerCase().includes("cron") && retrievalGoal.toLowerCase().includes("cron") ? 1 : 0;
      if (queryIntent.mode === "internal_system" && aExactish !== bExactish) return bExactish - aExactish;
      if (Math.abs(Number(a.row.similarity || 0) - Number(b.row.similarity || 0)) > 0.03) {
        return Number(b.row.similarity || 0) - Number(a.row.similarity || 0);
      }
      return Number(b.row.confidence || 0) - Number(a.row.confidence || 0);
    });

  const functionalPath = dedupeByAddr([
    ...scoredFunctionalCandidates.filter(({ row }) => explicitFunctionBridgeAddrs.has(row.addr)).map(({ row }) => row),
    ...scoredFunctionalCandidates
      // Filter out TEMPORAL day nodes — they are never a valid functional path target
      .filter(({ row }) => `${row.pyramid_id || ""}` !== "TEMPORAL")
      .map(({ row }) => row),
  ]).slice(0, format === "compact" ? 3 : 5);
  // Actionability-aware candidate selection: prefer executable over reference,
  // and skip generic/governance nodes for non-matching queries.
  const nextActionCandidate = (() => {
    const qualifying = scoredFunctionalCandidates.filter(({ row, execution, score }) => {
      if (isSessionArtifactRow(row)) return false;
      if (isBroadControlNode(row) && !shouldAllowBroadControlNode(retrievalGoal, row, queryIntent)) return false;
      if (isGenericMetaNode(row) && !queryHasMetaIntent(retrievalGoal)) return false;
      if (isGovernanceNode(row) && !queryHasGovernanceIntent(retrievalGoal)) return false;
      if (isSecurityIncidentNode(row) && !queryHasSecurityIntent(retrievalGoal)) return false;
      // Zero-overlap nodes should not qualify as action candidates, even if executable.
      // An executable node about "Discord Voice" is wrong for a "CodeQL" query.
      const rowOverlap = lexicalOverlap(retrievalGoal, row as any);
      return (score >= 0.75 && rowOverlap > 0) || (execution.kind === "executable" && rowOverlap > 0.1);
    });
    // Prefer the first executable candidate; fall back to the first non-reference
    const executable = qualifying.find(({ execution }) => execution.kind === "executable");
    if (executable) return executable.row;
    const nonReference = qualifying.find(({ execution }) => execution.kind !== "reference");
    if (nonReference) return nonReference.row;
    return qualifying[0]?.row || null;
  })();

  let reasoningPath = null;
  let bestReasoningScore = -Infinity;
  for (const truth of truths.slice(0, 3)) {
    for (const func of functionalPath.slice(0, 3)) {
      if (truth.addr === func.addr) continue;
      const candidatePath = await findBoundedReasoningPath(truth.addr, func.addr, access, accessLevels, {
        maxHops: 3,
        minConfidence: 0.55,
      });
      const candidateScore = scoreReasoningPath(truth, func, candidatePath);
      if (candidateScore > bestReasoningScore) {
        bestReasoningScore = candidateScore;
        reasoningPath = candidatePath;
      }
    }
  }

  const candidateTruthEntries = truths.map((row) => ({
        grounding_kind: "node" as const,
        addr: row.addr,
        label: row.label,
        pyramid_id: row.pyramid_id,
        confidence: roundFloat(row.confidence),
        description: row.description || null,
        truth_posture: row.guidance.truth_posture,
        truth_reason: row.guidance.truth_reason,
        why_this_matters: compactReason(row),
      }));

  const truthEntries = dedupeByAddr([
    ...(explicitWorldSeed ? [{
      grounding_kind: "ontology_anchor" as const,
      addr: explicitWorldSeed.addr,
      label: explicitWorldSeed.label,
      pyramid_id: explicitWorldSeed.pyramid_id,
      confidence: null,
      description: explicitWorldSeed.description || null,
      truth_posture: "partially_grounded" as const,
      truth_reason: "This is the strongest world branch matched directly from the goal. Use it as directional grounding rather than as a settled fact claim.",
      why_this_matters: "This ontology branch is the clearest world-model home for the task as phrased.",
    }] : []),
    ...candidateTruthEntries,
    ...ontology.cross_domain
      .filter((row) => row.pyramid_id === "WORLD" && row.addr !== explicitWorldSeed?.addr)
      .map((row) => ({
        grounding_kind: "ontology_anchor" as const,
        addr: row.addr,
        label: row.label,
        pyramid_id: row.pyramid_id,
        confidence: null,
        description: row.description || null,
        truth_posture: "partially_grounded" as const,
        truth_reason: "No strong world node surfaced directly, so this ontology branch is being used as directional grounding rather than as a settled fact claim.",
        why_this_matters: row.why_it_matters || "This is the strongest world branch currently connected to the goal.",
      })),
  ]).slice(0, format === "compact" ? 4 : 6);

  const constraints = Array.from(new Set([
    ...truths
      .filter((row) => ["provisional", "heuristic"].includes(row.guidance.truth_posture))
      .slice(0, 2)
      .map((row) => row.guidance.truth_reason),
    ...ontology.anchors
      .slice(0, 2)
      .flatMap((anchor) => ontologyGuidanceFor(anchor.addr)?.hallucination_guard || [])
      .slice(0, 4),
    ...(truths.length === 0
      ? ["No node-level world grounding surfaced. Treat the current world anchors as directional guidance until a more factual node appears."]
      : []),
  ])).slice(0, format === "compact" ? 4 : 6);

  const verification = Array.from(new Set([
    ...functionalPath
      .slice(0, 2)
      .map((row) => `Check /run/${row.addr} before acting to confirm prerequisites and readiness.`),
    ...(skills.length > 0 ? ["Use reviewed skills as execution guidance, but verify they fit the current world constraints."] : []),
  ])).slice(0, format === "compact" ? 3 : 5);

  // For external_world mode: count only real node-level truths, not ontology anchors (which always appear)
  const realTruths = truths.filter((row) => row.guidance.truth_posture === "grounded" || row.guidance.truth_posture === "partially_grounded");
  const realNodeTruths = enriched.filter((row) => Number(row.similarity ?? 0) >= 0.65);
  const externalCoverageLow = queryIntent.mode === "external_world" && realNodeTruths.length <= 1;

  const unknowns = Array.from(new Set([
    ...(functionalPath.length === 0 ? ["No strong functional path surfaced yet; more graph traversal may be required before acting."] : []),
    ...(truths.every((row) => !["grounded", "partially_grounded"].includes(row.guidance.truth_posture))
      ? ["The current truth anchors are not strongly corroborated yet."]
      : []),
    ...(externalCoverageLow ? ["This appears to be a live or external factual query with low in-graph coverage."] : []),
  ])).slice(0, format === "compact" ? 3 : 5);

  const nextAction = externalCoverageLow
    ? {
        kind: "external_lookup" as const,
        tool: "web_search" as const,
        reason: "Verity One coverage is too weak for a trustworthy in-graph answer. Use external sources before returning to the graph.",
      }
    : nextActionCandidate
    ? {
        kind: "run" as const,
        addr: nextActionCandidate.addr,
        label: nextActionCandidate.label,
        run_url: `/run/${nextActionCandidate.addr}`,
        reason: classifyNodeExecution(nextActionCandidate).kind === "executable"
          ? "This is the strongest specific operational node with an immediate execution surface."
          : queryIntent.mode === "external_world"
            ? "This is the least-generic functional lead currently surfaced, but it may still require additional world verification."
            : "This is the strongest functional node currently surfaced for the goal.",
      }
    : skills[0]
      ? {
          kind: "skill" as const,
          id: skills[0].id,
          label: skills[0].content,
          skill_path: skills[0].skill_path,
          reason: "No stronger action node surfaced, so the best reviewed skill is the next narrow step.",
        }
      : truths[0]
        ? {
            kind: "inspect" as const,
            addr: truths[0].addr,
            label: truths[0].label,
            node_url: `/nodes/${truths[0].addr}`,
            reason: "Ground the claim first, then cross into FUNCTION only when the action path is clearer.",
          }
        : {
            kind: "search" as const,
            reason: "No adequate grounding surfaced; broaden the query slightly and retry.",
          };

  // Memory context: when tenant auth is available, fetch prior memories as
  // constraints — not as top-ranked action nodes.
  let memoryContext: {
    prior_memories: Array<{ addr: string; label: string; kind: string; assertion: string; relevance: number; federation?: ResolvedFederatedMemoryMetadata }>;
    recall_confidence: { relevance: string; freshness: string; provenance: string; conflict_free: string };
    fresh_research_needed: string | null;
    error_recovered?: boolean;
    recovery_reason?: string | null;
  } | null = null;
  // LW1: the operational action-packet (#63) derived from the caller's OWN
  // tenant-scoped recall. It re-shapes the same recall memory_context uses, and its
  // supporting_evidence ALSO surfaces the recall's supporting_memories (which
  // memory_context omits) — still strictly within the caller's tenant/overlay scope
  // (the same data /recall already returns to this caller), never cross-tenant. Set
  // only when recall surfaced a primary.
  let actionPacket: ActionPacket | null = null;

  const tenantSpaceId = spaceIds.find((s: string) => s.startsWith("tenant:")) || null;

  // Fetch memory context BEFORE computing confidence so it can inform memory_value
  if (access.tenantId && tenantSpaceId) {
    try {
      const recallResult = await compileRecall(sql, {
        query: retrievalGoal,
        tenantId: access.tenantId,
        spaceId: tenantSpaceId,
        agentId: access.agentId,
        limit: 5,
        timeoutMs: 3_000,
        embedding,
        suppressExposureEvent: true,
        suppressTelemetry: true,
      });
      if (recallResult.error_recovered) {
        console.warn("[ground/memory-context] recall degraded:", recallResult.recovery_reason);
      }
      if (recallResult.primary_memories.length > 0) {
        memoryContext = {
          prior_memories: recallResult.primary_memories.map((m) => ({
            addr: m.addr,
            label: m.label,
            kind: m.kind,
            assertion: m.assertion.slice(0, 300),
            relevance: m.relevance,
          })),
          recall_confidence: {
            relevance: recallResult.confidence.relevance,
            freshness: recallResult.confidence.freshness,
            provenance: recallResult.confidence.provenance,
            conflict_free: recallResult.confidence.conflict_free,
          },
          fresh_research_needed: recallResult.fresh_research_needed,
          ...(recallResult.error_recovered ? {
            error_recovered: true,
            recovery_reason: recallResult.recovery_reason,
          } : {}),
        };
        // MT2: stamp the packet with the authenticated tenant (the recall was compiled with
        // access.tenantId) so a forwarded/cached packet stays tenant-bound (tenant_scope.tenant_id).
        actionPacket = toActionPacket(recallResult, { tenantId: access.tenantId });
      }
    } catch (e: any) {
      console.error("[ground/memory-context] recall compiler error:", e?.message);
    }
  }

  // Pre-compute best overlap early — needed for confidence scoring and coverage calculations
  const bestFuncOverlap = functionalPath.length > 0
    ? Math.max(0, ...functionalPath.map((row) => lexicalOverlap(retrievalGoal, row as any)))
    : 0;

  const confidence = packetConfidence(truths, functionalPath, !!reasoningPath, memoryContext, topSimilarity, bestFuncOverlap);
  if (externalCoverageLow) {
    confidence.level = "low";
    confidence.summary = "External-world retrieval surfaced only weak or generic branches. Use external sources first; treat this packet as exploratory, not actionable.";
  }

  // Out-of-coverage override: if the top functional node shares zero terms with the goal,
  // the grounding is noise, not signal. Tell the agent plainly.
  if (confidence.level === "low" && functionalPath.length > 0) {
    const topOverlap = lexicalOverlap(retrievalGoal, functionalPath[0] as any);
    if (topOverlap === 0) {
      confidence.summary = "This topic is outside VO's current graph. The LLM's own training data is your best source. Do not act on the functional path below — it was the closest semantic neighbor, not a real match.";
    }
  }

  // bestFuncOverlap already computed above (before confidence)

  const packet = {
    goal_interpretation: {
      original: goal,
      retrieval_query: retrievalGoal,
      prompt_distillation: goalPrompt.changed
        ? {
            core_topic: goalPrompt.coreTopic,
            source_hint: goalPrompt.sourceHint,
            mode_hint: goalPrompt.modeHint,
          }
        : null,
      mode: ontology.intent.mode,
      retrieval_mode: queryIntent.mode,
      focus: ontology.intent.focus,
      reductive_rule: ontology.intent.reductive_rule,
      target_pyramid: queryIntent.targetPyramidId,
      target_branch: queryIntent.targetParentAddr,
      branch_choice_reason: explicitWorldSeed
        ? `Matched strongest world branch directly: ${explicitWorldSeed.label}`
        : ontology.next_steps?.[0]?.reason || "Selected from reranked graph candidates and ontology bridges.",
      retrieval_miss_warning: retrievalMissWarning,
      rejected_candidates: rejectedCandidates.map((row) => ({
        addr: row.addr,
        label: row.label,
        pyramid_id: row.pyramid_id,
        similarity: roundFloat(row.similarity),
      })),
    },
    truths: truthEntries,
    functional_path: functionalPath.map((row) => ({
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      confidence: roundFloat(row.confidence),
      description: row.description || null,
      quick_start: quickStartPreview(row.quick_start),
      runbook: quickStartPreview(row.runbook),
      run_url: `/run/${row.addr}`,
    })),
    reasoning_path: reasoningPath ? {
      from: reasoningPath.from,
      to: reasoningPath.to,
      hops: reasoningPath.hops,
      summary: reasoningPath.summary,
      nodes: reasoningPath.nodes.map((node) => ({
        addr: node.addr,
        label: node.label,
        pyramid_id: node.pyramid_id,
        hop: node.hop,
      })),
      edges: reasoningPath.edges.map((edge) => ({
        from: edge.from_addr,
        to: edge.to_addr,
        type: edge.edge_type,
        role: edge.role,
        label: edge.label,
        confidence: roundFloat(edge.confidence),
      })),
      semantics: reasoningPath.semantics,
    } : null,
    skills: skills.map((skill) => ({
      id: skill.id,
      content: skill.content,
      status: skill.status,
      skill_path: skill.skill_path,
      source_url: skill.source_url,
    })),
    constraints,
    verification,
    unknowns,
    in_graph_coverage: (() => {
      if (externalCoverageLow) return "low";
      if (functionalPath.length === 0 && truths.length === 0) return "none";
      if (bestFuncOverlap < 0.3 && confidence.level === "low") return "none";
      if (bestFuncOverlap < 0.3 && functionalPath.length > 0) return "low";
      return truths.length >= 2 || functionalPath.length >= 2 ? "medium" : "partial";
    })(),
    // eval_hint: tells agents what kind of result this is (action / recall / abstain)
    eval_hint: (() => {
      const coverage = externalCoverageLow ? "low"
        : (functionalPath.length === 0 && truths.length === 0) ? "none"
        : (bestFuncOverlap < 0.3 && confidence.level === "low") ? "none"
        : (bestFuncOverlap < 0.3) ? "low"
        : "medium";
      if (coverage === "none" || (coverage === "low" && bestFuncOverlap < 0.3)) return "abstain";
      if (queryIntent.recall || queryIntent.temporal) return "recall";
      if (nextActionCandidate) {
        const exec = classifyNodeExecution(nextActionCandidate);
        if (exec.kind === "executable") return "action";
      }
      if (functionalPath.length > 0 && bestFuncOverlap >= 0.3) return "action";
      return "recall";
    })(),
    next_action: nextAction,
    confidence,
    ...(memoryContext ? { memory_context: memoryContext } : {}),
  };
  const gapSignals = await recordGroundingGapSignals(sql, {
    goal,
    access,
    agentId: agent || access.agentId || null,
    intent: queryIntent,
    intentMode: ontology.intent.mode,
    truths: packet.truths,
    functionalPath: packet.functional_path,
    skills: packet.skills,
    confidence: { level: packet.confidence.level, note: packet.confidence.summary },
    ontology,
  });

  const markdownLines = [
    `## Grounding Packet: ${goal}`,
    "",
    `Mode: ${packet.goal_interpretation.mode}`,
    `Focus: ${packet.goal_interpretation.focus}`,
    `Rule: ${packet.goal_interpretation.reductive_rule}`,
    "",
    "### Truth Anchors",
    ...packet.truths.slice(0, 4).map((row) =>
      `- **${row.label}** [${row.addr}] (${row.truth_posture}${typeof row.confidence === "number" ? `, conf=${row.confidence.toFixed(2)}` : ""}): ${row.description || row.truth_reason}`
    ),
    "",
    "### Functional Path",
    ...packet.functional_path.slice(0, 3).map((row) =>
      `- **${row.label}** [${row.addr}]${row.quick_start ? ` | quick_start: ${row.quick_start}` : ` | run: /run/${row.addr}`}`
    ),
  ];
  if (packet.reasoning_path) {
    markdownLines.push("", "### Reasoning Path");
    markdownLines.push(`- ${packet.reasoning_path.summary}`);
  }
  if (packet.skills.length > 0) {
    markdownLines.push("", "### Reviewed Skills");
    markdownLines.push(...packet.skills.slice(0, 3).map((skill) =>
      `- **${skill.content}** (${skill.status})${skill.skill_path ? ` | path: ${skill.skill_path}` : ""}`
    ));
  }
  if (packet.constraints.length > 0) {
    markdownLines.push("", "### Constraints");
    markdownLines.push(...packet.constraints.map((item) => `- ${item}`));
  }
  markdownLines.push("", "### Next Action");
  markdownLines.push(`- ${packet.next_action.reason}`);

  const totalMs = Date.now() - startedAt;
  if (agent) logGroundPathEvent(agent, goal, packet, totalMs);

  // --- v3: Applicable schema ---
  const schemaResults = await sql`
    SELECT n.addr, n.label, n.substance->>'schema_purpose' AS purpose,
      n.substance->>'when_active' AS when_active,
      1 - (n.embedding_hv <=> ${vectorStr}::halfvec) AS similarity
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.node_type = 'schema' AND n.embedding_hv IS NOT NULL
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND n.space_id = ANY(${spaceIds}::text[])
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
            )`}
    ORDER BY n.embedding_hv <=> ${vectorStr}::halfvec
    LIMIT 1`;
  const applicable_schema = schemaResults.length > 0 && parseFloat(schemaResults[0].similarity) > 0.45
    ? {
        addr: schemaResults[0].addr,
        label: schemaResults[0].label,
        purpose: schemaResults[0].purpose,
        when_active: schemaResults[0].when_active,
      }
    : null;

  // --- v3: Guards ---
  const guardWarnings = checkGuardsSync({
    nodes: enriched.map((n) => ({
      addr: n.addr,
      similarity: Number(n.similarity ?? 0),
      confidence: Number(n.confidence ?? 0),
    })),
    topSimilarity: topSimilarity,
    totalResults: enriched.length,
  });

  // --- Section 15.3: proven_paths (collaborative intelligence from agent journeys) ---
  let proven_paths: Array<{ endpoint: string; node_addr: string; label: string }> | null = null;
  if (hitAddrs.length > 0) {
    try {
      const pathRows = await sql`
        SELECT DISTINCT ON (ape.addr_selected)
          ape.endpoint, ape.addr_selected AS node_addr, n.label
        FROM agent_path_events ape
        JOIN nodes n ON n.addr = ape.addr_selected
        WHERE ape.outcome IN ('actionable', 'useful')
          AND ape.addr_selected = ANY(${hitAddrs})
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
      // Non-fatal
    }
  }

  // Determine packet mode
  // Research handoff: when VO genuinely has no special value (low confidence + out-of-coverage + abstain hint)
  const isResearchHandoff =
    (confidence.memory_value === "low" && confidence.cluster === "low") ||
    (externalCoverageLow && confidence.memory_value === "low") ||
    (confidence.level === "low" && bestFuncOverlap < 0.2 && confidence.memory_value !== "high");
  const packetMode: "action" | "recall" | "research_handoff" | "governance" =
    isResearchHandoff ? "research_handoff" :
    (queryIntent.recall || queryIntent.temporal) ? "recall" :
    queryIntent.governanceBias ? "governance" :
    "action";

  // --- format=tiny: ~200-300 token response ---
  if (format === "tiny") {
    const totalMs = Date.now() - startedAt;
    if (agent) logGroundPathEvent(agent, goal, packet, totalMs);

    if (packetMode === "research_handoff") {
      return c.json({
        ok: true,
        format: "tiny",
        goal,
        mode: "research_handoff",
        likely_domain: goalPrompt.coreTopic || retrievalGoal,
        best_prior_memory: memoryContext?.prior_memories?.[0] ? {
          addr: memoryContext.prior_memories[0].addr,
          label: memoryContext.prior_memories[0].label,
          assertion: memoryContext.prior_memories[0].assertion?.slice(0, 200),
        } : null,
        what_to_verify: "Use external sources — VO coverage is too weak for this topic.",
        narrow_next_move: packet.next_action?.reason || "Broaden the query or use web search.",
        confidence,
        eval_hint: packet.eval_hint,
        ms: totalMs,
      });
    }

    const primaryNode = functionalPath[0] || truths[0];
    const backupNode = functionalPath[1] || truths[1] || null;
    const topConstraint = packet.constraints?.[0] || null;

    return c.json({
      ok: true,
      format: "tiny",
      goal,
      mode: packetMode,
      primary: primaryNode ? {
        addr: primaryNode.addr,
        label: primaryNode.label,
        quick_start: quickStartPreview(primaryNode.quick_start),
        run_url: `/run/${primaryNode.addr}`,
      } : null,
      backup: backupNode ? {
        addr: backupNode.addr,
        label: backupNode.label,
        run_url: `/run/${backupNode.addr}`,
      } : null,
      constraint: topConstraint,
      confidence,
      memory_posture: memoryContext
        ? {
            status: memoryContext.prior_memories.length > 0 ? "memory_backed" : "research_needed",
            note: `VO has ${memoryContext.prior_memories.length} prior memor${memoryContext.prior_memories.length === 1 ? "y" : "ies"}. ${memoryContext.fresh_research_needed || "No fresh research needed."}`,
            provenance: memoryContext.prior_memories[0]?.federation?.authority || "tenant_local",
          }
        : confidence.memory_value === "low"
          ? { status: "research_needed", note: "No special prior memory. Consider external sources.", provenance: null }
          : null,
      eval_hint: packet.eval_hint,
      ms: totalMs,
    });
  }

  return c.json({
    ok: true,
    goal,
    mode: packetMode,
    packet,
    ...(actionPacket ? { action_packet: actionPacket } : {}),
    ...(applicable_schema ? { applicable_schema } : {}),
    ...(guardWarnings.length > 0 ? { warnings: guardWarnings } : {}),
    ...(proven_paths ? { proven_paths } : {}),
    ontology,
    bridge_steps: ontology.next_steps,
    gap_signals: gapSignals.map((signal) => ({
      gap_key: signal.gapKey,
      gap_type: signal.gapType,
      severity: signal.severity,
    })),
    candidates_considered: enriched.length,
    markdown: markdownLines.join("\n"),
    ms: totalMs,
  });

  } catch (err: any) {
    console.error("[ground] Internal error:", err?.message || err);
    return errorJson(c, "service_unavailable", {
      message: "Service temporarily unavailable",
      details: { retry_after_ms: 2000 },
    });
  }
});

export default ground;
