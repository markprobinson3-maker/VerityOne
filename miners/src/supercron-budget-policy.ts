import { EmbedDimensionMismatchError } from "@verity-one/embed";
import { readTenantSetting, TenantNotFoundError } from "../../api/src/lib/tenant-settings";

export type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

export const DEFAULT_DAILY_LLM_BUDGET_MICRO = 170_000;
export const MIN_DAILY_LLM_BUDGET_MICRO = 100_000;
export const MAX_DAILY_LLM_BUDGET_MICRO = 2_000_000;
export const CARRYOVER_MAX_DAYS = 7;
export const MANUAL_RUN_DAILY_CAP_MICRO = 20_000_000;
export const MANUAL_RUN_REQUEST_CAP_MICRO = 10_000_000;
export const LLM_ESTIMATE_FLASH_MICRO = 200;
export const LLM_ESTIMATE_FLASH_LITE_MICRO = 50;
// Flat pre-call reserve for embedding callers that do not have text-specific
// input available yet. Prefer estimateEmbeddingCostMicro(text) when text exists.
export const LLM_ESTIMATE_EMBEDDING_MICRO = 200;
export const LLM_ESTIMATE_DISTILLER_FUSION_PASS_MICRO = 500_000;
export const LLM_ESTIMATE_GOLDEN_CASE_MICRO = 200;
export const LLM_MODEL_COST_MICRO_PER_TOKEN = {
  embedding: { input: 0.15, output: 0 },
  flash_lite: { input: 0.0375, output: 0.15 },
  flash: { input: 0.075, output: 0.30 },
  pro: { input: 1.25, output: 10.00 },
} as const;
export const EMBEDDING_CHARS_PER_TOKEN = 3;
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MANUAL_RUN_STATUS_VALUES = ["pending", "running", "completed", "failed", "rejected"] as const;
type ManualRunStatus = (typeof MANUAL_RUN_STATUS_VALUES)[number];

export interface TenantBudgetState {
  tenantId: string;
  dailyCapMicro: number;
  carryoverBalanceMicro: number;
  spendTodayMicro: number;
  manualSpendTodayMicro: number;
  lastRolloverAt: Date;
  updatedAt: Date;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason: "ok" | "budget_would_exceed" | "manual_budget_would_exceed" | "invalid_estimate" | "ignore_budget" | "invalid_budget_options";
  estimatedMicro: number;
  effectiveCapMicro: number;
  spendTodayMicro: number;
  remainingMicro: number;
}

export interface BudgetCheckOptions {
  manualRunBudgetMicro?: number | null;
  manualRunSpentMicro?: number | null;
  manualRunId?: number | null;
  ignoreBudget?: boolean;
  now?: Date;
}

export interface RecordSpendOptions {
  isManualRun?: boolean;
  manualRunId?: number | null;
}

export interface ManualRunRecord {
  id: number;
  tenantId: string;
  requestedAt: Date;
  requestedBy: string;
  budgetMicro: number;
  status: ManualRunStatus;
  rejectionReason: string | null;
}

export interface ManualRunSpendResult {
  manualRunId: number;
  tenantId: string;
  actualSpendMicro: number;
  manualSpendTodayMicro: number;
}

export class BudgetSpendRejectedError extends Error {
  constructor(
    public readonly reason: "budget_would_exceed" | "manual_budget_would_exceed" | "invalid_estimate",
    message: string = reason,
  ) {
    super(message);
    this.name = "BudgetSpendRejectedError";
  }
}

export class ManualRunAlreadyOpenError extends Error {
  constructor(public readonly tenantId: string) {
    super(`manual_run_already_open:${tenantId}`);
    this.name = "ManualRunAlreadyOpenError";
  }
}

