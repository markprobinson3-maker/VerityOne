/**
 * Verity Ingest — Types, source registry, parameters, exit codes.
 */

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgresql://localhost:5432/verity");
export { sql };
let sqlClosed = false;

export async function closeVISql(): Promise<void> {
  if (sqlClosed) return;
  sqlClosed = true;
  await sql.end();
}

// ============================================================
// EXIT CODES
// ============================================================
export const EXIT = {
  SUCCESS: 0,
  VALIDATION: 1,
  BUDGET_EXCEEDED: 2,
  DUPLICATE_SOURCE: 3,
  ATOMIZER_FAILURE: 4,
  QUEUE_FULL: 5,
  CONCURRENT_INGESTION: 6,
} as const;

// ============================================================
// TEMPORALITY
// ============================================================
export type Temporality = "EPHEMERAL" | "CURRENT" | "DURABLE";

export const TEMPORALITY_MULTIPLIER: Record<Temporality, number> = {
  EPHEMERAL: 0.5,
  CURRENT: 1.0,
  DURABLE: 3.0,
};

// ============================================================
// ATOM TYPES
// ============================================================
export type AtomType = "CLAIM" | "FRAMEWORK" | "ACTION" | "SIGNAL";
export type Classification = "AUTO_ON" | "AUTO_IN" | "QUEUE";

// ============================================================
// SOURCE REGISTRY
// ============================================================
export interface SourceProfile {
  source_type: string;
  importance_bias: number;        // -30 to +30
  default_halflife_hours: number;
  default_confidence: number;     // Starting confidence for ON atoms
  atoms_per_1k_tokens: number;    // Token-proportional cap
  absolute_atom_ceiling: number;
  cost_ceiling_usd: number;
}

export const SOURCE_REGISTRY: Record<string, SourceProfile> = {
  arxiv:      { source_type: "arxiv",      importance_bias: 20,  default_halflife_hours: 168, default_confidence: 0.60, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 200, cost_ceiling_usd: 1.00 },
  github:     { source_type: "github",     importance_bias: 10,  default_halflife_hours: 72,  default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.50 },
  youtube:    { source_type: "youtube",    importance_bias: 0,   default_halflife_hours: 48,  default_confidence: 0.50, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 150, cost_ceiling_usd: 0.75 },
  reddit:     { source_type: "reddit",     importance_bias: -10, default_halflife_hours: 12,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 50,  cost_ceiling_usd: 0.25 },
  hn:         { source_type: "hn",         importance_bias: 5,   default_halflife_hours: 24,  default_confidence: 0.50, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 40,  cost_ceiling_usd: 0.20 },
  rss:        { source_type: "rss",        importance_bias: -8,  default_halflife_hours: 18,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 60,  cost_ceiling_usd: 0.25 },
  pdf:        { source_type: "pdf",        importance_bias: 15,  default_halflife_hours: 120, default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 200, cost_ceiling_usd: 1.00 },
  audio:      { source_type: "audio",      importance_bias: 0,   default_halflife_hours: 48,  default_confidence: 0.50, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 150, cost_ceiling_usd: 0.75 },
  web:        { source_type: "web",        importance_bias: -5,  default_halflife_hours: 24,  default_confidence: 0.45, atoms_per_1k_tokens: 3, absolute_atom_ceiling: 50,  cost_ceiling_usd: 0.25 },
  market_api: { source_type: "market_api", importance_bias: -30, default_halflife_hours: 4,   default_confidence: 0.40, atoms_per_1k_tokens: 1, absolute_atom_ceiling: 100, cost_ceiling_usd: 0.10 },
  agent_dump: { source_type: "agent_dump", importance_bias: 10,  default_halflife_hours: 72,  default_confidence: 0.55, atoms_per_1k_tokens: 2, absolute_atom_ceiling: 80,  cost_ceiling_usd: 0.50 },
};

// ============================================================
// PIPELINE TYPES — flow through stages
// ============================================================
export interface RawAtom {
  content: string;
  atom_type: AtomType;
  source_excerpt: string;
  temporality: Temporality;
}

export interface ValidatedAtom extends RawAtom {
  provenance: "verified" | "unverified";
  embedding: number[];
  chunk_index: number;
  chunk_metadata?: Record<string, any> | null;
  origin_key?: string | null;
  origin_kind?: string | null;
  origin_label?: string | null;
}

export interface NodeMatch {
  addr: string;
  label: string;
  similarity: number;
}

export interface ScoredAtom extends ValidatedAtom {
  score: number;
  score_components: {
    novelty: number;
    source_quality: number;
    specificity: number;
    graph_need: number;
    taste: number;
    taste_multiplier: number;
  };
  nearest_node_addr: string | null;
  nearest_similarity: number;
  /** All nodes above droplet_min_similarity — used for multi-node stimulus splitting */
  matching_nodes: NodeMatch[];
}

export interface ClassifiedAtom extends ScoredAtom {
  classification: Classification;
  is_contradiction: boolean;
  contradiction_verdict?: "yes" | "no" | "refines";
}

