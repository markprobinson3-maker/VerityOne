/**
 * Shared types for MCP prompt handlers —
 * VO-MCP-RESOURCES-PROMPTS-PR-1.
 *
 * Prompts are LLM-facing guidance that instructs the agent to use
 * existing vo-mcp tools. They are READ-ONLY by contract and
 * MUST NOT:
 *   - talk to the local VO (they never call client.get/post)
 *   - mutate any state
 *   - fabricate memory contents
 *   - assume tool outputs
 * A prompt produces a deterministic `PromptResult` from its args;
 * the real work is still a tool call the agent decides to make.
 */
import type { ZodRawShape, z } from "zod";

export type PromptMessageRole = "user" | "assistant";

export interface PromptMessage {
  role: PromptMessageRole;
  content: { type: "text"; text: string };
  [key: string]: unknown;
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
  [key: string]: unknown;
}

export interface PromptDefinition<Shape extends ZodRawShape = ZodRawShape> {
  /** Wire name registered with MCP. snake_case per contract. */
  name: string;
  /** Short human title. */
  title: string;
  /** Description shown to the agent in prompts/list. */
  description: string;
  /** Zod raw shape for argsSchema (not a z.object). */
  argsSchema: Shape;
  /** Thin pure handler: args in, PromptResult out. No I/O. */
  handler(args: z.infer<z.ZodObject<Shape>>): PromptResult;
}

/** Convenience: build a single-user-message result. */
export function userPrompt(
  description: string,
  text: string,
): PromptResult {
  return {
    description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}
