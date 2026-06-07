/**
 * Serverless-safe Hono app shell (rung F3).
 *
 * This module owns:
 *   - Hono app construction
 *   - All middleware (null-byte/path-traversal guard, betaCors,
 *     attachAccessContext, logger, tenant-settings gates, route-
 *     pattern rate limits, beta/operator access gates)
 *   - All serverless-safe route mounts
 *   - Static endpoints (/, /health, /start, /download,
 *     /releases/*, /toc, /.well-known/agent, /agent.json,
 *     /ai-plugin.json)
 *
 * What this module MUST NOT do:
 *   - Call `Bun.serve(...)` or hold a port.
 *   - Call `server.reload`, `server.upgrade`, `process.once`.
 *   - Start `startChangeStream`, `startWorkerHeartbeat`, or any
 *     `start*Loop` background worker.
 *   - Run pre-serve overlay normalization (long-lived launcher does
 *     that with explicit fail-fast on error).
 *   - Import `../../miners/**`, `../../../miners/**`, or route
 *     modules that own local-control/miner-backed surfaces
 *     (dashboard/machine-vault/browser-capture/providers/browser-session/
 *     federation/mining/vi/wi/trends/ops/supercron/day-journal). Those routes register through
 *     `./long-lived-routes.ts` from the long-lived launcher.
 *     `api/index.ts` (Vercel entrypoint) returns 503 for those paths
 *     instead of importing local-control or miner code.
 *
 * Why: `app.ts` is imported by both the long-lived launcher
 * (`api/src/index.ts`) and the Vercel function entrypoint
 * (`api/index.ts`). It must be safe for a Vercel cold start to
 * import — no background loops, no port allocation, no connections
 * to a local-only Postgres at module load.
 */

import crypto from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "hono/logger";
import { correlationIdMiddleware, errorHandler, translateError } from "./middleware/error-handler";
import { errorJson } from "./lib/error-envelope";
import registry from "./routes/registry";
import nodes from "./routes/nodes";
import subgraph from "./routes/subgraph";
import search from "./routes/search";
import traverse from "./routes/traverse";
import insight from "./routes/insight";
import {
  attachAccessContext,
  allowedRegistryAccessLevels,
  authDescriptor,
  betaCors,
  getAccessContext,
  rateLimit,
  rateLimitDescriptor,
  requireBetaAccess,
  requireOperatorAccess,
  sourceRateLimitIdentity,
  trustProxyConfigStatus,
  visibleSpaceIds,
} from "./lib/access";
import { sql as tocSql } from "./db";
import { GLOBAL_SPACE_ID } from "./lib/spaces";
import { selectVisibleGraphCounts, selectVisiblePyramidSummaries } from "./lib/visible-graph";
import {
  mergeVary,
  prefersHtml,
  serveLiveStableManifest,
  serveLocalSnapshotStableManifest,
} from "./routes/site";
import { registerWebsiteRoutes, renderMarketingHomepageHtml } from "./website-routes";
import { requireVoEnabled, gatePublicResonance, enforceRecallScope, enforceWritePermission } from "./lib/tenant-settings-middleware";
import { hostedRateLimit } from "./lib/hosted-rate-limit";

const app = new Hono();

// Middleware

function redactConnectAccessLog(message: string, ...rest: string[]): void {
  const redacted = message.replace(
    /(\/(?:account\/(?:connect\/(?:google\/(?:start|confirm)|redeem)|auth\/google\/(?:start|callback)|drive\/(?:start|consent|redeem|google\/callback))|dashboard\/account\/(?:connect\/(?:callback|start|status|retry)|drive\/(?:start|status|redeem)|unlink))[^\s]*)/g,
    (match) => {
      const queryIdx = match.indexOf("?");
      return queryIdx === -1 ? match : `${match.slice(0, queryIdx)}?[redacted]`;
    },
  );
  console.log(redacted, ...rest);
}

