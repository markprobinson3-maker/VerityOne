import { closeVISql, sql } from "../vi/config";
import { callFlashLiteWithModel, type LLMResult } from "../lib/llm";
import { toVectorStr, embeddingMetadataForVectorWrite } from "@verity-one/embed";
import { deriveStimulusOrigin } from "../lib/stimulus-origin";
import { deleteEdgesByIds, upsertEdge, writeEdge } from "../../../api/src/lib/edge-mutations";
// R2: machine-level trend reactor kill switch. resolveTenantSettings reads
// ~/.vo/config.json#trends_enabled (default false). When the operator
// hasn't opted in via the dashboard toggle, runTrendMaintenance and
// attachOrphanToTrendPool both short-circuit before any DB work.
import { resolveTenantSettings } from "../../../api/src/lib/runtime-profile";
// R4: per-tenant DB-backed trends_enabled. listEnabledTenantSpaces returns
// tenant spaces whose tenant_settings.trends_enabled='true'. The reactor's
// forward pipeline (attachOrphanToTrendPool, clusterStandaloneOrphans,
// proto-cluster routing/birth/adopt in runTrendMaintenance) gates on this
// set plus 'global'. Cleanup/sync/archive/dedup paths are NOT gated so
// disabled tenants don't lose existing trends or starve orphan pools
// (Q-R4.6).
import { listEnabledTenantSpaces } from "../../../api/src/lib/tenant-settings";

type TrendLifecycle = "emerging" | "active" | "sustained" | "cooling" | "dead";
type TrendSpaceFilter = string[] | null;
type TrendMaintenanceBudget = {
  estimateFlashLiteMicro: number;
  evaluateBudgetCheck: (estimatedMicro: number) => { allowed: boolean; reason: string };
  recordLlmSpend: (actualMicro: number) => Promise<void>;
  actualCostMicro: (result: LLMResult, fallbackMicro: number) => number;
};
type TrendMaintenanceOptions = {
  budget?: TrendMaintenanceBudget;
};

function isTrendBudgetControlError(error: unknown): boolean {
  const message = String((error as any)?.message || "");
  return message.startsWith("trend_budget_") || Boolean((error as any)?.trendBudgetAccountingError);
}

// Exported so api/src/lib/trend-diagnostics.ts (R1) can read the live
// thresholds and produce silent pre-gate counts without re-implementing
// the loader. The shape is stable; the gate names line up with the
// runtime checks in routeProtoCluster.
export interface TrendParams {
  enabled: boolean;
  baseHalflifeHours: number;
  peakDelayHours: number;
  heatBudget: number;
  maxAgeDays: number;
  nurseryHours: number;
  nurseryFloorSteady: number;
  steadyScoreCap: number;
  graduationMinAgeDays: number;
  graduationMinDirectEnergy: number;
  graduationMinEdges: number;
  graduationMinSources: number;
  graduationMinOrigins: number;
  convergenceMinOrphans: number;
  convergenceMinSources: number;
  convergenceMinOrigins: number;
  convergenceMinEnergy: number;
  convergenceMinTemporalSpreadHours: number;
  protoClusterJoinSimilarity: number;
  dedupSimilarity: number;
  autoWireMax: number;
  autoWireMinSimilarity: number;
  autoWireWeightCap: number;
  promotionMinEnergy: number;
  recurrenceMaxIncarnations: number;
  orphanTtlCurrentHours: number;
  orphanTtlEphemeralHours: number;
  orphanPoolMax: number;
  protoClusterMaxAgeHours: number;
  recentFeedDefaultHours: number;
  promotionAmbiguityEnergyBand: number;
  promotionAmbiguitySimilarityBand: number;
  promotionAmbiguityGraceHours: number;
  releaseAmbiguityEnergyBand: number;
  releaseAmbiguityGraceHours: number;
  liveDedupIntervalMinutes: number;
  liveDedupSimilarity: number;
  liveDedupMaxBirthGapHours: number;
  liveDedupMinSharedOrigins: number;
  liveDedupAuditCooldownHours: number;
  rssProtoClusterJoinSimilarity: number;
  rssMinSharedTerms: number;
  rssPairwiseSupportFloor: number;
  rssAdoptSimilarity: number;
  rssAdoptMaxSourceDiversity: number;
}

type TrendParamKey = keyof TrendParams;
type TrendParamDef = {
  stateKey: string;
  type: "boolean" | "number";
  min?: number;
};

interface OrphanStimulus {
  id: number;
  source: string;
  source_id?: string | null;
  url?: string | null;
  content: string;
  temporality: "DURABLE" | "CURRENT" | "EPHEMERAL" | null;
  energy: number;
  decay_halflife_hours: number;
  created_at: Date;
  embedding: number[];
  proto_cluster_id: string | null;
  ingest_batch_id?: string | null;
  node_addr?: string | null;
  origin_key?: string | null;
  origin_kind?: string | null;
  origin_label?: string | null;
  // R3: tenant scoping. Threaded from stimuli.space_id (foundation
  // contract: NOT NULL DEFAULT 'global' + FK to graph_spaces).
  space_id: string;
}

interface ProtoCluster {
  id: string;
  centroid: number[];
  orphanCount: number;
  sourceTypes: string[];
  originKeys: string[];
  originDiversity: number;
  totalEnergy: number;
  createdAt: Date;
  lastFed: Date;
  // R3: tenant scoping. Set at cluster creation from joining orphan's
  // space_id; preserved through refresh and routing decisions.
  space_id: string;
}

interface TrendStats {
  liveHeat: number;
  avgDirectEnergy7d: number;
  sourceDiversity: number;
  sourceTypes: string[];
  originDiversity: number;
  originKeys: string[];
  newSourcesLastHour: number;
  newOriginsLastHour: number;
  totalSources: number;
  totalOrigins: number;
  consistencyHours: number;
  recentFeedIntervalHours: number;
  postBirthStimulusSeen: boolean;
  lastStimulusAt: string | null;
  feedTimestamps: string[];
  directStimulusCount: number;
  edgeCount: number;
  effectiveHalflifeHours: number;
  lifecycle: TrendLifecycle;
  graduationEligible: boolean;
  peakEnergy: number;
  velocity: number;
}

interface ClusterDecisionSnapshot {
  action: "await_more_signal" | "hold_borderline_promotion" | "hold_borderline_release" | "birth" | "adopt" | "recur" | "release";
  borderline: boolean;
  reasons: string[];
  metrics: {
    orphan_count: number;
    source_diversity: number;
    origin_diversity: number;
    total_energy: number;
    age_hours: number;
    hours_since_last_feed: number;
    best_similarity: number | null;
    dedup_kind: "active" | "archive" | null;
  };
  recommendedAction: "wait_for_more_signal" | "monitor_next_feed" | "release_cluster" | "promote_cluster" | "adopt_cluster" | "recur_trend";
}

interface LiveTrendSnapshot {
  addr: string;
  label: string;
  lifecycle: TrendLifecycle;
  birthTime: Date;
  createdAt: Date;
  domains: string[];
  sourceTypes: string[];
  sourceDiversity: number;
  originKeys: string[];
  originDiversity: number;
  feedCount: number;
  stimulusHeat: number;
  embedding: number[];
  // R3: tenant scope. Required so dedup queries can scope by space.
  space_id: string;
}

interface LiveTrendDuplicateCandidate {
  pairKey: string;
  primary: LiveTrendSnapshot;
  secondary: LiveTrendSnapshot;
  similarity: number;
  birthGapHours: number;
  sharedOrigins: string[];
  sharedDomains: string[];
  sharedSourceTypes: string[];
  primaryScore: number;
  secondaryScore: number;
}

interface SmokeFixtureEdgeTarget {
  addr: string;
  fallbackLabel: string;
  relation: string;
  confidence: number;
  weight: number;
}

const DEFAULT_PARAMS: TrendParams = {
  enabled: true,
  baseHalflifeHours: 12,
  peakDelayHours: 0,
  heatBudget: 1.0,
  maxAgeDays: 14,
  nurseryHours: 24,
  nurseryFloorSteady: 0.5,
  steadyScoreCap: 3,
  graduationMinAgeDays: 21,
  graduationMinDirectEnergy: 0.2,
  graduationMinEdges: 3,
  graduationMinSources: 3,
  graduationMinOrigins: 3,
  convergenceMinOrphans: 3,
  convergenceMinSources: 2,
  convergenceMinOrigins: 2,
  convergenceMinEnergy: 2,
  convergenceMinTemporalSpreadHours: 2,
  protoClusterJoinSimilarity: 0.72,
  dedupSimilarity: 0.88,
  autoWireMax: 5,
  autoWireMinSimilarity: 0.65,
  autoWireWeightCap: 0.4,
  promotionMinEnergy: 0.05,
  recurrenceMaxIncarnations: 3,
  orphanTtlCurrentHours: 48,
  orphanTtlEphemeralHours: 8,
  orphanPoolMax: 500,
  protoClusterMaxAgeHours: 72,
  recentFeedDefaultHours: 6,
  promotionAmbiguityEnergyBand: 0.35,
  promotionAmbiguitySimilarityBand: 0.03,
  promotionAmbiguityGraceHours: 6,
  releaseAmbiguityEnergyBand: 0.35,
  releaseAmbiguityGraceHours: 6,
  liveDedupIntervalMinutes: 15,
  liveDedupSimilarity: 0.95,
  liveDedupMaxBirthGapHours: 48,
  liveDedupMinSharedOrigins: 1,
  liveDedupAuditCooldownHours: 12,
  rssProtoClusterJoinSimilarity: 0.84,
  rssMinSharedTerms: 2,
  rssPairwiseSupportFloor: 0.45,
  rssAdoptSimilarity: 0.93,
  rssAdoptMaxSourceDiversity: 8,
};

const TREND_PARAM_CACHE_MS = 30_000;

const TREND_PARAM_DEFS: Record<TrendParamKey, TrendParamDef> = {
  enabled: { stateKey: "trend_enabled", type: "boolean" },
  baseHalflifeHours: { stateKey: "trend_base_halflife_hours", type: "number", min: 0.1 },
  peakDelayHours: { stateKey: "trend_peak_delay_hours", type: "number", min: 0 },
  heatBudget: { stateKey: "trend_heat_budget", type: "number", min: 0 },
  maxAgeDays: { stateKey: "trend_max_age_days", type: "number", min: 0.1 },
  nurseryHours: { stateKey: "trend_nursery_hours", type: "number", min: 0 },
  nurseryFloorSteady: { stateKey: "trend_nursery_floor_steady", type: "number", min: 0 },
  steadyScoreCap: { stateKey: "trend_steady_score_cap", type: "number", min: 0 },
  graduationMinAgeDays: { stateKey: "trend_graduation_min_age_days", type: "number", min: 0 },
  graduationMinDirectEnergy: { stateKey: "trend_graduation_min_direct_energy", type: "number", min: 0 },
  graduationMinEdges: { stateKey: "trend_graduation_min_edges", type: "number", min: 0 },
  graduationMinSources: { stateKey: "trend_graduation_min_sources", type: "number", min: 0 },
  graduationMinOrigins: { stateKey: "trend_graduation_min_origins", type: "number", min: 0 },
  convergenceMinOrphans: { stateKey: "trend_convergence_min_orphans", type: "number", min: 0 },
  convergenceMinSources: { stateKey: "trend_convergence_min_sources", type: "number", min: 0 },
  convergenceMinOrigins: { stateKey: "trend_convergence_min_origins", type: "number", min: 0 },
  convergenceMinEnergy: { stateKey: "trend_convergence_min_energy", type: "number", min: 0 },
  convergenceMinTemporalSpreadHours: { stateKey: "trend_convergence_min_temporal_spread_hours", type: "number", min: 0 },
  protoClusterJoinSimilarity: { stateKey: "trend_proto_cluster_join_similarity", type: "number", min: 0 },
  dedupSimilarity: { stateKey: "trend_dedup_similarity", type: "number", min: 0 },
  autoWireMax: { stateKey: "trend_auto_wire_max", type: "number", min: 0 },
  autoWireMinSimilarity: { stateKey: "trend_auto_wire_min_similarity", type: "number", min: 0 },
  autoWireWeightCap: { stateKey: "trend_auto_wire_weight_cap", type: "number", min: 0 },
  promotionMinEnergy: { stateKey: "trend_promotion_min_energy", type: "number", min: 0 },
  recurrenceMaxIncarnations: { stateKey: "trend_recurrence_max_incarnations", type: "number", min: 0 },
  orphanTtlCurrentHours: { stateKey: "trend_orphan_ttl_current_hours", type: "number", min: 0.1 },
  orphanTtlEphemeralHours: { stateKey: "trend_orphan_ttl_ephemeral_hours", type: "number", min: 0.1 },
  orphanPoolMax: { stateKey: "trend_orphan_pool_max", type: "number", min: 1 },
  protoClusterMaxAgeHours: { stateKey: "trend_proto_cluster_max_age_hours", type: "number", min: 0.1 },
  recentFeedDefaultHours: { stateKey: "trend_recent_feed_default_hours", type: "number", min: 0.1 },
  promotionAmbiguityEnergyBand: { stateKey: "trend_promotion_ambiguity_energy_band", type: "number", min: 0 },
  promotionAmbiguitySimilarityBand: { stateKey: "trend_promotion_ambiguity_similarity_band", type: "number", min: 0 },
  promotionAmbiguityGraceHours: { stateKey: "trend_promotion_ambiguity_grace_hours", type: "number", min: 0 },
  releaseAmbiguityEnergyBand: { stateKey: "trend_release_ambiguity_energy_band", type: "number", min: 0 },
  releaseAmbiguityGraceHours: { stateKey: "trend_release_ambiguity_grace_hours", type: "number", min: 0 },
  liveDedupIntervalMinutes: { stateKey: "trend_live_dedup_interval_minutes", type: "number", min: 1 },
  liveDedupSimilarity: { stateKey: "trend_live_dedup_similarity", type: "number", min: 0 },
  liveDedupMaxBirthGapHours: { stateKey: "trend_live_dedup_max_birth_gap_hours", type: "number", min: 0 },
  liveDedupMinSharedOrigins: { stateKey: "trend_live_dedup_min_shared_origins", type: "number", min: 0 },
  liveDedupAuditCooldownHours: { stateKey: "trend_live_dedup_audit_cooldown_hours", type: "number", min: 0 },
  rssProtoClusterJoinSimilarity: { stateKey: "trend_rss_proto_cluster_join_similarity", type: "number", min: 0 },
  rssMinSharedTerms: { stateKey: "trend_rss_min_shared_terms", type: "number", min: 1 },
  rssPairwiseSupportFloor: { stateKey: "trend_rss_pairwise_support_floor", type: "number", min: 0 },
  rssAdoptSimilarity: { stateKey: "trend_rss_adopt_similarity", type: "number", min: 0 },
  rssAdoptMaxSourceDiversity: { stateKey: "trend_rss_adopt_max_source_diversity", type: "number", min: 1 },
};

const SMOKE_TREND_FIXTURE_PREFIX = "Smoke Trend Fixture";
const DEFAULT_SMOKE_FIXTURE_EDGE_TARGETS: SmokeFixtureEdgeTarget[] = [
  {
    addr: "META.0.3.11",
    fallbackLabel: "Verity Scope",
    relation: "ripples across",
    confidence: 0.82,
    weight: 0.28,
  },
  {
    addr: "OC.0.2.134",
    fallbackLabel: "Verity One Architecture",
    relation: "pressures",
    confidence: 0.79,
    weight: 0.26,
  },
  {
    addr: "CC.0.1.1",
    fallbackLabel: "Agentic Loop",
    relation: "redirects attention toward",
    confidence: 0.77,
    weight: 0.24,
  },
  {
    addr: "CX.0.1.1",
    fallbackLabel: "Task Execution",
    relation: "demands action from",
    confidence: 0.8,
    weight: 0.27,
  },
];

let cachedParams: TrendParams | null = null;
let cachedParamsLoadedAt = 0;

