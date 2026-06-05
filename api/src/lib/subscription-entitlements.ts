import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export const ENTITLEMENT_SOURCE_PRECEDENCE = [
  "admin_override",
  "stripe_subscription",
  "manual_vo_plus",
  "free_google",
] as const;

export type EntitlementSource = typeof ENTITLEMENT_SOURCE_PRECEDENCE[number];

export const EFFECTIVE_CAPABILITIES = [
  "lightweight_status_sync",
  "account_governance_sync",
  "non_project_graph_sync",
  "project_sync",
  "vault_metadata_sync",
  "vault_drive_mirror",
  "raw_capture_drive_mirror",
] as const;

export type EffectiveCapability = typeof EFFECTIVE_CAPABILITIES[number];

export type EffectiveEntitlementTier =
  | "free"
  | "plus"
  | "vo_plus_admin"
  | "vo_plus_beta"
  | "vo_plus_internal";

export interface EffectiveEntitlement {
  tier: EffectiveEntitlementTier;
  source: EntitlementSource;
  label?: string;
  capabilities: EffectiveCapability[];
  vo_plus_active: boolean;
  manage_url: string;
}

const FREE_CAPABILITIES: EffectiveCapability[] = [
  "lightweight_status_sync",
  "account_governance_sync",
  "non_project_graph_sync",
];

const VO_PLUS_CAPABILITIES: EffectiveCapability[] = [...EFFECTIVE_CAPABILITIES];

function manageUrl(): string {
  return "https://verityone.app/my/account#vo-plus";
}

function project(
  tier: EffectiveEntitlementTier,
  source: EntitlementSource,
  label?: string | null,
): EffectiveEntitlement {
  const voPlus = tier !== "free";
  return {
    tier,
    source,
    ...(label ? { label } : {}),
    capabilities: voPlus ? VO_PLUS_CAPABILITIES : FREE_CAPABILITIES,
    vo_plus_active: voPlus,
    manage_url: manageUrl(),
  };
}

export async function resolveEffectiveEntitlement(
  _sql: SqlTag,
  _input: { accountId?: string | null; tenantId?: string | null },
): Promise<EffectiveEntitlement> {
  // Open-core: entitlement tiers and the hosted admin-override / subscription
  // tables are a VO+ (hosted) concern. The local node has no hosted entitlement
  // source, so it resolves to the local tier with the always-available local
  // capabilities. The VO+ build supplies the real resolver (admin overrides +
  // subscriptions); the pure capability helpers below are the shared contract.
  return project("free", "free_google");
}

export function hasCapability(
  entitlement: Pick<EffectiveEntitlement, "capabilities">,
  capability: EffectiveCapability,
): boolean {
  return entitlement.capabilities.includes(capability);
}

function syncItemProjectAddr(item: any): string | null {
  if (typeof item?.project_addr === "string" && item.project_addr.length > 0) return item.project_addr;
  if (
    item?.plaintext_metadata &&
    typeof item.plaintext_metadata === "object" &&
    typeof item.plaintext_metadata.project_addr === "string" &&
    item.plaintext_metadata.project_addr.length > 0
  ) {
    return item.plaintext_metadata.project_addr;
  }
  return null;
}

export function requiredCapabilitiesForSyncItem(item: any): EffectiveCapability[] {
  if (item.type === "project") return ["project_sync"];
  if (item.type === "memory" && syncItemProjectAddr(item)) return ["project_sync"];
  if (item.type === "journal_entry" && syncItemProjectAddr(item)) return ["project_sync"];
  if (item.type === "edge") return ["project_sync"];
  if (item.type === "vault_dossier") return ["vault_metadata_sync"];
  if (item.type === "journal_entry") return [];
  if (item.type === "vault_drive_file") {
    if (item.file_kind === "vault_dossier") return ["vault_drive_mirror"];
    if (item.file_kind === "raw_capture_file") return ["raw_capture_drive_mirror"];
    if (item.file_kind === "other_vault_file") return ["vault_drive_mirror"];
    throw Object.assign(new Error("unknown_file_kind"), { code: "unknown_file_kind" });
  }
  if (item.type === "governance") return [];
  if (item.type === "memory") return [];
  return [];
}

export function isRegisteredEntitlementSyncItem(item: any): boolean {
  return Boolean(
    item &&
    typeof item === "object" &&
    (
      item.type === "project" ||
      item.type === "edge" ||
      item.type === "vault_dossier" ||
      item.type === "vault_drive_file" ||
      item.type === "journal_entry" ||
      item.type === "governance" ||
      item.type === "memory"
    ),
  );
}

export function forbiddenSyncItems(
  items: any[],
  entitlement: Pick<EffectiveEntitlement, "capabilities">,
): { forbidden_items: Array<{ type: string; count: number }>; required_capabilities: EffectiveCapability[] } {
  const counts = new Map<string, number>();
  const required = new Set<EffectiveCapability>();
  for (const item of items) {
    if (!isRegisteredEntitlementSyncItem(item)) {
      const type = typeof item?.type === "string" ? item.type : "unknown";
      counts.set(type, (counts.get(type) || 0) + 1);
      continue;
    }
    let caps: EffectiveCapability[];
    try {
      caps = requiredCapabilitiesForSyncItem(item);
    } catch (e) {
      const type = typeof item?.type === "string" ? item.type : "unknown";
      if ((e as any)?.code === "unknown_file_kind" && type === "vault_drive_file") {
        if (!hasCapability(entitlement, "vault_drive_mirror")) {
          counts.set(type, (counts.get(type) || 0) + 1);
          required.add("vault_drive_mirror");
        }
      } else {
        counts.set(type, (counts.get(type) || 0) + 1);
      }
      continue;
    }
    const missing = caps.filter((cap) => !hasCapability(entitlement, cap));
    if (missing.length === 0) continue;
    const type = typeof item?.type === "string" ? item.type : "unknown";
    counts.set(type, (counts.get(type) || 0) + 1);
    for (const cap of missing) required.add(cap);
  }
  return {
    forbidden_items: [...counts.entries()].map(([type, count]) => ({ type, count })),
    required_capabilities: [...required],
  };
}
