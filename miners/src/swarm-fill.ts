/**
 * Swarm Fill — Multi-agent gap filling for Verity One
 * 
 * Spawns N agents (proposers, challengers, connectors, synthesizers)
 * that interact around a gap area, generating proposals that flow
 * through the existing staging → QC → commit pipeline.
 * 
 * Inspired by MiroFish's swarm simulation feedback loop.
 * Adapted to respect Verity One's staging gate and HOP principles.
 * 
 * Usage: 
 *   bun run miners/src/swarm-fill.ts                    # auto-detect best gap
 *   bun run miners/src/swarm-fill.ts --pyramid META     # target specific pyramid
 *   bun run miners/src/swarm-fill.ts --addr META.0.1.7  # target specific node
 *   bun run miners/src/swarm-fill.ts --agents 32        # scale up agents
 *   bun run miners/src/swarm-fill.ts --dry-run          # proposals only, no staging write
 */

import { createDirectSql } from "@verity-one/db-pool";
import { randomUUID } from "crypto";
import { canonicalizePyramidId, prefixForPyramidId } from "@verity-one/graph-shape";
import { withAllocatedChildSlot } from "../../api/src/lib/ontology";
import { callFlash, getModelId } from "./lib/llm";

const sql = createDirectSql();

// --- Config ---
const DEFAULT_AGENTS = 16;
const MAX_BUDGET_USD = 2.0;
const CONSECUTIVE_DRY_LIMIT = 3;

// --- Types ---
interface SwarmNode {
  addr: string;
  label: string;
  substance: string;
  confidence: number;
  depth: number;
  layer: number;
  parent_addr: string | null;
  pyramid_id: string;
}

interface SwarmEdge {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string;
  layer: number;
}

interface GapTarget {
  addr: string;
  label: string;
  pyramid_id: string;
  gap_type: string;
  gap_score: number;
}

interface SwarmBrief {
  target: SwarmNode;
  parent: SwarmNode | null;
  siblings: SwarmNode[];
  children: SwarmNode[];
  edges: SwarmEdge[];
  nearby: SwarmNode[];       // semantically similar from other branches
  crossPyramid: SwarmNode[]; // from other pyramids
  orphans: SwarmNode[];      // orphan nodes in this pyramid
  sourceEvidence: { addr: string; refs: string }[];  // grounding data
}

type AgentRole = "proposer" | "challenger" | "connector" | "synthesizer";

interface AgentResult {
  role: AgentRole;
  perspective: string;
  sql: string;
  raw: string;
}

// --- LLM Backend ---
async function callLLM(prompt: string, systemPrompt: string): Promise<string> {
  return callFlash(prompt, { systemPrompt, temperature: 0.4 });
}

// --- Gap Detection ---
async function detectGap(pyramidId?: string, targetAddr?: string): Promise<GapTarget | null> {
  if (targetAddr) {
    const [node] = await sql<SwarmNode[]>`
      SELECT addr, label, pyramid_id FROM nodes WHERE addr = ${targetAddr}`;
    if (!node) return null;
    return { addr: node.addr, label: node.label, pyramid_id: node.pyramid_id, gap_type: "manual", gap_score: 5 };
  }

  const gaps = await sql<GapTarget[]>`SELECT * FROM detect_pyramid_gaps(${pyramidId || null}, 1)`;
  return gaps[0] || null;
}

