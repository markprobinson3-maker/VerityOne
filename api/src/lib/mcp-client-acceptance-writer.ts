/**
 * Narrow api-side mirror of the acceptance-artifact writer.
 *
 * The authoritative writer lives at
 * `agent-lab/scripts/lib/mcp-client-acceptance-artifact.ts`. That
 * module is node-only (imports `node:fs` + `node:path` only), so
 * a direct cross-package import from `api/` would work at
 * runtime — but the established policy in this repo is that
 * `api/` does NOT import from `agent-lab/`; instead, narrow
 * MCP-facing vocabulary is mirrored into `api/src/lib/` with
 * two-sided drift guards (see `mcp-control-status.ts` and its
 * mirror-drift test).
 *
 * This file extends that posture to the *write* path the new
 * dashboard action runner needs for the acceptance recorder:
 *   - `assertArtifactShape(artifact)` — schema + field
 *     invariants, duplicate-client refusal, secret-scan on
 *     every free-text field, strict boolean doctor flags.
 *     Throws, never redacts.
 *   - `upsertCell(existing, cell, now)` — pure function; at
 *     most one cell per client.
 *   - `writeClientAcceptanceArtifact(outDir, artifact)` —
 *     asserts shape, creates the dir, writes
 *     `result.json` + `result.md` atomically.
 *   - `renderMarkdown(artifact)` — same format as the authority.
 *   - `clientAcceptanceArtifactOutDir(repoRoot)` — the single
 *     directory this writer is permitted to write under
 *     (`<repoRoot>/agent-lab/proof/vo-mcp-client-acceptance/`).
 *
 * A sibling drift test
 * (`agent-lab/scripts/lib/mcp-client-acceptance-writer-api-mirror.test.ts`)
 * pins this mirror's schema, cell-shape, and secret-pattern
 * vocabulary equal to the agent-lab source.
 *
 * What this file deliberately does NOT ship:
 *   - `summarizeClientAcceptance` / rollup logic — the dashboard
 *     runner only needs to write cells; the proof suite still
 *     consumes the summary from agent-lab.
 *   - any reader / freshness / stale-file logic — the dashboard
 *     already has `readAcceptanceArtifact` in
 *     `api/src/lib/mcp-control-status.ts`.
 *
 * `SECRET_PATTERNS` + `findSecret` are imported from
 * `./mcp-control-status` so the api has ONE mirror of the
 * secret vocabulary, not two.
 */

import fs from "node:fs";
import path from "node:path";
import { SECRET_PATTERNS, findSecret } from "./mcp-control-status";

// ─── Cell + artifact shape (mirror) ────────────────────────────────

export type ClientAcceptanceClient = "claude-desktop" | "codex";
export const CLIENT_ACCEPTANCE_CLIENTS: readonly ClientAcceptanceClient[] = [
  "claude-desktop",
  "codex",
] as const;

export type ClientAcceptanceStatus = "pass" | "fail";
export const CLIENT_ACCEPTANCE_STATUSES: readonly ClientAcceptanceStatus[] = [
  "pass",
  "fail",
] as const;

export interface ClientAcceptanceCell {
  client: ClientAcceptanceClient;
  status: ClientAcceptanceStatus;
  accepted_at: string;
  operator_summary: string;
  observed_tool_or_resource: string;
  observed_result_summary: string;
  config_doctor_ran: boolean;
  live_doctor_ran: boolean;
  /** Rung 11 — Skill-lifecycle discriminator. Operator
   *  attestation that they observed the Skill actually loaded
   *  in the client session (the agent behaved per the Skill's
   *  instructions). OPTIONAL — cells recorded before rung 11 do
   *  not carry these fields, and `vo_skill` rows stay at
   *  `installed` (not `enabled`) for those cells.
   *
   *  When present and `true`, PAIRED with a rung-10 checker
   *  result of `installed`, promotes the `vo_skill / <client>`
   *  row to `enabled`. When `false` (operator looked but did
   *  not see Skill-specific behavior), the row stays
   *  `installed`. Ordinary MCP-connection acceptance alone
   *  (status=pass + both doctors true, without
   *  `skill_observed: true`) does NOT promote `vo_skill` to
   *  `enabled` — the two surfaces are kept distinct per the
   *  rung-9 separation principle. */
  skill_observed?: boolean;
  /** Rung 11 — free-text operator note naming the Skill-
   *  specific behavior they observed (e.g. "I asked Claude to
   *  summarize my recent decisions and it used vo_memory_recall
   *  per the Skill's decision-capture guidance"). Secret-
   *  scanned like the other free-text fields. Required when
   *  `skill_observed === true`; absent/empty otherwise. */
  skill_observed_note?: string;
}

