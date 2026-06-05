import { callPro, getGoogleApiKey, getModelId } from "./lib/llm";
import { sql as rootSql } from "./vi/config";
import { deleteEdgesByIds } from "../../api/src/lib/edge-mutations";

export const DISTILLER_LOCK_ID = 44;
export const DEFAULT_NODE_SCAN_LIMIT = 40;
export const DEFAULT_EDGE_SCAN_LIMIT = 80;
export const DEFAULT_CURATOR_BUDGET = 6;
export const DEFAULT_FUSION_BUDGET = 2;
export const SEMANTIC_AUDIT_PACKET_TYPES = [
  "near_duplicate_memory_review",
  "edge_quality_provenance_review",
  "semantic_supersession_review",
  "confidence_promotion_review",
] as const;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.93;
const GRANULARITY_SIMILARITY_THRESHOLD = 0.88;
const ORPHAN_MIN_AGE_HOURS = 72;
const ORPHAN_CONFIDENCE_CEILING = 0.65;
const VAGUE_EDGE_TYPES = ["related", "related_to"] as const;
const CURATOR_DUPLICATE_MIN_ATTEMPTS = 2;
const CURATOR_GRANULARITY_MIN_ATTEMPTS = 2;
const CURATOR_ORPHAN_MIN_ATTEMPTS = 3;
const CURATOR_DUPLICATE_DEFER_MS = 2 * 60 * 60 * 1000;
const CURATOR_GRANULARITY_DEFER_MS = 4 * 60 * 60 * 1000;
const CURATOR_ORPHAN_DEFER_MS = 6 * 60 * 60 * 1000;
const CURATOR_BLOCKED_RETRY_MS = 12 * 60 * 60 * 1000;
const CURATOR_CONFIDENCE_FLOOR = 0.25;
const CURATOR_CONFIDENCE_STEP = 0.12;
const FUSION_MODEL_TIMEOUT_MS = Number(process.env.DISTILLER_FUSION_MODEL_TIMEOUT_MS || 25_000);
const FUSION_DEFAULT_DEFER_MS = 6 * 60 * 60 * 1000;
const MAX_FUSION_ATTEMPTS = 10;
const FUSION_CONFIDENCE_FLOOR = 0.72;
const FUSION_ALLOWED_FIELDS = ["label", "substance", "confidence"] as const;
const FUSION_ALLOWED_EDGE_TYPES = [
  "grounds",
  "constrains",
  "frames",
  "mirrors",
  "operationalizes",
  "supports",
  "conflicts_with",
] as const;
const FUSION_ALLOWED_ACTIONS = [
  "defer",
  "keep_separate",
  "revise_node",
  "strengthen_bridge",
  "archive_candidate",
  "preserve_tension",
] as const;
const FUSION_ALLOWED_TENSION_TYPES = [
  "tradeoff",
  "paradox",
  "constraint",
  "complement",
  "contradiction",
] as const;

type SqlClient = typeof rootSql | any;

type DistillerMode = "once" | "watch";

type SemanticAuditPacketType = (typeof SEMANTIC_AUDIT_PACKET_TYPES)[number];
type FusionAction = (typeof FUSION_ALLOWED_ACTIONS)[number];
type FusionField = (typeof FUSION_ALLOWED_FIELDS)[number];
type FusionEdgeType = (typeof FUSION_ALLOWED_EDGE_TYPES)[number];
type FusionTensionType = (typeof FUSION_ALLOWED_TENSION_TYPES)[number];

type DistillerOptions = {
  dryRun?: boolean;
  mode?: DistillerMode;
  workerInstance?: string | null;
  nodeScanLimit?: number;
  edgeScanLimit?: number;
  curatorBudget?: number;
  fusionBudget?: number;
  fusionJudge?: FusionJudgeFn;
  requireFusionJudgmentForHandoff?: boolean;
  applyDeterministicEdgeCleanup?: boolean;
  shouldContinue?: () => boolean;
  metadata?: Record<string, unknown>;
};

type EdgeScanRow = {
  id: number;
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string | null;
  is_self_loop: boolean;
  has_stronger_same_endpoint: boolean;
  stronger_edge_types: string[] | null;
};

type NodeScanRow = {
  addr: string;
  label: string;
  visibility: string;
  confidence: number;
  query_hits: number;
  created_at: string | Date | null;
  parent_addr: string | null;
  parent_label: string | null;
  parent_similarity: number | null;
  duplicate_addr: string | null;
  duplicate_label: string | null;
  duplicate_similarity: number | null;
  is_orphan: boolean;
};

type PressureRecord = {
  pressureType: string;
  score: number;
  metadata: Record<string, unknown>;
};

type WorkItemResolution = {
  count: number;
  workItemIds: number[];
};

type CuratorClusterSnapshot = {
  nodeAddrs: string[];
  edgeIds: number[];
  clusterHash: string;
  metadata: Record<string, unknown>;
  proposalKind: string;
  proposalSummary: string;
  riskLane: "low" | "medium" | "high";
  proposalPayload: Record<string, unknown>;
};

type CuratorLifecycleResult = {
  reopened: number;
  deferred: number;
  handoffsPrepared: number;
  handoffsSubmitted: number;
  handoffsBlocked: number;
  proposalsResolved: number;
  fusionJudgments: number;
  fusionDeferred: number;
  fusionBlocked: number;
};

type CuratorArtifactResult = {
  clustersBuilt: number;
  proposalsEmitted: number;
  proposalsByPacketType: Record<string, number>;
};

type FusionSuggestedUpdate = {
  addr: string;
  field: FusionField;
  new_value: unknown;
  reason: string;
};

type FusionSuggestedUpdateInput = {
  addr?: unknown;
  field?: unknown;
  new_value?: unknown;
  reason?: unknown;
};

type FusionSuggestedEdge = {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string;
  reason: string;
};

type FusionSuggestedTension = {
  from_addr: string;
  to_addr: string;
  tension_type: FusionTensionType;
  tension: number;
  synthesis: string;
  reason: string;
};

type FusionDecision = {
  action: FusionAction;
  canonical_addr: string | null;
  target_addr: string | null;
  summary: string;
  rationale: string;
  confidence: number;
  suggested_updates: FusionSuggestedUpdate[];
  suggested_edge: FusionSuggestedEdge | null;
  suggested_tension: FusionSuggestedTension | null;
  fusion_normalizer_fallback?: boolean;
  fusion_parse_error?: string;
};

type FusionClusterNode = {
  addr: string;
  label: string;
  confidence: number;
  query_hits: number;
  parent_addr: string | null;
  visibility: string;
  node_type: string | null;
  description: string;
  source_refs_count: number;
};

type FusionClusterEdge = {
  id: number;
  from_addr: string;
  to_addr: string;
  edge_type: string;
  label: string | null;
  confidence: number;
};

type FusionClusterContext = {
  proposalId: number;
  proposalKind: string;
  proposalSummary: string;
  pressureType: string;
  seedRef: string;
  nodeAddrs: string[];
  nodes: FusionClusterNode[];
  edges: FusionClusterEdge[];
};

type FusionJudgeFn = (context: FusionClusterContext) => Promise<FusionDecision>;

export type DistillerRunResult = {
  runId: number;
  status: "completed" | "failed";
  nodeScanCount: number;
  edgeScanCount: number;
  workItemsSelected: number;
  workItemsDetected: number;
  workItemsResolved: number;
  actionsApplied: number;
  vagueEdgesRemoved: number;
  selfLoopEdgesRemoved: number;
  clustersBuilt: number;
  proposalsEmitted: number;
  proposalsDeferred: number;
  proposalsReopened: number;
  handoffsPrepared: number;
  handoffsSubmitted: number;
  handoffsBlocked: number;
  proposalsResolved: number;
  proposalsByPacketType: Record<string, number>;
  fusionJudgments: number;
  fusionDeferred: number;
  fusionBlocked: number;
  dryRun: boolean;
};

function clampLimit(input: number | undefined, fallback: number, min: number, max: number, label?: string): number {
  const n = Number(input ?? fallback);
  const finite = Number.isFinite(n) ? n : fallback;
  const clamped = Math.min(Math.max(finite, min), max);
  if (label && input !== undefined && finite !== clamped) {
    console.warn(`[distiller] ${label}=${input} clamped to ${clamped} (range ${min}-${max})`);
  }
  return clamped;
}

function distillerShouldContinue(options: Pick<DistillerOptions, "shouldContinue">): boolean {
  if (!options.shouldContinue) return true;
  try {
    return options.shouldContinue() !== false;
  } catch {
    return false;
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function parseJsonArray<T = unknown>(raw: unknown): T[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clusterHash(parts: unknown): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(JSON.stringify(parts));
  return hasher.digest("hex");
}

function futureDate(ms: number): Date {
  return new Date(Date.now() + ms);
}

function clampConfidence(value: number): number {
  return Number(Math.max(CURATOR_CONFIDENCE_FLOOR, Math.min(0.99, value)).toFixed(2));
}

function clampFusionConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(2));
}

function compactText(input: unknown, limit = 320): string {
  const normalized = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeFusionAction(value: unknown): FusionAction {
  return FUSION_ALLOWED_ACTIONS.includes(value as FusionAction) ? value as FusionAction : "defer";
}

function normalizeFusionField(value: unknown): FusionField | null {
  return FUSION_ALLOWED_FIELDS.includes(value as FusionField) ? value as FusionField : null;
}

function normalizeFusionEdgeType(value: unknown): FusionEdgeType | null {
  return FUSION_ALLOWED_EDGE_TYPES.includes(value as FusionEdgeType) ? value as FusionEdgeType : null;
}

function normalizeFusionTensionType(value: unknown): FusionTensionType | null {
  return FUSION_ALLOWED_TENSION_TYPES.includes(value as FusionTensionType) ? value as FusionTensionType : null;
}

function validUpdateShape(field: FusionField, value: unknown): boolean {
  if (field === "label") {
    return typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 160;
  }
  if (field === "confidence") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0.99;
  }
  if (field === "substance") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const description = typeof (value as Record<string, unknown>).description === "string"
      ? compactText((value as Record<string, unknown>).description, 2000)
      : "";
    return description.length >= 50;
  }
  return false;
}

function fusionGuidanceForContext(context: FusionClusterContext): string[] {
  if (context.pressureType === "duplicate_pressure" || context.proposalKind === "duplicate_review") {
    return [
      "Decide whether the nodes are true near-duplicates or should remain separate.",
      "Prefer revising the weaker node or keeping them separate over flattening distinct concepts.",
      "A bridge edge is only useful if it clarifies the distinction or dependency.",
    ];
  }
  if (context.pressureType === "granularity_pressure" || context.proposalKind === "granularity_review") {
    return [
      "Judge whether the seed node is too narrow relative to its parent or whether the parent-child split is valid.",
      "Prefer label/substance clarification or a bridge edge over confidence-only downgrades when meaning is actually distinct.",
      "Do not collapse a child that adds unique operational or explanatory value.",
    ];
  }
  if (context.pressureType === "orphan_pressure" || context.proposalKind === "orphan_review") {
    return [
      "Judge whether the orphan should remain independent, gain a clarifying bridge, or stay deferred until more evidence arrives.",
      "A bridge edge should only be proposed when the relationship is strong enough to improve retrieval directly.",
      "Do not force a bridge from weak thematic resemblance alone.",
    ];
  }
  if (context.pressureType === "edge_bloat_pressure" || context.proposalKind === "edge_quality_review") {
    return [
      "Judge whether the seed edge is too generic, duplicative, or weakly grounded.",
      "Prefer a stronger typed bridge only when the cluster evidence supports a specific relationship.",
      "Do not preserve vague relationship labels or invent provenance outside the packet.",
    ];
  }
  return [
    "Prefer narrow revisions and typed bridges over broad semantic rewrites.",
    "Use defer when the cluster is still too ambiguous to improve safely.",
  ];
}

function semanticAuditPacketTypeForPressure(pressureType: string): SemanticAuditPacketType {
  if (pressureType === "duplicate_pressure") return "near_duplicate_memory_review";
  if (pressureType === "granularity_pressure") return "semantic_supersession_review";
  if (pressureType === "orphan_pressure") return "semantic_supersession_review";
  if (pressureType === "edge_bloat_pressure") return "edge_quality_provenance_review";
  if (pressureType === "confidence_promotion_pressure") return "confidence_promotion_review";
  return "semantic_supersession_review";
}

