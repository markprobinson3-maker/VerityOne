/**
 * Federation rate-limit layer — VO-FEDERATION-RATE-LIMITS-PR-1
 * (rung 12b).
 *
 * Defines route classes plus token-bucket machinery for the
 * federation mutation surfaces that the exec plan's Phase 5 pins:
 *
 *   - `/account/link`      prevent enumeration       per-account
 *   - `/account/connect/*` prevent OAuth-code abuse   per-IP /
 *                                                     per-account /
 *                                                     per-code
 *   - `/account/drive/*`   prevent OAuth flood        per-account /
 *                                                     per-sync-node
 *   - hosted queue/control
 *     (`/remote/queue`,
 *      `/remote/cancel`,
 *      `/my/sync/control`) prevent flood              per-tenant +
 *                                                     per-account
 *   - `/hosted-mcp/write`  prevent hosted MCP write   per-tenant +
 *                          flood                      per-account +
 *                                                     per-agent
 *   - sync node writes
 *     (`/sync/push`,
 *      `/remote/result`)   prevent rotation-lock      per-tenant +
 *                          starvation / result flood  per-node
 *   - `/account/onboarding/confirm`
 *                          prevent tenant-slug abuse  per-account +
 *                                                     per-IP
 *
 * Account onboarding is included in the shared route-class vocabulary
 * and key helpers, but its route intentionally uses the DB-backed
 * fixed-window limiter in `onboarding-rate-limit.ts`; the other route
 * classes use the single-process token bucket in this module.
 *
 * **Not a middleware.** Each federation route already has its
 * own auth resolver (`requirePortalSession`, `requireSyncAuth`,
 * `resolveAuth`) whose output is the exact identity we key on.
 * A generic middleware would have to re-implement that auth
 * resolution — instead, the route handler calls `recordHit(...)`
 * after auth resolves and returns 429 with `Retry-After`
 * directly. Unauthenticated flood protection remains proxy /
 * login-middleware territory; see `hosted-rate-limit.ts` for the
 * architecture note.
 *
 * **Single-process, in-memory bucket.** GA scope is single-node
 * API deployments; distributed rate limits are explicitly
 * out-of-scope for rung 12b (future rung can layer a Redis or
 * DB-backed bucket under this same surface).
 *
 * **Emits a `federation_activity` error event on every tenant-
 * resolved 429.** See `emitRateLimitHit()` in
 * `federation-activity-writer.ts`. The event carries
 * `error_category="rate_limit"` so the dashboard + audit export can
 * distinguish rate-limited errors from handler exceptions. Pre-tenant
 * rate limits still return `Retry-After`, but the telemetry helper is
 * a no-op because `federation_activity.tenant_id` is required.
 */

/** Stable route-class identifiers. The union is a drift-guard
 *  anchor: adding a new rate-limited route means extending this
 *  union + the corresponding key builder, so a route handler
 *  cannot silently use an untracked bucket namespace. */
export type RateLimitedRoute =
  | "account_link"
  | "account_connect"
  | "account_drive"
  | "account_onboarding"
  | "hosted_mcp_write"
  | "remote_queue"
  | "sync_push";

export const RATE_LIMITED_ROUTES: readonly RateLimitedRoute[] = [
  "account_link",
  "account_connect",
  "account_drive",
  "account_onboarding",
  "hosted_mcp_write",
  "remote_queue",
  "sync_push",
] as const;

export type TokenBucketRateLimitedRoute = Exclude<RateLimitedRoute, "account_onboarding">;

/** Token-bucket subset of RATE_LIMITED_ROUTES. Exported so drift tests
 *  and future metrics enumeration can distinguish routes served by this
 *  in-memory limiter from DB-backed account onboarding, which must branch
 *  to `recordOnboardingRateLimitHit()` instead of `recordHit()`. */
export const TOKEN_BUCKET_RATE_LIMITED_ROUTES: readonly TokenBucketRateLimitedRoute[] = [
  "account_link",
  "account_connect",
  "account_drive",
  "hosted_mcp_write",
  "remote_queue",
  "sync_push",
] as const;

/** Env-driven config with safe defaults. Per-route overrides
 *  via explicit env vars — sync-node write routes run hotter because
 *  chunky batch/result uploads are the expected traffic shape. */
