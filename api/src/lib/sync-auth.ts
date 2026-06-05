// Open-core stub. The VO+ implementation ships separately.
/**
 * Node-scoped sync-auth helper (open-core stub).
 *
 * In the open-core build, hosted node sync is disabled. These functions keep
 * the same signatures and return types as the full implementation so callers
 * compile and run, but they perform no hosted-mirror writes and issue no
 * durable sync credentials. The hosted sync pipeline ships separately.
 *
 * Safe degraded behavior:
 *   - issueSyncToken      -> null   (no token issued; callers treat as a no-op)
 *   - resolveSyncToken    -> null   (no token resolves when sync is disabled)
 *   - invalidateNodeSyncToken -> void (no-op)
 *   - invalidateAllSyncTokens -> 0  (nothing to invalidate)
 */

type SqlTag = any;

export interface SyncTokenIssuance {
  raw_token: string;
  token_hash: string;
}

/**
 * Issue a sync token. Disabled in open-core: returns null so callers treat the
 * issuance as unavailable and respond gracefully (no hosted write occurs).
 */
export async function issueSyncToken(
  _sql: SqlTag,
  _accountId: string,
  _tenantId: string,
  _nodeId: string,
  _options: { requireUnclaimed?: boolean } = {},
): Promise<SyncTokenIssuance | null> {
  return null;
}

export interface ResolvedSyncAuth {
  account_id: string;
  tenant_id: string;
  node_id: string;
}

/**
 * Resolve a raw sync bearer token to its node identity. Disabled in open-core:
 * no token resolves, so this always returns null.
 */
export async function resolveSyncToken(
  _sql: SqlTag,
  _rawToken: string,
): Promise<ResolvedSyncAuth | null> {
  return null;
}

/**
 * Invalidate a specific node's sync token. No-op in open-core.
 */
export async function invalidateNodeSyncToken(
  _sql: SqlTag,
  _accountId: string,
  _tenantId: string,
  _nodeId: string,
): Promise<void> {
  return;
}

/**
 * Invalidate all sync tokens for a tenant/account. No-op in open-core: returns 0.
 */
export async function invalidateAllSyncTokens(
  _sql: SqlTag,
  _accountId: string,
  _tenantId: string,
): Promise<number> {
  return 0;
}
