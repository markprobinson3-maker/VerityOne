/**
 * Verity Ingest — Observability
 *
 * --stats, --stats --today, --stats --cost, --stats --sources, --queue
 */

import { sql } from "./config";
import { loadParams } from "./config";

// ============================================================
// --stats
// ============================================================

export async function handleStats(sub: "full" | "today" | "cost" | "sources"): Promise<void> {
  switch (sub) {
    case "today": return showToday();
    case "cost": return showCost();
    case "sources": return showSources();
    default: return showFull();
  }
}

async function showFull(): Promise<void> {
  const [totals] = await sql`
    SELECT
      COUNT(*) as total_batches,
      COALESCE(SUM(atom_count), 0) as total_atoms,
      COALESCE(SUM(on_count), 0) as total_on,
      COALESCE(SUM(in_count), 0) as total_in,
      COALESCE(SUM(queue_count), 0) as total_queue,
      COALESCE(SUM(cost_usd), 0) as total_cost
    FROM source_history WHERE rolled_back = false`;

  const [queueDepth] = await sql`
    SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending'`;

  const [staging] = await sql`
    SELECT COUNT(*) as cnt FROM staging_nodes
    WHERE source_context->>'vi_batch_id' IS NOT NULL AND qc_status = 'pending'`;

  const [trendStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE node_type = 'trend') as live_trends,
      COUNT(*) FILTER (
        WHERE node_type = 'trend'
          AND COALESCE(source_context->'trend'->>'lifecycle', 'emerging') = 'emerging'
      ) as emerging_trends
    FROM nodes`;

  const [protoClusters] = await sql`SELECT COUNT(*) as cnt FROM wi_proto_clusters`;

  // Daily averages (last 7 days)
  const [daily] = await sql`
    SELECT
      COALESCE(AVG(atom_count), 0) as avg_atoms,
      COALESCE(AVG(cost_usd), 0) as avg_cost
    FROM source_history
    WHERE rolled_back = false AND ingested_at > now() - INTERVAL '7 days'`;

  console.log("═══ Verity Ingest Stats ═══\n");
  console.log(`Total batches:       ${totals.total_batches}`);
  console.log(`Total atoms:         ${totals.total_atoms}`);
  console.log(`  AUTO_ON:           ${totals.total_on}`);
  console.log(`  AUTO_IN:           ${totals.total_in}`);
  console.log(`  QUEUE:             ${totals.total_queue}`);
  console.log(`Total cost:          $${parseFloat(totals.total_cost).toFixed(4)}`);
  console.log(`Queue depth:         ${queueDepth.cnt}`);
  console.log(`Pending staging:     ${staging.cnt}`);
  console.log(`Live trends:         ${trendStats.live_trends} (${trendStats.emerging_trends} emerging)`);
  console.log(`Proto-clusters:      ${protoClusters.cnt}`);
  console.log(`\n7-day daily avg:`);
  console.log(`  Atoms/day:         ${parseFloat(daily.avg_atoms).toFixed(1)}`);
  console.log(`  Cost/day:          $${parseFloat(daily.avg_cost).toFixed(4)}`);

  if (parseInt(totals.total_atoms) > 0) {
    const onRatio = (parseInt(totals.total_on) / parseInt(totals.total_atoms) * 100).toFixed(1);
    const inRatio = (parseInt(totals.total_in) / parseInt(totals.total_atoms) * 100).toFixed(1);
    const queueRatio = (parseInt(totals.total_queue) / parseInt(totals.total_atoms) * 100).toFixed(1);
    console.log(`\nClassification ratios:`);
    console.log(`  AUTO_ON:  ${onRatio}%`);
    console.log(`  AUTO_IN:  ${inRatio}%`);
    console.log(`  QUEUE:    ${queueRatio}%`);
  }
}

async function showToday(): Promise<void> {
  const [today] = await sql`
    SELECT
      COUNT(*) as batches,
      COALESCE(SUM(atom_count), 0) as atoms,
      COALESCE(SUM(on_count), 0) as on_count,
      COALESCE(SUM(in_count), 0) as in_count,
      COALESCE(SUM(queue_count), 0) as queue_count,
      COALESCE(SUM(cost_usd), 0) as cost
    FROM source_history
    WHERE rolled_back = false AND ingested_at::date = CURRENT_DATE`;

  console.log("═══ Today's Activity ═══\n");
  console.log(`Batches:   ${today.batches}`);
  console.log(`Atoms:     ${today.atoms}`);
  console.log(`  ON:      ${today.on_count}`);
  console.log(`  IN:      ${today.in_count}`);
  console.log(`  QUEUE:   ${today.queue_count}`);
  console.log(`Cost:      $${parseFloat(today.cost).toFixed(4)}`);
}

async function showCost(): Promise<void> {
  const rows = await sql`
    SELECT source_type,
      COUNT(*) as batches,
      COALESCE(SUM(atom_count), 0) as atoms,
      COALESCE(SUM(cost_usd), 0) as cost,
      CASE WHEN SUM(atom_count) > 0 THEN SUM(cost_usd) / SUM(atom_count) ELSE 0 END as cost_per_atom
    FROM source_history
    WHERE rolled_back = false
    GROUP BY source_type
    ORDER BY cost DESC`;

  console.log("═══ Cost Breakdown ═══\n");
  console.log("Source       Batches  Atoms   Cost       $/atom");
  console.log("─".repeat(55));

  for (const r of rows) {
    console.log(
      `${r.source_type.padEnd(13)}${String(r.batches).padEnd(9)}${String(r.atoms).padEnd(8)}$${parseFloat(r.cost).toFixed(4).padEnd(10)}$${parseFloat(r.cost_per_atom).toFixed(6)}`
    );
  }

  const [total] = await sql`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM source_history WHERE rolled_back = false`;
  console.log(`${"─".repeat(55)}`);
  console.log(`${"Total".padEnd(22)}$${parseFloat(total.total).toFixed(4)}`);
}

async function showSources(): Promise<void> {
  const rows = await sql`
    SELECT
      sh.source_type,
      COUNT(*) as batches,
      COALESCE(SUM(sh.atom_count), 0) as total_atoms,
      COALESCE(SUM(sh.on_count), 0) as on_count,
      CASE WHEN SUM(sh.atom_count) > 0
        THEN ROUND(SUM(sh.on_count)::numeric / SUM(sh.atom_count) * 100, 1)
        ELSE 0 END as on_ratio
    FROM source_history sh
    WHERE sh.rolled_back = false
    GROUP BY sh.source_type
    ORDER BY total_atoms DESC`;

  console.log("═══ Per-Source Quality ═══\n");
  console.log("Source       Batches  Atoms   ON    ON%");
  console.log("─".repeat(50));

  for (const r of rows) {
    console.log(
      `${r.source_type.padEnd(13)}${String(r.batches).padEnd(9)}${String(r.total_atoms).padEnd(8)}${String(r.on_count).padEnd(6)}${r.on_ratio}%`
    );
  }
}

// ============================================================
// --queue
// ============================================================

export async function handleQueue(): Promise<void> {
  const params = await loadParams();

  const [pending] = await sql`
    SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending'`;
  const [contradictions] = await sql`
    SELECT COUNT(*) as cnt FROM intake_queue WHERE review_status = 'pending' AND is_contradiction = true`;
  const [oldest] = await sql`
    SELECT created_at FROM intake_queue WHERE review_status = 'pending' ORDER BY created_at LIMIT 1`;

  const depth = parseInt(pending.cnt);
  const contraCount = parseInt(contradictions.cnt);
  const capacity = (depth / params.queue_cap * 100).toFixed(1);

  console.log("═══ Queue Health ═══\n");
  console.log(`Depth:           ${depth} / ${params.queue_cap} (${capacity}%)`);
  console.log(`Contradictions:  ${contraCount} / ${params.contradiction_cap}`);
  console.log(`Oldest pending:  ${oldest ? oldest.created_at : "—"}`);
  console.log(`Learning mode:   ${params.learning_mode ? "ON" : "OFF"}`);

  if (depth > params.queue_cap * 0.8) {
    console.log(`\n⚠ Queue at ${capacity}% capacity — consider reviewing items`);
  }
  if (contraCount > params.contradiction_cap * 0.8) {
    console.log(`⚠ Contradiction queue at ${Math.round(contraCount / params.contradiction_cap * 100)}% — back-pressure may trigger`);
  }

  // Stimulus lifecycle stats
  const [stimStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'throbbing') as throbbing_orphans,
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'promoted') as promoted_orphans,
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'dissolved') as dissolved_orphans,
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'adopted') as adopted_orphans,
      COUNT(*) FILTER (WHERE parent_stimulus_id IS NOT NULL) as droplets,
      COUNT(*) FILTER (WHERE node_addr IS NOT NULL AND parent_stimulus_id IS NULL AND NOT is_orphan) as single_orbits,
      COUNT(*) FILTER (WHERE ingest_batch_id IS NOT NULL) as vi_stimuli
    FROM stimuli`;

  if (parseInt(stimStats.vi_stimuli) > 0) {
    console.log(`\n═══ Stimulus Lifecycle ═══\n`);
    console.log(`VI stimuli total:  ${stimStats.vi_stimuli}`);
    console.log(`  🌙 Single orbit: ${stimStats.single_orbits}`);
    console.log(`  💧 Droplets:     ${stimStats.droplets}`);
    console.log(`  ◉ Throbbing:     ${stimStats.throbbing_orphans}`);
    console.log(`  ✅ Promoted:     ${stimStats.promoted_orphans}`);
    console.log(`  🏠 Adopted:      ${stimStats.adopted_orphans}`);
    console.log(`  💨 Dissolved:    ${stimStats.dissolved_orphans}`);
  }
}
