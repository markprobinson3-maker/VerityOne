/**
 * Shared proof-artifact shape for VO+ federation rungs —
 * VO-PLUS-FEDERATION-PROOF-SCHEMA-PR-1.
 *
 * Several federation rungs (4, 5, 8, 12 at minimum) need a
 * machine-readable artifact that says "we exercised these
 * routes / capabilities, here is what passed, here is what
 * is deliberately not supported yet." This module pins a
 * single shape for those artifacts so later rungs do not
 * each invent their own vocabulary.
 *
 * It intentionally mirrors the hosted-proof artifact at
 * `agent-lab/scripts/lib/hosted-proof-artifact.ts` — same
 * status vocabulary, same flat evidence envelope — but adds
 * two fields:
 *
 *   - `rung_id`: so the artifact is self-describing. A
 *     consumer reading one JSON file knows which ladder
 *     rung emitted it.
 *   - `stale` / `manual_required` statuses: federation
 *     artifacts cover surfaces (sync freshness, operator-
 *     entered acceptance) where those outcomes are real and
 *     distinct from `unsupported` or `fail`.
 *
 * The artifact is NOT a replacement for the richer
 * `agent-lab/runs/<date>/<name>/` reports that operator-
 * evidence runners already write. It is a narrow, flat
 * summary that downstream consumers (drift guards, dashboard
 * renderers, GA-hardening aggregators) can read without
 * embedding runner internals.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Proof statuses. Same core vocabulary as
 * `HostedRouteStatus` in the hosted-proof artifact, plus two
 * federation-specific outcomes:
 *
 *   - `stale`: the route answered but the underlying hosted
 *     mirror data is older than the rung's freshness bar.
 *     Distinct from `fail` — the surface works, the data
 *     does not.
 *   - `manual_required`: the step cannot be proven by the
 *     runner alone; an operator must confirm / enter
 *     evidence. Mirrors the MCP ladder's attestation
 *     pattern.
 */
export type FederationProofStatus =
  | "pass"
  | "fail"
  | "stale"
  | "unsupported"
  | "unproven"
  | "manual_required";

/**
 * One row in the artifact. One cell = one tested capability.
 * Keep the surface flat so consumers can grep without a
 * JSON library.
 */
export interface FederationProofCell {
  /** e.g. `POST /account/link` or `sync: tombstone-not-served`.
   *  Human-readable. */
  route: string;
  /** What the cell tests. `binding` = account/tenant/node
   *  link lifecycle (rungs 1-2). `sync` = mirror ingest +
   *  freshness (rung 4). `intent` = remote-intent queue
   *  (rung 5). `read` = hosted-mcp reads (rung 8).
   *  `hardening` = isolation / rate-limit / audit (rung 12). */
  capability: "binding" | "sync" | "intent" | "read" | "hardening";
  status: FederationProofStatus;
  /** Shallow, named evidence. Consumers treat unknown keys
   *  as opaque; runners may add route-specific keys without
   *  breaking the schema. */
  evidence?: {
    http_status?: number;
    body_excerpt?: string;
    route_url?: string;
    error?: string;
    tenant_id?: string;
    node_id?: string;
    age_seconds?: number;
    operator_attestation?: string;
  };
  /** Operator-readable rationale. For `unsupported` cells
   *  this documents why the cell is deliberately not a gap
   *  ("direct hosted mutation is unsupported"). For `fail` /
   *  `stale` it names the exact remediation. */
  rationale?: string;
}

/**
 * A federation proof artifact. One artifact per runner
 * invocation.
 */
export interface FederationProofArtifact {
  /** Stable schema tag. Bump when the shape changes. */
  schema: "vo-plus-federation-proof/v1";
  /** The ladder rung this artifact reports on, matching the
   *  codes in docs/VO-PLUS-TENANT-FEDERATION-PR-LADDER.md,
   *  e.g. `VO-HOSTED-MIRROR-HARDENING-PR-1`. Consumers use
   *  this to route the artifact to the right dashboard row. */
  rung_id: string;
  /** Short human-readable stamp: usually ISO-date + sequence. */
  run_stamp: string;
  run_started_at: string;
  run_finished_at: string;
  /** The hosted VO base the runner exercised. Required even
   *  for local-only rungs so the artifact records "which
   *  hosted side was this run against" unambiguously. */
  api_base: string;
  /** True if the runner completed its setup preconditions
   *  (account seeding, credential mint, node-link approval).
   *  False means later cells are necessarily `unproven` and
   *  no positive cell can be trusted for this run. */
  preconditions_met: boolean;
  totals: Record<FederationProofStatus, number>;
  cells: FederationProofCell[];
  /** Free-form operator notes. Kept outside `cells` so cell
   *  shape stays grep-friendly. */
  notes: string[];
}

/**
 * All federation proof statuses. Exported so tests + dashboard
 * renderers can enumerate without re-declaring.
 */
export const FEDERATION_PROOF_STATUSES: ReadonlyArray<FederationProofStatus> = [
  "pass",
  "fail",
  "stale",
  "unsupported",
  "unproven",
  "manual_required",
];

/**
 * Build an empty totals record. Every status present with
 * zero count — simpler for dashboard consumers than a sparse
 * map.
 */
