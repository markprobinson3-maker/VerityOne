/**
 * `vo-mcp doctor` — spawn the installed MCP server as a child, run the 4-step
 * handshake, verify the registered tool surface and a real recall round-trip,
 * print a single-line summary, exit 0 or 1.
 *
 * Binding behavior per docs/VO-MCP-SERVER-CONTRACT.md:
 *   1. initialize → valid protocolVersion
 *   2. notifications/initialized → no response
 *   3. tools/list → exactly the registered tools in TOOL_NAMES
 *   4. tools/call vo_memory_recall { query: "doctor check" } → HTTP 200, body.ok = true
 *   5. SIGTERM the child, wait for clean exit
 *
 * The rung-0 disposable driver at /tmp/vo-mcp-r0-driver.mjs is the blueprint.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import {
  checkClaudeDesktopConfig,
  checkCodexConfig,
  type ConfigCheckResult,
} from "./client-config-check.js";
import { installedServerPath } from "./install.js";
// VO-MCP-TENANT-DEFAULT-FIRST-RUN-PR-2 (follow-up): import TOOL_NAMES
// from the zero-dep `./tools/names.js` module, NOT from
// `./tools/index.js`. tools/index.ts re-exports TOOL_NAMES from
// names.ts, but importing it from there would transitively pull in
// every tool module (each uses `zod`). That pull crashes the `vo
// mcp doctor` path under a fresh checkout where `mcp/node_modules`
// has not been installed. Doctor only needs the *names* to validate
// the `tools/list` response, so the zero-dep module is the right
// seam. A drift test in `mcp/src/tools/index.test.ts` pins the
// hand-maintained list equal to the derived one.
import { TOOL_NAMES } from "./tools/names.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DoctorOptions {
  serverPath?: string;
  /** Absolute path to Node >= 20 used to spawn the installed server.
   *  REQUIRED when the doctor is invoked from a non-Node runtime
   *  (e.g. `vo mcp doctor` running under Bun) — `process.execPath`
   *  there would be Bun, which does NOT match the
   *  `node <abs>/dist/server.js` install contract. Defaults to
   *  `process.execPath`, which is correct ONLY when the caller is
   *  the `vo-mcp` binary (a real Node entrypoint). */
  nodeBin?: string;
}

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  const serverPath = opts.serverPath || installedServerPath();
  const nodeBin = opts.nodeBin || process.execPath;
  if (!fs.existsSync(serverPath)) {
    process.stderr.write(
      `vo-mcp doctor: server not found at ${serverPath}\n` +
        `vo-mcp doctor: run \`vo mcp install --client claude-desktop\` (or --client generic) first\n`,
    );
    return false;
  }

  const startedAt = Date.now();
  const child = spawn(nodeBin, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Capture child stderr for diagnostic output in case a check fails.
  const childStderrLines: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    for (const line of text.split("\n")) {
      if (line.trim()) childStderrLines.push(line);
    }
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || "rpc error"));
      else entry.resolve(msg.result);
    }
  });

  function request<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15_000);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method: string, params: unknown): void {
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function fail(reason: string, detail?: string): boolean {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    process.stderr.write(`vo-mcp doctor: FAIL — ${reason}\n`);
    if (detail) process.stderr.write(`  detail: ${detail}\n`);
    if (childStderrLines.length > 0) {
      process.stderr.write(`  last child stderr:\n`);
      for (const line of childStderrLines.slice(-5)) {
        process.stderr.write(`    ${line}\n`);
      }
    }
    return false;
  }

  try {
    // 1. initialize
    const initResult = (await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vo-mcp-doctor", version: "0.1.0" },
    })) as { protocolVersion?: string; serverInfo?: { name?: string } };

    if (!initResult?.protocolVersion) {
      return fail("initialize did not return a protocolVersion");
    }
    if (initResult.serverInfo?.name !== "vo-mcp") {
      return fail(`unexpected serverInfo.name: ${initResult.serverInfo?.name}`);
    }

    // 2. initialized notification
    notify("notifications/initialized", {});

    // 3. tools/list
    const listResult = (await request("tools/list", {})) as {
      tools?: Array<{ name: string }>;
    };
    const toolNames = (listResult?.tools || []).map((t) => t.name).sort();
    const expected = [...TOOL_NAMES].sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
      return fail(
        "tools/list did not return the expected registered tool surface",
        `got: ${JSON.stringify(toolNames)} expected: ${JSON.stringify(expected)}`,
      );
    }

    // 4. tools/call vo_memory_recall
    const callResult = (await request("tools/call", {
      name: "vo_memory_recall",
      arguments: { query: "doctor check" },
    })) as {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    if (callResult?.isError) {
      const errText = callResult.content?.[0]?.text || "";
      return fail("vo_memory_recall returned isError=true", errText.slice(0, 300));
    }
    const recallText = callResult?.content?.[0]?.text;
    if (!recallText) {
      return fail("vo_memory_recall returned empty content");
    }
    let recallBody: { ok?: boolean; primary_memories?: unknown[] };
    try {
      recallBody = JSON.parse(recallText);
    } catch (e) {
      return fail("vo_memory_recall response body is not JSON", (e as Error).message);
    }
    if (recallBody.ok !== true) {
      return fail("vo_memory_recall returned ok=false", recallText.slice(0, 300));
    }
    if (!Array.isArray(recallBody.primary_memories)) {
      return fail("vo_memory_recall missing primary_memories array");
    }

    // 5. clean shutdown
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      let done = false;
      const finalize = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finalize);
      setTimeout(finalize, 2000);
    });

    const ms = Date.now() - startedAt;
    process.stdout.write(
      `vo-mcp doctor: OK (${TOOL_NAMES.length} tools, recall ok, ${ms}ms)\n`,
    );
    return true;
  } catch (e) {
    return fail((e as Error).message);
  }
}