export interface ClientAcceptanceArtifact {
  schema: "vo-mcp-client-acceptance/v1";
  run_stamp: string;
  run_finished_at: string;
  cells: ClientAcceptanceCell[];
  notes: string[];
}

// ─── Output path ───────────────────────────────────────────────────

/** The SINGLE directory this writer is permitted to write under.
 *  Called by the runner; never passes a browser-supplied path. */
export function clientAcceptanceArtifactOutDir(repoRoot: string): string {
  return path.join(repoRoot, "agent-lab", "proof", "vo-mcp-client-acceptance");
}

// ─── Pre-upsert backup (design contract for artifact_write) ──────
//
// The design doc requires every artifact_write action to take a
// timestamped backup BEFORE the upsert so a mistaken record
// doesn't destroy prior evidence. The writer itself is atomic
// (write tmp + rename) for the replace step, but the PRIOR bytes
// would otherwise be gone. This helper writes
// `result.json.bak.<UTC-stamp>` as a sibling of the target
// artifact. Silent when the artifact does not yet exist (first-
// time record — nothing to preserve).

/** Deterministic UTC-stamped backup filename. Same shape as the
 *  Claude Desktop config backup in the runner, so future
 *  tooling can assume one format across the runner. */
export function acceptanceBackupPath(jsonPath: string, now: Date = new Date()): string {
  const stamp =
    now.getUTCFullYear().toString().padStart(4, "0") +
    (now.getUTCMonth() + 1).toString().padStart(2, "0") +
    now.getUTCDate().toString().padStart(2, "0") +
    "-" +
    now.getUTCHours().toString().padStart(2, "0") +
    now.getUTCMinutes().toString().padStart(2, "0") +
    now.getUTCSeconds().toString().padStart(2, "0") +
    "-" +
    now.getUTCMilliseconds().toString().padStart(3, "0");
  return `${jsonPath}.bak.${stamp}`;
}

export const ACCEPTANCE_BACKUP_STAMP_RE =
  /\.bak\.\d{8}-\d{6}-\d{3}$/;

export function isAcceptanceRunnerBackup(filename: string): boolean {
  return ACCEPTANCE_BACKUP_STAMP_RE.test(filename);
}

export interface BackupOutcome {
  ok: boolean;
  /** The written backup path, or null when the original artifact
   *  did not exist (first-time record). */
  backup_path: string | null;
  reason?: string;
}

/** Copy the current `result.json` to a timestamped sibling. No-op
 *  (returns ok + null) when the artifact does not yet exist.
 *  Atomic (write tmp + rename). Called by the runner strategy
 *  BEFORE upsertCell, so the prior bytes are recoverable if the
 *  operator records a wrong cell. */
export function takeAcceptanceBackup(
  outDir: string,
  now: Date = new Date(),
): BackupOutcome {
  const jsonPath = path.join(outDir, "result.json");
  if (!fs.existsSync(jsonPath)) {
    return {
      ok: true,
      backup_path: null,
      reason: "no existing acceptance artifact — first-time record; nothing to back up",
    };
  }
  try {
    const bytes = fs.readFileSync(jsonPath);
    const backupPath = acceptanceBackupPath(jsonPath, now);
    const tmp = backupPath + ".tmp";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, backupPath);
    return { ok: true, backup_path: backupPath };
  } catch (e) {
    return {
      ok: false,
      backup_path: null,
      reason: `acceptance backup failed: ${(e as Error).message}`,
    };
  }
}

/** Latest runner-produced backup sibling, or null. Uses the
 *  strict timestamped-filename pattern so stray `.tmp` files or
 *  hand-created siblings are rejected. */
export function findLatestAcceptanceBackup(outDir: string): string | null {
  try {
    const jsonName = "result.json";
    const candidates = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith(jsonName + ".bak.") && isAcceptanceRunnerBackup(f));
    if (candidates.length === 0) return null;
    candidates.sort();
    return path.join(outDir, candidates[candidates.length - 1]);
  } catch {
    return null;
  }
}

// ─── Shape invariants (mirror of assertArtifactShape) ─────────────

/** Throws if the artifact is malformed or contains a secret-
 *  shaped free-text field. Does NOT silently redact — the whole
 *  point of the recorder's scan is that the operator sees the
 *  refusal and removes the paste. */
