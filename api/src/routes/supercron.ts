import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext, rateLimit, requireBetaAccess, requireOperatorAccess } from "../lib/access";
import { auditMutation } from "../lib/audit";
import { errorJson } from "../lib/error-envelope";
import { readSupercronStatus, unavailableSupercronStatusSnapshot } from "../lib/supercron-status";

const supercron = new Hono();
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FORCE_RUN_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const FORCE_RUN_RATE_LIMIT_MAX = 1;
const FORCE_RUN_MAX_RESERVED_BUDGET_USD = 10;
const FORCE_RUN_DEFAULT_MANUAL_BUDGET_USD = 10;
const FORCE_RUN_MAX_BODY_BYTES = 4096;
const FORCE_RUN_GRAPH_STATE_PREFIX = "supercron.force_run";
const FORCE_RUN_GRAPH_STATE_REQUESTED_AT_SUFFIX = "requested_at";
const FORCE_RUN_GRAPH_STATE_TENANT_SUFFIX = "tenant_id";
const FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX = "payload";
let cachedForceRunInstanceTenant: { value: string | null; expiresAt: number } | null = null;

interface ForceRunRequest {
  tenantId: string;
  llmBudgetUsd: number | null;
}

function parseOptionalBudgetUsd(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || Array.isArray(value) || typeof value === "object") return "invalid";
  if (typeof value !== "number" && typeof value !== "string") return "invalid";
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return "invalid";
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > FORCE_RUN_MAX_RESERVED_BUDGET_USD) return "invalid";
  if (Math.abs((parsed * 100) - Math.round(parsed * 100)) > 1e-9) return "invalid";
  return parsed;
}

