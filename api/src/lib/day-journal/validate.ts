import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type JournalSensitivity = "personal" | "standard";
export type ReservedVoCommand = "VOR" | "VOW" | "VOP" | "VOL";
export type DayJournalEntrySensitivity = "standard" | "personal" | "health" | "financial" | "calendar" | "email";
export type DayJournalRoutineStatus = "ok" | "partial" | "skipped" | "error";

export interface DayJournalSourceRef {
  type: string;
  url?: string;
  label?: string;
}

export interface DayJournalRoutineResult {
  ok: boolean;
  routine_id: string;
  schema: string;
  target_path: string;
  captured_at: string;
  session_date?: string;
  status: DayJournalRoutineStatus;
  summary_line?: string;
  tags?: string[];
  payload: Record<string, unknown>;
  source_refs?: DayJournalSourceRef[];
  project_addr?: string;
  error?: string;
}

export type DayJournalRoutineResultValidation =
  | { ok: true; result: DayJournalRoutineResult }
  | { ok: false; code: "invalid_routine_result"; error: string };

export interface JournalCreateCommand {
  kind: "journal_create";
  command: "VOJ";
  body: string;
  options: {
    target_date?: string;
    tags: string[];
    sensitivity: JournalSensitivity;
  };
  raw: string;
}

export interface ReservedVoCommandResult {
  kind: "reserved";
  command: ReservedVoCommand;
  body: string;
  raw: string;
  reason: string;
}

export interface InvalidVoCommandResult {
  kind: "invalid";
  command: "VOJ";
  code:
    | "empty_body"
    | "invalid_date"
    | "invalid_flag"
    | "invalid_tags"
    | "invalid_sensitivity"
    | "duplicate_flag"
    | "missing_flag_value"
    | "body_too_large";
  error: string;
  raw: string;
}

export interface UnknownVoCommandResult {
  kind: "unknown";
  raw: string;
}

export type ExplicitVoCommandResult =
  | JournalCreateCommand
  | ReservedVoCommandResult
  | InvalidVoCommandResult
  | UnknownVoCommandResult;

export type TargetPathParseResult =
  | { ok: true; target_path: string; segments: string[] }
  | { ok: false; code: "invalid_target_path"; error: string };

const RESERVED_COMMAND_REASONS: Record<ReservedVoCommand, string> = {
  VOR: "VOR is reserved for VO recall.",
  VOW: "VOW is reserved for durable memory writes.",
  VOP: "VOP is reserved for project memory writes.",
  VOL: "VOL is reserved for list and task writes.",
};

const COMMAND_PREFIX_RE = /^\s*([A-Z]{3,})(?=[:\s]|$)/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TARGET_SEGMENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ROUTINE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SCHEMA_ID_RE = /^[a-z][a-z0-9_]{0,63}_v[0-9]+$/;
const TAG_RE = /^[a-z0-9_-]{1,64}$/;
const SOURCE_REF_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_SOURCE_REF_TYPES = new Set(["prototype", "constructor"]);
const PJ_ADDR_RE = /^PJ\.[0-9]+(\.[0-9]+)*$/;
// The VO-token alternative enumerates real token prefixes only (vop_REDACTED, voc_,
// vocr_, voca_, vobc_, vodg_, vons_, vos_, voa_) and requires a body of at
// least 6 chars. Command-only prefixes like voj_, vor_, vow_, vol_ are
// deliberately excluded so short slug tags such as `voj_smoke` or `voc_test`
// (4-char body) do not false-positive while still catching every real leaked
// token (production tokens carry 20-40+ char random bodies).
const SECRET_RE =
  /\bBearer\s+\S+|\bsk-[A-Za-z0-9][A-Za-z0-9_-]*|\bsk_(?:test|live)_[A-Za-z0-9_]+\b|\bAuthorization:\s*\S+(?:\s+\S+)?|\b[A-Za-z0-9_-]*(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|pwd)s?\b\s*[:=]\s*\S+|\b(?:vocr|voca|vobc|vodg|vons|voc|vos|voa|vop)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b|\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9_]+\b|\bgithub_pat_[A-Za-z0-9_]+\b|\bxox[a-z]-[A-Za-z0-9-]+\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\b/i;
