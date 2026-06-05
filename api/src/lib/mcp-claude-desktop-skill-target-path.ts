/**
 * Claude Desktop VO Skill target-path contract —
 * VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1.
 *
 * PROVISIONAL PATH CONTRACT — the target path pinned here is
 * NOT sourced from an Anthropic-authoritative document. It is a
 * VO-owned provisional pin decided in the target-path PR to
 * unblock the pure resolver/validator shape. The
 * `skill_*_claude_desktop` action descriptors (install / disable /
 * rollback) SHIP in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`
 * and consume this module at preview + execute time. If Anthropic later
 * publishes the authoritative writable Skills directory and it
 * differs from the path below, this module updates in lockstep;
 * the drift guard in
 * `agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`
 * catches divergence.
 *
 * Provisional pin — darwin only (the only platform the
 * contract names today):
 *
 *     ~/Library/Application Support/Claude/AgentSkills/
 *         verity-one-mcp/SKILL.md
 *
 * The directory parent (`.../Claude/AgentSkills/`) mirrors the
 * existing `resolveClaudeDesktopConfigPath` platform-anchor
 * pattern (which pins Claude Desktop's JSON config under
 * `~/Library/Application Support/Claude/`); the `AgentSkills`
 * subdirectory is VO-provisional.
 *
 * Non-darwin platforms are NOT pinned by this contract. The
 * validator refuses on win32 / linux with `{ ok: false, reason }`
 * that names the provisional-platform scope. A later PR that
 * extends coverage to additional platforms MUST update this
 * module + the drift guards in lockstep.
 *
 * Scope boundary: this file is PURE. It does NO filesystem
 * writes, does NOT `mkdir`, does NOT copy / rename / delete.
 * The validator reads via `lstat` / `realpathSync` only. All
 * writes live in the runner's Claude Desktop Skill strategies,
 * not here. A future edit that adds a write primitive to this
 * module is a scope violation and the drift guard catches it.
 *
 * Single-Skill scope — identical to the Codex Skill resolver
 * (`mcp-skill-target-path.ts`):
 *   - Source (authority): `mcp/skills/verity-one-mcp/SKILL.md`.
 *   - Target file: `<skillsRoot>/verity-one-mcp/SKILL.md`.
 *
 * The Codex Skill resolver provided the template for every
 * path-safety check here (direct-symlink refusal, suspicious-
 * ancestor walk, kind checks, informational-only `realpath`);
 * the Codex module's invariants apply here too. Where this
 * module diverges from the Codex resolver, it's platform-
 * driven: Codex is platform-agnostic (same `.codex` layout
 * everywhere); Claude Desktop is platform-anchored (the
 * provisional pin names only macOS today).
 *
 * Shipped consumers in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`:
 *   - `skill_install_claude_desktop`
 *   - `skill_disable_claude_desktop`
 *   - `skill_rollback_claude_desktop`
 * These descriptors and dashboard buttons live in the local
 * action runner, not in this pure resolver. This module still does
 * no filesystem writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findSuspiciousAncestorSymlink } from "./mcp-skill-target-path";

/** Runtime-resolved pieces of the Claude Desktop Skill target
 *  path. Mirrors `CodexSkillTargetPath`'s three-level breakdown
 *  (anchor root → per-Skill dir → file) so the validator can
 *  scope-check each level separately and the shipped Skill
 *  actions can reuse the same discipline. */
export interface ClaudeDesktopSkillTargetPath {
  /** Claude Desktop's platform-anchored home directory — the
   *  parent of the AgentSkills directory AND the Claude Desktop
   *  JSON config file. On darwin: `<home>/Library/Application
   *  Support/Claude`. Used as the validator's anchor for
   *  kind checks + ancestor-walk start. */
  claudeDesktopHome: string;
  /** Directory that holds all Claude Desktop AgentSkills. The
   *  "accepted parent" for path-safety; validator requires this
   *  exact absolute path, with no symlink ancestors. On darwin:
   *  `<claudeDesktopHome>/AgentSkills`. */
  skillsRoot: string;
  /** Per-Skill subdirectory for the VO Skill under the Skills
   *  root. The shipped `skill_install_claude_desktop` action
   *  creates this directory ONLY if the parent
   *  (`skillsRoot`) exists — never auto-create the AgentSkills
   *  parent itself. */
  skillDir: string;
  /** Absolute path to the `SKILL.md` file the shipped Claude
   *  Desktop Skill actions operate on. Single file scope
   *  — same discipline as the Codex Skill side. */
  skillFile: string;
}

export interface ClaudeDesktopSkillResolverDeps {
  /** Injected homedir. Defaults to the live-HOME-aware helper
   *  (`process.env.HOME` > `os.homedir()`) for production — see
   *  `claudeDesktopHomeDir` below. Tests pass a tmpdir-scoped
   *  value directly to exercise the validator without touching
   *  the real `~/Library/Application Support/Claude`. */
  home?: string;
  /** Injected env bag. Defaults to `process.env` for production.
   *  Consumed ONLY by the default-home resolution path to read
   *  live `HOME` — matches the Claude Desktop MCP config helpers
   *  (`claudeDesktopHomeDir` in `mcp-local-action-runner.ts`,
   *  `homeDir` in `mcp/src/install.ts`) so the dashboard
   *  preview + shipped Claude Desktop Skill actions see the
   *  same home the operator's shell has. */
  env?: NodeJS.ProcessEnv;
  /** Injected platform. Defaults to `process.platform` for
   *  production. Tests override to exercise the non-darwin
   *  refusal branch without running under the real OS. */
  platform?: NodeJS.Platform;
}