function integerOrDefault(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === "boolean") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function positiveIntegerOrThrow(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function estimateEmbeddingCostMicro(text: string): number {
  // Embedding helpers currently expose no usageMetadata, so budget checks use
  // a conservative character proxy until the embed package returns token usage.
  const tokenEstimate = Math.max(1, Math.ceil(String(text || "").length / EMBEDDING_CHARS_PER_TOKEN));
  const microPerToken = LLM_MODEL_COST_MICRO_PER_TOKEN.embedding.input;
  return Math.max(1, Math.ceil(tokenEstimate * microPerToken));
}

export async function recordEmbeddingSpendIfBilled(args: {
  cacheHit: boolean;
  estimateMicro: number;
  recordSpend: (actualMicro: number) => Promise<void>;
}): Promise<number> {
  if (args.cacheHit) return 0;
  await args.recordSpend(args.estimateMicro);
  return args.estimateMicro;
}

export function shouldRecordEmbeddingFailureSpend(error: unknown): boolean {
  // Provider failure billing is ambiguous after retries. Exclude only local
  // failures known not to reach Gemini, and conservatively record the rest.
  // Non-Error throw values fall through to the conservative record path.
  const candidate = error as { name?: unknown; code?: unknown };
  const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);
  const preRequestTlsCodes = new Set([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  return !(error instanceof EmbedDimensionMismatchError
    || error instanceof TypeError
    || candidate?.name === "AbortError"
    || networkCodes.has(code)
    || preRequestTlsCodes.has(code)
    || code.startsWith("ERR_TLS_"));
}

function assertTenantId(tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId)) throw new Error(`invalid tenant_id: must match ${TENANT_ID_RE.source}`);
  return tenantId;
}

function parseManualRunStatus(value: unknown): ManualRunStatus {
  if ((MANUAL_RUN_STATUS_VALUES as readonly unknown[]).includes(value)) return value as ManualRunStatus;
  throw new Error(`unexpected manual run status: ${String(value)}`);
}

function isManualRunAlreadyOpenError(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate?.code !== "23505") return false;
  const constraint = String(candidate.constraint || "");
  return !constraint || constraint.includes("idx_supercron_manual_runs_one_open_per_tenant");
}

async function assertTenantGraphSpace(sql: SqlLike, tenantId: string): Promise<void> {
  const validTenantId = assertTenantId(tenantId);
  const [spaceRow] = await sql`
    SELECT 1
    FROM graph_spaces
    WHERE space_id = ${`tenant:${validTenantId}`}
      AND tenant_id = ${validTenantId}
      AND kind = 'tenant'
    LIMIT 1
  `;
  if (!spaceRow) throw new TenantNotFoundError(validTenantId);
}

function clampDailyCapMicro(value: unknown): number {
  const parsed = integerOrDefault(value, DEFAULT_DAILY_LLM_BUDGET_MICRO);
  return Math.max(MIN_DAILY_LLM_BUDGET_MICRO, Math.min(MAX_DAILY_LLM_BUDGET_MICRO, parsed));
}

