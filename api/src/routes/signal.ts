/**
 * /signal — Feedback loop endpoint
 * 
 * Agents POST here after using a node's quick_start or following an edge.
 * Success signals boost confidence; failure signals flag for review.
 * This is how the graph learns what knowledge is actually useful.
 *
 * POST /signal { addr: "OC.0.2.49", success: true, agent: "claude-code", context?: "deployed successfully" }
 * POST /signal { slug: "twilio-sms", success: false, agent: "codex", context?: "TWILIO_ACCOUNT_SID not set" }
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { assertAgentSelfOrOperator, getAccessContext, isOperator, resolveAgentTenant, visibleSpaceIds } from "../lib/access";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { AgentSignalSchema, RecallOutcomeSignalSchema, SignalRequestSchema } from "../schemas/signal.schema";
import { auditMutation } from "../lib/audit";
import { GLOBAL_SPACE_ID, tenantSpaceId } from "../lib/spaces";
import { RECALL_OUTCOME_SCORE, recordRecallOutcomeEvent, selectRecallExposurePacket, selectRecallOutcomeSummary } from "../lib/recall-outcomes";

const signal = new Hono();

const MAX_RECALL_OUTCOME_EVIDENCE_BYTES = 8192;

function recallOutcomeStatsReasonKind(error: any): "schema_missing" | "transient" | "other" {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (code === "42P01" || /recall_outcome_events.*does not exist|relation .*recall_outcome_events.* does not exist/i.test(message)) {
    return "schema_missing";
  }
  if (/timeout|connection|ECONNRESET|ECONNREFUSED|terminating connection/i.test(message)) {
    return "transient";
  }
  return "other";
}

function getCorrelationId(c: any): string | null {
  return (c.get("correlation_id") as string | undefined) || null;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? {})).length;
}

// --- Agent stimulus feedback (lightweight, goes into stimuli table) ---
const AGENT_SIGNAL_TYPES = ["success", "failure", "query"] as const;
type AgentSignalType = typeof AGENT_SIGNAL_TYPES[number];
const TYPE_MAP: Record<AgentSignalType, string> = { success: "agent_success", failure: "agent_failure", query: "agent_query" };
const URGENCY_MAP: Record<AgentSignalType, number> = { query: 0.3, success: 0.5, failure: 0.6 };
const HALFLIFE_MAP: Record<AgentSignalType, number> = { query: 4, success: 48, failure: 24 };


signal.post("/agent", async (c) => {
  // maxBytes is a defense-in-depth cap so a huge body is rejected before parse/validation;
  // the schema's nodes.max(100)/context.max(2000) bound the per-field work that follows.
  const body = await validateRequest(c, AgentSignalSchema, "json", { maxBytes: 65536 });
  const type = body.type as AgentSignalType;
  if (body.agent && !assertAgentSelfOrOperator(c, body.agent)) {
    return errorJson(c, "forbidden");
  }

  // Rate limit: max 10 agent signals per minute, PER TENANT space.
  // The counter MUST be scoped to the same space_id the INSERT below
  // writes to. An unscoped (global) COUNT lets one tenant's signal
  // volume starve every other tenant's /signal/agent endpoint
  // (cross-tenant denial), since 10 agent signals from any single
  // tenant within 60s would rate-limit every other tenant.
  const access = getAccessContext(c);
  const spaceId = access.tenantId ? tenantSpaceId(access.tenantId) : GLOBAL_SPACE_ID;
  const [recent] = await sql`
    SELECT COUNT(*)::int as n FROM stimuli
    WHERE source = 'agent' AND space_id = ${spaceId}
      AND created_at > now() - interval '60 seconds'`;
  if (recent.n >= 10) {
    return errorJson(c, "rate_limited");
  }

  let content = body.context.slice(0, 500);
  if (Array.isArray(body.nodes) && body.nodes.length > 0) {
    const nodeList = body.nodes.map((n: any) => String(n)).join(", ");
    content = `Nodes used: ${nodeList}. Context: ${content}`;
    content = content.slice(0, 500);
  }

  // F11: thread the request's correlation_id into the stimulus row so the
  // F9 audit chain reaches into the lifecycle layer.
  const correlationId = getCorrelationId(c);
  // Per-request unique source_id. The old `signal_<epoch-seconds>` key collided on the
  // stimuli UNIQUE(source, source_id) for ANY two agent signals in the same wall-clock
  // second (across tenants/callers); the loser hit ON CONFLICT DO NOTHING → 0 rows →
  // 409 "duplicate signal" and was silently lost. Namespace by tenant + a random suffix
  // so distinct concurrent signals never collide. (The ON CONFLICT below is kept as a
  // belt-and-braces guard against an astronomically-unlikely collision.)
  // `access`/`spaceId` are hoisted above (the per-tenant rate-limit COUNT).
  const sourceId = `signal_${access.tenantId ?? "global"}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const result = await sql`
    INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, decay_halflife_hours, peak_delay_hours, processed, correlation_id, space_id)
    VALUES ('agent', ${sourceId}, ${TYPE_MAP[type]}, ${URGENCY_MAP[type]}, ${content}, ${HALFLIFE_MAP[type]}, 0, false, ${correlationId}, ${spaceId})
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING id`;

  if (result.length === 0) {
    return errorJson(c, "conflict", { message: "duplicate signal" });
  }

  // Agent identity tracking — fire-and-forget
  if (body.agent) {
    const agent = body.agent;
    const agentTenant = resolveAgentTenant(c, agent);
    (async () => {
      try {
        await sql`SELECT touch_agent(${agentTenant}, ${agent})`;
        if (type === "success") {
          await sql`UPDATE agent_profiles SET success_count = success_count + 1, signal_count = signal_count + 1 WHERE tenant_id = ${agentTenant} AND agent_id = ${agent}`;
        } else if (type === "failure") {
          await sql`UPDATE agent_profiles SET failure_count = failure_count + 1, signal_count = signal_count + 1 WHERE tenant_id = ${agentTenant} AND agent_id = ${agent}`;
        } else {
          await sql`UPDATE agent_profiles SET signal_count = signal_count + 1 WHERE tenant_id = ${agentTenant} AND agent_id = ${agent}`;
        }

        // Feedback auto-close: correlate recent queries with this outcome
        if (type === "success" || type === "failure") {
          await sql`SELECT * FROM close_feedback_loop(${agent}, ${type})`;
        }
      } catch (_) { /* silent */ }
    })();
  }

  // Impact estimate: how many heated nodes + other agents will this influence?
  let impactedNodes = 0;
  let otherAgentsBenefit = 0;

  if (Array.isArray(body.nodes) && body.nodes.length > 0) {
    const requestedAddrs = body.nodes.map((n: any) => String(n));
    // Only consider nodes the caller can actually read. Otherwise a caller could
    // probe another tenant's private addrs for stimulus heat and cross-agent
    // activity. We gate on the input set AND (MT14) scope the cross-agent count to
    // the caller's tenant via agent_queries.tenant_id.
    const spaceIds = visibleSpaceIds(access);
    const readable = await sql`
      SELECT addr FROM nodes
      WHERE addr = ANY(${requestedAddrs}::text[])
        AND visibility <> 'deleted'
        ${spaceIds ? sql`AND space_id = ANY(${spaceIds}::text[])` : sql``}`;
    const nodeAddrs = readable.map((r: any) => r.addr);
    if (nodeAddrs.length > 0) {
      const [heated, others] = await Promise.all([
        sql`SELECT COUNT(*)::int AS n FROM nodes WHERE addr = ANY(${nodeAddrs}::text[]) AND stimulus_heat > 0 AND visibility <> 'deleted'`,
        sql`SELECT COUNT(DISTINCT agent_id)::int AS n FROM agent_queries
            WHERE node_addrs_returned && ${nodeAddrs}::text[]
              AND agent_id != ${body.agent || ''}
              AND tenant_id = ${resolveAgentTenant(c, body.agent)}
              AND created_at > now() - interval '7 days'`,
      ]);
      impactedNodes = heated[0].n;
      otherAgentsBenefit = others[0].n;
    }
  }

  // Build impact message
  let impact = "Signal recorded.";
  if (impactedNodes > 0) {
    impact += ` Will influence ${impactedNodes} heated node${impactedNodes > 1 ? "s" : ""} in next reactor cycle.`;
  } else {
    impact += " Will be processed in next reactor cycle.";
  }
  if (otherAgentsBenefit > 0) {
    impact += ` ${otherAgentsBenefit} other agent${otherAgentsBenefit > 1 ? "s" : ""} recently used ${impactedNodes > 1 ? "these nodes" : "this node"} — your feedback helps them too.`;
  }
  if (type === "success") {
    impact += " Success signals boost node confidence over time.";
  } else if (type === "failure") {
    impact += " Failure signals flag potential issues for review.";
  }

  // Agent stats for response
  let yourStats: any = undefined;
  if (body.agent) {
    const [profile] = await sql`SELECT signal_count, success_count, failure_count FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, body.agent)} AND agent_id = ${body.agent}`;
    if (profile) {
      const total = profile.success_count + profile.failure_count;
      yourStats = {
        total_signals: profile.signal_count,
        success_rate: total > 0 ? parseFloat((profile.success_count / total).toFixed(2)) : null,
      };
    }
  }

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveAgentTenant(c, body.agent),
    actor: body.agent || "operator",
    actorKind: isOperator(c) ? "operator_token" : "tenant_session",
    operation: "signal_emit",
    eventData: { signal_type: type, stimulus_id: result[0].id, node_count: Array.isArray(body.nodes) ? body.nodes.length : 0 },
  });

  return c.json({
    ok: true,
    stimulus_id: result[0].id,
    impact,
    ...(yourStats ? { your_stats: yourStats } : {}),
  });
});

