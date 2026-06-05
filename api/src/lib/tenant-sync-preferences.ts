export interface TenantSyncPreferences {
  tenant_id: string;
  project_mode: "all" | "selected";
  selected_project_addrs: string[];
  graph_enabled: boolean;
  projects_enabled: boolean;
  vault_metadata_enabled: boolean;
  drive_mirror_enabled: boolean;
  source: "vow_request" | "vol_sync";
  updated_by_account_id: string | null;
  updated_at: string | null;
}

export const HOSTED_SYNC_PROJECTION_SNAPSHOT_KEY = "__hosted_projection_snapshot";
export const HOSTED_SYNC_PROJECTION_DELTA_KEY = "__hosted_projection_delta";
export const HOSTED_SYNC_PROJECTION_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  HOSTED_SYNC_PROJECTION_SNAPSHOT_KEY,
  HOSTED_SYNC_PROJECTION_DELTA_KEY,
]);

export type TenantSyncPreferenceProjectionSnapshot =
  | { exists: false }
  | {
      exists: true;
      project_mode: "all" | "selected";
      selected_project_addrs: string[];
      graph_enabled: boolean;
      projects_enabled: boolean;
      vault_metadata_enabled: boolean;
      drive_mirror_enabled: boolean;
      source: "vow_request" | "vol_sync";
    };

type TenantSyncPreferenceFunctionalState = Exclude<TenantSyncPreferenceProjectionSnapshot, { exists: false }>;

export interface TenantSyncPreferenceProjectionDelta {
  command_type: "sync_start" | "sync_stop" | "mirror_enable" | "mirror_disable" | "project_remove_from_vow";
  project_addr: string | null;
  before: TenantSyncPreferenceProjectionSnapshot;
  after: TenantSyncPreferenceProjectionSnapshot;
  added_project_addr: boolean;
  removed_project_addr: boolean;
}

export interface SyncPreferenceItem {
  type: string;
  addr?: string | null;
  project_addr?: string | null;
  plaintext_metadata?: {
    item_addr?: string | null;
    project_addr?: string | null;
  } | null;
}

export interface SyncItemPartition {
  allowed: { index: number; item: SyncPreferenceItem }[];
  rejected: { index: number; item: SyncPreferenceItem; reason: string }[];
}

type SqlTag = any;

const PJ_ADDR_RE = /^PJ\.[0-9]+(?:\.[0-9]+)*$/;

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export async function selectTenantSyncPreferences(
  sql: SqlTag,
  tenantId: string,
): Promise<TenantSyncPreferences | null> {
  let row;
  try {
    [row] = await sql`
      SELECT tenant_id, project_mode, selected_project_addrs, graph_enabled,
             projects_enabled, vault_metadata_enabled, drive_mirror_enabled,
             source, updated_by_account_id, updated_at
      FROM tenant_sync_preferences
      WHERE tenant_id = ${tenantId}
    `;
  } catch (e) {
    if ((e as { code?: string })?.code === "42P01") return null;
    throw e;
  }
  if (!row) return null;
  return {
    tenant_id: String(row.tenant_id),
    project_mode: row.project_mode === "selected" ? "selected" : "all",
    selected_project_addrs: asStringArray(row.selected_project_addrs),
    graph_enabled: asBoolean(row.graph_enabled, true),
    projects_enabled: asBoolean(row.projects_enabled, true),
    vault_metadata_enabled: asBoolean(row.vault_metadata_enabled, true),
    drive_mirror_enabled: asBoolean(row.drive_mirror_enabled, true),
    source: row.source === "vow_request" ? "vow_request" : "vol_sync",
    updated_by_account_id: row.updated_by_account_id == null ? null : String(row.updated_by_account_id),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

function projectionSnapshotFromPreferences(
  prefs: TenantSyncPreferences | null,
): TenantSyncPreferenceProjectionSnapshot {
  if (!prefs) return { exists: false };
  return {
    exists: true,
    project_mode: prefs.project_mode,
    selected_project_addrs: [...prefs.selected_project_addrs],
    graph_enabled: prefs.graph_enabled,
    projects_enabled: prefs.projects_enabled,
    vault_metadata_enabled: prefs.vault_metadata_enabled,
    drive_mirror_enabled: prefs.drive_mirror_enabled,
    source: prefs.source,
  };
}

export async function selectTenantSyncPreferenceProjectionSnapshot(
  sql: SqlTag,
  tenantId: string,
): Promise<TenantSyncPreferenceProjectionSnapshot> {
  return projectionSnapshotFromPreferences(await selectTenantSyncPreferences(sql, tenantId));
}

function isTenantSyncPreferenceProjectionSnapshot(
  value: unknown,
): value is TenantSyncPreferenceProjectionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.exists === false) return Object.keys(snapshot).length === 1;
  if (snapshot.exists !== true) return false;
  if (snapshot.project_mode !== "all" && snapshot.project_mode !== "selected") return false;
  if (!Array.isArray(snapshot.selected_project_addrs) || !snapshot.selected_project_addrs.every((v) => typeof v === "string")) return false;
  for (const key of ["graph_enabled", "projects_enabled", "vault_metadata_enabled", "drive_mirror_enabled"]) {
    if (typeof snapshot[key] !== "boolean") return false;
  }
  if (snapshot.source !== "vow_request" && snapshot.source !== "vol_sync") return false;
  return true;
}

