/**
 * World Ingestor V2 — REST API endpoints.
 *
 * POST /wi/ingest         — { url, dry_run?, force?, priority? } → { run_id, status }
 * POST /wi/ingest/batch   — { urls[], dry_run?, priority? } → { queued, duplicates }
 * GET  /wi/runs           — recent run history
 * DELETE /wi/runs/:run_id — rollback a run
 * GET  /wi/queue          — queue depth + items
 * GET  /wi/skills         — skill proposals (filterable by status)
 * POST /wi/skills/:id/approve — approve a skill
 * POST /wi/skills/:id/reject  — reject a skill
 * GET  /wi/health         — system health check
 */

import { Hono } from "hono";
import { sql } from "../db";
import { errorJson, ApiError } from "../lib/error-envelope";
import { readBoundedJsonBody } from "../lib/bounded-body";

// Import pipeline functions from miners
import { receive } from "../../../miners/src/wi/receive";
import { extract } from "../../../miners/src/wi/extract";
import { route } from "../../../miners/src/wi/route";
import { rollbackRun } from "../../../miners/src/wi/rollback";
import { markWISourceHistoryFailed } from "../../../miners/src/wi/source-history";
import { installSkill, rejectSkill } from "../../../miners/src/wi/skills";
import { enqueue } from "../../../miners/src/wi/queue";
import { listProtoClusters, promoteProtoCluster, dismissProtoCluster } from "../../../miners/src/trends/service";
import { auditMutation } from "../lib/audit";
import { clampInt } from "../lib/utils";

const app = new Hono();

function wiAuditTenant(): string {
  return process.env.VERITY_DEFAULT_TENANT_ID || "system";
}

// ============================================================
// POST /ingest — trigger ingestion
// ============================================================

app.post("/ingest", async (c) => {
  const parsed = await readBoundedJsonBody(c, 10_000_000);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};
  const url = body.url;
  if (!url || typeof url !== "string") {
    return errorJson(c, "invalid_request", { message: "Missing 'url' in request body" });
  }

  const dryRun = !!body.dry_run;
  const force = !!body.force;
  let source: Awaited<ReturnType<typeof receive>> | null = null;

  try {
    source = await receive(url, { dryRun, force });
    const atoms = await extract(source.textParts, source.runId, source.sourceType, source.title);
    const result = await route(atoms, source.runId, {
      dryRun,
      force,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      sourceHash: source.sourceHash,
      title: source.title,
    });

    if (!dryRun) {
      await auditMutation(c, sql, {
        kind: "admin_action",
        tenantId: wiAuditTenant(),
        actor: "operator",
        actorKind: "operator_token",
        operation: "wi_ingest",
        eventData: {
          run_id: result.runId,
          source_type: result.sourceType,
          atoms_extracted: result.atomsExtracted,
          atoms_new_node: result.atomsNewNode,
          force,
        },
      });
    }

    return c.json({
      run_id: result.runId,
      status: result.status,
      source_type: result.sourceType,
      title: result.title,
      atoms_extracted: result.atomsExtracted,
      atoms_new_node: result.atomsNewNode,
      atoms_heat: result.atomsHeat,
      atoms_skill: result.atomsSkill,
      atoms_drop: result.atomsDrop,
      elapsed_ms: result.elapsedMs,
      cost_usd: result.costUsd,
      dry_run: dryRun,
      force,
    });
  } catch (err: any) {
    if (!dryRun) {
      await markWISourceHistoryFailed({
        runId: source?.runId,
        sourceId: url,
        lastError: "world_ingest_failed",
      }).catch(() => {});
    }
    console.error("[wi/ingest] failed:", err);
    return errorJson(c, "validation_failed", { message: "World ingest request failed" });
  }
});

// ============================================================
// GET /runs — recent run history
// ============================================================

