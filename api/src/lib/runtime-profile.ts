/**
 * Shared runtime-profile resolver.
 *
 * The single authority for profile selection across every VO entrypoint
 * (api process, runtime-supervisor, `vo doctor`). Implements the binding
 * resolution chain locked in docs/VO-RUNTIME-PROFILES.md:
 *
 *   1. `~/.vo/config.json#profile` — persisted authority. If present with a
 *      valid value, return it and STOP. `VERITY_PROFILE` is NOT read when
 *      the config file has a valid `profile` field. This is how the
 *      split-brain is prevented: every process reads the same file.
 *
 *   2. `VERITY_PROFILE` environment variable — fallback read ONLY when the
 *      config file is absent OR has no `profile` field. For bootstrap and
 *      CI flows that don't yet have a persisted config.
 *
 *   3. Default `"tenant-default"` — when neither source is set.
 *
 * Invalid values from either source throw `RuntimeProfileError`. Every
 * caller must catch and exit non-zero with the error on stderr.
 *
 * This module has zero heavy dependencies (only node:fs, node:os, node:path)
 * so it can be imported by Bun scripts (api, supervisor, vo-cli) and Node
 * scripts alike without pulling in the api's Hono / Postgres stack.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimeProfile = "tenant-default" | "full";
export type ProfileSource = "config_file" | "env_fallback" | "default";

export interface ResolvedProfile {
  profile: RuntimeProfile;
  source: ProfileSource;
}

export class RuntimeProfileError extends Error {
  constructor(
    message: string,
    public readonly offendingValue: string,
    public readonly sourceKind: "config_file" | "env_fallback",
  ) {
    super(message);
    this.name = "RuntimeProfileError";
  }
}

const VALID_PROFILES: readonly RuntimeProfile[] = ["tenant-default", "full"] as const;

/**
 * Config path override for testing — reads `VO_CONFIG_PATH` env var if set,
 * otherwise falls back to `~/.vo/config.json`. Test suites set this to an
 * isolated path under `/tmp` so they don't clobber the tenant's real config.
 * Tenants and the documented install path never set this var.
 *
 * Exported so every VO entrypoint that reads or writes the config (api,
 * supervisor, vo-cli, vo-profile) reads from exactly the same path. A
 * hardcoded `os.homedir() + "/.vo/config.json"` anywhere else in the tree
 * is a bug — the two paths will disagree whenever VO_CONFIG_PATH is set,
 * and the status surface will contradict the resolver.
 */
export function resolveConfigPath(): string {
  const override = process.env.VO_CONFIG_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".vo", "config.json");
}

/** @deprecated use resolveConfigPath — kept as the internal alias for readability below */
function configPath(): string {
  return resolveConfigPath();
}

function isValidProfile(value: unknown): value is RuntimeProfile {
  return typeof value === "string" && (VALID_PROFILES as readonly string[]).includes(value);
}

function readConfigProfile(): { present: boolean; value: string | null } {
  const cfgPath = configPath();
  if (!fs.existsSync(cfgPath)) return { present: false, value: null };
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf-8");
  } catch {
    return { present: false, value: null };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Config file exists but is not parseable — treat as absent for resolution
    // purposes. The api's main config loader (config.ts) will fail loudly
    // on the same file; this resolver stays narrow and silent.
    return { present: false, value: null };
  }
  if (!("profile" in parsed)) return { present: false, value: null };
  const rawProfile = parsed.profile;
  if (rawProfile === null || rawProfile === undefined) return { present: false, value: null };
  return { present: true, value: String(rawProfile) };
}

/**
 * Resolve the runtime profile exactly per the binding chain. Throws
 * RuntimeProfileError on an invalid value from either config or env.
 */
export function resolveRuntimeProfile(): ResolvedProfile {
  // Source 1: ~/.vo/config.json#profile (with override for testing)
  const configField = readConfigProfile();
  if (configField.present) {
    const value = configField.value!;
    if (!isValidProfile(value)) {
      throw new RuntimeProfileError(
        `invalid profile in ${configPath()}: "${value}". Must be "tenant-default" or "full".`,
        value,
        "config_file",
      );
    }
    // STOP here. Env is not read when config has a valid value.
    return { profile: value, source: "config_file" };
  }

  // Source 2: VERITY_PROFILE env var (fallback only when config has no field)
  const envRaw = (process.env.VERITY_PROFILE || "").trim();
  if (envRaw) {
    if (!isValidProfile(envRaw)) {
      throw new RuntimeProfileError(
        `invalid VERITY_PROFILE env value: "${envRaw}". Must be "tenant-default" or "full".`,
        envRaw,
        "env_fallback",
      );
    }
    return { profile: envRaw, source: "env_fallback" };
  }

  // Source 3: default
  return { profile: "tenant-default", source: "default" };
}

