const PDF_META_KEYS = [
  "citation_pdf_url",
  "pdf_url",
  "og:pdf",
  "eprints.document_url",
  "wkhealth_pdf_url",
];

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractMetaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return null;
}

function absolutize(baseUrl: string, candidate: string): string | null {
  if (!candidate) return null;
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function looksLikePdfUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith(".pdf")) return true;
    if (pathname.includes("/pdf/")) return true;
    if (url.hostname.includes("fetcher.alphaxiv.org") && pathname.includes("/pdf/")) return true;
    if (url.searchParams.has("pdf")) return true;
    if (url.searchParams.has("download")) return true;
    if (url.searchParams.has("format") && url.searchParams.get("format")?.toLowerCase() === "pdf") return true;
    return false;
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(candidate) || /\/pdf\//i.test(candidate);
  }
}

export function discoverEmbeddedPdfUrl(baseUrl: string, html: string): string | null {
  for (const key of PDF_META_KEYS) {
    const candidate = extractMetaContent(html, key);
    const absolute = candidate ? absolutize(baseUrl, candidate) : null;
    if (absolute && looksLikePdfUrl(absolute)) return absolute;
  }

  const linkMatch = html.match(/<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/pdf["']/i);
  if (linkMatch?.[1]) {
    const absolute = absolutize(baseUrl, decodeHtml(linkMatch[1].trim()));
    if (absolute && looksLikePdfUrl(absolute)) return absolute;
  }

  const anchorPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = decodeHtml(match[1].trim());
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const absolute = absolutize(baseUrl, href);
    if (!absolute || !looksLikePdfUrl(absolute)) continue;
    if (/pdf|download|full\s*text|paper/i.test(label) || /\/pdf\//i.test(href) || /\.pdf(?:[?#]|$)/i.test(href)) {
      return absolute;
    }
  }

  const rawPdfPattern = /https?:\/\/[^\s"'<>]+(?:\.pdf(?:[?#][^\s"'<>]*)?|\/pdf\/[^\s"'<>]+)/gi;
  for (const match of html.matchAll(rawPdfPattern)) {
    const candidate = decodeHtml(match[0]);
    if (looksLikePdfUrl(candidate)) return candidate;
  }

  return null;
}
