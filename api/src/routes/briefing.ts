/**
 * /briefing — Full graph briefing
 *
 * GET /briefing?since=ISO_TIMESTAMP&limit=10&domain=security
 * Returns a summary of stimulus activity, graph mutations, resonance shifts,
 * hot nodes, recent stimuli, conflicts, and supersessions.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { allowedRegistryAccessLevels, getAccessContext, visibleSpaceIds } from "../lib/access";
import { isSyntheticGraphMutation, isSyntheticStimulus, isSyntheticText } from "../lib/public-graph";
import { clampInt } from "../lib/utils";
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const briefing = new Hono();

briefing.get("/", async (c) => {
  const access = getAccessContext(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const sinceParam = c.req.query("since");
  const since = sinceParam ? new Date(sinceParam).toISOString() : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const limit = clampInt(c.req.query("limit"), 10, 1, 50);
  const domain = c.req.query("domain") || null;
  const accessLevels = allowedRegistryAccessLevels(c);

  // Parallel queries for summary stats
  const [hwRow] = await sql`SELECT heat_weight() as w`;
  const hw = parseFloat(hwRow.w);

  const [stimuliCount] = access.scope === "operator"
    ? await sql`
        SELECT COUNT(*) as n
        FROM stimuli
        WHERE created_at >= ${since}
      `
    : await sql`
        SELECT COUNT(*) as n
        FROM stimuli s
        LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE s.created_at >= ${since}
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            s.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              n.addr IS NOT NULL
              AND n.space_id = ${GLOBAL_SPACE_ID}
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
      `;

  const [heatedCount] = access.scope === "operator"
    ? await sql`
        SELECT COUNT(*) as n
        FROM nodes
        WHERE stimulus_heat > 0
          AND visibility <> 'deleted'
      `
    : await sql`
        SELECT COUNT(*) as n
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.stimulus_heat > 0
          AND n.visibility <> 'deleted'
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
      `;

  const [conflictsCount] = access.scope === "operator"
    ? await sql`SELECT COUNT(*) as n FROM stimulus_conflicts WHERE NOT resolved`
    : await sql`
        SELECT COUNT(*) as n
        FROM stimulus_conflicts sc
        JOIN nodes n ON n.addr = sc.node_addr
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE NOT sc.resolved
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
      `;

  const [supersessionsCount] = access.scope === "operator"
    ? await sql`SELECT COUNT(*) as n FROM supersession_candidates WHERE status = 'pending'`
    : await sql`
        SELECT COUNT(*) as n
        FROM supersession_candidates sc
        JOIN stimuli s ON s.id = sc.newer_stimulus_id
        LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE sc.status = 'pending'
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            s.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              n.addr IS NOT NULL
              AND n.space_id = ${GLOBAL_SPACE_ID}
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
      `;

  // Hot nodes — top by stimulus_heat, only nodes with heat > 0
  const hotNodes = await sql`
    SELECT
      n.addr,
      n.label,
      n.stimulus_heat,
      n.resonance,
      n.confidence,
      n.confidence_by_domain,
      ARRAY(
        SELECT DISTINCT s.source
        FROM stimulus_contributions sc
        JOIN stimuli s ON s.id = sc.stimulus_id
        WHERE sc.node_addr = n.addr AND sc.contribution > 0.001
      ) as heat_sources,
      (
        SELECT LEFT(s.content, 100)
        FROM stimulus_contributions sc
        JOIN stimuli s ON s.id = sc.stimulus_id
        WHERE sc.node_addr = n.addr AND sc.contribution > 0.001
        ORDER BY sc.contribution DESC
        LIMIT 1
      ) as top_stimulus_preview
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.stimulus_heat > 0
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
        `}
      AND (
        n.node_type IS DISTINCT FROM 'trend'
        OR COALESCE(n.source_context->'trend'->>'lifecycle', 'emerging') != 'emerging'
      )
    ORDER BY n.stimulus_heat DESC
    LIMIT ${limit}`;

  // Recent stimuli
  const recentStimuli = access.scope === "operator"
    ? await sql`
        SELECT
          s.id,
          s.source,
          s.stimulus_type as type,
          LEFT(s.content, 150) as content_preview,
          s.urgency,
          (SELECT COUNT(*) FROM stimulus_contributions sc WHERE sc.stimulus_id = s.id AND sc.contribution > 0.001) as nodes_matched,
          s.created_at
        FROM stimuli s
        WHERE s.created_at >= ${since}
          AND s.source != 'agent'
        ORDER BY s.created_at DESC
        LIMIT ${limit * 4}
      `
    : await sql`
        SELECT
          s.id,
          s.source,
          s.stimulus_type as type,
          LEFT(s.content, 150) as content_preview,
          s.urgency,
          (SELECT COUNT(*) FROM stimulus_contributions sc WHERE sc.stimulus_id = s.id AND sc.contribution > 0.001) as nodes_matched,
          s.created_at
        FROM stimuli s
        LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE s.created_at >= ${since}
          AND s.source != 'agent'
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            s.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              n.addr IS NOT NULL
              AND n.space_id = ${GLOBAL_SPACE_ID}
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
        ORDER BY s.created_at DESC
        LIMIT ${limit * 4}
      `;

  // Graph mutations (new section)
  const mutationCounts = access.scope === "operator"
    ? await sql`
        SELECT
          COALESCE(SUM(CASE WHEN mutation_type = 'node_create' THEN 1 ELSE 0 END), 0) as nodes_created,
          COALESCE(SUM(CASE WHEN mutation_type = 'node_update' THEN 1 ELSE 0 END), 0) as nodes_updated,
          COALESCE(SUM(CASE WHEN mutation_type = 'edge_create' THEN 1 ELSE 0 END), 0) as edges_created
        FROM graph_mutations
        WHERE created_at >= ${since}
          AND mutation_type IN ('node_create', 'node_update', 'edge_create')
      `
    : await sql`
        SELECT
          COALESCE(SUM(CASE WHEN gm.mutation_type = 'node_create' THEN 1 ELSE 0 END), 0) as nodes_created,
          COALESCE(SUM(CASE WHEN gm.mutation_type = 'node_update' THEN 1 ELSE 0 END), 0) as nodes_updated,
          COALESCE(SUM(CASE WHEN gm.mutation_type = 'edge_create' THEN 1 ELSE 0 END), 0) as edges_created
        FROM graph_mutations gm
        LEFT JOIN nodes n ON n.addr = gm.target_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE gm.created_at >= ${since}
          AND gm.space_id = ANY(${spaceIds}::text[])
          AND gm.mutation_type IN ('node_create', 'node_update', 'edge_create')
          AND (
            gm.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              position('→' in COALESCE(gm.target_addr, '')) = 0
              AND n.addr IS NOT NULL
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
      `;

  const recentMutations = access.scope === "operator"
    ? await sql`
        SELECT mutation_type as type, target_addr as addr, target_label as label,
               source, created_at as when
        FROM graph_mutations
        WHERE created_at >= ${since}
          AND mutation_type IN ('node_create', 'node_update', 'edge_create')
        ORDER BY created_at DESC
        LIMIT ${limit * 4}
      `
    : await sql`
        SELECT gm.mutation_type as type, gm.target_addr as addr, gm.target_label as label,
               gm.source, gm.created_at as when
        FROM graph_mutations gm
        LEFT JOIN nodes n ON n.addr = gm.target_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE gm.created_at >= ${since}
          AND gm.space_id = ANY(${spaceIds}::text[])
          AND gm.mutation_type IN ('node_create', 'node_update', 'edge_create')
          AND (
            gm.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              position('→' in COALESCE(gm.target_addr, '')) = 0
              AND n.addr IS NOT NULL
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
        ORDER BY gm.created_at DESC
        LIMIT ${limit * 4}
      `;

  // Resonance shifts (new section)
  const resonanceShifts = await sql`
    SELECT
      rc.node_addr as addr,
      n.label,
      rc.old_resonance,
      rc.new_resonance,
      rc.delta,
      rc.trigger_type as trigger
    FROM resonance_changelog rc
    JOIN nodes n ON n.addr = rc.node_addr
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE rc.computed_at >= ${since}
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
        `}
    ORDER BY ABS(rc.delta) DESC
    LIMIT ${limit}`;

  const mc = mutationCounts[0] || { nodes_created: 0, nodes_updated: 0, edges_created: 0 };

  const activeTrends = await sql`
    SELECT addr, label, stimulus_heat, source_context, substance
    FROM nodes
    WHERE node_type = 'trend'
      AND visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND space_id = ANY(${spaceIds}::text[])
          AND (
            space_id <> ${GLOBAL_SPACE_ID}
            OR visibility = 'public'
          )
        `}
      AND COALESCE(source_context->'trend'->>'lifecycle', 'emerging') IN ('active', 'sustained', 'cooling')
    ORDER BY stimulus_heat DESC, created_at DESC
    LIMIT ${limit}`;

  const emergingTrends = await sql`
    SELECT addr, label, source_context, substance
    FROM nodes
    WHERE node_type = 'trend'
      AND visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND space_id = ANY(${spaceIds}::text[])
          AND (
            space_id <> ${GLOBAL_SPACE_ID}
            OR visibility = 'public'
          )
        `}
      AND COALESCE(source_context->'trend'->>'lifecycle', 'emerging') = 'emerging'
    ORDER BY created_at DESC
    LIMIT ${limit}`;

  const deadTrends = await sql`
    SELECT original_addr, label, death_time, birth_time
    FROM trend_archive
    WHERE death_time >= ${since}
      ${access.scope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}
    ORDER BY death_time DESC
    LIMIT ${limit * 4}`;

  const filteredStimuli = recentStimuli
    .filter((row: any) => !isSyntheticStimulus(row))
    .slice(0, limit);
  const filteredMutations = recentMutations
    .filter((row: any) => !isSyntheticGraphMutation(row))
    .slice(0, limit);
  const filteredDeadTrends = deadTrends
    .filter((row: any) => !isSyntheticText(row.label))
    .slice(0, limit);

  return c.json({
    ok: true,
    period: { since, until: new Date().toISOString() },
    summary: {
      stimuli_processed: parseInt(stimuliCount.n),
      nodes_heated: parseInt(heatedCount.n),
      current_heat_weight: hw,
      conflicts_pending: parseInt(conflictsCount.n),
      supersessions_pending: parseInt(supersessionsCount.n),
    },
    graph_changes: {
      nodes_created: parseInt(mc.nodes_created),
      nodes_updated: parseInt(mc.nodes_updated),
      edges_created: parseInt(mc.edges_created),
      recent_changes: filteredMutations.map((m: any) => ({
        type: m.type,
        addr: m.addr,
        label: m.label,
        when: m.when,
        source: m.source,
      })),
    },
    resonance_shifts: resonanceShifts.map((r: any) => ({
      addr: r.addr,
      label: r.label,
      old_resonance: parseFloat(parseFloat(r.old_resonance).toFixed(3)),
      new_resonance: parseFloat(parseFloat(r.new_resonance).toFixed(3)),
      delta: parseFloat(parseFloat(r.delta).toFixed(3)),
      trigger: r.trigger,
    })),
    hot_nodes: hotNodes.map((n: any) => {
      const node: any = {
        addr: n.addr,
        label: n.label,
        stimulus_heat: parseFloat(parseFloat(n.stimulus_heat).toFixed(3)),
        live_resonance: parseFloat((parseFloat(n.resonance) + parseFloat(n.stimulus_heat) * hw).toFixed(3)),
        heat_sources: n.heat_sources,
        top_stimulus_preview: n.top_stimulus_preview,
      };
      if (domain) {
        const cbd = typeof n.confidence_by_domain === "string"
          ? JSON.parse(n.confidence_by_domain)
          : (n.confidence_by_domain || {});
        node.domain_confidence = cbd[domain] != null
          ? parseFloat(parseFloat(cbd[domain]).toFixed(3))
          : parseFloat(parseFloat(n.confidence).toFixed(3));
      }
      return node;
    }),
    recent_stimuli: filteredStimuli.map((s: any) => ({
      id: parseInt(s.id),
      source: s.source,
      type: s.type,
      content_preview: s.content_preview,
      urgency: parseFloat(parseFloat(s.urgency).toFixed(2)),
      nodes_matched: parseInt(s.nodes_matched),
      created_at: s.created_at,
    })),
    trends: {
      active: activeTrends.map((t: any) => {
        const trend = typeof t.source_context === "string" ? JSON.parse(t.source_context).trend : t.source_context?.trend;
        return {
          addr: t.addr,
          label: t.label,
          lifecycle: trend?.lifecycle || "active",
          heat: parseFloat(parseFloat(t.stimulus_heat).toFixed(3)),
          velocity: parseFloat(parseFloat(trend?.velocity || 0).toFixed(3)),
          source_diversity: parseInt(trend?.source_diversity || 0),
          description: t.substance?.description || null,
        };
      }),
      emerging_count: emergingTrends.length,
      recently_died: filteredDeadTrends.map((t: any) => ({
        addr: t.original_addr,
        label: t.label,
        death_time: t.death_time,
        lived_hours: Math.max(
          0,
          (new Date(t.death_time).getTime() - new Date(t.birth_time).getTime()) / 3_600_000,
        ),
      })),
    },
  });
});

export default briefing;
