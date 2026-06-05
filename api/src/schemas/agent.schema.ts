import { z } from "zod";

export const AgentUpdateSchema = z.object({
  capabilities: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const AgentPolicyPatchSchema = z.record(z.string(), z.unknown());
