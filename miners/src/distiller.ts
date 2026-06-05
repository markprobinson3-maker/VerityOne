/**
 * Distiller — Post-ingestion consolidation engine
 * 
 * The ingestor throws stuff at the wall. QC Sentinel filters quality.
 * The Distiller compresses what survived into maximum actionable density.
 * 
 * Passes:
 *   1. MERGE   — Near-duplicate nodes (>threshold similarity) → merge into stronger one
 *   2. ABSORB  — Overly granular children → fold substance into parent node
 *   3. ORPHAN  — Zero-edge nodes with no query hits → demote or delete
 *   4. PROMOTE — High-usage nodes → confidence boost
 *   5. STALE   — Old nodes with decayed confidence + zero queries → flag
 * 
 * Usage:
 *   bun run miners/src/distiller.ts                    # full analysis, dry-run
 *   bun run miners/src/distiller.ts --execute          # actually apply changes
 *   bun run miners/src/distiller.ts --pass merge       # run only merge pass
 *   bun run miners/src/distiller.ts --pass absorb      # run only absorb pass
 *   bun run miners/src/distiller.ts --pass orphan      # run only orphan pass
 *   bun run miners/src/distiller.ts --pass promote     # run only promote pass
 *   bun run miners/src/distiller.ts --pass stale       # run only stale pass
 *   bun run miners/src/distiller.ts --threshold 0.90   # similarity threshold (default 0.92)
 *   bun run miners/src/distiller.ts --min-age 24       # min hours since creation (default 24)
 *   bun run miners/src/distiller.ts --report           # just show stats, no actions
 */

import postgres from "postgres";
import { callFlash as callFlashLLM } from "./lib/llm";
import { embedTextForInsert, embeddingTextForNode } from "@verity-one/embed";

const sql = postgres("postgresql://localhost:5432/verity");

// --- Config ---
const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
const ABSORB_SIMILARITY_THRESHOLD = 0.88;
const ORPHAN_MIN_AGE_HOURS = 24;
const STALE_DAYS = 30;
const STALE_CONFIDENCE_FLOOR = 0.40;
const PROMOTE_QUERY_THRESHOLD = 3;
const PROMOTE_BOOST = 0.05;
const MAX_CONFIDENCE = 0.95;
const MAX_ABSORB_CHILDREN = 5;

const callFlash = (prompt: string) => callFlashLLM(prompt, { temperature: 0.1, jsonMode: true });

// --- Types ---
interface MergeCandidate {
  addr_a: string;
  label_a: string;
  addr_b: string;
  label_b: string;
  similarity: number;
  winner?: string;
  loser?: string;
  reason?: string;
}

interface AbsorbCandidate {
  parent_addr: string;
  parent_label: string;
  child_addr: string;
  child_label: string;
  similarity: number;
}

interface OrphanCandidate {
  addr: string;
  label: string;
  confidence: number;
  age_hours: number;
  query_hits: number;
}

interface PromoteCandidate {
  addr: string;
  label: string;
  confidence: number;
  query_hits: number;
  new_confidence: number;
}

interface StaleCandidate {
  addr: string;
  label: string;
  confidence: number;
  days_since_query: number;
  edge_count: number;
}

interface DistillReport {
  timestamp: string;
  merges: MergeCandidate[];
  absorbs: AbsorbCandidate[];
  orphans: OrphanCandidate[];
  promotions: PromoteCandidate[];
  stale: StaleCandidate[];
  stats: {
    total_nodes: number;
    total_edges: number;
    avg_confidence: number;
    avg_edge_density: number;
    orphan_count: number;
    high_similarity_pairs: number;
  };
}

