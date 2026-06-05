/**
 * Dialectic Scanner v1.0
 * 
 * Two-pass scanner: discovers both TENSION (disagreement) and 
 * INFERENCE (missing connections) in a single graph traversal.
 * 
 * Pass 1: Walk neighborhoods → find tensions via scanner_rules
 * Pass 2: Walk 2-hop chains → find inferences via composition matrix
 * Pass 3: Consistency check on new/modified tensions
 * 
 * All discoveries go to the unified proposals table.
 * Nothing is auto-applied — everything staged for review.
 * 
 * Usage:
 *   bun run miners/src/dialectic-scanner.ts              # full scan
 *   bun run miners/src/dialectic-scanner.ts --tensions    # pass 1 only
 *   bun run miners/src/dialectic-scanner.ts --inferences  # pass 2 only
 *   bun run miners/src/dialectic-scanner.ts --dry-run     # detect only, no writes
 */

import postgres from "postgres";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dir, "../../.env") });

const sql = postgres(process.env.DATABASE_URL || "postgresql://localhost:5432/verity");

const DRY_RUN = process.argv.includes("--dry-run");
const TENSIONS_ONLY = process.argv.includes("--tensions");
const INFERENCES_ONLY = process.argv.includes("--inferences");
const MAX_NEIGHBORS_PER_NODE = 50; // R7 condition: deterministic cap

interface ScannerRule {
  id: number;
  name: string;
  field_path: string;
  comparison: string;
  threshold: number | null;
  produces_tension_type: string;
  default_tension: number;
  same_pyramid_only: boolean;
  node_types: string[] | null;
}

interface CompositionRule {
  edge_type_1: string;
  edge_type_2: string;
  produces_type: string;
  min_confidence: number;
}

// ============================================================
// PASS 1: Tension Detection
// ============================================================

