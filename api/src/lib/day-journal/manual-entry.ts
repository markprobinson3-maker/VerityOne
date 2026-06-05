import { buildDayAddr } from "@verity-one/graph-shape";
import {
  canonicalizeJournalRequest,
  deriveManualEntryKey,
  hashJournalRequest,
  parseExplicitVoCommand,
  type DayJournalEntrySensitivity,
  type DayJournalRoutineResult,
  type ReservedVoCommand,
} from "./validate";
import type { WriteDayJournalEntryInput } from "./writer";

export type ManualEntryErrorCode =
  | "invalid_request"
  | "payload_too_large"
  | "reserved_command"
  | "target_date_mismatch"
  | "future_target_date"
  | "validation_failed";

export interface ManualEntryError {
  ok: false;
  status: 400 | 413;
  code: ManualEntryErrorCode;
  error: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface ManualEntryCreateInput {
  command_text?: unknown;
  target_date?: unknown;
  day_addr?: unknown;
  target_timezone?: unknown;
  idempotency_key?: unknown;
}

export interface PreparedManualEntryCreate {
  ok: true;
  command_text: string;
  body: string;
  target_date: string;
  day_addr: string;
  target_timezone: string;
  sensitivity: "personal" | "standard";
  tags: string[];
  entry_key: string | null;
  target_path: string;
  request_hash: string;
  request_canonical_json: string;
  writer_input: WriteDayJournalEntryInput | null;
}

export interface ManualEntryRetractInput {
  entry_key?: unknown;
  idempotency_key?: unknown;
  reason?: unknown;
}

export interface PreparedManualEntryRetract {
  ok: true;
  entry_key: string;
  reason?: string;
  request_hash: string;
  request_canonical_json: string;
  writer_input: WriteDayJournalEntryInput;
}

export interface PrepareManualEntryContext {
  tenantId: string;
  spaceId: string;
  actor?: string | null;
  defaultTimezone?: string | null;
  now?: Date;
}

const DAY_ADDR_RE = /^TMP\.([0-9]{4})\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEY_RE = /^entry_[0-9]{8}_[a-f0-9]{16}$/;
const MANUAL_ROUTINE_ID = "manual.tenant_entry";
const MANUAL_SCHEMA_ID = "manual_journal_entry_v1";
const MANUAL_IDEMPOTENCY_NAMESPACE = "manual_voj";
const RETRACT_IDEMPOTENCY_NAMESPACE = "manual_voj.retract";
const MAX_COMMAND_TEXT_CHARS = 16_384;
const MAX_SUMMARY_LINE_CHARS = 4000;
const MAX_REASON_CHARS = 512;

const RESERVED_HINTS: Record<ReservedVoCommand, string> = {
  VOR: "VOR is reserved for memory recall. Use the future VO recall route.",
  VOW: "VOW is reserved for durable memory writes. Use the memory write path.",
  VOP: "VOP is reserved for project memory insertion. Use the project memory path.",
  VOL: "VOL is reserved for list creation. Use the future VO list route.",
};

function error(
  code: ManualEntryErrorCode,
  message: string,
  opts: { hint?: string; details?: Record<string, unknown> } = {},
): ManualEntryError {
  return {
    ok: false,
    status: code === "payload_too_large" ? 413 : 400,
    code,
    error: message,
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.details ? { details: opts.details } : {}),
  };
}

function normalizeTimezone(value: unknown, fallback: string | null | undefined): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError("target_timezone must be a string.");
  }
  const raw = typeof value === "string" ? value : fallback || "UTC";
  const tz = raw.normalize("NFC").trim() || "UTC";
  if (tz.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(tz)) {
    throw new TypeError("target_timezone must be a bounded IANA time zone string.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
  } catch {
    throw new TypeError("target_timezone must be a valid IANA time zone.");
  }
  return tz;
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function targetDateToDayAddr(targetDate: string): string {
  if (!isValidIsoDate(targetDate)) {
    throw new TypeError("target_date must be a real YYYY-MM-DD date.");
  }
  const [year, month, day] = targetDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  const doy = Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
  return buildDayAddr(year, doy);
}

function dayAddrToTargetDate(dayAddr: string): string {
  const match = dayAddr.match(DAY_ADDR_RE);
  if (!match) throw new TypeError("day_addr must match canonical TMP.YYYY.DDD with DDD in 001-366.");
  const year = Number(match[1]);
  const doy = Number(match[2]);
  const date = new Date(Date.UTC(year, 0, doy));
  if (date.getUTCFullYear() !== year || buildDayAddr(year, doy) !== dayAddr) {
    throw new TypeError("day_addr must refer to a real calendar day.");
  }
  return date.toISOString().slice(0, 10);
}

function normalizeOptionalDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isValidIsoDate(value)) {
    throw new TypeError(`${name} must be a real YYYY-MM-DD date.`);
  }
  return value;
}