// =====================================================================
// PASS 1: MERGE — Find near-duplicate nodes and merge them
// =====================================================================
async function findMergeCandidates(threshold: number): Promise<MergeCandidate[]> {
  console.log(`\n🔀 MERGE PASS (threshold: ${threshold})`);
  
  const pairs = await sql`
    SELECT 
      a.addr AS addr_a, a.label AS label_a, a.confidence AS conf_a, 
      a.query_hits AS hits_a, a.node_type AS type_a,
      (SELECT COUNT(*) FROM edges WHERE from_addr = a.addr OR to_addr = a.addr) AS edges_a,
      b.addr AS addr_b, b.label AS label_b, b.confidence AS conf_b,
      b.query_hits AS hits_b, b.node_type AS type_b,
      (SELECT COUNT(*) FROM edges WHERE from_addr = b.addr OR to_addr = b.addr) AS edges_b,
      1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) AS similarity
    FROM nodes a, nodes b
    WHERE a.addr < b.addr
      AND a.embedding_hv IS NOT NULL AND b.embedding_hv IS NOT NULL
      AND a.visibility = 'public' AND b.visibility = 'public'
      AND a.pyramid_id = b.pyramid_id
      AND 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) > ${threshold}
    ORDER BY similarity DESC
    LIMIT 50
  `;

  const candidates: MergeCandidate[] = [];

  for (const p of pairs) {
    // Score each node: higher = more valuable = winner
    const scoreA = (Number(p.conf_a) * 10) + Number(p.hits_a) + Number(p.edges_a);
    const scoreB = (Number(p.conf_b) * 10) + Number(p.hits_b) + Number(p.edges_b);

    candidates.push({
      addr_a: p.addr_a,
      label_a: p.label_a,
      addr_b: p.addr_b,
      label_b: p.label_b,
      similarity: Number(p.similarity),
      winner: scoreA >= scoreB ? p.addr_a : p.addr_b,
      loser: scoreA >= scoreB ? p.addr_b : p.addr_a,
      reason: `score: ${scoreA >= scoreB ? p.label_a : p.label_b} (${Math.max(scoreA, scoreB).toFixed(1)}) > ${scoreA < scoreB ? p.label_a : p.label_b} (${Math.min(scoreA, scoreB).toFixed(1)})`,
    });
  }

  console.log(`   Found ${candidates.length} merge candidates above ${threshold}`);
  for (const c of candidates.slice(0, 10)) {
    console.log(`   ${c.similarity.toFixed(3)} | KEEP ${c.winner} → ABSORB ${c.loser}`);
    console.log(`          "${c.label_a}" ↔ "${c.label_b}"`);
  }
  if (candidates.length > 10) console.log(`   ... and ${candidates.length - 10} more`);

  return candidates;
}

async function validateMerge(candidate: MergeCandidate): Promise<boolean> {
  // Ask Gemini if these are ACTUALLY duplicates or just semantically similar
  const validatePrompt = `Two knowledge graph nodes have high embedding similarity (${candidate.similarity.toFixed(3)}).
Are they TRUE DUPLICATES (same concept, should merge) or DISTINCT concepts that happen to be similar?

Node A: "${candidate.label_a}" (${candidate.addr_a})
Node B: "${candidate.label_b}" (${candidate.addr_b})

Return JSON: {"is_duplicate": true/false, "reason": "brief explanation"}`;

  try {
    const result = await callFlash(validatePrompt);
    const parsed = JSON.parse(result);
    if (!parsed.is_duplicate) {
      console.log(`   ⏭ Skip: "${candidate.label_a}" ↔ "${candidate.label_b}" — ${parsed.reason || "distinct concepts"}`);
    }
    return parsed.is_duplicate === true;
  } catch {
    return false; // Conservative: don't merge if validation fails
  }
}

