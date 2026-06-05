/**
 * Domain-aware recall routing.
 *
 * Classifies query intent (ops/rollout/workspace/mixed/unknown), selects the
 * most likely domain project for first-pass recall, widens when results are
 * weak, and returns a RoutingTrace alongside the recall result.
 *
 * Design principles:
 *   - Routing is explicit and inspectable (trace on every call)
 *   - Widening is deliberate, not silent
 *   - Mixed queries run both domains, not one flattened domain
 *   - Does NOT modify existing /memory/recall behavior
 *   - Embedding is computed once and reused across domain passes
 */

import type { Sql } from "postgres";
import { embedQuery } from "./embed";
import { compileRecall, type RecallResult } from "./recall-compiler";
import { createRecallId, recordRecallOutcomeEvent } from "./recall-outcomes";

// ── Types ──

export type DomainIntent = "ops" | "rollout" | "workspace" | "mixed" | "unknown";

export interface RoutingTrace {
  /** Original query text */
  query: string;
  /** Classified intent */
  classified_intent: DomainIntent;
  /** Keyword scores driving the classification */
  intent_scores: { ops: number; rollout: number; workspace: number };
  /** Domain label chosen for first-pass recall (null = tenant-wide) */
  first_pass_domain: string | null;
  /** Project addr used for first-pass (null = tenant-wide) */
  first_pass_project_addr: string | null;
  /** Primary memory count from first-pass */
  first_pass_result_count: number;
  /** Average relevance of first-pass primary memories */
  first_pass_avg_relevance: number;
  /** Whether domain widening occurred */
  widened: boolean;
  /** Ordered sequence of domains tried during widening */
  widen_sequence: string[];
  /** Domain labels present in final primary memories */
  final_primary_domains: string[];
  /** Overall routing confidence */
  final_confidence: "high" | "medium" | "low";
  /** True if workspace query lacked bootstrap context */
  missing_bootstrap_context: boolean;
  /** True when query was classified as mixed-intent */
  mixed_query: boolean;
  /** Advisory warnings from the routing layer */
  warnings: string[];
}

export interface RoutedRecallResult extends RecallResult {
  routing: RoutingTrace;
  /**
   * For mixed-intent queries: per-domain memories from each recall pass, before merge.
   * Allows callers to display or reason about each domain independently.
   * Additive/optional — undefined for non-mixed intent. Existing callers using only
   * primary_memories are unaffected.
   */
  split_results?: {
    mixed_split: true;
    ops: { domain: string; memories: RecallResult["primary_memories"]; result_count: number };
    rollout: { domain: string; memories: RecallResult["primary_memories"]; result_count: number };
  };
}

// ── Known domain labels ──
// These match the labels seeded in PR-11 (VO Tenant Operations) and PR-12 (VO Beta Rollout).

export const KNOWN_DOMAIN_LABELS = {
  ops: "VO Tenant Operations",
  rollout: "VO Beta Rollout",
} as const;

// ── Intent classification ──
//
// Keyword stems: single-word entries are matched against query word-tokens via
// startsWith (covers plurals and conjugations within +3 chars). Multi-word entries
// (containing space or hyphen) use normalized substring match.

const OPS_KEYWORDS: string[] = [
  // Verification / proof
  "proof", "verify", "proven", "prove",
  // Health / failure / incident
  "health", "incident", "failure",
  // Debugging / gateway / runtime
  "debug", "gateway", "runtime",
  // Escalation stem covers: escalate, escalating, escalation
  "escalat",
  // Trust model / boundary
  "trust", "boundary", "localhost",
  // Install / maintenance / tooling
  "install", "maintenance", "runbook", "canary",
  // Remote write handling
  "retract", "suspicious",
  // Multi-word ops signals
  "support-bundle",
  "support bundle",
  "local-first",
  "break glass",
  "confusing failure",
];

const ROLLOUT_KEYWORDS: string[] = [
  // Core rollout
  "beta", "rollout", "stage",
  // Onboarding (stem covers: onboard, onboarding)
  "onboard",
  // User selection
  "users", "tester",
  // Conditions
  "expansion", "burden",
  "stop condition",
  "success criteria",
  "go condition",
  "operator burden",
  "first user",
  "first users",
  "who should",
  "early access",
  "first session",
  // Demo filter
  "demo",
];

