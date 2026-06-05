export const SYNC_REJECTION_ACTIONS = [
  "retry_required",
  "cursor_consumable",
  "idempotent_noop",
] as const;

export type SyncRejectionAction = (typeof SYNC_REJECTION_ACTIONS)[number];

export const SYNC_RETRY_REQUIRED_REASONS = [
  "sync_token_invalid",
  "entitlement_expired",
  "tenant_key_unavailable",
  "node_unauthorized",
  "rate_limited",
  "serialization_error",
  "duplicate_batch_id_conflict",
  "unknown_rejection",
  "server_5xx",
] as const;

export const SYNC_CURSOR_CONSUMABLE_REASONS = [
  "secret_scanner_match",
  "category_filtered_unsafe",
  "item_too_large_single_row",
  "schema_validation_failed_bad_row",
] as const;

export const SYNC_IDEMPOTENT_NOOP_REASONS = [
  "duplicate_batch_id",
] as const;

export type SyncRetryRequiredReason = (typeof SYNC_RETRY_REQUIRED_REASONS)[number];
export type SyncCursorConsumableReason = (typeof SYNC_CURSOR_CONSUMABLE_REASONS)[number];
export type SyncIdempotentNoopReason = (typeof SYNC_IDEMPOTENT_NOOP_REASONS)[number];
export type SyncRejectionReason =
  | SyncRetryRequiredReason
  | SyncCursorConsumableReason
  | SyncIdempotentNoopReason;

export interface SyncRejectionPolicyDecision {
  reason: SyncRejectionReason;
  action: SyncRejectionAction;
  cursor_advances: boolean;
}

function isRetryReason(reason: SyncRejectionReason): reason is SyncRetryRequiredReason {
  return (SYNC_RETRY_REQUIRED_REASONS as readonly string[]).includes(reason);
}

function isCursorConsumableReason(reason: SyncRejectionReason): reason is SyncCursorConsumableReason {
  return (SYNC_CURSOR_CONSUMABLE_REASONS as readonly string[]).includes(reason);
}

function isIdempotentNoopReason(reason: SyncRejectionReason): reason is SyncIdempotentNoopReason {
  return (SYNC_IDEMPOTENT_NOOP_REASONS as readonly string[]).includes(reason);
}

export function classifySyncRejection(reason: SyncRejectionReason): SyncRejectionPolicyDecision {
  if (isRetryReason(reason)) {
    return { reason, action: "retry_required", cursor_advances: false };
  }
  if (isCursorConsumableReason(reason)) {
    return { reason, action: "cursor_consumable", cursor_advances: true };
  }
  if (isIdempotentNoopReason(reason)) {
    return { reason, action: "idempotent_noop", cursor_advances: true };
  }
  const exhaustive: never = reason;
  return exhaustive;
}

export function syncRetryRequired(reason: SyncRetryRequiredReason): SyncRejectionPolicyDecision {
  return classifySyncRejection(reason);
}

export function syncCursorConsumable(reason: SyncCursorConsumableReason): SyncRejectionPolicyDecision {
  return classifySyncRejection(reason);
}

export function syncIdempotentNoop(reason: SyncIdempotentNoopReason): SyncRejectionPolicyDecision {
  return classifySyncRejection(reason);
}

export function classifyHostedSyncPushFailure(status: number, code: unknown): SyncRejectionPolicyDecision {
  if (code === "not_drive_mirror_primary" || code === "not_supported_for_security_tier") {
    return syncCursorConsumable("category_filtered_unsafe");
  }
  if (code === "category_filtered_unsafe") {
    return syncCursorConsumable("category_filtered_unsafe");
  }
  if (code === "payload_too_large") {
    return syncCursorConsumable("item_too_large_single_row");
  }
  if (status === 401 || status === 403 || code === "sync_token_invalid" || code === "agent_token_invalid") {
    return syncRetryRequired("sync_token_invalid");
  }
  if (status === 402 || code === "payment_required") {
    return syncRetryRequired("entitlement_expired");
  }
  if (status === 409 || code === "conflict") {
    return syncRetryRequired("duplicate_batch_id_conflict");
  }
  if (status === 429 || code === "rate_limited") {
    return syncRetryRequired("rate_limited");
  }
  if (status === 503 || code === "service_unavailable") {
    return syncRetryRequired("tenant_key_unavailable");
  }
  if (status >= 500) {
    return syncRetryRequired("server_5xx");
  }
  if (code === "validation_failed") {
    return syncRetryRequired("serialization_error");
  }
  return syncRetryRequired("unknown_rejection");
}