// ── Tenant settings resolver ──────────────────────────────────────────
//
// Machine-level tenant controls per TENANT-CONTROL-SURFACE-DESIGN-PR-1.
// Read from the same config file the profile resolver uses. Each field
// is optional — safe defaults apply when absent.
//
// Separation from profile: profile controls the RUNTIME SHAPE (which
// processes run). Settings controls the POLICY SHAPE (what those processes
// allow). Both live in ~/.vo/config.json, read through resolveConfigPath().

export type PublicResonance = "off" | "assist" | "active";
export type HostedSync = "off" | "outbound";
export type VaultSync = "off" | "metadata_only";
export type PublicOverlaySync = "off" | "pull";

export interface TenantSettings {
  /** Master on/off for the VO memory loop. */
  vo_enabled: boolean;
  /** Master on/off for the trend reactor pipeline (R2). Defaults to off.
   *  Asymmetric with vo_enabled — the memory loop is always on by
   *  default, but the trend reactor is opt-in so a fresh install
   *  produces no clustering noise until an operator turns it on. */
  trends_enabled: boolean;
  /** Whether public-graph knowledge can influence agent behavior. */
  public_resonance: PublicResonance;
  /** Optional hosted-account outbound sync (stub, not wired). */
  hosted_sync: HostedSync;
  /** Vault artifact sync behavior (stub, not wired). */
  vault_sync: VaultSync;
  /** Public overlay sync: whether this node pulls signed public overlays.
   *  "off" = no new pulls (existing imports remain locally readable).
   *  "pull" = manual pulls allowed via `vo overlay pull`. */
  public_overlay_sync: PublicOverlaySync;
  /** Opt-in API boot migration runner. Default off; hosted deploys usually migrate explicitly. */
  auto_migrate_on_boot: boolean;
  /** Project addrs included in outbound sync. Internal only until project registry ships. */
  sync_projects: string[] | null;
  /** R6: optional account/governance mirror content. Control-plane sync still exports while connected. */
  sync_account_governance: boolean;
  /** R6: unprojected memory graph mirror. */
  sync_non_project_graph: boolean;
  /** R6: tenant-facing project category switch; selected project addrs are stored in sync_projects. */
  sync_projects_enabled: boolean;
  /** R6: local preference schema anchor for future vault/Drive migrations. */
  sync_preferences_version: number | null;
  /** R8: Google Drive mirror category switches, stored outside WRITABLE_SETTINGS_KEYS. */
  sync_vault_dossiers: boolean;
  sync_raw_capture_files: boolean;
  sync_drive_mirror: boolean;
}

export interface SettingsInvalidEntry {
  key: string;
  raw_value: unknown;
  valid_values: string;
}

export interface ResolvedTenantSettings extends TenantSettings {
  /** Which fields were explicitly set in the config vs defaulted. */
  sources: Record<keyof TenantSettings, "config_file" | "default">;
  /** Fields that were present in the config but had invalid values.
   *  These defaulted to permissive safe values, which is dangerous
   *  for policy ceilings — a typo like "fase" in vo_enabled would
   *  silently re-enable the memory loop. Callers MUST check this
   *  array and surface warnings to the tenant. */
  invalid: SettingsInvalidEntry[];
}

// VO-DASHBOARD-HOSTED-SETTINGS-PR-1: exported so the command validator
// + hosted Settings UI can build enum dropdowns from the same source
// of truth as `writeTenantSetting()`. Drift between these would let
// the hosted form show options the validator/helper would reject.
export const VALID_PUBLIC_RESONANCE: readonly PublicResonance[] = ["off", "assist", "active"];
export const VALID_HOSTED_SYNC: readonly HostedSync[] = ["off", "outbound"];
export const VALID_VAULT_SYNC: readonly VaultSync[] = ["off", "metadata_only"];
export const VALID_PUBLIC_OVERLAY_SYNC: readonly PublicOverlaySync[] = ["off", "pull"];

/** Allowed values per writable setting key. The hosted Settings page
 *  consumes this to build per-key controls (boolean toggle / enum
 *  select), and the queue-time validator consumes it to enforce the
 *  same shape `writeTenantSetting` would reject. Keeping one map
 *  prevents the validator/UI from drifting from the helper. */
