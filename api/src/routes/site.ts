/**
 * Public homepage — VO-WEBSITE-HOMEPAGE-PR-1
 *
 * Seam for the content-negotiated root:
 *   GET / with Accept containing text/html (and not application/json)
 *     → renderHomepage()
 *   everything else (wildcard, empty, missing, application/json)
 *     → the existing machine-facing discovery JSON in api/src/index.ts
 *
 * This module only exports pure functions — no Hono app, no side effects —
 * so tests and the root dispatcher can both consume it cleanly:
 *   - prefersHtml(accept)  → content-negotiation predicate
 *   - renderHomepage()     → the full HTML document as a string
 *
 * Visual language:
 *   - Reuses HOSTED_TOKENS + tokenCssBlock("hosted") + SHARED_SEAM_MARKER
 *     from ui-style.ts so typography, spacing, and palette stay in sync
 *     with the hosted portal.
 *   - Does NOT import SHARED_COMPONENT_CSS or authorityBadge / fullHeader /
 *     compactHeader — those are dashboard grammar. The public homepage
 *     defines its own layout vocabulary (site-hero, site-section,
 *     site-path, site-usecase, site-system, site-authority, site-footer)
 *     so the explainer surface does not drift toward dashboard chrome.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { errorJson } from "../lib/error-envelope";

// ─── Content negotiation ────────────────────────────────────────────────

/**
 * Strict rule for serving HTML at `/`:
 *   - Missing / empty Accept → JSON (caller made no claim — default is
 *     machine-readable discovery)
 *   - `*` / `*​/*` wildcard → JSON (curl default, generic HTTP client)
 *   - Any `application/json` in the Accept list → JSON (machine caller)
 *   - Only when the caller names `text/html` AND has not also named
 *     `application/json` → HTML
 *
 * This preserves the existing JSON contract for every machine caller and
 * every default-Accept test in scripts/smoke-test.sh and
 * api/src/routes/smoke.test.ts. Browsers — which send
 * `text/html,application/xhtml+xml,application/xml;q=0.9,image/...,*​/*;q=0.8`
 * — receive HTML.
 */
export function prefersHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const a = accept.toLowerCase().trim();
  if (a === "" || a === "*/*") return false;
  if (a.includes("application/json")) return false;
  return a.includes("text/html");
}

/**
 * Merge a new Vary dimension into any existing Vary header value without
 * overwriting what an upstream middleware already set. betaCors sets
 * `Vary: Origin` in its before-phase for cross-origin callers; the root
 * handler adds `Vary: Accept` for the HTML-vs-JSON split — both
 * dimensions matter, and overwriting one for the other breaks either
 * CORS cache correctness or the content-negotiation cache correctness.
 *
 * Returns a single comma-separated header value (preferred over multiple
 * Vary headers). De-duplicates case-insensitively.
 */
export function mergeVary(existing: string | null | undefined, addition: string): string {
  const target = addition.trim();
  if (!existing || !existing.trim()) return target;
  const tokens = existing.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.some((t) => t.toLowerCase() === target.toLowerCase())) return existing;
  return `${existing}, ${target}`;
}

// ─── Copy constants ─────────────────────────────────────────────────────
//
// The canonical hero headline, 40-word-budget subhead, quick-start intro,
// trust/authority summary, and per-use-case blocks live here so they can
// be changed in one place and so tests can assert them directly against
// this module if needed.
//
// Word-budget audit (hero subhead ≤ 40, quick-start intro ≤ 30,
// use cases ≤ 50 each, trust summary ≤ 100). These limits and
// audited counts are enforced by api/src/routes/site.test.ts:
//   - HERO_SUBHEAD: 33 words ✓ (budget ≤ 40)
//   - QUICKSTART_INTRO: 28 words ✓ (budget ≤ 30)
//   - USECASE_RESEARCH_BODY: 36 words ✓ (budget ≤ 50)
//   - USECASE_CODING_BODY: 44 words ✓ (budget ≤ 50)
//   - USECASE_OPS_BODY: 35 words ✓ (budget ≤ 50)
//   - TRUST_SUMMARY: 49 words ✓ (budget ≤ 100)



// ─── Release channel (VO-VERCEL-RELEASE-CHANNEL-BOOTSTRAP-PR-1) ─────────
//
// One VO-controlled public release channel. The canonical source-of-
// truth files are checked in under deploy/public/ — Vercel serves
// them statically at verityone.app, AND the local API reads the
// SAME files and serves them on the same paths, so:
//
//   - the desktop VO app seam's eventual CHANNEL_LIVE flip lands on
//     real endpoints that match exactly what tests cover here
//   - local dogfooding + integration tests can exercise the same
//     contract without a network round-trip
//   - there is NO second hosted Hono app — Vercel is pure static
//     serving; the local Hono app is the only runtime renderer
//
// Both helpers read from disk at request time (tiny files, < 10KB
// combined) so a mis-edit to the canonical JSON or HTML is caught
// by the next test run rather than captured into a stale build
// artifact.

