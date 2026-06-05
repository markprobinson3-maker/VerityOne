/**
 * Tool: vo_memory_search → POST /memory/recall  (thin alias)
 *
 * Per docs/VO-MCP-SERVER-CONTRACT.md, vo_memory_search is a one-ranking-path
 * alias over /memory/recall with a simpler query-only input. It exists purely
 * for agent discoverability — agents that scan tool lists for "search" find
 * it, and get the same canonical recall ranking.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe("Natural language search query."),
};

export const memorySearchTool: ToolDefinition<typeof inputShape> = {
  name: "vo_memory_search",
  description:
    "Free-text search across tenant memories. Thin alias for the canonical recall path — same ranking, simpler input.",
  inputShape,
  async handler(client, args) {
    const result = await client.post<unknown>("/memory/recall", { query: String(args.query) });
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
