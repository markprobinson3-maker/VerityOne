/**
 * Per-tenant DB-backed settings — VO-REACTOR-REVIVAL-LADDER-1 R4.
 *
 * R2 added a machine-level `trends_enabled` in ~/.vo/config.json.
 * R4 layers per-tenant settings in the DB so each tenant on the same
 * operator instance can opt in/out independently. The
 * combined gate is: machine flag (R2) AND tenant flag (R4) — both
 * must be true for the reactor to do forward-pipeline work in a
 * tenant's space.
 *
 * Q-R4 contract:
 *   - Default-off: row absent ≡ false. Tenants opt in.
 *   - Whitelist of writable keys is INDEPENDENT from the machine
 *     `WRITABLE_SETTINGS_KEYS`. Same key name (`trends_enabled`)
 *     happens to exist in both, but they are different policy domains.
 *   - Write helper verifies `graph_spaces.space_id = 'tenant:' || tenant_id`
 *     exists before writing — protects against typos that would
 *     create a setting for a tenant the rest of the system never sees.
 *   - Disabling tenant trends stops new forward processing
 *     (attachOrphanToTrendPool, clusterStandaloneOrphans,
 *     proto-cluster routing/birth/adopt) but does NOT freeze existing
 *     trends; cleanup/sync/archive/dedup still run across all spaces.
 *   - Disabling tenant trends does NOT hide visibility — beta callers
 *     still see global + their tenant space in /trends/* reads.
 *
 * Dependency-light invariant (codex P1 patch):
 *   This module accepts a SQL handle as a parameter and does NOT
 *   import from `../db`, `hono`, or `miners/src`. The reactor service
 *   imports `listEnabledTenantSpaces` from here cross-workspace, so
 *   the import boundary must stay one-way. Drift guard pins the
 *   absence of those imports.
 */

import { CORE_PYRAMID_IDS } from "@verity-one/graph-shape";

export type TenantSettingsSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PYRAMID_FOCUS_RE = /^[A-Z]{2,12}$/;
const SUPERCRON_INTENSITY_VALUES = ["light", "balanced", "thorough"] as const;
const SUPERCRON_QUALITY_PRESET_VALUES = ["lenient", "balanced", "strict"] as const;
const SUPERCRON_NODE_GC_APPLY_ACTION_VALUES = ["tombstone", "delete"] as const;
// Mirrors the (pure, DB-free) PolicyProfileName enum on policy-profile.ts. Inlined
// here — exactly as SUPERCRON_QUALITY_PRESET_VALUES mirrors supercron-policy's enum —
// so this dependency-light module stays free of the policy-profile import chain.
const POLICY_PROFILE_VALUES = ["conservative", "balanced", "aggressive"] as const;
export type TenantPolicyProfile = (typeof POLICY_PROFILE_VALUES)[number];

/**
 * Whitelist of tenant-writable setting keys. Intentionally narrow —
 * every future key needs its own SQL migration that widens the
 * `tenant_settings_key_check` CHECK and adds key-specific value
 * validation in TENANT_SETTING_VALUE_SHAPES. Drift guard pins this
 * is NOT aliased to the machine-level WRITABLE_SETTINGS_KEYS.
 */
export const WRITABLE_TENANT_SETTINGS_KEYS = [
  "trends_enabled",
  "supercron_cadence_minutes",
  "supercron_active_hours",
  "supercron_intensity",
  "supercron_pyramid_focus",
  "supercron_quality_preset",
  "supercron_llm_budget_usd_micro_daily",
  "golden_query_enabled",
  "recall_outcomes_enabled",
  "confidence_promotion_enabled",
  "supercron_node_gc_candidate_enabled",
  "supercron_node_gc_dormant_days",
  "supercron_node_gc_per_cycle_cap",
  "supercron_node_gc_max_active_candidates",
  "supercron_node_gc_rejection_cooldown_days",
  "supercron_node_gc_apply_enabled",
  "supercron_node_gc_apply_action",
  "supercron_node_gc_apply_per_cycle_cap",
  "policy_profile",
] as const;
export type WritableTenantSettingsKey = (typeof WRITABLE_TENANT_SETTINGS_KEYS)[number];

