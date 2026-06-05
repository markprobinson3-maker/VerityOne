/**
 * Operator-scoped OAuth readiness summary.
 *
 * AGGREGATE COUNTS + readiness flags ONLY — never token hashes, client secrets,
 * auth codes, refresh tokens, raw bearers, or per-client identifiers. Safe to
 * surface on operator-gated surfaces (/ops/runtime, the /admin overview); MUST
 * NOT appear on public descriptors (/connect, /.well-known/*).
 *
 * Lets operators answer at a glance: is the OAuth issuer/resource configured,
 * how many connector clients/grants exist by lifecycle status, when did the
 * connector OAuth-grant retention sweep last run (and did it error), and is
 * audit correlation on.
 *
 * The client/grant counts cover the FULL status space of each table's CHECK
 * constraint so the per-status counts always reconcile to the total population:
 *   oauth_clients : active | dormant | archived | revoked
 *   oauth_grants  : active | consumed | expired | revoked
 */

import type postgres from "postgres";

import {
  hasConfiguredOAuthIssuer,
  resolveOAuthIssuer,
  resolveOAuthResource,
} from "../routes/oauth";
import { selectHostedMaintenanceStatus } from "./hosted-maintenance";

type SqlTag = ReturnType<typeof postgres>;

/** The hosted-maintenance sweep that performs connector OAuth-grant retention. */
const OAUTH_GRANT_RETENTION_SWEEP = "connector_oauth_grants";

export interface OAuthReadinessSummary {
  oauth_issuer_configured: boolean;
  oauth_issuer: string | null;
  oauth_issuer_error: string | null;
  oauth_resource: string;
  oauth_clients_active_count: number;
  oauth_clients_dormant_count: number;
  oauth_clients_archived_count: number;
  oauth_clients_revoked_count: number;
  oauth_grants_active_count: number;
  oauth_grants_consumed_count: number;
  oauth_grants_expired_count: number;
  oauth_grants_revoked_count: number;
  /**
   * Anchored specifically to the connector_oauth_grants retention sweep inside
   * the hosted-maintenance pass — NOT the whole maintenance job. Reports the run
   * time only when that sweep actually ran, and an error only when that sweep is
   * the one that failed (an unrelated sweep failing never shows here). Note: this
   * does NOT cover SuperCron pass5k client dormancy/archival — that runs outside
   * hosted maintenance and is reported via the SuperCron oauth_client_retention
   * pass result, not here.
   */
  last_oauth_retention_at: string | null;
  last_oauth_retention_error: string | null;
  oauth_audit_correlation_enabled: boolean;
}

export async function selectOAuthReadinessSummary(sql: SqlTag): Promise<OAuthReadinessSummary> {
  const [clients] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int   AS active,
      COUNT(*) FILTER (WHERE status = 'dormant')::int  AS dormant,
      COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
      COUNT(*) FILTER (WHERE status = 'revoked')::int  AS revoked
    FROM oauth_clients
  `;
  const [grants] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int   AS active,
      COUNT(*) FILTER (WHERE status = 'consumed')::int AS consumed,
      COUNT(*) FILTER (WHERE status = 'expired')::int  AS expired,
      COUNT(*) FILTER (WHERE status = 'revoked')::int  AS revoked
    FROM oauth_grants
  `;

  // OAuth grant retention runs as the connector_oauth_grants sweep inside the
  // hosted maintenance pass. Anchor the operator-facing retention signal to that
  // sweep specifically — never to the whole job — so an unrelated sweep failing
  // does not masquerade as an OAuth-retention error, and a fresh timestamp is
  // only reported when the grant sweep actually ran. Best-effort: a
  // missing/garbled status row must not fail the whole operator payload.
  let lastRetentionAt: string | null = null;
  let lastRetentionError: string | null = null;
  try {
    const maint = await selectHostedMaintenanceStatus(sql);
    const lastRun = maint.last_run as
      | { sweeps?: Array<{ sweep?: string }>; error_in_sweep?: string | null }
      | null
      | undefined;
    const grantSweepCompleted =
      Array.isArray(lastRun?.sweeps) &&
      lastRun!.sweeps.some((s) => s?.sweep === OAUTH_GRANT_RETENTION_SWEEP);
    const grantSweepErrored = lastRun?.error_in_sweep === OAUTH_GRANT_RETENTION_SWEEP;
    lastRetentionAt =
      grantSweepCompleted || grantSweepErrored ? ((maint.last_run_at as string | null) ?? null) : null;
    lastRetentionError = grantSweepErrored ? ((maint.last_error_kind as string | null) ?? null) : null;
  } catch {
    /* maintenance status is best-effort for the readiness summary */
  }

  // resolveOAuthIssuer throws on a misconfigured env (install_misconfigured);
  // report that as an error string rather than failing the operator payload.
  let issuer: string | null = null;
  let issuerError: string | null = null;
  try {
    issuer = resolveOAuthIssuer();
  } catch (err) {
    issuerError = err instanceof Error ? err.message : String(err);
  }

  return {
    oauth_issuer_configured: hasConfiguredOAuthIssuer(),
    oauth_issuer: issuer,
    oauth_issuer_error: issuerError,
    oauth_resource: resolveOAuthResource(),
    oauth_clients_active_count: Number(clients?.active ?? 0),
    oauth_clients_dormant_count: Number(clients?.dormant ?? 0),
    oauth_clients_archived_count: Number(clients?.archived ?? 0),
    oauth_clients_revoked_count: Number(clients?.revoked ?? 0),
    oauth_grants_active_count: Number(grants?.active ?? 0),
    oauth_grants_consumed_count: Number(grants?.consumed ?? 0),
    oauth_grants_expired_count: Number(grants?.expired ?? 0),
    oauth_grants_revoked_count: Number(grants?.revoked ?? 0),
    last_oauth_retention_at: lastRetentionAt,
    last_oauth_retention_error: lastRetentionError,
    // correlation_id is unconditionally threaded through insertAudit, the
    // single owner of hosted_audit_log writes in oauth.ts.
    oauth_audit_correlation_enabled: true,
  };
}
