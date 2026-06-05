/**
 * WI Adapter — Hacker News.
 * Uses Firebase API. Fetches story + linked article (via web adapter) + top 30 comments (depth 3).
 * 100ms delay between fetches to be polite.
 */

import { extract as webExtract } from "./web";

const HN_API = "https://hacker-news.firebaseio.com/v0";

async function hnFetch(path: string): Promise<any> {
  const res = await fetch(`${HN_API}/${path}.json`);
  if (!res.ok) throw new Error(`HN API error ${res.status}: ${path}`);
  return res.json();
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface HNComment {
  by: string;
  text: string;
  replies: HNComment[];
}

async function fetchComments(ids: number[], maxDepth: number, currentDepth = 0): Promise<HNComment[]> {
  if (currentDepth >= maxDepth || ids.length === 0) return [];

  const limit = currentDepth === 0 ? 30 : 3;
  const comments: HNComment[] = [];

  for (const id of ids.slice(0, limit)) {
    await delay(100);
    try {
      const item = await hnFetch(`item/${id}`);
      if (!item || item.deleted || item.dead || !item.text) continue;

      const replies = item.kids
        ? await fetchComments(item.kids, maxDepth, currentDepth + 1)
        : [];

      comments.push({
        by: item.by || "anonymous",
        text: decodeHtml(item.text),
        replies,
      });
    } catch {
      continue;
    }
  }

  return comments;
}

function decodeHtml(html: string): string {
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, "")
    .trim();
}

function formatComments(comments: HNComment[], indent = 0): string {
  let text = "";
  for (const c of comments) {
    const prefix = "  ".repeat(indent);
    text += `${prefix}**${c.by}:** ${c.text}\n\n`;
    if (c.replies.length > 0) {
      text += formatComments(c.replies, indent + 1);
    }
  }
  return text;
}

function extractItemId(url: string): string {
  const u = new URL(url);
  const id = u.searchParams.get("id");
  if (!id) throw new Error(`Cannot extract item ID from HN URL: ${url}`);
  return id;
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const itemId = extractItemId(url);
  const story = await hnFetch(`item/${itemId}`);

  if (!story) throw new Error("HN item not found");

  let text = `# ${story.title || "Untitled"}\n\n`;
  text += `**By:** ${story.by || "unknown"} | **Score:** ${story.score || 0} | **Comments:** ${story.descendants || 0}\n\n`;

  // Fetch linked article if available
  if (story.url) {
    text += `**Link:** ${story.url}\n\n`;
    try {
      const article = await webExtract(story.url);
      text += `## Article Content\n\n${article.text}\n\n`;
    } catch {
      // Article fetch failed — continue with just the HN discussion
      text += `*(Article could not be fetched)*\n\n`;
    }
  }

  // Story text (for Ask HN, Show HN posts)
  if (story.text) {
    text += `## Post\n\n${decodeHtml(story.text)}\n\n`;
  }

  // Fetch comments
  if (story.kids && story.kids.length > 0) {
    text += `## Discussion (Top Comments)\n\n`;
    const comments = await fetchComments(story.kids, 3);
    text += formatComments(comments);
  }

  if (text.length < 50) throw new Error("HN content too short");

  return { text, title: story.title || `HN Item ${itemId}` };
}