signal.post("/recall", async (c) => {
  const body = await validateRequest(c, RecallOutcomeSignalSchema);
  if (body.agent && !assertAgentSelfOrOperator(c, body.agent)) {
    return errorJson(c, "forbidden");
  }

  const access = getAccessContext(c);
  const packet = await selectRecallExposurePacket(sql, body.recall_id);
  if (!packet && !isOperator(c)) {
    return errorJson(c, "invalid_request", {
      message: "recall_id has no recorded exposure packet; outcome feedback is unavailable for this recall",
    });
  }
  if (packet && !isOperator(c) && packet.tenant_id !== access.tenantId) {
    return errorJson(c, "forbidden", { message: "recall_id belongs to a different tenant" });
  }

  const correlationId = getCorrelationId(c);
  const evidence = body.evidence || {};
  const requestedMemoryAddrs = [...new Set((body.memories || [])
    .map((addr) => String(addr || "").trim())
    .filter(Boolean))]
    .slice(0, 50);
  if (body.outcome === "missing_memory" && requestedMemoryAddrs.length > 0) {
    return errorJson(c, "invalid_request", {
      message: "missing_memory reports must describe absent context in context or evidence, not memory addrs",
      details: { ignored_memories: requestedMemoryAddrs.slice(0, 5) },
    });
  }
  if (!packet && requestedMemoryAddrs.length > 0) {
    return errorJson(c, "invalid_request", {
      message: "orphan recall outcomes cannot attach memory addrs without an original exposure packet",
      details: { ignored_memories: requestedMemoryAddrs.slice(0, 5) },
    });
  }
  const outcomeEvidence = packet?.agent_id
    ? { ...evidence, original_recall_agent_id: packet.agent_id }
    : evidence;
  if (jsonByteLength(outcomeEvidence) > MAX_RECALL_OUTCOME_EVIDENCE_BYTES) {
    return errorJson(c, "payload_too_large", {
      message: `evidence exceeds ${MAX_RECALL_OUTCOME_EVIDENCE_BYTES} bytes`,
    });
  }

  let recoveredOrphanPacket = false;
  if (!packet) {
    const tenantId = access.tenantId || "system";
    await recordRecallOutcomeEvent(sql, {
      recallId: body.recall_id,
      tenantId,
      spaceId: access.tenantId ? tenantSpaceId(access.tenantId) : GLOBAL_SPACE_ID,
      agentId: body.agent || access.agentId || null,
      query: body.query || null,
      eventType: "recalled",
      memoryAddrs: [],
      topAddr: null,
      evidence: { orphan: true, recovered_by: "signal_recall" },
      source: "signal_recall_orphan_recovery",
      correlationId,
    });
    recoveredOrphanPacket = true;
  }

  const tenantId = packet?.tenant_id || access.tenantId || "system";
  const spaceId = packet?.space_id || (access.tenantId ? tenantSpaceId(access.tenantId) : GLOBAL_SPACE_ID);
  let memoryAddrs = body.outcome === "missing_memory"
    ? []
    : requestedMemoryAddrs.length > 0
      ? requestedMemoryAddrs
      : (packet?.memory_addrs || []);
  if (packet && body.outcome !== "missing_memory" && requestedMemoryAddrs.length > 0) {
    const known = new Set(packet.memory_addrs);
    const unknown = requestedMemoryAddrs.filter((addr) => !known.has(addr));
    if (unknown.length > 0) {
      return errorJson(c, "invalid_request", {
        message: "memories must be a subset of the original recalled packet",
        details: { unknown_memories: unknown.slice(0, 5) },
      });
    }
    memoryAddrs = requestedMemoryAddrs;
  }

  await recordRecallOutcomeEvent(sql, {
    recallId: body.recall_id,
    tenantId,
    spaceId,
    agentId: body.agent || access.agentId || null,
    query: packet?.query || body.query || null,
    eventType: body.outcome,
    memoryAddrs,
    topAddr: memoryAddrs[0] || null,
    actionContext: body.context || null,
    evidence: outcomeEvidence,
    source: "signal_recall",
    correlationId,
  });

  await auditMutation(c, sql, {
    kind: "recall_outcome_logged",
    tenantId,
    actor: body.agent || access.agentId || "operator",
    actorKind: isOperator(c) ? "operator_token" : "tenant_session",
    eventData: {
      recall_id: body.recall_id,
      outcome: body.outcome,
      memory_count: memoryAddrs.length,
      recovered_orphan_packet: recoveredOrphanPacket,
    },
  });

  return c.json({
    ok: true,
    recall_id: body.recall_id,
    outcome: body.outcome,
    memory_count: memoryAddrs.length,
    score: RECALL_OUTCOME_SCORE[body.outcome],
    recovered_orphan_packet: recoveredOrphanPacket,
  });
});

