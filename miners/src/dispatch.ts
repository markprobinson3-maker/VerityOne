/**
 * Mercury Blitz Dispatcher
 * 
 * Reads a target node cluster from the pyramid, builds context,
 * dispatches Mercury for mining, and writes results to staging tables.
 * 
 * Usage: bun run miners/src/dispatch.ts <addr> [--source <file>]
 * 
 * The --source flag provides additional source material (a markdown file
 * whose content Mercury should extract facts from into the node's children).
 * Without --source, Mercury works from the existing substance only.
 */
import { createDirectSql } from "@verity-one/db-pool";
import { randomUUID } from "crypto";
import { buildAddr, prefixForPyramidId } from "@verity-one/graph-shape";

const sql = createDirectSql();

const MERCURY_CONSTRAINTS = `You are a Layer 0 cartographer for the Verity One knowledge pyramid. You extract FACTS from source material into pyramid nodes.

HARD RULES:
1. Output ONLY valid SQL INSERT statements into staging_nodes, staging_edges, or staging_updates. Each statement must end with a semicolon.
2. NO explanations, NO markdown, NO commentary. Just SQL.
3. Every substance must be SELF-SUFFICIENT — a reader must understand the node without any external files. Include all relevant details, specs, numbers, names.
4. NO raw code in substance. Natural language descriptions of structure, logic, flow only.
5. Atomic: one subject + one verb + one object per node label. Keep labels concise.
6. Binary triads: propose exactly 2 children per parent when decomposing.
7. Maximum confidence: 0.65. You are a cartographer, not an oracle.
8. Edge labels must explain WHY the connection exists, not just THAT it exists.
9. If you are unsure about something, DO NOT include it. Omission > hallucination.
10. Use the run_id provided. Do not invent addresses that conflict with existing ones.

FORBIDDEN:
- DO NOT invent capabilities, features, or systems that aren't explicitly stated in the source material.
- DO NOT guess at implementation details not present in the source.
- DO NOT create edges to nodes not in the provided context or being created in this batch.
- DO NOT output anything except SQL INSERT statements.

STAGING TABLE SCHEMAS:

INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility)
VALUES ('RUN_ID', 'OC.0.2.123', 'OPENCLAW', 0, 2, 123, 'Label', '{"description": "...", "node_type": "concept"}'::jsonb, 0.65, 'OC.0.1.4', 'public|private');

INSERT INTO staging_edges (run_id, from_addr, to_addr, edge_type, layer, label, confidence)
VALUES ('RUN_ID', 'ADDR1', 'ADDR2', 'mirrors|implements|governs|...', 1, 'WHY description', 0.65);

INSERT INTO staging_updates (run_id, addr, field, old_value, new_value, reason)
VALUES ('RUN_ID', 'ADDR', 'substance', '"old"'::jsonb, '{"description": "new..."}'::jsonb, 'WHY this improves it');`;

interface Node {
  addr: string;
  label: string;
  substance: Record<string, unknown>;
  confidence: number;
  depth: number;
  layer: number;
  parent_addr: string | null;
  pyramid_id: string;
  visibility: string;
}

interface Edge {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  layer: number;
  label: string;
}

async function getNodeCluster(addr: string) {
  // Get the target node
  const [target] = await sql<Node[]>`
    SELECT addr, label, substance, confidence, depth, layer, parent_addr, pyramid_id, visibility
    FROM nodes WHERE addr = ${addr}
  `;
  if (!target) throw new Error(`Node ${addr} not found`);

  // Get children
  const children = await sql<Node[]>`
    SELECT addr, label, substance, confidence, depth, layer, parent_addr, pyramid_id, visibility
    FROM nodes WHERE parent_addr = ${addr}
    ORDER BY position
  `;

  // Get siblings (same parent)
  const siblings = target.parent_addr
    ? await sql<Node[]>`
        SELECT addr, label, substance, confidence, depth, layer, parent_addr, pyramid_id, visibility
        FROM nodes WHERE parent_addr = ${target.parent_addr} AND addr != ${addr}
        ORDER BY position
      `
    : [];

  // Get parent
  const parent = target.parent_addr
    ? (
        await sql<Node[]>`
          SELECT addr, label, substance, confidence, depth, layer, parent_addr, pyramid_id, visibility
          FROM nodes WHERE addr = ${target.parent_addr}
        `
      )[0]
    : null;

  // Get edges involving this node
  const edges = await sql<Edge[]>`
    SELECT from_addr, to_addr, edge_type, layer, label
    FROM edges WHERE from_addr = ${addr} OR to_addr = ${addr}
  `;

  // Get next available positions at target's child depth
  const [maxPos] = await sql`
    SELECT COALESCE(MAX(position), 0) as max_pos FROM nodes 
    WHERE parent_addr = ${addr}
  `;

  // Get next available depth-position number in the pyramid
  // Check BOTH nodes and staging_nodes to avoid addr cycling on rejected proposals
  const childDepth = target.depth + 1;
  const [maxNum] = await sql`
    SELECT GREATEST(
      COALESCE((SELECT MAX(SPLIT_PART(addr, '.', 4)::int) FROM nodes WHERE pyramid_id = ${target.pyramid_id} AND depth = ${childDepth}), 0),
      COALESCE((SELECT MAX(SPLIT_PART(addr, '.', 4)::int) FROM staging_nodes WHERE pyramid_id = ${target.pyramid_id} AND depth = ${childDepth}), 0)
    ) as max_num
  `;

  return {
    target,
    children,
    siblings,
    parent,
    edges,
    nextPosition: (maxPos as { max_pos: number }).max_pos + 1,
    nextNumber: (maxNum as { max_num: number }).max_num + 1,
    childDepth,
  };
}

