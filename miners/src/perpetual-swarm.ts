/**
 * Perpetual Swarm — The self-sustaining knowledge fire
 * 
 * One process that never needs relighting. It finds its own fuel,
 * regulates its own burn rate, and each cycle's output becomes
 * the next cycle's input.
 * 
 * FUEL SOURCES (priority-ranked):
 *   1. Query misses    — questions agents asked that got weak answers
 *   2. Contradictions  — real conflicts between nodes waiting for resolution
 *   3. Fresh approvals — newly-committed nodes that need edge wiring
 *   4. Stale high-value — frequently-queried nodes going stale
 *   5. Low-confidence   — weakest nodes that could be enriched by debate
 * 
 * REGULATION:
 *   - Daily budget cap (default $0.50/day)
 *   - Diminishing returns: topics that produce 0 artifacts get deprioritized
 *   - Cooldown: same topic can't be convened twice in 4 hours
 *   - Circuit breaker: 3 consecutive dry runs → sleep for 2 hours
 * 
 * FEEDBACK LOOP:
 *   Convene → artifacts staged → QC approves → new nodes/edges →
 *   neighbors queued for next convene → graph grows → better convenes
 * 
 * Usage:
 *   bun run miners/src/perpetual-swarm.ts              # one cycle
 *   bun run miners/src/perpetual-swarm.ts --continuous  # run forever (for cron: use single cycle)
 *   bun run miners/src/perpetual-swarm.ts --dry-run     # pick fuel but don't convene
 *   bun run miners/src/perpetual-swarm.ts --budget 1.00 # daily budget override
 */

import postgres from "postgres";

const sql = postgres("postgresql://localhost:5432/verity");

const CONVENE_URL = "http://localhost:3100/swarm/convene";
// batch-31: accept BOTH `--budget 1.00` (the form the usage header + miners/CLAUDE.md
// document) and `--budget=1.00`. The old split("=")[1] silently dropped the spaced
// form, so the operator override was ignored (fell back to 0.50).
function parseBudgetArg(): number {
  const i = process.argv.findIndex((a) => a === "--budget" || a.startsWith("--budget="));
  if (i < 0) return 0.50;
  const raw = process.argv[i].includes("=") ? process.argv[i].split("=")[1] : process.argv[i + 1];
  const n = parseFloat(raw || "");
  return Number.isFinite(n) && n > 0 ? n : 0.50;
}
const DAILY_BUDGET_USD = parseBudgetArg();
const COST_PER_CONVENE = 0.025; // ~$0.025 per 4-agent convene
const COOLDOWN_HOURS = 4;
const MAX_CONSECUTIVE_DRY = 3;
const DRY_RUN = process.argv.includes("--dry-run");

// --- Fuel Source Types ---
interface FuelSource {
  type: "query_miss" | "contradiction" | "fresh_approval" | "stale_high_value" | "low_confidence";
  question: string;
  priority: number;        // higher = more urgent
  addrs?: string[];        // force specific agents
  context: string;         // why this was selected
  topic_hash: string;      // for cooldown dedup
}

// --- Fuel Discovery ---

async function findQueryMisses(): Promise<FuelSource[]> {
  // Questions that got low similarity scores or zero results
  const misses = await sql`
    SELECT query, results_returned, created_at
    FROM query_log
    WHERE results_returned <= 2
      AND created_at > NOW() - INTERVAL '24 hours'
      AND query NOT LIKE '[convene]%'
    ORDER BY created_at DESC
    LIMIT 5`;

  return misses.map((m: any) => ({
    type: "query_miss" as const,
    question: m.query,
    priority: 5,
    context: `Agent query "${m.query}" returned only ${m.results_returned} results`,
    topic_hash: hashTopic(m.query),
  }));
}

async function findContradictions(): Promise<FuelSource[]> {
  const conflicts = await sql`
    SELECT e.from_addr, e.to_addr, e.label,
      n1.label AS from_label, n2.label AS to_label
    FROM edges e
    JOIN nodes n1 ON e.from_addr = n1.addr
    JOIN nodes n2 ON e.to_addr = n2.addr
    WHERE e.edge_type = 'conflicts_with'
    ORDER BY e.confidence DESC
    LIMIT 5`;

  return conflicts.map((c: any) => ({
    type: "contradiction" as const,
    question: `Resolve the conflict between "${c.from_label}" and "${c.to_label}": ${c.label}`,
    priority: 4,
    addrs: [c.from_addr, c.to_addr],
    context: `Explicit conflicts_with edge: ${c.from_addr} ↔ ${c.to_addr}`,
    topic_hash: hashTopic(`${c.from_addr}:${c.to_addr}`),
  }));
}

