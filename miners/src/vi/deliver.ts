/**
 * Verity Ingest — Stage 5: DELIVER
 *
 * Route atoms: AUTO_ON → staging_nodes, AUTO_IN → stimuli, QUEUE → intake_queue
 * Track corroboration deltas, source history, mining run, release lock.
 */

import {
  sql, EXIT, CLASSIFIER_VERSION, TEMPORALITY_MULTIPLIER,
  ATOM_TO_STIMULUS_TYPE, ATOM_TO_NODE_TYPE,
  type IngestContext, type ClassifiedAtom,
} from "./config";
import { loadParams } from "./config";
import { DEPTH_GUARDED_PYRAMIDS } from "@verity-one/graph-shape";
import { toVectorStr } from "@verity-one/embed";
import { releaseLock } from "./receive";
import { attachOrphanToTrendPool } from "../trends/service";
import { getModelId } from "../lib/llm";
import { deriveStimulusOrigin } from "../lib/stimulus-origin";
import { resolveDurableOntologyTarget, withAllocatedChildSlot } from "../../../api/src/lib/ontology";

/**
 * VI-4: corroboration-boost gate. A boost bumps an existing node's confidence
 * when a new atom strongly AGREES with it. Require a PROVENANCE-VERIFIED atom
 * (its source_excerpt was confirmed to appear in the source) in addition to an
 * explicit no-contradiction verdict + high similarity. Content that fails the
 * provenance check — including injected/hallucinated atoms that steer the SORT
 * contradiction LLM toward "no" — must not be able to inflate a node's
 * confidence. Verified atoms still corroborate exactly as before.
 */
export function shouldApplyCorroborationBoost(atom: ClassifiedAtom): boolean {
  return (
    atom.contradiction_verdict === "no" &&
    atom.provenance === "verified" &&
    !!atom.nearest_node_addr &&
    atom.nearest_similarity > 0.90
  );
}

/**
 * DELIVER: Write classified atoms to their destination tables
 */
export async function deliver(ctx: IngestContext): Promise<void> {
  const params = await loadParams();
  const { classified_atoms, batch_id, source_type, source_id, source_title, profile, flags, stats } = ctx;

  if (flags.dry_run) {
    printDryRunSummary(ctx);
    return;
  }

  // Check queue capacity before delivering
  const [queueCount] = await sql`
    SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending'`;
  const pendingQueue = parseInt(queueCount.cnt);
  const queueAtoms = classified_atoms.filter(a => a.classification === "QUEUE");

  if (pendingQueue + queueAtoms.length > params.queue_cap) {
    await releaseLock();
    throw new Error(`Queue full: ${pendingQueue} pending + ${queueAtoms.length} new > ${params.queue_cap} cap (exit ${EXIT.QUEUE_FULL})`);
  }

  // Check contradiction cap
  const [contradictionCount] = await sql`
    SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending' AND is_contradiction = true`;
  const pendingContradictions = parseInt(contradictionCount.cnt);
  const newContradictions = classified_atoms.filter(a => a.is_contradiction).length;

  if (pendingContradictions + newContradictions > params.contradiction_cap) {
    console.error(`[DELIVER] Contradiction back-pressure: ${pendingContradictions} pending + ${newContradictions} new > ${params.contradiction_cap} cap`);
    // Don't exit — just reclassify contradictions as QUEUE without the contradiction flag
    console.log(`[DELIVER] Excess contradictions will still be queued but may overflow.`);
  }

  // Deliver each atom
  for (let i = 0; i < classified_atoms.length; i++) {
    const atom = classified_atoms[i];

    switch (atom.classification) {
      case "AUTO_ON":
        await deliverAutoOn(atom, ctx, i);
        stats.auto_on++;
        break;
      case "AUTO_IN":
        await deliverAutoIn(atom, ctx, i);
        stats.auto_in++;
        break;
      case "QUEUE":
        await deliverQueue(atom, ctx);
        stats.queued++;
        break;
    }

    // Track atom fate in feedback ledger (fire-and-forget)
    sql`
      INSERT INTO atom_feedback (ingest_batch_id, source_type, score, classification)
      VALUES (${batch_id}, ${source_type}, ${atom.score}, ${atom.classification})
    `.catch(() => {});

    // Corroboration boost — verified, explicitly-agreeing, highly-similar atoms only (VI-4).
    if (shouldApplyCorroborationBoost(atom)) {
      await applyCorroborationBoost(atom.nearest_node_addr!, batch_id);
    }
  }

  // Source history
  await sql`
    INSERT INTO source_history (source_hash, source_type, source_id, source_title, atom_count, in_count, on_count, queue_count, cost_usd, ingest_batch_id)
    VALUES (${ctx.source_hash}, ${source_type}, ${source_id}, ${source_title}, ${classified_atoms.length}, ${stats.auto_in}, ${stats.auto_on}, ${stats.queued}, ${stats.cost_usd}, ${batch_id})
    ON CONFLICT (source_hash) DO UPDATE SET
      atom_count = EXCLUDED.atom_count,
      in_count = EXCLUDED.in_count,
      on_count = EXCLUDED.on_count,
      queue_count = EXCLUDED.queue_count,
      cost_usd = EXCLUDED.cost_usd,
      ingest_batch_id = EXCLUDED.ingest_batch_id,
      ingested_at = now(),
      rolled_back = false`;

  // Mining run
  const [maxRun] = await sql`SELECT COALESCE(MAX(run_number), 0) + 1 as next FROM mining_runs`;
  await sql`INSERT INTO mining_runs (run_number, mode, nodes_checked, edges_found, implied_nodes, cost_usd, model_used, started_at, completed_at)
    VALUES (${maxRun.next}, 'verity-ingest', ${classified_atoms.length}, 0, ${stats.auto_on}, ${stats.cost_usd}, ${getModelId("flash")}, now(), now())`;

  // Release advisory lock
  await releaseLock();

  // Summary
  console.log(`\n[DELIVER] Complete:`);
  console.log(`  AUTO_ON → staging_nodes: ${stats.auto_on}`);
  console.log(`  AUTO_IN → stimuli:       ${stats.auto_in}`);
  console.log(`  QUEUE → intake_queue:    ${stats.queued}`);
  console.log(`  Cost: $${stats.cost_usd.toFixed(4)}`);
  console.log(`  Batch: ${batch_id}`);
}