async function executeMerge(candidate: MergeCandidate): Promise<void> {
  const { winner, loser } = candidate;
  if (!winner || !loser) return;

  // Validate with Gemini first
  const isActualDupe = await validateMerge(candidate);
  if (!isActualDupe) return;

  // Get both nodes' substance
  const [winnerNode] = await sql`SELECT substance, source_refs, confidence FROM nodes WHERE addr = ${winner}`;
  const [loserNode] = await sql`SELECT substance, source_refs FROM nodes WHERE addr = ${loser}`;

  if (!winnerNode || !loserNode) return;

  // Use Gemini to merge substances intelligently
  const mergePrompt = `You are merging two knowledge graph nodes that are near-duplicates.

WINNER (keep this node): ${winner}
Label: ${candidate.winner === candidate.addr_a ? candidate.label_a : candidate.label_b}
Substance: ${JSON.stringify(winnerNode.substance)}

LOSER (being absorbed): ${loser}  
Label: ${candidate.winner === candidate.addr_a ? candidate.label_b : candidate.label_a}
Substance: ${JSON.stringify(loserNode.substance)}

Merge the loser's unique information into the winner's substance. Keep the winner's structure.
Drop redundant/duplicate information. Keep only actionable, unique content.

Return JSON: {"merged_substance": <the merged substance object>}`;

  try {
    const result = await callFlash(mergePrompt);
    const parsed = JSON.parse(result);
    
    if (!parsed.merged_substance) {
      console.log(`   ⚠ Flash returned no merged_substance for ${winner} ← ${loser}`);
      return;
    }

    // Merge source_refs
    const winnerRefs = Array.isArray(winnerNode.source_refs) ? winnerNode.source_refs : [];
    const loserRefs = Array.isArray(loserNode.source_refs) ? loserNode.source_refs : [];
    const mergedRefs = [...new Set([...winnerRefs, ...loserRefs])];

    // F7: substance text changed, so re-embed before opening the
    // transaction (no nested API call inside the tx).
    const [winnerLabelRow] = await sql`SELECT label FROM nodes WHERE addr = ${winner}`;
    const winnerLabel = winnerLabelRow?.label || "";
    const winnerEmbed = await embedTextForInsert(embeddingTextForNode(winnerLabel, parsed.merged_substance));

    const { rewireEdgesForNodeMerge } = await import("../../api/src/lib/edge-mutations");
    await sql.begin(async (tx) => {
      // Update winner with merged substance + refreshed embedding markers
      await tx`UPDATE nodes SET
        substance = ${sql.json(parsed.merged_substance)},
        source_refs = ${sql.json(mergedRefs)},
        embedding_hv = ${winnerEmbed.vecStr}::halfvec(3072),
        embedding_at = ${winnerEmbed.embeddedAt},
        embedding_model = ${winnerEmbed.model},
        embedding_task_type = ${winnerEmbed.taskType},
        updated_at = now()
      WHERE addr = ${winner}`;

      // Rewire loser's edges to winner.
      await rewireEdgesForNodeMerge(sql as any, String(loser), String(winner), { tx: tx as any });

      // Hide loser (don't delete — audit trail)
      await tx`UPDATE nodes SET visibility = 'merged',
        provenance = provenance || ${sql.json({ merged_into: winner, merged_at: new Date().toISOString() })}
      WHERE addr = ${loser}`;
    });

    console.log(`   ✅ Merged: ${loser} → ${winner}`);
  } catch (err: any) {
    console.log(`   ❌ Merge failed for ${winner} ← ${loser}: ${err.message?.slice(0, 100)}`);
  }
}

// =====================================================================
// PASS 2: ABSORB — Fold overly granular children into parent
// =====================================================================
async function findAbsorbCandidates(): Promise<AbsorbCandidate[]> {
  console.log(`\n🫗 ABSORB PASS (granularity reduction)`);

  // Find children that are too similar to their parent
  const candidates = await sql`
    SELECT 
      c.addr AS child_addr, c.label AS child_label,
      p.addr AS parent_addr, p.label AS parent_label,
      c.confidence AS child_conf, c.query_hits AS child_hits,
      1 - (c.embedding_hv::vector <=> p.embedding_hv::vector) AS similarity
    FROM nodes c
    JOIN nodes p ON p.addr = c.parent_addr
    WHERE c.embedding_hv IS NOT NULL AND p.embedding_hv IS NOT NULL
      AND c.visibility = 'public' AND p.visibility = 'public'
      AND 1 - (c.embedding_hv::vector <=> p.embedding_hv::vector) > ${ABSORB_SIMILARITY_THRESHOLD}
      AND c.query_hits = 0
      AND c.confidence <= 0.6
    ORDER BY similarity DESC
    LIMIT 30
  `;

  const result: AbsorbCandidate[] = candidates.map((c: any) => ({
    parent_addr: c.parent_addr,
    parent_label: c.parent_label,
    child_addr: c.child_addr,
    child_label: c.child_label,
    similarity: Number(c.similarity),
  }));

  console.log(`   Found ${result.length} absorption candidates`);
  for (const c of result.slice(0, 8)) {
    console.log(`   ${c.similarity.toFixed(3)} | ${c.child_label} → absorb into ${c.parent_label}`);
  }
  if (result.length > 8) console.log(`   ... and ${result.length - 8} more`);

  return result;
}

