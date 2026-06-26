/**
 * First-run honesty for embedding failures.
 *
 * The three canonical first-run calls (/context, /remember, /memory/write)
 * all require the embedding provider. With no GOOGLE_API_KEY the provider
 * returns 4xx, which used to surface as an opaque "Service temporarily
 * unavailable" (/context) or a bare internal_error (writes) — the worst
 * possible first impression, and the bootstrap's own verify step curls
 * /context. Classify embed failures so routes can return the existing
 * `embedding_service_unavailable` envelope with a hint that names the fix.
 */
import { EmbedApiError, EmbedDimensionMismatchError } from "@verity-one/embed";

export const EMBED_KEY_HINT =
  "Set OPENCLAW_GOOGLE_API_KEY (or GOOGLE_API_KEY) in the node's environment and restart — "
  + "embeddings power /context, /search, and memory writes. Get a key: https://aistudio.google.com/apikey";

export interface EmbedUnavailable {
  message: string;
  hint: string;
}

/**
 * Returns an honest message+hint when `err` is an embedding-provider
 * failure, else null (caller falls through to its normal error handling).
 * 400/401/403 from the provider almost always means the key is missing or
 * invalid (an empty key produces 400/403 from the API).
 */
export function classifyEmbedUnavailable(err: unknown): EmbedUnavailable | null {
  if (err instanceof EmbedApiError) {
    const keyProblem = err.status === 400 || err.status === 401 || err.status === 403;
    if (keyProblem) {
      return {
        message: "Embedding provider rejected the request — the embedding API key is missing or invalid.",
        hint: EMBED_KEY_HINT,
      };
    }
    return {
      message: `Embedding provider unavailable (HTTP ${err.status}) after retries.`,
      hint: `Check network/provider status, then retry. If this node was never configured: ${EMBED_KEY_HINT}`,
    };
  }
  if (err instanceof EmbedDimensionMismatchError) {
    return {
      message: `Embedding configuration drift: ${err.message}`,
      hint: "The embedding model/dimensions no longer match the stored vectors — check EMBED_MODEL and the embedding columns before writing.",
    };
  }
  return null;
}
