/**
 * Worker LLM spend ledger (item 5) — per-call spend accounting for ALL Gemini workers, not just
 * SuperCron.
 *
 * PR15 budget enforcement is SuperCron-scoped; non-SuperCron workers (qc-sentinel, verity-ingest,
 * distiller, swarm, …) call the shared LLM client directly and record no spend, so PR15 totals
 * understate true tenant LLM spend. This is the shared writer/reader for a per-call ledger so
 * /ops can report total LLM spend by worker.
 *
 * Two load-bearing properties:
 *   - ACCOUNTING-ONLY: it records spend; it NEVER gates (no worker is blocked on budget here).
 *   - BEST-EFFORT: every write is wrapped — a recording failure is logged and swallowed, so
 *     instrumentation can never break a worker's LLM call.
 *
 * Shared between workspaces: api (/ops read surface) and miners (the writers) both import it.
 */

import type { Sql } from "postgres";

/**
 * Per-token micro-USD rates. MIRRORS miners/src/supercron-budget-policy.ts
 * LLM_MODEL_COST_MICRO_PER_TOKEN so worker spend is priced identically to SuperCron spend; a
 * foundation-state-drift pin asserts the two tables stay in sync.
 */
export const WORKER_LLM_COST_MICRO_PER_TOKEN = {
  embedding: { input: 0.15, output: 0 },
  flash_lite: { input: 0.0375, output: 0.15 },
  flash: { input: 0.075, output: 0.30 },
  pro: { input: 1.25, output: 10.00 },
} as const;

export type WorkerLlmCostBucket = keyof typeof WORKER_LLM_COST_MICRO_PER_TOKEN;

/** Map a model id to its rate bucket — mirrors supercron's llmCostBucket. */
export function workerLlmCostBucket(modelId: string): WorkerLlmCostBucket {
  const n = modelId.toLowerCase();
  if (n.includes("embedding") || n.includes("embed")) return "embedding";
  if (n.includes("lite")) return "flash_lite";
  if (n.includes("pro")) return "pro";
  return "flash";
}

/** Micro-USD cost from token counts (>=1 when any tokens, mirrors supercron's llmActualCostMicro).
 *  0 only when both token counts are unknown/zero. */
export function workerLlmCostMicro(modelId: string, tokensIn: number | null, tokensOut: number | null): number {
  const input = Math.max(0, Number(tokensIn || 0));
  const output = Math.max(0, Number(tokensOut || 0));
  if (input === 0 && output === 0) return 0;
  const rates = WORKER_LLM_COST_MICRO_PER_TOKEN[workerLlmCostBucket(modelId)];
  return Math.max(1, Math.ceil(input * rates.input + output * rates.output));
}

export interface WorkerSpendEntry {
  worker: string;
  tenantId?: string | null;
  modelId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  correlationId?: string | null;
}

/**
 * Record ONE worker LLM call's spend. BEST-EFFORT: never throws — a failed write is logged and
 * swallowed, so instrumentation can never break a worker's LLM path.
 */
export async function recordWorkerSpend(sql: Sql, entry: WorkerSpendEntry): Promise<void> {
  try {
    const tokensIn = Math.max(0, Math.trunc(Number(entry.tokensIn || 0)));
    const tokensOut = Math.max(0, Math.trunc(Number(entry.tokensOut || 0)));
    const costMicro = workerLlmCostMicro(entry.modelId, tokensIn, tokensOut);
    await sql`
      INSERT INTO worker_llm_spend (worker_name, tenant_id, model_id, tokens_in, tokens_out, cost_usd_micro, correlation_id)
      VALUES (${entry.worker}, ${entry.tenantId ?? null}, ${entry.modelId}, ${tokensIn}, ${tokensOut}, ${costMicro}, ${entry.correlationId ?? null})
    `;
  } catch (err) {
    console.error(`[worker-llm-spend] best-effort record failed for worker=${entry.worker} model=${entry.modelId}:`, (err as Error)?.message);
  }
}

/**
 * A spend hook bound to a sql handle + worker identity, shaped to plug straight into the miners
 * LLM client's `spend` config. It takes the structural LLMResult shape (modelId + token counts)
 * so this api lib needs NO import from miners. Best-effort (delegates to recordWorkerSpend).
 */
export function makeWorkerSpendRecorder(
  sql: Sql,
  opts: { worker: string; tenantId?: string | null; correlationId?: string | null },
): (result: { modelId: string; inputTokens: number | null; outputTokens: number | null }) => Promise<void> {
  return (result) => recordWorkerSpend(sql, {
    worker: opts.worker,
    tenantId: opts.tenantId ?? null,
    modelId: result.modelId,
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
    correlationId: opts.correlationId ?? null,
  });
}

export interface WorkerSpendSummaryRow {
  worker_name: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_micro: number;
}

/**
 * Aggregate spend by worker over the last `sinceHours` (default 24, clamped to [1, 90 days]).
 * Read-only — backs the /ops/llm-spend surface.
 */
export async function summarizeWorkerSpend(
  sql: Sql,
  opts: { sinceHours?: number } = {},
): Promise<{ since_hours: number; total_cost_usd_micro: number; by_worker: WorkerSpendSummaryRow[] }> {
  const raw = Number(opts.sinceHours);
  const sinceHours = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 24 * 90) : 24;
  const rows = await sql`
    SELECT worker_name,
           count(*)::int AS calls,
           COALESCE(sum(tokens_in), 0)::bigint AS tokens_in,
           COALESCE(sum(tokens_out), 0)::bigint AS tokens_out,
           COALESCE(sum(cost_usd_micro), 0)::bigint AS cost_usd_micro
    FROM worker_llm_spend
    WHERE occurred_at >= now() - make_interval(hours => ${sinceHours})
    GROUP BY worker_name
    ORDER BY cost_usd_micro DESC
  `;
  const byWorker: WorkerSpendSummaryRow[] = (rows as any[]).map((r) => ({
    worker_name: r.worker_name,
    calls: Number(r.calls),
    tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out),
    cost_usd_micro: Number(r.cost_usd_micro),
  }));
  const total = byWorker.reduce((acc, r) => acc + r.cost_usd_micro, 0);
  return { since_hours: sinceHours, total_cost_usd_micro: total, by_worker: byWorker };
}
