import * as fs from "node:fs";
import * as path from "node:path";
import type postgres from "postgres";
import { resolveConfigPath, type ResolvedTenantSettings } from "./runtime-profile";
import { isHeavySyncAllowedFromCache, type LocalEntitlementCache, type PausedEntitlementRow } from "./local-entitlement-cache";

type SqlTag = ReturnType<typeof postgres>;

export type SyncCategory =
  | "lightweight_status"
  | "account_governance"
  | "non_project_graph"
  | "projects"
  | "vault_metadata"
  | "vault_dossiers"
  | "raw_capture_files"
  | "drive_mirror";

export interface SyncPreferenceSummary {
  master_enabled: boolean;
  account_governance: boolean;
  non_project_graph: boolean;
  projects_enabled: boolean;
  selected_project_count: number;
  vault_metadata: boolean;
  vault_dossiers: boolean;
  raw_capture_files: boolean;
  drive_mirror: boolean;
}

export interface EffectiveSyncPreferences {
  master_enabled: boolean;
  lightweight_status: { enabled: true; locked: true };
  account_governance: { enabled: boolean; entitlement: "free" };
  non_project_graph: { enabled: boolean; entitlement: "free" };
  projects: {
    enabled: boolean;
    requested_enabled: boolean;
    entitlement: "vo_plus";
    selected_project_addrs: string[];
  };
  vault_metadata: { enabled: boolean; requested_enabled: boolean; entitlement: "vo_plus" };
  vault_dossiers: { enabled: boolean; requested_enabled: boolean; entitlement: "vo_plus"; disabled_reason: string | null };
  raw_capture_files: { enabled: boolean; requested_enabled: boolean; entitlement: "vo_plus"; disabled_reason: string | null };
  drive_mirror: { enabled: boolean; requested_enabled: boolean; entitlement: "vo_plus"; disabled_reason: string | null };
  legacy_sync_projects_null: boolean;
  heavy_sync_active: boolean;
  summary: SyncPreferenceSummary;
}

export interface SyncProjectOption {
  addr: string;
  label: string | null;
  eligible: boolean;
  disabled_reason: string | null;
}

export interface SyncPreferencePatch {
  account_governance?: boolean;
  non_project_graph?: boolean;
  projects_enabled?: boolean;
  selected_project_addrs?: string[];
  vault_metadata?: boolean;
  vault_dossiers?: boolean;
  raw_capture_files?: boolean;
  drive_mirror?: boolean;
}

export function resolveEffectiveSyncPreferences(
  settings: ResolvedTenantSettings,
  entitlementCache?: LocalEntitlementCache | null,
): EffectiveSyncPreferences {
  const heavy = isHeavySyncAllowedFromCache(entitlementCache || null);
  const selected = Array.isArray(settings.sync_projects) ? [...new Set(settings.sync_projects.filter(Boolean))] : [];
  const projectsRequested = settings.sync_projects_enabled === true;
  const vaultRequested = settings.vault_sync === "metadata_only";
  const driveRequested = settings.sync_drive_mirror === true;
  const dossiersRequested = settings.sync_vault_dossiers === true;
  const rawFilesRequested = settings.sync_raw_capture_files === true;
  const tierBlocksDrive = entitlementCache?.tenant_security_tier === "content_opaque";
  const driveEnabled = driveRequested && heavy && !tierBlocksDrive;
  const driveDisabledReason = tierBlocksDrive
    ? "Drive mirror is not supported for content_opaque tenants"
    : driveRequested && !driveEnabled
      ? "Drive consent or VO+ required"
      : null;
  const summary: SyncPreferenceSummary = {
    master_enabled: settings.hosted_sync === "outbound",
    account_governance: settings.sync_account_governance !== false,
    non_project_graph: settings.sync_non_project_graph !== false,
    projects_enabled: projectsRequested,
    selected_project_count: selected.length,
    vault_metadata: vaultRequested,
    vault_dossiers: dossiersRequested,
    raw_capture_files: rawFilesRequested,
    drive_mirror: driveRequested,
  };
  return {
    master_enabled: summary.master_enabled,
    lightweight_status: { enabled: true, locked: true },
    account_governance: { enabled: summary.account_governance, entitlement: "free" },
    non_project_graph: { enabled: summary.non_project_graph, entitlement: "free" },
    projects: {
      enabled: projectsRequested && heavy && selected.length > 0,
      requested_enabled: projectsRequested,
      entitlement: "vo_plus",
      selected_project_addrs: selected,
    },
    vault_metadata: { enabled: vaultRequested && heavy, requested_enabled: vaultRequested, entitlement: "vo_plus" },
    vault_dossiers: {
      enabled: dossiersRequested && driveEnabled,
      requested_enabled: dossiersRequested,
      entitlement: "vo_plus",
      disabled_reason: dossiersRequested && !driveEnabled ? driveDisabledReason : null,
    },
    raw_capture_files: {
      enabled: rawFilesRequested && driveEnabled,
      requested_enabled: rawFilesRequested,
      entitlement: "vo_plus",
      disabled_reason: rawFilesRequested && !driveEnabled ? driveDisabledReason : null,
    },
    drive_mirror: {
      enabled: driveEnabled,
      requested_enabled: driveRequested,
      entitlement: "vo_plus",
      disabled_reason: driveDisabledReason,
    },
    legacy_sync_projects_null: settings.sync_projects === null,
    heavy_sync_active: heavy,
    summary,
  };
}

