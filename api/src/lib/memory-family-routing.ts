/**
 * Memory-Family Routing — route recall and grounding queries to the right memory cluster.
 *
 * Memory families are NOT vendor/tool aliases (that's a secondary signal).
 * They are memory-type clusters: accepted_decision, user_preference,
 * user_correction, deployment_pattern, etc.
 *
 * RESTRICTION: Do NOT apply to /search in v1. /search remains broad for recovery.
 */

import type { Sql } from "postgres";
import type { MemoryKind } from "./memory-contract";
import { embedBatch } from "./embed";

// ── Memory families ──

export interface MemoryFamily {
  id: string;
  label: string;
  description: string;
  /** Memory kinds that belong to this family */
  kinds: MemoryKind[];
  /** Keywords that signal this family */
  keywords: string[];
}

export const MEMORY_FAMILIES: MemoryFamily[] = [
  {
    id: "accepted_decision",
    label: "Accepted Decisions",
    description: "Architecture, technology, and operational decisions the operator accepted.",
    kinds: ["decision"],
    keywords: ["decision", "decided", "chose", "choice", "architecture", "selected", "settled", "adopted"],
  },
  {
    id: "user_preference",
    label: "User Preferences",
    description: "Model, provider, billing, and workflow preferences.",
    kinds: ["preference"],
    keywords: ["preference", "prefer", "preferred", "favorite", "default", "model choice", "provider", "billing"],
  },
  {
    id: "user_correction",
    label: "User Corrections",
    description: "Corrections applied to agent behavior or assumptions.",
    kinds: ["correction"],
    keywords: ["correction", "corrected", "wrong", "mistake", "fix", "dont", "do not", "stop", "never"],
  },
  {
    id: "deployment_pattern",
    label: "Deployment Patterns",
    description: "Infrastructure, deployment, and operational patterns.",
    kinds: ["pattern", "decision"],
    keywords: ["deploy", "deployment", "infrastructure", "server", "hosting", "cloudflare", "vercel", "tunnel"],
  },
  {
    id: "failure_pattern",
    label: "Failure Patterns",
    description: "Recurring failures, bugs, and incident patterns.",
    kinds: ["pattern", "context"],
    keywords: ["failure", "bug", "incident", "crash", "error", "regression", "broke", "breaking"],
  },
  {
    id: "provider_choice",
    label: "Provider/Tool Choices",
    description: "Specific vendor, tool, and provider decisions.",
    kinds: ["decision", "preference"],
    keywords: ["provider", "tool", "api key", "token", "model", "llm", "embedding", "database"],
  },
  {
    id: "billing_choice",
    label: "Billing & Cost Decisions",
    description: "Spending limits, billing decisions, cost controls.",
    kinds: ["decision", "preference"],
    keywords: ["billing", "cost", "spending", "limit", "budget", "price", "subscription", "invoice"],
  },
  {
    id: "regression_history",
    label: "Regression History",
    description: "Regression suite decisions, test history, quality gates.",
    kinds: ["decision", "pattern"],
    keywords: ["regression", "test", "suite", "canary", "benchmark", "eval", "quality", "gate"],
  },
  {
    id: "digest_summary",
    label: "Digest Summaries",
    description: "Session digests, operational summaries, activity logs.",
    kinds: ["digest", "changelog"],
    keywords: ["digest", "summary", "session", "recap", "activity", "log", "what happened", "recent"],
  },
];

// ── Route detection ──

export interface MemoryRoute {
  /** Matched memory families, ordered by confidence */
  families: Array<{ id: string; label: string; score: number }>;
  /** Memory kinds to filter by (union of matched family kinds) */
  targetKinds: MemoryKind[];
  /** Route confidence */
  confidence: "high" | "medium" | "low";
  /** Whether tenant-local memories likely exist for this query */
  tenantMemoryPresent: boolean;
  /** Fallback policy */
  fallbackPolicy: "family_only" | "family_plus_global" | "global_only";
}

