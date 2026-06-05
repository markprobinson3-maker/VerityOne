/**
 * `vo-mcp install --client <name>` — writes an MCP client config entry with
 * absolute paths to the installed server, installs a launcher script on the
 * tenant machine, and prunes build-time dev deps from the copied node_modules.
 *
 * Supported clients (implemented honestly — only what I can verify from
 * this machine/session):
 *   - claude-desktop : macOS config at ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - generic        : prints the JSON block to stdout for manual paste
 *   - codex          : prints a Codex MCP TOML block to stdout for paste into
 *                      `<resolved Codex config path>` (see
 *                      `resolveCodexMcpConfigPath`). VO-MCP-CROSS-CLIENT-INTEROP-PR-1.
 *                      The CLI itself does NOT write to the Codex config — it
 *                      prints a pasteable block so operators on a terminal
 *                      workflow can edit by hand. For an automated, parser-
 *                      backed merge that preserves unrelated sections
 *                      byte-for-byte, the VO dashboard's `mcp_onboard_codex`
 *                      action (shipped in VO-MCP-CODEX-INSTALL-ACTION-PR-1)
 *                      owns the write via `mcp/src/codex-toml-merge.ts` +
 *                      `smol-toml`. This CLI intentionally stays dependency-
 *                      light — the TOML parser is consumed only by the
 *                      dashboard runner, not by the CLI install path.
 *
 * Unsupported in rung 1 (printed with explicit message; no speculation):
 *   - cursor
 *   - zed
 *
 * Rules (binding per docs/VO-MCP-SERVER-CONTRACT.md):
 *   - command and args[0] must be absolute paths
 *   - no VO_TOKEN in env (token resolves from ~/.vo/config.json)
 *   - agent clients spawn `node <abs>/dist/server.js` directly, never `vo-mcp serve`
 *   - refuses to overwrite an existing verity-one entry without --force
 *   - copies the compiled dist/ to ~/.vo/mcp/dist/ so the client config is
 *     independent of the repo checkout location
 *   - writes ~/.vo/mcp/bin/vo-mcp launcher so tenants can run `vo-mcp doctor`
 *     without the repo checkout
 *   - prunes dev-only deps (typescript, @types/*) from ~/.vo/mcp/node_modules
 *   - if run from the already-installed location (source === dest), skips the
 *     filesystem copy phase gracefully and still refreshes config + launcher
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexMcpConfigPath } from "./codex-mcp-config-path.js";

/**
 * Installed-layout paths — computed LAZILY via `os.homedir()` at call
 * time rather than captured at module import. Two reasons:
 *
 *   1. Tests override `process.env.HOME` to exercise the installer
 *      against a tmp dir; a captured-at-import constant would ignore
 *      the override and write to the real `~/.vo/mcp`.
 *   2. A long-running process that receives a HOME change between
 *      invocations (unusual, but possible) picks the new one up
 *      automatically.
 *
 * Exported functions are named `*Path` so a caller never confuses
 * them with a static string. The historical `INSTALL_ROOT` /
 * `INSTALLED_SERVER` / `INSTALLED_LAUNCHER` / `CLAUDE_DESKTOP_CONFIG`
 * exports remain as name-only re-exports below for doctor.ts and
 * any external caller that imports them.
 */
/**
 * Resolve the tenant's HOME directory at call time, preferring the
 * live `process.env.HOME` over `os.homedir()`. Bun (unlike Node)
 * caches `os.homedir()` at startup, so a test that mutates
 * `process.env.HOME` after module import would otherwise be ignored.
 * The fallback to `os.homedir()` preserves Windows + non-POSIX
 * behavior where `$HOME` may not be set.
 */
