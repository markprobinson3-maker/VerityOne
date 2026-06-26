/**
 * /machine/vault/* — JSON surface for local automation agents.
 *
 * VO-LOCAL-MCP-HARVEST-OPERATOR-PR-1.
 *
 * This route prefix exists so local MCP (and any future local-automation
 * client) can trigger harvest against the shared engine without going
 * through the dashboard's HTML surface. It is deliberately narrow:
 *
 *   - JSON-only (no HTML fragments, no presenter reuse)
 *   - tenant-bearer authenticated (MCP carries exactly one tenant-scoped
 *     token per docs/VO-MCP-SERVER-CONTRACT.md — no operator channel)
 *   - the server is the harvest authority: the vault root comes from
 *     `resolveConfiguredVaultRoot` and `readVaultDashboardState(...)`
 *     enforces the same "ready" gate the dashboard UI uses
 *   - returns the shared engine's `AutoOutcome` verbatim so honest stops
 *     (missing key / VO unavailable / all_writes_failed / finalize
 *     conflict / unknown) carry their precise taxonomy through to MCP
 *
 * Why not 409/validation status codes for stop points:
 *
 *   Engine outcomes — success AND every `stop_*` — travel as 200 with
 *   `{ ok: true, outcome: AutoOutcome }`. Pre-engine gate refusals (vault
 *   not ready, bad input) travel as 200 with
 *   `{ ok: false, kind: "precondition", status_kind, reason, message }`.
 *   This keeps MCP's 4-class ErrorClass mapping in mcp/src/vo-client.ts
 *   intact — 409 would be flattened to `upstream_error` and MCP would
 *   lose the precise stop reason.
 *
 *   Only truly malformed requests return 400 and only bearer-auth
 *   failures return 401/403. Both map cleanly through VoClient.
 */

import { Hono } from "hono";
import path from "node:path";
import { sql } from "../db";
import { getAccessContext } from "../lib/access";
import { errorJson, ApiError } from "../lib/error-envelope";
import { readBoundedJsonBody } from "../lib/bounded-body";
import { auditMutation } from "../lib/audit";

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

const machineVault = new Hono();

// Byte ceiling for /machine/vault JSON bodies (batch-25 #3). Vault config
// payloads (root path, harvest opts) are small; cap well under the 2MB norm.
const MACHINE_VAULT_MAX_BODY_BYTES = 256_000;

/**
 * Test-only override for the harvest engine. Production leaves this
 * `null` and the route dynamically imports `runVaultHarvestAuto`. Tests
 * set a stub via `__setHarvestRunnerForTests(...)` so the route can be
 * driven through representative AutoOutcomes without touching the real
 * filesystem / HTTP / LLM layers.
 *
 * Mirrors the test seam in api/src/routes/dashboard.ts so both facades
 * have matching test posture against the same engine.
 */
type HarvestRunnerFn = (typeof import("../lib/vault-harvest"))["runVaultHarvestAuto"];
let harvestRunnerOverride: HarvestRunnerFn | null = null;
export function __setHarvestRunnerForTests(fn: HarvestRunnerFn | null): void {
  harvestRunnerOverride = fn;
}

// ── POST /machine/vault/harvest-auto ──────────────────────────────────
//
// Inputs  : { source: string }
//   - `source` may be an absolute file path or a URL; the engine
//     normalizes either via `runVaultHarvest`.
//   - No `vault_root` argument is accepted. The server's configured
//     root is authoritative. Accepting a client-supplied root would
//     let a caller point the engine at an arbitrary filesystem path,
//     trivially bypassing the tenant binding + readiness gate.
//
// Auth    : tenant-scoped bearer via `Authorization: Bearer <token>`.
//   - `access.tenantId` must be non-null (beta/agent scope).
//   - The tenant bearer flows straight into the engine as
//     `tenantToken` for /memory/write (unlike the dashboard route,
//     which accepts operator auth and then reverse-looks-up a
//     tenant-scoped bearer server-side).
//
// Outputs:
//   - 200 { ok: true, outcome }                         — engine ran
//   - 200 { ok: false, kind: "precondition", ... }      — gate refused
//   - 400 canonical error envelope                       — bad input
//   - 401/403                                           — bearer rejected
//
// Doc-link honesty:
//   - /ops/link-doc requires operator auth. The route resolves a server-
//     side operator token from the first entry of VERITY_OPERATOR_TOKENS
//     if present; otherwise `operatorToken: null` and the engine skips
//     link-doc honestly (the outcome's `docLink` surfaces the skip).
//   - No operator token ever passes through the MCP client or the
//     request body.

