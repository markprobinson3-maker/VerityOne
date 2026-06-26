/**
 * /providers — Provider management API for the local dashboard.
 *
 * Routes:
 *   GET  /providers/status    — redacted provider summary + task routing
 *   POST /providers/validate  — real API check for a provider
 *   POST /providers/defaults  — set task routing for one task
 *   POST /providers/agent-override — set per-agent LLM override
 *
 * Auth: tenant-scoped. Mutations are operator-only in first cut.
 * API keys are NEVER returned by any route.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { readBoundedJsonBody } from "../lib/bounded-body";
import { getAccessContext, isOperator } from "../lib/access";
import {
  readProviderSummary,
  setProviderKey,
  removeProviderKey,
  writeTaskRoute,
  CANONICAL_TASKS,
  type TaskRoute,
} from "../lib/provider-config";
import { validateProvider } from "../lib/provider-validate";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { listTenantAgentIds } from "../lib/agent-override";

// L2-6 (batch-28): byte cap for all providers POST body reads.
const PROVIDERS_MAX_BODY_BYTES = 64_000;

const providers = new Hono();

// Type-safe string field read (batch-25 #5). The previous `(body?.x || "").trim()`
// threw on a truthy non-string (e.g. { provider: 42 }), 500-ing instead of
// returning invalid_request. Matches the readStringField copies in account.ts /
// remote.ts: a non-string coerces to its String() form, null/undefined → "".
function readStringField(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

// ── GET /providers/status ────────────────────────────────────────────

providers.get("/status", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const summary = readProviderSummary();

  // Aggregate per-agent overrides, scoped to tenant-owned agents only.
  // VERITY_AGENT_TENANTS maps agent_id → tenant_id. Only include agents
  // whose tenant_id matches the caller's tenant.
  let agentOverrides: Record<string, unknown> = {};
  try {
    const tenantAgentIds = listTenantAgentIds(access.tenantId);

    if (tenantAgentIds.length > 0) {
      const rows = await sql`
        SELECT agent_id, metadata->'llm_overrides' as overrides
        FROM agent_profiles
        WHERE tenant_id = ${access.tenantId} AND agent_id = ANY(${tenantAgentIds})
          AND metadata->'llm_overrides' IS NOT NULL
          AND metadata->'llm_overrides' != 'null'::jsonb
      `;
      for (const row of rows) {
        if (row.overrides && typeof row.overrides === "object") {
          agentOverrides[row.agent_id] = row.overrides;
        }
      }
    }
  } catch { /* agent_profiles may not exist */ }

  return c.json({
    ok: true,
    ...summary,
    agent_overrides: agentOverrides,
  });
});

// ── POST /providers/validate ─────────────────────────────────────────

providers.post("/validate", async (c) => {
  // Operator-only, matching every other /providers mutation (defaults, key,
  // overrides). Validation makes an external provider API call and mutates the
  // local validation cache (provider-validate.ts updateValidationCache); a
  // tenant/beta token must not be able to drive either. The dashboard validate
  // bridge is already operator-gated — this brings the direct route to parity.
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required to validate a provider." });
  }

  const bounded = await readBoundedJsonBody(c, PROVIDERS_MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.response;
  const body = bounded.value;
  const provider = readStringField((body as any)?.provider);
  if (!provider) {
    return errorJson(c, "invalid_request", { message: "provider is required." });
  }

  const result = await validateProvider(provider);
  return c.json({ ok: true, ...result });
});

// ── POST /providers/defaults ─────────────────────────────────────────

