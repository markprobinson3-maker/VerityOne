import { sql } from "../db";
import type { AccessContext } from "./access";
import { findOntologyBranchByAddr } from "./ontology";
import { ontologyGuidanceSummary } from "./ontology-guidance";
import { filterReadableNodes } from "./public-graph";
import { GLOBAL_SPACE_ID } from "./spaces";
import { ONTOLOGY_BRIDGE_PYRAMIDS as ONTOLOGY_PYRAMIDS } from "@verity-one/graph-shape";

export interface OntologyBridgeNode {
  seed_addr: string;
  via_addr: string;
  via_label: string;
  via_pyramid_id: string;
  addr: string;
  label: string;
  pyramid_id: string;
  node_type: string;
  description: string | null;
  edge_type: string;
  edge_label: string | null;
  confidence: number;
  access_level?: string | null;
  visibility?: string | null;
  space_id?: string | null;
  depth?: number | null;
  alignment_role?: string | null;
  why_it_matters?: string | null;
  action_hint?: string | null;
  confidence_posture?: string | null;
}

export interface OntologyBridgePayload {
  intent: {
    mode: "act" | "understand" | "evaluate" | "coordinate" | "discover";
    focus: string;
    reductive_rule: string;
  };
  next_steps: Array<{
    kind: "anchor" | "bridge";
    addr: string;
    label: string;
    pyramid_id: string;
    reason: string;
  }>;
  anchors: Array<{
    seed_addr: string;
    addr: string;
    label: string;
    pyramid_id: string;
    priority?: "primary" | "resonant" | "suggested";
    relationship: string;
    description: string | null;
    why_it_matters?: string | null;
    action_hint?: string | null;
    confidence_posture?: string | null;
  }>;
  cross_domain: Array<{
    seed_addr: string;
    via_addr: string;
    via_label: string;
    via_pyramid_id: string;
    addr: string;
    label: string;
    pyramid_id: string;
    priority?: "primary" | "resonant" | "suggested";
    relationship: string;
    edge_label: string | null;
    description: string | null;
    why_it_matters?: string | null;
    action_hint?: string | null;
    confidence_posture?: string | null;
  }>;
}

function classifyOntologyIntent(
  queryText: string,
  anchors: OntologyBridgeNode[],
  bridges: OntologyBridgeNode[],
): OntologyBridgePayload["intent"] {
  const text = queryText.trim().toLowerCase();
  const scores = {
    act: 0,
    understand: 0,
    evaluate: 0,
    coordinate: 0,
    discover: 0,
  };

  const addScore = (mode: keyof typeof scores, terms: string[], amount = 2) => {
    for (const term of terms) {
      if (text.includes(term)) scores[mode] += amount;
    }
  };

  addScore("act", ["build", "implement", "fix", "deploy", "write", "create", "run", "use", "ship"]);
  addScore("understand", ["what is", "explain", "understand", "why", "meaning", "overview", "concept"]);
  addScore("evaluate", ["compare", "validate", "test", "audit", "verify", "risk", "compliance", "assess"]);
  addScore("coordinate", ["plan", "workflow", "governance", "coordinate", "delegate", "proposal", "sequence", "schedule"]);
  addScore("discover", ["explore", "discover", "browse", "map", "survey"], 2);

  for (const row of anchors) {
    if (row.pyramid_id === "FUNCTION") scores.act += 1;
    if (row.pyramid_id === "WORLD") scores.understand += 1;
  }
  for (const row of bridges) {
    if (row.pyramid_id === "FUNCTION" && row.edge_type === "informs") scores.coordinate += 1;
    if (row.pyramid_id === "WORLD" && row.edge_type === "informs") scores.evaluate += 1;
  }

  const mode = (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] || "discover") as OntologyBridgePayload["intent"]["mode"];
  switch (mode) {
    case "act":
      return {
        mode,
        focus: "Enter through FUNCTION for immediate execution paths, then cross into WORLD only for constraints, evidence, or governance reality.",
        reductive_rule: "Take one functional anchor and at most two world bridges before widening the search.",
      };
    case "understand":
      return {
        mode,
        focus: "Enter through WORLD to anchor facts and meaning, then cross into FUNCTION only when you need a concrete operational move.",
        reductive_rule: "Stay on one world branch until the factual frame is stable, then pivot once into FUNCTION.",
      };
    case "evaluate":
      return {
        mode,
        focus: "Start with WORLD for evidence, uncertainty, incentives, or constraints, then use FUNCTION for validation, audit, or controlled action.",
        reductive_rule: "Prefer evidence-bearing branches first; only expand into action branches that test or constrain the claim.",
      };
    case "coordinate":
      return {
        mode,
        focus: "Start with WORLD for actors, incentives, and governance dynamics, then cross into FUNCTION for workflow and decision execution.",
        reductive_rule: "Keep the traversal to one coordination anchor and the two strongest execution bridges.",
      };
    default:
      return {
        mode: "discover",
        focus: "Start with the strongest ontology anchor and follow one bridge at a time to preserve context budget.",
        reductive_rule: "Expand breadth only after the current anchor stops yielding useful action or explanation.",
      };
  }
}