function projectionSnapshotFromPayload(
  payload: Record<string, unknown>,
): TenantSyncPreferenceProjectionSnapshot | null {
  const snapshot = payload[HOSTED_SYNC_PROJECTION_SNAPSHOT_KEY];
  return isTenantSyncPreferenceProjectionSnapshot(snapshot) ? snapshot : null;
}

function defaultProjectionState(source: "vow_request" | "vol_sync" = "vow_request"): TenantSyncPreferenceFunctionalState {
  return {
    exists: true,
    project_mode: "all",
    selected_project_addrs: [],
    graph_enabled: true,
    projects_enabled: true,
    vault_metadata_enabled: true,
    drive_mirror_enabled: true,
    source,
  };
}

function functionalStateFromSnapshot(
  snapshot: TenantSyncPreferenceProjectionSnapshot,
): TenantSyncPreferenceFunctionalState | null {
  return snapshot.exists ? snapshot : null;
}

function canonicalAddrs(addrs: string[]): string[] {
  return [...new Set(addrs.filter(Boolean))].sort();
}

function sameFunctionalProjection(
  left: TenantSyncPreferenceProjectionSnapshot,
  right: TenantSyncPreferenceProjectionSnapshot,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.project_mode === right.project_mode &&
    JSON.stringify(canonicalAddrs(left.selected_project_addrs)) === JSON.stringify(canonicalAddrs(right.selected_project_addrs)) &&
    left.graph_enabled === right.graph_enabled &&
    left.projects_enabled === right.projects_enabled &&
    left.vault_metadata_enabled === right.vault_metadata_enabled &&
    left.drive_mirror_enabled === right.drive_mirror_enabled;
}

function projectLaneCanBeRestoredFromDelta(
  current: TenantSyncPreferenceProjectionSnapshot,
  delta: TenantSyncPreferenceProjectionDelta,
): boolean {
  if (!current.exists || !delta.after.exists) return false;
  return current.graph_enabled === delta.after.graph_enabled &&
    current.vault_metadata_enabled === delta.after.vault_metadata_enabled &&
    current.drive_mirror_enabled === delta.after.drive_mirror_enabled &&
    current.projects_enabled === delta.after.projects_enabled;
}