function buildPrompt(
  cluster: Awaited<ReturnType<typeof getNodeCluster>>,
  runId: string,
  sourceContent?: string
): string {
  const { target, children, siblings, parent, edges, nextNumber, childDepth } =
    cluster;
  const nextAddr = buildAddr(target.pyramid_id, 0, childDepth, nextNumber);
  const nextAddrPlusOne = buildAddr(target.pyramid_id, 0, childDepth, nextNumber + 1);
  const prefix = prefixForPyramidId(target.pyramid_id) || target.pyramid_id;

  let prompt = `${MERCURY_CONSTRAINTS}\n\n`;
  prompt += `RUN_ID: ${runId}\n`;
  prompt += `PYRAMID: ${target.pyramid_id}\n\n`;

  prompt += `=== TARGET NODE ===\n`;
  prompt += `Address: ${target.addr}\n`;
  prompt += `Label: ${target.label}\n`;
  prompt += `Depth: ${target.depth}, Layer: ${target.layer}\n`;
  prompt += `Current substance: ${JSON.stringify(target.substance)}\n`;
  prompt += `Confidence: ${target.confidence}\n`;
  prompt += `Visibility: ${target.visibility}\n\n`;

  if (parent) {
    prompt += `=== PARENT ===\n`;
    prompt += `${parent.addr} | ${parent.label} | ${JSON.stringify(parent.substance)}\n\n`;
  }

  if (children.length > 0) {
    prompt += `=== EXISTING CHILDREN (do NOT duplicate these) ===\n`;
    for (const c of children) {
      prompt += `${c.addr} | ${c.label} | depth ${c.depth} | ${JSON.stringify(c.substance)}\n`;
    }
    prompt += `\n`;
  }

  if (siblings.length > 0) {
    prompt += `=== SIBLINGS (for context, do NOT duplicate) ===\n`;
    for (const s of siblings) {
      prompt += `${s.addr} | ${s.label}\n`;
    }
    prompt += `\n`;
  }

  if (edges.length > 0) {
    prompt += `=== EXISTING EDGES ===\n`;
    for (const e of edges) {
      prompt += `${e.from_addr} → ${e.to_addr} | ${e.edge_type} L${e.layer} | ${e.label}\n`;
    }
    prompt += `\n`;
  }

  prompt += `=== NEXT AVAILABLE ADDRESSES ===\n`;
  prompt += `For new children of ${target.addr}: use ${nextAddr}, ${nextAddrPlusOne}, etc. Prefix ${prefix} must match pyramid_id ${target.pyramid_id}.\n`;
  prompt += `Position numbers: start at ${cluster.nextPosition}\n\n`;

  if (sourceContent) {
    prompt += `=== SOURCE MATERIAL (extract facts from this) ===\n`;
    prompt += sourceContent;
    prompt += `\n\n`;
  }

  prompt += `=== YOUR TASK ===\n`;
  if (sourceContent) {
    prompt += `Extract all relevant facts from the source material into child nodes of ${target.addr}.\n`;
    prompt += `If the target substance is thin, also propose an UPDATE with richer substance.\n`;
  } else if (children.length === 0) {
    prompt += `This node has no children. Decompose it into exactly 2 child nodes (binary triad).\n`;
    prompt += `Base decomposition on what the current substance describes.\n`;
  } else {
    prompt += `Review this node cluster. Propose:\n`;
    prompt += `- Updates to substance if it's thin or missing details\n`;
    prompt += `- New edges if you see connections to siblings or parent\n`;
    prompt += `- Additional children if the decomposition is incomplete\n`;
  }

  prompt += `\nOutput ONLY SQL INSERT statements. Nothing else.`;

  return prompt;
}

async function main() {
  const addr = process.argv[2];
  if (!addr) {
    console.error("Usage: bun run miners/src/dispatch.ts <addr> [--source <file>]");
    process.exit(1);
  }

  const sourceIdx = process.argv.indexOf("--source");
  let sourceContent: string | undefined;
  if (sourceIdx > -1 && process.argv[sourceIdx + 1]) {
    sourceContent = await Bun.file(process.argv[sourceIdx + 1]).text();
  }

  const runId = `mercury-${randomUUID().slice(0, 8)}`;
  console.log(`Run: ${runId}`);
  console.log(`Target: ${addr}`);

  const cluster = await getNodeCluster(addr);
  const prompt = buildPrompt(cluster, runId, sourceContent);

  // Write prompt to file for dispatch
  const promptPath = `/tmp/verity-mercury-${runId}.txt`;
  await Bun.write(promptPath, prompt);
  console.log(`Prompt written to: ${promptPath}`);
  console.log(`Prompt length: ${prompt.length} chars`);
  console.log(`\nDispatch this to Mercury via:`);
  console.log(`  sessions_spawn with model=mercury, task=<contents of ${promptPath}>`);
  console.log(`\nMercury output → save to /tmp/verity-mercury-${runId}-output.sql`);
  console.log(`Then run: bun run miners/src/ingest-staging.ts ${runId} /tmp/verity-mercury-${runId}-output.sql`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
