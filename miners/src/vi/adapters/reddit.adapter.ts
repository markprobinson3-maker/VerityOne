import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "reddit",
  source_type: "reddit",
  description: "Reddit subreddit scraper — top posts + comments",
  default_schedule: "0 */6 * * *",
  webhook_enabled: true,
  auth: { type: "none", required: false },

  async extract(input) {
    const subreddit = input.config?.subreddit || input.source || "machinelearning";
    const sort = input.config?.sort || "hot";
    const limit = input.config?.limit || 10;
    const commentDepth = input.config?.comment_depth || 3;

    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
    const resp = await fetch(url, { headers: { "User-Agent": "VerityIngest/1.0" } });
    const data: any = await resp.json();

    const chunks = [];
    for (const post of data.data.children) {
      const p = post.data;
      let text = `[${p.score} pts | ${p.num_comments} comments] ${p.title}\n`;
      if (p.selftext) text += `\n${p.selftext}\n`;
      if (p.url && !p.url.includes("reddit.com")) text += `\nLink: ${p.url}\n`;

      if (commentDepth > 0) {
        try {
          const commResp = await fetch(`https://www.reddit.com${p.permalink}.json?limit=${commentDepth}`,
            { headers: { "User-Agent": "VerityIngest/1.0" } });
          const commData: any = await commResp.json();
          const comments = commData[1]?.data?.children?.slice(0, commentDepth) || [];
          for (const c of comments) {
            if (c.data?.body) text += `\n> [${c.data.score} pts] ${c.data.body}\n`;
          }
        } catch {}
      }

      chunks.push({
        content: text,
        chunk_index: chunks.length,
        chunk_total: limit,
        metadata: { subreddit, post_id: p.id, score: p.score, url: p.url },
      });
    }

    return {
      title: `r/${subreddit} ${sort} ${limit} — ${new Date().toISOString().slice(0, 10)}`,
      source_id: `reddit:${subreddit}:${sort}:${new Date().toISOString().slice(0, 13)}`,
      chunks,
    };
  },
};
