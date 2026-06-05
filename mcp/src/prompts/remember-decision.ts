/**
 * Prompt: vo_remember_decision
 *
 * Guides an agent to save a durable decision to tenant memory via
 * `vo_memory_write`. The prompt never issues the write itself —
 * MCP prompts don't call tools. It encodes the write-safety rules
 * the `vo_memory_write` tool enforces anyway, surfaced here so the
 * agent doesn't produce an input the tool will reject.
 */
import { z } from "zod";
import { userPrompt, type PromptDefinition } from "./types.js";

const argsSchema = {
  decision: z
    .string()
    .min(1)
    .max(4000)
    .describe("The decision being remembered. Concrete, actionable."),
  rationale: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Why this decision was made. Feeds into `why_it_matters` on the write.",
    ),
  subject: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Optional short subject line. When absent, the agent may let the server derive one from the decision.",
    ),
  project: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe(
      "Optional project addr the decision belongs to. When set, the write should include `bootstrap_context` from a recent `vo_pretask_ground` call against this project.",
    ),
};

export const voRememberDecisionPrompt: PromptDefinition<typeof argsSchema> = {
  name: "vo_remember_decision",
  title: "Remember a decision",
  description:
    "Write-safety guidance for recording a decision to tenant memory via vo_memory_write. Never invokes the tool; enforces source=user_accepted-only-with-explicit-intent, real source_refs or none, supersedes for revisions.",
  argsSchema,
  handler({ decision, rationale, subject, project }) {
    const subjectLine = subject
      ? `Use subject: ${JSON.stringify(subject)}.`
      : `Omit \`subject\` unless the user gave an explicit short label — the backend derives one from the decision text.`;
    const projectLine = project
      ? `This decision is project-scoped (${project}). Before writing, call \`vo_pretask_ground { goal: "save decision about: ${decision.slice(0, 80).replace(/"/g, '\\"')}…", explicit_project_addr: "${project}" }\` and pass the returned \`bootstrap_context\` into \`vo_memory_write.bootstrap_context\`. The canonical project-filter field on \`vo_pretask_ground\` is \`explicit_project_addr\`; do NOT pass a bare \`project_addr\`.`
      : `No project was specified. The write should NOT include a project_addr unless the user explicitly named one.`;

    const text =
      `The user wants to record this decision to tenant memory:\n\n` +
      `  decision:  ${decision}\n` +
      `  rationale: ${rationale}\n\n` +
      `${subjectLine}\n\n` +
      `${projectLine}\n\n` +
      `Call \`vo_memory_write\` with these rules:\n\n` +
      `  - \`kind\`: \"decision\"\n` +
      `  - \`assertion\`: the decision verbatim from above. Do not paraphrase.\n` +
      `  - \`why_it_matters\`: the rationale verbatim. Do not fabricate extra context.\n` +
      `  - \`source\`: default to \"agent_inferred\" unless the user in THIS turn explicitly said "save this" or equivalent, in which case use \"user_accepted\". Never pick \"user_accepted\" without explicit user intent.\n` +
      `  - \`source_refs\`: include ONLY real source addrs / links. If nothing to cite, omit the field; never fabricate a source.\n` +
      `  - If this decision revises an earlier one, set \`supersedes\` to that memory's addr. If it contradicts a retracted one, do NOT re-use the retracted addr — the backend rejects that.\n` +
      `  - If you just read a related memory via \`vo://memory/{addr}\` or \`vo_memory_get\` and the user agreed this decision replaces it, set \`supersedes\` accordingly.\n\n` +
      `Do NOT call \`vo_memory_write\` if any of these hold:\n` +
      `  - you are not sure the user intends to save the decision now,\n` +
      `  - the decision text is incomplete,\n` +
      `  - you would need to fabricate a subject, a source_ref, or a rationale detail.\n\n` +
      `After the write succeeds, cite the returned addr verbatim so the user can retract or supersede later.\n`;
    return userPrompt(
      `Save decision to tenant memory via vo_memory_write`,
      text,
    );
  },
};