const FORBIDDEN_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const EXPLICIT_COMMAND_RAW_MAX_CHARS = 16384;
const RESERVED_COMMAND_BODY_MAX_CHARS = 4096;
const JOURNAL_CREATE_BODY_MAX_CHARS = 8192;
const JOURNAL_REQUEST_MAX_DEPTH = 32;
const MAX_ROUTINE_PAYLOAD_BYTES = 65536;
const MAX_PAYLOAD_PREVIEW_BYTES = 4096;
const MAX_SUMMARY_LINE_CHARS = 4000;
const MAX_SOURCE_REFS = 32;
const MAX_SOURCE_REFS_BYTES = 8192;

function invalidCommand(
  code: InvalidVoCommandResult["code"],
  error: string,
  raw: string,
): InvalidVoCommandResult {
  return { kind: "invalid", command: "VOJ", code, error, raw };
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function bodyAfterReservedCommand(rest: string): string {
  const trimmed = rest.trimStart();
  const body = trimmed.startsWith(":") ? trimmed.slice(1).trim() : trimmed.trim();
  return truncateCodePoints(body.normalize("NFC"), RESERVED_COMMAND_BODY_MAX_CHARS);
}

function truncateCodePoints(value: string, maxChars: number): string {
  let out = "";
  let count = 0;
  for (const char of value) {
    if (count >= maxChars) break;
    out += char;
    count += 1;
  }
  return out;
}

function hasMoreThanCodePoints(value: string, maxChars: number): boolean {
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > maxChars) return true;
  }
  return false;
}

function renderJsonbText(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const rendered = renderJsonbText(item === undefined ? null : item);
      if (rendered === null) return null;
      parts.push(rendered);
    }
    return `[${parts.join(", ")}]`;
  }
  if (!isPlainObject(value)) return null;
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entryValue = value[key];
    if (entryValue === undefined || typeof entryValue === "function" || typeof entryValue === "symbol") continue;
    const renderedKey = JSON.stringify(key);
    const renderedValue = renderJsonbText(entryValue);
    if (renderedKey === undefined || renderedValue === null) return null;
    parts.push(`${renderedKey}: ${renderedValue}`);
  }
  return `{${parts.join(", ")}}`;
}

function jsonbTextUtf8UpperBound(value: unknown): number | null {
  const rendered = renderJsonbText(value);
  return rendered === null ? null : Buffer.byteLength(rendered, "utf8");
}

function flagValue(
  next: string | undefined,
  raw: string,
  message: string,
): string | InvalidVoCommandResult {
  if (!next || next.startsWith("--")) {
    return invalidCommand("missing_flag_value", message, raw);
  }
  return next;
}