// --- Context Assembly ---
async function assembleContext(target: GapTarget): Promise<SwarmBrief> {
  const [targetNode] = await sql<SwarmNode[]>`
    SELECT addr, label, substance->>'description' as substance, confidence, depth, layer, parent_addr, pyramid_id
    FROM nodes WHERE addr = ${target.addr}`;

  const parent = targetNode.parent_addr ? (await sql<SwarmNode[]>`
    SELECT addr, label, substance->>'description' as substance, confidence, depth, layer, parent_addr, pyramid_id
    FROM nodes WHERE addr = ${targetNode.parent_addr}`)[0] : null;

  const siblings = parent ? await sql<SwarmNode[]>`
    SELECT addr, label, substance->>'description' as substance, confidence, depth, layer, parent_addr, pyramid_id
    FROM nodes WHERE parent_addr = ${parent.addr} AND addr != ${target.addr}
    ORDER BY addr LIMIT 10` : [];

  const children = await sql<SwarmNode[]>`
    SELECT addr, label, substance->>'description' as substance, confidence, depth, layer, parent_addr, pyramid_id
    FROM nodes WHERE parent_addr = ${target.addr}
    ORDER BY addr LIMIT 20`;

  const allAddrs = [target.addr, ...(parent ? [parent.addr] : []), ...siblings.map(s => s.addr), ...children.map(c => c.addr)];
  const edges = await sql<SwarmEdge[]>`
    SELECT from_addr, to_addr, edge_type, label, layer
    FROM edges WHERE from_addr = ANY(${allAddrs}) OR to_addr = ANY(${allAddrs})
    ORDER BY confidence DESC LIMIT 30`;

  // Semantic neighbors (from different branches)
  const nearby = await sql<SwarmNode[]>`
    SELECT n.addr, n.label, n.substance->>'description' as substance, n.confidence, n.depth, n.layer, n.parent_addr, n.pyramid_id
    FROM nodes n
    WHERE n.pyramid_id = ${target.pyramid_id}
      AND n.parent_addr != ${targetNode.parent_addr || ''}
      AND n.embedding_hv IS NOT NULL
      AND n.addr != ${target.addr}
    ORDER BY n.embedding_hv <=> (SELECT embedding_hv FROM nodes WHERE addr = ${target.addr})
    LIMIT 5`;

  // Cross-pyramid nodes
  const crossPyramid = await sql<SwarmNode[]>`
    SELECT n.addr, n.label, n.substance->>'description' as substance, n.confidence, n.depth, n.layer, n.parent_addr, n.pyramid_id
    FROM nodes n
    WHERE n.pyramid_id != ${target.pyramid_id}
      AND n.embedding_hv IS NOT NULL
    ORDER BY n.embedding_hv <=> (SELECT embedding_hv FROM nodes WHERE addr = ${target.addr})
    LIMIT 3`;

  // Orphan nodes in this pyramid
  const orphans = await sql<SwarmNode[]>`
    SELECT n.addr, n.label, n.substance->>'description' as substance, n.confidence, n.depth, n.layer, n.parent_addr, n.pyramid_id
    FROM nodes n
    WHERE n.pyramid_id = ${target.pyramid_id}
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_addr = n.addr OR e.to_addr = n.addr)
    ORDER BY n.depth, n.addr LIMIT 15`;

  // Source evidence from nearby nodes — ground proposals in real refs
  const sourceEvidence = await sql<{ addr: string; refs: string }[]>`
    SELECT addr, source_refs::text AS refs FROM nodes
    WHERE addr = ANY(${[target.addr, ...(parent ? [parent.addr] : []), ...children.map(c => c.addr)].filter(Boolean)})
      AND source_refs IS NOT NULL AND source_refs != '[]'::jsonb
    LIMIT 10`;

  return { target: targetNode, parent, siblings, children, edges, nearby, crossPyramid, orphans, sourceEvidence };
}