function homeDir(): string {
  const live = process.env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

function installRootPath(): string {
  return path.join(homeDir(), ".vo", "mcp");
}
function installedDistPath(): string {
  return path.join(installRootPath(), "dist");
}
function installedServerPath(): string {
  return path.join(installedDistPath(), "server.js");
}
function installedBinDirPath(): string {
  return path.join(installRootPath(), "bin");
}
function installedLauncherPath(): string {
  return path.join(installedBinDirPath(), "vo-mcp");
}
function installedNodeModulesPath(): string {
  return path.join(installRootPath(), "node_modules");
}

function claudeDesktopConfigPath(): string {
  return process.platform === "darwin"
    ? path.join(homeDir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
      : path.join(homeDir(), ".config", "Claude", "claude_desktop_config.json");
}

const DEFAULT_VO_URL = "http://127.0.0.1:3100";

export type ClientTarget = "claude-desktop" | "generic" | "codex" | "cursor" | "zed";

/** Every known client name the installer recognizes, supported or not.
 *  Used by `parseClientTarget` to distinguish "typo" from "honestly
 *  unsupported" so the CLI error message is accurate. */
export const CLIENT_TARGETS: readonly ClientTarget[] = [
  "claude-desktop",
  "generic",
  "codex",
  "cursor",
  "zed",
] as const;

/** Clients the installer actually implements. `cursor` and `zed` are
 *  recognized but refused with an honest error. `codex` emits a TOML
 *  block to stdout (like `generic`) rather than writing to
 *  ~/.codex/config.toml directly. */
export const SUPPORTED_CLIENT_TARGETS: readonly ("claude-desktop" | "generic" | "codex")[] = [
  "claude-desktop",
  "generic",
  "codex",
] as const;

/** Narrow a raw --client value to a known target. Returns null for
 *  unknown strings (including empty); caller raises the appropriate
 *  error. Does NOT filter out unsupported targets — `install()` owns
 *  the honest unsupported-but-known refusal. */
export function parseClientTarget(raw: string | undefined): ClientTarget | null {
  if (raw === undefined) return null;
  return (CLIENT_TARGETS as readonly string[]).includes(raw) ? (raw as ClientTarget) : null;
}

export interface InstallOptions {
  client: ClientTarget;
  force: boolean;
}

/**
 * Explicit runtime parameters the installer needs to produce a
 * correct tenant install, regardless of which process is driving the
 * call. Both callers (the `vo-mcp` binary and the `vo mcp install`
 * wrapper) hand these values to `install()` — never let the function
 * probe `process.execPath` or `import.meta.url` on its own, since
 * those values are wrong when the wrapper runs under Bun or from a
 * different package root.
 *
 *   - `nodeBin`:     absolute path to Node ≥ 20. Written verbatim
 *                    into the Claude Desktop `command` field and into
 *                    `~/.vo/mcp/bin/vo-mcp`. MUST be Node, NEVER Bun.
 *   - `sourceDist`:  absolute path to the already-built JS dist dir
 *                    (`<packageRoot>/dist`). The installer copies
 *                    this directory verbatim into `~/.vo/mcp/dist/`.
 *                    MUST point at built `.js`, never at `mcp/src`.
 *   - `packageRoot`: absolute path to the package root (parent of
 *                    `sourceDist`). Contains `node_modules/`, `bin/`,
 *                    and `package.json`. Used to read devDependencies
 *                    for prune + to copy the runtime node_modules.
 */
export interface InstallRuntime {
  nodeBin: string;
  sourceDist: string;
  packageRoot: string;
}

/**
 * Default runtime factory — used by the `vo-mcp` binary where
 * `process.execPath` IS the right Node and `import.meta.url` DOES
 * point at `<packageRoot>/dist/install.js`. The `vo mcp install`
 * wrapper MUST NOT call this; it builds its own runtime from the
 * repo's `mcp/dist` and a real `node` on PATH.
 */
export function resolveDefaultInstallRuntime(): InstallRuntime {
  const thisFile = fileURLToPath(import.meta.url);
  const sourceDist = path.dirname(thisFile);
  const packageRoot = path.dirname(sourceDist);
  return {
    nodeBin: process.execPath,
    sourceDist,
    packageRoot,
  };
}

interface InstallPaths {
  sourceDist: string;
  packageRoot: string;
  sourceNodeModules: string;
  sourceLauncher: string;
  sourcePackageJson: string;
}

/** Derive the copy-source layout from the caller-supplied runtime. */
function resolvePaths(runtime: InstallRuntime): InstallPaths {
  return {
    sourceDist: runtime.sourceDist,
    packageRoot: runtime.packageRoot,
    sourceNodeModules: path.join(runtime.packageRoot, "node_modules"),
    sourceLauncher: path.join(runtime.packageRoot, "bin", "vo-mcp"),
    sourcePackageJson: path.join(runtime.packageRoot, "package.json"),
  };
}

/** Detect when the caller is running from the already-installed copy — in
 *  which case the filesystem install would `fs.cpSync(src, dest)` with the
 *  same path and crash. Graceful outcome: skip the copy phase. */
function isSelfUpdate(paths: InstallPaths): boolean {
  return path.resolve(paths.sourceDist) === path.resolve(installedDistPath());
}

/** Read devDependencies from the source package.json and delete each from the
 *  installed node_modules. Cleans up empty scope directories (e.g. @types/). */
function pruneDevDeps(paths: InstallPaths): string[] {
  if (!fs.existsSync(paths.sourcePackageJson)) return [];
  const installedNodeModules = installedNodeModulesPath();
  if (!fs.existsSync(installedNodeModules)) return [];

  let pkg: { devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(paths.sourcePackageJson, "utf-8"));
  } catch {
    return [];
  }

  const devDeps = Object.keys(pkg.devDependencies || {});
  const pruned: string[] = [];

  for (const depName of devDeps) {
    const depPath = path.join(installedNodeModules, depName);
    if (fs.existsSync(depPath)) {
      fs.rmSync(depPath, { recursive: true, force: true });
      pruned.push(depName);
    }
    if (depName.startsWith("@")) {
      const scope = depName.split("/")[0];
      const scopeDir = path.join(installedNodeModules, scope);
      try {
        const remaining = fs.readdirSync(scopeDir);
        if (remaining.length === 0) fs.rmdirSync(scopeDir);
      } catch {
        /* scope dir already gone or non-empty; skip */
      }
    }
  }

  return pruned;
}

/** Write ~/.vo/mcp/bin/vo-mcp as a stable launcher for post-install use.
 *  Always written (even on self-update) so tenants can recover from accidental
 *  deletion. Chmod +x on POSIX.
 *
 *  The installed launcher hardcodes absolute paths for BOTH the Node binary
 *  (captured from the caller-supplied `runtime.nodeBin`) and the cli.js entry
 *  point. This makes it safe under narrow-PATH contexts (cron, systemd,
 *  sandboxed spawns) that would otherwise fail with `node: not found`, AND
 *  guarantees the launcher always points at Node — never at Bun or some
 *  other runtime the driving process happens to be.
 *
 *  Tenants who rebuild Node (nvm switch, Homebrew upgrade) and end up with a
 *  different absolute node path can re-run `vo mcp install` / `vo-mcp install`
 *  to refresh the baked-in path. The self-update code path covers this
 *  cheaply. */
function writeLauncher(runtime: InstallRuntime): void {
  const launcherPath = installedLauncherPath();
  fs.mkdirSync(installedBinDirPath(), { recursive: true });

  const nodeBin = runtime.nodeBin;
  const cliJs = path.join(installedDistPath(), "cli.js");

  const launcherContent = [
    "#!/bin/bash",
    "# vo-mcp installed launcher — generated by `vo-mcp install`.",
    "# Absolute paths are baked in at install time so this script works under",
    "# narrow-PATH contexts (cron, systemd, child spawns) without requiring",
    "# `node` to be discoverable on PATH.",
    "set -e",
    `exec ${JSON.stringify(nodeBin)} ${JSON.stringify(cliJs)} "$@"`,
    "",
  ].join("\n");

  fs.writeFileSync(launcherPath, launcherContent, "utf-8");
  try {
    fs.chmodSync(launcherPath, 0o755);
  } catch {
    /* chmod may fail on non-POSIX; ignore */
  }
}

/** Copy the built dist/ directory + node_modules + a minimal package.json
 *  into ~/.vo/mcp/. Self-update-safe: if called from the installed location,
 *  skips the copy phase.
 *
 *  Layout after a full install:
 *    ~/.vo/mcp/package.json        (minimal: {"type": "module"})
 *    ~/.vo/mcp/bin/vo-mcp          (executable launcher)
 *    ~/.vo/mcp/dist/server.js      (what agent clients spawn)
 *    ~/.vo/mcp/dist/...other.js
 *    ~/.vo/mcp/node_modules/...    (runtime deps, dev-only pruned)
 */
function installFilesystem(runtime: InstallRuntime, paths: InstallPaths): { selfUpdate: boolean; pruned: string[] } {
  const installRoot = installRootPath();
  const installedDist = installedDistPath();
  const installedNodeModules = installedNodeModulesPath();
  fs.mkdirSync(installRoot, { recursive: true });

  if (isSelfUpdate(paths)) {
    // We're running from ~/.vo/mcp/dist/install.js. Filesystem is already in
    // place — just refresh the launcher and return.
    writeLauncher(runtime);
    return { selfUpdate: true, pruned: [] };
  }

  if (!fs.existsSync(paths.sourceNodeModules)) {
    throw new Error(
      `node_modules not found at ${paths.sourceNodeModules}. Run "npm install" in the mcp/ package first.`,
    );
  }

  // Wipe and rewrite dist/
  if (fs.existsSync(installedDist)) fs.rmSync(installedDist, { recursive: true, force: true });
  fs.mkdirSync(installedDist, { recursive: true });
  fs.cpSync(paths.sourceDist, installedDist, { recursive: true });

  // Wipe and rewrite node_modules/
  if (fs.existsSync(installedNodeModules)) {
    fs.rmSync(installedNodeModules, { recursive: true, force: true });
  }
  fs.cpSync(paths.sourceNodeModules, installedNodeModules, { recursive: true, dereference: false });

  // Minimal package.json for Node ESM resolution (.js files treated as ESM).
  const minimalPackageJson = {
    name: "vo-mcp-installed",
    version: "0.1.0",
    type: "module" as const,
    private: true,
  };
  fs.writeFileSync(
    path.join(installRoot, "package.json"),
    JSON.stringify(minimalPackageJson, null, 2) + "\n",
    "utf-8",
  );

  // Prune devDeps so the tenant install does not ship typescript / @types.
  const pruned = pruneDevDeps(paths);

  // Write launcher script.
  writeLauncher(runtime);

  return { selfUpdate: false, pruned };
}

function buildEntry(runtime: InstallRuntime): { command: string; args: string[]; env: Record<string, string> } {
  return {
    // Caller-supplied absolute Node path — never Bun, never relative.
    command: runtime.nodeBin,
    args: [installedServerPath()],
    // No VO_TOKEN. Tenant token comes from ~/.vo/config.json per contract.
    env: { VO_URL: DEFAULT_VO_URL },
  };
}

function mergeClaudeDesktop(runtime: InstallRuntime, force: boolean): string {
  const configPath = claudeDesktopConfigPath();
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${configPath} exists but is not valid JSON: ${(e as Error).message}`);
    }
  }

  const mcpServers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  if (mcpServers["verity-one"] && !force) {
    throw new Error(
      `${configPath} already has an mcpServers.verity-one entry. Re-run with --force to overwrite.`,
    );
  }

  mcpServers["verity-one"] = buildEntry(runtime);
  const next = { ...existing, mcpServers };

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return configPath;
}

function printGenericInstructions(runtime: InstallRuntime): void {
  const entry = buildEntry(runtime);
  const block = { mcpServers: { "verity-one": entry } };
  process.stdout.write(
    "Paste this block into your MCP client's config file:\n\n" +
      JSON.stringify(block, null, 2) +
      "\n\n" +
      "Notes:\n" +
      `  - command and args[0] are absolute (${entry.command}, ${entry.args[0]}).\n` +
      "  - VO_TOKEN is intentionally absent. The server reads tenant auth from ~/.vo/config.json.\n" +
      "  - Restart your MCP client after editing its config.\n",
  );
}

/**
 * Build the TOML block for Codex's `~/.codex/config.toml` from the
 * installed runtime. Exported so tests can assert the exact shape
 * without spawning an install run.
 *
 * The produced block is a valid TOML fragment: every string value is
 * emitted via `JSON.stringify`, whose output is a double-quoted
 * basic-string literal that also parses as a TOML basic string. This
 * keeps escaping correct without requiring a dedicated TOML writer.
 */
export function buildCodexTomlBlock(runtime: InstallRuntime): string {
  const entry = buildEntry(runtime);
  return [
    "[mcp_servers.verity-one]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `env = { VO_URL = ${JSON.stringify(entry.env.VO_URL)} }`,
    "",
  ].join("\n");
}

function printCodexInstructions(runtime: InstallRuntime): void {
  const entry = buildEntry(runtime);
  const toml = buildCodexTomlBlock(runtime);
  // Resolve the SAME Codex MCP config path the dashboard runner
  // and the doctor use (CODEX_HOME > live $HOME). The text we
  // print points at the operator's actual config path so an
  // operator with CODEX_HOME set is not told to edit the wrong
  // file.
  const resolved = resolveCodexMcpConfigPath({ home: homeDir() });
  process.stdout.write(
    `Paste this block into your Codex MCP config at ${resolved}:\n\n` +
      toml +
      "\n" +
      "Notes:\n" +
      `  - command and args[0] are absolute (${entry.command}, ${entry.args[0]}).\n` +
      "  - VO_TOKEN is intentionally absent. The server reads tenant auth from ~/.vo/config.json.\n" +
      `  - Codex reads ${resolved}; restart Codex after editing.\n` +
      `  - This CLI does NOT write ${resolved} for you — paste the block into an\n` +
      "    existing [mcp_servers.*] section or add it if the section does not exist\n" +
      "    yet. For an automated merge that preserves unrelated sections byte-for-byte,\n" +
      "    run the VO dashboard's `mcp_onboard_codex` action (shipped in\n" +
      "    VO-MCP-CODEX-INSTALL-ACTION-PR-1).\n",
  );
}

/**
 * Print an explicit, client-aware "what to do next" checklist after
 * a successful install. The checklist separates three things the
 * operator must distinguish clearly:
 *
 *   1. what the installer DID touch (dist copy + Claude Desktop
 *      config merge, or a pasteable Codex block)
 *   2. what the operator must STILL do MANUALLY in the CLI workflow
 *      (restart the client, paste TOML into ~/.codex/config.toml)
 *   3. how to verify the preconditions without waiting for the
 *      client's GUI acceptance (`vo-mcp doctor` + `vo-mcp doctor
 *      --client <name>`)
 *
 * Honesty contract: never promises the client will actually load
 * the server after restart — that is the manual-acceptance cell in
 * the interop proof matrix.
 */
/**
 * Tail line appended to every post-install checklist pointing at
 * the activation wayfinding guide. Kept as a named constant so the
 * drift guard in `agent-lab/scripts/lib/mcp-activation-wayfinding.test.ts`
 * can pin the exact string without coupling to each client
 * branch's body.
 */
const ACTIVATION_POINTER_LINE =
  `  See docs/VO-MCP-ACTIVATION.md for the full install → doctor → record → rerun-proof flow.\n`;

function printPostInstallChecklist(
  client: "claude-desktop" | "codex" | "generic",
  installedLauncher: string,
  writtenConfigPath?: string,
): void {
  process.stdout.write("\nNext steps:\n");
  if (client === "claude-desktop") {
    process.stdout.write(
      `  1. Validate the written Claude Desktop config (read-only, no mutation):\n` +
        `       ${installedLauncher} doctor --client claude-desktop\n` +
        `  2. Exercise the installed server against your local VO node:\n` +
        `       ${installedLauncher} doctor\n` +
        `  3. Quit and relaunch Claude Desktop. Confirm the verity-one tools\n` +
        `     appear in the MCP-tool picker and at least one call succeeds.\n` +
        `     (Step 3 is the only GUI-side acceptance; steps 1 and 2 cover every\n` +
        `     on-disk and protocol-level precondition.)\n`,
    );
    if (writtenConfigPath) {
      process.stdout.write(`  Config file: ${writtenConfigPath}\n`);
    }
    process.stdout.write(ACTIVATION_POINTER_LINE);
    return;
  }
  if (client === "codex") {
    const resolvedCodex = resolveCodexMcpConfigPath({ home: homeDir() });
    process.stdout.write(
      `  1. Paste the [mcp_servers.verity-one] block above into ${resolvedCodex}.\n` +
        `     If the file already has an [mcp_servers.*] section, append under it;\n` +
        `     otherwise add the section verbatim. For an automated merge that\n` +
        `     preserves unrelated sections byte-for-byte, use the VO dashboard's\n` +
        `     \`mcp_onboard_codex\` action.\n` +
        `  2. Validate the pasted config (read-only, no mutation):\n` +
        `       ${installedLauncher} doctor --client codex\n` +
        `  3. Exercise the installed server against your local VO node:\n` +
        `       ${installedLauncher} doctor\n` +
        `  4. Restart Codex. Confirm the verity-one tools appear and at least\n` +
        `     one call succeeds. (Step 4 is the only GUI-side acceptance;\n` +
        `     steps 2 and 3 cover every on-disk and protocol-level precondition.)\n`,
    );
    process.stdout.write(ACTIVATION_POINTER_LINE);
    return;
  }
  // generic
  process.stdout.write(
    `  1. Paste the JSON block above into your client's MCP config.\n` +
      `  2. Exercise the installed server against your local VO node:\n` +
      `       ${installedLauncher} doctor\n` +
      `  3. Restart your MCP client and confirm the verity-one tools appear.\n`,
  );
  process.stdout.write(ACTIVATION_POINTER_LINE);
}


