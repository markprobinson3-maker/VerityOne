/**
 * Tool: vo_memory_update → POST /memory/update
 *
 * Thin passthrough. For typo-level / tag / expiry patches on still-true
 * memories. Material assertion corrections should use vo_memory_retract +
 * new vo_memory_write with an explicit supersedes, per the contract's
 * update vs retract vs forget rubric.
 *
 * Backend authority: api/src/routes/memory.ts and
 * api/src/lib/memory-contract.ts#validateUpdateRequest.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const updateInputShape = {
  addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .describe("Canonical memory address to patch."),
  assertion: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "Only for typo-level fixes. Material assertion changes should use retract + new write with explicit supersedes.",
    ),
  subject: z.string().max(120).optional(),
  why_it_matters: z.string().optional(),
  evidence: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Agents should NOT self-boost confidence on memories they themselves wrote. Reserved for user-driven corrections.",
    ),
  expires_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "ISO-8601 timestamp, or null to clear an existing expiry. Agents should NOT extend expiry on their own memories without explicit user intent; clearing expiry is allowed when the user asks.",
    ),
};

export const memoryUpdateTool: ToolDefinition<typeof updateInputShape> = {
  name: "vo_memory_update",
  description:
    "Patch a specific existing memory in place. Use for minor corrections (typos, added tags, legitimate expiry changes). " +
      "Prefer vo_memory_retract + new vo_memory_write for material assertion changes. " +
      "Backend re-embeds when assertion changes; this is transparent to MCP.",
  inputShape: updateInputShape,
  async handler(client, args) {
    const body: Record<string, unknown> = { addr: args.addr };
    for (const key of [
      "assertion",
      "subject",
      "why_it_matters",
      "evidence",
      "tags",
      "confidence",
      "expires_at",
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const result = await client.post<unknown>("/memory/update", body);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
