/**
 * Operating-loop proof — the deterministic end-to-end proof that VO's Tenant-Zero
 * operating loop wires together (Tier-2 harness-first OS, PR 11 / CAPSTONE part 1:
 * contract-first, NO new table).
 *
 * The loop is: CAPTURE (#60 event-envelope) -> CLASSIFY (#61 knowledge-vocabulary)
 * -> ROUTE (domain intent) -> RECALL (recall-compiler) -> ACTION-PACKET (#63) ->
 * REVIEW (#65 review-queue) -> WORKFLOW-RUN (#64) -> NEEDS-ATTENTION (#66). Eight of
 * those stages are PURE; only RECALL and ROUTE are DB-bound (compileRecall(sql) /
 * routedRecall(sql) embed a query and score live nodes). So this module is a PURE,
 * DETERMINISTIC composition over the pure primitives that takes the two upstream,
 * DB-bound results (the routed intent + the RecallResult) as STAGED inputs — exactly
 * as #68's eval-harness stages a RecallResult fixture. It runs the downstream pure
 * chain, threads each stage's output into the next, and proves not just that each
 * stage RUNS but that the loop is WIRED (the action packet derives from the recall;
 * the review queue is built from the recall's conflicts/stale; needs-attention
 * surfaces the review packets and the workflow run).
 *
 * Per the Tier-2 rule it adds NO store, NO route, NO LLM call. The live daily-loop
 * proof COMMAND (a later capstone part) gathers the real upstream results
 * (classifyIntent(query) + compileRecall(sql, query)) and the real ledger rows, then
 * calls runLoopProof — so the same proof contract covers both the CI fixture and the
 * live run. It composes #10 policy-profile so one posture drives every stage.
 */

import { buildEventEnvelope, validateEventEnvelope, type BuildEventEnvelopeInput } from "./event-envelope";
import { assessOperatingFact, type OperatingFactInput } from "./knowledge-vocabulary";
import { toActionPacket } from "./action-packet";
import { selectReviewQueue, validateReviewPacket, type ReviewQueue, type ReviewQueueInput } from "./review-queue";
import { buildWorkflowRun, validateWorkflowRun, type BuildWorkflowRunInput } from "./workflow-run";
import { aggregateAttention, validateAttentionItem } from "./needs-attention";
import { resolvePolicyProfile } from "./policy-profile";
import { resolveFederationMetadata } from "./federated-memory";
import type { RecallResult, RecalledMemory } from "./recall-compiler";
import type { DomainIntent } from "./domain-router";

// ── Vocabularies ──────────────────────────────────────────────────────────────

/** The ordered stages of the operating loop. */
export type LoopStage =
  | "capture" | "classify" | "route" | "recall"
  | "action_packet" | "review" | "workflow_run" | "needs_attention";
export const LOOP_STAGES: readonly LoopStage[] = [
  "capture", "classify", "route", "recall", "action_packet", "review", "workflow_run", "needs_attention",
] as const;

/** Routed intent — mirrors domain-router's DomainIntent (kept as a value list so the
 *  proof can validate a staged route without importing the DB-bound router). */
export type LoopRouteIntent = "ops" | "rollout" | "workspace" | "mixed" | "unknown";
export const LOOP_ROUTE_INTENTS: readonly LoopRouteIntent[] = ["ops", "rollout", "workspace", "mixed", "unknown"] as const;

// Type-level drift guard: LoopRouteIntent must stay exactly in sync with the
// domain-router's DomainIntent (we mirror the value list to avoid importing the
// DB-bound router). If either side adds/removes a member, this stops compiling.
type _RouteIntentsInSync =
  [LoopRouteIntent] extends [DomainIntent] ? ([DomainIntent] extends [LoopRouteIntent] ? true : never) : never;
const _routeIntentDriftGuard: _RouteIntentsInSync = true;
void _routeIntentDriftGuard;

// ── Result ──────────────────────────────────────────────────────────────────────

export interface LoopStageResult {
  stage: LoopStage;
  /** The stage ran and yielded an artifact (false = it threw). */
  produced: boolean;
  /** The artifact is valid / the stage's contract held. */
  ok: boolean;
  detail: string;
}

export interface LoopProof {
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generated_at: string;
  tenant_id: string | null;
  stages: LoopStageResult[];
  /** The cross-stage connections hold (packet⟵recall, needs-attention⟵review/run). */
  wired: boolean;
  /** Every stage produced + ok AND the loop is wired. */
  ok: boolean;
}

// ── Input ─────────────────────────────────────────────────────────────────────

export interface LoopProofInput {
  tenantId: string | null;
  capture: BuildEventEnvelopeInput;
  classify: OperatingFactInput;
  /** Staged routed intent (live: classifyIntent(query).intent). */
  route: LoopRouteIntent;
  /** Staged recall (live: compileRecall(sql, query)). */
  recall: RecallResult;
  /** A representative routed run for the WORKFLOW-RUN stage. */
  workflowRun: BuildWorkflowRunInput;
}

