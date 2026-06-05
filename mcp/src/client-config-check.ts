/**
 * Client-specific MCP config validators —
 * VO-MCP-CLIENT-ERGONOMICS-PR-1.
 *
 * Read-only diagnostics for the two MCP client targets the CLI
 * installer supports:
 *
 *   - Claude Desktop: the CLI installer merges
 *     `mcpServers.verity-one` into a JSON config file at a
 *     platform-dependent path.
 *   - Codex: the CLI installer emits a `[mcp_servers.verity-one]`
 *     TOML block to stdout. The CLI itself does NOT write the
 *     file — the operator either pastes it by hand OR runs the
 *     dashboard's `mcp_onboard_codex` action, which owns the
 *     parser-backed byte-preserving merge (shipped in
 *     `VO-MCP-CODEX-INSTALL-ACTION-PR-1` via
 *     `mcp/src/codex-toml-merge.ts` + `smol-toml`).
 *
 * These functions NEVER mutate the config file. They are invoked by
 * `vo-mcp doctor --client <name>` to answer one question cleanly:
 * "does the client I just installed into have a `verity-one` entry
 * that points at an actually-existing server, and does every path
 * in that entry resolve?"
 *
 * Runtime acceptance (the GUI app actually loading the config and
 * calling tools) is still manual — this module covers the
 * precondition half of that story.
 *
 * TOML parsing note — narrow scope: this read-only doctor module
 * deliberately does NOT depend on a TOML parser. Codex's MCP
 * server config is a narrow, known shape emitted by
 * `buildCodexTomlBlock()` in install.ts; this validator
 * regex-matches exactly that shape. If Codex changes its config
 * grammar the validator fails loud rather than producing false
 * positives. The PACKAGE now ships `smol-toml` as a runtime
 * dependency for the dashboard-side parser-backed merge
 * (`mcp/src/codex-toml-merge.ts`), but that parser is scoped to
 * the write path — this doctor stays regex-only so `vo-mcp
 * doctor --client codex` keeps its lightweight read-only posture.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexMcpConfigPath } from "./codex-mcp-config-path.js";

/** One row in the doctor output — a single named check. */
export interface ConfigCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
}

export interface ConfigCheckResult {
  ok: boolean;
  /** Absolute path to the config file the check targets. Present
   *  even when the file is missing so the operator can see exactly
   *  where the installer expects to find it. */
  config_path: string;
  checks: ConfigCheck[];
}

function homeDir(): string {
  const live = process.env.HOME;
  if (live && live.trim()) return live;
  return os.homedir();
}

/** Result of probing a `command` path to decide whether it will run
 *  the installed MCP server correctly. The install contract requires
 *  `command` to be Node ≥ 20 — not Bun, not `/bin/sh`, not any other
 *  runtime — because MCP clients spawn it as
 *  `<command> <abs>/dist/server.js`. A previous revision of these
 *  validators treated any existing absolute path as a pass; that was
 *  wrong. This helper actually runs `<command> --version` and
 *  inspects the output.
 *
 *  Node is the only runtime whose `--version` produces `v<maj>.<min>.<patch>`
 *  without extra noise, so a simple regex on the first line is enough
 *  to distinguish. Timeouts bound the check to 2s so a hung binary
 *  does not block `doctor` indefinitely.
 *
 *  Exported for direct testing. */