async function executeAbsorb(candidates: AbsorbCandidate[]): Promise<void> {
  // Group by parent
  const byParent = new Map<string, AbsorbCandidate[]>();
  for (const c of candidates) {
    const group = byParent.get(c.parent_addr) || [];
    group.push(c);
    byParent.set(c.parent_addr, group);
  }

  for (const [parentAddr, children] of byParent) {
    if (children.length > MAX_ABSORB_CHILDREN) {
      console.log(`   ⚠ Skipping ${parentAddr} — ${children.length} children too many to absorb at once`);
      continue;
    }

    const [parent] = await sql`SELECT substance, source_refs FROM nodes WHERE addr = ${parentAddr}`;
    if (!parent) continue;

    const childData = await sql`
      SELECT addr, label, substance, source_refs FROM nodes 
      WHERE addr IN ${sql(children.map(c => c.child_addr))}
    `;

    const absorbPrompt = `You are consolidating overly-granular knowledge graph nodes into their parent.

PARENT NODE: ${parentAddr} — "${children[0].parent_label}"
Parent substance: ${JSON.stringify(parent.substance)}

CHILDREN TO ABSORB (fold their unique knowledge into parent):
${childData.map((c: any) => `- ${c.addr} "${c.label}": ${JSON.stringify(c.substance)}`).join('\n')}

Produce an enriched version of the parent substance that incorporates the children's unique information.
Eliminate redundancy. Keep it concise and actionable. The children will be hidden after this.

Return JSON: {"enriched_substance": <the enriched parent substance object>}`;

    try {
      const result = await callFlash(absorbPrompt);
      const parsed = JSON.parse(result);
      
      if (!parsed.enriched_substance) continue;

      // Merge all source_refs
      const parentRefs = Array.isArray(parent.source_refs) ? parent.source_refs : [];
      const childRefs = childData.flatMap((c: any) => Array.isArray(c.source_refs) ? c.source_refs : []);
      const mergedRefs = [...new Set([...parentRefs, ...childRefs])];

      // F7: parent substance text changed, re-embed before opening tx.
      const [parentLabelRow] = await sql`SELECT label FROM nodes WHERE addr = ${parentAddr}`;
      const parentLabel = parentLabelRow?.label || children[0].parent_label || "";
      const parentEmbed = await embedTextForInsert(embeddingTextForNode(parentLabel, parsed.enriched_substance));

      const { rewireEdgesForNodeMerge } = await import("../../api/src/lib/edge-mutations");
      await sql.begin(async (tx) => {
        await tx`UPDATE nodes SET
          substance = ${sql.json(parsed.enriched_substance)},
          source_refs = ${sql.json(mergedRefs)},
          embedding_hv = ${parentEmbed.vecStr}::halfvec(3072),
          embedding_at = ${parentEmbed.embeddedAt},
          embedding_model = ${parentEmbed.model},
          embedding_task_type = ${parentEmbed.taskType},
          updated_at = now()
        WHERE addr = ${parentAddr}`;

        for (const child of children) {
          // Rewire child edges to parent
          await rewireEdgesForNodeMerge(sql as any, String(child.child_addr), String(parentAddr), { tx: tx as any });
          
          // Hide child
          await tx`UPDATE nodes SET visibility = 'absorbed',
            provenance = provenance || ${sql.json({ absorbed_into: parentAddr, absorbed_at: new Date().toISOString() })}
          WHERE addr = ${child.child_addr}`;
        }

      });

      console.log(`   ✅ Absorbed ${children.length} children into ${parentAddr} "${children[0].parent_label}"`);
    } catch (err: any) {
      console.log(`   ❌ Absorb failed for ${parentAddr}: ${err.message?.slice(0, 100)}`);
    }
  }
}

