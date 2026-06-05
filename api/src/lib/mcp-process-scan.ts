/**
 * MCP process scanner —
 * VO-FEDERATION-ACTIVITY-DASHBOARD-PR-1 (rung 7 impl).
 *
 * Enumerates running MCP server processes on the local machine by
 * shelling out to `ps -eo pid,lstart,command` and filtering for
 * commands whose argv includes the canonical MCP server path as its
 * own token
 * (`~/.vo/mcp/dist/server.js`).
 *
 * Rationale — MCP transport is stdio. Every MCP client spawns an
 * independent `server.js` process with no shared parent, so there is
 * no in-memory connection registry to enumerate. A process scan is
 * the cheapest honest way to surface live local presence without
 * introducing a new write path (which Q4=A rules out).
 *
 * Per-client detail is intentionally PID-level only. Rich per-session
 * metadata (tool history, last activity) would require a persisted
 * registry — deferred to a follow-on rung per Q4=A.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface McpProcessDescriptor {
  /** OS process ID. Only stable for the lifetime of the process. */
  pid: number;
  /** ISO-8601 timestamp derived from `ps lstart`. Null when the
   *  platform's `ps` output cannot be parsed reliably. */
  started_at: string | null;
}

/** Path to the canonical MCP server entry. MCP clients spawn
 *  `<node> <this path>` per the install contract in
 *  `mcp/src/client-config-check.ts` + `mcp/src/install.ts`. */
export function mcpServerEntryPath(): string {
  return path.join(os.homedir(), ".vo", "mcp", "dist", "server.js");
}

/** Shell out to `ps` and return the raw stdout. Injectable via the
 *  `psRunner` option so unit tests can supply fixture output without
 *  actually spawning a shell. Any runner failure is treated as
 *  "no visible MCP clients" — the dashboard must not crash because
 *  process enumeration is unavailable. */
export interface ListActiveMcpClientsOptions {
  psRunner?: () => Promise<string>;
  /** Override the path match — primarily for testing. Default is the
   *  canonical MCP server entry. */
  entryPath?: string;
}

export async function listActiveMcpClients(
  opts: ListActiveMcpClientsOptions = {},
): Promise<McpProcessDescriptor[]> {
  const entry = opts.entryPath ?? mcpServerEntryPath();
  let raw = "";
  try {
    raw = opts.psRunner ? await opts.psRunner() : await runPsDefault();
  } catch {
    raw = "";
  }
  return parsePsOutput(raw, entry);
}

/** Default `ps` runner. Shells out with `stdio: ["ignore", "pipe",
 *  "ignore"]` so any stderr noise does not pollute the output. Returns
 *  an empty string on any failure so the caller never throws. */
async function runPsDefault(): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      const proc = spawn("ps", ["-eo", "pid,lstart,command"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let buf = "";
      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
      });
      const child = proc as unknown as {
        on(event: "close" | "error", listener: (...args: unknown[]) => void): void;
      };
      child.on("close", () => resolve(buf));
      child.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

/** Parse `ps -eo pid,lstart,command` output.
 *
 * Columns on macOS + Linux BSD-ps both render `lstart` as 5 tokens
 * (`DayOfWeek Mon DD HH:MM:SS YYYY`), separated from the command by
 * whitespace. We walk each line, find the MCP entry path in the
 * command column, and pull PID + lstart.
 */
export function parsePsOutput(
  raw: string,
  entryPath: string,
): McpProcessDescriptor[] {
  const out: McpProcessDescriptor[] = [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Header row: "PID STARTED COMMAND" or similar — skip.
    if (/^PID\b/i.test(line)) continue;
    // Tokenize by whitespace. First token is PID; next 5 are lstart;
    // remainder is command.
    const tokens = line.split(/\s+/);
    if (tokens.length < 7) continue;
    const pidStr = tokens[0];
    const pid = Number(pidStr);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    // Precise command match: the entry path must appear as its own argv
    // token (ruling out false positives where the path appears inside
    // a longer argument).
    const commandTokens = tokens.slice(6);
    if (!commandTokens.includes(entryPath)) continue;

    const lstartTokens = tokens.slice(1, 6).join(" ");
    const started_at = parseLstart(lstartTokens);
    out.push({ pid, started_at });
  }
  return out;
}

/** Parse `ps lstart` format `DayOfWeek Mon DD HH:MM:SS YYYY` to ISO
 *  8601. Returns null on unparseable input so the caller never crashes
 *  on exotic locales. */
function parseLstart(lstart: string): string | null {
  const d = new Date(lstart);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}
