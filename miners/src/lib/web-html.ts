function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTextPartCharLimit(): number {
  return readPositiveInt(process.env.VERITY_TEXT_PART_CHAR_LIMIT, 120_000);
}

function splitTextIntoBoundedParts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).filter(Boolean);
  if (paragraphs.length <= 1) {
    const hardParts: string[] = [];
    for (let i = 0; i < trimmed.length; i += maxChars) {
      hardParts.push(trimmed.slice(i, i + maxChars).trim());
    }
    return hardParts.filter(Boolean);
  }

  const parts: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      parts.push(current.trim());
      current = paragraph;
      continue;
    }
    if (candidate.length > maxChars) {
      const chunks = splitTextIntoBoundedParts(paragraph, maxChars);
      parts.push(...chunks);
      current = "";
      continue;
    }
    current = candidate;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function decodeFragment(hash: string): string {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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

function basenameTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/\.[^.]+$/i, "");
    return last || url;
  } catch {
    return url;
  }
}

function looksLikeHtmlDocument(body: string, contentType = ""): boolean {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes("text/html") || lowerType.includes("application/xhtml+xml")) return true;
  const sample = body.slice(0, 4096).toLowerCase();
  return /<!doctype html|<html\b|<head\b|<body\b|<title\b|<article\b|<main\b|<div\b|<p\b|<h1\b/.test(sample);
}

function stripProjectGutenbergBoilerplate(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const startMatch = normalized.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i);
  const endMatch = normalized.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i);
  const start = startMatch ? startMatch.index! + startMatch[0].length : 0;
  const end = endMatch ? endMatch.index! : normalized.length;
  const sliced = normalized.slice(start, end).trim();
  return sliced || normalized.trim();
}

function normalizePlainTextTitle(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

function derivePlainTextTitle(url: string, rawText: string, text: string): string {
  const source = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  const explicitTitle = source.match(/^Title:\s*(.+)$/im)?.[1]?.trim();
  if (explicitTitle) return normalizePlainTextTitle(explicitTitle);

  const gutenbergTitle = source.match(/The Project Gutenberg eBook of\s+(.+?)(?:, by\b|, translated by\b|, edited by\b|,|\n|$)/i)?.[1]?.trim();
  if (gutenbergTitle) return gutenbergTitle;

  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 20)) {
    if (line.length < 4 || line.length > 140) continue;
    if (/^project gutenberg/i.test(line)) continue;
    if (/^(title|author|translator|illustrator|release date|language|credits|produced by)\b/i.test(line)) continue;
    if (/^(university .* bulletin|no\.\s*\d+[:.]|translated by|adjunct professor|comparative literature series|published by)\b/i.test(line)) continue;
    return normalizePlainTextTitle(line);
  }

  return basenameTitle(url);
}

export function extractPlainTextDocument(url: string, body: string): { text: string; title: string; textParts: string[] } {
  const normalized = stripProjectGutenbergBoilerplate(body)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = normalized;
  const title = derivePlainTextTitle(url, body, normalized);
  const textParts = splitTextIntoBoundedParts(text, resolveTextPartCharLimit());
  return {
    text,
    title,
    textParts: textParts.length > 0 ? textParts : [text],
  };
}

function findSectionEndByHeading(html: string, start: number, level: number): number {
  const rest = html.slice(start);
  const nextHeading = new RegExp(`<h([1-${level}])\\b`, "ig");
  const match = nextHeading.exec(rest);
  return match ? start + match.index : html.length;
}