interface BucketConfig {
  /** Max tokens the bucket can hold (burst ceiling). */
  burst: number;
  /** Sustained fill rate in tokens per minute. */
  per_minute: number;
}

const MIN_BURST = 5;
const MIN_PER_MINUTE = 10;
const PRUNE_EVERY_HITS = 256;
const PRUNE_MIN_INTERVAL_MS = 10_000;

function readInt(envName: string, fallback: number, min: number = 1): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function loadConfig(route: TokenBucketRateLimitedRoute): BucketConfig {
  const base_burst = readInt("VO_RATE_LIMIT_BURST", 30);
  const base_per_minute = readInt("VO_RATE_LIMIT_PER_MINUTE", 120);

  switch (route) {
    case "sync_push":
      // Sync-push uploads can run chunky; allow a larger burst
      // and a higher sustained rate without drowning the bucket.
      return {
        burst: Math.max(
          MIN_BURST,
          readInt("VO_RATE_LIMIT_SYNC_PUSH_BURST", Math.max(MIN_BURST, base_burst * 2)),
        ),
        per_minute: Math.max(
          MIN_PER_MINUTE,
          readInt(
            "VO_RATE_LIMIT_SYNC_PUSH_PER_MINUTE",
            Math.max(MIN_PER_MINUTE, base_per_minute * 2),
          ),
        ),
      };
    case "account_link":
    case "account_connect":
    case "account_drive":
      // Account-facing flows use a tighter clamp than the defaults;
      // anti-abuse traffic should burst narrowly.
      // The absolute floor applies even to explicit route overrides:
      // operators may tune this limiter, but cannot accidentally
      // disable these account-facing paths by setting a too-low value.
      return {
        burst: Math.max(
          MIN_BURST,
          readInt(
            "VO_RATE_LIMIT_ACCOUNT_LINK_BURST",
            Math.max(MIN_BURST, Math.floor(base_burst / 2)),
          ),
        ),
        per_minute: Math.max(
          MIN_PER_MINUTE,
          readInt(
            "VO_RATE_LIMIT_ACCOUNT_LINK_PER_MINUTE",
            Math.max(MIN_PER_MINUTE, Math.floor(base_per_minute / 2)),
          ),
        ),
      };
    case "hosted_mcp_write":
      // Hosted MCP write intent is keyed per tenant/account/agent.
      // Aggregate protection against agent proliferation belongs to
      // credential issuance, suspension, and revoke controls; this
      // bucket protects each issued agent identity from bursting.
      return {
        burst: Math.max(
          MIN_BURST,
          readInt("VO_RATE_LIMIT_HOSTED_MCP_WRITE_BURST", Math.max(MIN_BURST, base_burst)),
        ),
        per_minute: Math.max(
          MIN_PER_MINUTE,
          readInt(
            "VO_RATE_LIMIT_HOSTED_MCP_WRITE_PER_MINUTE",
            Math.max(MIN_PER_MINUTE, base_per_minute),
          ),
        ),
      };
    case "remote_queue":
      return {
        burst: Math.max(MIN_BURST, base_burst),
        per_minute: Math.max(MIN_PER_MINUTE, base_per_minute),
      };
    default: {
      const routeName = String(route);
      console.warn(`[federation-rate-limit] unknown token-bucket route "${routeName}"; using default config`);
      return {
        burst: Math.max(MIN_BURST, base_burst),
        per_minute: Math.max(MIN_PER_MINUTE, base_per_minute),
      };
    }
  }
}

/** Per-bucket runtime state. `tokens` is a float so partial-
 *  second refills accumulate correctly between hits. */
interface BucketState {
  tokens: number;
  last_refill_ms: number;
  /** Cached config snapshot so env changes during a process
   *  lifetime do not reshape an existing bucket mid-window;
   *  config is re-read only when a bucket is first created. */
  config: BucketConfig;
}

const buckets = new Map<string, BucketState>();
let hitsSincePrune = 0;
let lastPruneMs = 0;

/** Test-only reset. Keeps bucket state off the global singleton
 *  between test files / cases so a prior 429 does not poison a
 *  subsequent test. Never called by route handlers. */