async function recordTrendEvent(input: {
  eventType: string;
  // R3: required. Every event must be tenant-scoped. Pass the linked
  // entity's space_id (orphan, cluster, trend node, or archive) so
  // diagnostics can scope the event feed without joining through 4
  // possible parents.
  spaceId: string;
  stimulusId?: number | null;
  protoClusterId?: string | null;
  trendAddr?: string | null;
  ingestBatchId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO trend_events (event_type, space_id, stimulus_id, proto_cluster_id, trend_addr, ingest_batch_id, payload)
    VALUES (
      ${input.eventType},
      ${input.spaceId},
      ${input.stimulusId ?? null},
      ${input.protoClusterId ?? null},
      ${input.trendAddr ?? null},
      ${input.ingestBatchId ?? null},
      ${sql.json((input.payload || {}) as any)}
    )
  `;
}

async function readActiveProtoClusterHold(clusterId: string, lastFed: Date): Promise<{ holdUntil: Date; sourceAuditId: number | null } | null> {
  const [row] = await sql`
    SELECT hold_until, source_audit_id, updated_at, metadata
    FROM trend_policy_overrides
    WHERE ref_kind = 'proto_cluster'
      AND ref_id = ${clusterId}
      AND action = 'hold_until'
      AND hold_until > now()
    LIMIT 1
  `;
  if (!row) return null;
  const metadata = typeof row.metadata === "string"
    ? JSON.parse(row.metadata)
    : (row.metadata || {});
  const decisionCreatedAt = asDate(metadata.decision_created_at || row.updated_at);
  if (lastFed.getTime() > decisionCreatedAt.getTime()) {
    await sql`
      DELETE FROM trend_policy_overrides
      WHERE ref_kind = 'proto_cluster'
        AND ref_id = ${clusterId}
        AND action = 'hold_until'
    `;
    return null;
  }
  return {
    holdUntil: asDate(row.hold_until),
    sourceAuditId: row.source_audit_id == null ? null : parseInt(row.source_audit_id),
  };
}

async function enqueueTrendDecisionAudit(input: {
  decisionKind: string;
  refKind: "proto_cluster" | "trend";
  refId: string;
  // R3: required. Stable indexed filter for tenant diagnostics; cleaner
  // than deriving via mixed ref_id/trend_addr joins (codex P1).
  spaceId: string;
  trendAddr?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO trend_decision_audits (
      decision_kind, ref_kind, ref_id, space_id, trend_addr, payload
    )
    VALUES (
      ${input.decisionKind},
      ${input.refKind},
      ${input.refId},
      ${input.spaceId},
      ${input.trendAddr ?? null},
      ${sql.json(input.payload as any)}
    )
  `;
}

function parseEmbedding(raw: string | number[] | null): number[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(Number);
  return raw.replace(/[\[\]]/g, "").split(",").filter(Boolean).map(Number);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function avgEmbedding(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += vector[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;
  return centroid;
}

function shouldUseFallbackTrendLabels(): boolean {
  return process.env.VERITY_TRENDS_DISABLE_LLM === "1"
    || !(process.env.OPENCLAW_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY);
}

function currentEnergy(row: Pick<OrphanStimulus, "energy" | "decay_halflife_hours" | "created_at">): number {
  if (!row.decay_halflife_hours || row.decay_halflife_hours <= 0) return row.energy;
  const hoursSince = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
  return row.energy * Math.pow(0.5, hoursSince / row.decay_halflife_hours);
}

function extractSourceType(source: string): string {
  return source.replace(/^(wi:|vi:)/, "");
}

function resolveStimulusSourceType(stimulus: Pick<OrphanStimulus, "source" | "source_id" | "url" | "content" | "origin_key" | "origin_kind" | "origin_label">): string {
  const base = extractSourceType(stimulus.source);
  if (base !== "rss") return base;
  const origin = resolveStimulusOrigin(stimulus);
  if (origin.kind === "host" && origin.label) return `rss:${origin.label.toLowerCase()}`;
  if (origin.key) return `rss:${origin.key.toLowerCase()}`;
  return "rss";
}

function resolveStimulusOrigin(stimulus: Pick<OrphanStimulus, "source" | "source_id" | "url" | "content" | "origin_key" | "origin_kind" | "origin_label">): { key: string; kind: string; label: string } {
  if (stimulus.origin_key) {
    return {
      key: stimulus.origin_key,
      kind: stimulus.origin_kind || "derived",
      label: stimulus.origin_label || stimulus.origin_key,
    };
  }
  const derived = deriveStimulusOrigin({
    sourceType: extractSourceType(stimulus.source),
    sourceId: stimulus.source_id || null,
    url: stimulus.url || null,
    content: stimulus.content,
    sourceExcerpt: stimulus.content,
  });
  return {
    key: derived.originKey,
    kind: derived.originKind,
    label: derived.originLabel,
  };
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function intersectStrings(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const bSet = new Set(b);
  return [...new Set(a.filter((item) => bSet.has(item)))];
}

const RSS_TOPIC_STOPWORDS = new Set([
  "about", "after", "against", "also", "among", "and", "another", "any", "are",
  "around", "article", "articles", "based", "been", "before", "being", "between",
  "blog", "blogs", "both", "business", "but", "can", "company", "companies",
  "could", "daily", "data", "design", "did", "does", "each", "episode", "episodes",
  "even", "every", "find", "first", "for", "from", "get", "had", "has", "have",
  "help", "here", "how", "into", "its", "just", "know", "latest", "launch",
  "launched", "launches", "like", "look", "make", "many", "market", "markets",
  "may", "model", "models", "more", "most", "much", "need", "news", "not", "now",
  "one", "only", "other", "our", "out", "over", "own", "part", "people", "podcast",
  "podcasts", "product", "products", "read", "released", "release", "releases",
  "report", "reports", "research", "researchers", "said", "say", "says", "science",
  "see", "show", "signal", "signals", "some", "startup", "startups", "still",
  "story", "stories", "study", "studies", "such", "system", "systems", "take",
  "tech", "technology", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "thing", "things", "think", "this", "those", "three", "through",
  "time", "today", "too", "two", "update", "updates", "use", "used", "using",
  "very", "video", "videos", "want", "was", "way", "ways", "week", "weekly",
  "well", "were", "what", "when", "where", "which", "while", "who", "will",
  "with", "work", "world", "would", "year", "years", "you", "your",
  "ai", "artificial", "intelligence", "new",
]);

function isRssSourceType(sourceType: string): boolean {
  return sourceType === "rss" || sourceType.startsWith("rss:");
}

function isTrendEligibleSourceType(sourceType: string): boolean {
  return sourceType !== "rss:youtube.com";
}

function normalizeTopicText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .toLowerCase();
}

function extractTopicTerms(text: string): string[] {
  const tokens = normalizeTopicText(text).match(/[a-z][a-z0-9-]{2,}/g) || [];
  const filtered = tokens.filter((token) => !RSS_TOPIC_STOPWORDS.has(token));
  return [...new Set(filtered)];
}

function sharedTopicTerms(a: string, b: string): string[] {
  return intersectStrings(extractTopicTerms(a), extractTopicTerms(b));
}

function buildTopicFrequency(contents: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const content of contents) {
    for (const term of extractTopicTerms(content)) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return counts;
}

export function buildRssCoherenceSnapshot(contents: string[], minSharedTerms: number): {
  repeatedTerms: string[];
  maxTermFrequency: number;
  pairwiseSupport: number;
  dominantTopic: boolean;
  isCoherent: boolean;
} {
  const frequencies = buildTopicFrequency(contents);
  const repeatedTerms = [...frequencies.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);
  const maxTermFrequency = repeatedTerms.length > 0
    ? Math.max(...repeatedTerms.map((term) => frequencies.get(term) || 0))
    : 0;

  let supportedPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < contents.length; i++) {
    for (let j = i + 1; j < contents.length; j++) {
      totalPairs++;
      if (sharedTopicTerms(contents[i], contents[j]).length >= minSharedTerms) {
        supportedPairs++;
      }
    }
  }

  const pairwiseSupport = totalPairs === 0 ? 0 : supportedPairs / totalPairs;
  const dominantTopic = maxTermFrequency >= Math.max(2, Math.ceil(contents.length / 2));
  const isCoherent = (repeatedTerms.length >= minSharedTerms && pairwiseSupport > 0)
    || dominantTopic;

  return {
    repeatedTerms,
    maxTermFrequency,
    pairwiseSupport,
    dominantTopic,
    isCoherent,
  };
}

async function fetchProtoClusterSampleContents(clusterId: string, limit = 6): Promise<string[]> {
  const rows = await sql`
    SELECT content
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id = ${clusterId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row: any) => String(row.content || "")).filter(Boolean);
}

function rssPairCanConverge(a: OrphanStimulus, b: OrphanStimulus, params: TrendParams): boolean {
  const similarity = cosine(a.embedding, b.embedding);
  if (!isRssSourceType(resolveStimulusSourceType(a)) && !isRssSourceType(resolveStimulusSourceType(b))) {
    return similarity >= params.protoClusterJoinSimilarity;
  }
  return similarity >= params.rssProtoClusterJoinSimilarity
    && sharedTopicTerms(a.content, b.content).length >= params.rssMinSharedTerms;
}

async function rssStimulusFitsCluster(orphan: OrphanStimulus, clusterId: string, params: TrendParams): Promise<boolean> {
  const clusterContents = await fetchProtoClusterSampleContents(clusterId);
  if (clusterContents.length === 0) return true;
  let strongestSharedTerms = 0;
  for (const content of clusterContents) {
    strongestSharedTerms = Math.max(strongestSharedTerms, sharedTopicTerms(orphan.content, content).length);
    if (strongestSharedTerms >= params.rssMinSharedTerms) return true;
  }
  return false;
}

function buildTrendPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function normalizeTrendBirthTime(row: any, trendContext: Record<string, any>): Date {
  return trendContext.birth_time
    ? asDate(trendContext.birth_time)
    : asDate(row.created_at);
}

function parseLiveTrendSnapshot(row: any): LiveTrendSnapshot {
  const sourceContext = typeof row.source_context === "string"
    ? JSON.parse(row.source_context)
    : (row.source_context || {});
  const trend = sourceContext.trend || {};
  const substance = typeof row.substance === "string"
    ? JSON.parse(row.substance)
    : (row.substance || {});
  return {
    addr: row.addr,
    label: row.label,
    lifecycle: (trend.lifecycle || "emerging") as TrendLifecycle,
    birthTime: normalizeTrendBirthTime(row, trend),
    createdAt: asDate(row.created_at),
    domains: asStringArray(substance.domains),
    sourceTypes: asStringArray(trend.source_types),
    sourceDiversity: parseInt(trend.source_diversity || 0),
    originKeys: asStringArray(trend.origin_keys),
    originDiversity: parseInt(trend.origin_diversity || 0),
    feedCount: asStringArray(trend.feed_timestamps).length,
    stimulusHeat: parseFloat(row.stimulus_heat || 0),
    embedding: parseEmbedding(row.embedding),
    space_id: row.space_id,
  };
}

function scoreLiveTrendForDedup(trend: LiveTrendSnapshot): number {
  const ageHours = Math.max(0, (Date.now() - trend.birthTime.getTime()) / 3_600_000);
  return (
    trend.stimulusHeat * 4
    + trend.originDiversity * 1.75
    + trend.sourceDiversity * 1.25
    + Math.min(trend.feedCount, 24) * 0.05
    + Math.min(ageHours, 72) * 0.005
  );
}

function chooseDuplicatePrimary(a: LiveTrendSnapshot, b: LiveTrendSnapshot): {
  primary: LiveTrendSnapshot;
  secondary: LiveTrendSnapshot;
  primaryScore: number;
  secondaryScore: number;
} {
  const scoreA = scoreLiveTrendForDedup(a);
  const scoreB = scoreLiveTrendForDedup(b);
  if (scoreA !== scoreB) {
    return scoreA > scoreB
      ? { primary: a, secondary: b, primaryScore: scoreA, secondaryScore: scoreB }
      : { primary: b, secondary: a, primaryScore: scoreB, secondaryScore: scoreA };
  }
  if (a.birthTime.getTime() !== b.birthTime.getTime()) {
    return a.birthTime.getTime() <= b.birthTime.getTime()
      ? { primary: a, secondary: b, primaryScore: scoreA, secondaryScore: scoreB }
      : { primary: b, secondary: a, primaryScore: scoreB, secondaryScore: scoreA };
  }
  return a.addr <= b.addr
    ? { primary: a, secondary: b, primaryScore: scoreA, secondaryScore: scoreB }
    : { primary: b, secondary: a, primaryScore: scoreB, secondaryScore: scoreA };
}

function evaluateLiveTrendDuplicateCandidate(
  a: LiveTrendSnapshot,
  b: LiveTrendSnapshot,
  similarity: number,
  params: TrendParams,
): LiveTrendDuplicateCandidate | null {
  if (similarity < params.liveDedupSimilarity) return null;
  const birthGapHours = Math.abs(a.birthTime.getTime() - b.birthTime.getTime()) / 3_600_000;
  if (birthGapHours > params.liveDedupMaxBirthGapHours) return null;

  const sharedOrigins = intersectStrings(a.originKeys, b.originKeys);
  const sharedDomains = intersectStrings(a.domains, b.domains);
  const sharedSourceTypes = intersectStrings(a.sourceTypes, b.sourceTypes);
  if (sharedOrigins.length < params.liveDedupMinSharedOrigins && sharedDomains.length === 0) {
    return null;
  }

  const chosen = chooseDuplicatePrimary(a, b);
  return {
    pairKey: buildTrendPairKey(a.addr, b.addr),
    primary: chosen.primary,
    secondary: chosen.secondary,
    similarity,
    birthGapHours,
    sharedOrigins,
    sharedDomains,
    sharedSourceTypes,
    primaryScore: chosen.primaryScore,
    secondaryScore: chosen.secondaryScore,
  };
}

function buildClusterDecisionSnapshot(
  cluster: ProtoCluster,
  params: TrendParams,
  options: {
    bestSimilarity?: number | null;
    dedupKind?: "active" | "archive" | null;
    ageHours?: number;
    hoursSinceLastFeed?: number;
  } = {},
): ClusterDecisionSnapshot {
  const ageHours = options.ageHours ?? ((Date.now() - cluster.createdAt.getTime()) / 3_600_000);
  const hoursSinceLastFeed = options.hoursSinceLastFeed ?? ((Date.now() - cluster.lastFed.getTime()) / 3_600_000);
  const bestSimilarity = options.bestSimilarity ?? null;
  const dedupKind = options.dedupKind ?? null;

  const reasons: string[] = [];
  const meetsBase =
    cluster.orphanCount >= params.convergenceMinOrphans
    && cluster.sourceTypes.length >= params.convergenceMinSources
    && cluster.originDiversity >= params.convergenceMinOrigins
    && cluster.totalEnergy >= params.convergenceMinEnergy;

  const promotionBorderline =
    meetsBase
    && ageHours < params.promotionAmbiguityGraceHours
    && (
      cluster.orphanCount === params.convergenceMinOrphans
      || cluster.sourceTypes.length === params.convergenceMinSources
      || cluster.originDiversity === params.convergenceMinOrigins
      || cluster.totalEnergy < params.convergenceMinEnergy + params.promotionAmbiguityEnergyBand
      || (bestSimilarity != null && Math.abs(bestSimilarity - params.dedupSimilarity) <= params.promotionAmbiguitySimilarityBand)
    );

  const releaseBorderline =
    ageHours > params.protoClusterMaxAgeHours
    && cluster.orphanCount < params.convergenceMinOrphans
    && hoursSinceLastFeed <= params.releaseAmbiguityGraceHours
    && (
      cluster.orphanCount >= Math.max(1, params.convergenceMinOrphans - 1)
      || cluster.sourceTypes.length >= Math.max(1, params.convergenceMinSources - 1)
      || cluster.originDiversity >= Math.max(1, params.convergenceMinOrigins - 1)
      || cluster.totalEnergy >= Math.max(0, params.convergenceMinEnergy - params.releaseAmbiguityEnergyBand)
    );

  if (cluster.orphanCount < params.convergenceMinOrphans) reasons.push("needs_more_orphans");
  if (cluster.sourceTypes.length < params.convergenceMinSources) reasons.push("needs_more_sources");
  if (cluster.originDiversity < params.convergenceMinOrigins) reasons.push("needs_more_origins");
  if (cluster.totalEnergy < params.convergenceMinEnergy) reasons.push("needs_more_energy");
  if (promotionBorderline) reasons.push("promotion_borderline");
  if (releaseBorderline) reasons.push("release_borderline");
  if (bestSimilarity != null && Math.abs(bestSimilarity - params.dedupSimilarity) <= params.promotionAmbiguitySimilarityBand) {
    reasons.push("dedup_similarity_borderline");
  }

  let action: ClusterDecisionSnapshot["action"] = "await_more_signal";
  let recommendedAction: ClusterDecisionSnapshot["recommendedAction"] = "wait_for_more_signal";

  if (releaseBorderline) {
    action = "hold_borderline_release";
    recommendedAction = "monitor_next_feed";
  } else if (ageHours > params.protoClusterMaxAgeHours && cluster.orphanCount < params.convergenceMinOrphans) {
    action = "release";
    recommendedAction = "release_cluster";
  } else if (!meetsBase) {
    action = "await_more_signal";
    recommendedAction = "wait_for_more_signal";
  } else if (promotionBorderline) {
    action = "hold_borderline_promotion";
    recommendedAction = "monitor_next_feed";
  } else if (dedupKind === "active") {
    action = "adopt";
    recommendedAction = "adopt_cluster";
  } else if (dedupKind === "archive") {
    action = "recur";
    recommendedAction = "recur_trend";
  } else {
    action = "birth";
    recommendedAction = "promote_cluster";
  }

  return {
    action,
    borderline: promotionBorderline || releaseBorderline,
    reasons,
    metrics: {
      orphan_count: cluster.orphanCount,
      source_diversity: cluster.sourceTypes.length,
      origin_diversity: cluster.originDiversity,
      total_energy: cluster.totalEnergy,
      age_hours: ageHours,
      hours_since_last_feed: hoursSinceLastFeed,
      best_similarity: bestSimilarity,
      dedup_kind: dedupKind,
    },
    recommendedAction,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildTrendSourceContext(input: {
  lifecycle: TrendLifecycle;
  birthTime: string;
  nurseryUntil: string;
  sourceTypes: string[];
  sourceDiversity: number;
  originKeys: string[];
  originDiversity: number;
  incarnation: number;
  priorIncarnationAddr: string | null;
  feedTimestamps: string[];
  velocity: number;
  currentHalflifeHours: number;
  graduationEligible: boolean;
  peakEnergy: number;
  lastStimulusAt: string | null;
  avgDirectEnergy7d: number;
}): Record<string, any> {
  return {
    birth_time: input.birthTime,
    source_diversity: input.sourceDiversity,
    source_types: input.sourceTypes,
    origin_diversity: input.originDiversity,
    origin_keys: input.originKeys,
    velocity: input.velocity,
    lifecycle: input.lifecycle,
    graduation_eligible: input.graduationEligible,
    incarnation: input.incarnation,
    prior_incarnation_addr: input.priorIncarnationAddr,
    feed_timestamps: input.feedTimestamps,
    nursery_until: input.nurseryUntil,
    current_halflife_hours: input.currentHalflifeHours,
    peak_energy: input.peakEnergy,
    last_stimulus_at: input.lastStimulusAt,
    avg_direct_energy_7d: input.avgDirectEnergy7d,
  };
}

async function evaluateRssTrendAdoption(
  trendAddr: string,
  clusterContents: string[],
  bestSimilarity: number,
  params: TrendParams,
): Promise<{
  allowed: boolean;
  sharedTerms: string[];
  trendSourceDiversity: number;
  reasons: string[];
}> {
  const [trend] = await sql`
    SELECT label, substance, source_context
    FROM nodes
    WHERE addr = ${trendAddr}
      AND node_type = 'trend'
  `;
  if (!trend) {
    return { allowed: false, sharedTerms: [], trendSourceDiversity: 0, reasons: ["missing_trend"] };
  }

  const sourceContext = typeof trend.source_context === "string"
    ? JSON.parse(trend.source_context)
    : (trend.source_context || {});
  const trendCtx = sourceContext.trend || {};
  const trendSourceDiversity = parseInt(trendCtx.source_diversity || 0, 10) || 0;
  const trendText = [
    String(trend.label || ""),
    String(trend.substance?.description || ""),
    String(trend.substance?.summary || ""),
    ...(Array.isArray(trend.substance?.domains) ? trend.substance.domains.map((value: any) => String(value)) : []),
  ].join(" ");

  const clusterTerms = buildRssCoherenceSnapshot(clusterContents, params.rssMinSharedTerms).repeatedTerms;
  const sharedTerms = clusterTerms.length > 0
    ? intersectStrings(clusterTerms, extractTopicTerms(trendText))
    : [];

  const reasons: string[] = [];
  if (bestSimilarity < params.rssAdoptSimilarity) reasons.push("similarity_below_rss_adopt_floor");
  if (sharedTerms.length < params.rssMinSharedTerms) reasons.push("insufficient_topic_overlap");
  if (trendSourceDiversity > params.rssAdoptMaxSourceDiversity) reasons.push("active_trend_too_broad");

  return {
    allowed: reasons.length === 0,
    sharedTerms,
    trendSourceDiversity,
    reasons,
  };
}

function normalizeSmokeFixtureEdgeTargets(rawTargets: any): SmokeFixtureEdgeTarget[] {
  const inputTargets = Array.isArray(rawTargets) && rawTargets.length > 0
    ? rawTargets
    : DEFAULT_SMOKE_FIXTURE_EDGE_TARGETS;
  return inputTargets
    .map((target: any) => ({
      addr: String(target?.addr || "").trim(),
      fallbackLabel: String(target?.fallback_label || target?.fallbackLabel || "").trim(),
      relation: String(target?.relation || "pressures").trim(),
      confidence: Number.isFinite(Number(target?.confidence)) ? Number(target.confidence) : 0.78,
      weight: Number.isFinite(Number(target?.weight)) ? Number(target.weight) : 0.25,
    }))
    .filter((target) => target.addr.length > 0);
}

function buildSmokeFixtureConfig(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    ...overrides,
    enabled: true,
    fixture_key: "smoke-trend-fixture",
    relation_targets: normalizeSmokeFixtureEdgeTargets(overrides.relation_targets),
    seeded_from: "seed-smoke-trend",
  };
}

function resolveSmokeFixtureConfig(input: {
  orphans?: OrphanStimulus[];
  archivedSourceContext?: Record<string, any>;
}): Record<string, any> | null {
  const archivedFixture = input.archivedSourceContext?.smoke_fixture;
  if (archivedFixture) {
    return buildSmokeFixtureConfig(archivedFixture);
  }

  const looksLikeSmokeFixture = (input.orphans || []).some((orphan) =>
    String(orphan.content || "").includes(SMOKE_TREND_FIXTURE_PREFIX)
    || String(orphan.ingest_batch_id || "").includes("smoke:trend-fixture"),
  );
  if (!looksLikeSmokeFixture) return null;

  return buildSmokeFixtureConfig();
}

export async function loadTrendParams(): Promise<TrendParams> {
  if (cachedParams && (Date.now() - cachedParamsLoadedAt) < TREND_PARAM_CACHE_MS) return cachedParams;
  const rows = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key LIKE 'trend_%'
  `;
  cachedParams = hydrateTrendParamsFromRows(rows as any);
  cachedParamsLoadedAt = Date.now();
  return cachedParams;
}

export function invalidateTrendParamCache(): void {
  cachedParams = null;
  cachedParamsLoadedAt = 0;
}

function hydrateTrendParamsFromRows(rows: Array<{ key: string; value: string }>): TrendParams {
  const map = new Map<string, string>(rows.map((row: any) => [row.key, row.value]));
  const params: Partial<TrendParams> = {};

  for (const [name, def] of Object.entries(TREND_PARAM_DEFS) as [TrendParamKey, TrendParamDef][]) {
    const raw = map.get(def.stateKey);
    const fallback = DEFAULT_PARAMS[name];
    if (def.type === "boolean") {
      setTrendParam(params, name, raw == null ? fallback : raw === "true");
      continue;
    }
    const numeric = Number.parseFloat(raw ?? String(fallback));
    setTrendParam(params, name, Number.isFinite(numeric) ? numeric : fallback);
  }

  return params as TrendParams;
}

function setTrendParam(target: Partial<TrendParams>, name: TrendParamKey, value: boolean | number): void {
  (target as Record<string, boolean | number>)[name] = value;
}

function serializeTrendParamValue(name: TrendParamKey, value: TrendParams[TrendParamKey]): string {
  if (TREND_PARAM_DEFS[name].type === "boolean") return value ? "true" : "false";
  return String(value);
}

function normalizeTrendParamPatch(input: Record<string, unknown>): Partial<TrendParams> {
  const patch: Partial<TrendParams> = {};
  for (const [name, def] of Object.entries(TREND_PARAM_DEFS) as [TrendParamKey, TrendParamDef][]) {
    if (!(name in input)) continue;
    const raw = input[name];
    if (def.type === "boolean") {
      if (typeof raw !== "boolean") {
        throw new Error(`Trend config field ${name} must be boolean`);
      }
      setTrendParam(patch, name, raw);
      continue;
    }
    const numeric = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(numeric)) {
      throw new Error(`Trend config field ${name} must be numeric`);
    }
    if (def.min != null && numeric < def.min) {
      throw new Error(`Trend config field ${name} must be >= ${def.min}`);
    }
    setTrendParam(patch, name, numeric);
  }
  return patch;
}

function buildNumericSummary(values: number[]): { count: number; min: number | null; median: number | null; avg: number | null; max: number | null } {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return { count: 0, min: null, median: null, avg: null, max: null };
  }
  const total = clean.reduce((sum, value) => sum + value, 0);
  return {
    count: clean.length,
    min: Math.min(...clean),
    median: median(clean),
    avg: total / clean.length,
    max: Math.max(...clean),
  };
}