function proposalKindForPressure(pressureType: string): string {
  if (pressureType === "duplicate_pressure") return "duplicate_review";
  if (pressureType === "granularity_pressure") return "granularity_review";
  if (pressureType === "orphan_pressure") return "orphan_review";
  if (pressureType === "edge_bloat_pressure") return "edge_quality_review";
  if (pressureType === "confidence_promotion_pressure") return "confidence_promotion_review";
  return "general_review";
}

function allowedFusionActionsForContext(context: FusionClusterContext): FusionAction[] {
  if (context.pressureType === "duplicate_pressure" || context.proposalKind === "duplicate_review") {
    return ["defer", "keep_separate", "revise_node", "strengthen_bridge", "archive_candidate"];
  }
  if (context.pressureType === "granularity_pressure" || context.proposalKind === "granularity_review") {
    return ["defer", "keep_separate", "revise_node", "strengthen_bridge", "archive_candidate"];
  }
  if (context.pressureType === "orphan_pressure" || context.proposalKind === "orphan_review") {
    return ["defer", "keep_separate", "strengthen_bridge", "archive_candidate"];
  }
  if (context.pressureType === "edge_bloat_pressure" || context.proposalKind === "edge_quality_review") {
    return ["defer", "keep_separate", "strengthen_bridge", "preserve_tension"];
  }
  return ["defer", "keep_separate", "revise_node", "strengthen_bridge", "archive_candidate", "preserve_tension"];
}

function allowedFusionEdgeTypesForContext(context: FusionClusterContext, action: FusionAction): FusionEdgeType[] {
  if (action === "preserve_tension") return ["conflicts_with"];
  if (context.pressureType === "duplicate_pressure" || context.proposalKind === "duplicate_review") {
    return ["mirrors", "frames", "grounds", "constrains", "supports"];
  }
  if (context.pressureType === "granularity_pressure" || context.proposalKind === "granularity_review") {
    return ["grounds", "frames", "constrains", "supports", "operationalizes"];
  }
  if (context.pressureType === "orphan_pressure" || context.proposalKind === "orphan_review") {
    return ["grounds", "frames", "supports", "mirrors"];
  }
  if (context.pressureType === "edge_bloat_pressure" || context.proposalKind === "edge_quality_review") {
    return ["grounds", "constrains", "frames", "mirrors", "supports", "conflicts_with"];
  }
  return [...FUSION_ALLOWED_EDGE_TYPES];
}

function allowedFusionTensionTypesForContext(context: FusionClusterContext): FusionTensionType[] {
  if (context.pressureType === "duplicate_pressure" || context.proposalKind === "duplicate_review") {
    return ["contradiction", "complement", "constraint"];
  }
  if (context.pressureType === "granularity_pressure" || context.proposalKind === "granularity_review") {
    return ["constraint", "complement", "paradox"];
  }
  if (context.pressureType === "orphan_pressure" || context.proposalKind === "orphan_review") {
    return ["complement", "tradeoff", "constraint"];
  }
  return [...FUSION_ALLOWED_TENSION_TYPES];
}

function isWeakFusionEdgeLabel(label: string, fromLabel: string | null, toLabel: string | null): boolean {
  const normalized = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized || normalized.length < 18) return true;
  const genericPatterns = [
    " is related to ",
    " related to ",
    " is connected to ",
    " connected to ",
    " links to ",
    " associated with ",
  ];
  if (genericPatterns.some((pattern) => normalized.includes(pattern))) return true;
  const from = (fromLabel || "").trim().toLowerCase();
  const to = (toLabel || "").trim().toLowerCase();
  if (from && to && normalized === `${from} ${to}`) return true;
  return false;
}

function validTensionSynthesis(value: unknown): boolean {
  return typeof value === "string" && value.trim().length >= 24 && value.trim().length <= 600;
}

function normalizeFusionDecision(
  raw: unknown,
  context: FusionClusterContext,
): FusionDecision {
  const payload = parseJsonObject(raw);
  const nodeAddrSet = new Set(context.nodeAddrs);
  const allowedActions = new Set(allowedFusionActionsForContext(context));
  const labelByAddr = new Map(context.nodes.map((node) => [node.addr, node.label]));
  const suggestedUpdates = parseJsonArray<FusionSuggestedUpdateInput>(payload.suggested_updates)
    .slice(0, 2)
    .map((item) => {
      const field = normalizeFusionField(item?.field);
      const addr = typeof item?.addr === "string" ? item.addr : "";
      if (!field || !nodeAddrSet.has(addr) || !validUpdateShape(field, item?.new_value)) return null;
      return {
        addr,
        field,
        new_value: field === "label" && typeof item?.new_value === "string"
          ? item.new_value.trim()
          : item?.new_value,
        reason: compactText(item?.reason || payload.rationale || payload.summary || "Fusion suggestion", 240),
      } satisfies FusionSuggestedUpdate;
    })
    .filter((item): item is FusionSuggestedUpdate => Boolean(item));

  const rawEdge = parseJsonObject(payload.suggested_edge);
  const normalizedAction = normalizeFusionAction(payload.action);
  const actionFallback = !FUSION_ALLOWED_ACTIONS.includes(payload.action as FusionAction)
    || !allowedActions.has(normalizedAction);
  const allowedEdgeTypes = new Set(allowedFusionEdgeTypesForContext(context, normalizedAction));
  const suggestedEdge = rawEdge.from_addr && rawEdge.to_addr
    && nodeAddrSet.has(String(rawEdge.from_addr))
    && nodeAddrSet.has(String(rawEdge.to_addr))
    && normalizeFusionEdgeType(rawEdge.edge_type)
    && allowedEdgeTypes.has(normalizeFusionEdgeType(rawEdge.edge_type)!)
    && typeof rawEdge.label === "string"
    && rawEdge.label.trim().length >= 12
    && String(rawEdge.from_addr) !== String(rawEdge.to_addr)
    && !isWeakFusionEdgeLabel(
      String(rawEdge.label),
      labelByAddr.get(String(rawEdge.from_addr)) || null,
      labelByAddr.get(String(rawEdge.to_addr)) || null,
    )
    ? {
        from_addr: String(rawEdge.from_addr),
        to_addr: String(rawEdge.to_addr),
        edge_type: normalizeFusionEdgeType(rawEdge.edge_type)!,
        label: compactText(rawEdge.label, 240),
        reason: compactText(rawEdge.reason || payload.rationale || payload.summary || "Fusion bridge suggestion", 240),
      } satisfies FusionSuggestedEdge
    : null;

  const rawTension = parseJsonObject(payload.suggested_tension);
  const allowedTensionTypes = new Set(allowedFusionTensionTypesForContext(context));
  const suggestedTension = rawTension.from_addr && rawTension.to_addr
    && nodeAddrSet.has(String(rawTension.from_addr))
    && nodeAddrSet.has(String(rawTension.to_addr))
    && String(rawTension.from_addr) !== String(rawTension.to_addr)
    && normalizeFusionTensionType(rawTension.tension_type)
    && allowedTensionTypes.has(normalizeFusionTensionType(rawTension.tension_type)!)
    && Number(rawTension.tension) >= 0
    && Number(rawTension.tension) <= 1
    && validTensionSynthesis(rawTension.synthesis)
    ? {
        from_addr: String(rawTension.from_addr),
        to_addr: String(rawTension.to_addr),
        tension_type: normalizeFusionTensionType(rawTension.tension_type)!,
        tension: clampFusionConfidence(rawTension.tension),
        synthesis: compactText(rawTension.synthesis, 600),
        reason: compactText(rawTension.reason || payload.rationale || payload.summary || "Fusion tension preservation", 240),
      } satisfies FusionSuggestedTension
    : null;

  const canonicalAddr = typeof payload.canonical_addr === "string" && nodeAddrSet.has(payload.canonical_addr)
    ? payload.canonical_addr
    : null;
  const targetAddr = typeof payload.target_addr === "string" && nodeAddrSet.has(payload.target_addr)
    ? payload.target_addr
    : null;

  return {
    action: actionFallback ? "defer" : normalizedAction,
    canonical_addr: canonicalAddr,
    target_addr: targetAddr,
    summary: compactText(payload.summary || (actionFallback ? "Fusion review defaulted to defer." : "Fusion review completed."), 200),
    rationale: compactText(
      payload.rationale || (actionFallback
        ? "Fusion normalizer defaulted to defer because the model response did not contain an allowed action."
        : "No additional rationale provided."),
      600,
    ),
    confidence: clampFusionConfidence(payload.confidence),
    suggested_updates: suggestedUpdates,
    suggested_edge: suggestedEdge,
    suggested_tension: suggestedTension,
    ...(actionFallback || payload.fusion_normalizer_fallback === true
      ? { fusion_normalizer_fallback: true }
      : {}),
    ...(typeof payload.fusion_parse_error === "string"
      ? { fusion_parse_error: compactText(payload.fusion_parse_error, 240) }
      : {}),
  };
}

function buildFusionPrompt(context: FusionClusterContext): string {
  return JSON.stringify({
    task: "Review this bounded Verity One cluster and recommend the safest semantic fusion outcome.",
    rules: [
      "Use only the cluster evidence below.",
      "Do not invent addresses, nodes, facts, or sources.",
      "Prefer abstention/defer over speculative fusion.",
      "Respect addr identity: no hidden node collapse.",
      "Suggested updates must stay on existing cluster nodes and only use label, substance, or confidence fields.",
      "Suggested edge is optional and must connect existing cluster nodes.",
      "If suggesting an edge, use only these types: " + FUSION_ALLOWED_EDGE_TYPES.join(", "),
      "Suggested tension is optional and must preserve meaningful disagreement, not duplicate a bridge edge.",
      "If action is preserve_tension, prefer suggested_tension over suggested_updates.",
    ],
    decision_guidance: fusionGuidanceForContext(context),
    response_shape: {
      action: FUSION_ALLOWED_ACTIONS,
      canonical_addr: "string|null",
      target_addr: "string|null",
      summary: "short string",
      rationale: "short string",
      confidence: "0..1",
      suggested_updates: [
        {
          addr: "existing cluster addr",
          field: FUSION_ALLOWED_FIELDS,
          new_value: "field-specific value",
          reason: "short string",
        },
      ],
      suggested_edge: {
        from_addr: "existing cluster addr",
        to_addr: "existing cluster addr",
        edge_type: "typed relation",
        label: "meaningful edge label",
        reason: "short string",
      },
      suggested_tension: {
        from_addr: "existing cluster addr",
        to_addr: "existing cluster addr",
        tension_type: FUSION_ALLOWED_TENSION_TYPES,
        tension: "0..1",
        synthesis: "what the unresolved tension reveals",
        reason: "short string",
      },
    },
    cluster: {
      proposal_id: context.proposalId,
      proposal_kind: context.proposalKind,
      semantic_audit_packet_type: semanticAuditPacketTypeForPressure(context.pressureType),
      proposal_summary: context.proposalSummary,
      pressure_type: context.pressureType,
      seed_ref: context.seedRef,
      nodes: context.nodes.map((node) => ({
        addr: node.addr,
        label: node.label,
        confidence: node.confidence,
        query_hits: node.query_hits,
        parent_addr: node.parent_addr,
        visibility: node.visibility,
        node_type: node.node_type,
        source_refs_count: node.source_refs_count,
        description: node.description,
      })),
      edges: context.edges.map((edge) => ({
        id: edge.id,
        from_addr: edge.from_addr,
        to_addr: edge.to_addr,
        edge_type: edge.edge_type,
        label: edge.label,
        confidence: edge.confidence,
      })),
    },
  }, null, 2);
}

async function defaultFusionJudge(context: FusionClusterContext): Promise<FusionDecision> {
  const raw = await callPro(buildFusionPrompt(context), {
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 1600,
    timeoutMs: FUSION_MODEL_TIMEOUT_MS,
    systemPrompt: "You are Distiller Fusion for Verity One. You review bounded graph clusters and return compact JSON-only semantic curation decisions.",
  });
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const snippet = compactText(raw, 200);
    console.warn(`[distiller-fusion] JSON parse failed for cluster ${context.proposalId}: ${message}; first 200 chars: ${snippet}`);
    parsed = {
      action: "defer",
      summary: "Fusion judgment was not parseable.",
      rationale: `Unparseable fusion judgment: ${message}`,
      confidence: 0,
      suggested_updates: [],
      suggested_edge: null,
      suggested_tension: null,
      fusion_normalizer_fallback: true,
      fusion_parse_error: message,
    };
  }
  return normalizeFusionDecision(parsed, context);
}