function projectionDeltaAfterState(
  before: TenantSyncPreferenceProjectionSnapshot,
  commandType: TenantSyncPreferenceProjectionDelta["command_type"],
  payload: Record<string, unknown>,
  opts: { activeProjectAddrs?: string[] } = {},
): {
  after: TenantSyncPreferenceProjectionSnapshot;
  projectAddr: string | null;
  addedProjectAddr: boolean;
  removedProjectAddr: boolean;
} {
  const beforeState = functionalStateFromSnapshot(before);
  if (commandType === "sync_start" || commandType === "sync_stop") {
    const enabled = commandType === "sync_start";
    const base = beforeState || defaultProjectionState();
    return {
      after: {
        ...base,
        source: "vow_request",
        graph_enabled: enabled,
        projects_enabled: enabled,
        vault_metadata_enabled: enabled,
        drive_mirror_enabled: enabled,
      },
      projectAddr: null,
      addedProjectAddr: false,
      removedProjectAddr: false,
    };
  }

  const projectAddr = payloadProjectAddr(payload);
  if (!projectAddr) {
    return { after: before, projectAddr: null, addedProjectAddr: false, removedProjectAddr: false };
  }
  const base = beforeState || defaultProjectionState();
  const beforeAddrs = canonicalAddrs(base.selected_project_addrs);
  const enabled = commandType === "mirror_enable";
  const enableBaseAddrs = enabled && base.project_mode === "all"
    ? canonicalAddrs(opts.activeProjectAddrs ?? beforeAddrs)
    : beforeAddrs;
  const removalBaseAddrs = !enabled && base.project_mode === "all"
    ? canonicalAddrs(opts.activeProjectAddrs ?? beforeAddrs)
    : beforeAddrs;
  const afterAddrs = enabled
    ? canonicalAddrs([...enableBaseAddrs, projectAddr])
    : removalBaseAddrs.filter((addr) => addr !== projectAddr);
  return {
    after: {
      ...base,
      source: "vow_request",
      project_mode: "selected",
      selected_project_addrs: afterAddrs,
      projects_enabled: enabled ? true : base.projects_enabled && afterAddrs.length > 0,
    },
    projectAddr,
    addedProjectAddr: enabled && !enableBaseAddrs.includes(projectAddr),
    removedProjectAddr: !enabled && removalBaseAddrs.includes(projectAddr),
  };
}

function isTenantSyncPreferenceProjectionDelta(
  value: unknown,
): value is TenantSyncPreferenceProjectionDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const delta = value as Record<string, unknown>;
  if (
    delta.command_type !== "sync_start" &&
    delta.command_type !== "sync_stop" &&
    delta.command_type !== "mirror_enable" &&
    delta.command_type !== "mirror_disable" &&
    delta.command_type !== "project_remove_from_vow"
  ) return false;
  if (delta.project_addr != null && typeof delta.project_addr !== "string") return false;
  if (!isTenantSyncPreferenceProjectionSnapshot(delta.before)) return false;
  if (!isTenantSyncPreferenceProjectionSnapshot(delta.after)) return false;
  if (typeof delta.added_project_addr !== "boolean") return false;
  if (typeof delta.removed_project_addr !== "boolean") return false;
  return true;
}

function projectionDeltaFromPayload(
  payload: Record<string, unknown>,
): TenantSyncPreferenceProjectionDelta | null {
  const delta = payload[HOSTED_SYNC_PROJECTION_DELTA_KEY];
  return isTenantSyncPreferenceProjectionDelta(delta) ? delta : null;
}

export function buildTenantSyncPreferenceProjectionPayload(
  snapshot: TenantSyncPreferenceProjectionSnapshot,
  commandType: string,
  payload: Record<string, unknown>,
  opts: { activeProjectAddrs?: string[] } = {},
): Record<string, unknown> {
  if (
    commandType !== "sync_start" &&
    commandType !== "sync_stop" &&
    commandType !== "mirror_enable" &&
    commandType !== "mirror_disable" &&
    commandType !== "project_remove_from_vow"
  ) {
    return { ...payload, [HOSTED_SYNC_PROJECTION_SNAPSHOT_KEY]: snapshot };
  }
  const deltaState = projectionDeltaAfterState(snapshot, commandType, payload, opts);
  const delta: TenantSyncPreferenceProjectionDelta = {
    command_type: commandType,
    project_addr: deltaState.projectAddr,
    before: snapshot,
    after: deltaState.after,
    added_project_addr: deltaState.addedProjectAddr,
    removed_project_addr: deltaState.removedProjectAddr,
  };
  return {
    ...payload,
    [HOSTED_SYNC_PROJECTION_SNAPSHOT_KEY]: snapshot,
    [HOSTED_SYNC_PROJECTION_DELTA_KEY]: delta,
  };
}

