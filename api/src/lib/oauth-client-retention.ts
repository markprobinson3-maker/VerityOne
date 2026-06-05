/**
 * OAuth DCR client lifecycle retention.
 *
 * Public Dynamic Client Registration can create durable oauth_clients rows for
 * one-off connector attempts. This sweep ages unused public clients out of the
 * active set WITHOUT deleting them, so the forensic registration record
 * (client_id, redirect_uris, scopes, registered_at) survives for audit and
 * reference. The lifecycle is a status-flip:
 *
 *   active  --(no active grants + unused > OAUTH_CLIENT_DORMANT_AFTER_DAYS)-->  dormant
 *   dormant --(dormant > OAUTH_CLIENT_ARCHIVE_AFTER_DAYS, still no active grants)--> archived
 *
 * dormant/archived clients are invisible to lookupActiveClient (status='active'),
 * so /oauth/authorize and /oauth/token reject them; recovery is a fresh RFC 7591
 * re-registration (new client_id), matching the public-client posture.
 *
 * Both transitions are guarded so a client in the middle of a fresh
 * authorize/token flow (unexpired consent request OR active unexpired grant) is
 * never aged out. Each transition is atomic with its hosted_audit_log row
 * (oauth_client_dormant / oauth_client_archived) via a single UPDATE...RETURNING
 * -> INSERT CTE, and the whole sweep is idempotent: a second pass finds no
 * newly-eligible rows and flips nothing.
 *
 * SuperCron pass5k calls this AFTER grant retention (pass5j) so grants that just
 * expired are visible to the no-active-grant guard. NEVER hard-deletes.
 */

import crypto from "node:crypto";
import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export const OAUTH_CLIENT_DORMANT_AFTER_DAYS = 90;
export const OAUTH_CLIENT_ARCHIVE_AFTER_DAYS = 180;
export const OAUTH_CLIENT_RETENTION_BATCH_SIZE = 500;

export interface OauthClientRetentionResult {
  dormant_clients: number;
  archived_clients: number;
  dormant_after_days: number;
  archive_after_days: number;
  batch_size: number;
  dry_run: boolean;
  disabled: boolean;
}

function emptyResult(dryRun: boolean, disabled: boolean): OauthClientRetentionResult {
  return {
    dormant_clients: 0,
    archived_clients: 0,
    dormant_after_days: OAUTH_CLIENT_DORMANT_AFTER_DAYS,
    archive_after_days: OAUTH_CLIENT_ARCHIVE_AFTER_DAYS,
    batch_size: OAUTH_CLIENT_RETENTION_BATCH_SIZE,
    dry_run: dryRun,
    disabled,
  };
}

/**
 * Status-flip unused/dormant public DCR client registrations through their
 * lifecycle. NEVER deletes rows. Idempotent. Returns aggregate counts only
 * (operator-safe — no client IDs or secrets).
 */
