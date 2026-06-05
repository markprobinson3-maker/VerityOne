import { z } from "zod";

export const WatchCreateSchema = z.object({
  agent: z.string(),
  filter: z.string().max(256),
  watch_priority: z.enum(["standard", "critical"]).optional(),
}).passthrough();

export const WatchDeleteSchema = z.object({
  agent: z.string().optional(),
}).passthrough();
