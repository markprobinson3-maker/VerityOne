import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "hn-top",
  source_type: "hn",
  description: "Hacker News top stories — titles + top comments",
  default_schedule: "0 */4 * * *",
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const limit = input.config?.limit || 10;
    const topIds: number[] = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json());
    const stories = await Promise.all(
      topIds.slice(0, limit).map(async (id) => {
        const story: any = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json());
        return `[${story.score} pts] ${story.title}\n${story.url || ""}\n${story.text || ""}`;
      })
    );
    return {
      title: `HN Top ${limit} — ${new Date().toISOString().slice(0, 10)}`,
      source_id: `hn:top:${new Date().toISOString().slice(0, 13)}`,
      chunks: [{ content: stories.join("\n\n---\n\n"), chunk_index: 0, chunk_total: 1 }],
    };
  },
};
