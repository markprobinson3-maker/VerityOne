/**
 * MCP Skill filesystem checker — MCP-SKILL-CHECKER-IMPL-PR-1 (rung 10).
 *
 * Pure library module. Consumed by BOTH:
 *   - `api/src/lib/mcp-local-action-runner.ts` (wraps the helpers as
 *     `read_only` descriptors `skill_doctor_codex` /
 *     `skill_doctor_claude_desktop` for the dashboard's "run check
 *     now" button).
 *   - `api/src/lib/mcp-control-status.ts` (calls the helpers
 *     synchronously during `computeStatus` so `/mcp-controls.json`
 *     can promote `vo_skill` rows from `manual_required` to
 *     concrete states).
 *
 * Import cycle prevention (rung 9 reviewer P2 #1): this module
 * deliberately does NOT import from `mcp-local-action-runner.ts`
 * or `mcp-control-status.ts`. The runner imports from
 * control-status; if either of those imported from here AND this
 * imported back, we'd get a cycle. Instead this module duplicates
 * a handful of small filesystem primitives (readFileNoFollow,
 * describeStatKind, resolveRepoRoot, Skill stamp helpers). The
 * duplication is drift-guarded: the paired test asserts the
 * duplicated functions produce the same output as the runner's
 * exported counterparts for every input shape.
 *
 * Contract: `docs/VO-MCP-SKILL-CHECKER-DESIGN.md`. Drift from
 * that contract fails the design-drift test in
 * `agent-lab/scripts/lib/mcp-skill-checker-design.test.ts` +
 * this module's companion test in `mcp-skill-checker.test.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";

import {
  CODEX_SKILL_SOURCE_REL_PATH,
  type CodexSkillResolverDeps,
  resolveCodexSkillTargetPath,
  validateCodexSkillTargetPath,
} from "./mcp-skill-target-path";

import {
  CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH,
  type ClaudeDesktopSkillResolverDeps,
  resolveClaudeDesktopSkillTargetPath,
  validateClaudeDesktopSkillTargetPath,
} from "./mcp-claude-desktop-skill-target-path";

// ─── Checker output shape (binding — see design doc) ─────────────

/** One of the six filesystem states produced by the checker.
 *  `enabled` is NOT a checker-produced state: it stays blocked
 *  until Skill-specific operator-attestation evidence exists
 *  (rung 11). See design doc § "Separation principle". */
export type SkillDoctorState =
  | "not_installed"
  | "disabled"
  | "installed"
  | "outdated"
  | "error"
  | "manual_required";

export interface SkillDoctorOutput {
  state: SkillDoctorState;
  /** Absolute path to the target SKILL.md (always returned, even
   *  on error — callers want to see the path the checker
   *  attempted). */
  target_path: string;
  /** Absolute path to the repo source SKILL.md, or `null` when
   *  the repo root was unresolvable (triggers the
   *  `manual_required` fallback). */
  source_path: string | null;
  /** First 12 chars of sha256 of target bytes, or `null` when
   *  target is absent / disabled / refused. */
  target_hash_prefix: string | null;
  /** First 12 chars of sha256 of source bytes, or `null` when
   *  source is unresolvable. */
  source_hash_prefix: string | null;
  /** ISO-8601 UTC mtime from the same no-follow fd read that
   *  produced `target_hash_prefix`, or `null` when target is
   *  absent. */
  target_mtime: string | null;
  /** Absolute path to the most-recent eligible
   *  `SKILL.md.disabled.<stamp>` sibling, or `null` when none is
   *  present. Surfaced for operator transparency even when
   *  `SKILL.md` is also present (present beats disabled in the
   *  state rule, but the disabled sibling is still disclosed). */
  disabled_sibling_path: string | null;
  /** Human-readable one-line summary naming the check outcome.
   *  Useful as the `details` / `summary` field in the action
   *  result card and the status-row tooltip. */
  details: string;
}

// ─── Strategy deps (binding — see design doc) ────────────────────

/** Dep bag for the Codex Skill checker. Accepts the Codex-
 *  specific resolver deps for tmpdir-scoped tests. */
