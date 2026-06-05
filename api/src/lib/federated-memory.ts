/**
 * Federated memory metadata — identifies whether a memory is tenant-local,
 * a synced copy, or a public overlay imported into a local VO node.
 *
 * This is groundwork for hybrid local/public VO deployments. Current hosted
 * usage defaults every memory to tenant_local + local_only.
 */

export interface ValidationErrorLike {
  field: string;
  message: string;
}

export const MEMORY_AUTHORITIES = [
  "tenant_local",
  "tenant_shared",
  "public_overlay",
] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const MEMORY_SYNC_STATES = [
  "local_only",
  "synced_copy",
  "public_overlay",
] as const;
export type MemorySyncState = (typeof MEMORY_SYNC_STATES)[number];

export interface FederatedMemoryMetadata {
  /** Which layer is authoritative for this memory. */
  authority?: MemoryAuthority;
  /** How this memory arrived in the current store. */
  sync_state?: MemorySyncState;
  /** Upstream memory identifier if this memory was synced/imported. */
  upstream_memory_id?: string;
  /** Upstream system or instance label, e.g. "vo-public". */
  upstream_origin?: string;
  /** Last successful sync/import timestamp. */
  last_synced_at?: string;
}

export interface ResolvedFederatedMemoryMetadata {
  authority: MemoryAuthority;
  sync_state: MemorySyncState;
  upstream_memory_id: string | null;
  upstream_origin: string | null;
  last_synced_at: string | null;
}

export function validateFederationMetadata(
  value: unknown,
  fieldPrefix = "federation",
): ValidationErrorLike[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ field: fieldPrefix, message: "Must be an object" }];
  }

  const data = value as Record<string, unknown>;
  const errors: ValidationErrorLike[] = [];

  if (data.authority !== undefined && !MEMORY_AUTHORITIES.includes(data.authority as MemoryAuthority)) {
    errors.push({
      field: `${fieldPrefix}.authority`,
      message: `Must be one of: ${MEMORY_AUTHORITIES.join(", ")}`,
    });
  }
  if (data.sync_state !== undefined && !MEMORY_SYNC_STATES.includes(data.sync_state as MemorySyncState)) {
    errors.push({
      field: `${fieldPrefix}.sync_state`,
      message: `Must be one of: ${MEMORY_SYNC_STATES.join(", ")}`,
    });
  }
  if (data.upstream_memory_id !== undefined && typeof data.upstream_memory_id !== "string") {
    errors.push({ field: `${fieldPrefix}.upstream_memory_id`, message: "Must be a string" });
  }
  if (data.upstream_origin !== undefined && typeof data.upstream_origin !== "string") {
    errors.push({ field: `${fieldPrefix}.upstream_origin`, message: "Must be a string" });
  }
  if (data.last_synced_at !== undefined && typeof data.last_synced_at !== "string") {
    errors.push({ field: `${fieldPrefix}.last_synced_at`, message: "Must be a string timestamp" });
  }

  return errors;
}

export function resolveFederationMetadata(value: unknown): ResolvedFederatedMemoryMetadata {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    authority: MEMORY_AUTHORITIES.includes(data.authority as MemoryAuthority)
      ? data.authority as MemoryAuthority
      : "tenant_local",
    sync_state: MEMORY_SYNC_STATES.includes(data.sync_state as MemorySyncState)
      ? data.sync_state as MemorySyncState
      : "local_only",
    upstream_memory_id: typeof data.upstream_memory_id === "string" ? data.upstream_memory_id : null,
    upstream_origin: typeof data.upstream_origin === "string" ? data.upstream_origin : null,
    last_synced_at: typeof data.last_synced_at === "string" ? data.last_synced_at : null,
  };
}
