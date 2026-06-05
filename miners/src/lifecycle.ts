/**
 * Node Lifecycle — Absorption logic for the thermodynamic lifecycle.
 *
 * Energy is never destroyed, only transformed.
 * Dormant nodes that go 180 days without revival get absorbed by their parent.
 * Their essence is compressed and preserved as echoes for future rediscovery.
 *
 * Usage: called from reactor.ts --lifecycle or at end of processPending()
 */

import postgres from "postgres";
import { callFlashLite } from "./lib/llm";
import { embedBatch, toVectorStr, embeddingMetadataForVectorWrite, embedTextForInsert, embeddingTextForNode } from "@verity-one/embed";

type SqlClient = ReturnType<typeof postgres>;

// ============================================================
// Types
// ============================================================

interface AbsorptionCandidate {
  addr: string;
  label: string;
  substance: any;
  embedding_hv: string | null;
  parent_addr: string | null;
}

// ============================================================
// Find nodes dormant long enough for absorption
// ============================================================

async function findAbsorptionCandidates(sql: SqlClient): Promise<AbsorptionCandidate[]> {
  const [param] = await sql`SELECT value FROM graph_state WHERE key = 'lifecycle_absorption_dormant_days'`;
  const dormantDays = parseInt(param?.value || "180");

  const rows = await sql`
    SELECT addr, label, substance, embedding_hv::text, parent_addr
    FROM nodes
    WHERE visibility = 'dormant' AND pinned = false
      AND dormant_at < now() - ${dormantDays + ' days'}::INTERVAL
  `;

  return rows.map((r: any) => ({
    addr: r.addr,
    label: r.label,
    substance: typeof r.substance === "string" ? JSON.parse(r.substance) : r.substance,
    embedding_hv: r.embedding_hv,
    parent_addr: r.parent_addr,
  }));
}

// ============================================================
// Absorb a single node — the 4-step process
// ============================================================

