import type postgres from "postgres";

export const TENANT_DEFAULT_SUPERCRON_ENABLED_KEY = "supercron.tenant_default_enabled";
export const LEGACY_TENANT_DEFAULT_SUPERCRON_ENABLED_KEY = "supercron_tenant_default_enabled";

const DISABLED_VALUES = new Set(["false", "0", "off", "disabled", "no", "n", "f"]);

export interface TenantDefaultSupercronGate {
  enabled: boolean;
  key: string | null;
  value: string | null;
}

export function parseTenantDefaultSupercronEnabled(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return true;
  return !DISABLED_VALUES.has(normalized);
}

export async function readTenantDefaultSupercronEnabled(
  sql: ReturnType<typeof postgres>,
): Promise<TenantDefaultSupercronGate> {
  const [row] = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key = ${TENANT_DEFAULT_SUPERCRON_ENABLED_KEY}
       OR key = ${LEGACY_TENANT_DEFAULT_SUPERCRON_ENABLED_KEY}
    ORDER BY CASE key WHEN ${TENANT_DEFAULT_SUPERCRON_ENABLED_KEY} THEN 0 ELSE 1 END
    LIMIT 1
  `;

  if (!row) {
    return { enabled: true, key: null, value: null };
  }

  const value = row.value === null || row.value === undefined ? null : String(row.value);
  return {
    enabled: parseTenantDefaultSupercronEnabled(row.value),
    key: row.key ?? null,
    value,
  };
}