export interface CodexSkillDoctorDeps {
  resolverDeps?: CodexSkillResolverDeps;
  repoRootOverride?: string;
  sourcePathOverride?: string;
  now?: Date;
  /** Test-only hook fired between Stage 1 (initial
   *  path-safety) and Stage 4 (immediately-pre-read
   *  re-validation). Production code never sets this. Tests
   *  inject a parent-dir swap inside the hook to exercise the
   *  status-TOCTOU refusal. */
  __testOnly_preReadHook?: () => void | Promise<void>;
  /** Test-only hook fired after the immediately-pre-read
   *  revalidation + regular-file lstat, but immediately before
   *  the no-follow fd open. Guards the fd-bound mtime/hash
   *  contract. */
  __testOnly_preTargetOpenHook?: () => void | Promise<void>;
}

/** Dep bag for the Claude Desktop Skill checker. Accepts the
 *  Claude-Desktop-specific resolver deps (platform, home, env)
 *  for tmpdir-scoped tests. */
export interface ClaudeDesktopSkillDoctorDeps {
  resolverDeps?: ClaudeDesktopSkillResolverDeps;
  repoRootOverride?: string;
  sourcePathOverride?: string;
  now?: Date;
  /** Test-only hook — see CodexSkillDoctorDeps. */
  __testOnly_preReadHook?: () => void | Promise<void>;
  /** Test-only hook — see CodexSkillDoctorDeps. */
  __testOnly_preTargetOpenHook?: () => void | Promise<void>;
}

// ─── Stamp helpers (duplicated from runner; drift-guarded) ───────

// Matches `YYYYMMDD-HHMMSS-mmm` anchored. The runner exports
// `parseCodexSkillStamp` + `isValidCodexSkillStamp` but importing
// from the runner would create a cycle (see module header). The
// paired test asserts bit-for-bit parity with the runner's
// exported versions for every input the runner's tests exercise.
const SKILL_STAMP_REGEX =
  /^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})-([0-9]{3})$/;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Parse a `YYYYMMDD-HHMMSS-mmm` UTC stamp. Returns `null` when
 *  the regex fails OR when the components don't round-trip
 *  (e.g. month=13, day=32). */
function parseSkillStamp(stamp: string): Date | null {
  const m = SKILL_STAMP_REGEX.exec(stamp);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss, ms] = m;
  const year = Number(yyyy);
  const month = Number(mm) - 1;
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);
  const millis = Number(ms);
  const candidate = Date.UTC(year, month, day, hour, minute, second, millis);
  const d = new Date(candidate);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second ||
    d.getUTCMilliseconds() !== millis
  ) {
    return null;
  }
  return d;
}

/** True when the stamp parses to a real UTC instant AND that
 *  instant is not more than 5 minutes in the future relative to
 *  `now`. The 5-min future-skew tolerance matches the runner's
 *  rollback-candidate eligibility filter. */
function isValidSkillStamp(stamp: string, now?: Date): boolean {
  const d = parseSkillStamp(stamp);
  if (!d) return false;
  const current = now ?? new Date();
  if (d.getTime() > current.getTime() + FIVE_MINUTES_MS) return false;
  return true;
}

// ─── Filesystem primitives (duplicated; drift-guarded) ───────────

function describeStatKind(st: fs.Stats): string {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "regular file";
  if (st.isBlockDevice()) return "block device";
  if (st.isCharacterDevice()) return "character device";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  return "unknown";
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

interface NoFollowRead {
  bytes: Buffer;
  stat: fs.Stats;
}

/** O_NOFOLLOW + fstat-on-fd read. The bytes and stat come from the
 *  same opened fd so status evidence cannot report an mtime from one
 *  regular file and a hash from a later regular-file swap. */
function readFileNoFollowWithStat(abs: string): NoFollowRead {
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
    return { bytes: fs.readFileSync(fd), stat: st };
  } finally {
    fs.closeSync(fd);
  }
}

/** O_NOFOLLOW + fstat-on-fd read. Duplicated from the runner's
 *  internal helper of the same name. The paired test asserts
 *  bit-for-bit parity: both helpers refuse symlinks, non-files,
 *  and ENOENT identically. */
function readFileNoFollow(abs: string): Buffer {
  return readFileNoFollowWithStat(abs).bytes;
}

/** Walk upward from a file path looking for the `verity-one`
 *  package.json root. Duplicated from `mcp-control-status.ts`'s
 *  exported `resolveRepoRoot` — cannot import it because
 *  mcp-control-status will import from THIS module and that
 *  would cycle. The paired test asserts identical behavior for
 *  identical inputs. */
