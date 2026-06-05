/**
 * Window-based hosted rate-limit middleware for VO+ surfaces.
 *
 * DEFERRED: VO-PLUS-RATE-LIMITING-PR-1 was deferred because the current
 * auth architecture creates an inherent tension between:
 *   1. Protecting DB-backed auth lookups from unauthenticated flooding
 *      (requires pre-auth counting, which changes 401→429 behavior)
 *   2. Preserving auth-boundary behavior for wrong credentials
 *      (requires post-auth-only counting, which leaves DB unprotected)
 *   3. Per-identity limits requiring verified identity that only exists
 *      after route handlers authenticate
 *
 * The right resolution is architectural:
 *   - Add lightweight hosted auth preambles that resolve verified
 *     identity before route logic runs
 *   - Rate-limit on verified identity after the preamble
 *   - Keep coarse unauthenticated flood protection at the proxy layer
 *
 * This module is active for the narrow /admin/login brute-force guard.
 * Federation write/control routes use route-local limiters, mostly the
 * separate token-bucket layer in federation-rate-limit.ts.
 */

import type { MiddlewareHandler } from "hono";
import { extractForwardedClientIp, isTrustProxyEnabled } from "./access";
import { errorJson } from "./error-envelope";

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;
const BUCKET_PRUNE_INTERVAL_MS = 5_000;
let lastBucketPruneAt = 0;

export function __resetHostedRateLimitBucketsForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetHostedRateLimitBucketsForTests is test-only");
  }
  buckets.clear();
  // Restore the module's initial prune-throttle state so prune behavior is
  // independent of test execution order. Without this, a prior test's
  // timestamp decides whether the throttled (non-forced) prune at the top of
  // the limiter pre-empts the forced-prune-at-cap branch under test.
  lastBucketPruneAt = 0;
}

export function __fillHostedRateLimitBucketsForTests(
  count = MAX_BUCKETS,
  resetAtOffsetMs = 60_000,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__fillHostedRateLimitBucketsForTests is test-only");
  }
  buckets.clear();
  for (let i = 0; i < count; i++) {
    buckets.set(`test-overflow:${i}`, {
      count: 1,
      resetAt: Date.now() + resetAtOffsetMs,
    });
  }
  // Mark the map as just-pruned so the throttled (non-forced) prune at the top
  // of the limiter is skipped on the next request. That guarantees the
  // forced-prune-at-cap branch — not the periodic prune — is what clears
  // expired buckets, so "forces expired-bucket pruning at cap" tests exercise
  // the branch they claim to regardless of order or isolated (-t) runs.
  lastBucketPruneAt = Date.now();
}

// Cold-start safe: never start a top-level timer at module import.
// `app.ts` (and therefore the Vercel function entrypoint) imports
// this module, and a `setInterval(...)` here would keep the serverless
// function alive past its expected idle window. Hot requests lazily
// validate their own bucket; full-map pruning is throttled and forced
// only at cap so high-cardinality traffic cannot make every request O(n).
function pruneExpiredBuckets(now: number, force = false): void {
  if (!force && now - lastBucketPruneAt < BUCKET_PRUNE_INTERVAL_MS) return;
  lastBucketPruneAt = now;
  for (const [key, val] of buckets) {
    if (val.resetAt <= now) buckets.delete(key);
  }
}

interface HostedRateLimitOptions {
  bucket: string;
  max: number;
  windowMs: number;
}

/**
 * Simple IP-based brute-force limiter. Only appropriate for surfaces
 * where every request should count (e.g. login forms). NOT suitable
 * for authenticated API surfaces where auth behavior must be preserved.
 */
export function hostedRateLimit(opts: HostedRateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    // Only trust forwarded headers behind a known proxy. Without
    // VERITY_TRUST_PROXY=1 plus a serverless/Vercel runtime signal, all
    // clients share the "local" bucket.
    let ip = "local";
    if (isTrustProxyEnabled()) {
      ip = extractForwardedClientIp((name) => c.req.header(name));
    }
    const bucketKey = `${opts.bucket}:ip:${ip}`;
    const now = Date.now();
    pruneExpiredBuckets(now);
    let current = buckets.get(bucketKey);

    if (current && current.resetAt <= now) {
      buckets.delete(bucketKey);
      current = undefined;
    }

    if (!current) {
      if (buckets.size >= MAX_BUCKETS) {
        pruneExpiredBuckets(now, true);
      }
      if (buckets.size >= MAX_BUCKETS) {
        const retryAfter = Math.max(1, Math.ceil(opts.windowMs / 1000));
        c.header("Retry-After", String(retryAfter));
        const accept = c.req.header("Accept") || "";
        if (accept.includes("text/html")) {
          return c.html(
            `<!DOCTYPE html><html><head><title>429</title></head>` +
            `<body style="font-family:sans-serif;background:#021008;color:#e8dcc0;display:flex;align-items:center;justify-content:center;min-height:100vh">` +
            `<div style="text-align:center"><h1>Too Many Requests</h1><p>Wait ${retryAfter}s.</p></div></body></html>`,
            429,
          );
        }
        return errorJson(c, "rate_limited", { details: { retry_after: retryAfter } });
      }
      current = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(bucketKey, current);
    }

    // Increment before next() so concurrent requests in the same
    // window all see and update the same counter object.
    current.count += 1;

    if (current.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      const accept = c.req.header("Accept") || "";
      if (accept.includes("text/html")) {
        return c.html(
          `<!DOCTYPE html><html><head><title>429</title></head>` +
          `<body style="font-family:sans-serif;background:#021008;color:#e8dcc0;display:flex;align-items:center;justify-content:center;min-height:100vh">` +
          `<div style="text-align:center"><h1>Too Many Requests</h1><p>Wait ${retryAfter}s.</p></div></body></html>`,
          429,
        );
      }
      return errorJson(c, "rate_limited", { details: { retry_after: retryAfter } });
    }

    return next();
  };
}
