import { createHash } from "node:crypto";
import type postgres from "postgres";
import { buildDayAddr } from "@verity-one/graph-shape";
import { EMBED_MODEL, toVectorStr } from "../embed";
import { journalDayJournalEntry } from "../sync-journal-port";
import {
  canonicalizeJournalRequest,
  deriveManualEntryKey,
  deriveRoutineEntryKey,
  hashJournalPayload,
  hashJournalRequest,
  parseDayJournalTargetPath,
  validateDayJournalRoutineResult,
  type DayJournalEntrySensitivity,
  type DayJournalRoutineResult,
} from "./validate";

type SqlTag = ReturnType<typeof postgres>;

export type DayJournalRoutineClass = "context_only" | "actionable";
export type DayJournalMutationKind = "create" | "routine_run" | "retract" | "redact";
export type DayJournalRequestKind = "manual_voj" | "hosted_command" | "routine_run" | "scheduled_routine";
export type WriteDayJournalEntryErrorCode =
  | "entry_was_retracted"
  | "idempotency_conflict"
  | "entry_key_collision"
  | "entry_not_found"
  | "day_node_missing";

export interface WriteDayJournalEntryInput {
  tenantId: string;
  spaceId: string;
  dayAddr?: string;
  targetDate?: string;
  targetTimezone?: string;
  result?: DayJournalRoutineResult;
  actor?: string;
  runId?: string;
  entryKey?: string;
  idempotencyKey?: string;
  requestHash: string;
  requestCanonicalJson?: string;
  idempotencyNamespace?: string;
  requestKind: DayJournalRequestKind;
  sensitivity?: DayJournalEntrySensitivity;
  routineClass?: DayJournalRoutineClass;
  mutationKind?: DayJournalMutationKind;
}

export type WriteDayJournalEntryResult =
  | {
      ok: true;
      day_addr: string;
      entry_key: string;
      target_path: string;
      entry_state: "active" | "retracted" | "redacted";
      routine_id?: string;
      sensitivity?: DayJournalEntrySensitivity;
      tags?: string[];
    }
  | { ok: true; day_addr: string; entry_key: null; target_path: string; entry_state: "none"; result_status: "skipped" | "error" }
  | {
      ok: false;
      code: WriteDayJournalEntryErrorCode;
      hint?: string;
    };

const DAY_NODE_PLACEHOLDER_VEC = toVectorStr(new Array(3072).fill(0));
const MAX_FUTURE_CAPTURED_AT_MS = 60 * 60 * 1000;
const MAX_CAPTURED_AT_BEFORE_TARGET_MS = 14 * 60 * 60 * 1000;
const MAX_CAPTURED_AT_AFTER_TARGET_MS = 36 * 60 * 60 * 1000;
const DAY_ADDR_RE = /^TMP\.([0-9]{4})\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ENTRY_KEY_RE = /^(entry_[0-9]{8}_[a-f0-9]{16}|routine_[a-f0-9]{16})$/;
const PJ_ADDR_RE = /^PJ\.[0-9]+(\.[0-9]+)*$/;
const IDEMPOTENCY_NAMESPACE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MANUAL_ROUTINE_ID = "manual.tenant_entry";
const RETRACTED_HINT = "Submit a new VOJ with a different message/idempotency_key, or use an explicit operator route to recreate.";