export async function getTrendConfigState(): Promise<any> {
  const params = await loadTrendParams();
  return {
    params,
    defaults: DEFAULT_PARAMS,
    graph_state_keys: Object.fromEntries(
      (Object.entries(TREND_PARAM_DEFS) as [TrendParamKey, TrendParamDef][])
        .map(([name, def]) => [name, def.stateKey]),
    ),
    doctrine: {
      decay_model: "steady_sustained_multi_origin_signal_extends_halflife; bursty_novelty_spikes_decay_fast_unless_reinforced",
      actionable_posture: "fast spikes attract attention immediately; slow-build trends earn confidence over time before becoming more actionable",
      tuning_note: "Adjust cautiously; prioritize truth retention and agent actionability over raw trend volume.",
    },
    cache: {
      ttl_ms: TREND_PARAM_CACHE_MS,
      loaded_at: cachedParamsLoadedAt ? new Date(cachedParamsLoadedAt).toISOString() : null,
    },
  };
}

export async function updateTrendConfigState(input: Record<string, unknown>): Promise<any> {
  const payload = (input?.params && typeof input.params === "object")
    ? input.params as Record<string, unknown>
    : input;
  const patch = normalizeTrendParamPatch(payload || {});
  const entries = Object.entries(patch) as [TrendParamKey, TrendParams[TrendParamKey]][];
  if (entries.length === 0) {
    throw new Error("No valid trend config fields provided");
  }

  for (const [name, value] of entries) {
    const stateKey = TREND_PARAM_DEFS[name].stateKey;
    await sql`
      INSERT INTO graph_state (key, value)
      VALUES (${stateKey}, ${serializeTrendParamValue(name, value)})
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }

  invalidateTrendParamCache();
  const state = await getTrendConfigState();
  return {
    ...state,
    updated_fields: entries.map(([name]) => name),
  };
}

async function fetchOrphanStimulus(id: number): Promise<OrphanStimulus | null> {
  const [row] = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours,
      created_at, embedding::text, proto_cluster_id, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE id = ${id}
      AND is_orphan = true
      AND orphan_status = 'throbbing'
      AND embedding IS NOT NULL
  `;
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: row.proto_cluster_id,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    // R3: tenant scope from foundation column.
    space_id: row.space_id,
  };
}

async function fetchProtoClusters(): Promise<ProtoCluster[]> {
  const rows = await sql`
    SELECT id, centroid::text, orphan_count, source_types, origin_keys, origin_diversity, total_energy, created_at, last_fed, space_id
    FROM wi_proto_clusters
    ORDER BY created_at ASC
  `;
  return rows.map((row: any) => ({
    id: row.id,
    centroid: parseEmbedding(row.centroid),
    orphanCount: parseInt(row.orphan_count),
    sourceTypes: row.source_types || [],
    originKeys: row.origin_keys || [],
    originDiversity: parseInt(row.origin_diversity || 0),
    totalEnergy: parseFloat(row.total_energy),
    createdAt: asDate(row.created_at),
    lastFed: asDate(row.last_fed),
    // R3: tenant scope from foundation column.
    space_id: row.space_id,
  }));
}

async function refreshProtoCluster(clusterId: string): Promise<ProtoCluster | null> {
  const members = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours, created_at, embedding::text, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id = ${clusterId}
      AND embedding IS NOT NULL
  `;

  if (members.length === 0) {
    await sql`DELETE FROM wi_proto_clusters WHERE id = ${clusterId}`;
    return null;
  }

  // R3: assert all members agree on space_id. If they don't, the cluster
  // was poisoned by ingest-time logic that bypassed the per-space filter —
  // refuse to refresh and return null so the caller drops it cleanly.
  const memberSpaces = new Set(members.map((row: any) => row.space_id));
  if (memberSpaces.size !== 1) {
    throw new Error(`R3 invariant: refreshProtoCluster member-space mismatch on ${clusterId}: [${[...memberSpaces].join(", ")}]`);
  }

  const orphans: OrphanStimulus[] = members.map((row: any) => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: clusterId,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    space_id: row.space_id,
  }));

  const centroid = avgEmbedding(orphans.map((row) => row.embedding));
  const totalEnergy = orphans.reduce((sum, row) => sum + currentEnergy(row), 0);
  const sourceTypes = [...new Set(orphans.map((row) => resolveStimulusSourceType(row)))];
  const originKeys = [...new Set(orphans.map((row) => resolveStimulusOrigin(row).key))];
  const lastFed = new Date(Math.max(...orphans.map((row) => row.created_at.getTime())));

  const centroidStr = toVectorStr(centroid);
  const [updated] = await sql`
    UPDATE wi_proto_clusters
    SET centroid = ${centroidStr}::halfvec,
      orphan_count = ${orphans.length},
      source_types = ${sourceTypes},
      origin_keys = ${originKeys},
      origin_diversity = ${originKeys.length},
      total_energy = ${totalEnergy},
      last_fed = ${lastFed.toISOString()}
    WHERE id = ${clusterId}
    RETURNING id, centroid::text, orphan_count, source_types, origin_keys, origin_diversity, total_energy, created_at, last_fed, space_id
  `;

  return updated ? {
    id: updated.id,
    centroid: parseEmbedding(updated.centroid),
    orphanCount: parseInt(updated.orphan_count),
    sourceTypes: updated.source_types || [],
    originKeys: updated.origin_keys || [],
    originDiversity: parseInt(updated.origin_diversity || 0),
    totalEnergy: parseFloat(updated.total_energy),
    createdAt: asDate(updated.created_at),
    lastFed: asDate(updated.last_fed),
    space_id: updated.space_id,
  } : null;
}

async function createClusterFromStimuli(stimulusIds: number[]): Promise<string> {
  const rows = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours, created_at, embedding::text, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE id = ANY(${stimulusIds}::int[])
      AND is_orphan = true
      AND orphan_status = 'throbbing'
      AND embedding IS NOT NULL
  `;
  if (rows.length === 0) {
    throw new Error("Cannot create proto-cluster without orphan stimuli");
  }

  // R3: all stimuli forming this cluster must agree on space_id; if they
  // don't, this is a bug upstream (cross-tenant grouping). Refuse to
  // create the cluster.
  const distinctSpaces = new Set(rows.map((r: any) => r.space_id));
  if (distinctSpaces.size !== 1) {
    throw new Error(`R3 invariant: createClusterFromStimuli requires a single space_id; got [${[...distinctSpaces].join(", ")}]`);
  }
  const clusterSpaceId = rows[0].space_id;

  const orphans: OrphanStimulus[] = rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: null,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    space_id: row.space_id,
  }));

  const centroid = avgEmbedding(orphans.map((row) => row.embedding));
  const totalEnergy = orphans.reduce((sum, row) => sum + currentEnergy(row), 0);
  const sourceTypes = [...new Set(orphans.map((row) => resolveStimulusSourceType(row)))];
  const originKeys = [...new Set(orphans.map((row) => resolveStimulusOrigin(row).key))];
  const centroidStr = toVectorStr(centroid);
  const [created] = await sql`
    INSERT INTO wi_proto_clusters (centroid, orphan_count, source_types, origin_keys, origin_diversity, total_energy, space_id)
    VALUES (${centroidStr}::halfvec, ${orphans.length}, ${sourceTypes}, ${originKeys}, ${originKeys.length}, ${totalEnergy}, ${clusterSpaceId})
    RETURNING id
  `;
  await sql`
    UPDATE stimuli
    SET proto_cluster_id = ${created.id}
    WHERE id = ANY(${stimulusIds}::int[])
  `;
  return created.id;
}

// R3: clusterStandaloneOrphans is now per-space. Caller (runTrendMaintenance)
// discovers distinct space_ids from stimuli + proto-clusters and loops.
// Each invocation operates within one space; cross-space union is forbidden
// at the WHERE filter, eliminating the foundational data-leak risk.
async function clusterStandaloneOrphans(params: TrendParams, spaceId: string): Promise<number> {
  const rows = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours, created_at, embedding::text, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id IS NULL
      AND embedding IS NOT NULL
      AND space_id = ${spaceId}
    ORDER BY created_at ASC
  `;
  if (rows.length < 2) return 0;

  const orphans: OrphanStimulus[] = rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: null,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    space_id: row.space_id,
  })).filter((row) => isTrendEligibleSourceType(resolveStimulusSourceType(row)));

  const parent = Array.from({ length: orphans.length }, (_, idx) => idx);
  const find = (idx: number): number => {
    if (parent[idx] !== idx) parent[idx] = find(parent[idx]);
    return parent[idx];
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < orphans.length; i++) {
    for (let j = i + 1; j < orphans.length; j++) {
      if (rssPairCanConverge(orphans[i], orphans[j], params)) {
        unite(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < orphans.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  let created = 0;
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const ids = indexes.map((idx) => orphans[idx].id);
    const protoClusterId = await createClusterFromStimuli(ids);
    await recordTrendEvent({
      eventType: "proto_cluster_created",
      spaceId: spaceId,
      protoClusterId,
      ingestBatchId: orphans[indexes[0]]?.ingest_batch_id || null,
      payload: {
        member_ids: ids,
        trigger: "maintenance_grouping",
      },
    });
    created++;
  }
  return created;
}

export async function attachOrphanToTrendPool(stimulusId: number): Promise<{ status: "standalone" | "cluster_joined" | "cluster_created"; protoClusterId: string | null }> {
  // R2: outermost machine-level kill switch. VI/WI ingest paths call this
  // outside `runTrendMaintenance`, so the same short-circuit must apply
  // here or stimuli would still be clustered when the operator has the
  // toggle off.
  const settings = resolveTenantSettings();
  if (!settings.trends_enabled) return { status: "standalone", protoClusterId: null };

  const params = await loadTrendParams();
  if (!params.enabled) return { status: "standalone", protoClusterId: null };

  const orphan = await fetchOrphanStimulus(stimulusId);
  // R4: per-tenant gate. If the orphan's space is a tenant space and
  // that tenant has not opted into trends, do not cluster — leave it
  // as a standalone stimulus. Global stimuli (`space_id='global'`)
  // always proceed; expireOrphans/enforceOrphanPoolCap still apply.
  if (orphan && orphan.space_id !== "global") {
    const enabledTenantSpaces = await listEnabledTenantSpaces(sql as any);
    if (!enabledTenantSpaces.includes(orphan.space_id)) {
      return { status: "standalone", protoClusterId: null };
    }
  }
  if (!orphan || !orphan.temporality || orphan.temporality === "DURABLE") {
    return { status: "standalone", protoClusterId: null };
  }
  const vectorStr = toVectorStr(orphan.embedding);
  const maxDistance = Math.max(0, 1 - params.protoClusterJoinSimilarity);

  // R3: ingest-time clustering must NOT cross spaces. A tenant orphan
  // must never attach to a global or other-tenant cluster — even if the
  // embedding similarity is high. Filter by orphan.space_id so the
  // best-match candidate is restricted to the orphan's own space.
  const [bestCluster] = await sql`
    SELECT id, 1 - (centroid <=> ${vectorStr}::halfvec) as similarity
    FROM wi_proto_clusters
    WHERE centroid IS NOT NULL
      AND space_id = ${orphan.space_id}
    ORDER BY centroid <=> ${vectorStr}::halfvec
    LIMIT 1
  `;

  const orphanSourceType = resolveStimulusSourceType(orphan);
  if (!isTrendEligibleSourceType(orphanSourceType)) {
    await recordTrendEvent({
      eventType: "orphan_attached",
      spaceId: orphan.space_id,
      stimulusId,
      ingestBatchId: orphan.ingest_batch_id,
      payload: {
        status: "standalone",
        temporality: orphan.temporality,
        source: orphan.source,
        reason: "source_type_excluded_from_trend_pool",
      },
    });
    return { status: "standalone", protoClusterId: null };
  }
  const joinThreshold = isRssSourceType(orphanSourceType)
    ? params.rssProtoClusterJoinSimilarity
    : params.protoClusterJoinSimilarity;

  if (bestCluster && parseFloat(bestCluster.similarity || 0) >= joinThreshold) {
    if (isRssSourceType(orphanSourceType)) {
      const fitsCluster = await rssStimulusFitsCluster(orphan, bestCluster.id, params);
      if (!fitsCluster) {
        await enforceOrphanPoolCap();
        return { status: "standalone", protoClusterId: null };
      }
    }
    await sql`
      UPDATE stimuli
      SET proto_cluster_id = ${bestCluster.id}
      WHERE id = ${stimulusId}
    `;
    await refreshProtoCluster(bestCluster.id);
    await enforceOrphanPoolCap();
    await recordTrendEvent({
      eventType: "proto_cluster_joined",
      spaceId: orphan.space_id,
      stimulusId,
      protoClusterId: bestCluster.id,
      ingestBatchId: orphan.ingest_batch_id,
      payload: {
        similarity: parseFloat(bestCluster.similarity || 0),
        temporality: orphan.temporality,
        source: orphan.source,
      },
    });
    return { status: "cluster_joined", protoClusterId: bestCluster.id };
  }

  // R3: standalone stimulus lookup is space-scoped — same rationale
  // as the proto-cluster best-match above.
  const standalones = await sql`
    SELECT id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id IS NULL
      AND id != ${stimulusId}
      AND embedding IS NOT NULL
      AND space_id = ${orphan.space_id}
      AND (embedding <=> ${vectorStr}::halfvec) <= ${maxDistance}
    ORDER BY embedding <=> ${vectorStr}::halfvec
    LIMIT ${Math.max(32, Math.ceil(params.convergenceMinOrphans * 8))}
  `;
  const similarStandalones = standalones.map((row: any) => row.id);

  if (similarStandalones.length > 0) {
    const protoClusterId = await createClusterFromStimuli([stimulusId, ...similarStandalones]);
    await refreshProtoCluster(protoClusterId);
    await enforceOrphanPoolCap();
    await recordTrendEvent({
      eventType: "proto_cluster_created",
      spaceId: orphan.space_id,
      stimulusId,
      protoClusterId,
      ingestBatchId: orphan.ingest_batch_id,
      payload: {
        member_ids: [stimulusId, ...similarStandalones],
        temporality: orphan.temporality,
        source: orphan.source,
      },
    });
    return { status: "cluster_created", protoClusterId };
  }

  await enforceOrphanPoolCap();
  await recordTrendEvent({
    eventType: "orphan_attached",
    spaceId: orphan.space_id,
    stimulusId,
    ingestBatchId: orphan.ingest_batch_id,
    payload: {
      status: "standalone",
      temporality: orphan.temporality,
      source: orphan.source,
    },
  });
  return { status: "standalone", protoClusterId: null };
}

async function enforceOrphanPoolCap(): Promise<number> {
  const params = await loadTrendParams();
  const [totals] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'throbbing') as total_orphans
    FROM stimuli
  `;
  const totalOrphans = parseInt(totals.total_orphans || 0);
  if (totalOrphans <= params.orphanPoolMax) return 0;

  const overflow = totalOrphans - params.orphanPoolMax;
  if (overflow <= 0) return 0;

  const evictedRows = await sql`
    WITH ranked AS (
      SELECT id, ingest_batch_id
      FROM stimuli
      WHERE is_orphan = true
        AND orphan_status = 'throbbing'
        AND proto_cluster_id IS NULL
      ORDER BY
        CASE
          WHEN COALESCE(decay_halflife_hours, 0) <= 0 THEN COALESCE(energy, 1)
          ELSE COALESCE(energy, 1) * EXP(-0.693 * EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 / decay_halflife_hours)
        END ASC,
        created_at ASC
      LIMIT ${overflow}
    ),
    updated AS (
      UPDATE stimuli s
      SET orphan_status = 'dissolved'
      FROM ranked r
      WHERE s.id = r.id
      RETURNING s.id, s.ingest_batch_id, s.space_id
    )
    SELECT id, ingest_batch_id, space_id
    FROM updated
  `;

  for (const row of evictedRows) {
    await recordTrendEvent({
      eventType: "orphan_dissolved",
      spaceId: row.space_id,
      stimulusId: row.id,
      ingestBatchId: row.ingest_batch_id || null,
      payload: { reason: "pool_cap_eviction" },
    });
  }

  return evictedRows.length;
}

