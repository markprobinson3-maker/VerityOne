import type { ViAdapter } from "./types";
import { normalizeRssFeedUrl } from "../rss-url";

export const adapter: ViAdapter = {
  name: "rss",
  source_type: "rss",
  description: "Generic RSS/Atom feed reader — works with any RSS feed URL",
  default_schedule: "0 */4 * * *",
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const feedUrl = normalizeRssFeedUrl(input.source || input.config?.feed_url || "");
    const maxItems = input.config?.max_items || 15;

    const resp = await fetch(feedUrl);
    const xml = await resp.text();

    const items = xml.includes("<entry>")
      ? xml.split("<entry>").slice(1)
      : xml.split("<item>").slice(1);

    const chunks = items.slice(0, maxItems).map((item, i) => {
      const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || "";
      const desc = item.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/)?.[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() || "";
      const link = item.match(/<link[^>]*(?:href="([^"]+)"[^>]*\/?>|>([\s\S]*?)<\/link>)/)?.[1] ||
                   item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || "";
      const pubDate = item.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1]?.trim() || "";

      return {
        content: `${title}\n${pubDate}\n${link}\n\n${desc}`,
        chunk_index: i,
        chunk_total: Math.min(items.length, maxItems),
        metadata: { title, link, pubDate },
      };
    });

    const feedTitle = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || feedUrl;
    return {
      title: `RSS: ${feedTitle}`,
      source_id: `rss:${feedUrl}:${new Date().toISOString().slice(0, 13)}`,
      chunks,
    };
  },
};
