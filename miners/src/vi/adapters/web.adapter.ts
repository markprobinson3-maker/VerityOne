import type { ViAdapter } from "./types";
import { chunkText } from "./helpers";
import { discoverEmbeddedPdfUrl } from "../../lib/pdf-discovery";
import { extractPdfText } from "../../lib/pdf-extract";
import { extractRemoteDocument } from "../../lib/web-html";

export const adapter: ViAdapter = {
  name: "web",
  source_type: "web",
  description: "Generic web page extractor via readability",
  default_schedule: null,
  webhook_enabled: true,
  auth: { type: "none", required: false },

  async extract(input) {
    const source = input.source;

    // Local file
    if (source.startsWith("/") || source.startsWith("~") || source.startsWith("./")) {
      const resolved = source.startsWith("~")
        ? source.replace("~", process.env.HOME || "")
        : source;
      const text = await Bun.file(resolved).text();
      if (text.length < 50) throw new Error("File content too short (< 50 chars)");
      const title = resolved.split("/").pop() || resolved;
      const chunks = chunkText(text);
      return {
        title,
        source_id: `file://${resolved}`,
        chunks: chunks.map((c, i) => ({ content: c, chunk_index: i, chunk_total: chunks.length })),
      };
    }

    // Remote URL
    const resp = await fetch(source, {
      headers: { "User-Agent": "Verity-Ingest/0.5 (knowledge-graph)" },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);

    const contentType = resp.headers.get("content-type") || "";
    const body = await resp.text();
    const extracted = extractRemoteDocument(source, body, { contentType });
    const embeddedPdfUrl = extracted.format === "html" ? discoverEmbeddedPdfUrl(source, body) : null;
    if (embeddedPdfUrl) {
      const pdf = await extractPdfText(embeddedPdfUrl, { titleHint: extracted.title });
      const chunks = (pdf.textParts.length > 0 ? pdf.textParts : [pdf.text]).flatMap(part => chunkText(part));
      return {
        title: pdf.title,
        source_id: source,
        chunks: chunks.map((c, i) => ({ content: c, chunk_index: i, chunk_total: chunks.length })),
      };
    }

    if (extracted.text.length < 50) throw new Error("Extracted text too short (< 50 chars)");

    const chunks = (extracted.textParts.length > 0 ? extracted.textParts : [extracted.text]).flatMap(part => chunkText(part));
    return {
      title: extracted.title,
      source_id: source,
      chunks: chunks.map((c, i) => ({ content: c, chunk_index: i, chunk_total: chunks.length })),
    };
  },
};