export interface LoopProofOptions {
  generatedAt: string;
  /** A policy-profile name (#10) whose knobs drive review + needs-attention. */
  profile?: string;
}

// ── Runner ─────────────────────────────────────────────────────────────────────

const errMsg = (e: unknown): string => `threw: ${e instanceof Error ? e.message : String(e)}`;
const RUN_ATTENTION_STATUSES = new Set(["failed", "rejected", "expired"]);

/**
 * Run the operating-loop proof. PURE and deterministic — never touches the DB,
 * never calls an LLM, never mutates the input. Each pure stage runs (a throwing
 * stage is recorded produced:false, never crashes the proof); the staged upstream
 * stages (route, recall) are validated; and `wired` asserts the cross-stage
 * connections so the proof fails if the loop is merely a set of independent
 * stages rather than a connected chain. Same inputs always yield the same proof.
 */
export function runLoopProof(input: LoopProofInput, opts: LoopProofOptions): LoopProof {
  const policy = resolvePolicyProfile(opts.profile ?? "balanced");
  const stages: LoopStageResult[] = [];
  const push = (stage: LoopStage, produced: boolean, ok: boolean, detail: string) =>
    stages.push({ stage, produced, ok, detail });

  // 1. CAPTURE — normalize raw intake into a canonical event envelope.
  try {
    const env = buildEventEnvelope(input.capture);
    const v = validateEventEnvelope(env);
    push("capture", true, v.ok, v.ok ? `envelope ${env.event_type}` : v.errors.join("; "));
  } catch (e) { push("capture", false, false, errMsg(e)); }

  // 2. CLASSIFY — assign the operating class of the captured fact.
  try {
    const a = assessOperatingFact(input.classify);
    push("classify", true, Boolean(a.operating_class), `operating_class=${a.operating_class} durable=${a.durable}`);
  } catch (e) { push("classify", false, false, errMsg(e)); }

  // 3. ROUTE — staged routed intent (live: classifyIntent).
  const routeOk = (LOOP_ROUTE_INTENTS as readonly string[]).includes(input.route);
  push("route", input.route != null, routeOk, `intent=${input.route}`);

  // 4. RECALL — staged RecallResult (live: compileRecall(sql)).
  const recallOk = Boolean(input.recall && input.recall.recall_id);
  push("recall", input.recall != null, recallOk, recallOk ? `recall_id=${input.recall.recall_id} posture=${input.recall.explanation?.posture}` : "missing recall_id");

  // 5. ACTION-PACKET — reshape the recall into an operational packet. The wiring
  // check verifies DERIVED invariants (not just the copied recall_id, which is
  // tautological): the packet's primary presence + confidence must come from THIS
  // recall, so a refactor that threaded the wrong recall here would fail.
  let packetDerived = false;
  try {
    const pkt = toActionPacket(input.recall, { tenantId: input.tenantId });
    // MT2: every project_addr the packet scopes to must come from THIS recall's memories (not a
    // tautology — a packet threading a foreign recall's projects would fail), and the packet must be
    // stamped for this tenant.
    const recallProjectAddrs = new Set(
      [...input.recall.primary_memories, ...input.recall.supporting_memories]
        .map((m) => m.project_addr).filter((a): a is string => a != null),
    );
    const packetProjectsFromRecall = pkt.tenant_scope.project_addrs.every((a) => recallProjectAddrs.has(a));
    packetDerived = pkt.recall_id === input.recall.recall_id
      && pkt.has_primary === (input.recall.primary_memories.length > 0)
      && pkt.confidence === input.recall.confidence
      && pkt.tenant_scope.tenant_id === input.tenantId
      && packetProjectsFromRecall;
    push("action_packet", true, packetDerived, packetDerived ? `derived from recall (tenant ${pkt.tenant_scope.tenant_id}); approval=${pkt.required_approval} risk=${pkt.risk_level}` : "packet not derived from / bound to the recall's tenant");
  } catch (e) { push("action_packet", false, false, errMsg(e)); }

  // 6. REVIEW — bound review queue from the recall's conflicts/stale candidates.
  //    recall.conflicts are RecallResult conflicts -> the recallConflicts field
  //    (tagged candidate_source "recall_conflict"), NOT the memory_conflicts field.
  let reviewQueue: ReviewQueue | null = null;
  try {
    const rqInput: ReviewQueueInput = { tenantId: input.tenantId, recallConflicts: input.recall.conflicts, stale: input.recall.stale };
    reviewQueue = selectReviewQueue(rqInput, { generatedAt: opts.generatedAt, ...policy.review_queue });
    const ok = reviewQueue.packets.every((p) => validateReviewPacket(p).ok);
    push("review", true, ok, `${reviewQueue.packets.length} packets; dropped ${reviewQueue.dropped.map((d) => d.reason).join(",") || "none"}`);
  } catch (e) { push("review", false, false, errMsg(e)); }

  // 7. WORKFLOW-RUN — normalize the routed action into one inspectable run.
  let runStatus: string | null = null;
  let runApproval: string | null = null;
  let workflowRunObj: ReturnType<typeof buildWorkflowRun> | null = null;
  try {
    workflowRunObj = buildWorkflowRun(input.workflowRun);
    runStatus = workflowRunObj.status;
    runApproval = workflowRunObj.approval_state;
    const v = validateWorkflowRun(workflowRunObj);
    push("workflow_run", true, v.ok, v.ok ? `status=${workflowRunObj.status} approval=${workflowRunObj.approval_state}` : v.errors.join("; "));
  } catch (e) { push("workflow_run", false, false, errMsg(e)); }

  const recallPosture = input.recall.explanation?.posture ?? "unknown";

  // 8. NEEDS-ATTENTION — the REAL operator surface, filtered by the selected posture.
  try {
    const na = aggregateAttention(
      { tenantId: input.tenantId, reviewQueue: reviewQueue ?? undefined, workflowRuns: workflowRunObj ? [workflowRunObj] : [], recall: { posture: recallPosture } },
      { generatedAt: opts.generatedAt, ...policy.needs_attention },
    );
    const ok = na.items.every((i) => validateAttentionItem(i).ok);
    push("needs_attention", true, ok, `${na.items.length} items (profile ${opts.profile ?? "balanced"})`);
  } catch (e) { push("needs_attention", false, false, errMsg(e)); }

  // ── Wiring: the loop is a connected chain, not independent stages ───────────
  // Composition is checked at a NEUTRAL floor (posture-independent): "wired" asks
  // whether needs-attention COMPOSES the review queue + the run at all — a tighter
  // policy posture legitimately filtering them from the operator surface is correct
  // behavior, not a broken link.
  let wiringSources: string[] = [];
  try {
    const wiringNa = aggregateAttention(
      { tenantId: input.tenantId, reviewQueue: reviewQueue ?? undefined, workflowRuns: workflowRunObj ? [workflowRunObj] : [], recall: { posture: recallPosture } },
      { generatedAt: opts.generatedAt, severityFloor: "low", maxItems: 10_000 },
    );
    wiringSources = wiringNa.items.map((i) => i.source);
  } catch { wiringSources = []; }

  const packetWired = packetDerived;
  const reviewToAttention = reviewQueue !== null && (reviewQueue.packets.length === 0 || wiringSources.includes("review_queue"));
  const runNeedsAttention = runStatus !== null && (RUN_ATTENTION_STATUSES.has(runStatus) || runApproval === "pending");
  const runToAttention = !runNeedsAttention || wiringSources.includes("workflow_run");
  const wired = packetWired && reviewToAttention && runToAttention;

  const ok = stages.every((s) => s.produced && s.ok) && wired;
  return { generated_at: opts.generatedAt, tenant_id: input.tenantId, stages, wired, ok };
}