async function ensureCursorRows(tx: SqlClient): Promise<void> {
  await tx`
    INSERT INTO distill_cursors (cursor_kind, last_node_addr, last_edge_id)
    VALUES
      ('node_scan', NULL, NULL),
      ('edge_scan', NULL, NULL)
    ON CONFLICT (cursor_kind) DO NOTHING
  `;
}

async function withTransaction<T>(client: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  if (typeof client?.begin === "function") {
    return client.begin(fn);
  }
  return fn(client);
}

async function createRun(tx: SqlClient, input: Required<Pick<DistillerOptions, "dryRun" | "mode">> & {
  workerInstance: string | null;
  nodeScanLimit: number;
  edgeScanLimit: number;
  fusionBudget: number;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const [row] = await tx`
    INSERT INTO distill_runs (
      mode,
      status,
      worker_instance,
      dry_run,
      node_scan_limit,
      edge_scan_limit,
      budget_work_items,
      metadata
    ) VALUES (
      ${input.mode},
      'running',
      ${input.workerInstance},
      ${input.dryRun},
      ${input.nodeScanLimit},
      ${input.edgeScanLimit},
      ${input.nodeScanLimit + input.edgeScanLimit},
      ${tx.json({
        phase: "distiller-a+b+c",
        version: "phase3-foundation",
        fusion_budget: input.fusionBudget,
        ...(input.metadata || {}),
      })}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function finalizeRun(tx: SqlClient, runId: number, result: DistillerRunResult, metadata?: Record<string, unknown>): Promise<void> {
  await tx`
    UPDATE distill_runs
    SET status = ${result.status},
        work_items_selected = ${result.workItemsSelected},
        work_items_detected = ${result.workItemsDetected},
        work_items_resolved = ${result.workItemsResolved},
        actions_applied = ${result.actionsApplied},
        vague_edges_removed = ${result.vagueEdgesRemoved},
        self_loop_edges_removed = ${result.selfLoopEdgesRemoved},
        metadata = metadata || ${tx.json(metadata || {})},
        finished_at = now()
    WHERE id = ${runId}
  `;
}

async function recordFailedRunAfterRollback(
  client: SqlClient,
  input: Required<Pick<DistillerOptions, "dryRun" | "mode">> & {
    workerInstance: string | null;
    nodeScanLimit: number;
    edgeScanLimit: number;
    fusionBudget: number;
    metadata?: Record<string, unknown>;
  },
  error: unknown,
): Promise<void> {
  const metadataKeys = input.metadata && typeof input.metadata === "object"
    ? Object.keys(input.metadata).slice(0, 20)
    : [];
  await client`
    INSERT INTO distill_runs (
      mode,
      status,
      worker_instance,
      dry_run,
      node_scan_limit,
      edge_scan_limit,
      budget_work_items,
      metadata,
      finished_at
    ) VALUES (
      ${input.mode},
      'failed',
      ${input.workerInstance},
      ${input.dryRun},
      ${input.nodeScanLimit},
      ${input.edgeScanLimit},
      ${input.nodeScanLimit + input.edgeScanLimit},
      ${client.json({
        phase: "distiller-a+b+c",
        version: "phase3-foundation",
        fusion_budget: input.fusionBudget,
        post_rollback_recovery: true,
        error: error instanceof Error ? error.message : String(error),
        ...(metadataKeys.length > 0 ? { caller_metadata_keys: metadataKeys } : {}),
      })},
      now()
    )
  `;
}

async function nextEdgeBatch(tx: SqlClient, limit: number): Promise<EdgeScanRow[]> {
  const [cursor] = await tx`
    SELECT cursor_kind, last_edge_id, cycle_count
    FROM distill_cursors
    WHERE cursor_kind = 'edge_scan'
    LIMIT 1
  `;

  let rows = await tx`
    SELECT
      e.id,
      e.from_addr,
      e.to_addr,
      e.edge_type,
      e.label,
      (e.from_addr = e.to_addr) AS is_self_loop,
      EXISTS (
        SELECT 1
        FROM edges stronger
        WHERE stronger.from_addr = e.from_addr
          AND stronger.to_addr = e.to_addr
          AND stronger.edge_type <> ALL(${VAGUE_EDGE_TYPES}::text[])
      ) AS has_stronger_same_endpoint,
      ARRAY(
        SELECT DISTINCT stronger.edge_type
        FROM edges stronger
        WHERE stronger.from_addr = e.from_addr
          AND stronger.to_addr = e.to_addr
          AND stronger.edge_type <> ALL(${VAGUE_EDGE_TYPES}::text[])
        ORDER BY stronger.edge_type
      ) AS stronger_edge_types
    FROM edges e
    WHERE e.id > ${cursor?.last_edge_id ?? 0}
    ORDER BY e.id ASC
    LIMIT ${limit}
  `;

  let wrapped = false;
  if (rows.length === 0) {
    rows = await tx`
      SELECT
        e.id,
        e.from_addr,
        e.to_addr,
        e.edge_type,
        e.label,
        (e.from_addr = e.to_addr) AS is_self_loop,
        EXISTS (
          SELECT 1
          FROM edges stronger
          WHERE stronger.from_addr = e.from_addr
            AND stronger.to_addr = e.to_addr
            AND stronger.edge_type <> ALL(${VAGUE_EDGE_TYPES}::text[])
        ) AS has_stronger_same_endpoint,
        ARRAY(
          SELECT DISTINCT stronger.edge_type
          FROM edges stronger
          WHERE stronger.from_addr = e.from_addr
            AND stronger.to_addr = e.to_addr
            AND stronger.edge_type <> ALL(${VAGUE_EDGE_TYPES}::text[])
          ORDER BY stronger.edge_type
        ) AS stronger_edge_types
      FROM edges e
      ORDER BY e.id ASC
      LIMIT ${limit}
    `;
    wrapped = true;
  }

  const lastEdgeId = rows.length > 0 ? Number(rows[rows.length - 1].id) : null;
  await tx`
    UPDATE distill_cursors
    SET last_edge_id = ${lastEdgeId},
        cycle_count = cycle_count + ${wrapped ? 1 : 0},
        updated_at = now()
    WHERE cursor_kind = 'edge_scan'
  `;

  return rows as EdgeScanRow[];
}

async function nextNodeBatch(tx: SqlClient, limit: number): Promise<NodeScanRow[]> {
  const [cursor] = await tx`
    SELECT cursor_kind, last_node_addr, cycle_count
    FROM distill_cursors
    WHERE cursor_kind = 'node_scan'
    LIMIT 1
  `;

  let rows = await tx`
    SELECT
      n.addr,
      n.label,
      n.visibility,
      COALESCE(n.confidence, 0) AS confidence,
      COALESCE(n.query_hits, 0) AS query_hits,
      n.created_at,
      n.parent_addr,
      p.label AS parent_label,
      CASE
        WHEN n.embedding_hv IS NOT NULL AND p.embedding_hv IS NOT NULL
          THEN 1 - (n.embedding_hv::vector <=> p.embedding_hv::vector)
        ELSE NULL
      END AS parent_similarity,
      dup.addr AS duplicate_addr,
      dup.label AS duplicate_label,
      dup.similarity AS duplicate_similarity,
      NOT EXISTS (
        SELECT 1
        FROM edges e
        WHERE e.from_addr = n.addr OR e.to_addr = n.addr
      ) AS is_orphan
    FROM nodes n
    LEFT JOIN nodes p
      ON p.addr = n.parent_addr
    LEFT JOIN LATERAL (
      SELECT
        peer.addr,
        peer.label,
        1 - (n.embedding_hv::vector <=> peer.embedding_hv::vector) AS similarity
      FROM nodes peer
      WHERE n.embedding_hv IS NOT NULL
        AND peer.embedding_hv IS NOT NULL
        AND peer.addr <> n.addr
        AND peer.visibility = n.visibility
        AND COALESCE(peer.space_id, 'global') = COALESCE(n.space_id, 'global')
        AND peer.pyramid_id = n.pyramid_id
      ORDER BY n.embedding_hv::vector <=> peer.embedding_hv::vector
      LIMIT 1
    ) dup ON true
    WHERE n.visibility IN ('public', 'private')
      AND n.addr > ${cursor?.last_node_addr ?? ""}
    ORDER BY n.addr ASC
    LIMIT ${limit}
  `;

  let wrapped = false;
  if (rows.length === 0) {
    rows = await tx`
      SELECT
        n.addr,
        n.label,
        n.visibility,
        COALESCE(n.confidence, 0) AS confidence,
        COALESCE(n.query_hits, 0) AS query_hits,
        n.created_at,
        n.parent_addr,
        p.label AS parent_label,
        CASE
          WHEN n.embedding_hv IS NOT NULL AND p.embedding_hv IS NOT NULL
            THEN 1 - (n.embedding_hv::vector <=> p.embedding_hv::vector)
          ELSE NULL
        END AS parent_similarity,
        dup.addr AS duplicate_addr,
        dup.label AS duplicate_label,
        dup.similarity AS duplicate_similarity,
        NOT EXISTS (
          SELECT 1
          FROM edges e
          WHERE e.from_addr = n.addr OR e.to_addr = n.addr
        ) AS is_orphan
      FROM nodes n
      LEFT JOIN nodes p
        ON p.addr = n.parent_addr
      LEFT JOIN LATERAL (
        SELECT
          peer.addr,
          peer.label,
          1 - (n.embedding_hv::vector <=> peer.embedding_hv::vector) AS similarity
        FROM nodes peer
        WHERE n.embedding_hv IS NOT NULL
          AND peer.embedding_hv IS NOT NULL
          AND peer.addr <> n.addr
          AND peer.visibility = n.visibility
          AND COALESCE(peer.space_id, 'global') = COALESCE(n.space_id, 'global')
          AND peer.pyramid_id = n.pyramid_id
        ORDER BY n.embedding_hv::vector <=> peer.embedding_hv::vector
        LIMIT 1
      ) dup ON true
      WHERE n.visibility IN ('public', 'private')
      ORDER BY n.addr ASC
      LIMIT ${limit}
    `;
    wrapped = true;
  }

  const lastNodeAddr = rows.length > 0 ? String(rows[rows.length - 1].addr) : null;
  await tx`
    UPDATE distill_cursors
    SET last_node_addr = ${lastNodeAddr},
        cycle_count = cycle_count + ${wrapped ? 1 : 0},
        updated_at = now()
    WHERE cursor_kind = 'node_scan'
  `;

  return rows as NodeScanRow[];
}

async function upsertWorkItem(
  tx: SqlClient,
  runId: number,
  scopeKind: "node" | "edge",
  seedRef: string,
  pressure: PressureRecord,
): Promise<void> {
  await tx`
    INSERT INTO distill_work_items (
      scope_kind,
      seed_ref,
      pressure_type,
      pressure_score,
      status,
      metadata,
      last_distilled_at,
      attempt_count
    ) VALUES (
      ${scopeKind},
      ${seedRef},
      ${pressure.pressureType},
      ${pressure.score},
      'open',
      ${tx.json({
        ...pressure.metadata,
        last_run_id: runId,
      })},
      now(),
      1
    )
    ON CONFLICT (scope_kind, seed_ref, pressure_type) DO UPDATE SET
      pressure_score = EXCLUDED.pressure_score,
      status = CASE
        WHEN distill_work_items.status = 'invalid' THEN distill_work_items.status
        ELSE 'open'
      END,
      metadata = CASE
        WHEN distill_work_items.status = 'invalid' THEN distill_work_items.metadata
        ELSE distill_work_items.metadata || EXCLUDED.metadata
      END,
      last_seen_at = now(),
      last_distilled_at = CASE
        WHEN distill_work_items.status = 'invalid' THEN distill_work_items.last_distilled_at
        ELSE now()
      END,
      attempt_count = CASE
        WHEN distill_work_items.status = 'invalid' THEN distill_work_items.attempt_count
        ELSE distill_work_items.attempt_count + 1
      END,
      resolved_at = CASE
        WHEN distill_work_items.status = 'invalid' THEN distill_work_items.resolved_at
        ELSE NULL
      END
  `;
}

async function resolveInactiveWorkItems(
  tx: SqlClient,
  scopeKind: "node" | "edge",
  seedRef: string,
  activeTypes: string[],
): Promise<WorkItemResolution> {
  const resolved = await tx`
    UPDATE distill_work_items
    SET status = 'resolved',
        resolved_at = now(),
        last_distilled_at = now()
    WHERE scope_kind = ${scopeKind}
      AND seed_ref = ${seedRef}
      AND status = 'open'
      AND pressure_type <> ALL(${activeTypes}::text[])
    RETURNING id
  `;
  const workItemIds = resolved.map((row: any) => Number(row.id));
  return {
    count: workItemIds.length,
    workItemIds,
  };
}

async function resolveAppliedWorkItem(
  tx: SqlClient,
  scopeKind: "node" | "edge",
  seedRef: string,
  pressureType: string,
  resolutionMetadata: Record<string, unknown>,
): Promise<number[]> {
  const resolved = await tx`
    UPDATE distill_work_items
    SET status = 'resolved',
        resolved_at = now(),
        last_distilled_at = now(),
        metadata = metadata || ${tx.json(resolutionMetadata)}
    WHERE scope_kind = ${scopeKind}
      AND seed_ref = ${seedRef}
      AND pressure_type = ${pressureType}
    RETURNING id
  `;
  return resolved.map((row: any) => Number(row.id));
}

async function resolveCuratorArtifacts(tx: SqlClient, workItemIds: number[]): Promise<void> {
  if (!workItemIds.length) return;
  await tx`
    UPDATE distill_clusters
    SET status = 'resolved',
        updated_at = now()
    WHERE work_item_id = ANY(${workItemIds}::bigint[])
      AND status = 'open'
  `;
  await tx`
    UPDATE distill_proposals
    SET status = 'resolved',
        resolved_at = now(),
        updated_at = now()
    WHERE work_item_id = ANY(${workItemIds}::bigint[])
      AND status = 'open'
  `;
}

function buildEdgePressures(row: EdgeScanRow): PressureRecord[] {
  const pressures: PressureRecord[] = [];
  if (row.is_self_loop) {
    pressures.push({
      pressureType: "edge_bloat_pressure",
      score: 1,
      metadata: {
        subtype: "self_loop",
        edge_id: row.id,
        edge_type: row.edge_type,
      },
    });
    return pressures;
  }

  if (VAGUE_EDGE_TYPES.includes(row.edge_type as typeof VAGUE_EDGE_TYPES[number]) && row.has_stronger_same_endpoint) {
    pressures.push({
      pressureType: "edge_bloat_pressure",
      score: 0.9,
      metadata: {
        subtype: "vague_duplicate",
        edge_id: row.id,
        edge_type: row.edge_type,
        stronger_edge_types: row.stronger_edge_types || [],
      },
    });
  }
  return pressures;
}

function ageHours(value: string | Date | null): number {
  if (!value) return 0;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 3_600_000);
}

function buildNodePressures(row: NodeScanRow): PressureRecord[] {
  const pressures: PressureRecord[] = [];

  if ((row.duplicate_similarity || 0) >= DUPLICATE_SIMILARITY_THRESHOLD && row.duplicate_addr) {
    pressures.push({
      pressureType: "duplicate_pressure",
      score: Number(row.duplicate_similarity || 0),
      metadata: {
        duplicate_addr: row.duplicate_addr,
        duplicate_label: row.duplicate_label,
        similarity: Number(row.duplicate_similarity || 0),
      },
    });
  }

  if ((row.parent_similarity || 0) >= GRANULARITY_SIMILARITY_THRESHOLD && row.parent_addr && row.query_hits === 0) {
    pressures.push({
      pressureType: "granularity_pressure",
      score: Number(row.parent_similarity || 0),
      metadata: {
        parent_addr: row.parent_addr,
        parent_label: row.parent_label,
        similarity: Number(row.parent_similarity || 0),
      },
    });
  }

  if (
    row.is_orphan
    && row.query_hits === 0
    && Number(row.confidence || 0) <= ORPHAN_CONFIDENCE_CEILING
    && ageHours(row.created_at) >= ORPHAN_MIN_AGE_HOURS
  ) {
    pressures.push({
      pressureType: "orphan_pressure",
      score: 0.6,
      metadata: {
        age_hours: Math.round(ageHours(row.created_at)),
        confidence: Number(row.confidence || 0),
      },
    });
  }

  return pressures;
}

async function buildCuratorSnapshot(tx: SqlClient, workItem: any): Promise<CuratorClusterSnapshot | null> {
  const metadata = parseJsonObject(workItem.metadata);
  const pressureScore = Number(workItem.pressure_score);
  const safePressureScore = Number.isFinite(pressureScore) ? pressureScore : 0;

  if (workItem.scope_kind === "edge" && workItem.pressure_type === "edge_bloat_pressure") {
    const edgeId = Number(workItem.seed_ref);
    if (!Number.isFinite(edgeId) || edgeId <= 0) return null;

    const [seedEdge] = await tx`
      SELECT id, from_addr, to_addr, edge_type, label
      FROM edges
      WHERE id = ${edgeId}
      LIMIT 1
    `;
    if (!seedEdge) return null;

    const nodeRows = await tx`
      SELECT addr, label, pyramid_id, parent_addr, visibility, space_id
      FROM nodes
      WHERE addr = ANY(${[String(seedEdge.from_addr), String(seedEdge.to_addr)]}::text[])
        AND visibility NOT IN ('dormant', 'merged', 'deleted')
      ORDER BY addr ASC
      LIMIT 20
    `;
    const nodeAddrs = nodeRows.map((row: any) => String(row.addr));
    if (nodeAddrs.length < 2) return null;

    const edgeRows = await tx`
      SELECT id, from_addr, to_addr, edge_type, label
      FROM edges
      WHERE from_addr = ANY(${nodeAddrs}::text[])
        AND to_addr = ANY(${nodeAddrs}::text[])
      ORDER BY id ASC
      LIMIT 40
    `;
    const edgeIds = edgeRows.map((row: any) => Number(row.id));
    const labelByAddr = new Map(nodeRows.map((row: any) => [String(row.addr), String(row.label)]));
    const edgeLabel = seedEdge.label ? String(seedEdge.label) : "";
    const proposalSummary = `Edge quality pressure on ${labelByAddr.get(String(seedEdge.from_addr)) || seedEdge.from_addr} -> ${labelByAddr.get(String(seedEdge.to_addr)) || seedEdge.to_addr}.`;

    return {
      nodeAddrs,
      edgeIds,
      clusterHash: clusterHash({
        pressure_type: String(workItem.pressure_type),
        node_addrs: nodeAddrs,
        edge_ids: edgeIds,
      }),
      metadata: {
        pressure_type: workItem.pressure_type,
        pressure_score: safePressureScore,
        semantic_audit_packet_type: semanticAuditPacketTypeForPressure(String(workItem.pressure_type)),
        seed_edge_id: edgeId,
        seed_edge_type: String(seedEdge.edge_type),
        seed_edge_label: edgeLabel,
        edge_subtype: metadata.subtype || null,
        stronger_edge_types: parseJsonArray<string>(metadata.stronger_edge_types),
        edge_preview: edgeRows.map((row: any) => ({
          id: Number(row.id),
          from_addr: String(row.from_addr),
          to_addr: String(row.to_addr),
          edge_type: String(row.edge_type),
          label: row.label || "",
        })),
      },
      proposalKind: proposalKindForPressure(String(workItem.pressure_type)),
      proposalSummary,
      riskLane: "medium",
      proposalPayload: {
        pressure_type: workItem.pressure_type,
        semantic_audit_packet_type: semanticAuditPacketTypeForPressure(String(workItem.pressure_type)),
        semantic_audit_packet_types: SEMANTIC_AUDIT_PACKET_TYPES,
        seed_edge_id: edgeId,
        from_addr: String(seedEdge.from_addr),
        to_addr: String(seedEdge.to_addr),
        edge_type: String(seedEdge.edge_type),
        edge_label: edgeLabel,
        edge_subtype: metadata.subtype || null,
        stronger_edge_types: parseJsonArray<string>(metadata.stronger_edge_types),
        node_count: nodeAddrs.length,
        edge_count: edgeIds.length,
        suggested_review: "Check whether the edge is too generic, weakly provenanced, or should be replaced by a stronger typed relationship.",
      },
    };
  }

  if (workItem.scope_kind !== "node") return null;

  const seedAddr = String(workItem.seed_ref);
  const candidateAddrs = new Set<string>([seedAddr]);
  const duplicateAddr = typeof metadata.duplicate_addr === "string" ? metadata.duplicate_addr : null;
  const parentAddr = typeof metadata.parent_addr === "string" ? metadata.parent_addr : null;
  if (duplicateAddr) candidateAddrs.add(duplicateAddr);
  if (parentAddr) candidateAddrs.add(parentAddr);

  const baseNodes = await tx`
    SELECT addr, label, parent_addr, pyramid_id, visibility, space_id
    FROM nodes
    WHERE addr = ANY(${[...candidateAddrs]}::text[])
  `;
  if (!baseNodes.length) return null;

  for (const row of baseNodes) {
    if (row.parent_addr) candidateAddrs.add(String(row.parent_addr));
  }

  const neighborRows = await tx`
    SELECT DISTINCT
      CASE
        WHEN e.from_addr = ${seedAddr} THEN e.to_addr
        ELSE e.from_addr
      END AS neighbor_addr
    FROM edges e
    WHERE e.from_addr = ${seedAddr}
       OR e.to_addr = ${seedAddr}
    ORDER BY neighbor_addr ASC
    LIMIT 10
  `;
  for (const row of neighborRows) {
    if (row.neighbor_addr) candidateAddrs.add(String(row.neighbor_addr));
  }

  const nodeRows = await tx`
    SELECT addr, label, pyramid_id, parent_addr, visibility, space_id
    FROM nodes
    WHERE addr = ANY(${[...candidateAddrs]}::text[])
    ORDER BY addr ASC
    LIMIT 20
  `;
  const nodeAddrs = nodeRows.map((row: any) => String(row.addr));
  if (!nodeAddrs.length) return null;

  const edgeRows = await tx`
    SELECT id, from_addr, to_addr, edge_type, label
    FROM edges
    WHERE from_addr = ANY(${nodeAddrs}::text[])
      AND to_addr = ANY(${nodeAddrs}::text[])
    ORDER BY id ASC
    LIMIT 40
  `;
  const edgeIds = edgeRows.map((row: any) => Number(row.id));
  const seedNode = nodeRows.find((row: any) => String(row.addr) === seedAddr) || nodeRows[0];
  const duplicateNode = duplicateAddr ? nodeRows.find((row: any) => String(row.addr) === duplicateAddr) : null;
  const parentNode = parentAddr ? nodeRows.find((row: any) => String(row.addr) === parentAddr) : null;
  const strongerTypes = parseJsonArray<string>(metadata.stronger_edge_types);

  let proposalKind = proposalKindForPressure(String(workItem.pressure_type));
  let proposalSummary = `Review ${seedNode.label} for graph curation pressure.`;
  const payload: Record<string, unknown> = {
    pressure_type: workItem.pressure_type,
    semantic_audit_packet_type: semanticAuditPacketTypeForPressure(String(workItem.pressure_type)),
    semantic_audit_packet_types: SEMANTIC_AUDIT_PACKET_TYPES,
    seed_addr: seedAddr,
    seed_label: seedNode.label,
    duplicate_addr: duplicateAddr,
    parent_addr: parentAddr,
    stronger_edge_types: strongerTypes,
    node_count: nodeAddrs.length,
    edge_count: edgeIds.length,
  };

  if (workItem.pressure_type === "duplicate_pressure" && duplicateNode) {
    proposalSummary = `Duplicate pressure between ${seedNode.label} and ${duplicateNode.label}.`;
    payload.candidate_addr = duplicateAddr;
    payload.candidate_label = duplicateNode.label;
    payload.suggested_review = "Decide whether one node should supersede the other or whether stronger typed bridges are enough.";
  } else if (workItem.pressure_type === "granularity_pressure" && parentNode) {
    proposalSummary = `Granularity pressure between ${seedNode.label} and parent ${parentNode.label}.`;
    payload.parent_label = parentNode.label;
    payload.suggested_review = "Check whether the child is overly narrow and should be absorbed, revised, or left distinct.";
  } else if (workItem.pressure_type === "orphan_pressure") {
    proposalSummary = `Orphan pressure on ${seedNode.label}.`;
    payload.suggested_review = "Check whether the node needs stronger bridges, archival, or more time to ripen.";
  }

  const snapshotMetadata = {
    pressure_type: workItem.pressure_type,
    pressure_score: safePressureScore,
    seed_label: seedNode.label,
    seed_pyramid_id: seedNode.pyramid_id,
    duplicate_label: duplicateNode?.label || null,
    parent_label: parentNode?.label || null,
    neighbor_labels: nodeRows
      .filter((row: any) => String(row.addr) !== seedAddr && String(row.addr) !== duplicateAddr && String(row.addr) !== parentAddr)
      .slice(0, 6)
      .map((row: any) => row.label),
    edge_preview: edgeRows.slice(0, 8).map((row: any) => ({
      id: Number(row.id),
      from_addr: String(row.from_addr),
      to_addr: String(row.to_addr),
      edge_type: String(row.edge_type),
      label: row.label || "",
    })),
  };

  return {
    nodeAddrs,
    edgeIds,
    clusterHash: clusterHash({
      work_item_id: Number(workItem.id),
      pressure_type: String(workItem.pressure_type),
      node_addrs: nodeAddrs,
      edge_ids: edgeIds,
    }),
    metadata: snapshotMetadata,
    proposalKind,
    proposalSummary,
    riskLane: "medium",
    proposalPayload: payload,
  };
}

async function upsertCuratorArtifacts(
  tx: SqlClient,
  runId: number,
  workItem: any,
  snapshot: CuratorClusterSnapshot,
): Promise<{ clusterBuilt: boolean; proposalEmitted: boolean }> {
  const [cluster] = await tx`
    INSERT INTO distill_clusters (
      work_item_id,
      scope_kind,
      seed_ref,
      cluster_hash,
      status,
      node_addrs,
      edge_ids,
      pressure_types,
      metadata,
      last_built_at,
      updated_at
    ) VALUES (
      ${Number(workItem.id)},
      ${String(workItem.scope_kind)},
      ${String(workItem.seed_ref)},
      ${snapshot.clusterHash},
      'open',
      ${tx.json(snapshot.nodeAddrs)},
      ${tx.json(snapshot.edgeIds)},
      ${tx.json([String(workItem.pressure_type)])},
      ${tx.json({
        ...snapshot.metadata,
        last_run_id: runId,
      })},
      now(),
      now()
    )
    ON CONFLICT (work_item_id) DO UPDATE SET
      cluster_hash = EXCLUDED.cluster_hash,
      status = 'open',
      defer_reason = NULL,
      next_review_at = NULL,
      node_addrs = EXCLUDED.node_addrs,
      edge_ids = EXCLUDED.edge_ids,
      pressure_types = EXCLUDED.pressure_types,
      metadata = distill_clusters.metadata || EXCLUDED.metadata,
      last_built_at = now(),
      updated_at = now()
    RETURNING id, xmax = 0 AS inserted
  `;

  const [proposal] = await tx`
    INSERT INTO distill_proposals (
      work_item_id,
      cluster_id,
      proposal_kind,
      status,
      risk_lane,
      summary,
      payload,
      updated_at
    ) VALUES (
      ${Number(workItem.id)},
      ${Number(cluster.id)},
      ${snapshot.proposalKind},
      'open',
      ${snapshot.riskLane},
      ${snapshot.proposalSummary},
      ${tx.json({
        ...snapshot.proposalPayload,
        cluster_hash: snapshot.clusterHash,
        last_run_id: runId,
      })},
      now()
    )
    ON CONFLICT (work_item_id, proposal_kind) DO UPDATE SET
      cluster_id = EXCLUDED.cluster_id,
      status = 'open',
      defer_reason = NULL,
      next_review_at = NULL,
      risk_lane = EXCLUDED.risk_lane,
      summary = EXCLUDED.summary,
      payload = EXCLUDED.payload,
      updated_at = now(),
      resolved_at = NULL
    RETURNING id, xmax = 0 AS inserted
  `;

  return {
    clusterBuilt: Boolean(cluster?.inserted),
    proposalEmitted: Boolean(proposal?.inserted),
  };
}

async function reopenDueCuratorArtifacts(tx: SqlClient): Promise<number> {
  const reopenedClusters = await tx`
    UPDATE distill_clusters
    SET status = 'open',
        defer_reason = NULL,
        next_review_at = NULL,
        revisit_count = revisit_count + 1,
        updated_at = now()
    WHERE status = 'deferred'
      AND next_review_at IS NOT NULL
      AND next_review_at <= now()
    RETURNING id
  `;
  const reopenedProposals = await tx`
    UPDATE distill_proposals
    SET status = 'open',
        defer_reason = NULL,
        next_review_at = NULL,
        updated_at = now()
    WHERE status = 'deferred'
      AND next_review_at IS NOT NULL
      AND next_review_at <= now()
    RETURNING id
  `;
  return reopenedClusters.length + reopenedProposals.length;
}

function proposalDeferWindow(pressureType: string): number {
  if (pressureType === "duplicate_pressure") return CURATOR_DUPLICATE_DEFER_MS;
  if (pressureType === "granularity_pressure") return CURATOR_GRANULARITY_DEFER_MS;
  return CURATOR_ORPHAN_DEFER_MS;
}

function minAttemptsForPressure(pressureType: string): number {
  if (pressureType === "duplicate_pressure") return CURATOR_DUPLICATE_MIN_ATTEMPTS;
  if (pressureType === "granularity_pressure") return CURATOR_GRANULARITY_MIN_ATTEMPTS;
  return CURATOR_ORPHAN_MIN_ATTEMPTS;
}

async function deferCuratorProposal(
  tx: SqlClient,
  workItemId: number,
  reason: string,
  deferMs: number,
): Promise<void> {
  const nextReviewAt = futureDate(deferMs);
  await tx`
    UPDATE distill_clusters
    SET status = 'deferred',
        defer_reason = ${reason},
        next_review_at = ${nextReviewAt},
        updated_at = now()
    WHERE work_item_id = ${workItemId}
      AND status = 'open'
  `;
  await tx`
    UPDATE distill_proposals
    SET status = 'deferred',
        defer_reason = ${reason},
        next_review_at = ${nextReviewAt},
        handoff_status = CASE
          WHEN handoff_status = 'submitted' THEN handoff_status
          ELSE 'none'
        END,
        updated_at = now()
    WHERE work_item_id = ${workItemId}
      AND status = 'open'
  `;
}

type CuratorHandoffCandidate =
  | {
      kind: "update";
      addr: string;
      label: string;
      field: FusionField;
      oldValue: unknown;
      newValue: unknown;
      rationale: string;
      source: "fusion" | "curator";
    }
  | {
      kind: "edge";
      fromAddr: string;
      toAddr: string;
      edgeType: FusionEdgeType;
      label: string;
      rationale: string;
      confidence: number;
      source: "fusion";
    }
  | {
      kind: "tension";
      fromAddr: string;
      toAddr: string;
      tensionType: FusionTensionType;
      tension: number;
      synthesis: string;
      rationale: string;
      source: "fusion";
    };

function buildHandoffPreview(candidate: CuratorHandoffCandidate): Record<string, unknown> {
  if (candidate.kind === "update") {
    return {
      kind: "update",
      addr: candidate.addr,
      label: candidate.label,
      field: candidate.field,
      source: candidate.source,
      old_value: candidate.oldValue,
      new_value: candidate.newValue,
    };
  }
  if (candidate.kind === "edge") {
    return {
      kind: "edge",
      from_addr: candidate.fromAddr,
      to_addr: candidate.toAddr,
      edge_type: candidate.edgeType,
      label: candidate.label,
      source: candidate.source,
      confidence: candidate.confidence,
    };
  }
  return {
    kind: "tension",
    from_addr: candidate.fromAddr,
    to_addr: candidate.toAddr,
    tension_type: candidate.tensionType,
    tension: candidate.tension,
    synthesis: candidate.synthesis,
    source: candidate.source,
  };
}

async function buildFusionClusterContext(tx: SqlClient, proposal: any): Promise<FusionClusterContext | null> {
  const nodeAddrs = uniqueNodeAddrs(parseJsonArray<string>(proposal.node_addrs));
  if (!nodeAddrs.length) return null;

  const edgeIds = parseJsonArray<number>(proposal.edge_ids)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  const nodeRows = await tx`
    SELECT
      addr,
      label,
      COALESCE(confidence, 0) AS confidence,
      COALESCE(query_hits, 0) AS query_hits,
      parent_addr,
      visibility,
      node_type,
      left(COALESCE(substance->>'description', ''), 600) AS description,
      COALESCE(jsonb_array_length(COALESCE(source_refs, '[]'::jsonb)), 0) AS source_refs_count
    FROM nodes
    WHERE addr = ANY(${nodeAddrs}::text[])
    ORDER BY addr ASC
  `;
  if (!nodeRows.length) return null;

  const edgeRows = edgeIds.length > 0
    ? await tx`
        SELECT id, from_addr, to_addr, edge_type, label, COALESCE(confidence, 0) AS confidence
        FROM edges
        WHERE id = ANY(${edgeIds}::bigint[])
        ORDER BY id ASC
      `
    : [];

  return {
    proposalId: Number(proposal.id),
    proposalKind: String(proposal.proposal_kind),
    proposalSummary: String(proposal.summary),
    pressureType: String(proposal.pressure_type),
    seedRef: String(proposal.seed_ref),
    nodeAddrs,
    nodes: nodeRows.map((row: any) => ({
      addr: String(row.addr),
      label: String(row.label),
      confidence: Number(row.confidence || 0),
      query_hits: Number(row.query_hits || 0),
      parent_addr: row.parent_addr ? String(row.parent_addr) : null,
      visibility: String(row.visibility || "public"),
      node_type: row.node_type ? String(row.node_type) : null,
      description: compactText(row.description, 600),
      source_refs_count: Number(row.source_refs_count || 0),
    })),
    edges: edgeRows.map((row: any) => ({
      id: Number(row.id),
      from_addr: String(row.from_addr),
      to_addr: String(row.to_addr),
      edge_type: String(row.edge_type),
      label: row.label ? String(row.label) : null,
      confidence: Number(row.confidence || 0),
    })),
  };
}

async function evaluateFusionProposal(
  tx: SqlClient,
  proposal: any,
  fusionJudge: FusionJudgeFn,
): Promise<"judged" | "deferred" | "blocked" | "skipped"> {
  const nextAttempt = Number(proposal.fusion_attempt_count || 0) + 1;
  if (nextAttempt > MAX_FUSION_ATTEMPTS) {
    await tx`
      UPDATE distill_proposals
      SET fusion_status = 'abandoned',
          fusion_error = ${`Exceeded ${MAX_FUSION_ATTEMPTS} fusion judgment attempts.`},
          fusion_attempt_count = ${nextAttempt},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;
    return "blocked";
  }

  if (!getGoogleApiKey()) {
    const nextReviewAt = futureDate(FUSION_DEFAULT_DEFER_MS);
    await tx`
      UPDATE distill_proposals
      SET fusion_status = 'deferred',
          fusion_next_review_at = ${nextReviewAt},
          fusion_error = 'No Google API key configured for Distiller fusion judgments.',
          fusion_attempt_count = ${nextAttempt},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;
    return "deferred";
  }

  const context = await buildFusionClusterContext(tx, proposal);
  if (!context) {
    await tx`
      UPDATE distill_proposals
      SET fusion_status = 'blocked',
          fusion_error = 'Unable to assemble a bounded fusion cluster for this proposal.',
          fusion_attempt_count = ${nextAttempt},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;
    return "blocked";
  }

  await tx`
    UPDATE distill_proposals
    SET fusion_status = 'pending',
        fusion_error = NULL,
        updated_at = now()
    WHERE id = ${proposal.id}
  `;

  try {
    const decision = await fusionJudge(context);
    if (decision.action === "defer") {
      const nextReviewAt = futureDate(FUSION_DEFAULT_DEFER_MS);
      await tx`
        UPDATE distill_proposals
        SET fusion_status = 'deferred',
            fusion_model = ${getModelId("pro")},
            fusion_action = ${decision.action},
            fusion_summary = ${decision.summary},
            fusion_confidence = ${decision.confidence},
            fusion_payload = ${tx.json(decision)},
            fusion_judged_at = now(),
            fusion_next_review_at = ${nextReviewAt},
            fusion_error = ${decision.rationale},
            fusion_attempt_count = ${nextAttempt},
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      return "deferred";
    }
    await tx`
      UPDATE distill_proposals
      SET fusion_status = 'judged',
          fusion_model = ${getModelId("pro")},
          fusion_action = ${decision.action},
          fusion_summary = ${decision.summary},
          fusion_confidence = ${decision.confidence},
          fusion_payload = ${tx.json(decision)},
          fusion_judged_at = now(),
          fusion_next_review_at = NULL,
          fusion_error = NULL,
          fusion_attempt_count = ${nextAttempt},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;
    return "judged";
  } catch (error: any) {
    const retryAfterMs = Number(error?.retryAfterMs || 0) > 0
      ? Number(error.retryAfterMs)
      : FUSION_DEFAULT_DEFER_MS;
    const nextReviewAt = futureDate(retryAfterMs);
    const message = compactText(error?.message || "Fusion judgment failed.", 240);
    await tx`
      UPDATE distill_proposals
      SET fusion_status = ${error?.name === "ModelCooldownError" ? "deferred" : "blocked"},
          fusion_next_review_at = ${nextReviewAt},
          fusion_error = ${message},
          fusion_attempt_count = ${nextAttempt},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;
    return error?.name === "ModelCooldownError" ? "deferred" : "blocked";
  }
}

async function hydrateProposalState(tx: SqlClient, proposalId: number): Promise<any | null> {
  const [proposal] = await tx`
    SELECT p.id, p.work_item_id, p.cluster_id, p.proposal_kind, p.status, p.risk_lane, p.summary, p.payload,
      p.handoff_status, p.staging_ref, p.fusion_status, p.fusion_action, p.fusion_summary,
      p.fusion_confidence, p.fusion_payload, p.fusion_attempt_count, p.fusion_error,
      w.scope_kind, w.seed_ref, w.pressure_type, w.attempt_count, w.metadata,
      cl.cluster_hash, cl.node_addrs, cl.edge_ids
    FROM distill_proposals p
    JOIN distill_work_items w ON w.id = p.work_item_id
    JOIN distill_clusters cl ON cl.id = p.cluster_id
    WHERE p.id = ${proposalId}
    LIMIT 1
  `;
  return proposal || null;
}

async function selectFusionHandoffCandidate(
  tx: SqlClient,
  proposal: any,
): Promise<CuratorHandoffCandidate | null> {
  if (String(proposal.fusion_status || "none") !== "judged") return null;
  if (Number(proposal.fusion_confidence || 0) < FUSION_CONFIDENCE_FLOOR) return null;

  const payload = parseJsonObject(proposal.fusion_payload);
  const updates = parseJsonArray<FusionSuggestedUpdate>(payload.suggested_updates);

  const clusterNodeAddrs = new Set(uniqueNodeAddrs(parseJsonArray<string>(proposal.node_addrs)));
  for (const item of updates) {
    const field = normalizeFusionField(item?.field);
    const addr = typeof item?.addr === "string" ? item.addr : "";
    if (!field || !clusterNodeAddrs.has(addr) || !validUpdateShape(field, item?.new_value)) continue;

    const [node] = await tx`
      SELECT addr, label, confidence, substance
      FROM nodes
      WHERE addr = ${addr}
      LIMIT 1
    `;
    if (!node) continue;

    let oldValue: unknown;
    let newValue: unknown = item.new_value;
    if (field === "label") {
      const normalized = String(item.new_value || "").trim();
      if (!normalized || normalized === String(node.label || "").trim()) continue;
      oldValue = String(node.label || "");
      newValue = normalized;
    } else if (field === "confidence") {
      const normalized = clampConfidence(Number(item.new_value));
      if (!Number.isFinite(normalized) || normalized === Number(node.confidence || 0)) continue;
      oldValue = Number(node.confidence || 0);
      newValue = normalized;
    } else {
      oldValue = parseJsonObject(node.substance);
      if (JSON.stringify(oldValue ?? null) === JSON.stringify(item.new_value ?? null)) continue;
    }

    return {
      kind: "update",
      addr: String(node.addr),
      label: String(node.label),
      field,
      oldValue,
      newValue,
      rationale: compactText(item?.reason || proposal.fusion_summary || proposal.summary, 240),
      source: "fusion",
    };
  }

  const suggestedEdge = parseJsonObject(payload.suggested_edge);
  const edgeType = normalizeFusionEdgeType(suggestedEdge.edge_type);
  const fromAddr = typeof suggestedEdge.from_addr === "string" ? suggestedEdge.from_addr : "";
  const toAddr = typeof suggestedEdge.to_addr === "string" ? suggestedEdge.to_addr : "";
  const label = typeof suggestedEdge.label === "string" ? suggestedEdge.label.trim() : "";
  if (
    edgeType
    && clusterNodeAddrs.has(fromAddr)
    && clusterNodeAddrs.has(toAddr)
    && fromAddr !== toAddr
    && label.length >= 12
  ) {
    const labelRows = await tx`
      SELECT addr, label
      FROM nodes
      WHERE addr = ANY(${[fromAddr, toAddr]}::text[])
    `;
    const labelByAddr = new Map(labelRows.map((row: any) => [String(row.addr), String(row.label)]));
    if (!isWeakFusionEdgeLabel(label, labelByAddr.get(fromAddr) || null, labelByAddr.get(toAddr) || null)) {
      const [existing] = await tx`
        SELECT id
        FROM edges
        WHERE from_addr = ${fromAddr}
          AND to_addr = ${toAddr}
          AND edge_type = ${edgeType}
        LIMIT 1
      `;
      if (!existing) {
        const [stagingExisting] = await tx`
          SELECT id
          FROM staging_edges
          WHERE run_id = ${`distill-proposal-${proposal.id}`}
             OR (
               from_addr = ${fromAddr}
               AND to_addr = ${toAddr}
               AND edge_type = ${edgeType}
               AND qc_status IN ('pending', 'revised')
             )
          LIMIT 1
        `;
        if (!stagingExisting) {
          return {
            kind: "edge",
            fromAddr,
            toAddr,
            edgeType,
            label,
            rationale: compactText(suggestedEdge.reason || proposal.fusion_summary || proposal.summary, 240),
            confidence: clampConfidence(Math.max(Number(proposal.fusion_confidence || 0), 0.55)),
            source: "fusion",
          };
        }
      }
    }
  }

  const suggestedTension = parseJsonObject(payload.suggested_tension);
  const tensionType = normalizeFusionTensionType(suggestedTension.tension_type);
  const tensionFrom = typeof suggestedTension.from_addr === "string" ? suggestedTension.from_addr : "";
  const tensionTo = typeof suggestedTension.to_addr === "string" ? suggestedTension.to_addr : "";
  const synthesis = typeof suggestedTension.synthesis === "string" ? suggestedTension.synthesis.trim() : "";
  const tensionStrength = clampFusionConfidence(suggestedTension.tension);
  if (
    String(proposal.fusion_action || "") === "preserve_tension"
    && tensionType
    && clusterNodeAddrs.has(tensionFrom)
    && clusterNodeAddrs.has(tensionTo)
    && tensionFrom !== tensionTo
    && tensionStrength > 0
    && validTensionSynthesis(synthesis)
  ) {
    const [existingTension] = await tx`
      SELECT id
      FROM edge_tensions
      WHERE from_addr = ${tensionFrom}
        AND to_addr = ${tensionTo}
        AND tension_type = ${tensionType}
        AND resolved_at IS NULL
      LIMIT 1
    `;
    if (!existingTension) {
      const [pendingProposal] = await tx`
        SELECT id
        FROM proposals
        WHERE proposal_type = 'tension'
          AND from_addr = ${tensionFrom}
          AND to_addr = ${tensionTo}
          AND status = 'pending'
          AND payload->>'tension_type' = ${tensionType}
        LIMIT 1
      `;
      if (!pendingProposal) {
        return {
          kind: "tension",
          fromAddr: tensionFrom,
          toAddr: tensionTo,
          tensionType,
          tension: tensionStrength,
          synthesis: compactText(synthesis, 600),
          rationale: compactText(suggestedTension.reason || proposal.fusion_summary || proposal.summary, 240),
          source: "fusion",
        };
      }
    }
  }

  return null;
}

async function selectConfidenceHandoffCandidate(
  tx: SqlClient,
  proposal: any,
): Promise<CuratorHandoffCandidate | null> {
  const payload = parseJsonObject(proposal.payload);
  const metadata = parseJsonObject(proposal.metadata);
  const candidateAddrs = uniqueNodeAddrs([
    String(proposal.seed_ref),
    typeof payload.candidate_addr === "string" ? payload.candidate_addr : null,
    typeof metadata.duplicate_addr === "string" ? metadata.duplicate_addr : null,
    typeof payload.parent_addr === "string" ? payload.parent_addr : null,
  ]);
  if (!candidateAddrs.length) return null;

  const nodeRows = await tx`
    SELECT addr, label, COALESCE(confidence, 0) AS confidence, COALESCE(query_hits, 0) AS query_hits
    FROM nodes
    WHERE addr = ANY(${candidateAddrs}::text[])
  `;
  if (!nodeRows.length) return null;

  if (proposal.proposal_kind === "duplicate_review") {
    const sorted = [...nodeRows].sort((a: any, b: any) => {
      const scoreA = Number(a.confidence || 0) + Number(a.query_hits || 0) * 0.01;
      const scoreB = Number(b.confidence || 0) + Number(b.query_hits || 0) * 0.01;
      return scoreA - scoreB;
    });
    const target = sorted[0];
    const proposedConfidence = clampConfidence(Number(target.confidence || 0) - CURATOR_CONFIDENCE_STEP);
    if (proposedConfidence >= Number(target.confidence || 0)) return null;
    return {
      kind: "update",
      addr: String(target.addr),
      label: String(target.label),
      field: "confidence",
      oldValue: Number(target.confidence || 0),
      newValue: proposedConfidence,
      rationale: `Duplicate pressure against a stronger nearby node suggests this node's confidence should be reviewed downward before semantic consolidation.`,
      source: "curator",
    };
  }

  if (proposal.proposal_kind === "granularity_review") {
    const targetAddr = typeof payload.seed_addr === "string" ? payload.seed_addr : String(proposal.seed_ref);
    const target = nodeRows.find((row: any) => String(row.addr) === targetAddr) || nodeRows[0];
    const proposedConfidence = clampConfidence(Number(target.confidence || 0) - 0.10);
    if (proposedConfidence >= Number(target.confidence || 0)) return null;
    return {
      kind: "update",
      addr: String(target.addr),
      label: String(target.label),
      field: "confidence",
      oldValue: Number(target.confidence || 0),
      newValue: proposedConfidence,
      rationale: `Granularity pressure suggests this node may be too narrow relative to its parent and should be reviewed before it remains a strong standalone anchor.`,
      source: "curator",
    };
  }

  if (proposal.proposal_kind === "orphan_review") {
    const targetAddr = typeof payload.seed_addr === "string" ? payload.seed_addr : String(proposal.seed_ref);
    const target = nodeRows.find((row: any) => String(row.addr) === targetAddr) || nodeRows[0];
    const proposedConfidence = clampConfidence(Number(target.confidence || 0) - 0.08);
    if (proposedConfidence >= Number(target.confidence || 0)) return null;
    return {
      kind: "update",
      addr: String(target.addr),
      label: String(target.label),
      field: "confidence",
      oldValue: Number(target.confidence || 0),
      newValue: proposedConfidence,
      rationale: `Repeated orphan pressure with no meaningful neighborhood suggests the node should remain in the graph, but at a lower confidence until more evidence or bridges arrive.`,
      source: "curator",
    };
  }

  return null;
}

