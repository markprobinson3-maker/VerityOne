/**
 * Verity Ingest — Shared adapter helpers
 *
 * HTML stripping, VTT parsing, text chunking.
 * Extracted from sources.ts for reuse across adapters.
 */

export function stripHtml(html: string): string {
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

export function extractTitle(html: string): string {
  return html.match(/<title[^>]*>(.*?)<\/title>/si)?.[1]?.trim() || "";
}

export function parseVtt(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let prev = "";

  for (const line of lines) {
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;

    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && clean !== prev) {
      textLines.push(clean);
      prev = clean;
    }
  }

  return textLines.join(" ");
}

const TARGET_WORDS = 1000;
const MAX_WORDS = 1500;

export function chunkText(text: string, target = TARGET_WORDS, max = MAX_WORDS): string[] {
  let paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  const totalWords = text.split(/\s+/).length;
  if (paragraphs.length < 3 && totalWords > max) {
    paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  }
  if (paragraphs.length < 3 && totalWords > max) {
    paragraphs = text.split(/(?<=[.!?])\s+/).filter(p => p.trim().length > 0);
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;

    if (currentWordCount + paraWords > max && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = [para];
      currentWordCount = paraWords;
    } else {
      current.push(para);
      currentWordCount += paraWords;

      if (currentWordCount >= target) {
        chunks.push(current.join("\n\n"));
        current = [];
        currentWordCount = 0;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  if (chunks.length === 0 && text.trim().length > 0) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += target) {
      chunks.push(words.slice(i, i + target).join(" "));
    }
  }

  return chunks;
}
