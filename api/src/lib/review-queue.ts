/**
 * Semantic Review Queue — the contract that bounds LLM use to high-value review
 * packets (Tier-2 harness-first OS, PR 6: contract-first, NO new table).
 *
 * The plan asks for bounded semantic judgment: instead of broad, expensive LLM
 * scans, VO should select a SMALL set of high-value review candidates
 * deterministically, then hand each to a bounded review that has a budget, a
 * scope, a typed output schema, and a verification path (PR6 acceptance). Per
 * the Tier-2 rule ("classify/normalize OVER existing structures; do NOT add
 * redundant tables") this module adds NO store, NO route, and crucially NO LLM
 * call — it is a PURE, DETERMINISTIC selector + packet contract over candidate
 * sources VO already computes:
 *   - lifecycleAtomicityReport (#62) torn/invariant classes  → stale/conflict
 *   - memory_conflicts rows (getActiveConflicts) + RecallResult.conflicts,
 *     precision-gated by memory-quality's storedConflictHasActionableAnchor
 *     ("contradiction precision")                            → contradiction
 *   - RecallResult.stale + graph edge tensions               → stale / edge quality
 *   - agent-inferred durable facts missing a source_ref       → source promotion
 *
 * It composes the canonical Event Envelope (#60) typed-unknown vocabulary and the
 * operating vocabulary (#61). The four review kinds align with the EXISTING
 * distill_proposals.proposal_kind enum (db/supercron-semantic-audit-packets.sql)
 * via REVIEW_KIND_TO_DISTILL_PROPOSAL_KIND, so a later wiring PR can persist a
 * packet into that ledger (extending the enum additively where needed) rather
 * than forking a new queue. The actual LLM call + budget-spend gating
 * (canSpendLlmCost) are DEFERRED to a later PR; this lib only DESCRIBES the
 * bounded review (scope/budget/output_schema/verification) so the same inputs
 * always yield the same queue.
 */

import { createHash } from "node:crypto";
import { EVENT_UNKNOWN_REASONS, type EventUnknownReason } from "./event-envelope";
import { storedConflictHasActionableAnchor } from "./memory-quality";
import type { AtomicityClassResult } from "./lifecycle-atomicity";

// ── Vocabularies ──────────────────────────────────────────────────────────────

/** The high-value review categories the plan bounds LLM use to (PR6 goal). */
export type ReviewKind =
  | "contradiction_review"
  | "edge_quality_review"
  | "stale_conflict_review"
  | "source_promotion_review";

export const REVIEW_KINDS: readonly ReviewKind[] = [
  "contradiction_review", "edge_quality_review", "stale_conflict_review", "source_promotion_review",
] as const;

/** The existing distill_proposals.proposal_kind enum (the persistence sink). */
export type DistillProposalKind =
  | "duplicate_review"
  | "granularity_review"
  | "orphan_review"
  | "edge_quality_review"
  | "confidence_promotion_review";

export const DISTILL_PROPOSAL_KINDS: readonly DistillProposalKind[] = [
  "duplicate_review", "granularity_review", "orphan_review", "edge_quality_review", "confidence_promotion_review",
] as const;

/**
 * How each ReviewKind maps onto the EXISTING distill_proposals enum. A null means
 * the existing enum has no equivalent yet — persisting that kind needs an additive
 * enum extension (a later wiring PR), NOT a new table. This documents the reuse
 * boundary so we never fork the queue.
 */
export const REVIEW_KIND_TO_DISTILL_PROPOSAL_KIND: Record<ReviewKind, DistillProposalKind | null> = {
  contradiction_review: null,                          // no existing kind — additive extension when persisted
  edge_quality_review: "edge_quality_review",          // exact match
  stale_conflict_review: null,                         // closest existing: orphan_review — additive extension when persisted
  source_promotion_review: "confidence_promotion_review", // aligned (promote agent-inferred → source-backed durable)
};

