import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "apify",
  source_type: "web",
  description: "Apify scraper results — accepts webhook POST or pulls from dataset",
  default_schedule: null,
  webhook_enabled: true,
  auth: { type: "api_key", key_env: "APIFY_API_KEY", required: false },

  async extract(input) {
    // Webhook payload: Apify sends dataset items directly
    if (input.webhook_payload?.items) {
      const items = input.webhook_payload.items;
      const chunks = items.map((item: any, i: number) => ({
        content: item.text || item.body || JSON.stringify(item),
        chunk_index: i,
        chunk_total: items.length,
        metadata: { url: item.url, title: item.title },
      }));
      return {
        title: input.webhook_payload.datasetName || "Apify Scrape",
        source_id: `apify:${input.webhook_payload.datasetId || Date.now()}`,
        chunks,
      };
    }

    // Dataset URL: pull items from Apify API
    if (input.source) {
      const resp = await fetch(input.source);
      const items: any[] = await resp.json();
      const chunks = items.map((item, i) => ({
        content: item.text || item.body || JSON.stringify(item),
        chunk_index: i,
        chunk_total: items.length,
        metadata: { url: item.url, title: item.title },
      }));
      return {
        title: "Apify Dataset",
        source_id: `apify:${input.source}`,
        chunks,
      };
    }

    return { title: "Apify Dataset", source_id: `apify:${Date.now()}`, chunks: [] };
  },
};
