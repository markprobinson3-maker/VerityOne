/**
 * WI Adapter — arXiv papers.
 * Converts URL to PDF link, downloads, extracts via pdftotext.
 * Falls back to abstract page if pdftotext fails.
 * Limit: 100 pages.
 */

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
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

interface ArxivMeta {
  title: string;
  abstract: string;
  subjects: string;
  pages: number;
  id: string;
}

async function prescreenArxiv(paperId: string): Promise<{ skip: boolean; reason?: string; metadata?: ArxivMeta }> {
  const absUrl = `https://arxiv.org/abs/${paperId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(absUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "WorldIngestor/2.0" },
    });
    if (!res.ok) return { skip: false }; // Can't pre-screen, proceed anyway
    const html = await res.text();

    const title = html.match(/<meta name="citation_title" content="([^"]+)"/)?.[1]
      ?? html.match(/<h1 class="title[^"]*"[^>]*>[\s\S]*?<span[^>]*>Title:<\/span>\s*([\s\S]*?)<\/h1>/i)?.[1]?.trim()
      ?? "";
    const abstract = html.match(/<meta name="citation_abstract" content="([^"]+)"/)?.[1]
      ?? html.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/^Abstract:\s*/i, "")
      ?? "";
    const subjects = html.match(/Subjects:.*?<span[^>]*>(.*?)<\/span>/s)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    const pageInfo = html.match(/(\d+)\s*pages/)?.[1];
    const pages = parseInt(pageInfo ?? "0");

    if (pages > 0 && pages < 3) return { skip: true, reason: `Too short (${pages} pages)` };
    if (pages > 200) return { skip: true, reason: `Too long (${pages} pages), queue for chunked processing` };

    return { skip: false, metadata: { title: stripHtml(title), abstract, subjects, pages, id: paperId } };
  } catch {
    return { skip: false }; // Pre-screen failed, proceed without it
  } finally {
    clearTimeout(timer);
  }
}

function toPdfUrl(url: string): string {
  // https://arxiv.org/abs/2301.12345 → https://arxiv.org/pdf/2301.12345
  // https://arxiv.org/pdf/2301.12345 → already PDF
  const u = new URL(url);
  const path = u.pathname;

  if (path.startsWith("/pdf/")) return url;

  // /abs/ID → /pdf/ID
  const absMatch = path.match(/\/abs\/(.+)/);
  if (absMatch) return `https://arxiv.org/pdf/${absMatch[1]}`;

  // /html/ID → /pdf/ID
  const htmlMatch = path.match(/\/html\/(.+)/);
  if (htmlMatch) return `https://arxiv.org/pdf/${htmlMatch[1]}`;

  // Fallback — try appending .pdf
  return url.replace(/\/?$/, ".pdf");
}

function toAbsUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname;
  const idMatch = path.match(/\/(abs|pdf|html)\/(.+?)(?:\.pdf)?$/);
  if (idMatch) return `https://arxiv.org/abs/${idMatch[2]}`;
  return url;
}

async function extractAbstract(url: string): Promise<{ text: string; title: string }> {
  const absUrl = toAbsUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(absUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "WorldIngestor/2.0" },
    });
    if (!res.ok) throw new Error(`arXiv abstract fetch failed: ${res.status}`);
    const html = await res.text();

    const title = html.match(/<h1 class="title[^"]*"[^>]*>[\s\S]*?<span[^>]*>Title:<\/span>\s*([\s\S]*?)<\/h1>/i)?.[1]?.trim()
      || html.match(/<title[^>]*>(.*?)<\/title>/si)?.[1]?.trim()
      || url;

    const abstractMatch = html.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i);
    const abstract = abstractMatch ? stripHtml(abstractMatch[1]).replace(/^Abstract:\s*/i, "") : "";

    const authorsMatch = html.match(/<div class="authors">([\s\S]*?)<\/div>/i);
    const authors = authorsMatch ? stripHtml(authorsMatch[1]) : "";

    let text = `# ${stripHtml(title)}\n\n`;
    if (authors) text += `**Authors:** ${authors}\n\n`;
    if (abstract) text += `## Abstract\n\n${abstract}\n\n`;

    text += `*(Full paper PDF available at ${toPdfUrl(url)})*`;

    return { text, title: stripHtml(title) };
  } finally {
    clearTimeout(timer);
  }
}

export async function extract(url: string): Promise<{ text: string; title: string; metadata?: Record<string, any> }> {
  // Extract paper ID for pre-screening
  const idMatch = url.match(/(\d{4,}\.\d{4,5})/);
  let prescreen: { skip: boolean; reason?: string; metadata?: ArxivMeta } | null = null;

  if (idMatch) {
    try {
      prescreen = await prescreenArxiv(idMatch[1]);
      if (prescreen.skip) {
        console.log(`[WI] arXiv pre-screen: skipping ${idMatch[1]} — ${prescreen.reason}`);
        return { text: "", title: prescreen.reason || "Skipped", metadata: { skipped: true, reason: prescreen.reason } };
      }
    } catch { /* pre-screen is optional — continue on failure */ }
  }

  const pdfUrl = toPdfUrl(url);

  // Download PDF
  const tmpFile = `/tmp/wi-arxiv-${Date.now()}.pdf`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(pdfUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "WorldIngestor/2.0" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`PDF download failed: ${res.status}`);
      const buf = await res.arrayBuffer();
      await Bun.write(tmpFile, buf);
    } finally {
      clearTimeout(timer);
    }

    // Run pdftotext
    const proc = Bun.spawn(["pdftotext", "-layout", "-l", "100", tmpFile, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || text.trim().length < 100) {
      // pdftotext failed — fallback to abstract
      console.warn(`[WI] arXiv pdftotext failed, falling back to abstract page`);
      return extractAbstract(url);
    }

    // Extract title from first non-empty line
    const lines = text.split("\n").filter(l => l.trim().length > 0);
    const title = lines[0]?.trim().slice(0, 120) || url;

    return {
      text: text.trim(),
      title: prescreen?.metadata?.title || title,
      metadata: prescreen?.metadata ? {
        abstract: prescreen.metadata.abstract,
        subjects: prescreen.metadata.subjects,
        pages: prescreen.metadata.pages,
        arxivId: prescreen.metadata.id,
      } : undefined,
    };
  } catch (err: any) {
    // If PDF extraction fails entirely, try abstract
    if (err.message.includes("pdftotext") || err.message.includes("Executable not found")) {
      console.warn(`[WI] pdftotext not available, falling back to abstract page`);
      return extractAbstract(url);
    }
    throw err;
  } finally {
    try { await Bun.spawn(["rm", "-f", tmpFile]).exited; } catch {}
  }
}