export async function selectActiveHostedMirrorProjectAddrs(sql: SqlTag, tenantId: string): Promise<string[]> {
  const mirrorRows = await sql`
    SELECT DISTINCT COALESCE(
      project_addr,
      CASE WHEN item_type = 'project' THEN COALESCE(item_addr, regexp_replace(item_key, '^project:', '')) ELSE NULL END
    ) AS project_addr
    FROM hosted_mirror_items
    WHERE tenant_id = ${tenantId}
      AND item_status = 'active'
      AND (
        project_addr IS NOT NULL
        OR item_type = 'project'
        OR item_key LIKE 'project:%'
      )
    ORDER BY project_addr
  `.catch((e: any) => {
    if (e?.code === "42P01") return [];
    throw e;
  });
  const driveRows = await sql`
    SELECT DISTINCT project_addr
    FROM hosted_drive_files
    WHERE tenant_id = ${tenantId}
      AND status = 'uploaded'
      AND project_addr IS NOT NULL
    ORDER BY project_addr
  `.catch((e: any) => {
    if (e?.code === "42P01") return [];
    throw e;
  });
  return canonicalAddrs([
    ...mirrorRows.map((row: any) => row.project_addr),
    ...driveRows.map((row: any) => row.project_addr),
  ].filter((addr): addr is string => typeof addr === "string" && PJ_ADDR_RE.test(addr)));
}

async function restoreTenantSyncPreferenceProjectionSnapshot(
  sql: SqlTag,
  tenantId: string,
  accountId: string | null,
  snapshot: TenantSyncPreferenceProjectionSnapshot,
): Promise<Record<string, unknown>> {
  if (!snapshot.exists) {
    const result = await sql`
      DELETE FROM tenant_sync_preferences
      WHERE tenant_id = ${tenantId}
    `;
    return { projected: false, restored_snapshot: true, deleted: Number(result.count) || 0 };
  }
  await sql`
    INSERT INTO tenant_sync_preferences (
      tenant_id, project_mode, selected_project_addrs, graph_enabled,
      projects_enabled, vault_metadata_enabled, drive_mirror_enabled,
      source, updated_by_account_id, updated_at
    )
    VALUES (
      ${tenantId}, ${snapshot.project_mode},
      ${snapshot.selected_project_addrs}::text[],
      ${snapshot.graph_enabled}, ${snapshot.projects_enabled},
      ${snapshot.vault_metadata_enabled}, ${snapshot.drive_mirror_enabled},
      ${snapshot.source}, ${accountId}, now()
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      project_mode = EXCLUDED.project_mode,
      selected_project_addrs = EXCLUDED.selected_project_addrs,
      graph_enabled = EXCLUDED.graph_enabled,
      projects_enabled = EXCLUDED.projects_enabled,
      vault_metadata_enabled = EXCLUDED.vault_metadata_enabled,
      drive_mirror_enabled = EXCLUDED.drive_mirror_enabled,
      source = EXCLUDED.source,
      updated_by_account_id = EXCLUDED.updated_by_account_id,
      updated_at = EXCLUDED.updated_at
  `;
  return { projected: false, restored_snapshot: true, deleted: 0 };
}

