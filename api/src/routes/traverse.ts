/**
 * /traverse — Multi-hop graph traversal and shortest path
 *
 * BFS traversal:
 *   GET /traverse?from=META.0.2.4&hops=2
 *   GET /traverse?from=META.0.2.4&hops=3&edge_types=related_to,implements&direction=outbound
 *
 * Shortest path:
 *   GET /traverse?from=OC.0.2.1&to=META.0.1.3
 *
 * Max 5 hops. 653 nodes is trivial for BFS.
 */

import { Hono } from "hono";
import { errorJson } from "../lib/error-envelope";
import { sql } from "../db";
import { allowedRegistryAccessLevels, getAccessContext, isOperator, type AccessContext } from "../lib/access";
import { classifyGraphEdgeRole, formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { clampInt, splitQuery } from "../lib/utils";
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const traverse = new Hono();

type Direction = "outbound" | "inbound" | "both";

function summarizePathSemantics(edges: any[]) {
  const byRole: Record<string, number> = {};
  for (const edge of edges) {
    const role = classifyGraphEdgeRole(edge.edge_type);
    byRole[role] = (byRole[role] || 0) + 1;
  }
  return {
    dominant_role: Object.entries(byRole).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    role_counts: byRole,
  };
}

async function loadNode(addr: string, access: AccessContext, accessLevels: string[]) {
  const operator = access.scope === "operator";
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
  if (operator) {
    const [node] = await sql`
      SELECT addr, pyramid_id, layer, depth, position, label, confidence,
        node_type, stimulus_heat, resonance
      FROM nodes
      WHERE addr = ${addr}
        AND visibility <> 'deleted'`;
    return node || null;
  }

  const [node] = await sql`
    SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.position, n.label, n.confidence,
      n.node_type, n.stimulus_heat, n.resonance,
      n.visibility, n.source_context, r.access_level, n.space_id,
      n.substance->>'description' as description
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
      AND n.space_id = ANY(${spaceIds}::text[])
      AND (
        n.space_id <> ${GLOBAL_SPACE_ID}
        OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
      )`;
  return node || null;
}

async function fetchConnectedEdges(
  addr: string,
  edgeTypes: string[],
  direction: Direction,
  access: AccessContext,
  accessLevels: string[],
) {
  const operator = access.scope === "operator";
  const spaceIds = access.spaceIds || [GLOBAL_SPACE_ID];
  if (operator) {
    if (edgeTypes.length > 0) {
      if (direction === "outbound") {
        return sql`
          SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
          FROM edges e
          JOIN nodes neighbor
            ON neighbor.addr = e.to_addr
            AND neighbor.visibility <> 'deleted'
          WHERE e.from_addr = ${addr} AND e.edge_type = ANY(${edgeTypes})`;
      }
      if (direction === "inbound") {
        return sql`
          SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
          FROM edges e
          JOIN nodes neighbor
            ON neighbor.addr = e.from_addr
            AND neighbor.visibility <> 'deleted'
          WHERE e.to_addr = ${addr} AND e.edge_type = ANY(${edgeTypes})`;
      }
      return sql`
        SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
        FROM edges e
        JOIN nodes neighbor
          ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
          AND neighbor.visibility <> 'deleted'
        WHERE (e.from_addr = ${addr} OR e.to_addr = ${addr}) AND e.edge_type = ANY(${edgeTypes})`;
    }
    if (direction === "outbound") {
      return sql`
        SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
        FROM edges e
        JOIN nodes neighbor
          ON neighbor.addr = e.to_addr
          AND neighbor.visibility <> 'deleted'
        WHERE e.from_addr = ${addr}`;
    }
    if (direction === "inbound") {
      return sql`
        SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
        FROM edges e
        JOIN nodes neighbor
          ON neighbor.addr = e.from_addr
          AND neighbor.visibility <> 'deleted'
        WHERE e.to_addr = ${addr}`;
    }
    return sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
      FROM edges e
      JOIN nodes neighbor
        ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
        AND neighbor.visibility <> 'deleted'
      WHERE e.from_addr = ${addr} OR e.to_addr = ${addr}`;
  }

  return sql`
    SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence,
      CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END as neighbor_addr
    FROM edges e
    JOIN nodes neighbor
      ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
    JOIN registry r ON r.pyramid_id = neighbor.pyramid_id
    WHERE ${direction === "outbound"
      ? sql`e.from_addr = ${addr}`
      : direction === "inbound"
        ? sql`e.to_addr = ${addr}`
        : sql`(e.from_addr = ${addr} OR e.to_addr = ${addr})`}
      ${edgeTypes.length > 0 ? sql`AND e.edge_type = ANY(${edgeTypes})` : sql``}
      AND e.space_id = ANY(${spaceIds}::text[])
      AND neighbor.space_id = ANY(${spaceIds}::text[])
      AND neighbor.visibility <> 'deleted'
      AND (
        neighbor.space_id <> ${GLOBAL_SPACE_ID}
        OR (neighbor.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
      )`;
}

// --- BFS Traversal ---
async function bfsTraverse(
  from: string,
  maxHops: number,
  edgeTypes: string[],
  direction: Direction,
  access: AccessContext,
  accessLevels: string[],
) {
  const visited = new Set<string>();
  const queue: { addr: string; hop: number }[] = [{ addr: from, hop: 0 }];
  const resultNodes: any[] = [];
  const resultEdges: any[] = [];
  const seenEdges = new Set<string>();

  while (queue.length > 0) {
    const { addr, hop } = queue.shift()!;
    if (visited.has(addr) || hop > maxHops) continue;
    visited.add(addr);

    // Fetch the node
    const node = await loadNode(addr, access, accessLevels);
    if (!node) continue;
    resultNodes.push({ ...node, hop });

    // Fetch connected edges (respect direction and type filters)
    if (hop < maxHops) {
      const edges = await fetchConnectedEdges(addr, edgeTypes, direction, access, accessLevels);

      for (const edge of edges) {
        const edgeKey = `${edge.from_addr}-${edge.to_addr}-${edge.edge_type}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          const { neighbor_addr, ...cleanEdge } = edge as any;
          resultEdges.push(cleanEdge);
        }
        const neighbor = (edge as any).neighbor_addr || (edge.from_addr === addr ? edge.to_addr : edge.from_addr);
        if (!visited.has(neighbor)) {
          queue.push({ addr: neighbor, hop: hop + 1 });
        }
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}

// --- Shortest Path (BFS, unweighted) ---
async function shortestPath(
  from: string,
  to: string,
  edgeTypes: string[],
  maxHops: number,
  access: AccessContext,
  accessLevels: string[],
) {
  const fromNode = await loadNode(from, access, accessLevels);
  const toNode = await loadNode(to, access, accessLevels);
  if (!fromNode || !toNode) return null;

  const visited = new Set<string>();
  const parent = new Map<string, { addr: string; edge: any }>();
  const queue: { addr: string; hop: number }[] = [{ addr: from, hop: 0 }];
  visited.add(from);

  while (queue.length > 0) {
    const { addr, hop } = queue.shift()!;
    if (addr === to) break;
    if (hop >= maxHops) continue;

    const edges = await fetchConnectedEdges(addr, edgeTypes, "both", access, accessLevels);

    for (const edge of edges) {
      const neighbor = (edge as any).neighbor_addr || (edge.from_addr === addr ? edge.to_addr : edge.from_addr);
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, { addr, edge });
        queue.push({ addr: neighbor, hop: hop + 1 });
      }
    }
  }

  // Reconstruct path
  if (!visited.has(to)) {
    return null; // No path found
  }

  const pathAddrs: string[] = [];
  const pathEdges: any[] = [];
  let current = to;

  while (current !== from) {
    pathAddrs.unshift(current);
    const p = parent.get(current);
    if (!p) break;
    pathEdges.unshift(p.edge);
    current = p.addr;
  }
  pathAddrs.unshift(from);

  // Fetch node details for path
  const pathNodes = [];
  for (let i = 0; i < pathAddrs.length; i++) {
    const node = await loadNode(pathAddrs[i], access, accessLevels);
    if (node) pathNodes.push({ ...node, hop: i });
  }

  return {
    nodes: pathNodes,
    edges: pathEdges.map((edge: any) => {
      const { neighbor_addr, ...cleanEdge } = edge;
      return cleanEdge;
    }),
    hops: pathAddrs.length - 1,
  };
}

