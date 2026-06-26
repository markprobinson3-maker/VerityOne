/**
 * /watch — Topic subscription system
 * 
 * Agents subscribe to topics and get digests of what changed.
 * The passive dependency engine — subscribe once, check whenever.
 *
 * POST /watch { agent: "art-1", filter: "domain:security" }
 * GET /watch/art-1  → events since last check
 * DELETE /watch/3   → unsubscribe
 */

import { Hono } from "hono";
import { sql } from "../db";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, isOperator, resolveAgentTenant, visibleSpaceIds } from "../lib/access";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { WatchCreateSchema, WatchDeleteSchema } from "../schemas/watch.schema";
import { auditMutation } from "../lib/audit";

const watch = new Hono();

// Valid filter prefixes
const VALID_FILTERS = ["domain:", "node:", "heat:", "source:"];

// Reject SQL operators, semicolons, comment markers in filter value
const FILTER_POISON = /[;'"\\]|--|\bOR\b|\bAND\b|\bDROP\b|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bUNION\b/i;


function validateFilter(filter: string): boolean {
  if (!VALID_FILTERS.some(prefix => filter.startsWith(prefix))) return false;
  const value = filter.slice(filter.indexOf(":") + 1);
  if (FILTER_POISON.test(value)) return false;
  return true;
}

// POST /watch — subscribe
watch.post("/", async (c) => {
  const body = await validateRequest(c, WatchCreateSchema);

  if (!assertAgentSelfOrOperator(c, body.agent)) {
    return errorJson(c, "forbidden");
  }
  if (!validateFilter(body.filter)) {
    return errorJson(c, "validation_failed", {
      message: `filter must start with one of: ${VALID_FILTERS.join(", ")}`,
      details: { examples: ["domain:security", "node:OC.0.2.27", "heat:>0.05", "source:hackernews"] },
    });
  }
  const watchPriority = body.watch_priority || "standard";
  const agentTenant = resolveAgentTenant(c, body.agent);

  // Ensure agent exists
  await sql`SELECT touch_agent(${agentTenant}, ${body.agent})`;

  // Max 20 watches per agent
  const [count] = await sql`SELECT COUNT(*)::int as n FROM agent_watches WHERE tenant_id = ${agentTenant} AND agent_id = ${body.agent}`;
  if (count.n >= 20) {
    return errorJson(c, "invalid_request", { message: "Maximum 20 watches per agent. Remove some first." });
  }

  const result = await sql`
    INSERT INTO agent_watches (tenant_id, agent_id, filter, watch_priority)
    VALUES (${agentTenant}, ${body.agent}, ${body.filter}, ${watchPriority})
    ON CONFLICT (tenant_id, agent_id, filter) DO UPDATE SET last_checked = now(), watch_priority = ${watchPriority}
    RETURNING id`;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: agentTenant,
    actor: body.agent,
    actorKind: isOperator(c) ? "operator_token" : "tenant_session",
    operation: "watch_create",
    eventData: { agent_id: body.agent, filter: body.filter, watch_priority: watchPriority },
  });

  return c.json({ ok: true, watch_id: result[0].id, filter: body.filter, watch_priority: watchPriority });
});

