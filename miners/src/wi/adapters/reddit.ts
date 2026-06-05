/**
 * WI Adapter — Reddit.
 * Uses old.reddit.com JSON API (.json suffix).
 * Fetches post + top 30 comments + 3 replies each.
 * 20s timeout. Backoff on 429.
 */

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeRedditUrl(url: string): string {
  const u = new URL(url);
  // Convert to old.reddit.com
  let path = u.pathname;
  // Strip trailing slash
  path = path.replace(/\/+$/, "");
  return `https://old.reddit.com${path}.json`;
}

interface RedditComment {
  author: string;
  body: string;
  score: number;
  replies: RedditComment[];
}

function extractComments(data: any, maxTopLevel: number, maxReplies: number): RedditComment[] {
  if (!data?.data?.children) return [];

  const comments: RedditComment[] = [];

  for (const child of data.data.children.slice(0, maxTopLevel)) {
    if (child.kind !== "t1" || !child.data) continue;
    const d = child.data;
    if (d.author === "[deleted]" && d.body === "[removed]") continue;

    const replies = d.replies
      ? extractComments(d.replies, maxReplies, 0)
      : [];

    comments.push({
      author: d.author || "[deleted]",
      body: decodeHtml(d.body || ""),
      score: d.score || 0,
      replies,
    });
  }

  return comments;
}

function formatComments(comments: RedditComment[], indent = 0): string {
  let text = "";
  for (const c of comments) {
    const prefix = "  ".repeat(indent);
    text += `${prefix}**${c.author}** (${c.score} pts): ${c.body}\n\n`;
    if (c.replies.length > 0) {
      text += formatComments(c.replies, indent + 1);
    }
  }
  return text;
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const jsonUrl = normalizeRedditUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "WorldIngestor/2.0 (knowledge-graph bot)",
      },
    });

    // Handle rate limiting
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5");
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      // Retry once
      const retryRes = await fetch(jsonUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "WorldIngestor/2.0 (knowledge-graph bot)" },
      });
      if (!retryRes.ok) throw new Error(`Reddit API error ${retryRes.status} after retry`);
      const retryData = await retryRes.json();
      return processRedditData(retryData, url);
    }

    if (!res.ok) throw new Error(`Reddit API error ${res.status}`);

    const data = await res.json();
    return processRedditData(data, url);
  } finally {
    clearTimeout(timer);
  }
}

function processRedditData(data: any, url: string): { text: string; title: string } {
  if (!Array.isArray(data) || data.length < 1) {
    throw new Error("Invalid Reddit API response");
  }

  const post = data[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error("No post data found");

  let text = `# ${post.title || "Untitled"}\n\n`;
  text += `**By:** u/${post.author || "[deleted]"} | **Score:** ${post.score || 0} | **Comments:** ${post.num_comments || 0}\n`;
  text += `**Subreddit:** r/${post.subreddit}\n\n`;

  // Post body (self text or link)
  if (post.selftext) {
    text += decodeHtml(post.selftext) + "\n\n";
  } else if (post.url && !post.url.includes("reddit.com")) {
    text += `**Link:** ${post.url}\n\n`;
  }

  // Comments (second element in array)
  if (data.length >= 2) {
    text += "## Comments\n\n";
    const comments = extractComments(data[1], 30, 3);
    text += formatComments(comments);
  }

  if (text.length < 50) throw new Error("Reddit content too short");

  return { text, title: post.title || `Reddit Post` };
}