export function assertArtifactShape(artifact: ClientAcceptanceArtifact): void {
  if (artifact.schema !== "vo-mcp-client-acceptance/v1") {
    throw new Error(
      `artifact.schema must be "vo-mcp-client-acceptance/v1"; got ${JSON.stringify(
        artifact.schema,
      )}`,
    );
  }
  if (typeof artifact.run_stamp !== "string" || artifact.run_stamp.trim() === "") {
    throw new Error(
      `artifact.run_stamp must be a non-empty string; got ${JSON.stringify(
        artifact.run_stamp,
      )}`,
    );
  }
  if (typeof artifact.run_finished_at !== "string") {
    throw new Error("artifact.run_finished_at must be an ISO string");
  }
  if (!Number.isFinite(Date.parse(artifact.run_finished_at))) {
    throw new Error(
      `artifact.run_finished_at is not a valid ISO timestamp: ${JSON.stringify(
        artifact.run_finished_at,
      )}`,
    );
  }
  if (!Array.isArray(artifact.cells)) {
    throw new Error("artifact.cells must be an array");
  }
  if (!Array.isArray(artifact.notes)) {
    throw new Error("artifact.notes must be an array");
  }
  for (let i = 0; i < artifact.notes.length; i++) {
    const n = artifact.notes[i];
    if (typeof n !== "string") {
      throw new Error(
        `artifact.notes[${i}] must be a string; got ${JSON.stringify(n)}`,
      );
    }
    const secret = findSecret(n);
    if (secret) {
      throw new Error(
        `artifact.notes[${i}] contains a secret-shaped pattern (${secret.name}); refusing to write`,
      );
    }
  }
  const seen = new Set<string>();
  for (const cell of artifact.cells) {
    if (!CLIENT_ACCEPTANCE_CLIENTS.includes(cell.client)) {
      throw new Error(
        `artifact cell has unknown client ${JSON.stringify(cell.client)}`,
      );
    }
    if (seen.has(cell.client)) {
      throw new Error(
        `artifact has duplicate cell for client ${JSON.stringify(cell.client)}`,
      );
    }
    seen.add(cell.client);
    if (!CLIENT_ACCEPTANCE_STATUSES.includes(cell.status)) {
      throw new Error(
        `artifact cell ${cell.client} has unknown status ${JSON.stringify(
          cell.status,
        )}`,
      );
    }
    if (typeof cell.accepted_at !== "string" || !Number.isFinite(Date.parse(cell.accepted_at))) {
      throw new Error(
        `artifact cell ${cell.client} has invalid accepted_at ${JSON.stringify(
          cell.accepted_at,
        )}`,
      );
    }
    const freeText: Array<[string, unknown]> = [
      ["operator_summary", cell.operator_summary],
      ["observed_tool_or_resource", cell.observed_tool_or_resource],
      ["observed_result_summary", cell.observed_result_summary],
    ];
    for (const [field, raw] of freeText) {
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new Error(
          `artifact cell ${cell.client}.${field} must be a non-empty string`,
        );
      }
      const secret = findSecret(raw);
      if (secret) {
        throw new Error(
          `artifact cell ${cell.client}.${field} contains a secret-shaped pattern (${secret.name}); refusing to write`,
        );
      }
    }
    if (typeof cell.config_doctor_ran !== "boolean") {
      throw new Error(
        `artifact cell ${cell.client}.config_doctor_ran must be boolean`,
      );
    }
    if (typeof cell.live_doctor_ran !== "boolean") {
      throw new Error(
        `artifact cell ${cell.client}.live_doctor_ran must be boolean`,
      );
    }
    // Rung 11 — Skill-lifecycle discriminator fields are
    // OPTIONAL. Reject only the case where skill_observed is a
    // non-boolean value (e.g. string "true" from a hand-edit).
    if (
      cell.skill_observed !== undefined &&
      typeof cell.skill_observed !== "boolean"
    ) {
      throw new Error(
        `artifact cell ${cell.client}.skill_observed must be boolean when present`,
      );
    }
    if (cell.skill_observed_note !== undefined) {
      if (typeof cell.skill_observed_note !== "string") {
        throw new Error(
          `artifact cell ${cell.client}.skill_observed_note must be string when present`,
        );
      }
      if (cell.skill_observed_note.trim() !== "") {
        if (cell.skill_observed === undefined) {
          throw new Error(
            `artifact cell ${cell.client}.skill_observed_note requires skill_observed to be present`,
          );
        }
        const secret = findSecret(cell.skill_observed_note);
        if (secret) {
          throw new Error(
            `artifact cell ${cell.client}.skill_observed_note contains a secret-shaped pattern (${secret.name}); refusing to write`,
          );
        }
      }
    }
    // Coherence: skill_observed=true requires a non-empty note
    // (semantic gate — the attestation must name the behavior
    // the operator observed). skill_observed=false can have an
    // empty note (operator attested they looked but didn't see).
    if (
      cell.skill_observed === true &&
      (typeof cell.skill_observed_note !== "string" ||
        cell.skill_observed_note.trim() === "")
    ) {
      throw new Error(
        `artifact cell ${cell.client}.skill_observed=true requires a non-empty skill_observed_note`,
      );
    }
  }
}

// ─── Upsert (pure) ─────────────────────────────────────────────────

