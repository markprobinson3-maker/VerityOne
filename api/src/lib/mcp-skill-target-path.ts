/**
 * Codex VO Skill target-path contract.
 * VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1.
 *
 * Pure resolver + path-safety validator for the Codex VO Skill
 * install target. Consumed today by the three shipped Codex
 * Skill `file_mutation` descriptors — `skill_install_codex`,
 * `skill_disable_codex`, `skill_rollback_codex` — registered
 * in `api/src/lib/mcp-local-action-runner.ts` under
 * `control_scope: "vo_skill"` (landed in
 * `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`). Those descriptors
 * re-run `validateCodexSkillTargetPath` at preview time,
 * immediately before each path-based filesystem mutation, and
 * immediately pre-write as the parent-dir TOCTOU guard.
 *
 * Scope boundary: this file remains PURE. It does NO filesystem
 * writes, does NOT `mkdir`, does NOT touch `~/.codex` in any
 * way — the validator reads via `lstat` / `realpathSync` only.
 * All writes (backup, copy, rename, restore) live in the
 * runner's Skill strategies, not here. A future edit that
 * adds a write primitive to this module is a scope violation
 * and the drift guard in
 * `agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`
 * catches it.
 *
 * Claude Desktop Skill target path ships in a SEPARATE module
 * (`./mcp-claude-desktop-skill-target-path.ts`) under a
 * VO-provisional pin — not an Anthropic-authoritative path —
 * via `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`. The Claude-side
 * resolver REUSES the ancestor-walk
 * (`findSuspiciousAncestorSymlink`) exported from this module
 * so both client resolvers share one walk implementation. The
 * `skill_*_claude_desktop` ACTION descriptors (install /
 * disable / rollback) SHIP in
 * `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` and consume the
 * Claude Desktop target-path module at preview + execute time.
 *
 * Precedence:
 *   1. `CODEX_HOME` env var (absolute path) → overrides
 *      `<home>/.codex`.
 *   2. `<live HOME>/.codex` (fallback; `process.env.HOME`
 *      wins over Bun's cached `os.homedir()`, matching the
 *      shipped Codex MCP config resolver / dashboard runner
 *      convention).
 *
 * Platform-agnostic. Codex uses the same `.codex` directory
 * shape across macOS / Linux / Windows per the existing MCP
 * config path helper.
 *
 * Single-Skill scope:
 *   - Source (authority): `mcp/skills/verity-one-mcp/SKILL.md`.
 *   - Target file: `<skillsRoot>/verity-one-mcp/SKILL.md`.
 *
 * The target is a **single file** — not a directory wipe. The
 * shipped `skill_install_codex` action writes ONE `SKILL.md`;
 * `skill_disable_codex` renames that file to a timestamped
 * `.disabled` sibling (rename-only, never deletes);
 * `skill_rollback_codex` restores the latest valid timestamped
 * sibling. Unrelated Codex Skills are never touched. Same
 * destruction-refusal posture the design doc pins.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runtime-resolved pieces of the Codex Skill target path. Every
 *  Skill action uses the three-level breakdown (root → per-Skill
 *  dir → file) so the validator can scope-check separately. */
export interface CodexSkillTargetPath {
  /** Codex home directory (contains `config.toml`, `skills/`,
   *  etc.). Used as the anchor for path-safety equality checks. */
  codexHome: string;
  /** Directory that holds all Codex Skills. The "accepted parent"
   *  for path-safety: the validator requires this exact absolute
   *  path, with no symlink ancestors. */
  skillsRoot: string;
  /** Per-Skill subdirectory for the VO Skill under the Skills
   *  root. The shipped `skill_install_codex` action creates this
   *  directory only if the parent (`skillsRoot`) exists. */
  skillDir: string;
  /** Absolute path to the `SKILL.md` file the shipped Skill
   *  actions operate on. This is the ONLY file they may write;
   *  `skill_disable_codex` renames this file to a timestamped
   *  `.disabled` sibling, `skill_rollback_codex` restores from
   *  a timestamped sibling back onto this path. */
  skillFile: string;
}