function resolveRepoRoot(fromFile: string = __filename): string {
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

// ─── Shared scan logic ───────────────────────────────────────────

/** Scan skillDir for `.disabled.<UTC-stamp>` siblings. Returns
 *  the absolute path of the most-recent eligible sibling (by
 *  stamp, not by mtime) or `null` if none exists. A sibling is
 *  eligible when:
 *    - filename matches `SKILL.md.disabled.<stamp>` exactly
 *      (no trailing `.tmp`, no prefix/suffix junk)
 *    - stamp passes `isValidSkillStamp` (real UTC + not future)
 *    - the sibling is a regular file (not a symlink — symlinks
 *      are rejected to prevent a planted-disabled-symlink attack)
 *  Non-existent or non-directory `skillDir` returns `null`. */
function findLatestDisabledSibling(
  skillDir: string,
  now?: Date,
): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillDir);
  } catch {
    return null;
  }
  const candidates: Array<{ path: string; stamp: string; date: Date }> = [];
  for (const name of entries) {
    // Strict suffix match: `SKILL.md.disabled.<stamp>` — no
    // `.tmp` suffix, no trailing junk.
    const prefix = "SKILL.md.disabled.";
    if (!name.startsWith(prefix)) continue;
    const stamp = name.slice(prefix.length);
    if (!isValidSkillStamp(stamp, now)) continue;
    const abs = path.join(skillDir, name);
    const st = lstatOrNull(abs);
    if (!st) continue;
    if (st.isSymbolicLink()) continue; // refuse symlinked siblings
    if (!st.isFile()) continue;
    const parsed = parseSkillStamp(stamp);
    if (!parsed) continue;
    candidates.push({ path: abs, stamp, date: parsed });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
  return candidates[0].path;
}