export async function runOauthClientRetention(
  sql: SqlTag,
  options: { dryRun?: boolean } = {},
): Promise<OauthClientRetentionResult> {
  const dryRun = options.dryRun === true;
  if (process.env.VERITY_OAUTH_CLIENT_RETENTION === "off") {
    return emptyResult(false, true);
  }

  if (dryRun) {
    const [row] = await sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM oauth_clients c
          WHERE c.status = 'active'
            AND COALESCE(c.last_used_at, c.registered_at)
                < now() - (${OAUTH_CLIENT_DORMANT_AFTER_DAYS}::int * interval '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM oauth_authorization_requests ar
              WHERE ar.client_id = c.client_id
                AND ar.consumed_at IS NULL
                AND ar.expires_at > now()
            )
            AND NOT EXISTS (
              SELECT 1 FROM oauth_grants g
              WHERE g.client_id = c.client_id
                AND g.status = 'active'
                AND (
                  (g.expires_at IS NOT NULL AND g.expires_at > now())
                  OR (g.refresh_expires_at IS NOT NULL AND g.refresh_expires_at > now())
                  OR (g.refresh_inactivity_at IS NOT NULL AND g.refresh_inactivity_at > now())
                )
            )
        ) AS dormant_clients,
        (
          SELECT COUNT(*)::int
          FROM oauth_clients c
          WHERE c.status = 'dormant'
            AND c.dormant_at IS NOT NULL
            AND c.dormant_at < now() - (${OAUTH_CLIENT_ARCHIVE_AFTER_DAYS}::int * interval '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM oauth_grants g
              WHERE g.client_id = c.client_id
                AND g.status = 'active'
                AND (
                  (g.expires_at IS NOT NULL AND g.expires_at > now())
                  OR (g.refresh_expires_at IS NOT NULL AND g.refresh_expires_at > now())
                  OR (g.refresh_inactivity_at IS NOT NULL AND g.refresh_inactivity_at > now())
                )
            )
        ) AS archived_clients
    `;
    return {
      ...emptyResult(true, false),
      dormant_clients: Number(row?.dormant_clients ?? 0),
      archived_clients: Number(row?.archived_clients ?? 0),
    };
  }

  // Forensic correlation id tying every audit row from this sweep together.
  const cleanupRunId = `oauth-client-retention:${crypto.randomUUID()}`;
  const begin = (sql as unknown as { begin?: (fn: (tx: any) => Promise<OauthClientRetentionResult>) => Promise<OauthClientRetentionResult> }).begin;
  const runPasses = async (tx: any): Promise<OauthClientRetentionResult> => {
    // Bound the transaction's lock + statement budget so a contended retention
    // sweep aborts and retries next cycle rather than holding the two batched
    // UPDATE...RETURNING + audit INSERT passes' locks indefinitely. (SET LOCAL
    // is transaction-scoped; on the non-begin fallback path it is a harmless
    // no-op.)
    await tx`SET LOCAL lock_timeout = '30s'`;
    await tx`SET LOCAL statement_timeout = '60s'`;
    // Pass 1: active -> dormant. UPDATE...RETURNING feeds the audit INSERT in a
    // single statement so the status flip and its audit row commit atomically.
    const [dormantRow] = await tx`
      WITH eligible AS (
        SELECT c.client_id
        FROM oauth_clients c
        WHERE c.status = 'active'
          AND COALESCE(c.last_used_at, c.registered_at)
              < now() - (${OAUTH_CLIENT_DORMANT_AFTER_DAYS}::int * interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM oauth_authorization_requests ar
            WHERE ar.client_id = c.client_id
              AND ar.consumed_at IS NULL
              AND ar.expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM oauth_grants g
            WHERE g.client_id = c.client_id
              AND g.status = 'active'
              AND (
                (g.expires_at IS NOT NULL AND g.expires_at > now())
                OR (g.refresh_expires_at IS NOT NULL AND g.refresh_expires_at > now())
                OR (g.refresh_inactivity_at IS NOT NULL AND g.refresh_inactivity_at > now())
              )
          )
        ORDER BY COALESCE(c.last_used_at, c.registered_at) ASC
        LIMIT ${OAUTH_CLIENT_RETENTION_BATCH_SIZE}
      ),
      flipped AS (
        UPDATE oauth_clients c
        SET status = 'dormant', dormant_at = now()
        WHERE c.client_id IN (SELECT client_id FROM eligible)
        RETURNING c.client_id
      ),
      audited AS (
        INSERT INTO hosted_audit_log (event_type, actor_kind, actor_label, correlation_id, event_data)
        SELECT
          'oauth_client_dormant',
          'oauth_client',
          'oauth_retention:' || f.client_id,
          ${cleanupRunId}::text,
          jsonb_build_object(
            'client_id', f.client_id,
            'reason', 'retention_dormant',
            'threshold_days', ${OAUTH_CLIENT_DORMANT_AFTER_DAYS}::int,
            'affected_grant_count', 0,
            'cleanup_run_id', ${cleanupRunId}::text
          )
        FROM flipped f
        RETURNING 1
      )
      SELECT (SELECT COUNT(*) FROM flipped)::int AS dormant_clients
    `;

    // Pass 2: dormant -> archived. A client just flipped to dormant in pass 1
    // has dormant_at = now() and so is not archive-eligible, so no double flip.
    const [archivedRow] = await tx`
      WITH eligible AS (
        SELECT c.client_id
        FROM oauth_clients c
        WHERE c.status = 'dormant'
          AND c.dormant_at IS NOT NULL
          AND c.dormant_at < now() - (${OAUTH_CLIENT_ARCHIVE_AFTER_DAYS}::int * interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM oauth_grants g
            WHERE g.client_id = c.client_id
              AND g.status = 'active'
              AND (
                (g.expires_at IS NOT NULL AND g.expires_at > now())
                OR (g.refresh_expires_at IS NOT NULL AND g.refresh_expires_at > now())
                OR (g.refresh_inactivity_at IS NOT NULL AND g.refresh_inactivity_at > now())
              )
          )
        ORDER BY c.dormant_at ASC
        LIMIT ${OAUTH_CLIENT_RETENTION_BATCH_SIZE}
      ),
      flipped AS (
        UPDATE oauth_clients c
        SET status = 'archived', archived_at = now()
        WHERE c.client_id IN (SELECT client_id FROM eligible)
        RETURNING c.client_id
      ),
      audited AS (
        INSERT INTO hosted_audit_log (event_type, actor_kind, actor_label, correlation_id, event_data)
        SELECT
          'oauth_client_archived',
          'oauth_client',
          'oauth_retention:' || f.client_id,
          ${cleanupRunId}::text,
          jsonb_build_object(
            'client_id', f.client_id,
            'reason', 'retention_archived',
            'threshold_days', ${OAUTH_CLIENT_ARCHIVE_AFTER_DAYS}::int,
            'affected_grant_count', 0,
            'cleanup_run_id', ${cleanupRunId}::text
          )
        FROM flipped f
        RETURNING 1
      )
      SELECT (SELECT COUNT(*) FROM flipped)::int AS archived_clients
    `;

    return {
      ...emptyResult(false, false),
      dormant_clients: Number(dormantRow?.dormant_clients ?? 0),
      archived_clients: Number(archivedRow?.archived_clients ?? 0),
    };
  };

  if (typeof begin === "function") return begin.call(sql, runPasses);
  return runPasses(sql as any);
}
