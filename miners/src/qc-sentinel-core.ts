import {
  PREFIX_TO_PYRAMID_ID,
  VALID_NODE_TYPES,
  DEPTH_GUARDED_PYRAMIDS,
  isValidAddr,
  addrBelongsToPyramid,
  ADDR_SHAPE_STANDARD,
} from "@verity-one/graph-shape";

export const PREFIX_TO_PYRAMID = PREFIX_TO_PYRAMID_ID;

export const RUNBOOK_TYPES = ["workflow", "procedure", "protocol"] as const;
export const VALID_VISIBILITY = ["public", "private", "dormant", "merged"] as const;
export const SUPPORTED_UPDATE_FIELDS = ["label", "substance", "confidence", "visibility"] as const;
export const MAX_CONFIDENCE = 0.7;
// F6 hoisted the canonical address-shape regex into @verity-one/graph-shape.
// VALID_ADDR_RE remains exported here for back-compat with importers that
// only need the standard 4-segment shape; isValidAddr() is the canonical
// validator that also accepts the universal AO/TMP exceptions.
export const VALID_ADDR_RE = ADDR_SHAPE_STANDARD;

type JsonRecord = Record<string, unknown>;

export interface ShapeResult {
  valid: boolean;
  reason?: string;
}

export interface StagingBase {
  id: number;
  run_id: string;
  qc_status?: string;
  qc_agent?: string | null;
  qc_notes?: string | null;
  qc_timestamp?: string | null;
  claimed_at?: string | null;
  claimed_by?: string | null;
  retry_after?: string | null;
  revision_count?: number | null;
  last_error?: string | null;
  created_at?: string;
}

export interface StagingNode extends StagingBase {
  addr: string;
  pyramid_id: string;
  layer: number;
  depth: number;
  position: number;
  label: string;
  substance: unknown;
  confidence: number;
  parent_addr: string | null;
  visibility: string;
  source_context?: unknown;
}

export interface StagingEdge extends StagingBase {
  from_addr: string;
  to_addr: string;
  edge_type: string;
  layer: number;
  label: string;
  confidence: number;
  source_context?: unknown;
}

export interface StagingUpdate extends StagingBase {
  addr: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
  reason: string;
}

export type StagingItem =
  | { type: "node"; item: StagingNode }
  | { type: "edge"; item: StagingEdge }
  | { type: "update"; item: StagingUpdate };

export interface QCDecision {
  decision: "approve" | "reject" | "revise";
  reason: string;
  patch?: Record<string, unknown>;
}

export function parseJsonField<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stagingTemporality(sourceContext: JsonRecord): string | null {
  return normalizeString(sourceContext.vi_temporality)
    || normalizeString(sourceContext.wi_temporality)
    || normalizeString(sourceContext.temporality);
}

export function validateSubstancePayload(substance: unknown): ShapeResult {
  // Auto-parse double-encoded JSON strings (common from LLM-generated SQL)
  let s = substance;
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch { /* leave as-is */ }
  }
  if (!isRecord(s)) return { valid: false, reason: "Substance is null or not an object" };

  const desc = s.description;
  if (typeof desc !== "string" || desc.trim().length < 50) {
    return { valid: false, reason: `substance.description must be >50 chars (got ${typeof desc === "string" ? desc.trim().length : 0})` };
  }

  const nodeType = normalizeString(s.node_type);
  if (!nodeType || !VALID_NODE_TYPES.includes(nodeType as (typeof VALID_NODE_TYPES)[number])) {
    return { valid: false, reason: `Invalid substance.node_type: ${nodeType || "missing"} (valid: ${VALID_NODE_TYPES.join(", ")})` };
  }

  if (RUNBOOK_TYPES.includes(nodeType as (typeof RUNBOOK_TYPES)[number])) {
    const runbook = s.runbook;
    if (!Array.isArray(runbook) || runbook.length < 1 || runbook.length > 8) {
      return { valid: false, reason: `${nodeType} requires runbook array (1-8 items), got ${Array.isArray(runbook) ? runbook.length : "missing"}` };
    }
  }

  return { valid: true };
}

