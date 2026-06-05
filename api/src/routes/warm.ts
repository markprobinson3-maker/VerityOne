/**
 * /warm — Agent Warm-Start Context
 *
 * One call gives an agent pre-loaded context for a task.
 * Embeds task description, HNSW searches top nodes, filters by
 * confidence + agent domain affinity, formats as markdown or JSON.
 *
 * GET /warm?task=deploy+to+production&agent=claude-code&format=compact
 */

import { Hono } from "hono";
import { errorJson } from "../lib/error-envelope";
import { sql } from "../db";
import { embedQuery, toVectorStr } from "../lib/embed";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, resolveAgentTenant } from "../lib/access";
import { distillAgentTaskPrompt } from "../lib/agent-task-prompt";
import { formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { filterReadableNodes } from "../lib/public-graph";
import { buildRetrievalPatterns, detectRetrievalIntent, rerankRetrievalRows } from "../lib/retrieval-intent";
import { selectRelevantSkills } from "../lib/skill-retrieval";
import { roundFloat, parseJsonField } from "../lib/utils";
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const warm = new Hono();

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

type WarmFormat = "compact" | "full";

warm.get("/", async (c) => {
  const task = c.req.query("task") || "";
  const agent = c.req.query("agent") || "";
  const format = (c.req.query("format") || "compact") as WarmFormat;
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];

  if (!task) {
    return errorJson(c, "invalid_request", {
      message: "task parameter required",
      details: { example: "/warm?task=deploy+to+production&agent=my-agent" },
    });
  }
  if (!["compact", "full"].includes(format)) {
    return errorJson(c, "invalid_request", { message: "format must be compact or full" });
  }
  if (agent && !assertAgentSelfOrOperator(c, agent)) {
    return errorJson(c, "forbidden");
  }

  const startMs = Date.now();
  const taskPrompt = distillAgentTaskPrompt(task);
  const retrievalTask = taskPrompt.retrievalQuery;
  const queryIntent = detectRetrievalIntent(retrievalTask);
  const queryPatterns = buildRetrievalPatterns(retrievalTask);

  // 1. Embed task description (~100ms)
  const embedding = await embedQuery(retrievalTask);
  const vecStr = toVectorStr(embedding);

  // 2. HNSW cosine search top 8 (~5ms)
  const topK = format === "compact" ? 8 : 12;
  let candidates = await sql`
    SELECT n.addr, n.label, n.node_type, n.confidence, n.pyramid_id,
      n.visibility, n.source_context, n.parent_addr, r.access_level,
      n.substance->>'description' as description,
      n.substance->'quick_start' as quick_start,
      n.substance->'runbook' as runbook,
      n.substance->'provides' as provides,
      n.source_refs,
      1 - (n.embedding_hv <=> ${vecStr}::halfvec) as similarity
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.embedding_hv IS NOT NULL
      AND n.visibility <> 'deleted'
      AND n.confidence > 0.5
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND n.space_id = ANY(${spaceIds}::text[])
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
            )`}
    ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
    LIMIT ${topK * 3}` as any[];
  candidates = access.scope === "operator"
    ? candidates.slice()
    : filterReadableNodes(candidates, access);
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
      SELECT n.addr, n.label, n.node_type, n.confidence, n.pyramid_id,
        n.visibility, n.source_context, n.parent_addr, r.access_level,
        n.substance->>'description' as description,
        n.substance->'quick_start' as quick_start,
        n.substance->'runbook' as runbook,
        n.substance->'provides' as provides,
        n.source_refs,
        0.62::numeric as similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE (
          n.pyramid_id = ${queryIntent.targetPyramidId}
          OR n.parent_addr = ${queryIntent.targetParentAddr || ""}
          OR n.addr IN (SELECT node_addr FROM aligned_nodes)
        )
        AND n.visibility <> 'deleted'
        AND n.confidence > 0.45
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
      LIMIT ${Math.max(topK, 8)}
    ` as any[];
    if (access.scope !== "operator") supplemental = filterReadableNodes(supplemental, access);
    candidates = dedupeByAddr([...candidates, ...supplemental]);
  }

  // 3. Filter by agent domain affinity (if agent provided)
  if (agent) {
    const [profile] = await sql`
      SELECT domain_affinity FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, agent)} AND agent_id = ${agent}`;

    if (profile?.domain_affinity) {
      const affinity = typeof profile.domain_affinity === "string"
        ? JSON.parse(profile.domain_affinity)
        : profile.domain_affinity;

      // Boost nodes matching agent's domain affinity
      candidates = candidates.map((n: any) => {
        const domainBoost = affinity[n.node_type] ? 0.05 : 0;
        return { ...n, boosted_sim: parseFloat(n.similarity) + domainBoost };
      });
      candidates.sort((a: any, b: any) => (b.boosted_sim || b.similarity) - (a.boosted_sim || a.similarity));
    }
  }

  candidates = rerankRetrievalRows(retrievalTask, candidates);

  // Cap to final count
  const finalCount = format === "compact" ? 5 : 8;
  candidates = candidates.slice(0, finalCount);
  const skills = await selectRelevantSkills(retrievalTask, {
    limit: format === "compact" ? 2 : 3,
    includeNeedsHuman: access.scope === "operator",
  });

  // 4. Increment query_hits on returned nodes
  const addrs = candidates.map((n: any) => n.addr);
  if (addrs.length > 0) {
    sql`SELECT increment_query_hits(${addrs}::text[])`.catch(() => {});
  }
  const bridgeContext = await selectOntologyBridgeContext(addrs, access, {
    anchorLimit: 3,
    bridgeLimit: 4,
    queryText: retrievalTask,
  });

  // 5. Format as markdown context block
  const confidenceAvg = candidates.length > 0
    ? candidates.reduce((sum: number, n: any) => sum + parseFloat(n.confidence), 0) / candidates.length
    : 0;

  let contextBlock: string;

  if (format === "compact") {
    // ~500 tokens, designed for system prompt injection
    const lines = candidates.map((n: any) => {
      const qs = n.quick_start ? ` | quick_start: ${JSON.stringify(n.quick_start)}` : "";
      return `- **${n.label}** [${n.addr}] (${n.node_type}, conf=${parseFloat(n.confidence).toFixed(2)}): ${(n.description || "").slice(0, 120)}${qs}`;
    });
    const bridgeLines = bridgeContext.bridges.map((row) =>
      `- **${row.label}** [${row.addr}] via ${row.via_label} (${row.edge_type})`
    );
    contextBlock = `## Verity Context: ${task}\n\n${lines.join("\n")}`;
    if (skills.length > 0) {
      contextBlock += `\n\n### Reviewed Skills\n${skills.map((skill) =>
        `- **${skill.content}** (${skill.status})${skill.skill_path ? ` | path: ${skill.skill_path}` : ""}`
      ).join("\n")}`;
    }
    if (bridgeLines.length > 0) {
      contextBlock += `\n\n### Bridge Paths\n${bridgeLines.join("\n")}`;
    }
  } else {
    // ~2000 tokens, deep context
    const blocks = candidates.map((n: any) => {
      let block = `### ${n.label} [${n.addr}]\n`;
      block += `Type: ${n.node_type} | Confidence: ${parseFloat(n.confidence).toFixed(2)} | Pyramid: ${n.pyramid_id}\n\n`;
      block += `${n.description || "No description"}\n`;
      if (n.quick_start) block += `\n**Quick Start:** ${JSON.stringify(n.quick_start)}\n`;
      if (n.runbook) block += `\n**Runbook:** ${JSON.stringify(n.runbook)}\n`;
      if (n.provides) block += `\n**Provides:** ${JSON.stringify(n.provides)}\n`;
      if (n.source_refs) {
        const refs = parseJsonField(n.source_refs);
        if (Array.isArray(refs) && refs.length > 0) {
          block += `\n**Sources:** ${refs.length} linked source reference${refs.length > 1 ? "s" : ""}\n`;
        }
      }
      return block;
    });
    contextBlock = `## Verity Deep Context: ${task}\n\n${blocks.join("\n---\n\n")}`;
    if (skills.length > 0) {
      const skillBlocks = skills.map((skill) =>
        `- **${skill.content}** (${skill.status}${skill.skill_type ? `, ${skill.skill_type}` : ""})${skill.source_url ? ` — ${skill.source_url}` : ""}`
      );
      contextBlock += `\n\n## Reviewed Skills\n${skillBlocks.join("\n")}`;
    }
    if (bridgeContext.bridges.length > 0) {
      const bridgeBlocks = bridgeContext.bridges.map((row) =>
        `- **${row.label}** [${row.addr}] (${row.pyramid_id}) via **${row.via_label}** [${row.via_addr}] using \`${row.edge_type}\``
      );
      contextBlock += `\n\n## Cross-Domain Bridges\n${bridgeBlocks.join("\n")}`;
    }
  }

  // 6. Agent tracking (fire-and-forget)
  if (agent) {
    const agentTenant = resolveAgentTenant(c, agent);
    (async () => {
      try {
        await sql`SELECT touch_agent(${agentTenant}, ${agent})`;
      } catch (_) { /* silent */ }
    })();
  }

  const cacheKey = `warm_${Buffer.from(task).toString("base64url").slice(0, 32)}_${format}`;

  return c.json({
    ok: true,
    task_interpretation: {
      original: task,
      retrieval_query: retrievalTask,
      prompt_distillation: taskPrompt.changed
        ? {
            core_topic: taskPrompt.coreTopic,
            source_hint: taskPrompt.sourceHint,
            mode_hint: taskPrompt.modeHint,
          }
        : null,
    },
    context_block: contextBlock,
    node_count: candidates.length,
    confidence_avg: roundFloat(confidenceAvg),
    cache_key: cacheKey,
    ontology: formatOntologyBridgePayload(bridgeContext),
    source_refs: candidates.map((n: any) => ({
      addr: n.addr,
      label: n.label,
      similarity: roundFloat(n.similarity),
    })),
    skills,
    bridges: [
      ...bridgeContext.anchors.slice(0, 2).map((row) => ({
        kind: "anchor",
        seed_addr: row.seed_addr,
        via_addr: row.addr,
        via_label: row.label,
        addr: row.addr,
        label: row.label,
        pyramid_id: row.pyramid_id,
        relationship: row.edge_type,
      })),
      ...bridgeContext.bridges.map((row) => ({
        kind: "bridge",
        seed_addr: row.seed_addr,
        via_addr: row.via_addr,
        via_label: row.via_label,
        addr: row.addr,
        label: row.label,
        pyramid_id: row.pyramid_id,
        relationship: row.edge_type,
      })),
    ],
    ms: Date.now() - startMs,
  });
});

export default warm;