function buildOntologyNextSteps(
  context: { anchors: OntologyBridgeNode[]; bridges: OntologyBridgeNode[] },
): OntologyBridgePayload["next_steps"] {
  const steps: OntologyBridgePayload["next_steps"] = [];
  for (const row of context.anchors.slice(0, 2)) {
    steps.push({
      kind: "anchor",
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      reason: row.alignment_role === "primary_anchor"
        ? "Primary ontology anchor for fast orientation."
        : row.pyramid_id === "FUNCTION"
        ? "Best direct action branch for the current goal."
        : "Best grounding branch for facts, incentives, or constraints.",
    });
  }
  for (const row of context.bridges.slice(0, 2)) {
    steps.push({
      kind: "bridge",
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      reason: row.edge_label || `Use this ${row.pyramid_id.toLowerCase()} bridge to pivot domains without widening the query.`,
    });
  }
  return steps.slice(0, 3);
}

function dedupe<T extends { addr: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.addr)) continue;
    seen.add(row.addr);
    out.push(row);
  }
  return out;
}

function sortBridgeRows(rows: OntologyBridgeNode[]): OntologyBridgeNode[] {
  const alignmentPriority = (row: OntologyBridgeNode): number => {
    if (row.edge_type === "anchor") return -3;
    if (row.alignment_role === "primary_anchor") return -2;
    if (row.alignment_role === "resonance") return -1;
    if (row.edge_type === "suggests") return 1;
    return 0;
  };
  const edgePriority = (edgeType: string): number => {
    switch (edgeType) {
      case "operationalizes": return 0;
      case "informs": return 1;
      case "constrains": return 2;
      case "enables": return 3;
      case "specializes": return 4;
      case "shapes": return 5;
      default: return 6;
    }
  };
  return rows.sort((a, b) => {
    const alignmentDelta = alignmentPriority(a) - alignmentPriority(b);
    if (alignmentDelta !== 0) return alignmentDelta;
    const edgeDelta = edgePriority(a.edge_type) - edgePriority(b.edge_type);
    if (edgeDelta !== 0) return edgeDelta;
    const confDelta = (b.confidence || 0) - (a.confidence || 0);
    if (confDelta !== 0) return confDelta;
    return a.label.localeCompare(b.label);
  });
}

function capResonanceRows(rows: OntologyBridgeNode[], limit: number): OntologyBridgeNode[] {
  const primary = rows.filter((row) => row.alignment_role === "primary_anchor" || row.edge_type === "anchor");
  const resonance = rows.filter((row) => row.alignment_role === "resonance").slice(0, Math.max(0, limit - primary.length));
  const neutral = rows
    .filter((row) => row.edge_type !== "anchor" && !row.alignment_role)
    .slice(0, Math.max(0, limit - primary.length - resonance.length));
  return [...primary, ...resonance, ...neutral].slice(0, limit);
}

