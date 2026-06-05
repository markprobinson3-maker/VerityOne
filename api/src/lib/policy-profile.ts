/**
 * Policy profiles — named operating-posture presets that bundle the per-tenant
 * knobs the Tier-2 primitives already honor (Tier-2 harness-first OS, PR 10:
 * contract-first, NO new table).
 *
 * Today an operator must tune a dozen independent scalars — review-queue budget /
 * severity floor / caps, needs-attention severity floor + cap, the eval golden
 * minimum, a routine budget ceiling, the supercron quality preset. A policy
 * profile lets a tenant pick ONE posture (conservative / balanced / aggressive)
 * that resolves to all of them at once. Per the Tier-2 rule ("classify/normalize
 * OVER existing structures") this module adds NO new knobs and NO new table: each
 * resolved sub-object is `Required<Omit<Options, "generatedAt">>` of the REAL
 * primitive option type (ReviewQueueOptions, NeedsAttentionOptions,
 * RunEvalSuiteOptions) plus the routine budget ceiling — so a profile can only
 * ever set values the primitives already accept, and a caller applies it by
 * spreading: `selectReviewQueue(input, { generatedAt, ...policy.review_queue })`.
 *
 * It mirrors the existing preset→knobs precedent (miners/src/supercron-policy.ts
 * getThresholdsForQualityPreset: a frozen Record looked up by a loose string,
 * defaulting to balanced, returning a fresh copy) and bridges to the existing
 * supercron_quality_preset tenant setting. PURE and DB-free: the resolver takes a
 * preset string, never a sql handle. Persistence (a tenant_settings `policy_profile`
 * key) and wiring into the primitives' call sites are DEFERRED.
 */

import { REVIEW_SEVERITIES, type ReviewQueueOptions, type ReviewSeverity } from "./review-queue";
import type { NeedsAttentionOptions } from "./needs-attention";
import type { RunEvalSuiteOptions } from "./eval-harness";
import { MAX_ROUTINE_BUDGET_MICRO, MIN_ROUTINE_BUDGET_MICRO } from "./routine-plugin";

// ── Vocabularies ──────────────────────────────────────────────────────────────

/** The operating posture a tenant selects. */
export type PolicyProfileName = "conservative" | "balanced" | "aggressive";
export const POLICY_PROFILE_NAMES: readonly PolicyProfileName[] = ["conservative", "balanced", "aggressive"] as const;

/**
 * The supercron quality preset a profile bridges to — mirrors the (un-exported)
 * enum on tenant-settings.ts `supercron_quality_preset` / supercron-policy.ts
 * `SupercronQualityPreset`. A future wiring PR writes this onto the existing
 * tenant_settings key (no new vocabulary).
 */
export type SupercronQualityPreset = "lenient" | "balanced" | "strict";
export const SUPERCRON_QUALITY_PRESETS: readonly SupercronQualityPreset[] = ["lenient", "balanced", "strict"] as const;

// ── The resolved bundle (only knobs the primitives already accept) ─────────────

export interface ResolvedPolicy {
  profile: PolicyProfileName;
  /** Spread into selectReviewQueue's options alongside `generatedAt`. */
  review_queue: Required<Omit<ReviewQueueOptions, "generatedAt">>;
  /** Spread into aggregateAttention's options alongside `generatedAt`. */
  needs_attention: Required<Omit<NeedsAttentionOptions, "generatedAt">>;
  /** Spread into runEvalSuite's options alongside `generatedAt`. */
  eval: Required<Omit<RunEvalSuiteOptions, "generatedAt">>;
  /** The per-run routine LLM budget ceiling (RoutinePluginSpec.budget_ceiling_micro). */
  routine: { budget_ceiling_micro: number };
  /** Bridges to the existing tenant_settings supercron_quality_preset key. */
  supercron_quality_preset: SupercronQualityPreset;
}

// ── The preset table (preset → concrete knobs) ──────────────────────────────────
//
// conservative = spend little, surface only the urgent (high floor), strictest
// quality bar. balanced = the primitives' own defaults. aggressive = spend more,
// surface everything (low floor), more lenient bar. Every value below is within
// the range its primitive accepts (validateResolvedPolicy enforces this).

