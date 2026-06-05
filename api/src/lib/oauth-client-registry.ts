/**
 * OAuth client registry — RFC 7591 Dynamic Client Registration + RFC 8252
 * native-app loopback redirect handling. Public-client posture only.
 *
 *   - redirect_uris MUST be a non-empty array. Each URI must be either:
 *       * an https://... URI with no fragment, no query, no wildcard host; OR
 *       * a loopback http URI (http://localhost, http://127.0.0.1, http://[::1])
 *         per RFC 8252 §7.3 when `application_type` is "native". For loopback
 *         URIs the port is dynamic — the registration stores the URI as
 *         submitted, and /oauth/authorize matches scheme + host + path only
 *         (port may differ at runtime).
 *     Non-loopback http://, fragments, queries, wildcards, and unknown
 *     schemes reject.
 *   - token_endpoint_auth_method MUST be omitted or "none" (public client).
 *     Any client_secret/client_secret_jwt/private_key_jwt submission rejects.
 *   - scope canonicalizes to either ["vo.read"] or ["vo.read","vo.write.intent"].
 *     Omitted scope defaults to least-privilege ["vo.read"]; `vo.write.intent`
 *     never stands alone.
 *   - grant_types MUST contain "authorization_code"; "refresh_token" is
 *     optional. Any grant type outside that pair rejects.
 *   - client_name is optional DCR display metadata. When supplied it is
 *     normalized for consent UX, but remains explicitly unverified.
 *   - Re-registration with identical body still mints a NEW client_id
 *     (RFC 7591 §3.2). No find-or-create.
 *
 * The validator is a pure function (unit-testable without DB). The inserter
 * uses the validator's canonical output verbatim, so the SQL-side CHECK
 * constraints in `db/oauth-clients.sql` are belt-and-braces.
 */

import crypto from "node:crypto";
import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

/** Legacy export — preserved for tests + drift fixtures that reference the
 *  canonical Claude MCP connector URI. The validator no longer hard-pins
 *  redirect_uris to this value; both Claude and any RFC-7591/8252-compliant
 *  client (Codex desktop, etc.) can register. */
export const CLAUDE_MCP_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
/** @deprecated kept for back-compat with tests/imports; use CLAUDE_MCP_REDIRECT_URI. */
export const REQUIRED_REDIRECT_URI = CLAUDE_MCP_REDIRECT_URI;
/** The set of grant_types this server supports. authorization_code is
 *  mandatory in every registration; refresh_token is optional. */
export const SUPPORTED_GRANT_TYPES: readonly ["authorization_code", "refresh_token"] = [
  "authorization_code",
  "refresh_token",
];
export const REQUIRED_GRANT_TYPE = "authorization_code" as const;
/** @deprecated retained name; now represents the canonical supported set, not a
 *  mandatory exact-match. Tests historically used this as the happy-body grant
 *  list; that pair still validates. */
export const REQUIRED_GRANT_TYPES: readonly string[] = SUPPORTED_GRANT_TYPES;
export const CONNECTOR_READ_SCOPE = "vo.read";
export const CONNECTOR_WRITE_INTENT_SCOPE = "vo.write.intent";
export const REQUIRED_SCOPES: readonly [typeof CONNECTOR_READ_SCOPE] = [CONNECTOR_READ_SCOPE];
export const CONNECTOR_WRITE_INTENT_SCOPES: readonly [
  typeof CONNECTOR_READ_SCOPE,
  typeof CONNECTOR_WRITE_INTENT_SCOPE,
] = [CONNECTOR_READ_SCOPE, CONNECTOR_WRITE_INTENT_SCOPE];
export const ALLOWED_CONNECTOR_SCOPES: readonly [
  typeof CONNECTOR_READ_SCOPE,
  typeof CONNECTOR_WRITE_INTENT_SCOPE,
] = CONNECTOR_WRITE_INTENT_SCOPES;
export const REQUIRED_TOKEN_AUTH_METHOD = "none";

export type ConnectorScope = (typeof ALLOWED_CONNECTOR_SCOPES)[number];
export type ConnectorScopeSet =
  | readonly [typeof CONNECTOR_READ_SCOPE]
  | readonly [typeof CONNECTOR_READ_SCOPE, typeof CONNECTOR_WRITE_INTENT_SCOPE];

/** Validated DCR request. The shape stored in `oauth_clients`
 *  matches this exactly (canonical-arrays so the SQL CHECK
 *  constraints pass deterministically). */