async function selectCuratorHandoffCandidate(
  tx: SqlClient,
  proposal: any,
): Promise<CuratorHandoffCandidate | null> {
  if (String(proposal.fusion_status || "none") === "judged") {
    const fusionCandidate = await selectFusionHandoffCandidate(tx, proposal);
    if (fusionCandidate) return fusionCandidate;
    return null;
  }
  return selectConfidenceHandoffCandidate(tx, proposal);
}

function canResolveFusionWithoutHandoff(proposal: any): boolean {
  if (String(proposal.fusion_status || "none") !== "judged") return false;
  if (String(proposal.fusion_action || "") !== "keep_separate") return false;
  if (Number(proposal.fusion_confidence || 0) < FUSION_CONFIDENCE_FLOOR) return false;
  const payload = parseJsonObject(proposal.fusion_payload);
  const updates = parseJsonArray<FusionSuggestedUpdate>(payload.suggested_updates);
  const suggestedEdge = parseJsonObject(payload.suggested_edge);
  const suggestedTension = parseJsonObject(payload.suggested_tension);
  return updates.length === 0
    && Object.keys(suggestedEdge).length === 0
    && Object.keys(suggestedTension).length === 0;
}

function shouldWaitForFusionBeforeHandoff(proposal: any): boolean {
  return String(proposal.proposal_kind || "") === "edge_quality_review";
}

