/**
 * Server-only embedding helper + DB-backed cache + write-safety contract.
 *
 * F7 (rung 7 of VO-FOUNDATION-HARDENING-LADDER-1) extracted this surface
 * from `api/src/lib/embed.ts` so cross-workspace callers under
 * `scripts/`, `miners/`, and `api/scripts/` can import via the package
 * boundary instead of reaching into API-private source. The package
 * also adds the F7 write-safety contract:
 *
 *   1. `EmbedDimensionMismatchError` and `EmbedApiError` — typed errors
 *      so callers can route to a 503 instead of a 500 at the route
 *      boundary, and so the retry loop knows what's retryable.
 *
 *   2. `withEmbedRetry` — wraps the external API call in a 3-retry
 *      loop with exponential backoff (250 ms / 1 s / 4 s) on 429 / 5xx
 *      and network/abort failures. Does NOT retry dimension mismatch
 *      or programmer/data-shape errors.
 *
 *   3. `assertEmbedDim` — every embedding crossing the package
 *      boundary (cache hits, API responses, and vectors before cache
 *      writes) is verified to be `EMBED_DIMS = 3072`.
 *
 *   4. `embeddingTextForNode(label, substance)` — canonical text
 *      selection for `nodes.embedding_hv`. Picks high-signal fields
 *      in stable order (`label`, then `description`, `summary`,
 *      `assertion`, `why_it_matters`, `evidence`, `substance`,
 *      `title`, `path`, then array fields `domains`, `tags`).
 *      Skips noisy lifecycle/status fields.
 *
 *   5. `embedTextForInsert(text)` — the canonical helper for every
 *      `nodes` INSERT. Uses the document embedding path
 *      (`embedBatch([text])`, NOT `embedQuery`), asserts dimension,
 *      and returns `{ vecStr, model, taskType: EMBED_DOCUMENT_TASK_TYPE,
 *      embeddedAt, cacheHit }` ready for the four marker columns and
 *      spend-accounting callers. `embedTextForInsertFromCache(text)`
 *      exposes the same shape on cache hits without calling the provider.
 *
 *   6. `embeddingMetadataForVectorWrite(taskType)` — for derived
 *      vector writers (centroids, lifecycle nudges, manual recovery)
 *      that produce a vector through arithmetic rather than a fresh
 *      text embed. Returns `{ model, taskType, embeddedAt }` so the
 *      caller can write the marker columns alongside the derived
 *      vector.
 *
 * Server-only constraint: this package owns the DB-backed
 * `query_embeddings` cache and depends on `@verity-one/db-pool`. It
 * MUST NOT be imported from `scope/src/`. The F7 drift surface
 * enforces this via static guard.
 */

import { createPooledSql } from "@verity-one/db-pool";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMS = 3072;
const EMBED_DOCUMENT_TASK_TYPE = "RETRIEVAL_DOCUMENT";
const EMBED_BATCH_LIMIT = 100;
const GOOGLE_API_KEY = process.env.OPENCLAW_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY || "";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

export { EMBED_MODEL, EMBED_DIMS, EMBED_DOCUMENT_TASK_TYPE };

// ── F7 typed errors ────────────────────────────────────────────────

export class EmbedDimensionMismatchError extends Error {
  constructor(public actual: number, public expected: number) {
    super(`Embed dimension mismatch: got ${actual}, expected ${expected}`);
    this.name = "EmbedDimensionMismatchError";
  }
}

export class EmbedApiError extends Error {
  constructor(public status: number, public bodyExcerpt: string) {
    super(`Embedding API error ${status}: ${bodyExcerpt.slice(0, 200)}`);
    this.name = "EmbedApiError";
  }
}

// ── F7 retry + dimension validation ────────────────────────────────

const EMBED_RETRY_DELAYS_MS = [250, 1000, 4000] as const;

