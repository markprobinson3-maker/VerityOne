import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "apewisdom",
  source_type: "reddit",
  description: "ApeWisdom trending tickers from Reddit/StockTwits — tracks retail sentiment",
  default_schedule: "0 */4 * * *",
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const filter = input.config?.filter || "all-stocks";
    const limit = input.config?.limit || 20;

    const resp = await fetch(`https://apewisdom.io/api/v1.0/filter/${filter}/page/1`);
    const data: any = await resp.json();
    const results = data.results?.slice(0, limit) || [];

    let text = `ApeWisdom Trending (${filter}):\n\n`;
    for (const r of results) {
      text += `${r.rank}. $${r.ticker} — ${r.mentions} mentions (${r.mentions_24h_ago} 24h ago) | `;
      text += `Upvotes: ${r.upvotes} | Name: ${r.name}\n`;
    }

    return {
      title: `ApeWisdom: ${filter} top ${limit} — ${new Date().toISOString().slice(0, 16)}`,
      source_id: `apewisdom:${filter}:${new Date().toISOString().slice(0, 13)}`,
      chunks: [{ content: text, chunk_index: 0, chunk_total: 1, metadata: { filter, count: results.length } }],
    };
  },
};