// ============================================================
// AUTO_ON → staging_nodes
// ============================================================

async function deliverAutoOn(atom: ClassifiedAtom, ctx: IngestContext, atomIndex: number): Promise<void> {
  const nodeType = ATOM_TO_NODE_TYPE[atom.atom_type] || "concept";
  const ontologyTarget = await resolveDurableOntologyTarget(sql, {
    content: atom.content,
    sourceType: ctx.source_type,
    sourceTitle: ctx.source_title,
    sourceId: ctx.source_id,
    sourceExcerpt: atom.source_excerpt,
    nodeType,
    atomType: atom.atom_type,
  });
  const label = atom.content.slice(0, 80);

  const substance = {
    description: atom.content,
    node_type: nodeType,
    vi_atom_type: atom.atom_type,
    vi_temporality: atom.temporality,
    vi_source_excerpt: atom.source_excerpt,
    vi_score: atom.score,
  };

  const sourceContext = {
    vi_batch_id: ctx.batch_id,
    // Operator-internal routing provenance; do not expose these hints cross-tenant.
    vi_target_tenant_id: ctx.target_tenant_id || null,
    vi_target_space_id: ctx.target_space_id || 'global',
    vi_source_type: ctx.source_type,
    vi_score: atom.score,
    vi_score_components: atom.score_components,
    vi_classifier_version: CLASSIFIER_VERSION,
    ontology_target: {
      pyramid_id: ontologyTarget.pyramidId,
      parent_addr: ontologyTarget.parentAddr,
      parent_label: ontologyTarget.parentLabel,
      reason: ontologyTarget.selectionReason,
      keyword_score: ontologyTarget.keywordScore,
    },
  };

  // F6: allocation + depth-guard short-circuit + INSERT all live inside
  // the same transaction-scoped advisory lock so concurrent ingest into
  // the same slot space cannot collide on addr.
  await withAllocatedChildSlot(
    sql,
    ontologyTarget.pyramidId,
    ontologyTarget.parentAddr,
    async (tx, slot) => {
      // Skip staging for depth 0-2 in guarded pyramids — QC sentinel
      // would always reject these. Returning before the INSERT releases
      // the lock cleanly via COMMIT-of-empty-tx.
      if (
        slot.depth <= 2 &&
        (DEPTH_GUARDED_PYRAMIDS as readonly string[]).includes(ontologyTarget.pyramidId.toUpperCase())
      ) {
        console.log(`[DELIVER]   SKIP: depth ${slot.depth} in guarded pyramid ${ontologyTarget.pyramidId} — "${atom.content.slice(0, 50)}..."`);
        return;
      }

      await tx`INSERT INTO staging_nodes (
        run_id, addr, pyramid_id, layer, depth, position, label,
        substance, confidence, parent_addr, visibility, qc_status, qc_agent, source_context
      ) VALUES (
        ${ctx.batch_id}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position},
        ${label}, ${tx.json(substance)},
        ${ctx.profile.default_confidence}, ${ontologyTarget.parentAddr}, 'public', 'pending', 'verity-ingest',
        ${tx.json(sourceContext)}
      )`;

      console.log(`[DELIVER]   ON: ${slot.addr} "${label.slice(0, 50)}..." (${ontologyTarget.pyramidId}, score: ${atom.score})`);
    },
  );
}

