/**
 * Shared-library install() + runtime-injection tests —
 * VO-MCP-TENANT-DEFAULT-FIRST-RUN-PR-2.
 *
 * The critical invariant exercised here: `install(opts, runtime)`
 * writes `runtime.nodeBin` (not `process.execPath`) into the
 * generic-client JSON block and uses `runtime.sourceDist` (not
 * `import.meta.url`) as the copy source. That is what lets `vo mcp
 * install` run under Bun without corrupting the install contract.
 *
 * Every test overrides HOME so the real filesystem stays untouched.
 * Each test cleans up its temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCodexTomlBlock,
  install,
  parseClientTarget,
  resolveDefaultInstallRuntime,
  CLIENT_TARGETS,
  SUPPORTED_CLIENT_TARGETS,
  type InstallRuntime,
} from "./install.js";

// ── Test fixture: a fake built mcp package under a tmp dir ────────────

function makeFakePackage(): { packageRoot: string; sourceDist: string; cleanup: () => void } {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vo-mcp-pkg-"));
  const sourceDist = path.join(packageRoot, "dist");
  fs.mkdirSync(sourceDist, { recursive: true });
  // Minimal dist contents — install() copies the directory verbatim, it
  // does not inspect the file contents.
  fs.writeFileSync(path.join(sourceDist, "server.js"), "// fake server\n");
  fs.writeFileSync(path.join(sourceDist, "cli.js"), "// fake cli\n");
  fs.writeFileSync(path.join(sourceDist, "install.js"), "// fake install\n");
  // node_modules (install refuses without it)
  const nm = path.join(packageRoot, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, ".keep"), "");
  // Minimal package.json so pruneDevDeps has something to read.
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "vo-mcp", version: "0.1.0", devDependencies: {} }),
  );
  return {
    packageRoot,
    sourceDist,
    cleanup: () => { try { fs.rmSync(packageRoot, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function withFakeHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vo-mcp-home-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = priorHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Narrow-type proxy — install() uses the (chunk) single-arg form.
  (process.stdout as unknown as { write: (s: string | Uint8Array) => boolean }).write = (s) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return chunks.join("");
}

// ── Runtime injection — the key contract ─────────────────────────────

describe("install() — runtime parameter flows through", () => {
  let pkg: ReturnType<typeof makeFakePackage>;
  beforeEach(() => { pkg = makeFakePackage(); });
  afterEach(() => pkg.cleanup());

  test("--client generic writes runtime.nodeBin into the printed JSON block (NOT process.execPath)", () => {
    withFakeHome(() => {
      const runtime: InstallRuntime = {
        nodeBin: "/fake/absolute/path/to/node",
        sourceDist: pkg.sourceDist,
        packageRoot: pkg.packageRoot,
      };
      const out = captureStdout(() => install({ client: "generic", force: false }, runtime));
      // Primary assertion: the generic JSON block carries the injected
      // nodeBin verbatim. If the installer had fallen back to
      // `process.execPath`, the block would carry the bun/tsx/node
      // executable the test runner is using, not /fake/...
      expect(out).toContain("/fake/absolute/path/to/node");
      // And: process.execPath (bun under `bun test`) must NOT appear as
      // a `command` value — if it did, the runtime param was ignored.
      expect(out).not.toMatch(new RegExp(`"command":\\s*"${escapeForRegex(process.execPath)}"`));
    });
  });

  test("--client generic copies from runtime.sourceDist (NOT mcp/src/)", () => {
    withFakeHome((home) => {
      const runtime: InstallRuntime = {
        nodeBin: "/fake/node",
        sourceDist: pkg.sourceDist,
        packageRoot: pkg.packageRoot,
      };
      captureStdout(() => install({ client: "generic", force: false }, runtime));
      // The install copied the fake dist into ~/.vo/mcp/dist. Verify
      // the contents match the fake (not anything from mcp/src).
      const installedServer = path.join(home, ".vo", "mcp", "dist", "server.js");
      expect(fs.existsSync(installedServer)).toBe(true);
      expect(fs.readFileSync(installedServer, "utf-8")).toBe("// fake server\n");
    });
  });

  test("launcher script bakes in runtime.nodeBin (NOT process.execPath)", () => {
    withFakeHome((home) => {
      const runtime: InstallRuntime = {
        nodeBin: "/fake/node",
        sourceDist: pkg.sourceDist,
        packageRoot: pkg.packageRoot,
      };
      captureStdout(() => install({ client: "generic", force: false }, runtime));
      const launcher = fs.readFileSync(path.join(home, ".vo", "mcp", "bin", "vo-mcp"), "utf-8");
      expect(launcher).toContain('"/fake/node"');
      expect(launcher).not.toContain(`"${process.execPath}"`);
    });
  });

  test("node_modules workspace symlinks are DEREFERENCED — installed tree is self-contained (survives repo deletion)", () => {
    // Simulate the `@verity-one/vault-root` workspace dep: a node_modules entry
    // whose files are symlinks pointing OUTSIDE the package (into the "repo").
    // install() must copy them as REAL files so ~/.vo/mcp keeps working after
    // the repo is deleted/moved (docs/VO-MCP-SERVER-CONTRACT.md). Regression
    // guard for the Node-cpSync-dereference bug (batch 15 L1-1).
    const externalTarget = `${pkg.packageRoot}-ext-ws.js`; // OUTSIDE the package
    fs.writeFileSync(externalTarget, "// real workspace-dep file\n");
    try {
      const wsDir = path.join(pkg.packageRoot, "node_modules", "@scope", "ws");
      fs.mkdirSync(wsDir, { recursive: true });
      fs.symlinkSync(externalTarget, path.join(wsDir, "index.js")); // escaping symlink
      withFakeHome((home) => {
        const runtime: InstallRuntime = { nodeBin: "/fake/node", sourceDist: pkg.sourceDist, packageRoot: pkg.packageRoot };
        captureStdout(() => install({ client: "generic", force: false }, runtime));
        const installed = path.join(home, ".vo", "mcp", "node_modules", "@scope", "ws", "index.js");
        expect(fs.existsSync(installed)).toBe(true);
        expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false); // real file, not a symlink
        expect(fs.readFileSync(installed, "utf-8")).toBe("// real workspace-dep file\n");
        // Belt + suspenders: nothing under installed node_modules escapes ~/.vo/mcp.
        const mcpRoot = fs.realpathSync(path.join(home, ".vo", "mcp"));
        const escaping: string[] = [];
        const walk = (d: string): void => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isSymbolicLink()) {
              let t: string;
              try { t = fs.realpathSync(p); } catch { escaping.push(`${p} (broken)`); continue; }
              if (t !== mcpRoot && !t.startsWith(mcpRoot + path.sep)) escaping.push(`${p} -> ${t}`);
            } else if (e.isDirectory()) walk(p);
          }
        };
        walk(path.join(home, ".vo", "mcp", "node_modules"));
        expect(escaping).toEqual([]);
      });
    } finally {
      try { fs.rmSync(externalTarget, { force: true }); } catch { /* ignore */ }
    }
  });
});

