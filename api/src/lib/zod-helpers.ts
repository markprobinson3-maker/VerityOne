/**
 * F8: zod-backed request validation helpers.
 *
 * `validateRequest(c, schema, source?, opts?)` is the canonical input gate
 * for routes accepting a JSON, query, param, or form body. It throws an
 * `ApiError` subclass on failure; the top-level `errorHandler` middleware
 * translates the throw into the canonical error envelope.
 *
 * Reusable atomic schemas (TenantId, SpaceId, Addr, ProjectAddr, etc.)
 * live here so per-route schemas can compose them.
 */

import type { Context } from "hono";
import { z } from "zod";
import { ApiError, ValidationFailedError, sanitizeZodIssues } from "./error-envelope";

export type ValidateRequestSource = "json" | "query" | "param" | "form";

export interface ValidateRequestOptions {
  /** Maximum body size in bytes for "json" source. Performs Content-Length preflight + UTF-8 size check. */
  maxBytes?: number;
  /** When true, reject `application/json`-incompatible content types upfront (default: false — Hono's c.req.json() is permissive). */
  requireJsonContentType?: boolean;
  /** When true, parse multi-value form fields as arrays (Hono parseBody { all }). */
  allFormFields?: boolean;
}

/**
 * Validate a request and return the parsed, type-safe payload.
 *
 * On parse failure: throws `ValidationFailedError` (translates to HTTP 400
 * with `code: "validation_failed"` and sanitized issue list).
 * On JSON parse error / oversized body / unsupported media type: throws
 * `ApiError("invalid_request" | "payload_too_large" | "unsupported_media_type")`.
 */
export async function validateRequest<T>(
  c: Context,
  schema: z.ZodType<T>,
  source: ValidateRequestSource = "json",
  opts: ValidateRequestOptions = {},
): Promise<T> {
  let raw: unknown;
  try {
    if (source === "json") {
      if (opts.requireJsonContentType) {
        const ct = c.req.header("content-type") || "";
        if (!/^application\/json\b/i.test(ct)) {
          throw new ApiError("unsupported_media_type");
        }
      }
      if (opts.maxBytes !== undefined) {
        const cl = Number(c.req.header("content-length") || "0");
        if (Number.isFinite(cl) && cl > opts.maxBytes) {
          throw new ApiError("payload_too_large");
        }
        const text = await c.req.text();
        if (new Blob([text]).size > opts.maxBytes) {
          throw new ApiError("payload_too_large");
        }
        raw = text === "" ? undefined : JSON.parse(text);
      } else {
        raw = await c.req.json();
      }
    } else if (source === "query") {
      raw = c.req.query();
    } else if (source === "form") {
      raw = await c.req.parseBody({ all: opts.allFormFields });
    } else {
      raw = c.req.param();
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("invalid_request", "Body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationFailedError(sanitizeZodIssues(parsed.error.issues));
  }
  return parsed.data;
}

// ============================================================================
// Reusable atomic schemas — compose into per-route schemas
// ============================================================================

/** Tenant identifier (lowercase alphanumeric + hyphen/underscore, 1–64 chars). */
export const TenantIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, {
  message: "tenant_id must be 1-64 chars of lowercase alphanumerics, hyphen, underscore",
});

/** Space identifier — `tenant:<id>` or `overlay:<id>`. */
export const SpaceIdSchema = z.string().regex(/^(tenant|overlay):[a-z0-9_-]+$/, {
  message: "space_id must be tenant:<id> or overlay:<id>",
});

/** Canonical node address — `<PREFIX>.<n>.<n>.<n>` plus the day/anchor exceptions. */
export const AddrSchema = z.string().regex(
  /^[A-Z]{2,5}(\.\d+){3}$|^TMP\.\d{4}\.\d{1,3}$|^AO\.0\.0\.0$/,
  { message: "addr must be a canonical node address" },
);

/** Project address — `PJ.0.<n>.<n>` (depth 1 within PROJECTS pyramid). */
export const ProjectAddrSchema = z.string().regex(/^PJ\.0\.\d+\.\d+$/, {
  message: "project addr must match PJ.0.<n>.<n>",
});

/** Pyramid identifier — uppercase alphanumeric, 2–10 chars. */
export const PyramidIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, {
  message: "pyramid_id must be 2-10 uppercase alphanumeric chars",
});

/** Confidence score 0..1 inclusive. */
export const ConfidenceSchema = z.number().min(0).max(1);

/** Memory kinds — keep in sync with memory-contract.ts. */
export const MemoryKindSchema = z.enum([
  "context",
  "decision",
  "preference",
  "correction",
  "pattern",
  "vision",
  "changelog",
  "digest",
]);

/** Source kinds — keep in sync with memory-contract.ts. */
export const SourceKindSchema = z.enum([
  "user_accepted",
  "agent_inferred",
  "agent_corrected",
  "system_generated",
]);

/** ISO date or datetime string. */
export const IsoDateSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "expected ISO date or datetime",
});

/** Convenience: trimmed non-empty string with optional max length. */
export function trimmedString(opts?: { min?: number; max?: number }) {
  let s = z.string().transform((v) => v.trim());
  if (opts?.min !== undefined) s = s.refine((v) => v.length >= (opts.min as number), { message: `length >= ${opts.min}` });
  if (opts?.max !== undefined) s = s.refine((v) => v.length <= (opts.max as number), { message: `length <= ${opts.max}` });
  return s;
}
