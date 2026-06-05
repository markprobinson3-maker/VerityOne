/**
 * /projects — Tenant-facing project registry.
 *
 * Routes:
 *   GET  /projects                    — list projects (tenant-scoped beta or operator)
 *   POST /projects                    — create project (operator-only in first cut)
 *   POST /projects/:addr/rename       — rename project (operator-only)
 *   POST /projects/:addr/archive      — archive project (operator-only)
 *   POST /projects/:addr/unarchive    — unarchive project (operator-only)
 *
 * Storage authority: PROJECTS depth-1 root nodes in the `nodes` table.
 * No new table, no file. The graph IS the registry.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext, isOperator } from "../lib/access";
import {
  listProjects,
  createProject,
  renameProject,
  archiveProject,
  unarchiveProject,
  moveProject,
} from "../lib/project-registry";
import {
  ensureProjectPyramidMembership,
  getTenantPyramid,
} from "../lib/tenant-pyramids";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { auditMutation } from "../lib/audit";
import {
  CreateProjectSchema,
  RenameProjectSchema,
  ArchiveProjectSchema,
  MoveProjectSchema,
  DescribeProjectSchema,
} from "../schemas/projects.schema";

const projects = new Hono();

// ── GET /projects ── list projects for the tenant ──────────────────────
// Auth: operator OR beta with tenantId.
projects.get("/", async (c) => {
  const access = getAccessContext(c);

  let spaceId: string;
  if (access.scope === "operator") {
    // Operator: use tenant_id from query or default
    const tenantId = c.req.query("tenant_id");
    if (!tenantId) {
      return errorJson(c, "invalid_request", { message: "Operator must specify ?tenant_id=<id>" });
    }
    spaceId = `tenant:${tenantId}`;
  } else if (access.tenantId) {
    spaceId = `tenant:${access.tenantId}`;
  } else {
    return errorJson(c, "tenant_required", {
      hint: "Tenant scope required to list projects. Use a token mapped via VERITY_AGENT_TOKENS.",
    });
  }

  // Lazy backfill: ensure legacy projects have pyramid membership
  const tenantId = spaceId.replace("tenant:", "");
  await ensureProjectPyramidMembership(sql, tenantId);

  const rows = await listProjects(sql, spaceId);
  const active = rows.filter((r) => !r.dormant_at);
  const archived = rows.filter((r) => !!r.dormant_at);

  const mapRow = (r: typeof rows[0]) => ({
    addr: r.addr,
    label: r.label,
    memory_count: r.memory_count,
    description: r.description,
    created_at: r.created_at,
    ...(r.dormant_at ? { dormant_at: r.dormant_at } : {}),
    grouping: r.tenant_pyramid_id ? {
      tenant_pyramid_id: r.tenant_pyramid_id,
      label: r.pyramid_label,
      kind: r.pyramid_kind,
      system_key: r.pyramid_system_key,
    } : null,
  });

  return c.json({
    ok: true,
    space_id: spaceId,
    active: active.map(mapRow),
    archived: archived.map(mapRow),
    total_active: active.length,
    total_archived: archived.length,
  });
});

// ── POST /projects ── create a project ─────────────────────────────────
// Auth: operator-only in first cut.
projects.post("/", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", {
      hint: "Project creation requires operator auth. Use VERITY_OPERATOR_TOKENS.",
    });
  }

  const body = await validateRequest(c, CreateProjectSchema);
  const label = body.label.trim();
  const tenantId = body.tenant_id.trim();
  const description = (body.description || "").trim();
  const requestedPyramidId = (body.tenant_pyramid_id || "").trim() || null;

  // Validate tenant_pyramid_id if specified
  if (requestedPyramidId) {
    const pyramid = await getTenantPyramid(sql, tenantId, requestedPyramidId);
    if (!pyramid) {
      return errorJson(c, "pyramid_unknown", {
        message: `Tenant pyramid not found: ${requestedPyramidId}. Use GET /tenant-pyramids to list available pyramids.`,
      });
    }
  }

  const spaceId = `tenant:${tenantId}`;

  try {
    const result = await createProject(sql, spaceId, label, description, requestedPyramidId || undefined);
    await auditMutation(c, sql, {
      kind: "project_created",
      tenantId,
      actor: "operator",
      actorKind: "operator_token",
      projectAddr: (result as any).addr ?? "",
      eventData: { label, has_description: !!description, pyramid_id: requestedPyramidId || null },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[projects/create] failed:", e);
    return errorJson(c, "invalid_request", { message: "Project create failed" });
  }
});

// ── POST /projects/:addr/rename ────────────────────────────────────────
projects.post("/:addr/rename", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required");
  }

  const addr = c.req.param("addr");
  const body = await validateRequest(c, RenameProjectSchema);

  try {
    const result = await renameProject(sql, `tenant:${body.tenant_id}`, addr, body.label.trim());
    await auditMutation(c, sql, {
      kind: "project_renamed",
      tenantId: body.tenant_id,
      actor: "operator",
      actorKind: "operator_token",
      projectAddr: addr,
      eventData: { new_label: body.label.trim() },
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("[projects/rename] failed:", e);
    return errorJson(c, "invalid_request", { message: "Project rename failed" });
  }
});

// ── POST /projects/:addr/archive ───────────────────────────────────────
projects.post("/:addr/archive", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required");
  }

  const addr = c.req.param("addr");
  const body = await validateRequest(c, ArchiveProjectSchema);

  try {
    const result = await archiveProject(sql, `tenant:${body.tenant_id}`, addr);
    await auditMutation(c, sql, {
      kind: "project_archived",
      tenantId: body.tenant_id,
      actor: "operator",
      actorKind: "operator_token",
      projectAddr: addr,
    });
    return c.json({ ok: true, ...result, archived: true });
  } catch (e) {
    console.error("[projects/archive] failed:", e);
    return errorJson(c, "invalid_request", { message: "Project archive failed" });
  }
});

// ── POST /projects/:addr/unarchive ─────────────────────────────────────
projects.post("/:addr/unarchive", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required");
  }

  const addr = c.req.param("addr");
  const body = await validateRequest(c, ArchiveProjectSchema);

  try {
    const result = await unarchiveProject(sql, `tenant:${body.tenant_id}`, addr);
    await auditMutation(c, sql, {
      kind: "project_unarchived",
      tenantId: body.tenant_id,
      actor: "operator",
      actorKind: "operator_token",
      projectAddr: addr,
    });
    return c.json({ ok: true, ...result, archived: false });
  } catch (e) {
    console.error("[projects/unarchive] failed:", e);
    return errorJson(c, "invalid_request", { message: "Project unarchive failed" });
  }
});

// ── POST /projects/:addr/move ──────────────────────────────────────────
// Move a project to a different tenant pyramid.
projects.post("/:addr/move", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required");
  }

  const addr = c.req.param("addr");
  const body = await validateRequest(c, MoveProjectSchema);
  const tenantId = body.tenant_id.trim();
  const tenantPyramidId = body.tenant_pyramid_id.trim();

  // Validate target pyramid exists and belongs to the same tenant
  const pyramid = await getTenantPyramid(sql, tenantId, tenantPyramidId);
  if (!pyramid) {
    return errorJson(c, "pyramid_unknown", {
      message: `Tenant pyramid not found: ${tenantPyramidId}. Use GET /tenant-pyramids to list available pyramids.`,
    });
  }

  try {
    const result = await moveProject(sql, `tenant:${tenantId}`, addr, tenantPyramidId);
    await auditMutation(c, sql, {
      kind: "project_moved",
      tenantId,
      actor: "operator",
      actorKind: "operator_token",
      projectAddr: addr,
      eventData: { tenant_pyramid_id: tenantPyramidId, pyramid_kind: pyramid.kind },
    });
    return c.json({
      ok: true,
      ...result,
      pyramid_label: pyramid.label,
      pyramid_kind: pyramid.kind,
    });
  } catch (e) {
    console.error("[projects/move] failed:", e);
    return errorJson(c, "invalid_request", { message: "Project move failed" });
  }
});

// ── POST /projects/:addr/describe ────────────────────────────────────────
projects.post("/:addr/describe", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required");
  }

  const addr = c.req.param("addr");
  const body = await validateRequest(c, DescribeProjectSchema);
  const tenantId = body.tenant_id.trim();
  const rawDescription = body.description;
  const description =
    rawDescription === null || rawDescription.trim() === ""
      ? null
      : rawDescription.trim();

  const spaceId = `tenant:${tenantId}`;
  const [project] = await sql`
    SELECT addr, label, substance FROM nodes
    WHERE addr = ${addr}
      AND space_id = ${spaceId}
      AND pyramid_id = 'PROJECTS'
      AND depth = 1
      AND visibility <> 'deleted'
  `;
  if (!project) return errorJson(c, "project_not_found");

  // F7: description is part of the canonical embedding text, so refresh
  // the four embedding marker columns in the same transaction as the
  // substance change.
  const { embedTextForInsert, embeddingTextForNode } = await import("../lib/embed");
  const currentSubstance =
    project.substance && typeof project.substance === "object" && !Array.isArray(project.substance)
      ? project.substance
      : {};
  const refreshedSubstance = { ...currentSubstance, description };
  const refreshedEmbed = await embedTextForInsert(embeddingTextForNode(project.label, refreshedSubstance));
  const updatedRows = await sql`
    UPDATE nodes SET
      substance = substance || ${sql.json({ description })}::jsonb,
      embedding_hv = ${refreshedEmbed.vecStr}::halfvec(3072),
      embedding_at = ${refreshedEmbed.embeddedAt},
      embedding_model = ${refreshedEmbed.model},
      embedding_task_type = ${refreshedEmbed.taskType},
      updated_at = now()
    WHERE addr = ${addr}
      AND space_id = ${spaceId}
      AND pyramid_id = 'PROJECTS'
      AND depth = 1
      AND substance IS NOT DISTINCT FROM ${sql.json(project.substance ?? null)}::jsonb
    RETURNING addr
  `;
  if (updatedRows.length === 0) {
    return errorJson(c, "state_mismatch", {
      message: "Project changed while description embedding was being computed. Retry the update.",
    });
  }

  // Sync journal: project upsert (description change). Best-effort post-mutation.
  const { journalProject } = await import("../lib/sync-journal-port");
  journalProject(sql, "upsert", addr, spaceId).catch((e) =>
    console.error("[projects/describe] journalProject failed:", e?.message),
  );

  await auditMutation(c, sql, {
    kind: "project_described",
    tenantId,
    actor: "operator",
    actorKind: "operator_token",
    projectAddr: addr,
    eventData: { has_description: description !== null },
  });

  return c.json({ ok: true, addr, description });
});

export default projects;
