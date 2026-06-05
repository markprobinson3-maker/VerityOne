import type { SqlLike } from "./supercron-budget-policy";

export async function countActiveRegistryDormantNodes(
  sql: SqlLike,
  tenantId: string,
  tenantSpaceId: string,
): Promise<number> {
  if (!tenantId || !tenantSpaceId) {
    throw new Error("active_registry_dormant_count_requires_tenant_scope");
  }
  const [row] = await sql`
    SELECT count(*)::int AS active_registry_dormant_count
    FROM nodes n
    JOIN memory_registry mr
      ON mr.addr = n.addr
      AND mr.tenant_id = ${tenantId}
    WHERE n.node_type = 'memory'
      AND n.space_id = ${tenantSpaceId}
      AND n.dormant_at IS NOT NULL
      AND mr.status = 'active'
  `;
  return Number(row?.active_registry_dormant_count || 0);
}
