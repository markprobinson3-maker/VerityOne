/**
 * Tool: vo_memory_forget → POST /memory/forget
 *
 * Archive a memory that is no longer relevant but was not incorrect.
 * Distinguished from retract: forget has no `reason` because there is
 * nothing wrong to explain. Use for cleanup of stale-but-correct
 * memories (expired session context, historical changelog entries).
 *
 * When there is a reason to record, use vo_memory_retract instead.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const forgetInputShape = {
  addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .describe("Canonical memory address to archive."),
};

export const memoryForgetTool: ToolDefinition<typeof forgetInputShape> = {
  name: "vo_memory_forget",
  description:
    "Archive a memory that is no longer relevant but was not incorrect. Use retract, not forget, whenever there is a reason to record.",
  inputShape: forgetInputShape,
  async handler(client, args) {
    const result = await client.post<unknown>("/memory/forget", { addr: args.addr });
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