// --- Brief Renderer ---
function renderBrief(brief: SwarmBrief): string {
  const lines: string[] = [];
  lines.push(`# Swarm Brief for ${brief.target.addr} (${brief.target.label})`);
  lines.push(`Pyramid: ${brief.target.pyramid_id} | Layer: ${brief.target.layer} | Depth: ${brief.target.depth}`);
  lines.push("");

  lines.push("## Target Node");
  lines.push(`[${brief.target.addr}] ${brief.target.label} (conf=${brief.target.confidence})`);
  lines.push(brief.target.substance?.slice(0, 500) || "(no substance)");
  lines.push("");

  if (brief.parent) {
    lines.push("## Parent");
    lines.push(`[${brief.parent.addr}] ${brief.parent.label}: ${brief.parent.substance?.slice(0, 300)}`);
    lines.push("");
  }

  if (brief.siblings.length) {
    lines.push("## Siblings");
    brief.siblings.forEach(s => lines.push(`- [${s.addr}] ${s.label}: ${s.substance?.slice(0, 200)}`));
    lines.push("");
  }

  if (brief.children.length) {
    lines.push("## Children");
    brief.children.forEach(c => lines.push(`- [${c.addr}] ${c.label}: ${c.substance?.slice(0, 200)}`));
    lines.push("");
  }

  if (brief.edges.length) {
    lines.push("## Existing Edges");
    brief.edges.forEach(e => lines.push(`- ${e.from_addr} —[${e.edge_type}]→ ${e.to_addr}: ${e.label?.slice(0, 100)}`));
    lines.push("");
  }

  if (brief.nearby.length) {
    lines.push("## Nearby Nodes (different branches, semantically close)");
    brief.nearby.forEach(n => lines.push(`- [${n.addr}] ${n.label}: ${n.substance?.slice(0, 200)}`));
    lines.push("");
  }

  if (brief.crossPyramid.length) {
    lines.push("## Cross-Pyramid Nodes (may relate)");
    brief.crossPyramid.forEach(n => lines.push(`- [${n.addr}] ${n.label} (${n.pyramid_id}): ${n.substance?.slice(0, 200)}`));
    lines.push("");
  }

  if (brief.orphans.length) {
    lines.push("## Orphan Nodes (no edges, need connections)");
    brief.orphans.forEach(o => lines.push(`- [${o.addr}] ${o.label}: ${o.substance?.slice(0, 150)}`));
    lines.push("");
  }

  if (brief.sourceEvidence.length) {
    lines.push("## Source Evidence (ground your proposals in these)");
    brief.sourceEvidence.forEach(s => lines.push(`- [${s.addr}] refs: ${s.refs}`));
    lines.push("");
  }

  return lines.join("\n");
}

// --- Agent System Prompts ---
const STAGING_SCHEMA = `
STAGING TABLE SCHEMAS:

INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility)
VALUES ('RUN_ID', 'OC.0.2.123', 'FUNCTION', 0, 2, 123, 'Label', '{"description": "...", "node_type": "concept"}'::jsonb, 0.65, 'OC.0.1.4', 'public');

INSERT INTO staging_edges (run_id, from_addr, to_addr, edge_type, layer, label, confidence)
VALUES ('RUN_ID', 'ADDR1', 'ADDR2', 'mirrors|implements|governs|integrates|informs', LAYER, 'WHY this connection exists', 0.65);
`;

function getSystemPrompt(role: AgentRole, perspectiveNode?: SwarmNode): string {
  const base = `You are a swarm agent for the Verity One knowledge pyramid. Your output MUST be ONLY valid SQL INSERT statements into staging_nodes and/or staging_edges. No explanations, no markdown, no commentary. Just SQL.

HARD RULES:
- Maximum confidence: 0.65
- Substance must be SELF-SUFFICIENT (reader understands without external files)
- NO raw code in substance — natural language only
- Every staged node must include substance.node_type
- Edge labels explain WHY the connection exists, not THAT it exists
- Do NOT hallucinate capabilities not present in the brief
- Use canonical pyramid_ids (FUNCTION, META, WORLD, HEURISTIC, PROJECTS, TN) and matching addr prefixes (OC, CC, CX, META, PJ, TN)
- Omission > hallucination. If unsure, skip it.
${STAGING_SCHEMA}`;

  // Node persona context if available
  const persona = perspectiveNode
    ? `\nYOU ARE NODE [${perspectiveNode.addr}] "${perspectiveNode.label}". Speak from this node's perspective and expertise. Your proposals should reflect what THIS node would consider important, missing, or connected.\nNode context: ${perspectiveNode.substance?.slice(0, 300) || "(none)"}\n`
    : "";

  switch (role) {
    case "proposer":
      return `${base}${persona}
YOUR ROLE: PROPOSER
Generate new child nodes for areas that are thin or missing children. Each proposed node should add genuine knowledge that isn't already captured. Focus on depth and specificity. Propose 2-4 nodes maximum.
IMPORTANT: Ground your proposals in the Source Evidence section when available. If no evidence supports a claim, do NOT propose it. The substance description must be factual and verifiable from the brief context.`;

    case "challenger":
      return `${base}${persona}
YOUR ROLE: CHALLENGER  
Review the proposals below. For GOOD proposals, output them as-is (copy the SQL). For BAD proposals (hallucinated, duplicate, vague), output nothing for that proposal. For proposals that need fixes, output the CORRECTED SQL. Only output SQL for proposals you approve or revise.`;

    case "connector":
      return `${base}${persona}
YOUR ROLE: CONNECTOR
Find meaningful edges between orphan nodes and the rest of the graph. Each edge must explain WHY the connection exists. Focus on cross-branch and cross-pyramid connections. Propose 3-6 edges maximum.`;

    case "synthesizer":
      return `${base}${persona}
YOUR ROLE: SYNTHESIZER
Look for L1 (relational) patterns across the L0 facts in this area. If you find a genuine pattern — where multiple facts connect in a non-obvious way — propose an L1 node (layer=1) with edges to the facts it connects. L2 (meaning) nodes are extremely rare; only propose if the insight is genuinely transcendent. Propose 0-2 nodes maximum. It is perfectly acceptable to propose nothing if no genuine pattern exists.`;
  }
}

