/**
 * Google OAuth 2.0 helper — authorization code flow.
 *
 * Isolated from the rest of the app so it can be mocked/tested
 * without calling Google. The only external dependency is fetch().
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI   (e.g., https://verityone.app/account/auth/google/callback)
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleUserInfo {
  sub: string;       // Google subject ID (stable, unique per user)
  email: string;
  name: string;
  picture?: string;
}

export class GoogleOAuthConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Google OAuth is not configured. Missing env vars: ${missing.join(", ")}. ` +
      `Set these in .env or the environment to enable VO+ account login.`,
    );
    this.name = "GoogleOAuthConfigError";
  }
}

export function loadGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI || "").trim();

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!redirectUri) missing.push("GOOGLE_REDIRECT_URI");

  if (missing.length > 0) throw new GoogleOAuthConfigError(missing);

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Google authorization URL for the consent screen.
 */
export function buildAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an authorization code for Google tokens + user info.
 */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<GoogleUserInfo> {
  // Exchange code for tokens
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
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${body.slice(0, 200)}`);
  }

  const tokens = (await tokenRes.json()) as { access_token?: string; id_token?: string };
  if (!tokens.access_token) {
    throw new Error("Google token exchange returned no access_token");
  }

  // Fetch user info
  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`Google userinfo failed (${userRes.status})`);
  }

  const profile = (await userRes.json()) as Record<string, unknown>;
  const sub = String(profile.sub || "").trim();
  const email = String(profile.email || "").trim();
  const name = String(profile.name || "").trim();

  if (!sub || !email) {
    throw new Error("Google profile missing sub or email");
  }

  // The design says the hosted account stores a "Google-verified email."
  // Google's userinfo response includes `email_verified: true/false`.
  // Reject unverified emails so the canonical account address is always
  // one Google has confirmed the user controls.
  if (profile.email_verified !== true) {
    throw new Error("Google email is not verified. Only verified Google emails can create VO+ accounts.");
  }

  return { sub, email, name, picture: profile.picture as string | undefined };
}
