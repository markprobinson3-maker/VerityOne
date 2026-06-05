/**
 * World Ingestor V2 — Orphan Heat Convergence.
 *
 * Scans throbbing orphan stimuli for embedding clusters. When enough orphans
 * converge in the same region of embedding space, we detect an emergent concept
 * and optionally auto-promote it to a new graph node.
 *
 * Lifecycle: detected → promoted | dismissed | decayed
 */

import { sql, loadParams, type WIParams } from "./config";
import { slugifyLabel } from "@verity-one/graph-shape";
import { resolveDurableOntologyTarget, withAllocatedChildSlot } from "../../../api/src/lib/ontology";
import { callFlashLite } from "../lib/llm";
import { emitWI } from "./events";
import { embedBatch, toVectorStr } from "@verity-one/embed";

// ============================================================
// COSINE SIMILARITY
// ============================================================

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// DISCORD NOTIFICATION
// ============================================================

async function postDiscord(message: string): Promise<void> {
  try {
    const [row] = await sql`SELECT value FROM graph_state WHERE key = 'wi_discord_webhook'`;
    const webhook = row?.value;
    if (!webhook) {
      console.log("[WI Convergence]", message);
      return;
    }
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (err: any) {
    console.error(`[WI Convergence] Discord post failed: ${err.message}`);
  }
}

// ============================================================
// PARSE EMBEDDING — halfvec string → number[]
// ============================================================

function parseEmbedding(raw: string): number[] {
  // Format: [0.1,0.2,...] or similar
  return raw.replace(/[\[\]]/g, "").split(",").map(Number);
}

// ============================================================
// UNION-FIND for clustering
// ============================================================

class UnionFind {
  parent: number[];
  rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }

  clusters(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }
    return groups;
  }
}

// ============================================================
// ORPHAN STIMULUS TYPE
// ============================================================

interface OrphanStimulus {
  id: number;
  content: string;
  embedding: number[];
  energy: number;
  decay_halflife_hours: number;
  created_at: Date;
  source: string;
  currentEnergy: number;
}

// ============================================================
// 1. SCAN ORPHANS — find throbbing orphan clusters
// ============================================================

async function scanOrphans(params: WIParams): Promise<Array<{ orphans: OrphanStimulus[]; totalEnergy: number }>> {
  const rows = await sql`
    SELECT id, content, embedding::text, energy, decay_halflife_hours, created_at, source
    FROM stimuli
    WHERE is_orphan = true AND orphan_status = 'throbbing'
  `;

  if (rows.length === 0) return [];

  // Parse embeddings and compute current energy
  const orphans: OrphanStimulus[] = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    const embedding = parseEmbedding(row.embedding);
    const hoursSince = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
    const currentEnergy = row.energy * Math.pow(0.5, hoursSince / row.decay_halflife_hours);
    if (currentEnergy < 0.1) continue; // Decayed — skip
    orphans.push({
      id: row.id,
      content: row.content,
      embedding,
      energy: row.energy,
      decay_halflife_hours: row.decay_halflife_hours,
      created_at: new Date(row.created_at),
      source: row.source,
      currentEnergy,
    });
  }

  if (orphans.length < params.convergenceMinOrphans) return [];

  // Pairwise cosine → adjacency at > 0.80
  const uf = new UnionFind(orphans.length);
  for (let i = 0; i < orphans.length; i++) {
    for (let j = i + 1; j < orphans.length; j++) {
      if (cosine(orphans[i].embedding, orphans[j].embedding) > 0.80) {
        uf.union(i, j);
      }
    }
  }

  // Build clusters meeting thresholds
  const clusters: Array<{ orphans: OrphanStimulus[]; totalEnergy: number }> = [];
  for (const [, indices] of uf.clusters()) {
    if (indices.length < params.convergenceMinOrphans) continue;
    const clusterOrphans = indices.map(i => orphans[i]);
    const totalEnergy = clusterOrphans.reduce((s, o) => s + o.currentEnergy, 0);
    if (totalEnergy < params.convergenceMinEnergy) continue;
    clusters.push({ orphans: clusterOrphans, totalEnergy });
  }

  return clusters;
}

// ============================================================
// 2. CREATE CONVERGENCE EVENT — for qualifying clusters
// ============================================================