// ============================================================
// AUTO_IN → stimuli (three fates: orbit, split, orphan)
// ============================================================

async function deliverAutoIn(atom: ClassifiedAtom, ctx: IngestContext, atomIndex: number): Promise<void> {
  const params = await loadParams();
  const vectorStr = toVectorStr(atom.embedding);
  const stimType = ATOM_TO_STIMULUS_TYPE[atom.atom_type] || "news_article";
  const halflife = ctx.profile.default_halflife_hours * TEMPORALITY_MULTIPLIER[atom.temporality];
  const sourceStr = `vi:${ctx.source_type}`;
  const sourceIdStr = `vi:${ctx.batch_id}:${atomIndex}`;
  const targetSpaceId = ctx.target_space_id || 'global';
  const origin = atom.origin_key
    ? {
        originKey: atom.origin_key,
        originKind: atom.origin_kind || "derived",
        originLabel: atom.origin_label || atom.origin_key,
      }
    : deriveStimulusOrigin({
        sourceType: ctx.source_type,
        sourceId: ctx.source_id,
        sourceTitle: ctx.source_title,
        url: ctx.source_id,
        chunkMetadata: ctx.chunk_metadata?.[atom.chunk_index] || null,
        content: atom.content,
        sourceExcerpt: atom.source_excerpt,
      });

  const matchingNodes = selectAutoInTargets(atom, ctx, params);

  // FATE 1: ORPHAN — no nodes above threshold.
  // F11: VI delivery is a background path; correlation_id NULL.
  if (matchingNodes.length === 0) {
    const [inserted] = await sql`
      INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, url, embedding,
        decay_halflife_hours, peak_delay_hours, energy, is_orphan, orphan_status, ingest_batch_id, temporality,
        origin_key, origin_kind, origin_label, correlation_id, space_id)
      VALUES (${sourceStr}, ${sourceIdStr}, ${stimType}, 0.5, ${atom.content}, ${ctx.source_id},
        ${vectorStr}::halfvec, ${halflife}, 0, 1.0, true, 'throbbing', ${ctx.batch_id}, ${atom.temporality},
        ${origin.originKey}, ${origin.originKind}, ${origin.originLabel}, NULL, ${targetSpaceId})
      ON CONFLICT (source, source_id) DO NOTHING
      RETURNING id`;

    if (inserted?.id) {
      await attachOrphanToTrendPool(inserted.id);
    }

    console.log(`[DELIVER]   IN ◉ ORPHAN: "${atom.content.slice(0, 50)}..." (throbbing, no home found)`);
    return;
  }

  // FATE 2: ORBIT — single node match
  if (matchingNodes.length === 1) {
    const node = matchingNodes[0];
    await sql`
      INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, url, embedding,
        decay_halflife_hours, peak_delay_hours, node_addr, similarity, energy, is_orphan, ingest_batch_id, temporality,
        origin_key, origin_kind, origin_label, correlation_id, space_id)
      VALUES (${sourceStr}, ${sourceIdStr}, ${stimType}, 0.5, ${atom.content}, ${ctx.source_id},
        ${vectorStr}::halfvec, ${halflife}, 0, ${node.addr}, ${node.similarity}, 1.0, false, ${ctx.batch_id}, ${atom.temporality},
        ${origin.originKey}, ${origin.originKind}, ${origin.originLabel}, NULL, ${targetSpaceId})
      ON CONFLICT (source, source_id) DO NOTHING`;

    console.log(`[DELIVER]   IN 🌙 ORBIT: "${atom.content.slice(0, 40)}..." → ${node.addr} (sim: ${node.similarity})`);
    return;
  }

  // FATE 3: SPLIT — multiple node matches → droplets
  // Energy conservation: split proportionally by similarity
  const totalSimilarity = matchingNodes.reduce((sum, n) => sum + n.similarity, 0);

  // Insert the parent stimulus first
  const [parent] = await sql`
    INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, url, embedding,
      decay_halflife_hours, peak_delay_hours, node_addr, similarity, energy, is_orphan, ingest_batch_id, temporality,
      origin_key, origin_kind, origin_label, correlation_id, space_id)
    VALUES (${sourceStr}, ${sourceIdStr}, ${stimType}, 0.5, ${atom.content}, ${ctx.source_id},
      ${vectorStr}::halfvec, ${halflife}, 0, ${matchingNodes[0].addr}, ${matchingNodes[0].similarity},
      ${matchingNodes[0].similarity / totalSimilarity}, false, ${ctx.batch_id}, ${atom.temporality},
      ${origin.originKey}, ${origin.originKind}, ${origin.originLabel}, NULL, ${targetSpaceId})
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING id`;

  if (!parent) {
    console.log(`[DELIVER]   IN: "${atom.content.slice(0, 50)}..." (duplicate, skipped)`);
    return;
  }

  // Insert droplets for additional matching nodes
  for (let d = 1; d < matchingNodes.length; d++) {
    const node = matchingNodes[d];
    const dropletEnergy = node.similarity / totalSimilarity;
    const dropletSourceId = `${sourceIdStr}:drop:${d}`;

    await sql`
      INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, url, embedding,
        decay_halflife_hours, peak_delay_hours, node_addr, similarity, energy,
        is_orphan, parent_stimulus_id, ingest_batch_id, temporality,
        origin_key, origin_kind, origin_label, correlation_id, space_id)
      VALUES (${sourceStr}, ${dropletSourceId}, ${stimType}, 0.5, ${atom.content}, ${ctx.source_id},
        ${vectorStr}::halfvec, ${halflife}, 0, ${node.addr}, ${node.similarity},
        ${dropletEnergy}, false, ${parent.id}, ${ctx.batch_id}, ${atom.temporality},
        ${origin.originKey}, ${origin.originKind}, ${origin.originLabel}, NULL, ${targetSpaceId})
      ON CONFLICT (source, source_id) DO NOTHING`;
  }

  const nodeList = matchingNodes.map(n => `${n.addr}(${n.similarity})`).join(", ");
  console.log(`[DELIVER]   IN 💧 SPLIT(${matchingNodes.length}): "${atom.content.slice(0, 35)}..." → ${nodeList}`);
}

