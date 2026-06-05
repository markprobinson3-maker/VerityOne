/**
 * Local overlay import engine — pulls signed public overlays from the
 * federation feed, verifies signatures, and imports into local storage.
 *
 * Imported overlays live in `nodes` with `space_id = 'overlay:<tenant_id>'`.
 * They are additive, provenance-labeled, and never overwrite tenant-local
 * truth. Cursor ownership is local-only: the cursor advances only after
 * successful verification and import of a complete page.
 *
 * Imported overlays participate in local recall as subordinate,
 * provenance-labeled context (shipped in Phase 3).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type postgres from "postgres";
import { resolveConfigPath } from "./runtime-profile";
import { verifyOverlaySignature } from "./overlay-signing";
import { allocateChildSlotInTx } from "./ontology";
import { canonicalizePyramidId, type KnownPyramidId } from "./graph-shape";
import { embedTextForInsert, embeddingTextForNode } from "@verity-one/embed";
// F12: canonical maturity_stage origin.
import { coalesceMaturityStage } from "@verity-one/graph-shape";

type SqlTag = ReturnType<typeof postgres>;

export interface OverlayAuditOptions {
  correlationId?: string | null;
}

// ── Local federation state ──────────────────────────────────────────
// Persisted at ~/.vo/overlay-state.json. Contains only what the local
// node needs to pull and verify overlays without calling hosted.

export interface OverlayState {
  base_url: string;
  tenant_id: string;
  node_id: string;
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  overlay_verify_key: string;
  overlay_cursor: string | null;
  last_pull_at: string | null;
  last_pull_error: string | null;
}

function overlayStatePath(): string {
  return path.join(path.dirname(resolveConfigPath()), "overlay-state.json");
}

export function loadOverlayState(): OverlayState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(overlayStatePath(), "utf-8"));
    if (!raw.base_url || !raw.tenant_id || !raw.node_id || !raw.refresh_token || !raw.overlay_verify_key) return null;
    return raw as OverlayState;
  } catch {
    return null;
  }
}

export function saveOverlayState(state: OverlayState): void {
  const p = overlayStatePath();
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * Initialize overlay state from a federation register/refresh response.
 */
export function initOverlayState(
  baseUrl: string,
  tenantId: string,
  nodeId: string,
  response: {
    access_token: string;
    access_token_expires_at: string;
    refresh_token: string;
    overlay_verify_key: string;
    overlay_cursor?: string | null;
  },
): OverlayState {
  const state: OverlayState = {
    base_url: baseUrl,
    tenant_id: tenantId,
    node_id: nodeId,
    access_token: response.access_token,
    access_token_expires_at: response.access_token_expires_at,
    refresh_token: response.refresh_token,
    overlay_verify_key: response.overlay_verify_key,
    overlay_cursor: response.overlay_cursor || null,
    last_pull_at: null,
    last_pull_error: null,
  };
  saveOverlayState(state);
  return state;
}

// ── Token refresh ───────────────────────────────────────────────────