function forceRunGraphStateKey(tenantId: string, suffix: string): string {
  return `${FORCE_RUN_GRAPH_STATE_PREFIX}.${tenantId}.${suffix}`;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const codePoint = ch.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

async function readForceRunInstanceTenantId(): Promise<string | null> {
  if (cachedForceRunInstanceTenant && cachedForceRunInstanceTenant.expiresAt > Date.now()) {
    return cachedForceRunInstanceTenant.value;
  }
  const envTenantId = (process.env.VERITY_INSTANCE_TENANT_ID || "").trim();
  if (envTenantId) {
    const [tenant] = await sql`
      SELECT t.tenant_id
      FROM tenants t
      JOIN graph_spaces gs
        ON gs.space_id = 'tenant:' || t.tenant_id
        AND gs.tenant_id = t.tenant_id
        AND gs.kind = 'tenant'
      WHERE t.tenant_id = ${envTenantId}
        AND t.status = 'active'
      LIMIT 1
    `;
    if (!tenant?.tenant_id) throw new Error(`tenant_space_missing:${envTenantId}`);
    cachedForceRunInstanceTenant = { value: envTenantId, expiresAt: Date.now() + 60_000 };
    return envTenantId;
  }
  const tenants = await sql`
    SELECT t.tenant_id
    FROM tenants t
    JOIN graph_spaces gs
      ON gs.space_id = 'tenant:' || t.tenant_id
      AND gs.tenant_id = t.tenant_id
      AND gs.kind = 'tenant'
    WHERE t.status = 'active'
    ORDER BY t.created_at ASC, t.tenant_id ASC
    LIMIT 2
  `;
  if (tenants.length > 1) throw new Error("instance_tenant_required_multiple_active_tenants");
  const value = tenants[0]?.tenant_id ? String(tenants[0].tenant_id) : null;
  cachedForceRunInstanceTenant = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

async function parseForceRunRequest(c: any, next: any) {
  const access = getAccessContext(c);
  const contentType = c.req.header("content-type") || "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json." });
  }
  const contentLength = Number(c.req.header("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > FORCE_RUN_MAX_BODY_BYTES) {
    return errorJson(c, "payload_too_large", { message: "Force-run request body is too large." });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await c.req.text();
    if (utf8ByteLength(raw) > FORCE_RUN_MAX_BODY_BYTES) {
      return errorJson(c, "payload_too_large", { message: "Force-run request body is too large." });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return errorJson(c, "invalid_request", { message: "Request body must be valid JSON." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson(c, "invalid_request", { message: "Request body must be a JSON object." });
  }
  const bodyTenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
  const tenantId = access.scope === "operator" ? bodyTenantId : (access.tenantId || bodyTenantId);
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  if (access.scope !== "operator" && (!access.tenantId || (bodyTenantId && access.tenantId !== bodyTenantId))) {
    return errorJson(c, "forbidden", { message: "Force-run requires operator scope or a matching tenant beta token." });
  }
  const llmBudgetUsd = parseOptionalBudgetUsd(body.llm_budget_usd);
  if (llmBudgetUsd === "invalid") {
    return errorJson(c, "invalid_request", { message: "llm_budget_usd must be a non-negative dollar amount up to 10.00 when provided." });
  }
  c.set("force_run_request", { tenantId, llmBudgetUsd } satisfies ForceRunRequest);
  c.set("force_run_tenant_id", tenantId);
  await next();
}

supercron.get("/status", requireOperatorAccess(), async (c) => {
  let status;
  try {
    status = await readSupercronStatus(sql);
  } catch (error: any) {
    status = unavailableSupercronStatusSnapshot(error);
  }
  return c.json(status);
});

supercron.post(
  "/force-run",
  requireBetaAccess(),
  parseForceRunRequest,
  rateLimit({
    key: "force-run",
    max: FORCE_RUN_RATE_LIMIT_MAX,
    windowMs: FORCE_RUN_RATE_LIMIT_WINDOW_MS,
    identity: (c) => `force-run-${c.get("force_run_tenant_id")}`,
  }),
  async (c) => {
    const access = getAccessContext(c);
    const req = (c as any).get("force_run_request") as ForceRunRequest;
    let instanceTenantId: string | null;
    try {
      instanceTenantId = await readForceRunInstanceTenantId();
    } catch (error: any) {
      return errorJson(c, "instance_tenant_required", {
        message: "VERITY_INSTANCE_TENANT_ID must identify one active tenant graph space.",
      });
    }
    if (!instanceTenantId) {
      return errorJson(c, "instance_tenant_required", {
        message: "VERITY_INSTANCE_TENANT_ID must identify one active tenant graph space.",
      });
    }
    if (req.tenantId !== instanceTenantId) {
      return errorJson(c, "force_run_tenant_mismatch", {
        message: "Force-run tenant must match this SuperCron instance owner.",
        details: { instance_tenant_id: instanceTenantId },
      });
    }
    const [tenant] = await sql`
      SELECT 1 FROM graph_spaces
      WHERE space_id = ${`tenant:${req.tenantId}`}
        AND tenant_id = ${req.tenantId}
        AND kind = 'tenant'
      LIMIT 1
    `;
    if (!tenant) {
      return errorJson(c, "tenant_not_found", { message: "Tenant not found." });
    }
    const [openManualRun] = await sql`
      SELECT id, status
      FROM supercron_manual_runs
      WHERE tenant_id = ${req.tenantId}
        AND status IN ('pending', 'running')
      ORDER BY requested_at ASC, id ASC
      LIMIT 1
    `;
    if (openManualRun) {
      return errorJson(c, "manual_run_already_open", {
        message: "A SuperCron manual run is already pending or running for this tenant.",
        details: {
          manual_run_id: Number(openManualRun.id),
          status: String(openManualRun.status),
        },
      });
    }

    const requestedAt = new Date().toISOString();
    const requestedBy = access.scope === "operator" ? "operator" : (access.agentId || req.tenantId);
    const budgetMode = req.llmBudgetUsd == null ? "default_manual_budget" : "manual_budget";
    const payload = {
      tenant_id: req.tenantId,
      requested_at: requestedAt,
      requested_by: requestedBy,
      requested_by_kind: access.scope === "operator" ? "operator_token" : "tenant_session",
      llm_budget_usd: req.llmBudgetUsd,
      budget_mode: budgetMode,
      enforcement: "deferred",
    };

    await (sql as any).begin(async (tx: any) => {
      await tx`
        INSERT INTO graph_state (key, value, updated_at)
        VALUES
          (${forceRunGraphStateKey(req.tenantId, FORCE_RUN_GRAPH_STATE_REQUESTED_AT_SUFFIX)}, ${requestedAt}, now()),
          (${forceRunGraphStateKey(req.tenantId, FORCE_RUN_GRAPH_STATE_TENANT_SUFFIX)}, ${req.tenantId}, now()),
          (${forceRunGraphStateKey(req.tenantId, FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX)}, ${JSON.stringify(payload)}, now())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              updated_at = EXCLUDED.updated_at
      `;
      await auditMutation(c, sql as any, {
        kind: "supercron_force_run",
        tenantId: req.tenantId,
        actor: requestedBy,
        actorKind: access.scope === "operator" ? "operator_token" : "tenant_session",
        eventData: payload,
      }, { tx });
    });

    return c.json({
      ok: true,
      accepted: true,
      tenant_id: req.tenantId,
      requested_at: requestedAt,
      budget_mode: budgetMode,
      manual_budget_usd: req.llmBudgetUsd ?? FORCE_RUN_DEFAULT_MANUAL_BUDGET_USD,
    }, 202);
  },
);

export default supercron;
