/**
 * Tool registry.
 *
 * Rung 1 (read-only, memory):   vo_bootstrap_project, vo_memory_recall,
 *                                vo_memory_recall_routed, vo_memory_get,
 *                                vo_memory_search
 * Rung 2 (write + composed):    vo_memory_write, vo_memory_update,
 *                                vo_memory_retract, vo_memory_forget,
 *                                vo_pretask_ground
 * Rung 3 (read-only, vault):    vo_vault_list, vo_vault_lookup
 * Rung 4 (read-only, public):   vo_public_search, vo_public_context
 * Rung 5 (read-only, review):   vo_memory_review, vo_memory_inspect
 * Rung 6 (overlay promotion):   vo_overlay_promote
 * Rung 7 (vault harvest write): vo_vault_harvest_auto
 * Day journal (local only):      vo_day_journal_entry_create,
 *                                vo_day_journal_entry_retract,
 *                                vo_day_journal_day_get,
 *                                vo_day_journal_search,
 *                                vo_day_journal_routines_list,
 *                                vo_day_journal_routine_dry_run,
 *                                vo_day_journal_routine_run
 *
 * Any new tool added here must have a corresponding section in
 * docs/VO-MCP-SERVER-CONTRACT.md first. The contract is binding input.
 */

import { TOOL_NAMES as NAMES_CONST } from "./names.js";
import { bootstrapProjectTool } from "./bootstrap-project.js";
import { dayJournalDayGetTool } from "./day-journal-day-get.js";
import { dayJournalEntryCreateTool } from "./day-journal-entry-create.js";
import { dayJournalEntryRetractTool } from "./day-journal-entry-retract.js";
import { dayJournalRoutineDryRunTool } from "./day-journal-routine-dry-run.js";
import { dayJournalRoutineRunTool } from "./day-journal-routine-run.js";
import { dayJournalRoutinesListTool } from "./day-journal-routines-list.js";
import { dayJournalSearchTool } from "./day-journal-search.js";
import { memoryForgetTool } from "./memory-forget.js";
import { memoryGetTool } from "./memory-get.js";
import { memoryInspectTool } from "./memory-inspect.js";
import { memoryRecallTool } from "./memory-recall.js";
import { memoryRecallRoutedTool } from "./memory-recall-routed.js";
import { memoryRetractTool } from "./memory-retract.js";
import { memoryReviewTool } from "./memory-review.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryUpdateTool } from "./memory-update.js";
import { memoryWriteTool } from "./memory-write.js";
import { overlayPromoteTool } from "./overlay-promote.js";
import { pretaskGroundTool } from "./pretask-ground.js";
import { publicContextTool } from "./public-context.js";
import { publicSearchTool } from "./public-search.js";
import type { ToolDefinition } from "./types.js";
import { vaultHarvestAutoTool } from "./vault-harvest-auto.js";
import { vaultListTool } from "./vault-list.js";
import { vaultLookupTool } from "./vault-lookup.js";

// Order matters only for tools/list output, not behavior. Grouped by rung,
// with composed tools listed after the primitives in their rung.
export const TOOLS: ToolDefinition[] = [
  // Rung 1 — memory read
  bootstrapProjectTool,
  memoryRecallTool,
  memoryRecallRoutedTool,
  memoryGetTool,
  memorySearchTool,
  // Rung 2 — memory write
  memoryWriteTool,
  memoryUpdateTool,
  memoryRetractTool,
  memoryForgetTool,
  // Rung 2 — composed grounding
  pretaskGroundTool,
  // Rung 3 — vault read
  vaultListTool,
  vaultLookupTool,
  // Rung 4 — public-overlay read (anonymous local calls)
  publicSearchTool,
  publicContextTool,
  // Rung 5 — review/audit read
  memoryReviewTool,
  memoryInspectTool,
  // Rung 6 — overlay promotion
  overlayPromoteTool,
  // Rung 7 — vault harvest write (narrow exception to rung-3 read-only rule)
  vaultHarvestAutoTool,
  // Day journal — local-only manual VOJ write/retract plus PR10 routine/read surface
  dayJournalEntryCreateTool,
  dayJournalEntryRetractTool,
  dayJournalDayGetTool,
  dayJournalSearchTool,
  dayJournalRoutinesListTool,
  dayJournalRoutineDryRunTool,
  dayJournalRoutineRunTool,
];

/**
 * Re-export the zero-dep name list as the authoritative `TOOL_NAMES`
 * for every consumer of this module. The runtime name list here —
 * derived from the actual tool modules — is exported separately as
 * `DERIVED_TOOL_NAMES` so a drift test (in-package, where zod is
 * available) can pin the two lists equal.
 *
 * Rationale: `doctor.ts` runs from `vo mcp doctor` under Bun where
 * `mcp/node_modules` is not guaranteed (fresh checkout, root
 * workspaces omit mcp). It needs just the names, not the schemas,
 * so it imports `./names.js` directly and never pulls this
 * zod-rooted module.
 */
export const TOOL_NAMES = NAMES_CONST;

/** Derived-from-code name list — exported for the drift test only.
 *  NEVER use this in doctor or other zero-dep consumers. */
export const DERIVED_TOOL_NAMES = TOOLS.map((t) => t.name);
