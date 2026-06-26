/**
 * Archetype Miner — L2 Cross-Pyramid Pattern Detection
 * 
 * Finds recurring structural patterns across pyramids.
 * An "archetype" is a pattern that appears in 2+ pyramids,
 * suggesting a deeper truth about how systems work.
 * 
 * Examples:
 *   - "CLI Wrapper" pattern: OC has ~40 CLI tools, CC has 5, CX has 3
 *     → the archetype is "expose complex systems via simple CLIs"
 *   - "Safety Gate" pattern: OC has Ted review, CX has sandbox policies
 *     → the archetype is "gate untrusted output through verification"
 *   - "Feedback Loop" pattern: OC has reactor, PJ has crypto retraining
 *     → the archetype is "systems improve by consuming their own output"
 * 
 * Usage:
 *   bun run miners/src/archetype-miner.ts              # detect + stage
 *   bun run miners/src/archetype-miner.ts --dry-run    # detect only
 *   bun run miners/src/archetype-miner.ts --report     # just show patterns
 */

import postgres from "postgres";
import { callFlash as callFlashLLM } from "./lib/llm";

const sql = postgres("postgresql://localhost:5432/verity");

const DRY_RUN = process.argv.includes("--dry-run");
const REPORT_ONLY = process.argv.includes("--report");

interface ClusterNode {
  addr: string;
  label: string;
  pyramid_id: string;
  node_type: string;
  substance_preview: string;
  provides: string[];
}

interface Archetype {
  name: string;
  description: string;
  instances: { addr: string; label: string; pyramid: string }[];
  pyramids: string[];
  confidence: number;
}

const callFlash = (prompt: string) => callFlashLLM(prompt, { temperature: 0.2 });

/**
 * Confidence for a capability cluster from how many pyramids it spans. Capped at 0.9 so the
 * value stays a valid [0,1] probability — there are 10 registered pyramids, so the uncapped
 * `0.6 + count*0.05` produced 1.05 (9 pyramids) / 1.10 (10) and wrote out-of-range values to
 * proposals.confidence (REAL, no CHECK). Matches the Math.min(0.9, …) cap used by the edge-bridge
 * formula below and in supercron.
 */
export function clusterConfidence(pyramidCount: number): number {
  return Math.min(0.9, 0.6 + pyramidCount * 0.05);
}

// Strategy 1: Capability clustering via "provides" overlap
async function findCapabilityClusters(): Promise<Archetype[]> {
  console.log("\n  🔍 Strategy 1: Capability overlap across pyramids...");
  
  // Find provides values that appear in 2+ pyramids
  const clusters = await sql`
    WITH provides AS (
      SELECT n.addr, n.label, n.pyramid_id, n.node_type,
        jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(n.substance->'provides') = 'array' 
          THEN n.substance->'provides' ELSE '[]'::jsonb END
        ) as capability
      FROM nodes n
      WHERE n.substance ? 'provides'
    ),
    cross_pyramid AS (
      SELECT capability, 
        array_agg(DISTINCT pyramid_id) as pyramids,
        count(DISTINCT pyramid_id) as pyramid_count,
        json_agg(json_build_object('addr', addr, 'label', label, 'pyramid', pyramid_id)) as instances
      FROM provides
      GROUP BY capability
      HAVING count(DISTINCT pyramid_id) >= 2
    )
    SELECT * FROM cross_pyramid ORDER BY pyramid_count DESC, capability`;

  const archetypes: Archetype[] = [];
  
  for (const c of clusters) {
    archetypes.push({
      name: `Shared Capability: ${c.capability}`,
      description: `The capability "${c.capability}" appears across ${c.pyramid_count} pyramids (${(c.pyramids as string[]).join(', ')}), suggesting a fundamental pattern.`,
      instances: c.instances as any[],
      pyramids: c.pyramids as string[],
      confidence: clusterConfidence(c.pyramid_count as number),
    });
  }

  console.log(`    Found ${archetypes.length} cross-pyramid capability patterns`);
  return archetypes;
}

