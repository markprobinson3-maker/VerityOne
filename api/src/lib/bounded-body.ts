// Shared byte-bounded body readers (batch-25 / batch-28).
//
// readBoundedFormBody mirrors readBoundedJsonBody for urlencoded HTML forms:
// it enforces the same declared + actual byte bounds and returns parsed form
// fields via URLSearchParams. ONLY suitable for application/x-www-form-urlencoded
// forms (hidden inputs, no file uploads). Routes that accept multipart bodies
// must continue to use c.req.parseBody() with separate size enforcement.

// Shared byte-bounded JSON body reader (batch-25).
//
// Several internet-facing write surfaces parsed `c.req.json()` with no byte
// ceiling — a peer could stream an unbounded body into memory before any
// route-local logic ran. `readBoundedRemoteJson` (routes/remote.ts) and
// `readBoundedBody` (routes/browser-capture.ts) each grew a private copy of the
// same guard; this is the shared, exported version for new VO-envelope sites
// (/account/connect/redeem, /machine/vault, /hosted-mcp write).
//
// It bounds the ACTUAL utf-8 byte length — not just the declared Content-Length,
// which can be omitted or chunked — and returns the standard VO error envelope
// on rejection. OAuth endpoints deliberately do NOT use this: they must emit
// spec-shaped errors, not the VO envelope (see routes/oauth.ts).
import type { Context } from "hono";
import { errorJson } from "./error-envelope";

export type BoundedJsonResult =
  | { ok: true; value: any }
  | { ok: false; response: Response };

export type BoundedFormResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Read and JSON-parse a request body, rejecting bodies whose declared OR actual
 * utf-8 size exceeds `maxBytes`. An empty body resolves to `{ ok: true, value: null }`
 * (callers null-guard their field reads). Never throws.
 */
export async function readBoundedJsonBody(c: Context, maxBytes: number): Promise<BoundedJsonResult> {
  const tooLarge = () =>
    ({
      ok: false as const,
      response: errorJson(c, "payload_too_large", {
        message: "Request body is too large.",
        details: { max_bytes: maxBytes },
      }),
    });

  const declared = Number(c.req.header("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Could not read request body." }) };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return tooLarge();
  if (raw.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Valid JSON body required." }) };
  }
}

/**
 * Read and URLSearchParams-parse a urlencoded form body, rejecting bodies
 * whose declared OR actual utf-8 size exceeds `maxBytes`. Only suitable for
 * application/x-www-form-urlencoded forms (hidden inputs, no file uploads).
 * An empty body resolves to `{ ok: true, value: {} }`. Never throws.
 */
export async function readBoundedFormBody(c: Context, maxBytes: number): Promise<BoundedFormResult> {
  const tooLarge = () =>
    ({
      ok: false as const,
      response: errorJson(c, "payload_too_large", {
        message: "Request body is too large.",
        details: { max_bytes: maxBytes },
      }),
    });

  const declared = Number(c.req.header("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, response: errorJson(c, "invalid_request", { message: "Could not read request body." }) };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return tooLarge();
  return { ok: true, value: Object.fromEntries(new URLSearchParams(raw)) };
}
