/**
 * Project registry helper — manages PROJECTS depth-1 root nodes as the
 * canonical project registry for a tenant.
 *
 * Storage authority: `nodes` table, `pyramid_id='PROJECTS' AND depth=1`.
 * No new table, no file. The graph IS the registry.
 *
 * First-cut auth: operator-only for mutations, tenant-scoped beta for reads.
 */

import { journalProject, nudgeSyncScheduler } from "./sync-journal-port";
import { withAllocatedChildSlot } from "./ontology";
import { embedTextForInsert, embeddingTextForNode } from "@verity-one/embed";

type SqlTag = any;

export interface ProjectRow {
  addr: string;
  label: string;
  node_type: string;
  visibility: string;
  space_id: string;
  dormant_at: string | null;
  created_at: string;
  description: string | null;
  memory_count: number;
  tenant_pyramid_id: string | null;
  pyramid_label: string | null;
  pyramid_kind: string | null;
  pyramid_system_key: string | null;
}

// ── Read ───────────────────────────────────────────────────────────────

/**
 * List all projects for a tenant, with memory counts and pyramid membership.
 * Returns active projects first, then archived.
 */
export async function listProjects(sql: SqlTag, spaceId: string): Promise<ProjectRow[]> {
  const rows = await sql`
    SELECT
      n.addr,
      n.label,
      n.node_type,
      n.visibility,
      n.space_id,
      n.dormant_at,
      n.created_at,
      n.substance->>'description' as description,
      n.tenant_pyramid_id,
      tp.label as pyramid_label,
      tp.kind as pyramid_kind,
      tp.system_key as pyramid_system_key,
      (
        SELECT COUNT(*)::int FROM nodes m
        WHERE m.substance->>'project_addr' = n.addr
          AND m.space_id = ${spaceId}
          AND m.node_type = 'memory'
          AND m.visibility <> 'deleted'
      ) as memory_count
    FROM nodes n
    LEFT JOIN tenant_pyramids tp ON tp.pyramid_id = n.tenant_pyramid_id
    WHERE n.pyramid_id = 'PROJECTS'
      AND n.depth = 1
      AND n.space_id = ${spaceId}
      AND n.visibility <> 'deleted'
    ORDER BY n.dormant_at IS NOT NULL, n.label
  `;
  return rows as ProjectRow[];
}

/**
 * Resolve an active project by name (case-insensitive) within a tenant space.
 * Returns null if not found, throws if ambiguous.
 */
export async function resolveProjectByName(
  sql: SqlTag,
  spaceId: string,
  name: string,
): Promise<ProjectRow | null> {
  const rows = await sql`
    SELECT
      n.addr, n.label, n.node_type, n.visibility, n.space_id,
      n.dormant_at, n.created_at,
      n.substance->>'description' as description,
      0 as memory_count
    FROM nodes n
    WHERE n.pyramid_id = 'PROJECTS'
      AND n.depth = 1
      AND n.space_id = ${spaceId}
      AND n.visibility <> 'deleted'
      AND LOWER(n.label) = LOWER(${name})
      AND n.dormant_at IS NULL
  `;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`Ambiguous project name "${name}": ${rows.length} active matches`);
  }
  return rows[0] as ProjectRow;
}

/**
 * Resolve a project (active OR archived) by name within a tenant space.
 * Used for archive/unarchive operations that may target either state.
 */
export async function resolveProjectByNameAnyState(
  sql: SqlTag,
  spaceId: string,
  name: string,
  archivedOnly: boolean = false,
): Promise<ProjectRow | null> {
  const rows = await sql`
    SELECT
      n.addr, n.label, n.node_type, n.visibility, n.space_id,
      n.dormant_at, n.created_at,
      n.substance->>'description' as description,
      0 as memory_count
    FROM nodes n
    WHERE n.pyramid_id = 'PROJECTS'
      AND n.depth = 1
      AND n.space_id = ${spaceId}
      AND n.visibility <> 'deleted'
      AND LOWER(n.label) = LOWER(${name})
      ${archivedOnly ? sql`AND n.dormant_at IS NOT NULL` : sql``}
    ORDER BY n.dormant_at IS NULL DESC
    LIMIT 1
  `;
  return (rows[0] as ProjectRow) || null;
}

// ── Uniqueness ─────────────────────────────────────────────────────────

/**
 * Check if an active project with the given label already exists
 * (case-insensitive). Returns the conflicting project or null.
 *
 * `excludeAddr` allows rename to skip the project being renamed.
 */
export async function checkActiveNameConflict(
  sql: SqlTag,
  spaceId: string,
  label: string,
  excludeAddr?: string,
): Promise<ProjectRow | null> {
  const rows = await sql`
    SELECT addr, label FROM nodes
    WHERE pyramid_id = 'PROJECTS'
      AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
      AND LOWER(label) = LOWER(${label})
      AND dormant_at IS NULL
      ${excludeAddr ? sql`AND addr != ${excludeAddr}` : sql``}
    LIMIT 1
  `;
  return (rows[0] as ProjectRow) || null;
}

