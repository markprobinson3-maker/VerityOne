import type { OntologyBridgePayload } from "./ontology-bridges";
import { summarizeSourceGrounding } from "./source-refs";
import { parseJsonField } from "./utils";

type GuidanceRow = {
  addr?: string | null;
  pyramid_id?: string | null;
  label?: string | null;
  confidence?: number | string | null;
  source_refs?: unknown;
  source_context?: unknown;
  space_id?: string | null;
};

export type NodeGuidance = {
  truth_posture: "grounded" | "partially_grounded" | "provisional" | "heuristic" | "tenant_local";
  truth_reason: string;
  traversal_hint: string;
};

export function deriveNodeGuidance(
  row: GuidanceRow,
  ontology: OntologyBridgePayload | null = null,
): NodeGuidance {
  const confidence = Number(row.confidence || 0);
  const groundingSummary = summarizeSourceGrounding(row.source_refs);
  const refs = groundingSummary.refCount;
  const isTenantLocal = !!row.space_id && row.space_id !== "global";
  const sourceContext = parseJsonField<Record<string, any>>(row.source_context) ?? {};
  const explicitGrounding = sourceContext?.grounding?.status;

  let truth_posture: NodeGuidance["truth_posture"];
  let truth_reason: string;

  if (isTenantLocal) {
    truth_posture = "tenant_local";
    truth_reason = "This node is tenant-local. Treat it as private operational memory unless it has been published into the public truth layer.";
  } else if (explicitGrounding === "grounded") {
    truth_posture = "grounded";
    truth_reason = sourceContext?.grounding?.note || "This node has been explicitly marked grounded by the public durable grounding policy.";
  } else if (explicitGrounding === "partially_grounded") {
    truth_posture = "partially_grounded";
    truth_reason = sourceContext?.grounding?.note || "This node has explicit but partial grounding and should be treated as constrained guidance.";
  } else if (explicitGrounding === "provisional") {
    truth_posture = "provisional";
    truth_reason = sourceContext?.grounding?.note || "This node is explicitly marked provisional until corroborated.";
  } else if (groundingSummary.corroborated && confidence >= 0.75) {
    truth_posture = "grounded";
    truth_reason = `This node is corroborated across ${groundingSummary.originCount} distinct source origins and can serve as a stable truth anchor.`;
  } else if (refs >= 1) {
    truth_posture = "partially_grounded";
    truth_reason = groundingSummary.originCount >= 1
      ? `This node has ${refs} source reference${refs === 1 ? "" : "s"} across ${groundingSummary.originCount} origin${groundingSummary.originCount === 1 ? "" : "s"}, but it should still be treated as constrained guidance rather than final truth.`
      : "This node has at least one source reference, but it should still be treated as constrained guidance rather than final truth.";
  } else if (confidence >= 0.75) {
    truth_posture = "provisional";
    truth_reason = "This node is structurally coherent but under-sourced. Use it as a working hypothesis until corroborated.";
  } else {
    truth_posture = "heuristic";
    truth_reason = "This node is weakly grounded. Use it only to guide further search, not to anchor a decisive claim.";
  }

  const topAnchor = ontology?.anchors?.[0] || null;
  const topBridge = ontology?.cross_domain?.[0] || null;

  let traversal_hint = "Stay narrow: inspect this node and one meaningful neighbor before broadening the search.";
  if (topAnchor) {
    traversal_hint = topAnchor.pyramid_id === "FUNCTION"
      ? "Use the strongest FUNCTION anchor for the next action, then cross into WORLD only if constraints, incentives, or evidence matter."
      : "Use the strongest WORLD anchor to ground the claim first, then cross into FUNCTION only when a concrete move is needed.";
  } else if (topBridge) {
    traversal_hint = `Follow the bridge into ${topBridge.label} only if the current node stops yielding direct action or factual grounding.`;
  } else if (row.pyramid_id === "FUNCTION") {
    traversal_hint = "Treat this as an action branch. Cross into WORLD only to verify facts, incentives, or external constraints.";
  } else if (row.pyramid_id === "WORLD") {
    traversal_hint = "Treat this as a grounding branch. Cross into FUNCTION only when you need a concrete operational move.";
  }

  return { truth_posture, truth_reason, traversal_hint };
}
