/**
 * Tool: vo_vault_harvest_auto — VO-LOCAL-MCP-HARVEST-OPERATOR-PR-1.
 *
 * The first write-capable vault tool in the MCP surface. Calls the local
 * VO node's /machine/vault/harvest-auto JSON route, which itself wraps
 * the shared harvest engine in api/src/lib/vault-harvest.ts. The engine
 * is the single canonical owner of the harvest pipeline — MCP is a thin
 * adapter, the dashboard is a thin adapter, and the CLI is a thin
 * adapter; all three sit on top of the same engine.
 *
 * Authority model (binding, per docs/VO-MCP-SERVER-CONTRACT.md Rung 7):
 *
 *   - MCP carries exactly ONE tenant-scoped bearer. No operator channel.
 *   - The server (not MCP) validates harvest readiness via
 *     `readVaultDashboardState(...).status_kind === "ready"`. A non-
 *     ready vault returns `ok: false, kind: "precondition"` from the
 *     route; MCP maps that to a validation_failure with the precise
 *     `status_kind`.
 *   - `/ops/link-doc` requires operator auth. The server resolves an
 *     operator token from its own env if present; otherwise the engine
 *     honestly skips doc-link (the `docLink` field carries the
 *     canonical engine value `"skipped_no_operator_auth"` — the other
 *     three values are `"linked"`, `"skipped_no_project"`, `"failed"`;
 *     never a fake "linked").
 *   - The MCP tool does NOT accept a `vault_root` argument. The
 *     server's configured root is authoritative — accepting a client
 *     root would let the caller point the engine at an arbitrary
 *     filesystem path, trivially bypassing the tenant binding + the
 *     "ready" gate.
 *
 * Result shape (MCP envelope):
 *
 *   success:   { ok: true, outcome: { kind: "success", capture, dossier,
 *                graph_write, doc_link, next } }
 *   stop:      { ok: true, outcome: { kind: "stop_*", ... engine fields,
 *                what_preserved, what_did_not_happen, next } }
 *   gate:      validation_failure envelope with the exact status_kind
 *   transport: the usual ErrorClass envelope (unreachable / auth /
 *              not_found / validation / upstream) via the existing VoClient mapping
 *
 * Stop taxonomy is the engine's AutoOutcome verbatim:
 *   - stop_missing_key         — no LLM API key configured
 *   - stop_vo_unavailable      — 4 subReasons: unreachable /
 *                                missing_tenant_auth / all_writes_failed /
 *                                unknown
 *   - stop_finalize_conflict   — generated dossier differed from
 *                                operator-edited version
 *   - stop_unknown             — uncategorized stage failure
 */

import path from "node:path";
import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { extractReason } from "../vo-client.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

const harvestInputShape = {
  source: z
    .string()
    .min(1)
    .describe(
      "Absolute file path OR URL to harvest. The engine auto-detects URL vs. path. " +
        "No vault_root argument: the local VO server's configured vault root is authoritative.",
    ),
};

/**
 * Shape of the /machine/vault/harvest-auto response body (HTTP 200 on
 * both engine-completion and gate-refusal). Kept permissive because the
 * engine's AutoOutcome union is canonical upstream and any schema drift
 * here would mask useful outcome fields.
 */
interface MachineHarvestResponse {
  ok: boolean;
  // Present when ok: true — the shared engine's AutoOutcome.
  outcome?: {
    kind: string;
    [key: string]: unknown;
  };
  // Present when ok: false, kind: "precondition" — gate refusal.
  kind?: string;
  status_kind?: string;
  reason?: string;
  message?: string;
}

/**
 * Shape the tool returns to agents. Mirrors AutoOutcome 1:1 for the
 * engine-completion case, with additive `summary` and (on stop) human
 * next-step text. Agents can either:
 *   - read `outcome.kind` and branch
 *   - read the additive `summary` for a short human-readable line
 *
 * Mapping additive guidance does NOT rewrite engine fields; engine
 * fields remain load-bearing.
 */
function summarizeOutcome(o: { kind: string; [k: string]: unknown }): string {
  switch (o.kind) {
    case "success": {
      const w = typeof o.atomsWritten === "number" ? o.atomsWritten : 0;
      const d = typeof o.atomsDeduped === "number" ? o.atomsDeduped : 0;
      return `Harvest complete — ${w} atom(s) written, ${d} deduped. Local vault authoritative.`;
    }
    case "stop_missing_key":
      return "Stopped — AI model API key not configured. Run `vo onboard` locally.";
    case "stop_vo_unavailable": {
      const sub = typeof o.subReason === "string" ? o.subReason : "unknown";
      if (sub === "all_writes_failed") {
        const total = typeof o.atomsProposed === "number" ? o.atomsProposed : 0;
        return `Stopped — 0 of ${total} atoms reached the VO graph. Local files preserved.`;
      }
      if (sub === "missing_tenant_auth") return "Stopped — VO tenant auth missing. Run `vo init --tenant <id>`.";
      if (sub === "unreachable") return "Stopped — local VO unreachable. Start the VO node, then resume via `vo vault confirm`.";
      return "Stopped — VO could not complete the graph write.";
    }
    case "stop_finalize_conflict":
      return "Stopped — generated dossier differed from your edited version. Operator-edited dossier preserved; conflict file written to `.conflicts/`.";
    case "stop_unknown": {
      const stage = typeof o.stage === "string" ? o.stage : "unknown";
      return `Stopped — harvest failed at stage "${stage}". Local files preserved.`;
    }
    default:
      return `Unrecognized outcome kind "${o.kind}".`;
  }
}

