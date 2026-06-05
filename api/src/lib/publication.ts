import { VALID_NODE_TYPES, type KnownNodeType, canonicalizePyramidId } from "./graph-shape";
import { resolveDurableOntologyTarget } from "./ontology";

type SqlTag = any;

export interface SourceNodeForPublication {
  addr: string;
  space_id: string;
  pyramid_id: string;
  label: string;
  node_type?: string | null;
  substance?: any;
  visibility?: string | null;
  source_context?: any;
}

export interface PublicationOverrides {
  targetPyramidId?: string | null;
  targetParentAddr?: string | null;
  publicLabel?: string | null;
  publicDescription?: string | null;
  publicNodeType?: string | null;
  publicVisibility?: string | null;
  provides?: string[] | null;
  quickStart?: unknown;
  references?: unknown;
  derivationNote?: string | null;
  publicationKind?: "mirror" | "promotion" | "derivation" | null;
}

export interface PublicationPlan {
  targetPyramidId: string;
  targetParentAddr: string | null;
  publicLabel: string;
  publicDescription: string;
  publicNodeType: KnownNodeType;
  publicVisibility: string;
  publicationKind: "mirror" | "promotion" | "derivation";
  derivationNote: string | null;
  sourceSnapshot: Record<string, unknown>;
  publishedSubstance: Record<string, unknown>;
  selectionReason: string;
}

function trimString(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
}

function normalizeNodeType(value: string | null | undefined, fallback: KnownNodeType = "concept"): KnownNodeType {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "project") return "concept";
  if (VALID_NODE_TYPES.includes(normalized as KnownNodeType)) return normalized as KnownNodeType;
  return fallback;
}

function uniqueStrings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const cleaned = values
    .map((value) => trimString(value, 200))
    .filter((value): value is string => !!value);
  if (cleaned.length === 0) return undefined;
  return [...new Set(cleaned)];
}

export async function buildPublicationPlan(
  sql: SqlTag,
  sourceNode: SourceNodeForPublication,
  overrides: PublicationOverrides = {},
): Promise<PublicationPlan> {
  const sourceSubstance = (sourceNode.substance && typeof sourceNode.substance === "object")
    ? sourceNode.substance
    : {};
  const sourceDescription = trimString(overrides.publicDescription, 6000)
    || trimString(sourceSubstance.description, 6000)
    || `${sourceNode.label} published from a private tenant overlay into the public Verity graph.`;
  const sourceLabel = trimString(overrides.publicLabel, 200) || sourceNode.label;
  const requestedPyramid = canonicalizePyramidId(overrides.targetPyramidId || undefined);
  if (requestedPyramid === "PROJECTS") {
    throw new Error("Public publications cannot target PROJECTS");
  }

  const ontologyTarget = requestedPyramid
    ? {
        pyramidId: requestedPyramid,
        parentAddr: overrides.targetParentAddr || null,
        parentLabel: null,
        selectionReason: `Operator override selected ${requestedPyramid}`,
        keywordScore: 0,
      }
    : await resolveDurableOntologyTarget(sql, {
        content: [sourceNode.label, sourceDescription].filter(Boolean).join("\n\n"),
        sourceType: sourceNode.source_context?.publication_source_type
          || (sourceNode.pyramid_id === "PROJECTS" ? null : sourceNode.pyramid_id),
        nodeType: sourceNode.node_type,
        includeLocalPyramids: false,
      });

  const targetPyramidId = ontologyTarget.pyramidId;
  if (targetPyramidId === "PROJECTS") {
    throw new Error("Public publications cannot target PROJECTS");
  }

  const publicNodeType = normalizeNodeType(overrides.publicNodeType || sourceNode.node_type || "concept");
  const publishedSubstance: Record<string, unknown> = {
    description: sourceDescription,
    published_from_private_overlay: true,
  };

  const provides = uniqueStrings(overrides.provides || sourceSubstance.provides);
  if (provides && targetPyramidId === "FUNCTION") {
    publishedSubstance.provides = provides;
  }

  if (overrides.quickStart !== undefined && overrides.quickStart !== null) {
    publishedSubstance.quick_start = overrides.quickStart;
  } else if (targetPyramidId === "FUNCTION" && sourceSubstance.quick_start != null) {
    publishedSubstance.quick_start = sourceSubstance.quick_start;
  }

  if (overrides.references !== undefined && overrides.references !== null) {
    publishedSubstance.references = overrides.references;
  } else if (sourceSubstance.references != null) {
    publishedSubstance.references = sourceSubstance.references;
  }

  if (targetPyramidId === "FUNCTION" && sourceSubstance.runbook != null) {
    publishedSubstance.runbook = sourceSubstance.runbook;
  }

  const derivationNote = trimString(overrides.derivationNote, 2000);
  if (derivationNote) {
    publishedSubstance.derivation_note = derivationNote;
  }

  return {
    targetPyramidId,
    targetParentAddr: overrides.targetParentAddr || ontologyTarget.parentAddr || null,
    publicLabel: sourceLabel,
    publicDescription: sourceDescription,
    publicNodeType,
    publicVisibility: trimString(overrides.publicVisibility, 50) || "public",
    publicationKind: overrides.publicationKind || "mirror",
    derivationNote,
    sourceSnapshot: {
      addr: sourceNode.addr,
      space_id: sourceNode.space_id,
      pyramid_id: sourceNode.pyramid_id,
      label: sourceNode.label,
      node_type: sourceNode.node_type || null,
      description: trimString(sourceSubstance.description, 6000),
    },
    publishedSubstance,
    selectionReason: ontologyTarget.selectionReason,
  };
}

export function publicationEdgeTypeForTarget(targetPyramidId: string, publicNodeType: string): string {
  if (targetPyramidId === "FUNCTION") {
    return ["tool", "skill", "workflow", "procedure", "protocol"].includes(publicNodeType)
      ? "operationalizes"
      : "implements";
  }
  if (targetPyramidId === "WORLD") return "informs";
  return "mirrors";
}
