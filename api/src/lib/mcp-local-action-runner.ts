/**
 * Local action runner.
 *
 * Pins the runner contract in
 * `docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md`. Ships the
 * descriptor registry, typed-args validator, confirmation-
 * token mint/consume, output redactor, concurrency guard,
 * path-safety checks, and the preview/execute lifecycle.
 *
 * Allowlist after `MCP-SKILL-CHECKER-IMPL-PR-1` (nineteen
 * actions across three categories):
 *
 *   read_only (five):
 *     - mcp_live_doctor
 *     - mcp_client_doctor_claude_desktop
 *     - mcp_client_doctor_codex
 *     - skill_doctor_codex
 *     - skill_doctor_claude_desktop
 *
 *   file_mutation (twelve):
 *     ── Claude Desktop MCP connection control ──
 *       - mcp_onboard_claude_desktop        (normal install)
 *       - mcp_onboard_claude_desktop_force  (overwrite / repair)
 *       - mcp_rollback_claude_desktop       (symmetric undo)
 *     ── Codex MCP connection control ──
 *       - mcp_onboard_codex                 (merge verity-one)
 *       - mcp_onboard_codex_force           (overwrite section)
 *       - mcp_rollback_codex                (restore latest backup)
 *     ── Codex VO Skill control ──
 *       - skill_install_codex               (copy repo SKILL.md)
 *       - skill_disable_codex               (rename-to-disabled)
 *       - skill_rollback_codex              (symmetric undo)
 *     ── Claude Desktop VO Skill control ──
 *       - skill_install_claude_desktop      (copy repo SKILL.md)
 *       - skill_disable_claude_desktop      (rename-to-disabled)
 *       - skill_rollback_claude_desktop     (symmetric undo)
 *
 *   artifact_write (two — gitignored acceptance artifact):
 *     - acceptance_record_claude_desktop
 *     - acceptance_record_codex
 *
 * The six VO Skill actions use `control_scope: "vo_skill"` and
 * share the per-(tenant, `vo_skill`) mutation lock — Skill install
 * / disable / rollback serialize AMONG THEMSELVES per tenant but
 * do NOT block `mcp_connection` mutations (a Claude Desktop MCP
 * install can safely run concurrently with a Codex or Claude
 * Desktop Skill install; they target unrelated files). The Codex
 * Skill target-path contract is reused from
 * `api/src/lib/mcp-skill-target-path.ts`
 * (`VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1`); the Claude Desktop
 * Skill target-path contract is reused from
 * `api/src/lib/mcp-claude-desktop-skill-target-path.ts`
 * (`VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`, VO-provisional darwin
 * pin, NOT Anthropic-authoritative). No resolver logic is
 * duplicated here. Each Skill descriptor's preview re-runs the
 * relevant client validator so symlink / ancestor-walk refusals
 * disable the Confirm button before the operator can authorize a
 * write.
 *
 * The three Codex MCP actions use `control_scope:
 * "mcp_connection"` and serialize alongside Claude Desktop MCP
 * install / repair / rollback AND both acceptance recorders.
 * They target the Codex MCP `config.toml` file — NOT the VO
 * Skill `SKILL.md` file (that is the Codex VO Skill surface,
 * above). The merge preserves unrelated sections / comments /
 * blank lines / ordering byte-for-byte; validates TOML before
 * AND after via `smol-toml`; first-time install writes no
 * backup (rollback refuses when no eligible backup exists —
 * NO backup ⇒ NO rollback; never deletes the config).
 * Contract: `docs/VO-MCP-CODEX-TOML-MERGE-DESIGN.md`.
 *
 * Each artifact_write strategy takes a pre-upsert
 * `result.json.bak.<UTC-stamp>` snapshot so a mistaken record
 * is recoverable via the manual rollback shape documented in
 * `docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md` (no dashboard
 * undo action ships in this PR — the design's "symmetric undo"
 * requirement is deferred for artifact writes and narrowed in
 * the design doc's artifact_write section).
 *
 * Outside this allowlist: generic Skill support (permanently out
 * of scope), generic host config writes, hosted proof / write /
 * review, remote / web MCP, any arbitrary shell invocation.
 * Browser wire protocol is strictly
 * `{ action_id, typed_args, confirmation_token }`.
 *
 * Isolation: zero static imports from `mcp/src/doctor`,
 * `mcp/src/install`, or `mcp/src/tools/*` — those pull zod and
 * would crash `api/` module load on a fresh checkout without
 * `mcp/node_modules`. Strategies lazy-import at dispatch time.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  SECRET_PATTERNS,
  findSecret,
  readAcceptanceArtifact,
  resolveRepoRoot,
  computeAllControlRowsWithCheckers,
  type AcceptanceArtifactRead,
  type DashboardControlRow,
} from "./mcp-control-status";
import {
  CLIENT_ACCEPTANCE_CLIENTS,
  CLIENT_ACCEPTANCE_STATUSES,
  clientAcceptanceArtifactOutDir,
  findLatestAcceptanceBackup,
  sanitizeInputStrict,
  takeAcceptanceBackup,
  upsertCell,
  writeClientAcceptanceArtifact,
  type ClientAcceptanceCell,
  type ClientAcceptanceClient,
  type ClientAcceptanceStatus,
} from "./mcp-client-acceptance-writer";
import {
  CODEX_SKILL_SOURCE_REL_PATH,
  findSuspiciousAncestorSymlink,
  resolveCodexHome,
  resolveCodexSkillTargetPath,
  validateCodexSkillTargetPath,
  type CodexSkillResolverDeps,
  type CodexSkillTargetPath,
} from "./mcp-skill-target-path";
import {
  CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH,
  resolveClaudeDesktopSkillTargetPath,
  validateClaudeDesktopSkillTargetPath,
  type ClaudeDesktopSkillResolverDeps,
  type ClaudeDesktopSkillTargetPath,
} from "./mcp-claude-desktop-skill-target-path";
import {
  runSkillDoctorClaudeDesktop,
  runSkillDoctorCodex,
  type SkillDoctorOutput,
} from "./mcp-skill-checker";

// ─── Descriptor shape (mirror of the design-doc interface) ────────

export type ActionCategory =
  | "read_only"
  | "file_mutation"
  | "artifact_write"
  | "external_app_handoff";

export type ActionRiskLevel = "low" | "medium" | "high";

export interface ActionDescriptor {
  action_id: string;
  category: ActionCategory;
  client_scope: "claude-desktop" | "codex" | "generic" | "*";
  control_scope: "mcp_connection" | "vo_skill";
  /** Args the browser may send. Every key listed must be present;
   *  every key NOT listed is rejected. `type` is a structural
   *  validator used at preview + execute. */
  args_schema: Record<string, ArgsFieldType>;
  risk_level: ActionRiskLevel;
  /** Human-readable one-liner describing what the action DOES (no
   *  browser-provided shell strings). Rendered verbatim in the
   *  preview card. */
  command_summary: string;
  /** Files the strategy READS. Shown in the preview so the operator
   *  can audit scope. Static — templates like `~/.codex/config.toml`
   *  are fine here; the preview `resolvePreviewExtras` hook is where
   *  runtime-resolved absolute paths land. */
  reads: readonly string[];
  /** OPTIONAL. For `file_mutation` / `artifact_write` descriptors:
   *  the files the action may WRITE (including backup siblings).
   *  Undefined for read-only descriptors. */
  mutates?: readonly string[];
  execute_strategy: StrategyLabel;
  rollback_strategy: RollbackStrategyLabel;
  status_reread: "live_doctor" | "client_doctor" | "artifact_read" | "none";
  /** OPTIONAL. Hook that resolves runtime-specific disclosures at
   *  preview time — exact absolute config path, whether a backup
   *  will be taken, notes about what's NOT touched. Read-only
   *  descriptors omit this. The output is merged into `ActionPreview`
   *  so the operator sees real paths before clicking confirm. */
  resolvePreviewExtras?: () => PreviewExtras;
}

export interface PreviewExtras {
  /** Absolute runtime-resolved path(s) the action will write to. */
  mutates?: readonly string[];
  /** Human-readable sentence about backup behavior, if any. */
  backup_note?: string;
  /** Extra operator-visible notes — "Codex is not touched",
   *  "Skill is not installed", etc. Rendered beneath the
   *  command_summary so the operator sees what is explicitly
   *  out of scope for this specific action. */
  extra_notes?: readonly string[];
  /** Optional hint a touchable config path exists. Useful so the
   *  UI can render a bold "this file will be modified" line. */
  touched_config_path?: string;
  /** For file_mutation actions that touch a known config file:
   *  the CURRENT `mcpServers.verity-one` entry (if any) read from
   *  disk at preview time, serialized as a JSON string so the UI
   *  can render it pretty-printed. Lets the operator see what a
   *  force-repair would OVERWRITE before confirming. Null when
   *  no entry exists yet. */
  current_entry_json?: string | null;
  /** For file_mutation actions that write structured content: the
   *  EXACT proposed next value the strategy will write at execute
   *  time, rendered as the on-disk shape. For Codex MCP: a TOML
   *  block byte-identical to what `buildCodexTomlBlock` emits, so
   *  the operator sees the exact section that will land (or
   *  replace the current section) before confirming. The preview-
   *  time formatter mirrors the installer's block shape and is
   *  drift-guarded against the authoritative `buildCodexTomlBlock`.
   *  Null when the runtime cannot be resolved at preview time
   *  (missing mcp/dist, no node on PATH); the preview's
   *  `change_note` carries the reason in that case. Other
   *  descriptors may surface a JSON value or omit the field. */
  proposed_next_value?: string | null;
  /** Human-readable note about the current-vs-next change (e.g.
   *  "will create a new entry" / "will OVERWRITE this entry" /
   *  "will restore the latest backup"). */
  change_note?: string;
  /** Result of the path-safety check (symlink + parent-dir
   *  realpath scope). Refused paths surface here BEFORE the
   *  operator sees a Confirm button, so the runner never asks
   *  the operator to authorize a mutation that the strategy
   *  would refuse anyway. */
  path_safety?:
    | { ok: true; realpath: string | null }
    | { ok: false; reason: string };
}

export type ArgsFieldType =
  | "string"
  | "boolean"
  | "enum"
  | "string_optional"
  | "boolean_optional";

/** Strategy labels are server-side enums. The browser never sends
 *  these — it sends an `action_id`; the runner resolves a strategy
 *  through the descriptor registry. Adding a new label here is the
 *  only path to executable behavior. */
export type StrategyLabel =
  | "live_doctor_handshake"
  | "client_doctor_claude_desktop"
  | "client_doctor_codex"
  | "onboard_claude_desktop"
  | "onboard_claude_desktop_force"
  | "rollback_claude_desktop"
  | "onboard_codex"
  | "onboard_codex_force"
  | "rollback_codex"
  | "acceptance_record_claude_desktop"
  | "acceptance_record_codex"
  | "skill_install_codex"
  | "skill_disable_codex"
  | "skill_rollback_codex"
  | "skill_install_claude_desktop"
  | "skill_disable_claude_desktop"
  | "skill_rollback_claude_desktop"
  | "skill_doctor_codex"
  | "skill_doctor_claude_desktop";

/** Rollback strategy labels. `"none"` is allowed for:
 *    - `read_only` and `external_app_handoff` (no mutation to
 *      undo),
 *    - `artifact_write` descriptors that take a pre-upsert
 *      `.bak.<UTC-stamp>` sibling AND name the manual rollback
 *      shape in the preview (the dashboard-surfaced undo
 *      requirement is narrowed for gitignored evidence-only
 *      artifacts — see `docs/VO-MCP-LOCAL-ACTION-RUNNER-
 *      DESIGN.md` §"Rollback contract").
 *  `file_mutation` descriptors MUST pair with a named symmetric
 *  undo descriptor (e.g. `rollback_claude_desktop`). */
export type RollbackStrategyLabel =
  | "none"
  | "rollback_claude_desktop"
  | "rollback_codex"
  | "skill_rollback_codex"
  | "skill_rollback_claude_desktop";

// ─── Claude Desktop helpers (narrow adapter; no installer refactor) ─

/** Resolve the tenant's HOME directory at call time. Mirrors the
 *  installer's `homeDir()` helper (`mcp/src/install.ts`) EXACTLY:
 *  prefer live `process.env.HOME` over `os.homedir()`, with
 *  `os.homedir()` as the Windows / non-POSIX fallback.
 *
 *  Why this matters (reviewer P2): Bun (unlike Node) caches
 *  `os.homedir()` at startup. A test that mutates
 *  `process.env.HOME` after module import — or any long-running
 *  process that receives a HOME change — would otherwise diverge
 *  between the dashboard's path resolution and the installer's.
 *  The dashboard would validate / backup against the cached
 *  homedir while `params.install()` writes through the live-
 *  `$HOME` path. Same precedence as the installer closes that
 *  gap; the drift guard in the runner test pins equivalence
 *  under a `process.env.HOME` override. */
function claudeDesktopHomeDir(): string {
  const live = process.env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

/** Claude Desktop config path resolution. Mirrors the three-line
 *  helper inside `mcp/src/install.ts` so this module does not
 *  need to widen the `mcp/` package surface. Uses
 *  `claudeDesktopHomeDir()` (live `$HOME` > `os.homedir()`),
 *  matching the installer's `homeDir()` exactly. If the install
 *  library's resolution ever changes, a drift test in
 *  `mcp-local-action-runner.test.ts` pins equivalence. */
export function resolveClaudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(
      claudeDesktopHomeDir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || "",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  return path.join(
    claudeDesktopHomeDir(),
    ".config",
    "Claude",
    "claude_desktop_config.json",
  );
}

/** Deterministic timestamp-suffixed backup filename for a given
 *  config path. The stamp is UTC and millisecond-stable so two
 *  backups can never collide. */
export function claudeDesktopBackupPath(configPath: string, now?: Date): string {
  const d = now ?? new Date();
  const stamp =
    d.getUTCFullYear().toString().padStart(4, "0") +
    (d.getUTCMonth() + 1).toString().padStart(2, "0") +
    d.getUTCDate().toString().padStart(2, "0") +
    "-" +
    d.getUTCHours().toString().padStart(2, "0") +
    d.getUTCMinutes().toString().padStart(2, "0") +
    d.getUTCSeconds().toString().padStart(2, "0") +
    "-" +
    d.getUTCMilliseconds().toString().padStart(3, "0");
  return `${configPath}.bak.${stamp}`;
}

export interface BackupOutcome {
  /** True when a backup was written. False with reason when there
   *  was nothing to back up (first-time install) or when the backup
   *  failed. */
  ok: boolean;
  backup_path: string | null;
  reason?: string;
}

/** Take a pre-mutation snapshot of the Claude Desktop config.
 *  Atomic write (write + rename) so a crash between backup and
 *  mutation leaves recoverable state. If the config file does not
 *  yet exist, returns `{ ok: true, backup_path: null }` with an
 *  explanatory reason so the caller does NOT treat missing-config
 *  as a backup failure.
 *
 *  Uses `lstat` (NOT `existsSync`) for the presence check so a
 *  symlink swapped in at `configPath` between the caller's path-
 *  safety check and this call is REFUSED rather than followed.
 *  Reads bytes via `readFileNoFollow` (O_NOFOLLOW + fstat-on-fd
 *  + read-from-fd) — race-free against a late-planted symlink
 *  at the final path component. Same hardening posture as
 *  `takeCodexSkillBackup`. */
export function takeClaudeDesktopBackup(
  configPath: string,
  now?: Date,
): BackupOutcome {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(configPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return {
        ok: false,
        backup_path: null,
        reason: `Claude Desktop backup lstat failed: ${(e as Error).message}`,
      };
    }
  }
  if (!st) {
    return {
      ok: true,
      backup_path: null,
      reason: "no existing Claude Desktop config — first-time install; nothing to back up",
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      backup_path: null,
      reason: `Claude Desktop config ${configPath} is a symlink; refusing to backup (would read the link target's bytes, not the expected config bytes). Remove the symlink and retry.`,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      backup_path: null,
      reason: `Claude Desktop config ${configPath} is not a regular file (${describeStatKind(st)}); refusing to backup.`,
    };
  }
  try {
    const bytes = readFileNoFollow(configPath);
    const backupPath = claudeDesktopBackupPath(configPath, now);
    const tmp = backupPath + ".tmp";
    writeFileNoFollowExclusive(tmp, bytes);
    fs.renameSync(tmp, backupPath);
    return { ok: true, backup_path: backupPath };
  } catch (e) {
    return {
      ok: false,
      backup_path: null,
      reason: `backup failed: ${(e as Error).message}`,
    };
  }
}

/** Exact suffix pattern this runner's `claudeDesktopBackupPath`
 *  produces — 8 digits (date) + `-` + 6 digits (time) + `-` + 3
 *  digits (millisecond). Rollback candidate selection uses this
 *  AND a stamp-validity check — the regex alone accepts any
 *  digit sequence of the right length (e.g.
 *  `config.json.bak.99999999-999999-999`), which a validity-
 *  parsing step rejects.
 *
 *  Capture-group pattern for stamp extraction from a matched
 *  filename. The existing `.endsWith` shape is preserved for
 *  backward compatibility with the acceptance-record writer's
 *  sibling file filters. */
const CLAUDE_BACKUP_STAMP_RE = /\.bak\.\d{8}-\d{6}-\d{3}$/;
const CLAUDE_BACKUP_STAMP_EXTRACT_RE = /\.bak\.(\d{8}-\d{6}-\d{3})$/;

/** Validity gate for a Claude Desktop backup stamp. Delegates to
 *  the shared runner-stamp validator (same UTC round-trip +
 *  5-minute future-skew rules as the Codex Skill backup stamp).
 *  Exposed for tests + consistency with the Skill side; production
 *  callers go through `findLatestClaudeDesktopBackup`. */
export function isValidClaudeDesktopBackupStamp(
  stamp: string,
  now?: Date,
): boolean {
  // Same `YYYYMMDD-HHMMSS-mmm` shape as the Codex Skill backup
  // stamp; reuse the validator.
  return isValidCodexSkillStamp(stamp, now);
}

export function isClaudeDesktopRunnerBackup(
  filename: string,
  now?: Date,
): boolean {
  const m = CLAUDE_BACKUP_STAMP_EXTRACT_RE.exec(filename);
  if (!m) return false;
  return isValidClaudeDesktopBackupStamp(m[1], now);
}

/** Finds the latest eligible backup sibling of the Claude Desktop
 *  config.
 *
 *  Eligibility — an entry is eligible ONLY when ALL of the
 *  following hold:
 *    - filename starts with `<config-basename>.bak.`;
 *    - filename ends with an exact `.bak.<8-6-3-digit-UTC-stamp>`
 *      (rejects `.tmp`, prefix-only / malformed-stamp shapes);
 *    - stamp parses to a real UTC instant in the past (+ 5-min
 *      future-skew tolerance) — `isValidClaudeDesktopBackupStamp`
 *      rejects impossible calendar fields like
 *      `99999999-999999-999` and hand-crafted future stamps
 *      aimed at leapfrogging real backups in lexical sort;
 *    - `lstat(abs)` reports a regular file — not a symlink,
 *      not a device, not a directory.
 *
 *  Eligibility DOES NOT prove runner provenance. A file
 *  hand-created at the same exact stamp shape is ALSO eligible;
 *  the filter cannot distinguish runner-produced bytes from
 *  operator-planted ones without a separate manifest, and no
 *  such manifest ships today. Same narrowed contract as the
 *  Codex Skill side. */
export function findLatestClaudeDesktopBackup(
  configPath: string,
  now?: Date,
): string | null {
  try {
    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    const prefix = base + ".bak.";
    const candidates: { abs: string; stamp: string }[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const m = CLAUDE_BACKUP_STAMP_EXTRACT_RE.exec(name);
      if (!m) continue;
      const stamp = m[1];
      // Impossible / future-beyond-skew stamps are rejected so
      // a hand-crafted `.bak.99999999-999999-999` cannot
      // lexical-sort past real backups.
      if (!isValidClaudeDesktopBackupStamp(stamp, now)) continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      // Symlinks / non-regular-files are rejected — rollback
      // will read candidates via `readFileNoFollow`, which
      // would also refuse, but filtering here keeps the
      // sort set honest.
      if (st.isSymbolicLink() || !st.isFile()) continue;
      candidates.push({ abs, stamp });
    }
    if (candidates.length === 0) return null;
    // Chronological by stamp (zero-padded → lexical sort is
    // chronological).
    candidates.sort((a, b) => a.stamp.localeCompare(b.stamp));
    return candidates[candidates.length - 1].abs;
  } catch {
    return null;
  }
}

// ─── Path safety (symlink + realpath scope) ──────────────────────
//
// File-mutation strategies must not write through a symlink to a
// file outside the Claude Desktop config scope — even if the
// symlink's target is owned by the same user, an operator who
// previewed "~/Library/.../claude_desktop_config.json" and saw
// the honest path expects THAT file to change, not some sibling
// the link points at. Both preview and execute run this check;
// preview refuses early so the operator never sees a stale path
// next to an unrelated write plan.
//
// Two classes of check:
//
//   1. Existing-file check — the config file itself must not be
//      a symlink. lstat's `isSymbolicLink()` is the authoritative
//      test. A regular file or a missing file is fine (first-time
//      install is common).
//
//   2. Parent-dir realpath check — for first-time install, the
//      parent directory's realpath must land under the expected
//      client scope (e.g. `Library/Application Support/Claude`
//      on macOS). This prevents a symlinked parent directory
//      from diverting the CREATE through to an unrelated tree.

export type PathSafetyResult =
  | { ok: true; realpath: string }
  | { ok: false; reason: string };

/** Platform-anchored absolute parent paths allowed for the
 *  Claude Desktop config. The validator compares the parent's
 *  realpath against the SINGLE expected absolute path for the
 *  current platform, not a suffix match against a list of
 *  endings. A bare `endsWith("Claude")` check (the previous
 *  implementation) would accept a symlinked macOS parent to any
 *  `…/Claude`-ended path on disk; refusing requires anchoring at
 *  the real home / APPDATA root.
 *
 *  Exported (under a test-only name) so the drift guards can pin
 *  the exact expected path the runner will allow. Tests can also
 *  inject a fake `$HOME` / `%APPDATA%` by constructing paths
 *  relative to a tmpdir and passing them through the injected-
 *  homedir variant of `validateClaudeDesktopConfigPath`. */
export function expectedClaudeDesktopParentPath(
  home: string = claudeDesktopHomeDir(),
  appdata: string | undefined = process.env.APPDATA,
): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    return path.join(appdata || "", "Claude");
  }
  return path.join(home, ".config", "Claude");
}

export interface PathSafetyOpts {
  /** Override the platform-anchored expected parent directory.
   *  Tests inject a tmpdir-scoped shape so they can exercise the
   *  EQUALITY-based parent check without mutating the real home.
   *  Production leaves this undefined to derive from os.homedir()
   *  + process.platform. */
  expectedParent?: string;
}

export function validateClaudeDesktopConfigPath(
  configPath: string,
  opts: PathSafetyOpts = {},
): PathSafetyResult {
  const expectedParent = opts.expectedParent ?? expectedClaudeDesktopParentPath();
  // Ensure the claimed path is absolute — the resolver ALWAYS
  // produces absolute paths, but a future refactor could regress
  // this and we'd rather refuse than mutate a relative-resolved
  // path.
  if (!path.isAbsolute(configPath)) {
    return { ok: false, reason: `Claude config path ${configPath} is not absolute; refusing to act` };
  }
  // lstat the target. If it exists as a symlink, refuse.
  try {
    const st = fs.lstatSync(configPath);
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        reason: `Claude config path ${configPath} is a symlink. The runner refuses to write through symlinks to avoid redirecting operator-expected paths to unrelated files. Remove or inline the symlink manually, then re-run.`,
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        reason: `Claude config path ${configPath} exists but is not a regular file (lstat mode indicates a ${describeStatKind(st)}). Refusing to act.`,
      };
    }
    // Existing file is regular. Realpath it as belt-and-braces —
    // resolve any ancestor symlink and make sure we still land at
    // the expected platform-anchored parent.
    const resolved = fs.realpathSync(configPath);
    const parentCheck = validateClaudeParentDirRealpath(
      path.dirname(resolved),
      expectedParent,
    );
    if (!parentCheck.ok) return parentCheck;
    return { ok: true, realpath: resolved };
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      // First-time install case: the file doesn't exist yet.
      // Validate the PARENT directory — creating it via mkdirp is
      // allowed, but only if the nearest-existing ancestor
      // realpath still lands under the Claude scope.
      const parent = path.dirname(configPath);
      return validateClaudeParentForFirstInstall(parent, expectedParent);
    }
    return { ok: false, reason: `path-safety check failed: ${(e as Error).message}` };
  }
}

function describeStatKind(st: fs.Stats): string {
  if (st.isDirectory()) return "directory";
  if (st.isBlockDevice()) return "block device";
  if (st.isCharacterDevice()) return "character device";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  return "non-file entry";
}

function validateClaudeParentDirRealpath(
  parent: string,
  expected: string,
): PathSafetyResult {
  // Anchored equality check against the platform-canonical
  // expected parent. Refuses when:
  //
  //   - the EXPECTED parent itself is a symlink (direct
  //     diversion of the canonical location), OR
  //   - the actual parent's realpath does not match the
  //     expected parent.
  //
  // Legitimate system-level realpath resolution (e.g. macOS
  // `/var` → `/private/var`, which applies to tmpdir ancestors)
  // stays accepted by treating `realpath(expected)` as
  // interchangeable ONLY when `expected` itself is not a
  // symlink. This way, a user who explicitly symlinks
  // `~/Library/Application Support/Claude` → `/tmp/anywhere`
  // is refused outright (that's the vector the suffix-only
  // check previously missed), while a user on a filesystem
  // that transparently resolves system-level prefixes
  // elsewhere is not punished.
  let expectedIsSymlink = false;
  try {
    const est = fs.lstatSync(expected);
    expectedIsSymlink = est.isSymbolicLink();
  } catch {
    // Expected parent doesn't exist yet — fine for first-install.
  }
  if (expectedIsSymlink) {
    return {
      ok: false,
      reason: `expected Claude config parent ${expected} is itself a symlink. The runner refuses to follow a symlinked canonical location because the operator-visible preview path would diverge from the write target. Remove the symlink and re-create ${expected} as a real directory.`,
    };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(parent);
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        reason: `Claude config parent directory ${parent} does not exist; create ${parent} first (or let Claude Desktop create it on first run).`,
      };
    }
    return { ok: false, reason: `parent-dir realpath failed: ${(e as Error).message}` };
  }
  let expectedReal = expected;
  try {
    expectedReal = fs.realpathSync(expected);
  } catch {
    // Expected parent doesn't exist yet (fresh install); fall
    // back to literal.
  }
  if (resolved !== expected && resolved !== expectedReal) {
    return {
      ok: false,
      reason: `Claude config parent realpath ${resolved} is not the expected platform-anchored path ${expectedReal}. Refusing to mutate — a symlinked parent may be diverting the write to an unexpected tree. The runner ONLY accepts the exact OS-canonical Claude Desktop config directory for this user account.`,
    };
  }
  return { ok: true, realpath: resolved };
}

/** For first-time install (config file not present yet), walk up
 *  the parent chain until we find an existing ancestor, realpath
 *  that, then require the original parent's path (post-realpath
 *  of the nearest-existing ancestor) to still land under a
 *  Claude scope ending. */
function validateClaudeParentForFirstInstall(
  parent: string,
  expected: string,
): PathSafetyResult {
  let probe = parent;
  // Walk up to the first existing ancestor. Cap the walk so a
  // malformed path cannot infinite-loop.
  for (let i = 0; i < 32; i++) {
    try {
      const existsSt = fs.lstatSync(probe);
      // If any ancestor on the chain is a symlink, resolve it and
      // then re-derive the target parent to ensure the full post-
      // resolution parent chain still lands under a Claude scope.
      if (existsSt.isSymbolicLink()) {
        const ancestorReal = fs.realpathSync(probe);
        const rest = path.relative(probe, parent);
        const resolvedParent = path.resolve(ancestorReal, rest);
        return validateClaudeParentDirRealpath(resolvedParent, expected);
      }
      if (existsSt.isDirectory()) {
        // Found a real directory; final check on the original
        // parent's realpath.
        return validateClaudeParentDirRealpath(parent, expected);
      }
      return {
        ok: false,
        reason: `ancestor ${probe} exists but is not a directory (kind: ${describeStatKind(existsSt)}); refusing`,
      };
    } catch (e: any) {
      if (e && e.code === "ENOENT") {
        // Not there yet — walk up.
        const up = path.dirname(probe);
        if (up === probe) break; // reached root
        probe = up;
        continue;
      }
      return { ok: false, reason: `ancestor probe on ${probe} failed: ${(e as Error).message}` };
    }
  }
  return {
    ok: false,
    reason: `could not find an existing ancestor for ${parent}; Claude parent-dir scope cannot be verified`,
  };
}

// ─── Config-diff preview (for file_mutation extras) ──────────────
//
// The preview for install and force-repair discloses what
// `mcpServers.verity-one` currently holds (if any) so the
// operator can see what a force action would OVERWRITE. The
// "proposed" side is described structurally — we can't show the
// new JSON until the install library runs (its values depend on
// the freshly-built mcp/dist paths + the resolved nodeBin), and
// faking it would mislead.

export interface ClaudeDesktopCurrentEntry {
  present: boolean;
  /** The raw JSON value of `mcpServers["verity-one"]` when present,
   *  else null. The runner prints this redacted; the UI renders
   *  it pretty-printed so the operator sees what would be
   *  overwritten. */
  entry: unknown;
  /** Informational — reason we returned the shape we did. Not
   *  surfaced to the operator verbatim; used by tests. */
  note: string;
}

