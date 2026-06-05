/**
 * World Ingestor V2 — Stage 3: ENRICH
 * Pool atoms, enrich with Flash Lite (graph context + edge suggestions + heat),
 * then release to ROUTE with richer metadata.
 */

import { sql, loadParams, type ExtractedAtom, type EnrichedAtom, type EnrichmentData } from "./config";
import { embedBatch, toVectorStr } from "@verity-one/embed";
import { callFlashLite } from "../lib/llm";
import { emitWI } from "./events";
import { routeEnrichedAtoms } from "./route";

// ============================================================
// ENRICHMENT PROMPT
// ============================================================

function buildEnrichmentPrompt(atomsWithContext: string): string {
  return `You are enriching knowledge atoms before they enter a knowledge graph.
For each atom, you have: its raw content, type, temporality, and the
top-5 nearest existing nodes in the graph.

For each atom, provide:

1. enriched_content: Rewrite the atom to be more precise and self-contained.
   Fix ambiguity, add specificity, make it optimally embeddable.
   Keep it under 200 words.

2. edge_suggestions: Array of relationships to existing nodes:
   [{ "target_addr": "PJ.0.2.12", "edge_type": "supports|tensions|extends|prerequisite|example_of", "reason": "one sentence" }]
   Only suggest edges to nodes listed in the context. Empty array if none fit.

3. priority: 0.0-1.0 score. Consider:
   - How novel is this vs existing graph? (novel = high priority)
   - How actionable? (skills > knowledge)
   - How durable? (durable > ephemeral)
   - How many existing nodes does it connect to? (connected = high value)

4. heat_signature: {
     "primary_domain": "most relevant domain",
     "intensity": 0.0-1.0 (how much energy this carries),
     "decay_class": "slow|medium|fast" (override if temporality alone is wrong)
   }

5. batch_relationships: If multiple atoms in this batch relate to each other:
   [{ "related_atom_index": 3, "relationship": "prerequisite|builds_on|contradicts|example_of" }]
   Empty array if none relate.

${atomsWithContext}

Return JSON array matching atom indices. Each element: { "index": N, "enriched_content": "...", "edge_suggestions": [...], "priority": 0.X, "heat_signature": {...}, "batch_relationships": [...] }`;
}

// ============================================================
// POOL ATOMS — insert extracted atoms into wi_atom_pool
// ============================================================

export async function poolAtoms(
  atoms: ExtractedAtom[],
  runId: string,
  sourceUrl: string,
  sourceType: string,
): Promise<string[]> {
  const params = await loadParams();
  const poolIds: string[] = [];

  for (const atom of atoms) {
    const [row] = await sql`
      INSERT INTO wi_atom_pool (
        run_id, source_url, source_type,
        content, type, subtype, domains,
        importance, actionability, temporality
      ) VALUES (
        ${runId}, ${sourceUrl}, ${sourceType},
        ${atom.content}, ${atom.type}, ${atom.subtype || null}, ${atom.domains || []},
        ${atom.importance}, ${atom.actionability}, ${atom.temporality || null}
      )
      RETURNING id
    `;
    poolIds.push(row.id);
    emitWI("atom_pooled", runId, { pool_id: row.id, type: atom.type, temporality: atom.temporality });
  }

  // Check pool depth alert
  const [depth] = await sql`SELECT COUNT(*) AS n FROM wi_atom_pool WHERE status = 'pending'`;
  if (parseInt(depth.n) > params.enrichmentPoolAlertDepth) {
    console.warn(`[WI] Enrichment pool backlog: ${depth.n} atoms pending (alert threshold: ${params.enrichmentPoolAlertDepth})`);
  }

  return poolIds;
}

// ============================================================
// ENRICH BATCH — grab pending atoms from pool, enrich via Flash Lite
// ============================================================

