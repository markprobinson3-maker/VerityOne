// Open-core stub. The VO+ implementation ships separately.
//
// Tenant data-key management (per-tenant key domains, key wrapping/rotation,
// and the associated hosted crypto) is a VO+ capability and is NOT part of the
// open-core node. The open-core node ships no encrypted tenant key domains, so
// the only symbol it ever references — the boot-time readiness guard — can
// safely report "nothing to do, all good" without touching any crypto, env
// secrets, or the database.
//
// This stub exports a type-compatible surface with safe, disabled behavior.
// It reads no secrets, performs no encryption/decryption, and derives no keys.

type SqlTag = any;

/**
 * Verdict shape returned by the boot-time master-key readiness guard.
 * Mirrors the VO+ contract so consumers (api/src/index.ts) can read
 * `.ok`, `.level`, and `.warning` without changes.
 */
export interface MasterKeyReadiness {
  ok: boolean;
  level: "ok" | "no_key" | "key_mismatch" | "partial_rotation";
  envWrappedTenants: number;
  configuredKeyId: string | null;
  matchingTenants: number;
  warning: string | null;
}

/**
 * Open-core stub: there are no env-wrapped tenant key domains in the
 * open-core node, so the readiness guard is always satisfied. Returns a
 * stable, safe "ok" verdict with no warning. Never throws, never reads
 * secrets, never queries the database.
 */
export async function checkMasterKeyReadiness(_sql?: SqlTag): Promise<MasterKeyReadiness> {
  return {
    ok: true,
    level: "ok",
    envWrappedTenants: 0,
    configuredKeyId: null,
    matchingTenants: 0,
    warning: null,
  };
}
