/**
 * /bootstrap/project — Project-aware agent bootstrap.
 *
 * Infers tenant project from local workspace context, runs project-scoped
 * recall when confidence is high, falls back to tenant-wide recall otherwise.
 *
 * This is a LOCAL-FIRST endpoint: raw workspace data stays on the local node.
 * The public VO layer does not control tenant project identity.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext, resolveAgentTenant } from "../lib/access";
import { inferProject } from "../lib/project-inference";
import { compileRecall } from "../lib/recall-compiler";
import { resolveAgentPolicy } from "../lib/agent-policy";
import { resolveTenantSettings } from "../lib/runtime-profile";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";

const bootstrap = new Hono();

bootstrap.post("/project", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required for project bootstrap." });
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return errorJson(c, "invalid_request", { message: "Request body required" });
  }

  const spaceId = `tenant:${access.tenantId}`;
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 2000) : "";
  const startMs = Date.now();

  // 1. Infer project
  const inference = await inferProject(sql, access.tenantId, spaceId, {
    explicit_project_addr: typeof body.explicit_project_addr === "string" ? body.explicit_project_addr : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    workspace_name: typeof body.workspace_name === "string" ? body.workspace_name : undefined,
    repo_slug: typeof body.repo_slug === "string" ? body.repo_slug : undefined,
    goal,
  });

  // 2. Determine bootstrap confidence tier and workspace routing safety.
  //
  // Only high-confidence or explicit-override matches are safe for automatic
  // workspace routing. Medium-confidence partial matches (e.g., an arbitrary cwd
  // that fuzzy-matches an unrelated project) must NOT silently steer recall,
  // produce project-scoped memory payloads, recommended write shapes, or
  // bootstrap context — they are advisory-only and must be surfaced without
  // being acted on.
  //
  // Tier 1 (safe):          explicit_override or confidence=high
  // Tier 2 (advisory only): confidence=medium — show but never act on
  // Tier 3 (unsafe):        confidence=low or no inference
  const safeForWorkspaceRouting =
    inference.inferred !== null && (
      inference.inferred.source === "explicit_override" ||
      inference.inferred.confidence === "high"
    );

  const workspaceRoutingReason = !inference.inferred
    ? "no project inferred — tenant-wide recall only"
    : safeForWorkspaceRouting
      ? `${inference.inferred.confidence}-confidence match (${inference.inferred.source}) → safe to thread project context into workspace recall`
      : `${inference.inferred.confidence}-confidence match (${inference.inferred.source}) — withheld from automatic workspace routing; use explicit_project_addr to override`;

  // 3. Run project-scoped recall only when inference is Tier 1 (safeForWorkspaceRouting).
  //    Medium-confidence matches produce no project recall payload — an agent must not
  //    see project-scoped memories for an unconfirmed project identity.
  // Resolve agent-policy visible_projects so bootstrap recall respects
  // the same project restrictions as /memory/recall.
  let visibleProjectAddrs: string[] | null = null;
  if (access.scope !== "operator" && access.agentId) {
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch { /* DB error → no filtering */ }
    const machineSettings = resolveTenantSettings();
    const effective = resolveAgentPolicy(access.agentId, storedMetadata, machineSettings);
    visibleProjectAddrs = effective.visible_projects;
  }

  let projectMemory: {
    used: boolean;
    project_addr: string | null;
    project_label: string | null;
    primary_memories: any[];
    supporting_memories: any[];
  } = { used: false, project_addr: null, project_label: null, primary_memories: [], supporting_memories: [] };

  // Track whether project recall was skipped due to visible_projects policy
  // (hoisted for posture logic below).
  let projectSkippedByPolicy = false;

  if (safeForWorkspaceRouting && inference.inferred) {
    // If the inferred project is outside the agent's visible_projects,
    // skip project-scoped recall entirely rather than leaking memories.
    const inferredAddr = inference.inferred.addr;
    const projectAllowed = !visibleProjectAddrs || visibleProjectAddrs.includes(inferredAddr);
    projectSkippedByPolicy = !projectAllowed;

    if (projectAllowed) {
      try {
        const recallQuery = goal || `project decisions and context for ${inference.inferred.label}`;
        const recall = await compileRecall(sql, {
          query: recallQuery,
          tenantId: access.tenantId,
          spaceId,
          agentId: access.agentId,
          projectAddr: inference.inferred.addr,
          visibleProjectAddrs,
          limit: 5,
          suppressExposureEvent: true,
          suppressTelemetry: true,
        });
        projectMemory = {
          used: true,
          project_addr: inference.inferred.addr,
          project_label: inference.inferred.label,
          primary_memories: recall.primary_memories,
          supporting_memories: recall.supporting_memories,
        };
      } catch (e: any) {
        console.error("[bootstrap/project] project recall failed:", e?.message);
      }
    }
    // else: project disallowed by agent policy — skip project recall
  }

  // 4. Always run tenant-wide recall (broader context)
  let tenantMemory: {
    used: boolean;
    primary_memories: any[];
  } = { used: false, primary_memories: [] };

  try {
    const tenantQuery = goal || "recent decisions, corrections, and preferences";
    const tenantRecall = await compileRecall(sql, {
      query: tenantQuery,
      tenantId: access.tenantId,
      spaceId,
      agentId: access.agentId,
      visibleProjectAddrs,
      // Prefer (not restrict) the inferred project's memories: this tenant-wide
      // recall still surfaces unscoped memories, but in-project ones rank higher.
      // Gated on Tier-1 safety (safeForWorkspaceRouting): a MEDIUM-confidence
      // (Tier-2 advisory) inference must be shown but NEVER acted on, and
      // re-ranking recall IS acting on it — so only boost a high-confidence /
      // explicit-override project.
      projectContextAddr: safeForWorkspaceRouting && inference.inferred ? inference.inferred.addr : undefined,
      limit: 3,
      suppressExposureEvent: true,
      suppressTelemetry: true,
    });
    tenantMemory = {
      used: true,
      primary_memories: tenantRecall.primary_memories,
    };
  } catch (e: any) {
    console.error("[bootstrap/project] tenant recall failed:", e?.message);
  }

  // 5. Determine posture
  const hasProjectMemory = projectMemory.used && projectMemory.primary_memories.length > 0;
  const hasTenantMemory = tenantMemory.primary_memories.length > 0;
  const skippedByPolicy = projectSkippedByPolicy;
  const posture = hasProjectMemory
    ? "project_backed"
    : skippedByPolicy
      ? "project_restricted_by_policy"
      : inference.inferred
        ? "project_inferred_no_memory"
        : hasTenantMemory
          ? "tenant_only"
          : "no_memory";

  const postureNote =
    posture === "project_backed"
      ? `Project "${inference.inferred!.label}" inferred confidently. Starting with project-scoped tenant memory.`
      : posture === "project_restricted_by_policy"
        ? `Project "${inference.inferred!.label}" inferred but excluded by agent visible_projects policy. Using tenant-wide memory.`
        : posture === "project_inferred_no_memory"
          ? `Project "${inference.inferred!.label}" inferred but confidence is too low for automatic project recall. Using tenant-wide memory.`
          : posture === "tenant_only"
            ? "No confident project match. Using tenant-wide memory."
            : "No project inference and no tenant memories found for this context.";

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    operation: "tenant_bootstrap",
    eventData: {
      posture,
      inferred_project_addr: inference.inferred?.addr || null,
      safe_for_workspace_routing: safeForWorkspaceRouting,
      project_memory_count: projectMemory.primary_memories.length,
      tenant_memory_count: tenantMemory.primary_memories.length,
    },
  });

  return c.json({
    ok: true,
    inferred_project: inference.inferred,
    candidates: inference.candidates.length > 1 ? inference.candidates.slice(0, 3) : undefined,
    project_memory: projectMemory,
    tenant_memory: tenantMemory,
    bootstrap_posture: {
      status: posture,
      note: postureNote,
    },
    /** Agents must check this before threading inferred_project into workspace recall.
     *  false = advisory-only: show the inferred project but do not bias recall with it. */
    safe_for_workspace_routing: safeForWorkspaceRouting,
    workspace_routing_reason: workspaceRoutingReason,
    /** Only non-null when safe_for_workspace_routing=true. Medium-confidence matches
     *  do not get a write shape — callers must use explicit project_addr to write. */
    recommended_write_shape: safeForWorkspaceRouting && inference.inferred ? {
      project_addr: inference.inferred.addr,
      scope: "project",
    } : null,
    /** Only non-null when safe_for_workspace_routing=true. Pass to /memory/write to
     *  carry forward the project context. Medium-confidence matches must not produce
     *  a bootstrap_context that auto-scopes writes to an unconfirmed project. */
    bootstrap_context: safeForWorkspaceRouting && inference.inferred ? {
      project_addr: inference.inferred.addr,
      project_label: inference.inferred.label,
      confidence: inference.inferred.confidence,
      source: inference.inferred.source,
      tenant_id: access.tenantId,
      issued_at: new Date().toISOString(),
    } : null,
    ms: Date.now() - startMs,
  });
});

export default bootstrap;
