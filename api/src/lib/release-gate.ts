/**
 * Release gate — the single pass/fail verdict that decides whether VO's Tier-2
 * Harness-OS is releasable (Tier-2 harness-first OS, PR 11 / CAPSTONE part 2:
 * contract-first, NO new table).
 *
 * The release-blocking checks already exist, scattered across CI: the typecheck
 * ratchet (scripts/typecheck-gate.ts), the pure + live drift suites
 * (foundation-drift-guards / foundation-live-drift), #68's golden eval pass rate,
 * #62's lifecycle-atomicity report, and #11a's operating-loop proof. There is no
 * single orchestrator that runs them and emits ONE verdict. Per the Tier-2 rule
 * ("classify/normalize OVER existing structures") this module does NOT re-run or
 * re-implement any check — it is a PURE, DETERMINISTIC sequencer over the
 * already-computed OUTCOMES (the #66 needs-attention pattern: the caller gathers
 * the results, the gate decides), emitting a releasable boolean + the typed list of
 * blocking checks (never silent). It adds NO store, NO route, NO LLM call.
 *
 * The actual COMMAND that runs the gates (typecheck via tsc, drift via bun test,
 * the live atomicity scan, the live loop proof) and feeds their results in is a
 * later capstone part (a script); this is its contract.
 */

import type { LoopProof } from "./operating-loop";
import type { EvalReport } from "./eval-harness";
import type { LifecycleAtomicityReport } from "./lifecycle-atomicity";

// ── Vocabulary ──────────────────────────────────────────────────────────────────

/** The release-blocking checks, in evaluation order. */
export type ReleaseGateCheckName =
  | "typecheck"            // scripts/typecheck-gate.ts ratchet (api/src errors <= baseline)
  | "drift_guards"         // the foundation drift suites
  | "golden_eval"          // #68 eval-harness golden pass rate >= minimum
  | "lifecycle_atomicity"  // #62 — no invariant/torn findings (drift self-heals)
  | "operating_loop";      // #11a — the operating-loop proof is green + wired

export const RELEASE_GATE_CHECKS: readonly ReleaseGateCheckName[] = [
  "typecheck", "drift_guards", "golden_eval", "lifecycle_atomicity", "operating_loop",
] as const;

// ── Input: the already-computed outcomes of each check ──────────────────────────

export interface ReleaseGateInput {
  /** From scripts/typecheck-gate.ts: the one-way api/src error ratchet. */
  typecheck: { ok: boolean; apiSrcErrors: number; baseline: number };
  /** Whether the pure + live drift suites passed (and which failed, if any). */
  driftGuards: { ok: boolean; failed?: string[] };
  /** #68 EvalReport (the relevant subset). */
  goldenEval: Pick<EvalReport, "golden_pass_rate" | "degraded" | "minimum_pass_rate">;
  /** #62 LifecycleAtomicityReport (the relevant subset). */
  lifecycleAtomicity: Pick<LifecycleAtomicityReport, "clean" | "total_findings" | "by_severity">;
  /** #11a LoopProof (the relevant subset). */
  operatingLoop: Pick<LoopProof, "ok" | "wired">;
}

// ── Verdict ──────────────────────────────────────────────────────────────────────

export interface ReleaseGateCheck {
  name: ReleaseGateCheckName;
  passed: boolean;
  detail: string;
}

export interface ReleaseGateVerdict {
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generated_at: string;
  /** True iff every release-blocking check passed. */
  releasable: boolean;
  checks: ReleaseGateCheck[];
  /** The names of the checks that blocked release — never silent. */
  blockers: ReleaseGateCheckName[];
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Decide releasability from the gathered check outcomes. PURE and deterministic —
 * never touches the DB, never re-runs a check, never mutates the input. Every check
 * is release-blocking; `releasable` is true iff all pass, and `blockers` names every
 * failing check (never silent). The same outcomes always yield the same verdict.
 */
export function evaluateReleaseGate(input: ReleaseGateInput, opts: { generatedAt: string }): ReleaseGateVerdict {
  const checks: ReleaseGateCheck[] = [];

  // typecheck ratchet: must be ok AND within the error baseline.
  const tcPassed = input.typecheck.ok && input.typecheck.apiSrcErrors <= input.typecheck.baseline;
  checks.push({
    name: "typecheck",
    passed: tcPassed,
    detail: `${input.typecheck.apiSrcErrors} api/src errors (baseline ${input.typecheck.baseline})`,
  });

  // drift guards: all pure + live drift suites must pass.
  checks.push({
    name: "drift_guards",
    passed: input.driftGuards.ok,
    detail: input.driftGuards.ok ? "all drift guards pass" : `failed: ${(input.driftGuards.failed ?? []).join(", ") || "unspecified"}`,
  });

  // golden eval: must have ACTUALLY RUN (a null pass rate = no evidence) AND not be
  // degraded AND be at/above the minimum. A release gate fails closed on no-evidence
  // — it never accepts the supercron health surface's null-tolerant convention.
  const golden = input.goldenEval;
  const goldenRate = golden.golden_pass_rate;
  const goldenPassed = goldenRate != null && !golden.degraded && goldenRate >= golden.minimum_pass_rate;
  checks.push({
    name: "golden_eval",
    passed: goldenPassed,
    detail: goldenRate == null
      ? "no golden cases ran (no evidence)"
      : `golden_pass_rate ${goldenRate} (min ${golden.minimum_pass_rate})`,
  });

  // lifecycle atomicity: by_severity must be PRESENT (an absent report is no evidence,
  // not "clean") and have no structural (invariant) or torn findings; drift self-heals.
  const atom = input.lifecycleAtomicity;
  const sev = atom.by_severity;
  const atomPassed = sev != null && sev.invariant === 0 && sev.torn === 0;
  checks.push({
    name: "lifecycle_atomicity",
    passed: atomPassed,
    detail: sev == null
      ? "atomicity report missing by_severity (no evidence)"
      : atomPassed
        ? `no invariant/torn findings (${atom.total_findings} total, drift-only)`
        : `${sev.invariant} invariant + ${sev.torn} torn findings`,
  });

  // operating-loop proof: must be green AND wired.
  const loopPassed = input.operatingLoop.ok && input.operatingLoop.wired;
  checks.push({
    name: "operating_loop",
    passed: loopPassed,
    detail: loopPassed ? "loop proof green + wired" : `ok=${input.operatingLoop.ok} wired=${input.operatingLoop.wired}`,
  });

  const blockers = checks.filter((c) => !c.passed).map((c) => c.name);
  return { generated_at: opts.generatedAt, releasable: blockers.length === 0, checks, blockers };
}