async function revertTenantSyncPreferenceProjectionDelta(
  sql: SqlTag,
  tenantId: string,
  accountId: string | null,
  delta: TenantSyncPreferenceProjectionDelta,
): Promise<Record<string, unknown>> {
  const current = projectionSnapshotFromPreferences(await selectTenantSyncPreferences(sql, tenantId));
  if (sameFunctionalProjection(current, delta.after)) {
    return restoreTenantSyncPreferenceProjectionSnapshot(sql, tenantId, accountId, delta.before);
  }
  if (delta.command_type === "mirror_enable" && delta.added_project_addr && delta.project_addr) {
    const projectAddr = delta.project_addr;
    const canRestoreProjectLane = projectLaneCanBeRestoredFromDelta(current, delta);
    const restoredSource = delta.before.exists ? delta.before.source : "vol_sync";
    await sql`
      UPDATE tenant_sync_preferences
      SET selected_project_addrs = (
            SELECT COALESCE(array_agg(project.addr ORDER BY project.addr), ARRAY[]::text[])
            FROM unnest(selected_project_addrs) AS project(addr)
            WHERE project.addr <> ${projectAddr}
          ),
          projects_enabled = CASE
            WHEN ${canRestoreProjectLane} THEN COALESCE(array_length(ARRAY(
              SELECT project.addr
              FROM unnest(selected_project_addrs) AS project(addr)
              WHERE project.addr <> ${projectAddr}
            ), 1), 0) > 0
            ELSE projects_enabled
          END,
          source = ${restoredSource},
          updated_by_account_id = ${accountId},
          updated_at = now()
      WHERE tenant_id = ${tenantId}
    `;
    return { projected: false, restored_delta: true, delta_kind: "remove_added_project_addr" };
  }
  if (
    (delta.command_type === "mirror_disable" || delta.command_type === "project_remove_from_vow") &&
    delta.removed_project_addr &&
    delta.project_addr
  ) {
    const projectAddr = delta.project_addr;
    const canRestoreProjectLane = projectLaneCanBeRestoredFromDelta(current, delta);
    const restoredSource = delta.before.exists ? delta.before.source : "vol_sync";
    await sql`
      UPDATE tenant_sync_preferences
      SET project_mode = 'selected',
          selected_project_addrs = (
            SELECT array_agg(project.addr ORDER BY project.addr)
            FROM (
              SELECT DISTINCT addr
              FROM unnest(tenant_sync_preferences.selected_project_addrs || ARRAY[${projectAddr}]::text[]) AS project(addr)
              WHERE addr <> ''
            ) AS project
          ),
          projects_enabled = CASE
            WHEN ${canRestoreProjectLane} THEN ${delta.before.exists ? delta.before.projects_enabled : true}
            ELSE projects_enabled
          END,
          source = ${restoredSource},
          updated_by_account_id = ${accountId},
          updated_at = now()
      WHERE tenant_id = ${tenantId}
    `;
    return { projected: false, restored_delta: true, delta_kind: "restore_removed_project_addr" };
  }
  if (delta.command_type === "sync_start" || delta.command_type === "sync_stop") {
    if (!delta.after.exists) {
      return { projected: false, restored_delta: false, reason: "concurrent_projection_not_reverted" };
    }
    const before = delta.before.exists ? delta.before : defaultProjectionState();
    const after = delta.after;
    const restoreLanes = {
      graph_enabled: before.graph_enabled !== after.graph_enabled,
      projects_enabled: before.projects_enabled !== after.projects_enabled,
      vault_metadata_enabled: before.vault_metadata_enabled !== after.vault_metadata_enabled,
      drive_mirror_enabled: before.drive_mirror_enabled !== after.drive_mirror_enabled,
    };
    if (Object.values(restoreLanes).some(Boolean)) {
      const restoredSource = delta.before.exists ? delta.before.source : "vol_sync";
      await sql`
        UPDATE tenant_sync_preferences
        SET graph_enabled = CASE
              WHEN ${restoreLanes.graph_enabled} THEN ${before.graph_enabled}
              ELSE graph_enabled
            END,
            projects_enabled = CASE
              WHEN ${restoreLanes.projects_enabled} AND projects_enabled = ${after.projects_enabled} THEN ${before.projects_enabled}
              ELSE projects_enabled
            END,
            vault_metadata_enabled = CASE
              WHEN ${restoreLanes.vault_metadata_enabled} AND vault_metadata_enabled = ${after.vault_metadata_enabled} THEN ${before.vault_metadata_enabled}
              ELSE vault_metadata_enabled
            END,
            drive_mirror_enabled = CASE
              WHEN ${restoreLanes.drive_mirror_enabled} AND drive_mirror_enabled = ${after.drive_mirror_enabled} THEN ${before.drive_mirror_enabled}
              ELSE drive_mirror_enabled
            END,
            source = ${restoredSource},
            updated_by_account_id = ${accountId},
            updated_at = now()
        WHERE tenant_id = ${tenantId}
      `;
      return { projected: false, restored_delta: true, delta_kind: "restore_sync_lane_state" };
    }
  }
  return { projected: false, restored_delta: false, reason: "concurrent_projection_not_reverted" };
}

