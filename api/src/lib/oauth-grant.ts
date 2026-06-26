/**
 * OAuth grant lifecycle — VO-WEB-AGENT-CONNECTOR-OAUTH-PR-1
 * (rung 11a).
 *
 * Auth codes (`voca_*`) → access (`voc_*`) + refresh (`vocr_*`)
 * tokens, all hash-stored in `oauth_grants`. Per the rung-10
 * design (Q3=A locked):
 *
 *   - Public-client posture; no `vocs_*` client secrets.
 *   - Authorization codes are stateful + single-use (PKCE,
 *     redirect_uri, client_id, resource bound).
 *   - Refresh is stable-token and concurrency-tolerant: the
 *     refresh token itself is not rotated on every use. The
 *     active grant row is updated in place with a fresh access
 *     token and extended inactivity deadline.
 *   - Presenting a consumed historical refresh token fails
 *     with invalid_grant, but does not revoke the active grant
 *     family. Some desktop MCP clients launch/retry sessions in
 *     parallel; treating a stale refresh as hostile replay
 *     causes avoidable connector lockouts.
 *   - Refresh preserves the family's absolute
 *     `refresh_expires_at` and clamps inactivity extension to
 *     `LEAST(now() + 14d, root.refresh_expires_at)`.
 *   - Cascade-revoke helper accepts a credential id (single
 *     revoke) OR a credential id array (batch unlink) so both
 *     account.ts revoke sites use the same code path.
 *   - All TTLs are named constants exported from this module.
 */

import crypto from "node:crypto";
import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;
export type SqlOrTx = SqlTag | {
  json: (value: unknown) => unknown;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
};

// ── Named TTL constants (drift guard #19 pins each value) ────

export const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;        // 24 hours
export const REFRESH_TOKEN_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
export const REFRESH_TOKEN_INACTIVITY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;                 // 5 minutes
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;    // 10 minutes (consent UI window)

// ── Token format prefixes + minters ─────────────────────────

const ACCESS_PREFIX = "voc_";
const REFRESH_PREFIX = "vocr_";
const AUTH_CODE_PREFIX = "voca_";
const NONCE_PREFIX = "vocn_"; // consent nonce; not in scanner patterns (short-lived, hashed)

const ACCESS_BODY_BYTES = 32;
const REFRESH_BODY_BYTES = 32;
const AUTH_CODE_BODY_BYTES = 32;
const NONCE_BODY_BYTES = 24;

export function mintAccessToken(): string {
  return `${ACCESS_PREFIX}${crypto.randomBytes(ACCESS_BODY_BYTES).toString("base64url")}`;
}

export function mintRefreshToken(): string {
  return `${REFRESH_PREFIX}${crypto.randomBytes(REFRESH_BODY_BYTES).toString("base64url")}`;
}

export function mintAuthCode(): string {
  return `${AUTH_CODE_PREFIX}${crypto.randomBytes(AUTH_CODE_BODY_BYTES).toString("base64url")}`;
}

