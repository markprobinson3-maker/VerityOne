/**
 * /agenda — "What should I work on?"
 *
 * Returns priority items (hot + urgent nodes), trending nodes, and stale areas.
 * When ?agent= is provided, adds personalized recommendations.
 *
 * GET /agenda
 * GET /agenda?agent=agent-42
 * GET /agenda?agent=agent-42&capabilities=coding,security&limit=5
 */

import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, resolveAgentTenant, visibleSpaceIds } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { clampInt, splitQuery } from "../lib/utils";
import { compileRecall } from "../lib/recall-compiler";
import { LIFECYCLE_PROPOSAL_ACTIONS, MEMORY_MERGE_ACTION } from "../lib/supercron-ops";

const agenda = new Hono();

agenda.get("/", async (c) => {
  const agent = c.req.query("agent") || null;
  const capabilities = splitQuery(c.req.query("capabilities"));
  const limit = clampInt(c.req.query("limit"), 5, 1, 20);
  const access = getAccessContext(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const accessLevels = allowedRegistryAccessLevels(c);
  if (agent && !assertAgentSelfOrOperator(c, agent)) {
    return errorJson(c, "forbidden");
  }

  const startMs = Date.now();

  // Load agent profile if requested (non-blocking for main queries)
  let agentProfile: any = null;
  if (agent) {
    const [row] = await sql`SELECT * FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, agent)} AND agent_id = ${agent}`;
    agentProfile = row || null;
  }

  // --- PRIORITY ITEMS: high heat + high urgency from recent stimuli ---
  const priorityRows = await sql`
    SELECT n.addr, n.label, n.stimulus_heat, n.node_type,
      n.confidence_by_domain,
      MAX(s.urgency) as max_urgency,
      COUNT(DISTINCT s.id) as stimulus_count,
      array_agg(DISTINCT s.source) as sources,
      MIN(s.content) as sample_content,
      n.substance->'quick_start' as quick_start
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    JOIN stimulus_contributions sc ON sc.node_addr = n.addr AND sc.base_contribution > 0.001
    JOIN stimuli s ON s.id = sc.stimulus_id AND s.created_at > now() - interval '24 hours'
    WHERE n.stimulus_heat > 0.02
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
        `}
      AND (
        n.node_type IS DISTINCT FROM 'trend'
        OR COALESCE(n.source_context->'trend'->>'lifecycle', 'emerging') != 'emerging'
      )
    GROUP BY n.addr, n.label, n.stimulus_heat, n.node_type,
      n.confidence_by_domain, n.substance
    ORDER BY n.stimulus_heat * MAX(s.urgency) DESC
    LIMIT ${limit * 2}`;

  // If agent has domain_affinity, boost matching items
  let priorityItems = priorityRows.map((r: any) => {
    let urgency = parseFloat(r.stimulus_heat) * parseFloat(r.max_urgency);

    // Agent domain boost
    if (agentProfile?.domain_affinity && Object.keys(agentProfile.domain_affinity).length > 0) {
      const nodeType = r.node_type || "general";
      const agentAff = agentProfile.domain_affinity[nodeType];
      if (agentAff && agentAff > 0.1) {
        urgency *= 1.5;
      }
    }

    const sources = (r.sources || []).filter(Boolean);
    const sourceStr = sources.length > 0 ? sources.join(", ") : "stimuli";
    const count = parseInt(r.stimulus_count);

    return {
      urgency: parseFloat(urgency.toFixed(3)),
      title: r.label,
      reason: `${count} ${count === 1 ? "stimulus" : "stimuli"} from ${sourceStr} in last 24h`,
      action: r.quick_start
        ? `Run: ${typeof r.quick_start === "object" && r.quick_start.command ? r.quick_start.command : "See quick_start"}`
        : `Investigate ${r.label}`,
      nodes: [r.addr],
      quick_start: `curl -s 'http://localhost:3100/context?q=${encodeURIComponent(r.label)}&depth=deep'`,
    };
  });

  // Sort by urgency after boost, take limit
  priorityItems.sort((a: any, b: any) => b.urgency - a.urgency);
  priorityItems = priorityItems.slice(0, limit);

  // --- TRENDING: nodes with rising heat (most recent stimuli) ---
  const trendingRows = await sql`
    SELECT n.addr, n.label, n.stimulus_heat,
      COUNT(DISTINCT sc.stimulus_id) as recent_stimuli
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    JOIN stimulus_contributions sc ON sc.node_addr = n.addr
      AND sc.created_at > now() - interval '12 hours'
      AND sc.base_contribution > 0.001
    WHERE n.stimulus_heat > 0.01
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
    GROUP BY n.addr, n.label, n.stimulus_heat
    ORDER BY COUNT(DISTINCT sc.stimulus_id) DESC, n.stimulus_heat DESC
    LIMIT ${limit}`;

  const trending = trendingRows.map((r: any) => ({
    addr: r.addr,
    label: r.label,
    heat: parseFloat(parseFloat(r.stimulus_heat).toFixed(4)),
    heat_trend: "rising",
    why: `${r.recent_stimuli} stimuli in last 12h`,
  }));

  // --- STALE AREAS: old, low-confidence nodes ---
  const staleRows = await sql`
    SELECT n.addr, n.label, n.confidence, n.updated_at,
      EXTRACT(DAY FROM now() - n.updated_at)::int as days_stale
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.updated_at < now() - interval '30 days'
      AND n.confidence < 0.6
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
    ORDER BY n.confidence ASC, n.updated_at ASC
    LIMIT ${limit}`;

  const staleAreas = staleRows.map((r: any) => ({
    addr: r.addr,
    label: r.label,
    days_since_update: r.days_stale,
    confidence: parseFloat(parseFloat(r.confidence).toFixed(3)),
    suggestion: `This node hasn't been validated in ${r.days_stale} days`,
  }));

  const trendRows = await sql`
    SELECT n.addr, n.label, n.stimulus_heat, n.source_context, n.substance
    FROM nodes n
    LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.node_type = 'trend'
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND COALESCE(r.access_level, 'public') = ANY(${accessLevels}::text[]))
          )
        `}
      AND COALESCE(n.source_context->'trend'->>'lifecycle', 'emerging') IN ('active', 'sustained', 'cooling')
    ORDER BY n.stimulus_heat DESC, n.created_at DESC
    LIMIT ${limit}`;

  const trend_items = trendRows.map((r: any) => {
    const trend = typeof r.source_context === "string" ? JSON.parse(r.source_context).trend : r.source_context?.trend;
    return {
      addr: r.addr,
      label: r.label,
      lifecycle: trend?.lifecycle || "active",
      heat: parseFloat(parseFloat(r.stimulus_heat).toFixed(4)),
      velocity: parseFloat(parseFloat(trend?.velocity || 0).toFixed(3)),
      source_diversity: parseInt(trend?.source_diversity || 0),
      why: r.substance?.description || null,
    };
  });

  // --- PERSONALIZED: only when agent= provided ---
  let personalized: any = undefined;
  if (agent) {
    let changesSinceLastVisit = 0;
    if (agentProfile) {
      const [changes] = access.scope === "operator"
        ? await sql`
            SELECT COUNT(*)::int as n
            FROM resonance_changelog
            WHERE computed_at > ${agentProfile.last_seen}
          `
        : await sql`
            SELECT COUNT(*)::int as n
            FROM resonance_changelog rc
            JOIN nodes n ON n.addr = rc.node_addr
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE rc.computed_at > ${agentProfile.last_seen}
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          `;
      changesSinceLastVisit = changes.n;
    }

    // Build recommendation from domain affinity + priority items
    let recommendation = "No specific recommendation — explore priority items above";
    if (agentProfile?.domain_affinity && Object.keys(agentProfile.domain_affinity).length > 0) {
      const topDomain = Object.entries(agentProfile.domain_affinity as Record<string, number>)
        .sort((a, b) => b[1] - a[1])[0];
      if (topDomain && priorityItems.length > 0) {
        recommendation = `Based on your ${topDomain[0]} focus, prioritize: ${priorityItems[0].title}`;
      }
    }

    personalized = {
      agent_id: agent,
      your_domains: agentProfile?.domain_affinity || {},
      changes_since_last_visit: changesSinceLastVisit,
      recommendation,
    };

    // Touch agent (fire-and-forget)
    sql`SELECT touch_agent(${resolveAgentTenant(c, agent)}, ${agent})`.catch(() => {});
  }

  // --- TENANT-ONLY SECTIONS: recent decisions, session followups, unresolved tensions ---
  let recentDecisions: any[] = [];
  let sessionFollowups: any[] = [];
  let unresolvedTensions: any[] = [];

  if (access.tenantId) {
    const tenantSpace = `tenant:${access.tenantId}`;

    const [decisionRecall, changelogRecall] = await Promise.all([
      compileRecall(sql, {
        query: "recent decisions corrections preferences",
        tenantId: access.tenantId,
        spaceId: tenantSpace,
        agentId: agent || access.agentId,
        kinds: ["decision", "correction", "preference"],
        limit: 5,
        suppressExposureEvent: true,
        suppressTelemetry: true,
      }).catch(() => null),
      compileRecall(sql, {
        query: "recent changelog session activity",
        tenantId: access.tenantId,
        spaceId: tenantSpace,
        agentId: agent || access.agentId,
        kinds: ["changelog"],
        limit: 5,
        suppressExposureEvent: true,
        suppressTelemetry: true,
      }).catch(() => null),
    ]);

    const decisionMemories = decisionRecall
      ? decisionRecall.primary_memories.concat(decisionRecall.supporting_memories).slice(0, 5)
      : [];
    if (decisionMemories.length > 0) {
      recentDecisions = decisionMemories.map((m) => ({
        addr: m.addr,
        label: m.label,
        memory_type: m.kind,
        description: m.assertion.slice(0, 200),
        created_at: m.created_at,
      }));
    } else {
      if (decisionRecall?.error_recovered) {
        console.warn("[agenda/recent-decisions] recall degraded, using SQL fallback:", decisionRecall.recovery_reason);
      }
      const decisionRows = await sql`
        SELECT addr, label,
          substance->>'memory_type' as memory_type,
          substring(substance->>'description' from 1 for 200) as description_preview,
          created_at
        FROM nodes
        WHERE space_id = ${tenantSpace}
          AND node_type = 'memory'
          AND visibility <> 'deleted'
          AND substance->>'memory_type' IN ('correction', 'decision')
          AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC
        LIMIT 5
      `;
      recentDecisions = decisionRows.map((r: any) => ({
        addr: r.addr,
        label: r.label,
        memory_type: r.memory_type,
        description: r.description_preview,
        created_at: r.created_at,
      }));
    }

    const changelogMemories = changelogRecall
      ? changelogRecall.primary_memories.concat(changelogRecall.supporting_memories).slice(0, 5)
      : [];
    if (changelogMemories.length > 0) {
      sessionFollowups = changelogMemories.map((m) => ({
        addr: m.addr,
        label: m.label,
        description: m.assertion.slice(0, 200),
        created_at: m.created_at,
      }));
    } else {
      if (changelogRecall?.error_recovered) {
        console.warn("[agenda/session-followups] recall degraded, using SQL fallback:", changelogRecall.recovery_reason);
      }
      const followupRows = await sql`
        SELECT addr, label,
          substring(substance->>'description' from 1 for 200) as description_preview,
          created_at
        FROM nodes
        WHERE space_id = ${tenantSpace}
          AND node_type = 'memory'
          AND visibility <> 'deleted'
          AND substance->>'memory_type' = 'changelog'
          AND created_at > now() - interval '48 hours'
        ORDER BY created_at DESC
        LIMIT 5
      `;
      sessionFollowups = followupRows.map((r: any) => ({
        addr: r.addr,
        label: r.label,
        description: r.description_preview,
        created_at: r.created_at,
      }));
    }

    // Unresolved tensions (high tension, not yet resolved)
    const tensionRows = await (access.scope === "operator"
      ? sql`
          SELECT et.from_addr, et.to_addr, et.tension, et.evidence,
            n1.label as from_label, n2.label as to_label,
            et.created_at
          FROM edge_tensions et
          JOIN nodes n1 ON n1.addr = et.from_addr
          JOIN nodes n2 ON n2.addr = et.to_addr
          WHERE et.resolved_at IS NULL
            AND n1.visibility <> 'deleted'
            AND n2.visibility <> 'deleted'
            AND et.tension > 0.5
          ORDER BY et.tension DESC
          LIMIT 5
        `
      : sql`
          SELECT et.from_addr, et.to_addr, et.tension, et.evidence,
            n1.label as from_label, n2.label as to_label,
            et.created_at
          FROM edge_tensions et
          JOIN nodes n1 ON n1.addr = et.from_addr
          JOIN registry r1 ON r1.pyramid_id = n1.pyramid_id
          JOIN nodes n2 ON n2.addr = et.to_addr
          JOIN registry r2 ON r2.pyramid_id = n2.pyramid_id
          WHERE et.resolved_at IS NULL
            AND n1.space_id = ANY(${spaceIds}::text[])
            AND n2.space_id = ANY(${spaceIds}::text[])
            AND n1.visibility <> 'deleted'
            AND n2.visibility <> 'deleted'
            AND (
              n1.space_id <> ${GLOBAL_SPACE_ID}
              OR (n1.visibility = 'public' AND r1.access_level = ANY(${accessLevels}::text[]))
            )
            AND (
              n2.space_id <> ${GLOBAL_SPACE_ID}
              OR (n2.visibility = 'public' AND r2.access_level = ANY(${accessLevels}::text[]))
            )
            AND et.tension > 0.5
          ORDER BY et.tension DESC
          LIMIT 5
        `
    ).catch(() => [] as any[]);
    unresolvedTensions = tensionRows.map((r: any) => ({
      from: { addr: r.from_addr, label: r.from_label },
      to: { addr: r.to_addr, label: r.to_label },
      tension: parseFloat(parseFloat(r.tension).toFixed(3)),
      evidence: r.evidence,
      created_at: r.created_at,
    }));
  }

  // --- MAINTENANCE SIGNALS: actionable graph health items for agents ---
  const maintenanceItems: any[] = [];

  // Pending proposals awaiting review
  const [pendingProposals] = await sql`
    SELECT count(*)::int AS cnt FROM proposals WHERE status = 'pending'`;
  if (pendingProposals.cnt > 10) {
    maintenanceItems.push({
      type: "pending_proposals",
      count: pendingProposals.cnt,
      action: "Review pending proposals",
      quick_start: "bun run miners/src/verity-ingest.ts --review --quick",
    });
  }

  if (access.scope === "operator") {
    // SuperCron operator review queues. These are review/accounting signals,
    // not instructions to trigger another mutating cycle.
    const [supercronReview] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM supercron_runs WHERE status = 'degraded' AND started_at > now() - interval '24 hours') AS degraded_runs_24h,
        (SELECT COUNT(*)::int FROM supercron_runs WHERE status IN ('error', 'timeout') AND started_at > now() - interval '24 hours') AS failed_runs_24h,
        (
          SELECT COUNT(*)::int
          FROM proposals
          WHERE status = 'pending'
            AND payload->>'action' = ANY(${LIFECYCLE_PROPOSAL_ACTIONS}::text[])
        ) AS pending_lifecycle_proposals,
        (
          SELECT COUNT(*)::int
          FROM proposals
          WHERE status = 'approved'
            AND payload->>'action' = ${MEMORY_MERGE_ACTION}
        ) AS approved_memory_merge_hold_queue,
        (
          SELECT COUNT(*)::int
          FROM edges
          WHERE btrim(COALESCE(provenance->>'discovered_by', '')) = ''
        ) AS edge_provenance_debt
    `;
    if (parseInt(supercronReview.degraded_runs_24h || 0) > 0) {
      maintenanceItems.push({
        type: "supercron_degraded_runs",
        count: parseInt(supercronReview.degraded_runs_24h || 0),
        action: "Inspect recent SuperCron quality_report warnings",
        quick_start: "bun run miners/src/supercron.ts --stats",
      });
    }
    if (parseInt(supercronReview.failed_runs_24h || 0) > 0) {
      maintenanceItems.push({
        type: "supercron_failed_runs",
        count: parseInt(supercronReview.failed_runs_24h || 0),
        severity: "critical",
        action: "Stop scheduling and inspect SuperCron logs before running another mutating cycle",
        quick_start: "bun run miners/src/supercron.ts --stats",
      });
    }
    if (parseInt(supercronReview.pending_lifecycle_proposals || 0) > 0) {
      maintenanceItems.push({
        type: "lifecycle_proposal_backlog",
        count: parseInt(supercronReview.pending_lifecycle_proposals || 0),
        action: "Review pending tenant memory supersession and memory merge proposals",
        quick_start: "curl -s -H \"Authorization: Bearer $OPERATOR_TOKEN\" http://localhost:3100/proposals/pending",
      });
    }
    if (parseInt(supercronReview.approved_memory_merge_hold_queue || 0) > 0) {
      maintenanceItems.push({
        type: "memory_merge_hold_queue",
        count: parseInt(supercronReview.approved_memory_merge_hold_queue || 0),
        action: "Apply approved memory_merge proposals manually using the runbook checks, or leave held until the atomic applier lands",
        quick_start: "psql -X \"${PSQL_TARGET:-$DATABASE_URL}\" -c \"SELECT id, proposal_type, status, payload->>'action' AS action, from_addr, to_addr, confidence, created_at FROM proposals WHERE status = 'approved' AND payload->>'action' = 'memory_merge' ORDER BY created_at DESC LIMIT 50;\"",
      });
    }
    if (parseInt(supercronReview.edge_provenance_debt || 0) > 0) {
      maintenanceItems.push({
        type: "edge_provenance_debt",
        count: parseInt(supercronReview.edge_provenance_debt || 0),
        action: "Inspect sample edges missing provenance.discovered_by and trace the writer that bypassed provenance stamps",
        quick_start: "psql -X \"${PSQL_TARGET:-$DATABASE_URL}\" -c \"SELECT id, from_addr, to_addr, edge_type, provenance, created_at FROM edges WHERE btrim(COALESCE(provenance->>'discovered_by', '')) = '' ORDER BY created_at DESC LIMIT 50;\"",
      });
    }
  }

  // Pending supersessions
  const [pendingSupersessions] = await sql`
    SELECT count(*)::int AS cnt FROM supersession_candidates WHERE status = 'pending'`;
  if (pendingSupersessions.cnt > 50) {
    maintenanceItems.push({
      type: "supersession_backlog",
      count: pendingSupersessions.cnt,
      action: "Resolve supersession candidates",
      quick_start: "bun run miners/src/supercron.ts --tier 2 --pyramid CROSS",
    });
  }

  // Unembedded nodes (invisible to semantic search)
  const [unembedded] = await sql`
    SELECT count(*)::int AS cnt FROM nodes WHERE visibility = 'public' AND embedding_hv IS NULL`;
  if (unembedded.cnt > 0) {
    maintenanceItems.push({
      type: "unembedded_nodes",
      count: unembedded.cnt,
      action: "Nodes invisible to semantic search — need embedding",
      quick_start: "bun run scripts/embed-new-heuristics.ts",
    });
  }

  // Orphan nodes with query hits (valuable but disconnected)
  const orphanValuable = await sql`
    SELECT n.addr, n.label, n.query_hits FROM nodes n
    LEFT JOIN edges e ON e.from_addr = n.addr OR e.to_addr = n.addr
    WHERE n.visibility = 'public' AND n.layer > 0 AND e.id IS NULL AND n.query_hits > 0
    ORDER BY n.query_hits DESC LIMIT 3`;
  for (const o of orphanValuable) {
    maintenanceItems.push({
      type: "valuable_orphan",
      addr: o.addr,
      label: o.label,
      query_hits: o.query_hits,
      action: `Wire ${o.addr} to related nodes — it has ${o.query_hits} query hits but no edges`,
    });
  }

  const result: any = {
    ok: true,
    generated_at: new Date().toISOString(),
    priority_items: priorityItems,
    trending,
    trend_items,
    stale_areas: staleAreas,
    ...(maintenanceItems.length > 0 ? { maintenance_signals: maintenanceItems } : {}),
  };

  if (personalized) {
    result.personalized = personalized;
  }

  // Include tenant sections only when authenticated
  if (access.tenantId) {
    if (recentDecisions.length > 0) result.recent_decisions = recentDecisions;
    if (sessionFollowups.length > 0) result.session_followups = sessionFollowups;
    if (unresolvedTensions.length > 0) result.unresolved_tensions = unresolvedTensions;
  }

  result.ms = Date.now() - startMs;
  return c.json(result);
});

export default agenda;
