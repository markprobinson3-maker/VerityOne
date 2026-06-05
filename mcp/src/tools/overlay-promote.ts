/**
 * Tool: vo_overlay_promote -> POST /memory/promote-overlay
 *
 * Explicitly promote an imported public overlay into a new tenant-local
 * memory. The original overlay row stays unchanged. Promotion through MCP
 * always produces agent_inferred trust state -- it is NOT approval.
 *
 * Idempotent: if the overlay was already promoted, returns the existing
 * promoted memory address with already_promoted: true.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  overlay_addr: z
    .string()
    .min(1)
    .describe("Address of the overlay node to promote, e.g. OVL.0.0.abc123def456"),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Optional reason for promotion. Stored in promoted_from metadata."),
};

export const overlayPromoteTool: ToolDefinition<typeof inputShape> = {
  name: "vo_overlay_promote",
  description:
    "Explicitly promote an imported public overlay into a new tenant-local memory. " +
    "The promoted memory is always agent_inferred — this is NOT approval. " +
    "Use vo_memory_inspect to verify provenance after promotion, and vo memory approve (CLI) for human trust upgrade.",
  inputShape,
  async handler(client, args) {
    const body: Record<string, unknown> = { overlay_addr: args.overlay_addr };
    if (typeof args.reason === "string") body.reason = args.reason;

    const result = await client.post<unknown>("/memory/promote-overlay", body);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