function selectAutoInTargets(atom: ClassifiedAtom, ctx: IngestContext, params: Awaited<ReturnType<typeof loadParams>>) {
  const matchingNodes = atom.matching_nodes || [];
  if (ctx.source_type !== "rss") return matchingNodes;

  const ontologyAnchors = matchingNodes
    .filter((node) => isRssAnchorTarget(node, atom.atom_type, params))
    .sort((a, b) => b.similarity - a.similarity);

  if (ontologyAnchors.length === 0) return [];

  const minimumStrongSimilarity = Math.max(params.rss_anchor_similarity, params.orphan_similarity_threshold + 0.22);
  const strongAnchors = ontologyAnchors.filter((node) => node.similarity >= minimumStrongSimilarity);
  if (strongAnchors.length === 0) return [];

  const [top, second] = strongAnchors;
  if (strongAnchors.length === 1) return [top];

  if (top.similarity >= minimumStrongSimilarity && top.similarity - (second?.similarity || 0) >= params.rss_anchor_margin) {
    return [top];
  }

  return [];
}

function isRssAnchorTarget(node: { addr: string; similarity: number }, atomType: ClassifiedAtom["atom_type"], params: Awaited<ReturnType<typeof loadParams>>): boolean {
  if (node.addr.startsWith("WD.")) return true;
  if (node.addr.startsWith("TN.")) return false;
  if (!node.addr.startsWith("FN.")) return false;
  return (atomType === "ACTION" || atomType === "FRAMEWORK")
    && node.similarity >= params.rss_function_anchor_similarity;
}