providers.post("/defaults", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for task routing changes." });
  }

  const bounded = await readBoundedJsonBody(c, PROVIDERS_MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.response;
  const body = bounded.value;
  const task = readStringField((body as any)?.task);
  const provider = readStringField((body as any)?.provider);
  const model = readStringField((body as any)?.model);

  if (!task) return errorJson(c, "invalid_request", { message: "task is required." });
  if (!provider) return errorJson(c, "invalid_request", { message: "provider is required." });
  if (!model) return errorJson(c, "invalid_request", { message: "model is required." });

  // VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: writeTaskRoute throws
  // NonCanonicalTaskError if the task name is not in CANONICAL_TASKS.
  // Map that to an honest 400 instead of a 500.
  try {
    const result = writeTaskRoute(task, { provider, model });
    await auditMutation(c, sql, {
      kind: "tenant_settings_changed",
      tenantId: getAccessContext(c).tenantId || process.env.VERITY_DEFAULT_TENANT_ID || "system",
      actor: "operator",
      actorKind: "operator_token",
      settingKey: `provider.defaults.${task}`,
      eventData: { task, provider, model },
    });
    return c.json({ ok: true, task, ...result });
  } catch (e: any) {
    const { NonCanonicalTaskError } = await import("../lib/provider-config");
    if (e instanceof NonCanonicalTaskError) {
      return errorJson(c, "invalid_request", { message: `task must be one of: ${CANONICAL_TASKS.join(", ")}` });
    }
    throw e;
  }
});

// ── POST /providers/defaults/clear ───────────────────────────────────
// VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1.
// Operator-only. Clears one task routing override; idempotent.

providers.post("/defaults/clear", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for task routing changes." });
  }

  const bounded = await readBoundedJsonBody(c, PROVIDERS_MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.response;
  const body = bounded.value;
  const taskType = readStringField((body as any)?.task_type);
  if (!taskType) return errorJson(c, "invalid_request", { message: "task_type is required." });

  // Defense-in-depth: also enforce canonical-task at the route layer
  // (the validator only runs for queue commands; direct routes bypass
  // it). Mirrors the agent-override clear surfaces.
  if (!CANONICAL_TASKS.includes(taskType as any)) {
    return errorJson(c, "invalid_request", { message: `task_type must be one of: ${CANONICAL_TASKS.join(", ")}` });
  }

  const { clearTaskRoute } = await import("../lib/provider-config");
  const res = clearTaskRoute(taskType);
  await auditMutation(c, sql, {
    kind: "tenant_settings_changed",
    tenantId: getAccessContext(c).tenantId || process.env.VERITY_DEFAULT_TENANT_ID || "system",
    actor: "operator",
    actorKind: "operator_token",
    settingKey: `provider.defaults.${taskType}`,
    eventData: { task_type: taskType, cleared: res.cleared },
  });
  return c.json({ ok: true, task_type: taskType, cleared: res.cleared, previous: res.previous });
});

// ── POST /providers/agent-override ───────────────────────────────────
// Operator-only. Scoped to agents owned by the operator's tenant via
// VERITY_AGENT_TENANTS mapping.
//
// VO-REMOTE-COMMAND-PROVIDER-AGENT-OVERRIDE-PR-1: collapsed onto the
// shared `writeAgentOverride` helper. The previous local-only write
// path had NO tenant-ownership check and NO governance journal — both
// now fixed by going through the canonical helper.

