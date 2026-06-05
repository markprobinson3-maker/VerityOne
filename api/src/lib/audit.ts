/**
 * F9: canonical mutation audit wrapper.
 *
 * `auditMutation(c, sql, event, opts?)` is the single entry point for
 * writing operator-facing audit rows for tenant mutations. It:
 *   - extracts `correlation_id` from `c.get("correlation_id")` (set by
 *     F8's `correlationIdMiddleware`),
 *   - dispatches to the right backing table based on `event.kind`,
 *   - honors `opts.durability` so security-sensitive mutations can roll
 *     back if the audit row fails (`required`) while telemetry stays
 *     best-effort. Calls that pass a transaction default to `required`;
 *     outside a transaction the default is `best_effort`.
 *
 * Memory lifecycle is special:
 *   - `memory_events` is written by the existing helpers (`writeMemory`,
 *     `updateMemory`, `retractMemory`, `forgetMemory`, `approveMemory`)
 *     inside their `sql.begin(...)` blocks. F9 threads `correlation_id`
 *     into those helpers via their `opts` parameter; this wrapper does
 *     NOT add a second `memory_events` row.
 *   - This wrapper writes only the operator-facing `hosted_audit_log`
 *     row for memory_* events, after the lifecycle helper succeeds.
 *
 * Federation telemetry (`federation_activity`) is written directly by
 * the existing `writeActivityEvent` / `emit*` helpers in
 * `federation-activity-writer.ts`. F9 threads `correlation_id` into
 * those helpers — this wrapper does not duplicate their writes.
 */

import type { Context } from "hono";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
type SqlOrTx = SqlClient | { json: (v: unknown) => any; (...args: any[]): any };

// ============================================================================
// Event types — discriminated union over kind
// ============================================================================

export type ActorKind =
  | "operator_token"
  | "admin_session"
  | "tenant_session"
  | "hosted_agent"
  | "oauth_client";

export interface AuditEventBase {
  /** Tenant scope for the audit row. Required for all events. */
  tenantId: string;
  /** Free-form actor label (e.g. agent id, operator hash prefix). */
  actor?: string | null;
  /** Actor classification — one of the controlled vocabulary values. */
  actorKind?: ActorKind;
  /** Optional account_id (UUID) for hosted-account-mediated events. */
  accountId?: string | null;
  /** Optional structured metadata. Will be redacted by the wrapper. */
  eventData?: Record<string, unknown>;
}

export interface MemoryAuditEvent extends AuditEventBase {
  kind:
    | "memory_created"
    | "memory_updated"
    | "memory_retracted"
    | "memory_forgotten"
    | "memory_approved"
    | "memory_conflict_detected"
    | "memory_conflict_resolved";
  addr: string;
  relatedAddr?: string;
  conflictId?: number | string;
}

export interface ProjectAuditEvent extends AuditEventBase {
  kind:
    | "project_created"
    | "project_renamed"
    | "project_archived"
    | "project_unarchived"
    | "project_moved"
    | "project_described";
  projectAddr: string;
}

export interface PyramidAuditEvent extends AuditEventBase {
  kind: "pyramid_created" | "pyramid_renamed" | "pyramid_deleted";
  pyramidId: string;
}

export interface NodeAuditEvent extends AuditEventBase {
  kind: "node_published" | "node_unpublished";
  addr: string;
}

export interface AdminAuditEvent extends AuditEventBase {
  kind: "admin_login" | "admin_action";
  /** Operation name for admin_action (e.g. "approve_proposal"). */
  operation?: string;
}

export interface RecallOutcomeAuditEvent extends AuditEventBase {
  kind: "recall_outcome_logged";
}

export interface AgentAuditEvent extends AuditEventBase {
  kind: "agent_created" | "agent_updated" | "agent_disabled";
  agentId: string;
}

export interface OAuthAuditEvent extends AuditEventBase {
  kind:
    | "oauth_client_register"
    | "oauth_authorize"
    | "oauth_token_issue"
    | "oauth_token_refresh"
    | "oauth_token_revoke"
    | "oauth_refresh_replay_detected"
    // Retention lifecycle transitions (status-flip sweeps, never deletes).
    | "oauth_client_dormant"
    | "oauth_client_archived"
    | "oauth_grant_expired";
  clientId?: string;
}

