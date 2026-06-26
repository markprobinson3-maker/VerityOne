/**
 * Vercel function entrypoint (rung F3).
 *
 * Vercel routes all dynamic traffic through `vercel.json` rewrites
 * to this file. The handler:
 *
 *   1. Sets `VERITY_DEPLOYMENT_PROFILE` to `serverless` BEFORE
 *      importing any module under `./src/`. This guarantees that
 *      `./src/db` selects the pooled (`prepare: false`, `max: 2`)
 *      pool factory on cold start. Static imports from `./src/` are
 *      forbidden in this file — ESM evaluates those before this
 *      file's body runs, which would let `./src/db` cache the wrong
 *      pool config.
 *
 *   2. Short-circuits long-lived-only routes (/stream and the
 *      miner-backed/local-control surfaces /dashboard, /machine/vault,
 *      /browser-capture, /day-journal, /providers, /browser-session, /federation,
 *      /mining, /vi, /wi, /trends, /ops, /supercron) with a 503 BEFORE loading
 *      the shared Hono app, so
 *      a serverless cold start never imports local-control or miner
 *      modules even by accident.
 *
 *   3. Lazily loads `./src/app` and forwards everything else to
 *      Hono.
 *
 * What this file MUST NOT do:
 *   - Call `Bun.serve(...)` (Vercel owns the request loop).
 *   - Register `process.once(...)` signal handlers (Vercel hands
 *     each invocation a fresh function instance).
 *   - Start `startChangeStream`, `startWorkerHeartbeat`, or any
 *     `start*Loop` background worker.
 *   - Import `./src/long-lived-routes` (its imports drag in miner-
 *     local DB clients).
 */

// The @vercel/node CommonJS wrapper can see either the native ESM module
// shape or a double-wrapped interop shape. Keep this type loose and let
// resolveFetchApp perform the runtime fetch-app validation below.
type AppModule = Record<string, any>;
// Type-only import for the F8 envelope helper. Resolved lazily inside the
// handler to keep cold-start imports under serverless rules.
type ErrorEnvelopeModule = typeof import("./src/lib/error-envelope.js");

let appPromise: Promise<AppModule> | null = null;
let errorEnvelopePromise: Promise<ErrorEnvelopeModule> | null = null;

type FetchApp = {
  fetch(request: Request): Response | Promise<Response>;
};

function objectKeysForDebug(value: unknown): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort();
}

async function loadErrorEnvelope(): Promise<ErrorEnvelopeModule> {
  if (!errorEnvelopePromise) {
    errorEnvelopePromise = import("./src/lib/error-envelope.js");
  }
  return errorEnvelopePromise;
}

async function ensureServerlessDeploymentProfile(): Promise<Response | null> {
  const raw = (process.env.VERITY_DEPLOYMENT_PROFILE || "").trim();
  if (!raw) {
    // Vercel's env injection happens through `process.env`, so a
    // freshly cold-started function may have an empty
    // VERITY_DEPLOYMENT_PROFILE if the dashboard env was never set.
    // Default to serverless BEFORE importing app/db code.
    process.env.VERITY_DEPLOYMENT_PROFILE = "serverless";
    return null;
  }
  if (raw !== "serverless") {
    const { errorResponse } = await loadErrorEnvelope();
    return errorResponse("install_misconfigured", {
      message: "api/index.ts requires VERITY_DEPLOYMENT_PROFILE=serverless",
    });
  }
  return null;
}

function resolveFetchApp(mod: AppModule): FetchApp {
  const candidates = [
    mod.default,
    mod.app,
    (mod.default as any)?.default,
    (mod.default as any)?.app,
  ];
  const app = candidates.find((candidate): candidate is FetchApp => {
    return Boolean(candidate && typeof (candidate as FetchApp).fetch === "function");
  });
  if (!app) {
    throw new TypeError(
      `api/src/app did not export a Hono fetch app; module_keys=${objectKeysForDebug(mod).join(",") || "(none)"}; default_keys=${objectKeysForDebug(mod.default).join(",") || "(none)"}`,
    );
  }
  return app;
}

async function loadApp(): Promise<FetchApp> {
  if (!appPromise) {
    appPromise = import("./src/app.js");
  }
  const mod = await appPromise;
  return resolveFetchApp(mod);
}

const LONG_LIVED_PREFIX_RE =
  /^\/(?:dashboard|machine\/vault|browser-capture|day-journal|providers|browser-session|federation|mining|vi|wi|trends|ops|supercron)(?:\/|$)/;

export default {
  async fetch(request: Request): Promise<Response> {
    const profileError = await ensureServerlessDeploymentProfile();
    if (profileError) return profileError;

    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      const { errorResponse } = await loadErrorEnvelope();
      return errorResponse("service_unavailable", {
        message: "WebSocket unavailable in serverless profile; use polling endpoints",
      });
    }

    // /ops/backup-status is a deliberate exception: a standalone serverless-safe
    // router (api/src/routes/backup-status.ts, mounted in app.ts) handles it
    // without importing the long-lived ops surface, so operators can read the
    // hosted mirror's DR status from the serverless prod API.
    if (
      url.pathname !== "/ops/backup-status" &&
      LONG_LIVED_PREFIX_RE.test(url.pathname)
    ) {
      const { errorResponse } = await loadErrorEnvelope();
      return errorResponse("service_unavailable", {
        message: "Route unavailable in serverless profile",
      });
    }

    const app = await loadApp();
    return app.fetch(request);
  },
};