// --- Run Agents ---
async function runProposers(
  brief: string, runId: string, perspectiveNodes: SwarmNode[], count: number
): Promise<AgentResult[]> {
  const tasks = perspectiveNodes.slice(0, count).map(async (pNode) => {
    const prompt = `${brief}

You represent the perspective of: [${pNode.addr}] ${pNode.label}
Run ID: ${runId}

Looking at this area from your perspective, what children, enrichments, or missing nodes would strengthen this part of the pyramid? Output ONLY SQL INSERT statements.`;

    try {
      const raw = await callLLM(prompt, getSystemPrompt("proposer", pNode));
      const sqlOut = extractSQL(raw, runId);
      return { role: "proposer" as AgentRole, perspective: pNode.addr, sql: sqlOut, raw };
    } catch (e: any) {
      console.error(`  Proposer (${pNode.addr}) failed: ${e.message}`);
      return { role: "proposer" as AgentRole, perspective: pNode.addr, sql: "", raw: e.message };
    }
  });

  return Promise.all(tasks);
}

async function runChallengers(
  brief: string, runId: string, proposals: AgentResult[], count: number
): Promise<AgentResult[]> {
  const proposalBlock = proposals
    .filter(p => p.sql.trim())
    .map((p, i) => `--- Proposal ${i + 1} (from perspective ${p.perspective}) ---\n${p.sql}`)
    .join("\n\n");

  if (!proposalBlock.trim()) return [];

  const tasks = Array.from({ length: count }, async (_, i) => {
    try {
      const prompt = `${brief}\n\nPROPOSALS TO REVIEW:\n${proposalBlock}\n\nRun ID: ${runId}\n\nReview each proposal. Output ONLY the SQL for proposals you ACCEPT or REVISE. Skip rejected proposals entirely.`;
      const raw = await callLLM(prompt, getSystemPrompt("challenger"));
      const sqlOut = extractSQL(raw, runId);
      return { role: "challenger" as AgentRole, perspective: `challenger-${i}`, sql: sqlOut, raw };
    } catch (e: any) {
      console.error(`  Challenger ${i} failed: ${e.message}`);
      return { role: "challenger" as AgentRole, perspective: `challenger-${i}`, sql: "", raw: e.message };
    }
  });

  return Promise.all(tasks);
}

async function runConnectors(
  brief: string, runId: string, count: number
): Promise<AgentResult[]> {
  const tasks = Array.from({ length: count }, async (_, i) => {
    try {
      const prompt = `${brief}\n\nRun ID: ${runId}\n\nFocus on the orphan nodes listed above. Find meaningful connections (edges) between them and the rest of the graph. Each edge label must explain WHY the relationship exists. Output ONLY SQL INSERT INTO staging_edges statements.`;
      const raw = await callLLM(prompt, getSystemPrompt("connector", brief.target));
      const sqlOut = extractSQL(raw, runId);
      return { role: "connector" as AgentRole, perspective: `connector-${i}`, sql: sqlOut, raw };
    } catch (e: any) {
      console.error(`  Connector ${i} failed: ${e.message}`);
      return { role: "connector" as AgentRole, perspective: `connector-${i}`, sql: "", raw: e.message };
    }
  });

  return Promise.all(tasks);
}