export function parseExplicitVoCommand(input: string): ExplicitVoCommandResult {
  const inputText = String(input ?? "");
  const raw = truncateCodePoints(inputText, EXPLICIT_COMMAND_RAW_MAX_CHARS);
  const inputWasTruncated = hasMoreThanCodePoints(inputText, EXPLICIT_COMMAND_RAW_MAX_CHARS);
  const match = raw.match(COMMAND_PREFIX_RE);
  if (!match) return { kind: "unknown", raw };

  const command = match[1];
  const rest = raw.slice(match[0].length);

  if (command === "VOM") {
    return { kind: "unknown", raw };
  }

  if (command === "VOR" || command === "VOW" || command === "VOP" || command === "VOL") {
    return {
      kind: "reserved",
      command,
      body: bodyAfterReservedCommand(rest),
      raw,
      reason: RESERVED_COMMAND_REASONS[command],
    };
  }

  if (command !== "VOJ") {
    return { kind: "unknown", raw };
  }
  if (inputWasTruncated) {
    return invalidCommand(
      "body_too_large",
      `VOJ command text must be ${JOURNAL_CREATE_BODY_MAX_CHARS} characters or fewer.`,
      raw,
    );
  }

  const colonIndex = rest.indexOf(":");
  if (colonIndex < 0) return { kind: "unknown", raw };

  const header = rest.slice(0, colonIndex).trim();
  const body = rest.slice(colonIndex + 1).trim().normalize("NFC");
  if (!body) return invalidCommand("empty_body", "VOJ requires journal text after ':'.", raw);
  if (hasMoreThanCodePoints(body, JOURNAL_CREATE_BODY_MAX_CHARS)) {
    return invalidCommand(
      "body_too_large",
      `VOJ command text must be ${JOURNAL_CREATE_BODY_MAX_CHARS} characters or fewer.`,
      raw,
    );
  }

  const options: JournalCreateCommand["options"] = {
    tags: [],
    sensitivity: "personal",
  };
  const seenFlags = new Set<string>();
  const tokens = header ? header.split(/\s+/) : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.startsWith("--")) {
      if (seenFlags.has(token)) {
        return invalidCommand("duplicate_flag", `Duplicate VOJ flag: ${token}`, raw);
      }
      seenFlags.add(token);
    }
    if (token === "--date") {
      const value = flagValue(next, raw, "--date requires YYYY-MM-DD.");
      if (typeof value !== "string") return value;
      if (!isValidIsoDate(value)) {
        return invalidCommand("invalid_date", "--date must be a real YYYY-MM-DD date.", raw);
      }
      options.target_date = value;
      i += 1;
      continue;
    }
    if (token === "--tags") {
      const value = flagValue(next, raw, "--tags requires a comma-separated value.");
      if (typeof value !== "string") return value;
      const normalizedTags = value
        .split(",")
        .map((tag) => tag.trim().normalize("NFC"))
        .filter(Boolean);
      if (normalizedTags.length === 0 || normalizedTags.length > 20) {
        return invalidCommand("invalid_tags", "--tags must include 1 to 20 lowercase slug values.", raw);
      }
      for (const tag of normalizedTags) {
        if (!TAG_RE.test(tag)) {
          return invalidCommand("invalid_tags", "--tags must be lowercase slug values.", raw);
        }
      }
      options.tags = normalizedTags;
      i += 1;
      continue;
    }
    if (token === "--sensitivity") {
      const value = flagValue(next, raw, "--sensitivity requires personal or standard.");
      if (typeof value !== "string") return value;
      if (value !== "personal" && value !== "standard") {
        return invalidCommand("invalid_sensitivity", "--sensitivity must be personal or standard.", raw);
      }
      options.sensitivity = value;
      i += 1;
      continue;
    }
    return invalidCommand("invalid_flag", `Unsupported VOJ flag: ${token}`, raw);
  }

  return {
    kind: "journal_create",
    command: "VOJ",
    body,
    options,
    raw,
  };
}

export function parseDayJournalTargetPath(input: string): TargetPathParseResult {
  const targetPath = String(input ?? "");
  if (targetPath !== targetPath.trim()) {
    return { ok: false, code: "invalid_target_path", error: "target_path must not have surrounding whitespace." };
  }
  if (targetPath.length > 256) {
    return { ok: false, code: "invalid_target_path", error: "target_path must be 256 characters or fewer." };
  }
  if (!targetPath.startsWith("journal.")) {
    return { ok: false, code: "invalid_target_path", error: "target_path must start with journal." };
  }

  const segments = targetPath.split(".");
  const children = segments.slice(1);
  if (segments[0] !== "journal" || children.length < 2 || children.length > 8) {
    return {
      ok: false,
      code: "invalid_target_path",
      error: "target_path must include journal plus 2 to 8 child segments.",
    };
  }

  for (const segment of children) {
    if (!TARGET_SEGMENT_RE.test(segment)) {
      return {
        ok: false,
        code: "invalid_target_path",
        error: `Invalid target_path segment: ${segment}`,
      };
    }
    if (FORBIDDEN_TARGET_SEGMENTS.has(segment)) {
      return {
        ok: false,
        code: "invalid_target_path",
        error: `Forbidden target_path segment: ${segment}`,
      };
    }
  }

  return { ok: true, target_path: targetPath, segments };
}