export function mintConsentNonce(): string {
  return `${NONCE_PREFIX}${crypto.randomBytes(NONCE_BODY_BYTES).toString("base64url")}`;
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ── Format invariants (exposed for pure-unit tests) ─────────

export function isAccessTokenShape(s: string): boolean {
  return /^voc_[A-Za-z0-9_-]{40,}$/.test(s);
}
export function isRefreshTokenShape(s: string): boolean {
  return /^vocr_[A-Za-z0-9_-]{40,}$/.test(s);
}
export function isAuthCodeShape(s: string): boolean {
  return /^voca_[A-Za-z0-9_-]{40,}$/.test(s);
}

// ── PKCE verification (S256) ────────────────────────────────

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  // Timing-safe compare — challenge is base64url-encoded SHA-256 (43 chars).
  if (computed.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

// ── Refresh inactivity expiry math ──────────────────────────

/**
 * Compute the row's `refresh_inactivity_at` after a refresh.
 * Inactivity extends by 14d but is clamped to the
 * family's absolute `refresh_expires_at` so activity can never
 * extend the 30-day absolute TTL.
 *
 * Returns a Date object representing the LEAST of (now + 14d,
 * absolute_expiry).
 */
export function computeRotatedInactivityAt(
  absoluteExpiresAt: Date,
  nowMs: number = Date.now(),
): Date {
  const proposed = nowMs + REFRESH_TOKEN_INACTIVITY_TTL_MS;
  const cap = absoluteExpiresAt.getTime();
  return new Date(Math.min(proposed, cap));
}

// ── Row shapes ──────────────────────────────────────────────

export type GrantStatus = "active" | "consumed" | "revoked" | "expired";

export type RevokedReason =
  | "oauth_revoke"
  | "refresh_replay"
  | "credential_revoke"
  | "admin"
  | "tenant_self"
  | "retention_expired";

export interface OauthGrantRow {
  id: string;
  client_id: string;
  access_token_hash: string | null;
  refresh_token_hash: string | null;
  auth_code_hash: string | null;
  account_id: string;
  tenant_id: string;
  agent_id: string;
  hosted_agent_credential_id: string;
  scopes: string[];
  audience: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  redirect_uri: string | null;
  state: string | null;
  expires_at: Date | null;
  refresh_expires_at: Date | null;
  refresh_inactivity_at: Date | null;
  status: GrantStatus;
  revoked_reason: RevokedReason | null;
  issued_at: Date;
  last_used_at: Date | null;
  consumed_at: Date | null;
  grant_family_id: string;
  parent_grant_id: string | null;
  revoked_at: Date | null;
}

// ── Authorization request (consent handoff) ─────────────────

export interface AuthorizationRequestInput {
  client_id: string;
  account_id: string;
  tenant_id: string;
  redirect_uri: string;
  audience: string;
  scopes: readonly string[];
  state: string | null;
  code_challenge: string;
  code_challenge_method: "S256";
}

export interface AuthorizationRequestRow {
  id: string;
  nonce: string; // raw — returned ONCE to embed in the consent form
  expires_at: Date;
}

/**
 * Create a durable authorization-request row + return the raw
 * consent nonce so the consent UI can embed it. The nonce is
 * stored as a SHA-256 hash; the raw value is shown ONCE (in
 * the consent form's hidden field) and never persisted in
 * plaintext.
 */
export async function createAuthorizationRequest(
  sql: SqlTag,
  input: AuthorizationRequestInput,
): Promise<AuthorizationRequestRow> {
  const nonce = mintConsentNonce();
  const nonce_hash = hashToken(nonce);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS);
  const [row] = await sql`
    INSERT INTO oauth_authorization_requests (
      nonce_hash, client_id, account_id, tenant_id,
      redirect_uri, audience, scopes, state,
      code_challenge, code_challenge_method, expires_at
    )
    VALUES (
      ${nonce_hash}, ${input.client_id}, ${input.account_id}::uuid, ${input.tenant_id},
      ${input.redirect_uri}, ${input.audience}, ${input.scopes as unknown as string[]}, ${input.state},
      ${input.code_challenge}, ${input.code_challenge_method}, ${expiresAt.toISOString()}
    )
    RETURNING id, expires_at
  `;
  return {
    id: row.id as string,
    nonce,
    expires_at: row.expires_at as Date,
  };
}

export interface ConsumedAuthorizationRequest {
  id: string;
  client_id: string;
  account_id: string;
  tenant_id: string;
  redirect_uri: string;
  audience: string;
  scopes: string[];
  state: string | null;
  code_challenge: string;
  code_challenge_method: string;
}

/**
 * Atomically consume an authorization-request row by its raw
 * nonce. Returns null if the row was already consumed, expired,
 * or doesn't exist. Single-use via the `consumed_at IS NULL`
 * predicate in the UPDATE.
 *
 * Caller MUST run this inside the same transaction that inserts
 * the resulting auth-code grant.
 *
 * SECURITY: pass `ownerAccountId` (the presenting session's account) so the
 * consume is scoped to the owner. Without it, a non-owner who presents
 * someone else's pending consent nonce would BURN it (the consume commits)
 * before any application-level ownership check — a one-time-nonce griefing /
 * DoS primitive against an in-flight OAuth consent. With the owner predicate,
 * a non-owner matches zero rows and gets the generic `null` (invalid_grant),
 * never consuming the victim's request.
 */
export async function consumeAuthorizationRequest(
  txOrSql: SqlTag,
  rawNonce: string,
  ownerAccountId?: string | null,
): Promise<ConsumedAuthorizationRequest | null> {
  const nonce_hash = hashToken(rawNonce);
  const ownerFilter = ownerAccountId
    ? txOrSql`AND account_id = ${ownerAccountId}::uuid`
    : txOrSql``;
  const [row] = await txOrSql`
    UPDATE oauth_authorization_requests
    SET consumed_at = now()
    WHERE nonce_hash = ${nonce_hash}
      AND consumed_at IS NULL
      AND expires_at > now()
      ${ownerFilter}
    RETURNING id, client_id, account_id::text AS account_id, tenant_id,
              redirect_uri, audience, scopes, state,
              code_challenge, code_challenge_method
  `;
  if (!row) return null;
  return {
    id: row.id as string,
    client_id: row.client_id as string,
    account_id: row.account_id as string,
    tenant_id: row.tenant_id as string,
    redirect_uri: row.redirect_uri as string,
    audience: row.audience as string,
    scopes: row.scopes as string[],
    state: (row.state as string | null) ?? null,
    code_challenge: row.code_challenge as string,
    code_challenge_method: row.code_challenge_method as string,
  };
}

// ── Auth code creation ──────────────────────────────────────

export interface CreateAuthCodeInput {
  client_id: string;
  account_id: string;
  tenant_id: string;
  agent_id: string;
  hosted_agent_credential_id: string;
  audience: string;
  scopes: readonly string[];
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string | null;
}

export interface CreatedAuthCode {
  grant_id: string;
  raw_code: string;
  family_id: string;
  expires_at: Date;
}

/**
 * Issue an auth-code grant in the consent flow. Caller is
 * expected to have JUST consumed the matching authorization
 * request in the same transaction.
 */
export async function createAuthCodeGrant(
  txOrSql: SqlTag,
  input: CreateAuthCodeInput,
): Promise<CreatedAuthCode> {
  const id = crypto.randomUUID();
  const family_id = id; // self-rooted family per the rung-10 design
  const raw_code = mintAuthCode();
  const expires_at = new Date(Date.now() + AUTH_CODE_TTL_MS);
  await txOrSql`
    INSERT INTO oauth_grants (
      id, client_id, auth_code_hash,
      account_id, tenant_id, agent_id, hosted_agent_credential_id,
      scopes, audience,
      code_challenge, code_challenge_method, redirect_uri, state,
      expires_at,
      status,
      grant_family_id
    )
    VALUES (
      ${id}::uuid, ${input.client_id}, ${hashToken(raw_code)},
      ${input.account_id}::uuid, ${input.tenant_id}, ${input.agent_id}, ${input.hosted_agent_credential_id}::uuid,
      ${input.scopes as unknown as string[]}, ${input.audience},
      ${input.code_challenge}, ${input.code_challenge_method}, ${input.redirect_uri}, ${input.state},
      ${expires_at.toISOString()},
      'active',
      ${family_id}::uuid
    )
  `;
  return { grant_id: id, raw_code, family_id, expires_at };
}

// ── Code exchange (auth code → access + refresh) ────────────

export interface CodeExchangeInput {
  raw_code: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  code_verifier: string;
  /**
   * Whether the registered client may receive a refresh token (B29-1). The
   * route passes client.grant_types.includes("refresh_token"). Defaults to
   * true for backward-compat when omitted (internal/test callers).
   */
  allow_refresh?: boolean;
}

export type CodeExchangeError =
  | { kind: "invalid_grant"; message: string }
  | { kind: "invalid_client"; message: string }
  | { kind: "invalid_target"; message: string }
  | { kind: "invalid_request"; message: string };

export interface CodeExchangeResult {
  grant_id: string;
  access_token: string;
  /** null when the client is not authorized for the refresh_token grant (B29-1). */
  refresh_token: string | null;
  access_expires_at: Date;
  refresh_expires_at: Date | null;
  refresh_inactivity_at: Date | null;
  family_id: string;
  account_id: string;
  tenant_id: string;
  agent_id: string;
  hosted_agent_credential_id: string;
  audience: string;
  scopes: string[];
}

export interface CodeExchangeHooks {
  auditInside?: (tx: SqlOrTx, result: CodeExchangeResult) => Promise<void>;
}

/**
 * Exchange an auth code for access + refresh tokens. Atomic:
 * the auth code is marked consumed_at (status stays 'active'
 * until the family rotates) and a NEW row in the same family
 * is inserted carrying the fresh access+refresh hashes. Per
 * the rung-10 design, a self-rooted family's first non-code
 * row chains via parent_grant_id back to the auth-code row.
 */
export async function exchangeAuthCode(
  sql: SqlTag,
  input: CodeExchangeInput,
  hooks: CodeExchangeHooks = {},
): Promise<CodeExchangeResult | { error: CodeExchangeError }> {
  const code_hash = hashToken(input.raw_code);
  // Single-use enforcement: lock the code row before marking it consumed.
  return await sql.begin(async (tx) => {
    const q = tx as any;
    // Bound the FOR UPDATE wait (batch-27 B2): an interactive token endpoint must
    // not pin a pooled connection waiting on a contended grant row. SET LOCAL is
    // tx-scoped (auto-resets on commit/rollback). 3s → fail fast on contention.
    await q`SET LOCAL lock_timeout = '3s'`;
    const [code] = await q`
      SELECT id, client_id, account_id::text AS account_id, tenant_id, agent_id,
             hosted_agent_credential_id::text AS hosted_agent_credential_id,
             scopes, audience, code_challenge, code_challenge_method,
             redirect_uri, expires_at, status, consumed_at, grant_family_id::text AS grant_family_id
      FROM oauth_grants
      WHERE auth_code_hash = ${code_hash}
        AND status = 'active'
      FOR UPDATE
    `;
    if (!code) {
      return { error: { kind: "invalid_grant", message: "Authorization code not found or already consumed." } };
    }
    if (code.consumed_at !== null) {
      return { error: { kind: "invalid_grant", message: "Authorization code already consumed." } };
    }
    if ((code.expires_at as Date).getTime() <= Date.now()) {
      return { error: { kind: "invalid_grant", message: "Authorization code expired." } };
    }
    if (code.client_id !== input.client_id) {
      return { error: { kind: "invalid_client", message: "client_id does not match authorization code." } };
    }
    if (code.redirect_uri !== input.redirect_uri) {
      return { error: { kind: "invalid_grant", message: "redirect_uri does not match the one used at /authorize." } };
    }
    if (code.audience !== input.resource) {
      return { error: { kind: "invalid_target", message: "resource does not match the audience bound at /authorize." } };
    }
    if (!verifyPkceS256(input.code_verifier, code.code_challenge as string)) {
      return { error: { kind: "invalid_grant", message: "PKCE code_verifier check failed." } };
    }

    // Mark the code consumed.
    await q`
      UPDATE oauth_grants
      SET status = 'consumed',
          consumed_at = now()
      WHERE id = ${code.id as string}::uuid
    `;

    // Issue the fresh access + refresh row in the same family.
    const new_id = crypto.randomUUID();
    const access_token = mintAccessToken();
    // B29-1: only mint a refresh token if the client registered the
    // refresh_token grant type. A code-only client (RFC 6749 §5.2
    // unauthorized_client) gets an access token with NO refresh — closing the
    // over-issuance of long-lived capability against the client's own declared
    // posture. Existing clients that registered refresh_token are unaffected.
    const allowRefresh = input.allow_refresh !== false;
    const refresh_token = allowRefresh ? mintRefreshToken() : null;
    const now = Date.now();
    const access_expires_at = new Date(now + ACCESS_TOKEN_TTL_MS);
    const refresh_expires_at = allowRefresh ? new Date(now + REFRESH_TOKEN_ABSOLUTE_TTL_MS) : null;
    const refresh_inactivity_at = allowRefresh ? new Date(now + REFRESH_TOKEN_INACTIVITY_TTL_MS) : null;

    await q`
      INSERT INTO oauth_grants (
        id, client_id,
        access_token_hash, refresh_token_hash,
        account_id, tenant_id, agent_id, hosted_agent_credential_id,
        scopes, audience,
        expires_at, refresh_expires_at, refresh_inactivity_at,
        status, grant_family_id, parent_grant_id
      )
      VALUES (
        ${new_id}::uuid, ${code.client_id as string},
        ${hashToken(access_token)}, ${refresh_token ? hashToken(refresh_token) : null},
        ${code.account_id as string}::uuid, ${code.tenant_id as string}, ${code.agent_id as string},
        ${code.hosted_agent_credential_id as string}::uuid,
        ${code.scopes as unknown as string[]}, ${code.audience as string},
        ${access_expires_at.toISOString()}, ${refresh_expires_at ? refresh_expires_at.toISOString() : null}, ${refresh_inactivity_at ? refresh_inactivity_at.toISOString() : null},
        'active', ${code.grant_family_id as string}::uuid, ${code.id as string}::uuid
      )
    `;
    const result: CodeExchangeResult = {
      grant_id: new_id,
      access_token,
      refresh_token,
      access_expires_at,
      refresh_expires_at,
      refresh_inactivity_at,
      family_id: code.grant_family_id as string,
      account_id: code.account_id as string,
      tenant_id: code.tenant_id as string,
      agent_id: code.agent_id as string,
      hosted_agent_credential_id: code.hosted_agent_credential_id as string,
      audience: code.audience as string,
      scopes: code.scopes as string[],
    };
    if (hooks.auditInside) await hooks.auditInside(q, result);
    return result;
  });
}

// ── Refresh token grant ─────────────────────────────────────

export interface RefreshInput {
  raw_refresh_token: string;
  client_id: string;
  resource: string;
}

export type RefreshError =
  | { kind: "invalid_grant"; message: string }
  | { kind: "invalid_client"; message: string }
  | { kind: "invalid_target"; message: string };

/**
 * Refresh an access token using a stable refresh token. The
 * active grant row is updated in place, preserving the refresh
 * token while issuing a fresh access token and extending the
 * inactivity window. Historical consumed refresh rows are
 * treated as stale invalid_grant, not family-wide compromise.
 */
export async function rotateRefreshToken(
  sql: SqlTag,
  input: RefreshInput,
  hooks: CodeExchangeHooks = {},
): Promise<CodeExchangeResult | { error: RefreshError }> {
  const refresh_hash = hashToken(input.raw_refresh_token);
  return await sql.begin(async (tx) => {
    const q = tx as any;
    // Bound the FOR UPDATE wait (batch-27 B2) — same rationale as exchangeAuthCode:
    // fail fast on a contended grant row instead of pinning a pooled connection.
    await q`SET LOCAL lock_timeout = '3s'`;
    // Look up by hash. Includes consumed/revoked rows so stale
    // historical refresh grants cleanly return invalid_grant.
    // batch-32 VO-TOK-1: join the credential/account/tenant-link lifecycle so a
    // refresh can't keep minting access tokens for a suspended account, a revoked
    // credential, or a severed tenant link — mirroring resolveConnectorAccessTokenForResource
    // (oauth-resource-resolver.ts) so refresh and resolution share one lifecycle truth.
    // FOR UPDATE OF g: lock only the grants row (FOR UPDATE can't apply to the
    // nullable side of the LEFT JOIN; the rotation only mutates oauth_grants).
    const [row] = await q`
      SELECT g.id, g.client_id, g.account_id::text AS account_id, g.tenant_id, g.agent_id,
             g.hosted_agent_credential_id::text AS hosted_agent_credential_id,
             g.scopes, g.audience, g.status, g.refresh_expires_at,
             g.refresh_inactivity_at,
             g.grant_family_id::text AS grant_family_id,
             c.status AS credential_status,
             a.status AS account_status,
             atl.status AS link_status
      FROM oauth_grants g
      JOIN hosted_agent_credentials c
        ON c.credential_id = g.hosted_agent_credential_id
       AND c.account_id    = g.account_id
       AND c.tenant_id     = g.tenant_id
       AND c.agent_id      = g.agent_id
      JOIN accounts a
        ON a.account_id    = g.account_id
      LEFT JOIN account_tenant_links atl
        ON atl.account_id  = g.account_id
       AND atl.tenant_id   = g.tenant_id
       AND atl.status      = 'active'
      WHERE g.refresh_token_hash = ${refresh_hash}
      FOR UPDATE OF g
    `;
    if (!row) {
      return { error: { kind: "invalid_grant", message: "Refresh token not found." } };
    }
    if (row.client_id !== input.client_id) {
      return { error: { kind: "invalid_client", message: "client_id does not match grant." } };
    }
    if (row.audience !== input.resource) {
      return { error: { kind: "invalid_target", message: "resource does not match grant audience." } };
    }
    if (row.status === "consumed") {
      return { error: { kind: "invalid_grant", message: "Refresh token is no longer active." } };
    }
    if (row.status !== "active") {
      return { error: { kind: "invalid_grant", message: `Refresh token status is '${row.status}'.` } };
    }
    const absoluteExpiry = row.refresh_expires_at as Date;
    if (absoluteExpiry.getTime() <= Date.now()) {
      return { error: { kind: "invalid_grant", message: "Refresh token expired (absolute TTL)." } };
    }
    const inactivityExpiry = row.refresh_inactivity_at as Date | null;
    if (inactivityExpiry && inactivityExpiry.getTime() <= Date.now()) {
      return { error: { kind: "invalid_grant", message: "Refresh token expired (inactivity TTL)." } };
    }
    // batch-32 VO-TOK-1: lifecycle gates (parity with the access-token resolver).
    if (row.credential_status !== "active") {
      return { error: { kind: "invalid_grant", message: "Agent credential is no longer active." } };
    }
    if (row.account_status !== "active") {
      return { error: { kind: "invalid_grant", message: "Account is no longer active." } };
    }
    if (row.link_status !== "active") {
      return { error: { kind: "invalid_grant", message: "Tenant link is no longer active." } };
    }

    // Issue a fresh access token while keeping the refresh token
    // stable. Inactivity is clamped to the absolute family expiry.
    const access_token = mintAccessToken();
    const now = Date.now();
    const access_expires_at = new Date(now + ACCESS_TOKEN_TTL_MS);
    const refresh_inactivity_at = computeRotatedInactivityAt(absoluteExpiry, now);

    await q`
      UPDATE oauth_grants
      SET access_token_hash = ${hashToken(access_token)},
          expires_at = ${access_expires_at.toISOString()},
          refresh_inactivity_at = ${refresh_inactivity_at.toISOString()},
          last_used_at = now()
      WHERE id = ${row.id as string}::uuid
    `;
    const result: CodeExchangeResult = {
      grant_id: row.id as string,
      access_token,
      refresh_token: input.raw_refresh_token,
      access_expires_at,
      refresh_expires_at: absoluteExpiry,
      refresh_inactivity_at,
      family_id: row.grant_family_id as string,
      account_id: row.account_id as string,
      tenant_id: row.tenant_id as string,
      agent_id: row.agent_id as string,
      hosted_agent_credential_id: row.hosted_agent_credential_id as string,
      audience: row.audience as string,
      scopes: row.scopes as string[],
    };
    if (hooks.auditInside) await hooks.auditInside(q, result);
    return result;
  });
}

// ── Family-wide revocation ──────────────────────────────────

export interface FamilyRevokeResult {
  family_id: string | null;
  revoked_count: number;
  /**
   * Forensic dimensions of the revoked family, captured via RETURNING in the
   * same statement so the audit row can reconstruct client/agent/audience/
   * scope without a second query. Null when no grant resolved (a
   * revokeByPresentedToken miss) or nothing was revoked (already
   * revoked/expired family). All rows in a family share client_id/agent_id/
   * audience by construction; scopes are the granted set.
   */
  client_id: string | null;
  agent_id: string | null;
  audience: string | null;
  scopes: string[] | null;
}

export interface FamilyRevokeHooks {
  /**
   * Runs as the last statement inside the revoke, with the same db/tx handle
   * the UPDATE used, so the audit row commits or rolls back atomically with
   * the revoke. If it throws, the revoke rolls back with it.
   */
  auditInside?: (tx: SqlOrTx, result: FamilyRevokeResult) => Promise<void>;
  /**
   * RFC 7009 §2.1 client binding for revokeByPresentedToken. When set (even to
   * "" or null), the presented token's grant family is only revoked if its
   * client_id equals this value; a mismatch is a silent no-op (§2.2 — respond
   * 200, leak no existence info). Leave undefined to skip the check for
   * separately-authenticated callers.
   */
  expectedClientId?: string | null;
}

/**
 * Family-wide revoke. Used by /oauth/revoke (RFC 7009),
 * /my/connectors POST, /admin/connectors POST. Accepts any
 * presented token (access, refresh, or auth code) — resolves
 * to the family then revokes.
 */
export async function revokeByPresentedToken(
  sql: SqlTag,
  raw_token: string,
  reason: RevokedReason,
  hooks: FamilyRevokeHooks = {},
): Promise<FamilyRevokeResult> {
  const h = hashToken(raw_token);
  const [grant] = await sql`
    SELECT grant_family_id::text AS grant_family_id, client_id
    FROM oauth_grants
    WHERE access_token_hash = ${h}
       OR refresh_token_hash = ${h}
       OR auth_code_hash = ${h}
    LIMIT 1
  `;
  // Token not found: nothing to revoke and nothing to audit (auditInside is
  // not invoked), matching RFC 7009 §2.2 (respond 200, leak no existence info).
  if (!grant) {
    return { family_id: null, revoked_count: 0, client_id: null, agent_id: null, audience: null, scopes: null };
  }
  // RFC 7009 §2.1: a (public) client may only revoke a token issued to ITSELF.
  // When the caller binds an expected client_id, a mismatch is a silent no-op so
  // a party holding another client's token string cannot revoke that client's
  // grant family (§2.2: still respond 200, leak no existence info).
  if (hooks.expectedClientId !== undefined && grant.client_id !== hooks.expectedClientId) {
    return { family_id: null, revoked_count: 0, client_id: null, agent_id: null, audience: null, scopes: null };
  }
  return revokeFamily(sql, grant.grant_family_id as string, reason, hooks);
}

/** Revoke an entire grant family by id. Single UPDATE; RETURNING captures the
 *  forensic dimensions for the audit row. auditInside (when supplied) runs
 *  inside the same statement's handle so the audit commits/rolls back with it. */
export async function revokeFamily(
  sqlOrTx: SqlTag,
  family_id: string,
  reason: RevokedReason,
  hooks: FamilyRevokeHooks = {},
): Promise<FamilyRevokeResult> {
  const rows = await sqlOrTx`
    UPDATE oauth_grants
    SET status = 'revoked',
        revoked_reason = ${reason},
        revoked_at = now()
    WHERE grant_family_id = ${family_id}::uuid
      AND status NOT IN ('revoked','expired')
    RETURNING client_id, agent_id, audience, scopes
  `;
  const head = (rows[0] as { client_id: string; agent_id: string; audience: string; scopes: string[] } | undefined) ?? null;
  const result: FamilyRevokeResult = {
    family_id,
    revoked_count: rows.length,
    client_id: head?.client_id ?? null,
    agent_id: head?.agent_id ?? null,
    audience: head?.audience ?? null,
    scopes: head?.scopes ?? null,
  };
  if (hooks.auditInside) await hooks.auditInside(sqlOrTx, result);
  return result;
}

/**
 * Cascade-revoke for credential-revoke sites
 * (`/account/agent-keys/:id/revoke` single + `/account/unlink`
 * batch). Accepts a single credential_id OR an array of
 * credential ids; the SQL uses `ANY($ids)` so both paths share
 * one statement.
 *
 * MUST be called inside the same transaction as the credential
 * revoke UPDATE so the cascade lands atomically.
 */
export async function cascadeRevokeGrantsForCredentialIds(
  tx: SqlTag,
  credential_ids: readonly string[],
): Promise<{ revoked_count: number; family_ids: string[]; grants: Array<{ family_id: string; scopes: string[] }> }> {
  if (credential_ids.length === 0) {
    return { revoked_count: 0, family_ids: [], grants: [] };
  }
  const rows = await tx`
    UPDATE oauth_grants
    SET status = 'revoked',
        revoked_reason = 'credential_revoke',
        revoked_at = now()
    WHERE hosted_agent_credential_id = ANY(${credential_ids as unknown as string[]}::uuid[])
      AND status NOT IN ('revoked','expired')
    RETURNING grant_family_id::text AS grant_family_id, scopes
  `;
  const grantByFamily = new Map<string, string[]>();
  for (const row of rows) {
    const family_id = row.grant_family_id as string;
    if (!grantByFamily.has(family_id)) {
      grantByFamily.set(family_id, row.scopes as string[]);
    }
  }
  const grants = Array.from(grantByFamily.entries()).map(([family_id, scopes]) => ({ family_id, scopes }));
  const family_ids = grants.map((grant) => grant.family_id);
  return { revoked_count: rows.length, family_ids, grants };
}

// ── Retention sweep helpers (called by supercron pass) ──────

export interface RetentionSweepResult {
  expired_grants: number;
  pruned_authorization_requests: number;
  /** Observability snapshot counts (post-sweep) for operator visibility. */
  revoked_grants_seen: number;
  active_grants_seen: number;
  /** Distinct grant families touched by the expiry status-flip this run. */
  families_touched: number;
}

async function countGrantStatusSnapshot(
  sql: SqlTag,
): Promise<{ revoked: number; active: number }> {
  const [row] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active
    FROM oauth_grants
  `;
  return { revoked: Number(row?.revoked ?? 0), active: Number(row?.active ?? 0) };
}

/**
 * Status-flips grants whose refresh_inactivity_at OR
 * refresh_expires_at has passed; deletes consumed/expired
 * authorization requests older than 24 hours. Status flip
 * (NOT delete) preserves audit/export evidence. The expiry flip
 * and its single oauth_grant_expired summary audit row commit
 * atomically; the helper is idempotent (a second pass flips
 * nothing). Authorization-request rows are pre-token consent
 * nonces (not audit/export evidence), so pruning them is safe.
 */
export async function runConnectorGrantRetention(
  sql: SqlTag,
  options: { dryRun?: boolean } = {},
): Promise<RetentionSweepResult> {
  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    const [g] = await sql`
      SELECT COUNT(*)::int AS n
      FROM oauth_grants
      WHERE status = 'active'
        AND (
          (refresh_inactivity_at IS NOT NULL AND refresh_inactivity_at < now())
          OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < now())
        )
    `;
    const [r] = await sql`
      SELECT COUNT(*)::int AS n
      FROM oauth_authorization_requests
      WHERE (consumed_at IS NOT NULL OR expires_at < now())
        AND created_at < now() - interval '24 hours'
    `;
    const seen = await countGrantStatusSnapshot(sql);
    return {
      expired_grants: (g?.n as number) ?? 0,
      pruned_authorization_requests: (r?.n as number) ?? 0,
      revoked_grants_seen: seen.revoked,
      active_grants_seen: seen.active,
      families_touched: 0,
    };
  }

  const cleanupRunId = `oauth-grant-retention:${crypto.randomUUID()}`;
  const begin = (sql as unknown as {
    begin?: (fn: (tx: any) => Promise<{ expired: number; families: number }>) => Promise<{ expired: number; families: number }>;
  }).begin;
  const runExpiry = async (tx: any): Promise<{ expired: number; families: number }> => {
    const expRows = await tx`
      UPDATE oauth_grants
      SET status = 'expired',
          revoked_reason = 'retention_expired',
          revoked_at = now()
      WHERE status = 'active'
        AND (
          (refresh_inactivity_at IS NOT NULL AND refresh_inactivity_at < now())
          OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < now())
        )
      RETURNING id, grant_family_id::text AS grant_family_id
    `;
    const families = new Set(expRows.map((row: any) => row.grant_family_id as string)).size;
    if (expRows.length > 0) {
      // One summary audit row per run (not per grant) — the maintenance
      // summary already carries per-run counts; this is the forensic anchor
      // tying the expiry sweep to a cleanup_run_id. Commits atomically with
      // the status flip above.
      await tx`
        INSERT INTO hosted_audit_log (event_type, actor_kind, actor_label, correlation_id, event_data)
        VALUES (
          'oauth_grant_expired',
          'oauth_client',
          'oauth_retention:grants',
          ${cleanupRunId},
          ${tx.json({
            reason: "retention_expired",
            affected_grant_count: expRows.length,
            families_touched: families,
            cleanup_run_id: cleanupRunId,
          })}
        )
      `;
    }
    return { expired: expRows.length, families };
  };

  const { expired, families } = typeof begin === "function"
    ? await begin.call(sql, runExpiry)
    : await runExpiry(sql as any);

  const delRows = await sql`
    DELETE FROM oauth_authorization_requests
    WHERE (consumed_at IS NOT NULL OR expires_at < now())
      AND created_at < now() - interval '24 hours'
    RETURNING id
  `;
  const seen = await countGrantStatusSnapshot(sql);
  return {
    expired_grants: expired,
    pruned_authorization_requests: delRows.length,
    revoked_grants_seen: seen.revoked,
    active_grants_seen: seen.active,
    families_touched: families,
  };
}