/**
 * Absolute path to the repo-root deploy/public directory where the
 * checked-in release-channel assets live. Resolved from this file's
 * own location so it keeps working whether the api package is run
 * from the monorepo root or from `api/` directly.
 */
export function resolveDeployPublicRoot(): string {
  // Vercel's @vercel/node wrapper may execute transpiled route modules as
  // CommonJS, so this helper must avoid Bun-only module-directory syntax.
  for (const root of [process.cwd(), join(process.cwd(), "..")]) {
    const candidate = join(root, "deploy", "public");
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "deploy", "public");
}

/**
 * Expected shape of the stable-channel release manifest. Kept
 * intentionally narrow — `channel` + `version` are the only
 * strictly-required fields; everything else is optional so future
 * bumps can add fields without breaking existing readers. Desktop's
 * future fetch will parse this shape (already pinned by
 * parseLatestVoVersionFromManifest in desktop/src/vo-app.ts, which
 * reads top-level `version`).
 *
 * `install` — source-install block, authoritative source-mode
 * target for ensure-current. Present today; unchanged.
 *
 * `packages` — VO-NATIVE-PACKAGING-DESIGN-PR-1 §7.2 extension.
 * List of prebuilt signed artifacts (one per platform per kind).
 * Optional; manifests without `packages[]` are source-only and
 * older readers ignore the field. This bootstrap does NOT ship
 * live packaged entries — the on-disk
 * `deploy/public/releases/stable.json` stays source-only until the
 * full signed-artifact release flow exists. The typed shape is here
 * so manifest parsing (engine side + any test fixtures) has one
 * source of truth.
 */
export interface StableReleaseManifestPackage {
  kind: "vo-cli" | "verity-one-app";
  /** Rust-style triple: `darwin-arm64`, `darwin-x64`, etc. */
  platform: string;
  /** Absolute http(s) URL to the signed artifact container. */
  artifact_url: string;
  /** Hex-encoded sha256 of the artifact container (the exact bytes
   *  served at `artifact_url`). Required — sha256 verification is
   *  non-negotiable per the design's §11.1 trust posture. */
  artifact_sha256: string;
  artifact_size_bytes?: number;
  signature: {
    kind: "apple-codesign-notarized";
    /** Informational / auditable only. The engine verifies the
     *  signer identity against a Team ID pinned in its own compiled
     *  source code, NOT against this field (which an unsigned
     *  manifest cannot be trusted to be the source of). */
    team_id?: string;
  };
}

export interface StableReleaseManifest {
  channel: string;
  version: string;
  published_at?: string;
  download_url?: string;
  notes_url?: string;
  artifacts?: Record<string, string>;
  install?: unknown;
  packages?: StableReleaseManifestPackage[];
}

export function readStableManifest(): StableReleaseManifest {
  const p = join(resolveDeployPublicRoot(), "releases", "stable.json");
  const raw = readFileSync(p, "utf-8");
  return JSON.parse(raw) as StableReleaseManifest;
}


/**
 * Live authoritative stable-release manifest URL — hosted at the
 * branded download origin. The local node's `/releases/stable.json`
 * route proxies THIS file (not the embedded on-disk snapshot) so
 * the same path means the same thing in both origins:
 *
 *   hosted  → LIVE authoritative branded manifest
 *   local   → same LIVE authoritative manifest (proxied from hosted)
 *
 * The ensure-current engine also reads this URL via the
 * resolved-channel `apiUrl`. There is one authority, one URL.
 */
export const STABLE_MANIFEST_LIVE_URL = "https://download.verityone.app/releases/stable.json";

/**
 * Handler body for local `GET /releases/stable.json`.
 *
 * Fetches the live authoritative manifest from
 * `STABLE_MANIFEST_LIVE_URL` and returns those bytes. If the
 * fetch fails (network error, non-200 upstream), the route
 * returns a structured failure envelope with an explicit
 * `error_class` — it does NOT silently fall back to the embedded
 * on-disk snapshot. Inspection of the embedded snapshot lives at
 * `GET /releases/local-snapshot/stable.json`, a separately named
 * route with explicit snapshot semantics.
 *
 * The fetcher is injected so tests can exercise both the success
 * and failure paths without real network calls. Production
 * callers (api/src/index.ts) omit the dep bag and the default
 * `fetch` is used.
 */
export interface LiveManifestDeps {
  /** Replace with a fake in tests. Defaults to global fetch. */
  fetcher?: (url: string) => Promise<Response>;
  /** Override the URL in tests. Defaults to STABLE_MANIFEST_LIVE_URL. */
  liveUrl?: string;
}