export function syncPreferenceAuditSummary(prefs: EffectiveSyncPreferences): SyncPreferenceSummary {
  return { ...prefs.summary };
}

export function syncPreferencesMirrorBlock(prefs: EffectiveSyncPreferences): SyncPreferenceSummary {
  return { ...prefs.summary };
}

export function shouldIncludeJournalRowForSyncPreferences(
  row: {
    item_type: string;
    addr: string | null;
    project_addr: string | null;
    payload_json?: Record<string, unknown> | null;
    file_kind?: unknown;
  },
  prefs: EffectiveSyncPreferences,
  managedProjectAddrs: string[] | null,
): boolean {
  if (row.item_type === "governance") return true;
  if (row.item_type === "journal_entry") {
    const projectAddr = row.project_addr ||
      (typeof row.payload_json?.project_addr === "string" ? row.payload_json.project_addr : null);
    if (!projectAddr) return prefs.non_project_graph.enabled;
    if (!prefs.projects.enabled) return false;
    if (managedProjectAddrs !== null && !managedProjectAddrs.includes(projectAddr)) return false;
    return prefs.projects.selected_project_addrs.includes(projectAddr);
  }
  if (row.item_type === "project") {
    if (!prefs.projects.enabled || !row.addr) return false;
    if (managedProjectAddrs !== null && !managedProjectAddrs.includes(row.addr)) return false;
    return prefs.projects.selected_project_addrs.includes(row.addr);
  }
  if (row.item_type === "memory") {
    if (!row.project_addr) return prefs.non_project_graph.enabled;
    if (!prefs.projects.enabled) return false;
    if (managedProjectAddrs !== null && !managedProjectAddrs.includes(row.project_addr)) return false;
    return prefs.projects.selected_project_addrs.includes(row.project_addr);
  }
  if (row.item_type === "edge") {
    // Journal edge rows do not currently carry enough project scope to prove
    // they belong to an allowed project, so R6 fails closed for edges.
    return false;
  }
  if (row.item_type === "vault_dossier") return prefs.vault_metadata.enabled;
  if (row.item_type === "vault_drive_file") {
    const fileKind = typeof row.file_kind === "string"
      ? row.file_kind
      : typeof row.payload_json?.file_kind === "string"
        ? row.payload_json.file_kind
        : null;
    if (fileKind === "vault_dossier") return prefs.vault_dossiers.enabled;
    if (fileKind === "raw_capture_file") return prefs.raw_capture_files.enabled;
    if (fileKind === "other_vault_file") return prefs.drive_mirror.enabled;
    return false;
  }
  return false;
}

export function shouldIncludeSyncItemForSyncPreferences(
  item: Record<string, unknown>,
  prefs: EffectiveSyncPreferences,
  managedProjectAddrs: string[] | null,
): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  const addr = typeof item.addr === "string" ? item.addr : null;
  const projectAddr = typeof item.project_addr === "string" ? item.project_addr : null;
  return shouldIncludeJournalRowForSyncPreferences({
    item_type: type,
    addr,
    project_addr: projectAddr,
    payload_json: item,
    file_kind: item.file_kind,
  }, prefs, managedProjectAddrs);
}

export async function listSyncProjectOptions(sql: SqlTag, tenantId: string): Promise<{
  options: SyncProjectOption[];
  managed_ceiling_available: boolean;
  managed_project_addrs: string[] | null;
}> {
  const spaceId = `tenant:${tenantId}`;
  const projects = await sql`
    SELECT addr, label, tenant_pyramid_id
    FROM nodes
    WHERE pyramid_id = 'PROJECTS'
      AND depth = 1
      AND space_id = ${spaceId}
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
    ORDER BY label
  `;
  let managedAddrs: string[] | null = null;
  try {
    const { ensureProjectPyramidMembership } = require("./tenant-pyramids");
    await ensureProjectPyramidMembership(sql, tenantId);
    const rows = await sql`
      SELECT n.addr
      FROM nodes n
      JOIN tenant_pyramids tp ON tp.pyramid_id = n.tenant_pyramid_id
      WHERE n.pyramid_id = 'PROJECTS' AND n.depth = 1
        AND n.space_id = ${spaceId}
        AND n.dormant_at IS NULL
        AND n.visibility <> 'deleted'
        AND tp.sync_level = 'managed_mirror'
    `;
    managedAddrs = rows.map((r: any) => String(r.addr));
  } catch {
    managedAddrs = null;
  }
  const managedSet = managedAddrs === null ? null : new Set(managedAddrs);
  return {
    managed_ceiling_available: managedAddrs !== null,
    managed_project_addrs: managedAddrs,
    options: projects.map((p: any) => {
      const eligible = managedSet === null || managedSet.has(String(p.addr));
      return {
        addr: String(p.addr),
        label: typeof p.label === "string" ? p.label : null,
        eligible,
        disabled_reason: eligible ? null : "local_only",
      };
    }),
  };
}

