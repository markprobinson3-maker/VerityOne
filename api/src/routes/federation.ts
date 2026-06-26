/**
 * /federation — Federated public overlay sync for local/public VO deployments.
 *
 * Routes:
 *   POST /federation/register   — Register a local VO node
 *   POST /federation/refresh    — Refresh access token (background-safe)
 *   GET  /federation/overlays   — Pull signed public overlays
 *   GET  /federation/nodes      — List registered nodes for tenant
 *   POST /federation/nodes/:id/revoke — Revoke a registered node
 *
 * Trust boundaries:
 *   - Private tenant memory NEVER syncs outbound by default
 *   - Public overlays NEVER silently overwrite tenant-local truth
 *   - Local recall MUST work offline (no inbound cloud dependency)
 *   - Sync is outbound-pull only (local node initiates)
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAccessContext } from "../lib/access";
import crypto from "node:crypto";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { clampInt } from "../lib/utils";
import { readBoundedJsonBody } from "../lib/bounded-body";

const federation = new Hono();

// Pre-auth /refresh body is tiny (tenant_id + node_id + refresh_token).
const FEDERATION_REFRESH_MAX_BODY_BYTES = 4_000;

// ── Helpers ──

function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Default overlay TTL: 1 hour
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

// ── POST /federation/register ──

federation.post("/register", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required for federation." });
  }

  const body = await c.req.json().catch(() => null);
  if (!body || !body.node_id || !body.node_label) {
    return errorJson(c, "invalid_request", { message: "node_id and node_label required" });
  }

  const nodeId = String(body.node_id).trim().slice(0, 120);
  const nodeLabel = String(body.node_label).trim().slice(0, 200);
  const publicKey = typeof body.public_key === "string" ? body.public_key.slice(0, 4000) : null;
  const capabilities = body.capabilities && typeof body.capabilities === "object"
    ? body.capabilities
    : { private_memory: true, public_overlay_pull: true };

  // Generate tokens
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();

  // Overlay verification key (TOFU: delivered at registration)
  const { ensureOverlaySigningKeypair } = await import("../lib/overlay-signing");
  const overlayKp = ensureOverlaySigningKeypair();

  await sql`
    INSERT INTO federation_nodes (node_id, tenant_id, node_label, public_key, capabilities, status, refresh_token_hash, access_token_hash, access_token_expires_at, last_seen_at)
    VALUES (
      ${nodeId},
      ${access.tenantId},
      ${nodeLabel},
      ${publicKey},
      ${sql.json(capabilities)},
      'active',
      ${hashToken(refreshToken)},
      ${hashToken(accessToken)},
      ${expiresAt},
      now()
    )
    ON CONFLICT (tenant_id, node_id) DO UPDATE SET
      node_label = EXCLUDED.node_label,
      public_key = COALESCE(EXCLUDED.public_key, federation_nodes.public_key),
      capabilities = EXCLUDED.capabilities,
      status = 'active',
      refresh_token_hash = EXCLUDED.refresh_token_hash,
      access_token_hash = EXCLUDED.access_token_hash,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      last_seen_at = now(),
      updated_at = now()
  `;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || nodeId,
    operation: "federation_register",
    eventData: { node_id: nodeId, node_label: nodeLabel, capability_keys: Object.keys(capabilities || {}) },
  });

  return c.json({
    ok: true,
    node_id: nodeId,
    tenant_id: access.tenantId,
    node_label: nodeLabel,
    status: "active",
    access_token: accessToken,
    access_token_expires_at: expiresAt,
    refresh_token: refreshToken,
    overlay_verify_key: overlayKp.publicKeyPem,
    capabilities,
    trust_boundaries: {
      private_memory_sync: "never_by_default",
      public_overlay_pull: "allowed",
      local_recall_offline: "guaranteed",
      inbound_cloud_dependency: "none",
    },
  });
});

// ── POST /federation/refresh ──

// Refresh is background-safe: authenticates via refresh_token + tenant_id + node_id.
// Does NOT require the ordinary tenant auth middleware. A local node can refresh
// from a cron/background context without an interactive session.

federation.post("/refresh", async (c) => {
  // Bounded read (B29-9): a PRE-AUTH endpoint whose auth material
  // (refresh_token) is IN the body, so it pre-buffers an attacker-supplied
  // body before any credential check. The legit body is tiny.
  const parsed = await readBoundedJsonBody(c, FEDERATION_REFRESH_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { tenant_id?: unknown; node_id?: unknown; refresh_token?: unknown } | null;
  if (!body || !body.tenant_id || !body.node_id || !body.refresh_token) {
    return errorJson(c, "invalid_request", { message: "tenant_id, node_id, and refresh_token required" });
  }

  const tenantId = String(body.tenant_id).trim();
  const nodeId = String(body.node_id).trim();
  const refreshHash = hashToken(String(body.refresh_token));

  const [node] = await sql`
    SELECT node_id, tenant_id, status, overlay_cursor
    FROM federation_nodes
    WHERE tenant_id = ${tenantId}
      AND node_id = ${nodeId}
      AND refresh_token_hash = ${refreshHash}
  `;

  if (!node) {
    return errorJson(c, "agent_token_invalid", { message: "Invalid tenant_id, node_id, or refresh_token" });
  }
  if (node.status === "revoked") {
    return errorJson(c, "federation_disabled", { message: "federation_node_revoked: node has been revoked" });
  }

  // Issue new tokens
  const accessToken = generateToken();
  const newRefreshToken = generateToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();

  // Overlay verification key (returned on every refresh for key rotation)
  const { ensureOverlaySigningKeypair } = await import("../lib/overlay-signing");
  const overlayKp = ensureOverlaySigningKeypair();

  await sql`
    UPDATE federation_nodes SET
      refresh_token_hash = ${hashToken(newRefreshToken)},
      access_token_hash = ${hashToken(accessToken)},
      access_token_expires_at = ${expiresAt},
      last_seen_at = now(),
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND node_id = ${nodeId}
  `;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId,
    actor: nodeId,
    actorKind: "hosted_agent",
    operation: "federation_refresh",
    eventData: { node_id: nodeId },
  });

  return c.json({
    ok: true,
    node_id: nodeId,
    tenant_id: tenantId,
    access_token: accessToken,
    access_token_expires_at: expiresAt,
    refresh_token: newRefreshToken,
    overlay_verify_key: overlayKp.publicKeyPem,
    overlay_cursor: node.overlay_cursor || null,
  });
});

// ── Federation bearer auth helper ──
// Authenticates overlay pull and future federation routes via
// Authorization: Bearer <federation_access_token>. Distinct from
// tenant auth (getAccessContext) and VO+ sync auth (sync tokens).

async function resolveFederationBearer(c: any): Promise<{
  tenant_id: string;
  node_id: string;
  capabilities: Record<string, unknown>;
} | null> {
  const auth = c.req.header("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;

  const tokenHash = hashToken(match[1].trim());
  const [node] = await sql`
    SELECT tenant_id, node_id, capabilities, status, access_token_expires_at
    FROM federation_nodes
    WHERE access_token_hash = ${tokenHash}
      AND status = 'active'
      AND access_token_expires_at > now()
  `;
  if (!node) return null;

  // Update last_seen_at
  sql`UPDATE federation_nodes SET last_seen_at = now() WHERE tenant_id = ${node.tenant_id} AND node_id = ${node.node_id}`.catch(() => {});

  return {
    tenant_id: node.tenant_id,
    node_id: node.node_id,
    capabilities: node.capabilities || {},
  };
}

// ── GET /federation/overlays ──
// Real signed overlay feed backed by public_contribution_events +
// node_publications + target nodes in the global space.
// Auth: federation bearer token (not tenant auth).

federation.get("/overlays", async (c) => {
  const fedNode = await resolveFederationBearer(c);
  if (!fedNode) {
    return errorJson(c, "agent_token_invalid", { message: "federation_auth_required: valid federation access token required. Use POST /federation/refresh to obtain one." });
  }

  // Capability check
  if (!fedNode.capabilities.public_overlay_pull) {
    return errorJson(c, "federation_disabled", { message: "federation_capability_denied: this node does not have public_overlay_pull capability." });
  }

  const cursor = c.req.query("cursor") || null;
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);

  // Parse cursor: "evt:<id>" format, or null for beginning
  let cursorId = 0;
  if (cursor) {
    const cursorMatch = cursor.match(/^evt:(\d+)$/);
    if (!cursorMatch) {
      return errorJson(c, "invalid_request", { message: "federation_invalid_cursor: cursor must be in 'evt:<id>' format or omitted for start." });
    }
    cursorId = parseInt(cursorMatch[1], 10);
  }

  // Query curated overlay items from public_contribution_events
  // joined to node_publications and target nodes in the global space.
  // Phase 1: upsert-only (publication_created / publication_updated).
  const events = await sql`
    SELECT
      e.id as event_id,
      e.event_type,
      e.target_addr,
      e.created_at as event_at,
      e.event_payload,
      p.id as publication_id,
      p.public_label,
      p.public_description,
      p.target_pyramid_id,
      p.public_node_type,
      p.publication_kind,
      p.status as publication_status,
      n.label as node_label,
      n.substance as node_substance,
      n.node_type as node_type,
      n.confidence as node_confidence
    FROM public_contribution_events e
    JOIN node_publications p ON p.id = e.publication_id
    JOIN nodes n ON n.addr = e.target_addr AND n.space_id = 'global' AND n.visibility <> 'deleted'
    WHERE e.id > ${cursorId}
      AND e.event_type IN ('publication_created', 'publication_updated', 'publication_archived', 'publication_superseded')
    ORDER BY e.id ASC
    LIMIT ${limit + 1}
  `;

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;

  // Sign each overlay item
  const { signOverlayItem } = await import("../lib/overlay-signing");

  const items = page.map((e: any) => {
    const stableOverlayId = `pub:${e.publication_id}`;
    const isLifecycleTerminal = e.event_type === "publication_archived" || e.event_type === "publication_superseded";
    const eventPayload = (e.event_payload || {}) as Record<string, unknown>;

    const overlayPayload: Record<string, unknown> = {
      overlay_id: stableOverlayId,
      event_id: e.event_id,
      kind: isLifecycleTerminal ? "tombstone" : "upsert",
      label: e.public_label || e.node_label || e.target_addr,
      assertion: isLifecycleTerminal ? null : (e.public_description || (e.node_substance as any)?.description || null),
      pyramid_id: e.target_pyramid_id,
      node_type: e.public_node_type || e.node_type || null,
      target_addr: e.target_addr,
      published_at: e.event_at,
      ...(isLifecycleTerminal ? {
        reason: (eventPayload.reason as string) || (e.event_type === "publication_superseded" ? "superseded" : "archived"),
        publication_status: e.event_type === "publication_superseded" ? "superseded" : "archived",
        ...(eventPayload.successor_overlay_id ? { successor_overlay_id: eventPayload.successor_overlay_id } : {}),
        ...(eventPayload.successor_target_addr ? { successor_target_addr: eventPayload.successor_target_addr } : {}),
      } : {}),
      federation: {
        authority: "public_overlay",
        sync_state: "public_overlay",
        upstream_origin: "vo_public",
        upstream_memory_id: stableOverlayId,
      },
    };
    const signature = signOverlayItem(overlayPayload);
    return { ...overlayPayload, signature };
  });

  // Compute the cursor that represents the end of this page.
  // The CLIENT owns cursor advancement — the server does NOT update
  // overlay_cursor here. The client should persist this cursor only
  // after successful local verification and import. This prevents a
  // loss window where a crash between fetch and import would skip
  // overlays the node never committed.
  const lastEventId = page.length > 0 ? page[page.length - 1].event_id : cursorId;
  const endCursor = `evt:${lastEventId}`;

  return c.json({
    ok: true,
    cursor: cursor || "evt:0",
    end_cursor: endCursor,
    has_more: hasMore,
    items,
    count: items.length,
    note: "Cursor ownership: persist end_cursor locally only after successful import. Do not rely on server-side cursor tracking for loss prevention.",
    trust_rule: "Public overlays are additive only. They NEVER overwrite or mutate tenant-local memories. Import them as authority=public_overlay, sync_state=public_overlay.",
    federation_provenance: {
      source: "vo-public",
      authority: "public_overlay",
      sync_state: "public_overlay",
    },
  });
});

// ── GET /federation/nodes ──

federation.get("/nodes", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required." });
  }

  const nodes = await sql`
    SELECT node_id, node_label, status, capabilities, last_seen_at,
      access_token_expires_at, overlay_cursor, created_at, updated_at
    FROM federation_nodes
    WHERE tenant_id = ${access.tenantId}
    ORDER BY created_at DESC
  `;

  return c.json({
    ok: true,
    tenant_id: access.tenantId,
    count: nodes.length,
    nodes: nodes.map((n: any) => ({
      node_id: n.node_id,
      node_label: n.node_label,
      status: n.status,
      capabilities: n.capabilities,
      last_seen_at: n.last_seen_at,
      access_token_expires_at: n.access_token_expires_at,
      overlay_cursor: n.overlay_cursor,
      created_at: n.created_at,
    })),
  });
});

// ── POST /federation/nodes/:id/revoke ──

federation.post("/nodes/:id/revoke", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required." });
  }

  const nodeId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof (body as any)?.reason === "string" ? (body as any).reason : null;

  const [existing] = await sql`
    SELECT status FROM federation_nodes
    WHERE tenant_id = ${access.tenantId} AND node_id = ${nodeId}
  `;

  if (!existing) {
    return errorJson(c, "node_not_found", { message: "Node not found" });
  }

  await sql`
    UPDATE federation_nodes SET
      status = 'revoked',
      refresh_token_hash = NULL,
      updated_at = now()
    WHERE tenant_id = ${access.tenantId} AND node_id = ${nodeId}
  `;

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    operation: "federation_node_revoke",
    eventData: { node_id: nodeId, reason },
  });

  return c.json({
    ok: true,
    node_id: nodeId,
    status: "revoked",
    reason,
    trust_note: "Revoked nodes can no longer refresh tokens or pull overlays. Existing local memories are unaffected — local recall continues to work offline.",
  });
});

// ── POST /federation/link-challenge ────────────────────────────────────
// Proof-of-control for VO+ account linking. The CLI calls this on the
// LOCAL api to get a signed challenge that proves it controls this node.
// The signed challenge is then presented to the hosted service to
// finalize the account↔tenant binding.

import { signLinkChallenge, loadPublicKeyPem } from "../lib/node-keypair";

federation.post("/link-challenge", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required for link challenge." });
  }

  // The caller must specify which node_id they are linking. This
  // prevents the route from accidentally signing a challenge for a
  // different device on a multi-device tenant.
  const body = await c.req.json().catch(() => null);
  const requestedNodeId = (body?.node_id || "").trim();
  if (!requestedNodeId) {
    return errorJson(c, "invalid_request", { message: "node_id is required in the request body." });
  }

  // Find the SPECIFIC node for this tenant
  const [node] = await sql`
    SELECT node_id, public_key FROM federation_nodes
    WHERE tenant_id = ${access.tenantId}
      AND node_id = ${requestedNodeId}
      AND status = 'active'
  `;
  if (!node) {
    return errorJson(c, "node_not_found", {
      message: `No active federation node "${requestedNodeId}" found for tenant "${access.tenantId}". Run: vo init`,
    });
  }

  // Ensure we have a public key registered
  const pubKeyPem = loadPublicKeyPem();
  if (!pubKeyPem) {
    return errorJson(c, "invalid_request", {
      message: "No node keypair found. Re-run: vo init --force --tenant <id> to generate one.",
    });
  }

  // Update public key in federation_nodes if not already set
  if (!node.public_key) {
    await sql`
      UPDATE federation_nodes SET public_key = ${pubKeyPem}, updated_at = now()
      WHERE tenant_id = ${access.tenantId} AND node_id = ${node.node_id}
    `;
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: access.tenantId,
      actor: access.agentId || node.node_id,
      operation: "federation_link_challenge_key_update",
      eventData: { node_id: node.node_id },
    });
  }

  // Sign the challenge (5 minute TTL)
  const exp = Math.floor(Date.now() / 1000) + 300;
  const signedChallenge = signLinkChallenge({
    tenant_id: access.tenantId,
    node_id: node.node_id,
    exp,
  });

  return c.json({
    ok: true,
    challenge: signedChallenge,
    tenant_id: access.tenantId,
    node_id: node.node_id,
    public_key: pubKeyPem,
    expires_in_seconds: 300,
  });
});

export default federation;
