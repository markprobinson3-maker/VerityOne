/**
 * Tool: vo_memory_recall_routed → POST /memory/recall/routed
 *
 * Domain-aware recall. Same input shape as vo_memory_recall. Output adds a
 * `routing` trace and optional `split_results` for mixed-intent queries.
 * Authoritative shape: api/src/lib/domain-router.ts#RoutedRecallResult.
 */

import { buildErrorEnvelope } from "../errors.js";
import { buildRecallBody, recallInputShape } from "./memory-recall.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

export const memoryRecallRoutedTool: ToolDefinition<typeof recallInputShape> = {
  name: "vo_memory_recall_routed",
  description:
    "Domain-aware recall. Classifies query intent (ops/rollout/workspace/mixed), picks a first-pass domain, widens if results are weak, and returns a routing trace alongside the recall result.",
  inputShape: recallInputShape,
  async handler(client, args) {
    const result = await client.post<unknown>("/memory/recall/routed", buildRecallBody(args));
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