export function __resetRateLimitStateForTests(): void {
  // Guard: this wipes ALL live federation token buckets. It must never be
  // reachable in production (a self-inflicted limiter reset / DoS-amplifier),
  // matching the hosted limiter's test-helper guards.
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetRateLimitStateForTests is test-only (NODE_ENV must be 'test').");
  }
  buckets.clear();
  hitsSincePrune = 0;
  lastPruneMs = 0;
}

/**
 * F9: idle-bucket prune. A token-bucket has no `resetAt` (different
 * shape from `access.ts:rateLimit`), so the prune key is "fully
 * refilled AND idle for longer than a conservative TTL". TTL is
 * `max(10 minutes, 2 * burst/per_minute minutes)` so a busy tenant
 * doesn't get its bucket evicted between bursts. Mirrors the spirit
 * of `hosted-rate-limit.ts:pruneExpiredBuckets()` without copying the
 * resetAt-based predicate.
 */
function pruneIdleBuckets(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    const elapsedMs = Math.max(0, nowMs - bucket.last_refill_ms);
    const accrued = (elapsedMs / 60_000) * bucket.config.per_minute;
    const effectiveTokens = Math.min(bucket.config.burst, bucket.tokens + accrued);
    if (effectiveTokens < bucket.config.burst) continue;
    const refillMinutes = bucket.config.burst / Math.max(1, bucket.config.per_minute);
    const ttlMs = Math.max(10 * 60_000, refillMinutes * 2 * 60_000);
    if (nowMs - bucket.last_refill_ms > ttlMs) buckets.delete(key);
  }
}

function maybePruneIdleBuckets(nowMs: number): void {
  hitsSincePrune += 1;
  const elapsedSinceLastPrune = nowMs >= lastPruneMs
    ? nowMs - lastPruneMs
    : PRUNE_MIN_INTERVAL_MS;
  if (
    hitsSincePrune < PRUNE_EVERY_HITS &&
    elapsedSinceLastPrune < PRUNE_MIN_INTERVAL_MS
  ) {
    return;
  }
  hitsSincePrune = 0;
  lastPruneMs = nowMs;
  pruneIdleBuckets(nowMs);
}

export interface RecordHitResult {
  allowed: boolean;
  retry_after_seconds: number;
  /** Snapshot of remaining tokens AFTER the hit. Useful for the
   *  `X-RateLimit-Remaining` response header callers may set. */
  remaining: number;
}

/** Record one request against the bucket. Returns whether to
 *  allow or 429. `account_onboarding` is intentionally excluded at
 *  the type level: it uses the DB-backed fixed-window limiter and
 *  callers must branch before calling this in-memory helper.
 *  `retry_after_seconds` is always >= 1 on a rejection so the header
 *  value is never 0 (some clients reject 0 as invalid). */