export interface ValidatedDcrRequest {
  client_name: string | null;
  redirect_uris: readonly string[];
  grant_types: readonly string[];
  scopes: ConnectorScopeSet;
  token_endpoint_auth_method: "none";
}

type RedirectUriClassification =
  | { ok: true; kind: "https" | "loopback"; canonical: string }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Classify a redirect URI per RFC 7591 + RFC 8252 §7.3. Pure function. */
export function classifyRedirectUri(raw: unknown): RedirectUriClassification {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "redirect_uris[] entries must be non-empty strings." };
  }
  if (raw.includes("#")) {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} must not contain a fragment.` };
  }
  if (raw.includes("?")) {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} must not contain a query string.` };
  }
  if (raw.includes("*")) {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} must not contain a wildcard.` };
  }
  if (raw !== raw.trim()) {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} must not contain leading/trailing whitespace.` };
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} is not a valid absolute URL.` };
  }
  // Scheme must be lowercase per RFC 3986 §3.1 + RFC 8252 §7.3 requires the
  // submitted form. Reject case-shifted schemes ("HTTPS://...") explicitly.
  const schemeStartsAt = raw.indexOf(":");
  const rawScheme = schemeStartsAt > 0 ? raw.slice(0, schemeStartsAt) : "";
  if (rawScheme !== rawScheme.toLowerCase()) {
    return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} scheme must be lowercase.` };
  }
  if (parsed.protocol === "https:") {
    return { ok: true, kind: "https", canonical: raw };
  }
  if (parsed.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} must use https or be a loopback URI.` };
    }
    return { ok: true, kind: "loopback", canonical: raw };
  }
  return { ok: false, reason: `redirect_uri ${JSON.stringify(raw)} scheme must be https or http (loopback only).` };
}

/** Per RFC 8252 §7.3, loopback URIs match scheme + host + path; the port is
 *  dynamic and may differ between registration and the live authorize call.
 *  https URIs require exact match. Used by /oauth/authorize. */
export function redirectUriMatches(submitted: string, registered: string): boolean {
  if (submitted === registered) return true;
  let s: URL, r: URL;
  try { s = new URL(submitted); r = new URL(registered); } catch { return false; }
  if (s.protocol !== "http:" || r.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(s.hostname) || !LOOPBACK_HOSTS.has(r.hostname)) return false;
  return s.hostname === r.hostname && s.pathname === r.pathname;
}

export type DcrValidationError =
  | { kind: "invalid_redirect_uri"; message: string }
  | { kind: "invalid_client_metadata"; field: string; message: string }
  | { kind: "invalid_client_secret_submission"; message: string };

export type DcrValidationResult =
  | { ok: true; req: ValidatedDcrRequest }
  | { ok: false; error: DcrValidationError };

/** Canonicalize a raw `scope` field. RFC 7591 §2 says scope is
 *  a space-separated string; clients that send it as an array
 *  also need to be tolerated (some libraries do this). Returns
 *  the canonical sorted array OR null if the shape is wrong. */
function rawScopeParts(raw: unknown, defaultScopes: ConnectorScopeSet | null): readonly string[] | null {
  if (raw === undefined || raw === null) {
    return defaultScopes;
  }
  if (typeof raw === "string") {
    const parts = raw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts;
  }
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return raw as readonly string[];
  }
  return null;
}

export function canonicalizeConnectorScopes(
  raw: unknown,
  opts: { defaultToRead?: boolean; defaultToFull?: boolean } = {},
): ConnectorScopeSet | null {
  const defaultScopes = opts.defaultToFull === true
    ? CONNECTOR_WRITE_INTENT_SCOPES
    : opts.defaultToRead === true
      ? REQUIRED_SCOPES
      : null;
  const parts = rawScopeParts(raw, defaultScopes);
  if (parts === null || parts.length === 0) return null;
  const unique = new Set(parts);
  if (unique.size !== parts.length) return null;
  for (const scope of unique) {
    if (!(ALLOWED_CONNECTOR_SCOPES as readonly string[]).includes(scope)) {
      return null;
    }
  }
  if (!unique.has(CONNECTOR_READ_SCOPE)) return null;
  if (unique.has(CONNECTOR_WRITE_INTENT_SCOPE)) {
    return CONNECTOR_WRITE_INTENT_SCOPES;
  }
  return REQUIRED_SCOPES;
}

function isAbsentOrEmptyScope(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  return typeof raw === "string" && raw.trim().length === 0;
}

export function resolveRequestedConnectorScopes(
  raw: unknown,
  registeredScopes: readonly string[],
): ConnectorScopeSet | null {
  const registered = canonicalizeConnectorScopes(registeredScopes);
  if (!registered) return null;
  if (isAbsentOrEmptyScope(raw)) return registered;

  const requested = canonicalizeConnectorScopes(raw);
  if (!requested) return null;

  const narrowed = requested.filter((scope) => (registered as readonly string[]).includes(scope));
  return canonicalizeConnectorScopes(narrowed);
}

export function connectorScopesIncludeWriteIntent(scopes: readonly string[]): boolean {
  return scopes.includes(CONNECTOR_WRITE_INTENT_SCOPE);
}

function canonicalizeGrantTypes(raw: unknown): readonly string[] | null {
  if (raw === undefined || raw === null) {
    // RFC 7591 §2: when grant_types is omitted, the default is
    // ["authorization_code"]. We honor that — refresh_token is optional.
    return [REQUIRED_GRANT_TYPE];
  }
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return null;
  if (raw.length === 0) return null;
  const seen = new Set<string>();
  for (const gt of raw as string[]) {
    if (seen.has(gt)) return null;
    seen.add(gt);
  }
  return raw as readonly string[];
}

function canonicalizeClientName(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return false;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  if (normalized.length > 120) return false;
  return normalized;
}

/**
 * Validate a DCR registration request. Pure function — no DB,
 * no side effects. Returns the canonicalized output on success
 * or a structured error on rejection.
 *
 * Caller is expected to pass the parsed JSON body verbatim.
 */
export function validateDcrRequest(raw: unknown): DcrValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "body",
        message: "Request body must be a JSON object.",
      },
    };
  }

  const body = raw as Record<string, unknown>;

  const client_name = canonicalizeClientName(body.client_name);
  if (client_name === false) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "client_name",
        message: "client_name must be a string from 1 to 120 characters with no control characters.",
      },
    };
  }

  const applicationType = body.application_type;
  if (
    applicationType !== undefined &&
    applicationType !== "web" &&
    applicationType !== "native"
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "application_type",
        message: "application_type must be omitted, 'web', or 'native'.",
      },
    };
  }

  // Public-client posture: any client_secret submission rejects.
  if (
    body.client_secret !== undefined ||
    body.client_secret_jwt !== undefined ||
    body.private_key_jwt !== undefined
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_secret_submission",
        message:
          "Public-client only — client secrets are not accepted in this slice.",
      },
    };
  }

  // token_endpoint_auth_method: omitted OR "none". Any other
  // value (including "client_secret_basic", "client_secret_post",
  // "private_key_jwt") rejects.
  const authMethod = body.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== REQUIRED_TOKEN_AUTH_METHOD) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "token_endpoint_auth_method",
        message:
          "token_endpoint_auth_method must be omitted or 'none' (public clients only).",
      },
    };
  }

  // redirect_uris: REQUIRED, non-empty array of unique https:// or loopback
  // http URIs (RFC 7591 §2 + RFC 8252 §7.3). Fragments, queries, wildcards,
  // non-loopback http, and case-shifted schemes reject.
  const rawUris = body.redirect_uris;
  if (rawUris === undefined || rawUris === null) {
    return { ok: false, error: { kind: "invalid_redirect_uri", message: "redirect_uris is required." } };
  }
  if (!Array.isArray(rawUris)) {
    return { ok: false, error: { kind: "invalid_redirect_uri", message: "redirect_uris must be an array." } };
  }
  if (rawUris.length === 0) {
    return { ok: false, error: { kind: "invalid_redirect_uri", message: "redirect_uris must contain at least 1 entry." } };
  }
  const canonical_redirect_uris: string[] = [];
  let has_loopback_redirect_uri = false;
  for (const raw of rawUris) {
    const classified = classifyRedirectUri(raw);
    if (!classified.ok) {
      return { ok: false, error: { kind: "invalid_redirect_uri", message: classified.reason } };
    }
    if (classified.kind === "loopback") {
      has_loopback_redirect_uri = true;
    }
    if (canonical_redirect_uris.includes(classified.canonical)) {
      return { ok: false, error: { kind: "invalid_redirect_uri", message: `redirect_uris must not repeat: ${JSON.stringify(classified.canonical)}.` } };
    }
    canonical_redirect_uris.push(classified.canonical);
  }
  if (has_loopback_redirect_uri && applicationType !== "native") {
    return {
      ok: false,
      error: {
        kind: "invalid_redirect_uri",
        message:
          "loopback http redirect_uris require application_type 'native'. Browser/web clients must use https redirect_uris.",
      },
    };
  }

  // grant_types: canonicalize, require authorization_code, allow optional
  // refresh_token, reject anything else.
  const gts = canonicalizeGrantTypes(body.grant_types);
  if (gts === null) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "grant_types",
        message: "grant_types must be a non-empty array of unique strings.",
      },
    };
  }
  for (const gt of gts) {
    if (gt !== "authorization_code" && gt !== "refresh_token") {
      return {
        ok: false,
        error: {
          kind: "invalid_client_metadata",
          field: "grant_types",
          message: `grant_types entry ${JSON.stringify(gt)} is not supported (allowed: 'authorization_code', 'refresh_token').`,
        },
      };
    }
  }
  if (!gts.includes(REQUIRED_GRANT_TYPE)) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "grant_types",
        message: "grant_types must include 'authorization_code'.",
      },
    };
  }
  const canonical_grant_types: string[] = gts.includes("refresh_token")
    ? ["authorization_code", "refresh_token"]
    : ["authorization_code"];

  // scopes: canonicalize to the narrow connector scope sets. RFC 7591 clients
  // may omit scope; for this connector, omission means least-privilege
  // read-only access. `vo.write.intent` is accepted only when paired with
  // `vo.read`; write-only, unknown, duplicate, or admin scopes fail before
  // anything is stored.
  const scopes = canonicalizeConnectorScopes(body.scope ?? body.scopes, {
    defaultToRead: true,
  });
  if (scopes === null) {
    return {
      ok: false,
      error: {
        kind: "invalid_client_metadata",
        field: "scope",
        message: "scope must be 'vo.read' or 'vo.read vo.write.intent'.",
      },
    };
  }

  // Canonical output — feeds the SQL CHECK constraints in oauth-clients.sql
  // (redirect_uris non-empty; grant_types subset of allowed + includes
  // authorization_code; scopes canonical).
  return {
    ok: true,
    req: {
      client_name,
      redirect_uris: canonical_redirect_uris,
      grant_types: canonical_grant_types,
      scopes,
      token_endpoint_auth_method: "none" as const,
    },
  };
}

/** Synthesize an opaque client_id. RFC 7591 doesn't constrain
 *  the format; we use a `vocc_*` prefix (vo-connector-client) so
 *  log scanners + audit attribution can identify it at a glance.
 *  44 chars of base64url. */
export function newClientId(): string {
  return `vocc_${crypto.randomBytes(32).toString("base64url")}`;
}

export interface OauthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  scopes: string[];
  token_endpoint_auth_method: string;
  registered_at: Date;
  status: "active" | "dormant" | "archived" | "revoked";
  last_used_at: Date | null;
}

export interface RegisterClientHooks {
  /**
   * Runs as the last statement inside the registration, with the same db/tx
   * handle the INSERT used, so the audit row commits or rolls back atomically
   * with the oauth_clients insert. If it throws, the registration rolls back.
   */
  auditInside?: (tx: SqlTag, row: OauthClientRow) => Promise<void>;
}

/**
 * Insert a new client. ALWAYS mints a fresh `client_id` even
 * when the request body matches a prior registration verbatim
 * (RFC 7591 §3.2 + drift guard #20). client_secret_hash is
 * always NULL in 11a (public-client posture; drift guard #19
 * pins this).
 */
export async function registerClient(
  sql: SqlTag,
  req: ValidatedDcrRequest,
  hooks: RegisterClientHooks = {},
): Promise<OauthClientRow> {
  const client_id = newClientId();
  const [row] = await sql`
    INSERT INTO oauth_clients (
      client_id,
      client_secret_hash,
      client_name,
      redirect_uris,
      grant_types,
      scopes,
      token_endpoint_auth_method,
      status
    )
    VALUES (
      ${client_id},
      ${null},
      ${req.client_name},
      ${req.redirect_uris as unknown as string[]},
      ${req.grant_types as unknown as string[]},
      ${req.scopes as unknown as string[]},
      ${req.token_endpoint_auth_method},
      'active'
    )
    RETURNING *
  `;
  const client = row as unknown as OauthClientRow;
  if (hooks.auditInside) await hooks.auditInside(sql, client);
  return client;
}

export async function lookupActiveClient(
  sql: SqlTag,
  client_id: string,
): Promise<OauthClientRow | null> {
  const [row] = await sql`
    SELECT *
    FROM oauth_clients
    WHERE client_id = ${client_id}
      AND status = 'active'
  `;
  return (row as unknown as OauthClientRow) ?? null;
}