export async function enrichBatch(batchAtoms?: any[]): Promise<{ enriched: number; failed: number }> {
  const params = await loadParams();

  // Grab batch from pool if not provided
  if (!batchAtoms) {
    // Claim atoms atomically
    batchAtoms = await sql`
      UPDATE wi_atom_pool SET status = 'enriching'
      WHERE id IN (
        SELECT id FROM wi_atom_pool
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT ${params.enrichmentBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
  }

  if (batchAtoms.length === 0) return { enriched: 0, failed: 0 };

  let enriched = 0, failed = 0;

  try {
    // Embed raw content
    const texts = batchAtoms.map((a: any) => a.content);
    const embeddings = await embedBatch(texts);

    // Check if graph has nodes
    const [nodeCount] = await sql`SELECT COUNT(*) AS n FROM nodes WHERE embedding_hv IS NOT NULL`;
    const hasNodes = parseInt(nodeCount.n) > 0;

    // Fetch top-5 nearest nodes per atom
    const contextPerAtom: string[] = [];
    for (let i = 0; i < batchAtoms.length; i++) {
      const atom = batchAtoms[i];
      emitWI("atom_enriching", atom.run_id, { pool_id: atom.id, index: i });

      if (hasNodes && embeddings[i]) {
        const vecStr = toVectorStr(embeddings[i]);
        const neighbors = await sql`
          SELECT addr, label, 1 - (embedding_hv <=> ${vecStr}::halfvec) AS similarity
          FROM nodes WHERE embedding_hv IS NOT NULL
          ORDER BY embedding_hv <=> ${vecStr}::halfvec
          LIMIT 5
        `;
        const neighborStr = neighbors.map((n: any) =>
          `    - ${n.addr} "${n.label}" (sim: ${parseFloat(n.similarity).toFixed(3)})`
        ).join("\n");
        contextPerAtom.push(neighborStr || "    (no similar nodes)");
      } else {
        contextPerAtom.push("    (no graph context available)");
      }
    }

    // Build prompt
    const atomsWithContext = batchAtoms.map((atom: any, i: number) => {
      return `[${i}] ${atom.type} subtype=${atom.subtype || "?"} temporality=${atom.temporality || "DURABLE"} (importance=${atom.importance}, actionability=${atom.actionability})
Content: "${atom.content}"
Nearest nodes:
${contextPerAtom[i]}`;
    }).join("\n\n");

    const prompt = buildEnrichmentPrompt(`EXISTING GRAPH CONTEXT (per atom shown above)\n\nATOMS TO ENRICH:\n${atomsWithContext}`);

    // ONE Flash Lite call for the whole batch
    const raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 4096 });
    let results: any[];
    try {
      results = JSON.parse(raw.trim());
      if (!Array.isArray(results)) results = [results];
    } catch {
      console.warn("[WI] Enrichment JSON parse failed, marking batch for retry");
      // Reset to pending for retry
      for (const atom of batchAtoms) {
        await incrementRetryOrFail(atom);
      }
      return { enriched: 0, failed: batchAtoms.length };
    }

    // Write enrichment data back
    const resultMap = new Map<number, any>();
    for (const r of results) {
      if (typeof r?.index === "number") resultMap.set(r.index, r);
    }

    for (let i = 0; i < batchAtoms.length; i++) {
      const atom = batchAtoms[i];
      const result = resultMap.get(i);

      if (result?.enriched_content) {
        // Convert batch_relationships from index-based to id-based
        const batchRels = (result.batch_relationships || []).map((br: any) => ({
          related_atom_id: batchAtoms[br.related_atom_index]?.id || `index:${br.related_atom_index}`,
          relationship: br.relationship,
        }));

        await sql`
          UPDATE wi_atom_pool SET
            enriched_content = ${result.enriched_content},
            edge_suggestions = ${sql.json(result.edge_suggestions || [])},
            batch_relationships = ${sql.json(batchRels)},
            heat_signature = ${sql.json(result.heat_signature || { primary_domain: "general", intensity: 0.5, decay_class: "medium" })},
            enrichment_score = ${result.priority || 0.5},
            priority = ${result.priority || 0.5},
            status = 'enriched',
            enriched_at = now()
          WHERE id = ${atom.id}
        `;
        enriched++;
        emitWI("atom_enriched", atom.run_id, {
          pool_id: atom.id,
          enrichment_score: result.priority || 0.5,
          edge_count: (result.edge_suggestions || []).length,
        });
      } else {
        await incrementRetryOrFail(atom);
        failed++;
      }
    }
  } catch (err: any) {
    console.error(`[WI] Enrichment batch failed: ${err.message}`);
    // Reset all to pending for retry
    for (const atom of batchAtoms) {
      await incrementRetryOrFail(atom);
      failed++;
    }
  }

  return { enriched, failed };
}

async function incrementRetryOrFail(atom: any): Promise<void> {
  const retryCount = (atom.retry_count || 0) + 1;
  if (retryCount >= 3) {
    await sql`UPDATE wi_atom_pool SET status = 'failed', retry_count = ${retryCount} WHERE id = ${atom.id}`;
    console.warn(`[WI] Atom ${atom.id} failed after ${retryCount} retries`);
  } else {
    await sql`UPDATE wi_atom_pool SET status = 'pending', retry_count = ${retryCount} WHERE id = ${atom.id}`;
  }
}

// ============================================================
// ENRICH INLINE — same enrichment but immediate, no pool table
// ============================================================

export async function enrichInline(
  atoms: ExtractedAtom[],
  runId: string,
  sourceUrl: string,
  sourceType: string,
): Promise<EnrichedAtom[]> {
  if (atoms.length === 0) return [];

  try {
    // Embed raw content
    const texts = atoms.map(a => a.content);
    const embeddings = await embedBatch(texts);

    // Check if graph has nodes
    const [nodeCount] = await sql`SELECT COUNT(*) AS n FROM nodes WHERE embedding_hv IS NOT NULL`;
    const hasNodes = parseInt(nodeCount.n) > 0;

    // Fetch top-5 nearest nodes per atom
    const contextPerAtom: string[] = [];
    for (let i = 0; i < atoms.length; i++) {
      if (hasNodes && embeddings[i]) {
        const vecStr = toVectorStr(embeddings[i]);
        const neighbors = await sql`
          SELECT addr, label, 1 - (embedding_hv <=> ${vecStr}::halfvec) AS similarity
          FROM nodes WHERE embedding_hv IS NOT NULL
          ORDER BY embedding_hv <=> ${vecStr}::halfvec
          LIMIT 5
        `;
        const neighborStr = neighbors.map((n: any) =>
          `    - ${n.addr} "${n.label}" (sim: ${parseFloat(n.similarity).toFixed(3)})`
        ).join("\n");
        contextPerAtom.push(neighborStr || "    (no similar nodes)");
      } else {
        contextPerAtom.push("    (no graph context available)");
      }
    }

    // Build prompt
    const atomsWithContext = atoms.map((atom, i) => {
      return `[${i}] ${atom.type} subtype=${atom.subtype || "?"} temporality=${atom.temporality || "DURABLE"} (importance=${atom.importance}, actionability=${atom.actionability})
Content: "${atom.content}"
Nearest nodes:
${contextPerAtom[i]}`;
    }).join("\n\n");

    const prompt = buildEnrichmentPrompt(`EXISTING GRAPH CONTEXT (per atom shown above)\n\nATOMS TO ENRICH:\n${atomsWithContext}`);

    const raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 4096 });
    let results: any[];
    try {
      results = JSON.parse(raw.trim());
      if (!Array.isArray(results)) results = [results];
    } catch {
      console.warn("[WI] Inline enrichment JSON parse failed, passing atoms through unenriched");
      return atoms.map(a => ({ ...a, poolId: "inline" }));
    }

    const resultMap = new Map<number, any>();
    for (const r of results) {
      if (typeof r?.index === "number") resultMap.set(r.index, r);
    }

    return atoms.map((atom, i) => {
      const result = resultMap.get(i);
      if (result?.enriched_content) {
        const batchRels = (result.batch_relationships || []).map((br: any) => ({
          related_atom_id: `inline:${br.related_atom_index}`,
          relationship: br.relationship,
        }));

        const enrichment: EnrichmentData = {
          enrichedContent: result.enriched_content,
          edgeSuggestions: result.edge_suggestions || [],
          batchRelationships: batchRels,
          heatSignature: result.heat_signature || { primary_domain: "general", intensity: 0.5, decay_class: "medium" },
          enrichmentScore: result.priority || 0.5,
          priority: result.priority || 0.5,
        };

        return { ...atom, poolId: "inline", enrichment };
      }
      return { ...atom, poolId: "inline" };
    });
  } catch (err: any) {
    console.warn(`[WI] Inline enrichment failed (${err.message}), passing atoms through unenriched`);
    return atoms.map(a => ({ ...a, poolId: "inline" }));
  }
}

// ============================================================
// PROCESS POOL — full cron cycle
// ============================================================

export async function processPool(): Promise<{ enriched: number; routed: number; cleaned: number }> {
  // 1. Clean stale atoms
  const cleaned = await cleanStaleAtoms();

  // 2. Enrich pending batch
  const { enriched } = await enrichBatch();

  // 3. Route enriched atoms
  const routed = await releaseEnrichedAtoms();

  return { enriched, routed, cleaned };
}

async function releaseEnrichedAtoms(): Promise<number> {
  const enrichedRows = await sql`
    SELECT * FROM wi_atom_pool
    WHERE status = 'enriched'
    ORDER BY priority DESC, created_at ASC
    LIMIT 50
  `;

  if (enrichedRows.length === 0) return 0;

  try {
    await routeEnrichedAtoms(enrichedRows);

    // Mark as routed
    const ids = enrichedRows.map((r: any) => r.id);
    await sql`
      UPDATE wi_atom_pool SET status = 'routed', routed_at = now()
      WHERE id = ANY(${ids})
    `;

    return enrichedRows.length;
  } catch (err: any) {
    console.error(`[WI] Failed to route enriched atoms: ${err.message}`);
    return 0;
  }
}

// ============================================================
// CLEAN STALE ATOMS
// ============================================================

export async function cleanStaleAtoms(): Promise<number> {
  const params = await loadParams();

  // Delete stale EPHEMERAL pending atoms
  const ephemeralResult = await sql`
    DELETE FROM wi_atom_pool
    WHERE temporality = 'EPHEMERAL' AND status = 'pending'
      AND created_at < now() - make_interval(hours => ${params.enrichmentEphemeralTtlHours})
    RETURNING id, run_id
  `;

  for (const row of ephemeralResult) {
    emitWI("atom_pool_dropped", row.run_id, { pool_id: row.id, reason: "EPHEMERAL TTL expired" });
  }

  // Delete stale CURRENT pending atoms
  const currentResult = await sql`
    DELETE FROM wi_atom_pool
    WHERE temporality = 'CURRENT' AND status = 'pending'
      AND created_at < now() - make_interval(hours => ${params.enrichmentCurrentTtlHours})
    RETURNING id, run_id
  `;

  for (const row of currentResult) {
    emitWI("atom_pool_dropped", row.run_id, { pool_id: row.id, reason: "CURRENT TTL expired" });
  }

  const total = ephemeralResult.length + currentResult.length;
  if (total > 0) {
    console.log(`[WI] Cleaned ${total} stale atoms (${ephemeralResult.length} ephemeral, ${currentResult.length} current)`);
  }

  return total;
}

// ============================================================
// POOL STATUS — counts by status
// ============================================================

export async function poolStatus(): Promise<{
  pending: number;
  enriching: number;
  enriched: number;
  routed: number;
  failed: number;
  total: number;
}> {
  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'enriching') AS enriching,
      COUNT(*) FILTER (WHERE status = 'enriched') AS enriched,
      COUNT(*) FILTER (WHERE status = 'routed') AS routed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) AS total
    FROM wi_atom_pool
  `;

  return {
    pending: parseInt(counts.pending),
    enriching: parseInt(counts.enriching),
    enriched: parseInt(counts.enriched),
    routed: parseInt(counts.routed),
    failed: parseInt(counts.failed),
    total: parseInt(counts.total),
  };
}
