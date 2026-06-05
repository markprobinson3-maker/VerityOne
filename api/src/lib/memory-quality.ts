import type { MemoryKind, SourceKind, SourceRef } from "./memory-contract";

export type MemoryReviewCategory =
  | "likely_durable"
  | "likely_status_digest"
  | "likely_vague_needs_rewrite"
  | "likely_test_proof_garbage";

export interface MemoryQualityInput {
  kind: MemoryKind;
  source: SourceKind;
  subject?: string;
  assertion: string;
  whyItMatters?: string;
  evidence?: string;
  tags?: string[];
  sourceRefs?: SourceRef[] | null;
}

export interface MemoryQualityAssessment {
  verdict: "accept" | "reject";
  review_category: MemoryReviewCategory;
  review_priority: number;
  reasons: string[];
  meaningful_terms: string[];
}

export interface LexicalOverlapStats {
  left_terms: string[];
  right_terms: string[];
  shared_terms: string[];
  shared_entities: string[];
  jaccard: number;
  has_anchor: boolean;
}

const MIN_CONTRADICTION_ANCHOR_JACCARD = 0.12;
const MIN_CONTRADICTION_SHARED_TERMS = 3;

const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "always", "because", "been", "being",
  "between", "could", "from", "have", "into", "just", "like", "make", "more", "most",
  "must", "need", "needs", "only", "over", "same", "should", "than", "that", "their",
  "then", "there", "these", "they", "this", "those", "through", "under", "use", "used", "uses", "using",
  "when", "where", "which", "while", "with", "without", "would", "your",
  "lets", "let", "them", "all", "both", "done", "okay", "yeah", "yes",
]);

const PRONOUNS = new Set([
  "it", "its", "this", "that", "these", "those", "they", "them", "he", "she", "we",
  "you", "i", "me", "our", "ours", "their", "theirs", "one", "ones", "thing",
  "things", "stuff", "everything", "anything", "something",
]);

const VAGUE_PHRASES = [
  /\blet'?s do (it|them|all|both)\b/i,
  /\bdo (it|them|all|both)\b/i,
  /\bship it\b/i,
  /\bgo ahead\b/i,
  /\bsounds good\b/i,
  /\blooks good\b/i,
  /\bdo the same\b/i,
  /\bthat works\b/i,
  /\bok(?:ay)?\b/i,
];

const STATUS_DIGEST_PATTERNS = [
  /\b(daily|weekly|session|fresh|status)\s+(digest|summary|update|recap)\b/i,
  /\b(digest|summary|recap)\s+(for|of)\s+(today|this session|the session)\b/i,
  /\b(?:ran|running|run)\s+(tests?|smoke|lint|typecheck)\b/i,
  /\b(sync|mirror|cron|worker|maintenance)\s+(status|health|freshness)\b/i,
  /\bpending review\b/i,
  /\bqueue\s+(count|snapshot|status)\b/i,
];

const TEST_GARBAGE_PATTERNS = [
  /\b(write|memory|mcp|sync)\s+test\b/i,
  /\btest\s+(memory|write|intent|node|proof)\b/i,
  /\bproof\s+(garbage|witness|fixture|smoke)\b/i,
  /\blorem ipsum\b/i,
  /\bhello world\b/i,
];

export function meaningfulTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !PRONOUNS.has(t));
  return [...new Set(terms)];
}

function capitalizedEntities(text: string): string[] {
  const matches = text.match(/\b(?:[A-Z][A-Za-z0-9]{2,}|[A-Z]{2,})\b/g) || [];
  return [...new Set(matches.map((m) => m.toLowerCase()).filter((m) => !STOPWORDS.has(m)))];
}

function looksVague(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (VAGUE_PHRASES.some((re) => re.test(trimmed))) return true;
  const terms = meaningfulTerms(trimmed);
  return terms.length < 2 && trimmed.split(/\s+/).length <= 5;
}

function looksLikeStatusDigest(text: string, kind: MemoryKind): boolean {
  if (kind === "digest" || kind === "changelog") return true;
  return STATUS_DIGEST_PATTERNS.some((re) => re.test(text));
}

function looksLikeTestGarbage(text: string): boolean {
  return TEST_GARBAGE_PATTERNS.some((re) => re.test(text));
}

