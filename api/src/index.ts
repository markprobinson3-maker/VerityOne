/**
 * Long-lived launcher for the local Bun API server (rung F3).
 *
 * This file is responsible for:
 *   1. Loading `.env` from the project root.
 *   2. Refusing to boot with `VERITY_DEPLOYMENT_PROFILE=serverless`
 *      (Vercel must use `api/index.ts`, not this launcher).
 *   3. Resolving the existing VO runtime profile
 *      (`tenant-default | full`).
 *   4. Probing the database with the pre-existing degraded-mode /
 *      `VERITY_DB_STRICT=on` semantics.
 *   5. Constructing the shared Hono app via `./app` and registering
 *      the long-lived-only miner-backed routes via
 *      `./long-lived-routes`.
 *   6. Running the pre-serve overlay normalization (fail-fast).
 *   7. Starting `Bun.serve(...)`, attaching the `/stream` WebSocket
 *      upgrade, and starting every long-lived background loop:
 *      `startChangeStream`, `startWorkerHeartbeat`, the profile-
 *      gated VI scheduler / maintenance cron, sync scheduler,
 *      grant renewal, overlay scheduler, expiry engine, remote
 *      command loop.
 *   8. Logging the startup banner with deployment profile + runtime
 *      profile + redacted DSN host.
 *   9. Wiring SIGINT/SIGTERM handlers.
 *
 * Why dynamic imports of `./app`, `./db`, `./ws`, etc.: ESM static
 * imports evaluate BEFORE the `dotenv` call at the top of this file,
 * which means anything that reads `process.env.DATABASE_URL` /
 * `VERITY_DEPLOYMENT_PROFILE` at module load (e.g. `./db` selecting a
 * pool factory) would observe an unloaded env. Dynamic imports
 * defer that evaluation until after `config(...)` returns.
 */

import { config } from "dotenv";
import { resolve } from "path";
import { getDatabaseUrl, getDeploymentProfile } from "./lib/db-config";

// 1. Load `.env` from the project root before any other module that
//    reads `process.env`.
config({ path: resolve(import.meta.dir, "../../.env") });

// 2. Reject serverless profile early. The Vercel function uses
//    `api/index.ts`, which sets a serverless default and exposes a
//    `fetch(request)` handler — it never starts `Bun.serve`.
const DEPLOYMENT_PROFILE = getDeploymentProfile();
if (DEPLOYMENT_PROFILE !== "long-lived") {
  console.error(
    `api/src/index.ts is the long-lived launcher; current ` +
      `VERITY_DEPLOYMENT_PROFILE=${DEPLOYMENT_PROFILE}.`,
  );
  console.error(
    "Use api/index.ts (Vercel function entrypoint) for serverless deployments.",
  );
  process.exit(1);
}

// 3. Redact the user/password from the DSN for the startup banner.
function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return dsn.replace(/:[^:@/]*@/, ":***@");
  }
}

// 4. Dynamic imports — happen AFTER `config()` ran above so any
//    module that touches `process.env` at load time sees the right
//    values.
const { app } = await import("./app");
const { registerLongLivedRoutes } = await import("./long-lived-routes");
const { sql: tocSql, probeDatabaseConnection } = await import("./db");
const { addClient, removeClient, startChangeStream } = await import("./ws");
const { startWorkerHeartbeat } = await import(
  "../../miners/src/lib/worker-heartbeat"
);
const { resolveAccessContextFromRequest } = await import("./lib/access");
const { resolveRuntimeProfile, resolveTenantSettings, formatProfileBanner, RuntimeProfileError } =
  await import("./lib/runtime-profile");

// 5. Probe the DB once during long-lived startup. Preserves the
//    degraded-mode / `VERITY_DB_STRICT=on` semantics that previously
//    fired at top of `db.ts`.
await probeDatabaseConnection();

const autoMigrate = process.env.VERITY_AUTO_MIGRATE === "1" || resolveTenantSettings().auto_migrate_on_boot === true;
if (autoMigrate) {
  const { applyPendingMigrations } = await import("../../scripts/run-migrations");
  const result = await applyPendingMigrations(tocSql);
  if (result.failed) {
    console.error(`[verity-api] migration ${result.failed.filename} failed: ${result.failed.error}`);
    process.exit(1);
  }
  if (result.applied > 0) {
    console.log(`[verity-api] applied ${result.applied} pending migrations on boot`);
  }
}

