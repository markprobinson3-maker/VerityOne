/**
 * Dashboard overview aggregator — reads from existing honest data seams
 * to produce a compact snapshot for the local dashboard Home tab.
 *
 * Mounted under /dashboard/* (not /memory/*) to avoid the requireVoEnabled()
 * gate — the dashboard should render even when vo_enabled=false, which is
 * exactly when the operator needs it most.
 *
 * Honesty boundaries:
 * - Provider health: "configured" or "unconfigured" only — no live validation
 * - Routine health: combines vi_schedules with day-journal routine state;
 *   both fail soft so Home can render on partial local installs
 * - Hosted/account: best-effort from local tables — null when not derivable
 * - API keys: NEVER returned in the response
 *
 * Local-dashboard-only: this helper may read ~/.vo display/cache files
 * for Account / Sync state. Hosted portal routes must not import it.
 */

import type postgres from "postgres";
import {
  readDayJournalRoutineSchedulerStatus,
  type DayJournalRoutineSchedulerStatus,
} from "./day-journal/routine-scheduler-status";

type SqlTag = ReturnType<typeof postgres>;

type NeedsAttentionRow = {
  type: string;
  message: string;
  severity: "red" | "amber";
  tab: string;
  filter: string;
  label: string;
};

type DayJournalOverviewMode = "available" | "unavailable";

type DayJournalOverviewDefinition = {
  id: string;
  permissions: readonly string[];
};

type DayJournalOverviewSettingsRow = {
  routine_id?: unknown;
  enabled?: unknown;
  permission_grants?: unknown;
};

type DayJournalOverviewRunRow = {
  routine_id?: unknown;
  run_status?: unknown;
  result_status?: unknown;
  error?: unknown;
  started_at?: unknown;
};

type DayJournalOverviewSummary = {
  total_count: number;
  enabled_count: number;
  failing_count: number;
  recent_run_count: number;
  recent_failure_count: number;
  consecutive_failure_count: number;
  failure_rate_24h: number;
  last_run_at: string | null;
  mode: DayJournalOverviewMode;
  last_error_reason: string | null;
};

type DayJournalOverviewSummaryInput = {
  definitions: DayJournalOverviewDefinition[];
  settingsRows: DayJournalOverviewSettingsRow[];
  latestRunRows: DayJournalOverviewRunRow[];
  recentRunRows?: DayJournalOverviewRunRow[];
  mode?: DayJournalOverviewMode;
  lastErrorReason?: string | null;
};

export interface DashboardOverview {
  ok: true;
  health: {
    uptime_s: number;
    node_count: number;
    settings: {
      vo_enabled: unknown;
      public_resonance: unknown;
      hosted_sync: unknown;
      vault_sync: unknown;
      public_overlay_sync: unknown;
    };
    invalid_settings_count: number;
  };
  review: {
    pending_count: number;
  };
  activity: {
    total_count: number;
    preview_count: number;
    latest_event_at: string | null;
    recent_items: Array<{
      addr: string;
      label: string | null;
      kind: string | null;
      event_type: string;
      actor: string | null;
      created_at: string;
    }>;
  };
  setup: {
    google_linked: boolean | null;
    provider_configured: boolean;
    has_active_project: boolean;
    has_any_routine: boolean;
    hosted_sync_enabled: boolean;
    complete_count: number;
    total_count: number;
  };
  structure: {
    project_count: number;
    active_memory_count: number;
    projects_missing_description_count: number;
  };
  providers: {
    configured_count: number;
    configured_providers: string[];
    task_routing: Record<string, unknown>;
  };
  routines: {
    total_count: number;
    enabled_count: number;
    failing_count: number;
    stale_count: number;
    last_run_at: string | null;
    schedule_last_run_at: string | null;
    day_journal_last_run_at: string | null;
    schedule_total_count: number;
    schedule_enabled_count: number;
    schedule_failing_count: number;
    day_journal_total_count: number;
    day_journal_enabled_count: number;
    day_journal_failing_count: number;
    day_journal_recent_run_count: number;
    day_journal_recent_failure_count: number;
    day_journal_consecutive_failure_count: number;
    day_journal_failure_rate_24h: number;
    day_journal_mode: DayJournalOverviewMode;
    day_journal_last_error_reason: string | null;
    day_journal_scheduler_status: DayJournalRoutineSchedulerStatus;
    day_journal_scheduler_last_heartbeat_at: string | null;
  };
  needs_attention: NeedsAttentionRow[];
}

function overviewStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function overviewTimestampIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function latestOverviewTimestampIso(values: unknown[]): string | null {
  let latestIso: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const iso = overviewTimestampIso(value);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestIso = iso;
    }
  }
  return latestIso;
}

function overviewErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "unknown_error");
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || "unknown_error";
}

function overviewScheduleIsStale(row: any, now: number, staleThreshold: number): boolean {
  const staleAt = overviewTimestampIso(row?.last_run_at) || overviewTimestampIso(row?.created_at);
  if (!staleAt) return false;
  return now - Date.parse(staleAt) > staleThreshold;
}

function dayJournalRunNeedsAttention(row: DayJournalOverviewRunRow | undefined): boolean {
  const runStatus = typeof row?.run_status === "string" ? row.run_status : null;
  const resultStatus = typeof row?.result_status === "string" ? row.result_status : null;
  const error = typeof row?.error === "string" ? row.error : null;
  return runStatus === "failed"
    || runStatus === "rejected"
    || resultStatus === "error"
    || Boolean(error);
}

function overviewRunStartedMs(row: DayJournalOverviewRunRow): number {
  const iso = overviewTimestampIso(row.started_at);
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function summarizeDashboardDayJournalRoutines(
  input: DayJournalOverviewSummaryInput,
): DayJournalOverviewSummary {
  const knownRoutineIds = new Set(input.definitions.map((def) => def.id));
  const settingsByRoutine = new Map<string, DayJournalOverviewSettingsRow>();
  for (const row of input.settingsRows) {
    if (typeof row.routine_id === "string") settingsByRoutine.set(row.routine_id, row);
  }

  const latestRunByRoutine = new Map<string, DayJournalOverviewRunRow>();
  for (const row of input.latestRunRows) {
    if (typeof row.routine_id === "string") latestRunByRoutine.set(row.routine_id, row);
  }

  let enabledCount = 0;
  let failingCount = 0;
  const lastRunAt = latestOverviewTimestampIso(input.latestRunRows.map((row) => row.started_at));
  const recentRunRows = (input.recentRunRows || []).filter((row) =>
    typeof row.routine_id === "string" && knownRoutineIds.has(row.routine_id)
  );
  const recentFailureCount = recentRunRows.filter((row) => dayJournalRunNeedsAttention(row)).length;
  const failureRate24h = recentRunRows.length > 0 ? recentFailureCount / recentRunRows.length : 0;
  let consecutiveFailureCount = 0;
  for (const def of input.definitions) {
    const settings = settingsByRoutine.get(def.id);
    if (settings?.enabled !== true) continue;
    enabledCount += 1;

    const granted = new Set(overviewStringArray(settings.permission_grants));
    const missingGrant = def.permissions.some((permission) => !granted.has(permission));
    if (missingGrant || dayJournalRunNeedsAttention(latestRunByRoutine.get(def.id))) {
      failingCount += 1;
    }

    const routineRecentRuns = recentRunRows
      .filter((row) => row.routine_id === def.id)
      .sort((a, b) => overviewRunStartedMs(b) - overviewRunStartedMs(a));
    for (const row of routineRecentRuns) {
      if (!dayJournalRunNeedsAttention(row)) break;
      consecutiveFailureCount += 1;
    }
  }

  return {
    total_count: input.definitions.length,
    enabled_count: enabledCount,
    failing_count: failingCount,
    recent_run_count: recentRunRows.length,
    recent_failure_count: recentFailureCount,
    consecutive_failure_count: consecutiveFailureCount,
    failure_rate_24h: failureRate24h,
    last_run_at: lastRunAt,
    mode: input.mode ?? "available",
    last_error_reason: input.lastErrorReason ?? null,
  };
}

async function readDashboardOverviewViSchedules(sql: SqlTag): Promise<any[]> {
  try {
    return await sql`SELECT id, enabled, last_run_at, last_status, created_at FROM vi_schedules`;
  } catch (error) {
    console.warn("[dashboard/overview] vi_schedules summary unavailable", error);
    return [];
  }
}

export async function readDashboardOverviewDayJournalRoutineSummary(
  sql: SqlTag,
  tenantId: string,
): Promise<DayJournalOverviewSummary> {
  const { listRoutines } = await import("./day-journal/routines");
  const definitions = listRoutines().map((def) => ({
    id: def.id,
    permissions: def.permissions,
  }));

  try {
    const [settingsRows, latestRunRows, recentRunRows] = await Promise.all([
      sql`
        SELECT routine_id, enabled, permission_grants
        FROM tenant_day_journal_routines
        WHERE tenant_id = ${tenantId}
      `,
      sql`
        SELECT DISTINCT ON (routine_id)
          routine_id, run_status, result_status, error, started_at
        FROM tenant_day_journal_routine_runs
        WHERE tenant_id = ${tenantId}
          AND dry_run = false
        ORDER BY routine_id, started_at DESC, id DESC
      `,
      sql`
        SELECT routine_id, run_status, result_status, error, started_at
        FROM tenant_day_journal_routine_runs
        WHERE tenant_id = ${tenantId}
          AND dry_run = false
          AND started_at >= now() - interval '24 hours'
        ORDER BY started_at DESC, id DESC
        LIMIT 200
      `,
    ]);

    return summarizeDashboardDayJournalRoutines({
      definitions,
      settingsRows,
      latestRunRows,
      recentRunRows,
      mode: "available",
    });
  } catch (error) {
    console.warn("[dashboard/overview] day-journal routine summary unavailable", error);
    const reason = overviewErrorReason(error);
    return summarizeDashboardDayJournalRoutines({
      definitions,
      settingsRows: [],
      latestRunRows: [],
      recentRunRows: [],
      mode: "unavailable",
      lastErrorReason: reason,
    });
  }
}

export async function getDashboardOverview(
  sql: SqlTag,
  tenantId: string,
): Promise<DashboardOverview> {
  const spaceId = `tenant:${tenantId}`;

  // ── Parallel data fetches ──────────────────────────────────────────

  const [
    nodeCountResult,
    activeMemoryCount,
    reviewItems,
    recentEvents,
    activityCountResult,
    projectRows,
    scheduleRows,
    dayJournalRoutineSummary,
    dayJournalRoutineSchedulerStatus,
    googleLinkResult,
  ] = await Promise.all([
    // Node count (cheap)
    sql`SELECT COUNT(*)::int as count FROM nodes WHERE space_id = ${spaceId} AND visibility <> 'deleted'`,
    // Active memory count (cheap, indexed)
    sql`SELECT COUNT(*)::int as count FROM memory_registry WHERE tenant_id = ${tenantId} AND status = 'active'`,
    // Review queue count (moderate)
    import("./memory-audit").then(({ listReviewableMemories }) =>
      listReviewableMemories(sql as any, tenantId, 1), // just need count, limit 1 is cheap
    ),
    // Recent events preview (moderate)
    import("./memory-lifecycle").then(({ listRecentTenantEvents }) =>
      listRecentTenantEvents(sql as any, tenantId, 5),
    ),
    // Total activity count (cheap, indexed)
    sql`SELECT COUNT(*)::int as count FROM memory_events WHERE tenant_id = ${tenantId}`,
    // Project count + description check (moderate)
    sql`
      SELECT addr, label, substance->>'description' as description, dormant_at
      FROM nodes
      WHERE pyramid_id = 'PROJECTS' AND depth = 1 AND space_id = ${spaceId} AND dormant_at IS NULL AND visibility <> 'deleted'
    `,
    // Schedule summary (cheap, fail-soft on older local installs)
    readDashboardOverviewViSchedules(sql),
    // Day-journal routine summary (fail-soft while PR-rung tables migrate)
    readDashboardOverviewDayJournalRoutineSummary(sql, tenantId),
    // Local scheduler worker heartbeat (fail-soft on older installs)
    readDayJournalRoutineSchedulerStatus(sql),
    // Google account link (best-effort — may not exist on local-only installs)
    // Returns { found: true/false } on success, null on table-not-found/error
    sql`
      SELECT tenant_id, status FROM account_tenant_links
      WHERE tenant_id = ${tenantId} AND status = 'active'
      LIMIT 1
    `.then((rows: any[]) => ({ reachable: true, linked: rows.length > 0 }))
     .catch(() => ({ reachable: false, linked: false })),
  ]);

  // ── Settings (from config file, no DB) ─────────────────────────────

  const { resolveTenantSettings } = await import("./runtime-profile");
  const settings = resolveTenantSettings();

  // ── Local Account / Sync file-backed state (best effort) ───────────

  let localCredential: any = null;
  let localAttempt: any = null;
  let localAccountUiState: any = {};
  let localSyncHealth: string | null = null;
  let localSyncStatus: any = null;
  try {
    const { readLocalSyncCredential } = await import("./local-credential-store");
    localCredential = readLocalSyncCredential();
  } catch { /* local-only credential cache unavailable */ }
  try {
    const { readLocalConnectAttempt } = await import("./local-connect-state");
    localAttempt = readLocalConnectAttempt();
  } catch { /* local-only connect attempt unavailable */ }
  try {
    const { readLocalAccountUiState } = await import("./local-account-ui-state");
    localAccountUiState = readLocalAccountUiState();
  } catch { /* local-only UI cache unavailable */ }
  try {
    const [{ getSyncStatus }, { computeLocalSyncHealth }] = await Promise.all([
      import("./sync-exporter"),
      import("./federation-sync-health"),
    ]);
    localSyncStatus = await getSyncStatus(sql as any);
    localSyncHealth = computeLocalSyncHealth({
      syncConfigured: Boolean(localSyncStatus.sync_configured),
      lastAttemptAt: localSyncStatus.last_attempt?.last_attempt_at ?? null,
      lastResult: localSyncStatus.last_attempt?.last_result ?? null,
      hostedLastSyncAt: null,
    });
  } catch { /* sync status unavailable */ }

  // ── Provider summary (canonical helper, NO KEYS) ────────────────────

  const { readProviderSummary } = await import("./provider-config");
  const providerSummary = readProviderSummary();
  const configuredProviderNames = Object.entries(providerSummary.providers)
    .filter(([, v]) => v.configured)
    .map(([name]) => name);

  // ── Compute sections ───────────────────────────────────────────────

  const nodeCount = nodeCountResult[0]?.count || 0;
  const activeMemCount = activeMemoryCount[0]?.count || 0;
  // Review: get real pending count (listReviewableMemories with limit 1 tells us if any exist)
  const [pendingCountResult] = await sql`
    SELECT COUNT(*)::int as count FROM nodes
    WHERE space_id = ${spaceId}
      AND node_type = 'memory'
      AND visibility <> 'deleted'
      AND dormant_at IS NULL
      AND substance->>'source_kind' = 'agent_inferred'
      AND (substance->>'accepted_by_user')::boolean IS NOT TRUE
  `;
  const pendingCount = pendingCountResult?.count || 0;

  const activeProjects = projectRows.filter((r: any) => !r.dormant_at);
  const projectsMissingDesc = activeProjects.filter((r: any) => !r.description).length;

  const enabledSchedules = scheduleRows.filter((r: any) => r.enabled);
  const failingSchedules = scheduleRows.filter((r: any) => r.enabled && r.last_status === "error");
  const now = Date.now();
  const staleThreshold = 24 * 60 * 60 * 1000;
  const staleSchedules = enabledSchedules.filter((r: any) => overviewScheduleIsStale(r, now, staleThreshold));
  const scheduleLastRunAt = latestOverviewTimestampIso(scheduleRows.map((r: any) => r.last_run_at));
  const dayJournalLastRunAt = dayJournalRoutineSummary.last_run_at;
  const lastRunAt = latestOverviewTimestampIso([scheduleLastRunAt, dayJournalLastRunAt]);
  const scheduleTotalCount = scheduleRows.length;
  const scheduleEnabledCount = enabledSchedules.length;
  const scheduleFailingCount = failingSchedules.length;
  const combinedRoutineTotalCount = scheduleTotalCount + dayJournalRoutineSummary.total_count;
  const combinedRoutineEnabledCount = scheduleEnabledCount + dayJournalRoutineSummary.enabled_count;
  const combinedRoutineFailingCount = scheduleFailingCount + dayJournalRoutineSummary.failing_count;

  // Three-valued: true (linked), false (table reachable, not linked), null (table unreachable)
  const linkState = googleLinkResult as { reachable: boolean; linked: boolean };
  const googleLinked: boolean | null = linkState.reachable ? linkState.linked : null;

  // ── Setup checklist ────────────────────────────────────────────────

  const setupChecks = {
    google_linked: googleLinked,
    provider_configured: configuredProviderNames.length > 0,
    has_active_project: activeProjects.length > 0,
    has_any_routine: combinedRoutineTotalCount > 0,
    hosted_sync_enabled: settings.hosted_sync !== "off",
  };
  const checkValues = [
    setupChecks.google_linked === true,
    setupChecks.provider_configured,
    setupChecks.has_active_project,
    setupChecks.has_any_routine,
    setupChecks.hosted_sync_enabled,
  ];
  const completeCount = checkValues.filter(Boolean).length;

  // ── Needs attention ────────────────────────────────────────────────

  const needsAttention: NeedsAttentionRow[] = [];
  const alert = (row: NeedsAttentionRow) => needsAttention.push(row);

  if (pendingCount > 0) {
    alert({
      type: "pending_review",
      message: `${pendingCount} memor${pendingCount === 1 ? "y" : "ies"} pending review`,
      severity: pendingCount > 20 ? "red" : "amber",
      tab: "review",
      filter: "pending",
      label: "Review memories",
    });
  }
  if (settings.invalid.length > 0) {
    alert({
      type: "invalid_settings",
      message: `${settings.invalid.length} invalid setting${settings.invalid.length === 1 ? "" : "s"} in config`,
      severity: "red",
      tab: "settings",
      filter: "invalid",
      label: "Open settings",
    });
  }
  if (scheduleFailingCount > 0) {
    alert({
      type: "failing_routines",
      message: `${scheduleFailingCount} routine${scheduleFailingCount === 1 ? "" : "s"} failing`,
      severity: "red",
      tab: "routines",
      filter: "failing",
      label: "View routines",
    });
  }
  if (dayJournalRoutineSummary.failing_count > 0) {
    alert({
      type: "day_journal_routines_need_attention",
      message: `${dayJournalRoutineSummary.failing_count} day-journal routine${dayJournalRoutineSummary.failing_count === 1 ? "" : "s"} need attention`,
      severity: "red",
      tab: "routines",
      filter: "day-journal",
      label: "View routines",
    });
  }
  if (dayJournalRoutineSummary.failing_count === 0 && dayJournalRoutineSummary.recent_failure_count > 0) {
    alert({
      type: "day_journal_recent_failures",
      message: `${dayJournalRoutineSummary.recent_failure_count} day-journal run failure${dayJournalRoutineSummary.recent_failure_count === 1 ? "" : "s"} in the last 24h`,
      severity: "amber",
      tab: "routines",
      filter: "day-journal",
      label: "View routines",
    });
  }
  if (dayJournalRoutineSummary.mode === "unavailable") {
    alert({
      type: "day_journal_routines_unavailable",
      message: `Day-journal routine summary unavailable: ${dayJournalRoutineSummary.last_error_reason || "unknown_error"}`,
      severity: "amber",
      tab: "routines",
      filter: "day-journal",
      label: "View routines",
    });
  }
  if (
    dayJournalRoutineSummary.enabled_count > 0
    && dayJournalRoutineSchedulerStatus.status !== "active"
    && dayJournalRoutineSchedulerStatus.status !== "disabled"
  ) {
    alert({
      type: "day_journal_scheduler_inactive",
      message: `Day-journal routine scheduler is ${dayJournalRoutineSchedulerStatus.status}`,
      severity: dayJournalRoutineSchedulerStatus.status === "error" || dayJournalRoutineSchedulerStatus.status === "stale" ? "red" : "amber",
      tab: "routines",
      filter: "day-journal",
      label: "View routines",
    });
  }
  if (staleSchedules.length > 0) {
    alert({
      type: "stale_routines",
      message: `${staleSchedules.length} enabled routine${staleSchedules.length === 1 ? "" : "s"} stale for more than 24h`,
      severity: "amber",
      tab: "routines",
      filter: "stale",
      label: "View routines",
    });
  }
  if (configuredProviderNames.length === 0) {
    alert({
      type: "no_provider",
      message: "No LLM provider configured",
      severity: "amber",
      tab: "providers",
      filter: "setup",
      label: "Configure provider",
    });
  }
  if (activeProjects.length === 0) {
    alert({
      type: "no_project",
      message: "No active project defined",
      severity: "amber",
      tab: "structure",
      filter: "projects",
      label: "Create project",
    });
  }
  if (!settings.vo_enabled) {
    alert({
      type: "vo_disabled",
      message: "VO is disabled — memory operations are blocked",
      severity: "red",
      tab: "settings",
      filter: "vo_enabled",
      label: "Enable VO",
    });
  }
  if (googleLinked === false && !localCredential?.token_present && !localAttempt) {
    alert({
      type: "google_not_connected",
      message: "Google account is not connected",
      severity: "amber",
      tab: "account",
      filter: "google",
      label: "Connect Google",
    });
  }
  if (localAttempt?.tenant_id === tenantId && ["waiting", "callback_received", "redeeming"].includes(localAttempt.status)) {
    alert({
      type: "google_link_pending",
      message: "Google sign-in handshake is waiting for completion",
      severity: "amber",
      tab: "account",
      filter: "google",
      label: "Check Account / Sync",
    });
  }
  if (localAttempt?.tenant_id === tenantId && localAttempt.status === "error") {
    alert({
      type: "google_handshake_failed",
      message: "Google sign-in handshake failed",
      severity: "red",
      tab: "account",
      filter: "google",
      label: "Retry handshake",
    });
  }
  if (localAttempt?.tenant_id === tenantId && localAttempt.status === "expired") {
    alert({
      type: "google_reauth_required",
      message: "Google sign-in expired; re-authenticate to connect",
      severity: "amber",
      tab: "account",
      filter: "google",
      label: "Sign in again",
    });
  }
  if (localAccountUiState.hosted_error) {
    alert({
      type: "hosted_unreachable",
      message: "Hosted account status is currently unreachable",
      severity: "amber",
      tab: "account",
      filter: "hosted",
      label: "Refresh account",
    });
  }
  if (localCredential?.token_present && localCredential.tenant_id === tenantId && settings.hosted_sync === "off") {
    alert({
      type: "sync_disabled_after_link",
      message: "Hosted sync is off for a connected Google account",
      severity: "amber",
      tab: "account",
      filter: "sync",
      label: "Start sync",
    });
  }
  if (localCredential?.token_present && localCredential.tenant_id === tenantId && localSyncHealth === "never") {
    alert({
      type: "sync_never_run",
      message: "Hosted sync has not run yet",
      severity: "amber",
      tab: "account",
      filter: "sync",
      label: "Check sync",
    });
  }
  if (localCredential?.token_present && localCredential.tenant_id === tenantId && localSyncHealth === "error") {
    alert({
      type: "sync_error",
      message: "Hosted sync is reporting an error",
      severity: "red",
      tab: "account",
      filter: "sync",
      label: "Check sync",
    });
  }
  if (localCredential?.token_present && localCredential.tenant_id === tenantId && localSyncHealth === "offline") {
    alert({
      type: "sync_offline",
      message: "Hosted sync appears offline",
      severity: "amber",
      tab: "account",
      filter: "sync",
      label: "Check sync",
    });
  }

  // ── Assemble ───────────────────────────────────────────────────────

  return {
    ok: true,
    health: {
      uptime_s: Math.floor(process.uptime()),
      node_count: nodeCount,
      settings: {
        vo_enabled: settings.vo_enabled,
        public_resonance: settings.public_resonance,
        hosted_sync: settings.hosted_sync,
        vault_sync: settings.vault_sync,
        public_overlay_sync: settings.public_overlay_sync,
      },
      invalid_settings_count: settings.invalid.length,
    },
    review: {
      pending_count: pendingCount,
    },
    activity: {
      total_count: (activityCountResult as any)[0]?.count || 0,
      preview_count: recentEvents.length,
      latest_event_at: recentEvents.length > 0
        ? ((recentEvents[0] as any).created_at instanceof Date
          ? (recentEvents[0] as any).created_at.toISOString()
          : String((recentEvents[0] as any).created_at))
        : null,
      recent_items: recentEvents.map((e: any) => ({
        addr: e.addr,
        label: e.label,
        kind: e.kind,
        event_type: e.event_type,
        actor: e.actor,
        created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
      })),
    },
    setup: {
      ...setupChecks,
      complete_count: completeCount,
      total_count: checkValues.length,
    },
    structure: {
      project_count: activeProjects.length,
      active_memory_count: activeMemCount,
      projects_missing_description_count: projectsMissingDesc,
    },
    providers: {
      configured_count: configuredProviderNames.length,
      configured_providers: configuredProviderNames,
      task_routing: providerSummary.effective_routing,
    },
    routines: {
      total_count: combinedRoutineTotalCount,
      enabled_count: combinedRoutineEnabledCount,
      failing_count: combinedRoutineFailingCount,
      stale_count: staleSchedules.length,
      last_run_at: lastRunAt,
      schedule_last_run_at: scheduleLastRunAt,
      day_journal_last_run_at: dayJournalLastRunAt,
      schedule_total_count: scheduleTotalCount,
      schedule_enabled_count: scheduleEnabledCount,
      schedule_failing_count: scheduleFailingCount,
      day_journal_total_count: dayJournalRoutineSummary.total_count,
      day_journal_enabled_count: dayJournalRoutineSummary.enabled_count,
      day_journal_failing_count: dayJournalRoutineSummary.failing_count,
      day_journal_recent_run_count: dayJournalRoutineSummary.recent_run_count,
      day_journal_recent_failure_count: dayJournalRoutineSummary.recent_failure_count,
      day_journal_consecutive_failure_count: dayJournalRoutineSummary.consecutive_failure_count,
      day_journal_failure_rate_24h: dayJournalRoutineSummary.failure_rate_24h,
      day_journal_mode: dayJournalRoutineSummary.mode,
      day_journal_last_error_reason: dayJournalRoutineSummary.last_error_reason,
      day_journal_scheduler_status: dayJournalRoutineSchedulerStatus.status,
      day_journal_scheduler_last_heartbeat_at: dayJournalRoutineSchedulerStatus.last_heartbeat_at,
    },
    needs_attention: needsAttention,
  };
}
