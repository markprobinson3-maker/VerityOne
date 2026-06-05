// Open-core stub. The VO+ implementation ships separately.
//
// Hosted outbound sync is a VO+ (paid/hosted) capability. In the open-core
// build it is permanently disabled: there is no journal exporter, no hosted
// push, and no credential/crypto handling. This module exists only so the
// dashboard routes that dynamically `import("./sync-exporter")` continue to
// compile and boot, gracefully degrading to a "sync not configured" state.
//
// Every consumer in the OSS tree reaches this code through a try/catch around
// a dynamic import and treats a thrown/absent module as "no local sync". The
// stub goes one step further and returns a well-formed, disabled status object
// so callers that DO succeed still get safe, type-compatible values.

// The VO+ exporter receives a `postgres` tagged-template client here. The
// stub never queries the database, so a structural placeholder is enough and
// keeps this module free of any extra type dependency.
type SqlTag = unknown;

/**
 * Last-attempt record. In VO+ this is persisted sync telemetry; in open-core
 * there is never a sync attempt, so it is always `null`. The shape is kept
 * loose because OSS consumers only read a couple of optional fields off it
 * (and only when it is non-null, which it never is here).
 */
export interface LocalSyncState {
  last_attempt_at: string | null;
  last_result: string | null;
  last_error: string | null;
  [key: string]: unknown;
}

/**
 * Status surface consumed by the dashboard. In open-core every field reflects
 * the permanently-disabled state: nothing is configured, no token is present,
 * no node/tenant identity is bound, and there is no pending journal.
 */
export interface SyncStatus {
  sync_configured: boolean;
  hosted_sync: string;
  sync_token_present: boolean;
  local_cursor: number;
  tenant_id: string | null;
  node_id: string | null;
  journal_pending: number;
  vault_skip_reason: string | null;
  last_attempt: LocalSyncState | null;
}

/**
 * Return the local hosted-sync status. Open-core has no hosted sync, so this
 * always reports a disabled, unconfigured status with no bound identity.
 *
 * The `sql` parameter is accepted (and ignored) to stay signature-compatible
 * with the VO+ implementation, which queries the local sync journal.
 */
export async function getSyncStatus(_sql: SqlTag): Promise<SyncStatus> {
  return {
    sync_configured: false,
    hosted_sync: "off",
    sync_token_present: false,
    local_cursor: 0,
    tenant_id: null,
    node_id: null,
    journal_pending: 0,
    vault_skip_reason: null,
    last_attempt: null,
  };
}