export function readCurrentClaudeDesktopEntry(configPath: string): ClaudeDesktopCurrentEntry {
  // Read via `readFileNoFollow` (O_NOFOLLOW + fstat-on-fd) —
  // race-free against a symlink swap at the final path component
  // between `validateClaudeDesktopConfigPath` (which ran at the
  // caller) and this read. An `existsSync` + path-based
  // `readFileSync` pair left a TOCTOU window where the preview
  // card could render bytes from an unexpected target while
  // `path_safety` still appeared ok=true (reviewer P2; matches
  // the `readCurrentCodexVerityOneSection` fix).
  let raw: string;
  try {
    raw = readFileNoFollow(configPath).toString("utf8");
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      return { present: false, entry: null, note: "config file does not exist yet (first-time install)" };
    }
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) {
      return {
        present: false,
        entry: null,
        note:
          "current entry not read — config file is a symlink (path-safety check will refuse the action)",
      };
    }
    return {
      present: false,
      entry: null,
      note: `could not read config file (no-follow): ${(e as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      present: false,
      entry: null,
      note: `config file is not valid JSON (${(e as Error).message}); install will refuse at execute time`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { present: false, entry: null, note: "config file top-level is not a JSON object" };
  }
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { present: false, entry: null, note: "no mcpServers block in config — this will be a first-time entry" };
  }
  const entry = (mcpServers as Record<string, unknown>)["verity-one"];
  if (entry === undefined) {
    return { present: false, entry: null, note: "mcpServers exists but has no verity-one entry yet" };
  }
  return {
    present: true,
    entry,
    note: "verity-one entry already present; force-repair will OVERWRITE it",
  };
}

// ─── Codex MCP config helpers (shipped: mcp_onboard_codex etc.) ───

/** Resolve the absolute Codex MCP config path — `<codexHome>/config.toml`.
 *
 *  Delegates to `resolveCodexHome` from `./mcp-skill-target-path` so
 *  CODEX_HOME precedence is shared with the Codex VO Skill
 *  resolver. The drift guard in
 *  `agent-lab/scripts/lib/mcp-codex-toml-merge-design.test.ts`
 *  pins that the api-side `resolveCodexHome` and the mcp-side
 *  shared resolver (`mcp/src/codex-mcp-config-path.ts`) produce
 *  byte-identical output under matched `{ home, env }`.
 *
 *  Consumed by the three Codex MCP file_mutation descriptors'
 *  preview hooks AND strategies (both callers run synchronously;
 *  dynamic-import is not an option). */
export function resolveCodexMcpConfigPath(): string {
  return path.join(
    resolveCodexHome(claudeDesktopHomeDir(), process.env),
    "config.toml",
  );
}

/** Path-safety validator for the Codex MCP config file.
 *
 *  Refuses when:
 *    - configPath is not absolute;
 *    - config file exists AND is a symlink;
 *    - config file exists AND is not a regular file;
 *    - parent directory does NOT exist (the runner does NOT
 *      auto-create `~/.codex/`; the operator or Codex itself
 *      must create it on first-run);
 *    - parent directory exists AS a symlink;
 *    - any ANCESTOR of the parent is an operator-created
 *      symlink (same `findSuspiciousAncestorSymlink` fence the
 *      Codex Skill validator uses — skips platform-level system
 *      symlinks on macOS).
 *
 *  Allowed: config file is MISSING but the parent exists and is
 *  safe — this is the first-time-install posture (the preview
 *  names the carve-out explicitly; no backup is written; rollback
 *  refuses because no eligible backup exists).
 *
 *  `realpathSync(configPath)` MAY be called but is informational
 *  ONLY — surfaced via `realpath` in the ok-result so previews can
 *  show the resolved path. NOT used as a scope gate. */
export function validateCodexMcpConfigPath(
  configPath: string,
): PathSafetyResult {
  if (!path.isAbsolute(configPath)) {
    return {
      ok: false,
      reason: `Codex MCP config path ${configPath} is not absolute; refusing to act`,
    };
  }
  const parent = path.dirname(configPath);

  // 1. Parent must exist — NO auto-create.
  let parentStat: fs.Stats | null = null;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        reason:
          `Codex home ${parent} does not exist. The action does NOT auto-create this directory — create it yourself (or let Codex create it on first-run), then retry. If you have CODEX_HOME set, the directory under that root is what's missing.`,
      };
    }
    return {
      ok: false,
      reason: `parent lstat failed for ${parent}: ${(e as Error).message}`,
    };
  }
  if (parentStat.isSymbolicLink()) {
    return {
      ok: false,
      reason: `Codex home ${parent} is a symlink; refusing to write through symlinks that would redirect the operator-visible path to an unexpected tree. Remove or inline the symlink and retry.`,
    };
  }
  if (!parentStat.isDirectory()) {
    return {
      ok: false,
      reason: `Codex home path ${parent} exists but is not a directory; refusing to act`,
    };
  }
  // 2. Ancestor-symlink walk (same shape as the Skill validator).
  const sym = findSuspiciousAncestorSymlink(parent);
  if (sym) {
    return {
      ok: false,
      reason: `Ancestor ${sym} of the Codex home ${parent} is a symlink. The runner refuses to write through a symlinked ancestor to avoid redirecting the operator-visible path (${parent}) to an unexpected physical tree. Remove or inline the symlink and retry.`,
    };
  }
  // 3. Config file itself. May be absent (first-time install).
  let configStat: fs.Stats | null = null;
  try {
    configStat = fs.lstatSync(configPath);
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      // First-time install posture — allowed.
      return { ok: true, realpath: configPath };
    }
    return {
      ok: false,
      reason: `config lstat failed for ${configPath}: ${(e as Error).message}`,
    };
  }
  if (configStat.isSymbolicLink()) {
    return {
      ok: false,
      reason: `Codex MCP config ${configPath} is a symlink. The runner refuses to write through symlinks. Remove or inline the symlink and retry.`,
    };
  }
  if (!configStat.isFile()) {
    return {
      ok: false,
      reason: `Codex MCP config ${configPath} exists but is not a regular file (${describeStatKind(configStat)}); refusing.`,
    };
  }
  let realpath: string = configPath;
  try {
    realpath = fs.realpathSync(configPath);
  } catch {
    // Informational only; ignore failure.
  }
  return { ok: true, realpath };
}

/** Take a pre-mutation snapshot of the Codex MCP config file.
 *  Mirrors `takeClaudeDesktopBackup` byte-for-byte in posture:
 *  `lstat`-fortified, reads via `readFileNoFollow`, atomic
 *  write-tmp + rename. Returns `{ ok: true, backup_path: null }`
 *  when the config does not exist yet (first-time install — no
 *  backup is written because there is nothing to preserve).
 *  Matches the contract pinned in Preview §6 `Backup plan` + the
 *  Execute §"Take a backup" bullet. */
export function takeCodexMcpBackup(
  configPath: string,
  now?: Date,
): BackupOutcome {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(configPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return {
        ok: false,
        backup_path: null,
        reason: `Codex MCP backup lstat failed: ${(e as Error).message}`,
      };
    }
  }
  if (!st) {
    return {
      ok: true,
      backup_path: null,
      reason:
        "no existing Codex MCP config — first-time install; nothing to back up",
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      backup_path: null,
      reason: `Codex MCP config ${configPath} is a symlink; refusing to backup (would read the link target's bytes, not the expected config bytes). Remove the symlink and retry.`,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      backup_path: null,
      reason: `Codex MCP config ${configPath} is not a regular file (${describeStatKind(st)}); refusing to backup.`,
    };
  }
  try {
    const bytes = readFileNoFollow(configPath);
    // Reuse `claudeDesktopBackupPath` — it is shape-agnostic
    // (`${configPath}.bak.<YYYYMMDD-HHMMSS-mmm>`) and produces
    // the same stamp the Codex MCP rollback eligibility filter
    // expects.
    const backupPath = claudeDesktopBackupPath(configPath, now);
    const tmp = backupPath + ".tmp";
    writeFileNoFollowExclusive(tmp, bytes);
    fs.renameSync(tmp, backupPath);
    return { ok: true, backup_path: backupPath };
  } catch (e) {
    return {
      ok: false,
      backup_path: null,
      reason: `backup failed: ${(e as Error).message}`,
    };
  }
}

/** Finds the latest eligible `.bak.<UTC-stamp>` sibling of the
 *  Codex MCP config. Same eligibility filter as the Claude Desktop
 *  rollback candidate finder (anchored stamp regex + real UTC
 *  round-trip + 5-min skew + regular-file lstat). Eligibility does
 *  NOT prove runner provenance. */
export function findLatestCodexMcpBackup(
  configPath: string,
  now?: Date,
): string | null {
  // Behaviorally identical to `findLatestClaudeDesktopBackup` —
  // same stamp shape, same regex, same eligibility gate.
  return findLatestClaudeDesktopBackup(configPath, now);
}

/** Preview-time mirror of `buildCodexTomlBlock` from
 *  `mcp/src/install.ts`. Returns the EXACT TOML block the
 *  execute path will hand to the merger — byte-identical to
 *  what `buildCodexTomlBlock(runtime)` produces — so the
 *  preview card can show the operator the proposed next value
 *  before confirmation. Deliberate mirror rather than a dynamic
 *  import because `resolvePreviewExtras` is synchronous and
 *  `mcp/src/install.ts` lies outside `api/src`'s tsconfig
 *  rootDir; the drift guard in
 *  `api/src/lib/mcp-local-action-runner.test.ts` asserts this
 *  function's output equals `buildCodexTomlBlock`'s under a
 *  fixture runtime so any divergence is caught immediately.
 *  Execute path STILL uses the authoritative
 *  `buildCodexTomlBlock` — this function is preview-only. */
export function formatCodexProposedBlockForPreview(runtime: {
  nodeBin: string;
  sourceDist: string;
  packageRoot: string;
}): string {
  // The installed server path is the single "args[0]" slot that
  // `buildCodexTomlBlock` computes as `installedServerPath()`
  // which resolves to `<claudeDesktopHomeDir()>/.vo/mcp/dist/
  // server.js`. At preview time we mirror the same resolution
  // so the displayed block matches the block the execute path
  // will write.
  const installedServerPath = path.join(
    claudeDesktopHomeDir(),
    ".vo",
    "mcp",
    "dist",
    "server.js",
  );
  return [
    "[mcp_servers.verity-one]",
    `command = ${JSON.stringify(runtime.nodeBin)}`,
    `args = [${JSON.stringify(installedServerPath)}]`,
    `env = { VO_URL = ${JSON.stringify("http://127.0.0.1:3100")} }`,
    "",
  ].join("\n");
}

/** Informational preview payload describing the current
 *  `[mcp_servers.verity-one]` section text the operator would
 *  OVERWRITE (force-repair) or SEE ALREADY PRESENT (non-force
 *  install). Returns `{ present: false, section: null }` for
 *  first-time install. */
export interface CodexMcpCurrentSection {
  present: boolean;
  /** Raw section bytes (header + body) or null when absent. */
  section: string | null;
  /** Informational note; not surfaced verbatim to the operator. */
  note: string;
}

export function readCurrentCodexVerityOneSection(
  configPath: string,
): CodexMcpCurrentSection {
  // Read the config via `readFileNoFollow` (O_NOFOLLOW +
  // fstat-on-fd) — the open+read is race-free against a symlink
  // swap at the final path component and against a non-regular
  // file that sneaks in between preview's path_safety check and
  // the disclosure read (reviewer P2: `lstat` + path-based
  // `readFileSync` left a TOCTOU window where the preview card
  // could render bytes from an unexpected target while
  // `path_safety` remained `ok: true`). ENOENT is the
  // first-time-install branch; ELOOP / EMLINK / non-regular
  // refusals short-circuit to the same "not read" note that
  // path_safety would have surfaced.
  let raw: string;
  try {
    raw = readFileNoFollow(configPath).toString("utf8");
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      return {
        present: false,
        section: null,
        note: "config file does not exist yet (first-time install)",
      };
    }
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) {
      return {
        present: false,
        section: null,
        note:
          "current section not read — config file is a symlink (path-safety check will refuse the action)",
      };
    }
    return {
      present: false,
      section: null,
      note: `could not read config file (no-follow): ${(e as Error).message}`,
    };
  }
  // Count sections up-front — duplicate-section config is an
  // ambiguous state the preview surfaces via the backup_note
  // plus a refusal at merge time. Grammar MUST match
  // `mcp/src/codex-toml-merge.ts::VERITY_ONE_HEADER_RE` +
  // `ANY_HEADER_RE` byte-for-byte so the preview's
  // `current_entry_json` disclosure agrees with what the merge
  // strategy actually replaces at execute time. Both regexes
  // below are the broadened TOML-v1.0.0-aware shape (trailing
  // comment tolerated on single-bracket AND array-of-tables
  // headers; array-of-tables `[[...]]` recognized as a section
  // boundary). A source-level drift guard in the runner's
  // test suite asserts these regex literals match the
  // merger's.
  const headerRe =
    /^\s*\[mcp_servers\.verity-one\]\s*(?:#.*)?$/gm;
  const headers = [...raw.matchAll(headerRe)];
  if (headers.length === 0) {
    return {
      present: false,
      section: null,
      note: "no verity-one section yet — this will be a first-time section install",
    };
  }
  if (headers.length > 1) {
    return {
      present: true,
      section: null,
      note: `config contains ${headers.length} verity-one sections (duplicate) — merge will refuse at preview time; remove duplicates first`,
    };
  }
  const start = headers[0].index ?? 0;
  const anyHeaderRe =
    /^\s*(?:\[\[[^\]]+\]\]|\[[^\]]+\])\s*(?:#.*)?$/gm;
  anyHeaderRe.lastIndex = start + headers[0][0].length;
  // Skip descendant child tables (e.g.
  // `[mcp_servers.verity-one.env]` — with or without a trailing
  // comment) so the preview shows the FULL verity-one section
  // body that `_force` would replace, matching the merger's
  // `isVerityOneDescendantHeader` behavior.
  let nextHeader: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = anyHeaderRe.exec(raw)) !== null) {
    if (
      !/^\s*\[\[?\s*mcp_servers\.verity-one\.[^\]]+\]\]?\s*(?:#.*)?$/.test(
        m[0],
      )
    ) {
      nextHeader = m;
      break;
    }
  }
  const end = nextHeader ? nextHeader.index : raw.length;
  return {
    present: true,
    section: raw.slice(start, end).trimEnd(),
    note: "verity-one section already present; force-repair will OVERWRITE it",
  };
}

/** Path-safety validator for the `~/.vo/mcp` staging tree the
 *  Claude Desktop installer writes under. The dashboard's
 *  config-path validator only covers the Claude Desktop config
 *  file — `params.install()` ALSO creates / removes / copies
 *  under `~/.vo/mcp`, including several CHILD paths the
 *  installer's path-based writes resolve through (notably
 *  `~/.vo/mcp/bin/vo-mcp` and `~/.vo/mcp/package.json` —
 *  reviewer P2 reproduced a pre-planted `~/.vo/mcp/bin`
 *  symlink redirecting the launcher write into a decoy).
 *
 *  Validates every path the installer writes through:
 *    - `<HOME>/.vo` — if exists, real directory;
 *    - `<HOME>/.vo/mcp` — if exists, real directory;
 *    - `<HOME>/.vo/mcp/dist` — if exists, real directory
 *      (installer rmSyncs + mkdirSyncs + cpSyncs here);
 *    - `<HOME>/.vo/mcp/node_modules` — if exists, real
 *      directory (same rm+mkdir+cp shape);
 *    - `<HOME>/.vo/mcp/bin` — if exists, real directory
 *      (installer mkdirSyncs then writeFileSyncs the launcher
 *      under here);
 *    - `<HOME>/.vo/mcp/bin/vo-mcp` — if exists, real regular
 *      file (installer writeFileSyncs the launcher content;
 *      a pre-planted symlink here would be followed);
 *    - `<HOME>/.vo/mcp/package.json` — if exists, real
 *      regular file (installer writeFileSyncs a minimal
 *      package.json; a pre-planted symlink would be
 *      followed).
 *
 *  Uses `claudeDesktopHomeDir()` by default (same live-`$HOME`
 *  precedence as the installer + the dashboard config
 *  resolver) so the validator sees the same tree the
 *  installer will actually write through. Tests can inject a
 *  tmpdir-scoped `home` to exercise the validator without
 *  mutating the real `$HOME`.
 *
 *  Missing paths are OK — the installer creates them on first
 *  run. This validator's job is to refuse EXISTING but wrong
 *  shapes (symlinked, non-directory, non-regular-file), not
 *  to require pre-existing paths.
 *
 *  Residual note (Node `openat` limit): the installer itself
 *  still uses path-based `writeFileSync` / `cpSync` /
 *  `mkdirSync`, so a race between this pre-install validator
 *  and the installer's first internal write CAN still divert
 *  if an attacker times a symlink plant into the window.
 *  That's the same irreducible pure-JS limit documented at
 *  the top-level install/rollback strategies. Hardening the
 *  installer's child writes (option b in the reviewer's
 *  suggestion) is a separate concern and a larger refactor
 *  of `mcp/src/install.ts`. */
export type ClaudeDesktopStagingSafetyResult =
  | { ok: true; voRoot: string; voMcp: string }
  | { ok: false; reason: string };

/** Installer-write paths under `~/.vo/mcp` that must not be a
 *  symlink or a non-regular shape when they exist. Each entry
 *  declares what kind is EXPECTED when present — directories
 *  (for installer mkdir/cp targets) and regular files (for
 *  installer writeFileSync targets). The order is shallow-to-
 *  deep so a refusal on an earlier path gives the most
 *  actionable error. */
const CLAUDE_DESKTOP_STAGING_PATHS: readonly {
  readonly segments: readonly string[];
  readonly kind: "directory" | "file";
  readonly label: string;
}[] = [
  { segments: [".vo"], kind: "directory", label: ".vo root" },
  { segments: [".vo", "mcp"], kind: "directory", label: ".vo/mcp staging root" },
  {
    segments: [".vo", "mcp", "dist"],
    kind: "directory",
    label: ".vo/mcp/dist staging directory (installer's compiled-server output)",
  },
  {
    segments: [".vo", "mcp", "node_modules"],
    kind: "directory",
    label: ".vo/mcp/node_modules staging directory (installer's runtime deps)",
  },
  {
    segments: [".vo", "mcp", "bin"],
    kind: "directory",
    label: ".vo/mcp/bin staging directory (installer's launcher-script parent)",
  },
  {
    segments: [".vo", "mcp", "bin", "vo-mcp"],
    kind: "file",
    label: ".vo/mcp/bin/vo-mcp launcher script (installer's writeFileSync target)",
  },
  {
    segments: [".vo", "mcp", "package.json"],
    kind: "file",
    label: ".vo/mcp/package.json (installer's writeFileSync target)",
  },
];

export function validateClaudeDesktopStagingRoot(
  home: string = claudeDesktopHomeDir(),
): ClaudeDesktopStagingSafetyResult {
  if (!path.isAbsolute(home)) {
    return {
      ok: false,
      reason: `resolved HOME ${home} is not absolute; refusing to validate ~/.vo/mcp staging tree`,
    };
  }
  for (const entry of CLAUDE_DESKTOP_STAGING_PATHS) {
    const abs = path.join(home, ...entry.segments);
    const st = lstatOrNull(abs);
    if (!st) continue; // missing is OK — installer creates it on first run
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        reason: `${entry.label} ${abs} is a symlink. The runner refuses to run install through a symlinked staging path — the installer would write / remove / copy bytes via ${abs} and any symlink there would redirect those writes to an unexpected target. Remove the symlink (or inline it as a real ${entry.kind}) and retry.`,
      };
    }
    if (entry.kind === "directory" && !st.isDirectory()) {
      return {
        ok: false,
        reason: `${entry.label} ${abs} exists but is not a directory (kind: ${describeStatKind(st)}); refusing to act`,
      };
    }
    if (entry.kind === "file" && !st.isFile()) {
      return {
        ok: false,
        reason: `${entry.label} ${abs} exists but is not a regular file (kind: ${describeStatKind(st)}); refusing to act — the installer's writeFileSync would either follow the shape or fail in a less actionable way`,
      };
    }
  }
  return {
    ok: true,
    voRoot: path.join(home, ".vo"),
    voMcp: path.join(home, ".vo", "mcp"),
  };
}

/** Install-runtime resolver for the Claude Desktop mutation
 *  strategies. Builds the same `InstallRuntime` shape `vo-cli`
 *  hands to `install()` — real `node` on PATH (or `VO_MCP_NODE`
 *  override), built `mcp/dist`, and `mcp/` package root. Returns
 *  a structured refusal if any prerequisite is missing. */
export type InstallRuntimeResolution =
  | {
      ok: true;
      runtime: {
        nodeBin: string;
        sourceDist: string;
        packageRoot: string;
      };
    }
  | { ok: false; reason: string };

export function resolveClaudeDesktopInstallRuntime(): InstallRuntimeResolution {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (e) {
    return {
      ok: false,
      reason: `cannot resolve repo root from api module: ${(e as Error).message}`,
    };
  }
  const packageRoot = path.join(repoRoot, "mcp");
  const sourceDist = path.join(packageRoot, "dist");
  const serverJs = path.join(sourceDist, "server.js");
  const packageNodeModules = path.join(packageRoot, "node_modules");
  if (!fs.existsSync(serverJs)) {
    return {
      ok: false,
      reason:
        "mcp package is not built — expected mcp/dist/server.js. Run `bun install --cwd mcp && bun run --cwd mcp build` first, or use `vo mcp onboard --client claude-desktop` from the CLI.",
    };
  }
  if (!fs.existsSync(packageNodeModules)) {
    return {
      ok: false,
      reason:
        "mcp/node_modules is missing — run `bun install --cwd mcp` first.",
    };
  }
  // Node-bin lookup: VO_MCP_NODE override, then `command -v node`.
  const override = process.env.VO_MCP_NODE;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!path.isAbsolute(trimmed) || !fs.existsSync(trimmed)) {
      return {
        ok: false,
        reason: `VO_MCP_NODE=${trimmed} is not an absolute path that exists on disk`,
      };
    }
    return { ok: true, runtime: { nodeBin: trimmed, sourceDist, packageRoot } };
  }
  try {
    const out = execSync("command -v node", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out || !path.isAbsolute(out)) {
      return {
        ok: false,
        reason:
          "`command -v node` did not return an absolute Node path. Install Node ≥ 20 or set VO_MCP_NODE.",
      };
    }
    return { ok: true, runtime: { nodeBin: out, sourceDist, packageRoot } };
  } catch {
    return {
      ok: false,
      reason:
        "cannot locate a Node binary — install Node ≥ 20 or set VO_MCP_NODE to an absolute path.",
    };
  }
}

// ─── Pre-install build step (stale-dist protection) ───────────────
//
// Mirrors the `vo mcp onboard` contract: the dashboard install
// action ALWAYS rebuilds `mcp/` before copying `sourceDist` into
// `~/.vo/mcp`. File existence is not a freshness signal — a
// managed checkout that just pulled main or switched branches
// can trivially leave a stale `mcp/dist/server.js` on disk.
//
// The build invocation is server-side-fixed (`bun install --cwd
// mcp` then `bun run --cwd mcp build`). The browser supplies no
// command, cwd, env, or argv. `VO_MCP_ACTION_SKIP_BUILD=1` exists
// as a local-dev override for test environments only; the tests
// themselves inject a fake runner instead.

export interface McpBuildResult {
  ok: boolean;
  /** Short, redactor-friendly summary — no raw stdout. */
  summary: string;
  /** True when the build was deliberately skipped (env override).
   *  Surfaced in the result so the operator sees that the dashboard
   *  did not refresh bytes this run. */
  skipped: boolean;
}

/** The function shape the build runner exposes. Real impl spawns
 *  `bun install --cwd mcp` then `bun run --cwd mcp build` via
 *  execFileSync. Tests inject a fake that records calls without
 *  mutating the repo. */
export type RunMcpBuild = (repoRoot: string) => McpBuildResult;

/** Fixed server-side argv for the pre-install mcp rebuild. The
 *  browser never sends these; they live here so tests can pin
 *  the EXACT shape. Two Bun CLI quirks bit earlier iterations
 *  of this file:
 *
 *    - `bun --cwd mcp install` — Bun parses the trailing
 *      positional as a SCRIPT name (`install`), ignores the
 *      `--cwd` for script resolution, and exits
 *      `Script not found "install"`. The validated shape is
 *      `bun install --cwd mcp` (subcommand first, flag after).
 *
 *    - `bun run build --cwd mcp` — Bun resolves the script
 *      `build` against the CURRENT cwd's package.json BEFORE
 *      applying `--cwd`, so if the caller's cwd has no root
 *      `build` script the command fails
 *      `Script not found "build"`. The validated shape is
 *      `bun run --cwd mcp build` — the `--cwd` flag must come
 *      BEFORE the script-name positional so it affects script
 *      resolution.
 *
 *  Both shapes below are verified on Bun 1.3.9 against the mcp/
 *  package. The same argv list is mirrored in the `vo mcp
 *  onboard` orchestrator; a regression test pins each side. */
export const MCP_BUILD_COMMANDS: readonly {
  readonly cmd: "bun";
  readonly args: readonly string[];
  readonly label: string;
}[] = [
  { cmd: "bun", args: ["install", "--cwd", "mcp"], label: "bun install --cwd mcp" },
  { cmd: "bun", args: ["run", "--cwd", "mcp", "build"], label: "bun run --cwd mcp build" },
] as const;

function truncateForSummary(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}

/** Reports whether the build step will be skipped for the current
 *  process. Used by the preview so the operator's confirmation
 *  matches what actually happens at execute time. Env override is
 *  a local-dev escape hatch; production leaves the var unset. */
export function buildStepWillBeSkipped(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.VO_MCP_ACTION_SKIP_BUILD === "1";
}

/** Preview disclosure for the pre-install build step. The preview
 *  is the operator's confirmation contract, so it must reflect
 *  what the runner will ACTUALLY do — if the env override is set
 *  the build will be skipped and the operator needs to see that
 *  BEFORE clicking confirm, not in the post-execute summary. */
export function buildStepPreviewNote(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (buildStepWillBeSkipped(env)) {
    return "Build step: SKIPPED for this run (VO_MCP_ACTION_SKIP_BUILD=1 is set in this api process's environment). The runner will NOT rebuild mcp/ before install; the existing mcp/dist will be copied into ~/.vo/mcp as-is. Unset the env var and retry the preview for a full rebuild.";
  }
  return "Build step: ACTIVE. The runner will run `bun install --cwd mcp && bun run --cwd mcp build` before install so a stale mcp/dist from a branch/update cannot be copied into ~/.vo/mcp.";
}

export const defaultRunMcpBuild: RunMcpBuild = (repoRoot) => {
  if (buildStepWillBeSkipped()) {
    return {
      ok: true,
      skipped: true,
      summary:
        "mcp/ rebuild skipped (VO_MCP_ACTION_SKIP_BUILD=1 set — local-dev override; production installs must rebuild)",
    };
  }
  for (const step of MCP_BUILD_COMMANDS) {
    try {
      execFileSync(step.cmd, [...step.args], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 180_000,
      });
    } catch (e) {
      return {
        ok: false,
        skipped: false,
        summary: `mcp/ rebuild aborted: \`${step.label}\` failed (${truncateForSummary((e as Error).message)})`,
      };
    }
  }
  return {
    ok: true,
    skipped: false,
    summary: "mcp/ rebuilt fresh from source (bun install + bun run build both ok)",
  };
};

// ─── Codex VO Skill helpers (file_mutation; backup-before-write) ─
//
// VO-MCP-SKILL-INSTALL-ACTIONS-PR-1. Adds the three Codex Skill
// `file_mutation` actions: install, disable, rollback. Reuses the
// merged Codex target-path contract in
// `api/src/lib/mcp-skill-target-path.ts` for resolution + path
// safety (symlink + ancestor-walk fence). Everything below is
// concerned with what happens AFTER `validateCodexSkillTargetPath`
// returns `ok: true` — backup, copy, rename, restore.
//
// Stamp shape mirrors the Claude Desktop runner's strict regex:
// 8-digit date, 6-digit time, 3-digit millisecond, all UTC. A
// file that merely shares the `.bak.` / `.disabled.` prefix
// (interrupted `.tmp`, prefix-only / malformed stamp, random
// suffix) is REJECTED by the restore-candidate filter below.
//
// Narrowing note (reviewer P3): the filter DOES NOT prove
// runner provenance — only that the filename matches the
// stamp shape AND the file is a regular-file (not a symlink,
// not a device, not a directory) AND the stamp parses to a
// real UTC instant in the past (+ 5-minute skew). A file
// named `SKILL.md.bak.<valid-stamp>` hand-created by `cp`
// or `touch` with a valid stamp passes the filter and is
// eligible for restore — we cannot distinguish it from a
// runner-produced file without a separate manifest/marker,
// and no such marker ships today. If runner-produced
// provenance ever becomes load-bearing, add a
// `SKILL.md.bak-manifest.jsonl` that records every backup
// this runner writes + gate the restore on manifest
// membership. Today the contract is narrower: "exact valid
// timestamp-shaped regular siblings are eligible".

