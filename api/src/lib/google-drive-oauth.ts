import crypto from "node:crypto";
import type postgres from "postgres";
import { loadGoogleOAuthConfig, type GoogleOAuthConfig } from "./google-oauth";
import { loadSodium } from "./load-sodium";

type SqlTag = ReturnType<typeof postgres>;

// Identity scopes + the per-app drive.file scope. Google often returns the
// canonical userinfo.email / userinfo.profile URLs alongside (or instead of) the
// short email/profile forms — accept both. Neither userinfo.* form is a Drive
// scope; drive.file stays the ONLY Drive grant permitted.
export const DRIVE_SCOPE_ALLOWLIST = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/drive.file"]);
export const DRIVE_SCOPE = "openid email profile https://www.googleapis.com/auth/drive.file";
export const DRIVE_PENDING_TTL_MS = 10 * 60 * 1000;
export const DRIVE_CODE_TTL_MS = 90 * 1000;

export function driveGrantHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomDriveToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function loadGoogleDriveOAuthConfig(): GoogleOAuthConfig {
  const base = loadGoogleOAuthConfig();
  const redirectUri = (process.env.GOOGLE_DRIVE_REDIRECT_URI || "").trim()
    || base.redirectUri.replace("/account/auth/google/callback", "/account/drive/google/callback");
  return { ...base, redirectUri };
}

export function buildDriveConsentUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent select_account",
    // NO include_granted_scopes: a Drive connect must mint a MINIMAL token scoped
    // to exactly this request (identity + drive.file). With incremental auth on,
    // Google unions in every scope the account ever granted this client — which on
    // a developer/long-lived account can include broad scopes from past testing,
    // tripping verifyDriveScopeAllowlist ("scope_too_broad") on a perfectly valid
    // narrow consent. Omitting it keeps the issued token tight.
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function buildHostedDriveConsentUrl(baseUrl: string, grantId: string): string {
  const url = new URL("/account/drive/consent", baseUrl);
  url.searchParams.set("grant_id", grantId);
  return url.toString();
}

export function parseGrantedScopes(scope: string | undefined | null): Set<string> {
  return new Set(String(scope || "").split(/\s+/).filter(Boolean));
}

export function verifyDriveScopeAllowlist(scope: string | undefined | null): boolean {
  const scopes = parseGrantedScopes(scope);
  if (!scopes.has("https://www.googleapis.com/auth/drive.file")) return false;
  for (const s of scopes) {
    if (!DRIVE_SCOPE_ALLOWLIST.has(s)) return false;
  }
  return true;
}

export async function exchangeDriveCodeForTokens(
  config: GoogleOAuthConfig,
  code: string,
): Promise<Record<string, unknown>> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code,
    }).toString(),
  });
  if (!tokenRes.ok) {
    await tokenRes.text().catch(() => "");
    throw new Error(`Google Drive token exchange failed (${tokenRes.status})`);
  }
  const tokenResponse = (await tokenRes.json()) as Record<string, unknown>;
  const accessToken = typeof tokenResponse.access_token === "string" ? tokenResponse.access_token : "";
  if (!accessToken) throw new Error("Google Drive token exchange returned no access_token");
  if (typeof tokenResponse.refresh_token !== "string" || !tokenResponse.refresh_token) {
    throw new Error("Google Drive token exchange returned no refresh_token");
  }
  const expiresIn = Number(tokenResponse.expires_in);
  return {
    ...tokenResponse,
    expiry_date: Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + Math.floor(expiresIn * 1000)
      : undefined,
  };
}

export async function fetchDriveUserInfo(
  tokenResponse: Record<string, unknown>,
): Promise<{ sub: string; email: string; name: string }> {
  // JS cannot reliably zero token strings after use. The hosted callback seals
  // this token response before calling userinfo so no audit/log/DB await runs
  // in the plaintext window between exchange and sealed-box encryption.
  const accessToken = typeof tokenResponse.access_token === "string" ? tokenResponse.access_token : "";
  if (!accessToken) throw new Error("Google Drive token response has no access_token");
  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) throw new Error(`Google Drive userinfo failed (${userRes.status})`);
  const profile = (await userRes.json()) as Record<string, unknown>;
  if (profile.email_verified !== true) throw new Error("Google email is not verified");
  return {
    sub: String(profile.sub || ""),
    email: String(profile.email || ""),
    name: String(profile.name || ""),
  };
}

