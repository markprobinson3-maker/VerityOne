/**
 * OAuth provider — VO-WEB-AGENT-CONNECTOR-OAUTH-PR-1 (rung 11a).
 *
 * Six external endpoints + one consent-submission handler +
 * one test-only fixture protected resource.
 *
 *   GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   POST /oauth/register                          (RFC 7591 DCR)
 *   GET  /oauth/authorize                         (PKCE + RFC 8707)
 *   POST /oauth/authorize/consent                 (consent → auth code)
 *   POST /oauth/token                             (auth_code | refresh)
 *   POST /oauth/revoke                            (RFC 7009 family-wide)
 *   GET  /oauth/test-resource                     (test-only fixture;
 *                                                  proves audience binding)
 *
 * Mount with `app.route("/", oauthRoute)` — the router exposes
 * paths under `/.well-known/*` and `/oauth/*` directly, so a
 * `/oauth` mount prefix would incorrectly move metadata to
 * `/oauth/.well-known/*`.
 *
 * Test-only fixture is conditionally registered inside the
 * router file; in production it returns the normal app-level
 * 404. Two-key gate per drift guard #10:
 *   `process.env.NODE_ENV === "test" &&
 *    process.env.VERITY_OAUTH_TEST_FIXTURES === "on"`.
 */

import crypto from "node:crypto";
import { errorJson, ApiError } from "../lib/error-envelope";

import { Hono } from "hono";

import { sql } from "../db";
import {
  ensureDefaultHostedAgentPolicy,
  loadConsentPolicyMap,
  resolveConnectorAccessTokenForResource,
  type MirroredStoredPolicy,
} from "../lib/oauth-hosted-port";
import {
  ALLOWED_CONNECTOR_SCOPES,
  lookupActiveClient,
  redirectUriMatches,
  registerClient,
  resolveRequestedConnectorScopes,
  validateDcrRequest,
} from "../lib/oauth-client-registry";
import {
  consumeAuthorizationRequest,
  createAuthCodeGrant,
  createAuthorizationRequest,
  exchangeAuthCode,
  revokeByPresentedToken,
  revokeFamily,
  rotateRefreshToken,
} from "../lib/oauth-grant";

const oauth = new Hono();

const SESSION_COOKIE = "vo_session";
const DEFAULT_OAUTH_ISSUER = "https://verityone.app";
type OAuthIssuerEnv = Record<string, string | undefined>;
export function normalizeOAuthIssuer(rawIssuer: string, sourceEnv: string): string {
  const raw = rawIssuer.trim();
  if (raw.includes("?") || raw.includes("#")) {
    throw new ApiError("install_misconfigured", `${sourceEnv} must not include query or fragment`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("install_misconfigured", `${sourceEnv} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    throw new ApiError("install_misconfigured", `${sourceEnv} must use https://`);
  }
  if (url.search || url.hash) {
    throw new ApiError("install_misconfigured", `${sourceEnv} must not include query or fragment`);
  }
  if (!/^\/*$/.test(url.pathname)) {
    throw new ApiError("install_misconfigured", `${sourceEnv} must not include path`);
  }
  // Canonical issuer form: origin only, no path/query/fragment/default port.
  return url.origin;
}
export function resolveOAuthIssuer(env: OAuthIssuerEnv = process.env): string {
  const vercelEnv = (env.VERCEL_ENV || "").trim();
  const isVercel = env.VERCEL === "1" || env.VERCEL === "true";
  if (isVercel && vercelEnv !== "production") {
    const vercelUrl = (env.VERCEL_URL || "").trim();
    if (!vercelUrl) {
      throw new ApiError("install_misconfigured", "VERCEL_URL is required for non-production Vercel OAuth issuer");
    }
    const rawPreviewUrl = vercelUrl.startsWith("http://") || vercelUrl.startsWith("https://")
      ? vercelUrl
      : `https://${vercelUrl}`;
    return new URL(normalizeOAuthIssuer(rawPreviewUrl, "VERCEL_URL")).origin;
  }
  return normalizeOAuthIssuer(env.VERITY_OAUTH_ISSUER || DEFAULT_OAUTH_ISSUER, "VERITY_OAUTH_ISSUER");
}
let configuredOAuthIssuerCache: string | null = null;
function configuredOAuthIssuer(): string {
  if (!configuredOAuthIssuerCache) {
    configuredOAuthIssuerCache = resolveOAuthIssuer();
  }
  return configuredOAuthIssuerCache;
}
export const PRODUCTION_RESOURCE = "https://verityone.app/mcp";
const TEST_FIXTURE_RESOURCE = "https://verityone.app/oauth/test-resource";

/**
 * Canonical OAuth protected-resource (RFC 8707 resource indicator) that every
 * issued connector token is audience-bound to. Exported for the operator
 * readiness summary + conformance tests; the request-time accepted set
 * (acceptedAudiences) additionally allows the test-only fixture resource.
 */
export function resolveOAuthResource(): string {
  return PRODUCTION_RESOURCE;
}
const OAUTH_AUTO_CREDENTIAL_LABEL = "OAuth default read-only connector";
const OAUTH_AUTO_SYNC_SOURCE_NODE_ID = "hosted-oauth-auto-provision";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OAUTH_METADATA_CACHE_CONTROL = "public, max-age=3600";

const DEFAULT_OAUTH_AGENT_POLICY = {
  write_permission: "denied",
  recall_scope: "tenant_private",
  visible_projects: null,
} as const;

function setOAuthNoStoreHeaders(c: any): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Origin");
}

export function hasConfiguredOAuthIssuer(env: OAuthIssuerEnv = process.env): boolean {
  return Boolean((env.VERITY_OAUTH_ISSUER || "").trim() || env.VERCEL === "1" || env.VERCEL === "true");
}

function oauthIssuerForRequest(c: any): string {
  if (hasConfiguredOAuthIssuer()) return configuredOAuthIssuer();
  const url = new URL(c.req.url);
  const isLocalHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol === "http:" && isLocalHost) {
    return `${url.protocol}//${url.host}`;
  }
  return configuredOAuthIssuer();
}

function oauthEndpointOriginForIssuer(issuer: string): string {
  return new URL(issuer).origin;
}

function setOAuthMetadataHeaders(c: any): void {
  c.header("Cache-Control", OAUTH_METADATA_CACHE_CONTROL);
}

function setOAuthHtmlSecurityHeaders(c: any): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
}

function oauthNoStoreJson(c: any, body: unknown, status: number): Response {
  setOAuthNoStoreHeaders(c);
  return c.json(body, status as any);
}

type ConsentCredential = {
  credential_id: string;
  agent_id: string;
  label: string;
  created_at: Date | string | null;
  last_used_at: Date | string | null;
  has_policy: boolean;
  auto_provisioned?: boolean;
  stored_policy?: MirroredStoredPolicy | null;
};

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function isTestFixturesEnabled(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.VERITY_OAUTH_TEST_FIXTURES === "on"
  );
}

