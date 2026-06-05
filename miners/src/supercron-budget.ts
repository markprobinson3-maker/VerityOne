import { readTenantSetting } from "../../api/src/lib/tenant-settings";

type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

export const DEFAULT_SUPERCRON_CADENCE_MINUTES = 240;
export const MIN_SUPERCRON_CADENCE_MINUTES = 15;
export const MAX_SUPERCRON_CADENCE_MINUTES = 1440;
export const DEFAULT_COOLDOWN_WINDOW_CYCLES = 3;
export const DEFAULT_GOLDEN_PASS_RATE_MINIMUM = 0.8;
export const DEFAULT_COOLDOWN_RATIO_MINIMUM = 0.2;

export interface DailyLlmBudgetUsage {
  since: Date;
  llm_cost_usd_micro: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
}

/**
 * Pass cooldown state computed over the most recent `windowCycles` telemetry rows.
 *
 * Cooldown trigger semantics: a cycle counts toward `noUsefulWorkCycles` when
 * `proposals_created > 0 AND proposals_applied / proposals_created < 0.2`. Cycles
 * with `proposals_created = 0` are treated as IDLE, not USELESS, and do not
 * accumulate cooldown pressure.
 *
 * `usefulProposalRatio` is the AGGREGATE ratio across the window (sum applied /
 * sum created), provided as a smoothed informational signal. The cooldown
 * decision uses `cooldownTriggered`, not the aggregate ratio.
 */
export interface PassCooldownState {
  passName: string;
  windowCycles: number;
  observedCycles: number;
  proposalsCreated: number;
  proposalsApplied: number;
  usefulProposalRatio: number | null;
  noUsefulWorkCycles: number;
  cooldownTriggered: boolean;
}

export async function shouldRunPass(sql: SqlLike, passName: string, cooldownRatioMin = DEFAULT_COOLDOWN_RATIO_MINIMUM): Promise<boolean> {
  const state = await getPassCooldownState(sql, passName, DEFAULT_COOLDOWN_WINDOW_CYCLES, cooldownRatioMin);
  return !state.cooldownTriggered;
}

function goldenPassRateDeclining(ratesNewestFirst: number[], goldenPassRateMinimum = DEFAULT_GOLDEN_PASS_RATE_MINIMUM): boolean {
  return ratesNewestFirst.length >= 3
    && ratesNewestFirst[0] < goldenPassRateMinimum
    && ratesNewestFirst[0] <= ratesNewestFirst[1]
    && ratesNewestFirst[1] <= ratesNewestFirst[2];
}

export async function shouldRunTier3(sql: SqlLike, goldenPassRateMinimum = DEFAULT_GOLDEN_PASS_RATE_MINIMUM): Promise<boolean> {
  const latestRuns = await sql`
    SELECT
      status,
      COALESCE(degraded_reason, quality_report->>'degraded_reason', '') AS degraded_reason,
      CASE
        WHEN jsonb_typeof(quality_report->'golden_pass_rate') = 'number'
          THEN (quality_report->>'golden_pass_rate')::double precision
        ELSE NULL
      END AS golden_pass_rate
    FROM supercron_runs
    ORDER BY id DESC
    LIMIT 3
  `;
  const rates = latestRuns
    .map((row) => row.golden_pass_rate == null ? null : Number(row.golden_pass_rate))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  // Declining golden-query quality is a signal to run Tier 3, because Tier 3
  // produces the fresh evaluation data needed to verify recovery.
  if (goldenPassRateDeclining(rates, goldenPassRateMinimum)) return true;

  const latest = latestRuns[0];
  const degradedReason = String(latest?.degraded_reason || "");
  if (latest?.status === "degraded" && degradedReason.startsWith("absolute_invariant_breach:")) {
    return false;
  }
  return true;
}

function clampCadenceMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    console.warn(`[supercron-budget] cadence value ${JSON.stringify(value)} not an integer; defaulting to ${DEFAULT_SUPERCRON_CADENCE_MINUTES}`);
    return DEFAULT_SUPERCRON_CADENCE_MINUTES;
  }
  if (parsed < MIN_SUPERCRON_CADENCE_MINUTES || parsed > MAX_SUPERCRON_CADENCE_MINUTES) {
    console.warn(`[supercron-budget] cadence value ${parsed} out of range [${MIN_SUPERCRON_CADENCE_MINUTES}, ${MAX_SUPERCRON_CADENCE_MINUTES}]; defaulting to ${DEFAULT_SUPERCRON_CADENCE_MINUTES}`);
    return DEFAULT_SUPERCRON_CADENCE_MINUTES;
  }
  return parsed;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function readTenantCadence(sql: SqlLike, tenantId: string | null | undefined): Promise<number> {
  if (!tenantId) {
    const rows = await sql`
      SELECT value
      FROM tenant_settings
      WHERE key = 'supercron_cadence_minutes'
        AND value ~ '^[0-9]{1,4}$'
      ORDER BY value::int ASC
    `;
    if (rows.length === 0) return DEFAULT_SUPERCRON_CADENCE_MINUTES;
    return clampCadenceMinutes(rows[0].value);
  }
  const configured = await readTenantSetting(sql, tenantId, "supercron_cadence_minutes");
  if (configured == null) return DEFAULT_SUPERCRON_CADENCE_MINUTES;
  return clampCadenceMinutes(configured);
}

export async function getDailyLlmBudgetUsed(sql: SqlLike, since = utcMidnightToday()): Promise<DailyLlmBudgetUsage> {
  const [row] = await sql`
    SELECT
      COALESCE(sum(llm_cost_usd_micro), 0)::bigint AS llm_cost_usd_micro,
      COALESCE(sum(llm_tokens_in), 0)::bigint AS llm_tokens_in,
      COALESCE(sum(llm_tokens_out), 0)::bigint AS llm_tokens_out
    FROM supercron_pass_telemetry
    WHERE created_at >= ${since}
  `;
  return {
    since,
    llm_cost_usd_micro: nonNegativeInteger(row?.llm_cost_usd_micro),
    llm_tokens_in: nonNegativeInteger(row?.llm_tokens_in),
    llm_tokens_out: nonNegativeInteger(row?.llm_tokens_out),
  };
}

export async function getPassCooldownState(
  sql: SqlLike,
  passName: string,
  windowCycles = DEFAULT_COOLDOWN_WINDOW_CYCLES,
  cooldownRatioMin = DEFAULT_COOLDOWN_RATIO_MINIMUM,
): Promise<PassCooldownState> {
  const effectiveWindowCycles = Number.isInteger(windowCycles) && windowCycles > 0
    ? windowCycles
    : DEFAULT_COOLDOWN_WINDOW_CYCLES;
  const rows = await sql`
    SELECT proposals_created, proposals_applied
    FROM supercron_pass_telemetry
    WHERE pass_name = ${passName}
    ORDER BY created_at DESC, id DESC
    LIMIT ${effectiveWindowCycles}
  `;
  let proposalsCreated = 0;
  let proposalsApplied = 0;
  let noUsefulWorkCycles = 0;
  for (const row of rows) {
    const created = nonNegativeInteger(row.proposals_created);
    const applied = nonNegativeInteger(row.proposals_applied);
    proposalsCreated += created;
    proposalsApplied += applied;
    if (created > 0 && applied / created < cooldownRatioMin) noUsefulWorkCycles++;
  }
  return {
    passName,
    windowCycles: effectiveWindowCycles,
    observedCycles: rows.length,
    proposalsCreated,
    proposalsApplied,
    usefulProposalRatio: proposalsCreated > 0 ? proposalsApplied / proposalsCreated : null,
    noUsefulWorkCycles,
    cooldownTriggered: rows.length >= effectiveWindowCycles && noUsefulWorkCycles >= effectiveWindowCycles,
  };
}