async function runSynthesizers(
  brief: string, runId: string, acceptedSQL: string, count: number
): Promise<AgentResult[]> {
  const tasks = Array.from({ length: count }, async (_, i) => {
    try {
      const prompt = `${brief}\n\nACCEPTED PROPOSALS FROM THIS SWARM:\n${acceptedSQL || "(no proposals yet)"}\n\nRun ID: ${runId}\n\nLook for L1 relational patterns across the L0 facts. Do any facts connect in a non-obvious way that deserves a relation node? Output ONLY SQL INSERT statements with layer=1 for L1 nodes. Propose nothing if no genuine pattern exists.`;
      const raw = await callLLM(prompt, getSystemPrompt("synthesizer", brief.target));
      const sqlOut = extractSQL(raw, runId);
      return { role: "synthesizer" as AgentRole, perspective: `synthesizer-${i}`, sql: sqlOut, raw };
    } catch (e: any) {
      console.error(`  Synthesizer ${i} failed: ${e.message}`);
      return { role: "synthesizer" as AgentRole, perspective: `synthesizer-${i}`, sql: "", raw: e.message };
    }
  });

  return Promise.all(tasks);
}

// --- SQL Extraction ---
function extractSQL(raw: string, runId: string): string {
  // Strip markdown code fences
  let cleaned = raw.replace(/```sql\n?/gi, "").replace(/```\n?/g, "").trim();
  
  // Only keep INSERT INTO staging_* lines
  const lines = cleaned.split("\n");
  const sqlLines: string[] = [];
  let inInsert = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith("INSERT INTO STAGING_")) {
      inInsert = true;
      sqlLines.push(trimmed);
    } else if (inInsert) {
      sqlLines.push(trimmed);
      if (trimmed.endsWith(";")) {
        inInsert = false;
      }
    }
  }
  
  let result = sqlLines.join("\n");
  
  // Ensure run_id is correct (agents might hallucinate it)
  result = result.replace(/'RUN_ID'/g, `'${runId}'`);
  
  return result;
}

// --- Staging Write ---
/**
 * Allowlist gate for an LLM-emitted staging INSERT before it reaches sql.unsafe().
 * The previous gate only checked that a statement STARTS with "INSERT INTO staging_…",
 * which let `INSERT INTO staging_nodes (...) VALUES (...); DROP TABLE nodes; --` and
 * `INSERT INTO staging_nodes SELECT ...` through. This is a string-literal-aware scanner:
 * it tracks single-quoted literals (Postgres `''` escaping) so JSON substance values may
 * freely contain `;`, `--`, or SQL keywords, and OUTSIDE literals it forbids statement
 * separators, comments, a second statement, and any non-INSERT/VALUES SQL keyword. Only a
 * single, well-formed `INSERT INTO staging_(nodes|edges|updates) (...) VALUES (...)` passes.
 *
 * (The fuller migration — model emits structured JSON proposals, we emit parameterized
 * inserts — is the preferred end state but requires reworking the swarm's inter-agent SQL
 * handoff and validating against the live multi-agent run; tracked as a follow-up.)
 */
