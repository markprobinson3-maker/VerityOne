/**
 * Hosted portal session resolvers.
 *
 * Two resolvers, one cookie/hash flow:
 *
 *   - requirePortalAccountSession(c) — unlinked-ok. Returns the wide
 *     HostedAccountSessionView used by /portal/account/status and the
 *     /my/account parity helper. Selects best-current-or-historical
 *     link, account UI preferences, effective entitlement, and the
 *     `pending_link_count` aggregate.
 *
 *   - requireLinkedPortalSession(c) — linked-only. Returns the narrow
 *     HostedLinkedPortalSessionView { session_id, account_id, tenant_id }
 *     consumed by every existing /portal/* route and the /remote/cancel
 *     handler. The narrow shape preserves backward compatibility with
 *     handlers that only read those three fields.
 *
 * Both resolvers share the same session cookie + hash + revocation
 * checks. Neither accepts link codes, sync tokens, or hosted agent
 * credentials.
 */
import crypto from "node:crypto";
import { sql as defaultSql } from "../db";
import {
  readAccountUiPreferences,
  type AccountUiPreferences,
} from "./account-ui-preferences";
import {
  resolveEffectiveEntitlement,
  type EffectiveEntitlement,
  type EntitlementSource,
} from "./subscription-entitlements";

type SqlTag = any;

const SESSION_COOKIE = "vo_session";

export interface HostedLinkedPortalSessionView {
  session_id: string;
  account_id: string;
  tenant_id: string;
}

export type AccountTenantLinkStatus = "active" | "pending_confirmation" | "unlinked";

export interface HostedAccountSessionView {
  session_id: string;
  account_id: string;
  /**
   * Active tenant id only. Null whenever there is no `active`
   * `account_tenant_links` row, including never-linked, pending, and
   * post-unlink states.
   */
  tenant_id: string | null;
  /**
   * Display tenant id from the best current/historical link row.
   * Populated for pending_confirmation and unlinked states so the
   * identity card has something to display without granting active-
   * tenant authority.
   */
  link_tenant_id: string | null;
  link_status: AccountTenantLinkStatus | null;
  /**
   * Count of `pending_confirmation` link rows for this account across
   * all tenants. Allows the UI to render "multiple pending links"
   * without re-querying.
   */
  pending_link_count: number;
  linked_by_node_id: string | null;
  tenant_slug: string | null;
  email: string;
  display_name: string | null;
  capability_source: EntitlementSource;
  capability_label: string | null;
  vo_plus_active: boolean;
  entitlement: EffectiveEntitlement;
  account_preferences: AccountUiPreferences;
}

interface CoreSessionRow {
  session_id: string;
  account_id: string;
  email: string;
  display_name: string | null;
}

