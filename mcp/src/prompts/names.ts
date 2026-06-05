/**
 * Zero-dependency list of prompt names. Paired with a drift guard
 * in `prompts/index.test.ts`.
 */
export const PROMPT_NAMES = [
  "vo_recall_context",
  "vo_what_do_we_know_about",
  "vo_remember_decision",
] as const;