export const POLICY_PROFILES: Record<PolicyProfileName, ResolvedPolicy> = {
  conservative: {
    profile: "conservative",
    review_queue: { totalBudgetMicro: 25_000, maxPackets: 10, perKindCap: 4, severityFloor: "high" },
    needs_attention: { maxItems: 20, severityFloor: "high" },
    eval: { minimumPassRate: 0.9 },
    routine: { budget_ceiling_micro: 20_000 },
    supercron_quality_preset: "strict",
  },
  balanced: {
    // Matches each primitive's own defaults (review-queue 50k/20/8/low, needs-attention 50/low,
    // eval 0.8) — pinned behaviorally in the tests. routine.budget_ceiling_micro is a deliberate
    // balanced LLM allowance (the RoutinePluginSpec default is 0, which disables routine LLM use).
    profile: "balanced",
    review_queue: { totalBudgetMicro: 50_000, maxPackets: 20, perKindCap: 8, severityFloor: "low" },
    needs_attention: { maxItems: 50, severityFloor: "low" },
    eval: { minimumPassRate: 0.8 },
    routine: { budget_ceiling_micro: 50_000 },
    supercron_quality_preset: "balanced",
  },
  aggressive: {
    profile: "aggressive",
    review_queue: { totalBudgetMicro: 100_000, maxPackets: 40, perKindCap: 12, severityFloor: "low" },
    needs_attention: { maxItems: 100, severityFloor: "low" },
    eval: { minimumPassRate: 0.7 },
    routine: { budget_ceiling_micro: 100_000 },
    supercron_quality_preset: "lenient",
  },
};

// Freeze the preset table (mirrors supercron-policy's frozen knob tables). The
// resolver hands out fresh copies, so callers never need — or can mutate — these.
for (const name of POLICY_PROFILE_NAMES) {
  const p = POLICY_PROFILES[name];
  Object.freeze(p.review_queue);
  Object.freeze(p.needs_attention);
  Object.freeze(p.eval);
  Object.freeze(p.routine);
  Object.freeze(p);
}
Object.freeze(POLICY_PROFILES);

// ── Resolution ──────────────────────────────────────────────────────────────────

export function isPolicyProfileName(value: unknown): value is PolicyProfileName {
  return typeof value === "string" && (POLICY_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve a profile name to its concrete knob bundle. PURE — never touches the DB.
 * An unknown / null name safely falls back to "balanced" (mirrors
 * getThresholdsForQualityPreset). Returns a FRESH copy so a caller can never mutate
 * the shared preset table.
 */
export function resolvePolicyProfile(name: string | null | undefined): ResolvedPolicy {
  const profile: PolicyProfileName = isPolicyProfileName(name) ? name : "balanced";
  const p = POLICY_PROFILES[profile];
  return {
    profile,
    review_queue: { ...p.review_queue },
    needs_attention: { ...p.needs_attention },
    eval: { ...p.eval },
    routine: { ...p.routine },
    supercron_quality_preset: p.supercron_quality_preset,
  };
}

// ── Validation ───────────────────────────────────────────────────────────────────

export interface PolicyProfileValidation {
  ok: boolean;
  errors: string[];
}

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

/**
 * Validate that a resolved policy's knobs are all within the ranges the primitives
 * actually accept — the "no new / out-of-range knobs" guarantee. (Every entry in
 * POLICY_PROFILES must pass; a test pins this.) The `Required<Omit<>>` typing
 * already catches a primitive ADDING/REMOVING an option field; these value-range
 * checks are mirrored by hand because the primitives' bounds are mostly private
 * (only the routine budget bound is an exported const, reused directly below).
 */
export function validateResolvedPolicy(policy: ResolvedPolicy): PolicyProfileValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  inEnum(policy.profile, POLICY_PROFILE_NAMES, "profile");
  inEnum(policy.supercron_quality_preset, SUPERCRON_QUALITY_PRESETS, "supercron_quality_preset");

  // review-queue knobs
  const rq = policy.review_queue;
  if (!(Number.isInteger(rq.totalBudgetMicro) && rq.totalBudgetMicro >= 0)) errors.push("review_queue.totalBudgetMicro must be a non-negative integer");
  if (!isPositiveInt(rq.maxPackets)) errors.push("review_queue.maxPackets must be a positive integer");
  if (!isPositiveInt(rq.perKindCap)) errors.push("review_queue.perKindCap must be a positive integer");
  inEnum(rq.severityFloor as ReviewSeverity, REVIEW_SEVERITIES, "review_queue.severityFloor");

  // needs-attention knobs (AttentionSeverity is an alias of ReviewSeverity, so the
  // same REVIEW_SEVERITIES set is the correct validator).
  const na = policy.needs_attention;
  if (!isPositiveInt(na.maxItems)) errors.push("needs_attention.maxItems must be a positive integer");
  inEnum(na.severityFloor as ReviewSeverity, REVIEW_SEVERITIES, "needs_attention.severityFloor");

  // eval knob
  if (!(typeof policy.eval.minimumPassRate === "number" && policy.eval.minimumPassRate >= 0 && policy.eval.minimumPassRate <= 1)) {
    errors.push("eval.minimumPassRate must be in [0, 1]");
  }

  // routine knob (the existing RoutinePluginSpec budget bound)
  const rb = policy.routine.budget_ceiling_micro;
  if (!(Number.isInteger(rb) && rb >= MIN_ROUTINE_BUDGET_MICRO && rb <= MAX_ROUTINE_BUDGET_MICRO)) {
    errors.push(`routine.budget_ceiling_micro must be an integer in [${MIN_ROUTINE_BUDGET_MICRO}, ${MAX_ROUTINE_BUDGET_MICRO}]`);
  }

  return { ok: errors.length === 0, errors };
}