export function validateNodeShape(node: StagingNode): ShapeResult {
  if (!isValidAddr(node.addr)) {
    return {
      valid: false,
      reason: `Invalid addr format: ${node.addr} (expected <PREFIX>.L.D.P, TMP.YYYY.DOY, or AO.0.0.0)`,
    };
  }

  if (!addrBelongsToPyramid(node.addr, node.pyramid_id)) {
    return {
      valid: false,
      reason: `Addr ${node.addr} does not belong to pyramid_id ${node.pyramid_id}`,
    };
  }

  // Depth contract: depth 0-2 is human-curated ontology only.
  // DEPTH_GUARDED_PYRAMIDS is canonical in @verity-one/graph-shape.
  const OPERATOR_AGENTS = ["operator", "human", "the operator"];
  const submitter = (node.qc_agent || node.claimed_by || "").toLowerCase();
  if (
    node.depth <= 2 &&
    (DEPTH_GUARDED_PYRAMIDS as readonly string[]).includes(node.pyramid_id.toUpperCase()) &&
    !OPERATOR_AGENTS.includes(submitter)
  ) {
    return { valid: false, reason: "Depth 0-2 nodes require operator approval" };
  }

  const substanceCheck = validateSubstancePayload(node.substance);
  if (!substanceCheck.valid) return substanceCheck;

  if (node.confidence > MAX_CONFIDENCE) {
    return { valid: false, reason: `Confidence ${node.confidence} exceeds cap ${MAX_CONFIDENCE}` };
  }

  if (!VALID_VISIBILITY.includes(node.visibility as (typeof VALID_VISIBILITY)[number])) {
    return { valid: false, reason: `Invalid visibility: ${node.visibility}` };
  }

  const sourceContext = parseJsonField<JsonRecord>(node.source_context) || {};
  const temporality = stagingTemporality(sourceContext);
  if (temporality && temporality !== "DURABLE") {
    return { valid: false, reason: `Non-durable staging item routed to QC (${temporality})` };
  }

  const substance = node.substance as JsonRecord;
  if (substance.node_type === "trend") {
    const trendContext = isRecord(sourceContext.trend) ? sourceContext.trend : {};
    if (trendContext.graduation_review !== true) {
      return { valid: false, reason: "Trend nodes require source_context.trend.graduation_review=true" };
    }
  }

  return { valid: true };
}

export function validateEdgeShape(edge: StagingEdge): ShapeResult {
  if (edge.from_addr === edge.to_addr) {
    return { valid: false, reason: `Self-loop: ${edge.from_addr} → ${edge.to_addr}` };
  }

  if (edge.confidence > MAX_CONFIDENCE) {
    return { valid: false, reason: `Confidence ${edge.confidence} exceeds cap ${MAX_CONFIDENCE}` };
  }

  const sourceContext = parseJsonField<JsonRecord>(edge.source_context) || {};
  const temporality = stagingTemporality(sourceContext);
  if (temporality && temporality !== "DURABLE") {
    return { valid: false, reason: `Non-durable staging item routed to QC (${temporality})` };
  }

  return { valid: true };
}

