/**
 * Tool: vo_day_journal_day_get -> GET /day-journal/day/:addr
 *
 * Local-only day-journal read surface. Hosted/web MCP has a separate mirrored
 * day read and must not call local authority routes directly.
 */

import {
  dayJournalDayAddrSchema,
  dayJournalErrorEnvelope,
  strictDayJournalInputSchema,
  tenantIdSchema,
  withQuery,
} from "./day-journal-common.js";
import { okEnvelope, type ToolDefinition } from "./types.js";

const dayGetInputShape = {
  day_addr: dayJournalDayAddrSchema.describe("TMP.YYYY.DDD day address to read."),
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
};

export const dayJournalDayGetTool: ToolDefinition<typeof dayGetInputShape> = {
  name: "vo_day_journal_day_get",
  description:
    "Read one local day-journal day by TMP day address. Returns local-authority entries filtered by the local route's tenant and sensitivity policy.",
  inputShape: dayGetInputShape,
  inputSchema: strictDayJournalInputSchema(dayGetInputShape),
  async handler(client, args) {
    const pathname = withQuery(
      `/day-journal/day/${encodeURIComponent(String(args.day_addr))}`,
      { tenant_id: args.tenant_id },
    );
    const result = await client.get<unknown>(pathname);
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