export const SETTING_VALUE_SHAPES = {
  vo_enabled: { kind: "boolean" as const },
  trends_enabled: { kind: "boolean" as const },
  public_resonance: { kind: "enum" as const, values: VALID_PUBLIC_RESONANCE },
  hosted_sync: { kind: "enum" as const, values: VALID_HOSTED_SYNC },
  vault_sync: { kind: "enum" as const, values: VALID_VAULT_SYNC },
  public_overlay_sync: { kind: "enum" as const, values: VALID_PUBLIC_OVERLAY_SYNC },
  auto_migrate_on_boot: { kind: "boolean" as const },
} as const;

/** Shared validator for one (key, value) settings pair. Returns the
 *  same shape the command validator returns so callers can map to
 *  honest user errors. The helper itself (`writeTenantSetting`) still
 *  asserts independently — this is queue-time defense in depth. */
export function validateSettingValue(
  key: unknown,
  value: unknown,
): { valid: true } | { valid: false; error: string } {
  if (typeof key !== "string" || key.length === 0) {
    return { valid: false, error: "setting key must be a non-empty string" };
  }
  if (!(WRITABLE_SETTINGS_KEYS as readonly string[]).includes(key)) {
    return { valid: false, error: `setting key must be one of: ${WRITABLE_SETTINGS_KEYS.join(", ")}` };
  }
  const shape = (SETTING_VALUE_SHAPES as Record<string, { kind: "boolean" } | { kind: "enum"; values: readonly string[] }>)[key];
  if (shape.kind === "boolean") {
    if (typeof value !== "boolean") {
      return { valid: false, error: `${key} must be a boolean (true | false)` };
    }
    return { valid: true };
  }
  // enum
  if (typeof value !== "string" || !shape.values.includes(value)) {
    return { valid: false, error: `${key} must be one of: ${shape.values.join(", ")}` };
  }
  return { valid: true };
}

const DEFAULT_SETTINGS: TenantSettings = {
  vo_enabled: true,
  trends_enabled: false,
  public_resonance: "assist",
  hosted_sync: "off",
  vault_sync: "off",
  public_overlay_sync: "off",
  auto_migrate_on_boot: false,
  sync_projects: null,
  sync_account_governance: true,
  sync_non_project_graph: true,
  sync_projects_enabled: false,
  sync_preferences_version: null,
  sync_vault_dossiers: false,
  sync_raw_capture_files: false,
  sync_drive_mirror: false,
};

/**
 * Resolve tenant settings from the config file. Pure read — no mutations.
 * Safe defaults apply for every missing field. INVALID values (present but
 * wrong type or not in the valid set) are tracked in the `invalid` array
 * so callers can surface them as warnings. The runtime still uses the
 * default, but the invalid entry makes the broken state visible instead
 * of silently defaulting a policy ceiling away.
 */
