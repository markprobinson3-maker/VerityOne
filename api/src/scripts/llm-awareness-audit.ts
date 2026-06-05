/**
 * LLM Awareness Audit
 *
 * Tests whether a node's knowledge is already known to Claude from training data.
 * High-scoring nodes (≥0.80) are candidates for removal — VO is duplicating
 * what the LLM already knows, paying maintenance cost with no unique value.
 *
 * Usage:
 *   bun run api/src/scripts/llm-awareness-audit.ts --pyramid FUNCTION --limit 50
 *   bun run api/src/scripts/llm-awareness-audit.ts --pyramid WORLD
 *   bun run api/src/scripts/llm-awareness-audit.ts --addrs OC.0.2.70,FN.0.3.1173
 *   bun run api/src/scripts/llm-awareness-audit.ts --pyramid HEURISTIC --write
 *
 * Flags:
 *   --pyramid   Pyramid ID to audit (FUNCTION, WORLD, HEURISTIC, etc.)
 *   --limit     Max nodes to test (default: 30)
 *   --addrs     Comma-separated list of specific node addresses
 *   --write     Persist scores back to substance.llm_awareness_score
 *   --min-score Only show nodes at or above this threshold (e.g. 0.7)
 */

import { createDirectSql } from "../lib/db-config";

const sql = createDirectSql();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// Parse args
const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag: string) => args.includes(flag);

const pyramidArg = getArg("--pyramid");
const addrsArg = getArg("--addrs");
const limitArg = parseInt(getArg("--limit") || "30");
const writeBack = hasFlag("--write");
const minScore = parseFloat(getArg("--min-score") || "0");

if (!pyramidArg && !addrsArg) {
  console.error("Usage: --pyramid FUNCTION | --addrs addr1,addr2");
  process.exit(1);
}

// Fetch nodes
let nodes: { addr: string; label: string; description: string | null; pyramid_id: string }[];

if (addrsArg) {
  const addrs = addrsArg.split(",").map(a => a.trim());
  nodes = await sql`
    SELECT addr, label, pyramid_id, substance->>'description' as description
    FROM nodes WHERE addr = ANY(${addrs}::text[])`;
} else {
  nodes = await sql`
    SELECT addr, label, pyramid_id, substance->>'description' as description
    FROM nodes WHERE pyramid_id = ${pyramidArg}
    ORDER BY query_hits ASC, addr ASC
    LIMIT ${limitArg}`;
}

console.log(`\nAuditing ${nodes.length} nodes${pyramidArg ? ` from ${pyramidArg}` : ""}...\n`);

const TEST_PROMPT = (label: string, description: string) =>
  `You are being tested for knowledge coverage. Without any external documentation, tools, or lookup — using only what you learned during training — how accurately could you answer the following right now?

Topic: "${label}"
Context: ${description.slice(0, 150)}

Score yourself 0.0–1.0:
- 1.0 = I know the exact steps, commands, constraints, and edge cases
- 0.8 = I know this well, could give correct actionable guidance
- 0.6 = I know the general approach but might miss specifics
- 0.4 = Vague knowledge, likely to make mistakes on details
- 0.0 = I have no reliable training data on this topic

Be honest. If this is a general, well-documented tool or pattern, score it high. If this is context-specific, user-specific, or discovered through real use — score it low.

Respond ONLY with valid JSON, no other text: {"score": 0.0, "reason": "one sentence"}`;

type AuditResult = {
  addr: string;
  label: string;
  pyramid_id: string;
  score: number;
  reason: string;
  bucket: string;
};

const results: AuditResult[] = [];
let i = 0;

for (const node of nodes) {
  i++;
  const desc = node.description || node.label;

  process.stdout.write(`[${i}/${nodes.length}] ${node.addr} — ${node.label.slice(0, 50)}...`);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",  // cheap — this is a bulk audit
        max_tokens: 100,
        messages: [{ role: "user", content: TEST_PROMPT(node.label, desc) }],
      }),
    });

    const data = await resp.json() as any;
    const text = data.content?.[0]?.text?.trim() || "{}";

    // Extract JSON even if there's surrounding text
    const match = text.match(/\{[^}]+\}/);
    const parsed = match ? JSON.parse(match[0]) : { score: 0.5, reason: "parse error" };

    const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
    const reason = parsed.reason || "";
    const bucket =
      score >= 0.8 ? "LLM-AWARE" :
      score >= 0.5 ? "PARTIAL" :
      "UNIQUE";

    results.push({ addr: node.addr, label: node.label, pyramid_id: node.pyramid_id, score, reason, bucket });
    process.stdout.write(` → ${score.toFixed(2)} [${bucket}]\n`);

    if (writeBack) {
      await sql`UPDATE nodes SET llm_awareness_score = ${score} WHERE addr = ${node.addr}`;
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 150));
  } catch (e: any) {
    process.stdout.write(` → ERROR: ${e.message?.slice(0, 60)}\n`);
    results.push({ addr: node.addr, label: node.label, pyramid_id: node.pyramid_id, score: -1, reason: "error", bucket: "ERROR" });
  }
}

// Sort by score descending (most LLM-aware first)
results.sort((a, b) => b.score - a.score);

const filtered = minScore > 0 ? results.filter(r => r.score >= minScore) : results;

// Print summary table
console.log("\n" + "=".repeat(90));
console.log(`LLM AWARENESS AUDIT — ${pyramidArg || "custom"}`);
console.log("=".repeat(90));
console.log(`${"SCORE".padEnd(7)} ${"BUCKET".padEnd(12)} ${"ADDR".padEnd(14)} LABEL`);
console.log("-".repeat(90));

for (const r of filtered) {
  if (r.score < 0) continue;
  const scoreStr = r.score.toFixed(2).padEnd(7);
  const bucketStr = r.bucket.padEnd(12);
  const addrStr = r.addr.padEnd(14);
  console.log(`${scoreStr} ${bucketStr} ${addrStr} ${r.label.slice(0, 50)}`);
  console.log(`${"".padEnd(35)} ${r.reason.slice(0, 70)}`);
}

// Bucket summary
const aware = results.filter(r => r.score >= 0.8).length;
const partial = results.filter(r => r.score >= 0.5 && r.score < 0.8).length;
const unique = results.filter(r => r.score >= 0 && r.score < 0.5).length;

console.log("\n" + "=".repeat(90));
console.log(`SUMMARY: ${aware} LLM-AWARE (redundant) | ${partial} PARTIAL (review) | ${unique} UNIQUE (keep)`);
if (!writeBack) {
  console.log(`Run with --write to persist scores to substance.llm_awareness_score`);
}
console.log("=".repeat(90) + "\n");

await sql.end();
process.exit(0);
