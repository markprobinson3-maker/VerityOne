import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "arxiv",
  source_type: "arxiv",
  description: "arXiv paper search — abstracts + metadata from recent papers",
  default_schedule: "0 8 * * *",
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const query = input.config?.query || input.source || "cat:cs.AI";
    const maxResults = input.config?.max_results || 20;
    const sortBy = input.config?.sort_by || "submittedDate";

    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=${sortBy}&sortOrder=descending&max_results=${maxResults}`;
    const resp = await fetch(url);
    const xml = await resp.text();

    const entries = xml.split("<entry>").slice(1);
    const chunks = entries.map((entry, i) => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || "Untitled";
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || "";
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim());
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || "";
      const arxivId = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || "";
      const categories = [...entry.matchAll(/term="([^"]+)"/g)].map(m => m[1]);

      const text = `${title}\nAuthors: ${authors.join(", ")}\nPublished: ${published}\nCategories: ${categories.join(", ")}\n\n${summary}`;

      return {
        content: text,
        chunk_index: i,
        chunk_total: entries.length,
        metadata: { arxiv_id: arxivId, authors, categories, published },
      };
    });

    return {
      title: `arXiv: ${query} (${chunks.length} papers) — ${new Date().toISOString().slice(0, 10)}`,
      source_id: `arxiv:${query}:${new Date().toISOString().slice(0, 10)}`,
      chunks,
    };
  },
};