async function findFreshApprovals(): Promise<FuelSource[]> {
  // Nodes committed in the last 6 hours that have < 2 edges
  const fresh = await sql`
    SELECT n.addr, n.label, 
      (SELECT COUNT(*) FROM edges e WHERE e.from_addr = n.addr OR e.to_addr = n.addr) AS edge_count
    FROM nodes n
    WHERE n.updated_at > NOW() - INTERVAL '6 hours'
      AND n.visibility = 'public'
      AND (SELECT COUNT(*) FROM edges e WHERE e.from_addr = n.addr OR e.to_addr = n.addr) < 2
    ORDER BY n.updated_at DESC
    LIMIT 5`;

  return fresh.map((f: any) => ({
    type: "fresh_approval" as const,
    question: `What should "${f.label}" connect to? What does it depend on, conflict with, or enable?`,
    priority: 3,
    addrs: [f.addr],
    context: `New node ${f.addr} has only ${f.edge_count} edges`,
    topic_hash: hashTopic(f.addr),
  }));
}

async function findStaleHighValue(): Promise<FuelSource[]> {
  const stale = await sql`
    SELECT addr, label, query_hits, confidence,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(verified_at, updated_at))) / 86400 AS days_stale
    FROM nodes
    WHERE visibility = 'public' AND query_hits > 3
      AND COALESCE(verified_at, updated_at) < NOW() - INTERVAL '14 days'
    ORDER BY query_hits DESC
    LIMIT 3`;

  return stale.map((s: any) => ({
    type: "stale_high_value" as const,
    question: `Is "${s.label}" still accurate? It has ${s.query_hits} agent queries but hasn't been verified in ${Math.round(parseFloat(s.days_stale))} days.`,
    priority: 2,
    addrs: [s.addr],
    context: `High-value stale: ${s.addr} (${s.query_hits} queries, ${Math.round(parseFloat(s.days_stale))}d stale)`,
    topic_hash: hashTopic(s.addr),
  }));
}

async function findLowConfidence(): Promise<FuelSource[]> {
  const weak = await sql`
    SELECT addr, label, confidence, node_type
    FROM nodes
    WHERE visibility = 'public'
      AND confidence < 0.55
      AND node_type IN ('tool', 'skill', 'workflow')
    ORDER BY confidence ASC
    LIMIT 3`;

  return weak.map((w: any) => ({
    type: "low_confidence" as const,
    question: `What do we actually know about "${w.label}"? Verify or deprecate.`,
    priority: 1,
    addrs: [w.addr],
    context: `Low confidence: ${w.addr} at ${w.confidence}`,
    topic_hash: hashTopic(w.addr),
  }));
}

// --- Regulation ---

async function getSpendToday(): Promise<number> {
  // batch-31: the flat [convene]-count × COST_PER_CONVENE proxy ignored ALL
  // downstream worker spend (qc-sentinel Gemini-Pro review, ingest, distiller),
  // so the daily cap undercounted true Gemini cost. Add the real worker_llm_spend
  // ledger for that downstream spend. The swarm's own convenes are not yet
  // recorded in the ledger, so KEEP the proxy for them (when convene is
  // instrumented into worker_llm_spend, drop the proxy to avoid double-counting).
  const [convenes] = await sql`
    SELECT COUNT(*) AS convenes FROM query_log
    WHERE query LIKE '[convene]%'
      AND created_at > CURRENT_DATE`;
  const [ledger] = await sql`
    SELECT COALESCE(SUM(cost_usd_micro), 0)::bigint AS micro FROM worker_llm_spend
    WHERE occurred_at >= CURRENT_DATE`;
  const conveneEstimate = parseInt(convenes.convenes) * COST_PER_CONVENE;
  const ledgerUsd = Number(ledger.micro) / 1e6;
  return conveneEstimate + ledgerUsd;
}

async function isOnCooldown(topicHash: string): Promise<boolean> {
  const [result] = await sql`
    SELECT COUNT(*) AS cnt FROM query_log
    WHERE query LIKE ${`[convene:${topicHash}]%`}
      AND created_at > NOW() - make_interval(hours => ${COOLDOWN_HOURS})`;
  return parseInt(result.cnt) > 0;
}

async function getConsecutiveDry(): Promise<number> {
  const recent = await sql`
    SELECT results_returned FROM query_log
    WHERE query LIKE '[convene%'
    ORDER BY created_at DESC
    LIMIT ${MAX_CONSECUTIVE_DRY}`;
  let dry = 0;
  for (const r of recent) {
    if (r.results_returned === 0) dry++;
    else break;
  }
  return dry;
}

function hashTopic(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// --- Convene Caller ---

async function callConvene(fuel: FuelSource): Promise<{ edges: number; nodes: number; success: boolean }> {
  const body: any = {
    question: fuel.question,
    max_agents: fuel.addrs?.length ? Math.max(fuel.addrs.length + 2, 4) : 4,
    mode: fuel.type === "contradiction" ? "adversarial" : "debate",
    rounds: 2,
    agent: "perpetual-swarm",
  };
  if (fuel.addrs) body.addrs = fuel.addrs;

  try {
    const res = await fetch(CONVENE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`  Convene failed: ${res.status}`);
      return { edges: 0, nodes: 0, success: false };
    }
    const data = await res.json() as any;
    const staged = data.staged || { edges: 0, nodes: 0 };
    
    // Log with topic hash for cooldown tracking
    await sql`INSERT INTO query_log (query, results_returned, agent_id)
      VALUES (${`[convene:${fuel.topic_hash}] ${fuel.question.slice(0, 200)}`}, 
              ${staged.edges + staged.nodes}, 'perpetual-swarm')`;

    return { edges: staged.edges, nodes: staged.nodes, success: true };
  } catch (e: any) {
    console.error(`  Convene error: ${e.message}`);
    return { edges: 0, nodes: 0, success: false };
  }
}