const WORKSPACE_KEYWORDS: string[] = [
  // Core workspace terms
  "repo", "workspace", "cwd",
  // Bootstrap signals
  "bootstrap",
  "bootstrap posture",
  "workspace posture",
  // Local-specific
  "workspace-local",
  "workspace local",
  "local corrections",
  "repo root",
  "this repo",
  "this workspace",
  "project-specific",
  "architecture decisions",
];

function scoreKeywords(query: string, keywords: string[]): number {
  const normalized = query.toLowerCase().trim();
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const kw of keywords) {
    if (kw.includes(" ") || kw.includes("-")) {
      // Multi-word / hyphenated: substring match on full normalized string
      if (normalized.includes(kw)) score += 2;
    } else {
      // Single-word stem: match if any query word starts with the keyword
      // and is at most 3 chars longer (covers plurals and short conjugations)
      if (words.some((w) => w === kw || (w.startsWith(kw) && w.length <= kw.length + 3))) {
        score += 1;
      }
    }
  }
  return score;
}

export function classifyIntent(query: string): {
  intent: DomainIntent;
  ops_score: number;
  rollout_score: number;
  workspace_score: number;
} {
  const ops = scoreKeywords(query, OPS_KEYWORDS);
  const rollout = scoreKeywords(query, ROLLOUT_KEYWORDS);
  const workspace = scoreKeywords(query, WORKSPACE_KEYWORDS);

  // No signal at all
  if (ops === 0 && rollout === 0 && workspace === 0) {
    return { intent: "unknown", ops_score: 0, rollout_score: 0, workspace_score: 0 };
  }

  // Workspace wins when it clearly dominates both ops and rollout
  if (workspace > ops && workspace > rollout) {
    return { intent: "workspace", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
  }

  // Mixed: both ops AND rollout have meaningful scores (each >= 2, within 2.5x of each other)
  // Requires both to be meaningful — prevents a single "beta" from making an ops query mixed.
  if (ops >= 2 && rollout >= 2 && Math.min(ops, rollout) >= Math.max(ops, rollout) * 0.4) {
    return { intent: "mixed", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
  }

  // Single-domain wins
  if (ops > rollout && ops >= 1) {
    return { intent: "ops", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
  }
  if (rollout > ops && rollout >= 1) {
    return { intent: "rollout", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
  }

  // Tie between ops and rollout — workspace tiebreak or unknown
  if (workspace > 0) {
    return { intent: "workspace", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
  }

  return { intent: "unknown", ops_score: ops, rollout_score: rollout, workspace_score: workspace };
}

// ── Domain resolution (DB lookup by label, cached per space) ──

interface KnownDomains {
  ops: { label: string; addr: string } | null;
  rollout: { label: string; addr: string } | null;
  resolved_at: number;
}

const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _domainCache = new Map<string, KnownDomains>();

async function resolveKnownDomains(sql: Sql, spaceId: string): Promise<KnownDomains> {
  const cached = _domainCache.get(spaceId);
  if (cached && Date.now() - cached.resolved_at < DOMAIN_CACHE_TTL_MS) return cached;

  let rows: any[] = [];
  try {
    rows = await sql`
      SELECT addr, label FROM nodes
      WHERE space_id = ${spaceId}
        AND pyramid_id = 'PROJECTS'
        AND depth = 1
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
        AND label = ANY(${[KNOWN_DOMAIN_LABELS.ops, KNOWN_DOMAIN_LABELS.rollout]}::text[])
    `;
  } catch { /* non-fatal — DB error returns null domains */ }

  const domains: KnownDomains = { ops: null, rollout: null, resolved_at: Date.now() };
  for (const row of rows) {
    if (row.label === KNOWN_DOMAIN_LABELS.ops) domains.ops = { label: row.label, addr: row.addr };
    if (row.label === KNOWN_DOMAIN_LABELS.rollout) domains.rollout = { label: row.label, addr: row.addr };
  }

  _domainCache.set(spaceId, domains);
  return domains;
}

// ── Widen thresholds ──

const WIDEN_MIN_COUNT = 2;      // widen if primary_memories count < 2
const WIDEN_MIN_RELEVANCE = 0.40; // widen if avg relevance < 0.40

function evaluateQuality(result: RecallResult): {
  count: number;
  avgRelevance: number;
  good: boolean;
} {
  const count = result.primary_memories.length;
  const avgRelevance = count > 0
    ? result.primary_memories.reduce((s, m) => s + m.relevance, 0) / count
    : 0;
  const good = count >= WIDEN_MIN_COUNT && avgRelevance >= WIDEN_MIN_RELEVANCE;
  return { count, avgRelevance, good };
}

// ── Merge two recall results ──

function gradeLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function mergeRecallResults(a: RecallResult, b: RecallResult): RecallResult {
  // Union of all candidates, deduplicated by addr, re-sorted by composite_score
  const seen = new Set<string>();
  const all = [
    ...a.primary_memories,
    ...a.supporting_memories,
    ...b.primary_memories,
    ...b.supporting_memories,
  ];
  const merged: typeof a.primary_memories = [];
  for (const m of all) {
    if (!seen.has(m.addr)) {
      seen.add(m.addr);
      merged.push(m);
    }
  }
  merged.sort((x, y) => y.composite_score - x.composite_score);

  // Overlays must stay subordinate even after merge — never promoted to primary.
  // Split into tenant-local candidates and overlay candidates, then fill primary
  // from tenant-local only. Overlays go to supporting.
  const tenantCandidates = merged.filter((m) => m.federation?.authority !== "public_overlay");
  const overlayCandidates = merged.filter((m) => m.federation?.authority === "public_overlay");

  const primary = tenantCandidates.slice(0, 3);
  const tenantSupporting = tenantCandidates.slice(3, 6);
  const supporting = [...tenantSupporting, ...overlayCandidates].slice(0, 6);

  const avgRelevance = primary.length > 0
    ? primary.reduce((s, m) => s + m.relevance, 0) / primary.length : 0;
  const avgFreshness = primary.length > 0
    ? primary.reduce((s, m) => s + m.freshness, 0) / primary.length : 0;
  const avgProvenance = primary.length > 0
    ? primary.reduce((s, m) => s + m.provenance_score, 0) / primary.length : 0;
  const allConflictFree = primary.every((m) => m.conflict_free);

  return {
    ...a,
    primary_memories: primary,
    supporting_memories: supporting,
    confidence: {
      relevance: gradeLevel(avgRelevance),
      freshness: gradeLevel(avgFreshness),
      provenance: gradeLevel(avgProvenance),
      conflict_free: allConflictFree ? "high" : a.conflicts.length > 0 ? "low" : "medium",
      summary: primary.length === 0
        ? "No relevant memories found after domain-widening."
        : `${primary.length} memories found (domain-widened). Relevance: ${gradeLevel(avgRelevance)}, freshness: ${gradeLevel(avgFreshness)}.`,
    },
    explanation: {
      ...a.explanation,
      candidates_scored: a.explanation.candidates_scored + b.explanation.candidates_scored,
      excluded_count: a.explanation.excluded_count + b.explanation.excluded_count,
      excluded_reasons: [...new Set([...a.explanation.excluded_reasons, ...b.explanation.excluded_reasons])],
    },
  };
}

// ── Primary routing function ──

export interface RoutedRecallOptions {
  tenantId: string;
  spaceId: string;
  kinds?: string[];
  /** Explicit project addr for workspace routing (e.g., from bootstrap context) */
  projectAddr?: string;
  /** Agent-policy visible_projects: restrict project-backed memories to this set. */
  visibleProjectAddrs?: string[] | null;
  limit?: number;
  includeInactive?: boolean;
  timeoutMs?: number;
  /** Optional agent id for recall outcome telemetry attribution. */
  agentId?: string | null;
  /** Suppress imported overlay results (tenant_private recall scope). */
  suppressOverlays?: boolean;
}

export async function routedRecall(
  sql: Sql,
  query: string,
  opts: RoutedRecallOptions,
): Promise<RoutedRecallResult> {
  const { tenantId, spaceId } = opts;
  const warnings: string[] = [];
  const widenSequence: string[] = [];
  let widened = false;

  // 0. Early guard: if the caller explicitly requested a project that is
  // outside the agent's visible_projects, return an empty result immediately.
  // This prevents domain routing from silently widening to a different project.
  if (
    opts.projectAddr &&
    opts.visibleProjectAddrs &&
    opts.visibleProjectAddrs.length > 0 &&
    !opts.visibleProjectAddrs.includes(opts.projectAddr)
  ) {
    const recallId = createRecallId();
    let recallTelemetryUnavailable = false;
    try {
      await recordRecallOutcomeEvent(sql, {
        recallId,
        tenantId,
        spaceId,
        agentId: opts.agentId || null,
        query,
        eventType: "recalled",
        memoryAddrs: [],
        topAddr: null,
        evidence: {
          empty_visibility: true,
          project_addr: opts.projectAddr,
          visible_projects_enforced: true,
        },
      });
    } catch (error: any) {
      recallTelemetryUnavailable = true;
      console.warn("[domain-router] recall outcome event skipped:", error?.message || String(error));
    }

    const emptyResult: RoutedRecallResult = {
      recall_id: recallId,
      ...(recallTelemetryUnavailable ? { recall_telemetry_unavailable: true } : {}),
      primary_memories: [],
      supporting_memories: [],
      changes_since: [],
      conflicts: [],
      stale: [],
      fresh_research_needed: null,
      confidence: {
        relevance: "low",
        freshness: "low",
        provenance: "low",
        conflict_free: "high",
        summary: "explicit project outside agent visible_projects — no results",
      },
      next_move: null,
      error_recovered: false,
      recovery_reason: null,
      explanation: {
        candidates_scored: 0,
        excluded_count: 0,
        excluded_reasons: ["project outside agent visible_projects policy"],
        posture: "research_needed" as const,
        posture_note: "Agent visible_projects policy excluded the requested project. No memories to score.",
        routing_method: "none",
        routed_family: null,
      },
      routing: {
        query,
        classified_intent: "workspace",
        intent_scores: { ops: 0, rollout: 0, workspace: 0 },
        first_pass_domain: null,
        first_pass_project_addr: opts.projectAddr,
        first_pass_result_count: 0,
        first_pass_avg_relevance: 0,
        widened: false,
        widen_sequence: [],
        final_primary_domains: [],
        final_confidence: "low",
        missing_bootstrap_context: false,
        mixed_query: false,
        warnings: ["explicit project outside visible_projects — scoped empty result returned without widening"],
      },
    };
    return emptyResult;
  }

  // 1. Classify intent
  const { intent, ops_score, rollout_score, workspace_score } = classifyIntent(query);

  // 2. Resolve known domain project addrs (cached, non-fatal)
  const knownDomains = await resolveKnownDomains(sql, spaceId);

  // 3. Pre-compute embedding once — reused across all domain recall passes
  let sharedEmbedding: number[] | undefined;
  try {
    sharedEmbedding = await embedQuery(query);
  } catch {
    // Non-fatal: compileRecall embeds internally if not provided
  }

  // 4. Determine first-pass domain
  let firstPassProjectAddr: string | null = null;
  let firstPassDomain: string | null = null;
  let missingBootstrapContext = false;

  switch (intent) {
    case "ops":
      if (knownDomains.ops) {
        firstPassProjectAddr = knownDomains.ops.addr;
        firstPassDomain = knownDomains.ops.label;
      } else {
        warnings.push(
          `${KNOWN_DOMAIN_LABELS.ops} not seeded — using tenant-wide recall. Run: vo seed-system-project`,
        );
      }
      break;

    case "rollout":
      if (knownDomains.rollout) {
        firstPassProjectAddr = knownDomains.rollout.addr;
        firstPassDomain = knownDomains.rollout.label;
      } else {
        warnings.push(
          `${KNOWN_DOMAIN_LABELS.rollout} not seeded — using tenant-wide recall. Run: vo seed-rollout-project`,
        );
      }
      break;

    case "workspace":
      if (opts.projectAddr) {
        firstPassProjectAddr = opts.projectAddr;
        firstPassDomain = "workspace (bootstrap context)";
      } else {
        missingBootstrapContext = true;
        warnings.push(
          "Workspace query with no project context — workspace routing degraded. Bootstrap first: POST /bootstrap/project",
        );
      }
      break;

    case "mixed":
      // Mixed: start with ops (historically underserved in blended tenant recall)
      if (knownDomains.ops) {
        firstPassProjectAddr = knownDomains.ops.addr;
        firstPassDomain = knownDomains.ops.label;
      } else {
        warnings.push(
          `Mixed intent — ${KNOWN_DOMAIN_LABELS.ops} not seeded, starting with tenant-wide`,
        );
      }
      break;

    case "unknown":
      // No domain — tenant-wide recall (firstPassProjectAddr stays null)
      break;
  }

  // 5. First-pass recall
  const firstPassResult = await compileRecall(sql, {
    query,
    tenantId,
    spaceId,
    kinds: opts.kinds as any,
    projectAddr: firstPassProjectAddr ?? undefined,
    limit: opts.limit,
    includeInactive: opts.includeInactive,
    visibleProjectAddrs: opts.visibleProjectAddrs,
    timeoutMs: opts.timeoutMs,
    agentId: opts.agentId,
    suppressOverlays: opts.suppressOverlays,
    embedding: sharedEmbedding,
  });

  const firstPassQuality = evaluateQuality(firstPassResult);
  let finalResult = firstPassResult;

  // split_results: populated for mixed intent — captures per-domain memories before merge.
  let splitResults: RoutedRecallResult["split_results"] = undefined;

  // 6. Widening strategy
  if (intent === "mixed") {
    // Mixed always runs a second domain pass to honor both intents.
    // First pass is ops (set above), second is rollout — both results captured before merge.
    widened = true;
    const secondDomain = knownDomains.rollout?.addr !== firstPassProjectAddr
      ? knownDomains.rollout
      : knownDomains.ops?.addr !== firstPassProjectAddr
        ? knownDomains.ops
        : null;

    if (secondDomain) {
      widenSequence.push(secondDomain.label);
      const secondResult = await compileRecall(sql, {
        query,
        tenantId,
        spaceId,
        kinds: opts.kinds as any,
        projectAddr: secondDomain.addr,
        limit: opts.limit,
        includeInactive: opts.includeInactive,
        visibleProjectAddrs: opts.visibleProjectAddrs,
        agentId: opts.agentId,
        suppressOverlays: opts.suppressOverlays,
        embedding: sharedEmbedding,
      });
      finalResult = mergeRecallResults(firstPassResult, secondResult);

      // Capture split view before merge — first pass = ops, second = rollout.
      // Both halves are preserved so callers can display or reason about each domain
      // independently, rather than seeing only the blended merged result.
      if (knownDomains.ops && knownDomains.rollout) {
        splitResults = {
          mixed_split: true,
          ops: {
            domain: KNOWN_DOMAIN_LABELS.ops,
            memories: firstPassResult.primary_memories,
            result_count: firstPassResult.primary_memories.length,
          },
          rollout: {
            domain: KNOWN_DOMAIN_LABELS.rollout,
            memories: secondResult.primary_memories,
            result_count: secondResult.primary_memories.length,
          },
        };
      }
    }

    // If still weak after both domains, widen to tenant-wide
    if (!evaluateQuality(finalResult).good) {
      widenSequence.push("tenant-wide");
      const tenantResult = await compileRecall(sql, {
        query,
        tenantId,
        spaceId,
        kinds: opts.kinds as any,
        limit: opts.limit,
        includeInactive: opts.includeInactive,
        visibleProjectAddrs: opts.visibleProjectAddrs,
        agentId: opts.agentId,
        suppressOverlays: opts.suppressOverlays,
        embedding: sharedEmbedding,
      });
      finalResult = mergeRecallResults(finalResult, tenantResult);
    }
  } else if (firstPassProjectAddr !== null && !firstPassQuality.good) {
    // Guard: if the explicit project was outside the agent's visible_projects,
    // the empty first-pass result is correct (access denied for that project).
    // Do NOT widen — widening would leak tenant-wide or other-domain memories
    // that the caller shouldn't get when requesting a specific disallowed project.
    const explicitProjectDisallowed = opts.visibleProjectAddrs
      && opts.visibleProjectAddrs.length > 0
      && opts.projectAddr
      && !opts.visibleProjectAddrs.includes(opts.projectAddr);
    if (explicitProjectDisallowed) {
      // Return the empty scoped result as-is. No widening.
      warnings.push("explicit project outside visible_projects — scoped result returned without widening");
    } else {
    // Single-domain first pass was weak — widen deliberately
    widened = true;
    warnings.push(
      `First-pass domain had weak results (count=${firstPassQuality.count}, relevance=${firstPassQuality.avgRelevance.toFixed(2)}) — widening`,
    );

    // Try second likely domain before falling to tenant-wide
    let secondDomain: { label: string; addr: string } | null = null;
    if (intent === "ops" && knownDomains.rollout) secondDomain = knownDomains.rollout;
    else if (intent === "rollout" && knownDomains.ops) secondDomain = knownDomains.ops;

    if (secondDomain) {
      widenSequence.push(secondDomain.label);
      const secondResult = await compileRecall(sql, {
        query,
        tenantId,
        spaceId,
        kinds: opts.kinds as any,
        projectAddr: secondDomain.addr,
        limit: opts.limit,
        includeInactive: opts.includeInactive,
        visibleProjectAddrs: opts.visibleProjectAddrs,
        agentId: opts.agentId,
        suppressOverlays: opts.suppressOverlays,
        embedding: sharedEmbedding,
      });
      finalResult = mergeRecallResults(firstPassResult, secondResult);
    }

    // If still weak after second domain, fall back to tenant-wide
    if (!evaluateQuality(finalResult).good) {
      widenSequence.push("tenant-wide");
      const tenantResult = await compileRecall(sql, {
        query,
        tenantId,
        spaceId,
        kinds: opts.kinds as any,
        limit: opts.limit,
        includeInactive: opts.includeInactive,
        visibleProjectAddrs: opts.visibleProjectAddrs,
        agentId: opts.agentId,
        suppressOverlays: opts.suppressOverlays,
        embedding: sharedEmbedding,
      });
      finalResult = mergeRecallResults(finalResult, tenantResult);
    }
    } // end else (non-disallowed widening)
  }
  // For unknown intent: no widening — already tenant-wide by default.

  // 7. Collect domain labels present in final primary memories
  const finalDomainSet = new Set<string>();
  for (const m of finalResult.primary_memories) {
    if (m.project_label) finalDomainSet.add(m.project_label);
  }
  const finalPrimaryDomains = Array.from(finalDomainSet);

  // 8. Domain mismatch warnings (Failure Mode 1 / 2 from spec)
  if (intent === "ops" && finalResult.primary_memories.slice(0, 2).some(
    (m) => m.project_label === KNOWN_DOMAIN_LABELS.rollout,
  )) {
    warnings.push("Ops query: rollout memory dominates top results — check memory domain placement");
  }
  if (intent === "rollout" && finalResult.primary_memories.slice(0, 2).some(
    (m) => m.project_label === KNOWN_DOMAIN_LABELS.ops,
  )) {
    warnings.push("Rollout query: ops memory dominates top results — check memory domain placement");
  }
  if (intent === "unknown" && finalResult.primary_memories.length === 0) {
    warnings.push("Unknown intent — tenant-wide recall returned no memories");
  }

  // 9. Final confidence (base from quality + widening, then degraded for routing hazards)
  const finalQuality = evaluateQuality(finalResult);
  let finalConfidence: "high" | "medium" | "low";
  if (missingBootstrapContext) {
    // Workspace routing degraded — bootstrap context is absent, result may come from wrong project
    finalConfidence = "low";
  } else if (finalQuality.good && !widened) {
    finalConfidence = "high";
  } else if (finalQuality.good) {
    finalConfidence = "medium";
  } else {
    finalConfidence = "low";
  }

  // 10. Mixed domain collapse check — warn and degrade when one intent disappears from final results
  if (intent === "mixed") {
    const hasOps = finalPrimaryDomains.includes(KNOWN_DOMAIN_LABELS.ops);
    const hasRollout = finalPrimaryDomains.includes(KNOWN_DOMAIN_LABELS.rollout);
    if (!hasOps && knownDomains.ops) {
      warnings.push(
        `Mixed query: ${KNOWN_DOMAIN_LABELS.ops} dropped out of final results — ops memories may be weak or absent for this query`,
      );
      if (finalConfidence === "high") finalConfidence = "medium";
    }
    if (!hasRollout && knownDomains.rollout) {
      warnings.push(
        `Mixed query: ${KNOWN_DOMAIN_LABELS.rollout} dropped out of final results — rollout memories may be weak or absent for this query`,
      );
      if (finalConfidence === "high") finalConfidence = "medium";
    }
  }

  const trace: RoutingTrace = {
    query,
    classified_intent: intent,
    intent_scores: { ops: ops_score, rollout: rollout_score, workspace: workspace_score },
    first_pass_domain: firstPassDomain,
    first_pass_project_addr: firstPassProjectAddr,
    first_pass_result_count: firstPassQuality.count,
    first_pass_avg_relevance: parseFloat(firstPassQuality.avgRelevance.toFixed(3)),
    widened,
    widen_sequence: widenSequence,
    final_primary_domains: finalPrimaryDomains,
    final_confidence: finalConfidence,
    missing_bootstrap_context: missingBootstrapContext,
    mixed_query: intent === "mixed",
    warnings,
  };

  return { ...finalResult, _embedding: sharedEmbedding, routing: trace, split_results: splitResults };
}