// ── Mutations ──────────────────────────────────────────────────────────

export interface CreateProjectResult {
  addr: string;
  label: string;
  already_existed: boolean;
  tenant_pyramid_id?: string;
}

/**
 * Create a new PROJECTS depth-1 root node.
 * Enforces case-insensitive uniqueness among active projects.
 * Assigns tenant_pyramid_id — defaults to `memory` system pyramid
 * if not specified.
 */
export async function createProject(
  sql: SqlTag,
  spaceId: string,
  label: string,
  description?: string,
  tenantPyramidId?: string,
): Promise<CreateProjectResult> {
  const trimmedLabel = label.trim().slice(0, 120);
  if (!trimmedLabel) throw new Error("Label is required");

  // Case-insensitive uniqueness check
  const conflict = await checkActiveNameConflict(sql, spaceId, trimmedLabel);
  if (conflict) {
    return { addr: conflict.addr, label: conflict.label, already_existed: true };
  }

  // Resolve tenant pyramid membership. If not specified, use `memory`.
  let pyramidId = tenantPyramidId || null;
  if (!pyramidId) {
    const tenantId = spaceId.replace("tenant:", "");
    const { resolveMemoryPyramidId } = require("./tenant-pyramids");
    pyramidId = await resolveMemoryPyramidId(sql, tenantId);
  }

  const substance: Record<string, unknown> = {
    description: description || "",
    project_type: "standard",
    created_at: new Date().toISOString(),
  };

  // F7: compute the document embedding before allocation. The
  // withAllocatedChildSlot callback is fail-closed inside the
  // advisory lock; embed failures abort the project creation rather
  // than landing a NULL-embedding row.
  const projectEmbed = await embedTextForInsert(
    embeddingTextForNode(trimmedLabel, substance),
  );

  const addr = await withAllocatedChildSlot(
    sql,
    "PROJECTS",
    "PJ.0.0.1",
    async (tx, slot) => {
      await tx`
        INSERT INTO nodes (
          addr, pyramid_id, layer, depth, position, label, substance, confidence, hash, provenance,
          visibility, space_id, node_type, parent_addr, tenant_pyramid_id,
          embedding_hv, embedding_at, embedding_model, embedding_task_type
        )
        VALUES (
          ${slot.addr}, 'PROJECTS', 0, ${slot.depth}, ${slot.position},
          ${trimmedLabel},
          ${tx.json(substance)},
          0.95,
          md5(${slot.addr + "-" + trimmedLabel.toLowerCase().replace(/\s+/g, "-")}),
          ${tx.json({ agent: "vo-projects", date: new Date().toISOString().slice(0, 10), source: "tenant_created" })},
          'private',
          ${spaceId},
          'project',
          'PJ.0.0.1',
          ${pyramidId},
          ${projectEmbed.vecStr}::halfvec(3072),
          ${projectEmbed.embeddedAt},
          ${projectEmbed.model},
          ${projectEmbed.taskType}
        )
      `;
      return slot.addr;
    },
    { defaultDepth: 1 },
  );

  // Sync journal: project upsert. Best-effort outside the primary mutation —
  // F11 narrowed the transactional move to the journalMemory paths (F0 #5).
  // project mutations remain post-tx; .catch keeps this fire-and-forget under
  // the F11 awaitable contract.
  journalProject(sql, "upsert", addr, spaceId).catch((e) =>
    console.error("[project-registry] journalProject failed:", e?.message),
  );

  return { addr, label: trimmedLabel, already_existed: false, tenant_pyramid_id: pyramidId || undefined };
}

/**
 * Rename a project. Enforces case-insensitive uniqueness.
 * Addr does not change.
 */
export async function renameProject(
  sql: SqlTag,
  spaceId: string,
  addr: string,
  newLabel: string,
): Promise<{ addr: string; old_label: string; new_label: string }> {
  const trimmedLabel = newLabel.trim().slice(0, 120);
  if (!trimmedLabel) throw new Error("New label is required");

  // Verify the project exists and is in the right space
  const [project] = await sql`
    SELECT addr, label, substance FROM nodes
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
  `;
  if (!project) throw new Error(`Project not found: ${addr}`);

  // Case-insensitive conflict check (excluding self)
  const conflict = await checkActiveNameConflict(sql, spaceId, trimmedLabel, addr);
  if (conflict) {
    throw new Error(`Active project "${conflict.label}" (${conflict.addr}) already has that name`);
  }

  // F7: project rename changes the label which is the dominant signal
  // in embeddingTextForNode. Compute the embedding before the UPDATE so
  // the DB connection is not held across the network call, then write
  // the semantic field + marker columns atomically in one statement.
  const renamedEmbed = await embedTextForInsert(
    embeddingTextForNode(trimmedLabel, project.substance),
  );
  const renamedRows = await sql`
    UPDATE nodes
    SET label = ${trimmedLabel},
        embedding_hv = ${renamedEmbed.vecStr}::halfvec(3072),
        embedding_at = ${renamedEmbed.embeddedAt},
        embedding_model = ${renamedEmbed.model},
        embedding_task_type = ${renamedEmbed.taskType},
        updated_at = now()
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
      AND substance IS NOT DISTINCT FROM ${sql.json(project.substance ?? null)}::jsonb
    RETURNING addr
  `;
  if (renamedRows.length === 0) {
    throw new Error(`Project changed or was deleted while rename embedding was being computed: ${addr}`);
  }

  // Sync journal: project upsert (rename). Best-effort post-mutation.
  journalProject(sql, "upsert", addr, spaceId).catch((e) =>
    console.error("[project-registry] journalProject (rename) failed:", e?.message),
  );

  return { addr, old_label: project.label, new_label: trimmedLabel };
}