async function refreshAccessToken(
  state: OverlayState,
  baseUrl: string,
): Promise<{ ok: true; state: OverlayState } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/federation/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: state.tenant_id,
        node_id: state.node_id,
        refresh_token: state.refresh_token,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, error: `Refresh failed: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    return { ok: false, error: `Refresh failed (HTTP ${res.status}): ${body.error || res.statusText}` };
  }

  const body = await res.json() as any;
  state.access_token = body.access_token;
  state.access_token_expires_at = body.access_token_expires_at;
  state.refresh_token = body.refresh_token;
  if (body.overlay_verify_key) {
    state.overlay_verify_key = body.overlay_verify_key;
  }
  saveOverlayState(state);
  return { ok: true, state };
}

// ── Graph space creation ────────────────────────────────────────────

async function ensureOverlayGraphSpace(sql: SqlTag, tenantId: string): Promise<void> {
  const spaceId = `overlay:${tenantId}`;
  await sql`
    INSERT INTO graph_spaces (
      space_id, tenant_id, kind, label, description,
      overlay_parent_space_id, storage_backend, network_scope, sync_mode
    ) VALUES (
      ${spaceId},
      ${tenantId},
      'overlay',
      'Public overlays',
      'Signed public knowledge imported from VO control plane',
      ${'tenant:' + tenantId},
      'server',
      'wan',
      'manual'
    ) ON CONFLICT (space_id) DO NOTHING
  `;
}

// ── Import a single verified overlay item ───────────────────────────

export async function importOverlayItem(
  sql: SqlTag,
  tenantId: string,
  nodeId: string,
  item: Record<string, unknown>,
  opts: OverlayAuditOptions = {},
): Promise<void> {
  const overlayId = item.overlay_id as string;
  const spaceId = `overlay:${tenantId}`;
  const pyramidId: KnownPyramidId =
    canonicalizePyramidId(typeof item.pyramid_id === "string" ? item.pyramid_id : null) || "HEURISTIC";
  const nodeType = typeof item.node_type === "string" ? item.node_type : "pattern";
  const label = (item.label as string) || overlayId;

  const federation = item.federation as Record<string, unknown>;
  const memoryType = typeof item.memory_type === "string"
    ? item.memory_type
    : typeof item.node_type === "string"
      ? item.node_type
      : "context";
  const substance: Record<string, unknown> = {
    description: item.assertion || item.label || null,
    memory_type: memoryType,
    source_kind: "system_generated",
    federation: {
      authority: federation.authority,
      sync_state: federation.sync_state,
      upstream_origin: federation.upstream_origin,
      upstream_memory_id: federation.upstream_memory_id,
      last_synced_at: new Date().toISOString(),
    },
    overlay_source: {
      overlay_id: overlayId,
      event_id: item.event_id || null,
      target_addr: item.target_addr || null,
      published_at: item.published_at || null,
      signature: item.signature || null,
    },
  };

  // F7: compute the document embedding BEFORE the INSERT/UPDATE.
  // No more silent-catch — embed failure aborts the overlay import so
  // we never insert a node with NULL embedding_hv. Matches the F7
  // write-safety bar (NOT NULL on the column + fail-closed at the
  // route boundary). embeddingTextForNode picks high-signal fields in
  // the canonical order; embedTextForInsert uses RETRIEVAL_DOCUMENT.
  const embed = await embedTextForInsert(
    embeddingTextForNode(label, substance),
  );

  // Upsert by overlay_id, not by a synthetic OVL.* addr. F6 requires
  // every node.addr to use the canonical pyramid address contract, so
  // overlay identity lives in substance.overlay_source.overlay_id while
  // the physical row gets a normal allocated slot.
  const hash = crypto.createHash("md5").update(`${overlayId}:${label}`).digest("hex");
  const [result] = await sql.begin(async (tx: any) => {
    const [existing] = await tx`
      SELECT addr
      FROM nodes
      WHERE space_id = ${spaceId}
        AND substance->'overlay_source'->>'overlay_id' = ${overlayId}
        AND visibility <> 'deleted'
      LIMIT 1
    `;

    if (existing) {
      await tx`
        UPDATE nodes SET
          label = ${label},
          substance = ${tx.json(substance as any)},
          pyramid_id = ${pyramidId},
          node_type = ${nodeType},
          hash = ${hash},
          embedding_hv = ${embed.vecStr}::halfvec(3072),
          embedding_at = ${embed.embeddedAt},
          embedding_model = ${embed.model},
          embedding_task_type = ${embed.taskType},
          dormant_at = NULL,
          updated_at = now()
        WHERE addr = ${existing.addr}
          AND space_id = ${spaceId}
          AND visibility <> 'deleted'
      `;
      return [{ addr: existing.addr as string }];
    }

    const slot = await allocateChildSlotInTx(tx, pyramidId, null, { defaultDepth: 3 });
    await tx`
      INSERT INTO nodes (
        addr, label, substance, pyramid_id, layer, depth, position, node_type, space_id,
        confidence, hash, provenance, visibility,
        embedding_hv, embedding_at, embedding_model, embedding_task_type,
        created_at, updated_at
      ) VALUES (
        ${slot.addr},
        ${label},
        ${tx.json(substance as any)},
        ${pyramidId},
        0,
        ${slot.depth},
        ${slot.position},
        ${nodeType},
        ${spaceId},
        0.5,
        ${hash},
        ${tx.json({ source: "overlay_import", overlay_id: overlayId })},
        'public',
        ${embed.vecStr}::halfvec(3072),
        ${embed.embeddedAt},
        ${embed.model},
        ${embed.taskType},
        now(),
        now()
      )
    `;
    return [{ addr: slot.addr }];
  });
  const overlayAddr = result.addr;

  // Log to federation_overlay_log
  await sql`
    INSERT INTO federation_overlay_log (tenant_id, node_id, overlay_id, overlay_addr, synced_at, correlation_id)
    VALUES (${tenantId}, ${nodeId}, ${overlayId}, ${overlayAddr}, now(), ${opts.correlationId ?? null})
  `;
}

// ── Tombstone a previously imported overlay ─────────────────────────
// Marks the local overlay row as withdrawn by setting dormant_at.
// The recall compiler already excludes dormant rows by default.
// Does NOT delete the row — provenance is preserved.

export async function tombstoneOverlayItem(
  sql: SqlTag,
  tenantId: string,
  nodeId: string,
  item: Record<string, unknown>,
  opts: OverlayAuditOptions = {},
): Promise<void> {
  const overlayId = item.overlay_id as string;
  const spaceId = `overlay:${tenantId}`;

  // Check if the overlay exists locally
  const [existing] = await sql`
    SELECT addr
    FROM nodes
    WHERE space_id = ${spaceId}
      AND substance->'overlay_source'->>'overlay_id' = ${overlayId}
      AND visibility <> 'deleted'
    LIMIT 1
  `;

  if (existing) {
    // Mark as withdrawn — recall compiler's dormant filter excludes these
    const reason = (item.reason as string) || "archived";
    const publicationStatus = (item.publication_status as string) || "archived";
    const withdrawal: Record<string, unknown> = {
      reason,
      publication_status: publicationStatus,
      withdrawn_at: new Date().toISOString(),
      event_id: item.event_id || null,
    };
    // Preserve successor linkage for supersession
    if (item.successor_overlay_id) {
      withdrawal.successor_overlay_id = item.successor_overlay_id;
    }
    if (item.successor_target_addr) {
      withdrawal.successor_target_addr = item.successor_target_addr;
    }
    await sql`
      UPDATE nodes SET
        dormant_at = now(),
        substance = jsonb_set(
          COALESCE(substance, '{}'::jsonb),
          '{federation,withdrawal}',
          ${sql.json(withdrawal as any)}
        ),
        updated_at = now()
      WHERE addr = ${existing.addr}
        AND space_id = ${spaceId}
        AND visibility <> 'deleted'
    `;
  }
  // If not imported locally, no-op — the tombstone is for a publication
  // this node never pulled. Safe to advance cursor past it.

  // Log the lifecycle sync event
  await sql`
    INSERT INTO federation_overlay_log (tenant_id, node_id, overlay_id, overlay_addr, synced_at, correlation_id)
    VALUES (${tenantId}, ${nodeId}, ${overlayId}, ${existing?.addr || null}, now(), ${opts.correlationId ?? null})
  `;
}

// ── Repair pre-fix imported overlay rows ─────────────────────────────
// Normalizes substance.memory_type and substance.source_kind on
// already-imported overlay rows that were written before those fields
// were added to importOverlayItem(). Idempotent — only touches rows
// that are actually missing the fields. Does NOT touch tenant-local
// rows, dormant/lifecycle state, embeddings, or cursor.

export interface RepairResult {
  rows_scanned: number;
  rows_repaired: number;
  rows_already_ok: number;
}

// ── Promote overlay to tenant-local memory ──────────────────────────

export interface PromotionResult {
  ok: boolean;
  promoted: boolean;
  already_promoted: boolean;
  memory_addr?: string;
  overlay_addr: string;
  overlay_id?: string;
  source_kind?: string;
  error?: string;
}

export async function promoteOverlay(
  sql: SqlTag,
  tenantId: string,
  overlayAddr: string,
  caller: { agentId: string | null; isHuman: boolean },
  reason?: string,
  opts: OverlayAuditOptions = {},
): Promise<PromotionResult> {
  const spaceId = `overlay:${tenantId}`;
  const tenantSpaceId = `tenant:${tenantId}`;

  // 1. Load the overlay row
  const [overlay] = await sql`
    SELECT addr, label, substance, node_type, dormant_at
    FROM nodes
    WHERE addr = ${overlayAddr} AND space_id = ${spaceId}
      AND visibility <> 'deleted'
  `;
  if (!overlay) {
    return { ok: false, promoted: false, already_promoted: false, overlay_addr: overlayAddr, error: "Overlay not found in this tenant's overlay space." };
  }
  if (overlay.dormant_at) {
    return { ok: false, promoted: false, already_promoted: false, overlay_addr: overlayAddr, error: "Cannot promote a dormant (archived/superseded) overlay." };
  }

  const substance = (overlay.substance || {}) as Record<string, unknown>;
  const federation = (substance.federation || {}) as Record<string, unknown>;
  const overlaySource = (substance.overlay_source || {}) as Record<string, unknown>;
  const overlayId = (overlaySource.overlay_id as string) || (federation.upstream_memory_id as string) || null;

  // Fail closed: source linkage is required for auditable promotion
  if (!overlayId) {
    return { ok: false, promoted: false, already_promoted: false, overlay_addr: overlayAddr, error: "Overlay is missing source identity (overlay_id / upstream_memory_id). Cannot create auditable promoted memory." };
  }

  // 2. Idempotency check: already promoted?
  const [existing] = await sql`
    SELECT addr FROM nodes
    WHERE space_id = ${tenantSpaceId}
      AND substance->'promoted_from'->>'overlay_id' = ${overlayId}
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
      LIMIT 1
    `;
  if (existing) {
    return { ok: true, promoted: false, already_promoted: true, memory_addr: existing.addr, overlay_addr: overlayAddr, overlay_id: overlayId, source_kind: undefined };
  }

  // 3. Determine caller-honest source_kind
  const sourceKind = caller.isHuman ? "user_accepted" : "agent_inferred";
  const acceptedByUser = caller.isHuman;

  // 4. Build promoted memory substance
  const memoryType = (substance.memory_type as string) || overlay.node_type || "context";
  const assertion = (substance.description as string) || (overlay.label as string) || "";
  const label = (overlay.label as string || "").slice(0, 120) || assertion.slice(0, 120);

  const promotedSubstance: Record<string, unknown> = {
    description: assertion,
    memory_type: memoryType,
    source_kind: sourceKind,
    accepted_by_user: acceptedByUser,
    maturity_stage: coalesceMaturityStage(undefined),
    created_at: new Date().toISOString(),
    federation: {
      authority: "tenant_local",
      sync_state: "local_only",
    },
    promoted_from: {
      overlay_addr: overlayAddr,
      overlay_id: overlayId,
      upstream_origin: federation.upstream_origin || null,
      upstream_memory_id: federation.upstream_memory_id || null,
      target_addr: overlaySource.target_addr || null,
      promoted_at: new Date().toISOString(),
      promoted_by: caller.agentId || "operator",
      ...(reason ? { reason } : {}),
    },
  };

  // F7: compute the document embedding before the transaction. No
  // silent-catch — embed failure aborts the promotion so the new
  // memory node never lands with a NULL embedding. Uses canonical
  // text selection + document task type.
  const promotedEmbed = await embedTextForInsert(
    embeddingTextForNode(label, promotedSubstance),
  );

  // 6. Atomic: advisory lock + re-check idempotency + allocate + insert
  // Uses the same REMEMBER_LOCK_ID (900_001) as /memory/write to prevent
  // address allocation collisions between promotion and normal writes.
  const REMEMBER_LOCK_ID = 900_001;
  const hash = crypto.createHash("md5").update(overlayAddr + label).digest("hex");
  let addr: string;

  const [result] = await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(${REMEMBER_LOCK_ID})`;

    // Re-check idempotency inside the lock to prevent concurrent duplicate
    const [existingInTx] = await tx`
      SELECT addr FROM nodes
      WHERE space_id = ${tenantSpaceId}
        AND substance->'promoted_from'->>'overlay_id' = ${overlayId}
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
      LIMIT 1
    `;
    if (existingInTx) {
      return [{ addr: existingInTx.addr, already: true }];
    }

    const slot = await allocateChildSlotInTx(tx, "PROJECTS", null, { defaultDepth: 3 });
    const newAddr = slot.addr;

    await tx`
      INSERT INTO nodes (
        addr, pyramid_id, layer, depth, position, label, substance, confidence, hash, provenance,
        visibility, space_id, node_type,
        embedding_hv, embedding_at, embedding_model, embedding_task_type,
        created_at, updated_at
      )
      VALUES (
        ${newAddr}, 'PROJECTS', 0, ${slot.depth}, ${slot.position},
        ${label},
        ${tx.json(promotedSubstance as any)},
        0.80,
        ${hash},
        ${tx.json({ agent: caller.agentId || "overlay-promotion", date: new Date().toISOString().slice(0, 10), source: sourceKind })},
        'private',
        ${tenantSpaceId},
        'memory',
        ${promotedEmbed.vecStr}::halfvec(3072),
        ${promotedEmbed.embeddedAt},
        ${promotedEmbed.model},
        ${promotedEmbed.taskType},
        now(), now()
      )
    `;

    // F11: sync journal upsert inside the transaction so the journal row
    // commits with the promotion. Best-effort error handling.
    const { tryJournalMemoryInTx } = await import("./sync-journal-port");
    await tryJournalMemoryInTx(tx as any, "upsert", newAddr, tenantSpaceId, null, "[overlay-import]");

    return [{ addr: newAddr, already: false }];
  });

  if (result.already) {
    return { ok: true, promoted: false, already_promoted: true, memory_addr: result.addr, overlay_addr: overlayAddr, overlay_id: overlayId, source_kind: undefined };
  }
  addr = result.addr;

  // 6. Registry + event (fire-and-forget, non-blocking). These remain
  // outside the primary tx pre-F11; F11 narrows to sync journal only.
  try {
    const { insertRegistry, logEvent } = await import("./memory-lifecycle");
    await insertRegistry(sql as any, {
      addr, tenantId, kind: memoryType as any, sourceKind: sourceKind as any,
      sourceRef: caller.agentId || "overlay-promotion",
      acceptedByUser,
    });
    await logEvent(sql as any, addr, tenantId, "created", caller.agentId || "overlay-promotion", {
      kind: memoryType, source: sourceKind, promoted_from_overlay: overlayAddr,
    }, { correlationId: opts.correlationId ?? null });
  } catch { /* lifecycle logging is non-fatal */ }

  return {
    ok: true, promoted: true, already_promoted: false,
    memory_addr: addr, overlay_addr: overlayAddr, overlay_id: overlayId || undefined,
    source_kind: sourceKind,
  };
}