// Strategy 2: Node-type distribution patterns
async function findTypePatterns(): Promise<Archetype[]> {
  console.log("  🔍 Strategy 2: Node-type distribution patterns...");
  
  const dist = await sql`
    SELECT pyramid_id, node_type, count(*) as cnt,
      round(count(*)::numeric / sum(count(*)) OVER (PARTITION BY pyramid_id) * 100, 1) as pct
    FROM nodes
    GROUP BY pyramid_id, node_type
    ORDER BY pyramid_id, cnt DESC`;

  // Find node types that dominate (>20%) in 2+ pyramids
  const dominantTypes = new Map<string, { pyramid: string; pct: number }[]>();
  for (const r of dist) {
    if ((r.pct as number) >= 15) {
      const key = r.node_type as string;
      if (!dominantTypes.has(key)) dominantTypes.set(key, []);
      dominantTypes.get(key)!.push({ pyramid: r.pyramid_id as string, pct: r.pct as number });
    }
  }

  const archetypes: Archetype[] = [];
  for (const [type, pyramids] of dominantTypes) {
    if (pyramids.length >= 2) {
      archetypes.push({
        name: `Dominant Type: ${type}`,
        description: `"${type}" nodes dominate ${pyramids.length} pyramids: ${pyramids.map(p => `${p.pyramid} (${p.pct}%)`).join(', ')}. This structural pattern suggests ${type} is a fundamental organizing principle.`,
        instances: [],
        pyramids: pyramids.map(p => p.pyramid),
        confidence: 0.7,
      });
    }
  }

  console.log(`    Found ${archetypes.length} structural type patterns`);
  return archetypes;
}

// Strategy 3: Cross-pyramid edge pattern analysis
async function findEdgePatterns(): Promise<Archetype[]> {
  console.log("  🔍 Strategy 3: Cross-pyramid edge patterns...");

  const patterns = await sql`
    SELECT e.edge_type, n1.pyramid_id as from_pyramid, n2.pyramid_id as to_pyramid,
      count(*) as cnt,
      json_agg(json_build_object(
        'from_addr', e.from_addr, 'from_label', n1.label,
        'to_addr', e.to_addr, 'to_label', n2.label
      ) ORDER BY e.confidence DESC) as examples
    FROM edges e
    JOIN nodes n1 ON n1.addr = e.from_addr
    JOIN nodes n2 ON n2.addr = e.to_addr
    WHERE n1.pyramid_id != n2.pyramid_id
    GROUP BY e.edge_type, n1.pyramid_id, n2.pyramid_id
    HAVING count(*) >= 3
    ORDER BY cnt DESC`;

  const archetypes: Archetype[] = [];
  for (const p of patterns) {
    const examples = (p.examples as any[]).slice(0, 3);
    archetypes.push({
      name: `Bridge: ${p.from_pyramid}→${p.to_pyramid} [${p.edge_type}]`,
      description: `${p.cnt} "${p.edge_type}" edges bridge ${p.from_pyramid} → ${p.to_pyramid}. Examples: ${examples.map(e => `${e.from_label} → ${e.to_label}`).join('; ')}`,
      instances: examples.map(e => ({ addr: e.from_addr, label: e.from_label, pyramid: p.from_pyramid as string })),
      pyramids: [p.from_pyramid as string, p.to_pyramid as string],
      confidence: Math.min(0.9, 0.5 + (p.cnt as number) * 0.05),
    });
  }

  console.log(`    Found ${archetypes.length} cross-pyramid bridge patterns`);
  return archetypes;
}

