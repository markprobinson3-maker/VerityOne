import { sql } from "../db";
import type { AccessContext } from "./access";
import { classifyGraphEdgeRole } from "./ontology-bridges";
import { GLOBAL_SPACE_ID } from "./spaces";

type ReasoningNode = {
  addr: string;
  label: string;
  pyramid_id: string;
  node_type: string | null;
  confidence: number;
  description: string | null;
  hop?: number;
};

type ReasoningEdge = {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string | null;
  confidence: number;
  neighbor_addr?: string;
};

export type ReasoningPath = {
  from: string;
  to: string;
  hops: number;
  nodes: ReasoningNode[];
  edges: Array<ReasoningEdge & { role: string }>;
  semantics: {
    dominant_role: string | null;
    role_counts: Record<string, number>;
  };
  summary: string;
};

const ALLOWED_ROLES = new Set(["meaning", "application", "structure"]);

function summarizeRoles(edges: Array<ReasoningEdge & { role: string }>) {
  const roleCounts: Record<string, number> = {};
  for (const edge of edges) {
    roleCounts[edge.role] = (roleCounts[edge.role] || 0) + 1;
  }
  const dominantRole = Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    dominant_role: dominantRole,
    role_counts: roleCounts,
  };
}

function buildSummary(nodes: ReasoningNode[], edges: Array<ReasoningEdge & { role: string }>): string {
  if (nodes.length < 2 || edges.length === 0) {
    return "No bounded reasoning path was found between the current truth and function anchors.";
  }
  const segments = edges.map((edge) => edge.label || edge.edge_type.replace(/_/g, " "));
  return `${nodes[0].label} reaches ${nodes[nodes.length - 1].label} through ${segments.join(" -> ")}.`;
}

async function loadVisibleNode(
  addr: string,
  access: AccessContext,
  accessLevels: string[],
): Promise<ReasoningNode | null> {
  if (access.scope === "operator") {
    const [node] = await sql`
      SELECT addr, label, pyramid_id, node_type, confidence, substance->>'description' AS description
      FROM nodes
      WHERE addr = ${addr}
        AND visibility <> 'deleted'
    `;
    return (node as unknown as ReasoningNode) || null;
  }

  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
  const [node] = await sql`
    SELECT n.addr, n.label, n.pyramid_id, n.node_type, n.confidence, n.substance->>'description' AS description
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
      AND n.space_id = ANY(${spaceIds}::text[])
      AND (
        n.space_id <> ${GLOBAL_SPACE_ID}
        OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
      )
  `;
  return (node as unknown as ReasoningNode) || null;
}

async function fetchVisibleEdges(
  addr: string,
  access: AccessContext,
  accessLevels: string[],
  minConfidence: number,
): Promise<ReasoningEdge[]> {
  if (access.scope === "operator") {
    const rows = await sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.label, e.confidence
      FROM edges e
      JOIN nodes neighbor
        ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
        AND neighbor.visibility <> 'deleted'
      WHERE (e.from_addr = ${addr} OR e.to_addr = ${addr})
        AND e.confidence >= ${minConfidence}
      ORDER BY e.confidence DESC
      LIMIT 60
    `;
    return rows.filter((row: any) => ALLOWED_ROLES.has(classifyGraphEdgeRole(row.edge_type))) as unknown as ReasoningEdge[];
  }

  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
  const rows = await sql`
    SELECT
      e.id,
      e.from_addr,
      e.to_addr,
      e.edge_type,
      e.label,
      e.confidence,
      CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END AS neighbor_addr
    FROM edges e
    JOIN nodes neighbor
      ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
    JOIN registry r ON r.pyramid_id = neighbor.pyramid_id
    WHERE (e.from_addr = ${addr} OR e.to_addr = ${addr})
      AND e.confidence >= ${minConfidence}
      AND e.space_id = ANY(${spaceIds}::text[])
      AND neighbor.space_id = ANY(${spaceIds}::text[])
      AND neighbor.visibility <> 'deleted'
      AND (
        neighbor.space_id <> ${GLOBAL_SPACE_ID}
        OR (neighbor.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
      )
    ORDER BY e.confidence DESC
    LIMIT 60
  `;
  return rows.filter((row: any) => ALLOWED_ROLES.has(classifyGraphEdgeRole(row.edge_type))) as unknown as ReasoningEdge[];
}

export async function findBoundedReasoningPath(
  from: string,
  to: string,
  access: AccessContext,
  accessLevels: string[],
  opts: { maxHops?: number; minConfidence?: number } = {},
): Promise<ReasoningPath | null> {
  if (!from || !to || from === to) return null;
  const maxHops = Math.max(1, Math.min(opts.maxHops || 3, 4));
  const minConfidence = Math.max(0, Math.min(opts.minConfidence || 0.55, 1));

  const fromNode = await loadVisibleNode(from, access, accessLevels);
  const toNode = await loadVisibleNode(to, access, accessLevels);
  if (!fromNode || !toNode) return null;

  const visited = new Set<string>([from]);
  const parent = new Map<string, { addr: string; edge: ReasoningEdge }>();
  const queue: Array<{ addr: string; hop: number }> = [{ addr: from, hop: 0 }];

  while (queue.length > 0) {
    const { addr, hop } = queue.shift()!;
    if (addr === to) break;
    if (hop >= maxHops) continue;

    const edges = await fetchVisibleEdges(addr, access, accessLevels, minConfidence);
    for (const edge of edges) {
      const neighbor = edge.neighbor_addr || (edge.from_addr === addr ? edge.to_addr : edge.from_addr);
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, { addr, edge });
      queue.push({ addr: neighbor, hop: hop + 1 });
    }
  }

  if (!visited.has(to)) return null;

  const pathAddrs: string[] = [];
  const pathEdges: Array<ReasoningEdge & { role: string }> = [];
  let current = to;

  while (current !== from) {
    pathAddrs.unshift(current);
    const link = parent.get(current);
    if (!link) return null;
    pathEdges.unshift({
      ...link.edge,
      role: classifyGraphEdgeRole(link.edge.edge_type),
    });
    current = link.addr;
  }
  pathAddrs.unshift(from);

  const nodes: ReasoningNode[] = [];
  for (let i = 0; i < pathAddrs.length; i++) {
    const node = await loadVisibleNode(pathAddrs[i], access, accessLevels);
    if (node) nodes.push({ ...node, hop: i });
  }
  if (nodes.length < 2) return null;

  const semantics = summarizeRoles(pathEdges);
  return {
    from,
    to,
    hops: pathAddrs.length - 1,
    nodes,
    edges: pathEdges,
    semantics,
    summary: buildSummary(nodes, pathEdges),
  };
}
