/**
 * F8: zod schema for /remember (legacy compat memory write).
 *
 * The route adapts a loose `{ description, label?, memory_type?, context? }`
 * payload into the canonical `MemoryWriteRequest`. F8 keeps the loose shape
 * (so existing clients keep working) but enforces the field types.
 */

import { z } from "zod";
import { MemoryKindSchema } from "../lib/memory-contract";

export const RememberRequestSchema = z.object({
  description: z.string().min(1, { message: "Required. The memory content to save." }).max(8000),
  label: z.string().max(120).optional(),
  memory_type: MemoryKindSchema.optional(),
  context: z.string().optional(),
});

export type RememberRequest = z.infer<typeof RememberRequestSchema>;

export const RememberQuerySchema = z.object({
  limit: z.string().optional(),
  q: z.string().optional(),
  type: z.string().optional(),
});

export type RememberQuery = z.infer<typeof RememberQuerySchema>;