function uniqueNodeAddrs(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

async function submitCuratorHandoff(
  tx: SqlClient,
  proposal: any,
  candidate: CuratorHandoffCandidate,
): Promise<{ submitted: boolean; stagingRef: string | null }> {
  const runId = `distill-proposal-${proposal.id}`;
  if (candidate.kind === "update") {
    const [existing] = await tx`
      SELECT id, qc_status
      FROM staging_updates
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    if (existing) {
      return {
        submitted: false,
        stagingRef: `update:${existing.id}`,
      };
    }

    const [staging] = await tx`
      INSERT INTO staging_updates (
        run_id,
        addr,
        field,
        old_value,
        new_value,
        reason,
        qc_status,
        qc_agent
      ) VALUES (
        ${runId},
        ${candidate.addr},
        ${candidate.field},
        ${tx.json(candidate.oldValue)},
        ${tx.json(candidate.newValue)},
        ${`${proposal.summary} ${candidate.rationale}`},
        'pending',
        ${candidate.source === "fusion" ? "distiller-fusion" : "distiller-curator"}
      )
      RETURNING id
    `;

    return {
      submitted: true,
      stagingRef: staging ? `update:${staging.id}` : null,
    };
  }

  if (candidate.kind === "tension") {
    const labelRows = await tx`
      SELECT addr, label
      FROM nodes
      WHERE addr = ANY(${[candidate.fromAddr, candidate.toAddr]}::text[])
    `;
    const labelByAddr = new Map(labelRows.map((row: any) => [String(row.addr), String(row.label)]));

    const [existingApplied] = await tx`
      SELECT id
      FROM edge_tensions
      WHERE from_addr = ${candidate.fromAddr}
        AND to_addr = ${candidate.toAddr}
        AND tension_type = ${candidate.tensionType}
        AND resolved_at IS NULL
      LIMIT 1
    `;
    if (existingApplied) {
      return {
        submitted: false,
        stagingRef: `tension:${existingApplied.id}`,
      };
    }

    const [existing] = await tx`
      SELECT id
      FROM proposals
      WHERE proposal_type = 'tension'
        AND from_addr = ${candidate.fromAddr}
        AND to_addr = ${candidate.toAddr}
        AND status = 'pending'
        AND payload->>'tension_type' = ${candidate.tensionType}
      LIMIT 1
    `;
    if (existing) {
      return {
        submitted: false,
        stagingRef: `proposal:${existing.id}`,
      };
    }

    const [proposalRow] = await tx`
      INSERT INTO proposals (
        proposal_type,
        from_addr,
        to_addr,
        payload,
        confidence,
        discovered_by,
        evidence
      ) VALUES (
        'tension',
        ${candidate.fromAddr},
        ${candidate.toAddr},
        ${tx.json({
          tension_type: candidate.tensionType,
          tension: candidate.tension,
          synthesis: candidate.synthesis,
          synthesis_confidence: Number(proposal.fusion_confidence || candidate.tension || 0.5),
          visibility: "public",
          from_label: labelByAddr.get(candidate.fromAddr) || null,
          to_label: labelByAddr.get(candidate.toAddr) || null,
        })},
        ${Number(proposal.fusion_confidence || candidate.tension || 0.5)},
        'distiller-fusion',
        ${tx.json([{
          type: "distiller_fusion",
          proposal_id: proposal.id,
          summary: proposal.summary,
          rationale: candidate.rationale,
          timestamp: new Date().toISOString(),
        }])}
      )
      RETURNING id
    `;

    return {
      submitted: true,
      stagingRef: proposalRow ? `proposal:${proposalRow.id}` : null,
    };
  }

  const [staging] = await tx`
    INSERT INTO staging_edges (
      run_id,
      from_addr,
      to_addr,
      edge_type,
      layer,
      label,
      confidence,
      qc_status,
      qc_agent
    ) VALUES (
      ${runId},
      ${candidate.fromAddr},
      ${candidate.toAddr},
      ${candidate.edgeType},
      0,
      ${candidate.label},
      ${candidate.confidence},
      'pending',
      'distiller-fusion'
    )
    RETURNING id
  `;

  return {
    submitted: true,
    stagingRef: staging ? `edge:${staging.id}` : null,
  };
}

async function markWorkItemPendingQc(tx: SqlClient, proposal: any, stagingRef: string | null): Promise<void> {
  await tx`
    UPDATE distill_work_items
    SET status = 'resolved',
        resolved_at = now(),
        last_distilled_at = now(),
        metadata = metadata || ${tx.json({
          resolved_reason: "handoff_submitted",
          resolved_proposal_id: Number(proposal.id),
          resolved_staging_ref: stagingRef,
        })}
    WHERE id = ${proposal.work_item_id}
      AND status = 'open'
  `;
}

async function syncSubmittedCuratorProposals(tx: SqlClient): Promise<number> {
  const proposals = await tx`
    SELECT id, work_item_id, staging_ref
    FROM distill_proposals
    WHERE handoff_status = 'submitted'
      AND staging_ref IS NOT NULL
      AND status = 'open'
  `;

  let resolvedCount = 0;
  for (const proposal of proposals) {
    const [kind, rawId] = String(proposal.staging_ref).split(":");
    if (!rawId) continue;

    if (kind === "tension") {
      const [existing] = await tx`
        SELECT id
        FROM edge_tensions
        WHERE id = ${rawId}
        LIMIT 1
      `;
      if (!existing) continue;
      await tx`
        UPDATE distill_proposals
        SET status = 'resolved',
            handoff_status = 'submitted',
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      await tx`
        UPDATE distill_clusters
        SET status = 'resolved',
            updated_at = now()
        WHERE work_item_id = ${proposal.work_item_id}
          AND status = 'open'
      `;
      resolvedCount += 1;
      continue;
    }

    if (kind === "proposal") {
      const [queuedProposal] = await tx`
        SELECT id, status
        FROM proposals
        WHERE id = ${rawId}
        LIMIT 1
      `;
      if (!queuedProposal) continue;
      if (["approved", "applied"].includes(String(queuedProposal.status))) {
        await tx`
          UPDATE distill_proposals
          SET status = 'resolved',
              updated_at = now()
          WHERE id = ${proposal.id}
        `;
        await tx`
          UPDATE distill_clusters
          SET status = 'resolved',
              updated_at = now()
          WHERE work_item_id = ${proposal.work_item_id}
            AND status = 'open'
        `;
        resolvedCount += 1;
        continue;
      }
      if (String(queuedProposal.status) === "rejected") {
        const nextReviewAt = futureDate(CURATOR_BLOCKED_RETRY_MS);
        await tx`
          UPDATE distill_proposals
          SET status = 'deferred',
              handoff_status = 'blocked',
              defer_reason = 'QC rejected curator tension handoff',
              next_review_at = ${nextReviewAt},
              last_handoff_error = 'QC rejected curator tension handoff',
              updated_at = now()
          WHERE id = ${proposal.id}
        `;
        await tx`
          UPDATE distill_clusters
          SET status = 'deferred',
              defer_reason = 'QC rejected curator tension handoff',
              next_review_at = ${nextReviewAt},
              updated_at = now()
          WHERE work_item_id = ${proposal.work_item_id}
        `;
      }
      continue;
    }

    if (!["update", "edge"].includes(kind)) continue;
    const stagingRows = kind === "update"
      ? await tx`
          SELECT id, qc_status, qc_notes
          FROM staging_updates
          WHERE id = ${rawId}
          LIMIT 1
        `
      : await tx`
          SELECT id, qc_status, qc_notes
          FROM staging_edges
          WHERE id = ${rawId}
          LIMIT 1
        `;
    const [staging] = stagingRows;
    if (!staging) continue;
    if (staging.qc_status === "approved") {
      await tx`
        UPDATE distill_proposals
        SET status = 'resolved',
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      await tx`
        UPDATE distill_clusters
        SET status = 'resolved',
            updated_at = now()
        WHERE work_item_id = ${proposal.work_item_id}
          AND status = 'open'
      `;
      resolvedCount += 1;
      continue;
    }
    if (staging.qc_status === "rejected") {
      const nextReviewAt = futureDate(CURATOR_BLOCKED_RETRY_MS);
      await tx`
        UPDATE distill_proposals
        SET status = 'deferred',
            handoff_status = 'blocked',
            defer_reason = ${staging.qc_notes || "QC rejected curator handoff"},
            next_review_at = ${nextReviewAt},
            last_handoff_error = ${staging.qc_notes || "QC rejected curator handoff"},
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      await tx`
        UPDATE distill_clusters
        SET status = 'deferred',
            defer_reason = ${staging.qc_notes || "QC rejected curator handoff"},
            next_review_at = ${nextReviewAt},
            updated_at = now()
        WHERE work_item_id = ${proposal.work_item_id}
      `;
    }
  }

  return resolvedCount;
}

