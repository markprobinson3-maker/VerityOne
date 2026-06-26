import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { errorJson } from "./error-envelope";
import { mcpAllowedOrigins } from "./mcp-origin";
import { GLOBAL_SPACE_ID, tenantSpaceId } from "./spaces";
import { isWebMcpConnectorEnabled } from "./web-mcp-connector-profile";

export type AccessScope = "anonymous" | "beta" | "operator";

export interface AccessContext {
  scope: AccessScope;
  token: string | null;
  agentId: string | null;
  tenantId: string | null;
  spaceIds: string[] | null;
}

const DEFAULT_BETA_TOKEN = "change-me-in-beta";
const DEFAULT_OPERATOR_TOKEN = "change-me-in-production";
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
  "http://localhost:3101",
  "http://127.0.0.1:3101",
];
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const TRUST_PROXY_ENV = "VERITY_TRUST_PROXY";
export const TRUST_PROXY_REQUIRED_VALUE = "1";
const SERVERLESS_PROFILE = "serverless";
const TRUST_PROXY_REQUIRED_REASON =
  "VERITY_TRUST_PROXY=1 is required for serverless rate-limit identity";
const TRUST_PROXY_UNSAFE_REASON =
  "VERITY_TRUST_PROXY=1 is only safe behind a trusted proxy/serverless deployment";

type EnvLike = Record<string, string | undefined>;

function isTrustProxyConfigured(env: EnvLike = process.env): boolean {
  return (env[TRUST_PROXY_ENV] || "").trim() === TRUST_PROXY_REQUIRED_VALUE;
}

function trimmedEnv(env: EnvLike, key: string): string {
  return (env[key] || "").trim();
}

function isVercelRuntimeLike(env: EnvLike): boolean {
  return trimmedEnv(env, "VERCEL") === "1" ||
    Boolean(trimmedEnv(env, "VERCEL_ENV")) ||
    Boolean(trimmedEnv(env, "VERCEL_URL"));
}

// Placeholder substrings that betray an unrotated/missing secret. Kept hyphenated/
// multi-word so a legitimate high-entropy secret cannot collide.
const PLACEHOLDER_TOKEN_SUBSTRINGS = [
  "change-me-in-beta",
  "change-me-in-production",
  "your-secret-here",
  "replace-with-your",
];

function isPlaceholderTokenValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return PLACEHOLDER_TOKEN_SUBSTRINGS.some((p) => v.includes(p));
}

/**
 * Authoritative production/serverless signal — mirrors requiresTrustProxy() above and
 * isServerlessLike in hosted-connector-deployment.ts. In this mode the dev/test fixture
 * token defaults (DEFAULT_BETA_TOKEN / DEFAULT_OPERATOR_TOKEN) must never authenticate.
 * NODE_ENV=test is the explicit dev/test escape hatch (independently forbidden on
 * serverless by the deployment validator), so it is never production here.
 */
function isProductionAuthMode(env: EnvLike = process.env): boolean {
  if (trimmedEnv(env, "NODE_ENV") === "test") return false;
  return trimmedEnv(env, "VERITY_DEPLOYMENT_PROFILE") === SERVERLESS_PROFILE ||
    isVercelRuntimeLike(env);
}

function requiresTrustProxy(env: EnvLike): boolean {
  return trimmedEnv(env, "VERITY_DEPLOYMENT_PROFILE") === SERVERLESS_PROFILE ||
    isVercelRuntimeLike(env);
}

export function isTrustProxyEnabled(env: EnvLike = process.env): boolean {
  return isTrustProxyConfigured(env) && requiresTrustProxy(env);
}