function invalidRoutineResult(error: string): DayJournalRoutineResultValidation {
  return { ok: false, code: "invalid_routine_result", error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001F\u007F-\u009F]/.test(value);
}

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

function hasSecretLikeText(value: string): boolean {
  return SECRET_RE.test(value);
}

function sourceRefUrlIsAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!url.hostname || url.username || url.password) return false;
  return url.protocol === "https:";
}

function findNullByteInJsonStrings(value: unknown, path: string): string | null {
  if (typeof value === "string") {
    return hasNullByte(value) ? `${path} must not contain NUL bytes.` : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const error = findNullByteInJsonStrings(value[i], `${path}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const error = findNullByteInJsonStrings(child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

function validateSourceRefs(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "source_refs must be an array.";
  if (value.length > MAX_SOURCE_REFS) return `source_refs must have ${MAX_SOURCE_REFS} entries or fewer.`;
  const byteLength = jsonbTextUtf8UpperBound(value);
  if (byteLength == null || byteLength > MAX_SOURCE_REFS_BYTES) {
    return `source_refs must be ${MAX_SOURCE_REFS_BYTES} bytes or fewer.`;
  }
  for (const ref of value) {
    if (!isPlainObject(ref)) return "source_refs entries must be objects.";
    const keys = Object.keys(ref);
    for (const key of keys) {
      if (key !== "type" && key !== "url" && key !== "label") {
        return `source_refs entries do not allow key: ${key}`;
      }
    }
    if (
      typeof ref.type !== "string"
      || !SOURCE_REF_TYPE_RE.test(ref.type)
      || FORBIDDEN_SOURCE_REF_TYPES.has(ref.type)
    ) {
      return "source_refs.type must be a safe slug.";
    }
    if (ref.url !== undefined) {
      if (typeof ref.url !== "string" || ref.url.length === 0 || ref.url.length > 2048 || hasControlChars(ref.url)) {
        return "source_refs.url must be a bounded string without control characters.";
      }
      if (!sourceRefUrlIsAllowed(ref.url)) {
        return "source_refs.url must be https.";
      }
      if (hasSecretLikeText(ref.url)) return "source_refs.url must not contain secret-like text.";
    }
    if (ref.label !== undefined) {
      if (typeof ref.label !== "string" || ref.label.length > 256 || hasControlChars(ref.label)) {
        return "source_refs.label must be a bounded string without control characters.";
      }
      if (hasSecretLikeText(ref.label)) return "source_refs.label must not contain secret-like text.";
    }
  }
  return null;
}

function routinePayloadPreview(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof result.summary_line === "string" && result.summary_line ? { summary_line: result.summary_line } : {}),
    status: result.status,
  };
}

export function validateDayJournalRoutineResult(input: unknown): DayJournalRoutineResultValidation {
  if (!isPlainObject(input)) return invalidRoutineResult("result must be an object.");

  const result = input as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return invalidRoutineResult("ok must be boolean.");
  if (typeof result.routine_id !== "string" || !ROUTINE_ID_RE.test(result.routine_id)) {
    return invalidRoutineResult("routine_id must be a dotted safe slug.");
  }
  if (typeof result.schema !== "string" || !SCHEMA_ID_RE.test(result.schema)) {
    return invalidRoutineResult("schema must be a versioned safe slug.");
  }
  if (typeof result.target_path !== "string") return invalidRoutineResult("target_path is required.");
  const parsedTargetPath = parseDayJournalTargetPath(result.target_path);
  if (!parsedTargetPath.ok) return invalidRoutineResult(parsedTargetPath.error);

  if (typeof result.captured_at !== "string" || !Number.isFinite(Date.parse(result.captured_at))) {
    return invalidRoutineResult("captured_at must be an ISO timestamp.");
  }
  if (
    result.session_date !== undefined &&
    (typeof result.session_date !== "string" || !isValidIsoDate(result.session_date))
  ) {
    return invalidRoutineResult("session_date must be YYYY-MM-DD when present.");
  }
  if (result.status !== "ok" && result.status !== "partial" && result.status !== "skipped" && result.status !== "error") {
    return invalidRoutineResult("status must be ok, partial, skipped, or error.");
  }
  if (result.status === "error" && result.ok !== false) {
    return invalidRoutineResult("status=error requires ok=false.");
  }
  if (result.status !== "error" && result.ok !== true) {
    return invalidRoutineResult("non-error status requires ok=true.");
  }

  if (result.summary_line !== undefined) {
    if (
      typeof result.summary_line !== "string" ||
      result.summary_line.length > MAX_SUMMARY_LINE_CHARS ||
      hasControlChars(result.summary_line)
    ) {
      return invalidRoutineResult("summary_line must be a bounded string when present.");
    }
    if (hasSecretLikeText(result.summary_line)) return invalidRoutineResult("summary_line must not contain secret-like text.");
  }
  if (result.error !== undefined) {
    if (
      typeof result.error !== "string" ||
      result.error.length > MAX_SUMMARY_LINE_CHARS ||
      hasControlChars(result.error)
    ) {
      return invalidRoutineResult("error must be a bounded string when present.");
    }
    if (hasSecretLikeText(result.error)) return invalidRoutineResult("error must not contain secret-like text.");
  }
  const previewBytes = jsonbTextUtf8UpperBound(routinePayloadPreview(result));
  if (previewBytes == null || previewBytes > MAX_PAYLOAD_PREVIEW_BYTES) {
    return invalidRoutineResult(`payload_preview must be ${MAX_PAYLOAD_PREVIEW_BYTES} bytes or fewer.`);
  }
  if (!isPlainObject(result.payload)) return invalidRoutineResult("payload must be an object.");
  let canonicalPayload: string;
  try {
    canonicalPayload = canonicalizeJournalRequest(result.payload);
  } catch (error) {
    return invalidRoutineResult(error instanceof Error ? error.message : "payload is not canonical JSON.");
  }
  if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_ROUTINE_PAYLOAD_BYTES) {
    return invalidRoutineResult(`payload must be ${MAX_ROUTINE_PAYLOAD_BYTES} bytes or fewer.`);
  }
  const payloadNullByteError = findNullByteInJsonStrings(result.payload, "payload");
  if (payloadNullByteError) return invalidRoutineResult(payloadNullByteError);
  if (hasSecretLikeText(canonicalPayload)) return invalidRoutineResult("payload must not contain secret-like text.");

  if (result.tags !== undefined) {
    if (!Array.isArray(result.tags)) return invalidRoutineResult("tags must be an array when present.");
    if (result.tags.length > 20) return invalidRoutineResult("tags must have 20 entries or fewer.");
    for (const tag of result.tags) {
      if (typeof tag !== "string" || !TAG_RE.test(tag)) {
        return invalidRoutineResult("tags must be lowercase slugs.");
      }
    }
  }

  if (result.project_addr !== undefined && (typeof result.project_addr !== "string" || !PJ_ADDR_RE.test(result.project_addr))) {
    return invalidRoutineResult("project_addr must be a PJ address when present.");
  }

  const sourceRefsError = validateSourceRefs(result.source_refs);
  if (sourceRefsError) return invalidRoutineResult(sourceRefsError);

  return { ok: true, result: input as unknown as DayJournalRoutineResult };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableSeedPart(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const normalized = value.normalize("NFC");
  if (!normalized) {
    throw new TypeError(`${name} must not be empty.`);
  }
  if (normalized.includes("\x00")) {
    throw new TypeError(`${name} must not contain NUL bytes.`);
  }
  return normalized;
}

function stableSeed(parts: Array<[name: string, value: string]>): string {
  return parts.map(([name, value]) => stableSeedPart(name, value)).join("\x00");
}

export function deriveRoutineEntryKey(
  tenantId: string,
  dayAddr: string,
  routineId: string,
  targetPath: string,
): string {
  const parsedTargetPath = parseDayJournalTargetPath(targetPath);
  if (!parsedTargetPath.ok) {
    throw new TypeError(parsedTargetPath.error);
  }
  const seed = stableSeed([
    ["tenantId", tenantId],
    ["dayAddr", dayAddr],
    ["routineId", routineId],
    ["targetPath", parsedTargetPath.target_path],
  ]);
  return `routine_${sha256Hex(seed).slice(0, 16)}`;
}

export function deriveManualEntryKey(
  tenantId: string,
  targetDate: string,
  idempotencyKey: string,
): string {
  if (!isValidIsoDate(targetDate)) {
    throw new TypeError("targetDate must be a real YYYY-MM-DD date.");
  }
  const seed = stableSeed([
    ["tenantId", tenantId],
    ["targetDate", targetDate],
    ["idempotencyKey", idempotencyKey],
  ]);
  return `entry_${targetDate.replaceAll("-", "")}_${sha256Hex(seed).slice(0, 16)}`;
}

export function hashJournalPayload(tenantId: string, canonicalPayloadJson: string): string {
  return sha256Hex(stableSeed([
    ["tenantId", tenantId],
    ["canonicalPayloadJson", canonicalPayloadJson],
  ]));
}

export function hashJournalRequest(tenantId: string, canonicalRequestJson: string): string {
  return sha256Hex(stableSeed([
    ["tenantId", tenantId],
    ["canonicalRequestJson", canonicalRequestJson],
  ]));
}

export function canonicalizeJournalRequest(input: unknown): string {
  return canonicalizeValue(input, 0);
}

function compareUtf8Keys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function canonicalizeValue(value: unknown, depth: number): string {
  if (depth > JOURNAL_REQUEST_MAX_DEPTH) {
    throw new TypeError("journal_request_too_deep");
  }
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string") {
    return JSON.stringify((value as string).normalize("NFC"));
  }
  if (valueType === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new TypeError("Journal request numbers must be finite.");
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }
  if (valueType === "boolean") {
    return value ? "true" : "false";
  }
  if (
    valueType === "undefined" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    throw new TypeError(`Unsupported journal request value type: ${valueType}`);
  }

  if (Array.isArray(value)) {
    return canonicalizeArray(value, depth);
  }

  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new TypeError("Unsupported journal request object type.");
  }

  if (!value || typeof value !== "object") {
    throw new TypeError("Unsupported journal request value.");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Journal request objects must not contain Symbol keys.");
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Journal request objects must be plain objects.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      throw new TypeError(`Journal request object key must be enumerable: ${key}`);
    }
    if ("get" in descriptor || "set" in descriptor) {
      throw new TypeError(`Journal request object key must be a data property: ${key}`);
    }
  }

  const normalizedEntries = Object.keys(value as Record<string, unknown>).map((key) => ({
    key: key.normalize("NFC"),
    value: (value as Record<string, unknown>)[key],
  }));
  const seen = new Set<string>();
  for (const entry of normalizedEntries) {
    if (seen.has(entry.key)) {
      throw new TypeError(`Duplicate journal request key after Unicode normalization: ${entry.key}`);
    }
    seen.add(entry.key);
  }

  normalizedEntries.sort((a, b) => compareUtf8Keys(a.key, b.key));
  return `{${normalizedEntries
    .map((entry) => `${JSON.stringify(entry.key)}:${canonicalizeValue(entry.value, depth + 1)}`)
    .join(",")}}`;
}

function canonicalizeArray(value: unknown[], depth: number): string {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Journal request arrays must not contain Symbol keys.");
  }

  const allowedKeys = new Set<string>(["length"]);
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      throw new TypeError(`Journal request arrays must not be sparse: missing index ${i}`);
    }
    allowedKeys.add(String(i));
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Journal request arrays must not contain extra properties: ${key}`);
    }
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of allowedKeys) {
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable) {
      throw new TypeError(`Journal request array index must be enumerable: ${key}`);
    }
    if ("get" in descriptor || "set" in descriptor) {
      throw new TypeError(`Journal request array index must be a data property: ${key}`);
    }
  }

  return `[${value.map((item) => canonicalizeValue(item, depth + 1)).join(",")}]`;
}
