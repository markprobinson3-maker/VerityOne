/**
 * /regrounding — Mid-workflow re-injection of heuristics
 *
 * When an agent explicitly re-grounds, that is a drift signal worth tracking.
 * Returns top 3 heuristics + active guard warnings + drift score.
 *
 * GET /regrounding?agent_id=X
 */

import { Hono } from "hono";
import { errorJson } from "../lib/error-envelope";
import { sql } from "../db";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, visibleSpaceIds } from "../lib/access";
import { embedQuery, toVectorStr } from "../lib/embed";
import { auditMutation } from "../lib/audit";
import { GLOBAL_SPACE_ID, tenantSpaceId } from "../lib/spaces";

const regrounding = new Hono();

function regroundingAuditTenant(c: any, agentId: string): string {
  const access = getAccessContext(c);
  if (access.tenantId) return access.tenantId;
  const mapped = (process.env.VERITY_AGENT_TENANTS || "")
    .split(",")
    .map((p) => p.trim().split(":"))
    .find(([aid]) => aid === agentId)?.[1];
  return mapped || process.env.VERITY_DEFAULT_TENANT_ID || "system";
}

regrounding.get("/", async (c) => {
  const agentId = c.req.query("agent_id") || c.req.query("agent") || "";
  const sessionId = c.req.query("session_id") || null;
  const startMs = Date.now();

  if (!agentId) {
    return errorJson(c, "invalid_request", {
      message: "agent_id parameter required",
      details: { example: "/regrounding?agent_id=my-agent" },
    });
  }
  if (!assertAgentSelfOrOperator(c, agentId)) {
    return errorJson(c, "forbidden");
  }

  // Tenant isolation: scope HEURISTIC node reads to the caller's visible spaces
  // (operator => no filter). Mirrors the canonical predicate in /context & /search.
  const access = getAccessContext(c);
  const spaces = visibleSpaceIds(access);
  const accessLevels = allowedRegistryAccessLevels(c);

  // 1. Get recent queries from this agent to find contextually relevant heuristics
  const recentQueries = await sql`
    SELECT query FROM agent_path_events
    WHERE agent_id = ${agentId}
      AND query IS NOT NULL
      AND created_at > now() - interval '30 minutes'
    ORDER BY created_at DESC
    LIMIT 5`;

  let heuristics: any[] = [];

  if (recentQueries.length > 0) {
    // Embed a combined context of recent queries for relevance
    const combinedContext = recentQueries.map((r: any) => r.query).join(". ");
    const embedding = await embedQuery(combinedContext);
    const vecStr = toVectorStr(embedding);

    const heuristicResults = await sql`
      SELECT n.addr, n.label,
        n.substance->>'heuristic_text' AS heuristic_text,
        n.substance->>'elaboration' AS elaboration,
        1 - (n.embedding_hv <=> ${vecStr}::halfvec) AS similarity
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.pyramid_id = 'HEURISTIC' AND n.embedding_hv IS NOT NULL
        AND n.visibility <> 'deleted'
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaces}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
      LIMIT 3`;

    heuristics = heuristicResults.map((h: any) => ({
      addr: h.addr,
      heuristic: h.heuristic_text,
      elaboration: h.elaboration,
      relevance: parseFloat(parseFloat(h.similarity).toFixed(3)),
    }));
  } else {
    // No recent queries — return top 3 most general heuristics
    const defaultHeuristics = await sql`
      SELECT n.addr, n.label,
        n.substance->>'heuristic_text' AS heuristic_text,
        n.substance->>'elaboration' AS elaboration
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.pyramid_id = 'HEURISTIC'
        AND n.visibility <> 'deleted'
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaces}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )`}
      ORDER BY n.position
      LIMIT 3`;

    heuristics = defaultHeuristics.map((h: any) => ({
      addr: h.addr,
      heuristic: h.heuristic_text,
      elaboration: h.elaboration,
      relevance: null,
    }));
  }

  // 2. Check for active guard warnings (session patterns)
  const warnings: any[] = [];

  // Check repetition pattern
  const [repeatCheck] = await sql`
    SELECT query, COUNT(*)::int AS n
    FROM agent_path_events
    WHERE agent_id = ${agentId}
      AND created_at > now() - interval '10 minutes'
      AND query IS NOT NULL
    GROUP BY query
    HAVING COUNT(*) >= 3
    LIMIT 1`;

  if (repeatCheck) {
    warnings.push({
      id: "G-002",
      severity: "halt",
      message: `Query "${repeatCheck.query}" repeated ${repeatCheck.n} times. Try a different approach.`,
    });
  }

  // Check for low-confidence results pattern
  const [lowConfCheck] = await sql`
    SELECT COUNT(*)::int AS low_conf_count, COUNT(*)::int AS total
    FROM agent_path_events
    WHERE agent_id = ${agentId}
      AND created_at > now() - interval '15 minutes'
      AND confidence IS NOT NULL
      AND confidence::numeric < 0.5`;

  if (lowConfCheck && lowConfCheck.low_conf_count > 3) {
    warnings.push({
      id: "G-004",
      severity: "warning",
      message: "Multiple low-confidence results in recent session. Consider re-scoping the task.",
    });
  }

  // 3. Compute drift score (0.0 = stable, 1.0 = high drift)
  // Drift signals: repeated queries, low confidence, multiple endpoints hit rapidly
  let driftScore = 0;

  const [sessionActivity] = await sql`
    SELECT
      COUNT(*)::int AS total_events,
      COUNT(DISTINCT query)::int AS unique_queries,
      COUNT(DISTINCT endpoint)::int AS endpoints_hit,
      MAX(CASE WHEN outcome = 'redirect' THEN 1 ELSE 0 END)::int AS any_redirects,
      MAX(CASE WHEN outcome = 'noise' THEN 1 ELSE 0 END)::int AS any_noise
    FROM agent_path_events
    WHERE agent_id = ${agentId}
      AND created_at > now() - interval '30 minutes'`;

  if (sessionActivity && sessionActivity.total_events > 0) {
    const total = sessionActivity.total_events;
    const unique = sessionActivity.unique_queries || 1;

    // Repetition ratio: many events / few unique queries = drift
    const repetitionRatio = total > 1 ? 1 - (unique / total) : 0;
    driftScore += repetitionRatio * 0.4;

    // Redirect/noise signals
    if (sessionActivity.any_redirects) driftScore += 0.2;
    if (sessionActivity.any_noise) driftScore += 0.15;

    // High event count in short window
    if (total > 15) driftScore += 0.15;
    if (total > 25) driftScore += 0.1;
  }

  driftScore = Math.min(1.0, Math.max(0.0, driftScore));

  // Recommendation based on drift score
  const recommendation = driftScore >= 0.7
    ? "halt"
    : driftScore >= 0.4
      ? "re-plan"
      : "continue";

  // 4. Log drift event for telemetry. F11: capture correlation_id before
  // entering the async closure so the request id makes it into the stimulus.
  const regroundingCorrelationId = ((c as any).get("correlation_id") as string | undefined) || null;
  const regroundingTenant = regroundingAuditTenant(c, agentId);
  const regroundingSpaceId = regroundingTenant && regroundingTenant !== "system"
    ? tenantSpaceId(regroundingTenant)
    : GLOBAL_SPACE_ID;
  (async () => {
    try {
      const sourceId = `reground_${agentId}_${Math.floor(Date.now() / 1000)}`;
      await sql`
        INSERT INTO stimuli (source, source_id, stimulus_type, urgency, content, decay_halflife_hours, peak_delay_hours, processed, correlation_id, space_id)
        VALUES ('agent', ${sourceId}, 'agent_query', 0.4,
          ${`Agent regrounding: drift_score=${driftScore.toFixed(2)}, recommendation=${recommendation}`},
          8, 0, false, ${regroundingCorrelationId}, ${regroundingSpaceId})
        ON CONFLICT (source, source_id) DO NOTHING`;
    } catch {
      // Non-fatal
    }
  })();

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: regroundingAuditTenant(c, agentId),
    actor: agentId,
    operation: "regrounding",
    eventData: { session_id: sessionId, drift_score: parseFloat(driftScore.toFixed(3)), recommendation },
  });

  return c.json({
    ok: true,
    agent_id: agentId,
    heuristics,
    warnings,
    session_drift_score: parseFloat(driftScore.toFixed(3)),
    recommendation,
    ms: Date.now() - startMs,
  });
});

export default regrounding;
