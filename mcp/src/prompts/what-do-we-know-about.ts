/**
 * Prompt: vo_what_do_we_know_about
 *
 * A focused recall workflow for a named subject. Narrower than
 * `vo_recall_context` — the subject alone carries the recall
 * intent, and no task framing is added. Useful when the user asks
 * "what do we know about X?"
 */
import { z } from "zod";
import { userPrompt, type PromptDefinition } from "./types.js";

const argsSchema = {
  subject: z
    .string()
    .min(1)
    .max(500)
    .describe("The subject / entity / topic to recall memories about."),
};

export const voWhatDoWeKnowAboutPrompt: PromptDefinition<typeof argsSchema> = {
  name: "vo_what_do_we_know_about",
  title: "What do we know about <subject>?",
  description:
    "Focused recall workflow for a named subject via vo_memory_search (exact) + vo_memory_recall_routed (semantic). Cites addrs and never fabricates memory contents.",
  argsSchema,
  handler({ subject }) {
    const text =
      `Task: answer "what do we know about ${JSON.stringify(subject)}?" against tenant memory.\n\n` +
      `Workflow:\n` +
      `  1. Call \`vo_memory_search { query: "${subject.replace(/"/g, '\\"')}" }\` for direct label / substance hits.\n` +
      `  2. Call \`vo_memory_recall_routed { query: "what do we know about ${subject.replace(/"/g, '\\"')}?" }\` for broader semantic hits.\n` +
      `  3. Merge the two result sets, de-duplicating by \`addr\`.\n` +
      `  4. For each memory you cite, output its \`addr\` verbatim and quote its \`assertion\` (or trimmed \`substance\`) directly. Do not paraphrase addrs.\n` +
      `  5. If both tools return zero hits, say "nothing recorded in tenant memory about ${subject.replace(/"/g, '\\"')}" and stop — do not fabricate.\n` +
      `  6. This prompt is read-only. If the user wants a new memory saved, separately invoke \`vo_remember_decision\`.\n`;
    return userPrompt(
      `Recall everything tenant memory knows about '${subject}'`,
      text,
    );
  },
};