export function emptyFederationTotals(): Record<FederationProofStatus, number> {
  return {
    pass: 0,
    fail: 0,
    stale: 0,
    unsupported: 0,
    unproven: 0,
    manual_required: 0,
  };
}

/**
 * Recompute totals from cells. Callers should treat `totals`
 * on a parsed artifact as authoritative but can use this to
 * rebuild when mutating.
 */
export function computeFederationTotals(
  cells: ReadonlyArray<FederationProofCell>,
): Record<FederationProofStatus, number> {
  const totals = emptyFederationTotals();
  for (const cell of cells) {
    totals[cell.status] += 1;
  }
  return totals;
}

/**
 * Validate an arbitrary value is a well-formed
 * `FederationProofArtifact`. Returns the artifact on success;
 * throws a clear, operator-readable error otherwise. Matches
 * the hosted-proof-artifact validation style — strict on
 * known fields, silent on unknown ones so runners can
 * innovate without schema churn.
 */
export function parseFederationProofArtifact(
  raw: unknown,
): FederationProofArtifact {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("federation proof artifact is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== "vo-plus-federation-proof/v1") {
    throw new Error(
      `federation proof schema mismatch: expected vo-plus-federation-proof/v1, got ${String(obj.schema)}`,
    );
  }
  for (const key of [
    "rung_id",
    "run_stamp",
    "run_started_at",
    "run_finished_at",
    "api_base",
  ]) {
    if (typeof obj[key] !== "string" || (obj[key] as string).length === 0) {
      throw new Error(`federation proof artifact missing string field: ${key}`);
    }
  }
  if (typeof obj.preconditions_met !== "boolean") {
    throw new Error("federation proof artifact preconditions_met must be boolean");
  }
  if (!Array.isArray(obj.cells)) {
    throw new Error("federation proof artifact cells must be an array");
  }
  const cells: FederationProofCell[] = [];
  for (const [index, rawCell] of obj.cells.entries()) {
    if (typeof rawCell !== "object" || rawCell === null) {
      throw new Error(`federation proof cell [${index}] is not an object`);
    }
    const cell = rawCell as Record<string, unknown>;
    if (typeof cell.route !== "string" || cell.route.length === 0) {
      throw new Error(`federation proof cell [${index}] missing route`);
    }
    if (
      cell.capability !== "binding" &&
      cell.capability !== "sync" &&
      cell.capability !== "intent" &&
      cell.capability !== "read" &&
      cell.capability !== "hardening"
    ) {
      throw new Error(
        `federation proof cell [${index}] has unknown capability: ${String(cell.capability)}`,
      );
    }
    if (!FEDERATION_PROOF_STATUSES.includes(cell.status as FederationProofStatus)) {
      throw new Error(
        `federation proof cell [${index}] has unknown status: ${String(cell.status)}`,
      );
    }
    cells.push(cell as unknown as FederationProofCell);
  }
  if (typeof obj.totals !== "object" || obj.totals === null) {
    throw new Error("federation proof artifact totals must be an object");
  }
  const totals = obj.totals as Record<string, unknown>;
  const computedTotals = computeFederationTotals(cells);
  for (const status of FEDERATION_PROOF_STATUSES) {
    if (typeof totals[status] !== "number") {
      throw new Error(`federation proof totals missing status: ${status}`);
    }
    if (totals[status] !== computedTotals[status]) {
      throw new Error(
        `federation proof totals mismatch for ${status}: expected ${computedTotals[status]}, got ${String(totals[status])}`,
      );
    }
  }
  if (!Array.isArray(obj.notes)) {
    throw new Error("federation proof artifact notes must be an array");
  }
  return obj as unknown as FederationProofArtifact;
}

/**
 * Redact any bytes in `body` that match a federation
 * secret-scanner pattern. Used by proof runners to scrub
 * `body_excerpt` fields before they land in an artifact,
 * because a failing response may quote back the offending
 * payload (e.g. an error body that echoes a leaked token).
 * A proof artifact is committed as a gitignored local
 * file today, but operators also share them during
 * incidents — scrubbing at write-time means the
 * cross-artifact disclosure surface is zero.
 *
 * Lazy-imports the scanner module so parseFederationProof
 * consumers (drift guards, tests) do not pay for scanner
 * pattern compilation when they never call this helper.
 */
export function redactSecretsForProofEvidence(body: string): string {
  if (!body || body.length === 0) return body;
  let out = body;
  // Use require-style synchronous import guarded by
  // typeof so bun-test + esbuild both accept it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const scanner = require("./federation-secret-scanner") as typeof import("./federation-secret-scanner");
  for (const { name, regex } of scanner.SECRET_PATTERNS) {
    out = out.replace(new RegExp(regex.source, "g"), `<redacted:secret:${name}>`);
  }
  for (const { name, regex } of scanner.LOCAL_PATH_PATTERNS) {
    out = out.replace(new RegExp(regex.source, "g"), `<redacted:local_path:${name}>`);
  }
  return out;
}

/**
 * Serialize + write an artifact to `<outDir>/result.json`.
 * Caller picks the directory (convention:
 * `agent-lab/proof/vo-plus-federation/<rung>/<stamp>/`).
 * Returns the absolute path written.
 */
export function writeFederationProofArtifact(
  outDir: string,
  artifact: FederationProofArtifact,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, "result.json");
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return filePath;
}