/** Which existing structure a candidate was selected from. */
export type ReviewCandidateSource =
  | "memory_conflict"      // memory_conflicts row (getActiveConflicts)
  | "recall_conflict"      // RecallResult.conflicts
  | "lifecycle_atomicity"  // lifecycleAtomicityReport class (#62)
  | "reviewable_memory"    // listReviewableMemories item
  | "recall_stale"         // RecallResult.stale
  | "edge_tension";        // graph edge tension (routes/contradictions.ts)

export const REVIEW_CANDIDATE_SOURCES: readonly ReviewCandidateSource[] = [
  "memory_conflict", "recall_conflict", "lifecycle_atomicity", "reviewable_memory", "recall_stale", "edge_tension",
] as const;

export type ReviewSeverity = "high" | "medium" | "low";
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["high", "medium", "low"] as const;

/**
 * Whether a human must sign off before the reviewed change is applied. "auto"
 * is reserved for a future NON-destructive review kind; no current template
 * emits it (every shipped kind defaults to recommended or required), so a packet
 * is "auto" only if a caller explicitly overrides verification.
 */
export type ReviewApproval = "auto" | "recommended" | "required";
export const REVIEW_APPROVALS: readonly ReviewApproval[] = ["auto", "recommended", "required"] as const;

/** Why a candidate did NOT make the queue — surfaced so caps are never silent. */
export type ReviewQueueDropReason =
  | "low_relevance"        // contradiction failed the precision anchor / quality item not promotable
  | "self_healing_drift"   // lifecycle 'drift' class heals next maintenance cycle
  | "duplicate_candidate"  // same logical review (idempotency_key) already admitted
  | "over_kind_cap"        // exceeded the per-kind cap
  | "below_severity_floor"
  | "over_packet_cap"      // exceeded the max-packets count cap
  | "over_budget";         // queue token/cost budget exhausted

export const REVIEW_QUEUE_DROP_REASONS: readonly ReviewQueueDropReason[] = [
  "low_relevance", "self_healing_drift", "duplicate_candidate", "over_kind_cap",
  "below_severity_floor", "over_packet_cap", "over_budget",
] as const;

// ── The four required dimensions of a bounded review (PR6 acceptance) ──────────

/**
 * The bounded set of nodes a single review may read. IDENTIFIER-ONLY (addrs,
 * never content) — upholds lifecycle-atomicity's privacy contract.
 */
export interface ReviewScope {
  /** Owning tenant. Null only with a matching `unknowns.tenant_id` reason. */
  tenant_id: string | null;
  /** The addresses the reviewer may read. Bounded by `max_targets`. */
  target_addrs: string[];
  /** Hard cap on addrs the reviewer may pull — keeps a review from widening. */
  max_targets: number;
}

/**
 * The token/cost ceiling for ONE review. Cost is integer micro-USD per the
 * codebase convention. This lib only DESCRIBES the budget; spend-gating through
 * canSpendLlmCost (supercron-budget-policy.ts) happens when LLM wiring lands.
 */
export interface ReviewBudget {
  max_input_tokens: number;
  max_output_tokens: number;
  est_cost_micro: number;
}

/** A typed descriptor of what the bounded review MUST return — structured, not prose. */
export interface ReviewOutputSchema {
  /** Allowed verdict values the reviewer may return. */
  verdicts: string[];
  /** Required keys in the reviewer's JSON output. */
  required_fields: string[];
}

/** How the reviewer's output is VERIFIED deterministically before it is trusted. */
export interface ReviewVerification {
  /** Ordered deterministic checks to run on the output before acting on it. */
  checks: string[];
  /** Whether a human must approve before the reviewed change is applied. */
  approval: ReviewApproval;
}

// ── The packet ─────────────────────────────────────────────────────────────────