export function recordHit(
  route: TokenBucketRateLimitedRoute,
  identity: string,
  nowMs: number = Date.now(),
): RecordHitResult {
  maybePruneIdleBuckets(nowMs);
  const key = `${route}::${identity}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    const config = loadConfig(route);
    bucket = { tokens: config.burst, last_refill_ms: nowMs, config };
    buckets.set(key, bucket);
  }

  // Refill: linear accrual at `per_minute / 60` tokens/sec,
  // capped at burst. Handles elapsed-time floats cleanly.
  const effectiveNowMs = Math.max(nowMs, bucket.last_refill_ms);
  const elapsed_ms = effectiveNowMs - bucket.last_refill_ms;
  const accrued = (elapsed_ms / 60_000) * bucket.config.per_minute;
  bucket.tokens = Math.min(bucket.config.burst, bucket.tokens + accrued);
  bucket.last_refill_ms = effectiveNowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      retry_after_seconds: 0,
      remaining: Math.floor(bucket.tokens),
    };
  }

  // Rejected. Compute how long until the bucket has one full
  // token again. tokens is in [0, 1) here.
  const deficit = 1 - bucket.tokens;
  const seconds_needed = deficit / (bucket.config.per_minute / 60);
  return {
    allowed: false,
    retry_after_seconds: Math.max(1, Math.ceil(seconds_needed)),
    remaining: 0,
  };
}

/** Opaque observability read. Returns null when the bucket has
 *  never been touched (no hits seen). Future `/dashboard/
 *  sessions` row may surface "rate-limited" status for a given
 *  tenant/agent via this. */
export function getBucketSnapshot(
  route: TokenBucketRateLimitedRoute,
  identity: string,
): {
  tokens: number;
  burst: number;
  per_minute: number;
} | null {
  const bucket = buckets.get(`${route}::${identity}`);
  if (!bucket) return null;
  return {
    tokens: bucket.tokens,
    burst: bucket.config.burst,
    per_minute: bucket.config.per_minute,
  };
}

// ── Key builders (one per route) ────────────────────────────

/** `/account/link` key: account-scoped for the shipped route.
 *  The IP scope is intentionally namespaced for future proxy /
 *  pre-auth integrations, but `/account/link` itself currently
 *  calls this after resolving a hosted account. The `scope`
 *  discriminant prevents any future IP-keyed hit from sharing a
 *  bucket with an account-keyed hit for the same id string. */
export function accountLinkKey(input:
  | { scope: "account"; account_id: string }
  | { scope: "ip"; ip: string }): string {
  if (input.scope === "account") return `a:${input.account_id}`;
  return `ip:${input.ip}`;
}

/** `/account/connect/*` start key: pre-auth and IP scoped.
 *  Identity strings use short phase prefixes because `recordHit()`
 *  stores them under the `account_connect::` route namespace. */
export function accountConnectStartKey(input: { ip: string }): string {
  return `start|ip:${input.ip}`;
}

/** `/account/connect/*` confirm key: hosted-session/account scoped.
 *  Identity strings use short phase prefixes because `recordHit()`
 *  stores them under the `account_connect::` route namespace. */
export function accountConnectConfirmKey(input: { account_id: string }): string {
  return `confirm|a:${input.account_id}`;
}

/** `/account/connect/redeem` key: local callback scoped by IP before a
 *  code is readable, then by hashed code after JSON parsing. The route
 *  records both buckets for real redeem attempts: IP throttles clients,
 *  code_hash throttles leaked-code brute force across rotating IPs.
 *  Identity strings use short phase prefixes because `recordHit()`
 *  stores them under the `account_connect::` route namespace. */
export function accountConnectRedeemKey(input: { ip: string; code_hash?: string }): string {
  return input.code_hash
    ? `redeem|c:${input.code_hash}`
    : `redeem|ip:${input.ip}`;
}

/** `/account/onboarding/*` key: hosted-session/account plus IP. */
export function accountOnboardingKey(input:
  | { scope: "account"; account_id: string }
  | { scope: "ip"; ip: string }): string {
  if (input.scope === "account") return `account_onboarding|a:${input.account_id}`;
  return `account_onboarding|ip:${input.ip}`;
}

/** `/account/drive/*` key: hosted account or sync-node scoped.
 *  Start and redeem intentionally share the same sync-node bucket:
 *  they are one local-node authorization flow, so a noisy node cannot
 *  double its budget by alternating endpoints. */
export function accountDriveKey(input:
  | { scope: "account"; account_id: string }
  | { scope: "sync_node"; tenant_id: string; node_id: string }
  | { scope: "ip"; ip: string }): string {
  if (input.scope === "account") return `drive|a:${input.account_id}`;
  if (input.scope === "sync_node") return `drive|t:${input.tenant_id}|n:${input.node_id}`;
  return `drive|ip:${input.ip}`;
}

/** Hosted queue/control key shared by `/remote/queue`,
 *  `/remote/cancel`, and `/my/sync/control`. All three act on
 *  remote_commands, so they share one tenant+account budget.
 *  Session-bound. */
export function remoteQueueKey(input: {
  tenant_id: string;
  account_id: string;
}): string {
  return `t:${input.tenant_id}|a:${input.account_id}`;
}

/** `/hosted-mcp/write` key: tenant + account + hosted MCP agent.
 *  Budgets are intentionally per issued agent credential; account-
 *  level aggregate protection is handled by credential issuance,
 *  suspension, and revocation controls. */
export function hostedMcpWriteKey(input: {
  tenant_id: string;
  account_id: string;
  agent_id: string;
}): string {
  return `t:${input.tenant_id}|a:${input.account_id}|agent:${input.agent_id}`;
}

/** Sync-node write key shared by `/sync/push` and `/remote/result`:
 *  tenant + node, sync-token-bound. */
export function syncPushKey(input: {
  tenant_id: string;
  node_id: string;
}): string {
  return `t:${input.tenant_id}|n:${input.node_id}`;
}