function utcMidnightFor(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function asDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

export function computeRolloverState(input: {
  dailyCapMicro: number;
  carryoverBalanceMicro: number;
  spendTodayMicro: number;
  daysElapsed?: number;
}): { carryoverBalanceMicro: number; spendTodayMicro: number } {
  const dailyCapMicro = clampDailyCapMicro(input.dailyCapMicro);
  const daysElapsed = Math.max(1, nonNegativeInteger(input.daysElapsed ?? 1));
  const nextCarryoverBalanceMicro = Math.max(
    0,
    nonNegativeInteger(input.carryoverBalanceMicro) + (dailyCapMicro * daysElapsed) - nonNegativeInteger(input.spendTodayMicro),
  );
  return {
    carryoverBalanceMicro: Math.min(
      dailyCapMicro * CARRYOVER_MAX_DAYS,
      nextCarryoverBalanceMicro,
    ),
    spendTodayMicro: 0,
  };
}

export function getEffectiveBudgetCap(state: Pick<TenantBudgetState, "dailyCapMicro" | "carryoverBalanceMicro">): number {
  return nonNegativeInteger(state.dailyCapMicro) + nonNegativeInteger(state.carryoverBalanceMicro);
}

export function normalizeManualRunBudgetMicro(value: unknown): number {
  const parsed = integerOrDefault(value, 0);
  return Math.max(0, Math.min(MANUAL_RUN_REQUEST_CAP_MICRO, parsed));
}

export function evaluateBudgetCheck(
  state: TenantBudgetState,
  estimatedMicro: number,
  options: Omit<BudgetCheckOptions, "now"> = {},
): BudgetCheckResult {
  const estimate = integerOrDefault(estimatedMicro, -1);
  if (estimate < 0) {
    return {
      allowed: false,
      reason: "invalid_estimate",
      estimatedMicro: estimate,
      effectiveCapMicro: getEffectiveBudgetCap(state),
      spendTodayMicro: state.spendTodayMicro,
      remainingMicro: 0,
    };
  }

  if (options.ignoreBudget && options.manualRunBudgetMicro != null) {
    const effectiveCapMicro = getEffectiveBudgetCap(state);
    return {
      allowed: false,
      reason: "invalid_budget_options",
      estimatedMicro: estimate,
      effectiveCapMicro,
      spendTodayMicro: state.spendTodayMicro,
      remainingMicro: Math.max(0, effectiveCapMicro - state.spendTodayMicro),
    };
  }

  if (options.ignoreBudget) {
    const effectiveCapMicro = getEffectiveBudgetCap(state);
    return {
      allowed: true,
      reason: "ignore_budget",
      estimatedMicro: estimate,
      effectiveCapMicro,
      spendTodayMicro: state.spendTodayMicro,
      remainingMicro: Math.max(0, effectiveCapMicro - state.spendTodayMicro),
    };
  }

  const manualBudgetMicro = options.manualRunBudgetMicro == null
    ? null
    : normalizeManualRunBudgetMicro(options.manualRunBudgetMicro);
  if (manualBudgetMicro !== null) {
    const manualRunSpentMicro = nonNegativeInteger(options.manualRunSpentMicro);
    const remainingMicro = Math.max(
      0,
      Math.min(
        manualBudgetMicro - manualRunSpentMicro,
        MANUAL_RUN_DAILY_CAP_MICRO - state.manualSpendTodayMicro,
      ),
    );
    return {
      allowed: estimate <= remainingMicro,
      reason: estimate <= remainingMicro ? "ok" : "manual_budget_would_exceed",
      estimatedMicro: estimate,
      effectiveCapMicro: manualBudgetMicro,
      spendTodayMicro: state.manualSpendTodayMicro,
      remainingMicro,
    };
  }

  const effectiveCapMicro = getEffectiveBudgetCap(state);
  const remainingMicro = Math.max(0, effectiveCapMicro - state.spendTodayMicro);
  return {
    allowed: estimate <= remainingMicro,
    reason: estimate <= remainingMicro ? "ok" : "budget_would_exceed",
    estimatedMicro: estimate,
    effectiveCapMicro,
    spendTodayMicro: state.spendTodayMicro,
    remainingMicro,
  };
}

function rowToBudgetState(row: any, tenantId: string, fallbackDate: Date): TenantBudgetState {
  return {
    tenantId,
    dailyCapMicro: clampDailyCapMicro(row?.daily_cap_micro),
    carryoverBalanceMicro: nonNegativeInteger(row?.carryover_balance_micro),
    spendTodayMicro: nonNegativeInteger(row?.spend_today_micro),
    manualSpendTodayMicro: nonNegativeInteger(row?.manual_spend_today_micro),
    lastRolloverAt: asDate(row?.last_rollover_at, fallbackDate),
    updatedAt: asDate(row?.updated_at, fallbackDate),
  };
}

function cloneBudgetState(state: TenantBudgetState): TenantBudgetState {
  return {
    ...state,
    lastRolloverAt: new Date(state.lastRolloverAt),
    updatedAt: new Date(state.updatedAt),
  };
}

export async function getTenantBudgetState(
  sql: SqlLike,
  tenantId: string,
  now = new Date(),
): Promise<TenantBudgetState> {
  const validTenantId = assertTenantId(tenantId);
  await assertTenantGraphSpace(sql, validTenantId);
  const configured = await readTenantSetting(sql, validTenantId, "supercron_llm_budget_usd_micro_daily");
  const dailyCapMicro = clampDailyCapMicro(configured ?? DEFAULT_DAILY_LLM_BUDGET_MICRO);
  const today = utcMidnightFor(now);

  await sql`
    INSERT INTO supercron_tenant_budget_state (tenant_id, tenant_space_id, daily_cap_micro, last_rollover_at, updated_at)
    VALUES (${validTenantId}, ${`tenant:${validTenantId}`}, ${dailyCapMicro}, ${today}, now())
    ON CONFLICT (tenant_id) DO NOTHING
  `;

  await sql`
    UPDATE supercron_tenant_budget_state
    SET daily_cap_micro = ${dailyCapMicro},
        carryover_balance_micro = LEAST(carryover_balance_micro, ${dailyCapMicro * CARRYOVER_MAX_DAYS}),
        updated_at = now()
    WHERE tenant_id = ${validTenantId}
  `;

  await sql`
    UPDATE supercron_tenant_budget_state
    SET carryover_balance_micro = LEAST(
          daily_cap_micro * ${CARRYOVER_MAX_DAYS},
          GREATEST(
            0,
            carryover_balance_micro
              + (daily_cap_micro * GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${today}::timestamptz - last_rollover_at)) / 86400)::bigint))
              - spend_today_micro
          )
        ),
        spend_today_micro = 0,
        manual_spend_today_micro = 0,
        last_rollover_at = ${today},
        updated_at = now()
    WHERE tenant_id = ${validTenantId}
      AND last_rollover_at < ${today}
  `;

  const [row] = await sql`
    SELECT tenant_id, daily_cap_micro, carryover_balance_micro, spend_today_micro,
           manual_spend_today_micro, last_rollover_at, updated_at
    FROM supercron_tenant_budget_state
    WHERE tenant_id = ${validTenantId}
    LIMIT 1
  `;
  return rowToBudgetState(row, validTenantId, now);
}

function assertSpendMicro(value: unknown): number {
  const micro = integerOrDefault(value, -1);
  if (micro < 0) {
    throw new BudgetSpendRejectedError("invalid_estimate", "spend amount must be a non-negative integer");
  }
  return micro;
}

export async function canSpendLlmCost(
  sql: SqlLike,
  tenantId: string,
  estimatedMicro: number,
  options: BudgetCheckOptions = {},
): Promise<BudgetCheckResult> {
  const state = await getTenantBudgetState(sql, tenantId, options.now);
  return evaluateBudgetCheck(state, estimatedMicro, options);
}

export class BudgetStateCache {
  private stateValue: TenantBudgetState;
  private manualRunSpentMicroById = new Map<number, number>();
  private unkeyedManualRunSpentMicro = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly sql: SqlLike, state: TenantBudgetState) {
    this.stateValue = cloneBudgetState(state);
  }

  static async load(sql: SqlLike, tenantId: string, now = new Date()): Promise<BudgetStateCache> {
    return new BudgetStateCache(sql, await getTenantBudgetState(sql, tenantId, now));
  }

  currentState(): TenantBudgetState {
    return cloneBudgetState(this.stateValue);
  }

  async reload(now = new Date()): Promise<TenantBudgetState> {
    return this.serialize(async () => {
      this.stateValue = await getTenantBudgetState(this.sql, this.stateValue.tenantId, now);
      return this.currentState();
    });
  }

  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Synchronous snapshot check. Callers must await any in-flight
   * recordLlmSpend() or reload() on this cache before evaluating the next
   * budget check; pass bodies use this as a check-then-await-write sequence.
   */
  evaluateBudgetCheck(estimatedMicro: number, options: Omit<BudgetCheckOptions, "now"> = {}): BudgetCheckResult {
    const trackedManualRunSpend = options.manualRunId == null
      ? this.unkeyedManualRunSpentMicro
      : this.manualRunSpentMicroById.get(manualRunIdOrThrow(options.manualRunId)) ?? 0;
    const checkOptions = options.manualRunBudgetMicro == null || options.manualRunSpentMicro != null
      ? options
      : { ...options, manualRunSpentMicro: trackedManualRunSpend };
    return evaluateBudgetCheck(this.stateValue, estimatedMicro, checkOptions);
  }

  async recordLlmSpend(actualMicro: number, options: RecordSpendOptions = {}): Promise<TenantBudgetState> {
    return this.serialize(async () => {
      const micro = assertSpendMicro(actualMicro);
      if (micro === 0) return this.currentState();
      if (options.isManualRun) {
        if (options.manualRunId != null) {
          const manualRunId = manualRunIdOrThrow(options.manualRunId);
          const result = await recordManualRunSpend(this.sql, manualRunId, micro, this.stateValue.tenantId, {
            budgetStateInitialized: true,
          });
          this.stateValue.manualSpendTodayMicro = result.manualSpendTodayMicro;
          this.manualRunSpentMicroById.set(
            manualRunId,
            (this.manualRunSpentMicroById.get(manualRunId) ?? 0) + micro,
          );
        } else {
          const [row] = await this.sql`
            UPDATE supercron_tenant_budget_state
            SET manual_spend_today_micro = manual_spend_today_micro + ${micro},
                updated_at = now()
            WHERE tenant_id = ${this.stateValue.tenantId}
              AND manual_spend_today_micro + ${micro} <= ${MANUAL_RUN_DAILY_CAP_MICRO}
            RETURNING manual_spend_today_micro
          `;
          if (!row) throw new BudgetSpendRejectedError("manual_budget_would_exceed");
          this.stateValue.manualSpendTodayMicro = nonNegativeInteger(row.manual_spend_today_micro);
          this.unkeyedManualRunSpentMicro += micro;
        }
      } else {
        const [row] = await this.sql`
          UPDATE supercron_tenant_budget_state
          SET spend_today_micro = spend_today_micro + ${micro},
              updated_at = now()
          WHERE tenant_id = ${this.stateValue.tenantId}
            AND spend_today_micro + ${micro} <= daily_cap_micro + carryover_balance_micro
          RETURNING spend_today_micro
        `;
        if (!row) throw new BudgetSpendRejectedError("budget_would_exceed");
        this.stateValue.spendTodayMicro = nonNegativeInteger(row.spend_today_micro);
      }
      this.stateValue.updatedAt = new Date();
      return this.currentState();
    });
  }
}

