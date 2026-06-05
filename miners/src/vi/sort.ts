/**
 * Verity Ingest — Stage 4: SORT
 *
 * 4-rule classifier + contradiction detection via Flash when similarity > 0.90
 */

import { sql, CLASSIFIER_VERSION, type IngestContext, type ClassifiedAtom, type ScoredAtom } from "./config";
import { loadParams } from "./config";
import { callFlash } from "../lib/llm";

/**
 * SORT: Classify each scored atom into AUTO_ON, AUTO_IN, or QUEUE
 */
export async function sort(ctx: IngestContext): Promise<void> {
  const params = await loadParams();
  const { scored_atoms, stats } = ctx;
  const classified: ClassifiedAtom[] = [];

  console.log(`[SORT] Classifying ${scored_atoms.length} atoms (v${CLASSIFIER_VERSION})...`);
  console.log(`[SORT] Thresholds: auto_on=${params.auto_on_threshold}, auto_in=${params.auto_in_threshold}`);

  for (const atom of scored_atoms) {
    // Contradiction detection (only when nearest_similarity > threshold)
    let is_contradiction = false;
    let contradiction_verdict: "yes" | "no" | "refines" | undefined;

    if (atom.nearest_similarity > params.contradiction_similarity && atom.nearest_node_addr) {
      const result = await checkContradiction(atom);
      contradiction_verdict = result;
      is_contradiction = result === "yes";
      stats.flash_calls++;
      stats.cost_usd += 0.001;

      if (result === "yes") {
        console.log(`[SORT]   ⚡ Contradiction detected: "${atom.content.slice(0, 60)}..." vs ${atom.nearest_node_addr}`);
      } else if (result === "refines") {
        console.log(`[SORT]   ↗ Refinement: "${atom.content.slice(0, 60)}..." refines ${atom.nearest_node_addr}`);
      }
    }

    // 4 classification rules
    let classification: ClassifiedAtom["classification"];

    if (atom.temporality === "CURRENT" || atom.temporality === "EPHEMERAL") {
      // Time-bound atoms never become durable graph nodes directly.
      // Verified current signal goes straight to stimulus/orphan routing.
      classification = (is_contradiction || atom.provenance === "unverified") ? "QUEUE" : "AUTO_IN";
    } else if (contradiction_verdict === "refines") {
      // Durable refinements become candidate nodes for QC.
      classification = "AUTO_ON";
    } else if (atom.score >= params.auto_on_threshold && !is_contradiction && atom.provenance === "verified") {
      // Rule 1: High quality durable knowledge + clean → AUTO_ON
      classification = "AUTO_ON";
    } else if (atom.score >= params.auto_on_threshold && (is_contradiction || atom.provenance === "unverified")) {
      // Rule 2: Would be auto-ON but has a flag → QUEUE
      classification = "QUEUE";
    } else if (atom.score < params.auto_in_threshold) {
      // Rule 3: Low score → AUTO_IN
      classification = "AUTO_IN";
    } else {
      // Rule 4: Middle zone → QUEUE
      classification = "QUEUE";
    }

    classified.push({
      ...atom,
      classification,
      is_contradiction,
      contradiction_verdict,
    });
  }

  ctx.classified_atoms = classified;

  // Apply corroboration boost tracking (contradiction_verdict === "no" handled in deliver)

  // Summary
  const counts = { AUTO_ON: 0, AUTO_IN: 0, QUEUE: 0 };
  for (const a of classified) counts[a.classification]++;
  console.log(`[SORT] Classification: AUTO_ON=${counts.AUTO_ON}, AUTO_IN=${counts.AUTO_IN}, QUEUE=${counts.QUEUE}`);
  const contradictions = classified.filter(a => a.is_contradiction).length;
  if (contradictions > 0) console.log(`[SORT] Contradictions: ${contradictions}`);
}

// ============================================================
// CONTRADICTION DETECTION — Flash one-shot
// ============================================================

async function checkContradiction(atom: ScoredAtom): Promise<"yes" | "no" | "refines"> {
  // Fetch the existing node's content
  const [node] = await sql`
    SELECT addr, label, substance->>'description' as description
    FROM nodes
    WHERE addr = ${atom.nearest_node_addr}`;

  if (!node) return "no";

  const prompt = `Compare these two statements. Does the NEW atom contradict the EXISTING node?

EXISTING NODE (${node.addr}): ${node.label}
${node.description || ""}

NEW ATOM: ${atom.content}

Answer EXACTLY one word: yes, no, or refines
- "yes" = the new atom directly contradicts the existing node
- "no" = they are compatible or the atom corroborates the node
- "refines" = the atom adds nuance, updates, or extends the existing node

Answer:`;

  try {
    const raw = await callFlash(prompt, { temperature: 0.1, maxTokens: 10 });
    const answer = raw.trim().toLowerCase().replace(/[^a-z]/g, "");

    if (answer === "yes") return "yes";
    if (answer === "refines") return "refines";
    return "no";
  } catch {
    return "no"; // On failure, assume no contradiction
  }
}
