/**
 * `GET /audit/export?tenant_id=X&from=Y&to=Z` —
 * VO-FEDERATION-AUDIT-EXPORT-PR-1 (rung 12c).
 *
 * Streams `hosted_audit_log` rows for the requested tenant as
 * newline-delimited JSON (`application/x-ndjson`). Supports two
 * auth flows resolved by `resolveExportScope`:
 *
 *   - **Operator** (`Authorization: Bearer <operator-token>` +
 *     mandatory `?tenant_id=<id>` query param) — cross-tenant
 *     incident response. One tenant per call; never broadcasts.
 *   - **Tenant self-serve** (hosted session cookie `vo_session`) —
 *     scoped to the caller's own active tenant link. A
 *     `?tenant_id=...` query that disagrees with the session's
 *     active tenant hard-rejects (403).
 *
 * Query bounds (`from`, `to`) are optional ISO-8601 timestamps.
 * The handler validates them cheaply; anything unparseable is a
 * 400. Missing bounds pull the full history for the tenant.
 *
 * Streaming shape: every output line is a well-formed JSON
 * object; final line has a trailing `\n` so downstream
 * SIEM-style tools don't need a terminator heuristic. Rows are
 * emitted in `created_at ASC` order so an incremental export
 * cursor can be resumed by the caller using the last row's
 * `ts`.
 */

import { Hono } from "hono";
import crypto from "node:crypto";
import { errorJson, ApiError } from "../lib/error-envelope";

import { sql } from "../db";
import { getAccessContext } from "../lib/access";
import {
  resolveExportScope,
  tenantFilterFor,
  type ExportAuth,
  type ExportScope,
} from "../lib/audit-export-scope";
import { redactActivityEventMetadata } from "../lib/federation-activity-health";

const auditExport = new Hono();