/**
 * Derive the client IP used to key rate-limit buckets, trusting only values a
 * trusted proxy controls — never a client-supplied one. Callers gate this
 * behind isTrustProxyEnabled() (VERITY_TRUST_PROXY=1 + a serverless/Vercel
 * signal), which asserts a trusted proxy populates the forwarded headers.
 *
 * Trust order:
 *  1. x-vercel-forwarded-for — Vercel sets this to the real client IP and
 *     preserves it even behind an additional proxy; the client cannot forge it
 *     (Vercel overwrites client-supplied forwarded headers to prevent spoofing).
 *  2. The RIGHT-MOST x-forwarded-for entry — the hop appended by the nearest
 *     trusted proxy. Never the left-most entry: on any platform that *appends*
 *     (rather than overwrites) x-forwarded-for, the left-most value is
 *     attacker-controlled, so keying on it lets one client mint a fresh bucket
 *     per request (X-Forwarded-For: <rotating>, <real-ip>) and defeat the
 *     limiter — and fill the bucket map to its cap with fake identities.
 *  3. x-real-ip, then "local".
 */
export function extractForwardedClientIp(header: (name: string) => string | null | undefined): string {
  const vercelForwarded = firstForwardedIp(header("x-vercel-forwarded-for"));
  if (vercelForwarded) return vercelForwarded;
  const trustedHop = lastForwardedIp(header("x-forwarded-for"));
  if (trustedHop) return trustedHop;
  return header("x-real-ip")?.trim() || "local";
}

function firstForwardedIp(raw: string | null | undefined): string | null {
  const first = raw?.split(",")[0]?.trim();
  return first || null;
}

function lastForwardedIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

export function trustProxyConfigStatus(env: EnvLike = process.env): {
  required: boolean;
  configured: boolean;
  reason: string | null;
} {
  const required = requiresTrustProxy(env);
  const configured = isTrustProxyConfigured(env);
  return {
    required,
    configured,
    reason: required && !configured
      ? TRUST_PROXY_REQUIRED_REASON
      : configured && !required
        ? TRUST_PROXY_UNSAFE_REASON
        : null,
  };
}

function parseCsvSet(raw: string | undefined, fallback: string[] = []): Set<string> {
  const values = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values.length > 0 ? values : fallback);
}

function parseAgentTokenMap(raw: string | undefined): Map<string, string> {
  const pairs = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const byToken = new Map<string, string>();
  for (const pair of pairs) {
    const sep = pair.lastIndexOf(":");
    if (sep <= 0) continue;
    const agentId = pair.slice(0, sep).trim();
    const token = pair.slice(sep + 1).trim();
    if (agentId && token) byToken.set(token, agentId);
  }
  return byToken;
}

function parseAgentTenantMap(raw: string | undefined): Map<string, string> {
  const pairs = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const byAgent = new Map<string, string>();
  for (const pair of pairs) {
    const parts = pair.split(":");
    if (parts.length !== 2) continue;
    const [agentIdRaw, tenantIdRaw] = parts;
    const agentId = agentIdRaw.trim();
    const tenantId = tenantIdRaw.trim();
    if (agentId && TENANT_ID_RE.test(tenantId)) byAgent.set(agentId, tenantId);
  }
  return byAgent;
}

function tokenSet(raw: string | undefined, fixtureFallback: string[]): Set<string> {
  // In production mode there is NO fixture fallback: an empty/missing env yields an empty
  // set so the well-known placeholders can never authenticate. In dev/test the fixture
  // default is preserved (unchanged behavior).
  const prod = isProductionAuthMode();
  const parsed = parseCsvSet(raw, prod ? [] : fixtureFallback);
  // Defense in depth: even if a placeholder somehow lands in the env, never treat it as a
  // valid token in production.
  if (prod) {
    for (const value of [...parsed]) {
      if (isPlaceholderTokenValue(value)) parsed.delete(value);
    }
  }
  return parsed;
}