function authHeaderRateLimitIdentity(c: Context): string | null {
  const auth = c.req.header("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return null;
  return `auth:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

// F8: correlation id stamp + top-level error translator must run BEFORE
// every other middleware so any thrown ApiError / unknown error lands in
// the canonical envelope and 500s carry a traceable correlation id.
app.use("*", correlationIdMiddleware());
app.use("*", errorHandler());

// Strip null bytes from all inputs — prevents 500s from %00 in path params and query strings
// Check both the raw URL (for encoded %00) and decoded form (for literal \0)
app.use("*", async (c, next) => {
  try {
    const rawUrl = c.req.url;
    if (rawUrl.includes('%00') || rawUrl.includes('\0')) {
      return errorJson(c, "invalid_request", { message: "Invalid request: null bytes not allowed" });
    }
    // Block path traversal via .. in URL — prevents cross-route hopping via /nodes/../schema
    const url = new URL(rawUrl);
    if (url.pathname.includes('..')) {
      return errorJson(c, "invalid_request", { message: "Invalid request: path traversal not allowed" });
    }
    // Also check decoded path and query params
    const decoded = decodeURIComponent(url.pathname + url.search);
    if (decoded.includes('\0')) {
      return errorJson(c, "invalid_request", { message: "Invalid request: null bytes not allowed" });
    }
  } catch {
    return errorJson(c, "invalid_request", { message: "Invalid request URL" });
  }
  await next();
});

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});
app.use("*", betaCors);
app.use("*", attachAccessContext);
app.use("*", logger(redactConnectAccessLog));
// Tenant-settings policy gates (per TENANT-CONTROL-SURFACE-DESIGN-PR-1).
// These run AFTER access-context is attached so they can check operator scope.
// vo_enabled gate: memory, recall, bootstrap, remember are paused when false.
app.use("/memory/*", requireVoEnabled());
app.use("/remember", requireVoEnabled());
app.use("/bootstrap/*", requireVoEnabled());
// Agent write-permission gate: runs AFTER vo_enabled so machine ceiling fires first.
app.use("/memory/write", enforceWritePermission());
app.use("/memory/update", enforceWritePermission());
app.use("/remember", enforceWritePermission());
// public_resonance gate (machine ceiling): search/context return empty when off.
app.use("/search", gatePublicResonance());
app.use("/context", gatePublicResonance());
// Agent recall_scope gate: runs AFTER machine gate. Narrows public reads for
// specific agents with recall_scope=tenant_private. No effect when machine
// gate already fired, when no agentId is present, or for operators.
app.use("/search", enforceRecallScope());
app.use("/context", enforceRecallScope());

app.use("/search", rateLimit({ key: "search", max: 90, windowMs: 60_000 }));
app.use("/context", rateLimit({ key: "context", max: 60, windowMs: 60_000 }));
app.use("/ground", rateLimit({ key: "ground", max: 40, windowMs: 60_000 }));
app.use("/regrounding", rateLimit({ key: "regrounding", max: 30, windowMs: 60_000 }));
app.use("/insight", rateLimit({ key: "insight", max: 20, windowMs: 60_000 }));
app.use("/briefing", rateLimit({ key: "briefing", max: 30, windowMs: 60_000 }));
app.use("/trends/trace", rateLimit({ key: "trend-trace", max: 30, windowMs: 60_000 }));
app.use("/nodes/*", requireBetaAccess(), rateLimit({ key: "nodes", max: 120, windowMs: 60_000 }));
app.use("/subgraph", requireBetaAccess(), rateLimit({ key: "subgraph", max: 20, windowMs: 60_000 }));
app.use("/traverse", requireBetaAccess(), rateLimit({ key: "traverse", max: 20, windowMs: 60_000 }));
app.use("/insight", requireBetaAccess());
app.use("/agenda", requireBetaAccess(), rateLimit({ key: "agenda", max: 30, windowMs: 60_000 }));
app.use("/watch", requireBetaAccess(), rateLimit({ key: "watch-write", max: 120, windowMs: 60_000 }));
app.use("/watch/*", requireBetaAccess(), rateLimit({ key: "watch-read", max: 120, windowMs: 60_000 }));
app.use("/signal", requireBetaAccess(), rateLimit({ key: "signal", max: 30, windowMs: 60_000 }));
app.use("/signal/*", requireBetaAccess(), rateLimit({ key: "signal", max: 30, windowMs: 60_000 }));
app.use("/signal/agent", requireBetaAccess(), rateLimit({ key: "signal-agent", max: 20, windowMs: 60_000 }));
app.use("/agent", requireBetaAccess(), rateLimit({ key: "agent", max: 30, windowMs: 60_000 }));
app.use("/agent/*", requireBetaAccess(), rateLimit({ key: "agent", max: 30, windowMs: 60_000 }));
app.use("/run/*", requireBetaAccess(), rateLimit({ key: "run", max: 60, windowMs: 60_000 }));
app.use("/ground", requireBetaAccess());
app.use("/regrounding", requireBetaAccess());
app.use("/check/*", requireBetaAccess());
app.use("/warm", requireBetaAccess());
app.use("/remember", requireBetaAccess());
app.use("/temporal", requireBetaAccess(), rateLimit({ key: "temporal", max: 60, windowMs: 60_000 }));
app.use("/temporal/*", requireBetaAccess(), rateLimit({ key: "temporal", max: 60, windowMs: 60_000 }));
app.use("/hosted-mcp/*", rateLimit({ key: "hosted-mcp-source", max: 120, windowMs: 60_000, identity: sourceRateLimitIdentity }));
app.use("/hosted-mcp/*", rateLimit({ key: "hosted-mcp", max: 120, windowMs: 60_000, identity: authHeaderRateLimitIdentity }));
app.use("/mcp", rateLimit({ key: "mcp-source", max: 120, windowMs: 60_000, identity: sourceRateLimitIdentity }));
app.use("/mcp", rateLimit({ key: "mcp", max: 120, windowMs: 60_000, identity: authHeaderRateLimitIdentity }));
app.use("/oauth/register", rateLimit({ key: "oauth-register", max: 20, windowMs: 60_000 }));
app.use("/oauth/authorize", rateLimit({ key: "oauth-authorize", max: 60, windowMs: 60_000 }));
app.use("/oauth/authorize/consent", rateLimit({ key: "oauth-authorize-consent", max: 60, windowMs: 60_000 }));
app.use("/oauth/token", rateLimit({ key: "oauth-token", max: 60, windowMs: 60_000 }));
app.use("/oauth/revoke", rateLimit({ key: "oauth-revoke", max: 60, windowMs: 60_000 }));
app.use("/changelog", requireOperatorAccess());
app.use("/contradictions", requireOperatorAccess());
app.use("/freshness", requireOperatorAccess());
app.use("/ops", requireOperatorAccess());
app.use("/ops/*", requireOperatorAccess());
app.use("/gaps", requireOperatorAccess());
app.use("/gaps/*", requireOperatorAccess());
app.use("/publish", requireOperatorAccess());
app.use("/publish/*", requireOperatorAccess());
app.use("/trends/config", requireOperatorAccess());
app.use("/trends/config/*", requireOperatorAccess());
app.use("/trends/archive/*", requireOperatorAccess());
// R5: operator-only — agent-gaps reads raw query_log text (not yet
// space-scoped, Q-R5.9); promote/* is the early-promotion mutation.
app.use("/trends/agent-gaps", requireOperatorAccess());
app.use("/trends/promote/*", requireOperatorAccess());
app.use("/trends", requireBetaAccess());
app.use("/trends/diagnostics", requireBetaAccess());
app.use("/trends/audit", requireBetaAccess());
app.use("/trends/runtime", requireBetaAccess());
app.use("/trends/trace", requireBetaAccess());
// R5: beta-readable value surfaces — space-filtered via resolveTrendSpaceFilter.
app.use("/trends/knowledge-debt", requireBetaAccess());
app.use("/trends/promotion-candidates", requireBetaAccess());
app.use("/trends/drift-conflicts", requireBetaAccess());
app.use("/proposals", requireOperatorAccess());
app.use("/proposals/*", requireOperatorAccess());
app.use("/swarm", requireOperatorAccess());
app.use("/swarm/*", requireOperatorAccess());
app.use("/mining", requireOperatorAccess());
app.use("/mining/*", requireOperatorAccess());
app.use("/vi/schedules", requireOperatorAccess(), rateLimit({ key: "vi-schedules", max: 60, windowMs: 60_000 }));
app.use("/vi/schedules/*", requireOperatorAccess(), rateLimit({ key: "vi-schedules", max: 60, windowMs: 60_000 }));
app.use("/vi/stimuli/live", requireOperatorAccess());
app.use("/wi", requireOperatorAccess());
app.use("/wi/*", requireOperatorAccess());

const startedAt = Date.now();
const startedAtIso = new Date(startedAt).toISOString();

// Stale-runtime signal: /health recomputes mtimes for files that own route
// mounts or route-internal method registrations. A long-lived
// `bun run api/src/index.ts` process does not pick up file edits; without
// this check, operators can see a stale route surface until restart.
const ROUTE_SOURCE_FILES = [
  "app.ts",
  "long-lived-routes.ts",
  "voplus-routes.ts",
  "routes/agenda.ts",
  "routes/agent.ts",
  "routes/audit-export.ts",
  "routes/bootstrap.ts",
  "routes/briefing.ts",
  "routes/browser-capture.ts",
  "routes/capabilities.ts",
  "routes/changelog.ts",
  "routes/check.ts",
  "routes/connect.ts",
  "routes/context.ts",
  "routes/contradictions.ts",
  "routes/convene.ts",
  "routes/dashboard.ts",
  "routes/day-journal-routines.ts",
  "routes/federation.ts",
  "routes/freshness.ts",
  "routes/gaps.ts",
  "routes/ground.ts",
  "routes/insight.ts",
  "routes/machine-vault.ts",
  "routes/memory.ts",
  "routes/mining.ts",
  "routes/nodes.ts",
  "routes/oauth.ts",
  "routes/projects.ts",
  "routes/proposals.ts",
  "routes/providers.ts",
  "routes/publish.ts",
  "routes/registry.ts",
  "routes/regrounding.ts",
  "routes/remember.ts",
  "routes/run.ts",
  "routes/schema.ts",
  "routes/search.ts",
  "routes/signal.ts",
  "website-routes.ts",
  "routes/site.ts",
  "routes/subgraph.ts",
  "routes/supercron.ts",
  "routes/temporal.ts",
  "routes/tenant-pyramids.ts",
  "routes/traverse.ts",
  "routes/trends.ts",
  "routes/vi-schedules.ts",
  "routes/vi-webhook.ts",
  "routes/warm.ts",
  "routes/watch.ts",
  "routes/wi-api.ts",
  "routes/wi-monitor.ts",
] as const;

type RouteSourceMtime = { name: string; mtime_ms: number };

function readRouteSourceMtimes(): RouteSourceMtime[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const entries: RouteSourceMtime[] = [];
  for (const name of ROUTE_SOURCE_FILES) {
    try {
      const path = resolvePath(here, name);
      const stat = statSync(path);
      entries.push({ name, mtime_ms: stat.mtimeMs });
    } catch {
      // Missing source files should not break /health in packaged runtimes.
    }
  }
  return entries;
}

function maxRouteSourceMtimeMs(entries: RouteSourceMtime[]): number {
  return entries.reduce(
    (max, entry) => (entry.mtime_ms > max ? entry.mtime_ms : max),
    0,
  );
}

function routeSourceRuntimeStale(sourceMaxMtimeMs: number): boolean {
  return sourceMaxMtimeMs > startedAt + 5_000;
}

const startupRouteSourceMtimes = readRouteSourceMtimes();
const startupRoutesSourceMaxMtimeMs = maxRouteSourceMtimeMs(startupRouteSourceMtimes);
if (routeSourceRuntimeStale(startupRoutesSourceMaxMtimeMs)) {
  console.warn(
    `[startup] route source mtime (${new Date(startupRoutesSourceMaxMtimeMs).toISOString()}) is newer than process start (${startedAtIso}); routes may be stale relative to disk. Restart to pick up edits.`,
  );
}

const loggedHealthTrustProxyReasons = new Set<string>();
let loggedHealthDbProbeFailure = false;

function logHealthTrustProxyMisconfigurationOnce(reason: string): void {
  if (loggedHealthTrustProxyReasons.has(reason)) return;
  loggedHealthTrustProxyReasons.add(reason);
  console.error("[health] trust proxy configuration error:", reason);
}

function logHealthDbProbeFailureOnce(err: unknown): void {
  if (loggedHealthDbProbeFailure) return;
  loggedHealthDbProbeFailure = true;
  console.warn("[health] database count probe failed:", err);
}

// Lightweight health check for monitoring. Keep independent signals in the
// response so a config failure does not hide DB or route-runtime state.
app.get("/health", async (c) => {
  const trustProxyConfig = trustProxyConfigStatus();
  if (trustProxyConfig.reason) {
    logHealthTrustProxyMisconfigurationOnce(trustProxyConfig.reason);
  }
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  let nodes: number | null = null;
  let db: "ok" | "error" = "ok";
  try {
    const counts = await selectVisibleGraphCounts({ scope: access.scope, accessLevels, spaceIds });
    nodes = Number(counts.total_nodes);
  } catch (err) {
    db = "error";
    logHealthDbProbeFailureOnce(err);
  }
  const routeSourceMtimes = readRouteSourceMtimes();
  const routesSourceMaxMtimeMs = maxRouteSourceMtimeMs(routeSourceMtimes);
  const routesRuntimeStale = routeSourceRuntimeStale(routesSourceMaxMtimeMs);
  const nowMs = Date.now();
  const trustProxyOk = !trustProxyConfig.reason;
  const ok = trustProxyOk && db === "ok";
  return c.json({
    ok,
    code: ok
      ? "ok"
      : trustProxyConfig.reason
        ? "trust_proxy_misconfigured"
        : "health_check_failed",
    uptime_s: Math.floor((nowMs - startedAt) / 1000),
    started_at: startedAtIso,
    routes_runtime_stale: routesRuntimeStale,
    routes_source_max_mtime: routesSourceMaxMtimeMs > 0
      ? new Date(routesSourceMaxMtimeMs).toISOString()
      : null,
    checks: {
      trust_proxy: trustProxyOk ? "ok" : "misconfigured",
      db,
      routes_runtime: routesRuntimeStale ? "stale" : "ok",
    },
    trust_proxy: {
      required: trustProxyConfig.required,
      configured: trustProxyConfig.configured,
      ok: trustProxyOk,
      reason: trustProxyConfig.reason,
    },
    nodes,
  }, ok ? 200 : 503);
});

// Root — content-negotiated entry point:
//   - Browser (Accept: text/html without application/json) → public homepage HTML
//   - Everything else (default, */*, application/json, empty) → machine-facing
//     discovery JSON with live counts.
// The JSON contract is pinned by smoke.test.ts (fetch(BASE) / fetch(BASE + '/'))
// and scripts/smoke-test.sh — both send default Accept, both still receive
// JSON because prefersHtml() requires an explicit text/html caller that also
// does not mention application/json. See api/src/routes/site.ts.
app.get("/", async (c) => {
  // Tell caches/CDNs/proxies the representation varies by Accept header —
  // without this, an intermediary could reuse the HTML homepage body for a
  // later JSON discovery request (or vice versa) and break the preserved
  // machine-readable root contract. Must be set on BOTH branches; setting
  // it once before branching covers both responses.
  //
  // IMPORTANT: betaCors sets `Vary: Origin` in its before-phase for
  // cross-origin callers, so merge — do not overwrite — so Accept and
  // Origin both end up in the single Vary header.
  c.header("Vary", mergeVary(c.res.headers.get("Vary"), "Accept"));
  if (prefersHtml(c.req.header("accept"))) {
    // Marketing homepage lives behind the website seam (VO+ only). OSS core
    // returns null -> fall through to the JSON discovery surface.
    const homepage = renderMarketingHomepageHtml();
    if (homepage != null) return c.html(homepage);
  }
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const counts = await selectVisibleGraphCounts({ scope: access.scope, accessLevels, spaceIds });
  const registryRows = await selectVisiblePyramidSummaries({ scope: access.scope, accessLevels, spaceIds });
  const visiblePyramids = registryRows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.pyramid_id] = `${row.label} (${row.access_level}, ${row.node_count} nodes)`;
    return acc;
  }, {});
  const nodeCount = Number(counts.total_nodes);
  const edgeCount = Number(counts.total_edges);
  return c.json({
    name: "Verity One",
    version: "0.2.1",
    status: "ok",
    description: `Knowledge graph for AI agents. ${nodeCount} nodes, ${edgeCount} edges, 3072-dim HNSW semantic search + BM25 keyword search.`,
    start_here: "GET /context?q=<your task>&depth=deep — task-driven discovery with cited results (no auth required)",
    for_new_agents: "GET /schema — full ontology: node types, edge types, property meanings, confidence semantics, access boundaries, and example queries",
    endpoints: {
      "start_here": [
        "GET /schema — understand the graph (node types, edge types, properties, confidence, access rules, example queries)",
        "GET /context?q=<task>&depth=deep — task-driven discovery: 'for this task, what should I know?' with cited results (no auth)",
        "GET /ground?goal=<task> — agent-first grounding packet for high-confidence action (requires beta token)",
      ],
      discovery: [
        `GET /capabilities — paginated capability directory (${Number(counts.actionable_nodes)} actionable nodes)`,
        "GET /capabilities?domain=communication — filter by domain",
        "GET /search?q=<concept> — semantic + keyword hybrid search",
        "GET /nodes/:addr — authenticated node detail for beta-visible knowledge",
        "GET /check/:addr — authenticated readiness guide (live checks are operator-only)",
        "GET /traverse?from=<addr>&hops=2 — authenticated graph walk from any accessible node",
        "GET /toc — full node listing (use /capabilities at scale)",
      ],
      intelligence: [
        "GET /insight?q=<question>&depth=deep — authenticated multi-angle AI synthesis with [ADDR] citations",
        "GET /briefing — intelligence briefing: what changed, what's hot, system health (no auth)",
        "POST /swarm/convene — node-agents debate a question, extract new edges/nodes from interaction",
        "POST /publish/node — operator-only private-to-public publication bridge (supports dry_run)",
      ],
      agents: [
        "GET /connect — onboarding: everything a new agent needs to start",
        "GET /connect?agent=<id>&capabilities=coding,research — authenticated registration + onboarding",
        "GET /agenda — authenticated priority items, trends, stale areas ('what should I work on?')",
        "GET /trends — first-class trend dashboard (emerging, active, graduating, recent deaths)",
        "GET /trends/runtime — authenticated orphan pool, proto-clusters, lifecycle events, dangling-edge health",
        "GET/PATCH /trends/config — operator-only trend decay and promotion tuning levers",
        "GET /trends/trace?batch=<ingest_batch_id> — authenticated trace of orphan stimulus through automatic trend birth/archive",
        "GET /agenda?agent=<id> — personalized recommendations based on agent history",
        "GET /agent/<id> — authenticated profile (self or operator)",
        "POST /agent/<id> — authenticated profile update (self or operator)",
        "POST /watch — authenticated subscription to topics {agent, filter: 'domain:security'}",
        "GET /watch/<agent_id> — authenticated digest + subscriptions",
        "GET /run/<addr> — authenticated action-ready guide; live host checks are operator-only",
        "GET /regrounding?agent_id=<id> — mid-workflow re-injection of heuristics + drift detection",
        "POST /signal/agent — authenticated feedback signal: success/failure/query with node refs",
        "POST /signal/recall — authenticated recall outcome signal tied to recall_id",
        "POST /remember — authenticated private memory storage for decisions, preferences, and context",
      ],
      registry: [
        "GET /pyramids — list all knowledge pyramids",
      ],
    },
    auth: authDescriptor(),
    rate_limit: rateLimitDescriptor(),
    visible_pyramids: visiblePyramids,
    quick_start: {
      "1_understand": "curl /schema",
      "2_discover": "curl '/context?q=send+sms+notification&depth=deep&pyramids=FUNCTION'",
      "3_trends": "curl /trends",
      "4_connect": "curl /connect",
      "5_ground_beta": "curl -H 'Authorization: Bearer <beta-token>' '/ground?goal=send+sms+notification'",
      "6_detail_beta": "curl -H 'Authorization: Bearer <beta-token>' /nodes/OC.0.2.49",
      "7_synthesize_beta": "curl -H 'Authorization: Bearer <beta-token>' '/insight?q=how+do+I+deploy+safely&depth=deep'",
    },
  });
});

// /start — Public human onboarding page (VO-WEB-MCP-HOMEPAGE-ONBOARDING-PR-1).
// Unconditionally HTML. This is the canonical human onboarding surface;
// /connect and /schema remain strict JSON endpoints and are not proxied
// through here. See api/src/routes/site-start.ts.
// Marketing site routes (/start, /download, ...) are mounted by the website
// seam — a no-op in the OSS build (the marketing site is not part of core VO).
registerWebsiteRoutes(app);

// ─── Public release channel (VO-VERCEL-RELEASE-CHANNEL-BOOTSTRAP-PR-1) ──
//
// Two public, no-auth routes that BOTH read the single
// checked-in source of truth under deploy/public/. On verityone.app
// Vercel serves these same files statically; mounting them on the
// local Hono app keeps the contract dogfooded (local dev / integration
// tests exercise the same bytes Vercel will ship).
// `/releases/stable.json` must mean the SAME thing on local as it
// does on hosted — the live authoritative manifest. Local proxies
// the Vercel-hosted copy; no silent fallback to the embedded
// on-disk snapshot if the fetch fails. Offline / debug inspection
// of the embedded snapshot lives under a separately named route
// (`/releases/local-snapshot/stable.json`), so there is no path
// ambiguity.
app.get("/releases/stable.json", (c) => serveLiveStableManifest(c));
app.get("/releases/local-snapshot/stable.json", (c) =>
  serveLocalSnapshotStableManifest(c),
);

// Routes
app.route("/pyramids", registry);
app.route("/nodes", nodes);
app.route("/subgraph", subgraph);
app.route("/search", search);
app.route("/traverse", traverse);
app.route("/insight", insight);

import { context } from "./routes/context";
app.route("/context", context);

import briefing from "./routes/briefing";
app.route("/briefing", briefing);

import { check } from "./routes/check";
app.route("/check", check);

import { capabilities } from "./routes/capabilities";
import schema from "./routes/schema";
import signal from "./routes/signal";
import contradictions from "./routes/contradictions";
import freshness from "./routes/freshness";
import proposals from "./routes/proposals";
import swarm from "./routes/convene";
import agenda from "./routes/agenda";
import agentRoute from "./routes/agent";
app.route("/capabilities", capabilities);
app.route("/schema", schema);
app.route("/signal", signal);
app.route("/contradictions", contradictions);
app.route("/freshness", freshness);
app.route("/proposals", proposals);
app.route("/swarm", swarm);
app.route("/agenda", agenda);
app.route("/agent", agentRoute);

import connect from "./routes/connect";
import watch from "./routes/watch";
import ground from "./routes/ground";
import regrounding from "./routes/regrounding";
import gaps from "./routes/gaps";
import run from "./routes/run";
import warm from "./routes/warm";
import changelog from "./routes/changelog";
import publish from "./routes/publish";
app.route("/connect", connect);
import projectsRoute from "./routes/projects";
app.route("/projects", projectsRoute);
// Tenant pyramid management — distinct from graph ontology /pyramids.
import tenantPyramidsRoute from "./routes/tenant-pyramids";
app.route("/tenant-pyramids", tenantPyramidsRoute);
// ── Hosted VO+ rate limits ────────────────────────────────────────────
// Broad pre-auth hosted rate limiting is still deferred: preserving
// auth-boundary behavior (401/403 vs 429) requires lightweight auth
// preambles that resolve verified identity before route logic. This
// window-based helper is active only for /admin/login. Federation write
// and control paths use route-local limiters, mostly the token-bucket
// layer in api/src/lib/federation-rate-limit.ts instead.
const adminLoginRateLimit = hostedRateLimit({ bucket: "admin-login", max: 10, windowMs: 60_000 });
// Mount on the "/admin/login/*" prefix, not the bare path: in Hono a bare
// app.use("/admin/login") matches ONLY the exact path, which would leave the
// pathname guard below as dead code. The "/*" form also runs this middleware
// for /admin/login/<subpath> requests, and the guard then skips counting them
// so a flood of non-login subpaths cannot exhaust the login brute-force bucket
// and lock out real operator logins. Only the exact /admin/login path is
// counted against the limiter.
app.use("/admin/login/*", async (c, next) => {
  if (new URL(c.req.url).pathname !== "/admin/login") return next();
  return adminLoginRateLimit(c, next);
});

// Hosted VO+ HTTP routes (/account, /sync, /portal, /remote, /my, /hosted-mcp,
// /admin, and the root-mounted /mcp) are registered by registerVoPlusRoutes,
// imported from the open-core seam ./voplus-routes.ts and called once below
// (right after the oauth root mount) — so app.ts names the SEAM, never a hosted
// route module. The OSS build ships a no-op voplus-routes.ts (coupling #2;
// mirrors the sync-journal-port.ts seam). The guard middlewares for those routes
// (the /hosted-mcp/* + /mcp rate-limits and the /admin/login/* brute-force guard,
// above) stay here and keep their earlier registration, so they still compose
// before the registered handlers.
// Local-control routes mount from long-lived-routes.ts only. They read or
// write local machine state (dashboard action runner, machine vault,
// provider secrets, browser decrypt material), so the Vercel function
// entrypoint returns 503 for those prefixes instead of importing them
// into the serverless app shell.
app.route("/watch", watch);
app.route("/ground", ground);
app.route("/regrounding", regrounding);
app.route("/gaps", gaps);
app.route("/run", run);
app.route("/warm", warm);

import remember from "./routes/remember";
import memoryRoutes from "./routes/memory";
import bootstrapRoutes from "./routes/bootstrap";
import temporal from "./routes/temporal";
import auditExportRoute from "./routes/audit-export";
import oauthRoute from "./routes/oauth";
import { registerVoPlusRoutes } from "./voplus-routes";
app.route("/remember", remember);
app.route("/memory", memoryRoutes);
app.route("/bootstrap", bootstrapRoutes);
app.route("/temporal", temporal);
app.route("/audit", auditExportRoute);
// Rung 11a: OAuth router mounts at root so /.well-known/* +
// /oauth/* land at the RFC-required paths. Drift guard #14
// pins this mount shape.
app.route("/", oauthRoute);
// Hosted VO+ routes (open-core seam, coupling #2). Registered HERE — after the
// core oauth root mount so oauth keeps precedence on any shared /.well-known
// path, and synchronously at module load so the routes exist before the app
// serves any request (no post-build router mutation; the CJS serverless bundle
// also forbids the top-level await an async seam would require). No-op in OSS.
registerVoPlusRoutes(app);
app.route("/changelog", changelog);
app.route("/publish", publish);

// /toc — Full registry + Table of Contents served from the live graph
app.get("/toc", async (c) => {
  const sql = tocSql;
  const format = c.req.query("format") || "json";
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];

  // Registry: all pyramids with counts
  const pyramids = await selectVisiblePyramidSummaries({
    scope: access.scope,
    accessLevels,
    spaceIds,
  });

  // Full node index grouped by pyramid, ordered by hierarchy
  const nodes_list = access.scope === "operator"
    ? await sql`
        SELECT n.addr, n.pyramid_id, n.label, n.parent_addr, n.depth, n.layer, n.confidence,
          n.node_type, ROUND(n.resonance::numeric, 3) AS resonance,
          n.substance->>'slug' AS slug,
          n.substance->'provides' AS provides,
          n.substance->>'description' AS description
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        ORDER BY n.pyramid_id, n.depth, n.position`
    : await sql`
        SELECT n.addr, n.pyramid_id, n.label, n.parent_addr, n.depth, n.layer, n.confidence,
          n.node_type, ROUND(n.resonance::numeric, 3) AS resonance,
          n.substance->>'slug' AS slug,
          n.substance->'provides' AS provides,
          n.substance->>'description' AS description
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
        ORDER BY n.pyramid_id, n.depth, n.position`;

  // Stats
  const stats = await selectVisibleGraphCounts({
    scope: access.scope,
    accessLevels,
    spaceIds,
  });

  if (format === "text") {
    // Plain text TOC for agents that prefer minimal parsing
    let text = "# Verity One — Table of Contents\n\n";
    text += `${stats.total_nodes} nodes | ${stats.total_edges} edges | ${stats.actionable_nodes} actionable tools/skills\n\n`;
    text += "Search: GET /context?q=<task>&depth=deep\n";
    text += "Check:  GET /check/<addr> (auth required)\n";
    text += "Detail: GET /nodes/<addr> (auth required)\n\n";

    let currentPyramid = "";
    for (const n of nodes_list) {
      if (n.pyramid_id !== currentPyramid) {
        currentPyramid = n.pyramid_id;
        const p = pyramids.find((p: any) => p.pyramid_id === currentPyramid);
        text += `\n## ${currentPyramid} — ${p?.label || ""} (${p?.node_count || "?"} nodes)\n`;
      }
      const indent = "  ".repeat(Math.max(0, n.depth - 1));
      const type = n.node_type ? ` [${n.node_type}]` : "";
      text += `${indent}${n.addr} | ${n.label}${type} (conf=${n.confidence})\n`;
    }
    return c.text(text);
  }

  return c.json({
    name: "Verity One — Table of Contents",
    stats,
    pyramids,
    nodes: nodes_list,
    search: "GET /context?q=<your task>&depth=deep",
    check: "GET /check/<addr>",
    detail: "GET /nodes/<addr>",
  });
});