machineVault.post("/harvest-auto", async (c) => {
  const access = getAccessContext(c);
  // Rung-7 auth narrowing (documented contract): harvest-auto needs a
  // bearer that resolves to a non-null `access.tenantId` so the engine
  // can present it to /memory/write. That means an agent-mapped token
  // (VERITY_AGENT_TOKENS + VERITY_AGENT_TENANTS) — plain beta tokens
  // and operator tokens both resolve to `tenantId: null` and cannot
  // harvest on this surface. Return a structured reason so MCP maps
  // it to a clear 4-class envelope instead of a generic 403.
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message:
        "Harvest requires a bearer that resolves to a tenant (agent-mapped token). "
          + "Beta and operator bearers have no tenant binding and cannot harvest on /machine/vault/harvest-auto.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }

  const parsedBody = await readBoundedJsonBody(c, MACHINE_VAULT_MAX_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.value ?? {}) as Record<string, unknown>;
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) {
    return errorJson(c, "invalid_request", {
      message: "source is required (absolute file path or URL).",
      details: { reason: "source_missing" },
    });
  }
  // Reject relative paths — `runVaultHarvest` calls `path.resolve` on
  // non-URL sources, which would silently resolve against the API
  // process cwd. That is a real correctness trap for MCP callers whose
  // cwd is unrelated to the server. Require absolute paths explicitly.
  if (!isUrl(source) && !path.isAbsolute(source)) {
    return errorJson(c, "invalid_request", {
      message:
        "source must be an absolute file path or a http(s) URL. "
          + "Relative paths would resolve against the API server's cwd, not the caller's — rejected explicitly.",
      details: { reason: "source_not_absolute" },
    });
  }

  // Readiness gate — the SAME state machine the Vault tab renders from.
  // Covers vault_enabled, missing/invalid roots, and tenant-mismatched
  // bindings in one call. A non-ready state is a gate refusal, not a
  // harvest outcome, so it rides the precondition shape rather than
  // masquerading as a stop_* AutoOutcome.
  const { readVaultDashboardState } = await import("../lib/vault-control");
  const vaultState = readVaultDashboardState(null, access.tenantId);
  if (vaultState.status_kind !== "ready" || !vaultState.vault_root) {
    return c.json({
      ok: false,
      kind: "precondition",
      reason: vaultState.status_kind,
      status_kind: vaultState.status_kind,
      message: vaultState.discovery_error
        ?? `Vault is not ready (status: ${vaultState.status_kind}).`,
    });
  }

  // Server-side operator token for /ops/link-doc. If the operator has
  // not configured one, the engine honestly skips doc-link (returns
  // "skipped_no_operator") — it never fakes success.
  const envOperator = (process.env.VERITY_OPERATOR_TOKENS || "").split(",")[0]?.trim();
  const operatorToken = envOperator ? envOperator : null;

  const tenantToken = access.token || "";
  if (!tenantToken) {
    // Defensive: getAccessContext resolved a tenantId but the bearer
    // is absent. This shouldn't happen in practice — tenantId is
    // derived from the bearer — but fail closed rather than call the
    // engine with an empty token.
    return errorJson(c, "tenant_required", { message: "Tenant bearer required." });
  }

  const runner = harvestRunnerOverride
    ?? (await import("../lib/vault-harvest")).runVaultHarvestAuto;
  const outcome = await runner({
    root: vaultState.vault_root,
    source,
    tenantToken,
    operatorToken,
    verbose: false,
  });

  // Rung 3: stamp the just-written dossier as a vault_file source_ref onto
  // every freshly-harvested node, so each carries a verifiable on-disk source
  // and an obsidian:// open link. Best-effort — the harvest already succeeded;
  // a stamping failure must not flip a successful harvest into an error.
  let obsidianUri: string | undefined;
  if (outcome.kind === "success" && Array.isArray(outcome.nodeAddrs) && outcome.nodeAddrs.length > 0) {
    try {
      const { stampExistingDossier } = await import("../lib/vault-write");
      const stamp = await stampExistingDossier(sql, {
        vaultRoot: vaultState.vault_root,
        dossierRelPath: outcome.dossierPath,
        addrs: outcome.nodeAddrs,
      });
      obsidianUri = stamp.obsidianUri;
    } catch (e) {
      console.error(`[machine-vault] dossier source-ref stamp failed (non-fatal): ${(e as Error)?.message}`);
    }
  }

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    operation: "vault_harvest_auto",
    eventData: {
      outcome: (outcome as any)?.kind || (outcome as any)?.status || "unknown",
      source_type: isUrl(source) ? "url" : "file",
      dossier_stamped: Boolean(obsidianUri),
    },
  });

  return c.json({ ok: true, outcome, ...(obsidianUri ? { obsidian_uri: obsidianUri } : {}) });
});

