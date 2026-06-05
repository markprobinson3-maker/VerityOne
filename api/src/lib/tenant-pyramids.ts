/**
 * Tenant pyramid helpers — manages tenant-owned organizational containers
 * above projects.
 *
 * Storage authority: `tenant_pyramids` table.
 *
 * NOT the same as graph ontology pyramids (WORLD, FUNCTION, META, etc.)
 * which live on nodes.pyramid_id. Tenant pyramids are a separate concept
 * for tenant policy/organization.
 *
 * First-cut auth: operator-only for mutations, tenant-scoped beta for reads
 * (same pattern as the project registry).
 */

type SqlTag = any;

// ── Types ───────────────────────────────────────────────────────────

export interface TenantPyramidRow {
  pyramid_id: string;
  tenant_id: string;
  label: string;
  description: string | null;
  kind: "system" | "user";
  system_key: string | null;
  sync_level: "local_only" | "managed_mirror";
  created_at: string;
  updated_at: string;
}

// ── System pyramid definitions ──────────────────────────────────────

interface SystemPyramidDef {
  system_key: string;
  default_label: string;
  default_sync_level: "local_only" | "managed_mirror";
}

const SYSTEM_PYRAMIDS: SystemPyramidDef[] = [
  { system_key: "memory", default_label: "Memory", default_sync_level: "managed_mirror" },
  { system_key: "skills", default_label: "Skills", default_sync_level: "managed_mirror" },
];

export const SYSTEM_TENANT_PYRAMID_COUNT = SYSTEM_PYRAMIDS.length;
export const VALID_SYNC_LEVELS = ["local_only", "managed_mirror"] as const;

// ── Bootstrap ───────────────────────────────────────────────────────

/**
 * Ensure the system tenant pyramids exist for a tenant. Idempotent.
 * Creates `memory` and `skills` system pyramids if they don't already exist.
 * Existing system pyramids are NOT modified (label/sync_level may have been
 * changed by the tenant — do not overwrite).
 */
export async function ensureTenantPyramids(
  sql: SqlTag,
  tenantId: string,
): Promise<void> {
  for (const def of SYSTEM_PYRAMIDS) {
    const [existing] = await sql`
      SELECT pyramid_id FROM tenant_pyramids
      WHERE tenant_id = ${tenantId} AND system_key = ${def.system_key}
    `;
    if (existing) continue;

    await sql`
      INSERT INTO tenant_pyramids (tenant_id, label, kind, system_key, sync_level)
      VALUES (${tenantId}, ${def.default_label}, 'system', ${def.system_key}, ${def.default_sync_level})
      ON CONFLICT (tenant_id, system_key) WHERE system_key IS NOT NULL DO NOTHING
    `;
  }
}

// ── Membership helpers ──────────────────────────────────────────────

/**
 * Resolve the `memory` system pyramid for a tenant.
 * Ensures system pyramids exist first.
 * Returns the pyramid_id or null if the table doesn't exist yet.
 */
export async function resolveMemoryPyramidId(
  sql: SqlTag,
  tenantId: string,
): Promise<string | null> {
  await ensureTenantPyramids(sql, tenantId);
  const [row] = await sql`
    SELECT pyramid_id FROM tenant_pyramids
    WHERE tenant_id = ${tenantId} AND system_key = 'memory'
  `;
  return row?.pyramid_id || null;
}

/**
 * Ensure all tenant projects have pyramid membership. Idempotent.
 * Assigns unassigned PROJECTS depth-1 roots to the `memory` system pyramid.
 * Call lazily from tenant-scoped read/write entry points.
 */
export async function ensureProjectPyramidMembership(
  sql: SqlTag,
  tenantId: string,
): Promise<void> {
  const memoryId = await resolveMemoryPyramidId(sql, tenantId);
  if (!memoryId) return; // table not ready

  const spaceId = `tenant:${tenantId}`;

  // Assign all unassigned project roots to `memory`
  await sql`
    UPDATE nodes
    SET tenant_pyramid_id = ${memoryId}::uuid, updated_at = now()
    WHERE pyramid_id = 'PROJECTS'
      AND depth = 1
      AND space_id = ${spaceId}
      AND tenant_pyramid_id IS NULL
  `;
}

// ── Read ────────────────────────────────────────────────────────────

/**
 * List all tenant pyramids for a tenant, system first then user, alpha by label.
 */
