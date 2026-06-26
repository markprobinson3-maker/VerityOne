/**
 * Verity Ingest — Source detection + extraction adapters.
 *
 * Day 1 MVP: web, pdf, youtube
 * Week 2: arxiv, reddit, hn, github, audio, market_api, agent_dump
 */

import { existsSync } from "fs";
import { SOURCE_REGISTRY, type SourceProfile } from "./config";
import { ssrfGuardedFetch } from "../../../api/src/lib/ssrf-guard";
import { discoverEmbeddedPdfUrl } from "../lib/pdf-discovery";

// Cap the response body so an attacker-pointed URL can't OOM the ingester (batch-32 VI-3).
const WEB_FETCH_MAX_BYTES = Number(process.env.VERITY_HTML_URL_MAX_BYTES) || 5 * 1024 * 1024;
import { extractPdfText } from "../lib/pdf-extract";
import { extractRemoteDocument } from "../lib/web-html";

// ============================================================
// SOURCE DETECTION — rule-based, no LLM
// ============================================================

export function detectSourceType(input: string): string {
  // File path detection
  if (input.startsWith("/") || input.startsWith("~") || input.startsWith("./")) {
    if (input.endsWith(".pdf")) return "pdf";
    if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(input)) return "audio";
    return "web"; // local file treated as web (plain text)
  }

  // URL detection
  try {
    const url = new URL(input);
    const host = url.hostname.replace("www.", "");

    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("arxiv.org")) return "arxiv";
    if (host.includes("reddit.com")) return "reddit";
    if (host === "news.ycombinator.com") return "hn";
    if (host.includes("github.com")) return "github";

    return "web";
  } catch {
    // Not a URL — treat as file path
    if (input.endsWith(".pdf")) return "pdf";
    return "web";
  }
}

export function getSourceProfile(sourceType: string): SourceProfile {
  return SOURCE_REGISTRY[sourceType] || SOURCE_REGISTRY.web;
}

// ============================================================
// EXTRACTION ADAPTERS
// ============================================================

export interface ExtractionResult {
  text: string;
  title: string;
  source_id: string;
}

/**
 * Extract text content from a source input.
 */
export async function extractContent(input: string, sourceType: string): Promise<ExtractionResult> {
  switch (sourceType) {
    case "web":
      return input.startsWith("/") || input.startsWith("~") || input.startsWith("./")
        ? extractLocalFile(input)
        : extractWeb(input);
    case "pdf":
      return extractPdf(input);
    case "youtube":
      return extractYouTube(input);
    case "arxiv":
    case "reddit":
    case "hn":
    case "github":
    case "audio":
    case "market_api":
    case "agent_dump":
      throw new Error(`Source adapter "${sourceType}" not yet implemented. Coming in Week 2.`);
    default:
      throw new Error(`Unknown source type: ${sourceType}`);
  }
}

// --- Web adapter: fetch + strip HTML ---
async function extractWeb(url: string): Promise<ExtractionResult> {
  // ssrfGuardedFetch re-checks every redirect hop against the private-IP guard
  // (batch-32 VI-2) — a plain redirect:"follow" let a public URL 302 into an
  // internal address. The guard forces redirect:"manual" internally.
  const res = await ssrfGuardedFetch(url, {
    headers: { "User-Agent": "Verity-Ingest/0.5 (knowledge-graph)" },
  });

  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const declaredLen = parseInt(res.headers.get("content-length") || "0", 10);
  if (declaredLen > WEB_FETCH_MAX_BYTES) throw new Error(`Response too large (${declaredLen} bytes > ${WEB_FETCH_MAX_BYTES} cap)`);

  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();
  if (body.length > WEB_FETCH_MAX_BYTES) throw new Error(`Response too large (${body.length} bytes > ${WEB_FETCH_MAX_BYTES} cap)`);
  const extracted = extractRemoteDocument(url, body, { contentType });
  const embeddedPdfUrl = extracted.format === "html" ? discoverEmbeddedPdfUrl(url, body) : null;
  if (embeddedPdfUrl) {
    const pdf = await extractPdfText(embeddedPdfUrl, { titleHint: extracted.title });
    return { text: pdf.text, title: pdf.title, source_id: url };
  }

  if (extracted.text.length < 50) throw new Error("Extracted text too short (< 50 chars)");

  return { text: extracted.text, title: extracted.title, source_id: url };
}

