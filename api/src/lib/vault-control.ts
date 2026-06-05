/**
 * Vault control seam — VO-LOCAL-VAULT-DASHBOARD-PR-1.
 *
 * Canonical read + write + action helpers for the local dashboard Vault
 * tab. All Vault dashboard logic goes through this module; route handlers
 * must not edit ~/.vo/config.json inline, parse discoverVault() error
 * strings, or shell out on their own.
 *
 * Public shape:
 *   - resolveConfiguredVaultRoot()      — where did we get a root from?
 *   - inspectVaultRoot(root, expected?) — structured validity inspection
 *   - readVaultDashboardState(sql, id)  — composed dashboard state
 *   - writeVaultEnabled(enabled)        — local-only config write
 *   - writeVaultRoot(root | null)       — local-only config write
 *   - writeBrowserCaptureAutoHarvest()  — local-only config write
 *   - initializeVaultFromDashboard(..)  — scaffold delegation + validation
 *   - openVaultRoot(root)               — OS file-manager open
 *   - openVaultInObsidian(root)         — Obsidian open
 *   - detectObsidianInstall()           — best-effort platform check
 *
 * Three axes that MUST stay distinct in the dashboard state:
 *   1. feature intent     (vault_enabled — local config)
 *   2. root / binding     (resolveConfiguredVaultRoot + inspectVaultRoot)
 *   3. Obsidian companion (detectObsidianInstall — independent of the above)
 *
 * `vault_sync` is a tenant-settings field owned by the Settings tab
 * (resolveTenantSettings). The dashboard state exposes it for context
 * but never writes it through this module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
// execFileSync (not execSync) so vault paths land in argv and never go
// through a shell — `open` and `open -a Obsidian` take a literal path,
// and an operator-persisted vault_root may contain $()/backticks/etc.
import { execFileSync } from "node:child_process";
import type postgres from "postgres";
import {
  inspectVaultRoot as inspectSharedVaultRoot,
  resolveVaultRoot as resolveSharedVaultRoot,
  type VaultRootSource as SharedVaultRootSource,
} from "@verity-one/vault-root";
import { resolveConfigPath, resolveTenantSettings, type VaultSync } from "./runtime-profile";
import { listFinalizedDossierMetadata } from "./vault-metadata";
import { scaffoldVault, VaultScaffoldError } from "./vault-scaffold";
import { buildObsidianOpenUrl } from "./vault-write";

type SqlTag = ReturnType<typeof postgres>;

// ─── Typed status model ─────────────────────────────────────────────────

export type VaultStatusKind =
  | "disabled_ready"
  | "init_required"
  | "env_override_invalid"
  | "unreadable"
  | "no_tenant"
  | "tenant_mismatch"
  | "ready";

export type VaultRootSource = SharedVaultRootSource | "unset";

export type VaultInspection = ReturnType<typeof inspectVaultRoot>;

export interface VaultDashboardState {
  status_kind: VaultStatusKind;
  vault_enabled: boolean;
  vault_root: string | null;
  vault_root_source: VaultRootSource;
  vault_sync: VaultSync;
  vault_default_root: string | null;
  discovery_error: string | null;
  vault_tenant_id: string | null;
  tenant_match: boolean | null;
  initialized: boolean;
  dossier_count: number | null;
  last_generated_at: string | null;
  obsidian_installed: boolean | null;
  obsidian_open_supported: boolean;
  open_root_supported: boolean;
  browser_capture_auto_harvest: boolean;
  recommended_actions: string[];
}

// ─── Config reads ───────────────────────────────────────────────────────
//
// `vault_enabled` and `vault_root` are local-only config fields. They live
// beside profile + tenant-settings in ~/.vo/config.json but are NOT routed
// through writeTenantSetting() — vault_enabled is a local feature-intent
// flag, not a tenant policy, and vault_root is a filesystem path rather
// than an enum. See the write helpers below.

function readConfigRaw(): Record<string, unknown> {
  const cfgPath = resolveConfigPath();
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readConfiguredTenantId(): string | null {
  const cfg = readConfigRaw();
  return typeof cfg.tenant_id === "string" && cfg.tenant_id.trim() ? cfg.tenant_id.trim() : null;
}

export function readVaultEnabled(): boolean {
  const cfg = readConfigRaw();
  const v = cfg.vault_enabled;
  // Default false — Vault is opt-in locally.
  return v === true;
}

export function readBrowserCaptureAutoHarvest(tenantId?: string | null): boolean {
  if (!tenantId) return false;
  const cfg = readConfigRaw();
  // Default false — browser capture writes inbox artifacts only until
  // the local operator explicitly opts this tenant into clipper-sync handoff.
  const tenants = cfg.browser_capture_auto_harvest_tenants;
  if (!tenants || typeof tenants !== "object" || Array.isArray(tenants)) return false;
  return (tenants as Record<string, unknown>)[tenantId] === true;
}

/**
 * Resolve the configured vault root and where it came from, without
 * validating the path contents. Order follows the shared R7 resolver:
 *   1. explicit caller root, when provided through inspectVaultRoot()
 *   2. VERITY_VAULT_ROOT env var
 *   3. ~/.vo/config.json#vault_root
 *   4. ~/Verity One Vault/<tenant_id> default
 */
