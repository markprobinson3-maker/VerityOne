/**
 * Live release-evidence collector (Tier-2 Harness-OS live wiring, LW2).
 *
 * The release gate (#11b api/src/lib/release-gate.ts) is a PURE sequencer over five
 * release-blocking outcomes: typecheck, drift_guards, golden_eval, lifecycle_atomicity,
 * operating_loop. Its authoritative runner is the CI command api/scripts/release-gate.ts,
 * which gathers the toolchain/DB results and feeds them in.
 *
 * This module is the LIVE, IN-SERVER complement: it gathers — at request time, against
 * the running DB — every outcome that CAN be attested in-process, then emits the gate
 * verdict over them. Three of the five checks are live-attestable here:
 *   - lifecycle_atomicity — a LIVE read-only scan (lifecycleAtomicityReport(sql)); this
 *     is the one check the endpoint attests with real evidence that the CI script can
 *     only take as a passed-in flag.
 *   - golden_eval — the #68 pure golden suite (runEvalSuite over tier2GoldenCases()).
 *   - operating_loop — the #11a loop proof over the canonical staged fixture
 *     (defaultLoopProofInput()); proves the loop WIRES end-to-end, the same input the
 *     daily-loop-proof command uses.
 *
 * The two remaining checks (typecheck via tsc, drift_guards via `bun test`) CANNOT run
 * inside the API process. They FAIL CLOSED — emitted as not-ok so the gate blocks and
 * names them — exactly as api/scripts/release-gate.ts treats absent flags. The
 * consequence is deliberate and load-bearing: this endpoint can NEVER mint
 * `releasable: true`. It is a read-only EVIDENCE surface for operators, never a release
 * authority; the CI release-gate script remains the only path to a green verdict.
 *
 * Per the Tier-2 rule it adds NO store and NO LLM call — only read-only SELECTs (the
 * atomicity scan) and pure composition over already-built primitives.
 */

import type { Sql } from "postgres";

import { evaluateReleaseGate, type ReleaseGateInput, type ReleaseGateVerdict } from "./release-gate";
import { runEvalSuite, tier2GoldenCases, type EvalReport } from "./eval-harness";
import { runLoopProof, defaultLoopProofInput, buildLoopProofInputForTenant, type LoopProof } from "./operating-loop";
import { lifecycleAtomicityReport, type LifecycleAtomicityReport } from "./lifecycle-atomicity";
import { POLICY_PROFILE_NAMES, type PolicyProfileName } from "./policy-profile";

/** The release-gate checks that have NO in-process evidence and therefore fail closed
 *  in live mode. The CI release-gate script attests these via the toolchain. */
export const CI_ONLY_CHECKS = ["typecheck", "drift_guards"] as const;

export interface ReleaseEvidenceBundle {
  /** Caller-supplied snapshot anchor. */
  generated_at: string;
  mode: "live";
  /** What the evidence was scoped to: a single tenant, or the whole operator graph. */
  scope: "tenant" | "operator";
  /** The tenant the evidence is scoped to (null in operator scope). */
  tenant_id: string | null;
  /** The gate verdict over the live evidence. typecheck + drift_guards fail closed in
   *  live mode, so `releasable` is ALWAYS false here — this is an evidence surface, not
   *  the release authority (api/scripts/release-gate.ts is). */
  verdict: ReleaseGateVerdict;
  live_checks: {
    operating_loop: LoopProof;
    golden_eval: EvalReport;
    /** null iff the live atomicity scan errored — the gate then fails closed on it. */
    lifecycle_atomicity: LifecycleAtomicityReport | null;
  };
  /** Any live check that could not run (e.g. the DB scan failed). Empty when all ran. */
  live_check_errors: Record<string, string>;
  ci_attestation: {
    /** Always false: tsc + `bun test` cannot run in the API process. */
    attestable_in_live_mode: false;
    checks: readonly string[];
    note: string;
  };
}

export interface CollectReleaseEvidenceOptions {
  /** Snapshot anchor (the route supplies a real ISO timestamp). */
  generatedAt: string;
  /** Per-class offender sample bound for the live atomicity scan (1–200, default 20). */
  sampleLimit?: number;
  /** Policy profile driving the operating-loop proof (default balanced). */
  profile?: PolicyProfileName;
  /**
   * Scope the evidence to ONE tenant (default: operator-wide). When set, the live
   * atomicity scan filters to `tenant:${tenantId}` and the operating-loop proof runs
   * the tenant's namespaced fixture (buildLoopProofInputForTenant) instead of the
   * Tenant-Zero default — so an operator can attest a SPECIFIC tenant's release
   * readiness, not just the aggregate.
   */
  tenantId?: string | null;
}

const CI_ATTESTATION_NOTE =
  "typecheck + drift_guards run under the CI toolchain (tsc + `bun test`), not in this " +
  "process; they fail closed here so a live verdict can never be releasable. Run " +
  "`bun run api/scripts/release-gate.ts` in CI for the authoritative full verdict.";