async function expireOrphans(): Promise<number> {
  const params = await loadTrendParams();
  const rows = await sql`
    SELECT id, temporality, proto_cluster_id, ingest_batch_id, space_id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND (
        (
          temporality = 'EPHEMERAL'
          AND created_at <= now() - (${params.orphanTtlEphemeralHours} * interval '1 hour')
        )
        OR (
          (temporality IS NULL OR temporality != 'EPHEMERAL')
          AND created_at <= now() - (${params.orphanTtlCurrentHours} * interval '1 hour')
        )
        OR (
          CASE
            WHEN COALESCE(decay_halflife_hours, 0) <= 0 THEN COALESCE(energy, 1)
            ELSE COALESCE(energy, 1) * EXP(-0.693 * EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 / decay_halflife_hours)
          END
        ) < 0.01
      )
  `;

  const expiredIds = rows.map((row: any) => row.id);
  const affectedClusters = new Set<string>(rows.map((row: any) => row.proto_cluster_id).filter(Boolean));

  if (expiredIds.length > 0) {
    await sql`
      UPDATE stimuli
      SET orphan_status = 'dissolved',
        proto_cluster_id = NULL
      WHERE id = ANY(${expiredIds}::int[])
    `;
    for (const row of rows) {
      await recordTrendEvent({
        eventType: "orphan_dissolved",
        spaceId: row.space_id,
        stimulusId: row.id,
        protoClusterId: row.proto_cluster_id,
        ingestBatchId: row.ingest_batch_id || null,
        payload: {
          reason: "ttl_or_decay",
          temporality: row.temporality,
        },
      });
    }
  }

  for (const clusterId of affectedClusters) {
    await refreshProtoCluster(clusterId);
  }
  return expiredIds.length;
}

async function computeTrendStats(node: any, params: TrendParams): Promise<TrendStats> {
  const sourceContext = typeof node.source_context === "string"
    ? JSON.parse(node.source_context)
    : (node.source_context || {});
  const trendCtx = sourceContext.trend || {};
  const birthTime = trendCtx.birth_time ? new Date(trendCtx.birth_time) : asDate(node.created_at);

  const feedRows = await sql`
    SELECT s.id, s.source, s.source_id, s.url, s.content, s.origin_key, s.origin_kind, s.origin_label, s.created_at,
      sc.base_contribution,
      compute_decay(
        s.created_at,
        COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
        COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
        sc.base_contribution
      ) as live_contribution
    FROM stimulus_contributions sc
    JOIN stimuli s ON s.id = sc.stimulus_id
    WHERE sc.node_addr = ${node.addr}
    ORDER BY s.created_at ASC
  `;

  const now = Date.now();
  const bySource = new Set<string>();
  const byOrigin = new Set<string>();
  const recentHourSources = new Set<string>();
  const recentHourOrigins = new Set<string>();
  const feedTimestamps = feedRows.slice(-12).map((row: any) => asDate(row.created_at).toISOString());
  let liveHeat = 0;
  let recent7dTotal = 0;
  let recent7dCount = 0;
  let postBirthStimulusSeen = false;
  let lastStimulusAt: string | null = null;
  const intervals: number[] = [];
  const bucketSet = new Set<number>();

  for (let i = 0; i < feedRows.length; i++) {
    const row = feedRows[i];
    const createdAt = asDate(row.created_at);
    const sourceType = resolveStimulusSourceType({
      source: row.source,
      source_id: row.source_id,
      url: row.url,
      content: row.content,
      origin_key: row.origin_key,
      origin_kind: row.origin_kind,
      origin_label: row.origin_label,
    });
    const origin = resolveStimulusOrigin({
      source: row.source,
      source_id: row.source_id,
      url: row.url,
      content: row.content,
      origin_key: row.origin_key,
      origin_kind: row.origin_kind,
      origin_label: row.origin_label,
    });
    bySource.add(sourceType);
    byOrigin.add(origin.key);
    liveHeat += parseFloat(row.live_contribution || 0);
    if (createdAt.getTime() > now - 3_600_000) recentHourSources.add(sourceType);
    if (createdAt.getTime() > now - 3_600_000) recentHourOrigins.add(origin.key);
    if (createdAt.getTime() > now - 7 * 24 * 3_600_000) {
      recent7dTotal += parseFloat(row.live_contribution || 0);
      recent7dCount++;
    }
    if (createdAt.getTime() > birthTime.getTime() && parseFloat(row.base_contribution || 0) >= params.promotionMinEnergy) {
      postBirthStimulusSeen = true;
    }
    if (!lastStimulusAt || createdAt.getTime() > new Date(lastStimulusAt).getTime()) {
      lastStimulusAt = createdAt.toISOString();
    }
    if (i > 0) {
      const prev = asDate(feedRows[i - 1].created_at);
      intervals.push((createdAt.getTime() - prev.getTime()) / 3_600_000);
    }
    const bucket = Math.floor(createdAt.getTime() / (6 * 3_600_000));
    bucketSet.add(bucket);
  }

  const ageHours = (now - birthTime.getTime()) / 3_600_000;
  const consistencyHours = Math.min(params.steadyScoreCap * 24, bucketSet.size * 6);
  let steadyScore = Math.min(consistencyHours / 24, params.steadyScoreCap);
  const nurseryUntil = trendCtx.nursery_until
    ? new Date(trendCtx.nursery_until).getTime()
    : birthTime.getTime() + params.nurseryHours * 3_600_000;
  if (now < nurseryUntil) {
    steadyScore = Math.max(steadyScore, params.nurseryFloorSteady);
  }

  const velocity = recentHourOrigins.size / Math.max(byOrigin.size, 1);
  const effectiveHalflifeHours = Math.max(
    1,
    params.baseHalflifeHours * (1 + steadyScore) / (1 + velocity),
  );

  const recentFeedIntervalHours = Math.max(
    1,
    median(intervals.filter((value) => Number.isFinite(value) && value > 0)) || params.recentFeedDefaultHours,
  );

  let lifecycle: TrendLifecycle = "emerging";
  if (liveHeat < 0.01 || (ageHours > params.maxAgeDays * 24 && liveHeat < 0.1)) {
    lifecycle = "dead";
  } else if (ageHours > 48 && recent7dCount > 0 && (recent7dTotal / recent7dCount) > 0.3) {
    lifecycle = "sustained";
  } else if (lastStimulusAt && (now - new Date(lastStimulusAt).getTime()) / 3_600_000 > recentFeedIntervalHours * 2) {
    lifecycle = "cooling";
  } else if (postBirthStimulusSeen) {
    lifecycle = "active";
  }

  const [edgeCountRow] = await sql`
    SELECT COUNT(*)::int as n FROM edges
    WHERE from_addr = ${node.addr} OR to_addr = ${node.addr}
  `;
  const edgeCount = parseInt(edgeCountRow.n);

  const avgDirectEnergy7d = recent7dCount > 0 ? recent7dTotal / recent7dCount : 0;
  const graduationEligible =
    ageHours >= params.graduationMinAgeDays * 24 &&
    avgDirectEnergy7d >= params.graduationMinDirectEnergy &&
    edgeCount >= params.graduationMinEdges &&
    bySource.size >= params.graduationMinSources &&
    byOrigin.size >= params.graduationMinOrigins;

  return {
    liveHeat,
    avgDirectEnergy7d,
    sourceDiversity: bySource.size,
    sourceTypes: [...bySource],
    originDiversity: byOrigin.size,
    originKeys: [...byOrigin].slice(-12),
    newSourcesLastHour: recentHourSources.size,
    newOriginsLastHour: recentHourOrigins.size,
    totalSources: bySource.size,
    totalOrigins: byOrigin.size,
    consistencyHours,
    recentFeedIntervalHours,
    postBirthStimulusSeen,
    lastStimulusAt,
    feedTimestamps,
    directStimulusCount: feedRows.length,
    edgeCount,
    effectiveHalflifeHours,
    lifecycle,
    graduationEligible,
    peakEnergy: Math.max(parseFloat(trendCtx.peak_energy || 0), liveHeat),
    velocity,
  };
}

async function syncTrendContributionOverrides(nodeAddr: string, halflifeHours: number): Promise<void> {
  await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
    await tx`
      UPDATE stimulus_contributions
      SET decay_halflife_hours_override = ${halflifeHours},
        peak_delay_hours_override = 0
      WHERE node_addr = ${nodeAddr}
    `;
  });
}

async function computeTrendCentroid(nodeAddr: string): Promise<number[] | null> {
  const rows = await sql`
    SELECT s.embedding::text as embedding
    FROM stimulus_contributions sc
    JOIN stimuli s ON s.id = sc.stimulus_id
    WHERE sc.node_addr = ${nodeAddr}
      AND s.embedding IS NOT NULL
    ORDER BY s.created_at ASC
  `;

  if (rows.length === 0) return null;
  return avgEmbedding(rows.map((row: any) => parseEmbedding(row.embedding)));
}

async function syncActiveTrendCentroid(nodeAddr: string, label: string, lifecycle: TrendLifecycle): Promise<void> {
  const centroid = await computeTrendCentroid(nodeAddr);
  if (!centroid || centroid.length === 0) return;

  // F7: derived vector write — refresh the four marker columns alongside
  // the centroid so the row stays classified as DERIVED_CENTROID.
  const centroidStr = toVectorStr(centroid);
  const centroidMeta = embeddingMetadataForVectorWrite("DERIVED_CENTROID");
  // R3: load + carry node space_id so trend_centroids stays scoped.
  const [node] = await sql`SELECT space_id FROM nodes WHERE addr = ${nodeAddr}`;
  const node_space_id = node?.space_id || "global";
  await sql`
    UPDATE nodes
    SET embedding_hv = ${centroidStr}::halfvec(3072),
        embedding_at = ${centroidMeta.embeddedAt},
        embedding_model = ${centroidMeta.model},
        embedding_task_type = ${centroidMeta.taskType},
      updated_at = now()
    WHERE addr = ${nodeAddr}
  `;
  await upsertTrendCentroid(`node:${nodeAddr}`, "active", nodeAddr, label, lifecycle, centroid, node_space_id);
}

async function syncTrendNodeState(node: any, params: TrendParams): Promise<TrendStats> {
  const sourceContext = typeof node.source_context === "string"
    ? JSON.parse(node.source_context)
    : (node.source_context || {});
  const trendCtx = sourceContext.trend || {};
  const birthTime = trendCtx.birth_time
    ? new Date(trendCtx.birth_time).toISOString()
    : asDate(node.created_at).toISOString();
  const nurseryUntil = trendCtx.nursery_until
    ? new Date(trendCtx.nursery_until).toISOString()
    : new Date(new Date(birthTime).getTime() + params.nurseryHours * 3_600_000).toISOString();

  const stats = await computeTrendStats(node, params);
  await syncTrendContributionOverrides(node.addr, stats.effectiveHalflifeHours);

  const updatedContext = {
    ...sourceContext,
    trend: buildTrendSourceContext({
      lifecycle: stats.lifecycle,
      birthTime,
      nurseryUntil,
      sourceTypes: stats.sourceTypes,
      sourceDiversity: stats.sourceDiversity,
      originKeys: stats.originKeys,
      originDiversity: stats.originDiversity,
      incarnation: parseInt(trendCtx.incarnation || 1),
      priorIncarnationAddr: trendCtx.prior_incarnation_addr || null,
      feedTimestamps: stats.feedTimestamps,
      velocity: stats.velocity,
      currentHalflifeHours: stats.effectiveHalflifeHours,
      graduationEligible: stats.graduationEligible,
      peakEnergy: stats.peakEnergy,
      lastStimulusAt: stats.lastStimulusAt,
      avgDirectEnergy7d: stats.avgDirectEnergy7d,
    }),
  };

  await sql`
    UPDATE nodes
    SET source_context = ${sql.json(updatedContext)},
      updated_at = now()
    WHERE addr = ${node.addr}
  `;
  await syncActiveTrendCentroid(node.addr, node.label, stats.lifecycle);

  return stats;
}

async function allocateTrendAddr(): Promise<{ addr: string; position: number }> {
  const [row] = await sql`SELECT nextval('trend_addr_seq') as next`;
  const position = parseInt(row.next);
  return { addr: `TN.0.1.${position}`, position };
}

function buildTrendLabelFallback(contents: string[]): { label: string; description: string; domains: string[]; substance: string } {
  const sample = contents[0] || "Emergent trend";
  const label = sample.length > 72 ? `${sample.slice(0, 69)}...` : sample;
  return {
    label,
    description: sample.slice(0, 200),
    domains: ["general"],
    substance: sample,
  };
}

async function budgetedTrendFlashLite(
  prompt: string,
  config: Parameters<typeof callFlashLiteWithModel>[1],
  budget: TrendMaintenanceBudget | undefined,
): Promise<string> {
  if (budget) {
    const check = budget.evaluateBudgetCheck(budget.estimateFlashLiteMicro);
    if (!check.allowed) throw new Error(`trend_budget_${check.reason}`);
  }
  const result = await callFlashLiteWithModel(prompt, config);
  if (budget) {
    try {
      await budget.recordLlmSpend(budget.actualCostMicro(result, budget.estimateFlashLiteMicro));
    } catch (error: any) {
      const reason = String(error?.reason || error?.message || "failed").replace(/^trend_budget_/, "") || "failed";
      const wrapped = new Error(`trend_budget_accounting_${reason}`);
      (wrapped as any).trendBudgetAccountingError = true;
      (wrapped as any).cause = error;
      throw wrapped;
    }
  }
  return result.text;
}

async function assessTrendActionability(contents: string[], budget?: TrendMaintenanceBudget): Promise<{ actionable: boolean; category: string; reason: string }> {
  const fallback = { actionable: true, category: "unknown", reason: "llm_unavailable" };
  if (shouldUseFallbackTrendLabels()) return fallback;

  const prompt = `You are a trend quality gate for a knowledge graph. Your job is to determine whether a cluster of news atoms represents an ACTIONABLE or EMERGENT trend, versus a one-time news story, product launch, or isolated event.

ACTIONABLE/EMERGENT trends are:
- Patterns that are developing over time and likely to continue (e.g., "AI agents replacing junior devs", "GLP-1 drugs expanding beyond diabetes")
- Technology shifts with broad implications (e.g., "WebAssembly adoption accelerating")
- Market movements or regulatory changes affecting multiple actors
- Emerging behaviors, cultural shifts, or systemic changes

NOT trends (reject these):
- One-time product launches or company announcements ("Company X launches Y")
- Isolated news stories ("Russia-Cuba oil deal")
- Blog posts, tutorials, or content updates ("Lilian Weng blog migration")
- Individual research papers without broader movement
- Platform feature releases ("Stack Overflow launches Teams")
- Single events without recurring pattern

Atoms in this cluster:
${contents.slice(0, 8).map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return JSON: {"actionable": true/false, "category": "emerging_trend"|"tech_shift"|"market_movement"|"news_story"|"product_launch"|"content_update"|"isolated_event"|"research_paper", "reason": "brief explanation"}`;

  try {
    const raw = await budgetedTrendFlashLite(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 256, timeoutMs: 3000 }, budget);
    const parsed = JSON.parse(raw.trim());
    return {
      actionable: Boolean(parsed.actionable),
      category: String(parsed.category || "unknown"),
      reason: String(parsed.reason || "no_reason"),
    };
  } catch (error) {
    if (isTrendBudgetControlError(error)) throw error;
    // On LLM failure, allow the trend through (fail-open for now)
    return fallback;
  }
}

async function labelTrend(contents: string[], budget?: TrendMaintenanceBudget): Promise<{ label: string; description: string; domains: string[]; substance: string }> {
  const fallback = buildTrendLabelFallback(contents);
  if (shouldUseFallbackTrendLabels()) return fallback;

  const prompt = `These current-event atoms are converging into a new transient trend in a knowledge graph.

Atoms:
${contents.slice(0, 12).map((content, idx) => `${idx + 1}. ${content}`).join("\n")}

Return JSON with:
- label: concise title, max 80 chars
- description: compressed summary, max 200 chars
- domains: 1-4 lower-case domains
- substance: 1 paragraph explaining what is happening and why it matters
`;

  try {
    const raw = await budgetedTrendFlashLite(prompt, { jsonMode: true, temperature: 0.2, maxTokens: 512, timeoutMs: 2500 }, budget);
    const parsed = JSON.parse(raw.trim());
    return {
      label: String(parsed.label || fallback.label).slice(0, 80),
      description: String(parsed.description || fallback.description).slice(0, 200),
      domains: Array.isArray(parsed.domains) && parsed.domains.length > 0
        ? parsed.domains.slice(0, 4).map((value: any) => String(value).toLowerCase())
        : fallback.domains,
      substance: String(parsed.substance || fallback.substance),
    };
  } catch (error) {
    if (isTrendBudgetControlError(error)) throw error;
    return fallback;
  }
}