export interface TenantSettingsAuditEvent extends AuditEventBase {
  kind: "tenant_settings_changed";
  /** Setting key being changed (e.g. "vo_enabled"). */
  settingKey: string;
}

export interface SupercronForceRunAuditEvent extends AuditEventBase {
  kind: "supercron_force_run";
}

export interface VaultFileTombstonedAuditEvent extends AuditEventBase {
  kind: "vault_file_tombstoned";
  /** Node whose vault_file source_ref was soft-tombstoned (Rung 6). */
  addr: string;
  /** Local vault-relative dossier path — operator-facing audit only. */
  path: string;
  /** The ref's sha256, keying the audit row back to the exact ref. */
  sha256: string;
}

export type AuditEvent =
  | MemoryAuditEvent
  | ProjectAuditEvent
  | PyramidAuditEvent
  | NodeAuditEvent
  | AdminAuditEvent
  | RecallOutcomeAuditEvent
  | AgentAuditEvent
  | OAuthAuditEvent
  | TenantSettingsAuditEvent
  | SupercronForceRunAuditEvent
  | VaultFileTombstonedAuditEvent;

// ============================================================================
// Options
// ============================================================================

export interface AuditMutationOptions {
  /**
   * `required` — throw if the audit insert fails (so the caller's
   * `sql.begin(...)` rolls back). Use for security-sensitive mutations
   * (admin actions, account/credential changes, key rotations).
   *
   * `best_effort` — log the failure server-side but do not
   * throw. Use for read-side telemetry and non-critical mutations.
   *
   * Default: `required` when `tx` is supplied, otherwise `best_effort`.
   */
  durability?: "required" | "best_effort";
  /**
   * Optional caller-supplied correlation id. If omitted, the wrapper
   * extracts it from `c.get("correlation_id")`. Useful for callers
   * that have a correlation id from a parent request that has already
   * exited its Hono context (e.g., remote-command-dispatch handlers).
   */
  correlationId?: string | null;
  /**
   * Optional caller-supplied transaction handle. When set, the audit
   * insert runs inside the caller's `sql.begin(...)` so it commits
   * atomically with the parent mutation. Required for `durability:
   * "required"` events that must roll back together with the mutation.
   */
  tx?: SqlOrTx;
}

// ============================================================================
// Helpers
// ============================================================================

function actorKindOrDefault(event: AuditEvent): ActorKind {
  return event.actorKind ?? "tenant_session";
}

function buildEventData(event: AuditEvent): Record<string, unknown> {
  const base = { ...(event.eventData ?? {}) };
  switch (event.kind) {
    case "memory_created":
    case "memory_updated":
    case "memory_retracted":
    case "memory_forgotten":
    case "memory_approved":
    case "memory_conflict_detected":
    case "memory_conflict_resolved":
      base.addr = event.addr;
      if (event.relatedAddr) base.related_addr = event.relatedAddr;
      if (event.conflictId !== undefined) base.conflict_id = event.conflictId;
      break;
    case "project_created":
    case "project_renamed":
    case "project_archived":
    case "project_unarchived":
    case "project_moved":
    case "project_described":
      base.project_addr = event.projectAddr;
      break;
    case "pyramid_created":
    case "pyramid_renamed":
    case "pyramid_deleted":
      base.pyramid_id = event.pyramidId;
      break;
    case "node_published":
    case "node_unpublished":
      base.addr = event.addr;
      break;
    case "admin_action":
      if (event.operation) base.operation = event.operation;
      break;
    case "recall_outcome_logged":
      break;
    case "agent_created":
    case "agent_updated":
    case "agent_disabled":
      base.agent_id = event.agentId;
      break;
    case "oauth_client_register":
    case "oauth_authorize":
    case "oauth_token_issue":
    case "oauth_token_refresh":
    case "oauth_token_revoke":
    case "oauth_refresh_replay_detected":
    case "oauth_client_dormant":
    case "oauth_client_archived":
    case "oauth_grant_expired":
      if (event.clientId) base.client_id = event.clientId;
      break;
    case "tenant_settings_changed":
      base.setting_key = event.settingKey;
      break;
    case "supercron_force_run":
      break;
    case "vault_file_tombstoned":
      base.addr = event.addr;
      base.path = event.path;
      base.sha256 = event.sha256;
      break;
  }
  return base;
}

