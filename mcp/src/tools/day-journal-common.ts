import { z, type ZodRawShape } from "zod";
import { buildErrorEnvelope, type ErrorClass } from "../errors.js";
import type { VoCallErr } from "../vo-client.js";
import { errorEnvelope, type ToolResult } from "./types.js";

export const DAY_JOURNAL_DAY_ADDR_RE =
  /^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$/;
export const DAY_JOURNAL_ROUTINE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const DAY_JOURNAL_TAG_RE = /^[a-z0-9_-]{1,64}$/;
export const JOURNAL_DOMAIN_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const DAY_JOURNAL_CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRealDayAddr(value: string): boolean {
  if (!DAY_JOURNAL_DAY_ADDR_RE.test(value)) return false;
  const [, yearRaw, doyRaw] = value.split(".");
  const year = Number(yearRaw);
  const doy = Number(doyRaw);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return false;
  return doy <= (isLeapYear(year) ? 366 : 365);
}

function dayAddrForIsoDate(value: string): string | null {
  if (!isRealIsoDate(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  const doy = Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
  return `TMP.${String(year).padStart(4, "0")}.${String(doy).padStart(3, "0")}`;
}

function isIanaTimezone(value: string): boolean {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 128 || DAY_JOURNAL_CONTROL_CHAR_RE.test(normalized)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export const dayJournalDayAddrSchema = z.string().refine(isRealDayAddr, {
  message: "day_addr must be canonical TMP.YYYY.DDD and refer to a real day.",
});
export const dayJournalRoutineIdSchema = z.string().regex(DAY_JOURNAL_ROUTINE_ID_RE);
export const dayJournalTagSchema = z.string().regex(DAY_JOURNAL_TAG_RE);
export const journalDomainSchema = z.string().regex(JOURNAL_DOMAIN_RE);
export const isoDateSchema = z.string().refine(isRealIsoDate, {
  message: "date must be a real YYYY-MM-DD date.",
});
export const tenantIdSchema = z.string().regex(TENANT_ID_RE);
export const targetTimezoneSchema = z.string().refine(isIanaTimezone, {
  message: "target_timezone must be a bounded IANA timezone string.",
});

export const dayJournalLimitSchema = z.number().int().min(1).max(100).optional();
export const dayJournalOffsetSchema = z.number().int().min(0).max(10_000).optional();

export const dayJournalSensitivitySchema = z.enum([
  "standard",
  "personal",
  "health",
  "financial",
  "calendar",
  "email",
]);

export const dayJournalPermissionSchema = z.enum([
  "journal_write",
  "network",
  "local_files",
  "calendar",
  "email",
  "browser",
  "health",
  "finance",
  "llm",
]);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.normalize("NFC").trim().length > 0 && !value.includes("\0"), {
    message: "idempotency_key must be non-blank and must not contain NUL bytes.",
  });

export function strictDayJournalInputSchema<Shape extends ZodRawShape>(shape: Shape) {
  return z.object(shape).strict();
}

function hasTargetDateDayAddrMismatch(args: Record<string, unknown>): boolean {
  const targetDate = args.target_date;
  const dayAddr = args.day_addr;
  if (typeof targetDate !== "string" || typeof dayAddr !== "string") return false;
  if (!isRealDayAddr(dayAddr)) return false;
  const expectedDayAddr = dayAddrForIsoDate(targetDate);
  return expectedDayAddr !== null && expectedDayAddr !== dayAddr;
}

export function addDayJournalTargetConsistencyIssue(
  value: Record<string, unknown>,
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
): void {
  if (!hasTargetDateDayAddrMismatch(value)) return;
  ctx.addIssue({
    code: "custom",
    path: ["day_addr"],
    message: "day_addr and target_date must refer to the same day.",
  });
}

export function addDayJournalDateRangeIssue(
  value: Record<string, unknown>,
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
): void {
  const startDate = value.start_date;
  const endDate = value.end_date;
  if (typeof startDate !== "string" || typeof endDate !== "string") return;
  if (!isRealIsoDate(startDate) || !isRealIsoDate(endDate)) return;
  if (startDate <= endDate) return;
  ctx.addIssue({
    code: "custom",
    path: ["end_date"],
    message: "start_date must be <= end_date.",
  });
}

export function dayJournalTargetConsistencyError(args: Record<string, unknown>): ToolResult | null {
  if (!hasTargetDateDayAddrMismatch(args)) return null;
  return errorEnvelope(
    buildErrorEnvelope(
      "validation_failure",
      "day_addr and target_date must refer to the same day.",
      "Send either a matching day_addr/target_date pair or only one target field.",
      "target_date_day_addr_mismatch",
    ),
  );
}

export function dayJournalDateRangeError(args: Record<string, unknown>): ToolResult | null {
  const startDate = args.start_date;
  const endDate = args.end_date;
  if (typeof startDate !== "string" || typeof endDate !== "string") return null;
  if (!isRealIsoDate(startDate) || !isRealIsoDate(endDate) || startDate <= endDate) return null;
  return errorEnvelope(
    buildErrorEnvelope(
      "validation_failure",
      "start_date must be <= end_date.",
      "Use a start_date on or before end_date.",
      "date_range_invalid",
    ),
  );
}

export function withQuery(
  pathname: string,
  params: Record<string, unknown>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function bodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function bodyHint(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const hint = (body as Record<string, unknown>).hint;
  return typeof hint === "string" ? hint : undefined;
}

function bodyError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" ? error : undefined;
}

function bodyRequestHash(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const details = (body as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return undefined;
  const requestHash = (details as Record<string, unknown>).request_hash;
  return typeof requestHash === "string" ? requestHash : undefined;
}

function bodyDetail(body: unknown, fallback: string | undefined): string | undefined {
  const hint = bodyHint(body);
  const requestHash = bodyRequestHash(body);
  if (hint) return hint;
  if (requestHash) return `request_hash=${requestHash}`;
  return fallback;
}

function dayJournalErrorClass(status: number | null, fallback: ErrorClass): ErrorClass {
  if (status === 404) return "not_found";
  if (status === 400 || status === 409 || status === 413) {
    return "validation_failure";
  }
  return fallback;
}

function dayJournalErrorMessage(result: VoCallErr): string {
  const error = bodyError(result.body);
  if (error) return error;
  if (result.status === 404) {
    return result.detail || result.message;
  }
  return result.message;
}

export function dayJournalErrorEnvelope(result: VoCallErr): ToolResult {
  return errorEnvelope(
    buildErrorEnvelope(
      dayJournalErrorClass(result.status, result.errorClass),
      dayJournalErrorMessage(result),
      bodyDetail(result.body, result.detail),
      bodyCode(result.body),
    ),
  );
}
