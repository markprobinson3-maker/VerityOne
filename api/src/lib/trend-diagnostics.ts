/**
 * Trend pipeline diagnostics — VO-REACTOR-REVIVAL-LADDER-1 R1.
 *
 * Read-only diagnostic surfaces over the existing reactor + trend
 * tables. R1 ships zero behavior change; the goal is operator
 * visibility into *why* convergence is or is not happening so the
 * pipeline stops being a black box.
 *
 * The big idea: every gate that holds a proto-cluster is countable
 * from `wi_proto_clusters` (current state) + `trend_events` (logged
 * holds) + `loadTrendParams()` (live thresholds). R1 turns those into
 * a single payload at GET /trends/diagnostics so an operator can see
 * "X clusters held below convergenceMinOrphans, Y held by topic
 * incoherence" without spelunking SQL.
 *
 * Held-reason extraction (`extractHeldReason`) handles the three
 * payload variants that `recordTrendEvent({eventType:
 * 'proto_cluster_held'})` produces today: `payload.reason`,
 * `payload.decision.action`, and `payload.verdict.reason`. The
 * fallback `unknown_proto_cluster_hold` makes a future payload
 * variant a fingerprintable failure rather than a silent miss.
 *
 * Silent gates (orphan/source/origin/energy) are NOT logged today;
 * R1 reconstructs them by comparing `wi_proto_clusters` to the live
 * `loadTrendParams()` snapshot. R1 deliberately does not add logging
 * for these — that is a behavior change reserved for a later rung.
 */

import { sql } from "../db";
import {
  buildRssCoherenceSnapshot,
  listProtoClusters,
  loadTrendParams,
  type TrendParams,
} from "../../../miners/src/trends/service";

const HELD_REASON_FALLBACK = "unknown_proto_cluster_hold";
export type TrendSpaceFilter = string[] | null;

/**
 * Pull a normalized reason string from a `proto_cluster_held` event
 * payload. Production payloads come in three shapes:
 *
 *   - { reason: "insufficient_batch_diversity", ... }
 *   - { decision: { action: "hold_borderline_promotion", ... }, ... }
 *   - { reason: "not_actionable", verdict: { reason: "low_confidence" } }
 *
 * Precedence: explicit top-level `reason` wins (most specific). Then
 * `decision.action`. Then `verdict.reason` (carries the inner why for
 * an actionability hold). Anything else falls back to a single
 * sentinel so future payload variants surface as a tracked unknown.
 */
export function extractHeldReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return HELD_REASON_FALLBACK;
  const p = payload as Record<string, unknown>;
  if (typeof p.reason === "string" && p.reason.length > 0) return p.reason;
  const decision = p.decision as Record<string, unknown> | undefined;
  if (decision && typeof decision.action === "string" && decision.action.length > 0) {
    return decision.action;
  }
  const verdict = p.verdict as Record<string, unknown> | undefined;
  if (verdict && typeof verdict.reason === "string" && verdict.reason.length > 0) {
    return verdict.reason;
  }
  return HELD_REASON_FALLBACK;
}

export interface StimulusHealth {
  total: number;
  with_embedding: number;
  with_correlation: number;
  oldest_unprocessed_age_seconds: number | null;
  by_origin_kind: Array<{ origin_kind: string | null; count: number }>;
}

export async function getStimulusHealth(spaceFilter: TrendSpaceFilter = null): Promise<StimulusHealth> {
  const [agg] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_embedding,
      count(*) FILTER (WHERE correlation_id IS NOT NULL)::int AS with_correlation,
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE processed = false)))::int AS oldest_unprocessed_age_seconds
    FROM stimuli
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const byOrigin = await sql`
    SELECT origin_kind, count(*)::int AS count
    FROM stimuli
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY origin_kind
    ORDER BY count DESC, origin_kind NULLS FIRST
  `;
  return {
    total: Number(agg?.total ?? 0),
    with_embedding: Number(agg?.with_embedding ?? 0),
    with_correlation: Number(agg?.with_correlation ?? 0),
    oldest_unprocessed_age_seconds: agg?.oldest_unprocessed_age_seconds == null
      ? null
      : Number(agg.oldest_unprocessed_age_seconds),
    by_origin_kind: byOrigin.map((row: any) => ({
      origin_kind: row.origin_kind,
      count: Number(row.count),
    })),
  };
}

