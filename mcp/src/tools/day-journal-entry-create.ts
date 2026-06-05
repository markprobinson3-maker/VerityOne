/**
 * Tool: vo_day_journal_entry_create → POST /day-journal/entries
 *
 * Local-only manual VOJ surface. Hosted/web MCP must use queued commands in
 * a later rung; this stdio tool talks only to the local VO node through
 * VoClient, like the rest of the local MCP package.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import {
  addDayJournalTargetConsistencyIssue,
  dayJournalDayAddrSchema,
  dayJournalErrorEnvelope,
  dayJournalTargetConsistencyError,
  idempotencyKeySchema,
  isoDateSchema,
  strictDayJournalInputSchema,
  targetTimezoneSchema,
  tenantIdSchema,
} from "./day-journal-common.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const createInputShape = {
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
  command_text: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => !value.includes("\0"), {
      message: "command_text must not contain NUL bytes.",
    })
    .describe(
      "Explicit VOJ command text, e.g. `VOJ: shipped the manual journal route`. Ordinary prose is refused.",
    ),
  target_date: isoDateSchema
    .optional()
    .describe("Optional YYYY-MM-DD target date. Must match VOJ --date when both are present."),
  day_addr: dayJournalDayAddrSchema
    .optional()
    .describe("Optional canonical day node address. Must match target_date/VOJ --date when present."),
  target_timezone: targetTimezoneSchema
    .optional()
    .describe("Optional IANA timezone used to resolve today's date when no explicit date is supplied."),
  idempotency_key: idempotencyKeySchema
    .optional()
    .describe("Required for non-dry-run writes. Omit only with dry_run=true."),
  dry_run: z
    .boolean()
    .optional()
    .describe("When true, validate/resolve the VOJ request without writing."),
};

const createInputSchema = strictDayJournalInputSchema(createInputShape).superRefine((value, ctx) => {
  addDayJournalTargetConsistencyIssue(value, ctx);
  if (value.dry_run !== true && value.idempotency_key === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["idempotency_key"],
      message: "idempotency_key is required unless dry_run is true.",
    });
  }
});

function createIdempotencyError(args: Record<string, unknown>) {
  if (args.dry_run !== true && args.idempotency_key === undefined) {
    return errorEnvelope(
      buildErrorEnvelope(
        "validation_failure",
        "idempotency_key is required unless dry_run is true.",
        "Provide idempotency_key or set dry_run=true.",
        "idempotency_key_required",
      ),
    );
  }
  return null;
}

function createValidationError(args: Record<string, unknown>) {
  return createIdempotencyError(args) || dayJournalTargetConsistencyError(args);
}

export const dayJournalEntryCreateTool: ToolDefinition<typeof createInputShape> = {
  name: "vo_day_journal_entry_create",
  description:
    "Create or dry-run a local manual day-journal entry from explicit VOJ command text. " +
      "Use dry_run=true to validate/resolve target date and entry key without writing. " +
      "Non-dry-run writes require idempotency_key and execute only against the local VO node.",
  inputShape: createInputShape,
  inputSchema: createInputSchema,
  validateArgs: createValidationError,
  async handler(client, args) {
    const validationError = createValidationError(args);
    if (validationError) return validationError;
    const body: Record<string, unknown> = {
      command_text: args.command_text,
    };
    for (const key of [
      "tenant_id",
      "target_date",
      "day_addr",
      "target_timezone",
      "idempotency_key",
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const endpoint = args.dry_run === true
      ? "/day-journal/entries/dry-run"
      : "/day-journal/entries";
    const result = await client.post<unknown>(endpoint, body);
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