async function scanTensions(): Promise<{ found: number; created: number }> {
  console.log("[DIALECTIC] Pass 1: Tension scan...");

  // Load active scanner rules
  const rules: ScannerRule[] = await sql`
    SELECT * FROM scanner_rules WHERE enabled = true`;
  
  if (rules.length === 0) {
    console.log("[DIALECTIC] No scanner rules enabled, skipping tension scan");
    return { found: 0, created: 0 };
  }
  console.log(`[DIALECTIC] ${rules.length} scanner rules loaded`);

  // Fetch all edges with node substance (one query, used by all rules)
  const edges = await sql`
    SELECT e.from_addr, e.to_addr, e.edge_type, e.confidence AS edge_conf,
      n1.label AS from_label, n1.confidence AS from_conf, n1.pyramid_id AS from_pyramid,
      n1.visibility AS from_vis, n1.node_type AS from_type,
      n1.substance AS from_sub,
      n2.label AS to_label, n2.confidence AS to_conf, n2.pyramid_id AS to_pyramid,
      n2.visibility AS to_vis, n2.node_type AS to_type,
      n2.substance AS to_sub
    FROM edges e
    JOIN nodes n1 ON n1.addr = e.from_addr
    JOIN nodes n2 ON n2.addr = e.to_addr
    WHERE n1.visibility = 'public' AND n2.visibility = 'public'`;
  
  console.log(`[DIALECTIC] Scanning ${edges.length} edges...`);

  // Check existing tensions to avoid re-proposing
  const existingTensions = await sql`
    SELECT from_addr || '|' || to_addr || '|' || tension_type AS key
    FROM edge_tensions`;
  const existingSet = new Set(existingTensions.map((r: any) => r.key));

  // Check existing pending proposals
  const pendingProposals = await sql`
    SELECT from_addr || '|' || to_addr AS key
    FROM proposals WHERE proposal_type = 'tension' AND status = 'pending'`;
  const pendingSet = new Set(pendingProposals.map((r: any) => r.key));

  let found = 0;
  let created = 0;

  for (const edge of edges) {
    for (const rule of rules) {
      // Node type filter
      if (rule.node_types && rule.node_types.length > 0) {
        if (!rule.node_types.includes(edge.from_type) && !rule.node_types.includes(edge.to_type)) continue;
      }

      // Same-pyramid filter
      if (rule.same_pyramid_only && edge.from_pyramid !== edge.to_pyramid) continue;

      let tensionDetected = false;
      let evidence: any = {};

      switch (rule.comparison) {
        case 'exact_match': {
          const val1 = edge.from_sub?.[rule.field_path];
          const val2 = edge.to_sub?.[rule.field_path];
          if (val1 && val2 && val1 === val2 && edge.from_addr !== edge.to_addr) {
            tensionDetected = true;
            evidence = { field: rule.field_path, value: val1, rule: rule.name };
          }
          break;
        }
        case 'array_overlap': {
          const arr1 = edge.from_sub?.[rule.field_path];
          const arr2 = edge.to_sub?.[rule.field_path];
          if (Array.isArray(arr1) && Array.isArray(arr2)) {
            const overlap = arr1.filter((v: any) => arr2.includes(v));
            const overlapRatio = overlap.length / Math.max(arr1.length, arr2.length);
            if (overlap.length > 0 && (!rule.threshold || overlapRatio >= rule.threshold)) {
              tensionDetected = true;
              evidence = { field: rule.field_path, overlap, ratio: overlapRatio, rule: rule.name };
            }
          }
          break;
        }
        case 'confidence_gap': {
          const gap = Math.abs(edge.from_conf - edge.to_conf);
          if (gap >= (rule.threshold || 0.3)) {
            tensionDetected = true;
            evidence = { 
              field: 'confidence', gap: parseFloat(gap.toFixed(3)),
              from_conf: edge.from_conf, to_conf: edge.to_conf,
              rule: rule.name 
            };
          }
          break;
        }
        case 'semantic_distance': {
          // Deferred to v1.1 — requires embedding comparison
          break;
        }
      }

      if (tensionDetected) {
        found++;
        const key = `${edge.from_addr}|${edge.to_addr}|${rule.produces_tension_type}`;
        const proposalKey = `${edge.from_addr}|${edge.to_addr}`;

        // Skip if tension already exists or proposal pending
        if (existingSet.has(key) || pendingSet.has(proposalKey)) {
          continue;
        }

        // Determine visibility (R5 fix: strictest endpoint)
        const visibility = (edge.from_vis === 'private' || edge.to_vis === 'private') ? 'private' : 'public';

        if (!DRY_RUN) {
          await sql`
            INSERT INTO proposals (proposal_type, from_addr, to_addr, payload, confidence, discovered_by, evidence)
            VALUES (
              'tension', ${edge.from_addr}, ${edge.to_addr},
              ${sql.json({
                tension_type: rule.produces_tension_type,
                tension: rule.default_tension,
                visibility,
                from_label: edge.from_label,
                to_label: edge.to_label,
              })},
              ${rule.default_tension},
              'scanner',
              ${sql.json([{ type: 'scanner_rule', ...evidence, timestamp: new Date().toISOString() }])}
            )`;
          created++;
          pendingSet.add(proposalKey); // prevent duplicates within same run
        }

        console.log(`  ⚡ [${rule.produces_tension_type}] ${edge.from_label} ↔ ${edge.to_label} (${rule.name}, evidence: ${JSON.stringify(evidence).slice(0, 100)})`);
      }
    }
  }

  console.log(`[DIALECTIC] Pass 1 complete: ${found} tensions detected, ${created} proposals created`);
  return { found, created };
}

// ============================================================
// PASS 2: Inference Detection (Transitive Edges)
// ============================================================

