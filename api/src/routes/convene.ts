/**
 * POST /swarm/convene — The living layer of Verity One
 * 
 * Takes a question, finds the most relevant nodes, generates
 * a persona for each, runs them in parallel debate, and extracts
 * structured artifacts (new edges, nodes, tensions) from the interaction.
 * 
 * Modes:
 *   debate:      agents argue their positions, moderator synthesizes
 *   consensus:   agents seek agreement, flag unresolvable gaps
 *   adversarial: one agent deliberately challenges all others
 * 
 * Cost: ~$0.02-0.05 per convene (Mercury agents + Gemini moderator)
 */

import { Hono } from "hono";
import { sql } from "../db";
import { embedQuery, toVectorStr } from "../lib/embed";
import { canonicalizeEdgeType } from "../lib/graph-shape";
import { resolveDurableOntologyTarget, withAllocatedChildSlot } from "../lib/ontology";
import { generatePersonas, type NodePersona } from "../lib/persona";
import { errorJson, ApiError } from "../lib/error-envelope";
import { readBoundedJsonBody } from "../lib/bounded-body";
import { auditMutation } from "../lib/audit";
import { callOptionalMinerFlash } from "../lib/miner-llm-bridge";

const swarm = new Hono();

const INCEPTION_API_KEY = process.env.OPENCLAW_INCEPTION_API_KEY;
const MERCURY_URL = "https://api.inceptionlabs.ai/v1/chat/completions";

type ConveneMode = "debate" | "consensus" | "adversarial";

function conveneAuditTenant(agent?: string): string {
  if (agent) {
    const mapped = (process.env.VERITY_AGENT_TENANTS || "")
      .split(",")
      .map((p) => p.trim().split(":"))
      .find(([aid]) => aid === agent)?.[1];
    if (mapped) return mapped;
  }
  return process.env.VERITY_DEFAULT_TENANT_ID || "system";
}

interface ConveneRequest {
  question: string;
  max_agents?: number;     // default 6
  mode?: ConveneMode;      // default "debate"
  rounds?: number;         // default 3
  addrs?: string[];        // optional: force specific node-agents
  agent?: string;          // requesting agent id
}

interface AgentTurn {
  addr: string;
  label: string;
  round: number;
  position: string;
  proposed_edges: ProposedEdge[];
  proposed_nodes: ProposedNode[];
  confidence_in_consensus: number;  // 0-1
}

interface ProposedEdge {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string;
}

interface ProposedNode {
  label: string;
  description: string;
  node_type: string;
  parent_addr?: string;
}

interface ConveneResult {
  question: string;
  mode: ConveneMode;
  agents: { addr: string; label: string; personality: string }[];
  rounds: AgentTurn[][];
  consensus: string | null;
  proposed_edges: ProposedEdge[];
  proposed_nodes: ProposedNode[];
  unresolved_tensions: string[];
  meta: {
    elapsed_ms: number;
    total_turns: number;
    rounds_run: number;
    agent_count: number;
  };
}

// --- LLM Calls ---

