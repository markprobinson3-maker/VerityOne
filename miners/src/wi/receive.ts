/**
 * World Ingestor V2 — Stage 1: RECEIVE
 * Source detection, extraction, dedup, truncation, splitting.
 */

import { sql, normalizeUrl, preNormalizeUrl, loadParams, estimateTokens, shouldChunk, SOURCE_DETECTION_RULES, type RawSource } from "./config";
import { emitWI } from "./events";

// Adapter imports
import * as webAdapter from "./adapters/web";
import * as youtubeAdapter from "./adapters/youtube";
import * as pdfAdapter from "./adapters/pdf";
import * as githubAdapter from "./adapters/github";
import * as twitterAdapter from "./adapters/twitter";
import * as stackoverflowAdapter from "./adapters/stackoverflow";
import * as hnAdapter from "./adapters/hn";
import * as jupyterAdapter from "./adapters/jupyter";
import * as substackAdapter from "./adapters/substack";
import * as podcastAdapter from "./adapters/podcast";
import * as redditAdapter from "./adapters/reddit";
import * as arxivAdapter from "./adapters/arxiv";
import * as doiAdapter from "./adapters/doi";

const ADAPTERS: Record<string, { extract: (url: string) => Promise<{ text: string; title: string; metadata?: Record<string, any>; textParts?: string[] }> }> = {
  web: webAdapter,
  youtube: youtubeAdapter,
  pdf: pdfAdapter,
  github: githubAdapter,
  twitter: twitterAdapter,
  stackoverflow: stackoverflowAdapter,
  hn: hnAdapter,
  jupyter: jupyterAdapter,
  substack: substackAdapter,
  podcast: podcastAdapter,
  reddit: redditAdapter,
  arxiv: arxivAdapter,
  doi: doiAdapter,
};

// ============================================================
// SOURCE TYPE DETECTION
// ============================================================

export function detectSourceType(input: string): string {
  // File path detection
  if (input.startsWith("/") || input.startsWith("~") || input.startsWith("./")) {
    if (input.endsWith(".pdf")) return "pdf";
    if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(input)) return "podcast";
    if (input.endsWith(".ipynb")) return "jupyter";
    return "web";
  }

  try {
    const u = new URL(input);
    const host = u.hostname.replace("www.", "").toLowerCase();
    const path = u.pathname;

    // Check .ipynb on GitHub before generic github match
    if (host.includes("github.com") && path.endsWith(".ipynb")) return "jupyter";

    for (const rule of SOURCE_DETECTION_RULES) {
      if (rule.test(input, host, path)) return rule.type;
    }
    return "web";
  } catch {
    if (input.endsWith(".pdf")) return "pdf";
    return "web";
  }
}

// ============================================================
// SHA-256 HASH
// ============================================================

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// RECEIVE — full Stage 1
// ============================================================

export interface ReceiveOptions {
  force?: boolean;
  refreshDays?: number;
  dryRun?: boolean;
}

export async function receive(input: string, opts: ReceiveOptions = {}): Promise<RawSource> {
  const params = await loadParams();

  // Pre-normalize URL (alphaxiv→arxiv, etc.) before detection
  const normalizedInput = preNormalizeUrl(input);
  const sourceType = detectSourceType(normalizedInput);
  const runId = `wi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. URL dedup (unless --force)
  if (!opts.force) {
    const normalized = normalizeUrl(input);
    const staleDays = opts.refreshDays ?? params.staleDays;

    const [existing] = await sql`
      SELECT source_hash, ingested_at, status
      FROM source_history
      WHERE normalized_url = ${normalized}
      ORDER BY ingested_at DESC LIMIT 1
    `;

    if (existing && existing.status !== 'failed') {
      const ageMs = Date.now() - new Date(existing.ingested_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < staleDays) {
        throw new Error(`[DEDUP] Already ingested ${ageDays.toFixed(1)}d ago (stale threshold: ${staleDays}d). Use --force to bypass.`);
      }
    }
  }

  // 2. Extract content via adapter
  const adapter = ADAPTERS[sourceType];
  if (!adapter) throw new Error(`No adapter for source type: ${sourceType}`);

  const { text: rawText, title, metadata: adapterMeta, textParts: adapterTextParts } = await adapter.extract(normalizedInput);

  // 2a. Short-circuit if adapter returned empty text (e.g. pre-screen skip)
  if (!rawText || rawText.length === 0) {
    emitWI("source_start", runId, { url: input, source_type: sourceType, title, skipped: true });
    return {
      text: "",
      textParts: [],
      title,
      sourceUrl: input,
      sourceType,
      sourceHash: "",
      runId,
      metadata: adapterMeta,
    };
  }

  // 2b. Token estimation warning
  if (shouldChunk(rawText)) {
    console.warn(`[WI] Content is ${estimateTokens(rawText)} tokens — exceeds 900K, may need chunking`);
  }

  // 3. Content hash dedup
  const sourceHash = await sha256(rawText);
  if (!opts.force) {
    const [hashMatch] = await sql`
      SELECT id FROM source_history WHERE source_hash = ${sourceHash} LIMIT 1
    `;
    if (hashMatch) {
      throw new Error(`[DEDUP] Identical content already ingested (hash match). Use --force to bypass.`);
    }
  }

  // 4. Write source_history with status='processing'
  if (!opts.dryRun) {
    await sql`
      INSERT INTO source_history (source_id, source_hash, source_type, source_title, normalized_url, status, ingest_batch_id, ingested_at, updated_at)
      VALUES (${input}, ${sourceHash}, ${sourceType}, ${title}, ${normalizeUrl(input)}, 'processing', ${runId}, now(), now())
      ON CONFLICT (source_hash) DO UPDATE SET
        status = 'processing', updated_at = now(), ingest_batch_id = ${runId}
    `;
  }

  // 5. Truncate if needed
  let text = rawText;
  const maxChars = params.maxChars;
  if (text.length > maxChars) {
    // Truncate at paragraph boundary
    const truncated = text.slice(0, maxChars);
    const lastPara = truncated.lastIndexOf("\n\n");
    text = lastPara > maxChars * 0.5 ? truncated.slice(0, lastPara) : truncated;
    text += "\n\n[CONTENT TRUNCATED]";
  }

  // 6. Split if > 80% of max
  const splitThreshold = Math.floor(maxChars * 0.8);
  let textParts: string[] = adapterTextParts && adapterTextParts.length > 0 ? adapterTextParts : [text];

  if (!adapterTextParts?.length && text.length > splitThreshold) {
    const mid = Math.floor(text.length / 2);
    // Find nearest paragraph boundary to midpoint
    const searchStart = Math.max(0, mid - 2000);
    const searchEnd = Math.min(text.length, mid + 2000);
    const searchRegion = text.slice(searchStart, searchEnd);
    const paraBreak = searchRegion.lastIndexOf("\n\n");

    let splitPoint: number;
    if (paraBreak !== -1) {
      splitPoint = searchStart + paraBreak;
    } else {
      splitPoint = mid;
    }

    const overlap = 500;
    const part1 = text.slice(0, splitPoint + overlap);
    const part2 = text.slice(Math.max(0, splitPoint - overlap));
    textParts = [part1, part2];
  }

  // 7. Emit source_start
  emitWI("source_start", runId, { url: input, source_type: sourceType, title });

  return {
    text,
    textParts,
    title,
    sourceUrl: input,  // Keep original URL for provenance
    sourceType,
    sourceHash,
    runId,
    metadata: adapterMeta,
  };
}
