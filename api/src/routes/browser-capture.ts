/**
 * /browser-capture/* — local-only browser capture intake.
 *
 * This route is deliberately narrower than Vault harvest:
 *   - capture tokens are local vobc_* secrets, not dashboard/session/sync creds
 *   - /intake writes one markdown artifact under inbox/web-clips/
 *   - optional harvest handoff is controlled by a tenant-bearer local setting
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getAccessContext, resolveAgentBearerForTenant } from "../lib/access";
import { errorJson } from "../lib/error-envelope";
import {
  readBrowserCaptureAutoHarvest,
  readVaultDashboardState,
  writeBrowserCaptureAutoHarvest,
} from "../lib/vault-control";
import {
  issueBrowserCaptureToken,
  listBrowserCaptureTokens,
  resolveBrowserCaptureToken,
  revokeBrowserCaptureToken,
} from "../lib/browser-capture-token";
import { writeBrowserCaptureIntake } from "../lib/browser-capture-intake";

const MAX_INTAKE_CONTENT_LENGTH = 128_000;

const browserCapture = new Hono();

type ClipperSyncRunnerFn = (typeof import("../lib/vault-harvest"))["runVaultClipperSync"];
let clipperSyncRunnerOverride: ClipperSyncRunnerFn | null = null;
export function __setBrowserCaptureClipperSyncRunnerForTests(fn: ClipperSyncRunnerFn | null): void {
  clipperSyncRunnerOverride = fn;
}

function tokenFromAuthorization(raw: string | undefined): string | null {
  const match = (raw || "").match(/^Bearer\s+(vobc_[A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

function allowedExtensionOrigins(): Set<string> {
  return new Set(
    (process.env.VERITY_BROWSER_CAPTURE_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return allowedExtensionOrigins().has(origin);
}

function applyExtensionCors(c: Context, origin: string | undefined): void {
  if (!origin || !originAllowed(origin)) return;
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
}

browserCapture.options("/intake", async (c) => {
  const origin = c.req.header("origin");
  if (!originAllowed(origin)) {
    return errorJson(c, "forbidden", {
      message: "Browser capture origin is not allowed.",
      details: { reason: "origin_not_allowed" },
    });
  }
  applyExtensionCors(c, origin);
  return new Response(null, { status: 204, headers: c.res.headers });
});

browserCapture.post("/tokens", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message: "Browser capture token issuance requires a tenant-scoped bearer.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label : null;
  const result = issueBrowserCaptureToken({ tenantId: access.tenantId, label });
  return c.json({
    ok: true,
    token: result.token,
    token_id: result.record.token_id,
    token_prefix: result.record.token_prefix,
    scope: result.record.scope,
    tenant_id: result.record.tenant_id,
    label: result.record.label,
    created_at: result.record.created_at,
  });
});

browserCapture.get("/tokens", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message: "Browser capture token listing requires a tenant-scoped bearer.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }
  return c.json({ ok: true, tokens: listBrowserCaptureTokens(access.tenantId) });
});

browserCapture.post("/tokens/:tokenId/revoke", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message: "Browser capture token revocation requires a tenant-scoped bearer.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }
  const record = revokeBrowserCaptureToken({
    tenantId: access.tenantId,
    tokenId: c.req.param("tokenId"),
  });
  if (!record) {
    return errorJson(c, "not_found", { message: "Browser capture token not found." });
  }
  return c.json({ ok: true, token: record });
});

browserCapture.get("/settings", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message: "Browser capture settings require a tenant-scoped bearer.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }
  return c.json({
    ok: true,
    tenant_id: access.tenantId,
    browser_capture_auto_harvest: readBrowserCaptureAutoHarvest(access.tenantId),
  });
});

browserCapture.post("/settings", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message: "Browser capture settings require a tenant-scoped bearer.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.browser_capture_auto_harvest !== "boolean") {
    return errorJson(c, "invalid_request", {
      message: "browser_capture_auto_harvest must be true or false.",
    });
  }
  const result = writeBrowserCaptureAutoHarvest(access.tenantId, body.browser_capture_auto_harvest);
  return c.json({
    ok: true,
    tenant_id: access.tenantId,
    browser_capture_auto_harvest: result.next,
    previous: result.previous === true,
  });
});

async function runOptionalClipperHandoff(input: {
  tenantId: string;
  vaultRoot: string;
}): Promise<{
  mode: "inbox_only" | "clipper_sync_auto";
  ok: boolean;
  reason?: string;
  results?: Awaited<ReturnType<ClipperSyncRunnerFn>>;
}> {
  if (!readBrowserCaptureAutoHarvest(input.tenantId)) {
    return { mode: "inbox_only", ok: true };
  }

  const tenantToken = resolveAgentBearerForTenant(input.tenantId);
  if (!tenantToken) {
    return { mode: "clipper_sync_auto", ok: false, reason: "tenant_bearer_missing" };
  }

  const envOperator = (process.env.VERITY_OPERATOR_TOKENS || "").split(",")[0]?.trim();
  const runner = clipperSyncRunnerOverride
    ?? (await import("../lib/vault-harvest")).runVaultClipperSync;
  const results = await runner({
    root: input.vaultRoot,
    auto: true,
    tenantToken,
    operatorToken: envOperator || null,
    verbose: false,
  });
  const hasIncomplete = results.some((row) => row.status === "partial" || row.status === "malformed");
  return {
    mode: "clipper_sync_auto",
    ok: !hasIncomplete,
    reason: hasIncomplete ? "clipper_sync_incomplete" : undefined,
    results,
  };
}

browserCapture.post("/intake", async (c) => {
  const origin = c.req.header("origin");
  if (!originAllowed(origin)) {
    return errorJson(c, "forbidden", {
      message: "Browser capture origin is not allowed.",
      details: { reason: "origin_not_allowed" },
    });
  }
  applyExtensionCors(c, origin);
  const contentLength = Number(c.req.header("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_INTAKE_CONTENT_LENGTH) {
    return errorJson(c, "payload_too_large", {
      message: "Browser capture payload is too large.",
      details: { max_bytes: MAX_INTAKE_CONTENT_LENGTH },
    });
  }

  const rawToken = tokenFromAuthorization(c.req.header("authorization"));
  if (!rawToken) {
    return errorJson(c, "unauthorized", {
      message: "Browser capture intake requires Authorization: Bearer vobc_*.",
    });
  }
  const token = resolveBrowserCaptureToken(rawToken);
  if (!token) {
    return errorJson(c, "unauthorized", { message: "Browser capture token is invalid or revoked." });
  }

  const state = readVaultDashboardState(null, token.tenant_id);
  if (state.status_kind !== "ready" || !state.vault_root) {
    return errorJson(c, "conflict", {
      message: "Vault must be initialized and ready before browser capture intake.",
      details: { status_kind: state.status_kind },
    });
  }

  const body = await c.req.json().catch(() => null);
  const result = writeBrowserCaptureIntake(state.vault_root, body);
  if (!result.ok) {
    const code = result.reason === "write_failed" ? "internal_error" : "invalid_request";
    return errorJson(c, code, {
      message: result.message,
      details: { reason: result.reason, field: result.field },
    });
  }

  const handoff = await runOptionalClipperHandoff({
    tenantId: token.tenant_id,
    vaultRoot: state.vault_root,
  });

  return c.json({
    ok: true,
    path: result.path,
    relative_path: result.relative_path,
    source_url: result.source_url,
    handoff,
  });
});

export default browserCapture;