export interface ReviewPacket {
  review_kind: ReviewKind;
  candidate_source: ReviewCandidateSource;
  severity: ReviewSeverity;
  /** Operator-readable selection reason. Identifier-only — never memory content. */
  reason: string;
  scope: ReviewScope;
  budget: ReviewBudget;
  output_schema: ReviewOutputSchema;
  verification: ReviewVerification;
  /** Natural dedup token; cryptographic key via reviewPacketIdempotencyKey(). */
  idempotency_key: string;
  unknowns: {
    tenant_id?: EventUnknownReason;
  };
}

// ── Per-kind review templates ───────────────────────────────────────────────────
//
// Each ReviewKind has a canonical bounded-review spec: a budget, the typed output
// it must return, and the verification path that gates acting on that output.
// Destructive verdicts (retire a memory, drop an edge, pick a contradiction
// winner) default to human approval — the LLM judges, it does not orchestrate.

interface ReviewKindTemplate {
  default_severity: ReviewSeverity;
  budget: ReviewBudget;
  output_schema: ReviewOutputSchema;
  verification: ReviewVerification;
}

export const REVIEW_KIND_TEMPLATES: Record<ReviewKind, ReviewKindTemplate> = {
  contradiction_review: {
    default_severity: "high",
    budget: { max_input_tokens: 1500, max_output_tokens: 400, est_cost_micro: 3000 },
    output_schema: {
      verdicts: ["genuine_contradiction", "not_a_contradiction", "needs_more_evidence"],
      required_fields: ["verdict", "rationale", "winning_addr"],
    },
    verification: {
      checks: [
        "both target addrs are still active (dormant_at IS NULL)",
        "verdict is in the allowed set",
        "winning_addr (when present) is one of the target addrs",
      ],
      approval: "required",
    },
  },
  edge_quality_review: {
    default_severity: "medium",
    budget: { max_input_tokens: 1200, max_output_tokens: 300, est_cost_micro: 2500 },
    output_schema: {
      verdicts: ["keep_edge", "weaken_edge", "drop_edge", "needs_more_evidence"],
      required_fields: ["verdict", "rationale"],
    },
    verification: {
      // drop_edge / weaken_edge mutate the graph, so an edge review is gated like
      // the other destructive kinds — the LLM judges, a human applies.
      checks: [
        "both endpoint addrs still exist",
        "verdict is in the allowed set",
        "no destructive edge change is applied without approval",
      ],
      approval: "required",
    },
  },
  stale_conflict_review: {
    default_severity: "medium",
    budget: { max_input_tokens: 1200, max_output_tokens: 300, est_cost_micro: 2500 },
    output_schema: {
      verdicts: ["still_valid", "retire", "supersede", "needs_more_evidence"],
      required_fields: ["verdict", "rationale"],
    },
    verification: {
      checks: [
        "target addr is still active",
        "verdict is in the allowed set",
        "no destructive transition is applied without approval",
      ],
      approval: "required",
    },
  },
  source_promotion_review: {
    default_severity: "low",
    budget: { max_input_tokens: 1500, max_output_tokens: 400, est_cost_micro: 3000 },
    output_schema: {
      verdicts: ["promote_with_source", "keep_as_is", "reject"],
      required_fields: ["verdict", "rationale", "source_refs"],
    },
    verification: {
      checks: [
        "target addr is still active",
        "verdict is in the allowed set",
        "source_refs is non-empty when verdict is promote_with_source",
      ],
      approval: "recommended",
    },
  },
};

// ── Construction ─────────────────────────────────────────────────────────────────

export interface BuildReviewPacketInput {
  review_kind: ReviewKind;
  candidate_source: ReviewCandidateSource;
  reason: string;
  tenant_id?: string | null;
  target_addrs: string[];
  max_targets?: number;
  severity?: ReviewSeverity;
  budget?: ReviewBudget;
  output_schema?: ReviewOutputSchema;
  verification?: ReviewVerification;
  idempotency_key?: string;
  unknowns?: ReviewPacket["unknowns"];
}

function naturalKey(kind: ReviewKind, addrs: string[]): string {
  // Sort so the same logical target set hashes identically regardless of order.
  return `${kind}:${[...addrs].sort().join("+")}`;
}

