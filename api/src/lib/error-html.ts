/**
 * F8: minimal HTML/text renderer for browser-facing failure pages.
 *
 * Browser routes (`admin.ts`, `portal-web.ts`, OAuth consent forms) cannot
 * return JSON envelopes — they need to render an HTML error page. `errorHtml`
 * produces a sanitized page that includes the error code + correlation id but
 * never interpolates raw exception text or `(e as Error).message`.
 *
 * JSON API routes must continue to use `errorJson(...)` from `error-envelope.ts`.
 */

import type { Context } from "hono";
import { type ErrorCode, defaultMessageFor } from "./error-codes";
import { httpStatusFor } from "./error-envelope";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ErrorHtmlOptions {
  /** Optional page title (defaults to a humanized code). */
  title?: string;
  /** Public-safe message (defaults to the controlled-vocab message for the code). */
  message?: string;
  /** Operator hint, displayed below the message. Public-safe text only. */
  hint?: string;
  /** Correlation id from `c.get("correlation_id")` — included for ops trace. */
  correlationId?: string;
}

export function errorHtml(
  c: Context,
  code: ErrorCode,
  opts: ErrorHtmlOptions = {},
): Response {
  const status = httpStatusFor(code);
  const title = opts.title ?? humanize(code);
  const message = opts.message ?? defaultMessageFor(code);
  const corr = opts.correlationId ?? (c.get("correlation_id") as string | undefined);

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Verity One</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 640px; margin: 4rem auto; padding: 0 1.5rem; color: #222; }
    h1 { font-size: 1.5rem; margin-bottom: .5rem; }
    .code { font-family: ui-monospace, "SF Mono", monospace;
            background: #f4f4f5; padding: 2px 6px; border-radius: 3px; font-size: .9rem; }
    .hint { color: #555; margin-top: 1rem; }
    .corr { color: #888; font-size: .8rem; margin-top: 2rem; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p class="code">code: ${escapeHtml(code)} · status: ${status}</p>
  ${opts.hint ? `<p class="hint">${escapeHtml(opts.hint)}</p>` : ""}
  ${corr ? `<p class="corr">correlation_id=${escapeHtml(corr)}</p>` : ""}
</body>
</html>`;

  return c.html(body, status as any);
}

function humanize(code: ErrorCode): string {
  return code
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
