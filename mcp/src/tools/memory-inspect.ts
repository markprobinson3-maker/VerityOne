/**
 * Tool: vo_memory_inspect -> GET /memory/:addr/audit
 *
 * Compact read-only audit snapshot: identity, trust state, provenance,
 * promotion linkage, approval metadata, and recent lifecycle events.
 * Thin passthrough per contract rung 5.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .describe("Canonical memory address, e.g. PJ.0.3.512"),
  event_limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum recent events to include (default 10)."),
};

export const memoryInspectTool: ToolDefinition<typeof inputShape> = {
  name: "vo_memory_inspect",
  description:
    "Compact audit snapshot for a single memory: trust state, provenance, promotion linkage, approval metadata, and recent lifecycle events. Read-only.",
  inputShape,
  async handler(client, args) {
    const addr = String(args.addr);
    const eventLimit = args.event_limit ? Number(args.event_limit) : undefined;
    const qs = eventLimit ? `?limit=${eventLimit}` : "";
    const result = await client.get<unknown>(
      `/memory/${encodeURIComponent(addr)}/audit${qs}`,
    );
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