/**
 * Build a ReviewPacket, filling budget / output schema / verification from the
 * canonical per-kind template when not supplied, so every packet always carries
 * the four required dimensions. Null tenant gets a default typed reason so the
 * validator passes for a genuinely operator-wide candidate.
 */
export function buildReviewPacket(input: BuildReviewPacketInput): ReviewPacket {
  const template = REVIEW_KIND_TEMPLATES[input.review_kind];
  const tenant_id = input.tenant_id ?? null;
  const target_addrs = input.target_addrs;

  const unknowns: ReviewPacket["unknowns"] = { ...(input.unknowns ?? {}) };
  if (tenant_id === null && unknowns.tenant_id === undefined) unknowns.tenant_id = "not_applicable";

  return {
    review_kind: input.review_kind,
    candidate_source: input.candidate_source,
    severity: input.severity ?? template.default_severity,
    reason: input.reason,
    scope: {
      tenant_id,
      target_addrs,
      // Default to exactly the present target count (clamped) — never pre-widen
      // the scope; a caller must opt in to a larger ceiling.
      max_targets: input.max_targets ?? Math.min(Math.max(target_addrs.length, 1), MAX_REVIEW_TARGETS),
    },
    budget: input.budget ?? template.budget,
    output_schema: input.output_schema ?? template.output_schema,
    verification: input.verification ?? template.verification,
    idempotency_key: input.idempotency_key ?? naturalKey(input.review_kind, target_addrs),
    unknowns,
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────────

function normalizeKeyPart(label: string, value: string): string {
  const trimmed = (value ?? "").normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError(`review-queue ${label} must be a bounded non-empty string without NUL bytes.`);
  }
  return trimmed;
}

/**
 * Deterministic dedup key (sha256 hex) for a packet. Two packets describing the
 * same logical review — same tenant scope, kind, and idempotency token — hash
 * identically. Mirrors workflowRunIdempotencyKey.
 */
export function reviewPacketIdempotencyKey(packet: ReviewPacket): string {
  const scope = packet.scope.tenant_id ? normalizeKeyPart("tenant_id", packet.scope.tenant_id) : "global";
  const kind = normalizeKeyPart("review_kind", packet.review_kind);
  const key = normalizeKeyPart("idempotency_key", packet.idempotency_key);
  const seed = [scope, kind, key].join("\x00");
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────────

export interface ReviewPacketValidation {
  ok: boolean;
  errors: string[];
}

/** Hard ceiling on how many addrs ONE packet may target — enforces "no broad scans". */
export const MAX_REVIEW_TARGETS = 8;

/** A target addr must be a bounded, non-empty, NUL-free string — the same admissibility
 *  the idempotency hasher (normalizeKeyPart) enforces, so validate and hash never disagree. */
function isCleanAddr(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.normalize("NFC").trim();
  return trimmed.length > 0 && !value.includes("\0") && value.length <= 256;
}

/**
 * Validate a packet's contract. Beyond enum/shape checks this enforces the PR6
 * acceptance criteria as INVARIANTS: every packet must carry a bounded scope, a
 * budget, a typed output schema, and a verification path — so a packet that an
 * LLM could act on without one of those four can never validate.
 */
export function validateReviewPacket(packet: ReviewPacket): ReviewPacketValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  inEnum(packet.review_kind, REVIEW_KINDS, "review_kind");
  inEnum(packet.candidate_source, REVIEW_CANDIDATE_SOURCES, "candidate_source");
  inEnum(packet.severity, REVIEW_SEVERITIES, "severity");
  inEnum(packet.verification.approval, REVIEW_APPROVALS, "verification.approval");

  if (!packet.reason) errors.push("reason is required");

  // Scope — bounded, non-empty (acceptance: no broad expensive scans).
  if (!Array.isArray(packet.scope.target_addrs) || packet.scope.target_addrs.length === 0) {
    errors.push("scope.target_addrs must be a non-empty array");
  } else if (packet.scope.target_addrs.length > packet.scope.max_targets) {
    errors.push("scope.target_addrs exceeds scope.max_targets");
  } else if (!packet.scope.target_addrs.every(isCleanAddr)) {
    // A blank/NUL/oversized addr would validate-then-throw at hash time; reject it here.
    errors.push("scope.target_addrs must all be bounded, non-empty, NUL-free strings");
  }
  if (!(packet.scope.max_targets >= 1 && packet.scope.max_targets <= MAX_REVIEW_TARGETS)) {
    errors.push(`scope.max_targets must be between 1 and ${MAX_REVIEW_TARGETS}`);
  }

  // Budget (acceptance: every review has a budget). A review consumes tokens, so it
  // can never declare itself free — est_cost_micro must be strictly positive.
  if (!(packet.budget.max_input_tokens > 0)) errors.push("budget.max_input_tokens must be > 0");
  if (!(packet.budget.max_output_tokens > 0)) errors.push("budget.max_output_tokens must be > 0");
  if (!(packet.budget.est_cost_micro > 0)) errors.push("budget.est_cost_micro must be > 0");

  // Output schema (acceptance: every review has an output schema).
  if (!Array.isArray(packet.output_schema.verdicts) || packet.output_schema.verdicts.length === 0) {
    errors.push("output_schema.verdicts must be a non-empty array");
  }
  if (!Array.isArray(packet.output_schema.required_fields) || packet.output_schema.required_fields.length === 0) {
    errors.push("output_schema.required_fields must be a non-empty array");
  }

  // Verification path (acceptance: every review has a verification path).
  if (!Array.isArray(packet.verification.checks) || packet.verification.checks.length === 0) {
    errors.push("verification.checks must be a non-empty array");
  }

  // tenant_id may be null ONLY with a typed reason.
  if (packet.scope.tenant_id === null) {
    const reason = packet.unknowns?.tenant_id;
    if (!reason) errors.push("scope.tenant_id is null without an unknowns.tenant_id reason");
    else if (!EVENT_UNKNOWN_REASONS.includes(reason)) errors.push(`unknowns.tenant_id "${reason}" is not a valid reason`);
  }

  return { ok: errors.length === 0, errors };
}

// ── Mappers: select candidates from existing structures into packets ──────────────
//
// Each mapper is pure and identifier-only (reasons template addrs, never memory
// content). A mapper returns null when the candidate fails its relevance gate.

const CONFLICT_KIND_BY_TYPE: Record<string, ReviewKind> = {
  contradiction: "contradiction_review",
  supersession_ambiguity: "stale_conflict_review",
  scope_overlap: "stale_conflict_review",
};

/**
 * Map a conflict pair (memory_conflicts row OR RecallResult.conflicts entry).
 * Contradictions are PRECISION-GATED: a contradiction whose stored description
 * carries a weak lexical anchor is dropped (returns null) — this is the plan's
 * "contradiction precision", reusing memory-quality.storedConflictHasActionableAnchor.
 */
export function fromConflict(
  row: { addr_a: string; addr_b: string; conflict_type: string; description?: string | null },
  source: "memory_conflict" | "recall_conflict",
  tenantId: string | null,
): ReviewPacket | null {
  const kind = CONFLICT_KIND_BY_TYPE[row.conflict_type] ?? "stale_conflict_review";
  if (kind === "contradiction_review" && !storedConflictHasActionableAnchor(row.description)) {
    return null; // weak anchor — not a high-precision contradiction
  }
  return buildReviewPacket({
    review_kind: kind,
    candidate_source: source,
    severity: kind === "contradiction_review" ? "high" : "medium",
    reason: `detected ${row.conflict_type} between ${row.addr_a} and ${row.addr_b}`,
    tenant_id: tenantId,
    target_addrs: [row.addr_a, row.addr_b],
  });
}

/**
 * Map one offending address from a lifecycle atomicity class (#62) into a stale/
 * conflict review. 'invariant' (structural) → high, 'torn' (half-applied) →
 * medium. 'drift' classes self-heal and are NOT mapped here (the selector tallies
 * them as a self_healing_drift drop instead).
 */
export function fromAtomicityFinding(cls: AtomicityClassResult, addr: string, tenantId: string | null): ReviewPacket {
  return buildReviewPacket({
    review_kind: "stale_conflict_review",
    candidate_source: "lifecycle_atomicity",
    severity: cls.severity === "invariant" ? "high" : "medium",
    reason: `${cls.class}: ${cls.description}`,
    tenant_id: tenantId,
    target_addrs: [addr],
  });
}

/**
 * Map a reviewable memory (listReviewableMemories item) into a source-promotion
 * review when it is a durable fact lacking a source. Non-promotable quality items
 * (vague / status-digest / test-garbage) are deterministic cleanups, not bounded
 * LLM reviews, so they are dropped (returns null).
 *
 * `source_link_status` (computeSourceLinkStatus) and `durable` are NOT emitted by
 * the raw ReviewableMemoryItem — a caller enriches them. Without enrichment this
 * falls back to the producer's real `review_category` ('likely_durable'), so the
 * mapper never depends on a field a future wiring PR would have to fork in.
 */
export function fromReviewableMemory(
  item: { addr: string; review_category?: string; source_link_status?: string; durable?: boolean; review_quality_reasons?: string[] },
  tenantId: string | null,
): ReviewPacket | null {
  const needsSource = item.source_link_status === "missing";
  const isDurable = item.durable === true || item.review_category === "likely_durable";
  if (!needsSource && !isDurable) return null;
  const reasons = (item.review_quality_reasons ?? []).join(", ");
  return buildReviewPacket({
    review_kind: "source_promotion_review",
    candidate_source: "reviewable_memory",
    severity: needsSource ? "medium" : "low",
    reason: `agent-inferred durable fact needs source-backed promotion${reasons ? ` (${reasons})` : ""}`,
    tenant_id: tenantId,
    target_addrs: [item.addr],
  });
}

/** Map a RecallResult.stale entry into a stale-conflict review (re-verify). */
export function fromRecallStale(s: { addr: string; days_old: number }, tenantId: string | null): ReviewPacket {
  return buildReviewPacket({
    review_kind: "stale_conflict_review",
    candidate_source: "recall_stale",
    severity: s.days_old >= 90 ? "medium" : "low",
    reason: `recall surfaced this memory as ${s.days_old}d stale`,
    tenant_id: tenantId,
    target_addrs: [s.addr],
  });
}

const EDGE_TENSION_KIND: Record<string, ReviewKind> = {
  confidence_divergence: "edge_quality_review",
  capability_overlap: "edge_quality_review",
  staleness_gap: "stale_conflict_review",
  explicit_conflict: "contradiction_review",
  dialectic_tension: "contradiction_review",
};

/** Map a graph edge tension (routes/contradictions.ts row) into an edge-quality/conflict review. */
export function fromEdgeTension(
  t: { type: string; severity?: ReviewSeverity; from_addr: string; to_addr: string },
  tenantId: string | null,
): ReviewPacket {
  const kind = EDGE_TENSION_KIND[t.type] ?? "edge_quality_review";
  // Edge rows come from a DB route — `severity` is typed but untrusted at runtime.
  // Normalize to a known value so it can never produce an undefined rank downstream.
  const severity = REVIEW_SEVERITIES.includes(t.severity as ReviewSeverity)
    ? (t.severity as ReviewSeverity)
    : REVIEW_KIND_TEMPLATES[kind].default_severity;
  return buildReviewPacket({
    review_kind: kind,
    candidate_source: "edge_tension",
    severity,
    reason: `${t.type} (${severity}) between ${t.from_addr} and ${t.to_addr}`,
    tenant_id: tenantId,
    target_addrs: [t.from_addr, t.to_addr],
  });
}

// ── Selector ─────────────────────────────────────────────────────────────────────

export interface ReviewQueueInput {
  tenantId: string | null;
  /** memory_conflicts rows (getActiveConflicts). */
  conflicts?: Array<{ addr_a: string; addr_b: string; conflict_type: string; description?: string | null }>;
  /** RecallResult.conflicts. */
  recallConflicts?: Array<{ addr_a: string; addr_b: string; conflict_type: string; description?: string | null }>;
  /** lifecycleAtomicityReport.classes (#62). */
  atomicity?: AtomicityClassResult[];
  /** listReviewableMemories items. `source_link_status`/`durable` are optional caller
   *  enrichments (not on the raw item); selection falls back to `review_category`. */
  reviewable?: Array<{ addr: string; review_category?: string; source_link_status?: string; durable?: boolean; review_quality_reasons?: string[] }>;
  /** RecallResult.stale. */
  stale?: Array<{ addr: string; days_old: number }>;
  /** Graph edge tensions (routes/contradictions.ts). */
  edges?: Array<{ type: string; severity?: ReviewSeverity; from_addr: string; to_addr: string }>;
}

export interface ReviewQueueOptions {
  /** Caller-supplied snapshot anchor (no clock in pure code). */
  generatedAt: string;
  /** Total micro-USD ceiling for the whole queue. */
  totalBudgetMicro?: number;
  /** Hard cap on admitted packets. */
  maxPackets?: number;
  /** Cap on packets per review kind. */
  perKindCap?: number;
  /** Drop packets below this severity. */
  severityFloor?: ReviewSeverity;
}

export interface ReviewQueueBudget {
  total_micro: number;
  allocated_micro: number;
  packet_count: number;
}

export interface ReviewQueueDrop {
  reason: ReviewQueueDropReason;
  count: number;
}

export interface ReviewQueue {
  tenant_id: string | null;
  generated_at: string;
  packets: ReviewPacket[];
  budget: ReviewQueueBudget;
  /** What was excluded and why — caps are never silent. */
  dropped: ReviewQueueDrop[];
}

// $0.05 ceiling per pass. Kept below DEFAULT_MAX_PACKETS * min-template-cost
// (20 * 2500 = 50_000) so the budget is a REAL default limiter, not inert.
const DEFAULT_QUEUE_BUDGET_MICRO = 50_000;
const DEFAULT_MAX_PACKETS = 20;
const DEFAULT_PER_KIND_CAP = 8;

const SEVERITY_RANK: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_RANK: Record<ReviewCandidateSource, number> = {
  memory_conflict: 0, recall_conflict: 1, lifecycle_atomicity: 2, edge_tension: 3, recall_stale: 4, reviewable_memory: 5,
};

/** Rank a severity with a safe fallback so an unexpected value never yields NaN. */
function severityRank(s: ReviewSeverity): number {
  return SEVERITY_RANK[s] ?? SEVERITY_RANK.low;
}

/** Coerce a numeric option to a finite, non-negative integer (defends caps/budget against NaN/Infinity). */
function finiteOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value as number) ? Math.max(0, Math.trunc(value as number)) : fallback;
}