export type NodeBinaryProbe =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export function probeNodeBinary(commandPath: string): NodeBinaryProbe {
  let out: ReturnType<typeof spawnSync>;
  try {
    out = spawnSync(commandPath, ["--version"], {
      timeout: 2000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { ok: false, reason: `spawn failed: ${(e as Error).message}` };
  }
  if (out.error) {
    return { ok: false, reason: `spawn error: ${out.error.message}` };
  }
  if (typeof out.status === "number" && out.status !== 0) {
    return {
      ok: false,
      reason: `\`${commandPath} --version\` exited ${out.status}: ${(out.stderr || out.stdout || "").toString().trim().slice(0, 200)}`,
    };
  }
  const stdout = (out.stdout ?? "").toString().trim();
  // Node prints exactly `v<major>.<minor>.<patch>` — nothing else.
  // Bun prints `1.3.9`, deno prints `deno 1.xx.x\n...`, /bin/sh has
  // no `--version` and exits non-zero. Anchor on Node's exact shape.
  const match = stdout.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return {
      ok: false,
      reason: `\`${commandPath} --version\` did not print a Node version (got ${JSON.stringify(stdout.slice(0, 100))})`,
    };
  }
  const major = Number(match[1]);
  if (major < 20) {
    return {
      ok: false,
      reason: `Node ${stdout} is too old; MCP server requires Node ≥ 20`,
    };
  }
  return { ok: true, version: stdout };
}

// ── Claude Desktop ──────────────────────────────────────────────────

export function claudeDesktopConfigPathDefault(): string {
  return process.platform === "darwin"
    ? path.join(homeDir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
      : path.join(homeDir(), ".config", "Claude", "claude_desktop_config.json");
}

export interface ClaudeDesktopCheckOpts {
  /** Override the config path. Tests pass a tmp path; real callers
   *  let it default to the per-platform location. */
  configPath?: string;
  /** Override the installed server path. Defaults to
   *  `~/.vo/mcp/dist/server.js` via install.ts. */
  expectedServerPath?: string;
}

export function checkClaudeDesktopConfig(
  opts: ClaudeDesktopCheckOpts = {},
): ConfigCheckResult {
  const configPath = opts.configPath ?? claudeDesktopConfigPathDefault();
  const expectedServer =
    opts.expectedServerPath ?? path.join(homeDir(), ".vo", "mcp", "dist", "server.js");
  const checks: ConfigCheck[] = [];

  // 1. config file present
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: "claude_desktop_config_present",
      status: "fail",
      detail:
        `not found at ${configPath} — run \`vo-mcp install --client claude-desktop\` first`,
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "claude_desktop_config_present", status: "pass", detail: configPath });

  // 2. JSON parses
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (e) {
    checks.push({
      name: "claude_desktop_config_readable",
      status: "fail",
      detail: (e as Error).message,
    });
    return { ok: false, config_path: configPath, checks };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    checks.push({
      name: "claude_desktop_config_json",
      status: "fail",
      detail: `not valid JSON: ${(e as Error).message}`,
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "claude_desktop_config_json", status: "pass" });

  // 3. mcpServers.verity-one entry
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    checks.push({
      name: "mcp_servers_object",
      status: "fail",
      detail: "top level is not a JSON object",
    });
    return { ok: false, config_path: configPath, checks };
  }
  const obj = parsed as Record<string, unknown>;
  // Split the "missing" vs "wrong shape" sub-cases so a later
  // consumer (the control-status report's doctor-failure
  // classifier) can tell a pre-install tenant's absent key from
  // an operator whose config file carries `mcpServers` with the
  // wrong JSON shape. Both still emit the `mcp_servers_object`
  // check name; the details are distinct so the downstream
  // classifier can route cleanly without re-parsing the full
  // JSON.
  const mcpServersRaw = obj.mcpServers;
  if (mcpServersRaw === undefined || mcpServersRaw === null) {
    checks.push({
      name: "mcp_servers_object",
      status: "fail",
      detail: "`mcpServers` key is missing",
    });
    return { ok: false, config_path: configPath, checks };
  }
  if (typeof mcpServersRaw !== "object" || Array.isArray(mcpServersRaw)) {
    checks.push({
      name: "mcp_servers_object",
      status: "fail",
      detail: "`mcpServers` value is not an object",
    });
    return { ok: false, config_path: configPath, checks };
  }
  const mcpServers = mcpServersRaw as Record<string, unknown>;
  checks.push({ name: "mcp_servers_object", status: "pass" });

  const entry = mcpServers["verity-one"];
  if (!entry) {
    checks.push({
      name: "verity_one_entry_present",
      status: "fail",
      detail:
        "`mcpServers.verity-one` entry not found — run `vo-mcp install --client claude-desktop --force` to rewrite it",
    });
    return { ok: false, config_path: configPath, checks };
  }
  if (typeof entry !== "object" || Array.isArray(entry)) {
    checks.push({
      name: "verity_one_entry_present",
      status: "fail",
      detail: "`mcpServers.verity-one` is not an object",
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "verity_one_entry_present", status: "pass" });

  const e = entry as Record<string, unknown>;

  // 4. command is an absolute path to an actual Node ≥ 20 binary.
  //    The install contract spawns `<command> <abs>/dist/server.js`,
  //    so a `command` that points at /bin/sh or Bun runs the wrong
  //    program even if the path exists. probeNodeBinary() executes
  //    `<command> --version` with a 2s timeout and confirms Node's
  //    exact version-line shape.
  if (typeof e.command !== "string" || !path.isAbsolute(e.command)) {
    checks.push({
      name: "verity_one_command_absolute",
      status: "fail",
      detail: `\`command\` must be an absolute path; got ${JSON.stringify(e.command)}`,
    });
  } else if (!fs.existsSync(e.command)) {
    checks.push({
      name: "verity_one_command_exists",
      status: "fail",
      detail: `\`command\` path does not exist on disk: ${e.command} — re-run install after installing Node ≥ 20`,
    });
  } else {
    const probe = probeNodeBinary(e.command);
    if (!probe.ok) {
      checks.push({
        name: "verity_one_command_is_node",
        status: "fail",
        detail:
          `\`command\` at ${e.command} is not a Node binary: ${probe.reason}. ` +
          `MCP clients spawn \`<command> <server.js>\`; anything other than Node will not run the server correctly. Re-run install after ensuring the Node path is canonical.`,
      });
    } else {
      checks.push({
        name: "verity_one_command_is_node",
        status: "pass",
        detail: `${e.command} (${probe.version})`,
      });
    }
  }

  // 5. args[0] matches the installed server path AND that file exists
  if (!Array.isArray(e.args) || typeof e.args[0] !== "string") {
    checks.push({
      name: "verity_one_args_shape",
      status: "fail",
      detail: "`args` must be an array whose first element is an absolute path to server.js",
    });
  } else if (!path.isAbsolute(e.args[0])) {
    checks.push({
      name: "verity_one_args_shape",
      status: "fail",
      detail: `\`args[0]\` must be an absolute path; got ${JSON.stringify(e.args[0])}`,
    });
  } else if (!fs.existsSync(e.args[0])) {
    checks.push({
      name: "verity_one_server_exists",
      status: "fail",
      detail:
        `server.js referenced in args[0] does not exist: ${e.args[0]} — run \`vo-mcp install --client claude-desktop --force\` to refresh the install`,
    });
  } else if (e.args[0] !== expectedServer) {
    checks.push({
      name: "verity_one_server_path_canonical",
      status: "warn",
      detail:
        `args[0] (${e.args[0]}) does not match the canonical installed server (${expectedServer}). This is OK if you know why — otherwise re-run install --force.`,
    });
  } else {
    checks.push({
      name: "verity_one_server_exists",
      status: "pass",
      detail: e.args[0],
    });
  }

  // 6. env has VO_URL but no VO_TOKEN (token flows from ~/.vo/config.json)
  if (!e.env || typeof e.env !== "object" || Array.isArray(e.env)) {
    checks.push({
      name: "verity_one_env_shape",
      status: "warn",
      detail: "`env` should be an object with at least VO_URL set",
    });
  } else {
    const envObj = e.env as Record<string, unknown>;
    if (typeof envObj.VO_URL !== "string" || !envObj.VO_URL.startsWith("http")) {
      checks.push({
        name: "verity_one_env_vo_url",
        status: "warn",
        detail: `env.VO_URL is missing or malformed: ${JSON.stringify(envObj.VO_URL)}`,
      });
    } else {
      checks.push({ name: "verity_one_env_vo_url", status: "pass", detail: envObj.VO_URL });
    }
    if ("VO_TOKEN" in envObj) {
      checks.push({
        name: "verity_one_env_no_vo_token",
        status: "warn",
        detail:
          "env.VO_TOKEN is set in the client config — remove it. The server resolves tenant auth from ~/.vo/config.json.",
      });
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, config_path: configPath, checks };
}

// ── Codex ───────────────────────────────────────────────────────────

export function codexConfigPathDefault(): string {
  return resolveCodexMcpConfigPath({ home: homeDir() });
}

export interface CodexCheckOpts {
  /** Override the config path. Tests pass a tmp path; real callers
   *  let it default to `~/.codex/config.toml`. */
  configPath?: string;
  /** Override the installed server path. Defaults to
   *  `~/.vo/mcp/dist/server.js`. */
  expectedServerPath?: string;
}

export function checkCodexConfig(opts: CodexCheckOpts = {}): ConfigCheckResult {
  const configPath = opts.configPath ?? codexConfigPathDefault();
  const expectedServer =
    opts.expectedServerPath ?? path.join(homeDir(), ".vo", "mcp", "dist", "server.js");
  const checks: ConfigCheck[] = [];

  // 1. file present
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: "codex_config_present",
      status: "fail",
      detail:
        `not found at ${configPath} — paste the block from \`vo-mcp install --client codex\` into it`,
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "codex_config_present", status: "pass", detail: configPath });

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (e) {
    checks.push({
      name: "codex_config_readable",
      status: "fail",
      detail: (e as Error).message,
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "codex_config_readable", status: "pass" });

  // 2. [mcp_servers.verity-one] section present and UNIQUE.
  //    Because the Codex flow is paste-into-TOML, it is easy for an
  //    operator to paste the block twice. Two identical section
  //    headers make the TOML at best ambiguous (the later one
  //    silently wins in most parsers) and at worst invalid — either
  //    way the doctor should NOT bless the config.
  const sectionCount = countCodexVerityOneSections(raw);
  if (sectionCount === 0) {
    checks.push({
      name: "verity_one_section_present",
      status: "fail",
      detail:
        `\`[mcp_servers.verity-one]\` section not found — paste the block from \`vo-mcp install --client codex\``,
    });
    return { ok: false, config_path: configPath, checks };
  }
  if (sectionCount > 1) {
    checks.push({
      name: "verity_one_section_unique",
      status: "fail",
      detail:
        `\`[mcp_servers.verity-one]\` section appears ${sectionCount} times in ${configPath}. ` +
        `Remove duplicates so exactly one block remains — TOML parsers treat duplicate table headers as ambiguous or invalid.`,
    });
    return { ok: false, config_path: configPath, checks };
  }
  const section = extractCodexVerityOneSection(raw);
  if (!section) {
    // Defense-in-depth: count said 1 but extractor failed. Should not
    // happen for valid section headers; fail loud if it ever does.
    checks.push({
      name: "verity_one_section_present",
      status: "fail",
      detail:
        `internal: countCodexVerityOneSections=1 but extractor returned null on ${configPath}`,
    });
    return { ok: false, config_path: configPath, checks };
  }
  checks.push({ name: "verity_one_section_present", status: "pass" });

  // 3. command = "<absolute path>" AND actually Node ≥ 20. Same
  //    probe used for the Claude Desktop path; pasted configs that
  //    substituted /bin/sh or another runtime would otherwise pass
  //    existence alone.
  const command = extractTomlStringValue(section, "command");
  if (!command) {
    checks.push({
      name: "verity_one_command_present",
      status: "fail",
      detail: "`command = \"<path>\"` line missing or unparseable in the section",
    });
  } else if (!path.isAbsolute(command)) {
    checks.push({
      name: "verity_one_command_absolute",
      status: "fail",
      detail: `command is not an absolute path: ${JSON.stringify(command)}`,
    });
  } else if (!fs.existsSync(command)) {
    checks.push({
      name: "verity_one_command_exists",
      status: "fail",
      detail: `command path does not exist on disk: ${command} — install Node ≥ 20 and re-paste`,
    });
  } else {
    const probe = probeNodeBinary(command);
    if (!probe.ok) {
      checks.push({
        name: "verity_one_command_is_node",
        status: "fail",
        detail:
          `command at ${command} is not a Node binary: ${probe.reason}. ` +
          `Codex spawns \`<command> <server.js>\`; anything other than Node will not run the server. Re-paste the block from \`vo-mcp install --client codex\`.`,
      });
    } else {
      checks.push({
        name: "verity_one_command_is_node",
        status: "pass",
        detail: `${command} (${probe.version})`,
      });
    }
  }

  // 4. args = ["<abs path to server.js>"]
  const argsArray = extractTomlStringArray(section, "args");
  if (!argsArray || argsArray.length === 0) {
    checks.push({
      name: "verity_one_args_present",
      status: "fail",
      detail: "`args = [\"<abs path to server.js>\"]` line missing or unparseable",
    });
  } else {
    const first = argsArray[0];
    if (!path.isAbsolute(first)) {
      checks.push({
        name: "verity_one_args_absolute",
        status: "fail",
        detail: `args[0] is not an absolute path: ${JSON.stringify(first)}`,
      });
    } else if (!fs.existsSync(first)) {
      checks.push({
        name: "verity_one_server_exists",
        status: "fail",
        detail: `server.js referenced in args[0] does not exist: ${first} — run \`vo-mcp install --client codex\` to refresh`,
      });
    } else if (first !== expectedServer) {
      checks.push({
        name: "verity_one_server_path_canonical",
        status: "warn",
        detail: `args[0] (${first}) is not the canonical installed server (${expectedServer})`,
      });
    } else {
      checks.push({
        name: "verity_one_server_exists",
        status: "pass",
        detail: first,
      });
    }
  }

  // 5. env inline table carries VO_URL, no VO_TOKEN
  const envLine = section.match(/^\s*env\s*=\s*\{([^}]*)\}\s*$/m)?.[1] ?? null;
  if (!envLine) {
    checks.push({
      name: "verity_one_env_shape",
      status: "warn",
      detail: "`env = { VO_URL = \"...\" }` inline table not found in the section",
    });
  } else {
    const voUrl = envLine.match(/\bVO_URL\s*=\s*"([^"]*)"/)?.[1] ?? null;
    if (!voUrl || !voUrl.startsWith("http")) {
      checks.push({
        name: "verity_one_env_vo_url",
        status: "warn",
        detail: `env VO_URL missing or malformed: ${JSON.stringify(voUrl)}`,
      });
    } else {
      checks.push({ name: "verity_one_env_vo_url", status: "pass", detail: voUrl });
    }
    if (/\bVO_TOKEN\s*=/.test(envLine)) {
      checks.push({
        name: "verity_one_env_no_vo_token",
        status: "warn",
        detail:
          "env.VO_TOKEN is set — remove it. The server resolves tenant auth from ~/.vo/config.json.",
      });
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, config_path: configPath, checks };
}