// GET /traverse?from=X&hops=2&edge_types=&direction=&to=Y
traverse.get("/", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rawHops = c.req.query("hops");
  const edgeTypes = splitQuery(c.req.query("edge_types"));
  const direction = (c.req.query("direction") || "both") as Direction;

  if (!from) return errorJson(c, "invalid_request", { message: "from parameter required" });
  if (!["outbound", "inbound", "both"].includes(direction)) {
    return errorJson(c, "invalid_request", { message: "direction must be outbound, inbound, or both" });
  }

  // Validate hops: must be a positive integer
  if (rawHops !== undefined) {
    const parsed = Number(rawHops);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return errorJson(c, "invalid_request", { message: "hops must be a positive integer (1-5)" });
    }
  }
  const hops = clampInt(rawHops, 2, 1, 5);

  const access = getAccessContext(c);
  const operator = isOperator(c);
  const accessLevels = allowedRegistryAccessLevels(c);

  const startMs = Date.now();

  // Validate that the 'from' address exists
  const fromNode = await loadNode(from, access, accessLevels);
  if (!fromNode) {
    return errorJson(c, "node_not_found");
  }

  // Shortest path mode
  if (to) {
    const result = await shortestPath(from, to, edgeTypes, hops, access, accessLevels);
    if (!result) {
      return errorJson(c, "not_found", {
        message: `No path found within ${hops} hops`,
        details: { from, to, ms: Date.now() - startMs },
      });
    }
    const bridgeContext = await selectOntologyBridgeContext(result.nodes.map((node: any) => node.addr), access, {
      anchorLimit: 4,
      bridgeLimit: 5,
      queryText: `${from} ${to}`,
    });
    return c.json({
      ok: true,
      mode: "shortest_path",
      from,
      to,
      hops: result.hops,
      nodes: result.nodes,
      edges: result.edges.map((edge: any) => ({
        ...edge,
        role: classifyGraphEdgeRole(edge.edge_type),
      })),
      ontology: formatOntologyBridgePayload(bridgeContext),
      path_semantics: summarizePathSemantics(result.edges),
      count: { nodes: result.nodes.length, edges: result.edges.length },
      ms: Date.now() - startMs,
    });
  }

  // BFS traversal mode
  const result = await bfsTraverse(from, hops, edgeTypes, direction, access, accessLevels);
  const bridgeContext = await selectOntologyBridgeContext(result.nodes.map((node: any) => node.addr), access, {
    anchorLimit: 4,
    bridgeLimit: 5,
    queryText: from,
  });
  return c.json({
    ok: true,
    mode: "traverse",
    from,
    hops,
    direction,
    ...(edgeTypes.length > 0 ? { edge_types: edgeTypes } : {}),
    nodes: result.nodes,
    edges: result.edges.map((edge: any) => ({
      ...edge,
      role: classifyGraphEdgeRole(edge.edge_type),
    })),
    ontology: formatOntologyBridgePayload(bridgeContext),
    path_semantics: summarizePathSemantics(result.edges),
    count: { nodes: result.nodes.length, edges: result.edges.length },
    ms: Date.now() - startMs,
  });
});

export default traverse;