export interface SupercronActiveHours {
  start: number;
  end: number;
}

/**
 * Validation shape per writable key. `boolean` values are stored as
 * 'true'/'false' text in the DB (the SQL CHECK enforces this), while
 * structured controls are stored as JSON text after shape validation.
 */
export const TENANT_SETTING_VALUE_SHAPES = {
  trends_enabled: { kind: "boolean" as const },
  supercron_cadence_minutes: { kind: "integer" as const, min: 15, max: 1440 },
  supercron_active_hours: { kind: "active_hours" as const },
  supercron_intensity: { kind: "enum" as const, values: SUPERCRON_INTENSITY_VALUES },
  supercron_pyramid_focus: { kind: "pyramid_focus" as const },
  supercron_quality_preset: { kind: "enum" as const, values: SUPERCRON_QUALITY_PRESET_VALUES },
  supercron_llm_budget_usd_micro_daily: { kind: "integer" as const, min: 100_000, max: 2_000_000 },
  golden_query_enabled: { kind: "boolean" as const },
  recall_outcomes_enabled: { kind: "boolean" as const },
  confidence_promotion_enabled: { kind: "boolean" as const },
  supercron_node_gc_candidate_enabled: { kind: "boolean" as const },
  supercron_node_gc_dormant_days: { kind: "integer" as const, min: 30, max: 365 },
  supercron_node_gc_per_cycle_cap: { kind: "integer" as const, min: 1, max: 500 },
  supercron_node_gc_max_active_candidates: { kind: "integer" as const, min: 10, max: 5_000 },
  supercron_node_gc_rejection_cooldown_days: { kind: "integer" as const, min: 7, max: 365 },
  supercron_node_gc_apply_enabled: { kind: "boolean" as const },
  supercron_node_gc_apply_action: { kind: "enum" as const, values: SUPERCRON_NODE_GC_APPLY_ACTION_VALUES },
  supercron_node_gc_apply_per_cycle_cap: { kind: "integer" as const, min: 1, max: 50 },
  policy_profile: { kind: "enum" as const, values: POLICY_PROFILE_VALUES },
} as const;

export interface TenantSettings {
  /** Per-tenant on/off for the trend reactor pipeline. Defaults to false
   *  (opt-in). Layered inside the machine-level flag from R2. */
  trends_enabled: boolean;
  /** SuperCron cadence in minutes. Defaults to 240 (4 hours). */
  supercron_cadence_minutes: number;
  /** Tenant-configured active hours. PR14 records the value; PR15 enforces it. */
  supercron_active_hours: SupercronActiveHours;
  /** Tenant-configured maintenance intensity. PR15 maps this to pass policy. */
  supercron_intensity: (typeof SUPERCRON_INTENSITY_VALUES)[number];
  /** Canonical pyramid ids to focus. Empty array means all pyramids. */
  supercron_pyramid_focus: string[];
  /** Tenant-configured quality sensitivity. PR15 maps this to thresholds. */
  supercron_quality_preset: (typeof SUPERCRON_QUALITY_PRESET_VALUES)[number];
  /** Display-only PR14 daily budget, stored in micro-USD. PR15 enforces it. */
  supercron_llm_budget_usd_micro_daily: number;
  /** PR14 writes feature toggles; PR15 consumes them. Defaults preserve existing behavior. */
  golden_query_enabled: boolean;
  recall_outcomes_enabled: boolean;
  confidence_promotion_enabled: boolean;
  /** Non-destructive SuperCron node-GC candidate marking. Defaults off. */
  supercron_node_gc_candidate_enabled: boolean;
  /** Minimum dormant age before a memory can be marked as a GC candidate. */
  supercron_node_gc_dormant_days: number;
  /** Maximum GC candidates to mark in one SuperCron cycle. */
  supercron_node_gc_per_cycle_cap: number;
  /** Active candidate/approved receipt backpressure threshold. */
  supercron_node_gc_max_active_candidates: number;
  /** Cooldown before a rejected node can be marked again. */
  supercron_node_gc_rejection_cooldown_days: number;
  /** Destructive SuperCron node-GC apply pass. Defaults off. */
  supercron_node_gc_apply_enabled: boolean;
  /** Tenant-selected apply action for approved node-GC receipts. */
  supercron_node_gc_apply_action: (typeof SUPERCRON_NODE_GC_APPLY_ACTION_VALUES)[number];
  /** Maximum approved receipts to apply in one SuperCron cycle. */
  supercron_node_gc_apply_per_cycle_cap: number;
  /** Operating posture (#10 policy profile) the Tier-2 primitives resolve their
   *  review-queue / needs-attention / eval / routine knobs from. Defaults to balanced. */
  policy_profile: TenantPolicyProfile;
}

