/**
 * Tool: vo_day_journal_entry_retract → POST /day-journal/entries/:entry_key/retract
 *
 * Local-only manual VOJ retraction surface. Hosted/web MCP must not register
 * this direct writer in Rung 1.
 */

import { z } from "zod";
import {
  dayJournalErrorEnvelope,
  idempotencyKeySchema,
  strictDayJournalInputSchema,
  tenantIdSchema,
} from "./day-journal-common.js";
import { okEnvelope, type ToolDefinition } from "./types.js";

const retractInputShape = {
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
  entry_key: z
    .string()
    .regex(/^entry_[0-9]{8}_[a-f0-9]{16}$/)
    .describe("Manual VOJ entry key to retract."),
  idempotency_key: idempotencyKeySchema
    .describe("Required idempotency key for this retraction request."),
  reason: z
    .string()
    .max(512)
    .refine((value) => !value.includes("\0"), {
      message: "reason must not contain NUL bytes.",
    })
    .optional()
    .describe("Optional audit-safe reason for the retraction."),
};

export const dayJournalEntryRetractTool: ToolDefinition<typeof retractInputShape> = {
  name: "vo_day_journal_entry_retract",
  description:
    "Retract a local manual day-journal entry by entry_key. Retraction preserves audit metadata and tombstones the hosted mirror through the local sync path.",
  inputShape: retractInputShape,
  inputSchema: strictDayJournalInputSchema(retractInputShape),
  async handler(client, args) {
    const body: Record<string, unknown> = {
      idempotency_key: args.idempotency_key,
    };
    if (args.tenant_id !== undefined) body.tenant_id = args.tenant_id;
    if (typeof args.reason === "string") body.reason = args.reason;

    const result = await client.post<unknown>(
      `/day-journal/entries/${encodeURIComponent(String(args.entry_key))}/retract`,
      body,
    );
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
