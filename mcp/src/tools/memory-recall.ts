/**
 * Tool: vo_memory_recall → POST /memory/recall
 *
 * Thin passthrough. Authoritative shape: api/src/lib/recall-compiler.ts#RecallResult.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const MEMORY_KINDS = [
  "decision",
  "preference",
  "correction",
  "context",
  "pattern",
  "vision",
  "changelog",
  "digest",
] as const;

export const recallInputShape = {
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe("Natural language recall query."),
  kinds: z
    .array(z.enum(MEMORY_KINDS))
    .optional()
    .describe("Optional filter on memory kinds."),
  project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe("Optional filter: memories associated with a tenant project root."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of primary memories (default backend-determined)."),
  include_inactive: z
    .boolean()
    .optional()
    .describe("If true, include superseded/retracted memories."),
};

/** Shared body-builder used by both plain and routed recall. */
export function buildRecallBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { query: String(args.query) };
  if (Array.isArray(args.kinds)) body.kinds = args.kinds;
  if (typeof args.project_addr === "string") body.project_addr = args.project_addr;
  if (typeof args.limit === "number") body.limit = args.limit;
  if (typeof args.include_inactive === "boolean") body.include_inactive = args.include_inactive;
  return body;
}

export const memoryRecallTool: ToolDefinition<typeof recallInputShape> = {
  name: "vo_memory_recall",
  description:
    "Recall tenant memories matching a natural-language query. Uses the canonical recall compiler with scoring by relevance, freshness, provenance, and conflict-freeness.",
  inputShape: recallInputShape,
  async handler(client, args) {
    const result = await client.post<unknown>("/memory/recall", buildRecallBody(args));
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