signal.post("/", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", {
      message: "Use POST /signal/agent for beta feedback. Direct confidence mutation is operator-only.",
    });
  }
  const body = await validateRequest(c, SignalRequestSchema);

  // Resolve slug to addr if needed
  let addr = body.addr;
  if (!addr && body.slug) {
    const [node] = await sql`
      SELECT addr FROM nodes 
      WHERE substance->>'slug' = ${body.slug} 
        AND visibility <> 'deleted'
      LIMIT 1`;
    if (!node) return errorJson(c, "node_not_found", { message: `No node found with slug: ${body.slug}` });
    addr = node.addr;
  }
  if (!addr) return errorJson(c, "invalid_request", { message: "addr or slug required" });

  // Verify node exists
  const [node] = await sql`SELECT addr, label, confidence, space_id FROM nodes WHERE addr = ${addr} AND visibility <> 'deleted'`;
  if (!node) return errorJson(c, "node_not_found", { message: `Node not found: ${addr}` });

  const tier = body.agent_tier || "single";

  // Record execution via existing SQL function (handles confidence propagation + tier caps)
  await sql`SELECT record_execution(${addr}, ${body.success}, ${tier})`;

  // Get updated confidence
  const [updated] = await sql`SELECT confidence FROM nodes WHERE addr = ${addr} AND visibility <> 'deleted'`;

  // Log the signal for audit trail
  await sql`
    INSERT INTO query_log (query, results_returned, top_addr, top_similarity, agent_id)
    VALUES (
      ${`[signal] ${body.success ? 'success' : 'failure'}: ${body.context || 'no context'}`},
      1, ${addr}, ${body.success ? 1.0 : 0.0}, ${body.agent || 'anonymous'}
    )`;

  const tenantId = typeof node.space_id === "string" && node.space_id.startsWith("tenant:")
    ? node.space_id.slice(7)
    : "system";
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId,
    actor: body.agent || "operator",
    actorKind: "operator_token",
    operation: "signal_emit",
    eventData: { addr, success: body.success, tier },
  });

  return c.json({
    ok: true,
    addr,
    label: node.label,
    success: body.success,
    confidence_before: parseFloat(node.confidence),
    confidence_after: parseFloat(updated.confidence),
    tier,
    message: body.success
      ? `Confidence updated. ${node.label} is working as documented.`
      : `Failure recorded. ${node.label} flagged for review.`,
  });
});