function printLauncherInstructions(selfUpdate: boolean, pruned: string[]): void {
  if (selfUpdate) {
    process.stdout.write(`vo-mcp install: source == installed location — skipped file copy (self-update)\n`);
  } else if (pruned.length > 0) {
    process.stdout.write(`vo-mcp install: pruned dev deps from installed node_modules: ${pruned.join(", ")}\n`);
  }
  const installedServer = installedServerPath();
  const installedLauncher = installedLauncherPath();
  process.stdout.write(
    `vo-mcp install: server installed at ${installedServer}\n` +
      `vo-mcp install: launcher installed at ${installedLauncher}\n` +
      `\n` +
      `To use \`vo-mcp\` as a shell command, symlink the launcher into a directory on your PATH:\n` +
      `  ln -s ${installedLauncher} ~/.local/bin/vo-mcp\n` +
      `  # or: ln -s ${installedLauncher} /usr/local/bin/vo-mcp\n` +
      `\n` +
      `Verify:\n` +
      `  ${installedLauncher} doctor\n`,
  );
}

/**
 * Install the MCP server into a tenant's MCP client config.
 *
 * `runtime` is REQUIRED when called from anything other than the
 * `vo-mcp` binary — in particular, `vo mcp install` under Bun must
 * construct its own runtime (real Node path, real built dist dir)
 * and hand it in, because `process.execPath` and `import.meta.url`
 * in that context would point at the wrong binary / wrong source.
 * When omitted the function falls back to `resolveDefaultInstallRuntime()`,
 * which is the correct behavior for the `vo-mcp` binary entrypoint.
 */