export async function recordLlmSpend(
  sql: SqlLike,
  tenantId: string,
  actualMicro: number,
  options: RecordSpendOptions = {},
): Promise<void> {
  const micro = assertSpendMicro(actualMicro);
  if (micro === 0) return;
  await getTenantBudgetState(sql, tenantId);
  if (options.isManualRun) {
    if (options.manualRunId != null) {
      await recordManualRunSpend(sql, options.manualRunId, micro, tenantId, { budgetStateInitialized: true });
      return;
    }
    const [row] = await sql`
      UPDATE supercron_tenant_budget_state
      SET manual_spend_today_micro = manual_spend_today_micro + ${micro},
          updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND manual_spend_today_micro + ${micro} <= ${MANUAL_RUN_DAILY_CAP_MICRO}
      RETURNING manual_spend_today_micro
    `;
    if (!row) throw new BudgetSpendRejectedError("manual_budget_would_exceed");
    return;
  }
  const [row] = await sql`
    UPDATE supercron_tenant_budget_state
    SET spend_today_micro = spend_today_micro + ${micro},
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND spend_today_micro + ${micro} <= daily_cap_micro + carryover_balance_micro
    RETURNING spend_today_micro
  `;
  if (!row) throw new BudgetSpendRejectedError("budget_would_exceed");
}

