import { Hono } from "hono";
import { errorJson } from "../lib/error-envelope";
import { sql } from "../db";
import { isSessionArtifactRow } from "../lib/agentic-routing";
import { distillAgentTaskPrompt } from "../lib/agent-task-prompt";
import { embedQuery, toVectorStr, EMBED_MODEL } from "../lib/embed";
import { deriveNodeGuidance } from "../lib/node-guidance";
import { allowedRegistryAccessLevels, getAccessContext, visibleSpaceIds } from "../lib/access";
import { formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { filterReadableNodes } from "../lib/public-graph";
import { buildRetrievalPatterns, detectRetrievalIntent, rerankRetrievalRows } from "../lib/retrieval-intent";
import { selectRelevantSkills } from "../lib/skill-retrieval";
import { clampInt, parseJsonField } from "../lib/utils";
import { withResolvedKinds, type SourceRef } from "../lib/source-refs";

/** Stamp the closed source-ref kind (plan Q1=A) on a row's raw source_refs so
 *  search results carry vault_file/url/doc discriminators. Returns undefined
 *  when there are none, so the field is omitted rather than emitted empty. */
function stampSearchSourceRefs(raw: unknown): SourceRef[] | undefined {
  const refs = parseJsonField<SourceRef[]>(raw);
  if (!Array.isArray(refs) || refs.length === 0) return undefined;
  return withResolvedKinds(refs);
}
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const search = new Hono();

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

// GET /search?q=concept&limit=10&mode=semantic|text|auto
search.get("/", async (c) => {
  const rawQuery = c.req.query("q");
  if (!rawQuery) return errorJson(c, "invalid_request", { message: "q parameter required" });
  const query = rawQuery.replace(/\0/g, "");
  if (!query) return errorJson(c, "invalid_request", { message: "q parameter required" });
  if (query.length > 2000) return errorJson(c, "invalid_request", { message: "q too long (max 2000 chars)" });

  try {
  const queryPrompt = distillAgentTaskPrompt(query);
  const retrievalQuery = queryPrompt.retrievalQuery;
  const limit = clampInt(c.req.query("limit"), 10, 1, 100);
  const mode = c.req.query("mode") || "auto";
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access);
  const fetchLimit = Math.min(limit * 4, 200);
  const queryAgent = c.req.query("agent") || null;
  if (access.agentId && queryAgent && queryAgent !== access.agentId) {
    return errorJson(c, "forbidden");
  }
  const trackedAgent = access.scope === "anonymous" ? null : (queryAgent || access.agentId || null);
  const queryIntent = detectRetrievalIntent(retrievalQuery);
  const queryPatterns = buildRetrievalPatterns(retrievalQuery);

  // Try semantic search first (if API key available)
  if (mode !== "text") {
    try {
      const embedding = await embedQuery(retrievalQuery);
      const vectorStr = toVectorStr(embedding);
      // Increase HNSW ef_search for better recall — the default (40) misses
      // nodes in sparse regions of the graph, especially recently-updated embeddings.
      await sql.unsafe("SET LOCAL hnsw.ef_search = 200");
      let results = await sql`
        SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.label, n.confidence, n.visibility,
               n.space_id, n.source_refs,
               r.access_level, n.node_type, n.parent_addr, n.source_context,
               n.substance->>'description' as description,
               round((1 - (n.embedding_hv <=> ${vectorStr}::halfvec))::numeric, 4) as similarity
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.embedding_hv IS NOT NULL
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
      ` as any[];
      if (access.scope !== "operator") {
        results = filterReadableNodes(results, access);
      } else {
        results = results.slice();
      }
      // Session demotion is handled by rerankRetrievalRows via agenticRoutingAdjustment.
      // No pre-sort needed here — the reranker handles all scoring.
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
          SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.label, n.confidence, n.visibility,
                 n.space_id, n.source_refs,
                 r.access_level, n.node_type, n.parent_addr, n.source_context,
                 n.substance->>'description' as description,
                 0.61::numeric AS similarity
          FROM nodes n
          JOIN registry r ON r.pyramid_id = n.pyramid_id
          WHERE (
              n.pyramid_id = ${queryIntent.targetPyramidId}
              OR n.parent_addr = ${queryIntent.targetParentAddr || ""}
              OR n.addr IN (SELECT node_addr FROM aligned_nodes)
            )
            AND (
              n.label ILIKE ANY(${queryPatterns}::text[])
              OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
            )
            AND n.visibility <> 'deleted'
            ${access.scope === "operator"
              ? sql``
              : sql`
                  AND n.space_id = ANY(${spaceIds}::text[])
                  AND (
                    n.space_id <> ${GLOBAL_SPACE_ID}
                    OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
                  )`}
          ORDER BY n.confidence DESC
          LIMIT ${Math.max(limit, 8)}
        ` as any[];
        if (access.scope !== "operator") {
          supplemental = filterReadableNodes(supplemental, access);
        }
        results = dedupeByAddr([...results, ...supplemental]);
      }
      results = rerankRetrievalRows(retrievalQuery, results).slice(0, limit);

      // Log query for usage tracking
      sql`INSERT INTO query_log (query, results_returned, top_addr, top_similarity, agent_id)
          VALUES (${query}, ${results.length}, ${results[0]?.addr || null}, ${results[0]?.similarity || null}, ${trackedAgent})
      `.catch(() => {});

      // Increment query hits on returned nodes
      const hitAddrs = results.map((r: any) => r.addr);
      if (hitAddrs.length > 0) {
        sql`SELECT increment_query_hits(${hitAddrs}::text[])`.catch(() => {});
      }
      const bridgeContext = await selectOntologyBridgeContext(hitAddrs, access, {
        anchorLimit: 4,
        bridgeLimit: 5,
        queryText: retrievalQuery,
      });
      const skills = await selectRelevantSkills(retrievalQuery, {
        limit: 3,
        includeNeedsHuman: access.scope === "operator",
      });

      const ontology = formatOntologyBridgePayload(bridgeContext);
      return c.json({
        query,
        retrieval_query: retrievalQuery,
        prompt_distillation: queryPrompt.changed
          ? {
              core_topic: queryPrompt.coreTopic,
              source_hint: queryPrompt.sourceHint,
              mode_hint: queryPrompt.modeHint,
            }
          : null,
        results: results.map((row: any) => ({
          ...row,
          source_refs: stampSearchSourceRefs(row.source_refs),
          guidance: deriveNodeGuidance(row, ontology),
        })),
        count: results.length,
        mode: "semantic",
        model: EMBED_MODEL,
        ontology,
        skills,
      });
    } catch {
      // Fall through to text search
    }
  }

  // Fallback: text search
  let results = await sql`
    SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.label, n.confidence, n.visibility,
           n.space_id, n.source_refs, r.access_level, n.node_type, n.parent_addr, n.source_context,
           n.substance->>'description' as description,
           CASE
             WHEN lower(n.label) = lower(${retrievalQuery}) THEN 4
             WHEN n.label ILIKE ${retrievalQuery + "%"} THEN 3
             WHEN n.label ILIKE ${"%" + retrievalQuery + "%"} THEN 2
             WHEN n.substance::text ILIKE ${"%" + retrievalQuery + "%"} THEN 1
             ELSE 0
           END AS text_rank
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE (
      n.label ILIKE ${"%" + retrievalQuery + "%"}
      OR n.substance::text ILIKE ${"%" + retrievalQuery + "%"}
    )
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND n.space_id = ANY(${spaceIds}::text[])
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
            )`}
    ORDER BY text_rank DESC, n.confidence DESC
    LIMIT ${fetchLimit}
  ` as any[];
  if (access.scope !== "operator") {
    results = filterReadableNodes(results, access);
  } else {
    results = results.slice();
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
      SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.label, n.confidence, n.visibility,
             n.space_id, n.source_refs, r.access_level, n.node_type, n.parent_addr, n.source_context,
             n.substance->>'description' as description,
             3 AS text_rank
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = ${queryIntent.targetPyramidId}
          OR n.parent_addr = ${queryIntent.targetParentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND (
          n.label ILIKE ANY(${queryPatterns}::text[])
          OR n.substance::text ILIKE ANY(${queryPatterns}::text[])
        )
        AND n.visibility <> 'deleted'
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.confidence DESC
      LIMIT ${Math.max(limit, 8)}
    ` as any[];
    if (access.scope !== "operator") {
      supplemental = filterReadableNodes(supplemental, access);
    }
    results = dedupeByAddr([...results, ...supplemental]);
  }
  results = rerankRetrievalRows(retrievalQuery, results).slice(0, limit);
  const bridgeContext = await selectOntologyBridgeContext(results.map((r: any) => r.addr), access, {
    anchorLimit: 4,
    bridgeLimit: 5,
    queryText: retrievalQuery,
  });
  const ontology = formatOntologyBridgePayload(bridgeContext);
  const skills = await selectRelevantSkills(retrievalQuery, {
    limit: 3,
    includeNeedsHuman: access.scope === "operator",
  });

  return c.json({
    query,
    retrieval_query: retrievalQuery,
    prompt_distillation: queryPrompt.changed
      ? {
          core_topic: queryPrompt.coreTopic,
          source_hint: queryPrompt.sourceHint,
          mode_hint: queryPrompt.modeHint,
        }
      : null,
    results: results.map((row: any) => ({
      ...row,
      source_refs: stampSearchSourceRefs(row.source_refs),
      guidance: deriveNodeGuidance(row, ontology),
    })),
    count: results.length,
    mode: "text",
    ontology,
    skills,
  });

  } catch (err: any) {
    console.error("[search] Internal error:", err?.message || err);
    return errorJson(c, "service_unavailable", {
      message: "Service temporarily unavailable",
      details: { retry_after_ms: 2000 },
    });
  }
});

export default search;