app.get("/runs", async (c) => {
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);

  const runs = await sql`
    SELECT run_id, source_url, source_type, title,
      atoms_extracted, atoms_new_node, atoms_heat, atoms_skill, atoms_drop,
      skills_detected, cost_usd::numeric(10,6), elapsed_ms, status, error,
      created_at
    FROM wi_runs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return c.json({ runs, count: runs.length });
});

// ============================================================
// GET /queue — queue status
// ============================================================

app.get("/queue", async (c) => {
  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'processing') AS processing,
      COUNT(*) FILTER (WHERE status = 'done') AS done,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) AS total
    FROM wi_queue
  `;

  const items = await sql`
    SELECT id, url, source_type, priority, status, submitted_by, submitted_at, error_message
    FROM wi_queue
    WHERE status IN ('pending', 'processing')
    ORDER BY priority ASC, submitted_at ASC
    LIMIT 20
  `;

  return c.json({ counts, items });
});

// ============================================================
// GET /health — system health
// ============================================================

app.get("/health", async (c) => {
  const checks: Record<string, any> = {};

  // PostgreSQL
  try {
    const start = Date.now();
    await sql`SELECT 1`;
    checks.postgresql = { ok: true, latency_ms: Date.now() - start };
  } catch (err: any) {
    console.warn("[wi/health] postgresql check failed:", err);
    checks.postgresql = { ok: false, error: "postgresql_check_failed" };
  }

  // Recent runs (last 24h)
  try {
    const [stats] = await sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COALESCE(AVG(elapsed_ms), 0)::int AS avg_elapsed_ms,
        COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost
      FROM wi_runs
      WHERE created_at > now() - interval '24 hours'
    `;
    checks.runs_24h = {
      total: parseInt(stats.total),
      failed: parseInt(stats.failed),
      avg_elapsed_ms: stats.avg_elapsed_ms,
      cost: parseFloat(stats.cost),
    };
  } catch (err: any) {
    console.warn("[wi/health] runs_24h check failed:", err);
    checks.runs_24h = { error: "runs_24h_check_failed" };
  }

  // Queue
  try {
    const [q] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing' AND started_at < now() - interval '15 minutes') AS stale
      FROM wi_queue
    `;
    checks.queue = { pending: parseInt(q.pending), stale: parseInt(q.stale) };
  } catch (err: any) {
    console.warn("[wi/health] queue check failed:", err);
    checks.queue = { error: "queue_check_failed" };
  }

  // Recent errors
  try {
    const errors = await sql`
      SELECT run_id, source_url, error, created_at
      FROM wi_runs
      WHERE error IS NOT NULL AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 5
    `;
    checks.recent_errors = errors;
  } catch {
    checks.recent_errors = [];
  }

  const allOk = checks.postgresql?.ok !== false;
  return c.json({ ok: allOk, checks, timestamp: new Date().toISOString() });
});

// ============================================================
// POST /ingest/batch — bulk submission
// ============================================================

app.post("/ingest/batch", async (c) => {
  const parsed = await readBoundedJsonBody(c, 10_000_000);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};
  const urls = body.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return errorJson(c, "invalid_request", { message: "Missing 'urls' array in request body" });
  }

  const priority = body.priority ?? 5;
  const submittedBy = body.submitted_by ?? "api:batch";
  const queued: string[] = [];
  const errors: string[] = [];

  for (const url of urls) {
    if (typeof url !== "string" || !url.trim()) continue;
    try {
      const id = await enqueue(url.trim(), { priority, submittedBy });
      queued.push(url);
    } catch (err: any) {
      console.warn("[wi/ingest/batch] enqueue failed:", { url, err });
      errors.push(`${url}: enqueue_failed`);
    }
  }

  if (queued.length > 0) {
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: submittedBy,
      actorKind: "operator_token",
      operation: "wi_ingest_queue",
      eventData: { queued_count: queued.length, errors_count: errors.length, priority },
    });
  }

  return c.json({ queued: queued.length, errors: errors.length, error_details: errors });
});

// ============================================================
// DELETE /runs/:run_id — rollback a run
// ============================================================

app.delete("/runs/:run_id", async (c) => {
  const runId = c.req.param("run_id");
  try {
    const result = await rollbackRun(runId);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: "operator",
      actorKind: "operator_token",
      operation: "wi_run_rollback",
      eventData: { run_id: runId, ...result },
    });
    return c.json({
      rolled_back: true,
      run_id: runId,
      staging_nodes_deleted: result.stagingNodesDeleted,
      stimuli_deleted: result.stimuliDeleted,
      skill_proposals_deleted: result.skillProposalsDeleted,
      skills_moved: result.skillsMoved,
    });
  } catch (err: any) {
    console.error("[wi/runs/rollback] failed:", err);
    return errorJson(c, "validation_failed", { message: "World ingest rollback failed" });
  }
});

