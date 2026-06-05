import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "bloomberg",
  source_type: "web",
  description: "Bloomberg-style financial news via free alternatives (MarketWatch, Yahoo Finance, Finnhub)",
  default_schedule: "0 7,12,17 * * 1-5",
  webhook_enabled: false,
  auth: { type: "api_key", key_env: "FINNHUB_API_KEY", required: false },

  async extract(input) {
    const provider = input.config?.provider || "finnhub";
    const chunks = [];

    if (provider === "finnhub" && process.env.FINNHUB_API_KEY) {
      const category = input.config?.category || "general";
      const resp = await fetch(`https://finnhub.io/api/v1/news?category=${category}&token=${process.env.FINNHUB_API_KEY}`);
      const articles: any[] = await resp.json();

      const text = articles.slice(0, 15).map((a) =>
        `[${a.source}] ${a.headline}\n${a.summary}\n${a.url}`
      ).join("\n\n---\n\n");

      chunks.push({
        content: `Financial News (${category}):\n\n${text}`,
        chunk_index: 0, chunk_total: 1,
        metadata: { provider, category, article_count: Math.min(articles.length, 15) },
      });
    } else {
      const resp = await fetch("https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US");
      const xml = await resp.text();
      const items = xml.split("<item>").slice(1, 11);
      const text = items.map(item => {
        const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
        const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";
        return `${title}\n${desc}`;
      }).join("\n\n---\n\n");

      chunks.push({ content: `Yahoo Finance Headlines:\n\n${text}`, chunk_index: 0, chunk_total: 1, metadata: { provider: "yahoo" } });
    }

    return {
      title: `Financial News — ${new Date().toISOString().slice(0, 16)}`,
      source_id: `bloomberg:${provider}:${new Date().toISOString().slice(0, 13)}`,
      chunks,
    };
  },
};