async function upsertTrendCentroid(refKey: string, refKind: "active" | "archive", refAddr: string, label: string, lifecycle: string, centroid: number[], spaceId: string): Promise<void> {
  const centroidStr = toVectorStr(centroid);
  await sql`
    INSERT INTO trend_centroids (ref_key, ref_kind, ref_addr, label, lifecycle, centroid, space_id, updated_at)
    VALUES (${refKey}, ${refKind}, ${refAddr}, ${label}, ${lifecycle}, ${centroidStr}::halfvec, ${spaceId}, now())
    ON CONFLICT (ref_key) DO UPDATE SET
      ref_kind = EXCLUDED.ref_kind,
      ref_addr = EXCLUDED.ref_addr,
      label = EXCLUDED.label,
      lifecycle = EXCLUDED.lifecycle,
      centroid = EXCLUDED.centroid,
      space_id = EXCLUDED.space_id,
      updated_at = now()
  `;
}

async function hasRecentTrendDuplicateAudit(
  pairKey: string,
  primaryAddr: string,
  secondaryAddr: string,
  cooldownHours: number,
): Promise<boolean> {
  const pairPattern = `%${pairKey}%`;
  const primaryPeerPattern = `%${secondaryAddr}%`;
  const secondaryPeerPattern = `%${primaryAddr}%`;
  const [row] = await sql`
    SELECT 1
    FROM trend_decision_audits
    WHERE decision_kind = 'trend_duplicate_candidate'
      AND (
        payload::text LIKE ${pairPattern}
        OR (trend_addr = ${primaryAddr} AND payload::text LIKE ${primaryPeerPattern})
        OR (trend_addr = ${secondaryAddr} AND payload::text LIKE ${secondaryPeerPattern})
      )
      AND created_at > now() - (${cooldownHours} * interval '1 hour')
    LIMIT 1
  `;
  return Boolean(row);
}

async function writeTrendDedupSweepState(input: {
  ranAt: string;
  scannedPairs: number;
  flaggedPairs: number;
}): Promise<void> {
  await sql`
    INSERT INTO graph_state (key, value)
    VALUES
      ('trend_live_dedup_last_run_at', ${input.ranAt}),
      ('trend_live_dedup_last_scanned_pairs', ${String(input.scannedPairs)}),
      ('trend_live_dedup_last_flagged_pairs', ${String(input.flaggedPairs)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function runActiveTrendDedupSweep(options: { force?: boolean } = {}): Promise<{
  scannedPairs: number;
  flaggedPairs: number;
  skipped: boolean;
  lastRunAt: string | null;
}> {
  const params = await loadTrendParams();
  if (params.liveDedupIntervalMinutes <= 0) {
    return { scannedPairs: 0, flaggedPairs: 0, skipped: true, lastRunAt: null };
  }

  const [stateRow] = await sql`
    SELECT value
    FROM graph_state
    WHERE key = 'trend_live_dedup_last_run_at'
  `;
  const lastRunAt = stateRow?.value ? String(stateRow.value) : null;
  if (!options.force && lastRunAt) {
    const minutesSinceLastRun = (Date.now() - asDate(lastRunAt).getTime()) / 60_000;
    if (minutesSinceLastRun < params.liveDedupIntervalMinutes) {
      return { scannedPairs: 0, flaggedPairs: 0, skipped: true, lastRunAt };
    }
  }

  const rows = await sql`
    SELECT addr, label, substance, source_context, stimulus_heat, created_at, embedding_hv::text as embedding, space_id
    FROM nodes
    WHERE node_type = 'trend'
      AND visibility = 'public'
      AND embedding_hv IS NOT NULL
  `;
  const trends: LiveTrendSnapshot[] = rows.map(parseLiveTrendSnapshot);
  const trendByAddr = new Map<string, LiveTrendSnapshot>(
    trends.map((trend): [string, LiveTrendSnapshot] => [trend.addr, trend]),
  );
  const seenPairs = new Set<string>();
  let scannedPairs = 0;
  let flaggedPairs = 0;

  for (const trend of trends) {
    const centroidStr = toVectorStr(trend.embedding);
    // R3: cross-space dedup is forbidden. A trend in tenant:example-tenant must
    // never deduplicate against a trend in tenant:bobcorp or vice versa,
    // even if their centroids overlap. Scope the neighbor lookup by
    // trend.space_id so dedup only operates within one space.
    const neighbors = await sql`
      SELECT ref_addr, 1 - (centroid <=> ${centroidStr}::halfvec) as similarity
      FROM trend_centroids
      WHERE ref_kind = 'active'
        AND ref_addr != ${trend.addr}
        AND space_id = ${trend.space_id}
      ORDER BY centroid <=> ${centroidStr}::halfvec
      LIMIT 4
    `;

    for (const row of neighbors) {
      const peer = trendByAddr.get(String(row.ref_addr));
      if (!peer) continue;
      const pairKey = buildTrendPairKey(trend.addr, peer.addr);
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      scannedPairs++;

      const similarity = parseFloat(String(row.similarity));
      const candidate = evaluateLiveTrendDuplicateCandidate(trend, peer, similarity, params);
      if (!candidate) continue;
      if (
        await hasRecentTrendDuplicateAudit(
          candidate.pairKey,
          candidate.primary.addr,
          candidate.secondary.addr,
          params.liveDedupAuditCooldownHours,
        )
      ) continue;

      const reasons = [
        "high_active_similarity",
        ...(candidate.sharedOrigins.length > 0 ? ["shared_origins"] : []),
        ...(candidate.sharedDomains.length > 0 ? ["shared_domains"] : []),
        ...(candidate.sharedSourceTypes.length > 0 ? ["shared_source_types"] : []),
      ];
      const payload = {
        pair_key: candidate.pairKey,
        similarity: candidate.similarity,
        birth_gap_hours: candidate.birthGapHours,
        shared_origins: candidate.sharedOrigins,
        shared_domains: candidate.sharedDomains,
        shared_source_types: candidate.sharedSourceTypes,
        suggested_primary_addr: candidate.primary.addr,
        peer_trend_addr: candidate.secondary.addr,
        reasons,
        primary: {
          addr: candidate.primary.addr,
          label: candidate.primary.label,
          lifecycle: candidate.primary.lifecycle,
          stimulus_heat: candidate.primary.stimulusHeat,
          source_diversity: candidate.primary.sourceDiversity,
          origin_diversity: candidate.primary.originDiversity,
          birth_time: candidate.primary.birthTime.toISOString(),
          score: Number(candidate.primaryScore.toFixed(4)),
        },
        secondary: {
          addr: candidate.secondary.addr,
          label: candidate.secondary.label,
          lifecycle: candidate.secondary.lifecycle,
          stimulus_heat: candidate.secondary.stimulusHeat,
          source_diversity: candidate.secondary.sourceDiversity,
          origin_diversity: candidate.secondary.originDiversity,
          birth_time: candidate.secondary.birthTime.toISOString(),
          score: Number(candidate.secondaryScore.toFixed(4)),
        },
        decision: {
          action: "flag_duplicate_candidate",
          borderline: false,
          reasons,
          metrics: {
            similarity: candidate.similarity,
            birth_gap_hours: candidate.birthGapHours,
            shared_origin_count: candidate.sharedOrigins.length,
            shared_domain_count: candidate.sharedDomains.length,
            shared_source_type_count: candidate.sharedSourceTypes.length,
          },
          recommendedAction: "manual_review",
        },
      };

      await recordTrendEvent({
        eventType: "trend_duplicate_candidate",
        spaceId: candidate.primary.space_id,
        trendAddr: candidate.primary.addr,
        payload,
      });
      await enqueueTrendDecisionAudit({
        decisionKind: "trend_duplicate_candidate",
        refKind: "trend",
        refId: candidate.primary.addr,
        spaceId: candidate.primary.space_id,
        trendAddr: candidate.primary.addr,
        payload,
      });
      flaggedPairs++;
    }
  }

  const ranAt = new Date().toISOString();
  await writeTrendDedupSweepState({ ranAt, scannedPairs, flaggedPairs });
  return { scannedPairs, flaggedPairs, skipped: false, lastRunAt: ranAt };
}

async function deleteTrendEdgesOwnedBy(trendAddr: string): Promise<number> {
  // R3: load the trend's space_id so the trend_edges_cleaned event is
  // tenant-scoped. Falls back to 'global' if the node is already gone
  // (race with archive).
  const [owner] = await sql`SELECT space_id FROM nodes WHERE addr = ${trendAddr}`;
  const owner_space_id = owner?.space_id || "global";
  let removed: any[] = [];
  await sql.begin(async (tx) => {
    const txAny = tx as any;
    removed = await txAny`
      SELECT id
      FROM edges
      WHERE edge_type = 'trend_affects'
        AND (
          from_addr = ${trendAddr}
          OR to_addr = ${trendAddr}
          OR COALESCE(source_context->>'trend_owner', '') = ${trendAddr}
        )
    `;
    await deleteEdgesByIds(sql as any, removed.map((row: any) => row.id), { tx: txAny });
  });
  if (removed.length > 0) {
    await recordTrendEvent({
      eventType: "trend_edges_cleaned",
      spaceId: owner_space_id,
      trendAddr,
      payload: { removed_edge_ids: removed.map((row: any) => row.id), removed_count: removed.length },
    });
  }
  return removed.length;
}

async function cleanupDanglingTrendEdges(): Promise<number> {
  let removed: any[] = [];
  await sql.begin(async (tx) => {
    const txAny = tx as any;
    removed = await txAny`
      SELECT e.id, e.from_addr, e.to_addr, e.source_context
      FROM edges e
      WHERE e.edge_type = 'trend_affects'
        AND (
          NOT EXISTS (SELECT 1 FROM nodes nf WHERE nf.addr = e.from_addr)
          OR NOT EXISTS (SELECT 1 FROM nodes nt WHERE nt.addr = e.to_addr)
          OR (
            COALESCE(e.source_context->>'trend_owner', '') != ''
            AND NOT EXISTS (
              SELECT 1 FROM nodes owner
              WHERE owner.addr = e.source_context->>'trend_owner'
            )
          )
        )
    `;
    await deleteEdgesByIds(sql as any, removed.map((row: any) => row.id), { tx: txAny });
  });
  for (const row of removed) {
    const sourceContext = typeof row.source_context === "string"
      ? JSON.parse(row.source_context)
      : (row.source_context || {});
    // R3: dangling edge cleanup — the owner node is already gone, so
    // there's no live space_id to load. Default to 'global' (the
    // foundation column default) so the event still records a stable
    // tenant scope. This is the only place R3 falls back to 'global'
    // by design rather than incident.
    await recordTrendEvent({
      eventType: "trend_edges_cleaned",
      spaceId: "global",
      trendAddr: sourceContext.trend_owner || row.from_addr || null,
      payload: {
        removed_edge_ids: [row.id],
        from_addr: row.from_addr,
        to_addr: row.to_addr,
        reason: "dangling_trend_edge",
      },
    });
  }
  return removed.length;
}

async function createTrendEdges(trendAddr: string, trendLabel: string, centroid: number[], trendSpaceId: string, params: TrendParams): Promise<void> {
  const centroidStr = toVectorStr(centroid);
  // R3: candidate target search is scoped to the trend's space PLUS
  // the global pool. A tenant trend can wire edges to its own
  // tenant-private nodes AND to global public nodes, but never to
  // another tenant's private nodes.
  const rows = await sql`
    SELECT addr, label, space_id, 1 - (embedding_hv <=> ${centroidStr}::halfvec) as similarity
    FROM nodes
    WHERE addr != ${trendAddr}
      AND node_type != 'trend'
      AND embedding_hv IS NOT NULL
      AND visibility = 'public'
      AND space_id = ANY(ARRAY[${trendSpaceId}::text, 'global'])
    ORDER BY embedding_hv <=> ${centroidStr}::halfvec
    LIMIT ${params.autoWireMax * 3}
  `;

  let inserted = 0;
  for (const row of rows) {
    const similarity = parseFloat(row.similarity);
    if (similarity < params.autoWireMinSimilarity) continue;
    await writeEdge(sql as any, {
      fromAddr: trendAddr,
      toAddr: String(row.addr),
      edgeType: "trend_affects",
      layer: 1,
      label: `${trendLabel} affects ${row.label}`,
      confidence: Math.min(0.9, similarity),
      weight: Math.min(params.autoWireWeightCap, similarity),
      hash: "pending",
      provenance: { basis: "inferred", source: "trend-engine" },
      sourceContext: { trend_auto: true, trend_owner: trendAddr },
      // R3: explicit space safety. The edge owner space is the trend's
      // space; targets in 'global' show up as public-affects-tenant
      // edges, which is acceptable because globals are public by design.
      spaceId: trendSpaceId,
      fromSpaceId: trendSpaceId,
      toSpaceId: String(row.space_id),
    });
    inserted++;
    if (inserted >= params.autoWireMax) break;
  }
}

async function createSmokeFixtureEdgesFromSourceContext(
  trendAddr: string,
  trendLabel: string,
  sourceContext: Record<string, any>,
): Promise<number> {
  const smokeFixture = sourceContext.smoke_fixture;
  if (!smokeFixture?.enabled) return 0;

  const targets = normalizeSmokeFixtureEdgeTargets(smokeFixture.relation_targets);
  if (targets.length === 0) return 0;

  const targetRows = await sql`
    SELECT addr, label
    FROM nodes
    WHERE addr = ANY(${targets.map((target) => target.addr)}::text[])
      AND visibility = 'public'
  `;
  const labelByAddr = new Map<string, string>(targetRows.map((row: any) => [String(row.addr), String(row.label || row.addr)]));

  let synced = 0;
  for (const target of targets) {
    const targetLabel = labelByAddr.get(target.addr) || target.fallbackLabel || target.addr;
    if (!targetLabel) continue;

    await upsertEdge(sql as any, {
      fromAddr: trendAddr,
      toAddr: target.addr,
      edgeType: "trend_affects",
      layer: 1,
      label: `${trendLabel} ${target.relation} ${targetLabel}`,
      confidence: Math.max(0.55, Math.min(0.92, target.confidence)),
      weight: Math.max(0.12, Math.min(0.4, target.weight)),
      hash: "pending",
      provenance: { basis: "fixture", source: "trend-smoke-fixture" },
      sourceContext: {
        trend_owner: trendAddr,
        smoke_fixture: true,
        fixture_key: smokeFixture.fixture_key || "smoke-trend-fixture",
        relation_hint: target.relation,
        target_addr: target.addr,
      },
    }, { conflictUpdate: "replaceMetadata" });
    synced++;
  }

  if (synced > 0) {
    // R3: load space_id from the trend node — fixture sync runs as part
    // of birth, so the node exists.
    const [trendNode] = await sql`SELECT space_id FROM nodes WHERE addr = ${trendAddr}`;
    await recordTrendEvent({
      eventType: "trend_fixture_edges_synced",
      spaceId: trendNode?.space_id || "global",
      trendAddr,
      payload: {
        synced_count: synced,
        fixture_key: smokeFixture.fixture_key || "smoke-trend-fixture",
        targets: targets.map((target) => target.addr),
      },
    });
  }

  return synced;
}

async function seedTrendContributions(stimuli: OrphanStimulus[], nodeAddr: string, halflifeHours: number): Promise<void> {
  await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
    for (const stimulus of stimuli) {
      const baseContribution = Math.max(0.01, currentEnergy(stimulus));
      // F11: copy correlation_id from the stimuli row via subselect so trend
      // birth contributions inherit the source's request id (or NULL).
      await tx`
        INSERT INTO stimulus_contributions (
          stimulus_id, node_addr, channel, contribution, base_contribution, relevance, urgency,
          decay_halflife_hours_override, peak_delay_hours_override, correlation_id
        )
        VALUES (
          ${stimulus.id},
          ${nodeAddr},
          'relevance',
          ${baseContribution},
          ${baseContribution},
          1.0,
          1.0,
          ${halflifeHours},
          0,
          (SELECT correlation_id FROM stimuli WHERE id = ${stimulus.id})
        )
        ON CONFLICT (stimulus_id, node_addr) DO NOTHING
      `;
    }
  });
}

async function adoptClusterToExistingTrend(clusterId: string, orphans: OrphanStimulus[], trendAddr: string, params: TrendParams): Promise<void> {
  await seedTrendContributions(orphans, trendAddr, params.baseHalflifeHours);
  const orphanIds = orphans.map((row) => row.id);
  await sql`
    UPDATE stimuli
    SET node_addr = ${trendAddr},
      is_orphan = false,
      orphan_status = 'adopted',
      proto_cluster_id = NULL
    WHERE id = ANY(${orphanIds}::int[])
  `;
  await sql`DELETE FROM wi_proto_clusters WHERE id = ${clusterId}`;
  // R3: orphans were already verified to share one space at cluster
  // creation; reuse the first orphan's space_id for the adoption event.
  await recordTrendEvent({
    eventType: "trend_adopted",
    spaceId: orphans[0].space_id,
    protoClusterId: clusterId,
    trendAddr,
    ingestBatchId: orphans[0]?.ingest_batch_id || null,
    payload: {
      stimulus_ids: orphanIds,
      source_types: [...new Set(orphans.map((row) => resolveStimulusSourceType(row)))],
    },
  });
}

async function birthTrendFromCluster(clusterId: string, archivedMatch?: any, budget?: TrendMaintenanceBudget): Promise<string> {
  const params = await loadTrendParams();
  const rows = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours, created_at, embedding::text, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id = ${clusterId}
      AND embedding IS NOT NULL
    ORDER BY created_at ASC
  `;
  if (rows.length === 0) {
    throw new Error(`Proto-cluster ${clusterId} has no active orphan members`);
  }

  // R3: cluster space_id is the single source of truth for the trend.
  // Cross-tenant clustering would have failed at clusterStandaloneOrphans
  // already; this is defense in depth.
  const distinctSpaces = new Set(rows.map((r: any) => r.space_id));
  if (distinctSpaces.size !== 1) {
    throw new Error(`R3 invariant: birthTrendFromCluster requires a single space_id; got [${[...distinctSpaces].join(", ")}]`);
  }
  const trend_space_id = rows[0].space_id;

  const orphans: OrphanStimulus[] = rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: clusterId,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    space_id: row.space_id,
  }));

  const centroid = avgEmbedding(orphans.map((row) => row.embedding));
  const labeled = await labelTrend(orphans.map((row) => row.content), budget);
  const { addr, position } = await allocateTrendAddr();
  const sourceTypes = [...new Set(orphans.map((row) => resolveStimulusSourceType(row)))];
  const originKeys = [...new Set(orphans.map((row) => resolveStimulusOrigin(row).key))];
  const birthTime = new Date().toISOString();
  const nurseryUntil = new Date(Date.now() + params.nurseryHours * 3_600_000).toISOString();
  const priorIncarnationAddr = archivedMatch?.prior_addr || archivedMatch?.original_addr || null;
  const priorIncarnation = archivedMatch ? parseInt(archivedMatch.incarnation || 1) : 0;
  const incarnation = archivedMatch ? Math.min(priorIncarnation + 1, params.recurrenceMaxIncarnations) : 1;
  const confidenceBoost = archivedMatch
    ? 0.05 * Math.pow(0.7, Math.max(0, incarnation - 2))
    : 0;
  const confidence = Math.min(0.75, 0.5 + confidenceBoost);
  const archivedSourceContext = typeof archivedMatch?.source_context === "string"
    ? JSON.parse(archivedMatch.source_context)
    : (archivedMatch?.source_context || {});
  const trendContext = buildTrendSourceContext({
    lifecycle: "emerging",
    birthTime,
    nurseryUntil,
    sourceTypes,
    sourceDiversity: sourceTypes.length,
    originKeys,
    originDiversity: originKeys.length,
    incarnation,
    priorIncarnationAddr,
    feedTimestamps: orphans.map((row) => row.created_at.toISOString()).slice(-12),
    velocity: sourceTypes.length / Math.max(orphans.length, 1),
    currentHalflifeHours: params.baseHalflifeHours,
    graduationEligible: false,
    peakEnergy: orphans.reduce((sum, row) => sum + currentEnergy(row), 0),
    lastStimulusAt: orphans[orphans.length - 1].created_at.toISOString(),
    avgDirectEnergy7d: orphans.reduce((sum, row) => sum + currentEnergy(row), 0) / orphans.length,
  });
  const smokeFixtureConfig = resolveSmokeFixtureConfig({ orphans, archivedSourceContext });
  const persistedSourceContext = {
    ...archivedSourceContext,
    ...(smokeFixtureConfig ? { smoke_fixture: smokeFixtureConfig } : {}),
    trend: trendContext,
  };

  const substance = {
    description: labeled.description,
    summary: labeled.description,
    substance: labeled.substance,
    domains: labeled.domains,
      source_types: sourceTypes,
      origin_keys: originKeys,
      node_type: "trend",
  };

  // F7: trend birth uses a centroid (arithmetic blend of contributing
  // orphan vectors), not a fresh text embed. Mark with DERIVED_CENTROID
  // so the drift surface can distinguish derived from text-embedded
  // vectors and a future re-embed rung can refresh trends from their
  // labeled summary if needed.
  const centroidMeta = embeddingMetadataForVectorWrite("DERIVED_CENTROID");
  await sql`
    INSERT INTO nodes (
      addr, pyramid_id, layer, depth, position, label, substance, confidence,
      hash, provenance, parent_addr, visibility, node_type, source_context,
      embedding_hv, embedding_at, embedding_model, embedding_task_type, space_id
    )
    VALUES (
      ${addr},
      'TN',
      0,
      1,
      ${position},
      ${labeled.label},
      ${sql.json(substance)},
      ${confidence},
      'pending',
      '{"basis":"observed","source":"trend-engine"}'::jsonb,
      'TN.0.0.0',
      'public',
      'trend',
      ${sql.json(persistedSourceContext)},
      ${toVectorStr(centroid)}::halfvec(3072),
      ${centroidMeta.embeddedAt},
      ${centroidMeta.model},
      ${centroidMeta.taskType},
      ${trend_space_id}
    )
  `;

  await createTrendEdges(addr, labeled.label, centroid, trend_space_id, params);
  await createSmokeFixtureEdgesFromSourceContext(addr, labeled.label, persistedSourceContext);
  await seedTrendContributions(orphans, addr, params.baseHalflifeHours);
  await sql`
    UPDATE stimuli
    SET node_addr = ${addr},
      is_orphan = false,
      orphan_status = 'promoted',
      proto_cluster_id = NULL
    WHERE proto_cluster_id = ${clusterId}
  `;
  await sql`DELETE FROM wi_proto_clusters WHERE id = ${clusterId}`;
  await upsertTrendCentroid(`node:${addr}`, "active", addr, labeled.label, "emerging", centroid, trend_space_id);
  await sql`SELECT refresh_registry_counts('TN')`;
  await recordTrendEvent({
    eventType: archivedMatch ? "trend_recurred" : "trend_born",
    spaceId: trend_space_id,
    protoClusterId: clusterId,
    trendAddr: addr,
    ingestBatchId: orphans[0]?.ingest_batch_id || null,
    payload: {
      stimulus_ids: orphans.map((row) => row.id),
      source_types: sourceTypes,
      origin_keys: originKeys,
      incarnation,
      prior_incarnation_addr: priorIncarnationAddr,
      label: labeled.label,
    },
  });

  return addr;
}