function manualRunIdOrThrow(value: unknown): number {
  return positiveIntegerOrThrow(value, "manualRunId");
}

async function readManualRunForSpend(
  sql: SqlLike,
  id: number,
  expectedTenantId: string | null,
): Promise<{ tenantId: string; status: ManualRunStatus }> {
  const [row] = await sql`
    SELECT tenant_id, status FROM supercron_manual_runs WHERE id = ${id} LIMIT 1
  `;
  if (!row) throw new Error(`manual run not found: ${id}`);
  const tenantId = String(row.tenant_id);
  if (expectedTenantId !== null && tenantId !== expectedTenantId) {
    throw new Error(`manual run tenant mismatch: expected ${expectedTenantId}, got ${tenantId}`);
  }
  const status = parseManualRunStatus(row.status);
  if (status !== "pending" && status !== "running") {
    throw new Error(`manual run is not open: ${status}`);
  }
  return { tenantId, status };
}

/**
 * LOCK ORDER INVARIANT: When acquiring row locks on supercron_manual_runs
 * and supercron_tenant_budget_state in the same transaction, lock
 * supercron_manual_runs first, then supercron_tenant_budget_state.
 */
export async function recordManualRunSpend(
  sql: SqlLike,
  manualRunId: number,
  actualMicro: number,
  expectedTenantId: string | null = null,
  options: { budgetStateInitialized?: boolean } = {},
): Promise<ManualRunSpendResult> {
  const id = manualRunIdOrThrow(manualRunId);
  const micro = assertSpendMicro(actualMicro);
  const tenantFilter = expectedTenantId == null ? null : String(expectedTenantId);
  const manualRun = await readManualRunForSpend(sql, id, tenantFilter);
  if (!options.budgetStateInitialized) await getTenantBudgetState(sql, manualRun.tenantId);
  if (micro === 0) {
    const [row] = await sql`
      SELECT smr.id, smr.tenant_id, COALESCE(smr.actual_spend_micro, 0)::bigint AS actual_spend_micro,
             b.manual_spend_today_micro::bigint AS manual_spend_today_micro
      FROM supercron_manual_runs smr
      JOIN supercron_tenant_budget_state b ON b.tenant_id = smr.tenant_id
      WHERE smr.id = ${id}
        AND (${tenantFilter}::text IS NULL OR smr.tenant_id = ${tenantFilter})
        AND smr.status IN ('pending', 'running')
      LIMIT 1
    `;
    if (!row) throw new Error(`manual run not found: ${id}`);
    return {
      manualRunId: nonNegativeInteger(row.id),
      tenantId: String(row.tenant_id),
      actualSpendMicro: nonNegativeInteger(row.actual_spend_micro),
      manualSpendTodayMicro: nonNegativeInteger(row.manual_spend_today_micro),
    };
  }

  const [row] = await sql`
    WITH selected AS (
      SELECT smr.id, smr.tenant_id, smr.budget_micro,
             COALESCE(smr.actual_spend_micro, 0)::bigint AS actual_spend_micro,
             b.manual_spend_today_micro
      FROM supercron_manual_runs smr
      JOIN supercron_tenant_budget_state b ON b.tenant_id = smr.tenant_id
      WHERE smr.id = ${id}
        AND (${tenantFilter}::text IS NULL OR smr.tenant_id = ${tenantFilter})
        AND smr.status IN ('pending', 'running')
      FOR UPDATE OF smr, b
    ),
    eligible AS (
      SELECT s.id, s.tenant_id, s.actual_spend_micro
      FROM selected s
      WHERE s.actual_spend_micro + ${micro} <= s.budget_micro
        AND s.manual_spend_today_micro + ${micro} <= ${MANUAL_RUN_DAILY_CAP_MICRO}
    ),
    updated_run AS (
      UPDATE supercron_manual_runs smr
      SET actual_spend_micro = COALESCE(smr.actual_spend_micro, 0) + ${micro}
      FROM eligible e
      WHERE smr.id = e.id
      RETURNING smr.id, smr.tenant_id, smr.actual_spend_micro
    ),
    updated_budget AS (
      UPDATE supercron_tenant_budget_state b
      SET manual_spend_today_micro = manual_spend_today_micro + ${micro},
          updated_at = now()
      FROM eligible e
      WHERE b.tenant_id = e.tenant_id
      RETURNING b.tenant_id, b.manual_spend_today_micro
    )
    SELECT ur.id, ur.tenant_id, ur.actual_spend_micro, ub.manual_spend_today_micro
    FROM updated_run ur
    JOIN updated_budget ub ON ub.tenant_id = ur.tenant_id
    LIMIT 1
  `;
  if (!row) throw new BudgetSpendRejectedError("manual_budget_would_exceed");
  return {
    manualRunId: nonNegativeInteger(row.id),
    tenantId: String(row.tenant_id),
    actualSpendMicro: nonNegativeInteger(row.actual_spend_micro),
    manualSpendTodayMicro: nonNegativeInteger(row.manual_spend_today_micro),
  };
}

