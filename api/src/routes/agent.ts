/**
 * /agent/:id — View and update agent profiles
 *
 * GET  /agent/:id          — view agent profile + stats + effective policy
 * POST /agent/:id          — update capabilities and metadata (self or operator; policy stripped)
 * POST /agent/:id/policy   — update agent policy (operator-only)
 */

import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { assertAgentSelfOrOperator, getAccessContext, isOperator, resolveAgentTenant } from "../lib/access";
import { resolveAgentPolicy } from "../lib/agent-policy";
import { resolveTenantSettings } from "../lib/runtime-profile";
import { AgentPolicyPatchSchema, AgentUpdateSchema } from "../schemas/agent.schema";
import { auditMutation } from "../lib/audit";

const agent = new Hono();

const BLOCKED_KEYS = ['__proto__', 'constructor', 'prototype'];

function sanitizeKeys(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  const clean: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (BLOCKED_KEYS.includes(k)) continue;
    clean[k] = sanitizeKeys(v);
  }
  return clean;
}

// GET /agent/:id — view agent profile
agent.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!assertAgentSelfOrOperator(c, id)) {
    return errorJson(c, "forbidden");
  }

  const tenant = resolveAgentTenant(c, id);
  const [row] = await sql`SELECT * FROM agent_profiles WHERE tenant_id = ${tenant} AND agent_id = ${id}`;
  if (!row) {
    return errorJson(c, "not_found", { message: `Agent not found: ${id}` });
  }

  const successRate = row.success_count + row.failure_count > 0
    ? parseFloat((row.success_count / (row.success_count + row.failure_count)).toFixed(2))
    : null;

  // Resolve effective policy under the machine-level ceiling.
  const machineSettings = resolveTenantSettings();
  const metadata = (row.metadata && typeof row.metadata === "object") ? row.metadata as Record<string, unknown> : null;
  const effectivePolicy = resolveAgentPolicy(row.agent_id, metadata, machineSettings);

  return c.json({
    ok: true,
    agent_id: row.agent_id,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    stats: {
      queries: row.query_count,
      signals: row.signal_count,
      successes: row.success_count,
      failures: row.failure_count,
      success_rate: successRate,
    },
    domain_affinity: row.domain_affinity,
    top_nodes: row.top_nodes,
    capabilities: row.capabilities,
    metadata: row.metadata,
    effective_policy: {
      write_permission: effectivePolicy.write_permission,
      recall_scope: effectivePolicy.recall_scope,
      recall_scope_note: "enforced on /search and /context — tenant_private suppresses public results for this agent",
      visible_projects: effectivePolicy.visible_projects,
      visible_projects_note: "enforced on /memory/recall and /memory/recall/routed — project-backed memories filtered by allowed addrs",
      sources: effectivePolicy.sources,
    },
  });
});

// POST /agent/:id — update capabilities and metadata
agent.post("/:id", async (c) => {
  const id = c.req.param("id");
  if (!assertAgentSelfOrOperator(c, id)) {
    return errorJson(c, "forbidden");
  }

  const body = await validateRequest(c, AgentUpdateSchema, "json", { maxBytes: 50_000 });

  const tenant = resolveAgentTenant(c, id);
  // Ensure agent exists (auto-create)
  await sql`SELECT touch_agent(${tenant}, ${id})`;

  const updates: string[] = [];

  if (body.capabilities && Array.isArray(body.capabilities)) {
    await sql`UPDATE agent_profiles SET capabilities = ${body.capabilities}, updated_at = now() WHERE tenant_id = ${tenant} AND agent_id = ${id}`;
    updates.push("capabilities");
  }

  if (body.metadata && typeof body.metadata === "object") {
    const cleanMetadata = sanitizeKeys(body.metadata);
    // Strip `policy` from self-service metadata writes — agents must not
    // be able to remove their own restrictions. Policy writes go through
    // the operator-only POST /agent/:id/policy route.
    if ("policy" in cleanMetadata) {
      delete cleanMetadata.policy;
    }
    // Merge into existing metadata (use sql.json() for proper JSONB typing)
    await sql`UPDATE agent_profiles SET metadata = metadata || ${sql.json(cleanMetadata)}, updated_at = now() WHERE tenant_id = ${tenant} AND agent_id = ${id}`;
    updates.push("metadata");
  }

  if (updates.length > 0) {
    await auditMutation(c, sql, {
      kind: "agent_updated",
      tenantId: tenant,
      agentId: id,
      actor: getAccessContext(c).agentId || "operator",
      actorKind: isOperator(c) ? "operator_token" : "tenant_session",
      eventData: { updated_fields: updates },
    });
  }

  return c.json({
    ok: true,
    agent_id: id,
    updated: updates,
  });
});