export function syncItemProjectAddr(item: SyncPreferenceItem): string | null {
  if (item.type === "project") {
    return item.addr || item.plaintext_metadata?.item_addr || null;
  }
  if (
    item.type === "memory" ||
    item.type === "edge" ||
    item.type === "vault_dossier" ||
    item.type === "vault_drive_file" ||
    item.type === "journal_entry"
  ) {
    return item.project_addr || item.plaintext_metadata?.project_addr || null;
  }
  return null;
}

export function isSyncItemAllowedByTenantSyncPreferences(
  prefs: TenantSyncPreferences | null,
  item: SyncPreferenceItem,
): boolean {
  if (!prefs) return true;
  if (item.type === "project" && !prefs.projects_enabled) return false;
  if (item.type === "vault_dossier" && !prefs.vault_metadata_enabled) return false;
  if (item.type === "vault_drive_file" && !prefs.drive_mirror_enabled) return false;
  if (
    (item.type === "memory" || item.type === "edge" || item.type === "governance" || item.type === "journal_entry") &&
    !prefs.graph_enabled
  ) {
    return false;
  }
  if (prefs.project_mode !== "selected") return true;
  const projectAddr = syncItemProjectAddr(item);
  if (item.type === "edge" && !projectAddr) return false;
  if (!projectAddr) return true;
  return prefs.selected_project_addrs.includes(projectAddr);
}

export function tenantSyncPreferenceRejectionReason(
  prefs: TenantSyncPreferences | null,
  item: SyncPreferenceItem,
): string {
  if (!prefs) return "no_preferences_row";
  if (item.type === "project" && !prefs.projects_enabled) return "projects_disabled";
  if (item.type === "vault_dossier" && !prefs.vault_metadata_enabled) return "vault_metadata_disabled";
  if (item.type === "vault_drive_file" && !prefs.drive_mirror_enabled) return "drive_mirror_disabled";
  if (
    (item.type === "memory" || item.type === "edge" || item.type === "governance" || item.type === "journal_entry") &&
    !prefs.graph_enabled
  ) {
    return "graph_disabled";
  }
  if (prefs.project_mode !== "selected") return "unknown";
  return "project_not_in_allowlist";
}

export function partitionSyncItemsByTenantSyncPreferences(
  prefs: TenantSyncPreferences | null,
  items: SyncPreferenceItem[],
): SyncItemPartition {
  const allowed: SyncItemPartition["allowed"] = [];
  const rejected: SyncItemPartition["rejected"] = [];
  items.forEach((item, index) => {
    if (isSyncItemAllowedByTenantSyncPreferences(prefs, item)) {
      allowed.push({ index, item });
    } else {
      rejected.push({
        index,
        item,
        reason: tenantSyncPreferenceRejectionReason(prefs, item),
      });
    }
  });
  return { allowed, rejected };
}

export function countSyncItemsRejectedByTenantSyncPreferences(
  prefs: TenantSyncPreferences | null,
  items: SyncPreferenceItem[],
): number {
  return items.reduce(
    (count, item) => count + (isSyncItemAllowedByTenantSyncPreferences(prefs, item) ? 0 : 1),
    0,
  );
}

