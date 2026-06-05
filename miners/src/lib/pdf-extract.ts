import { existsSync } from "fs";

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function looksScholarlyPdf(source: string, titleHint?: string): boolean {
  const candidate = `${source} ${titleHint || ""}`.toLowerCase();
  return [
    "alphaxiv.org",
    "arxiv.org",
    "doi.org",
    "acm.org",
    "ieee.org",
    "springer.com",
    "nature.com",
    "science.org",
    "philpapers.org",
    "projecteuclid.org",
    "jstor.org",
    "papers/",
    "/abs/",
    "/pdf/",
  ].some(token => candidate.includes(token));
}

export function resolvePdfPageLimit(source: string, opts: { titleHint?: string; pageLimit?: number } = {}): number {
  if (opts.pageLimit && opts.pageLimit > 0) return opts.pageLimit;
  const scholarlyDefault = readPositiveInt(process.env.VERITY_PDF_SCHOLARLY_PAGE_LIMIT, 0);
  const generalDefault = readPositiveInt(process.env.VERITY_PDF_PAGE_LIMIT, 0);
  return looksScholarlyPdf(source, opts.titleHint) ? scholarlyDefault : generalDefault;
}

function resolvePdfPagesPerPart(source: string, opts: { titleHint?: string } = {}): number {
  const scholarlyDefault = readPositiveInt(process.env.VERITY_PDF_SCHOLARLY_PAGES_PER_PART, 48);
  const generalDefault = readPositiveInt(process.env.VERITY_PDF_PAGES_PER_PART, 36);
  return looksScholarlyPdf(source, opts.titleHint) ? scholarlyDefault : generalDefault;
}

function resolvePdfMaxParts(source: string, opts: { titleHint?: string } = {}): number {
  const scholarlyDefault = readPositiveInt(process.env.VERITY_PDF_SCHOLARLY_MAX_PARTS, 24);
  const generalDefault = readPositiveInt(process.env.VERITY_PDF_MAX_PARTS, 16);
  return looksScholarlyPdf(source, opts.titleHint) ? scholarlyDefault : generalDefault;
}

function resolvePdfPartCharLimit(): number {
  return readPositiveInt(process.env.VERITY_PDF_PART_CHAR_LIMIT, 120_000);
}

