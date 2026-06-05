import { deriveSourceRefs, summarizeSourceGrounding } from "./source-refs";
import { parseJsonField } from "./utils";

export type PublicGroundingStatus = "grounded" | "partially_grounded" | "provisional";
export type PublicationReviewStatus = "ready_to_publish" | "needs_grounding";

type GroundingContext = Record<string, unknown>;

type EvaluatePublicGroundingInput = {
  spaceId?: string | null;
  visibility?: string | null;
  confidence?: number | string | null;
  sourceRefs?: unknown;
  sourceContext?: unknown;
  provenanceSources?: unknown;
};

export type PublicGroundingResult = {
  sourceRefs: ReturnType<typeof deriveSourceRefs>;
  sourceContext: GroundingContext;
  confidence: number;
  status: PublicGroundingStatus | null;
};

export type PublicationGroundingResult = {
  sourceRefs: ReturnType<typeof deriveSourceRefs>;
  groundingStatus: PublicGroundingStatus;
  publishableWithoutOverride: boolean;
  reviewStatus: PublicationReviewStatus;
  reason: string;
};

function numericConfidence(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deriveStatus(summary: ReturnType<typeof summarizeSourceGrounding>, confidence: number): PublicGroundingStatus {
  if (summary.corroborated && confidence >= 0.75) return "grounded";
  if (summary.refCount >= 1) return "partially_grounded";
  return "provisional";
}

function buildGroundingNote(status: PublicGroundingStatus, summary: ReturnType<typeof summarizeSourceGrounding>): string {
  switch (status) {
    case "grounded":
      return `This public node is backed by ${summary.refCount} source references across ${summary.originCount} distinct origin${summary.originCount === 1 ? "" : "s"} and can serve as a stable truth anchor.`;
    case "partially_grounded":
      return `This public node has ${summary.refCount} source reference${summary.refCount === 1 ? "" : "s"} across ${summary.originCount} origin${summary.originCount === 1 ? "" : "s"} and should be treated as constrained guidance.`;
    default:
      return "This public node has no source references yet and is explicitly provisional until corroborated.";
  }
}

export function evaluatePublicGrounding(input: EvaluatePublicGroundingInput): PublicGroundingResult {
  const baseContext = parseJsonField<GroundingContext>(input.sourceContext) ?? {};
  const sourceRefs = deriveSourceRefs({
    existing: input.sourceRefs,
    sourceContext: baseContext,
    provenanceSources: input.provenanceSources,
  });
  const groundingSummary = summarizeSourceGrounding(sourceRefs);
  const confidence = numericConfidence(input.confidence);

  if (input.spaceId !== "global" || input.visibility !== "public") {
    return {
      sourceRefs,
      sourceContext: baseContext,
      confidence,
      status: null,
    };
  }

  const status = deriveStatus(groundingSummary, confidence);
  const adjustedConfidence = status === "provisional" ? Math.min(confidence, 0.74) : confidence;

  return {
    sourceRefs,
    confidence: adjustedConfidence,
    status,
    sourceContext: {
      ...baseContext,
      grounding: {
        policy: "public_durable_grounding_v1",
        status,
        source_ref_count: groundingSummary.refCount,
        origin_count: groundingSummary.originCount,
        corroborated: groundingSummary.corroborated,
        note: buildGroundingNote(status, groundingSummary),
      },
    },
  };
}

export function assessPublicationGrounding(input: Omit<EvaluatePublicGroundingInput, "spaceId" | "visibility" | "confidence">): PublicationGroundingResult {
  const sourceRefs = deriveSourceRefs({
    existing: input.sourceRefs,
    sourceContext: input.sourceContext,
    provenanceSources: input.provenanceSources,
  });
  const groundingSummary = summarizeSourceGrounding(sourceRefs);
  const groundingStatus: PublicGroundingStatus = groundingSummary.corroborated
    ? "grounded"
    : groundingSummary.refCount >= 1
      ? "partially_grounded"
      : "provisional";

  if (groundingStatus === "provisional") {
    return {
      sourceRefs,
      groundingStatus,
      publishableWithoutOverride: false,
      reviewStatus: "needs_grounding",
      reason: "This candidate has no usable source references. Add grounding or publish explicitly as provisional.",
    };
  }

  return {
    sourceRefs,
    groundingStatus,
    publishableWithoutOverride: true,
    reviewStatus: "ready_to_publish",
    reason: groundingStatus === "grounded"
      ? "This candidate has strong source grounding for public publication."
      : "This candidate has minimal source grounding and can publish, but should still be treated as constrained guidance.",
  };
}

export async function refreshPublicNodeGrounding(tx: any, addr: string): Promise<PublicGroundingResult | null> {
  const [row] = await tx`
    SELECT addr, space_id, visibility, confidence, source_refs, source_context
    FROM nodes
    WHERE addr = ${addr}
      AND visibility <> 'deleted'
    LIMIT 1
  `;
  if (!row) return null;

  const grounded = evaluatePublicGrounding({
    spaceId: row.space_id,
    visibility: row.visibility,
    confidence: row.confidence,
    sourceRefs: row.source_refs,
    sourceContext: row.source_context,
  });

  const updatedRows = await tx`
    UPDATE nodes
    SET confidence = ${grounded.confidence},
        source_refs = ${tx.json(grounded.sourceRefs)},
        source_context = ${tx.json(grounded.sourceContext)},
        updated_at = NOW()
    WHERE addr = ${addr}
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  if (updatedRows.length === 0) return null;

  return grounded;
}