export async function tombstoneHostedMirrorProject(
  sql: SqlTag,
  tenantId: string,
  projectAddr: string,
): Promise<{ tombstoned: number; journal_archived: number; drive_obsoleted: number }> {
  const mirrorResult = await sql`
    UPDATE hosted_mirror_items
    SET item_status = 'tombstoned',
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND item_status = 'active'
      AND (
        project_addr = ${projectAddr}
        OR (item_type = 'project' AND item_addr = ${projectAddr})
        OR item_key = ${`project:${projectAddr}`}
      )
  `;
  let journalArchived = 0;
  try {
    const journalResult = await sql`
      UPDATE hosted_mirror_journal_entries
      SET item_status = 'archived',
          tags = '{}'::text[],
          payload_preview = '{}'::jsonb,
          source_refs = '[]'::jsonb,
          updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND item_status = 'active'
        AND project_addr = ${projectAddr}
    `;
    journalArchived = Number(journalResult.count) || 0;
  } catch (e) {
    if ((e as any)?.code !== "42P01") throw e;
  }
  const driveResult = await sql`
    UPDATE hosted_drive_files
    SET status = 'obsolete',
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND project_addr = ${projectAddr}
      AND status NOT IN ('obsolete', 'deleted_drive', 'deleted_local')
  `;
  return {
    tombstoned: Number(mirrorResult.count) || 0,
    journal_archived: journalArchived,
    drive_obsoleted: Number(driveResult.count) || 0,
  };
}

function isProjectSyncCommand(commandType: string): commandType is "mirror_enable" | "mirror_disable" | "project_remove_from_vow" {
  return commandType === "mirror_enable" || commandType === "mirror_disable" || commandType === "project_remove_from_vow";
}

function payloadProjectAddr(payload: Record<string, unknown>): string | null {
  const addr = typeof payload.project_addr === "string" ? payload.project_addr.trim() : "";
  return /^PJ\.[0-9]+(?:\.[0-9]+)*$/.test(addr) ? addr : null;
}

async function projectSyncPreferenceProjection(
  sql: SqlTag,
  tenantId: string,
  accountId: string | null,
  commandType: "mirror_enable" | "mirror_disable" | "project_remove_from_vow",
  payload: Record<string, unknown>,
  source: "vow_request" | "vol_sync" = "vol_sync",
): Promise<{ projected: boolean; tombstoned: number }> {
  const projectAddr = payloadProjectAddr(payload);
  if (!projectAddr) return { projected: false, tombstoned: 0 };
  const enabled = commandType === "mirror_enable";
  const activeHostedProjectAddrs = await selectActiveHostedMirrorProjectAddrs(sql, tenantId);
  const enableUnionFromAll = canonicalAddrs([...activeHostedProjectAddrs, projectAddr]);
  const selectedForRemovalFromAll = enabled
    ? []
    : activeHostedProjectAddrs.filter((addr) => addr !== projectAddr);
  const insertSelectedAddrs = enabled ? enableUnionFromAll : selectedForRemovalFromAll;
  await sql`
    INSERT INTO tenant_sync_preferences (
      tenant_id, project_mode, selected_project_addrs, projects_enabled,
      source, updated_by_account_id, updated_at
    )
    VALUES (
      ${tenantId}, 'selected',
      ${insertSelectedAddrs}::text[],
      ${enabled || insertSelectedAddrs.length > 0}, ${source}, ${accountId}, now()
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      project_mode = 'selected',
      selected_project_addrs = CASE
        WHEN ${enabled} THEN (
          SELECT ARRAY(
            SELECT DISTINCT project.addr
            FROM unnest(CASE
              WHEN tenant_sync_preferences.project_mode = 'all' THEN ${enableUnionFromAll}::text[]
              ELSE tenant_sync_preferences.selected_project_addrs || ${[projectAddr]}::text[]
            END) AS project(addr)
            WHERE addr IS NOT NULL AND addr <> ''
            ORDER BY project.addr
          )
        )
        ELSE (
          SELECT COALESCE(array_agg(project.addr ORDER BY project.addr), ARRAY[]::text[])
          FROM unnest(CASE
            WHEN tenant_sync_preferences.project_mode = 'all' THEN ${selectedForRemovalFromAll}::text[]
            ELSE tenant_sync_preferences.selected_project_addrs
          END) AS project(addr)
          WHERE project.addr <> ${projectAddr}
        )
      END,
      projects_enabled = CASE
        WHEN ${enabled} THEN true
        ELSE tenant_sync_preferences.projects_enabled AND COALESCE(array_length(ARRAY(
          SELECT project.addr
          FROM unnest(CASE
            WHEN tenant_sync_preferences.project_mode = 'all' THEN ${selectedForRemovalFromAll}::text[]
            ELSE tenant_sync_preferences.selected_project_addrs
          END) AS project(addr)
          WHERE project.addr <> ${projectAddr}
        ), 1), 0) > 0
      END,
      source = ${source},
      updated_by_account_id = ${accountId},
      updated_at = now()
  `;
  const keepExisting = commandType === "mirror_disable" && payload.keep_existing === true;
  const isOptimistic = source === "vow_request";
  const tombstone = enabled || keepExisting || isOptimistic ? { tombstoned: 0 } : await tombstoneHostedMirrorProject(sql, tenantId, projectAddr);
  return { projected: true, tombstoned: tombstone.tombstoned };
}