export function validateUpdateShape(update: StagingUpdate): ShapeResult {
  if (!SUPPORTED_UPDATE_FIELDS.includes(update.field as (typeof SUPPORTED_UPDATE_FIELDS)[number])) {
    return { valid: false, reason: `Unsupported update field: ${update.field}` };
  }

  const reason = normalizeString(update.reason);
  if (!reason || reason.length < 10) {
    return { valid: false, reason: "Update reason must be at least 10 characters" };
  }

  switch (update.field) {
    case "label": {
      const label = normalizeString(update.new_value);
      if (!label || label.length < 3) {
        return { valid: false, reason: "Label updates require a non-empty string" };
      }
      return { valid: true };
    }
    case "substance":
      return validateSubstancePayload(parseJsonField<JsonRecord>(update.new_value) || update.new_value);
    case "confidence": {
      const value = parseNumeric(update.new_value);
      if (value == null || value < 0 || value > 1) {
        return { valid: false, reason: "Confidence updates require a numeric value between 0 and 1" };
      }
      return { valid: true };
    }
    case "visibility": {
      const value = normalizeString(update.new_value);
      if (!value || !VALID_VISIBILITY.includes(value as (typeof VALID_VISIBILITY)[number])) {
        return { valid: false, reason: `Visibility updates require one of: ${VALID_VISIBILITY.join(", ")}` };
      }
      return { valid: true };
    }
    default:
      return { valid: false, reason: `Unsupported update field: ${update.field}` };
  }
}

export function sanitizeRevisionPatch(
  type: StagingItem["type"],
  patch: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(patch)) return undefined;

  if (type === "node") {
    const next: Record<string, unknown> = {};
    const label = normalizeString(patch.label);
    if (label) next.label = label;
    const substance = parseJsonField<JsonRecord>(patch.substance) || patch.substance;
    if (isRecord(substance)) next.substance = substance;
    const visibility = normalizeString(patch.visibility);
    if (visibility && VALID_VISIBILITY.includes(visibility as (typeof VALID_VISIBILITY)[number])) {
      next.visibility = visibility;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  if (type === "edge") {
    const label = normalizeString(patch.label);
    return label ? { label } : undefined;
  }

  const next: Record<string, unknown> = {};
  if ("new_value" in patch) next.new_value = (patch as JsonRecord).new_value;
  const reason = normalizeString(patch.reason);
  if (reason) next.reason = reason;
  return Object.keys(next).length > 0 ? next : undefined;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
    throw new Error(`QC response was not valid JSON: ${trimmed.slice(0, 200)}`);
  }
}

export function parseQcDecisionResponse(raw: string, type: StagingItem["type"]): QCDecision {
  const payload = JSON.parse(extractJsonObject(raw)) as JsonRecord;
  const decision = normalizeString(payload.decision)?.toLowerCase();
  const reason = normalizeString(payload.reason) || "No reason provided";

  if (decision !== "approve" && decision !== "reject" && decision !== "revise") {
    throw new Error(`Invalid QC decision: ${String(payload.decision || "(missing)")}`);
  }

  const patch = sanitizeRevisionPatch(type, payload.patch);
  return {
    decision,
    reason,
    patch,
  };
}

export async function parseQcDecisionResponseWithRepair(
  raw: string,
  type: StagingItem["type"],
  repair?: (raw: string, error: Error) => Promise<string | null>,
): Promise<QCDecision> {
  try {
    return parseQcDecisionResponse(raw, type);
  } catch (error) {
    if (!repair) throw error;
    const repaired = await repair(raw, error instanceof Error ? error : new Error(String(error)));
    if (!repaired || !repaired.trim()) throw error;
    return parseQcDecisionResponse(repaired, type);
  }
}

export function normalizeApprovedUpdateValue(field: string, value: unknown): unknown {
  switch (field) {
    case "label":
    case "visibility": {
      const normalized = normalizeString(value);
      if (!normalized) throw new Error(`${field} update requires a string value`);
      return normalized;
    }
    case "confidence": {
      const numeric = parseNumeric(value);
      if (numeric == null || numeric < 0 || numeric > 1) {
        throw new Error("confidence update requires a numeric value between 0 and 1");
      }
      return numeric;
    }
    case "substance": {
      const parsed = parseJsonField<JsonRecord>(value) || value;
      if (!isRecord(parsed)) throw new Error("substance update requires an object value");
      return parsed;
    }
    default:
      throw new Error(`Unsupported update field: ${field}`);
  }
}
