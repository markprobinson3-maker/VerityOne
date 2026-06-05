/**
 * Tool: vo_memory_retract → POST /memory/retract
 *
 * Mark a memory as wrong and exclude it from default recall while
 * preserving it for audit. Use when the original assertion was incorrect,
 * misleading, or obsoleted by a correction.
 *
 * Strongly encourage a `reason` — the backend stores it in substance
 * and logs it into the retraction event for future contradiction surfaces.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const retractInputShape = {
  addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .describe("Canonical memory address to retract."),
  reason: z
    .string()
    .optional()
    .describe(
      "Short explanation of why this memory is wrong. Strongly encouraged — the reason flows into the event log and future contradiction surfaces. Retract without a reason is allowed by the backend but discouraged.",
    ),
};

export const memoryRetractTool: ToolDefinition<typeof retractInputShape> = {
  name: "vo_memory_retract",
  description:
    "Mark a memory as wrong and exclude it from default recall while preserving it for audit. " +
      "Prefer retract over forget whenever there is a reason to record. " +
      "Prefer retract over in-place update when the original assertion was wrong (silently updating a wrong assertion destroys audit trail).",
  inputShape: retractInputShape,
  async handler(client, args) {
    const body: Record<string, unknown> = { addr: args.addr };
    if (typeof args.reason === "string") body.reason = args.reason;

    const result = await client.post<unknown>("/memory/retract", body);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