async function createConvergenceEvent(
  cluster: { orphans: OrphanStimulus[]; totalEnergy: number },
): Promise<number | null> {
  // Compute centroid embedding (average)
  const dim = cluster.orphans[0].embedding.length;
  const centroid = new Array(dim).fill(0);
  for (const orphan of cluster.orphans) {
    for (let i = 0; i < dim; i++) centroid[i] += orphan.embedding[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= cluster.orphans.length;

  // Check for existing detected convergence event with similar centroid
  const existing = await sql`
    SELECT id, centroid_embedding::text, orphan_count, total_energy
    FROM wi_convergence_events
    WHERE status = 'detected'
  `;

  for (const evt of existing) {
    if (!evt.centroid_embedding) continue;
    const existingCentroid = parseEmbedding(evt.centroid_embedding);
    if (cosine(centroid, existingCentroid) > 0.85) {
      // Update existing event instead of creating new
      await sql`
        UPDATE wi_convergence_events SET
          orphan_count = ${cluster.orphans.length},
          total_energy = ${cluster.totalEnergy},
          updated_at = now()
        WHERE id = ${evt.id}
      `;
      console.log(`[WI Convergence] Updated existing event #${evt.id}: ${cluster.orphans.length} orphans, energy ${cluster.totalEnergy.toFixed(1)}`);
      return evt.id;
    }
  }

  // Gather sample content (top 3 by energy) and source types
  const sorted = [...cluster.orphans].sort((a, b) => b.currentEnergy - a.currentEnergy);
  const sampleContent = sorted.slice(0, 3).map(o => o.content);
  const sourceTypes = [...new Set(cluster.orphans.map(o => o.source.replace(/^wi:/, "")))];

  // Flash Lite call to name the emerging concept
  let proposedLabel = "Unknown convergence";
  let proposedDescription = "";
  try {
    const prompt = `These orphan knowledge fragments are clustering around a new topic that doesn't exist in the knowledge graph yet:

${sampleContent.map((c, i) => `${i + 1}. "${c}" (from ${sourceTypes[i] || "unknown"})`).join("\n")}

What concept or topic are these converging on?
Return JSON: { "label": "short name", "description": "one sentence" }`;

    const raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.2, maxTokens: 256 });
    const parsed = JSON.parse(raw.trim());
    proposedLabel = parsed.label || proposedLabel;
    proposedDescription = parsed.description || "";
  } catch (err: any) {
    console.warn(`[WI Convergence] Label generation failed: ${err.message}`);
  }

  // INSERT
  const centroidStr = toVectorStr(centroid);
  const [row] = await sql`
    INSERT INTO wi_convergence_events (
      centroid_embedding, orphan_count, total_energy, source_types, sample_content,
      proposed_label, proposed_description, status
    ) VALUES (
      ${centroidStr}::halfvec, ${cluster.orphans.length}, ${cluster.totalEnergy},
      ${sourceTypes}, ${sampleContent},
      ${proposedLabel}, ${proposedDescription}, 'detected'
    ) RETURNING id
  `;

  emitWI("convergence", "system", {
    event_id: row.id,
    label: proposedLabel,
    orphan_count: cluster.orphans.length,
    total_energy: cluster.totalEnergy,
    source_types: sourceTypes,
  });

  await postDiscord(`🌊 Convergence detected: "${proposedLabel}" — ${cluster.orphans.length} orphans from ${sourceTypes.join(", ")}, energy ${cluster.totalEnergy.toFixed(1)}`);

  console.log(`[WI Convergence] Created event #${row.id}: "${proposedLabel}" (${cluster.orphans.length} orphans, energy ${cluster.totalEnergy.toFixed(1)})`);
  return row.id;
}

// ============================================================
// 3. CHECK AUTO-PROMOTE — promote qualifying detected events
// ============================================================