// ── POST /machine/vault/root ──────────────────────────────────────────
//
// VO-DESKTOP-WRAPPER-PR-1 — narrow JSON seam so the desktop shell's
// native folder picker can persist the tenant's chosen vault_root
// without going through the dashboard's operator-auth write path.
//
// The desktop wrapper carries the same tenant bearer MCP carries (from
// ~/.vo/config.json#agent_token). Requiring operator auth here would
// force the wrapper to either:
//   - ship operator credentials in client-side config (bad posture), or
//   - prompt the tenant to type their vault path manually (defeats the
//     whole "native folder picker" goal)
//
// Instead this route takes a tenant bearer, validates the root via the
// canonical `writeVaultRoot()` helper (which itself checks
// absolute-path + trim), and returns the same `{ ok, previous, next }`
// shape the dashboard operator route returns — so UI surfaces that
// already parse it can share read code.
//
// Inputs:
//   { root: string | null }
//     - absolute path → set vault_root
//     - null          → clear vault_root
//     - missing/other → 400 validation_failure
//
// Outputs:
//   200 { ok: true, previous, next }
//   400 canonical error envelope with details.reason
//   401/403 — transport auth (tenant bearer missing/rejected)

machineVault.post("/root", async (c) => {
  const access = getAccessContext(c);
  // Same Rung-7 narrowing as /harvest-auto: need a bearer that
  // resolves to a tenant. The vault_root is persisted machine-wide
  // in ~/.vo/config.json, and the write is a tenant-owned config
  // change — operator tokens (tenantId: null) have nothing to bind to.
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      message:
        "Setting vault_root requires a bearer that resolves to a tenant (agent-mapped token). "
          + "Beta and operator bearers have no tenant binding and cannot write this config.",
      details: { reason: "tenant_scoped_bearer_required" },
    });
  }

  const parsedBody = await readBoundedJsonBody(c, MACHINE_VAULT_MAX_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.value ?? {}) as Record<string, unknown>;
  const raw = body.root;

  // Distinguish three shapes: absolute path, explicit null (clear), and
  // "missing / wrong type" (400). Matches the dashboard operator
  // route's input contract so both facades share semantics.
  let value: string | null | undefined;
  if (raw === null) {
    value = null;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    value = trimmed ? trimmed : null;
  } else {
    value = undefined;
  }
  if (value === undefined) {
    return errorJson(c, "invalid_request", {
      message: "root must be an absolute path string or null.",
      details: { reason: "root_missing" },
    });
  }

  const { writeVaultRoot } = await import("../lib/vault-control");
  try {
    const result = writeVaultRoot(value);
    await auditMutation(c, sql, {
      kind: "tenant_settings_changed",
      tenantId: access.tenantId,
      actor: access.agentId || "operator",
      settingKey: "vault_root",
      eventData: { action: value === null ? "clear" : "set", previous_set: Boolean(result.previous), next_set: Boolean(result.next) },
    });
    return c.json({ ok: true, previous: result.previous, next: result.next });
  } catch (e) {
    // writeVaultRoot throws for non-absolute paths and empty strings.
    // Those are the caller's fault, not a server problem — 400 with a
    // structured reason so the desktop shell can show a honest
    // "that path didn't work" UI without parsing prose.
    const reason = /absolute/i.test((e as Error).message || "") ? "root_not_absolute" : "root_invalid";
    return errorJson(c, "invalid_request", {
      message: "Vault root update failed",
      details: { reason },
    });
  }
});

export default machineVault;
