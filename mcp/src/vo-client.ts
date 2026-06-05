/**
 * Thin localhost HTTP client for the local VO node.
 *
 * Per docs/VO-MCP-SERVER-CONTRACT.md:
 *   - talks only to the resolved base URL (default 127.0.0.1:3100)
 *   - never falls back to any public endpoint
 *   - maps generic local HTTP failures to ErrorClass values
 *
 * HTTP status → ErrorClass mapping (binding):
 *   ECONNREFUSED/ETIMEDOUT/DNS → local_vo_unreachable
 *   401/403                    → tenant_auth_failure
 *   400                        → validation_failure
 *   404                        → not_found
 *   409/413                    → validation_failure
 *   >=500 or non-JSON          → upstream_error
 */

import type { VoConfig } from "./config.js";
import {
  type ErrorClass,
  classifyFetchFailure,
} from "./errors.js";

export interface VoCallOk<T> {
  ok: true;
  status: number;
  body: T;
}

export interface VoCallErr {
  ok: false;
  errorClass: ErrorClass;
  status: number | null;
  message: string;
  detail: string;
  /**
   * Parsed JSON response body, when one was present and valid. Lets
   * tool handlers extract structured fields (e.g. `reason`) that the
   * server emits alongside the `error` text but that
   * `extractBodyMessage` would otherwise discard. Absent on
   * connection-level failures and non-JSON responses.
   */
  body?: unknown;
}

export type VoCallResult<T> = VoCallOk<T> | VoCallErr;

const DEFAULT_TIMEOUT_MS = 20_000;
export const VO_CLIENT_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

type BoundedResponseText =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "read_failed"; detail: string };

export class VoClient {
  constructor(private readonly config: VoConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get source(): VoConfig["source"] {
    return this.config.source;
  }

  async get<T>(pathname: string): Promise<VoCallResult<T>> {
    return this.request<T>("GET", pathname, undefined, /* anonymous */ false);
  }

  async post<T>(pathname: string, body: unknown): Promise<VoCallResult<T>> {
    return this.request<T>("POST", pathname, body, /* anonymous */ false);
  }

  /**
   * Anonymous GET — used by rung-4 public-feed tools per non-negotiable #17.
   *
   * Identical to `get<T>()` except:
   *   - NO `Authorization` header is sent
   *   - the access layer in `api/src/lib/access.ts` resolves the request to
   *     `scope: "anonymous"` with `spaceIds: [GLOBAL_SPACE_ID]`, structurally
   *     restricting results to the public graph at the SQL layer
   *
   * The same shared ErrorClass mapping applies. `tenant_auth_failure` is
   * structurally impossible from this code path because no token is sent;
   * if it ever appears from a rung-4 tool, the implementation has drifted
   * (probably by accidentally using `get` instead of `getAnonymous`).
   */
  async getAnonymous<T>(pathname: string): Promise<VoCallResult<T>> {
    return this.request<T>("GET", pathname, undefined, /* anonymous */ true);
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    body: unknown,
    anonymous: boolean,
  ): Promise<VoCallResult<T>> {
    const url = `${this.config.baseUrl}${pathname}`;
    const headers: Record<string, string> = {};
    if (!anonymous) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
      const status = response.status;
      const read = await readBoundedResponseText(response);
      if (!read.ok) {
        return {
          ok: false,
          errorClass: "upstream_error",
          status,
          message: read.reason === "too_large"
            ? "local VO response too large"
            : "local VO response read failed",
          detail: read.detail,
        };
      }

      const text = read.text;
      let parsed: unknown = null;
      let parseFailed = false;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parseFailed = true;
        }
      }

      if (status >= 200 && status < 300) {
        if (parseFailed) {
          return {
            ok: false,
            errorClass: "upstream_error",
            status,
            message: "local VO returned non-JSON response",
            detail: truncateCodePoints(text, 400),
          };
        }
        return { ok: true, status, body: parsed as T };
      }

      if (status === 401 || status === 403) {
        return {
          ok: false,
          errorClass: "tenant_auth_failure",
          status,
          message: `local VO rejected tenant token (HTTP ${status})`,
          detail: extractBodyMessage(parsed, text),
          ...(parsed !== null ? { body: parsed } : {}),
        };
      }

      if (status === 404) {
        return {
          ok: false,
          errorClass: "not_found",
          status,
          message: extractBodyError(parsed) || "local VO resource not found",
          detail: extractBodyMessage(parsed, text),
          ...(parsed !== null ? { body: parsed } : {}),
        };
      }

      if (status === 400 || status === 409 || status === 413) {
        return {
          ok: false,
          errorClass: "validation_failure",
          status,
          message: "local VO rejected request body",
          detail: extractBodyMessage(parsed, text),
          ...(parsed !== null ? { body: parsed } : {}),
        };
      }

      return {
        ok: false,
        errorClass: "upstream_error",
        status,
        message: `local VO returned HTTP ${status}`,
        detail: extractBodyMessage(parsed, text),
        ...(parsed !== null ? { body: parsed } : {}),
      };
    } catch (e) {
      const { errorClass, detail } = classifyFetchFailure(e);
      return {
        ok: false,
        errorClass,
        status: null,
        message:
          errorClass === "local_vo_unreachable"
            ? `local VO unreachable at ${this.config.baseUrl}`
            : `local VO request failed`,
        detail,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedResponseText(response: Response): Promise<BoundedResponseText> {
  const declared = declaredContentLength(response);
  if (declared !== null && declared > VO_CLIENT_MAX_RESPONSE_BODY_BYTES) {
    await cancelResponseBody(response);
    return {
      ok: false,
      reason: "too_large",
      detail:
        `Response Content-Length ${declared} exceeds ` +
        `${VO_CLIENT_MAX_RESPONSE_BODY_BYTES} byte MCP cap.`,
    };
  }

  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > VO_CLIENT_MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already being rejected; cancellation is best effort.
        }
        return {
          ok: false,
          reason: "too_large",
          detail:
            `Response body exceeded ${VO_CLIENT_MAX_RESPONSE_BODY_BYTES} ` +
            `byte MCP cap while streaming.`,
        };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { ok: true, text: parts.join("") };
  } catch (e) {
    if (isAbortError(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "read_failed",
      detail: truncateCodePoints(message, 400),
    };
  }
}

function isAbortError(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in value &&
      (value as { name?: unknown }).name === "AbortError",
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The caller is rejecting this response already; cancellation is best effort.
  }
}

/**
 * Pull a structured `reason` out of a VoCallErr body, when one exists
 * and is a string. Use from tool handlers that want to surface the
 * server's sub-reason into the MCP error envelope.
 */
export function extractReason(err: VoCallErr): string | undefined {
  if (!err.body || typeof err.body !== "object") return undefined;
  const reason = (err.body as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

function extractBodyMessage(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (Array.isArray(obj.errors)) return truncateCodePoints(JSON.stringify(obj.errors), 400);
  }
  return truncateCodePoints(raw, 400);
}

function extractBodyError(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const error = (parsed as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function truncateCodePoints(value: string, maxChars: number): string {
  let out = "";
  let count = 0;
  for (const ch of value) {
    if (count >= maxChars) break;
    out += ch;
    count += 1;
  }
  return out;
}
