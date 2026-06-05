/**
 * Claim / Evidence / Decision operating vocabulary (Tier-2 PR2).
 *
 * The plan asks for claim, evidence, and decision to be DISTINCT first-class
 * concepts. VO's memory contract (./memory-contract.ts) already carries the
 * substrate — kinds, per-kind source-ref requirements, lifecycle statuses,
 * supersession, effective_at, scope, source posture — so per the plan's rule
 * ("if existing memory nodes already represent these, add explicit metadata
 * classification and validators rather than creating redundant tables") this
 * module is a thin, ADDITIVE classification + validation layer over the memory
 * contract. It introduces no new table and changes no write path: it lets the
 * higher Tier-2 surfaces (action packets, Needs-Attention dashboard, semantic
 * review queue) reason about durable operating facts as claims/decisions.
 *
 *   Event    — something happened          (api/src/lib/event-envelope.ts)
 *   Evidence — why a claim exists           (a source_ref with capture provenance)
 *   Claim    — a specific extracted assertion
 *   Decision — accepted operational policy/direction/preference/correction
 */

import {
  computeSourceLinkStatus,
  type MemoryKind,
  type SourceKind,
  type SourceRef,
} from "./memory-contract";

// ── Operating class ──────────────────────────────────────────────────────────

/**
 * The operating role a durable memory plays. This is the claim/decision framing
 * the higher surfaces care about, derived from the memory's `kind`.
 */
export type OperatingClass = "claim" | "decision" | "correction" | "preference" | "transient";

export const MEMORY_KIND_TO_OPERATING_CLASS: Record<MemoryKind, OperatingClass> = {
  decision: "decision",
  correction: "correction",
  preference: "preference",
  context: "claim",
  pattern: "claim",
  vision: "claim",
  changelog: "transient",
  digest: "transient",
};

export function classifyMemoryKind(kind: MemoryKind): OperatingClass {
  return MEMORY_KIND_TO_OPERATING_CLASS[kind];
}

/**
 * Operating classes whose facts are durable policy/direction. They must be
 * traceable (source-backed or explicitly user-asserted) and supersedable, and
 * must never enter the graph as an untyped generic memory.
 */
export const DURABLE_OPERATING_CLASSES: readonly OperatingClass[] = ["decision", "correction"] as const;

export function isDurableOperatingClass(c: OperatingClass): boolean {
  return DURABLE_OPERATING_CLASSES.includes(c);
}

// ── Support posture ──────────────────────────────────────────────────────────

/** How well-supported a fact's provenance is. */
export type SupportPosture = "source_backed" | "user_asserted" | "agent_generated" | "unsupported";

export function supportPosture(input: { source: SourceKind; source_refs?: SourceRef[] | null }): SupportPosture {
  if (input.source_refs && input.source_refs.length > 0) return "source_backed";
  switch (input.source) {
    case "user_accepted":
    case "agent_corrected":
      return "user_asserted";
    case "agent_inferred":
    case "system_generated":
      return "agent_generated";
    default:
      return "unsupported";
  }
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Evidence = a source_ref with capture provenance. Extends the memory contract's
 * SourceRef (path/url/type) with the capture hash + timestamp the plan requires
 * ("evidence must have source kind and capture hash/path/URL when available").
 */
export interface EvidenceRef extends SourceRef {
  capture_hash?: string | null;
  captured_at?: string | null;
}

export type EvidenceFreshness = "current" | "stale" | "inaccessible";

/** Build an EvidenceRef from a SourceRef plus optional capture provenance. */
export function evidenceFromSourceRef(
  ref: SourceRef,
  capture?: { hash?: string | null; captured_at?: string | null },
): EvidenceRef {
  return { ...ref, capture_hash: capture?.hash ?? null, captured_at: capture?.captured_at ?? null };
}

// ── Assessment ────────────────────────────────────────────────────────────────

/** The fields of a memory write this layer reasons about. */
export interface OperatingFactInput {
  kind: MemoryKind;
  source: SourceKind;
  source_refs?: SourceRef[] | null;
  effective_at?: string | null;
  supersedes?: string | null;
  scope?: string | null;
}

export interface OperatingFactAssessment {
  operating_class: OperatingClass;
  posture: SupportPosture;
  durable: boolean;
  /** Contract violations — a caller enforcing the vocabulary should reject these. */
  issues: string[];
  /** Softer concerns that weaken downstream trust/recall but do not block. */
  warnings: string[];
}

/**
 * Assess a memory write against the operating vocabulary. Advisory by design
 * (returns issues/warnings; never throws, never mutates) so it can be layered
 * onto the existing write path without changing behavior. Source-ref
 * requirements reuse the memory contract's computeSourceLinkStatus so there is
 * one source of truth for which kinds need a source.
 */
export function assessOperatingFact(input: OperatingFactInput): OperatingFactAssessment {
  const operating_class = classifyMemoryKind(input.kind);
  const posture = supportPosture(input);
  const durable = isDurableOperatingClass(operating_class);
  const issues: string[] = [];
  const warnings: string[] = [];

  // Source-ref requirement — delegated to the canonical memory contract.
  if (computeSourceLinkStatus(input.kind, input.source_refs ?? null) === "missing") {
    issues.push(
      `a ${operating_class} of kind "${input.kind}" requires a source_ref (or reclassify it as a kind that does not)`,
    );
  }

  // A durable operating fact must not be silently agent-generated with no
  // backing — it must be source-backed or user-asserted.
  if (durable && posture === "agent_generated") {
    issues.push(
      `a ${operating_class} must be source-backed or user-asserted, not silently agent-generated`,
    );
  }

  // Decisions need effective_at + scope so staleness/supersession reasoning works.
  if (operating_class === "decision") {
    if (!input.effective_at) warnings.push("decision has no effective_at; staleness/supersession reasoning will be weaker");
    if (!input.scope) warnings.push("decision has no scope; downstream will default it to tenant");
  }

  return { operating_class, posture, durable, issues, warnings };
}

/**
 * The plan's guard: an agent cannot silently write a durable decision as an
 * untyped generic memory. A write filed under a non-durable kind (claim/
 * transient, e.g. "context") that nonetheless carries decision signals —
 * `supersedes` or `effective_at` set, with a user-accepted source — is
 * misclassified and should be a decision/correction. Returns a message to
 * surface, or null if the write is fine.
 */
export function flagUntypedDurableFact(input: OperatingFactInput): string | null {
  const operating_class = classifyMemoryKind(input.kind);
  if (isDurableOperatingClass(operating_class)) return null; // already a durable kind
  const carriesDecisionSignals = Boolean(input.supersedes) || Boolean(input.effective_at);
  if (carriesDecisionSignals && input.source === "user_accepted") {
    return `write filed as "${input.kind}" carries decision signals (supersedes/effective_at + user_accepted) — classify it as a "decision" or "correction", not "${input.kind}"`;
  }
  return null;
}