export async function revokeGoogleDriveTokenResponse(
  tokenResponse: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const token = typeof tokenResponse.refresh_token === "string" && tokenResponse.refresh_token
    ? tokenResponse.refresh_token
    : typeof tokenResponse.access_token === "string" && tokenResponse.access_token
      ? tokenResponse.access_token
      : "";
  if (!token) return false;
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  if (!res.ok) throw new Error(`Google Drive token revoke failed (${res.status})`);
  return true;
}

export async function revokeLocalDriveTokenIfPresent(options: { timeoutMs?: number } = {}): Promise<boolean> {
  const { readLocalDriveMirrorState, readLocalDriveTokenJson } = await import("./google-drive-state");
  const tokenJson = readLocalDriveTokenJson(readLocalDriveMirrorState());
  if (!tokenJson) return false;
  const tokenResponse = JSON.parse(tokenJson) as Record<string, unknown>;
  return revokeGoogleDriveTokenResponse(tokenResponse, options);
}

export async function sealDriveTokenBlob(input: {
  publicKey: Uint8Array;
  grantId: string;
  tokenResponse: Record<string, unknown>;
}): Promise<Uint8Array> {
  const sodium = await loadSodium();
  const plaintext = new TextEncoder().encode(JSON.stringify({
    grant_id: input.grantId,
    token_response: input.tokenResponse,
  }));
  return sodium.crypto_box_seal(plaintext, input.publicKey);
}

export async function openDriveTokenBlob(input: {
  ciphertext: Uint8Array;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  grantId: string;
}): Promise<Record<string, unknown>> {
  const sodium = await loadSodium();
  const opened = sodium.crypto_box_seal_open(input.ciphertext, input.publicKey, input.privateKey);
  if (!opened) throw new Error("drive_token_decrypt_failed");
  const parsed = JSON.parse(new TextDecoder().decode(opened)) as Record<string, unknown>;
  if (parsed.grant_id !== input.grantId || !parsed.token_response || typeof parsed.token_response !== "object") {
    throw new Error("drive_token_grant_mismatch");
  }
  return parsed.token_response as Record<string, unknown>;
}

export async function expireHostedDriveConnectGrants(sql: SqlTag): Promise<number> {
  const res = await sql`
    UPDATE hosted_drive_connect_grants
    SET status = 'expired', encrypted_token_blob = NULL, updated_at = now()
    WHERE status IN ('pending', 'ready_for_redeem')
      AND (
        expires_at <= now()
        OR (code_expires_at IS NOT NULL AND code_expires_at <= now())
      )
  `;
  return res.count;
}

export async function claimDriveMirrorPrimary(
  tx: SqlTag,
  input: { accountId: string; tenantId: string; nodeId: string },
): Promise<"claimed" | "already_primary" | "other_primary"> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('vo_drive_primary'), hashtext(${input.tenantId}))`;
  const [existing] = await tx`
    SELECT node_id
    FROM hosted_nodes
    WHERE tenant_id = ${input.tenantId}
      AND status = 'active'
      AND drive_mirror_primary_at IS NOT NULL
    LIMIT 1
  `;
  if (existing?.node_id === input.nodeId) return "already_primary";
  if (existing?.node_id) return "other_primary";
  try {
    const updated = await tx`
      UPDATE hosted_nodes
      SET drive_mirror_primary_at = now(), updated_at = now()
      WHERE account_id = ${input.accountId}::uuid
        AND tenant_id = ${input.tenantId}
        AND node_id = ${input.nodeId}
        AND status = 'active'
        AND drive_mirror_primary_at IS NULL
    `;
    return updated.count === 1 ? "claimed" : "other_primary";
  } catch (e) {
    if ((e as any)?.code === "23505") return "other_primary";
    throw e;
  }
}