function currentConfig() {
  return {
    betaTokens: tokenSet(process.env.VERITY_BETA_TOKENS, [DEFAULT_BETA_TOKEN]),
    operatorTokens: tokenSet(process.env.VERITY_OPERATOR_TOKENS, [DEFAULT_OPERATOR_TOKEN]),
    agentTokens: parseAgentTokenMap(process.env.VERITY_AGENT_TOKENS),
    agentTenants: parseAgentTenantMap(process.env.VERITY_AGENT_TENANTS),
    allowedOrigins: parseCsvSet(process.env.VERITY_CORS_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
  };
}

/**
 * Boot guard: in production/serverless mode, REFUSE BOOT when the auth token envs are
 * absent or placeholder-like. Throws a names-only Error (never a secret value). Called
 * once at module load from app.ts so BOTH the long-lived launcher and the Vercel cold-start
 * import fail closed instead of serving a node where "change-me-in-production" is a valid
 * operator bearer. Dev/test (non-serverless, no VERCEL_*, or NODE_ENV=test) is a no-op.
 */
export function assertAuthSecretsConfigured(env: EnvLike = process.env): void {
  if (!isProductionAuthMode(env)) return;
  const problems: string[] = [];
  const check = (key: string, required: boolean) => {
    const raw = trimmedEnv(env, key);
    if (!raw) {
      if (required) problems.push(`${key} is not set`);
      return;
    }
    const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
    if (required && values.length === 0) {
      problems.push(`${key} is not set`);
      return;
    }
    if (values.some((v) => isPlaceholderTokenValue(v))) {
      problems.push(`${key} contains an unrotated placeholder value`);
    }
  };
  check("VERITY_OPERATOR_TOKENS", true);
  check("VERITY_BETA_TOKENS", true);
  // VI_WEBHOOK_KEY is optional (no webhook ingestion => unset is fine) but a placeholder
  // value must never ship.
  check("VI_WEBHOOK_KEY", false);
  if (problems.length > 0) {
    throw new Error(
      "Refusing to boot in production: auth secrets are misconfigured — " +
        problems.join("; ") +
        ". Set rotated values for VERITY_OPERATOR_TOKENS and VERITY_BETA_TOKENS (and " +
        "VI_WEBHOOK_KEY if used).",
    );
  }
}

/**
 * Safe agent-id shape (1-80 chars: letters/digits/_-.:) shared by the /connect onboarding
 * surface. Rejecting anything else stops /connect?agent=... from persisting arbitrary-
 * length / arbitrary-content identifiers into agent_profiles.
 */
export const SAFE_AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

export function isSafeAgentId(value: string): boolean {
  return SAFE_AGENT_ID_PATTERN.test(value);
}

/** Detect a VO token-looking string so a leaked secret is never persisted or echoed back. */
export function looksLikeVoSecret(value: string): boolean {
  return /\bv(?:op|oc|ocr|oca|ons|os|oa|odg)_[A-Za-z0-9._~+/=-]{12,}\b/.test(value);
}

function isAllowedOrigin(origin: string, requestUrl: string, allowedOrigins: Set<string>): boolean {
  if (allowedOrigins.has("*") || allowedOrigins.has(origin)) return true;

  try {
    const originUrl = new URL(origin);
    const targetUrl = new URL(requestUrl);
    const sameHostname = originUrl.hostname === targetUrl.hostname;
    const webProtocols = (originUrl.protocol === "http:" || originUrl.protocol === "https:")
      && (targetUrl.protocol === "http:" || targetUrl.protocol === "https:");
    if (sameHostname && webProtocols) return true;
  } catch {
    return false;
  }

  return false;
}

/**
 * Exact-host CORS validation for the browser-session bridge (the local VO node's
 * browser-capture endpoint). Replaces a substring `origin.includes("verityone.app")`
 * check that accepted suffix/prefix/authority-injection origins such as
 * `https://verityone.app.evil.test`, `https://evilverityone.app`, and
 * `https://verityone.app@evil.test`. Fail-closed: only an http(s) origin whose parsed
 * host is exactly `verityone.app`, a well-formed `*.verityone.app` subdomain, or
 * loopback (`localhost` / `127.0.0.1`, any port) is accepted.
 */
export function isValidBrowserSessionOrigin(origin: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (host === "verityone.app") return true;
  if (host.endsWith(".verityone.app")) {
    // Require ≥1 non-empty DNS label before ".verityone.app" (rejects ".verityone.app").
    const label = host.slice(0, -".verityone.app".length);
    return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(label);
  }
  if (host === "localhost" || host === "127.0.0.1") return true;
  return false;
}

function tokenFromRequestLike(input: { headers: Headers; url: string }): string | null {
  const auth = input.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();
  // Query-string tokens removed — they leak into logs, browser history, and referrers.
  // Use Authorization: Bearer <token> header only.
  return null;
}

function bearerToken(c: Context): string | null {
  return tokenFromRequestLike(c.req.raw);
}

/**
 * F9: clientKey only trusts forwarded headers under VERITY_TRUST_PROXY=1
 * plus a serverless/Vercel runtime signal. Without both gates, an unauthenticated
 * client could spoof x-forwarded-for / x-real-ip to create unbounded
 * distinct rate-limit buckets and pump the in-memory Map. When trust is
 * disabled, the helper returns "local" for tokenless requests and the
 * limiter collapses them all into one shared bucket.
 */
function clientKey(c: Context): string {
  if (isTrustProxyEnabled()) {
    return extractForwardedClientIp((name) => c.req.header(name));
  }
  return "local";
}

export function sourceRateLimitIdentity(c: Context): string {
  return clientKey(c);
}

function parseAccessContext(c: Context): AccessContext {
  return resolveAccessContextFromRequest(c.req.raw);
}

export function resolveAccessContextFromRequest(request: Request): AccessContext {
  const token = tokenFromRequestLike(request);
  if (!token) {
    return { scope: "anonymous", token: null, agentId: null, tenantId: null, spaceIds: [GLOBAL_SPACE_ID] };
  }

  const config = currentConfig();
  if (config.operatorTokens.has(token)) {
    return { scope: "operator", token, agentId: null, tenantId: null, spaceIds: null };
  }

  const agentId = config.agentTokens.get(token) || null;
  if (agentId) {
    const tenantId = config.agentTenants.get(agentId) || null;
    return {
      scope: "beta",
      token,
      agentId,
      tenantId,
      spaceIds: tenantId ? [GLOBAL_SPACE_ID, tenantSpaceId(tenantId)] : [GLOBAL_SPACE_ID],
    };
  }

  if (config.betaTokens.has(token)) {
    return { scope: "beta", token, agentId: null, tenantId: null, spaceIds: [GLOBAL_SPACE_ID] };
  }

  return { scope: "anonymous", token: null, agentId: null, tenantId: null, spaceIds: [GLOBAL_SPACE_ID] };
}

export const attachAccessContext: MiddlewareHandler = async (c, next) => {
  c.set("access", parseAccessContext(c));
  await next();
};

export function getAccessContext(c: Context): AccessContext {
  const cached = c.get("access") as AccessContext | undefined;
  return cached || parseAccessContext(c);
}

export function isOperator(c: Context): boolean {
  return getAccessContext(c).scope === "operator";
}

/**
 * Resolve a tenant-scoped bearer token for the given tenantId.
 *
 * Use case: server-side code (e.g. the dashboard harvest route) that
 * needs to make authenticated calls to routes like /memory/write, which
 * hard-require `access.tenantId`. Operator tokens resolve to
 * `tenantId: null` and would be rejected; this helper returns a bearer
 * whose access context actually resolves to `scope: "beta"` with the
 * expected `tenantId`.
 *
 * Resolution algorithm — this cannot just pick "first agent, first
 * token" because two real failure shapes would slip through:
 *   (a) Multiple agents may be mapped to the same tenant, but only a
 *       non-first agent has a token in `VERITY_AGENT_TOKENS`.
 *   (b) The candidate token may also appear in
 *       `VERITY_OPERATOR_TOKENS`; `resolveAccessContextFromRequest`
 *       matches operator before agent, so the bearer would round-trip
 *       as `scope: "operator"` with `tenantId: null`, reintroducing
 *       the /memory/write failure.
 *
 * Instead: iterate ALL agents mapped to the tenant, iterate ALL tokens
 * mapped to each agent, and round-trip each candidate through the real
 * resolver. Return the first bearer whose access context is
 * `scope: "beta"` AND `tenantId === tenantId`. Return `null` when no
 * candidate survives — callers must fail clearly rather than silently
 * degrading.
 */
export function resolveAgentBearerForTenant(tenantId: string): string | null {
  if (!tenantId) return null;
  const config = currentConfig();

  const agentIds = [...config.agentTenants.entries()]
    .filter(([, t]) => t === tenantId)
    .map(([agentId]) => agentId);
  if (agentIds.length === 0) return null;

  const agentIdSet = new Set(agentIds);
  const candidateTokens = [...config.agentTokens.entries()]
    .filter(([, agentId]) => agentIdSet.has(agentId))
    .map(([token]) => token);

  for (const token of candidateTokens) {
    // Synthesize a minimal Request so we exercise the real resolver.
    // Any 3100-series URL works — the path isn't inspected.
    const probe = new Request("http://localhost/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const access = resolveAccessContextFromRequest(probe);
    if (access.scope === "beta" && access.tenantId === tenantId) {
      return token;
    }
  }

  return null;
}

export function hasBetaAccess(c: Context): boolean {
  const scope = getAccessContext(c).scope;
  return scope === "beta" || scope === "operator";
}

export function allowedRegistryAccessLevels(c: Context): string[] {
  const scope = getAccessContext(c).scope;
  if (scope === "operator") return ["public", "shared", "private"];
  if (scope === "beta") return ["public", "shared"];
  return ["public"];
}

export function canReadRegistryAccessLevel(c: Context, accessLevel: string | null | undefined): boolean {
  if (!accessLevel) return false;
  return allowedRegistryAccessLevels(c).includes(accessLevel);
}

export function canReadSpaceId(
  access: AccessContext | AccessScope,
  spaceId: string | null | undefined,
): boolean {
  const resolved = typeof access === "string"
    ? ({ scope: access, token: null, agentId: null, tenantId: null, spaceIds: access === "operator" ? null : [GLOBAL_SPACE_ID] } satisfies AccessContext)
    : access;
  if (resolved.scope === "operator") return true;
  const visibleSpaces = resolved.spaceIds || [GLOBAL_SPACE_ID];
  return visibleSpaces.includes((spaceId || GLOBAL_SPACE_ID).trim() || GLOBAL_SPACE_ID);
}

export function visibleSpaceIds(access: AccessContext | AccessScope): string[] | null {
  if (typeof access === "string") {
    return access === "operator" ? null : [GLOBAL_SPACE_ID];
  }
  return access.scope === "operator" ? null : (access.spaceIds || [GLOBAL_SPACE_ID]);
}

export function requireBetaAccess(): MiddlewareHandler {
  return async (c, next) => {
    if (!hasBetaAccess(c)) {
      return errorJson(c, "unauthorized", {
        hint: "This endpoint requires a beta token. Pass it via Authorization: Bearer <token> header. See GET /connect for onboarding.",
      });
    }
    await next();
  };
}

export function requireOperatorAccess(): MiddlewareHandler {
  return async (c, next) => {
    if (!isOperator(c)) {
      return errorJson(c, "operator_required", {
        hint: "This endpoint requires operator-level access.",
      });
    }
    await next();
  };
}

export function assertAgentSelfOrOperator(c: Context, agentId: string): boolean {
  const access = getAccessContext(c);
  if (access.scope === "operator") return true;
  if (access.agentId) return access.agentId === agentId;
  // Beta tokens without a mapped agentId can only access their own tenant data,
  // not impersonate specific agents. Allow read but block agent-specific writes.
  return false;
}

/**
 * MT14: resolve the tenant that an agent's profile/telemetry belongs to. This is
 * the single source of truth for stamping/scoping the tenant_id column on
 * agent_profiles, agent_queries, and agent_watches. It consolidates three
 * previously-duplicated inline resolvers (tenantForAgent in routes/agent.ts,
 * signalAuditTenant in routes/signal.ts, auditTenantForAgent in routes/watch.ts).
 *
 * Order: the authenticated request tenant, else the VERITY_AGENT_TENANTS binding
 * for this agent_id, else the "system" sentinel (the established fallback those
 * three resolvers already returned). NEVER returns null — every agent_profiles
 * row therefore has a non-null tenant_id, satisfying the NOT NULL constraint.
 */
export function resolveAgentTenant(c: Context, agentId?: string | null): string {
  const access = getAccessContext(c);
  if (access.tenantId) return access.tenantId;
  if (agentId) {
    const mapped = currentConfig().agentTenants.get(agentId);
    if (mapped) return mapped;
  }
  return "system";
}

type RateLimitOptions = {
  key: string;
  max: number;
  windowMs: number;
  identity?: (c: Context) => string | null | undefined;
};

interface RateBucket {
  count: number;
  resetAt: number;
  /** F9: window the most recent emitRateLimitHit was issued for. */
  emittedAtWindow?: number;
}

const rateBuckets = new Map<string, RateBucket>();
const MAX_RATE_BUCKETS = 10_000;
const RATE_BUCKET_PRUNE_INTERVAL_MS = 5_000;
let lastRateBucketPruneAt = 0;

export function __resetRateLimitBucketsForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetRateLimitBucketsForTests is test-only");
  }
  rateBuckets.clear();
  // Restore the module's initial prune-throttle state so prune behavior is
  // independent of test execution order. Without this, a prior test's
  // timestamp decides whether the throttled (non-forced) prune at the top of
  // rateLimit() pre-empts the forced-prune-at-cap branch under test.
  lastRateBucketPruneAt = 0;
}