/** Upsert a single cell into an existing artifact or initialise a
 *  new artifact if none exists. Returns a new artifact value; does
 *  not write to disk. Mirror of the authority's `upsertCell`. */
export function upsertCell(
  existing: ClientAcceptanceArtifact | null,
  cell: ClientAcceptanceCell,
  now: Date,
): ClientAcceptanceArtifact {
  const base: ClientAcceptanceArtifact = existing
    ? {
        ...existing,
        cells: existing.cells.filter((c) => c.client !== cell.client),
      }
    : {
        schema: "vo-mcp-client-acceptance/v1",
        run_stamp: `client-acceptance-${now.getTime()}`,
        run_finished_at: now.toISOString(),
        cells: [],
        notes: [],
      };
  return {
    ...base,
    run_stamp: `client-acceptance-${now.getTime()}`,
    run_finished_at: now.toISOString(),
    cells: [...base.cells, cell],
  };
}

// ─── Writer ────────────────────────────────────────────────────────

/** Writes `result.json` + `result.md` under `outDir`. Asserts
 *  shape first; throws before any disk I/O if the artifact would
 *  be malformed. Caller is responsible for choosing `outDir` —
 *  the runner uses `clientAcceptanceArtifactOutDir(repoRoot)`;
 *  browser-supplied paths are NEVER threaded here. Writes are
 *  atomic (tmp + rename) for both files. */
export function writeClientAcceptanceArtifact(
  outDir: string,
  artifact: ClientAcceptanceArtifact,
): { jsonPath: string; mdPath: string } {
  assertArtifactShape(artifact);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "result.json");
  const mdPath = path.join(outDir, "result.md");
  const jsonTmp = jsonPath + ".tmp";
  const mdTmp = mdPath + ".tmp";
  fs.writeFileSync(jsonTmp, JSON.stringify(artifact, null, 2) + "\n");
  fs.renameSync(jsonTmp, jsonPath);
  fs.writeFileSync(mdTmp, renderMarkdown(artifact));
  fs.renameSync(mdTmp, mdPath);
  return { jsonPath, mdPath };
}

export function renderMarkdown(artifact: ClientAcceptanceArtifact): string {
  const lines: string[] = [];
  lines.push("# VO MCP — operator-observed client runtime acceptance");
  lines.push("");
  lines.push(`- schema: \`${artifact.schema}\``);
  lines.push(`- run_stamp: \`${artifact.run_stamp}\``);
  lines.push(`- run_finished_at: \`${artifact.run_finished_at}\``);
  lines.push("");
  lines.push("## Cells");
  lines.push("");
  lines.push(
    "| Client | Status | Accepted at | Observed | Config doctor | Live doctor | Skill observed | Skill note |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const cell of artifact.cells) {
    const skillObserved =
      cell.skill_observed === true
        ? "true"
        : cell.skill_observed === false
          ? "false"
          : "";
    const skillNote = cell.skill_observed_note
      ? cell.skill_observed_note.replace(/\|/g, "\\|").replace(/\n/g, " ")
      : "";
    lines.push(
      `| ${cell.client} | \`${cell.status}\` | ${cell.accepted_at} | \`${cell.observed_tool_or_resource}\` | ${cell.config_doctor_ran} | ${cell.live_doctor_ran} | ${skillObserved} | ${skillNote} |`,
    );
  }
  if (artifact.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const note of artifact.notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push("");
  lines.push("## Scope contract");
  lines.push("");
  lines.push(
    "This artifact records operator-observed runtime acceptance for " +
      "Claude Desktop and Codex against the local stdio MCP server. " +
      "It does NOT prove generic remote MCP, connector writes, or " +
      "anything at `mcp.verityone.app`; the separate web `/mcp` " +
      "connector is queue-only for writes. It also does NOT describe " +
      "`/hosted-mcp/*` as MCP transport (those routes are hosted " +
      "portable-agent REST with queue-only write intent). " +
      "Written by `agent-lab/scripts/record-mcp-client-acceptance.ts`; " +
      "consumed by `agent-lab/scripts/run-mcp-interop-proof.ts`.",
  );
  lines.push("");
  return lines.join("\n");
}

// ─── Strict input sanitizer (secret refusal) ─────────────────────

/** Strict sanitizer used by the recorder BEFORE `upsertCell`.
 *  Rejects any input containing a known secret pattern — the
 *  recorder's job is to refuse, not paper over by redacting. */
export function sanitizeInputStrict(
  input: string,
): { ok: true; value: string } | { ok: false; name: string; match: string } {
  const found = findSecret(input);
  if (found) {
    return { ok: false, name: found.name, match: found.match };
  }
  return { ok: true, value: input };
}

// Re-export from the single-source-of-truth secret vocabulary so
// callers in this file's scope get the same list the reader uses.
export { SECRET_PATTERNS, findSecret };