// ── Inspect overlay normalization state (read-only) ─────────────────

export interface NormalizationInspection {
  total_overlay_rows: number;
  missing_memory_type: number;
  missing_source_kind: number;
  missing_either: number;
  fully_normalized: number;
}

export async function inspectOverlayNormalization(
  sql: SqlTag,
  tenantId: string,
): Promise<NormalizationInspection> {
  const spaceId = `overlay:${tenantId}`;
  const [counts] = await sql`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE substance->>'memory_type' IS NULL)::int as missing_memory_type,
      COUNT(*) FILTER (WHERE substance->>'source_kind' IS NULL)::int as missing_source_kind,
      COUNT(*) FILTER (WHERE substance->>'memory_type' IS NULL OR substance->>'source_kind' IS NULL)::int as missing_either
    FROM nodes
    WHERE space_id = ${spaceId}
      AND substance->'federation'->>'authority' = 'public_overlay'
      AND visibility <> 'deleted'
  `;
  return {
    total_overlay_rows: counts?.total || 0,
    missing_memory_type: counts?.missing_memory_type || 0,
    missing_source_kind: counts?.missing_source_kind || 0,
    missing_either: counts?.missing_either || 0,
    fully_normalized: (counts?.total || 0) - (counts?.missing_either || 0),
  };
}