export function isSafeStagingInsert(rawStmt: string): boolean {
  const stmt = rawStmt.trim().replace(/;+\s*$/, ""); // tolerate trailing semicolon(s)
  if (!stmt) return false;
  if (!/^INSERT\s+INTO\s+staging_(nodes|edges|updates)\b/i.test(stmt)) return false;

  // Collect everything OUTSIDE single-quoted string literals (lowercased).
  let inStr = false;
  let outside = "";
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (inStr) {
      if (ch === "'") {
        if (stmt[i + 1] === "'") { i++; continue; } // '' = escaped quote, stay in string
        inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    outside += ch.toLowerCase();
  }
  if (inStr) return false; // unterminated string literal → malformed/suspicious

  if (outside.includes(";")) return false;                        // stacked statements
  if (outside.includes("--") || outside.includes("/*") || outside.includes("*/")) return false; // comments
  // Exactly one INSERT, a VALUES clause, and no non-INSERT SQL verbs outside literals.
  if ((outside.match(/\binsert\s+into\b/g) || []).length !== 1) return false;
  if (!/\bvalues\b/.test(outside)) return false;
  if (/\b(select|drop|delete|update|alter|truncate|create|grant|revoke|copy|merge|call|do|attach|set|returning|union|with)\b/.test(outside)) return false;

  // Block function-call expressions (e.g. `VALUES (pg_sleep(30))`), which pass
  // every keyword check above. Legit staging inserts use only literals and
  // casts (`'…'::jsonb`); the ONLY legitimate `identifier(` tokens are the
  // table name, its column-list opener, and VALUES. Any other identifier
  // immediately followed by `(` is a function call and is rejected.
  const ALLOWED_PARENS = new Set(["values", "staging_nodes", "staging_edges", "staging_updates"]);
  for (const m of outside.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (!ALLOWED_PARENS.has(m[1])) return false;
  }

  return true;
}

/**
 * Split a batch of LLM-emitted SQL into statements on semicolons that are
 * OUTSIDE single-quoted string literals (Postgres `''` escaping). A raw
 * `allSQL.split(";")` would split a valid INSERT whose JSON/text value contains
 * a `;`, corrupting it into bad fragments. Mirrors the literal tracking in
 * isSafeStagingInsert.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { cur += "'"; i++; continue; } // '' escaped quote
        inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === ";") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function writeToStaging(allSQL: string, runId: string, dryRun: boolean): Promise<{ nodes: number; edges: number; updates: number }> {
  if (!allSQL.trim()) return { nodes: 0, edges: 0, updates: 0 };
  
  // Count expected inserts
  const nodeCount = (allSQL.match(/INSERT INTO staging_nodes/gi) || []).length;
  const edgeCount = (allSQL.match(/INSERT INTO staging_edges/gi) || []).length;
  const updateCount = (allSQL.match(/INSERT INTO staging_updates/gi) || []).length;

  if (dryRun) {
    console.log("  [DRY RUN] Would stage:", { nodes: nodeCount, edges: edgeCount, updates: updateCount });
    return { nodes: nodeCount, edges: edgeCount, updates: updateCount };
  }

  // Execute SQL statements one at a time for safety.
  const statements = splitSqlStatements(allSQL).filter(s => s.trim().toUpperCase().startsWith("INSERT INTO STAGING_"));
  let successNodes = 0, successEdges = 0, successUpdates = 0;

  // Track address remapping: LLM-generated addr → safe addr
  const addrMap = new Map<string, string>();
  const canonicalPyramidByAddr = new Map<string, string>();
  const executedProposedNodeAddrs = new Set<string>();

  const nodeStatements = statements.filter((stmt) => /\bINSERT\s+INTO\s+staging_nodes\b/i.test(stmt));
  const otherStatements = statements.filter((stmt) => !/\bINSERT\s+INTO\s+staging_nodes\b/i.test(stmt));

  // Stage nodes first so edges can be remapped to the allocated addrs.
  // The INSERT itself runs inside the same transaction-scoped advisory
  // lock as the slot allocation; this preserves F6's race-safe contract
  // even though the source is LLM-emitted SQL.
  for (const stmt of nodeStatements) {
    let trimmed = stmt.trim();
    if (!isSafeStagingInsert(trimmed)) {
      console.warn(`  ↳ Blocked unsafe staged node SQL: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const addrMatch = trimmed.match(/VALUES\s*\(\s*'[^']+'\s*,\s*'([^']+)'/i);
    const pyramidMatch = trimmed.match(/VALUES\s*\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'([^']+)'/i);
    if (addrMatch && pyramidMatch) {
      const proposedAddr = addrMatch[1];
      const pyramidId = canonicalizePyramidId(pyramidMatch[1]);
      if (!pyramidId) {
        console.warn(`  ↳ Skip node ${proposedAddr}: unknown pyramid_id ${pyramidMatch[1]}`);
        continue;
      }
      if (executedProposedNodeAddrs.has(proposedAddr)) {
        console.warn(`  ↳ Skip duplicate staged node proposal for ${proposedAddr}`);
        continue;
      }
      executedProposedNodeAddrs.add(proposedAddr);

      try {
        await withAllocatedChildSlot(sql, pyramidId, null, async (tx, slot) => {
          trimmed = trimmed.replace(
            /(VALUES\s*\(\s*'[^']+'\s*,\s*)'[^']+'\s*,\s*'[^']+'\s*,\s*[^,]+,\s*[^,]+,\s*[^,]+/i,
            `$1'${slot.addr}', '${pyramidId}', 0, ${slot.depth}, ${slot.position}`,
          );
          await tx.unsafe(trimmed + ";");
          addrMap.set(proposedAddr, slot.addr);
          canonicalPyramidByAddr.set(proposedAddr, pyramidId);
          canonicalPyramidByAddr.set(slot.addr, pyramidId);

          const action = proposedAddr === slot.addr ? "normalize" : "remap";
          const prefix = prefixForPyramidId(pyramidId) || pyramidId;
          console.log(`  ↳ ${action}: ${proposedAddr} → ${slot.addr} (${pyramidId}/${prefix})`);
        });
        successNodes++;
      } catch (e: any) {
        console.error(`  SQL error: ${e.message.slice(0, 100)}`);
      }
    }
  }

  for (const stmt of otherStatements) {
    let trimmed = stmt.trim();
    if (!trimmed) continue;
    
    // Apply address remapping
    for (const [old, safe] of addrMap) {
      trimmed = trimmed.replaceAll(`'${old}'`, `'${safe}'`);
    }

    if (trimmed.includes("staging_edges")) {
      const edgeMatch = trimmed.match(/VALUES\s*\(\s*'[^']+'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/i);
      if (edgeMatch && edgeMatch[1] === edgeMatch[2]) {
        console.warn(`  ↳ Skip self-loop edge ${edgeMatch[1]} → ${edgeMatch[2]}`);
        continue;
      }
    }
    
    // Allowlist gate: a single well-formed INSERT INTO staging_(nodes|edges|updates) only —
    // rejects stacked statements, comments, INSERT…SELECT, and non-INSERT verbs (string-
    // literal-aware, so JSON substance values are unaffected).
    if (!isSafeStagingInsert(trimmed)) {
      console.warn(`  ↳ Blocked unsafe staging SQL: ${trimmed.slice(0, 60)}`);
      continue;
    }
    try {
      await sql.unsafe(trimmed + ";");
      if (trimmed.includes("staging_edges")) successEdges++;
      else if (trimmed.includes("staging_updates")) successUpdates++;
    } catch (e: any) {
      console.error(`  SQL error: ${e.message.slice(0, 100)}`);
    }
  }

  return { nodes: successNodes, edges: successEdges, updates: successUpdates };
}

// --- Main Orchestrator ---
async function main() {
  const args = process.argv.slice(2);
  const pyramidId = args.includes("--pyramid") ? args[args.indexOf("--pyramid") + 1] : undefined;
  const targetAddr = args.includes("--addr") ? args[args.indexOf("--addr") + 1] : undefined;
  const agentCount = args.includes("--agents") ? parseInt(args[args.indexOf("--agents") + 1]) : DEFAULT_AGENTS;
  const dryRun = args.includes("--dry-run");
  console.log("🐟 Swarm Fill starting...");
  console.log(`   Agents: ${agentCount} | Dry run: ${dryRun}`);

  // Phase 0: Gap Detection
  console.log("\n📍 Phase 0: Gap Detection");
  const gap = await detectGap(pyramidId, targetAddr);
  if (!gap) {
    console.log("  No gaps found. Pyramid may be saturated.");
    process.exit(0);
  }
  console.log(`  Target: [${gap.addr}] ${gap.label} (${gap.gap_type}, score=${gap.gap_score})`);

  const runId = `swarm:${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  // Phase 1: Context Assembly
  console.log("\n📦 Phase 1: Context Assembly");
  const brief = await assembleContext(gap);
  const briefText = renderBrief(brief);
  console.log(`  Brief: ${briefText.length} chars | ${brief.children.length} children | ${brief.edges.length} edges | ${brief.orphans.length} orphans`);

  // Determine agent distribution
  const proposerCount = Math.ceil(agentCount / 2);
  const challengerCount = Math.ceil(agentCount / 4);
  const connectorCount = Math.max(1, Math.ceil(agentCount / 8));
  const synthesizerCount = Math.max(1, Math.ceil(agentCount / 8));

  // Perspective nodes for proposers
  const perspectiveNodes = [...brief.nearby, ...brief.crossPyramid, ...brief.siblings].slice(0, proposerCount);
  // Pad with children if not enough perspectives
  while (perspectiveNodes.length < proposerCount && brief.children.length > perspectiveNodes.length) {
    perspectiveNodes.push(brief.children[perspectiveNodes.length]);
  }
  // Final fallback: use target itself
  while (perspectiveNodes.length < proposerCount) {
    perspectiveNodes.push(brief.target);
  }

  // Phase 2: Parallel Proposals
  console.log(`\n🎯 Phase 2: Proposers (${proposerCount} agents)`);
  const proposals = await runProposers(briefText, runId, perspectiveNodes, proposerCount);
  const proposalSQL = proposals.map(p => p.sql).filter(Boolean).join("\n");
  console.log(`  Proposals: ${proposals.filter(p => p.sql.trim()).length}/${proposerCount} agents produced output`);

  // Phase 3: Challenge Round
  console.log(`\n⚔️ Phase 3: Challengers (${challengerCount} agents)`);
  const challenges = await runChallengers(briefText, runId, proposals, challengerCount);
  const challengeSQL = challenges.map(c => c.sql).filter(Boolean).join("\n");
  console.log(`  Challenges: ${challenges.filter(c => c.sql.trim()).length}/${challengerCount} agents produced output`);

  // Phase 4: Connection Round
  console.log(`\n🔗 Phase 4: Connectors (${connectorCount} agents)`);
  const connections = await runConnectors(briefText, runId, connectorCount);
  const connectionSQL = connections.map(c => c.sql).filter(Boolean).join("\n");
  console.log(`  Connections: ${connections.filter(c => c.sql.trim()).length}/${connectorCount} agents produced output`);

  // Phase 5: Synthesis Round
  const acceptedSQL = [challengeSQL || proposalSQL, connectionSQL].filter(Boolean).join("\n");
  console.log(`\n🧬 Phase 5: Synthesizers (${synthesizerCount} agents)`);
  const syntheses = await runSynthesizers(briefText, runId, acceptedSQL, synthesizerCount);
  const synthesisSQL = syntheses.map(s => s.sql).filter(Boolean).join("\n");
  console.log(`  Syntheses: ${syntheses.filter(s => s.sql.trim()).length}/${synthesizerCount} agents produced output`);

  // Phase 6: Staging Commit
  const allSQL = [
    challengeSQL || proposalSQL, // Use challenged versions if available, else raw proposals
    connectionSQL,
    synthesisSQL,
  ].filter(Boolean).join("\n\n");

  // Dump raw SQL for comparison
  if (process.env.SWARM_DUMP) {
    const fs = await import("fs");
    fs.writeFileSync(process.env.SWARM_DUMP, allSQL, "utf-8");
    console.log(`  [DUMP] Wrote raw SQL to ${process.env.SWARM_DUMP}`);
  }

  console.log(`\n📝 Phase 6: Staging ${dryRun ? "(DRY RUN)" : ""}`);
  const staged = await writeToStaging(allSQL, runId, dryRun);
  console.log(`  Staged: ${staged.nodes} nodes, ${staged.edges} edges, ${staged.updates} updates`);

  // Log mining run
  const elapsed = (Date.now() - startTime) / 1000;
  if (!dryRun) {
    await sql`INSERT INTO mining_runs (run_number, pyramid_id, mode, nodes_checked, edges_found, implied_nodes, model_used, completed_at, source_files)
      VALUES (
        (SELECT COALESCE(MAX(run_number), 0) + 1 FROM mining_runs),
        ${gap.pyramid_id},
        'swarm-fill',
        ${agentCount},
        ${staged.edges},
        ${staged.nodes},
        ${getModelId("flash")},
        NOW(),
        ${JSON.stringify([{ type: "gap", addr: gap.addr, label: gap.label, gap_type: gap.gap_type }])}::jsonb
      )`;
  }

  console.log(`\n✅ Swarm Fill complete in ${elapsed.toFixed(1)}s`);
  console.log(`   Run: ${runId}`);
  console.log(`   Target: [${gap.addr}] ${gap.label}`);
  console.log(`   Agents: ${agentCount} (${proposerCount}P + ${challengerCount}C + ${connectorCount}N + ${synthesizerCount}S)`);
  console.log(`   Staged: ${staged.nodes} nodes + ${staged.edges} edges + ${staged.updates} updates`);
  console.log(`   Next: Run qc-check.ts to validate proposals, then commit.ts to promote approved items.`);

  await sql.end();
}

// Only run the CLI when executed directly, not when imported (e.g. by tests) — importing
// must not connect to the DB or convene a swarm.
if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
