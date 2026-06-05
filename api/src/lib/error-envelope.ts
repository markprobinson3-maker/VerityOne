/**
 * F8: canonical error envelope + ergonomic helpers.
 *
 * Every error response from the API is `{ ok: false, code, error, details?, hint? }`.
 * Callers should use the helpers in this file rather than building shapes by
 * hand — drift-pinned in foundation-state-drift.test.ts.
 *
 * Two emission paths:
 *   - `errorJson(c, code, opts?)` for handlers that have a Hono Context
 *   - `errorResponse(code, opts?)` for pre-app serverless short-circuits
 *     (api/index.ts) where Hono has not loaded yet
 *
 * `buildErrorEnvelope(code, opts?)` is the framework-independent envelope
 * builder both helpers wrap; tests can assert directly on it.
 */

import type { Context } from "hono";
import type { z } from "zod";
import { type ErrorCode, defaultMessageFor } from "./error-codes";

export interface ErrorEnvelope {
  ok: false;
  code: ErrorCode;
  error: string;
  details?: unknown;
  hint?: string;
}

export interface SanitizedZodIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export class ApiError extends Error {
  public readonly details?: unknown;
  public readonly hint?: string;
  public readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string, details?: unknown, hint?: string) {
    super(message ?? defaultMessageFor(code));
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

export class ValidationFailedError extends ApiError {
  public readonly issues: SanitizedZodIssue[];
  constructor(issues: SanitizedZodIssue[], message?: string) {
    super("validation_failed", message ?? "Request failed schema validation", { issues });
    this.issues = issues;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(hint?: string) { super("unauthorized", undefined, undefined, hint); }
}
export class ForbiddenError extends ApiError {
  constructor(hint?: string) { super("forbidden", undefined, undefined, hint); }
}
export class NotFoundError extends ApiError {
  constructor(message?: string) { super("not_found", message); }
}
export class ConflictError extends ApiError {
  constructor(message?: string, details?: unknown) { super("conflict", message, details); }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "invalid_request":
    case "invalid_params":
    case "validation_failed":
    case "tenant_slug_invalid":
    case "content_opaque_edge_not_supported":
    case "content_opaque_schema_version_required":
    case "invalid_addr":
    case "reserved_command":
    case "target_date_mismatch":
    case "future_target_date":
      return 400;
    case "category_filtered_unsafe":
      return 422;
    case "unauthorized":
    case "agent_token_invalid":
    case "sync_token_invalid":
    case "oauth_state_invalid":
    case "provider_credentials_invalid":
      return 401;
    case "forbidden":
    case "tenant_required":
    case "space_required":
    case "operator_required":
    case "onboarding_disabled":
    case "federation_disabled":
    case "publish_blocked":
    case "approval_required":
    case "agent_write_denied":
    case "not_drive_mirror_primary":
    case "drive_connect_required":
    case "not_supported_for_security_tier":
    case "vo_disabled":
      return 403;
    case "not_found":
    case "tenant_not_found":
    case "memory_not_found":
    case "project_not_found":
    case "node_not_found":
    case "edge_not_found":
    case "pyramid_unknown":
    case "worker_unknown":
    case "addr_invalid":
    case "provider_unsupported":
    case "entry_not_found":
    case "day_node_missing":
      return 404;
    case "method_not_allowed":
      return 405;
    case "not_acceptable":
      return 406;
    case "gone":
      return 410;
    case "payment_required":
      return 402;
    case "conflict":
    case "account_already_linked":
    case "tenant_already_linked":
    case "tenant_slug_taken":
    case "tenant_link_pending":
    case "link_race":
    case "state_mismatch":
    case "duplicate_memory":
    case "memory_dormant":
    case "sync_replay_detected":
    case "staging_not_promotable":
    case "job_not_due":
    case "install_pending":
    case "force_run_tenant_mismatch":
    case "manual_run_already_open":
    case "entry_was_retracted":
    case "idempotency_conflict":
    case "idempotency_account_mismatch":
    case "idempotency_command_mismatch":
    case "idempotency_origin_mismatch":
    case "entry_key_collision":
      return 409;
    case "payload_too_large":
      return 413;
    case "unsupported_media_type":
      return 415;
    case "rate_limited":
      return 429;
    case "internal_error":
    case "embedding_dimension_mismatch":
    case "oauth_callback_failed":
    case "install_misconfigured":
    case "overlay_signature_invalid":
    case "overlay_unsupported_kind":
      return 500;
    case "not_implemented":
      return 501;
    case "bad_gateway":
      return 502;
    case "gateway_timeout":
      return 504;
    case "service_unavailable":
    case "embedding_service_unavailable":
    case "central_db_schema_stale":
    case "central_db_schema_drift":
    case "instance_tenant_required":
      return 503;
    default: {
      // Exhaustiveness: TypeScript proves we covered every code.
      const _: never = code;
      void _;
      return 500;
    }
  }
}

export function buildErrorEnvelope(
  code: ErrorCode,
  opts?: { message?: string; details?: unknown; hint?: string },
): ErrorEnvelope {
  const message = errorEnvelopeOwnField(opts, "message") as string | undefined;
  const details = errorEnvelopeOwnField(opts, "details");
  const hint = errorEnvelopeOwnField(opts, "hint") as string | undefined;
  return {
    ok: false,
    code,
    error: message ?? defaultMessageFor(code),
    ...(details !== undefined ? { details } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

function errorEnvelopeOwnField(opts: unknown, key: string): unknown {
  if (!opts || typeof opts !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(opts, key)) return undefined;
  return (opts as Record<string, unknown>)[key];
}

export function errorJson(
  c: Context,
  code: ErrorCode,
  opts?: { message?: string; details?: unknown; hint?: string; extra?: Record<string, unknown> },
): Response {
  const extra = errorEnvelopeOwnField(opts, "extra");
  const extraRecord = extra && typeof extra === "object" && !Array.isArray(extra)
    ? extra as Record<string, unknown>
    : {};
  return c.json<ErrorEnvelope & Record<string, unknown>>({
    ...extraRecord,
    ...buildErrorEnvelope(code, opts),
  }, httpStatusFor(code) as any);
}

export function errorResponse(
  code: ErrorCode,
  opts?: { message?: string; details?: unknown; hint?: string; headers?: HeadersInit },
): Response {
  const headers = errorEnvelopeOwnField(opts, "headers") as HeadersInit | undefined;
  return Response.json(buildErrorEnvelope(code, opts), {
    status: httpStatusFor(code),
    headers,
  });
}

/**
 * Sanitize zod issues to a stable, public-safe shape. Drops parent paths,
 * actual values, and zod-internal details — keeps only `path`, `code`, `message`.
 */
export function sanitizeZodIssues(issues: z.core.$ZodIssue[]): SanitizedZodIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((seg) => (typeof seg === "number" ? seg : String(seg))),
    code: issue.code,
    message: issue.message,
  }));
}
