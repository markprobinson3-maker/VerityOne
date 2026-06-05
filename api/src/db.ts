/**
 * Shared DB handles for the Hono app.
 *
 * Pool config + connection-string resolution live in
 * `./lib/db-config.ts` (rung F3). This file just selects the right
 * pool factory for the active deployment profile and exposes the
 * long-lived-only LISTEN/NOTIFY handle.
 *
 * Importing this file MUST NOT issue an asynchronous query or call
 * `process.exit(...)`. The startup probe is exposed as
 * `probeDatabaseConnection()` so the long-lived launcher can opt in
 * while serverless cold-starts stay side-effect free.
 */

import {
  createDirectSql,
  createPooledSql,
  getDeploymentProfile,
} from "./lib/db-config";

const PROFILE = getDeploymentProfile();

export const sql =
  PROFILE === "serverless" ? createPooledSql() : createDirectSql();

// LISTEN/NOTIFY is long-lived only. Neon's serverless connection
// pooler does not support session-scoped LISTEN. Serverless callers
// must not import this; they should poll `change_stream` instead.
export const listenSql =
  PROFILE === "long-lived" ? createDirectSql({ max: 1 }) : null;

// ── Startup connection probe ────────────────────────────────
//
// Two modes (preserved from the pre-F3 shape):
//
//   1. Default (unset or anything other than "on"): log the result
//      but do NOT exit. A local operator whose Postgres is not yet
//      running can still boot the API — routes that touch the DB
//      will throw at query time with an HTTP-surfaceable error;
//      routes that do not (setup wizard, static assets, docs) stay
//      usable. Matches the rest of the VO runtime's "degrade, don't
//      crash" posture.
//
//   2. `VERITY_DB_STRICT=on`: preserve the original fail-fast
//      behavior. Intended for production container deploys where
//      the orchestrator's health-check should restart the pod until
//      Postgres is reachable. Explicit opt-in so local tenants
//      don't inherit it by accident. Serverless cold starts must
//      NOT call this — Vercel function failures should surface as
//      request errors, not import-time `process.exit(...)`.
//
// postgres.js auto-reconnects on runtime drops regardless of this
// flag — it only controls the boot-time behavior.
export async function probeDatabaseConnection(): Promise<void> {
  try {
    await sql`SELECT 1`;
    console.log("✅ Database connected");
  } catch (err: any) {
    console.error("❌ Database connection failed:", err?.message ?? err);
    if (process.env.VERITY_DB_STRICT === "on") {
      console.error("   VERITY_DB_STRICT=on — exiting.");
      process.exit(1);
    }
    console.error(
      "   VERITY_DB_STRICT unset — API continues in degraded mode.",
    );
    console.error(
      "   Routes touching the DB will error; restart once Postgres is reachable.",
    );
  }
}