/** Resolve the tenant's HOME directory at call time, preferring
 *  live `process.env.HOME` over `os.homedir()`. Bun (unlike
 *  Node) caches `os.homedir()` at startup, so any process that
 *  receives a HOME change between module import and resolver
 *  call — including tests that mutate `process.env.HOME` — must
 *  see the live value. Mirrors
 *  `api/src/lib/mcp-local-action-runner.ts::claudeDesktopHomeDir`
 *  and `mcp/src/install.ts::homeDir` byte-for-byte in behavior
 *  (reviewer P2: the Claude Desktop Skill resolver must honor
 *  the same live-HOME rule the shipped Claude Desktop MCP
 *  helpers already do — otherwise the shipped Skill actions
 *  would resolve the provisional target under the cached
 *  homedir while the live installer writes under the operator's
 *  shell HOME). `os.homedir()` fallback covers Windows /
 *  non-POSIX where `$HOME` may not be set. */
export function claudeDesktopHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const live = env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

/** Pure resolver. Always returns the four path pieces using the
 *  provisional darwin layout; validator does the platform-
 *  scope refusal when the injected platform is not `"darwin"`.
 *  The resolver stays pure (path arithmetic only) so tests can
 *  exercise structure independently of filesystem state.
 *
 *  Non-darwin callers get a structural target that points at
 *  the macOS-layout path under their home; the validator
 *  catches + refuses that branch before any lstat runs.
 *
 *  HOME resolution uses the live-HOME-aware
 *  `claudeDesktopHomeDir` helper by default — explicit
 *  `deps.home` overrides it (the path that tests prefer). */
export function resolveClaudeDesktopSkillTargetPath(
  deps: ClaudeDesktopSkillResolverDeps = {},
): ClaudeDesktopSkillTargetPath {
  const home = deps.home ?? claudeDesktopHomeDir(deps.env ?? process.env);
  // The provisional contract names only the darwin layout. The
  // resolver arithmetic still produces a well-formed absolute
  // path for the caller's `home` on non-darwin platforms (so
  // callers can inspect the structure without crashing) — but
  // `validateClaudeDesktopSkillTargetPath` refuses the
  // non-darwin branch before touching disk.
  const claudeDesktopHome = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
  );
  const skillsRoot = path.join(claudeDesktopHome, "AgentSkills");
  const skillDir = path.join(skillsRoot, "verity-one-mcp");
  const skillFile = path.join(skillDir, "SKILL.md");
  return { claudeDesktopHome, skillsRoot, skillDir, skillFile };
}

// ─── Path-safety validator ───────────────────────────────────────

export type ClaudeDesktopSkillPathSafetyResult =
  | {
      ok: true;
      target: ClaudeDesktopSkillTargetPath;
      skillsRootRealpath: string;
      /** Informational: true when an existing SKILL.md is already
       *  present at the target. The shipped Skill actions' preview
       *  hooks use this to show "install would overwrite" — the
       *  field matches the Codex-side result shape. */
      existingSkillFile: boolean;
    }
  | {
      ok: false;
      target: ClaudeDesktopSkillTargetPath;
      reason: string;
    };

/** Pure read-only path-safety check for the Claude Desktop VO
 *  Skill target. Mirrors the refusal matrix of
 *  `validateCodexSkillTargetPath` with one additional refusal
 *  at the top: the provisional contract names only darwin, so
 *  non-darwin platforms refuse before any filesystem check.
 *
 *  Refuses:
 *    - non-darwin platform (provisional-contract scope);
 *    - relative / non-absolute claudeDesktopHome or skillsRoot;
 *    - missing `skillsRoot` (do NOT auto-create);
 *    - direct symlink at `claudeDesktopHome`, `skillsRoot`,
 *      `skillDir`, or `skillFile` (refused at each level via
 *      `lstat`);
 *    - non-directory at `claudeDesktopHome` or `skillsRoot`;
 *    - any symlinked ANCESTOR of `skillsRoot` —
 *      `findSuspiciousAncestorSymlink` (imported from the
 *      Codex Skill module) walks parent-by-parent up to the
 *      filesystem root, skipping platform system symlinks;
 *    - skillDir existing as a non-directory;
 *    - skillFile existing as a non-regular-file.
 *
 *  `realpathSync(skillsRoot)` IS called, but its result is
 *  INFORMATIONAL ONLY — surfaced as `skillsRootRealpath` in
 *  the ok-result so the shipped preview hooks can display the
 *  resolved path. It is NOT used as a scope gate. Same
 *  narrowed contract the Codex Skill side pins.
 *
 *  Never writes, never creates, never follows a symlink. */
