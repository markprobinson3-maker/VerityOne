/**
 * /proposals — Submit new knowledge for review
 * 
 * Agents and users propose new nodes or corrections.
 * Everything goes through staging — nothing enters the graph unchecked.
 * Status: pending → revised → approved/rejected
 */

import crypto from "node:crypto";

import { Hono } from "hono";
import { sql } from "../db";
import {
  VALID_NODE_TYPES,
  canonicalizePyramidId,
  CORE_PYRAMID_IDS,
} from "../lib/graph-shape";
import { withAllocatedChildSlot } from "../lib/ontology";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { validateTenantSlug } from "../lib/tenant-name";

const proposals = new Hono();

// Input limits to prevent queue bloat
const MAX_LABEL_LEN = 200;
const MAX_DESC_LEN = 5000;
const MAX_FIELD_LEN = 2000;
const MAX_REASON_LEN = 2000;
const MAX_PROVIDES = 20;

function proposalAuditTenant(agent?: string): string {
  if (agent) {
    const mapped = (process.env.VERITY_AGENT_TENANTS || "")
      .split(",")
      .map((p) => p.trim().split(":"))
      .find(([aid]) => aid === agent)?.[1];
    if (mapped) return mapped;
  }
  return process.env.VERITY_DEFAULT_TENANT_ID || "system";
}