export function __fillRateLimitBucketsForTests(
  count = MAX_RATE_BUCKETS,
  resetAtOffsetMs = 60_000,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__fillRateLimitBucketsForTests is test-only");
  }
  rateBuckets.clear();
  for (let i = 0; i < count; i++) {
    rateBuckets.set(`test-overflow:${i}`, {
      count: 1,
      resetAt: Date.now() + resetAtOffsetMs,
    });
  }
  // Mark the map as just-pruned so the throttled (non-forced) prune at the top
  // of rateLimit() is skipped on the next request. That guarantees the
  // forced-prune-at-cap branch — not the periodic prune — is what clears
  // expired buckets, so "forces expired-bucket pruning at cap" tests exercise
  // the branch they claim to regardless of order or isolated (-t) runs.
  lastRateBucketPruneAt = Date.now();
}

/**
 * F9: periodic expired-bucket prune. Hot requests lazily validate only
 * their own bucket; full-map pruning is throttled and forced only at cap.
 */
function pruneExpiredBuckets(now: number, force = false): void {
  if (!force && now - lastRateBucketPruneAt < RATE_BUCKET_PRUNE_INTERVAL_MS) return;
  lastRateBucketPruneAt = now;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const access = getAccessContext(c);
    // Never embed a raw bearer in the bucket-map key: hash the token fallback
    // (matching authHeaderRateLimitIdentity) so no rate-limit key holds plaintext.
    const tokenIdentity = access.token
      ? `auth:${createHash("sha256").update(access.token).digest("hex")}`
      : null;
    const identity = options.identity?.(c) || tokenIdentity || clientKey(c);
    const bucketKey = `${options.key}:${identity}`;
    const now = Date.now();

    pruneExpiredBuckets(now);

    let current = rateBuckets.get(bucketKey);
    if (current && current.resetAt <= now) {
      rateBuckets.delete(bucketKey);
      current = undefined;
    }

    if (!current) {
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        pruneExpiredBuckets(now, true);
      }
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        c.header("Retry-After", String(Math.max(1, Math.ceil(options.windowMs / 1000))));
        return errorJson(c, "rate_limited");
      }
      rateBuckets.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (current.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      // F9 Q7: emit federation_activity rate-limit hit ONLY for
      // tenant-agent identities (so anonymous + operator + beta-without-
      // agentId floods don't invent fake federation rows). Coalesce so
      // each (route, identity, window) emits at most once per window.
      if (
        access.tenantId &&
        access.agentId &&
        current.emittedAtWindow !== current.resetAt
      ) {
        current.emittedAtWindow = current.resetAt;
        // Lazy import to avoid module-load-order cycles. The writer is
        // best-effort and gated by VERITY_ACTIVITY_TELEMETRY_ENABLED.
        const tenantId = access.tenantId;
        const agentId = access.agentId;
        const route = options.key;
        (async () => {
          try {
            const { sql } = await import("../db");
            const { emitRateLimitHit } = await import("./federation-activity-writer");
            await emitRateLimitHit(sql as any, c, {
              tenant_id: tenantId,
              session_type: "hosted-mcp-agent",
              session_id: agentId,
              route,
            });
          } catch {
            /* best-effort telemetry */
          }
        })();
      }
      return errorJson(c, "rate_limited");
    }

    current.count += 1;
    rateBuckets.set(bucketKey, current);
    await next();
  };
}