/** `fs.lstatSync` wrapped to return null on ENOENT instead of
 *  throwing. Used by the Skill strategies + the backup helper
 *  to decide whether a path exists AS a regular file (not
 *  following symlinks). A plain `existsSync` would follow a
 *  symlink and disclose bytes from an unexpected target — we
 *  need the more precise check. */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Write a file at an absolute path without ever following a
 *  pre-planted symlink at the final path component AND without
 *  overwriting any existing regular file at that path — race-
 *  free. This is the alternative to `fs.writeFileSync(abs,
 *  bytes)`, which follows an existing symlink AND clobbers any
 *  pre-existing regular file at `abs`. Intended for temp-file
 *  writes where the caller will atomically `rename(tmp,
 *  target)` afterward — so `tmp` must not pre-exist in any
 *  shape.
 *
 *  Implementation: `open(abs, O_WRONLY | O_CREAT | O_EXCL |
 *  O_NOFOLLOW)` fails with EEXIST if anything exists at `abs`
 *  (including a pre-planted symlink) AND fails with ELOOP on
 *  POSIX if the final component is a symlink. Together these
 *  two flags guarantee:
 *    - a pre-planted symlink at `abs` cannot divert the write
 *      to a decoy file (reviewer P2: `fs.writeFileSync(tmp,
 *      bytes)` with a path like `SKILL.md.tmp` pre-planted as
 *      a symlink followed the symlink and overwrote the
 *      decoy, leaving `SKILL.md` as a symlink after the
 *      caller's subsequent rename);
 *    - a race-installed file at `abs` after the caller
 *      checked presence is refused (the path must not exist
 *      at open time).
 *
 *  Mode 0o600 matches the default for operator-private
 *  artifacts. Bytes are written via `writeSync(fd, bytes)` then
 *  `closeSync(fd)`. The caller's subsequent `rename(abs,
 *  target)` replaces the entry at `target` atomically — POSIX
 *  rename does NOT follow a symlink on the destination.
 *
 *  The narrow window between `closeSync(fd)` and the caller's
 *  `renameSync` is an irreducible pure-JS limit (Node does not
 *  expose `linkat(fd, …)` for fd-bound atomic link), but it
 *  is orders of magnitude smaller than the open-and-write
 *  window the previous path-based writeFileSync left exposed.
 *
 *  On Windows `O_NOFOLLOW` is typically a no-op — the
 *  `O_EXCL` fallback still refuses pre-existing files of any
 *  kind. */
function writeFileNoFollowExclusive(
  abs: string,
  bytes: Buffer | string,
  mode = 0o600,
): void {
  const oNoFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(
    abs,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | oNoFollow,
    mode,
  );
  try {
    fs.writeSync(fd, bytes as never);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read a file at an absolute path without ever following a
 *  symlink at the final path component — race-free. This is
 *  the alternative to `fs.lstatSync(abs)` + `fs.readFileSync(abs)`,
 *  which has a window between the lstat and the read where an
 *  attacker could swap the file to a symlink; the bytes read
 *  would then come from the link target, not the lstat'd
 *  regular file.
 *
 *  Implementation: `open(abs, O_RDONLY | O_NOFOLLOW)` fails with
 *  ELOOP on POSIX if the final component is a symlink.
 *  `fstat` on the fd returns the stats of whatever was opened
 *  (no path resolution); `readFileSync(fd)` reads from the fd
 *  (no path resolution). Nothing between open and read can
 *  divert bytes.
 *
 *  On Windows `O_NOFOLLOW` is typically a no-op — the `fstat`
 *  + `isFile()` check below is the fallback there. Production
 *  VO deployments run on POSIX; this is defense in depth for
 *  the POSIX case and best-effort on Windows. */
function readFileNoFollow(abs: string): Buffer {
  const oNoFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | oNoFollow);
  try {
    const st = fs.fstatSync(fd);
    if (st.isSymbolicLink()) {
      throw new Error(
        `${abs} is a symlink at the final path component (O_NOFOLLOW should have refused this; defensive fstat fallback caught it)`,
      );
    }
    if (!st.isFile()) {
      throw new Error(
        `${abs} is not a regular file (${describeStatKind(st)}); refusing to read`,
      );
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function codexSkillStamp(now?: Date): string {
  const d = now ?? new Date();
  return (
    d.getUTCFullYear().toString().padStart(4, "0") +
    (d.getUTCMonth() + 1).toString().padStart(2, "0") +
    d.getUTCDate().toString().padStart(2, "0") +
    "-" +
    d.getUTCHours().toString().padStart(2, "0") +
    d.getUTCMinutes().toString().padStart(2, "0") +
    d.getUTCSeconds().toString().padStart(2, "0") +
    "-" +
    d.getUTCMilliseconds().toString().padStart(3, "0")
  );
}

export function codexSkillBackupPath(skillFile: string, now?: Date): string {
  const dir = path.dirname(skillFile);
  return path.join(dir, `SKILL.md.bak.${codexSkillStamp(now)}`);
}

export function codexSkillDisabledPath(skillFile: string, now?: Date): string {
  const dir = path.dirname(skillFile);
  return path.join(dir, `SKILL.md.disabled.${codexSkillStamp(now)}`);
}

/** Strict pattern: `SKILL.md.bak.<8digit>-<6digit>-<3digit>`.
 *  Rejects `.tmp`, hand-created shapes, random suffixes. */
const CODEX_SKILL_BACKUP_STAMP_RE = /^SKILL\.md\.bak\.\d{8}-\d{6}-\d{3}$/;

/** Strict pattern: `SKILL.md.disabled.<8digit>-<6digit>-<3digit>`. */
const CODEX_SKILL_DISABLED_STAMP_RE = /^SKILL\.md\.disabled\.\d{8}-\d{6}-\d{3}$/;

/** Combined restore-candidate pattern with kind + stamp capture
 *  groups so callers can report which kind of restore they'll
 *  perform. */
const CODEX_SKILL_RESTORE_CANDIDATE_RE =
  /^SKILL\.md\.(bak|disabled)\.(\d{8}-\d{6}-\d{3})$/;

/** Future-skew tolerance for a runner-produced stamp. A stamp
 *  more than this far past `now` is treated as impossible —
 *  either a wall-clock glitch during write (rare) or a hand-
 *  crafted file meant to leapfrog real backups in rollback
 *  selection. 5 minutes is loose enough for NTP / VM hypervisor
 *  drift but tight enough to refuse `99999999-999999-999`. */
const CODEX_SKILL_STAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Parse a runner-produced stamp `YYYYMMDD-HHMMSS-mmm` (all UTC)
 *  into a `Date`. Returns null when the stamp is the wrong shape
 *  OR when the parsed fields don't round-trip (month > 12, day
 *  beyond month length, hour > 23, etc.). This is the second
 *  line of defense after the anchored regex on the filename —
 *  the regex accepts any digit sequence of the right length,
 *  so a stamp like `99999999-999999-999` superficially matches
 *  but is not a real date. The round-trip check rejects it. */
export function parseCodexSkillStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(stamp);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const millisecond = Number(m[7]);
  // Cheap out-of-range rejections before Date.UTC so the round-
  // trip check below is not the only line of defense.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23) return null;
  if (minute > 59) return null;
  // Allow leap second (60) on the second field — Date.UTC
  // normalizes it; the round-trip check below rejects the
  // resulting drift if unwanted.
  if (second > 60) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // Round-trip check — Date.UTC silently normalizes overflow
  // (month 13 → January of year+1), so if the parsed components
  // don't match the output components, the input was impossible.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second ||
    d.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return d;
}

/** True when `stamp` parses to a real UTC date that is not in
 *  the future beyond `CODEX_SKILL_STAMP_FUTURE_SKEW_MS`. The
 *  second test rejects hand-crafted stamps aimed at leapfrogging
 *  real backups in rollback selection (filenames lexical-sort,
 *  so `99999999-999999-999` would otherwise always win). */
export function isValidCodexSkillStamp(stamp: string, now?: Date): boolean {
  const parsed = parseCodexSkillStamp(stamp);
  if (!parsed) return false;
  const nowMs = (now ?? new Date()).getTime();
  if (parsed.getTime() > nowMs + CODEX_SKILL_STAMP_FUTURE_SKEW_MS) return false;
  return true;
}

export function isCodexSkillRunnerBackup(filename: string, now?: Date): boolean {
  const m = CODEX_SKILL_BACKUP_STAMP_RE.exec(filename);
  if (!m) return false;
  // Extract the stamp after the final `SKILL.md.bak.` prefix.
  const stamp = filename.slice("SKILL.md.bak.".length);
  return isValidCodexSkillStamp(stamp, now);
}

export function isCodexSkillRunnerDisabled(filename: string, now?: Date): boolean {
  if (!CODEX_SKILL_DISABLED_STAMP_RE.test(filename)) return false;
  const stamp = filename.slice("SKILL.md.disabled.".length);
  return isValidCodexSkillStamp(stamp, now);
}

export interface CodexSkillRestoreCandidate {
  absPath: string;
  kind: "bak" | "disabled";
  stamp: string;
}

/** Finds the latest eligible `.bak.<UTC-stamp>` or
 *  `.disabled.<UTC-stamp>` sibling of the pinned Codex
 *  `SKILL.md`.
 *
 *  Eligibility — an entry is eligible ONLY when ALL of the
 *  following hold:
 *    - filename matches `^SKILL.md.(bak|disabled).<8-6-3-digit-
 *      UTC-stamp>$` (anchored regex — rejects prefix-only,
 *      trailing-noise, `.tmp` shapes);
 *    - stamp parses to a real UTC instant (`isValidCodex-
 *      SkillStamp` — rejects impossible calendar fields like
 *      `99999999-999999-999`) that is NOT in the future
 *      beyond the `CODEX_SKILL_STAMP_FUTURE_SKEW_MS`
 *      tolerance (rejects hand-crafted stamps aimed at
 *      leapfrogging real backups in lexical sort);
 *    - `lstat(abs)` reports a regular file — NOT a symlink,
 *      NOT a device, NOT a directory.
 *
 *  Eligibility DOES NOT prove runner provenance (reviewer
 *  P3). The filter cannot distinguish a runner-produced
 *  backup from a hand-created file at the same exact stamp
 *  shape — e.g. `cp some-other-file
 *  SKILL.md.bak.20260420-120000-000` passes every check
 *  above. If an operator plants a well-named regular file in
 *  the per-Skill directory, it IS eligible for restore.
 *  Today that's acceptable: the Skill directory is owned by
 *  the same operator account that runs the dashboard, and a
 *  hostile process with write access to that directory can
 *  do worse things than leapfrog rollback selection. If
 *  provenance ever becomes load-bearing, add a manifest.
 *
 *  Returns null when no eligible candidate exists. */
export function findLatestCodexSkillRestoreCandidate(
  skillFile: string,
  now?: Date,
): CodexSkillRestoreCandidate | null {
  const dir = path.dirname(skillFile);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: CodexSkillRestoreCandidate[] = [];
  for (const name of entries) {
    const m = CODEX_SKILL_RESTORE_CANDIDATE_RE.exec(name);
    if (!m) continue;
    const stamp = m[2];
    // Second line of defense past the anchored regex — reject
    // impossible dates (month 99 etc.) and stamps beyond the
    // future-skew tolerance so an attacker cannot plant
    // `SKILL.md.bak.99999999-999999-999` to lexical-sort past
    // real runner-produced backups.
    if (!isValidCodexSkillStamp(stamp, now)) continue;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    candidates.push({ absPath: abs, kind: m[1] as "bak" | "disabled", stamp });
  }
  if (candidates.length === 0) return null;
  // Sort chronologically by stamp (the filename field is already
  // zero-padded so lexical sort == chronological). Since the
  // isValidCodexSkillStamp check above rejected impossible /
  // future stamps, lexical sort is safe — every remaining
  // candidate parses to a real past UTC instant.
  candidates.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return candidates[candidates.length - 1];
}

/** Take a pre-mutation snapshot of the current Codex SKILL.md.
 *  Atomic (write-tmp + rename). If the file does not yet exist,
 *  returns `{ ok: true, backup_path: null }` — first-time install
 *  has nothing to preserve.
 *
 *  Uses `lstat` (NOT `existsSync`) for the presence check so a
 *  symlink swapped in at `skillFile` between the caller's path-
 *  safety check and this call is REFUSED rather than followed.
 *  Otherwise we'd read the link target's bytes (attacker-
 *  controlled) into a runner-produced `.bak.<UTC-stamp>` sibling,
 *  which would later be restored by `skill_rollback_codex`. */
export function takeCodexSkillBackup(
  skillFile: string,
  now?: Date,
): BackupOutcome {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(skillFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return {
        ok: false,
        backup_path: null,
        reason: `Codex Skill backup lstat failed: ${(e as Error).message}`,
      };
    }
  }
  if (!st) {
    return {
      ok: true,
      backup_path: null,
      reason:
        "no existing SKILL.md at the Codex target — first-time install; nothing to back up",
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      backup_path: null,
      reason: `SKILL.md at the Codex target ${skillFile} is a symlink; refusing to backup (would read the link target's bytes, not the expected Skill bytes). Remove the symlink and retry.`,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      backup_path: null,
      reason: `SKILL.md at the Codex target ${skillFile} is not a regular file (${describeStatKind(st)}); refusing to backup.`,
    };
  }
  try {
    // Read through `O_NOFOLLOW` + fstat-on-fd so a symlink
    // swapped in at skillFile between the lstat above and here
    // cannot divert the backup to read bytes from the link
    // target. The lstat is still the first line of defense
    // (gives an operator-readable refusal reason for the common
    // case); this call is the race-free second line.
    const bytes = readFileNoFollow(skillFile);
    const backupPath = codexSkillBackupPath(skillFile, now);
    const tmp = backupPath + ".tmp";
    writeFileNoFollowExclusive(tmp, bytes);
    fs.renameSync(tmp, backupPath);
    return { ok: true, backup_path: backupPath };
  } catch (e) {
    return {
      ok: false,
      backup_path: null,
      reason: `Codex Skill backup failed: ${(e as Error).message}`,
    };
  }
}

/** Claude Desktop VO Skill backup helper — mirrors
 *  `takeCodexSkillBackup` byte-for-byte in posture (lstat-gated
 *  presence check, `readFileNoFollow` + atomic write-tmp +
 *  rename, first-time-install carve-out). Lives as a separate
 *  function ONLY so error messages name "Claude Desktop Skill"
 *  instead of "Codex Skill" — the underlying filesystem
 *  discipline is identical. Consumed by the three Claude
 *  Desktop Skill strategies (install/disable/rollback) that
 *  ship in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`. */
export function takeClaudeDesktopSkillBackup(
  skillFile: string,
  now?: Date,
): BackupOutcome {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(skillFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return {
        ok: false,
        backup_path: null,
        reason: `Claude Desktop Skill backup lstat failed: ${(e as Error).message}`,
      };
    }
  }
  if (!st) {
    return {
      ok: true,
      backup_path: null,
      reason:
        "no existing SKILL.md at the Claude Desktop target — first-time install; nothing to back up",
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      backup_path: null,
      reason: `SKILL.md at the Claude Desktop target ${skillFile} is a symlink; refusing to backup (would read the link target's bytes, not the expected Skill bytes). Remove the symlink and retry.`,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      backup_path: null,
      reason: `SKILL.md at the Claude Desktop target ${skillFile} is not a regular file (${describeStatKind(st)}); refusing to backup.`,
    };
  }
  try {
    const bytes = readFileNoFollow(skillFile);
    // Reuse the Codex-named pure path helper — the stamp shape
    // is client-agnostic (`<skillFile>.bak.<UTC-stamp>`), so
    // both client resolvers share one path-arithmetic
    // implementation. The per-client refusal-message parity
    // lives in this function body, not in the path helper.
    const backupPath = codexSkillBackupPath(skillFile, now);
    const tmp = backupPath + ".tmp";
    writeFileNoFollowExclusive(tmp, bytes);
    fs.renameSync(tmp, backupPath);
    return { ok: true, backup_path: backupPath };
  } catch (e) {
    return {
      ok: false,
      backup_path: null,
      reason: `Claude Desktop Skill backup failed: ${(e as Error).message}`,
    };
  }
}

export type CodexSkillTargetState =
  | { state: "absent" }
  | {
      state: "present-same" | "present-different" | "present-unreadable-source";
      size_bytes: number;
      mtime: string;
      sha256_prefix: string;
      source_sha256_prefix?: string;
    };

/** Reads the current SKILL.md at the resolved Codex target and
 *  compares it to the repo source (when resolvable). Used by the
 *  install preview so the operator sees `absent`, `present-same`
 *  (install is a no-op refresh), or `present-different` (install
 *  will OVERWRITE) BEFORE confirming. Hash prefix only — full
 *  hashes aren't needed for the operator to decide. */
export function readCodexSkillTargetState(
  skillFile: string,
  sourcePath?: string,
): CodexSkillTargetState {
  const st = lstatOrNull(skillFile);
  if (!st) return { state: "absent" };
  if (st.isSymbolicLink() || !st.isFile()) return { state: "absent" };
  try {
    const bytes = readFileNoFollow(skillFile);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const sourceStat = sourcePath ? lstatOrNull(sourcePath) : null;
    if (!sourcePath || !sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      return {
        state: "present-unreadable-source",
        size_bytes: st.size,
        mtime: st.mtime.toISOString(),
        sha256_prefix: sha.slice(0, 12),
      };
    }
    const src = readFileNoFollow(sourcePath);
    const srcSha = createHash("sha256").update(src).digest("hex");
    return {
      state: sha === srcSha ? "present-same" : "present-different",
      size_bytes: st.size,
      mtime: st.mtime.toISOString(),
      sha256_prefix: sha.slice(0, 12),
      source_sha256_prefix: srcSha.slice(0, 12),
    };
  } catch {
    // If something transient prevents reading, hide the error —
    // execute will re-run path safety + state check and surface a
    // clean refusal if the problem persists.
    return { state: "absent" };
  }
}

/** Shared Skill-preview extras builder. The three Skill descriptors
 *  each invoke this with their own `kind` so the preview copy can
 *  reflect what the action actually does while keeping the
 *  disclosure fields (touched_config_path, mutates, backup_note,
 *  change_note, path_safety, extra_notes) consistent. */
function buildCodexSkillPreviewExtras(
  kind: "install" | "disable" | "rollback",
): PreviewExtras {
  const safety = validateCodexSkillTargetPath();
  const target: CodexSkillTargetPath = safety.ok
    ? safety.target
    : resolveCodexSkillTargetPath();
  const { skillFile } = target;
  // Source path — only needed by install for the state comparison.
  let sourcePath: string | undefined;
  try {
    sourcePath = path.join(resolveRepoRoot(), CODEX_SKILL_SOURCE_REL_PATH);
  } catch {
    sourcePath = undefined;
  }
  // Current target state — only read when path-safety passed (the
  // validator refused a symlink/ancestor diversion; reading through
  // a refused path would disclose bytes from the unexpected target).
  const targetState: CodexSkillTargetState = safety.ok
    ? readCodexSkillTargetState(skillFile, sourcePath)
    : { state: "absent" };
  const latestRestore = safety.ok
    ? findLatestCodexSkillRestoreCandidate(skillFile)
    : null;

  // Shared extra_notes — every Skill preview must carry the
  // MCP-not-touched disclaimer + status-stays-manual and must
  // redirect Claude Desktop / generic to their own channels.
  const sharedNotes: string[] = [
    "MCP connection config is NOT touched. This action writes ONLY under the Codex Skills directory; `~/.codex/config.toml`, Claude Desktop config, `~/.vo`, the acceptance artifact, and any hosted / remote MCP surface are NOT modified.",
    "Claude Desktop VO Skill install / disable / rollback ship as separate allowlisted actions (`skill_*_claude_desktop`) under a VO-provisional darwin pin — this Codex action does NOT touch Claude Desktop Skill directories.",
    "Generic VO Skill support stays permanently `unsupported` — no writable Skills directory can be inferred for an unknown host.",
    "Status re-read after execute runs the rung-10 Skill checker and may promote the Codex Skill row to a filesystem state (`installed`, `disabled`, `stale`, or `not_installed`). It still does NOT promote to `enabled` from a successful write alone; `enabled` requires a fresh same-client Skill acceptance cell with `skill_observed=true` + a non-empty note.",
  ];

  // Per-kind preview copy. Each branch sets: mutates, backup_note,
  // change_note, and any kind-specific extra notes.
  if (kind === "install") {
    const mutates = [skillFile, `${skillFile}.bak.<UTC-stamp>`];
    let changeNote: string;
    let currentEntryJson: string | null = null;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not read or describe the current target until the refusal is resolved.";
    } else if (targetState.state === "absent") {
      changeNote =
        "First-time install — no SKILL.md exists at the Codex target yet. A new file is created; no backup is needed.";
    } else if (targetState.state === "present-same") {
      changeNote = `The existing SKILL.md at the Codex target already matches the repo source (sha256 prefix ${targetState.sha256_prefix}). Install atomically rewrites the same bytes — a backup is still taken before the write so the mtime-only change is reversible.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    } else if (targetState.state === "present-different") {
      changeNote = `The existing SKILL.md at the Codex target DIFFERS from the repo source (target sha256 ${targetState.sha256_prefix} vs source ${targetState.source_sha256_prefix ?? "?"}). Install will OVERWRITE the current bytes; the prior bytes land in a timestamped \`.bak.<UTC-stamp>\` sibling.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
            source_sha256_prefix: targetState.source_sha256_prefix,
          },
          null,
          2,
        ),
      );
    } else {
      changeNote = `The Codex target exists but the repo source at ${sourcePath ?? "(unresolved)"} could not be read for comparison. Install will still attempt a copy; a backup is taken before any write.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
    return {
      touched_config_path: skillFile,
      mutates,
      backup_note:
        "A timestamped `SKILL.md.bak.<UTC-stamp>` sibling is written atomically before any overwrite. First-time install skips the backup (nothing to preserve) and the preview says so in `change_note`.",
      change_note: changeNote,
      current_entry_json: currentEntryJson,
      path_safety: safety.ok
        ? { ok: true as const, realpath: safety.skillsRootRealpath }
        : { ok: false as const, reason: safety.reason },
      extra_notes: [
        `Source (authoritative): \`${CODEX_SKILL_SOURCE_REL_PATH}\` in this repo. The action copies ONLY from that path — no other source is allowed.`,
        "Rollback: run `skill_rollback_codex` after this install to restore the latest valid `.bak.<UTC-stamp>` sibling. Manual fallback: `cp <bak> SKILL.md` in the same directory.",
        ...sharedNotes,
      ],
    };
  }
  if (kind === "disable") {
    const mutates = [skillFile, `${skillFile}.disabled.<UTC-stamp>`];
    let changeNote: string;
    let currentEntryJson: string | null = null;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not read or describe the current target until the refusal is resolved.";
    } else if (targetState.state === "absent") {
      changeNote =
        "No SKILL.md exists at the Codex target — disable will REFUSE at execute time (nothing to disable).";
    } else {
      changeNote = `The current SKILL.md will be RENAMED (bytes preserved) to \`SKILL.md.disabled.<UTC-stamp>\` in the same directory. No delete, no separate backup — the rename itself preserves the bytes. Reverse via \`skill_rollback_codex\` or \`mv <disabled> SKILL.md\`.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
    return {
      touched_config_path: skillFile,
      mutates,
      backup_note:
        "Disable is rename-to-disabled, NOT a separate backup + delete. The current SKILL.md bytes move intact into the `.disabled.<UTC-stamp>` sibling; no unrelated Skills are touched.",
      change_note: changeNote,
      current_entry_json: currentEntryJson,
      path_safety: safety.ok
        ? { ok: true as const, realpath: safety.skillsRootRealpath }
        : { ok: false as const, reason: safety.reason },
      extra_notes: [
        "Rollback: `skill_rollback_codex` restores the latest eligible `.bak.<UTC-stamp>` OR `.disabled.<UTC-stamp>` sibling — eligibility = anchored regex + real UTC stamp + not-future + regular-file. `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. Eligibility does NOT prove runner provenance.",
        ...sharedNotes,
      ],
    };
  }
  // rollback
  const mutates = latestRestore
    ? [skillFile, `${skillFile}.bak.<UTC-stamp> (safety copy of current, if present)`]
    : [skillFile];
  let changeNote: string;
  let currentEntryJson: string | null = null;
  if (!safety.ok) {
    changeNote =
      "Path safety refused (see `path_safety`). Preview will not read or describe the restore candidates until the refusal is resolved.";
  } else if (!latestRestore) {
    changeNote =
      "No valid `SKILL.md.bak.<UTC-stamp>` or `SKILL.md.disabled.<UTC-stamp>` sibling found on disk — rollback will REFUSE at execute time. Run `skill_install_codex` or `skill_disable_codex` first.";
  } else {
    changeNote = `The latest eligible sibling is \`${latestRestore.absPath}\` (kind: ${latestRestore.kind}, stamp: ${latestRestore.stamp}). Restoring it REPLACES the current SKILL.md; a fresh safety backup of the current bytes is taken first so the rollback is itself reversible. Eligibility = exact stamp shape + real UTC instant + regular file; it does NOT prove the sibling was written by this runner.`;
    if (targetState.state !== "absent") {
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
  }
  return {
    touched_config_path: skillFile,
    mutates,
    backup_note: latestRestore
      ? `Latest restore candidate: \`${latestRestore.absPath}\`. A fresh \`SKILL.md.bak.<UTC-stamp>\` safety backup of the current SKILL.md (if present) is taken before the restore so the rollback itself is reversible.`
      : "No valid `.bak.*` or `.disabled.*` sibling found on disk — rollback will refuse at execute time. No safety backup is taken when nothing will be written.",
    change_note: changeNote,
    current_entry_json: currentEntryJson,
    path_safety: safety.ok
      ? { ok: true as const, realpath: safety.skillsRootRealpath }
      : { ok: false as const, reason: safety.reason },
    extra_notes: [
      "Strict candidate filter: only exact valid timestamp-shaped regular siblings are eligible — filename matches `SKILL.md.bak.<8digit>-<6digit>-<3digit>` or `SKILL.md.disabled.<8digit>-<6digit>-<3digit>`, stamp parses to a real UTC instant (rejects impossible calendar fields + future stamps beyond a 5-minute skew), and the entry is a regular file (not a symlink, not a device, not a directory). `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. NOTE: eligibility does NOT prove runner provenance — a file hand-created at the same exact stamp shape is also eligible; if you need provenance, do not roll back to a sibling you did not produce.",
      ...sharedNotes,
    ],
  };
}

/** Preview-extras helper for the three Claude Desktop VO Skill
 *  descriptors (`skill_install_claude_desktop`,
 *  `skill_disable_claude_desktop`,
 *  `skill_rollback_claude_desktop`). Mirrors
 *  `buildCodexSkillPreviewExtras` byte-for-byte in structure —
 *  same four branches (path-safety refused / absent /
 *  present-same / present-different), same shared-notes
 *  shape, same `current_entry_json` redaction shape — but
 *  consumes the Claude Desktop target-path validator
 *  (`validateClaudeDesktopSkillTargetPath`) and names the
 *  Claude Desktop surface in every operator-facing string.
 *  `control_scope: "vo_skill"` for all three descriptors;
 *  MCP connection config is NOT touched. Status re-read runs
 *  the rung-10 Skill checker; `enabled` remains gated on
 *  Skill-specific operator attestation. */
function buildClaudeDesktopSkillPreviewExtras(
  kind: "install" | "disable" | "rollback",
): PreviewExtras {
  const safety = validateClaudeDesktopSkillTargetPath();
  const target: ClaudeDesktopSkillTargetPath = safety.ok
    ? safety.target
    : resolveClaudeDesktopSkillTargetPath();
  const { skillFile } = target;
  let sourcePath: string | undefined;
  try {
    sourcePath = path.join(
      resolveRepoRoot(),
      CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH,
    );
  } catch {
    sourcePath = undefined;
  }
  // `readCodexSkillTargetState` and
  // `findLatestCodexSkillRestoreCandidate` are client-agnostic
  // (filename-based — every Skill target uses `SKILL.md` + the
  // same `.bak.<UTC-stamp>` / `.disabled.<UTC-stamp>` suffix
  // grammar). Reuse them for Claude Desktop Skill previews so
  // the two client-specific preview helpers share one
  // implementation of the current-target-state shape + the
  // restore-candidate scan.
  const targetState: CodexSkillTargetState = safety.ok
    ? readCodexSkillTargetState(skillFile, sourcePath)
    : { state: "absent" };
  const latestRestore = safety.ok
    ? findLatestCodexSkillRestoreCandidate(skillFile)
    : null;

  const sharedNotes: string[] = [
    "MCP connection config is NOT touched. This action writes ONLY under the Claude Desktop AgentSkills directory; Claude Desktop's `claude_desktop_config.json`, `~/.codex/config.toml`, `~/.vo`, the acceptance artifact, and any hosted / remote MCP surface are NOT modified.",
    "The target path is a VO-PROVISIONAL pin (darwin: `~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md`) — NOT Anthropic-authoritative. If Anthropic later publishes the authoritative writable Skills directory and it differs, the target-path module updates in lockstep; the drift guard catches silent divergence.",
    "Codex VO Skill surface is separate — `skill_install_codex` / `skill_disable_codex` / `skill_rollback_codex` target `~/.codex/skills/verity-one-mcp/SKILL.md` under the same `(tenant, vo_skill)` lock.",
    "Generic VO Skill support stays permanently `unsupported` — no writable Skills directory can be inferred for an unknown host.",
    "Status re-read after execute runs the rung-10 Skill checker and may promote the Claude Desktop Skill row to a filesystem state (`installed`, `disabled`, `stale`, or `not_installed`). It still does NOT promote to `enabled` from a successful write alone; `enabled` requires a fresh same-client Skill acceptance cell with `skill_observed=true` + a non-empty note.",
  ];

  if (kind === "install") {
    const mutates = [skillFile, `${skillFile}.bak.<UTC-stamp>`];
    let changeNote: string;
    let currentEntryJson: string | null = null;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not read or describe the current target until the refusal is resolved.";
    } else if (targetState.state === "absent") {
      changeNote =
        "First-time install — no SKILL.md exists at the Claude Desktop target yet. A new file is created; no backup is needed.";
    } else if (targetState.state === "present-same") {
      changeNote = `The existing SKILL.md at the Claude Desktop target already matches the repo source (sha256 prefix ${targetState.sha256_prefix}). Install atomically rewrites the same bytes — a backup is still taken before the write so the mtime-only change is reversible.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    } else if (targetState.state === "present-different") {
      changeNote = `The existing SKILL.md at the Claude Desktop target DIFFERS from the repo source (target sha256 ${targetState.sha256_prefix} vs source ${targetState.source_sha256_prefix ?? "?"}). Install will OVERWRITE the current bytes; the prior bytes land in a timestamped \`.bak.<UTC-stamp>\` sibling.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
            source_sha256_prefix: targetState.source_sha256_prefix,
          },
          null,
          2,
        ),
      );
    } else {
      changeNote = `The Claude Desktop target exists but the repo source at ${sourcePath ?? "(unresolved)"} could not be read for comparison. Install will still attempt a copy; a backup is taken before any write.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
    return {
      touched_config_path: skillFile,
      mutates,
      backup_note:
        "A timestamped `SKILL.md.bak.<UTC-stamp>` sibling is written atomically before any overwrite. First-time install skips the backup (nothing to preserve) and the preview says so in `change_note`.",
      change_note: changeNote,
      current_entry_json: currentEntryJson,
      path_safety: safety.ok
        ? { ok: true as const, realpath: safety.skillsRootRealpath }
        : { ok: false as const, reason: safety.reason },
      extra_notes: [
        `Source (authoritative): \`${CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH}\` in this repo. The action copies ONLY from that path — no other source is allowed.`,
        "Rollback: run `skill_rollback_claude_desktop` after this install to restore the latest valid `.bak.<UTC-stamp>` sibling. Manual fallback: `cp <bak> SKILL.md` in the same directory.",
        ...sharedNotes,
      ],
    };
  }
  if (kind === "disable") {
    const mutates = [skillFile, `${skillFile}.disabled.<UTC-stamp>`];
    let changeNote: string;
    let currentEntryJson: string | null = null;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not read or describe the current target until the refusal is resolved.";
    } else if (targetState.state === "absent") {
      changeNote =
        "No SKILL.md exists at the Claude Desktop target — disable will REFUSE at execute time (nothing to disable).";
    } else {
      changeNote = `The current SKILL.md will be RENAMED (bytes preserved) to \`SKILL.md.disabled.<UTC-stamp>\` in the same directory. No delete, no separate backup — the rename itself preserves the bytes. Reverse via \`skill_rollback_claude_desktop\` or \`mv <disabled> SKILL.md\`.`;
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
    return {
      touched_config_path: skillFile,
      mutates,
      backup_note:
        "Disable is rename-to-disabled, NOT a separate backup + delete. The current SKILL.md bytes move intact into the `.disabled.<UTC-stamp>` sibling; no unrelated Skills are touched.",
      change_note: changeNote,
      current_entry_json: currentEntryJson,
      path_safety: safety.ok
        ? { ok: true as const, realpath: safety.skillsRootRealpath }
        : { ok: false as const, reason: safety.reason },
      extra_notes: [
        "Rollback: `skill_rollback_claude_desktop` restores the latest eligible `.bak.<UTC-stamp>` OR `.disabled.<UTC-stamp>` sibling — eligibility = anchored regex + real UTC stamp + not-future + regular-file. `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. Eligibility does NOT prove runner provenance.",
        ...sharedNotes,
      ],
    };
  }
  // rollback
  const mutates = latestRestore
    ? [skillFile, `${skillFile}.bak.<UTC-stamp> (safety copy of current, if present)`]
    : [skillFile];
  let changeNote: string;
  let currentEntryJson: string | null = null;
  if (!safety.ok) {
    changeNote =
      "Path safety refused (see `path_safety`). Preview will not read or describe the restore candidates until the refusal is resolved.";
  } else if (!latestRestore) {
    changeNote =
      "No valid `SKILL.md.bak.<UTC-stamp>` or `SKILL.md.disabled.<UTC-stamp>` sibling found on disk — rollback will REFUSE at execute time. Run `skill_install_claude_desktop` or `skill_disable_claude_desktop` first.";
  } else {
    changeNote = `The latest eligible sibling is \`${latestRestore.absPath}\` (kind: ${latestRestore.kind}, stamp: ${latestRestore.stamp}). Restoring it REPLACES the current SKILL.md; a fresh safety backup of the current bytes is taken first so the rollback is itself reversible. Eligibility = exact stamp shape + real UTC instant + regular file; it does NOT prove the sibling was written by this runner.`;
    if (targetState.state !== "absent") {
      currentEntryJson = redactOutput(
        JSON.stringify(
          {
            state: targetState.state,
            size_bytes: targetState.size_bytes,
            mtime: targetState.mtime,
            sha256_prefix: targetState.sha256_prefix,
          },
          null,
          2,
        ),
      );
    }
  }
  return {
    touched_config_path: skillFile,
    mutates,
    backup_note: latestRestore
      ? `Latest restore candidate: \`${latestRestore.absPath}\`. A fresh \`SKILL.md.bak.<UTC-stamp>\` safety backup of the current SKILL.md (if present) is taken before the restore so the rollback itself is reversible.`
      : "No valid `.bak.*` or `.disabled.*` sibling found on disk — rollback will refuse at execute time. No safety backup is taken when nothing will be written.",
    change_note: changeNote,
    current_entry_json: currentEntryJson,
    path_safety: safety.ok
      ? { ok: true as const, realpath: safety.skillsRootRealpath }
      : { ok: false as const, reason: safety.reason },
    extra_notes: [
      "Strict candidate filter: only exact valid timestamp-shaped regular siblings are eligible — filename matches `SKILL.md.bak.<8digit>-<6digit>-<3digit>` or `SKILL.md.disabled.<8digit>-<6digit>-<3digit>`, stamp parses to a real UTC instant (rejects impossible calendar fields + future stamps beyond a 5-minute skew), and the entry is a regular file (not a symlink, not a device, not a directory). `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. NOTE: eligibility does NOT prove runner provenance — a file hand-created at the same exact stamp shape is also eligible; if you need provenance, do not roll back to a sibling you did not produce.",
      ...sharedNotes,
    ],
  };
}

