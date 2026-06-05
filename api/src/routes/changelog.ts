/**
 * /changelog — Graph Changelog Digest
 *
 * Returns typed change list from node_history + graph_mutations + edge_tensions.
 * Agents can poll this to understand what changed since their last check.
 *
 * GET /changelog?since=2024-01-01T00:00:00Z&limit=50
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext, visibleSpaceIds } from "../lib/access";
import { clampInt } from "../lib/utils";

const changelog = new Hono();

interface ChangeEntry {
  type: "node_update" | "mutation" | "tension_discovered" | "tension_resolved";
  timestamp: string;
  target: string;
  label?: string;
  detail: string;
}

changelog.get("/", async (c) => {
  const access = getAccessContext(c);
  const spaceIds = visibleSpaceIds(access);
  const sinceParam = c.req.query("since");
  const limit = clampInt(c.req.query("limit"), 50, 1, 200);

  // Default to last 24 hours if no since provided
  const since = sinceParam || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const startMs = Date.now();
  const changes: ChangeEntry[] = [];

  // 1. Node history (field-level changes)
  const nodeChanges = await sql`
    SELECT nh.addr, nh.field, nh.old_value, nh.new_value, nh.changed_by, nh.reason, nh.created_at,
      n.label
    FROM node_history nh
    JOIN nodes n ON n.addr = nh.addr
    WHERE nh.created_at >= ${since}::timestamptz
      AND n.visibility <> 'deleted'
      ${access.scope === "operator" ? sql`` : sql`AND n.space_id = ANY(${spaceIds}::text[])`}
    ORDER BY nh.created_at DESC
    LIMIT ${limit}`;

  for (const ch of nodeChanges) {
    changes.push({
      type: "node_update",
      timestamp: ch.created_at,
      target: ch.addr,
      label: ch.label,
      detail: `${ch.field} changed${ch.changed_by ? ` by ${ch.changed_by}` : ""}${ch.reason ? `: ${ch.reason}` : ""}`,
    });
  }

  // 2. Graph mutations (structural changes)
  const mutations = await sql`
    SELECT mutation_type, target_addr, target_label, source, created_at
    FROM graph_mutations
    WHERE created_at >= ${since}::timestamptz
      ${access.scope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}
    ORDER BY created_at DESC
    LIMIT ${limit}`;

  for (const m of mutations) {
    changes.push({
      type: "mutation",
      timestamp: m.created_at,
      target: m.target_addr,
      label: m.target_label,
      detail: `${m.mutation_type}${m.source ? ` via ${m.source}` : ""}`,
    });
  }

  // 3. New/resolved tensions
  const newTensions = await sql`
    SELECT et.from_addr, et.to_addr, et.tension_type, et.tension, et.created_at
    FROM edge_tensions et
    JOIN nodes n1 ON n1.addr = et.from_addr
    JOIN nodes n2 ON n2.addr = et.to_addr
    WHERE et.created_at >= ${since}::timestamptz AND et.resolved_at IS NULL
      AND n1.visibility <> 'deleted'
      AND n2.visibility <> 'deleted'
      ${access.scope === "operator" ? sql`` : sql`AND n1.space_id = ANY(${spaceIds}::text[]) AND n2.space_id = ANY(${spaceIds}::text[])`}
    ORDER BY et.created_at DESC
    LIMIT ${limit}`;

  for (const t of newTensions) {
    changes.push({
      type: "tension_discovered",
      timestamp: t.created_at,
      target: `${t.from_addr} ↔ ${t.to_addr}`,
      detail: `${t.tension_type} tension (${parseFloat(t.tension).toFixed(2)})`,
    });
  }

  const resolvedTensions = await sql`
    SELECT et.from_addr, et.to_addr, et.tension_type, et.resolved_at
    FROM edge_tensions et
    JOIN nodes n1 ON n1.addr = et.from_addr
    JOIN nodes n2 ON n2.addr = et.to_addr
    WHERE et.resolved_at >= ${since}::timestamptz
      AND n1.visibility <> 'deleted'
      AND n2.visibility <> 'deleted'
      ${access.scope === "operator" ? sql`` : sql`AND n1.space_id = ANY(${spaceIds}::text[]) AND n2.space_id = ANY(${spaceIds}::text[])`}
    ORDER BY et.resolved_at DESC
    LIMIT ${limit}`;

  for (const t of resolvedTensions) {
    changes.push({
      type: "tension_resolved",
      timestamp: t.resolved_at,
      target: `${t.from_addr} ↔ ${t.to_addr}`,
      detail: `${t.tension_type} tension resolved`,
    });
  }

  // Sort all changes by timestamp descending, apply limit
  changes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const trimmed = changes.slice(0, limit);

  // Build summary string
  const nodeUpdates = trimmed.filter(c => c.type === "node_update").length;
  const mutationCount = trimmed.filter(c => c.type === "mutation").length;
  const tensionCount = trimmed.filter(c => c.type === "tension_discovered" || c.type === "tension_resolved").length;
  const summary = `${trimmed.length} changes since ${since}: ${nodeUpdates} node updates, ${mutationCount} mutations, ${tensionCount} tension events`;

  return c.json({
    ok: true,
    since,
    total: trimmed.length,
    summary,
    changes: trimmed,
    ms: Date.now() - startMs,
  });
});

export default changelog;
