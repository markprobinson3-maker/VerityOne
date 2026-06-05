/**
 * Tier-2 eval harness — runnable golden cases that prove the Tier-2 primitive
 * CONTRACTS behave (Tier-2 harness-first OS, PR 9: contract-first, NO new table).
 *
 * VO already has a LIVE-RECALL golden system: scripts/golden-query.ts manages
 * golden_query_cases DB rows and the supercron golden-query pass runs them,
 * reporting a golden_pass_rate (miners/src/supercron-health.ts
 * GoldenQueryQualitySummary, min 0.8). That harness proves RECALL behaves against
 * the live graph. This module is its complement on the PRIMITIVE-CONTRACT side:
 * the Tier-2 libs (#63 action-packet, #65 review-queue, #66 needs-attention, #67
 * routine-plugin, #62's pure summarizeAtomicity) are all PURE functions over
 * fixtures — ideal golden inputs — so their acceptance criteria can be turned into
 * deterministic golden cases that run with NO DB and NO LLM.
 *
 * Per the Tier-2 rule it adds NO store, NO route, NO LLM call. It REUSES the
 * existing golden vocabulary: the report mirrors GoldenQueryQualitySummary's field
 * names (golden_pass_rate, golden_cases_run/failed/errored/total) and the 0.8
 * GOLDEN_QUERY_PASS_RATE_MINIMUM, and yields the same `degraded`-below-minimum
 * verdict the supercron quality report uses — so a future cycle can fold the
 * primitive-contract pass-rate into the same health surface. `runEvalSuite` is a
 * pure deterministic runner; `tier2GoldenCases()` ships the canonical suite.
 */

import { selectReviewQueue } from "./review-queue";
import { aggregateAttention } from "./needs-attention";
import { buildWorkflowRun } from "./workflow-run";
import { summarizeAtomicity } from "./lifecycle-atomicity";
import { toActionPacket } from "./action-packet";
import { resolveFederationMetadata } from "./federated-memory";
import type { RecallResult, RecalledMemory } from "./recall-compiler";
import {
  buildRoutinePlugin,
  evaluateRoutineAdmission,
  validateRoutinePlugin,
} from "./routine-plugin";

// ── Vocabulary (mirrors supercron-health's golden pass-rate semantics) ─────────

/** Minimum golden pass rate before a suite is "degraded" — mirrors GOLDEN_QUERY_PASS_RATE_MINIMUM. */
export const GOLDEN_PASS_RATE_MINIMUM = 0.8;

export type GoldenCaseStatus = "passed" | "failed" | "errored";

/** The outcome of evaluating one golden case (pure: pass + an operator-readable detail). */
export interface GoldenCheck {
  pass: boolean;
  detail: string;
}

/** A golden case: a pure assertion over a Tier-2 primitive run on a fixture. */
export interface GoldenCase {
  id: string;
  /** Which Tier-2 primitive this pins (e.g. "review-queue"). */
  primitive: string;
  description: string;
  /** Pure; runs the lib over a fixture and returns pass + detail. May throw → errored. */
  evaluate: () => GoldenCheck;
}

export interface GoldenCaseResult {
  id: string;
  primitive: string;
  description: string;
  status: GoldenCaseStatus;
  detail: string;
}

export interface EvalReport {
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generated_at: string;
  golden_cases_total: number;
  golden_cases_run: number;
  golden_cases_passed: number;
  golden_cases_failed: number;
  golden_cases_errored: number;
  /** passed / run, or null when nothing ran (mirrors GoldenQueryQualitySummary). */
  golden_pass_rate: number | null;
  minimum_pass_rate: number;
  /** True when a pass rate exists and is below the minimum. */
  degraded: boolean;
  by_primitive: Record<string, { run: number; passed: number; failed: number; errored: number }>;
  /** Every non-passing case — never silent. */
  failures: GoldenCaseResult[];
}

// ── Runner ─────────────────────────────────────────────────────────────────────

export interface RunEvalSuiteOptions {
  generatedAt: string;
  minimumPassRate?: number;
}

/**
 * Run a golden suite. PURE and deterministic — never touches the DB, never calls
 * an LLM, never mutates the input. Cases run in array order; a case that throws is
 * counted as `errored` (it never crashes the suite), so one broken case cannot
 * mask the rest. The same cases always yield the same report.
 */
