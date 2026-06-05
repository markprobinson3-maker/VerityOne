import {
  DEFAULT_COOLDOWN_WINDOW_CYCLES,
  getPassCooldownState,
  shouldRunTier3,
  type PassCooldownState,
} from "../../../miners/src/supercron-budget";

type SqlTag = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

const DEFAULT_EDGE_USEFULNESS_FLAG_CEILING = 0.2;
const DEFAULT_EDGE_USEFULNESS_PROTECTION_FLOOR = 0.7;
const SUPERCRON_STATUS_CACHE_TTL_MS = 5_000;

type SafeToRunLevel = "unknown" | "safe" | "caution" | "blocked";

const HIGH_RISK_PROPOSAL_ACTIONS = new Set([
  "tenant_memory_supersession",
  "memory_merge",
  "edge_usefulness_cleanup",
  "registry_reconciliation",
]);

const ROLLBACK_EVENT_TYPES = [
  "supercron_rollback",
  "tenant_supersession_rollback",
  "memory_merge_rollback",
  "registry_reconciliation_rollback",
];

let cachedStatus: { snapshot: SupercronStatusSnapshot; expiresAt: number } | null = null;

function intValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function configuredValue(value: unknown): string | null {
  return value == null ? null : String(value);
}

function parseThreshold(value: unknown, fallback: number): { value: number; configured: string | null; valid: boolean } {
  const configured = configuredValue(value);
  if (value == null) return { value: fallback, configured, valid: true };
  if (typeof value === "boolean") return { value: fallback, configured, valid: false };
  if (typeof value === "string" && value.trim() === "") return { value: fallback, configured, valid: false };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { value: fallback, configured, valid: false };
  return { value: Math.max(0, Math.min(1, parsed)), configured, valid: parsed >= 0 && parsed <= 1 };
}

function qualityGrade(row: any | null): "unknown" | "green" | "yellow" | "amber" | "red" {
  if (!row) return "unknown";
  const status = cleanString(row.status);
  if (status === "error" || status === "timeout" || status === "failed") return "red";
  if (status === "degraded") return "amber";
  if (intValue(row.warning_count) > 0) return "yellow";
  return "green";
}

function summarizeSafeToRun(input: {
  latestRun: any | null;
  failedRuns24h: number;
  controllerErrors24h: number;
  cooldownStates: PassCooldownState[];
  passTelemetryAvailable: boolean;
}): { safe: boolean; level: SafeToRunLevel; reasons: string[] } {
  const reasons: string[] = [];
  const latestReason = cleanString(input.latestRun?.degraded_reason);
  if (input.failedRuns24h > 0) reasons.push(`${input.failedRuns24h} failed SuperCron cycle(s) in 24h`);
  if (latestReason.startsWith("absolute_invariant_breach:")) {
    reasons.push("latest degraded cycle has an absolute invariant breach");
  }
  if (input.controllerErrors24h > 0) reasons.push(`${input.controllerErrors24h} controller error telemetry row(s) in 24h`);
  const cooled = input.cooldownStates.filter((state) => state.cooldownTriggered);
  if (cooled.length > 0) {
    reasons.push(`pass cooldown(s) active: ${cooled.map((state) => state.passName).join(", ")}`);
  }

  if (input.latestRun === null && input.failedRuns24h === 0 && input.cooldownStates.length === 0) {
    return { safe: false, level: "unknown", reasons: ["No SuperCron run history; first cycle has not completed."] };
  }
  if (input.failedRuns24h > 0 || latestReason.startsWith("absolute_invariant_breach:")) {
    return { safe: false, level: "blocked", reasons };
  }
  if (!input.passTelemetryAvailable) {
    return { safe: false, level: "unknown", reasons: ["Pass telemetry unavailable; mutation safety cannot be verified."] };
  }
  if (reasons.length > 0) return { safe: true, level: "caution", reasons };
  return { safe: true, level: "safe", reasons: [] };
}