export function detectMemoryRoute(query: string): MemoryRoute | null {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return null;

  const scored: Array<{ family: MemoryFamily; score: number }> = [];

  // Tokenize query into words for word-level matching
  const queryWords = normalized.split(/[^a-z0-9]+/).filter(Boolean);

  for (const family of MEMORY_FAMILIES) {
    let score = 0;
    for (const kw of family.keywords) {
      if (kw.includes(" ")) {
        // Multi-word keywords use substring match (already precise)
        if (normalized.includes(kw)) score += 2;
      } else {
        // Single-word keywords: match if any query word starts with the keyword
        // This handles plurals (decisions→decision) without substring false positives
        // (error≠error correction, but correction→correction✓)
        const matched = queryWords.some((w) => w === kw || w.startsWith(kw) && w.length <= kw.length + 3);
        if (matched) score += 1;
      }
    }
    if (score > 0) {
      scored.push({ family, score });
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;

  // Confidence: high if top family has 3+ keyword hits or 2+ families agree
  const confidence: MemoryRoute["confidence"] =
    topScore >= 3 ? "high" :
    (topScore >= 2 || scored.length >= 2) ? "medium" :
    "low";

  const families = scored.slice(0, 3).map(({ family, score }) => ({
    id: family.id,
    label: family.label,
    score,
  }));

  // Collect unique target kinds from all matched families
  const kindSet = new Set<MemoryKind>();
  for (const { family } of scored.slice(0, 3)) {
    for (const kind of family.kinds) kindSet.add(kind);
  }

  const fallbackPolicy: MemoryRoute["fallbackPolicy"] =
    confidence === "high" ? "family_only" :
    confidence === "medium" ? "family_plus_global" :
    "global_only";

  return {
    families,
    targetKinds: Array.from(kindSet),
    confidence,
    tenantMemoryPresent: false, // Will be set by caller after DB check
    fallbackPolicy,
  };
}

// ── Tenant memory presence check ──

// ── Semantic family routing (fallback when keywords fail) ──

let _familyEmbeddings: Map<string, number[]> | null = null;
let _familyEmbeddingsLoading: Promise<void> | null = null;

/**
 * Precompute embeddings for all 9 memory family descriptions.
 * Called lazily on first semantic route attempt. Cached in module scope.
 */
async function ensureFamilyEmbeddings(): Promise<Map<string, number[]>> {
  if (_familyEmbeddings) return _familyEmbeddings;
  if (_familyEmbeddingsLoading) {
    await _familyEmbeddingsLoading;
    return _familyEmbeddings!;
  }

  _familyEmbeddingsLoading = (async () => {
    const texts = MEMORY_FAMILIES.map((f) => `${f.label}: ${f.description}`);
    const embeddings = await embedBatch(texts);
    _familyEmbeddings = new Map();
    for (let i = 0; i < MEMORY_FAMILIES.length; i++) {
      _familyEmbeddings.set(MEMORY_FAMILIES[i].id, embeddings[i]);
    }
  })();
  await _familyEmbeddingsLoading;
  _familyEmbeddingsLoading = null;
  return _familyEmbeddings!;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Semantic memory-family routing. Uses precomputed family embeddings
 * to find the best matching family for a query embedding.
 *
 * Only call this when keyword routing returns null or low confidence.
 */
export async function detectSemanticMemoryRoute(
  queryEmbedding: number[],
): Promise<MemoryRoute | null> {
  const familyEmbeddings = await ensureFamilyEmbeddings();

  const scored: Array<{ family: MemoryFamily; score: number }> = [];
  for (const family of MEMORY_FAMILIES) {
    const familyEmb = familyEmbeddings.get(family.id);
    if (!familyEmb) continue;
    const sim = cosineSimilarity(queryEmbedding, familyEmb);
    if (sim > 0.45) {
      scored.push({ family, score: sim });
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;

  // Semantic confidence: tighter thresholds than keyword (more noise)
  const confidence: MemoryRoute["confidence"] =
    topScore >= 0.65 ? "high" :
    topScore >= 0.50 ? "medium" :
    "low";

  if (confidence === "low") return null; // Don't route on weak semantic match

  const families = scored.slice(0, 3).map(({ family, score }) => ({
    id: family.id,
    label: family.label,
    score: parseFloat(score.toFixed(3)),
  }));

  const kindSet = new Set<MemoryKind>();
  for (const { family } of scored.slice(0, 3)) {
    for (const kind of family.kinds) kindSet.add(kind);
  }

  return {
    families,
    targetKinds: Array.from(kindSet),
    confidence,
    tenantMemoryPresent: false,
    fallbackPolicy: confidence === "high" ? "family_only" : "family_plus_global",
  };
}

// ── Tenant memory presence check ──

export async function checkTenantMemoryPresence(
  sql: Sql,
  spaceId: string,
  kinds: MemoryKind[],
): Promise<boolean> {
  if (kinds.length === 0) return false;
  const [row] = await sql`
    SELECT EXISTS(
      SELECT 1 FROM nodes
      WHERE space_id = ${spaceId}
        AND node_type = 'memory'
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
        AND substance->>'memory_type' = ANY(${kinds}::text[])
      LIMIT 1
    ) as present
  `;
  return row?.present === true;
}
