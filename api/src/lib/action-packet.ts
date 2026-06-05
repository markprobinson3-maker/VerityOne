/**
 * Action Packet recall v1 (Tier-2 PR4).
 *
 * The plan asks recall to return an OPERATIONAL packet — "what an agent/person
 * should do next" — not just a ranked memory list (§6 Action Packet; PR4). VO's
 * recall compiler (./recall-compiler.ts) already does the hard part: it scores
 * candidates, detects conflicts, computes freshness/provenance, picks a primary
 * vs supporting split, and derives a `next_move` and `confidence`. So per the
 * Tier-2 rule ("classify/normalize OVER existing structures; do NOT add
 * redundant tables") this module is a thin, PURE, DETERMINISTIC adapter that
 * re-shapes a `RecallResult` into the packet the higher Harness-OS loop consumes.
 *
 * It adds NO store, NO route, NO write path, and crucially NO LLM call — the
 * packet is assembled by deterministic rules over fields recall already
 * produced (per the plan's "don't make the LLM the orchestrator"). It composes
 * the Tier-2 operating vocabulary (./knowledge-vocabulary.ts) so a durable
 * decision/correction raises the approval bar before an agent acts on it.
 */

import type { RecallConfidence, RecallResult, RecalledMemory } from "./recall-compiler";
import { classifyMemoryKind, isDurableOperatingClass, type OperatingClass } from "./knowledge-vocabulary";
import { MEMORY_KINDS, type MemoryKind } from "./memory-contract";

export type RiskLevel = "low" | "medium" | "high";

/** Human-approval posture before an agent acts: none (no sign-off), recommended
 *  (advisory), or required (mandatory sign-off). */
export type ApprovalState = "none" | "recommended" | "required";

export interface ActionPacketEvidence {
  addr: string;
  label: string;
  kind: string;
  assertion: string;
  /** Plain-terms provenance from recall (e.g. "user-accepted", "agent-inferred"). */
  provenance_label: string;
  relevance: number;
}

export type WarningKind = "conflict" | "stale" | "superseded" | "lifecycle";

export interface ActionPacketWarning {
  kind: WarningKind;
  detail: string;
  addrs: string[];
}

export interface ActionPacket {
  /** False when recall surfaced no usable primary memory (research-needed). */
  has_primary: boolean;
  /** What to act on, assembled from the primary memory (deterministic, no LLM). */
  primary_instruction: string;
  primary_addr: string | null;
  /** The operating class of the primary memory (#61), or null if no primary. */
  operating_class: OperatingClass | null;
  supporting_evidence: ActionPacketEvidence[];
  conflicts_warnings: ActionPacketWarning[];
  freshness_note: string;
  risk_level: RiskLevel;
  required_approval: ApprovalState;
  /** Derived verification steps (NOT invented criteria) the actor should meet. */
  acceptance_criteria: string[];
  confidence: RecallConfidence;
  /** Recall's recommended next move, passed through verbatim (may be null). */
  next_recommended_action: string | null;
  /** Passed through so later /signal/recall outcome feedback can attach. */
  recall_id: string;
  /** Tenant scope of this packet (MT2): the tenant it was built for + the distinct project_addrs of
   *  the memories it draws on. Lets a forwarded/cached packet stay tenant-bound and lets callers
   *  validate the packet belongs to the expected tenant (no cross-tenant action). */
  tenant_scope: {
    tenant_id: string | null;
    project_addrs: string[];
  };
}

export interface ActionPacketOptions {
  /** Cap on supporting evidence entries carried into the packet (default 8). */
  maxEvidence?: number;
  /** The tenant this packet is built for (MT2). Stamped into tenant_scope.tenant_id; the route
   *  supplies the authenticated tenant so the packet is self-describing about its scope. */
  tenantId?: string | null;
}

function operatingClassOf(kind: string): OperatingClass | null {
  return MEMORY_KINDS.includes(kind as MemoryKind) ? classifyMemoryKind(kind as MemoryKind) : null;
}

function toEvidence(m: RecalledMemory): ActionPacketEvidence {
  return {
    addr: m.addr,
    label: m.label,
    kind: m.kind,
    assertion: m.assertion,
    provenance_label: m.explanation?.provenance_label ?? m.source,
    relevance: m.relevance,
  };
}

function collectWarnings(result: RecallResult, primary: RecalledMemory | null): ActionPacketWarning[] {
  const warnings: ActionPacketWarning[] = [];

  for (const c of result.conflicts) {
    warnings.push({
      kind: "conflict",
      detail: c.description ?? `${c.conflict_type} conflict`,
      addrs: [c.addr_a, c.addr_b],
    });
  }

  for (const s of result.stale) {
    warnings.push({
      kind: "stale",
      detail: `"${s.label}" is ${s.days_old}d old`,
      addrs: [s.addr],
    });
  }

  if (primary) {
    if (primary.superseded_by) {
      warnings.push({
        kind: "superseded",
        detail: `primary memory has been superseded by ${primary.superseded_by}`,
        addrs: [primary.addr, primary.superseded_by],
      });
    } else if (primary.status !== "active") {
      warnings.push({
        kind: "lifecycle",
        detail: `primary memory status is "${primary.status}", not active`,
        addrs: [primary.addr],
      });
    } else if (primary.explanation?.lifecycle_note) {
      warnings.push({
        kind: "lifecycle",
        detail: primary.explanation.lifecycle_note,
        addrs: [primary.addr],
      });
    } else if (!primary.conflict_free) {
      // Recall flagged the primary not conflict-free without a superseded/
      // lifecycle reason — surface it so the high risk it drives carries a why.
      warnings.push({
        kind: "conflict",
        detail: "primary memory is flagged not conflict-free",
        addrs: [primary.addr],
      });
    }
  }

  return warnings;
}