function readRawConfig(): Record<string, unknown> {
  const cfgPath = resolveConfigPath();
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    return {};
  }
}

function writeRawConfig(raw: Record<string, unknown>): string {
  const cfgPath = resolveConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, cfgPath);
  return cfgPath;
}

export async function applySyncPreferencePatch(input: {
  sql: SqlTag;
  tenantId: string;
  settings: ResolvedTenantSettings;
  entitlementCache: LocalEntitlementCache | null;
  patch: SyncPreferencePatch;
}): Promise<{
  configPath: string;
  previous: EffectiveSyncPreferences;
  next: EffectiveSyncPreferences;
  changed_keys: string[];
}> {
  const previous = resolveEffectiveSyncPreferences(input.settings, input.entitlementCache);
  const raw = readRawConfig();
  const changed = new Set<string>();

  const heavy = previous.heavy_sync_active;
  if ((
    input.patch.projects_enabled === true ||
    input.patch.vault_metadata === true ||
    input.patch.vault_dossiers === true ||
    input.patch.raw_capture_files === true ||
    input.patch.drive_mirror === true
  ) && !heavy) {
    const error = new Error("VO+ is required for project and vault sync preferences.");
    (error as any).code = "payment_required";
    throw error;
  }

  const projectOptions = await listSyncProjectOptions(input.sql, input.tenantId);
  const eligible = new Set(projectOptions.options.filter((p) => p.eligible).map((p) => p.addr));
  if (input.patch.selected_project_addrs !== undefined) {
    if (!Array.isArray(input.patch.selected_project_addrs)) {
      const error = new Error("selected_project_addrs must be an array.");
      (error as any).code = "invalid_project_selection";
      throw error;
    }
    const selected = [...new Set(input.patch.selected_project_addrs.map((v) => String(v).trim()).filter(Boolean))];
    if (selected.some((addr) => !eligible.has(addr))) {
      const error = new Error("One or more selected projects cannot be mirrored.");
      (error as any).code = "invalid_project_selection";
      throw error;
    }
    raw.sync_projects = selected;
    changed.add("selected_project_addrs");
  }

  if (input.patch.account_governance !== undefined) {
    raw.sync_account_governance = input.patch.account_governance === true;
    changed.add("account_governance");
  }
  if (input.patch.non_project_graph !== undefined) {
    raw.sync_non_project_graph = input.patch.non_project_graph === true;
    changed.add("non_project_graph");
  }
  if (input.patch.projects_enabled !== undefined) {
    raw.sync_projects_enabled = input.patch.projects_enabled === true;
    changed.add("projects_enabled");
  }
  if (input.patch.vault_metadata !== undefined) {
    raw.vault_sync = input.patch.vault_metadata === true ? "metadata_only" : "off";
    changed.add("vault_metadata");
  }
  if (input.patch.drive_mirror !== undefined) {
    raw.sync_drive_mirror = input.patch.drive_mirror === true;
    changed.add("drive_mirror");
  }
  if (input.patch.vault_dossiers !== undefined) {
    raw.sync_vault_dossiers = input.patch.vault_dossiers === true;
    changed.add("vault_dossiers");
  }
  if (input.patch.raw_capture_files !== undefined) {
    raw.sync_raw_capture_files = input.patch.raw_capture_files === true;
    changed.add("raw_capture_files");
  }
  raw.sync_preferences_version = 1;

  const configPath = writeRawConfig(raw);
  const { resolveTenantSettings } = await import("./runtime-profile");
  const next = resolveEffectiveSyncPreferences(resolveTenantSettings(), input.entitlementCache);

  const { journalGovernance } = await import("./sync-journal-port");
  await journalGovernance(input.sql, "machine_settings", `tenant:${input.tenantId}`);
  if (next.master_enabled) {
    const { nudgeSyncScheduler } = await import("./sync-scheduler");
    nudgeSyncScheduler();
  }

  return { configPath, previous, next, changed_keys: [...changed] };
}

export function pruneReplayRowsBySyncPreferences<T extends PausedEntitlementRow>(
  rows: T[],
  prefs: EffectiveSyncPreferences,
  managedProjectAddrs: string[] | null,
): { allowed: T[]; pruned: T[] } {
  const allowed: T[] = [];
  const pruned: T[] = [];
  for (const row of rows) {
    if (shouldIncludeJournalRowForSyncPreferences(row, prefs, managedProjectAddrs)) allowed.push(row);
    else pruned.push(row);
  }
  return { allowed, pruned };
}

export function pruneReplayRowsByTenantSecurity<T extends PausedEntitlementRow>(
  rows: T[],
  tenantSecurityTier: string | null | undefined,
): { allowed: T[]; pruned: T[] } {
  if (tenantSecurityTier !== "content_opaque") return { allowed: rows, pruned: [] };
  const allowed: T[] = [];
  const pruned: T[] = [];
  for (const row of rows) {
    if (row.item_type === "vault_drive_file" || row.item_type === "edge") pruned.push(row);
    else allowed.push(row);
  }
  return { allowed, pruned };
}