export interface CodexSkillResolverDeps {
  /** Injected homedir. Defaults to the live-HOME-aware helper
   *  (`process.env.HOME` > `os.homedir()`) for production.
   *  Tests pass a tmpdir-scoped value to exercise the validator
   *  without touching the real `~/.codex`. */
  home?: string;
  /** Env bag. The resolver honors `CODEX_HOME` (absolute path)
   *  per the Codex CLI's own convention. */
  env?: NodeJS.ProcessEnv;
}

/** Pure resolver. Returns the four path pieces. Does NOT touch
 *  the filesystem; call `validateCodexSkillTargetPath` next for
 *  realpath + symlink + scope checks. */
export function resolveCodexSkillTargetPath(
  deps: CodexSkillResolverDeps = {},
): CodexSkillTargetPath {
  const env = deps.env ?? process.env;
  const home = deps.home ?? codexHomeDir(env);
  const codexHome = resolveCodexHome(home, env);
  const skillsRoot = path.join(codexHome, "skills");
  const skillDir = path.join(skillsRoot, "verity-one-mcp");
  const skillFile = path.join(skillDir, "SKILL.md");
  return { codexHome, skillsRoot, skillDir, skillFile };
}

/** Resolve the tenant's HOME directory at call time, preferring
 *  live `process.env.HOME` over `os.homedir()`. Bun caches
 *  `os.homedir()` at startup, so long-lived dashboard processes
 *  must follow the operator's live HOME override when deriving
 *  `<home>/.codex` (unless CODEX_HOME is set). Mirrors
 *  `mcp/src/codex-mcp-config-path.ts::codexHomeDir`. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const live = env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

/** Codex home dir. `CODEX_HOME` wins when set to an absolute path;
 *  otherwise `<home>/.codex`. Callers that do not inject `home`
 *  should obtain it via `codexHomeDir()` so api + mcp package
 *  consumers share CODEX_HOME > live HOME precedence. */
export function resolveCodexHome(
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const override = env.CODEX_HOME;
  if (override && override.trim() && path.isAbsolute(override.trim())) {
    return override.trim();
  }
  return path.join(home, ".codex");
}

// ─── Path-safety validator ───────────────────────────────────────

export type CodexSkillPathSafetyResult =
  | {
      ok: true;
      target: CodexSkillTargetPath;
      skillsRootRealpath: string;
      /** Informational: true when an existing SKILL.md is already
       *  present at the target. The shipped Skill action
       *  `resolvePreviewExtras` hooks use this to show "install
       *  would overwrite" in the preview. */
      existingSkillFile: boolean;
    }
  | { ok: false; target: CodexSkillTargetPath; reason: string };

/** Pure read-only path-safety check. Refuses:
 *
 *    - relative / non-absolute codexHome or skillsRoot,
 *    - missing `skillsRoot` parent (do NOT auto-create),
 *    - direct symlink at `codexHome`, `skillsRoot`,
 *      `skillDir`, or `skillFile` (refused at each level
 *      via `lstat`),
 *    - non-directory at `codexHome` or `skillsRoot`,
 *    - any symlinked ANCESTOR of `skillsRoot` —
 *      `findSuspiciousAncestorSymlink` walks parent-by-parent
 *      up to the filesystem root, skipping a small allowlist
 *      of legitimate platform-level OS symlinks (`/var`,
 *      `/tmp`, `/etc` on macOS). This catches the
 *      `CODEX_HOME=<root>/link/codex` shape where `<root>/link`
 *      is an operator-created symlink — `lstat` on the
 *      literal `skillsRoot` alone does NOT catch it because
 *      intermediate symlinks are followed implicitly,
 *    - skillDir existing as a non-directory,
 *    - skillFile existing as a non-regular-file.
 *
 *  `realpathSync(skillsRoot)` IS called, but its result is
 *  INFORMATIONAL ONLY — surfaced as `skillsRootRealpath` in
 *  the result so the preview can show the resolved path. It
 *  is NOT used as a scope gate. The retired
 *  `rootReal === skillsRoot` (equality) / `basename(skillsRoot)
 *  === 'skills'` (suffix) fences were replaced by the explicit
 *  ancestor walk; do not reintroduce them in any future edit.
 *
 *  Never writes, never creates, never follows a symlink.
 *
 *  How the shipped `skill_install_codex` / `skill_disable_codex`
 *  / `skill_rollback_codex` actions consume this validator:
 *    1. Each descriptor's `resolvePreviewExtras` hook calls the
 *       validator at preview time; `{ ok: false, reason }`
 *       surfaces via `path_safety` on the preview card and the
 *       Confirm button renders disabled.
 *    2. Each strategy re-runs the validator at multiple points
 *       (pre-backup, pre-write, immediately-pre-write) so a
 *       TOCTOU swap between preview and execute is caught.
 *    3. The install strategy NEVER auto-creates `skillsRoot`;
 *       if the operator has not yet installed / configured
 *       Codex such that a Skills directory exists, the action
 *       refuses and the preview message surfaces the refusal. */
