/**
 * Stimulus Intake — Feed the Resonance Reactor with signals from the world
 *
 * Sources:
 *   - hackernews: Top HN stories, classified by type
 *   - arxiv: Recent AI/DB/Security papers
 *   - coingecko: Significant crypto price moves (>5% 24h change)
 *   - agent: Internal agent signals (exported for programmatic use)
 *
 * Usage:
 *   bun run miners/src/stimulus-intake.ts --source hackernews
 *   bun run miners/src/stimulus-intake.ts --source arxiv
 *   bun run miners/src/stimulus-intake.ts --source coingecko
 *   bun run miners/src/stimulus-intake.ts --source all
 *   bun run miners/src/stimulus-intake.ts --source all --dry-run
 */

import postgres from "postgres";
import { embedQuery, toVectorStr } from "@verity-one/embed";

const sql = postgres("postgresql://localhost:5432/verity");
const DRY_RUN = process.argv.includes("--dry-run");

// ============================================================
// Types
// ============================================================

interface Stimulus {
  source: string;
  source_id: string;
  stimulus_type: string;
  urgency: number;
  content: string;
  url?: string;
  decay_halflife_hours?: number;
  peak_delay_hours?: number;
}

// ============================================================
// Helpers
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyHNStory(title: string, url?: string): string {
  const t = title.toLowerCase();
  if (/cve|vulnerabilit|breach|exploit|zero.?day/.test(t)) return "security_alert";
  if (/release|launch|announce|ship\b|v[23]\b/.test(t)) return "tool_release";
  if (url && url.includes("arxiv.org")) return "research_paper";
  if (/stock|market|trading|ipo|valuation|fund|revenue|earnings/.test(t)) return "market_move";
  return "news_article";
}

// ============================================================
// Source Adapters
// ============================================================

async function fetchHackerNews(): Promise<Stimulus[]> {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const ids: number[] = await res.json();
  const top30 = ids.slice(0, 30);

  const stimuli: Stimulus[] = [];
  for (const id of top30) {
    try {
      const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item = await itemRes.json() as {
        id: number; title?: string; url?: string; text?: string; score?: number;
      };
      if (!item || !item.title) continue;

      const content = item.title + (item.url ? ` ${item.url}` : item.text ? ` ${item.text}` : "");
      const urgency = clamp((item.score || 0) / 500, 0.2, 0.9);

      stimuli.push({
        source: "hackernews",
        source_id: String(item.id),
        stimulus_type: classifyHNStory(item.title, item.url),
        urgency,
        content,
        url: item.url,
      });
    } catch (e) {
      console.error(`  [HN] Failed to fetch item ${id}: ${e}`);
    }
  }
  return stimuli;
}

async function fetchArxiv(): Promise<Stimulus[]> {
  const query = "cat:cs.AI+OR+cat:cs.DB+OR+cat:cs.CR";
  const url = `http://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=20`;
  const res = await fetch(url);
  const xml = await res.text();

  const stimuli: Stimulus[] = [];
  // Parse entries from Atom XML — each <entry> block
  const entries = xml.split("<entry>").slice(1);
  for (const entry of entries) {
    const getId = entry.match(/<id>(.*?)<\/id>/);
    const getTitle = entry.match(/<title>([\s\S]*?)<\/title>/);
    const getSummary = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const getLink = entry.match(/<link[^>]*href="(https?:\/\/arxiv\.org\/abs\/[^"]+)"/);

    if (!getId || !getTitle) continue;

    const arxivId = getId[1].replace("http://arxiv.org/abs/", "").trim();
    const title = getTitle[1].replace(/\s+/g, " ").trim();
    const summary = getSummary ? getSummary[1].replace(/\s+/g, " ").trim().slice(0, 1000) : "";
    const link = getLink ? getLink[1] : getId[1];

    stimuli.push({
      source: "arxiv",
      source_id: arxivId,
      stimulus_type: "research_paper",
      urgency: 0.4,
      content: `${title} ${summary}`,
      url: link,
      peak_delay_hours: 24,
      decay_halflife_hours: 168,
    });
  }
  return stimuli;
}

async function fetchCoinGecko(): Promise<Stimulus[]> {
  // Read threshold from graph_state
  const [row] = await sql`
    SELECT value FROM graph_state WHERE key = 'significant_move_threshold'
  `;
  const threshold = row ? parseFloat(row.value) * 100 : 5; // stored as 0.05, we need 5%

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,dogecoin,cardano&vs_currencies=usd&include_24hr_change=true"
  );
  const data = await res.json() as Record<string, { usd: number; usd_24h_change: number }>;

  const today = new Date().toISOString().slice(0, 10);
  const stimuli: Stimulus[] = [];

  for (const [coin, info] of Object.entries(data)) {
    const change = info.usd_24h_change;
    if (Math.abs(change) < threshold) continue;

    const direction = change > 0 ? "+" : "";
    stimuli.push({
      source: "coingecko",
      source_id: `${coin}_${today}`,
      stimulus_type: "market_move",
      urgency: clamp(Math.abs(change) / 30, 0.3, 0.9),
      content: `${coin} moved ${direction}${change.toFixed(1)}% in 24h, now $${info.usd.toLocaleString()}`,
      decay_halflife_hours: 2,
    });
  }
  return stimuli;
}