export async function listTenantPyramids(
  sql: SqlTag,
  tenantId: string,
): Promise<TenantPyramidRow[]> {
  const rows = await sql`
    SELECT pyramid_id, tenant_id, label, description, kind, system_key, sync_level,
           created_at, updated_at
    FROM tenant_pyramids
    WHERE tenant_id = ${tenantId}
    ORDER BY kind = 'system' DESC, label
  `;
  return rows as TenantPyramidRow[];
}

/**
 * Get a single tenant pyramid by its stable pyramid_id.
 */
export async function getTenantPyramid(
  sql: SqlTag,
  tenantId: string,
  pyramidId: string,
): Promise<TenantPyramidRow | null> {
  const [row] = await sql`
    SELECT pyramid_id, tenant_id, label, description, kind, system_key, sync_level,
           created_at, updated_at
    FROM tenant_pyramids
    WHERE tenant_id = ${tenantId} AND pyramid_id = ${pyramidId}::uuid
  `;
  return (row as TenantPyramidRow) || null;
}

/**
 * Resolve a tenant pyramid by name (case-insensitive).
 */
export async function resolvePyramidByName(
  sql: SqlTag,
  tenantId: string,
  name: string,
): Promise<TenantPyramidRow | null> {
  const [row] = await sql`
    SELECT pyramid_id, tenant_id, label, description, kind, system_key, sync_level,
           created_at, updated_at
    FROM tenant_pyramids
    WHERE tenant_id = ${tenantId} AND LOWER(label) = LOWER(${name})
  `;
  return (row as TenantPyramidRow) || null;
}

// ── Mutations ───────────────────────────────────────────────────────

export interface CreatePyramidResult {
  pyramid_id: string;
  label: string;
  sync_level: string;
}

/**
 * Create a new user tenant pyramid. System pyramids are created only
 * by ensureTenantPyramids(), not by this function.
 *
 * Enforces case-insensitive label uniqueness per tenant.
 * Default sync_level is local_only (safe default — tenant must
 * explicitly enable sync for new pyramids).
 */
export async function createTenantPyramid(
  sql: SqlTag,
  tenantId: string,
  label: string,
  syncLevel?: string,
): Promise<CreatePyramidResult> {
  const trimmedLabel = label.trim().slice(0, 120);
  if (!trimmedLabel) throw new Error("Label is required");

  const effectiveLevel = syncLevel || "local_only";
  if (!VALID_SYNC_LEVELS.includes(effectiveLevel as any)) {
    throw new Error(`Invalid sync_level "${effectiveLevel}". Valid: ${VALID_SYNC_LEVELS.join(", ")}`);
  }

  // Case-insensitive uniqueness check
  const conflict = await resolvePyramidByName(sql, tenantId, trimmedLabel);
  if (conflict) {
    throw new Error(`A tenant pyramid named "${conflict.label}" already exists for this tenant`);
  }

  const [row] = await sql`
    INSERT INTO tenant_pyramids (tenant_id, label, kind, system_key, sync_level)
    VALUES (${tenantId}, ${trimmedLabel}, 'user', NULL, ${effectiveLevel})
    RETURNING pyramid_id
  `;

  // Nudge sync scheduler — new pyramid affects managed_project_groupings
  // governance display metadata if the pyramid has managed_mirror level.
  try {
    const { nudgeSyncScheduler } = require("./sync-journal-port");
    nudgeSyncScheduler();
  } catch { /* scheduler may not be loaded */ }

  return { pyramid_id: row.pyramid_id, label: trimmedLabel, sync_level: effectiveLevel };
}

/**
 * Rename a tenant pyramid. Enforces case-insensitive uniqueness.
 * Works for both system and user pyramids (system_key stays stable).
 */
export async function renameTenantPyramid(
  sql: SqlTag,
  tenantId: string,
  pyramidId: string,
  newLabel: string,
): Promise<{ pyramid_id: string; old_label: string; new_label: string }> {
  const trimmedLabel = newLabel.trim().slice(0, 120);
  if (!trimmedLabel) throw new Error("New label is required");

  const pyramid = await getTenantPyramid(sql, tenantId, pyramidId);
  if (!pyramid) throw new Error(`Tenant pyramid not found: ${pyramidId}`);

  // Case-insensitive conflict check (excluding self)
  const [conflict] = await sql`
    SELECT pyramid_id, label FROM tenant_pyramids
    WHERE tenant_id = ${tenantId}
      AND LOWER(label) = LOWER(${trimmedLabel})
      AND pyramid_id != ${pyramidId}::uuid
  `;
  if (conflict) {
    throw new Error(`A tenant pyramid named "${conflict.label}" already exists`);
  }

  await sql`
    UPDATE tenant_pyramids SET label = ${trimmedLabel}, updated_at = now()
    WHERE pyramid_id = ${pyramidId}::uuid AND tenant_id = ${tenantId}
  `;

  // Nudge sync scheduler — rename affects managed_project_groupings display labels
  try {
    const { nudgeSyncScheduler } = require("./sync-journal-port");
    nudgeSyncScheduler();
  } catch { /* scheduler may not be loaded */ }

  return { pyramid_id: pyramidId, old_label: pyramid.label, new_label: trimmedLabel };
}

