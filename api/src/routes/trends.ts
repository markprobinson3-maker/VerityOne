import { Hono, type Context } from "hono";
import { sql } from "../db";
import { getTrendConfigState, getTrendDashboard, getTrendRuntimeState, traceTrendActivity, updateTrendConfigState, archiveTrendNow, promoteProtoClusterEarly } from "../../../miners/src/trends/service";
import { isSyntheticBatchId, isSyntheticText, isSyntheticTrendEvent } from "../lib/public-graph";
import { errorJson } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
// R1: read-only diagnostic surfaces over the existing reactor +
// trend tables. No behavior change; surfaces only.
import {
  getTrendDiagnostics,
  getTrendHealth,
  getHeldReasonsBreakdown,
  getProtoClusterAudit,
  getTrendAddrAudit,
  DEFAULT_HEALTH_THRESHOLD_SECONDS,
  type TrendSpaceFilter,
} from "../lib/trend-diagnostics";
// R5: value-add diagnostic surfaces.
import {
  getKnowledgeDebt,
  getPromotionCandidates,
  getDriftConflicts,
  getAgentGaps,
} from "../lib/trend-diagnostics";
// R2: machine-level kill switch + in-route operator gate.
import { resolveTenantSettings } from "../lib/runtime-profile";
import { getAccessContext, isOperator, resolveAgentTenant } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const trends = new Hono();
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const TREND_ADDR_RE = /^TN\.\d+(?:\.\d+)*$/;

function resolveTrendSpaceFilter(c: Context): { filter: TrendSpaceFilter; error?: Response } {
  const access = getAccessContext(c);
  const explicitSpaceId = (c.req.query("space_id") || "").trim() || null;
  if (explicitSpaceId && access.scope !== "operator") {
    return {
      filter: [],
      error: errorJson(c, "forbidden", { message: "Only operator scope can override space_id" }),
    };
  }
  if (access.scope === "operator") {
    return { filter: explicitSpaceId ? [explicitSpaceId] : null };
  }
  return { filter: access.spaceIds || [GLOBAL_SPACE_ID] };
}

trends.get("/", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const agent = c.req.query("agent") || null;
  const result = await getTrendDashboard(agent, scope.filter, resolveAgentTenant(c, agent));
  result.active_trends = (result.active_trends || []).filter((row: any) => !isSyntheticText(row.label) && !isSyntheticText(row.description));
  result.emerging = (result.emerging || []).filter((row: any) => !isSyntheticText(row.label) && !isSyntheticText(row.description));
  result.graduating = (result.graduating || []).filter((row: any) => !isSyntheticText(row.label) && !isSyntheticText(row.description));
  result.recently_died = (result.recently_died || []).filter((row: any) => !isSyntheticText(row.label));
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
  });
});

trends.get("/runtime", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const limit = parseInt(c.req.query("limit") || "25", 10);
  const result = await getTrendRuntimeState(Number.isFinite(limit) ? limit : 25, scope.filter);
  result.orphan_pool = (result.orphan_pool || []).filter((row: any) => !isSyntheticBatchId(row.ingest_batch_id) && !isSyntheticText(row.content_preview));
  result.live_trends = (result.live_trends || []).filter((row: any) => !isSyntheticText(row.label));
  result.recent_events = (result.recent_events || []).filter((row: any) => !isSyntheticTrendEvent(row));
  // R1: held_reasons over the last 24h so operators see the gate
  // distribution alongside the live runtime view. Cheap join against
  // `trend_events` filtered by event_type='proto_cluster_held'.
  const held_reasons = scope.filter === null
    ? await getHeldReasonsBreakdown(24)
    : await getHeldReasonsBreakdown(24, scope.filter);
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
    held_reasons,
  });
});

// R1: full diagnostic payload — stimulus health, orphan pool histogram,
// proto-cluster gate analysis (logged + silent), trend lifecycle stats,
// 24h held-reason breakdown, health indicator. Read-only.
trends.get("/diagnostics", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const result = await getTrendDiagnostics(scope.filter);
  return c.json({ ok: true, ...result });
});

// R1: 200/503 health indicator suitable for an external pinger.
// `ok` flips when the oldest unprocessed stimulus exceeds the configured
// threshold (default 6 hours). Returns 200 on healthy, 503 on stale so
// monitoring tools can alert without parsing JSON.
//
// R2: when the machine-level `trends_enabled` flag is off, return
// 200 {status:"disabled"} BEFORE any DB query so a deliberately-paused
// reactor doesn't alert and doesn't require a working DB to prove it
// is intentionally paused.
trends.get("/health", async (c) => {
  const settings = resolveTenantSettings();
  if (!settings.trends_enabled) {
    return c.json({
      ok: true,
      status: "disabled",
      oldest_unprocessed_age_seconds: null,
      threshold_seconds: DEFAULT_HEALTH_THRESHOLD_SECONDS,
    }, 200);
  }
  const result = await getTrendHealth();
  return c.json({ status: result.ok ? "ok" : "stale", ...result }, result.ok ? 200 : 503);
});

