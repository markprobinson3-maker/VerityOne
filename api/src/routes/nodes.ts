import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { deriveNodeGuidance } from "../lib/node-guidance";
import { classifyGraphEdgeRole, formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { applyOntologyGuidanceToSubstance } from "../lib/ontology-guidance";
import { parseJsonField } from "../lib/utils";
import { getAccessContext, isOperator, visibleSpaceIds, allowedRegistryAccessLevels } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { filterReadableNodes, isNodeReadableForScope } from "../lib/public-graph";
import { NodeVariantCreateSchema } from "../schemas/nodes.schema";

const nodes = new Hono();

// GET /nodes/:addr — Single node with neighbors
// ?raw=true to include embedding and unparsed fields
nodes.get("/:addr", async (c) => {
  const addr = c.req.param("addr");
  const raw = c.req.query("raw") === "true";
  const access = getAccessContext(c);
  const operator = isOperator(c);

  const [node] = await sql`
    SELECT n.*, r.access_level
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
  `;
  if (!node) return errorJson(c, "node_not_found");
  if (!operator && !isNodeReadableForScope(access, node)) {
    return errorJson(c, "node_not_found");
  }

  // Strip heavy/internal fields (useless to consuming agents)
  if (!raw) {
    delete node.embedding_hv;
    delete node.search_vector;
    delete node.token_weight;
    delete node.token_claimed;
    delete node.contributor_addr;
    delete node.decay_rate;
    delete node.temperature;
  }

  // Parse stringified JSON fields
  node.provenance = parseJsonField(node.provenance) ?? node.provenance;
  node.source_refs = parseJsonField(node.source_refs) ?? node.source_refs;
  node.source_context = parseJsonField(node.source_context) ?? node.source_context;
  node.substance = parseJsonField(node.substance) ?? node.substance;
  node.substance = applyOntologyGuidanceToSubstance(node.addr, node.substance);

  // Add computed agent-friendly fields
  const sub = node.substance || {};
  node.use_when = sub.provides?.length
    ? `Use this when you need: ${(sub.provides as string[]).join(", ")}`
    : null;
  node.ready = sub.readiness?.checks?.every((ch: any) => ch.tier === "green") ?? false;
  node.cost = sub.readiness?.cost || "unknown";

  // Get children
  let children = await sql`
    SELECT n.addr, n.label, n.layer, n.depth, n.confidence, n.temperature,
      n.visibility, n.node_type, n.source_context, n.space_id, n.substance->>'description' as description,
      r.access_level
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.parent_addr = ${addr}
      AND n.visibility <> 'deleted'
    ORDER BY n.position
  ` as any[];
  if (!operator) {
    children = filterReadableNodes(children, access);
  }
  children = children.map(({ visibility, node_type, source_context, description, access_level, space_id, ...child }: any) => child);

  // Get edges (both directions), stripped for readability
  const edgeRows = await sql`
    SELECT e.id, e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, 
      e.confidence, e.execution_count, e.success_count, e.last_executed,
      neighbor.visibility as neighbor_visibility,
      neighbor.node_type as neighbor_node_type,
      neighbor.source_context as neighbor_source_context,
      neighbor.space_id as neighbor_space_id,
      neighbor.substance->>'description' as neighbor_description,
      r.access_level as neighbor_access_level,
      CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END as neighbor_addr
    FROM edges e
    JOIN nodes neighbor
      ON neighbor.addr = CASE WHEN e.from_addr = ${addr} THEN e.to_addr ELSE e.from_addr END
    JOIN registry r ON r.pyramid_id = neighbor.pyramid_id
    WHERE (e.from_addr = ${addr} OR e.to_addr = ${addr})
      AND neighbor.visibility <> 'deleted'
    ORDER BY e.confidence DESC
  `;
  const edges = operator
    ? edgeRows
    : edgeRows
        .filter((edge: any) => isNodeReadableForScope(access, {
          visibility: edge.neighbor_visibility,
          node_type: edge.neighbor_node_type,
          source_context: edge.neighbor_source_context,
          description: edge.neighbor_description,
          access_level: edge.neighbor_access_level,
          label: edge.neighbor_addr,
          space_id: edge.neighbor_space_id,
        }))
        .map(({ neighbor_visibility, neighbor_node_type, neighbor_source_context, neighbor_description, neighbor_access_level, neighbor_space_id, ...edge }: any) => edge);
  if (operator) {
    for (const edge of edges as any[]) {
      delete edge.neighbor_visibility;
      delete edge.neighbor_node_type;
      delete edge.neighbor_source_context;
      delete edge.neighbor_description;
      delete edge.neighbor_access_level;
      delete edge.neighbor_space_id;
    }
  }
  const bridgeContext = await selectOntologyBridgeContext([addr], access, {
    anchorLimit: 4,
    bridgeLimit: 5,
    queryText: node.label,
  });
  const ontology = formatOntologyBridgePayload(bridgeContext);
  node.guidance = deriveNodeGuidance(node, ontology);

  // Inject corrections from unresolved edge_tensions
  try {
    // Tenant isolation: the corrections query joins both endpoints (nf/nt) of
    // each tension. For non-operators, constrain BOTH endpoints to visible
    // spaces plus the public/global clause (mirror /context tensions). Operator
    // (spaces === null) => no space filter, sees everything.
    const spaces = visibleSpaceIds(access);
    const accessLevels = allowedRegistryAccessLevels(c);
    const tensions = spaces === null
      ? await sql`
          SELECT et.id, et.tension_type, et.tension, et.synthesis, et.evidence
          FROM edge_tensions et
          JOIN nodes nf ON nf.addr = et.from_addr
          JOIN nodes nt ON nt.addr = et.to_addr
          WHERE (et.from_addr = ${addr} OR et.to_addr = ${addr})
            AND et.resolved_at IS NULL
            AND et.tension_type IN ('contradiction', 'constraint')
            AND nf.visibility <> 'deleted'
            AND nt.visibility <> 'deleted'
          ORDER BY et.tension DESC`
      : await sql`
          SELECT et.id, et.tension_type, et.tension, et.synthesis, et.evidence
          FROM edge_tensions et
          JOIN nodes nf ON nf.addr = et.from_addr
          JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
          JOIN nodes nt ON nt.addr = et.to_addr
          JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
          WHERE (et.from_addr = ${addr} OR et.to_addr = ${addr})
            AND et.resolved_at IS NULL
            AND et.tension_type IN ('contradiction', 'constraint')
            AND nf.space_id = ANY(${spaces}::text[])
            AND nt.space_id = ANY(${spaces}::text[])
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
          ORDER BY et.tension DESC`;

    if (tensions.length > 0) {
      node.corrections = tensions.map((t: any) => ({
        tension_id: t.id,
        type: t.tension_type,
        severity: t.tension,
        warning: t.synthesis,
        evidence: t.evidence,
        resolved: false,
      }));
    }
  } catch {
    // Non-fatal — skip if edge_tensions query fails
  }

  // Increment query hits (this node was useful enough to fetch)
  await sql`SELECT increment_query_hits(${[addr]}::text[])`;

  return c.json({
    node,
    children,
    edges: edges.map((edge: any) => ({
      ...edge,
      role: classifyGraphEdgeRole(edge.edge_type),
    })),
    ontology,
  });
});

// --- P7: Context Collapse — Substance Variants ---

// GET /nodes/:addr/variants — list all substance variants
nodes.get("/:addr/variants", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized");
  }
  const addr = c.req.param("addr");
  const [node] = await sql`SELECT addr, label, substance_variants FROM nodes WHERE addr = ${addr} AND visibility <> 'deleted'`;
  if (!node) return errorJson(c, "node_not_found");

  const variants = node.substance_variants || [];

  // Collapse history
  const collapses = await sql`
    SELECT variant_index, agent_id, context_summary, created_at
    FROM collapse_events WHERE node_addr = ${addr}
    ORDER BY created_at DESC LIMIT 20`;

  return c.json({
    addr: node.addr,
    label: node.label,
    variant_count: variants.length,
    variants,
    recent_collapses: collapses,
  });
});

