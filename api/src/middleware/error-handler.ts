/**
 * F8: top-level error-translation middleware + correlation id stamp.
 *
 * Registered in `api/src/app.ts` as the FIRST middleware (before any other
 * `app.use` / `app.route`):
 *   app.use("*", correlationIdMiddleware());
 *   app.use("*", errorHandler());
 *
 * The error handler converts:
 *   - thrown ApiError subclasses → canonical envelope via errorJson(c, err.code)
 *   - any other thrown Error → envelope with code "internal_error" + a hint
 *     pointing to the per-request correlation id; the original error is logged
 *     server-side but not leaked to the client
 *
 * The matching `app.onError(...)` registration in `app.ts` is the final
 * fallback for errors thrown synchronously inside route handlers (Hono
 * dispatches sync throws to onError, async throws bubble up to middleware).
 */

import type { Context, MiddlewareHandler } from "hono";
import { ApiError, errorJson } from "../lib/error-envelope";

export function correlationIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get("correlation_id")) {
      c.set("correlation_id", crypto.randomUUID());
    }
    await next();
  };
}

export function errorHandler(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      return translateError(c, err);
    }
  };
}

/**
 * Translate any thrown error into the canonical envelope. Used by both the
 * `errorHandler()` middleware and `app.onError(...)` so the two paths produce
 * identical responses.
 */
export function translateError(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return errorJson(c, err.code, {
      message: err.message,
      details: err.details,
      hint: err.hint,
    });
  }
  const correlationId =
    (c.get("correlation_id") as string | undefined) ?? crypto.randomUUID();
  const errorObj = err instanceof Error ? err : new Error(String(err));
  console.error(`[api:error] ${correlationId} ${errorObj.name}: ${errorObj.message}`);
  if (errorObj.stack) console.error(errorObj.stack);
  return errorJson(c, "internal_error", {
    hint: `Server logs reference correlation_id=${correlationId}`,
  });
}