async function absorbNode(sql: SqlClient, node: AbsorptionCandidate): Promise<boolean> {
  if (!node.parent_addr) {
    console.log(`[LIFECYCLE] Skipping ${node.addr} "${node.label}" — no parent`);
    return false;
  }

  // Step 1: Compress essence via Flash Lite
  const description = node.substance?.description || node.label;
  const domains = Array.isArray(node.substance?.domains) ? node.substance.domains.join(", ") : "general";

  let essence: string;
  try {
    const raw = await callFlashLite(
      `This knowledge node is being retired from a knowledge graph.
Compress its core insight into a single sentence that preserves
what an AI agent might need to know in the future.
Node: ${node.label}  Description: ${description}  Domains: ${domains}
Return JSON: { "essence": "one sentence" }`,
      { jsonMode: true, temperature: 0.1, maxTokens: 256 },
    );
    const parsed = JSON.parse(raw.trim());
    essence = parsed.essence || description.slice(0, 200);
  } catch (err: any) {
    console.warn(`[LIFECYCLE] Essence compression failed for ${node.addr}: ${err.message}`);
    essence = description.slice(0, 200);
  }

  // Step 2: Absorb into parent
  const [parent] = await sql`
    SELECT addr, label, substance, embedding_hv::text FROM nodes WHERE addr = ${node.parent_addr}
  `;
  if (!parent) {
    console.log(`[LIFECYCLE] Parent ${node.parent_addr} not found for ${node.addr}, skipping`);
    return false;
  }

  const parentSubstance = typeof parent.substance === "string" ? JSON.parse(parent.substance) : (parent.substance || {});
  const absorbedEchoes = Array.isArray(parentSubstance.absorbed_echoes) ? parentSubstance.absorbed_echoes : [];
  absorbedEchoes.push({
    essence,
    original_addr: node.addr,
    absorbed_at: new Date().toISOString().split("T")[0],
  });
  parentSubstance.absorbed_echoes = absorbedEchoes;

  // Nudge parent embedding: parent × 0.95 + dying × 0.05
  let newParentEmbedding: string | null = null;
  if (parent.embedding_hv && node.embedding_hv) {
    try {
      const parentEmb = parseEmbeddingStr(parent.embedding_hv);
      const childEmb = parseEmbeddingStr(node.embedding_hv);
      if (parentEmb.length === childEmb.length && parentEmb.length > 0) {
        const nudged = parentEmb.map((v, i) => v * 0.95 + childEmb[i] * 0.05);
        newParentEmbedding = toVectorStr(nudged);
      }
    } catch {
      // Embedding nudge failed — not critical
    }
  }

  // F7: derived-vector nudge (DERIVED_NUDGE task type) — the
  // arithmetic blend is not a fresh text embed, so it gets the
  // derived-vector marker. substance + embedding + markers update
  // atomically. If the nudge can't compute, fall back to substance-
  // only — the parent's existing embedding stays valid.
  if (newParentEmbedding) {
    const nudgeMeta = embeddingMetadataForVectorWrite("DERIVED_NUDGE");
    await sql`
      UPDATE nodes SET
        substance = ${sql.json(parentSubstance)},
        embedding_hv = ${newParentEmbedding}::halfvec(3072),
        embedding_at = ${nudgeMeta.embeddedAt},
        embedding_model = ${nudgeMeta.model},
        embedding_task_type = ${nudgeMeta.taskType}
      WHERE addr = ${node.parent_addr}
    `;
  } else {
    const fallbackEmbed = await embedTextForInsert(
      embeddingTextForNode(parent.label || node.parent_addr, parentSubstance),
    );
    await sql`
      UPDATE nodes SET
        substance = ${sql.json(parentSubstance)},
        embedding_hv = ${fallbackEmbed.vecStr}::halfvec(3072),
        embedding_at = ${fallbackEmbed.embeddedAt},
        embedding_model = ${fallbackEmbed.model},
        embedding_task_type = ${fallbackEmbed.taskType}
      WHERE addr = ${node.parent_addr}
    `;
  }

  // Insert into absorbed_echoes table (vector-searchable for rediscovery)
  let essenceEmbedding: string | null = null;
  try {
    const [emb] = await embedBatch([essence]);
    if (emb) essenceEmbedding = toVectorStr(emb);
  } catch {
    // Embedding failed — insert without it
  }

  await sql`
    INSERT INTO absorbed_echoes (parent_addr, original_addr, original_label, essence, embedding)
    VALUES (${node.parent_addr}, ${node.addr}, ${node.label}, ${essence},
      ${essenceEmbedding ? sql`${essenceEmbedding}::halfvec` : null})
  `;

  // Step 3: Enrich edge siblings
  const siblings = await sql`
    SELECT DISTINCT
      CASE WHEN e.from_addr = ${node.addr} THEN e.to_addr ELSE e.from_addr END AS sibling_addr
    FROM edges e
    WHERE (e.from_addr = ${node.addr} OR e.to_addr = ${node.addr})
      AND e.edge_type != 'parent_child'
  `;

  for (const sib of siblings) {
    const [sibNode] = await sql`SELECT substance FROM nodes WHERE addr = ${sib.sibling_addr}`;
    if (!sibNode) continue;

    const sibSubstance = typeof sibNode.substance === "string" ? JSON.parse(sibNode.substance) : (sibNode.substance || {});
    const relatedEchoes = Array.isArray(sibSubstance.related_echoes) ? sibSubstance.related_echoes : [];
    relatedEchoes.push({
      echo: `Related concept (retired): ${node.label}`,
      original_addr: node.addr,
    });
    sibSubstance.related_echoes = relatedEchoes;

    await sql`UPDATE nodes SET substance = ${sql.json(sibSubstance)} WHERE addr = ${sib.sibling_addr}`;
  }

  // Step 4: Delete the node and all references
  const { deleteEdgesByIds } = await import("../../api/src/lib/edge-mutations");
  await sql.begin(async (tx: any) => {
    const edgeRows = await tx`SELECT id FROM edges WHERE from_addr = ${node.addr} OR to_addr = ${node.addr}`;
    await deleteEdgesByIds(sql as any, edgeRows.map((row: any) => row.id), { tx });
    await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
    await tx`DELETE FROM stimulus_contributions WHERE node_addr = ${node.addr}`;
    await tx`DELETE FROM stimuli WHERE node_addr = ${node.addr}`;
    await tx`DELETE FROM wi_source_links WHERE node_addr = ${node.addr}`;
    await tx`DELETE FROM nodes WHERE addr = ${node.addr}`;
  });

  console.log(`[LIFECYCLE] Absorbed ${node.addr} "${node.label}" → parent ${node.parent_addr}`);
  return true;
}

// ============================================================
// Parse embedding string "[0.1,0.2,...]" → number[]
// ============================================================

function parseEmbeddingStr(str: string): number[] {
  const clean = str.replace(/^\[/, "").replace(/\]$/, "");
  if (!clean) return [];
  return clean.split(",").map(Number);
}

// ============================================================
// runLifecycle — Orchestrator
// ============================================================

export async function runLifecycle(): Promise<{
  stimuliCleaned: number;
  dormantMarked: number;
  absorbed: number;
}> {
  const sql = postgres("postgresql://localhost:5432/verity");
  // 1. Decay + cleanup spent stimuli
  try {
    const [decayResult] = await sql`SELECT decay_wi_stimulus_energy() AS cleaned`;
    const stimuliCleaned = parseInt(decayResult.cleaned) || 0;

    // 2. Flag dormant nodes
    const [dormantResult] = await sql`SELECT mark_dormant_nodes() AS marked`;
    const dormantMarked = parseInt(dormantResult.marked) || 0;

    // 3. Absorb candidates
    const candidates = await findAbsorptionCandidates(sql);
    let absorbed = 0;
    for (const node of candidates) {
      const ok = await absorbNode(sql, node);
      if (ok) absorbed++;
    }

    return { stimuliCleaned, dormantMarked, absorbed };
  } finally {
    await sql.end();
  }
}

// Allow direct invocation for testing
if (import.meta.main) {
  const { config } = await import("dotenv");
  const { resolve } = await import("path");
  config({ path: resolve(import.meta.dir, "../../.env") });

  const result = await runLifecycle();
  console.log(`[LIFECYCLE] Stimuli cleaned: ${result.stimuliCleaned}`);
  console.log(`[LIFECYCLE] Nodes marked dormant: ${result.dormantMarked}`);
  console.log(`[LIFECYCLE] Nodes absorbed: ${result.absorbed}`);
}
