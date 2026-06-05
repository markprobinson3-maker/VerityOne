/**
 * Tool: vo_memory_get → GET /memory/:addr
 *
 * Thin passthrough. 404 is passed through as validation_failure per contract
 * (the client layer already maps 404 → validation_failure globally).
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .describe("Canonical memory address, e.g. PJ.0.3.512"),
};

export const memoryGetTool: ToolDefinition<typeof inputShape> = {
  name: "vo_memory_get",
  description: "Fetch a single tenant memory by its canonical address.",
  inputShape,
  async handler(client, args) {
    const addr = String(args.addr);
    // Defensive: never interpolate user input into a URL without encoding.
    const result = await client.get<unknown>(`/memory/${encodeURIComponent(addr)}`);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