// ============================================================
// QUEUE → intake_queue
// ============================================================

async function deliverQueue(atom: ClassifiedAtom, ctx: IngestContext): Promise<void> {
  const vectorStr = toVectorStr(atom.embedding);

  const lineage = {
    source_id: ctx.source_id,
    batch_id: ctx.batch_id,
    scored_at: new Date().toISOString(),
    score_components: atom.score_components,
  };

  await sql`INSERT INTO intake_queue (
    atom_content, atom_type, score, score_components, temporality,
    source_type, source_id, source_title, ingest_batch_id,
    embedding, nearest_node_addr, nearest_similarity,
    is_contradiction, provenance_status, classifier_version,
    review_status, lineage
  ) VALUES (
    ${atom.content}, ${atom.atom_type}, ${atom.score}, ${sql.json(atom.score_components)}, ${atom.temporality},
    ${ctx.source_type}, ${ctx.source_id}, ${ctx.source_title}, ${ctx.batch_id},
    ${vectorStr}::halfvec, ${atom.nearest_node_addr}, ${atom.nearest_similarity},
    ${atom.is_contradiction}, ${atom.provenance}, ${CLASSIFIER_VERSION},
    'pending', ${sql.json(lineage)}
  )`;

  const flag = atom.is_contradiction ? " [CONTRADICTION]" : atom.provenance === "unverified" ? " [UNVERIFIED]" : "";
  console.log(`[DELIVER]   Q: "${atom.content.slice(0, 50)}..." (score: ${atom.score})${flag}`);
}

// ============================================================
// CORROBORATION BOOST
// ============================================================

async function applyCorroborationBoost(nodeAddr: string, batchId: string): Promise<void> {
  const [node] = await sql`SELECT confidence FROM nodes WHERE addr = ${nodeAddr}`;
  if (!node) return;

  const before = parseFloat(node.confidence);
  const after = Math.min(1.0, before + 0.02);
  const delta = after - before;

  if (delta <= 0) return;

  await sql`UPDATE nodes SET confidence = ${after} WHERE addr = ${nodeAddr}`;
  await sql`INSERT INTO confidence_deltas (ingest_batch_id, node_addr, delta_type, confidence_before, confidence_after, delta)
    VALUES (${batchId}, ${nodeAddr}, 'corroboration', ${before}, ${after}, ${delta})`;

  console.log(`[DELIVER]   ↑ Corroboration boost: ${nodeAddr} ${before.toFixed(2)} → ${after.toFixed(2)}`);
}

// ============================================================
// DRY RUN SUMMARY
// ============================================================

function printDryRunSummary(ctx: IngestContext): void {
  const { classified_atoms, stats } = ctx;

  console.log(`\n[DRY RUN] Would deliver ${classified_atoms.length} atoms:`);

  const counts = { AUTO_ON: 0, AUTO_IN: 0, QUEUE: 0 };
  for (const atom of classified_atoms) {
    counts[atom.classification]++;
    const flag = atom.is_contradiction ? " [CONTRADICTION]" : atom.provenance === "unverified" ? " [UNVERIFIED]" : "";
    console.log(`  ${atom.classification.padEnd(7)} | ${atom.score.toFixed(2)} | ${atom.atom_type.padEnd(9)} | ${atom.content.slice(0, 60)}...${flag}`);
  }

  console.log(`\n  AUTO_ON → staging_nodes: ${counts.AUTO_ON}`);
  console.log(`  AUTO_IN → stimuli:       ${counts.AUTO_IN}`);
  console.log(`  QUEUE → intake_queue:    ${counts.QUEUE}`);
  console.log(`  Estimated cost: $${stats.cost_usd.toFixed(4)}`);
  console.log(`  Flash calls: ${stats.flash_calls}`);
  console.log(`  Batch: ${ctx.batch_id}`);
}
