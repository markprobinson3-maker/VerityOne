/**
 * /failures — Surface known failure patterns, anti-patterns, and error catalogues.
 *
 * VO's most unique content for AI agents: things that went wrong, why, and how to avoid them.
 * Browsable without needing to know which topic to query first.
 *
 * GET /failures                     — all failure patterns (compact, paginated)
 * GET /failures?domain=cron         — filter by domain
 * GET /failures?pyramid=FUNCTION    — filter by pyramid
 * GET /failures?q=deploy            — search within failures
 * GET /failures?limit=20&offset=0   — pagination
 */

import { Hono } from "hono";
import { sql } from "../db";
import { allowedRegistryAccessLevels, getAccessContext } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { clampInt } from "../lib/utils";

const failures = new Hono();

failures.get("/", async (c) => {
  const startMs = Date.now();
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);

  const domain = c.req.query("domain") || null;
  const pyramid = c.req.query("pyramid") || null;
  const q = (c.req.query("q") || "").replace(/\0/g, "");
  const limit = clampInt(c.req.query("limit"), 30, 1, 100);
  const offset = clampInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // Failure patterns live in two places:
  // 1. Nodes with failure_warnings in substance (from atom_feedback incidents)
  // 2. Heuristic nodes (they encode what NOT to do)
  // 3. Nodes with anti-pattern markers in substance

  // Build conditions
  const conditions: any[] = [];

  // Nodes with failure_patterns (stored in substance by ingest pipeline)
  const failureNodes = await sql`
    SELECT n.addr, n.label, n.pyramid_id, n.node_type, n.confidence, n.query_hits,
      n.substance->>'description' AS description,
      n.substance->'failure_patterns' AS failure_patterns,
      n.substance->'quick_start' AS quick_start,
      COALESCE(jsonb_array_length(n.substance->'failure_patterns'), 0) AS pattern_count
    FROM nodes n
    LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.visibility = 'public'
      AND n.substance ? 'failure_patterns'
      AND jsonb_typeof(n.substance->'failure_patterns') = 'array'
      AND jsonb_array_length(n.substance->'failure_patterns') > 0
      ${pyramid ? sql`AND n.pyramid_id = ${pyramid}` : sql``}
      ${q ? sql`AND (n.label ILIKE ${"%" + q + "%"} OR n.substance->>'description' ILIKE ${"%" + q + "%"})` : sql``}
      AND (
        n.space_id = ${GLOBAL_SPACE_ID}
        AND COALESCE(r.access_level, 'public') = ANY(${accessLevels}::text[])
      )
    ORDER BY COALESCE(jsonb_array_length(n.substance->'failure_patterns'), 0) DESC, n.query_hits DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const [totalRow] = await sql`
    SELECT count(*)::int AS cnt FROM nodes n
    LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.visibility = 'public'
      AND n.substance ? 'failure_patterns'
      AND jsonb_typeof(n.substance->'failure_patterns') = 'array'
      AND jsonb_array_length(n.substance->'failure_patterns') > 0
      ${pyramid ? sql`AND n.pyramid_id = ${pyramid}` : sql``}
      ${q ? sql`AND (n.label ILIKE ${"%" + q + "%"} OR n.substance->>'description' ILIKE ${"%" + q + "%"})` : sql``}
      AND (
        n.space_id = ${GLOBAL_SPACE_ID}
        AND COALESCE(r.access_level, 'public') = ANY(${accessLevels}::text[])
      )`;

  // Also get heuristic warnings (H-series that encode failure patterns)
  const heuristicWarnings = !offset ? await sql`
    SELECT addr, label, substance->>'heuristic_text' AS heuristic,
      substance->>'description' AS description,
      substance->'domains' AS domains
    FROM nodes
    WHERE pyramid_id = 'HEURISTIC' AND visibility = 'public'
      AND (substance->>'description' ILIKE '%fail%'
        OR substance->>'description' ILIKE '%error%'
        OR substance->>'description' ILIKE '%never%'
        OR substance->>'description' ILIKE '%avoid%'
        OR substance->>'description' ILIKE '%danger%'
        OR substance->>'description' ILIKE '%wrong%'
        OR substance->>'description' ILIKE '%bug%'
        OR substance->>'description' ILIKE '%mistake%')
      ${q ? sql`AND (label ILIKE ${"%" + q + "%"} OR substance->>'description' ILIKE ${"%" + q + "%"})` : sql``}
    ORDER BY query_hits DESC
    LIMIT 15` : [];

  // Get available pyramids for filtering (simpler than extracting domains from JSONB)
  const domains = await sql`
    SELECT n.pyramid_id AS domain, count(*)::int AS nodes
    FROM nodes n
    WHERE n.visibility = 'public' AND n.substance ? 'failure_warnings'
      AND jsonb_array_length(n.substance->'failure_warnings') > 0
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`;

  const items = failureNodes.map((n: any) => {
    const patterns = Array.isArray(n.failure_patterns) ? n.failure_patterns : [];
    return {
      addr: n.addr,
      label: n.label,
      pyramid_id: n.pyramid_id,
      confidence: parseFloat(n.confidence),
      pattern_count: patterns.length,
      failures: patterns.map((fp: any) => {
        if (typeof fp === "string") return fp.slice(0, 300);
        const text = fp.injection_text || fp.description || fp.pattern || JSON.stringify(fp);
        const cost = fp.cost ? ` [cost: ${fp.cost}]` : "";
        const incidents = fp.incidents ? ` [${fp.incidents} incident(s)]` : "";
        return `${text}${incidents}${cost}`.slice(0, 300);
      }),
      description: (n.description || "").slice(0, 200),
      quick_start: n.quick_start || null,
    };
  });

  return c.json({
    ok: true,
    total: totalRow.cnt,
    offset,
    limit,
    items,
    ...(heuristicWarnings.length > 0 ? {
      preventive_heuristics: heuristicWarnings.map((h: any) => ({
        addr: h.addr,
        label: h.label,
        heuristic: h.heuristic || h.description,
      })),
    } : {}),
    available_domains: domains.map((d: any) => ({ domain: d.domain, nodes: d.nodes })),
    ms: Date.now() - startMs,
  });
});

export default failures;