async function archiveTrend(addr: string): Promise<void> {
  // R3: load space_id from the trend node and carry it through every
  // write (trend_archive INSERT, recordTrendEvent payload). Without
  // this, a tenant trend archived via the operator route ends up
  // global/default-scoped — which would let cross-tenant
  // recurrence dedup happen later.
  const [node] = await sql`
    SELECT addr, label, substance, source_context, embedding_hv::text, query_hits, stimulus_heat, created_at, space_id
    FROM nodes
    WHERE addr = ${addr}
      AND node_type = 'trend'
  `;
  if (!node) return;
  const archive_space_id = node.space_id;

  const sourceContext = typeof node.source_context === "string"
    ? JSON.parse(node.source_context)
    : (node.source_context || {});
  const trendCtx = sourceContext.trend || {};
  const birthTime = trendCtx.birth_time ? new Date(trendCtx.birth_time).toISOString() : asDate(node.created_at).toISOString();
  const centroid = parseEmbedding(node.embedding_hv);
  const linkedStimuli = await sql`
    SELECT id, ingest_batch_id
    FROM stimuli
    WHERE node_addr = ${addr}
    ORDER BY created_at ASC
  `;
  const [archive] = await sql`
    INSERT INTO trend_archive (
      original_addr, label, substance, domains, centroid, birth_time, peak_energy,
      source_types, source_diversity, origin_keys, origin_diversity, incarnation, prior_addr, engagement_count, graduated, source_context, space_id
    )
    VALUES (
      ${node.addr},
      ${node.label},
      ${JSON.stringify(node.substance)},
      ${node.substance?.domains || []},
      ${toVectorStr(centroid)}::halfvec,
      ${birthTime},
      ${parseFloat(trendCtx.peak_energy || node.stimulus_heat || 0)},
      ${trendCtx.source_types || []},
      ${parseInt(trendCtx.source_diversity || 0)},
      ${trendCtx.origin_keys || []},
      ${parseInt(trendCtx.origin_diversity || 0)},
      ${parseInt(trendCtx.incarnation || 1)},
      ${trendCtx.prior_incarnation_addr || null},
      ${parseInt(node.query_hits || 0)},
      ${Boolean(trendCtx.graduated || false)},
      ${sql.json(sourceContext)},
      ${archive_space_id}
    )
    RETURNING id
  `;

  await upsertTrendCentroid(`archive:${archive.id}`, "archive", node.addr, node.label, "dead", centroid, archive_space_id);
  await sql`DELETE FROM trend_centroids WHERE ref_key = ${"node:" + addr}`;
  await deleteTrendEdgesOwnedBy(addr);
  await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
    await tx`DELETE FROM stimulus_contributions WHERE node_addr = ${addr}`;
  });
  await sql`
    UPDATE stimuli
    SET node_addr = NULL
    WHERE node_addr = ${addr}
  `;
  await sql`DELETE FROM nodes WHERE addr = ${addr}`;
  await sql`SELECT refresh_registry_counts('TN')`;
  await recordTrendEvent({
    eventType: "trend_archived",
    spaceId: archive_space_id,
    trendAddr: addr,
    ingestBatchId: linkedStimuli[0]?.ingest_batch_id || null,
    payload: {
      archive_id: archive.id,
      stimulus_ids: linkedStimuli.map((row: any) => row.id),
      incarnation: parseInt(trendCtx.incarnation || 1),
      birth_time: birthTime,
      death_time: new Date().toISOString(),
    },
  });
}

async function routeProtoCluster(cluster: ProtoCluster, budget?: TrendMaintenanceBudget): Promise<"none" | "adopted" | "birthed"> {
  const params = await loadTrendParams();
  if (cluster.sourceTypes.some((sourceType) => !isTrendEligibleSourceType(sourceType))) {
    await releaseProtoCluster(cluster.id);
    return "none";
  }
  if (cluster.orphanCount < params.convergenceMinOrphans) return "none";
  if (cluster.sourceTypes.length < params.convergenceMinSources) return "none";
  if (cluster.originDiversity < params.convergenceMinOrigins) return "none";
  if (cluster.totalEnergy < params.convergenceMinEnergy) return "none";

  const rows = await sql`
    SELECT id, source, source_id, url, content, temporality, energy, decay_halflife_hours, created_at, embedding::text, ingest_batch_id, node_addr,
      origin_key, origin_kind, origin_label, space_id
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND proto_cluster_id = ${cluster.id}
      AND embedding IS NOT NULL
  `;
  if (rows.length === 0) return "none";
  const orphans: OrphanStimulus[] = rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    url: row.url,
    content: row.content,
    temporality: row.temporality,
    energy: parseFloat(row.energy),
    decay_halflife_hours: parseFloat(row.decay_halflife_hours),
    created_at: asDate(row.created_at),
    embedding: parseEmbedding(row.embedding),
    proto_cluster_id: cluster.id,
    ingest_batch_id: row.ingest_batch_id,
    node_addr: row.node_addr,
    origin_key: row.origin_key,
    origin_kind: row.origin_kind,
    origin_label: row.origin_label,
    space_id: row.space_id,
  }));

  // Ingest batch diversity gate: cluster stimuli must come from multiple independent
  // feed batches. A single batch dumping similar content isn't a trend signal —
  // but 3 different outlets (techcrunch, verge, cnet) each contributing from their
  // own batch IS a trend signal, even if they all arrive in the same minute.
  const distinctBatches = new Set(orphans.map((o) => o.ingest_batch_id).filter(Boolean));
  if (distinctBatches.size < 2) {
    await recordTrendEvent({
      eventType: "proto_cluster_held",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: {
        reason: "insufficient_batch_diversity",
        distinct_batches: distinctBatches.size,
        required_batches: 2,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
      },
    });
    return "none";
  }

  const clusterContents = orphans.map((row) => row.content);
  // Coherence check applies to ALL clusters, not just RSS-heavy ones
  const coherence = buildRssCoherenceSnapshot(clusterContents, params.rssMinSharedTerms);

  if (!coherence.isCoherent || (!coherence.dominantTopic && coherence.pairwiseSupport < params.rssPairwiseSupportFloor)) {
    await recordTrendEvent({
      eventType: "proto_cluster_held",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: {
        reason: "topic_incoherent",
        coherence,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
      },
    });
    await enqueueTrendDecisionAudit({
      decisionKind: "topic_incoherent",
      refKind: "proto_cluster",
      refId: cluster.id,
      spaceId: cluster.space_id,
      payload: {
        coherence,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
        example_atoms: clusterContents.slice(0, 6),
      },
    });
    return "none";
  }

  const centroidStr = toVectorStr(cluster.centroid);
  // R3: dedup against trend_centroids must scope by the cluster's
  // space_id. A cluster in tenant:example-tenant must not adopt or recur a
  // trend in tenant:bobcorp or in 'global' from another tenant's
  // pool. Cross-space unification is an R6+ federation feature.
  const matches = await sql`
    SELECT ref_key, ref_kind, ref_addr, label, lifecycle,
      1 - (centroid <=> ${centroidStr}::halfvec) as similarity
    FROM trend_centroids
    WHERE space_id = ${cluster.space_id}
    ORDER BY centroid <=> ${centroidStr}::halfvec
    LIMIT 5
  `;
  let best = matches.find((row: any) => parseFloat(row.similarity) >= params.dedupSimilarity);
  let rssAdoptionDecision: Awaited<ReturnType<typeof evaluateRssTrendAdoption>> | null = null;
  const rssHeavy = cluster.sourceTypes.some((st) => isRssSourceType(st));
  if (rssHeavy && best?.ref_kind === "active") {
    rssAdoptionDecision = await evaluateRssTrendAdoption(
      best.ref_addr,
      clusterContents,
      parseFloat(best.similarity),
      params,
    );
    if (!rssAdoptionDecision.allowed) {
      best = null as any;
    }
  }
  const decision = buildClusterDecisionSnapshot(cluster, params, {
    bestSimilarity: best ? parseFloat(best.similarity) : null,
    dedupKind: best?.ref_kind || null,
  });

  if (decision.action === "hold_borderline_promotion") {
    await recordTrendEvent({
      eventType: "proto_cluster_held",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: {
        decision,
        rss_adoption: rssAdoptionDecision,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
      },
    });
    await enqueueTrendDecisionAudit({
      decisionKind: "borderline_promotion",
      refKind: "proto_cluster",
      refId: cluster.id,
      spaceId: cluster.space_id,
      payload: {
        decision,
        rss_adoption: rssAdoptionDecision,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
        example_atoms: orphans.slice(0, 6).map((row) => row.content),
      },
    });
    return "none";
  }

  if (best && best.ref_kind === "active") {
    await recordTrendEvent({
      eventType: "proto_cluster_routed",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      trendAddr: best.ref_addr,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: { decision, rss_adoption: rssAdoptionDecision },
    });
    await adoptClusterToExistingTrend(cluster.id, orphans, best.ref_addr, params);
    return "adopted";
  }

  // LLM actionability gate: reject one-time news stories before ANY birth (fresh or recurrence)
  const actionabilityVerdict = await assessTrendActionability(clusterContents, budget);
  if (!actionabilityVerdict.actionable) {
    await recordTrendEvent({
      eventType: "proto_cluster_held",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: {
        reason: "not_actionable",
        verdict: actionabilityVerdict,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
      },
    });
    await enqueueTrendDecisionAudit({
      decisionKind: "actionability_rejected",
      refKind: "proto_cluster",
      refId: cluster.id,
      spaceId: cluster.space_id,
      payload: {
        verdict: actionabilityVerdict,
        source_types: cluster.sourceTypes,
        origin_keys: cluster.originKeys,
        example_atoms: clusterContents.slice(0, 6),
      },
    });
    // Release the cluster — these orphans can try again if more signal arrives
    await releaseProtoCluster(cluster.id);
    return "none";
  }

  if (best && best.ref_kind === "archive") {
    const archiveId = parseInt(String(best.ref_key).replace("archive:", ""));
    const [archive] = await sql`
      SELECT id, original_addr, prior_addr, incarnation, source_context
      FROM trend_archive
      WHERE id = ${archiveId}
    `;
    await recordTrendEvent({
      eventType: "proto_cluster_routed",
      spaceId: cluster.space_id,
      protoClusterId: cluster.id,
      trendAddr: archive?.original_addr || null,
      ingestBatchId: orphans[0]?.ingest_batch_id || null,
      payload: { decision, rss_adoption: rssAdoptionDecision, actionability: actionabilityVerdict },
    });
    await birthTrendFromCluster(cluster.id, archive, budget);
    return "birthed";
  }

  await recordTrendEvent({
    eventType: "proto_cluster_routed",
    spaceId: cluster.space_id,
    protoClusterId: cluster.id,
    ingestBatchId: orphans[0]?.ingest_batch_id || null,
    payload: { decision, rss_adoption: rssAdoptionDecision, actionability: actionabilityVerdict },
  });
  await birthTrendFromCluster(cluster.id, undefined, budget);
  return "birthed";
}