/** Hash bytes → first 12 chars of sha256 hex. */
function hashPrefix(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

// ─── Core checker (client-parameterized) ─────────────────────────

type ValidatorFn<D, R> = (deps?: D) => R;

type ResolverFn<D, R> = (deps?: D) => R;

/** Shared implementation of the 8-stage checker, parameterized by
 *  the client-specific validator + resolver. Both client entry
 *  points below (`runSkillDoctorCodex` / `runSkillDoctorClaudeDesktop`)
 *  dispatch through this function. */
async function runSkillDoctorShared<DepsBag, Validated, Resolved>(
  validator: ValidatorFn<DepsBag, Validated>,
  resolver: ResolverFn<DepsBag, Resolved>,
  deps: DepsBag | undefined,
  sourceRelPath: string,
  preReadHook: (() => void | Promise<void>) | undefined,
  preTargetOpenHook: (() => void | Promise<void>) | undefined,
  repoRootOverride: string | undefined,
  sourcePathOverride: string | undefined,
  now: Date | undefined,
): Promise<SkillDoctorOutput> {
  // Stage 1: initial path-safety check.
  const safety0 = validator(deps);
  // Both validators return `{ ok, target, ... }` with the same
  // duck-typed shape; narrow via casts locally.
  const safe0 = safety0 as unknown as {
    ok: boolean;
    target: { skillDir: string; skillFile: string };
    reason?: string;
  };

  // `target_path` is emitted even on error: callers want to know
  // what path the checker attempted. Resolve it via the pure
  // resolver (separate from validator) so we always have a path
  // string to return.
  const resolvedTarget = resolver(deps) as unknown as {
    skillDir: string;
    skillFile: string;
  };
  const targetPath = resolvedTarget.skillFile;
  const skillDir = resolvedTarget.skillDir;

  if (!safe0.ok) {
    return {
      state: "error",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: null,
      disabled_sibling_path: null,
      details: `path-safety refused: ${safe0.reason ?? "unknown reason"}`,
    };
  }

  // Stage 1b: lstat the target up-front so `target_mtime` and
  // regular-file/symlink/non-file branches are pinned BEFORE
  // the pre-read hook could perturb things. Capture the result
  // for later stages.
  const skillFileLstat = lstatOrNull(safe0.target.skillFile);
  const initialMtime = skillFileLstat
    ? skillFileLstat.mtime.toISOString()
    : null;

  // Stage 3: test-only hook. Fires between the initial
  // path-safety (stage 1) and the immediately-pre-read
  // revalidation (stage 4) so tests can inject a parent-dir
  // swap and assert the stage-4 revalidation catches it.
  if (preReadHook) {
    await preReadHook();
  }

  // Stage 4: immediately-pre-read re-validation. Catches a
  // parent-dir swap that landed after stage 1.
  const safety1 = validator(deps);
  const safe1 = safety1 as unknown as {
    ok: boolean;
    target: { skillDir: string; skillFile: string };
    reason?: string;
  };
  if (!safe1.ok) {
    return {
      state: "error",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: null,
      disabled_sibling_path: null,
      details: `refused at immediately-pre-read re-validation (status-TOCTOU guard): ${safe1.reason ?? "unknown reason"}`,
    };
  }

  // Post-revalidation lstat — refreshes the mtime from after the
  // hook landed (if the hook fired). The initial lstat from
  // stage 1b is the fallback when the pre-read lstat throws
  // (rare — the validator just passed).
  const postHookLstat = lstatOrNull(safe1.target.skillFile);

  // Disabled-sibling scan runs AFTER the pre-read revalidation
  // so a post-hook parent swap can't divert the scan into the
  // decoy tree (the validator at stage 4 catches that).
  const disabledSiblingPath = findLatestDisabledSibling(
    safe1.target.skillDir,
    now,
  );

  // Stage 5: target read. If the target is absent at this
  // point, we're in `not_installed` (or `disabled` if there's
  // an eligible disabled sibling).
  if (!postHookLstat) {
    if (disabledSiblingPath) {
      return {
        state: "disabled",
        target_path: targetPath,
        source_path: null,
        target_hash_prefix: null,
        source_hash_prefix: null,
        target_mtime: null,
        disabled_sibling_path: disabledSiblingPath,
        details: `no SKILL.md at ${targetPath}; most-recent disabled sibling is ${disabledSiblingPath}`,
      };
    }
    return {
      state: "not_installed",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: null,
      disabled_sibling_path: null,
      details: `no SKILL.md at ${targetPath} and no eligible .disabled.<stamp> sibling`,
    };
  }

  if (postHookLstat.isSymbolicLink()) {
    return {
      state: "error",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: initialMtime,
      disabled_sibling_path: disabledSiblingPath,
      details: `${targetPath} is a symlink; refusing to follow`,
    };
  }
  if (!postHookLstat.isFile()) {
    return {
      state: "error",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: initialMtime,
      disabled_sibling_path: disabledSiblingPath,
      details: `${targetPath} exists but is not a regular file (${describeStatKind(postHookLstat)})`,
    };
  }

  // Hash the target. The fd-bound helper guards against a
  // final-component symlink swap AND returns mtime from the same
  // regular file whose bytes are hashed.
  let targetBytes: Buffer;
  let targetReadStat: fs.Stats;
  try {
    if (preTargetOpenHook) {
      await preTargetOpenHook();
    }
    const targetRead = readFileNoFollowWithStat(safe1.target.skillFile);
    targetBytes = targetRead.bytes;
    targetReadStat = targetRead.stat;
  } catch (e) {
    return {
      state: "error",
      target_path: targetPath,
      source_path: null,
      target_hash_prefix: null,
      source_hash_prefix: null,
      target_mtime: postHookLstat.mtime.toISOString(),
      disabled_sibling_path: disabledSiblingPath,
      details: `read refused: ${(e as Error).message}`,
    };
  }
  const targetHash = hashPrefix(targetBytes);
  const targetMtime = targetReadStat.mtime.toISOString();

  // Stage 7: source read.
  let sourcePath: string | null;
  let sourceBytes: Buffer | null = null;
  if (sourcePathOverride) {
    sourcePath = sourcePathOverride;
  } else {
    let repoRoot: string;
    try {
      repoRoot = repoRootOverride ?? resolveRepoRoot();
    } catch {
      repoRoot = "";
    }
    if (!repoRoot) {
      sourcePath = null;
    } else {
      sourcePath = path.join(repoRoot, sourceRelPath);
    }
  }
  let sourceHash: string | null = null;
  if (sourcePath) {
    try {
      sourceBytes = readFileNoFollow(sourcePath);
      sourceHash = hashPrefix(sourceBytes);
    } catch {
      // Source unreadable — fall through to the
      // manual_required branch below.
      sourceBytes = null;
      sourceHash = null;
    }
  }

  if (sourceBytes === null || sourceHash === null) {
    // Target IS present (we have targetBytes) but we can't
    // compare — emit manual_required with the target hash so
    // operators can see what's on disk even if we can't verify.
    return {
      state: "manual_required",
      target_path: targetPath,
      source_path: sourcePath,
      target_hash_prefix: targetHash,
      source_hash_prefix: null,
      target_mtime: targetMtime,
      disabled_sibling_path: disabledSiblingPath,
      details: sourcePath
        ? `target present at ${targetPath} but repo source at ${sourcePath} could not be read; checker cannot verify`
        : `target present at ${targetPath} but repo root unresolvable; checker cannot compare against source`,
    };
  }

  // Hash comparison. Use full sha256 for equality (defensive:
  // prefixes can collide in principle). If full hashes match we
  // emit the 12-char prefix for display.
  const targetFull = createHash("sha256").update(targetBytes).digest("hex");
  const sourceFull = createHash("sha256").update(sourceBytes).digest("hex");
  if (targetFull === sourceFull) {
    return {
      state: "installed",
      target_path: targetPath,
      source_path: sourcePath,
      target_hash_prefix: targetHash,
      source_hash_prefix: sourceHash,
      target_mtime: targetMtime,
      disabled_sibling_path: disabledSiblingPath,
      details: `SKILL.md present at ${targetPath}; hash matches repo source (${targetHash})`,
    };
  }
  return {
    state: "outdated",
    target_path: targetPath,
    source_path: sourcePath,
    target_hash_prefix: targetHash,
    source_hash_prefix: sourceHash,
    target_mtime: targetMtime,
    disabled_sibling_path: disabledSiblingPath,
    details: `SKILL.md present at ${targetPath} but bytes DIFFER from repo source (target ${targetHash} vs source ${sourceHash})`,
  };
}

// ─── Per-client entry points ─────────────────────────────────────

/** Run the Codex Skill filesystem checker. Pure: reads target +
 *  source bytes, produces a state classification. Does not
 *  write, does not repair. Consumed by both the action
 *  descriptor wrapper and `computeStatus`. */
export async function runSkillDoctorCodex(
  deps: CodexSkillDoctorDeps = {},
): Promise<SkillDoctorOutput> {
  return runSkillDoctorShared(
    (d) => validateCodexSkillTargetPath(d as CodexSkillResolverDeps | undefined),
    (d) => resolveCodexSkillTargetPath(d as CodexSkillResolverDeps | undefined),
    deps.resolverDeps,
    CODEX_SKILL_SOURCE_REL_PATH,
    deps.__testOnly_preReadHook,
    deps.__testOnly_preTargetOpenHook,
    deps.repoRootOverride,
    deps.sourcePathOverride,
    deps.now,
  );
}

/** Run the Claude Desktop Skill filesystem checker. Same posture
 *  as the Codex checker; validator refuses non-darwin before any
 *  filesystem work so the VO-provisional platform scope is
 *  enforced. */
export async function runSkillDoctorClaudeDesktop(
  deps: ClaudeDesktopSkillDoctorDeps = {},
): Promise<SkillDoctorOutput> {
  return runSkillDoctorShared(
    (d) =>
      validateClaudeDesktopSkillTargetPath(
        d as ClaudeDesktopSkillResolverDeps | undefined,
      ),
    (d) =>
      resolveClaudeDesktopSkillTargetPath(
        d as ClaudeDesktopSkillResolverDeps | undefined,
      ),
    deps.resolverDeps,
    CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH,
    deps.__testOnly_preReadHook,
    deps.__testOnly_preTargetOpenHook,
    deps.repoRootOverride,
    deps.sourcePathOverride,
    deps.now,
  );
}

// ─── Test-only exports (drift-guard against runner's versions) ───

/** Exported for the drift-guard test only. Not intended for
 *  production use. Callers outside `mcp-skill-checker.test.ts`
 *  should treat these as internal. */
export const __testOnly_internals = {
  parseSkillStamp,
  isValidSkillStamp,
  readFileNoFollowWithStat,
  readFileNoFollow,
  resolveRepoRoot,
  describeStatKind,
  findLatestDisabledSibling,
  hashPrefix,
  SKILL_STAMP_REGEX,
};
