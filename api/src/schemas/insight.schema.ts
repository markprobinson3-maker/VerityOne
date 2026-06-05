import { z } from "zod";

export const InsightRequestSchema = z.object({
  question: z.string().optional(),
  q: z.string().optional(),
  depth: z.enum(["fast", "quick", "deep"]).optional(),
  agent: z.string().optional(),
}).passthrough();
