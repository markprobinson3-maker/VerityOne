import { readTenantSettings, type SupercronActiveHours, type TenantSettingsSql } from "../../api/src/lib/tenant-settings";

export type SupercronQualityPreset = "lenient" | "balanced" | "strict";
export type SupercronIntensity = "light" | "balanced" | "thorough";

export interface SupercronQualityThresholds {
  golden_pass_rate_min: number;
  cooldown_ratio_min: number;
  low_coverage_pct: number;
}

export interface ResolvedTenantPolicy {
  tenantId: string;
  cadenceMinutes: number;
  dailyBudgetMicro: number;
  activeHours: Readonly<SupercronActiveHours>;
  withinActiveHours: boolean;
  intensity: SupercronIntensity;
  tierList: readonly number[];
  qualityPreset: SupercronQualityPreset;
  thresholds: Readonly<SupercronQualityThresholds>;
  pyramidFocus: readonly string[];
  features: Readonly<{
    goldenQueryEnabled: boolean;
    recallOutcomesEnabled: boolean;
    confidencePromotionEnabled: boolean;
  }>;
  nodeGc: Readonly<{
    candidateEnabled: boolean;
    dormantDays: number;
    perCycleCap: number;
    maxActiveCandidates: number;
    rejectionCooldownDays: number;
    applyEnabled: boolean;
    applyAction: "tombstone" | "delete";
    applyPerCycleCap: number;
  }>;
}

export const QUALITY_PRESET_THRESHOLDS: Record<SupercronQualityPreset, SupercronQualityThresholds> = {
  lenient: { golden_pass_rate_min: 0.6, cooldown_ratio_min: 0.05, low_coverage_pct: 0.75 },
  balanced: { golden_pass_rate_min: 0.8, cooldown_ratio_min: 0.2, low_coverage_pct: 0.5 },
  strict: { golden_pass_rate_min: 0.9, cooldown_ratio_min: 0.4, low_coverage_pct: 0.25 },
};

export const INTENSITY_TIERS: Record<SupercronIntensity, number[]> = {
  light: [1],
  balanced: [1, 2],
  thorough: [1, 2, 3],
};

export const MIN_SUPERCRON_CADENCE_MINUTES = 15;
export const MAX_SUPERCRON_CADENCE_MINUTES = 1440;

function clampCadenceMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 240;
  return Math.max(MIN_SUPERCRON_CADENCE_MINUTES, Math.min(MAX_SUPERCRON_CADENCE_MINUTES, parsed));
}

export function getThresholdsForQualityPreset(preset: string | null | undefined): SupercronQualityThresholds {
  const key = preset === "lenient" || preset === "strict" ? preset : "balanced";
  return { ...QUALITY_PRESET_THRESHOLDS[key] };
}

export function getTiersForIntensity(intensity: string | null | undefined): number[] {
  const key = intensity === "balanced" || intensity === "thorough" ? intensity : "light";
  return [...INTENSITY_TIERS[key]];
}

export function isWithinActiveHours(activeHours: SupercronActiveHours, now = new Date()): boolean {
  const start = Number(activeHours?.start);
  const end = Number(activeHours?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 24 || end < 0 || end > 24) return false;
  if (start === 0 && end === 24) return true;
  if (start === end || (start === 24 && end === 0)) return false;
  const hour = now.getUTCHours();
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function filterPyramidsByFocus(pyramidIds: readonly string[], focus: readonly string[] | null | undefined): string[] {
  const normalizedFocus = new Set((focus || []).map((value) => String(value).trim().toUpperCase()).filter(Boolean));
  if (normalizedFocus.size === 0) return [...pyramidIds];
  return pyramidIds.filter((pyramidId) => normalizedFocus.has(String(pyramidId).toUpperCase()));
}

export function intersectPolicyTiers(policyTiers: readonly number[], operatorTiers: readonly number[] | null | undefined): number[] {
  if (!operatorTiers || operatorTiers.length === 0) return [...policyTiers];
  const allowed = new Set(operatorTiers.map((tier) => Number(tier)).filter((tier) => Number.isInteger(tier)));
  return policyTiers.filter((tier) => allowed.has(tier));
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export async function getResolvedTenantPolicy(
  sql: TenantSettingsSql,
  tenantId: string,
  options: { now?: Date; operatorTiers?: readonly number[] } = {},
): Promise<Readonly<ResolvedTenantPolicy>> {
  const settings = await readTenantSettings(sql, tenantId);
  const intensity = settings.supercron_intensity;
  const qualityPreset = settings.supercron_quality_preset;
  const policyTiers = getTiersForIntensity(intensity);
  const resolved: ResolvedTenantPolicy = {
    tenantId,
    cadenceMinutes: clampCadenceMinutes(settings.supercron_cadence_minutes),
    dailyBudgetMicro: settings.supercron_llm_budget_usd_micro_daily,
    activeHours: Object.freeze({ ...settings.supercron_active_hours }),
    withinActiveHours: isWithinActiveHours(settings.supercron_active_hours, options.now),
    intensity,
    tierList: freezeArray(intersectPolicyTiers(policyTiers, options.operatorTiers)),
    qualityPreset,
    thresholds: Object.freeze(getThresholdsForQualityPreset(qualityPreset)),
    pyramidFocus: freezeArray(settings.supercron_pyramid_focus),
    features: Object.freeze({
      goldenQueryEnabled: settings.golden_query_enabled,
      recallOutcomesEnabled: settings.recall_outcomes_enabled,
      confidencePromotionEnabled: settings.confidence_promotion_enabled,
    }),
    nodeGc: Object.freeze({
      candidateEnabled: settings.supercron_node_gc_candidate_enabled,
      dormantDays: settings.supercron_node_gc_dormant_days,
      perCycleCap: settings.supercron_node_gc_per_cycle_cap,
      maxActiveCandidates: settings.supercron_node_gc_max_active_candidates,
      rejectionCooldownDays: settings.supercron_node_gc_rejection_cooldown_days,
      applyEnabled: settings.supercron_node_gc_apply_enabled,
      applyAction: settings.supercron_node_gc_apply_action,
      applyPerCycleCap: settings.supercron_node_gc_apply_per_cycle_cap,
    }),
  };
  return Object.freeze(resolved);
}