/**
 * Assemble the ReleaseGateInput from the live evidence, FAILING CLOSED on the two
 * CI-only checks. PURE — no DB, no clock — so the fail-closed posture is unit-testable
 * without a database. typecheck + drift_guards carry no in-process evidence, so they are
 * emitted not-ok (mirroring api/scripts/release-gate.ts's absent-flag handling); the gate
 * then blocks and names them, guaranteeing `releasable` is false in live mode.
 */
export function assembleLiveReleaseGateInput(live: {
  operatingLoop: Pick<LoopProof, "ok" | "wired">;
  goldenEval: Pick<EvalReport, "golden_pass_rate" | "degraded" | "minimum_pass_rate">;
  lifecycleAtomicity: ReleaseGateInput["lifecycleAtomicity"];
}): ReleaseGateInput {
  return {
    // No in-process toolchain → no typecheck evidence. Fail closed.
    typecheck: { ok: false, apiSrcErrors: Number.MAX_SAFE_INTEGER, baseline: 0 },
    // The drift suites run under `bun test` in CI, not in this process. Fail closed with
    // an explicit reason so the blocker detail reads clearly.
    driftGuards: { ok: false, failed: ["not_attested_in_live_mode"] },
    goldenEval: live.goldenEval,
    lifecycleAtomicity: live.lifecycleAtomicity,
    operatingLoop: live.operatingLoop,
  };
}

/** Normalize a caller-supplied profile to a known name, or undefined (→ balanced). */
export function normalizeProfile(raw: string | null | undefined): PolicyProfileName | undefined {
  return raw != null && (POLICY_PROFILE_NAMES as readonly string[]).includes(raw)
    ? (raw as PolicyProfileName)
    : undefined;
}

/**
 * Gather the live release evidence and emit the gate verdict. Read-only — the only DB
 * access is the lifecycle-atomicity SELECT scan; everything else is pure. If the live
 * atomicity scan throws (e.g. DB unavailable), it FAILS CLOSED: the error is recorded,
 * the live report is null, and the gate blocks lifecycle_atomicity on no-evidence rather
 * than the endpoint 500ing or silently passing.
 */
export async function collectReleaseEvidence(
  sql: Sql,
  opts: CollectReleaseEvidenceOptions,
): Promise<ReleaseEvidenceBundle> {
  const { generatedAt } = opts;
  const tenantId = opts.tenantId ?? null;
  const live_check_errors: Record<string, string> = {};

  // 1. lifecycle-atomicity — LIVE read-only scan (fail closed on DB error). Scoped to
  //    the requested tenant when given, else the whole operator graph (tenant:%).
  let lifecycleReport: LifecycleAtomicityReport | null = null;
  let lifecycleEvidence: ReleaseGateInput["lifecycleAtomicity"];
  try {
    lifecycleReport = await lifecycleAtomicityReport(sql, { sampleLimit: opts.sampleLimit, tenantId });
    lifecycleEvidence = {
      clean: lifecycleReport.clean,
      total_findings: lifecycleReport.total_findings,
      by_severity: lifecycleReport.by_severity,
    };
  } catch (e) {
    // Fail closed WITHOUT echoing the raw driver message: a postgres/driver error can
    // carry the failing SQL fragment or a connection host:port. Surface a content-free
    // class only and keep the full detail in server logs, mirroring /ops/runtime's
    // unavailableSupercronStatusSnapshot. (Operator-only surface, but no reason to widen
    // it past the curated aggregates the other /ops routes expose.)
    const errName = e instanceof Error && e.name ? e.name : "Error";
    console.error("[release-evidence] lifecycle-atomicity scan failed:", e);
    live_check_errors.lifecycle_atomicity = `atomicity_scan_failed: ${errName}`;
    // No by_severity → the gate fails closed on lifecycle_atomicity (no evidence).
    lifecycleEvidence = { clean: false, total_findings: 0 } as ReleaseGateInput["lifecycleAtomicity"];
  }

  // 2. golden eval — pure, in-process.
  const goldenEval = runEvalSuite(tier2GoldenCases(), { generatedAt });

  // 3. operating-loop proof — pure, in-process. Tenant scope runs the tenant's
  //    namespaced fixture so the proof attests THAT tenant's loop; operator scope
  //    keeps the canonical Tenant-Zero staged fixture.
  const loopInput = tenantId ? buildLoopProofInputForTenant(tenantId) : defaultLoopProofInput();
  const operatingLoop = runLoopProof(loopInput, { generatedAt, profile: opts.profile });

  const verdict = evaluateReleaseGate(
    assembleLiveReleaseGateInput({ operatingLoop, goldenEval, lifecycleAtomicity: lifecycleEvidence }),
    { generatedAt },
  );

  return {
    generated_at: generatedAt,
    mode: "live",
    scope: tenantId ? "tenant" : "operator",
    tenant_id: tenantId,
    verdict,
    live_checks: {
      operating_loop: operatingLoop,
      golden_eval: goldenEval,
      lifecycle_atomicity: lifecycleReport,
    },
    live_check_errors,
    ci_attestation: {
      attestable_in_live_mode: false,
      checks: [...CI_ONLY_CHECKS],
      note: CI_ATTESTATION_NOTE,
    },
  };
}