// 6. Register miner-backed routes. The shared app shell never
//    imports these directly; they live behind a long-lived gate.
await registerLongLivedRoutes(app);

// 6b. Preload the VI ingest adapter registry into THIS process so the
//     operator-facing /vi/adapters + /vi/schedules CRUD routes function
//     in BOTH runtime profiles. Loading the registry is metadata-only
//     (each *.adapter.ts module is side-effect-free at import; all
//     network/IO lives inside its extract()); it does NOT start any
//     ingestion — the timed VI scheduler stays gated to the `full`
//     profile below. Without this, `tenant-default` (the default) never
//     calls loadAdapters(), leaving the registry empty so every adapter
//     lookup 400s ("Unknown adapter") and GET /vi/adapters returns []. In
//     `full`, startScheduler() also calls loadAdapters() (idempotent —
//     registerAdapter is a Map.set) but only AFTER the listener is up;
//     doing it here pre-serve closes that window too. Non-fatal: adapter
//     discovery failing must not block the API from serving.
try {
  const { loadAdapters, listAdapters } = await import(
    "../../miners/src/vi/adapters/registry"
  );
  await loadAdapters();
  console.log(`[vi-adapters] loaded ${listAdapters().length} ingest adapters`);
} catch (e) {
  console.error(
    `[vi-adapters] adapter preload failed (non-fatal): ${(e as Error)?.message}`,
  );
}

const port = parseInt(process.env.VERITY_API_PORT || "3100");
const apiHostname = process.env.VERITY_API_BIND || "127.0.0.1";

// 7. Pre-serve overlay normalization. Imported overlay rows MUST be
//    normalized before serving recall. This guarantees
//    `substance.memory_type` and `substance.source_kind` exist on
//    all overlay rows, so recall can read them directly without
//    COALESCE fallback. If normalization fails for an existing
//    overlay space, startup aborts.
try {
  const { runStartupOverlayRepair } = await import("./lib/overlay-import");
  const repairResult = await runStartupOverlayRepair(tocSql);
  if (repairResult.ran && repairResult.repair) {
    if (repairResult.repair.rows_repaired > 0) {
      console.log(
        `[overlay-normalization] Pre-serve: repaired ${repairResult.repair.rows_repaired} of ${repairResult.repair.rows_scanned} imported overlay rows`,
      );
    }
  }
  // Not ran = no config / no tenant / no overlay space → proceed normally.
} catch (e) {
  console.error(
    `[overlay-normalization] FATAL: pre-serve normalization failed: ${(e as Error)?.message}`,
  );
  console.error(
    `[overlay-normalization] Cannot serve recall with denormalized overlay rows. Fix the issue and restart.`,
  );
  process.exit(1);
}

// 8. Start HTTP server with WebSocket upgrade.
const websocketHandler: import("bun").WebSocketHandler<undefined> = {
  open(ws) {
    addClient(ws as any);
  },
  close(ws) {
    removeClient(ws as any);
  },
  message(_ws, _msg) {
    // Clients don't send messages; this is a broadcast-only stream
  },
};