function sqlJson(sql: SqlTag, value: unknown): postgres.Parameter {
  return (sql as any).json(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableHashPart(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const normalized = value.normalize("NFC");
  if (!normalized || normalized.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes.`);
  }
  return normalized;
}

function normalizeIdempotencyNamespace(value: string): string {
  const normalized = stableHashPart("idempotencyNamespace", value);
  if (normalized !== normalized.trim() || !IDEMPOTENCY_NAMESPACE_RE.test(normalized)) {
    throw new TypeError("idempotencyNamespace must be a dotted safe slug without surrounding whitespace.");
  }
  return normalized;
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("idempotencyKey must be a string.");
  }
  const trimmed = value.normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError("idempotencyKey must be a bounded non-empty string without NUL bytes.");
  }
  return trimmed;
}

function hashIdempotencyKey(tenantId: string, namespace: string, key: string): string {
  const seed = [
    stableHashPart("tenantId", tenantId),
    normalizeIdempotencyNamespace(namespace),
    normalizeIdempotencyKey(key),
  ].join("\x00");
  return sha256Hex(seed);
}

function validateIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function dateValueToIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const date = value.slice(0, 10);
    if (validateIsoDate(date)) return date;
  }
  throw new TypeError("database date value is not a valid YYYY-MM-DD date.");
}

function timestampValueToIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new TypeError("database timestamp value is not a valid ISO timestamp.");
}

function dateToDayAddr(targetDate: string): { dayAddr: string; year: number; doy: number; date: Date } {
  if (!validateIsoDate(targetDate)) throw new TypeError("targetDate must be YYYY-MM-DD.");
  const [year, month, day] = targetDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  const doy = Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
  return { dayAddr: buildDayAddr(year, doy), year, doy, date };
}

function dayAddrToDate(dayAddr: string): { targetDate: string; year: number; doy: number; date: Date } {
  const match = dayAddr.match(DAY_ADDR_RE);
  if (!match) throw new TypeError("dayAddr must match canonical TMP.YYYY.DDD with DDD in 001-366.");
  const year = Number(match[1]);
  const doy = Number(match[2]);
  const date = new Date(Date.UTC(year, 0, doy));
  if (date.getUTCFullYear() !== year || buildDayAddr(year, doy) !== dayAddr) {
    throw new TypeError("dayAddr is not a real calendar day.");
  }
  return { targetDate: date.toISOString().slice(0, 10), year, doy, date };
}

function resolveTarget(input: Pick<WriteDayJournalEntryInput, "dayAddr" | "targetDate">): {
  dayAddr: string;
  targetDate: string;
  year: number;
  doy: number;
  date: Date;
} {
  if (input.targetDate) {
    const resolved = dateToDayAddr(input.targetDate);
    if (input.dayAddr && input.dayAddr !== resolved.dayAddr) {
      throw new TypeError("dayAddr and targetDate refer to different days.");
    }
    return { ...resolved, targetDate: input.targetDate };
  }
  if (input.dayAddr) {
    const resolved = dayAddrToDate(input.dayAddr);
    return { dayAddr: input.dayAddr, ...resolved };
  }
  const today = new Date();
  const targetDate = today.toISOString().slice(0, 10);
  const resolved = dateToDayAddr(targetDate);
  return { ...resolved, targetDate };
}

function weekdayName(date: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
}

function normalizeTimezone(value: string | undefined): string {
  const tz = (value || "UTC").normalize("NFC").trim();
  if (!tz || tz.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(tz)) {
    throw new TypeError("targetTimezone must be a bounded string without control characters.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
  } catch {
    throw new TypeError("targetTimezone must be a valid IANA time zone.");
  }
  return tz;
}

function normalizeTags(tags: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const tag of tags || []) {
    const normalized = tag.normalize("NFC").trim();
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

function normalizeProjectAddr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PJ_ADDR_RE.test(trimmed)) throw new TypeError("project_addr must be a PJ address.");
  return trimmed;
}

function normalizeRequestHash(value: string): string {
  const hash = String(value || "").trim();
  if (!HASH_RE.test(hash)) throw new TypeError("requestHash must be a 64-character lowercase sha256 hex string.");
  return hash;
}

function defaultMutationKindForRequest(kind: DayJournalRequestKind): DayJournalMutationKind {
  return kind === "routine_run" || kind === "scheduled_routine" ? "routine_run" : "create";
}

function assertRequestHashMatchesCanonicalJson(
  tenantId: string,
  requestHash: string,
  requestCanonicalJson: string | undefined,
  _requestKind: DayJournalRequestKind,
): void {
  if (requestCanonicalJson === undefined) {
    throw new TypeError("requestCanonicalJson is required for day journal writes.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestCanonicalJson);
  } catch {
    throw new TypeError("requestCanonicalJson must be valid JSON.");
  }
  const canonical = canonicalizeJournalRequest(parsed);
  if (canonical !== requestCanonicalJson) {
    throw new TypeError("requestCanonicalJson must already be in canonical journal JSON form.");
  }
  if (hashJournalRequest(tenantId, canonical) !== requestHash) {
    throw new TypeError("requestHash does not match requestCanonicalJson.");
  }
}

function createDaySubstance(targetDate: string, year: number, doy: number): Record<string, unknown> {
  const date = new Date(`${targetDate}T00:00:00.000Z`);
  return {
    date: targetDate,
    day_of_week: weekdayName(date),
    day_of_year: doy,
    year,
    summary: "",
    energy: 0,
    tags: [],
    intake: [],
    journal: {},
    predictions_fulfilled: [],
    predictions_missed: [],
    day_affinity: 0,
  };
}

function buildEntryPayload(
  result: DayJournalRoutineResult,
  entryKey: string,
  sensitivity: DayJournalEntrySensitivity,
  routineClass: DayJournalRoutineClass,
  capturedAtIso: string,
): Record<string, unknown> {
  return {
    entry_key: entryKey,
    schema: result.schema,
    routine_id: result.routine_id,
    captured_at: capturedAtIso,
    ...(result.session_date ? { session_date: result.session_date } : {}),
    status: result.status,
    ...(result.summary_line ? { summary_line: result.summary_line } : {}),
    tags: normalizeTags(result.tags),
    sensitivity,
    routine_class: routineClass,
    payload: result.payload,
    ...(result.source_refs ? { source_refs: result.source_refs } : {}),
    ...(result.project_addr ? { project_addr: result.project_addr } : {}),
  };
}

function targetDateUtcStartMs(targetDate: string): number {
  const ms = Date.parse(`${targetDate}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new TypeError("targetDate must be a real YYYY-MM-DD date.");
  return ms;
}

function capturedAtIsoForResult(result: DayJournalRoutineResult, isManual: boolean, targetDate: string): string {
  if (isManual) return new Date().toISOString();
  const capturedAt = new Date(result.captured_at);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new TypeError("captured_at must be a valid timestamp.");
  }
  if (capturedAt.getTime() > Date.now() + MAX_FUTURE_CAPTURED_AT_MS) {
    throw new TypeError("captured_at must not be more than 1 hour in the future.");
  }
  const targetStartMs = targetDateUtcStartMs(targetDate);
  if (
    capturedAt.getTime() < targetStartMs - MAX_CAPTURED_AT_BEFORE_TARGET_MS
    || capturedAt.getTime() >= targetStartMs + MAX_CAPTURED_AT_AFTER_TARGET_MS
  ) {
    throw new TypeError("captured_at must be within the target day window.");
  }
  return capturedAt.toISOString();
}

function buildPayloadPreview(result: DayJournalRoutineResult): Record<string, unknown> {
  return {
    ...(result.summary_line ? { summary_line: result.summary_line } : {}),
    status: result.status,
  };
}

function storagePathSegments(targetPath: string, isManual: boolean, entryKey: string): string[] {
  const parsed = parseDayJournalTargetPath(targetPath);
  if (!parsed.ok) throw new TypeError(parsed.error);
  if (isManual && parsed.segments[parsed.segments.length - 1] !== entryKey) {
    return [...parsed.segments, entryKey];
  }
  return parsed.segments;
}

function assertEntryKey(value: string): void {
  if (!ENTRY_KEY_RE.test(value)) throw new TypeError("entryKey must match the day-journal public key shape.");
}

async function markRunFailed(sql: SqlTag, input: WriteDayJournalEntryInput, error: unknown): Promise<void> {
  if (!input.runId) return;
  const message = error instanceof Error ? error.message : String(error || "day_journal_writer_failed");
  await sql`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        error = ${message.slice(0, 4000)},
        finished_at = COALESCE(finished_at, now()),
        last_progress_at = now()
    WHERE id = ${input.runId}::uuid
      AND tenant_id = ${input.tenantId}
      AND run_status IN ('pending', 'running')
  `.catch((markError) => {
    const reason = markError instanceof Error ? markError.message : String(markError || "unknown error");
    console.error("day-journal-writer: failed to mark run failed:", reason);
  });
}

async function writeRunFailure(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  code: WriteDayJournalEntryErrorCode,
  hint?: string,
): Promise<void> {
  if (!input.runId) return;
  const message = hint ? `${code}: ${hint}` : code;
  await tx`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'failed',
        result_status = 'error',
        error = ${message.slice(0, 4000)},
        finished_at = COALESCE(finished_at, now()),
        last_progress_at = now()
    WHERE id = ${input.runId}::uuid
      AND tenant_id = ${input.tenantId}
      AND run_status IN ('pending', 'running')
  `;
}

async function failWrite(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  code: WriteDayJournalEntryErrorCode,
  hint?: string,
): Promise<WriteDayJournalEntryResult> {
  await writeRunFailure(tx, input, code, hint);
  return hint ? { ok: false, code, hint } : { ok: false, code };
}

async function ensureAndLockDayNode(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  target: ReturnType<typeof resolveTarget>,
): Promise<{ ok: true } | { ok: false; hint: string }> {
  const label = `${target.targetDate} (${weekdayName(target.date)})`;
  const hashSeed = `day-journal:${input.spaceId}:${target.dayAddr}:${label}`;
  const provenance = { agent: input.actor || "day-journal-writer", method: "day-journal-writer", basis: "inferred" };
  await tx`
    INSERT INTO nodes (
      addr, pyramid_id, layer, depth, position, label, substance,
      confidence, hash, temperature, provenance, node_type, visibility, space_id, decay_rate,
      embedding_hv, embedding_at, embedding_model, embedding_task_type
    ) VALUES (
      ${target.dayAddr}, 'TEMPORAL', 0, 0, ${target.doy}, ${label}, ${sqlJson(tx, createDaySubstance(target.targetDate, target.year, target.doy))}::jsonb,
      0.3, md5(${hashSeed}), 0.0, ${sqlJson(tx, provenance)}::jsonb, 'day', 'private', ${input.spaceId}, 0.005,
      ${DAY_NODE_PLACEHOLDER_VEC}::halfvec(3072), now(), ${EMBED_MODEL}, 'legacy_unknown'
    )
    ON CONFLICT (addr) DO NOTHING
  `;
  const rows = await tx`
    SELECT addr
    FROM nodes
    WHERE addr = ${target.dayAddr}
      AND space_id = ${input.spaceId}
      AND node_type = 'day'
      AND visibility <> 'deleted'
    FOR UPDATE
  `;
  if (rows.length === 1) return { ok: true };

  const [conflictingDayNode] = await tx`
    SELECT space_id, visibility
    FROM nodes
    WHERE addr = ${target.dayAddr}
      AND node_type = 'day'
    LIMIT 1
  `;
  if (conflictingDayNode) {
    return {
      ok: false,
      hint: "The target TMP day address already exists outside this tenant or is deleted; current nodes.addr primary-key storage prevents tenant-local auto-create.",
    };
  }
  return {
    ok: false,
    hint: "The target day node could not be created or locked for this tenant.",
  };
}

async function patchDayNodeEntry(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  dayAddr: string,
  jsonPath: string[],
  entryPayload: Record<string, unknown>,
  tags: string[],
): Promise<boolean> {
  const rows = await tx`
    UPDATE nodes
    SET embedding_hv = ${DAY_NODE_PLACEHOLDER_VEC}::halfvec(3072),
        embedding_at = now(),
        embedding_model = ${EMBED_MODEL},
        embedding_task_type = 'legacy_unknown',
        substance = jsonb_set(
          day_journal_jsonb_set_deep(
            COALESCE(substance, '{}'::jsonb),
            ${jsonPath}::text[],
            ${sqlJson(tx, entryPayload)}::jsonb
          ),
          '{tags}',
          (
            SELECT COALESCE(jsonb_agg(tag ORDER BY tag), '[]'::jsonb)
            FROM (
              SELECT DISTINCT tag
              FROM (
                SELECT jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(COALESCE(substance, '{}'::jsonb)->'tags') = 'array'
                    THEN COALESCE(substance, '{}'::jsonb)->'tags'
                    ELSE '[]'::jsonb
                  END
                ) AS tag
                UNION ALL
                SELECT unnest(${tags}::text[]) AS tag
              ) raw_tags
              WHERE tag <> ''
            ) deduped_tags
          ),
          true
        ),
        updated_at = now()
    WHERE addr = ${dayAddr}
      AND space_id = ${input.spaceId}
      AND node_type = 'day'
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  return rows.length === 1;
}

async function removeDayNodeEntry(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  dayAddr: string,
  jsonPath: string[],
): Promise<boolean> {
  // Missing JSON path is treated as already removed; the normalized entry row
  // and mandatory tombstone sync row are the retraction source of truth.
  const rows = await tx`
    UPDATE nodes
    SET substance = COALESCE(substance, '{}'::jsonb) #- ${jsonPath}::text[],
        embedding_hv = ${DAY_NODE_PLACEHOLDER_VEC}::halfvec(3072),
        embedding_at = now(),
        embedding_model = ${EMBED_MODEL},
        embedding_task_type = 'legacy_unknown',
        updated_at = now()
    WHERE addr = ${dayAddr}
      AND space_id = ${input.spaceId}
      AND node_type = 'day'
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  return rows.length === 1;
}

async function writeRunSuccess(
  tx: SqlTag,
  input: WriteDayJournalEntryInput,
  resultStatus: "ok" | "partial" | "skipped" | "error",
  result: Record<string, unknown> | null,
): Promise<void> {
  if (!input.runId) return;
  const resultError = resultStatus === "error"
    ? String(result?.error || result?.summary_line || "Routine returned an error result.").slice(0, 4000)
    : null;
  await tx`
    UPDATE tenant_day_journal_routine_runs
    SET run_status = 'succeeded',
        result_status = ${resultStatus},
        result = ${result ? sqlJson(tx, result) : null}::jsonb,
        error = ${resultError},
        finished_at = now(),
        last_progress_at = now()
    WHERE id = ${input.runId}::uuid
      AND tenant_id = ${input.tenantId}
      AND run_status IN ('pending', 'running')
  `;
}

export async function writeDayJournalEntry(
  sql: SqlTag,
  input: WriteDayJournalEntryInput,
): Promise<WriteDayJournalEntryResult> {
  try {
    if (input.spaceId !== `tenant:${input.tenantId}`) {
      throw new TypeError("spaceId must match tenantId.");
    }
    const requestHash = normalizeRequestHash(input.requestHash);
    assertRequestHashMatchesCanonicalJson(input.tenantId, requestHash, input.requestCanonicalJson, input.requestKind);
    const mutationKind: DayJournalMutationKind = input.mutationKind || defaultMutationKindForRequest(input.requestKind);

    return await sql.begin(async (tx: any) => {
      if (mutationKind === "retract" || mutationKind === "redact") {
        if (!input.entryKey) throw new TypeError("entryKey is required for retraction/redaction.");
        assertEntryKey(input.entryKey);
        const [existing] = await tx`
          SELECT *
          FROM tenant_day_journal_entries
          WHERE tenant_id = ${input.tenantId}
            AND entry_key = ${input.entryKey}
          FOR UPDATE
        `;
        if (!existing) return await failWrite(tx, input, "entry_not_found");
        if (existing.entry_state !== "active") {
          // Low-level writer fail-closes; PR6 owned route retries translate this
          // terminal state to 200 OK without recreating retracted payload data.
          return await failWrite(tx, input, "entry_was_retracted", RETRACTED_HINT);
        }
        const target = resolveTarget({ dayAddr: String(existing.day_addr), targetDate: dateValueToIsoDate(existing.target_date) });
        const dayLocked = await ensureAndLockDayNode(tx, input, target);
        if (!dayLocked.ok) return await failWrite(tx, input, "day_node_missing", dayLocked.hint);
        const path = storagePathSegments(String(existing.target_path), String(existing.routine_id) === MANUAL_ROUTINE_ID, input.entryKey);
        const removed = await removeDayNodeEntry(tx, input, String(existing.day_addr), path);
        if (!removed) return await failWrite(tx, input, "day_node_missing");
        const [updated] = await tx`
          UPDATE tenant_day_journal_entries
          SET entry_state = ${mutationKind === "redact" ? "redacted" : "retracted"},
              payload_json = NULL,
              payload_preview = '{}'::jsonb,
              tags = '{}'::text[],
              source_refs = '[]'::jsonb,
              last_mutation_kind = ${mutationKind},
              updated_at = now()
          WHERE tenant_id = ${input.tenantId}
            AND entry_key = ${input.entryKey}
          RETURNING *
        `;
        await writeRunSuccess(tx, input, "ok", { mutation_kind: mutationKind, entry_key: input.entryKey, request_hash: requestHash });
        await journalDayJournalEntry(tx, "tombstone", input.entryKey, input.spaceId, {
          entry_key: input.entryKey,
          day_addr: updated.day_addr,
          target_date: dateValueToIsoDate(updated.target_date),
          target_timezone: updated.target_timezone,
          routine_id: updated.routine_id,
          target_path: updated.target_path,
          project_addr: updated.project_addr,
          schema: updated.schema,
          sensitivity: updated.sensitivity,
          routine_class: updated.routine_class,
          result_status: updated.result_status,
          entry_state: updated.entry_state,
          captured_at: timestampValueToIso(updated.captured_at),
          updated_at: timestampValueToIso(updated.updated_at),
          is_local_authoritative: true,
        });
        return {
          ok: true,
          day_addr: String(updated.day_addr),
          entry_key: input.entryKey,
          target_path: String(updated.target_path),
          entry_state: updated.entry_state === "redacted" ? "redacted" : "retracted",
        };
      }

      const targetTimezone = normalizeTimezone(input.targetTimezone);
      if (!input.result) throw new TypeError("result is required for create/routine_run writes.");
      const validation = validateDayJournalRoutineResult(input.result);
      if (!validation.ok) throw new TypeError(validation.error);
      const result = validation.result;
      const isManual = input.requestKind === "manual_voj" || result.routine_id === MANUAL_ROUTINE_ID;
      if (input.targetDate && result.session_date && input.targetDate !== result.session_date) {
        throw new TypeError("targetDate and result.session_date refer to different days.");
      }
      const target = resolveTarget({ dayAddr: input.dayAddr, targetDate: input.targetDate || result.session_date });
      const capturedAtIso = capturedAtIsoForResult(result, isManual, target.targetDate);
      const parsedTargetPath = parseDayJournalTargetPath(result.target_path);
      if (!parsedTargetPath.ok) throw new TypeError(parsedTargetPath.error);

      if (result.status === "skipped" || result.status === "error") {
        const target = resolveTarget({ dayAddr: input.dayAddr, targetDate: input.targetDate || result.session_date });
        await writeRunSuccess(tx, input, result.status, result as unknown as Record<string, unknown>);
        return {
          ok: true,
          day_addr: target.dayAddr,
          entry_key: null,
          target_path: parsedTargetPath.target_path,
          entry_state: "none",
          result_status: result.status,
        };
      }

      const idempotencyKey = input.idempotencyKey ? normalizeIdempotencyKey(input.idempotencyKey) : undefined;
      if (isManual && !idempotencyKey) {
        throw new TypeError("idempotencyKey is required for manual journal writes.");
      }
      const idempotencyNamespace = input.idempotencyNamespace
        ? normalizeIdempotencyNamespace(input.idempotencyNamespace)
        : undefined;
      if (idempotencyKey && !idempotencyNamespace) {
        throw new TypeError("idempotencyNamespace is required when idempotencyKey is present.");
      }
      const derivedEntryKey = isManual
        ? deriveManualEntryKey(input.tenantId, target.targetDate, idempotencyKey!)
        : deriveRoutineEntryKey(input.tenantId, target.dayAddr, result.routine_id, parsedTargetPath.target_path);
      const entryKey = input.entryKey || derivedEntryKey;
      assertEntryKey(entryKey);
      if (entryKey !== derivedEntryKey) throw new TypeError("entryKey does not match canonical derivation.");

      if (!isManual) {
        const [routineTarget] = await tx`
          SELECT entry_key, request_hash, entry_state
          FROM tenant_day_journal_entries
          WHERE tenant_id = ${input.tenantId}
            AND day_addr = ${target.dayAddr}
            AND routine_id = ${result.routine_id}
            AND target_path = ${parsedTargetPath.target_path}
            AND entry_key LIKE 'routine_%'
          FOR UPDATE
        `;
        if (routineTarget && routineTarget.entry_key !== entryKey) {
          return await failWrite(tx, input, "entry_key_collision");
        }
      }

      const idempotencyKeySha256 = idempotencyKey && idempotencyNamespace
        ? hashIdempotencyKey(input.tenantId, idempotencyNamespace, idempotencyKey)
        : null;
      if (idempotencyKeySha256) {
        const [idempotencyExisting] = await tx`
          SELECT entry_key, entry_state, request_hash, day_addr, target_path
          FROM tenant_day_journal_entries
          WHERE tenant_id = ${input.tenantId}
            AND idempotency_namespace = ${idempotencyNamespace}
            AND idempotency_key_sha256 = ${idempotencyKeySha256}
          FOR UPDATE
        `;
        if (idempotencyExisting) {
          if (idempotencyExisting.entry_state !== "active") {
            return await failWrite(tx, input, "entry_was_retracted", RETRACTED_HINT);
          }
          if (idempotencyExisting.entry_key !== entryKey || idempotencyExisting.request_hash !== requestHash) {
            return await failWrite(tx, input, "idempotency_conflict", "Use a new idempotency_key for edited journal text.");
          }
          return {
            ok: true,
            day_addr: String(idempotencyExisting.day_addr),
            entry_key: String(idempotencyExisting.entry_key),
            target_path: String(idempotencyExisting.target_path),
            entry_state: "active",
          };
        }
      }
      const dayLocked = await ensureAndLockDayNode(tx, input, target);
      if (!dayLocked.ok) return await failWrite(tx, input, "day_node_missing", dayLocked.hint);

      const sensitivity = input.sensitivity || "personal";
      const routineClass = input.routineClass || "context_only";
      const entryPayload = buildEntryPayload(result, entryKey, sensitivity, routineClass, capturedAtIso);
      const canonicalPayload = canonicalizeJournalRequest(entryPayload);
      const payloadHash = hashJournalPayload(input.tenantId, canonicalPayload);
      const payloadPreview = buildPayloadPreview(result);
      const tags = normalizeTags(result.tags);
      const sourceRefs = result.source_refs || [];
      const projectAddr = normalizeProjectAddr(result.project_addr);
      const storagePath = storagePathSegments(parsedTargetPath.target_path, isManual, entryKey);

      const upsertRows = isManual
        ? await tx`
            INSERT INTO tenant_day_journal_entries (
              tenant_id, entry_key, day_addr, target_date, target_timezone,
              routine_id, target_path, project_addr, schema, sensitivity, routine_class,
              result_status, entry_state, captured_at, tags, payload_json, payload_preview,
              payload_hash, source_refs, latest_run_id, idempotency_namespace,
              idempotency_key_sha256, request_hash, last_mutation_kind
            ) VALUES (
              ${input.tenantId}, ${entryKey}, ${target.dayAddr}, ${target.targetDate}, ${targetTimezone},
              ${result.routine_id}, ${parsedTargetPath.target_path}, ${projectAddr}, ${result.schema}, ${sensitivity}, ${routineClass},
              ${result.status}, 'active', ${entryPayload.captured_at}, ${tags}, ${sqlJson(tx, entryPayload)}::jsonb, ${sqlJson(tx, payloadPreview)}::jsonb,
              ${payloadHash}, ${sqlJson(tx, sourceRefs)}::jsonb, ${input.runId ?? null}::uuid, ${idempotencyNamespace ?? null},
              ${idempotencyKeySha256}, ${requestHash}, ${mutationKind}
            )
            ON CONFLICT (tenant_id, entry_key) DO UPDATE
            SET updated_at = tenant_day_journal_entries.updated_at
            WHERE tenant_day_journal_entries.entry_state = 'active'
              AND tenant_day_journal_entries.request_hash = ${requestHash}
            RETURNING entry_key, entry_state, request_hash
          `
        : await tx`
            INSERT INTO tenant_day_journal_entries (
              tenant_id, entry_key, day_addr, target_date, target_timezone,
              routine_id, target_path, project_addr, schema, sensitivity, routine_class,
              result_status, entry_state, captured_at, tags, payload_json, payload_preview,
              payload_hash, source_refs, latest_run_id, idempotency_namespace,
              idempotency_key_sha256, request_hash, last_mutation_kind
            ) VALUES (
              ${input.tenantId}, ${entryKey}, ${target.dayAddr}, ${target.targetDate}, ${targetTimezone},
              ${result.routine_id}, ${parsedTargetPath.target_path}, ${projectAddr}, ${result.schema}, ${sensitivity}, ${routineClass},
              ${result.status}, 'active', ${entryPayload.captured_at}, ${tags}, ${sqlJson(tx, entryPayload)}::jsonb, ${sqlJson(tx, payloadPreview)}::jsonb,
              ${payloadHash}, ${sqlJson(tx, sourceRefs)}::jsonb, ${input.runId ?? null}::uuid, ${idempotencyNamespace ?? null},
              ${idempotencyKeySha256}, ${requestHash}, ${mutationKind}
            )
            ON CONFLICT (tenant_id, entry_key) DO UPDATE
            SET day_addr = EXCLUDED.day_addr,
                target_date = EXCLUDED.target_date,
                target_timezone = EXCLUDED.target_timezone,
                routine_id = EXCLUDED.routine_id,
                target_path = EXCLUDED.target_path,
                project_addr = EXCLUDED.project_addr,
                schema = EXCLUDED.schema,
                sensitivity = EXCLUDED.sensitivity,
                routine_class = EXCLUDED.routine_class,
                result_status = EXCLUDED.result_status,
                entry_state = 'active',
                captured_at = EXCLUDED.captured_at,
                tags = EXCLUDED.tags,
                payload_json = EXCLUDED.payload_json,
                payload_preview = EXCLUDED.payload_preview,
                payload_hash = EXCLUDED.payload_hash,
                source_refs = EXCLUDED.source_refs,
                latest_run_id = COALESCE(EXCLUDED.latest_run_id, tenant_day_journal_entries.latest_run_id),
                request_hash = EXCLUDED.request_hash,
                last_mutation_kind = EXCLUDED.last_mutation_kind,
                updated_at = now()
            WHERE tenant_day_journal_entries.entry_state = 'active'
            RETURNING entry_key, entry_state, request_hash
          `;

      if (upsertRows.length === 0) {
        const [existing] = await tx`
          SELECT entry_key, entry_state, request_hash
          FROM tenant_day_journal_entries
          WHERE tenant_id = ${input.tenantId}
            AND entry_key = ${entryKey}
          FOR UPDATE
        `;
        if (existing?.entry_state !== "active") {
          return await failWrite(tx, input, "entry_was_retracted", RETRACTED_HINT);
        }
        if (isManual && existing?.request_hash && existing.request_hash !== requestHash) {
          return await failWrite(tx, input, "idempotency_conflict", "Use a new idempotency_key for edited journal text.");
        }
        return await failWrite(tx, input, "entry_key_collision");
      }

      const patched = await patchDayNodeEntry(tx, input, target.dayAddr, storagePath, entryPayload, tags);
      if (!patched) return await failWrite(tx, input, "day_node_missing");
      await writeRunSuccess(tx, input, result.status, result as unknown as Record<string, unknown>);
      await journalDayJournalEntry(tx, "upsert", entryKey, input.spaceId, {
        ...entryPayload,
        day_addr: target.dayAddr,
        target_date: target.targetDate,
        target_timezone: targetTimezone,
        routine_id: result.routine_id,
        target_path: parsedTargetPath.target_path,
        project_addr: projectAddr,
        schema: result.schema,
        sensitivity,
        routine_class: routineClass,
        result_status: result.status,
        entry_state: "active",
        captured_at: entryPayload.captured_at,
        tags,
        payload_json: entryPayload,
        payload_preview: payloadPreview,
        source_refs: sourceRefs,
        payload_hash: payloadHash,
        request_hash: requestHash,
        is_local_authoritative: true,
        updated_at: new Date().toISOString(),
      });

      return {
        ok: true,
        day_addr: target.dayAddr,
        entry_key: entryKey,
        target_path: parsedTargetPath.target_path,
        entry_state: "active",
        routine_id: result.routine_id,
        sensitivity,
        tags,
      };
    });
  } catch (error) {
    await markRunFailed(sql, input, error);
    throw error;
  }
}