/** Preview-extras helper for the two Skill filesystem doctors
 *  (`skill_doctor_codex`, `skill_doctor_claude_desktop`). Read-
 *  only by design: no `mutates`, no backup plan. Surfaces the
 *  target path + a truthful description of what the check will
 *  examine. Consumed by the action-runner preview; the SAME
 *  checker helper is invoked directly by `computeStatus` for
 *  status-row promotion (see design doc § "Evidence transport").
 */
function buildSkillDoctorPreviewExtras(
  client: "codex" | "claude_desktop",
): PreviewExtras {
  const sharedNotes: string[] = [
    "MCP connection config is NOT touched. This check reads ONLY the Skill file, a repo source file, and the Skill directory listing; `~/.codex/config.toml`, Claude Desktop config, `~/.vo`, the acceptance artifact, and every hosted / remote MCP surface are NOT modified.",
    "Status-row promotion path: the SAME filesystem check runs inside `computeStatus` when `/mcp-controls.json` refreshes. Clicking this button shows the check in the action-result card with an audit-trail token; the status row is already promoted to the same state at page refresh time. Mismatch between the two is transparent evidence of a between-refreshes filesystem change.",
    "Operator-gated `enabled` state is NOT reached by this check alone. The checker promotes the row to `installed` / `disabled` / `outdated` / `not_installed` / `error` / `manual_required` from filesystem evidence alone. Promotion to `enabled` requires the rung-11 Skill acceptance discriminator (`skill_observed=true` + non-empty note) in a fresh same-client artifact cell.",
    "Generic VO Skill support stays permanently `unsupported` — this check has no generic-host equivalent.",
  ];
  if (client === "codex") {
    const safety = validateCodexSkillTargetPath();
    const target: CodexSkillTargetPath = safety.ok
      ? safety.target
      : resolveCodexSkillTargetPath();
    return {
      touched_config_path: target.skillFile,
      mutates: [],
      backup_note:
        "No backup is taken — this is a read-only check. `lstat` + sha256 hash + disabled-sibling scan + repo source compare.",
      change_note:
        "Read-only: lstat the Codex target SKILL.md, sha256 it, scan the directory for eligible `SKILL.md.disabled.<UTC-stamp>` siblings, read + sha256 the repo source at `mcp/skills/verity-one-mcp/SKILL.md`, and classify the state.",
      current_entry_json: null,
      path_safety: safety.ok
        ? { ok: true as const, realpath: safety.skillsRootRealpath }
        : { ok: false as const, reason: safety.reason },
      extra_notes: [
        "Returned state is one of: `not_installed` / `disabled` / `installed` / `outdated` / `error` / `manual_required`. Details field names the specific condition (e.g. hash prefix on match, or refusal reason on error).",
        ...sharedNotes,
      ],
    };
  }
  // claude_desktop
  const safety = validateClaudeDesktopSkillTargetPath();
  const target: ClaudeDesktopSkillTargetPath = safety.ok
    ? safety.target
    : resolveClaudeDesktopSkillTargetPath();
  return {
    touched_config_path: target.skillFile,
    mutates: [],
    backup_note:
      "No backup is taken — this is a read-only check. `lstat` + sha256 hash + disabled-sibling scan + repo source compare.",
    change_note:
      "Read-only: lstat the Claude Desktop target SKILL.md at the VO-provisional darwin pin, sha256 it, scan for eligible disabled siblings, read + sha256 the repo source, and classify the state. Non-darwin platforms return `error` (the VO-provisional contract names only darwin).",
    current_entry_json: null,
    path_safety: safety.ok
      ? { ok: true as const, realpath: safety.skillsRootRealpath }
      : { ok: false as const, reason: safety.reason },
    extra_notes: [
      "Target path pin is VO-PROVISIONAL (darwin only, `~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md`) — NOT Anthropic-authoritative. Non-darwin returns `error` with a platform-scope reason; the status row renders `unsupported`.",
      "Returned state is one of: `not_installed` / `disabled` / `installed` / `outdated` / `error` / `manual_required`.",
      ...sharedNotes,
    ],
  };
}

/** Preview-extras helper for the three Codex MCP descriptors
 *  (`mcp_onboard_codex`, `mcp_onboard_codex_force`,
 *  `mcp_rollback_codex`). Mirrors the shape of
 *  `buildCodexSkillPreviewExtras` but targets the Codex MCP
 *  `config.toml` file — NOT the VO Skill `SKILL.md` file. The two
 *  surfaces are deliberately separate: Codex MCP config writes use
 *  `control_scope: "mcp_connection"`; Codex VO Skill writes use
 *  `control_scope: "vo_skill"`. */
function buildCodexMcpPreviewExtras(
  kind: "install" | "force" | "rollback",
): PreviewExtras {
  const cfg = resolveCodexMcpConfigPath();
  const safety = validateCodexMcpConfigPath(cfg);
  const current = safety.ok
    ? readCurrentCodexVerityOneSection(cfg)
    : {
        present: false,
        section: null,
        note: "current section not read — path-safety check refused",
      };
  const latestBackup = safety.ok ? findLatestCodexMcpBackup(cfg) : null;

  // Proposed next block — surfaced for install + force so the
  // operator sees the EXACT TOML that will land. Resolves the
  // install runtime synchronously.
  //
  // Contract invariant (design §"Preview contract"): for
  // install / force, `proposed_next_value` MUST be populated
  // whenever path_safety succeeds. If the install runtime
  // cannot be resolved (mcp/ not built, no node on PATH,
  // `VO_MCP_NODE` set to a missing path), we cannot compute
  // the proposed block — AND we MUST NOT let the operator
  // confirm a write they have not seen. In that case we
  // OVERRIDE `path_safety` to `{ ok: false, reason: ... }` so
  // the dashboard disables the Confirm button; execute-time
  // Stage 0b runtime-resolve gives a defense-in-depth second
  // refusal if a stale token somehow reaches the execute
  // endpoint.
  //
  // Rollback does not propose new content — it restores
  // pre-existing bytes from a backup — so no
  // `proposed_next_value` is surfaced for that kind, and the
  // runtime-refusal override does NOT apply.
  let proposedNextValue: string | null = null;
  let runtimeRefusal: { reason: string } | null = null;
  if (kind === "install" || kind === "force") {
    const rt = resolveClaudeDesktopInstallRuntime();
    if (rt.ok) {
      proposedNextValue = formatCodexProposedBlockForPreview(rt.runtime);
    } else {
      runtimeRefusal = {
        reason:
          `Install runtime not resolvable (${rt.reason}). `
          + "The proposed `[mcp_servers.verity-one]` block depends "
          + "on the resolved absolute Node path + installed server "
          + "path, so the preview cannot show the exact TOML that "
          + "would be written. Confirm is disabled until the "
          + "runtime resolves — build mcp/ (`bun install --cwd mcp "
          + "&& bun run --cwd mcp build`), ensure `node` is on "
          + "PATH (or set `VO_MCP_NODE` to an absolute node path), "
          + "then re-open the preview.",
      };
    }
  }
  // Staging-root path-safety — the execute path calls
  // `params.install({ client: "codex" })` which runs the
  // installer's `installFilesystem()`, copying
  // `mcp/dist` → `~/.vo/mcp/dist` + writing `~/.vo/mcp/
  // node_modules`, `~/.vo/mcp/bin/vo-mcp`, and `~/.vo/mcp/
  // package.json`. Those paths MUST pass the same staging
  // validator the Claude Desktop install uses (reviewer P2:
  // preview previously claimed `~/.vo is NOT modified`,
  // which was false — `installFilesystem` writes under
  // `~/.vo/mcp/` on every install). Kind === "rollback" does
  // NOT trigger `installFilesystem` so staging is only checked
  // for install + force.
  const stagingSafety: ClaudeDesktopStagingSafetyResult | { ok: true; realpath: string } =
    kind === "install" || kind === "force"
      ? validateClaudeDesktopStagingRoot()
      : { ok: true, realpath: "staging-root-not-checked-on-rollback" };

  // Preview-level path_safety combines THREE refusal surfaces:
  // (1) filesystem path-safety of the Codex config file itself
  //     (symlink / non-regular / missing parent / ancestor
  //     symlink — same checks the runner's
  //     `validateCodexMcpConfigPath` runs at execute time);
  // (2) install-runtime-unavailability (mcp/ not built, no
  //     `node` on PATH);
  // (3) `~/.vo/mcp` staging-root path-safety (the installer
  //     writes to this tree during install + force).
  // ANY refusal disables Confirm. Filesystem refusal on the
  // config is reported first (most actionable). Then staging.
  // Then runtime-unavailability.
  const previewSafety: PathSafetyResult = !safety.ok
    ? safety
    : !stagingSafety.ok
      ? stagingSafety
      : runtimeRefusal
        ? { ok: false as const, reason: runtimeRefusal.reason }
        : safety;

  // The execute path ALSO writes the installer's staging tree
  // (`~/.vo/mcp/dist` etc.) during install + force. `mutates`
  // must name those paths honestly — a preview that said "only
  // the Codex config file is touched" lied about the installer
  // filesystem write (reviewer P2). Rollback does not trigger
  // `installFilesystem`, so it touches ONLY the config file +
  // safety backup.
  const stagingMutates =
    kind === "install" || kind === "force"
      ? [
          path.join(
            claudeDesktopHomeDir(),
            ".vo",
            "mcp",
            "dist",
            "server.js",
          ),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "bin", "vo-mcp"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "package.json"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "node_modules (pruned)"),
        ]
      : [];

  // Shared extra_notes — every Codex MCP preview must carry the
  // scope disclaimers so the operator never mistakes a Codex MCP
  // merge for a Skill install.
  const sharedNotes: string[] = [
    "Only `[mcp_servers.verity-one]` is touched in the Codex config. Unrelated sections, comments, blank lines, and section ordering in the MCP config file are preserved byte-for-byte (merge is validated before AND after via `smol-toml`; merge refuses if either parse fails).",
    "Install + force ALSO refresh the bundled MCP server at `~/.vo/mcp/` — the installer copies `mcp/dist` to `~/.vo/mcp/dist/server.js`, prunes dev deps into `~/.vo/mcp/node_modules`, and writes `~/.vo/mcp/bin/vo-mcp` + `~/.vo/mcp/package.json` (same staging posture as `mcp_onboard_claude_desktop`). The Codex config's `command = <node>` + `args[0] = ~/.vo/mcp/dist/server.js` point at that staging tree, so the merged config depends on it. Rollback does NOT touch `~/.vo/mcp/` (it only restores the Codex config file).",
    "Codex VO Skill is NOT touched — `~/.codex/skills/` is left alone; the Skill has its own allowlisted actions (`skill_install_codex` / `skill_disable_codex` / `skill_rollback_codex`) under a different control scope.",
    "Claude Desktop MCP config is NOT touched.",
    "Generic MCP install is permanently `unsupported` — this action is Codex-specific.",
    "The acceptance artifact at `agent-lab/proof/vo-mcp-client-acceptance/result.json` is NOT written by this action; use `acceptance_record_codex` separately to upsert acceptance evidence.",
    "No hosted / remote / web MCP surface is contacted.",
    "Status re-read after execute runs `artifact_read` only — successful config write alone does NOT promote the row. Restart Codex, run `vo-mcp doctor` + `vo-mcp config-doctor --client codex` in your terminal, then record acceptance via `acceptance_record_codex` to move the row to `enabled`.",
  ];

  if (kind === "install") {
    const mutates = [cfg, `${cfg}.bak.<UTC-stamp>`, ...stagingMutates];
    let changeNote: string;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not describe the current section until the refusal is resolved.";
    } else if (!stagingSafety.ok) {
      changeNote =
        "`~/.vo/mcp` staging path-safety refused (see `path_safety`). The installer would write under this tree during install/force; fix the refusal before retrying.";
    } else if (runtimeRefusal) {
      changeNote =
        "Install runtime not resolvable (see `path_safety`). `proposed_next_value` cannot be computed until the runtime resolves; Confirm is disabled.";
    } else if (!current.present) {
      changeNote =
        "No `[mcp_servers.verity-one]` section exists yet in `~/.codex/config.toml` (or the file itself is absent). This normal install APPENDS the verity-one block shown in `proposed_next_value`; unrelated sections are preserved. The installer ALSO refreshes `~/.vo/mcp/` (see `mutates` + scope-note below).";
    } else {
      changeNote =
        "A `[mcp_servers.verity-one]` section ALREADY EXISTS (see `current_entry_json`). This normal install will REFUSE at merge time — use the force-repair action (`mcp_onboard_codex_force`) if you want to replace it with `proposed_next_value`.";
    }
    return {
      touched_config_path: cfg,
      mutates,
      backup_note:
        "A timestamped `<configPath>.bak.<UTC-stamp>` sibling is written atomically before any merge WHEN the config file already exists. First-time install against a missing config writes NO backup (nothing to preserve) — the preview says so in `change_note`; rollback then refuses because no eligible backup exists (see `mcp_rollback_codex`).",
      current_entry_json: current.section,
      proposed_next_value: proposedNextValue,
      change_note: changeNote,
      path_safety: previewSafety.ok
        ? { ok: true as const, realpath: previewSafety.realpath }
        : { ok: false as const, reason: previewSafety.reason },
      extra_notes: [
        "Rollback: run `mcp_rollback_codex` after this install to restore the latest valid `.bak.<UTC-stamp>` sibling (only eligible when a backup was written; first-time installs have no automatic rollback artifact). Manual fallback: `cp <bak> ~/.codex/config.toml`.",
        ...sharedNotes,
      ],
    };
  }

  if (kind === "force") {
    const mutates = [cfg, `${cfg}.bak.<UTC-stamp>`, ...stagingMutates];
    let changeNote: string;
    if (!safety.ok) {
      changeNote =
        "Path safety refused (see `path_safety`). Preview will not describe the current section until the refusal is resolved.";
    } else if (!stagingSafety.ok) {
      changeNote =
        "`~/.vo/mcp` staging path-safety refused (see `path_safety`). The installer would write under this tree during install/force; fix the refusal before retrying.";
    } else if (runtimeRefusal) {
      changeNote =
        "Install runtime not resolvable (see `path_safety`). `proposed_next_value` cannot be computed until the runtime resolves; Confirm is disabled.";
    } else if (!current.present) {
      changeNote =
        "No `[mcp_servers.verity-one]` section exists yet. Force-repair will REFUSE at merge time (nothing to overwrite) — use the normal install action (`mcp_onboard_codex`) for first-time install.";
    } else {
      changeNote =
        "A `[mcp_servers.verity-one]` section ALREADY EXISTS (see `current_entry_json`). This force-repair will OVERWRITE it WITH the block in `proposed_next_value`. Only that section's source range is replaced; unrelated sections, comments, blank lines, and section ordering are preserved byte-for-byte. The prior section bytes land in the timestamped `.bak.<UTC-stamp>` sibling so you can roll back.";
    }
    return {
      touched_config_path: cfg,
      mutates,
      backup_note:
        "A timestamped backup of the existing `~/.codex/config.toml` is taken before any overwrite. You can restore it via the `mcp_rollback_codex` action. Same posture as `takeClaudeDesktopBackup` — non-null backup_path when the file existed; null on the (refused) first-time-force case.",
      current_entry_json: current.section,
      proposed_next_value: proposedNextValue,
      change_note: changeNote,
      path_safety: previewSafety.ok
        ? { ok: true as const, realpath: previewSafety.realpath }
        : { ok: false as const, reason: previewSafety.reason },
      extra_notes: [
        "This action OVERWRITES an existing `[mcp_servers.verity-one]` section. Run it only if the non-force install refused because the section was already present and you want the current installed bytes to take over.",
        ...sharedNotes,
      ],
    };
  }

  // rollback
  const mutates = latestBackup
    ? [cfg, `${cfg}.bak.<UTC-stamp> (safety copy of current, taken first)`]
    : [cfg];
  let changeNote: string;
  if (!safety.ok) {
    changeNote =
      "Path safety refused (see `path_safety`). Preview will not describe the restore candidates until the refusal is resolved.";
  } else if (!latestBackup) {
    changeNote =
      "No eligible `.bak.<UTC-stamp>` sibling of `~/.codex/config.toml` found on disk — rollback will REFUSE at execute time (no backup ⇒ no rollback; the runner will NOT delete the current config or synthesize an empty-file undo). Run `mcp_onboard_codex` or `mcp_onboard_codex_force` first to produce a backup, or manually reverse a first-time install via `rm ~/.codex/config.toml`.";
  } else {
    changeNote = `The latest eligible backup is \`${latestBackup}\`. Restoring it REPLACES the current `
      + "`~/.codex/config.toml` (see `current_entry_json` for the current verity-one section that will be"
      + " displaced). A safety backup of current state is taken first so the rollback is itself reversible."
      + " Eligibility = exact stamp shape + real UTC instant + regular file; it does NOT prove the sibling"
      + " was written by this runner.";
  }
  return {
    touched_config_path: cfg,
    mutates,
    backup_note: latestBackup
      ? `Latest backup detected: \`${latestBackup}\`. A fresh safety backup of the current config is taken before the restore so the rollback itself is reversible.`
      : "No prior `.bak.*` sibling found on disk — the action will refuse at execute time. Run the install or force-repair action first to produce a backup.",
    current_entry_json: current.section,
    change_note: changeNote,
    path_safety: safety.ok
      ? { ok: true as const, realpath: safety.realpath }
      : { ok: false as const, reason: safety.reason },
    extra_notes: [
      "Strict candidate filter: only exact `.bak.<8digit>-<6digit>-<3digit>` stamp-shaped regular siblings are eligible — stamp parses to a real UTC instant (rejects impossible calendar fields + future stamps beyond a 5-minute skew), and the entry is a regular file (not a symlink, not a device, not a directory). `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. NOTE: eligibility does NOT prove runner provenance — a file hand-created at the same exact stamp shape is also eligible; if you need provenance, do not roll back to a sibling you did not produce.",
      ...sharedNotes,
    ],
  };
}

// ─── Registry (hardcoded; no dynamic registration) ────────────────