// ── Canonical staged fixture ────────────────────────────────────────────────────

const FIXTURE_AT = "2026-01-01T00:00:00.000Z";

/**
 * A self-contained staged loop input that exercises every wiring link: a durable
 * decision recall with a strong-anchor contradiction (so review produces a packet)
 * and a failed routed run (so needs-attention surfaces a workflow_run item). The CI
 * drift pin runs `runLoopProof(defaultLoopProofInput(), { generatedAt })` and expects
 * ok:true / wired:true. The live command swaps in real route + recall + ledger rows.
 */
export function defaultLoopProofInput(): LoopProofInput {
  const primary: RecalledMemory = {
    addr: "PJ.0.3.100", label: "model routing decision", kind: "decision", source: "user_accepted",
    assertion: "Default to gemini-3.1-pro for complex coding.", why_it_matters: "model routing",
    relevance: 0.9, freshness: 0.9, provenance_score: 1.0, conflict_free: true, composite_score: 0.9,
    created_at: "2026-05-01T00:00:00Z", effective_at: "2026-05-01T00:00:00Z", superseded_by: null,
    status: "active", federation: resolveFederationMetadata(null), project_addr: null, project_label: null,
    explanation: { why_recalled: "high relevance + user-accepted", lifecycle_note: null, provenance_label: "user-accepted" },
  };
  const recall: RecallResult = {
    recall_id: "rcl_loop_1", primary_memories: [primary], supporting_memories: [], changes_since: [],
    conflicts: [{ addr_a: "PJ.0.3.1", addr_b: "PJ.0.3.2", conflict_type: "contradiction", description: "jaccard=0.5, shared_terms=alpha|beta|gamma" }],
    stale: [{ addr: "PJ.0.3.9", label: "stale note", days_old: 200 }],
    fresh_research_needed: null,
    confidence: { relevance: "high", freshness: "high", provenance: "high", conflict_free: "medium", summary: "strong" },
    next_move: "Apply the decision.", error_recovered: false, recovery_reason: null,
    explanation: { candidates_scored: 5, excluded_count: 0, excluded_reasons: [], posture: "memory_backed", posture_note: "memory-backed", routing_method: "semantic", routed_family: null },
  };
  return {
    tenantId: "t1",
    capture: {
      source_kind: "mcp_write_intent", source_label: "loop-proof", event_type: "memory.write_intent",
      tenant_id: "t1", idempotency_key: "loop-capture-1",
    } as BuildEventEnvelopeInput,
    classify: { kind: "decision", source: "user_accepted", effective_at: FIXTURE_AT },
    route: "ops",
    recall,
    workflowRun: {
      run_id: "loop-run-1", source_ledger: "remote_commands", kind: "apply_edit",
      status: "failed", tenant_id: "t1", started_at: FIXTURE_AT, ended_at: FIXTURE_AT, outcome: { class: "failure" },
    },
  };
}

