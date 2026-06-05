// Open-core stub. The VO+ implementation ships separately.
/**
 * Open-core stub for the MCP + Skill control-status helpers.
 *
 * In the hosted (VO+) build this module reads an operator
 * acceptance artifact from disk, runs filesystem Skill checkers,
 * and computes a per-(client, control) status table for the local
 * dashboard. That implementation is part of VO+ and ships
 * separately.
 *
 * This open-core stub keeps the open-source `api/` node compiling
 * and booting by exporting every symbol consumers import, with:
 *
 *   - Faithful, self-contained reproductions of the two genuinely
 *     pure helpers consumers depend on for real behavior:
 *       * `SECRET_PATTERNS` / `findSecret` — a secret-shape
 *         DETECTOR (no secrets of its own) used by the acceptance
 *         writer to refuse, and by the action runner to redact,
 *         token-shaped free text before it is logged or rendered.
 *       * `resolveRepoRoot` — walks up from a file to the repo's
 *         `package.json` root; used by several path resolvers.
 *
 *   - Safe, degraded (disabled) values for the
 *     acceptance/checker surface:
 *       * `readAcceptanceArtifact` always reports `missing` — the
 *         open-core build records no acceptance artifact, so the
 *         dashboard renders the "no artifact recorded yet"
 *         branch rather than reading any file.
 *       * `computeAllControlRowsWithCheckers` returns an empty
 *         row set — the control table renders empty instead of
 *         shelling out to checkers.
 *
 * Type shapes mirror the consumed surface so callers type-check
 * and never crash on a missing field at runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ─── Vocabulary ──────────────────────────────────────────────────

export type Client = "claude-desktop" | "codex" | "generic";
export type Control = "mcp_connection" | "vo_skill";
export type StatusCode =
  | "unsupported"
  | "unknown"
  | "not_installed"
  | "installed"
  | "enabled"
  | "disabled"
  | "stale"
  | "error"
  | "manual_required";

// ─── Acceptance-artifact shapes (type-compatibility only) ────────

export interface AcceptanceCell {
  client: "claude-desktop" | "codex";
  status: "pass" | "fail";
  accepted_at: string;
  operator_summary: string;
  observed_tool_or_resource: string;
  observed_result_summary: string;
  config_doctor_ran: boolean;
  live_doctor_ran: boolean;
  skill_observed?: boolean;
  skill_observed_note?: string;
}

export interface AcceptanceArtifact {
  schema: "vo-mcp-client-acceptance/v1";
  run_stamp: string;
  run_finished_at: string;
  cells: AcceptanceCell[];
  notes: string[];
}

/** Tagged-variant result of an acceptance-artifact read. The
 *  open-core stub only ever produces the `missing` variant, but
 *  the full union is exported so consumers that narrow on
 *  `read.kind` continue to type-check. */
export type AcceptanceArtifactRead =
  | { kind: "missing"; expected_path: string }
  | { kind: "malformed"; path: string; error: string }
  | {
      kind: "stale";
      path: string;
      age_ms: number;
      max_age_ms: number;
      artifact: AcceptanceArtifact;
    }
  | { kind: "ok"; path: string; age_ms: number; artifact: AcceptanceArtifact };

export const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

// ─── Dashboard row shape ─────────────────────────────────────────

export interface DashboardControlRow {
  client: Client;
  control: Control;
  status: StatusCode;
  /** Short human-readable evidence sentence. */
  evidence: string;
  /** Operator-scoped next-action hint. */
  next_action?: {
    kind: "run_command" | "open_doc" | "open_file";
    value: string;
  };
}

// ─── Secret hygiene (faithful, self-contained leak detector) ─────
// This is a DETECTOR, not a store of secrets: a set of
// conservative regular expressions matching token / key SHAPES so
// that token-shaped free text is refused by the acceptance writer
// and redacted by the action runner before it can be logged or
// rendered. Reproduced faithfully because consumers rely on its
// exact behavior, and it contains no secrets, crypto, or hosted
// logic of its own.

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "authorization_bearer", pattern: /Authorization\s*:\s*Bearer\s+\S+/i },
  { name: "bare_bearer", pattern: /\bBearer\s+[A-Za-z0-9_.+/=-]{10,}/ },
  { name: "tenant_token", pattern: /\btenant-[A-Za-z0-9][A-Za-z0-9._-]*-token\b/ },
  { name: "credential_token", pattern: /\b[a-z]{2,8}_[A-Za-z0-9_-]{10,}\b/ },
  { name: "hex64_key", pattern: /\b[a-f0-9]{64}\b/ },
  { name: "token_assignment", pattern: /\b[A-Z][A-Z0-9_]*TOKEN\s*=\s*\S+/ },
  { name: "master_key_assignment", pattern: /\b[A-Z][A-Z0-9_]*MASTER_KEY\s*=\s*\S+/ },
];

/** Returns the first secret-shaped match in `input`, or `null`. */
export function findSecret(
  input: string,
): { name: string; match: string } | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    const m = pattern.exec(input);
    if (m) return { name, match: m[0] };
  }
  return null;
}

// ─── Acceptance-artifact reader (disabled in open core) ──────────

/**
 * Open-core stub: the open-source build records no operator
 * acceptance artifact, so this always reports `missing`. Consumers
 * handle the `missing` variant as "no artifact recorded yet on
 * this machine" and render the manual-activation guidance instead
 * of reading any file.
 */
export function readAcceptanceArtifact(
  _repoRoot: string,
  _now: Date = new Date(),
  _max_age_ms: number = DEFAULT_MAX_AGE_MS,
): AcceptanceArtifactRead {
  return {
    kind: "missing",
    expected_path:
      "agent-lab/proof/vo-mcp-client-acceptance/result.json",
  };
}

// ─── Control-row computation (disabled in open core) ─────────────

/**
 * Open-core stub: returns no rows. The hosted build computes the
 * per-(client, control) status table from the acceptance artifact
 * and filesystem Skill checkers; in open core the dashboard
 * control table renders empty rather than shelling out.
 */
export async function computeAllControlRowsWithCheckers(
  _read: AcceptanceArtifactRead,
  _now: Date = new Date(),
  _max_age_ms: number = DEFAULT_MAX_AGE_MS,
): Promise<DashboardControlRow[]> {
  return [];
}

// ─── Repo root resolver (faithful, pure filesystem walk) ─────────

/**
 * Resolve the repo root by walking up from `fromFile` looking for
 * the `package.json` whose `name` is the workspace root marker.
 * Falls back to `process.cwd()`. Pure filesystem logic — no
 * secrets, no hosted state.
 */
export function resolveRepoRoot(fromFile: string = __filename): string {
  try {
    let dir = path.dirname(fromFile);
    for (let i = 0; i < 8; i++) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        const content = JSON.parse(readFileSync(pkg, "utf8")) as {
          name?: string;
        };
        if (content.name === "verity-one") return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to cwd
  }
  return process.cwd();
}