function normalizeOptionalDayAddr(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("day_addr must be a string.");
  dayAddrToTargetDate(value);
  return value;
}

function normalizeIdempotencyKey(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError("idempotency_key is required.");
    return null;
  }
  if (typeof value !== "string") throw new TypeError("idempotency_key must be a string.");
  const trimmed = value.normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError("idempotency_key must be a bounded non-empty string without NUL bytes.");
  }
  return trimmed;
}

function truncateCodePoints(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function resolveManualTarget(input: {
  parsedTargetDate?: string;
  bodyTargetDate: string | null;
  bodyDayAddr: string | null;
  timezone: string;
  now: Date;
}): { ok: true; targetDate: string; dayAddr: string } | ManualEntryError {
  if (input.parsedTargetDate && input.bodyTargetDate && input.parsedTargetDate !== input.bodyTargetDate) {
    return error("target_date_mismatch", "VOJ --date and body target_date refer to different days.");
  }

  const targetDate = input.parsedTargetDate
    || input.bodyTargetDate
    || (input.bodyDayAddr ? dayAddrToTargetDate(input.bodyDayAddr) : dateInTimezone(input.now, input.timezone));
  const dayAddr = targetDateToDayAddr(targetDate);

  if (input.bodyDayAddr && input.bodyDayAddr !== dayAddr) {
    return error("target_date_mismatch", "VOJ target date and body day_addr refer to different days.");
  }

  const today = dateInTimezone(input.now, input.timezone);
  if (targetDate > today) {
    return error("future_target_date", "Manual VOJ target_date cannot be in the future.", {
      hint: "Use today's date or an operator-only backfill path.",
      details: { target_date: targetDate, today, target_timezone: input.timezone },
    });
  }

  return { ok: true, targetDate, dayAddr };
}

function canonicalRequestHash(tenantId: string, request: Record<string, unknown>): {
  canonical: string;
  hash: string;
} {
  const canonical = canonicalizeJournalRequest(request);
  return { canonical, hash: hashJournalRequest(tenantId, canonical) };
}

export function prepareManualJournalEntryCreate(
  input: ManualEntryCreateInput,
  context: PrepareManualEntryContext,
  opts: { dryRun?: boolean } = {},
): PreparedManualEntryCreate | ManualEntryError {
  try {
    if (typeof input.command_text !== "string") {
      return error("invalid_request", "command_text is required.");
    }
    if (input.command_text.includes("\0")) {
      return error("invalid_request", "command_text must not contain NUL bytes.");
    }
    if (input.command_text.length > MAX_COMMAND_TEXT_CHARS) {
      return error("payload_too_large", "command_text must be <= 16384 characters without NUL bytes.");
    }
    const parsed = parseExplicitVoCommand(input.command_text);
    if (parsed.kind === "reserved") {
      return error("reserved_command", `${parsed.command} is reserved.`, {
        hint: RESERVED_HINTS[parsed.command],
        details: { command: parsed.command },
      });
    }
    if (parsed.kind === "unknown") {
      return error("invalid_request", "command_text must begin with an explicit VOJ command.");
    }
    if (parsed.kind === "invalid") {
      return error(parsed.code === "body_too_large" ? "payload_too_large" : "validation_failed", parsed.error, {
        details: { command_code: parsed.code },
      });
    }

    const targetTimezone = normalizeTimezone(input.target_timezone, context.defaultTimezone);
    const bodyTargetDate = normalizeOptionalDate(input.target_date, "target_date");
    const bodyDayAddr = normalizeOptionalDayAddr(input.day_addr);
    const now = context.now || new Date();
    const resolved = resolveManualTarget({
      parsedTargetDate: parsed.options.target_date,
      bodyTargetDate,
      bodyDayAddr,
      timezone: targetTimezone,
      now,
    });
    if (!resolved.ok) return resolved;

    const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key, opts.dryRun !== true);
    const entryKey = idempotencyKey
      ? deriveManualEntryKey(context.tenantId, resolved.targetDate, idempotencyKey)
      : null;
    const targetPath = entryKey ? `journal.manual.entries.${entryKey}` : "journal.manual.entries";

    const request = {
      kind: "manual_voj",
      command_text: parsed.raw,
      target_date: resolved.targetDate,
      day_addr: resolved.dayAddr,
      target_timezone: targetTimezone,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      sensitivity: parsed.options.sensitivity,
      tags: parsed.options.tags,
      body: parsed.body,
    };
    const { canonical, hash } = canonicalRequestHash(context.tenantId, request);

    const result: DayJournalRoutineResult | null = entryKey
      ? {
          ok: true,
          routine_id: MANUAL_ROUTINE_ID,
          schema: MANUAL_SCHEMA_ID,
          target_path: targetPath,
          captured_at: now.toISOString(),
          session_date: resolved.targetDate,
          status: "ok",
          summary_line: truncateCodePoints(parsed.body, MAX_SUMMARY_LINE_CHARS),
          tags: parsed.options.tags,
          payload: {
            text: parsed.body,
            entered_via: "VOJ",
            command_text: parsed.raw,
          },
          source_refs: [],
        }
      : null;

    const writerInput: WriteDayJournalEntryInput | null = opts.dryRun !== true && result && idempotencyKey
      ? {
          tenantId: context.tenantId,
          spaceId: context.spaceId,
          targetDate: resolved.targetDate,
          dayAddr: resolved.dayAddr,
          targetTimezone,
          result,
          actor: context.actor || "day-journal-route",
          idempotencyKey,
          idempotencyNamespace: MANUAL_IDEMPOTENCY_NAMESPACE,
          requestHash: hash,
          requestCanonicalJson: canonical,
          requestKind: "manual_voj",
          sensitivity: parsed.options.sensitivity as DayJournalEntrySensitivity,
          routineClass: "context_only",
          mutationKind: "create",
        }
      : null;

    return {
      ok: true,
      command_text: parsed.raw,
      body: parsed.body,
      target_date: resolved.targetDate,
      day_addr: resolved.dayAddr,
      target_timezone: targetTimezone,
      sensitivity: parsed.options.sensitivity,
      tags: parsed.options.tags,
      entry_key: entryKey,
      target_path: targetPath,
      request_hash: hash,
      request_canonical_json: canonical,
      writer_input: writerInput,
    };
  } catch (e) {
    return error("validation_failed", e instanceof Error ? e.message : String(e));
  }
}

