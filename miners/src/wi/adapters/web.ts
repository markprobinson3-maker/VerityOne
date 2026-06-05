/**
 * WI Adapter — Generic web fetch + HTML strip.
 * HTML defaults stay conservative; plain-text dumps get a larger budget and multipart split.
 */

import { discoverEmbeddedPdfUrl } from "../../lib/pdf-discovery";
import { extractPdfText } from "../../lib/pdf-extract";
import { extractRemoteDocument } from "../../lib/web-html";

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HTML_MAX_BYTES = readPositiveInt(process.env.VERITY_HTML_URL_MAX_BYTES, 5 * 1024 * 1024);
const TEXT_MAX_BYTES = readPositiveInt(process.env.VERITY_TEXT_URL_MAX_BYTES, 100 * 1024 * 1024);

export async function extract(url: string): Promise<{ text: string; title: string; textParts?: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "WorldIngestor/2.0 (knowledge-graph)" },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const contentType = res.headers.get("content-type") || "";
    const allowsTextBudget = contentType.toLowerCase().includes("text/plain") || /\.txt(?:[?#]|$)/i.test(url);
    const maxBytes = allowsTextBudget ? TEXT_MAX_BYTES : HTML_MAX_BYTES;
    const contentLength = parseInt(res.headers.get("content-length") || "0");
    if (contentLength > maxBytes) throw new Error(`Response too large: ${contentLength} bytes (max ${maxBytes})`);

    const body = await res.text();
    if (body.length > maxBytes) throw new Error(`Response too large: ${body.length} chars`);

    const extracted = extractRemoteDocument(url, body, { contentType });
    const embeddedPdfUrl = extracted.format === "html" ? discoverEmbeddedPdfUrl(url, body) : null;
    if (embeddedPdfUrl) {
      const pdf = await extractPdfText(embeddedPdfUrl, { titleHint: extracted.title });
      return { text: pdf.text, title: pdf.title, textParts: pdf.textParts };
    }

    if (extracted.text.length < 50) throw new Error("Extracted text too short (< 50 chars)");

    return { text: extracted.text, title: extracted.title, textParts: extracted.textParts };
  } finally {
    clearTimeout(timeout);
  }
}
