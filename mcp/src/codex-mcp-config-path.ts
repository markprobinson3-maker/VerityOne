/**
 * Shared Codex MCP config path resolver.
 *
 * Pinned by `docs/VO-MCP-CODEX-TOML-MERGE-DESIGN.md` as the single
 * source of truth for the Codex MCP config path. Shipped consumers:
 *
 *   - `mcp/src/client-config-check.ts` (`codexConfigPathDefault`)
 *     — read-only Codex MCP doctor (CLI `vo mcp doctor --client
 *     codex`).
 *   - `mcp/src/install.ts` — CLI `vo mcp install --client codex`
 *     prints the pasteable TOML block naming this resolved path.
 *     (Post-`VO-MCP-CODEX-INSTALL-ACTION-PR-1` the CLI prints the
 *     block; the parser-backed auto-merge lives in the runner via
 *     `mcp/src/codex-toml-merge.ts` + `smol-toml`.)
 *   - `mcp/src/codex-toml-merge.ts` — pure string-to-string
 *     byte-preserving merger. Does NOT touch the filesystem
 *     itself. The runner reads the resolved path's bytes via
 *     `readFileNoFollow`, hands them to this merger, and writes
 *     the returned output via `writeFileNoFollowExclusive` +
 *     atomic rename in
 *     `api/src/lib/mcp-local-action-runner.ts::runCodexMcpInstall`.
 *     Shipped in `VO-MCP-CODEX-INSTALL-ACTION-PR-1`.
 *   - `api/src/lib/mcp-local-action-runner.ts` — shipped Codex MCP
 *     file_mutation strategies (`mcp_onboard_codex`,
 *     `mcp_onboard_codex_force`, `mcp_rollback_codex`) consume the
 *     resolver at preview + execute time (api imports the api-side
 *     duplicate of `resolveCodexHome` synchronously; the
 *     drift-guard in `api/src/lib/mcp-skill-target-path.test.ts`
 *     asserts the two implementations agree under matched
 *     `{ home, env }`).
 *
 * CODEX_HOME precedence deliberately matches the Skill target-path
 * resolver in `api/src/lib/mcp-skill-target-path.ts::resolveCodexHome`;
 * the cross-package drift guard lives in
 * `api/src/lib/mcp-skill-target-path.test.ts`.
 *
 * NOT a TOML parser. NOT filesystem-aware. Pure path arithmetic —
 * safe to call from preview code BEFORE path-safety fencing.
 */

import os from "node:os";
import path from "node:path";

export interface CodexMcpConfigPathOpts {
  /** Override live HOME resolution — typically only in tests. */
  home?: string;
  /** Override `process.env` — typically only in tests. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the Codex home directory.
 *
 *  - `CODEX_HOME` env var (if set AND trimmed non-empty AND
 *    absolute) wins.
 *  - Otherwise `<home>/.codex`.
 *
 *  Matches `api/src/lib/mcp-skill-target-path.ts::resolveCodexHome`
 *  byte-for-byte in behavior; drift-guarded.
 */
export function resolveCodexHome(opts: CodexMcpConfigPathOpts = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? codexHomeDir(env);
  const override = env.CODEX_HOME;
  if (override && override.trim() && path.isAbsolute(override.trim())) {
    return override.trim();
  }
  return path.join(home, ".codex");
}

/** Resolve HOME at call time, preferring live `process.env.HOME`
 *  over Bun's cached `os.homedir()`. This mirrors the api-side
 *  Codex Skill resolver so Codex MCP config and Codex Skill
 *  target paths do not drift under a HOME override. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const live = env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

/** Resolve the Codex MCP config file path — `<codexHome>/config.toml`.
 *
 *  This is the single resolver every Codex MCP config consumer
 *  SHALL import. The design doc bans the string literal
 *  `~/.codex/config.toml` appearing as a write path anywhere in the
 *  codebase — drift-guarded.
 */
export function resolveCodexMcpConfigPath(
  opts: CodexMcpConfigPathOpts = {},
): string {
  return path.join(resolveCodexHome(opts), "config.toml");
}