export function validateCodexSkillTargetPath(
  deps: CodexSkillResolverDeps = {},
): CodexSkillPathSafetyResult {
  const target = resolveCodexSkillTargetPath(deps);
  if (!path.isAbsolute(target.codexHome)) {
    return {
      ok: false,
      target,
      reason: `resolved Codex home ${target.codexHome} is not absolute; refusing to act`,
    };
  }
  // codexHome must exist as a regular directory + not a symlink.
  const homeCheck = checkDirExistsAndNotSymlink(target.codexHome, "Codex home");
  if (!homeCheck.ok) return { ok: false, target, reason: homeCheck.reason };

  // skillsRoot: must exist. Missing parent refuses (do NOT auto-
  // create). Must not itself be a symlink, and no operator-
  // created symlinked ancestor may divert writes (enforced via
  // the explicit ancestor walk below — NOT via realpath
  // equality; `realpathSync` is surfaced informationally only).
  const rootLstat = lstatOrNull(target.skillsRoot);
  if (!rootLstat) {
    return {
      ok: false,
      target,
      reason:
        `Codex Skills directory ${target.skillsRoot} does not exist. ` +
        `The action does NOT auto-create this directory — create it yourself (or let Codex create it on first-run), then retry. ` +
        `If you have CODEX_HOME set, the Skills directory under that root is what's missing.`,
    };
  }
  if (rootLstat.isSymbolicLink()) {
    return {
      ok: false,
      target,
      reason:
        `Codex Skills directory ${target.skillsRoot} is a symlink. ` +
        `The runner refuses to write through symlinks to avoid redirecting the operator-visible path to an unexpected tree. ` +
        `Remove or inline the symlink and retry.`,
    };
  }
  if (!rootLstat.isDirectory()) {
    return {
      ok: false,
      target,
      reason: `Codex Skills path ${target.skillsRoot} exists but is not a directory; refusing to act`,
    };
  }
  // Explicit ancestor-symlink walk. The lstat checks above
  // catch direct symlinks at `codexHome` and `skillsRoot`, but
  // a symlinked ANCESTOR (e.g. `CODEX_HOME=/tmp/link/codex`
  // where `/tmp/link → /tmp/other`) would still pass those
  // checks because lstat on `/tmp/link/codex` follows the
  // intermediate symlink implicitly. Walk every ancestor of
  // `skillsRoot` from its parent up to the filesystem root and
  // refuse at the first symlink we find — EXCEPT for a small
  // allowlist of known platform-level system symlinks (macOS
  // `/var` → `/private/var`, `/tmp`, `/etc`) which are
  // legitimate OS-level redirects and stopping points.
  const sym = findSuspiciousAncestorSymlink(target.skillsRoot);
  if (sym) {
    return {
      ok: false,
      target,
      reason:
        `Ancestor ${sym} of the Codex Skills directory ${target.skillsRoot} is a symlink. ` +
        `The runner refuses to write through a symlinked ancestor to avoid redirecting the operator-visible path (${target.skillsRoot}) to an unexpected physical tree. ` +
        `Remove or inline the symlink and retry.`,
    };
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(target.skillsRoot);
  } catch (e) {
    return {
      ok: false,
      target,
      reason: `realpath(skillsRoot=${target.skillsRoot}) failed: ${(e as Error).message}`,
    };
  }

  // skillDir (per-Skill dir): may not exist (first-time install)
  // or may exist as a regular directory. Symlink here is refused.
  const dirLstat = lstatOrNull(target.skillDir);
  if (dirLstat) {
    if (dirLstat.isSymbolicLink()) {
      return {
        ok: false,
        target,
        reason: `Codex Skill directory ${target.skillDir} is a symlink; refusing`,
      };
    }
    if (!dirLstat.isDirectory()) {
      return {
        ok: false,
        target,
        reason: `Codex Skill path ${target.skillDir} exists but is not a directory; refusing`,
      };
    }
  }

  // skillFile: may not exist (first-time install) or exist as
  // a regular file. Symlink here is refused.
  let existingSkillFile = false;
  const fileLstat = lstatOrNull(target.skillFile);
  if (fileLstat) {
    if (fileLstat.isSymbolicLink()) {
      return {
        ok: false,
        target,
        reason:
          `Codex Skill file ${target.skillFile} is a symlink; refusing. ` +
          `Remove the symlink and retry; the action will not follow it.`,
      };
    }
    if (!fileLstat.isFile()) {
      return {
        ok: false,
        target,
        reason: `Codex Skill path ${target.skillFile} exists but is not a regular file; refusing`,
      };
    }
    existingSkillFile = true;
  }

  return {
    ok: true,
    target,
    skillsRootRealpath: rootReal,
    existingSkillFile,
  };
}

