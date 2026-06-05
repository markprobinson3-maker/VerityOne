/**
 * /dashboard — Local tenant dashboard.
 *
 * Routes:
 *   GET  /dashboard                      — HTML shell (unauthenticated)
 *   GET  /dashboard/overview             — Home tab composite read
 *   GET  /dashboard/structure            — Structure tab composite read
 *   GET  /dashboard/review               — Review queue read
 *   GET  /dashboard/review/:addr/audit   — Memory audit snapshot
 *   POST /dashboard/review/:addr/approve — Approve memory (operator-only)
 *   POST /dashboard/review/:addr/retract — Retract memory (operator-only)
 *
 * Tenant resolution: all data routes accept either:
 *   - tenant token with implicit tenantId
 *   - operator token with explicit ?tenant_id=<id> (GET) or body tenant_id (POST)
 *
 * Mounted under /dashboard/* to avoid the requireVoEnabled() gate.
 */

import { Hono } from "hono";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { sql } from "../db";
import { getAccessContext, isOperator } from "../lib/access";
import {
  computeAllControlRowsWithCheckers,
  readAcceptanceArtifact,
  resolveRepoRoot,
  type DashboardControlRow,
} from "../lib/mcp-control-status";
import {
  ACTION_DESCRIPTORS,
  executeAction,
  previewAction,
  recordAudit,
  FORBIDDEN_TOP_LEVEL_FIELDS,
  type ActionDescriptor,
} from "../lib/mcp-local-action-runner";
import { buildStyleBlock, SHARED_SEAM_MARKER } from "../lib/ui-style";
import { buildErrorEnvelope, errorJson, ApiError } from "../lib/error-envelope";
import { ERROR_CODES, type ErrorCode } from "../lib/error-codes";
import { auditMutation } from "../lib/audit";
import type { SyncPreferencePatch } from "../lib/sync-preferences";
import { getDriveMirrorStats } from "../lib/google-drive-state";
import { HOSTED_PARITY_THRESHOLDS } from "../lib/hosted-parity-thresholds";
import {
  DAY_JOURNAL_SCOPED_AUTHORITY_PERMISSIONS,
  defaultTargetPathForRoutine,
  listRoutines,
  routineNeedsScopedAuthority,
  type DayJournalRoutineDefinition,
} from "../lib/day-journal/routines";
import {
  readDayJournalRoutineSchedulerStatus,
  type DayJournalRoutineSchedulerStatusSummary,
} from "../lib/day-journal/routine-scheduler-status";

const dashboard = new Hono();
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function errorCodeForHttpStatus(status: number): ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 406) return "not_acceptable";
  if (status === 410) return "gone";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_failed";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status === 501) return "not_implemented";
  if (status === 502) return "bad_gateway";
  if (status === 503) return "service_unavailable";
  if (status === 504) return "gateway_timeout";
  if (status >= 500) return "internal_error";
  return "invalid_request";
}

// ── Dashboard tenant resolver ────────────────────────────────────────
// Local to /dashboard/* routes. Does NOT change global access.ts.
// For GET: accepts ?tenant_id from operator tokens.
// For POST: accepts body.tenant_id from operator tokens.

interface DashboardAuth {
  tenantId: string;
  scope: string;
  isOperator: boolean;
}

function resolveDashboardTenant(c: any, method: "GET" | "POST" | "PATCH" = "GET", body?: any): DashboardAuth | null {
  const access = getAccessContext(c);

  // Tenant token: implicit tenantId
  if (access.tenantId) {
    return { tenantId: access.tenantId, scope: access.scope, isOperator: access.scope === "operator" };
  }

  // Operator token: explicit tenant_id required
  if (access.scope === "operator") {
    const bodyTenantId = typeof body?.tenant_id === "string"
      ? body.tenant_id.trim()
      : "";
    const tenantId = method === "GET"
      ? (c.req.query("tenant_id") || "").trim()
      : bodyTenantId;
    if (tenantId && TENANT_ID_RE.test(tenantId)) {
      return { tenantId, scope: "operator", isOperator: true };
    }
  }

  return null;
}

async function readDashboardSupercronOperatorStatus(): Promise<any> {
  try {
    const { readSupercronStatus, unavailableSupercronStatusSnapshot } = await import("../lib/supercron-status");
    try {
      return await readSupercronStatus(sql);
    } catch (error: any) {
      return unavailableSupercronStatusSnapshot(error);
    }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 240);
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      installed: {},
      quality: {
        grade: "unknown",
        last_status: null,
        last_degraded_reason: null,
        last_warning_count: 0,
        last_golden_pass_rate: null,
        last_started_at: null,
        last_finished_at: null,
      },
      degraded_reasons_24h: [],
      rollback_count_24h: 0,
      proposal_queue_depth: [],
      recall_relevance_trend: [],
      runtime_trend: [],
      cooldown_states: [],
      tier3_controller: { allowed: null, error: message, skips_last_12_cycles: 0 },
      edge_usefulness_distribution: {
        flag_ceiling: 0.2,
        flag_ceiling_configured: null,
        protection_floor: 0.7,
        protection_floor_configured: null,
        low: 0,
        mid: 0,
        high: 0,
        total: 0,
        last_computed_at: null,
        threshold_values_valid: false,
        thresholds_inverted: false,
      },
      safe_to_run_mutating_tier: {
        safe: false,
        level: "unknown",
        reasons: ["SuperCron status unavailable"],
      },
      diagnostic_hints: [`SuperCron status unavailable: ${message}`],
      recent_runs: [],
    };
  }
}

interface DashboardLocalNodeTarget {
  nodeId: string;
  publicKeyPem: string;
}

async function resolveDashboardLocalNodeTarget(tenantId: string): Promise<DashboardLocalNodeTarget | null> {
  const { loadLocalNodeIdentity } = await import("../lib/node-keypair");
  const identity = loadLocalNodeIdentity();
  if (!identity) return null;

  // The local node row is keyed by the configured sync node_id.
  // In the mismatched recovery path, the current key can derive a
  // different id than the hosted row we need to rotate/revoke/claim.
  let targetNodeId = identity.nodeId;
  try {
    const { getSyncStatus } = await import("../lib/sync-exporter");
    const localSync = await getSyncStatus(sql as any);
    if (
      localSync.tenant_id === tenantId &&
      typeof localSync.node_id === "string" &&
      localSync.node_id.trim()
    ) {
      targetNodeId = localSync.node_id.trim();
    }
  } catch {
    // sync-exporter may not be available; key-derived id is the
    // best fallback for local-only installs.
  }

  return {
    nodeId: targetNodeId,
    publicKeyPem: identity.publicKeyPem,
  };
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dashboardJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dashboardJsonArray(value: unknown): unknown[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function dashboardStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dashboardTimestampIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dashboardDateIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function dayJournalDisplayStatus(runStatus: unknown, resultStatus: unknown): string | null {
  const run = typeof runStatus === "string" && runStatus ? runStatus : null;
  const result = typeof resultStatus === "string" && resultStatus ? resultStatus : null;
  if (run === "failed" || run === "rejected" || run === "canceled" || run === "running" || run === "pending") {
    return run;
  }
  return result || run;
}

type DashboardDayJournalSettingsRow = {
  routine_id?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  config?: unknown;
  permission_grants?: unknown;
  last_dry_run_at?: unknown;
  last_dry_run_status?: unknown;
  last_scheduled_at?: unknown;
  next_run_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type DashboardDayJournalRunRow = {
  id?: unknown;
  routine_id?: unknown;
  target_path?: unknown;
  target_date?: unknown;
  target_timezone?: unknown;
  day_addr_at_run?: unknown;
  trigger?: unknown;
  run_status?: unknown;
  result_status?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  error?: unknown;
};

type DashboardDayJournalEntryRow = {
  routine_id?: unknown;
  target_path?: unknown;
  target_date?: unknown;
  day_addr?: unknown;
  result_status?: unknown;
  captured_at?: unknown;
  payload_preview?: unknown;
  source_refs?: unknown;
  updated_at?: unknown;
};

function dayJournalRoutineSettingsJson(
  row: DashboardDayJournalSettingsRow | undefined,
  def: DayJournalRoutineDefinition,
  fallbackTimezone = "UTC",
): Record<string, unknown> {
  return {
    enabled: Boolean(row?.enabled),
    schedule: typeof row?.schedule === "string" ? row.schedule : def.defaultSchedule,
    timezone: typeof row?.timezone === "string" ? row.timezone : fallbackTimezone,
    config: dashboardJsonObject(row?.config),
    permission_grants: dashboardStringArray(row?.permission_grants),
    last_dry_run_at: dashboardTimestampIso(row?.last_dry_run_at),
    last_dry_run_status: row?.last_dry_run_status || null,
    last_scheduled_at: dashboardTimestampIso(row?.last_scheduled_at),
    next_run_at: dashboardTimestampIso(row?.next_run_at),
    created_at: dashboardTimestampIso(row?.created_at),
    updated_at: dashboardTimestampIso(row?.updated_at),
  };
}

function dayJournalRoutineRunJson(row: DashboardDayJournalRunRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    routine_id: String(row.routine_id || ""),
    target_path: String(row.target_path || ""),
    target_date: dashboardDateIso(row.target_date),
    target_timezone: String(row.target_timezone || ""),
    day_addr: String(row.day_addr_at_run || ""),
    trigger: String(row.trigger || ""),
    run_status: String(row.run_status || ""),
    result_status: row.result_status || null,
    display_status: dayJournalDisplayStatus(row.run_status, row.result_status),
    started_at: dashboardTimestampIso(row.started_at),
    finished_at: dashboardTimestampIso(row.finished_at),
    error: typeof row.error === "string" && row.error ? row.error : null,
  };
}

function dayJournalRoutineEntryJson(row: DashboardDayJournalEntryRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    routine_id: String(row.routine_id || ""),
    target_path: String(row.target_path || ""),
    target_date: dashboardDateIso(row.target_date),
    day_addr: String(row.day_addr || ""),
    result_status: row.result_status || null,
    captured_at: dashboardTimestampIso(row.captured_at),
    payload_preview: dashboardJsonObject(row.payload_preview),
    source_refs: dashboardJsonArray(row.source_refs),
    updated_at: dashboardTimestampIso(row.updated_at),
  };
}

function dayJournalCapabilitiesForRoutine(def: DayJournalRoutineDefinition): string[] {
  return def.permissions.filter((permission) => permission !== "journal_write");
}

function dayJournalExternalPermissionsForRoutine(def: DayJournalRoutineDefinition): string[] {
  const external = new Set(DAY_JOURNAL_SCOPED_AUTHORITY_PERMISSIONS);
  return def.permissions.filter((permission) => external.has(permission));
}

function dayJournalRoutineNeedsAttention(routine: {
  last_run_status?: unknown;
  last_result_status?: unknown;
  last_error?: unknown;
  missing_permissions?: unknown;
}): boolean {
  return (
    routine.last_run_status === "failed" ||
    routine.last_run_status === "rejected" ||
    routine.last_result_status === "error" ||
    Boolean(routine.last_error) ||
    (Array.isArray(routine.missing_permissions) && routine.missing_permissions.length > 0)
  );
}

function dashboardDayJournalSchedulerStatusJson(
  status: DayJournalRoutineSchedulerStatusSummary | undefined,
): DayJournalRoutineSchedulerStatusSummary | null {
  if (!status) return null;
  return {
    ...status,
    last_error: null,
  };
}

export function buildDashboardDayJournalReadModel(input: {
  definitions: DayJournalRoutineDefinition[];
  defaultTimezone?: string;
  settingsRows?: Record<string, unknown>[];
  latestRunRows?: Record<string, unknown>[];
  latestEntryRows?: Record<string, unknown>[];
  recentRunRows?: Record<string, unknown>[];
  schedulerStatus?: DayJournalRoutineSchedulerStatusSummary;
}): Record<string, unknown> {
  const defaultTimezone = input.defaultTimezone || "UTC";
  const settingsRows = input.settingsRows || [];
  const latestRunRows = input.latestRunRows || [];
  const latestEntryRows = input.latestEntryRows || [];
  const recentRunRows = input.recentRunRows || [];
  const settingsById = new Map(settingsRows.map((row) => [String(row.routine_id), row as DashboardDayJournalSettingsRow]));
  const latestRunById = new Map(latestRunRows.map((row) => [String(row.routine_id), row as DashboardDayJournalRunRow]));
  const latestEntryById = new Map(latestEntryRows.map((row) => [String(row.routine_id), row as DashboardDayJournalEntryRow]));
  const routines = input.definitions.map((def) => {
    const settings = dayJournalRoutineSettingsJson(settingsById.get(def.id), def, defaultTimezone);
    const latestRun = dayJournalRoutineRunJson(latestRunById.get(def.id));
    const latestEntry = dayJournalRoutineEntryJson(latestEntryById.get(def.id));
    const latestPayloadPreview = latestEntry ? latestEntry.payload_preview : {};
    const requiredPermissions = [...def.permissions];
    const grantedPermissions = dashboardStringArray(settings.permission_grants);
    const missingPermissions = requiredPermissions.filter((permission) => !grantedPermissions.includes(permission));
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      domain: def.domain,
      sensitivity: def.sensitivity,
      routine_class: def.routineClass,
      target_path: defaultTargetPathForRoutine(def),
      required_permissions: requiredPermissions,
      granted_permissions: grantedPermissions,
      missing_permissions: missingPermissions,
      permissions_complete: missingPermissions.length === 0,
      capabilities: dayJournalCapabilitiesForRoutine(def),
      external_permissions: dayJournalExternalPermissionsForRoutine(def),
      requires_scoped_authority: routineNeedsScopedAuthority(def, "dry-run"),
      settings,
      last_run_status: latestRun ? latestRun.run_status : null,
      last_result_status: latestRun ? latestRun.result_status : null,
      last_display_status: latestRun ? latestRun.display_status : null,
      last_error: latestRun ? latestRun.error : null,
      latest_run: latestRun,
      latest_entry: latestEntry,
      latest_payload_preview: latestPayloadPreview,
      source_refs: latestEntry ? latestEntry.source_refs : [],
    };
  });
  const enabledCount = routines.filter((routine: any) => routine.settings?.enabled === true).length;
  const failingCount = routines.filter((routine: any) =>
    routine.settings?.enabled === true && dayJournalRoutineNeedsAttention(routine)
  ).length;
  return {
    ok: true,
    mode: "available",
    summary: {
      total_count: routines.length,
      enabled_count: enabledCount,
      failing_count: failingCount,
      recent_run_count: recentRunRows.length,
    },
    routines,
    recent_runs: recentRunRows.map((row) => dayJournalRoutineRunJson(row as DashboardDayJournalRunRow)).filter(Boolean),
    notes: {
      read_only: false,
      mutation_controls: true,
      run_history_limit: 20,
      control_routes: {
        dry_run: "/dashboard/day-journal/routines/:id/dry-run",
        run: "/dashboard/day-journal/routines/:id/run",
        enable: "/dashboard/day-journal/routines/:id/enable",
        disable: "/dashboard/day-journal/routines/:id/disable",
      },
      dry_run_required_permissions: [...DAY_JOURNAL_SCOPED_AUTHORITY_PERMISSIONS],
      scheduler_status: dashboardDayJournalSchedulerStatusJson(input.schedulerStatus),
    },
  };
}

export function buildDashboardDayJournalUnavailableReadModel(input: {
  definitions: DayJournalRoutineDefinition[];
  defaultTimezone?: string;
  schedulerStatus?: DayJournalRoutineSchedulerStatusSummary;
}): Record<string, unknown> {
  const defaultTimezone = input.defaultTimezone || "UTC";
  return {
    ok: false,
    mode: "unavailable",
    summary: {
      total_count: input.definitions.length,
      enabled_count: 0,
      failing_count: 0,
      recent_run_count: 0,
    },
    routines: input.definitions.map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description,
      domain: def.domain,
      sensitivity: def.sensitivity,
      routine_class: def.routineClass,
      target_path: defaultTargetPathForRoutine(def),
      required_permissions: [...def.permissions],
      granted_permissions: null,
      missing_permissions: null,
      permissions_complete: null,
      capabilities: dayJournalCapabilitiesForRoutine(def),
      external_permissions: dayJournalExternalPermissionsForRoutine(def),
      requires_scoped_authority: routineNeedsScopedAuthority(def, "dry-run"),
      settings: dayJournalRoutineSettingsJson(undefined, def, defaultTimezone),
      last_run_status: null,
      last_result_status: null,
      last_display_status: null,
      last_error: null,
      latest_run: null,
      latest_entry: null,
      latest_payload_preview: {},
      source_refs: [],
    })),
    recent_runs: [],
    notes: {
      read_only: true,
      mutation_controls: false,
      unavailable_reason: "day_journal_tables_unavailable",
      unavailable_message: "Day-journal routine read model unavailable on this node.",
      scheduler_status: dashboardDayJournalSchedulerStatusJson(input.schedulerStatus),
    },
  };
}

export function applyDashboardDayJournalControlAccess(dayJournal: Record<string, unknown>, canWrite: boolean): Record<string, unknown> {
  const notes = dayJournal.notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return dayJournal;
  const noteRecord = notes as Record<string, unknown>;
  if (!canWrite || dayJournal.mode === "unavailable") {
    noteRecord.read_only = true;
    noteRecord.mutation_controls = false;
    delete noteRecord.control_routes;
    delete noteRecord.dry_run_required_permissions;
  } else {
    noteRecord.read_only = false;
    noteRecord.mutation_controls = true;
  }
  return dayJournal;
}

async function readDashboardTenantDefaultTimezone(tenantId: string): Promise<string> {
  try {
    const [row] = await sql`
      SELECT COALESCE(metadata->'circle'->>'timezone', metadata->>'timezone') AS timezone
      FROM tenants
      WHERE tenant_id = ${tenantId}
    `;
    return typeof row?.timezone === "string" && row.timezone.trim() ? row.timezone : "UTC";
  } catch {
    return "UTC";
  }
}

async function readDashboardDayJournalRoutines(tenantId: string): Promise<Record<string, unknown>> {
  const definitions = listRoutines();
  const [defaultTimezone, schedulerStatus] = await Promise.all([
    readDashboardTenantDefaultTimezone(tenantId),
    readDayJournalRoutineSchedulerStatus(sql),
  ]);
  try {
    const [settingsRows, latestRunRows, latestEntryRows, recentRunRows] = await Promise.all([
      sql`
        SELECT routine_id, enabled, schedule, timezone, config, permission_grants,
               last_dry_run_at, last_dry_run_status, last_scheduled_at, next_run_at, created_at, updated_at
        FROM tenant_day_journal_routines
        WHERE tenant_id = ${tenantId}
      `,
      sql`
        SELECT DISTINCT ON (routine_id)
               id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
               trigger, run_status, result_status, started_at, finished_at, error
        FROM tenant_day_journal_routine_runs
        WHERE tenant_id = ${tenantId}
          AND dry_run = false
        ORDER BY routine_id, started_at DESC, id DESC
      `,
      sql`
        SELECT DISTINCT ON (routine_id)
               routine_id, target_path, target_date, day_addr, result_status, captured_at,
               payload_preview, source_refs, updated_at
        FROM tenant_day_journal_entries
        WHERE tenant_id = ${tenantId}
          AND routine_id IS NOT NULL
          AND entry_state = 'active'
        ORDER BY routine_id, captured_at DESC, entry_key DESC
      `,
      sql`
        SELECT id, routine_id, target_path, target_date, target_timezone, day_addr_at_run,
               trigger, run_status, result_status, started_at, finished_at, error
        FROM tenant_day_journal_routine_runs
        WHERE tenant_id = ${tenantId}
          AND dry_run = false
        ORDER BY started_at DESC, id DESC
        LIMIT 20
      `,
    ]);

    return buildDashboardDayJournalReadModel({
      definitions,
      defaultTimezone,
      settingsRows: settingsRows as Record<string, unknown>[],
      latestRunRows: latestRunRows as Record<string, unknown>[],
      latestEntryRows: latestEntryRows as Record<string, unknown>[],
      recentRunRows: recentRunRows as Record<string, unknown>[],
      schedulerStatus,
    });
  } catch (error) {
    console.error("[dashboard/day-journal] read model unavailable:", error);
    return buildDashboardDayJournalUnavailableReadModel({ definitions, defaultTimezone, schedulerStatus });
  }
}

async function readDashboardViSchedules(): Promise<{ rows: any[]; mode: "available" | "unavailable" }> {
  try {
    const rows = await sql`
      SELECT id, adapter_name, schedule_cron, source_input, adapter_config,
             enabled, last_run_at, last_status, last_error, last_atoms_count,
             next_run_at, total_runs, total_atoms, total_cost_usd,
             interval_seconds, created_at
      FROM vi_schedules
      ORDER BY enabled DESC, next_run_at ASC NULLS LAST
    `;
    return { rows: rows as any[], mode: "available" };
  } catch (error) {
    console.error("[dashboard/routines] vi_schedules unavailable:", error);
    return { rows: [], mode: "unavailable" };
  }
}

function hostedBaseUrlFromBody(body: any): string {
  const raw = readString(body?.hosted_base_url) || "https://verityone.app";
  const url = new URL(raw);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("hosted_base_url must use https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function localOriginFromRequest(): string {
  const numericPort = Number(process.env.VERITY_API_PORT || "3100");
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) {
    throw new Error("local dashboard port is invalid");
  }
  return `http://127.0.0.1:${numericPort}`;
}

const DASHBOARD_DAY_JOURNAL_ROUTINE_ACTIONS = new Set(["dry-run", "run", "enable", "disable"]);
const DASHBOARD_DAY_JOURNAL_REQUEST_MAX_BODY_BYTES = 128 * 1024;
const DASHBOARD_DAY_JOURNAL_PROXY_RESPONSE_MAX_BYTES = 256 * 1024;
const DASHBOARD_DAY_JOURNAL_PROXY_TIMEOUT_MS = 70_000;
const DASHBOARD_VI_SCHEDULE_PROXY_TIMEOUT_MS = 70_000;
const DASHBOARD_VI_SCHEDULE_AUDIT_TENANT_HEADER = "X-Vi-Schedule-Operator-Tenant";

function localApiProxyHostFromBind(configuredBind: string): string {
  const bind = configuredBind.trim() || "127.0.0.1";
  const unbracketed = bind.startsWith("[") && bind.endsWith("]") ? bind.slice(1, -1) : bind;
  const normalized = unbracketed.toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") return "127.0.0.1";
  if (normalized === "localhost") return "localhost";
  const ipv4Parts = normalized.split(".");
  if (
    ipv4Parts.length === 4
    && ipv4Parts[0] === "127"
    && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  ) {
    return normalized;
  }
  if (normalized === "::1") return "[::1]";
  throw new Error("local API bind must be loopback for dashboard proxying");
}

function localApiOriginForDashboardProxy(): string {
  const host = localApiProxyHostFromBind(process.env.VERITY_API_BIND || "127.0.0.1");
  const port = Number(process.env.VERITY_API_PORT || "3100");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("local API port is invalid");
  }
  return `http://${host}:${port}`;
}

function dayJournalRoutineProxyPath(routineId: string, action: string): string {
  return `/day-journal/routines/${encodeURIComponent(routineId)}/${action}`;
}

function dashboardViScheduleIdParam(c: any): string | Response {
  const raw = String(c.req.param("id") || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    return errorJson(c, "invalid_request", { message: "Schedule id must be a positive integer." });
  }
  if (!Number.isSafeInteger(Number(raw))) {
    return errorJson(c, "invalid_request", { message: "Schedule id is too large." });
  }
  return raw;
}

function dashboardViScheduleFieldValidationError(c: any, body: Record<string, unknown>): Response | undefined {
  const sourceInput = body.source_input;
  if (sourceInput !== undefined && sourceInput !== null && typeof sourceInput !== "string") {
    return errorJson(c, "invalid_request", { message: "source_input must be a string." });
  }

  const scheduleCron = body.schedule_cron;
  if (scheduleCron !== undefined && scheduleCron !== null && typeof scheduleCron !== "string") {
    return errorJson(c, "invalid_request", { message: "schedule_cron must be a string." });
  }

  const enabled = body.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return errorJson(c, "invalid_request", { message: "enabled must be a boolean." });
  }

  const intervalSeconds = body.interval_seconds;
  if (
    intervalSeconds !== undefined
    && intervalSeconds !== null
    && (typeof intervalSeconds !== "number" || !Number.isInteger(intervalSeconds) || intervalSeconds < 0)
  ) {
    return errorJson(c, "invalid_request", { message: "interval_seconds must be a non-negative integer." });
  }

  const adapterConfig = body.adapter_config;
  if (adapterConfig !== undefined && adapterConfig !== null && (typeof adapterConfig !== "object" || Array.isArray(adapterConfig))) {
    return errorJson(c, "invalid_request", { message: "adapter_config must be an object." });
  }

  return undefined;
}

function dashboardUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function dashboardDeclaredContentLength(value: string | undefined): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function readDashboardBoundedRequestText(
  c: any,
  maxBytes: number,
): Promise<{ ok: true; raw: string } | { ok: false; reason: "too_large" | "invalid" }> {
  const body = c.req?.raw?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The request is already rejected; cancel is only best-effort cleanup.
          }
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, raw: new TextDecoder().decode(bytes) };
  }

  try {
    const raw = await c.req.text();
    if (dashboardUtf8ByteLength(raw) > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, raw };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

async function readDashboardProxyResponseText(response: Response): Promise<string> {
  const declaredContentLength = Number(response.headers.get("content-length") || "0");
  if (
    Number.isFinite(declaredContentLength)
    && declaredContentLength > DASHBOARD_DAY_JOURNAL_PROXY_RESPONSE_MAX_BYTES
  ) {
    throw new Error("local API response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > DASHBOARD_DAY_JOURNAL_PROXY_RESPONSE_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The response is already rejected; cancel is only best-effort cleanup.
      }
      throw new Error("local API response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function dashboardProxyOwnField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function dashboardProxyAdapterField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  let cursor: unknown = value;
  while (cursor && typeof cursor === "object" && cursor !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cursor, key)) {
      try {
        return (value as Record<string, unknown>)[key];
      } catch {
        return undefined;
      }
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

function dashboardProxyCallAdapterMethod(value: unknown, key: string, ...args: unknown[]): unknown {
  const method = dashboardProxyAdapterField(value, key);
  if (typeof method !== "function") return undefined;
  try {
    return method.apply(value, args);
  } catch {
    return undefined;
  }
}

function dashboardProxyPayloadField(payload: any, key: string): unknown {
  return dashboardProxyOwnField(payload, key);
}

function dashboardProxyStringField(payload: any, key: string): string | undefined {
  const value = dashboardProxyPayloadField(payload, key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dashboardProxyErrorCode(payload: any, status: number): ErrorCode {
  const code = dashboardProxyPayloadField(payload, "code");
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
    ? code as ErrorCode
    : errorCodeForHttpStatus(status);
}

const DASHBOARD_PROXY_SAFE_DETAIL_KEYS = new Set([
  "routine_id",
  "run_id",
  "schedule_id",
  "existing_schedule_id",
  "target_date",
  "target_timezone",
  "day_addr",
  "status",
  "current_status",
  "max_bytes",
]);

const DASHBOARD_VI_SCHEDULE_PROXY_SAFE_DETAIL_KEYS = new Set([
  ...DASHBOARD_PROXY_SAFE_DETAIL_KEYS,
  "adapter_name",
  "source_input_normalized",
  "last_attempt_url",
  "validation_field",
  "reason",
]);

function dashboardProxySafeDetailValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value.length <= 512 ? value : value.slice(0, 512);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

function dashboardProxyDetailsField(
  payload: any,
  safeKeys: Set<string> = DASHBOARD_PROXY_SAFE_DETAIL_KEYS,
): Record<string, string | number | boolean | null> | undefined {
  const details = dashboardProxyPayloadField(payload, "details");
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const safeDetails: Record<string, string | number | boolean | null> = {};
  for (const key of safeKeys) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = dashboardProxySafeDetailValue((details as Record<string, unknown>)[key]);
    if (value !== undefined) safeDetails[key] = value;
  }
  return Object.keys(safeDetails).length > 0 ? safeDetails : undefined;
}

function dashboardProxyHttpStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

function dashboardProxyErrorJson(
  c: any,
  status: number,
  code: ErrorCode,
  opts: { message?: string; details?: unknown; hint?: string },
): Response {
  const proxyStatus = dashboardProxyHttpStatus(status);
  if (proxyStatus === undefined) return errorJson(c, code, opts);
  return c.json(buildErrorEnvelope(code, opts), proxyStatus as any);
}

function dashboardProxyHeaderValue(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[^\x20-\x7E]/.test(trimmed)) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function dashboardProxyRemoteAddressValue(value: unknown): string | undefined {
  const candidate = typeof value === "object" && value
    ? dashboardProxyAdapterField(value, "address") || dashboardProxyAdapterField(value, "hostname") || dashboardProxyAdapterField(value, "host")
    : value;
  const remoteAddress = dashboardProxyHeaderValue(candidate, 128);
  if (!remoteAddress || /[\s,;]/.test(remoteAddress)) return undefined;
  if (isIP(remoteAddress) === 0) return undefined;
  return remoteAddress;
}

function dashboardProxyForwardedForValue(value: unknown): string | undefined {
  const raw = dashboardProxyHeaderValue(value, 1024);
  if (!raw) return undefined;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const safeParts: string[] = [];
  for (const part of parts) {
    const ip = dashboardProxyRemoteAddressValue(part);
    if (!ip) return undefined;
    safeParts.push(ip);
  }
  return safeParts.join(", ");
}

function dashboardProxyRemoteAddress(c: any): string | undefined {
  const env = c.env;
  const server = dashboardProxyOwnField(env, "server");
  const incoming = dashboardProxyOwnField(env, "incoming");
  const socket = dashboardProxyOwnField(incoming, "socket");
  return dashboardProxyRemoteAddressValue(dashboardProxyOwnField(c.env, "remoteAddr"))
    || dashboardProxyRemoteAddressValue(dashboardProxyOwnField(c.env, "remoteAddress"))
    || dashboardProxyRemoteAddressValue(dashboardProxyOwnField(c.env, "clientIp"))
    || dashboardProxyRemoteAddressValue(dashboardProxyCallAdapterMethod(server, "requestIP", c.req?.raw))
    || dashboardProxyRemoteAddressValue(dashboardProxyAdapterField(socket, "remoteAddress"))
    || dashboardProxyRemoteAddressValue(c.get?.("remoteAddr"))
    || dashboardProxyRemoteAddressValue(c.get?.("remote_addr"));
}

function dashboardProxyForwardedForHeader(c: any): string | undefined {
  const forwardedFor = dashboardProxyForwardedForValue(c.req.header("X-Forwarded-For"));
  const remoteAddress = dashboardProxyRemoteAddress(c);
  if (!forwardedFor) return remoteAddress;
  if (!remoteAddress) return forwardedFor;
  const suffix = ", " + remoteAddress;
  const maxLength = 1024;
  const incomingBudget = maxLength - suffix.length;
  if (incomingBudget <= 0) return remoteAddress;
  const boundedForwardedFor = forwardedFor.length > incomingBudget
    ? forwardedFor.slice(0, incomingBudget).replace(/[\s,]+$/g, "")
    : forwardedFor;
  return boundedForwardedFor ? boundedForwardedFor + suffix : remoteAddress;
}

function dashboardProxyForwardedProtoValue(value: unknown): string | undefined {
  const proto = dashboardProxyHeaderValue(value, 16)?.toLowerCase();
  return proto === "http" || proto === "https" ? proto : undefined;
}

function dashboardProxyForwardedProtoHeader(c: any): string | undefined {
  const forwardedProto = dashboardProxyForwardedProtoValue(c.req.header("X-Forwarded-Proto"));
  if (forwardedProto) return forwardedProto;
  try {
    return dashboardProxyForwardedProtoValue(new URL(c.req.url).protocol.replace(/:$/, ""));
  } catch {
    return undefined;
  }
}

function dashboardProxyForwardedHostValue(value: unknown): string | undefined {
  const host = dashboardProxyHeaderValue(value);
  if (!host || /[\s,;\/\\]/.test(host)) return undefined;
  return host;
}

function dashboardProxyForwardedHostHeader(c: any): string | undefined {
  const forwardedHost = dashboardProxyForwardedHostValue(c.req.header("X-Forwarded-Host"));
  if (forwardedHost) return forwardedHost;
  const host = dashboardProxyForwardedHostValue(c.req.header("Host"));
  if (host) return host;
  try {
    return dashboardProxyForwardedHostValue(new URL(c.req.url).host);
  } catch {
    return undefined;
  }
}

function dashboardProxyTenantHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tenant = value.trim();
  if (
    !tenant
    || tenant.length > 128
    || /[^\x20-\x7E]/.test(tenant)
    || /[\s,;]/.test(tenant)
    || !TENANT_ID_RE.test(tenant)
  ) {
    return undefined;
  }
  return tenant;
}

function dashboardProxyHeaders(
  c: any,
  token: string,
  options: { viScheduleAuditTenant?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  const forwardedFor = dashboardProxyForwardedForHeader(c);
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
  const forwardedProto = dashboardProxyForwardedProtoHeader(c);
  if (forwardedProto) headers["X-Forwarded-Proto"] = forwardedProto;
  const forwardedHost = dashboardProxyForwardedHostHeader(c);
  if (forwardedHost) headers["X-Forwarded-Host"] = forwardedHost;
  const requestId = dashboardProxyHeaderValue(c.req.header("X-Request-Id"))
    ?? dashboardProxyHeaderValue(c.get?.("correlation_id"));
  if (requestId) headers["X-Request-Id"] = requestId;
  const auditTenant = dashboardProxyTenantHeaderValue(options.viScheduleAuditTenant);
  if (auditTenant) headers[DASHBOARD_VI_SCHEDULE_AUDIT_TENANT_HEADER] = auditTenant;
  return headers;
}

async function readDashboardProxyJsonPayload(
  c: any,
  response: Response,
  label: string,
  invalidMessage: string,
): Promise<{ ok: true; payload: any } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await readDashboardProxyResponseText(response);
  } catch (error) {
    console.error(`[dashboard/${label}] proxy returned an invalid response:`, error);
    return {
      ok: false,
      response: errorJson(c, "bad_gateway", { message: invalidMessage }),
    };
  }
  if (!text) return { ok: true, payload: null };
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: true, payload: undefined };
  }
}

async function proxyDashboardDayJournalRoutineAction(c: any, body: Record<string, unknown>): Promise<Response> {
  const routineId = String(c.req.param("id") || "").trim();
  const action = String(c.req.param("action") || "").trim();
  if (!routineId) return errorJson(c, "invalid_request", { message: "routine id is required." });
  if (!DASHBOARD_DAY_JOURNAL_ROUTINE_ACTIONS.has(action)) {
    return errorJson(c, "not_found", { message: "Day journal routine dashboard action not found." });
  }

  const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  let proxyRes: Response;
  try {
    proxyRes = await fetch(localApiOriginForDashboardProxy() + dayJournalRoutineProxyPath(routineId, action), {
      method: "POST",
      headers: dashboardProxyHeaders(c, token),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(DASHBOARD_DAY_JOURNAL_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[dashboard/day-journal] routine action proxy failed:", error);
    return errorJson(c, "bad_gateway", { message: "Day journal routine local API proxy failed." });
  }
  if (proxyRes.status >= 300 && proxyRes.status < 400) {
    return errorJson(c, "bad_gateway", { message: "Day journal routine local API returned a redirect." });
  }
  const read = await readDashboardProxyJsonPayload(
    c,
    proxyRes,
    "day-journal",
    "Day journal routine local API returned an invalid response.",
  );
  if (!read.ok) return read.response;
  const payload = read.payload;
  if (proxyRes.ok && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    return errorJson(c, "bad_gateway", { message: "Day journal routine local API returned an invalid response." });
  }
  if (!proxyRes.ok) {
    const code = dashboardProxyErrorCode(payload, proxyRes.status);
    const details = dashboardProxyDetailsField(payload);
    const hint = dashboardProxyStringField(payload, "hint");
    return dashboardProxyErrorJson(c, proxyRes.status, code, {
      message:
        dashboardProxyStringField(payload, "error")
        || dashboardProxyStringField(payload, "message")
        || "Day journal routine action failed.",
      ...(details !== undefined ? { details } : {}),
      ...(hint ? { hint } : {}),
    });
  }
  return c.json(payload && typeof payload === "object" ? payload : { ok: true });
}

async function proxyDashboardViScheduleAction(
  c: any,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: Record<string, unknown> | undefined,
  viScheduleAuditTenant: string,
  fallbackFailureMessage: string,
): Promise<{ ok: true; payload: any; status: number } | { ok: false; response: Response }> {
  const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  let proxyRes: Response;
  try {
    proxyRes = await fetch(localApiOriginForDashboardProxy() + path, {
      method,
      headers: dashboardProxyHeaders(c, token, { viScheduleAuditTenant }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(DASHBOARD_VI_SCHEDULE_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[dashboard/routines] schedule proxy failed:", error);
    return {
      ok: false,
      response: errorJson(c, "bad_gateway", { message: "Schedule local API proxy failed." }),
    };
  }
  if (proxyRes.status >= 300 && proxyRes.status < 400) {
    return {
      ok: false,
      response: errorJson(c, "bad_gateway", { message: "Schedule local API returned a redirect." }),
    };
  }
  const read = await readDashboardProxyJsonPayload(
    c,
    proxyRes,
    "vi-schedules",
    "Schedule local API returned an invalid response.",
  );
  if (!read.ok) return read;
  const payload = read.payload;
  if (proxyRes.ok && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    return {
      ok: false,
      response: errorJson(c, "bad_gateway", { message: "Schedule local API returned an invalid response." }),
    };
  }
  if (!proxyRes.ok) {
    const code = dashboardProxyErrorCode(payload, proxyRes.status);
    const details = dashboardProxyDetailsField(payload, DASHBOARD_VI_SCHEDULE_PROXY_SAFE_DETAIL_KEYS);
    const hint = dashboardProxyStringField(payload, "hint");
    return {
      ok: false,
      response: dashboardProxyErrorJson(c, proxyRes.status, code, {
        message:
          dashboardProxyStringField(payload, "error")
          || dashboardProxyStringField(payload, "message")
          || fallbackFailureMessage,
        ...(details !== undefined ? { details } : {}),
        ...(hint ? { hint } : {}),
      }),
    };
  }
  return { ok: true, payload, status: proxyRes.status };
}

async function readDashboardJsonObject(
  c: any,
  tooLargeMessage = "Dashboard request body is too large.",
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const mediaType = (c.req.header("content-type") || "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      response: errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" }),
    };
  }
  const declaredContentLength = dashboardDeclaredContentLength(c.req.header("content-length"));
  if (declaredContentLength === "invalid") {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Content-Length must be a non-negative integer." }),
    };
  }
  if (
    declaredContentLength !== undefined
    && declaredContentLength > DASHBOARD_DAY_JOURNAL_REQUEST_MAX_BODY_BYTES
  ) {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: tooLargeMessage,
        details: { max_bytes: DASHBOARD_DAY_JOURNAL_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }
  const read = await readDashboardBoundedRequestText(c, DASHBOARD_DAY_JOURNAL_REQUEST_MAX_BODY_BYTES);
  if (!read.ok && read.reason === "too_large") {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: tooLargeMessage,
        details: { max_bytes: DASHBOARD_DAY_JOURNAL_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }
  if (!read.ok) {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }
  const raw = read.raw;
  let body: unknown;
  try {
    body = raw === "" ? null : JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

const LOCAL_CONNECT_START_WINDOW_MS = 60 * 1000;
const LOCAL_CONNECT_START_MAX = 5;
const localConnectStartHits = new Map<string, number[]>();

function assertLocalConnectStartBudget(tenantId: string): boolean {
  const now = Date.now();
  const key = `${tenantId}:${process.env.VO_CONFIG_PATH || ""}`;
  const hits = (localConnectStartHits.get(key) || []).filter(
    (hit) => now - hit < LOCAL_CONNECT_START_WINDOW_MS,
  );
  if (hits.length >= LOCAL_CONNECT_START_MAX) {
    localConnectStartHits.set(key, hits);
    return false;
  }
  hits.push(now);
  localConnectStartHits.set(key, hits);
  return true;
}

// ── GET /dashboard — HTML shell ──────────────────────────────────────

dashboard.get("/", (c) => {
  return c.html(DASHBOARD_HTML);
});

// ── GET /dashboard/overview ──────────────────────────────────────────

dashboard.get("/overview", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required. Use tenant token or operator token with ?tenant_id=<id>." });
  }

  const { getDashboardOverview } = await import("../lib/dashboard-overview");
  const { buildAttentionSurface } = await import("../lib/attention-surface");
  const [overview, supercronOperatorStatus] = await Promise.all([
    getDashboardOverview(sql as any, auth.tenantId),
    auth.isOperator ? readDashboardSupercronOperatorStatus() : Promise.resolve(null),
  ]);

  // LW5: the ranked attention surface (#66) over the producers VO now persists — the
  // tenant's open review_proposals (LW4) + supercron quality (operators) + the existing
  // needs_attention rows — under the tenant's #10 policy (LW3). Additive: the existing
  // needs_attention field is untouched, and a failure here degrades to an empty surface
  // rather than 500ing the whole (previously working) overview.
  const attentionGeneratedAt = new Date().toISOString();
  const attention = await buildAttentionSurface(sql as any, {
    tenantId: auth.tenantId,
    dashboardRows: overview.needs_attention,
    generatedAt: attentionGeneratedAt,
    includeQuality: auth.isOperator,
  }).catch((e) => {
    console.error("[dashboard/overview] attention surface failed; degrading:", e instanceof Error ? e.message : e);
    return { tenant_id: auth.tenantId, generated_at: attentionGeneratedAt, items: [], by_severity: { high: 0, medium: 0, low: 0 }, by_category: {} as Record<string, number>, dropped: [] };
  });

  return c.json({
    ...overview,
    attention,
    ...(supercronOperatorStatus ? { supercron_operator_status: supercronOperatorStatus } : {}),
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_review: true, can_structure_write: auth.isOperator },
  });
});

// ── GET /dashboard/structure ─────────────────────────────────────────

dashboard.get("/structure", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const spaceId = `tenant:${auth.tenantId}`;
  const { ensureTenantPyramids, listTenantPyramids } = await import("../lib/tenant-pyramids");
  const { ensureProjectPyramidMembership } = await import("../lib/tenant-pyramids");
  const { listProjects } = await import("../lib/project-registry");

  await ensureTenantPyramids(sql, auth.tenantId);
  await ensureProjectPyramidMembership(sql, auth.tenantId);

  const pyramids = await listTenantPyramids(sql, auth.tenantId);
  const projects = await listProjects(sql, spaceId);

  const activeProjects = projects.filter((p: any) => !p.dormant_at);
  const archivedProjects = projects.filter((p: any) => p.dormant_at);

  // Hygiene
  const pyramidsMissingDesc = pyramids.filter((p: any) => !p.description).length;
  const projectsMissingDesc = activeProjects.filter((p: any) => !p.description).length;
  const emptyPyramids = pyramids.filter((p: any) => {
    return !activeProjects.some((proj: any) => proj.tenant_pyramid_id === p.pyramid_id);
  }).length;

  return c.json({
    ok: true,
    tenant_id: auth.tenantId,
    pyramids,
    projects: { active: activeProjects, archived: archivedProjects },
    hygiene: {
      pyramids_missing_description_count: pyramidsMissingDesc,
      projects_missing_description_count: projectsMissingDesc,
      empty_pyramids_count: emptyPyramids,
    },
    _auth: { scope: auth.scope, can_write: auth.isOperator },
  });
});

// ── GET /dashboard/review ────────────────────────────────────────────

dashboard.get("/review", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const rawLimit = parseInt(c.req.query("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const cursor = c.req.query("cursor") || null;

  const { listReviewableMemories } = await import("../lib/memory-audit");
  const page = await listReviewableMemories(sql as any, auth.tenantId, limit, cursor);

  return c.json({
    ok: true,
    items: page.items,
    count: page.items.length,
    // total = the WHOLE backlog (not just this page) + a cursor for the next page, so the
    // operator can never mistake a truncated page for an empty queue.
    total: page.total,
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_approve: auth.isOperator, can_retract: auth.isOperator },
  });
});

// ── GET /dashboard/review/:addr/audit ────────────────────────────────

dashboard.get("/review/:addr/audit", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const addr = c.req.param("addr");
  const rawLimit = parseInt(c.req.query("limit") || "10", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;

  const { getMemoryAuditSnapshot } = await import("../lib/memory-audit");
  const snapshot = await getMemoryAuditSnapshot(sql as any, auth.tenantId, addr, limit);

  if (!snapshot) {
    return errorJson(c, "memory_not_found", { message: "Memory not found" });
  }

  return c.json({ ok: true, ...snapshot });
});

// ── POST /dashboard/review/:addr/approve ─────────────────────────────

dashboard.post("/review/:addr/approve", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for approval." });
  }

  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }

  const addr = c.req.param("addr");
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  const { approveMemory } = await import("../lib/memory-approve");
  const result = await approveMemory(sql as any, auth.tenantId, addr, { actor: "operator:dashboard", isHuman: true }, reason);

  if (!result.ok) {
    return c.json(result, 400);
  }
  return c.json(result);
});

// ── POST /dashboard/review/:addr/retract ─────────────────────────────

dashboard.post("/review/:addr/retract", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required for retraction." });
  }

  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }

  const addr = c.req.param("addr");
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  const { retractMemory } = await import("../lib/memory-retract");
  const result = await retractMemory(sql as any, auth.tenantId, addr, "operator:dashboard", reason);

  if (!result.ok) {
    return errorJson(c, "not_found", { message: result.error });
  }
  return c.json({ ok: true, addr: result.addr, status: result.status });
});

// ── GET /dashboard/sessions ───────────────────────────────────────────
// Rung 7b + rung 11b: federation activity feed grouped by
// session_type. Distinct from /dashboard/activity (memory-
// activity) — renders local-mcp-client from live process scan and
// the hosted session types from federation_activity rows, including
// the rung-11b hosted-mcp-connector actor class.

dashboard.get("/sessions", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const { computeActivityFreshness, ACTIVITY_SESSION_TYPES } = await import(
    "../lib/federation-activity-health"
  );
  const { listActiveMcpClients } = await import("../lib/mcp-process-scan");

  // ── 1. Hosted rows: latest event per (session_type, session_id).
  //    DISTINCT ON requires its keys to lead ORDER BY; ts DESC
  //    within each group picks the latest event.
  let hostedRows: any[] = [];
  try {
    hostedRows = await sql`
      SELECT DISTINCT ON (session_type, session_id)
        session_type, session_id, ts AS last_event_at, event_type, outcome
      FROM federation_activity
      WHERE tenant_id = ${auth.tenantId}
      ORDER BY session_type, session_id, ts DESC
    `;
  } catch { /* table may not exist on very old installs */ }

  const sessions: Record<string, any[]> = {
    "local-mcp-client": [],
    "hosted-browser-session": [],
    "hosted-mcp-agent": [],
    "sync-node": [],
    "hosted-mcp-connector": [],
  };

  for (const row of hostedRows) {
    const freshness = computeActivityFreshness({
      lastEventAt: typeof row.last_event_at === "string"
        ? row.last_event_at
        : row.last_event_at?.toISOString?.() ?? null,
    });
    const sessionArray = sessions[row.session_type];
    if (sessionArray) {
      sessionArray.push({
        session_id: row.session_id,
        last_event_at: row.last_event_at,
        last_event_type: row.event_type,
        outcome: row.outcome,
        freshness,
      });
    }
  }

  // ── 2. Local MCP clients — only when the viewed tenant matches
  //    the local machine's configured tenant. Mirrors the
  //    syncTenantMismatch gate in /dashboard/account so hosted
  //    presence is never misattributed across tenants.
  let localMcpClientVisibility:
    | "active"
    | "cross_tenant_suppressed"
    | "no_local_config" = "no_local_config";
  try {
    const { getSyncStatus } = await import("../lib/sync-exporter");
    const localSync = await getSyncStatus(sql as any);
    const localTenantId = typeof localSync?.tenant_id === "string"
      ? localSync.tenant_id.trim()
      : "";
    if (localTenantId && localTenantId === auth.tenantId) {
      localMcpClientVisibility = "active";
      const clients = await listActiveMcpClients();
      sessions["local-mcp-client"] = clients.map((client) => ({
        session_id: String(client.pid),
        pid: client.pid,
        started_at: client.started_at,
        // Local presence: a running process IS the freshness evidence.
        // Age-from-start would falsely render a healthy long-lived
        // client as `stale`; use `active` unconditionally. Persistent
        // per-tool activity tracking defers to the Q4=A follow-on.
        freshness: "active" as const,
      }));
    } else if (localTenantId) {
      localMcpClientVisibility = "cross_tenant_suppressed";
    }
  } catch { /* sync-exporter unavailable — keep no_local_config */ }

  // ── 3. Summary.
  const by_type: Record<string, number> = {};
  let total = 0;
  let active = 0;
  for (const type of ACTIVITY_SESSION_TYPES) {
    const list = sessions[type];
    by_type[type] = list.length;
    total += list.length;
    active += list.filter((s) => s.freshness === "active").length;
  }

  return c.json({
    ok: true,
    sessions,
    local_mcp_client_visibility: localMcpClientVisibility,
    summary: {
      total_sessions: total,
      active_count: active,
      by_type,
    },
    _auth: { tenant_id: auth.tenantId, scope: auth.scope },
  });
});

// ── GET /dashboard/activity ───────────────────────────────────────────

dashboard.get("/activity", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const rawLimit = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const projectAddr = c.req.query("project_addr") || null;

  const { listRecentTenantEvents } = await import("../lib/memory-lifecycle");
  const items = await listRecentTenantEvents(sql as any, auth.tenantId, limit, projectAddr);

  // Get projects list for the filter control
  const projectRows = await sql`
    SELECT addr, label FROM nodes
    WHERE pyramid_id = 'PROJECTS' AND depth = 1 AND space_id = ${"tenant:" + auth.tenantId} AND dormant_at IS NULL
      AND visibility <> 'deleted'
    ORDER BY label
  `;

  return c.json({
    ok: true,
    items: items.map((e: any) => ({
      addr: e.addr,
      label: e.label,
      kind: e.kind,
      event_type: e.event_type,
      actor: e.actor,
      created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at || ""),
      event_data: e.event_data,
      project_addr: e.project_addr,
    })),
    count: items.length,
    filters: { project_addr: projectAddr, limit },
    projects: projectRows.map((p: any) => ({ addr: p.addr, label: p.label })),
    _auth: { tenant_id: auth.tenantId, scope: auth.scope },
  });
});

// ── GET /dashboard/settings ──────────────────────────────────────────

dashboard.get("/settings", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const { resolveTenantSettings } = await import("../lib/runtime-profile");
  const { readTenantSettings } = await import("../lib/tenant-settings");
  const { resolvePolicyProfile } = await import("../lib/policy-profile");
  const settings = resolveTenantSettings();
  const tenantSettings = await readTenantSettings(sql as any, auth.tenantId);
  // LW3: resolve the tenant's policy posture (#10) to its concrete knob bundle so the
  // setting is observable end-to-end (the same resolution LW5 feeds to aggregateAttention).
  const resolvedPolicy = resolvePolicyProfile(tenantSettings.policy_profile);

  // Tenant-owned agents only (from VERITY_AGENT_TENANTS)
  const agentTenantStr = process.env.VERITY_AGENT_TENANTS || "";
  const tenantAgentIds: string[] = [];
  for (const pair of agentTenantStr.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [aid, tid] = pair.split(":").map((s) => s.trim());
    if (tid === auth.tenantId && aid) tenantAgentIds.push(aid);
  }

  const agents: Array<{ agent_id: string; last_seen: string | null; policy: unknown; effective_policy: unknown }> = [];
  if (tenantAgentIds.length > 0) {
    const { resolveAgentPolicy } = await import("../lib/agent-policy");
    const rows = await sql`
      SELECT agent_id, metadata, last_seen FROM agent_profiles
      WHERE tenant_id = ${auth.tenantId} AND agent_id = ANY(${tenantAgentIds})
    `;
    for (const row of rows) {
      const effective = resolveAgentPolicy(
        row.agent_id,
        row.metadata as Record<string, unknown> | null,
        settings as any,
      );
      agents.push({
        agent_id: row.agent_id,
        last_seen: row.last_seen || null,
        policy: (row.metadata as any)?.policy || null,
        effective_policy: effective,
      });
    }
    // Include mapped agents that have no profile row yet
    for (const aid of tenantAgentIds) {
      if (!agents.find((a) => a.agent_id === aid)) {
        const effective = resolveAgentPolicy(aid, null, settings as any);
        agents.push({ agent_id: aid, last_seen: null, policy: null, effective_policy: effective });
      }
    }
  }

  // Active projects for visible_projects selection
  const projectRows = await sql`
    SELECT addr, label FROM nodes
    WHERE pyramid_id = 'PROJECTS' AND depth = 1 AND space_id = ${"tenant:" + auth.tenantId} AND dormant_at IS NULL
      AND visibility <> 'deleted'
    ORDER BY label
  `;

  return c.json({
    ok: true,
    machine_settings: {
      vo_enabled: settings.vo_enabled,
      // R2: trends_enabled is the machine-level kill switch for the
      // trend reactor pipeline. Defaults to false; operator opts in
      // from the Trends tab (which reads this same JSON).
      trends_enabled: settings.trends_enabled,
      public_resonance: settings.public_resonance,
      hosted_sync: settings.hosted_sync,
      vault_sync: settings.vault_sync,
      public_overlay_sync: settings.public_overlay_sync,
    },
    tenant_settings: tenantSettings,
    resolved_policy: resolvedPolicy,
    agents,
    projects: projectRows.map((p: any) => ({ addr: p.addr, label: p.label })),
    _auth: {
      tenant_id: auth.tenantId,
      scope: auth.scope,
      can_write: auth.isOperator,
      machine_settings_can_write: auth.isOperator,
      tenant_settings_can_write: auth.isOperator || auth.scope === "beta",
    },
  });
});

// ── POST /dashboard/settings/toggle ──────────────────────────────────

dashboard.post("/settings/toggle", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const access = getAccessContext(c);
  const scope = body.scope === "tenant" ? "tenant" : "machine";
  const key = ((body.key as string) || "").trim();
  const value = body.value;

  if (scope === "machine") {
    if (!isOperator(c)) {
      return errorJson(c, "operator_required", { message: "Operator auth required." });
    }

    const auth = resolveDashboardTenant(c, "POST", body);
    if (!auth) {
      return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
    }

    const { writeTenantSetting, WRITABLE_SETTINGS_KEYS } = await import("../lib/runtime-profile");
    if (!WRITABLE_SETTINGS_KEYS.includes(key as any)) {
      return errorJson(c, "invalid_request", { message: `Invalid setting key: ${key}. Must be one of: ${WRITABLE_SETTINGS_KEYS.join(", ")}` });
    }

    try {
      const result = writeTenantSetting(key as any, value, { sql: sql as any, tenantId: auth.tenantId });
      return c.json({ ok: true, scope, key, previous: result.previous, next: result.next });
    } catch (e) {
      console.error("[dashboard/settings/write] failed:", e);
      return errorJson(c, "invalid_request", { message: "Tenant setting update failed" });
    }
  }

  const tenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  const tenantAllowed = access.scope === "operator" || (access.scope === "beta" && access.tenantId === tenantId);
  if (!tenantAllowed) {
    return errorJson(c, "forbidden", { message: "Tenant-scope settings require operator or matching tenant beta token." });
  }

  const tenantSettingsLib = await import("../lib/tenant-settings");
  const writableTenantKeys = tenantSettingsLib.WRITABLE_TENANT_SETTINGS_KEYS as readonly string[];
  if (!writableTenantKeys.includes(key)) {
    return errorJson(c, "invalid_request", { message: `Invalid tenant setting key: ${key}. Must be one of: ${writableTenantKeys.join(", ")}` });
  }

  try {
    const result = await tenantSettingsLib.writeTenantSetting(sql as any, tenantId, key as any, value);
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId,
      actor: access.scope === "operator" ? "operator" : (access.agentId || tenantId),
      actorKind: access.scope === "operator" ? "operator_token" : "tenant_session",
      operation: "tenant_settings_changed",
      eventData: { settingKey: key, previous: result.previous, next: result.next, scope: "tenant" },
    });
    return c.json({ ok: true, scope, key, previous: result.previous, next: result.next });
  } catch (e: any) {
    console.error("[dashboard/settings/tenant-write] failed:", e);
    if (e?.name === "TenantNotFoundError") {
      return errorJson(c, "tenant_not_found", { message: "Tenant not found." });
    }
    return errorJson(c, "invalid_request", { message: "Tenant setting update failed" });
  }
});

// ── POST /dashboard/review-proposals/:id — resolve/dismiss/defer (OA1) ─────
//
// The action half of LW4/LW5: transition a #65 review proposal out of `open`.
// Tenant-scoped (a caller can only act on its OWN tenant's proposals) + open-only,
// status-transition ONLY (never mutates a memory/node/edge). Audited.
dashboard.post("/review-proposals/:id", async (c) => {
  // Body first: an OPERATOR token names the tenant via body.tenant_id, so the tenant
  // resolver needs the parsed body (mirrors the sibling tenant-write POSTs).
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const auth = resolveDashboardTenant(c, "POST", read.body);
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required (operators pass tenant_id in the body)." });
  }
  // Strict integer id (review_proposals.id is BIGINT): reject loose forms like "1e3"
  // and ids beyond the safe-integer range rather than silently mis-targeting a row.
  const idRaw = c.req.param("id");
  if (!/^[0-9]+$/.test(idRaw) || Number(idRaw) > Number.MAX_SAFE_INTEGER) {
    return errorJson(c, "invalid_request", { message: "review proposal id must be a positive integer." });
  }
  const id = Number(idRaw);
  const { REVIEW_PROPOSAL_ACTIONS, isReviewProposalAction, resolveReviewProposal } =
    await import("../lib/review-proposal-resolve");
  const action = read.body.action;
  if (!isReviewProposalAction(action)) {
    return errorJson(c, "invalid_request", { message: `action must be one of: ${REVIEW_PROPOSAL_ACTIONS.join(", ")}` });
  }
  const deferDaysRaw = read.body.defer_days;
  const result = await resolveReviewProposal(sql as any, {
    id,
    tenantId: auth.tenantId,
    action,
    deferDays: typeof deferDaysRaw === "number" ? deferDaysRaw : undefined,
    generatedAt: new Date().toISOString(),
  });
  if (!result.ok) {
    return errorJson(c, "not_found", {
      message: "Review proposal not found, not owned by this tenant, or already closed.",
    });
  }
  const access = getAccessContext(c);
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: auth.tenantId,
    actor: auth.isOperator ? "operator" : (access.agentId || auth.tenantId),
    actorKind: auth.isOperator ? "operator_token" : "tenant_session",
    operation: "review_proposal_resolved",
    eventData: { review_proposal_id: id, action, status: result.proposal.status },
  });
  return c.json({ ok: true, proposal: result.proposal });
});

// ── POST /dashboard/conflicts/:id — resolve/dismiss a detected conflict (OA3) ──
//
// The action half of the conflict queue: close ONE detected memory_conflict.
// Tenant-scoped (a caller can only close its OWN tenant's conflicts) + detected-only,
// status-transition ONLY — it never retires/mutates either memory (the destructive
// retire-the-loser half is a separate OA rung). Audited.
dashboard.post("/conflicts/:id", async (c) => {
  // Body first: an OPERATOR token names the tenant via body.tenant_id, so the tenant
  // resolver needs the parsed body (mirrors the sibling tenant-write POSTs).
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const auth = resolveDashboardTenant(c, "POST", read.body);
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required (operators pass tenant_id in the body)." });
  }
  // Strict integer id (memory_conflicts.id is BIGINT): reject loose forms like "1e3"
  // and ids beyond the safe-integer range rather than silently mis-targeting a row.
  const idRaw = c.req.param("id");
  if (!/^[0-9]+$/.test(idRaw) || Number(idRaw) > Number.MAX_SAFE_INTEGER) {
    return errorJson(c, "invalid_request", { message: "conflict id must be a positive integer." });
  }
  const id = Number(idRaw);
  const { CONFLICT_CLOSE_ACTIONS, isConflictCloseAction, closeConflict } =
    await import("../lib/conflict-closure");
  const action = read.body.action;
  if (!isConflictCloseAction(action)) {
    return errorJson(c, "invalid_request", { message: `action must be one of: ${CONFLICT_CLOSE_ACTIONS.join(", ")}` });
  }
  // actor is resolved BEFORE the close (unlike OA1) because OA3 persists it into the
  // row's resolved_by — closeConflict needs it as the resolvedBy argument.
  const access = getAccessContext(c);
  const actor = auth.isOperator ? "operator" : (access.agentId || auth.tenantId);
  const result = await closeConflict(sql as any, {
    id,
    tenantId: auth.tenantId,
    action,
    resolvedBy: actor,
  });
  if (!result.ok) {
    // Deliberately non-disambiguating (mirrors OA1): not revealing WHICH of absent /
    // foreign-tenant / already-closed matched prevents cross-tenant id enumeration.
    return errorJson(c, "not_found", {
      message: "Conflict not found, not owned by this tenant, or already closed.",
    });
  }
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: auth.tenantId,
    actor,
    actorKind: auth.isOperator ? "operator_token" : "tenant_session",
    operation: "memory_conflict_closed",
    eventData: { conflict_id: id, action, status: result.conflict.status },
  });
  return c.json({ ok: true, conflict: result.conflict });
});

// ── POST /dashboard/conflicts/:id/resolve — retire the loser, keep the winner (DESTRUCTIVE) ──
//
// The destructive half deferred from OA3: the operator picks the WINNER of a detected conflict
// and the LOSER is retired (superseded by the winner) + the conflict resolved, atomically.
// DRY-RUN is the DEFAULT (the preview is read-only); apply requires explicit dry_run:false.
// Protected losers / ineligible winners are refused; tenant-scoped + detected-only; audited.
dashboard.post("/conflicts/:id/resolve", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const auth = resolveDashboardTenant(c, "POST", read.body);
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required (operators pass tenant_id in the body)." });
  }
  const idRaw = c.req.param("id");
  if (!/^[0-9]+$/.test(idRaw) || Number(idRaw) > Number.MAX_SAFE_INTEGER) {
    return errorJson(c, "invalid_request", { message: "conflict id must be a positive integer." });
  }
  const id = Number(idRaw);
  const winnerAddr = read.body.winner_addr;
  const { isValidAddr } = await import("@verity-one/graph-shape");
  if (typeof winnerAddr !== "string" || !isValidAddr(winnerAddr)) {
    return errorJson(c, "invalid_request", { message: "winner_addr must be a valid graph address." });
  }
  // Dry-run is the DEFAULT — the caller must explicitly pass dry_run:false to retire the loser.
  const dryRun = read.body.dry_run !== false;
  const access = getAccessContext(c);
  const actor = auth.isOperator ? "operator" : (access.agentId || auth.tenantId);
  const { resolveConflictWithWinner } = await import("../lib/conflict-resolution");
  const result = await resolveConflictWithWinner(sql as any, {
    id,
    tenantId: auth.tenantId,
    winnerAddr,
    dryRun,
    resolvedBy: actor,
  });
  if (!result.ok) {
    if (result.reason === "not_found") {
      // Deliberately non-disambiguating (mirrors OA3): no cross-tenant id enumeration.
      return errorJson(c, "not_found", { message: "Conflict not found, not owned by this tenant, or already closed." });
    }
    if (result.reason === "winner_not_in_pair") {
      return errorJson(c, "invalid_request", { message: "winner_addr must be one of the conflict's two memories." });
    }
    // Feasibility refusals (loser_protected / winner_not_eligible / transition_failed) are
    // operator-actionable results on a conflict the caller already OWNS (tenant-authenticated),
    // so there is no cross-tenant enumeration concern — return 200 with the reason. (not_found
    // above stays deliberately non-disambiguating because it spans the cross-tenant case.)
    return c.json({ ok: false, reason: result.reason, detail: result.detail });
  }
  // Audit only a real mutation — a dry run changes nothing.
  if (!dryRun) {
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: auth.tenantId,
      actor,
      actorKind: auth.isOperator ? "operator_token" : "tenant_session",
      operation: "conflict_resolved_with_winner",
      eventData: { conflict_id: id, winner_addr: result.winner, loser_addr: result.loser, outcome: result.outcome },
    });
  }
  return c.json({ ok: true, outcome: result.outcome, winner: result.winner, loser: result.loser });
});

// ── POST /dashboard/memory-repair/:addr — reconcile a torn registry↔node pair (OA4) ──
//
// Safe lifecycle repair. inv1 (registry 'active' over an already-dead node) → park the
// registry at a terminal status so the two agree (NON-destructive — recall already excludes
// the dead node). inv2 (retired registry over a live node) is ambiguous and REFUSED
// (requires_decision → the destructive retire rung). Tenant-scoped, dry-run-FIRST (the caller
// must pass dry_run:false to apply), audited. Never mutates a node.
dashboard.post("/memory-repair/:addr", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const auth = resolveDashboardTenant(c, "POST", read.body);
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required (operators pass tenant_id in the body)." });
  }
  const addr = c.req.param("addr");
  const { isValidAddr } = await import("@verity-one/graph-shape");
  if (!isValidAddr(addr)) {
    return errorJson(c, "invalid_request", { message: "memory addr is not a valid graph address." });
  }
  // Dry-run is the DEFAULT — the caller must explicitly pass dry_run:false to mutate.
  const dryRun = read.body.dry_run !== false;
  const access = getAccessContext(c);
  const actor = auth.isOperator ? "operator" : (access.agentId || auth.tenantId);
  const { repairMemoryLifecycle, REPAIR_DECISION_OPTIONS } = await import("../lib/lifecycle-repair");
  const result = await repairMemoryLifecycle(sql as any, {
    addr,
    tenantId: auth.tenantId,
    dryRun,
    repairedBy: actor,
  });
  if (!result.ok) {
    // Deliberately non-disambiguating (mirrors OA1/OA3): not revealing whether the addr is
    // absent vs owned by another tenant prevents cross-tenant addr enumeration.
    return errorJson(c, "not_found", { message: "Memory not found or not owned by this tenant." });
  }
  // Audit ONLY a real mutation — dry_run / requires_decision / already_consistent mutate nothing.
  if (result.outcome === "repaired") {
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: auth.tenantId,
      actor,
      actorKind: auth.isOperator ? "operator_token" : "tenant_session",
      operation: "memory_lifecycle_repaired",
      eventData: {
        addr,
        torn_class: result.plan.torn_class,
        from_status: result.plan.from_status,
        to_status: result.plan.to_status,
      },
    });
  }
  const decision = result.outcome === "requires_decision"
    ? {
        requires_decision: true,
        // Routing hints (canonical list in lifecycle-repair.ts) — OA4 applies neither; the
        // operator takes the choice to the destructive retire rung.
        options: [...REPAIR_DECISION_OPTIONS],
        note: "Ambiguous torn state — neither side is auto-safe. Use the conflict/retire rung to choose restore vs retire.",
      }
    : {};
  return c.json({ ok: true, outcome: result.outcome, plan: result.plan, ...decision });
});

// ── POST /dashboard/settings/agent/:agent_id/policy ──────────────────

dashboard.post("/settings/agent/:agent_id/policy", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }

  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }

  const agentId = c.req.param("agent_id");

  // VO-DASHBOARD-HOSTED-AGENT-POLICY-PR-1: converged on the canonical
  // `applyAgentPolicyPatch` helper. One shared validator (via
  // validatePolicyUpdate), one shared jsonb_set, one shared journal
  // call across direct route + dashboard bridge + remote dispatch.
  //
  // `body` is accepted verbatim as the patch — the helper's validator
  // enforces WRITABLE_POLICY_KEYS + per-key shape, so any unknown
  // keys or malformed values produce an explicit errors list.
  const { applyAgentPolicyPatch } = await import("../lib/agent-policy-write");
  const result = await applyAgentPolicyPatch(sql as any, {
    tenantId: auth.tenantId,
    agentId,
    patch: body,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "invalid_input":
        return errorJson(c, "invalid_request", { message: result.detail });
      case "not_in_tenant":
        return errorJson(c, "tenant_required", { message: `Agent "${agentId}" does not belong to tenant "${auth.tenantId}".` });
      case "agent_not_found":
        return errorJson(c, "not_found", { message: `Agent profile not found: ${agentId}` });
      case "invalid_patch":
        return errorJson(c, "validation_failed", { details: { errors: result.errors } });
      case "empty_patch":
        return errorJson(c, "invalid_request", { message: "No valid policy fields in body" });
    }
  }

  return c.json({
    ok: true,
    agent_id: result.agent_id,
    policy: result.stored_policy,
    effective_policy: result.effective_policy,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PROVIDERS BRIDGE ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ── GET /dashboard/providers ─────────────────────────────────────────

dashboard.get("/providers", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const { readProviderSummary, CANONICAL_TASKS } = await import("../lib/provider-config");
  const summary = readProviderSummary();

  // Tenant-owned agents + overrides (scoped by VERITY_AGENT_TENANTS)
  const agentTenantStr = process.env.VERITY_AGENT_TENANTS || "";
  const tenantAgentIds: string[] = [];
  for (const pair of agentTenantStr.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [aid, tid] = pair.split(":").map((s) => s.trim());
    if (tid === auth.tenantId && aid) tenantAgentIds.push(aid);
  }

  let agentOverrides: Record<string, unknown> = {};
  const tenantAgents: Array<{ agent_id: string; last_seen: string | null }> = [];
  if (tenantAgentIds.length > 0) {
    const rows = await sql`
      SELECT agent_id, metadata->'llm_overrides' as overrides, last_seen
      FROM agent_profiles WHERE tenant_id = ${auth.tenantId} AND agent_id = ANY(${tenantAgentIds})
    `;
    for (const row of rows) {
      tenantAgents.push({ agent_id: row.agent_id, last_seen: row.last_seen || null });
      if (row.overrides && typeof row.overrides === "object") agentOverrides[row.agent_id] = row.overrides;
    }
    for (const aid of tenantAgentIds) {
      if (!tenantAgents.find((a) => a.agent_id === aid)) {
        tenantAgents.push({ agent_id: aid, last_seen: null });
      }
    }
  }

  return c.json({
    ok: true,
    ...summary,
    agent_overrides: agentOverrides,
    tenant_agents: tenantAgents,
    canonical_tasks: [...CANONICAL_TASKS],
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_write: auth.isOperator },
  });
});

// ── POST /dashboard/providers/key ────────────────────────────────────

dashboard.post("/providers/key", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const provider = ((body.provider as string) || "").trim();
  const key = ((body.key as string) || "").trim();
  if (!provider) return errorJson(c, "invalid_request", { message: "provider is required." });
  if (!key) return errorJson(c, "invalid_request", { message: "key is required." });

  try {
    const { setProviderKey } = await import("../lib/provider-config");
    setProviderKey(provider, key, "operator:dashboard");
    return c.json({ ok: true, provider, configured: true });
  } catch (e) {
    console.error("[dashboard/providers/set-key] failed:", e);
    return errorJson(c, "invalid_request", { message: "Provider key update failed" });
  }
});

// ── POST /dashboard/providers/remove-key ─────────────────────────────

dashboard.post("/providers/remove-key", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const provider = ((body.provider as string) || "").trim();
  if (!provider) return errorJson(c, "invalid_request", { message: "provider is required." });

  const { removeProviderKey } = await import("../lib/provider-config");
  removeProviderKey(provider, "operator:dashboard");
  return c.json({ ok: true, provider, removed: true });
});

// ── POST /dashboard/providers/validate ───────────────────────────────

dashboard.post("/providers/validate", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const provider = ((body.provider as string) || "").trim();
  if (!provider) return errorJson(c, "invalid_request", { message: "provider is required." });

  const { validateProvider } = await import("../lib/provider-validate");
  const result = await validateProvider(provider);
  return c.json({ ok: true, ...result });
});

// ── POST /dashboard/providers/defaults ───────────────────────────────

dashboard.post("/providers/defaults", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const task = ((body.task as string) || "").trim();
  const provider = ((body.provider as string) || "").trim();
  const model = ((body.model as string) || "").trim();
  if (!task || !provider || !model) return errorJson(c, "invalid_request", { message: "task, provider, and model are required." });

  // VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: catch NonCanonicalTaskError
  // and map to 400 (parallel to /providers/defaults). Stops the dashboard
  // bridge from creating new non-canonical task-route overrides.
  const { writeTaskRoute, NonCanonicalTaskError } = await import("../lib/provider-config");
  try {
    const result = writeTaskRoute(task, { provider, model });
    return c.json({ ok: true, task, ...result });
  } catch (e: any) {
    if (e instanceof NonCanonicalTaskError) {
      return errorJson(c, "invalid_request", { message: "Task route is not canonical" });
    }
    throw e;
  }
});

// ── POST /dashboard/providers/defaults/clear ─────────────────────────
// VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1.

dashboard.post("/providers/defaults/clear", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const taskType = ((body.task_type as string) || "").trim();
  if (!taskType) return errorJson(c, "invalid_request", { message: "task_type is required." });

  // Defense-in-depth canonical check.
  const { CANONICAL_TASKS, clearTaskRoute } = await import("../lib/provider-config");
  if (!CANONICAL_TASKS.includes(taskType as any)) {
    return errorJson(c, "invalid_request", { message: `task_type must be one of: ${CANONICAL_TASKS.join(", ")}` });
  }

  const res = clearTaskRoute(taskType);
  return c.json({ ok: true, task_type: taskType, cleared: res.cleared, previous: res.previous });
});

// ── POST /dashboard/providers/agent-override ─────────────────────────

dashboard.post("/providers/agent-override", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const agentId = ((body.agent_id as string) || "").trim();
  const task = ((body.task as string) || "").trim();
  const provider = ((body.provider as string) || "").trim();
  const model = ((body.model as string) || "").trim();

  // VO-REMOTE-COMMAND-PROVIDER-AGENT-OVERRIDE-PR-1: collapsed onto the
  // shared writeAgentOverride helper. The prior inline implementation
  // had the tenant check + jsonb_set but was missing journalGovernance —
  // hosted /my/providers would therefore never see the override without
  // waiting for the next unrelated governance write to nudge sync.
  const { writeAgentOverride } = await import("../lib/agent-override");
  const res = await writeAgentOverride(sql as any, {
    tenantId: auth.tenantId,
    agentId,
    task,
    provider,
    model,
  });
  if (!res.ok) {
    if (res.reason === "invalid_input") return errorJson(c, "invalid_request", { message: res.detail });
    if (res.reason === "not_in_tenant") return errorJson(c, "tenant_required", { message: `Agent "${agentId}" not in this tenant.` });
    if (res.reason === "agent_not_found") return errorJson(c, "not_found", { message: `Agent not found: ${agentId}` });
    return errorJson(c, "internal_error", { message: "Override write failed." });
  }
  return c.json({ ok: true, agent_id: res.agent_id, task: res.task, provider: res.provider, model: res.model });
});

// ── POST /dashboard/providers/agent-override/clear ───────────────────
// VO-PROVIDER-AGENT-OVERRIDE-CLEAR-PR-1.
// Mirrors the set companion above but routes through clearAgentOverride.

dashboard.post("/providers/agent-override/clear", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const agentId = ((body.agent_id as string) || "").trim();
  const task = ((body.task as string) || "").trim();

  const { clearAgentOverride } = await import("../lib/agent-override");
  const res = await clearAgentOverride(sql as any, { tenantId: auth.tenantId, agentId, task });
  if (!res.ok) {
    if (res.reason === "invalid_input") return errorJson(c, "invalid_request", { message: res.detail });
    if (res.reason === "not_in_tenant") return errorJson(c, "tenant_required", { message: `Agent "${agentId}" not in this tenant.` });
    if (res.reason === "agent_not_found") return errorJson(c, "not_found", { message: `Agent not found: ${agentId}` });
    return errorJson(c, "internal_error", { message: "Override clear failed." });
  }
  return c.json({ ok: true, agent_id: res.agent_id, task: res.task, cleared: res.cleared, previous: res.previous });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTINES BRIDGE ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ── GET /dashboard/routines ──────────────────────────────────────────

dashboard.get("/routines", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  // vi_schedules is operator-only data (mirrors GET /vi/schedules being
  // operator-gated). Non-operators get an empty, available schedule list so the
  // tenant-scoped day-journal routines payload still renders.
  const [dayJournal, viSchedules] = await Promise.all([
    readDashboardDayJournalRoutines(auth.tenantId),
    auth.isOperator
      ? readDashboardViSchedules()
      : Promise.resolve({ rows: [] as any[], mode: "available" as const }),
  ]);
  applyDashboardDayJournalControlAccess(dayJournal, auth.isOperator);
  const schedules = viSchedules.rows;

  const now = Date.now();
  const staleThreshold = 24 * 60 * 60 * 1000;
  const enabledSchedules = schedules.filter((s: any) => s.enabled);
  const failingSchedules = enabledSchedules.filter((s: any) => s.last_status === "error");
  const staleSchedules = enabledSchedules.filter((s: any) => {
    if (!s.last_run_at) return s.created_at && (now - new Date(s.created_at).getTime()) > staleThreshold;
    return (now - new Date(s.last_run_at).getTime()) > staleThreshold;
  });

  // Get adapters list
  let adapters: unknown[] = [];
  try {
    const { listAdapters } = await import("../../../miners/src/vi/adapters/registry");
    adapters = listAdapters();
  } catch { /* adapters module may not be available */ }

  // Real per-run history from vi_schedule_runs. Global latest 50 rows, newest
  // first. Summary-only — no payloads, no raw logs. See schedule-history.ts.
  let recentRuns: unknown[] = [];
  let historyMode: "real_runs" | "unavailable" = "real_runs";
  try {
    const { listRecentScheduleRuns, RUN_HISTORY_LIMIT } = await import("../../../miners/src/vi/schedule-history");
    recentRuns = await listRecentScheduleRuns(sql as any, RUN_HISTORY_LIMIT);
  } catch {
    // Table may not exist on older installs. Report honestly.
    recentRuns = [];
    historyMode = "unavailable";
  }

  return c.json({
    ok: true,
    summary: {
      total_count: schedules.length,
      enabled_count: enabledSchedules.length,
      failing_count: failingSchedules.length,
      stale_count: staleSchedules.length,
    },
    day_journal: dayJournal,
    schedules,
    adapters,
    recent_runs: recentRuns,
    notes: { history_mode: historyMode, history_limit_global: 50, schedule_mode: viSchedules.mode },
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_write: auth.isOperator },
  });
});

// ── POST /dashboard/day-journal/routines/:id/:action ────────────────
// Dashboard controls deliberately proxy through the local PR8
// /day-journal/routines route layer so enablement, dry-run, permission,
// schedule, and writer guardrails stay in one place.

dashboard.post("/day-journal/routines/:id/:action", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Day journal request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });
  body.tenant_id = auth.tenantId;
  return proxyDashboardDayJournalRoutineAction(c, body);
});

// ── POST /dashboard/routines ─────────────────────────────────────────
// Proxies to POST /vi/schedules to preserve adapter validation, RSS
// normalization, duplicate rejection, feed-title enrichment, and
// default schedule fallback.

dashboard.post("/routines", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  if (body.adapter_name !== undefined && typeof body.adapter_name !== "string") {
    return errorJson(c, "invalid_request", { message: "adapter_name must be a string." });
  }
  const adapterName = (body.adapter_name || "").trim();
  if (!adapterName) return errorJson(c, "invalid_request", { message: "adapter_name is required." });
  const fieldError = dashboardViScheduleFieldValidationError(c, body);
  if (fieldError) return fieldError;

  // Proxy through the canonical vi-schedules create path
  const proxied = await proxyDashboardViScheduleAction(c, "/vi/schedules", "POST", {
    adapter_name: adapterName,
    schedule_cron: body.schedule_cron !== undefined ? body.schedule_cron : undefined,
    source_input: body.source_input !== undefined ? body.source_input : undefined,
    adapter_config: body.adapter_config !== undefined ? body.adapter_config : undefined,
    enabled: body.enabled,
    interval_seconds: body.interval_seconds !== undefined ? body.interval_seconds : undefined,
  }, auth.tenantId, "Create failed");
  if (!proxied.ok) return proxied.response;
  const result = proxied.payload;
  const schedule = result.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return errorJson(c, "bad_gateway", { message: "Schedule local API did not return a schedule." });
  }
  return c.json({ ok: true, schedule, duplicate: result.duplicate === true }, proxied.status as any);
});

dashboard.post("/routines/import", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });
  const fieldError = dashboardViScheduleFieldValidationError(c, body);
  if (fieldError) return fieldError;

  const proxied = await proxyDashboardViScheduleAction(c, "/vi/schedules/import", "POST", {
    source_input: body.source_input !== undefined ? body.source_input : undefined,
    schedule_cron: body.schedule_cron !== undefined ? body.schedule_cron : undefined,
    adapter_config: body.adapter_config !== undefined ? body.adapter_config : undefined,
    enabled: body.enabled !== undefined ? body.enabled : undefined,
    interval_seconds: body.interval_seconds !== undefined ? body.interval_seconds : undefined,
  }, auth.tenantId, "Import failed");
  if (!proxied.ok) return proxied.response;
  const result = proxied.payload;
  if (
    typeof result.imported_from !== "string"
    || !Number.isInteger(result.discovered)
    || result.discovered < 0
    || !Number.isInteger(result.created_count)
    || result.created_count < 0
    || !Number.isInteger(result.skipped_count)
    || result.skipped_count < 0
    || !Array.isArray(result.created)
    || !Array.isArray(result.skipped)
  ) {
    return errorJson(c, "bad_gateway", { message: "Schedule local API did not return an import summary." });
  }
  return c.json({
    ok: true,
    imported_from: result.imported_from,
    discovered: result.discovered,
    created_count: result.created_count,
    skipped_count: result.skipped_count,
    created: Array.isArray(result.created) ? result.created : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
  }, proxied.status as any);
});

// ── PATCH /dashboard/routines/:id ────────────────────────────────────

// Proxies to PATCH /vi/schedules/:id to preserve RSS normalization,
// duplicate detection, and feed-title enrichment.

dashboard.post("/routines/:id/edit", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const id = dashboardViScheduleIdParam(c);
  if (typeof id !== "string") return id;

  const patchBody = {
    schedule_cron: body.schedule_cron !== undefined ? body.schedule_cron : undefined,
    source_input: body.source_input !== undefined ? body.source_input : undefined,
    adapter_config: body.adapter_config !== undefined ? body.adapter_config : undefined,
    enabled: body.enabled !== undefined ? body.enabled : undefined,
    interval_seconds: body.interval_seconds !== undefined ? body.interval_seconds : undefined,
  };
  const fieldError = dashboardViScheduleFieldValidationError(c, patchBody);
  if (fieldError) return fieldError;

  const proxied = await proxyDashboardViScheduleAction(
    c,
    "/vi/schedules/" + encodeURIComponent(id),
    "PATCH",
    patchBody,
    auth.tenantId,
    "Update failed",
  );
  if (!proxied.ok) return proxied.response;
  const result = proxied.payload;
  const schedule = result.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return errorJson(c, "bad_gateway", { message: "Schedule local API did not return a schedule." });
  }
  return c.json({ ok: true, schedule });
});

// ── DELETE /dashboard/routines/:id ───────────────────────────────────

dashboard.post("/routines/:id/delete", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const id = dashboardViScheduleIdParam(c);
  if (typeof id !== "string") return id;
  const proxied = await proxyDashboardViScheduleAction(
    c,
    "/vi/schedules/" + encodeURIComponent(id),
    "DELETE",
    undefined,
    auth.tenantId,
    "Delete failed",
  );
  if (!proxied.ok) return proxied.response;
  return c.json({ ok: true, schedule_id: Number(id), deleted: true });
});

// ── POST /dashboard/routines/:id/run ─────────────────────────────────

dashboard.post("/routines/:id/run", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const id = dashboardViScheduleIdParam(c);
  if (typeof id !== "string") return id;
  const proxied = await proxyDashboardViScheduleAction(
    c,
    "/vi/schedules/" + encodeURIComponent(id) + "/run",
    "POST",
    undefined,
    auth.tenantId,
    "Run failed",
  );
  if (!proxied.ok) return proxied.response;
  return c.json({ ok: true, schedule_id: Number(id), triggered: true });
});

// ── POST /dashboard/routines/:id/toggle ──────────────────────────────

dashboard.post("/routines/:id/toggle", async (c) => {
  if (!isOperator(c)) return errorJson(c, "operator_required", { message: "Operator auth required." });
  const read = await readDashboardJsonObject(c, "Dashboard routine request body is too large.");
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "invalid_request", { message: "tenant_id required." });

  const id = dashboardViScheduleIdParam(c);
  if (typeof id !== "string") return id;
  if (typeof body.enabled !== "boolean") {
    return errorJson(c, "invalid_request", { message: "enabled must be a boolean." });
  }
  const enabled = body.enabled;
  const proxied = await proxyDashboardViScheduleAction(
    c,
    "/vi/schedules/" + encodeURIComponent(id),
    "PATCH",
    { enabled },
    auth.tenantId,
    "Update failed",
  );
  if (!proxied.ok) return proxied.response;
  const result = proxied.payload;
  const confirmedEnabled = result.schedule?.enabled;
  if (typeof confirmedEnabled !== "boolean") {
    return errorJson(c, "bad_gateway", { message: "Schedule local API did not confirm enabled state." });
  }
  return c.json({ ok: true, schedule_id: Number(id), enabled: confirmedEnabled });
});

async function startLocalHostedConnect(c: any, body: any) {
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const { readLocalSyncCredential } = await import("../lib/local-credential-store");
  const current = readLocalSyncCredential();
  if (current?.token_present && current.tenant_id && current.tenant_id !== auth.tenantId) {
    return errorJson(c, "conflict", {
      message: "tenant_already_connected",
      details: { connected_tenant_id: current.tenant_id },
    });
  }
  if (current?.token_present && current.tenant_id === auth.tenantId) {
    return c.json({ ok: true, status: "connected", connection: current });
  }
  const { readLocalConnectAttempt } = await import("../lib/local-connect-state");
  const pendingAttempt = readLocalConnectAttempt();
  if (pendingAttempt && pendingAttempt.status !== "expired" && pendingAttempt.tenant_id !== auth.tenantId) {
    return errorJson(c, "conflict", {
      message: "tenant_connect_in_progress",
      details: { pending_tenant_id: pendingAttempt.tenant_id },
    });
  }
  if (!assertLocalConnectStartBudget(auth.tenantId)) {
    return errorJson(c, "rate_limited", { message: "Too many Google sign-in attempts. Try again shortly." });
  }

  let hostedBaseUrl: string;
  let localOrigin: string;
  try {
    hostedBaseUrl = hostedBaseUrlFromBody(body);
    localOrigin = localOriginFromRequest();
  } catch {
    return errorJson(c, "invalid_request", { message: "invalid_connect_origin" });
  }

  const {
    ensureNodeKeypair,
    deriveNodeIdFromPublicKeyPem,
  } = await import("../lib/node-keypair");
  const { publicKeyHash } = await import("../lib/hosted-connect");
  const { createLocalConnectAttempt } = await import("../lib/local-connect-state");

  const keypair = ensureNodeKeypair();
  const nodeId = deriveNodeIdFromPublicKeyPem(keypair.publicKeyPem);
  const nodePublicKeyHash = publicKeyHash(keypair.publicKeyPem);
  const redirectUri = `${localOrigin}/dashboard/account/connect/callback`;
  const attempt = createLocalConnectAttempt({
    tenantId: auth.tenantId,
    nodeId,
    nodePublicKeyHash,
    localOrigin,
    redirectUri,
    hostedBaseUrl,
  });
  const openUrl = new URL(`${hostedBaseUrl}/account/connect/google/start`);
  openUrl.searchParams.set("tenant_id", auth.tenantId);
  openUrl.searchParams.set("node_id", nodeId);
  openUrl.searchParams.set("node_public_key_hash", nodePublicKeyHash);
  openUrl.searchParams.set("node_label", `Local VO ${nodeId}`);
  openUrl.searchParams.set("local_origin", localOrigin);
  openUrl.searchParams.set("redirect_uri", redirectUri);
  openUrl.searchParams.set("state", attempt.state);
  openUrl.searchParams.set("nonce", attempt.nonce);
  openUrl.searchParams.set("pkce_challenge", attempt.pkce_challenge);

  return c.json({
    ok: true,
    status: "waiting",
    open_url: openUrl.toString(),
    attempt_id: attempt.attempt_id,
    expires_at: attempt.expires_at,
  });
}

dashboard.post("/account/connect/start", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  return startLocalHostedConnect(c, body);
});

dashboard.post("/account/connect/retry", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { clearLocalConnectAttempt } = await import("../lib/local-connect-state");
  clearLocalConnectAttempt();
  return startLocalHostedConnect(c, body);
});

dashboard.get("/account/connect/status", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { readLocalSyncCredential } = await import("../lib/local-credential-store");
  const credential = readLocalSyncCredential();
  if (credential?.token_present && credential.tenant_id === auth.tenantId) {
    return c.json({ ok: true, status: "connected", connection: credential });
  }
  const { readLocalConnectAttempt } = await import("../lib/local-connect-state");
  const attempt = readLocalConnectAttempt();
  if (!attempt) return c.json({ ok: true, status: "idle", tenant_id: auth.tenantId });
  if (attempt.tenant_id !== auth.tenantId) {
    return c.json({
      ok: true,
      status: "blocked_by_other_tenant",
      tenant_id: auth.tenantId,
      next_action: "switch_tenant",
    });
  }
  return c.json({
    ok: true,
    status: attempt.status === "expired" ? "expired" : attempt.status,
    tenant_id: attempt.tenant_id,
    node_id: attempt.node_id,
    hosted_base_url: attempt.hosted_base_url,
    local_origin: attempt.local_origin,
    storage: attempt.secret_storage,
    expires_at: attempt.expires_at,
    last_error_code: attempt.last_error_code,
    next_action: attempt.status === "expired" || attempt.status === "error" ? "retry" : "wait",
  });
});

dashboard.get("/account/connect/callback", async (c) => {
  const code = readString(c.req.query("code"));
  const state = readString(c.req.query("state"));
  const grantId = readString(c.req.query("grant_id"));
  const render = (title: string, message: string) => c.html(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title></head><body><script>history.replaceState(null,"","/dashboard/account/connect/callback");</script><main style="font-family:system-ui;margin:48px auto;max-width:560px"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p><p><a href="/dashboard?tab=account">Return to Account / Sync</a></p></main></body></html>`);

  if (!code || !state || !grantId || code.length > 256 || state.length > 256 || grantId.length > 80) {
    return render("Connection failed", "The hosted callback was incomplete. Return to Account / Sync and retry.");
  }

  const {
    readLocalConnectAttemptWithSecrets,
    updateLocalConnectAttempt,
    validateLocalConnectState,
    clearLocalConnectAttempt,
  } = await import("../lib/local-connect-state");
  const attempt = readLocalConnectAttemptWithSecrets();
  if (!attempt || !validateLocalConnectState(attempt, state)) {
    return render("Connection failed", "The hosted callback did not match this local connection attempt. Return to Account / Sync and retry.");
  }

  const { hashSecret } = await import("../lib/hosted-connect");
  updateLocalConnectAttempt({
    status: "callback_received",
    callback_code_hash: hashSecret(code),
    callback_grant_id: grantId,
  });

  try {
    updateLocalConnectAttempt({ status: "redeeming" });
    const {
      ensureNodeKeypair,
      signConnectChallenge,
    } = await import("../lib/node-keypair");
    const keypair = ensureNodeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const challenge = signConnectChallenge({
      kind: "hosted_local_connect",
      tenant_id: attempt.tenant_id,
      node_id: attempt.node_id,
      node_public_key_hash: attempt.node_public_key_hash,
      grant_id: grantId,
      nonce: attempt.nonce,
      iat: now,
      exp: now + 60,
    });
    const redeemRes = await fetch(`${attempt.hosted_base_url}/account/connect/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        state,
        nonce: attempt.nonce,
        pkce_verifier: attempt.pkce_verifier,
        tenant_id: attempt.tenant_id,
        node_id: attempt.node_id,
        public_key: keypair.publicKeyPem,
        challenge,
        node_label: `Local VO ${attempt.node_id}`,
      }),
    });
    const payload = await redeemRes.json().catch(() => null) as any;
    if (!redeemRes.ok || !payload?.ok || !payload.sync_token) {
      updateLocalConnectAttempt({ status: "error", last_error_code: payload?.error || payload?.code || `http_${redeemRes.status}` });
      return render("Connection failed", "Hosted sign-in completed, but local VO could not redeem the connection. Return to Account / Sync and retry.");
    }
    const { writeLocalSyncCredential } = await import("../lib/local-credential-store");
    writeLocalSyncCredential({
      tenantId: payload.tenant_id || attempt.tenant_id,
      nodeId: payload.node_id || attempt.node_id,
      rawToken: payload.sync_token,
      accountEmail: payload.email ?? null,
      accountId: payload.account_id ?? null,
      hostedBaseUrl: attempt.hosted_base_url,
    });
    clearLocalConnectAttempt();
    return render("Connected", "You're signed in. Return to Account / Sync to view connection status.");
  } catch (e) {
    updateLocalConnectAttempt({ status: "error", last_error_code: "hosted_unreachable" });
    return render("Connection failed", "Local VO could not reach hosted Verity One. Check your internet connection and retry.");
  }
});

dashboard.post("/account/unlink", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const {
    clearLocalSyncCredential,
    readLocalSyncCredential,
    readRawLocalSyncToken,
  } = await import("../lib/local-credential-store");
  const { clearLocalEntitlementCache } = await import("../lib/local-entitlement-cache");
  const credential = readLocalSyncCredential();
  if (!credential?.token_present) {
    return errorJson(c, "not_found", { message: "No local hosted connection to unlink." });
  }
  if (credential.tenant_id && credential.tenant_id !== auth.tenantId) {
    return errorJson(c, "conflict", { message: "tenant_id does not match the connected local tenant." });
  }
  const hostedBaseUrl = credential.hosted_base_url || "https://verityone.app";
  const rawToken = readRawLocalSyncToken();
  const authHeader = rawToken ? `Bearer ${rawToken}` : (c.req.header("Authorization") || "");
  try {
    const res = await fetch(`${hostedBaseUrl}/account/unlink`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({ tenant_id: auth.tenantId }),
    });
    if (!res.ok) {
      return errorJson(c, "service_unavailable", { message: "hosted_unlink_failed" });
    }
  } catch {
    return errorJson(c, "service_unavailable", { message: "hosted_unreachable" });
  }
  try {
    const { revokeLocalDriveTokenIfPresent } = await import("../lib/google-drive-oauth");
    await revokeLocalDriveTokenIfPresent({ timeoutMs: 5000 });
  } catch { /* best-effort: offline revoke must not leave local linked */ }
  const { clearLocalDriveMirrorState } = await import("../lib/google-drive-state");
  clearLocalDriveMirrorState();
  clearLocalSyncCredential(auth.tenantId);
  clearLocalEntitlementCache();
  return c.json({ ok: true, unlinked: true, tenant_id: auth.tenantId });
});

dashboard.post("/account/entitlement/refresh", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { readLocalSyncCredential, readRawLocalSyncToken } = await import("../lib/local-credential-store");
  const { classifyEntitlementHealth, isHeavySyncAllowedFromCache, refreshLocalEntitlementCache } = await import("../lib/local-entitlement-cache");
  const credential = readLocalSyncCredential();
  const rawToken = readRawLocalSyncToken();
  if (!credential?.token_present || credential.tenant_id !== auth.tenantId || !rawToken) {
    return errorJson(c, "conflict", { message: "No active hosted connection for this tenant." });
  }
  const refreshed = await refreshLocalEntitlementCache({
    hostedBaseUrl: credential.hosted_base_url || "https://verityone.app",
    syncToken: rawToken,
    tenantId: auth.tenantId,
    nodeId: credential.node_id,
    timeoutMs: 8000,
  });
  if (!refreshed.ok) {
    return errorJson(c, "service_unavailable", { message: refreshed.code });
  }
  return c.json({
    ok: true,
    entitlement: {
      ...refreshed.cache,
      health: classifyEntitlementHealth(refreshed.cache),
      heavy_sync_active: isHeavySyncAllowedFromCache(refreshed.cache),
    },
  });
});

dashboard.post("/account/preferences", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  if (body?.show_google_email !== true && body?.show_google_email !== false) {
    return errorJson(c, "invalid_request", { message: "show_google_email must be boolean." });
  }

  const {
    readLocalSyncCredential,
    readRawLocalSyncToken,
  } = await import("../lib/local-credential-store");
  const {
    readLocalAccountUiState,
    writeLocalAccountUiPreferenceCache,
    recordHostedAccountError,
    clearHostedAccountError,
  } = await import("../lib/local-account-ui-state");
  const credential = readLocalSyncCredential();
  const rawToken = readRawLocalSyncToken();
  if (!credential?.token_present || credential.tenant_id !== auth.tenantId || !rawToken) {
    return errorJson(c, "conflict", { message: "No active hosted connection for this tenant." });
  }
  const hostedBaseUrl = credential.hosted_base_url || "https://verityone.app";
  const previousLocal = readLocalAccountUiState().show_google_email !== false;
  try {
    const res = await fetch(`${hostedBaseUrl}/account/preferences`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({
        tenant_id: auth.tenantId,
        show_google_email: body.show_google_email,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await res.json().catch(() => null) as any;
    if (!res.ok || !payload?.ok) {
      recordHostedAccountError({ code: payload?.error || `http_${res.status}`, message: "Hosted preference update failed." });
      const localErrorCode = res.status === 401 || res.status === 403
        ? "service_unavailable"
        : errorCodeForHttpStatus(res.status);
      return errorJson(c, localErrorCode, { message: "Hosted preference update failed." });
    }
    clearHostedAccountError();
    writeLocalAccountUiPreferenceCache({ show_google_email: payload.next?.show_google_email ?? body.show_google_email });
    return c.json({
      ok: true,
      previous: payload.previous ?? { show_google_email: previousLocal },
      next: payload.next ?? { show_google_email: body.show_google_email },
    });
  } catch {
    recordHostedAccountError({ code: "hosted_unreachable", message: "Hosted account preferences are unreachable." });
    return errorJson(c, "service_unavailable", { message: "hosted_unreachable" });
  }
});

async function updateAccountSyncControl(c: any, body: any, nextValue: "outbound" | "off") {
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const { readLocalSyncCredential } = await import("../lib/local-credential-store");
  const credential = readLocalSyncCredential();
  if (!credential?.token_present || credential.tenant_id !== auth.tenantId) {
    return errorJson(c, "conflict", { message: "A current hosted connection is required to change sync from Account / Sync." });
  }

  const { writeTenantSetting } = await import("../lib/runtime-profile");
  const result = writeTenantSetting("hosted_sync", nextValue, { sql: sql as any, tenantId: auth.tenantId });
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: auth.tenantId,
    actor: auth.scope === "operator" ? "operator" : auth.tenantId,
    actorKind: auth.scope === "operator" ? "operator_token" : "tenant_session",
    operation: "tenant_settings_changed",
    eventData: {
      settingKey: "hosted_sync",
      previous: result.previous,
      next: result.next,
      source: "account_sync_control",
    },
  });
  if (nextValue === "outbound") {
    const { nudgeSyncScheduler } = await import("../lib/sync-scheduler");
    nudgeSyncScheduler();
  }
  return c.json({ ok: true, key: "hosted_sync", previous: result.previous, next: result.next });
}

dashboard.post("/account/sync/start", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  return updateAccountSyncControl(c, body, "outbound");
});

dashboard.post("/account/sync/stop", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  return updateAccountSyncControl(c, body, "off");
});

dashboard.get("/account/sync/preferences", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { resolveTenantSettings } = await import("../lib/runtime-profile");
  const {
    listSyncProjectOptions,
    resolveEffectiveSyncPreferences,
  } = await import("../lib/sync-preferences");
  const { readLocalEntitlementCache } = await import("../lib/local-entitlement-cache");
  const { readLocalSyncCredential } = await import("../lib/local-credential-store");
  const settings = resolveTenantSettings();
  const credential = readLocalSyncCredential();
  const entitlementCache = readLocalEntitlementCache({
    tenantId: auth.tenantId,
    nodeId: credential?.node_id ?? null,
    hostedBaseUrl: credential?.hosted_base_url ?? null,
  });
  const prefs = resolveEffectiveSyncPreferences(settings, entitlementCache);
  const projects = await listSyncProjectOptions(sql as any, auth.tenantId);
  return c.json({
    ok: true,
    preferences: prefs,
    project_options: projects.options,
    managed_ceiling_available: projects.managed_ceiling_available,
    _auth: { tenant_id: auth.tenantId, scope: auth.scope },
  });
});

dashboard.patch("/account/sync/preferences", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "PATCH", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { resolveTenantSettings } = await import("../lib/runtime-profile");
  const {
    applySyncPreferencePatch,
    syncPreferenceAuditSummary,
  } = await import("../lib/sync-preferences");
  const { readLocalEntitlementCache } = await import("../lib/local-entitlement-cache");
  const { readLocalSyncCredential } = await import("../lib/local-credential-store");
  const credential = readLocalSyncCredential();
  const entitlementCache = readLocalEntitlementCache({
    tenantId: auth.tenantId,
    nodeId: credential?.node_id ?? null,
    hostedBaseUrl: credential?.hosted_base_url ?? null,
  });
  const patch: SyncPreferencePatch = {};
  for (const key of [
    "account_governance",
    "non_project_graph",
    "projects_enabled",
    "vault_metadata",
    "vault_dossiers",
    "raw_capture_files",
    "drive_mirror",
  ] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") return errorJson(c, "invalid_request", { message: `${key} must be boolean.` });
      patch[key] = body[key];
    }
  }
  if ("selected_project_addrs" in body) {
    if (!Array.isArray(body.selected_project_addrs)) {
      return errorJson(c, "invalid_request", { message: "selected_project_addrs must be an array." });
    }
    patch.selected_project_addrs = body.selected_project_addrs.map((v) => String(v));
  }

  try {
    const result = await applySyncPreferencePatch({
      sql: sql as any,
      tenantId: auth.tenantId,
      settings: resolveTenantSettings(),
      entitlementCache,
      patch,
    });
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: auth.tenantId,
      actor: auth.scope === "operator" ? "operator" : auth.tenantId,
      actorKind: auth.scope === "operator" ? "operator_token" : "tenant_session",
      operation: "sync_preferences_changed",
      eventData: {
        changed_keys: result.changed_keys,
        tenant_id: auth.tenantId,
        previous_summary: syncPreferenceAuditSummary(result.previous),
        next_summary: syncPreferenceAuditSummary(result.next),
      },
    });
    return c.json({
      ok: true,
      changed_keys: result.changed_keys,
      previous: syncPreferenceAuditSummary(result.previous),
      next: result.next,
    });
  } catch (e: any) {
    if (e?.code === "payment_required") return errorJson(c, "payment_required", { message: "VO+ is required for project and vault sync preferences." });
    if (e?.code === "invalid_project_selection") return errorJson(c, "invalid_request", { message: "invalid_project_selection" });
    return errorJson(c, "invalid_request", { message: "Sync preference update failed." });
  }
});

async function readDriveMirrorHeartbeatProjection(state: any, tenantId: string): Promise<Record<string, unknown> | null> {
  if (!state?.tenant_id || state.tenant_id !== tenantId || !state?.node_id) return null;
  try {
    const [row] = await sql`
      SELECT status, last_error, last_heartbeat, stale_after_ms
      FROM worker_heartbeats
      WHERE worker_name = 'drive-mirror'
        AND instance_id = ${`${tenantId}:${state.node_id}`}
      LIMIT 1
    `;
    if (!row?.last_heartbeat) {
      return {
        worker_heartbeat_age_seconds: null,
        worker_heartbeat_stale: true,
        worker_heartbeat_status: null,
        worker_heartbeat_last_error: null,
      };
    }
    const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(row.last_heartbeat).getTime()) / 1000));
    // R8 closure: one source of truth for the drive-mirror staleness window,
    // shared with hosted-account-parity (was a hardcoded 15*60_000 literal).
    const staleAfterMs = Number(row.stale_after_ms) || HOSTED_PARITY_THRESHOLDS.driveWorkerStaleAfterMs;
    return {
      worker_heartbeat_age_seconds: ageSeconds,
      worker_heartbeat_stale: ageSeconds * 1000 > staleAfterMs,
      worker_heartbeat_status: row.status || null,
      worker_heartbeat_last_error: row.last_error || null,
    };
  } catch {
    return null;
  }
}

export function projectLocalDriveMirrorStateForDashboard(
  state: any,
  tenantId: string,
  heartbeat: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const stats = getDriveMirrorStats({ files: state?.files || {} });
  if (state?.tenant_id && state.tenant_id !== tenantId) {
    return {
      tenant_id: tenantId,
      blocked_by_other_tenant: true,
      node_id: null,
      status: "blocked_by_other_tenant",
      token_present: false,
      file_count: 0,
      uploaded_count: 0,
      failed_count: 0,
      pending_count: 0,
      deleted_local_count: 0,
      deleted_drive_count: 0,
      stats: { file_count: 0, uploaded_count: 0, failed_count: 0, pending_count: 0, deleted_local_count: 0, deleted_drive_count: 0, total_size_bytes: 0 },
      last_error_code: "drive_tenant_mismatch",
      last_tick_at: null,
      updated_at: state.updated_at || null,
      worker_heartbeat_age_seconds: null,
      worker_heartbeat_stale: null,
      worker_heartbeat_status: null,
    };
  }
  const effectiveStatus = !state?.tenant_id || !state?.token_secret_ref
    ? "not_configured"
    : state.status === "skipped" && state.last_error_code === "drive_categories_disabled"
      ? "disabled_by_user"
      : state.last_error_code === "not_supported_for_security_tier"
        ? "disabled_by_security_tier"
      : state.last_error_code === "vo_plus_required" || state.last_error_code === "entitlement_grace_expired"
        ? "enabled_but_entitlement_lapsed"
        : "enabled_and_active";
  // R8 closure: surface the "Open in Drive" links (drive_web_url) — but ONLY
  // for a genuinely active, entitled mirror. The reliable gate is the live
  // worker status in {running, idle}: the worker flips status to "skipped"
  // when Drive is disabled by the user, the entitlement lapses, OR the tenant
  // is content_opaque — and on lapse it leaves last_error_code null, so
  // effectiveStatus alone (which collapses skipped → "enabled_and_active")
  // would wrongly expose links to a lapsed tenant. Require both.
  const driveActivelyMirroring = state?.status === "running" || state?.status === "idle";
  const entitledActive = driveActivelyMirroring && effectiveStatus === "enabled_and_active";
  const filesRecord = state?.files && typeof state.files === "object" && !Array.isArray(state.files)
    ? state.files
    : {};
  const GOOGLE_URL = /^https:\/\/(?:drive|docs)\.google\.com\//;
  const driveFolderId = entitledActive ? (state?.tenant_folder_id || null) : null;
  const driveFolderWebUrl = driveFolderId
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(driveFolderId)}`
    : null;
  const driveFiles = entitledActive
    ? Object.entries(filesRecord)
        .filter(([, f]: [string, any]) =>
          f && f.status === "uploaded" && typeof f.drive_web_url === "string" && GOOGLE_URL.test(f.drive_web_url))
        .map(([relativePath, f]: [string, any]) => ({
          relative_path: relativePath,
          drive_web_url: f.drive_web_url as string,
          file_kind: (f.file_kind as string) ?? null,
        }))
        .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
    : [];
  return {
    tenant_id: state?.tenant_id || null,
    node_id: state?.node_id || null,
    status: state?.status || "not_configured",
    effective_status: effectiveStatus,
    token_present: Boolean(state?.token_secret_ref),
    file_count: stats.file_count,
    uploaded_count: stats.uploaded_count,
    failed_count: stats.failed_count,
    pending_count: stats.pending_count,
    deleted_local_count: stats.deleted_local_count,
    deleted_drive_count: stats.deleted_drive_count,
    stats,
    drive_folder_web_url: driveFolderWebUrl,
    drive_files: driveFiles,
    last_error_code: state?.last_error_code || null,
    last_tick_at: state?.last_tick_at || null,
    updated_at: state?.updated_at || null,
    ...(heartbeat || {}),
  };
}

async function assertDriveMirrorEntitlement(input: {
  tenantId: string;
  credential: { node_id?: string | null; hosted_base_url?: string | null } | null;
}): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string; details?: unknown }> {
  try {
    const { getTenantSecurityConfig } = await import("../lib/tenant-security");
    const securityConfig = await getTenantSecurityConfig(sql as any, input.tenantId);
    if (securityConfig?.security_mode === "content_opaque") {
      return {
        ok: false,
        code: "not_supported_for_security_tier",
        message: "Google Drive vault mirror is not supported for content_opaque tenants.",
      };
    }
  } catch (e) {
    if ((e as any)?.code !== "42P01") throw e;
  }
  const { isHeavySyncAllowedFromCache, readLocalEntitlementCache, refreshLocalEntitlementCache } = await import("../lib/local-entitlement-cache");
  let entitlementCache = readLocalEntitlementCache({
    tenantId: input.tenantId,
    nodeId: input.credential?.node_id ?? null,
    hostedBaseUrl: input.credential?.hosted_base_url ?? null,
  });
  if (!isHeavySyncAllowedFromCache(entitlementCache) && input.credential?.hosted_base_url) {
    const { readRawLocalSyncToken } = await import("../lib/local-credential-store");
    const rawToken = readRawLocalSyncToken();
    if (rawToken) {
      const refreshed = await refreshLocalEntitlementCache({
        hostedBaseUrl: input.credential.hosted_base_url,
        syncToken: rawToken,
        tenantId: input.tenantId,
        nodeId: input.credential.node_id ?? null,
        timeoutMs: 5000,
      }).catch(() => null);
      if (refreshed?.cache) entitlementCache = refreshed.cache;
    }
  }
  if (isHeavySyncAllowedFromCache(entitlementCache)) return { ok: true };
  return {
    ok: false,
    code: "payment_required",
    message: "VO+ is required for Google Drive vault mirror.",
    details: { manage_url: `${(input.credential?.hosted_base_url || "https://verityone.app").replace(/\/$/, "")}/my/account#vo-plus` },
  };
}

function projectLocalDriveAttemptForDashboard(attempt: any, tenantId: string): Record<string, unknown> | null {
  if (!attempt) return null;
  if (attempt.tenant_id !== tenantId) {
    return {
      tenant_id: tenantId,
      status: "blocked_by_other_tenant",
      blocked_by_other_tenant: true,
      expires_at: attempt.expires_at,
    };
  }
  return {
    tenant_id: attempt.tenant_id,
    status: "pending",
    expires_at: attempt.expires_at,
  };
}

dashboard.get("/account/drive/status", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { readLocalDriveConnectAttempt, readLocalDriveMirrorState } = await import("../lib/google-drive-state");
  const state = readLocalDriveMirrorState();
  const attempt = readLocalDriveConnectAttempt();
  const heartbeat = await readDriveMirrorHeartbeatProjection(state, auth.tenantId);
  return c.json({
    ok: true,
    drive: {
      state: projectLocalDriveMirrorStateForDashboard(state, auth.tenantId, heartbeat),
      attempt: projectLocalDriveAttemptForDashboard(attempt, auth.tenantId),
    },
  });
});

dashboard.post("/account/drive/start", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { readLocalSyncCredential, readRawLocalSyncToken } = await import("../lib/local-credential-store");
  const credential = readLocalSyncCredential();
  const rawToken = readRawLocalSyncToken();
  if (!credential?.hosted_base_url || !credential.node_id || !rawToken) {
    return errorJson(c, "drive_connect_required", { message: "Hosted Google sync must be connected before enabling Drive mirror." });
  }
  if (credential.tenant_id !== auth.tenantId) {
    return errorJson(c, "forbidden", { message: "Connected hosted tenant does not match the active dashboard tenant." });
  }
  const entitlementGate = await assertDriveMirrorEntitlement({ tenantId: auth.tenantId, credential });
  if (!entitlementGate.ok) {
    return errorJson(c, entitlementGate.code, {
      message: entitlementGate.message,
      details: entitlementGate.details,
    });
  }
  const { loadSodium } = await import("../lib/load-sodium");
  const sodium = await loadSodium();
  const keyPair = sodium.crypto_box_keypair();
  const nonce = crypto.randomBytes(18).toString("base64url");
  const hostedBaseUrl = credential.hosted_base_url.replace(/\/$/, "");
  const res = await fetch(`${hostedBaseUrl}/account/drive/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${rawToken}`,
    },
    body: JSON.stringify({
      tenant_id: auth.tenantId,
      nonce,
      ephemeral_public_key: Buffer.from(keyPair.publicKey).toString("base64"),
    }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await res.json().catch(() => null) as any;
  if (!res.ok || !payload?.grant_id || !payload?.consent_url) {
    return errorJson(c, "bad_gateway", { message: "Hosted Drive consent start failed." });
  }
  const { clearLocalDriveConnectAttempt, writeLocalDriveConnectAttempt, writeLocalDriveMirrorState } = await import("../lib/google-drive-state");
  clearLocalDriveConnectAttempt();
  writeLocalDriveConnectAttempt({
    grant_id: payload.grant_id,
    tenant_id: auth.tenantId,
    node_id: credential.node_id,
    nonce: payload.nonce || nonce,
    hosted_base_url: hostedBaseUrl,
    private_key_ref: `drive-connect:${auth.tenantId}:${credential.node_id}:${payload.grant_id}`,
    private_key: Buffer.from(keyPair.privateKey).toString("base64"),
    public_key: Buffer.from(keyPair.publicKey).toString("base64"),
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  writeLocalDriveMirrorState({
    tenant_id: auth.tenantId,
    node_id: credential.node_id,
    status: "consent_pending",
    last_error_code: null,
  });
  return c.json({ ok: true, open_url: payload.consent_url });
});

dashboard.post("/account/drive/redeem", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { readLocalSyncCredential, readRawLocalSyncToken } = await import("../lib/local-credential-store");
  const credential = readLocalSyncCredential();
  const rawToken = readRawLocalSyncToken();
  if (!credential?.hosted_base_url || !credential.node_id || !rawToken) {
    return errorJson(c, "drive_connect_required", { message: "Hosted Google sync must be connected before redeeming Drive consent." });
  }
  if (credential.tenant_id !== auth.tenantId) {
    return errorJson(c, "forbidden", { message: "Connected hosted tenant does not match the active dashboard tenant." });
  }
  const entitlementGate = await assertDriveMirrorEntitlement({ tenantId: auth.tenantId, credential });
  if (!entitlementGate.ok) {
    return errorJson(c, entitlementGate.code, {
      message: entitlementGate.message,
      details: entitlementGate.details,
    });
  }
  const {
    clearLocalDriveConnectAttempt,
    readLocalDriveConnectAttempt,
    readLocalDrivePrivateKey,
    writeLocalDriveMirrorState,
    writeLocalDriveToken,
  } = await import("../lib/google-drive-state");
  const attempt = readLocalDriveConnectAttempt();
  if (!attempt || attempt.tenant_id !== auth.tenantId) {
    return errorJson(c, "invalid_request", { message: "No pending Drive consent attempt." });
  }
  if (attempt.node_id !== credential.node_id || attempt.hosted_base_url.replace(/\/$/, "") !== credential.hosted_base_url.replace(/\/$/, "")) {
    return errorJson(c, "state_mismatch", { message: "Pending Drive consent does not match the connected hosted node." });
  }
  const hostedBaseUrl = attempt.hosted_base_url.replace(/\/$/, "");
  const res = await fetch(`${hostedBaseUrl}/account/drive/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${rawToken}`,
    },
    body: JSON.stringify({ grant_id: attempt.grant_id, nonce: attempt.nonce }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await res.json().catch(() => null) as any;
  if (!res.ok) {
    return errorJson(c, errorCodeForHttpStatus(res.status) || "bad_gateway", { message: payload?.message || "Hosted Drive consent is not ready yet." });
  }
  const privateKey = readLocalDrivePrivateKey(attempt);
  if (!privateKey || !payload?.encrypted_token_blob) {
    return errorJson(c, "state_mismatch", { message: "Pending Drive secret is unavailable." });
  }
  const { openDriveTokenBlob } = await import("../lib/google-drive-oauth");
  let tokenResponse: Record<string, unknown>;
  try {
    tokenResponse = await openDriveTokenBlob({
      ciphertext: new Uint8Array(Buffer.from(payload.encrypted_token_blob, "base64")),
      publicKey: new Uint8Array(Buffer.from(attempt.public_key, "base64")),
      privateKey: new Uint8Array(Buffer.from(privateKey, "base64")),
      grantId: attempt.grant_id,
    });
  } catch {
    return errorJson(c, "state_mismatch", { message: "Drive token decrypt failed." });
  }
  clearLocalDriveConnectAttempt();
  const next = writeLocalDriveToken({
    tenantId: auth.tenantId,
    nodeId: credential.node_id,
    tokenJson: JSON.stringify(tokenResponse),
  });
  import("../lib/google-drive-worker")
    .then(({ nudgeDriveMirrorWorker }) => nudgeDriveMirrorWorker())
    .catch(() => {});
  if (payload.primary_status === "other_primary") {
    writeLocalDriveMirrorState({ status: "mirror_primary_on_other_node", last_error_code: "mirror_primary_on_other_node" });
  }
  return c.json({
    ok: true,
    drive: projectLocalDriveMirrorStateForDashboard(next, auth.tenantId),
    primary_status: payload.primary_status || "claimed",
  });
});

// ── GET /dashboard/account ────────────────────────────────────────────
// Local Account/Sync surface. Uses getSyncStatus() for local sync state
// (not hosted_nodes/remote_commands directly — those are hosted tables).
// Identity from account_tenant_links is best-effort (may not exist locally).

dashboard.get("/account", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  const { resolveTenantSettings } = await import("../lib/runtime-profile");
  const settings = resolveTenantSettings();

  let localNodeKeyPem: string | null = null;
  let localNodeId: string | null = null;
  try {
    const { loadLocalNodeIdentity } = await import("../lib/node-keypair");
    const identity = loadLocalNodeIdentity();
    localNodeKeyPem = identity?.publicKeyPem ?? null;
    localNodeId = identity?.nodeId ?? null;
  } catch {
    localNodeKeyPem = null;
    localNodeId = null;
  }

  // Sync health: from local getSyncStatus() (reads config, sync token, journal).
  // getSyncStatus() reflects THIS machine's sync state, not an arbitrary tenant's.
  // If operator is querying a different tenant than this machine's configured tenant,
  // the sync section is honestly marked as "not this node's tenant."
  let syncStatus: any = null;
  let syncTenantMismatch = false;
  try {
    const { getSyncStatus } = await import("../lib/sync-exporter");
    const localSync = await getSyncStatus(sql as any);
    const localSyncTenantId = typeof localSync.tenant_id === "string"
      ? localSync.tenant_id.trim()
      : "";
    if (localSyncTenantId && localSyncTenantId === auth.tenantId) {
      syncStatus = localSync;
      if (typeof localSync.node_id === "string" && localSync.node_id.trim()) {
        localNodeId = localSync.node_id.trim();
      }
    } else if (localSyncTenantId) {
      syncTenantMismatch = true;
    } else {
      syncStatus = localSync;
    }
  } catch { /* sync-exporter may not be available */ }

  // Identity: best-effort from account_tenant_links (may not exist on local-only installs)
  let identity: { tenant_id: string; google_linked: boolean | null; account_email: string | null; account_display_name: string | null } = {
    tenant_id: auth.tenantId, google_linked: null, account_email: null, account_display_name: null,
  };
  // Link row for the rung-1 state projection (active OR this local
  // node's pending claim). Without a local node id, do not surface an
  // arbitrary pending row for another device.
  let linkForProjection: { account_id: string; status: "active" | "pending_confirmation" | "unlinked"; linked_by_node_id: string | null } | null = null;
  try {
    const [link] = localNodeId
      ? await sql`
      SELECT atl.account_id, atl.status, atl.linked_by_node_id, a.email, a.display_name
      FROM account_tenant_links atl
      JOIN accounts a ON a.account_id = atl.account_id
      WHERE atl.tenant_id = ${auth.tenantId}
        AND (
          atl.status = 'active'
          OR (atl.status = 'pending_confirmation' AND atl.linked_by_node_id = ${localNodeId})
        )
      ORDER BY CASE atl.status WHEN 'active' THEN 0 ELSE 1 END
      LIMIT 1
    `
      : await sql`
      SELECT atl.account_id, atl.status, atl.linked_by_node_id, a.email, a.display_name
      FROM account_tenant_links atl
      JOIN accounts a ON a.account_id = atl.account_id
      WHERE atl.tenant_id = ${auth.tenantId}
        AND atl.status = 'active'
      ORDER BY CASE atl.status WHEN 'active' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    identity.google_linked = link && link.status === "active" ? true : false;
    if (link) {
      identity.account_email = link.email || null;
      identity.account_display_name = link.display_name || null;
      linkForProjection = {
        account_id: String(link.account_id),
        status: link.status as "active" | "pending_confirmation" | "unlinked",
        linked_by_node_id: link.linked_by_node_id ?? null,
      };
    }
  } catch {
    // Tables may not exist on local-only — identity.google_linked stays null
  }

  // Hosted_nodes row for the projection — only meaningful
  // when the operator is viewing the local node's tenant.
  // For cross-tenant views we skip the local-node lookup.
  let nodeForProjection: { node_id: string | null; status: string; node_public_key: string | null; sync_token_claimed: boolean; last_sync_at: string | null } | null = null;
  try {
    if (linkForProjection && !syncTenantMismatch && localNodeId) {
      const expectedNodeStatus =
        linkForProjection.status === "active"
          ? "active"
          : "pending";
      const [nodeRow] = await sql`
        SELECT node_id, status, node_public_key, sync_token_claimed, last_sync_at
        FROM hosted_nodes
        WHERE account_id = ${linkForProjection.account_id}::uuid
          AND tenant_id = ${auth.tenantId}
          AND node_id = ${localNodeId}
          AND status = ${expectedNodeStatus}
        LIMIT 1
      `;
      if (nodeRow) {
        nodeForProjection = {
          node_id: String(nodeRow.node_id),
          status: String(nodeRow.status),
          node_public_key: nodeRow.node_public_key ?? null,
          sync_token_claimed: Boolean(nodeRow.sync_token_claimed),
          last_sync_at: nodeRow.last_sync_at ? String(nodeRow.last_sync_at) : null,
        };
      }
    }
  } catch {
    // hosted_nodes may not exist locally — nodeForProjection stays null
  }

  // Rung 2 Q3=A+: read-only visibility of OTHER tenant
  // devices. Only emit this list when the local node id
  // is known so `sibling_nodes` never silently includes
  // the local device. Actions still target only the local
  // node — this list is purely so operators can see remote
  // devices without needing to jump to the hosted portal.
  let siblingNodes: Array<{ node_id: string; status: string; last_sync_at: string | null; sync_token_claimed: boolean }> = [];
  try {
    if (linkForProjection && localNodeId) {
      const siblingRows = await sql`
        SELECT hn.node_id, hn.status, hn.last_sync_at, hn.sync_token_claimed
        FROM hosted_nodes hn
        JOIN account_tenant_links atl
          ON atl.account_id = hn.account_id
         AND atl.tenant_id = hn.tenant_id
         AND atl.status = 'active'
        WHERE hn.tenant_id = ${auth.tenantId}
          AND hn.node_id <> ${localNodeId}
        ORDER BY hn.created_at DESC
        LIMIT 25
      `;
      siblingNodes = siblingRows.map((r: any) => ({
        node_id: String(r.node_id),
        status: String(r.status),
        last_sync_at: r.last_sync_at ? String(r.last_sync_at) : null,
        sync_token_claimed: Boolean(r.sync_token_claimed),
      }));
    }
  } catch {
    // hosted_nodes may not exist locally — siblingNodes stays []
  }

  // Remote command counts + recent (tenant-scoped, metadata only — no payload).
  // Distinguish "unavailable" (table doesn't exist / query error) from "empty" (no commands).
  let commandCounts: Record<string, number> | null = null;
  let recentCommands: any[] | null = null;
  let commandsAvailable = false;
  try {
    const countRows = await sql`
      SELECT status, COUNT(*)::int as count FROM remote_commands
      WHERE tenant_id = ${auth.tenantId} GROUP BY status
    `;
    // `canceled` is a user-initiated terminal status (VO-REMOTE-COMMAND-CANCEL-PR-1).
    // Initialize the bucket so the UI always has a key to read, even before
    // any rows with that status exist — avoids a `canceled: undefined` gap
    // in the rendered counts grid.
    commandCounts = { queued: 0, claimed: 0, applied: 0, rejected: 0, failed: 0, canceled: 0 };
    for (const r of countRows) commandCounts[r.status] = r.count;

    // Metadata only: no payload column selected
    const cmdRows = await sql`
      SELECT id, category, command_type, status, created_at, updated_at, result
      FROM remote_commands WHERE tenant_id = ${auth.tenantId}
      ORDER BY created_at DESC LIMIT 20
    `;
    recentCommands = cmdRows.map((cmd: any) => ({
      id: cmd.id, category: cmd.category, command_type: cmd.command_type,
      status: cmd.status, created_at: cmd.created_at, updated_at: cmd.updated_at,
      result: cmd.result || null,
    }));
    commandsAvailable = true;
  } catch {
    // remote_commands table may not exist on this node
    commandCounts = null;
    recentCommands = null;
  }

  // Rung-1 5-state projection — state + context + actions
  // the Account tab UI renders directly. The lookup above
  // already gathered everything; projectAccountState is a
  // pure mapping (no DB). Cross-tenant views skip the
  // mismatch check by passing localNodeKeyPem=null when
  // the configured tenant differs from the viewed tenant.
  const { projectAccountState } = await import("../lib/dashboard-account-state");
  const keyPemForProjection = syncTenantMismatch ? null : localNodeKeyPem;

  // Rung 3: sync-health projection input. Uses local
  // getSyncStatus() output + hosted node row's last_sync_at.
  // When syncTenantMismatch is true we have no honest local
  // view of this tenant's sync, so we emit a disabled input
  // — the projection reports 'disabled' which is correct:
  // this node is NOT the one syncing the requested tenant.
  const syncStatusTenantId = syncStatus && typeof syncStatus.tenant_id === "string"
    ? syncStatus.tenant_id.trim()
    : "";
  const syncHealthInput = syncStatus && !syncTenantMismatch
    ? {
        syncConfigured: Boolean(
          syncStatus.sync_configured &&
          syncStatusTenantId === auth.tenantId &&
          syncStatus.node_id
        ),
        lastAttemptAt: syncStatus.last_attempt?.last_attempt_at ?? null,
        lastResult: syncStatus.last_attempt?.last_result ?? null,
        hostedLastSyncAt: nodeForProjection?.last_sync_at ?? null,
      }
    : undefined;
  const pendingJournalCount = syncStatus && !syncTenantMismatch
    ? (typeof syncStatus.journal_pending === "number" ? syncStatus.journal_pending : 0)
    : 0;
  const localCursor = syncStatus && !syncTenantMismatch
    ? (typeof syncStatus.local_cursor === "number" ? syncStatus.local_cursor : null)
    : null;

  // Rung 2: viewerIsOperator gates the force-rotate
  // action on the mismatched-state card. auth.scope
  // comes from resolveDashboardTenant — "operator" when
  // the caller presented an operator token.
  const projection = projectAccountState({
    hasTenantContext: true,
    tenantId: auth.tenantId,
    accountEmail: identity.account_email,
    accountDisplayName: identity.account_display_name,
    link: linkForProjection,
    node: nodeForProjection,
    localNodeKeyPem: keyPemForProjection,
    siblingNodes,
    viewerIsOperator: auth.scope === "operator",
    syncHealthInput,
    pendingJournalCount,
    localCursor,
  });

  // Rung 3: feature flag lets operators disable the new
  // sync-health card render without redeploying. Default
  // on; "off" → render skips the card, projection fields
  // still compute (never a silent disable of the shared
  // vocabulary at the module layer).
  const syncHealthCardEnabled = process.env.VERITY_SYNC_HEALTH_CARD !== "off";
  const { readLocalSyncCredential, readRawLocalSyncToken } = await import("../lib/local-credential-store");
  const { readLocalConnectAttempt } = await import("../lib/local-connect-state");
  const {
    readLocalAccountUiState,
    writeLocalAccountUiPreferenceCache,
    recordHostedAccountError,
    clearHostedAccountError,
  } = await import("../lib/local-account-ui-state");
  const {
    classifyEntitlementHealth,
    isHeavySyncAllowedFromCache,
    readLocalEntitlementCache,
    refreshLocalEntitlementCache,
  } = await import("../lib/local-entitlement-cache");
  const {
    listSyncProjectOptions,
    resolveEffectiveSyncPreferences,
  } = await import("../lib/sync-preferences");
  const { readLocalDriveConnectAttempt, readLocalDriveMirrorState } = await import("../lib/google-drive-state");
  const localCredential = readLocalSyncCredential();
  const localAttempt = readLocalConnectAttempt();
  const rawSyncToken = readRawLocalSyncToken();
  let accountPreferences = {
    show_google_email: readLocalAccountUiState().show_google_email !== false,
  };
  let hostedAccountError = readLocalAccountUiState().hosted_error || null;
  const currentLocalCredential = localCredential?.token_present && localCredential.tenant_id === auth.tenantId
    ? localCredential
    : null;
  let entitlementCache = readLocalEntitlementCache({
    tenantId: auth.tenantId,
    nodeId: currentLocalCredential?.node_id ?? null,
    hostedBaseUrl: currentLocalCredential?.hosted_base_url ?? null,
  });
  if (currentLocalCredential && rawSyncToken) {
    const hostedBaseUrl = currentLocalCredential.hosted_base_url || "https://verityone.app";
    try {
      const prefRes = await fetch(`${hostedBaseUrl}/account/preferences?tenant_id=${encodeURIComponent(auth.tenantId)}`, {
        headers: { Authorization: `Bearer ${rawSyncToken}` },
        signal: AbortSignal.timeout(5000),
      });
      const prefPayload = await prefRes.json().catch(() => null) as any;
      if (prefRes.ok && prefPayload?.account_preferences) {
        accountPreferences = {
          show_google_email: prefPayload.account_preferences.show_google_email !== false,
        };
        writeLocalAccountUiPreferenceCache(accountPreferences);
        clearHostedAccountError();
        hostedAccountError = null;
      } else {
        hostedAccountError = recordHostedAccountError({
          code: prefPayload?.error || `http_${prefRes.status}`,
          message: "Hosted account preferences are unavailable.",
        }).hosted_error || null;
      }
    } catch {
      hostedAccountError = recordHostedAccountError({
        code: "hosted_unreachable",
        message: "Hosted account preferences are unreachable.",
      }).hosted_error || null;
    }
    const entitlementRefresh = await refreshLocalEntitlementCache({
      hostedBaseUrl,
      syncToken: rawSyncToken,
      tenantId: auth.tenantId,
      nodeId: currentLocalCredential.node_id,
      timeoutMs: 5000,
    });
    entitlementCache = entitlementRefresh.cache || entitlementCache;
  }
  const connectStatus = localCredential?.token_present && localCredential.tenant_id === auth.tenantId
    ? {
        status: "connected",
        tenant_id: auth.tenantId,
        node_id: localCredential.node_id,
        local_origin: localOriginFromRequest(),
        hosted_base_url: localCredential.hosted_base_url || "https://verityone.app",
        hosted_account_url: `${(localCredential.hosted_base_url || "https://verityone.app").replace(/\/$/, "")}/my/account`,
        connection: localCredential,
      }
    : localAttempt
      ? {
          status: localAttempt.status,
          tenant_id: localAttempt.tenant_id,
          node_id: localAttempt.node_id,
          hosted_base_url: localAttempt.hosted_base_url,
          hosted_account_url: `${localAttempt.hosted_base_url.replace(/\/$/, "")}/my/account`,
          local_origin: localAttempt.local_origin,
          storage: localAttempt.secret_storage,
          expires_at: localAttempt.expires_at,
          last_error_code: localAttempt.last_error_code,
        }
      : { status: "not_signed_in", tenant_id: auth.tenantId };
  const effectiveAccountEmail = identity.account_email || null;
  const emailVisible = accountPreferences.show_google_email;
  const hostedSyncValue = syncStatus && !syncTenantMismatch ? syncStatus.hosted_sync : "off";
  const canUseSyncControls = Boolean(currentLocalCredential);
  const syncControlReason = !canUseSyncControls
    ? "hosted_connection_required"
    : hostedSyncValue === "outbound"
      ? "sync_running"
      : "sync_stopped";
  const hostedAccountUrl = `${(currentLocalCredential?.hosted_base_url || "https://verityone.app").replace(/\/$/, "")}/my/account`;
  const effectiveSyncPreferences = resolveEffectiveSyncPreferences(settings, entitlementCache);
  const driveState = readLocalDriveMirrorState();
  const driveAttempt = readLocalDriveConnectAttempt();
  const driveHeartbeat = await readDriveMirrorHeartbeatProjection(driveState, auth.tenantId);
  const syncProjectOptions = await listSyncProjectOptions(sql as any, auth.tenantId).catch(() => ({
    options: [],
    managed_ceiling_available: false,
    managed_project_addrs: null,
  }));

  return c.json({
    ok: true,
    identity: {
      ...identity,
      account_email: effectiveAccountEmail,
      email_visible: emailVisible,
      email_display: emailVisible ? (effectiveAccountEmail || null) : "Hidden",
      google_linked: identity.google_linked === true || (localCredential?.token_present === true && localCredential.tenant_id === auth.tenantId),
    },
    account_preferences: accountPreferences,
    hosted_account_error: hostedAccountError,
    connect: connectStatus,
    sync_controls: {
      can_start: canUseSyncControls && hostedSyncValue !== "outbound",
      can_stop: canUseSyncControls && hostedSyncValue === "outbound",
      hosted_sync: hostedSyncValue,
      reason: syncControlReason,
    },
    sync_preferences: effectiveSyncPreferences,
    drive_mirror: {
      state: projectLocalDriveMirrorStateForDashboard(driveState, auth.tenantId, driveHeartbeat),
      attempt: projectLocalDriveAttemptForDashboard(driveAttempt, auth.tenantId),
    },
    sync_project_options: syncProjectOptions.options,
    managed_ceiling_available: syncProjectOptions.managed_ceiling_available,
    entitlement: entitlementCache
      ? {
          ...entitlementCache,
          health: classifyEntitlementHealth(entitlementCache),
          heavy_sync_active: isHeavySyncAllowedFromCache(entitlementCache),
        }
      : {
          tier: "unknown",
          source: "unknown",
          capabilities: [],
          vo_plus_active: false,
          heavy_sync_active: false,
          manage_url: hostedAccountUrl,
          health: "unknown",
        },
    // Rung-1 fields. Drift guard at
    // federation-state-drift.test.ts pins these keys +
    // valid state values. UI keys on projection.state.
    state: projection.state,
    context: projection.context,
    actions: projection.actions,
    sync_health_card_enabled: syncHealthCardEnabled,
    sync: syncStatus ? {
      hosted_sync: syncStatus.hosted_sync,
      sync_configured: syncStatus.sync_configured,
      sync_token_present: syncStatus.sync_token_present,
      local_cursor: syncStatus.local_cursor,
      journal_pending: syncStatus.journal_pending,
      tenant_id: syncStatus.tenant_id,
      node_id: syncStatus.node_id,
      vault_skip_reason: syncStatus.vault_skip_reason,
      last_attempt: syncStatus.last_attempt,
    } : syncTenantMismatch
      ? { note: "This node is configured for a different tenant. Sync state is not available for the requested tenant." }
      : null,
    remote_commands: commandsAvailable
      ? { available: true, counts: commandCounts, recent: recentCommands }
      : { available: false, note: "Remote command history is not available from this node. Use the hosted dashboard for command visibility." },
    _auth: { tenant_id: auth.tenantId, scope: auth.scope },
  });
});

// ── POST /dashboard/account/link-submit ───────────────────────────────
// Rung-1 local-dashboard bridge: takes the operator-pasted
// link code + tenant_id and forwards to POST /account/link
// via an in-process fetch with X-VO-Link-Code. The /account/
// link handler owns TOFU / node-challenge logic; this bridge
// only translates the dashboard's tenant-token auth into a
// hosted-link-code call.
//
// Body: { tenant_id: string, link_code: string }
// Auth: standard dashboard tenant-token (resolveDashboardTenant).
// Returns the /account/link response verbatim.

dashboard.post("/account/link-submit", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id.trim() : "";
  const linkCode = typeof body?.link_code === "string" ? body.link_code.trim() : "";
  if (!tenantId || !linkCode) {
    return errorJson(c, "invalid_request", { message: "tenant_id and link_code are required." });
  }
  if (tenantId !== auth.tenantId) {
    return errorJson(c, "tenant_required", { message: "tenant_id does not match the authenticated tenant." });
  }

  // Build the node challenge payload from the local keypair.
  // The operator's local node is the one linking; we use its
  // key. If node-keypair is not available, we refuse with a
  // specific error rather than silently proxying.
  let signedChallenge: string;
  let nodePublicKeyPem: string;
  let nodeId: string;
  try {
    const {
      ensureNodeKeypair,
      signLinkChallenge,
      deriveNodeIdFromPublicKeyPem,
    } = await import("../lib/node-keypair");
    const keypair = ensureNodeKeypair();
    nodePublicKeyPem = keypair.publicKeyPem;
    nodeId = deriveNodeIdFromPublicKeyPem(keypair.publicKeyPem);
    const exp = Math.floor(Date.now() / 1000) + 60;
    signedChallenge = signLinkChallenge({ tenant_id: tenantId, node_id: nodeId, exp });
  } catch (e) {
    console.error("[dashboard/link] local node keypair unavailable:", e);
    return errorJson(c, "service_unavailable", { message: "local_node_keypair_unavailable" });
  }

  // Fetch /account/link on the same process. Use localhost
  // origin + the X-VO-Link-Code header as the hosted portal
  // would have done. Derive origin from the actual request
  // URL so https / forwarded-proto deployments do not get
  // downgraded to http.
  let origin = "http://localhost:3100";
  try {
    origin = new URL(c.req.url).origin;
  } catch {
    origin = `http://${c.req.header("Host") || "localhost:3100"}`;
  }
  const upstream = await fetch(`${origin}/account/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VO-Link-Code": linkCode,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      node_id: nodeId,
      node_public_key: nodePublicKeyPem,
      signed_challenge: signedChallenge,
    }),
  });
  const text = await upstream.text();
  try {
    return c.json(JSON.parse(text), upstream.status as any);
  } catch {
    // Scrub the excerpt through the scanner pattern set before
    // returning it to the browser. If /account/link ever echoes
    // request content (a debug string, an error that quotes the
    // payload), the excerpt could otherwise carry the link code
    // or a signed challenge back to the client. Belt-and-
    // suspenders — current /account/link does not echo, but
    // we don't want this surface to silently regress.
    const { redactSecretsForProofEvidence } = await import("../lib/federation-proof");
    return errorJson(c, "invalid_request", { message: "upstream_non_json", details: { body_excerpt: redactSecretsForProofEvidence(text.slice(0, 200)), } });
  }
});

dashboard.post("/account/sync-token/claim", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const target = await resolveDashboardLocalNodeTarget(auth.tenantId);
  if (!target) {
    return errorJson(c, "service_unavailable", { message: "local_node_keypair_unavailable" });
  }
  const requestedNodeId = typeof body?.node_id === "string" ? body.node_id.trim() : "";
  if (requestedNodeId && requestedNodeId !== target.nodeId) {
    return errorJson(c, "conflict", { message: "node_id does not match this local node." });
  }

  const [link] = await sql`
    SELECT account_id FROM account_tenant_links
    WHERE tenant_id = ${auth.tenantId}
      AND status = 'active'
  `;
  if (!link) {
    return errorJson(c, "tenant_not_found", { message: "No active tenant link." });
  }

  const [node] = await sql`
    SELECT id, sync_token_claimed FROM hosted_nodes
    WHERE account_id = ${link.account_id}::uuid
      AND tenant_id = ${auth.tenantId}
      AND node_id = ${target.nodeId}
      AND status = 'active'
  `;
  if (!node) {
    return errorJson(c, "node_not_found", { message: `No active local node "${target.nodeId}".` });
  }
  if (node.sync_token_claimed) {
    return errorJson(c, "conflict", { message: "Sync token already claimed for this local node. Rotate instead." });
  }

  const { issueSyncToken } = await import("../lib/sync-auth");
  let issued: { raw_token: string; token_hash: string } | null = null;
  await sql.begin(async (tx: any) => {
    issued = await issueSyncToken(tx, String(link.account_id), auth.tenantId, target.nodeId);
    if (!issued) throw new Error("DASHBOARD_SYNC_TOKEN_CLAIM_RACE");
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: auth.tenantId,
      accountId: String(link.account_id),
      actor: auth.scope === "operator" ? "operator" : auth.tenantId,
      actorKind: auth.scope === "operator" ? "operator_token" : "tenant_session",
      operation: "sync_token_claimed",
      eventData: {
        node_id: target.nodeId,
        token_prefix: issued.raw_token.slice(0, 12),
        token_hash: issued.token_hash,
        source: "local_dashboard",
      },
    }, { tx, durability: "required" });
  }).catch((e: any) => {
    if (String(e?.message || "") === "DASHBOARD_SYNC_TOKEN_CLAIM_RACE") return null;
    throw e;
  });
  if (!issued) {
    return errorJson(c, "conflict", { message: "Local node changed before the token could be issued. Refresh and retry." });
  }
  const { writeLocalSyncTokenWithStatus } = await import("../lib/local-sync-token");
  const stored = writeLocalSyncTokenWithStatus((issued as { raw_token: string; token_hash: string }).raw_token, {
    tenantId: auth.tenantId,
    nodeId: target.nodeId,
    accountId: String(link.account_id),
  });

  return c.json({
    ok: true,
    claimed: true,
    node_id: target.nodeId,
    cached_locally: true,
    credential_storage: stored.status?.storage ?? null,
    keychain_attempted: stored.status?.keychain_attempted ?? false,
  });
});

dashboard.post("/account/sync-token/rotate", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const target = await resolveDashboardLocalNodeTarget(auth.tenantId);
  if (!target) {
    return errorJson(c, "service_unavailable", { message: "local_node_keypair_unavailable" });
  }
  const requestedNodeId = typeof body?.node_id === "string" ? body.node_id.trim() : "";
  if (requestedNodeId && requestedNodeId !== target.nodeId) {
    return errorJson(c, "conflict", { message: "node_id does not match this local node." });
  }

  const [link] = await sql`
    SELECT account_id FROM account_tenant_links
    WHERE tenant_id = ${auth.tenantId}
      AND status = 'active'
  `;
  if (!link) {
    return errorJson(c, "tenant_not_found", { message: "No active tenant link." });
  }

  const [node] = await sql`
    SELECT id, sync_token_claimed, sync_token_hash FROM hosted_nodes
    WHERE account_id = ${link.account_id}::uuid
      AND tenant_id = ${auth.tenantId}
      AND node_id = ${target.nodeId}
      AND status = 'active'
  `;
  if (!node) {
    return errorJson(c, "node_not_found", { message: `No active local node "${target.nodeId}".` });
  }
  if (!node.sync_token_claimed || !node.sync_token_hash) {
    return errorJson(c, "conflict", { message: "No sync token to rotate. Claim one first." });
  }

  const { issueSyncToken } = await import("../lib/sync-auth");
  let issued: { raw_token: string; token_hash: string } | null = null;
  await sql.begin(async (tx: any) => {
    issued = await issueSyncToken(tx, String(link.account_id), auth.tenantId, target.nodeId);
    if (!issued) throw new Error("DASHBOARD_SYNC_TOKEN_ROTATE_RACE");
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: auth.tenantId,
      accountId: String(link.account_id),
      actor: auth.scope === "operator" ? "operator" : auth.tenantId,
      actorKind: auth.scope === "operator" ? "operator_token" : "tenant_session",
      operation: "sync_token_rotated",
      eventData: {
        node_id: target.nodeId,
        token_prefix: issued.raw_token.slice(0, 12),
        token_hash: issued.token_hash,
        source: "local_dashboard",
      },
    }, { tx, durability: "required" });
  }).catch((e: any) => {
    if (String(e?.message || "") === "DASHBOARD_SYNC_TOKEN_ROTATE_RACE") return null;
    throw e;
  });
  if (!issued) {
    return errorJson(c, "conflict", { message: "Local node changed before the token could be rotated. Refresh and retry." });
  }
  const { writeLocalSyncTokenWithStatus } = await import("../lib/local-sync-token");
  const stored = writeLocalSyncTokenWithStatus((issued as { raw_token: string; token_hash: string }).raw_token, {
    tenantId: auth.tenantId,
    nodeId: target.nodeId,
    accountId: String(link.account_id),
  });

  return c.json({
    ok: true,
    rotated: true,
    node_id: target.nodeId,
    cached_locally: true,
    credential_storage: stored.status?.storage ?? null,
    keychain_attempted: stored.status?.keychain_attempted ?? false,
  });
});

// ── POST /dashboard/account/node/revoke ─────────────────────────
// Rung 2 local-dashboard bridge for per-device revoke
// (VO-ACCOUNT-NODE-BINDING-HARDENING-PR-1 Q3=A+).
// Resolves the local target node id server-side and calls
// the existing revokeNode() helper in hosted-admin-
// actions.ts directly (in-process) with dashboard
// actor attribution. Browser-supplied node_id values
// that don't match the configured local node are rejected
// 409 before the helper is called.
//
// Bypassing the HTTP layer is intentional: the helper
// already audits node_revoked inside its transaction
// (post rung-1 hardening), so re-using it keeps a
// single implementation of the revoke semantics. The
// HTTP /account/nodes/:node_id/revoke endpoint is still
// available (and rung-2 hardened) for direct callers
// with explicit resolveLinkControlAuth credentials.

dashboard.post("/account/node/revoke", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });

  const target = await resolveDashboardLocalNodeTarget(auth.tenantId);
  if (!target) {
    return errorJson(c, "service_unavailable", { message: "local_node_keypair_unavailable" });
  }
  const requestedNodeId = typeof body?.node_id === "string" ? body.node_id.trim() : "";
  if (requestedNodeId && requestedNodeId !== target.nodeId) {
    return errorJson(c, "conflict", { message: "node_id does not match this local node." });
  }

  // Resolve the active hosted node row for THIS configured
  // local node. revokeNode() takes the row UUID; we look it
  // up here so we never pass browser-supplied identifiers
  // into the helper.
  const [node] = await sql`
    SELECT hn.id, atl.account_id
    FROM hosted_nodes hn
    JOIN account_tenant_links atl
      ON atl.account_id = hn.account_id
     AND atl.tenant_id = hn.tenant_id
     AND atl.status = 'active'
    WHERE hn.tenant_id = ${auth.tenantId}
      AND hn.node_id = ${target.nodeId}
      AND hn.status = 'active'
    LIMIT 1
  `;
  if (!node) {
    return errorJson(c, "node_not_found", { message: `No active local node "${target.nodeId}".` });
  }

  const { revokeNode } = await import("../lib/hosted-admin-actions");
  const actorLabel = auth.scope === "operator"
    ? "local_dashboard_operator"
    : "local_dashboard_tenant";
  const result = await revokeNode(sql as any, String(node.id), {
    kind: "operator_token",
    label: actorLabel,
  }, {
    correlationId: ((c as any).get("correlation_id") as string | undefined) ?? null,
  });
  if (!result.ok) {
    return errorJson(c, "conflict", { message: result.error || "revoke_failed" });
  }

  return c.json({
    ok: true,
    revoked: true,
    node_id: target.nodeId,
    tenant_id: auth.tenantId,
  });
});

// ── POST /dashboard/account/key/rotate ──────────────────────────
// Rung 2 local-dashboard bridge for node-key rotation
// (VO-ACCOUNT-NODE-BINDING-HARDENING-PR-1 Q1=C). Signs a
// canonical rotate challenge with the CURRENT local key
// as new-key possession proof, then forwards to the
// rotation endpoint. When the operator is operator-token-
// scoped, forwards with force:true (operator-only escape
// hatch for the mismatched-state flow where the current
// local key differs from the hosted one). Tenant-token
// callers are rejected before local signing; the state
// projection also hides the action for them.
//
// Browser-supplied node_id mismatches are checked against
// the configured local node id and rejected 409 before any
// signing or forwarding happens.

dashboard.post("/account/key/rotate", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) return errorJson(c, "tenant_required", { message: "Tenant context required." });
  if (auth.scope !== "operator") {
    return errorJson(c, "operator_required", { message: "Operator auth required for key rotation." });
  }

  const {
    signRotateChallenge,
    fingerprintPublicKeyPem,
  } = await import("../lib/node-keypair");
  const target = await resolveDashboardLocalNodeTarget(auth.tenantId);
  if (!target) {
    return errorJson(c, "service_unavailable", { message: "local_node_keypair_unavailable" });
  }
  const requestedNodeId = typeof body?.node_id === "string" ? body.node_id.trim() : "";
  if (requestedNodeId && requestedNodeId !== target.nodeId) {
    return errorJson(c, "conflict", { message: "node_id does not match this local node." });
  }

  // The current local key IS the new key we want the
  // hosted side to record. Build the possession-proof
  // challenge signed by the current local private key.
  const fingerprint = fingerprintPublicKeyPem(target.publicKeyPem);
  const exp = Math.floor(Date.now() / 1000) + 60;
  const signedChallenge = signRotateChallenge({
    tenant_id: auth.tenantId,
    node_id: target.nodeId,
    kind: "rotate",
    new_public_key_fingerprint: fingerprint,
    exp,
  });

  // Forward to /account/nodes/:node_id/key/rotate.
  // This bridge is operator-token only, matching the
  // projection gate for rotate_local_node_key. A tenant-
  // token caller that bypasses the UI is rejected above
  // before any local-key signing or upstream forwarding.
  const forwardBody: Record<string, unknown> = {
    tenant_id: auth.tenantId,
    new_public_key: target.publicKeyPem,
    signed_challenge: signedChallenge,
  };
  if (auth.scope === "operator") {
    forwardBody.force = true;
  }

  let origin = "http://localhost:3100";
  try {
    origin = new URL(c.req.url).origin;
  } catch {
    origin = `http://${c.req.header("Host") || "localhost:3100"}`;
  }
  const upstream = await fetch(
    `${origin}/account/nodes/${encodeURIComponent(target.nodeId)}/key/rotate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the dashboard auth so the upstream
        // sees the same operator/tenant scope. The
        // dashboard uses tenant-token or operator-token;
        // upstream resolves via getAccessContext.
        ...(c.req.header("Authorization")
          ? { Authorization: c.req.header("Authorization") as string }
          : {}),
      },
      body: JSON.stringify(forwardBody),
    },
  );
  const text = await upstream.text();
  try {
    return c.json(JSON.parse(text), upstream.status as any);
  } catch {
    const { redactSecretsForProofEvidence } = await import("../lib/federation-proof");
    return errorJson(c, "invalid_request", { message: "upstream_non_json", details: { body_excerpt: redactSecretsForProofEvidence(text.slice(0, 200)), } });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// VAULT — VO-LOCAL-VAULT-DASHBOARD-PR-1
// ═══════════════════════════════════════════════════════════════════════
//
// All dashboard Vault reads + writes delegate to api/src/lib/vault-control
// so routes never edit ~/.vo/config.json inline, never parse discoverVault
// error strings, and never shell out directly (the control seam owns
// platform-specific open actions).
//
// Three axes that stay distinct in the response `state`:
//   - feature intent      (state.vault_enabled)
//   - root / binding      (state.vault_root / state.status_kind)
//   - Obsidian companion  (state.obsidian_installed / *_supported)
//
// `vault_sync` is a tenant-settings field owned by /dashboard/settings
// and surfaced here read-only for context; Vault routes never mutate it.

// ── GET /dashboard/vault ──────────────────────────────────────────────

dashboard.get("/vault", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }
  const { readVaultDashboardState } = await import("../lib/vault-control");
  const state = readVaultDashboardState(sql as any, auth.tenantId);
  return c.json({
    ok: true,
    state,
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_write: auth.isOperator },
  });
});

// ── GET /dashboard/vault/history ──────────────────────────────────────
//
// VO-LINKED-SOURCES-HISTORY-PR-1. Recency-ordered list of finalized
// dossiers + their honest graph-link status, for the Vault tab's
// "Linked Sources" region.
//
// Shape rules (binding):
//
//   - Readiness: gated on the SAME state machine the Vault tab uses
//     (`readVaultDashboardState`). Non-ready vaults return
//     `{ rows: [], status_kind, reason }` — they never pretend to be
//     empty-success. This keeps the Vault tab's kind model
//     load-bearing.
//
//   - Root: comes from the server's configured root via
//     `state.vault_root`. Never read `body.root` / `query.root` —
//     accepting a client-supplied path would bypass the readiness
//     gate and the tenant binding check.
//
//   - Data source: `{vault_root}/dossiers/*.dossier.md` only.
//     Finalized dossiers, no drafts, no conflicts. Frontmatter +
//     filename only — no body parsing, no index.md, no log.md, no
//     captures/.manifest.jsonl.
//
//   - Seam: calls `listVaultHistoryRows` in `vault-history.ts` — a
//     local-history reader that is INTENTIONALLY separate from
//     `listFinalizedDossierMetadata` in `vault-metadata.ts`. The
//     sync-export helper has a narrow stable contract that must
//     stay frozen; dashboard history gets its own reader.

dashboard.get("/vault/history", async (c) => {
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", { message: "Tenant context required." });
  }

  const { readVaultDashboardState } = await import("../lib/vault-control");
  const state = readVaultDashboardState(sql as any, auth.tenantId);

  // Non-ready → honest empty + status_kind. Vault tab's client
  // render must check this before showing "no harvests yet", so the
  // two states (no vault vs. empty-ready) never conflate.
  if (state.status_kind !== "ready" || !state.vault_root) {
    return c.json({
      ok: true,
      status_kind: state.status_kind,
      reason: state.status_kind,
      rows: [],
      vault_root: state.vault_root,
      _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_write: auth.isOperator },
    });
  }

  const { listVaultHistoryRows } = await import("../lib/vault-history");
  const rows = listVaultHistoryRows(state.vault_root);

  return c.json({
    ok: true,
    status_kind: "ready",
    vault_root: state.vault_root,
    rows,
    count: rows.length,
    _auth: { tenant_id: auth.tenantId, scope: auth.scope, can_write: auth.isOperator },
  });
});

// ── POST /dashboard/vault/enabled ─────────────────────────────────────

dashboard.post("/vault/enabled", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  if (typeof body.enabled !== "boolean") {
    return errorJson(c, "invalid_request", { message: "enabled must be a boolean (true | false)." });
  }
  const { writeVaultEnabled } = await import("../lib/vault-control");
  try {
    const result = writeVaultEnabled(body.enabled);
    return c.json({ ok: true, previous: result.previous, next: result.next });
  } catch (e) {
    console.error("[dashboard/vault/enabled] failed:", e);
    return errorJson(c, "invalid_request", { message: "Vault enabled setting update failed" });
  }
});

// ── POST /dashboard/vault/root ────────────────────────────────────────

dashboard.post("/vault/root", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  const rootRaw = body.root;
  // Distinguish "not provided" (missing key) from "explicitly null" (clear).
  let rootValue: string | null | undefined;
  if (rootRaw === null) {
    rootValue = null;
  } else if (typeof rootRaw === "string") {
    const trimmed = rootRaw.trim();
    rootValue = trimmed ? trimmed : null;
  } else {
    rootValue = undefined;
  }
  if (rootValue === undefined) {
    return errorJson(c, "invalid_request", { message: "root must be an absolute path string or null." });
  }
  const { writeVaultRoot } = await import("../lib/vault-control");
  try {
    const result = writeVaultRoot(rootValue);
    return c.json({ ok: true, previous: result.previous, next: result.next });
  } catch (e) {
    console.error("[dashboard/vault/root] failed:", e);
    return errorJson(c, "invalid_request", { message: "Vault root update failed" });
  }
});

// ── POST /dashboard/vault/init ────────────────────────────────────────

dashboard.post("/vault/init", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  const rootRaw = body.root;
  const explicitRoot = typeof rootRaw === "string" && rootRaw.trim() ? rootRaw.trim() : undefined;
  const { initializeVaultFromDashboard } = await import("../lib/vault-control");
  const result = initializeVaultFromDashboard({ root: explicitRoot, tenantId: auth.tenantId });
  if (!result.ok) {
    // 409 Conflict covers every "existing state at this root is malformed
    // and must be resolved by the operator first" case: tenant_mismatch
    // (bound to a different tenant), missing_tenant_binding (marker
    // present but no tenant_id), invalid_marker_json (marker present but
    // unparseable). 400 Bad Request covers the caller-input reasons
    // (no_root, not_absolute, not_directory). scaffold_failed is 500.
    const conflictReasons = new Set(["tenant_mismatch", "missing_tenant_binding", "invalid_marker_json"]);
    const serverErrorReasons = new Set(["scaffold_failed"]);
    const status = conflictReasons.has(result.reason) ? 409
      : serverErrorReasons.has(result.reason) ? 500
      : 400;
    return errorJson(c, errorCodeForHttpStatus(status), {
      message: result.error,
      details: { reason: result.reason, details: result.details },
    });
  }
  return c.json({
    ok: true,
    root: result.root,
    tenant_id: result.tenant_id,
    scaffold: result.scaffold,
  });
});

// ── POST /dashboard/vault/open ────────────────────────────────────────

dashboard.post("/vault/open", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  const { resolveConfiguredVaultRoot, inspectVaultRoot, openVaultRoot } = await import("../lib/vault-control");
  const configured = resolveConfiguredVaultRoot();
  if (!configured.root) {
    return errorJson(c, "invalid_request", { message: "No vault root configured." });
  }
  const inspection = inspectVaultRoot(configured.root, auth.tenantId);
  if (!inspection.ok) {
    return errorJson(c, "conflict", {
      message: inspection.error,
      details: { reason: inspection.reason },
    });
  }
  const openResult = openVaultRoot(configured.root);
  if (!openResult.ok) {
    // supported=false → 501 Not Implemented; supported=true but failed → 500.
    const status = openResult.supported ? 500 : 501;
    return errorJson(c, errorCodeForHttpStatus(status), {
      message: openResult.error || "Open failed.",
      details: { supported: openResult.supported },
    });
  }
  return c.json({ ok: true });
});

// ── POST /dashboard/vault/harvest ─────────────────────────────────────
//
// VO-LOCAL-DASHBOARD-HARVEST-PR-1 — the first real no-terminal
// operator surface for local harvest. This route:
//
//   - requires operator auth (same posture as the other vault-mutating
//     routes: enabled / root / init / open / open-obsidian)
//   - gates on `readVaultDashboardState(...).status_kind === "ready"` —
//     the SAME state machine the Vault tab renders from. This covers
//     feature-intent (`vault_enabled`), configured root, root
//     inspection, tenant binding, and marker validity in one
//     single-source-of-truth call, so a direct POST cannot bypass the
//     UI's (`canWrite && kind === 'ready'`) visibility gate.
//   - the dashboard NEVER accepts a freeform `body.root` for harvest —
//     the root comes from `state.vault_root` (i.e. from
//     `resolveConfiguredVaultRoot`), never from the request body.
//   - calls `runVaultHarvestAuto()` from the shared engine directly
//     (api/src/lib/vault-harvest.ts). No CLI subprocess. No formatted
//     text parsing. The structured `AutoOutcome` is returned as JSON
//     plus a pre-rendered HTML fragment for the Vault tab.
//   - resolves a tenant-scoped bearer via
//     `resolveAgentBearerForTenant(auth.tenantId)` for the engine's
//     `tenantToken` argument. The operator bearer is NOT usable here:
//     /memory/write requires `access.tenantId`, and operator tokens
//     resolve to `tenantId: null`. When no agent → tenant mapping is
//     configured for the selected tenant, the route fails up-front
//     with a clear `tenant_bearer_missing` error rather than letting
//     the harvest silently degrade into an all-writes-failed stop.
//   - threads the caller's operator bearer as `operatorToken` — this
//     is only used by the engine for /ops/link-doc, which accepts
//     operator auth.

/**
 * Test-only override for the engine runner. Production code leaves
 * this `null`; the route falls back to the real dynamic import.
 * Tests set a stub via `__setHarvestRunnerForTests(...)` so the
 * route can be driven through representative AutoOutcomes without
 * touching the real filesystem / HTTP / LLM layers.
 *
 * Intentionally NOT exported as part of the public surface — the
 * underscore-prefixed setter signals intent ("tests only") and lets
 * the suite restore the production path cleanly in afterEach.
 */
type HarvestRunnerFn = (typeof import("../lib/vault-harvest"))["runVaultHarvestAuto"];
let harvestRunnerOverride: HarvestRunnerFn | null = null;
export function __setHarvestRunnerForTests(fn: HarvestRunnerFn | null): void {
  harvestRunnerOverride = fn;
}

dashboard.post("/vault/harvest", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) {
    return errorJson(c, "invalid_request", { message: "source is required (file path or URL)." });
  }

  // Vault-tab parity gate — same state machine the UI consumes, so a
  // direct POST cannot bypass the `canWrite && kind === 'ready'`
  // visibility gate. status_kind covers vault_enabled (→ "disabled"),
  // missing/invalid/unmarked roots, and tenant-mismatched bindings.
  const { readVaultDashboardState } = await import("../lib/vault-control");
  const vaultState = readVaultDashboardState(null, auth.tenantId);
  if (vaultState.status_kind !== "ready" || !vaultState.vault_root) {
    return errorJson(c, "conflict", {
      message: vaultState.discovery_error
        ?? `Vault is not ready (status: ${vaultState.status_kind}).`,
      details: {
        reason: vaultState.status_kind,
        status_kind: vaultState.status_kind,
      },
    });
  }

  // Tenant-scoped bearer for /memory/write. Operator bearer is NOT
  // usable — /memory/write requires access.tenantId, and operator
  // tokens resolve to tenantId: null. Fail up-front when the server
  // has no agent-token mapping for this tenant so the operator sees
  // a configuration error instead of a silent all-writes-failed stop.
  const { resolveAgentBearerForTenant } = await import("../lib/access");
  const tenantBearer = resolveAgentBearerForTenant(auth.tenantId);
  if (!tenantBearer) {
    return errorJson(c, "conflict", {
      message: `No agent token configured for tenant "${auth.tenantId}" on this server.`,
      hint: "Set VERITY_AGENT_TOKENS and VERITY_AGENT_TENANTS in the API env so graph writes can authenticate.",
      details: {
        reason: "tenant_bearer_missing",
      },
    });
  }

  // Operator bearer for /ops/link-doc only. The engine skips link-doc
  // honestly if this is null.
  const operatorBearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "") || null;

  // Engine call via the injectable test seam. Production path is the
  // real shared engine; tests override via __setHarvestRunnerForTests
  // to drive the route against representative AutoOutcomes without
  // hitting the real filesystem / HTTP / LLM layers.
  const runner = harvestRunnerOverride
    ?? (await import("../lib/vault-harvest")).runVaultHarvestAuto;
  const outcome = await runner({
    root: vaultState.vault_root,
    source,
    tenantToken: tenantBearer,
    operatorToken: operatorBearer,
    verbose: false,
  });

  const { renderHarvestOutcomeHtml } = await import("../lib/dashboard-harvest-ui");
  const html = renderHarvestOutcomeHtml(outcome);

  return c.json({ ok: true, outcome, html });
});

// ── POST /dashboard/vault/open-obsidian ───────────────────────────────

dashboard.post("/vault/open-obsidian", async (c) => {
  if (!isOperator(c)) {
    return errorJson(c, "operator_required", { message: "Operator auth required." });
  }
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const auth = resolveDashboardTenant(c, "POST", body);
  if (!auth) {
    return errorJson(c, "invalid_request", { message: "tenant_id required in body." });
  }
  const { resolveConfiguredVaultRoot, inspectVaultRoot, openVaultInObsidian, openObsidianFile } = await import("../lib/vault-control");
  const configured = resolveConfiguredVaultRoot();
  if (!configured.root) {
    return errorJson(c, "invalid_request", { message: "No vault root configured." });
  }
  const inspection = inspectVaultRoot(configured.root, auth.tenantId);
  if (!inspection.ok) {
    return errorJson(c, "conflict", {
      message: inspection.error,
      details: { reason: inspection.reason },
    });
  }

  // Rung 3: when a specific dossier path is supplied, open THAT file via the
  // obsidian://open URL instead of the whole vault. If the caller also passes
  // the stamped sha256, verify-on-click that the on-disk file still matches
  // before handing off — refuse rather than open a tampered/stale dossier.
  const vaultFilePath = typeof body.vault_file_path === "string" ? body.vault_file_path.trim() : "";
  if (vaultFilePath) {
    if (
      vaultFilePath.startsWith("/") ||
      vaultFilePath.includes("..") ||
      /^[A-Za-z]:[\\/]/.test(vaultFilePath)
    ) {
      return errorJson(c, "invalid_request", {
        message: "vault_file_path must be vault-relative without traversal.",
        details: { reason: "vault_file_path_invalid" },
      });
    }
    const expectedSha = typeof body.expected_sha256 === "string" ? body.expected_sha256.trim() : "";
    if (expectedSha) {
      const { verifyDossierHash } = await import("../lib/vault-write");
      const verdict = verifyDossierHash(configured.root, vaultFilePath, expectedSha);
      if (!verdict.ok) {
        return errorJson(c, "conflict", {
          message: `Dossier hash check failed (${verdict.reason}). The on-disk file does not match the stamped source.`,
          details: { reason: verdict.reason, actual_sha256: verdict.actualSha256 },
        });
      }
    }
    const fileResult = openObsidianFile(configured.root, vaultFilePath);
    if (!fileResult.ok) {
      const status = fileResult.supported ? 500 : 501;
      return errorJson(c, errorCodeForHttpStatus(status), {
        message: fileResult.error || "Open failed.",
        details: { supported: fileResult.supported },
      });
    }
    return c.json({ ok: true, opened: "file", vault_file_path: vaultFilePath });
  }

  const openResult = openVaultInObsidian(configured.root);
  if (!openResult.ok) {
    const status = openResult.supported ? 500 : 501;
    return errorJson(c, errorCodeForHttpStatus(status), {
      message: openResult.error || "Open failed.",
      details: { supported: openResult.supported },
    });
  }
  return c.json({ ok: true, opened: "vault" });
});

// ── GET /dashboard/mcp-controls.json ─────────────────────────────────
// Read-only MCP + VO Skill control status for the dashboard's
// "Clients + Skill" tab. Evidence source is the gitignored
// operator-acceptance artifact at
// `agent-lab/proof/vo-mcp-client-acceptance/result.json` on this
// same machine. No shell-out, no subprocess, no writes — the
// dashboard is a reader; the operator records / installs / doctors
// from their own terminal.
//
// VO-MCP-DASHBOARD-CONTROLS-PR-1.
dashboard.get("/mcp-controls.json", async (c) => {
  // Match every other `/dashboard/*` GET: accept tenant tokens
  // directly AND accept operator tokens with `?tenant_id=<id>`
  // via the shared `resolveDashboardTenant` helper. A bare
  // `getAccessContext(c).tenantId` check would 403 operator-
  // token dashboard sessions that work on the other tabs.
  const auth = resolveDashboardTenant(c, "GET");
  if (!auth) {
    return errorJson(c, "tenant_required", {
      message: "Tenant context required. Use tenant token or operator token with ?tenant_id=<id>.",
    });
  }
  const repoRoot = resolveRepoRoot();
  const read = readAcceptanceArtifact(repoRoot);
  // Rung 10: use the async wrapper that runs the Skill checker
  // helpers directly (NOT via the action runner's audit log)
  // and threads their output into the sync row computation.
  // See `docs/VO-MCP-SKILL-CHECKER-DESIGN.md` § "Evidence
  // transport".
  const rows = await computeAllControlRowsWithCheckers(read);
  // Artifact-level summary for the dashboard header.
  const artifact_summary = (() => {
    switch (read.kind) {
      case "missing":
        return {
          kind: read.kind,
          path: read.expected_path,
          note:
            "No operator-acceptance artifact recorded yet on this machine. Run the acceptance recorder locally to populate it.",
        };
      case "malformed":
        return {
          kind: read.kind,
          path: read.path,
          note: `Artifact malformed: ${read.error}`,
        };
      case "stale":
        return {
          kind: read.kind,
          path: read.path,
          age_ms: read.age_ms,
          max_age_ms: read.max_age_ms,
          note: "Artifact file older than 72h. Re-record to refresh.",
        };
      case "ok":
        return {
          kind: read.kind,
          path: read.path,
          age_ms: read.age_ms,
          note: "Fresh operator-acceptance artifact in use for MCP rows.",
        };
    }
  })();
  return c.json({
    ok: true,
    // Dashboard explicitly documents its evidence posture so a
    // future consumer cannot accidentally claim the dashboard has
    // shelled out. MCP rows use the acceptance artifact; VO Skill
    // rows also use the rung-10 read-only filesystem checker.
    source: "artifact_and_skill_checker",
    artifact_summary,
    rows,
    // Full operator-command palette — click-to-copy strings the
    // dashboard renders in order. Exposing the whole activation
    // sequence (install → doctor → live-doctor → recorder →
    // interop → activation-doc → skill-file) means the dashboard
    // matches the PR report's copy claims instead of shipping
    // only whichever command a single row's `next_action`
    // happens to highlight.
    commands: dashboardControlCopyCommands(),
  });
});

// ── Local action runner routes (read-only slice) ─────────────────
// VO-MCP-LOCAL-ACTION-RUNNER-READONLY-PR-1.
//
// Two routes that implement the preview → confirm → execute
// lifecycle pinned in `docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md`.
// Scope for THIS PR: three read-only descriptors only — live MCP
// handshake, Claude Desktop config doctor, Codex config doctor.
// No file-mutation, artifact-write, or Skill action ships here.
//
// Wire protocol (design-bound):
//
//   POST /dashboard/mcp-actions/preview
//     body: { action_id: "<enum>", args: { … per descriptor … } }
//     → { ok, preview: { …, confirmation_token } }
//
//   POST /dashboard/mcp-actions/execute
//     body: { action_id, args, confirmation_token }
//     → { ok, result: { outcome, summary (redacted), status_after } }
//
// The browser NEVER sends command / argv / cwd / env. A request
// body that carries any of those fields is refused 400.
// `resolveDashboardTenant(c, "POST", body)` handles operator-token
// tenant resolution like every other POST route.

function isLoopbackOrigin(raw: string | null | undefined): boolean {
  // No Origin header → accept (curl / server-internal callers).
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

dashboard.post("/mcp-actions/preview", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const obj = read.body;
  // Origin pinning — refuse any non-loopback Origin outright. A
  // missing Origin (curl, server-internal) is allowed; a PRESENT
  // Origin from a non-loopback host is a dashboard-as-remote-
  // control attempt, refused.
  if (!isLoopbackOrigin(c.req.header("origin"))) {
    return errorJson(c, "forbidden", { message: "non-loopback Origin not permitted" });
  }
  // Shell-relay refusal applied before tenant resolution so a
  // stray `command`/`argv`/`cwd`/`env` field never touches any
  // privileged code path.
  for (const forbidden of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (forbidden in obj) {
      return errorJson(c, "invalid_request", {
        message: `request body must not include "${forbidden}"; the browser never supplies shell arguments`,
      });
    }
  }
  const auth = resolveDashboardTenant(c, "POST", obj);
  if (!auth) {
    return errorJson(c, "tenant_required", {
      message: "Tenant context required. Use tenant token or operator token with tenant_id.",
    });
  }
  const action_id = typeof obj.action_id === "string" ? obj.action_id : "";
  const args = (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args))
    ? (obj.args as Record<string, unknown>)
    : {};
  const outcome = previewAction({ action_id, args, tenant_id: auth.tenantId });
  if (!outcome.ok) {
    return errorJson(c, errorCodeForHttpStatus(outcome.status), { message: outcome.error });
  }
  return c.json({ ok: true, preview: outcome.preview });
});

dashboard.post("/mcp-actions/execute", async (c) => {
  const read = await readDashboardJsonObject(c);
  if (!read.ok) return read.response;
  const obj = read.body;
  if (!isLoopbackOrigin(c.req.header("origin"))) {
    return errorJson(c, "forbidden", { message: "non-loopback Origin not permitted" });
  }
  for (const forbidden of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (forbidden in obj) {
      return errorJson(c, "invalid_request", {
        message: `request body must not include "${forbidden}"; the browser never supplies shell arguments`,
      });
    }
  }
  const auth = resolveDashboardTenant(c, "POST", obj);
  if (!auth) {
    return errorJson(c, "tenant_required", {
      message: "Tenant context required. Use tenant token or operator token with tenant_id.",
    });
  }
  const action_id = typeof obj.action_id === "string" ? obj.action_id : "";
  const confirmation_token = typeof obj.confirmation_token === "string" ? obj.confirmation_token : "";
  const args = (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args))
    ? (obj.args as Record<string, unknown>)
    : {};
  const out = await executeAction({
    action_id,
    args,
    confirmation_token,
    tenant_id: auth.tenantId,
  });
  if (!out.ok) {
    recordAudit({
      ts: new Date().toISOString(),
      action_id,
      tenant_id: auth.tenantId,
      outcome: "refused",
      summary: out.error,
    });
    return errorJson(c, errorCodeForHttpStatus(out.status), { message: out.error });
  }
  recordAudit({
    ts: new Date().toISOString(),
    action_id,
    tenant_id: auth.tenantId,
    outcome: out.result.outcome,
    duration_ms: out.result.duration_ms,
    summary: out.result.summary,
  });
  return c.json({ ok: true, result: out.result });
});

// ── Helpers used by the dashboard HTML shell below ─────────────
// Exported for test visibility; not part of the public API shape.
export function dashboardControlCopyCommands(): Record<
  "install_claude_desktop"
  | "install_codex"
  | "install_generic"
  | "config_doctor_claude_desktop"
  | "config_doctor_codex"
  | "live_doctor"
  | "recorder_claude_desktop"
  | "recorder_codex"
  | "interop_proof"
  | "activation_doc"
  | "skill_file",
  string
> {
  return {
    install_claude_desktop: "vo mcp install --client claude-desktop",
    install_codex: "vo mcp install --client codex",
    install_generic: "vo mcp install --client generic",
    config_doctor_claude_desktop: "vo-mcp doctor --client claude-desktop",
    config_doctor_codex: "vo-mcp doctor --client codex",
    live_doctor: "vo-mcp doctor",
    recorder_claude_desktop:
      "bun run agent-lab/scripts/record-mcp-client-acceptance.ts --client claude-desktop --status pass --observed vo_memory_recall --summary '<what you saw>' --result '<shape>' --config-doctor-ran --live-doctor-ran",
    recorder_codex:
      "bun run agent-lab/scripts/record-mcp-client-acceptance.ts --client codex --status pass --observed vo_memory_recall --summary '<what you saw>' --result '<shape>' --config-doctor-ran --live-doctor-ran",
    interop_proof: "bun run agent-lab/scripts/run-mcp-interop-proof.ts",
    activation_doc: "docs/VO-MCP-ACTIVATION.md",
    skill_file: "mcp/skills/verity-one-mcp/SKILL.md",
  };
}

// Tiny type re-export so test files don't have to reach into
// the lib path twice.
export type { DashboardControlRow };

export default dashboard;

// ═══════════════════════════════════════════════════════════════════════
// HTML DASHBOARD — self-contained, no build step
// ═══════════════════════════════════════════════════════════════════════

// Local shell extras: sidebar + tabs + density-floor specific styles
// (everything else comes from the shared seam — buildStyleBlock("local", ...))
const LOCAL_SHELL_EXTRAS = `
/* ── ${SHARED_SEAM_MARKER} :: local shell extras ── */

/* ── Layout ── */
.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 220px; flex-shrink: 0;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  padding: 1.5rem 0;
  display: flex; flex-direction: column;
}
.main {
  flex: 1; padding: 1.75rem 2rem; overflow-y: auto;
  /* Density floor: 1440px viewport = ~1220px content; keep ~30 row tables wide */
  max-width: 1280px;
}

/* ── Brand ── */
.brand {
  padding: 0 1.25rem 1.25rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: .85rem;
}
.brand h1 {
  font-size: 1.05rem; font-weight: 700;
  color: var(--text); letter-spacing: -0.01em;
}
.brand .sub {
  font-size: .68rem; color: var(--text-muted);
  margin-top: .15rem; font-family: var(--font-mono);
  text-transform: uppercase; letter-spacing: .07em;
}

/* ── Tabs (sidebar nav) — control flow markup, do not change shape ── */
.tabs { list-style: none; flex: 1; }
.tabs li {
  padding: .5rem 1.25rem;
  font-size: .85rem; font-weight: 500;
  cursor: pointer; color: var(--text-secondary);
  border-left: 2px solid transparent;
  transition: color .12s, background .12s, border-color .12s;
}
.tabs li:hover { color: var(--text); background: var(--bg-secondary); }
.tabs li.active {
  color: var(--text); border-left-color: var(--accent);
  background: var(--bg-secondary);
}
.tabs li.disabled {
  color: var(--text-muted); cursor: default; opacity: .5;
}
.tabs li.disabled:hover { background: none; color: var(--text-muted); }
.tab-badge {
  display: inline-block; font-size: .6rem; padding: .1rem .4rem;
  background: var(--border); color: var(--text-muted); border-radius: var(--radius-sm);
  margin-left: .4rem; vertical-align: middle; font-weight: 600;
}

/* ── Checklist (Setup card) ── */
.checklist { list-style: none; }
.checklist li {
  display: flex; align-items: center; gap: .5rem;
  padding: .35rem 0; font-size: .85rem;
}
.check-icon { font-size: .9rem; }
.check-done { color: var(--green); }
.check-pending { color: var(--text-muted); }

/* ── Activity rows (compact density list) ── */
.event-row {
  display: flex; gap: .75rem; padding: .5rem 0;
  border-bottom: 1px solid var(--border); font-size: .82rem;
}
.event-row:last-child { border-bottom: none; }
.event-type {
  font-family: var(--font-mono); font-size: .72rem; font-weight: 600;
  padding: .15rem .5rem; border-radius: var(--radius-sm);
  background: var(--bg-secondary); color: var(--text-secondary);
  border: 1px solid var(--border);
  white-space: nowrap; align-self: flex-start;
}
.event-meta { flex: 1; }
.event-addr { font-family: var(--font-mono); color: var(--highlight); font-size: .75rem; }
.event-label { color: var(--text-secondary); }
.event-time { color: var(--text-muted); font-size: .72rem; white-space: nowrap; }

/* ── Token gate ── */
.gate {
  display: flex; align-items: center; justify-content: center;
  min-height: 80vh; text-align: center;
}
.gate-box {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 2.25rem; max-width: 420px; width: 100%;
}
.gate-box h2 { font-size: 1.05rem; margin-bottom: .5rem; color: var(--text); }
.gate-box p { font-size: .85rem; color: var(--text-secondary); margin-bottom: 1.25rem; }
.gate-input {
  width: 100%; padding: .6rem .85rem; font-family: var(--font-mono);
  font-size: .82rem; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  outline: none; margin-bottom: .65rem;
}
.gate-input:focus { border-color: var(--accent); }
.gate-btn {
  width: 100%; padding: .6rem; font-size: .85rem; font-weight: 600;
  background: var(--accent); color: var(--accent-fg); border: none; border-radius: var(--radius-sm);
  cursor: pointer; transition: opacity .12s;
}
.gate-btn:hover { opacity: .9; }
.gate-error { color: var(--red); font-size: .8rem; margin-top: .65rem; }

/* ── Card-dither: subtle marker for primary attention card ── */
.card-dither {
  background-image:
    repeating-linear-gradient(
      0deg,
      transparent, transparent 1px,
      color-mix(in srgb, var(--accent) 6%, transparent) 1px,
      color-mix(in srgb, var(--accent) 6%, transparent) 2px
    );
  background-size: 2px 2px;
  background-position: top right;
  background-repeat: repeat-y;
  background-clip: padding-box;
}

/* ── VO-HARVEST-DRAG-FEEDBACK-PR-1 — drag-over state ──
   Visible cue that #vault-harvest-card accepts the active drag.
   JS already toggles this class on dragenter/dragover/dragleave/
   drop; without a style rule the class was a silent no-op. */
.vault-harvest-dragover {
  outline: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent);
  outline-offset: -2px;
  background-color: color-mix(in srgb, var(--accent) 4%, transparent);
}

/* ── Collapsible ── */
.collapse-header {
  display: flex; justify-content: space-between; align-items: center;
  cursor: pointer; user-select: none; padding: .5rem 0;
}
.collapse-header:hover { color: var(--text); }
.collapse-toggle { font-size: .7rem; color: var(--text-muted); transition: transform .12s; }
.collapse-body { overflow: hidden; }
.collapse-body.collapsed { display: none; }

/* ── Inline forms ── */
.inline-form { display: flex; gap: .5rem; margin-top: .5rem; flex-wrap: wrap; }

/* ── Structure rows ── */
.structure-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: .45rem .6rem; border-bottom: 1px solid var(--border);
  font-size: .83rem;
}
.structure-row:last-child { border-bottom: none; }
.structure-label { flex: 1; }
.structure-desc { color: var(--text-muted); font-size: .75rem; margin-top: .1rem; }
.structure-actions { display: flex; gap: .3rem; flex-shrink: 0; }
.structure-meta { font-family: var(--font-mono); font-size: .7rem; color: var(--text-muted); margin-right: .5rem; }
.archived-tag {
  font-size: .65rem; padding: .1rem .35rem;
  background: var(--border); color: var(--text-muted); border-radius: var(--radius-sm);
}

/* ── Review layout ── */
.review-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.review-list-item {
  padding: .55rem .75rem; border-bottom: 1px solid var(--border);
  cursor: pointer; font-size: .83rem; transition: background .1s;
}
.review-list-item:hover { background: var(--bg-secondary); }
.review-list-item.selected {
  background: var(--bg-secondary); border-left: 2px solid var(--accent);
}
.review-kind { font-family: var(--font-mono); font-size: .68rem; color: var(--text-secondary); }
.review-overlay { font-size: .65rem; color: var(--highlight); margin-left: .3rem; }
.review-quality { font-size: .65rem; color: var(--text-muted); margin-left: .3rem; }
.review-quality-reason { font-size: .7rem; color: var(--text-muted); margin-top: .15rem; }
.audit-field { padding: .3rem 0; font-size: .82rem; border-bottom: 1px solid var(--border); }
.audit-field:last-child { border-bottom: none; }
.audit-label { color: var(--text-muted); font-size: .72rem; }
.audit-value { font-family: var(--font-mono); color: var(--text); font-size: .8rem; }
.action-bar { display: flex; gap: .5rem; margin-top: .75rem; flex-wrap: wrap; }
.status-msg { font-size: .8rem; margin-top: .5rem; }
.status-ok { color: var(--green); }
.status-err { color: var(--red); }
.warn-badge { font-size: .68rem; color: var(--amber); margin-left: .3rem; }

/* ── Attention actions ── */
.alert-action-row {
  display: flex; align-items: center; gap: .55rem;
}
.alert-action-row .alert-message { flex: 1; min-width: 0; }
.attention-action {
  width: 100%; display: grid; grid-template-columns: auto 1fr auto auto;
  align-items: center; gap: .65rem; margin: .42rem 0; padding: .72rem .78rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: inherit; font: inherit; text-align: left; cursor: pointer;
  background: color-mix(in srgb, var(--bg-raised) 92%, var(--accent) 8%);
  transition: border-color .12s, background .12s, transform .12s;
}
.attention-action.red { border-left: 3px solid var(--red); }
.attention-action.amber { border-left: 3px solid var(--amber); }
.attention-action:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--bg-raised) 84%, var(--accent) 16%);
}
.attention-action:focus-visible,
.check-action:focus-visible,
.stat-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 80%, transparent);
  outline-offset: 2px;
}
.attention-message { min-width: 0; color: var(--text); }
.attention-target {
  color: var(--highlight); font-family: var(--font-mono);
  font-size: .68rem; text-transform: uppercase; letter-spacing: .06em;
}
.attention-arrow { color: var(--text-muted); font-size: .9rem; }
.dashboard-mini-action { margin-left: auto; white-space: nowrap; }
.check-action,
.stat-action {
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border: 1px solid transparent; background: transparent;
}
.check-action {
  display: flex; align-items: center; gap: .5rem; width: 100%;
  padding: .35rem .4rem; border-radius: var(--radius-sm);
}
.check-action:hover,
.stat-action:hover {
  background: var(--bg-secondary); border-color: var(--border);
}
.check-label { flex: 1; }
.check-cta {
  color: var(--highlight); font-size: .72rem; font-family: var(--font-mono);
}
.stat-action {
  border-radius: var(--radius); padding: .72rem .8rem;
  min-height: 74px; display: flex; flex-direction: column;
  justify-content: center; gap: .12rem;
}
.stat-action .stat-value,
.stat .stat-value {
  font-variant-numeric: tabular-nums;
}
.home-summary-card {
  width: 100%; display: block; color: inherit; font: inherit; text-align: left;
  cursor: pointer; border-color: var(--border);
  transition: border-color .12s, background .12s, transform .12s;
}
.home-summary-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--bg-raised) 90%, var(--accent) 10%);
}
.home-summary-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 80%, transparent);
  outline-offset: 2px;
}
.home-summary-title {
  display: flex; align-items: center; justify-content: space-between; gap: .75rem;
}
.focus-banner {
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-raised));
  color: var(--text-secondary);
  border-radius: var(--radius); padding: .65rem .75rem;
  font-size: .82rem; margin-bottom: 1rem;
}
.filter-bar {
  display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .75rem;
}
.filter-chip.active {
  background: var(--accent); color: var(--accent-fg); border-color: var(--accent);
}

@media (max-width: 768px) {
  .review-layout { grid-template-columns: 1fr; }
  .shell { flex-direction: column; }
  .sidebar {
    width: 100%; border-right: none;
    border-bottom: 1px solid var(--border); padding: 1rem 0;
  }
  .tabs { display: flex; overflow-x: auto; gap: 0; }
  .tabs li {
    border-left: none; border-bottom: 2px solid transparent;
    white-space: nowrap; padding: .5rem .75rem; font-size: .78rem;
  }
  .tabs li.active {
    border-bottom-color: var(--accent); border-left-color: transparent;
  }
  .main { padding: 1rem; }
}
`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verity One — Dashboard</title>
<style>
${buildStyleBlock("local", LOCAL_SHELL_EXTRAS)}
</style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="brand">
      <h1>Verity One</h1>
      <div class="sub">local dashboard</div>
    </div>
    <ul class="tabs" id="tabs">
      <li class="active" data-tab="home">Home</li>
      <li data-tab="structure">Structure</li>
      <li data-tab="review">Review</li>
      <li data-tab="activity">Activity</li>
      <li data-tab="sessions">Sessions</li>
      <li data-tab="providers">Providers</li>
      <li data-tab="routines">Routines</li>
      <li data-tab="vault">Vault</li>
      <li data-tab="mcp-controls">Clients + Skill</li>
      <li data-tab="trends">Trends</li>
      <li data-tab="settings">Settings</li>
      <li data-tab="account">Account / Sync</li>
    </ul>
  </nav>
  <main class="main" id="content">
    <!-- Populated by JS based on auth state -->
  </main>
</div>

<script>
(function() {
  const TOKEN_KEY = 'vo_dashboard_token';
  const TENANT_KEY = 'vo_dashboard_tenant_id';
  const POLL_MS = 30000;
  const content = document.getElementById('content');
  let pollTimer = null;
  let accountPollTimer = null;
  let waitingLoopActive = false;
  let currentData = null;
  let dayJournalRoutineIndex = {};
  let dayJournalDryRunRequiredPermissions = [];

  // ── State machine ─────────────────────────────────────────────────
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function getTenantId() { return localStorage.getItem(TENANT_KEY); }
  function setTenantId(t) { if (t) localStorage.setItem(TENANT_KEY, t); else localStorage.removeItem(TENANT_KEY); }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (accountPollTimer) { clearInterval(accountPollTimer); accountPollTimer = null; }
    waitingLoopActive = false;
  }
  function clearToken() {
    stopPoll();
    currentData = null;
    authMeta = null;
    dayJournalRoutineIndex = {};
    dayJournalDryRunRequiredPermissions = [];
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
    // Any cached harvest guidance is bound to the identity it was
    // rendered for — never carry it past a token/tenant wipe.
    clearLastHarvestResult();
  }
  function dashUrl(path) {
    var tid = currentTenantId();
    return path + (tid ? (path.includes('?') ? '&' : '?') + 'tenant_id=' + encodeURIComponent(tid) : '');
  }
  function authHeaders() { return { Authorization: 'Bearer ' + getToken() }; }
  function currentTenantId() {
    return (authMeta && authMeta.tenant_id) || (currentData && currentData._auth && currentData._auth.tenant_id) || getTenantId() || '';
  }

  var activeTab = 'home';
  var authMeta = null; // populated after first overview load
  var pendingDashboardIntent = null;

  function render() {
    var token = getToken();
    if (!token) { renderGate(); return; }
    renderLoading();
    loadTab(activeTab);
  }

  function switchTab(tab) {
    if (tab === activeTab) return;
    var items = document.querySelectorAll('#tabs li');
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      if (li.classList.contains('disabled')) continue;
      li.classList.toggle('active', li.getAttribute('data-tab') === tab);
    }
    activeTab = tab;
    stopPoll();
    renderLoading();
    loadTab(tab);
  }

  function setDashboardIntent(tab, filter) {
    pendingDashboardIntent = { tab: tab, filter: filter || '' };
  }

  function takeDashboardIntent(tab) {
    if (pendingDashboardIntent && pendingDashboardIntent.tab === tab) {
      var intent = pendingDashboardIntent;
      pendingDashboardIntent = null;
      return intent;
    }
    return null;
  }

  function goDashboardTarget(tab, filter) {
    if (!tab) return;
    setDashboardIntent(tab, filter || '');
    if (tab === activeTab) {
      renderLoading();
      loadTab(tab);
      return;
    }
    switchTab(tab);
  }

  function wireDashboardActions(root) {
    var scope = root || content;
    var controls = scope.querySelectorAll('[data-dash-tab]');
    for (var i = 0; i < controls.length; i++) {
      controls[i].addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        goDashboardTarget(this.getAttribute('data-dash-tab'), this.getAttribute('data-dash-filter') || '');
      });
    }
  }

  // Wire tab clicks
  document.getElementById('tabs').addEventListener('click', function(e) {
    var li = e.target.closest('li[data-tab]');
    if (!li || li.classList.contains('disabled')) return;
    switchTab(li.getAttribute('data-tab'));
  });

  function loadTab(tab) {
    if (tab === 'home') { fetchOverview(); return; }
    if (tab === 'structure') { fetchStructure(); return; }
    if (tab === 'review') { fetchReview(); return; }
    if (tab === 'activity') { fetchActivity(); return; }
    if (tab === 'sessions') { fetchSessions(); return; }
    if (tab === 'settings') { fetchSettings(); return; }
    if (tab === 'providers') { fetchProviders(); return; }
    if (tab === 'routines') { fetchRoutines(); return; }
    if (tab === 'vault') { fetchVault(); return; }
    if (tab === 'mcp-controls') { fetchMcpControls(); return; }
    if (tab === 'trends') { fetchTrends(); return; }
    if (tab === 'account') { fetchAccount(); return; }
    activeTab = 'home';
    content.innerHTML = '<div class="state-msg">Unknown dashboard tab. Returning to Home.</div>';
    fetchOverview();
  }

  // ── Token gate ────────────────────────────────────────────────────
  function renderGate(error) {
    content.innerHTML = '<div class="gate"><div class="gate-box">' +
      '<h2>Connect to Verity One</h2>' +
      '<p>Enter your token to access the local dashboard.</p>' +
      '<input class="gate-input" id="token-input" type="password" placeholder="tenant-*-token or operator token" autocomplete="off">' +
      '<input class="gate-input" id="tenant-input" type="text" placeholder="tenant_id (required for operator tokens)" autocomplete="off">' +
      '<button class="gate-btn" id="token-btn">Connect</button>' +
      (error ? '<div class="gate-error">' + esc(error) + '</div>' : '') +
      '</div></div>';
    document.getElementById('token-btn').onclick = function() {
      var val = document.getElementById('token-input').value.trim();
      var tid = document.getElementById('tenant-input').value.trim();
      if (!val) return;
      // A fresh connect is a new identity posture — drop any cached
      // harvest result before the next render so prior tenant/root
      // guidance cannot leak into this session.
      clearLastHarvestResult();
      setToken(val);
      setTenantId(tid);
      render();
    };
    document.getElementById('token-input').onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('token-btn').click();
    };
    document.getElementById('tenant-input').onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('token-btn').click();
    };
  }

  function renderLoading() {
    content.innerHTML = '<div class="state-msg">Loading dashboard...</div>';
  }

  // ── Fetch overview ────────────────────────────────────────────────
  function fetchOverview() {
    fetch(dashUrl('/dashboard/overview'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) {
          clearToken();
          renderGate('Token rejected. Check your token' + (getTenantId() ? '' : ' or add a tenant_id for operator tokens') + '.');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        currentData = data;
        if (data._auth) authMeta = data._auth;
        renderHome(data);
        if (activeTab === 'home') startPoll();
      })
      .catch(function(err) {
        content.innerHTML = '<div class="state-msg">Failed to load: ' + esc(err.message) + '</div>';
      });
  }

  function startPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function() {
      fetch(dashUrl('/dashboard/overview'), { headers: authHeaders() })
        .then(function(res) {
          if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
          if (!res.ok) return null;
          return res.json();
        })
        .then(function(data) {
          if (data) { currentData = data; renderHome(data); }
        })
        .catch(function() { /* silent poll failure */ });
    }, POLL_MS);
  }

  // ── Home tab ──────────────────────────────────────────────────────
  function renderHome(d) {
    var html = '';

    // Compact-rhythm header — local density-first view, no lead paragraph.
    // Local-authoritative authority badge: this dashboard speaks for the
    // local node, which is the source of truth.
    html += '<div class="rhythm-compact">';
    html += '<div class="page-kicker">Overview</div>';
    html += '<div class="page-title-row">';
    html += '<h1>Home <span class="auth-badge" data-state="local-authoritative">' +
      '<span class="auth-icon" aria-hidden="true">&#9679;</span>' +
      '<span class="auth-label">Local authoritative</span></span></h1>';
    html += '</div></div>';

    // Needs attention
    html += '<div class="card card-dither"><div class="card-title">Needs Attention</div>';
    if (d.needs_attention && d.needs_attention.length > 0) {
      for (var i = 0; i < d.needs_attention.length; i++) {
        var a = d.needs_attention[i];
        var target = homeTargetForAttention(a);
        var icon = a.severity === 'red' ? '&#9632;' : '&#9650;';
        html += attentionAction(a.severity, icon, a.message, target);
      }
    } else {
      html += '<div class="empty">All clear. Nothing needs attention.</div>';
    }
    html += '</div>';

    var hygiene = [];
    if (d.structure && d.structure.projects_missing_description_count > 0) {
      hygiene.push({
        message: d.structure.projects_missing_description_count + ' project(s) missing descriptions',
        tab: 'structure',
        filter: 'missing-descriptions',
        label: 'Open Structure',
      });
    }
    if (d.health && d.health.invalid_settings_count > 0) {
      hygiene.push({
        message: d.health.invalid_settings_count + ' invalid local setting(s)',
        tab: 'settings',
        filter: '',
        label: 'Open Settings',
      });
    }
    if (hygiene.length > 0) {
      html += '<div class="card"><div class="card-title">Data Hygiene</div>';
      for (var h = 0; h < hygiene.length; h++) {
        html += attentionAction('amber', '&#9650;', hygiene[h].message, hygiene[h]);
      }
      html += '<div class="empty" style="text-align:left;margin-top:.4rem">Structural and configuration cleanup only. Routine freshness stays in Needs Attention.</div>';
      html += '</div>';
    }

    // Setup + Stats side by side
    html += '<div class="section-cols">';

    // Setup checklist
    html += '<div class="card"><div class="card-title">Setup (' + d.setup.complete_count + '/' + d.setup.total_count + ')</div><ul class="checklist">';
    var checks = [
      { label: 'Google account linked', done: d.setup.google_linked === true, tab: 'account', cta: 'Open Account' },
      { label: 'Provider configured', done: d.setup.provider_configured, tab: 'providers', cta: 'Open Providers' },
      { label: 'Active project', done: d.setup.has_active_project, tab: 'structure', cta: 'Open Structure' },
      { label: 'Routine defined', done: d.setup.has_any_routine, tab: 'routines', cta: 'Open Routines' },
      { label: 'Hosted sync enabled', done: d.setup.hosted_sync_enabled, tab: 'account', cta: 'Open Account' },
    ];
    for (var j = 0; j < checks.length; j++) {
      var ck = checks[j];
      html += '<li><button type="button" class="check-action" data-dash-tab="' + esc(ck.tab) + '">' +
        '<span class="check-icon ' + (ck.done ? 'check-done' : 'check-pending') + '">' +
        (ck.done ? '&#10003;' : '&#9675;') + '</span><span class="check-label">' + esc(ck.label) +
        '</span><span class="check-cta">' + esc(ck.cta) + '</span></button></li>';
    }
    html += '</ul></div>';

    // Quick stats
    html += '<div class="card"><div class="card-title">Quick Stats</div><div class="stats">';
    html += stat(fmtUptime(d.health.uptime_s), 'Uptime');
    html += statAction(fmtCount(d.health.node_count), 'Nodes', 'activity', '');
    html += statAction(fmtCount(d.review.pending_count), 'Pending Review', 'review', 'pending');
    html += statAction(fmtCount(d.structure.active_memory_count), 'Active Memories', 'structure', '');
    html += statAction(fmtCount(d.providers.configured_count), 'Providers', 'providers', '');
    html += statAction(fmtRoutineRatio(d.routines.enabled_count, d.routines.total_count), 'Routines', 'routines', '');
    html += '</div></div>';
    html += '</div>'; // end section-cols

    if (d.supercron_operator_status) {
      html += renderSupercronOperatorCard(d.supercron_operator_status);
    }

    // Activity preview + Structure/Provider/Routine summaries
    html += '<div class="section-cols">';

    // Activity
    html += '<div class="card"><div class="card-title">Recent Activity</div>';
    if (d.activity.recent_items && d.activity.recent_items.length > 0) {
      for (var k = 0; k < d.activity.recent_items.length; k++) {
        var ev = d.activity.recent_items[k];
        html += '<div class="event-row">' +
          '<span class="event-type">' + esc(ev.event_type) + '</span>' +
          '<div class="event-meta"><span class="event-addr">' + esc(ev.addr) + '</span> ' +
          '<span class="event-label">' + esc(ev.label || '') + '</span></div>' +
          '<span class="event-time">' + fmtTime(ev.created_at) + '</span></div>';
      }
    } else {
      html += '<div class="empty">No recent activity.</div>';
    }
    html += '</div>';

    // Right column: structure + providers + routines
    html += '<div>';

    // Structure
    html += homeSummaryCard(
      'Structure',
      summaryRow('Projects', d.structure.project_count) +
        summaryRow('Missing descriptions', d.structure.projects_missing_description_count),
      'structure',
      d.structure.projects_missing_description_count > 0 ? 'missing-descriptions' : ''
    );

    // Providers
    var providersBody = '';
    if (d.providers.configured_providers.length > 0) {
      providersBody += summaryRow('Configured', d.providers.configured_providers.join(', '));
    } else {
      providersBody += '<div class="empty">No providers configured.</div>';
    }
    html += homeSummaryCard('Providers', providersBody, 'providers', '');

    // Routines
    var routinesBody = '';
    routinesBody += summaryRow('Enabled', fmtRoutineRatio(d.routines.enabled_count, d.routines.total_count));
    var dayJournalSchedulerStatus = d.routines.day_journal_scheduler_status || null;
    var dayJournalSchedulerNeedsAttention = Number(d.routines.day_journal_enabled_count || 0) > 0
      && dayJournalSchedulerStatus
      && dayJournalSchedulerStatus !== 'active'
      && dayJournalSchedulerStatus !== 'disabled';
    if (d.routines.failing_count > 0) {
      routinesBody += summaryRowHtml('Failing', '<span style="color:var(--red)">' + esc(fmtCount(d.routines.failing_count)) + '</span>');
    }
    if (Number(d.routines.day_journal_recent_failure_count || 0) > 0) {
      routinesBody += summaryRowHtml('Day-journal failures (24h)', '<span style="color:var(--amber)">' + esc(fmtCount(d.routines.day_journal_recent_failure_count)) + '</span>');
    }
    if (dayJournalSchedulerNeedsAttention) {
      routinesBody += summaryRow('Day-journal scheduler', dayJournalSchedulerStatus);
    }
    if (d.routines.schedule_last_run_at || d.routines.day_journal_last_run_at) {
      if (d.routines.schedule_last_run_at) {
        routinesBody += summaryRow('VI last run', fmtTime(d.routines.schedule_last_run_at));
      }
      if (d.routines.day_journal_last_run_at) {
        routinesBody += summaryRow('Day-journal last run', fmtTime(d.routines.day_journal_last_run_at));
      }
    } else if (d.routines.last_run_at) {
      routinesBody += summaryRow('Last run', fmtTime(d.routines.last_run_at));
    }
    var dayJournalFailingForHome = Number(d.routines.day_journal_failing_count || 0);
    var dayJournalRecentFailureForHome = Number(d.routines.day_journal_recent_failure_count || 0);
    var scheduleFailingForHome = Number(d.routines.schedule_failing_count || 0);
    var routinesHomeFilter = (dayJournalSchedulerNeedsAttention || dayJournalFailingForHome > 0 || dayJournalRecentFailureForHome > 0) ? 'day-journal' : scheduleFailingForHome > 0 ? 'failing' : d.routines.stale_count > 0 ? 'stale' : '';
    html += homeSummaryCard('Routines', routinesBody, 'routines', routinesHomeFilter);

    html += '</div>'; // end right col
    html += '</div>'; // end section-cols

    content.innerHTML = html;
    wireDashboardActions();
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function stat(val, label) {
    return '<div class="stat"><div class="stat-value">' + esc(String(val)) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
  }
  function statAction(val, label, tab, filter) {
    return '<button type="button" class="stat stat-action" data-dash-tab="' + esc(tab) + '" data-dash-filter="' + esc(filter || '') + '">' +
      '<div class="stat-value">' + esc(String(val)) + '</div><div class="stat-label">' + esc(label) + '</div></button>';
  }
  function summaryRow(label, val) {
    return '<div class="summary-row"><span class="summary-label">' + esc(label) + '</span><span class="summary-value">' + esc(String(val)) + '</span></div>';
  }
  function summaryRowHtml(label, rawHtml) {
    return '<div class="summary-row"><span class="summary-label">' + esc(label) + '</span><span class="summary-value">' + rawHtml + '</span></div>';
  }
  function homeSummaryCard(title, bodyHtml, tab, filter) {
    return '<button type="button" class="card home-summary-card" data-dash-tab="' + esc(tab) +
      '" data-dash-filter="' + esc(filter || '') + '">' +
      '<div class="card-title home-summary-title"><span>' + esc(title) +
      '</span><span class="attention-arrow" aria-hidden="true">&#8250;</span></div>' +
      bodyHtml + '</button>';
  }
  function renderSupercronOperatorCard(status) {
    var quality = status.quality || {};
    var dist = status.edge_usefulness_distribution || {};
    var safe = status.safe_to_run_mutating_tier || {};
    var tier3 = status.tier3_controller || {};
    var queue = status.proposal_queue_depth || [];
    var pendingHighRisk = queue.filter(function(row) { return row.high_risk && row.status === 'pending'; });
    var highRisk = pendingHighRisk
      .slice(0, 4)
      .map(function(row) { return String(row.action || 'unknown') + ': ' + String(row.count || 0); })
      .join(', ');
    if (pendingHighRisk.length > 4) highRisk += ', +' + String(pendingHighRisk.length - 4) + ' more';
    var runtime = (status.runtime_trend || [])[0] || {};
    var costMicro = runtime.llm_cost_usd_micro == null ? null : Number(runtime.llm_cost_usd_micro);
    var costText = costMicro != null && isFinite(costMicro) ? '$' + (costMicro / 1000000).toFixed(4) : '—';
    var allHints = status.diagnostic_hints || [];
    var hints = allHints.slice(0, 3);
    var bucketText = dist.thresholds_inverted
      ? 'n/a (thresholds inverted)'
      : 'low ' + fmtNullableCount(dist.low) + ' / mid ' + fmtNullableCount(dist.mid) + ' / high ' + fmtNullableCount(dist.high);
    var thresholdText = 'flag ' + fmtThreshold(dist.flag_ceiling, dist.flag_ceiling_configured) +
      ' / protect ' + fmtThreshold(dist.protection_floor, dist.protection_floor_configured);
    var html = '<div class="card" data-supercron-operator-status="1">';
    html += '<div class="card-title">SuperCron Operator Status</div>';
    html += '<div class="stats" style="margin-bottom:.75rem">';
    html += stat(quality.grade || 'unknown', 'Quality grade');
    html += stat(quality.last_golden_pass_rate == null ? '—' : Number(quality.last_golden_pass_rate).toFixed(2), 'Golden pass rate');
    html += stat(fmtCount(status.rollback_count_24h || 0), 'Rollbacks 24h');
    html += stat(safe.level || 'unknown', 'Mutating tier');
    html += '</div>';
    html += summaryRow('Last status', quality.last_status || '—');
    html += summaryRow('Degraded reason', quality.last_degraded_reason || '—');
    html += summaryRow('Last finished', quality.last_finished_at || '—');
    html += summaryRow('Runtime last cycle', formatDurationMs(runtime.total_ms));
    html += summaryRow('LLM cost last cycle', costText);
    html += summaryRow('Edge thresholds', thresholdText);
    html += summaryRow('Edge score buckets', bucketText);
    html += summaryRow('Tier 3 skips last 12', fmtCount(tier3.skips_last_12_cycles || 0));
    html += summaryRow('Data sources', installedSummary(status.installed || {}));
    html += summaryRow('Pending high-risk proposals', highRisk || '—');
    if (hints.length > 0) {
      html += '<div style="margin-top:.75rem">';
      for (var i = 0; i < hints.length; i++) {
        html += '<div class="alert amber"><span class="alert-icon">&#9650;</span>' + esc(hints[i]) + '</div>';
      }
      if (allHints.length > hints.length) {
        html += '<div class="alert amber"><span class="alert-icon">&#9650;</span>+' + esc(String(allHints.length - hints.length)) + ' more diagnostic hint(s)</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }
  function fmtNullableCount(value) {
    return value == null ? 'n/a' : fmtCount(value || 0);
  }
  function fmtThreshold(effective, configured) {
    var text = effective == null ? 'n/a' : Number(effective).toFixed(2);
    if (configured !== null && configured !== undefined) {
      var configuredText = String(configured).trim() === '' ? 'empty' : String(configured);
      if (configuredText === 'empty' || Number(configured) !== Number(effective)) {
        text += ' (configured ' + configuredText + ')';
      }
    }
    return text;
  }
  function formatDurationMs(value) {
    var ms = Number(value || 0);
    if (!isFinite(ms) || ms <= 0) return '—';
    if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
    if (ms >= 1000) return (ms / 1000).toFixed(1) + ' s';
    return fmtCount(ms) + ' ms';
  }
  function installedSummary(installed) {
    var keys = ['supercron_runs', 'supercron_pass_telemetry', 'edge_usefulness_scores', 'golden_query_runs', 'recall_outcome_events', 'proposals', 'memory_events'];
    var missing = keys.filter(function(key) { return installed[key] !== true; });
    if (missing.length === 0) return 'all installed';
    return 'missing ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? ', +' + String(missing.length - 3) + ' more' : '');
  }
  function attentionAction(severity, icon, message, target) {
    return '<button type="button" class="attention-action ' + esc(severity || 'amber') + '" data-dash-tab="' + esc(target.tab) +
      '" data-dash-filter="' + esc(target.filter || '') + '">' +
      '<span class="alert-icon">' + icon + '</span>' +
      '<span class="attention-message">' + esc(message) + '</span>' +
      '<span class="attention-target">' + esc(target.label) + '</span>' +
      '<span class="attention-arrow" aria-hidden="true">&#8250;</span></button>';
  }
  function homeTargetForAttention(alert) {
    if (alert && alert.tab) {
      return {
        tab: String(alert.tab),
        filter: alert.filter ? String(alert.filter) : '',
        label: alert.label ? String(alert.label) : 'Open ' + String(alert.tab),
      };
    }
    return homeTargetForMessage(alert && alert.message);
  }
  function homeTargetForMessage(message) {
    var text = String(message || '').toLowerCase();
    if (text.indexOf('pending review') >= 0 || text.indexOf('review') >= 0) {
      return { tab: 'review', filter: 'pending', label: 'Open Review' };
    }
    if (text.indexOf('routine') >= 0 && (text.indexOf('fail') >= 0 || text.indexOf('error') >= 0)) {
      return { tab: 'routines', filter: 'failing', label: 'Show Failing' };
    }
    if (text.indexOf('routine') >= 0 && text.indexOf('stale') >= 0) {
      return { tab: 'routines', filter: 'stale', label: 'Show Stale' };
    }
    if (text.indexOf('routine') >= 0) return { tab: 'routines', filter: '', label: 'Open Routines' };
    if (text.indexOf('provider') >= 0) return { tab: 'providers', filter: '', label: 'Open Providers' };
    if (text.indexOf('project') >= 0 || text.indexOf('description') >= 0) {
      return { tab: 'structure', filter: 'missing-descriptions', label: 'Open Structure' };
    }
    if (text.indexOf('setting') >= 0 || text.indexOf('config') >= 0) return { tab: 'settings', filter: '', label: 'Open Settings' };
    if (text.indexOf('sync') >= 0 || text.indexOf('google') >= 0 || text.indexOf('account') >= 0) {
      return { tab: 'account', filter: '', label: 'Open Account' };
    }
    return { tab: 'activity', filter: '', label: 'Open Activity' };
  }
  function fmtCount(n) {
    var num = Number(n || 0);
    return isFinite(num) ? num.toLocaleString() : '0';
  }
  function fmtRoutineRatio(enabled, total) {
    return fmtCount(enabled) + ' / ' + fmtCount(total);
  }
  function fmtUptime(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm';
    if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
  }
  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var now = Date.now();
      var diff = Math.floor((now - d.getTime()) / 1000);
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff/60) + 'm ago';
      if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
      return Math.floor(diff/86400) + 'd ago';
    } catch(e) { return iso; }
  }

  // Rung 3: format a precomputed age (in seconds) the same
  // way fmtTime formats ISO strings. Used by the sync-health
  // card which receives sync_health_age_seconds from the
  // projection (server-side clock; avoids client-drift).
  function fmtDurationAgo(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds/60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds/3600) + 'h ago';
    return Math.floor(seconds/86400) + 'd ago';
  }

  // ── Structure tab ──────────────────────────────────────────────────

  function fetchStructure() {
    fetch(dashUrl('/dashboard/structure'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data._auth) authMeta = data._auth;
        renderStructure(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load structure: ' + esc(err.message) + '</div>'; });
  }

  function renderStructure(d) {
    var canWrite = d._auth && d._auth.can_write;
    var intent = takeDashboardIntent('structure');
    var html = '<h2 style="font-size:1.1rem;margin-bottom:1rem;">Structure</h2>';

    if (intent && intent.filter === 'missing-descriptions') {
      html += '<div class="focus-banner">Focused from Home: inspect rows marked <strong>no description</strong>, then add missing project or pyramid descriptions where appropriate.</div>';
    }

    // Hygiene warnings
    if (d.hygiene) {
      var warns = [];
      if (d.hygiene.pyramids_missing_description_count > 0) warns.push(d.hygiene.pyramids_missing_description_count + ' pyramid(s) missing description');
      if (d.hygiene.projects_missing_description_count > 0) warns.push(d.hygiene.projects_missing_description_count + ' project(s) missing description');
      if (d.hygiene.empty_pyramids_count > 0) warns.push(d.hygiene.empty_pyramids_count + ' empty pyramid(s)');
      if (warns.length > 0) {
        html += '<div class="card" style="margin-bottom:1rem">';
        for (var w = 0; w < warns.length; w++) html += '<div class="alert amber"><span class="alert-icon">&#9650;</span>' + esc(warns[w]) + '</div>';
        html += '</div>';
      }
    }

    // Create pyramid form
    if (canWrite) {
      html += '<div class="card" style="margin-bottom:1rem"><div class="card-title">Add Pyramid</div>';
      html += '<div class="inline-form"><input class="input-sm" id="new-pyr-label" placeholder="Pyramid name"><input class="input-sm" id="new-pyr-desc" placeholder="Description (optional)"><button class="btn-sm btn-primary" id="btn-create-pyr">Create</button></div>';
      html += '<div id="pyr-create-status" class="status-msg"></div></div>';
    }

    // Pyramids + projects
    var pyramids = d.pyramids || [];
    var activeProjects = (d.projects && d.projects.active) || [];
    var archivedProjects = (d.projects && d.projects.archived) || [];

    for (var i = 0; i < pyramids.length; i++) {
      var pyr = pyramids[i];
      var pyrProjects = activeProjects.filter(function(p) { return p.tenant_pyramid_id === pyr.pyramid_id; });
      var pyrArchived = archivedProjects.filter(function(p) { return p.tenant_pyramid_id === pyr.pyramid_id; });

      html += '<div class="card card-dither" style="margin-bottom:0.75rem">';
      html += '<div class="collapse-header" data-collapse="pyr-' + i + '">';
      html += '<div><strong>' + esc(pyr.label) + '</strong>';
      if (pyr.kind === 'system') html += ' <span class="tab-badge">' + esc(pyr.system_key) + '</span>';
      html += ' <span class="structure-meta">' + esc(String(pyrProjects.length)) + ' project' + (pyrProjects.length !== 1 ? 's' : '') + '</span>';
      if (!pyr.description) html += '<span class="warn-badge">no description</span>';
      html += '</div><span class="collapse-toggle">&#9660;</span></div>';

      html += '<div class="collapse-body" id="pyr-' + i + '">';
      if (pyr.description) html += '<div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.5rem;padding-left:0.3rem">' + esc(pyr.description) + '</div>';

      // Pyramid actions
      if (canWrite) {
        html += '<div class="inline-form" style="margin-bottom:0.5rem">';
        html += '<input class="input-sm" id="pyr-desc-' + i + '" placeholder="Set description" value="' + esc(pyr.description || '') + '">';
        html += '<button class="btn-sm btn-ghost" data-pyr-describe="' + esc(pyr.pyramid_id) + '" data-pyr-index="' + i + '">Save</button>';
        if (pyr.kind !== 'system') html += '<button class="btn-sm btn-danger" data-pyr-delete="' + esc(pyr.pyramid_id) + '">Delete</button>';
        html += '</div>';
      }

      // Projects under this pyramid
      for (var j = 0; j < pyrProjects.length; j++) {
        var proj = pyrProjects[j];
        html += '<div class="structure-row">';
        html += '<div class="structure-label"><span class="event-addr">' + esc(proj.addr) + '</span> ' + esc(proj.label);
        if (!proj.description) html += '<span class="warn-badge">no desc</span>';
        html += '<div class="structure-desc">' + esc(proj.description || '') + '</div></div>';
        html += '<span class="structure-meta">' + esc(String(proj.memory_count || 0)) + ' mem</span>';
        if (canWrite) {
          html += '<div class="structure-actions">';
          html += '<button class="btn-sm btn-ghost" data-proj-describe="' + esc(proj.addr) + '">Desc</button>';
          html += '<button class="btn-sm btn-ghost" data-proj-archive="' + esc(proj.addr) + '">Archive</button>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Archived projects
      if (pyrArchived.length > 0) {
        html += '<div style="font-size:0.75rem;color:var(--text-muted);padding:0.3rem 0.6rem;margin-top:0.3rem">' + esc(String(pyrArchived.length)) + ' archived</div>';
      }

      // Add project form
      if (canWrite) {
        html += '<div class="inline-form" style="margin-top:0.3rem">';
        html += '<input class="input-sm" id="new-proj-' + i + '" placeholder="New project name">';
        html += '<button class="btn-sm btn-primary" data-proj-create="' + esc(pyr.pyramid_id) + '" data-pyr-index="' + i + '">Add</button>';
        html += '</div>';
      }

      html += '</div></div>'; // collapse-body + card
    }

    // Unassigned projects
    var unassigned = activeProjects.filter(function(p) { return !p.tenant_pyramid_id; });
    if (unassigned.length > 0) {
      html += '<div class="card"><div class="card-title">Unassigned Projects (' + unassigned.length + ')</div>';
      for (var u = 0; u < unassigned.length; u++) {
        html += '<div class="structure-row"><span class="event-addr">' + esc(unassigned[u].addr) + '</span> ' + esc(unassigned[u].label) + '</div>';
      }
      html += '</div>';
    }

    content.innerHTML = html;
    wireCollapseHandlers();
    wireStructureActions(d);
  }

  function wireCollapseHandlers() {
    var headers = document.querySelectorAll('.collapse-header');
    for (var i = 0; i < headers.length; i++) {
      headers[i].addEventListener('click', function() {
        var id = this.getAttribute('data-collapse');
        var body = document.getElementById(id);
        if (body) body.classList.toggle('collapsed');
      });
    }
  }

  function wireStructureActions(d) {
    var tid = (d._auth && d._auth.scope === 'operator') ? getTenantId() : null;
    function postBody(extra) { var b = extra || {}; if (tid) b.tenant_id = tid; return b; }

    function doPyrDescribe(pyrId, idx) {
      var el = document.getElementById('pyr-desc-' + idx);
      if (!el) return;
      mutate('/tenant-pyramids/' + encodeURIComponent(pyrId) + '/describe', postBody({ description: el.value }), function() { fetchStructure(); });
    }
    function doPyrDelete(pyrId) {
      if (!confirm('Delete this pyramid?')) return;
      mutate('/tenant-pyramids/' + encodeURIComponent(pyrId) + '/delete', postBody({}), function() { fetchStructure(); });
    }
    function doProjDescribe(addr) {
      var desc = prompt('Enter project description:');
      if (desc === null) return;
      mutate('/projects/' + encodeURIComponent(addr) + '/describe', postBody({ description: desc }), function() { fetchStructure(); });
    }
    function doProjArchive(addr) {
      if (!confirm('Archive this project?')) return;
      mutate('/projects/' + encodeURIComponent(addr) + '/archive', postBody({}), function() { fetchStructure(); });
    }
    function doProjCreate(pyrId, idx) {
      var el = document.getElementById('new-proj-' + idx);
      if (!el || !el.value.trim()) return;
      mutate('/projects', postBody({ label: el.value.trim(), tenant_pyramid_id: pyrId }), function() { fetchStructure(); });
    }

    var pyrDescribeBtns = document.querySelectorAll('[data-pyr-describe]');
    for (var pd = 0; pd < pyrDescribeBtns.length; pd++) {
      pyrDescribeBtns[pd].addEventListener('click', function() {
        doPyrDescribe(this.getAttribute('data-pyr-describe'), this.getAttribute('data-pyr-index'));
      });
    }
    var pyrDeleteBtns = document.querySelectorAll('[data-pyr-delete]');
    for (var px = 0; px < pyrDeleteBtns.length; px++) {
      pyrDeleteBtns[px].addEventListener('click', function() {
        doPyrDelete(this.getAttribute('data-pyr-delete'));
      });
    }
    var projDescribeBtns = document.querySelectorAll('[data-proj-describe]');
    for (var prd = 0; prd < projDescribeBtns.length; prd++) {
      projDescribeBtns[prd].addEventListener('click', function() {
        doProjDescribe(this.getAttribute('data-proj-describe'));
      });
    }
    var projArchiveBtns = document.querySelectorAll('[data-proj-archive]');
    for (var pra = 0; pra < projArchiveBtns.length; pra++) {
      projArchiveBtns[pra].addEventListener('click', function() {
        doProjArchive(this.getAttribute('data-proj-archive'));
      });
    }
    var projCreateBtns = document.querySelectorAll('[data-proj-create]');
    for (var pc = 0; pc < projCreateBtns.length; pc++) {
      projCreateBtns[pc].addEventListener('click', function() {
        doProjCreate(this.getAttribute('data-proj-create'), this.getAttribute('data-pyr-index'));
      });
    }

    var createBtn = document.getElementById('btn-create-pyr');
    if (createBtn) {
      createBtn.onclick = function() {
        var label = document.getElementById('new-pyr-label');
        var desc = document.getElementById('new-pyr-desc');
        if (!label || !label.value.trim()) return;
        var body = postBody({ label: label.value.trim() });
        mutate('/tenant-pyramids', body, function(result) {
          // If description was provided and create succeeded, persist it
          if (desc && desc.value.trim() && result && result.pyramid_id) {
            mutate('/tenant-pyramids/' + encodeURIComponent(result.pyramid_id) + '/describe',
              postBody({ description: desc.value.trim() }),
              function() { fetchStructure(); });
          } else {
            fetchStructure();
          }
        });
      };
    }
  }

  function mutate(path, body, onSuccess) {
    fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return; }
      return res.json();
    }).then(function(data) {
      if (data && data.ok && onSuccess) onSuccess(data);
      else if (data && !data.ok) alert(data.error || 'Operation failed');
    }).catch(function(err) { alert('Error: ' + err.message); });
  }

  // ── Review tab ────────────────────────────────────────────────────

  var selectedReviewAddr = null;

  function fetchReview() {
    fetch(dashUrl('/dashboard/review'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data._auth) authMeta = data._auth;
        renderReview(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load review: ' + esc(err.message) + '</div>'; });
  }

  function renderReview(d) {
    var canApprove = d._auth && d._auth.can_approve;
    var items = d.items || [];
    var html = '<h2 style="font-size:1.1rem;margin-bottom:1rem;">Review Queue</h2>';

    if (items.length === 0) {
      html += '<div class="card"><div class="empty">No memories pending review. All clear.</div></div>';
      content.innerHTML = html;
      return;
    }

    html += '<div class="review-layout">';

    // Left: list
    html += '<div class="card" style="max-height:70vh;overflow-y:auto">';
    html += '<div class="card-title">' + esc(String(items.length)) + ' Pending</div>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var sel = it.addr === selectedReviewAddr ? ' selected' : '';
      html += '<div class="review-list-item' + sel + '" data-review-addr="' + esc(it.addr) + '">';
      html += '<div><span class="review-kind">' + esc(it.kind) + '</span>';
      if (it.overlay_origin) html += '<span class="review-overlay">[overlay]</span>';
      html += '<span class="review-quality">' + esc(it.review_category || 'likely_durable') + '</span>';
      html += '</div>';
      html += '<div style="margin-top:0.15rem">' + esc(it.label) + '</div>';
      html += '<div style="font-size:0.72rem;color:var(--text-muted);font-family:var(--font-mono)">' + esc(it.addr) + '</div>';
      if (it.review_quality_reasons && it.review_quality_reasons.length > 0) {
        html += '<div class="review-quality-reason">' + esc(it.review_quality_reasons.slice(0, 2).join(', ')) + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Right: audit detail
    html += '<div id="review-detail">';
    if (selectedReviewAddr) {
      html += '<div class="state-msg">Loading audit...</div>';
    } else {
      html += '<div class="card"><div class="empty">Select a memory to inspect.</div></div>';
    }
    html += '</div>';

    html += '</div>'; // review-layout

    content.innerHTML = html;

    // Wire list clicks
    var listItems = document.querySelectorAll('.review-list-item');
    for (var k = 0; k < listItems.length; k++) {
      listItems[k].addEventListener('click', function() {
        var addr = this.getAttribute('data-review-addr');
        selectedReviewAddr = addr;
        // Update selection visually
        var all = document.querySelectorAll('.review-list-item');
        for (var m = 0; m < all.length; m++) all[m].classList.toggle('selected', all[m].getAttribute('data-review-addr') === addr);
        fetchAudit(addr, canApprove);
      });
    }

    // Auto-load first or previously selected
    if (selectedReviewAddr) fetchAudit(selectedReviewAddr, canApprove);
  }

  function fetchAudit(addr, canApprove) {
    var detail = document.getElementById('review-detail');
    if (!detail) return;
    detail.innerHTML = '<div class="state-msg">Loading audit...</div>';

    fetch(dashUrl('/dashboard/review/' + encodeURIComponent(addr) + '/audit'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(snap) {
        if (!snap) return;
        if (!snap.ok) { detail.innerHTML = '<div class="state-msg">Memory not found.</div>'; return; }
        renderAudit(detail, snap, canApprove);
      })
      .catch(function(err) { detail.innerHTML = '<div class="state-msg">Audit failed: ' + esc(err.message) + '</div>'; });
  }

  function renderAudit(container, s, canApprove) {
    var html = '<div class="card">';
    html += '<div class="card-title">Audit: ' + esc(s.addr) + '</div>';

    html += auditField('Label', s.label);
    html += auditField('Kind', s.kind);
    html += auditField('Source', s.source);
    html += auditField('Trust State', s.trust_state);
    html += auditField('Status', s.status);
    html += auditField('Accepted by User', s.accepted_by_user ? 'Yes' : 'No');
    html += auditField('Overlay Origin', s.overlay_origin ? 'Yes' : 'No');

    if (s.promoted_from) {
      var pf = s.promoted_from;
      html += auditField('Promoted From', (pf.overlay_addr || '') + ' (' + (pf.overlay_id || '') + ')');
    }

    if (s.approval) {
      html += auditField('Approved By', s.approval.approved_by || '');
      html += auditField('Approved At', s.approval.approved_at || '');
    }

    // Recent events
    if (s.recent_events && s.recent_events.length > 0) {
      html += '<div style="margin-top:0.5rem"><div class="card-title">Recent Events</div>';
      for (var i = 0; i < s.recent_events.length; i++) {
        var ev = s.recent_events[i];
        html += '<div class="event-row"><span class="event-type">' + esc(ev.event_type) + '</span>';
        html += '<span class="event-time">' + fmtTime(ev.created_at) + '</span></div>';
      }
      html += '</div>';
    }

    // Actions
    if (canApprove) {
      html += '<div class="action-bar">';
      html += '<button class="btn-sm btn-primary" id="btn-approve">Approve</button>';
      html += '<input class="input-sm" id="retract-reason" placeholder="Retract reason" style="max-width:200px">';
      html += '<button class="btn-sm btn-danger" id="btn-retract">Retract</button>';
      html += '</div>';
      html += '<div id="action-status" class="status-msg"></div>';
    }

    html += '</div>';
    container.innerHTML = html;

    // Wire action buttons
    if (canApprove) {
      var tid = getTenantId();
      document.getElementById('btn-approve').onclick = function() {
        var body = { tenant_id: tid };
        reviewAction(s.addr, 'approve', body);
      };
      document.getElementById('btn-retract').onclick = function() {
        var reason = document.getElementById('retract-reason').value.trim();
        var body = { tenant_id: tid };
        if (reason) body.reason = reason;
        reviewAction(s.addr, 'retract', body);
      };
    }
  }

  function reviewAction(addr, action, body) {
    var statusEl = document.getElementById('action-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted)">Processing...</span>';

    fetch('/dashboard/review/' + encodeURIComponent(addr) + '/' + action, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data.ok) {
          if (statusEl) statusEl.innerHTML = '<span class="status-ok">&#10003; ' + esc(action === 'approve' ? 'Approved' : 'Retracted') + '</span>';
          selectedReviewAddr = null;
          setTimeout(function() { fetchReview(); }, 800);
        } else {
          if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
        }
      })
      .catch(function(err) {
        if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
      });
  }

  function auditField(label, val) {
    return '<div class="audit-field"><div class="audit-label">' + esc(label) + '</div><div class="audit-value">' + esc(String(val || '—')) + '</div></div>';
  }

  // ── Activity tab ───────────────────────────────────────────────────

  var activityProjectFilter = null;

  function fetchActivity(projectAddr) {
    if (projectAddr !== undefined) activityProjectFilter = projectAddr;
    var url = dashUrl('/dashboard/activity?limit=50');
    if (activityProjectFilter) url += '&project_addr=' + encodeURIComponent(activityProjectFilter);
    fetch(url, { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        renderActivity(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load activity: ' + esc(err.message) + '</div>'; });
  }

  function renderActivity(d) {
    // Compact-rhythm header for density view — no lead paragraph by design.
    var html = '<div class="rhythm-compact">' +
      '<div class="page-kicker">Operator log</div>' +
      '<div class="page-title-row"><h1>Activity ' +
      '<span class="auth-badge" data-state="local-authoritative">' +
        '<span class="auth-icon" aria-hidden="true">&#9679;</span>' +
        '<span class="auth-label">Local authoritative</span></span>' +
      '</h1></div></div>';

    // Project filter
    html += '<div class="card" style="margin-bottom:1rem"><div class="card-title">Filter</div>';
    html += '<select class="input-sm" id="activity-project-filter" style="max-width:300px">';
    html += '<option value="">All projects</option>';
    var projects = d.projects || [];
    for (var p = 0; p < projects.length; p++) {
      var sel = d.filters && d.filters.project_addr === projects[p].addr ? ' selected' : '';
      html += '<option value="' + esc(projects[p].addr) + '"' + sel + '>' + esc(projects[p].label) + '</option>';
    }
    html += '</select></div>';

    // Event list
    html += '<div class="card">';
    html += '<div class="card-title">' + esc(String(d.count || 0)) + ' Events</div>';
    var items = d.items || [];
    if (items.length === 0) {
      html += '<div class="empty">No activity yet.</div>';
    } else {
      for (var i = 0; i < items.length; i++) {
        var ev = items[i];
        html += '<div class="event-row">';
        html += '<span class="event-type">' + esc(ev.event_type) + '</span>';
        html += '<div class="event-meta">';
        html += '<span class="event-addr">' + esc(ev.addr) + '</span> ';
        html += '<span class="event-label">' + esc(ev.label || '') + '</span>';
        if (ev.actor) html += '<div style="font-size:0.72rem;color:var(--text-muted)">by ' + esc(ev.actor) + '</div>';
        html += '</div>';
        html += '<span class="event-time">' + fmtTime(ev.created_at) + '</span>';
        html += '</div>';
      }
    }
    html += '</div>';

    content.innerHTML = html;

    // Wire filter
    var filterEl = document.getElementById('activity-project-filter');
    if (filterEl) {
      filterEl.onchange = function() { fetchActivity(this.value || null); };
    }
  }

  // ── Federation Sessions tab ─────────────────────────────────────────

  function fetchSessions() {
    fetch(dashUrl('/dashboard/sessions'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        renderSessions(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load sessions: ' + esc(err.message) + '</div>'; });
  }

  function renderSessions(d) {
    var html = '<div class="rhythm-compact">' +
      '<div class="page-kicker">Federation actors</div>' +
      '<div class="page-title-row"><h1>Sessions ' +
      '<span class="auth-badge" data-state="local-authoritative">' +
        '<span class="auth-icon" aria-hidden="true">&#9679;</span>' +
        '<span class="auth-label">Local authoritative</span></span>' +
      '</h1></div></div>';

    var summary = d.summary || {};
    html += '<div class="stats" style="margin-bottom:1rem">';
    html += stat(summary.total_sessions || 0, 'Total');
    html += stat(summary.active_count || 0, 'Active');
    html += '</div>';

    var sessions = d.sessions || {};
    var labels = {
      'local-mcp-client': 'Local MCP clients',
      'hosted-browser-session': 'Hosted browser sessions',
      'hosted-mcp-agent': 'Hosted MCP agents',
      'sync-node': 'Sync nodes',
      'hosted-mcp-connector': 'Hosted MCP connectors',
    };
    var types = ['local-mcp-client', 'hosted-browser-session', 'hosted-mcp-agent', 'sync-node', 'hosted-mcp-connector'];
    var badgeClass = { active: 'badge-ok', recent: 'badge-warn', stale: 'badge-err' };
    var badgeLabel = { active: 'Active', recent: 'Recent', stale: 'Stale' };

    for (var ti = 0; ti < types.length; ti++) {
      var type = types[ti];
      var list = sessions[type] || [];
      html += '<div class="card" data-session-card="' + esc(type) + '">';
      html += '<div class="card-title">' + esc(labels[type] || type) + '</div>';
      if (type === 'local-mcp-client' && d.local_mcp_client_visibility === 'cross_tenant_suppressed') {
        html += '<div class="empty">Local MCP process presence is hidden because this machine is configured for a different tenant.</div>';
      } else if (type === 'local-mcp-client' && d.local_mcp_client_visibility === 'no_local_config') {
        html += '<div class="empty">No local VO tenant configuration was found on this machine.</div>';
      } else if (list.length === 0) {
        html += '<div class="empty">No activity for this actor type.</div>';
      } else {
        for (var si = 0; si < list.length; si++) {
          var s = list[si] || {};
          var freshness = s.freshness || 'stale';
          var cls = badgeClass[freshness] || '';
          var label = badgeLabel[freshness] || freshness;
          var when = s.last_event_at ? fmtTime(s.last_event_at) : (s.started_at ? 'started ' + fmtTime(s.started_at) : 'never');
          html += '<div class="summary-row" data-session-row="' + esc(s.session_id || s.pid || '') + '">';
          html += '<span class="summary-label"><code>' + esc(s.session_id || s.pid || 'unknown') + '</code></span>';
          html += '<span class="summary-value" style="font-size:.75rem">';
          html += '<span class="badge ' + cls + '" data-session-freshness-badge>' + esc(label) + '</span>';
          html += ' &middot; <code data-session-freshness-state style="font-size:.7rem;color:var(--dim)">' + esc(freshness) + '</code>';
          if (s.last_event_type) html += ' &middot; ' + esc(s.last_event_type);
          html += ' &middot; ' + esc(when);
          html += '</span></div>';
        }
      }
      html += '</div>';
    }

    content.innerHTML = html;
  }

  // ── Trends tab ────────────────────────────────────────────────────

  function fetchTrends() {
    Promise.all([
      fetch(dashUrl('/trends/diagnostics'), { headers: authHeaders() }),
      fetch(dashUrl('/trends/config'), { headers: authHeaders() }),
      fetch(dashUrl('/dashboard/settings'), { headers: authHeaders() }),
    ]).then(function(responses) {
      var diagRes = responses[0];
      var cfgRes = responses[1];
      var settingsRes = responses[2];
      var authRequiredResponses = [diagRes, settingsRes];
      for (var i = 0; i < authRequiredResponses.length; i++) {
        if (authRequiredResponses[i].status === 401 || authRequiredResponses[i].status === 403) {
          clearToken();
          render();
          return null;
        }
        if (!authRequiredResponses[i].ok) throw new Error('HTTP ' + authRequiredResponses[i].status);
      }
      var cfgJson;
      if (cfgRes.status === 401 || cfgRes.status === 403) {
        cfgJson = Promise.resolve({ params: {}, defaults: {} });
      } else if (!cfgRes.ok) {
        throw new Error('HTTP ' + cfgRes.status);
      } else {
        cfgJson = cfgRes.json();
      }
      return Promise.all([diagRes.json(), cfgJson, settingsRes.json()]);
    }).then(function(payloads) {
      if (!payloads) return;
      // R5 value surfaces. Tolerate per-endpoint failure: agent-gaps returns
      // 403 for tenant beta (operator-only by design — Q-R5.9), and any other
      // R5 endpoint failing should not blow up the whole tab.
      var safeJson = function(url, fallback) {
        return fetch(dashUrl(url), { headers: authHeaders() })
          .then(function(r) {
            if (r.ok) return r.json();
            var f = Object.assign({}, fallback);
            f.unavailable = true;
            f.status = r.status;
            return f;
          })
          .catch(function(err) {
            var f = Object.assign({}, fallback);
            f.unavailable = true;
            f.error = err && err.message || 'request failed';
            return f;
          });
      };
      return Promise.all([
        Promise.resolve(payloads),
        safeJson('/trends/knowledge-debt', { buckets: [] }),
        safeJson('/trends/promotion-candidates', { candidates: [] }),
        safeJson('/trends/drift-conflicts', { conflicts: [] }),
        safeJson('/trends/agent-gaps', { gaps: [] }),
      ]);
    }).then(function(combined) {
      if (!combined) return;
      var p = combined[0];
      renderTrends(p[0], p[1], p[2], combined[1], combined[2], combined[3], combined[4]);
    }).catch(function(err) {
      content.innerHTML = '<div class="state-msg">Failed to load trends: ' + esc(err.message) + '</div>';
    });
  }

  function fmtTrendAge(seconds) {
    var n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return 'none';
    if (n < 3600) return Math.floor(n / 60) + 'm';
    if (n < 86400) return (n / 3600).toFixed(n < 7200 ? 1 : 0) + 'h';
    return (n / 86400).toFixed(n < 172800 ? 1 : 0) + 'd';
  }

  function trendInputId(key) {
    return 'trend-param-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function renderTrends(diag, cfg, settings, debt, candidates, conflicts, gaps) {
    var auth = (settings && settings._auth) || {};
    var canWrite = !!(auth.machine_settings_can_write !== undefined ? auth.machine_settings_can_write : auth.can_write);
    var tenantCanWrite = !!auth.tenant_settings_can_write;
    var tenantId = auth.tenant_id || getTenantId();
    var ms = (settings && settings.machine_settings) || {};
    var ts = (settings && settings.tenant_settings) || {};
    var trendsEnabled = !!ms.trends_enabled;
    var tenantTrendsEnabled = !!ts.trends_enabled;
    var stimuli = (diag && diag.stimuli) || {};
    var orphanPool = (diag && diag.orphan_pool) || {};
    var protoClusters = (diag && diag.proto_clusters) || {};
    var trends = (diag && diag.trends) || {};
    var totalStimuli = Number(stimuli.total || 0);
    var embeddingPct = totalStimuli > 0 ? ((Number(stimuli.with_embedding || 0) / totalStimuli) * 100).toFixed(0) + '%' : '0%';
    var oldestAge = fmtTrendAge(stimuli.oldest_unprocessed_age_seconds);

    var html = '<div class="rhythm-full">' +
      '<div class="page-kicker">Reactor controls</div>' +
      '<div class="page-title-row"><h1>Trends</h1></div>' +
      '</div>';

    html += '<div class="card card-dither"><div class="card-title">Reactor Toggle</div>';
    html += '<div class="structure-row" title="Machine-level kill switch. graph_state[\\'trend_enabled\\'] is a separate library-level lever tunable via PATCH /trends/config.">';
    html += '<span class="structure-label">trends_enabled</span>';
    html += '<span class="structure-meta">' + esc(String(trendsEnabled)) + '</span>';
    if (canWrite) {
      html += '<div class="structure-actions">';
      html += '<button class="btn-sm btn-ghost" data-setting-key="trends_enabled" data-setting-val="' + (trendsEnabled ? 'false' : 'true') + '">' + (trendsEnabled ? 'Disable' : 'Enable') + '</button>';
      html += '</div>';
    }
    html += '</div><div id="settings-status" class="status-msg"></div></div>';

    html += '<div class="card"><div class="card-title">Tenant Trends</div>';
    html += '<div class="structure-row">';
    html += '<span class="structure-label">' + esc(tenantId || 'tenant') + '</span>';
    html += '<span class="structure-meta">' + (tenantTrendsEnabled ? 'Enabled' : 'Disabled') + '</span>';
    if (tenantCanWrite) {
      html += '<div class="structure-actions">';
      html += '<button class="btn-sm btn-ghost" data-tenant-setting-key="trends_enabled" data-tenant-setting-val="' + (tenantTrendsEnabled ? 'false' : 'true') + '">' + (tenantTrendsEnabled ? 'Disable for this tenant' : 'Enable for this tenant') + '</button>';
      html += '</div>';
    }
    html += '</div><div id="tenant-settings-status" class="status-msg"></div></div>';

    html += '<div class="stats" style="margin-bottom:1rem">';
    html += stat(totalStimuli, 'Pending stimuli');
    html += stat(embeddingPct, 'Embedded');
    html += stat(orphanPool.size || 0, 'Orphan pool');
    html += stat(protoClusters.total || 0, 'Proto-clusters');
    html += stat(trends.live || 0, 'Live trends');
    html += stat(String(trends.born_last_24h || 0) + ' / ' + String(trends.died_last_24h || 0), 'Born / died 24h');
    html += stat(oldestAge, 'Oldest pending');
    html += '</div>';

    var params = (cfg && cfg.params) || {};
    var defaults = (cfg && cfg.defaults) || {};
    var keys = [
      'convergenceMinOrphans',
      'convergenceMinSources',
      'convergenceMinOrigins',
      'convergenceMinEnergy',
      'protoClusterMaxAgeHours',
      'dedupSimilarity',
      'protoClusterJoinSimilarity',
    ].filter(function(key) {
      return Object.prototype.hasOwnProperty.call(params, key) && Object.prototype.hasOwnProperty.call(defaults, key);
    });

    html += '<div class="card"><div class="card-title">Threshold Tuning</div>';
    if (!canWrite) {
      html += '<div class="empty">Read-only mode. Operator token required for trend tuning.</div>';
    } else if (keys.length === 0) {
      html += '<div class="empty">No tunable trend parameters available.</div>';
    } else {
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var inputId = trendInputId(key);
        html += '<div class="structure-row">';
        html += '<span class="structure-label">' + esc(key) + '</span>';
        html += '<span class="structure-meta">default ' + esc(String(defaults[key])) + '</span>';
        html += '<div class="structure-actions" style="gap:0.35rem;flex-wrap:wrap">';
        html += '<input class="input-sm" id="' + esc(inputId) + '" type="number" step="any" value="' + esc(String(params[key])) + '" style="max-width:110px">';
        html += '<button class="btn-sm btn-primary" data-trend-param="' + esc(key) + '">Save</button>';
        html += '<button class="btn-sm btn-ghost" data-trend-reset="' + esc(key) + '">Reset</button>';
        html += '<span id="' + esc(inputId) + '-status" class="status-msg"></span>';
        html += '</div></div>';
      }
    }
    html += '</div>';

    // R5: Knowledge Debt — orphan stimuli aging out without converging.
    var debtBuckets = (debt && debt.buckets) || [];
    html += '<div class="card"><div class="card-title">Knowledge Debt</div>';
    html += '<div class="card-subtitle">Orphan stimuli older than 14 days that never converged. Domains where you may need to ingest more material.</div>';
    if (debt && debt.unavailable) {
      html += '<div class="empty">Knowledge debt is temporarily unavailable' + (debt.status ? ' (HTTP ' + esc(String(debt.status)) + ')' : '') + '.</div>';
    } else if (debtBuckets.length === 0) {
      html += '<div class="empty">No aged orphans (older than 14 days) in your visible spaces.</div>';
    } else {
      html += '<table class="data-table"><thead><tr><th>Space</th><th>Origin</th><th>Age bucket</th><th>Count</th><th>Oldest</th></tr></thead><tbody>';
      for (var d = 0; d < debtBuckets.length; d++) {
        var bucket = debtBuckets[d];
        html += '<tr>';
        html += '<td>' + esc(String(bucket.space_id || '')) + '</td>';
        html += '<td>' + esc(String(bucket.origin_kind || '')) + '</td>';
        html += '<td>' + esc(String(bucket.age_bucket || '')) + '</td>';
        html += '<td>' + esc(String(bucket.count || 0)) + '</td>';
        html += '<td>' + esc(fmtTrendAge(bucket.oldest_age_seconds)) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // R5: Promotion Candidates — proto-clusters meeting non-age gates.
    var cands = (candidates && candidates.candidates) || [];
    html += '<div class="card"><div class="card-title">Promotion Candidates</div>';
    html += '<div class="card-subtitle">Proto-clusters meeting orphan/source/origin/energy gates but blocked by the age gate. Operators can force-promote (other gates still enforced; audited).</div>';
    if (candidates && candidates.unavailable) {
      html += '<div class="empty">Promotion candidates are temporarily unavailable' + (candidates.status ? ' (HTTP ' + esc(String(candidates.status)) + ')' : '') + '.</div>';
    } else if (cands.length === 0) {
      html += '<div class="empty">No proto-clusters waiting on the age gate in your visible spaces.</div>';
    } else {
      html += '<table class="data-table"><thead><tr><th>Cluster</th><th>Space</th><th>Action</th><th>Age</th><th>Orphans</th><th>Sources</th><th>Origins</th><th>Energy</th>';
      if (canWrite) html += '<th>Promote</th>';
      html += '</tr></thead><tbody>';
      for (var k = 0; k < cands.length; k++) {
        var cand = cands[k];
        html += '<tr>';
        html += '<td><code>' + esc(String(cand.id || '').slice(0, 8)) + '…</code></td>';
        html += '<td>' + esc(String(cand.space_id || '')) + '</td>';
        html += '<td>' + esc(String(cand.action || '')) + '</td>';
        html += '<td>' + esc(Number(cand.age_hours || 0).toFixed(1) + 'h') + '</td>';
        html += '<td>' + esc(String(cand.orphan_count || 0)) + '</td>';
        html += '<td>' + esc(String((cand.source_types || []).length)) + '</td>';
        html += '<td>' + esc(String(cand.origin_diversity || 0)) + '</td>';
        html += '<td>' + esc(Number(cand.total_energy || 0).toFixed(2)) + '</td>';
        if (canWrite) {
          html += '<td><button class="btn-sm btn-primary" data-trend-promote="' + esc(String(cand.id)) + '" data-trend-promote-space="' + esc(String(cand.space_id || '')) + '">Promote</button></td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // R5: Drift Conflicts — review-priority heuristic, NOT entailment.
    var conflictRows = (conflicts && conflicts.conflicts) || [];
    html += '<div class="card"><div class="card-title">Drift Conflicts</div>';
    html += '<div class="card-subtitle">Possible drift review candidates: external-source-heavy clusters near durable nodes that lexically diverge. Heuristic — not a contradiction claim.</div>';
    if (conflicts && conflicts.unavailable) {
      html += '<div class="empty">Drift conflicts are temporarily unavailable' + (conflicts.status ? ' (HTTP ' + esc(String(conflicts.status)) + ')' : '') + '.</div>';
    } else if (conflictRows.length === 0) {
      html += '<div class="empty">No drift review candidates in your visible spaces.</div>';
    } else {
      html += '<table class="data-table"><thead><tr><th>Cluster</th><th>Cluster space</th><th>Node</th><th>Score</th><th>Similarity</th><th>Lex divergence</th><th>Ext src ratio</th></tr></thead><tbody>';
      for (var p = 0; p < conflictRows.length && p < 25; p++) {
        var con = conflictRows[p];
        html += '<tr>';
        html += '<td><code>' + esc(String(con.proto_cluster_id || '').slice(0, 8)) + '…</code></td>';
        html += '<td>' + esc(String(con.cluster_space_id || '')) + '</td>';
        html += '<td><code>' + esc(String(con.node_addr || '')) + '</code> ' + esc(String(con.node_label || '')) + '</td>';
        html += '<td>' + esc(Number(con.conflict_score || 0).toFixed(4)) + '</td>';
        html += '<td>' + esc(Number(con.similarity || 0).toFixed(3)) + '</td>';
        html += '<td>' + esc(Number(con.lexical_divergence || 0).toFixed(3)) + '</td>';
        html += '<td>' + esc(Number(con.external_source_ratio || 0).toFixed(3)) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // R5: Agent Gaps — operator-only because query_log lacks space_id (Q-R5.9).
    if (canWrite) {
      var gapRows = (gaps && gaps.gaps) || [];
      html += '<div class="card"><div class="card-title">Agent Gaps</div>';
      html += '<div class="card-subtitle">Recent agent queries with low similarity or no results, joined to orphan stimuli that might fill them. Operator-only until query_log is space-scoped.</div>';
      if (gapRows.length === 0) {
        html += '<div class="empty">No agent gaps detected in the last 7 days.</div>';
      } else {
        html += '<table class="data-table"><thead><tr><th>Terms</th><th>Queries</th><th>Matching orphans</th><th>Sample queries</th></tr></thead><tbody>';
        for (var g = 0; g < gapRows.length; g++) {
          var gap = gapRows[g];
          html += '<tr>';
          html += '<td>' + esc((gap.terms || []).slice(0, 5).join(', ')) + '</td>';
          html += '<td>' + esc(String(gap.query_count || 0)) + '</td>';
          html += '<td>' + esc(String(gap.orphan_count || 0)) + '</td>';
          html += '<td>' + esc((gap.sample_queries || []).slice(0, 2).join(' | ')) + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      html += '</div>';
    }

    content.innerHTML = html;

    if (canWrite) {
      var toggleBtns = document.querySelectorAll('[data-setting-key]');
      for (var t = 0; t < toggleBtns.length; t++) {
        toggleBtns[t].addEventListener('click', function() {
          var key = this.getAttribute('data-setting-key');
          var val = this.getAttribute('data-setting-val');
          settingToggle(key, val === 'true' ? true : val === 'false' ? false : val);
        });
      }

      var saveBtns = document.querySelectorAll('[data-trend-param]');
      for (var s = 0; s < saveBtns.length; s++) {
        saveBtns[s].addEventListener('click', function() {
          saveTrendParam(this.getAttribute('data-trend-param'), params);
        });
      }

      var resetBtns = document.querySelectorAll('[data-trend-reset]');
      for (var r = 0; r < resetBtns.length; r++) {
        resetBtns[r].addEventListener('click', function() {
          var key = this.getAttribute('data-trend-reset');
          var input = document.getElementById(trendInputId(key));
          if (input) input.value = defaults[key];
        });
      }

      var promoteBtns = document.querySelectorAll('[data-trend-promote]');
      for (var pb = 0; pb < promoteBtns.length; pb++) {
        promoteBtns[pb].addEventListener('click', function() {
          var protoId = this.getAttribute('data-trend-promote');
          var spaceId = this.getAttribute('data-trend-promote-space') || '';
          promoteCandidate(protoId, spaceId);
        });
      }
    }
    if (tenantCanWrite) {
      var tenantToggleBtns = document.querySelectorAll('[data-tenant-setting-key]');
      for (var tt = 0; tt < tenantToggleBtns.length; tt++) {
        tenantToggleBtns[tt].addEventListener('click', function() {
          var key = this.getAttribute('data-tenant-setting-key');
          var val = this.getAttribute('data-tenant-setting-val');
          tenantSettingToggle(key, val === 'true' ? true : val === 'false' ? false : val);
        });
      }
    }
  }

  function saveTrendParam(key, params) {
    var input = document.getElementById(trendInputId(key));
    var status = document.getElementById(trendInputId(key) + '-status');
    if (!input) return;
    var next = Number(input.value);
    if (!Number.isFinite(next)) {
      if (status) status.innerHTML = '<span class="status-err">Enter a number</span>';
      return;
    }
    var prev = params ? params[key] : undefined;
    if (!confirm('Update ' + key + ' from ' + prev + ' to ' + next + '?')) return;
    fetch(dashUrl('/trends/config'), {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ params: { [key]: next } }),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      if (data.ok) {
        if (status) status.innerHTML = '<span class="status-ok">&#10003; updated</span>';
        setTimeout(function() { fetchTrends(); }, 500);
      } else {
        if (status) status.innerHTML = '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
      }
    }).catch(function(err) {
      if (status) status.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
    });
  }

  function promoteCandidate(protoId, spaceId) {
    var shortId = (protoId || '').slice(0, 8);
    var msg = 'Force-promote ' + shortId + '…?\\n\\nThis bypasses the age gate. ' +
      'Other gates (orphans, sources, origins, energy) are still enforced. ' +
      'The action is audited as trend_proto_cluster_promote.';
    if (!confirm(msg)) return;
    var body = spaceId ? JSON.stringify({ space_id: spaceId }) : '{}';
    fetch(dashUrl('/trends/promote/' + encodeURIComponent(protoId)), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: body,
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json().then(function(data) { return { res: res, data: data }; });
    }).then(function(out) {
      if (!out) return;
      if (out.res.ok && out.data && out.data.ok) {
        alert('Promoted ' + (out.data.trend_addr || 'birth pending') + ' in ' + (out.data.space_id || ''));
        setTimeout(function() { fetchTrends(); }, 500);
      } else {
        var msg2 = (out.data && (out.data.error || out.data.message)) || ('HTTP ' + out.res.status);
        var details = out.data && out.data.details;
        var reason = details && details.reason ? ' (' + details.reason + ')' : '';
        alert('Promote failed: ' + msg2 + reason);
      }
    }).catch(function(err) {
      alert('Promote failed: ' + err.message);
    });
  }

  // ── Settings tab ──────────────────────────────────────────────────

  function fetchSettings() {
    fetch(dashUrl('/dashboard/settings'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data._auth) authMeta = data._auth;
        renderSettings(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load settings: ' + esc(err.message) + '</div>'; });
  }

  function supercronBadge(label, state) {
    return '<span class="auth-badge" data-state="' + esc(state) + '" style="margin-left:0.35rem">' + esc(label) + '</span>';
  }

  function supercronBudgetUsd(micro) {
    var n = Number(micro);
    if (!Number.isFinite(n)) n = 170000;
    return (n / 1000000).toFixed(2);
  }

  function renderSupercronTenantControls(d) {
    var auth = d._auth || {};
    var ts = d.tenant_settings || {};
    var tenantId = auth.tenant_id || getTenantId() || '';
    var canWrite = !!auth.tenant_settings_can_write;
    var activeHours = ts.supercron_active_hours || { start: 0, end: 24 };
    var pyramidFocus = Array.isArray(ts.supercron_pyramid_focus) ? ts.supercron_pyramid_focus : [];
    var html = '<div class="card card-dither"><div class="card-title">SuperCron Tenant Controls</div>';
    html += '<div class="card-subtitle">Run cadence and tenant policy controls are active for the SuperCron instance-owner tenant.</div>';
    html += '<div class="structure-row"><span class="structure-label">Run Cadence ' + supercronBadge('active', 'live') + '</span>';
    html += '<span class="structure-meta">Current: ' + esc(String(ts.supercron_cadence_minutes || 240)) + ' min</span>';
    html += '<div class="structure-actions"><select class="input-sm" id="supercron-cadence-minutes" ' + (canWrite ? '' : 'disabled') + '>';
    var cadenceOptions = [60, 240, 720, 1440];
    for (var c = 0; c < cadenceOptions.length; c++) {
      var cadence = cadenceOptions[c];
      html += '<option value="' + cadence + '"' + (Number(ts.supercron_cadence_minutes || 240) === cadence ? ' selected' : '') + '>' + esc(cadence === 60 ? 'Hourly' : cadence === 240 ? 'Every 4 hours' : cadence === 720 ? 'Twice daily' : 'Daily') + '</option>';
    }
    html += '</select><button class="btn-sm btn-primary" data-supercron-control="cadence" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Daily LLM Budget ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">$' + esc(supercronBudgetUsd(ts.supercron_llm_budget_usd_micro_daily)) + ' / day</span>';
    html += '<div class="structure-actions"><input class="input-sm" id="supercron-budget-usd" type="number" min="0.10" max="2.00" step="0.01" value="' + esc(supercronBudgetUsd(ts.supercron_llm_budget_usd_micro_daily)) + '" ' + (canWrite ? '' : 'disabled') + '><button class="btn-sm btn-primary" data-supercron-control="budget" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Active Hours ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">' + esc(String(activeHours.start)) + ':00-' + esc(String(activeHours.end)) + ':00 UTC</span>';
    html += '<div class="structure-actions" title="Active hours use UTC. Use start greater than end for an overnight UTC window."><input class="input-sm" id="supercron-hours-start" aria-label="Active start hour UTC" type="number" min="0" max="24" step="1" value="' + esc(String(activeHours.start)) + '" ' + (canWrite ? '' : 'disabled') + '><input class="input-sm" id="supercron-hours-end" aria-label="Active end hour UTC" type="number" min="0" max="24" step="1" value="' + esc(String(activeHours.end)) + '" ' + (canWrite ? '' : 'disabled') + '><button class="btn-sm btn-primary" data-supercron-control="active_hours" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Maintenance Intensity ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">' + esc(String(ts.supercron_intensity || 'light')) + '</span>';
    html += '<div class="structure-actions"><select class="input-sm" id="supercron-intensity" ' + (canWrite ? '' : 'disabled') + '>';
    ['light', 'balanced', 'thorough'].forEach(function(v) { html += '<option value="' + esc(v) + '"' + ((ts.supercron_intensity || 'light') === v ? ' selected' : '') + '>' + esc(v) + '</option>'; });
    html += '</select><button class="btn-sm btn-primary" data-supercron-control="intensity" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Active Features ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">Golden ' + esc(String(!!ts.golden_query_enabled)) + ', recall ' + esc(String(!!ts.recall_outcomes_enabled)) + ', confidence ' + esc(String(!!ts.confidence_promotion_enabled)) + '</span>';
    html += '<div class="structure-actions" style="gap:0.35rem;flex-wrap:wrap">';
    ['golden_query_enabled', 'recall_outcomes_enabled', 'confidence_promotion_enabled'].forEach(function(key) {
      var next = !ts[key];
      html += '<button class="btn-sm btn-ghost" data-supercron-control="feature" data-supercron-feature-key="' + esc(key) + '" data-supercron-feature-value="' + esc(String(next)) + '" ' + (canWrite ? '' : 'disabled') + '>' + esc((next ? 'Enable ' : 'Disable ') + key.replace(/_enabled$/, '')) + '</button>';
    });
    html += '</div></div>';

    html += '<div class="structure-row"><span class="structure-label">Pyramid Focus ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">' + esc(pyramidFocus.length ? pyramidFocus.join(', ') : 'all pyramids') + '</span>';
    html += '<div class="structure-actions"><input class="input-sm" id="supercron-pyramid-focus" value="' + esc(pyramidFocus.join(', ')) + '" placeholder="PROJECTS, FUNCTION" ' + (canWrite ? '' : 'disabled') + '><button class="btn-sm btn-primary" data-supercron-control="pyramid_focus" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Quality Sensitivity ' + supercronBadge('live', 'active') + '</span>';
    html += '<span class="structure-meta">' + esc(String(ts.supercron_quality_preset || 'balanced')) + '</span>';
    html += '<div class="structure-actions"><select class="input-sm" id="supercron-quality-preset" ' + (canWrite ? '' : 'disabled') + '>';
    ['lenient', 'balanced', 'strict'].forEach(function(v) { html += '<option value="' + esc(v) + '"' + ((ts.supercron_quality_preset || 'balanced') === v ? ' selected' : '') + '>' + esc(v) + '</option>'; });
    html += '</select><button class="btn-sm btn-primary" data-supercron-control="quality_preset" ' + (canWrite ? '' : 'disabled') + '>Save</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Node GC Candidates ' + supercronBadge('candidate', 'armed') + '</span>';
    html += '<span class="structure-meta">' + (ts.supercron_node_gc_candidate_enabled ? 'Enabled' : 'Disabled') + ' · dormant ' + esc(String(ts.supercron_node_gc_dormant_days || 90)) + 'd · cap ' + esc(String(ts.supercron_node_gc_per_cycle_cap || 50)) + '/' + esc(String(ts.supercron_node_gc_max_active_candidates || 200)) + '</span>';
    html += '<div class="structure-actions"><button class="btn-sm btn-ghost" data-supercron-control="feature" data-supercron-feature-key="supercron_node_gc_candidate_enabled" data-supercron-feature-value="' + esc(String(!ts.supercron_node_gc_candidate_enabled)) + '" ' + (canWrite ? '' : 'disabled') + '>' + (ts.supercron_node_gc_candidate_enabled ? 'Disable marking' : 'Enable marking') + '</button></div></div>';

    html += '<div class="structure-row"><span class="structure-label">Force Run ' + supercronBadge('active', 'live') + '</span>';
    html += '<span class="structure-meta">Requests next watch-loop cycle for ' + esc(tenantId || 'tenant') + '</span>';
    html += '<div class="structure-actions"><input class="input-sm" id="supercron-force-budget-usd" type="number" min="0" max="10.00" step="0.01" placeholder="optional budget USD" ' + (canWrite ? '' : 'disabled') + '><button class="btn-sm btn-primary" data-supercron-force-run="true" ' + (canWrite ? '' : 'disabled') + '>Run Now</button></div></div>';
    html += '<div id="supercron-controls-status" class="status-msg"></div><div id="supercron-force-run-status" class="status-msg"></div></div>';
    return html;
  }

  function renderSettings(d) {
    var canWrite = d._auth && (d._auth.machine_settings_can_write !== undefined ? d._auth.machine_settings_can_write : d._auth.can_write);
    var tenantCanWrite = d._auth && d._auth.tenant_settings_can_write;
    // Full-rhythm header for settings — explanatory, audit-style.
    // Authority model (do not invert): local writes are authoritative on
    // this node and surface in hosted as mirrored state on the next sync.
    // Queued intent is the *hosted-to-local* direction (hosted accepts a
    // request, local later applies it), not the other way around.
    var html = '<div class="rhythm-full">' +
      '<div class="page-kicker">Local configuration</div>' +
      '<div class="page-title-row"><h1>Settings ' +
      '<span class="auth-badge" data-state="local-authoritative">' +
        '<span class="auth-icon" aria-hidden="true">&#9679;</span>' +
        '<span class="auth-label">Local authoritative</span></span>' +
      '</h1></div>' +
      '<p class="page-lead">Machine, agent, and provider settings for this VO node. ' +
      'Changes here apply locally as the source of truth and become visible to hosted as mirrored state on the next sync.</p>' +
      '</div>';

    // Machine settings
    html += '<div class="card card-dither"><div class="card-title">Machine Settings</div>';
    var ms = d.machine_settings || {};
    var settingKeys = ['vo_enabled', 'trends_enabled', 'public_resonance', 'hosted_sync', 'vault_sync', 'public_overlay_sync'];
    for (var i = 0; i < settingKeys.length; i++) {
      var k = settingKeys[i];
      var v = ms[k];
      html += '<div class="structure-row">';
      html += '<span class="structure-label">' + esc(k) + '</span>';
      html += '<span class="structure-meta">' + esc(String(v)) + '</span>';
      if (canWrite) {
        html += '<div class="structure-actions">';
        if (typeof v === 'boolean') {
          html += '<button class="btn-sm btn-ghost" data-setting-key="' + esc(k) + '" data-setting-val="' + (v ? 'false' : 'true') + '">' + (v ? 'Disable' : 'Enable') + '</button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '<div id="settings-status" class="status-msg"></div></div>';

    html += renderSupercronTenantControls(d);

    // Agent policies
    var agents = d.agents || [];
    if (agents.length > 0) {
      html += '<div class="card"><div class="card-title">Agent Policies (' + esc(String(agents.length)) + ')</div>';
      for (var j = 0; j < agents.length; j++) {
        var ag = agents[j];
        var eff = ag.effective_policy || {};
        html += '<div class="card" style="margin-bottom:0.5rem;padding:0.75rem">';
        html += '<div style="font-family:var(--font-mono);font-size:0.82rem;color:var(--accent);margin-bottom:0.4rem">' + esc(ag.agent_id) + '</div>';
        if (ag.last_seen) html += '<div style="font-size:0.72rem;color:var(--text-muted)">Last seen: ' + fmtTime(ag.last_seen) + '</div>';

        html += '<div style="margin-top:0.4rem">';
        html += summaryRow('write_permission', eff.write_permission || 'allowed');
        html += summaryRow('recall_scope', eff.recall_scope || 'tenant_and_public');

        var vp = eff.visible_projects;
        html += summaryRow('visible_projects', vp === null ? 'all' : (Array.isArray(vp) ? vp.length + ' project(s)' : String(vp)));

        if (canWrite) {
          html += '<div class="inline-form" style="margin-top:0.4rem">';
          html += '<select class="input-sm" id="agent-wp-' + j + '" style="max-width:140px">';
          html += '<option value="allowed"' + (eff.write_permission === 'allowed' ? ' selected' : '') + '>allowed</option>';
          html += '<option value="denied"' + (eff.write_permission === 'denied' ? ' selected' : '') + '>denied</option>';
          html += '</select>';
          html += '<select class="input-sm" id="agent-rs-' + j + '" style="max-width:180px">';
          html += '<option value="tenant_and_public"' + (eff.recall_scope === 'tenant_and_public' ? ' selected' : '') + '>tenant_and_public</option>';
          html += '<option value="tenant_private"' + (eff.recall_scope === 'tenant_private' ? ' selected' : '') + '>tenant_private</option>';
          html += '</select>';
          html += '</div>';
          // visible_projects multi-select
          var vpArr = Array.isArray(vp) ? vp : [];
          var allProjects = d.projects || [];
          html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--text-muted)">visible_projects:</div>';
          html += '<select class="input-sm" id="agent-vp-' + j + '" multiple style="max-width:300px;min-height:60px;font-size:0.75rem">';
          html += '<option value="__all__"' + (vp === null ? ' selected' : '') + '>All projects (default)</option>';
          for (var pi = 0; pi < allProjects.length; pi++) {
            var pSel = vpArr.indexOf(allProjects[pi].addr) >= 0 ? ' selected' : '';
            html += '<option value="' + esc(allProjects[pi].addr) + '"' + pSel + '>' + esc(allProjects[pi].label) + '</option>';
          }
          html += '</select>';
          html += '<div class="inline-form" style="margin-top:0.3rem"><button class="btn-sm btn-primary" data-agent-idx="' + j + '" data-agent-id="' + esc(ag.agent_id) + '">Save Policy</button></div>';
        }

        html += '</div></div>';
      }
      html += '</div>';
    }

    if (!canWrite && !tenantCanWrite) {
      html += '<div class="card"><div class="empty">Read-only mode. Operator token required for settings changes.</div></div>';
    } else if (!canWrite) {
      html += '<div class="card"><div class="empty">Machine settings require an operator token. Tenant SuperCron controls remain available for the authenticated tenant.</div></div>';
    }

    content.innerHTML = html;

    // Wire setting toggles
    if (canWrite) {
      var toggleBtns = document.querySelectorAll('[data-setting-key]');
      for (var t = 0; t < toggleBtns.length; t++) {
        toggleBtns[t].addEventListener('click', function() {
          var key = this.getAttribute('data-setting-key');
          var val = this.getAttribute('data-setting-val');
          var parsed = val === 'true' ? true : val === 'false' ? false : val;
          settingToggle(key, parsed);
        });
      }

      // Wire agent policy saves
      var saveBtns = document.querySelectorAll('[data-agent-idx]');
      for (var s = 0; s < saveBtns.length; s++) {
        saveBtns[s].addEventListener('click', function() {
          var idx = this.getAttribute('data-agent-idx');
          var agentId = this.getAttribute('data-agent-id');
          var wp = document.getElementById('agent-wp-' + idx);
          var rs = document.getElementById('agent-rs-' + idx);
          var vpEl = document.getElementById('agent-vp-' + idx);
          if (!wp || !rs) return;
          var fields = { write_permission: wp.value, recall_scope: rs.value };
          // Parse visible_projects from multi-select
          if (vpEl) {
            var selected = [];
            for (var opt = 0; opt < vpEl.options.length; opt++) {
              if (vpEl.options[opt].selected) selected.push(vpEl.options[opt].value);
            }
            if (selected.indexOf('__all__') >= 0 || selected.length === 0) {
              fields.visible_projects = null; // all projects
            } else {
              fields.visible_projects = selected;
            }
          }
          agentPolicySave(agentId, fields);
        });
      }
    }
    if (tenantCanWrite) {
      var scBtns = document.querySelectorAll('[data-supercron-control]');
      for (var sc = 0; sc < scBtns.length; sc++) {
        scBtns[sc].addEventListener('click', function() {
          saveSupercronTenantControl(this);
        });
      }
      var forceBtns = document.querySelectorAll('[data-supercron-force-run]');
      for (var fr = 0; fr < forceBtns.length; fr++) {
        forceBtns[fr].addEventListener('click', function() {
          requestSupercronForceRun();
        });
      }
    }
  }

  function settingToggle(key, value) {
    var tid = getTenantId();
    var body = { scope: 'machine', key: key, value: value };
    if (tid) body.tenant_id = tid;
    fetch('/dashboard/settings/toggle', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      var el = document.getElementById('settings-status');
      if (data.ok) {
        if (el) el.innerHTML = '<span class="status-ok">&#10003; ' + esc(key) + ' updated</span>';
        setTimeout(function() { activeTab === 'trends' ? fetchTrends() : fetchSettings(); }, 500);
      } else {
        if (el) el.innerHTML = '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
      }
    }).catch(function(err) {
      var el = document.getElementById('settings-status');
      if (el) el.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
    });
  }

  function tenantSettingToggle(key, value) {
    var tid = currentTenantId();
    var body = { scope: 'tenant', tenant_id: tid, key: key, value: value };
    fetch('/dashboard/settings/toggle', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      var el = document.getElementById('tenant-settings-status') || document.getElementById('settings-status');
      if (data.ok) {
        if (el) el.innerHTML = '<span class="status-ok">&#10003; ' + esc(key) + ' updated</span>';
        setTimeout(function() { activeTab === 'trends' ? fetchTrends() : fetchSettings(); }, 500);
      } else {
        if (el) el.innerHTML = '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
      }
    }).catch(function(err) {
      var el = document.getElementById('tenant-settings-status') || document.getElementById('settings-status');
      if (el) el.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
    });
  }

  function controlValue(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }

  function setSupercronControlStatus(message, ok) {
    var el = document.getElementById('supercron-controls-status') || document.getElementById('tenant-settings-status') || document.getElementById('settings-status');
    if (el) el.innerHTML = '<span class="' + (ok ? 'status-ok' : 'status-err') + '">' + esc(message) + '</span>';
  }

  function saveSupercronTenantControl(button) {
    var control = button.getAttribute('data-supercron-control') || '';
    if (control === 'cadence') {
      return tenantSettingToggle('supercron_cadence_minutes', Number(controlValue('supercron-cadence-minutes')));
    }
    if (control === 'budget') {
      var usd = Number(controlValue('supercron-budget-usd'));
      if (!Number.isFinite(usd)) return setSupercronControlStatus('Enter a valid budget', false);
      return tenantSettingToggle('supercron_llm_budget_usd_micro_daily', Math.round(usd * 1000000));
    }
    if (control === 'active_hours') {
      var start = Number(controlValue('supercron-hours-start'));
      var end = Number(controlValue('supercron-hours-end'));
      if (!Number.isInteger(start) || !Number.isInteger(end)) return setSupercronControlStatus('Active hours must be whole hours', false);
      return tenantSettingToggle('supercron_active_hours', { start: start, end: end });
    }
    if (control === 'intensity') {
      return tenantSettingToggle('supercron_intensity', controlValue('supercron-intensity'));
    }
    if (control === 'feature') {
      var key = button.getAttribute('data-supercron-feature-key') || '';
      var val = button.getAttribute('data-supercron-feature-value') === 'true';
      return tenantSettingToggle(key, val);
    }
    if (control === 'pyramid_focus') {
      var raw = controlValue('supercron-pyramid-focus');
      var focus = raw.split(',').map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);
      return tenantSettingToggle('supercron_pyramid_focus', focus);
    }
    if (control === 'quality_preset') {
      return tenantSettingToggle('supercron_quality_preset', controlValue('supercron-quality-preset'));
    }
  }

  function requestSupercronForceRun() {
    var tid = currentTenantId();
    var status = document.getElementById('supercron-force-run-status');
    if (!tid) {
      if (status) status.innerHTML = '<span class="status-err">tenant_id required</span>';
      return;
    }
    var budgetRaw = controlValue('supercron-force-budget-usd').trim();
    var body = { tenant_id: tid };
    if (budgetRaw) {
      var budget = Number(budgetRaw);
      if (!Number.isFinite(budget) || budget < 0 || budget > 10) {
        if (status) status.innerHTML = '<span class="status-err">Enter a budget from 0 to 10 USD</span>';
        return;
      }
      body.llm_budget_usd = budget;
    }
    fetch('/supercron/force-run', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json().then(function(data) { return { res: res, data: data }; });
    }).then(function(out) {
      if (!out) return;
      if (out.res.ok && out.data && out.data.accepted) {
        if (status) status.innerHTML = '<span class="status-ok">&#10003; SuperCron force-run requested</span>';
      } else {
        var msg = (out.data && (out.data.error || out.data.message)) || ('HTTP ' + out.res.status);
        if (status) status.innerHTML = '<span class="status-err">' + esc(msg) + '</span>';
      }
    }).catch(function(err) {
      if (status) status.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
    });
  }

  function agentPolicySave(agentId, fields) {
    var tid = getTenantId();
    var body = Object.assign({}, fields);
    if (tid) body.tenant_id = tid;
    fetch('/dashboard/settings/agent/' + encodeURIComponent(agentId) + '/policy', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      if (data.ok) { fetchSettings(); }
      else { alert(data.error || 'Policy update failed'); }
    }).catch(function(err) { alert('Error: ' + err.message); });
  }

  // ── Providers tab ──────────────────────────────────────────────────

  function fetchProviders() {
    fetch(dashUrl('/dashboard/providers'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) { if (data) renderProviders(data); })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load providers: ' + esc(err.message) + '</div>'; });
  }

  function renderProviders(d) {
    var canWrite = d._auth && d._auth.can_write;
    var html = '<h2 style="font-size:1.1rem;margin-bottom:1rem;">Providers</h2>';

    // Provider cards
    var providers = d.providers || {};
    var names = Object.keys(providers);
    html += '<div class="section-cols" style="margin-bottom:1rem">';
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var p = providers[name];
      var statusLabel = providerStatusLabel(p);
      var statusColor = statusLabel === 'ok' ? 'var(--green)' : p.configured ? 'var(--amber)' : 'var(--text-muted)';
      html += '<div class="card">';
      html += '<div class="card-title" style="display:flex;justify-content:space-between">' + esc(name) + '<span style="color:' + statusColor + '">' + esc(statusLabel) + '</span></div>';
      html += summaryRow('Configured', p.configured ? 'Yes' : 'No');
      if (p.configured_at) html += summaryRow('Configured at', fmtTime(p.configured_at));
      if (p.last_validated_at) html += summaryRow('Last validated', fmtTime(p.last_validated_at));
      if (p.last_error) html += '<div style="font-size:0.75rem;color:var(--red);margin-top:0.3rem">' + esc(p.last_error) + '</div>';
      if (canWrite) {
        html += '<div class="inline-form" style="margin-top:0.5rem">';
        html += '<input class="input-sm" id="prov-key-' + i + '" type="password" placeholder="API key" autocomplete="off" style="max-width:200px">';
        html += '<button class="btn-sm btn-primary" data-prov-set="' + esc(name) + '" data-prov-idx="' + i + '">Set Key</button>';
        if (p.configured) html += '<button class="btn-sm btn-danger" data-prov-rm="' + esc(name) + '">Remove</button>';
        html += '<button class="btn-sm btn-ghost" data-prov-val="' + esc(name) + '">Verify</button>';
        html += '</div>';
      }
      html += '<div id="prov-status-' + i + '" class="status-msg"></div>';
      html += '</div>';
    }
    html += '</div>';

    // Task routing
    // VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1: Clear button is gated on
    // explicit override presence (task_overrides), NOT inferred from
    // effective != recommended (which would false-negative when the
    // override happens to match the recommendation byte-for-byte).
    html += '<div class="card card-dither" style="margin-bottom:1rem"><div class="card-title">Task Routing</div>';
    var tasks = d.canonical_tasks || [];
    var effective = d.effective_routing || {};
    var recommended = d.recommended_defaults || {};
    var taskOverrides = d.task_overrides || {};
    for (var t = 0; t < tasks.length; t++) {
      var task = tasks[t];
      var eff = effective[task] || {};
      var rec = recommended[task] || {};
      var taskHasOverride = !!taskOverrides[task];
      html += '<div class="structure-row">';
      html += '<span class="structure-label"><strong>' + esc(task) + '</strong><div class="structure-desc">Recommended: ' + esc(rec.provider || '') + '/' + esc(rec.model || '') + '</div></span>';
      html += '<span class="structure-meta">' + esc(eff.provider || '') + '/' + esc(eff.model || '') + '</span>';
      if (canWrite) {
        html += '<div class="structure-actions">';
        html += '<button class="btn-sm btn-ghost" data-task-edit="' + esc(task) + '">Edit</button>';
        // Clear renders ONLY for tasks with an explicit persisted
        // override. Tenant-token / read-only mode hides both buttons
        // because the whole actions block is canWrite-gated.
        if (taskHasOverride) {
          html += '<button class="btn-sm btn-ghost" data-task-clear="' + esc(task) + '" style="margin-left:.3rem">Clear</button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    // VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: separate read-only
    // Legacy Task Routes card. Surfaces persisted non-canonical
    // entries that pre-date the canonicalization (new writes are
    // blocked at every set surface). NO Edit, NO Clear — neither is
    // supported. Card hides entirely when no legacy entries exist.
    var legacyRoutes = d.legacy_task_routes || {};
    var legacyKeys = Object.keys(legacyRoutes);
    if (legacyKeys.length > 0) {
      html += '<div class="card" style="margin-bottom:1rem"><div class="card-title">Legacy Task Routes</div>';
      html += '<div class="empty" style="padding:.4rem 0;text-align:left;font-size:.72rem;color:var(--text-muted)">';
      html += 'These task names are not in the canonical task list and are not supported by dashboard controls. They will continue to apply at runtime until cleared from <code>~/.vo/config.json</code> directly.';
      html += '</div>';
      for (var lk = 0; lk < legacyKeys.length; lk++) {
        var legacyTask = legacyKeys[lk];
        var legacyRoute = legacyRoutes[legacyTask] || {};
        html += '<div class="structure-row">';
        html += '<span class="structure-label"><strong>' + esc(legacyTask) + '</strong><div class="structure-desc">non-canonical</div></span>';
        html += '<span class="structure-meta">' + esc(legacyRoute.provider || '') + '/' + esc(legacyRoute.model || '') + '</span>';
        // No actions block — no Edit, no Clear.
        html += '</div>';
      }
      html += '</div>';
    }

    // Agent overrides
    var agents = d.tenant_agents || [];
    var tasks = d.canonical_tasks || [];
    if (agents.length > 0) {
      html += '<div class="card"><div class="card-title">Agent LLM Overrides</div>';
      var overrides = d.agent_overrides || {};
      for (var a = 0; a < agents.length; a++) {
        var ag = agents[a];
        var agOvr = overrides[ag.agent_id] || {};
        html += '<div style="margin-bottom:0.75rem;padding:0.5rem;border-bottom:1px solid var(--border)">';
        html += '<div style="font-family:var(--font-mono);font-size:0.8rem;color:var(--accent);margin-bottom:0.3rem">' + esc(ag.agent_id) + '</div>';
        var ovrKeys = Object.keys(agOvr);
        if (ovrKeys.length > 0) {
          for (var ok = 0; ok < ovrKeys.length; ok++) {
            var ovTask = ovrKeys[ok];
            var ov = agOvr[ovTask];
            // VO-PROVIDER-AGENT-OVERRIDE-CLEAR-PR-1: render the
            // override row with an inline Clear button — only on
            // currently-overridden tasks. Set/replace remains in
            // the freeform form below; the two affordances stay
            // distinct so users can never click "clear" for a
            // task that isn't actually overridden.
            html += '<div class="summary-row" style="align-items:center">';
            html += '<span class="summary-label">' + esc(ovTask) + '</span>';
            html += '<span class="summary-value" style="display:flex;align-items:center;gap:.4rem">';
            html += esc((ov && ov.provider || '') + '/' + (ov && ov.model || ''));
            if (canWrite) {
              html += '<button class="btn-sm btn-ghost" data-agovr-clear-agent="' + esc(ag.agent_id) + '" data-agovr-clear-task="' + esc(ovTask) + '" style="padding:.1rem .4rem;font-size:.7rem">Clear</button>';
            }
            html += '</span>';
            html += '</div>';
          }
        } else {
          html += '<div class="empty">No overrides (using tenant defaults)</div>';
        }
        if (canWrite) {
          html += '<div class="inline-form" style="margin-top:0.3rem">';
          html += '<select class="input-sm" id="agovr-task-' + a + '" style="max-width:170px">';
          for (var ti = 0; ti < tasks.length; ti++) {
            html += '<option value="' + esc(tasks[ti]) + '">' + esc(tasks[ti]) + '</option>';
          }
          html += '</select>';
          html += '<input class="input-sm" id="agovr-prov-' + a + '" placeholder="provider" style="max-width:100px">';
          html += '<input class="input-sm" id="agovr-model-' + a + '" placeholder="model" style="max-width:130px">';
          html += '<button class="btn-sm btn-primary" data-agovr-idx="' + a + '" data-agovr-agent="' + esc(ag.agent_id) + '">Set Override</button>';
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (!canWrite) {
      html += '<div class="card"><div class="empty">Read-only mode. Operator token required for provider management.</div></div>';
    }

    content.innerHTML = html;
    wireProviderActions(d);
  }

  function providerStatusLabel(p) {
    if (!p || !p.configured) return 'unconfigured';
    if (p.validation_status === 'ok') return 'ok';
    if (p.validation_status === 'error') return 'error';
    if (p.last_error) return 'error';
    return 'not verified';
  }

  function wireProviderActions(d) {
    // Key set buttons
    var setBtns = document.querySelectorAll('[data-prov-set]');
    for (var i = 0; i < setBtns.length; i++) {
      setBtns[i].addEventListener('click', function() {
        var name = this.getAttribute('data-prov-set');
        var idx = this.getAttribute('data-prov-idx');
        var keyEl = document.getElementById('prov-key-' + idx);
        if (!keyEl || !keyEl.value.trim()) return;
        provMutate('/dashboard/providers/key', { provider: name, key: keyEl.value.trim() }, idx, function() { fetchProviders(); });
      });
    }
    // Remove buttons
    var rmBtns = document.querySelectorAll('[data-prov-rm]');
    for (var r = 0; r < rmBtns.length; r++) {
      rmBtns[r].addEventListener('click', function() {
        var name = this.getAttribute('data-prov-rm');
        if (!confirm('Remove key for ' + name + '?')) return;
        provMutate('/dashboard/providers/remove-key', { provider: name }, null, function() { fetchProviders(); });
      });
    }
    // Validate buttons
    var valBtns = document.querySelectorAll('[data-prov-val]');
    for (var v = 0; v < valBtns.length; v++) {
      valBtns[v].addEventListener('click', function() {
        var name = this.getAttribute('data-prov-val');
        provMutate('/dashboard/providers/validate', { provider: name }, null, function() { fetchProviders(); });
      });
    }
    // Agent override buttons
    var aovrBtns = document.querySelectorAll('[data-agovr-idx]');
    for (var ao = 0; ao < aovrBtns.length; ao++) {
      aovrBtns[ao].addEventListener('click', function() {
        var idx = this.getAttribute('data-agovr-idx');
        var agentId = this.getAttribute('data-agovr-agent');
        var taskEl = document.getElementById('agovr-task-' + idx);
        var provEl = document.getElementById('agovr-prov-' + idx);
        var modelEl = document.getElementById('agovr-model-' + idx);
        if (!taskEl || !provEl || !modelEl || !provEl.value.trim() || !modelEl.value.trim()) return;
        provMutate('/dashboard/providers/agent-override', {
          agent_id: agentId, task: taskEl.value, provider: provEl.value.trim(), model: modelEl.value.trim()
        }, null, function() { fetchProviders(); });
      });
    }
    // Agent override CLEAR buttons (per-row, only on existing overrides).
    var aovrClearBtns = document.querySelectorAll('[data-agovr-clear-agent]');
    for (var ac = 0; ac < aovrClearBtns.length; ac++) {
      aovrClearBtns[ac].addEventListener('click', function() {
        var agentId = this.getAttribute('data-agovr-clear-agent');
        var task = this.getAttribute('data-agovr-clear-task');
        if (!confirm('Clear override "' + task + '" for ' + agentId + '?')) return;
        provMutate('/dashboard/providers/agent-override/clear', {
          agent_id: agentId, task: task
        }, null, function() { fetchProviders(); });
      });
    }
    // Task routing edit
    var taskBtns = document.querySelectorAll('[data-task-edit]');
    for (var te = 0; te < taskBtns.length; te++) {
      taskBtns[te].addEventListener('click', function() {
        var task = this.getAttribute('data-task-edit');
        var provider = prompt('Provider for ' + task + ':');
        if (!provider) return;
        var model = prompt('Model for ' + task + ':');
        if (!model) return;
        provMutate('/dashboard/providers/defaults', { task: task, provider: provider, model: model }, null, function() { fetchProviders(); });
      });
    }
    // Task routing CLEAR (per-row, only on overridden tasks).
    var taskClearBtns = document.querySelectorAll('[data-task-clear]');
    for (var tc = 0; tc < taskClearBtns.length; tc++) {
      taskClearBtns[tc].addEventListener('click', function() {
        var task = this.getAttribute('data-task-clear');
        if (!confirm('Clear task routing override for "' + task + '"? It will fall back to the recommended default.')) return;
        provMutate('/dashboard/providers/defaults/clear', { task_type: task }, null, function() { fetchProviders(); });
      });
    }
  }

  function provMutate(path, body, statusIdx, onSuccess) {
    var tid = getTenantId();
    if (tid) body.tenant_id = tid;
    fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      if (statusIdx !== null) {
        var el = document.getElementById('prov-status-' + statusIdx);
        if (el) el.innerHTML = data.ok ? '<span class="status-ok">&#10003; Done</span>' : '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
      }
      if (data.ok && onSuccess) setTimeout(function() { onSuccess(data); }, 300);
      else if (!data.ok) alert(data.error || 'Operation failed');
    }).catch(function(err) { alert('Error: ' + err.message); });
  }

  // ── Vault tab (VO-LOCAL-VAULT-DASHBOARD-PR-1) ─────────────────────
  //
  // Structured state comes from GET /dashboard/vault (api/src/lib/vault-control
  // readVaultDashboardState). The renderer keeps three axes visible
  // at all times — feature intent, root/binding, and Obsidian companion —
  // and dispatches per-status-kind copy + actions underneath.

  // Persist the last-rendered harvest result so the post-harvest state
  // refresh (fetchVault → renderVault) does not wipe the operator's
  // success/stop guidance when it rebuilds the Vault tab.
  //
  // Scoped by the identity the result was rendered against (tenant_id
  // plus vault_root) so switching tenants or reconnecting with a
  // different operator session cannot leak one tenant's vault paths
  // or recovery guidance into another tenant's UI. Cleared on new
  // harvest submit, on clearToken, and on gate resubmit (which
  // mutates token / tenant_id). Restore is additionally gated on the
  // CURRENT rendered state matching the cache's tenant_id +
  // vault_root at paint time.
  //
  // Shape: { tenant: string, root: string, html: string } or null.
  var lastHarvestResult = null;
  function clearLastHarvestResult() { lastHarvestResult = null; }

  // VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
  // client populator for post-harvest reveal + open-obsidian
  // slots emitted by the presenter. Runs after every harvest
  // result paint (fresh submit AND cached-result restore),
  // so the controls stay available across rerenders.
  //
  // Browser-mode honesty: the presenter emits empty slots
  // (data-attributed spans only); this populator fills them
  // ONLY when the wrapper is present. Browser users see empty
  // slots (no dead controls). Obsidian handoff is additionally
  // gated on the shared shouldRenderObsidianQuickAction truth
  // at paint time, and re-checked at click time in the
  // delegate (a stale click after state drift refuses
  // honestly instead of dispatching).
  // VO-LOCAL-DASHBOARD-HARVEST-LOG-REVEAL-PR-1 —
  // card-level Reveal log.md populator. Runs after every
  // renderVault() mounts the harvest card. Browser-mode
  // honesty: the static slot stays empty unless the wrapper
  // is present, so non-desktop operators see no dead control.
  // Dispatch-time recheck of wrapper + ready + vault_root
  // happens in the delegated click handler, not here —
  // paint-time populator only gates on wrapper presence (the
  // click will compose against the live vault_root anyway and
  // refuse if it has drifted).
  function populateHarvestLogReveal() {
    var slot = document.getElementById('vault-harvest-log-reveal');
    if (!slot) return;
    if (slot.__voHarvestLogRevealPopulated) return;
    slot.__voHarvestLogRevealPopulated = true;
    var hasWrapper = typeof window.voDesktop === 'object'
      && window.voDesktop !== null
      && typeof window.voDesktop.revealPath === 'function';
    if (!hasWrapper) return;
    // VO-LOCAL-DASHBOARD-HARVEST-INDEX-REVEAL-PR-1 +
    // VO-LOCAL-DASHBOARD-HARVEST-MANIFEST-REVEAL-PR-1 — the
    // managed-files row now hosts Reveal log.md, Reveal
    // index.md, and Reveal captures/.manifest.jsonl. Single
    // status span is shared (most-recent click wins) to keep
    // the row visually quiet; cross-fading is not useful here
    // because each reveal resolves independently and
    // asynchronously.
    slot.innerHTML =
      '<button type="button" class="btn-xs btn-ghost harvest-log-reveal-btn" '
      + 'data-harvest-log-action="reveal-log">Reveal log.md</button>'
      + '<button type="button" class="btn-xs btn-ghost harvest-log-reveal-btn" '
      + 'data-harvest-log-action="reveal-index" '
      + 'style="margin-left:.4rem">Reveal index.md</button>'
      + '<button type="button" class="btn-xs btn-ghost harvest-log-reveal-btn" '
      + 'data-harvest-log-action="reveal-manifest" '
      + 'style="margin-left:.4rem">Reveal captures/.manifest.jsonl</button>'
      + '<span class="harvest-log-reveal-status status-dim" '
      + 'data-harvest-log-reveal-status="1" '
      + 'style="margin-left:.4rem"></span>';
  }

  function populateHarvestLocalActions() {
    var resultEl = document.getElementById('vault-harvest-result');
    if (!resultEl) return;
    var hasWrapper = typeof window.voDesktop === 'object'
      && window.voDesktop !== null
      && typeof window.voDesktop.revealPath === 'function';
    // Reveal slots. Each slot is a span emitted next to the
    // corresponding summary-value. We validate the path at PAINT
    // time against live currentVaultData.state.vault_root and
    // the same composer the click handler uses — an untrusted
    // path (absolute, traversing, wrong prefix, or unavailable
    // vault root) never gets promoted into a dead button. The
    // click handler keeps its own recheck as defense in depth
    // for render/click state drift.
    var revealSlots = resultEl.querySelectorAll('[data-harvest-local-reveal]');
    var paintState = (currentVaultData && currentVaultData.state) || null;
    var paintVaultRoot = (paintState && typeof paintState.vault_root === 'string' && paintState.status_kind === 'ready')
      ? paintState.vault_root
      : '';
    for (var i = 0; i < revealSlots.length; i++) {
      var slot = revealSlots[i];
      if (slot.__voHarvestRevealPopulated) continue;
      slot.__voHarvestRevealPopulated = true;
      if (!hasWrapper) continue;
      var kind = slot.getAttribute('data-harvest-local-reveal') || '';
      var relPath = slot.getAttribute('data-harvest-local-path') || '';
      if (!relPath) continue;
      // Paint-time validation: refuse untrusted paths up front
      // so browser-mode and drifted-state operators never see a
      // button that can only fail at click time. If vault_root
      // is not yet ready, also skip — the button would just hit
      // "Vault is not ready" at click time, which is a dead
      // control per the PR contract.
      if (!paintVaultRoot) continue;
      var paintComposed = composeVaultArtifactPath(paintVaultRoot, relPath);
      if (!paintComposed.ok) continue;
      var label = 'Reveal';
      if (kind === 'dossier') label = 'Reveal dossier';
      else if (kind === 'draft') label = 'Reveal draft';
      else if (kind === 'capture') label = 'Reveal capture';
      else if (kind === 'preserved-dossier') label = 'Reveal preserved dossier';
      else if (kind === 'conflict-file') label = 'Reveal conflict file';
      slot.innerHTML = '<button type="button" class="btn-xs btn-ghost harvest-reveal-btn" '
        + 'data-harvest-local-action="reveal" '
        + 'data-harvest-local-kind="' + esc(kind) + '" '
        + 'data-harvest-local-path="' + esc(relPath) + '" '
        + 'style="margin-left:.4rem">' + esc(label) + '</button>'
        + '<span class="harvest-reveal-status status-dim" '
        + 'data-harvest-reveal-status="1" '
        + 'style="margin-left:.4rem"></span>';
    }
    // Open-obsidian handoff slots — success + finalize-conflict
    // only (the presenter emits them there). Gated on hasWrapper
    // AND the shared truthful gate (ready + canWrite +
    // obsidian_open_supported + obsidian_installed). The click
    // delegate re-checks the gate at dispatch time.
    var handoffSlots = resultEl.querySelectorAll('[data-harvest-local-handoff="open-obsidian"]');
    for (var j = 0; j < handoffSlots.length; j++) {
      var hoSlot = handoffSlots[j];
      if (hoSlot.__voHarvestHandoffPopulated) continue;
      hoSlot.__voHarvestHandoffPopulated = true;
      if (!hasWrapper) continue;
      var state = (currentVaultData && currentVaultData.state) || {};
      var auth = (currentVaultData && currentVaultData._auth) || {};
      var canWrite = auth.can_write === true;
      if (!shouldRenderObsidianQuickAction(state, canWrite)) continue;
      hoSlot.innerHTML =
        '<span class="status-dim harvest-local-handoff-label" style="margin-right:.4rem">Next step</span>'
        + '<button type="button" class="btn-xs btn-ghost harvest-local-handoff-btn" '
        + 'data-harvest-local-action="open-obsidian">'
        + 'Open current vault in Obsidian'
        + '</button>'
        + '<span class="harvest-local-handoff-status status-dim" '
        + 'data-harvest-local-handoff-status="1" '
        + 'style="margin-left:.4rem"></span>';
    }
  }

  // Vault-tab state snapshot — the Home overview uses currentData for
  // itself, so the Vault tab keeps its own handle. Anything that needs
  // the current vault_root AFTER a Vault render (harvest-result cache,
  // desktop native reveal intercept) reads from here — reading
  // currentData would either be null (first-visit Vault with no prior
  // Home load) or stale Home payload (which doesn't carry state.vault_root).
  var currentVaultData = null;
  // VO-DESKTOP-WRAPPER-LINKED-SOURCES-OBSIDIAN-HANDOFF-PR-1 —
  // Shared freshness counter for fetchVault + fetchVaultHistory.
  // Every fetch of either endpoint bumps the counter; each async
  // resolution captures the counter at dispatch time and drops
  // silently if the counter has moved.
  //
  // Primary hazard this prevents: the Linked Sources Obsidian
  // handoff reads live currentVaultData to decide render vs
  // empty, while renderVaultHistory(d) paints a history
  // response snapshot into the same card. Without this
  // invalidation, an older history response can arrive AFTER
  // currentVaultData has advanced to a new vault state,
  // producing mixed snapshots (e.g. the non-ready history
  // message paired with a ready handoff button). Bumping on
  // fetchVault also drops an in-flight history response that
  // was dispatched under the older vault state — renderVault()
  // itself re-triggers fetchVaultHistory(), so nothing is
  // lost.
  //
  // Secondary benefit: rapid consecutive fetchVault() calls
  // (tab-switch / retry) stop clobbering each other's paint.
  var vaultReadGeneration = 0;

  function fetchVault() {
    vaultReadGeneration += 1;
    var myGen = vaultReadGeneration;
    fetch(dashUrl('/dashboard/vault'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (myGen !== vaultReadGeneration) return;
        currentVaultData = data;
        renderVault(data);
      })
      .catch(function(err) {
        // Drop stale failures so an older vault read that
        // rejects AFTER a newer fetch has already painted
        // fresher state can't overwrite the tab with a
        // retroactive "Failed to load vault" message.
        if (myGen !== vaultReadGeneration) return;
        content.innerHTML = '<div class="state-msg">Failed to load vault: ' + esc(err.message) + '</div>';
      });
  }

  function renderVault(d) {
    var canWrite = d._auth && d._auth.can_write;
    var state = d.state || {};

    // VO-LOCAL-DASHBOARD-HARVEST-PR-1B — snapshot the operator's
    // in-progress typing BEFORE we blow away the DOM below. The
    // harvestSubmit success path schedules fetchVault() 500ms
    // after an outcome; during that window the operator may
    // already be typing the NEXT source into
    // #vault-harvest-source. content.innerHTML = html destroys
    // that element, so the fresh one is always empty — which
    // means a simple "is the field empty?" guard cannot
    // distinguish "not typed yet" from "was typed, just got
    // replaced." We capture the live value here, THEN let the
    // DOM replacement happen, THEN use the captured value to
    // decide whether the cached source should be written back.
    // If the operator had typed anything (and it differs from
    // the cached source, i.e. they are starting fresh rather
    // than sitting on the same retry input), we skip the
    // restore entirely and rewrite what they were typing into
    // the freshly-rendered field.
    var prevHarvestSrcEl = document.getElementById('vault-harvest-source');
    var priorTypedSource = prevHarvestSrcEl && typeof prevHarvestSrcEl.value === 'string'
      ? prevHarvestSrcEl.value
      : '';

    // Full-rhythm header — settings/control-oriented page.
    var html = '<div class="rhythm-full">' +
      '<div class="page-kicker">Local companion layer</div>' +
      '<div class="page-title-row"><h1>Vault ' +
      '<span class="auth-badge" data-state="local-authoritative">' +
        '<span class="auth-icon" aria-hidden="true">&#9679;</span>' +
        '<span class="auth-label">Local authoritative</span></span>' +
      '</h1></div>' +
      '<p class="page-lead">Local markdown companion layer for readable dossiers and notes. Vault stays local. Obsidian is optional.</p>' +
      '</div>';

    // Three-axis summary card. NEVER collapse these into one badge.
    //
    // VO-DESKTOP-WRAPPER-PLUGIN-CONTROLS-RECOVERY-PR-1 — id +
    // tabindex="-1" so the plugin-controls card's recovery
    // affordances can anchor-jump here for blocked-state recovery
    // (unavailable_no_vault, tenant/root mismatch). The
    // tabindex="-1" keeps the card out of the natural Tab
    // sequence but lets programmatic focus() land, consistent
    // with the plugin-controls card's own quick-action target.
    html += '<div class="card card-dither" id="vault-summary-card" tabindex="-1"><div class="card-title">Vault Summary</div>';

    // Axis 1 — feature intent (vault_enabled)
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Feature intent</span>';
    html += '<span class="structure-meta">' + (state.vault_enabled ? 'Vault enabled' : 'Vault disabled') + '</span>';
    html += '</div>';

    // Axis 2 — root / binding (vault_root + source)
    var rootLabel;
    if (state.vault_root) {
      rootLabel = state.vault_root + ' (' + esc(state.vault_root_source || 'config') + ')';
    } else {
      rootLabel = 'no vault path registered';
    }
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Root / binding</span>';
    html += '<span class="structure-meta">' + esc(rootLabel) + '</span>';
    html += '</div>';

    // Axis 3 — Obsidian companion (independent of intent + root)
    var obsLabel;
    if (state.obsidian_installed === null) {
      obsLabel = 'detection unsupported on this platform';
    } else if (state.obsidian_installed === true) {
      obsLabel = 'Obsidian installed';
    } else {
      obsLabel = 'Obsidian not installed';
    }
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Obsidian companion</span>';
    html += '<span class="structure-meta">' + esc(obsLabel) + '</span>';
    html += '</div>';

    // vault_sync is read-only context — lives in Settings, not here.
    html += '<div class="structure-row">';
    html += '<span class="structure-label">vault_sync (Settings)</span>';
    html += '<span class="structure-meta">' + esc(String(state.vault_sync || 'off')) + ' &middot; read-only here</span>';
    html += '</div>';

    html += '</div>';

    // Per-status state + actions card.
    html += '<div class="card"><div class="card-title">Status</div>';
    var kind = state.status_kind;

    if (kind === 'disabled_ready') {
      html += '<p class="vault-copy">Vault is disabled for this tenant. Existing vault files, if any, are untouched.</p>';
      if (state.vault_root) {
        html += '<div class="summary-row"><span class="summary-label">Current path</span><span class="summary-value">' + esc(state.vault_root) + '</span></div>';
      }
      if (canWrite) {
        html += '<div class="vault-actions"><button class="btn-sm btn-primary" data-vault-action="enable">Enable Vault</button></div>';
      }
    } else if (kind === 'no_tenant') {
      html += '<p class="vault-copy">Connect or select a tenant to see the default vault path.</p>';
      if (canWrite) {
        html += '<div class="vault-actions">';
        html += '<input class="input-sm" id="vault-root-input" type="text" placeholder="/absolute/path/to/vault" style="min-width:280px">';
        html += '<button class="btn-sm btn-primary" data-vault-action="set-root">Set vault path</button>';
        html += '<button class="btn-sm btn-primary vault-native-picker" data-vault-action="pick-folder" style="display:none">Choose folder&hellip;</button>';
        html += '</div>';
      }
    } else if (kind === 'init_required') {
      html += '<p class="vault-copy">Default vault path is ready to initialize for this tenant.</p>';
      if (state.vault_root) {
        html += '<div class="summary-row"><span class="summary-label">Current path</span><span class="summary-value">' + esc(state.vault_root) + '</span></div>';
      }
      if (canWrite) {
        html += '<div class="vault-actions">';
        html += '<button class="btn-sm btn-primary" data-vault-action="init">Initialize vault</button>';
        html += '<input class="input-sm" id="vault-root-input" type="text" placeholder="/absolute/path/to/vault" style="min-width:280px">';
        html += '<button class="btn-sm btn-ghost" data-vault-action="set-root">Change vault path</button>';
        html += '<button class="btn-sm btn-primary vault-native-picker" data-vault-action="pick-folder" style="display:none">Choose folder&hellip;</button>';
        if (state.vault_root) {
          html += '<button class="btn-sm btn-ghost vault-open-btn" data-vault-action="open" data-server-open="0" style="display:none">Reveal current path</button>';
        }
        html += '</div>';
      }
    } else if (kind === 'env_override_invalid' || kind === 'unreadable') {
      html += '<p class="vault-copy vault-err">' + esc(state.discovery_error || 'Vault root is invalid.') + '</p>';
      // VO-DESKTOP-WRAPPER-RECOVERY-AFFORDANCES-PR-1 — show the
      // path that is currently invalid so the operator can see
      // what they need to change. Existing copy just named the
      // discovery_error without ever disclosing which path
      // triggered it.
      if (state.vault_root) {
        html += '<div class="summary-row"><span class="summary-label">Current path</span><span class="summary-value">' + esc(state.vault_root) + '</span></div>';
      }
      if (canWrite) {
        html += '<div class="vault-actions">';
        html += '<input class="input-sm" id="vault-root-input" type="text" placeholder="/absolute/path/to/vault" style="min-width:280px">';
        html += '<button class="btn-sm btn-ghost" data-vault-action="set-root">Change vault path</button>';
        html += '<button class="btn-sm btn-ghost vault-native-picker" data-vault-action="pick-folder" style="display:none">Choose folder&hellip;</button>';
        // VO-DESKTOP-WRAPPER-RECOVERY-AFFORDANCES-PR-1 — Reveal
        // the current (invalid) path via the existing wrapper
        // bridge. Helps the operator diagnose WHY the path is
        // invalid (wrong directory, missing, permissions).
        // data-server-open="0" means: no valid server-side
        // fallback for this state — the button is shown only
        // when the wrapper is present, per the existing
        // .vault-open-btn visibility rule in the setup JS
        // below. Browser-mode: button stays hidden (no dead
        // control). Click path reuses vaultAction('open'),
        // which already calls window.voDesktop.revealPath
        // against currentVaultData.state.vault_root at click
        // time — no baked data-attribute, so a tenant-switch-
        // triggered fetchVault replaces currentVaultData before
        // the click can target the wrong path.
        if (state.vault_root) {
          html += '<button class="btn-sm btn-ghost vault-open-btn" data-vault-action="open" data-server-open="0" style="display:none">Reveal current path</button>';
        }
        html += '</div>';
      }
    } else if (kind === 'tenant_mismatch') {
      html += '<p class="vault-copy vault-err">' + esc(state.discovery_error || 'Vault at this path is bound to a different tenant.') + '</p>';
      html += '<p class="vault-note">Rebind or force-adopt of another tenant&#39;s vault is not supported. Change the path to a different directory or clear it.</p>';
      if (state.vault_root) {
        // The path itself is THIS tenant's configured vault_root
        // (the operator chose it); only the binding MARKER
        // inside belongs to another tenant, and that marker's
        // content is never exposed here. Displaying the path
        // is not a cross-tenant leak.
        html += '<div class="summary-row"><span class="summary-label">Current path</span><span class="summary-value">' + esc(state.vault_root) + '</span></div>';
      }
      if (canWrite) {
        html += '<div class="vault-actions">';
        html += '<input class="input-sm" id="vault-root-input" type="text" placeholder="/absolute/path/to/vault" style="min-width:280px">';
        html += '<button class="btn-sm btn-primary" data-vault-action="set-root">Change vault path</button>';
        html += '<button class="btn-sm btn-primary vault-native-picker" data-vault-action="pick-folder" style="display:none">Choose folder&hellip;</button>';
        // Reveal path so the operator can look at the
        // conflicting directory. Wrapper-only (see
        // invalid_root). Safe: the reveal target is the
        // operator's own configured path, not cross-tenant
        // data; revealPath just shows the folder in
        // Finder/Explorer, not any tenant marker content.
        if (state.vault_root) {
          html += '<button class="btn-sm btn-ghost vault-open-btn" data-vault-action="open" data-server-open="0" style="display:none">Reveal current path</button>';
        }
        html += '</div>';
      }
    } else if (kind === 'ready') {
      html += '<p class="vault-copy">Vault ready.</p>';
      html += '<div class="summary-row"><span class="summary-label">Dossiers</span>';
      html += '<span class="summary-value">' + (state.dossier_count !== null && state.dossier_count !== undefined ? state.dossier_count : '&mdash;') + '</span></div>';
      html += '<div class="summary-row"><span class="summary-label">Last generated</span>';
      html += '<span class="summary-value">' + esc(state.last_generated_at || '—') + '</span></div>';
      if (canWrite) {
        html += '<div class="vault-actions">';
        // Open vault button is rendered unconditionally with visibility
        // decided at runtime. Two independent enablement paths:
        //   (a) server-side: state.open_root_supported is macOS-only
        //       today (uses the open(1) shell binary);
        //   (b) wrapper: Electron shell.showItemInFolder via the
        //       revealPath bridge works on every Electron platform.
        // Setup JS reveals the button when either is available.
        // Marking it display:none by default keeps non-macOS browser
        // users from seeing a dead button. The unsupported-platform
        // note below is gated the same way.
        html += '<button class="btn-sm btn-primary vault-open-btn" data-vault-action="open" style="display:none" data-server-open="' + (state.open_root_supported ? '1' : '0') + '">Open vault</button>';
        if (state.obsidian_open_supported && state.obsidian_installed === true) {
          html += '<button class="btn-sm btn-ghost" data-vault-action="open-obsidian">Open in Obsidian</button>';
        }
        html += '<input class="input-sm" id="vault-root-input" type="text" placeholder="change path (optional)" style="min-width:240px">';
        html += '<button class="btn-sm btn-ghost" data-vault-action="set-root">Change vault path</button>';
        html += '<button class="btn-sm btn-ghost vault-native-picker" data-vault-action="pick-folder" style="display:none">Choose folder&hellip;</button>';
        html += '<button class="btn-sm btn-ghost" data-vault-action="disable">Disable Vault</button>';
        html += '</div>';
        // Honest note shown only when neither path is available.
        // Runtime-gated via .vault-open-note (setup JS hides it the
        // moment anyOpenable becomes true).
        html += '<p class="vault-copy vault-open-note" style="display:' + (state.open_root_supported ? 'none' : 'block') + '">Open-in-app actions are not supported on this platform yet. Use the desktop app to enable them.</p>';
      }
    } else {
      html += '<p class="vault-copy">Unknown vault status.</p>';
    }
    html += '<div id="vault-status" class="status-msg"></div>';
    html += '</div>';

    // VO-LOCAL-DASHBOARD-HARVEST-PR-1 — harvest control + result region.
    //
    // Deliberately a separate card with its own submit handler. The
    // generic vaultAction() handler above flattens toggles into a
    // one-line ✓/✗ toast — the AutoOutcome taxonomy from
    // runVaultHarvestAuto has five distinct stop kinds plus success,
    // so harvest gets its own dedicated result region
    // (#vault-harvest-result) and its own submit function
    // (harvestSubmit) that drops server-rendered HTML into the
    // region without losing the structured distinctions.
    if (canWrite && kind === 'ready') {
      html += '<div class="card card-dither" id="vault-harvest-card"><div class="card-title">Harvest a source</div>';
      html += '<p class="vault-copy">Capture a local file or URL into this vault. Runs locally on this machine — local vault stays authoritative.</p>';
      html += '<div class="vault-actions" style="flex-wrap:wrap">';
      html += '<input class="input-sm" id="vault-harvest-source" type="text" placeholder="/absolute/path/to/source.md  or  https://example.com/article" style="min-width:360px;flex:1">';
      html += '<button class="btn-sm btn-primary" id="vault-harvest-submit">Harvest</button>';
      html += '</div>';
      // VO-LOCAL-DASHBOARD-HARVEST-PR-1A — drag-and-drop hint.
      // The affordance is the existing harvest card itself; drop-zone
      // listeners are attached to #vault-harvest-card in the ready-
      // state setup block below. Copy stays local-first + honest:
      // text/URL drops populate #vault-harvest-source and reuse
      // harvestSubmit(); local files without a usable absolute path
      // surface an honest error in #vault-harvest-result rather than
      // inventing a hidden bridge round-trip.
      html += '<p class="vault-copy vault-copy-dim" id="vault-harvest-drop-hint" style="margin-top:.4rem">Tip: drop a URL or a path-bearing text selection onto this card to pre-fill the field and harvest. Dropped binary files are not supported here — paste an absolute path instead.</p>';
      // VO-LOCAL-DASHBOARD-HARVEST-LOG-REVEAL-PR-1 +
      // VO-LOCAL-DASHBOARD-HARVEST-INDEX-REVEAL-PR-1 — card-level
      // managed-file reveal row. Empty static slot; the client
      // populator fills it with Reveal log.md + Reveal index.md
      // buttons ONLY in wrapper mode (so browser-mode harvest
      // cards see no dead controls). Clicks route through the
      // EXISTING window.voDesktop.revealPath bridge via the
      // existing #vault-harvest-card delegate; absolute paths
      // are composed at click time from live vault_root, never
      // baked into the static HTML.
      html += '<div class="harvest-managed-files-row" id="vault-harvest-log-reveal" style="margin-top:.4rem"></div>';
      html += '<div id="vault-harvest-pending" class="status-msg" style="display:none"></div>';
      html += '<div id="vault-harvest-result"></div>';
      html += '</div>';
    } else if (canWrite && kind !== 'ready') {
      html += '<div class="card"><div class="card-title">Harvest</div><p class="vault-copy">Harvest is available once the vault is <strong>ready</strong>. Finish the status steps above first.</p></div>';
    }

    // VO-LINKED-SOURCES-HISTORY-PR-1 — Linked Sources (history).
    //
    // The card itself is always rendered. The body is populated
    // asynchronously by fetchVaultHistory() below so non-ready vaults
    // and empty vaults each get their own honest copy. The filter
    // input is hidden until rows are actually loaded.
    html += '<div class="card" id="vault-history-card">';
    html += '<div class="card-title">Linked Sources</div>';
    html += '<p class="vault-copy">Finalized dossiers on this machine and whether each is backed by VO memory nodes. Local vault is authoritative.</p>';
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-OBSIDIAN-HANDOFF-PR-1 —
    // card-level Obsidian handoff slot. Rendered between the
    // lead copy and the filter row so it reads as a next-step
    // affordance, not another filter control. Empty by default;
    // populated in wrapper mode by renderVaultHistory() only
    // when the shared truthful gate (ready + canWrite +
    // obsidian_open_supported + obsidian_installed) is
    // satisfied. Browser mode leaves this empty — no dead
    // handoff. This is a CARD-level action (open-obsidian opens
    // the vault, not a specific dossier), so row-level actions
    // remain narrow: reveal-dossier + source URL link.
    html += '<div class="history-handoff-row" id="vault-history-handoff"></div>';
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-STATUS-REFRESH-PR-1 —
    // card-level manual refresh affordance. Always visible (the
    // history GET route works in both wrapper and browser mode,
    // so no wrapper gate here). Click is routed through the
    // existing #vault-history-card delegate and calls the
    // existing fetchVaultHistory() — no new route, no new bridge
    // call, no duplicated fetch logic. Pending/error state is
    // painted into the sibling status span so failures stay
    // local to the Linked Sources card.
    html += '<div class="history-card-actions" id="vault-history-actions" style="margin-top:.3rem;margin-bottom:.3rem">';
    html += '<button type="button" class="btn-xs btn-ghost history-refresh-btn" '
      + 'data-history-action="refresh" '
      + 'title="Recheck linked sources">Refresh</button>';
    html += '<span class="history-refresh-status status-dim" '
      + 'data-history-refresh-status="1" '
      + 'style="margin-left:.5rem"></span>';
    html += '</div>';
    html += '<div class="vault-actions" id="vault-history-filter-row" style="display:none">';
    html += '<input class="input-sm" id="vault-history-filter" type="text" placeholder="Filter by title, hash, URL, or capture path" style="min-width:320px;flex:1">';
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-COUNT-CLICK-CLEAR-PR-1 —
    // single count/clear slot. applyVaultHistoryFilter paints
    // either passive count text (empty query) or a clickable
    // count/clear control (active query). The previous separate
    // #vault-history-filter-clear button was removed so the
    // shell exposes one canonical recovery path instead of two
    // parallel controls.
    html += '<span class="status-dim" id="vault-history-filter-count" style="margin-left:.6rem"></span>';
    html += '</div>';
    html += '<div id="vault-history-body"><div class="status-dim">Loading history&hellip;</div></div>';
    html += '</div>';

    // VO-LOCAL-DASHBOARD-LOCAL-INTEGRATION-STATUS-PR-1 — overview card.
    //
    // A read-only, three-pane summary of the local integration
    // stack: is Obsidian installed? is the VO Review plugin
    // installed and current in this machine's configured vault? is
    // Verity One itself current? Renders above the actionable
    // plugin-controls card so the tenant sees "health at a glance"
    // first, then reaches for the plugin-specific controls below
    // if they want to act on what the overview reports.
    //
    // DELIBERATELY isolated from the plugin card's state machine
    // (pluginActionInFlight / lastPluginStatus /
    // pluginReadGeneration stay plugin-card-specific). This panel
    // is strictly read-only — it does NOT inherit action
    // suppression, tenant-context gating, or stale-session
    // placeholder recovery. Those mechanisms exist to protect
    // vault-root-mutating plugin actions, and have no meaning for
    // app-level status reads.
    html += '<div class="card" id="vault-integration-status-card">';
    html += '<div class="card-title">Local integrations</div>';
    html += '<p class="vault-copy">Status of the local apps and plugins this workstation uses with Verity One. Read-only — nothing is written.</p>';
    html += '<div class="integration-status-grid">';
    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
    // each block has a header row carrying the title PLUS a small
    // refresh slot. The slot stays EMPTY in browser mode (no dead
    // control) and is populated in wrapper mode by
    // renderLocalIntegrationStatus(). The button itself dispatches
    // ONLY that block's matching existing read seam via the
    // delegated click handler on #vault-integration-status-card;
    // no new preload method, no new ipcMain.handle, no new route.
    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-QUICK-ACTIONS-PR-1 —
    // Obsidian and plugin blocks carry a quick-action slot BELOW
    // the body. The Obsidian slot is conditionally populated by
    // renderLocalIntegrationStatus() only when the truthful gate
    // (ready + canWrite + obsidian_open_supported + obsidian_
    // installed) is satisfied. The plugin slot is populated
    // whenever the wrapper is present (plugin-controls card is
    // always rendered below, so the quick-jump is always valid).
    // The VO app block has NO quick-action slot — by design: no
    // updater / installer / release-page action belongs here. The
    // structural absence makes that property enforceable at
    // test/grep time, not just at review time.
    html += '<div class="integration-block" id="integration-obsidian-app">';
    html += '<div class="integration-block-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem">';
    html += '<div class="integration-block-title">Obsidian app</div>';
    html += '<span class="integration-block-refresh-slot" id="integration-obsidian-app-refresh"></span>';
    html += '</div>';
    html += '<div id="integration-obsidian-app-body"><div class="status-dim">Loading&hellip;</div></div>';
    html += '<div class="integration-block-quick-actions" id="integration-obsidian-app-quick-actions"></div>';
    html += '</div>';
    html += '<div class="integration-block" id="integration-vo-plugin">';
    html += '<div class="integration-block-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem">';
    html += '<div class="integration-block-title">VO Review plugin</div>';
    html += '<span class="integration-block-refresh-slot" id="integration-vo-plugin-refresh"></span>';
    html += '</div>';
    html += '<div id="integration-vo-plugin-body"><div class="status-dim">Loading&hellip;</div></div>';
    html += '<div class="integration-block-quick-actions" id="integration-vo-plugin-quick-actions"></div>';
    html += '</div>';
    html += '<div class="integration-block" id="integration-vo-app">';
    html += '<div class="integration-block-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem">';
    html += '<div class="integration-block-title">Verity One app</div>';
    html += '<span class="integration-block-refresh-slot" id="integration-vo-app-refresh"></span>';
    html += '</div>';
    html += '<div id="integration-vo-app-body"><div class="status-dim">Loading&hellip;</div></div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // VO-LOCAL-DASHBOARD-OBSIDIAN-PLUGIN-CONTROLS-PR-1 — plugin lifecycle card.
    //
    // Rendered UNCONDITIONALLY regardless of canWrite / status_kind /
    // obsidian_installed. The renderer keys visibility purely off
    // window.voDesktop presence (the desktop bridge) plus the returned
    // PluginStatus. Reasons:
    //
    //   - plugin lifecycle is desktop-owned; operator token has no
    //     say over local filesystem actions
    //   - obsidian_installed is about the APP, not the plugin — a
    //     tenant may want to install the plugin into a vault before
    //     first opening Obsidian
    //   - keying on status_kind === "ready" would hide the honest
    //     unavailable_no_vault plugin kind, which is the exact
    //     state that helps the tenant see WHY the plugin can't be
    //     installed yet
    //
    // The body is populated by renderPluginControls() after the
    // shell HTML is injected; initial state is "Loading…" so the
    // card never flashes empty in the browser.
    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-QUICK-ACTIONS-PR-1 —
    // tabindex="-1" makes the card programmatically focusable so
    // the plugin-controls quick action in the Local integrations
    // card can actually move keyboard focus here (a plain <div>
    // ignores focus() calls). -1 keeps the card OUT of the
    // natural Tab sequence — it takes focus only when we call
    // focus() explicitly. Pair with {preventScroll:true} at the
    // callsite so the browser-native href="#id" scroll still
    // runs unopposed.
    html += '<div class="card" id="vault-plugin-controls-card" tabindex="-1">';
    html += '<div class="card-title">VO Review plugin</div>';
    html += '<p class="vault-copy">Install, update, or remove the bundled VO Review Obsidian plugin in this vault. Controlled by the desktop app only &mdash; the local dashboard reads status and dispatches actions through the native bridge.</p>';
    html += '<div id="vault-plugin-controls-body"><div class="status-dim">Loading plugin status&hellip;</div></div>';
    html += '</div>';

    if (!canWrite) {
      html += '<div class="card"><div class="empty">Read-only mode. Operator token required for Vault actions.</div></div>';
    }

    content.innerHTML = html;

    // Restore the last harvest result (if any) so the post-harvest
    // state refresh does not wipe the operator's guidance card — but
    // only when BOTH the tenant AND the vault_root match the identity
    // the cache was rendered against. Prior tenants' vault paths and
    // recovery commands must never surface in another tenant's UI.
    //
    // VO-LOCAL-DASHBOARD-HARVEST-PR-1B — also restore the last
    // attempted source into #vault-harvest-source so the retry
    // affordance emitted by the presenter for retryable stop kinds
    // has something to resubmit. Identity-gated by the same
    // tenant+root pair; source lives in the cache and is cleared
    // on clearLastHarvestResult(), so clearToken() / tenant switch
    // / new-submit-start paths all already wipe it.
    if (canWrite && kind === 'ready' && lastHarvestResult
        && lastHarvestResult.tenant === (getTenantId() || '')
        && lastHarvestResult.root === (state.vault_root || '')) {
      var restoredResult = document.getElementById('vault-harvest-result');
      if (restoredResult) {
        restoredResult.innerHTML = lastHarvestResult.html;
        // VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
        // rerender path: repopulate local-action slots so the
        // Reveal/Open-Obsidian affordances survive tab switches
        // and the 500ms post-submit fetchVault rerender.
        populateHarvestLocalActions();
      }
      // Decide what to put in the freshly-rendered
      // #vault-harvest-source based on the PRE-rerender snapshot
      // taken at the top of renderVault:
      //
      //   - if the operator was typing a NEW source (non-empty
      //     snapshot, different from the cached source), they're
      //     starting the next harvest — write their typed value
      //     back into the field so the 500ms rerender doesn't
      //     eat it. Leave the cached source alone; the retry
      //     affordance will still resubmit whatever is in the
      //     field when clicked (now their new input).
      //   - if the snapshot matches the cached source, the
      //     operator had not typed anything new — restore the
      //     cached source so retry has something to resubmit.
      //   - if the snapshot is empty, same restore (fresh
      //     field, cached source goes back in).
      var restoredSrc = document.getElementById('vault-harvest-source');
      if (restoredSrc && typeof lastHarvestResult.source === 'string') {
        var typedTrim = priorTypedSource.trim();
        var cachedTrim = lastHarvestResult.source.trim();
        if (typedTrim && typedTrim !== cachedTrim) {
          restoredSrc.value = priorTypedSource;
        } else if (lastHarvestResult.source) {
          restoredSrc.value = lastHarvestResult.source;
        }
      }
    } else if (canWrite && kind === 'ready' && priorTypedSource) {
      // No cached harvest (fresh field rerender, no retry
      // context) but the operator was typing — carry their
      // in-progress input across the rerender so a plugin-
      // status refresh / tab switch / other fetchVault trigger
      // cannot silently eat it.
      var freshSrcEl = document.getElementById('vault-harvest-source');
      if (freshSrcEl) freshSrcEl.value = priorTypedSource;
    }

    if (canWrite) {
      var actionBtns = document.querySelectorAll('[data-vault-action]');
      for (var i = 0; i < actionBtns.length; i++) {
        actionBtns[i].addEventListener('click', function() {
          vaultAction(this.getAttribute('data-vault-action'));
        });
      }
      var harvestBtn = document.getElementById('vault-harvest-submit');
      if (harvestBtn) {
        harvestBtn.addEventListener('click', function() { harvestSubmit(); });
      }
      // VO-LOCAL-DASHBOARD-HARVEST-LOG-REVEAL-PR-1 — populate
      // the card-level Reveal log.md slot. Runs on every
      // renderVault() canWrite+ready rerender; the populator's
      // idempotency flag prevents double-population inside the
      // same card instance (re-entry via 500ms post-submit
      // refresh is handled by the fresh DOM each renderVault
      // produces).
      populateHarvestLogReveal();
      // VO-LOCAL-DASHBOARD-HARVEST-PR-1B — retry/resume delegation.
      //
      // The presenter emits retry buttons tagged with
      // data-harvest-retry="<kind>" inside retryable stop cards.
      // The result region's innerHTML is replaced on every submit
      // AND on every renderVault() rerender (this setup block
      // runs again), so a direct listener on each button would
      // either miss freshly-painted ones or pile up duplicates.
      // Delegate off the card itself — one listener, read
      // data-harvest-retry from the clicked descendant, and route
      // back through the existing harvestSubmit() path. Same
      // #vault-harvest-source that the ready-state restore above
      // already repopulated from lastHarvestResult.source.
      var harvestCardForRetry = document.getElementById('vault-harvest-card');
      if (harvestCardForRetry) {
        harvestCardForRetry.addEventListener('click', function(ev) {
          var target = ev.target;
          // VO-LOCAL-DASHBOARD-HARVEST-LOG-REVEAL-PR-1 +
          // VO-LOCAL-DASHBOARD-HARVEST-INDEX-REVEAL-PR-1 —
          // card-level managed-file reveal branch. Checked FIRST
          // so these clicks never fall through to the result-
          // local-action or retry branches. Uses a single
          // namespace (data-harvest-log-action) with two values
          // (reveal-log | reveal-index) so the two managed-file
          // reveals share one delegate arm and one shared status
          // span. Composes the absolute path at click time
          // against LIVE currentVaultData; refuses honestly on
          // wrapper absence / non-ready / empty vault_root /
          // disallowed filename without throwing.
          var logEl = target && typeof target.closest === 'function'
            ? target.closest('[data-harvest-log-action]')
            : null;
          if (logEl && harvestCardForRetry.contains(logEl)) {
            ev.preventDefault();
            ev.stopPropagation();
            var logAction = logEl.getAttribute('data-harvest-log-action') || '';
            // Map action → filename (allowlist enforced a second
            // time in composeVaultRootFilePath as defense in
            // depth).
            var managedFilename = '';
            if (logAction === 'reveal-log') managedFilename = 'log.md';
            else if (logAction === 'reveal-index') managedFilename = 'index.md';
            else if (logAction === 'reveal-manifest') managedFilename = 'captures/.manifest.jsonl';
            var logStatusEl = logEl.parentNode
              ? logEl.parentNode.querySelector('[data-harvest-log-reveal-status]')
              : null;
            function setLogStatus(html) {
              if (logStatusEl) logStatusEl.innerHTML = html;
            }
            setLogStatus('');
            if (!managedFilename) {
              setLogStatus('<span class="status-err">Unknown managed-file action.</span>');
              return;
            }
            if (typeof window.voDesktop !== 'object' || !window.voDesktop
                || typeof window.voDesktop.revealPath !== 'function') {
              setLogStatus('<span class="status-err">Desktop bridge unavailable.</span>');
              return;
            }
            var logLiveState = (currentVaultData && currentVaultData.state) || null;
            if (!logLiveState || logLiveState.status_kind !== 'ready') {
              setLogStatus('<span class="status-err">Vault is not ready.</span>');
              return;
            }
            var logVaultRoot = logLiveState.vault_root;
            if (typeof logVaultRoot !== 'string' || !logVaultRoot) {
              setLogStatus('<span class="status-err">Vault root unavailable.</span>');
              return;
            }
            var logComposed = composeVaultRootFilePath(logVaultRoot, managedFilename);
            if (!logComposed.ok) {
              setLogStatus('<span class="status-err">Refused: ' + esc(logComposed.reason) + '</span>');
              return;
            }
            window.voDesktop.revealPath(logComposed.path).then(function(r) {
              var res = r || {};
              if (res.ok) {
                setLogStatus('<span class="status-ok">&#10003; revealed</span>');
              } else {
                setLogStatus('<span class="status-err">' + esc(res.reason || 'reveal refused') + '</span>');
              }
            }).catch(function(err) {
              setLogStatus('<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>');
            });
            return;
          }
          // VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
          // local-action branch for reveal + open-obsidian.
          // Checked FIRST so these clicks never fall through to
          // the retry branch. Uses a separate attribute namespace
          // (data-harvest-local-action) so it cannot collide with
          // data-harvest-retry. Honest refusal on wrapper absence
          // / state drift / unsafe path — no throws.
          var localEl = target && typeof target.closest === 'function'
            ? target.closest('[data-harvest-local-action]')
            : null;
          if (localEl && harvestCardForRetry.contains(localEl)) {
            ev.preventDefault();
            ev.stopPropagation();
            var action = localEl.getAttribute('data-harvest-local-action') || '';
            if (action === 'reveal') {
              var statusEl = localEl.parentNode
                ? localEl.parentNode.querySelector('[data-harvest-reveal-status]')
                : null;
              function setRevealStatus(html) {
                if (statusEl) statusEl.innerHTML = html;
              }
              setRevealStatus('');
              if (typeof window.voDesktop !== 'object' || !window.voDesktop
                  || typeof window.voDesktop.revealPath !== 'function') {
                setRevealStatus('<span class="status-err">Desktop bridge unavailable.</span>');
                return;
              }
              var liveState = (currentVaultData && currentVaultData.state) || null;
              if (!liveState || liveState.status_kind !== 'ready') {
                setRevealStatus('<span class="status-err">Vault is not ready.</span>');
                return;
              }
              var vaultRoot = liveState.vault_root;
              if (typeof vaultRoot !== 'string' || !vaultRoot) {
                setRevealStatus('<span class="status-err">Vault root unavailable.</span>');
                return;
              }
              var relPath = localEl.getAttribute('data-harvest-local-path') || '';
              var composed = composeVaultArtifactPath(vaultRoot, relPath);
              if (!composed.ok) {
                setRevealStatus('<span class="status-err">Refused: ' + esc(composed.reason) + '</span>');
                return;
              }
              window.voDesktop.revealPath(composed.path).then(function(r) {
                var res = r || {};
                if (res.ok) {
                  setRevealStatus('<span class="status-ok">&#10003; revealed</span>');
                } else {
                  setRevealStatus('<span class="status-err">' + esc(res.reason || 'reveal refused') + '</span>');
                }
              }).catch(function(err) {
                setRevealStatus('<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>');
              });
              return;
            }
            if (action === 'open-obsidian') {
              var hoStatusEl = localEl.parentNode
                ? localEl.parentNode.querySelector('[data-harvest-local-handoff-status]')
                : null;
              function setHoStatus(html) {
                if (hoStatusEl) hoStatusEl.innerHTML = html;
              }
              setHoStatus('');
              var hoState = (currentVaultData && currentVaultData.state) || {};
              var hoAuth = (currentVaultData && currentVaultData._auth) || {};
              if (!shouldRenderObsidianQuickAction(hoState, hoAuth.can_write === true)) {
                setHoStatus('<span class="status-err">Handoff unavailable in current state.</span>');
                return;
              }
              vaultAction('open-obsidian');
              return;
            }
            return;
          }
          // Walk up from the event target to the nearest element
          // carrying data-harvest-retry (button text spans are
          // common targets; .closest() handles both).
          var retryEl = target && typeof target.closest === 'function'
            ? target.closest('[data-harvest-retry]')
            : null;
          if (!retryEl) return;
          if (!harvestCardForRetry.contains(retryEl)) return;
          ev.preventDefault();
          ev.stopPropagation();
          // Same seam: harvestSubmit() reads #vault-harvest-source,
          // which the renderVault restore just repopulated from
          // lastHarvestResult.source. No new route, no new submit
          // function, no hidden state.
          harvestSubmit();
        });
      }
      // VO-LOCAL-DASHBOARD-HARVEST-PR-1B — re-sync in-flight UI
      // state. The harvest card + every retry button just came
      // out of the innerHTML replacement fresh and visually
      // enabled, but harvestInFlight may still be true from a
      // request that has not yet settled (tab switch during
      // harvest, fetchVault() during harvest, plugin-status
      // refresh during harvest). Without this reapply the
      // operator sees actionable buttons that silently no-op at
      // the early-return in harvestSubmit(). Reapply the guard
      // AFTER all harvest controls (submit + retries inside the
      // restored result HTML) are wired, so a live request
      // keeps the UI in a coherent disabled state across the
      // rerender.
      setHarvestControlsDisabled(harvestInFlight);
      // VO-LOCAL-DASHBOARD-HARVEST-PR-1A — drag-and-drop intake.
      //
      // Thin enhancement over the existing harvest seam. On drop:
      //   1. try text/uri-list (standard URL drag payload)
      //   2. fall back to text/plain
      //   3. if neither carries a usable string but File objects
      //      are present, render an honest local error in
      //      #vault-harvest-result instead of inventing a hidden
      //      desktop bridge round-trip — browser drag/drop File
      //      objects do not safely expose an absolute filesystem
      //      path, and this PR is explicitly forbidden from
      //      widening the preload / IPC surface.
      //
      // Supported payloads populate #vault-harvest-source then reuse
      // harvestSubmit() so there is exactly ONE submit path, ONE
      // result region, and ONE /dashboard/vault/harvest route.
      var harvestCard = document.getElementById('vault-harvest-card');
      if (harvestCard) {
        var extractDroppedSource = function(dataTransfer) {
          if (!dataTransfer) return '';
          // text/uri-list is the standards-compliant drop type for
          // URLs; browsers also provide text/plain as a shadow.
          // Prefer uri-list so a selected-link drag doesn't lose
          // the URL to some adjacent plain-text preview.
          var uriList = '';
          try { uriList = dataTransfer.getData('text/uri-list') || ''; } catch (e) { uriList = ''; }
          if (uriList) {
            // uri-list format: lines; first non-comment line is the
            // primary URL. Comments start with '#'.
            var lines = uriList.split(/\\r?\\n/);
            for (var li = 0; li < lines.length; li++) {
              var line = lines[li].trim();
              if (line && line.charAt(0) !== '#') return line;
            }
          }
          var plain = '';
          try { plain = dataTransfer.getData('text/plain') || ''; } catch (e) { plain = ''; }
          return plain.trim();
        };
        var setDragOverClass = function(on) {
          if (on) harvestCard.classList.add('vault-harvest-dragover');
          else harvestCard.classList.remove('vault-harvest-dragover');
        };
        harvestCard.addEventListener('dragenter', function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          setDragOverClass(true);
        });
        harvestCard.addEventListener('dragover', function(ev) {
          // dragover MUST call preventDefault for the drop event to
          // fire. Without this the browser rejects the drop at the
          // viewport level and we never see it.
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.dataTransfer) {
            try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* read-only in some browsers */ }
          }
          setDragOverClass(true);
        });
        harvestCard.addEventListener('dragleave', function(ev) {
          // Only clear the highlight when the pointer actually left
          // the card, not when it moved between children. Compare
          // relatedTarget against the card bounds.
          if (ev.relatedTarget && harvestCard.contains(ev.relatedTarget)) return;
          setDragOverClass(false);
        });
        // Classify an extracted drop payload. The harvest engine
        // routes strings as either http(s) URLs or as local-path
        // targets (path.resolve'd when a scheme is not http(s)).
        // That means a file:///... URI dropped from Chromium or
        // Electron would get server-side-resolved as a local path
        // and fail with a misleading "source file not found" —
        // NOT the intended unsupported-file fallback. Classify the
        // payload client-side and route known-bogus URI schemes
        // (file, data, blob, ftp, mailto, …) to the warn branch.
        var classifyDroppedSource = function(source) {
          if (!source) return { kind: 'empty' };
          var trimmed = source.trim();
          if (!trimmed) return { kind: 'empty' };
          // Windows-drive-path carveout. A path like C:\notes\a.md
          // or D:/docs/x.md would otherwise match the URI-scheme
          // regex below (letter + colon) and get misclassified as
          // an unsupported URI — which would block exactly the
          // plain-text path payloads this drop path is supposed to
          // accept. Single-letter RFC 3986 schemes are vanishingly
          // rare in practice and no well-known scheme (http, https,
          // file, data, blob, ftp, mailto, ssh, git, …) is a single
          // letter, so recognizing [A-Za-z]:[\/] as a local-path
          // prefix does not shadow any real URI scheme we would
          // route separately.
          if (/^[a-zA-Z]:[\\\/]/.test(trimmed)) {
            return { kind: 'plain', source: trimmed };
          }
          // Does the string open with a URI scheme (letter,
          // [letter|digit|+|.|-]* ':')? RFC 3986 §3.1.
          var schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
          if (schemeMatch) {
            var scheme = schemeMatch[1].toLowerCase();
            if (scheme === 'http' || scheme === 'https') {
              return { kind: 'http-url', source: trimmed };
            }
            return { kind: 'unsupported-uri', scheme: scheme };
          }
          // No URI scheme — treat as a plain text/path payload.
          // Harvest engine will path.resolve it; user dragged a
          // typed path or a text selection with their own
          // semantics. Let the server surface any failure.
          return { kind: 'plain', source: trimmed };
        };
        var paintHarvestWarn = function(messageHtml) {
          var resultEl = document.getElementById('vault-harvest-result');
          if (resultEl) {
            resultEl.innerHTML = '<div class="alert alert-warn" style="margin-top:.6rem"><span class="alert-icon" aria-hidden="true">!</span><span>' + messageHtml + '</span></div>';
          }
          // An unsupported drop is NOT a success. Drop the cached
          // harvest result in this branch too, otherwise the next
          // renderVault() rerender under the same tenant+root
          // would restore the prior success card on top of this
          // warning — making the state look fresher than it is.
          clearLastHarvestResult();
        };
        harvestCard.addEventListener('drop', function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          setDragOverClass(false);
          var srcEl = document.getElementById('vault-harvest-source');
          var rawSource = extractDroppedSource(ev.dataTransfer);
          var classified = classifyDroppedSource(rawSource);
          if (classified.kind === 'http-url' || classified.kind === 'plain') {
            if (srcEl) srcEl.value = classified.source;
            // Clear any prior outcome card before the new submit so
            // the tenant sees only the fresh result. harvestSubmit()
            // also calls clearLastHarvestResult() internally, but
            // doing it here keeps the identity guard posture
            // consistent for the drop path.
            clearLastHarvestResult();
            harvestSubmit();
            return;
          }
          if (classified.kind === 'unsupported-uri') {
            // file:// / data: / blob: / ftp: / mailto: / etc.
            // These would be path.resolve'd server-side and
            // surface a misleading "source file not found" —
            // reject client-side with an honest hint.
            paintHarvestWarn(
              'Dropped ' + esc(classified.scheme) + ':// URL is not supported here. Drop an http(s) URL, or paste the local absolute path into the field and click Harvest.',
            );
            return;
          }
          // classified.kind === 'empty' — no usable text payload.
          // Surface either a file-specific hint (if File objects
          // were present) or a generic "nothing usable" hint.
          // Browser File drags do not expose an absolute filesystem
          // path the harvest route could consume, and PR-1A
          // deliberately does NOT widen the preload/IPC surface to
          // extract one.
          var files = ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files : null;
          if (files && files.length > 0) {
            paintHarvestWarn(
              'Dropped file (' + esc(files[0].name || 'unnamed') + ') is not supported here. Paste its absolute path into the field and click Harvest.',
            );
          } else {
            paintHarvestWarn(
              'Nothing usable in the drop. Drop a URL or a path-bearing text selection.',
            );
          }
        });
      }
      // VO-DESKTOP-WRAPPER-PR-1 — native picker button is hidden by
      // default and only revealed when running inside the Electron
      // shell (which exposes window.voDesktop via the preload bridge).
      // Browser users never see this button — progressive enhancement
      // only.
      var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
      if (hasWrapper) {
        var pickerBtns = document.querySelectorAll('.vault-native-picker');
        for (var j = 0; j < pickerBtns.length; j++) {
          pickerBtns[j].style.display = 'inline-block';
        }
      }
      // Open vault: two independent enablement paths —
      //   (a) server-side: data-server-open="1" when
      //       state.open_root_supported is true (macOS-only today)
      //   (b) wrapper: revealPath bridge works on every Electron
      //       platform, independent of the server flag
      // Show the button when EITHER is usable; hide the
      // "unsupported platform" note the moment either is usable
      // (it exists only to be honest when both are unavailable).
      var openBtns = document.querySelectorAll('.vault-open-btn');
      var anyOpenable = false;
      for (var k = 0; k < openBtns.length; k++) {
        var btn = openBtns[k];
        var serverOpen = btn.getAttribute('data-server-open') === '1';
        if (serverOpen || hasWrapper) {
          btn.style.display = 'inline-block';
          anyOpenable = true;
        }
      }
      if (anyOpenable) {
        var notes = document.querySelectorAll('.vault-open-note');
        for (var m = 0; m < notes.length; m++) {
          notes[m].style.display = 'none';
        }
      }
    }

    // VO-LINKED-SOURCES-HISTORY-PR-1 — kick off history fetch.
    // Non-ready vaults still call this; the render handles the
    // non-ready body copy honestly rather than faking an empty list.
    fetchVaultHistory();

    // VO-LOCAL-DASHBOARD-OBSIDIAN-PLUGIN-CONTROLS-PR-1 — plugin controls.
    // Deliberately INDEPENDENT of canWrite / kind so that the
    // wrapper-present path is the authoritative gate. See the card
    // HTML block above for the rationale.
    renderPluginControls();

    // VO-LOCAL-DASHBOARD-LOCAL-INTEGRATION-STATUS-PR-1 — overview.
    // Independent of canWrite / kind / obsidian_installed for the
    // same reason: the panel reflects MACHINE-level status, not
    // the current tenant's vault-readiness state. Obsidian app
    // status and VO app status exist and are useful BEFORE any
    // vault is configured.
    renderLocalIntegrationStatus();
  }

  // ── Linked Sources (VO-LINKED-SOURCES-HISTORY-PR-1) ───────────────

  // Holds the most recent rows so the filter can act on them without
  // re-fetching. Reset on every renderVault so tab switches and
  // tenant switches start fresh.
  var currentVaultHistoryRows = null;

  // VO-DESKTOP-WRAPPER-LINKED-SOURCES-STATUS-REFRESH-PR-1 —
  // Card-local pending painter for the manual refresh button.
  // Keeps pending/success copy scoped to the Linked Sources card
  // so failures can't cross-paint Vault Summary, Harvest, Local
  // integrations, or plugin controls. Called in three places:
  //   - from the delegate click handler before fetchVaultHistory
  //   - from the top of renderVaultHistory (success clears it)
  //   - from fetchVaultHistory's .catch (failure also clears the
  //     "Checking…" copy; the body already paints the HTTP error)
  // Passing pending=true disables the button and paints
  // "Checking linked sources…"; pending=false re-enables and
  // clears the status span.
  function setHistoryRefreshPending(pending) {
    var btn = document.getElementById('vault-history-actions');
    var statusEl = null;
    if (btn) {
      var realBtn = btn.querySelector('[data-history-action="refresh"]');
      if (realBtn) realBtn.disabled = !!pending;
      statusEl = btn.querySelector('[data-history-reveal-status], [data-history-refresh-status]');
      // Prefer the refresh-specific anchor if present.
      var refreshStatusEl = btn.querySelector('[data-history-refresh-status]');
      if (refreshStatusEl) statusEl = refreshStatusEl;
    }
    if (statusEl) {
      statusEl.innerHTML = pending
        ? '<span class="status-dim">Checking linked sources&hellip;</span>'
        : '';
    }
  }

  function fetchVaultHistory() {
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-STATUS-REFRESH-PR-1 —
    // wire the card-level delegate BEFORE dispatching the
    // fetch. Previously the delegate was installed inside
    // renderVaultHistory on the success path only, which left
    // the static Refresh button unwired when the INITIAL
    // history fetch failed — the failure path paints "Failed
    // to load history" but never calls renderVaultHistory, so
    // the operator had no way to retry. Installing here runs
    // before either .then() or .catch() fires, so the failure
    // path also has a wired Refresh button.
    //
    // The install is idempotent via __voHistoryRevealDelegate,
    // so multiple fetchVaultHistory() calls on the same card
    // mount do NOT stack listeners.
    ensureHistoryCardDelegate();

    // Bump the shared counter so any older in-flight history
    // response (from a previous fetchVaultHistory OR from a
    // fetchVault that's since been superseded) drops on
    // resolve. See vaultReadGeneration declaration for the
    // mixed-snapshot hazard this prevents in the Linked
    // Sources card.
    vaultReadGeneration += 1;
    var myGen = vaultReadGeneration;
    currentVaultHistoryRows = null;
    fetch(dashUrl('/dashboard/vault/history'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (myGen !== vaultReadGeneration) return;
        renderVaultHistory(data);
      })
      .catch(function(err) {
        if (myGen !== vaultReadGeneration) return;
        var body = document.getElementById('vault-history-body');
        if (body) body.innerHTML = '<div class="status-err">Failed to load history: ' + esc(err.message) + '</div>';
        // Clear the card-local refresh pending UI on failure so
        // the button re-enables for retry. The body itself
        // carries the honest "Failed to load history" message
        // (above); the refresh status anchor just needs to stop
        // saying "Checking…".
        setHistoryRefreshPending(false);
      });
  }

  function renderVaultHistory(d) {
    var body = document.getElementById('vault-history-body');
    var filterRow = document.getElementById('vault-history-filter-row');
    var filterInput = document.getElementById('vault-history-filter');
    if (!body) return;

    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-STATUS-REFRESH-PR-1 —
    // any successful render (initial load or manual refresh) is
    // the signal to clear the pending UI and re-enable the
    // refresh button. Placed here so tab-switch re-fetches and
    // filter-driven re-renders also restore coherent state.
    setHistoryRefreshPending(false);

    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-STATUS-REFRESH-PR-1 —
    // belt-and-suspenders: fetchVaultHistory already installs
    // the delegate before fetching, so by the time we get here
    // the flag is set and this call is a no-op. Kept for
    // resilience in case renderVaultHistory is ever called via
    // a new path.
    ensureHistoryCardDelegate();

    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-OBSIDIAN-HANDOFF-PR-1 —
    // (re)populate the card-level Obsidian handoff slot on every
    // render. Gated on wrapper presence (no dead handoff in
    // browser mode) AND the shared truthful gate
    // shouldRenderObsidianQuickAction (ready + canWrite +
    // obsidian_open_supported + obsidian_installed). In any
    // non-satisfying state — including the non-ready early
    // return below — the slot is emptied, so a tab switch that
    // drops the vault out of ready also drops the handoff UI.
    renderLinkedSourcesObsidianHandoff();

    // Non-ready vault — honest state-specific copy + narrow
    // recovery pointer. VO-DESKTOP-WRAPPER-LINKED-SOURCES-
    // RECOVERY-AFFORDANCES-PR-1: jumps to the existing Vault
    // Summary card (tabindex="-1", browser-native anchor
    // scroll). No new route, no bridge call — pure in-page
    // navigation. Honest for both writable and read-only
    // sessions: the Vault Summary card renders either way.
    if (d.status_kind !== 'ready') {
      var kindHint = esc(String(d.status_kind || 'unknown'));
      body.innerHTML =
        '<div class="status-dim">History is available once the vault is <strong>ready</strong>. Current status: <code>' + kindHint + '</code>.</div>'
        + '<div class="history-recovery" data-history-recovery-kind="non-ready">'
        + '<a href="#vault-summary-card" '
        + 'class="btn-xs btn-ghost history-recovery-jump" '
        + 'data-history-recovery-jump="vault-summary">'
        + 'Review vault setup'
        + '</a>'
        + '</div>';
      if (filterRow) filterRow.style.display = 'none';
      currentVaultHistoryRows = null;
      return;
    }

    var rows = Array.isArray(d.rows) ? d.rows : [];
    currentVaultHistoryRows = rows;

    // Ready but empty — VO-DESKTOP-WRAPPER-LINKED-SOURCES-
    // RECOVERY-AFFORDANCES-PR-1: next-step affordance split on
    // canWrite. Writable sessions get a pure in-page jump to
    // the existing #vault-harvest-card (only rendered when
    // canWrite && ready — same gate applies). Read-only
    // sessions get honest copy naming the operator-token
    // blocker, NOT a dead CTA pointing at a card that wasn't
    // rendered.
    if (rows.length === 0) {
      var emptyAuth = (currentVaultData && currentVaultData._auth) || {};
      var emptyCanWrite = emptyAuth.can_write === true;
      var emptyHtml;
      if (emptyCanWrite) {
        emptyHtml = '<div class="status-dim">No finalized dossiers yet. Harvest a source above to start the local history.</div>'
          + '<div class="history-recovery" data-history-recovery-kind="empty-ready" data-history-recovery-mode="writable">'
          + '<a href="#vault-harvest-card" '
          + 'class="btn-xs btn-ghost history-recovery-jump" '
          + 'data-history-recovery-jump="vault-harvest">'
          + 'Jump to Harvest'
          + '</a>'
          + '</div>';
      } else {
        emptyHtml = '<div class="status-dim">No finalized dossiers yet. This session is read-only &mdash; an operator token is required to start a harvest.</div>'
          + '<div class="history-recovery" data-history-recovery-kind="empty-ready" data-history-recovery-mode="read-only"></div>';
      }
      body.innerHTML = emptyHtml;
      if (filterRow) filterRow.style.display = 'none';
      return;
    }

    if (filterRow) filterRow.style.display = 'flex';
    // Reattach filter handler (the element persists across re-renders
    // because the card is inside the main tab innerHTML replacement).
    if (filterInput && !filterInput.dataset.wired) {
      filterInput.dataset.wired = '1';
      filterInput.addEventListener('input', function() {
        applyVaultHistoryFilter(filterInput.value || '');
      });
    }
    applyVaultHistoryFilter(filterInput ? (filterInput.value || '') : '');
  }

  // VO-DESKTOP-WRAPPER-LINKED-SOURCES-REVEAL-DOSSIER-PR-1 +
  // OBSIDIAN-HANDOFF-PR-1 + STATUS-REFRESH-PR-1 — delegated click
  // handler for the row-level Reveal dossier affordance, the
  // card-level Obsidian handoff, and the card-level manual
  // Refresh. Installed ONCE per card mount via a
  // __voHistoryRevealDelegate flag on #vault-history-card.
  //
  // Called from fetchVaultHistory() BEFORE the fetch starts, so
  // the Refresh button is wired even when the initial history
  // load fails (the failure path paints "Failed to load history"
  // but does not go through renderVaultHistory). Also called at
  // the top of renderVaultHistory as belt-and-suspenders; the
  // idempotency flag keeps repeated calls from stacking
  // listeners.
  //
  // The card element is rebuilt by renderVault() on every tab
  // visit, so the flag is naturally scoped to the card instance.
  // Catching clicks at the card level (not per-row) matters
  // because applyVaultHistoryFilter() replaces
  // #vault-history-body.innerHTML on every filter keystroke —
  // per-row listeners would either miss freshly-painted rows or
  // pile up duplicates.
  function ensureHistoryCardDelegate() {
    var historyCard = document.getElementById('vault-history-card');
    if (!historyCard || historyCard.__voHistoryRevealDelegate) return;
    historyCard.__voHistoryRevealDelegate = true;
    historyCard.addEventListener('click', function(ev) {
      var target = ev.target;
      // Refresh branch — checked FIRST.
      var refreshEl = target && typeof target.closest === 'function'
        ? target.closest('[data-history-action="refresh"]')
        : null;
      if (refreshEl && historyCard.contains(refreshEl)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (refreshEl.disabled) return;
        setHistoryRefreshPending(true);
        fetchVaultHistory();
        return;
      }
      // VO-DESKTOP-WRAPPER-LINKED-SOURCES-FILTER-RECOVERY-PR-1 —
      // filter-zero-match recovery. Reads the EXISTING filter
      // input, clears its value, and re-runs the existing
      // applyVaultHistoryFilter('') path. Pure client-side
      // navigation through seams that already exist — no new
      // route, no new fetch.
      var clearFilterEl = target && typeof target.closest === 'function'
        ? target.closest('[data-history-action="clear-filter"]')
        : null;
      if (clearFilterEl && historyCard.contains(clearFilterEl)) {
        ev.preventDefault();
        ev.stopPropagation();
        var filterInput = document.getElementById('vault-history-filter');
        if (filterInput) filterInput.value = '';
        applyVaultHistoryFilter('');
        return;
      }
      // Obsidian handoff branch — card-level, checked before
      // reveal-dossier so a handoff click never falls through.
      var handoff = target && typeof target.closest === 'function'
        ? target.closest('[data-history-action="open-obsidian"]')
        : null;
      if (handoff && historyCard.contains(handoff)) {
        ev.preventDefault();
        ev.stopPropagation();
        var hoStatusEl = historyCard.querySelector('[data-history-handoff-status]');
        function setHoStatus(html) {
          if (hoStatusEl) hoStatusEl.innerHTML = html;
        }
        setHoStatus('');
        var hoState = (currentVaultData && currentVaultData.state) || {};
        var hoAuth = (currentVaultData && currentVaultData._auth) || {};
        if (!shouldRenderObsidianQuickAction(hoState, hoAuth.can_write === true)) {
          setHoStatus('<span class="status-err">Handoff unavailable in current state.</span>');
          return;
        }
        vaultAction('open-obsidian');
        return;
      }
      // Reveal dossier branch — row-level.
      var btn = target && typeof target.closest === 'function'
        ? target.closest('[data-history-action="reveal-dossier"]')
        : null;
      if (!btn || !historyCard.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var statusEl = btn.parentNode
        ? btn.parentNode.querySelector('[data-history-reveal-status]')
        : null;
      function setStatus(html) {
        if (statusEl) statusEl.innerHTML = html;
      }
      setStatus('');
      if (typeof window.voDesktop !== 'object' || !window.voDesktop
          || typeof window.voDesktop.revealPath !== 'function') {
        setStatus('<span class="status-err">Desktop bridge unavailable.</span>');
        return;
      }
      var liveState = (currentVaultData && currentVaultData.state) || null;
      if (!liveState || liveState.status_kind !== 'ready') {
        setStatus('<span class="status-err">Vault is not ready.</span>');
        return;
      }
      var vaultRoot = liveState.vault_root;
      if (typeof vaultRoot !== 'string' || !vaultRoot) {
        setStatus('<span class="status-err">Vault root unavailable.</span>');
        return;
      }
      var rel = btn.getAttribute('data-history-dossier-path') || '';
      var composed = composeVaultAbsolutePath(vaultRoot, rel);
      if (!composed.ok) {
        setStatus('<span class="status-err">Refused: ' + esc(composed.reason) + '</span>');
        return;
      }
      window.voDesktop.revealPath(composed.path).then(function(r) {
        var res = r || {};
        if (res.ok) {
          setStatus('<span class="status-ok">&#10003; revealed</span>');
        } else {
          setStatus('<span class="status-err">' + esc(res.reason || 'reveal refused') + '</span>');
        }
      }).catch(function(err) {
        setStatus('<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>');
      });
    });
  }

  // VO-DESKTOP-WRAPPER-LINKED-SOURCES-OBSIDIAN-HANDOFF-PR-1 —
  // populates (or clears) the card-level Obsidian handoff slot
  // inside the Linked Sources card. Called from renderVault-
  // History() on every render. Browser-mode honesty: emits
  // nothing when wrapper is absent, so there's no dead control
  // even if the server-side open-obsidian route would technically
  // respond. Uses the SHARED truth gate
  // shouldRenderObsidianQuickAction so a future gate change
  // automatically propagates here.
  //
  // This is a CARD-level action: "Open current vault in Obsidian"
  // opens the vault itself, not any specific dossier. Row-level
  // actions stay narrow (reveal-dossier + source URL link).
  function renderLinkedSourcesObsidianHandoff() {
    var slot = document.getElementById('vault-history-handoff');
    if (!slot) return;
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    var state = (currentVaultData && currentVaultData.state) || {};
    var auth = (currentVaultData && currentVaultData._auth) || {};
    var canWrite = auth.can_write === true;
    if (!hasWrapper || !shouldRenderObsidianQuickAction(state, canWrite)) {
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML =
      '<span class="status-dim history-handoff-label">Next step</span>'
      + ' <button type="button" class="btn-xs btn-ghost history-handoff-btn" '
      + 'data-history-action="open-obsidian">'
      + 'Open current vault in Obsidian'
      + '</button>'
      + ' <span class="history-handoff-status status-dim" '
      + 'data-history-handoff-status="1"></span>';
  }

  function applyVaultHistoryFilter(queryRaw) {
    var body = document.getElementById('vault-history-body');
    var countEl = document.getElementById('vault-history-filter-count');
    if (!body) return;
    var rows = currentVaultHistoryRows || [];
    var q = (queryRaw || '').trim().toLowerCase();
    var filtered = rows;
    if (q) {
      filtered = rows.filter(function(r) {
        return [
          r.title || '',
          r.hash || '',
          r.dossier_path || '',
          r.source_capture || '',
          r.source_url || '',
        ].some(function(v) {
          return String(v).toLowerCase().indexOf(q) !== -1;
        });
      });
    }
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-COUNT-CLICK-CLEAR-PR-1 —
    // the count slot itself is the shell-level clear affordance
    // when a filter is active. Empty query paints passive count
    // text; non-empty query paints a single compact button that
    // carries both the honest count ("x of y shown") and the
    // clear action via the existing data-history-action=
    // "clear-filter" delegate. Zero-match (filtered.length ===
    // 0) still paints the count here; the body below stays
    // honest and button-free.
    if (countEl) {
      if (q) {
        countEl.innerHTML =
          '<button type="button" class="btn-xs btn-ghost history-filter-count-clear" '
          + 'data-history-action="clear-filter" '
          + 'title="Clear filter">'
          + esc(filtered.length + ' of ' + rows.length + ' shown')
          + ' <span class="status-dim">&middot; Clear</span>'
          + '</button>';
      } else {
        countEl.textContent = rows.length + ' dossier' + (rows.length === 1 ? '' : 's');
      }
    }
    if (filtered.length === 0) {
      // Zero-match body keeps only the honest copy — the
      // shell-level Clear filter button above covers the
      // recovery action. Keeping two competing Clear buttons
      // here would fork the UX; the shell-level one wins
      // because it's also visible when filtered.length > 0.
      body.innerHTML = '<div class="status-dim">No dossiers match <code>' + esc(q) + '</code>.</div>';
      return;
    }
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-REVEAL-DOSSIER-PR-1 —
    // wrapper-presence check captured ONCE per filter render so
    // each row renderer can gate the Reveal dossier affordance
    // at render time (not click time). Browser mode therefore
    // emits no dead reveal button at all, matching the contract
    // used elsewhere (Local integrations card).
    var hasWrapper = typeof window.voDesktop === 'object'
      && window.voDesktop !== null
      && typeof window.voDesktop.revealPath === 'function';
    var html = '<div class="vault-history-list">';
    for (var i = 0; i < filtered.length; i++) {
      html += renderVaultHistoryRow(filtered[i], hasWrapper);
    }
    html += '</div>';
    body.innerHTML = html;
  }

  // VO-DESKTOP-WRAPPER-LINKED-SOURCES-REVEAL-DOSSIER-PR-1 — pure
  // path composer used by the Linked Sources row Reveal dossier
  // affordance. Joins an absolute vault root with a relative
  // dossier path in a way the main-process revealPathHandler
  // accepts:
  //   - POSIX absolute root "/..." joined with "/"
  //   - Windows absolute root (drive letter + colon + backslash)
  //     joined with "\\" (forward slashes in rel are rewritten to
  //     backslashes so the final path still matches the
  //     Windows-absolute regex the handler uses).
  //
  // Strict validation on rel because even though our own
  // history seam produces it, the click happens later — a
  // DevTools rewrite, a content-script injection, or a drifted
  // row HTML shouldn't be able to turn this into a shell reveal
  // of an arbitrary path.
  //
  // Returns { ok: true, path } or { ok: false, reason }.
  // reason is stable-enum so tests and the row UI can pick
  // specific copy.
  // Backslash is bound at runtime via String.fromCharCode so the
  // DASHBOARD_HTML wrapping template literal doesn't half-eat
  // backslash escape sequences at render time. Every time we
  // need to compare against or produce a literal backslash, we
  // route through BS instead of using a raw '\\' literal.
  var BS = String.fromCharCode(92);
  // Separator regex built with RegExp constructor + BS so the
  // template escape doesn't collapse '[\\\\/]+' into something
  // unintended. Class matches one-or-more of backslash or slash.
  var DOSSIER_SEP_RE = new RegExp('[' + BS + BS + '/]+');
  // Forward-slash regex built via constructor so the template
  // literal render doesn't half-eat the escape (/\//g becomes
  // ///g — invalid regex literal — at runtime).
  var FWD_SLASH_RE = new RegExp('/', 'g');
  var BACKSLASH_RE = new RegExp(BS + BS, 'g');

  // VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
  // sibling composer that accepts harvest-artifact prefixes
  // (dossiers/ or captures/). Same validation shape as
  // composeVaultAbsolutePath, different allowed-prefix set.
  // Conflict files live under dossiers/.conflicts/... so they
  // pass the dossiers/ prefix check; drafts live under dossiers/
  // too. Captures live under captures/.
  //
  // Returns { ok: true, path } or { ok: false, reason } with the
  // same reason enum (except path_not_dossier → path_not_artifact
  // to name the broader allowed set honestly).
  // VO-LOCAL-DASHBOARD-HARVEST-LOG-REVEAL-PR-1 +
  // VO-LOCAL-DASHBOARD-HARVEST-INDEX-REVEAL-PR-1 — tiny composer
  // for the vault's canonical top-level managed files (log.md
  // and index.md). The targets are fixed top-level filenames
  // relative to vault_root (not under dossiers/ or captures/),
  // so the existing artifact/dossier composers don't cover them.
  // Mirrors their POSIX/Windows root handling via the shared
  // BS constant.
  //
  // The filename argument is strictly allowlisted (log.md or
  // index.md) — the composer refuses any other value with
  // reason filename_not_allowed. That keeps the seam from being
  // repurposed into an arbitrary root-file reveal.
  //
  // Returns { ok: true, path } or { ok: false, reason }. Reason
  // enum reused from the other composers for consistency
  // (empty_root / root_not_absolute / filename_not_allowed).
  // VO-LOCAL-DASHBOARD-HARVEST-MANIFEST-REVEAL-PR-1 — allowlist
  // extended to include the captures/.manifest.jsonl managed
  // file. Entries are stored in POSIX form; the composer
  // normalizes the inner slash to backslash on Windows roots so
  // the final path matches the revealPathHandler's Windows
  // absolute-path regex (which requires a single backslash
  // after the drive letter and is lenient about interior
  // separators, but mixed separators are ugly).
  //
  // This is explicitly NOT a general relative-file reveal seam:
  // the allowlist stays strict and short; arbitrary filenames
  // keep refusing with filename_not_allowed.
  var VAULT_ROOT_FILE_ALLOWLIST = {
    'log.md': true,
    'index.md': true,
    'captures/.manifest.jsonl': true,
  };
  function composeVaultRootFilePath(root, filename) {
    if (typeof root !== 'string' || !root) return { ok: false, reason: 'empty_root' };
    if (typeof filename !== 'string' || !VAULT_ROOT_FILE_ALLOWLIST[filename]) {
      return { ok: false, reason: 'filename_not_allowed' };
    }
    var isWin = root.length >= 3
      && /^[A-Za-z]$/.test(root.charAt(0))
      && root.charAt(1) === ':'
      && root.charAt(2) === BS;
    var isPosix = root.charAt(0) === '/';
    if (!isWin && !isPosix) return { ok: false, reason: 'root_not_absolute' };
    var sep = isWin ? BS : '/';
    // Strip trailing separator(s) so the join never produces a
    // duplicate.
    var r = root;
    while (r.length > 0 && (r.charAt(r.length - 1) === '/' || r.charAt(r.length - 1) === BS)) {
      r = r.substring(0, r.length - 1);
    }
    // Normalize any interior forward slashes in the allowlisted
    // filename to backslashes on Windows so the final path is
    // single-separator. Filenames with no slash (log.md,
    // index.md) pass through unchanged.
    var normalizedFilename = isWin ? filename.replace(FWD_SLASH_RE, BS) : filename;
    return { ok: true, path: r + sep + normalizedFilename };
  }

  function composeVaultArtifactPath(root, rel) {
    if (typeof root !== 'string' || !root) return { ok: false, reason: 'empty_root' };
    if (typeof rel !== 'string' || !rel) return { ok: false, reason: 'empty_path' };
    var first = rel.charAt(0);
    if (first === '/' || first === BS) return { ok: false, reason: 'path_not_relative' };
    if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: 'path_not_relative' };
    var isDossier = rel.indexOf('dossiers/') === 0 || rel.indexOf('dossiers' + BS) === 0;
    var isCapture = rel.indexOf('captures/') === 0 || rel.indexOf('captures' + BS) === 0;
    if (!isDossier && !isCapture) {
      return { ok: false, reason: 'path_not_artifact' };
    }
    var segs = rel.split(DOSSIER_SEP_RE);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '..') return { ok: false, reason: 'path_traversal' };
      if (segs[i] === '' && i !== 0) return { ok: false, reason: 'path_malformed' };
    }
    var isWin = root.length >= 3
      && /^[A-Za-z]$/.test(root.charAt(0))
      && root.charAt(1) === ':'
      && root.charAt(2) === BS;
    var isPosix = root.charAt(0) === '/';
    if (!isWin && !isPosix) return { ok: false, reason: 'root_not_absolute' };
    var sep = isWin ? BS : '/';
    var r = root;
    while (r.length > 0 && (r.charAt(r.length - 1) === '/' || r.charAt(r.length - 1) === BS)) {
      r = r.substring(0, r.length - 1);
    }
    var normalizedRel = isWin ? rel.replace(FWD_SLASH_RE, BS) : rel.replace(BACKSLASH_RE, '/');
    return { ok: true, path: r + sep + normalizedRel };
  }

  function composeVaultAbsolutePath(root, rel) {
    if (typeof root !== 'string' || !root) return { ok: false, reason: 'empty_root' };
    if (typeof rel !== 'string' || !rel) return { ok: false, reason: 'empty_path' };

    // Reject absolute row paths (leading slash or backslash).
    var first = rel.charAt(0);
    if (first === '/' || first === BS) return { ok: false, reason: 'path_not_relative' };
    // Reject Windows drive-letter relatives (e.g. C:foo, C:/foo, C:\foo).
    if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: 'path_not_relative' };

    // Row contract: dossier_path is always under the dossiers/
    // prefix. Enforce it so a drifted/forged row can't reveal
    // anywhere else under the vault root.
    if (rel.indexOf('dossiers/') !== 0 && rel.indexOf('dossiers' + BS) !== 0) {
      return { ok: false, reason: 'path_not_dossier' };
    }

    // Reject any ".." segment in either separator form.
    var segs = rel.split(DOSSIER_SEP_RE);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '..') return { ok: false, reason: 'path_traversal' };
      if (segs[i] === '' && i !== 0) {
        // Empty segment from duplicate separators. Leading-sep
        // was already rejected above.
        return { ok: false, reason: 'path_malformed' };
      }
    }

    // Detect root kind without relying on backslash escapes.
    // Windows root = [A-Za-z] + ':' + backslash, mirroring the
    // main-process revealPathHandler validation.
    var isWin = root.length >= 3
      && /^[A-Za-z]$/.test(root.charAt(0))
      && root.charAt(1) === ':'
      && root.charAt(2) === BS;
    var isPosix = root.charAt(0) === '/';
    if (!isWin && !isPosix) return { ok: false, reason: 'root_not_absolute' };

    var sep = isWin ? BS : '/';
    // Strip trailing separator(s) so the join never produces a
    // duplicate.
    var r = root;
    while (r.length > 0 && (r.charAt(r.length - 1) === '/' || r.charAt(r.length - 1) === BS)) {
      r = r.substring(0, r.length - 1);
    }
    // Normalize rel's separators to match the root kind so the
    // final path is single-separator and satisfies the main-
    // process absolute-path format check.
    var normalizedRel = isWin ? rel.replace(FWD_SLASH_RE, BS) : rel.replace(BACKSLASH_RE, '/');
    return { ok: true, path: r + sep + normalizedRel };
  }

  // Gate source_url rendering to http(s) only. Frontmatter is
  // tenant-owned text on disk; a malicious or malformed dossier
  // with a javascript- or data-scheme source_url would otherwise
  // render as a clickable executable link. Return null for
  // anything that isnt http or https; the row renderer falls back
  // to plain-text display so the operator still sees the bogus
  // value without a one-click exploit path.
  function safeSourceUrl(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^https?:\\/\\//i.test(trimmed)) return null;
    return trimmed;
  }

  function renderVaultHistoryRow(r, hasWrapper) {
    // Honest status badge — five values, two axes (doc / memory).
    var badgeClass, badgeText;
    if (r.link_status === 'graph_linked') {
      badgeClass = 'badge badge-ok';
      badgeText = 'Linked to VO';
    } else if (r.link_status === 'doc_linked_no_memories') {
      badgeClass = 'badge badge-ok';
      badgeText = 'Doc-linked, no memories';
    } else if (r.link_status === 'memories_only') {
      badgeClass = 'badge badge-warn';
      badgeText = 'Memories only';
    } else if (r.link_status === 'local_only') {
      badgeClass = 'badge';
      badgeText = 'Local dossier only';
    } else {
      badgeClass = 'badge badge-err';
      badgeText = 'Metadata unavailable';
    }
    var title = r.title || '(untitled)';
    var when = r.generated_at || '—';
    var line = '<div class="vault-history-row" style="padding:.5rem 0;border-top:1px solid var(--border)">';
    line += '<div style="display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap">';
    line += '<span class="status-value" style="font-weight:600">' + esc(title) + '</span>';
    line += '<span class="' + badgeClass + '">' + esc(badgeText) + '</span>';
    line += '<span class="status-dim" style="font-size:.78rem">' + esc(when) + '</span>';
    line += '</div>';
    line += '<div class="status-dim" style="font-size:.78rem;margin-top:.15rem">';
    line += 'hash <code>' + esc(r.hash || '—') + '</code> · dossier <code>' + esc(r.dossier_path || '—') + '</code>';
    // VO-DESKTOP-WRAPPER-LINKED-SOURCES-REVEAL-DOSSIER-PR-1 —
    // row-local Reveal dossier affordance. Truthful-gate: emits
    // the button ONLY when wrapper is present AND the row
    // carries a non-empty dossier_path. Browser mode gets no
    // button at all (no dead control). hasWrapper is captured
    // once per filter render in applyVaultHistoryFilter and
    // threaded through here.
    //
    // Style: small inline btn-link look via btn-xs btn-ghost,
    // consistent with the existing hash/dossier row copy.
    if (hasWrapper && r.dossier_path) {
      line += ' · <button type="button" class="btn-xs btn-ghost history-reveal-btn" '
        + 'data-history-action="reveal-dossier" '
        + 'data-history-dossier-path="' + esc(r.dossier_path) + '">'
        + 'Reveal dossier'
        + '</button>';
      line += '<span class="history-reveal-status status-dim" '
        + 'data-history-reveal-status="1" '
        + 'style="margin-left:.4rem"></span>';
    }
    if (r.source_capture) line += ' · capture <code>' + esc(r.source_capture) + '</code>';
    if (r.source_url) {
      var safeUrl = safeSourceUrl(r.source_url);
      if (safeUrl) {
        line += ' · <a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">source URL</a>';
      } else {
        // Non-http(s) scheme — render as plain text so the operator
        // sees the bogus value but can't click it.
        line += ' · <span class="status-err" title="URL refused (only http/https allowed)">source URL: ' + esc(r.source_url) + '</span>';
      }
    }
    line += '</div>';
    if ((r.link_status === 'graph_linked' || r.link_status === 'doc_linked_no_memories') && r.vo_addr) {
      line += '<div class="status-dim" style="font-size:.78rem">vo_addr <code>' + esc(r.vo_addr) + '</code>';
      if (r.vo_nodes_count != null && r.vo_nodes_count > 0) {
        line += ' · ' + esc(String(r.vo_nodes_count)) + ' memory node' + (r.vo_nodes_count === 1 ? '' : 's');
      } else {
        line += ' · 0 derived memories';
      }
      line += '</div>';
    } else if (r.link_status === 'memories_only' && r.vo_nodes_count) {
      line += '<div class="status-dim" style="font-size:.78rem">' + esc(String(r.vo_nodes_count)) + ' memory node' + (r.vo_nodes_count === 1 ? '' : 's') + ' written, no doc-link yet.</div>';
    }
    line += '</div>';
    return line;
  }

  // Harvest submit — own its result region; never route through
  // vaultAction(). The server returns the structured AutoOutcome AND
  // a pre-rendered HTML fragment; we drop the fragment directly so
  // the presenter lives in one place (api/src/lib/dashboard-harvest-ui.ts).
  // VO-LOCAL-DASHBOARD-HARVEST-PR-1B — double-submit guard. A true
  // boolean gate (not just a button.disabled toggle) so click-spam
  // on the submit button AND on any retry affordance rendered by
  // the presenter all share the same single-in-flight discipline.
  // Settled on both the .then and .catch paths so a failed request
  // does not leave the button permanently disabled.
  var harvestInFlight = false;
  function setHarvestControlsDisabled(disabled) {
    var submitBtn = document.getElementById('vault-harvest-submit');
    if (submitBtn) submitBtn.disabled = !!disabled;
    var retries = document.querySelectorAll('.vault-harvest-retry');
    for (var ri = 0; ri < retries.length; ri++) {
      retries[ri].disabled = !!disabled;
    }
  }
  // VO-HARVEST-SUBMIT-ERROR-RETRY-PR-1 — inline retry control
  // for harvest submit error paths that do NOT produce a
  // presenter-emitted stop card (the presenter already emits
  // retry for stop_missing_key / stop_vo_unavailable /
  // stop_unknown). Covered here:
  //   - HTTP 400/409 "Harvest rejected" input failures
  //   - !data.ok "Harvest failed unexpectedly" server failures
  //   - .catch "Unexpected: <err.message>" transport failures
  //
  // Reuses the EXISTING data-harvest-retry delegate (the
  // listener calls harvestSubmit() regardless of attribute
  // value), with a distinct "submit_error" kind for analytics /
  // structural assertions. No new seam, no new route, no new
  // action namespace.
  function renderSubmitErrorRetry() {
    return '<div class="harvest-retry-row" style="margin-top:.6rem">'
      + '<button type="button" class="btn-sm btn-secondary vault-harvest-retry" '
      + 'data-harvest-retry="submit_error">Retry harvest</button>'
      + '<span class="status-dim" style="margin-left:.6rem">'
      + 'Same source will be resubmitted.'
      + '</span>'
      + '</div>';
  }

  function harvestSubmit() {
    // Drop duplicate clicks while a harvest is in flight. Not a
    // global state machine rewrite — just a thin guard that keeps
    // retry/submit honest.
    if (harvestInFlight) return;
    var srcEl = document.getElementById('vault-harvest-source');
    var pendingEl = document.getElementById('vault-harvest-pending');
    var resultEl = document.getElementById('vault-harvest-result');
    var source = srcEl && typeof srcEl.value === 'string' ? srcEl.value.trim() : '';
    if (!source) {
      if (resultEl) {
        resultEl.innerHTML = '<div class="alert alert-err" style="margin-top:.6rem"><span class="alert-icon" aria-hidden="true">!</span><span>Enter a source path or URL first.</span></div>';
      }
      return;
    }
    var tid = getTenantId();
    if (pendingEl) {
      pendingEl.style.display = 'block';
      pendingEl.innerHTML = '<span class="status-dim">Harvesting &hellip; this may take a few seconds.</span>';
    }
    // Clear the cached result so the post-harvest refresh (and any
    // tab switch back to Vault) does not reshow the previous outcome
    // while the new one is still in flight.
    clearLastHarvestResult();
    if (resultEl) resultEl.innerHTML = '';
    harvestInFlight = true;
    setHarvestControlsDisabled(true);
    fetch('/dashboard/vault/harvest', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ tenant_id: tid, source: source }),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json().catch(function() { return null; }).then(function(data) {
        return { status: res.status, data: data };
      });
    }).then(function(wrapped) {
      if (!wrapped) return;
      if (pendingEl) { pendingEl.style.display = 'none'; pendingEl.innerHTML = ''; }
      var data = wrapped.data || {};
      if (wrapped.status === 409 || wrapped.status === 400) {
        // Inspection / input failure — NOT a harvest outcome. Render
        // inline without inventing a fake outcome card.
        // VO-HARVEST-SUBMIT-ERROR-RETRY-PR-1 — inline retry that
        // routes through the existing #vault-harvest-card delegate
        // back into harvestSubmit(). The delegate calls
        // harvestSubmit() regardless of the retry-kind value, so
        // we reuse the existing data-harvest-retry namespace with
        // a distinct "submit_error" value.
        if (resultEl) {
          resultEl.innerHTML = '<div class="alert alert-warn" style="margin-top:.6rem"><span class="alert-icon" aria-hidden="true">!</span><span>' + esc(data.error || 'Harvest rejected.') + '</span></div>'
            + renderSubmitErrorRetry();
        }
        return;
      }
      if (!data.ok) {
        if (resultEl) {
          resultEl.innerHTML = '<div class="alert alert-err" style="margin-top:.6rem"><span class="alert-icon" aria-hidden="true">!</span><span>' + esc(data.error || 'Harvest failed unexpectedly.') + '</span></div>'
            + renderSubmitErrorRetry();
        }
        return;
      }
      if (resultEl && typeof data.html === 'string') {
        resultEl.innerHTML = data.html;
        populateHarvestLocalActions();
        // Stash the rendered card with the identity it was rendered
        // against — tenant_id + vault_root. The 500ms refresh rebuilds
        // the Vault tab; without persistence the guidance would flash
        // and vanish. The identity tag ensures a later tenant/root
        // change cannot resurface this tenant's paths.
        //
        // VO-LOCAL-DASHBOARD-HARVEST-PR-1B: also stash the attempted
        // source so the restore path in renderVault can refill
        // #vault-harvest-source for the retry affordance. Same
        // identity gate; clearLastHarvestResult() wipes it too, so
        // tenant-switch / token-clear / new-submit all already
        // clear the retry context.
        var vaultRootForCache = (currentVaultData && currentVaultData.state && currentVaultData.state.vault_root)
          ? currentVaultData.state.vault_root
          : ((data.outcome && data.outcome.root) || '');
        lastHarvestResult = {
          tenant: getTenantId() || '',
          root: vaultRootForCache || '',
          html: data.html,
          source: source,
        };
      }
      // Refresh the 3-axis state card so dossier count / last-
      // generated timestamp reflect the new write. Fire-and-forget.
      setTimeout(function() { fetchVault(); }, 500);
    }).catch(function(err) {
      if (pendingEl) { pendingEl.style.display = 'none'; pendingEl.innerHTML = ''; }
      if (resultEl) {
        resultEl.innerHTML = '<div class="alert alert-err" style="margin-top:.6rem"><span class="alert-icon" aria-hidden="true">!</span><span>Unexpected: ' + esc(err && err.message ? err.message : String(err)) + '</span></div>'
          + renderSubmitErrorRetry();
      }
    }).then(function() {
      // Always restore controls on settle — whether the request
      // succeeded, refused, or threw. A dropped in-flight flag
      // would leave retry/submit permanently disabled after the
      // first failure, which would defeat the whole PR-1B goal.
      harvestInFlight = false;
      setHarvestControlsDisabled(false);
    });
  }

  function vaultAction(action) {
    var tid = getTenantId();
    var statusEl = document.getElementById('vault-status');
    // VO-DESKTOP-WRAPPER-PR-1 — native folder picker. Short-circuits
    // the normal fetch-post flow below: the bridge handles the
    // OS dialog AND the /machine/vault/root write server-side, then
    // we just refresh the Vault tab on success.
    if (action === 'pick-folder') {
      if (typeof window.voDesktop !== 'object' || !window.voDesktop) {
        if (statusEl) statusEl.innerHTML = '<span class="status-err">Native picker not available in this context.</span>';
        return;
      }
      window.voDesktop.pickVaultFolder().then(function(r) {
        var res = r || {};
        if (res.canceled) {
          // User closed the dialog — not an error, not a status.
          return;
        }
        if (res.persisted) {
          if (statusEl) statusEl.innerHTML = '<span class="status-ok">&#10003; vault root set to ' + esc(res.root || '') + '</span>';
          setTimeout(function() { fetchVault(); }, 200);
        } else {
          if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(res.message || 'Picker refused') + '</span>';
        }
      }).catch(function(err) {
        if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>';
      });
      return;
    }
    // VO-DESKTOP-WRAPPER-PR-1 — route "open vault" through the native
    // reveal bridge when the wrapper is present. Skips a server round-
    // trip and works even if /dashboard/vault/open is disabled on the
    // platform. Browser users (no bridge) fall through to the
    // server-side action unchanged.
    //
    // Read from currentVaultData (set by fetchVault), NOT currentData
    // — currentData is the Home overview's handle and never carries
    // state.vault_root, so reading it here would silently fall back
    // to the server-side route.
    if (action === 'open'
        && typeof window.voDesktop === 'object' && window.voDesktop
        && currentVaultData && currentVaultData.state && typeof currentVaultData.state.vault_root === 'string' && currentVaultData.state.vault_root) {
      window.voDesktop.revealPath(currentVaultData.state.vault_root).then(function(r) {
        var res = r || {};
        if (res.ok) {
          if (statusEl) statusEl.innerHTML = '<span class="status-ok">&#10003; revealed vault in Finder/Explorer</span>';
        } else {
          if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(res.reason || 'reveal refused') + '</span>';
        }
      }).catch(function(err) {
        if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>';
      });
      return;
    }
    var body = { tenant_id: tid };
    var endpoint;
    if (action === 'enable') { endpoint = '/dashboard/vault/enabled'; body.enabled = true; }
    else if (action === 'disable') { endpoint = '/dashboard/vault/enabled'; body.enabled = false; }
    else if (action === 'set-root') {
      endpoint = '/dashboard/vault/root';
      var inp = document.getElementById('vault-root-input');
      var v = inp ? inp.value.trim() : '';
      body.root = v ? v : null;
    }
    else if (action === 'init') { endpoint = '/dashboard/vault/init'; }
    else if (action === 'open') { endpoint = '/dashboard/vault/open'; }
    else if (action === 'open-obsidian') { endpoint = '/dashboard/vault/open-obsidian'; }
    else return;

    fetch(endpoint, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      if (data.ok) {
        if (statusEl) statusEl.innerHTML = '<span class="status-ok">&#10003; ' + esc(action) + ' ok</span>';
        setTimeout(function() { fetchVault(); }, 500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(data.error || 'Failed') + '</span>';
      }
    }).catch(function(err) {
      if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(err.message) + '</span>';
    });
  }

  // ── Plugin controls (VO-LOCAL-DASHBOARD-OBSIDIAN-PLUGIN-CONTROLS-PR-1) ──
  //
  // Deliberately separate from the generic vaultAction() flow above.
  // Plugin install/update/remove lives entirely on the desktop side
  // (window.voDesktop preload bridge) — routing these through
  // /dashboard/vault/* POSTs or /machine/* would duplicate authority
  // the desktop module already owns. The bridge ALWAYS returns the
  // fresh PluginStatus inside the action result; we re-render from
  // that, never from a refetch and never from ad-hoc local logic
  // that could drift from the desktop state machine.
  //
  // Browser-mode honesty: the card renders an explicit
  // "desktop-app-required" state when window.voDesktop is absent.
  // No install/update/remove buttons are attached in browser mode —
  // buttons exist in the DOM only when the bridge can actually act.
  var pluginActionInFlight = false;

  // Cache the most recent PluginStatus the bridge returned so the
  // dispatch-time tenant-context gate in pluginAction() can re-run
  // the SAME mismatch check the render layer used (covers all
  // three modes — dashboard_vault_unset, tenant_mismatch,
  // vault_root_mismatch — without duplicating the comparison).
  // Written by renderPluginStatus; read by pluginAction.
  var lastPluginStatus = null;

  // Monotonic read-dispatch counter. Bumped on EVERY dispatch of
  // getObsidianPluginStatus() (from renderPluginControls) AND on
  // every pluginAction() write dispatch. Each async read callback
  // captures the counter at dispatch time and drops if a newer
  // dispatch has since happened — protects against two same-
  // session reads racing to paint the card (older read resolving
  // after newer would otherwise overwrite the newer's lastPluginStatus
  // cache and DOM with a stale snapshot). Action dispatches also
  // bump to invalidate any in-flight read the action's own result
  // will be newer than — that way a pre-action read cannot arrive
  // late and paint stale state over an action's authoritative
  // post-mutation result.
  var pluginReadGeneration = 0;

  function pluginStatusCopy(status) {
    // Copy table mirrored from spec § 6. Keep these literal strings
    // so the UI test can pin them verbatim; a drift here would mean
    // the dashboard is narrating the desktop state machine
    // incorrectly.
    switch (status && status.kind) {
      case 'not_installed':
        return 'VO Review plugin is not installed in this vault.';
      case 'installed_current':
        return 'VO Review plugin is installed and current.';
      case 'installed_outdated':
        return 'VO Review plugin is installed, but the bundled version is newer.';
      case 'installed_unknown':
        return 'VO Review plugin is present, but the installed manifest could not be read.';
      case 'unavailable_no_vault':
        return 'Configure a local vault before installing the plugin.';
      case 'unavailable_bundle_missing':
        return 'The bundled plugin artifact is missing from this build.';
      default:
        return 'Plugin status unavailable.';
    }
  }

  // ── Tenant-context mismatch gate ──────────────────────────────────
  //
  // The desktop bridge always targets the LOCAL MACHINE's configured
  // vault_root (via resolveLocalVaultRoot) — it has no tenant
  // parameter. Under operator tenant-switching, the dashboard can
  // legitimately be viewing tenant B while the machine is still
  // bound to tenant A's vault. Without a gate, clicking Install here
  // would mutate tenant A's vault while the copy says "in this vault"
  // referring to the tenant-B session — a silent cross-tenant
  // mutation.
  //
  // This gate compares the dashboard's current vault state (from
  // /dashboard/vault, which IS tenant-scoped) against the status the
  // desktop bridge returned. Any divergence suppresses actions and
  // surfaces an explicit banner.
  //
  // Returns null when the two views are aligned, or a mismatch
  // reason string when they aren't.
  function pluginTenantMismatchReason(status) {
    var vaultData = currentVaultData;
    var vaultState = vaultData && vaultData.state;
    // Defensive — if the Vault tab hasn't finished loading yet we
    // can't evaluate; the next render (triggered by fetchVault's
    // then) will re-check.
    if (!vaultState) return null;

    // The desktop seam itself may report "no vault" (kind
    // unavailable_no_vault). In that case its own can_install=false
    // already short-circuits actions; we don't need a separate
    // tenant-context banner.
    if (!status || !status.vault_root) return null;

    // Dashboard has no configured vault for the current tenant.
    // The desktop WOULD target a vault_root that doesn't belong to
    // this dashboard session — refuse.
    if (!vaultState.vault_root) return 'dashboard_vault_unset';

    // Dashboard explicitly reports tenant_mismatch (vault binding
    // tenant_id != current session tenant_id). Never mutate.
    if (vaultState.tenant_match === false) return 'tenant_mismatch';

    // Strict string compare. A trailing-slash / case difference
    // would be honestly different paths on disk — no normalization
    // that could mask a real divergence.
    if (vaultState.vault_root !== status.vault_root) return 'vault_root_mismatch';

    return null;
  }

  // VO-DESKTOP-WRAPPER-PLUGIN-CONTROLS-RECOVERY-PR-1 — pure
  // decision for whether the plugin-controls card should render a
  // recovery affordance pointing to the Vault Summary card. Two
  // trigger conditions:
  //   - status.kind === 'unavailable_no_vault'  (bridge reports no
  //     vault configured — operator needs to set one in the Vault
  //     Summary before any plugin action can proceed)
  //   - pluginTenantMismatchReason(status) !== null  (dashboard
  //     session and desktop bridge disagree on which vault is
  //     authoritative — operator needs to align them via the
  //     Vault Summary)
  // Returns a stable kind string (or null) so the template can
  // branch on a small closed set rather than recomputing both
  // conditions inline.
  function pluginRecoveryKind(status, mismatchReason) {
    if (mismatchReason) return 'mismatch';
    if (status && status.kind === 'unavailable_no_vault') return 'no_vault';
    return null;
  }

  function pluginRecoveryCopy(recoveryKind, canWrite) {
    // Copy branches on both the trigger state AND operator-token
    // presence. The plugin-controls card renders regardless of
    // canWrite, but the Vault Summary card only exposes path-
    // changing controls (set-root, pick-folder) when canWrite is
    // true. A read-only jump CTA would land on a card with no
    // usable controls — so read-only copy is honest about the
    // operator-token requirement and does NOT render a jump
    // link (gated at the callsite in renderPluginStatus).
    //
    // Paths are still withheld: no install_dir, no bridge-side
    // vault_root re-disclosure. Read-only copy names the
    // operator-token blocker instead of a filesystem path.
    switch (recoveryKind) {
      case 'no_vault':
        return canWrite
          ? 'Configure a local vault root in the Vault Summary above, then return here to install the plugin.'
          : 'A local vault root must be configured before the plugin can install, but this session is read-only — an operator token is required to set the vault path.';
      case 'mismatch':
        return canWrite
          ? 'Align the vault shown in the Vault Summary above with this dashboard session before taking plugin actions here.'
          : 'The vault shown in the Vault Summary is not aligned with this dashboard session, but this session is read-only — an operator token is required to change the vault path.';
      default:
        return '';
    }
  }

  function pluginTenantMismatchMessage(reason, status) {
    var vaultState = (currentVaultData && currentVaultData.state) || {};
    var dashboardRoot = vaultState.vault_root || '(none)';
    var desktopRoot = (status && status.vault_root) || '(none)';
    switch (reason) {
      case 'dashboard_vault_unset':
        return 'The dashboard has no vault configured for the current tenant, '
          + 'but the desktop app is pointed at ' + desktopRoot + '. '
          + 'Plugin actions would mutate a vault that does not belong to this '
          + 'dashboard session — actions are disabled.';
      case 'tenant_mismatch':
        return 'The configured vault at ' + dashboardRoot + ' is bound to a '
          + 'different tenant than the current dashboard session. Plugin '
          + 'actions would mutate a mismatched vault — actions are disabled. '
          + 'Switch tenants or re-bind the vault to continue.';
      case 'vault_root_mismatch':
        return 'The dashboard is viewing vault ' + dashboardRoot + ', but the '
          + 'desktop app is pointed at ' + desktopRoot + '. Plugin actions '
          + 'would mutate the desktop vault, not the one shown here — '
          + 'actions are disabled. Align VERITY_VAULT_ROOT or '
          + '~/.vo/config.json vault_root with the dashboard tenant to continue.';
      default:
        return '';
    }
  }

  function renderPluginControls() {
    var body = document.getElementById('vault-plugin-controls-body');
    if (!body) return;
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper) {
      // Browser mode. Do NOT pretend to control local filesystem.
      body.innerHTML =
        '<div class="empty">Plugin install controls are available in the desktop app. '
        + 'Open the Verity One desktop app to install, update, or remove the VO Review plugin in this vault.</div>';
      return;
    }

    // Hard read-suppression while an action is in flight. Without
    // this, a tab switch or parent re-render during an
    // install/update/remove would dispatch a fresh
    // getObsidianPluginStatus() read that could later resolve with
    // PRE-mutation state and overwrite the action's authoritative
    // POST-mutation result. The in-flight action's own resolution
    // is the final paint; we wait for it.
    if (pluginActionInFlight) {
      body.innerHTML = '<div class="status-dim">A plugin action is in progress&hellip; the status will refresh when it completes.</div>';
      return;
    }

    body.innerHTML = '<div class="status-dim">Loading plugin status&hellip;</div>';

    // Capture dispatch identity + read generation synchronously.
    //
    // Identity (tenant_id + vault_root) protects against cross-
    // session drift: operator switches tenants between dispatch
    // and resolution.
    //
    // Generation protects against SAME-session stale-read
    // overwrite: Vault tab re-renders while an earlier
    // getObsidianPluginStatus() is still in flight; the newer
    // read resolves first and paints; the older read resolves
    // later and must NOT paint over the newer snapshot.
    var readDispatchTenantId = (typeof getTenantId === 'function' ? (getTenantId() || '') : '');
    var readDispatchVaultRoot = ((currentVaultData && currentVaultData.state && currentVaultData.state.vault_root) || '');
    pluginReadGeneration += 1;
    var readDispatchGen = pluginReadGeneration;
    function readIdentityStillMatches() {
      var nowTenantId = (typeof getTenantId === 'function' ? (getTenantId() || '') : '');
      var nowVaultRoot = ((currentVaultData && currentVaultData.state && currentVaultData.state.vault_root) || '');
      return nowTenantId === readDispatchTenantId && nowVaultRoot === readDispatchVaultRoot;
    }
    function readGenerationStillCurrent() {
      return readDispatchGen === pluginReadGeneration;
    }

    try {
      var p = window.voDesktop.getObsidianPluginStatus();
      if (!p || typeof p.then !== 'function') {
        renderPluginBridgeError('desktop bridge returned a non-promise for plugin status');
        return;
      }
      p.then(function(status) {
        // Generation check FIRST — a newer read (or action)
        // dispatch has already claimed the paint slot. Drop
        // silently: painting here would overwrite the newer
        // snapshot's lastPluginStatus with stale state.
        if (!readGenerationStillCurrent()) return;
        // Identity check covers the cross-tenant case on top of
        // same-session staleness.
        if (!readIdentityStillMatches()) return;
        renderPluginStatus(status);
      }, function(err) {
        if (!readGenerationStillCurrent()) return;
        if (!readIdentityStillMatches()) return;
        renderPluginBridgeError(err && err.message || 'unknown error');
      });
    } catch (e) {
      renderPluginBridgeError(e && e.message || 'unknown error');
    }
  }

  function renderPluginBridgeError(msg) {
    var body = document.getElementById('vault-plugin-controls-body');
    if (body) {
      body.innerHTML = '<div class="status-err">Could not read plugin status from the desktop app: ' + esc(String(msg)) + '</div>';
    }
  }

  function renderPluginStatus(status) {
    var body = document.getElementById('vault-plugin-controls-body');
    if (!body) return;
    if (!status || typeof status !== 'object') {
      renderPluginBridgeError('empty status payload');
      return;
    }

    // Cache the status for the dispatch-time defense in
    // pluginAction(). Updated on every successful render so the
    // cache never goes stale against the rendered UI.
    lastPluginStatus = status;

    // Evaluate the tenant-context gate BEFORE composing the action
    // buttons so their disabled state reflects both the desktop
    // status AND the dashboard session alignment.
    var mismatchReason = pluginTenantMismatchReason(status);

    var html = '';
    html += '<div class="plugin-status-block">';

    // Headline copy keyed off the PluginStatus kind.
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Status</span>';
    html += '<span class="structure-meta">' + esc(pluginStatusCopy(status)) + '</span>';
    html += '</div>';

    // Bundled / installed versions surface side-by-side so an
    // installed_outdated state shows the exact delta.
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Bundled version</span>';
    html += '<span class="structure-meta">' + esc(status.bundled_version || '(missing)') + '</span>';
    html += '</div>';
    html += '<div class="structure-row">';
    html += '<span class="structure-label">Installed version</span>';
    html += '<span class="structure-meta">' + esc(status.installed_version || '(not installed)') + '</span>';
    html += '</div>';

    if (status.install_dir) {
      html += '<div class="structure-row">';
      html += '<span class="structure-label">Install dir</span>';
      html += '<span class="structure-meta">' + esc(status.install_dir) + '</span>';
      html += '</div>';
    }

    // Preserve the desktop seam's own message when present — it
    // already carries the best explanation (e.g. "Bundled plugin is
    // incomplete — missing: main.js").
    if (status.message) {
      html += '<p class="vault-copy plugin-status-message">' + esc(status.message) + '</p>';
    }
    html += '</div>';

    // Tenant-context mismatch banner. Rendered BEFORE the action
    // buttons so the tenant sees the reason BEFORE reaching for a
    // (disabled) button.
    if (mismatchReason) {
      html += '<div class="status-err plugin-tenant-mismatch" data-plugin-mismatch="'
        + esc(mismatchReason) + '">'
        + esc(pluginTenantMismatchMessage(mismatchReason, status))
        + '</div>';
    }

    // VO-DESKTOP-WRAPPER-PLUGIN-CONTROLS-RECOVERY-PR-1 — narrow
    // recovery affordance pointing to the existing Vault Summary
    // card. Rendered for two blocked states:
    //   - unavailable_no_vault: operator needs to configure a
    //     vault root before any install/update/remove works.
    //   - any pluginTenantMismatchReason: operator needs to
    //     align vault context between dashboard session and
    //     desktop bridge.
    // Content is a short "next step" copy + a pure in-page
    // anchor jump to #vault-summary-card. It does NOT introduce
    // a second plugin mutation surface — no data-plugin-action
    // emitted here, no install/update/remove verb, no bridge
    // call. It does NOT leak paths beyond what the mismatch
    // banner already discloses (no install_dir, no bridge-side
    // vault_root re-disclosure in the generic copy).
    var recoveryKind = pluginRecoveryKind(status, mismatchReason);
    if (recoveryKind) {
      // Read canWrite from the same dashboard session state the
      // Vault Summary card renders against. In read-only sessions
      // the target card has no path-changing controls, so the
      // jump link is suppressed and the copy honestly names the
      // operator-token blocker.
      var recoveryCanWrite = !!(currentVaultData && currentVaultData._auth && currentVaultData._auth.can_write === true);
      html += '<div class="plugin-recovery" data-plugin-recovery-kind="'
        + esc(recoveryKind) + '" data-plugin-recovery-mode="'
        + (recoveryCanWrite ? 'writable' : 'read-only') + '">';
      html += '<p class="vault-copy">'
        + esc(pluginRecoveryCopy(recoveryKind, recoveryCanWrite))
        + '</p>';
      if (recoveryCanWrite) {
        html += '<a href="#vault-summary-card" '
          + 'class="btn-xs btn-ghost plugin-recovery-jump" '
          + 'data-plugin-recovery-jump="vault-summary">'
          + 'Jump to Vault controls'
          + '</a>';
      }
      html += '</div>';
    }

    // Action buttons. Gated on BOTH the desktop PluginStatus flags
    // AND the dashboard tenant-context alignment — if either says
    // no, the button is disabled. Never re-derived locally from
    // status.kind.
    html += '<div class="vault-actions" id="vault-plugin-actions">';
    var canInstall = status.can_install === true && !mismatchReason;
    var canUpdate = status.can_update === true && !mismatchReason;
    var canRemove = status.can_remove === true && !mismatchReason;
    html += '<button class="btn-sm btn-primary" data-plugin-action="install"'
      + (canInstall ? '' : ' disabled') + '>Install plugin</button>';
    html += '<button class="btn-sm btn-ghost" data-plugin-action="update"'
      + (canUpdate ? '' : ' disabled') + '>Update plugin</button>';
    html += '<button class="btn-sm btn-ghost" data-plugin-action="remove"'
      + (canRemove ? '' : ' disabled') + '>Remove plugin</button>';
    html += '</div>';

    // Dedicated result area — separate from the generic
    // #vault-status toast used by vaultAction(). Preserves the
    // LifecycleActionResult outcome + message shape.
    html += '<div id="vault-plugin-result"></div>';

    // Enablement reminder — PR-1 installs FILES only.
    html += '<p class="vault-copy status-dim">After install, enable the plugin in Obsidian &rarr; Settings &rarr; Community Plugins.</p>';

    // VO-DESKTOP-WRAPPER-PLUGIN-CONTROLS-OBSIDIAN-HANDOFF-PR-1 —
    // narrow "next step" handoff to the existing open-obsidian
    // seam. Gated on the SAME truth the Vault-card Open-in-
    // Obsidian button and the Local integrations quick action use:
    // ready + canWrite + obsidian_open_supported + obsidian_
    // installed. No plugin-specific approximation.
    //
    // Dispatch path: vaultAction('open-obsidian') → existing POST
    // /dashboard/vault/open-obsidian. No new route, no new
    // preload method, no new ipcMain.handle, no duplicated fetch.
    //
    // Deliberately sits in the helper/reminder area AFTER the
    // result region and enablement reminder — it reads as a
    // handoff, NOT a plugin mutation. No data-plugin-action
    // attribute is used (avoids being treated as a fourth
    // mutation button by the action-row delegate loop below).
    var handoffState = (currentVaultData && currentVaultData.state) || {};
    var handoffAuth = (currentVaultData && currentVaultData._auth) || {};
    var handoffCanWrite = handoffAuth.can_write === true;
    if (shouldRenderObsidianQuickAction(handoffState, handoffCanWrite)) {
      html += '<div class="plugin-handoff" data-plugin-handoff-kind="open-obsidian">';
      html += '<p class="vault-copy status-dim plugin-handoff-label">Next step</p>';
      html += '<button type="button" class="btn-sm btn-ghost plugin-handoff-btn" '
        + 'data-plugin-handoff="open-obsidian">'
        + 'Open current vault in Obsidian'
        + '</button>';
      html += '</div>';
    }

    body.innerHTML = html;

    // Wire button clicks AFTER the HTML is committed — binds only
    // when the bridge is present, since renderPluginStatus is only
    // called from the has-wrapper branch of renderPluginControls.
    var btns = body.querySelectorAll('[data-plugin-action]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function() {
        pluginAction(this.getAttribute('data-plugin-action'));
      });
    }

    // VO-DESKTOP-WRAPPER-PLUGIN-CONTROLS-OBSIDIAN-HANDOFF-PR-1 —
    // handoff click wiring. Separate selector from data-plugin-
    // action so the existing mutation-button delegate above is
    // untouched and the handoff is not counted as a plugin
    // mutation. Dispatch-time recheck: re-run the same truthful
    // gate against LIVE currentVaultData before calling
    // vaultAction. Guards against state drift between render
    // and click (tenant switch, vault disable, Obsidian
    // uninstall) — a stale click must NOT route through to
    // open-obsidian against a vault that no longer satisfies
    // the gate.
    var handoffBtn = body.querySelector('[data-plugin-handoff="open-obsidian"]');
    if (handoffBtn) {
      handoffBtn.addEventListener('click', function() {
        var liveState = (currentVaultData && currentVaultData.state) || {};
        var liveAuth = (currentVaultData && currentVaultData._auth) || {};
        if (!shouldRenderObsidianQuickAction(liveState, liveAuth.can_write === true)) {
          return;
        }
        vaultAction('open-obsidian');
      });
    }
  }

  function pluginAction(kind) {
    if (pluginActionInFlight) return;
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper) return;  // defense in depth — buttons shouldn't exist here

    // Defense in depth: run the SAME mismatch check the render
    // layer used against the cached lastPluginStatus. Covers all
    // three divergence modes (dashboard_vault_unset, tenant_mismatch,
    // AND vault_root_mismatch) — a DevTools re-enabled click or a
    // stale render can never route through to the bridge while the
    // dashboard/desktop views disagree. No logic drift — one function
    // defines the gate, both render and dispatch consult it.
    if (!lastPluginStatus) {
      // Status never rendered — nothing to act on. Shouldn't be
      // reachable via a real button click (buttons don't exist
      // before renderPluginStatus runs), but defensive anyway.
      var noStatusEl = document.getElementById('vault-plugin-result');
      if (noStatusEl) {
        noStatusEl.innerHTML = '<div class="status-err">Refused &mdash; plugin status has not been loaded yet.</div>';
      }
      return;
    }
    var dispatchMismatch = pluginTenantMismatchReason(lastPluginStatus);
    if (dispatchMismatch) {
      var refusedEl = document.getElementById('vault-plugin-result');
      if (refusedEl) {
        refusedEl.innerHTML = '<div class="status-err">Refused &mdash; '
          + esc(pluginTenantMismatchMessage(dispatchMismatch, lastPluginStatus))
          + '</div>';
      }
      return;
    }

    var call;
    if (kind === 'install') call = window.voDesktop.installObsidianPlugin();
    else if (kind === 'update') call = window.voDesktop.updateObsidianPlugin();
    else if (kind === 'remove') call = window.voDesktop.removeObsidianPlugin();
    else return;

    // Bump the read generation so any in-flight
    // renderPluginControls() read at an older generation drops
    // when it resolves — an action's post-mutation result is the
    // new authoritative state; a pre-action read must not arrive
    // late and paint stale state over it.
    pluginReadGeneration += 1;

    // Capture dispatch identity. Between dispatch and promise
    // resolution the operator may switch tenants or the dashboard
    // may reload a different vault_root. Applying result.status
    // back into the DOM in that case would paint tenant A's plugin
    // status under tenant B's Vault tab — exactly the kind of
    // cross-tenant drift the harvest UI's lastHarvestResult
    // identity-stamp already guards against.
    var dispatchTenantId = (typeof getTenantId === 'function' ? (getTenantId() || '') : '');
    var dispatchVaultRoot = ((currentVaultData && currentVaultData.state && currentVaultData.state.vault_root) || '');

    function identityStillMatches() {
      var nowTenantId = (typeof getTenantId === 'function' ? (getTenantId() || '') : '');
      var nowVaultRoot = ((currentVaultData && currentVaultData.state && currentVaultData.state.vault_root) || '');
      return nowTenantId === dispatchTenantId && nowVaultRoot === dispatchVaultRoot;
    }

    pluginActionInFlight = true;
    var btns = document.querySelectorAll('[data-plugin-action]');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;

    var pending = document.getElementById('vault-plugin-result');
    if (pending) pending.innerHTML = '<div class="status-dim">' + esc(kind) + 'ing plugin&hellip;</div>';

    if (!call || typeof call.then !== 'function') {
      pluginActionInFlight = false;
      if (pending) pending.innerHTML = '<div class="status-err">Desktop bridge returned a non-promise for ' + esc(kind) + '.</div>';
      return;
    }

    call.then(function(result) {
      pluginActionInFlight = false;
      // Identity check: if the operator switched tenants or the
      // dashboard reloaded a different vault between dispatch and
      // now, drop the result silently — painting here would be a
      // cross-tenant UI bleed.
      //
      // BUT the current session's card body may be stuck on the
      // "A plugin action is in progress" placeholder painted by
      // the in-flight read-suppression guard in
      // renderPluginControls(). Now that pluginActionInFlight is
      // false, dispatch a fresh render for the CURRENT session so
      // the placeholder doesn't linger indefinitely. Also refresh
      // the upper integrations-panel plugin block so its "health
      // at a glance" summary doesn't stay frozen on the pre-
      // action snapshot.
      if (!identityStillMatches()) {
        renderPluginControls();
        refreshIntegrationVoPluginBlock(null);
        return;
      }

      if (!result || typeof result !== 'object') {
        if (pending) pending.innerHTML = '<div class="status-err">Desktop bridge returned empty result.</div>';
        renderPluginControls();
        refreshIntegrationVoPluginBlock(null);
        return;
      }
      // Rerender from the returned status (never a refetch). The
      // desktop LifecycleActionResult always includes a fresh
      // PluginStatus, so the next button states come from the same
      // machine that decided whether the action succeeded. The
      // integrations-panel plugin block is refreshed from the SAME
      // status — no separate bridge read, no drift risk between the
      // two cards.
      if (result.status) {
        renderPluginStatus(result.status);
        refreshIntegrationVoPluginBlock(result.status);
      }
      var resultEl = document.getElementById('vault-plugin-result');
      if (resultEl) {
        var cls = result.ok ? 'status-ok' : 'status-err';
        var prefix = result.ok ? '&#10003; ' : '';
        var message = result.message || (result.ok ? 'Action completed.' : 'Action failed.');
        resultEl.innerHTML = '<div class="' + cls + '">' + prefix + esc(message) + '</div>';
      }
    }, function(err) {
      pluginActionInFlight = false;
      // Same stale-session drop + placeholder recovery on the
      // error path — AND refresh the integrations panel.
      if (!identityStillMatches()) {
        renderPluginControls();
        refreshIntegrationVoPluginBlock(null);
        return;
      }
      var resultEl = document.getElementById('vault-plugin-result');
      if (resultEl) resultEl.innerHTML = '<div class="status-err">Plugin action failed: ' + esc(err && err.message || String(err)) + '</div>';
      // Best-effort re-read so button states match reality.
      renderPluginControls();
      refreshIntegrationVoPluginBlock(null);
    });
  }

  // ── Local integration status (VO-LOCAL-DASHBOARD-LOCAL-INTEGRATION-STATUS-PR-1) ──
  //
  // Read-only three-pane overview of the local integration stack.
  // Deliberately isolated from the plugin-controls card's state
  // machine — this panel has no actions, no tenant-vault gating,
  // no stale-session placeholder recovery. It's a straight
  // snapshot of three independent product contracts:
  //
  //   - AppStatus         (Obsidian app, desktop/src/obsidian-app.ts)
  //   - PluginStatus      (VO Review plugin, desktop/src/obsidian-plugin.ts)
  //   - VoAppStatus       (Verity One app, desktop/src/vo-app.ts)
  //
  // Each contract's distinct kinds are preserved in the copy
  // — NEVER flattened into a lossy "healthy/unhealthy" enum
  // (the three products reach different terminal states and each
  // distinction is load-bearing for honest diagnosis).

  // Per-block generation counters. Each of the three integration
  // blocks (Obsidian app / VO plugin / VO app) has its OWN counter
  // so a refresh targeting one block never invalidates in-flight
  // reads for the other two. Concrete hazard without this split:
  // refreshIntegrationVoPluginBlock bumps the shared counter for
  // a plugin-only repaint, and any Obsidian-app / VO-app reads
  // still waiting on their latest-version network lookup would
  // drop silently on resolution, leaving those cards stuck on
  // "Loading…" indefinitely.
  var integrationObsidianAppReadGeneration = 0;
  var integrationPluginReadGeneration = 0;
  var integrationVoAppReadGeneration = 0;

  function renderLocalIntegrationStatus() {
    var obsEl = document.getElementById('integration-obsidian-app-body');
    var pluginEl = document.getElementById('integration-vo-plugin-body');
    var voEl = document.getElementById('integration-vo-app-body');
    if (!obsEl || !pluginEl || !voEl) return;

    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper) {
      // Browser mode. Do NOT pretend to inspect local state — the
      // plain browser has no way to read any of these three
      // contracts. Paint the same honest fallback in all three
      // blocks so the tenant sees a consistent "desktop app
      // required" message.
      var fallback = '<div class="empty">Local integration status is available in the desktop app. Open the Verity One desktop app to see whether Obsidian, the VO Review plugin, and the Verity One app itself are current.</div>';
      obsEl.innerHTML = fallback;
      pluginEl.innerHTML = fallback;
      voEl.innerHTML = fallback;
      return;
    }

    // VO-DESKTOP-WRAPPER-OPEN-LOCAL-THING-PR-1 — delegated click
    // listener for the integration-block reveal buttons. Installed
    // ONCE per card mount via a __voRevealDelegate flag on the
    // card element, so repeat renderLocalIntegrationStatus() calls
    // (tab switch / action-triggered refresh / plugin status
    // re-read) cannot stack duplicate listeners. The card itself
    // is rebuilt by renderVault() — each rebuild is a fresh
    // element, so the flag is naturally scoped to the card
    // instance.
    //
    // Click target: any element carrying
    // data-integration-reveal-path. walk up via .closest() so a
    // click on the button's label text still resolves. Calls
    // the EXISTING window.voDesktop.revealPath; no new preload
    // method, no new ipcMain.handle, no new dashboard route.
    var integrationsCard = document.getElementById('vault-integration-status-card');
    if (integrationsCard && !integrationsCard.__voRevealDelegate) {
      integrationsCard.__voRevealDelegate = true;
      integrationsCard.addEventListener('click', function(ev) {
        var target = ev.target;
        // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-QUICK-ACTIONS-PR-1 —
        // quick-action branch. Checked FIRST so a quick-action
        // click never falls through to refresh or reveal. Each
        // branch routes to an EXISTING seam:
        //   - 'open-obsidian' → vaultAction('open-obsidian') →
        //     POST /dashboard/vault/open-obsidian (pre-existing
        //     route; no new endpoint introduced).
        //   - 'plugin-controls' → scroll the existing plugin
        //     controls card into view. The <a href="#...">
        //     already delivers the browser-native scroll; this
        //     branch adds focus movement so keyboard users land
        //     at the card. It does NOT dispatch any plugin
        //     mutation — the plugin card owns those buttons +
        //     their mismatch/in-flight discipline.
        var qaEl = target && typeof target.closest === 'function'
          ? target.closest('[data-integration-quick-action]')
          : null;
        if (qaEl && integrationsCard.contains(qaEl)) {
          var qa = qaEl.getAttribute('data-integration-quick-action') || '';
          if (qa === 'open-obsidian') {
            ev.preventDefault();
            ev.stopPropagation();
            // Dispatch-time gate recheck — between render and
            // click the vault state can drift (tenant switch,
            // vault change, Obsidian uninstall). Reuses the same
            // pure gate the renderer used at paint time. If the
            // gate now fails, refuse the click so vaultAction
            // doesn't POST to open-obsidian against state that
            // no longer supports it.
            var liveState = (currentVaultData && currentVaultData.state) || {};
            var liveAuth = (currentVaultData && currentVaultData._auth) || {};
            if (!shouldRenderObsidianQuickAction(liveState, liveAuth.can_write === true)) {
              return;
            }
            // Reuses the EXISTING vaultAction dispatcher → the
            // EXISTING /dashboard/vault/open-obsidian route. No
            // new seam.
            vaultAction('open-obsidian');
            return;
          }
          if (qa === 'plugin-controls') {
            // Let the <a href="#vault-plugin-controls-card"> do
            // the browser-native scroll. We do NOT call
            // preventDefault, so degraded-JS and keyboard-Enter
            // behavior both still work. Augment with focus
            // movement so accessibility tooling lands on the
            // card. No mutation dispatched; no bypass of the
            // plugin card's existing mismatch/in-flight posture.
            var card = document.getElementById('vault-plugin-controls-card');
            if (card && typeof card.focus === 'function') {
              // Move focus AFTER the default scroll has queued.
              setTimeout(function() {
                try { card.focus({ preventScroll: true }); } catch (e) {}
              }, 0);
            }
            return;
          }
          return;
        }
        // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
        // manual per-block recheck routed through the same card
        // delegate. Checked BEFORE the reveal branch so a refresh
        // click never accidentally falls through to reveal. Each
        // block dispatches ONLY its matching EXISTING read seam
        // (getObsidianAppStatus / getObsidianPluginStatus /
        // getVoAppStatus) — no new preload methods, no new IPC
        // channels. Plugin branch reuses refreshIntegrationVoPlugin-
        // Block so the plugin card's generation-bump + mismatch
        // safety discipline stays the single source of truth. No
        // global "refresh all" affordance is added here.
        var refreshEl = target && typeof target.closest === 'function'
          ? target.closest('[data-integration-refresh]')
          : null;
        if (refreshEl && integrationsCard.contains(refreshEl)) {
          ev.preventDefault();
          ev.stopPropagation();
          var block = refreshEl.getAttribute('data-integration-refresh') || '';
          // Dispatch-time wrapper presence recheck. The slot is only
          // populated in wrapper mode, but if the bridge vanished
          // between render and click, refuse the call rather than
          // throwing.
          if (typeof window.voDesktop !== 'object' || !window.voDesktop) {
            return;
          }
          if (block === 'obsidian-app') {
            refreshIntegrationObsidianAppBlock();
          } else if (block === 'plugin') {
            // Suppress plugin refresh while a lifecycle action is in
            // flight. Refreshing mid-mutation would race with the
            // action's own post-completion refresh AND could paint
            // a PRE-mutation snapshot over the in-progress
            // placeholder. The action's completion callback will
            // refresh the block; until then keep the honest
            // in-flight copy. (=== true form keeps the indexOf
            // anchor tests in renderLocalIntegrationStatus body
            // unambiguous.)
            if (pluginActionInFlight === true) {
              var pEl = document.getElementById('integration-vo-plugin-body');
              if (pEl) pEl.innerHTML = '<div class="status-dim">A plugin action is in progress&hellip; the status will refresh when it completes.</div>';
            } else {
              // refreshIntegrationVoPluginBlock(null) re-runs the
              // getObsidianPluginStatus read through the same
              // renderVoPluginBlock renderer, which in turn re-
              // applies pluginTenantMismatchReason at render time.
              // Manual refresh therefore cannot bypass the tenant/
              // root mismatch gate.
              refreshIntegrationVoPluginBlock(null);
            }
          } else if (block === 'vo-app') {
            refreshIntegrationVoAppBlock();
          }
          return;
        }
        var revealEl = target && typeof target.closest === 'function'
          ? target.closest('[data-integration-reveal-path]')
          : null;
        if (!revealEl) return;
        if (!integrationsCard.contains(revealEl)) return;
        var path = revealEl.getAttribute('data-integration-reveal-path') || '';
        var kind = revealEl.getAttribute('data-integration-reveal-kind') || '';
        if (!path) return;
        // Honest inline status target — sits next to the button.
        var statusEl = revealEl.parentNode
          ? revealEl.parentNode.querySelector('[data-integration-reveal-status]')
          : null;
        if (statusEl) statusEl.innerHTML = '';
        ev.preventDefault();
        ev.stopPropagation();
        // Guard: if the wrapper disappeared between render and
        // click (rare — same tab, but be honest), surface a clear
        // error rather than throwing.
        if (typeof window.voDesktop !== 'object' || !window.voDesktop
            || typeof window.voDesktop.revealPath !== 'function') {
          if (statusEl) statusEl.innerHTML = '<span class="status-err">Desktop bridge unavailable.</span>';
          return;
        }
        // VO-DESKTOP-WRAPPER-OPEN-LOCAL-THING-PR-1 — dispatch-time
        // guard for plugin reveals. The button's path attribute
        // was baked in at render time (against the tenant + vault
        // state that was authoritative THEN). Between render and
        // click the operator can switch tenants, the dashboard's
        // vault_root can drift, or a plugin action on another
        // tab could have changed install_dir. A stale click here
        // could otherwise reveal another tenant's plugin folder
        // — exactly the mismatch branch that renderVoPluginBlock
        // defends against at render time.
        //
        // Re-run the same pluginTenantMismatchReason gate and
        // also verify the button's stored path still matches the
        // current authoritative snapshot (lastPluginStatus). If
        // either fails, refuse to reveal, paint an honest status
        // message, and kick a refresh so the stale UI catches up.
        //
        // App reveals (Obsidian install_path) are machine-scoped
        // — the AppStatus contract is not tenant-bound — so no
        // per-click recheck is needed for kind === 'app'.
        if (kind === 'plugin') {
          var stale = null;
          if (!lastPluginStatus || typeof lastPluginStatus !== 'object') {
            stale = 'Plugin status is not current. Refreshing…';
          } else if (pluginTenantMismatchReason(lastPluginStatus)) {
            stale = 'Plugin reveal blocked: ' + pluginTenantMismatchMessage(
              pluginTenantMismatchReason(lastPluginStatus),
              lastPluginStatus,
            );
          } else if (lastPluginStatus.install_dir !== path) {
            stale = 'Plugin folder path changed since this view was rendered. Refreshing…';
          }
          if (stale) {
            if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(stale) + '</span>';
            // Refresh the plugin block so the UI re-reflects the
            // authoritative state (a fresh mismatch message, or
            // the new install_dir, or a hidden reveal button).
            refreshIntegrationVoPluginBlock(null);
            return;
          }
        }
        window.voDesktop.revealPath(path).then(function(r) {
          var res = r || {};
          if (res.ok) {
            if (statusEl) statusEl.innerHTML = '<span class="status-ok">&#10003; revealed in Finder/Explorer</span>';
          } else {
            if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc(res.reason || 'reveal refused') + '</span>';
          }
        }).catch(function(err) {
          if (statusEl) statusEl.innerHTML = '<span class="status-err">' + esc((err && err.message) || String(err)) + '</span>';
        });
      });
    }

    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
    // populate the three refresh slots with small per-block buttons.
    // Reached only on the hasWrapper path; the browser-mode branch
    // above returns before this point, so slots stay empty in
    // browser mode (no dead control). The buttons are tagged with
    // data-integration-refresh=<block> and routed through the
    // delegated click listener above.
    var refreshBtnHtml = function(blockKind, title) {
      return '<button type="button" class="btn-xs btn-ghost integration-refresh-btn" '
        + 'data-integration-refresh="' + esc(blockKind) + '" '
        + 'title="' + esc(title) + '">Refresh</button>';
    };
    var obsRefreshSlot = document.getElementById('integration-obsidian-app-refresh');
    if (obsRefreshSlot) obsRefreshSlot.innerHTML = refreshBtnHtml('obsidian-app', 'Recheck Obsidian app status');
    var pluginRefreshSlot = document.getElementById('integration-vo-plugin-refresh');
    if (pluginRefreshSlot) pluginRefreshSlot.innerHTML = refreshBtnHtml('plugin', 'Recheck VO Review plugin status');
    var voRefreshSlot = document.getElementById('integration-vo-app-refresh');
    if (voRefreshSlot) voRefreshSlot.innerHTML = refreshBtnHtml('vo-app', 'Recheck Verity One app status');

    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-QUICK-ACTIONS-PR-1 —
    // per-block quick-action slot population. Uses the SAME
    // currentVaultData the vault card consumes, so the Obsidian
    // gate here is the same one the pre-existing "Open in
    // Obsidian" button in the vault ready-state block uses (line
    // ~2957): status_kind === 'ready' + canWrite + obsidian_open_
    // supported + obsidian_installed. If any of those is false,
    // render no Obsidian quick action — no dead affordance.
    //
    // The plugin quick action is always rendered in wrapper mode:
    // it's a navigation affordance to an existing card that owns
    // its own mismatch/in-flight discipline, so no pre-gate here.
    //
    // VO app block has no quick-action slot at all (structural
    // enforcement that this PR did not add a VO app action).
    var obsQaSlot = document.getElementById('integration-obsidian-app-quick-actions');
    if (obsQaSlot) {
      var qaState = (currentVaultData && currentVaultData.state) || {};
      var qaAuth = (currentVaultData && currentVaultData._auth) || {};
      var qaCanWrite = qaAuth.can_write === true;
      if (shouldRenderObsidianQuickAction(qaState, qaCanWrite)) {
        obsQaSlot.innerHTML =
          '<button type="button" class="btn-xs btn-ghost integration-quick-action-btn" '
            + 'data-integration-quick-action="open-obsidian">'
            + 'Open current vault in Obsidian'
            + '</button>';
      } else {
        obsQaSlot.innerHTML = '';
      }
    }
    var pluginQaSlot = document.getElementById('integration-vo-plugin-quick-actions');
    if (pluginQaSlot) {
      // Anchor jump to the existing plugin-controls card — the
      // browser-native href="#id" behavior scrolls the target into
      // view. No new JS, no new routing — this is pure in-page
      // navigation. Uses data-integration-quick-action="plugin-
      // controls" in addition to the href so the card delegate can
      // add focus movement on click (accessibility polish) without
      // breaking the degraded-JS anchor behavior.
      pluginQaSlot.innerHTML =
        '<a href="#vault-plugin-controls-card" '
          + 'class="btn-xs btn-ghost integration-quick-action-btn" '
          + 'data-integration-quick-action="plugin-controls">'
          + 'Plugin controls'
          + '</a>';
    }
    // Obsidian-app + VO-app generations: INDEPENDENT captures —
    // one per block. A refresh of one never invalidates the other.
    integrationObsidianAppReadGeneration += 1;
    var obsGen = integrationObsidianAppReadGeneration;
    integrationVoAppReadGeneration += 1;
    var voGen = integrationVoAppReadGeneration;

    obsEl.innerHTML = '<div class="status-dim">Loading Obsidian app status&hellip;</div>';
    voEl.innerHTML = '<div class="status-dim">Loading Verity One app status&hellip;</div>';

    // Plugin block: SUPPRESS the status read while a plugin
    // action is in flight. Otherwise a tab-away-and-back during
    // install/update/remove would dispatch a fresh
    // getObsidianPluginStatus() that could paint a PRE-mutation
    // snapshot into the upper summary while the lower plugin-
    // controls card is intentionally showing "A plugin action is
    // in progress…" — the two cards would contradict each other.
    //
    // When the action resolves, pluginAction's completion callback
    // already calls refreshIntegrationVoPluginBlock(result.status)
    // to paint the authoritative post-mutation status. Until then,
    // the summary block shows an honest in-flight placeholder and
    // the generation counter is NOT bumped (nothing to
    // invalidate).
    if (pluginActionInFlight) {
      pluginEl.innerHTML = '<div class="status-dim">A plugin action is in progress&hellip; the status will refresh when it completes.</div>';
    } else {
      integrationPluginReadGeneration += 1;
      var pluginGen = integrationPluginReadGeneration;
      pluginEl.innerHTML = '<div class="status-dim">Loading VO Review plugin status&hellip;</div>';
      dispatchIntegrationRead(
        window.voDesktop.getObsidianPluginStatus,
        function() { return pluginGen === integrationPluginReadGeneration; },
        pluginEl,
        renderVoPluginBlock,
      );
    }

    // Obsidian-app and VO-app reads are ALWAYS dispatched — they
    // are unrelated to plugin mutations, and suppressing them
    // here would leave their cards stuck on prior state for the
    // duration of a plugin action. Each paints into its own block
    // when it resolves.
    dispatchIntegrationRead(
      window.voDesktop.getObsidianAppStatus,
      function() { return obsGen === integrationObsidianAppReadGeneration; },
      obsEl,
      renderObsidianAppBlock,
    );
    dispatchIntegrationRead(
      window.voDesktop.getVoAppStatus,
      function() { return voGen === integrationVoAppReadGeneration; },
      voEl,
      renderVoAppBlock,
    );
  }

  // The checkStillCurrent parameter is a closure that returns true
  // iff the read's captured per-block generation still equals the
  // counter's live value. The dispatcher stays agnostic to which
  // block's counter it's comparing against — each call site
  // supplies its own closure.
  function dispatchIntegrationRead(method, checkStillCurrent, container, renderer) {
    try {
      var p = method();
      if (!p || typeof p.then !== 'function') {
        container.innerHTML = '<div class="status-err">Desktop bridge returned a non-promise.</div>';
        return;
      }
      p.then(function(status) {
        if (!checkStillCurrent()) return; // superseded
        renderer(container, status);
      }, function(err) {
        if (!checkStillCurrent()) return;
        container.innerHTML = '<div class="status-err">Could not read status: '
          + esc(err && err.message || 'unknown error') + '</div>';
      });
    } catch (e) {
      container.innerHTML = '<div class="status-err">Bridge call threw: '
        + esc(e && e.message || 'unknown error') + '</div>';
    }
  }

  // ── Per-contract copy (each kind preserved verbatim) ────────────

  function obsidianAppHeadline(s) {
    switch (s && s.kind) {
      case 'not_installed':             return 'Not installed on this computer.';
      case 'installed_current':         return 'Installed and current.';
      case 'installed_outdated':        return 'Installed, update available.';
      case 'installed_unknown_version': return 'Installed, version unknown.';
      case 'latest_unknown':            return 'Installed; could not check for a newer version.';
      case 'unsupported_platform':      return 'This platform is not probed by the desktop app.';
      default:                          return 'Status unavailable.';
    }
  }

  function voPluginHeadline(s) {
    switch (s && s.kind) {
      case 'not_installed':              return 'Not installed in this vault.';
      case 'installed_current':          return 'Installed and current.';
      case 'installed_outdated':         return 'Installed, bundled version is newer.';
      case 'installed_unknown':          return 'Installed; installed manifest could not be read.';
      case 'unavailable_no_vault':       return 'No vault configured on this machine.';
      case 'unavailable_bundle_missing': return 'Bundled plugin missing from this build.';
      default:                           return 'Status unavailable.';
    }
  }

  function voAppHeadline(s) {
    switch (s && s.kind) {
      case 'current':                     return 'Running the current release.';
      case 'outdated':                    return 'Update available.';
      case 'local_ahead_of_latest':       return 'Running a build newer than the latest published release.';
      case 'latest_unknown':              return 'Could not check for a newer version.';
      case 'local_version_unknown':      return 'Could not determine the local version.';
      case 'release_channel_unavailable': return voAppUnavailableHeadline(s);
      default:                            return 'Status unavailable.';
    }
  }

  // Reason-aware headline for release_channel_unavailable — kept
  // in sync with the resolver reasons in
  // desktop/src/vo-app.ts (VO-DESKTOP-RELEASE-CHANNEL-SELECTION-PR-1).
  // The default branch keeps the pre-selection copy so the existing
  // integration-card tests and copy pins don't regress for the
  // no_release_channel_configured (legacy) reason.
  function voAppUnavailableHeadline(s) {
    switch (s && s.reason) {
      case 'channel_not_publicly_wired':
        return 'Selected release channel is not publicly wired yet.';
      case 'custom_incomplete':
        return 'Custom release channel is incomplete — both manifest and page URLs required.';
      case 'custom_invalid_url':
        return 'Custom release channel has an invalid URL — must be absolute http(s).';
      case 'no_release_channel_configured':
      default:
        return 'Release channel not live in this build.';
    }
  }

  // Shared "meta row" helper — a single label/value row, with an
  // honest absent-value placeholder instead of a silent blank.
  // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-QUICK-ACTIONS-PR-1 —
  // Pure decision for whether the Obsidian quick action should
  // render inside the integrations card. Mirrors the exact gate
  // the pre-existing vault ready-state "Open in Obsidian" button
  // uses at line ~2957:
  //   - state.status_kind === 'ready'
  //   - canWrite === true
  //   - state.obsidian_open_supported === true
  //   - state.obsidian_installed === true
  // Any of these falsy (including null / undefined / other
  // falsy values) → no quick action. Strict === true on the two
  // Obsidian fields because the contract allows null (unknown),
  // which must NOT render an affordance whose click would fail.
  function shouldRenderObsidianQuickAction(state, canWrite) {
    if (!state || typeof state !== 'object') return false;
    if (state.status_kind !== 'ready') return false;
    if (canWrite !== true) return false;
    if (state.obsidian_open_supported !== true) return false;
    if (state.obsidian_installed !== true) return false;
    return true;
  }

  function integrationMetaRow(label, value) {
    var v = (value === null || value === undefined || value === '') ? '&mdash;' : esc(String(value));
    return '<div class="structure-row">'
      + '<span class="structure-label">' + esc(label) + '</span>'
      + '<span class="structure-meta">' + v + '</span>'
      + '</div>';
  }

  // VO-DESKTOP-WRAPPER-OPEN-LOCAL-THING-PR-1 — narrow reveal
  // affordance over the existing window.voDesktop.revealPath
  // bridge. Renders a small button tagged with the absolute
  // path to reveal; the delegated click listener on the Local
  // integrations card reads data-integration-reveal-path and
  // calls revealPath(...). No new preload method, no new
  // ipcMain.handle, no new route — this is a renderer-side
  // composition over the bridge already shipped.
  //
  // Only called when path is a truthy string — callers are
  // responsible for the path-bearing gate (Obsidian block
  // requires install_path; plugin block requires install_dir
  // AND a non-mismatch state).
  //
  // The kind arg feeds data-integration-reveal-kind so the
  // click delegate can apply kind-specific dispatch-time guards.
  // Currently "plugin" reveals re-run the tenant/root mismatch
  // check at click time (state may have drifted since render),
  // while "app" reveals are machine-wide (Obsidian install_path
  // is not tenant-scoped) and need no per-click recheck.
  function renderIntegrationRevealButton(path, label, kind) {
    return '<div class="integration-reveal-row" style="margin-top:.4rem">'
      + '<button type="button" class="btn-xs btn-ghost integration-reveal-btn" '
      + 'data-integration-reveal-path="' + esc(path) + '" '
      + 'data-integration-reveal-label="' + esc(label) + '" '
      + 'data-integration-reveal-kind="' + esc(kind) + '">'
      + 'Reveal ' + esc(label)
      + '</button>'
      + '<span class="integration-reveal-status status-dim" '
      + 'data-integration-reveal-status="1" '
      + 'style="margin-left:.6rem"></span>'
      + '</div>';
  }

  function renderObsidianAppBlock(container, s) {
    if (!s || typeof s !== 'object') {
      container.innerHTML = '<div class="status-err">Empty Obsidian app status payload.</div>';
      return;
    }
    var html = '<p class="vault-copy integration-headline">' + esc(obsidianAppHeadline(s)) + '</p>';
    // Only surface fields that are meaningful for the kind — don't
    // pretend we know a version when the contract says we don't.
    if (s.install_path) html += integrationMetaRow('Install path', s.install_path);
    if (s.installed_version !== null && s.installed_version !== undefined) {
      html += integrationMetaRow('Installed version', s.installed_version);
    }
    if (s.latest_version !== null && s.latest_version !== undefined) {
      html += integrationMetaRow('Latest known', s.latest_version);
    }
    if (s.update_available === true) {
      html += integrationMetaRow('Update available', 'yes');
    }
    // VO-DESKTOP-WRAPPER-OPEN-LOCAL-THING-PR-1: path-gated reveal.
    // install_path is the authoritative local filesystem path the
    // Obsidian status contract exposes; when present, surface a
    // small "Reveal app" affordance that hands the exact same
    // path to window.voDesktop.revealPath. Absent path → no
    // button (browser fallback already handles hasWrapper = false
    // in renderLocalIntegrationStatus, so we never reach here
    // without a wrapper).
    if (s.install_path) {
      html += renderIntegrationRevealButton(s.install_path, 'app', 'app');
    }
    container.innerHTML = html;
  }

  function integrationPluginMismatchHeadline(reason) {
    switch (reason) {
      case 'dashboard_vault_unset':
        return 'Dashboard has no vault configured for this tenant.';
      case 'tenant_mismatch':
        return 'Configured vault belongs to a different tenant.';
      case 'vault_root_mismatch':
        return 'Desktop app is pointed at a different vault.';
      default:
        return "Plugin status reflects a different tenant's vault.";
    }
  }

  function renderVoPluginBlock(container, s) {
    if (!s || typeof s !== 'object') {
      container.innerHTML = '<div class="status-err">Empty VO Review plugin status payload.</div>';
      return;
    }

    // Tenant-context mismatch: the desktop seam's PluginStatus
    // reflects the MACHINE's configured vault, not necessarily the
    // current dashboard tenant's vault. Rendering the raw
    // install_dir / installed_version here under a mismatched
    // tenant would leak tenant A's filesystem path into tenant B's
    // "Local integrations" card — exactly the cross-tenant bleed
    // the actionable plugin card guards against. Show an honest
    // mismatch message INSTEAD of the plugin details when
    // pluginTenantMismatchReason() fires.
    //
    // Note: we reuse only the PURE pluginTenantMismatchReason /
    // pluginTenantMismatchMessage helpers — the integration block
    // does NOT inherit the plugin card's action-gating state
    // machine (pluginActionInFlight / lastPluginStatus /
    // pluginReadGeneration / stale-session placeholder recovery),
    // which stay plugin-card-specific.
    var mismatchReason = pluginTenantMismatchReason(s);
    if (mismatchReason) {
      container.innerHTML =
        '<p class="vault-copy integration-headline">'
          + esc(integrationPluginMismatchHeadline(mismatchReason))
          + '</p>'
          + '<p class="vault-copy status-dim integration-plugin-mismatch" data-plugin-mismatch="'
          + esc(mismatchReason) + '">'
          + esc(pluginTenantMismatchMessage(mismatchReason, s))
          + '</p>';
      return;
    }

    var html = '<p class="vault-copy integration-headline">' + esc(voPluginHeadline(s)) + '</p>';
    if (s.bundled_version) html += integrationMetaRow('Bundled version', s.bundled_version);
    if (s.installed_version !== null && s.installed_version !== undefined) {
      html += integrationMetaRow('Installed version', s.installed_version);
    }
    if (s.install_dir) html += integrationMetaRow('Install dir', s.install_dir);
    // VO-DESKTOP-WRAPPER-OPEN-LOCAL-THING-PR-1: path-gated reveal.
    // Only reachable here when the mismatch gate above passed, so
    // install_dir is safe to expose as a reveal target. The
    // mismatch branch above returns BEFORE this point, so a
    // different-tenant's install_dir can never flow into a
    // reveal affordance.
    if (s.install_dir) {
      html += renderIntegrationRevealButton(s.install_dir, 'plugin folder', 'plugin');
    }
    container.innerHTML = html;
  }

  // ── Post-action refresh hook for the integrations panel ─────────────
  //
  // pluginAction() updates the lower plugin-controls card directly
  // from the returned LifecycleActionResult.status, but WITHOUT
  // this helper the upper integrations panel's plugin block would
  // stay frozen on its pre-action snapshot until the next
  // renderVault() fires — producing contradictory UI where the
  // summary says "Not installed" while the controls card says
  // "Installed and current" after a successful install.
  //
  // Two call modes:
  //
  //   refreshIntegrationVoPluginBlock(result.status) — happy path,
  //     paint from the fresh status the action seam returned.
  //   refreshIntegrationVoPluginBlock(null) — stale-session drop
  //     or error recovery: dispatch a new bridge read so the
  //     block shows current machine state.
  // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
  // per-block manual recheck for the Obsidian app block. Mirrors
  // the refreshIntegrationVoPluginBlock shape without inheriting
  // the plugin-specific action-gating; AppStatus is machine-scoped
  // and has no tenant binding, so no mismatch gate applies here.
  //
  // Bumps ONLY the Obsidian-app block's generation counter so any
  // prior in-flight read drops before it can overwrite the paint
  // we're about to apply. The plugin and VO-app block counters
  // stay untouched; their reads keep their own freshness check.
  //
  // Browser-mode branch is defensive: the refresh slot is never
  // populated without a wrapper, so this path is unreachable in
  // practice, but we still refuse to dispatch if the bridge
  // vanished between render and click.
  function refreshIntegrationObsidianAppBlock() {
    var el = document.getElementById('integration-obsidian-app-body');
    if (!el) return;
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper || typeof window.voDesktop.getObsidianAppStatus !== 'function') return;
    integrationObsidianAppReadGeneration += 1;
    var myGen = integrationObsidianAppReadGeneration;
    el.innerHTML = '<div class="status-dim">Checking Obsidian app status&hellip;</div>';
    dispatchIntegrationRead(
      window.voDesktop.getObsidianAppStatus,
      function() { return myGen === integrationObsidianAppReadGeneration; },
      el,
      renderObsidianAppBlock,
    );
  }

  // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
  // per-block manual recheck for the Verity One app block. Same
  // shape as refreshIntegrationObsidianAppBlock against a
  // different read seam. VoAppStatus is also machine-scoped (it
  // describes the locally-installed VO app build) and has no
  // tenant binding.
  function refreshIntegrationVoAppBlock() {
    var el = document.getElementById('integration-vo-app-body');
    if (!el) return;
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper || typeof window.voDesktop.getVoAppStatus !== 'function') return;
    integrationVoAppReadGeneration += 1;
    var myGen = integrationVoAppReadGeneration;
    el.innerHTML = '<div class="status-dim">Checking Verity One app status&hellip;</div>';
    dispatchIntegrationRead(
      window.voDesktop.getVoAppStatus,
      function() { return myGen === integrationVoAppReadGeneration; },
      el,
      renderVoAppBlock,
    );
  }

  function refreshIntegrationVoPluginBlock(statusOrNull) {
    var el = document.getElementById('integration-vo-plugin-body');
    if (!el) return;  // Vault tab not current; nothing to paint into.
    // Bump ONLY the plugin block's counter — in BOTH the
    // status-paint and re-fetch paths — so any older in-flight
    // plugin read drops before it can overwrite the paint we're
    // about to apply. The Obsidian-app and VO-app block counters
    // stay untouched; their in-flight reads (possibly still
    // waiting on latest-version network lookups) keep their own
    // freshness check intact and will paint when they resolve.
    //
    // Concrete race this bump avoids: the integration panel
    // dispatches a plugin status read at gen=N, the user clicks
    // Install, the action resolves with
    // result.status = installed_current, this helper paints that
    // status, THEN the older plugin read resolves at gen=N
    // (unchanged), its checkStillCurrent closure still passes, and
    // it repaints the block back to not_installed.
    integrationPluginReadGeneration += 1;
    if (statusOrNull) {
      renderVoPluginBlock(el, statusOrNull);
      return;
    }
    // Re-fetch path. Guarded by wrapper presence; browser-mode
    // clients never reach pluginAction, so this branch's
    // wrapper-present assumption holds.
    var hasWrapper = typeof window.voDesktop === 'object' && window.voDesktop !== null;
    if (!hasWrapper) return;
    // VO-DESKTOP-WRAPPER-LOCAL-INTEGRATION-STATUS-REFRESH-PR-1 —
    // paint a block-local "Checking…" placeholder BEFORE
    // dispatching, so a manual refresh click (routed here for the
    // plugin block) gives the operator the same immediate pending
    // feedback the new Obsidian-app / VO-app helpers provide.
    //
    // Safe for the pre-existing callers too:
    //   - pluginAction's post-completion refresh passes a truthy
    //     statusOrNull, which returns above before reaching here.
    //   - pluginAction's error-recovery paths pass null; showing a
    //     brief "Checking…" placeholder while the bridge re-reads
    //     is consistent with every other refresh path in this
    //     file and is never misleading.
    //   - The dispatch-time stale-reveal refresh also benefits —
    //     the operator who just had a reveal rejected sees the
    //     block actively re-checking instead of frozen on stale
    //     state.
    el.innerHTML = '<div class="status-dim">Checking VO Review plugin status&hellip;</div>';
    var myGen = integrationPluginReadGeneration;
    dispatchIntegrationRead(
      window.voDesktop.getObsidianPluginStatus,
      function() { return myGen === integrationPluginReadGeneration; },
      el,
      renderVoPluginBlock,
    );
  }

  function renderVoAppBlock(container, s) {
    if (!s || typeof s !== 'object') {
      container.innerHTML = '<div class="status-err">Empty Verity One app status payload.</div>';
      return;
    }
    var html = '<p class="vault-copy integration-headline">' + esc(voAppHeadline(s)) + '</p>';
    if (s.local_version) html += integrationMetaRow('Local version', s.local_version);
    if (s.latest_version !== null && s.latest_version !== undefined) {
      html += integrationMetaRow('Latest known', s.latest_version);
    }
    if (s.update_available === true) {
      html += integrationMetaRow('Update available', 'yes');
    }
    container.innerHTML = html;
  }

  // ── Routines tab ──────────────────────────────────────────────────

  function fetchRoutines() {
    return fetch(dashUrl('/dashboard/routines'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data._auth) authMeta = data._auth;
        renderRoutines(data);
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load routines: ' + esc(err.message) + '</div>'; });
  }

  function renderRoutines(d) {
    var canWrite = d._auth && d._auth.can_write;
    var intent = takeDashboardIntent('routines');
    var activeFilter = normalizeRoutineFilter((intent && intent.filter) || 'all');
    var dayJournalFocus = activeFilter === 'day-journal';
    var html = '<h2 style="font-size:1.1rem;margin-bottom:1rem;">Routines</h2>';

    // Summary cards
    var s = d.summary || {};
    var djSummary = (d.day_journal && d.day_journal.summary) || {};
    var scheduleFailingCount = Number(s.failing_count || 0);
    var dayJournalFailingCount = Number(djSummary.failing_count || 0);
    var combinedFailingCount = scheduleFailingCount + dayJournalFailingCount;
    var combinedTotalCount = Number(s.total_count || 0) + Number(djSummary.total_count || 0);
    var combinedEnabledCount = Number(s.enabled_count || 0) + Number(djSummary.enabled_count || 0);
    var staleCount = Number(s.stale_count || 0);
    var dayJournalSchedulerStatus = d.day_journal && d.day_journal.notes && d.day_journal.notes.scheduler_status;
    var dayJournalSchedulerNeedsAttention = Number(djSummary.enabled_count || 0) > 0
      && dayJournalSchedulerStatus
      && dayJournalSchedulerStatus.status
      && dayJournalSchedulerStatus.status !== 'active'
      && dayJournalSchedulerStatus.status !== 'disabled';
    html += '<div class="stats" style="margin-bottom:1rem">';
    html += stat(combinedTotalCount, 'Total');
    html += stat(combinedEnabledCount, 'Enabled');
    html += statColored(combinedFailingCount, 'Failing', combinedFailingCount > 0 ? 'var(--red)' : 'var(--text)');
    html += statColored(staleCount, 'Stale (>24h)', staleCount > 0 ? 'var(--amber)' : 'var(--text)');
    html += '</div>';

    if (staleCount > 0 || scheduleFailingCount > 0 || dayJournalFailingCount > 0 || dayJournalSchedulerNeedsAttention) {
      html += '<div class="card" style="margin-bottom:1rem"><div class="card-title">Routine Hygiene</div>';
      if (scheduleFailingCount > 0) {
        html += '<div class="alert red alert-action-row"><span class="alert-icon">&#9632;</span><span class="alert-message">' + esc(String(scheduleFailingCount)) +
          ' enabled schedule routine(s) currently failing.</span><button type="button" class="btn-sm btn-ghost dashboard-mini-action" data-routine-filter="failing">Show Failing</button></div>';
      }
      if (dayJournalFailingCount > 0) {
        html += '<div class="alert red alert-action-row"><span class="alert-icon">&#9632;</span><span class="alert-message">' + esc(String(dayJournalFailingCount)) +
          ' day-journal routine(s) need attention in the panel below.</span><button type="button" class="btn-sm btn-ghost dashboard-mini-action" data-routine-filter="day-journal">View Day Journal</button></div>';
      }
      if (dayJournalSchedulerNeedsAttention) {
        var schedulerHygieneColor = dayJournalSchedulerStatus.status === 'error' || dayJournalSchedulerStatus.status === 'stale' ? 'red' : 'amber';
        html += '<div class="alert ' + schedulerHygieneColor + ' alert-action-row"><span class="alert-icon">' + (schedulerHygieneColor === 'red' ? '&#9632;' : '&#9650;') +
          '</span><span class="alert-message">' + esc(dayJournalSchedulerStatusMessage(dayJournalSchedulerStatus)) +
          '</span><button type="button" class="btn-sm btn-ghost dashboard-mini-action" data-routine-filter="day-journal">View Day Journal</button></div>';
      }
      if (staleCount > 0) {
        html += '<div class="alert amber alert-action-row"><span class="alert-icon">&#9650;</span><span class="alert-message">' + esc(String(staleCount)) +
          ' enabled routine(s) have not run in more than 24 hours.</span><button type="button" class="btn-sm btn-ghost dashboard-mini-action" data-routine-filter="stale">Show Stale</button></div>';
      }
      html += '<div class="empty" style="text-align:left;margin-top:.4rem">Review stale feeds, day-journal routine warnings, disable intentionally dormant schedules, or run a selected routine manually with an operator token.</div>';
      html += '</div>';
    }

    if (dayJournalFocus) {
      html += '<div class="focus-banner">Showing day-journal routines. VI schedule rows and VI run history are hidden in this focus view. <button type="button" class="btn-sm btn-ghost dashboard-mini-action" data-routine-filter="all">Show All Routines</button></div>';
    }
    html += renderDayJournalRoutinesPanel(d.day_journal, canWrite);
    if (d.notes && d.notes.schedule_mode === 'unavailable') {
      html += '<div class="alert amber" style="margin-bottom:1rem"><span class="alert-icon">&#9650;</span><span class="alert-message">VI schedule rows are unavailable on this node. Day-journal routines remain visible above.</span></div>';
    }

    if (dayJournalFocus) {
      html += '<div class="card card-dither"><div class="card-title">VI Schedules</div><div class="empty">VI schedule rows and VI run history are hidden while focusing the day-journal panel.</div></div>';
    } else {
      // Schedule list
      var schedules = d.schedules || [];
      var visibleSchedules = [];
      for (var si = 0; si < schedules.length; si++) {
        if (routineMatchesDashboardFilter(schedules[si], activeFilter)) visibleSchedules.push(schedules[si]);
      }
      if (activeFilter !== 'all') {
        html += '<div class="focus-banner">Showing ' + esc(routineFilterLabel(activeFilter).toLowerCase()) +
          ' routines. Use the chips below to change the triage view.</div>';
      }
      html += '<div class="card card-dither"><div class="card-title">Schedules (' + esc(String(visibleSchedules.length)) + ' / ' + esc(String(schedules.length)) + ')</div>';
      html += '<div class="filter-bar">' +
        routineFilterChip('all', 'All', schedules, activeFilter) +
        routineFilterChip('failing', 'Failing', schedules, activeFilter) +
        routineFilterChip('stale', 'Stale', schedules, activeFilter) +
        routineFilterChip('disabled', 'Disabled', schedules, activeFilter) +
        '</div>';
      if (d.notes && d.notes.schedule_mode === 'unavailable') {
        html += '<div class="empty">VI schedule table unavailable.</div>';
      } else if (schedules.length === 0) {
        html += '<div class="empty">No routines configured.</div>';
      } else if (visibleSchedules.length === 0) {
        html += '<div class="empty">No routines match this filter.</div>';
      } else {
        for (var i = 0; i < visibleSchedules.length; i++) {
          var sc = visibleSchedules[i];
          var statusColor = sc.last_status === 'error' ? 'var(--red)' : sc.last_status === 'ok' ? 'var(--green)' : 'var(--text-muted)';
          html += '<div class="structure-row" style="flex-wrap:wrap">';
          html += '<div class="structure-label">';
          html += '<strong>' + esc(sc.adapter_name) + '</strong>';
          if (!sc.enabled) html += ' <span class="archived-tag">disabled</span>';
          html += '<div class="structure-desc">' + esc(sc.source_input || '') + '</div>';
          html += '<div style="font-size:0.7rem;color:var(--text-muted)">';
          if (sc.schedule_cron) html += 'cron: ' + esc(sc.schedule_cron) + ' ';
          if (sc.interval_seconds) html += 'every ' + esc(String(sc.interval_seconds)) + 's ';
          html += '</div></div>';
          html += '<div style="text-align:right;min-width:120px">';
          html += '<div style="color:' + statusColor + ';font-size:0.8rem">' + esc(sc.last_status || 'never run') + '</div>';
          if (sc.last_run_at) html += '<div style="font-size:0.7rem;color:var(--text-muted)">' + fmtTime(sc.last_run_at) + '</div>';
          if (sc.total_runs) html += '<div style="font-size:0.68rem;color:var(--text-muted)">' + esc(String(sc.total_runs)) + ' runs, ' + esc(String(sc.total_atoms || 0)) + ' atoms</div>';
          html += '</div>';
          if (canWrite) {
            html += '<div class="structure-actions" style="width:100%;margin-top:0.3rem;justify-content:flex-end">';
            html += '<button class="btn-sm btn-ghost" data-routine-busy-key="vi-schedule:' + sc.id + '" data-sched-toggle="' + sc.id + '" data-sched-enabled="' + (sc.enabled ? 'false' : 'true') + '">' + (sc.enabled ? 'Disable' : 'Enable') + '</button>';
            html += '<button class="btn-sm btn-ghost" data-routine-busy-key="vi-schedule:' + sc.id + '" data-sched-run="' + sc.id + '">Run Now</button>';
            html += '<button class="btn-sm btn-ghost" data-routine-busy-key="vi-schedule:' + sc.id + '" data-sched-edit="' + sc.id + '">Edit</button>';
            html += '<button class="btn-sm btn-danger" data-routine-busy-key="vi-schedule:' + sc.id + '" data-sched-del="' + sc.id + '">Delete</button>';
            html += '</div>';
          }
          html += '</div>';
        }
      }
      html += '</div>';

      // Create form
      if (canWrite) {
        var adapters = d.adapters || [];
        html += '<div class="card" style="margin-top:1rem"><div class="card-title">Add Routine</div>';
        html += '<div class="inline-form">';
        html += '<select class="input-sm" id="new-sched-adapter">';
        for (var ai = 0; ai < adapters.length; ai++) {
          html += '<option value="' + esc(adapters[ai].name) + '">' + esc(adapters[ai].name) + ' — ' + esc(adapters[ai].description || '') + '</option>';
        }
        if (adapters.length === 0) html += '<option value="">No adapters available</option>';
        html += '</select>';
        html += '<input class="input-sm" id="new-sched-source" placeholder="Source/feed URL">';
        html += '<input class="input-sm" id="new-sched-cron" placeholder="Cron (optional)" style="max-width:120px">';
        html += '<button class="btn-sm btn-primary" id="btn-create-sched" data-routine-busy-key="vi-create">Create</button>';
        html += '</div>';
        html += '<div class="inline-form" style="margin-top:.5rem">';
        html += '<input class="input-sm" id="import-sched-opml" placeholder="OPML URL">';
        html += '<input class="input-sm" id="import-sched-cron" placeholder="Cron (optional)" style="max-width:120px">';
        html += '<button class="btn-sm btn-ghost" id="btn-import-sched" data-routine-busy-key="vi-import">Import OPML</button>';
        html += '</div></div>';

        // Prompt-assisted maintenance note
        html += '<div class="card" style="margin-top:0.75rem"><div class="card-title">Complex Maintenance</div>';
        html += '<div class="empty">For embedding refresh, recall optimization, or vault sync routines, use the CLI:<br>';
        html += '<code style="font-family:var(--font-mono);font-size:0.75rem;color:var(--highlight)">vo settings set public_overlay_sync pull</code><br>';
        html += '<code style="font-family:var(--font-mono);font-size:0.75rem;color:var(--highlight)">vo overlay pull</code>';
        html += '</div></div>';
      }

      // Recent run history — real per-run summaries from vi_schedule_runs.
      // Summary-only: adapter, trigger, status, atoms, cost, error, timing.
      // Global retention cap is 50 rows — surface that honestly.
      var runs = d.recent_runs || [];
      var historyMode = d.notes && d.notes.history_mode;
      var historyLimit = (d.notes && d.notes.history_limit_global) || 50;
      html += '<div class="card" style="margin-top:1rem"><div class="card-title">Recent Runs (' + esc(String(runs.length)) + ')</div>';
      if (historyMode === 'unavailable') {
        html += '<div class="empty">Run history table not available on this node. Existing schedules still show latest-run summary above.</div>';
      } else if (runs.length === 0) {
        html += '<div class="empty">No runs recorded yet.</div>';
      } else {
        for (var ri = 0; ri < runs.length; ri++) {
          var run = runs[ri];
          var runStatusColor = run.status === 'error' ? 'var(--red)' : 'var(--green)';
          var triggerBadge = run.trigger_kind === 'scheduler'
            ? 'scheduler'
            : run.trigger_kind === 'remote_command'
              ? 'remote'
              : 'manual';
          html += '<div class="structure-row" style="flex-wrap:wrap;padding:0.4rem 0.5rem">';
          html += '<div class="structure-label" style="flex:1">';
          html += '<strong>' + esc(run.adapter_name) + '</strong>';
          html += ' <span class="archived-tag" style="font-size:0.65rem">' + esc(triggerBadge) + '</span>';
          if (run.source_input) html += '<div class="structure-desc" style="font-size:0.7rem">' + esc(run.source_input) + '</div>';
          if (run.error) html += '<div style="font-size:0.7rem;color:var(--red);margin-top:0.15rem">' + esc(run.error) + '</div>';
          html += '</div>';
          html += '<div style="text-align:right;min-width:130px">';
          html += '<div style="color:' + runStatusColor + ';font-size:0.78rem">' + esc(run.status) + '</div>';
          if (typeof run.atoms_count === 'number') html += '<div style="font-size:0.7rem;color:var(--text-muted)">' + esc(String(run.atoms_count)) + ' atoms</div>';
          if (run.cost_usd != null) html += '<div style="font-size:0.68rem;color:var(--text-muted)">$' + esc(Number(run.cost_usd).toFixed(4)) + '</div>';
          if (run.started_at) html += '<div style="font-size:0.68rem;color:var(--text-muted)">' + fmtTime(run.started_at) + '</div>';
          if (typeof run.duration_ms === 'number') html += '<div style="font-size:0.66rem;color:var(--text-muted)">' + esc(String(run.duration_ms)) + 'ms</div>';
          html += '</div></div>';
        }
      }
      html += '</div>';

      // Honest footer — no more "latest summary only" once history exists.
      var historyLabel = historyMode === 'unavailable'
        ? 'History: unavailable on this node'
        : 'History: real per-run summaries, global cap ' + esc(String(historyLimit));
      html += '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.5rem;text-align:right">' + historyLabel + '</div>';

      if (!canWrite) {
        html += '<div class="card" style="margin-top:1rem"><div class="empty">Read-only mode. Operator token required for routine management.</div></div>';
      }
    }

    content.innerHTML = html;
    wireRoutineActions();
    wireRoutineFilters(d);
  }

  function renderDayJournalRoutinesPanel(dayJournal, canWrite) {
    var dj = dayJournal || {};
    var routines = dj.routines || [];
    var recentRuns = dj.recent_runs || [];
    var summary = dj.summary || {};
    var runHistoryLimit = dj.notes && dj.notes.run_history_limit;
    var schedulerStatus = dj.notes && dj.notes.scheduler_status;
    var dryRunPermissions = Array.isArray(dj.notes && dj.notes.dry_run_required_permissions)
      ? dj.notes.dry_run_required_permissions
      : [];
    dayJournalDryRunRequiredPermissions = dryRunPermissions;
    var dryRunPermissionsLabel = dryRunPermissions.join(', ') || 'external-permission';
    var unavailableMessage = (dj.notes && dj.notes.unavailable_message) || 'Day-journal routine read model unavailable on this node.';
    var controlsEnabled = canWrite && dj.mode !== 'unavailable' && dj.notes && dj.notes.mutation_controls === true;
    dayJournalRoutineIndex = {};
    var html = '<div class="card" style="margin-bottom:1rem" data-day-journal-readonly="' + (controlsEnabled ? 'false' : 'true') + '">';
    html += '<div class="card-title">Day Journal Routines</div>';
    html += '<div class="stats" style="margin-bottom:.7rem">';
    html += stat(summary.total_count || routines.length || 0, 'Definitions');
    html += stat(summary.enabled_count || 0, 'Enabled');
    html += statColored(summary.failing_count || 0, 'Failing', summary.failing_count > 0 ? 'var(--red)' : 'var(--text)');
    html += stat(summary.recent_run_count || 0, 'Recent runs');
    html += '</div>';
    if (dj.mode === 'unavailable') {
      html += '<div class="alert amber"><span class="alert-icon">&#9650;</span><span class="alert-message">' + esc(unavailableMessage) + '</span></div>';
    }
    if (Number(summary.enabled_count || 0) > 0 && schedulerStatus && schedulerStatus.status && schedulerStatus.status !== 'active' && schedulerStatus.status !== 'disabled') {
      var schedulerAlertColor = schedulerStatus.status === 'error' || schedulerStatus.status === 'stale' ? 'red' : 'amber';
      var schedulerMessage = dayJournalSchedulerStatusMessage(schedulerStatus);
      html += '<div class="alert ' + schedulerAlertColor + '"><span class="alert-icon">' + (schedulerAlertColor === 'red' ? '&#9632;' : '&#9650;') + '</span><span class="alert-message">' + esc(schedulerMessage) + '</span></div>';
    }
    if (controlsEnabled) {
      html += '<div class="alert amber" style="margin-bottom:.65rem"><span class="alert-icon">&#9650;</span><span class="alert-message">Controls call the local <code>/day-journal/routines/:id</code> API. Dry-run preview is required before first enable for ' + esc(dryRunPermissionsLabel) + ' routines.</span></div>';
    }
    if (routines.length === 0) {
      html += '<div class="empty">No day-journal routine definitions registered.</div>';
    } else {
      for (var i = 0; i < routines.length; i++) {
        var r = routines[i] || {};
        if (r.id) dayJournalRoutineIndex[String(r.id)] = r;
        var settings = r.settings || {};
        var latestRun = r.latest_run || {};
        var preview = r.latest_payload_preview || {};
        var previewText = compactJsonPreview(preview);
        var enabled = settings.enabled === true;
        var grantedPermissions = Array.isArray(r.granted_permissions) ? r.granted_permissions : null;
        var missingPermissions = Array.isArray(r.missing_permissions) ? r.missing_permissions : null;
        var permissionWarning = enabled && missingPermissions && missingPermissions.length > 0;
        var grantedPermissionsLabel = grantedPermissions ? grantedPermissions.join(', ') || 'none' : 'unknown';
        var missingPermissionsLabel = missingPermissions ? missingPermissions.join(', ') || 'none' : 'unknown';
        var latestSources = dayJournalSourceRefsLabel(r);
        var sourceReliability = preview && preview.source_reliability ? String(preview.source_reliability) : (latestSources ? 'latest source refs shown' : 'preview before enabling');
        var financialRoutine = r.sensitivity === 'financial' || (r.capabilities || []).indexOf('finance') !== -1;
        var status = r.last_display_status || dayJournalDisplayStatus(r.last_run_status, r.last_result_status) || 'never run';
        var statusColor = dayJournalStatusNeedsAttention(r.last_run_status, r.last_result_status, r.last_error) || permissionWarning
          ? 'var(--red)'
          : (status === 'ok' || status === 'succeeded' ? 'var(--green)' : 'var(--text-muted)');
        html += '<div class="structure-row" style="align-items:flex-start;flex-wrap:wrap" data-day-journal-routine="' + esc(r.id) + '">';
        html += '<div class="structure-label" style="min-width:260px;flex:1">';
        html += '<strong>' + esc(r.label || r.id) + '</strong> ';
        html += '<span class="archived-tag">' + (enabled ? 'enabled' : 'disabled') + '</span>';
        html += '<div class="structure-desc">' + esc(r.description || '') + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted);margin-top:.25rem">Target: <code>' + esc(r.target_path || '') + '</code></div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Schedule: ' + esc(settings.schedule || '') + ' / ' + esc(settings.timezone || 'UTC') + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Required permissions: ' + esc((r.required_permissions || []).join(', ') || 'none') + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Granted permissions: ' + esc(grantedPermissionsLabel) + '</div>';
        html += '<div style="font-size:.7rem;color:' + (permissionWarning ? 'var(--red)' : 'var(--text-muted)') + '">Missing permissions: ' + esc(missingPermissionsLabel) + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Capabilities: ' + esc((r.capabilities || []).join(', ') || 'local journal') + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Sensitivity: ' + esc(r.sensitivity || 'standard') + ' / class: ' + esc(r.routine_class || 'context_only') + '</div>';
        html += '<div style="font-size:.7rem;color:var(--text-muted)">Source reliability: ' + esc(sourceReliability) + '</div>';
        if (financialRoutine) html += '<div style="font-size:.7rem;color:var(--amber)">Financial context only. Not investment advice; no buy-sell recommendation.</div>';
        if (latestSources) html += '<div style="font-size:.7rem;color:var(--text-muted)">Latest sources: ' + esc(latestSources) + '</div>';
        html += '</div>';
        html += '<div style="min-width:220px;max-width:360px;text-align:left">';
        html += '<div style="color:' + statusColor + ';font-size:.78rem">Last status: ' + esc(status) + '</div>';
        if (latestRun.started_at) html += '<div style="font-size:.68rem;color:var(--text-muted)">Last run: ' + fmtTime(latestRun.started_at) + '</div>';
        if (r.last_error) html += '<div style="font-size:.7rem;color:var(--red);margin-top:.2rem">Last error: ' + esc(r.last_error) + '</div>';
        if (r.latest_entry && r.latest_entry.captured_at) html += '<div style="font-size:.68rem;color:var(--text-muted)">Latest write: ' + fmtTime(r.latest_entry.captured_at) + ' / <code>' + esc(r.latest_entry.day_addr || '') + '</code></div>';
        html += '<pre style="margin:.35rem 0 0;white-space:pre-wrap;max-height:7rem;overflow:auto;font-size:.68rem;color:var(--text-muted);background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:.45rem">' + esc(previewText) + '</pre>';
        html += '</div>';
        if (controlsEnabled) {
          html += '<div class="structure-actions" style="width:100%;margin-top:.35rem;justify-content:flex-end">';
          html += '<button type="button" class="btn-sm btn-ghost" data-routine-busy-key="day-journal:' + esc(r.id) + '" data-day-journal-action="dry-run" data-day-journal-routine-id="' + esc(r.id) + '">Dry Run</button>';
          if (enabled) {
            html += '<button type="button" class="btn-sm btn-ghost" data-routine-busy-key="day-journal:' + esc(r.id) + '" data-day-journal-action="run" data-day-journal-routine-id="' + esc(r.id) + '">Run Now</button>';
            html += '<button type="button" class="btn-sm btn-ghost" data-routine-busy-key="day-journal:' + esc(r.id) + '" data-day-journal-action="edit" data-day-journal-routine-id="' + esc(r.id) + '">Edit Settings</button>';
            html += '<button type="button" class="btn-sm btn-danger" data-routine-busy-key="day-journal:' + esc(r.id) + '" data-day-journal-action="disable" data-day-journal-routine-id="' + esc(r.id) + '">Disable</button>';
          } else {
            html += '<button type="button" class="btn-sm btn-primary" data-routine-busy-key="day-journal:' + esc(r.id) + '" data-day-journal-action="enable" data-day-journal-routine-id="' + esc(r.id) + '">Enable</button>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
    }
    var runHistoryTitle = 'Day Journal Run History (' + String(recentRuns.length) + ')';
    if (runHistoryLimit) runHistoryTitle += ' - latest ' + String(runHistoryLimit);
    html += '<div class="card-title" style="margin-top:.85rem">' + esc(runHistoryTitle) + '</div>';
    if (dj.mode === 'unavailable') {
      html += '<div class="empty" style="text-align:left">Run history is unavailable while the day-journal read model is unavailable.</div>';
    } else if (recentRuns.length === 0) {
      html += '<div class="empty" style="text-align:left">No day-journal routine runs recorded yet.</div>';
    } else {
      for (var ri = 0; ri < recentRuns.length; ri++) {
        var run = recentRuns[ri] || {};
        var runStatus = run.display_status || dayJournalDisplayStatus(run.run_status, run.result_status) || 'unknown';
        var runStatusColor = dayJournalStatusNeedsAttention(run.run_status, run.result_status, run.error)
          ? 'var(--red)'
          : (runStatus === 'ok' || runStatus === 'succeeded' ? 'var(--green)' : 'var(--text-muted)');
        html += '<div class="structure-row" style="align-items:flex-start;flex-wrap:wrap;padding:.4rem .5rem" data-day-journal-run="' + esc(run.id || '') + '">';
        html += '<div class="structure-label" style="min-width:260px;flex:1">';
        html += '<strong>' + esc(run.routine_id || 'unknown routine') + '</strong>';
        html += '<div class="structure-desc">' + esc(run.target_path || '') + '</div>';
        html += '<div style="font-size:.68rem;color:var(--text-muted)">Target date: ' + esc(run.target_date || '') + ' / ' + esc(run.day_addr || '') + '</div>';
        if (run.error) html += '<div style="font-size:.7rem;color:var(--red);margin-top:.2rem">Error: ' + esc(run.error) + '</div>';
        html += '</div>';
        html += '<div style="text-align:right;min-width:130px">';
        html += '<div style="color:' + runStatusColor + ';font-size:.78rem">' + esc(runStatus) + '</div>';
        if (run.started_at) html += '<div style="font-size:.68rem;color:var(--text-muted)">' + fmtTime(run.started_at) + '</div>';
        if (run.trigger) html += '<div style="font-size:.66rem;color:var(--text-muted)">' + esc(run.trigger) + '</div>';
        html += '</div></div>';
      }
    }
    html += '<div style="font-size:.7rem;color:var(--text-muted);margin-top:.5rem;text-align:right">' + (controlsEnabled ? 'Day-journal routine controls are routed through the local API.' : 'Day-journal routine view is read-only.') + '</div>';
    html += '</div>';
    return html;
  }

  function compactJsonPreview(value) {
    if (!value || typeof value !== 'object') return '{}';
    try {
      var text = JSON.stringify(value, null, 2);
      if (!text || text === '{}') return '{}';
      return text.length > 1200 ? text.slice(0, 1197) + '...' : text;
    } catch (err) {
      return '{}';
    }
  }

  function dayJournalSourceRefsLabel(routine) {
    var refs = routine.source_refs || (routine.latest_entry && routine.latest_entry.source_refs) || [];
    var labels = [];
    var hasDeleted = false;
    if (Array.isArray(refs)) {
      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i] || {};
        // Rung-6 soft-tombstone: a vault_file ref whose dossier was deleted.
        if (ref.status === 'deleted') hasDeleted = true;
        var label = ref.label || ref.title || ref.path || ref.url || ref.type;
        if (label && labels.indexOf(label) === -1) labels.push(String(label));
      }
    }
    var joined = labels.join(', ');
    // Rung-6 badge. Rendered via esc() at the call site, so emit plain text
    // (not HTML) — the marker still reads as a deletion next to the sources.
    if (hasDeleted) joined += (joined ? ' ' : '') + '(source file deleted)';
    return joined;
  }

  function dayJournalDisplayStatus(runStatus, resultStatus) {
    if (runStatus === 'failed' || runStatus === 'rejected' || runStatus === 'canceled' || runStatus === 'running' || runStatus === 'pending') return runStatus;
    return resultStatus || runStatus || null;
  }

  function dayJournalStatusNeedsAttention(runStatus, resultStatus, error) {
    return Boolean(error) || runStatus === 'failed' || runStatus === 'rejected' || resultStatus === 'error';
  }

  function dayJournalSchedulerStatusMessage(status) {
    var state = status && status.status ? String(status.status) : 'missing';
    var lastHeartbeat = status && status.last_heartbeat_at ? ' Last heartbeat: ' + fmtTime(status.last_heartbeat_at) + '.' : '';
    if (state === 'missing') return 'Day-journal routine scheduler heartbeat is missing. Enabled scheduled routines will not fire until the local scheduler writes a heartbeat.';
    if (state === 'stopped') return 'Day-journal routine scheduler is stopped. Enabled scheduled routines will not fire until it restarts.' + lastHeartbeat;
    if (state === 'stale') return 'Day-journal routine scheduler heartbeat is stale. Enabled scheduled routines may not be firing.' + lastHeartbeat;
    if (state === 'error') return 'Day-journal routine scheduler is reporting an error. Check local server logs for details.' + lastHeartbeat;
    if (state === 'disabled') return 'Day-journal routine scheduler is intentionally disabled by local configuration.' + lastHeartbeat;
    if (state === 'unavailable') return 'Day-journal routine scheduler heartbeat status is unavailable on this node.';
    return 'Day-journal routine scheduler is ' + state + '.' + lastHeartbeat;
  }

  function dayJournalRoutineById(id) {
    return dayJournalRoutineIndex[String(id || '')] || null;
  }

  var routineMutationBusyKeys = Object.create(null);

  function routineMutationBusy(key) {
    return Boolean(key && routineMutationBusyKeys[String(key)]);
  }

  function setRoutineMutationBusy(key, busy) {
    if (!key) return;
    key = String(key);
    if (busy) routineMutationBusyKeys[key] = true;
    else delete routineMutationBusyKeys[key];
    syncRoutineMutationBusyButtons();
  }

  function syncRoutineMutationBusyButtons() {
    var buttons = document.querySelectorAll('[data-routine-busy-key]');
    for (var i = 0; i < buttons.length; i++) {
      var busy = routineMutationBusy(buttons[i].getAttribute('data-routine-busy-key'));
      buttons[i].disabled = busy;
      if (busy) buttons[i].setAttribute('data-routine-busy', 'true');
      else buttons[i].removeAttribute('data-routine-busy');
    }
  }

  function dayJournalRoutineBusyKey(routineId) {
    return 'day-journal:' + String(routineId || '');
  }

  function dayJournalRoutineBusy(routineId) {
    return routineMutationBusy(dayJournalRoutineBusyKey(routineId));
  }

  function setDayJournalRoutineBusy(routineId, busy) {
    setRoutineMutationBusy(dayJournalRoutineBusyKey(routineId), busy);
  }

  function splitPermissionList(text) {
    var out = [];
    var parts = String(text || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var item = parts[i].trim();
      if (item && out.indexOf(item) === -1) out.push(item);
    }
    return out;
  }

  function dayJournalDefaultPermissionGrants(routine) {
    var settings = routine.settings || {};
    if (Array.isArray(settings.permission_grants) && settings.permission_grants.length > 0) return settings.permission_grants;
    return Array.isArray(routine.required_permissions) ? routine.required_permissions : [];
  }

  function dayJournalExternalPermissionsForUi(routine) {
    if (Array.isArray(routine.external_permissions)) return routine.external_permissions;
    var caps = Array.isArray(routine.capabilities) ? routine.capabilities : [];
    var required = Array.isArray(dayJournalDryRunRequiredPermissions) ? dayJournalDryRunRequiredPermissions : [];
    var out = [];
    for (var i = 0; i < caps.length; i++) {
      if (required.indexOf(caps[i]) !== -1) out.push(caps[i]);
    }
    return out;
  }

  function promptDayJournalJsonConfig(routine) {
    var settings = routine.settings || {};
    var current = settings.config && typeof settings.config === 'object' ? settings.config : {};
    var text = prompt('Routine config JSON object:', JSON.stringify(current, null, 2));
    if (text === null) return null;
    try {
      var parsed = JSON.parse(text.trim() || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be an object');
      return parsed;
    } catch (err) {
      alert('Config must be a valid JSON object.');
      return null;
    }
  }

  function promptDayJournalExecutionSettingsPayload(routine) {
    var settings = routine.settings || {};
    var timezone = prompt('Timezone:', settings.timezone || 'UTC');
    if (timezone === null) return null;
    var config = promptDayJournalJsonConfig(routine);
    if (config === null) return null;
    var grantsText = prompt('Permission grants (comma-separated):', dayJournalDefaultPermissionGrants(routine).join(', '));
    if (grantsText === null) return null;
    return {
      timezone: timezone.trim() || 'UTC',
      config: config,
      permission_grants: splitPermissionList(grantsText),
    };
  }

  function promptDayJournalSettingsPayload(routine) {
    var settings = routine.settings || {};
    var schedule = prompt('Schedule (daily@HH:MM, weekday@HH:MM, or weekly:<day>@HH:MM):', settings.schedule || '');
    if (schedule === null) return null;
    var payload = promptDayJournalExecutionSettingsPayload(routine);
    if (!payload) return null;
    payload.schedule = schedule.trim();
    return payload;
  }

  function promptDayJournalDryRunPayload(routine) {
    var settingsPayload = promptDayJournalExecutionSettingsPayload(routine);
    if (!settingsPayload) return null;
    var targetDate = prompt('Dry-run target date (today or YYYY-MM-DD):', 'today');
    if (targetDate === null) return null;
    return {
      target_date: targetDate.trim() || 'today',
      target_timezone: settingsPayload.timezone,
      config: settingsPayload.config,
      permission_grants: settingsPayload.permission_grants,
    };
  }

  function dayJournalEnablePayload(routine) {
    var settings = routine.settings || {};
    return {
      schedule: settings.schedule || '',
      timezone: settings.timezone || 'UTC',
      config: settings.config && typeof settings.config === 'object' ? settings.config : {},
      permission_grants: dayJournalDefaultPermissionGrants(routine),
    };
  }

  function confirmDayJournalEnable(routine) {
    var caps = routine.capabilities || [];
    var externalPermissions = dayJournalExternalPermissionsForUi(routine);
    var lines = [
      'Enable ' + (routine.label || routine.id) + '?',
      'Target path: ' + (routine.target_path || ''),
      'Permissions: ' + (dayJournalDefaultPermissionGrants(routine).join(', ') || 'none'),
    ];
    if (routine.requires_scoped_authority === true || externalPermissions.length > 0) {
      lines.push('A successful dry-run preview is required before enabling scoped-authority routines.');
    }
    if (routine.sensitivity === 'financial' || caps.indexOf('finance') !== -1) {
      lines.push('Financial context only. Not investment advice; no buy-sell recommendation.');
      lines.push('Market routines require explicit network and finance grants.');
    }
    return confirm(lines.join('\\n'));
  }

  function routineFilterLabel(filter) {
    if (filter === 'day-journal') return 'Day-journal';
    if (filter === 'failing') return 'Failing';
    if (filter === 'stale') return 'Stale';
    if (filter === 'disabled') return 'Disabled';
    return 'All';
  }

  function normalizeRoutineFilter(filter) {
    var value = String(filter || 'all');
    if (value === 'all' || value === 'day-journal' || value === 'failing' || value === 'stale' || value === 'disabled') return value;
    return 'all';
  }

  function routineFilterChip(filter, label, schedules, activeFilter) {
    return '<button type="button" class="btn-sm btn-ghost filter-chip' + (activeFilter === filter ? ' active' : '') +
      '" data-routine-filter="' + esc(filter) + '">' + esc(label) + ' ' +
      '<span class="tab-badge">' + esc(String(routineFilterCount(schedules, filter))) + '</span></button>';
  }

  function routineFilterCount(schedules, filter) {
    var count = 0;
    for (var i = 0; i < schedules.length; i++) {
      if (routineMatchesDashboardFilter(schedules[i], filter)) count++;
    }
    return count;
  }

  function routineMatchesDashboardFilter(sc, filter) {
    if (filter === 'day-journal') return false;
    if (filter === 'failing') return sc.enabled !== false && sc.last_status === 'error';
    if (filter === 'stale') return isRoutineStaleForDashboard(sc);
    if (filter === 'disabled') return sc.enabled === false;
    return true;
  }

  function isRoutineStaleForDashboard(sc) {
    if (sc.enabled === false) return false;
    var staleAt = sc.last_run_at || sc.created_at;
    if (!staleAt) return false;
    var t = new Date(staleAt).getTime();
    if (!isFinite(t)) return false;
    return Date.now() - t > 24 * 60 * 60 * 1000;
  }

  function wireRoutineActions() {
    // Toggle
    var toggleBtns = document.querySelectorAll('[data-sched-toggle]');
    for (var t = 0; t < toggleBtns.length; t++) {
      toggleBtns[t].addEventListener('click', function() {
        var id = this.getAttribute('data-sched-toggle');
        var enabled = this.getAttribute('data-sched-enabled') === 'true';
        routineMutate('/dashboard/routines/' + id + '/toggle', { enabled: enabled }, this);
      });
    }
    // Run
    var runBtns = document.querySelectorAll('[data-sched-run]');
    for (var r = 0; r < runBtns.length; r++) {
      runBtns[r].addEventListener('click', function() {
        routineMutate('/dashboard/routines/' + this.getAttribute('data-sched-run') + '/run', {}, this);
      });
    }
    // Edit
    var editBtns = document.querySelectorAll('[data-sched-edit]');
    for (var e = 0; e < editBtns.length; e++) {
      editBtns[e].addEventListener('click', function() {
        var id = this.getAttribute('data-sched-edit');
        var newSource = prompt('Source input (leave empty to keep current):');
        var newCron = prompt('Cron schedule (leave empty to keep current):');
        var body = {};
        if (newSource !== null && newSource.trim()) body.source_input = newSource.trim();
        if (newCron !== null && newCron.trim()) body.schedule_cron = newCron.trim();
        if (Object.keys(body).length === 0) return;
        routineMutate('/dashboard/routines/' + id + '/edit', body, this);
      });
    }
    // Delete
    var delBtns = document.querySelectorAll('[data-sched-del]');
    for (var d = 0; d < delBtns.length; d++) {
      delBtns[d].addEventListener('click', function() {
        if (!confirm('Delete this routine?')) return;
        routineMutate('/dashboard/routines/' + this.getAttribute('data-sched-del') + '/delete', {}, this);
      });
    }
    // Create
    var createBtn = document.getElementById('btn-create-sched');
    if (createBtn) {
      createBtn.onclick = function() {
        var adapter = document.getElementById('new-sched-adapter');
        var source = document.getElementById('new-sched-source');
        var cron = document.getElementById('new-sched-cron');
        if (!adapter || !adapter.value) return;
        var body = { adapter_name: adapter.value };
        if (source && source.value.trim()) body.source_input = source.value.trim();
        if (cron && cron.value.trim()) body.schedule_cron = cron.value.trim();
        routineMutate('/dashboard/routines', body, createBtn);
      };
    }
    var importBtn = document.getElementById('btn-import-sched');
    if (importBtn) {
      importBtn.onclick = function() {
        var source = document.getElementById('import-sched-opml');
        var cron = document.getElementById('import-sched-cron');
        if (!source || !source.value.trim()) return;
        var body = { source_input: source.value.trim() };
        if (cron && cron.value.trim()) body.schedule_cron = cron.value.trim();
        routineMutate('/dashboard/routines/import', body, importBtn);
      };
    }
    var dayJournalBtns = document.querySelectorAll('[data-day-journal-action]');
    for (var j = 0; j < dayJournalBtns.length; j++) {
      dayJournalBtns[j].addEventListener('click', function() {
        var triggerButton = this;
        var action = this.getAttribute('data-day-journal-action');
        var id = this.getAttribute('data-day-journal-routine-id');
        if (dayJournalRoutineBusy(id)) return;
        var routine = dayJournalRoutineById(id);
        if (!routine) return alert('Day-journal routine not found in the current dashboard model.');
        var pathBase = '/dashboard/day-journal/routines/' + encodeURIComponent(id) + '/';
        if (action === 'dry-run') {
          var dryBody = promptDayJournalDryRunPayload(routine);
          if (dryBody) routineMutate(pathBase + 'dry-run', dryBody, triggerButton, id);
          return;
        }
        if (action === 'run') {
          var targetDate = prompt('Run target date (today or YYYY-MM-DD):', 'today');
          if (targetDate === null) return;
          if (!confirm('Run ' + (routine.label || routine.id) + ' now for target path ' + (routine.target_path || '') + '?')) return;
          routineMutate(pathBase + 'run', { target_date: targetDate.trim() || 'today', generate_idempotency_key: true }, triggerButton, id);
          return;
        }
        if (action === 'edit') {
          var editBody = promptDayJournalSettingsPayload(routine);
          if (!editBody) return;
          if (!confirm('Apply settings through the local enable route? A matching dry-run may be required before the change is accepted.')) return;
          routineMutate(pathBase + 'enable', editBody, triggerButton, id);
          return;
        }
        if (action === 'enable') {
          if (!confirmDayJournalEnable(routine)) return;
          routineMutate(pathBase + 'enable', dayJournalEnablePayload(routine), triggerButton, id);
          return;
        }
        if (action === 'disable') {
          if (!confirm('Disable ' + (routine.label || routine.id) + '?')) return;
          routineMutate(pathBase + 'disable', {}, triggerButton, id);
        }
      });
    }
    syncRoutineMutationBusyButtons();
  }

  function wireRoutineFilters(d) {
    var filterBtns = document.querySelectorAll('[data-routine-filter]');
    for (var f = 0; f < filterBtns.length; f++) {
      filterBtns[f].addEventListener('click', function() {
        pendingDashboardIntent = { tab: 'routines', filter: normalizeRoutineFilter(this.getAttribute('data-routine-filter') || 'all') };
        renderRoutines(d);
      });
    }
  }

  function routineMutate(path, body, triggerEl, dayJournalRoutineId) {
    var busyKey = dayJournalRoutineId ? dayJournalRoutineBusyKey(dayJournalRoutineId) : (triggerEl ? triggerEl.getAttribute('data-routine-busy-key') : '');
    if (dayJournalRoutineId) {
      if (routineMutationBusy(busyKey)) return Promise.resolve(null);
      setRoutineMutationBusy(busyKey, true);
    } else if (busyKey) {
      if (routineMutationBusy(busyKey)) return Promise.resolve(null);
      setRoutineMutationBusy(busyKey, true);
    } else if (triggerEl) {
      if (triggerEl.disabled || triggerEl.getAttribute('data-routine-busy') === 'true') return Promise.resolve(null);
      triggerEl.disabled = true;
      triggerEl.setAttribute('data-routine-busy', 'true');
    }
    var tid = currentTenantId();
    if (tid) body.tenant_id = tid;
    return fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json();
    }).then(function(data) {
      if (!data) return;
      if (data.ok) return fetchRoutines();
      else alert(data.error || data.message || data.hint || 'Operation failed');
    }).catch(function(err) { alert('Error: ' + err.message); })
      .finally(function() {
        if (busyKey) {
          setRoutineMutationBusy(busyKey, false);
        } else if (triggerEl) {
          triggerEl.disabled = false;
          triggerEl.removeAttribute('data-routine-busy');
        }
      });
  }

  function statColored(val, label, color) {
    return '<div class="stat"><div class="stat-value" style="color:' + color + '">' + esc(String(val)) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
  }

  // ── Account / Sync tab ─────────────────────────────────────────────

  function startAccountPoll() {
    if (activeTab !== 'account' || waitingLoopActive || accountPollTimer) return;
    accountPollTimer = setInterval(function() {
      if (!waitingLoopActive && activeTab === 'account' && getToken()) fetchAccount();
    }, POLL_MS);
  }

  function postAccountAction(path, body) {
    var payload = Object.assign({ tenant_id: getTenantId() }, body || {});
    return fetch(dashUrl(path), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(payload),
    }).then(function(res) {
      if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
      return res.json().catch(function() { return { ok: false, error: 'invalid_response' }; });
    });
  }

  function fetchAccount(options) {
    if (waitingLoopActive && !(options && options.force)) return;
    fetch(dashUrl('/dashboard/account'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        renderAccount(data);
        var ctx = (data && data.context) || {};
        wireLinkStateActions(ctx.tenant_id || '', ctx.node_id || '');
        wireGoogleConnectActions();
        wireAccountControls();
        startAccountPoll();
      })
      .catch(function(err) { content.innerHTML = '<div class="state-msg">Failed to load account: ' + esc(err.message) + '</div>'; });
  }

  function fetchConnectStatusSafe() {
    return fetch(dashUrl('/dashboard/account/connect/status'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) return { ok: false, status: 'local_auth_required' };
        return res.json().catch(function() { return { ok: false, status: 'hosted_unreachable' }; });
      })
      .catch(function() { return { ok: false, status: 'hosted_unreachable' }; });
  }

  function pollConnectStatus(deadlineMs) {
    waitingLoopActive = true;
    fetchConnectStatusSafe().then(function(data) {
      var statusEl = content.querySelector('[data-google-connect-status]');
      if (statusEl && data && data.status) statusEl.textContent = String(data.status);
      if (data && data.status === 'connected') {
        waitingLoopActive = false;
        fetchAccount({ force: true });
        return;
      }
      if (Date.now() < deadlineMs) {
        setTimeout(function() { pollConnectStatus(deadlineMs); }, 2000);
      } else {
        waitingLoopActive = false;
        fetchAccount({ force: true });
      }
    });
  }

  function wireGoogleConnectActions() {
    var btn = content.querySelector('[data-google-connect-start]');
    if (!btn) return;
    btn.addEventListener('click', function() {
      btn.disabled = true;
      fetch(dashUrl('/dashboard/account/connect/start'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ tenant_id: getTenantId() }),
      })
        .then(function(res) {
          if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
          return res.json();
        })
        .then(function(data) {
          if (!data) return;
          if (data.open_url) {
            window.open(data.open_url, '_blank', 'noopener');
            pollConnectStatus(Date.now() + 30000);
          } else if (data.status === 'connected') {
            fetchAccount();
          } else {
            alert(data.error || data.message || 'Unable to start Google sign-in');
            btn.disabled = false;
          }
        })
        .catch(function(err) { alert('Unable to start Google sign-in: ' + err.message); btn.disabled = false; });
    });
  }

  function wireAccountControls() {
    var refresh = content.querySelector('[data-account-refresh]');
    if (refresh) refresh.addEventListener('click', function() { fetchAccount({ force: true }); });

    function showSyncPrefError(message) {
      var el = content.querySelector('[data-sync-pref-error]');
      if (!el) return;
      el.hidden = false;
      el.textContent = message || 'Sync preference update failed.';
    }

    function patchSyncPreferences(payload, revert) {
      fetch(dashUrl('/dashboard/account/sync/preferences'), {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(Object.assign({ tenant_id: getTenantId() }, payload || {})),
      })
        .then(function(res) {
          if (res.status === 401 || res.status === 403) { clearToken(); render(); return null; }
          return res.json().catch(function() { return { ok: false, error: 'invalid_response' }; });
        })
        .then(function(data) {
          if (!data) return;
          if (data.ok) fetchAccount({ force: true });
          else {
            if (typeof revert === 'function') revert();
            showSyncPrefError(data.message || data.error || 'Sync preference update failed.');
          }
        })
        .catch(function(err) {
          if (typeof revert === 'function') revert();
          showSyncPrefError('Sync preference update failed: ' + err.message);
        });
    }

    var emailToggle = content.querySelector('[data-email-visibility-toggle]');
    if (emailToggle) {
      emailToggle.addEventListener('change', function() {
        var next = !!emailToggle.checked;
        postAccountAction('/dashboard/account/preferences', { show_google_email: next })
          .then(function(data) {
            if (!data) return;
            if (data.ok) fetchAccount({ force: true });
            else {
              emailToggle.checked = !next;
              alert(data.message || data.error || 'Preference update failed');
            }
          })
          .catch(function(err) {
            emailToggle.checked = !next;
            alert('Preference update failed: ' + err.message);
          });
      });
    }

    var start = content.querySelector('[data-sync-start]');
    if (start) start.addEventListener('click', function() {
      start.disabled = true;
      postAccountAction('/dashboard/account/sync/start', {})
        .then(function(data) {
          if (!data) return;
          if (data.ok) fetchAccount({ force: true });
          else { alert(data.message || data.error || 'Unable to start sync'); start.disabled = false; }
        })
        .catch(function(err) { alert('Unable to start sync: ' + err.message); start.disabled = false; });
    });

    var stop = content.querySelector('[data-sync-stop]');
    if (stop) stop.addEventListener('click', function() {
      stop.disabled = true;
      postAccountAction('/dashboard/account/sync/stop', {})
        .then(function(data) {
          if (!data) return;
          if (data.ok) fetchAccount({ force: true });
          else { alert(data.message || data.error || 'Unable to stop sync'); stop.disabled = false; }
        })
        .catch(function(err) { alert('Unable to stop sync: ' + err.message); stop.disabled = false; });
    });

    var entRefresh = content.querySelector('[data-entitlement-refresh]');
    if (entRefresh) entRefresh.addEventListener('click', function() {
      entRefresh.disabled = true;
      postAccountAction('/dashboard/account/entitlement/refresh', {})
        .then(function(data) {
          if (!data) return;
          if (data.ok) fetchAccount({ force: true });
          else { alert(data.message || data.error || 'Unable to refresh VO+ status'); entRefresh.disabled = false; }
        })
        .catch(function(err) { alert('Unable to refresh VO+ status: ' + err.message); entRefresh.disabled = false; });
    });

    var driveStart = content.querySelector('[data-drive-connect-start]');
    if (driveStart) driveStart.addEventListener('click', function() {
      driveStart.disabled = true;
      postAccountAction('/dashboard/account/drive/start', {})
        .then(function(data) {
          if (!data) return;
          if (data.ok && data.open_url) {
            window.open(data.open_url, '_blank', 'noopener');
            fetchAccount({ force: true });
          } else {
            alert(data.message || data.error || 'Unable to start Drive authorization');
            driveStart.disabled = false;
          }
        })
        .catch(function(err) { alert('Unable to start Drive authorization: ' + err.message); driveStart.disabled = false; });
    });

    var driveRedeem = content.querySelector('[data-drive-connect-redeem]');
    if (driveRedeem) driveRedeem.addEventListener('click', function() {
      driveRedeem.disabled = true;
      postAccountAction('/dashboard/account/drive/redeem', {})
        .then(function(data) {
          if (!data) return;
          if (data.ok) fetchAccount({ force: true });
          else { alert(data.message || data.error || 'Drive authorization is not ready yet'); driveRedeem.disabled = false; }
        })
        .catch(function(err) { alert('Unable to finish Drive authorization: ' + err.message); driveRedeem.disabled = false; });
    });

    content.querySelectorAll('[data-sync-pref]').forEach(function(box) {
      if (box.disabled || box.getAttribute('data-sync-pref') === 'lightweight_status') return;
      box.addEventListener('change', function() {
        var key = box.getAttribute('data-sync-pref');
        var next = !!box.checked;
        var payload = {};
        payload[key] = next;
        patchSyncPreferences(payload, function() { box.checked = !next; });
      });
    });

    content.querySelectorAll('[data-sync-project-addr]').forEach(function(box) {
      if (box.disabled) return;
      box.addEventListener('change', function() {
        var before = !box.checked;
        var selected = [];
        content.querySelectorAll('[data-sync-project-addr]').forEach(function(projectBox) {
          if (!projectBox.disabled && projectBox.checked) selected.push(projectBox.getAttribute('data-sync-project-addr'));
        });
        patchSyncPreferences({ selected_project_addrs: selected }, function() { box.checked = before; });
      });
    });

    var help = content.querySelector('[data-connect-help]');
    if (help) help.addEventListener('click', function() {
      var panel = content.querySelector('[data-connect-help-panel]');
      if (panel) panel.hidden = !panel.hidden;
    });
  }

  // renderLinkStateCard — rung-1 5-state projection card.
  // d.state is one of: unconfigured / unlinked / pending /
  // linked / mismatched. d.context carries the evidence
  // fields. d.actions carries the action buttons +
  // instructional blocks. Empty state-fields render as "—".
  function renderLinkStateCard(d) {
    var state = d.state || 'unconfigured';
    var ctx = d.context || {};
    var actions = d.actions || [];
    var stateLabelMap = {
      unconfigured: 'Unconfigured',
      unlinked: 'Unlinked',
      pending: 'Pending operator approval',
      linked: 'Linked',
      mismatched: 'Mismatched — recoverable',
    };
    var stateBadgeClass = {
      unconfigured: '',
      unlinked: 'badge-warn',
      pending: 'badge-warn',
      linked: 'badge-ok',
      mismatched: 'badge-err',
    };
    var badge = stateBadgeClass[state] || '';
    var label = stateLabelMap[state] || state;

    var html = '<div class="card card-dither" data-link-state-card>';
    html += '<div class="card-title">Link state</div>';
    html += '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">';
    html += '<span class="badge ' + badge + '" data-link-state-badge>' + esc(label) + '</span>';
    html += '<code data-link-state-code style="font-size:.75rem;color:var(--dim)">' + esc(state) + '</code>';
    html += '</div>';

    // Context block
    if (ctx.tenant_id) html += summaryRow('Tenant', ctx.tenant_id);
    if (ctx.account_email) html += summaryRow('Account', ctx.account_email);
    if (ctx.node_id) html += summaryRow('Node', ctx.node_id);
    if (ctx.link_status) html += summaryRow('Link row', ctx.link_status);
    if (ctx.sync_token_claimed === true) html += summaryRow('Sync token', 'claimed');
    else if (ctx.sync_token_claimed === false) html += summaryRow('Sync token', 'claimable');
    if (ctx.last_sync_at) html += summaryRow('Last sync', fmtTime(ctx.last_sync_at));
    if (ctx.mismatch_reason) {
      html += '<div style="padding:.5rem;border:1px solid var(--red);color:var(--red);margin:.5rem 0;font-size:.8rem" data-link-mismatch-reason>';
      html += esc(ctx.mismatch_reason);
      html += '</div>';
    }

    // Actions block — stacked buttons / forms.
    if (actions.length > 0) {
      html += '<div style="margin-top:.75rem;display:flex;flex-direction:column;gap:.4rem" data-link-state-actions>';
      for (var i = 0; i < actions.length; i++) {
        var a = actions[i];
        if (a.id === 'submit_link_code') {
          html += '<form data-link-action-form="submit_link_code" data-link-action-path="' + esc(a.path || '') + '" style="display:flex;gap:.4rem;align-items:center">';
          html += '<input type="text" name="link_code" placeholder="paste link code" required style="flex:1;font-size:.85rem;padding:.3rem" />';
          html += '<button type="submit" class="btn" style="font-size:.85rem">' + esc(a.label) + '</button>';
          html += '</form>';
          if (a.hint) html += '<div style="font-size:.72rem;color:var(--dim)">' + esc(a.hint) + '</div>';
        } else if (a.method && a.path) {
          html += '<button class="btn" type="button" data-link-action-id="' + esc(a.id) + '" data-link-action-method="' + esc(a.method) + '" data-link-action-path="' + esc(a.path) + '" style="font-size:.85rem;text-align:left">';
          html += esc(a.label);
          html += '</button>';
          if (a.hint) html += '<div style="font-size:.72rem;color:var(--dim);margin-top:-.2rem">' + esc(a.hint) + '</div>';
        } else {
          // Instructional-only (method null). Render as a
          // note, not a button.
          html += '<div style="font-size:.78rem;color:var(--dim);padding:.2rem 0" data-link-action-id="' + esc(a.id) + '"><strong>' + esc(a.label) + '</strong>';
          if (a.hint) html += '<br />' + esc(a.hint);
          html += '</div>';
        }
      }
      html += '</div>';
    }

    // Rung 2 Q3=A+ sibling-nodes read-only list.
    var siblings = (ctx.sibling_nodes && Array.isArray(ctx.sibling_nodes)) ? ctx.sibling_nodes : [];
    if (siblings.length > 0) {
      html += '<div style="margin-top:.75rem;padding-top:.5rem;border-top:1px solid var(--border)" data-sibling-nodes>';
      html += '<div style="font-size:.75rem;color:var(--dim);margin-bottom:.3rem">Other devices on this tenant</div>';
      for (var si = 0; si < siblings.length; si++) {
        var sib = siblings[si];
        var sibBadge = sib.status === 'active' ? 'badge-ok' : sib.status === 'revoked' ? 'badge-err' : '';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:.78rem;padding:.2rem 0">';
        html += '<code style="color:var(--dim)">' + esc(sib.node_id) + '</code>';
        html += '<span class="badge ' + sibBadge + '">' + esc(sib.status) + '</span>';
        html += '<span style="font-size:.72rem;color:var(--muted)">' + (sib.last_sync_at ? fmtTime(sib.last_sync_at) : '—') + '</span>';
        html += '</div>';
      }
      html += '<div style="font-size:.72rem;color:var(--dim);margin-top:.35rem">Manage remote devices at <code>verityone.app/my/account</code></div>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function wireLinkStateActions(tenantId, nodeId) {
    // Delegated click handler for POST/GET action buttons.
    var actionsBox = content.querySelector('[data-link-state-actions]');
    if (!actionsBox) return;
    actionsBox.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-link-action-id]');
      if (!btn || !btn.dataset.linkActionMethod) return;
      evt.preventDefault();
      var method = btn.dataset.linkActionMethod;
      var path = btn.dataset.linkActionPath;
      if (!path) return;
      btn.disabled = true;
      var requestPath = path.indexOf('/dashboard/') === 0 ? dashUrl(path) : path;
      var init = { method: method, headers: authHeaders() };
      // POST actions that operate on the current node carry
      // {tenant_id, node_id}; tenant-wide unlink carries only
      // {tenant_id}. Dashboard-local bridge routes also use
      // the same body shape for operator-token parity.
      if (method === 'POST' && (
        btn.dataset.linkActionId === 'cancel_pending' ||
        btn.dataset.linkActionId === 'abandon_mismatch' ||
        btn.dataset.linkActionId === 'claim_sync_token' ||
        btn.dataset.linkActionId === 'rotate_sync_token' ||
        btn.dataset.linkActionId === 'revoke_this_node' ||
        btn.dataset.linkActionId === 'rotate_local_node_key'
      )) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ tenant_id: tenantId, node_id: nodeId });
      } else if (method === 'POST' && btn.dataset.linkActionId === 'unlink_tenant') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ tenant_id: tenantId });
      }
      fetch(requestPath, init)
        .then(function (res) { return res.text().then(function (text) { return { status: res.status, text: text }; }); })
        .then(function (r) {
          if (r.status >= 200 && r.status < 300) { fetchAccount(); }
          else { alert('Action failed (' + r.status + '): ' + r.text); btn.disabled = false; }
        })
        .catch(function (err) { alert('Network error: ' + err.message); btn.disabled = false; });
    });

    // Link-code submit form → POST local bridge that proxies
    // to /account/link. Impl scope's simplest form submits
    // the code as a field the bridge forwards into the
    // X-VO-Link-Code header.
    var form = content.querySelector('[data-link-action-form="submit_link_code"]');
    if (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('input[name="link_code"]');
        var code = input && input.value ? input.value.trim() : '';
        if (!code) return;
        var path = form.dataset.linkActionPath;
        if (!path) return;
        var requestPath = path.indexOf('/dashboard/') === 0 ? dashUrl(path) : path;
        fetch(requestPath, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ tenant_id: tenantId, link_code: code }),
        })
          .then(function (res) { return res.text().then(function (text) { return { status: res.status, text: text }; }); })
          .then(function (r) {
            if (r.status >= 200 && r.status < 300) { fetchAccount(); }
            else { alert('Link-submit failed (' + r.status + '): ' + r.text); }
          })
          .catch(function (err) { alert('Network error: ' + err.message); });
      });
    }
  }

  function renderAccount(d) {
    var html = '<h2 style="font-size:1.1rem;margin-bottom:1rem;">Account / Sync</h2>';

    var id = d.identity || {};
    var connect = d.connect || {};
    var prefs = d.account_preferences || {};
    var controls = d.sync_controls || {};
    var entitlement = d.entitlement || {};
    var hostedAccountUrl = connect.hosted_account_url || 'https://verityone.app/my/account';
    var emailVisible = id.email_visible !== false;
    var emailDisplay = id.email_display || (emailVisible ? id.account_email : 'Hidden');
    var linkedLabel = id.google_linked === true ? 'Linked' : id.google_linked === false ? 'Not linked' : 'Unknown';
    var linkedBadge = id.google_linked === true ? 'badge-ok' : id.google_linked === false ? 'badge-warn' : '';
    html += '<div class="card card-dither" data-google-auth-card><div class="card-title">Google authorization</div>';
    html += '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.55rem">';
    html += '<span class="badge ' + linkedBadge + '">' + esc(linkedLabel) + '</span>';
    if (emailDisplay) html += '<span style="font-size:.82rem;color:var(--dim)">' + esc(emailDisplay) + '</span>';
    if (connect.status) html += '<span style="font-size:.78rem;color:var(--dim)" data-google-connect-status>' + esc(connect.status) + '</span>';
    html += '</div>';
    if (connect.status === 'connected' && connect.connection) {
      html += '<p style="font-size:.82rem;color:var(--dim);line-height:1.55;margin:.2rem 0 .75rem">You\\'re signed in as ' + esc(emailDisplay || 'this Google account') + '. Connected to local VO at ' + esc(connect.local_origin || 'this machine') + '.</p>';
    } else if (connect.status === 'expired') {
      html += '<p style="font-size:.82rem;color:var(--dim);line-height:1.55;margin:.2rem 0 .75rem">The sign-in window expired. Retry Google sign-in to reconnect this local VO.</p>';
    } else if (connect.status === 'error' || connect.status === 'hosted_unreachable') {
      html += '<p style="font-size:.82rem;color:var(--dim);line-height:1.55;margin:.2rem 0 .75rem">Hosted connection could not be completed. Check your internet connection and retry.</p>';
    } else {
    html += '<p style="font-size:.82rem;color:var(--dim);line-height:1.55;margin:.2rem 0 .75rem">Use one Google account for hosted VO+ and this local VO. The browser session lives on <code>verityone.app</code>; after linking, this dashboard mirrors the same account, tenant, device, and sync state without using the hosted cookie as local authority.</p>';
    }
    if (d.hosted_account_error && d.hosted_account_error.message) {
      html += '<div class="alert alert-warn" style="margin:.4rem 0 .65rem">' + esc(d.hosted_account_error.message) + '</div>';
    }
    html += '<div class="inline-form" style="gap:.45rem;align-items:center">';
    if (connect.status === 'connected') {
      html += '<button class="btn-sm" type="button" data-account-refresh>Refresh</button>';
      if (controls.can_start) html += '<button class="btn-sm btn-primary" type="button" data-sync-start>Start sync</button>';
      if (controls.can_stop) html += '<button class="btn-sm btn-ghost" type="button" data-sync-stop>Stop sync</button>';
      html += '<button class="btn-sm btn-ghost" type="button" data-connect-help>Help</button>';
    } else {
      html += '<button class="btn-sm btn-primary" type="button" data-google-connect-start>Sign in with Google</button>';
      html += '<button class="btn-sm btn-ghost" type="button" data-account-refresh>Refresh</button>';
      html += '<button class="btn-sm btn-ghost" type="button" data-connect-help>Help</button>';
    }
    html += '<a class="btn-sm btn-ghost" href="' + hostedAccountUrl + '" target="_blank" rel="noopener" data-hosted-account-open>Open hosted account</a>';
    html += '</div>';
    html += '<div class="alert" data-connect-help-panel hidden style="margin:.5rem 0 .65rem;font-size:.78rem;line-height:1.45">If the handshake does not complete, confirm that local VO is running, the hosted sign-in page is reachable, popups are allowed, and internet is active. Then use Refresh or start Google sign-in again.</div>';
    html += '<div class="summary-row" style="margin-top:.75rem"><span class="summary-label">Show Google email</span><span class="summary-value"><label style="display:inline-flex;align-items:center;gap:.4rem"><input type="checkbox" data-email-visibility-toggle ' + (prefs.show_google_email !== false ? 'checked' : '') + '> <span>' + (prefs.show_google_email !== false ? 'Showing' : 'Hidden') + '</span></label></span></div>';
    html += '<div class="summary-row"><span class="summary-label">Sync</span><span class="summary-value">' + esc(controls['hosted_sync'] || 'off') + '</span></div>';
    html += '</div>';

    var planLabel = entitlement.source === 'admin_override' ? 'Admin'
      : entitlement.vo_plus_active ? 'VO+'
      : entitlement.source === 'free_google' ? 'Free Google'
      : 'Unknown';
    var heavyActive = entitlement.heavy_sync_active === true;
    var heavyState = entitlement.health === 'available' ? 'Available'
      : entitlement.health === 'grace_active' ? 'Grace active'
      : entitlement.health === 'paused_vo_plus_required' ? 'Paused - VO+ required'
      : entitlement.health === 'hosted_unreachable' ? 'Hosted unreachable'
      : 'Unknown';
    html += '<div class="card card-dither" data-entitlement-card><div class="card-title">VO+ capability</div>';
    html += '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.55rem">';
    html += '<span class="badge ' + (heavyActive ? 'badge-ok' : 'badge-warn') + '">' + esc(planLabel) + '</span>';
    html += '<span style="font-size:.78rem;color:var(--dim)">' + esc(heavyState) + '</span>';
    var sp = d.sync_preferences || {};
    var projPref = sp.projects || {};
    var vaultPref = sp.vault_metadata || {};
    var drivePref = sp.drive_mirror || {};
    var dossierPref = sp.vault_dossiers || {};
    var rawPref = sp.raw_capture_files || {};
    var driveDisabledReason = drivePref.disabled_reason || '';
    var driveControlsDisabled = !heavyActive || !!driveDisabledReason;
    html += '</div>';
    html += summaryRow('Graph sync', 'Enabled');
    html += summaryRow('Project sync', heavyActive ? 'Enabled' : 'VO+ required');
    html += summaryRow('Vault metadata', heavyActive ? 'Enabled' : 'VO+ required');
    html += summaryRow('Google Drive vault mirror', driveDisabledReason ? driveDisabledReason : (heavyActive ? 'Available' : 'VO+ required'));
    html += '<div class="inline-form" style="gap:.45rem;align-items:center;margin-top:.65rem">';
    html += '<button class="btn-sm btn-ghost" type="button" data-entitlement-refresh>Refresh VO+ status</button>';
    html += '<a class="btn-sm btn-ghost" href="' + esc(entitlement.manage_url || hostedAccountUrl + '#vo-plus') + '" target="_blank" rel="noopener">Manage VO+</a>';
    html += '</div>';
    html += '</div>';

    var selectedProjects = {};
    (projPref.selected_project_addrs || []).forEach(function(addr) { selectedProjects[addr] = true; });
    var selectedProjectCount = sp.summary && typeof sp.summary.selected_project_count === 'number'
      ? sp.summary.selected_project_count
      : Object.keys(selectedProjects).length;
    var projectOptions = d.sync_project_options || [];
    html += '<div class="card card-dither" data-sync-preferences-card><div class="card-title">Sync preferences</div>';
    html += '<div class="alert alert-warn" data-sync-pref-error hidden style="margin:.35rem 0 .6rem;font-size:.78rem"></div>';
    if (sp.legacy_sync_projects_null && heavyActive) {
      html += '<div class="alert" style="margin:.35rem 0 .6rem;font-size:.78rem">Project sync now requires selecting projects.</div>';
    }
    function prefRow(label, key, checked, disabled, reason) {
      html += '<label class="summary-row" style="cursor:' + (disabled ? 'not-allowed' : 'pointer') + '">';
      html += '<span class="summary-label">' + esc(label) + (reason ? ' <span style="color:var(--dim);font-size:.72rem">(' + esc(reason) + ')</span>' : '') + '</span>';
      html += '<span class="summary-value"><input type="checkbox" data-sync-pref="' + esc(key) + '" ' + (checked ? 'checked ' : '') + (disabled ? 'disabled ' : '') + '></span>';
      html += '</label>';
    }
    prefRow('Lightweight status', 'lightweight_status', true, true, 'connected protocol');
    prefRow('Account and governance', 'account_governance', !!(sp.account_governance && sp.account_governance.enabled), false, '');
    prefRow('Non-project graph memory', 'non_project_graph', !!(sp.non_project_graph && sp.non_project_graph.enabled), false, '');
    prefRow('Projects', 'projects_enabled', !!projPref.requested_enabled, !heavyActive && !projPref.requested_enabled, heavyActive ? '' : 'VO+ required');
    html += '<div class="summary-row" style="font-size:.76rem;color:var(--dim)"><span class="summary-label">Selected projects</span><span class="summary-value">' + esc(String(selectedProjectCount)) + '</span></div>';
    html += '<div style="margin:.35rem 0 .55rem;padding-left:.75rem;border-left:1px solid var(--border)">';
    if (projectOptions.length === 0) {
      html += '<div class="empty" style="padding:.35rem 0">No active projects available.</div>';
    } else {
      for (var pi = 0; pi < projectOptions.length; pi++) {
        var po = projectOptions[pi];
        var alreadySelected = !!selectedProjects[po.addr];
        var disabled = !alreadySelected && (!heavyActive || !po.eligible);
        var reason = !heavyActive && !alreadySelected ? 'VO+ required' : (!po.eligible ? 'Local only' : '');
        html += '<label style="display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.24rem 0;font-size:.8rem;color:' + (disabled ? 'var(--dim)' : 'var(--text)') + '">';
        html += '<span>' + esc(po.label || po.addr) + (reason ? ' <span style="font-size:.72rem;color:var(--dim)">(' + esc(reason) + ')</span>' : '') + '</span>';
        html += '<input type="checkbox" data-sync-project-addr="' + esc(po.addr) + '" ' + (alreadySelected ? 'checked ' : '') + (disabled ? 'disabled ' : '') + '>';
        html += '</label>';
      }
    }
    if (projPref.requested_enabled && Object.keys(selectedProjects).length === 0) {
      html += '<div style="font-size:.76rem;color:var(--warn);margin-top:.35rem">No projects selected.</div>';
    }
    html += '</div>';
    prefRow('Vault metadata', 'vault_metadata', !!vaultPref.requested_enabled, !heavyActive && !vaultPref.requested_enabled, heavyActive ? '' : 'VO+ required');
    prefRow('Google Drive mirror', 'drive_mirror', !!drivePref.requested_enabled, driveControlsDisabled && !drivePref.requested_enabled, driveDisabledReason || (heavyActive ? '' : 'VO+ required'));
    prefRow('Vault dossiers', 'vault_dossiers', !!dossierPref.requested_enabled, (driveControlsDisabled || !!dossierPref.disabled_reason) && !dossierPref.requested_enabled, dossierPref.disabled_reason || driveDisabledReason || (heavyActive ? '' : 'VO+ required'));
    prefRow('Raw/capture files', 'raw_capture_files', !!rawPref.requested_enabled, (driveControlsDisabled || !!rawPref.disabled_reason) && !rawPref.requested_enabled, rawPref.disabled_reason || driveDisabledReason || (heavyActive ? '' : 'VO+ required'));
    var drive = d.drive_mirror || {};
    var driveState = drive.state || {};
    var driveStats = driveState.stats || {};
    html += '<div class="summary-row"><span class="summary-label">Drive worker</span><span class="summary-value">' + esc(driveState.status || 'not_configured') + '</span></div>';
    html += '<div class="summary-row"><span class="summary-label">Drive progress</span><span class="summary-value">' + esc(String(driveStats.uploaded_count || 0)) + ' / ' + esc(String(driveStats.file_count || 0)) + ' files mirrored</span></div>';
    if (driveState.drive_folder_web_url) {
      var driveFileCount = (driveState.drive_files && driveState.drive_files.length) || 0;
      html += '<div class="summary-row"><span class="summary-label">Open in Drive</span><span class="summary-value"><a href="' + esc(driveState.drive_folder_web_url) + '" target="_blank" rel="noopener noreferrer">Vault folder ↗</a>' + (driveFileCount ? ' <span class="status-dim">(' + esc(String(driveFileCount)) + ' file' + (driveFileCount === 1 ? '' : 's') + ')</span>' : '') + '</span></div>';
    }
    if (driveState.last_error_code) {
      html += '<div class="summary-row"><span class="summary-label">Drive attention</span><span class="summary-value">' + esc(driveState.last_error_code) + '</span></div>';
    }
    html += '<div class="inline-form" style="gap:.45rem;align-items:center;margin-top:.55rem">';
    html += '<button class="btn-sm btn-ghost" type="button" data-drive-connect-start ' + (driveControlsDisabled ? 'disabled' : '') + '>Authorize Drive</button>';
    if (drive.attempt) html += '<button class="btn-sm btn-primary" type="button" data-drive-connect-redeem>Finish Drive authorization</button>';
    html += '</div>';
    html += '</div>';

    // Link-state card (rung 1) — 5-state projection with
    // operator-facing context + action buttons.
    html += renderLinkStateCard(d);

    // Identity section
    html += '<div class="card card-dither"><div class="card-title">Identity</div>';
    html += summaryRow('Tenant ID', id.tenant_id || '—');
    html += summaryRow('Google Linked', id.google_linked === true ? 'Yes' : id.google_linked === false ? 'No' : 'Unknown');
    if (emailDisplay) html += summaryRow('Email', emailDisplay);
    if (id.account_display_name) html += summaryRow('Name', id.account_display_name);
    html += '</div>';

    // Sync health section — rung 3. Badge + details use the
    // shared SYNC_HEALTH_STATES vocabulary from
    // federation-sync-health.ts. Same enum rendered on hosted
    // /my/account (portal-web.ts) so operators see the same
    // state regardless of which dashboard they opened.
    // Server flag VERITY_SYNC_HEALTH_CARD=off hides the card
    // without changing the projection contract.
    if (d.sync_health_card_enabled !== false) {
    html += '<div class="card" data-sync-health-card><div class="card-title">Sync Health</div>';
    var syncCtx = d.context || {};
    var syncHealth = syncCtx.sync_health || 'disabled';
    var syncHealthBadgeMap = {
      fresh: 'badge-ok',
      never: 'badge-warn',
      disabled: '',
      error: 'badge-err',
      offline: 'badge-err',
    };
    var syncHealthLabelMap = {
      fresh: 'Fresh',
      never: 'Never synced',
      disabled: 'Disabled',
      error: 'Error',
      offline: 'Offline',
    };
    var syncHealthBadge = syncHealthBadgeMap[syncHealth] || '';
    var syncHealthLabel = syncHealthLabelMap[syncHealth] || syncHealth;
    html += '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">';
    html += '<span class="badge ' + syncHealthBadge + '" data-sync-health-badge>' + esc(syncHealthLabel) + '</span>';
    html += '<code data-sync-health-state style="font-size:.75rem;color:var(--dim)">' + esc(syncHealth) + '</code>';
    html += '</div>';

    var s = d.sync;
    if (s && s.note) {
      html += '<div class="empty">' + esc(s.note) + '</div>';
    } else {
      var syncLocalCursor = (syncCtx.local_cursor !== null && typeof syncCtx.local_cursor === 'number')
        ? syncCtx.local_cursor
        : (s && typeof s.local_cursor === 'number' ? s.local_cursor : null);
      var syncPendingJournal = (typeof syncCtx.pending_journal_count === 'number')
        ? syncCtx.pending_journal_count
        : (s && typeof s.journal_pending === 'number' ? s.journal_pending : 0);
      if (syncCtx.sync_health_age_seconds !== null && typeof syncCtx.sync_health_age_seconds === 'number') {
        html += summaryRow('Last hosted sync', fmtDurationAgo(syncCtx.sync_health_age_seconds));
      } else {
        html += summaryRow('Last hosted sync', '—');
      }
      if (syncLocalCursor !== null) {
        html += summaryRow('Local Cursor', String(syncLocalCursor));
      }
      html += summaryRow('Journal Pending', String(syncPendingJournal || 0) + ' items');
      if (s) {
        html += summaryRow('Hosted Sync', s.hosted_sync || 'off');
        if (s.node_id) html += summaryRow('Node ID', s.node_id);
        if (s.last_attempt && s.last_attempt.last_result) {
          html += summaryRow('Last attempt', s.last_attempt.last_result);
        }
        if (s.last_attempt && s.last_attempt.last_error) {
          html += '<div style="font-size:.78rem;color:var(--red);margin-top:.2rem" data-sync-health-error>' + esc(s.last_attempt.last_error) + '</div>';
        }
      }
    }
    html += '</div>';
    } // end of sync_health_card_enabled guard

    // Remote command history
    html += '<div class="card"><div class="card-title">Remote Commands</div>';
    var rc = d.remote_commands || {};
    if (rc.available === false) {
      html += '<div class="empty">' + esc(rc.note || 'Remote command history is not available from this node.') + '</div>';
    } else {
      var counts = rc.counts || {};
      html += '<div class="stats" style="margin-bottom:.75rem">';
      html += stat(counts.queued || 0, 'Queued');
      html += stat(counts.claimed || 0, 'Claimed');
      html += stat(counts.applied || 0, 'Applied');
      html += stat(counts.rejected || 0, 'Rejected');
      html += stat(counts.failed || 0, 'Failed');
      html += stat(counts.canceled || 0, 'Canceled');
      html += '</div>';

      var recent = rc.recent || [];
      if (recent.length > 0) {
        for (var i = 0; i < recent.length; i++) {
          var cmd = recent[i];
          // canceled = user-initiated terminal. Render it as a neutral
          // badge (no colored variant) instead of falling through to the
          // amber "warn" bucket alongside queued/claimed. Unknown future
          // statuses also land here as plain — no silent miscoloring.
          var statusBadge;
          if (cmd.status === 'applied') statusBadge = 'badge-ok';
          else if (cmd.status === 'rejected' || cmd.status === 'failed') statusBadge = 'badge-err';
          else if (cmd.status === 'queued' || cmd.status === 'claimed') statusBadge = 'badge-warn';
          else statusBadge = '';
          html += '<div class="cmd-row" style="padding:.4rem .5rem;border-bottom:1px solid var(--border);font-size:.8rem;display:flex;justify-content:space-between;align-items:center">';
          html += '<span class="event-type">' + esc(cmd.command_type) + '</span>';
          html += '<span style="font-size:.72rem;color:var(--dim)">' + esc(cmd.category) + '</span>';
          html += '<span class="badge ' + statusBadge + '">' + esc(cmd.status) + '</span>';
          html += '<span style="font-size:.72rem;color:var(--muted)">' + fmtTime(cmd.created_at) + '</span>';
          html += '</div>';
          // Safe result detail — only known fields per (category, command_type).
          // Reads nothing payload-y; every dynamic string passes through esc().
          // Mirrors the hosted safeResultDetail contract.
          var r = cmd.result;
          var detail = '';
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            if (cmd.category === 'providers' && cmd.command_type === 'validate_provider') {
              var vs = typeof r.validation_status === 'string' ? r.validation_status : '';
              var msg = typeof r.message === 'string' ? r.message : '';
              if (vs) detail += '<strong>' + esc(vs) + '</strong>';
              if (msg) detail += (detail ? ' &middot; ' : '') + esc(msg);
            } else if (cmd.category === 'routines' && cmd.command_type === 'schedule_edit') {
              if (r.duplicate === true && (typeof r.existing_schedule_id === 'number' || typeof r.existing_schedule_id === 'string')) {
                detail = 'duplicate of schedule ' + esc(String(r.existing_schedule_id));
              } else if (Array.isArray(r.edited_fields) && r.edited_fields.length > 0) {
                var fields = [];
                for (var ef = 0; ef < r.edited_fields.length; ef++) {
                  if (typeof r.edited_fields[ef] === 'string') fields.push(esc(r.edited_fields[ef]));
                }
                if (fields.length) detail = 'edited: ' + fields.join(', ');
              }
            } else if (cmd.category === 'providers' && cmd.command_type === 'set_agent_override') {
              var aid = typeof r.agent_id === 'string' ? r.agent_id : '';
              var tt = typeof r.task === 'string' ? r.task : '';
              var pp = typeof r.provider === 'string' ? r.provider : '';
              var mm = typeof r.model === 'string' ? r.model : '';
              if (aid && tt && pp && mm) {
                detail = '<code>' + esc(aid) + '</code> &middot; ' + esc(tt) + ' = ' + esc(pp) + '/' + esc(mm);
              }
            } else if (cmd.category === 'settings' && cmd.command_type === 'setting_toggle') {
              // Dispatch emits {key, previous, next} via writeTenantSetting.
              // Accept legacy {key, value} too so older rows still render.
              var sk = typeof r.key === 'string' ? r.key : '';
              var svCand = r.next !== undefined ? r.next : r.value;
              var sv = (typeof svCand === 'boolean' || typeof svCand === 'string' || typeof svCand === 'number')
                ? String(svCand)
                : '';
              if (sk && sv) {
                detail = '<code>' + esc(sk) + '</code> &rarr; ' + esc(sv);
              }
            } else if (cmd.category === 'settings' && cmd.command_type === 'agent_policy') {
              // VO-DASHBOARD-HOSTED-AGENT-POLICY-PR-1.
              // Canonical helper emits {agent_id, key, previous, next, changed}.
              // Allowlisted fields only: agent_id, key, next.
              var apaid = typeof r.agent_id === 'string' ? r.agent_id : '';
              var apk = typeof r.key === 'string' ? r.key : '';
              if (apaid && apk) {
                var apn = r.next;
                var apv = '';
                if (typeof apn === 'string') {
                  apv = esc(apn);
                } else if (apn === null) {
                  apv = apk === 'visible_projects' ? '<code>all</code>' : '<code>null</code>';
                } else if (Array.isArray(apn)) {
                  var addrCount = 0;
                  for (var ia = 0; ia < apn.length; ia++) {
                    if (typeof apn[ia] === 'string') addrCount++;
                  }
                  apv = addrCount + ' project' + (addrCount === 1 ? '' : 's');
                }
                if (apv) {
                  var apNoop = r.changed === false ? ' <span style="font-size:.7rem;color:var(--dim)">(no-op)</span>' : '';
                  detail = '<code>' + esc(apaid) + '</code> &middot; ' + esc(apk) + ' &rarr; ' + apv + apNoop;
                }
              }
            } else if (cmd.category === 'providers' && cmd.command_type === 'clear_default_model') {
              var ctt = typeof r.task_type === 'string' ? r.task_type : '';
              if (ctt) {
                var wasNoop = r.cleared === false;
                var verb = wasNoop ? 'no-op clear' : 'cleared';
                detail = esc(verb) + ' <code>' + esc(ctt) + '</code>';
              }
            } else if (cmd.category === 'providers' && cmd.command_type === 'clear_agent_override') {
              var caid = typeof r.agent_id === 'string' ? r.agent_id : '';
              var ctt = typeof r.task === 'string' ? r.task : '';
              if (caid && ctt) {
                var wasNoop = r.cleared === false;
                var verb = wasNoop ? 'no-op clear' : 'cleared';
                detail = '<code>' + esc(caid) + '</code> &middot; ' + esc(verb) + ' ' + esc(ctt);
              }
            }
            if (!detail && (cmd.status === 'rejected' || cmd.status === 'failed') && typeof r.error === 'string' && r.error) {
              detail = '<span style="color:var(--red)">' + esc(r.error) + '</span>';
            }
          }
          if (detail) {
            html += '<div style="padding:.1rem .5rem .35rem;font-size:.72rem;color:var(--dim);border-bottom:1px solid var(--border);margin-top:-.2rem">' + detail + '</div>';
          }
        }
      } else {
        html += '<div class="empty">No remote commands yet.</div>';
      }
    }
    html += '</div>';

    content.innerHTML = html;
  }

  // ── MCP + VO Skill controls tab ────────────────────────────────
  // VO-MCP-DASHBOARD-CONTROLS-PR-1. Status refresh is read-only
  // for MCP connection + VO Skill activation. Mutating buttons
  // below go only through the allowlisted preview / confirm /
  // execute runner; unavailable surfaces remain copy-command
  // operator flows.
  function fetchMcpControls() {
    fetch(dashUrl('/dashboard/mcp-controls.json'), { headers: authHeaders() })
      .then(function(res) {
        if (res.status === 401 || res.status === 403) {
          clearToken();
          renderGate('Token rejected.');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        if (!data) return;
        renderMcpControls(data);
      })
      .catch(function(err) {
        content.innerHTML = '<div class="state-msg">Failed to load: ' + esc(err.message) + '</div>';
      });
  }

  function renderMcpControls(d) {
    var rows = d.rows || [];
    var summary = d.artifact_summary || {};
    var html = '<div class="mcp-controls">';
    html += '<h2>Clients + VO Skill</h2>';
    html += '<p class="mcp-controls-intro">' +
      'Status for the two separate tenant controls: <strong>MCP connection</strong> ' +
      '(does your client spawn the local VO MCP stdio server?) and ' +
      '<strong>VO Skill</strong> (is the repo-local agent brief available to your client?). ' +
      'Read-only status refreshes do not shell out. Mutating dashboard buttons below use the allowlisted preview / confirm / execute runner; surfaces without an allowlisted helper remain a local operator command copy flow.' +
      '</p>';
    // Evidence-source line — honest about the two read paths.
    html += '<p class="mcp-controls-source">Evidence source: <code>artifact_and_skill_checker</code>. ' +
      'The dashboard reads ' +
      '<code>agent-lab/proof/vo-mcp-client-acceptance/result.json</code> ' +
      '(gitignored; written locally by the acceptance recorder) and runs the read-only <code>skill_doctor_&lt;client&gt;</code> filesystem helpers for VO Skill rows. ' +
      'It does <strong>not</strong> shell out to <code>vo-mcp doctor</code>, and it does <strong>not</strong> ' +
      'verify on-disk MCP config outside the shipped checker / artifact paths. ' +
      'Artifact state: <code>' + esc(summary.kind || 'unknown') + '</code>' +
      (summary.note ? ' — ' + esc(summary.note) : '') + '</p>';

    // Group rows by control so the separation is impossible to miss.
    var byControl = { mcp_connection: [], vo_skill: [] };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (byControl[r.control]) byControl[r.control].push(r);
    }

    function renderGroup(title, note, controlRows) {
      var out = '<section class="mcp-control-group">';
      out += '<h3>' + esc(title) + '</h3>';
      out += '<p class="mcp-control-note">' + esc(note) + '</p>';
      out += '<table class="mcp-control-table"><thead><tr>' +
        '<th>Client</th><th>Status</th><th>Evidence</th><th>Next action (operator-local)</th>' +
        '</tr></thead><tbody>';
      for (var j = 0; j < controlRows.length; j++) {
        var row = controlRows[j];
        var actionHtml = '';
        if (row.next_action) {
          if (row.next_action.kind === 'run_command') {
            actionHtml = '<code class="mcp-cmd" data-copy="' + esc(row.next_action.value) +
              '">' + esc(row.next_action.value) + '</code>' +
              '<div class="mcp-op-note">Run this in your own terminal, not from the dashboard.</div>';
          } else if (row.next_action.kind === 'open_doc') {
            actionHtml = '<code>' + esc(row.next_action.value) + '</code>' +
              '<div class="mcp-op-note">Open this doc in the repo. The dashboard does not auto-open files.</div>';
          } else if (row.next_action.kind === 'open_file') {
            actionHtml = '<code>' + esc(row.next_action.value) + '</code>' +
              '<div class="mcp-op-note">Open this file in the repo. The dashboard does not auto-open files.</div>';
          }
        }
        out += '<tr>' +
          '<td><code>' + esc(row.client) + '</code></td>' +
          '<td><span class="mcp-status mcp-status-' + esc(row.status) + '">' + esc(row.status) + '</span></td>' +
          '<td>' + esc(row.evidence) + '</td>' +
          '<td>' + actionHtml + '</td>' +
        '</tr>';
      }
      out += '</tbody></table></section>';
      return out;
    }

    html += renderGroup(
      'MCP connection',
      'Whether a client (Claude Desktop / Codex / generic) can spawn the local VO MCP stdio server. This is the CONNECTIVITY control.',
      byControl.mcp_connection,
    );
    html += renderGroup(
      'VO Skill',
      'Whether the agent has the repo-local VO Skill brief at mcp/skills/verity-one-mcp/SKILL.md in its client\\'s Skills directory. The Skill is guidance only; it is NOT invoked or called by the MCP server, and MCP works without it. This is the BEHAVIOR control. Rung 10 ships read-only Skill checkers for Codex and Claude Desktop filesystem states; Rung 11 promotes to enabled only when the same-client acceptance artifact is fresh and records skill_observed=true plus a non-empty Skill note.',
      byControl.vo_skill,
    );

    // Operator command palette -- the full activation sequence
    // a human runs in their own terminal. Click to copy; the
    // dashboard does NOT execute any of these. Each rows
    // next_action points at ONE of these commands, but the
    // full sequence is exposed here so the operator can read
    // the whole flow in order rather than chasing whichever
    // step a single row happens to highlight.
    var cmds = d.commands || {};
    function cmdLine(label, key, note) {
      var v = cmds[key] || '';
      return '<li class="mcp-cmd-line">' +
        '<div class="mcp-cmd-label">' + esc(label) + '</div>' +
        '<code class="mcp-cmd" data-copy="' + esc(v) + '">' + esc(v) + '</code>' +
        (note ? '<div class="mcp-op-note">' + esc(note) + '</div>' : '') +
        '</li>';
    }
    function docLine(label, key) {
      var v = cmds[key] || '';
      return '<li class="mcp-cmd-line">' +
        '<div class="mcp-cmd-label">' + esc(label) + '</div>' +
        '<code>' + esc(v) + '</code>' +
        '</li>';
    }
    html += '<section class="mcp-control-group">';
    html += '<h3>Operator commands</h3>';
    html += '<p class="mcp-op-note">' +
      'These are the full activation and acceptance commands — click to copy, then paste into your own terminal. ' +
      'The dashboard does not run, paste, or edit any of them; it only shows the strings.' +
      '</p>';
    html += '<ol class="mcp-cmd-list">';
    html += cmdLine('1. Install (Claude Desktop)', 'install_claude_desktop', 'Merges mcpServers.verity-one into your local Claude Desktop config file. Dashboard does not run this.');
    html += cmdLine('1. Install (Codex)', 'install_codex', 'Prints a [mcp_servers.verity-one] TOML block to stdout for CLI/manual install. This copy-command row does NOT write ~/.codex; use the Codex MCP buttons below for the dashboard automated merge.');
    html += cmdLine('1. Install (generic host)', 'install_generic', 'Prints a JSON stdio block for other MCP hosts to paste into their own config. Does not write any host config. Dashboard does not run this.');
    html += cmdLine('2. Config doctor (Claude Desktop)', 'config_doctor_claude_desktop');
    html += cmdLine('2. Config doctor (Codex)', 'config_doctor_codex');
    html += cmdLine('3. Live doctor', 'live_doctor', 'Boots the stdio server once and checks capabilities. No writes.');
    html += cmdLine('4. Record acceptance (Claude Desktop)', 'recorder_claude_desktop', 'Fill in --summary / --result with what YOU saw; this writes the gitignored acceptance artifact.');
    html += cmdLine('4. Record acceptance (Codex)', 'recorder_codex');
    html += cmdLine('5. Cross-client interop proof', 'interop_proof');
    html += docLine('Activation doc', 'activation_doc');
    html += docLine('Repo-local Skill', 'skill_file');
    html += '</ol>';
    html += '</section>';

    // Doc pointers. Inert links / file paths — operator opens
    // them on their own machine.
    html += '<section class="mcp-control-group">';
    html += '<h3>Reference</h3>';
    html += '<ul>';
    html += '<li>Activation flow: <code>docs/VO-MCP-ACTIVATION.md</code></li>';
    html += '<li>Agent usage kit: <code>docs/VO-MCP-AGENT-USAGE.md</code></li>';
    html += '<li>Repo-local Skill: <code>mcp/skills/verity-one-mcp/SKILL.md</code></li>';
    html += '<li>Cross-client interop proof: <code>docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md</code></li>';
    html += '</ul>';
    html += '<p class="mcp-op-note">None of the links above open a browser or shell anything. They are file paths in this repo — open them in your editor.</p>';
    html += '</section>';

    // Read-only live checks — preview/confirm/execute flow.
    // VO-MCP-LOCAL-ACTION-RUNNER-READONLY-PR-1. Three action ids
    // in the allowlist; each mapped to a button that opens an
    // inline preview pane and requires a typed confirmation
    // click before the runner executes. The runner re-reads the
    // existing acceptance artifact after execute so exit codes
    // never directly promote dashboard state.
    html += '<section class="mcp-control-group" id="mcp-readonly-actions">';
    html += '<h3>Read-only live checks</h3>';
    html += '<p class="mcp-op-note">Each button runs an allowlisted read-only action on this machine. The dashboard shows a preview first; you confirm before anything executes. No writes, no config changes, no Skill install — all three checks are classified read_only.</p>';
    html += '<div class="mcp-action-list">';
    html += '<button class="mcp-action-btn" data-action-id="mcp_live_doctor">Re-check: live MCP stdio handshake</button>';
    html += '<button class="mcp-action-btn" data-action-id="mcp_client_doctor_claude_desktop">Re-check: Claude Desktop config</button>';
    html += '<button class="mcp-action-btn" data-action-id="mcp_client_doctor_codex">Re-check: Codex config</button>';
    html += '</div>';
    html += '</section>';

    // Claude Desktop install / repair — local operator actions.
    // VO-MCP-LOCAL-ACTION-RUNNER-CLAUDE-INSTALL-PR-1. These are
    // file_mutation actions: preview shows the exact config
    // path, a backup is taken before any write, rollback is a
    // symmetric allowlisted action. This section is Claude
    // Desktop MCP CONFIG only — it does NOT render Codex MCP
    // TOML merge, Codex VO Skill, generic MCP, Claude Desktop
    // Skill, or acceptance recorder buttons. The Codex MCP
    // config buttons (install / repair / rollback) live in
    // their own #mcp-codex-install-actions section rendered
    // below under control_scope "mcp_connection" (shipped in
    // VO-MCP-CODEX-INSTALL-ACTION-PR-1). The Codex VO Skill
    // buttons (install / disable / rollback) live in their
    // own #mcp-codex-skill-actions section below that under
    // control_scope "vo_skill". Generic MCP install is
    // permanently unsupported.
    // (NOTE: this comment sits inside the DASHBOARD_HTML
    // template literal — backticks would terminate the outer
    // literal, so any code-style quotation uses plain text.)
    html += '<section class="mcp-control-group" id="mcp-claude-install-actions">';
    html += '<h3>Claude Desktop MCP — install / repair (local operator actions)</h3>';
    html += '<p class="mcp-op-note"><strong>Scope:</strong> Claude Desktop only. These actions merge the verity-one entry into your local Claude Desktop config. Codex (~/.codex/config.toml), generic hosts, the VO Skill, and the acceptance artifact are <strong>not</strong> touched. Every button opens a preview with the exact file path and backup plan; nothing executes without your confirmation click.</p>';
    html += '<div class="mcp-action-list">';
    html += '<button class="mcp-action-btn" data-action-id="mcp_onboard_claude_desktop">Install Claude Desktop MCP (merge verity-one)</button>';
    html += '<button class="mcp-action-btn mcp-action-risky" data-action-id="mcp_onboard_claude_desktop_force">Repair Claude Desktop MCP (force overwrite)</button>';
    html += '<button class="mcp-action-btn" data-action-id="mcp_rollback_claude_desktop">Roll back to most recent backup</button>';
    html += '</div>';
    html += '</section>';

    // Codex MCP config — install / repair / rollback (local operator
    // actions). VO-MCP-CODEX-INSTALL-ACTION-PR-1. These are
    // file_mutation actions under control_scope=mcp_connection,
    // targeting the Codex MCP config at ~/.codex/config.toml. They
    // are DISTINCT from the Codex VO Skill actions below: different
    // file (config.toml vs SKILL.md), different lock (mcp_connection
    // vs vo_skill), different control scope. The merge preserves
    // unrelated sections / comments / blank lines / ordering
    // byte-for-byte; validates TOML before AND after the merge via
    // smol-toml. First-time install writes no backup (nothing to
    // preserve); rollback refuses when no eligible backup exists.
    // (NOTE: this comment is inside the DASHBOARD_HTML template
    // literal — backticks would terminate the outer literal, so
    // any code-style quotation uses plain text here.)
    html += '<section class="mcp-control-group" id="mcp-codex-install-actions">';
    html += '<h3>Codex MCP config — install / repair (local operator actions)</h3>';
    html += '<p class="mcp-op-note"><strong>Scope:</strong> Codex MCP config + the bundled <code>~/.vo/mcp/</code> server tree. Install and repair merge the <code>[mcp_servers.verity-one]</code> section into <code>~/.codex/config.toml</code> (CODEX_HOME-aware; unrelated sections / comments / ordering preserved byte-for-byte) AND refresh the installed server at <code>~/.vo/mcp/</code> — same staging posture as <code>mcp_onboard_claude_desktop</code>. <strong>Codex VO Skill is NOT touched</strong> (<code>~/.codex/skills/</code> has its own allowlisted actions below); Claude Desktop config, the acceptance artifact, and every hosted / remote MCP surface are left alone. Rollback restores the latest <code>.bak.&lt;UTC-stamp&gt;</code> of the Codex config file and does NOT re-run the installer. Every button opens a preview with the exact config path, current verity-one section (if any), the proposed next block, and backup plan; nothing executes without your confirmation click.</p>';
    html += '<p class="mcp-op-note"><strong>Status posture:</strong> Config write alone does NOT promote the Codex MCP row to <code>enabled</code>. After a successful install/repair, restart Codex, run <code>vo-mcp doctor</code> + <code>vo-mcp config-doctor --client codex</code> in your terminal, then record acceptance via the recorder section below.</p>';
    html += '<div class="mcp-action-list">';
    html += '<button class="mcp-action-btn" data-action-id="mcp_onboard_codex">Install Codex MCP config (merge verity-one section)</button>';
    html += '<button class="mcp-action-btn mcp-action-risky" data-action-id="mcp_onboard_codex_force">Repair Codex MCP config (force overwrite verity-one section)</button>';
    html += '<button class="mcp-action-btn" data-action-id="mcp_rollback_codex">Roll back Codex MCP config (restore latest backup)</button>';
    html += '</div>';
    html += '</section>';

    // Codex VO Skill — install / disable / rollback (local operator
    // actions). VO-MCP-SKILL-INSTALL-ACTIONS-PR-1. These are
    // file_mutation actions under control_scope=vo_skill, NOT
    // mcp_connection — they target the Codex Skills directory
    // at <codexHome>/skills/verity-one-mcp/SKILL.md and NEVER touch
    // MCP connection config. Claude Desktop Skill install ships in
    // a sibling section below (VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-
    // PR-1, VO-provisional darwin pin — NOT Anthropic-authoritative).
    // Generic Skill support stays permanently unsupported.
    // (NOTE: this comment is inside the DASHBOARD_HTML template
    // literal — backticks would terminate the outer literal, so
    // any code-style quotation uses plain text here.)
    html += '<section class="mcp-control-group mcp-skill-control-group" id="mcp-codex-skill-actions">';
    html += '<h3>Codex VO Skill — install / disable / rollback (local operator actions)</h3>';
    html += '<p class="mcp-op-note"><strong>Scope:</strong> Codex VO Skill only. These actions copy the repo-local <code>mcp/skills/verity-one-mcp/SKILL.md</code> into the Codex Skills directory (<code>~/.codex/skills/verity-one-mcp/SKILL.md</code>), disable it by renaming to <code>SKILL.md.disabled.&lt;UTC-stamp&gt;</code>, or restore the latest valid backup/disabled sibling. <strong>MCP connection config is NOT touched</strong> — <code>~/.codex/config.toml</code>, Claude Desktop config, <code>~/.vo</code>, the acceptance artifact, and every hosted/remote surface are left alone. Claude Desktop VO Skill actions ship in the sibling section below under a VO-provisional darwin target path (NOT Anthropic-authoritative); generic hosts are permanently unsupported. Every button opens a preview with the exact Skill path, current state (absent / present-same / present-different), path-safety check result, and backup plan; nothing executes without your confirmation click.</p>';
    html += '<p class="mcp-op-note"><strong>Status posture:</strong> Rung 10 ships <code>skill_doctor_codex</code> — a read-only filesystem checker that promotes the <code>vo_skill</code> row to <code>installed</code> / <code>disabled</code> / <code>outdated</code> / <code>not_installed</code> based on the current SKILL.md state. The status row refreshes automatically when you load the dashboard; the "Check state now" button exposes the same read for on-demand audit. Promotion to <code>enabled</code> requires the rung-11 Skill acceptance discriminator (<code>skill_observed=true</code> + non-empty note) in a fresh same-client artifact cell — filesystem evidence alone does not prove the agent loaded the Skill in session.</p>';
    html += '<div class="mcp-action-list mcp-skill-action-list">';
    html += '<button class="mcp-action-btn" data-action-id="skill_doctor_codex">Check Codex VO Skill state now (read-only)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_install_codex">Install Codex VO Skill (copy SKILL.md)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_disable_codex">Disable Codex VO Skill (rename to .disabled)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_rollback_codex">Roll back Codex VO Skill (restore latest sibling)</button>';
    html += '</div>';
    html += '</section>';

    // Claude Desktop VO Skill — install / disable / rollback (local
    // operator actions). VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1.
    // These are file_mutation actions under control_scope=vo_skill
    // (NOT mcp_connection) — they target the VO-provisional Claude
    // Desktop AgentSkills directory at ~/Library/Application Support/
    // Claude/AgentSkills/verity-one-mcp/SKILL.md (darwin-only pin,
    // NOT an Anthropic-authoritative path) and NEVER touch MCP
    // connection config. Mirror the Codex VO Skill action posture
    // byte-for-byte: same TOCTOU discipline, same stamp shape, same
    // atomic write. Serializes on the SAME (tenant, vo_skill) lock
    // as the Codex Skill actions above. Generic Skill support stays
    // permanently unsupported.
    // (NOTE: this comment is inside the DASHBOARD_HTML template
    // literal — backticks would terminate the outer literal, so
    // any code-style quotation uses plain text here.)
    html += '<section class="mcp-control-group mcp-skill-control-group" id="mcp-claude-skill-actions">';
    html += '<h3>Claude Desktop VO Skill — install / disable / rollback (local operator actions)</h3>';
    html += '<p class="mcp-op-note"><strong>Scope:</strong> Claude Desktop VO Skill only. These actions copy the repo-local <code>mcp/skills/verity-one-mcp/SKILL.md</code> into the VO-provisional Claude Desktop AgentSkills directory (<code>~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md</code>, darwin-only), disable it by renaming to <code>SKILL.md.disabled.&lt;UTC-stamp&gt;</code>, or restore the latest valid backup/disabled sibling. <strong>MCP connection config is NOT touched</strong> — Claude Desktop config, <code>~/.codex/config.toml</code>, <code>~/.vo</code>, the acceptance artifact, and every hosted/remote surface are left alone. <strong>Path pin is VO-provisional, NOT Anthropic-authoritative</strong> — if Anthropic publishes a different authoritative Skills location, the pin updates to match. Every button opens a preview with the exact Skill path, current state (absent / present-same / present-different), path-safety check result, and backup plan; nothing executes without your confirmation click.</p>';
    html += '<p class="mcp-op-note"><strong>Status posture:</strong> Rung 10 ships <code>skill_doctor_claude_desktop</code> — a read-only filesystem checker that promotes the <code>vo_skill</code> row to <code>installed</code> / <code>disabled</code> / <code>outdated</code> / <code>not_installed</code> based on the current SKILL.md state. Non-darwin platforms render <code>unsupported</code> (the VO-provisional pin is darwin-only). Promotion to <code>enabled</code> requires the rung-11 Skill acceptance discriminator (<code>skill_observed=true</code> + non-empty note) in a fresh same-client artifact cell.</p>';
    html += '<div class="mcp-action-list mcp-skill-action-list">';
    html += '<button class="mcp-action-btn" data-action-id="skill_doctor_claude_desktop">Check Claude Desktop VO Skill state now (read-only)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_install_claude_desktop">Install Claude Desktop VO Skill (copy SKILL.md)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_disable_claude_desktop">Disable Claude Desktop VO Skill (rename to .disabled)</button>';
    html += '<button class="mcp-action-btn" data-action-id="skill_rollback_claude_desktop">Roll back Claude Desktop VO Skill (restore latest sibling)</button>';
    html += '</div>';
    html += '</section>';

    // Runtime acceptance recorder -- artifact_write actions.
    // VO-MCP-ACTION-RUNNER-ACCEPTANCE-RECORDER-PR-1. Records
    // WHAT THE OPERATOR ALREADY OBSERVED in Claude Desktop /
    // Codex. It does not prove the GUI on its own, does not
    // invoke the client, does not run the doctors -- it upserts
    // the operator attestation into the existing gitignored
    // artifact. "pass" requires both doctor flags to be true.
    // No generic recorder. No Skill, no Codex TOML, no hosted.
    html += '<section class="mcp-control-group" id="mcp-acceptance-recorder">';
    html += '<h3>Record runtime acceptance (artifact_write)</h3>';
    html += '<p class="mcp-op-note"><strong>Read this first.</strong> This form records what YOU already saw in the client. It does not prove the GUI, it does not call an MCP tool for you, and it does not run the doctors. Fill it out only AFTER you have: (1) restarted the client, (2) run <code>vo mcp doctor --client &lt;client&gt;</code> (config doctor) and <code>vo mcp doctor</code> (live doctor) in your terminal, (3) exercised one real tool/resource in the client GUI. <code>pass</code> is refused unless BOTH doctor flags below are checked. <code>fail</code> is honest when either doctor has not been run.</p>';
    html += '<p class="mcp-op-note">Writes only under <code>agent-lab/proof/vo-mcp-client-acceptance/</code> (gitignored). Does NOT write <code>~/.codex/config.toml</code>, Claude Desktop config, <code>~/.vo</code>, or any Skill directory. No hosted or remote-MCP calls.</p>';
    var recorderClients = ["claude-desktop", "codex"];
    for (var rc = 0; rc < recorderClients.length; rc++) {
      var client = recorderClients[rc];
      var actionId = 'acceptance_record_' + client.replace('-', '_');
      html += '<div class="mcp-recorder-form" data-recorder-client="' + client + '" data-recorder-action-id="' + esc(actionId) + '">';
      html += '<h4>' + (client === 'claude-desktop' ? 'Claude Desktop' : 'Codex') + '</h4>';
      html += '<label class="mcp-recorder-field"><span>Status</span> ';
      html += '<label><input type="radio" name="status-' + client + '" value="pass" checked> pass</label> ';
      html += '<label><input type="radio" name="status-' + client + '" value="fail"> fail</label>';
      html += '</label>';
      html += '<label class="mcp-recorder-field"><span>Observed tool or resource</span><input type="text" class="mcp-recorder-tool" placeholder="vo_memory_recall" /></label>';
      html += '<label class="mcp-recorder-field"><span>Operator summary (what you did)</span><textarea class="mcp-recorder-summary" rows="2" placeholder="clicked vo_memory_recall — saw two memories"></textarea></label>';
      html += '<label class="mcp-recorder-field"><span>Observed result summary (what came back — no raw payload, no tokens)</span><textarea class="mcp-recorder-result" rows="2" placeholder="returned 2 memories, addrs redacted"></textarea></label>';
      html += '<label class="mcp-recorder-field mcp-recorder-checkbox"><input type="checkbox" class="mcp-recorder-config-doctor" /> I ran <code>vo mcp doctor --client ' + client + '</code> (config doctor)</label>';
      html += '<label class="mcp-recorder-field mcp-recorder-checkbox"><input type="checkbox" class="mcp-recorder-live-doctor" /> I ran <code>vo mcp doctor</code> (live doctor)</label>';
      // Rung 11 — optional Skill-lifecycle discriminator.
      // Paired with a rung-10 skill_doctor_<client> result of
      // "installed", these fields promote the "vo_skill" row to
      // "enabled". Leave blank when you did not specifically
      // observe Skill-driven behavior; check the box and fill the
      // note when you did.
      // (NOTE: this comment is inside the DASHBOARD_HTML template
      // literal — backticks would terminate the outer literal, so
      // any code-style quotation uses plain quoted text here.)
      html += '<fieldset class="mcp-recorder-skill-fieldset"><legend>Optional: Skill-lifecycle attestation (rung 11)</legend>';
      html += '<label class="mcp-recorder-field mcp-recorder-checkbox"><input type="checkbox" class="mcp-recorder-skill-observed" /> I observed the VO Skill loaded in this ' + (client === 'claude-desktop' ? 'Claude Desktop' : 'Codex') + ' session (agent behaved per the Skill instructions)</label>';
      html += '<label class="mcp-recorder-field"><span>Skill observation note (what the agent did that shows the Skill is active — required if the checkbox above is checked)</span><textarea class="mcp-recorder-skill-note" rows="2" placeholder="agent referenced vo_memory_recall per the Skill decision-capture guidance"></textarea></label>';
      html += '<p class="mcp-op-note mcp-recorder-skill-help">Filling this in only matters if the rung-10 <code>skill_doctor_' + client.replace('-', '_') + '</code> result is <code>installed</code>. Without it, the <code>vo_skill</code> row stays at <code>installed</code>; with it, the row is promoted to <code>enabled</code>. Leaving the checkbox unchecked is always safe — ordinary MCP-connection acceptance alone does not claim Skill runtime works.</p>';
      html += '</fieldset>';
      html += '<button class="mcp-action-btn mcp-recorder-preview">Preview &amp; confirm</button>';
      html += '</div>';
    }
    html += '</section>';

    // Shared preview / confirm panel. Placed OUTSIDE the
    // read-only section so a Claude Desktop MCP install preview,
    // a Codex VO Skill install preview, or an acceptance recorder
    // preview does NOT render under the "Read-only live checks"
    // heading. The panel labels itself at render time from
    // preview.category + preview.control_scope; the section
    // heading below stays neutral ("Preview & confirm") so it
    // does not imply a specific control_scope/category.
    html += '<section class="mcp-control-group mcp-action-panel-section" id="mcp-action-panel-section" aria-labelledby="mcp-action-panel-heading">';
    html += '<h3 id="mcp-action-panel-heading">Preview &amp; confirm</h3>';
    html += '<p class="mcp-op-note">When you click an action button above, its preview appears here. Every preview names its own <em>category</em> (<code>read_only</code> / <code>file_mutation</code> / <code>artifact_write</code>) and <em>control</em> (<code>mcp_connection</code> / <code>vo_skill</code>) so you can see what is being authorized. Nothing executes until you click <strong>Confirm</strong>.</p>';
    html += '<div id="mcp-action-panel" class="mcp-action-panel" aria-live="polite"></div>';
    html += '</section>';

    html += '<p class="mcp-control-refresh"><button id="mcp-controls-refresh">Refresh status</button> <span class="mcp-op-note">Re-reads the acceptance artifact and Skill checker filesystem evidence on disk. No subprocess, no file writes.</span></p>';

    html += '</div>';
    content.innerHTML = html;
    var refreshBtn = document.getElementById('mcp-controls-refresh');
    if (refreshBtn) refreshBtn.onclick = function() { fetchMcpControls(); };
    wireReadOnlyActionButtons();
    // Copy-to-clipboard for command blocks.
    var cmdEls = content.querySelectorAll('code.mcp-cmd');
    for (var k = 0; k < cmdEls.length; k++) {
      (function(el) {
        el.style.cursor = 'copy';
        el.title = 'Click to copy (you still run it locally).';
        el.addEventListener('click', function() {
          var text = el.getAttribute('data-copy') || el.textContent;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function(){});
          }
        });
      })(cmdEls[k]);
    }
  }

  // ── Action runner client glue ────────────────────────────────
  // The browser never composes command strings, cwd, env, or argv;
  // it sends only { action_id, args, confirmation_token }. The
  // allowlist below is a second-line defense against a rogue
  // server response trying to pass a non-allowlisted action id
  // back to the UI — the server registry is authoritative.
  var READONLY_ACTION_IDS = ['mcp_live_doctor', 'mcp_client_doctor_claude_desktop', 'mcp_client_doctor_codex'];
  var MUTATION_ACTION_IDS = ['mcp_onboard_claude_desktop', 'mcp_onboard_claude_desktop_force', 'mcp_rollback_claude_desktop'];
  var CODEX_MCP_ACTION_IDS = ['mcp_onboard_codex', 'mcp_onboard_codex_force', 'mcp_rollback_codex'];
  var CODEX_SKILL_ACTION_IDS = ['skill_install_codex', 'skill_disable_codex', 'skill_rollback_codex'];
  var CLAUDE_SKILL_ACTION_IDS = ['skill_install_claude_desktop', 'skill_disable_claude_desktop', 'skill_rollback_claude_desktop'];
  var SKILL_DOCTOR_ACTION_IDS = ['skill_doctor_codex', 'skill_doctor_claude_desktop'];
  var RECORDER_ACTION_IDS = ['acceptance_record_claude_desktop', 'acceptance_record_codex'];
  var ALL_ACTION_IDS = READONLY_ACTION_IDS.concat(MUTATION_ACTION_IDS).concat(CODEX_MCP_ACTION_IDS).concat(CODEX_SKILL_ACTION_IDS).concat(CLAUDE_SKILL_ACTION_IDS).concat(SKILL_DOCTOR_ACTION_IDS).concat(RECORDER_ACTION_IDS);

  function wireReadOnlyActionButtons() {
    var buttons = content.querySelectorAll('.mcp-action-btn');
    for (var i = 0; i < buttons.length; i++) {
      (function(btn) {
        // Recorder preview buttons carry the form-gather glue
        // separately from read-only / mutation zero-arg buttons.
        if (btn.classList && btn.classList.contains('mcp-recorder-preview')) {
          btn.addEventListener('click', function() {
            var form = btn.closest('.mcp-recorder-form');
            if (!form) return;
            var id = form.getAttribute('data-recorder-action-id') || '';
            if (RECORDER_ACTION_IDS.indexOf(id) === -1) return;
            requestRecorderPreview(id, form);
          });
          return;
        }
        btn.addEventListener('click', function() {
          var id = btn.getAttribute('data-action-id') || '';
          if (ALL_ACTION_IDS.indexOf(id) === -1) return;
          // Recorder actions need form args; zero-arg read-only /
          // mutation actions go through the simple path below.
          if (RECORDER_ACTION_IDS.indexOf(id) !== -1) return;
          requestActionPreview(id);
        });
      })(buttons[i]);
    }
  }

  function gatherRecorderArgs(form) {
    var client = form.getAttribute('data-recorder-client') || '';
    var status = '';
    var radios = form.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { status = radios[i].value; break; }
    }
    var toolEl = form.querySelector('.mcp-recorder-tool');
    var summaryEl = form.querySelector('.mcp-recorder-summary');
    var resultEl = form.querySelector('.mcp-recorder-result');
    var configEl = form.querySelector('.mcp-recorder-config-doctor');
    var liveEl = form.querySelector('.mcp-recorder-live-doctor');
    var skillObservedEl = form.querySelector('.mcp-recorder-skill-observed');
    var skillNoteEl = form.querySelector('.mcp-recorder-skill-note');
    var args = {
      status: status,
      observed_tool_or_resource: (toolEl && toolEl.value) || '',
      operator_summary: (summaryEl && summaryEl.value) || '',
      observed_result_summary: (resultEl && resultEl.value) || '',
      config_doctor_ran: !!(configEl && configEl.checked),
      live_doctor_ran: !!(liveEl && liveEl.checked)
    };
    // Rung 11 — only include the optional Skill-lifecycle
    // fields when the operator touched them. When both are
    // absent, the server treats this as a plain MCP-
    // connection acceptance (the vo_skill row stays at
    // checker-reported state).
    var noteVal = (skillNoteEl && skillNoteEl.value) || '';
    var skillChecked = !!(skillObservedEl && skillObservedEl.checked);
    if (skillChecked || noteVal !== '') {
      args.skill_observed = skillChecked;
      args.skill_observed_note = noteVal;
    }
    return args;
  }

  function requestRecorderPreview(actionId, form) {
    var panel = document.getElementById('mcp-action-panel');
    if (!panel) return;
    var args = gatherRecorderArgs(form);
    panel.innerHTML = '<div class="mcp-op-note">Loading preview for ' + esc(actionId) + '…</div>';
    fetch(dashUrl('/dashboard/mcp-actions/preview'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ action_id: actionId, args: args })
    })
      .then(function(res) { return res.json().then(function(j) { return { status: res.status, json: j }; }); })
      .then(function(r) {
        if (!r.json || !r.json.ok) {
          panel.innerHTML = '<div class="state-msg status-err">Preview refused: ' + esc((r.json && r.json.error) || ('HTTP ' + r.status)) + '</div>';
          return;
        }
        // Stash the typed args on the preview so execute can
        // re-send the exact same shape — token is bound to
        // (action_id, args hash, tenant), so the browser MUST
        // send identical args at execute.
        r.json.preview.__recorder_args = args;
        renderPreview(r.json.preview);
      })
      .catch(function(err) {
        panel.innerHTML = '<div class="state-msg status-err">Preview failed: ' + esc(err.message) + '</div>';
      });
  }

  function requestActionPreview(actionId) {
    var panel = document.getElementById('mcp-action-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="mcp-op-note">Loading preview for ' + esc(actionId) + '…</div>';
    fetch(dashUrl('/dashboard/mcp-actions/preview'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ action_id: actionId, args: {} })
    })
      .then(function(res) { return res.json().then(function(j) { return { status: res.status, json: j }; }); })
      .then(function(r) {
        if (!r.json || !r.json.ok) {
          panel.innerHTML = '<div class="state-msg status-err">Preview refused: ' + esc((r.json && r.json.error) || ('HTTP ' + r.status)) + '</div>';
          return;
        }
        renderPreview(r.json.preview);
      })
      .catch(function(err) {
        panel.innerHTML = '<div class="state-msg status-err">Preview failed: ' + esc(err.message) + '</div>';
      });
  }

  function renderPreview(preview) {
    var panel = document.getElementById('mcp-action-panel');
    if (!panel) return;
    var isMutation = preview.category === 'file_mutation' || preview.category === 'artifact_write';
    var html = '<div class="mcp-action-preview' + (isMutation ? ' mcp-action-preview-mutation' : '') + '">';
    html += '<h4>Preview: ' + esc(preview.action_id) + '</h4>';
    html += '<p class="mcp-action-meta"><strong>Category:</strong> <code>' + esc(preview.category) + '</code> &nbsp; ';
    html += '<strong>Client:</strong> <code>' + esc(preview.client_scope) + '</code> &nbsp; ';
    html += '<strong>Control:</strong> <code>' + esc(preview.control_scope) + '</code> &nbsp; ';
    html += '<strong>Risk:</strong> <code>' + esc(preview.risk_level) + '</code>';
    if (preview.rollback_strategy && preview.rollback_strategy !== 'none') {
      html += ' &nbsp; <strong>Rollback:</strong> <code>' + esc(preview.rollback_strategy) + '</code>';
    }
    html += '</p>';
    html += '<p class="mcp-action-summary">' + esc(preview.command_summary) + '</p>';
    if (preview.touched_config_path) {
      // Label the touched path by control_scope + client_scope +
      // category so the operator cannot misread the target:
      //   - vo_skill (file_mutation)    → Skill file (SKILL.md)
      //   - artifact_write              → Acceptance artifact file
      //   - mcp_connection file_mutation + client_scope=codex
      //                                 → Codex MCP config (TOML)
      //   - mcp_connection file_mutation else (Claude Desktop)
      //                                 → Claude Desktop MCP config (JSON)
      var touchedLabel;
      if (preview.control_scope === 'vo_skill') {
        touchedLabel = 'Skill file that may be modified:';
      } else if (preview.category === 'artifact_write') {
        touchedLabel = 'Artifact file that will be written:';
      } else if (preview.client_scope === 'codex') {
        touchedLabel = 'Codex MCP config file that may be modified (TOML):';
      } else {
        touchedLabel = 'Claude Desktop MCP config file that may be modified (JSON):';
      }
      html += '<p><strong>' + touchedLabel + '</strong><br><code>' + esc(preview.touched_config_path) + '</code></p>';
    }
    if (preview.reads && preview.reads.length) {
      html += '<p><strong>Reads:</strong></p><ul>';
      for (var ri = 0; ri < preview.reads.length; ri++) {
        html += '<li><code>' + esc(preview.reads[ri]) + '</code></li>';
      }
      html += '</ul>';
    }
    if (preview.mutates && preview.mutates.length) {
      html += '<p><strong>Writes / may write:</strong></p><ul>';
      for (var mi = 0; mi < preview.mutates.length; mi++) {
        html += '<li><code>' + esc(preview.mutates[mi]) + '</code></li>';
      }
      html += '</ul>';
    }
    if (preview.path_safety && preview.path_safety.ok === false) {
      // Mutation refused at preview time because of a symlink or
      // an out-of-scope parent realpath. Surface the red state
      // prominently — the Confirm button renders disabled below.
      html += '<p class="mcp-action-path-refused status-err"><strong>Refused (path safety):</strong> ' + esc(preview.path_safety.reason) + '</p>';
    }
    if (preview.change_note) {
      html += '<p class="mcp-action-change"><strong>Change:</strong> ' + esc(preview.change_note) + '</p>';
    }
    if (preview.current_entry_json) {
      // Label the current-entry disclosure by control_scope +
      // client_scope + category so the operator sees what kind of
      // existing bytes would be replaced / backed up:
      //   - vo_skill (file_mutation)    → current Codex Skill
      //                                   target state (sha256 +
      //                                   mtime + size summary)
      //   - artifact_write              → current acceptance cell
      //   - mcp_connection file_mutation + client_scope=codex
      //                                 → current
      //                                   [mcp_servers.verity-one]
      //                                   TOML section bytes
      //   - mcp_connection file_mutation else (Claude Desktop)
      //                                 → current
      //                                   mcpServers.verity-one
      //                                   JSON entry
      var entryLabel;
      if (preview.control_scope === 'vo_skill') {
        entryLabel = 'Current Codex Skill target state (will be replaced / backed up):';
      } else if (preview.category === 'artifact_write') {
        entryLabel = 'Current acceptance cell for this client (will be replaced / backed up):';
      } else if (preview.client_scope === 'codex') {
        entryLabel = 'Current <code>[mcp_servers.verity-one]</code> section (TOML; will be replaced / backed up):';
      } else {
        entryLabel = 'Current <code>mcpServers.verity-one</code> entry (will be replaced / backed up):';
      }
      html += '<p><strong>' + entryLabel + '</strong></p>';
      html += '<pre class="mcp-action-current-entry">' + esc(preview.current_entry_json) + '</pre>';
    }
    if (preview.proposed_next_value) {
      // Label the proposed-next disclosure by client_scope +
      // category. For Codex MCP install/force we show the exact
      // TOML block that will land on disk, byte-identical to
      // buildCodexTomlBlock's output (drift-guarded). For other
      // file_mutation kinds the field is null and this block
      // does not render.
      var proposedLabel;
      if (preview.client_scope === 'codex' && preview.control_scope === 'mcp_connection') {
        proposedLabel = 'Proposed next <code>[mcp_servers.verity-one]</code> section (TOML; what will be written):';
      } else {
        proposedLabel = 'Proposed next value (what will be written):';
      }
      html += '<p><strong>' + proposedLabel + '</strong></p>';
      html += '<pre class="mcp-action-proposed-next">' + esc(preview.proposed_next_value) + '</pre>';
    }
    if (preview.backup_note) {
      html += '<p class="mcp-action-backup"><strong>Backup:</strong> ' + esc(preview.backup_note) + '</p>';
    }
    if (preview.notes && preview.notes.length) {
      html += '<ul class="mcp-action-notes">';
      for (var j = 0; j < preview.notes.length; j++) {
        html += '<li>' + esc(preview.notes[j]) + '</li>';
      }
      html += '</ul>';
    }
    var confirmLabel = isMutation
      ? 'Confirm &amp; run this local operator action'
      : 'Confirm &amp; run read-only check';
    var pathRefused = !!(preview.path_safety && preview.path_safety.ok === false);
    html += '<div class="mcp-action-confirm">';
    html += '<button class="mcp-action-go" ' +
      (pathRefused ? 'disabled ' : '') +
      'data-token="' + esc(preview.confirmation_token) + '" data-action-id="' + esc(preview.action_id) + '">' +
      confirmLabel +
      (pathRefused ? ' (refused by path-safety check)' : '') +
      '</button> ';
    html += '<button class="mcp-action-cancel">Cancel</button>';
    html += '</div>';
    html += '</div>';
    panel.innerHTML = html;
    var goBtn = panel.querySelector('.mcp-action-go');
    if (goBtn) {
      // Stash recorder args on the Go button so execute re-sends
      // the SAME typed-args shape preview validated. Token is
      // bound to hash(args); mismatch → execute refuses.
      var stashedArgs = preview.__recorder_args || null;
      goBtn.__recorder_args = stashedArgs;
      goBtn.addEventListener('click', function() {
        executeConfirmedAction(
          goBtn.getAttribute('data-action-id') || '',
          goBtn.getAttribute('data-token') || '',
          goBtn,
          goBtn.__recorder_args,
        );
      });
    }
    var cancelBtn = panel.querySelector('.mcp-action-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() { panel.innerHTML = ''; });
    }
  }

  function executeConfirmedAction(actionId, token, button, recorderArgs) {
    if (ALL_ACTION_IDS.indexOf(actionId) === -1) return;
    if (button) { button.disabled = true; button.textContent = 'Running…'; }
    var args = recorderArgs || {};
    fetch(dashUrl('/dashboard/mcp-actions/execute'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        action_id: actionId,
        args: args,
        confirmation_token: token
      })
    })
      .then(function(res) { return res.json().then(function(j) { return { status: res.status, json: j }; }); })
      .then(function(r) {
        renderExecuteResult(r);
      })
      .catch(function(err) {
        var panel = document.getElementById('mcp-action-panel');
        if (panel) panel.innerHTML = '<div class="state-msg status-err">Execute failed: ' + esc(err.message) + '</div>';
      });
  }

  function renderExecuteResult(r) {
    var panel = document.getElementById('mcp-action-panel');
    if (!panel) return;
    if (!r.json || !r.json.ok) {
      panel.innerHTML = '<div class="state-msg status-err">Action refused: ' + esc((r.json && r.json.error) || ('HTTP ' + r.status)) + '</div>';
      return;
    }
    var result = r.json.result || {};
    var outcomeCls = result.outcome === 'pass' ? 'status-ok' : 'status-err';
    var html = '<div class="mcp-action-result">';
    html += '<h4>Result: <span class="' + outcomeCls + '">' + esc(result.outcome || 'unknown') + '</span></h4>';
    html += '<p><strong>Summary (redacted):</strong></p>';
    html += '<pre class="mcp-action-output">' + esc(result.summary || '') + '</pre>';
    html += '<p class="mcp-op-note">Duration: ' + esc(String(result.duration_ms || 0)) + ' ms. The summary above went through the secret redactor; raw stdout/stderr is never persisted.</p>';
    if (result.status_reread_error) {
      html += '<p class="mcp-op-note status-err">Status re-read failed: ' + esc(result.status_reread_error) + '</p>';
    } else if (result.status_after) {
      html += '<p class="mcp-op-note">Dashboard evidence re-read: acceptance artifact <code>' + esc(result.status_after.artifact_kind) + '</code> plus current Skill-checker filesystem evidence where applicable. Exit code alone never promotes status; the table below reflects current evidence.</p>';
    }
    html += '<button class="mcp-action-close">Close</button>';
    html += '</div>';
    panel.innerHTML = html;
    var closeBtn = panel.querySelector('.mcp-action-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        panel.innerHTML = '';
        fetchMcpControls();
      });
    }
    // Also refresh the evidence table immediately so the
    // post-action read is visible even if the operator does not
    // click "Close" right away.
    fetchMcpControls();
  }

  // ── Init ──────────────────────────────────────────────────────────
  render();
})();
</script>
</body>
</html>`;
