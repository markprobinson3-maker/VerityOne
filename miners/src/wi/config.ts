/**
 * World Ingestor V2 — Configuration, types, source profiles, params.
 */

import postgres from "postgres";

export const sql = postgres("postgresql://localhost:5432/verity");

// ============================================================
// TYPES
// ============================================================

export interface RawSource {
  text: string;
  textParts: string[];
  title: string;
  sourceUrl: string;
  sourceType: string;
  sourceHash: string;
  runId: string;
  metadata?: Record<string, any>;
}

export interface ExtractedAtom {
  content: string;
  type: "KNOWLEDGE" | "SKILL";
  subtype: "claim" | "framework" | "signal" | "technique" | "workflow" | "tool" | "integration";
  domains: string[];
  importance: number;
  actionability: number;
  temporality?: "DURABLE" | "CURRENT" | "EPHEMERAL";
  embedding?: number[];
}

export interface EnrichmentData {
  enrichedContent: string;
  edgeSuggestions: Array<{ target_addr: string; edge_type: string; reason: string }>;
  batchRelationships: Array<{ related_atom_id: string; relationship: string }>;
  heatSignature: { primary_domain: string; intensity: number; decay_class: "slow" | "medium" | "fast" };
  enrichmentScore: number;
  priority: number;
}

export interface EnrichedAtom extends ExtractedAtom {
  poolId: string;
  enrichment?: EnrichmentData;
}

export interface RoutedAtom extends ExtractedAtom {
  route: "NEW_NODE" | "HEAT" | "SKILL_PROPOSAL" | "DROP";
  targetNode?: string;
  reason?: string;
}

export interface WIRunResult {
  runId: string;
  sourceUrl: string;
  sourceType: string;
  title: string;
  atomsExtracted: number;
  atomsNewNode: number;
  atomsHeat: number;
  atomsSkill: number;
  atomsDrop: number;
  atomsDurable: number;
  atomsCurrent: number;
  atomsEphemeral: number;
  skillsDetected: number;
  costUsd: number;
  elapsedMs: number;
  status: "done" | "failed" | "rolled_back";
  error?: string;
}

export interface SourceProfile {
  source_type: string;
  importance_bias: number;
  default_halflife_hours: number;
  default_confidence: number;
  atoms_per_1k_tokens: number;
  absolute_atom_ceiling: number;
  cost_ceiling_usd: number;
}

// ============================================================
// SOURCE REGISTRY
// ============================================================

export const SOURCE_REGISTRY: Record<string, SourceProfile> = {
  youtube:       { source_type: "youtube",       importance_bias: 0,   default_halflife_hours: 48,  default_confidence: 0.50, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 150, cost_ceiling_usd: 0.75 },
  twitter:       { source_type: "twitter",       importance_bias: -5,  default_halflife_hours: 24,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 30,  cost_ceiling_usd: 0.10 },
  github:        { source_type: "github",        importance_bias: 10,  default_halflife_hours: 72,  default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.50 },
  stackoverflow: { source_type: "stackoverflow", importance_bias: 15,  default_halflife_hours: 720, default_confidence: 0.60, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.50 },
  hn:            { source_type: "hn",            importance_bias: 10,  default_halflife_hours: 48,  default_confidence: 0.55, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 50,  cost_ceiling_usd: 0.25 },
  reddit:        { source_type: "reddit",        importance_bias: -10, default_halflife_hours: 12,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 50,  cost_ceiling_usd: 0.25 },
  substack:      { source_type: "substack",      importance_bias: 10,  default_halflife_hours: 168, default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.50 },
  podcast:       { source_type: "podcast",       importance_bias: 5,   default_halflife_hours: 168, default_confidence: 0.50, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 200, cost_ceiling_usd: 0.00 },
  arxiv:         { source_type: "arxiv",         importance_bias: 20,  default_halflife_hours: 168, default_confidence: 0.60, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 200, cost_ceiling_usd: 1.00 },
  jupyter:       { source_type: "jupyter",       importance_bias: 15,  default_halflife_hours: 720, default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.50 },
  pdf:           { source_type: "pdf",           importance_bias: 15,  default_halflife_hours: 120, default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 200, cost_ceiling_usd: 1.00 },
  doi:           { source_type: "doi",           importance_bias: 15,  default_halflife_hours: 168, default_confidence: 0.55, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 200, cost_ceiling_usd: 1.00 },
  web:           { source_type: "web",           importance_bias: -5,  default_halflife_hours: 24,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 50,  cost_ceiling_usd: 0.25 },
};

// ============================================================
// TEMPORAL BIAS — source type → default temporality
// ============================================================