// ── Repair pre-fix imported overlay rows ─────────────────────────────

export async function repairOverlaySubstance(
  sql: SqlTag,
  tenantId: string,
): Promise<RepairResult> {
  const spaceId = `overlay:${tenantId}`;

  // Find imported overlay rows missing memory_type or source_kind
  const rows = await sql`
    SELECT addr, node_type, substance
    FROM nodes
    WHERE space_id = ${spaceId}
      AND substance->'federation'->>'authority' = 'public_overlay'
      AND visibility <> 'deleted'
      AND (
        substance->>'memory_type' IS NULL
        OR substance->>'source_kind' IS NULL
      )
  `;

  let repaired = 0;
  for (const row of rows) {
    const substance = (row.substance || {}) as Record<string, unknown>;
    const memoryType = (substance.memory_type as string) || row.node_type || "context";
    const sourceKind = (substance.source_kind as string) || "system_generated";

    await sql`
      UPDATE nodes SET
        substance = substance
          || jsonb_build_object('memory_type', ${memoryType}::text)
          || jsonb_build_object('source_kind', ${sourceKind}::text),
        updated_at = now()
      WHERE addr = ${row.addr}
        AND space_id = ${spaceId}
        AND visibility <> 'deleted'
    `;
    repaired++;
  }

  // Count total overlay rows for reporting
  const [{ total }] = await sql`
    SELECT COUNT(*)::int as total FROM nodes
    WHERE space_id = ${spaceId}
      AND substance->'federation'->>'authority' = 'public_overlay'
      AND visibility <> 'deleted'
  `;

  return {
    rows_scanned: total,
    rows_repaired: repaired,
    rows_already_ok: total - repaired,
  };
}