export interface SupercronStatusSnapshot {
  ok: boolean;
  generated_at: string;
  installed: {
    supercron_runs: boolean;
    supercron_pass_telemetry: boolean;
    edge_usefulness_scores: boolean;
    golden_query_runs: boolean;
    recall_outcome_events: boolean;
    proposals: boolean;
    memory_events: boolean;
  };
  quality: {
    grade: "unknown" | "green" | "yellow" | "amber" | "red";
    last_status: string | null;
    last_degraded_reason: string | null;
    last_warning_count: number;
    last_golden_pass_rate: number | null;
    last_started_at: string | null;
    last_finished_at: string | null;
  };
  degraded_reasons_24h: Array<{ reason: string; count: number; latest_started_at: string | null }>;
  rollback_count_24h: number;
  proposal_queue_depth: Array<{
    action: string;
    status: string;
    count: number;
    high_risk: boolean;
    last_created_at: string | null;
  }>;
  recall_relevance_trend: Array<{
    run_id: string | null;
    started_at: string | null;
    status: string | null;
    golden_pass_rate: number | null;
  }>;
  runtime_trend: Array<{
    run_id: string | null;
    started_at: string | null;
    status: string | null;
    total_ms: number;
    pass_ms: number;
    llm_cost_usd_micro: number;
    llm_tokens_in: number;
    llm_tokens_out: number;
  }>;
  cooldown_states: PassCooldownState[];
  tier3_controller: {
    allowed: boolean | null;
    error: string | null;
    skips_last_12_cycles: number;
  };
  edge_usefulness_distribution: {
    flag_ceiling: number;
    flag_ceiling_configured: string | null;
    protection_floor: number;
    protection_floor_configured: string | null;
    low: number | null;
    mid: number | null;
    high: number | null;
    total: number;
    last_computed_at: string | null;
    threshold_values_valid: boolean;
    thresholds_inverted: boolean;
  };
  safe_to_run_mutating_tier: {
    safe: boolean;
    level: SafeToRunLevel;
    reasons: string[];
  };
  diagnostic_hints: string[];
  recent_runs: Array<{
    id: number;
    run_id: string | null;
    started_at: string | null;
    finished_at: string | null;
    status: string | null;
    degraded_reason: string | null;
    total_actions: number;
    warning_count: number;
    golden_pass_rate: number | null;
  }>;
}

export function unavailableSupercronStatusSnapshot(error: unknown): SupercronStatusSnapshot {
  const message = String((error as any)?.message || error).slice(0, 240);
  return {
    ok: false,
    generated_at: new Date().toISOString(),
    installed: {
      supercron_runs: false,
      supercron_pass_telemetry: false,
      edge_usefulness_scores: false,
      golden_query_runs: false,
      recall_outcome_events: false,
      proposals: false,
      memory_events: false,
    },
    quality: {
      grade: "unknown",
      last_status: null,
      last_degraded_reason: null,
      last_warning_count: 0,
      last_golden_pass_rate: null,
      last_started_at: null,
      last_finished_at: null,
    },
    degraded_reasons_24h: [],
    rollback_count_24h: 0,
    proposal_queue_depth: [],
    recall_relevance_trend: [],
    runtime_trend: [],
    cooldown_states: [],
    tier3_controller: { allowed: null, error: message, skips_last_12_cycles: 0 },
    edge_usefulness_distribution: {
      flag_ceiling: DEFAULT_EDGE_USEFULNESS_FLAG_CEILING,
      flag_ceiling_configured: null,
      protection_floor: DEFAULT_EDGE_USEFULNESS_PROTECTION_FLOOR,
      protection_floor_configured: null,
      low: 0,
      mid: 0,
      high: 0,
      total: 0,
      last_computed_at: null,
      threshold_values_valid: false,
      thresholds_inverted: false,
    },
    safe_to_run_mutating_tier: {
      safe: false,
      level: "unknown",
      reasons: ["SuperCron status unavailable"],
    },
    diagnostic_hints: [`SuperCron status unavailable: ${message}`],
    recent_runs: [],
  };
}

export async function readSupercronStatus(sql: SqlTag): Promise<SupercronStatusSnapshot> {
  const now = Date.now();
  if (cachedStatus && cachedStatus.expiresAt > now) return cachedStatus.snapshot;
  const snapshot = await readSupercronStatusFresh(sql);
  cachedStatus = { snapshot, expiresAt: now + SUPERCRON_STATUS_CACHE_TTL_MS };
  return snapshot;
}

