/**
 * Mercury Synthesis Engine
 * 
 * Takes promoted edge tensions and generates synthesis text —
 * the "third thing" that neither node contains alone.
 * 
 * Usage:
 *   bun run miners/src/synthesizer.ts              # synthesize all unsynthesized
 *   bun run miners/src/synthesizer.ts --batch 10   # process N tensions
 *   bun run miners/src/synthesizer.ts --dry-run    # preview without writing
 */

import postgres from "postgres";
import { callFlash } from "./lib/llm";

const sql = postgres("postgresql://localhost:5432/verity");

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = process.argv.includes("--batch")
  ? parseInt(process.argv[process.argv.indexOf("--batch") + 1])
  : 999;

interface Tension {
  id: number;
  from_addr: string;
  to_addr: string;
  tension_type: string;
  tension: number;
  evidence: any;
}

interface NodeInfo {
  addr: string;
  label: string;
  description: string;
  node_type: string;
  confidence: number;
}

async function getNode(addr: string): Promise<NodeInfo | null> {
  const [node] = await sql`
    SELECT addr, label, substance->>'description' as description,
      node_type, confidence
    FROM nodes WHERE addr = ${addr}`;
  return node as NodeInfo | null;
}

const callLLM = (prompt: string) => callFlash(prompt, { temperature: 0.3, maxTokens: 1024 });

function buildSynthesisPrompt(from: NodeInfo, to: NodeInfo, tension: Tension): string {
  return `You are a knowledge synthesis engine. Two nodes in a knowledge graph are in "${tension.tension_type}" tension (score: ${tension.tension}).

NODE A: [${from.addr}] "${from.label}"
${from.description || "No description"}

NODE B: [${to.addr}] "${to.label}"  
${to.description || "No description"}

Tension type: ${tension.tension_type}
${tension.evidence ? `Evidence: ${JSON.stringify(tension.evidence).slice(0, 300)}` : ""}

Generate the SYNTHESIS — the insight that emerges from holding both sides at once. What's the "third thing" that neither node contains alone? How do these two work together, constrain each other, or create something new?

Rules:
- 1-3 sentences maximum
- Be specific to these nodes, not generic
- For "complement" tensions: what capability emerges from combining them?
- For "constraint" tensions: what's the resolution that satisfies both?
- For "contradiction" tensions: what's the deeper truth underneath?
- For "tradeoff" tensions: what's the optimal balance point?
- For "paradox" tensions: what's the perspective shift that dissolves the paradox?

Respond with ONLY the synthesis text, no preamble.`;
}

async function synthesize(tension: Tension): Promise<{ text: string; confidence: number } | null> {
  const from = await getNode(tension.from_addr);
  const to = await getNode(tension.to_addr);
  
  if (!from || !to) {
    console.log(`  ⚠️  Skipping tension ${tension.id}: missing node(s)`);
    return null;
  }

  const prompt = buildSynthesisPrompt(from, to, tension);
  const text = await callLLM(prompt);
  
  if (!text || text.length < 10) {
    console.log(`  ⚠️  Empty synthesis for tension ${tension.id}`);
    return null;
  }

  // Confidence based on tension type and input quality
  const baseConf = tension.tension_type === "complement" ? 0.7 
    : tension.tension_type === "constraint" ? 0.6
    : 0.5;
  const confidence = Math.min(0.9, baseConf + (from.confidence + to.confidence) / 10);

  return { text, confidence };
}

async function main() {
  console.log(`🔮 Mercury Synthesis Engine starting${DRY_RUN ? " (DRY RUN)" : ""}...`);
  
  // Fetch unsynthesized tensions
  const tensions = await sql<Tension[]>`
    SELECT id, from_addr, to_addr, tension_type, tension, evidence
    FROM edge_tensions 
    WHERE synthesis IS NULL AND resolved_at IS NULL
    ORDER BY tension DESC, created_at ASC
    LIMIT ${BATCH_SIZE}`;

  console.log(`  Found ${tensions.length} tensions needing synthesis\n`);

  let synthesized = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (const t of tensions) {
    const from = await getNode(t.from_addr);
    const to = await getNode(t.to_addr);
    
    process.stdout.write(`  [${t.tension_type}] ${from?.label || t.from_addr} ↔ ${to?.label || t.to_addr} ... `);

    try {
      const result = await synthesize(t);
      
      if (!result) {
        skipped++;
        continue;
      }

      console.log(`✅ (${result.confidence.toFixed(2)})`);
      console.log(`     "${result.text.slice(0, 120)}${result.text.length > 120 ? "..." : ""}"\n`);

      if (!DRY_RUN) {
        await sql`
          UPDATE edge_tensions 
          SET synthesis = ${result.text}, 
              synthesis_confidence = ${result.confidence}
          WHERE id = ${t.id}`;
        synthesized++;
      }
    } catch (e: any) {
      console.log(`❌ ${e.message.slice(0, 80)}`);
      skipped++;
    }

    // Small delay to avoid hammering Mercury
    await new Promise(r => setTimeout(r, 200));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🔮 Synthesis complete (${elapsed}s) | ✅ ${synthesized} synthesized | ⏭ ${skipped} skipped`);

  await sql.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
