export type VaultRootSource = "explicit" | "env" | "config" | "default";

export type VaultInspectStatus =
  | "ready"
  | "disabled_ready"
  | "init_required"
  | "tenant_mismatch"
  | "env_override_invalid"
  | "unreadable"
  | "no_tenant";

export type VaultSkipReason =
  | "vault_disabled"
  | "init_required"
  | "tenant_mismatch"
  | "env_override_invalid"
  | "unreadable"
  | "no_tenant";

export interface ResolveVaultRootOptions {
  tenantId?: string | null;
  explicitRoot?: string | null;
  env?: Record<string, string | undefined>;
  configPath?: string;
  homeDir?: string;
}

export type ResolvedVaultRoot =
  | {
      ok: true;
      root: string;
      source: VaultRootSource;
      tenant_id: string;
      default_root: string;
    }
  | {
      ok: false;
      status: "no_tenant";
      reason: "tenant_id_required";
      root: null;
      source: null;
      error: string;
    };

export interface InspectVaultRootOptions extends ResolveVaultRootOptions {
  vaultEnabled?: boolean;
}

export type VaultInspection =
  | {
      ok: true;
      status: "ready" | "disabled_ready";
      root: string;
      source: VaultRootSource;
      tenant_id: string;
      vault_tenant_id: string;
      vault_enabled: boolean;
      marker: Record<string, unknown>;
      error: null;
    }
  | {
      ok: false;
      status: Exclude<VaultInspectStatus, "ready" | "disabled_ready">;
      reason: string;
      root: string | null;
      source: VaultRootSource | null;
      tenant_id: string | null;
      vault_tenant_id?: string | null;
      expected_tenant_id?: string;
      vault_enabled: boolean;
      error: string;
    };

export function defaultVaultParent(homeDir?: string): string;
export function defaultVaultRootForTenant(tenantId: string, homeDir?: string): string;
export function resolveVaultRoot(options?: ResolveVaultRootOptions): ResolvedVaultRoot;
export function inspectVaultRoot(options?: InspectVaultRootOptions): VaultInspection;
export function vaultSkipReasonForStatus(status: VaultInspectStatus): VaultSkipReason | null;
