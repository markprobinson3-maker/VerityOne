// packages/embed/src/index.ts
import { createPooledSql } from "@verity-one/db-pool";
var EMBED_MODEL = "gemini-embedding-001";
var EMBED_DIMS = 3072;
var EMBED_DOCUMENT_TASK_TYPE = "RETRIEVAL_DOCUMENT";
var EMBED_BATCH_LIMIT = 100;
var GOOGLE_API_KEY = process.env.OPENCLAW_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY || "";
var EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;
class EmbedDimensionMismatchError extends Error {
  actual;
  expected;
  constructor(actual, expected) {
    super(`Embed dimension mismatch: got ${actual}, expected ${expected}`);
    this.actual = actual;
    this.expected = expected;
    this.name = "EmbedDimensionMismatchError";
  }
}

class EmbedApiError extends Error {
  status;
  bodyExcerpt;
  constructor(status, bodyExcerpt) {
    super(`Embedding API error ${status}: ${bodyExcerpt.slice(0, 200)}`);
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
    this.name = "EmbedApiError";
  }
}
var EMBED_RETRY_DELAYS_MS = [250, 1000, 4000];
async function withEmbedRetry(fn, label) {
  let lastErr;
  for (let attempt = 0;attempt <= EMBED_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof EmbedApiError ? err.status === 429 || err.status >= 500 && err.status < 600 : err instanceof TypeError || err?.name === "AbortError";
      if (!retryable || attempt === EMBED_RETRY_DELAYS_MS.length)
        throw err;
      await new Promise((r) => setTimeout(r, EMBED_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}
function assertEmbedDim(values) {
  if (!values) {
    throw new EmbedDimensionMismatchError(0, EMBED_DIMS);
  }
  if (values.length !== EMBED_DIMS) {
    throw new EmbedDimensionMismatchError(values.length, EMBED_DIMS);
  }
}
var _cacheSql = null;
function cacheSql() {
  if (!_cacheSql) {
    _cacheSql = createPooledSql({ idle_timeout: 30 });
  }
  return _cacheSql;
}
async function contentHash(text, taskType) {
  const data = new TextEncoder().encode(`${EMBED_MODEL}:${taskType}:${text}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ciFakeEmbeddingsEnabled() {
  return process.env.VERITY_CI === "1" && process.env.VERITY_CI_FAKE_EMBEDDINGS === "1";
}
function seededUnitRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seedForText(text) {
  let seed = 2166136261;
  for (let i = 0;i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  return seed || 1;
}
async function ciFakeEmbedding(text, _taskType) {
  const out = new Array(EMBED_DIMS);
  out.fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) || [text || "empty"];
  for (const token of tokens) {
    const rand = seededUnitRandom(seedForText(token));
    const weight = 1 + Math.min(token.length, 24) / 24;
    for (let i = 0;i < 16; i++) {
      const idx = Math.floor(rand() * EMBED_DIMS);
      const sign = rand() >= 0.5 ? 1 : -1;
      out[idx] = out[idx] + sign * weight;
    }
  }
  const acc = out.reduce((sum, n) => sum + n * n, 0);
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0;i < EMBED_DIMS; i++)
    out[i] = out[i] / norm;
  assertEmbedDim(out);
  return out;
}
function vecToStr(v) {
  return `[${v.join(",")}]`;
}
function parseVec(raw) {
  return raw.replace(/[\[\]]/g, "").split(",").map(Number);
}
async function cacheGet(hash) {
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
    if (err instanceof EmbedDimensionMismatchError)
      throw err;
  }
  return null;
}
async function cachePut(hash, embedding) {
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
  } catch {}
}
async function cacheGetMany(hashes) {
  const result = new Map;
  if (hashes.length === 0)
    return result;
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
    if (err instanceof EmbedDimensionMismatchError)
      throw err;
  }
  return result;
}
async function cachePutMany(entries) {
  if (entries.length === 0)
    return;
  for (const e of entries)
    assertEmbedDim(e.embedding);
  try {
    const db = cacheSql();
    for (const e of entries) {
      await db`
        INSERT INTO query_embeddings (content_hash, embedding)
        VALUES (${e.hash}, ${vecToStr(e.embedding)}::halfvec)
        ON CONFLICT (content_hash) DO NOTHING
      `;
    }
  } catch {}
}
async function fetchEmbedQuery(text) {
  const res = await fetch(`${EMBED_URL}?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EMBED_DIMS
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new EmbedApiError(res.status, err);
  }
  const data = await res.json();
  const values = data.embedding.values;
  assertEmbedDim(values);
  return values;
}
async function fetchEmbedBatch(texts) {
  const BATCH_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GOOGLE_API_KEY}`;
  if (texts.length > EMBED_BATCH_LIMIT) {
    const batches = [];
    for (let i = 0;i < texts.length; i += EMBED_BATCH_LIMIT) {
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
        outputDimensionality: EMBED_DIMS
      }))
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new EmbedApiError(res.status, err);
  }
  const data = await res.json();
  const all = data.embeddings.map((e) => e.values);
  for (const v of all)
    assertEmbedDim(v);
  return all;
}
async function embedQuery(text) {
  if (ciFakeEmbeddingsEnabled()) {
    return ciFakeEmbedding(text, "RETRIEVAL_QUERY");
  }
  const hash = await contentHash(text, "RETRIEVAL_QUERY");
  const cached = await cacheGet(hash);
  if (cached)
    return cached;
  const embedding = await withEmbedRetry(() => fetchEmbedQuery(text), "embedQuery");
  cachePut(hash, embedding);
  return embedding;
}
async function embedBatch(texts) {
  return (await embedBatchWithCacheMetadata(texts)).map((result) => result.embedding);
}
async function embedBatchWithCacheMetadata(texts) {
  if (texts.length === 0)
    return [];
  if (ciFakeEmbeddingsEnabled()) {
    return Promise.all(texts.map(async (text) => ({
      embedding: await ciFakeEmbedding(text, EMBED_DOCUMENT_TASK_TYPE),
      cacheHit: false
    })));
  }
  const hashes = await Promise.all(texts.map((t) => contentHash(t, EMBED_DOCUMENT_TASK_TYPE)));
  const cached = await cacheGetMany(hashes);
  const missIndices = [];
  const missTexts = [];
  for (let i = 0;i < texts.length; i++) {
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
  let missEmbeddings = [];
  if (missTexts.length > 0) {
    missEmbeddings = await withEmbedRetry(() => fetchEmbedBatch(missTexts), "embedBatch");
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
  const results = new Array(texts.length);
  let missPtr = 0;
  for (let i = 0;i < texts.length; i++) {
    const hash = hashes[i];
    if (!hash)
      throw new Error(`embedBatch hash invariant failed at index ${i}`);
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
function toVectorStr(embedding) {
  return `[${embedding.join(",")}]`;
}
async function embedCacheStats() {
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
    oldest_entry: row.oldest_entry
  };
}
function embedForInsertFromEmbedding(embedding, cacheHit) {
  assertEmbedDim(embedding);
  return {
    vecStr: toVectorStr(embedding),
    model: EMBED_MODEL,
    taskType: EMBED_DOCUMENT_TASK_TYPE,
    embeddedAt: new Date,
    cacheHit
  };
}
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function embeddingTextForNode(label, substance) {
  const parsed = typeof substance === "string" ? safeJsonParse(substance) : substance;
  const fields = [];
  if (label && label.trim())
    fields.push(label.trim());
  if (typeof parsed === "string" && parsed.trim()) {
    fields.push(parsed.trim());
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed;
    for (const key of [
      "description",
      "summary",
      "assertion",
      "why_it_matters",
      "evidence",
      "substance",
      "title",
      "path"
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim())
        fields.push(value.trim());
    }
    for (const key of ["domains", "tags"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        const joined = value.filter((item) => typeof item === "string").join(", ");
        if (joined)
          fields.push(joined);
      }
    }
  }
  return fields.join(`
`);
}
async function embedTextForInsert(text) {
  const [result] = await embedBatchWithCacheMetadata([text]);
  if (!result) {
    throw new EmbedDimensionMismatchError(0, EMBED_DIMS);
  }
  const { embedding, cacheHit } = result;
  return embedForInsertFromEmbedding(embedding, cacheHit);
}
async function embedTextForInsertFromCache(text) {
  if (ciFakeEmbeddingsEnabled())
    return null;
  const hash = await contentHash(text, EMBED_DOCUMENT_TASK_TYPE);
  const embedding = await cacheGet(hash);
  if (!embedding)
    return null;
  return embedForInsertFromEmbedding(embedding, true);
}
function embeddingMetadataForVectorWrite(taskType) {
  return {
    model: EMBED_MODEL,
    taskType,
    embeddedAt: new Date
  };
}
export {
  withEmbedRetry,
  toVectorStr,
  embeddingTextForNode,
  embeddingMetadataForVectorWrite,
  embedTextForInsertFromCache,
  embedTextForInsert,
  embedQuery,
  embedCacheStats,
  embedBatchWithCacheMetadata,
  embedBatch,
  assertEmbedDim,
  EmbedDimensionMismatchError,
  EmbedApiError,
  EMBED_MODEL,
  EMBED_DOCUMENT_TASK_TYPE,
  EMBED_DIMS
};
