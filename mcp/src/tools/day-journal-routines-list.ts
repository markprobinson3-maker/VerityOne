/**
 * Tool: vo_day_journal_routines_list -> GET /day-journal/routines
 *
 * Local-only routine definition/settings read. This does not mutate scheduler
 * settings and does not claim hosted availability.
 */

import {
  dayJournalErrorEnvelope,
  strictDayJournalInputSchema,
  tenantIdSchema,
  withQuery,
} from "./day-journal-common.js";
import { okEnvelope, type ToolDefinition } from "./types.js";

const routinesListInputShape = {
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
};

export const dayJournalRoutinesListTool: ToolDefinition<typeof routinesListInputShape> = {
  name: "vo_day_journal_routines_list",
  description:
    "List local day-journal routine definitions plus this tenant's settings snapshot.",
  inputShape: routinesListInputShape,
  inputSchema: strictDayJournalInputSchema(routinesListInputShape),
  async handler(client, args) {
    const result = await client.get<unknown>(
      withQuery("/day-journal/routines", { tenant_id: args.tenant_id }),
    );
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