/**
 * Deterministically select a bounded review queue from candidate sources VO has
 * already computed. PURE — never touches the DB, never calls an LLM, never
 * mutates the input. The selector itself runs NO scan (the caller passes bounded
 * candidate samples), precision-gates contradictions, drops self-healing drift,
 * dedups packets sharing an idempotency key, orders by severity, then admits
 * packets greedily under per-kind / packet-count / total-budget caps — so the
 * same inputs always yield the same queue and the queue cost is always bounded.
 * Every cap that excludes a candidate is tallied in `dropped` (never silent).
 */
export function selectReviewQueue(input: ReviewQueueInput, opts: ReviewQueueOptions): ReviewQueue {
  const totalBudget = finiteOption(opts.totalBudgetMicro, DEFAULT_QUEUE_BUDGET_MICRO);
  const maxPackets = finiteOption(opts.maxPackets, DEFAULT_MAX_PACKETS);
  const perKindCap = finiteOption(opts.perKindCap, DEFAULT_PER_KIND_CAP);
  const severityFloor = opts.severityFloor ?? "low";
  const tenantId = input.tenantId;

  const drops: Record<ReviewQueueDropReason, number> = {
    low_relevance: 0, self_healing_drift: 0, duplicate_candidate: 0, over_kind_cap: 0,
    below_severity_floor: 0, over_packet_cap: 0, over_budget: 0,
  };

  // 1. Map every candidate into a packet (or count a relevance/drift drop).
  const candidates: ReviewPacket[] = [];
  const pushOrDrop = (p: ReviewPacket | null) => {
    if (p) candidates.push(p);
    else drops.low_relevance++;
  };

  for (const c of input.conflicts ?? []) pushOrDrop(fromConflict(c, "memory_conflict", tenantId));
  for (const c of input.recallConflicts ?? []) pushOrDrop(fromConflict(c, "recall_conflict", tenantId));
  for (const cls of input.atomicity ?? []) {
    if (cls.severity === "drift") {
      // Tally the would-be packets (one per sampled addr) so the drift count is in
      // the same candidate-packet unit as every other drop reason — not raw rows.
      drops.self_healing_drift += cls.sample_addrs.length;
      continue;
    }
    for (const addr of cls.sample_addrs) candidates.push(fromAtomicityFinding(cls, addr, tenantId));
  }
  for (const item of input.reviewable ?? []) pushOrDrop(fromReviewableMemory(item, tenantId));
  for (const s of input.stale ?? []) candidates.push(fromRecallStale(s, tenantId));
  for (const e of input.edges ?? []) candidates.push(fromEdgeTension(e, tenantId));

  // 2. Severity floor.
  const floorRank = severityRank(severityFloor);
  const aboveFloor = candidates.filter((p) => {
    if (severityRank(p.severity) <= floorRank) return true;
    drops.below_severity_floor++;
    return false;
  });

  // 3. Stable total order: severity, then source, then idempotency key.
  aboveFloor.sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    const src = SOURCE_RANK[a.candidate_source] - SOURCE_RANK[b.candidate_source];
    if (src !== 0) return src;
    return a.idempotency_key < b.idempotency_key ? -1 : a.idempotency_key > b.idempotency_key ? 1 : 0;
  });

  // 4. Admit greedily; each cap that excludes a packet is tallied distinctly.
  //    Dedup first so a duplicate never consumes a slot, budget, or a cap tally.
  const admitted: ReviewPacket[] = [];
  const seenKeys = new Set<string>();
  const perKind: Record<ReviewKind, number> = {
    contradiction_review: 0, edge_quality_review: 0, stale_conflict_review: 0, source_promotion_review: 0,
  };
  let allocated = 0;
  for (const p of aboveFloor) {
    if (seenKeys.has(p.idempotency_key)) { drops.duplicate_candidate++; continue; }
    if (perKind[p.review_kind] >= perKindCap) { drops.over_kind_cap++; continue; }
    if (admitted.length >= maxPackets) { drops.over_packet_cap++; continue; }
    if (allocated + p.budget.est_cost_micro > totalBudget) { drops.over_budget++; continue; }
    admitted.push(p);
    seenKeys.add(p.idempotency_key);
    perKind[p.review_kind]++;
    allocated += p.budget.est_cost_micro;
  }

  const dropped: ReviewQueueDrop[] = REVIEW_QUEUE_DROP_REASONS
    .filter((r) => drops[r] > 0)
    .map((r) => ({ reason: r, count: drops[r] }));

  return {
    tenant_id: tenantId,
    generated_at: opts.generatedAt,
    packets: admitted,
    budget: { total_micro: totalBudget, allocated_micro: allocated, packet_count: admitted.length },
    dropped,
  };
}