// ── One-shot startup repair runner (testable seam) ──────────────────
// Called by both index.ts (automatic) and tests (deterministic).
// Returns null if there is nothing to repair (no tenant, no space).

export interface AutoRepairResult {
  ran: boolean;
  reason?: string;
  repair?: RepairResult;
}

/**
 * Pre-serve startup normalization gate. Ensures all imported overlay
 * rows have normalized substance fields before recall can be served.
 *
 * Returns AutoRepairResult on success or no-op.
 * THROWS on repair failure for an existing overlay space — the caller
 * (index.ts) must catch this and abort startup.
 */
export async function runStartupOverlayRepair(
  sqlConn: SqlTag,
): Promise<AutoRepairResult> {
  // 1. Read tenant_id from config
  let tenantId: string | null = null;
  try {
    const fs = await import("node:fs");
    const cfgPath = resolveConfigPath();
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    tenantId = cfg.tenant_id || null;
  } catch {
    return { ran: false, reason: "no_config" };
  }
  if (!tenantId) return { ran: false, reason: "no_tenant_id" };

  // 2. Check if overlay space exists
  const [spaceCheck] = await sqlConn`
    SELECT 1 FROM graph_spaces WHERE space_id = ${'overlay:' + tenantId}
  `;
  if (!spaceCheck) return { ran: false, reason: "no_overlay_space" };

  // 3. Run repair
  const result = await repairOverlaySubstance(sqlConn, tenantId);
  return { ran: true, repair: result };
}