export { installedServerPath };

// ── Client-aware read-only config check ─────────────────────────────

/** Supported client targets for `vo-mcp doctor --client <name>`.
 *  Matches the installer's SUPPORTED_CLIENT_TARGETS minus `generic`
 *  (generic has no on-disk config file to validate). */
export type DoctorClientTarget = "claude-desktop" | "codex";

export interface DoctorClientOptions {
  client: DoctorClientTarget;
  /** Override the config path. Real callers let it default to the
   *  per-platform / per-client location. Tests pass a tmp path. */
  configPath?: string;
  /** Override the expected installed server path. Defaults to
   *  `~/.vo/mcp/dist/server.js`. */
  expectedServerPath?: string;
}

/**
 * Read-only client-config check. Reports each check as
 * `pass|warn|fail` and returns a non-zero overall exit when any
 * `fail` is present. Never mutates the operator's config.
 *
 * Companion to the existing `doctor()` function. That one spawns
 * the installed server and runs a live MCP handshake; this one
 * answers the preconditions-on-disk question:
 *
 *   - is the client's config file actually present?
 *   - does it carry a `verity-one` entry?
 *   - do the paths in that entry point at files that exist?
 *   - is VO_URL set; is VO_TOKEN correctly absent?
 *
 * A green `doctor --client <name>` plus a green `doctor` means
 * everything BUT the GUI's own acceptance of the config is
 * verified. GUI acceptance itself stays manual by design.
 */
export function doctorClient(opts: DoctorClientOptions): boolean {
  let result: ConfigCheckResult;
  if (opts.client === "claude-desktop") {
    result = checkClaudeDesktopConfig({
      configPath: opts.configPath,
      expectedServerPath: opts.expectedServerPath,
    });
  } else if (opts.client === "codex") {
    result = checkCodexConfig({
      configPath: opts.configPath,
      expectedServerPath: opts.expectedServerPath,
    });
  } else {
    process.stderr.write(
      `vo-mcp doctor: --client must be one of claude-desktop, codex (got ${JSON.stringify(
        // Narrow "never" for diagnostic output.
        opts.client as unknown as string,
      )})\n`,
    );
    return false;
  }

  const label = opts.client === "claude-desktop" ? "Claude Desktop" : "Codex";
  const header = `vo-mcp doctor --client ${opts.client}`;
  process.stdout.write(`${header}: ${label} config at ${result.config_path}\n`);

  let failCount = 0;
  let warnCount = 0;
  for (const check of result.checks) {
    const mark =
      check.status === "pass" ? "  [PASS]" : check.status === "warn" ? "  [WARN]" : "  [FAIL]";
    const detail = check.detail ? ` — ${check.detail}` : "";
    process.stdout.write(`${mark} ${check.name}${detail}\n`);
    if (check.status === "fail") failCount++;
    if (check.status === "warn") warnCount++;
  }

  if (result.ok && warnCount === 0) {
    process.stdout.write(
      `${header}: OK (${result.checks.length} checks passed). Next manual step: restart ${label} and confirm the verity-one tools appear.\n`,
    );
    return true;
  }
  if (result.ok) {
    process.stdout.write(
      `${header}: OK with ${warnCount} warning(s). Next manual step: restart ${label} and confirm the verity-one tools appear.\n`,
    );
    return true;
  }
  process.stderr.write(
    `${header}: FAIL — ${failCount} check(s) failed, ${warnCount} warning(s). See [FAIL] lines above for exact remediation.\n`,
  );
  return false;
}