const SESSION_COOKIE_NAME = "vo_session";
const MAX_ROWS_PER_EXPORT = 100_000;

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getSessionCookie(c: any): string | null {
  const raw = c.req.header("Cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/** Resolve the caller's export auth. Operator token first
 *  (shorter check), hosted session second. No fallback to
 *  `unauthenticated` when a session hash is present but the
 *  row is revoked — that's a deliberate unauthenticated. */
async function resolveExportAuth(c: any): Promise<ExportAuth> {
  // Path 1: operator token (beta/operator scope resolved by
  // attachAccessContext middleware).
  const access = getAccessContext(c);
  if (access.scope === "operator") {
    return { kind: "operator" };
  }

  // Path 2: hosted session cookie.
  const cookie = getSessionCookie(c);
  if (cookie) {
    const tokenHash = hashToken(cookie);
    const [session] = await sql`
      SELECT a.account_id
      FROM account_sessions s
      JOIN accounts a ON a.account_id = s.account_id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked = false
        AND s.expires_at > now()
        AND a.status = 'active'
    `;
    if (session) {
      const [link] = await sql`
        SELECT tenant_id FROM account_tenant_links
        WHERE account_id = ${session.account_id} AND status = 'active'
      `;
      if (link) {
        return { kind: "tenant_session", tenant_id: link.tenant_id };
      }
      return { kind: "tenant_session_unlinked" };
    }
  }

  return { kind: "unauthenticated" };
}

/** Parse a query-string timestamp. Returns a Date or null on
 *  invalid. Used for from/to bounds. */
function parseTimestampParam(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// F9: optional sources unioned into the export when `?include=` is set.
// Each source has its own timestamp column, redaction shape, and event
// classification — the export normalizes them into a single NDJSON
// stream with a top-level `_source` discriminator. To avoid accidental
// million-row exports, any include= request MUST provide both `from`
// and `to` time-window bounds.
const INCLUDE_SOURCES = new Set<"memory_events" | "federation_activity" | "federation_overlay_log">([
  "memory_events",
  "federation_activity",
  "federation_overlay_log",
]);

function parseIncludeParam(raw: string | null | undefined): Set<string> {
  if (typeof raw !== "string") return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (INCLUDE_SOURCES.has(part as any)) out.add(part);
  }
  return out;
}

auditExport.get("/export", async (c) => {
  const auth = await resolveExportAuth(c);
  const queryTenant = c.req.query("tenant_id") ?? null;
  const scopeResult = resolveExportScope(auth, queryTenant);
  if (!scopeResult.ok) {
    const code =
      scopeResult.status === 401 ? "unauthorized" :
      scopeResult.status === 403 ? "forbidden" :
      scopeResult.status === 404 ? "tenant_not_found" :
      scopeResult.status === 500 ? "internal_error" :
      "invalid_request";
    return errorJson(c, code, {
      message: scopeResult.status === 500 ? "Audit export scope resolution failed" : scopeResult.error,
    });
  }

  const rawFrom = c.req.query("from") ?? null;
  const rawTo = c.req.query("to") ?? null;
  const fromDate = parseTimestampParam(rawFrom);
  const toDate = parseTimestampParam(rawTo);
  if (rawFrom && !fromDate) {
    return errorJson(c, "invalid_request", { message: "`from` must be an ISO-8601 timestamp." });
  }
  if (rawTo && !toDate) {
    return errorJson(c, "invalid_request", { message: "`to` must be an ISO-8601 timestamp." });
  }

  // F9: parse and validate ?include= sources.
  const includeSources = parseIncludeParam(c.req.query("include"));
  if (includeSources.size > 0 && (!fromDate || !toDate)) {
    return errorJson(c, "invalid_request", {
      message: "`include=` requires both `from` and `to` to bound the export window.",
      hint: "Narrow the time window to avoid scanning unbounded rows.",
    });
  }

  const tenantFilter = tenantFilterFor(scopeResult.scope);

  // Build the streaming response. postgres.js supports
  // async-iterator cursors via `.cursor(batchSize)`; we read
  // rows in batches of 500 and push NDJSON lines. Back-pressure
  // is naturally respected because the cursor awaits the next
  // batch only after the previous one is fully written.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let emitted = 0;
      const writeLine = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        emitted += 1;
      };
      try {
        // ── 1. hosted_audit_log (canonical default, always emitted) ──
        const halRows = sql`
          SELECT
            id,
            event_type,
            actor_kind,
            actor_label,
            account_id,
            tenant_id,
            node_id,
            link_id,
            event_data,
            correlation_id,
            created_at
          FROM hosted_audit_log
          WHERE tenant_id = ${tenantFilter}
            ${fromDate ? sql`AND created_at >= ${fromDate.toISOString()}` : sql``}
            ${toDate ? sql`AND created_at <= ${toDate.toISOString()}` : sql``}
          ORDER BY created_at ASC, id ASC
          LIMIT ${MAX_ROWS_PER_EXPORT}
        `.cursor(500);

        for await (const batch of halRows) {
          for (const row of batch) {
            const redacted = redactActivityEventMetadata(
              (row.event_data || {}) as Record<string, unknown>,
            );
            writeLine({
              ts: (row.created_at as Date).toISOString(),
              id: row.id,
              tenant_id: row.tenant_id,
              account_id: row.account_id,
              event_type: row.event_type,
              actor_kind: row.actor_kind,
              actor_label: row.actor_label,
              node_id: row.node_id,
              link_id: row.link_id,
              correlation_id: (row as any).correlation_id ?? null,
              evidence_source: "hosted_audit_log",
              _source: "hosted_audit_log",
              metadata: redacted,
            });
            if (emitted >= MAX_ROWS_PER_EXPORT) break;
          }
          if (emitted >= MAX_ROWS_PER_EXPORT) break;
        }

        // ── 2. memory_events (optional) ──
        if (includeSources.has("memory_events") && fromDate && toDate && emitted < MAX_ROWS_PER_EXPORT) {
          const meRows = sql`
            SELECT id, addr, tenant_id, event_type, event_data, actor, correlation_id, created_at
            FROM memory_events
            WHERE tenant_id = ${tenantFilter}
              AND created_at >= ${fromDate.toISOString()}
              AND created_at <= ${toDate.toISOString()}
            ORDER BY created_at ASC, id ASC
            LIMIT ${MAX_ROWS_PER_EXPORT}
          `.cursor(500);
          for await (const batch of meRows) {
            for (const row of batch) {
              writeLine({
                ts: (row.created_at as Date).toISOString(),
                id: row.id,
                tenant_id: row.tenant_id,
                event_type: row.event_type,
                actor_label: (row as any).actor ?? null,
                addr: row.addr,
                correlation_id: (row as any).correlation_id ?? null,
                evidence_source: "memory_events",
                _source: "memory_events",
                metadata: redactActivityEventMetadata((row.event_data || {}) as Record<string, unknown>),
              });
              if (emitted >= MAX_ROWS_PER_EXPORT) break;
            }
            if (emitted >= MAX_ROWS_PER_EXPORT) break;
          }
        }

        // ── 3. federation_activity (optional) ──
        if (includeSources.has("federation_activity") && fromDate && toDate && emitted < MAX_ROWS_PER_EXPORT) {
          const faRows = sql`
            SELECT id, ts, tenant_id, account_id, session_type, session_id, event_type, outcome, event_data, correlation_id
            FROM federation_activity
            WHERE tenant_id = ${tenantFilter}
              AND ts >= ${fromDate.toISOString()}
              AND ts <= ${toDate.toISOString()}
            ORDER BY ts ASC, id ASC
            LIMIT ${MAX_ROWS_PER_EXPORT}
          `.cursor(500);
          for await (const batch of faRows) {
            for (const row of batch) {
              writeLine({
                ts: (row.ts as Date).toISOString(),
                id: row.id,
                tenant_id: row.tenant_id,
                account_id: row.account_id,
                event_type: row.event_type,
                outcome: (row as any).outcome ?? null,
                session_type: (row as any).session_type ?? null,
                session_id: (row as any).session_id ?? null,
                correlation_id: (row as any).correlation_id ?? null,
                evidence_source: "federation_activity",
                _source: "federation_activity",
                metadata: redactActivityEventMetadata((row.event_data || {}) as Record<string, unknown>),
              });
              if (emitted >= MAX_ROWS_PER_EXPORT) break;
            }
            if (emitted >= MAX_ROWS_PER_EXPORT) break;
          }
        }

        // ── 4. federation_overlay_log (optional) ──
        if (includeSources.has("federation_overlay_log") && fromDate && toDate && emitted < MAX_ROWS_PER_EXPORT) {
          const folRows = sql`
            SELECT id, tenant_id, node_id, overlay_id, overlay_addr, correlation_id, synced_at
            FROM federation_overlay_log
            WHERE tenant_id = ${tenantFilter}
              AND synced_at >= ${fromDate.toISOString()}
              AND synced_at <= ${toDate.toISOString()}
            ORDER BY synced_at ASC, id ASC
            LIMIT ${MAX_ROWS_PER_EXPORT}
          `.cursor(500);
          for await (const batch of folRows) {
            for (const row of batch) {
              writeLine({
                ts: (row.synced_at as Date).toISOString(),
                id: row.id,
                tenant_id: row.tenant_id,
                node_id: row.node_id,
                event_type: "overlay_synced",
                correlation_id: (row as any).correlation_id ?? null,
                evidence_source: "federation_overlay_log",
                _source: "federation_overlay_log",
                // Route through the same scrubber as every other source so
                // redaction is uniform — overlay_addr/overlay_id could carry a
                // secret-shaped or local-path string and must not bypass it.
                metadata: redactActivityEventMetadata({
                  overlay_id: row.overlay_id,
                  overlay_addr: (row as any).overlay_addr ?? null,
                }),
              });
              if (emitted >= MAX_ROWS_PER_EXPORT) break;
            }
            if (emitted >= MAX_ROWS_PER_EXPORT) break;
          }
        }
      } catch (err) {
        // Stream error: emit one error line so the client sees
        // the failure, then close. Never leak the SQL error text.
        const errLine = JSON.stringify({
          _error: "export_failed",
          _hint: "Partial export; retry with a narrower time window.",
        });
        try {
          controller.enqueue(encoder.encode(errLine + "\n"));
        } catch {
          // Controller may already be closed.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Controller may already be closed or errored by the client.
        }
      }
    },
  });

  // Response headers document the export shape. `X-VO-Export-
  // Mode` + `X-VO-Export-Tenant` let a CLI consumer confirm the
  // resolved scope without re-parsing the response body.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-VO-Export-Mode": scopeResult.scope.mode,
      "X-VO-Export-Tenant": tenantFilter,
    },
  });
});

export default auditExport;