/** Bound the upstream body we echo in failure envelopes so a
 *  megabyte of HTML from a misconfigured intermediary can't blow
 *  up the local response. 1 KiB is enough to diagnose upstream-
 *  error / HTML-error-page / JSON-parse failures without
 *  leaking a full body into the envelope. */
const UPSTREAM_BODY_SNIPPET_LIMIT = 1024;

const SNAPSHOT_ROUTE_HINT =
  "The local /releases/stable.json route proxies the live authoritative manifest and does NOT silently fall back to the on-disk snapshot. " +
  "If you need offline inspection, use GET /releases/local-snapshot/stable.json.";

function truncateForEnvelope(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `… [truncated; ${text.length - limit} more chars]`;
}

export async function serveLiveStableManifest(
  c: { header: (k: string, v: string) => void; json: (body: unknown, status?: number) => Response },
  deps: LiveManifestDeps = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? ((url: string) => fetch(url));
  const liveUrl = deps.liveUrl ?? STABLE_MANIFEST_LIVE_URL;
  c.header("Content-Type", "application/json; charset=utf-8");

  // Step 1: transport layer. A throw here is genuine transport
  // failure (DNS, ECONNREFUSED, TLS error, abort). Anything that
  // came back from the network, even a 5xx, does NOT throw here.
  let upstream: Response;
  try {
    upstream = await fetcher(liveUrl);
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "transport error fetching live manifest",
        authoritative_url: liveUrl,
      },
      hint: "Network / transport error fetching the live manifest. " + SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 2: read the upstream body ONCE as text. This means we
  // can echo it in failure envelopes (bounded) for diagnosis, AND
  // we never throw here on a non-JSON body — a later JSON.parse
  // decides whether the body looked like the manifest we expected.
  let rawBody: string;
  try {
    rawBody = await upstream.text();
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "upstream body read failed",
        upstream_status: upstream.status,
        authoritative_url: liveUrl,
      },
      hint: SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 3: upstream non-OK. Include the upstream body (bounded)
  // in the envelope so a curl consumer can see the real reason —
  // a Vercel 500 with a stack trace, a WAF 403 page, a 404 HTML
  // error page from an intermediary, etc. Collapsing this into
  // "upstream returned HTTP <n>" would throw away load-bearing
  // diagnostic info.
  if (!upstream.ok) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    const code = upstream.status === 500
      ? "internal_error"
      : upstream.status === 501
        ? "not_implemented"
        : upstream.status === 502
          ? "bad_gateway"
          : upstream.status >= 500
            ? "service_unavailable"
            : "bad_gateway";
    return errorJson(c as unknown as Context, code, {
      message: "live_manifest_unavailable",
      details: {
        detail: `upstream returned HTTP ${upstream.status}`,
        upstream_status: upstream.status,
        upstream_body: truncateForEnvelope(rawBody, UPSTREAM_BODY_SNIPPET_LIMIT),
        authoritative_url: liveUrl,
      },
      hint: SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 4: upstream 2xx. Parse the body as JSON. If it isn't
  // JSON (HTML error page returned with a 200 by an intermediary,
  // a proxy that rewrote the body, cache poisoning, whatever),
  // fail honestly with the parse error + a snippet of the body
  // — do NOT throw through to the transport-error path, which
  // would misclassify a content-type failure as a network
  // failure and lose the body entirely.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "upstream 2xx body was not valid JSON",
        upstream_status: upstream.status,
        upstream_body: truncateForEnvelope(rawBody, UPSTREAM_BODY_SNIPPET_LIMIT),
        authoritative_url: liveUrl,
      },
      hint:
        "The upstream returned a successful status but a body that didn't parse as JSON. " +
        "An intermediary, cache, or WAF may be rewriting the response. " +
        SNAPSHOT_ROUTE_HINT,
    });
  }

  c.header("X-Manifest-Source", "live-authoritative");
  c.header("X-Manifest-Authoritative-Url", liveUrl);
  return c.json(parsed);
}

/**
 * Handler body for local `GET /releases/local-snapshot/stable.json`.
 *
 * Returns the embedded `deploy/public/releases/stable.json` bytes
 * at the tenant's install sha. Distinct route, distinct semantics:
 * this is for dev / dogfood / offline inspection only. The route
 * is explicitly named `local-snapshot` so no URL consumer can
 * mistake it for the authority.
 *
 * Ships explicit honesty headers:
 *   X-Manifest-Source: local-snapshot
 *   X-Manifest-Authoritative-Url: <STABLE_MANIFEST_LIVE_URL>
 */
export function serveLocalSnapshotStableManifest(c: {
  header: (k: string, v: string) => void;
  json: (body: unknown) => Response;
}): Response {
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("X-Manifest-Source", "local-snapshot");
  c.header("X-Manifest-Authoritative-Url", STABLE_MANIFEST_LIVE_URL);
  return c.json(readStableManifest());
}
