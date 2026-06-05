// Open-core stub. The VO+ implementation ships separately.
//
// In the open-core build, on-boot database migrations are disabled. The
// hosted/VO+ implementation owns the migration manifest, the advisory-lock
// orchestration, legacy backfill, and reset surgery. This stub exposes the
// same public surface with type-compatible signatures and safe, degraded
// "nothing to do" return values so the OSS node compiles and boots without
// shipping any VO+ migration logic.

export interface MigrationManifest {
  version: number;
  phases: Record<string, string>;
  migrations: { file: string; phase: string }[];
  exclude: { file: string; reason: string }[];
}

export interface MigrationStatus {
  applied: {
    filename: string;
    applied_at: string;
    checksum: string;
    phase: string;
    manifest_version: number;
  }[];
  pending: { filename: string; phase: string }[];
  drift: { filename: string; recorded_checksum: string; actual_checksum: string }[];
  not_in_manifest: string[];
}

export interface MigrationApplyResult {
  applied: number;
  legacyBackfilled: number;
  pending: number;
  skipped: number;
  failed: { filename: string; error: string } | null;
}

// Loose alias mirroring the real module: callers pass a tagged SQL client.
type SqlTag = any;

/**
 * Disabled in open-core. Returns an empty manifest (no migrations to apply).
 */
export async function loadMigrationManifest(): Promise<MigrationManifest> {
  return { version: 0, phases: {}, migrations: [], exclude: [] };
}

/**
 * Disabled in open-core. Reports no applied/pending/drift migrations.
 */
export async function getMigrationStatus(
  _sql: SqlTag,
  _opts: { ensureBootstrap?: boolean } = {},
): Promise<MigrationStatus> {
  return { applied: [], pending: [], drift: [], not_in_manifest: [] };
}

/**
 * Disabled in open-core. Legacy seed detection is a VO+ concern.
 */
export async function shouldMarkLegacySeedInstalled(
  _sql: SqlTag,
  _file: string,
): Promise<boolean> {
  return false;
}

/**
 * Disabled in open-core. No-op: nothing applied, nothing pending, no failure.
 * Boot-time consumers read `.failed` (null => no error) and `.applied`
 * (0 => no log line), so this degrades cleanly.
 */
export async function applyPendingMigrations(
  _sql: SqlTag,
  _opts: { dryRun?: boolean } = {},
): Promise<MigrationApplyResult> {
  return { applied: 0, legacyBackfilled: 0, pending: 0, skipped: 0, failed: null };
}

/**
 * Disabled in open-core. No legacy rows are backfilled.
 */
export async function backfillLegacyMigrations(_sql: SqlTag): Promise<{ marked: number }> {
  return { marked: 0 };
}

/**
 * Disabled in open-core. Destructive schema reset is a VO+ operator concern
 * and is intentionally not available here.
 */
export async function resetDatabase(_sql: SqlTag): Promise<MigrationApplyResult> {
  return { applied: 0, legacyBackfilled: 0, pending: 0, skipped: 0, failed: null };
}