const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  trends_enabled: false,
  supercron_cadence_minutes: 240,
  supercron_active_hours: { start: 0, end: 24 },
  supercron_intensity: "light",
  supercron_pyramid_focus: [],
  supercron_quality_preset: "balanced",
  supercron_llm_budget_usd_micro_daily: 170_000,
  golden_query_enabled: true,
  recall_outcomes_enabled: true,
  confidence_promotion_enabled: true,
  supercron_node_gc_candidate_enabled: false,
  supercron_node_gc_dormant_days: 90,
  supercron_node_gc_per_cycle_cap: 50,
  supercron_node_gc_max_active_candidates: 200,
  supercron_node_gc_rejection_cooldown_days: 90,
  supercron_node_gc_apply_enabled: false,
  supercron_node_gc_apply_action: "tombstone",
  supercron_node_gc_apply_per_cycle_cap: 10,
  policy_profile: "balanced",
};

function defaultTenantSettings(): TenantSettings {
  return {
    ...DEFAULT_TENANT_SETTINGS,
    supercron_active_hours: { ...DEFAULT_TENANT_SETTINGS.supercron_active_hours },
    supercron_pyramid_focus: [...DEFAULT_TENANT_SETTINGS.supercron_pyramid_focus],
  };
}

export class TenantNotFoundError extends Error {
  constructor(public readonly tenantId: string) {
    super(`tenant graph_space not found for tenant_id="${tenantId}"`);
    this.name = "TenantNotFoundError";
  }
}

export interface SettingValidationResult {
  valid: boolean;
  error?: string;
}

export function validateTenantSettingValue(
  key: unknown,
  value: unknown,
): SettingValidationResult {
  if (typeof key !== "string" || key.length === 0) {
    return { valid: false, error: "setting key must be a non-empty string" };
  }
  if (!(WRITABLE_TENANT_SETTINGS_KEYS as readonly string[]).includes(key)) {
    return {
      valid: false,
      error: `setting key must be one of: ${WRITABLE_TENANT_SETTINGS_KEYS.join(", ")}`,
    };
  }
  const shape = TENANT_SETTING_VALUE_SHAPES[key as WritableTenantSettingsKey];
  if (shape.kind === "boolean") {
    if (typeof value !== "boolean") {
      return { valid: false, error: `${key} must be a boolean (true | false)` };
    }
  }
  if (shape.kind === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < shape.min || value > shape.max) {
      return { valid: false, error: `${key} must be an integer between ${shape.min} and ${shape.max}` };
    }
  }
  if (shape.kind === "enum") {
    if (typeof value !== "string" || !(shape.values as readonly string[]).includes(value)) {
      return { valid: false, error: `${key} must be one of: ${(shape.values as readonly string[]).join(", ")}` };
    }
  }
  if (shape.kind === "active_hours") {
    if (!isPlainRecord(value)) {
      return { valid: false, error: `${key} must be an object with integer start and end hours` };
    }
    const start = value.start;
    const end = value.end;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > 24 ||
      end < 0 ||
      end > 24 ||
      start === end ||
      (start === 24 && end === 0)
    ) {
      return { valid: false, error: `${key} must have integer start/end in [0, 24] and a non-zero window; start > end means overnight` };
    }
  }
  if (shape.kind === "pyramid_focus") {
    if (!Array.isArray(value)) {
      return { valid: false, error: `${key} must be an array of canonical pyramid ids` };
    }
    const knownPyramids = new Set<string>(CORE_PYRAMID_IDS as readonly string[]);
    for (const item of value) {
      if (typeof item !== "string" || !PYRAMID_FOCUS_RE.test(item) || !knownPyramids.has(item)) {
        return { valid: false, error: `${key} entries must be known canonical pyramid ids` };
      }
    }
  }
  return { valid: true };
}