export const ACTION_DESCRIPTORS: readonly ActionDescriptor[] = [
  {
    action_id: "mcp_live_doctor",
    category: "read_only",
    client_scope: "*",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "low",
    command_summary:
      "Spawn the installed local MCP stdio server (~/.vo/mcp/dist/server.js) and run the read-only 4-step handshake. No writes. No network.",
    reads: [
      "~/.vo/mcp/dist/server.js",
      "~/.vo/config.json",
    ],
    execute_strategy: "live_doctor_handshake",
    rollback_strategy: "none",
    status_reread: "artifact_read",
  },
  {
    action_id: "mcp_client_doctor_claude_desktop",
    category: "read_only",
    client_scope: "claude-desktop",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "low",
    command_summary:
      "Read-only validation of the Claude Desktop config file. Verifies mcpServers.verity-one exists, paths are absolute + present, VO_URL is set, VO_TOKEN is absent. No writes.",
    reads: [
      "~/Library/Application Support/Claude/claude_desktop_config.json (macOS)",
    ],
    execute_strategy: "client_doctor_claude_desktop",
    rollback_strategy: "none",
    status_reread: "artifact_read",
  },
  {
    action_id: "mcp_client_doctor_codex",
    category: "read_only",
    client_scope: "codex",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "low",
    command_summary:
      "Read-only validation of ~/.codex/config.toml. Verifies the [mcp_servers.verity-one] section is present and well-shaped. No writes.",
    reads: ["~/.codex/config.toml"],
    execute_strategy: "client_doctor_codex",
    rollback_strategy: "none",
    status_reread: "artifact_read",
  },
  // ── Claude Desktop MCP install/repair mutation actions ──
  // VO-MCP-LOCAL-ACTION-RUNNER-CLAUDE-INSTALL-PR-1. This was the
  // first mutation-shipping slice in the runner. Adjacent
  // mutation surfaces now SHIPPED (see descriptors further below
  // in this array):
  //   - Codex MCP TOML merge: `mcp_onboard_codex` /
  //     `mcp_onboard_codex_force` / `mcp_rollback_codex` via
  //     `VO-MCP-CODEX-INSTALL-ACTION-PR-1`.
  //   - Codex VO Skill: `skill_install_codex` /
  //     `skill_disable_codex` / `skill_rollback_codex` via
  //     `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`.
  //   - Acceptance-artifact writes:
  //     `acceptance_record_claude_desktop` /
  //     `acceptance_record_codex` via
  //     `VO-MCP-ACTION-RUNNER-ACCEPTANCE-RECORDER-PR-1`.
  // Adjacent Skill surface now SHIPPED too:
  //   - Claude Desktop VO Skill: `skill_install_claude_desktop` /
  //     `skill_disable_claude_desktop` /
  //     `skill_rollback_claude_desktop` via
  //     `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` (VO-provisional
  //     darwin target pin; NOT Anthropic-authoritative).
  // Still deferred / unsupported: generic host config writes
  // (permanently unsupported), generic Skill support (permanently
  // unsupported), hosted / remote MCP transport (out of scope).
  {
    action_id: "mcp_onboard_claude_desktop",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Merge `mcpServers.verity-one` into the local Claude Desktop config. Takes a timestamped backup of the existing config before writing (or skips the backup if the config does not yet exist). Refuses if `mcpServers.verity-one` already exists — use the repair action to overwrite.",
    reads: [],
    mutates: [
      "<Claude Desktop config>",
      "<Claude Desktop config>.bak.<timestamp>",
      "~/.vo/mcp/ (installer staging for the bundled MCP server)",
    ],
    execute_strategy: "onboard_claude_desktop",
    rollback_strategy: "rollback_claude_desktop",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => {
      const cfg = resolveClaudeDesktopConfigPath();
      const configSafety = validateClaudeDesktopConfigPath(cfg);
      const stagingSafety = validateClaudeDesktopStagingRoot();
      // Combined path-safety: refused if EITHER the config path
      // OR the ~/.vo/mcp staging tree fails. The config side
      // catches symlinked config / parent / ancestor that would
      // divert the dashboard's own writes; the staging side
      // catches symlinked ~/.vo or ~/.vo/mcp that would divert
      // the installer's bundled-server writes (reviewer P2).
      const safety = configSafety.ok
        ? stagingSafety
        : configSafety;
      // Gate the disk read on path safety. For a symlinked config
      // path (or any other refusal shape), readFileSync would
      // follow the symlink and disclose bytes from the unexpected
      // target — we refuse the read entirely and tell the
      // operator the current entry is not available until the
      // path-safety refusal is resolved.
      const current = configSafety.ok
        ? readCurrentClaudeDesktopEntry(cfg)
        : { present: false, entry: null, note: "current entry not read — path-safety check refused" };
      const changeNote = current.present
        ? "A `mcpServers.verity-one` entry already exists (see `current_entry_json`). This normal install will REFUSE rather than overwrite — use the force-repair action if you want to replace it."
        : "No `mcpServers.verity-one` entry exists yet. This action will CREATE a new entry merged into the existing config (or create the config file if it is absent).";
      return {
        touched_config_path: cfg,
        mutates: [
          cfg,
          `${cfg}.bak.<UTC-stamp>`,
          // Installer staging tree — same four child paths the
          // `validateClaudeDesktopStagingRoot` validator protects
          // (reviewer P3: preview was under-disclosing the other
          // staging writes; now names each path-safety-validated
          // child so the operator sees the full write set).
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "dist", "server.js"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "bin", "vo-mcp"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "package.json"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "node_modules (pruned)"),
        ],
        backup_note:
          "A timestamped backup of the current Claude Desktop config is written atomically before any merge. If no config file exists yet, the first-time install skips the backup (nothing to preserve).",
        current_entry_json: configSafety.ok && current.present
          ? redactOutput(JSON.stringify(current.entry, null, 2))
          : null,
        change_note: changeNote,
        path_safety: safety.ok
          ? {
              ok: true as const,
              realpath:
                "realpath" in safety
                  ? (safety.realpath as string)
                  : configSafety.ok ? configSafety.realpath : null,
            }
          : { ok: false as const, reason: safety.reason },
        extra_notes: [
          buildStepPreviewNote(),
          "Only Claude Desktop is touched. The action does NOT write ~/.codex/config.toml.",
          "The action does NOT install the VO Skill or copy any Skill file into a client Skills directory.",
          "The action does NOT record acceptance — you must run a Claude Desktop tool manually after restart, then run the acceptance recorder to update the dashboard artifact.",
          "The action does NOT call any hosted /my / remote / web MCP surface.",
        ],
      };
    },
  },
  {
    action_id: "mcp_onboard_claude_desktop_force",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "high",
    command_summary:
      "REPAIR: overwrites any existing `mcpServers.verity-one` entry in the local Claude Desktop config. Takes a timestamped backup before writing so the prior entry is recoverable. Use this to repair a broken entry or refresh after rebuilding mcp/.",
    reads: [],
    mutates: [
      "<Claude Desktop config>",
      "<Claude Desktop config>.bak.<timestamp>",
      "~/.vo/mcp/ (installer staging for the bundled MCP server)",
    ],
    execute_strategy: "onboard_claude_desktop_force",
    rollback_strategy: "rollback_claude_desktop",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => {
      const cfg = resolveClaudeDesktopConfigPath();
      const configSafety = validateClaudeDesktopConfigPath(cfg);
      const stagingSafety = validateClaudeDesktopStagingRoot();
      const safety = configSafety.ok ? stagingSafety : configSafety;
      const current = configSafety.ok
        ? readCurrentClaudeDesktopEntry(cfg)
        : { present: false, entry: null, note: "current entry not read — path-safety check refused" };
      const changeNote = current.present
        ? "A `mcpServers.verity-one` entry ALREADY EXISTS (see `current_entry_json`). This force-repair action will OVERWRITE it. The prior bytes land in a timestamped `.bak.<UTC-stamp>` sibling so you can roll back."
        : "No `mcpServers.verity-one` entry exists yet. This force-repair will behave the same as a normal install — create a new entry — since there is nothing to overwrite.";
      return {
        touched_config_path: cfg,
        mutates: [
          cfg,
          `${cfg}.bak.<UTC-stamp>`,
          // Installer staging tree — same four child paths the
          // `validateClaudeDesktopStagingRoot` validator protects.
          // Force-repair re-runs the filesystem install just like
          // normal install, so the preview must list the full
          // staging write set (reviewer P3 parity with Codex MCP).
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "dist", "server.js"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "bin", "vo-mcp"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "package.json"),
          path.join(claudeDesktopHomeDir(), ".vo", "mcp", "node_modules (pruned)"),
        ],
        backup_note:
          "A timestamped backup of the existing Claude Desktop config is taken before any overwrite. You can restore it via the `mcp_rollback_claude_desktop` action.",
        current_entry_json: configSafety.ok && current.present
          ? redactOutput(JSON.stringify(current.entry, null, 2))
          : null,
        change_note: changeNote,
        path_safety: safety.ok
          ? {
              ok: true as const,
              realpath:
                "realpath" in safety
                  ? (safety.realpath as string)
                  : configSafety.ok ? configSafety.realpath : null,
            }
          : { ok: false as const, reason: safety.reason },
        extra_notes: [
          buildStepPreviewNote(),
          "This action OVERWRITES an existing `mcpServers.verity-one` entry. Run it only if the non-force install refused because the entry was already present and you want the current installed bytes to take over.",
          "Only Claude Desktop is touched. ~/.codex/config.toml, generic hosts, VO Skill directories, acceptance artifacts, and hosted surfaces are NOT touched.",
        ],
      };
    },
  },
  {
    action_id: "mcp_rollback_claude_desktop",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "ROLLBACK: restores the most recent timestamped backup of the local Claude Desktop config. A safety copy of the current config is taken first so the rollback itself is reversible. Refuses if no backup exists.",
    reads: [],
    mutates: [
      "<Claude Desktop config>",
      "<Claude Desktop config>.bak.<timestamp>",
    ],
    execute_strategy: "rollback_claude_desktop",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => {
      const cfg = resolveClaudeDesktopConfigPath();
      const safety = validateClaudeDesktopConfigPath(cfg);
      const latest = safety.ok ? findLatestClaudeDesktopBackup(cfg) : null;
      const current = safety.ok
        ? readCurrentClaudeDesktopEntry(cfg)
        : { present: false, entry: null, note: "current entry not read — path-safety check refused" };
      const changeNote = latest
        ? `The latest eligible backup is ${latest}. Restoring it REPLACES the current Claude Desktop config (see \`current_entry_json\` for what will be displaced). A safety backup of current state is taken first so the rollback is itself reversible. Eligibility = exact stamp shape + real UTC instant + regular file; it does NOT prove the sibling was written by this runner.`
        : "No prior `.bak.<UTC-stamp>` sibling exists — rollback will refuse at execute time.";
      return {
        touched_config_path: cfg,
        mutates: latest
          ? [cfg, `${cfg}.bak.<UTC-stamp> (safety copy of current, taken first)`]
          : [cfg],
        backup_note: latest
          ? `Latest backup detected: ${latest}. A fresh safety backup of the current config is taken before the restore so the rollback itself is reversible.`
          : "No prior `.bak.*` sibling found on disk — the action will refuse at execute time. Run the install or repair action first.",
        current_entry_json: safety.ok && current.present
          ? redactOutput(JSON.stringify(current.entry, null, 2))
          : null,
        change_note: changeNote,
        path_safety: safety.ok
          ? { ok: true as const, realpath: safety.realpath }
          : { ok: false as const, reason: safety.reason },
        extra_notes: [
          "Only the Claude Desktop config file is touched. ~/.codex, generic hosts, VO Skill, acceptance artifacts, and hosted surfaces are NOT touched.",
        ],
      };
    },
  },
  // ── Acceptance recorder actions (artifact_write) ──
  // VO-MCP-ACTION-RUNNER-ACCEPTANCE-RECORDER-PR-1. The
  // operator has already restarted the client and observed
  // one real MCP tool/resource call manually; these actions
  // upsert that attestation into the gitignored acceptance
  // artifact. No Skill install, no Codex TOML write, no
  // hosted proof execution.
  {
    action_id: "acceptance_record_claude_desktop",
    category: "artifact_write",
    client_scope: "claude-desktop",
    control_scope: "mcp_connection",
    args_schema: {
      status: "string",
      observed_tool_or_resource: "string",
      operator_summary: "string",
      observed_result_summary: "string",
      config_doctor_ran: "boolean",
      live_doctor_ran: "boolean",
      // Rung 11 — Skill-lifecycle discriminator (optional).
      // When skill_observed=true + rung-10 checker says
      // `installed`, the `vo_skill / claude-desktop` row
      // reaches `enabled`. Ordinary MCP-connection acceptance
      // (without these fields) does NOT promote `vo_skill`.
      skill_observed: "boolean_optional",
      skill_observed_note: "string_optional",
    },
    risk_level: "medium",
    command_summary:
      "Record what you just observed in Claude Desktop into the gitignored acceptance artifact at `agent-lab/proof/vo-mcp-client-acceptance/result.json` (+ `result.md`). Upserts at most one cell per client. Refuses pass unless BOTH `config_doctor_ran` and `live_doctor_ran` are true. The artifact is what the dashboard's MCP status row reads; a fresh same-client pass with both doctor flags can promote the MCP row to `enabled`. Optional `skill_observed` + `skill_observed_note` fields (rung 11) attest that the operator observed the Skill loaded in the client session; paired with a rung-10 `skill_doctor_claude_desktop` result of `installed`, they promote the `vo_skill` row to `enabled`.",
    reads: [],
    mutates: [
      "<repo>/agent-lab/proof/vo-mcp-client-acceptance/result.json",
      "<repo>/agent-lab/proof/vo-mcp-client-acceptance/result.md",
    ],
    execute_strategy: "acceptance_record_claude_desktop",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => {
      return buildAcceptancePreviewExtras("claude-desktop");
    },
  },
  {
    action_id: "acceptance_record_codex",
    category: "artifact_write",
    client_scope: "codex",
    control_scope: "mcp_connection",
    args_schema: {
      status: "string",
      observed_tool_or_resource: "string",
      operator_summary: "string",
      observed_result_summary: "string",
      config_doctor_ran: "boolean",
      live_doctor_ran: "boolean",
      // Rung 11 — Skill-lifecycle discriminator (optional).
      // See acceptance_record_claude_desktop for semantics.
      skill_observed: "boolean_optional",
      skill_observed_note: "string_optional",
    },
    risk_level: "medium",
    command_summary:
      "Record what you just observed in Codex into the gitignored acceptance artifact at `agent-lab/proof/vo-mcp-client-acceptance/result.json` (+ `result.md`). Upserts at most one cell per client. Refuses pass unless BOTH `config_doctor_ran` and `live_doctor_ran` are true. This action does NOT write `~/.codex/config.toml`. Optional `skill_observed` + `skill_observed_note` fields (rung 11) attest that the operator observed the Codex Skill loaded; paired with a rung-10 `skill_doctor_codex` result of `installed`, they promote the `vo_skill` row to `enabled`.",
    reads: [],
    mutates: [
      "<repo>/agent-lab/proof/vo-mcp-client-acceptance/result.json",
      "<repo>/agent-lab/proof/vo-mcp-client-acceptance/result.md",
    ],
    execute_strategy: "acceptance_record_codex",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => {
      return buildAcceptancePreviewExtras("codex");
    },
  },
  // ── Codex VO Skill install / disable / rollback ─────────────────
  // VO-MCP-SKILL-INSTALL-ACTIONS-PR-1. Reuses the merged Codex
  // target-path contract (VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1)
  // from `api/src/lib/mcp-skill-target-path.ts` — resolver +
  // `validateCodexSkillTargetPath` (symlink + ancestor-walk
  // fence) + `CODEX_SKILL_SOURCE_REL_PATH`. No resolver logic is
  // duplicated here. `control_scope: "vo_skill"` means these
  // three serialize on the shared `(tenant, vo_skill)` mutation
  // lock alongside the Claude Desktop Skill actions below, but do
  // NOT block Claude Desktop or Codex `mcp_connection` mutations.
  // Generic stays permanently `unsupported`.
  {
    action_id: "skill_install_codex",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Copy the repo-local VO Skill (`mcp/skills/verity-one-mcp/SKILL.md`) to the resolved Codex target under `<codexHome>/skills/verity-one-mcp/SKILL.md`. Takes a timestamped backup of the existing file before any overwrite. Refuses on symlink / ancestor-symlink / missing-`skillsRoot` / non-directory parent / non-regular-file target. Status re-read runs `skill_doctor_codex`; `enabled` remains Skill-attestation-gated.",
    reads: ["mcp/skills/verity-one-mcp/SKILL.md (repo source)"],
    mutates: [
      "<Codex skillFile>",
      "<Codex skillFile>.bak.<UTC-stamp>",
    ],
    execute_strategy: "skill_install_codex",
    rollback_strategy: "skill_rollback_codex",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexSkillPreviewExtras("install"),
  },
  {
    action_id: "skill_disable_codex",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Disable the installed Codex VO Skill by RENAMING `SKILL.md` to `SKILL.md.disabled.<UTC-stamp>` in the same directory. Never deletes. Never touches unrelated Skills. Reversible via `skill_rollback_codex`. Refuses if no SKILL.md exists at the target.",
    reads: [],
    mutates: [
      "<Codex skillFile>",
      "<Codex skillFile>.disabled.<UTC-stamp>",
    ],
    execute_strategy: "skill_disable_codex",
    rollback_strategy: "skill_rollback_codex",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexSkillPreviewExtras("disable"),
  },
  {
    action_id: "skill_rollback_codex",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Restore the latest eligible `SKILL.md.bak.<UTC-stamp>` or `SKILL.md.disabled.<UTC-stamp>` sibling at the Codex Skill target. Eligibility = anchored stamp regex + real UTC stamp (rejects impossible calendar fields + future stamps) + regular file (not a symlink / device / directory). `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. Eligibility does NOT prove runner provenance — a file hand-created at the same exact stamp shape is also eligible. Takes a safety backup of the CURRENT `SKILL.md` first so the rollback itself is reversible. Refuses if no eligible candidate exists.",
    reads: [],
    mutates: [
      "<Codex skillFile>",
      "<Codex skillFile>.bak.<UTC-stamp> (safety copy of current, if present)",
    ],
    execute_strategy: "skill_rollback_codex",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexSkillPreviewExtras("rollback"),
  },
  // ── Claude Desktop VO Skill install / disable / rollback ────────
  // VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1. Consumes the
  // VO-provisional target-path contract shipped in
  // VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1 from
  // `api/src/lib/mcp-claude-desktop-skill-target-path.ts` —
  // resolver + `validateClaudeDesktopSkillTargetPath` (symlink +
  // ancestor-walk fence) + `CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH`.
  // The path pin is a VO-provisional darwin default
  // (`~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md`);
  // NOT an Anthropic-authoritative location. Actions mirror the
  // shipped Codex Skill action posture byte-for-byte: same TOCTOU
  // discipline, same stamp shape, same preview-extras structure,
  // same status-read strategy. `control_scope: "vo_skill"` — these
  // serialize on the shared `(tenant, vo_skill)` mutation lock
  // alongside the three Codex Skill actions above. They do NOT
  // block Claude Desktop or Codex `mcp_connection` mutations.
  // Status re-read runs the rung-10 Skill checker. `enabled`
  // requires the rung-11 Skill acceptance discriminator
  // (`skill_observed=true` + non-empty note); filesystem writes
  // or checks alone never enable the row.
  {
    action_id: "skill_install_claude_desktop",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Copy the repo-local VO Skill (`mcp/skills/verity-one-mcp/SKILL.md`) to the VO-provisional Claude Desktop target under `~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md` (darwin-only). Takes a timestamped backup of the existing file before any overwrite. Refuses on symlink / ancestor-symlink / missing parent / non-directory parent / non-regular-file target. Non-darwin and non-Anthropic-authoritative — the path is a VO-provisional pin. Status re-read runs `skill_doctor_claude_desktop`; `enabled` remains Skill-attestation-gated.",
    reads: ["mcp/skills/verity-one-mcp/SKILL.md (repo source)"],
    mutates: [
      "<Claude Desktop skillFile>",
      "<Claude Desktop skillFile>.bak.<UTC-stamp>",
    ],
    execute_strategy: "skill_install_claude_desktop",
    rollback_strategy: "skill_rollback_claude_desktop",
    status_reread: "artifact_read",
    resolvePreviewExtras: () =>
      buildClaudeDesktopSkillPreviewExtras("install"),
  },
  {
    action_id: "skill_disable_claude_desktop",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Disable the installed Claude Desktop VO Skill by RENAMING `SKILL.md` to `SKILL.md.disabled.<UTC-stamp>` in the same directory. Never deletes. Never touches unrelated Skills. Reversible via `skill_rollback_claude_desktop`. Refuses if no SKILL.md exists at the target.",
    reads: [],
    mutates: [
      "<Claude Desktop skillFile>",
      "<Claude Desktop skillFile>.disabled.<UTC-stamp>",
    ],
    execute_strategy: "skill_disable_claude_desktop",
    rollback_strategy: "skill_rollback_claude_desktop",
    status_reread: "artifact_read",
    resolvePreviewExtras: () =>
      buildClaudeDesktopSkillPreviewExtras("disable"),
  },
  {
    action_id: "skill_rollback_claude_desktop",
    category: "file_mutation",
    client_scope: "claude-desktop",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Restore the latest eligible `SKILL.md.bak.<UTC-stamp>` or `SKILL.md.disabled.<UTC-stamp>` sibling at the Claude Desktop Skill target. Eligibility = anchored stamp regex + real UTC stamp (rejects impossible calendar fields + future stamps) + regular file (not a symlink / device / directory). `.tmp`, prefix-only / malformed stamps, and symlinks are rejected. Eligibility does NOT prove runner provenance — a file hand-created at the same exact stamp shape is also eligible. Takes a safety backup of the CURRENT `SKILL.md` first so the rollback itself is reversible. Refuses if no eligible candidate exists.",
    reads: [],
    mutates: [
      "<Claude Desktop skillFile>",
      "<Claude Desktop skillFile>.bak.<UTC-stamp> (safety copy of current, if present)",
    ],
    execute_strategy: "skill_rollback_claude_desktop",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () =>
      buildClaudeDesktopSkillPreviewExtras("rollback"),
  },
  // ── Skill filesystem doctors (read-only) ────────────────────────
  // VO-MCP-SKILL-CHECKER-IMPL-PR-1 (rung 10). Two read-only
  // descriptors that consume the shared library helper at
  // `api/src/lib/mcp-skill-checker.ts::runSkillDoctor<Client>`.
  // The SAME helper is invoked by `computeStatus` during status-
  // row computation so `/mcp-controls.json` promotes `vo_skill`
  // rows from `manual_required` to concrete states (`installed` /
  // `disabled` / `outdated` / `not_installed` / `error` /
  // `manual_required`). These descriptors exist for the operator-
  // visible "run check now" button's audit trail; they are NOT
  // the path by which rows get promoted (that path is the direct
  // helper call from computeStatus). See
  // `docs/VO-MCP-SKILL-CHECKER-DESIGN.md` § "Evidence transport".
  // `enabled` stays operator-gated via the Skill-specific
  // acceptance discriminator shipped in rung 11
  // (MCP-SKILL-LIFECYCLE-INTEROP-PROOF-PR-1, Skill-acceptance
  // half).
  {
    action_id: "skill_doctor_codex",
    category: "read_only",
    client_scope: "codex",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "low",
    command_summary:
      "Read the Codex Skill filesystem state: lstat + sha256 of `<codexHome>/skills/verity-one-mcp/SKILL.md`, scan for eligible `SKILL.md.disabled.<UTC-stamp>` siblings, and compare against the pinned repo source. Returns one of `not_installed` / `disabled` / `installed` / `outdated` / `error` / `manual_required`. No writes. Promotes the `vo_skill / codex` status row from `manual_required` to a concrete state (except `enabled`, which stays operator-attested).",
    reads: [
      "<Codex skillFile>",
      "<repo>/mcp/skills/verity-one-mcp/SKILL.md",
      "<Codex skillDir> (for .disabled.<stamp> sibling scan)",
    ],
    mutates: [],
    execute_strategy: "skill_doctor_codex",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildSkillDoctorPreviewExtras("codex"),
  },
  {
    action_id: "skill_doctor_claude_desktop",
    category: "read_only",
    client_scope: "claude-desktop",
    control_scope: "vo_skill",
    args_schema: {},
    risk_level: "low",
    command_summary:
      "Read the Claude Desktop Skill filesystem state at the VO-provisional darwin path `~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md`: lstat + sha256 + disabled-sibling scan + repo-source compare. Returns one of `not_installed` / `disabled` / `installed` / `outdated` / `error` / `manual_required`. Non-darwin returns `error` (unsupported platform for the VO-provisional pin). No writes. Promotes the `vo_skill / claude-desktop` status row from `manual_required` to a concrete state (except `enabled`, which stays operator-attested).",
    reads: [
      "<Claude Desktop skillFile>",
      "<repo>/mcp/skills/verity-one-mcp/SKILL.md",
      "<Claude Desktop skillDir> (for .disabled.<stamp> sibling scan)",
    ],
    mutates: [],
    execute_strategy: "skill_doctor_claude_desktop",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () =>
      buildSkillDoctorPreviewExtras("claude_desktop"),
  },
  // ── Codex MCP config install / force / rollback ─────────────────
  // VO-MCP-CODEX-INSTALL-ACTION-PR-1. Implements the contract
  // pinned in `docs/VO-MCP-CODEX-TOML-MERGE-DESIGN.md`. Targets
  // the Codex MCP `config.toml` file (NOT the VO Skill file) and
  // serializes on the shared `(tenant, mcp_connection)` mutation
  // lock alongside Claude Desktop MCP install / force / rollback
  // and the two acceptance recorders. Deliberately DISTINCT from
  // the shipped `skill_*_codex` actions — different file, different
  // lock, different control scope.
  //
  // `status_reread: "artifact_read"` — identical to every
  // descriptor the runner ships today. A successful config write
  // alone does NOT promote the Codex MCP row; promotion to
  // `enabled` still requires `acceptance_record_codex` with both
  // doctor flags true.
  {
    action_id: "mcp_onboard_codex",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "Merge `[mcp_servers.verity-one]` into the local Codex MCP config at `~/.codex/config.toml` AND refresh the bundled MCP server at `~/.vo/mcp/` (same installer staging tree as `mcp_onboard_claude_desktop`). Preserves unrelated Codex-config sections / comments / blank lines / ordering byte-for-byte. Validates the file parses as TOML before AND after the merge via `smol-toml`. Takes a timestamped backup of the Codex config only when it already exists (first-time install writes no backup; rollback then refuses because no eligible backup exists). Refuses if `[mcp_servers.verity-one]` already exists — use the repair action to overwrite.",
    reads: [],
    mutates: [
      "<Codex MCP config>",
      "<Codex MCP config>.bak.<UTC-stamp> (only when pre-existing config)",
      "~/.vo/mcp/ (installer staging for the bundled MCP server — `dist/server.js`, `node_modules`, `bin/vo-mcp`, `package.json`)",
    ],
    execute_strategy: "onboard_codex",
    rollback_strategy: "rollback_codex",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexMcpPreviewExtras("install"),
  },
  {
    action_id: "mcp_onboard_codex_force",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "high",
    command_summary:
      "REPAIR: overwrites an existing `[mcp_servers.verity-one]` section in `~/.codex/config.toml` AND refreshes the bundled MCP server at `~/.vo/mcp/` (same staging tree as `mcp_onboard_claude_desktop`). Replaces ONLY the verity-one section's source range in the Codex config — unrelated sections, comments, blank lines, and section ordering are preserved byte-for-byte. Takes a timestamped backup before writing so the prior section is recoverable. Use this to repair a broken entry or refresh after rebuilding mcp/.",
    reads: [],
    mutates: [
      "<Codex MCP config>",
      "<Codex MCP config>.bak.<UTC-stamp>",
      "~/.vo/mcp/ (installer staging for the bundled MCP server)",
    ],
    execute_strategy: "onboard_codex_force",
    rollback_strategy: "rollback_codex",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexMcpPreviewExtras("force"),
  },
  {
    action_id: "mcp_rollback_codex",
    category: "file_mutation",
    client_scope: "codex",
    control_scope: "mcp_connection",
    args_schema: {},
    risk_level: "medium",
    command_summary:
      "ROLLBACK: restores the most recent timestamped backup of `~/.codex/config.toml`. A safety copy of the current config is taken first so the rollback itself is reversible. Refuses if no eligible backup exists — NO backup ⇒ NO rollback; the runner does NOT delete the current config or synthesize an empty-file undo.",
    reads: [],
    mutates: [
      "<Codex MCP config>",
      "<Codex MCP config>.bak.<UTC-stamp>",
    ],
    execute_strategy: "rollback_codex",
    rollback_strategy: "none",
    status_reread: "artifact_read",
    resolvePreviewExtras: () => buildCodexMcpPreviewExtras("rollback"),
  },
] as const;

export function findDescriptor(action_id: string): ActionDescriptor | null {
  return ACTION_DESCRIPTORS.find((d) => d.action_id === action_id) ?? null;
}

// ─── Typed-args + request-body validation ─────────────────────────

/** Keys the browser MUST NEVER send. Design doc forbids them
 *  because they would turn the action runner into a shell relay. */
export const FORBIDDEN_TOP_LEVEL_FIELDS: readonly string[] = [
  "command",
  "argv",
  "cwd",
  "env",
];

export type RequestValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; status: 400; error: string };

/** Validate a preview or execute request body. Both shapes accept
 *  `{action_id, args}`; execute additionally carries
 *  `confirmation_token`. The extra field is tolerated here — the
 *  execute path validates it separately. */
export function validateActionRequest(
  body: unknown,
  descriptor: ActionDescriptor,
): RequestValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "request body must be an object" };
  }
  const obj = body as Record<string, unknown>;
  // Forbidden fields at the top level — shell-relay posture.
  for (const forbidden of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (forbidden in obj) {
      return {
        ok: false,
        status: 400,
        error: `request body must not include "${forbidden}"; the browser never supplies shell arguments`,
      };
    }
  }
  const args = obj.args;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { ok: false, status: 400, error: "args must be an object" };
  }
  const argsObj = (args as Record<string, unknown>) || {};
  // Unknown arg field — fail closed.
  for (const key of Object.keys(argsObj)) {
    if (!(key in descriptor.args_schema)) {
      return {
        ok: false,
        status: 400,
        error: `unknown arg "${key}" for action ${descriptor.action_id}; schema keys: ${Object.keys(descriptor.args_schema).join(", ") || "(none)"}`,
      };
    }
  }
  // Typed-check schema keys. Fields tagged `*_optional` are
  // allowed to be absent OR pass the type check. Required fields
  // must be present and well-typed.
  for (const [key, fieldType] of Object.entries(descriptor.args_schema)) {
    const isOptional =
      fieldType === "string_optional" || fieldType === "boolean_optional";
    const present = key in argsObj;
    if (!present) {
      if (isOptional) continue;
      return {
        ok: false,
        status: 400,
        error: `missing required arg "${key}" for action ${descriptor.action_id}`,
      };
    }
    const v = argsObj[key];
    if (
      (fieldType === "string" || fieldType === "string_optional") &&
      typeof v !== "string"
    ) {
      return { ok: false, status: 400, error: `arg "${key}" must be a string` };
    }
    if (
      (fieldType === "boolean" || fieldType === "boolean_optional") &&
      typeof v !== "boolean"
    ) {
      return { ok: false, status: 400, error: `arg "${key}" must be a boolean` };
    }
    // enum is validated by the strategy specifics today; none of the
    // three read-only actions ships enum args.
  }
  return { ok: true, args: argsObj };
}

// ─── Redactor ────────────────────────────────────────────────────

/** Upper bound on redacted output we persist (per stream). Anything
 *  past this gets truncated with a `[…truncated]` marker. Raw
 *  output is never written to disk; only the redacted projection
 *  ever leaves this module. */
export const OUTPUT_LENGTH_CAP = 4096;

/** Redacts every SECRET_PATTERNS match with a label, collapses
 *  $HOME to `~`, and caps length. Callers feed it anything they
 *  might log or ship to the browser. */
export function redactOutput(input: string): string {
  let out = String(input ?? "");
  // $HOME → ~ before pattern redaction so patterns don't key off
  // the expanded path.
  const home = os.homedir();
  if (home && home.length > 1) {
    // Escape for regex literal.
    const homeRe = new RegExp(
      home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "g",
    );
    out = out.replace(homeRe, "~");
  }
  // Secret patterns.
  for (const { name, pattern } of SECRET_PATTERNS) {
    // Build a non-global clone so we can replace iteratively
    // without a global-regex cursor.
    const src = pattern.source;
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : pattern.flags + "g";
    const g = new RegExp(src, flags);
    out = out.replace(g, () => `[REDACTED:${name}]`);
  }
  if (out.length > OUTPUT_LENGTH_CAP) {
    out = out.slice(0, OUTPUT_LENGTH_CAP) + "\n[…truncated]";
  }
  return out;
}

// ─── Confirmation token store ────────────────────────────────────

/** Token TTL in ms. Short-lived — previews are expected to be
 *  confirmed within a minute or two of clicking. A stale token
 *  forces a fresh preview so the operator sees current scope. */
export const TOKEN_TTL_MS = 2 * 60 * 1000;

interface TokenRecord {
  token: string;
  action_id: string;
  args_hash: string;
  tenant_id: string;
  expires_at: number;
  /** True when the preview that minted this token was safe to
   *  confirm — i.e. `extras.path_safety` was absent or ok. False
   *  when the preview refused (symlinked config, unresolvable
   *  install runtime, etc.). Execute checks this and refuses
   *  when false — a caller who saw a refused preview MUST NOT
   *  be able to reuse the token after fixing the refusal state
   *  out-of-band; the operator must request a fresh preview so
   *  they see the newly-computed `proposed_next_value` before
   *  confirming. Defense-in-depth complement to the UI's
   *  Confirm-disable on path_safety.ok=false (reviewer P2:
   *  "don't let a token minted from a refused preview execute"). */
  preview_confirmable: boolean;
}

/** In-memory per-process store. This PR's runner is a single-
 *  process local service; clustering is out of scope. A restart
 *  invalidates all outstanding tokens, which is the correct
 *  safety default. */
const TOKEN_STORE = new Map<string, TokenRecord>();

export function hashArgs(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortRecord(args));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortRecord(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortRecord);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    sorted[k] = sortRecord((v as Record<string, unknown>)[k]);
  }
  return sorted;
}

export function mintConfirmationToken(params: {
  action_id: string;
  args_hash: string;
  tenant_id: string;
  now?: number;
  /** True when the minting preview's path_safety was absent or
   *  ok. False when the preview refused (symlinked config /
   *  unresolvable install runtime / any other path_safety.ok
   *  === false state). Execute consumes the token and refuses
   *  when false. Default true (backward-compatible for callers
   *  that don't set it — read-only doctor tokens + recorder
   *  tokens never set path_safety so they stay confirmable). */
  preview_confirmable?: boolean;
}): string {
  const token = randomUUID();
  const now = params.now ?? Date.now();
  TOKEN_STORE.set(token, {
    token,
    action_id: params.action_id,
    args_hash: params.args_hash,
    tenant_id: params.tenant_id,
    expires_at: now + TOKEN_TTL_MS,
    preview_confirmable: params.preview_confirmable ?? true,
  });
  return token;
}

export type TokenConsumption =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 409; error: string };

export function consumeConfirmationToken(params: {
  token: string;
  action_id: string;
  args_hash: string;
  tenant_id: string;
  now?: number;
}): TokenConsumption {
  const rec = TOKEN_STORE.get(params.token);
  if (!rec) {
    return { ok: false, status: 403, error: "confirmation_token not recognized (never minted, already consumed, or expired)" };
  }
  // Single-use: delete immediately so a racing double-submit can't
  // replay.
  TOKEN_STORE.delete(params.token);
  const now = params.now ?? Date.now();
  if (now >= rec.expires_at) {
    return { ok: false, status: 403, error: "confirmation_token expired — request a fresh preview" };
  }
  // Timing-safe compare of the three binding fields.
  if (!safeEq(rec.action_id, params.action_id)) {
    return { ok: false, status: 403, error: "confirmation_token was minted for a different action_id" };
  }
  if (!safeEq(rec.args_hash, params.args_hash)) {
    return { ok: false, status: 403, error: "confirmation_token was minted for different args" };
  }
  if (!safeEq(rec.tenant_id, params.tenant_id)) {
    return { ok: false, status: 403, error: "confirmation_token was minted for a different tenant context" };
  }
  // Defense-in-depth against "preview refused → caller fixes the
  // refusal state out-of-band → replays the token": refuse
  // tokens minted from a refused preview. Forces the operator to
  // re-preview so they see the newly-computable
  // `proposed_next_value` / `current_entry_json` / `path_safety`
  // state before confirming. Complements the UI's Confirm-
  // disable on `path_safety.ok=false`.
  if (!rec.preview_confirmable) {
    return {
      ok: false,
      status: 403,
      error:
        "confirmation_token was minted from a refused preview "
        + "(path_safety.ok was false — e.g. symlinked config, "
        + "unresolvable install runtime). Request a fresh "
        + "preview so the newly-computed proposed_next_value / "
        + "path_safety state is visible before confirming.",
    };
  }
  return { ok: true };
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  } catch {
    return false;
  }
}

/** Test-only helpers — exported so the suite can exercise
 *  expiry and clear state between cases. Not part of the wire
 *  protocol. */
export function __testOnly_clearTokenStore(): void {
  TOKEN_STORE.clear();
}
export function __testOnly_expireToken(token: string): void {
  const rec = TOKEN_STORE.get(token);
  if (rec) {
    TOKEN_STORE.set(token, { ...rec, expires_at: Date.now() - 1 });
  }
}

// ─── Concurrency guard (read-only per action; mutations per control) ─

const INFLIGHT = new Set<string>();

/** Compute the lock key for an action. Mutation categories
 *  (file_mutation + artifact_write) lock on `(tenant, control)`
 *  so EVERY mutation under the same control serializes:
 *
 *    - install / force / rollback on claude-desktop (file_mutation)
 *    - recorder for claude-desktop (artifact_write)
 *    - recorder for codex (artifact_write)
 *
 *  The two recorder descriptors upsert the SAME gitignored
 *  `result.json`. An earlier client-scoped key let them run
 *  concurrently — two overlapping upserts could each read the
 *  old artifact and last-writer-wins would drop the other
 *  client's cell. Widening to the control level fixes that
 *  AND preserves the existing "install vs same-client recorder"
 *  serialization that the design doc calls for.
 *
 *  Read-only doctors keep per-(category, action, client) keying
 *  so two unrelated reads on different clients run concurrently. */
export function computeLockKey(descriptor: ActionDescriptor, tenant_id: string): string {
  if (descriptor.category === "file_mutation" || descriptor.category === "artifact_write") {
    return `${tenant_id}::mutation::${descriptor.control_scope}`;
  }
  return `${tenant_id}::${descriptor.category}::${descriptor.action_id}::${descriptor.client_scope}`;
}

export type LockAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; status: 409; error: string };

export function acquireLock(descriptor: ActionDescriptor, tenant_id: string): LockAcquisition {
  const key = computeLockKey(descriptor, tenant_id);
  if (INFLIGHT.has(key)) {
    const blurb =
      descriptor.category === "file_mutation" || descriptor.category === "artifact_write"
        ? `another mutation under ${descriptor.control_scope} is already in flight for this tenant; install / repair / rollback / recorder all serialize on the same control so an install can't run against a config the recorder is attesting to, and two recorder upserts can't race the same result.json`
        : `another ${descriptor.action_id} execution is already in flight for this tenant`;
    return {
      ok: false,
      status: 409,
      error: `${blurb}; refusing overlapping run`,
    };
  }
  INFLIGHT.add(key);
  return {
    ok: true,
    release: () => {
      INFLIGHT.delete(key);
    },
  };
}

export function __testOnly_clearLocks(): void {
  INFLIGHT.clear();
}

// ─── Preview + execute envelopes ─────────────────────────────────

export interface ActionPreview {
  action_id: string;
  category: ActionCategory;
  client_scope: ActionDescriptor["client_scope"];
  control_scope: ActionDescriptor["control_scope"];
  command_summary: string;
  reads: readonly string[];
  /** Write paths resolved at preview time (file_mutation / artifact_
   *  write actions). Empty array for read-only descriptors. */
  mutates: readonly string[];
  /** Explicit backup-behavior sentence for mutation actions. Omitted
   *  (null) on read-only. */
  backup_note: string | null;
  /** Resolved absolute path of the single config file this action
   *  may rewrite, if any. Used by the UI to render a prominent
   *  "will be modified" line. */
  touched_config_path: string | null;
  /** Current value of `mcpServers.verity-one` in the operator's
   *  Claude Desktop config (pretty-printed JSON), if any. Lets
   *  the operator see what a force-repair would OVERWRITE. Null
   *  for first-time installs and read-only descriptors. */
  current_entry_json: string | null;
  /** For file_mutation actions that write structured content:
   *  the EXACT proposed next value the strategy will write at
   *  execute time. Codex MCP install/force surfaces a TOML block
   *  byte-identical to `buildCodexTomlBlock`'s output
   *  (`formatCodexProposedBlockForPreview` mirrors + is drift-
   *  guarded). Null when the value is not determinable at
   *  preview time (rollback; missing install runtime;
   *  read-only). */
  proposed_next_value: string | null;
  /** Human-readable "current vs next" note for the file change. */
  change_note: string | null;
  /** Path-safety check result (symlink + parent-dir realpath
   *  scope). For a mutation descriptor with `ok: false`, the UI
   *  renders a red preview and the Confirm button is disabled.
   *  Null for read-only descriptors where no path-safety check
   *  applies. */
  path_safety:
    | { ok: true; realpath: string | null }
    | { ok: false; reason: string }
    | null;
  risk_level: ActionRiskLevel;
  status_reread: ActionDescriptor["status_reread"];
  rollback_strategy: RollbackStrategyLabel;
  /** Human-readable notes rendered beneath the command summary.
   *  Combines the generic read-only reminder with descriptor-
   *  specific extra_notes for mutation actions. */
  notes: readonly string[];
  confirmation_token: string;
  token_expires_at: number;
}

export interface ActionExecutionResult {
  action_id: string;
  outcome: "pass" | "fail";
  /** Synthetic, redacted one-line summary. Raw stdout/stderr is
   *  NEVER returned to the browser. */
  summary: string;
  duration_ms: number;
  /** Evidence re-read after the action. For this PR all three
   *  read-only strategies re-read the acceptance artifact + the
   *  per-(client, control) status rows so the dashboard can
   *  refresh without inferring from the exit value alone. */
  status_after: {
    artifact_kind: "missing" | "malformed" | "stale" | "ok";
    rows: readonly DashboardControlRow[];
  } | null;
  /** Non-null when the evidence re-read itself failed — the
   *  execute path is honest about "the action ran but we could
   *  not confirm state afterward." */
  status_reread_error?: string;
}

export interface PreviewParams {
  action_id: string;
  args: Record<string, unknown>;
  tenant_id: string;
  now?: number;
}

export type PreviewOutcome =
  | { ok: true; preview: ActionPreview }
  | { ok: false; status: 400 | 403 | 404; error: string };

export function previewAction(params: PreviewParams): PreviewOutcome {
  const descriptor = findDescriptor(params.action_id);
  if (!descriptor) {
    return {
      ok: false,
      status: 404,
      error: `unknown action_id ${JSON.stringify(params.action_id)}`,
    };
  }
  const validation = validateActionRequest(
    { args: params.args },
    descriptor,
  );
  if (!validation.ok) {
    return { ok: false, status: validation.status, error: validation.error };
  }
  // Semantic validation for artifact_write descriptors. The
  // structural validator above only checks types; the recorder's
  // status/pass-requires-both-doctors/secret-refusal rules are
  // semantic and run at preview time so the refusal surfaces
  // BEFORE a token is minted.
  if (descriptor.category === "artifact_write") {
    const sem = validateAcceptanceArgs(validation.args);
    if (!sem.ok) {
      return { ok: false, status: 400, error: sem.reason };
    }
  }
  const args_hash = hashArgs(validation.args);
  // Resolve extras FIRST so the token's `preview_confirmable`
  // flag can reflect the path_safety result. Extras are
  // synchronous by contract (see `resolvePreviewExtras` type).
  const extras: PreviewExtras = descriptor.resolvePreviewExtras
    ? descriptor.resolvePreviewExtras()
    : {};
  // When a mutation preview's path_safety refused (symlinked
  // config, unresolvable install runtime, etc.) the token is
  // still minted so the UI can render the refusal card with a
  // disabled Confirm button — but the token is marked NOT
  // confirmable so a stale-token replay (caller fixes the
  // refusal state out-of-band and POSTs execute directly) is
  // refused at consume time. Read-only descriptors and
  // artifact_write recorders don't set path_safety, so they
  // stay confirmable by default.
  const previewConfirmable = extras.path_safety
    ? extras.path_safety.ok
    : true;
  const token = mintConfirmationToken({
    action_id: descriptor.action_id,
    args_hash,
    tenant_id: params.tenant_id,
    now: params.now,
    preview_confirmable: previewConfirmable,
  });
  const expires_at = (params.now ?? Date.now()) + TOKEN_TTL_MS;
  const notes: string[] = [];
  if (descriptor.category === "read_only") {
    notes.push(
      "This is a read-only check. The runner will spawn / read only the items listed under `reads`.",
    );
    notes.push(
      "The dashboard re-reads its evidence after the action so status updates reflect the current artifact, not the exit code alone.",
    );
  } else {
    notes.push(
      "This is a LOCAL OPERATOR ACTION that writes to disk. Review `mutates` + `backup_note` carefully before confirming.",
    );
    notes.push(
      "The dashboard does not claim `enabled` from exit code alone. After execute the artifact is re-read; the status table reflects current evidence.",
    );
  }
  if (extras.extra_notes) {
    for (const n of extras.extra_notes) notes.push(n);
  }
  return {
    ok: true,
    preview: {
      action_id: descriptor.action_id,
      category: descriptor.category,
      client_scope: descriptor.client_scope,
      control_scope: descriptor.control_scope,
      command_summary: descriptor.command_summary,
      reads: descriptor.reads,
      mutates: extras.mutates ?? descriptor.mutates ?? [],
      backup_note: extras.backup_note ?? null,
      touched_config_path: extras.touched_config_path ?? null,
      current_entry_json: extras.current_entry_json ?? null,
      proposed_next_value: extras.proposed_next_value ?? null,
      change_note: extras.change_note ?? null,
      path_safety: extras.path_safety ?? null,
      risk_level: descriptor.risk_level,
      status_reread: descriptor.status_reread,
      rollback_strategy: descriptor.rollback_strategy,
      notes,
      confirmation_token: token,
      token_expires_at: expires_at,
    },
  };
}

export interface ExecuteParams {
  action_id: string;
  args: Record<string, unknown>;
  confirmation_token: string;
  tenant_id: string;
  now?: number;
  /** Lazy-loaded strategies. Tests inject fakes; production wires
   *  real implementations at the route site via `makeDefault
   *  Strategies()` below. */
  strategies?: StrategyMap;
}

export type ExecuteOutcome =
  | { ok: true; result: ActionExecutionResult }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string };

export async function executeAction(params: ExecuteParams): Promise<ExecuteOutcome> {
  const descriptor = findDescriptor(params.action_id);
  if (!descriptor) {
    return {
      ok: false,
      status: 404,
      error: `unknown action_id ${JSON.stringify(params.action_id)}`,
    };
  }
  const validation = validateActionRequest(
    { args: params.args },
    descriptor,
  );
  if (!validation.ok) {
    return { ok: false, status: validation.status, error: validation.error };
  }
  const args_hash = hashArgs(validation.args);
  const tokenCheck = consumeConfirmationToken({
    token: params.confirmation_token,
    action_id: descriptor.action_id,
    args_hash,
    tenant_id: params.tenant_id,
    now: params.now,
  });
  if (!tokenCheck.ok) {
    return { ok: false, status: tokenCheck.status, error: tokenCheck.error };
  }
  const lock = acquireLock(descriptor, params.tenant_id);
  if (!lock.ok) {
    return { ok: false, status: lock.status, error: lock.error };
  }
  const strategies = params.strategies ?? (await defaultStrategies());
  const startedAt = Date.now();
  try {
    const strategy = strategies[descriptor.execute_strategy];
    if (!strategy) {
      return {
        ok: false,
        status: 500,
        error: `no strategy bound for ${descriptor.execute_strategy}`,
      };
    }
    let strategyResult: StrategyResult;
    try {
      strategyResult = await strategy(validation.args);
    } catch (e) {
      strategyResult = {
        outcome: "fail",
        summary: `strategy threw: ${(e as Error).message}`,
      };
    }
    const duration_ms = Date.now() - startedAt;
    let status_after: ActionExecutionResult["status_after"] = null;
    let status_reread_error: string | undefined;
    try {
      const read = readAcceptanceArtifact(resolveRepoRoot());
      // Rung 10: status re-read after execute uses the async
      // wrapper so `vo_skill` rows get promoted from the
      // Skill checker's output (which the action descriptor
      // cleanup MUST NOT depend on — see design doc §
      // "Evidence transport").
      status_after = {
        artifact_kind: read.kind,
        rows: await computeAllControlRowsWithCheckers(read),
      };
    } catch (e) {
      status_reread_error = `status re-read failed: ${(e as Error).message}`;
    }
    return {
      ok: true,
      result: {
        action_id: descriptor.action_id,
        outcome: strategyResult.outcome,
        summary: redactOutput(strategyResult.summary),
        duration_ms,
        status_after,
        status_reread_error,
      },
    };
  } finally {
    lock.release();
  }
}

// ─── Strategy dispatch ───────────────────────────────────────────

export interface StrategyResult {
  outcome: "pass" | "fail";
  /** Raw or synthetic; redacted on the way out via `redactOutput`. */
  summary: string;
  /** OPTIONAL. Pre-redacted full output blob (e.g. a JSON dump of a
   *  doctor result) for strategies that want to surface more than
   *  the one-line summary. Already passed through `redactOutput`
   *  by the producing strategy. */
  redacted_output?: string;
}

/** Strategy callable. Takes the validated `args` bag so the
 *  recorder can re-validate + upsert without sharing state
 *  through a module-level variable. Read-only doctor strategies
 *  that take no args simply ignore the parameter. */
export type StrategyFn = (args: Record<string, unknown>) => Promise<StrategyResult>;

export type StrategyMap = Partial<Record<StrategyLabel, StrategyFn>>;

/** Real strategies. Lazy-imports mcp/src/doctor + mcp/src/install
 *  so the api module load doesn't eagerly pull zod transitively
 *  via mcp/src/tools/*. Tests inject their own `StrategyMap`. */
export async function defaultStrategies(): Promise<StrategyMap> {
  const doctorMod = (await import("../../../mcp/src/doctor")) as {
    doctor: (opts?: { nodeBin?: string }) => Promise<boolean>;
    doctorClient: (opts: { client: "claude-desktop" | "codex" }) => boolean;
  };
  const installMod = (await import("../../../mcp/src/install")) as {
    install: (
      opts: { client: "claude-desktop" | "codex" | "generic" | "cursor" | "zed"; force: boolean },
      runtime: { nodeBin: string; sourceDist: string; packageRoot: string },
    ) => void;
    buildCodexTomlBlock: BuildCodexTomlBlockFn;
  };
  const codexMergeMod = (await import(
    "../../../mcp/src/codex-toml-merge"
  )) as {
    mergeVerityOneSection: MergeVerityOneSectionFn;
  };
  return {
    live_doctor_handshake: async () => {
      const ok = await doctorMod.doctor();
      return {
        outcome: ok ? "pass" : "fail",
        summary: ok
          ? "live MCP stdio handshake: pass (installed server spawned; 4-step MCP init completed)"
          : "live MCP stdio handshake: FAIL (see `vo mcp doctor` in your terminal for details)",
      };
    },
    client_doctor_claude_desktop: async () => {
      const ok = doctorMod.doctorClient({ client: "claude-desktop" });
      return {
        outcome: ok ? "pass" : "fail",
        summary: ok
          ? "claude-desktop config doctor: pass (verity-one entry present; paths absolute + on disk; VO_URL set; VO_TOKEN absent)"
          : "claude-desktop config doctor: FAIL (see `vo mcp doctor --client claude-desktop` in your terminal for details)",
      };
    },
    client_doctor_codex: async () => {
      const ok = doctorMod.doctorClient({ client: "codex" });
      return {
        outcome: ok ? "pass" : "fail",
        summary: ok
          ? "codex config doctor: pass (verity-one section present in ~/.codex/config.toml)"
          : "codex config doctor: FAIL (section missing or malformed; run `vo mcp doctor --client codex` in your terminal for details)",
      };
    },
    onboard_claude_desktop: async () =>
      runClaudeDesktopInstall({
        force: false,
        install: installMod.install,
        runBuild: defaultRunMcpBuild,
      }),
    onboard_claude_desktop_force: async () =>
      runClaudeDesktopInstall({
        force: true,
        install: installMod.install,
        runBuild: defaultRunMcpBuild,
      }),
    rollback_claude_desktop: async () => runClaudeDesktopRollback(),
    onboard_codex: async () =>
      runCodexMcpInstall({
        force: false,
        install: installMod.install,
        buildBlock: installMod.buildCodexTomlBlock,
        merge: codexMergeMod.mergeVerityOneSection,
        runBuild: defaultRunMcpBuild,
      }),
    onboard_codex_force: async () =>
      runCodexMcpInstall({
        force: true,
        install: installMod.install,
        buildBlock: installMod.buildCodexTomlBlock,
        merge: codexMergeMod.mergeVerityOneSection,
        runBuild: defaultRunMcpBuild,
      }),
    rollback_codex: async () => runCodexMcpRollback(),
    acceptance_record_claude_desktop: async (args) =>
      runAcceptanceRecord("claude-desktop", args),
    acceptance_record_codex: async (args) => runAcceptanceRecord("codex", args),
    skill_install_codex: async () => runCodexSkillInstall({}),
    skill_disable_codex: async () => runCodexSkillDisable({}),
    skill_rollback_codex: async () => runCodexSkillRollback({}),
    skill_install_claude_desktop: async () =>
      runClaudeDesktopSkillInstall({}),
    skill_disable_claude_desktop: async () =>
      runClaudeDesktopSkillDisable({}),
    skill_rollback_claude_desktop: async () =>
      runClaudeDesktopSkillRollback({}),
    skill_doctor_codex: async () => runSkillDoctorCodexStrategy(),
    skill_doctor_claude_desktop: async () =>
      runSkillDoctorClaudeDesktopStrategy(),
  };
}

// ─── Skill doctor strategy wrappers (rung 10) ────────────────────

/** Wrap the library helper in a StrategyResult envelope for the
 *  dashboard action-runner descriptor. The SAME helper is called
 *  directly by `computeStatus` — the descriptor wrapper exists
 *  solely for the operator-visible "run check now" button and
 *  its audit trail. Status-row promotion does NOT depend on this
 *  wrapper being invoked. */
async function runSkillDoctorCodexStrategy(): Promise<StrategyResult> {
  const out = await runSkillDoctorCodex({});
  return {
    outcome: "pass",
    summary: formatSkillDoctorSummary("codex", out),
    redacted_output: redactOutput(JSON.stringify(out, null, 2)),
  };
}

async function runSkillDoctorClaudeDesktopStrategy(): Promise<StrategyResult> {
  const out = await runSkillDoctorClaudeDesktop({});
  return {
    outcome: "pass",
    summary: formatSkillDoctorSummary("claude-desktop", out),
    redacted_output: redactOutput(JSON.stringify(out, null, 2)),
  };
}

function formatSkillDoctorSummary(
  client: "codex" | "claude-desktop",
  out: SkillDoctorOutput,
): string {
  const prefix = client === "codex" ? "codex skill doctor" : "claude desktop skill doctor";
  return `${prefix}: state=${out.state}. ${out.details}`;
}

// ─── Claude Desktop install / rollback strategies ────────────────

/** Narrow adapter around `install({ client: "claude-desktop" })`.
 *  Always rebuilds mcp/ before install so a stale `mcp/dist` left
 *  over from a branch/update cannot sneak into `~/.vo/mcp`. Takes
 *  a backup of the Claude Desktop config BEFORE any write so a
 *  crash between backup and install leaves recoverable state.
 *  Never accepts browser-provided args — the only input is
 *  `force`, which is baked into the descriptor. Exported so
 *  tests can assert the build-first invariant with injected
 *  `install` + `runBuild` fakes. */
export async function runClaudeDesktopInstall(params: {
  force: boolean;
  install: (
    opts: { client: "claude-desktop" | "codex" | "generic" | "cursor" | "zed"; force: boolean },
    runtime: { nodeBin: string; sourceDist: string; packageRoot: string },
  ) => void;
  runBuild: RunMcpBuild;
  /** Optional test-injection surface. Production callers pass
   *  neither hook; regression tests use them to reproduce the
   *  parent-dir TOCTOU attack across the install lifecycle.
   *  `__testOnly_preMutationHook` fires AFTER the initial
   *  path-safety check and AFTER the rebuild / runtime resolve
   *  but BEFORE the pre-backup re-validation.
   *  `__testOnly_preWriteHook` fires AFTER the pre-backup
   *  re-validation + backup but BEFORE the immediately-pre-
   *  install re-validation, so a parent-dir swap inside the
   *  hook hits the final guard window. */
  __testOnly_preMutationHook?: () => void | Promise<void>;
  __testOnly_preWriteHook?: () => void | Promise<void>;
}): Promise<StrategyResult> {
  // Stage 0a: initial path-safety checks. Refuse symlinked
  // config file / symlinked parent diverting the write, AND
  // refuse a symlinked staging tree (`~/.vo`, `~/.vo/mcp`)
  // that would divert the installer's bundled-server writes.
  // Both checks run BEFORE any subprocess or filesystem
  // mutation.
  const configPath = resolveClaudeDesktopConfigPath();
  const safety0 = validateClaudeDesktopConfigPath(configPath);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused: ${safety0.reason}`,
    };
  }
  const staging0 = validateClaudeDesktopStagingRoot();
  if (!staging0.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused (staging-root path safety): ${staging0.reason}`,
    };
  }
  // Stage 0b: rebuild mcp/ fresh. Default contract is "always
  // rebuild" — file existence is not a freshness signal and the
  // dashboard must not copy stale dist bytes into ~/.vo/mcp.
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (e) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused: cannot resolve repo root (${(e as Error).message})`,
    };
  }
  const build = params.runBuild(repoRoot);
  if (!build.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install aborted before install: ${build.summary}`,
    };
  }
  const rt = resolveClaudeDesktopInstallRuntime();
  if (!rt.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused: ${rt.reason}`,
    };
  }

  // TOCTOU-regression hook #1. The build step above can take
  // seconds; an attacker could swap skillDir's parent to a
  // symlink during that window. The pre-backup re-validation
  // below catches it. Production never sets the hook.
  if (params.__testOnly_preMutationHook) {
    await params.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety checks before the backup.
  // Catches a swap that happened between Stage 0a and here
  // (notably during the build / runtime resolution — seconds-
  // long window). Both the config path AND the staging tree
  // re-validate.
  const safety1 = validateClaudeDesktopConfigPath(configPath);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused at re-validation (TOCTOU guard, pre-backup): ${safety1.reason}`,
    };
  }
  const staging1 = validateClaudeDesktopStagingRoot();
  if (!staging1.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused at re-validation (staging-root TOCTOU guard, pre-backup): ${staging1.reason}`,
    };
  }

  const backup = takeClaudeDesktopBackup(configPath);
  if (!backup.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install aborted before write: ${backup.reason ?? "backup failed"}`,
    };
  }

  // TOCTOU-regression hook #2. Tests inject a parent-dir swap
  // here. The immediately-pre-install re-validation below
  // catches it; `O_NOFOLLOW` does not protect intermediate
  // parent components, so the parent-dir swap must be refused
  // via the explicit re-validation.
  if (params.__testOnly_preWriteHook) {
    await params.__testOnly_preWriteHook();
  }

  // Stage 2: IMMEDIATELY-PRE-INSTALL re-validation (parent-dir
  // TOCTOU guard). Validates BOTH the Claude config path AND
  // the `~/.vo/mcp` staging tree that `params.install()` will
  // write through. Same residual-window posture as the Skill
  // strategies + the Claude Desktop rollback — Node does not
  // expose `openat`/`fstatat` in stdlib, so the window between
  // this re-validation and `params.install()`'s first internal
  // write is the irreducible pure-JS limit.
  const safety2 = validateClaudeDesktopConfigPath(configPath);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused at immediately-pre-install re-validation (parent-dir TOCTOU guard): ${safety2.reason}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }
  const staging2 = validateClaudeDesktopStagingRoot();
  if (!staging2.ok) {
    return {
      outcome: "fail",
      summary: `claude-desktop install refused at immediately-pre-install re-validation (staging-root parent-dir TOCTOU guard): ${staging2.reason}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  try {
    params.install({ client: "claude-desktop", force: params.force }, rt.runtime);
  } catch (e) {
    const msg = (e as Error).message;
    // Claude Desktop install library refuses non-force overwrite
    // with a specific message — reshape for the onboard-runner hint.
    const needsForce = /already has.*verity-one|--force to overwrite/i.test(msg);
    const hint = needsForce && !params.force
      ? ` → retry via the "REPAIR (force)" action to overwrite the existing entry. The backup written before this refusal is at ${backup.backup_path ?? "(none, first-time install)"}.`
      : "";
    return {
      outcome: "fail",
      summary: `claude-desktop install FAILED: ${msg}${hint}`,
    };
  }
  const buildNote = build.skipped
    ? " Build: skipped (env override)."
    : " Build: mcp/ rebuilt fresh from source.";
  const backupNote = backup.backup_path
    ? `Pre-write backup: ${backup.backup_path}. Rollback via the mcp_rollback_claude_desktop action.`
    : "No pre-existing config — first-time install; no backup needed.";
  const nextSteps =
    "Next: restart Claude Desktop so it re-reads the config, run a verity-one tool once in the app to prove end-to-end, then record acceptance from your terminal (the dashboard does not claim `enabled` until the acceptance artifact is updated).";
  return {
    outcome: "pass",
    summary: `claude-desktop ${params.force ? "repair (force)" : "install"} ok: ${configPath} now has mcpServers.verity-one.${buildNote} ${backupNote} ${nextSteps}`,
  };
}