export function validateClaudeDesktopSkillTargetPath(
  deps: ClaudeDesktopSkillResolverDeps = {},
): ClaudeDesktopSkillPathSafetyResult {
  const platform = deps.platform ?? process.platform;
  const target = resolveClaudeDesktopSkillTargetPath(deps);

  // Provisional-contract platform gate. The path pinned in this
  // PR is VO-provisional and named only for darwin. Non-darwin
  // platforms get a clean refusal naming the provisional scope
  // so the shipped Claude Desktop Skill actions refuse on any
  // platform whose target path has not been pinned.
  if (platform !== "darwin") {
    return {
      ok: false,
      target,
      reason:
        `Claude Desktop Skill target path is only provisionally pinned for darwin (macOS); this process is running on ${platform}. ` +
        `The provisional contract in VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1 names only the macOS layout (${target.skillsRoot}). ` +
        `Extending coverage to win32 / linux requires a later PR that updates this resolver + the paired drift guards in lockstep.`,
    };
  }

  if (!path.isAbsolute(target.claudeDesktopHome)) {
    return {
      ok: false,
      target,
      reason: `resolved Claude Desktop home ${target.claudeDesktopHome} is not absolute; refusing to act`,
    };
  }

  // claudeDesktopHome must exist as a regular directory + not a
  // symlink. Mirrors the Codex Skill `codexHome` check.
  const homeCheck = checkDirExistsAndNotSymlink(
    target.claudeDesktopHome,
    "Claude Desktop home",
  );
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
        `Claude Desktop AgentSkills directory ${target.skillsRoot} does not exist. ` +
        `The resolver does NOT auto-create this directory — create it yourself, then retry. ` +
        `NOTE: this path is a VO-provisional pin (not Anthropic-authoritative); if Anthropic publishes a different writable Skills directory, this module will update in lockstep.`,
    };
  }
  if (rootLstat.isSymbolicLink()) {
    return {
      ok: false,
      target,
      reason:
        `Claude Desktop AgentSkills directory ${target.skillsRoot} is a symlink. ` +
        `The resolver refuses to follow symlinks to avoid redirecting the operator-visible path to an unexpected tree. ` +
        `Remove or inline the symlink and retry.`,
    };
  }
  if (!rootLstat.isDirectory()) {
    return {
      ok: false,
      target,
      reason: `Claude Desktop AgentSkills path ${target.skillsRoot} exists but is not a directory; refusing to act`,
    };
  }

  // Explicit ancestor-symlink walk — imported from the Codex
  // Skill module so both client resolvers share one
  // implementation. The walk skips a small allowlist of known
  // platform system symlinks (macOS `/var` → `/private/var`,
  // `/tmp`, `/etc`) which are legitimate OS-level redirects.
  const sym = findSuspiciousAncestorSymlink(target.skillsRoot);
  if (sym) {
    return {
      ok: false,
      target,
      reason:
        `Ancestor ${sym} of the Claude Desktop AgentSkills directory ${target.skillsRoot} is a symlink. ` +
        `The resolver refuses to follow a symlinked ancestor to avoid redirecting the operator-visible path (${target.skillsRoot}) to an unexpected physical tree. ` +
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
        reason: `Claude Desktop VO Skill directory ${target.skillDir} is a symlink; refusing`,
      };
    }
    if (!dirLstat.isDirectory()) {
      return {
        ok: false,
        target,
        reason: `Claude Desktop VO Skill path ${target.skillDir} exists but is not a directory; refusing`,
      };
    }
  }

  // skillFile: may not exist (first-time install) or exist as a
  // regular file. Symlink here is refused.
  let existingSkillFile = false;
  const fileLstat = lstatOrNull(target.skillFile);
  if (fileLstat) {
    if (fileLstat.isSymbolicLink()) {
      return {
        ok: false,
        target,
        reason:
          `Claude Desktop VO Skill file ${target.skillFile} is a symlink; refusing. ` +
          `Remove the symlink and retry; the resolver will not follow it.`,
      };
    }
    if (!fileLstat.isFile()) {
      return {
        ok: false,
        target,
        reason: `Claude Desktop VO Skill path ${target.skillFile} exists but is not a regular file; refusing`,
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

function checkDirExistsAndNotSymlink(
  absPath: string,
  label: string,
): { ok: true } | { ok: false; reason: string } {
  const st = lstatOrNull(absPath);
  if (!st) {
    return {
      ok: false,
      reason:
        `${label} ${absPath} does not exist. Create the directory yourself; the resolver does not auto-create it.`,
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

/** Authoritative repo-local Skill source path. Identical to
 *  `CODEX_SKILL_SOURCE_REL_PATH` in `mcp-skill-target-path.ts`:
 *  both client-specific resolvers copy from the SAME repo
 *  source. Drift-guarded in the Skill-controls test file so a
 *  future edit cannot silently diverge the source authority.
 *  The shipped `skill_install_claude_desktop` strategy copies
 *  from `<repoRoot>/<CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH>`
 *  to the resolved target `skillFile`. No other source is
 *  allowed. */
export const CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH =
  "mcp/skills/verity-one-mcp/SKILL.md";
