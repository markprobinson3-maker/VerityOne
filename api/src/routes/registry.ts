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
import { selectVisiblePyramidSummaries } from "../lib/visible-graph";

const registry = new Hono();

// GET /pyramids — Table of contents
registry.get("/", async (c) => {
  const access = getAccessContext(c);
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const pyramids = await selectVisiblePyramidSummaries({
    scope: access.scope,
    accessLevels,
    spaceIds,
  });
  return c.json({ pyramids });
});

// GET /pyramids/:id — Single pyramid details
registry.get("/:id", async (c) => {
  const id = c.req.param("id");
  const access = getAccessContext(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const [pyramid] = await sql`
    SELECT * FROM registry WHERE pyramid_id = ${id}
  `;
  if (!pyramid) return errorJson(c, "pyramid_unknown", { message: "Pyramid not found" });
  const [tenantVisible] = isOperator(c)
    ? [{ ok: true } as any]
    : await sql`
        SELECT EXISTS (
          SELECT 1
          FROM nodes n
          WHERE n.pyramid_id = ${id}
            AND n.space_id = ANY(${spaceIds}::text[])
            AND n.space_id <> ${GLOBAL_SPACE_ID}
            AND n.visibility <> 'deleted'
        ) AS ok
      `;
  if (!canReadRegistryAccessLevel(c, pyramid.access_level) && !tenantVisible?.ok) {
    return errorJson(c, "pyramid_unknown", { message: "Pyramid not found" });
  }

  const visiblePyramids = await selectVisiblePyramidSummaries({
    scope: access.scope,
    accessLevels: allowedRegistryAccessLevels(c),
    spaceIds,
  });
  const visiblePyramid = visiblePyramids.find((row: any) => row.pyramid_id === id);
  if (!visiblePyramid) {
    return errorJson(c, "pyramid_unknown", { message: "Pyramid not found" });
  }

  // Include node count by layer
  const layerStats = isOperator(c)
    ? await sql`
        SELECT layer, COUNT(*) as count, AVG(confidence) as avg_confidence
        FROM nodes
        WHERE pyramid_id = ${id}
          AND visibility <> 'deleted'
        GROUP BY layer ORDER BY layer
      `
    : await sql`
        SELECT layer, COUNT(*) as count, AVG(confidence) as avg_confidence
        FROM nodes
        WHERE pyramid_id = ${id}
          AND space_id = ANY(${spaceIds}::text[])
          AND visibility <> 'deleted'
          AND (
            space_id <> ${GLOBAL_SPACE_ID}
            OR visibility = 'public'
          )
        GROUP BY layer ORDER BY layer
      `;
  const visibleNodeCount = Number(visiblePyramid.node_count);

  return c.json({
    pyramid: {
      ...visiblePyramid,
      node_count: visibleNodeCount,
      edge_count: Number(visiblePyramid.edge_count),
    },
    layers: layerStats,
  });
});

export default registry;
