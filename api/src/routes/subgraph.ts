import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import {
  allowedRegistryAccessLevels,
  canReadRegistryAccessLevel,
  getAccessContext,
  isOperator,
  visibleSpaceIds,
} from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";

const subgraph = new Hono();
const POSTGRES_INT_MAX = 2_147_483_647;

function parseSubgraphInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value <= POSTGRES_INT_MAX ? value : null;
}

// GET /subgraph?pyramid=META&layer=0&depthMin=0&depthMax=3
// Returns a slice of a pyramid for Scope rendering
subgraph.get("/", async (c) => {
  const pyramid = c.req.query("pyramid");
  const layerRaw = c.req.query("layer");
  const layer = parseSubgraphInt(layerRaw, 0);
  const depthMin = parseSubgraphInt(c.req.query("depthMin"), 0);
  const depthMax = parseSubgraphInt(c.req.query("depthMax"), 99);
  const edgeMode = c.req.query("edge_mode") === "touching" ? "touching" : "internal";
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];

  if (!pyramid) return errorJson(c, "invalid_request", { message: "pyramid parameter required" });
  if (layer === null) return errorJson(c, "invalid_request", { message: "layer must be a non-negative integer." });
  if (depthMin === null) return errorJson(c, "invalid_request", { message: "depthMin must be a non-negative integer." });
  if (depthMax === null) return errorJson(c, "invalid_request", { message: "depthMax must be a non-negative integer." });
  if (depthMax < depthMin) {
    return errorJson(c, "invalid_request", { message: "depthMax must be >= depthMin." });
  }
  const [registryRow] = await sql`
    SELECT access_level
    FROM registry
    WHERE pyramid_id = ${pyramid}
  `;
  const [tenantVisible] = isOperator(c)
    ? [{ ok: true } as any]
    : await sql`
        SELECT EXISTS (
          SELECT 1
          FROM nodes n
          WHERE n.pyramid_id = ${pyramid}
            AND n.space_id = ANY(${spaceIds}::text[])
            AND n.space_id <> ${GLOBAL_SPACE_ID}
            AND n.visibility <> 'deleted'
        ) AS ok
      `;
  if (!registryRow || (!canReadRegistryAccessLevel(c, registryRow.access_level) && !tenantVisible?.ok)) {
    return errorJson(c, "pyramid_unknown", { message: "Pyramid not found" });
  }

  // Build query conditions
  const conditions = [sql`n.pyramid_id = ${pyramid}`];
  if (layerRaw !== undefined) conditions.push(sql`n.layer = ${layer}`);
  conditions.push(sql`n.depth >= ${depthMin}`);
  conditions.push(sql`n.depth <= ${depthMax}`);

  const nodes = isOperator(c)
    ? await sql`
        SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.position,
               n.label, n.confidence, n.temperature, n.parent_addr,
               n.visibility, n.substance, n.node_type, n.source_context, n.stimulus_heat,
               n.order_score, n.hemisphere_affinity
        FROM nodes n
        WHERE ${sql`n.pyramid_id = ${pyramid}`}
        AND n.visibility NOT IN ('dormant', 'deleted')
        AND n.depth >= ${depthMin}
        AND n.depth <= ${depthMax}
        ${layerRaw !== undefined ? sql`AND n.layer = ${layer}` : sql``}
        ORDER BY n.depth, n.position
      `
    : await sql`
        SELECT n.addr, n.pyramid_id, n.layer, n.depth, n.position,
               n.label, n.confidence, n.temperature, n.parent_addr,
               n.visibility, n.space_id, n.substance, n.node_type, n.source_context, n.stimulus_heat,
               n.order_score, n.hemisphere_affinity
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE ${sql`n.pyramid_id = ${pyramid}`}
          AND n.space_id = ANY(${spaceIds}::text[])
          AND n.visibility <> 'deleted'
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
          AND n.depth >= ${depthMin}
          AND n.depth <= ${depthMax}
          ${layerRaw !== undefined ? sql`AND n.layer = ${layer}` : sql``}
        ORDER BY n.depth, n.position
      `;

  // Get all edges between these nodes
  const nodeAddrs = nodes.map((n: any) => n.addr);
  
  let edges: any[] = [];
  if (nodeAddrs.length > 0) {
    edges = isOperator(c)
      ? edgeMode === "touching"
        ? await sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer,
             e.label, e.confidence, e.weight, e.bidirectional
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      JOIN nodes nt ON nt.addr = e.to_addr
      WHERE (e.from_addr = ANY(${nodeAddrs}) OR e.to_addr = ANY(${nodeAddrs}))
        AND nf.visibility <> 'deleted'
        AND nt.visibility <> 'deleted'
    `
        : await sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer,
             e.label, e.confidence, e.weight, e.bidirectional
      FROM edges e
      WHERE e.from_addr = ANY(${nodeAddrs})
        AND e.to_addr = ANY(${nodeAddrs})
    `
      : edgeMode === "touching"
        ? await sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer,
             e.label, e.confidence, e.weight, e.bidirectional
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
      JOIN nodes nt ON nt.addr = e.to_addr
      JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
      WHERE (e.from_addr = ANY(${nodeAddrs}) OR e.to_addr = ANY(${nodeAddrs}))
        AND e.space_id = ANY(${spaceIds}::text[])
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
    `
        : await sql`
      SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer,
             e.label, e.confidence, e.weight, e.bidirectional
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
      JOIN nodes nt ON nt.addr = e.to_addr
      JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
      WHERE e.from_addr = ANY(${nodeAddrs})
        AND e.to_addr = ANY(${nodeAddrs})
        AND e.space_id = ANY(${spaceIds}::text[])
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
    `;
  }

  return c.json({
    pyramid,
    edge_mode: edgeMode,
    slice: { depthMin, depthMax, layer: layerRaw !== undefined ? layer : null },
    nodes,
    edges,
    count: { nodes: nodes.length, edges: edges.length },
  });
});

export default subgraph;
