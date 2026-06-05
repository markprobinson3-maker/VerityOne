import { z } from "zod";

export const NodeVariantCreateSchema = z.object({
  description: z.string().min(20),
  context: z.string().optional(),
  weight: z.unknown().optional(),
}).passthrough();