// --- Local file adapter ---
async function extractLocalFile(path: string): Promise<ExtractionResult> {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME || "")
    : path;

  if (!existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const file = Bun.file(resolved);
  const text = await file.text();

  if (text.length < 50) throw new Error("File content too short (< 50 chars)");

  const title = resolved.split("/").pop() || resolved;
  return { text, title, source_id: `file://${resolved}` };
}

// --- PDF adapter: pdftotext ---
async function extractPdf(path: string): Promise<ExtractionResult> {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME || "")
    : path;

  const { text, title } = await extractPdfText(resolved);
  return {
    text,
    title,
    source_id: resolved.startsWith("http://") || resolved.startsWith("https://") ? resolved : `file://${resolved}`,
  };
}

// --- YouTube adapter: yt-dlp subtitles ---
async function extractYouTube(url: string): Promise<ExtractionResult> {
  const tmpDir = `/tmp/vi-yt-${Date.now()}`;
  await Bun.spawn(["mkdir", "-p", tmpDir]).exited;

  // Download auto-subtitles
  const proc = Bun.spawn([
    "yt-dlp",
    "--write-auto-sub",
    "--sub-lang", "en",
    "--skip-download",
    "--output", `${tmpDir}/%(id)s`,
    url,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  // Find and parse .vtt file
  const { stdout } = Bun.spawn(["find", tmpDir, "-name", "*.vtt"], { stdout: "pipe" });
  const vttFiles = (await new Response(stdout).text()).trim().split("\n").filter(Boolean);

  if (vttFiles.length === 0) {
    // Fallback: try .en.vtt
    const { stdout: stdout2 } = Bun.spawn(["find", tmpDir, "-type", "f"], { stdout: "pipe" });
    const allFiles = (await new Response(stdout2).text()).trim();
    throw new Error(`No subtitle files found. Files in ${tmpDir}: ${allFiles}`);
  }

  const vttContent = await Bun.file(vttFiles[0]).text();
  const text = parseVtt(vttContent);

  // Get title from yt-dlp
  const titleProc = Bun.spawn(["yt-dlp", "--get-title", url], { stdout: "pipe" });
  const title = (await new Response(titleProc.stdout).text()).trim() || url;

  // Cleanup
  Bun.spawn(["rm", "-rf", tmpDir]);

  if (text.length < 50) throw new Error("YouTube transcript too short (< 50 chars)");

  return { text, title, source_id: url };
}

// ============================================================
// CHUNKING — split text into ~1000 word chunks
// ============================================================

const TARGET_WORDS = 1000;
const MAX_WORDS = 1500;

export function chunkText(text: string): string[] {
  // Split on paragraph boundaries (double newline or single newline for dense text)
  let paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  // If we got very few paragraphs with lots of words, split further on single newlines
  const totalWords = text.split(/\s+/).length;
  if (paragraphs.length < 3 && totalWords > MAX_WORDS) {
    paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  }

  // If still too few (e.g. HTML-stripped text), split on sentence boundaries
  if (paragraphs.length < 3 && totalWords > MAX_WORDS) {
    paragraphs = text.split(/(?<=[.!?])\s+/).filter(p => p.trim().length > 0);
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;

    if (currentWordCount + paraWords > MAX_WORDS && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = [para];
      currentWordCount = paraWords;
    } else {
      current.push(para);
      currentWordCount += paraWords;

      if (currentWordCount >= TARGET_WORDS) {
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
    // Last resort: hard split by word count
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += TARGET_WORDS) {
      chunks.push(words.slice(i, i + TARGET_WORDS).join(" "));
    }
  }

  return chunks;
}

// ============================================================
// HELPERS
// ============================================================

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

function parseVtt(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let prev = "";

  for (const line of lines) {
    // Skip headers, timestamps, empty lines
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;

    // Remove VTT tags
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && clean !== prev) {
      textLines.push(clean);
      prev = clean;
    }
  }

  return textLines.join(" ");
}
