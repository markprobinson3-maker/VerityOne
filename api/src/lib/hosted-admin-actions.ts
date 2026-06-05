// Open-core stub. The VO+ implementation ships separately.
//
// In the open-core build there is no hosted control plane, so there is no
// node link/revoke lifecycle to manage. These helpers therefore return
// safe, disabled results so callers degrade gracefully instead of crashing.

export interface ApproveResult {
  ok: boolean;
  error?: string;
  account_id?: string;
  tenant_id?: string;
  node_id?: string;
  tenant_key?: unknown;
}

export interface RevokeResult {
  ok: boolean;
  error?: string;
  node_id?: string;
  tenant_id?: string;
}

export interface HostedAdminAuditOptions {
  correlationId?: string | null;
}

const HOSTED_DISABLED = "Hosted admin actions are not available in this build.";

/**
 * Disabled in open-core: link approval is part of the hosted control
 * plane. Returns a safe failure result; no state is mutated.
 */
export async function approveLink(
  _sql: unknown,
  _linkId: string,
  _actor: { kind: string; label: string },
  _opts: HostedAdminAuditOptions = {},
): Promise<ApproveResult> {
  return { ok: false, error: HOSTED_DISABLED };
}

/**
 * Disabled in open-core: node revoke is part of the hosted control
 * plane. Returns a safe failure result; no state is mutated.
 */
export async function revokeNode(
  _sql: unknown,
  _nodeDbId: string,
  _actor: { kind: string; label: string },
  _opts: HostedAdminAuditOptions = {},
): Promise<RevokeResult> {
  return { ok: false, error: HOSTED_DISABLED };
}