export const TEMPORAL_BIAS: Record<string, string> = {
  arxiv: "DURABLE",
  stackoverflow: "DURABLE",
  jupyter: "DURABLE",
  github: "DURABLE",
  youtube: "MIXED",
  podcast: "MIXED",
  substack: "MIXED",
  web: "MIXED",
  hn: "CURRENT",
  reddit: "CURRENT",
  twitter: "EPHEMERAL",
  pdf: "DURABLE",
  doi: "DURABLE",
};

// ============================================================
// SOURCE DETECTION RULES (priority order — first match wins)
// ============================================================

export const SOURCE_DETECTION_RULES: Array<{ type: string; test: (url: string, host: string, path: string) => boolean }> = [
  { type: "youtube",       test: (_, h) => h.includes("youtube.com") || h.includes("youtu.be") },
  { type: "twitter",       test: (_, h, p) => (h.includes("twitter.com") || h.includes("x.com")) && p.includes("/status/") },
  { type: "github",        test: (_, h) => h.includes("github.com") },
  { type: "stackoverflow", test: (_, h) => h.includes("stackoverflow.com") || h.includes("stackexchange.com") },
  { type: "hn",            test: (_, h) => h === "news.ycombinator.com" },
  { type: "reddit",        test: (_, h) => h.includes("reddit.com") },
  { type: "substack",      test: (_, h) => h.includes("substack.com") || h.includes("beehiiv.com") || h.includes("buttondown.email") || h.includes("convertkit.com") },
  { type: "podcast",       test: (u, h) => /\.(mp3|m4a|wav|ogg)$/i.test(u) || h.includes("feeds.") || u.includes("/feed") || u.includes("/rss") || h.includes("podcasts.apple.com") || h.includes("open.spotify.com") || h.includes("anchor.fm") || h.includes("podbean.com") || h.includes("buzzsprout.com") || h.includes("transistor.fm") },
  // Academic sources (fallback catches — most normalize to arxiv/pdf URLs via preNormalizeUrl)
  { type: "arxiv",  test: (_, h) => h.includes("alphaxiv.org") },
  { type: "arxiv",  test: (_, h, p) => h.includes("huggingface.co") && p.startsWith("/papers/") },
  { type: "arxiv",         test: (_, h) => h.includes("arxiv.org") },
  { type: "arxiv",  test: (_, h) => h.includes("openreview.net") },
  { type: "arxiv",  test: (_, h) => h.includes("biorxiv.org") || h.includes("medrxiv.org") },
  { type: "arxiv",  test: (_, h) => h.includes("aclanthology.org") },
  { type: "pdf",    test: (_, h) => h.includes("semanticscholar.org") },
  { type: "web",    test: (_, h) => h.includes("pubmed.ncbi.nlm.nih.gov") },
  { type: "doi",    test: (_, h) => h === "doi.org" },
  { type: "pdf",           test: (u) => u.toLowerCase().endsWith(".pdf") },
  // web is the default fallback — handled in detectSourceType
];

// ============================================================
// URL NORMALIZATION — for dedup
// ============================================================

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    let normalized = `${u.protocol}//${u.hostname.replace("www.", "")}${u.pathname}`.toLowerCase();
    // Preserve ?v= for YouTube
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
      normalized += `?v=${u.searchParams.get("v")}`;
    }
    // Strip trailing slash
    normalized = normalized.replace(/\/+$/, "");
    return normalized;
  } catch {
    return url.toLowerCase().trim();
  }
}

// ============================================================
// URL PRE-NORMALIZATION — rewrite academic URLs to optimal extraction form
// ============================================================

export function preNormalizeUrl(url: string): string {
  // alphaxiv → arxiv PDF
  const alphaxiv = url.match(/alphaxiv\.org\/abs\/(\d+\.\d+)/);
  if (alphaxiv) return `https://arxiv.org/pdf/${alphaxiv[1]}`;

  // HuggingFace papers → arxiv PDF
  const hf = url.match(/huggingface\.co\/papers\/(\d+\.\d+)/);
  if (hf) return `https://arxiv.org/pdf/${hf[1]}`;

  // arxiv abs → arxiv PDF (faster — skip abstract page)
  const arxivAbs = url.match(/arxiv\.org\/abs\/(\d+\.\d+)/);
  if (arxivAbs) return `https://arxiv.org/pdf/${arxivAbs[1]}`;

  // OpenReview forum → PDF
  const openreview = url.match(/openreview\.net\/forum\?id=([A-Za-z0-9_-]+)/);
  if (openreview) return `https://openreview.net/pdf?id=${openreview[1]}`;

  // bioRxiv/medRxiv → full PDF (skip if already .full.pdf)
  if (/(?:bio|med)rxiv\.org\/.*\.full\.pdf/.test(url)) return url;
  const biorxiv = url.match(/((?:bio|med)rxiv\.org\/content\/[\d.\/v]+)/);
  if (biorxiv) return `https://${biorxiv[1]}.full.pdf`;

  // ACL Anthology → PDF
  const acl = url.match(/aclanthology\.org\/([A-Z0-9.-]+)\/?$/);
  if (acl) return `https://aclanthology.org/${acl[1]}.pdf`;

  return url;
}