// Strategy 4: AI synthesis of highest-signal patterns
async function synthesizeArchetypes(allPatterns: Archetype[]): Promise<Archetype[]> {
  if (allPatterns.length === 0) return [];
  
  console.log("\n  🧠 AI synthesis: finding deeper archetypes...");
  
  const patternSummary = allPatterns
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 30)
    .map((a, i) => `${i + 1}. ${a.name}: ${a.description.slice(0, 200)}`)
    .join('\n');

  const prompt = `You are analyzing a knowledge graph with 5 pyramids: OPENCLAW (AI agent framework), META (self-knowledge), PROJECTS (crypto, audio, options trading), CLAUDECODE (Claude Code editor), CODEX (OpenAI Codex).

Here are ${Math.min(30, allPatterns.length)} detected cross-pyramid patterns:

${patternSummary}

Identify 3-7 DEEP ARCHETYPES — recurring structural/conceptual patterns that transcend any single pyramid. Each archetype should be a genuine insight about how these systems work, not just a category label.

For each archetype, respond in this exact JSON format:
[
  {
    "name": "Archetype Name (3-5 words)",
    "description": "2-3 sentences explaining the pattern, why it recurs, and what it reveals about system design",
    "pyramids": ["PYRAMID1", "PYRAMID2"],
    "confidence": 0.7
  }
]

Respond with ONLY the JSON array, no preamble.`;

  try {
    const response = await callFlash(prompt);
    // Extract JSON from response (may have markdown wrapping)
    // Try to extract JSON — handle markdown code blocks and stray text
    let jsonStr = response;
    const codeBlock = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log("    ⚠️ Could not parse AI response");
      console.log("    Raw:", response.slice(0, 500));
      return [];
    }
    
    let parsed: any[];
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e2: any) {
      console.log("    ⚠️ JSON parse failed, trying cleanup...");
      console.log("    Fragment:", jsonMatch[0].slice(0, 300));
      // Try fixing common issues: trailing commas, smart quotes
      const cleaned = jsonMatch[0]
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      parsed = JSON.parse(cleaned);
    }
    
    const archetypes: Archetype[] = parsed.map((a: any) => ({
      ...a,
      instances: [],
    }));
    
    console.log(`    Synthesized ${archetypes.length} deep archetypes`);
    return archetypes;
  } catch (e: any) {
    console.log(`    ❌ Synthesis failed: ${e.message.slice(0, 80)}`);
    return [];
  }
}

async function stageArchetypes(archetypes: Archetype[]): Promise<number> {
  let staged = 0;
  
  for (const a of archetypes) {
    // Check for existing proposal with same name
    const [existing] = await sql`
      SELECT id FROM proposals 
      WHERE proposal_type = 'archetype' AND payload->>'name' = ${a.name} AND status = 'pending'`;
    
    if (existing) continue;

    await sql`
      INSERT INTO proposals (proposal_type, payload, confidence, discovered_by, evidence)
      VALUES ('archetype', ${sql.json({
        name: a.name,
        description: a.description,
        pyramids: a.pyramids,
      })}, ${a.confidence}, 'archetype-miner', ${sql.json(
        a.instances.map(i => ({ addr: i.addr, label: i.label, pyramid: i.pyramid }))
      )})`;
    staged++;
  }

  return staged;
}

async function main() {
  console.log(`🏛️  Archetype Miner starting${DRY_RUN ? " (DRY RUN)" : REPORT_ONLY ? " (REPORT)" : ""}...`);
  
  // Run all detection strategies
  const capPatterns = await findCapabilityClusters();
  const typePatterns = await findTypePatterns();
  const edgePatterns = await findEdgePatterns();
  
  const allPatterns = [...capPatterns, ...typePatterns, ...edgePatterns];
  console.log(`\n  📊 Total raw patterns: ${allPatterns.length}`);

  // AI synthesis to find deep archetypes
  const deepArchetypes = await synthesizeArchetypes(allPatterns);
  
  // Print report
  console.log("\n\n═══════════════════════════════════════════");
  console.log("  DISCOVERED ARCHETYPES");
  console.log("═══════════════════════════════════════════\n");
  
  for (const a of deepArchetypes) {
    console.log(`  🏛️  ${a.name} (${a.confidence.toFixed(2)})`);
    console.log(`     Pyramids: ${a.pyramids.join(', ')}`);
    console.log(`     ${a.description}`);
    console.log();
  }

  if (REPORT_ONLY || DRY_RUN) {
    console.log("  📋 Raw pattern breakdown:");
    console.log(`     Capability clusters: ${capPatterns.length}`);
    console.log(`     Type patterns: ${typePatterns.length}`);
    console.log(`     Edge bridges: ${edgePatterns.length}`);
    console.log(`     Deep archetypes: ${deepArchetypes.length}`);
  }

  if (!DRY_RUN && !REPORT_ONLY && deepArchetypes.length > 0) {
    const staged = await stageArchetypes(deepArchetypes);
    console.log(`  📦 Staged ${staged} archetype proposals`);
  }

  console.log(`\n🏛️  Archetype Miner complete`);
  await sql.end();
}

// Only run the CLI when executed directly, not when imported (e.g. by a test).
if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