// Strip HTML tags to prevent stored XSS if proposals are ever rendered in UI
function sanitize(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

interface NodeProposal {
  label: string;
  description: string;
  node_type?: string;       // tool | skill | workflow | concept
  provides?: string[];
  pyramid?: string;         // default: FUNCTION
  parent_addr?: string;
  agent?: string;
  basis?: string;           // asserted | observed | inferred
  evidence?: string;        // supporting context
}

interface CorrectionProposal {
  addr: string;             // node to correct
  field: string;            // which field is wrong
  current_value?: string;   // what it says now
  proposed_value: string;   // what it should say
  reason: string;
  agent?: string;
}

// POST /proposals/node — propose a new node
proposals.post("/node", async (c) => {
  let body: NodeProposal;
  try {
    body = await c.req.json<NodeProposal>();
  } catch {
    return errorJson(c, "invalid_request", {
      message: "JSON body required",
      details: {
        format: { label: "string (required)", description: "string (required)", node_type: "tool|skill|workflow|concept", provides: "string[]", agent: "string" },
      },
    });
  }

  if (!body.label || !body.description) {
    return errorJson(c, "invalid_request", { message: "label and description are required" });
  }

  // Sanitize and enforce size limits
  body.label = truncate(sanitize(body.label), MAX_LABEL_LEN);
  body.description = truncate(sanitize(body.description), MAX_DESC_LEN);
  if (body.evidence) body.evidence = truncate(sanitize(body.evidence), MAX_FIELD_LEN);
  if (body.provides) body.provides = body.provides.slice(0, MAX_PROVIDES).map(p => truncate(sanitize(p), 100));
  if (body.parent_addr) body.parent_addr = truncate(sanitize(body.parent_addr), MAX_FIELD_LEN);

  if (body.label.length === 0) {
    return errorJson(c, "invalid_request", { message: "label cannot be empty after sanitization" });
  }

  // MT10: a random suffix makes run_id collision-proof — two tenants' proposals in the
  // same millisecond no longer share a run_id, so /proposals/status can never return
  // the wrong tenant's row on a Date.now() collision.
  const runId = `proposal-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const pyramid = canonicalizePyramidId(body.pyramid || "FUNCTION");
  if (!pyramid) {
    return errorJson(c, "pyramid_unknown", {
      message: `Unsupported pyramid. Use one of: ${[...CORE_PYRAMID_IDS].join(", ")}.`,
    });
  }

  const normalizedNodeType = (body.node_type || "concept").trim().toLowerCase();
  if (!VALID_NODE_TYPES.includes(normalizedNodeType as (typeof VALID_NODE_TYPES)[number])) {
    return errorJson(c, "invalid_request", { message: `Unsupported node_type. Use one of: ${VALID_NODE_TYPES.join(", ")}` });
  }

  let parentAddr = body.parent_addr || null;
  if (parentAddr) {
    const [parent] = await sql`
      SELECT addr, pyramid_id, depth
      FROM nodes
      WHERE addr = ${parentAddr}
        AND visibility <> 'deleted'`;
    if (!parent) return errorJson(c, "invalid_request", { message: `Parent not found: ${parentAddr}` });
    if (parent.pyramid_id !== pyramid) {
      return errorJson(c, "invalid_request", { message: `Parent ${parentAddr} belongs to ${parent.pyramid_id}, expected ${pyramid}` });
    }
    if (parent.depth !== 1) {
      return errorJson(c, "invalid_request", { message: `Parent ${parentAddr} must be a depth-1 branch for depth-2 proposals` });
    }
  } else {
    const [defaultParent] = await sql`
      SELECT addr
      FROM nodes
      WHERE pyramid_id = ${pyramid}
        AND depth = 1
        AND visibility <> 'deleted'
      ORDER BY position ASC
      LIMIT 1`;
    if (!defaultParent) {
      return errorJson(c, "invalid_request", { message: `No depth-1 parent branch found for pyramid ${pyramid}` });
    }
    parentAddr = defaultParent.addr;
  }

  const addr = await withAllocatedChildSlot(
    sql,
    pyramid,
    parentAddr,
    async (tx, slot) => {
      await tx`
        INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility, qc_status, qc_agent, qc_notes)
        VALUES (
          ${runId}, ${slot.addr}, ${pyramid}, 0, ${slot.depth}, ${slot.position},
          ${body.label},
          ${JSON.stringify({
            description: body.description,
            provides: body.provides || [],
            node_type: normalizedNodeType,
          })},
          0.50, ${parentAddr}, 'public', 'pending',
          ${body.agent || "anonymous"},
          ${body.evidence || null}
        )`;
      return slot.addr;
    },
  );

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: proposalAuditTenant(body.agent),
    actor: body.agent || "anonymous",
    operation: "proposal_node",
    eventData: { run_id: runId, proposed_addr: addr, pyramid, node_type: normalizedNodeType },
  });

  return c.json({
    ok: true,
    status: "pending",
    proposed_addr: addr,
    run_id: runId,
    message: "Proposal submitted for review. It will appear in the graph after approval.",
    check: `GET /proposals/status?run_id=${runId}`,
  });
});

// POST /proposals/correction — propose a fix to an existing node
proposals.post("/correction", async (c) => {
  let body: CorrectionProposal;
  try {
    body = await c.req.json<CorrectionProposal>();
  } catch {
    return errorJson(c, "invalid_request", {
      message: "JSON body required",
      details: {
        format: { addr: "string (required)", field: "string (required)", proposed_value: "string (required)", reason: "string (required)" },
      },
    });
  }

  if (!body.addr || !body.field || !body.proposed_value || !body.reason) {
    return errorJson(c, "invalid_request", { message: "addr, field, proposed_value, and reason are required" });
  }

  // Sanitize and enforce size limits
  body.proposed_value = truncate(sanitize(body.proposed_value), MAX_FIELD_LEN);
  body.reason = truncate(sanitize(body.reason), MAX_REASON_LEN);
  if (body.current_value) body.current_value = truncate(sanitize(body.current_value), MAX_FIELD_LEN);

  // Verify node exists
  const [node] = await sql`SELECT addr, label FROM nodes WHERE addr = ${body.addr} AND visibility <> 'deleted'`;
  if (!node) return errorJson(c, "node_not_found", { message: `Node not found: ${body.addr}` });

  const runId = `correction-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  await sql`
    INSERT INTO staging_updates (run_id, addr, field, old_value, new_value, reason, qc_status, qc_agent)
    VALUES (
      ${runId}, ${body.addr}, ${body.field},
      ${body.current_value ? sql`${body.current_value}::jsonb` : sql`null`},
      ${sql.json(body.proposed_value)},
      ${body.reason},
      'pending', ${body.agent || "anonymous"}
    )`;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: proposalAuditTenant(body.agent),
    actor: body.agent || "anonymous",
    operation: "proposal_correction",
    eventData: { run_id: runId, addr: body.addr, field: body.field },
  });

  return c.json({
    ok: true,
    status: "pending",
    addr: body.addr,
    label: node.label,
    field: body.field,
    run_id: runId,
    message: `Correction proposed for ${node.label}. Pending review.`,
  });
});

