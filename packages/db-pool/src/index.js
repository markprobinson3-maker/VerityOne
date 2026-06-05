// packages/db-pool/src/index.ts
import postgres from "postgres";
function getDatabaseUrl() {
  const configured = process.env.DATABASE_URL?.trim();
  return configured || "postgresql://localhost:5432/verity";
}
var cachedProfile;
function getDeploymentProfile() {
  if (cachedProfile)
    return cachedProfile;
  const raw = (process.env.VERITY_DEPLOYMENT_PROFILE || "long-lived").trim();
  if (raw !== "serverless" && raw !== "long-lived") {
    throw new Error(`VERITY_DEPLOYMENT_PROFILE must be "serverless" or "long-lived" ` + `(got: ${JSON.stringify(raw)})`);
  }
  cachedProfile = raw;
  return cachedProfile;
}
function requireLongLivedDeploymentProfile(operation) {
  if (getDeploymentProfile() === "long-lived")
    return { ok: true };
  return {
    ok: false,
    error: `${operation} requires VERITY_DEPLOYMENT_PROFILE=long-lived. ` + `This operator rotation flow uses a reserved PostgreSQL session lock ` + `and is intentionally disabled in serverless functions.`
  };
}
function __resetCachedDeploymentProfileForTests() {
  cachedProfile = undefined;
}
function createPooledSql(extra = {}) {
  return postgres(getDatabaseUrl(), {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
    ...extra
  });
}
function createDirectSql(extra = {}) {
  return postgres(getDatabaseUrl(), {
    max: 40,
    idle_timeout: 20,
    connect_timeout: 10,
    ...extra
  });
}
export {
  requireLongLivedDeploymentProfile,
  getDeploymentProfile,
  getDatabaseUrl,
  createPooledSql,
  createDirectSql,
  __resetCachedDeploymentProfileForTests
};
