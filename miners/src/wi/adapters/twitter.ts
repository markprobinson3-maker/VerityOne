/**
 * WI Adapter — Twitter/X thread extraction.
 * Strategy: Try nitter instances first, fallback to direct web fetch + strip.
 * Stitches thread replies. 10s timeout.
 */

const NITTER_INSTANCES = [
  "nitter.privacydev.net",
  "nitter.poast.org",
  "nitter.cz",
];

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
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

function extractTweetPath(url: string): string {
  const u = new URL(url);
  return u.pathname;
}

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WorldIngestor/2.0)" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function tryNitter(tweetPath: string): Promise<{ text: string; title: string } | null> {
  for (const instance of NITTER_INSTANCES) {
    try {
      const html = await fetchWithTimeout(`https://${instance}${tweetPath}`, 8_000);

      const tweetTexts: string[] = [];

      // Extract tweet-content divs
      const mainMatches = html.matchAll(/<div[^>]*class="[^"]*tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi);
      for (const match of mainMatches) {
        const clean = stripHtml(match[1]);
        if (clean.length > 10) tweetTexts.push(clean);
      }

      if (tweetTexts.length === 0) continue;

      const title = tweetTexts[0].slice(0, 80) + (tweetTexts[0].length > 80 ? "..." : "");
      return { text: tweetTexts.join("\n\n---\n\n"), title };
    } catch {
      continue;
    }
  }
  return null;
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const tweetPath = extractTweetPath(url);

  // Try nitter instances first
  const nitterResult = await tryNitter(tweetPath);
  if (nitterResult && nitterResult.text.length >= 50) {
    return nitterResult;
  }

  // Fallback: direct web fetch
  const html = await fetchWithTimeout(url, 10_000);
  const text = stripHtml(html);

  if (text.length < 50) throw new Error("Could not extract tweet content — page too short or blocked");

  const title = html.match(/<title[^>]*>(.*?)<\/title>/si)?.[1]?.trim() || url;
  return { text, title };
}
