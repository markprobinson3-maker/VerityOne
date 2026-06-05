/**
 * WI Adapter — DOI resolver.
 * Follows doi.org redirect → detects publisher → delegates to correct adapter.
 */

import * as arxivAdapter from "./arxiv";
import * as pdfAdapter from "./pdf";
import * as webAdapter from "./web";

async function resolveDOI(url: string): Promise<{ resolvedUrl: string; adapter: string }> {
  // Extract DOI from URL
  const doiMatch = url.match(/doi\.org\/(10\.\d{4,}\/[^\s?#]+)/);
  const doi = doiMatch ? doiMatch[1] : url.replace(/^https?:\/\/doi\.org\//, "");

  const response = await fetch(`https://doi.org/${doi}`, {
    redirect: "manual",
    headers: { "User-Agent": "WorldIngestor/2.0" },
  });
  const location = response.headers.get("location") ?? "";

  if (!location) throw new Error(`DOI ${doi} did not redirect`);

  // Map publisher to adapter
  if (location.includes("arxiv.org")) return { resolvedUrl: location, adapter: "arxiv" };
  if (location.includes("openreview.net")) return { resolvedUrl: location, adapter: "pdf" };
  if (location.includes("aclanthology.org")) return { resolvedUrl: location, adapter: "pdf" };
  if (location.includes("biorxiv.org") || location.includes("medrxiv.org")) return { resolvedUrl: location, adapter: "pdf" };

  // Generic: try PDF link, fall back to web
  if (location.endsWith(".pdf")) return { resolvedUrl: location, adapter: "pdf" };
  return { resolvedUrl: location, adapter: "web" };
}

const DELEGATE: Record<string, { extract: (url: string) => Promise<{ text: string; title: string; metadata?: Record<string, any> }> }> = {
  arxiv: arxivAdapter,
  pdf: pdfAdapter,
  web: webAdapter,
};

export async function extract(url: string): Promise<{ text: string; title: string; metadata?: Record<string, any> }> {
  const { resolvedUrl, adapter } = await resolveDOI(url);
  console.log(`[WI] DOI resolved → ${adapter}: ${resolvedUrl}`);

  const delegate = DELEGATE[adapter] || webAdapter;
  const result = await delegate.extract(resolvedUrl);
  return { ...result, metadata: { ...result.metadata, doi: url, resolvedUrl, resolvedAdapter: adapter } };
}
