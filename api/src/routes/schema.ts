/**
 * /schema — Self-describing ontology for AI agents
 * 
 * Returns everything an agent needs to understand the graph:
 * node types, edge types, property meanings, confidence semantics,
 * access boundaries, and example queries with expected output shapes.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { allowedRegistryAccessLevels, getAccessContext, visibleSpaceIds } from "../lib/access";
import { canonicalizeEdgeType } from "../lib/graph-shape";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { ARCHIVED_PYRAMIDS } from "../lib/visible-graph";

const schema = new Hono();

schema.get("/", async (c) => {
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  // Live stats
  const [counts] = access.scope === "operator"
    ? await sql`
        SELECT
          (SELECT COUNT(*) FROM nodes WHERE visibility='public') AS public_nodes,
          (SELECT COUNT(*) FROM nodes WHERE visibility='private') AS private_nodes,
          (
            SELECT COUNT(*)
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN nodes nt ON nt.addr = e.to_addr
            WHERE nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
          ) AS total_edges,
          (
            SELECT COUNT(DISTINCT node_type)
            FROM nodes
            WHERE node_type IS NOT NULL
              AND visibility <> 'deleted'
          ) AS node_type_count,
          (
            SELECT COUNT(DISTINCT e.edge_type)
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN nodes nt ON nt.addr = e.to_addr
            WHERE nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
          ) AS edge_type_count
      `
    : await sql`
        SELECT
          (
            SELECT COUNT(*)
            FROM nodes n
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE n.space_id = ANY(${spaceIds}::text[])
              AND n.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND n.visibility <> 'deleted'
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility='public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS public_nodes,
          (
            SELECT COUNT(*)
            FROM nodes n
            WHERE n.space_id = ANY(${spaceIds}::text[])
              AND n.space_id <> ${GLOBAL_SPACE_ID}
              AND n.visibility='private'
          ) AS private_nodes,
          (
            SELECT COUNT(*)
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = e.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE e.space_id = ANY(${spaceIds}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND nf.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND nt.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS total_edges,
          (
            SELECT COUNT(DISTINCT n.node_type)
            FROM nodes n
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE n.node_type IS NOT NULL
              AND n.space_id = ANY(${spaceIds}::text[])
              AND n.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND n.visibility <> 'deleted'
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility='public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS node_type_count,
          (
            SELECT COUNT(DISTINCT e.edge_type)
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = e.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE e.space_id = ANY(${spaceIds}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND nf.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND nt.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS edge_type_count
      `;

  // Live edge type distribution
  const edgeTypesRaw = access.scope === "operator"
    ? await sql`
        SELECT e.edge_type, COUNT(*) AS count,
          ROUND(AVG(e.confidence)::numeric, 2) AS avg_confidence
        FROM edges e
        JOIN nodes nf ON nf.addr = e.from_addr
        JOIN nodes nt ON nt.addr = e.to_addr
        WHERE nf.visibility <> 'deleted'
          AND nt.visibility <> 'deleted'
        GROUP BY e.edge_type ORDER BY count DESC
      `
    : await sql`
        SELECT e.edge_type, COUNT(*) AS count,
          ROUND(AVG(e.confidence)::numeric, 2) AS avg_confidence
        FROM edges e
        JOIN nodes nf ON nf.addr = e.from_addr
        JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
        JOIN nodes nt ON nt.addr = e.to_addr
        JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
        WHERE e.space_id = ANY(${spaceIds}::text[])
          AND nf.space_id = ANY(${spaceIds}::text[])
          AND nt.space_id = ANY(${spaceIds}::text[])
          AND nf.visibility <> 'deleted'
          AND nt.visibility <> 'deleted'
          AND (
            nf.space_id <> ${GLOBAL_SPACE_ID}
            OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
          )
          AND (
            nt.space_id <> ${GLOBAL_SPACE_ID}
            OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
          )
        GROUP BY e.edge_type
        ORDER BY count DESC
      `;
  const edgeTypeMap = new Map<string, { edge_type: string; count: number; avg_confidence_sum: number }>();
  for (const row of edgeTypesRaw as any[]) {
    const canonical = canonicalizeEdgeType(row.edge_type) || row.edge_type;
    const current = edgeTypeMap.get(canonical);
    if (current) {
      current.count += parseInt(row.count);
      current.avg_confidence_sum += parseFloat(row.avg_confidence) * parseInt(row.count);
    } else {
      edgeTypeMap.set(canonical, {
        edge_type: canonical,
        count: parseInt(row.count),
        avg_confidence_sum: parseFloat(row.avg_confidence) * parseInt(row.count),
      });
    }
  }
  const edgeTypes = [...edgeTypeMap.values()]
    .map((row) => ({
      edge_type: row.edge_type,
      count: row.count,
      avg_confidence: Number((row.avg_confidence_sum / Math.max(row.count, 1)).toFixed(2)),
    }))
    .sort((a, b) => b.count - a.count);

  // Live node type distribution
  const nodeTypes = await sql`
    SELECT n.node_type, COUNT(*) AS count,
      ROUND(AVG(n.confidence)::numeric, 2) AS avg_confidence
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.node_type IS NOT NULL
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility='public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
        `}
    GROUP BY n.node_type ORDER BY count DESC
  `;

  return c.json({
    name: "Verity One Ontology",
    version: "2.1",
    description: "AI-first knowledge graph. Nodes are facts, edges are relationships. Everything is searchable by semantic similarity or keyword.",

    node_types: {
      summary: nodeTypes,
      definitions: {
        tool: "External integration or CLI tool (noun). Has quick_start with actual commands, readiness checks, and cost tier.",
        skill: "Operational pattern or procedure (verb). Documents how to do something, often referencing tools.",
        workflow: "Multi-step composition of tools and skills. Has ordered steps with dependencies.",
        concept: "Architecture pattern, principle, or reference document. Not directly executable.",
        "anti-pattern": "Known failure mode with documented fix. Exists to prevent repeat mistakes.",
        structure: "Organizational node (pyramid root, category). Rarely useful to query directly.",
      },
    },

    edge_types: {
      summary: edgeTypes,
      definitions: {
        uses: "A depends on B at runtime (e.g., service A uses an SMS provider)",
        requires: "A cannot function without B (stronger than uses)",
        provides: "A offers capability B",
        extends: "A adds functionality to B",
        alternative_to: "A and B solve the same problem differently",
        conflicts_with: "A and B cannot coexist (port conflicts, platform exclusions)",
        child_of: "A is a sub-concept of B (hierarchy)",
        related_to: "A and B are related but not dependent",
        documents: "A is documentation for B",
        implements: "A is a concrete implementation of concept B",
        evolved_from: "A replaced or superseded B",
        cross_pyramid: "Connects nodes across different knowledge pyramids",
        composes: "A includes B as a step in a workflow",
        feeds_into: "Output of A is input to B",
        validated_by: "A's correctness is checked by B",
      },
    },

    properties: {
      confidence: {
        range: "0.0 to 0.99",
        meaning: "How reliable this fact is. 0.50 = new/unverified, 0.70 = single agent max, 0.90 = multi-agent verified, 0.95+ = human confirmed. Decays over time if not re-validated.",
        floor: 0.05,
        caps: { single_agent: 0.70, multi_agent: 0.90, human: 0.99 },
      },
      resonance: {
        range: "0.0 to 1.0",
        meaning: "How important this node is to the overall graph. Computed from 8 weighted factors: connectivity, bridge_score, usage_signal, confidence, layer_depth, source_backing, subtree_richness, recency.",
      },
      layer: {
        values: { 0: "L0 — Raw facts (tools, configs, commands)", 1: "L1 — Relationships and patterns", 2: "L2 — Emergent meaning and principles" },
      },
      visibility: {
        values: { public: "Accessible to all agents", private: "Hidden from search results (deprecated nodes, internal structure)" },
        note: "Visibility is orthogonal to space ownership. Public/shared routes only traverse the global space; tenant overlays stay private unless explicitly exposed.",
      },
      cost: {
        values: { free: "No cost", "free-tier": "Free with limits", "paid-per-use": "Pay per API call", subscription: "Monthly fee required" },
        rule: "When in doubt, classified UP (e.g., free-tier not free)",
      },
    },

    pyramids: {
      WORLD: { access: "public", description: "Grounding knowledge about reality, science, institutions, and the human world." },
      FUNCTION: { access: "public", description: "The primary actionable layer: methods, tools, workflows, constraints, and execution pathways. Includes former OPENCLAW, CLAUDECODE, and CODEX content." },
      META: { access: "shared", description: "System principles, ontology, runtime, and architecture of the pyramid system itself." },
      PROJECTS: { access: "private", description: "Tenant-owned project overlays. These remain private to their owner while linking into the public WORLD/FUNCTION graph." },
    },

    spaces: {
      global: "Shared Verity truth layer. Public and shared knowledge lives here.",
      tenant_overlay: "Private user-owned overlay space. Personal projects and vaults can link to the global graph without becoming part of the public ontology.",
    },

    query_guide: {
      "find tools for a task": {
        endpoint: "GET /context?q=<natural language task>&depth=deep&pyramids=FUNCTION",
        returns: "Ranked nodes with relevance score, description, provides[], quick_start{}, cost",
        example: "/context?q=send+sms+notification&depth=deep&pyramids=FUNCTION",
      },
      "check if a tool is ready": {
        endpoint: "GET /check/<addr>",
        returns: "Authenticated readiness status. Beta users get static guidance; operators get live checks.",
        example: "/check/OC.0.2.49",
      },
      "explore connections": {
        endpoint: "GET /traverse?from=<addr>&hops=2",
        returns: "All nodes within N hops, with edge types and labels",
        example: "/traverse?from=OC.0.2.58&hops=2",
      },
      "get full node detail": {
        endpoint: "GET /nodes/<addr>",
        returns: "Authenticated node detail with substance, provenance, edges, and children",
        example: "/nodes/OC.0.2.49",
      },
      "browse capabilities": {
        endpoint: "GET /capabilities?domain=<domain>&limit=50",
        returns: "Paginated capability directory with provider counts",
        example: "/capabilities?domain=communication",
      },
      "AI synthesis": {
        endpoint: "GET /insight?q=<question>&depth=deep",
        returns: "Multi-angle search, deduplicated ranking, Gemini-synthesized answer with [ADDR] citations",
        example: "/insight?q=how+do+I+deploy+safely",
      },
    },

    truth_engine: {
      thesis: "Truth is a process, not a snapshot. It's derived from the tension between related claims.",
      contradictions: {
        endpoint: "GET /contradictions?min_divergence=0.3",
        returns: "Explicit conflicts, confidence divergence, staleness gaps, capability overlaps — ranked by severity",
        note: "Contradictions are operator-only in beta because they can reveal internal structure and unresolved private tensions.",
      },
      provenance_basis: {
        field: "provenance.basis",
        values: {
          observed: "From real incidents, logs, or file evidence (highest trust)",
          consensus: "Multiple agents/sources agree (high trust)",
          inferred: "Derived from other nodes by AI mining (medium trust)",
          asserted: "Stated by a single agent, unverified (lowest trust)",
        },
        weighting: "observed > consensus > inferred > asserted",
      },
      temporal: {
        fields: ["verified_at", "verification_method", "updated_at", "decay_rate"],
        note: "Confidence decays over time via apply_confidence_decay(). Layer-aware: L0 after 7d, L1 after 14d (half-rate), L2 after 30d (quarter-rate). Floor: 0.05 (never fully forgotten).",
      },
    },

    feedback: {
      signal: {
        endpoint: "POST /signal/agent { type, context, nodes?, agent? }",
        returns: "Stimulus receipt and downstream impact summary",
        note: "Beta agents feed back through stimuli. Direct confidence mutation via POST /signal is operator-only.",
      },
      recall_outcome: {
        endpoint: "POST /signal/recall { recall_id, outcome, memories?, context?, query?, agent? }",
        returns: "Recall outcome receipt for usefulness scoring",
        note: "Use the recall_id returned from memory recall/context flows so SuperCron can separate query_hits from task usefulness. query is supplemental; the original recall packet query remains canonical when present.",
      },
      stats: "GET /signal/stats — authenticated feedback loop health",
      automatic: "Every search increments query_hits. Weekly cron runs confidence decay + resonance refresh.",
    },

    stats: {
      public_nodes: counts.public_nodes,
      private_nodes: counts.private_nodes,
      total_edges: counts.total_edges,
      node_types: counts.node_type_count,
      edge_types: counts.edge_type_count,
    },
    auth: {
      anonymous: "search/context/briefing/trends/schema/capabilities",
      beta: "node detail, traversal, insight, watch, agenda, run/check guidance",
      operator: "host execution, staging mutation, ingest and maintenance controls",
    },
  });
});

export default schema;