function tenantIdValid(tenantId: string): boolean {
  return TENANT_ID_RE.test(tenantId);
}

function serializeBoolean(value: unknown): "true" | "false" {
  return value === true ? "true" : "false";
}

function parseBoolean(raw: string | null | undefined): boolean {
  return raw === "true";
}

function parseInteger(raw: string | null | undefined, fallback: number, min?: number, max?: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) return fallback;
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonSetting(raw: string | null | undefined, fallback: unknown): unknown {
  if (raw == null || raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseTenantSettingValue<K extends WritableTenantSettingsKey>(
  key: K,
  raw: string | null | undefined,
): TenantSettings[K] {
  const shape = TENANT_SETTING_VALUE_SHAPES[key];
  if (shape.kind === "boolean") return parseBoolean(raw) as TenantSettings[K];
  if (shape.kind === "integer") {
    return parseInteger(raw, DEFAULT_TENANT_SETTINGS[key] as number, shape.min, shape.max) as TenantSettings[K];
  }
  if (shape.kind === "enum") {
    return ((shape.values as readonly string[]).includes(String(raw)) ? raw : DEFAULT_TENANT_SETTINGS[key]) as TenantSettings[K];
  }
  if (shape.kind === "active_hours") {
    const fallback = { ...DEFAULT_TENANT_SETTINGS.supercron_active_hours };
    const parsed = parseJsonSetting(raw, fallback);
    return (validateTenantSettingValue(key, parsed).valid ? parsed : fallback) as TenantSettings[K];
  }
  if (shape.kind === "pyramid_focus") {
    const fallback = [...DEFAULT_TENANT_SETTINGS.supercron_pyramid_focus];
    const parsed = parseJsonSetting(raw, fallback);
    return (validateTenantSettingValue(key, parsed).valid ? parsed : fallback) as TenantSettings[K];
  }
  return DEFAULT_TENANT_SETTINGS[key];
}

function serializeTenantSettingValue<K extends WritableTenantSettingsKey>(
  key: K,
  value: TenantSettings[K],
): string {
  const shape = TENANT_SETTING_VALUE_SHAPES[key];
  if (shape.kind === "boolean") return serializeBoolean(value);
  if (shape.kind === "active_hours" || shape.kind === "pyramid_focus") return JSON.stringify(value);
  return String(value);
}

/**
 * Read a single tenant setting. Returns the parsed value or null when
 * the row is absent. Boolean keys deserialize from 'true'/'false' text.
 */
export async function readTenantSetting<K extends WritableTenantSettingsKey>(
  sql: TenantSettingsSql,
  tenantId: string,
  key: K,
): Promise<TenantSettings[K] | null> {
  if (!tenantIdValid(tenantId)) return null;
  const rows = await sql`
    SELECT value FROM tenant_settings
    WHERE tenant_id = ${tenantId} AND key = ${key as string}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const raw = String(rows[0].value);
  return parseTenantSettingValue(key, raw);
}

/**
 * Read a tenant's policy profile (#10), defaulting to "balanced" when the row is
 * absent or (defensively) unrecognized. The thin typed accessor consumers use to
 * feed resolvePolicyProfile(...) — keeps this module free of the policy-profile
 * import chain (it returns the inlined enum type, never imports the resolver). A
 * caller resolves the knobs with `resolvePolicyProfile(await readTenantPolicyProfile(...))`.
 */
export async function readTenantPolicyProfile(
  sql: TenantSettingsSql,
  tenantId: string | null | undefined,
): Promise<TenantPolicyProfile> {
  if (!tenantId || !tenantIdValid(tenantId)) return "balanced";
  const value = await readTenantSetting(sql, tenantId, "policy_profile");
  return value ?? "balanced";
}

/**
 * Read all tenant settings as a fully-resolved object with defaults
 * applied. Used by GET /dashboard/settings to render the merged view.
 */
export async function readTenantSettings(sql: TenantSettingsSql, tenantId: string | null | undefined): Promise<TenantSettings> {
  if (!tenantId || !tenantIdValid(tenantId)) {
    return defaultTenantSettings();
  }
  const rows = await sql`
    SELECT key, value FROM tenant_settings
    WHERE tenant_id = ${tenantId}
  `;
  const result: TenantSettings = defaultTenantSettings();
  for (const row of rows as Array<{ key: string; value: string }>) {
    if ((WRITABLE_TENANT_SETTINGS_KEYS as readonly string[]).includes(row.key)) {
      const key = row.key as WritableTenantSettingsKey;
      (result as any)[key] = parseTenantSettingValue(key, row.value);
    }
  }
  return result;
}

/**
 * Write a tenant setting. Verifies the corresponding `graph_spaces`
 * row exists before writing — a typo would otherwise create a setting
 * for a tenant the rest of the system never processes (silent failure).
 *
 * Throws:
 *   - Error("invalid tenant_id ...") for regex-invalid tenant ids.
 *   - Error from validateTenantSettingValue for bad key/value shapes.
 *   - TenantNotFoundError when graph_spaces has no `tenant:<id>` row.
 *
 * Returns { previous, next } — `previous` is null when the row didn't
 * exist before.
 */
export async function writeTenantSetting<K extends WritableTenantSettingsKey>(
  sql: TenantSettingsSql,
  tenantId: string,
  key: K,
  value: TenantSettings[K],
): Promise<{ previous: TenantSettings[K] | null; next: TenantSettings[K] }> {
  if (!tenantIdValid(tenantId)) {
    throw new Error(`invalid tenant_id: must match ${TENANT_ID_RE.source}`);
  }
  const validation = validateTenantSettingValue(key, value);
  if (!validation.valid) {
    throw new Error(validation.error || "invalid tenant setting value");
  }
  const spaceId = `tenant:${tenantId}`;
  const [spaceRow] = await sql`
    SELECT 1 FROM graph_spaces WHERE space_id = ${spaceId} LIMIT 1
  `;
  if (!spaceRow) {
    throw new TenantNotFoundError(tenantId);
  }

  const previous = await readTenantSetting(sql, tenantId, key);

  const serialized = serializeTenantSettingValue(key, value);

  await sql`
    INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
    VALUES (${tenantId}, ${key as string}, ${serialized}, now())
    ON CONFLICT (tenant_id, key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
  `;

  return { previous, next: value };
}

/**
 * Return the list of tenant space_ids whose `trends_enabled='true'`.
 * Used by the reactor to filter the per-space forward-processing
 * loop. Caller wraps the result with 'global' which is always
 * processed when the machine flag is on.
 *
 * The reactor imports this from miners/src/trends/service.ts
 * cross-workspace; the dependency-light invariant on this module
 * (no imports from ../db / hono / miners/src) keeps the import
 * boundary one-way and prevents circular deps.
 */
export async function listEnabledTenantSpaces(sql: TenantSettingsSql): Promise<string[]> {
  const rows = await sql`
    SELECT tenant_id FROM tenant_settings
    WHERE key = 'trends_enabled' AND value = 'true'
    ORDER BY tenant_id
  `;
  return (rows as Array<{ tenant_id: string }>).map((row) => `tenant:${row.tenant_id}`);
}