export function prepareManualJournalEntryRetract(
  input: ManualEntryRetractInput,
  context: PrepareManualEntryContext,
): PreparedManualEntryRetract | ManualEntryError {
  try {
    if (typeof input.entry_key !== "string" || !ENTRY_KEY_RE.test(input.entry_key)) {
      return error("invalid_request", "entry_key must be a manual day-journal entry key.");
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key, true)!;
    let reason: string | undefined;
    if (input.reason !== undefined && input.reason !== null && input.reason !== "") {
      if (typeof input.reason !== "string") throw new TypeError("reason must be a string.");
      const normalizedReason = input.reason.normalize("NFC").trim();
      if (normalizedReason.includes("\0")) throw new TypeError("reason must not contain NUL bytes.");
      if (normalizedReason.length > MAX_REASON_CHARS) {
        throw new TypeError(`reason must be <= ${MAX_REASON_CHARS} characters without NUL bytes.`);
      }
      reason = normalizedReason;
    }
    const request = {
      kind: "manual_voj_retract",
      entry_key: input.entry_key,
      idempotency_key: idempotencyKey,
      ...(reason ? { reason } : {}),
    };
    const { canonical, hash } = canonicalRequestHash(context.tenantId, request);
    return {
      ok: true,
      entry_key: input.entry_key,
      ...(reason ? { reason } : {}),
      request_hash: hash,
      request_canonical_json: canonical,
      writer_input: {
        tenantId: context.tenantId,
        spaceId: context.spaceId,
        entryKey: input.entry_key,
        actor: context.actor || "day-journal-route",
        idempotencyKey,
        idempotencyNamespace: RETRACT_IDEMPOTENCY_NAMESPACE,
        requestHash: hash,
        requestCanonicalJson: canonical,
        requestKind: "manual_voj",
        mutationKind: "retract",
      },
    };
  } catch (e) {
    return error("validation_failed", e instanceof Error ? e.message : String(e));
  }
}