// =====================================================================
// PASS 3: ORPHAN — Flag zero-edge nodes with no usage
// =====================================================================
async function findOrphans(minAgeHours: number): Promise<OrphanCandidate[]> {
  console.log(`\n🪹 ORPHAN PASS (min age: ${minAgeHours}h)`);

  const orphans = await sql`
    SELECT n.addr, n.label, n.confidence, n.query_hits,
      EXTRACT(EPOCH FROM (now() - n.created_at)) / 3600 AS age_hours
    FROM nodes n
    LEFT JOIN edges e_out ON e_out.from_addr = n.addr
    LEFT JOIN edges e_in ON e_in.to_addr = n.addr
    WHERE e_out.id IS NULL AND e_in.id IS NULL
      AND n.visibility = 'public'
      AND n.layer > 0
      AND EXTRACT(EPOCH FROM (now() - n.created_at)) / 3600 > ${minAgeHours}
    ORDER BY n.confidence ASC, age_hours DESC
  `;

  const result: OrphanCandidate[] = orphans.map((o: any) => ({
    addr: o.addr,
    label: o.label,
    confidence: Number(o.confidence),
    age_hours: Math.round(Number(o.age_hours)),
    query_hits: Number(o.query_hits),
  }));

  console.log(`   Found ${result.length} orphan nodes (no edges, age > ${minAgeHours}h)`);
  for (const o of result.slice(0, 10)) {
    console.log(`   ${o.addr} "${o.label}" conf=${o.confidence} age=${o.age_hours}h hits=${o.query_hits}`);
  }
  if (result.length > 10) console.log(`   ... and ${result.length - 10} more`);

  return result;
}

async function executeOrphanDemotion(orphans: OrphanCandidate[]): Promise<void> {
  for (const o of orphans) {
    // If it's been queried, don't demote — wire it instead
    if (o.query_hits > 0) {
      console.log(`   ⏭ Skip ${o.addr} — has ${o.query_hits} query hits, needs wiring not demotion`);
      continue;
    }

    await sql`UPDATE nodes SET 
      visibility = 'demoted',
      provenance = provenance || ${JSON.stringify({ 
        demoted_at: new Date().toISOString(), 
        demoted_reason: 'orphan_no_edges_no_queries' 
      })}::jsonb
    WHERE addr = ${o.addr}`;
    
    console.log(`   📉 Demoted: ${o.addr} "${o.label}"`);
  }
}

// =====================================================================
// PASS 4: PROMOTE — Boost frequently-queried nodes
// =====================================================================
async function findPromotions(): Promise<PromoteCandidate[]> {
  console.log(`\n⬆️ PROMOTE PASS (min queries: ${PROMOTE_QUERY_THRESHOLD})`);

  const promotable = await sql`
    SELECT addr, label, confidence, query_hits
    FROM nodes
    WHERE query_hits >= ${PROMOTE_QUERY_THRESHOLD}
      AND confidence < ${MAX_CONFIDENCE}
      AND visibility = 'public'
    ORDER BY query_hits DESC
    LIMIT 30
  `;

  const result: PromoteCandidate[] = promotable.map((n: any) => ({
    addr: n.addr,
    label: n.label,
    confidence: Number(n.confidence),
    query_hits: Number(n.query_hits),
    new_confidence: Math.min(MAX_CONFIDENCE, Number(n.confidence) + PROMOTE_BOOST),
  }));

  console.log(`   Found ${result.length} nodes eligible for confidence boost`);
  for (const p of result.slice(0, 10)) {
    console.log(`   ${p.addr} "${p.label}" ${p.confidence} → ${p.new_confidence} (${p.query_hits} queries)`);
  }

  return result;
}