function acceptedAudiences(): readonly string[] {
  return isTestFixturesEnabled()
    ? [PRODUCTION_RESOURCE, TEST_FIXTURE_RESOURCE]
    : [PRODUCTION_RESOURCE];
}

function requestedResource(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : PRODUCTION_RESOURCE;
}

function newOauthAutoAgentId(): string {
  return `mcp-oauth-default-${crypto.randomBytes(8).toString("hex")}`;
}

function isLoopbackRedirectUri(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function formString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getSessionCookie(c: any): string | null {
  const raw = c.req.header("Cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

interface SessionAccount {
  session_id: string;
  account_id: string;
  email: string;
  tenant_id: string | null;
}

async function resolveSessionAccount(c: any): Promise<SessionAccount | null> {
  const token = getSessionCookie(c);
  if (!token) return null;
  const [row] = await sql`
    SELECT s.session_id, s.account_id, a.email
    FROM account_sessions s
    JOIN accounts a ON a.account_id = s.account_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.revoked = false
      AND s.expires_at > now()
      AND a.status = 'active'
  `;
  if (!row) return null;
  const [link] = await sql`
    SELECT tenant_id FROM account_tenant_links
    WHERE account_id = ${row.account_id} AND status = 'active'
  `;
  return {
    session_id: row.session_id as string,
    account_id: row.account_id as string,
    email: row.email as string,
    tenant_id: (link?.tenant_id as string | undefined) ?? null,
  };
}

function actorLabelForClient(client_id: string): string {
  // Non-secret label per drift guard plan: short prefix only.
  return `oauth_client:${client_id.slice(0, 12)}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// resolveActiveTenantTdkForWrite + ensureDefaultHostedAgentPolicy moved to the VO+
// side (../lib/oauth-hosted.ts) behind the open-core seam ../lib/oauth-hosted-port
// (coupling #3). ensureDefaultHostedAgentPolicy is imported from the seam above;
// it now takes the default-policy + sync-source-node-id as args so those public
// contract constants stay here while the hosted SQL/crypto stays private.

async function loadConsentCredentials(q: any, session: SessionAccount): Promise<ConsentCredential[]> {
  return await q`
    SELECT c.credential_id::text AS credential_id,
           c.agent_id,
           c.label,
           c.created_at,
           c.last_used_at,
           EXISTS(
	             SELECT 1 FROM hosted_mirror_items m
	             WHERE m.tenant_id = c.tenant_id
	               AND m.item_key = 'governance:agent_policy:' || c.agent_id
                 AND m.item_status = 'active'
	           ) AS has_policy
    FROM hosted_agent_credentials c
    WHERE c.account_id = ${session.account_id}::uuid
      AND c.tenant_id = ${session.tenant_id}
      AND c.status = 'active'
    ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC
  ` as unknown as ConsentCredential[];
}

// loadConsentPolicyMap moved to the VO+ side behind ../lib/oauth-hosted-port
// (open-core seam). It now takes agent-id strings (callers pass the mapped ids).

async function loadOrAutoProvisionConsentCredentials(
  session: SessionAccount,
  correlationId: string | null,
): Promise<
  | { ok: true; credentials: ConsentCredential[] }
  | { ok: false; status: number; title: string; message: string }
> {
  return await sql.begin(async (tx) => {
    const q = tx as any;
    await q`SELECT pg_advisory_xact_lock(hashtext(${`oauth_auto_credential:${session.account_id}:${session.tenant_id}`}))`;
    const existing = await loadConsentCredentials(q, session);
    if (existing.length > 0) return { ok: true as const, credentials: existing };

    const rawToken = `vop_REDACTED${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.slice(0, 12);
    const agentId = newOauthAutoAgentId();
    const [cred] = await q`
      INSERT INTO hosted_agent_credentials (
        account_id, tenant_id, agent_id, label, token_hash, token_prefix, status
      )
      VALUES (
        ${session.account_id}::uuid, ${session.tenant_id}, ${agentId},
        ${OAUTH_AUTO_CREDENTIAL_LABEL}, ${tokenHash}, ${tokenPrefix}, 'active'
      )
      RETURNING credential_id::text AS credential_id, agent_id, label, created_at, last_used_at
    `;

    const policy = await ensureDefaultHostedAgentPolicy(q, session.tenant_id!, agentId, DEFAULT_OAUTH_AGENT_POLICY, OAUTH_AUTO_SYNC_SOURCE_NODE_ID);
    if (!policy.ok) {
      throw new Error(`oauth_auto_policy_failed:${policy.reason}`);
    }

    await insertAudit(q, {
      event_type: "agent_credential_issue",
      actor_kind: "tenant_session",
      actor_label: session.email,
      account_id: session.account_id,
      tenant_id: session.tenant_id,
      correlation_id: correlationId,
      event_data: {
        source: "oauth_auto_provision",
        credential_id: cred!.credential_id,
        agent_id: agentId,
        label: OAUTH_AUTO_CREDENTIAL_LABEL,
        default_policy: DEFAULT_OAUTH_AGENT_POLICY,
      },
    });

    const credential: ConsentCredential = {
      credential_id: cred!.credential_id,
      agent_id: cred!.agent_id,
      label: cred!.label,
      created_at: cred!.created_at,
      last_used_at: cred!.last_used_at,
      has_policy: true,
      auto_provisioned: true,
    };

    return {
      ok: true as const,
      credentials: [credential],
    };
  }).catch((e) => {
    console.warn("[oauth] auto-provision default credential failed", e);
    return {
      ok: false,
      status: 503,
      title: "Connector setup is not ready",
      message: "VO could not create a default read-only connector credential for this tenant. Finish tenant setup outside this OAuth flow, then return to your app and authenticate again.",
    } as const;
  });
}

function grantedScopesForPolicy(requestedScopes: readonly string[], policy: MirroredStoredPolicy | null): string[] {
  if (!requestedScopes.includes("vo.write.intent")) return [...requestedScopes];
  return policy?.write_permission === "allowed" ? [...requestedScopes] : ["vo.read"];
}

function credentialPolicyCopy(cr: ConsentCredential, requestedScopes: readonly string[]): string {
  const policy = cr.stored_policy ?? null;
  const grantedScopes = grantedScopesForPolicy(requestedScopes, policy);
  const projectCopy = Array.isArray(policy?.visible_projects) && policy.visible_projects.length > 0
    ? `Project access is limited to ${policy.visible_projects.length} mirrored project${policy.visible_projects.length === 1 ? "" : "s"} by this credential policy.`
    : "Read access follows tenant governance and any managed-project ceiling; this credential has no narrower project allowlist mirrored.";
  const writeCopy = requestedScopes.includes("vo.write.intent")
    ? grantedScopes.includes("vo.write.intent")
      ? "Write intent is allowed by this credential policy; local VO still reviews and applies queued commands."
      : "Write intent was requested, but this credential is read-only unless you explicitly allow write intent later."
    : "No write-intent OAuth scope was requested.";
  if (!cr.has_policy || !policy) {
    return `VO will apply a default read-only policy before approval. ${projectCopy} ${writeCopy}`;
  }
  return `${projectCopy} ${writeCopy}`;
}

function renderCredentialSummary(cr: ConsentCredential, requestedScopes: readonly string[], selected: boolean): string {
  const grantedScopes = grantedScopesForPolicy(requestedScopes, cr.stored_policy ?? null).join(" ");
  const badge = cr.auto_provisioned
    ? `<span class="badge">auto-provisioned</span>`
    : cr.has_policy
      ? `<span class="badge">policy synced</span>`
      : `<span class="badge warn">default read-only policy will be applied</span>`;
  return `<div class="credential-card${selected ? " selected" : ""}">
    <div class="credential-title">
      <strong>agent_id:</strong> <code>${escapeHtml(cr.agent_id)}</code>
      ${badge}
    </div>
    <div><strong>Label:</strong> ${escapeHtml(cr.label || "(no label)")}</div>
    <div><strong>credential_id:</strong> <code>${escapeHtml(cr.credential_id.slice(0, 8))}…</code></div>
    <div><strong>Granted scope if approved:</strong> <code>${escapeHtml(grantedScopes)}</code></div>
    <p>${escapeHtml(credentialPolicyCopy(cr, requestedScopes))}</p>
  </div>`;
}

function renderConsentPage(args: {
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  issuer: string;
  requestedScopes: readonly string[];
  effectiveResource: string;
  session: SessionAccount;
  consentNonce: string;
  state: string | null;
  credentials: readonly ConsentCredential[];
}): string {
  const selected = args.credentials[0]!;
  const credentialControl = args.credentials.length === 1
    ? `<input type="hidden" name="credential_id" value="${escapeHtml(selected.credential_id)}">
       ${renderCredentialSummary(selected, args.requestedScopes, true)}`
    : `<fieldset>
        <legend>Choose credential</legend>
        ${args.credentials.map((cr, index) => `<label class="credential-choice">
          <input type="radio" name="credential_id" value="${escapeHtml(cr.credential_id)}"${index === 0 ? " checked" : ""} required>
          ${renderCredentialSummary(cr, args.requestedScopes, false)}
        </label>`).join("\n")}
       </fieldset>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize Connector — VO</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#021008;color:#e8dcc0;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.45}
.card{background:#0b2012;border:1px solid #3a3526;border-radius:8px;padding:1.25rem;margin:1rem 0}
.credential-card{border:1px solid #3a3526;border-radius:8px;padding:1rem;margin:.75rem 0;background:#06170c;color:#e8dcc0}
.credential-card.selected{border-color:#d4a857;background:#06170c}
.credential-choice:has(input:checked) .credential-card{border-color:#d4a857;background:#06170c}
.credential-title{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem}
.credential-choice{display:block;margin:.75rem 0;cursor:pointer}
.credential-choice input{margin-right:.5rem}
.badge{display:inline-block;border:1px solid #8bd49c;color:#8bd49c;border-radius:999px;padding:.1rem .45rem;font-size:.75rem}
.badge.warn{border-color:#ffb454;color:#e8c070}
button{background:#6e8a76;color:#021008;border:none;padding:.6rem 1rem;border-radius:6px;cursor:pointer;font-size:.95rem;font-weight:600}
.cancel{background:#3a3526;margin-left:.5rem}
.dim{color:#b8ad94;font-size:.9rem}
code{background:#3a3526;padding:.1rem .3rem;border-radius:3px;font-size:.85rem}
fieldset{border:0;padding:0;margin:0}legend{font-weight:700;margin-bottom:.35rem}
</style>
</head><body>
<h1>Authorize Connector</h1>
<div class="card">
  <p>An OAuth client is requesting connector access to your VO+ tenant.</p>
  ${args.client_name ? `<p><strong>Client name:</strong> ${escapeHtml(args.client_name)}</p>
  <p class="dim">This name was provided by the client during registration and has not been verified by VO.</p>` : ""}
  <p><strong>Client ID:</strong> <code>${escapeHtml(args.client_id)}</code></p>
  <p><strong>Requested scope:</strong> <code>${escapeHtml(args.requestedScopes.join(" "))}</code></p>
  <p><strong>Requested resource:</strong> <code>${escapeHtml(args.effectiveResource)}</code></p>
  <p><strong>Signed in as:</strong> ${escapeHtml(args.session.email)} · <strong>Tenant:</strong> ${escapeHtml(args.session.tenant_id)}</p>
</div>
<form method="POST" action="/oauth/authorize/consent">
  <input type="hidden" name="consent_nonce" value="${escapeHtml(args.consentNonce)}">
  <div class="card">
    <h2 style="margin-top:0;font-size:1.1rem">Bind grant to a credential</h2>
    <p>This controls what the connector can read or queue under the selected credential's agent_policy.</p>
    ${credentialControl}
  </div>
  <button type="submit">Approve</button>
  <a href="${escapeHtml(callbackUrlWithError(args.redirect_uri, "access_denied", args.state, args.issuer))}" class="cancel" style="display:inline-block;padding:.6rem 1rem;border-radius:6px;background:#3a3526;color:#e8dcc0;text-decoration:none">Cancel</a>
</form>
</body></html>`;
}

function callbackUrlWithCode(redirectUri: string, code: string, state: string | null, issuer = configuredOAuthIssuer()): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("iss", issuer);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function callbackUrlWithError(redirectUri: string, error: string, state: string | null, issuer = configuredOAuthIssuer()): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("iss", issuer);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function loopbackCallbackHandoffPage(callbackUrl: string): string {
  const jsonUrl = JSON.stringify(callbackUrl);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Connection approved — VO</title>
<meta name="referrer" content="no-referrer">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#021008;color:#e8dcc0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;line-height:1.45}
.box{max-width:520px;background:#0b2012;border:1px solid #3a3526;border-radius:8px;padding:1.5rem}
.dim{color:#b8ad94}a{color:#d4a857}
iframe{display:none;width:0;height:0;border:0}
img{display:none;width:0;height:0}
</style></head>
<body>
<div class="box">
  <h1>Connection approved</h1>
  <p>Returning you to your app…</p>
  <p class="dim">If your app didn't reconnect, return to it and click Authenticate again.</p>
  <p class="dim"><a id="manual-link" href="#">Return to app</a></p>
</div>
<iframe id="oauth-callback-frame" title="OAuth callback handoff"></iframe>
<img id="oauth-callback-pixel" alt="">
<script>
(() => {
  const callbackUrl = ${jsonUrl};
  const frame = document.getElementById("oauth-callback-frame");
  const pixel = document.getElementById("oauth-callback-pixel");
  const link = document.getElementById("manual-link");
  link.href = callbackUrl;
  frame.src = callbackUrl;
  pixel.src = callbackUrl;
  try { fetch(callbackUrl, { mode: "no-cors", cache: "no-store" }).catch(() => {}); } catch {}
})();
</script>
</body></html>`;
}

function correlationIdForRequest(c: any): string | null {
  try {
    if (typeof c.get !== "function") return null;
    const value = c.get("correlation_id");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

// Single owner of every hosted_audit_log write in this router. Every
// OAuth/auto-provision audit row flows through here so correlation_id and the
// column shape can never drift apart across the six emission sites. actor_kind
// defaults to the OAuth-client posture but is parameterized for the
// tenant-session auto-provision row. Callers inside a sql.begin(...) pass `tx`
// so the audit row commits/rolls back atomically with the mutation.
type AuditActorKind = "oauth_client" | "tenant_session" | "operator_token" | "admin_session" | "hosted_agent";

async function insertAudit(db: any, args: {
  event_type: string;
  actor_kind?: AuditActorKind;
  account_id?: string | null;
  tenant_id?: string | null;
  correlation_id?: string | null;
  actor_label: string;
  event_data: Record<string, unknown>;
}): Promise<void> {
  await db`
    INSERT INTO hosted_audit_log (
      event_type, actor_kind, actor_label, account_id, tenant_id, correlation_id, event_data
    )
    VALUES (
      ${args.event_type},
      ${args.actor_kind ?? "oauth_client"},
      ${args.actor_label},
      ${args.account_id ?? null},
      ${args.tenant_id ?? null},
      ${args.correlation_id ?? null},
      ${db.json(args.event_data as any)}
    )
  `;
}

// Touch last_used_at on a successful token exchange so the lifecycle retention
// sweep treats the client as in-service. Guarded by status='active' so a
// concurrently-flipped dormant/archived client is never resurrected. Best-effort
// and awaited before the token response so it is observable, but a failed touch
// must not fail token issuance.
async function markOauthClientUsed(client_id: string): Promise<void> {
  try {
    await sql`
      UPDATE oauth_clients
      SET last_used_at = now()
      WHERE client_id = ${client_id}
        AND status = 'active'
    `;
  } catch {
    /* best-effort last-used touch */
  }
}

function logOAuthTokenServerError(grantType: "authorization_code" | "refresh_token", err: unknown): void {
  const detail = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/[\r\n]/g, " ");
  console.error(`[oauth/token] ${grantType} grant failed before response: ${detail}`);
}

// ── Discovery metadata ──────────────────────────────────────

oauth.get("/.well-known/oauth-protected-resource", (c) => {
  setOAuthMetadataHeaders(c);
  const issuer = oauthIssuerForRequest(c);
  return c.json({
    resource: PRODUCTION_RESOURCE,
    authorization_servers: [issuer],
    scopes_supported: [...ALLOWED_CONNECTOR_SCOPES],
  });
});

oauth.get("/.well-known/oauth-authorization-server", (c) => {
  setOAuthMetadataHeaders(c);
  const issuer = oauthIssuerForRequest(c);
  const endpointOrigin = oauthEndpointOriginForIssuer(issuer);
  return c.json({
    issuer,
    authorization_endpoint: `${endpointOrigin}/oauth/authorize`,
    token_endpoint: `${endpointOrigin}/oauth/token`,
    registration_endpoint: `${endpointOrigin}/oauth/register`,
    revocation_endpoint: `${endpointOrigin}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    registration_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...ALLOWED_CONNECTOR_SCOPES],
  });
});