async function advanceCuratorLifecycle(
  tx: SqlClient,
  runId: number,
  fusionBudget: number,
  fusionJudge: FusionJudgeFn,
  options: { requireFusionJudgmentForHandoff?: boolean; shouldContinue?: () => boolean } = {},
): Promise<CuratorLifecycleResult> {
  const reopened = await reopenDueCuratorArtifacts(tx);
  const proposals = await tx`
    SELECT p.id, p.work_item_id, p.cluster_id, p.proposal_kind, p.status, p.risk_lane, p.summary, p.payload,
      p.handoff_status, p.staging_ref, p.fusion_status, p.fusion_action, p.fusion_summary,
      p.fusion_confidence, p.fusion_payload, p.fusion_attempt_count, p.fusion_error, p.fusion_next_review_at,
      w.scope_kind, w.seed_ref, w.pressure_type, w.attempt_count, w.metadata,
      cl.cluster_hash, cl.node_addrs, cl.edge_ids
    FROM distill_proposals p
    JOIN distill_work_items w ON w.id = p.work_item_id
    JOIN distill_clusters cl ON cl.id = p.cluster_id
    WHERE p.status = 'open'
    ORDER BY (p.payload->>'last_run_id' = ${String(runId)}) DESC,
      w.pressure_score DESC NULLS LAST,
      p.updated_at DESC,
      p.created_at DESC
  `;

  let deferred = 0;
  let handoffsPrepared = 0;
  let handoffsSubmitted = 0;
  let handoffsBlocked = 0;
  let fusionJudgments = 0;
  let fusionDeferred = 0;
  let fusionBlocked = 0;
  let proposalsResolvedInline = 0;
  let remainingFusionBudget = fusionBudget;

  for (let proposal of proposals) {
    if (!distillerShouldContinue(options)) break;
    if (proposal.handoff_status === "submitted") continue;

    // Ripening gate: skip (don't defer) proposals that haven't been observed enough.
    // Skipping keeps status='open' so the next pass picks it up naturally
    // once attempt_count crosses the threshold — no defer/reopen dance needed.
    const minAttempts = minAttemptsForPressure(String(proposal.pressure_type));
    const attemptCount = Number(proposal.attempt_count || 0);
    if (attemptCount < minAttempts) {
      continue;
    }

    const fusionStatus = String(proposal.fusion_status || "none");
    const fusionDue = !proposal.fusion_next_review_at || new Date(proposal.fusion_next_review_at).getTime() <= Date.now();
    if (
      remainingFusionBudget > 0
      && distillerShouldContinue(options)
      && (fusionStatus === "none" || (fusionStatus === "deferred" && fusionDue))
    ) {
      const fusionOutcome = await evaluateFusionProposal(tx, proposal, fusionJudge);
      if (fusionOutcome === "judged") fusionJudgments += 1;
      if (fusionOutcome === "deferred") fusionDeferred += 1;
      if (fusionOutcome === "blocked") fusionBlocked += 1;
      if (fusionOutcome !== "skipped") {
        remainingFusionBudget -= 1;
        proposal = await hydrateProposalState(tx, Number(proposal.id)) || proposal;
      }
    }

    if (!distillerShouldContinue(options)) break;

    if (
      (options.requireFusionJudgmentForHandoff || shouldWaitForFusionBeforeHandoff(proposal))
      && String(proposal.fusion_status || "none") !== "judged"
    ) {
      continue;
    }

    const candidate = await selectCuratorHandoffCandidate(tx, proposal);
    if (!candidate) {
      if (canResolveFusionWithoutHandoff(proposal)) {
        await tx`
          UPDATE distill_proposals
          SET status = 'resolved',
              resolved_at = now(),
              updated_at = now()
          WHERE id = ${proposal.id}
        `;
        await tx`
          UPDATE distill_clusters
          SET status = 'resolved',
              updated_at = now()
          WHERE work_item_id = ${proposal.work_item_id}
            AND status IN ('open', 'deferred')
        `;
        proposalsResolvedInline += 1;
        continue;
      }

      const nextReviewAt = futureDate(CURATOR_BLOCKED_RETRY_MS);
      await tx`
        UPDATE distill_proposals
        SET status = 'deferred',
            handoff_status = 'blocked',
            defer_reason = 'No safe curator handoff candidate was available for this cluster.',
            next_review_at = ${nextReviewAt},
            last_handoff_error = 'No safe curator handoff candidate was available for this cluster.',
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      await tx`
        UPDATE distill_clusters
        SET status = 'deferred',
            defer_reason = 'No safe curator handoff candidate was available for this cluster.',
            next_review_at = ${nextReviewAt},
            updated_at = now()
        WHERE id = ${proposal.cluster_id}
      `;
      handoffsBlocked += 1;
      continue;
    }

    handoffsPrepared += 1;
    await tx`
      UPDATE distill_proposals
      SET handoff_status = 'ready',
          payload = payload || ${tx.json({
            handoff_preview: buildHandoffPreview(candidate),
          })},
          updated_at = now()
      WHERE id = ${proposal.id}
    `;

    const handoff = await submitCuratorHandoff(tx, proposal, candidate);
    if (handoff.submitted) {
      await markWorkItemPendingQc(tx, proposal, handoff.stagingRef);
      await tx`
        UPDATE distill_proposals
        SET handoff_status = 'submitted',
            staging_ref = ${handoff.stagingRef},
            handed_off_at = now(),
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
      handoffsSubmitted += 1;
    } else if (handoff.stagingRef) {
      await markWorkItemPendingQc(tx, proposal, handoff.stagingRef);
      await tx`
        UPDATE distill_proposals
        SET handoff_status = 'submitted',
            staging_ref = ${handoff.stagingRef},
            updated_at = now()
        WHERE id = ${proposal.id}
      `;
    }
  }

  const proposalsResolved = proposalsResolvedInline + await syncSubmittedCuratorProposals(tx);
  return {
    reopened,
    deferred,
    handoffsPrepared,
    handoffsSubmitted,
    handoffsBlocked,
    proposalsResolved,
    fusionJudgments,
    fusionDeferred,
    fusionBlocked,
  };
}