// R1: per-entity audit trail — events + decision audits joined into one
// chronological feed. Caller passes proto_cluster_id (uuid) OR trend_addr.
trends.get("/audit", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const protoClusterId = c.req.query("proto_cluster_id");
  const trendAddr = c.req.query("trend_addr");
  if (protoClusterId) {
    if (!UUID_RE.test(protoClusterId)) {
      return errorJson(c, "invalid_request", { message: "proto_cluster_id must be a uuid" });
    }
    const entries = await getProtoClusterAudit(protoClusterId, scope.filter);
    return c.json({
      ok: true,
      proto_cluster_id: protoClusterId,
      generated_at: new Date().toISOString(),
      entries,
    });
  }
  if (trendAddr) {
    if (!TREND_ADDR_RE.test(trendAddr)) {
      return errorJson(c, "invalid_request", { message: "trend_addr must look like TN.x.y.z" });
    }
    const entries = await getTrendAddrAudit(trendAddr, scope.filter);
    return c.json({
      ok: true,
      trend_addr: trendAddr,
      generated_at: new Date().toISOString(),
      entries,
    });
  }
  return errorJson(c, "invalid_request", { message: "Provide either proto_cluster_id or trend_addr" });
});

trends.get("/config", async (c) => {
  const result = await getTrendConfigState();
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    ...result,
  });
});

trends.patch("/config", async (c) => {
  // R2: defense in depth. app.ts mounts /trends/config behind operator
  // middleware, but the route should not trust mount alone for a config
  // write. A future remount mistake mustn't expose this to non-operators.
  if (!isOperator(c)) {
    return errorJson(c, "forbidden", { message: "Operator scope required to mutate trend config" });
  }
  try {
    const body = await c.req.json();
    const result = await updateTrendConfigState(body || {});
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: process.env.VERITY_DEFAULT_TENANT_ID || "system",
      actor: "operator",
      actorKind: "operator_token",
      operation: "trend_config_update",
      eventData: { keys: Object.keys(body || {}) },
    });
    return c.json({
      ok: true,
      updated_at: new Date().toISOString(),
      ...result,
    });
  } catch (error: any) {
    console.error("[trends/config] update failed:", error);
    return errorJson(c, "invalid_request", { message: "Invalid trend config update" });
  }
});

trends.get("/trace", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const batchId = c.req.query("batch") || null;
  const stimulusIdRaw = c.req.query("stimulus_id");
  const contentLike = c.req.query("content") || null;
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const stimulusId = stimulusIdRaw ? parseInt(stimulusIdRaw, 10) : null;

  if (!batchId && !stimulusId && !contentLike) {
    return errorJson(c, "invalid_request", { message: "Provide at least one of: batch, stimulus_id, content" });
  }

  const trace = await traceTrendActivity({
    batchId,
    stimulusId: Number.isFinite(stimulusId as number) ? stimulusId : null,
    contentLike,
    limit: Number.isFinite(limit) ? limit : 50,
  }, scope.filter);
  trace.stimuli = (trace.stimuli || []).filter((row: any) => !isSyntheticBatchId(row.ingest_batch_id) && !isSyntheticText(row.content));
  trace.event_timeline = (trace.event_timeline || []).filter((row: any) => !isSyntheticTrendEvent(row));
  trace.live_trends = (trace.live_trends || []).filter((row: any) => !isSyntheticText(row.label));
  trace.archived_trends = (trace.archived_trends || []).filter((row: any) => !isSyntheticText(row.label));

  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    ...trace,
  });
});

// R5: knowledge-debt — orphan stimuli grouped by (space_id, origin_kind, age_bucket)
// for unprocessed rows older than 14 days. Beta-readable per R5 plan; uses the same
// space-filter helper as /trends/diagnostics so a beta caller sees only their tenant
// + global, never another tenant.
trends.get("/knowledge-debt", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const buckets = await getKnowledgeDebt(scope.filter);
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    buckets,
  });
});