// ── Honest unsupported-client refusal ────────────────────────────────

describe("install() — supported / unsupported client honesty", () => {
  let pkg: ReturnType<typeof makeFakePackage>;
  beforeEach(() => { pkg = makeFakePackage(); });
  afterEach(() => pkg.cleanup());

  test("--client codex prints a Codex TOML block with absolute paths + no VO_TOKEN", () => {
    withFakeHome(() => {
      const runtime: InstallRuntime = {
        nodeBin: "/opt/homebrew/bin/node",
        sourceDist: pkg.sourceDist,
        packageRoot: pkg.packageRoot,
      };
      const out = captureStdout(() =>
        install({ client: "codex", force: false }, runtime),
      );
      // Block boundary
      expect(out).toContain("[mcp_servers.verity-one]");
      // Absolute paths, not relative
      expect(out).toContain(`command = "/opt/homebrew/bin/node"`);
      expect(out).toMatch(/args = \["[^"]*\/\.vo\/mcp\/dist\/server\.js"\]/);
      // Tenant auth resolution: VO_URL only, no VO_TOKEN in the env
      // assignment. (VO_TOKEN may still appear in the human-facing
      // notes that explain its intentional absence.)
      expect(out).toContain(`env = { VO_URL = "http://127.0.0.1:3100" }`);
      const tomlBlockMatch = out.match(
        /\[mcp_servers\.verity-one\][\s\S]*?(?=\n\nNotes)/,
      );
      expect(tomlBlockMatch).not.toBeNull();
      expect(tomlBlockMatch![0]).not.toContain("VO_TOKEN");
      // Paste guidance names the operator's RESOLVED Codex
      // config path — not a tilde literal — so an operator
      // with CODEX_HOME set sees the exact file they need to
      // edit. Shipped shape since
      // VO-MCP-CODEX-INSTALL-ACTION-PR-1 refactored the
      // installer to delegate to `resolveCodexMcpConfigPath`.
      expect(out).toMatch(/\/\.codex\/config\.toml/);
      // Does NOT advertise itself as writing that file for the user
      expect(out).toContain("does NOT write");
    });
  });

  test("buildCodexTomlBlock produces a stable, pasteable TOML fragment", () => {
    const runtime: InstallRuntime = {
      nodeBin: "/Users/test/.nvm/versions/node/v24.5.0/bin/node",
      sourceDist: "/ignored-by-this-function",
      packageRoot: "/ignored-by-this-function",
    };
    const block = buildCodexTomlBlock(runtime);
    const lines = block.trimEnd().split("\n");
    expect(lines[0]).toBe("[mcp_servers.verity-one]");
    expect(lines[1]).toBe(
      `command = "/Users/test/.nvm/versions/node/v24.5.0/bin/node"`,
    );
    // args[0] points at the INSTALLED server path, not sourceDist
    expect(lines[2]).toMatch(
      /^args = \["[^"]*\/\.vo\/mcp\/dist\/server\.js"\]$/,
    );
    expect(lines[3]).toBe(
      `env = { VO_URL = "http://127.0.0.1:3100" }`,
    );
    // Verify the block is self-contained: strings are valid TOML basic
    // strings (JSON-compatible double-quote escaping).
    for (const line of lines.slice(1)) {
      const quoted = line.match(/"[^"\\]*(?:\\.[^"\\]*)*"/g) ?? [];
      for (const q of quoted) expect(() => JSON.parse(q)).not.toThrow();
    }
  });

  test.each(["cursor", "zed"] as const)(
    "--client %s (recognized but not implemented) → throws with honest message",
    (client) => {
      withFakeHome(() => {
        const runtime: InstallRuntime = {
          nodeBin: "/fake/node",
          sourceDist: pkg.sourceDist,
          packageRoot: pkg.packageRoot,
        };
        let caught: Error | undefined;
        try {
          install({ client, force: false }, runtime);
        } catch (e) {
          caught = e as Error;
        }
        expect(caught).toBeDefined();
        expect(caught!.message).toContain(client);
        expect(caught!.message).toContain("not supported");
        expect(caught!.message).toContain("generic");
      });
    },
  );
});

// ── parseClientTarget ─────────────────────────────────────────────────

describe("parseClientTarget", () => {
  test("returns ClientTarget for every known name", () => {
    for (const c of CLIENT_TARGETS) {
      expect(parseClientTarget(c)).toBe(c);
    }
  });

  test("returns null for unknown names", () => {
    expect(parseClientTarget("zsh")).toBeNull();
    expect(parseClientTarget("")).toBeNull();
    expect(parseClientTarget(undefined)).toBeNull();
  });

  test("CLIENT_TARGETS / SUPPORTED drift guards", () => {
    expect([...CLIENT_TARGETS].sort()).toEqual(
      ["claude-desktop", "codex", "cursor", "generic", "zed"],
    );
    expect([...SUPPORTED_CLIENT_TARGETS].sort()).toEqual(
      ["claude-desktop", "codex", "generic"],
    );
  });
});

// ── resolveDefaultInstallRuntime ─────────────────────────────────────

describe("resolveDefaultInstallRuntime", () => {
  test("returns a runtime bag with process.execPath + import.meta.url-derived dist", () => {
    const r = resolveDefaultInstallRuntime();
    expect(path.isAbsolute(r.nodeBin)).toBe(true);
    expect(r.nodeBin).toBe(process.execPath);
    expect(path.isAbsolute(r.sourceDist)).toBe(true);
    expect(path.isAbsolute(r.packageRoot)).toBe(true);
    // `sourceDist` must be the dist/src sibling of `packageRoot` —
    // i.e. its direct parent IS the packageRoot. Contract for the
    // `vo-mcp` binary's default shape.
    expect(path.dirname(r.sourceDist)).toBe(r.packageRoot);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