export function resolveConfiguredVaultRoot(tenantId?: string | null): {
  root: string | null;
  source: VaultRootSource;
  tenant_id: string | null;
  default_root: string | null;
  status?: "no_tenant";
  error?: string;
} {
  const resolved = resolveSharedVaultRoot({
    tenantId: tenantId ?? readConfiguredTenantId(),
    env: process.env,
    configPath: resolveConfigPath(),
  });
  if (!resolved.ok) {
    return { root: null, source: "unset", tenant_id: null, default_root: null, status: "no_tenant", error: resolved.error };
  }
  return {
    root: resolved.root,
    source: resolved.source,
    tenant_id: resolved.tenant_id,
    default_root: resolved.default_root,
  };
}

// ─── Structured inspection ─────────────────────────────────────────────

/**
 * Inspect a configured vault root and return a typed, lossless report.
 *
 * Never parses freeform strings — each distinct failure mode has its own
 * typed reason so the dashboard state machine can render accurate copy
 * and enable accurate action buttons.
 */
export function inspectVaultRoot(
  candidate: string | null,
  expectedTenantId?: string,
  vaultEnabled = true,
): ReturnType<typeof inspectSharedVaultRoot> {
  return inspectSharedVaultRoot({
    tenantId: expectedTenantId ?? readConfiguredTenantId(),
    explicitRoot: candidate,
    env: process.env,
    configPath: resolveConfigPath(),
    vaultEnabled,
  });
}

// ─── Platform / Obsidian detection ──────────────────────────────────────
//
// macOS-first per spec. Other platforms return honest "unsupported"
// signals rather than pretending to support open-in-app flows.

export function isOpenRootSupported(): boolean {
  return process.platform === "darwin";
}

export function isOpenObsidianSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * Best-effort detect whether Obsidian is installed. Returns `null` when
 * the check itself is not supported on this platform — the dashboard
 * treats null as "we cannot tell" and hides the Obsidian companion
 * affordance rather than claiming it is missing.
 */
export function detectObsidianInstall(): boolean | null {
  if (process.platform !== "darwin") return null;
  try {
    return fs.existsSync("/Applications/Obsidian.app");
  } catch {
    return null;
  }
}

// ─── Open actions ──────────────────────────────────────────────────────

export interface OpenActionResult {
  ok: boolean;
  supported: boolean;
  error?: string;
}

/**
 * Open the vault root in the platform file manager (macOS Finder via
 * `open`). Returns a structured unsupported result on other platforms
 * rather than throwing or silently no-oping.
 */
