/**
 * WI Adapter — PDF text extraction via pdftotext.
 * Uses the shared PDF policy. Supports both local files and URLs.
 */

import { extractPdfText } from "../../lib/pdf-extract";

export async function extract(url: string): Promise<{ text: string; title: string; textParts?: string[] }> {
  return extractPdfText(url);
}