// ============================================================
// GET /skills — skill proposals
// ============================================================

app.get("/skills", async (c) => {
  const status = c.req.query("status");
  const limit = clampInt(c.req.query("limit"), 50, 1, 200);

  let skills;
  if (status) {
    skills = await sql`
      SELECT id, content, source_url, skill_type, status,
        quality_scores, reviewed_by, reviewed_at, rejection_reason,
        skill_path, invocation_count, error_count,
        created_at, retired_at, retired_reason
      FROM wi_skill_proposals
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    skills = await sql`
      SELECT id, content, source_url, skill_type, status,
        quality_scores, reviewed_by, reviewed_at, rejection_reason,
        skill_path, invocation_count, error_count,
        created_at, retired_at, retired_reason
      FROM wi_skill_proposals
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return c.json({ skills, count: skills.length });
});

// ============================================================
// POST /skills/:id/approve — approve and install a skill
// ============================================================

app.post("/skills/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"));
  try {
    // Update status to approved
    await sql`
      UPDATE wi_skill_proposals SET
        status = 'approved',
        reviewed_by = 'human',
        reviewed_at = now()
      WHERE id = ${id} AND status IN ('needs_human', 'proposed', 'auto_review')
    `;

    const skillPath = await installSkill(id);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: "operator",
      actorKind: "operator_token",
      operation: "wi_skill_approve",
      eventData: { proposal_id: id, skill_path: skillPath },
    });
    return c.json({ approved: true, id, skill_path: skillPath });
  } catch (err: any) {
    console.error("[wi/skills/approve] failed:", err);
    return errorJson(c, "validation_failed", { message: "Skill approval failed" });
  }
});

// ============================================================
// POST /skills/:id/reject — reject a skill
// ============================================================

app.post("/skills/:id/reject", async (c) => {
  const id = parseInt(c.req.param("id"));
  const parsed = await readBoundedJsonBody(c, 10_000_000);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};
  const reason = body.reason || "Rejected by human reviewer";

  try {
    await rejectSkill(id, reason);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: "operator",
      actorKind: "operator_token",
      operation: "wi_skill_reject",
      eventData: { proposal_id: id, reason },
    });
    return c.json({ rejected: true, id, reason });
  } catch (err: any) {
    console.error("[wi/skills/reject] failed:", err);
    return errorJson(c, "validation_failed", { message: "Skill rejection failed" });
  }
});

// ============================================================
// GET /convergence — convergence events
// ============================================================

app.get("/convergence", async (c) => {
  const events = await listProtoClusters();
  return c.json({ events, count: events.length });
});

// ============================================================
// POST /convergence/:id/promote — manually promote to node
// ============================================================

app.post("/convergence/:id/promote", async (c) => {
  const id = c.req.param("id");
  try {
    const addr = await promoteProtoCluster(id);
    if (!addr) return errorJson(c, "not_found", { message: "Event not found or not in detected state" });
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: "operator",
      actorKind: "operator_token",
      operation: "wi_convergence_promote",
      eventData: { cluster_id: id, node_addr: addr },
    });
    return c.json({ promoted: true, id, node_addr: addr });
  } catch (err: any) {
    console.error("[wi/convergence/promote] failed:", err);
    return errorJson(c, "validation_failed", { message: "Convergence promotion failed" });
  }
});

// ============================================================
// POST /convergence/:id/dismiss — dismiss a convergence event
// ============================================================

app.post("/convergence/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  try {
    await dismissProtoCluster(id);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: wiAuditTenant(),
      actor: "operator",
      actorKind: "operator_token",
      operation: "wi_convergence_dismiss",
      eventData: { cluster_id: id },
    });
    return c.json({ dismissed: true, id });
  } catch (err: any) {
    console.error("[wi/convergence/dismiss] failed:", err);
    return errorJson(c, "validation_failed", { message: "Convergence dismiss failed" });
  }
});

export default app;
