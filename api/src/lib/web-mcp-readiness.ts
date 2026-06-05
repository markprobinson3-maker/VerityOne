/**
 * Operator-scoped Web MCP connector readiness summary.
 *
 * AGGREGATE COUNTS + readiness flags ONLY — never bearer tokens, token/refresh
 * hashes, sync tokens, command payloads, event_data, grant/agent identifiers, or
 * project/memory IDs. Safe on operator-gated surfaces (/ops/runtime); MUST NOT
 * appear on public descriptors (/connect, /.well-known/*).
 *
 * Mirror of the oauth-readiness.ts pattern. Every DB read is wrapped so a missing
 * table (fresh install) or transient error degrades that slice to 0/null rather
 * than failing the whole operator payload, and the independent reads run under a
 * single Promise.all so adding this block does not regress /ops/runtime latency.
 */

import type postgres from "postgres";

import { SYNC_HEALTH_STALE_THRESHOLD_SECONDS } from "./federation-sync-health";
import { HOSTED_MCP_POLICY_MATRIX, matrixRoutePaths } from "./hosted-mcp-policy-matrix";
import { MCP_CONNECTOR_TOOL_CATALOG } from "./mcp-tool-registry";
import { isWebMcpConnectorEnabled } from "./web-mcp-connector-profile";

type SqlTag = ReturnType<typeof postgres>;

export interface WebMcpReadinessSummary {
  /**
   * The LOCAL process connector gate (isWebMcpConnectorEnabled). In the
   * long-lived /ops process this is false off-serverless by default; it is NOT
   * the deployed serverless surface state — see web_mcp_bundle_current for that.
   */
  web_mcp_enabled: boolean;
  mcp_route_mounted: boolean;
  hosted_mcp_route_count: number;
  advertised_tool_count: number;
  policy_matrix_tool_count: number;
  active_connector_grant_count: number;
  revoked_connector_grant_count: number;
  connector_activity_24h_count: number;
  connector_error_24h_count: number;
  stale_mirror_count: number;
  queued_write_intent_count: number;
  failed_write_intent_count: number;
  last_connector_activity_at: string | null;
  last_write_intent_at: string | null;
  last_mirror_sync_at: string | null;
  /**
   * Whether the checked-in serverless bundle matches source. No runtime
   * mechanism exists to determine this from a DB, so it is always null
   * ("unknown") here — bundle/source parity is enforced by the build-time drift
   * guard, not surfaced at runtime. Reserved so the field is stable if a
   * deployed-bundle version signal is ever added.
   */
  web_mcp_bundle_current: boolean | null;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Normalize a postgres timestamp (Date or string) to ISO 8601, or null.
 *  Exported for direct unit testing — a non-date value (the only way a stray
 *  string could reach a timestamp field) sanitizes to null, never surfaces. */
export function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function selectWebMcpReadinessSummary(sql: SqlTag): Promise<WebMcpReadinessSummary> {
  const enabled = isWebMcpConnectorEnabled();

  const [grants, activity, commands, mirrors] = await Promise.all([
    // Connector grants ARE oauth_grants (the MCP connector is the only OAuth
    // client). Aggregate status counts only — no token/hash columns selected.
    safe(async () => {
      const [r] = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int  AS active,
          COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked
        FROM oauth_grants
      `;
      return { active: Number(r?.active ?? 0), revoked: Number(r?.revoked ?? 0) };
    }, { active: 0, revoked: 0 }),
    // Node-wide connector activity over the rung-11b session_type. Counts +
    // last-timestamp only; event_data (which can carry detail) is never selected.
    safe(async () => {
      const [r] = await sql`
        SELECT
          COUNT(*) FILTER (
            WHERE session_type = 'hosted-mcp-connector' AND ts > now() - interval '24 hours'
          )::int AS total_24h,
          COUNT(*) FILTER (
            WHERE session_type = 'hosted-mcp-connector' AND event_type = 'error'
              AND ts > now() - interval '24 hours'
          )::int AS errors_24h,
          MAX(ts) FILTER (WHERE session_type = 'hosted-mcp-connector') AS last_at
        FROM federation_activity
      `;
      return {
        total: Number(r?.total_24h ?? 0),
        errors: Number(r?.errors_24h ?? 0),
        last_at: toIso(r?.last_at),
      };
    }, { total: 0, errors: 0, last_at: null }),
    // Write-intent queue health. Status counts + last-queued timestamp only;
    // payload/idempotency columns are never selected.
    safe(async () => {
      const [r] = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          MAX(created_at) AS last_at
        FROM remote_commands
      `;
      return {
        queued: Number(r?.queued ?? 0),
        failed: Number(r?.failed ?? 0),
        last_at: toIso(r?.last_at),
      };
    }, { queued: 0, failed: 0, last_at: null }),
    // Mirror freshness across active hosted nodes (node-wide operator view).
    safe(async () => {
      const [r] = await sql`
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'active'
              AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(secs => ${SYNC_HEALTH_STALE_THRESHOLD_SECONDS}))
          )::int AS stale,
          MAX(last_sync_at) FILTER (WHERE status = 'active') AS last_at
        FROM hosted_nodes
      `;
      return { stale: Number(r?.stale ?? 0), last_at: toIso(r?.last_at) };
    }, { stale: 0, last_at: null }),
  ]);

  return {
    web_mcp_enabled: enabled,
    mcp_route_mounted: enabled,
    // Static surface shape — array lengths, no DB.
    hosted_mcp_route_count: matrixRoutePaths().length,
    advertised_tool_count: MCP_CONNECTOR_TOOL_CATALOG.length,
    policy_matrix_tool_count: HOSTED_MCP_POLICY_MATRIX.length,
    active_connector_grant_count: grants.active,
    revoked_connector_grant_count: grants.revoked,
    connector_activity_24h_count: activity.total,
    connector_error_24h_count: activity.errors,
    stale_mirror_count: mirrors.stale,
    queued_write_intent_count: commands.queued,
    failed_write_intent_count: commands.failed,
    last_connector_activity_at: activity.last_at,
    last_write_intent_at: commands.last_at,
    last_mirror_sync_at: mirrors.last_at,
    web_mcp_bundle_current: null,
  };
}