// ============================================================
// INGEST CONTEXT — mutable pipeline state
// ============================================================
export interface IngestContext {
  batch_id: string;
  target_tenant_id?: string;
  target_space_id?: string;
  source_id: string;
  source_type: string;
  source_title: string;
  source_hash: string;
  profile: SourceProfile;
  chunks: string[];
  chunk_metadata?: Array<Record<string, any> | null>;
  raw_atoms: RawAtom[];
  validated_atoms: ValidatedAtom[];
  scored_atoms: ScoredAtom[];
  classified_atoms: ClassifiedAtom[];
  flags: {
    dry_run: boolean;
    re_ingest: boolean;
    force: boolean;
  };
  stats: {
    chunks_processed: number;
    atoms_extracted: number;
    atoms_validated: number;
    atoms_embedded: number;
    atoms_deduped: number;
    auto_on: number;
    auto_in: number;
    queued: number;
    cost_usd: number;
    flash_calls: number;
    embed_calls: number;
  };
}

// ============================================================
// VI PARAMS — loaded from graph_state at startup
// ============================================================
export interface VIParams {
  auto_on_threshold: number;
  auto_in_threshold: number;
  contradiction_similarity: number;
  queue_cap: number;
  contradiction_cap: number;
  novelty_weight: number;
  source_weight: number;
  specificity_weight: number;
  graph_need_weight: number;
  learning_mode: boolean;
  classifier_version: number;
  /** Minimum similarity for a stimulus to orbit a node (droplet threshold) */
  droplet_min_similarity: number;
  /** Below this similarity = orphan (no home found) */
  orphan_similarity_threshold: number;
  /** Taste boost multiplier range: 1.0 to 1.0 + 0.5 * this value */
  taste_boost_factor: number;
  /** Minimum atom_feedback rows with query_hits > 0 before taste activates */
  taste_min_feedback: number;
  /** RSS can orbit a world/trend anchor only when similarity clears this floor */
  rss_anchor_similarity: number;
  /** RSS can orbit a function anchor only for clearly operational items above this floor */
  rss_function_anchor_similarity: number;
  /** RSS anchor must beat the next best eligible anchor by at least this margin */
  rss_anchor_margin: number;
}

let _params: VIParams | null = null;

export async function loadParams(): Promise<VIParams> {
  if (_params) return _params;

  const rows = await sql`SELECT key, value FROM graph_state WHERE key LIKE 'vi_%'`;
  const m = new Map(rows.map(r => [r.key, r.value]));

  _params = {
    auto_on_threshold: parseFloat(m.get("vi_auto_on_threshold") || "0.70"),
    auto_in_threshold: parseFloat(m.get("vi_auto_in_threshold") || "0.30"),
    contradiction_similarity: parseFloat(m.get("vi_contradiction_similarity") || "0.90"),
    queue_cap: parseInt(m.get("vi_queue_cap") || "500"),
    contradiction_cap: parseInt(m.get("vi_contradiction_cap") || "20"),
    novelty_weight: parseFloat(m.get("vi_novelty_weight") || "0.40"),
    source_weight: parseFloat(m.get("vi_source_weight") || "0.20"),
    specificity_weight: parseFloat(m.get("vi_specificity_weight") || "0.20"),
    graph_need_weight: parseFloat(m.get("vi_graph_need_weight") || "0.20"),
    learning_mode: m.get("vi_learning_mode") === "true",
    classifier_version: parseInt(m.get("vi_classifier_version") || "5"),
    droplet_min_similarity: parseFloat(m.get("vi_droplet_min_similarity") || "0.35"),
    orphan_similarity_threshold: parseFloat(m.get("vi_orphan_similarity_threshold") || "0.40"),
    taste_boost_factor: parseFloat(m.get("vi_taste_boost_factor") || "0.30"),
    taste_min_feedback: parseInt(m.get("vi_taste_min_feedback") || "20"),
    rss_anchor_similarity: parseFloat(m.get("vi_rss_anchor_similarity") || "0.72"),
    rss_function_anchor_similarity: parseFloat(m.get("vi_rss_function_anchor_similarity") || "0.88"),
    rss_anchor_margin: parseFloat(m.get("vi_rss_anchor_margin") || "0.15"),
  };

  return _params;
}

// ============================================================
// STIMULUS TYPE MAPPING
// ============================================================
export const ATOM_TO_STIMULUS_TYPE: Record<AtomType, string> = {
  CLAIM: "news_article",
  SIGNAL: "market_move",
  ACTION: "tool_release",
  FRAMEWORK: "research_paper",
};

// ============================================================
// ATOM TYPE → NODE TYPE MAPPING
// ============================================================
export const ATOM_TO_NODE_TYPE: Record<AtomType, string> = {
  CLAIM: "concept",
  SIGNAL: "concept",
  ACTION: "tool",
  FRAMEWORK: "workflow",
};

// ============================================================
// CLASSIFIER VERSION
// ============================================================
export const CLASSIFIER_VERSION = 5;
