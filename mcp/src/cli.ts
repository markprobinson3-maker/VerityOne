#!/usr/bin/env node
/**
 * vo-mcp — standalone CLI binary for the local-first MCP package.
 *
 * Subcommands (per docs/VO-MCP-SERVER-CONTRACT.md):
 *   vo-mcp install --client <name> [--force]
 *   vo-mcp doctor
 *   vo-mcp serve        (manual/debug only — NOT the install contract)
 *   vo-mcp --help | -h
 *   vo-mcp --version | -v
 *
 * This binary is completely separate from the `vo` CLI in
 * agent-lab/scripts/vo-cli.ts. The two never merge.
 */

import { doctor, doctorClient, type DoctorClientTarget } from "./doctor.js";
import {
  install,
  parseClientTarget,
  SUPPORTED_CLIENT_TARGETS,
} from "./install.js";
import { runServer } from "./server.js";
import { TOOL_NAMES } from "./tools/index.js";

// MCP server package version — one of four independent version axes; see docs/VERSIONING.md.
const VERSION = "0.1.0";

const HELP = `vo-mcp ${VERSION} — local-first stdio MCP server for Verity One

USAGE
  vo-mcp install --client <name> [--force]
  vo-mcp doctor [--client <name>]
  vo-mcp serve
  vo-mcp --help | --version

COMMANDS
  install    Install the MCP server into an agent client's config.
             Supported clients: claude-desktop, codex, generic
             (cursor, zed are not supported in this rung — use
              --client generic and paste the JSON block by hand.)
             --client codex prints a [mcp_servers.verity-one] TOML block
             for ~/.codex/config.toml; the installer does NOT write that
             file automatically.

  doctor     Default: spawn the installed MCP server, run the 4-step MCP
             handshake, and verify the rung-1 tools work against the local
             VO node. One-line summary; exits 0 on pass, 1 on fail.
             --client claude-desktop: read-only validation of the
               Claude Desktop config — checks that mcpServers.verity-one
               exists, that command + args[0] are absolute + present on
               disk, that VO_URL is set and VO_TOKEN is absent.
             --client codex: same read-only checks against
               ~/.codex/config.toml for the [mcp_servers.verity-one]
               section. Never mutates either file.

  serve      Manual/debug entrypoint. Runs the stdio MCP server in the
             current process. NOTE: this is NOT the install contract —
             agent clients spawn node <installed>/dist/server.js directly,
             not \`vo-mcp serve\`.

RUNG-1 TOOLS
  ${TOOL_NAMES.join("\n  ")}

REFERENCES
  docs/VO-MCP-SERVER-CONTRACT.md    (binding design contract)
  docs/VO-MCP-R0-READINESS.md        (footprint + hand-proof)
`;

function parseArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main(): Promise<void> {
  // A CLI that writes to stdout must not crash when its consumer closes the
  // pipe early — e.g. `vo-mcp install --client generic | head` or `| grep -q`.
  // Without this, the next stdout.write throws an unhandled EPIPE and the
  // process exits non-zero (which broke the release smoke's `… | grep -q`).
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`vo-mcp ${VERSION}\n`);
    return;
  }

  if (cmd === "install") {
    const raw = parseArg(argv, "--client");
    if (!raw) {
      process.stderr.write(
        `vo-mcp install: --client is required (${SUPPORTED_CLIENT_TARGETS.join(" | ")})\n`,
      );
      process.exit(1);
    }
    const client = parseClientTarget(raw);
    if (!client) {
      process.stderr.write(
        `vo-mcp install: unknown --client ${JSON.stringify(raw)}. ` +
          `Supported: ${SUPPORTED_CLIENT_TARGETS.join(", ")} ` +
          `(cursor, zed also recognized but not implemented — use --client generic for those).\n`,
      );
      process.exit(1);
    }
    try {
      install({ client, force: hasFlag(argv, "--force") });
    } catch (e) {
      process.stderr.write(`vo-mcp install: ${(e as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "doctor") {
    const rawClient = parseArg(argv, "--client");
    if (rawClient !== undefined) {
      if (rawClient !== "claude-desktop" && rawClient !== "codex") {
        process.stderr.write(
          `vo-mcp doctor: --client must be one of claude-desktop, codex ` +
            `(got ${JSON.stringify(rawClient)}).\n` +
            `Omit --client to run the default live MCP handshake against the installed server.\n`,
        );
        process.exit(1);
      }
      const ok = doctorClient({ client: rawClient as DoctorClientTarget });
      process.exit(ok ? 0 : 1);
    }
    const ok = await doctor();
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "serve") {
    await runServer();
    return;
  }

  process.stderr.write(`vo-mcp: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`vo-mcp: fatal: ${(e as Error).message}\n`);
  if ((e as Error).stack) process.stderr.write((e as Error).stack + "\n");
  process.exit(1);
});