// ─── Small helpers ───────────────────────────────────────────────

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Platform-level system symlinks that are legitimate OS-level
 *  redirects (not operator-supplied). The ancestor walk stops
 *  here — on macOS, `os.tmpdir()` typically returns a path under
 *  `/var/folders/...` and `/var` itself is a symlink to
 *  `/private/var`; refusing on that would block every
 *  tmpdir-scoped call. These paths are fixed OS installs, not
 *  surfaces the operator controls. */
const PLATFORM_SYSTEM_SYMLINKS: ReadonlySet<string> =
  process.platform === "darwin"
    ? new Set(["/var", "/tmp", "/etc"])
    : new Set<string>();

/** Walk every ancestor of `absPath` (starting at its parent, up
 *  to the filesystem root) and return the first one that is a
 *  symlink the operator would have created. Platform system
 *  symlinks in `PLATFORM_SYSTEM_SYMLINKS` are skipped. Returns
 *  `null` when no suspicious ancestor symlink is found. */
export function findSuspiciousAncestorSymlink(absPath: string): string | null {
  let current = path.dirname(absPath);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    if (PLATFORM_SYSTEM_SYMLINKS.has(current)) {
      return null;
    }
    const st = lstatOrNull(current);
    if (st && st.isSymbolicLink()) {
      return current;
    }
    current = parent;
  }
}

function checkDirExistsAndNotSymlink(
  absPath: string,
  label: string,
): { ok: true } | { ok: false; reason: string } {
  const st = lstatOrNull(absPath);
  if (!st) {
    return {
      ok: false,
      reason:
        `${label} ${absPath} does not exist. Create or configure Codex first; the action does not auto-create this directory.`,
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      reason: `${label} ${absPath} is a symlink; refusing to act`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      reason: `${label} ${absPath} exists but is not a directory; refusing`,
    };
  }
  return { ok: true };
}

// ─── Source path constant ────────────────────────────────────────

/** Authoritative repo-local Skill source path. The shipped
 *  `skill_install_codex` strategy copies from
 *  `<repoRoot>/<CODEX_SKILL_SOURCE_REL_PATH>` to the resolved
 *  target `skillFile`. No other source is allowed. */
export const CODEX_SKILL_SOURCE_REL_PATH =
  "mcp/skills/verity-one-mcp/SKILL.md";