export function openVaultRoot(root: string): OpenActionResult {
  if (!isOpenRootSupported()) {
    return {
      ok: false,
      supported: false,
      error: "Opening a vault in the file manager is not supported on this platform yet.",
    };
  }
  if (!path.isAbsolute(root)) {
    return { ok: false, supported: true, error: "root must be an absolute path" };
  }
  if (!fs.existsSync(root)) {
    return { ok: false, supported: true, error: `vault root does not exist: ${root}` };
  }
  try {
    // execFileSync with argv — never a shell. Metacharacters in `root`
    // (`$()`, backticks, `;`, `&&`, etc.) are literal filename bytes
    // passed directly to `open(1)`, not a shell to interpret.
    execFileSync("open", [root], { stdio: "ignore" });
    return { ok: true, supported: true };
  } catch (e) {
    return { ok: false, supported: true, error: (e as Error).message };
  }
}

/**
 * Open the vault in Obsidian. macOS-only in v1; on other platforms returns
 * a structured unsupported result. Obsidian accepts a vault directory via
 * its URL scheme; using `open -a Obsidian <path>` is the minimal macOS
 * approach and does not assume Obsidian's Advanced URI plugin is present.
 */
export function openVaultInObsidian(root: string): OpenActionResult {
  if (!isOpenObsidianSupported()) {
    return {
      ok: false,
      supported: false,
      error: "Opening a vault in Obsidian is not supported on this platform yet.",
    };
  }
  if (!path.isAbsolute(root)) {
    return { ok: false, supported: true, error: "root must be an absolute path" };
  }
  if (!fs.existsSync(root)) {
    return { ok: false, supported: true, error: `vault root does not exist: ${root}` };
  }
  if (detectObsidianInstall() === false) {
    return { ok: false, supported: true, error: "Obsidian is not installed at /Applications/Obsidian.app." };
  }
  try {
    // execFileSync with argv — never a shell. See openVaultRoot above.
    execFileSync("open", ["-a", "Obsidian", root], { stdio: "ignore" });
    return { ok: true, supported: true };
  } catch (e) {
    return { ok: false, supported: true, error: (e as Error).message };
  }
}

/**
 * Open a SPECIFIC dossier file in Obsidian via the `obsidian://open` URL
 * scheme (plan Rung 3). macOS-only in v1, same guards as openVaultInObsidian.
 * `dossierRelPath` must be vault-relative (e.g. `dossiers/<addr>.md`); it is
 * validated against path traversal before being handed to Obsidian. The URL
 * is built by vault-write.buildObsidianOpenUrl and passed to `open` as a
 * single argv (never a shell).
 */
export function openObsidianFile(root: string, dossierRelPath: string): OpenActionResult {
  if (!isOpenObsidianSupported()) {
    return {
      ok: false,
      supported: false,
      error: "Opening a vault file in Obsidian is not supported on this platform yet.",
    };
  }
  if (!path.isAbsolute(root)) {
    return { ok: false, supported: true, error: "root must be an absolute path" };
  }
  if (!fs.existsSync(root)) {
    return { ok: false, supported: true, error: `vault root does not exist: ${root}` };
  }
  if (path.isAbsolute(dossierRelPath) || dossierRelPath.includes("..")) {
    return { ok: false, supported: true, error: "dossier path must be vault-relative without traversal" };
  }
  if (detectObsidianInstall() === false) {
    return { ok: false, supported: true, error: "Obsidian is not installed at /Applications/Obsidian.app." };
  }
  const url = buildObsidianOpenUrl(path.basename(root), dossierRelPath);
  try {
    // execFileSync with argv — never a shell. The obsidian:// URL is a single
    // literal argument handed to `open`, which dispatches it to the OS URL
    // handler (Obsidian). Metacharacters stay literal.
    execFileSync("open", [url], { stdio: "ignore" });
    return { ok: true, supported: true };
  } catch (e) {
    return { ok: false, supported: true, error: (e as Error).message };
  }
}

// ─── Config writes ──────────────────────────────────────────────────────
//
// Atomic temp-file + rename, preserving unrelated config fields. Neither
// helper routes through writeTenantSetting(): `vault_enabled` is local
// feature intent (not a tenant policy) and `vault_root` is a path field
// (not an enum).