async function buildCuratorArtifacts(tx: SqlClient, runId: number, budget: number): Promise<CuratorArtifactResult> {
  if (budget <= 0) return { clustersBuilt: 0, proposalsEmitted: 0, proposalsByPacketType: {} };
  const workItems = await tx`
    SELECT id, scope_kind, seed_ref, pressure_type, pressure_score, metadata
    FROM distill_work_items
    WHERE status = 'open'
      AND (
        (scope_kind = 'node' AND pressure_type = ANY(${["duplicate_pressure", "granularity_pressure", "orphan_pressure", "confidence_promotion_pressure"]}::text[]))
        OR (scope_kind = 'edge' AND pressure_type = 'edge_bloat_pressure')
      )
    ORDER BY (metadata->>'last_run_id' = ${String(runId)}) DESC, pressure_score DESC NULLS LAST, last_seen_at DESC
    LIMIT ${budget}
  `;

  let clustersBuilt = 0;
  let proposalsEmitted = 0;
  const proposalsByPacketType: Record<string, number> = {};
  for (const workItem of workItems) {
    const snapshot = await buildCuratorSnapshot(tx, workItem);
    if (!snapshot) {
      await tx`
        UPDATE distill_work_items
        SET status = 'invalid',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'invalid_reason', 'snapshot_unavailable',
              'invalid_at', now(),
              'invalid_run_id', ${runId}::bigint
            ),
            attempt_count = COALESCE(attempt_count, 0) + 1,
            resolved_at = now(),
            last_distilled_at = now()
        WHERE id = ${workItem.id}
      `;
      continue;
    }
    const result = await upsertCuratorArtifacts(tx, runId, workItem, snapshot);
    if (result.clusterBuilt) clustersBuilt += 1;
    if (result.proposalEmitted) {
      proposalsEmitted += 1;
      const packetType = String(snapshot.proposalPayload.semantic_audit_packet_type || "unknown");
      proposalsByPacketType[packetType] = (proposalsByPacketType[packetType] || 0) + 1;
    }
  }

  return { clustersBuilt, proposalsEmitted, proposalsByPacketType };
}