export async function runTrendMaintenance(options: TrendMaintenanceOptions = {}): Promise<{
  expiredOrphans: number;
  clusteredStandalones: number;
  birthed: number;
  adopted: number;
  archived: number;
  synced: number;
  cleanedEdges: number;
  dedupSweepSkipped: boolean;
  duplicateCandidates: number;
}> {
  // R2: outermost machine-level kill switch. The operator-facing
  // ~/.vo/config.json#trends_enabled toggle gates the whole pipeline
  // before any DB read. The existing graph_state `trend_enabled`
  // (loaded into params.enabled below) remains as a library-level
  // emergency stop layered inside this gate.
  const settings = resolveTenantSettings();
  if (!settings.trends_enabled) {
    return {
      expiredOrphans: 0,
      clusteredStandalones: 0,
      birthed: 0,
      adopted: 0,
      archived: 0,
      synced: 0,
      cleanedEdges: 0,
      dedupSweepSkipped: true,
      duplicateCandidates: 0,
    };
  }

  const params = await loadTrendParams();
  if (!params.enabled) {
    return {
      expiredOrphans: 0,
      clusteredStandalones: 0,
      birthed: 0,
      adopted: 0,
      archived: 0,
      synced: 0,
      cleanedEdges: 0,
      dedupSweepSkipped: true,
      duplicateCandidates: 0,
    };
  }

  const cleanedEdges = await cleanupDanglingTrendEdges();
  const expiredOrphans = await expireOrphans();
  // R4: forward-pipeline enabled-spaces filter. Compute the set of
  // spaces eligible for new clustering + routing once. 'global' is
  // always processed when the machine flag is on (we already passed
  // the R2 gate above). Tenant spaces opt in via tenant_settings.
  // Cleanup paths (cleanupDanglingTrendEdges, expireOrphans, the
  // dedup sweep below) operate across all spaces — they were called
  // before this filter computation.
  const enabledTenantSpaces = await listEnabledTenantSpaces(sql as any);
  const enabledSpaceIds = new Set(["global", ...enabledTenantSpaces]);
  // R3: per-space clustering. Discover distinct space_ids from BOTH the
  // unclustered orphan stimuli AND existing proto-clusters (a stale
  // cluster from a previous run might be in a space with no current
  // orphans, and the per-space loop must still know about it). Run
  // clusterStandaloneOrphans once per space so cross-space union is
  // structurally impossible.
  const spaceRows = await sql`
    SELECT DISTINCT space_id FROM stimuli
      WHERE is_orphan = true
        AND orphan_status = 'throbbing'
        AND proto_cluster_id IS NULL
        AND embedding IS NOT NULL
    UNION
    SELECT DISTINCT space_id FROM wi_proto_clusters
    ORDER BY space_id
  `;
  let clusteredStandalones = 0;
  for (const row of spaceRows as unknown as Array<{ space_id: string }>) {
    // R4: skip disabled tenant spaces. clusterStandaloneOrphans is the
    // forward-pipeline entry point — refusing it here means a disabled
    // tenant's stimuli sit unclustered until expireOrphans ages them out.
    if (!enabledSpaceIds.has(row.space_id)) continue;
    clusteredStandalones += await clusterStandaloneOrphans(params, row.space_id);
  }

  const clusterRows = await fetchProtoClusters();
  let birthed = 0;
  let adopted = 0;
  for (const staleCluster of clusterRows) {
    const cluster = await refreshProtoCluster(staleCluster.id);
    if (!cluster) continue;
    const clusterAgeHours = (Date.now() - cluster.createdAt.getTime()) / 3_600_000;
    const activeHold = await readActiveProtoClusterHold(cluster.id, cluster.lastFed);
    if (activeHold) {
      await recordTrendEvent({
        eventType: "proto_cluster_policy_hold",
        spaceId: cluster.space_id,
        protoClusterId: cluster.id,
        payload: {
          hold_until: activeHold.holdUntil.toISOString(),
          source_audit_id: activeHold.sourceAuditId,
          source_types: cluster.sourceTypes,
        },
      });
      continue;
    }
    if (clusterAgeHours > params.protoClusterMaxAgeHours && cluster.orphanCount < params.convergenceMinOrphans) {
      const decision = buildClusterDecisionSnapshot(cluster, params, { ageHours: clusterAgeHours });
      if (decision.action === "hold_borderline_release") {
        await recordTrendEvent({
          eventType: "proto_cluster_held",
          spaceId: cluster.space_id,
          protoClusterId: cluster.id,
          payload: { decision, source_types: cluster.sourceTypes, origin_keys: cluster.originKeys },
        });
        await enqueueTrendDecisionAudit({
          decisionKind: "borderline_release",
          refKind: "proto_cluster",
          refId: cluster.id,
          spaceId: cluster.space_id,
          payload: {
            decision,
            source_types: cluster.sourceTypes,
            origin_keys: cluster.originKeys,
          },
        });
        continue;
      }
      await recordTrendEvent({
        eventType: "proto_cluster_release_decision",
        spaceId: cluster.space_id,
        protoClusterId: cluster.id,
        payload: { decision, source_types: cluster.sourceTypes, origin_keys: cluster.originKeys },
      });
      await releaseProtoCluster(cluster.id);
      continue;
    }
    // R4: skip routing/birth/adopt for disabled tenant spaces. The
    // cluster row was loaded from the global pool (ALL spaces), but the
    // forward path stops here. The stale under-threshold release check
    // above still runs for disabled spaces so old proto-clusters do not
    // accumulate forever when a tenant turns trends off.
    if (!enabledSpaceIds.has(cluster.space_id)) continue;
    const result = await routeProtoCluster(cluster, options.budget);
    if (result === "birthed") birthed++;
    if (result === "adopted") adopted++;
  }

  const trendNodes = await sql`
    SELECT addr, label, source_context, created_at
    FROM nodes
    WHERE node_type = 'trend'
  `;

  let archived = 0;
  let synced = 0;
  for (const node of trendNodes) {
    const stats = await syncTrendNodeState(node, params);
    if (stats.lifecycle === "dead") {
      await archiveTrend(node.addr);
      archived++;
    } else {
      synced++;
    }
  }

  const dedupSweep = await runActiveTrendDedupSweep();

  await sql`SELECT refresh_stimulus_heat()`;

  return {
    expiredOrphans,
    clusteredStandalones,
    birthed,
    adopted,
    archived,
    synced,
    cleanedEdges,
    dedupSweepSkipped: dedupSweep.skipped,
    duplicateCandidates: dedupSweep.flaggedPairs,
  };
}

export async function listProtoClusters(spaceFilter: TrendSpaceFilter = null): Promise<any[]> {
  const params = await loadTrendParams();
  const clusters = (await fetchProtoClusters())
    .filter((cluster) => spaceFilter === null || spaceFilter.includes(cluster.space_id));
  const result = [];
  for (const cluster of clusters) {
    const activeHold = await readActiveProtoClusterHold(cluster.id, cluster.lastFed);
    const members = await sql`
      SELECT id, content, source, created_at
      FROM stimuli
      WHERE proto_cluster_id = ${cluster.id}
        AND is_orphan = true
        AND orphan_status = 'throbbing'
      ORDER BY created_at DESC
      LIMIT 3
    `;
    result.push({
      id: cluster.id,
      orphan_count: cluster.orphanCount,
      source_types: cluster.sourceTypes,
      origin_keys: cluster.originKeys,
      origin_diversity: cluster.originDiversity,
      total_energy: cluster.totalEnergy,
      space_id: cluster.space_id,
      created_at: cluster.createdAt,
      last_fed: cluster.lastFed,
      decision_preview: buildClusterDecisionSnapshot(cluster, params),
      policy_hold_until: activeHold?.holdUntil || null,
      policy_source_audit_id: activeHold?.sourceAuditId || null,
      sample_content: members.map((row: any) => row.content),
    });
  }
  return result;
}

export async function dismissProtoCluster(clusterId: string): Promise<void> {
  const memberRows = await sql`
    SELECT id, ingest_batch_id, space_id
    FROM stimuli
    WHERE proto_cluster_id = ${clusterId}
      AND is_orphan = true
      AND orphan_status = 'throbbing'
  `;
  // R3: dismissal happens at the cluster level; load space_id from the
  // cluster (or fall back to first member) so the event is scoped.
  const [dismissedCluster] = await sql`SELECT space_id FROM wi_proto_clusters WHERE id = ${clusterId}`;
  const dismissed_space_id = dismissedCluster?.space_id || memberRows[0]?.space_id || "global";
  await sql`
    UPDATE stimuli
    SET proto_cluster_id = NULL,
      orphan_status = 'dissolved'
    WHERE proto_cluster_id = ${clusterId}
      AND is_orphan = true
      AND orphan_status = 'throbbing'
  `;
  await sql`DELETE FROM wi_proto_clusters WHERE id = ${clusterId}`;
  await recordTrendEvent({
    eventType: "proto_cluster_dismissed",
    spaceId: dismissed_space_id,
    protoClusterId: clusterId,
    ingestBatchId: memberRows[0]?.ingest_batch_id || null,
    payload: { member_ids: memberRows.map((row: any) => row.id) },
  });
}

async function releaseProtoCluster(clusterId: string): Promise<void> {
  // R3: load cluster space_id before deleting so the released event is
  // tenant-scoped.
  const [releasedCluster] = await sql`SELECT space_id FROM wi_proto_clusters WHERE id = ${clusterId}`;
  const released_space_id = releasedCluster?.space_id || "global";
  const memberRows = await sql`
    SELECT id, ingest_batch_id
    FROM stimuli
    WHERE proto_cluster_id = ${clusterId}
      AND is_orphan = true
      AND orphan_status = 'throbbing'
  `;
  await sql`
    UPDATE stimuli
    SET proto_cluster_id = NULL
    WHERE proto_cluster_id = ${clusterId}
      AND is_orphan = true
      AND orphan_status = 'throbbing'
  `;
  await sql`DELETE FROM wi_proto_clusters WHERE id = ${clusterId}`;
  await recordTrendEvent({
    eventType: "proto_cluster_released",
    spaceId: released_space_id,
    protoClusterId: clusterId,
    ingestBatchId: memberRows[0]?.ingest_batch_id || null,
    payload: { member_ids: memberRows.map((row: any) => row.id) },
  });
}

export async function promoteProtoCluster(clusterId: string): Promise<string | null> {
  const [cluster] = await sql`
    SELECT id FROM wi_proto_clusters WHERE id = ${clusterId}
  `;
  if (!cluster) return null;
  return birthTrendFromCluster(clusterId);
}

export async function promoteProtoClusterEarly(
  clusterId: string,
  expectedSpaceId?: string | null,
): Promise<{ trend_addr: string | null; reason?: string; space_id: string }> {
  const cluster = await refreshProtoCluster(clusterId);
  if (!cluster) {
    return { trend_addr: null, reason: "not_found", space_id: "unknown" };
  }
  if (expectedSpaceId && cluster.space_id !== expectedSpaceId) {
    return { trend_addr: null, reason: "space_mismatch", space_id: cluster.space_id };
  }

  const params = await loadTrendParams();
  let reason: string | null = null;
  if (cluster.orphanCount < params.convergenceMinOrphans) reason = "below_min_orphans";
  else if (cluster.sourceTypes.length < params.convergenceMinSources) reason = "below_min_sources";
  else if (cluster.originDiversity < params.convergenceMinOrigins) reason = "below_min_origins";
  else if (cluster.totalEnergy < params.convergenceMinEnergy) reason = "below_min_energy";
  if (reason) {
    return { trend_addr: null, reason, space_id: cluster.space_id };
  }

  await recordTrendEvent({
    eventType: "proto_cluster_force_promoted",
    spaceId: cluster.space_id,
    protoClusterId: cluster.id,
    payload: {
      reason: "operator_override",
      bypassed_gate: "age",
      metrics: {
        orphan_count: cluster.orphanCount,
        source_diversity: cluster.sourceTypes.length,
        origin_diversity: cluster.originDiversity,
        total_energy: cluster.totalEnergy,
      },
      thresholds: {
        convergenceMinOrphans: params.convergenceMinOrphans,
        convergenceMinSources: params.convergenceMinSources,
        convergenceMinOrigins: params.convergenceMinOrigins,
        convergenceMinEnergy: params.convergenceMinEnergy,
      },
      source_types: cluster.sourceTypes,
      origin_keys: cluster.originKeys,
    },
  });
  const trendAddr = await birthTrendFromCluster(cluster.id);
  return { trend_addr: trendAddr, space_id: cluster.space_id };
}

export async function archiveTrendNow(addr: string): Promise<void> {
  await archiveTrend(addr);
}

export async function getTrendContributionOverrides(nodeAddr: string): Promise<{ halflifeHours: number; peakDelayHours: number } | null> {
  const params = await loadTrendParams();
  const [row] = await sql`
    SELECT source_context
    FROM nodes
    WHERE addr = ${nodeAddr}
      AND node_type = 'trend'
  `;
  if (!row) return null;
  const sourceContext = typeof row.source_context === "string"
    ? JSON.parse(row.source_context)
    : (row.source_context || {});
  const trend = sourceContext.trend || {};
  return {
    halflifeHours: parseFloat(trend.current_halflife_hours || params.baseHalflifeHours),
    peakDelayHours: 0,
  };
}

export async function getTrendHeatBudget(): Promise<number> {
  const params = await loadTrendParams();
  return params.heatBudget;
}

export async function getTrendDashboard(agentId?: string | null, spaceFilter: TrendSpaceFilter = null, tenantId?: string | null): Promise<any> {
  const trendRows = await sql`
    SELECT addr, label, substance, source_context, stimulus_heat, created_at, space_id
    FROM nodes
    WHERE node_type = 'trend'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
  `;

  let affinity: Record<string, number> = {};
  if (agentId) {
    // MT14: always tenant-scope (the route caller always supplies the tenant). A call
    // shape with an agentId but no tenant resolves to tenant_id = NULL → no row → empty
    // affinity, never another tenant's profile.
    const [profile] = await sql`
      SELECT domain_affinity FROM agent_profiles
      WHERE agent_id = ${agentId} AND tenant_id = ${tenantId ?? null}
    `;
    if (profile?.domain_affinity) {
      affinity = typeof profile.domain_affinity === "string"
        ? JSON.parse(profile.domain_affinity)
        : profile.domain_affinity;
    }
  }

  const emerging: any[] = [];
  const activeTrends: any[] = [];
  const graduating: any[] = [];
  for (const row of trendRows) {
    const sourceContext = typeof row.source_context === "string"
      ? JSON.parse(row.source_context)
      : (row.source_context || {});
    const trend = sourceContext.trend || {};
    const domains = Array.isArray(row.substance?.domains) ? row.substance.domains : [];
    let relevance = null;
    if (agentId) {
      relevance = domains.reduce((sum: number, domain: string) => sum + (affinity[domain] || 0), 0) / Math.max(domains.length, 1);
    }
    const item = {
      addr: row.addr,
      label: row.label,
      description: row.substance?.description || null,
      lifecycle: trend.lifecycle || "emerging",
      birth_time: trend.birth_time || row.created_at,
      energy: parseFloat(row.stimulus_heat || 0),
      velocity: parseFloat(trend.velocity || 0),
      source_diversity: parseInt(trend.source_diversity || 0),
      origin_diversity: parseInt(trend.origin_diversity || 0),
      source_types: trend.source_types || [],
      origin_keys: trend.origin_keys || [],
      effective_halflife_hours: parseFloat(trend.current_halflife_hours || DEFAULT_PARAMS.baseHalflifeHours),
      stimulus_count: Array.isArray(trend.feed_timestamps) ? trend.feed_timestamps.length : 0,
      incarnation: parseInt(trend.incarnation || 1),
      graduation_eligible: Boolean(trend.graduation_eligible),
      relevance,
    };
    if (item.lifecycle === "emerging") emerging.push(item);
    else activeTrends.push(item);
    if (item.graduation_eligible) graduating.push(item);
  }

  const recentlyDied = await sql`
    SELECT original_addr, label, death_time, birth_time
    FROM trend_archive
    WHERE death_time > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY death_time DESC
    LIMIT 20
  `;

  const [stats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE node_type = 'trend') as total_live,
      COUNT(*) FILTER (WHERE node_type = 'trend' AND source_context->'trend'->>'lifecycle' = 'emerging') as total_emerging,
      COUNT(*) FILTER (
        WHERE node_type = 'trend'
          AND (source_context->'trend'->>'birth_time')::timestamptz > now() - interval '24 hours'
      ) as born_last_24h
    FROM nodes
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [deadStats] = await sql`
    SELECT COUNT(*) as died_last_24h
    FROM trend_archive
    WHERE death_time > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [orphanStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE is_orphan = true AND orphan_status = 'throbbing') as orphan_pool_size
    FROM stimuli
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [clusterStats] = await sql`
    SELECT COUNT(*) as proto_cluster_count
    FROM wi_proto_clusters
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;

  return {
    active_trends: activeTrends,
    emerging,
    graduating,
    recently_died: recentlyDied.map((row: any) => ({
      addr: row.original_addr,
      label: row.label,
      died_at: row.death_time,
      lived_hours: Math.max(
        0,
        (new Date(row.death_time).getTime() - new Date(row.birth_time).getTime()) / 3_600_000,
      ),
    })),
    stats: {
      total_active: parseInt(stats.total_live || 0) - parseInt(stats.total_emerging || 0),
      total_emerging: parseInt(stats.total_emerging || 0),
      born_last_24h: parseInt(stats.born_last_24h || 0),
      died_last_24h: parseInt(deadStats.died_last_24h || 0),
      orphan_pool_size: parseInt(orphanStats.orphan_pool_size || 0),
      proto_cluster_count: parseInt(clusterStats.proto_cluster_count || 0),
    },
  };
}

