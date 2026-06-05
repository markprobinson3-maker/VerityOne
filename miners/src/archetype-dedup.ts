import { createHash } from "node:crypto";
import { EMBED_DOCUMENT_TASK_TYPE } from "@verity-one/embed";

export const ARCHETYPE_DEDUP_PURPOSE = "archetype_dedup";
export const ARCHETYPE_DEDUP_EMBEDDING_TASK_TYPE = EMBED_DOCUMENT_TASK_TYPE;
// Shared by the proposal embedding backfill and fallback archetype inserts so
// graph_state completion markers cannot race ahead of unembedded proposals.
export const PROPOSAL_EMBEDDING_BACKFILL_LOCK_NAMESPACE = 0x564f4609;
export const PROPOSAL_EMBEDDING_BACKFILL_LOCK_ID = 0x50524f50; // 'PROP'
export type ArchetypeBackfillMarkerInvalidationMode = "when_inserted" | "always";

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

export function archetypeCanonicalText(payload: unknown): string {
  const record = payloadRecord(payload);
  return typeof record.description === "string" ? record.description.trim() : "";
}

export function archetypeStablePayload(payload: unknown): { name: string; description: string; pyramids: string[] } {
  const record = payloadRecord(payload);
  return {
    name: typeof record.name === "string" ? record.name.trim() : "",
    description: typeof record.description === "string" ? record.description.trim() : "",
    pyramids: Array.isArray(record.pyramids)
      ? record.pyramids.map((pyramid) => String(pyramid).trim()).filter(Boolean)
      : [],
  };
}

export function pyramidJaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left.map((value) => String(value).trim()).filter(Boolean));
  const rightSet = new Set(right.map((value) => String(value).trim()).filter(Boolean));
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection++;
  }
  const union = new Set([...leftSet, ...rightSet]);
  // Both empty means there is no pyramid-side signal, so let cosine decide.
  if (union.size === 0) return 1;
  return intersection / union.size;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function archetypeSourcePayloadHash(payload: unknown): string {
  const stablePayload = archetypeStablePayload(payload);
  return sha256Hex(JSON.stringify({
    name: stablePayload.name,
    description: stablePayload.description,
    pyramids: stablePayload.pyramids,
  }));
}

export function modelAwareArchetypeBackfillMarkerKey(model: string, taskType: string): string {
  return `proposal_embeddings.${ARCHETYPE_DEDUP_PURPOSE}.${model}.${taskType}.backfill_completed_at`;
}

export function shouldInvalidateArchetypeBackfillMarkerAfterFallback(args: {
  inserted: boolean;
  mode?: ArchetypeBackfillMarkerInvalidationMode;
}): boolean {
  return args.mode === "always" || args.inserted;
}