// ── Verify and import a page of items (testable seam) ───────────────
// Extracted from the pull loop so tests can exercise the same
// signature verification, kind dispatch, and import path without HTTP.

export interface PageImportResult {
  ok: boolean;
  error?: string;
  items_imported: number;
  items_failed: number;
}

export async function verifyAndImportPage(
  sql: SqlTag,
  tenantId: string,
  nodeId: string,
  overlayVerifyKey: string,
  items: Array<Record<string, unknown>>,
  opts: OverlayAuditOptions = {},
): Promise<PageImportResult> {
  let imported = 0;
  for (const item of items) {
    if (!item.overlay_id || typeof item.overlay_id !== "string") {
      return { ok: false, error: "Item missing overlay_id", items_imported: imported, items_failed: 1 };
    }
    if (!item.signature || typeof item.signature !== "string") {
      return { ok: false, error: `Item ${item.overlay_id} missing signature`, items_imported: imported, items_failed: 1 };
    }
    if (!item.federation || (item.federation as any).authority !== "public_overlay") {
      return { ok: false, error: `Item ${item.overlay_id} missing or invalid federation metadata`, items_imported: imported, items_failed: 1 };
    }
    if (item.kind !== "upsert" && item.kind !== "tombstone") {
      return { ok: false, error: `Item ${item.overlay_id} has unsupported kind "${item.kind}"`, items_imported: imported, items_failed: 1 };
    }

    const { signature, ...payloadWithoutSig } = item;
    if (!verifyOverlaySignature(payloadWithoutSig, signature as string, overlayVerifyKey)) {
      return { ok: false, error: `Item ${item.overlay_id} has invalid signature`, items_imported: imported, items_failed: 1 };
    }

    try {
      if (item.kind === "tombstone") {
        await tombstoneOverlayItem(sql, tenantId, nodeId, item, opts);
      } else {
        await importOverlayItem(sql, tenantId, nodeId, item, opts);
      }
      imported++;
    } catch (e) {
      return { ok: false, error: `Import failed for ${item.overlay_id}: ${(e as Error).message}`, items_imported: imported, items_failed: 1 };
    }
  }
  return { ok: true, items_imported: imported, items_failed: 0 };
}

