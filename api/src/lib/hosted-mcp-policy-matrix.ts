// Open-core stub. The VO+ implementation ships separately.
/**
 * Hosted MCP policy matrix — OPEN-CORE STUB.
 *
 * The hosted/web MCP read+write surface (the `/hosted-mcp/*` routes, their
 * policy gates, freshness guarantees, and write-intent payload schemas) is part
 * of VO+ and is NOT included in the open-core distribution. This stub exists
 * only so open-core modules that reference the policy-matrix surface compile and
 * boot.
 *
 * Open-core does not ship any hosted-mcp routes, so the matrix is empty: every
 * count derived from it (route count, policy-entry count) is honestly 0. No
 * secrets, crypto, tenant identity, or hosted-mirror logic live here. Module
 * load is side-effect-free.
 */

export const HOSTED_MCP_POLICY_CAPABILITIES = ["read", "write", "review-audit"] as const;
export const HOSTED_MCP_POLICY_GATE_SOURCES = [
  "machine_settings",
  "agent_policy",
  "tenant_security_config",
  "connector_oauth_scope",
] as const;
export const HOSTED_MCP_POLICY_GATE_ACTIONS = ["deny", "filter", "metadata_only"] as const;

export type HostedMcpCapability = (typeof HOSTED_MCP_POLICY_CAPABILITIES)[number];

/** A single policy gate. Shape preserved for type compatibility; open-core
 *  ships no gate instances. */
export interface PolicyGate {
  name: string;
  source: (typeof HOSTED_MCP_POLICY_GATE_SOURCES)[number];
  action_on_deny: (typeof HOSTED_MCP_POLICY_GATE_ACTIONS)[number];
  description: string;
}

export interface FreshnessGuarantee {
  source: "hosted_mirror";
  field: "last_sync_at";
  required: boolean;
  note: string;
}

export interface HostedMcpRouteEntry {
  route: string;
  capability: HostedMcpCapability;
  policy_gates: ReadonlyArray<PolicyGate>;
  freshness: FreshnessGuarantee;
  description: string;
  command_payload_schemas?: Record<string, unknown>;
}

/** Write-intent payload schemas live in VO+. Empty in open-core. */
export const HOSTED_MCP_WRITE_PAYLOAD_SCHEMAS: Record<string, unknown> = {};

/**
 * The hosted-mcp route policy matrix. Open-core ships no hosted-mcp routes, so
 * the matrix is empty. Consumers read its length (route/policy counts) and may
 * iterate it; an empty array is the safe, honest degraded value.
 */
export const HOSTED_MCP_POLICY_MATRIX: ReadonlyArray<HostedMcpRouteEntry> = [];

/** Sorted, unique list of route paths covered by the matrix. Empty in
 *  open-core (no hosted-mcp routes ship). */
export function matrixRoutePaths(): ReadonlyArray<string> {
  return HOSTED_MCP_POLICY_MATRIX.map((e) => e.route).sort();
}

/** Stable serialization shape for the policy-matrix response. Type preserved
 *  for compatibility; open-core never serves this route. */
export interface PolicyMatrixResponse {
  schema: "vo-plus-hosted-mcp-policy-matrix/v1";
  tenant_id: string;
  agent_id: string;
  routes: ReadonlyArray<HostedMcpRouteEntry>;
  generated_at: string;
}