// Agent bootstrap — standard discovery endpoint
// An agent hitting ANY URL on this server gets guided to /context
app.get("/.well-known/agent", async (c) => {
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const counts = await selectVisibleGraphCounts({ scope: access.scope, accessLevels, spaceIds });
  const registryRows = await selectVisiblePyramidSummaries({ scope: access.scope, accessLevels, spaceIds });
  const nodeCount = Number(counts.total_nodes);
  const edgeCount = Number(counts.total_edges);
  const visiblePyramids = registryRows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.pyramid_id] = `${row.label} (${row.access_level}, ${row.node_count} nodes)`;
    return acc;
  }, {});
  return c.json({
    protocol: "verity-one",
    version: "0.2.1",
    name: "Verity One Knowledge Graph",
    description: `Self-organizing knowledge pyramid. ${nodeCount} nodes, ${edgeCount} edges, 3072-dim HNSW vector search + BM25 keyword search. Typed nodes (tool/skill/workflow/concept), typed edges (20 types), confidence with time-based decay.`,
    bootstrap: {
      "1_schema": "/schema — understand the graph before querying it",
      "2_search": "/context?q=<your task>&depth=deep — task-driven discovery with ranked, cited results",
      "3_detail": "/nodes/<addr> — authenticated node detail for beta-visible knowledge",
    },
    capabilities: [
      "hybrid-search (3072-dim HNSW vectors + BM25 keyword, sub-5ms)",
      "graph-traversal (20 typed edge types, N-hop walks)",
      "ai-synthesis (multi-angle Gemini insight with [ADDR] citations)",
      "execution-tracking (usage feeds back into confidence via record_skill_use)",
      "readiness-guides (beta-safe static checks, operator live verification)",
      "capability-directory (527 capabilities across 21 domains, paginated)",
    ],
    pyramids: visiblePyramids,
    auth: authDescriptor(),
    rate_limit: rateLimitDescriptor(),
  });
});

// OpenAI-style model card / agent card
app.get("/agent.json", (c) => c.redirect("/.well-known/agent"));
app.get("/ai-plugin.json", (c) => c.redirect("/.well-known/agent"));

// F8: unknown route + final error translator. The error handler middleware
// catches async throws; `app.onError` catches sync throws routed by Hono.
app.notFound((c) => errorJson(c, "not_found"));
app.onError((err, c) => translateError(c, err));

export default app;
export { app };