// ── DCR ─────────────────────────────────────────────────────

oauth.post("/oauth/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const v = validateDcrRequest(body);
  if (!v.ok) {
    const status = v.error.kind === "invalid_redirect_uri" ? 400 : 400;
    return oauthNoStoreJson(
      c,
      {
        error:
          v.error.kind === "invalid_redirect_uri"
            ? "invalid_redirect_uri"
            : v.error.kind === "invalid_client_secret_submission"
            ? "invalid_client_metadata"
            : "invalid_client_metadata",
        error_description: v.error.kind === "invalid_redirect_uri"
          ? v.error.message
          : (v.error as any).message,
      },
      status,
    );
  }
  const correlation_id = correlationIdForRequest(c);
  const row = await sql.begin(async (tx) => {
    // auditInside runs as the last statement inside the oauth_clients insert,
    // so a failed audit row rolls the registration back with it.
    return await registerClient(tx as any, v.req, {
      auditInside: async (txx, registered) => {
        await insertAudit(txx, {
          event_type: "oauth_client_register",
          correlation_id,
          actor_label: actorLabelForClient(registered.client_id),
          event_data: {
            client_id: registered.client_id,
            client_name: registered.client_name,
            redirect_uris: registered.redirect_uris,
            grant_types: registered.grant_types,
            scopes: registered.scopes,
            token_endpoint_auth_method: registered.token_endpoint_auth_method,
          },
        });
      },
    });
  });
  // RFC 7591 §3.2.1 response shape.
  return oauthNoStoreJson(
    c,
    {
      client_id: row.client_id,
      ...(row.client_name ? { client_name: row.client_name } : {}),
      // No client_secret — public client.
      redirect_uris: row.redirect_uris,
      grant_types: row.grant_types,
      scope: row.scopes.join(" "),
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      client_id_issued_at: Math.floor(row.registered_at.getTime() / 1000),
    },
    201,
  );
});