export interface OrphanPoolHealth {
  size: number;
  by_status: Array<{ orphan_status: string | null; count: number }>;
  age_histogram: Array<{ bucket: string; count: number }>;
}

export async function getOrphanPoolHealth(spaceFilter: TrendSpaceFilter = null): Promise<OrphanPoolHealth> {
  const [{ size }] = await sql`
    SELECT count(*)::int AS size FROM stimuli
    WHERE is_orphan = true
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const byStatus = await sql`
    SELECT orphan_status, count(*)::int AS count
    FROM stimuli
    WHERE is_orphan = true
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY orphan_status
    ORDER BY count DESC, orphan_status NULLS FIRST
  `;
  // Age buckets in hours: <1, 1-6, 6-24, 24-72, >72.
  const histogram = await sql`
    SELECT bucket, count(*)::int AS count
    FROM (
      SELECT CASE
        WHEN now() - created_at < interval '1 hour' THEN '<1h'
        WHEN now() - created_at < interval '6 hours' THEN '1-6h'
        WHEN now() - created_at < interval '24 hours' THEN '6-24h'
        WHEN now() - created_at < interval '72 hours' THEN '24-72h'
        ELSE '>72h'
      END AS bucket
      FROM stimuli
      WHERE is_orphan = true
        AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ) sub
    GROUP BY bucket
    ORDER BY (CASE bucket
      WHEN '<1h' THEN 1
      WHEN '1-6h' THEN 2
      WHEN '6-24h' THEN 3
      WHEN '24-72h' THEN 4
      ELSE 5
    END)
  `;
  return {
    size: Number(size),
    by_status: byStatus.map((row: any) => ({
      orphan_status: row.orphan_status,
      count: Number(row.count),
    })),
    age_histogram: histogram.map((row: any) => ({
      bucket: String(row.bucket),
      count: Number(row.count),
    })),
  };
}

export interface SilentGateCounts {
  below_min_orphans: number;
  below_min_sources: number;
  below_min_origins: number;
  below_min_energy: number;
}

export interface ProtoClusterHealth {
  total: number;
  by_age_bucket: Array<{ bucket: string; count: number }>;
  distinct_batch_diversity_distribution: Array<{ distinct_batches: number; cluster_count: number }>;
  silent_gate_counts: SilentGateCounts;
  silent_gate_thresholds: Pick<
    TrendParams,
    "convergenceMinOrphans" | "convergenceMinSources" | "convergenceMinOrigins" | "convergenceMinEnergy"
  >;
}

export async function getProtoClusterHealth(params: TrendParams, spaceFilter: TrendSpaceFilter = null): Promise<ProtoClusterHealth> {
  const [{ total }] = await sql`
    SELECT count(*)::int AS total FROM wi_proto_clusters
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;

  const byAge = await sql`
    SELECT bucket, count(*)::int AS count
    FROM (
      SELECT CASE
        WHEN now() - last_fed < interval '1 hour' THEN '<1h'
        WHEN now() - last_fed < interval '6 hours' THEN '1-6h'
        WHEN now() - last_fed < interval '24 hours' THEN '6-24h'
        WHEN now() - last_fed < interval '72 hours' THEN '24-72h'
        ELSE '>72h'
      END AS bucket
      FROM wi_proto_clusters
      WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ) sub
    GROUP BY bucket
    ORDER BY (CASE bucket
      WHEN '<1h' THEN 1
      WHEN '1-6h' THEN 2
      WHEN '6-24h' THEN 3
      WHEN '24-72h' THEN 4
      ELSE 5
    END)
  `;

  // Distinct ingest batches per cluster — the gate that fires
  // "insufficient_batch_diversity". Distribution across all clusters
  // makes it visible whether most are stuck at 1 batch.
  const batchDist = await sql`
    SELECT distinct_batches, count(*)::int AS cluster_count
    FROM (
      SELECT pc.id, count(DISTINCT s.ingest_batch_id) FILTER (WHERE s.ingest_batch_id IS NOT NULL) AS distinct_batches
      FROM wi_proto_clusters pc
      LEFT JOIN stimuli s ON s.proto_cluster_id = pc.id AND s.is_orphan = true
      WHERE ${spaceFilter === null ? sql`true` : sql`pc.space_id = ANY(${spaceFilter}::text[])`}
      GROUP BY pc.id
    ) sub
    GROUP BY distinct_batches
    ORDER BY distinct_batches
  `;

  // Silent pre-gates — clusters that would fail routeProtoCluster's
  // first four checks. These never write trend_events today; we
  // reconstruct the count by comparing live cluster state to the
  // live thresholds.
  const [silentRow] = await sql`
    SELECT
      count(*) FILTER (WHERE orphan_count < ${params.convergenceMinOrphans})::int AS below_min_orphans,
      count(*) FILTER (WHERE COALESCE(array_length(source_types, 1), 0) < ${params.convergenceMinSources})::int AS below_min_sources,
      count(*) FILTER (WHERE origin_diversity < ${params.convergenceMinOrigins})::int AS below_min_origins,
      count(*) FILTER (WHERE total_energy < ${params.convergenceMinEnergy})::int AS below_min_energy
    FROM wi_proto_clusters
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;

  return {
    total: Number(total),
    by_age_bucket: byAge.map((row: any) => ({ bucket: String(row.bucket), count: Number(row.count) })),
    distinct_batch_diversity_distribution: batchDist.map((row: any) => ({
      distinct_batches: Number(row.distinct_batches ?? 0),
      cluster_count: Number(row.cluster_count),
    })),
    silent_gate_counts: {
      below_min_orphans: Number(silentRow?.below_min_orphans ?? 0),
      below_min_sources: Number(silentRow?.below_min_sources ?? 0),
      below_min_origins: Number(silentRow?.below_min_origins ?? 0),
      below_min_energy: Number(silentRow?.below_min_energy ?? 0),
    },
    silent_gate_thresholds: {
      convergenceMinOrphans: params.convergenceMinOrphans,
      convergenceMinSources: params.convergenceMinSources,
      convergenceMinOrigins: params.convergenceMinOrigins,
      convergenceMinEnergy: params.convergenceMinEnergy,
    },
  };
}

export interface HeldReasonBucket {
  reason: string;
  count: number;
  sample_proto_cluster_ids: string[];
}

export async function getHeldReasonsBreakdown(windowHours = 24, spaceFilter: TrendSpaceFilter = null): Promise<HeldReasonBucket[]> {
  const rows = await sql`
    SELECT proto_cluster_id, payload
    FROM trend_events
    WHERE event_type = 'proto_cluster_held'
      AND created_at > now() - (${windowHours}::int * interval '1 hour')
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
  `;
  const buckets = new Map<string, { count: number; samples: string[] }>();
  for (const row of rows as any[]) {
    const reason = extractHeldReason(row.payload);
    let bucket = buckets.get(reason);
    if (!bucket) {
      bucket = { count: 0, samples: [] };
      buckets.set(reason, bucket);
    }
    bucket.count += 1;
    if (bucket.samples.length < 3 && row.proto_cluster_id) {
      const id = String(row.proto_cluster_id);
      if (!bucket.samples.includes(id)) bucket.samples.push(id);
    }
  }
  return [...buckets.entries()]
    .map(([reason, info]) => ({ reason, count: info.count, sample_proto_cluster_ids: info.samples }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface TrendLifecycleStats {
  live: number;
  archived: number;
  born_last_24h: number;
  died_last_24h: number;
  recurrence_distribution: Array<{ incarnation: number; count: number }>;
}

export async function getTrendLifecycleStats(spaceFilter: TrendSpaceFilter = null): Promise<TrendLifecycleStats> {
  const [{ live }] = await sql`
    SELECT count(*)::int AS live FROM nodes
    WHERE node_type = 'trend'
      AND visibility <> 'deleted'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [{ archived }] = await sql`
    SELECT count(*)::int AS archived FROM trend_archive
    WHERE ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [{ born_last_24h }] = await sql`
    SELECT count(*)::int AS born_last_24h
    FROM trend_events
    WHERE event_type = 'trend_born' AND created_at > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const [{ died_last_24h }] = await sql`
    SELECT count(*)::int AS died_last_24h
    FROM trend_events
    WHERE event_type = 'trend_archived' AND created_at > now() - interval '24 hours'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  // Recurrence distribution from trend_archive incarnation column.
  const recurrence = await sql`
    SELECT incarnation, count(*)::int AS count
    FROM trend_archive
    WHERE incarnation IS NOT NULL
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY incarnation
    ORDER BY incarnation
  `;
  return {
    live: Number(live),
    archived: Number(archived),
    born_last_24h: Number(born_last_24h),
    died_last_24h: Number(died_last_24h),
    recurrence_distribution: recurrence.map((row: any) => ({
      incarnation: Number(row.incarnation),
      count: Number(row.count),
    })),
  };
}

export interface TrendHealth {
  ok: boolean;
  oldest_unprocessed_age_seconds: number | null;
  threshold_seconds: number;
}

// Exported (R2): /trends/health route reuses this for the disabled-state
// branch so the literal `21600` / `60 * 60 * 6` doesn't get duplicated
// across the route layer.
export const DEFAULT_HEALTH_THRESHOLD_SECONDS = 60 * 60 * 6; // 6 hours

export async function getTrendHealth(
  thresholdSeconds = DEFAULT_HEALTH_THRESHOLD_SECONDS,
  spaceFilter: TrendSpaceFilter = null,
): Promise<TrendHealth> {
  const [{ age }] = await sql`
    SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS age
    FROM stimuli
    WHERE processed = false
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
  `;
  const oldest = age == null ? null : Number(age);
  return {
    ok: oldest == null ? true : oldest <= thresholdSeconds,
    oldest_unprocessed_age_seconds: oldest,
    threshold_seconds: thresholdSeconds,
  };
}

export interface TrendDiagnosticsPayload {
  generated_at: string;
  stimuli: StimulusHealth;
  orphan_pool: OrphanPoolHealth;
  proto_clusters: ProtoClusterHealth;
  trends: TrendLifecycleStats;
  held_reasons_24h: HeldReasonBucket[];
  health: TrendHealth;
}

export async function getTrendDiagnostics(spaceFilter: TrendSpaceFilter = null): Promise<TrendDiagnosticsPayload> {
  const params = await loadTrendParams();
  const [stimuli, orphan_pool, proto_clusters, trends, held_reasons_24h, health] = await Promise.all([
    getStimulusHealth(spaceFilter),
    getOrphanPoolHealth(spaceFilter),
    getProtoClusterHealth(params, spaceFilter),
    getTrendLifecycleStats(spaceFilter),
    getHeldReasonsBreakdown(24, spaceFilter),
    getTrendHealth(DEFAULT_HEALTH_THRESHOLD_SECONDS, spaceFilter),
  ]);
  return {
    generated_at: new Date().toISOString(),
    stimuli,
    orphan_pool,
    proto_clusters,
    trends,
    held_reasons_24h,
    health,
  };
}

function redactSample(value: unknown): string {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function topicTerms(value: unknown): string[] {
  const words = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 24);
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "being",
  "from",
  "have",
  "into",
  "more",
  "over",
  "that",
  "their",
  "there",
  "this",
  "with",
  "would",
]);

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection++;
  }
  return intersection / Math.max(1, new Set([...left, ...right]).size);
}

function parseJsonish(value: unknown): any {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? value : {};
}

export interface KnowledgeDebtBucket {
  space_id: string;
  origin_kind: string;
  age_bucket: "14-30d" | "30-60d" | ">60d";
  count: number;
  oldest_age_seconds: number;
  samples: string[];
}

export async function getKnowledgeDebt(spaceFilter: TrendSpaceFilter = null): Promise<KnowledgeDebtBucket[]> {
  const rows = await sql`
    SELECT
      space_id,
      COALESCE(origin_kind, 'unknown') AS origin_kind,
      CASE
        WHEN now() - created_at < interval '30 days' THEN '14-30d'
        WHEN now() - created_at < interval '60 days' THEN '30-60d'
        ELSE '>60d'
      END AS age_bucket,
      count(*)::int AS count,
      EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds,
      (array_agg(left(regexp_replace(content, E'[\\r\\n\\t]+', ' ', 'g'), 80) ORDER BY created_at DESC))[1:3] AS samples
    FROM stimuli
    WHERE is_orphan = true
      AND processed = false
      AND created_at < now() - interval '14 days'
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY space_id, COALESCE(origin_kind, 'unknown'), age_bucket
    ORDER BY count DESC, oldest_age_seconds DESC
    LIMIT 50
  `;
  return rows.map((row: any) => ({
    space_id: row.space_id,
    origin_kind: row.origin_kind,
    age_bucket: row.age_bucket,
    count: Number(row.count),
    oldest_age_seconds: Number(row.oldest_age_seconds || 0),
    samples: (row.samples || []).map(redactSample),
  }));
}

export interface PromotionCandidate {
  id: string;
  space_id: string;
  action: string;
  age_hours: number;
  orphan_count: number;
  source_types: string[];
  origin_keys: string[];
  origin_diversity: number;
  total_energy: number;
  decision_preview: unknown;
  thresholds: Pick<TrendParams, "convergenceMinOrphans" | "convergenceMinSources" | "convergenceMinOrigins" | "convergenceMinEnergy" | "graduationMinAgeDays">;
  sample_content: string[];
}

export async function getPromotionCandidates(
  spaceFilter: TrendSpaceFilter = null,
  params?: TrendParams,
): Promise<PromotionCandidate[]> {
  const trendParams = params || await loadTrendParams();
  const allowedActions = new Set(["hold_borderline_promotion", "birth", "recur", "adopt"]);
  const maxAgeHours = trendParams.graduationMinAgeDays * 24;
  const clusters = await listProtoClusters(spaceFilter);
  return clusters
    .map((cluster: any) => {
      const decision = cluster.decision_preview || {};
      const createdAt = new Date(cluster.created_at);
      const ageHours = Number.isFinite(createdAt.getTime())
        ? (Date.now() - createdAt.getTime()) / 3_600_000
        : 0;
      return { cluster, decision, ageHours };
    })
    .filter(({ decision, ageHours }) => allowedActions.has(String(decision.action || "")) && ageHours < maxAgeHours)
    .map(({ cluster, decision, ageHours }) => ({
      id: cluster.id,
      space_id: cluster.space_id,
      action: String(decision.action || ""),
      age_hours: Number(ageHours.toFixed(2)),
      orphan_count: Number(cluster.orphan_count || 0),
      source_types: cluster.source_types || [],
      origin_keys: cluster.origin_keys || [],
      origin_diversity: Number(cluster.origin_diversity || 0),
      total_energy: Number(cluster.total_energy || 0),
      decision_preview: decision,
      thresholds: {
        convergenceMinOrphans: trendParams.convergenceMinOrphans,
        convergenceMinSources: trendParams.convergenceMinSources,
        convergenceMinOrigins: trendParams.convergenceMinOrigins,
        convergenceMinEnergy: trendParams.convergenceMinEnergy,
        graduationMinAgeDays: trendParams.graduationMinAgeDays,
      },
      sample_content: (cluster.sample_content || []).slice(0, 3).map(redactSample),
    }));
}

export interface DriftConflictCandidate {
  proto_cluster_id: string;
  cluster_space_id: string;
  node_addr: string;
  node_label: string;
  node_space_id: string;
  similarity: number;
  conflict_score: number;
  lexical_divergence: number;
  external_source_ratio: number;
  repeated_terms: string[];
  sample_content: string[];
}

export async function getDriftConflicts(
  spaceFilter: TrendSpaceFilter = null,
  params?: TrendParams,
): Promise<DriftConflictCandidate[]> {
  const trendParams = params || await loadTrendParams();
  const clusters = await sql`
    SELECT pc.id, pc.space_id, pc.centroid::text AS centroid, pc.source_types,
      array_agg(s.content ORDER BY s.created_at DESC) FILTER (WHERE s.content IS NOT NULL) AS contents,
      count(s.id)::int AS member_count,
      count(s.id) FILTER (
        WHERE lower(COALESCE(s.origin_kind, '')) IN ('rss', 'hn', 'hackernews', 'arxiv', 'coingecko', 'external', 'feed')
          OR lower(COALESCE(s.source, '')) IN ('rss', 'hn', 'hackernews', 'arxiv', 'coingecko')
      )::int AS external_count
    FROM wi_proto_clusters pc
    LEFT JOIN stimuli s ON s.proto_cluster_id = pc.id AND s.is_orphan = true AND s.orphan_status = 'throbbing'
    WHERE pc.centroid IS NOT NULL
      AND ${spaceFilter === null ? sql`true` : sql`pc.space_id = ANY(${spaceFilter}::text[])`}
    GROUP BY pc.id, pc.space_id, pc.centroid, pc.source_types
    LIMIT 100
  `;

  const out: DriftConflictCandidate[] = [];
  for (const cluster of clusters as any[]) {
    const contents = (cluster.contents || []).map(String).filter(Boolean);
    const coherence = buildRssCoherenceSnapshot(contents, trendParams.rssMinSharedTerms);
    const clusterTerms = coherence.repeatedTerms.length > 0
      ? coherence.repeatedTerms
      : topicTerms(contents.join(" "));
    const memberCount = Number(cluster.member_count || 0);
    const externalSourceRatio = memberCount === 0 ? 0 : Number(cluster.external_count || 0) / memberCount;
    const candidateSpaces = [...new Set([cluster.space_id, "global"])]
      .filter((spaceId) => spaceFilter === null || spaceFilter.includes(spaceId));
    if (candidateSpaces.length === 0) continue;

    const nodes = await sql`
      SELECT addr, label, substance, space_id,
        1 - (embedding_hv <=> ${cluster.centroid}::halfvec) AS similarity
      FROM nodes
      WHERE embedding_hv IS NOT NULL
        AND node_type <> 'trend'
        AND pyramid_id <> 'TN'
        AND space_id = ANY(${candidateSpaces}::text[])
        AND visibility <> 'deleted'
        AND 1 - (embedding_hv <=> ${cluster.centroid}::halfvec) >= ${trendParams.autoWireMinSimilarity}
      ORDER BY embedding_hv <=> ${cluster.centroid}::halfvec
      LIMIT 20
    `;
    for (const node of nodes as any[]) {
      const substance = parseJsonish(node.substance);
      const nodeTerms = topicTerms(`${node.label || ""} ${substance.summary || ""} ${substance.description || ""}`);
      const lexicalDivergence = 1 - jaccard(clusterTerms, nodeTerms);
      const similarity = Number(node.similarity || 0);
      out.push({
        proto_cluster_id: cluster.id,
        cluster_space_id: cluster.space_id,
        node_addr: node.addr,
        node_label: node.label,
        node_space_id: node.space_id,
        similarity,
        conflict_score: Number((similarity * lexicalDivergence * externalSourceRatio).toFixed(6)),
        lexical_divergence: Number(lexicalDivergence.toFixed(6)),
        external_source_ratio: Number(externalSourceRatio.toFixed(6)),
        repeated_terms: clusterTerms.slice(0, 12),
        sample_content: contents.slice(0, 3).map(redactSample),
      });
    }
  }
  return out
    .sort((a, b) => b.conflict_score - a.conflict_score || b.similarity - a.similarity)
    .slice(0, 100);
}

export interface AgentGap {
  key: string;
  query_count: number;
  orphan_count: number;
  sample_queries: string[];
  orphan_samples: string[];
  terms: string[];
}

export async function getAgentGaps(): Promise<AgentGap[]> {
  const queryRows = await sql`
    SELECT query, results_returned, top_similarity, created_at
    FROM query_log
    WHERE created_at > now() - interval '7 days'
      AND (top_similarity < 0.4 OR results_returned = 0)
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const orphanRows = await sql`
    SELECT content, source, origin_kind
    FROM stimuli
    WHERE is_orphan = true
      AND orphan_status = 'throbbing'
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const orphanTerms = orphanRows.map((row: any) => ({
    content: redactSample(row.content),
    terms: topicTerms(`${row.content || ""} ${row.source || ""} ${row.origin_kind || ""}`),
  }));
  const groups = new Map<string, AgentGap>();
  for (const row of queryRows as any[]) {
    const terms = topicTerms(row.query);
    if (terms.length === 0) continue;
    const key = terms.slice(0, 3).sort().join("|");
    let group = groups.get(key);
    if (!group) {
      const matchingOrphans = orphanTerms.filter((orphan) => terms.some((term) => orphan.terms.includes(term)));
      group = {
        key,
        query_count: 0,
        orphan_count: matchingOrphans.length,
        sample_queries: [],
        orphan_samples: matchingOrphans.slice(0, 3).map((row) => row.content),
        terms: terms.slice(0, 8),
      };
      groups.set(key, group);
    }
    group.query_count++;
    if (group.sample_queries.length < 3) group.sample_queries.push(redactSample(row.query));
  }
  return [...groups.values()]
    .sort((a, b) => b.query_count - a.query_count || b.orphan_count - a.orphan_count)
    .slice(0, 50);
}

export interface TrendAuditEntry {
  source: "trend_events" | "trend_decision_audits";
  id: number;
  event_type?: string;
  decision_kind?: string;
  ref_kind?: string;
  ref_id?: string;
  proto_cluster_id?: string | null;
  trend_addr?: string | null;
  payload: unknown;
  created_at: string;
}

export async function getProtoClusterAudit(
  protoClusterId: string,
  spaceFilter: TrendSpaceFilter = null,
): Promise<TrendAuditEntry[]> {
  const events = await sql`
    SELECT 'trend_events'::text AS source, id::int AS id, event_type, proto_cluster_id, trend_addr,
           payload, created_at
    FROM trend_events
    WHERE proto_cluster_id = ${protoClusterId}::uuid
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  const audits = await sql`
    SELECT 'trend_decision_audits'::text AS source, id::int AS id, decision_kind, ref_kind, ref_id,
           trend_addr, payload, created_at
    FROM trend_decision_audits
    WHERE ref_kind = 'proto_cluster' AND ref_id = ${protoClusterId}
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return mergeAuditEntries(events, audits);
}

export async function getTrendAddrAudit(
  trendAddr: string,
  spaceFilter: TrendSpaceFilter = null,
): Promise<TrendAuditEntry[]> {
  const events = await sql`
    SELECT 'trend_events'::text AS source, id::int AS id, event_type, proto_cluster_id, trend_addr,
           payload, created_at
    FROM trend_events
    WHERE trend_addr = ${trendAddr}
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  const audits = await sql`
    SELECT 'trend_decision_audits'::text AS source, id::int AS id, decision_kind, ref_kind, ref_id,
           trend_addr, payload, created_at
    FROM trend_decision_audits
    WHERE (trend_addr = ${trendAddr} OR (ref_kind = 'trend' AND ref_id = ${trendAddr}))
      AND ${spaceFilter === null ? sql`true` : sql`space_id = ANY(${spaceFilter}::text[])`}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return mergeAuditEntries(events, audits);
}

function mergeAuditEntries(events: any[], audits: any[]): TrendAuditEntry[] {
  const merged: TrendAuditEntry[] = [];
  for (const row of events) {
    merged.push({
      source: "trend_events",
      id: Number(row.id),
      event_type: row.event_type,
      proto_cluster_id: row.proto_cluster_id ? String(row.proto_cluster_id) : null,
      trend_addr: row.trend_addr,
      payload: row.payload,
      created_at: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    });
  }
  for (const row of audits) {
    merged.push({
      source: "trend_decision_audits",
      id: Number(row.id),
      decision_kind: row.decision_kind,
      ref_kind: row.ref_kind,
      ref_id: row.ref_id,
      trend_addr: row.trend_addr,
      payload: row.payload,
      created_at: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    });
  }
  return merged
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, 100);
}
