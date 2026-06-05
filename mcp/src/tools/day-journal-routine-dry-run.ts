/**
 * Tool: vo_day_journal_routine_dry_run -> POST /day-journal/routines/:id/dry-run
 *
 * Local-only routine preview. The backend owns permission checks and marker
 * updates; the MCP tool only validates the client-side argument shape.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import {
  addDayJournalTargetConsistencyIssue,
  dayJournalDayAddrSchema,
  dayJournalErrorEnvelope,
  dayJournalPermissionSchema,
  dayJournalRoutineIdSchema,
  dayJournalTargetConsistencyError,
  isoDateSchema,
  strictDayJournalInputSchema,
  targetTimezoneSchema,
  tenantIdSchema,
} from "./day-journal-common.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const routineDryRunInputShape = {
  routine_id: dayJournalRoutineIdSchema.describe("Dotted day-journal routine id."),
  tenant_id: tenantIdSchema
    .optional()
    .describe("Optional tenant override for operator tokens. Tenant-scoped agent tokens must omit or match this value."),
  target_date: isoDateSchema.optional(),
  day_addr: dayJournalDayAddrSchema.optional(),
  target_timezone: targetTimezoneSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  permission_grants: z
    .array(dayJournalPermissionSchema)
    .max(16)
    .refine((value) => new Set(value).size === value.length, {
      message: "permission_grants must not contain duplicates.",
    })
    .optional(),
};

const routineDryRunInputSchema = strictDayJournalInputSchema(routineDryRunInputShape).superRefine((value, ctx) => {
  addDayJournalTargetConsistencyIssue(value, ctx);
});

function duplicatePermissionGrantsError(args: Record<string, unknown>) {
  const grants = args.permission_grants;
  if (!Array.isArray(grants)) return null;
  if (new Set(grants).size === grants.length) return null;
  return errorEnvelope(
    buildErrorEnvelope(
      "validation_failure",
      "permission_grants must not contain duplicates.",
      "Send each permission grant at most once.",
      "duplicate_permission_grants",
    ),
  );
}

function routineDryRunValidationError(args: Record<string, unknown>) {
  return dayJournalTargetConsistencyError(args) || duplicatePermissionGrantsError(args);
}

export const dayJournalRoutineDryRunTool: ToolDefinition<typeof routineDryRunInputShape> = {
  name: "vo_day_journal_routine_dry_run",
  description:
    "Execute a registered local day-journal routine in dry-run mode. This does not write a journal entry, but it does run routine code, may perform declared external effects such as network calls, and updates the backend dry-run marker returned for enablement guardrails. Non-standard sensitivity or extra-permission routines require operator scope.",
  inputShape: routineDryRunInputShape,
  inputSchema: routineDryRunInputSchema,
  validateArgs: routineDryRunValidationError,
  async handler(client, args) {
    const validationError = routineDryRunValidationError(args);
    if (validationError) return validationError;
    const body: Record<string, unknown> = {};
    for (const key of [
      "tenant_id",
      "target_date",
      "day_addr",
      "target_timezone",
      "config",
      "permission_grants",
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const result = await client.post<unknown>(
      `/day-journal/routines/${encodeURIComponent(String(args.routine_id))}/dry-run`,
      body,
    );
    if (!result.ok) return dayJournalErrorEnvelope(result);
    return okEnvelope(result.body);
  },
};