// ── /oauth/authorize ────────────────────────────────────────

function authorizeError(
  c: any,
  redirect_uri: string | null,
  state: string | null,
  error: string,
  description?: string,
): Response {
  if (redirect_uri) {
    const url = new URL(redirect_uri);
    url.searchParams.set("error", error);
    url.searchParams.set("iss", oauthIssuerForRequest(c));
    if (description) url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  }
  return oauthProtocolErrorJson(c, error, description, 400, state ? { state } : undefined);
}

function oauthProtocolErrorJson(
  c: any,
  error: string,
  description: string | undefined,
  status: number,
  extra?: Record<string, string>,
): Response {
  setOAuthNoStoreHeaders(c);
  return c.json({ error, error_description: description, ...(extra ?? {}) }, status as any);
}

oauth.get("/oauth/authorize", async (c) => {
  const params = c.req.query();
  const response_type = params.response_type;
  const client_id = params.client_id;
  const redirect_uri = params.redirect_uri ?? null;
  const scope = params.scope;
  const state = params.state ?? null;
  const code_challenge = params.code_challenge;
  const code_challenge_method = params.code_challenge_method;
  const resource = params.resource;

  if (!client_id || typeof client_id !== "string") {
    return authorizeError(c, null, state, "invalid_request", "client_id is required.");
  }
  const client = await lookupActiveClient(sql, client_id);
  if (!client) {
    return authorizeError(c, null, state, "invalid_client", "Unknown or revoked client_id.");
  }
  if (!redirect_uri || !client.redirect_uris.some((stored) => redirectUriMatches(redirect_uri, stored))) {
    return authorizeError(c, null, state, "invalid_request", "redirect_uri does not match a registered URI.");
  }
  if (response_type !== "code") {
    return authorizeError(c, redirect_uri, state, "unsupported_response_type", "response_type must be 'code'.");
  }
  const requestedScopes = resolveRequestedConnectorScopes(scope, client.scopes);
  if (!requestedScopes) {
    return authorizeError(c, redirect_uri, state, "invalid_scope", "scope must be 'vo.read' or 'vo.read vo.write.intent'.");
  }
  if (code_challenge_method !== "S256") {
    return authorizeError(c, redirect_uri, state, "invalid_request", "code_challenge_method must be 'S256'.");
  }
  if (!code_challenge || code_challenge.length < 43) {
    return authorizeError(c, redirect_uri, state, "invalid_request", "code_challenge missing or too short.");
  }
  const effectiveResource = requestedResource(resource);
  if (!acceptedAudiences().includes(effectiveResource)) {
    return authorizeError(c, redirect_uri, state, "invalid_target", "resource must be the canonical /mcp URI.");
  }

  const session = await resolveSessionAccount(c);
  if (!session) {
    // Send the user to sign in, then loop back to /oauth/authorize.
    const url = new URL(c.req.url);
    const ret = url.pathname + url.search;
    return c.redirect(`/my?return_to=${encodeURIComponent(ret)}`, 302);
  }
  if (!session.tenant_id) {
    setOAuthHtmlSecurityHeaders(c);
    return c.html(
      `<h1>Tenant link required</h1><p>You are signed in but your account has no active tenant. Run <code>vo account link</code> locally first.</p>`,
      400,
    );
  }

  const credentialResult = await loadOrAutoProvisionConsentCredentials(session, correlationIdForRequest(c));
  if (!credentialResult.ok) {
    setOAuthHtmlSecurityHeaders(c);
    return c.html(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(credentialResult.title)}</title>
       <style>body{font-family:-apple-system,sans-serif;background:#021008;color:#e8dcc0;max-width:620px;margin:2rem auto;padding:0 1rem;line-height:1.45}.box{background:#0b2012;border:1px solid #3a3526;border-radius:8px;padding:1.25rem}</style>
       </head><body><div class="box"><h1>${escapeHtml(credentialResult.title)}</h1><p>${escapeHtml(credentialResult.message)}</p></div></body></html>`,
      credentialResult.status as any,
    );
  }
  const credentials = credentialResult.credentials;
  const policyMap = await loadConsentPolicyMap(sql as any, session.tenant_id, credentials.map((c) => c.agent_id));
  const credentialsWithPolicies = credentials.map((cr) => ({
    ...cr,
    stored_policy: policyMap[cr.agent_id] ?? null,
  }));

  // Persist the consent handoff.
  const req = await createAuthorizationRequest(sql, {
    client_id,
    account_id: session.account_id,
    tenant_id: session.tenant_id,
    redirect_uri,
    audience: effectiveResource,
    scopes: requestedScopes,
    state,
    code_challenge,
    code_challenge_method: "S256",
  });

  setOAuthHtmlSecurityHeaders(c);
  return c.html(renderConsentPage({
    client_id,
    client_name: client.client_name,
    redirect_uri,
    issuer: oauthIssuerForRequest(c),
    requestedScopes,
    effectiveResource,
    session,
    consentNonce: req.nonce,
    state,
    credentials: credentialsWithPolicies,
  }));
});

oauth.post("/oauth/authorize/consent", async (c) => {
  const session = await resolveSessionAccount(c);
  if (!session) return errorJson(c, "unauthorized", { message: "session_required" });

  const body = await c.req.parseBody();
  const consent_nonce = formString(body.consent_nonce);
  const credential_id = formString(body.credential_id);
  if (!consent_nonce || !credential_id) {
    return oauthProtocolErrorJson(c, "invalid_request", "consent_nonce and credential_id required.", 400);
  }
  if (!isUuid(credential_id)) {
    return oauthProtocolErrorJson(c, "invalid_request", "credential_id must be a UUID.", 400);
  }

  // Single tx: consume nonce + verify credential + insert auth-
  // code grant. Replay sees zero rows on the consume UPDATE.
  const correlation_id = correlationIdForRequest(c);
  const result = await sql.begin(async (tx) => {
    const q = tx as any;
    // Scope the consume to the presenting session's account so a non-owner
    // cannot BURN another account's one-time consent nonce (the consume
    // commits even on a value-return rejection). A non-owner now matches zero
    // rows and falls into the generic invalid_grant below.
    const req = await consumeAuthorizationRequest(q, consent_nonce, session.account_id);
    if (!req) {
      return { ok: false as const, status: 400, error: "invalid_grant", description: "Consent nonce already consumed or expired." };
    }
    // Defense-in-depth: with the owner-scoped consume above this is
    // unreachable (req.account_id always equals session.account_id), but the
    // explicit guard documents the invariant and protects against a future
    // refactor dropping the owner predicate.
    if (req.account_id !== session.account_id) {
      return { ok: false as const, status: 403, error: "access_denied", description: "Session does not own this consent request." };
    }
    // Verify selected credential. has_policy is computed from
    // the encrypted hosted_mirror_items governance row (see
    // api/src/lib/hosted-governance-read.ts).
    const [cred] = await q`
      SELECT c.credential_id, c.agent_id, c.status,
             EXISTS(
               SELECT 1 FROM hosted_mirror_items m
               WHERE m.tenant_id = ${req.tenant_id}
                 AND m.item_key = 'governance:agent_policy:' || c.agent_id
                 AND m.item_status = 'active'
             ) AS has_policy
      FROM hosted_agent_credentials c
      WHERE c.credential_id = ${credential_id}::uuid
        AND c.account_id = ${req.account_id}::uuid
        AND c.tenant_id = ${req.tenant_id}
        AND c.status = 'active'
    `;
    if (!cred) {
      return { ok: false as const, status: 400, error: "invalid_grant", description: "Selected credential not found or not active for this tenant." };
    }

    const policyResult = await ensureDefaultHostedAgentPolicy(q, req.tenant_id, cred.agent_id as string, DEFAULT_OAUTH_AGENT_POLICY, OAUTH_AUTO_SYNC_SOURCE_NODE_ID);
    if (!policyResult.ok) {
      return { ok: false as const, status: 503, error: "temporarily_unavailable", description: "Default connector policy could not be prepared. Finish tenant setup outside this OAuth flow, then authenticate again." };
    }
    const policyMap = await loadConsentPolicyMap(q, req.tenant_id, [String(cred.agent_id)]);
    const selectedPolicy = policyMap[String(cred.agent_id)] ?? null;
    const grantedScopes = grantedScopesForPolicy(req.scopes, selectedPolicy);
    const code = await createAuthCodeGrant(q, {
      client_id: req.client_id,
      account_id: req.account_id,
      tenant_id: req.tenant_id,
      agent_id: cred.agent_id as string,
      hosted_agent_credential_id: cred.credential_id as string,
      audience: req.audience,
      scopes: grantedScopes,
      redirect_uri: req.redirect_uri,
      code_challenge: req.code_challenge,
      code_challenge_method: req.code_challenge_method as "S256",
      state: req.state,
    });
    await insertAudit(q, {
      event_type: "oauth_authorize",
      actor_label: actorLabelForClient(req.client_id),
      account_id: req.account_id,
      tenant_id: req.tenant_id,
      correlation_id,
      event_data: {
        client_id: req.client_id,
        credential_id: cred.credential_id,
        agent_id: cred.agent_id,
        grant_family_id: code.family_id,
        audience: req.audience,
        requested_scopes: req.scopes,
        granted_scopes: grantedScopes,
        default_policy_created: policyResult.created,
      },
    });
    return { ok: true as const, redirect_uri: req.redirect_uri, code: code.raw_code, state: req.state };
  });

  if (!result.ok) {
    return oauthProtocolErrorJson(c, result.error, result.description, result.status);
  }
  const callbackUrl = callbackUrlWithCode(result.redirect_uri, result.code, result.state, oauthIssuerForRequest(c));
  if (isLoopbackRedirectUri(result.redirect_uri)) {
    setOAuthHtmlSecurityHeaders(c);
    c.header("Pragma", "no-cache");
    return c.html(loopbackCallbackHandoffPage(callbackUrl));
  }
  return c.redirect(callbackUrl, 302);
});

// ── /oauth/token ────────────────────────────────────────────

oauth.post("/oauth/token", async (c) => {
  setOAuthNoStoreHeaders(c);
  const body = await c.req.parseBody();
  const grant_type = String(body.grant_type ?? "");
  const client_id = String(body.client_id ?? "");
  const resource = requestedResource(body.resource);
  const correlation_id = correlationIdForRequest(c);
  const issuer = oauthIssuerForRequest(c);

  if (!client_id) return oauthProtocolErrorJson(c, "invalid_client", "client_id required.", 400);
  if (!acceptedAudiences().includes(resource)) {
    return oauthProtocolErrorJson(c, "invalid_target", "resource must equal the audience bound at /authorize.", 400);
  }
  if (!grant_type) return oauthProtocolErrorJson(c, "invalid_request", "grant_type required.", 400);

  if (grant_type === "authorization_code") {
    const code = String(body.code ?? "");
    const code_verifier = String(body.code_verifier ?? "");
    const redirect_uri = String(body.redirect_uri ?? "");
    if (!code || !code_verifier || !redirect_uri) {
      return oauthProtocolErrorJson(
        c,
        "invalid_request",
        "code, code_verifier, and redirect_uri are required for authorization_code grant.",
        400,
      );
    }
    // Reject dormant/archived/revoked (and unknown) clients: lookupActiveClient
    // filters status='active', so a lifecycle-aged client cannot mint tokens
    // (recovery is a fresh RFC 7591 re-registration). Checked after request-
    // shape validation to preserve RFC 6749 error precedence.
    if (!(await lookupActiveClient(sql, client_id))) {
      return oauthProtocolErrorJson(c, "invalid_client", "Unknown, dormant, archived, or revoked client_id.", 400);
    }
    let r: Awaited<ReturnType<typeof exchangeAuthCode>>;
    try {
      r = await exchangeAuthCode(sql, {
        raw_code: code,
        client_id,
        redirect_uri,
        resource,
        code_verifier,
      }, {
        auditInside: async (tx, issued) => {
          await insertAudit(tx, {
            event_type: "oauth_token_issue",
            account_id: issued.account_id,
            tenant_id: issued.tenant_id,
            correlation_id,
            actor_label: actorLabelForClient(client_id),
            event_data: {
              client_id,
              grant_family_id: issued.family_id,
              agent_id: issued.agent_id,
              scope: issued.scopes,
              audience: issued.audience,
              iss: issuer,
              expires_in: Math.floor((issued.access_expires_at.getTime() - Date.now()) / 1000),
            },
          });
        },
      });
    } catch (err) {
      logOAuthTokenServerError("authorization_code", err);
      return oauthProtocolErrorJson(
        c,
        "server_error",
        "Token issuance failed before response.",
        500,
      );
    }
    if ("error" in r) {
      return oauthProtocolErrorJson(c, r.error.kind, r.error.message, 400);
    }
    await markOauthClientUsed(client_id);
    return c.json({
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      token_type: "Bearer",
      expires_in: Math.floor((r.access_expires_at.getTime() - Date.now()) / 1000),
      scope: r.scopes.join(" "),
      iss: issuer,
    });
  }

  if (grant_type === "refresh_token") {
    const refresh_token = String(body.refresh_token ?? "");
    if (!refresh_token) {
      return oauthProtocolErrorJson(
        c,
        "invalid_request",
        "refresh_token parameter required for refresh_token grant.",
        400,
      );
    }
    // Reject dormant/archived/revoked (and unknown) clients before refreshing.
    if (!(await lookupActiveClient(sql, client_id))) {
      return oauthProtocolErrorJson(c, "invalid_client", "Unknown, dormant, archived, or revoked client_id.", 400);
    }
    let r: Awaited<ReturnType<typeof rotateRefreshToken>>;
    try {
      r = await rotateRefreshToken(sql, {
        raw_refresh_token: refresh_token,
        client_id,
        resource,
      }, {
        auditInside: async (tx, issued) => {
          await insertAudit(tx, {
            event_type: "oauth_token_refresh",
            account_id: issued.account_id,
            tenant_id: issued.tenant_id,
            correlation_id,
            actor_label: actorLabelForClient(client_id),
            event_data: {
              client_id,
              grant_family_id: issued.family_id,
              agent_id: issued.agent_id,
              scope: issued.scopes,
              audience: issued.audience,
              iss: issuer,
              expires_in: Math.floor((issued.access_expires_at.getTime() - Date.now()) / 1000),
            },
          });
        },
      });
    } catch (err) {
      logOAuthTokenServerError("refresh_token", err);
      return oauthProtocolErrorJson(
        c,
        "server_error",
        "Token refresh failed before response.",
        500,
      );
    }
    if ("error" in r) {
      return oauthProtocolErrorJson(c, r.error.kind, r.error.message, 400);
    }
    await markOauthClientUsed(client_id);
    return c.json({
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      token_type: "Bearer",
      expires_in: Math.floor((r.access_expires_at.getTime() - Date.now()) / 1000),
      scope: r.scopes.join(" "),
      iss: issuer,
    });
  }

  return oauthProtocolErrorJson(
    c,
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token.",
    400,
  );
});

// ── /oauth/revoke (RFC 7009 family-wide) ───────────────────

oauth.post("/oauth/revoke", async (c) => {
  setOAuthNoStoreHeaders(c);
  const body = await c.req.parseBody();
  const token = String(body.token ?? "");
  if (!token) {
    // RFC 7009 §2.2: respond 200 even on missing/unknown
    // tokens. Do NOT leak existence info.
    return c.body(null, 200);
  }
  const correlation_id = correlationIdForRequest(c);
  await sql.begin(async (tx) => {
    // auditInside only fires when the presented token resolved to a family
    // (RFC 7009: unknown tokens stay silent). The audit row commits atomically
    // with the family revoke inside this transaction.
    await revokeByPresentedToken(tx as any, token, "oauth_revoke", {
      auditInside: async (txx, result) => {
        await insertAudit(txx, {
          event_type: "oauth_token_revoke",
          correlation_id,
          actor_label: "oauth_client:revoke",
          event_data: {
            source: "oauth_revoke",
            revoke_reason: "oauth_revoke",
            grant_family_id: result.family_id,
            revoked_count: result.revoked_count,
            client_id: result.client_id,
            agent_id: result.agent_id,
            audience: result.audience,
            scope: result.scopes,
          },
        });
      },
    });
  });
  return c.body(null, 200);
});

// ── /my/connectors (tenant-self) + /admin/connectors (operator) ─

/** Constant-time operator-token check. This gates /admin/connectors (lists
 *  ALL tenants' grants) and /admin/connectors/:id/revoke (family-wide
 *  cross-tenant revoke) — the highest-privilege surface in this file — so the
 *  comparison must not short-circuit on the first mismatching byte (a timing
 *  side-channel that leaks the token byte-by-byte). We SHA-256 both sides and
 *  compare digests with timingSafeEqual, iterating ALL configured tokens
 *  without an early return on a match. */
function isOperatorToken(c: any): boolean {
  const auth = c.req.header("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const presented = m[1].trim();
  if (!presented) return false;
  const presentedDigest = crypto.createHash("sha256").update(presented).digest();
  const operatorTokens = (process.env.VERITY_OPERATOR_TOKENS || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  let matched = false;
  for (const token of operatorTokens) {
    const candidateDigest = crypto.createHash("sha256").update(token).digest();
    // Digests are always 32 bytes, so timingSafeEqual never throws on length.
    if (crypto.timingSafeEqual(presentedDigest, candidateDigest)) {
      matched = true;
    }
  }
  return matched;
}

function renderConnectorList(args: {
  title: string;
  scope: "tenant" | "operator";
  rows: ReadonlyArray<{
    grant_family_id: string;
    client_id: string;
    audience: string;
    issued_at: string;
    last_used_at: string | null;
    tenant_id: string;
    agent_id: string;
  }>;
}): string {
  const rowHtml = args.rows
    .map((r) => {
      const tenantCol =
        args.scope === "operator"
          ? `<td style="padding:.4rem;color:#8a836f">${r.tenant_id}</td>`
          : "";
      return `<tr style="border-top:1px solid #3a3526">
        <td style="padding:.4rem"><code style="font-size:.75rem">${r.grant_family_id.slice(0, 8)}…</code></td>
        <td style="padding:.4rem"><code style="font-size:.75rem">${r.client_id.slice(0, 16)}…</code></td>
        <td style="padding:.4rem">${r.agent_id}</td>
        ${tenantCol}
        <td style="padding:.4rem;color:#8a836f">${r.issued_at}</td>
        <td style="padding:.4rem;color:#8a836f">${r.last_used_at ?? "—"}</td>
        <td style="padding:.4rem">
          <form method="POST" action="${args.scope === "tenant" ? "/my/connectors" : "/admin/connectors"}/${r.grant_family_id}/revoke">
            <button type="submit" style="background:#d97757;color:#021008;border:none;padding:.25rem .6rem;border-radius:4px;cursor:pointer">Revoke</button>
          </form>
        </td>
      </tr>`;
    })
    .join("\n");
  const headTenant = args.scope === "operator" ? "<th>Tenant</th>" : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${args.title}</title>
<style>body{font-family:-apple-system,sans-serif;background:#021008;color:#e8dcc0;max-width:1000px;margin:2rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse}th{text-align:left;padding:.4rem;color:#8a836f;font-weight:500}
.empty{padding:2rem;text-align:center;color:#8a836f}</style></head>
<body><h1>${args.title}</h1>
${args.rows.length === 0
  ? '<div class="empty">No active connector grants.</div>'
  : `<table><thead><tr><th>Family</th><th>Client</th><th>Agent</th>${headTenant}<th>Issued</th><th>Last Used</th><th></th></tr></thead><tbody>${rowHtml}</tbody></table>`}
</body></html>`;
}

oauth.get("/my/connectors", async (c) => {
  const session = await resolveSessionAccount(c);
  if (!session || !session.tenant_id) {
    return c.redirect("/my", 302);
  }
  const rows = await sql`
    SELECT grant_family_id::text AS grant_family_id,
           client_id, audience, agent_id, tenant_id,
           MIN(issued_at)::text AS issued_at,
           MAX(last_used_at)::text AS last_used_at
    FROM oauth_grants
    WHERE account_id = ${session.account_id}::uuid
      AND tenant_id = ${session.tenant_id}
      AND status = 'active'
    GROUP BY grant_family_id, client_id, audience, agent_id, tenant_id
    ORDER BY MAX(issued_at) DESC
  `;
  // Self-protect: these HTML pages live under the /my and /admin prefixes but
  // are served by oauthRoute (mounted at "/"), so they do NOT depend on
  // portal-web's web.use("*") frame-busting middleware — which only wraps them
  // when portal-web happens to register first. Setting the headers here makes
  // clickjacking protection independent of mount/registration order (see the
  // registerVoPlusRoutes extraction, which moves /my + /admin to late
  // registration and would otherwise flip that order).
  setOAuthHtmlSecurityHeaders(c);
  return c.html(
    renderConnectorList({
      title: "Connectors — Your Tenant",
      scope: "tenant",
      rows: rows as any,
    }),
  );
});

oauth.post("/my/connectors/:grant_family_id/revoke", async (c) => {
  const session = await resolveSessionAccount(c);
  if (!session || !session.tenant_id) return c.redirect("/my", 302);
  const family_id = c.req.param("grant_family_id");
  if (!isUuid(family_id)) return c.redirect("/my/connectors", 302);
  // Tenant-scope at the SQL layer: only flip rows in this
  // session's tenant scope. A crafted family_id from another
  // tenant matches no rows.
  const correlation_id = correlationIdForRequest(c);
  await sql.begin(async (tx: any) => {
    // Inline UPDATE (not revokeFamily) because tenant-self revoke MUST stay
    // scoped to this session's account_id + tenant_id; a crafted family_id from
    // another tenant matches no rows. RETURNING captures the forensic
    // dimensions for the audit row in the same statement.
    const rows = await tx`
      UPDATE oauth_grants
      SET status = 'revoked', revoked_reason = 'tenant_self', revoked_at = now()
      WHERE grant_family_id = ${family_id}::uuid
        AND account_id = ${session.account_id}::uuid
        AND tenant_id = ${session.tenant_id}
        AND status NOT IN ('revoked','expired')
      RETURNING client_id, agent_id, audience, scopes
    `;
    if (rows.length > 0) {
      const head = rows[0] as { client_id: string; agent_id: string; audience: string; scopes: string[] };
      await insertAudit(tx, {
        event_type: "oauth_token_revoke",
        account_id: session.account_id,
        tenant_id: session.tenant_id,
        correlation_id,
        actor_label: "tenant_self",
        event_data: {
          source: "my_connectors_revoke",
          revoke_reason: "tenant_self",
          grant_family_id: family_id,
          revoked_count: rows.length,
          client_id: head.client_id,
          agent_id: head.agent_id,
          audience: head.audience,
          scope: head.scopes,
        },
      });
    }
  });
  return c.redirect("/my/connectors", 302);
});

oauth.get("/admin/connectors", async (c) => {
  if (!isOperatorToken(c)) {
    return errorJson(c, "operator_required", { message: "operator_token_required" });
  }
  const rows = await sql`
    SELECT grant_family_id::text AS grant_family_id,
           client_id, audience, agent_id, tenant_id,
           MIN(issued_at)::text AS issued_at,
           MAX(last_used_at)::text AS last_used_at
    FROM oauth_grants
    WHERE status = 'active'
    GROUP BY grant_family_id, client_id, audience, agent_id, tenant_id
    ORDER BY MAX(issued_at) DESC
    LIMIT 200
  `;
  // Self-protect (see /my/connectors above): clickjacking headers must not
  // depend on mount-registration order, which the registerVoPlusRoutes
  // extraction changes.
  setOAuthHtmlSecurityHeaders(c);
  return c.html(
    renderConnectorList({
      title: "Connectors — Operator (All Tenants)",
      scope: "operator",
      rows: rows as any,
    }),
  );
});

oauth.post("/admin/connectors/:grant_family_id/revoke", async (c) => {
  if (!isOperatorToken(c)) {
    return errorJson(c, "operator_required", { message: "operator_token_required" });
  }
  const family_id = c.req.param("grant_family_id");
  if (!isUuid(family_id)) return c.redirect("/admin/connectors", 302);
  const correlation_id = correlationIdForRequest(c);
  await sql.begin(async (tx) => {
    await revokeFamily(tx as any, family_id, "admin", {
      auditInside: async (txx, result) => {
        if (result.revoked_count === 0) return;
        await insertAudit(txx, {
          event_type: "oauth_token_revoke",
          correlation_id,
          actor_label: "operator_token",
          event_data: {
            source: "admin_connectors_revoke",
            revoke_reason: "admin",
            grant_family_id: family_id,
            revoked_count: result.revoked_count,
            client_id: result.client_id,
            agent_id: result.agent_id,
            audience: result.audience,
            scope: result.scopes,
          },
        });
      },
    });
  });
  return c.redirect("/admin/connectors", 302);
});

// ── Test-only fixture protected resource ───────────────────
//
// Drift guard #5 + #10: the route is registered ONLY when both
// env keys are present at module-evaluation time. In production
// (or any env where either key is absent) the route never
// mounts and requests return the normal app-level 404.

if (isTestFixturesEnabled()) {
  oauth.get("/oauth/test-resource", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/);
    const bearer = m?.[1] ?? null;
    const r = await resolveConnectorAccessTokenForResource(
      sql,
      bearer,
      TEST_FIXTURE_RESOURCE,
    );
    if ("error" in r) {
      return errorJson(c, "unauthorized", { message: r.error as unknown as string });
    }
    return c.json({
      ok: true,
      resource: TEST_FIXTURE_RESOURCE,
      tenant_id: r.agent.tenant_id,
      agent_id: r.agent.agent_id,
      credential_id: r.agent.credential_id,
    });
  });
}

export default oauth;