async function checkAutoPromote(params: WIParams): Promise<number> {
  let promoted = 0;

  const events = await sql`
    SELECT id, centroid_embedding::text, proposed_label, proposed_description
    FROM wi_convergence_events
    WHERE status = 'detected'
  `;

  for (const evt of events) {
    if (!evt.centroid_embedding) continue;
    const centroid = parseEmbedding(evt.centroid_embedding);

    // Re-query orphans near centroid
    const orphanRows = await sql`
      SELECT id, content, embedding::text, energy, decay_halflife_hours, created_at, source
      FROM stimuli
      WHERE is_orphan = true AND orphan_status = 'throbbing'
    `;

    const nearOrphans: OrphanStimulus[] = [];
    for (const row of orphanRows) {
      if (!row.embedding) continue;
      const emb = parseEmbedding(row.embedding);
      if (cosine(centroid, emb) <= 0.80) continue;
      const hoursSince = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
      const currentEnergy = row.energy * Math.pow(0.5, hoursSince / row.decay_halflife_hours);
      if (currentEnergy < 0.1) continue;
      nearOrphans.push({
        id: row.id,
        content: row.content,
        embedding: emb,
        energy: row.energy,
        decay_halflife_hours: row.decay_halflife_hours,
        created_at: new Date(row.created_at),
        source: row.source,
        currentEnergy,
      });
    }

    const totalEnergy = nearOrphans.reduce((s, o) => s + o.currentEnergy, 0);
    const sourceTypes = [...new Set(nearOrphans.map(o => o.source.replace(/^wi:/, "")))];

    // Update counts
    await sql`
      UPDATE wi_convergence_events SET
        orphan_count = ${nearOrphans.length},
        total_energy = ${totalEnergy},
        source_types = ${sourceTypes},
        updated_at = now()
      WHERE id = ${evt.id}
    `;

    // Check auto-promote thresholds
    if (
      nearOrphans.length >= params.convergenceAutoPromoteOrphans &&
      totalEnergy >= params.convergenceAutoPromoteEnergy &&
      sourceTypes.length >= params.convergenceAutoPromoteSources
    ) {
      await promoteEvent(evt.id, evt.proposed_label, evt.proposed_description, nearOrphans);
      promoted++;
    }
  }

  return promoted;
}

// ============================================================
// 4. PROMOTE EVENT — create node from convergence
// ============================================================

