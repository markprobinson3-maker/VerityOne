import { z } from "zod";

const AgentIdSchema = z.string().max(64).regex(/^[a-z0-9_:-]+$/i);

export const AgentSignalSchema = z.object({
  type: z.enum(["success", "failure", "query"]),
  // Bounded so an oversized payload is rejected before the handler joins `nodes` into a
  // string and passes the array to Postgres ANY(...) — mirrors RecallOutcomeSignalSchema.
  context: z.string().max(2000),
  agent: AgentIdSchema.optional(),
  nodes: z.array(z.unknown()).max(100).optional(),
}).passthrough();

export const RecallOutcomeSignalSchema = z.object({
  recall_id: z.string().uuid().refine((value) => value !== "00000000-0000-0000-0000-000000000000", "recall_id must be a real UUID"),
  outcome: z.enum([
    "used",
    "ignored",
    "supported_action",
    "confused",
    "contradicted",
    "wasted_context",
    "user_corrected",
    "missing_memory",
  ]),
  agent: AgentIdSchema.optional(),
  query: z.string().max(500).optional(),
  context: z.string().max(1000).optional(),
  memories: z.array(z.string().min(1)).max(50).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const SignalRequestSchema = z.object({
  addr: z.string().optional(),
  slug: z.string().optional(),
  success: z.boolean(),
  agent: AgentIdSchema.optional(),
  agent_tier: z.string().optional(),
  context: z.string().optional(),
}).passthrough().refine((body) => Boolean(body.addr || body.slug), {
  message: "addr or slug required",
});