async function readSupercronStatusFresh(sql: SqlTag): Promise<SupercronStatusSnapshot> {
  const [installedRow] = await sql`
    SELECT
      to_regclass('supercron_runs') IS NOT NULL AS supercron_runs,
      to_regclass('supercron_pass_telemetry') IS NOT NULL AS supercron_pass_telemetry,
      to_regclass('edge_usefulness_scores') IS NOT NULL AS edge_usefulness_scores,
      to_regclass('golden_query_runs') IS NOT NULL AS golden_query_runs,
      to_regclass('recall_outcome_events') IS NOT NULL AS recall_outcome_events,
      to_regclass('proposals') IS NOT NULL AS proposals,
      to_regclass('memory_events') IS NOT NULL AS memory_events
  `;
  const installed = {
    supercron_runs: Boolean(installedRow?.supercron_runs),
    supercron_pass_telemetry: Boolean(installedRow?.supercron_pass_telemetry),
    edge_usefulness_scores: Boolean(installedRow?.edge_usefulness_scores),
    golden_query_runs: Boolean(installedRow?.golden_query_runs),
    recall_outcome_events: Boolean(installedRow?.recall_outcome_events),
    proposals: Boolean(installedRow?.proposals),
    memory_events: Boolean(installedRow?.memory_events),
  };

  const hints: string[] = [];
  let latestRun: any | null = null;
  let recentRuns: any[] = [];
  let degradedReasons24h: any[] = [];
  let failedRuns24h = 0;
  let rollbackCount24h = 0;
  let proposalQueueDepth: any[] = [];
  let runtimeTrend: any[] = [];
  let cooldownStates: PassCooldownState[] = [];
  let controllerErrors24h = 0;
  let tier3Controller = {
    allowed: null as boolean | null,
    error: null as string | null,
    skips_last_12_cycles: 0,
  };
  let edgeUsefulnessDistribution: SupercronStatusSnapshot["edge_usefulness_distribution"] = {
    flag_ceiling: DEFAULT_EDGE_USEFULNESS_FLAG_CEILING,
    flag_ceiling_configured: null as string | null,
    protection_floor: DEFAULT_EDGE_USEFULNESS_PROTECTION_FLOOR,
    protection_floor_configured: null as string | null,
    low: 0,
    mid: 0,
    high: 0,
    total: 0,
    last_computed_at: null as string | null,
    threshold_values_valid: true,
    thresholds_inverted: false,
  };

  if (!installed.supercron_runs) {
    hints.push("SuperCron run history is empty. Apply migrations and complete one cycle before using this dashboard.");
  } else {
    recentRuns = await sql`
      SELECT
        id,
        run_id,
        started_at,
        finished_at,
        status,
        COALESCE(degraded_reason, quality_report->>'degraded_reason') AS degraded_reason,
        total_actions,
        COALESCE(
          CASE WHEN jsonb_typeof(quality_report->'warnings') = 'array'
            THEN jsonb_array_length(quality_report->'warnings')
            ELSE 0
          END,
          0
        )::int AS warning_count,
        CASE
          WHEN jsonb_typeof(quality_report->'golden_pass_rate') = 'number'
            THEN (quality_report->>'golden_pass_rate')::double precision
          ELSE NULL
        END AS golden_pass_rate
      FROM supercron_runs
      ORDER BY id DESC
      LIMIT 12
    `;
    latestRun = recentRuns[0] || null;
    degradedReasons24h = await sql`
      SELECT
        COALESCE(NULLIF(degraded_reason, ''), NULLIF(quality_report->>'degraded_reason', ''), 'degraded_without_reason') AS reason,
        COUNT(*)::int AS count,
        MAX(started_at) AS latest_started_at
      FROM supercron_runs
      WHERE started_at > now() - interval '24 hours'
        AND (status = 'degraded' OR COALESCE(degraded_reason, quality_report->>'degraded_reason', '') <> '')
      GROUP BY reason
      ORDER BY count DESC, latest_started_at DESC
      LIMIT 12
    `;
    if (degradedReasons24h.some((row: any) => cleanString(row.reason) === "degraded_without_reason")) {
      hints.push("A degraded cycle was recorded without a reason; inspect SuperCron quality reporting.");
    }
    const [failedRow] = await sql`
      SELECT COUNT(*)::int AS count
      FROM supercron_runs
      WHERE started_at > now() - interval '24 hours'
        AND status IN ('error', 'timeout', 'failed')
    `;
    failedRuns24h = intValue(failedRow?.count);
  }

  if (installed.memory_events) {
    try {
      const [rollbackRow] = await sql`
        SELECT COUNT(*)::int AS count
        FROM memory_events
        WHERE created_at > now() - interval '24 hours'
          AND event_type = ANY(${ROLLBACK_EVENT_TYPES}::text[])
      `;
      rollbackCount24h = intValue(rollbackRow?.count);
    } catch (error: any) {
      hints.push(`Rollback history could not be read: ${String(error?.message || error).slice(0, 240)}`);
    }
  } else {
    hints.push("Rollback history is unavailable because memory_events is not installed.");
  }

  if (installed.proposals) {
    proposalQueueDepth = await sql`
      SELECT
        COALESCE(NULLIF(payload->>'action', ''), proposal_type, 'unknown') AS action,
        status,
        COUNT(*)::int AS count,
        MAX(created_at) AS last_created_at
      FROM proposals
      WHERE status IN ('pending', 'approved')
      GROUP BY action, status
      ORDER BY count DESC, action ASC, status ASC
      LIMIT 24
    `;
  } else {
    hints.push("Proposal queue depth is unavailable because proposals is not installed.");
  }

  if (installed.supercron_runs && installed.supercron_pass_telemetry) {
    runtimeTrend = await sql`
      SELECT
        r.run_id,
        r.started_at,
        r.status,
        COALESCE(r.tier1_ms, 0) + COALESCE(r.tier2_ms, 0) + COALESCE(r.tier3_ms, 0) + COALESCE(r.tier4_ms, 0) AS total_ms,
        COALESCE(SUM(t.ms), 0)::int AS pass_ms,
        COALESCE(SUM(t.llm_cost_usd_micro), 0)::bigint AS llm_cost_usd_micro,
        COALESCE(SUM(t.llm_tokens_in), 0)::bigint AS llm_tokens_in,
        COALESCE(SUM(t.llm_tokens_out), 0)::bigint AS llm_tokens_out
      FROM supercron_runs r
      LEFT JOIN supercron_pass_telemetry t ON t.supercron_run_id = r.id
      GROUP BY r.id
      ORDER BY r.id DESC
      LIMIT 12
    `;

    const passRows = await sql`
      SELECT pass_name, MAX(created_at) AS last_seen_at
      FROM supercron_pass_telemetry
      WHERE created_at > now() - interval '7 days'
      GROUP BY pass_name
      ORDER BY last_seen_at DESC, pass_name ASC
      LIMIT 24
    `;
    cooldownStates = await Promise.all(
      passRows
        .map((row: any) => cleanString(row.pass_name))
        .filter(Boolean)
        .map((passName: string) => getPassCooldownState(sql, passName, DEFAULT_COOLDOWN_WINDOW_CYCLES)),
    );
    const [controllerErrorRow] = await sql`
      SELECT COUNT(*)::int AS count
      FROM supercron_pass_telemetry
      WHERE pass_name = 'controller_error'
        AND created_at > now() - interval '24 hours'
    `;
    controllerErrors24h = intValue(controllerErrorRow?.count);
  } else if (!installed.supercron_pass_telemetry) {
    hints.push("Pass telemetry unavailable; mutation safety cannot be verified.");
  }

  if (installed.supercron_runs) {
    const tier3SkipsLast12Cycles = recentRuns.filter((row: any) => numberOrNull(row.golden_pass_rate) == null).length;
    try {
      tier3Controller = {
        allowed: await shouldRunTier3(sql),
        error: null,
        skips_last_12_cycles: tier3SkipsLast12Cycles,
      };
    } catch (error: any) {
      tier3Controller = {
        allowed: null,
        error: String(error?.message || error).slice(0, 500),
        skips_last_12_cycles: tier3SkipsLast12Cycles,
      };
      hints.push("Tier 3 controller status could not be read; controller decisions fail open during cycles.");
    }
  }

  if (installed.edge_usefulness_scores) {
    const settings = await sql`
      SELECT key, value
      FROM graph_state
      WHERE key IN ('edge_usefulness.flag_ceiling', 'edge_usefulness.protection_floor')
    `;
    const valueByKey = new Map(settings.map((row: any) => [row.key, row.value]));
    const flag = parseThreshold(valueByKey.get("edge_usefulness.flag_ceiling"), DEFAULT_EDGE_USEFULNESS_FLAG_CEILING);
    const protection = parseThreshold(valueByKey.get("edge_usefulness.protection_floor"), DEFAULT_EDGE_USEFULNESS_PROTECTION_FLOOR);
    const flagCeiling = Math.min(flag.value, protection.value);
    const protectionFloor = protection.value;
    const thresholdsInverted = flag.value > protection.value;
    const [distribution] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE score < ${flagCeiling}::numeric)::int AS low,
        COUNT(*) FILTER (WHERE score >= ${flagCeiling}::numeric AND score < ${protectionFloor}::numeric)::int AS mid,
        COUNT(*) FILTER (WHERE score >= ${protectionFloor}::numeric)::int AS high,
        COUNT(*)::int AS total,
        MAX(last_computed_at) AS last_computed_at
      FROM edge_usefulness_scores
    `;
    edgeUsefulnessDistribution = {
      flag_ceiling: flagCeiling,
      flag_ceiling_configured: flag.configured,
      protection_floor: protectionFloor,
      protection_floor_configured: protection.configured,
      low: thresholdsInverted ? null : intValue(distribution?.low),
      mid: thresholdsInverted ? null : intValue(distribution?.mid),
      high: thresholdsInverted ? null : intValue(distribution?.high),
      total: intValue(distribution?.total),
      last_computed_at: distribution?.last_computed_at || null,
      threshold_values_valid: flag.valid && protection.valid && !thresholdsInverted,
      thresholds_inverted: thresholdsInverted,
    };
    if (!edgeUsefulnessDistribution.threshold_values_valid) {
      hints.push("Edge usefulness thresholds are invalid or inverted; defaults/clamps are being shown.");
    }
    if (
      edgeUsefulnessDistribution.total > 0
      && edgeUsefulnessDistribution.low === 0
      && edgeUsefulnessDistribution.high === 0
    ) {
      hints.push("All edges are in the mid bucket; tune flag_ceiling/protection_floor only after reviewing the distribution.");
    }
  } else {
    hints.push("Edge usefulness scoring has not yet populated. Run a Tier 2 cycle to generate scores.");
  }

  if (latestRun && numberOrNull(latestRun.golden_pass_rate) == null) {
    hints.push("Latest cycle has no golden_pass_rate; Tier 3 may have been skipped or golden probes did not run.");
  }
  const recentAppliedProposalRows = proposalQueueDepth.filter((row: any) => cleanString(row.status) === "approved");
  if (installed.proposals && recentAppliedProposalRows.length === 0) {
    hints.push("No approved proposal queue depth is visible; if pending proposals grow, check qc-sentinel review/apply status.");
  }

  const safeToRun = summarizeSafeToRun({
    latestRun,
    failedRuns24h,
    controllerErrors24h,
    cooldownStates,
    passTelemetryAvailable: installed.supercron_pass_telemetry,
  });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    installed,
    quality: {
      grade: qualityGrade(latestRun),
      last_status: latestRun?.status || null,
      last_degraded_reason: latestRun?.degraded_reason || null,
      last_warning_count: intValue(latestRun?.warning_count),
      last_golden_pass_rate: numberOrNull(latestRun?.golden_pass_rate),
      last_started_at: latestRun?.started_at || null,
      last_finished_at: latestRun?.finished_at || null,
    },
    degraded_reasons_24h: degradedReasons24h.map((row: any) => ({
      reason: cleanString(row.reason) || "unknown",
      count: intValue(row.count),
      latest_started_at: row.latest_started_at || null,
    })),
    rollback_count_24h: rollbackCount24h,
    proposal_queue_depth: proposalQueueDepth.map((row: any) => {
      const action = cleanString(row.action) || "unknown";
      return {
        action,
        status: cleanString(row.status) || "unknown",
        count: intValue(row.count),
        high_risk: HIGH_RISK_PROPOSAL_ACTIONS.has(action),
        last_created_at: row.last_created_at || null,
      };
    }),
    recall_relevance_trend: recentRuns.map((row: any) => ({
      run_id: row.run_id || null,
      started_at: row.started_at || null,
      status: row.status || null,
      golden_pass_rate: numberOrNull(row.golden_pass_rate),
    })),
    runtime_trend: runtimeTrend.map((row: any) => ({
      run_id: row.run_id || null,
      started_at: row.started_at || null,
      status: row.status || null,
      total_ms: intValue(row.total_ms),
      pass_ms: intValue(row.pass_ms),
      llm_cost_usd_micro: intValue(row.llm_cost_usd_micro),
      llm_tokens_in: intValue(row.llm_tokens_in),
      llm_tokens_out: intValue(row.llm_tokens_out),
    })),
    cooldown_states: cooldownStates,
    tier3_controller: tier3Controller,
    edge_usefulness_distribution: edgeUsefulnessDistribution,
    safe_to_run_mutating_tier: safeToRun,
    diagnostic_hints: hints,
    recent_runs: recentRuns.map((row: any) => ({
      id: intValue(row.id),
      run_id: row.run_id || null,
      started_at: row.started_at || null,
      finished_at: row.finished_at || null,
      status: row.status || null,
      degraded_reason: row.degraded_reason || null,
      total_actions: intValue(row.total_actions),
      warning_count: intValue(row.warning_count),
      golden_pass_rate: numberOrNull(row.golden_pass_rate),
    })),
  };
}