async function executePromotions(promotions: PromoteCandidate[]): Promise<void> {
  for (const p of promotions) {
    await sql`UPDATE nodes SET 
      confidence = ${p.new_confidence},
      provenance = provenance || ${JSON.stringify({ 
        promoted_at: new Date().toISOString(), 
        promoted_reason: `${p.query_hits}_queries`,
        previous_confidence: p.confidence
      })}::jsonb
    WHERE addr = ${p.addr}`;
    
    console.log(`   ⬆️ Promoted: ${p.addr} "${p.label}" ${p.confidence} → ${p.new_confidence}`);
  }
}

// =====================================================================
// PASS 5: STALE — Flag old unqueried low-confidence nodes
// =====================================================================
async function findStale(): Promise<StaleCandidate[]> {
  console.log(`\n🧊 STALE PASS (>${STALE_DAYS} days unqueried, conf < ${STALE_CONFIDENCE_FLOOR})`);

  const staleDaysInterval = `${STALE_DAYS} days`;
  const stale = await sql`
    SELECT n.addr, n.label, n.confidence,
      COALESCE(EXTRACT(EPOCH FROM (now() - n.last_queried)) / 86400, 
               EXTRACT(EPOCH FROM (now() - n.created_at)) / 86400) AS days_since_query,
      (SELECT COUNT(*) FROM edges WHERE from_addr = n.addr OR to_addr = n.addr) AS edge_count
    FROM nodes n
    WHERE n.visibility = 'public'
      AND n.confidence < ${STALE_CONFIDENCE_FLOOR}
      AND (n.last_queried IS NULL OR n.last_queried < now() - ${staleDaysInterval}::interval)
      AND n.created_at < now() - ${staleDaysInterval}::interval
    ORDER BY n.confidence ASC
    LIMIT 30
  `;

  const result: StaleCandidate[] = stale.map((s: any) => ({
    addr: s.addr,
    label: s.label,
    confidence: Number(s.confidence),
    days_since_query: Math.round(Number(s.days_since_query)),
    edge_count: Number(s.edge_count),
  }));

  console.log(`   Found ${result.length} stale low-confidence nodes`);
  for (const s of result.slice(0, 10)) {
    console.log(`   ${s.addr} "${s.label}" conf=${s.confidence} stale=${s.days_since_query}d edges=${s.edge_count}`);
  }

  return result;
}

