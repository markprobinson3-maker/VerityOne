/**
 * Tool: vo_memory_review -> GET /memory/review
 *
 * Read-only discovery surface: active tenant-local agent_inferred memories
 * pending human review. Thin passthrough per contract rung 5.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum items to return (default 20)."),
};

export const memoryReviewTool: ToolDefinition<typeof inputShape> = {
  name: "vo_memory_review",
  description:
    "List active tenant memories pending human review. Read-only — does not change any memory state. Items include overlay_origin visibility where applicable.",
  inputShape,
  async handler(client, args) {
    const limit = args.limit ? Number(args.limit) : undefined;
    const qs = limit ? `?limit=${limit}` : "";
    const result = await client.get<unknown>(`/memory/review${qs}`);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