async function hostedSyncProjection(
  sql: SqlTag,
  tenantId: string,
  accountId: string | null,
  commandType: "sync_start" | "sync_stop",
  source: "vow_request" | "vol_sync" = "vol_sync",
): Promise<{ projected: boolean }> {
  const enabled = commandType === "sync_start";
  await sql`
    INSERT INTO tenant_sync_preferences (
      tenant_id, graph_enabled, projects_enabled, vault_metadata_enabled,
      drive_mirror_enabled, source, updated_by_account_id, updated_at
    )
    VALUES (${tenantId}, ${enabled}, ${enabled}, ${enabled}, ${enabled}, ${source}, ${accountId}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET
      graph_enabled = ${enabled},
      projects_enabled = ${enabled},
      vault_metadata_enabled = ${enabled},
      drive_mirror_enabled = ${enabled},
      source = ${source},
      updated_by_account_id = ${accountId},
      updated_at = now()
  `;
  return { projected: true };
}

export async function applyTenantSyncPreferenceCommandResult(
  sql: SqlTag,
  input: {
    tenantId: string;
    accountId: string | null;
    commandType: string;
    payload: Record<string, unknown>;
    projectionSource?: "vow_request" | "vol_sync";
  },
): Promise<Record<string, unknown> | null> {
  if (input.commandType === "sync_start" || input.commandType === "sync_stop") {
    return hostedSyncProjection(sql, input.tenantId, input.accountId, input.commandType, input.projectionSource);
  }
  if (isProjectSyncCommand(input.commandType)) {
    return projectSyncPreferenceProjection(sql, input.tenantId, input.accountId, input.commandType, input.payload, input.projectionSource);
  }
  return null;
}

export async function revertTenantSyncPreferenceCommand(
  sql: SqlTag,
  input: {
    tenantId: string;
    accountId: string | null;
    commandType: string;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown> | null> {
  if (
    input.commandType === "sync_start" ||
    input.commandType === "sync_stop" ||
    isProjectSyncCommand(input.commandType)
  ) {
    const delta = projectionDeltaFromPayload(input.payload);
    if (delta) {
      return revertTenantSyncPreferenceProjectionDelta(sql, input.tenantId, input.accountId, delta);
    }
    const snapshot = projectionSnapshotFromPayload(input.payload);
    if (!snapshot) {
      return { projected: false, restored_snapshot: false, reason: "projection_snapshot_unavailable" };
    }
    return restoreTenantSyncPreferenceProjectionSnapshot(sql, input.tenantId, input.accountId, snapshot);
  }
  return null;
}

export async function revertTenantSyncPreferenceCommandRow(
  sql: SqlTag,
  row: {
    tenant_id: string;
    account_id?: string | null;
    category: string;
    command_type: string;
    payload?: Record<string, unknown> | null;
  },
): Promise<Record<string, unknown> | null> {
  if (row.category !== "account_sync") return null;
  return revertTenantSyncPreferenceCommand(sql, {
    tenantId: row.tenant_id,
    accountId: row.account_id == null ? null : String(row.account_id),
    commandType: String(row.command_type),
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload
      : {},
  });
}

export const __test__ = {
  projectLaneCanBeRestoredFromDelta,
};
