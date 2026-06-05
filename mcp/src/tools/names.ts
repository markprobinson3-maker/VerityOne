/**
 * Tool-name registry — the canonical list of rung-1…7 MCP tool names.
 *
 * Lives in its own module (with zero runtime deps) so `doctor.ts`
 * can import the name list without transitively pulling every tool
 * module — each of which imports `zod` from `mcp/node_modules`.
 *
 * VO-MCP-TENANT-DEFAULT-FIRST-RUN-PR-2 (follow-up): `vo mcp doctor`
 * runs from the main `vo` CLI under Bun. The repo's root workspaces
 * deliberately omit `mcp/`, so `mcp/node_modules` is absent after a
 * fresh `bun install`. If doctor imported `./tools/index.js` it
 * would pull `bootstrap-project.ts` → `zod` and crash on load. The
 * handshake + `tools/list` validation doctor performs only needs
 * the *name list*, not the zod schemas, so the name list is
 * extracted here as strings. `tools/index.ts` still re-exports
 * `TOOL_NAMES` from this file and owns the single source of truth
 * `TOOLS` array — a drift test there pins the two lists equal.
 *
 * Any new tool added to `tools/index.ts#TOOLS` MUST also be added
 * here in the correct rung slot. The drift test fails the build
 * if the two disagree.
 */

/** Order matters only for `tools/list` output, not behavior.
 *  Matches the order in `tools/index.ts#TOOLS` exactly. */
export const TOOL_NAMES = [
  // Rung 1 — memory read
  "vo_bootstrap_project",
  "vo_memory_recall",
  "vo_memory_recall_routed",
  "vo_memory_get",
  "vo_memory_search",
  // Rung 2 — memory write
  "vo_memory_write",
  "vo_memory_update",
  "vo_memory_retract",
  "vo_memory_forget",
  // Rung 2 — composed grounding
  "vo_pretask_ground",
  // Rung 3 — vault read
  "vo_vault_list",
  "vo_vault_lookup",
  // Rung 4 — public-overlay read (anonymous local calls)
  "vo_public_search",
  "vo_public_context",
  // Rung 5 — review/audit read
  "vo_memory_review",
  "vo_memory_inspect",
  // Rung 6 — overlay promotion
  "vo_overlay_promote",
  // Rung 7 — vault harvest write (narrow exception to rung-3 read-only rule)
  "vo_vault_harvest_auto",
  // Day journal — local-only manual VOJ write/retract plus PR10 routine/read surface
  "vo_day_journal_entry_create",
  "vo_day_journal_entry_retract",
  "vo_day_journal_day_get",
  "vo_day_journal_search",
  "vo_day_journal_routines_list",
  "vo_day_journal_routine_dry_run",
  "vo_day_journal_routine_run",
] as const;
