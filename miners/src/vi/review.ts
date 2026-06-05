/**
 * Verity Ingest — Queue Management
 *
 * --review, --review --quick, --promote <id>, --demote <id>, --conflicts
 */

import { sql, CLASSIFIER_VERSION, ATOM_TO_STIMULUS_TYPE, ATOM_TO_NODE_TYPE, TEMPORALITY_MULTIPLIER, type AtomType, type Temporality } from "./config";
import { loadParams } from "./config";
import { toVectorStr } from "@verity-one/embed";
import { attachOrphanToTrendPool } from "../trends/service";
import { resolveDurableOntologyTarget, withAllocatedChildSlot } from "../../../api/src/lib/ontology";

interface ReviewOptions {
  promoteId: string | null;
  demoteId: string | null;
  quick: boolean;
  conflicts: boolean;
}

export async function handleReview(opts: ReviewOptions): Promise<void> {
  if (opts.promoteId) {
    await promote(parseInt(opts.promoteId));
    return;
  }

  if (opts.demoteId) {
    await demote(parseInt(opts.demoteId));
    return;
  }

  if (opts.conflicts) {
    await showConflicts();
    return;
  }

  if (opts.quick) {
    await showQuick();
    return;
  }

  await showPending();
}

// ============================================================
// --review: Show pending queue items
// ============================================================

async function showPending(): Promise<void> {
  const items = await sql`
    SELECT id, atom_content, atom_type, score, score_components, temporality,
           source_type, source_title, is_contradiction, provenance_status,
           nearest_node_addr, nearest_similarity, created_at
    FROM intake_queue
    WHERE review_status = 'pending'
    ORDER BY is_contradiction DESC, score DESC
    LIMIT 25`;

  if (items.length === 0) {
    console.log("Queue is empty. Nothing to review.");
    return;
  }

  const [total] = await sql`SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending'`;

  console.log(`Pending queue: ${total.cnt} items (showing top ${items.length})\n`);
  console.log("ID    Score  Type       Flags       Source    Content");
  console.log("─".repeat(100));

  for (const item of items) {
    const flags = [
      item.is_contradiction ? "CONTRA" : null,
      item.provenance_status === "unverified" ? "UNVER" : null,
    ].filter(Boolean).join(",") || "—";

    console.log(
      `${String(item.id).padEnd(6)}${String(item.score).padEnd(7)}${item.atom_type.padEnd(11)}${flags.padEnd(12)}${item.source_type.padEnd(10)}${item.atom_content.slice(0, 55)}`
    );
  }

  console.log(`\nUse --promote <id> to move to staging_nodes, --demote <id> to move to stimuli`);
}

// ============================================================
// --review --quick: Top 10 non-contradictions
// ============================================================

async function showQuick(): Promise<void> {
  const items = await sql`
    SELECT id, atom_content, atom_type, score, source_type, temporality
    FROM intake_queue
    WHERE review_status = 'pending' AND is_contradiction = false
    ORDER BY score DESC
    LIMIT 10`;

  if (items.length === 0) {
    console.log("No non-contradiction items in queue.");
    return;
  }

  console.log(`Quick review: Top ${items.length} by score\n`);
  console.log("ID    Score  Type       Source    Content");
  console.log("─".repeat(90));

  for (const item of items) {
    console.log(
      `${String(item.id).padEnd(6)}${String(item.score).padEnd(7)}${item.atom_type.padEnd(11)}${item.source_type.padEnd(10)}${item.atom_content.slice(0, 55)}`
    );
  }
}

// ============================================================
// --promote <id>: Move queue item → staging_nodes
// ============================================================

