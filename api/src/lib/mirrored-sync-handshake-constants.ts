export const MIRRORED_SYNC_USER_ACTION_RETRY_ATTEMPTS = 10;
export const MIRRORED_SYNC_USER_ACTION_RETRY_SECONDS = 30;
export const MIRRORED_SYNC_ACTIVE_PAGE_REFRESH_SECONDS = 60;
export const MIRRORED_SYNC_OFFLINE_BACKOFF_MIN_SECONDS = 300;
export const MIRRORED_SYNC_OFFLINE_BACKOFF_MAX_SECONDS = 600;

export const MIRRORED_SYNC_ACCOUNT_COMMAND_TYPES = [
  "sync_start",
  "sync_stop",
  "mirror_enable",
  "mirror_disable",
  "project_remove_from_vow",
] as const;

export type MirroredSyncAccountCommandType = (typeof MIRRORED_SYNC_ACCOUNT_COMMAND_TYPES)[number];

export function mirroredSyncIdempotencyKey(
  tenantId: string,
  commandType: MirroredSyncAccountCommandType,
  stablePart: string,
): string {
  return `mirrored_sync:${tenantId}:${commandType}:${stablePart}`;
}