function getSessionToken(c: any): string | null {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function resolveCoreSession(c: any, sql: SqlTag): Promise<CoreSessionRow | null> {
  const token = getSessionToken(c);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const [row] = await sql`
    SELECT s.session_id, s.account_id, a.email, a.display_name
    FROM account_sessions s
    JOIN accounts a ON a.account_id = s.account_id
    WHERE s.token_hash = ${tokenHash}
      AND s.revoked = false
      AND s.expires_at > now()
      AND a.status = 'active'
  `;
  if (!row) return null;
  return {
    session_id: String(row.session_id),
    account_id: String(row.account_id),
    email: String(row.email),
    display_name: row.display_name == null ? null : String(row.display_name),
  };
}

interface BestLinkRow {
  tenant_id: string;
  tenant_slug: string | null;
  status: AccountTenantLinkStatus;
  linked_by_node_id: string | null;
}

async function selectBestLinkForAccount(
  sql: SqlTag,
  accountId: string,
): Promise<BestLinkRow | null> {
  // Precedence: active → pending_confirmation → unlinked.
  // For pending and unlinked we pick the most recent by linked_at then id
  // to keep rendering deterministic when an account has multiple rows.
  try {
    const [row] = await sql`
      SELECT atl.tenant_id, hti.tenant_slug, atl.status, atl.linked_by_node_id
      FROM account_tenant_links atl
      LEFT JOIN hosted_tenant_identities hti ON hti.tenant_id = atl.tenant_id
      WHERE atl.account_id = ${accountId}::uuid
      ORDER BY
        CASE atl.status
          WHEN 'active' THEN 0
          WHEN 'pending_confirmation' THEN 1
          WHEN 'unlinked' THEN 2
          ELSE 3
        END ASC,
        atl.linked_at DESC,
        atl.id DESC
      LIMIT 1
    `;
    if (!row) return null;
    return normalizeLinkRow(row);
  } catch (e) {
    if ((e as { code?: string })?.code !== "42P01") throw e;
    const [row] = await sql`
      SELECT atl.tenant_id, atl.tenant_id AS tenant_slug, atl.status, atl.linked_by_node_id
      FROM account_tenant_links atl
      WHERE atl.account_id = ${accountId}::uuid
      ORDER BY
        CASE atl.status
          WHEN 'active' THEN 0
          WHEN 'pending_confirmation' THEN 1
          WHEN 'unlinked' THEN 2
          ELSE 3
        END ASC,
        atl.linked_at DESC,
        atl.id DESC
      LIMIT 1
    `;
    if (!row) return null;
    return normalizeLinkRow(row);
  }
}

function normalizeLinkRow(row: any): BestLinkRow | null {
  const status = row.status === "active" || row.status === "pending_confirmation" || row.status === "unlinked"
    ? row.status
    : null;
  if (!status) return null;
  return {
    tenant_id: String(row.tenant_id),
    tenant_slug: row.tenant_slug == null ? null : String(row.tenant_slug),
    status,
    linked_by_node_id: row.linked_by_node_id == null ? null : String(row.linked_by_node_id),
  };
}

async function countPendingLinks(sql: SqlTag, accountId: string): Promise<number> {
  try {
    const [row] = await sql`
      SELECT COUNT(*)::int AS pending
      FROM account_tenant_links
      WHERE account_id = ${accountId}::uuid
        AND status = 'pending_confirmation'
    `;
    return Number(row?.pending) || 0;
  } catch (e) {
    if ((e as { code?: string })?.code === "42P01") return 0;
    throw e;
  }
}

/**
 * Wide resolver — does not require an active tenant link.
 *
 * Returns null only for missing/expired/revoked sessions. Linked state
 * is encoded in `tenant_id` (active only) plus `link_tenant_id` /
 * `link_status` (best historical or current row).
 */
export async function requirePortalAccountSession(
  c: any,
  sql: SqlTag = defaultSql,
): Promise<HostedAccountSessionView | null> {
  const core = await resolveCoreSession(c, sql);
  if (!core) return null;

  const [link, pendingLinkCount] = await Promise.all([
    selectBestLinkForAccount(sql, core.account_id),
    countPendingLinks(sql, core.account_id),
  ]);

  const activeTenantId = link?.status === "active" ? link.tenant_id : null;

  const [entitlement, account_preferences] = await Promise.all([
    resolveEffectiveEntitlement(sql, {
      accountId: core.account_id,
      tenantId: activeTenantId,
    }),
    readAccountUiPreferences(sql, core.account_id),
  ]);

  return {
    session_id: core.session_id,
    account_id: core.account_id,
    tenant_id: activeTenantId,
    link_tenant_id: link?.tenant_id ?? null,
    link_status: link?.status ?? null,
    pending_link_count: pendingLinkCount,
    linked_by_node_id: link?.linked_by_node_id ?? null,
    tenant_slug: link?.tenant_slug ?? link?.tenant_id ?? null,
    email: core.email,
    display_name: core.display_name,
    capability_source: entitlement.source,
    capability_label: entitlement.label ?? null,
    vo_plus_active: entitlement.vo_plus_active,
    entitlement,
    account_preferences,
  };
}

/**
 * Narrow resolver — requires an active tenant link.
 *
 * Returns the legacy three-field shape consumed by all existing
 * /portal/* routes and /remote/cancel. Pays no `readAccountUiPreferences`
 * read; routes that need wide identity must use
 * `requirePortalAccountSession` instead.
 */
// R9_LINKED_PORTAL_SESSION_RESOLVER_START
export async function requireLinkedPortalSession(
  c: any,
  sql: SqlTag = defaultSql,
): Promise<HostedLinkedPortalSessionView | null> {
  const core = await resolveCoreSession(c, sql);
  if (!core) return null;

  const [link] = await sql`
    SELECT tenant_id
    FROM account_tenant_links
    WHERE account_id = ${core.account_id}::uuid
      AND status = 'active'
    LIMIT 1
  `;
  if (!link) return null;
  return {
    session_id: core.session_id,
    account_id: core.account_id,
    tenant_id: String(link.tenant_id),
  };
}
// R9_LINKED_PORTAL_SESSION_RESOLVER_END