// GET /signal/stats — feedback loop health
signal.get("/stats", async (c) => {
  const access = getAccessContext(c);
  const [stats] = await sql`
    SELECT 
      (SELECT COUNT(*) FROM edges WHERE execution_count > 0) AS edges_with_executions,
      (SELECT SUM(execution_count) FROM edges) AS total_executions,
      (SELECT SUM(success_count) FROM edges) AS total_successes,
      (SELECT COUNT(*) FROM nodes WHERE query_hits > 0 AND visibility <> 'deleted') AS nodes_ever_queried,
      (SELECT SUM(query_hits) FROM nodes WHERE visibility <> 'deleted') AS total_query_hits,
      (SELECT COUNT(*) FROM query_log WHERE query LIKE '[signal]%') AS total_signals
  `;
  let recallOutcomes: any = { available: false };
  try {
    if (access.tenantId) {
      recallOutcomes = { available: true, ...(await selectRecallOutcomeSummary(sql, access.tenantId)) };
    } else if (isOperator(c)) {
      const [recallStats] = await sql`
        WITH recent AS (
          SELECT *
          FROM recall_outcome_events
          WHERE created_at > now() - interval '24 hours'
        ),
        expanded AS (
          SELECT addr, SUM(outcome_score) AS net_score
          FROM (
            SELECT outcome_score, unnest(memory_addrs) AS addr
            FROM recent
            WHERE event_type <> 'recalled'
          ) expanded_rows
          WHERE addr IS NOT NULL
          GROUP BY addr
        ),
        useful AS (
          SELECT addr, net_score
          FROM expanded
          WHERE net_score > 0
          ORDER BY net_score DESC, addr
          LIMIT 10
        ),
        problem AS (
          SELECT addr, net_score
          FROM expanded
          WHERE net_score < 0
          ORDER BY net_score ASC, addr
          LIMIT 10
        )
        SELECT
          (SELECT COUNT(*)::int FROM recent WHERE event_type = 'recalled') AS recalled_events_24h,
          (SELECT COUNT(*)::int FROM recent WHERE event_type <> 'recalled' AND COALESCE(outcome_score, 0) > 0) AS positive_outcomes_24h,
          (SELECT COUNT(*)::int FROM recent WHERE event_type <> 'recalled' AND COALESCE(outcome_score, 0) < 0) AS negative_outcomes_24h,
          (SELECT COUNT(*)::int FROM recent WHERE event_type = 'supported_action') AS supported_actions_24h,
          (SELECT COUNT(*)::int FROM recent WHERE event_type = 'user_corrected') AS corrections_24h,
          (SELECT COUNT(*)::int FROM recent WHERE event_type = 'missing_memory') AS missing_memory_reports_24h,
          COALESCE((SELECT array_agg(addr ORDER BY net_score DESC, addr) FROM useful), '{}'::text[]) AS useful_memory_addrs_24h,
          COALESCE((SELECT array_agg(addr ORDER BY net_score ASC, addr) FROM problem), '{}'::text[]) AS problem_memory_addrs_24h`;
      recallOutcomes = {
        available: true,
        recalled_events_24h: Number(recallStats?.recalled_events_24h ?? 0),
        positive_outcomes_24h: Number(recallStats?.positive_outcomes_24h ?? 0),
        negative_outcomes_24h: Number(recallStats?.negative_outcomes_24h ?? 0),
        supported_actions_24h: Number(recallStats?.supported_actions_24h ?? 0),
        corrections_24h: Number(recallStats?.corrections_24h ?? 0),
        missing_memory_reports_24h: Number(recallStats?.missing_memory_reports_24h ?? 0),
        useful_memory_addrs_24h: Array.isArray(recallStats?.useful_memory_addrs_24h) ? recallStats.useful_memory_addrs_24h : [],
        problem_memory_addrs_24h: Array.isArray(recallStats?.problem_memory_addrs_24h) ? recallStats.problem_memory_addrs_24h : [],
      };
    } else {
      recallOutcomes = {
        available: false,
        reason_kind: "scope",
        reason: "recall outcomes require a tenant-scoped or operator token",
      };
    }
  } catch (error: any) {
    recallOutcomes = {
      available: false,
      reason_kind: recallOutcomeStatsReasonKind(error),
      reason: error?.message || "recall_outcome_events unavailable",
    };
  }

  return c.json({
    feedback_loop: {
      total_signals: parseInt(stats.total_signals),
      edges_with_executions: parseInt(stats.edges_with_executions),
      total_executions: parseInt(stats.total_executions || "0"),
      total_successes: parseInt(stats.total_successes || "0"),
      success_rate: stats.total_executions > 0
        ? parseFloat((parseInt(stats.total_successes) / parseInt(stats.total_executions) * 100).toFixed(1))
        : null,
      nodes_ever_queried: parseInt(stats.nodes_ever_queried),
      total_query_hits: parseInt(stats.total_query_hits || "0"),
    },
    recall_outcomes: recallOutcomes,
    health: parseInt(stats.total_signals) > 0 ? "active" : "dormant",
    note: "POST /signal/recall { recall_id, outcome, memories, context } to teach recall usefulness; POST /signal/agent records stimulus feedback.",
  });
});

export default signal;