/**
 * Build a tenant-scoped loop proof input (MT2). Same shape as the staged fixture, but EVERY
 * tenant-bearing field is namespaced to `tenantId` (capture.tenant_id, workflowRun.tenant_id, the
 * recall_id + memory project_label), so a non-Tenant-Zero tenant's proof carries only its own
 * identifiers. Optionally takes a LIVE `route` (classifyIntent(query).intent) and `recall`
 * (compileRecall(sql, query)) — when omitted, the staged fixture is namespaced. This is what the
 * --live command and the productization proof use instead of the hardcoded t1 fixture.
 */
export function buildLoopProofInputForTenant(
  tenantId: string,
  opts: { route?: LoopRouteIntent; recall?: RecallResult } = {},
): LoopProofInput {
  const base = defaultLoopProofInput();
  return {
    tenantId,
    capture: { ...base.capture, tenant_id: tenantId, idempotency_key: `loop-capture-${tenantId}` },
    classify: base.classify,
    route: opts.route ?? base.route,
    recall: opts.recall ?? namespaceFixtureRecallForTenant(base.recall, tenantId),
    workflowRun: { ...base.workflowRun, tenant_id: tenantId, run_id: `loop-run-${tenantId}` },
  };
}

// Namespace the STAGED fixture recall to a tenant (a fresh recall_id + tenant-tagged project_label),
// so tenant A's staged proof carries only A's identifiers and the MT4 isolation check can assert A's
// proof contains no B token. A live compileRecall recall is already tenant-scoped and passes through.
function namespaceFixtureRecallForTenant(recall: RecallResult, tenantId: string): RecallResult {
  const tag = (addr: string) => `${tenantId}:${addr}`;
  return {
    ...recall,
    recall_id: `rcl_${tenantId}`,
    primary_memories: recall.primary_memories.map((m) => ({ ...m, project_label: `${tenantId}-project` })),
    // namespace the conflict + stale candidates too, so EVERY identifier in a tenant's staged proof
    // is tenant-distinct (the MT4 exact-leaf isolation check then proves A's proof carries no B marker).
    conflicts: recall.conflicts.map((c) => ({
      ...c,
      addr_a: tag(c.addr_a),
      addr_b: tag(c.addr_b),
      description: c.description ? `${tenantId}: ${c.description}` : c.description,
    })),
    stale: recall.stale.map((s) => ({ ...s, addr: tag(s.addr), label: `${tenantId} ${s.label}` })),
  };
}

/**
 * Assert a loop proof input is internally tenant-consistent (MT2): the deterministic tenant-bearing
 * fields (capture.tenant_id, workflowRun.tenant_id) all name `input.tenantId`. Returns the foreign
 * references found — non-empty means the input MIXES tenants (e.g. the prior --live bug spread a t1
 * capture onto a t2 proof). The productization proof (MT4) uses this to FAIL a Tenant-A proof that
 * references Tenant-B. (The recall is tenant-scoped by construction — compileRecall(tenantId) or the
 * namespaced fixture — and the whole-proof substring check in MT4 catches any deeper reference.)
 */
export function loopProofInputTenantBound(input: LoopProofInput): { ok: boolean; foreign: string[] } {
  const foreign: string[] = [];
  if (input.capture.tenant_id !== input.tenantId) foreign.push(`capture.tenant_id=${input.capture.tenant_id}`);
  if (input.workflowRun.tenant_id !== input.tenantId) foreign.push(`workflowRun.tenant_id=${input.workflowRun.tenant_id}`);
  return { ok: foreign.length === 0, foreign };
}
