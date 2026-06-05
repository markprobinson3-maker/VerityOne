/**
 * Prompt: vo_recall_context
 *
 * Guides an agent to ground a task against existing tenant memory
 * before acting. Prefers `vo_pretask_ground` when a project addr
 * is known (returns bootstrap_context that downstream writes can
 * ride on), else `vo_memory_recall_routed` for a focused recall.
 *
 * Invariants enforced by the prompt text:
 *   - do not invent memory contents
 *   - cite returned memory addrs verbatim
 *   - no writes from this prompt; if the user wants a new memory
 *     saved, use `vo_remember_decision` separately
 */
import { z } from "zod";
import { userPrompt, type PromptDefinition } from "./types.js";

const argsSchema = {
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe("Natural-language recall query / task statement."),
  project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe(
      "Optional tenant project addr (PJ.x.y.z). When set, prefer `vo_pretask_ground` for project-scoped grounding.",
    ),
};

export const voRecallContextPrompt: PromptDefinition<typeof argsSchema> = {
  name: "vo_recall_context",
  title: "Recall VO memory for a task",
  description:
    "Ground a task against existing tenant memory via vo_memory_recall_routed or vo_pretask_ground. Cites addrs verbatim and never invents memory contents.",
  argsSchema,
  handler({ query, project_addr }) {
    const projectLine = project_addr
      ? `A project addr was provided: \`${project_addr}\`. Prefer \`vo_pretask_ground { goal: <above>, explicit_project_addr: "${project_addr}" }\` so downstream writes can carry the returned \`bootstrap_context\`. The tool's canonical project-filter field is \`explicit_project_addr\` — not \`project_addr\`.`
      : "No project addr was provided. Use `vo_memory_recall_routed { query: <above> }` with no project filter.";
    const text =
      `You are about to work on this task:\n\n` +
      `    ${query}\n\n` +
      `Before acting, ground yourself against tenant memory.\n\n` +
      `${projectLine}\n\n` +
      `Rules:\n` +
      `  - Cite each referenced memory by its \`PJ.x.y.z\` addr verbatim from the tool response. Never paraphrase an addr.\n` +
      `  - Quote the \`assertion\` text verbatim when summarizing a memory. Do not rewrite it.\n` +
      `  - Never invent memory content. If the tool returns zero hits, say so plainly and continue without fabricated context.\n` +
      `  - This prompt does not write memory. If the user wants a decision saved, invoke \`vo_remember_decision\` as a separate step.\n`;
    return userPrompt(
      project_addr
        ? `Ground '${query}' via vo_pretask_ground (project ${project_addr})`
        : `Recall context for '${query}' via vo_memory_recall_routed`,
      text,
    );
  },
};