export function classifyMemoryWriteQuality(input: MemoryQualityInput): MemoryQualityAssessment {
  const combined = [
    input.subject || "",
    input.assertion || "",
    input.whyItMatters || "",
    input.evidence || "",
    ...(input.tags || []),
  ].join(" ");
  const terms = meaningfulTerms(combined);
  const reasons: string[] = [];
  const sourceRequiresGate = input.source === "agent_inferred";
  const hasSourceRefs = Array.isArray(input.sourceRefs) && input.sourceRefs.length > 0;

  let reviewCategory: MemoryReviewCategory = "likely_durable";
  let reviewPriority = 1;

  if (looksLikeTestGarbage(combined)) {
    reviewCategory = "likely_test_proof_garbage";
    reviewPriority = 4;
    reasons.push("test_or_proof_artifact");
  } else if (looksLikeStatusDigest(combined, input.kind)) {
    reviewCategory = "likely_status_digest";
    reviewPriority = 3;
    reasons.push("status_or_digest_memory");
  }

  const subjectIsVague = input.subject ? looksVague(input.subject) : false;
  const assertionIsVague = looksVague(input.assertion);
  const dependsOnMissingContext =
    /\b(this|that|these|those|it|them|both|all)\b/i.test(input.assertion) &&
    terms.length < 5;

  if (subjectIsVague) reasons.push("vague_subject_label");
  if (assertionIsVague || dependsOnMissingContext) reasons.push("assertion_depends_on_missing_context");
  if (terms.length < 3 && !hasSourceRefs) reasons.push("insufficient_subject_object_specificity");

  if (
    reviewCategory === "likely_durable" &&
    (subjectIsVague || assertionIsVague || dependsOnMissingContext || terms.length < 3)
  ) {
    reviewCategory = "likely_vague_needs_rewrite";
    reviewPriority = 2;
  }

  const reject =
    sourceRequiresGate &&
    (
      reviewCategory === "likely_test_proof_garbage" ||
      reviewCategory === "likely_status_digest" ||
      reviewCategory === "likely_vague_needs_rewrite"
    );

  return {
    verdict: reject ? "reject" : "accept",
    review_category: reviewCategory,
    review_priority: reviewPriority,
    reasons: [...new Set(reasons)],
    meaningful_terms: terms,
  };
}

export function lexicalOverlapStats(left: string, right: string): LexicalOverlapStats {
  const leftTerms = meaningfulTerms(left);
  const rightTerms = meaningfulTerms(right);
  const rightSet = new Set(rightTerms);
  const sharedTerms = leftTerms.filter((term) => rightSet.has(term));
  const union = new Set([...leftTerms, ...rightTerms]).size;
  const leftEntities = capitalizedEntities(left);
  const rightEntities = new Set(capitalizedEntities(right));
  const sharedEntities = leftEntities.filter((entity) => rightEntities.has(entity));
  const jaccard = union > 0 ? sharedTerms.length / union : 0;
  const hasAnchor = hasActionableContradictionAnchor({
    sharedTerms,
    sharedEntities,
    jaccard,
  });

  return {
    left_terms: leftTerms,
    right_terms: rightTerms,
    shared_terms: sharedTerms,
    shared_entities: sharedEntities,
    jaccard,
    has_anchor: hasAnchor,
  };
}

export function hasActionableContradictionAnchor(input: {
  sharedTerms: string[];
  sharedEntities?: string[];
  jaccard: number;
}): boolean {
  const sharedTerms = input.sharedTerms.filter((term) => term.trim().length > 0);
  const sharedEntities = input.sharedEntities || [];
  const sharedEntitySet = new Set(sharedEntities.map((entity) => entity.toLowerCase()));
  const nonEntitySharedTerms = sharedTerms.filter((term) => !sharedEntitySet.has(term.toLowerCase()));
  const strongTermOverlap =
    sharedTerms.length >= MIN_CONTRADICTION_SHARED_TERMS &&
    input.jaccard >= MIN_CONTRADICTION_ANCHOR_JACCARD;
  const strongEntityOverlap =
    sharedEntities.length >= 2 &&
    input.jaccard >= MIN_CONTRADICTION_ANCHOR_JACCARD;
  const mixedOverlap =
    sharedEntities.length >= 1 &&
    nonEntitySharedTerms.length >= 2 &&
    input.jaccard >= MIN_CONTRADICTION_ANCHOR_JACCARD;

  return strongTermOverlap || strongEntityOverlap || mixedOverlap;
}

export function storedConflictHasActionableAnchor(description: string | null | undefined): boolean {
  if (!description) return true;
  const jaccardMatch = description.match(/\bjaccard=([0-9]+(?:\.[0-9]+)?)/i);
  const sharedTermsMatch = description.match(/\bshared_terms=([^),]+)/i);
  const sharedEntitiesMatch = description.match(/\bshared_entities=([^),]+)/i);

  if (!jaccardMatch && !sharedTermsMatch && !sharedEntitiesMatch) {
    return true;
  }

  const jaccard = jaccardMatch ? Number(jaccardMatch[1]) : 0;
  const sharedTerms = sharedTermsMatch
    ? sharedTermsMatch[1].split("|").map((term) => term.trim()).filter(Boolean)
    : [];
  const sharedEntities = sharedEntitiesMatch
    ? sharedEntitiesMatch[1].split("|").map((term) => term.trim()).filter(Boolean)
    : [];

  return hasActionableContradictionAnchor({ sharedTerms, sharedEntities, jaccard });
}