// GET /watch/:agent_id — check for updates
watch.get("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  if (!assertAgentSelfOrOperator(c, agentId)) {
    return errorJson(c, "forbidden");
  }
  // Scope digest counts/samples to the caller's visible spaces so a watch
  // never surfaces another tenant's stimuli/nodes. Operator → null → all spaces.
  const watchSpaceIds = visibleSpaceIds(getAccessContext(c));
  const watchAccessLevels = allowedRegistryAccessLevels(c);
  const watchTenant = resolveAgentTenant(c, agentId);

  const watches = await sql`
    SELECT id, filter, watch_priority, last_checked, created_at
    FROM agent_watches WHERE tenant_id = ${watchTenant} AND agent_id = ${agentId}
    ORDER BY created_at ASC`;

  if (watches.length === 0) {
    return c.json({
      ok: true,
      agent_id: agentId,
      subscriptions: [],
      digest: [],
      tip: 'POST /watch {"agent":"' + agentId + '","filter":"domain:security"} to subscribe to topics',
    });
  }

  const digest = [];
  for (const w of watches) {
    const events = await resolveFilter(w.filter, w.last_checked, w.watch_priority, watchSpaceIds, watchAccessLevels);
    digest.push({
      id: w.id,
      filter: w.filter,
      watch_priority: w.watch_priority,
      events_since_last_check: events.count,
      sample: events.sample,
      last_checked: w.last_checked,
    });
  }

  // Update all last_checked
  const ids = watches.map((w: any) => w.id);
  await sql`UPDATE agent_watches SET last_checked = now() WHERE tenant_id = ${watchTenant} AND id = ANY(${ids}::int[])`;

  return c.json({
    ok: true,
    agent_id: agentId,
    subscriptions: watches.map((w: any) => ({
      id: w.id,
      filter: w.filter,
      watch_priority: w.watch_priority,
      created_at: w.created_at,
      last_checked: w.last_checked,
    })),
    digest: digest.filter((entry: any) => entry.events_since_last_check > 0),
    checks: digest,
    checked_at: new Date().toISOString(),
  });
});

// DELETE /watch/:id — unsubscribe
watch.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  let body: { agent?: string } = {};
  try { body = await validateRequest(c, WatchDeleteSchema); } catch {}
  // A non-operator may delete only their OWN agent's watch, and the delete MUST
  // be scoped to that agent — otherwise any caller could delete an arbitrary
  // watch by guessing its integer id (IDOR). Operators may delete any watch.
  const operator = isOperator(c);
  if (!operator && (!body.agent || !assertAgentSelfOrOperator(c, body.agent))) {
    return errorJson(c, "forbidden");
  }

  const result = await sql`
    DELETE FROM agent_watches WHERE id = ${id}
    ${body.agent ? sql`AND tenant_id = ${resolveAgentTenant(c, body.agent)} AND agent_id = ${body.agent}` : sql``}
    RETURNING filter`;

  if (result.length === 0) {
    return errorJson(c, "not_found", { message: "Watch not found" });
  }

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveAgentTenant(c, body.agent),
    actor: body.agent || "operator",
    actorKind: isOperator(c) ? "operator_token" : "tenant_session",
    operation: "watch_delete",
    eventData: { watch_id: id, filter: result[0].filter, ...(body.agent ? { agent_id: body.agent } : {}) },
  });

  return c.json({ ok: true, removed: result[0].filter });
});