/** Test-injectable override surface for the Claude Desktop
 *  rollback strategy. Production callers pass no args. Tests use
 *  the two `__testOnly_*Hook` fields to inject filesystem swaps
 *  at the TOCTOU attack windows the Codex Skill hardening
 *  already covers — this Claude side is kept to the same
 *  hardening standard (reviewer P2). */
export interface ClaudeDesktopRollbackDeps {
  configPathOverride?: string;
  expectedParentOverride?: string;
  now?: Date;
  /** Fires AFTER initial validation + candidate selection,
   *  BEFORE the pre-safety-backup re-validation. Tests use it
   *  to swap the selected candidate / parent dir to a symlink
   *  and prove the re-validation + no-follow reads catch it. */
  __testOnly_preMutationHook?: () => void | Promise<void>;
  /** Fires AFTER the last mid-run re-validation, BEFORE the
   *  immediately-pre-read + immediately-pre-write revalidations.
   *  Tests use it to swap the parent directory and prove the
   *  immediately-pre revalidations catch it. */
  __testOnly_preWriteHook?: () => void | Promise<void>;
}

/** Restore the latest eligible `.bak.*` sibling of the Claude
 *  Desktop config. Takes a fresh safety backup of the CURRENT
 *  config first so the rollback is itself reversible.
 *
 *  Same hardening posture as `runCodexSkillRollback` (reviewer
 *  P2): the eligibility filter rejects impossible/future exact
 *  stamps via `isValidClaudeDesktopBackupStamp`; the safety
 *  backup + restore reads go through `takeClaudeDesktopBackup`
 *  (lstat-fortified) and `readFileNoFollow` (O_NOFOLLOW +
 *  fstat-on-fd) so a symlinked selected candidate cannot
 *  divert bytes; path-safety is re-run at multiple points so a
 *  TOCTOU swap between validate and read/write is caught at
 *  the next revalidation. `__testOnly_pre{Mutation,Write}Hook`
 *  expose the regression-test surface. */
