/**
 * Tool: vo_day_journal_routine_run -> POST /day-journal/routines/:id/run
 *
 * Local-only run-now surface. Non-dry-run writes remain idempotency guarded by
 * the backend; hosted/web agents must queue a routine-run intent instead.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import {
  addDayJournalTargetConsistencyIssue,
  dayJournalDayAddrSchema,
  dayJournalErrorEnvelope,
  dayJournalRoutineIdSchema,
  dayJournalTargetConsistencyError,
  idempotencyKeySchema,
  isoDateSchema,
  strictDayJournalInputSchema,
  tenantIdSchema,
} from "./day-journal-common.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const routineRunInputShape = {
  routine_id: dayJournalRoutineIdSchema.describe("Dotted day-journal routine id."),
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
  target_date: isoDateSchema.optional(),
  day_addr: dayJournalDayAddrSchema.optional(),
  idempotency_key: idempotencyKeySchema
    .optional()
    .describe("Required unless generate_idempotency_key is true."),
  generate_idempotency_key: z.boolean().optional(),
};

const routineRunInputSchema = strictDayJournalInputSchema(routineRunInputShape).superRefine((value, ctx) => {
  addDayJournalTargetConsistencyIssue(value, ctx);
  if (value.generate_idempotency_key === true && value.idempotency_key !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["idempotency_key"],
      message: "Use idempotency_key or generate_idempotency_key, not both.",
    });
  }
  if (value.generate_idempotency_key !== true && value.idempotency_key === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["idempotency_key"],
      message: "idempotency_key is required unless generate_idempotency_key is true.",
    });
  }
});

function routineRunIdempotencyError(args: Record<string, unknown>) {
  if (args.generate_idempotency_key === true && args.idempotency_key !== undefined) {
    return errorEnvelope(
      buildErrorEnvelope(
        "validation_failure",
        "Use idempotency_key or generate_idempotency_key, not both.",
        "Send either idempotency_key or generate_idempotency_key=true for routine run-now calls.",
        "idempotency_key_conflict",
      ),
    );
  }
  if (args.generate_idempotency_key !== true && args.idempotency_key === undefined) {
    return errorEnvelope(
      buildErrorEnvelope(
        "validation_failure",
        "idempotency_key is required unless generate_idempotency_key is true.",
        "Provide idempotency_key or set generate_idempotency_key=true.",
        "idempotency_key_required",
      ),
    );
  }
  return null;
}

function routineRunValidationError(args: Record<string, unknown>) {
  return routineRunIdempotencyError(args) || dayJournalTargetConsistencyError(args);
}

export const dayJournalRoutineRunTool: ToolDefinition<typeof routineRunInputShape> = {
  name: "vo_day_journal_routine_run",
  description:
    "Run an enabled, registered local day-journal routine now. Use routine_ids returned by vo_day_journal_routines_list. Requires an idempotency_key unless generate_idempotency_key=true. Routines with non-standard sensitivity or extra permissions require operator scope.",
  inputShape: routineRunInputShape,
  inputSchema: routineRunInputSchema,
  validateArgs: routineRunValidationError,
  async handler(client, args) {
    const validationError = routineRunValidationError(args);
    if (validationError) return validationError;
    const body: Record<string, unknown> = {};
    for (const key of [
      "tenant_id",
      "target_date",
      "day_addr",
      "idempotency_key",
      "generate_idempotency_key",
    ] as const) {
      if (key === "generate_idempotency_key" && args[key] !== true) continue;
      if (args[key] !== undefined) body[key] = args[key];
    }
    const result = await client.post<unknown>(
      `/day-journal/routines/${encodeURIComponent(String(args.routine_id))}/run`,
      body,
    );
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
