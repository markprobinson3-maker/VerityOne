/**
 * Federation activity event writer —
 * VO-FEDERATION-ACTIVITY-DASHBOARD-PR-1 (rung 7 impl).
 *
 * Thin INSERT helper that rung 7's signal sites piggyback to emit a
 * `federation_activity` row alongside the existing hosted signal they
 * already emit (audit log, sync batch, remote-commands transitions,
 * handler errors).
 *
 * **Durability model: best-effort awaited write with visible failure
 * signaling.** Matches the shipped `logDecryptAccess()` pattern in
 * `hosted-decrypt-audit.ts`. Telemetry INSERTs are awaited so the
 * caller can set a response header on failure, but the INSERT is NEVER
 * allowed to throw through the caller. When the INSERT fails, the
 * response sets `X-VO-Activity: failed` so monitoring can detect the
 * gap.
 *
 * Per rung-6 Q3=A: typed event schema + runtime scrubber defense in
 * depth. The typed `ActivityEventData` discriminated union gates
 * deliberate field additions at compile time; the runtime
 * `redactActivityEventMetadata()` scrub catches accidents where user
 * content leaks into a JSONB field despite schema discipline.
 *
 * Per rung-6 Q4=A + rung-7 Q1=A: this helper NEVER accepts
 * `session_type='local-mcp-client'`. The TS type for
 * `WriteActivityEventInput.session_type` excludes that value; the DB
 * CHECK constraint refuses it too. Local-mcp-client presence is
 * rendered from `mcp-process-scan.ts` (live OS process enumeration),
 * not from this table.
 */

import type { Context } from "hono";
import type postgres from "postgres";

import {
  redactActivityEventMetadata,
  type ActivityEventData,
  type ActivityEventType,
} from "./federation-activity-health";

type SqlTag = ReturnType<typeof postgres>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

/** Feature-flag gate. Matches the `VERITY_EXPIRY_ENGINE` /
 *  `VERITY_REMOTE_COMMANDS` pattern — default ON, `=off` disables
 *  every writer site. Read on every call so operators can toggle
 *  without restarting the API. */
export function isActivityTelemetryEnabled(): boolean {
  return process.env.VERITY_ACTIVITY_TELEMETRY_ENABLED !== "off";
}

/** Session types the hosted table permits. Excludes
 *  `local-mcp-client` structurally — that value is reserved for the
 *  local-side OS-process-scan render and is forbidden by the
 *  migration CHECK constraint. Rung 11b extends with
 *  `hosted-mcp-connector` (web MCP connector tool calls). */
export type WritableSessionType =
  | "hosted-browser-session"
  | "hosted-mcp-agent"
  | "sync-node"
  | "hosted-mcp-connector";

export interface WriteActivityEventInput {
  tenant_id: string;
  account_id?: string | null;
  session_type: WritableSessionType;
  /** UUID for handshake-scoped sessions, or `operator_token:<8-hex>`
   *  synthetic label (matches `operatorActorLabel()` in account.ts).
   *  Fallback `"unauthenticated"` for error events fired before auth
   *  resolves. */
  session_id: string;
  event_type: ActivityEventType;
  outcome?: string | null;
  event_data: ActivityEventData;
  /** Optional override for non-Hono parent dispatch paths. */
  correlation_id?: string | null;
  /** Refusal probes can emit error evidence without inventing a live session. */
  skip_auto_initialize?: boolean;
}

function shouldAutoInitialize(input: WriteActivityEventInput): boolean {
  return !input.skip_auto_initialize
    && input.event_type !== "session_initialized"
    && input.session_id !== "unauthenticated";
}

async function insertActivityRow(
  sql: SqlTag,
  input: WriteActivityEventInput,
  correlationId: string | null,
): Promise<void> {
  const scrubbed = redactActivityEventMetadata(
    input.event_data as unknown as Record<string, unknown>,
  ) as JsonValue;

  await sql`
    INSERT INTO federation_activity (
      tenant_id,
      account_id,
      session_type,
      session_id,
      event_type,
      outcome,
      event_data,
      correlation_id
    ) VALUES (
      ${input.tenant_id},
      ${input.account_id ?? null},
      ${input.session_type},
      ${input.session_id},
      ${input.event_type},
      ${input.outcome ?? null},
      ${sql.json(scrubbed)},
      ${correlationId}
    )
    ON CONFLICT (tenant_id, session_type, session_id)
    WHERE event_type = 'session_initialized'
    DO NOTHING
  `;
}

/**
 * Emit a single `federation_activity` row. Awaited so the caller can
 * set a response header on failure, but failures are swallowed — the
 * main handler path always succeeds regardless of telemetry.
 *
 * For every non-`session_initialized` event, the writer first attempts
 * a deduped `session_initialized` row for the same
 * `(tenant, session_type, session_id)` pair. The partial unique index
 * collapses concurrent first-observation races to one row.
 */
