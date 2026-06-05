/**
 * Tenant operating template (Multi-Tenant Productization, MT1).
 *
 * A pure RESOLVER that composes a tenant's operating posture from the structures that ALREADY back
 * it — there is no new table and no Tenant-Zero default. It answers: "for tenant X, what policy
 * profile, SuperCron/budget posture, routine/review/attention/eval knobs, projects, pyramids, and
 * sync preferences govern the operating loop?" — by reading tenant_settings, the resolved policy
 * profile, projects, tenant pyramids, and tenant_sync_preferences, all keyed on the tenant.
 *
 * Tenant Zero and a second tenant resolve through the SAME path; a tenant on the `balanced` profile
 * with default settings resolves to the primitives' own defaults (i.e. existing behavior).
 */

import {
  type PolicyProfileName,
  type ResolvedPolicy,
  resolvePolicyProfile,
  validateResolvedPolicy,
} from "./policy-profile";
import { type TenantSettings, readTenantSettings } from "./tenant-settings";
import { type TenantSyncPreferences, selectTenantSyncPreferences } from "./tenant-sync-preferences";
import { type ProjectRow, listProjects } from "./project-registry";
import { type TenantPyramidRow, listTenantPyramids } from "./tenant-pyramids";

// Matches the loose Sql alias the composed tenant libs already use (project-registry.ts etc.).
type SqlTag = any;

export interface TenantTemplateProject {
  addr: string;
  label: string;
  space_id: string;
  pyramid_system_key: string | null;
}

export interface TenantTemplatePyramid {
  pyramid_id: string;
  /** The owning tenant — kept on the view so a mis-scoped pyramid is catchable by
   *  validateTenantOperatingTemplate AND by the MT4 proof's JSON substring isolation check. */
  tenant_id: string;
  system_key: string | null;
  label: string;
  kind: "system" | "user";
  sync_level: "local_only" | "managed_mirror";
}

export interface TenantOperatingTemplate {
  tenant_id: string;
  space_id: string;
  /** The policy profile name this tenant operates under (conservative|balanced|aggressive). */
  policy_profile: PolicyProfileName;
  /** The resolved review-queue / needs-attention / eval / routine / quality knobs for that profile. */
  policy: ResolvedPolicy;
  /** SuperCron cadence/intensity/budget + golden/recall toggles + node-GC posture (tenant_settings). */
  settings: TenantSettings;
  /** What syncs for this tenant (null when not yet provisioned). */
  sync_preferences: TenantSyncPreferences | null;
  /** The tenant's projects (each scoped to space_id == tenant:<id>). */
  default_projects: TenantTemplateProject[];
  /** The tenant's pyramids (system + user). */
  pyramids: TenantTemplatePyramid[];
}

/**
 * PURE composition from already-loaded, tenant-scoped inputs. DB-free so it is testable and reusable
 * by the productization proof. The policy is resolved from settings.policy_profile (the single source
 * of the tenant's posture), so balanced+defaults == existing behavior.
 */
export function composeTenantOperatingTemplate(input: {
  tenantId: string;
  settings: TenantSettings;
  syncPreferences: TenantSyncPreferences | null;
  projects: ProjectRow[];
  pyramids: TenantPyramidRow[];
}): TenantOperatingTemplate {
  const policy = resolvePolicyProfile(input.settings.policy_profile);
  return {
    tenant_id: input.tenantId,
    space_id: `tenant:${input.tenantId}`,
    // policy.profile is the AUTHORITATIVE normalized profile (resolvePolicyProfile coerces an
    // unknown value to balanced); validateTenantOperatingTemplate pins it == policy_profile.
    policy_profile: policy.profile,
    policy,
    settings: input.settings,
    sync_preferences: input.syncPreferences,
    default_projects: input.projects.map((p) => ({
      addr: p.addr,
      label: p.label,
      space_id: p.space_id,
      pyramid_system_key: p.pyramid_system_key,
    })),
    pyramids: input.pyramids.map((py) => ({
      pyramid_id: py.pyramid_id,
      tenant_id: py.tenant_id,
      system_key: py.system_key,
      label: py.label,
      kind: py.kind,
      sync_level: py.sync_level,
    })),
  };
}

/** Degrade a missing-table (un-migrated schema) read to a fallback rather than rejecting the whole
 *  Promise.all — mirrors selectTenantSyncPreferences's own 42P01 handling. "Unprovisioned" means the
 *  tenant has no ROWS yet (→ defaults/empty); a 42P01 only fires on a genuinely un-migrated DB. */
function onMissingTable<T>(fallback: T) {
  return (e: unknown): T => {
    if ((e as { code?: string })?.code === "42P01") return fallback;
    throw e;
  };
}

/**
 * Resolve the operating template for a tenant from the live DB. Every read is tenant-scoped
 * (readTenantSettings/selectTenantSyncPreferences by tenant_id; listProjects by space_id;
 * listTenantPyramids by tenant_id), so a second tenant's template can never include a first
 * tenant's rows. An UNPROVISIONED tenant (no rows yet) resolves to defaults + empty
 * projects/pyramids + null sync preferences. Requires a non-empty tenantId.
 */
export async function resolveTenantOperatingTemplate(sql: SqlTag, tenantId: string): Promise<TenantOperatingTemplate> {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new Error("resolveTenantOperatingTemplate requires a non-empty tenantId");
  }
  const [settings, syncPreferences, projects, pyramids] = await Promise.all([
    readTenantSettings(sql, tenantId),
    selectTenantSyncPreferences(sql, tenantId),
    listProjects(sql, `tenant:${tenantId}`).catch(onMissingTable<ProjectRow[]>([])),
    listTenantPyramids(sql, tenantId).catch(onMissingTable<TenantPyramidRow[]>([])),
  ]);
  return composeTenantOperatingTemplate({ tenantId, settings, syncPreferences, projects, pyramids });
}

export interface TenantTemplateValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a resolved template is internally consistent + tenant-bound: the policy is one of the
 * valid profiles, space_id matches tenant_id, every project belongs to THIS tenant's space, and
 * the sync preferences (when present) name this tenant. Catches a mis-scoped composition before the
 * proof trusts it.
 */
export function validateTenantOperatingTemplate(t: TenantOperatingTemplate): TenantTemplateValidation {
  const errors: string[] = [];
  if (!t.tenant_id) errors.push("missing tenant_id");
  if (t.space_id !== `tenant:${t.tenant_id}`) errors.push(`space_id ${t.space_id} != tenant:${t.tenant_id}`);
  if (t.policy_profile !== t.policy.profile) errors.push("policy_profile does not match resolved policy");
  const pv = validateResolvedPolicy(t.policy);
  if (!pv.ok) errors.push(...pv.errors.map((e) => `policy: ${e}`));
  for (const p of t.default_projects) {
    if (p.space_id !== t.space_id) errors.push(`project ${p.addr} is in foreign space ${p.space_id}`);
  }
  for (const py of t.pyramids) {
    if (py.tenant_id !== t.tenant_id) errors.push(`pyramid ${py.pyramid_id} belongs to ${py.tenant_id}, not ${t.tenant_id}`);
  }
  if (t.sync_preferences && t.sync_preferences.tenant_id !== t.tenant_id) {
    errors.push(`sync_preferences belong to ${t.sync_preferences.tenant_id}, not ${t.tenant_id}`);
  }
  return { ok: errors.length === 0, errors };
}