function writeConfigField(
  field: "vault_enabled" | "vault_root",
  value: unknown,
): { configPath: string; previous: unknown; next: unknown } {
  const cfgPath = resolveConfigPath();
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(cfgPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`config at ${cfgPath} is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  }
  const previous = existing[field] ?? null;
  if (value === null) {
    // Explicit clear — remove the key rather than writing null, so a later
    // reader does not see the field as "configured to null".
    delete existing[field];
  } else {
    existing[field] = value;
  }
  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, cfgPath);
  return { configPath: cfgPath, previous, next: value };
}

export function writeVaultEnabled(enabled: boolean): { configPath: string; previous: unknown; next: boolean } {
  if (typeof enabled !== "boolean") {
    throw new Error(`vault_enabled must be true or false, got: ${JSON.stringify(enabled)}`);
  }
  const result = writeConfigField("vault_enabled", enabled);
  return { configPath: result.configPath, previous: result.previous, next: enabled };
}

export function writeVaultRoot(root: string | null): { configPath: string; previous: unknown; next: string | null } {
  if (root !== null) {
    if (typeof root !== "string" || !root.trim()) {
      throw new Error(`vault_root must be a non-empty string or null, got: ${JSON.stringify(root)}`);
    }
    if (!path.isAbsolute(root)) {
      throw new Error(`vault_root must be an absolute path, got: ${JSON.stringify(root)}`);
    }
  }
  const result = writeConfigField("vault_root", root);
  return { configPath: result.configPath, previous: result.previous, next: root };
}

export function writeBrowserCaptureAutoHarvest(tenantId: string, enabled: boolean): {
  configPath: string;
  previous: unknown;
  next: boolean;
} {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("tenant_id is required for browser_capture_auto_harvest");
  }
  if (typeof enabled !== "boolean") {
    throw new Error(`browser_capture_auto_harvest must be true or false, got: ${JSON.stringify(enabled)}`);
  }
  const cfgPath = resolveConfigPath();
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(cfgPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`config at ${cfgPath} is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  }
  const rawTenants = existing.browser_capture_auto_harvest_tenants;
  const tenants = rawTenants && typeof rawTenants === "object" && !Array.isArray(rawTenants)
    ? { ...(rawTenants as Record<string, unknown>) }
    : {};
  const previous = tenants[tenantId] ?? null;
  tenants[tenantId] = enabled;
  existing.browser_capture_auto_harvest_tenants = tenants;
  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, cfgPath);
  return { configPath: cfgPath, previous, next: enabled };
}

// ─── Initialization ────────────────────────────────────────────────────

export interface InitializeVaultInput {
  /** Absolute filesystem path to initialize. If omitted, the currently
   *  configured vault_root is used. */
  root?: string;
  /** Tenant id the dashboard is operating for. Used as the expected
   *  tenant for scaffold + inspection. */
  tenantId: string;
}

export type InitializeVaultResult =
  | { ok: true; root: string; tenant_id: string; scaffold: ReturnType<typeof scaffoldVault> }
  | {
      ok: false;
      reason:
        | "no_root"
        | "not_absolute"
        | "not_directory"
        | "invalid_marker_json"
        | "missing_tenant_binding"
        | "tenant_mismatch"
        | "unreadable"
        | "env_override_invalid"
        | "scaffold_failed";
      error: string;
      details?: Record<string, unknown>;
    };

/**
 * Scaffold-only initialization from the dashboard. Never harvests, never
 * writes to the graph, never calls the CLI as a subprocess. Delegates to
 * the extracted `scaffoldVault` helper for directory + file creation and
 * surfaces structured failure reasons for the dashboard to render.
 */