export async function writeActivityEvent(
  sql: SqlTag,
  c: Context,
  input: WriteActivityEventInput,
): Promise<void> {
  if (!isActivityTelemetryEnabled()) return;
  const correlationId =
    input.correlation_id !== undefined
      ? input.correlation_id
      : (typeof c.get === "function"
        ? ((c.get("correlation_id") as string | undefined) ?? null)
        : null);

  try {
    if (shouldAutoInitialize(input)) {
      await insertActivityRow(sql, {
        tenant_id: input.tenant_id,
        account_id: input.account_id,
        session_type: input.session_type,
        session_id: input.session_id,
        event_type: "session_initialized",
        event_data: {
          type: "session_initialized",
          session_type: input.session_type,
        },
      }, correlationId);
    }

    await insertActivityRow(sql, input, correlationId);
    // The conflict target is intentionally narrow: only the partial
    // unique index for session_initialized first-write dedup may be
    // swallowed. CHECK violations (e.g. local-mcp-client session_type)
    // still throw — they are caught below and surface via the header.
  } catch {
    // Best-effort awaited write: the main handler MUST NOT fail because
    // telemetry failed. Surface the gap via response header so
    // monitoring can detect it.
    try { c.header("X-VO-Activity", "failed"); } catch { /* header set may also fail; ignore */ }
  }
}

/**
 * Emit a `session_initialized` event for a (session_type, session_id)
 * pair — exactly once per session thanks to the partial unique index
 * + ON CONFLICT DO NOTHING. `writeActivityEvent()` already performs
 * this automatically for non-initialized writes; this helper exists
 * for the small number of sites that want to project explicit first-
 * observation rows without a companion event.
 *
 * Convenience wrapper around `writeActivityEvent` — callers that
 * already know they're emitting the first event in a session can call
 * this directly rather than constructing the full input.
 */
export async function emitSessionInitialized(
  sql: SqlTag,
  c: Context,
  input: Omit<WriteActivityEventInput, "event_type" | "event_data" | "outcome"> & {
    event_data?: undefined;
  },
): Promise<void> {
  await writeActivityEvent(sql, c, {
    tenant_id: input.tenant_id,
    account_id: input.account_id,
    session_type: input.session_type,
    session_id: input.session_id,
    event_type: "session_initialized",
    event_data: { type: "session_initialized", session_type: input.session_type },
  });
}

/**
 * Convenience helper for the `queueCommand` caller sites. Takes the
 * `RemoteCommandRow`-shaped result + the caller's session context and
 * emits a `write_intent` event only when the row was freshly queued
 * (not an idempotency hit).
 *
 * Duck-typed against `RemoteCommandRow` so this module does not have
 * to import the full remote-command-types surface.
 */
export async function emitWriteIntentForQueuedCommand(
  sql: SqlTag,
  c: Context,
  command: { id: string; category: unknown; command_type: unknown },
  inserted: boolean,
  session: {
    tenant_id: string;
    account_id: string | null;
    session_type: WritableSessionType;
    session_id: string;
  },
  metadata: Partial<Omit<Extract<ActivityEventData, { type: "write_intent" }>, "type" | "command_id" | "category" | "command_type">> = {},
): Promise<void> {
  if (!inserted) return;
  await writeActivityEvent(sql, c, {
    tenant_id: session.tenant_id,
    account_id: session.account_id,
    session_type: session.session_type,
    session_id: session.session_id,
    event_type: "write_intent",
    event_data: {
      type: "write_intent",
      command_id: String(command.id),
      category: String(command.category),
      command_type: String(command.command_type),
      ...metadata,
    },
  });
}

/**
 * Convenience helper for named federation routes that opt into `error`
 * activity events per Q3=A. Provides the common shape so callers don't
 * construct `event_data` manually at every site.
 */
export async function emitRouteError(
  sql: SqlTag,
  c: Context,
  input: {
    tenant_id: string;
    account_id?: string | null;
    session_type: WritableSessionType;
    session_id: string;
    route: string;
    status: number;
    event_data?: Omit<Extract<ActivityEventData, { type: "error" }>, "type" | "route" | "status">;
  },
): Promise<void> {
  await writeActivityEvent(sql, c, {
    tenant_id: input.tenant_id,
    account_id: input.account_id ?? null,
    session_type: input.session_type,
    session_id: input.session_id,
    event_type: "error",
    event_data: {
      type: "error",
      route: input.route,
      status: input.status,
      ...(input.event_data ?? {}),
    },
  });
}

/**
 * Rung-12b helper: record a 429 rate-limit rejection as a
 * `federation_activity` error event with the
 * `error_category="rate_limit"` sub-discriminant.
 *
 * Skipped when the 429 fired on an unauthenticated request
 * (no tenant_id resolvable) — the federation_activity table
 * requires a tenant_id, and unauth rejections are surfaced
 * only via the HTTP-level Retry-After header. Callers MUST
 * pass `tenant_id=null` in that case; this helper becomes a
 * no-op.
 */
export async function emitRateLimitHit(
  sql: SqlTag,
  c: Context,
  input: {
    tenant_id: string | null;
    account_id?: string | null;
    session_type: WritableSessionType;
    session_id: string;
    route: string;
  },
): Promise<void> {
  if (!input.tenant_id) return;
  await writeActivityEvent(sql, c, {
    tenant_id: input.tenant_id,
    account_id: input.account_id ?? null,
    session_type: input.session_type,
    session_id: input.session_id,
    event_type: "error",
    event_data: {
      type: "error",
      route: input.route,
      status: 429,
      error_category: "rate_limit",
    },
  });
}
