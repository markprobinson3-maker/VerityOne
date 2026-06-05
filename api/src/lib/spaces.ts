// Space-id helpers (rung F2 of VO-FOUNDATION-HARDENING-LADDER-1).
//
// The canonical per-pyramid / per-addr-prefix routing lives in the
// `graph_state` table and is read by the SQL helpers in
// db/tenant-overlay-foundation.sql. This pure-TS module only exposes
// helpers for code paths that have no SQL handle (e.g. URL builders,
// static defaults). When `VERITY_DEFAULT_TENANT_ID` is set the
// helpers return `tenant:<that_id>`; otherwise they fall back to
// `GLOBAL_SPACE_ID`.
//
// `DEFAULT_TENANT_ID` is exported as a nullable string so existing
// importers (notably api/src/routes/publish.ts:10,122) keep
// compiling. Any production caller that needs a tenant context MUST
// pass an explicit tenantId — the example-tenant fallback was removed under
// F2 to make the local install identical to a fresh-clone install.

export const GLOBAL_SPACE_ID = "global";

export const DEFAULT_TENANT_ID: string | null =
  (process.env.VERITY_DEFAULT_TENANT_ID || "").trim() || null;

export function tenantSpaceId(tenantId: string | null | undefined): string {
  const normalized = (tenantId || "").trim();
  if (normalized) {
    return normalized.startsWith("tenant:") ? normalized : `tenant:${normalized}`;
  }
  if (DEFAULT_TENANT_ID) return `tenant:${DEFAULT_TENANT_ID}`;
  return GLOBAL_SPACE_ID;
}

export function defaultSpaceIdForPyramid(pyramidId: string | null | undefined): string {
  switch ((pyramidId || "").trim().toUpperCase()) {
    case "PROJECTS":
      return tenantSpaceId(DEFAULT_TENANT_ID);
    default:
      return GLOBAL_SPACE_ID;
  }
}

export function defaultSpaceIdForAddr(addr: string | null | undefined): string {
  const prefix = (addr || "").trim().split(".", 1)[0]?.toUpperCase();
  if (prefix === "PJ") return tenantSpaceId(DEFAULT_TENANT_ID);
  return GLOBAL_SPACE_ID;
}