// ── Narrow TOML shape helpers ───────────────────────────────────────
// These intentionally parse only the Codex MCP section shape we need.
// They are not a general TOML parser, but the header grammar must stay
// aligned with the dashboard merge/preview path so valid TOML header
// comments or array-of-tables boundaries do not create doctor drift.

const CODEX_VERITY_ONE_HEADER_LINE_RE =
  /^\s*\[mcp_servers\.verity-one\]\s*(?:#.*)?$/;
const CODEX_ANY_TABLE_HEADER_LINE_RE =
  /^\s*(?:\[\[[^\]]+\]\]|\[[^\]]+\])\s*(?:#.*)?$/;
const CODEX_VERITY_ONE_DESCENDANT_HEADER_LINE_RE =
  /^\s*\[\[?\s*mcp_servers\.verity-one\.[^\]]+\]\]?\s*(?:#.*)?$/;

/** Count how many times the `[mcp_servers.verity-one]` table header
 *  literally appears in the file. Used to refuse duplicate sections
 *  (a real failure mode of the paste-into-TOML workflow that most
 *  TOML parsers treat as either ambiguous or invalid). */
export function countCodexVerityOneSections(raw: string): number {
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (CODEX_VERITY_ONE_HEADER_LINE_RE.test(line)) count++;
  }
  return count;
}