export function install(opts: InstallOptions, runtime?: InstallRuntime): void {
  const rt = runtime ?? resolveDefaultInstallRuntime();
  const paths = resolvePaths(rt);
  const { selfUpdate, pruned } = installFilesystem(rt, paths);

  if (opts.client === "claude-desktop") {
    const written = mergeClaudeDesktop(rt, opts.force);
    process.stdout.write(`vo-mcp install: wrote mcpServers.verity-one to ${written}\n`);
    printLauncherInstructions(selfUpdate, pruned);
    printPostInstallChecklist("claude-desktop", installedLauncherPath(), written);
    return;
  }

  if (opts.client === "generic") {
    printGenericInstructions(rt);
    process.stdout.write(`\n`);
    printLauncherInstructions(selfUpdate, pruned);
    printPostInstallChecklist("generic", installedLauncherPath());
    return;
  }

  if (opts.client === "codex") {
    printCodexInstructions(rt);
    process.stdout.write(`\n`);
    printLauncherInstructions(selfUpdate, pruned);
    printPostInstallChecklist("codex", installedLauncherPath());
    return;
  }

  // Honestly unsupported targets — do not guess at config paths or formats.
  throw new Error(
    `client "${opts.client}" is not supported in this rung. ` +
      `Supported: claude-desktop, generic, codex. ` +
      `For cursor/zed use --client generic and paste the block manually for now.`,
  );
}

/**
 * Accessor exports — replace the previous module-load-time constants
 * (`INSTALL_ROOT`, `INSTALLED_SERVER`, …) with lazy functions so a
 * HOME override between import and call is honored. The old constant
 * names are NOT re-exported; call sites (today: `doctor.ts`) use the
 * accessors directly.
 */
export {
  installRootPath,
  installedServerPath,
  installedLauncherPath,
  installedBinDirPath,
  claudeDesktopConfigPath,
};