export async function getTrendRuntimeState(limit = 25, spaceFilter: TrendSpaceFilter = null): Promise<any> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const params = await loadTrendParams();
  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM stimuli WHERE processed = false AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS pending_stimuli,
      (SELECT COUNT(*)::int FROM stimuli WHERE is_orphan = true AND orphan_status = 'throbbing' AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS orphan_pool_size,
      (SELECT COUNT(*)::int FROM wi_proto_clusters WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS proto_cluster_count,
      (SELECT COUNT(*)::int FROM nodes WHERE node_type = 'trend' AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS live_trend_count,
      (SELECT COUNT(*)::int FROM trend_archive WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS archived_trend_count,
      (SELECT COUNT(*)::int FROM trend_events WHERE created_at > now() - interval '24 hours' AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}) AS trend_events_last_24h,
      (SELECT COUNT(*)::int
         FROM edges e
         LEFT JOIN nodes nf ON nf.addr = e.from_addr
         LEFT JOIN nodes nt ON nt.addr = e.to_addr
        WHERE e.edge_type = 'trend_affects'
          AND ${spaceFilter === null ? sql`true` : sql`e.space_id = ANY(${spaceFilter}::text[])`}
          AND (nf.addr IS NULL OR nt.addr IS NULL)
      ) AS dangling_trend_edges
  `;
  const [ingestStats] = await sql`
    SELECT
      COUNT(*)::int AS total_last_24h,
      COUNT(*) FILTER (WHERE is_orphan = true)::int AS orphaned_last_24h,
      COUNT(*) FILTER (WHERE is_orphan = false)::int AS anchored_last_24h,
      COUNT(*) FILTER (WHERE is_orphan = false AND node_addr LIKE 'WD.%')::int AS world_anchored_last_24h,
      COUNT(*) FILTER (WHERE is_orphan = false AND node_addr LIKE 'FN.%')::int AS function_anchored_last_24h,
      COUNT(*) FILTER (WHERE is_orphan = false AND node_addr LIKE 'TN.%')::int AS trend_anchored_last_24h,
      COUNT(*) FILTER (WHERE proto_cluster_id IS NOT NULL)::int AS proto_clustered_last_24h,
      COUNT(*) FILTER (WHERE processed = true)::int AS processed_last_24h,
      (
        SELECT COUNT(*)::int
        FROM nodes
        WHERE node_type = 'trend'
          AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
      ) AS live_trends_with_stimuli
    FROM stimuli
    WHERE created_at > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const ingestBySource = await sql`
    SELECT source,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_orphan = true)::int AS orphaned,
      COUNT(*) FILTER (WHERE is_orphan = false)::int AS anchored
    FROM stimuli
    WHERE created_at > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY source
    ORDER BY total DESC
  `;

  const orphanRows = await sql`
    SELECT id, ingest_batch_id, source, temporality, energy, decay_halflife_hours,
      created_at, processed, proto_cluster_id, node_addr, left(content, 180) as content_preview
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;

  const liveTrendRows = await sql`
    SELECT addr, label, source_context, stimulus_heat, created_at, space_id
    FROM nodes
    WHERE node_type = 'trend'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
  const allLiveTrendRows = await sql`
    SELECT addr, label, source_context, stimulus_heat, created_at, space_id
    FROM nodes
    WHERE node_type = 'trend'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;

  const recentEvents = await sql`
    SELECT id, event_type, stimulus_id, proto_cluster_id, trend_addr, ingest_batch_id, payload, created_at
    FROM trend_events
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
  const eventBreakdownRows = await sql`
    SELECT event_type, COUNT(*)::int as n
    FROM trend_events
    WHERE created_at > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY event_type
    ORDER BY n DESC, event_type ASC
  `;
  const [auditStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int as pending_count,
      COUNT(*) FILTER (WHERE status = 'completed' AND processed_at > now() - interval '24 hours')::int as completed_last_24h,
      COUNT(*) FILTER (
        WHERE decision_kind = 'trend_duplicate_candidate'
          AND created_at > now() - interval '24 hours'
      )::int as duplicate_candidates_last_24h
    FROM trend_decision_audits
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const recentAudits = await sql`
    SELECT id, decision_kind, ref_kind, ref_id, trend_addr, status, actionable_summary,
      recommended_action, action_items, confidence, model, error, policy_status, policy_note,
      policy_applied_at, created_at, processed_at
    FROM trend_decision_audits
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT ${Math.max(5, Math.min(safeLimit, 20))}
  `;
  const policyOverrides = await sql`
    SELECT ref_kind, ref_id, action, hold_until, source_audit_id, metadata, updated_at
    FROM trend_policy_overrides
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY updated_at DESC
    LIMIT ${Math.max(5, Math.min(safeLimit, 20))}
  `;
  const dedupStateRows = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key = ANY(${[
      "trend_live_dedup_last_run_at",
      "trend_live_dedup_last_scanned_pairs",
      "trend_live_dedup_last_flagged_pairs",
    ]}::text[])
  `;
  const dedupState = new Map<string, string>(dedupStateRows.map((row: any) => [row.key, row.value]));

  const protoClusters = await listProtoClusters(spaceFilter);
  const liveTrendState = allLiveTrendRows.map((row: any) => {
    const sourceContext = typeof row.source_context === "string"
      ? JSON.parse(row.source_context)
      : (row.source_context || {});
    const trend = sourceContext.trend || {};
    return {
      addr: row.addr,
      label: row.label,
      lifecycle: String(trend.lifecycle || "emerging"),
      currentHalflifeHours: Number.parseFloat(trend.current_halflife_hours || params.baseHalflifeHours),
      velocity: Number.parseFloat(trend.velocity || 0),
      avgDirectEnergy7d: Number.parseFloat(trend.avg_direct_energy_7d || 0),
      stimulusHeat: Number.parseFloat(row.stimulus_heat || 0),
      sourceDiversity: Number.parseInt(trend.source_diversity || 0, 10),
      originDiversity: Number.parseInt(trend.origin_diversity || 0, 10),
      graduationEligible: Boolean(trend.graduation_eligible),
      lastStimulusAt: trend.last_stimulus_at || null,
      birthTime: trend.birth_time || row.created_at,
    };
  });
  const lifecycleCounts = liveTrendState.reduce((acc: Record<string, number>, item) => {
    acc[item.lifecycle] = (acc[item.lifecycle] || 0) + 1;
    return acc;
  }, {});
  const hottest = [...liveTrendState]
    .sort((a, b) => b.stimulusHeat - a.stimulusHeat)
    .slice(0, Math.min(8, safeLimit));
  const fastest = [...liveTrendState]
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, Math.min(8, safeLimit));
  const steadiest = [...liveTrendState]
    .sort((a, b) => b.currentHalflifeHours - a.currentHalflifeHours)
    .slice(0, Math.min(8, safeLimit));

  return {
    stats: {
      pending_stimuli: parseInt(stats.pending_stimuli || 0),
      orphan_pool_size: parseInt(stats.orphan_pool_size || 0),
      proto_cluster_count: parseInt(stats.proto_cluster_count || 0),
      live_trend_count: parseInt(stats.live_trend_count || 0),
      archived_trend_count: parseInt(stats.archived_trend_count || 0),
      trend_events_last_24h: parseInt(stats.trend_events_last_24h || 0),
      dangling_trend_edges: parseInt(stats.dangling_trend_edges || 0),
    },
    config: {
      params,
      cache_ttl_ms: TREND_PARAM_CACHE_MS,
    },
    monitoring: {
      doctrine: {
        long_halflife_signal: "steady_sustained_multi_origin",
        short_halflife_signal: "bursty_novelty_without_reinforcement",
      },
      ingest_delivery_last_24h: {
        total: parseInt(ingestStats.total_last_24h || 0, 10),
        orphaned: parseInt(ingestStats.orphaned_last_24h || 0, 10),
        anchored: parseInt(ingestStats.anchored_last_24h || 0, 10),
        world_anchored: parseInt(ingestStats.world_anchored_last_24h || 0, 10),
        function_anchored: parseInt(ingestStats.function_anchored_last_24h || 0, 10),
        trend_anchored: parseInt(ingestStats.trend_anchored_last_24h || 0, 10),
        proto_clustered: parseInt(ingestStats.proto_clustered_last_24h || 0, 10),
        processed: parseInt(ingestStats.processed_last_24h || 0, 10),
        live_trends_with_stimuli: parseInt(ingestStats.live_trends_with_stimuli || 0, 10),
        by_source: ingestBySource.map((row: any) => ({
          source: row.source,
          total: parseInt(row.total || 0, 10),
          orphaned: parseInt(row.orphaned || 0, 10),
          anchored: parseInt(row.anchored || 0, 10),
        })),
      },
      lifecycle_counts: lifecycleCounts,
      halflife_hours: buildNumericSummary(liveTrendState.map((item) => item.currentHalflifeHours)),
      velocity: buildNumericSummary(liveTrendState.map((item) => item.velocity)),
      avg_direct_energy_7d: buildNumericSummary(liveTrendState.map((item) => item.avgDirectEnergy7d)),
      stimulus_heat: buildNumericSummary(liveTrendState.map((item) => item.stimulusHeat)),
      source_diversity: buildNumericSummary(liveTrendState.map((item) => item.sourceDiversity)),
      origin_diversity: buildNumericSummary(liveTrendState.map((item) => item.originDiversity)),
      event_breakdown_last_24h: eventBreakdownRows.map((row: any) => ({
        event_type: row.event_type,
        count: parseInt(row.n || 0, 10),
      })),
      hottest_trends: hottest,
      fastest_risers: fastest,
      steadiest_trends: steadiest,
    },
    orphan_pool: orphanRows.map((row: any) => ({
      id: row.id,
      ingest_batch_id: row.ingest_batch_id,
      source: row.source,
      temporality: row.temporality,
      processed: Boolean(row.processed),
      proto_cluster_id: row.proto_cluster_id,
      node_addr: row.node_addr,
      age_hours: (Date.now() - new Date(row.created_at).getTime()) / 3_600_000,
      live_energy: currentEnergy({
        energy: parseFloat(row.energy),
        decay_halflife_hours: parseFloat(row.decay_halflife_hours),
        created_at: asDate(row.created_at),
      } as any),
      content_preview: row.content_preview,
      created_at: row.created_at,
    })),
    proto_clusters: protoClusters.slice(0, safeLimit),
    live_trends: liveTrendRows.map((row: any) => {
      const sourceContext = typeof row.source_context === "string"
        ? JSON.parse(row.source_context)
        : (row.source_context || {});
      const trend = sourceContext.trend || {};
      return {
        addr: row.addr,
        label: row.label,
        lifecycle: trend.lifecycle || "emerging",
        birth_time: trend.birth_time || row.created_at,
        last_stimulus_at: trend.last_stimulus_at || null,
        stimulus_heat: parseFloat(row.stimulus_heat || 0),
        source_diversity: parseInt(trend.source_diversity || 0),
        incarnation: parseInt(trend.incarnation || 1),
        graduation_eligible: Boolean(trend.graduation_eligible),
      };
    }),
    recent_events: recentEvents.map((row: any) => ({
      id: row.id,
      event_type: row.event_type,
      stimulus_id: row.stimulus_id,
      proto_cluster_id: row.proto_cluster_id,
      trend_addr: row.trend_addr,
      ingest_batch_id: row.ingest_batch_id,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      created_at: row.created_at,
    })),
    sidecar: {
      mode: "async_advisory_with_bounded_hold_policy",
      pending_audits: parseInt(auditStats.pending_count || 0),
      completed_last_24h: parseInt(auditStats.completed_last_24h || 0),
      duplicate_candidates_last_24h: parseInt(auditStats.duplicate_candidates_last_24h || 0),
      recent_audits: recentAudits.map((row: any) => ({
        id: row.id,
        decision_kind: row.decision_kind,
        ref_kind: row.ref_kind,
        ref_id: row.ref_id,
        trend_addr: row.trend_addr,
        status: row.status,
        actionable_summary: row.actionable_summary,
        recommended_action: row.recommended_action,
        action_items: typeof row.action_items === "string" ? JSON.parse(row.action_items) : row.action_items,
        confidence: row.confidence == null ? null : parseFloat(row.confidence),
        model: row.model,
        error: row.error,
        policy_status: row.policy_status,
        policy_note: row.policy_note,
        policy_applied_at: row.policy_applied_at,
        created_at: row.created_at,
        processed_at: row.processed_at,
      })),
      active_overrides: policyOverrides.map((row: any) => ({
        ref_kind: row.ref_kind,
        ref_id: row.ref_id,
        action: row.action,
        hold_until: row.hold_until,
        source_audit_id: row.source_audit_id == null ? null : parseInt(row.source_audit_id),
        metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        updated_at: row.updated_at,
      })),
    },
    automation: {
      orphan_attachment: "automatic_on_stimulus_write",
      trend_birth: "automatic_during_reactor_maintenance",
      archive_cleanup: "automatic_during_trend_archive",
      decision_sidecar: "async_advisory_with_bounded_policy_feedback",
      sidecar_policy: "bounded_hold_override_only",
      live_trend_dedup: "deterministic_low_frequency_duplicate_sweep_with_sidecar_review",
      live_trend_dedup_last_run_at: dedupState.get("trend_live_dedup_last_run_at") || null,
      live_trend_dedup_last_scanned_pairs: parseInt(dedupState.get("trend_live_dedup_last_scanned_pairs") || "0"),
      live_trend_dedup_last_flagged_pairs: parseInt(dedupState.get("trend_live_dedup_last_flagged_pairs") || "0"),
    },
  };
}

export async function traceTrendActivity(input: {
  batchId?: string | null;
  stimulusId?: number | null;
  contentLike?: string | null;
  limit?: number;
}, spaceFilter: TrendSpaceFilter = null): Promise<any> {
  const safeLimit = Math.max(1, Math.min(input.limit || 50, 200));
  if (!input.stimulusId && !input.batchId && !input.contentLike) {
    throw new Error("traceTrendActivity requires batchId, stimulusId, or contentLike");
  }
  const contentPattern = input.contentLike ? `%${input.contentLike}%` : null;

  const stimuli = await sql`
    SELECT id, source, source_id, stimulus_type, content, ingest_batch_id, temporality,
      processed, processed_at, is_orphan, orphan_status, proto_cluster_id, node_addr,
      energy, decay_halflife_hours, created_at
    FROM stimuli
    WHERE (
      (${input.stimulusId ?? null}::int IS NOT NULL AND id = ${input.stimulusId ?? null})
      OR (${input.batchId ?? null}::text IS NOT NULL AND ingest_batch_id = ${input.batchId ?? null})
      OR (${contentPattern}::text IS NOT NULL AND content ILIKE ${contentPattern})
    )
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at ASC
    LIMIT ${safeLimit}
  `;

  const stimulusIds = stimuli.map((row: any) => row.id);
  const batchIds = [...new Set(stimuli.map((row: any) => row.ingest_batch_id).filter(Boolean))];

  let eventRows: any[] = [];
  if (stimulusIds.length > 0 || batchIds.length > 0) {
    eventRows = await sql`
      SELECT id, event_type, stimulus_id, proto_cluster_id, trend_addr, ingest_batch_id, payload, created_at
      FROM trend_events
      WHERE (
        (${stimulusIds.length > 0}::boolean = true AND stimulus_id = ANY(${stimulusIds}::int[]))
        OR (${batchIds.length > 0}::boolean = true AND ingest_batch_id = ANY(${batchIds}::text[]))
      )
        AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
      ORDER BY created_at ASC
      LIMIT ${safeLimit * 4}
    `;
  }

  const clusterIds = [...new Set([
    ...stimuli.map((row: any) => row.proto_cluster_id).filter(Boolean),
    ...eventRows.map((row: any) => row.proto_cluster_id).filter(Boolean),
  ])];
  const trendAddrs = [...new Set([
    ...stimuli.map((row: any) => (typeof row.node_addr === "string" && row.node_addr.startsWith("TN.") ? row.node_addr : null)).filter(Boolean),
    ...eventRows.map((row: any) => row.trend_addr).filter(Boolean),
  ])];

  const clusters = clusterIds.length > 0
    ? await sql`
        SELECT id, orphan_count, source_types, total_energy, created_at, last_fed, space_id
        FROM wi_proto_clusters
        WHERE id = ANY(${clusterIds}::uuid[])
          AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
        ORDER BY created_at ASC
      `
    : [];

  const liveTrends = trendAddrs.length > 0
    ? await sql`
        SELECT addr, label, source_context, created_at, stimulus_heat, space_id
        FROM nodes
        WHERE addr = ANY(${trendAddrs}::text[])
          AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
      `
    : [];

  const archivedTrends = trendAddrs.length > 0
    ? await sql`
        SELECT id, original_addr, prior_addr, label, birth_time, death_time, incarnation, source_context, space_id
        FROM trend_archive
        WHERE (
          original_addr = ANY(${trendAddrs}::text[])
          OR COALESCE(prior_addr, '') = ANY(${trendAddrs}::text[])
        )
          AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
        ORDER BY death_time ASC
      `
    : [];

  const contributions = stimulusIds.length > 0
    ? await sql`
        SELECT sc.stimulus_id, sc.node_addr, sc.base_contribution, sc.contribution, sc.created_at
        FROM stimulus_contributions sc
        WHERE sc.stimulus_id = ANY(${stimulusIds}::int[])
        ORDER BY sc.created_at ASC
      `
    : [];
  const decisionAudits = clusterIds.length > 0 || trendAddrs.length > 0
    ? await sql`
        SELECT id, decision_kind, ref_kind, ref_id, trend_addr, status, actionable_summary,
          recommended_action, action_items, confidence, model, error, policy_status, policy_note,
          policy_applied_at, created_at, processed_at
        FROM trend_decision_audits
        WHERE (
          (ref_kind = 'proto_cluster' AND ref_id = ANY(${clusterIds}::text[]))
          OR (trend_addr IS NOT NULL AND trend_addr = ANY(${trendAddrs}::text[]))
        )
          AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `
    : [];

  return {
    query: {
      batch_id: input.batchId || null,
      stimulus_id: input.stimulusId || null,
      content_like: input.contentLike || null,
    },
    automatic_birth_observed: eventRows.some((row) => ["trend_born", "trend_recurred", "trend_adopted"].includes(row.event_type)),
    maintenance_dependency: "trend birth is automatic when Reactor maintenance runs",
    stimuli: stimuli.map((row: any) => ({
      id: row.id,
      source: row.source,
      source_id: row.source_id,
      stimulus_type: row.stimulus_type,
      ingest_batch_id: row.ingest_batch_id,
      temporality: row.temporality,
      processed: Boolean(row.processed),
      processed_at: row.processed_at,
      is_orphan: Boolean(row.is_orphan),
      orphan_status: row.orphan_status,
      proto_cluster_id: row.proto_cluster_id,
      node_addr: row.node_addr,
      live_energy: currentEnergy({
        energy: parseFloat(row.energy),
        decay_halflife_hours: parseFloat(row.decay_halflife_hours),
        created_at: asDate(row.created_at),
      } as any),
      created_at: row.created_at,
      content: row.content,
      contributions: contributions
        .filter((contribution: any) => contribution.stimulus_id === row.id)
        .map((contribution: any) => ({
          node_addr: contribution.node_addr,
          base_contribution: parseFloat(contribution.base_contribution || 0),
          live_contribution: parseFloat(contribution.contribution || 0),
          created_at: contribution.created_at,
        })),
    })),
    event_timeline: eventRows.map((row: any) => ({
      id: row.id,
      event_type: row.event_type,
      stimulus_id: row.stimulus_id,
      proto_cluster_id: row.proto_cluster_id,
      trend_addr: row.trend_addr,
      ingest_batch_id: row.ingest_batch_id,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      created_at: row.created_at,
    })),
    proto_clusters: clusters.map((row: any) => ({
      id: row.id,
      orphan_count: parseInt(row.orphan_count || 0),
      source_types: row.source_types || [],
      total_energy: parseFloat(row.total_energy || 0),
      created_at: row.created_at,
      last_fed: row.last_fed,
    })),
    live_trends: liveTrends.map((row: any) => {
      const sourceContext = typeof row.source_context === "string"
        ? JSON.parse(row.source_context)
        : (row.source_context || {});
      const trend = sourceContext.trend || {};
      return {
        addr: row.addr,
        label: row.label,
        lifecycle: trend.lifecycle || "emerging",
        birth_time: trend.birth_time || row.created_at,
        last_stimulus_at: trend.last_stimulus_at || null,
        incarnation: parseInt(trend.incarnation || 1),
        stimulus_heat: parseFloat(row.stimulus_heat || 0),
      };
    }),
    archived_trends: archivedTrends.map((row: any) => ({
      id: row.id,
      original_addr: row.original_addr,
      prior_addr: row.prior_addr,
      label: row.label,
      birth_time: row.birth_time,
      death_time: row.death_time,
      incarnation: parseInt(row.incarnation || 1),
      source_context: typeof row.source_context === "string" ? JSON.parse(row.source_context) : row.source_context,
    })),
    decision_audits: decisionAudits.map((row: any) => ({
      id: row.id,
      decision_kind: row.decision_kind,
      ref_kind: row.ref_kind,
      ref_id: row.ref_id,
      trend_addr: row.trend_addr,
      status: row.status,
      actionable_summary: row.actionable_summary,
      recommended_action: row.recommended_action,
      action_items: typeof row.action_items === "string" ? JSON.parse(row.action_items) : row.action_items,
      confidence: row.confidence == null ? null : parseFloat(row.confidence),
      model: row.model,
      error: row.error,
      policy_status: row.policy_status,
      policy_note: row.policy_note,
      policy_applied_at: row.policy_applied_at,
      created_at: row.created_at,
      processed_at: row.processed_at,
    })),
  };
}

export async function closeTrendService(): Promise<void> {
  await closeVISql();
}
