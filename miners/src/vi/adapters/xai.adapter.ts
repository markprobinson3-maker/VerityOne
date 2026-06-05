import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "xai",
  source_type: "web",
  description: "X/Twitter trending topics and search via free API alternatives",
  default_schedule: "0 */2 * * *",
  webhook_enabled: false,
  auth: { type: "api_key", key_env: "X_BEARER_TOKEN", required: false },

  async extract(input) {
    const mode = input.config?.mode || "trending";
    const chunks = [];

    if (mode === "search" && process.env.X_BEARER_TOKEN) {
      const query = input.config?.query || "AI agents";
      const resp = await fetch(`https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=20&tweet.fields=public_metrics,created_at,author_id`, {
        headers: { "Authorization": `Bearer ${process.env.X_BEARER_TOKEN}` },
      });
      const data: any = await resp.json();
      const text = (data.data || []).map((t: any) =>
        `[${t.public_metrics?.like_count || 0} likes | ${t.public_metrics?.retweet_count || 0} RT] ${t.text}`
      ).join("\n\n---\n\n");
      chunks.push({ content: `X Search: "${query}"\n\n${text}`, chunk_index: 0, chunk_total: 1, metadata: { mode, query } });
    } else {
      const topic = input.config?.topic || "technology";
      chunks.push({
        content: `X/Twitter trending: ${topic} — adapter needs X_BEARER_TOKEN or Apify scraper`,
        chunk_index: 0, chunk_total: 1,
        metadata: { mode, note: "Needs X_BEARER_TOKEN or Apify scraper" },
      });
    }

    return {
      title: `X: ${input.config?.query || "trending"} — ${new Date().toISOString().slice(0, 16)}`,
      source_id: `xai:${input.config?.query || "trending"}:${new Date().toISOString().slice(0, 13)}`,
      chunks,
    };
  },
};
