/**
 * Dashboard hosted-cookie rejection middleware —
 * VO-LOCAL-DASHBOARD-GOOGLE-LINK-PR-1 (rung 1 UI).
 *
 * Rung 1 non-negotiable (federation ladder boundary): a
 * hosted `vo_session` cookie must NEVER authenticate a
 * request against any `/dashboard/*` route. The local
 * dashboard uses tenant tokens / operator tokens via
 * `resolveDashboardTenant`; a hosted session is for
 * `/account/*`, `/my/*`, and `/portal/*` only.
 *
 * Today that guarantee is implicit — the dashboard
 * handlers never call resolveHostedSession. This
 * middleware makes it explicit by rejecting any request
 * to `/dashboard/*` that carries a vo_session cookie, so
 * a future handler that accidentally reads the cookie
 * cannot quietly widen the auth surface.
 *
 * The env flag `VERITY_DASHBOARD_COOKIE_GUARD=off`
 * disables the middleware for incident rollback without
 * requiring a code change.
 */

import type { Context, Next } from "hono";
import { errorJson } from "./error-envelope";

export const DASHBOARD_COOKIE_GUARD_FLAG = "VERITY_DASHBOARD_COOKIE_GUARD";

export async function rejectHostedSessionCookieOnDashboard(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (process.env[DASHBOARD_COOKIE_GUARD_FLAG] === "off") {
    await next();
    return;
  }
  const cookie = c.req.header("Cookie") || "";
  if (/(?:^|;\s*)vo_session=/.test(cookie)) {
    return errorJson(c, "forbidden", {
      message: "Hosted sessions cannot access local dashboard routes.",
      hint: "Use the operator token or a tenant token for /dashboard/*.",
    });
  }
  await next();
}
