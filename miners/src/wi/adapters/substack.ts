/**
 * WI Adapter — Substack / newsletters.
 * Web fetch + HTML strip. Detects paywall (<500 chars → mark partial).
 * Supports: substack.com, beehiiv.com, buttondown.email, convertkit.com
 */

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WorldIngestor/2.0)" },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const html = await res.text();
    const title = html.match(/<title[^>]*>(.*?)<\/title>/si)?.[1]?.trim() || url;

    // Try to extract just the article body for cleaner content
    let articleHtml = html;

    // Substack: look for article or post-content div
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
      || html.match(/<div[^>]*class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<div[^>]*class="[^"]*body[^"]*markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (articleMatch) {
      articleHtml = articleMatch[1];
    }

    let text = stripHtml(articleHtml);

    // Paywall detection
    if (text.length < 500) {
      // Likely paywalled — still return what we have, but note it
      text = `[PARTIAL — possible paywall, only ${text.length} chars extracted]\n\n${text}`;
    }

    if (text.length < 50) throw new Error("Newsletter content too short (< 50 chars), possibly paywalled");

    return { text, title };
  } finally {
    clearTimeout(timer);
  }
}
