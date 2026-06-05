import type { ViAdapter } from "./types";
import { chunkText } from "./helpers";
import { extractPdfText } from "../../lib/pdf-extract";

export const adapter: ViAdapter = {
  name: "pdf",
  source_type: "pdf",
  description: "PDF text extraction via pdftotext",
  default_schedule: null,
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const resolved = input.source.startsWith("~")
      ? input.source.replace("~", process.env.HOME || "")
      : input.source;
    const { text, title, textParts } = await extractPdfText(resolved);
    const chunks = (textParts.length > 0 ? textParts : [text]).flatMap(part => chunkText(part));
    return {
      title,
      source_id: resolved.startsWith("http://") || resolved.startsWith("https://") ? resolved : `file://${resolved}`,
      chunks: chunks.map((c, i) => ({ content: c, chunk_index: i, chunk_total: chunks.length })),
    };
  },
};