async function promoteEvent(
  eventId: number, label: string, description: string, orphans: OrphanStimulus[],
): Promise<string> {
  const ontologyTarget = await resolveDurableOntologyTarget(sql, {
    content: `${label}\n${description}`,
    sourceType: "web",
    nodeType: "workflow",
    actionability: 3,
  });
  // Compute centroid embedding for the new node
  const dim = orphans[0].embedding.length;
  const centroid = new Array(dim).fill(0);
  for (const o of orphans) {
    for (let i = 0; i < dim; i++) centroid[i] += o.embedding[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= orphans.length;

  // F6: allocation + staging INSERT under a single advisory lock with
  // PK-collision retry.
  const nextAddr = await withAllocatedChildSlot(
    sql,
    ontologyTarget.pyramidId,
    ontologyTarget.parentAddr,
    async (tx, slot) => {
      await tx`
        INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility, qc_status, qc_agent, source_context)
        VALUES (
          ${"convergence:" + eventId}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position},
          ${label.slice(0, 80)},
          ${tx.json({
            description,
            slug: slugifyLabel(label),
            domains: [],
            type: "KNOWLEDGE",
            subtype: "framework",
            node_type: "workflow",
            convergence_event_id: eventId,
          })},
          ${0.50},
          ${ontologyTarget.parentAddr}, 'private', 'pending', 'convergence',
          ${tx.json({
            convergence_event_id: eventId,
            orphan_count: orphans.length,
            source_types: [...new Set(orphans.map(o => o.source))],
            ontology_target: {
              pyramid_id: ontologyTarget.pyramidId,
              parent_addr: ontologyTarget.parentAddr,
              parent_label: ontologyTarget.parentLabel,
              reason: ontologyTarget.selectionReason,
              keyword_score: ontologyTarget.keywordScore,
            },
          })}
        )
      `;
      return slot.addr;
    },
  );

  // Update orphan stimuli — re-attach to new node
  const orphanIds = orphans.map(o => o.id);
  await sql`
    UPDATE stimuli SET
      node_addr = ${nextAddr},
      is_orphan = false,
      orphan_status = 'promoted'
    WHERE id = ANY(${orphanIds})
  `;

  // Update convergence event
  await sql`
    UPDATE wi_convergence_events SET
      status = 'promoted',
      promoted_node_addr = ${nextAddr},
      updated_at = now()
    WHERE id = ${eventId}
  `;

  emitWI("convergence", "system", {
    event_id: eventId,
    action: "promoted",
    node_addr: nextAddr,
    label,
  });

  await postDiscord(`🌊 Auto-promoted: "${label}" → ${nextAddr} (${orphans.length} orphans)`);

  console.log(`[WI Convergence] Promoted event #${eventId} → ${nextAddr}: "${label}"`);
  return nextAddr;
}

// ============================================================
// 5. DECAY CONVERGENCE EVENTS — close dead events
// ============================================================

async function decayConvergenceEvents(): Promise<number> {
  let decayed = 0;

  const events = await sql`
    SELECT id, centroid_embedding::text
    FROM wi_convergence_events
    WHERE status = 'detected'
  `;

  for (const evt of events) {
    if (!evt.centroid_embedding) continue;
    const centroid = parseEmbedding(evt.centroid_embedding);

    // Re-query orphans near centroid
    const orphanRows = await sql`
      SELECT energy, decay_halflife_hours, created_at, embedding::text
      FROM stimuli
      WHERE is_orphan = true AND orphan_status = 'throbbing'
    `;

    let anyAlive = false;
    for (const row of orphanRows) {
      if (!row.embedding) continue;
      const emb = parseEmbedding(row.embedding);
      if (cosine(centroid, emb) <= 0.80) continue;
      const hoursSince = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
      const currentEnergy = row.energy * Math.pow(0.5, hoursSince / row.decay_halflife_hours);
      if (currentEnergy >= 0.1) {
        anyAlive = true;
        break;
      }
    }

    if (!anyAlive) {
      await sql`
        UPDATE wi_convergence_events SET status = 'decayed', updated_at = now()
        WHERE id = ${evt.id}
      `;
      decayed++;
    }
  }

  return decayed;
}

// ============================================================
// 6. MANUAL DISMISS / PROMOTE
// ============================================================

export async function dismissConvergence(id: number): Promise<void> {
  await sql`
    UPDATE wi_convergence_events SET status = 'dismissed', updated_at = now()
    WHERE id = ${id} AND status = 'detected'
  `;
}

export async function promoteConvergence(id: number): Promise<string | null> {
  const [evt] = await sql`
    SELECT id, centroid_embedding::text, proposed_label, proposed_description
    FROM wi_convergence_events
    WHERE id = ${id} AND status = 'detected'
  `;
  if (!evt) return null;

  const centroid = parseEmbedding(evt.centroid_embedding);

  // Gather orphans near centroid
  const orphanRows = await sql`
    SELECT id, content, embedding::text, energy, decay_halflife_hours, created_at, source
    FROM stimuli
    WHERE is_orphan = true AND orphan_status = 'throbbing'
  `;

  const nearOrphans: OrphanStimulus[] = [];
  for (const row of orphanRows) {
    if (!row.embedding) continue;
    const emb = parseEmbedding(row.embedding);
    if (cosine(centroid, emb) <= 0.80) continue;
    const hoursSince = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
    const currentEnergy = row.energy * Math.pow(0.5, hoursSince / row.decay_halflife_hours);
    nearOrphans.push({
      id: row.id,
      content: row.content,
      embedding: emb,
      energy: row.energy,
      decay_halflife_hours: row.decay_halflife_hours,
      created_at: new Date(row.created_at),
      source: row.source,
      currentEnergy,
    });
  }

  if (nearOrphans.length === 0) return null;

  return promoteEvent(id, evt.proposed_label, evt.proposed_description || "", nearOrphans);
}

// ============================================================
// 7. ORCHESTRATOR — called by cron
// ============================================================

export async function runConvergenceScan(): Promise<{ detected: number; promoted: number; decayed: number }> {
  const params = await loadParams();
  let detected = 0;

  // Scan orphan clusters
  const clusters = await scanOrphans(params);
  for (const cluster of clusters) {
    const eventId = await createConvergenceEvent(cluster);
    if (eventId) detected++;
  }

  // Check auto-promote on all detected events
  const promoted = await checkAutoPromote(params);

  // Decay dead events
  const decayed = await decayConvergenceEvents();

  return { detected, promoted, decayed };
}