export async function createManualRunRecord(
  sql: SqlLike,
  input: { tenantId: string; requestedBy: string; budgetMicro: number; requestedAt?: Date },
): Promise<ManualRunRecord> {
  const tenantId = assertTenantId(input.tenantId);
  await assertTenantGraphSpace(sql, tenantId);
  const budgetMicro = normalizeManualRunBudgetMicro(input.budgetMicro);
  let row: any;
  try {
    [row] = await sql`
      INSERT INTO supercron_manual_runs (tenant_id, tenant_space_id, requested_at, requested_by, budget_micro, status)
      VALUES (${tenantId}, ${`tenant:${tenantId}`}, ${input.requestedAt || new Date()}, ${input.requestedBy}, ${budgetMicro}, 'pending')
      RETURNING id, tenant_id, requested_at, requested_by, budget_micro, status, rejection_reason
    `;
  } catch (error) {
    if (isManualRunAlreadyOpenError(error)) throw new ManualRunAlreadyOpenError(tenantId);
    throw error;
  }
  if (!row) throw new Error("manual run insert returned no row");
  return {
    id: positiveIntegerOrThrow(row.id, "manual run id"),
    tenantId: String(row.tenant_id || tenantId),
    requestedAt: asDate(row?.requested_at, input.requestedAt || new Date()),
    requestedBy: String(row?.requested_by || input.requestedBy),
    budgetMicro: nonNegativeInteger(row?.budget_micro),
    status: parseManualRunStatus(row.status),
    rejectionReason: row?.rejection_reason == null ? null : String(row.rejection_reason),
  };
}
