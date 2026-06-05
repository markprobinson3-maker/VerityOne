/**
 * Verity Ingest — Stage 3: WEIGH
 *
 * Pure math scoring. No LLM calls.
 * 4 signals: novelty (40%), source quality (20%), specificity (20%), graph need (20%)
 * + taste multiplier (boost-only, from neighbor query feedback)
 */

import { sql, type IngestContext, type ScoredAtom, type ValidatedAtom, type VIParams, type NodeMatch } from "./config";
import { loadParams } from "./config";
import { toVectorStr } from "@verity-one/embed";

/**
 * WEIGH: Score each validated atom against the existing graph
 */
export async function weigh(ctx: IngestContext): Promise<void> {
  const params = await loadParams();
  const { validated_atoms, profile, stats } = ctx;
  const scored: ScoredAtom[] = [];

  console.log(`[WEIGH] Scoring ${validated_atoms.length} atoms...`);

  // Check if enough taste feedback data exists (single query, hoisted outside loop)
  const [feedbackCount] = await sql`SELECT COUNT(*) as cnt FROM atom_feedback WHERE query_hits > 0 OR action_hits > 0`;
  const hasTasteData = parseInt(feedbackCount.cnt) >= params.taste_min_feedback;
  if (hasTasteData) console.log(`[WEIGH] Taste signal active (${feedbackCount.cnt} feedback rows with hits)`);

  for (let i = 0; i < validated_atoms.length; i++) {
    const atom = validated_atoms[i];

    // Vector search existing nodes — top 10 for droplet splitting
    const vectorStr = toVectorStr(atom.embedding);
    const neighbors: NodeMatch[] = await sql`
      SELECT addr, label,
        1 - (embedding_hv <=> ${vectorStr}::halfvec) as similarity
      FROM nodes
      WHERE embedding_hv IS NOT NULL
      ORDER BY embedding_hv <=> ${vectorStr}::halfvec
      LIMIT 10`;

    const maxSim = neighbors[0]?.similarity ?? 0;
    const nearestAddr = neighbors[0]?.addr ?? null;

    // All nodes above droplet threshold — these get stimulus moons
    const matchingNodes = neighbors.filter(n => n.similarity >= params.droplet_min_similarity);

    // 1. Novelty (configurable weight)
    const novelty = 1.0 - maxSim;

    // 2. Source quality
    const sourceQuality = (50 + profile.importance_bias) / 100;

    // 3. Specificity
    let specificity = 0.5;
    if (atom.content.length > 100) specificity += 0.1;
    if (/\d+\.\d+/.test(atom.content) || atom.content.includes("http")) specificity += 0.1;
    if (atom.atom_type === "FRAMEWORK") specificity += 0.15;
    if (atom.atom_type === "ACTION") specificity += 0.1;
    if (atom.atom_type === "SIGNAL") specificity -= 0.2;
    if (atom.temporality === "DURABLE") specificity += 0.05;
    if (atom.temporality === "EPHEMERAL") specificity -= 0.1;
    specificity = Math.max(0, Math.min(1, specificity));

    // 4. Graph need
    let graphNeed = 0.5;
    if (neighbors.every(n => n.similarity < 0.30)) graphNeed = 1.0;
    graphNeed = Math.max(0, Math.min(1, graphNeed));

    // 5. Taste signal — do atoms like this one get queried?
    let taste = 0.5; // neutral default (cold start)

    if (hasTasteData) {
      const neighborAddrs = neighbors.filter(n => n.similarity >= 0.30).map(n => n.addr);

      if (neighborAddrs.length > 0) {
        // Single batch query — only neighbors with POSITIVE query signal, scoped to 30 days
        const neighborFeedback = await sql`
          SELECT af.node_addr, af.query_hits, af.action_hits, af.created_at
          FROM atom_feedback af
          WHERE af.node_addr = ANY(${neighborAddrs})
            AND (af.query_hits > 0 OR af.action_hits > 0)
            AND af.created_at > NOW() - INTERVAL '30 days'`;

        if (neighborFeedback.length > 0) {
          let weightedSum = 0;
          let weightTotal = 0;

          for (const nf of neighborFeedback) {
            const neighbor = neighbors.find(n => n.addr === nf.node_addr);
            if (!neighbor) continue;

            const sim = neighbor.similarity;
            const ageDays = Math.max(1, (Date.now() - new Date(nf.created_at).getTime()) / 86400000);
            const queryVelocity = Math.min(1.0, (nf.query_hits + nf.action_hits * 5) / (ageDays * 2));

            weightedSum += queryVelocity * sim;
            weightTotal += sim;
          }

          if (weightTotal > 0) {
            taste = weightedSum / weightTotal;
          }
        }
      }
    }

    taste = Math.max(0, Math.min(1, taste));

    // Base score — UNCHANGED from pre-amendment weights
    const baseScore = (novelty * params.novelty_weight) +
                      (sourceQuality * params.source_weight) +
                      (specificity * params.specificity_weight) +
                      (graphNeed * params.graph_need_weight);

    // Taste multiplier — boost-only, never reduces score
    const tasteMultiplier = (hasTasteData && taste > 0.5)
      ? 1.0 + (taste - 0.5) * params.taste_boost_factor
      : 1.0;

    const score = baseScore * tasteMultiplier;
    const roundedScore = Math.round(score * 100) / 100;

    scored.push({
      ...atom,
      score: roundedScore,
      score_components: {
        novelty: Math.round(novelty * 100) / 100,
        source_quality: Math.round(sourceQuality * 100) / 100,
        specificity: Math.round(specificity * 100) / 100,
        graph_need: Math.round(graphNeed * 100) / 100,
        taste: Math.round(taste * 100) / 100,
        taste_multiplier: Math.round(tasteMultiplier * 100) / 100,
      },
      nearest_node_addr: nearestAddr,
      nearest_similarity: Math.round(maxSim * 100) / 100,
      matching_nodes: matchingNodes.map(n => ({
        addr: n.addr,
        label: n.label,
        similarity: Math.round(n.similarity * 100) / 100,
      })),
    });
  }

  ctx.scored_atoms = scored;

  // Summary
  const scores = scored.map(a => a.score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  console.log(`[WEIGH] Scores: avg=${avg.toFixed(2)}, min=${min.toFixed(2)}, max=${max.toFixed(2)}`);
}