export const betaCors: MiddlewareHandler = async (c, next) => {
  const config = currentConfig();
  const origin = c.req.header("Origin");

  if (!origin) {
    await next();
    return;
  }

  let allowedOrigins = config.allowedOrigins;
  let corsProfile: "generic" | "mcp" | "oauth-read" | "oauth-write" = "generic";
  try {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/mcp") {
      corsProfile = "mcp";
      allowedOrigins = isWebMcpConnectorEnabled() ? mcpAllowedOrigins() : new Set<string>();
    } else if (
      pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-authorization-server"
    ) {
      corsProfile = "oauth-read";
      allowedOrigins = mcpAllowedOrigins();
    } else if (
      pathname === "/oauth/register" ||
      pathname === "/oauth/token" ||
      pathname === "/oauth/revoke"
    ) {
      corsProfile = "oauth-write";
      allowedOrigins = mcpAllowedOrigins();
    }
  } catch {
    // Fall back to the global API CORS allow-list for malformed request URLs.
  }

  const webMcpCors = corsProfile !== "generic";
  const allowed = webMcpCors ? allowedOrigins.has(origin) : isAllowedOrigin(origin, c.req.url, allowedOrigins);
  c.header("Vary", "Origin");
  if (allowed) {
    let allowHeaders = "Authorization, Content-Type";
    if (corsProfile === "mcp") {
      allowHeaders = "Authorization, Content-Type, MCP-Protocol-Version";
    } else if (webMcpCors) {
      allowHeaders = "Authorization, Content-Type";
    }

    let allowMethods = "GET, POST, PATCH, DELETE, OPTIONS";
    if (corsProfile === "oauth-read") {
      allowMethods = "GET, OPTIONS";
    } else if (webMcpCors) {
      allowMethods = "POST, OPTIONS";
    }

    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Headers", allowHeaders);
    c.header("Access-Control-Allow-Methods", allowMethods);
    c.header("Access-Control-Allow-Credentials", "true");
  }

  if (c.req.method === "OPTIONS") {
    if (allowed) return c.body(null, 204);
    return errorJson(c, "forbidden", { message: "Origin not allowed" });
  }

  if (webMcpCors && !allowed) {
    return errorJson(c, "forbidden", { message: "Origin not allowed" });
  }

  await next();
};

export function authDescriptor(): string {
  return "public read routes plus bearer-token beta/operator routes";
}

export function rateLimitDescriptor(env: EnvLike = process.env): string {
  void env;
  return "basic per-route in-process rate limits";
}