/**
 * Create an agent stimulus programmatically from other TS code.
 */
export async function createAgentStimulus(
  type: "agent_query" | "agent_success" | "agent_failure",
  content: string,
  nodeAddrs?: string[]
): Promise<void> {
  const urgencyMap = { agent_query: 0.3, agent_success: 0.5, agent_failure: 0.6 };
  const halflifeMap = { agent_query: 4, agent_success: 48, agent_failure: 24 };

  const stimulus: Stimulus = {
    source: "agent",
    source_id: `agent_${Date.now()}`,
    stimulus_type: type,
    urgency: urgencyMap[type],
    content,
    decay_halflife_hours: halflifeMap[type],
  };

  const embedding = await embedQuery(content);
  const vectorStr = toVectorStr(embedding);

  // F11: background agent intake — no request context, correlation_id NULL.
  await sql`
    INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, embedding, decay_halflife_hours, correlation_id, space_id)
    VALUES (
      ${stimulus.source}, ${stimulus.source_id}, ${stimulus.stimulus_type},
      ${stimulus.urgency}, ${stimulus.content}, ${vectorStr}::halfvec, ${stimulus.decay_halflife_hours!}, NULL, 'global'
    )
    ON CONFLICT (source, source_id) DO NOTHING
  `;

  console.log(`[AGENT] ${content.slice(0, 80)} (${type}, urgency=${stimulus.urgency}, ${stimulus.source_id})`);
}

// ============================================================
// DB Insert
// ============================================================

async function insertStimuli(stimuli: Stimulus[]): Promise<number> {
  let inserted = 0;
  for (const s of stimuli) {
    // Embed with rate limiting
    let vectorStr: string;
    try {
      const embedding = await embedQuery(s.content);
      vectorStr = toVectorStr(embedding);
    } catch (e) {
      console.error(`  [EMBED] Failed for "${s.content.slice(0, 60)}...": ${e}`);
      continue;
    }

    // F11: background HN/arxiv/coingecko intake — no request context, NULL.
    const result = await sql`
      INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, url, embedding, decay_halflife_hours, peak_delay_hours, correlation_id, space_id)
      VALUES (
        ${s.source}, ${s.source_id}, ${s.stimulus_type}, ${s.urgency},
        ${s.content}, ${s.url ?? null}, ${vectorStr}::halfvec,
        ${s.decay_halflife_hours ?? 24}, ${s.peak_delay_hours ?? 0}, NULL, 'global'
      )
      ON CONFLICT (source, source_id) DO NOTHING
      RETURNING id
    `;

    if (result.length > 0) {
      inserted++;
      console.log(`[${s.source.toUpperCase()}] ${s.content.slice(0, 80)} (${s.stimulus_type}, urgency=${s.urgency.toFixed(2)}, ${s.source_id})`);
    } else {
      console.log(`[${s.source.toUpperCase()}] SKIP (dup) ${s.source_id}`);
    }

    await sleep(1000); // Rate limit between embedding calls
  }
  return inserted;
}

// ============================================================
// Main
// ============================================================

const SOURCE_ADAPTERS: Record<string, () => Promise<Stimulus[]>> = {
  hackernews: fetchHackerNews,
  arxiv: fetchArxiv,
  coingecko: fetchCoinGecko,
};

async function main() {
  const sourceArg = process.argv.find((_, i) => process.argv[i - 1] === "--source");
  if (!sourceArg) {
    console.error("Usage: bun run miners/src/stimulus-intake.ts --source <hackernews|arxiv|coingecko|all> [--dry-run]");
    process.exit(1);
  }

  const sources = sourceArg === "all"
    ? Object.keys(SOURCE_ADAPTERS)
    : [sourceArg];

  for (const name of sources) {
    if (!SOURCE_ADAPTERS[name]) {
      console.error(`Unknown source: ${name}`);
      process.exit(1);
    }
  }

  const counts: Record<string, { fetched: number; inserted: number }> = {};
  let totalInserted = 0;

  for (const name of sources) {
    console.log(`\n--- Fetching ${name} ---`);
    const stimuli = await SOURCE_ADAPTERS[name]();
    counts[name] = { fetched: stimuli.length, inserted: 0 };
    console.log(`  Found ${stimuli.length} stimuli`);

    if (DRY_RUN) {
      for (const s of stimuli) {
        console.log(`  [DRY] ${s.content.slice(0, 80)} (${s.stimulus_type}, urgency=${s.urgency.toFixed(2)}, ${s.source_id})`);
      }
    } else {
      const inserted = await insertStimuli(stimuli);
      counts[name].inserted = inserted;
      totalInserted += inserted;
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  for (const [name, c] of Object.entries(counts)) {
    if (DRY_RUN) {
      console.log(`  ${name}: ${c.fetched} fetched (dry run, nothing inserted)`);
    } else {
      console.log(`  ${name}: ${c.fetched} fetched, ${c.inserted} inserted`);
    }
  }
  if (!DRY_RUN) {
    console.log(`  Total inserted: ${totalInserted}`);
  }

  await sql.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