async function promote(id: number): Promise<void> {
  const [item] = await sql`
    SELECT * FROM intake_queue WHERE id = ${id} AND review_status = 'pending'`;

  if (!item) {
    console.error(`Queue item ${id} not found or already reviewed.`);
    process.exit(1);
  }

  if (item.temporality !== "DURABLE") {
    console.error(`Queue item ${id} is ${item.temporality}. Current/ephemeral atoms must be demoted into stimuli, not promoted into durable nodes.`);
    process.exit(1);
  }

  const nodeType = ATOM_TO_NODE_TYPE[item.atom_type as AtomType] || "concept";
  const ontologyTarget = await resolveDurableOntologyTarget(sql, {
    content: item.atom_content,
    sourceType: item.source_type,
    sourceTitle: item.source_title,
    sourceId: item.source_id,
    nodeType,
    atomType: item.atom_type,
  });
  const label = item.atom_content.slice(0, 80);

  const substance = {
    description: item.atom_content,
    node_type: nodeType,
    vi_atom_type: item.atom_type,
    vi_temporality: item.temporality,
    vi_score: item.score,
  };

  const sourceContext = {
    vi_batch_id: item.ingest_batch_id,
    vi_source_type: item.source_type,
    vi_score: item.score,
    vi_score_components: item.score_components,
    vi_classifier_version: CLASSIFIER_VERSION,
    vi_promoted_from_queue: true,
    ontology_target: {
      pyramid_id: ontologyTarget.pyramidId,
      parent_addr: ontologyTarget.parentAddr,
      parent_label: ontologyTarget.parentLabel,
      reason: ontologyTarget.selectionReason,
      keyword_score: ontologyTarget.keywordScore,
    },
  };

  // F6: allocation + staging INSERT + intake_queue update share the
  // transaction-scoped advisory lock so concurrent promotions cannot
  // collide on addr.
  const slotAddr = await withAllocatedChildSlot(
    sql,
    ontologyTarget.pyramidId,
    ontologyTarget.parentAddr,
    async (tx, slot) => {
      await tx`INSERT INTO staging_nodes (
        run_id, addr, pyramid_id, layer, depth, position, label,
        substance, confidence, parent_addr, visibility, qc_status, qc_agent, source_context
      ) VALUES (
        ${item.ingest_batch_id}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position},
        ${label}, ${tx.json(substance)},
        0.55, ${ontologyTarget.parentAddr}, 'public', 'pending', 'verity-ingest',
        ${tx.json(sourceContext)}
      )`;
      await tx`UPDATE intake_queue SET review_status = 'promoted', reviewed_at = now() WHERE id = ${id}`;
      return slot.addr;
    },
  );

  console.log(`Promoted queue item ${id} → ${slotAddr} "${label}"`);
}

// ============================================================
// --demote <id>: Move queue item → stimuli
// ============================================================

async function demote(id: number): Promise<void> {
  const params = await loadParams();
  const [item] = await sql`
    SELECT * FROM intake_queue WHERE id = ${id} AND review_status = 'pending'`;

  if (!item) {
    console.error(`Queue item ${id} not found or already reviewed.`);
    process.exit(1);
  }

  const stimType = ATOM_TO_STIMULUS_TYPE[item.atom_type as AtomType] || "news_article";
  const temporality = item.temporality as Temporality;
  const halflife = 24 * (TEMPORALITY_MULTIPLIER[temporality] || 1.0);
  const sourceStr = `vi:${item.source_type}`;
  const sourceIdStr = `vi:${item.ingest_batch_id}:demoted:${id}`;
  const isOrphan = !item.nearest_node_addr || parseFloat(item.nearest_similarity || 0) < params.orphan_similarity_threshold;

  // Use stored embedding
  const embeddingStr = item.embedding;

  // F11: VI review demotion — background path, correlation_id NULL.
  const [inserted] = await sql`
    INSERT INTO stimuli (
      source, source_id, stimulus_type, urgency, content, embedding,
      decay_halflife_hours, peak_delay_hours, node_addr, similarity, energy,
      is_orphan, orphan_status, ingest_batch_id, temporality, correlation_id, space_id
    )
    VALUES (
      ${sourceStr}, ${sourceIdStr}, ${stimType}, 0.5, ${item.atom_content}, ${embeddingStr},
      ${halflife}, 0, ${isOrphan ? null : item.nearest_node_addr}, ${isOrphan ? null : item.nearest_similarity}, 1.0,
      ${isOrphan}, ${isOrphan ? "throbbing" : null}, ${item.ingest_batch_id}, ${temporality}, NULL, 'global'
    )
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING id`;

  if (inserted?.id && isOrphan) {
    await attachOrphanToTrendPool(inserted.id);
  }

  await sql`UPDATE intake_queue SET review_status = 'demoted', reviewed_at = now() WHERE id = ${id}`;

  console.log(`Demoted queue item ${id} → stimuli (type: ${stimType}, halflife: ${halflife}h${isOrphan ? ", orphan" : ""})`);
}

// ============================================================
// --conflicts: Show pending contradictions
// ============================================================

async function showConflicts(): Promise<void> {
  const items = await sql`
    SELECT q.id, q.atom_content, q.atom_type, q.score, q.source_type,
           q.nearest_node_addr, q.nearest_similarity,
           n.label as node_label, n.substance->>'description' as node_description
    FROM intake_queue q
    LEFT JOIN nodes n ON n.addr = q.nearest_node_addr
    WHERE q.review_status = 'pending' AND q.is_contradiction = true
    ORDER BY q.score DESC`;

  if (items.length === 0) {
    console.log("No pending contradictions.");
    return;
  }

  console.log(`Pending contradictions: ${items.length}\n`);

  for (const item of items) {
    console.log(`─── Queue #${item.id} (score: ${item.score}) ───`);
    console.log(`  NEW ATOM: ${item.atom_content}`);
    console.log(`  VS NODE:  ${item.nearest_node_addr} "${item.node_label}"`);
    console.log(`            ${(item.node_description || "").slice(0, 100)}`);
    console.log(`  Similarity: ${item.nearest_similarity} | Source: ${item.source_type}`);
    console.log(`  → --promote ${item.id} (keep atom) or --demote ${item.id} (discard to stimulus)`);
    console.log();
  }
}
