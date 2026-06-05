/**
 * F8: controlled vocabulary of machine-readable error codes.
 *
 * Every error response from the API includes a `code` field drawn from this
 * map. Codes are snake_case, stable identifiers — clients can branch on them
 * even when the human-readable `error` text changes. Adding a new code requires
 * also adding it to `httpStatusFor` in `error-envelope.ts` (drift-pinned).
 *
 * Pattern: `<resource>_<problem>` for resource-specific failures, generic
 * names for cross-cutting failures.
 */

export const ERROR_CODES = {
  // Generic / cross-cutting
  invalid_request: "Request body is malformed or missing required fields",
  invalid_params: "Request parameters are malformed or missing required fields",
  validation_failed: "Request failed schema validation",
  unauthorized: "Authentication required",
  forbidden: "Access denied",
  not_supported_for_security_tier: "Operation is not supported for this tenant security tier",
  payment_required: "A paid entitlement is required for this operation",
  not_found: "Resource not found",
  gone: "Resource is no longer available",
  conflict: "Resource state conflicts with the request",
  state_mismatch: "Resource changed while the request was being processed",
  rate_limited: "Too many requests",
  onboarding_disabled: "Hosted onboarding is disabled",
  central_db_schema_stale: "Central database has pending migrations",
  central_db_schema_drift: "Central database migration checksums drifted",
  service_unavailable: "Upstream service is unavailable",
  vo_disabled: "VO is disabled by machine-level policy",
  unsupported_media_type: "Unsupported request content type",
  payload_too_large: "Request body is too large",
  internal_error: "Internal server error",
  method_not_allowed: "HTTP method not allowed for this route",
  not_acceptable: "Requested response media type is not acceptable",
  not_implemented: "Requested operation is not implemented on this host",
  bad_gateway: "Upstream gateway returned an invalid response",
  gateway_timeout: "Upstream gateway timed out",

  // Auth / tenancy
  agent_token_invalid: "Agent token is invalid or revoked",
  tenant_required: "Tenant context required",
  tenant_not_found: "Tenant not found",
  tenant_slug_invalid: "Tenant slug is invalid",
  tenant_slug_taken: "Tenant slug is already taken",
  account_already_linked: "Account is already linked to a tenant",
  tenant_already_linked: "Tenant is already linked to an account",
  tenant_link_pending: "Tenant link is pending confirmation",
  link_race: "Link state changed during the request",
  space_required: "Space identifier required",
  operator_required: "Operator authentication required",
  agent_write_denied: "Agent write permission is denied",

  // Memory / project / node
  memory_not_found: "Memory not found",
  project_not_found: "Project not found",
  node_not_found: "Node not found",
  edge_not_found: "Edge not found",
  invalid_addr: "Address parameter is malformed",
  addr_invalid: "Address is malformed or unrecognized",
  pyramid_unknown: "Pyramid identifier is not registered",
  duplicate_memory: "An equivalent memory already exists",
  memory_dormant: "Memory is dormant and cannot be modified in place",
  approval_required: "This action requires explicit user approval",

  // Embedding (subsumes F7 translation)
  embedding_service_unavailable: "Embedding provider is unavailable",
  embedding_dimension_mismatch: "Embedding dimension mismatch",

  // Day journal
  reserved_command: "Explicit VO command starter is reserved for another surface",
  target_date_mismatch: "Day journal target date inputs refer to different days",
  future_target_date: "Manual day journal entries cannot target a future date",
  entry_was_retracted: "Day journal entry was retracted and cannot be recreated by replay",
  idempotency_conflict: "Idempotency key conflicts with a different day journal request",
  idempotency_account_mismatch: "Idempotency key belongs to a different account",
  idempotency_command_mismatch: "Idempotency key was already used for a different command",
  idempotency_origin_mismatch: "Idempotency key was already used by a different origin",
  entry_key_collision: "Day journal entry key collides with an existing entry",
  entry_not_found: "Day journal entry not found",
  day_node_missing: "Target day node is missing or inaccessible",

  // Federation / sync / overlay
  sync_token_invalid: "Sync token is invalid or expired",
  sync_replay_detected: "Sync request appears to be a replay",
  not_drive_mirror_primary: "This node is not the active Drive mirror primary",
  drive_connect_required: "Google Drive consent is required",
  category_filtered_unsafe: "Sync item violates the tenant's hosted mirror preferences",
  content_opaque_edge_not_supported: "Edge sync is not supported in content-opaque mode",
  content_opaque_schema_version_required: "Content-opaque tenants must use schema_version 2",
  overlay_signature_invalid: "Overlay signature does not verify",
  overlay_unsupported_kind: "Overlay item kind is unsupported",
  federation_disabled: "Federation is disabled for this tenant",

  // Worker / lifecycle
  worker_unknown: "Worker is not registered",
  job_not_due: "Scheduled job is not due to run",
  instance_tenant_required: "SuperCron instance tenant is not configured",
  force_run_tenant_mismatch: "Force-run tenant must match this SuperCron instance owner",
  manual_run_already_open: "A SuperCron manual run is already pending or running for this tenant",

  // Site / install / boot
  install_pending: "Local install has not completed bootstrap",
  install_misconfigured: "Local install is misconfigured",

  // OAuth / external connectors
  oauth_state_invalid: "OAuth state parameter is invalid",
  oauth_callback_failed: "OAuth callback failed",
  provider_unsupported: "External provider is not supported",
  provider_credentials_invalid: "External provider credentials are invalid",

  // Publishing / staging
  publish_blocked: "Publication blocked by policy",
  staging_not_promotable: "Staging item cannot be promoted in its current state",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function defaultMessageFor(code: ErrorCode): string {
  return ERROR_CODES[code];
}