// ============================================================
// TOKEN ESTIMATION
// ============================================================

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function shouldChunk(text: string): boolean {
  return estimateTokens(text) > 900_000; // Leave 100K headroom in 1M context
}

// ============================================================
// PARAMS — loaded from graph_state at startup
// ============================================================

export interface WIParams {
  model: string;
  fallbackModel: string;
  maxAtoms: number;
  maxChars: number;
  similarityThreshold: number;
  skillActionabilityThreshold: number;
  parallelLimit: number;
  maxRetries: number;
  staleDays: number;
  trackingEnabled: boolean;
  whisperModel: string;
  podcastMaxDurationMin: number;
  podcastDownloadTimeoutS: number;
  halflifeDurableHours: number;
  halflifeCurrentHours: number;
  halflifeEphemeralHours: number;
  convergenceMinOrphans: number;
  convergenceMinEnergy: number;
  convergenceAutoPromoteOrphans: number;
  convergenceAutoPromoteEnergy: number;
  convergenceAutoPromoteSources: number;
  enrichmentEnabled: boolean;
  enrichmentBatchSize: number;
  enrichmentIntervalSec: number;
  enrichmentEphemeralTtlHours: number;
  enrichmentCurrentTtlHours: number;
  enrichmentInlineThreshold: number;
  enrichmentPoolAlertDepth: number;
}

let _params: WIParams | null = null;

export async function loadParams(): Promise<WIParams> {
  if (_params) return _params;

  const rows = await sql`SELECT key, value FROM graph_state WHERE key LIKE 'wi_%'`;
  const m = new Map(rows.map(r => [r.key, r.value]));

  _params = {
    model: m.get("wi_model") || "gemini-2.5-flash-lite",
    fallbackModel: m.get("wi_fallback_model") || "gemini-2.5-flash",
    maxAtoms: parseInt(m.get("wi_max_atoms") || "10"),
    maxChars: parseInt(m.get("wi_max_chars") || "160000"),
    similarityThreshold: parseFloat(m.get("wi_similarity_threshold") || "0.85"),
    skillActionabilityThreshold: parseInt(m.get("wi_skill_actionability_threshold") || "4"),
    parallelLimit: parseInt(m.get("wi_parallel_limit") || "5"),
    maxRetries: parseInt(m.get("wi_max_retries") || "3"),
    staleDays: parseInt(m.get("wi_stale_days") || "30"),
    trackingEnabled: m.get("wi_tracking_enabled") === "true",
    whisperModel: m.get("wi_whisper_model") || "medium",
    podcastMaxDurationMin: parseInt(m.get("wi_podcast_max_duration_min") || "180"),
    podcastDownloadTimeoutS: parseInt(m.get("wi_podcast_download_timeout_s") || "600"),
    halflifeDurableHours: parseInt(m.get("wi_halflife_durable_hours") || "720"),
    halflifeCurrentHours: parseInt(m.get("wi_halflife_current_hours") || "48"),
    halflifeEphemeralHours: parseInt(m.get("wi_halflife_ephemeral_hours") || "4"),
    convergenceMinOrphans: parseInt(m.get("wi_convergence_min_orphans") || "3"),
    convergenceMinEnergy: parseFloat(m.get("wi_convergence_min_energy") || "2.0"),
    convergenceAutoPromoteOrphans: parseInt(m.get("wi_convergence_auto_promote_orphans") || "7"),
    convergenceAutoPromoteEnergy: parseFloat(m.get("wi_convergence_auto_promote_energy") || "5.0"),
    convergenceAutoPromoteSources: parseInt(m.get("wi_convergence_auto_promote_sources") || "3"),
    enrichmentEnabled: m.get("wi_enrichment_enabled") !== "false",
    enrichmentBatchSize: parseInt(m.get("wi_enrichment_batch_size") || "20"),
    enrichmentIntervalSec: parseInt(m.get("wi_enrichment_interval_sec") || "120"),
    enrichmentEphemeralTtlHours: parseInt(m.get("wi_enrichment_ephemeral_ttl_hours") || "4"),
    enrichmentCurrentTtlHours: parseInt(m.get("wi_enrichment_current_ttl_hours") || "48"),
    enrichmentInlineThreshold: parseInt(m.get("wi_enrichment_inline_threshold") || "5"),
    enrichmentPoolAlertDepth: parseInt(m.get("wi_enrichment_pool_alert_depth") || "500"),
  };

  return _params;
}

export function resetParams() {
  _params = null;
}