async function getPdfPageCount(filePath: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["pdfinfo", filePath], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const match = stdout.match(/^Pages:\s+(\d+)/mi);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function splitTextIntoBoundedParts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
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

export interface PdfPageWindow {
  startPage: number;
  endPage: number;
}

export interface PdfTextPart {
  content: string;
  startPage: number;
  endPage: number;
  partIndex: number;
  partCount: number;
}

export function planPdfPageWindows(
  pageCount: number,
  source: string,
  opts: { titleHint?: string; pageLimit?: number } = {},
): PdfPageWindow[] {
  const effectivePageCount = Math.max(1, Math.min(pageCount, resolvePdfPageLimit(source, opts) || pageCount));
  const preferredPagesPerPart = Math.max(1, resolvePdfPagesPerPart(source, opts));
  const maxParts = Math.max(1, resolvePdfMaxParts(source, opts));
  const partCount = Math.max(1, Math.min(maxParts, Math.ceil(effectivePageCount / preferredPagesPerPart)));
  const pagesPerPart = Math.max(1, Math.ceil(effectivePageCount / partCount));

  const windows: PdfPageWindow[] = [];
  let startPage = 1;
  while (startPage <= effectivePageCount) {
    const endPage = Math.min(effectivePageCount, startPage + pagesPerPart - 1);
    windows.push({ startPage, endPage });
    startPage = endPage + 1;
  }
  return windows;
}

async function extractPdfPageRange(filePath: string, startPage: number, endPage: number): Promise<string> {
  const proc = Bun.spawn(["pdftotext", "-layout", "-f", String(startPage), "-l", String(endPage), filePath, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`pdftotext failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
  if (text.trim().length < 20) {
    throw new Error(`PDF extracted text too short for pages ${startPage}-${endPage}`);
  }
  return text;
}

async function extractPdfWholeText(filePath: string, pageLimit?: number): Promise<string> {
  const args = ["pdftotext", "-layout"];
  if (pageLimit && pageLimit > 0) {
    args.push("-l", String(pageLimit));
  }
  args.push(filePath, "-");
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`pdftotext failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
  if (text.trim().length < 20) {
    throw new Error("PDF extracted text too short");
  }
  return text;
}

function buildPdfPartPrefix(startPage: number, endPage: number, totalPages: number, segmentIndex: number, segmentCount: number): string {
  const pageLabel = startPage === endPage ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
  const segmentLabel = segmentCount > 1 ? `, segment ${segmentIndex}/${segmentCount}` : "";
  return `[PDF ${pageLabel} of ${totalPages}${segmentLabel}]`;
}

function derivePdfTitle(source: string, filePath: string, titleHint?: string): string {
  if (titleHint) return titleHint;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    try {
      const url = new URL(source);
      const lastPath = decodeURIComponent(url.pathname.split("/").pop() || "").replace(/\.pdf$/i, "");
      if (lastPath) return lastPath;
    } catch {}
  }
  return filePath.split("/").pop()?.replace(/\.pdf$/i, "") || source;
}

function formatPdfTextParts(windows: PdfPageWindow[], windowTexts: string[], totalPages: number): PdfTextPart[] {
  const maxChars = resolvePdfPartCharLimit();
  const parts: PdfTextPart[] = [];
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    const boundedSegments = splitTextIntoBoundedParts(windowTexts[i], maxChars);
    for (let j = 0; j < boundedSegments.length; j++) {
      const prefix = buildPdfPartPrefix(window.startPage, window.endPage, totalPages, j + 1, boundedSegments.length);
      parts.push({
        content: `${prefix}\n\n${boundedSegments[j].trim()}`,
        startPage: window.startPage,
        endPage: window.endPage,
        partIndex: 0,
        partCount: 0,
      });
    }
  }
  const totalPartCount = parts.length;
  return parts.map((part, index) => ({
    ...part,
    partIndex: index + 1,
    partCount: totalPartCount,
  }));
}

export async function extractPdfContent(
  source: string,
  opts: { titleHint?: string; pageLimit?: number } = {},
): Promise<{ text: string; title: string; textParts: string[]; pageCount?: number; pagesRead?: number; truncated?: boolean }> {
  let filePath: string;
  let tempFile: string | null = null;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    tempFile = `/tmp/verity-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(source, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "Verity-Ingest/1.0 (pdf-extractor)" },
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const buf = await res.arrayBuffer();
      await Bun.write(tempFile, buf);
    } finally {
      clearTimeout(timeout);
    }
    filePath = tempFile;
  } else {
    const resolved = source.startsWith("~")
      ? source.replace("~", process.env.HOME || "")
      : source;
    if (!existsSync(resolved)) throw new Error(`PDF not found: ${resolved}`);
    filePath = resolved;
  }

  try {
    const pageCount = await getPdfPageCount(filePath);
    let text: string;
    let textParts: string[];
    let pagesRead: number | undefined;

    if (pageCount && pageCount > 0) {
      const windows = planPdfPageWindows(pageCount, source, opts);
      const windowTexts: string[] = [];
      for (const window of windows) {
        windowTexts.push(await extractPdfPageRange(filePath, window.startPage, window.endPage));
      }
      const parts = formatPdfTextParts(windows, windowTexts, pageCount);
      text = parts.map(part => part.content).join("\n\n==== PDF PART ====\n\n");
      textParts = parts.map(part => part.content);
      pagesRead = windows.length > 0 ? windows[windows.length - 1].endPage : undefined;
    } else {
      const pageLimit = resolvePdfPageLimit(source, opts);
      const rawText = await extractPdfWholeText(filePath, pageLimit || undefined);
      textParts = splitTextIntoBoundedParts(rawText, resolvePdfPartCharLimit()).map((part, index, array) =>
        `[PDF extracted text, segment ${index + 1}/${array.length}]\n\n${part.trim()}`
      );
      text = textParts.join("\n\n==== PDF PART ====\n\n");
      pagesRead = pageLimit > 0 ? pageLimit : undefined;
    }

    if (text.trim().length < 50) throw new Error("PDF extracted text too short (< 50 chars)");

    const title = derivePdfTitle(source, filePath, opts.titleHint);

    return {
      text,
      title,
      textParts,
      pageCount: pageCount ?? undefined,
      pagesRead,
      truncated: pageCount ? pagesRead !== undefined && pagesRead < pageCount : undefined,
    };
  } finally {
    if (tempFile) {
      try {
        await Bun.spawn(["rm", "-f", tempFile]).exited;
      } catch {}
    }
  }
}

export async function extractPdfText(
  source: string,
  opts: { titleHint?: string; pageLimit?: number } = {},
): Promise<{ text: string; title: string; textParts: string[]; pageCount?: number; pagesRead?: number; truncated?: boolean }> {
  return extractPdfContent(source, opts);
}