// POST /agent/:id/policy — operator-only policy write
//
// The single mutation surface for agent policy. On a single-tenant
// local-first machine, operator IS the tenant (see AGENT-POLICY-DESIGN-PR-1).
// A future tenant-management credential extends this without route changes.
//
// VO-DASHBOARD-HOSTED-AGENT-POLICY-PR-1: converged on the canonical
// `applyAgentPolicyPatch` helper. Direct route, dashboard bridge, and
// remote dispatch now all go through one mutation seam that shares
// validation, journaling, ceiling resolution, and row-exists semantics.
agent.post("/:id/policy", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized", {
      message: "Unauthorized",
      hint: "Agent policy writes require operator auth. Use VERITY_OPERATOR_TOKENS or --operator-token.",
    });
  }

  const id = c.req.param("id");

  // Operator routes have access.tenantId = null, so derive the tenant
  // from VERITY_AGENT_TENANTS (the same mapping the canonical helper
  // validates against). Absence here is treated the same as
  // not_in_tenant — tells operator that agent is not bound.
  const agentTenants = (process.env.VERITY_AGENT_TENANTS || "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const agentTenantId = agentTenants
    .map((p) => p.split(":"))
    .find(([aid]) => aid === id)?.[1];
  if (!agentTenantId) {
    return errorJson(c, "not_found", {
      message: `Agent "${id}" is not recognized under VERITY_AGENT_TENANTS. ` +
        `Policy can only be set for agents in the configured tenant-agent mapping.`,
    });
  }

  const body = await validateRequest(c, AgentPolicyPatchSchema, "json", { maxBytes: 10_000 });

  const { applyAgentPolicyPatch } = await import("../lib/agent-policy-write");
  const result = await applyAgentPolicyPatch(sql, {
    tenantId: agentTenantId,
    agentId: id,
    patch: body,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "invalid_input":
        return errorJson(c, "validation_failed", { message: result.detail });
      case "not_in_tenant":
        // Shouldn't happen here because we already resolved the mapping,
        // but cover it for completeness — don't leak existence either way.
        return errorJson(c, "not_found", {
          message: `Agent "${id}" is not recognized under VERITY_AGENT_TENANTS.`,
        });
      case "agent_not_found":
        return errorJson(c, "not_found", {
          message: `Agent profile not found: ${id}. Run GET /connect?agent=${id} to create it.`,
        });
      case "invalid_patch":
        return errorJson(c, "validation_failed", {
          message: "Invalid policy patch",
          details: { errors: result.errors },
        });
      case "empty_patch":
        return errorJson(c, "invalid_request", { message: "No valid policy fields in body" });
    }
  }

  await auditMutation(c, sql, {
    kind: "agent_updated",
    tenantId: agentTenantId,
    agentId: id,
    actor: "operator",
    actorKind: "operator_token",
    eventData: { operation: "agent_policy_update" },
  });

  return c.json({
    ok: true,
    agent_id: result.agent_id,
    policy: result.stored_policy,
    effective_policy: {
      write_permission: result.effective_policy.write_permission,
      recall_scope: result.effective_policy.recall_scope,
      visible_projects: result.effective_policy.visible_projects,
      sources: result.effective_policy.sources,
    },
  });
});

export default agent;