// Last-resort process safety net (launch-readiness scan 2026-06-07, P1).
// Without these, an unhandled rejection or uncaught exception in any async task
// (scheduler tick, worker, fire-and-forget enrichment) is INVISIBLE — on the
// tenant-default profile (no supervisor) it can mean silent downtime or silent
// data-drift with no root-cause log. Make both LOUD.
//   - uncaughtException leaves the process in an undefined state → log + exit so
//     a supervisor / launchd / the operator restarts on a clean boot.
//   - unhandledRejection is logged loudly but NOT fatal: crashing a live
//     tenant-serving node on a single stray rejection trades data-drift risk for
//     an availability outage. The loud log closes the "silent" gap (the scan's
//     actual concern) while preserving uptime.
process.on("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error("[unhandledRejection] (logged, non-fatal):", detail);
});
process.on("uncaughtException", (err: Error) => {
  console.error("[uncaughtException] fatal — exiting for clean restart:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});

const server = Bun.serve({
  port,
  hostname: apiHostname,
  idleTimeout: 60, // /insight needs time for Gemini calls
  fetch: app.fetch,
  websocket: websocketHandler,
});

// 9. Runtime profile resolution (shared helper; same resolver used
//    by the supervisor and vo-cli). Done at startup so the profile
//    and source are available for the banner, for the heartbeat
//    metadata, and for gating elastic subsystems below.
let runtimeProfileResolved: {
  profile: "tenant-default" | "full";
  source: "config_file" | "env_fallback" | "default";
};
try {
  runtimeProfileResolved = resolveRuntimeProfile();
} catch (e) {
  if (e instanceof RuntimeProfileError) {
    console.error(`[runtime-profile] ${e.message}`);
  } else {
    console.error(
      `[runtime-profile] unexpected resolver failure: ${(e as Error).message}`,
    );
  }
  process.exit(1);
}
const RUNTIME_PROFILE = runtimeProfileResolved.profile;
const RUNTIME_PROFILE_SOURCE = runtimeProfileResolved.source;

const apiHeartbeat = startWorkerHeartbeat({
  sql: tocSql,
  workerName: "api",
  role: "api",
  mode: "persistent",
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 60_000,
  metadata: {
    port,
    profile: RUNTIME_PROFILE,
    profile_source: RUNTIME_PROFILE_SOURCE,
    deployment_profile: DEPLOYMENT_PROFILE,
    scheduler_enabled: RUNTIME_PROFILE === "full",
    maintenance_cron_enabled: RUNTIME_PROFILE === "tenant-default",
    websocket_enabled: true,
  },
});

// 10. Upgrade /stream to WebSocket on operator scope only.
const originalFetch = app.fetch;
const wrappedFetch = async (req: Request, env?: any) => {
  const url = new URL(req.url);
  if (url.pathname === "/stream") {
    const access = resolveAccessContextFromRequest(req);
    if (access.scope !== "operator") {
      return new Response("Unauthorized", { status: 401 });
    }
    const upgraded = server.upgrade(req);
    if (upgraded) return undefined as any;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return originalFetch.call(app, req, env);
};

// Override the fetch handler so /stream requests go through the
// upgrade path before falling through to Hono.
server.reload({ fetch: wrappedFetch, websocket: websocketHandler });

// 11. Start change stream listener — long-lived only (already
//     gated inside `startChangeStream` itself for belt-and-braces).
startChangeStream();

// 11b. Ops alerting — the proactive consumer of /ops/runtime. Inert unless
//      ALERT_WEBHOOK_URL is set, so OSS installs and CI are unaffected.
//      Runs on BOTH long-lived profiles (a full node wants paging too).
import("./lib/ops-alert")
  .then(({ startOpsAlertPoller }) => {
    const handle = startOpsAlertPoller({ port });
    if (handle) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          try { handle.stop(); } catch { /* ignore */ }
        });
      }
    }
  })
  .catch((err: Error) => {
    console.error("ops-alert poller failed to start:", err?.message ?? err);
  });

// 12. Profile-gated subsystems per docs/VO-RUNTIME-PROFILES.md:
//     - startScheduler() is the heavier VI adapter scheduler → full only
//     - startMaintenanceCron() is the tenant-default T1 safety net → tenant-default only
//
// Both are started AFTER the HTTP listener is ready (Bun.serve returned
// above and server.reload has run). The maintenance cron's startup tick
// fires ~5s after this point, so /ops/runtime and `vo doctor` observers
// see a heartbeat inside their ~10s window.
if (RUNTIME_PROFILE === "full") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  import("../../miners/src/vi/scheduler")
    .then(({ startScheduler }) => {
      startScheduler()
        .then(() => {
          console.log("VI Scheduler running");
        })
        .catch((err: Error) => {
          console.error("VI Scheduler failed to start:", err.message);
        });
    })
    // The dynamic import itself can reject (module load error); without an outer
    // .catch that rejection is unhandled. The full profile has a supervisor, but
    // surface it loudly rather than silently.
    .catch((err: Error) => {
      console.error("VI Scheduler module failed to load:", err?.message ?? err);
    });
} else {
  // tenant-default: in-api maintenance cron instead of VI scheduler + supervisor workers
  import("./lib/maintenance-cron")
    .then(({ startMaintenanceCron }) => {
      const cronHandle = startMaintenanceCron(tocSql);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          try {
            cronHandle.stop();
          } catch {
            /* ignore */
          }
        });
      }
    })
    // Without this .catch the rejection is unhandled and SILENT: on tenant-default
    // there is no supervisor, so a failed import / startMaintenanceCron throw would
    // mean vacuum, orphan cleanup, and memory-expiry never run while /health still
    // reports ok — invisible per-tenant data-integrity drift. Match the sibling
    // schedulers and surface it loudly.
    .catch((err: Error) => {
      console.error("Maintenance cron failed to start:", err?.message ?? err);
    });
}