export async function withEmbedRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof EmbedApiError
          ? err.status === 429 || (err.status >= 500 && err.status < 600)
          : err instanceof TypeError || (err as Error)?.name === "AbortError";
      if (!retryable || attempt === EMBED_RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, EMBED_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

export function assertEmbedDim(values: number[] | undefined): asserts values is number[] {
  if (!values) {
    throw new EmbedDimensionMismatchError(0, EMBED_DIMS);
  }
  if (values.length !== EMBED_DIMS) {
    throw new EmbedDimensionMismatchError(values.length, EMBED_DIMS);
  }
}

// ── Cache layer ────────────────────────────────────────────────────

let _cacheSql: ReturnType<typeof createPooledSql> | null = null;
function cacheSql() {
  if (!_cacheSql) {
    // Pool config + DATABASE_URL resolution come from db-pool so
    // serverless cold starts share the canonical (`prepare: false`,
    // `max: 2`) shape. `idle_timeout: 30` overrides the helper
    // default (20) to preserve the previous embedding-cache cadence.
    _cacheSql = createPooledSql({ idle_timeout: 30 });
  }
  return _cacheSql;
}

async function contentHash(text: string, taskType: string): Promise<string> {
  const data = new TextEncoder().encode(`${EMBED_MODEL}:${taskType}:${text}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ciFakeEmbeddingsEnabled(): boolean {
  return process.env.VERITY_CI === "1" && process.env.VERITY_CI_FAKE_EMBEDDINGS === "1";
}

function seededUnitRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedForText(text: string): number {
  let seed = 0x811C9DC5;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  return seed || 1;
}

async function ciFakeEmbedding(text: string, _taskType: string): Promise<number[]> {
  const out = new Array<number>(EMBED_DIMS);
  out.fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) || [text || "empty"];
  for (const token of tokens) {
    const rand = seededUnitRandom(seedForText(token));
    const weight = 1 + Math.min(token.length, 24) / 24;
    for (let i = 0; i < 16; i++) {
      const idx = Math.floor(rand() * EMBED_DIMS);
      const sign = rand() >= 0.5 ? 1 : -1;
      out[idx] = out[idx]! + sign * weight;
    }
  }
  const acc = out.reduce((sum, n) => sum + n * n, 0);
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < EMBED_DIMS; i++) out[i] = out[i]! / norm;
  assertEmbedDim(out);
  return out;
}

function vecToStr(v: number[]): string {
  return `[${v.join(",")}]`;
}

function parseVec(raw: string): number[] {
  return raw.replace(/[\[\]]/g, "").split(",").map(Number);
}

async function cacheGet(hash: string): Promise<number[] | null> {
  try {
    const db = cacheSql();
    const [row] = await db`
      UPDATE query_embeddings
      SET last_used_at = now(), hit_count = hit_count + 1
      WHERE content_hash = ${hash}
      RETURNING embedding::text
    `;
    if (row) {
      const parsed = parseVec(row.embedding);
      assertEmbedDim(parsed);
      return parsed;
    }
  } catch (err) {
    // Dimension mismatch on a cache hit is real corruption — surface it.
    if (err instanceof EmbedDimensionMismatchError) throw err;
    // Other cache errors fall through to the API.
  }
  return null;
}

async function cachePut(hash: string, embedding: number[]): Promise<void> {
  assertEmbedDim(embedding);
  try {
    const db = cacheSql();
    await db`
      INSERT INTO query_embeddings (content_hash, embedding)
      VALUES (${hash}, ${vecToStr(embedding)}::halfvec)
      ON CONFLICT (content_hash) DO UPDATE SET
        last_used_at = now(),
        hit_count = query_embeddings.hit_count + 1
    `;
  } catch {
    // Non-fatal — embedding still returned to caller.
  }
}

async function cacheGetMany(hashes: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (hashes.length === 0) return result;
  try {
    const db = cacheSql();
    const rows = await db`
      UPDATE query_embeddings
      SET last_used_at = now(), hit_count = hit_count + 1
      WHERE content_hash = ANY(${hashes})
      RETURNING content_hash, embedding::text
    `;
    for (const row of rows) {
      const parsed = parseVec(row.embedding);
      assertEmbedDim(parsed);
      result.set(row.content_hash, parsed);
    }
  } catch (err) {
    if (err instanceof EmbedDimensionMismatchError) throw err;
    // Other cache errors fall through.
  }
  return result;
}

async function cachePutMany(entries: { hash: string; embedding: number[] }[]): Promise<void> {
  if (entries.length === 0) return;
  for (const e of entries) assertEmbedDim(e.embedding);
  try {
    const db = cacheSql();
    for (const e of entries) {
      await db`
        INSERT INTO query_embeddings (content_hash, embedding)
        VALUES (${e.hash}, ${vecToStr(e.embedding)}::halfvec)
        ON CONFLICT (content_hash) DO NOTHING
      `;
    }
  } catch {
    // Non-fatal.
  }
}

// ── API calls ──────────────────────────────────────────────────────

async function fetchEmbedQuery(text: string): Promise<number[]> {
  const res = await fetch(`${EMBED_URL}?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EMBED_DIMS,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new EmbedApiError(res.status, err);
  }

  const data = (await res.json()) as { embedding: { values: number[] } };
  const values = data.embedding.values;
  assertEmbedDim(values);
  return values;
}

async function fetchEmbedBatch(texts: string[]): Promise<number[][]> {
  const BATCH_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GOOGLE_API_KEY}`;

  if (texts.length > EMBED_BATCH_LIMIT) {
    const batches: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_LIMIT) {
      const chunk = texts.slice(i, i + EMBED_BATCH_LIMIT);
      const chunkEmbeddings = await fetchEmbedBatch(chunk);
      batches.push(...chunkEmbeddings);
    }
    return batches;
  }

  const res = await fetch(BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: EMBED_DOCUMENT_TASK_TYPE,
        outputDimensionality: EMBED_DIMS,
      })),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new EmbedApiError(res.status, err);
  }

  const data = (await res.json()) as { embeddings: { values: number[] }[] };
  const all = data.embeddings.map((e) => e.values);
  for (const v of all) assertEmbedDim(v);
  return all;
}

// ── Public API (cached + retry) ────────────────────────────────────

/**
 * Embed a single text query. Cache-first, write-through on miss.
 * Use this for retrieval/search paths (`/context`, `/search`, etc.).
 * For node embeddings, use `embedTextForInsert` instead.
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (ciFakeEmbeddingsEnabled()) {
    return ciFakeEmbedding(text, "RETRIEVAL_QUERY");
  }

  const hash = await contentHash(text, "RETRIEVAL_QUERY");

  const cached = await cacheGet(hash);
  if (cached) return cached;

  const embedding = await withEmbedRetry(() => fetchEmbedQuery(text), "embedQuery");
  cachePut(hash, embedding); // fire-and-forget
  return embedding;
}

/**
 * Embed a batch of texts. Checks cache per-item, only calls API for misses.
 * Used by both ingest pipelines (`embedTextForInsert` wraps a 1-item batch)
 * and bulk operator scripts.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return (await embedBatchWithCacheMetadata(texts)).map((result) => result.embedding);
}

export interface EmbedBatchResult {
  embedding: number[];
  cacheHit: boolean;
}

/**
 * Batch embed with per-item cache metadata. Callers that account for upstream
 * spend should only charge externally billed misses (`cacheHit === false`).
 */
export async function embedBatchWithCacheMetadata(texts: string[]): Promise<EmbedBatchResult[]> {
  if (texts.length === 0) return [];

  if (ciFakeEmbeddingsEnabled()) {
    return Promise.all(texts.map(async (text) => ({
      embedding: await ciFakeEmbedding(text, EMBED_DOCUMENT_TASK_TYPE),
      cacheHit: false,
    })));
  }

  const hashes = await Promise.all(
    texts.map((t) => contentHash(t, EMBED_DOCUMENT_TASK_TYPE)),
  );

  const cached = await cacheGetMany(hashes);

  const missIndices: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hash = hashes[i];
    const text = texts[i];
    if (!hash || text === undefined) {
      throw new Error(`embedBatch invariant failed at index ${i}`);
    }
    if (!cached.has(hash)) {
      missIndices.push(i);
      missTexts.push(text);
    }
  }

  let missEmbeddings: number[][] = [];
  if (missTexts.length > 0) {
    missEmbeddings = await withEmbedRetry(
      () => fetchEmbedBatch(missTexts),
      "embedBatch",
    );

    const entries = missIndices.map((idx, j) => {
      const hash = hashes[idx];
      const embedding = missEmbeddings[j];
      if (!hash || !embedding) {
        throw new Error(`embedBatch response invariant failed at miss index ${idx}`);
      }
      return { hash, embedding };
    });
    cachePutMany(entries);
  }

  const results: EmbedBatchResult[] = new Array(texts.length);
  let missPtr = 0;
  for (let i = 0; i < texts.length; i++) {
    const hash = hashes[i];
    if (!hash) throw new Error(`embedBatch hash invariant failed at index ${i}`);
    const hit = cached.get(hash);
    if (hit) {
      results[i] = { embedding: hit, cacheHit: true };
    } else {
      const embedding = missEmbeddings[missPtr++];
      assertEmbedDim(embedding);
      results[i] = { embedding, cacheHit: false };
    }
  }

  return results;
}

/** Convert embedding array to a Postgres-compatible halfvec string. */
export function toVectorStr(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Cache stats for monitoring. */
export async function embedCacheStats(): Promise<{
  total_entries: number;
  total_hits: number;
  oldest_entry: string | null;
}> {
  const db = cacheSql();
  const [row] = await db`
    SELECT
      COUNT(*) AS total_entries,
      COALESCE(SUM(hit_count), 0) AS total_hits,
      MIN(created_at)::text AS oldest_entry
    FROM query_embeddings
  `;
  if (!row) {
    return { total_entries: 0, total_hits: 0, oldest_entry: null };
  }
  return {
    total_entries: parseInt(row.total_entries),
    total_hits: parseInt(row.total_hits),
    oldest_entry: row.oldest_entry,
  };
}

// ── F7 write-safety contract ───────────────────────────────────────

export type NodeEmbeddingTaskType =
  | typeof EMBED_DOCUMENT_TASK_TYPE
  | "DERIVED_CENTROID"
  | "DERIVED_NUDGE"
  | "MANUAL_RECOVERY";

export interface EmbedForInsert {
  vecStr: string;          // ready for `${vecStr}::halfvec(3072)` cast
  model: string;           // for `embedding_model` column
  taskType: typeof EMBED_DOCUMENT_TASK_TYPE;
  embeddedAt: Date;        // for `embedding_at` column (caller may also use `now()`)
  cacheHit: boolean;       // true when no upstream embedding API call was made
}

function embedForInsertFromEmbedding(embedding: number[], cacheHit: boolean): EmbedForInsert {
  assertEmbedDim(embedding);
  return {
    vecStr: toVectorStr(embedding),
    model: EMBED_MODEL,
    taskType: EMBED_DOCUMENT_TASK_TYPE,
    embeddedAt: new Date(),
    cacheHit,
  };
}

export interface VectorWriteMetadata {
  model: string;
  taskType: Exclude<NodeEmbeddingTaskType, typeof EMBED_DOCUMENT_TASK_TYPE>;
  embeddedAt: Date;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Canonical text-selection policy for `nodes.embedding_hv`. Picks
 * high-signal fields in stable order. Skips noisy lifecycle/status
 * fields so embeddings stay anchored to semantic meaning.
 *
 * Order: label → description → summary → assertion → why_it_matters
 * → evidence → substance (string) → title → path → domains/tags joined.
 */
export function embeddingTextForNode(label: string, substance: unknown): string {
  const parsed =
    typeof substance === "string"
      ? safeJsonParse(substance)
      : substance;
  const fields: string[] = [];
  if (label && label.trim()) fields.push(label.trim());
  if (typeof parsed === "string" && parsed.trim()) {
    fields.push(parsed.trim());
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of [
      "description",
      "summary",
      "assertion",
      "why_it_matters",
      "evidence",
      "substance",
      "title",
      "path",
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) fields.push(value.trim());
    }
    for (const key of ["domains", "tags"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        const joined = value.filter((item) => typeof item === "string").join(", ");
        if (joined) fields.push(joined);
      }
    }
  }
  return fields.join("\n");
}

/**
 * The canonical helper every `nodes` INSERT path should use.
 *
 * Uses the document embedding path (`embedBatch([text])`, NOT
 * `embedQuery`) because `nodes.embedding_hv` stores corpus/document
 * embeddings. Asserts dimension on return. The returned object holds
 * everything the four marker columns need — `vecStr` for the vector
 * cast, plus `model`, `taskType`, and `embeddedAt` for the marker
 * columns.
 */
export async function embedTextForInsert(text: string): Promise<EmbedForInsert> {
  const [result] = await embedBatchWithCacheMetadata([text]);
  if (!result) {
    throw new EmbedDimensionMismatchError(0, EMBED_DIMS);
  }
  const { embedding, cacheHit } = result;
  // embedBatch already asserts dim; the shared constructor re-checks to cover
  // future cache layers returning an unvalidated value.
  return embedForInsertFromEmbedding(embedding, cacheHit);
}

/**
 * Return the insert-ready document embedding only when the model/task/text
 * tuple is already cached. This never calls the upstream embedding provider.
 */
export async function embedTextForInsertFromCache(text: string): Promise<EmbedForInsert | null> {
  if (ciFakeEmbeddingsEnabled()) return null;
  const hash = await contentHash(text, EMBED_DOCUMENT_TASK_TYPE);
  const embedding = await cacheGet(hash);
  if (!embedding) return null;
  return embedForInsertFromEmbedding(embedding, true);
}

/**
 * Marker payload for derived/manual vector writers (centroids,
 * lifecycle nudges, manual recovery). The vector itself is computed
 * by the caller through arithmetic, not a text embed; this helper
 * just supplies the marker-column values so the write stays
 * classified.
 */
export function embeddingMetadataForVectorWrite(
  taskType: Exclude<NodeEmbeddingTaskType, typeof EMBED_DOCUMENT_TASK_TYPE>,
): VectorWriteMetadata {
  return {
    model: EMBED_MODEL,
    taskType,
    embeddedAt: new Date(),
  };
}
