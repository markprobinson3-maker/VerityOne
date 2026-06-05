/**
 * Tool: vo_memory_write → POST /memory/write
 *
 * Thin passthrough. The backend is the single authority for validation,
 * source-link status, dedup, contradiction detection, auto-wiring,
 * lifecycle events, and supersession. This file must not reimplement any
 * of that.
 *
 * The ONE place rung 2 adds client-side validation per the binding contract:
 *   - source === "system_generated" is refused at the MCP layer with
 *     validation_failure, without any HTTP call. system_generated is
 *     reserved for server-side writers; MCP agent callers must use
 *     agent_inferred, agent_corrected, or user_accepted.
 *
 * Everything else (source_refs shape, bootstrap_context validity, project
 * existence, supersedes resolution) is backend-authoritative. MCP passes
 * through whatever the caller provides.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const MEMORY_KINDS = [
  "decision",
  "preference",
  "correction",
  "context",
  "pattern",
  "vision",
  "changelog",
  "digest",
] as const;

// All 4 backend-accepted source kinds are in the zod enum so the handler's
// refusal code path actually executes and returns the structured ErrorClass
// envelope. If we restricted the enum to the 3 agent-legal values, the SDK
// would reject system_generated at the schema layer with its own error
// shape — inconsistent with the contract's "refusal returns validation_failure"
// requirement.
const ALL_SOURCE_KINDS = [
  "user_accepted",
  "agent_corrected",
  "agent_inferred",
  "system_generated",
] as const;

const scopeEnum = ["session", "project", "tenant", "global"] as const;

const sourceRefShape = z
  .object({
    type: z
      .string()
      .min(1)
      .describe('Short source-kind tag, e.g. "doc", "pr", "issue", "url".'),
    path: z
      .string()
      .optional()
      .describe('Relative path to a file, e.g. "docs/VO-CURRENT-STATE.md".'),
    url: z.string().optional().describe("URL of the source document."),
  })
  .describe(
    "Each source_ref MUST include `type` AND at least one of `path` or `url`. " +
      "The backend validator rejects source_refs without either with a 400. " +
      "NEVER fabricate — omit the array entirely if no real source exists.",
  );

const bootstrapContextShape = z
  .object({
    project_addr: z.string().optional(),
    project_label: z.string().optional(),
    confidence: z.string().optional(),
    source: z.string().optional(),
    tenant_id: z.string().optional(),
    issued_at: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Opaque object from a recent vo_bootstrap_project or vo_pretask_ground call. " +
      "MCP passes this through verbatim — it MUST NOT be synthesized, rewritten, or refreshed.",
  );

const writeInputShape = {
  kind: z
    .enum(MEMORY_KINDS)
    .describe("Memory kind. Drives scoring priority and source-link expectations."),
  assertion: z
    .string()
    .min(1)
    .max(4000)
    .describe("The core fact being remembered. No fabrication, no filler."),
  source: z
    .enum(ALL_SOURCE_KINDS)
    .describe(
      "How this memory was created. Default to agent_inferred unless the user explicitly told you to save in this turn. " +
        'Never pick user_accepted without explicit user intent. "system_generated" is reserved for server-side writers and is refused at the MCP layer with validation_failure.',
    ),
  subject: z
    .string()
    .max(120)
    .optional()
    .describe("Short subject line (max 120 chars). Backend derives one from assertion if omitted."),
  why_it_matters: z
    .string()
    .optional()
    .describe("Why this memory will matter to future work. Optional. Never fabricate — omit if nothing honest to say."),
  evidence: z.string().optional().describe("Optional supporting context."),
  scope: z.enum(scopeEnum).optional(),
  effective_at: z.string().optional().describe("ISO-8601 timestamp; defaults to now."),
  expires_at: z.string().optional().describe("ISO-8601 timestamp; null means never."),
  supersedes: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe(
      "Addr of a memory this one supersedes. MUST be caller-supplied — never inferred by similarity.",
    ),
  tags: z.array(z.string()).optional(),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("0..1. Default 0.80 at backend. Set deliberately, not as a self-boost."),
  project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe(
      "Tenant project root this memory belongs to. Prefer bootstrap_context unless the user named a different project explicitly.",
    ),
  source_refs: z
    .array(sourceRefShape)
    .optional()
    .describe(
      "Real files or URLs that back this assertion. Include for decision, correction, pattern when a real source exists. NEVER fabricate.",
    ),
  bootstrap_context: bootstrapContextShape.optional(),
};

export const memoryWriteTool: ToolDefinition<typeof writeInputShape> = {
  name: "vo_memory_write",
  description:
    "Write a new tenant memory via the canonical write path. Backend handles embedding, dedup, contradiction detection, source-link status, auto-wiring, lifecycle events, and supersession. " +
      "Write-safety: default source=agent_inferred; include source_refs for decision/correction/pattern when a real source exists (never fabricate); pass bootstrap_context from a recent vo_pretask_ground call when writing project-scoped memory; use supersedes explicitly for material revisions.",
  inputShape: writeInputShape,
  async handler(client, args) {
    // MCP-layer refusal: the one place rung 2 adds client-side validation.
    // system_generated is reserved for server-side writers. Refuse before any
    // HTTP call so the backend never sees the attempt.
    if (args.source === "system_generated") {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "source 'system_generated' is reserved for server-side writers",
          "system_generated is not a legal value from MCP callers; use agent_inferred, agent_corrected, or user_accepted",
        ),
      );
    }

    // Build the body exactly from what the caller provided. No field
    // invention, no defaulting of source_refs, no bootstrap_context
    // synthesis — the backend is authoritative.
    const body: Record<string, unknown> = {
      kind: args.kind,
      assertion: args.assertion,
      source: args.source,
    };
    for (const key of [
      "subject",
      "why_it_matters",
      "evidence",
      "scope",
      "effective_at",
      "expires_at",
      "supersedes",
      "tags",
      "confidence",
      "project_addr",
      "source_refs",
      "bootstrap_context",
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const result = await client.post<unknown>("/memory/write", body);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