export function resolveTenantSettings(): ResolvedTenantSettings {
  const cfgPath = resolveConfigPath();
  const sources: Record<keyof TenantSettings, "config_file" | "default"> = {
    vo_enabled: "default",
    trends_enabled: "default",
    public_resonance: "default",
    hosted_sync: "default",
    vault_sync: "default",
    public_overlay_sync: "default",
    auto_migrate_on_boot: "default",
    sync_projects: "default",
    sync_account_governance: "default",
    sync_non_project_graph: "default",
    sync_projects_enabled: "default",
    sync_preferences_version: "default",
    sync_vault_dossiers: "default",
    sync_raw_capture_files: "default",
    sync_drive_mirror: "default",
  };
  const invalid: SettingsInvalidEntry[] = [];

  let parsed: Record<string, unknown> = {};
  try {
    if (fs.existsSync(cfgPath)) {
      parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // Unparseable config — use all defaults. The profile resolver and
    // other config readers will surface the parse error separately.
    return { ...DEFAULT_SETTINGS, sources, invalid };
  }

  const result: TenantSettings = { ...DEFAULT_SETTINGS };

  // vo_enabled — boolean only
  if ("vo_enabled" in parsed) {
    if (typeof parsed.vo_enabled === "boolean") {
      result.vo_enabled = parsed.vo_enabled;
      sources.vo_enabled = "config_file";
    } else {
      invalid.push({ key: "vo_enabled", raw_value: parsed.vo_enabled, valid_values: "true | false (boolean)" });
    }
  }

  // trends_enabled — boolean only (R2: machine-level trend reactor kill switch)
  if ("trends_enabled" in parsed) {
    if (typeof parsed.trends_enabled === "boolean") {
      result.trends_enabled = parsed.trends_enabled;
      sources.trends_enabled = "config_file";
    } else {
      invalid.push({ key: "trends_enabled", raw_value: parsed.trends_enabled, valid_values: "true | false (boolean)" });
    }
  }

  // public_resonance — enum string
  if ("public_resonance" in parsed) {
    const v = parsed.public_resonance;
    if (typeof v === "string" && (VALID_PUBLIC_RESONANCE as readonly string[]).includes(v)) {
      result.public_resonance = v as PublicResonance;
      sources.public_resonance = "config_file";
    } else {
      invalid.push({ key: "public_resonance", raw_value: v, valid_values: VALID_PUBLIC_RESONANCE.join(" | ") });
    }
  }

  // hosted_sync — enum string
  if ("hosted_sync" in parsed) {
    const v = parsed.hosted_sync;
    if (typeof v === "string" && (VALID_HOSTED_SYNC as readonly string[]).includes(v)) {
      result.hosted_sync = v as HostedSync;
      sources.hosted_sync = "config_file";
    } else {
      invalid.push({ key: "hosted_sync", raw_value: v, valid_values: VALID_HOSTED_SYNC.join(" | ") });
    }
  }

  // vault_sync — enum string
  if ("vault_sync" in parsed) {
    const v = parsed.vault_sync;
    if (typeof v === "string" && (VALID_VAULT_SYNC as readonly string[]).includes(v)) {
      result.vault_sync = v as VaultSync;
      sources.vault_sync = "config_file";
    } else {
      invalid.push({ key: "vault_sync", raw_value: v, valid_values: VALID_VAULT_SYNC.join(" | ") });
    }
  }

  // public_overlay_sync — enum string
  if ("public_overlay_sync" in parsed) {
    const v = parsed.public_overlay_sync;
    if (typeof v === "string" && (VALID_PUBLIC_OVERLAY_SYNC as readonly string[]).includes(v)) {
      result.public_overlay_sync = v as PublicOverlaySync;
      sources.public_overlay_sync = "config_file";
    } else {
      invalid.push({ key: "public_overlay_sync", raw_value: v, valid_values: VALID_PUBLIC_OVERLAY_SYNC.join(" | ") });
    }
  }

  if ("auto_migrate_on_boot" in parsed) {
    if (typeof parsed.auto_migrate_on_boot === "boolean") {
      result.auto_migrate_on_boot = parsed.auto_migrate_on_boot;
      sources.auto_migrate_on_boot = "config_file";
    } else {
      invalid.push({ key: "auto_migrate_on_boot", raw_value: parsed.auto_migrate_on_boot, valid_values: "true | false (boolean)" });
    }
  }

  // sync_projects (internal only — not exposed to tenants yet)
  if ("sync_projects" in parsed) {
    if (Array.isArray(parsed.sync_projects)) {
      result.sync_projects = parsed.sync_projects.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      sources.sync_projects = "config_file";
    } else if (parsed.sync_projects === null) {
      result.sync_projects = null;
      sources.sync_projects = "config_file";
    }
  }

  // R6 local sync preference booleans
  for (const key of [
    "sync_account_governance",
    "sync_non_project_graph",
    "sync_projects_enabled",
    "sync_vault_dossiers",
    "sync_raw_capture_files",
    "sync_drive_mirror",
  ] as const) {
    if (key in parsed) {
      if (typeof parsed[key] === "boolean") {
        result[key] = parsed[key];
        sources[key] = "config_file";
      } else {
        invalid.push({ key, raw_value: parsed[key], valid_values: "true | false (boolean)" });
      }
    }
  }

  if ("sync_preferences_version" in parsed) {
    const v = parsed.sync_preferences_version;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) {
      result.sync_preferences_version = v;
      sources.sync_preferences_version = "config_file";
    } else if (v !== null) {
      invalid.push({ key: "sync_preferences_version", raw_value: v, valid_values: "positive integer or null" });
    }
  }

  return { ...result, sources, invalid };
}

/**
 * Atomically write a single tenant-settings field to the config file.
 * Preserves all unrelated fields (auth, profile, etc.). Uses temp-file
 * + rename for crash safety.
 *
 * Only the simple-valued tenant-facing fields listed below are writable through
 * this helper. `sync_projects` uses `writeSyncProjects()` instead because
 * it takes a resolved addr array, not a simple scalar.
 */
export const WRITABLE_SETTINGS_KEYS = ["vo_enabled", "trends_enabled", "public_resonance", "hosted_sync", "vault_sync", "public_overlay_sync", "auto_migrate_on_boot"] as const;
export type WritableSettingsKey = (typeof WRITABLE_SETTINGS_KEYS)[number];