// 13. Sync scheduler — automatic background sync when hosted_sync = "outbound".
//     Uses the existing exportSyncBatch() path. Disable with VERITY_SYNC_SCHEDULER=off.
Promise.all([
  import("./lib/local-credential-store"),
  import("./lib/local-connect-state"),
  import("./lib/google-drive-state"),
])
  .then(([credentialStore, connectState, driveState]) => {
    const activeRefs: string[] = [];
    const connectAttempt = connectState.readLocalConnectAttempt();
    if (connectAttempt?.status === "expired") {
      connectState.clearLocalConnectAttempt();
    } else if (connectAttempt) {
      activeRefs.push(
        connectAttempt.state_secret_ref,
        connectAttempt.nonce_secret_ref,
        connectAttempt.pkce_verifier_secret_ref,
      );
    }

    const driveAttempt = driveState.readLocalDriveConnectAttempt();
    if (driveAttempt && new Date(driveAttempt.expires_at).getTime() <= Date.now()) {
      driveState.clearLocalDriveConnectAttempt();
    } else if (driveAttempt?.private_key_ref) {
      activeRefs.push(driveAttempt.private_key_ref);
    }

    const mirrorState = driveState.readLocalDriveMirrorState();
    if (mirrorState.token_secret_ref) activeRefs.push(mirrorState.token_secret_ref);
    credentialStore.sweepOrphanedLocalSecretFiles(activeRefs);
  })
  .catch((err) => {
    console.error("Local secret startup sweep failed:", err?.message);
  });

import("./lib/sync-scheduler")
  .then(async ({ startSyncScheduler }) => {
    const { readLocalSyncCredential } = await import("./lib/local-credential-store");
    const credential = readLocalSyncCredential();
    const hostedUrl =
      credential?.hosted_base_url || process.env.VOPLUS_API_URL || "https://verityone.app";
    const syncHandle = startSyncScheduler(tocSql, hostedUrl);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        try {
          syncHandle.stop();
        } catch {
          /* ignore */
        }
      });
    }
  })
  .catch((err) => {
    console.error("Sync scheduler failed to start:", err?.message);
  });

// 13b. Google Drive vault mirror worker — local-only. It writes metadata to
// the sync journal and never posts directly to hosted /sync/push.
if (process.env.VERITY_DRIVE_MIRROR !== "off" && process.env.VERITY_DRIVE_MIRROR_WORKER !== "off") {
  import("./lib/google-drive-worker")
    .then(({ startDriveMirrorWorker }) => {
      const driveHandle = startDriveMirrorWorker();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          try {
            driveHandle.stop();
          } catch {
            /* ignore */
          }
        });
      }
    })
    .catch((err) => {
      console.error("Drive mirror worker failed to start:", err?.message);
    });
}

// 13c. Day-journal routine scheduler — local-only. It creates scheduled
// routine run rows and executes routines outside the settings-row lock.
// Disable with VERITY_DAY_JOURNAL_ROUTINE_SCHEDULER=off.
import("./lib/day-journal/routine-scheduler")
  .then(({ startDayJournalRoutineScheduler }) => {
    const routineSchedulerHandle = startDayJournalRoutineScheduler(tocSql);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        try {
          routineSchedulerHandle.stop();
        } catch {
          /* ignore */
        }
      });
    }
  })
  .catch((err) => {
    console.error("Day-journal routine scheduler failed to start:", err?.message);
  });

// 14. Grant renewal — background renewal for customer-managed tenant grants.
//     Renews active grants nearing expiry. Does NOT refresh on request paths.
import("./lib/grant-renewal")
  .then(({ startGrantRenewalLoop }) => {
    const renewalHandle = startGrantRenewalLoop(tocSql);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        try {
          renewalHandle.stop();
        } catch {
          /* ignore */
        }
      });
    }
  })
  .catch((err) => {
    console.error("Grant renewal loop failed to start:", err?.message);
  });

// 15. Overlay scheduler — automatic background overlay pull when public_overlay_sync = "pull".
//     Uses the existing pullAndImportOverlays() path. Disable with VERITY_OVERLAY_SCHEDULER=off.
import("./lib/overlay-scheduler")
  .then(({ startOverlayScheduler }) => {
    const overlayHandle = startOverlayScheduler(tocSql);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        try {
          overlayHandle.stop();
        } catch {
          /* ignore */
        }
      });
    }
  })
  .catch((err) => {
    console.error("Overlay scheduler failed to start:", err?.message);
  });

