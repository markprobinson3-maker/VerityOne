import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PARENT_NAME = "Verity One Vault";
const MARKER_NAME = ".vo-vault.json";

function cleanTenantId(tenantId) {
  return typeof tenantId === "string" && tenantId.trim() ? tenantId.trim() : null;
}

function readConfigRoot(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return typeof parsed.vault_root === "string" && parsed.vault_root.trim()
      ? parsed.vault_root.trim()
      : null;
  } catch {
    return null;
  }
}

export function defaultVaultParent(homeDir = process.env.HOME || os.homedir()) {
  return path.join(homeDir, PARENT_NAME);
}

export function defaultVaultRootForTenant(tenantId, homeDir = process.env.HOME || os.homedir()) {
  const tid = cleanTenantId(tenantId);
  if (!tid) throw new Error("tenant_id_required");
  return path.join(defaultVaultParent(homeDir), tid);
}

export function resolveVaultRoot(options = {}) {
  const tenantId = cleanTenantId(options.tenantId);
  if (!tenantId) {
    return {
      ok: false,
      status: "no_tenant",
      reason: "tenant_id_required",
      root: null,
      source: null,
      error: "tenant_id is required to resolve the default vault root.",
    };
  }

  const env = options.env || process.env;
  const homeDir = options.homeDir || env.HOME || process.env.HOME || os.homedir();
  const defaultRoot = defaultVaultRootForTenant(tenantId, homeDir);
  const explicitRoot = typeof options.explicitRoot === "string" && options.explicitRoot.trim()
    ? options.explicitRoot.trim()
    : null;
  if (explicitRoot) {
    return { ok: true, root: explicitRoot, source: "explicit", tenant_id: tenantId, default_root: defaultRoot };
  }

  const envRoot = (env.VERITY_VAULT_ROOT || "").trim();
  if (envRoot) {
    return { ok: true, root: envRoot, source: "env", tenant_id: tenantId, default_root: defaultRoot };
  }

  const configRoot = readConfigRoot(options.configPath);
  if (configRoot) {
    return { ok: true, root: configRoot, source: "config", tenant_id: tenantId, default_root: defaultRoot };
  }

  return { ok: true, root: defaultRoot, source: "default", tenant_id: tenantId, default_root: defaultRoot };
}

function markerTenant(marker) {
  return typeof marker.tenant_id === "string" && marker.tenant_id.trim()
    ? marker.tenant_id.trim()
    : null;
}

function isDirectoryEmpty(root) {
  try {
    return fs.readdirSync(root).filter((entry) => entry !== ".DS_Store").length === 0;
  } catch {
    return false;
  }
}

export function inspectVaultRoot(options = {}) {
  const vaultEnabled = options.vaultEnabled === true;
  const resolved = resolveVaultRoot(options);
  if (!resolved.ok) {
    return {
      ok: false,
      status: "no_tenant",
      reason: "tenant_id_required",
      root: null,
      source: null,
      tenant_id: null,
      vault_enabled: vaultEnabled,
      error: resolved.error,
    };
  }

  const { root, source, tenant_id: tenantId } = resolved;
  if (!path.isAbsolute(root)) {
    return {
      ok: false,
      status: source === "env" ? "env_override_invalid" : "unreadable",
      reason: "not_absolute",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: `Vault root must be an absolute path (got ${JSON.stringify(root)}).`,
    };
  }

  if (!fs.existsSync(root)) {
    return {
      ok: false,
      status: source === "env" ? "env_override_invalid" : "init_required",
      reason: "missing_path",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: source === "env"
        ? `VERITY_VAULT_ROOT points to a path that does not exist: ${root}`
        : `Vault root is not initialized yet: ${root}`,
    };
  }

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (e) {
    return {
      ok: false,
      status: source === "env" ? "env_override_invalid" : "unreadable",
      reason: "stat_failed",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: `Vault root is not readable: ${e.message}`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      status: source === "env" ? "env_override_invalid" : "unreadable",
      reason: "not_directory",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: `Vault root is not a directory: ${root}`,
    };
  }

  const markerPath = path.join(root, MARKER_NAME);
  if (!fs.existsSync(markerPath)) {
    const empty = isDirectoryEmpty(root);
    return {
      ok: false,
      status: empty ? "init_required" : "unreadable",
      reason: empty ? "missing_marker_empty" : "missing_marker_non_empty",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: empty
        ? `Vault root is empty and needs initialization: ${root}`
        : `Directory is not an initialized VO vault and is not empty: ${root}`,
    };
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  } catch (e) {
    return {
      ok: false,
      status: "unreadable",
      reason: "invalid_marker_json",
      root,
      source,
      tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: `${MARKER_NAME} at ${root} is not valid JSON: ${e.message}`,
    };
  }

  const vaultTenantId = markerTenant(marker);
  if (!vaultTenantId) {
    return {
      ok: false,
      status: "unreadable",
      reason: "missing_tenant_binding",
      root,
      source,
      tenant_id: tenantId,
      vault_tenant_id: null,
      vault_enabled: vaultEnabled,
      error: `${MARKER_NAME} at ${root} is missing tenant_id.`,
    };
  }

  if (vaultTenantId !== tenantId) {
    return {
      ok: false,
      status: "tenant_mismatch",
      reason: "tenant_mismatch",
      root,
      source,
      tenant_id: tenantId,
      vault_tenant_id: vaultTenantId,
      expected_tenant_id: tenantId,
      vault_enabled: vaultEnabled,
      error: `Vault at ${root} is bound to tenant "${vaultTenantId}" but expected "${tenantId}".`,
    };
  }

  return {
    ok: true,
    status: vaultEnabled ? "ready" : "disabled_ready",
    root,
    source,
    tenant_id: tenantId,
    vault_tenant_id: vaultTenantId,
    vault_enabled: vaultEnabled,
    marker,
    error: null,
  };
}

export function vaultSkipReasonForStatus(status) {
  if (status === "ready") return null;
  if (status === "disabled_ready") return "vault_disabled";
  if (status === "init_required") return "init_required";
  if (status === "tenant_mismatch") return "tenant_mismatch";
  if (status === "env_override_invalid") return "env_override_invalid";
  if (status === "unreadable") return "unreadable";
  if (status === "no_tenant") return "no_tenant";
  return "unreadable";
}