async function scanInferences(): Promise<{ found: number; created: number }> {
  console.log("\n[DIALECTIC] Pass 2: Inference scan (transitive edges)...");

  // Load composition matrix
  const rules: CompositionRule[] = await sql`
    SELECT edge_type_1, edge_type_2, produces_type, min_confidence
    FROM edge_composition_rules WHERE enabled = true`;
  
  if (rules.length === 0) {
    console.log("[DIALECTIC] No composition rules enabled, skipping inference scan");
    return { found: 0, created: 0 };
  }
  console.log(`[DIALECTIC] ${rules.length} composition rules loaded`);

  // Build lookup map: (type1, type2) → rule
  const ruleMap = new Map<string, CompositionRule>();
  for (const r of rules) {
    ruleMap.set(`${r.edge_type_1}|${r.edge_type_2}`, r);
  }

  // Find 2-hop transitive chains where composition rules apply
  // This query walks A→B→C and checks if (A→B.type, B→C.type) is in the composition matrix
  const type1s = [...new Set(rules.map(r => r.edge_type_1))];
  const type2s = [...new Set(rules.map(r => r.edge_type_2))];
  
  const candidates = await sql`
    SELECT 
      e1.from_addr AS a_addr, e1.to_addr AS b_addr, e2.to_addr AS c_addr,
      e1.edge_type AS type_1, e2.edge_type AS type_2,
      e1.confidence AS conf_1, e2.confidence AS conf_2,
      n1.label AS a_label, n2.label AS b_label, n3.label AS c_label
    FROM edges e1
    JOIN edges e2 ON e2.from_addr = e1.to_addr
    JOIN nodes n1 ON n1.addr = e1.from_addr
    JOIN nodes n2 ON n2.addr = e1.to_addr
    JOIN nodes n3 ON n3.addr = e2.to_addr
    WHERE e1.from_addr != e2.to_addr
      AND e1.edge_type = ANY(${type1s})
      AND e2.edge_type = ANY(${type2s})
  `;

  console.log(`[DIALECTIC] Found ${candidates.length} 2-hop chain candidates`);

  // Check existing edges to avoid proposing what exists
  const existingEdges = await sql`
    SELECT from_addr || '|' || to_addr AS key FROM edges`;
  const existingEdgeSet = new Set(existingEdges.map((r: any) => r.key));

  // Check pending proposals
  const pendingInf = await sql`
    SELECT from_addr || '|' || to_addr AS key
    FROM proposals WHERE proposal_type = 'inference' AND status = 'pending'`;
  const pendingInfSet = new Set(pendingInf.map((r: any) => r.key));

  let found = 0;
  let created = 0;

  for (const c of candidates) {
    const ruleKey = `${c.type_1}|${c.type_2}`;
    const rule = ruleMap.get(ruleKey);
    if (!rule) continue;

    // Check confidence threshold
    if (c.conf_1 < rule.min_confidence || c.conf_2 < rule.min_confidence) continue;

    found++;
    const edgeKey = `${c.a_addr}|${c.c_addr}`;

    // Skip if edge already exists or proposal pending
    if (existingEdgeSet.has(edgeKey) || pendingInfSet.has(edgeKey)) continue;

    if (!DRY_RUN) {
      await sql`
        INSERT INTO proposals (proposal_type, from_addr, to_addr, payload, confidence, discovered_by, evidence)
        VALUES (
          'inference', ${c.a_addr}, ${c.c_addr},
          ${sql.json({
            edge_type: rule.produces_type,
            via_node: c.b_addr,
            via_label: c.b_label,
            from_label: c.a_label,
            to_label: c.c_label,
          })},
          ${Math.min(c.conf_1, c.conf_2)},
          'inference',
          ${sql.json([{
            type: 'transitive_chain',
            chain: `${c.a_addr} →[${c.type_1}]→ ${c.b_addr} →[${c.type_2}]→ ${c.c_addr}`,
            produces: rule.produces_type,
            conf_1: c.conf_1,
            conf_2: c.conf_2,
            timestamp: new Date().toISOString(),
          }])}
        )`;
      created++;
      pendingInfSet.add(edgeKey);
    }

    console.log(`  🔗 ${c.a_label} →[${rule.produces_type}]→ ${c.c_label} (via ${c.b_label})`);
  }

  console.log(`[DIALECTIC] Pass 2 complete: ${found} inferences detected, ${created} proposals created`);
  return { found, created };
}

// ============================================================
// PASS 3: Consistency Check
// ============================================================