// GET /proposals/status/:run_id or /proposals/status?run_id=... — check proposal status
proposals.get("/status/:run_id", async (c) => {
  const runId = c.req.param("run_id");
  return getProposalStatus(c, runId);
});
proposals.get("/status", async (c) => {
  const runId = c.req.query("run_id");
  if (!runId) return errorJson(c, "invalid_request", { message: "run_id parameter required. Use /proposals/status?run_id=... or /proposals/status/:run_id" });
  return getProposalStatus(c, runId);
});

async function getProposalStatus(c: any, runId: string) {
  // MT10: optional ?tenant_id= scopes the status lookup to one tenant's space (the
  // run_id is collision-proof, but an operator reviewing a specific tenant can pin the
  // lookup to that space). Absent = operator-wide (any space), as before.
  const rawTenant = c.req.query("tenant_id");
  let space: string | null = null;
  if (rawTenant != null && rawTenant.trim() !== "") {
    const valid = validateTenantSlug(rawTenant);
    if (valid.ok !== true) {
      return errorJson(c, "invalid_request", { message: `tenant_id is invalid: ${valid.message}` });
    }
    space = `tenant:${valid.slug}`;
  }

  const [node] = await sql`
    SELECT addr, label, qc_status, qc_agent, qc_notes, created_at
    FROM staging_nodes
    WHERE run_id = ${runId} AND (${space}::text IS NULL OR space_id = ${space})`;

  const [correction] = await sql`
    SELECT addr, field, new_value, reason, qc_status, qc_agent, qc_notes, created_at
    FROM staging_updates
    WHERE run_id = ${runId} AND (${space}::text IS NULL OR space_id = ${space})`;

  const result = node || correction;
  if (!result) return errorJson(c, "not_found", { message: `No proposal found with run_id: ${runId}` });

  return c.json({
    run_id: runId,
    type: node ? "node" : "correction",
    status: result.qc_status,
    addr: result.addr,
    label: node?.label || undefined,
    created_at: result.created_at,
    reviewer: result.qc_agent,
    notes: result.qc_notes || null,
  });
}

// GET /proposals/pending — view what's waiting for review (operator-only).
// MT10: an optional ?tenant_id= scopes the pending queue to ONE tenant's space so an
// operator can review per tenant; absent = operator-wide (every space), as before.
// The staging tables carry space_id (tenant-overlay-foundation), so this is a pure
// filter — no new column. The `(space IS NULL OR space_id = space)` guard keeps the
// unfiltered path identical.
proposals.get("/pending", async (c) => {
  const rawTenant = c.req.query("tenant_id");
  let space: string | null = null;
  if (rawTenant != null && rawTenant.trim() !== "") {
    const valid = validateTenantSlug(rawTenant);
    if (valid.ok !== true) {
      return errorJson(c, "invalid_request", { message: `tenant_id is invalid: ${valid.message}` });
    }
    space = `tenant:${valid.slug}`;
  }

  const nodes = await sql`
    SELECT id, addr, label, substance->>'description' AS description, qc_agent, qc_notes, created_at
    FROM staging_nodes
    WHERE qc_status = 'pending'
      AND (${space}::text IS NULL OR space_id = ${space})
    ORDER BY created_at DESC LIMIT 20`;

  const corrections = await sql`
    SELECT id, addr, field, old_value, new_value, reason, qc_agent, created_at
    FROM staging_updates
    WHERE qc_status = 'pending'
      AND (${space}::text IS NULL OR space_id = ${space})
    ORDER BY created_at DESC LIMIT 20`;

  return c.json({
    scope: space ? "tenant" : "operator",
    tenant_id: space ? space.replace(/^tenant:/, "") : null,
    pending_nodes: nodes.length,
    pending_corrections: corrections.length,
    nodes,
    corrections,
  });
});

export default proposals;
