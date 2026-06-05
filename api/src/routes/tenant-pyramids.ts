/**
 * /tenant-pyramids — Tenant-owned pyramid management.
 *
 * Routes:
 *   GET  /tenant-pyramids                 — list tenant pyramids
 *   POST /tenant-pyramids                 — create a user pyramid
 *   POST /tenant-pyramids/:id/rename      — rename a pyramid
 *   POST /tenant-pyramids/:id/delete      — delete a user pyramid
 *   POST /tenant-pyramids/:id/level       — set sync_level
 *   POST /tenant-pyramids/:id/describe   — set description
 *
 * Auth: tenant-scoped beta or operator for reads, operator-only for writes.
 * Same pattern as /projects.
 *
 * These are NOT graph ontology pyramids (WORLD, FUNCTION, META, etc.)
 * which live at /pyramids. Tenant pyramids are a separate concept for
 * tenant policy and organization above projects.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext, isOperator } from "../lib/access";
import {
  ensureTenantPyramids,
  listTenantPyramids,
  createTenantPyramid,
  renameTenantPyramid,
  deleteTenantPyramid,
  setTenantPyramidLevel,
  describeTenantPyramid,
} from "../lib/tenant-pyramids";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";

const tenantPyramids = new Hono();

// ── Resolve tenant ID ───────────────────────────────────────────────
// Same pattern as /projects: operator uses ?tenant_id, beta uses token.

function resolveTenantId(c: any): string | null {
  const access = getAccessContext(c);
  if (access.scope === "operator") {
    return (c.req.query("tenant_id") || "").trim() || null;
  }
  return access.tenantId || null;
}

// ── GET /tenant-pyramids ────────────────────────────────────────────
// List all tenant pyramids for the resolved tenant.
// Lazily ensures system pyramids exist on first access.

tenantPyramids.get("/", async (c) => {
  const tenantId = resolveTenantId(c);
  if (!tenantId) {
    const access = getAccessContext(c);
    if (access.scope === "operator") {
      return errorJson(c, "invalid_request", { message: "Operator must specify ?tenant_id=<id>" });
    }
    return errorJson(c, "tenant_required", {
      message: "Tenant scope required. Use a token mapped via VERITY_AGENT_TOKENS.",
    });
  }

  // Lazy bootstrap: ensure system pyramids + project membership exist
  await ensureTenantPyramids(sql, tenantId);
  const { ensureProjectPyramidMembership } = await import("../lib/tenant-pyramids");
  await ensureProjectPyramidMembership(sql, tenantId);

  const pyramids = await listTenantPyramids(sql, tenantId);

  // Compute honest project counts per pyramid
  const spaceId = `tenant:${tenantId}`;
  const counts = await sql`
    SELECT tenant_pyramid_id, COUNT(*)::int as project_count
    FROM nodes
    WHERE pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
      AND tenant_pyramid_id IS NOT NULL
    GROUP BY tenant_pyramid_id
  `;
  const countMap = new Map(counts.map((r: any) => [r.tenant_pyramid_id, r.project_count]));

  return c.json({
    ok: true,
    tenant_id: tenantId,
    pyramids: pyramids.map((p) => ({
      pyramid_id: p.pyramid_id,
      label: p.label,
      description: p.description || null,
      kind: p.kind,
      system_key: p.system_key,
      sync_level: p.sync_level,
      project_count: countMap.get(p.pyramid_id) || 0,
      created_at: p.created_at,
      updated_at: p.updated_at,
    })),
    count: pyramids.length,
    note: "Tenant pyramids are organizational containers above projects. They are NOT graph ontology pyramids (WORLD, FUNCTION, etc.).",
  });
});

// ── POST /tenant-pyramids ───────────────────────────────────────────
// Create a user pyramid. Operator-only in first cut.

tenantPyramids.post("/", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", {
      message: "Unauthorized",
      hint: "Tenant pyramid creation requires operator auth in the first cut. Use VERITY_OPERATOR_TOKENS.",
    });
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return errorJson(c, "invalid_request", { message: "JSON body required" });
  }

  const label = (body?.label || "").trim();
  const tenantId = (body?.tenant_id || "").trim();
  const syncLevel = body?.sync_level;

  if (!label) return errorJson(c, "invalid_request", { message: "label is required" });
  if (!tenantId) return errorJson(c, "invalid_request", { message: "tenant_id is required" });

  // Ensure system pyramids exist before user creates any
  await ensureTenantPyramids(sql, tenantId);

  try {
    const result = await createTenantPyramid(sql, tenantId, label, syncLevel);
    await auditMutation(c, sql, {
      kind: "pyramid_created",
      tenantId,
      pyramidId: result.pyramid_id,
      actor: "operator",
      actorKind: "operator_token",
      eventData: { label, sync_level: syncLevel || null },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[tenant-pyramids/create] failed:", e);
    return errorJson(c, "invalid_request", { message: "Tenant pyramid create failed" });
  }
});

// ── POST /tenant-pyramids/:id/rename ────────────────────────────────

tenantPyramids.post("/:id/rename", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized", { message: "Unauthorized", hint: "Requires operator auth." });
  }

  const pyramidId = c.req.param("id");
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return errorJson(c, "invalid_request", { message: "JSON body required" });
  }

  const newLabel = (body?.label || "").trim();
  const tenantId = (body?.tenant_id || "").trim();
  if (!newLabel) return errorJson(c, "invalid_request", { message: "label is required" });
  if (!tenantId) return errorJson(c, "invalid_request", { message: "tenant_id is required" });

  try {
    const result = await renameTenantPyramid(sql, tenantId, pyramidId, newLabel);
    await auditMutation(c, sql, {
      kind: "pyramid_renamed",
      tenantId,
      pyramidId,
      actor: "operator",
      actorKind: "operator_token",
      eventData: { label: newLabel },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[tenant-pyramids/rename] failed:", e);
    return errorJson(c, "invalid_request", { message: "Tenant pyramid rename failed" });
  }
});

// ── POST /tenant-pyramids/:id/delete ────────────────────────────────

tenantPyramids.post("/:id/delete", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized", { message: "Unauthorized", hint: "Requires operator auth." });
  }

  const pyramidId = c.req.param("id");
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const tenantId = (body?.tenant_id || "").trim();
  if (!tenantId) return errorJson(c, "invalid_request", { message: "tenant_id is required" });

  try {
    const result = await deleteTenantPyramid(sql, tenantId, pyramidId);
    await auditMutation(c, sql, {
      kind: "pyramid_deleted",
      tenantId,
      pyramidId,
      actor: "operator",
      actorKind: "operator_token",
    });
    return c.json({ ok: true, ...result, deleted: true });
  } catch (e) {
    console.error("[tenant-pyramids/delete] failed:", e);
    return errorJson(c, "invalid_request", { message: "Tenant pyramid delete failed" });
  }
});

// ── POST /tenant-pyramids/:id/level ─────────────────────────────────

tenantPyramids.post("/:id/level", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized", { message: "Unauthorized", hint: "Requires operator auth." });
  }

  const pyramidId = c.req.param("id");
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return errorJson(c, "invalid_request", { message: "JSON body required" });
  }

  const tenantId = (body?.tenant_id || "").trim();
  const syncLevel = (body?.sync_level || "").trim();
  if (!tenantId) return errorJson(c, "invalid_request", { message: "tenant_id is required" });
  if (!syncLevel) return errorJson(c, "invalid_request", { message: "sync_level is required" });

  try {
    const result = await setTenantPyramidLevel(sql, tenantId, pyramidId, syncLevel);
    await auditMutation(c, sql, {
      kind: "tenant_settings_changed",
      tenantId,
      actor: "operator",
      actorKind: "operator_token",
      settingKey: `tenant_pyramid.${pyramidId}.sync_level`,
      eventData: { pyramid_id: pyramidId, sync_level: syncLevel },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[tenant-pyramids/level] failed:", e);
    return errorJson(c, "invalid_request", { message: "Tenant pyramid sync-level update failed" });
  }
});

// ── POST /tenant-pyramids/:id/describe ──────────────────────────────
tenantPyramids.post("/:id/describe", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized", { message: "Unauthorized", hint: "Requires operator auth." });
  }
  const body = await c.req.json().catch(() => ({}));
  const tenantId = body.tenant_id || c.req.query("tenant_id");
  if (!tenantId) {
    return errorJson(c, "invalid_request", { message: "tenant_id required" });
  }
  const pyramidId = c.req.param("id");
  const description = body.description !== undefined ? (body.description || null) : undefined;
  if (description === undefined) {
    return errorJson(c, "invalid_request", { message: "description field required (string or null to clear)" });
  }
  try {
    const result = await describeTenantPyramid(sql, tenantId, pyramidId, description);
    await auditMutation(c, sql, {
      kind: "tenant_settings_changed",
      tenantId,
      actor: "operator",
      actorKind: "operator_token",
      settingKey: `tenant_pyramid.${pyramidId}.description`,
      eventData: { pyramid_id: pyramidId, description_set: description !== null },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[tenant-pyramids/describe] failed:", e);
    return errorJson(c, "invalid_request", { message: "Tenant pyramid description update failed" });
  }
});

export default tenantPyramids;