// NOTE: Overlay normalization now runs pre-serve (above Bun.serve).
// The delayed auto-repair timer was removed because the pre-serve
// boundary guarantees normalization before first recall.

// 16. Memory expiry engine — transitions active memories past their expires_at.
//     45s startup delay, then every 5 minutes. Disable with VERITY_EXPIRY_ENGINE=off.
if (process.env.VERITY_EXPIRY_ENGINE !== "off") {
  import("./lib/memory-expiry")
    .then(({ startExpiryLoop }) => {
      const expiryHandle = startExpiryLoop(tocSql);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          try {
            expiryHandle.stop();
          } catch {
            /* ignore */
          }
        });
      }
    })
    .catch((err) => {
      console.error("Expiry engine failed to start:", err?.message);
    });
}

// 17. Remote command loop — polls hosted for pending commands via
//     HTTP, dispatches locally. 60s startup delay, then every 30
//     seconds. Disable with VERITY_REMOTE_COMMANDS=off. Requires
//     `tenant_id`, `access_token` (sync token), and a hosted URL in
//     config or env.
if (process.env.VERITY_REMOTE_COMMANDS !== "off") {
  const rcConfig = (() => {
    try {
      const fs = require("node:fs");
      const { resolveConfigPath } = require("./lib/runtime-profile");
      const {
        readLocalSyncCredential,
        readRawLocalSyncToken,
      } = require("./lib/local-credential-store");
      const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(), "utf-8"));
      const credential = readLocalSyncCredential();
      const hostedUrl =
        process.env.VOPLUS_API_URL || credential?.hosted_base_url || "https://verityone.app";
      const syncToken = readRawLocalSyncToken() || cfg.access_token; // vons_* sync token from federation registration
      return { tenantId: credential?.tenant_id || cfg.tenant_id, hostedUrl, syncToken };
    } catch {
      return null;
    }
  })();
  if (rcConfig?.tenantId && rcConfig?.syncToken) {
    import("./lib/remote-command-loop")
      .then(({ startRemoteCommandLoop }) => {
        const rcHandle = startRemoteCommandLoop(
          tocSql,
          rcConfig.tenantId,
          rcConfig.hostedUrl,
          rcConfig.syncToken,
        );
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          process.once(signal, () => {
            try {
              rcHandle.stop();
            } catch {
              /* ignore */
            }
          });
        }
      })
      .catch((err) => {
        console.error("Remote command loop failed to start:", err?.message);
      });
  }
}

// 18. Startup banner.
console.log(
  `📡 Verity deployment_profile=${DEPLOYMENT_PROFILE} runtime_profile=${RUNTIME_PROFILE} db=${redactDsn(getDatabaseUrl())}`,
);
console.log(`Verity One API running on http://${apiHostname}:${port}`);
console.log(`  ${formatProfileBanner(runtimeProfileResolved)}`);
console.log(`WebSocket stream at ws://${apiHostname}:${port}/stream`);

// 18b. Master-key readiness guard. env-wrapped tenant key domains can only be
//      unwrapped at runtime if VOPLUS_MASTER_KEY is configured + matches; when it
//      isn't, hosted reads fail closed with a 503 and NO per-request alert (TA1
//      Finding 1). Surface it loudly at boot. Read-only + non-fatal.
//      VO+ ONLY: gated on VOPLUS_MASTER_KEY so the open-core local node (which has
//      no hosted tenant key domains, and ships no ./lib/tenant-keys) skips both the
//      check and the dynamic import entirely — no spurious boot warning.
if (process.env.VOPLUS_MASTER_KEY) {
  try {
    const { checkMasterKeyReadiness } = await import("./lib/tenant-keys");
    const mk = await checkMasterKeyReadiness(tocSql);
    if (!mk.ok) {
      const bar = "!".repeat(76);
      console.warn(`\n${bar}\n⚠️  MASTER KEY NOT READY (${mk.level}) — ${mk.warning}\n${bar}\n`);
    } else if (mk.warning) {
      console.warn(`⚠️  master-key ${mk.level}: ${mk.warning}`);
    }
  } catch (err) {
    console.warn("master-key readiness check failed (non-fatal):", (err as Error)?.message);
  }
}

// 19. Signal handlers — flush heartbeat, stop server, exit cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void apiHeartbeat
      .stop({
        status: "stopped",
        metadata: {
          signal,
          port,
        },
      })
      .finally(() => {
        server.stop?.(true);
        process.exit(0);
      });
  });
}