/** Extract the lines belonging to the `[mcp_servers.verity-one]`
 *  section — the header line up to (but not including) the next
 *  `[...]` section header or end-of-file. Returns `null` when the
 *  header is not found. When duplicates are present the caller should
 *  use countCodexVerityOneSections() first and refuse; this function
 *  returns only the first occurrence. */
export function extractCodexVerityOneSection(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CODEX_VERITY_ONE_HEADER_LINE_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (
      CODEX_ANY_TABLE_HEADER_LINE_RE.test(lines[i]) &&
      !CODEX_VERITY_ONE_DESCENDANT_HEADER_LINE_RE.test(lines[i])
    ) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Extract a top-level `key = "..."` basic-string value from a TOML
 *  section body. Returns `null` if the key is absent or the value
 *  is not a simple double-quoted basic string. */
export function extractTomlStringValue(section: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`, "m");
  const m = section.match(re);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/** Extract a top-level `key = ["...", "..."]` array of basic strings
 *  from a TOML section body. Returns `null` if the key is absent or
 *  the value is not a same-line array of basic strings. */
export function extractTomlStringArray(section: string, key: string): string[] | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*$`, "m");
  const m = section.match(re);
  if (!m) return null;
  const body = m[1];
  const values: string[] = [];
  const stringRe = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = stringRe.exec(body)) !== null) {
    try {
      values.push(JSON.parse(`"${match[1]}"`));
    } catch {
      return null;
    }
  }
  return values;
}