// =====================================================================
// REPORT — Overall graph health metrics
// =====================================================================
async function generateReport(): Promise<DistillReport["stats"]> {
  console.log(`\n📊 GRAPH HEALTH REPORT`);

  const [counts] = await sql`
    SELECT 
      (SELECT COUNT(*) FROM nodes WHERE visibility = 'public') AS total_nodes,
      (SELECT COUNT(*) FROM edges) AS total_edges,
      (SELECT AVG(confidence) FROM nodes WHERE visibility = 'public') AS avg_confidence,
      (SELECT COUNT(*) FROM nodes n 
       LEFT JOIN edges e_out ON e_out.from_addr = n.addr
       LEFT JOIN edges e_in ON e_in.to_addr = n.addr
       WHERE e_out.id IS NULL AND e_in.id IS NULL AND n.visibility = 'public' AND n.layer > 0) AS orphan_count
  `;

  const [simPairs] = await sql`
    SELECT COUNT(*) AS cnt FROM (
      SELECT 1 FROM nodes a, nodes b
      WHERE a.addr < b.addr
        AND a.embedding_hv IS NOT NULL AND b.embedding_hv IS NOT NULL
        AND a.visibility = 'public' AND b.visibility = 'public'
        AND a.pyramid_id = b.pyramid_id
        AND 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) > 0.90
      LIMIT 100
    ) sub
  `;

  const stats = {
    total_nodes: Number(counts.total_nodes),
    total_edges: Number(counts.total_edges),
    avg_confidence: Number(Number(counts.avg_confidence).toFixed(3)),
    avg_edge_density: Number((Number(counts.total_edges) / Number(counts.total_nodes)).toFixed(2)),
    orphan_count: Number(counts.orphan_count),
    high_similarity_pairs: Number(simPairs.cnt),
  };

  console.log(`   Nodes: ${stats.total_nodes} | Edges: ${stats.total_edges}`);
  console.log(`   Avg confidence: ${stats.avg_confidence}`);
  console.log(`   Edge density: ${stats.avg_edge_density} edges/node`);
  console.log(`   Orphan nodes: ${stats.orphan_count}`);
  console.log(`   High-similarity pairs (>0.90): ${stats.high_similarity_pairs}`);

  return stats;
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  const execute = process.argv.includes("--execute");
  const reportOnly = process.argv.includes("--report");
  const passArg = process.argv.find((_, i) => process.argv[i - 1] === "--pass");
  const thresholdArg = process.argv.find((_, i) => process.argv[i - 1] === "--threshold");
  const minAgeArg = process.argv.find((_, i) => process.argv[i - 1] === "--min-age");

  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_SIMILARITY_THRESHOLD;
  const minAge = minAgeArg ? parseInt(minAgeArg) : ORPHAN_MIN_AGE_HOURS;
  const passes = passArg ? [passArg] : ["merge", "absorb", "orphan", "promote", "stale"];

  console.log(`\n🧪 Verity One Distiller ${execute ? "(EXECUTE MODE)" : "(DRY RUN)"}`);
  console.log(`   Passes: ${passes.join(", ")}`);
  console.log(`   Similarity threshold: ${threshold}`);
  console.log(`   Min orphan age: ${minAge}h`);

  // Always show report
  const stats = await generateReport();

  if (reportOnly) {
    await sql.end();
    return;
  }

  // Run requested passes
  let merges: MergeCandidate[] = [];
  let absorbs: AbsorbCandidate[] = [];
  let orphans: OrphanCandidate[] = [];
  let promotions: PromoteCandidate[] = [];
  let stale: StaleCandidate[] = [];

  if (passes.includes("merge")) {
    merges = await findMergeCandidates(threshold);
  }
  if (passes.includes("absorb")) {
    absorbs = await findAbsorbCandidates();
  }
  if (passes.includes("orphan")) {
    orphans = await findOrphans(minAge);
  }
  if (passes.includes("promote")) {
    promotions = await findPromotions();
  }
  if (passes.includes("stale")) {
    stale = await findStale();
  }

  // Summary
  console.log(`\n📋 DISTILLATION SUMMARY`);
  console.log(`   Merge candidates:   ${merges.length}`);
  console.log(`   Absorb candidates:  ${absorbs.length}`);
  console.log(`   Orphans to demote:  ${orphans.filter(o => o.query_hits === 0).length}`);
  console.log(`   Nodes to promote:   ${promotions.length}`);
  console.log(`   Stale flagged:      ${stale.length}`);

  if (!execute) {
    console.log(`\n   ⚠ DRY RUN — no changes made. Use --execute to apply.`);
    await sql.end();
    return;
  }

  // Execute
  console.log(`\n🔥 EXECUTING DISTILLATION`);

  if (passes.includes("merge") && merges.length > 0) {
    console.log(`\n--- Merging ${merges.length} pairs ---`);
    for (const m of merges) {
      await executeMerge(m);
    }
  }

  if (passes.includes("absorb") && absorbs.length > 0) {
    console.log(`\n--- Absorbing ${absorbs.length} children ---`);
    await executeAbsorb(absorbs);
  }

  if (passes.includes("orphan") && orphans.length > 0) {
    console.log(`\n--- Demoting ${orphans.filter(o => o.query_hits === 0).length} orphans ---`);
    await executeOrphanDemotion(orphans);
  }

  if (passes.includes("promote") && promotions.length > 0) {
    console.log(`\n--- Promoting ${promotions.length} nodes ---`);
    await executePromotions(promotions);
  }

  // Stale: just flag for now, don't auto-demote
  if (passes.includes("stale") && stale.length > 0) {
    console.log(`\n--- Stale nodes flagged (review recommended, no auto-action) ---`);
  }

  // Refresh registry
  await sql`SELECT refresh_registry_counts()`;
  console.log(`\n✅ Registry refreshed`);

  // Final stats
  await generateReport();

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
