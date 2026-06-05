/**
 * InsightForge — Multi-dimensional retrieval endpoint
 * 
 * Instead of single-vector search, this:
 * 1. Takes a question
 * 2. Generates sub-questions (different angles of the same query)
 * 3. Runs parallel semantic searches for each
 * 4. Deduplicates and ranks by frequency + similarity
 * 5. Synthesizes a grounded answer with node citations
 * 
 * Inspired by MiroFish's InsightForge pattern.
 * This is how the pyramid becomes a thinking instrument, not just storage.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { embedQuery, toVectorStr } from "../lib/embed";
import {
  allowedRegistryAccessLevels,
  assertAgentSelfOrOperator,
  getAccessContext,
  type AccessContext,
} from "../lib/access";
import { filterReadableNodes } from "../lib/public-graph";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { InsightRequestSchema } from "../schemas/insight.schema";
import { callOptionalMinerFlash } from "../lib/miner-llm-bridge";

const insight = new Hono();

async function callInsightLLM(
  prompt: string,
  options: { systemPrompt?: string; jsonMode?: boolean } = {},
): Promise<string | null> {
  return callOptionalMinerFlash(prompt, {
    systemPrompt: options.systemPrompt,
    jsonMode: options.jsonMode,
    temperature: 0.3,
    maxTokens: 2048,
    timeoutMs: 15_000,
  });
}

async function semanticSearch(
  query: string,
  limit: number = 7,
  access: AccessContext = { scope: "anonymous", token: null, agentId: null, tenantId: null, spaceIds: [GLOBAL_SPACE_ID] },
  accessLevels: string[] = ["public"],
): Promise<any[]> {
  try {
    const embedding = await embedQuery(query);
    const vectorStr = toVectorStr(embedding);
    const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
    let results = await sql`
      SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.label, n.confidence, n.visibility,
             n.node_type, n.source_context, n.space_id, r.access_level,
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
      LIMIT ${Math.min(limit * 4, 60)}
    ` as any[];
    if (access.scope !== "operator") {
      results = filterReadableNodes(results, access).slice(0, limit);
    } else {
      results = results.slice(0, limit);
    }
    return results;
  } catch {
    return [];
  }
}

interface InsightNode {
  addr: string;
  pyramid_id: string;
  layer: number;
  depth: number;
  label: string;
  confidence: number;
  description: string;
  similarity: number;
  hit_count: number;  // how many sub-questions found this node
  sub_queries: string[];  // which sub-questions found it
}

// POST /insight { question: "...", depth?: "fast"|"quick"|"deep" }
async function handleInsight(c: any, question: string, depth: "fast" | "quick" | "deep" = "quick", agent: string | null = null) {

  const startTime = Date.now();
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);

  // FAST MODE: no LLM calls, just ranked semantic search + node metadata
  // Target: <200ms instead of 6-7s
  if (depth === "fast") {
    const results = await semanticSearch(question, 10, access, accessLevels);
    const rankedAddrs = results.map((r: any) => r.addr);
    const provenanceRows = rankedAddrs.length > 0
      ? await sql`
          SELECT addr, source_refs, provenance->>'basis' AS basis
          FROM nodes
          WHERE addr = ANY(${rankedAddrs})
            AND visibility <> 'deleted'
        `
      : [];
    const provMap = new Map(provenanceRows.map((r: any) => [r.addr, r]));

    const nodes = results.map((r: any) => {
      const prov = provMap.get(r.addr);
      const refs = prov?.source_refs;
      const hasRefs = Array.isArray(refs) && refs.length > 0;
      const basis = prov?.basis || "unknown";
      return {
        addr: r.addr,
        pyramid_id: r.pyramid_id,
        label: r.label,
        confidence: r.confidence,
        description: r.description,
        similarity: parseFloat(r.similarity),
        provenance_basis: basis,
        has_source_refs: hasRefs,
        citation_quality: hasRefs ? "grounded" : (basis === "observed" || basis === "consensus") ? "basis-only" : "ungrounded",
      };
    });

    const groundedNodes = nodes.filter(n => n.citation_quality !== "ungrounded");
    const grounded_facts = groundedNodes.slice(0, 5).map(n =>
      `[${n.addr}] ${n.label}: ${n.description?.slice(0, 200) || "No description."}`
    );

    const elapsed = Date.now() - startTime;

    sql`INSERT INTO query_log (query, results_returned, top_addr, top_similarity, agent_id)
        VALUES (${"[insight:fast] " + question}, ${nodes.length}, ${nodes[0]?.addr || null}, ${nodes[0]?.similarity || null}, ${agent})
    `.catch(() => {});

    return c.json({
      question,
      answer: null,
      grounded_facts,
      inferred_synthesis: null,
      confidence_note: groundedNodes.length >= 3
        ? "Fast mode: grounded node summaries only (no LLM synthesis). Use depth=quick or depth=deep for synthesized answers."
        : "Fast mode: sparse grounding. Consider depth=deep for better coverage.",
      open_questions: [],
      next_queries: [],
      evidence_summary: {
        grounded_nodes: groundedNodes.length,
        ungrounded_nodes: nodes.length - groundedNodes.length,
      },
      tensions: [],
      sub_questions: [question],
      nodes,
      edges: [],
      meta: {
        total_unique_nodes: nodes.length,
        returned: nodes.length,
        sub_question_count: 1,
        depth: "fast",
        elapsed_ms: elapsed,
      },
    });
  }

  const subQuestionCount = depth === "deep" ? 5 : 3;

  // Step 1: Generate sub-questions
  const subQPrompt = `Given this question about a knowledge system:

"${question}"

Generate exactly ${subQuestionCount} different sub-questions that explore different angles of this question. Each should target a different facet — structural, relational, historical, operational, or conceptual.

  Return ONLY a JSON array of strings, nothing else:
["sub-question 1", "sub-question 2", "sub-question 3"${subQuestionCount > 3 ? ', "sub-question 4", "sub-question 5"' : ''}]`;

  let subQuestions: string[] = [question]; // fallback: just use original
  const rawSQ = await callInsightLLM(subQPrompt, { jsonMode: true });
  if (rawSQ) {
    try {
      const parsed = JSON.parse(rawSQ.replace(/```json\n?|\n?```/g, "").trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        subQuestions = [question, ...parsed]; // original + decomposed
      }
    } catch {
      // fallback to original question only
    }
  }

  // Step 2: Parallel semantic search for each sub-question
  const allResults = await Promise.all(
    subQuestions.map(async (sq) => {
      const results = await semanticSearch(sq, 7, access, accessLevels);
      return { query: sq, results };
    })
  );

  // Step 3: Deduplicate and rank by cross-query frequency
  const nodeMap = new Map<string, InsightNode>();
  
  for (const { query: sq, results } of allResults) {
    for (const r of results) {
      const existing = nodeMap.get(r.addr);
      if (existing) {
        existing.hit_count++;
        existing.sub_queries.push(sq);
        existing.similarity = Math.max(existing.similarity, parseFloat(r.similarity));
      } else {
        nodeMap.set(r.addr, {
          addr: r.addr,
          pyramid_id: r.pyramid_id,
          layer: r.layer,
          depth: r.depth,
          label: r.label,
          confidence: r.confidence,
          description: r.description,
          similarity: parseFloat(r.similarity),
          hit_count: 1,
          sub_queries: [sq],
        });
      }
    }
  }

  // Rank: nodes found by multiple sub-questions are most relevant
  // Score = hit_count * 0.6 + max_similarity * 0.3 + confidence * 0.1
  const rankedNodesRaw = [...nodeMap.values()]
    .map((n) => ({
      ...n,
      relevance_score: parseFloat(
        (n.hit_count * 0.6 + n.similarity * 0.3 + n.confidence * 0.1).toFixed(4)
      ),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 15);

  // Enrich with provenance quality — agents need to know if citations are grounded
  const rankedAddrs = rankedNodesRaw.map(n => n.addr);
  const provenanceRows = rankedAddrs.length > 0
    ? await sql`
        SELECT addr, source_refs, provenance->>'basis' AS basis,
          provenance->>'source' AS prov_source
        FROM nodes
        WHERE addr = ANY(${rankedAddrs})
          AND visibility <> 'deleted'
      `
    : [];
  const provMap = new Map(provenanceRows.map((r: any) => [r.addr, r]));

  const rankedNodes = rankedNodesRaw.map(n => {
    const prov = provMap.get(n.addr);
    const refs = prov?.source_refs;
    const hasRefs = Array.isArray(refs) && refs.length > 0 && !(refs.length === 0);
    const basis = prov?.basis || "unknown";
    return {
      ...n,
      provenance_basis: basis,
      has_source_refs: hasRefs,
      citation_quality: hasRefs ? "grounded" : (basis === "observed" || basis === "consensus") ? "basis-only" : "ungrounded",
    };
  });

  // Step 4: Get edges between the top nodes for relational context
  const topAddrs = rankedNodes.slice(0, 10).map((n) => n.addr);
  const edges = topAddrs.length > 0
    ? await sql`
        SELECT from_addr, to_addr, edge_type, label, confidence
        FROM edges
        WHERE from_addr = ANY(${topAddrs}) AND to_addr = ANY(${topAddrs})
        ORDER BY confidence DESC
        LIMIT 20
      `
    : [];

  // Step 5: Synthesize answer
  let synthesis: string | null = null;
  if (rankedNodes.length > 0) {
    const contextBlock = rankedNodes
      .slice(0, 10)
      .map((n) => `[${n.addr}] ${n.label} (conf=${n.confidence}, hits=${n.hit_count}, evidence=${n.citation_quality}): ${n.description?.slice(0, 300)}`)
      .join("\n\n");

    const edgeBlock = edges.length > 0
      ? "\n\nRelationships between these nodes:\n" +
        edges.map((e: any) => `${e.from_addr} —[${e.edge_type}]→ ${e.to_addr}: ${e.label?.slice(0, 100)}`).join("\n")
      : "";

    const synthPrompt = `You are answering a question using a knowledge pyramid (Verity One).
Ground your answer ONLY in the provided nodes. Cite node addresses like [META.0.2.4].
Be direct and specific.
IMPORTANT: Nodes marked evidence=ungrounded have no source_refs backing them. If you cite such nodes, qualify the citation (e.g., "[ADDR] (unverified)" or note in open_questions that the claim lacks evidence).

QUESTION: ${question}

RELEVANT NODES:
${contextBlock}
${edgeBlock}

Respond in this exact JSON format (no markdown, no code fences):
{
  "grounded_facts": ["Short factual bullets with [ADDR] citations only when directly supported"],
  "inferred_synthesis": "A cautious 1-2 paragraph synthesis that clearly separates inference from direct support",
  "answer": "A concise answer grounded in the facts above with [ADDR] citations where supported",
  "open_questions": ["What the graph doesn't answer", "Gaps you noticed"],
  "next_queries": ["Suggested follow-up queries for deeper understanding"],
  "confidence_note": "Brief note about evidence strength"
}

If the nodes don't fully answer the question, list the gaps in open_questions.
Do not fabricate specifics that are absent from the provided nodes.
Suggest 2-3 follow-up queries the agent should run next.`;

    synthesis = await callInsightLLM(synthPrompt, {
      systemPrompt: "You are a knowledge synthesis engine for Verity One, a multi-pyramid truth map. Your answers must be grounded in the provided node data. Never fabricate information not present in the nodes.",
      jsonMode: true,
    });
  }

  // Parse structured synthesis
  let answer: string | null = null;
  let grounded_facts: string[] = [];
  let inferred_synthesis: string | null = null;
  let confidence_note: string | null = null;
  let open_questions: string[] = [];
  let next_queries: string[] = [];

  if (synthesis) {
    try {
      const cleaned = synthesis.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      answer = parsed.answer || synthesis;
      grounded_facts = Array.isArray(parsed.grounded_facts) ? parsed.grounded_facts : [];
      inferred_synthesis = parsed.inferred_synthesis || null;
      confidence_note = parsed.confidence_note || null;
      open_questions = parsed.open_questions || [];
      next_queries = parsed.next_queries || [];
    } catch {
      // Gemini didn't return valid JSON — use raw synthesis
      answer = synthesis;
    }
  }

  if (grounded_facts.length === 0) {
    grounded_facts = rankedNodes
      .filter((node) => node.citation_quality !== "ungrounded")
      .slice(0, 4)
      .map((node) => `[${node.addr}] ${node.label}: ${node.description?.slice(0, 180) || "No description available."}`);
  }

  if (!inferred_synthesis && answer) {
    inferred_synthesis = answer;
  }

  if (!confidence_note) {
    const groundedCount = rankedNodes.filter((node) => node.citation_quality !== "ungrounded").length;
    confidence_note = groundedCount >= 4
      ? "Moderate evidence support from grounded nodes."
      : "Thin evidence support; treat synthesis as provisional.";
  }

  const elapsed = Date.now() - startTime;

  // Log the insight query
  sql`INSERT INTO query_log (query, results_returned, top_addr, top_similarity, agent_id)
      VALUES (${"[insight] " + question}, ${rankedNodes.length}, ${rankedNodes[0]?.addr || null}, ${rankedNodes[0]?.similarity || null}, ${agent})
  `.catch(() => {});

  // Find contradictions among top nodes
  const contradictionAddrs = topAddrs;
  const tensions = contradictionAddrs.length > 1
    ? await sql`
        SELECT e.from_addr, e.to_addr, e.label
        FROM edges e
        WHERE e.edge_type = 'conflicts_with'
          AND e.from_addr = ANY(${contradictionAddrs})
          AND e.to_addr = ANY(${contradictionAddrs})
        LIMIT 5`
    : [];

  return c.json({
    question,
    answer,
    grounded_facts,
    inferred_synthesis,
    confidence_note,
    open_questions,
    next_queries,
    evidence_summary: {
      grounded_nodes: rankedNodes.filter((node) => node.citation_quality !== "ungrounded").length,
      ungrounded_nodes: rankedNodes.filter((node) => node.citation_quality === "ungrounded").length,
    },
    tensions: tensions.map((t: any) => ({ from: t.from_addr, to: t.to_addr, reason: t.label })),
    sub_questions: subQuestions,
    nodes: rankedNodes,
    edges,
    meta: {
      total_unique_nodes: nodeMap.size,
      returned: rankedNodes.length,
      sub_question_count: subQuestions.length,
      depth,
      elapsed_ms: elapsed,
    },
  });
}

insight.post("/", async (c) => {
  const body = await validateRequest(c, InsightRequestSchema);
  const question = body.question || body.q;
  if (!question) return errorJson(c, "invalid_request", { message: "question parameter required" });
  if (question.length > 2000) return errorJson(c, "invalid_request", { message: "question too long (max 2000 chars)" });
  const depth = (body.depth || "quick") as "fast" | "quick" | "deep";
  const agent = body.agent || null;
  if (agent && !assertAgentSelfOrOperator(c, agent)) {
    return errorJson(c, "forbidden", { message: "Forbidden" });
  }
  return handleInsight(c, question, depth, agent);
});

insight.get("/", async (c) => {
  const question = c.req.query("q");
  if (!question) return errorJson(c, "invalid_request", { message: "q parameter required" });
  if (question.length > 2000) return errorJson(c, "invalid_request", { message: "q too long (max 2000 chars)" });
  const depth = (c.req.query("depth") || "quick") as "fast" | "quick" | "deep";
  return handleInsight(c, question, depth);
});

export default insight;
