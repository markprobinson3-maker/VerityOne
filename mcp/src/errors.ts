/**
 * Error classes and envelope shape per docs/VO-MCP-SERVER-CONTRACT.md.
 *
 * Every tool-call failure maps to exactly one ErrorClass. The envelope shape
 * is JSON-stringified into the MCP content block with isError: true.
 */

export type ErrorClass =
  | "local_vo_unreachable"
  | "tenant_auth_failure"
  | "not_found"
  | "validation_failure"
  | "upstream_error";

export interface VoErrorEnvelope {
  error_class: ErrorClass;
  message: string;
  /**
   * Optional structured sub-reason from the server (e.g.
   * `tenant_scoped_bearer_required`, `source_not_absolute`). Added in
   * Rung 7 so agents can branch on codes without parsing prose. Older
   * tools that don't emit a sub-reason simply omit this field.
   */
  reason?: string;
  detail?: string;
  hint?: string;
}

const HINTS: Record<ErrorClass, string> = {
  local_vo_unreachable: "run: vo doctor; ensure the local VO node is running",
  tenant_auth_failure: "check ~/.vo/config.json has a valid agent_token for this tenant",
  not_found: "verify the requested address or key exists in the selected tenant",
  validation_failure: "inspect the `detail` field for the specific validation error",
  upstream_error: "check the local VO node logs; rerun vo-mcp doctor",
};

export function buildErrorEnvelope(
  error_class: ErrorClass,
  message: string,
  detail?: string,
  reason?: string,
): VoErrorEnvelope {
  return {
    error_class,
    message,
    ...(reason !== undefined ? { reason } : {}),
    ...(detail !== undefined ? { detail } : {}),
    hint: HINTS[error_class],
  };
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Walk a cause chain (including AggregateError.errors) and return the first
 *  error code found. Node 22's undici-based fetch often nests connection
 *  errors inside TypeError("fetch failed") → AggregateError → [Error]. */
function findErrorCode(err: unknown, depth = 0): string | null {
  if (!err || depth > 4) return null;
  const e = err as { code?: string; cause?: unknown; errors?: unknown[] };
  if (typeof e.code === "string") return e.code;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const c = findErrorCode(inner, depth + 1);
      if (c) return c;
    }
  }
  if (e.cause) return findErrorCode(e.cause, depth + 1);
  return null;
}

/** Distinguish connection-level failures from HTTP-level failures. */
export function classifyFetchFailure(err: unknown): { errorClass: ErrorClass; detail: string } {
  const e = err as { name?: string; message?: string };
  const code = findErrorCode(err);

  const isAbort = e?.name === "AbortError";
  const isFetchFailed = typeof e?.message === "string" && e.message.toLowerCase().includes("fetch failed");

  if (isAbort || (code && UNREACHABLE_CODES.has(code)) || isFetchFailed) {
    return {
      errorClass: "local_vo_unreachable",
      detail: `${code || e?.name || "network_error"}: ${e?.message || String(err)}`,
    };
  }

  return {
    errorClass: "upstream_error",
    detail: e?.message || String(err),
  };
}