export async function runClaudeDesktopRollback(
  deps: ClaudeDesktopRollbackDeps = {},
): Promise<StrategyResult> {
  const configPath = deps.configPathOverride ?? resolveClaudeDesktopConfigPath();
  const validateOpts: PathSafetyOpts = deps.expectedParentOverride
    ? { expectedParent: deps.expectedParentOverride }
    : {};

  // Stage 0: initial path-safety check.
  const safety0 = validateClaudeDesktopConfigPath(configPath, validateOpts);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `rollback refused: ${safety0.reason}`,
    };
  }
  const latestBackup = findLatestClaudeDesktopBackup(configPath, deps.now);
  if (!latestBackup) {
    return {
      outcome: "fail",
      summary: `rollback refused: no eligible .bak.* sibling of ${configPath} found on disk. Eligibility = exact \`.bak.<8digit>-<6digit>-<3digit>\` stamp + real UTC instant in the past (+ 5-min skew) + regular file. Run an install or repair action first. Hand-created files at the same exact stamp shape are also eligible — eligibility does not prove runner provenance.`,
    };
  }

  // TOCTOU-regression hook #1 — tests inject a candidate-level
  // swap (replace the selected backup with a symlink) or a
  // parent-dir swap here. The re-validation + readFileNoFollow
  // below catch it.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety before the safety backup.
  const safety1 = validateClaudeDesktopConfigPath(configPath, validateOpts);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `rollback refused at re-validation (TOCTOU guard, pre-safety-backup): ${safety1.reason}`,
    };
  }

  // Stage 2: safety backup of current state. `takeClaudeDesktopBackup`
  // is lstat-fortified and reads via `readFileNoFollow`, so a
  // symlinked configPath is refused here even before the
  // re-validations below run.
  const safetyBackup = takeClaudeDesktopBackup(configPath, deps.now);
  if (!safetyBackup.ok) {
    return {
      outcome: "fail",
      summary: `rollback aborted: could not take a safety backup of the current config (${safetyBackup.reason ?? "unknown"}). Refusing to overwrite without an undo path.`,
    };
  }

  // Stage 3: RE-RUN path-safety before the restore read. Catches
  // a swap that happened between Stage 1 and here.
  const safety2 = validateClaudeDesktopConfigPath(configPath, validateOpts);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `rollback refused at re-validation (TOCTOU guard, pre-restore-read): ${safety2.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // TOCTOU-regression hook #2 — tests inject a PARENT-DIR swap
  // here. The immediately-pre-read and immediately-pre-write
  // re-validations below catch it.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 4: IMMEDIATELY-PRE-READ re-validation. `O_NOFOLLOW`
  // protects only the FINAL path component of the candidate;
  // a parent-dir swap between Stage 3 and the readFileNoFollow
  // below would let us open a regular file in the decoy tree
  // at the same candidate name. Node does not expose `openat`,
  // so the window is shrunk via this re-validation (same
  // residual-window posture as the Codex Skill rollback).
  const safety3 = validateClaudeDesktopConfigPath(configPath, validateOpts);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `rollback refused at immediately-pre-read re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 5: read candidate bytes via `readFileNoFollow`
  // (O_NOFOLLOW + fstat-on-fd). A symlink swapped at the
  // candidate's final component is refused with ELOOP (or the
  // fstat fallback on Windows).
  let restoredBytes: Buffer;
  try {
    restoredBytes = readFileNoFollow(latestBackup);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `rollback refused at candidate read (TOCTOU guard, post-selection): ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation. Even with the
  // candidate bytes already in memory, the path-based
  // writeFileSync + renameSync below resolve their destinations
  // through configPath's parent. A parent-dir swap between
  // Stage 5's read and here would land the bytes in the decoy
  // tree.
  const safety4 = validateClaudeDesktopConfigPath(configPath, validateOpts);
  if (!safety4.ok) {
    return {
      outcome: "fail",
      summary: `rollback refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety4.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic restore — write tmp, rename into place.
  // POSIX `rename(2)` does NOT follow a symlink at the
  // destination — it replaces the entry itself — so a late-
  // planted symlink at configPath cannot divert the rename.
  try {
    const tmp = configPath + ".restore.tmp";
    writeFileNoFollowExclusive(tmp, restoredBytes);
    fs.renameSync(tmp, configPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `rollback write FAILED: ${(e as Error).message}. Your safety backup is at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }
  const safetyNote = safetyBackup.backup_path
    ? `Safety backup of pre-rollback state: ${safetyBackup.backup_path}.`
    : "No safety backup was needed (config was absent).";
  return {
    outcome: "pass",
    summary: `claude-desktop rollback ok: restored ${latestBackup} over ${configPath}. ${safetyNote} Restart Claude Desktop for it to re-read the restored config.`,
  };
}

// ─── Codex VO Skill strategies (file_mutation) ───────────────────
//
// Install, disable, rollback. Each strategy re-runs
// `validateCodexSkillTargetPath` BEFORE any filesystem operation
// (defense in depth — the preview ran the same check at token-
// mint time, but the lock window between preview and execute is
// non-zero and a malicious or buggy change on disk between those
// two points must still refuse).
//
// Per-action undo posture — each strategy preserves prior bytes,
// but the SHAPE differs by action:
//
//   - Install  — writes from the pinned repo source. If a prior
//                SKILL.md exists at the target, take a
//                `.bak.<UTC-stamp>` sibling BEFORE the overwrite;
//                first-time install writes no backup (nothing to
//                preserve). Atomic (write-tmp + rename).
//
//   - Disable  — rename-only. Atomic `fs.renameSync` of the
//                current `SKILL.md` → `SKILL.md.disabled.<UTC-
//                stamp>`. The rename ITSELF is the preserved-
//                bytes artifact — no separate `.bak` is written
//                (a copy-then-delete shape would double on-disk
//                bytes + add a crash window where the original
//                is gone but the backup is not yet durable).
//                Never delete; refuses when no `SKILL.md` exists.
//
//   - Rollback — safety backup of the CURRENT `SKILL.md` (if
//                any) BEFORE restoring bytes from the latest
//                valid `.bak` / `.disabled` sibling. Atomic
//                (write-tmp + rename) for both the safety backup
//                and the restore write. Uses the strict candidate
//                filter (anchored stamp regex + round-trip-valid
//                UTC + future-skew guard).
//
// Never deletes unrelated Skills. Never `rm -rf` a parent. Never
// writes outside `verity-one-mcp/SKILL.md` and its timestamped
// siblings.

/** Test-injectable override surface. Production calls pass no
 *  overrides and the runner resolves CODEX_HOME / repo root from
 *  the process environment. Tests supply `resolverDeps` +
 *  `sourcePathOverride` so the strategy can exercise a tmpdir
 *  without mutating the real home.
 *
 *  Three TOCTOU-regression hook points — production never sets
 *  any of them:
 *
 *    - `__testOnly_preMkdirHook` (install only) fires AFTER
 *      the initial path-safety check + source resolution but
 *      BEFORE the strategy's skillDir `mkdirSync` call. Tests
 *      use it to swap `skillsRoot` (the PARENT of skillDir)
 *      to a symlink → decoy. Without this guard, mkdirSync
 *      would follow the symlinked parent and create
 *      `verity-one-mcp` INSIDE the decoy tree even though
 *      the later re-validation catches the swap. The
 *      immediately-pre-mkdir re-validation below refuses
 *      first.
 *
 *    - `__testOnly_preMutationHook` fires AFTER the initial
 *      path-safety check (and any mkdir/existence handling)
 *      but BEFORE the strategy's mid-run re-validation. Tests
 *      use it to inject a swap (replace `skillDir` with a
 *      symlink, etc.); the subsequent mid-run re-validation
 *      MUST catch the swap.
 *
 *    - `__testOnly_preWriteHook` fires AFTER the strategy's
 *      LAST mid-run re-validation but BEFORE the immediately-
 *      pre-write re-validation. Tests use it to inject a
 *      parent-dir swap (replace `verity-one-mcp/` with a
 *      symlink to a decoy dir) to prove the immediately-
 *      pre-write re-validation catches the attack. O_NOFOLLOW
 *      only protects the FINAL path component; an attacker
 *      who swaps a parent component can divert path-based
 *      writes + reads even though the final component is a
 *      regular file. Node does not expose `openat`/`fstatat`,
 *      so a true zero-window race-free mitigation is not
 *      possible in pure JS; the immediately-pre-write re-
 *      validation shrinks the window to the time between two
 *      adjacent synchronous function calls, which the
 *      regression tests exploit via this hook. */
export interface CodexSkillStrategyDeps {
  resolverDeps?: CodexSkillResolverDeps;
  sourcePathOverride?: string;
  repoRootOverride?: string;
  now?: Date;
  __testOnly_preMkdirHook?: () => void | Promise<void>;
  __testOnly_preMutationHook?: () => void | Promise<void>;
  __testOnly_preWriteHook?: () => void | Promise<void>;
}

export async function runCodexSkillInstall(
  deps: CodexSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `codex skill install refused: ${safety0.reason}`,
    };
  }
  const { skillDir, skillFile } = safety0.target;

  // Stage 1: resolve + read source bytes — authoritative path
  // only. Read once via O_NOFOLLOW before any target mutation so
  // the install writes the exact bytes validated at the start of
  // execute, not a source path swapped later in the run.
  let sourcePath: string;
  let sourceBytes: Buffer;
  if (deps.sourcePathOverride) {
    sourcePath = deps.sourcePathOverride;
  } else {
    let repoRoot: string;
    try {
      repoRoot = deps.repoRootOverride ?? resolveRepoRoot();
    } catch (e) {
      return {
        outcome: "fail",
        summary: `codex skill install refused: cannot resolve repo root (${(e as Error).message})`,
      };
    }
    sourcePath = path.join(repoRoot, CODEX_SKILL_SOURCE_REL_PATH);
  }
  try {
    sourceBytes = readFileNoFollow(sourcePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return {
      outcome: "fail",
      summary:
        code === "ENOENT"
          ? `codex skill install refused: repo source missing at ${sourcePath}. The action only copies from the pinned repo path.`
          : `codex skill install refused: repo source at ${sourcePath} could not be read as a regular no-follow file (${(e as Error).message}). The action only copies from the pinned repo path.`,
    };
  }

  // Stage 2: ensure skillDir exists as a REAL directory. Use
  // `lstat` (NOT `existsSync`) so a symlink swapped in between
  // Stage 0 and here is not followed. If absent, mkdir with
  // `recursive: false` — skillsRoot is already validated;
  // recursive:true would create skillsRoot behind the validator.
  //
  // Reviewer P2 repro: swapping `skillsRoot` (the PARENT of
  // skillDir) to a symlink → decoy between Stage 0 and the
  // `fs.mkdirSync(skillDir)` call below let the mkdir follow
  // the symlinked parent and create `verity-one-mcp` inside
  // the decoy tree, even though the later re-validation
  // caught the swap. The fix below: an immediately-pre-mkdir
  // re-validation + a `__testOnly_preMkdirHook` so the
  // regression test can reproduce the exact attack window.
  const skillDirLstat = lstatOrNull(skillDir);
  if (skillDirLstat) {
    if (skillDirLstat.isSymbolicLink()) {
      return {
        outcome: "fail",
        summary: `codex skill install refused: ${skillDir} is a symlink (swapped in after initial path-safety check). Refusing to follow.`,
      };
    }
    if (!skillDirLstat.isDirectory()) {
      return {
        outcome: "fail",
        summary: `codex skill install refused: ${skillDir} exists but is not a directory (${describeStatKind(skillDirLstat)}).`,
      };
    }
  } else {
    // skillDir is absent — we're about to mkdirSync it under
    // skillsRoot. The mkdir resolves the path through
    // skillsRoot, so a swap of skillsRoot to a symlink BEFORE
    // this point would divert the mkdir into the decoy tree.
    // Re-validate immediately before mkdir so the swap is
    // refused BEFORE any filesystem write lands.
    if (deps.__testOnly_preMkdirHook) {
      await deps.__testOnly_preMkdirHook();
    }
    const safetyMkdir = validateCodexSkillTargetPath(deps.resolverDeps);
    if (!safetyMkdir.ok) {
      return {
        outcome: "fail",
        summary: `codex skill install refused at immediately-pre-mkdir re-validation (parent-dir TOCTOU guard): ${safetyMkdir.reason}. Refusing to create ${skillDir} through a swapped parent.`,
      };
    }
    try {
      fs.mkdirSync(skillDir, { recursive: false });
    } catch (e) {
      return {
        outcome: "fail",
        summary: `codex skill install aborted: could not create ${skillDir} (${(e as Error).message})`,
      };
    }
  }

  // TOCTOU-regression hook — tests inject a filesystem swap here
  // so the re-validation below has something to refuse. Production
  // never sets the hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 3: RE-RUN path-safety immediately before backup. Catches
  // a swap that happened between Stage 0 and here (symlinked
  // skillDir or skillFile swapped in, ancestor symlink swapped
  // in, etc.). Defense in depth against TOCTOU between the
  // initial validation and the filesystem writes below.
  const safety1 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `codex skill install refused at re-validation (TOCTOU guard, pre-backup): ${safety1.reason}`,
    };
  }

  // Stage 4: backup current SKILL.md (if any) before overwrite.
  // takeCodexSkillBackup is now lstat-fortified — a swapped-in
  // symlink at skillFile is refused rather than followed.
  const backup = takeCodexSkillBackup(skillFile, deps.now);
  if (!backup.ok) {
    return {
      outcome: "fail",
      summary: `codex skill install aborted before write: ${backup.reason ?? "backup failed"}`,
    };
  }

  // Stage 5: RE-RUN path-safety once more, before the atomic
  // copy. Catches a swap that happened between the backup and
  // here.
  const safety2 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `codex skill install refused at re-validation (TOCTOU guard, pre-write): ${safety2.reason}. Backup at ${backup.backup_path ?? "(none)"}.`,
    };
  }

  // TOCTOU-regression hook #2 — tests inject a PARENT-DIR swap
  // here (replace skillDir with a symlink to a decoy). The
  // immediately-pre-write re-validation in Stage 6 catches it.
  // Production never sets the hook.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation. O_NOFOLLOW
  // protects only the FINAL path component; an attacker who
  // swaps a parent component (e.g. replaces `verity-one-mcp/`
  // with a symlink → decoy/) between Stage 5 and the write
  // would divert the path-based writeFileSync + renameSync into
  // the decoy tree even though the final SKILL.md component is
  // a regular file. Node does not expose `openat`/`fstatat`, so
  // a true zero-window fix is not possible in pure JS. This
  // re-validation shrinks the window to the time between two
  // adjacent sync calls — not race-free, but as tight as the
  // runtime permits.
  const safety3 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `codex skill install refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Backup at ${backup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic copy — write tmp, rename into place. POSIX
  // rename does NOT follow a symlink on the destination — it
  // replaces the entry itself, whether that entry is a file or
  // a symlink. So a late-planted symlink at skillFile cannot
  // divert bytes, but an intermediate-parent swap after Stage 6
  // still could (hence the warning above).
  try {
    const tmp = skillFile + ".tmp";
    writeFileNoFollowExclusive(tmp, sourceBytes);
    fs.renameSync(tmp, skillFile);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex skill install write FAILED: ${(e as Error).message}. Backup at ${backup.backup_path ?? "(none — first-time install)"}.`,
    };
  }

  const backupNote = backup.backup_path
    ? `Pre-write backup: ${backup.backup_path}. Rollback via the skill_rollback_codex action.`
    : "No pre-existing SKILL.md at the Codex target — first-time install; no backup needed.";
  const nextSteps =
    "Next: restart Codex so it re-reads its Skills directory, exercise one Skill instruction manually in the client, then record a Skill-specific acceptance cell (`skill_observed=true` + non-empty note) if the Skill behavior was observed. Status re-read runs `skill_doctor_codex`; checker evidence alone does not enable the row.";
  return {
    outcome: "pass",
    summary: `codex skill install ok: ${skillFile} now mirrors ${sourcePath}. ${backupNote} ${nextSteps}`,
  };
}

export async function runCodexSkillDisable(
  deps: CodexSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused: ${safety0.reason}`,
    };
  }
  const { skillFile } = safety0.target;
  // Use `lstat` (NOT `existsSync`) for the presence check so a
  // symlink swapped in at skillFile between Stage 0 and here is
  // not followed when deciding "does the file exist?".
  const skillFileLstat = lstatOrNull(skillFile);
  if (!skillFileLstat) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused: no SKILL.md at ${skillFile} — nothing to disable. Run skill_install_codex first, or skill_rollback_codex to restore from a prior backup/disabled sibling.`,
    };
  }
  if (skillFileLstat.isSymbolicLink()) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused: ${skillFile} is a symlink (swapped in after initial path-safety check). Refusing to rename — a rename on a symlink entry would rename the link, not the real Skill bytes the operator expects.`,
    };
  }
  if (!skillFileLstat.isFile()) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused: ${skillFile} is not a regular file (${describeStatKind(skillFileLstat)}).`,
    };
  }

  // TOCTOU-regression hook — tests inject a filesystem swap here
  // so the re-validation below has something to refuse. Production
  // never sets the hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety before the rename. Catches a
  // swap that happened between Stage 0 and here.
  const safety1 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused at re-validation (TOCTOU guard, pre-rename): ${safety1.reason}`,
    };
  }

  // TOCTOU-regression hook #2 — tests inject a PARENT-DIR swap
  // here. The immediately-pre-rename re-validation catches it.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 2: IMMEDIATELY-PRE-RENAME re-validation. See the
  // install strategy for the full O_NOFOLLOW-parent-swap
  // explanation; the same window applies to path-based rename.
  const safety2 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `codex skill disable refused at immediately-pre-rename re-validation (parent-dir TOCTOU guard): ${safety2.reason}`,
    };
  }

  // Stage 3: atomic rename. POSIX rename does NOT follow symlinks
  // on either operand — if a symlink was planted at skillFile
  // between Stage 2 and here, rename would rename the LINK
  // itself, not the target. Stage 2's re-validation already
  // refused a symlinked skillFile, so this operand is a real
  // regular file.
  const disabledPath = codexSkillDisabledPath(skillFile, deps.now);
  try {
    fs.renameSync(skillFile, disabledPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex skill disable rename FAILED: ${(e as Error).message}`,
    };
  }
  return {
    outcome: "pass",
    summary: `codex skill disable ok: ${skillFile} → ${disabledPath}. Bytes preserved intact; restore via skill_rollback_codex or \`mv ${disabledPath} ${skillFile}\`. Status re-read runs skill_doctor_codex; enabled requires checker=installed plus a fresh Skill acceptance cell (skill_observed=true + note).`,
  };
}

export async function runCodexSkillRollback(
  deps: CodexSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused: ${safety0.reason}`,
    };
  }
  const { skillFile } = safety0.target;
  const candidate = findLatestCodexSkillRestoreCandidate(skillFile, deps.now);
  if (!candidate) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused: no eligible SKILL.md.bak.<UTC-stamp> or SKILL.md.disabled.<UTC-stamp> sibling found on disk at ${path.dirname(skillFile)}. Run skill_install_codex or skill_disable_codex first. Eligibility = anchored stamp regex + real UTC instant in the past (+ 5-min skew) + regular file; \`.tmp\`, prefix/suffix junk, malformed / impossible / future stamps, symlinks, and non-regular-files are rejected. Exact valid timestamp-shaped HAND-CREATED siblings ARE eligible — eligibility does NOT prove runner provenance (no manifest ships today).`,
    };
  }

  // TOCTOU-regression hook — tests inject a filesystem swap here
  // so the re-validation below has something to refuse. Production
  // never sets the hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety immediately before the safety
  // backup. Catches a swap that happened between Stage 0 and here
  // (symlinked skillFile / skillDir / ancestor).
  const safety1 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused at re-validation (TOCTOU guard, pre-safety-backup): ${safety1.reason}`,
    };
  }

  // Stage 2: safety backup of current state — only when SKILL.md
  // exists (as a regular file — lstat, not existsSync).
  let safetyBackup: BackupOutcome = {
    ok: true,
    backup_path: null,
    reason: "current SKILL.md absent — no safety backup needed",
  };
  const skillFileLstat = lstatOrNull(skillFile);
  if (skillFileLstat) {
    safetyBackup = takeCodexSkillBackup(skillFile, deps.now);
    if (!safetyBackup.ok) {
      return {
        outcome: "fail",
        summary: `codex skill rollback aborted: safety backup of current state failed (${safetyBackup.reason ?? "unknown"}). Refusing to overwrite without an undo path.`,
      };
    }
  }

  // Stage 3: RE-RUN path-safety before the restore. Catches a
  // swap that happened between the safety backup and here.
  const safety2 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused at re-validation (TOCTOU guard, pre-restore): ${safety2.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // TOCTOU-regression hook #2 — tests inject a PARENT-DIR swap
  // here. The two immediately-pre re-validations below catch
  // it BEFORE the path-based read + write.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 4: IMMEDIATELY-PRE-READ re-validation. `O_NOFOLLOW`
  // protects only the FINAL path component of candidate.absPath;
  // an attacker who swaps an intermediate parent (e.g.
  // `verity-one-mcp/` → symlink → decoy/) between Stage 3 and
  // the readFileNoFollow below would open a regular file in
  // the decoy tree even though the candidate name itself is
  // not a symlink. Re-validate to catch a parent-dir swap
  // before we even try to read.
  const safety3 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused at immediately-pre-read re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 5: read candidate bytes via `O_NOFOLLOW` + fstat so a
  // symlink swapped AT the candidate's final component is
  // refused. Reviewer-reproduced scenario: without this,
  // swapping the selected backup to a symlink inside
  // `__testOnly_preMutationHook` caused rollback to return
  // pass and write the decoy's bytes into SKILL.md.
  let restoredBytes: Buffer;
  try {
    restoredBytes = readFileNoFollow(candidate.absPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused at candidate read (TOCTOU guard, post-selection): ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation. Even with the
  // candidate bytes already in memory, the path-based
  // writeFileSync + renameSync below resolve their destinations
  // through `skillFile`'s parent. A parent-dir swap between
  // Stage 5's read and the write would land the bytes in the
  // decoy tree. Re-validate once more.
  const safety4 = validateCodexSkillTargetPath(deps.resolverDeps);
  if (!safety4.ok) {
    return {
      outcome: "fail",
      summary: `codex skill rollback refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety4.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic restore — write tmp, rename into place.
  // POSIX `rename(2)` does NOT follow a symlink at the
  // destination — it replaces the entry itself — so a late-
  // planted symlink at skillFile cannot divert the rename.
  try {
    const tmp = skillFile + ".restore.tmp";
    writeFileNoFollowExclusive(tmp, restoredBytes);
    fs.renameSync(tmp, skillFile);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex skill rollback write FAILED: ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }
  const safetyNote = safetyBackup.backup_path
    ? `Safety backup of pre-rollback state: ${safetyBackup.backup_path}.`
    : "Current SKILL.md was absent — no safety backup needed.";
  return {
    outcome: "pass",
    summary: `codex skill rollback ok: restored ${candidate.absPath} (${candidate.kind}.${candidate.stamp}) over ${skillFile}. ${safetyNote} Restart Codex so it picks up the restored Skill. Status re-read runs skill_doctor_codex; enabled requires checker=installed plus a fresh Skill acceptance cell (skill_observed=true + note).`,
  };
}

// ─── Claude Desktop VO Skill strategies (file_mutation) ──────────
//
// VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1. Three strategies:
// install, disable, rollback. Mirror the shipped Codex Skill
// strategy posture byte-for-byte — same 8/4/8-stage TOCTOU
// pipeline, same stamp shape, same atomic write discipline, same
// test-injection hook surface. Only the target-path validator,
// the source rel-path constant, the backup helper, and operator-
// facing error-message prefixes differ.
//
// Reuses client-agnostic filename-based helpers wholesale:
//   - `codexSkillBackupPath`     — `${skillFile}.bak.<UTC-stamp>`
//   - `codexSkillDisabledPath`   — `${skillFile}.disabled.<UTC-stamp>`
//   - `findLatestCodexSkillRestoreCandidate` — regex matches
//     `SKILL.md.{bak,disabled}.<stamp>` siblings regardless of
//     which client owns the parent directory.
// These helpers are Codex-prefixed for historical reasons only;
// they operate on path bytes, not on client identity. Keeping the
// names avoids churn in the Codex PR's test fixtures. The drift
// guard in `agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`
// pins both sides.

export interface ClaudeDesktopSkillStrategyDeps {
  resolverDeps?: ClaudeDesktopSkillResolverDeps;
  sourcePathOverride?: string;
  repoRootOverride?: string;
  now?: Date;
  __testOnly_preMkdirHook?: () => void | Promise<void>;
  __testOnly_preMutationHook?: () => void | Promise<void>;
  __testOnly_preWriteHook?: () => void | Promise<void>;
}

export async function runClaudeDesktopSkillInstall(
  deps: ClaudeDesktopSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install refused: ${safety0.reason}`,
    };
  }
  const { skillDir, skillFile } = safety0.target;

  // Stage 1: resolve + read source bytes — authoritative path
  // only. Read once via O_NOFOLLOW before any target mutation so
  // the install writes the exact bytes validated at the start of
  // execute, not a source path swapped later in the run.
  let sourcePath: string;
  let sourceBytes: Buffer;
  if (deps.sourcePathOverride) {
    sourcePath = deps.sourcePathOverride;
  } else {
    let repoRoot: string;
    try {
      repoRoot = deps.repoRootOverride ?? resolveRepoRoot();
    } catch (e) {
      return {
        outcome: "fail",
        summary: `claude desktop skill install refused: cannot resolve repo root (${(e as Error).message})`,
      };
    }
    sourcePath = path.join(repoRoot, CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH);
  }
  try {
    sourceBytes = readFileNoFollow(sourcePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return {
      outcome: "fail",
      summary:
        code === "ENOENT"
          ? `claude desktop skill install refused: repo source missing at ${sourcePath}. The action only copies from the pinned repo path.`
          : `claude desktop skill install refused: repo source at ${sourcePath} could not be read as a regular no-follow file (${(e as Error).message}). The action only copies from the pinned repo path.`,
    };
  }

  // Stage 2: ensure skillDir exists as a REAL directory. Use
  // `lstat` (NOT `existsSync`) so a symlink swapped in between
  // Stage 0 and here is not followed. If absent, mkdir with
  // `recursive: false` — skillsRoot is already validated;
  // recursive:true would create skillsRoot behind the validator.
  //
  // See runCodexSkillInstall for the reviewer P2 repro that
  // motivates the immediately-pre-mkdir re-validation +
  // `__testOnly_preMkdirHook`.
  const skillDirLstat = lstatOrNull(skillDir);
  if (skillDirLstat) {
    if (skillDirLstat.isSymbolicLink()) {
      return {
        outcome: "fail",
        summary: `claude desktop skill install refused: ${skillDir} is a symlink (swapped in after initial path-safety check). Refusing to follow.`,
      };
    }
    if (!skillDirLstat.isDirectory()) {
      return {
        outcome: "fail",
        summary: `claude desktop skill install refused: ${skillDir} exists but is not a directory (${describeStatKind(skillDirLstat)}).`,
      };
    }
  } else {
    if (deps.__testOnly_preMkdirHook) {
      await deps.__testOnly_preMkdirHook();
    }
    const safetyMkdir = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
    if (!safetyMkdir.ok) {
      return {
        outcome: "fail",
        summary: `claude desktop skill install refused at immediately-pre-mkdir re-validation (parent-dir TOCTOU guard): ${safetyMkdir.reason}. Refusing to create ${skillDir} through a swapped parent.`,
      };
    }
    try {
      fs.mkdirSync(skillDir, { recursive: false });
    } catch (e) {
      return {
        outcome: "fail",
        summary: `claude desktop skill install aborted: could not create ${skillDir} (${(e as Error).message})`,
      };
    }
  }

  // TOCTOU-regression hook — tests inject a filesystem swap here
  // so the re-validation below has something to refuse. Production
  // never sets the hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 3: RE-RUN path-safety immediately before backup.
  const safety1 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install refused at re-validation (TOCTOU guard, pre-backup): ${safety1.reason}`,
    };
  }

  // Stage 4: backup current SKILL.md (if any) before overwrite.
  const backup = takeClaudeDesktopSkillBackup(skillFile, deps.now);
  if (!backup.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install aborted before write: ${backup.reason ?? "backup failed"}`,
    };
  }

  // Stage 5: RE-RUN path-safety once more, before the atomic
  // copy.
  const safety2 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install refused at re-validation (TOCTOU guard, pre-write): ${safety2.reason}. Backup at ${backup.backup_path ?? "(none)"}.`,
    };
  }

  // TOCTOU-regression hook #2 — tests inject a PARENT-DIR swap
  // here. The immediately-pre-write re-validation in Stage 6
  // catches it. Production never sets the hook.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation.
  const safety3 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Backup at ${backup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic copy — write tmp, rename into place.
  try {
    const tmp = skillFile + ".tmp";
    writeFileNoFollowExclusive(tmp, sourceBytes);
    fs.renameSync(tmp, skillFile);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `claude desktop skill install write FAILED: ${(e as Error).message}. Backup at ${backup.backup_path ?? "(none — first-time install)"}.`,
    };
  }

  const backupNote = backup.backup_path
    ? `Pre-write backup: ${backup.backup_path}. Rollback via the skill_rollback_claude_desktop action.`
    : "No pre-existing SKILL.md at the Claude Desktop target — first-time install; no backup needed.";
  const nextSteps =
    "Next: restart Claude Desktop so it re-reads its AgentSkills directory, exercise one Skill instruction manually in the client, then record a Skill-specific acceptance cell (`skill_observed=true` + non-empty note) if the Skill behavior was observed. Status re-read runs `skill_doctor_claude_desktop`; checker evidence alone does not enable the row.";
  return {
    outcome: "pass",
    summary: `claude desktop skill install ok: ${skillFile} now mirrors ${sourcePath}. ${backupNote} ${nextSteps}`,
  };
}

export async function runClaudeDesktopSkillDisable(
  deps: ClaudeDesktopSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused: ${safety0.reason}`,
    };
  }
  const { skillFile } = safety0.target;
  const skillFileLstat = lstatOrNull(skillFile);
  if (!skillFileLstat) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused: no SKILL.md at ${skillFile} — nothing to disable. Run skill_install_claude_desktop first, or skill_rollback_claude_desktop to restore from a prior backup/disabled sibling.`,
    };
  }
  if (skillFileLstat.isSymbolicLink()) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused: ${skillFile} is a symlink (swapped in after initial path-safety check). Refusing to rename — a rename on a symlink entry would rename the link, not the real Skill bytes the operator expects.`,
    };
  }
  if (!skillFileLstat.isFile()) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused: ${skillFile} is not a regular file (${describeStatKind(skillFileLstat)}).`,
    };
  }

  // TOCTOU-regression hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety before the rename.
  const safety1 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused at re-validation (TOCTOU guard, pre-rename): ${safety1.reason}`,
    };
  }

  // TOCTOU-regression hook #2 — PARENT-DIR swap.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 2: IMMEDIATELY-PRE-RENAME re-validation.
  const safety2 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable refused at immediately-pre-rename re-validation (parent-dir TOCTOU guard): ${safety2.reason}`,
    };
  }

  // Stage 3: atomic rename.
  const disabledPath = codexSkillDisabledPath(skillFile, deps.now);
  try {
    fs.renameSync(skillFile, disabledPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `claude desktop skill disable rename FAILED: ${(e as Error).message}`,
    };
  }
  return {
    outcome: "pass",
    summary: `claude desktop skill disable ok: ${skillFile} → ${disabledPath}. Bytes preserved intact; restore via skill_rollback_claude_desktop or \`mv ${disabledPath} ${skillFile}\`. Status re-read runs skill_doctor_claude_desktop; enabled requires checker=installed plus a fresh Skill acceptance cell (skill_observed=true + note).`,
  };
}

export async function runClaudeDesktopSkillRollback(
  deps: ClaudeDesktopSkillStrategyDeps = {},
): Promise<StrategyResult> {
  // Stage 0: initial path-safety check.
  const safety0 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused: ${safety0.reason}`,
    };
  }
  const { skillFile } = safety0.target;
  const candidate = findLatestCodexSkillRestoreCandidate(skillFile, deps.now);
  if (!candidate) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused: no eligible SKILL.md.bak.<UTC-stamp> or SKILL.md.disabled.<UTC-stamp> sibling found on disk at ${path.dirname(skillFile)}. Run skill_install_claude_desktop or skill_disable_claude_desktop first. Eligibility = anchored stamp regex + real UTC instant in the past (+ 5-min skew) + regular file; \`.tmp\`, prefix/suffix junk, malformed / impossible / future stamps, symlinks, and non-regular-files are rejected. Exact valid timestamp-shaped HAND-CREATED siblings ARE eligible — eligibility does NOT prove runner provenance (no manifest ships today).`,
    };
  }

  // TOCTOU-regression hook.
  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-RUN path-safety immediately before the safety
  // backup.
  const safety1 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused at re-validation (TOCTOU guard, pre-safety-backup): ${safety1.reason}`,
    };
  }

  // Stage 2: safety backup of current state — only when SKILL.md
  // exists (as a regular file — lstat, not existsSync).
  let safetyBackup: BackupOutcome = {
    ok: true,
    backup_path: null,
    reason: "current SKILL.md absent — no safety backup needed",
  };
  const skillFileLstat = lstatOrNull(skillFile);
  if (skillFileLstat) {
    safetyBackup = takeClaudeDesktopSkillBackup(skillFile, deps.now);
    if (!safetyBackup.ok) {
      return {
        outcome: "fail",
        summary: `claude desktop skill rollback aborted: safety backup of current state failed (${safetyBackup.reason ?? "unknown"}). Refusing to overwrite without an undo path.`,
      };
    }
  }

  // Stage 3: RE-RUN path-safety before the restore.
  const safety2 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused at re-validation (TOCTOU guard, pre-restore): ${safety2.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // TOCTOU-regression hook #2 — PARENT-DIR swap.
  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 4: IMMEDIATELY-PRE-READ re-validation.
  const safety3 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused at immediately-pre-read re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 5: read candidate bytes via O_NOFOLLOW + fstat.
  let restoredBytes: Buffer;
  try {
    restoredBytes = readFileNoFollow(candidate.absPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused at candidate read (TOCTOU guard, post-selection): ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation.
  const safety4 = validateClaudeDesktopSkillTargetPath(deps.resolverDeps);
  if (!safety4.ok) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety4.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic restore — write tmp, rename into place.
  try {
    const tmp = skillFile + ".restore.tmp";
    writeFileNoFollowExclusive(tmp, restoredBytes);
    fs.renameSync(tmp, skillFile);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `claude desktop skill rollback write FAILED: ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }
  const safetyNote = safetyBackup.backup_path
    ? `Safety backup of pre-rollback state: ${safetyBackup.backup_path}.`
    : "Current SKILL.md was absent — no safety backup needed.";
  return {
    outcome: "pass",
    summary: `claude desktop skill rollback ok: restored ${candidate.absPath} (${candidate.kind}.${candidate.stamp}) over ${skillFile}. ${safetyNote} Restart Claude Desktop so it picks up the restored Skill. Status re-read runs skill_doctor_claude_desktop; enabled requires checker=installed plus a fresh Skill acceptance cell (skill_observed=true + note).`,
  };
}