export const vaultHarvestAutoTool: ToolDefinition<typeof harvestInputShape> = {
  name: "vo_vault_harvest_auto",
  description:
    "Harvest a local file or URL into the tenant's local vault via the shared harvest engine. " +
      "Runs all 7 stages end-to-end: CAPTURE → ATOMIZE → CURATE → CONFIRM → GRAPH_WRITE → FINALIZE → LOG. " +
      "Returns a structured AutoOutcome — either `kind: \"success\"` with capture/dossier/graph-write/doc-link paths, " +
      "or a `kind: \"stop_*\"` with preserved files and the exact next step. " +
      "Local vault is authoritative; doc-link may be honestly skipped when the server lacks operator auth. " +
      "The server's configured vault_root is authoritative — no vault_root argument is accepted. " +
      "Requires an agent-mapped tenant bearer (a token that resolves to a tenant on the local VO node via VERITY_AGENT_TOKENS + VERITY_AGENT_TENANTS). " +
      "Plain beta tokens and operator tokens cannot harvest on this surface — they have no tenant binding. " +
      "`source` must be an absolute file path or a http(s) URL; relative paths are rejected.",
  inputShape: harvestInputShape,
  async handler(client, args) {
    const source = String(args.source || "").trim();
    if (!source) {
      // Structured `reason` so agents branch without parsing prose —
      // the contract's failure-cases table pins every MCP refusal path
      // to a specific reason code, not just `error_class`.
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "source is required",
          "pass an absolute file path or URL as the `source` argument",
          "source_missing",
        ),
      );
    }
    // The server resolves non-URL sources via `path.resolve`, so a
    // relative path would target the API process cwd — almost never
    // what the MCP caller means. Refuse client-side for a tight loop
    // with the SAME reason code the server-side refusal uses, so MCP
    // callers see one structured code regardless of which boundary
    // caught the bad input.
    if (!isUrl(source) && !path.isAbsolute(source)) {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "source must be an absolute path or URL",
          `got ${JSON.stringify(source)}; relative paths would resolve against the API server's cwd, not this process`,
          "source_not_absolute",
        ),
      );
    }

    const result = await client.post<MachineHarvestResponse>(
      "/machine/vault/harvest-auto",
      { source },
    );
    if (!result.ok) {
      // Transport-level failure (unreachable / auth / 400 / upstream).
      // Preserve the server's structured `reason` (e.g.
      // `tenant_scoped_bearer_required`, `source_not_absolute`) so MCP
      // callers can branch on the code without parsing prose.
      const reason = extractReason(result);
      return errorEnvelope(
        buildErrorEnvelope(result.errorClass, result.message, result.detail, reason),
      );
    }

    const body = result.body;

    // Gate refusal — the server-side readiness check refused to run
    // the engine. Map to validation_failure with the precise
    // status_kind so the agent knows whether to enable the vault,
    // configure a root, initialize it, or change binding. The
    // status_kind rides the envelope's structured `reason` field so
    // agents branch without parsing prose.
    if (body.ok === false && body.kind === "precondition") {
      const kind = body.status_kind || body.reason || "unknown";
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          body.message || `vault not ready (status_kind: ${kind})`,
          `status_kind=${kind}`,
          kind,
        ),
      );
    }

    // Engine-completed response. Outcome is the canonical AutoOutcome;
    // we pass it through verbatim and attach an additive `summary` text
    // so agents that want a short status line don't have to render
    // one themselves.
    if (body.ok === true && body.outcome && typeof body.outcome.kind === "string") {
      return okEnvelope({
        ok: true,
        outcome: body.outcome,
        summary: summarizeOutcome(body.outcome),
      });
    }

    // Response parsed as JSON but does not match either expected shape.
    // Treat as upstream_error so the agent sees an honest diagnostic
    // rather than a silent no-op.
    return errorEnvelope(
      buildErrorEnvelope(
        "upstream_error",
        "harvest-auto returned an unexpected response shape",
        truncateCodePoints(JSON.stringify(body), 400),
      ),
    );
  },
};

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