function freshnessNote(result: RecallResult): string {
  if (result.fresh_research_needed) return result.fresh_research_needed;
  if (result.stale.length > 0) {
    // result.stale is the packet-wide stale set, not only supporting memories.
    return `${result.stale.length} memory(ies) are stale; confirm they still hold.`;
  }
  return `Freshness: ${result.confidence.freshness}.`;
}

function riskLevel(
  result: RecallResult,
  primary: RecalledMemory | null,
): RiskLevel {
  const conf = result.confidence;
  const posture = result.explanation?.posture;

  const high =
    result.conflicts.length > 0 ||
    conf.conflict_free === "low" ||
    posture === "research_needed" ||
    posture === "degraded" ||
    (primary != null && (!primary.conflict_free || primary.status !== "active" || primary.superseded_by != null));
  if (high) return "high";

  const medium =
    conf.relevance === "low" ||
    conf.freshness === "low" ||
    conf.provenance === "low" ||
    conf.conflict_free === "medium" ||
    result.stale.length > 0 ||
    posture === "partial_memory";
  if (medium) return "medium";

  return "low";
}

function requiredApproval(risk: RiskLevel, operatingClass: OperatingClass | null): ApprovalState {
  const durable = operatingClass != null && isDurableOperatingClass(operatingClass);
  if (durable && risk === "high") return "required";
  if (durable || risk !== "low") return "recommended";
  return "none";
}

function acceptanceCriteria(
  result: RecallResult,
  primary: RecalledMemory | null,
  approval: ApprovalState,
): string[] {
  const criteria: string[] = [];
  if (primary) {
    criteria.push("Confirm the primary memory still reflects current state before acting.");
    criteria.push("Re-check the memory's source/provenance before relying on it.");
  } else {
    criteria.push("No primary memory was recalled — gather fresh evidence before acting.");
  }
  if (result.conflicts.length > 0) {
    criteria.push("Resolve the flagged conflict(s) before acting on the primary.");
  }
  if (result.stale.length > 0) {
    criteria.push("Refresh or revalidate the stale memory(ies).");
  }
  if (approval !== "none") {
    criteria.push(`Obtain ${approval} approval before executing.`);
  }
  return criteria;
}

function primaryInstruction(result: RecallResult, primary: RecalledMemory | null): string {
  if (!primary) {
    const note = result.explanation?.posture_note;
    return note
      ? `No actionable memory recalled — ${note}`
      : "No actionable memory recalled — treat as research-needed.";
  }
  return primary.assertion;
}

/**
 * Adapt a `RecallResult` into an operational ActionPacket. Pure and
 * deterministic — never touches the DB, never calls an LLM, never mutates the
 * input. Every field is derived by fixed rules from what recall already
 * produced, so the same recall always yields the same packet.
 */
export function toActionPacket(result: RecallResult, opts: ActionPacketOptions = {}): ActionPacket {
  const maxEvidence = Math.max(0, Math.trunc(opts.maxEvidence ?? 8));
  // primary_memories[0] = recall's top-ranked primary; we inherit recall's rank
  // order and never re-sort, so the packet stays deterministic with recall.
  const primary = result.primary_memories[0] ?? null;
  const operating_class = primary ? operatingClassOf(primary.kind) : null;

  const supporting_evidence = result.supporting_memories.slice(0, maxEvidence).map(toEvidence);
  // tenant scope: the project_addrs of every memory this packet draws on (deduped, non-null).
  const project_addrs = Array.from(
    new Set(
      [...result.primary_memories, ...result.supporting_memories]
        .map((m) => m.project_addr)
        .filter((a): a is string => a != null),
    ),
  );
  const conflicts_warnings = collectWarnings(result, primary);
  const risk_level = riskLevel(result, primary);
  const required_approval = requiredApproval(risk_level, operating_class);

  return {
    has_primary: primary != null,
    primary_instruction: primaryInstruction(result, primary),
    primary_addr: primary?.addr ?? null,
    operating_class,
    supporting_evidence,
    conflicts_warnings,
    freshness_note: freshnessNote(result),
    risk_level,
    required_approval,
    acceptance_criteria: acceptanceCriteria(result, primary, required_approval),
    confidence: result.confidence,
    next_recommended_action: result.next_move,
    recall_id: result.recall_id,
    tenant_scope: { tenant_id: opts.tenantId ?? null, project_addrs },
  };
}
