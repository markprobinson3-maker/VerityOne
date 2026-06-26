/**
 * /temporal — Temporal Circle API
 *
 * GET  /temporal/today     — Daily briefing (substance, pending intake, predictions, momentum)
 * POST /temporal/today/log — Write intake entry (what, projects, people, tags, energy)
 * POST /temporal/correct   — Queue correction for next super cron
 * GET  /temporal/range     — Day summaries for a date range
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext } from "../lib/access";
import { buildDayAddr } from "@verity-one/graph-shape";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { upsertEdge } from "../lib/edge-mutations";
import { appendDayNodeIntakeEntry } from "../lib/day-journal/day-node-substance";

const temporal = new Hono();

// Compute day addr from a Date in tenant timezone
function dayAddr(date: Date, tz: string): string {
  // Format date in tenant timezone
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const d = new Date(dateStr + "T12:00:00"); // noon to avoid DST edge
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const doy = Math.floor((d.getTime() - startOfYear.getTime()) / 86400000) + 1;
  return buildDayAddr(d.getFullYear(), doy);
}

function todayAddr(tz: string): string {
  return dayAddr(new Date(), tz);
}

function yesterdayAddr(tz: string): string {
  return dayAddr(new Date(Date.now() - 86400000), tz);
}

// Normalize project name for fuzzy matching (kebab→space)
function normalizeProjectName(name: string): string {
  return name.replace(/-/g, " ").replace(/[[\]]/g, "").trim();
}

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

function truncateCodePoints(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.normalize("NFC").trim();
    if (!normalized) continue;
    if (hasNullByte(normalized)) return null;
    out.push(truncateCodePoints(normalized, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

// ============================================================
// GET /temporal/today
// ============================================================
temporal.get("/today", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant context required" });
  }

  const spaceId = `tenant:${access.tenantId}`;

  // Get tenant timezone from metadata
  const [tenant] = await sql`
    SELECT metadata->'circle'->>'timezone' as tz
    FROM tenants WHERE tenant_id = ${access.tenantId}`;
  const tz = tenant?.tz || "America/Los_Angeles";

  const today = todayAddr(tz);
  const yesterday = yesterdayAddr(tz);

  // 1. Today's day node
  const [dayNode] = await sql`
    SELECT addr, label, substance, order_score, hemisphere_affinity
    FROM nodes
    WHERE addr = ${today}
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'`;

  // 2. Pending intake
  const pendingIntake = await sql`
    SELECT id, content, projects, people, tags, energy, created_at
    FROM temporal_intake
    WHERE target_day = ${today} AND status = 'pending' AND space_id = ${spaceId}
    ORDER BY created_at`;

  // 3. Yesterday summary
  const [yesterdayNode] = await sql`
    SELECT substance->>'summary' as summary
    FROM nodes
    WHERE addr = ${yesterday}
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'`;

  // 4. Week summary (last 7 days)
  const weekDays = await sql`
    SELECT addr, substance->>'summary' as summary, substance->>'date' as date
    FROM nodes
    WHERE node_type = 'day' AND space_id = ${spaceId}
      AND visibility <> 'deleted'
      AND substance->>'summary' IS NOT NULL AND substance->>'summary' <> ''
    ORDER BY addr DESC LIMIT 7`;

  // 5. Predictions (active_on with role 'predicted' for today)
  const predictions = await sql`
    SELECT e.from_addr as node, n.label,
      e.source_context->>'confidence' as confidence,
      e.source_context->>'basis' as basis
    FROM edges e
    JOIN nodes n ON e.from_addr = n.addr
    WHERE e.to_addr = ${today} AND e.edge_type = 'active_on'
      AND n.visibility <> 'deleted'
      AND n.space_id = ${spaceId}
      AND e.source_context->'roles' ? 'predicted'`;

  // 6. Momentum (project activity: last 14 days vs prior 14)
  const momentum = await sql`
    SELECT n.addr, n.label,
      (SELECT COUNT(*) FROM edges e1 WHERE e1.from_addr = n.addr AND e1.edge_type = 'active_on'
        AND e1.to_addr >= ${dayAddr(new Date(Date.now() - 14 * 86400000), tz)}) as recent,
      (SELECT COUNT(*) FROM edges e2 WHERE e2.from_addr = n.addr AND e2.edge_type = 'active_on'
        AND e2.to_addr >= ${dayAddr(new Date(Date.now() - 28 * 86400000), tz)}
        AND e2.to_addr < ${dayAddr(new Date(Date.now() - 14 * 86400000), tz)}) as prior
    FROM nodes n
    WHERE n.addr LIKE 'PJ.0.1.%' AND n.visibility NOT IN ('dormant', 'deleted')
      AND n.space_id = ${spaceId}
    ORDER BY n.addr`;

  const rising = momentum.filter((m: any) => m.recent > m.prior && m.recent > 0);
  const cooling = momentum.filter((m: any) => m.recent < m.prior && m.prior > 0);
  const dormant = momentum.filter((m: any) => m.recent === 0 && m.prior === 0);

  // 7. Memories approaching belt (rising order + increasing project edges)
  const approachingBelt = await sql`
    SELECT n.addr, n.label, n.order_score, n.hemisphere_affinity,
      (SELECT COUNT(*) FROM edges ep
       JOIN nodes np ON (CASE WHEN ep.from_addr = n.addr THEN ep.to_addr ELSE ep.from_addr END = np.addr)
       WHERE (ep.from_addr = n.addr OR ep.to_addr = n.addr)
         AND np.addr LIKE 'PJ.%'
         AND np.visibility <> 'deleted') as project_edges
    FROM nodes n
    WHERE n.hemisphere_affinity BETWEEN -0.2 AND 0.0
      AND n.order_score > 0.1
      AND n.visibility NOT IN ('dormant', 'deleted')
      AND n.space_id = ${spaceId}
    ORDER BY n.hemisphere_affinity DESC
    LIMIT 5`;

  // 8. Heuristics pending review
  const pendingHeuristics = await sql`
    SELECT n.addr, n.label, n.confidence, n.created_at
    FROM nodes n
    WHERE n.node_type = 'heuristic' AND n.pinned = false
      AND n.order_score > 0.3
      AND n.visibility NOT IN ('dormant', 'deleted')
      AND n.space_id = ${spaceId}
    ORDER BY n.order_score DESC
    LIMIT 5`;

  // 9. Projects active today (direct active_on edges from PJ.0.1.x → today)
  const projectsActiveToday = await sql`
    SELECT n.addr, n.label, e.weight, e.confidence
    FROM edges e
    JOIN nodes n ON e.from_addr = n.addr
    WHERE e.to_addr = ${today}
      AND e.edge_type = 'active_on'
      AND n.addr LIKE 'PJ.0.1.%'
      AND n.visibility NOT IN ('dormant', 'deleted')
      AND n.space_id = ${spaceId}
    ORDER BY e.weight DESC`;

  return c.json({
    ok: true,
    today: {
      addr: today,
      substance: dayNode?.substance || null,
      linked_nodes: pendingIntake.length,
    },
    pending_intake: pendingIntake,
    yesterday_summary: yesterdayNode?.summary || null,
    week_summary: weekDays.map((d: any) => ({ date: d.date, summary: d.summary })),
    predictions,
    momentum: {
      rising: rising.map((m: any) => ({ addr: m.addr, label: m.label, recent: m.recent, prior: m.prior })),
      cooling: cooling.map((m: any) => ({ addr: m.addr, label: m.label, recent: m.recent, prior: m.prior })),
      dormant: dormant.map((m: any) => ({ addr: m.addr, label: m.label })),
    },
    memories_approaching_belt: approachingBelt,
    heuristics_pending_review: pendingHeuristics,
    projects_active_today: projectsActiveToday,
  });
});

// ============================================================
// POST /temporal/today/log
// ============================================================
temporal.post("/today/log", async (c) => {
  const ct = (c.req.header("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" });
  }

  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant context required" });
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.what !== "string" || !body.what.trim()) {
    return errorJson(c, "invalid_request", { message: "Missing required field: what" });
  }
  if (hasNullByte(body.what)) {
    return errorJson(c, "invalid_request", { message: "Field what must not contain null bytes" });
  }

  const spaceId = `tenant:${access.tenantId}`;

  const [tenant] = await sql`
    SELECT metadata->'circle'->>'timezone' as tz
    FROM tenants WHERE tenant_id = ${access.tenantId}`;
  const tz = tenant?.tz || "America/Los_Angeles";
  const today = todayAddr(tz);

  const what: string = truncateCodePoints(body.what.normalize("NFC").trim(), 4000);
  const projects = boundedStringArray(body.projects, 10, 160);
  const people = boundedStringArray(body.people, 10, 160);
  const tags = boundedStringArray(body.tags, 20, 80);
  if (!projects || !people || !tags) {
    return errorJson(c, "invalid_request", { message: "projects, people, and tags must not contain null bytes" });
  }
  const energy: number | null = typeof body.energy === "number" ? Math.max(0, Math.min(1, body.energy)) : null;

  const [entry] = await sql.begin(async (tx: any) => {
    // 1. Insert into temporal_intake
    const [inserted] = await tx`
      INSERT INTO temporal_intake (target_day, content, projects, people, tags, energy, status, space_id)
      VALUES (${today}, ${what}, ${projects}, ${people}, ${tags}, ${energy}, 'pending', ${spaceId})
      RETURNING id`;

    // 2. Append to day node substance.intake for real-time visibility.
    // This must be awaited and transactional; a silent failed append leaves
    // the day node and intake queue disagreeing about the same entry.
    const intakeAppend = await appendDayNodeIntakeEntry(tx, {
      dayAddr: today,
      spaceId,
      content: what,
    });
    if (!intakeAppend.ok) {
      if (intakeAppend.reason === "content_too_large") {
        throw new ApiError(
          "payload_too_large",
          `Temporal intake content must be ${intakeAppend.max_length} characters or fewer.`,
          { day: today, max_length: intakeAppend.max_length },
        );
      }
      if (intakeAppend.reason === "content_invalid") {
        throw new ApiError(
          "invalid_request",
          "Temporal intake content must not be empty or contain null bytes.",
          { day: today },
        );
      }
      throw new ApiError(
        "node_not_found",
        `Day node ${today} is missing or deleted; cannot attach temporal intake.`,
        { day: today },
        "Run the temporal day-node bootstrap/backfill before writing intake.",
      );
    }

    return [inserted];
  });

  // 3. Lightweight resolution: match projects to anchor nodes
  const resolved: string[] = [];
  for (const proj of projects) {
    const normalized = normalizeProjectName(proj);
    if (!normalized) continue;

    const [match] = await sql`
      SELECT addr FROM nodes
      WHERE label ILIKE ${"%" + normalized + "%"}
        AND addr LIKE 'PJ.0.1.%'
        AND space_id = ${spaceId}
        AND visibility <> 'deleted'
      ORDER BY length(label) ASC
      LIMIT 1`;

    if (match) {
      // Create preliminary active_on edge
      await upsertEdge(sql, {
        fromAddr: String(match.addr),
        toAddr: today,
        edgeType: "active_on",
        layer: 0,
        confidence: 0.5,
        weight: 0.5,
        provenance: { agent: access.agentId || "claude-code", method: "lightweight-resolution", basis: "inferred" },
        sourceContext: { roles: ["preliminary"], source: "lightweight_resolution" },
        spaceId,
        fromSpaceId: spaceId,
        toSpaceId: spaceId,
      }, { conflictUpdate: "mergeRoles" }).catch(() => {});
      resolved.push(match.addr);
    }
  }

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    operation: "temporal_intake_log",
    eventData: { day: today, entry_id: entry.id, project_count: projects.length, resolved_count: resolved.length },
  });

  return c.json({
    ok: true,
    day: today,
    entry_id: entry.id,
    resolved,
  });
});

// ============================================================
// POST /temporal/correct
// ============================================================
temporal.post("/correct", async (c) => {
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("application/json")) {
    return errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" });
  }

  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant context required" });
  }

  const body = await c.req.json().catch(() => null);
  // Validate TYPE before any string op (batch-25 #4): a truthy non-string
  // (e.g. { issue: 42 }) reached body.issue.slice(...) and 500'd. Require
  // string day + issue, NUL-check, then normalize/truncate after validation.
  if (!body || typeof body.day !== "string" || !body.day.trim() || typeof body.issue !== "string" || !body.issue.trim()) {
    return errorJson(c, "invalid_request", { message: "Missing required fields: day, issue" });
  }
  if (hasNullByte(body.day) || hasNullByte(body.issue)) {
    return errorJson(c, "invalid_request", { message: "Fields day and issue must not contain null bytes" });
  }
  const day = body.day.normalize("NFC").trim();
  const issue = truncateCodePoints(body.issue.normalize("NFC").trim(), 4000);

  const spaceId = `tenant:${access.tenantId}`;

  const [entry] = await sql`
    INSERT INTO temporal_intake (target_day, content, status, space_id)
    VALUES (${day}, ${issue}, 'correction', ${spaceId})
    RETURNING id`;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    operation: "temporal_correction_queue",
    eventData: { day, entry_id: entry.id },
  });

  return c.json({ ok: true, queued: true, entry_id: entry.id });
});

// ============================================================
// GET /temporal/range
// ============================================================
temporal.get("/range", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant context required" });
  }

  const from = c.req.query("from"); // YYYY-MM-DD
  const to = c.req.query("to");     // YYYY-MM-DD
  if (!from || !to) {
    return errorJson(c, "invalid_request", { message: "Missing query params: from, to" });
  }

  const spaceId = `tenant:${access.tenantId}`;

  const [tenant] = await sql`
    SELECT metadata->'circle'->>'timezone' as tz
    FROM tenants WHERE tenant_id = ${access.tenantId}`;
  const tz = tenant?.tz || "America/Los_Angeles";

  const fromAddr = dayAddr(new Date(from + "T12:00:00"), tz);
  const toAddr = dayAddr(new Date(to + "T12:00:00"), tz);

  const days = await sql`
    SELECT n.addr, n.label, n.substance->>'summary' as summary,
      n.substance->>'energy' as energy, n.substance->>'day_affinity' as day_affinity,
      n.order_score,
      (SELECT COUNT(*) FROM edges e WHERE e.to_addr = n.addr AND e.edge_type = 'active_on') as edge_count
    FROM nodes n
    WHERE n.node_type = 'day' AND n.space_id = ${spaceId}
      AND n.addr >= ${fromAddr} AND n.addr <= ${toAddr}
      AND n.visibility <> 'deleted'
    ORDER BY n.addr`;

  return c.json({
    ok: true,
    from: fromAddr,
    to: toAddr,
    count: days.length,
    days,
  });
});

export default temporal;