export function initializeVaultFromDashboard(input: InitializeVaultInput): InitializeVaultResult {
  const configured = resolveConfiguredVaultRoot(input.tenantId);
  const targetRoot = input.root ?? configured.root;

  if (!targetRoot) {
    return {
      ok: false,
      reason: "no_root",
      error: "No vault root provided or configured. Set a vault path first.",
    };
  }
  if (!path.isAbsolute(targetRoot)) {
    return {
      ok: false,
      reason: "not_absolute",
      error: `Vault root must be an absolute path (got ${JSON.stringify(targetRoot)}).`,
    };
  }

  // Pre-flight existing state. Any malformed marker is a refusal, not a
  // silent overwrite — scaffoldVault would otherwise treat a marker with
  // missing tenant_id or invalid JSON as "unchanged" and return false
  // success while leaving the binding broken. The operator must resolve
  // the malformed state (delete the marker) before init proceeds. Only
  // `missing_marker` (directory exists but uninitialized) falls through
  // to scaffoldVault — that is the whole point of initialize.
  if (fs.existsSync(targetRoot)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetRoot);
    } catch (e) {
      return {
        ok: false,
        reason: "scaffold_failed",
        error: `cannot stat vault root ${targetRoot}: ${(e as Error).message}`,
        details: { root: targetRoot },
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        reason: "not_directory",
        error: `Vault root is not a directory: ${targetRoot}`,
        details: { root: targetRoot },
      };
    }
    const existingInspection = inspectVaultRoot(targetRoot, input.tenantId, true);
    if (!existingInspection.ok) {
      if (existingInspection.status === "tenant_mismatch") {
        return {
          ok: false,
          reason: "tenant_mismatch",
          error: existingInspection.error,
          details: {
            root: targetRoot,
            existing_tenant_id: existingInspection.vault_tenant_id,
            expected_tenant_id: input.tenantId,
          },
        };
      }
      if (existingInspection.status === "unreadable") {
        return {
          ok: false,
          reason: existingInspection.reason === "invalid_marker_json" ? "invalid_marker_json"
            : existingInspection.reason === "missing_tenant_binding" ? "missing_tenant_binding"
            : "unreadable",
          error: existingInspection.error,
          details: { root: targetRoot },
        };
      }
      if (existingInspection.status === "env_override_invalid") {
        return { ok: false, reason: "env_override_invalid", error: existingInspection.error, details: { root: targetRoot } };
      }
      // init_required on an empty directory is legitimately fixable by scaffoldVault.
    }
  }

  try {
    const scaffold = scaffoldVault({ root: targetRoot, tenantId: input.tenantId });
    return { ok: true, root: targetRoot, tenant_id: input.tenantId, scaffold };
  } catch (e) {
    if (e instanceof VaultScaffoldError) {
      // tenant_mismatch at scaffold time maps to the typed dashboard
      // rejection; other scaffold errors are surfaced structurally.
      if (e.reason === "tenant_mismatch") {
        return {
          ok: false,
          reason: "tenant_mismatch",
          error: e.message,
          details: e.details,
        };
      }
      if (e.reason === "not_absolute") {
        return { ok: false, reason: "not_absolute", error: e.message, details: e.details };
      }
      return { ok: false, reason: "scaffold_failed", error: e.message, details: e.details };
    }
    return { ok: false, reason: "scaffold_failed", error: (e as Error).message };
  }
}

// ─── Dashboard state composition ───────────────────────────────────────

/**
 * Compose the full dashboard Vault state. Handles the R7 status kinds
 * in the spec-required order — the first matching branch wins and lower
 * branches are not evaluated.
 *
 * The second argument `tenantId` is the tenant context the dashboard is
 * operating for (from resolveDashboardTenant in the route). Inspection
 * is parameterized on that id so `tenant_mismatch` is authoritative
 * against the current session rather than some global default.
 */
