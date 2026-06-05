// Open-core stub. The VO+ implementation ships separately.
/**
 * Tenant security mode — open-core stub.
 *
 * In the open-core build there is no hosted multi-tenant security posture
 * layer. The full implementation (per-tenant trust model selection,
 * customer-managed / content-opaque key authority, sync/read gating) ships
 * in VO+ separately. This stub exposes the same surface the open-core node
 * imports, returning safe "service-managed / disabled" defaults so the node
 * compiles and boots without any hosted-security logic.
 */

type SqlTag = any;

/**
 * Tenant security mode. Open-core nodes always behave as `service_managed`;
 * the other modes are recognized as valid type members so consumers that
 * persist/compare a stored value stay type-compatible, but this stub never
 * activates them.
 */
export type SecurityMode = "service_managed" | "customer_managed" | "content_opaque";

export interface TenantSecurityConfig {
  tenant_id: string;
  security_mode: SecurityMode;
  key_authority_config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Get tenant security config.
 *
 * Open-core stub: there is no tenant security posture store, so this always
 * resolves to `null` ("not bootstrapped"). Consumers treat a null/absent
 * config as the default `service_managed` posture, which keeps every code
 * path open exactly as it would be for a service-managed tenant.
 */
export async function getTenantSecurityConfig(
  _sql: SqlTag,
  _tenantId: string,
): Promise<TenantSecurityConfig | null> {
  return null;
}