// --- Main Loop ---

async function runOneCycle(): Promise<{ fuel: FuelSource | null; result: any }> {
  console.log("🔥 Perpetual Swarm — finding fuel...");

  // Check budget
  const spentToday = await getSpendToday();
  const remaining = DAILY_BUDGET_USD - spentToday;
  console.log(`  Budget: $${spentToday.toFixed(3)} spent / $${DAILY_BUDGET_USD} daily (${Math.floor(remaining / COST_PER_CONVENE)} convenes left)`);
  
  if (remaining < COST_PER_CONVENE) {
    console.log("  ⛽ Budget exhausted for today. Sleeping.");
    return { fuel: null, result: { reason: "budget_exhausted" } };
  }

  // Check circuit breaker
  const consecutiveDry = await getConsecutiveDry();
  if (consecutiveDry >= MAX_CONSECUTIVE_DRY) {
    console.log(`  🔌 Circuit breaker: ${consecutiveDry} consecutive dry runs. Sleeping.`);
    return { fuel: null, result: { reason: "circuit_breaker", dry_runs: consecutiveDry } };
  }

  // Gather all fuel sources
  console.log("  Scanning fuel sources...");
  const allFuel = [
    ...await findQueryMisses(),
    ...await findContradictions(),
    ...await findFreshApprovals(),
    ...await findStaleHighValue(),
    ...await findLowConfidence(),
  ];

  console.log(`  Found ${allFuel.length} potential topics`);

  // Filter by cooldown
  const available: FuelSource[] = [];
  for (const f of allFuel) {
    if (!(await isOnCooldown(f.topic_hash))) {
      available.push(f);
    }
  }
  console.log(`  ${available.length} after cooldown filter`);

  if (available.length === 0) {
    console.log("  ❄️ No available topics. All on cooldown or exhausted.");
    return { fuel: null, result: { reason: "no_fuel" } };
  }

  // Sort by priority (highest first)
  available.sort((a, b) => b.priority - a.priority);
  const selected = available[0];

  console.log(`\n  🎯 Selected: [${selected.type}] ${selected.question.slice(0, 100)}`);
  console.log(`     Priority: ${selected.priority} | Context: ${selected.context}`);

  if (DRY_RUN) {
    console.log("  [DRY RUN] Would convene this topic.");
    return { fuel: selected, result: { dry_run: true } };
  }

  // Run convene
  console.log("\n  ⚡ Convening...");
  const result = await callConvene(selected);
  
  console.log(`  Result: ${result.edges} edges + ${result.nodes} nodes staged`);
  
  if (result.edges + result.nodes > 0) {
    console.log("  🔥 Fire fed — artifacts staged for QC.");
  } else {
    console.log("  💨 Dry run — no artifacts produced.");
  }

  return { fuel: selected, result };
}

async function main() {
  const continuous = process.argv.includes("--continuous");
  const startTime = Date.now();

  if (continuous) {
    console.log("🔥🔥🔥 Perpetual Swarm — CONTINUOUS MODE");
    console.log(`  Budget: $${DAILY_BUDGET_USD}/day | Cooldown: ${COOLDOWN_HOURS}h | Circuit breaker: ${MAX_CONSECUTIVE_DRY} dry runs\n`);
    
    while (true) {
      const { fuel, result } = await runOneCycle();
      
      if (!fuel) {
        // Sleep based on reason
        const sleepMin = result.reason === "budget_exhausted" ? 60 
          : result.reason === "circuit_breaker" ? 120
          : 30;
        console.log(`  💤 Sleeping ${sleepMin} minutes...\n`);
        await new Promise(r => setTimeout(r, sleepMin * 60 * 1000));
      } else {
        // Brief pause between cycles
        console.log("  ⏳ 60s cooldown before next cycle...\n");
        await new Promise(r => setTimeout(r, 60_000));
      }
    }
  } else {
    // Single cycle (for cron)
    const { fuel, result } = await runOneCycle();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✅ Perpetual Swarm cycle complete (${elapsed}s)`);
    if (fuel) {
      console.log(`   Fuel: [${fuel.type}] ${fuel.question.slice(0, 80)}`);
      console.log(`   Staged: ${result.edges || 0} edges + ${result.nodes || 0} nodes`);
    } else {
      console.log(`   Status: ${result.reason}`);
    }
    
    await sql.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