export function readVaultDashboardState(
  _sql: SqlTag | null,
  tenantId: string,
): VaultDashboardState {
  const enabled = readVaultEnabled();
  const browser_capture_auto_harvest = readBrowserCaptureAutoHarvest(tenantId);
  const configured = resolveConfiguredVaultRoot(tenantId);
  const tenantSettings = resolveTenantSettings();
  const vault_sync = tenantSettings.vault_sync;
  const obsidian_installed = detectObsidianInstall();
  const open_root_supported = isOpenRootSupported();
  const obsidian_open_supported = isOpenObsidianSupported();

  // Common base fields. Status-kind-specific branches below will override
  // the status-dependent pieces (tenant_match, dossier counts, etc.).
  const base: VaultDashboardState = {
    status_kind: "no_tenant",
    vault_enabled: enabled,
    vault_root: configured.root,
    vault_root_source: configured.source,
    vault_sync,
    vault_default_root: configured.default_root,
    discovery_error: null,
    vault_tenant_id: null,
    tenant_match: null,
    initialized: false,
    dossier_count: null,
    last_generated_at: null,
    obsidian_installed,
    obsidian_open_supported,
    open_root_supported,
    browser_capture_auto_harvest,
    recommended_actions: [],
  };

  const inspection = inspectSharedVaultRoot({
    tenantId,
    env: process.env,
    configPath: resolveConfigPath(),
    vaultEnabled: enabled,
  });
  if (!inspection.ok) {
    if (inspection.status === "no_tenant") {
      return {
        ...base,
        status_kind: "no_tenant",
        discovery_error: inspection.error,
        recommended_actions: ["select_tenant"],
      };
    }
    if (inspection.status === "init_required") {
      return {
        ...base,
        status_kind: "init_required",
        vault_root: inspection.root,
        vault_root_source: inspection.source ?? configured.source,
        discovery_error: inspection.error,
        initialized: false,
        recommended_actions: enabled ? ["initialize_vault", "change_vault_path"] : ["enable_vault", "initialize_vault"],
      };
    }
    if (inspection.status === "tenant_mismatch") {
      return {
        ...base,
        status_kind: "tenant_mismatch",
        vault_root: inspection.root,
        vault_root_source: inspection.source ?? configured.source,
        discovery_error: inspection.error,
        vault_tenant_id: inspection.vault_tenant_id ?? null,
        tenant_match: false,
        initialized: true,
        recommended_actions: ["change_vault_path"],
      };
    }
    if (inspection.status === "env_override_invalid") {
      return {
        ...base,
        status_kind: "env_override_invalid",
        vault_root: inspection.root,
        vault_root_source: inspection.source ?? configured.source,
        discovery_error: inspection.error,
        recommended_actions: ["fix_env_override"],
      };
    }
    return {
      ...base,
      status_kind: "unreadable",
      vault_root: inspection.root,
      vault_root_source: inspection.source ?? configured.source,
      discovery_error: inspection.error,
      recommended_actions: ["change_vault_path"],
    };
  }

  if (inspection.status === "disabled_ready") {
    return {
      ...base,
      status_kind: "disabled_ready",
      vault_root: inspection.root,
      vault_root_source: inspection.source,
      vault_tenant_id: inspection.vault_tenant_id,
      tenant_match: true,
      initialized: true,
      recommended_actions: ["enable_vault"],
    };
  }

  // 6. Ready — read dossier metadata best-effort.
  let dossier_count: number | null = null;
  let last_generated_at: string | null = null;
  try {
    const dossiers = listFinalizedDossierMetadata(inspection.root);
    dossier_count = dossiers.length;
    for (const d of dossiers) {
      if (d.generated_at && (!last_generated_at || d.generated_at > last_generated_at)) {
        last_generated_at = d.generated_at;
      }
    }
  } catch {
    // best-effort — leave nulls
  }

  const ready_actions: string[] = ["change_vault_path", "disable_vault"];
  if (open_root_supported) ready_actions.unshift("open_vault");
  if (obsidian_open_supported && obsidian_installed === true) {
    ready_actions.splice(1, 0, "open_in_obsidian");
  }

  return {
    ...base,
    status_kind: "ready",
    vault_root: inspection.root,
    vault_root_source: inspection.source,
    vault_tenant_id: inspection.vault_tenant_id,
    tenant_match: true,
    initialized: true,
    dossier_count,
    last_generated_at,
    recommended_actions: ready_actions,
  };
}