export function runEvalSuite(cases: GoldenCase[], opts: RunEvalSuiteOptions): EvalReport {
  // Case ids must be unique so failures[] is keyable — a duplicate is a suite
  // authoring error (mirrors the registry's duplicate-id rejection). Fail loud.
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new TypeError(`eval suite has a duplicate case id: ${c.id}`);
    ids.add(c.id);
  }

  // Clamp the minimum to [0,1] uniformly: NaN/undefined/Infinity/2/-1 all fall back
  // to the default rather than producing "always/never degraded" traps.
  const m = opts.minimumPassRate;
  const minimum_pass_rate = typeof m === "number" && m >= 0 && m <= 1 ? m : GOLDEN_PASS_RATE_MINIMUM;

  const by_primitive: Record<string, { run: number; passed: number; failed: number; errored: number }> = {};
  const failures: GoldenCaseResult[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;

  const bump = (primitive: string): { run: number; passed: number; failed: number; errored: number } => {
    if (!by_primitive[primitive]) by_primitive[primitive] = { run: 0, passed: 0, failed: 0, errored: 0 };
    return by_primitive[primitive];
  };

  for (const c of cases) {
    const bucket = bump(c.primitive);
    bucket.run++;
    let status: GoldenCaseStatus;
    let detail: string;
    try {
      const check = c.evaluate();
      if (check.pass) { status = "passed"; passed++; bucket.passed++; }
      else { status = "failed"; failed++; bucket.failed++; }
      detail = check.detail;
    } catch (err) {
      status = "errored";
      errored++;
      bucket.errored++;
      detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (status !== "passed") {
      failures.push({ id: c.id, primitive: c.primitive, description: c.description, status, detail });
    }
  }

  const run = cases.length;
  const golden_pass_rate = run > 0 ? passed / run : null;
  const degraded = golden_pass_rate !== null && golden_pass_rate < minimum_pass_rate;

  return {
    generated_at: opts.generatedAt,
    golden_cases_total: run,
    golden_cases_run: run,
    golden_cases_passed: passed,
    golden_cases_failed: failed,
    golden_cases_errored: errored,
    golden_pass_rate,
    minimum_pass_rate,
    degraded,
    by_primitive,
    failures,
  };
}

// ── The canonical Tier-2 golden suite ──────────────────────────────────────────
//
// Each case runs a PURE Tier-2 lib over a small fixture and pins a documented
// acceptance criterion. A fixed fixture timestamp keeps every case deterministic
// (the libs require a generatedAt; this is a fixture value, not a clock read).

const GOLDEN_AT = "2026-01-01T00:00:00.000Z";

const ok: GoldenCheck = { pass: true, detail: "ok" };
const fail = (detail: string): GoldenCheck => ({ pass: false, detail });

/**
 * The canonical suite: ~10 golden cases across review-queue, needs-attention,
 * routine-plugin, and lifecycle-atomicity (all DB-free). A regression in any
 * Tier-2 contract turns one of these red. (action-packet is coverable by the same
 * GoldenCase contract — it needs a RecallResult fixture, attached by the caller.)
 */
export function tier2GoldenCases(): GoldenCase[] {
  return [
    // ── #65 review-queue ─────────────────────────────────────────────────────
    {
      id: "rq.contradiction_high",
      primitive: "review-queue",
      description: "a strong-anchor contradiction selects one high-severity contradiction_review packet",
      evaluate: () => {
        const q = selectReviewQueue(
          { tenantId: "t1", conflicts: [{ addr_a: "A", addr_b: "B", conflict_type: "contradiction", description: "jaccard=0.5, shared_terms=alpha|beta|gamma" }] },
          { generatedAt: GOLDEN_AT },
        );
        if (q.packets.length !== 1) return fail(`expected 1 packet, got ${q.packets.length}`);
        const p = q.packets[0];
        return p.review_kind === "contradiction_review" && p.severity === "high"
          ? ok : fail(`got kind=${p.review_kind} severity=${p.severity}`);
      },
    },
    {
      id: "rq.weak_anchor_dropped",
      primitive: "review-queue",
      description: "a weak-anchor contradiction is precision-gated out (low_relevance)",
      evaluate: () => {
        const q = selectReviewQueue(
          { tenantId: "t1", conflicts: [{ addr_a: "A", addr_b: "B", conflict_type: "contradiction", description: "jaccard=0.02, shared_terms=x" }] },
          { generatedAt: GOLDEN_AT },
        );
        return q.packets.length === 0 && q.dropped.find((d) => d.reason === "low_relevance")?.count === 1
          ? ok : fail(`packets=${q.packets.length} dropped=${JSON.stringify(q.dropped)}`);
      },
    },
    {
      id: "rq.budget_bounded",
      primitive: "review-queue",
      description: "the budget actually binds: allocated <= total, some admitted, the excess dropped over_budget (not silent)",
      evaluate: () => {
        const q = selectReviewQueue(
          { tenantId: "t1", stale: Array.from({ length: 30 }, (_, i) => ({ addr: `A${i}`, days_old: 200 })) },
          { generatedAt: GOLDEN_AT, totalBudgetMicro: 5000 },
        );
        const overBudget = q.dropped.find((d) => d.reason === "over_budget")?.count ?? 0;
        // Pin the limiter, not just the inequality: a zero-admission impl must NOT pass.
        return q.budget.allocated_micro <= q.budget.total_micro && q.packets.length > 0 && q.packets.length < 30 && overBudget > 0
          ? ok : fail(`allocated=${q.budget.allocated_micro} total=${q.budget.total_micro} packets=${q.packets.length} over_budget=${overBudget}`);
      },
    },

    // ── #66 needs-attention ──────────────────────────────────────────────────
    {
      id: "na.failed_run_high",
      primitive: "needs-attention",
      description: "a failed workflow run surfaces as a high-severity failed_workflow item",
      evaluate: () => {
        const run = buildWorkflowRun({ run_id: "r1", source_ledger: "remote_commands", kind: "retract_memory", status: "failed", tenant_id: "t1", started_at: GOLDEN_AT, ended_at: GOLDEN_AT, outcome: { class: "failure" } });
        const out = aggregateAttention({ tenantId: "t1", workflowRuns: [run] }, { generatedAt: GOLDEN_AT });
        if (out.items.length !== 1) return fail(`expected 1 item, got ${out.items.length}`);
        const it = out.items[0];
        return it.severity === "high" && it.category === "failed_workflow"
          ? ok : fail(`got severity=${it.severity} category=${it.category}`);
      },
    },
    {
      id: "na.compose_review_queue",
      primitive: "needs-attention",
      description: "a contradiction packet lifts faithfully: source review_queue, category conflict, severity high (pins the REVIEW_KIND→category map + passthrough)",
      evaluate: () => {
        const reviewQueue = selectReviewQueue(
          { tenantId: "t1", conflicts: [{ addr_a: "A", addr_b: "B", conflict_type: "contradiction", description: "jaccard=0.5, shared_terms=a|b|c" }] },
          { generatedAt: GOLDEN_AT },
        );
        const out = aggregateAttention({ tenantId: "t1", reviewQueue }, { generatedAt: GOLDEN_AT });
        const lifted = out.items.find((i) => i.source === "review_queue");
        if (!lifted) return fail("no review_queue-sourced item produced");
        return lifted.category === "conflict" && lifted.severity === "high"
          ? ok : fail(`lifted item category=${lifted.category} severity=${lifted.severity}`);
      },
    },
    {
      id: "na.healthy_run_excluded",
      primitive: "needs-attention",
      description: "a succeeded workflow run is not attention",
      evaluate: () => {
        const run = buildWorkflowRun({ run_id: "r2", source_ledger: "wi_runs", kind: "harvest", status: "succeeded", tenant_id: "t1", started_at: GOLDEN_AT, ended_at: GOLDEN_AT, outcome: { class: "success" } });
        const out = aggregateAttention({ tenantId: "t1", workflowRuns: [run] }, { generatedAt: GOLDEN_AT });
        return out.items.length === 0 ? ok : fail(`expected 0 items, got ${out.items.length}`);
      },
    },

    // ── #67 routine-plugin ───────────────────────────────────────────────────
    {
      id: "rp.opt_in_safe_sink",
      primitive: "routine-plugin",
      description: "a built routine is opt-in, validates, and targets a safe sink (day_node)",
      evaluate: () => {
        const spec = buildRoutinePlugin({ id: "market.spy_qqq_close", schedule: "weekday@15:05" });
        return spec.default_enabled === false && spec.output_target === "day_node" && validateRoutinePlugin(spec).ok
          ? ok : fail(`default_enabled=${spec.default_enabled} output_target=${spec.output_target} valid=${validateRoutinePlugin(spec).ok}`);
      },
    },
    {
      id: "rp.budget_enforced",
      primitive: "routine-plugin",
      description: "remaining budget below the routine's declared ceiling blocks admission",
      evaluate: () => {
        const spec = buildRoutinePlugin({ id: "x.llm", schedule: "daily@09:00", budget_ceiling_micro: 40000 });
        const a = evaluateRoutineAdmission(spec, { enabled: true, schedule_due: true, permission_grants: ["journal_write"], budget: { allowed: true, reason: "ok", remainingMicro: 39999 } });
        return a.admit === false && a.blocked_by.some((b) => b.reason === "over_budget")
          ? ok : fail(`admit=${a.admit} blocks=${a.blocked_by.map((b) => b.reason).join(",")}`);
      },
    },
    {
      id: "rp.scoped_authority",
      primitive: "routine-plugin",
      description: "a scoped routine is blocked without granted authority",
      evaluate: () => {
        const spec = buildRoutinePlugin({ id: "inbox.summary", schedule: "daily@08:00", permissions: ["journal_write", "email"], sensitivity: "email" });
        const a = evaluateRoutineAdmission(spec, { enabled: true, schedule_due: true, permission_grants: ["journal_write", "email"] });
        return a.admit === false && a.blocked_by.some((b) => b.reason === "needs_scoped_authority")
          ? ok : fail(`admit=${a.admit} blocks=${a.blocked_by.map((b) => b.reason).join(",")}`);
      },
    },

    // ── #62 lifecycle-atomicity (pure roll-up) ─────────────────────────────────
    {
      id: "la.summarize_torn",
      primitive: "lifecycle-atomicity",
      description: "a torn class rolls up to a non-clean report with matching severity totals",
      evaluate: () => {
        const rep = summarizeAtomicity(
          [{ class: "recall_eligible_inactive_registry", severity: "torn", description: "retired memory still served", count: 2, sample_addrs: ["A", "B"] }],
          { tenant_id: "t1", generated_at: GOLDEN_AT, sample_limit: 20 },
        );
        return rep.clean === false && rep.total_findings === 2 && rep.by_severity.torn === 2
          ? ok : fail(`clean=${rep.clean} total=${rep.total_findings} torn=${rep.by_severity.torn}`);
      },
    },

    // ── #63 action-packet ──────────────────────────────────────────────────────
    {
      id: "ap.durable_decision_approval",
      primitive: "action-packet",
      description: "a durable decision recall packetizes with operating_class decision and a raised approval bar (never 'none', composing #61)",
      evaluate: () => {
        const memory: RecalledMemory = {
          addr: "PJ.0.3.100", label: "model routing decision", kind: "decision", source: "user_accepted",
          assertion: "Default to gemini-3.1-pro for complex coding.", why_it_matters: "model routing",
          relevance: 0.9, freshness: 0.9, provenance_score: 1.0, conflict_free: true, composite_score: 0.9,
          created_at: "2026-05-01T00:00:00Z", effective_at: "2026-05-01T00:00:00Z", superseded_by: null,
          status: "active", federation: resolveFederationMetadata(null), project_addr: null, project_label: null,
          explanation: { why_recalled: "high relevance + user-accepted", lifecycle_note: null, provenance_label: "user-accepted" },
        };
        const result: RecallResult = {
          recall_id: "rcl_golden_1", primary_memories: [memory], supporting_memories: [], changes_since: [],
          conflicts: [], stale: [], fresh_research_needed: null,
          confidence: { relevance: "high", freshness: "high", provenance: "high", conflict_free: "high", summary: "strong" },
          next_move: "Apply the decision.", error_recovered: false, recovery_reason: null,
          explanation: { candidates_scored: 5, excluded_count: 0, excluded_reasons: [], posture: "memory_backed", posture_note: "memory-backed", routing_method: "semantic", routed_family: null },
        };
        const pkt = toActionPacket(result);
        return pkt.has_primary && pkt.operating_class === "decision" && pkt.required_approval !== "none"
          ? ok : fail(`has_primary=${pkt.has_primary} class=${pkt.operating_class} approval=${pkt.required_approval}`);
      },
    },
  ];
}
