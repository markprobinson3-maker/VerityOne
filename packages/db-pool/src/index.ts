/**
 * Server-only DB-pool + deployment-profile package (`@verity-one/db-pool`).
 *
 * F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) extracted this surface
 * from `api/src/lib/db-config.ts` so cross-workspace callers under
 * `scripts/`, `miners/`, and `api/scripts/` can import via the package
 * boundary instead of reaching into API-private source. F3 first
 * established the deployment-profile contract; F5 only changed the
 * package address, not the contract.
 *
 * The package owns:
 *
 *   1. The canonical `DATABASE_URL` resolution contract — env first,
 *      `postgresql://localhost:5432/verity` fallback, `.trim()` to
 *      defuse paste-time whitespace bugs in managed-DB connection
 *      strings (Neon, Supabase, etc.).
 *
 *   2. The `VERITY_DEPLOYMENT_PROFILE` env-flag with two values:
 *        - `long-lived` (default) — the existing local Bun server.
 *        - `serverless`           — Vercel functions + Neon. Smaller
 *          pool, `prepare: false` for PgBouncer transaction-mode
 *          pooling, no LISTEN/NOTIFY consumers, no startup probes
 *          that call `process.exit(...)`.
 *
 *      This is INTENTIONALLY separate from the existing VO runtime
 *      profile resolver in `api/src/lib/runtime-profile.ts`, which
 *      carries the `tenant-default | full` axis and reads
 *      `VERITY_PROFILE`. The two axes are orthogonal: a `long-lived`
 *      Bun server can serve either runtime profile; a `serverless`
 *      Vercel function should only ever serve `tenant-default`.
 *
 *   3. Pool factories for both profiles. Callers should NOT call
 *      `postgres(...)` directly — go through `createPooledSql` /
 *      `createDirectSql` so connection-string resolution and
 *      profile-appropriate defaults stay in one place.
 *
 *   4. `requireLongLivedDeploymentProfile(operation)` — the
 *      result-shaped denial used by the 5 operator rotation
 *      entrypoints (TDK rotation + 4 security-mode transitions).
 *      Those flows hold session-scoped advisory locks across multi-
 *      batch work with partial-progress recovery; they MUST NOT run
 *      from a serverless function that can vanish mid-transaction.
 *      The guard returns a value instead of throwing so existing
 *      `{ ok: false, error }` route handlers stay the same.
 *
 * Browser-safety: this package imports `postgres` directly. It MUST
 * NOT be imported from `scope/src/`. The F5 drift surface enforces
 * this via static guard.
 */

import postgres from "postgres";

export function getDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  return configured || "postgresql://localhost:5432/verity";
}

export type DeploymentProfile = "serverless" | "long-lived";

let cachedProfile: DeploymentProfile | undefined;

export function getDeploymentProfile(): DeploymentProfile {
  if (cachedProfile) return cachedProfile;
  const raw = (process.env.VERITY_DEPLOYMENT_PROFILE || "long-lived").trim();
  if (raw !== "serverless" && raw !== "long-lived") {
    throw new Error(
      `VERITY_DEPLOYMENT_PROFILE must be "serverless" or "long-lived" ` +
        `(got: ${JSON.stringify(raw)})`,
    );
  }
  cachedProfile = raw;
  return cachedProfile;
}

export function requireLongLivedDeploymentProfile(
  operation: string,
): { ok: true } | { ok: false; error: string } {
  if (getDeploymentProfile() === "long-lived") return { ok: true };
  return {
    ok: false,
    error:
      `${operation} requires VERITY_DEPLOYMENT_PROFILE=long-lived. ` +
      `This operator rotation flow uses a reserved PostgreSQL session lock ` +
      `and is intentionally disabled in serverless functions.`,
  };
}

// Test-only: reset the cached profile so repeated `getDeploymentProfile()`
// calls inside a single bun-test process can observe env-var changes.
// Production callers should never need this.
export function __resetCachedDeploymentProfileForTests(): void {
  cachedProfile = undefined;
}

export function createPooledSql(
  extra: postgres.Options<{}> = {},
): postgres.Sql<{}> {
  return postgres(getDatabaseUrl(), {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
    ...extra,
  });
}

export function createDirectSql(
  extra: postgres.Options<{}> = {},
  dsn?: string,
): postgres.Sql<{}> {
  // `dsn` lets a caller target a specific database WITHOUT mutating the global
  // DATABASE_URL (which would leak to spawned children). Optional + second so all
  // existing `createDirectSql()` / `createDirectSql({extra})` callers are unchanged.
  return postgres(dsn?.trim() || getDatabaseUrl(), {
    max: 40,
    idle_timeout: 20,
    connect_timeout: 10,
    ...extra,
  });
}