function extractAddr(event: AuditEvent): string | null {
  if ("addr" in event && typeof event.addr === "string") return event.addr;
  return null;
}

// ============================================================================
// auditMutation
// ============================================================================

/**
 * Write an operator-facing audit row for the given mutation event.
 *
 * Auto-extracts `correlation_id` from `c.get("correlation_id")`. Pass
 * `opts.tx` to run the insert inside the caller's existing transaction.
 * `opts.durability="required"` makes audit failure roll back the parent
 * mutation. Defaults to `required` when `opts.tx` is supplied and
 * `best_effort` otherwise.
 */
export async function auditMutation(
  c: Context,
  sql: SqlClient,
  event: AuditEvent,
  opts: AuditMutationOptions = {},
): Promise<void> {
  const correlationId =
    opts.correlationId !== undefined
      ? opts.correlationId
      : ((c.get("correlation_id") as string | undefined) ?? null);

  const handle = (opts.tx ?? sql) as any;
  const durability = opts.durability ?? (opts.tx ? "required" : "best_effort");
  const actorKind = actorKindOrDefault(event);
  const eventData = buildEventData(event);
  const accountId = event.accountId ?? null;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await handle`
        INSERT INTO hosted_audit_log
          (event_type, actor_kind, actor_label, account_id, tenant_id, event_data, correlation_id)
        VALUES (
          ${event.kind}, ${actorKind}, ${event.actor ?? ""}, ${accountId},
          ${event.tenantId}, ${handle.json(eventData)}, ${correlationId}
        )
      `;
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as any)?.code;
      if (attempt === 0 && (code === "40001" || code === "40P01")) {
        continue;
      }
      break;
    }
  }
  if (durability === "required") {
    throw lastErr;
  }
  // best-effort: log but swallow so the user-facing route still succeeds.
  const cid = correlationId ?? "no-correlation-id";
  console.error(
    `[audit] best-effort write failed for kind=${event.kind} tenant=${event.tenantId} correlation=${cid}:`,
    (lastErr as Error)?.message,
  );
}

/**
 * Worker-side audit insert for local background paths that have no Hono
 * Context. This writes the same hosted_audit_log shape as auditMutation
 * but defaults to best-effort durability: the worker cannot roll back a
 * helper mutation that has already committed, and failed audit writes
 * must not wedge the remote command loop.
 */
export async function auditMutationFromWorker(
  sql: SqlClient,
  event: AuditEvent,
  opts: Omit<AuditMutationOptions, "tx"> & { tx?: SqlOrTx } = {},
): Promise<void> {
  const handle = (opts.tx ?? sql) as any;
  const durability = opts.durability ?? "best_effort";
  const correlationId = opts.correlationId ?? null;
  const actorKind = actorKindOrDefault(event);
  const eventData = buildEventData(event);
  const accountId = event.accountId ?? null;

  try {
    await handle`
      INSERT INTO hosted_audit_log
        (event_type, actor_kind, actor_label, account_id, tenant_id, event_data, correlation_id)
      VALUES (
        ${event.kind}, ${actorKind}, ${event.actor ?? ""}, ${accountId},
        ${event.tenantId}, ${handle.json(eventData)}, ${correlationId}
      )
    `;
  } catch (err) {
    if (durability === "required") {
      throw err;
    }
    const cid = correlationId ?? "no-correlation-id";
    console.error(
      `[audit] worker best-effort write failed for kind=${event.kind} tenant=${event.tenantId} correlation=${cid}:`,
      (err as Error)?.message,
    );
  }
}