// R5: promotion-candidates — proto-clusters meeting non-age gates but failing the
// graduationMinAgeDays gate. Read-only. Operators see all spaces; tenant beta sees
// their own + global. The actual promote is a separate operator-only POST.
trends.get("/promotion-candidates", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const candidates = await getPromotionCandidates(scope.filter);
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    candidates,
  });
});

// R5: drift-conflicts — review-priority heuristic (NOT entailment). Surfaces
// proto-clusters whose external-source-heavy centroid sits near a durable node
// but lexically diverges from it. drift_score = proximity * lexical_divergence
// * external_source_ratio (Q-R5.10).
trends.get("/drift-conflicts", async (c) => {
  const scope = resolveTrendSpaceFilter(c);
  if (scope.error) return scope.error;
  const conflicts = await getDriftConflicts(scope.filter);
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    conflicts,
  });
});

// R5: agent-gaps — operator-only because query_log has no space_id today
// (Q-R5.9). Tenant-scoped agent gaps require a future query_log.space_id
// migration; until then, tenant beta callers must not see another tenant's
// query strings.
trends.get("/agent-gaps", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "forbidden", {
      message: "Operator scope required for /trends/agent-gaps; query_log is not yet tenant-scoped",
    });
  }
  const gaps = await getAgentGaps();
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    gaps,
  });
});

// R5: operator-only early promotion. Bypasses the age gate ONLY; orphan/source/
// origin/energy gates still apply. Optional space_id body/query field is an
// intent assertion — service rejects with `space_mismatch` if it doesn't match
// the loaded cluster (Q-R5.8). Audited as `trend_proto_cluster_promote`.
trends.post("/promote/:proto_id", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "forbidden", {
      message: "Operator scope required to force-promote proto-clusters",
    });
  }
  const protoId = c.req.param("proto_id");
  if (!protoId || !UUID_RE.test(protoId)) {
    return errorJson(c, "invalid_request", { message: "proto_id must be a uuid" });
  }
  let expectedSpaceId: string | null = null;
  const queryParam = (c.req.query("space_id") || "").trim();
  if (queryParam) {
    expectedSpaceId = queryParam;
  } else {
    let body: { space_id?: string } | null = null;
    const rawBody = await c.req.text();
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody) as { space_id?: string };
      } catch {
        return errorJson(c, "invalid_request", { message: "Request body must be valid JSON" });
      }
    }
    const bodyParam = (body && typeof body.space_id === "string" ? body.space_id.trim() : "");
    if (bodyParam) expectedSpaceId = bodyParam;
  }

  const result = await promoteProtoClusterEarly(protoId, expectedSpaceId);

  if (result.reason === "not_found") {
    return errorJson(c, "not_found", {
      message: "Proto-cluster not found",
      details: { proto_cluster_id: protoId },
    });
  }
  if (result.reason === "space_mismatch") {
    return errorJson(c, "state_mismatch", {
      message: "Proto-cluster space_id does not match expected",
      details: {
        reason: "space_mismatch",
        proto_cluster_id: protoId,
        expected_space_id: expectedSpaceId,
        actual_space_id: result.space_id,
      },
    });
  }
  if (result.reason && result.trend_addr === null) {
    return errorJson(c, "conflict", {
      message: `Proto-cluster does not meet promotion gates: ${result.reason}`,
      details: {
        reason: result.reason,
        proto_cluster_id: protoId,
        space_id: result.space_id,
      },
    });
  }

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: process.env.VERITY_DEFAULT_TENANT_ID || "system",
    actor: "operator",
    actorKind: "operator_token",
    operation: "trend_proto_cluster_promote",
    eventData: {
      proto_cluster_id: protoId,
      trend_addr: result.trend_addr,
      space_id: result.space_id,
    },
  });

  return c.json({
    ok: true,
    proto_cluster_id: protoId,
    trend_addr: result.trend_addr,
    space_id: result.space_id,
  });
});

// Archive (terminate) a trend node
trends.post("/archive/:addr{.+}", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "forbidden", { message: "Operator scope required to archive trends" });
  }
  const addr = c.req.param("addr");
  if (!addr || !addr.startsWith("TN.") || addr === "TN.0.0.0") {
    return errorJson(c, "invalid_request", { message: "Invalid trend address" });
  }
  try {
    await archiveTrendNow(addr);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: process.env.VERITY_DEFAULT_TENANT_ID || "system",
      actor: "operator",
      actorKind: "operator_token",
      operation: "trend_archive",
      eventData: { addr },
    });
    return c.json({ ok: true, archived: addr });
  } catch (e: any) {
    console.error("[trends/archive] archive failed:", e);
    return errorJson(c, "internal_error", { message: "Trend archive failed" });
  }
});

export default trends;