// Resolve a filter to events since last_checked
async function resolveFilter(filter: string, since: Date, priority: string = "standard", spaceIds: string[] | null = null, accessLevels: string[] = []): Promise<{ count: number; sample: string | null }> {
  const [prefix, value] = [filter.split(":")[0], filter.slice(filter.indexOf(":") + 1)];
  // Global-public refinement (batch-31): for non-operators (spaceIds non-null,
  // = ['global', 'tenant:<id>']) a bare `space_id = ANY(spaceIds)` lets GLOBAL-space
  // private/dormant/merged nodes (and their stimuli content) leak into a tenant's
  // digest counts/samples. Every other read path (search/context/briefing/
  // visible-graph) adds: a global row is only visible if it is public AND its
  // pyramid's access_level is allowed. Mirror that here, JOINing registry r and
  // qualifying per the node alias of each query. Operator (spaceIds null) emits no
  // clause → full visibility, exactly as before.

  switch (prefix) {
    case "domain": {
      // Count stimuli that matched nodes whose label or substance text contains this domain
      const pattern = "%" + value + "%";
      const [result] = await sql`
        SELECT COUNT(DISTINCT s.id)::int as n, MIN(s.content) as sample
        FROM stimuli s
        JOIN stimulus_contributions sc ON sc.stimulus_id = s.id AND sc.base_contribution > 0.001
        JOIN nodes n ON n.addr = sc.node_addr
        ${spaceIds ? sql`JOIN registry r ON r.pyramid_id = n.pyramid_id` : sql``}
        WHERE s.created_at > ${since}
          AND n.visibility <> 'deleted'
          ${spaceIds ? sql`AND s.space_id = ANY(${spaceIds}::text[])
            AND (n.space_id <> 'global' OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))` : sql``}
          AND (n.label ILIKE ${pattern} OR n.substance::text ILIKE ${pattern})`;
      const trendLifecycles = priority === "critical"
        ? ["emerging", "active", "sustained", "cooling"]
        : ["active", "sustained", "cooling"];
      const [trendResult] = await sql`
        SELECT COUNT(*)::int as n, MIN(n.label) as sample
        FROM nodes n
        ${spaceIds ? sql`JOIN registry r ON r.pyramid_id = n.pyramid_id` : sql``}
        WHERE n.node_type = 'trend'
          AND n.visibility <> 'deleted'
          ${spaceIds ? sql`AND n.space_id = ANY(${spaceIds}::text[])
            AND (n.space_id <> 'global' OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))` : sql``}
          AND COALESCE(n.source_context->'trend'->>'lifecycle', 'emerging') = ANY(${trendLifecycles}::text[])
          AND (n.label ILIKE ${pattern} OR n.substance::text ILIKE ${pattern})
          AND COALESCE(
            (n.source_context->'trend'->>'last_stimulus_at')::timestamptz,
            (n.source_context->'trend'->>'birth_time')::timestamptz,
            n.created_at
          ) > ${since}`;
      return {
        count: parseInt(result.n) + parseInt(trendResult.n),
        sample: result.sample
          ? result.sample.slice(0, 120)
          : trendResult.sample
            ? `Trend: ${String(trendResult.sample).slice(0, 120)}`
            : null,
      };
    }
    case "node": {
      // Count contributions to this specific node
      const [result] = await sql`
        SELECT COUNT(DISTINCT sc.stimulus_id)::int as n, MIN(s.content) as sample
        FROM stimulus_contributions sc
        JOIN stimuli s ON s.id = sc.stimulus_id
        JOIN nodes n ON n.addr = sc.node_addr
        ${spaceIds ? sql`JOIN registry r ON r.pyramid_id = n.pyramid_id` : sql``}
        WHERE sc.node_addr = ${value}
          AND sc.created_at > ${since}
          AND sc.base_contribution > 0.001
          AND n.visibility <> 'deleted'
          ${spaceIds ? sql`AND n.space_id = ANY(${spaceIds}::text[])
            AND (n.space_id <> 'global' OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))` : sql``}`;
      return { count: result.n, sample: result.sample ? result.sample.slice(0, 120) : null };
    }
    case "heat": {
      // Count nodes currently above threshold
      const threshold = parseFloat(value.replace(">", "")) || 0.05;
      const [result] = await sql`
        SELECT COUNT(*)::int as n FROM nodes
        ${spaceIds ? sql`JOIN registry r ON r.pyramid_id = nodes.pyramid_id` : sql``}
        WHERE stimulus_heat > ${threshold}
          AND visibility <> 'deleted'
          ${spaceIds ? sql`AND nodes.space_id = ANY(${spaceIds}::text[])
            AND (nodes.space_id <> 'global' OR (nodes.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))` : sql``}`;
      return { count: result.n, sample: result.n > 0 ? `${result.n} nodes above ${threshold} heat threshold` : null };
    }
    case "source": {
      // Count stimuli from this source since last check. A GLOBAL-space stimulus is
      // only visible to a tenant caller if it links to a global PUBLIC node (mirrors
      // briefing.ts); the LEFT JOINs are only added for non-operators.
      const [result] = await sql`
        SELECT COUNT(*)::int as n, MIN(s.content) as sample
        FROM stimuli s
        ${spaceIds ? sql`LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id` : sql``}
        WHERE s.source = ${value} AND s.created_at > ${since}
          ${spaceIds ? sql`AND s.space_id = ANY(${spaceIds}::text[])
            AND (s.space_id <> 'global' OR (n.addr IS NOT NULL AND n.space_id = 'global' AND n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[])))` : sql``}`;
      return { count: result.n, sample: result.sample ? result.sample.slice(0, 120) : null };
    }
    default:
      return { count: 0, sample: null };
  }
}

export default watch;