async function checkConsistency(): Promise<{ checked: number; flagged: number }> {
  console.log("\n[DIALECTIC] Pass 3: Synthesis consistency check...");

  // Find unchecked tensions with synthesis text
  const unchecked = await sql`
    SELECT id, from_addr, to_addr, synthesis, tension_type
    FROM edge_tensions 
    WHERE consistency_status = 'unchecked' 
      AND synthesis IS NOT NULL
    LIMIT 50`;

  if (unchecked.length === 0) {
    console.log("[DIALECTIC] No unchecked syntheses to verify");
    return { checked: 0, flagged: 0 };
  }

  let checked = 0;
  let flagged = 0;

  for (const t of unchecked) {
    // Find other tensions touching the same nodes
    const related = await sql`
      SELECT id, synthesis, tension_type FROM edge_tensions
      WHERE (from_addr = ${t.from_addr} OR to_addr = ${t.from_addr}
        OR from_addr = ${t.to_addr} OR to_addr = ${t.to_addr})
        AND id != ${t.id}
        AND synthesis IS NOT NULL
        AND resolved_at IS NULL`;

    let consistent = true;

    // Simple heuristic: flag if same node has contradictory tension types
    // (e.g., one says tradeoff, another says complement — these are different framings)
    for (const r of related) {
      if (t.tension_type === 'contradiction' && r.tension_type === 'complement') {
        // Can't be both contradicting and complementing
        consistent = false;
        break;
      }
      if (t.tension_type === 'complement' && r.tension_type === 'contradiction') {
        consistent = false;
        break;
      }
    }

    if (!DRY_RUN) {
      await sql`
        UPDATE edge_tensions 
        SET consistency_status = ${consistent ? 'consistent' : 'flagged'},
            consistency_checked_at = now()
        WHERE id = ${t.id}`;
    }

    checked++;
    if (!consistent) {
      flagged++;
      console.log(`  ⚠️ Flagged: tension #${t.id} (${t.tension_type}) between ${t.from_addr} ↔ ${t.to_addr}`);
    }
  }

  console.log(`[DIALECTIC] Pass 3 complete: ${checked} checked, ${flagged} flagged`);
  return { checked, flagged };
}

// ============================================================
// Main: Run all passes, log results
// ============================================================

async function main() {
  const startMs = Date.now();
  console.log(`\n[DIALECTIC] Scanner starting ${DRY_RUN ? '(DRY RUN)' : ''}...`);

  // Log the run
  let runId: number | null = null;
  if (!DRY_RUN) {
    const [run] = await sql`
      INSERT INTO scanner_run_log (run_type) 
      VALUES (${TENSIONS_ONLY ? 'contradiction' : INFERENCES_ONLY ? 'inference' : 'full'})
      RETURNING id`;
    runId = run.id;
  }

  let tensionsFound = 0, tensionsCreated = 0;
  let inferencesFound = 0, inferencesCreated = 0;
  let consistencyChecked = 0, consistencyFlagged = 0;
  let errors = 0;

  try {
    // Pass 1: Tensions
    if (!INFERENCES_ONLY) {
      const t = await scanTensions();
      tensionsFound = t.found;
      tensionsCreated = t.created;
    }

    // Pass 2: Inferences
    if (!TENSIONS_ONLY) {
      const i = await scanInferences();
      inferencesFound = i.found;
      inferencesCreated = i.created;
    }

    // Pass 3: Consistency
    if (!INFERENCES_ONLY) {
      const c = await checkConsistency();
      consistencyChecked = c.checked;
      consistencyFlagged = c.flagged;
    }
  } catch (err: any) {
    errors++;
    console.error(`[DIALECTIC] Error: ${err.message}`);
  }

  const wallMs = Date.now() - startMs;

  // Update run log
  if (runId && !DRY_RUN) {
    await sql`
      UPDATE scanner_run_log SET
        finished_at = now(),
        tensions_created = ${tensionsCreated},
        tensions_updated = 0,
        proposals_created = ${tensionsCreated + inferencesCreated},
        comparisons_made = ${tensionsFound + inferencesFound},
        errors = ${errors},
        wall_clock_ms = ${wallMs}
      WHERE id = ${runId}`;
  }

  console.log(`\n[DIALECTIC] === Summary ===`);
  console.log(`  Tensions:   ${tensionsFound} detected, ${tensionsCreated} proposals created`);
  console.log(`  Inferences: ${inferencesFound} detected, ${inferencesCreated} proposals created`);
  console.log(`  Consistency: ${consistencyChecked} checked, ${consistencyFlagged} flagged`);
  console.log(`  Wall clock: ${wallMs}ms`);
  console.log(`  Run logged: ${runId ? `#${runId}` : 'dry run'}`);

  await sql.end();
}

main().catch(err => {
  console.error("[DIALECTIC] Fatal error:", err);
  process.exit(1);
});