/**
 * Archive a project (set dormant_at, visibility=dormant).
 */
export async function archiveProject(
  sql: SqlTag,
  spaceId: string,
  addr: string,
): Promise<{ addr: string; label: string }> {
  const [project] = await sql`
    SELECT addr, label, dormant_at FROM nodes
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
  `;
  if (!project) throw new Error(`Project not found: ${addr}`);
  if (project.dormant_at) throw new Error(`Project "${project.label}" is already archived`);

  const archivedRows = await sql`
    UPDATE nodes
    SET dormant_at = now(), visibility = 'dormant', updated_at = now()
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  if (archivedRows.length === 0) {
    throw new Error(`Project changed or was deleted while archive was being applied: ${addr}`);
  }

  // Sync journal: project archive. Best-effort post-mutation.
  journalProject(sql, "archive", addr, spaceId).catch((e) =>
    console.error("[project-registry] journalProject (archive) failed:", e?.message),
  );

  return { addr, label: project.label };
}

/**
 * Unarchive a project (clear dormant_at, restore visibility=private).
 * Fails if the label now conflicts with an active project.
 */
export async function unarchiveProject(
  sql: SqlTag,
  spaceId: string,
  addr: string,
): Promise<{ addr: string; label: string }> {
  const [project] = await sql`
    SELECT addr, label, dormant_at FROM nodes
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
  `;
  if (!project) throw new Error(`Project not found: ${addr}`);
  if (!project.dormant_at) throw new Error(`Project "${project.label}" is not archived`);

  // Check conflict with active projects
  const conflict = await checkActiveNameConflict(sql, spaceId, project.label, addr);
  if (conflict) {
    throw new Error(`Cannot unarchive: active project "${conflict.label}" (${conflict.addr}) has the same name`);
  }

  const unarchivedRows = await sql`
    UPDATE nodes
    SET dormant_at = NULL, visibility = 'private', updated_at = now()
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  if (unarchivedRows.length === 0) {
    throw new Error(`Project changed or was deleted while unarchive was being applied: ${addr}`);
  }

  // Sync journal: project upsert (unarchive = re-activate). Best-effort.
  journalProject(sql, "upsert", addr, spaceId).catch((e) =>
    console.error("[project-registry] journalProject (unarchive) failed:", e?.message),
  );

  return { addr, label: project.label };
}

/**
 * Move a project to a different tenant pyramid.
 * Changes tenant_pyramid_id and nudges the sync scheduler so the
 * managed_project_addrs governance allowlist is updated promptly.
 * Does NOT change addr or memory linkage.
 */
export async function moveProject(
  sql: SqlTag,
  spaceId: string,
  addr: string,
  tenantPyramidId: string,
): Promise<{ addr: string; label: string; old_pyramid_id: string | null; new_pyramid_id: string }> {
  const [project] = await sql`
    SELECT addr, label, tenant_pyramid_id FROM nodes
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
  `;
  if (!project) throw new Error(`Project not found: ${addr}`);

  const movedRows = await sql`
    UPDATE nodes SET tenant_pyramid_id = ${tenantPyramidId}::uuid, updated_at = now()
    WHERE addr = ${addr}
      AND pyramid_id = 'PROJECTS' AND depth = 1
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  if (movedRows.length === 0) {
    throw new Error(`Project changed or was deleted while move was being applied: ${addr}`);
  }

  // Sync journal: project upsert (move is a policy-relevant event). Best-effort.
  journalProject(sql, "upsert", addr, spaceId).catch((e) =>
    console.error("[project-registry] journalProject (move) failed:", e?.message),
  );

  // Nudge sync scheduler — project moves affect the managed_project_addrs
  // governance allowlist on the hosted side. Routed through the sync-journal-port
  // seam (no-op in the OSS build); best-effort.
  try {
    nudgeSyncScheduler();
  } catch { /* scheduler nudge is best-effort */ }

  return {
    addr,
    label: project.label,
    old_pyramid_id: project.tenant_pyramid_id || null,
    new_pyramid_id: tenantPyramidId,
  };
}