// ─── Codex MCP config strategies (file_mutation) ─────────────────
//
// VO-MCP-CODEX-INSTALL-ACTION-PR-1. Three strategies: install,
// force-repair, rollback. Each re-runs `validateCodexMcpConfigPath`
// BEFORE any filesystem operation (defense in depth — preview ran
// the same check at token-mint time, but the lock window between
// preview and execute is non-zero).
//
// Backup posture:
//   - Install  — takes `<cfg>.bak.<UTC-stamp>` BEFORE merge ONLY
//                when the config already exists. First-time install
//                writes NO backup (nothing to preserve); rollback
//                then refuses because no eligible backup exists.
//   - Force    — always takes a backup (force requires an existing
//                section, which implies an existing file).
//   - Rollback — safety backup of current bytes BEFORE the restore
//                write so the rollback itself is reversible.
//                Refuses when no eligible backup exists — NO backup
//                ⇒ NO rollback; never deletes the config, never
//                synthesizes an empty-file undo.
//
// Write posture:
//   - Atomic (write-tmp + rename) via `writeFileNoFollowExclusive`.
//   - Reads via `readFileNoFollow` (O_NOFOLLOW + fstat-on-fd).
//   - Merge preserves unrelated sections byte-for-byte and
//     validates the file parses as TOML before AND after the merge
//     (smol-toml).

export type BuildCodexTomlBlockFn = (runtime: {
  nodeBin: string;
  sourceDist: string;
  packageRoot: string;
}) => string;

export type MergeVerityOneSectionFn = (
  input: string,
  block: string,
  opts: { mode: "install" | "force" },
) =>
  | {
      ok: true;
      output: string;
      section_range: { start: number; end: number };
      first_time_section: boolean;
    }
  | { ok: false; reason: string; code: string };

/** Test-injectable override surface for the Codex MCP install
 *  strategy. Production callers pass `install`, `buildBlock`,
 *  `merge`, and `runBuild`; tests inject fakes to exercise TOCTOU
 *  regressions + merge-refusal branches without mutating real
 *  home state. Three `__testOnly_*Hook` hooks mirror the Claude
 *  Desktop strategy's TOCTOU-regression surface. */
export interface CodexMcpInstallDeps {
  force: boolean;
  install: (
    opts: {
      client: "claude-desktop" | "codex" | "generic" | "cursor" | "zed";
      force: boolean;
    },
    runtime: { nodeBin: string; sourceDist: string; packageRoot: string },
  ) => void;
  buildBlock: BuildCodexTomlBlockFn;
  merge: MergeVerityOneSectionFn;
  runBuild: RunMcpBuild;
  configPathOverride?: string;
  /** Fires AFTER initial path-safety + rebuild + runtime resolve,
   *  BEFORE the pre-backup re-validation. */
  __testOnly_preMutationHook?: () => void | Promise<void>;
  /** Fires AFTER the pre-backup re-validation + backup but BEFORE
   *  the immediately-pre-install re-validation. */
  __testOnly_preWriteHook?: () => void | Promise<void>;
  /** Fires AFTER the install filesystem step and AFTER the merge
   *  call but BEFORE the immediately-pre-write-merge revalidation.
   *  Tests use it to swap the parent-dir between merge and write
   *  to prove the final revalidation catches it. */
  __testOnly_preMergeWriteHook?: () => void | Promise<void>;
}

/** Merge the `[mcp_servers.verity-one]` TOML block into the Codex
 *  MCP config at `~/.codex/config.toml`. Mirrors the hardening
 *  posture of `runClaudeDesktopInstall` (initial + pre-backup +
 *  immediately-pre-install + immediately-pre-merge-write
 *  path-safety revalidations; readFileNoFollow;
 *  writeFileNoFollowExclusive). */
export async function runCodexMcpInstall(
  params: CodexMcpInstallDeps,
): Promise<StrategyResult> {
  const configPath = params.configPathOverride ?? resolveCodexMcpConfigPath();

  // Stage 0a: initial path-safety check.
  const safety0 = validateCodexMcpConfigPath(configPath);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP ${params.force ? "repair" : "install"} refused: ${safety0.reason}`,
    };
  }

  // Stage 0b: rebuild mcp/ + resolve install runtime. Mirrors the
  // Claude Desktop install — fresh build every run, never trust
  // existing mcp/dist bytes.
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused: cannot resolve repo root (${(e as Error).message})`,
    };
  }
  const build = params.runBuild(repoRoot);
  if (!build.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install aborted before install: ${build.summary}`,
    };
  }
  const rt = resolveClaudeDesktopInstallRuntime();
  if (!rt.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused: ${rt.reason}`,
    };
  }

  if (params.__testOnly_preMutationHook) {
    await params.__testOnly_preMutationHook();
  }

  // Stage 1: RE-VALIDATE path-safety before the backup.
  const safety1 = validateCodexMcpConfigPath(configPath);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused at re-validation (TOCTOU guard, pre-backup): ${safety1.reason}`,
    };
  }

  // Stage 2: backup. Returns non-null backup_path when config
  // exists; null when config is absent (first-time install).
  const backup = takeCodexMcpBackup(configPath);
  if (!backup.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install aborted before write: ${backup.reason ?? "backup failed"}`,
    };
  }

  if (params.__testOnly_preWriteHook) {
    await params.__testOnly_preWriteHook();
  }

  // Stage 3: IMMEDIATELY-PRE-INSTALL re-validation. Catches parent-
  // dir swap between backup and installer call.
  const safety2 = validateCodexMcpConfigPath(configPath);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused at immediately-pre-install re-validation (parent-dir TOCTOU guard): ${safety2.reason}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }
  const staging2 = validateClaudeDesktopStagingRoot();
  if (!staging2.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused at immediately-pre-install re-validation (staging-root parent-dir TOCTOU guard): ${staging2.reason}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  // Stage 4: run the install. For Codex the upstream installer
  // handles the filesystem install of `~/.vo/mcp` + prints the
  // TOML instructions to stdout. The dashboard strategy IGNORES
  // the printed instructions — the merge below is what actually
  // lands the verity-one section into `~/.codex/config.toml`.
  try {
    params.install({ client: "codex", force: false }, rt.runtime);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex MCP filesystem install FAILED: ${(e as Error).message}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  // Stage 5: read current config bytes (for merge input). Empty
  // string for first-time install.
  let input = "";
  if (backup.backup_path) {
    // Backup exists ⇒ config file exists at preview time. Read via
    // readFileNoFollow so a late-planted symlink cannot divert
    // bytes.
    try {
      input = readFileNoFollow(configPath).toString("utf8");
    } catch (e) {
      return {
        outcome: "fail",
        summary: `codex MCP install refused: could not read existing config: ${(e as Error).message}. Backup at ${backup.backup_path}.`,
      };
    }
  }

  // Stage 6: build the TOML block + merge.
  const block = params.buildBlock(rt.runtime);
  const mergeResult = params.merge(input, block, {
    mode: params.force ? "force" : "install",
  });
  if (!mergeResult.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP merge refused: ${mergeResult.reason} (code: ${mergeResult.code}). Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  if (params.__testOnly_preMergeWriteHook) {
    await params.__testOnly_preMergeWriteHook();
  }

  // Stage 7: IMMEDIATELY-PRE-MERGE-WRITE re-validation. Catches a
  // parent-dir swap between merge-compute and the write below.
  const safety3 = validateCodexMcpConfigPath(configPath);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP install refused at immediately-pre-merge-write re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  // Stage 7b: FIRST-TIME-INSTALL RACE GUARD (reviewer P2). If we
  // recorded no backup (first-time install — config was absent at
  // Stage 2), but the config file now EXISTS on disk, REFUSE. The
  // file appeared between the backup decision and the merge write;
  // those bytes were never read, never backed up, and the pre-
  // computed merge input (empty string) does not reflect them.
  // Writing the merge output via rename would silently overwrite
  // the newly-created content with no undo path. Refusing is the
  // safe posture — a re-run will take a backup before writing
  // because the file now exists.
  if (!backup.backup_path) {
    let appeared = false;
    let appearedKind = "unknown";
    try {
      const raceStat = fs.lstatSync(configPath);
      appeared = true;
      if (raceStat.isFile()) appearedKind = "regular file";
      else if (raceStat.isSymbolicLink()) appearedKind = "symlink";
      else if (raceStat.isDirectory()) appearedKind = "directory";
      else appearedKind = describeStatKind(raceStat);
    } catch (e: any) {
      if (e && e.code !== "ENOENT") {
        return {
          outcome: "fail",
          summary: `codex MCP install refused: first-time-install race-guard lstat failed (${(e as Error).message}). No backup was taken because the config was absent at Stage 2.`,
        };
      }
    }
    if (appeared) {
      return {
        outcome: "fail",
        summary: `codex MCP install refused: first-time-install race — ${configPath} appeared as a ${appearedKind} between the backup decision (file was absent) and the merge write, but no backup was taken. Refusing to overwrite bytes this run did not read or merge. Re-run the install; the next run will take a backup before writing.`,
      };
    }
  }

  // Stage 8: atomic write-tmp + rename. writeFileNoFollowExclusive
  // refuses if the tmp path exists (a pre-planted symlink there is
  // refused with EEXIST/ELOOP); `fs.renameSync` replaces the
  // target entry (does NOT follow a symlink at the destination).
  try {
    const tmp = configPath + ".merge.tmp";
    writeFileNoFollowExclusive(tmp, Buffer.from(mergeResult.output, "utf8"));
    fs.renameSync(tmp, configPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex MCP merge write FAILED: ${(e as Error).message}. Backup at ${backup.backup_path ?? "(none, first-time install)"}.`,
    };
  }

  const buildNote = build.skipped
    ? " Build: skipped (env override)."
    : " Build: mcp/ rebuilt fresh from source.";
  const backupNote = backup.backup_path
    ? `Pre-write backup: ${backup.backup_path}. Rollback via the mcp_rollback_codex action.`
    : "No pre-existing config — first-time install; no backup written (rollback has no artifact to restore; manual reverse: `rm ~/.codex/config.toml`).";
  const firstTimeNote = mergeResult.first_time_section
    ? " First-time verity-one section — appended at EOF; unrelated sections preserved."
    : " Replaced existing verity-one section; unrelated sections, comments, and ordering preserved byte-for-byte.";
  const nextSteps =
    "Next: restart Codex so it re-reads the config, run a verity-one tool once in the app to prove end-to-end, then record acceptance via `acceptance_record_codex` (the dashboard does not claim `enabled` until the acceptance artifact is updated).";
  return {
    outcome: "pass",
    summary: `codex MCP ${params.force ? "repair (force)" : "install"} ok: ${configPath} now has [mcp_servers.verity-one].${buildNote} ${backupNote}${firstTimeNote} ${nextSteps}`,
  };
}

/** Test-injectable override surface for the Codex MCP rollback
 *  strategy. Mirrors `ClaudeDesktopRollbackDeps` — two TOCTOU
 *  regression hooks + a candidate/config path override. */
export interface CodexMcpRollbackDeps {
  configPathOverride?: string;
  now?: Date;
  /** Fires AFTER initial validation + candidate selection, BEFORE
   *  the pre-safety-backup re-validation. */
  __testOnly_preMutationHook?: () => void | Promise<void>;
  /** Fires AFTER the last mid-run re-validation, BEFORE the
   *  immediately-pre-read + immediately-pre-write revalidations. */
  __testOnly_preWriteHook?: () => void | Promise<void>;
}

/** Restore the latest eligible `.bak.<UTC-stamp>` sibling of the
 *  Codex MCP config. Takes a fresh safety backup of the CURRENT
 *  config first so the rollback is itself reversible. Same
 *  hardening posture as `runClaudeDesktopRollback`. Refuses when
 *  no eligible backup exists — the runner will NOT delete the
 *  current config or synthesize an empty-file undo. */
export async function runCodexMcpRollback(
  deps: CodexMcpRollbackDeps = {},
): Promise<StrategyResult> {
  const configPath = deps.configPathOverride ?? resolveCodexMcpConfigPath();

  // Stage 0: initial path-safety check.
  const safety0 = validateCodexMcpConfigPath(configPath);
  if (!safety0.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused: ${safety0.reason}`,
    };
  }
  const latestBackup = findLatestCodexMcpBackup(configPath, deps.now);
  if (!latestBackup) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused: no eligible .bak.* sibling of ${configPath} found on disk. Eligibility = exact \`.bak.<8digit>-<6digit>-<3digit>\` stamp + real UTC instant in the past (+ 5-min skew) + regular file. NO backup ⇒ NO rollback — the runner will NOT delete the current config or synthesize an empty-file undo. Run an install or repair action first. Hand-created files at the same exact stamp shape are also eligible — eligibility does not prove runner provenance.`,
    };
  }

  if (deps.__testOnly_preMutationHook) {
    await deps.__testOnly_preMutationHook();
  }

  // Stage 1: RE-VALIDATE path-safety before the safety backup.
  const safety1 = validateCodexMcpConfigPath(configPath);
  if (!safety1.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused at re-validation (TOCTOU guard, pre-safety-backup): ${safety1.reason}`,
    };
  }

  // Stage 2: safety backup of current state.
  const safetyBackup = takeCodexMcpBackup(configPath, deps.now);
  if (!safetyBackup.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback aborted: could not take a safety backup of the current config (${safetyBackup.reason ?? "unknown"}). Refusing to overwrite without an undo path.`,
    };
  }

  // Stage 3: RE-VALIDATE path-safety before the restore read.
  const safety2 = validateCodexMcpConfigPath(configPath);
  if (!safety2.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused at re-validation (TOCTOU guard, pre-restore-read): ${safety2.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  if (deps.__testOnly_preWriteHook) {
    await deps.__testOnly_preWriteHook();
  }

  // Stage 4: IMMEDIATELY-PRE-READ re-validation. `O_NOFOLLOW`
  // protects only the FINAL path component of the candidate; a
  // parent-dir swap between Stage 3 and the readFileNoFollow below
  // would let us open a regular file in the decoy tree at the same
  // candidate name.
  const safety3 = validateCodexMcpConfigPath(configPath);
  if (!safety3.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused at immediately-pre-read re-validation (parent-dir TOCTOU guard): ${safety3.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 5: read candidate bytes via `readFileNoFollow`.
  let restoredBytes: Buffer;
  try {
    restoredBytes = readFileNoFollow(latestBackup);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused at candidate read (TOCTOU guard, post-selection): ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 6: IMMEDIATELY-PRE-WRITE re-validation.
  const safety4 = validateCodexMcpConfigPath(configPath);
  if (!safety4.ok) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback refused at immediately-pre-write re-validation (parent-dir TOCTOU guard): ${safety4.reason}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }

  // Stage 7: atomic restore — write tmp, rename into place.
  try {
    const tmp = configPath + ".restore.tmp";
    writeFileNoFollowExclusive(tmp, restoredBytes);
    fs.renameSync(tmp, configPath);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `codex MCP rollback write FAILED: ${(e as Error).message}. Safety backup at ${safetyBackup.backup_path ?? "(none)"}.`,
    };
  }
  const safetyNote = safetyBackup.backup_path
    ? `Safety backup of pre-rollback state: ${safetyBackup.backup_path}.`
    : "Current config was absent — no safety backup was needed.";
  return {
    outcome: "pass",
    summary: `codex MCP rollback ok: restored ${latestBackup} over ${configPath}. ${safetyNote} Restart Codex so it re-reads the restored config.`,
  };
}

// ─── Acceptance recorder (artifact_write) ────────────────────────
//
// The operator has already restarted the client and observed ONE
// real MCP tool or resource call. These actions UPSERT that
// attestation into the gitignored artifact at
// `<repo>/agent-lab/proof/vo-mcp-client-acceptance/result.json`.
// No Skill install, no Codex TOML merge, no hosted proof run.
//
// Validation flow (preview + execute):
//   1. Typed args validated by `validateActionRequest` already
//      rejects unknown fields + wrong types at the basic level.
//   2. `validateAcceptanceArgs` does the semantic layer:
//        - status ∈ {pass, fail}
//        - free-text fields non-empty, trimmed
//        - free-text fields secret-scanned (refuse, no redact)
//        - pass requires BOTH doctor booleans === true
//   3. Preview mints a token. Execute consumes it. Execute re-
//      runs the same semantic layer (defense in depth) in case
//      args were tampered with between preview and execute.

export interface ValidatedAcceptanceArgs {
  status: ClientAcceptanceStatus;
  observed_tool_or_resource: string;
  operator_summary: string;
  observed_result_summary: string;
  config_doctor_ran: boolean;
  live_doctor_ran: boolean;
  /** Rung 11 — normalized Skill-observation attestation.
   *  `undefined` when the operator did not supply the optional
   *  field. Pairs with `skill_observed_note` via the coherence
   *  check below. */
  skill_observed?: boolean;
  /** Rung 11 — trimmed operator note naming the observed
   *  Skill-specific behavior. Undefined when not supplied;
   *  required (non-empty after trim) when
   *  `skill_observed === true`. */
  skill_observed_note?: string;
}

export function validateAcceptanceArgs(
  args: Record<string, unknown>,
): { ok: true; value: ValidatedAcceptanceArgs } | { ok: false; reason: string } {
  const rawStatus = args.status;
  if (
    typeof rawStatus !== "string" ||
    !(CLIENT_ACCEPTANCE_STATUSES as readonly string[]).includes(rawStatus)
  ) {
    return {
      ok: false,
      reason: `status must be one of ${CLIENT_ACCEPTANCE_STATUSES.join(" | ")}; got ${JSON.stringify(rawStatus)}`,
    };
  }
  for (const field of ["observed_tool_or_resource", "operator_summary", "observed_result_summary"] as const) {
    const v = args[field];
    if (typeof v !== "string" || v.trim() === "") {
      return {
        ok: false,
        reason: `${field} must be a non-empty string`,
      };
    }
    const sanitized = sanitizeInputStrict(v);
    if (!sanitized.ok) {
      return {
        ok: false,
        reason: `${field} contains a secret-shaped pattern (${sanitized.name}); refusing to accept. Remove the pasted token and try again.`,
      };
    }
  }
  for (const field of ["config_doctor_ran", "live_doctor_ran"] as const) {
    if (typeof args[field] !== "boolean") {
      return {
        ok: false,
        reason: `${field} must be a boolean (true|false); got ${JSON.stringify(args[field])}`,
      };
    }
  }
  const status = rawStatus as ClientAcceptanceStatus;
  const config_doctor_ran = args.config_doctor_ran as boolean;
  const live_doctor_ran = args.live_doctor_ran as boolean;
  // Pass requires BOTH doctor flags. `fail` is honest even
  // when either flag is false (incomplete activation).
  if (status === "pass" && (!config_doctor_ran || !live_doctor_ran)) {
    return {
      ok: false,
      reason:
        "status=pass requires BOTH config_doctor_ran and live_doctor_ran to be true. If either doctor has not been run, record the result as fail (honest incomplete activation) and run the doctors first.",
    };
  }

  // Rung 11 — Skill-lifecycle discriminator (optional).
  // Normalize + validate the pair. The ArgsFieldType validator
  // has already confirmed `skill_observed` is a boolean when
  // present and `skill_observed_note` is a string when present;
  // the semantic gates below enforce coherence + secret
  // hygiene.
  let skill_observed: boolean | undefined;
  let skill_observed_note: string | undefined;
  if ("skill_observed" in args) {
    skill_observed = args.skill_observed as boolean;
  }
  if ("skill_observed_note" in args) {
    const raw = args.skill_observed_note as string;
    const trimmed = raw.trim();
    if (trimmed !== "") {
      const sanitized = sanitizeInputStrict(raw);
      if (!sanitized.ok) {
        return {
          ok: false,
          reason: `skill_observed_note contains a secret-shaped pattern (${sanitized.name}); refusing to accept. Remove the pasted token and try again.`,
        };
      }
      skill_observed_note = trimmed;
    }
  }
  if (skill_observed === true) {
    if (!skill_observed_note) {
      return {
        ok: false,
        reason:
          "skill_observed=true requires a non-empty skill_observed_note naming the Skill-specific behavior the operator observed (e.g. 'agent referenced vo_memory_recall per the Skill's decision-capture guidance').",
      };
    }
  }
  if (skill_observed === undefined && skill_observed_note) {
    return {
      ok: false,
      reason:
        "skill_observed_note requires skill_observed to be present. Set skill_observed=true when the Skill was observed, or skill_observed=false when the note records a negative Skill observation.",
    };
  }

  return {
    ok: true,
    value: {
      status,
      observed_tool_or_resource: (args.observed_tool_or_resource as string).trim(),
      operator_summary: (args.operator_summary as string).trim(),
      observed_result_summary: (args.observed_result_summary as string).trim(),
      config_doctor_ran,
      live_doctor_ran,
      skill_observed,
      skill_observed_note,
    },
  };
}

/** Preview extras for the two recorder descriptors. The output-
 *  path disclosure is static (the writer hardcodes it under
 *  agent-lab/proof/vo-mcp-client-acceptance/), but freshness of
 *  an existing artifact + any current cell for this client is
 *  resolved at preview time so the operator sees what would be
 *  upserted. */
function buildAcceptancePreviewExtras(client: ClientAcceptanceClient): {
  mutates: readonly string[];
  touched_config_path: string;
  backup_note: string;
  change_note: string;
  extra_notes: readonly string[];
  current_entry_json: string | null;
  path_safety: { ok: true; realpath: null };
} {
  let repoRoot = "<repo>";
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    // Stay honest; if we can't resolve, the execute path will
    // refuse and the operator sees that refusal at run time.
  }
  const outDir = clientAcceptanceArtifactOutDir(repoRoot);
  const jsonPath = path.join(outDir, "result.json");
  const mdPath = path.join(outDir, "result.md");
  // Read current artifact to surface the existing cell for this
  // client (if any) so the operator sees what will be replaced.
  let existingCellJson: string | null = null;
  let artifactKindNote = "no existing artifact yet — a new one will be created";
  try {
    const read = readAcceptanceArtifact(repoRoot);
    if (read.kind === "ok" || read.kind === "stale") {
      const cell = read.artifact.cells.find((c) => c.client === client);
      if (cell) {
        existingCellJson = redactOutput(JSON.stringify(cell, null, 2));
        artifactKindNote = `${read.kind}; existing cell for ${client} will be REPLACED (prior value shown in current_entry_json)`;
      } else {
        artifactKindNote = `${read.kind}; no prior cell for ${client} yet — a new cell will be added`;
      }
    } else if (read.kind === "malformed") {
      artifactKindNote = `existing artifact is malformed (${read.error}); execute will refuse rather than overwrite a malformed file`;
    }
  } catch {
    // ignore; execute path will surface a clean refusal.
  }
  // Peek at the most recent existing backup so the preview can
  // name one concrete previous-state artifact. Runner writes a
  // fresh `.bak.<UTC-stamp>` sibling BEFORE every upsert.
  let latestBackupNote = "";
  try {
    const latest = findLatestAcceptanceBackup(outDir);
    latestBackupNote = latest
      ? ` Most recent pre-existing backup on disk: ${latest}.`
      : "";
  } catch {
    // ignore
  }
  return {
    mutates: [jsonPath, mdPath, `${jsonPath}.bak.<UTC-stamp>`],
    touched_config_path: jsonPath,
    backup_note:
      "Before any upsert the runner copies the current `result.json` to a timestamped sibling (`result.json.bak.<UTC-stamp>`). A mistaken record is recoverable by copying that backup back in place." +
      latestBackupNote +
      " A symmetric one-click undo action is NOT in this PR's allowlist — the design doc narrows the `artifact_write` undo requirement to backup-only for gitignored evidence artifacts; a future PR may add a dashboard rollback.",
    change_note: artifactKindNote,
    extra_notes: [
      "This action does NOT run the config doctor or live doctor for you — you must have already run them manually before recording. pass REQUIRES both doctor flags to be true.",
      "This action does NOT write ~/.codex/config.toml, Claude Desktop config, ~/.vo, or any Skill directory. Artifact writes land only under the repo-local agent-lab/proof/ tree.",
      "This action does NOT call any hosted /my / remote / web MCP surface.",
      "After execute, the dashboard re-reads evidence. A fresh same-client pass with both doctor flags can promote the `mcp_connection` row to `enabled`.",
    ],
    current_entry_json: existingCellJson,
    path_safety: { ok: true as const, realpath: null },
  };
}

/** Run an acceptance upsert for the given client. Re-validates
 *  at execute time (defense in depth), reads the current
 *  artifact, upserts the cell, writes atomically. */
async function runAcceptanceRecord(
  client: ClientAcceptanceClient,
  args: Record<string, unknown>,
): Promise<StrategyResult> {
  const validated = validateAcceptanceArgs(args);
  if (!validated.ok) {
    return { outcome: "fail", summary: `recorder refused: ${validated.reason}` };
  }
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (e) {
    return {
      outcome: "fail",
      summary: `recorder refused: cannot resolve repo root (${(e as Error).message})`,
    };
  }
  const outDir = clientAcceptanceArtifactOutDir(repoRoot);
  const now = new Date();
  const cell: ClientAcceptanceCell = {
    client,
    status: validated.value.status,
    accepted_at: now.toISOString(),
    operator_summary: validated.value.operator_summary,
    observed_tool_or_resource: validated.value.observed_tool_or_resource,
    observed_result_summary: validated.value.observed_result_summary,
    config_doctor_ran: validated.value.config_doctor_ran,
    live_doctor_ran: validated.value.live_doctor_ran,
    // Rung 11 — pass through Skill-lifecycle fields when
    // supplied. Undefined fields are omitted so older artifact
    // cells stay byte-identical through no-op round-trips.
    ...(validated.value.skill_observed !== undefined
      ? { skill_observed: validated.value.skill_observed }
      : {}),
    ...(validated.value.skill_observed_note !== undefined
      ? { skill_observed_note: validated.value.skill_observed_note }
      : {}),
  };
  // Read existing; refuse to overwrite a malformed artifact.
  const read = readAcceptanceArtifact(repoRoot);
  if (read.kind === "malformed") {
    return {
      outcome: "fail",
      summary: `recorder refused: existing artifact is malformed (${read.error}). Fix or delete the file before recording; overwriting would hide a corruption.`,
    };
  }
  // Take a pre-upsert backup so a mistaken record is recoverable.
  // Atomic (write tmp + rename). Silent when the artifact does
  // not yet exist (first-time record — nothing to preserve).
  const backup = takeAcceptanceBackup(outDir, now);
  if (!backup.ok) {
    return {
      outcome: "fail",
      summary: `recorder aborted before write: ${backup.reason ?? "backup failed"}`,
    };
  }
  const existing = read.kind === "ok" || read.kind === "stale" ? read.artifact : null;
  const next = upsertCell(
    existing
      ? {
          schema: existing.schema,
          run_stamp: existing.run_stamp,
          run_finished_at: existing.run_finished_at,
          cells: existing.cells.map((c) => ({
            client: c.client as ClientAcceptanceClient,
            status: c.status as ClientAcceptanceStatus,
            accepted_at: c.accepted_at,
            operator_summary: c.operator_summary,
            observed_tool_or_resource: c.observed_tool_or_resource,
            observed_result_summary: c.observed_result_summary,
            config_doctor_ran: c.config_doctor_ran,
            live_doctor_ran: c.live_doctor_ran,
            // Rung 11 — preserve Skill-lifecycle fields from
            // the on-disk cell through the round-trip. Older
            // cells without these fields round-trip as-is.
            ...(c.skill_observed !== undefined
              ? { skill_observed: c.skill_observed }
              : {}),
            ...(c.skill_observed_note !== undefined
              ? { skill_observed_note: c.skill_observed_note }
              : {}),
          })),
          notes: existing.notes.slice(),
        }
      : null,
    cell,
    now,
  );
  try {
    writeClientAcceptanceArtifact(outDir, next);
  } catch (e) {
    return {
      outcome: "fail",
      summary: `recorder write FAILED: ${(e as Error).message}`,
    };
  }
  return {
    outcome: "pass",
    summary: `acceptance recorded: ${client} ${validated.value.status} (observed=${validated.value.observed_tool_or_resource}; config_doctor_ran=${validated.value.config_doctor_ran}; live_doctor_ran=${validated.value.live_doctor_ran}). ${
      backup.backup_path
        ? `Pre-upsert backup written to ${backup.backup_path} — manual rollback shape: cp that file back to result.json.`
        : "First-time record — no prior artifact to preserve, no backup written."
    } Dashboard evidence re-read will reflect this cell on the next refresh.`,
  };
}

// ─── Audit helpers (in-memory ring buffer) ───────────────────────

export interface AuditRecord {
  ts: string;
  action_id: string;
  tenant_id: string;
  outcome: ActionExecutionResult["outcome"] | "refused";
  duration_ms?: number;
  summary: string;
  status_after_kind?: ActionExecutionResult["status_after"] extends infer X
    ? X extends { artifact_kind: infer K }
      ? K
      : null
    : null;
}

const AUDIT: AuditRecord[] = [];
const AUDIT_CAP = 64;

export function recordAudit(r: AuditRecord): void {
  AUDIT.push(r);
  if (AUDIT.length > AUDIT_CAP) AUDIT.splice(0, AUDIT.length - AUDIT_CAP);
}
export function listAudit(): readonly AuditRecord[] {
  return AUDIT.slice();
}
export function __testOnly_clearAudit(): void {
  AUDIT.length = 0;
}
