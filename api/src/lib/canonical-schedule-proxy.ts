/**
 * Canonical schedule proxy (VO-REMOTE-COMMAND-SCHEDULE-EDIT-PR-1).
 *
 * Single loopback helper that both the remote-command dispatch path and
 * any future internal caller can use to create/edit vi_schedules
 * THROUGH the canonical HTTP route (POST / PATCH /vi/schedules/:id).
 *
 * Using an HTTP loopback rather than importing the handler directly
 * preserves the canonical route's full behavior contract:
 *   - RSS URL normalization
 *   - RSS duplicate-feed rejection (409 with existing_schedule_id)
 *   - Feed-title enrichment
 *   - adapter_name validation
 *   - default schedule fallback
 *
 * Auth model: internal-only. Uses the first configured operator token
 * from VERITY_OPERATOR_TOKENS so the worker can act on behalf of the
 * locally-applied remote-command tenant without receiving a browser
 * bearer token. This is DIFFERENT from the dashboard bridge at
 * `/dashboard/routines/:id/edit`, which forwards the caller's own
 * operator bearer — remote-command dispatch has no such token to
 * forward because it runs inside the local worker loop.
 *
 * Do NOT expose this helper to untrusted callers. It is an internal
 * trust boundary: any caller able to reach it is already in the local
 * worker context.
 */

export interface CanonicalScheduleResponse {
  status: number;
  ok: boolean;
  body: any;
}

function internalOperatorToken(): string {
  const raw = process.env.VERITY_OPERATOR_TOKENS || "change-me-in-production";
  const first = raw.split(",")[0]?.trim() || "";
  return first;
}

function internalApiBase(): string {
  const host = process.env.VERITY_API_BIND || "127.0.0.1";
  const port = process.env.VERITY_API_PORT || "3100";
  return `http://${host}:${port}`;
}

/**
 * POST /vi/schedules — canonical create.
 * Caller supplies the full create body (adapter_name + optional
 * schedule_cron / source_input / adapter_config / enabled).
 */
export async function canonicalScheduleCreate(body: Record<string, unknown>): Promise<CanonicalScheduleResponse> {
  const res = await fetch(`${internalApiBase()}/vi/schedules`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalOperatorToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

/**
 * PATCH /vi/schedules/:id — canonical edit.
 * Caller supplies only the fields to change. Omitted fields keep their
 * current values per the canonical route's semantics. The dispatch
 * validator MUST reject payloads with zero editable fields BEFORE
 * calling this helper; a no-op PATCH would otherwise return 200 and
 * create fake successful history.
 */
export async function canonicalScheduleEdit(
  scheduleId: number | string,
  body: Record<string, unknown>,
): Promise<CanonicalScheduleResponse> {
  const res = await fetch(`${internalApiBase()}/vi/schedules/${encodeURIComponent(String(scheduleId))}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${internalOperatorToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}