providers.post("/agent-override", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for agent LLM overrides." });
  }

  const bounded = await readBoundedJsonBody(c, PROVIDERS_MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.response;
  const body = bounded.value;
  const bodyTenantId = ((body as any)?.tenant_id || "").toString().trim();
  const agentId = readStringField((body as any)?.agent_id);
  const task = readStringField((body as any)?.task);
  const provider = readStringField((body as any)?.provider);
  const model = readStringField((body as any)?.model);

  // Tenant resolution (parallel to /dashboard/providers/agent-override):
  //   - A tenant token carries `tenantId` directly on the AccessContext.
  //   - An operator token has `tenantId: null` and must supply the
  //     target tenant explicitly in the request body as `tenant_id`.
  // Field name is `tenantId` (camelCase) on AccessContext — NOT
  // `tenant_id`. The previous refactor used the wrong field and
  // reached `writeAgentOverride` with an empty string, which the
  // helper correctly rejected as invalid_input — breaking every
  // direct local override write. Captured by an in-process test now.
  const access = getAccessContext(c);
  const tenantId = access.tenantId || bodyTenantId;
  if (!tenantId) {
    return errorJson(c, "invalid_request", { message: "tenant_id is required for operator tokens (tenant tokens carry it implicitly)." });
  }

  if (!agentId) return errorJson(c, "invalid_request", { message: "agent_id is required." });
  if (!task) return errorJson(c, "invalid_request", { message: "task is required." });
  if (!provider) return errorJson(c, "invalid_request", { message: "provider is required." });
  if (!model) return errorJson(c, "invalid_request", { message: "model is required." });

  const { writeAgentOverride } = await import("../lib/agent-override");
  const res = await writeAgentOverride(sql as any, { tenantId, agentId, task, provider, model });
  if (!res.ok) {
    if (res.reason === "invalid_input") return errorJson(c, "invalid_request", { message: res.detail });
    if (res.reason === "not_in_tenant") return errorJson(c, "tenant_required", { message: `Agent "${agentId}" not in this tenant.` });
    if (res.reason === "agent_not_found") return errorJson(c, "not_found", { message: `Agent not found: ${agentId}` });
    return errorJson(c, "internal_error", { message: "Override write failed." });
  }
  await auditMutation(c, sql, {
    kind: "tenant_settings_changed",
    tenantId,
    actor: "operator",
    actorKind: "operator_token",
    settingKey: `provider.agent_override.${agentId}.${task}`,
    eventData: { agent_id: agentId, task, provider, model },
  });
  return c.json({
    ok: true,
    agent_id: res.agent_id,
    task: res.task,
    previous: res.previous,
    next: { provider: res.provider, model: res.model },
  });
});

// ── POST /providers/agent-override/clear ─────────────────────────────
// VO-PROVIDER-AGENT-OVERRIDE-CLEAR-PR-1.
// Operator-only. Tenant-resolved exactly like the set route above.

providers.post("/agent-override/clear", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for agent LLM overrides." });
  }

  const bounded = await readBoundedJsonBody(c, PROVIDERS_MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.response;
  const body = bounded.value;
  const bodyTenantId = ((body as any)?.tenant_id || "").toString().trim();
  const agentId = readStringField((body as any)?.agent_id);
  const task = readStringField((body as any)?.task);

  const access = getAccessContext(c);
  const tenantId = access.tenantId || bodyTenantId;
  if (!tenantId) {
    return errorJson(c, "invalid_request", { message: "tenant_id is required for operator tokens (tenant tokens carry it implicitly)." });
  }
  if (!agentId) return errorJson(c, "invalid_request", { message: "agent_id is required." });
  if (!task) return errorJson(c, "invalid_request", { message: "task is required." });

  const { clearAgentOverride } = await import("../lib/agent-override");
  const res = await clearAgentOverride(sql as any, { tenantId, agentId, task });
  if (!res.ok) {
    if (res.reason === "invalid_input") return errorJson(c, "invalid_request", { message: res.detail });
    if (res.reason === "not_in_tenant") return errorJson(c, "tenant_required", { message: `Agent "${agentId}" not in this tenant.` });
    if (res.reason === "agent_not_found") return errorJson(c, "not_found", { message: `Agent not found: ${agentId}` });
    return errorJson(c, "internal_error", { message: "Override clear failed." });
  }
  await auditMutation(c, sql, {
    kind: "tenant_settings_changed",
    tenantId,
    actor: "operator",
    actorKind: "operator_token",
    settingKey: `provider.agent_override.${agentId}.${task}`,
    eventData: { agent_id: agentId, task, cleared: res.cleared },
  });
  return c.json({
    ok: true,
    agent_id: res.agent_id,
    task: res.task,
    cleared: res.cleared,
    previous: res.previous,
  });
});

export default providers;
