/**
 * Tool: vo_day_journal_search -> GET /day-journal/search
 *
 * Local-only normalized day-journal search. This is a thin adapter over the
 * local route; hosted/web MCP uses the hosted mirror read core instead.
 */

import { z } from "zod";
import {
  addDayJournalDateRangeIssue,
  DAY_JOURNAL_CONTROL_CHAR_RE,
  dayJournalDateRangeError,
  dayJournalErrorEnvelope,
  dayJournalLimitSchema,
  dayJournalOffsetSchema,
  dayJournalRoutineIdSchema,
  dayJournalSensitivitySchema,
  dayJournalTagSchema,
  isoDateSchema,
  journalDomainSchema,
  strictDayJournalInputSchema,
  tenantIdSchema,
  withQuery,
} from "./day-journal-common.js";
import { okEnvelope, type ToolDefinition } from "./types.js";

const searchInputShape = {
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
  limit: dayJournalLimitSchema,
  offset: dayJournalOffsetSchema,
  start_date: isoDateSchema.optional(),
  end_date: isoDateSchema.optional(),
  routine_id: dayJournalRoutineIdSchema.optional(),
  domain: journalDomainSchema.optional(),
  tag: dayJournalTagSchema.optional(),
  sensitivity: dayJournalSensitivitySchema.optional(),
  q: z
    .string()
    .max(1000)
    .refine((value) => !DAY_JOURNAL_CONTROL_CHAR_RE.test(value), {
      message: "q must not contain control characters.",
    })
    .optional(),
};

const searchInputSchema = strictDayJournalInputSchema(searchInputShape).superRefine(addDayJournalDateRangeIssue);

export const dayJournalSearchTool: ToolDefinition<typeof searchInputShape> = {
  name: "vo_day_journal_search",
  description:
    "Search local normalized day-journal entries by date range, routine, domain, tag, sensitivity, or preview text. Preview-text search is a case-insensitive substring match over normalized JSON preview text; responses can be large, so use narrow filters and pagination.",
  inputShape: searchInputShape,
  inputSchema: searchInputSchema,
  validateArgs: dayJournalDateRangeError,
  async handler(client, args) {
    const dateRangeError = dayJournalDateRangeError(args);
    if (dateRangeError) return dateRangeError;
    const result = await client.get<unknown>(
      withQuery("/day-journal/search", {
        tenant_id: args.tenant_id,
        limit: args.limit,
        offset: args.offset,
        start_date: args.start_date,
        end_date: args.end_date,
        routine_id: args.routine_id,
        domain: args.domain,
        tag: args.tag,
        sensitivity: args.sensitivity,
        q: args.q,
      }),
    );
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