function sliceHeadingSection(html: string, fragment: string): string | null {
  const escaped = escapeRegex(fragment);
  const anchorPattern = new RegExp(`\\b(?:id|name)\\s*=\\s*["']${escaped}["']`, "i");
  const anchorMatch = anchorPattern.exec(html);
  if (!anchorMatch) return null;

  const headingOpen = /<h([1-6])\b[^>]*>/ig;
  let match: RegExpExecArray | null;
  let containingHeading: { start: number; after: number; level: number } | null = null;

  while ((match = headingOpen.exec(html)) && match.index <= anchorMatch.index) {
    const level = Number(match[1] || "6");
    const closeTag = new RegExp(`</h${level}>`, "ig");
    closeTag.lastIndex = headingOpen.lastIndex;
    const closeMatch = closeTag.exec(html);
    if (!closeMatch) continue;
    const closeIndex = closeMatch.index + closeMatch[0].length;
    if (closeMatch.index >= anchorMatch.index) {
      containingHeading = { start: match.index, after: closeIndex, level };
    }
  }

  if (!containingHeading) return null;

  const end = findSectionEndByHeading(html, containingHeading.after, containingHeading.level);
  return html.slice(containingHeading.start, end);
}

function sliceAnchoredElementSection(html: string, fragment: string): string | null {
  const escaped = escapeRegex(fragment);
  const elementPattern = new RegExp(`<([a-z0-9:-]+)\\b[^>]*\\b(?:id|name)\\s*=\\s*["']${escaped}["'][^>]*>`, "i");
  const match = elementPattern.exec(html);
  if (!match) return null;

  const start = match.index;
  const after = start + match[0].length;
  const headingAfter = /<h([1-6])\b[^>]*>/ig;
  headingAfter.lastIndex = after;
  const headingMatch = headingAfter.exec(html);
  if (headingMatch && headingMatch.index - after < 2000) {
    const level = Number(headingMatch[1] || "6");
    const closeTag = new RegExp(`</h${level}>`, "ig");
    closeTag.lastIndex = headingAfter.lastIndex;
    const closeMatch = closeTag.exec(html);
    if (closeMatch) {
      const headingEnd = closeMatch.index + closeMatch[0].length;
      const end = findSectionEndByHeading(html, headingEnd, level);
      return html.slice(headingMatch.index, end);
    }
  }

  const rest = html.slice(after);
  const boundaries = [
    /<h[1-6]\b/ig,
    /<(?:section|article|div)\b[^>]*\b(?:id|name)\s*=\s*["']/ig,
  ];

  let end = html.length;
  for (const boundary of boundaries) {
    const next = boundary.exec(rest);
    if (next) end = Math.min(end, after + next.index);
  }

  return html.slice(start, end);
}

export function extractAnchoredHtml(url: string, html: string): { html: string; narrowed: boolean } {
  let fragment = "";
  try {
    fragment = decodeFragment(new URL(url).hash);
  } catch {
    fragment = "";
  }

  if (!fragment) return { html, narrowed: false };

  const section = sliceHeadingSection(html, fragment) || sliceAnchoredElementSection(html, fragment);
  if (!section) return { html, narrowed: false };

  const sectionText = stripHtml(section);
  if (sectionText.length < 50) return { html, narrowed: false };

  return { html: section, narrowed: true };
}

export function extractWebText(url: string, html: string): { text: string; title: string; narrowedToFragment: boolean } {
  const title = extractTitle(html) || url;
  const narrowed = extractAnchoredHtml(url, html);
  return {
    title,
    text: stripHtml(narrowed.html),
    narrowedToFragment: narrowed.narrowed,
  };
}

export function extractRemoteDocument(
  url: string,
  body: string,
  opts: { contentType?: string } = {},
): { text: string; title: string; textParts: string[]; narrowedToFragment: boolean; format: "html" | "plain_text" } {
  if (!looksLikeHtmlDocument(body, opts.contentType || "")) {
    const extracted = extractPlainTextDocument(url, body);
    return {
      ...extracted,
      narrowedToFragment: false,
      format: "plain_text",
    };
  }

  const extracted = extractWebText(url, body);
  return {
    text: extracted.text,
    title: extracted.title,
    textParts: splitTextIntoBoundedParts(extracted.text, resolveTextPartCharLimit()),
    narrowedToFragment: extracted.narrowedToFragment,
    format: "html",
  };
}