/**
 * Delete a user tenant pyramid. System pyramids cannot be deleted.
 * Non-empty pyramids (with assigned projects) cannot be deleted —
 * projects must be moved to another pyramid first.
 */
export async function deleteTenantPyramid(
  sql: SqlTag,
  tenantId: string,
  pyramidId: string,
): Promise<{ pyramid_id: string; label: string }> {
  const pyramid = await getTenantPyramid(sql, tenantId, pyramidId);
  if (!pyramid) throw new Error(`Tenant pyramid not found: ${pyramidId}`);
  if (pyramid.kind === "system") {
    throw new Error(`Cannot delete system pyramid "${pyramid.label}" (system_key: ${pyramid.system_key}). System pyramids are permanent.`);
  }

  // Check for assigned projects — reject delete if non-empty.
  // Without this check, deleting a pyramid would orphan projects with
  // a dead tenant_pyramid_id that ensureProjectPyramidMembership()
  // cannot self-heal (it only backfills NULL, not stale UUIDs).
  const spaceId = `tenant:${tenantId}`;
  const [{ count }] = await sql`
    SELECT COUNT(*)::int as count FROM nodes
    WHERE pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND tenant_pyramid_id = ${pyramidId}::uuid
      AND visibility <> 'deleted'
  `;
  if (count > 0) {
    throw new Error(`Cannot delete pyramid "${pyramid.label}": ${count} project(s) are still assigned. Move them first with: vo projects move <project> <other-grouping>`);
  }

  await sql`
    DELETE FROM tenant_pyramids
    WHERE pyramid_id = ${pyramidId}::uuid AND tenant_id = ${tenantId}
  `;

  // Nudge sync scheduler — deletion affects managed_project_groupings
  try {
    const { nudgeSyncScheduler } = require("./sync-journal-port");
    nudgeSyncScheduler();
  } catch { /* scheduler may not be loaded */ }

  return { pyramid_id: pyramidId, label: pyramid.label };
}

/**
 * Update the sync_level of a tenant pyramid.
 */
export async function setTenantPyramidLevel(
  sql: SqlTag,
  tenantId: string,
  pyramidId: string,
  syncLevel: string,
): Promise<{ pyramid_id: string; label: string; old_level: string; new_level: string }> {
  if (!VALID_SYNC_LEVELS.includes(syncLevel as any)) {
    throw new Error(`Invalid sync_level "${syncLevel}". Valid: ${VALID_SYNC_LEVELS.join(", ")}`);
  }

  const pyramid = await getTenantPyramid(sql, tenantId, pyramidId);
  if (!pyramid) throw new Error(`Tenant pyramid not found: ${pyramidId}`);

  await sql`
    UPDATE tenant_pyramids SET sync_level = ${syncLevel}, updated_at = now()
    WHERE pyramid_id = ${pyramidId}::uuid AND tenant_id = ${tenantId}
  `;

  // Nudge sync scheduler — sync_level changes affect the managed_project_addrs
  // governance allowlist. Without this nudge, the change would not reach the
  // hosted mirror until an unrelated mutation triggers a governance snapshot.
  try {
    const { nudgeSyncScheduler } = require("./sync-journal-port");
    nudgeSyncScheduler();
  } catch { /* scheduler may not be loaded */ }

  return { pyramid_id: pyramidId, label: pyramid.label, old_level: pyramid.sync_level, new_level: syncLevel };
}

/**
 * Set or clear a pyramid's description.
 */
export async function describeTenantPyramid(
  sql: SqlTag,
  tenantId: string,
  pyramidId: string,
  description: string | null,
): Promise<{ pyramid_id: string; description: string | null }> {
  const pyramid = await getTenantPyramid(sql, tenantId, pyramidId);
  if (!pyramid) throw new Error(`Tenant pyramid not found: ${pyramidId}`);

  await sql`
    UPDATE tenant_pyramids SET description = ${description}, updated_at = now()
    WHERE pyramid_id = ${pyramidId}::uuid AND tenant_id = ${tenantId}
  `;

  return { pyramid_id: pyramidId, description };
}