// ── Pull lock ───────────────────────────────────────────────────────
// Prevents concurrent pulls (scheduler + manual CLI) from racing on
// overlay-state.json. Only one caller can hold the lock at a time.
// The lock is a file created with O_EXCL; released by unlinking.

function pullLockPath(): string {
  return path.join(path.dirname(resolveConfigPath()), "overlay-pull.lock");
}

function acquirePullLock(): boolean {
  try {
    // O_EXCL: fail if file already exists (another pull is running)
    const fd = fs.openSync(pullLockPath(), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    // Write PID for diagnosis
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return true;
  } catch {
    // Check for stale lock (process that created it is gone)
    try {
      const lockContent = fs.readFileSync(pullLockPath(), "utf-8").trim();
      const lockPid = parseInt(lockContent, 10);
      if (lockPid && lockPid !== process.pid) {
        // Check if that process is still alive
        try { process.kill(lockPid, 0); } catch {
          // Process is dead — stale lock. Remove and retry.
          fs.unlinkSync(pullLockPath());
          return acquirePullLock();
        }
      }
    } catch { /* lock file unreadable — treat as held */ }
    return false;
  }
}

function releasePullLock(): void {
  try { fs.unlinkSync(pullLockPath()); } catch { /* already gone */ }
}

// ── Pull and import ─────────────────────────────────────────────────

export interface PullResult {
  ok: boolean;
  error?: string;
  pages_fetched: number;
  items_imported: number;
  items_skipped: number;
  items_failed: number;
  cursor_before: string | null;
  cursor_after: string | null;
}

export async function pullAndImportOverlays(
  sql: SqlTag,
  opts?: { limit?: number; maxPages?: number },
): Promise<PullResult> {
  // Acquire exclusive pull lock to prevent concurrent pulls from
  // racing on overlay-state.json (scheduler + manual CLI).
  if (!acquirePullLock()) {
    return { ok: false, error: "Another overlay pull is already in progress.", pages_fetched: 0, items_imported: 0, items_skipped: 0, items_failed: 0, cursor_before: null, cursor_after: null };
  }

  try {
    return await _pullAndImportInner(sql, opts);
  } finally {
    releasePullLock();
  }
}

async function _pullAndImportInner(
  sql: SqlTag,
  opts?: { limit?: number; maxPages?: number },
): Promise<PullResult> {
  const state = loadOverlayState();
  if (!state) {
    return { ok: false, error: "No overlay state. Run federation registration first (vo init).", pages_fetched: 0, items_imported: 0, items_skipped: 0, items_failed: 0, cursor_before: null, cursor_after: null };
  }
  // Non-null binding for the failResult closure below: control-flow narrowing
  // of `state` does not carry into nested function bodies.
  const activeState = state;

  const baseUrl = state.base_url;
  const limit = opts?.limit || 20;
  const maxPages = opts?.maxPages || 10;
  const cursorBefore = state.overlay_cursor;

  let cursor = state.overlay_cursor || null;

  // Helper: persist error to overlay state before returning a failure result.
  // This makes `vo overlay status` useful after a failed pull.
  function failResult(error: string, partial?: Partial<PullResult>): PullResult {
    activeState.last_pull_error = error;
    activeState.last_pull_at = new Date().toISOString();
    saveOverlayState(activeState);
    return { ok: false, error, pages_fetched: 0, items_imported: 0, items_skipped: 0, items_failed: 0, cursor_before: cursorBefore, cursor_after: cursor, ...partial };
  }

  // Refresh token if expired
  const expiresAt = new Date(state.access_token_expires_at || 0).getTime();
  if (Date.now() > expiresAt - 60_000) {
    const refreshResult = await refreshAccessToken(state, baseUrl);
    if (!refreshResult.ok) {
      return failResult(refreshResult.error!);
    }
  }

  // Ensure overlay graph space exists
  await ensureOverlayGraphSpace(sql, state.tenant_id);

  let totalImported = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    // Fetch one page
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    qs.set("limit", String(limit));

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/federation/overlays?${qs}`, {
        headers: { Authorization: `Bearer ${state.access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return failResult(`Feed fetch failed: ${(e as Error).message}`, { pages_fetched: pagesFetched, items_imported: totalImported, items_failed: totalFailed });
    }

    // 401 → try refresh once then retry
    if (res.status === 401 && page === 0) {
      const refreshResult = await refreshAccessToken(state, baseUrl);
      if (!refreshResult.ok) {
        return failResult(`Auth failed and refresh failed: ${refreshResult.error}`);
      }
      try {
        res = await fetch(`${baseUrl}/federation/overlays?${qs}`, {
          headers: { Authorization: `Bearer ${state.access_token}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return failResult(`Feed fetch failed after refresh: ${(e as Error).message}`);
      }
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      return failResult(`Feed fetch failed (HTTP ${res.status}): ${body.error || res.statusText}`, { pages_fetched: pagesFetched, items_imported: totalImported, items_failed: totalFailed });
    }

    const body = await res.json() as any;
    const items = body.items || [];
    pagesFetched++;

    if (items.length === 0) break;

    // Verify and import the page through the shared seam.
    // This is the SAME function exercised by tests — no parallel reimplementation.
    const pageResult = await verifyAndImportPage(sql, state.tenant_id, state.node_id, state.overlay_verify_key, items);
    totalImported += pageResult.items_imported;
    totalFailed += pageResult.items_failed;
    if (!pageResult.ok) {
      return failResult(pageResult.error || "Page import failed", { pages_fetched: pagesFetched, items_imported: totalImported, items_failed: totalFailed });
    }

    // Page fully verified and imported. Advance local cursor.
    cursor = body.end_cursor || cursor;
    state.overlay_cursor = cursor;
    state.last_pull_at = new Date().toISOString();
    state.last_pull_error = null;
    saveOverlayState(state);

    if (!body.has_more) break;
  }

  return { ok: true, pages_fetched: pagesFetched, items_imported: totalImported, items_skipped: totalSkipped, items_failed: totalFailed, cursor_before: cursorBefore, cursor_after: cursor };
}