// POST /nodes/:addr/variants — add a substance variant
nodes.post("/:addr/variants", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized");
  }
  const addr = c.req.param("addr");
  const body = await validateRequest(c, NodeVariantCreateSchema);

  const [node] = await sql`SELECT addr, substance_variants FROM nodes WHERE addr = ${addr} AND visibility <> 'deleted'`;
  if (!node) return errorJson(c, "node_not_found");

  const variants = node.substance_variants || [];
  const newVariant = {
    description: body.description,
    context: body.context || null,
    weight: body.weight ?? 1.0,
    created_at: new Date().toISOString(),
  };
  variants.push(newVariant);

  await sql`UPDATE nodes SET substance_variants = ${sql.json(variants)} WHERE addr = ${addr}`;

  return c.json({
    ok: true,
    addr,
    variant_index: variants.length - 1,
    variant_count: variants.length,
  });
});

// DELETE /nodes/:addr/variants/:index — remove a variant
nodes.delete("/:addr/variants/:index", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "unauthorized");
  }
  const addr = c.req.param("addr");
  // F12 Q10: variant index validation. parseInt("foo") is NaN, and the
  // pre-F12 `index < 0 || index >= variants.length` check let NaN fall
  // through to a successful "delete variant 0". Reject non-integer +
  // NaN explicitly before any DB access.
  const rawIndex = c.req.param("index");
  if (!/^\d+$/.test(rawIndex || "")) {
    return errorJson(c, "invalid_request", {
      message: `Variant index must be a non-negative integer, got: ${JSON.stringify(rawIndex)}`,
    });
  }
  const index = parseInt(rawIndex, 10);
  if (!Number.isFinite(index) || index < 0) {
    return errorJson(c, "invalid_request", {
      message: `Variant index must be a non-negative integer, got: ${rawIndex}`,
    });
  }

  const [node] = await sql`SELECT addr, substance_variants FROM nodes WHERE addr = ${addr} AND visibility <> 'deleted'`;
  if (!node) return errorJson(c, "node_not_found");

  const variants = node.substance_variants || [];
  if (index >= variants.length) {
    return errorJson(c, "invalid_request", {
      message: `Invalid variant index: ${index} (have ${variants.length})`,
    });
  }

  variants.splice(index, 1);
  await sql`UPDATE nodes SET substance_variants = ${sql.json(variants)} WHERE addr = ${addr}`;

  return c.json({ ok: true, addr, variant_count: variants.length });
});

export default nodes;
