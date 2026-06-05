/**
 * Prompt registry + SDK registration helper —
 * VO-MCP-RESOURCES-PROMPTS-PR-1.
 *
 * Mirrors the shape of `tools/index.ts` and `resources/index.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PROMPT_NAMES as NAMES_CONST } from "./names.js";
import { voRecallContextPrompt } from "./recall-context.js";
import { voRememberDecisionPrompt } from "./remember-decision.js";
import { voWhatDoWeKnowAboutPrompt } from "./what-do-we-know-about.js";
import type { PromptDefinition } from "./types.js";

/** Authoritative runtime list. Order influences only `prompts/list`
 *  output, not behavior. */
export const PROMPTS: PromptDefinition[] = [
  voRecallContextPrompt,
  voWhatDoWeKnowAboutPrompt,
  voRememberDecisionPrompt,
];

// Drift-guard exports — paired with index.test.ts.
export const PROMPT_NAMES = NAMES_CONST;
export const DERIVED_PROMPT_NAMES = PROMPTS.map((p) => p.name);

/**
 * Register every PROMPTS entry with the SDK's McpServer. Prompt
 * handlers are pure: they do not call the local VO client, so no
 * VoClient dependency is needed here.
 */
export function registerPrompts(server: McpServer): void {
  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      // SDK types the args generically; each handler's argsSchema
      // narrows them. Cast is safe because the SDK validates args
      // against argsSchema before invoking the callback.
      async (args) =>
        prompt.handler(args as never),
    );
  }
}