export function writeTenantSetting(
  key: WritableSettingsKey,
  value: unknown,
  options?: { sql?: any; tenantId?: string },
): { configPath: string; previous: unknown; next: unknown } {
  const cfgPath = resolveConfigPath();

  // Validate
  switch (key) {
    case "vo_enabled":
      if (value !== true && value !== false) {
        throw new Error(`vo_enabled must be true or false, got: ${JSON.stringify(value)}`);
      }
      break;
    case "trends_enabled":
      if (value !== true && value !== false) {
        throw new Error(`trends_enabled must be true or false, got: ${JSON.stringify(value)}`);
      }
      break;
    case "public_resonance":
      if (!(VALID_PUBLIC_RESONANCE as readonly string[]).includes(value as string)) {
        throw new Error(`public_resonance must be one of: ${VALID_PUBLIC_RESONANCE.join(", ")}. Got: ${JSON.stringify(value)}`);
      }
      break;
    case "hosted_sync":
      if (!(VALID_HOSTED_SYNC as readonly string[]).includes(value as string)) {
        throw new Error(`hosted_sync must be one of: ${VALID_HOSTED_SYNC.join(", ")}. Got: ${JSON.stringify(value)}`);
      }
      break;
    case "vault_sync":
      if (!(VALID_VAULT_SYNC as readonly string[]).includes(value as string)) {
        throw new Error(`vault_sync must be one of: ${VALID_VAULT_SYNC.join(", ")}. Got: ${JSON.stringify(value)}`);
      }
      break;
    case "public_overlay_sync":
      if (!(VALID_PUBLIC_OVERLAY_SYNC as readonly string[]).includes(value as string)) {
        throw new Error(`public_overlay_sync must be one of: ${VALID_PUBLIC_OVERLAY_SYNC.join(", ")}. Got: ${JSON.stringify(value)}`);
      }
      break;
    case "auto_migrate_on_boot":
      if (value !== true && value !== false) {
        throw new Error(`auto_migrate_on_boot must be true or false, got: ${JSON.stringify(value)}`);
      }
      break;
  }

  // Read existing
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

  const previous = existing[key] ?? null;
  existing[key] = value;

  // Atomic write
  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, cfgPath);

  // Sync journal: governance upsert for machine settings change.
  // Optional — callers without DB access skip this; the exporter's
  // governance snapshot will still pick up the latest state on the next
  // batch triggered by any mutation.
  if (options?.sql && options?.tenantId) {
    const { journalGovernance } = require("./sync-journal-port");
    journalGovernance(options.sql, "machine_settings", `tenant:${options.tenantId}`).catch((e: any) =>
      console.error("[runtime-profile] journalGovernance failed:", e?.message),
    );
  }

  return { configPath: cfgPath, previous, next: value };
}

/**
 * Atomically write `sync_projects` to the config file.
 * Accepts a resolved addr array (names already resolved by the caller)
 * or null to clear the selection.
 */
export function writeSyncProjects(
  addrs: string[] | null,
  options?: { sql?: any; tenantId?: string },
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

  const previous = existing.sync_projects ?? null;
  existing.sync_projects = addrs;

  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, cfgPath);

  // Sync journal: governance upsert for sync_projects change
  if (options?.sql && options?.tenantId) {
    const { journalGovernance } = require("./sync-journal-port");
    journalGovernance(options.sql, "machine_settings", `tenant:${options.tenantId}`).catch((e: any) =>
      console.error("[runtime-profile] journalGovernance failed:", e?.message),
    );
  }

  return { configPath: cfgPath, previous, next: addrs };
}

// ── Profile formatting ────────────────────────────────────────────────

/**
 * Format the resolved profile + source as a human-readable banner line
 * suitable for logging at startup. Used by the api, supervisor, and CLI.
 */
export function formatProfileBanner(resolved: ResolvedProfile): string {
  switch (resolved.source) {
    case "config_file":
      return `profile: ${resolved.profile} (source: config_file)`;
    case "env_fallback":
      return `profile: ${resolved.profile} (source: env_fallback — ~/.vo/config.json has no profile field)`;
    case "default":
      return (
        `profile: ${resolved.profile} (source: default — ~/.vo/config.json has no profile field ` +
        `and VERITY_PROFILE is not set). To run the full developer/operator stack, ` +
        `add "profile": "full" to ~/.vo/config.json.`
      );
  }
}