async function callMercury(messages: { role: string; content: string }[]): Promise<string> {
  if (!INCEPTION_API_KEY) throw new Error("OPENCLAW_INCEPTION_API_KEY not set");
  const res = await fetch(MERCURY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INCEPTION_API_KEY}` },
    body: JSON.stringify({ model: "mercury-coder-small", messages, max_tokens: 800, temperature: 0.7 }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mercury error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || "";
}

async function callModeratorLLM(
  prompt: string,
  options: { systemPrompt?: string; jsonMode?: boolean } = {},
): Promise<string> {
  return await callOptionalMinerFlash(prompt, {
    systemPrompt: options.systemPrompt,
    jsonMode: options.jsonMode,
    temperature: 0.3,
    maxTokens: 2048,
    timeoutMs: 20_000,
  }) ?? "";
}

// --- Node Selection ---

async function selectAgentNodes(question: string, maxAgents: number, forcedAddrs?: string[]): Promise<string[]> {
  if (forcedAddrs?.length) return forcedAddrs.slice(0, maxAgents);

  // Semantic search for most relevant nodes
  const embedding = await embedQuery(question);
  const vectorStr = toVectorStr(embedding);
  const results = await sql`
    SELECT addr, node_type,
      round((1 - (embedding_hv <=> ${vectorStr}::halfvec))::numeric, 4) as similarity
    FROM nodes
    WHERE embedding_hv IS NOT NULL
      AND visibility = 'public'
      AND node_type IN ('tool', 'skill', 'workflow', 'anti-pattern', 'concept')
    ORDER BY embedding_hv <=> ${vectorStr}::halfvec
    LIMIT ${maxAgents + 4}`;

  // Prefer diversity: don't pick 4 tools if there's a relevant anti-pattern
  const selected: string[] = [];
  const typeCount: Record<string, number> = {};

  for (const r of results) {
    const type = r.node_type || "concept";
    if ((typeCount[type] || 0) >= Math.ceil(maxAgents / 2)) continue;
    selected.push(r.addr);
    typeCount[type] = (typeCount[type] || 0) + 1;
    if (selected.length >= maxAgents) break;
  }

  return selected;
}

// --- Debate Engine ---

async function runDebateRound(
  question: string,
  personas: NodePersona[],
  round: number,
  history: AgentTurn[][],
  mode: ConveneMode
): Promise<AgentTurn[]> {
  const historyContext = history.length > 0
    ? "\n\nPREVIOUS ROUNDS:\n" + history.map((r, i) =>
        r.map(t => `[Round ${i + 1}] ${t.label}: ${t.position}`).join("\n")
      ).join("\n\n")
    : "";

  const modeInstruction = {
    debate: "Argue your position. If you disagree with another agent, say why. If you agree, build on their point.",
    consensus: "Seek common ground. Acknowledge where you agree. Clearly flag unresolvable disagreements.",
    adversarial: round === 1 ? "Take the OPPOSITE position to what you'd normally argue. Stress-test the group's assumptions." : "Now argue your genuine position after hearing the adversarial challenges.",
  }[mode];

  // Run all agents in parallel
  const turns = await Promise.all(personas.map(async (persona): Promise<AgentTurn> => {
    const messages = [
      { role: "system", content: persona.systemPrompt },
      {
        role: "user",
        content: `QUESTION: ${question}

${modeInstruction}

${historyContext}

Respond in this JSON format (no markdown fences):
{
  "position": "Your 2-4 sentence argument from your node's perspective",
  "proposed_edges": [{"from_addr": "ADDR", "to_addr": "ADDR", "edge_type": "requires|conflicts_with|uses|related_to", "label": "WHY this connection exists"}],
  "proposed_nodes": [{"label": "Name", "description": "What this node captures", "node_type": "tool|skill|concept|anti-pattern"}],
  "confidence_in_consensus": 0.0 to 1.0
}

If you have no edges or nodes to propose, use empty arrays. Be honest about your confidence.`
      }
    ];

    try {
      const raw = await callModeratorLLM(
        messages.map(m => `[${m.role}]: ${m.content}`).join("\n\n"),
        { systemPrompt: persona.systemPrompt, jsonMode: true },
      );
      const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        addr: persona.addr,
        label: persona.label,
        round,
        position: parsed.position || raw.slice(0, 500),
        proposed_edges: Array.isArray(parsed.proposed_edges) ? parsed.proposed_edges : [],
        proposed_nodes: Array.isArray(parsed.proposed_nodes) ? parsed.proposed_nodes : [],
        confidence_in_consensus: parseFloat(parsed.confidence_in_consensus) || 0.5,
      };
    } catch {
      // Agent failed to produce structured output — use raw text
      return {
        addr: persona.addr,
        label: persona.label,
        round,
        position: "(failed to produce structured response)",
        proposed_edges: [],
        proposed_nodes: [],
        confidence_in_consensus: 0.3,
      };
    }
  }));

  return turns;
}

// --- Moderator Synthesis ---

async function synthesize(
  question: string,
  allRounds: AgentTurn[][],
  mode: ConveneMode
): Promise<{ consensus: string; tensions: string[]; edges: ProposedEdge[]; nodes: ProposedNode[] }> {
  const transcript = allRounds.map((round, i) =>
    round.map(t => `[Round ${i + 1}] [${t.addr}] ${t.label}: ${t.position}`).join("\n")
  ).join("\n\n");

  // Collect all proposed edges and nodes
  const allEdges = allRounds.flat().flatMap(t => t.proposed_edges);
  const allNodes = allRounds.flat().flatMap(t => t.proposed_nodes);

  const synthPrompt = `You are the moderator of a node-agent debate in Verity One.

QUESTION: ${question}
MODE: ${mode}

TRANSCRIPT:
${transcript}

PROPOSED EDGES FROM AGENTS:
${JSON.stringify(allEdges, null, 2)}

PROPOSED NODES FROM AGENTS:
${JSON.stringify(allNodes, null, 2)}

Synthesize the debate into:
{
  "consensus": "The group's answer in 2-4 sentences, noting which agents agreed/disagreed",
  "tensions": ["Unresolved disagreements that need human attention or more investigation"],
  "edges": [DEDUPLICATED list of proposed edges that at least 2 agents agreed on or that the debate clearly established],
  "nodes": [DEDUPLICATED list of proposed nodes that the debate revealed are missing from the graph]
}

Only include edges where both endpoints are real addresses mentioned in the transcript.
Only include nodes that represent genuine knowledge gaps revealed by the debate.
Be conservative — omission over hallucination.`;

  const raw = await callModeratorLLM(synthPrompt, {
    systemPrompt: "You are a precise knowledge moderator. Output only valid JSON.",
    jsonMode: true,
  });
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { consensus: raw.slice(0, 500), tensions: [], edges: allEdges, nodes: allNodes };
  }
}

// --- Artifact Pipeline ---

async function stageArtifacts(
  edges: ProposedEdge[],
  nodes: ProposedNode[],
  runId: string,
  question: string
): Promise<{ stagedEdges: number; stagedNodes: number }> {
  let stagedEdges = 0;
  let stagedNodes = 0;

  // Stage proposed edges
  for (const edge of edges) {
    if (!edge.from_addr || !edge.to_addr || !edge.edge_type) continue;
    if (edge.from_addr === edge.to_addr) continue;
    const canonicalEdgeType = canonicalizeEdgeType(edge.edge_type) || edge.edge_type.trim().toLowerCase();
    // Verify both endpoints exist
    const [fromExists] = await sql`SELECT addr FROM nodes WHERE addr = ${edge.from_addr} AND visibility <> 'deleted'`;
    const [toExists] = await sql`SELECT addr FROM nodes WHERE addr = ${edge.to_addr} AND visibility <> 'deleted'`;
    if (!fromExists || !toExists) continue;
    // Check for duplicate
    const [existing] = await sql`SELECT id FROM edges WHERE from_addr = ${edge.from_addr} AND to_addr = ${edge.to_addr} AND edge_type = ${canonicalEdgeType}`;
    const [existingStaging] = await sql`
      SELECT id
      FROM staging_edges
      WHERE from_addr = ${edge.from_addr}
        AND to_addr = ${edge.to_addr}
        AND edge_type = ${canonicalEdgeType}
        AND qc_status IN ('pending', 'revised')`;
    if (existing || existingStaging) continue;

    try {
      await sql`INSERT INTO staging_edges (run_id, from_addr, to_addr, edge_type, layer, label, confidence, qc_status)
        VALUES (${runId}, ${edge.from_addr}, ${edge.to_addr}, ${canonicalEdgeType}, 1, ${edge.label || ""}, 0.60, 'pending')`;
      stagedEdges++;
    } catch { /* skip duplicates */ }
  }

  // Stage proposed nodes
  for (const node of nodes) {
    if (!node.label || !node.description) continue;
    const ontologyTarget = await resolveDurableOntologyTarget(sql, {
      content: `${node.label}\n${node.description}`,
      nodeType: node.node_type || "concept",
      actionability: node.node_type === "workflow" || node.node_type === "tool" ? 4 : 2,
    });

    // F6: allocation + INSERT must run in the same transaction-scoped
    // advisory lock to be race-safe. withAllocatedChildSlot retries on
    // PK collision with a fresh slot up to 3 times before surfacing.
    try {
      await withAllocatedChildSlot(
        sql,
        ontologyTarget.pyramidId,
        ontologyTarget.parentAddr,
        async (tx, slot) => {
          await tx`INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility, qc_status, qc_agent)
            VALUES (${runId}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position}, ${node.label},
              ${tx.json({ description: node.description, node_type: node.node_type || "concept" })},
              0.55, ${ontologyTarget.parentAddr}, 'public', 'pending', 'swarm-convene')`;
        },
      );
      stagedNodes++;
    } catch (err) {
      console.error(`[convene] staging insert failed for "${node.label}":`, err);
    }
  }

  return { stagedEdges, stagedNodes };
}

// --- Main Endpoint ---

const CONVENE_MAX_BODY_BYTES = 8_000;
const CONVENE_MODES: ReadonlySet<string> = new Set(["debate", "consensus", "adversarial"]);

/** Clamp a caller-supplied count into [min,max], tolerating junk/negatives. */
function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

swarm.post("/convene", async (c) => {
  // Bounded read on an expensive/stateful LLM surface (B29-5). Operator-gated,
  // but an unbounded body still pre-buffers before any validation.
  const parsed = await readBoundedJsonBody(c, CONVENE_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.value ?? {}) as ConveneRequest;
  const question = body.question;
  if (!question || typeof question !== "string") return errorJson(c, "invalid_request", { message: "question must be a non-empty string" });
  if (question.length > 2000) return errorJson(c, "invalid_request", { message: "question too long (max 2000 chars)" });

  // Strict input validation (B29-5): a negative max_agents/rounds previously
  // slipped through Math.min, and an unknown mode was cast through as-is.
  if (body.mode != null && !CONVENE_MODES.has(String(body.mode))) {
    return errorJson(c, "invalid_request", { message: "mode must be one of: debate, consensus, adversarial" });
  }
  const maxAgents = clampCount(body.max_agents, 6, 1, 12);
  const mode: ConveneMode = body.mode || "debate";
  const rounds = clampCount(body.rounds, 3, 1, 5);
  const startTime = Date.now();

  // Select node-agents
  const addrs = await selectAgentNodes(question, maxAgents, body.addrs);
  if (addrs.length < 2) {
    return errorJson(c, "node_not_found", { message: "Not enough relevant nodes found for a debate. Try a broader question." });
  }

  // Generate personas
  const personas = await generatePersonas(addrs);
  if (personas.length < 2) {
    return errorJson(c, "internal_error", { message: "Could not generate personas for selected nodes." });
  }

  // Run debate rounds
  const allRounds: AgentTurn[][] = [];
  for (let r = 1; r <= rounds; r++) {
    const roundTurns = await runDebateRound(question, personas, r, allRounds, mode);
    allRounds.push(roundTurns);

    // Early exit: if all agents have high consensus confidence, stop
    const avgConfidence = roundTurns.reduce((sum, t) => sum + t.confidence_in_consensus, 0) / roundTurns.length;
    if (avgConfidence > 0.85 && r >= 2) break;
  }

  // Moderator synthesis
  const synthesis = await synthesize(question, allRounds, mode);

  // Stage artifacts into the pipeline
  const runId = `convene:${Date.now()}`;
  const { stagedEdges, stagedNodes } = await stageArtifacts(
    synthesis.edges || [],
    synthesis.nodes || [],
    runId,
    question
  );

  // Log the convene
  sql`INSERT INTO query_log (query, results_returned, agent_id)
    VALUES (${"[convene] " + question}, ${personas.length}, ${body.agent || "anonymous"})
  `.catch(() => {});

  const elapsed = Date.now() - startTime;
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: conveneAuditTenant(body.agent),
    actor: body.agent || "anonymous",
    operation: "swarm_convene",
    eventData: {
      mode,
      run_id: stagedEdges + stagedNodes > 0 ? runId : null,
      staged_edges: stagedEdges,
      staged_nodes: stagedNodes,
      agent_count: personas.length,
      rounds_run: allRounds.length,
    },
  });

  return c.json({
    question,
    mode,
    agents: personas.map(p => ({ addr: p.addr, label: p.label, personality: p.personality })),
    rounds: allRounds,
    consensus: synthesis.consensus,
    proposed_edges: synthesis.edges || [],
    proposed_nodes: synthesis.nodes || [],
    unresolved_tensions: synthesis.tensions || [],
    staged: { edges: stagedEdges, nodes: stagedNodes, run_id: stagedEdges + stagedNodes > 0 ? runId : null },
    meta: {
      elapsed_ms: elapsed,
      total_turns: allRounds.flat().length,
      rounds_run: allRounds.length,
      agent_count: personas.length,
    },
  });
});

// GET /swarm/convene — read-only guard (B29-5).
// Convene runs an LLM debate AND stages new edges/nodes, so it MUST NOT be
// reachable via GET: GET is required to be safe (no side effects), and a
// browser prefetch, a retrying proxy, or a crawler following the link would
// otherwise trigger an expensive, mutating run. The wrapper used to rewrite
// the GET into a POST and re-dispatch; that is removed. Callers must POST.
swarm.get("/convene", async (c) => {
  return errorJson(c, "method_not_allowed", {
    message: "GET /swarm/convene is not supported — convene runs an LLM debate and stages graph changes, so it must be invoked with POST /swarm/convene.",
  });
});

export default swarm;