async function applyEdgeCleanup(tx: SqlClient, row: EdgeScanRow, pressure: PressureRecord, dryRun: boolean): Promise<0 | 1> {
  if (dryRun) return 0;
  if (parseJsonObject(pressure.metadata).subtype === "self_loop") {
    const deleted = await deleteEdgesByIds(rootSql as any, [row.id], { tx: tx as any });
    return deleted.deleted > 0 ? 1 : 0;
  }
  if (parseJsonObject(pressure.metadata).subtype === "vague_duplicate") {
    const doomed = await tx`
      SELECT id FROM edges
      WHERE id = ${row.id}
        AND edge_type = ANY(${VAGUE_EDGE_TYPES}::text[])
        AND EXISTS (
          SELECT 1
          FROM edges stronger
          WHERE stronger.from_addr = ${row.from_addr}
            AND stronger.to_addr = ${row.to_addr}
            AND stronger.edge_type <> ALL(${VAGUE_EDGE_TYPES}::text[])
        )
    `;
    const deleted = await deleteEdgesByIds(rootSql as any, doomed.map((r: any) => r.id), { tx: tx as any });
    return deleted.deleted > 0 ? 1 : 0;
  }
  return 0;
}

export async function tryAcquireDistillerLock(sql: SqlClient = rootSql): Promise<boolean> {
  const [result] = await sql`SELECT pg_try_advisory_lock(${DISTILLER_LOCK_ID}) AS acquired`;
  return Boolean(result?.acquired);
}

export async function releaseDistillerLock(sql: SqlClient = rootSql): Promise<void> {
  await sql`SELECT pg_advisory_unlock(${DISTILLER_LOCK_ID})`;
}

export async function runDistillerPass(sql: SqlClient = rootSql, options: DistillerOptions = {}): Promise<DistillerRunResult> {
  const dryRun = Boolean(options.dryRun);
  const mode = options.mode || "once";
  const nodeScanLimit = clampLimit(options.nodeScanLimit, DEFAULT_NODE_SCAN_LIMIT, 1, 200, "nodeScanLimit");
  const edgeScanLimit = clampLimit(options.edgeScanLimit, DEFAULT_EDGE_SCAN_LIMIT, 1, 400, "edgeScanLimit");
  const curatorBudget = clampLimit(options.curatorBudget, DEFAULT_CURATOR_BUDGET, 0, 24, "curatorBudget");
  const fusionBudget = clampLimit(options.fusionBudget, DEFAULT_FUSION_BUDGET, 0, 12, "fusionBudget");
  if (options.requireFusionJudgmentForHandoff === true && fusionBudget === 0) {
    throw new Error(
      "fusionBudget=0 with requireFusionJudgmentForHandoff=true creates a no-progress state; set fusionBudget >= 1 or drop the requirement",
    );
  }
  const fusionJudge = options.fusionJudge || defaultFusionJudge;
  const applyDeterministicEdgeCleanup = options.applyDeterministicEdgeCleanup !== false;
  const shouldContinue = () => distillerShouldContinue(options);
  const runInput = {
    dryRun,
    mode,
    workerInstance: options.workerInstance || null,
    nodeScanLimit,
    edgeScanLimit,
    fusionBudget,
    metadata: options.metadata,
  };

  try {
    return await withTransaction(sql, async (tx: SqlClient) => {
    await ensureCursorRows(tx);
    const runId = await createRun(tx, runInput);

    const result: DistillerRunResult = {
      runId,
      status: "completed",
      nodeScanCount: 0,
      edgeScanCount: 0,
      workItemsSelected: 0,
      workItemsDetected: 0,
      workItemsResolved: 0,
      actionsApplied: 0,
      vagueEdgesRemoved: 0,
      selfLoopEdgesRemoved: 0,
      clustersBuilt: 0,
      proposalsEmitted: 0,
      proposalsDeferred: 0,
      proposalsReopened: 0,
      handoffsPrepared: 0,
      handoffsSubmitted: 0,
      handoffsBlocked: 0,
      proposalsResolved: 0,
      proposalsByPacketType: {},
      fusionJudgments: 0,
      fusionDeferred: 0,
      fusionBlocked: 0,
      dryRun,
    };

    try {
      const [edgeRows, nodeRows] = await Promise.all([
        nextEdgeBatch(tx, edgeScanLimit),
        nextNodeBatch(tx, nodeScanLimit),
      ]);

      result.edgeScanCount = edgeRows.length;
      result.nodeScanCount = nodeRows.length;
      result.workItemsSelected = edgeRows.length + nodeRows.length;

      for (const row of edgeRows) {
        if (!shouldContinue()) break;
        const pressures = buildEdgePressures(row);
        const activeTypes = pressures.map((pressure) => pressure.pressureType);
        for (const pressure of pressures) {
          if (!shouldContinue()) break;
          await upsertWorkItem(tx, runId, "edge", String(row.id), pressure);
          result.workItemsDetected += 1;
          const applied = applyDeterministicEdgeCleanup
            ? await applyEdgeCleanup(tx, row, pressure, dryRun)
            : 0;
          if (applied > 0) {
            result.actionsApplied += applied;
            const subtype = String(parseJsonObject(pressure.metadata).subtype || "");
            if (subtype === "self_loop") result.selfLoopEdgesRemoved += applied;
            if (subtype === "vague_duplicate") result.vagueEdgesRemoved += applied;
            const resolvedIds = await resolveAppliedWorkItem(tx, "edge", String(row.id), pressure.pressureType, {
              resolution: "auto_applied",
              resolved_run_id: runId,
            });
            await resolveCuratorArtifacts(tx, resolvedIds);
            result.workItemsResolved += 1;
          }
        }
        if (!shouldContinue()) break;
        const resolved = await resolveInactiveWorkItems(tx, "edge", String(row.id), activeTypes);
        await resolveCuratorArtifacts(tx, resolved.workItemIds);
        result.workItemsResolved += resolved.count;
      }

      for (const row of nodeRows) {
        if (!shouldContinue()) break;
        const pressures = buildNodePressures(row);
        const activeTypes = pressures.map((pressure) => pressure.pressureType);
        for (const pressure of pressures) {
          if (!shouldContinue()) break;
          await upsertWorkItem(tx, runId, "node", row.addr, pressure);
          result.workItemsDetected += 1;
        }
        if (!shouldContinue()) break;
        const resolved = await resolveInactiveWorkItems(tx, "node", row.addr, activeTypes);
        await resolveCuratorArtifacts(tx, resolved.workItemIds);
        result.workItemsResolved += resolved.count;
      }

      if (shouldContinue()) {
        const curator = await buildCuratorArtifacts(tx, runId, curatorBudget);
        result.clustersBuilt = curator.clustersBuilt;
        result.proposalsEmitted = curator.proposalsEmitted;
        result.proposalsByPacketType = curator.proposalsByPacketType;
      }

      if (shouldContinue()) {
        const lifecycle = await advanceCuratorLifecycle(tx, runId, fusionBudget, fusionJudge, {
          requireFusionJudgmentForHandoff: options.requireFusionJudgmentForHandoff,
          shouldContinue,
        });
        result.proposalsReopened = lifecycle.reopened;
        result.proposalsDeferred = lifecycle.deferred;
        result.handoffsPrepared = lifecycle.handoffsPrepared;
        result.handoffsSubmitted = lifecycle.handoffsSubmitted;
        result.handoffsBlocked = lifecycle.handoffsBlocked;
        result.proposalsResolved = lifecycle.proposalsResolved;
        result.fusionJudgments = lifecycle.fusionJudgments;
        result.fusionDeferred = lifecycle.fusionDeferred;
        result.fusionBlocked = lifecycle.fusionBlocked;
      }

      await finalizeRun(tx, runId, result, {
        node_scan_count: result.nodeScanCount,
        edge_scan_count: result.edgeScanCount,
        clusters_built: result.clustersBuilt,
        proposals_emitted: result.proposalsEmitted,
        proposals_deferred: result.proposalsDeferred,
        proposals_reopened: result.proposalsReopened,
        handoffs_prepared: result.handoffsPrepared,
        handoffs_submitted: result.handoffsSubmitted,
        handoffs_blocked: result.handoffsBlocked,
        proposals_resolved: result.proposalsResolved,
        proposals_by_packet_type: result.proposalsByPacketType,
        fusion_judgments: result.fusionJudgments,
        fusion_deferred: result.fusionDeferred,
        fusion_blocked: result.fusionBlocked,
      });
      return result;
    } catch (error) {
      result.status = "failed";
      await finalizeRun(tx, runId, result, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    });
  } catch (error) {
    await recordFailedRunAfterRollback(sql, runInput, error).catch(() => {});
    throw error;
  }
}