function scoreQueryMatch(
  queryText: string,
  label: string | null,
  description: string | null,
  keywords: string[] = [],
  depth: number | null | undefined = null,
): number {
  const query = queryText.trim().toLowerCase();
  if (!query) return 0;
  const haystack = `${label || ""} ${description || ""} ${keywords.join(" ")}`.toLowerCase();
  const labelText = (label || "").toLowerCase();
  let score = 0;
  if (labelText === query) score += 8;
  if (labelText.includes(query)) score += 5;
  if (haystack.includes(query)) score += 3;
  const terms = Array.from(new Set(query.split(/[^a-z0-9]+/i).filter((term) => term.length >= 3)));
  for (const term of terms) {
    if (labelText.includes(term)) score += 3;
    else if (haystack.includes(term)) score += 1;
  }
  for (const keyword of keywords) {
    const kw = keyword.toLowerCase();
    if (query.includes(kw) || kw.includes(query)) score += 2;
  }
  if (depth && depth >= 2) score += 1;
  return score;
}

export async function selectOntologyBridgeContext(
  seedAddrs: string[],
  access: AccessContext,
  options: { anchorLimit?: number; bridgeLimit?: number; queryText?: string | null } = {},
): Promise<{ anchors: OntologyBridgeNode[]; bridges: OntologyBridgeNode[]; queryText: string }> {
  const cleanSeedAddrs = Array.from(new Set(seedAddrs.filter(Boolean)));
  const queryText = (options.queryText || "").trim();
  if (cleanSeedAddrs.length === 0 && !queryText) {
    return { anchors: [], bridges: [], queryText: "" };
  }

  const anchorLimit = options.anchorLimit ?? 6;
  const bridgeLimit = options.bridgeLimit ?? 6;
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];

  let seedOntologyNodes = await sql`
    SELECT
      n.addr AS seed_addr,
      n.addr AS via_addr,
      n.label AS via_label,
      n.pyramid_id AS via_pyramid_id,
      n.addr,
      n.label,
      n.pyramid_id,
      n.node_type,
      n.depth,
      n.substance->>'description' AS description,
      'anchor'::text AS edge_type,
      NULL::text AS edge_label,
      n.confidence,
      r.access_level,
      n.visibility,
      n.space_id
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ANY(${cleanSeedAddrs})
      AND n.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
      AND n.depth >= 2
      AND n.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND n.space_id = ANY(${spaceIds}::text[])
            AND (
              n.space_id <> ${GLOBAL_SPACE_ID}
              OR (n.visibility = 'public' AND r.access_level IN ('public', 'shared'))
            )`}
  ` as OntologyBridgeNode[];

  let alignedOntologyNodes = await sql`
    WITH seed_alignment_edges AS (
      SELECT
        e.from_addr AS seed_addr,
        e.to_addr AS target_addr,
        e.edge_type,
        e.label AS edge_label,
        e.confidence,
        e.source_context->>'alignment_role' AS alignment_role
      FROM edges e
      JOIN nodes target ON target.addr = e.to_addr
      WHERE e.from_addr = ANY(${cleanSeedAddrs})
        AND target.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND target.visibility <> 'deleted'
        AND COALESCE(e.source_context->>'alignment_version', '') <> ''

      UNION ALL

      SELECT
        e.to_addr AS seed_addr,
        e.from_addr AS target_addr,
        e.edge_type,
        e.label AS edge_label,
        e.confidence,
        e.source_context->>'alignment_role' AS alignment_role
      FROM edges e
      JOIN nodes target ON target.addr = e.from_addr
      WHERE e.to_addr = ANY(${cleanSeedAddrs})
        AND target.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND target.visibility <> 'deleted'
        AND COALESCE(e.source_context->>'alignment_version', '') <> ''
    )
    SELECT DISTINCT ON (sa.seed_addr, target.addr)
      sa.seed_addr,
      target.addr AS via_addr,
      target.label AS via_label,
      target.pyramid_id AS via_pyramid_id,
      target.addr,
      target.label,
      target.pyramid_id,
      target.node_type,
      target.depth,
      target.substance->>'description' AS description,
      sa.edge_type,
      sa.edge_label,
      sa.confidence,
      sa.alignment_role,
      r.access_level,
      target.visibility,
      target.space_id
    FROM seed_alignment_edges sa
    JOIN nodes target ON target.addr = sa.target_addr
    JOIN registry r ON r.pyramid_id = target.pyramid_id
    WHERE target.depth >= 2
      AND target.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND target.space_id = ANY(${spaceIds}::text[])
            AND (
              target.space_id <> ${GLOBAL_SPACE_ID}
              OR (target.visibility = 'public' AND r.access_level IN ('public', 'shared'))
            )`}
    ORDER BY sa.seed_addr, target.addr, sa.confidence DESC
  ` as OntologyBridgeNode[];

  if (access.scope !== "operator") {
    seedOntologyNodes = filterReadableNodes(seedOntologyNodes, access);
    alignedOntologyNodes = filterReadableNodes(alignedOntologyNodes, access);
  }

  let queryOntologyNodes: OntologyBridgeNode[] = [];
  if (queryText) {
    queryOntologyNodes = await sql`
      SELECT
        ${cleanSeedAddrs[0] || ""}::text AS seed_addr,
        n.addr AS via_addr,
        n.label AS via_label,
        n.pyramid_id AS via_pyramid_id,
        n.addr,
        n.label,
        n.pyramid_id,
        n.node_type,
        n.depth,
        n.substance->>'description' AS description,
        'suggests'::text AS edge_type,
        'Ontology branch suggested by query intent'::text AS edge_label,
        n.confidence,
        r.access_level,
        n.visibility,
        n.space_id
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND n.depth >= 2
        AND n.visibility <> 'deleted'
        ${access.scope === "operator"
          ? sql``
          : sql`
              AND n.space_id = ANY(${spaceIds}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level IN ('public', 'shared'))
              )`}
    ` as OntologyBridgeNode[];
    if (access.scope !== "operator") {
      queryOntologyNodes = filterReadableNodes(queryOntologyNodes, access);
    }
    queryOntologyNodes = queryOntologyNodes
      .map((row) => ({
        ...row,
        confidence: scoreQueryMatch(
          queryText,
          row.label,
          row.description,
          findOntologyBranchByAddr(row.addr)?.keywords || [],
          row.depth,
        ),
      }))
      .filter((row) => row.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  const anchors = capResonanceRows(dedupe(sortBridgeRows([
    ...queryOntologyNodes,
    ...seedOntologyNodes,
    ...alignedOntologyNodes,
  ])), anchorLimit);

  const anchorAddrs = Array.from(new Set(anchors.map((anchor) => anchor.addr)));
  if (anchorAddrs.length === 0) {
    return { anchors, bridges: [], queryText };
  }

  let bridgeRows = await sql`
    WITH ontology_bridge_edges AS (
      SELECT
        e.from_addr AS via_addr,
        e.to_addr AS target_addr,
        e.edge_type,
        e.label AS edge_label,
        e.confidence
      FROM edges e
      JOIN nodes source ON source.addr = e.from_addr
      JOIN nodes target ON target.addr = e.to_addr
      WHERE e.from_addr = ANY(${anchorAddrs})
        AND source.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND target.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND source.visibility <> 'deleted'
        AND target.visibility <> 'deleted'
        AND source.pyramid_id <> target.pyramid_id
        AND e.confidence >= 0.70

      UNION ALL

      SELECT
        e.to_addr AS via_addr,
        e.from_addr AS target_addr,
        e.edge_type,
        e.label AS edge_label,
        e.confidence
      FROM edges e
      JOIN nodes source ON source.addr = e.to_addr
      JOIN nodes target ON target.addr = e.from_addr
      WHERE e.to_addr = ANY(${anchorAddrs})
        AND e.confidence >= 0.70
        AND source.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND target.pyramid_id = ANY(${ONTOLOGY_PYRAMIDS})
        AND source.visibility <> 'deleted'
        AND target.visibility <> 'deleted'
        AND source.pyramid_id <> target.pyramid_id
    )
    SELECT DISTINCT ON (obe.via_addr, target.addr)
      NULL::text AS seed_addr,
      anchor.addr AS via_addr,
      anchor.label AS via_label,
      anchor.pyramid_id AS via_pyramid_id,
      target.addr,
      target.label,
      target.pyramid_id,
      target.node_type,
      target.depth,
      target.substance->>'description' AS description,
      obe.edge_type,
      obe.edge_label,
      obe.confidence,
      NULL::text AS alignment_role,
      r.access_level,
      target.visibility,
      target.space_id
    FROM ontology_bridge_edges obe
    JOIN nodes target ON target.addr = obe.target_addr
    JOIN registry r ON r.pyramid_id = target.pyramid_id
    JOIN nodes anchor ON anchor.addr = obe.via_addr
    WHERE target.depth >= 2
      AND target.visibility <> 'deleted'
      AND anchor.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
            AND target.space_id = ANY(${spaceIds}::text[])
            AND (
              target.space_id <> ${GLOBAL_SPACE_ID}
              OR (target.visibility = 'public' AND r.access_level IN ('public', 'shared'))
            )`}
    ORDER BY obe.via_addr, target.addr, obe.confidence DESC
  ` as OntologyBridgeNode[];

  if (access.scope !== "operator") {
    bridgeRows = filterReadableNodes(bridgeRows, access);
  }

  const anchorByAddr = new Map(anchors.map((anchor) => [anchor.addr, anchor]));
  const bridges = dedupe(sortBridgeRows(
    bridgeRows
      .filter((row) => row.addr !== row.via_addr)
      .map((row) => {
        const anchor = anchorByAddr.get(row.via_addr);
        return {
          ...row,
          seed_addr: anchor?.seed_addr || row.seed_addr,
          via_label: anchor?.label || row.via_label,
          via_pyramid_id: anchor?.pyramid_id || row.via_pyramid_id,
        };
      }),
  )).slice(0, bridgeLimit);

  return { anchors, bridges, queryText };
}

export function formatOntologyBridgePayload(
  context: { anchors: OntologyBridgeNode[]; bridges: OntologyBridgeNode[]; queryText?: string },
): OntologyBridgePayload {
  const intent = classifyOntologyIntent(context.queryText || "", context.anchors, context.bridges);
  return {
    intent,
    next_steps: buildOntologyNextSteps(context),
    anchors: context.anchors.map((row) => ({
      ...(() => {
        const guidance: Partial<NonNullable<ReturnType<typeof ontologyGuidanceSummary>>> =
          ontologyGuidanceSummary(row.addr) || {};
        return {
          ...guidance,
          description: row.description || guidance.description || null,
        };
      })(),
      seed_addr: row.seed_addr,
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      priority: row.alignment_role === "primary_anchor" ? "primary" : row.alignment_role === "resonance" ? "resonant" : row.edge_type === "suggests" ? "suggested" : undefined,
      relationship: row.edge_type,
    })),
    cross_domain: context.bridges.map((row) => ({
      ...(() => {
        const guidance: Partial<NonNullable<ReturnType<typeof ontologyGuidanceSummary>>> =
          ontologyGuidanceSummary(row.addr) || {};
        return {
          ...guidance,
          description: row.description || guidance.description || null,
        };
      })(),
      seed_addr: row.seed_addr,
      via_addr: row.via_addr,
      via_label: row.via_label,
      via_pyramid_id: row.via_pyramid_id,
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      priority: row.alignment_role === "primary_anchor" ? "primary" : row.alignment_role === "resonance" ? "resonant" : row.edge_type === "suggests" ? "suggested" : undefined,
      relationship: row.edge_type,
      edge_label: row.edge_label,
    })),
  };
}

const STRUCTURAL_EDGE_TYPES = new Set([
  "contains",
  "part_of",
]);

const MEANING_EDGE_TYPES = new Set([
  "informs",
  "constrains",
  "enables",
  "shapes",
  "models",
  "governs",
  "specializes",
  "operationalizes",
  "grounds",
  "frames",
  "parallels",
  "suggests",
]);

const APPLICATION_EDGE_TYPES = new Set([
  "implements",
  "uses",
  "requires",
  "composes_with",
  "connects_to",
  "extends",
  "supports",
]);

const CONFLICT_EDGE_TYPES = new Set([
  "conflicts_with",
  "contradicts",
]);

export function classifyGraphEdgeRole(edgeType: string | null | undefined): string {
  const type = (edgeType || "").trim().toLowerCase();
  if (!type) return "relation";
  if (STRUCTURAL_EDGE_TYPES.has(type)) return "structure";
  if (MEANING_EDGE_TYPES.has(type)) return "meaning";
  if (APPLICATION_EDGE_TYPES.has(type)) return "application";
  if (CONFLICT_EDGE_TYPES.has(type)) return "conflict";
  return "relation";
}
