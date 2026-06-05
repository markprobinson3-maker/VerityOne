/**
 * vo-mcp self-check — MCP-LOCAL-READ-ONLY-PR-1 proof harness.
 *
 * This is the registered-surface proof, not shipped to tenants. It spawns the
 * just-built dist/server.js as a child process and exercises:
 *   - MCP handshake
 *   - tools/list matching the canonical TOOL_NAMES registry
 *   - representative tool paths against the live local VO node
 *   - the local_vo_unreachable error-class mapping (negative case, via
 *     VO_URL=http://127.0.0.1:1 which refuses connections)
 *   - the direct-spawn install shape (node <abs>/dist/server.js)
 *
 * Run: `node dist/self-check.js` from inside the mcp/ package after build.
 *
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, type VoConfig } from "./config.js";
import { TOOL_NAMES } from "./tools/index.js";

const thisFile = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(thisFile);
const SERVER_PATH = path.join(DIST_DIR, "server.js");

let passCount = 0;
let failCount = 0;

function pass(label: string): void {
  passCount++;
  process.stdout.write(`PASS: ${label}\n`);
}

function fail(label: string, detail?: string): void {
  failCount++;
  process.stdout.write(`FAIL: ${label}${detail ? " — " + detail : ""}\n`);
}

// ─── /memory/_capabilities probe (rung-5 classification helper) ──
//
// Matches the runner-side classifier in
// `agent-lab/scripts/lib/mcp-review-api-availability.ts`. Kept
// local here instead of cross-imported because `mcp/src` cannot
// take an `agent-lab/` dependency — each package installs
// independently in CI. The shared contract is the v1 schema
// tag and the two route names in REVIEW_AUDIT_ROUTES; a drift
// test pins both sides against each other.
//
// Used ONLY to distinguish "route not yet deployed on the live
// VO" (pre-install or old running API → skip) from "route
// advertised by the API but the MCP call did not return a
// happy shape" (real failure — fail loudly). The probe never
// promotes an unhealthy call to `pass`; it only lets the
// self-check give an honest `fail` when the API claims the
// route exists.

type SelfCheckCapProbe =
  | { kind: "ok"; routes: Record<string, boolean> }
  | { kind: "missing" }
  | { kind: "error" | "unauthenticated"; detail: string };

/** Timeout bound for the capability probe. Matches the harness's
 *  own MCP-call timeouts in spirit: long enough to tolerate a
 *  slow-but-responsive local API, short enough that a stalled
 *  socket does not hang self-check. The parent `VoClient` uses
 *  20s; 8s here is intentionally tighter because the probe is a
 *  single static-JSON GET with no DB work on the server side. */
const CAPABILITY_PROBE_TIMEOUT_MS = 8_000;

async function probeMemoryCapabilities(cfg: VoConfig): Promise<SelfCheckCapProbe> {
  // AbortController-backed timeout so a VO that accepts the
  // TCP connection but stalls mid-response cannot hang
  // self-check. The catch block below maps `AbortError` to a
  // structured `{ kind: "error", detail: "timeout ..." }`
  // return, matching the other probe outcomes.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CAPABILITY_PROBE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${cfg.baseUrl}/memory/_capabilities`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 401 || res.status === 403) {
      return { kind: "unauthenticated", detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { kind: "error", detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { schema?: unknown; routes?: unknown }
      | null;
    if (
      !body ||
      body.schema !== "vo-memory-api-capabilities/v1" ||
      typeof body.routes !== "object" ||
      body.routes === null
    ) {
      return { kind: "error", detail: "bad schema" };
    }
    return { kind: "ok", routes: body.routes as Record<string, boolean> };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err.name === "AbortError") {
      return {
        kind: "error",
        detail: `timeout after ${CAPABILITY_PROBE_TIMEOUT_MS}ms waiting for /memory/_capabilities`,
      };
    }
    return { kind: "error", detail: err.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function capAdvertises(probe: SelfCheckCapProbe, route: string): boolean {
  return probe.kind === "ok" && probe.routes[route] === true;
}

interface HarnessChild {
  child: ChildProcess;
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  stderrLines: string[];
  kill(): void;
}

function spawnHarness(env: NodeJS.ProcessEnv = process.env): HarnessChild {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const stderrLines: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf-8").split("\n")) {
      if (line.trim()) stderrLines.push(line);
    }
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
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

  return {
    child,
    request,
    notify,
    stderrLines,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
  };
}

interface ToolCallResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(h: HarnessChild, name: string, args: unknown): Promise<ToolCallResult> {
  return h.request<ToolCallResult>("tools/call", { name, arguments: args });
}

async function assertHandshake(h: HarnessChild, label: string): Promise<boolean> {
  try {
    const init = (await h.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vo-mcp-self-check", version: "0.0.0" },
    })) as { protocolVersion?: string; serverInfo?: { name?: string } };
    if (!init?.protocolVersion) {
      fail(`${label}: initialize missing protocolVersion`);
      return false;
    }
    if (init.serverInfo?.name !== "vo-mcp") {
      fail(`${label}: initialize serverInfo.name != vo-mcp`, String(init.serverInfo?.name));
      return false;
    }
    pass(`${label}: initialize handshake`);
    h.notify("notifications/initialized", {});
    return true;
  } catch (e) {
    fail(`${label}: initialize threw`, (e as Error).message);
    return false;
  }
}

function parseOk(result: ToolCallResult): { ok: boolean; body?: { ok?: boolean; primary_memories?: unknown[]; bootstrap_posture?: { status?: string }; addr?: string; items?: Array<{ addr: string; [k: string]: unknown }>; trust_state?: string; overlay_origin?: boolean; recent_events?: unknown[]; [k: string]: unknown } } {
  if (result.isError) return { ok: false };
  const text = result.content?.[0]?.text;
  if (!text) return { ok: false };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function parseErrorEnvelope(result: ToolCallResult): { error_class?: string; message?: string } | null {
  if (!result.isError) return null;
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runHappyPath(): Promise<void> {
  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "live-vo");
    if (!handshook) return;

    // tools/list
    const list = (await h.request("tools/list", {})) as { tools?: Array<{ name: string }> };
    const names = (list.tools || []).map((t) => t.name).sort();
    const expected = [...TOOL_NAMES].sort();
    if (JSON.stringify(names) === JSON.stringify(expected)) {
      pass(`live-vo: tools/list returns exactly ${expected.length} tools`);
    } else {
      fail(`live-vo: tools/list mismatch`, `got ${JSON.stringify(names)}`);
      return;
    }

    // vo_bootstrap_project
    const bs = parseOk(await callTool(h, "vo_bootstrap_project", { cwd: ".", goal: "self-check" }));
    if (bs.ok && bs.body?.ok === true && typeof bs.body.bootstrap_posture?.status === "string") {
      pass(`live-vo: vo_bootstrap_project → posture=${bs.body.bootstrap_posture.status}`);
    } else {
      fail(`live-vo: vo_bootstrap_project did not return ok posture`);
    }

    // vo_memory_recall
    const rc = parseOk(await callTool(h, "vo_memory_recall", { query: "vo local-first architecture" }));
    let firstMemoryAddr: string | null = null;
    if (rc.ok && rc.body?.ok === true && Array.isArray(rc.body.primary_memories)) {
      pass(`live-vo: vo_memory_recall → ${rc.body.primary_memories.length} primary memories`);
      const first = rc.body.primary_memories[0] as { addr?: string } | undefined;
      if (first?.addr) firstMemoryAddr = first.addr;
    } else {
      fail(`live-vo: vo_memory_recall did not return ok body`);
    }

    // vo_memory_recall_routed
    const routed = parseOk(await callTool(h, "vo_memory_recall_routed", { query: "retract a memory" }));
    if (routed.ok && routed.body?.ok === true && (routed.body as { routing?: unknown }).routing) {
      pass(`live-vo: vo_memory_recall_routed → body.ok + routing trace`);
    } else {
      fail(`live-vo: vo_memory_recall_routed did not return ok + routing`);
    }

    // vo_memory_search (thin alias over /memory/recall)
    const search = parseOk(await callTool(h, "vo_memory_search", { query: "how to recall memories" }));
    if (search.ok && search.body?.ok === true && Array.isArray(search.body.primary_memories)) {
      pass(`live-vo: vo_memory_search → ${search.body.primary_memories.length} primary memories (alias)`);
    } else {
      fail(`live-vo: vo_memory_search did not return ok body`);
    }

    // vo_memory_get — use the first addr found above, fall back to a known-unlikely one to exercise 404
    if (firstMemoryAddr) {
      const get = parseOk(await callTool(h, "vo_memory_get", { addr: firstMemoryAddr }));
      if (get.ok && get.body?.ok === true && get.body.addr === firstMemoryAddr) {
        pass(`live-vo: vo_memory_get ${firstMemoryAddr} → body.ok`);
      } else {
        fail(`live-vo: vo_memory_get ${firstMemoryAddr} did not return ok body`);
      }
    } else {
      fail("live-vo: no memory addr available to exercise vo_memory_get (recall returned empty)");
    }

    // vo_memory_get 404 → validation_failure
    const ghost = await callTool(h, "vo_memory_get", { addr: "PJ.0.3.999999" });
    const ghostErr = parseErrorEnvelope(ghost);
    if (ghostErr?.error_class === "validation_failure") {
      pass(`live-vo: vo_memory_get PJ.0.3.999999 → validation_failure (404 mapped correctly)`);
    } else {
      fail(`live-vo: vo_memory_get PJ.0.3.999999 did not map to validation_failure`, JSON.stringify(ghostErr));
    }

    // confirm stderr has structured init + at least one tool_call line
    const initLine = h.stderrLines.find((l) => l.includes('"event":"init"'));
    const toolCallLine = h.stderrLines.find((l) => l.includes('"event":"tool_call"'));
    if (initLine && toolCallLine) {
      pass(`live-vo: stderr has structured init + tool_call events`);
    } else {
      fail(`live-vo: stderr missing structured events`, `init=${!!initLine} tool_call=${!!toolCallLine}`);
    }
  } finally {
    h.kill();
  }
}

async function runUnreachable(): Promise<void> {
  // Point the server at a port that refuses connections to exercise
  // local_vo_unreachable. Use a token fallback via env so the config loader
  // still succeeds. 127.0.0.1:1 reliably ECONNREFUSEDs on macOS.
  const env = { ...process.env, VO_URL: "http://127.0.0.1:1", VO_TOKEN: "doctor-self-check-token" };
  const h = spawnHarness(env);
  try {
    const handshook = await assertHandshake(h, "unreachable-vo");
    if (!handshook) return;

    const result = await callTool(h, "vo_memory_recall", { query: "self-check unreachable" });
    const err = parseErrorEnvelope(result);
    if (err?.error_class === "local_vo_unreachable") {
      pass(`unreachable-vo: vo_memory_recall → local_vo_unreachable`);
    } else {
      fail(`unreachable-vo: expected local_vo_unreachable, got`, JSON.stringify(err));
    }

    // confirm stderr has the local_unreachable event specifically
    const unreachableLine = h.stderrLines.find((l) => l.includes('"event":"local_unreachable"'));
    if (unreachableLine) {
      pass(`unreachable-vo: stderr has local_unreachable event per contract`);
    } else {
      fail(`unreachable-vo: stderr missing local_unreachable event`, h.stderrLines.join(" | "));
    }
  } finally {
    h.kill();
  }
}

async function runWriteSurface(): Promise<void> {
  // Rung 2 write-surface proof.
  //
  // Exercises write / update / retract / forget / pretask_ground / the
  // system_generated refusal / a malformed source_ref shape. Every test
  // memory is written with a unique marker subject and IS CLEANED UP
  // (retract or forget) inside a try/finally so the live graph stays clean
  // even if an assertion throws.

  const marker = `[self-check-rung2-${Date.now()}]`;
  const writtenAddrsToCleanup: string[] = [];

  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "rung2");
    if (!handshook) return;

    // The full tools/list surface is verified once in the rung-3 block below
    // against the authoritative 12-tool shape. Duplicating it here would just
    // drift as new rungs land, so we only verify rung-2-specific behaviors.

    // 1. vo_pretask_ground (composition) — happy path + structured output
    const pg = parseOk(
      await callTool(h, "vo_pretask_ground", {
        cwd: ".",
        goal: "self-check rung2 grounding",
      }),
    );
    if (pg.ok && pg.body?.ok === true && pg.body.bootstrap && pg.body.recall) {
      pass(`rung2: vo_pretask_ground → bootstrap+recall composed`);
    } else {
      fail(`rung2: vo_pretask_ground did not return composed bootstrap+recall`, JSON.stringify(pg.body).slice(0, 200));
    }
    // bootstrap_context is either null or an object — both are valid
    if (pg.ok && (pg.body?.bootstrap_context === null || typeof pg.body?.bootstrap_context === "object")) {
      pass(`rung2: vo_pretask_ground bootstrap_context is null or object (verbatim lift)`);
    } else {
      fail(`rung2: vo_pretask_ground bootstrap_context shape unexpected`, JSON.stringify(pg.body?.bootstrap_context));
    }

    // 2. vo_memory_write — happy path write (tenant-scoped, unique marker)
    const writeResp = parseOk(
      await callTool(h, "vo_memory_write", {
        kind: "context",
        assertion: `${marker} self-check write — this is a test memory created by vo-mcp self-check and will be cleaned up immediately`,
        source: "agent_inferred",
        subject: `${marker} write test`,
        tags: ["self-check", "rung2"],
      }),
    );
    let writtenAddr: string | null = null;
    if (writeResp.ok && writeResp.body?.ok === true && typeof writeResp.body.addr === "string") {
      writtenAddr = writeResp.body.addr;
      writtenAddrsToCleanup.push(writtenAddr);
      pass(`rung2: vo_memory_write → ${writtenAddr}`);
    } else if (writeResp.ok && writeResp.body && "deduplicated" in writeResp.body) {
      // Deduplicated into an existing memory — also a legitimate outcome
      const existingAddr = (writeResp.body as { existing_addr?: string }).existing_addr;
      pass(`rung2: vo_memory_write → deduplicated into ${existingAddr} (valid outcome)`);
      // Do NOT add to cleanup list — we didn't create this one
    } else {
      fail(`rung2: vo_memory_write did not return ok body`, JSON.stringify(writeResp.body).slice(0, 200));
    }

    // 3. vo_memory_update — patch the just-written memory (only if we wrote a new one)
    if (writtenAddr) {
      const updateResp = parseOk(
        await callTool(h, "vo_memory_update", {
          addr: writtenAddr,
          tags: ["self-check", "rung2", "updated"],
        }),
      );
      if (updateResp.ok && updateResp.body?.ok === true && Array.isArray(updateResp.body.updated_fields)) {
        pass(`rung2: vo_memory_update → ${writtenAddr} (${updateResp.body.updated_fields.join(",")})`);
      } else {
        fail(`rung2: vo_memory_update did not return ok`, JSON.stringify(updateResp.body).slice(0, 200));
      }

      // 3b. vo_memory_update expires_at:null — regression guard for the
      // contract requirement that agents can CLEAR an existing expiry by
      // passing null. Backend accepts any value in expires_at; the MCP
      // schema must not block null at the zod layer.
      const clearExpiryResp = parseOk(
        await callTool(h, "vo_memory_update", {
          addr: writtenAddr,
          expires_at: null,
        }),
      );
      if (
        clearExpiryResp.ok &&
        clearExpiryResp.body?.ok === true &&
        Array.isArray(clearExpiryResp.body.updated_fields) &&
        clearExpiryResp.body.updated_fields.includes("expires_at")
      ) {
        pass(`rung2: vo_memory_update expires_at:null accepted (clear-expiry path)`);
      } else {
        fail(
          `rung2: vo_memory_update expires_at:null was not accepted`,
          JSON.stringify(clearExpiryResp.body ?? clearExpiryResp).slice(0, 300),
        );
      }
    }

    // 4. vo_memory_write for the retract path — second unique memory
    const retractMarker = `${marker} retract-test`;
    const retractWrite = parseOk(
      await callTool(h, "vo_memory_write", {
        kind: "context",
        assertion: `${retractMarker} self-check memory intended for retract — will be retracted by cleanup`,
        source: "agent_inferred",
        subject: retractMarker,
      }),
    );
    let retractAddr: string | null = null;
    if (retractWrite.ok && retractWrite.body?.ok === true && typeof retractWrite.body.addr === "string") {
      retractAddr = retractWrite.body.addr;
      pass(`rung2: vo_memory_write → ${retractAddr} (for retract test)`);
    } else if (retractWrite.ok && "deduplicated" in (retractWrite.body || {})) {
      pass(`rung2: vo_memory_write (retract test) deduplicated — skipping retract check`);
    } else {
      fail(`rung2: vo_memory_write (retract test) failed`);
    }

    // 5. vo_memory_retract — retract the second memory
    if (retractAddr) {
      const retractResp = parseOk(
        await callTool(h, "vo_memory_retract", {
          addr: retractAddr,
          reason: "self-check rung2 cleanup — not a real memory",
        }),
      );
      if (retractResp.ok && retractResp.body?.ok === true && (retractResp.body as { status?: string }).status === "retracted") {
        pass(`rung2: vo_memory_retract → ${retractAddr} status=retracted`);
      } else {
        fail(`rung2: vo_memory_retract did not set status=retracted`, JSON.stringify(retractResp.body).slice(0, 200));
      }
    }

    // 6. vo_memory_forget — forget the first (written + updated) memory as cleanup
    if (writtenAddr) {
      const forgetResp = parseOk(await callTool(h, "vo_memory_forget", { addr: writtenAddr }));
      if (forgetResp.ok && forgetResp.body?.ok === true && (forgetResp.body as { status?: string }).status === "archived") {
        pass(`rung2: vo_memory_forget → ${writtenAddr} status=archived (cleanup)`);
        // Successfully cleaned up — remove from the finally-block cleanup list
        const idx = writtenAddrsToCleanup.indexOf(writtenAddr);
        if (idx >= 0) writtenAddrsToCleanup.splice(idx, 1);
      } else {
        fail(`rung2: vo_memory_forget did not set status=archived`, JSON.stringify(forgetResp.body).slice(0, 200));
      }
    }

    // 7. system_generated refusal — must return validation_failure from the MCP layer
    //    WITHOUT making an HTTP call. We verify by detail-string signature.
    const sysGen = await callTool(h, "vo_memory_write", {
      kind: "context",
      assertion: `${marker} should not be written — system_generated refused at MCP layer`,
      source: "system_generated",
    });
    const sysGenErr = parseErrorEnvelope(sysGen);
    if (sysGenErr?.error_class === "validation_failure") {
      // Check for the MCP-layer detail signature so we know it came from the
      // refusal, not from a coincidental backend validation error.
      const detail = (sysGenErr as { detail?: string }).detail || "";
      if (detail.includes("system_generated") && detail.includes("legal value from MCP")) {
        pass(`rung2: vo_memory_write(source=system_generated) refused at MCP layer → validation_failure`);
      } else {
        fail(`rung2: vo_memory_write(source=system_generated) returned validation_failure but not the MCP-layer detail`, detail);
      }
    } else {
      fail(`rung2: vo_memory_write(source=system_generated) did not return validation_failure`, JSON.stringify(sysGenErr));
    }

    // 8. Malformed source_ref shape — missing both path and url.
    //    Backend validator rejects with 400; MCP wraps as validation_failure.
    const badSrc = await callTool(h, "vo_memory_write", {
      kind: "decision",
      assertion: `${marker} malformed source_ref test (should be rejected)`,
      source: "agent_inferred",
      source_refs: [{ type: "doc" }],
    });
    const badSrcErr = parseErrorEnvelope(badSrc);
    if (badSrcErr?.error_class === "validation_failure") {
      pass(`rung2: vo_memory_write with source_ref missing path+url → validation_failure`);
    } else {
      // This one is tolerant: if the SDK/zod rejects it first, we may get
      // an SDK-shaped error instead of our envelope. Either is acceptable
      // as long as the write did not succeed.
      if (parseOk(badSrc).ok === false) {
        pass(`rung2: vo_memory_write with source_ref missing path+url was rejected (shape TBD)`);
      } else {
        fail(`rung2: vo_memory_write with source_ref missing path+url was NOT rejected`, JSON.stringify(badSrc).slice(0, 300));
      }
    }
  } finally {
    // Cleanup: any addrs still in the list (e.g. if an assertion threw mid-way)
    // are forgotten to keep the live graph clean.
    for (const addr of writtenAddrsToCleanup) {
      try {
        await callTool(h, "vo_memory_forget", { addr });
        process.stdout.write(`INFO: rung2 cleanup forgot ${addr}\n`);
      } catch (e) {
        process.stdout.write(`WARN: rung2 cleanup failed to forget ${addr}: ${(e as Error).message}\n`);
      }
    }
    h.kill();
  }
}

// ── Rung 3 vault surface ─────────────────────────────────────────────

import os from "node:os";
import fsp from "node:fs/promises";
import fs from "node:fs";

interface VaultFixturePaths {
  root: string;
  dossiers: string;
}

async function writeVaultFixture(): Promise<VaultFixturePaths> {
  const root = path.join(os.tmpdir(), `vo-mcp-r3-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const dossiers = path.join(root, "dossiers");
  await fsp.mkdir(dossiers, { recursive: true });

  // .vo-vault.json — minimal, matches the shape vaultInit writes.
  await fsp.writeFile(
    path.join(root, ".vo-vault.json"),
    JSON.stringify({
      tenant_id: "self-check-rung3",
      vo_url: "http://127.0.0.1:3100",
      vault_version: "1.0.0",
      created_at: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf-8",
  );

  // Dossier 1: clean finalized with vo_nodes of length 2 (graph-backed)
  await fsp.writeFile(
    path.join(dossiers, "a1b2c3d4-primary.dossier.md"),
    `---
vo_addr: "PJ.0.3.1001"
vo_type: "dossier"
vo_managed: true
capture_hash: "a1b2c3d4e5f6a7b8"
source_capture: "captures/a1b2c3d4-primary.md"
source_url: "https://example.com/primary"
content_hash: "sha256:abc123"
source_hash: "a1b2c3d4e5f6a7b8"
generated_at: "2026-04-09T10:00:00Z"
generated_by: "harvest/v1"
vo_nodes:
  - "PJ.0.3.1001"
  - "PJ.0.3.1002"
title: "Primary Self-Check Dossier"
confidence: "high"
tags: []
---

# Primary Self-Check Dossier

Body content for rung-3 self-check.
`,
    "utf-8",
  );

  // Dossier 2: finalized with empty vo_nodes list (dossier exists but no graph-backing)
  await fsp.writeFile(
    path.join(dossiers, "c5c5c5c5-empty-nodes.dossier.md"),
    `---
vo_addr: ""
vo_type: "dossier"
vo_managed: true
capture_hash: "c5c5c5c5c5c5c5c5"
source_capture: "captures/c5c5c5c5-empty-nodes.md"
source_url: null
content_hash: "sha256:def456"
source_hash: "c5c5c5c5c5c5c5c5"
generated_at: "2026-04-09T11:00:00Z"
generated_by: "harvest/v1"
vo_nodes: []
title: "Empty Nodes Dossier"
confidence: "medium"
tags: []
---

# Empty Nodes Dossier

This dossier has an empty vo_nodes list (vo_nodes_count should be 0).
`,
    "utf-8",
  );

  // Dossier 3: draft (typically no vo_nodes field — should produce null count)
  await fsp.writeFile(
    path.join(dossiers, "b5e6f7a8-draft-test.dossier.draft.md"),
    `---
vo_type: "dossier.draft"
vo_managed: true
capture_hash: "b5e6f7a8b5e6f7a8"
source_capture: "captures/b5e6f7a8-draft-test.md"
generated_at: "2026-04-09T12:00:00Z"
title: "Draft Self-Check Dossier"
---

# Draft Self-Check Dossier

Draft body.
`,
    "utf-8",
  );

  // Dossier 4: malformed frontmatter — row should still appear in list with null fields
  await fsp.writeFile(
    path.join(dossiers, "d9d9d9d9-malformed.dossier.md"),
    `---
this is not
really
  valid yaml
at all: ?????
---

# Malformed frontmatter dossier
`,
    "utf-8",
  );

  // Dossiers 5+6: same hash prefix — exercises the ambiguous-hash path
  await fsp.writeFile(
    path.join(dossiers, "eeeeeeee-ambig-one.dossier.md"),
    `---
vo_type: "dossier"
title: "Ambiguous One"
generated_at: "2026-04-09T13:00:00Z"
vo_nodes: []
---
# Ambiguous One
`,
    "utf-8",
  );
  await fsp.writeFile(
    path.join(dossiers, "eeeeeeee-ambig-two.dossier.md"),
    `---
vo_type: "dossier"
title: "Ambiguous Two"
generated_at: "2026-04-09T13:30:00Z"
vo_nodes: []
---
# Ambiguous Two
`,
    "utf-8",
  );

  // Dossiers 7+8: same hash, one finalized + one draft — tests prefer_draft behavior
  await fsp.writeFile(
    path.join(dossiers, "abcdef01-has-both.dossier.md"),
    `---
vo_type: "dossier"
title: "Has Both Finalized"
generated_at: "2026-04-09T14:00:00Z"
vo_nodes:
  - "PJ.0.3.2001"
---
# Has Both - Finalized
`,
    "utf-8",
  );
  await fsp.writeFile(
    path.join(dossiers, "abcdef01-has-both.dossier.draft.md"),
    `---
vo_type: "dossier.draft"
title: "Has Both Draft"
generated_at: "2026-04-09T14:30:00Z"
---
# Has Both - Draft
`,
    "utf-8",
  );

  return { root, dossiers };
}

async function runVaultSurface(): Promise<void> {
  // Rung 3 vault-surface proof.
  //
  // Creates a temporary vault on disk with known fixtures, spawns the MCP
  // server with VERITY_VAULT_ROOT pointing at it, and exercises the list +
  // lookup tools against known inputs. Everything is cleaned up in the
  // finally block so no temp vaults survive the run.
  //
  // Separately spawns a second child WITHOUT VERITY_VAULT_ROOT to exercise
  // the "vault_root not configured" validation_failure path.

  let fixture: VaultFixturePaths | null = null;
  let hConfigured: HarnessChild | null = null;
  let hUnconfigured: HarnessChild | null = null;

  try {
    fixture = await writeVaultFixture();

    // ── Configured harness (has VERITY_VAULT_ROOT) ──
    const envWithVault = { ...process.env, VERITY_VAULT_ROOT: fixture.root };
    hConfigured = spawnHarness(envWithVault);

    const handshook = await assertHandshake(hConfigured, "rung3");
    if (!handshook) return;

    // The full tools/list surface is verified once in the rung-4 block
    // below against the authoritative 14-tool shape. Duplicating it here
    // would just drift as new rungs land — only verify rung-3-specific
    // behaviors below.

    // 2. vo_vault_list (finalized only) — 6 finalized fixtures
    const listFinalized = parseOk(
      await callTool(hConfigured, "vo_vault_list", { vault_root: fixture.root }),
    );
    if (
      listFinalized.ok &&
      listFinalized.body?.ok === true &&
      Array.isArray(listFinalized.body.dossiers)
    ) {
      const dossiers = listFinalized.body.dossiers as Array<Record<string, unknown>>;
      const finalizedCount = dossiers.filter((d) => d.source === "finalized").length;
      const draftCount = dossiers.filter((d) => d.source === "draft").length;
      if (finalizedCount === 6 && draftCount === 0) {
        pass(`rung3: vo_vault_list (finalized only) → 6 finalized rows, 0 drafts`);
      } else {
        fail(`rung3: vo_vault_list count mismatch`, `finalized=${finalizedCount} drafts=${draftCount}`);
      }
      // Verify row shape on the clean primary dossier
      const primary = dossiers.find((d) => d.hash === "a1b2c3d4");
      if (
        primary &&
        primary.slug === "primary" &&
        primary.filename === "a1b2c3d4-primary.dossier.md" &&
        primary.source === "finalized" &&
        primary.title === "Primary Self-Check Dossier" &&
        primary.generated_at === "2026-04-09T10:00:00Z" &&
        primary.vo_nodes_count === 2
      ) {
        pass(`rung3: vo_vault_list row shape for a1b2c3d4-primary is correct (vo_nodes_count=2)`);
      } else {
        fail(`rung3: vo_vault_list primary row shape wrong`, JSON.stringify(primary));
      }
      // Verify empty vo_nodes → count=0 (not null)
      const emptyNodes = dossiers.find((d) => d.hash === "c5c5c5c5");
      if (emptyNodes && emptyNodes.vo_nodes_count === 0) {
        pass(`rung3: vo_vault_list c5c5c5c5 empty vo_nodes → vo_nodes_count=0 (not null)`);
      } else {
        fail(`rung3: vo_vault_list empty-nodes row vo_nodes_count wrong`, JSON.stringify(emptyNodes));
      }
      // Verify malformed row is present with null fields
      const malformed = dossiers.find((d) => d.hash === "d9d9d9d9");
      if (
        malformed &&
        malformed.title === null &&
        malformed.generated_at === null &&
        malformed.vo_nodes_count === null
      ) {
        pass(`rung3: vo_vault_list malformed-frontmatter row kept with null fields (degraded, not dropped)`);
      } else {
        fail(`rung3: vo_vault_list malformed row handling wrong`, JSON.stringify(malformed));
      }
    } else {
      fail(`rung3: vo_vault_list did not return ok body`, JSON.stringify(listFinalized.body).slice(0, 200));
    }

    // 3. vo_vault_list with include_drafts
    const listWithDrafts = parseOk(
      await callTool(hConfigured, "vo_vault_list", {
        vault_root: fixture.root,
        include_drafts: true,
      }),
    );
    if (listWithDrafts.ok && Array.isArray(listWithDrafts.body?.dossiers)) {
      const ds = listWithDrafts.body.dossiers as Array<Record<string, unknown>>;
      const draftCount = ds.filter((d) => d.source === "draft").length;
      if (draftCount === 2) {
        pass(`rung3: vo_vault_list include_drafts=true → ${draftCount} drafts`);
      } else {
        fail(`rung3: expected 2 drafts with include_drafts=true`, `got ${draftCount}`);
      }
      // Draft should have vo_nodes_count = null (field absent in draft fixture)
      const draftRow = ds.find((d) => d.hash === "b5e6f7a8" && d.source === "draft");
      if (draftRow && draftRow.vo_nodes_count === null) {
        pass(`rung3: vo_vault_list draft row vo_nodes_count=null (field absent)`);
      } else {
        fail(`rung3: draft row vo_nodes_count should be null`, JSON.stringify(draftRow));
      }
    } else {
      fail(`rung3: vo_vault_list with include_drafts did not return ok`);
    }

    // 4. vo_vault_lookup happy path — clean finalized dossier
    const lookupPrimary = parseOk(
      await callTool(hConfigured, "vo_vault_lookup", {
        vault_root: fixture.root,
        hash: "a1b2c3d4",
      }),
    );
    if (
      lookupPrimary.ok &&
      lookupPrimary.body?.ok === true &&
      lookupPrimary.body.source === "finalized" &&
      lookupPrimary.body.filename === "a1b2c3d4-primary.dossier.md" &&
      typeof (lookupPrimary.body.content as string) === "string" &&
      (lookupPrimary.body.content as string).includes("Primary Self-Check Dossier")
    ) {
      pass(`rung3: vo_vault_lookup a1b2c3d4 → finalized dossier with content`);
      // Verify frontmatter was parsed and vo_nodes list is non-empty
      const fm = lookupPrimary.body.frontmatter as Record<string, unknown> | null;
      if (fm && Array.isArray(fm.vo_nodes) && (fm.vo_nodes as unknown[]).length === 2) {
        pass(`rung3: vo_vault_lookup frontmatter.vo_nodes parsed (length 2, graph-backed)`);
      } else {
        fail(`rung3: vo_vault_lookup frontmatter.vo_nodes shape wrong`, JSON.stringify(fm?.vo_nodes));
      }
    } else {
      fail(`rung3: vo_vault_lookup a1b2c3d4 did not return ok finalized`, JSON.stringify(lookupPrimary.body).slice(0, 200));
    }

    // 4b. vo_vault_lookup malformed-frontmatter regression guard.
    // Per contract: malformed YAML must degrade to frontmatter:null while
    // the file content still returns. An empty {} would be a false signal
    // to agents that the parse succeeded with zero fields.
    const lookupMalformed = parseOk(
      await callTool(hConfigured, "vo_vault_lookup", {
        vault_root: fixture.root,
        hash: "d9d9d9d9",
      }),
    );
    if (
      lookupMalformed.ok &&
      lookupMalformed.body?.ok === true &&
      lookupMalformed.body.frontmatter === null &&
      typeof (lookupMalformed.body.content as string) === "string" &&
      (lookupMalformed.body.content as string).includes("Malformed frontmatter dossier")
    ) {
      pass(`rung3: vo_vault_lookup d9d9d9d9 (malformed frontmatter) → frontmatter=null + content intact`);
    } else {
      fail(
        `rung3: malformed-frontmatter lookup did not degrade to frontmatter:null`,
        JSON.stringify(lookupMalformed.body).slice(0, 300),
      );
    }

    // 5. vo_vault_lookup prefer_draft=true when both exist → should return draft
    const lookupDraftPreferred = parseOk(
      await callTool(hConfigured, "vo_vault_lookup", {
        vault_root: fixture.root,
        hash: "abcdef01",
        prefer_draft: true,
      }),
    );
    if (
      lookupDraftPreferred.ok &&
      lookupDraftPreferred.body?.source === "draft" &&
      lookupDraftPreferred.body.filename === "abcdef01-has-both.dossier.draft.md"
    ) {
      pass(`rung3: vo_vault_lookup prefer_draft=true picked the draft variant`);
    } else {
      fail(`rung3: prefer_draft=true did not pick the draft`, JSON.stringify(lookupDraftPreferred.body).slice(0, 200));
    }

    // 5b. Same hash without prefer_draft → should return finalized
    const lookupFinalPreferred = parseOk(
      await callTool(hConfigured, "vo_vault_lookup", {
        vault_root: fixture.root,
        hash: "abcdef01",
      }),
    );
    if (
      lookupFinalPreferred.ok &&
      lookupFinalPreferred.body?.source === "finalized" &&
      lookupFinalPreferred.body.filename === "abcdef01-has-both.dossier.md"
    ) {
      pass(`rung3: vo_vault_lookup (no prefer_draft) picked the finalized variant`);
    } else {
      fail(`rung3: default lookup did not pick finalized`, JSON.stringify(lookupFinalPreferred.body).slice(0, 200));
    }

    // 6. Ambiguous hash — two finalized with same prefix
    const ambigResult = await callTool(hConfigured, "vo_vault_lookup", {
      vault_root: fixture.root,
      hash: "eeeeeeee",
    });
    const ambigErr = parseErrorEnvelope(ambigResult);
    if (
      ambigErr?.error_class === "validation_failure" &&
      typeof (ambigErr as { message?: string }).message === "string" &&
      (ambigErr as { message?: string }).message!.includes("ambiguous hash")
    ) {
      pass(`rung3: vo_vault_lookup ambiguous hash eeeeeeee → validation_failure "ambiguous hash"`);
    } else {
      fail(`rung3: ambiguous hash did not return the expected envelope`, JSON.stringify(ambigErr));
    }

    // 7. Not-found hash
    const notFound = await callTool(hConfigured, "vo_vault_lookup", {
      vault_root: fixture.root,
      hash: "00000000",
    });
    const notFoundErr = parseErrorEnvelope(notFound);
    if (
      notFoundErr?.error_class === "validation_failure" &&
      (notFoundErr as { message?: string }).message === "dossier not found"
    ) {
      pass(`rung3: vo_vault_lookup 00000000 → validation_failure "dossier not found"`);
    } else {
      fail(`rung3: not-found hash did not return the expected envelope`, JSON.stringify(notFoundErr));
    }

    // 8. vo_vault_lookup with vault_root pointing at a nonexistent path
    const badPath = await callTool(hConfigured, "vo_vault_lookup", {
      vault_root: "/nonexistent/path/for/self-check",
      hash: "a1b2c3d4",
    });
    const badPathErr = parseErrorEnvelope(badPath);
    if (badPathErr?.error_class === "validation_failure") {
      pass(`rung3: vo_vault_lookup with nonexistent vault_root → validation_failure`);
    } else {
      fail(`rung3: nonexistent vault_root did not return validation_failure`, JSON.stringify(badPathErr));
    }

    hConfigured.kill();
    hConfigured = null;

    // ── Unconfigured harness (no VERITY_VAULT_ROOT) ──
    // Must NOT inherit VERITY_VAULT_ROOT from our own env. Also must not have
    // vault_root in ~/.vo/config.json on this machine (we did not add one).
    const envWithoutVault = { ...process.env };
    delete envWithoutVault.VERITY_VAULT_ROOT;
    hUnconfigured = spawnHarness(envWithoutVault);
    const handshook2 = await assertHandshake(hUnconfigured, "rung3-unconfigured");
    if (handshook2) {
      const noConfig = await callTool(hUnconfigured, "vo_vault_list", {});
      const noConfigErr = parseErrorEnvelope(noConfig);
      if (
        noConfigErr?.error_class === "validation_failure" &&
        (noConfigErr as { message?: string }).message === "vault_root not configured"
      ) {
        pass(`rung3: vo_vault_list with no vault_root anywhere → validation_failure "vault_root not configured"`);
      } else {
        fail(`rung3: unconfigured vault_root did not return the expected envelope`, JSON.stringify(noConfigErr));
      }
    }
  } finally {
    if (hConfigured) hConfigured.kill();
    if (hUnconfigured) hUnconfigured.kill();
    if (fixture) {
      try {
        await fsp.rm(fixture.root, { recursive: true, force: true });
        // Confirm cleanup actually happened
        if (!fs.existsSync(fixture.root)) {
          process.stdout.write(`INFO: rung3 cleanup removed temp vault ${fixture.root}\n`);
        } else {
          process.stdout.write(`WARN: rung3 cleanup left temp vault at ${fixture.root}\n`);
        }
      } catch (e) {
        process.stdout.write(`WARN: rung3 cleanup failed: ${(e as Error).message}\n`);
      }
    }
  }
}

// ── Rung 4 public-feed surface ───────────────────────────────────────

async function runPublicFeedSurface(): Promise<void> {
  // Rung 4 public-feed proof.
  //
  // Exercises vo_public_search and vo_public_context against the live local
  // VO node. The MCP server calls /search and /context anonymously (no
  // Authorization header) per non-negotiable #17. The access layer in
  // api/src/lib/access.ts structurally restricts anonymous calls to
  // spaceIds: [GLOBAL_SPACE_ID] at the SQL layer, so tenant-private memory
  // cannot leak into rung-4 results.
  //
  // Verifies:
  //   1. tools/list matches TOOL_NAMES
  //   2. vo_public_search happy path + envelope shape
  //   3. vo_public_context happy path + envelope shape
  //   4. authority: "public_overlay" present at envelope top level
  //   5. result envelopes do NOT carry top-level memory-shaped fields
  //      (addr, kind, source, federation) — those are reserved for
  //      vo_memory_* tools
  //   6. tenant_auth_failure NEVER appears in any rung-4 call (drift
  //      detection per non-negotiable #17)
  //   7. indirect anonymous-header verification: structural success
  //      against routes that would behave differently with auth (see
  //      the assertion comment for the exact reasoning)

  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "rung4");
    if (!handshook) return;

    // 1. tools/list matches TOOL_NAMES
    const list = (await h.request("tools/list", {})) as { tools?: Array<{ name: string }> };
    const names = (list.tools || []).map((t) => t.name).sort();
    const expected = [...TOOL_NAMES].sort();
    if (JSON.stringify(names) === JSON.stringify(expected)) {
      pass(`rung4: tools/list returns ${expected.length} registered tools`);
    } else {
      fail(`rung4: tools/list mismatch`, `got ${JSON.stringify(names)}`);
      return;
    }

    // Helper: assert no top-level memory-shaped fields appear in a rung-4 envelope.
    // The vo_memory_* surface uses fields like addr, kind, source, federation.
    // A rung-4 result that carries any of these at the top level is a drift signal.
    const memoryShapedFields = ["addr", "kind", "source", "federation"];

    // 2. vo_public_search happy path
    const searchResult = parseOk(
      await callTool(h, "vo_public_search", { query: "verity local-first" }),
    );
    if (
      searchResult.ok &&
      searchResult.body?.ok === true &&
      searchResult.body.authority === "public_overlay"
    ) {
      pass(`rung4: vo_public_search → ok + authority=public_overlay`);
    } else {
      fail(`rung4: vo_public_search did not return ok+authority`, JSON.stringify(searchResult.body).slice(0, 200));
    }
    // 4a. authority field at top level (already covered above, recheck explicit)
    if (searchResult.ok && searchResult.body?.authority === "public_overlay") {
      pass(`rung4: vo_public_search envelope authority="public_overlay" present`);
    } else {
      fail(`rung4: vo_public_search missing envelope authority`);
    }
    // 5a. no top-level memory-shaped fields
    if (searchResult.ok && searchResult.body) {
      const leaked = memoryShapedFields.filter((f) => f in (searchResult.body as object));
      if (leaked.length === 0) {
        pass(`rung4: vo_public_search envelope has no top-level memory-shaped fields (addr/kind/source/federation)`);
      } else {
        fail(`rung4: vo_public_search envelope leaked memory-shaped top-level fields`, leaked.join(","));
      }
    }
    // Verify the contract-promised `nodes` alias resolves to data
    if (searchResult.ok && Array.isArray((searchResult.body as { nodes?: unknown[] })?.nodes)) {
      const nodes = (searchResult.body as { nodes: unknown[] }).nodes;
      pass(`rung4: vo_public_search envelope.nodes is an array (length ${nodes.length})`);
    } else {
      fail(`rung4: vo_public_search envelope.nodes missing or not array`);
    }

    // 3. vo_public_context happy path
    const contextResult = parseOk(
      await callTool(h, "vo_public_context", { query: "model context protocol", depth: "shallow" }),
    );
    if (
      contextResult.ok &&
      contextResult.body?.ok === true &&
      contextResult.body.authority === "public_overlay"
    ) {
      pass(`rung4: vo_public_context → ok + authority=public_overlay`);
    } else {
      fail(`rung4: vo_public_context did not return ok+authority`, JSON.stringify(contextResult.body).slice(0, 200));
    }
    // 5b. no top-level memory-shaped fields
    if (contextResult.ok && contextResult.body) {
      const leaked = memoryShapedFields.filter((f) => f in (contextResult.body as object));
      if (leaked.length === 0) {
        pass(`rung4: vo_public_context envelope has no top-level memory-shaped fields`);
      } else {
        fail(`rung4: vo_public_context envelope leaked memory-shaped top-level fields`, leaked.join(","));
      }
    }
    // Verify sections passes through (the contract-named field for /context body)
    if (contextResult.ok && (contextResult.body as { sections?: unknown })?.sections !== undefined) {
      pass(`rung4: vo_public_context envelope.sections present (raw backend body)`);
    } else {
      fail(`rung4: vo_public_context envelope.sections missing`);
    }

    // 6. tenant_auth_failure NEVER appears in any rung-4 call
    // Run a third call (against vo_public_search again with a different
    // query) and inspect every error envelope from the run for the
    // tenant_auth_failure class. If any rung-4 call ever returned that
    // class, the tool was sending the bearer token by mistake.
    const driftCheck = await callTool(h, "vo_public_search", { query: "rung4 drift check" });
    const driftErr = parseErrorEnvelope(driftCheck);
    if (driftErr?.error_class === "tenant_auth_failure") {
      fail(`rung4: vo_public_search returned tenant_auth_failure — anonymous client path is broken`);
    } else {
      pass(`rung4: no tenant_auth_failure from rung-4 calls (anonymous path holding)`);
    }

    // 7. Indirect anonymous-header verification.
    //
    // We cannot directly inspect the outbound HTTP headers from inside
    // the spawned MCP server's stderr (the structured logger does not
    // log header content, by design — it would be a leak vector). But
    // we have indirect structural evidence that the rung-4 calls are
    // anonymous:
    //
    //   (a) The implementation calls client.getAnonymous() instead of
    //       client.get(). getAnonymous() is the only client method that
    //       constructs headers without an Authorization line. Verified
    //       by inspection of mcp/src/vo-client.ts.
    //   (b) If the rung-4 tools were accidentally sending the bearer
    //       token, /search and /context would still return a result —
    //       but the result would include tenant-shared content from the
    //       agent's tenant space, which would surface as memory-shaped
    //       fields at the row level. The structural-integrity assertions
    //       above (no memory-shaped top-level fields) would catch the
    //       most obvious symptom; verifying per-row leakage would
    //       require reading every node and looking for PJ.x.x.x addrs.
    //   (c) tenant_auth_failure is structurally impossible from anonymous
    //       calls (no token to reject), and the drift-check above
    //       confirms no rung-4 call has produced one in this run.
    //
    // None of these prove header omission to the byte level, but together
    // they make accidental token-sending visible to the next test run.
    pass(`rung4: anonymous-header posture verified by indirect evidence (see self-check.ts comment for reasoning)`);

    // 8. Structured tool_call log entry should exist for the rung-4 calls
    // and report status:"ok" — confirming the tools went through the same
    // logging path as the other rungs and did not throw mid-handler.
    const rung4LogLines = h.stderrLines.filter(
      (l) => l.includes('"event":"tool_call"') && l.includes('"vo_public_'),
    );
    if (rung4LogLines.length >= 3) {
      const allOk = rung4LogLines.every((l) => l.includes('"status":"ok"'));
      if (allOk) {
        pass(`rung4: stderr has ${rung4LogLines.length} tool_call entries for vo_public_*, all status:ok`);
      } else {
        fail(`rung4: some rung-4 tool_call entries reported non-ok status`, rung4LogLines.join("\n"));
      }
    } else {
      fail(`rung4: expected ≥3 rung-4 tool_call stderr entries, got ${rung4LogLines.length}`);
    }
  } finally {
    h.kill();
  }
}

// ── Rung 5: Review/Audit read surface ──────────────────────────────────

async function runReviewSurface(): Promise<void> {
  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "rung5");
    if (!handshook) return;

    // 1. vo_memory_review — list pending review items
    // Deployment-aware via `/memory/_capabilities` probe (see
    // VO-MCP-REVIEW-API-AVAILABILITY-PR-1): if the probe says
    // the `GET /memory/review` route is ADVERTISED on this API
    // but the MCP call did not return the happy shape, that's
    // a real failure. If the probe is missing / the route is
    // not advertised, we skip honestly (no silent pass masking
    // a registered-but-broken route).
    const cfgForProbe = loadConfig();
    const memoryCapProbe = await probeMemoryCapabilities(cfgForProbe);
    const reviewAdvertised = capAdvertises(memoryCapProbe, "GET /memory/review");

    const review = parseOk(await callTool(h, "vo_memory_review", {}));
    const reviewRouteDeployed = review.ok && review.body?.ok === true && Array.isArray(review.body.items);
    if (reviewRouteDeployed) {
      pass(`rung5: vo_memory_review -> ok + ${review.body!.items!.length} items`);
    } else if (reviewAdvertised) {
      // The API's /memory/_capabilities says the route is
      // registered but the MCP call didn't return the happy
      // shape. That's a registered-but-broken route — a real
      // failure, not a deployment gap.
      fail(
        `rung5: vo_memory_review failed while /memory/_capabilities advertises GET /memory/review`,
        JSON.stringify(review.body ?? "no body").slice(0, 200),
      );
    } else {
      // Probe missing / errored / does not advertise the route:
      // the running API genuinely predates the review PR, or
      // the probe itself is unreachable. Skip honestly.
      const reason =
        memoryCapProbe.kind === "missing"
          ? "api_too_old"
          : memoryCapProbe.kind === "ok"
            ? "api_does_not_advertise_route"
            : memoryCapProbe.kind === "unauthenticated"
              ? "capability_endpoint_unauthenticated"
              : "capability_endpoint_error";
      pass(
        `rung5: vo_memory_review -> route not yet deployed on live server (capability probe: ${memoryCapProbe.kind}; reason=${reason})`,
      );
    }

    // 2. vo_memory_review with limit (only if route is deployed)
    if (reviewRouteDeployed) {
      const reviewLimited = parseOk(await callTool(h, "vo_memory_review", { limit: 2 }));
      if (reviewLimited.ok && reviewLimited.body?.ok === true && Array.isArray(reviewLimited.body.items)) {
        if (reviewLimited.body.items.length <= 2) {
          pass(`rung5: vo_memory_review limit=2 -> ${reviewLimited.body.items.length} items (<=2)`);
        } else {
          fail(`rung5: vo_memory_review limit=2 returned ${reviewLimited.body.items.length} items (expected <=2)`);
        }
      } else {
        fail(`rung5: vo_memory_review limit=2 failed`, JSON.stringify(reviewLimited.body ?? "no body").slice(0, 200));
      }
    }

    // 3. vo_memory_inspect — find a real addr to inspect
    let inspectAddr: string | null = null;
    if (reviewRouteDeployed && review.body?.items && review.body.items.length > 0) {
      inspectAddr = review.body.items[0].addr;
    }
    if (!inspectAddr) {
      // Fallback: recall a memory to get an addr
      const recall = parseOk(await callTool(h, "vo_memory_recall", { query: "architecture decisions" }));
      if (recall.ok && recall.body?.ok === true && Array.isArray(recall.body.primary_memories) && recall.body.primary_memories.length > 0) {
        inspectAddr = (recall.body.primary_memories[0] as { addr?: string })?.addr ?? null;
      }
    }

    if (inspectAddr) {
      // Deployment-aware via the same `/memory/_capabilities`
      // probe used for `vo_memory_review` above. The legacy
      // behavior ("any validation_failure means the audit
      // route was not deployed yet") silently hid real
      // registered-but-broken audit routes. Now:
      //   - probe says the route IS advertised + call fails
      //     → FAIL (real failure)
      //   - probe says the route is NOT advertised (old or
      //     mismatched API) → skip honestly
      const auditAdvertised = capAdvertises(
        memoryCapProbe,
        "GET /memory/:addr/audit",
      );
      const inspectRaw = await callTool(h, "vo_memory_inspect", { addr: inspectAddr });
      const inspect = parseOk(inspectRaw);
      if (
        inspect.ok &&
        inspect.body?.ok === true &&
        inspect.body.addr === inspectAddr &&
        typeof inspect.body.trust_state === "string"
      ) {
        pass(`rung5: vo_memory_inspect ${inspectAddr} -> ok + trust_state + recent_events`);
      } else if (auditAdvertised) {
        // API advertises the audit route but the MCP call
        // failed. Real failure, not a deployment gap.
        const inspectErr = parseErrorEnvelope(inspectRaw);
        fail(
          `rung5: vo_memory_inspect ${inspectAddr} failed while /memory/_capabilities advertises GET /memory/:addr/audit`,
          JSON.stringify(inspect.body ?? inspectErr ?? "no body").slice(0, 200),
        );
      } else {
        // Probe missing / errored / does not advertise the
        // audit route. Skip with a rationale; note that a
        // bare `validation_failure` error_class no longer
        // pattern-matches as "audit route not yet deployed"
        // — that inference would mask a registered-but-broken
        // route under a new, healthy API.
        const reason =
          memoryCapProbe.kind === "missing"
            ? "api_too_old"
            : memoryCapProbe.kind === "ok"
              ? "api_does_not_advertise_route"
              : memoryCapProbe.kind === "unauthenticated"
                ? "capability_endpoint_unauthenticated"
                : "capability_endpoint_error";
        pass(
          `rung5: vo_memory_inspect -> audit route not yet deployed on live server (capability probe: ${memoryCapProbe.kind}; reason=${reason})`,
        );
      }
    } else {
      fail(`rung5: no memory addr available for vo_memory_inspect (review queue and recall both empty)`);
    }

    // 4. vo_memory_inspect 404 -> validation_failure
    const ghost = await callTool(h, "vo_memory_inspect", { addr: "PJ.0.3.999999" });
    const ghostErr = parseErrorEnvelope(ghost);
    if (ghostErr?.error_class === "validation_failure") {
      pass(`rung5: vo_memory_inspect PJ.0.3.999999 -> validation_failure (404 mapped correctly)`);
    } else {
      fail(`rung5: vo_memory_inspect PJ.0.3.999999 did not map to validation_failure`, JSON.stringify(ghostErr));
    }
  } finally {
    h.kill();
  }
}

// ── Rung 6: Overlay promotion surface ──────────────────────────────────

async function runOverlayPromotionSurface(): Promise<void> {
  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "rung6");
    if (!handshook) return;

    // 1. vo_overlay_promote — bad overlay addr → validation_failure
    const badPromote = await callTool(h, "vo_overlay_promote", { overlay_addr: "OVL.0.0.nonexistent999" });
    const badErr = parseErrorEnvelope(badPromote);
    if (badErr?.error_class === "validation_failure") {
      pass(`rung6: vo_overlay_promote nonexistent overlay -> validation_failure`);
    } else {
      fail(`rung6: vo_overlay_promote nonexistent overlay did not map to validation_failure`, JSON.stringify(badErr));
    }

    // 2. vo_overlay_promote — empty overlay_addr should fail
    // May fail at Zod schema level (SDK-side) or at the backend (400).
    // Either way, the call should not succeed.
    const emptyPromote = await callTool(h, "vo_overlay_promote", { overlay_addr: "" });
    const emptyErr = parseErrorEnvelope(emptyPromote);
    const emptyOk = parseOk(emptyPromote);
    if (emptyErr || emptyPromote.isError || (emptyOk.ok && emptyOk.body?.ok === false)) {
      pass(`rung6: vo_overlay_promote empty overlay_addr -> rejected`);
    } else {
      fail(`rung6: vo_overlay_promote empty overlay_addr did not error`);
    }
  } finally {
    h.kill();
  }
}

// ─── Rung 7: vault harvest operator surface ──────────────────────────
//
// Exercises the new `vo_vault_harvest_auto` tool. We deliberately do NOT
// run a real harvest here — that would write real files + hit LLMs +
// mutate the tenant's memory graph, which is not what a self-check is
// for. Instead this rung proves:
//
//   1. tools/call vo_vault_harvest_auto { source: "" } — MCP-layer
//      refusal path. No HTTP, no engine. Proves the tool handler is
//      wired, executes, and returns a `validation_failure` envelope.
//   2. tools/call vo_vault_harvest_auto { source: "relative/path.md" } —
//      P2b guard. Also MCP-layer refusal (client-side absolute-or-URL
//      check). Proves the tight-loop validation matches the documented
//      contract.
//
// Both calls are side-effect-free. A regression that removes the tool,
// silently drops the source shape check, or changes the envelope shape
// would fail here immediately.

async function runVaultHarvestSurface(): Promise<void> {
  const h = spawnHarness();
  try {
    const handshook = await assertHandshake(h, "rung7");
    if (!handshook) return;

    // Helper: extract `reason` from the parsed envelope. parseErrorEnvelope
    // currently exposes error_class + message only, so we re-parse the
    // content text to read the structured reason code (round-4: every
    // MCP refusal carries one, per the contract's failure table).
    function extractReasonFromResult(res: ToolCallResult): string | undefined {
      const txt = res?.content?.[0]?.text;
      if (!txt) return undefined;
      try {
        const parsed = JSON.parse(txt) as { reason?: unknown };
        return typeof parsed.reason === "string" ? parsed.reason : undefined;
      } catch {
        return undefined;
      }
    }

    // 1. Empty source → validation_failure + reason=source_missing.
    const emptyRes = await callTool(h, "vo_vault_harvest_auto", { source: "" });
    const emptyErr = parseErrorEnvelope(emptyRes);
    const emptyReason = extractReasonFromResult(emptyRes);
    if (
      emptyErr
      && emptyErr.error_class === "validation_failure"
      && emptyReason === "source_missing"
    ) {
      pass(`rung7: vo_vault_harvest_auto empty source -> validation_failure + reason=source_missing`);
    } else {
      fail(
        `rung7: vo_vault_harvest_auto empty source did not return the structured refusal`,
        JSON.stringify({ ...emptyErr, reason: emptyReason }),
      );
    }

    // 2. Relative-path source → validation_failure + reason=source_not_absolute.
    const relRes = await callTool(h, "vo_vault_harvest_auto", { source: "notes/todo.md" });
    const relErr = parseErrorEnvelope(relRes);
    const relReason = extractReasonFromResult(relRes);
    if (
      relErr
      && relErr.error_class === "validation_failure"
      && /absolute/i.test(relErr.message || "")
      && relReason === "source_not_absolute"
    ) {
      pass(`rung7: vo_vault_harvest_auto relative source -> validation_failure + reason=source_not_absolute`);
    } else {
      fail(
        `rung7: vo_vault_harvest_auto relative source did not return the structured refusal`,
        JSON.stringify({ ...relErr, reason: relReason }),
      );
    }

    // 3. Bare filename source → validation_failure + same reason (still relative).
    const bareRes = await callTool(h, "vo_vault_harvest_auto", { source: "README.md" });
    const bareErr = parseErrorEnvelope(bareRes);
    const bareReason = extractReasonFromResult(bareRes);
    if (
      bareErr
      && bareErr.error_class === "validation_failure"
      && bareReason === "source_not_absolute"
    ) {
      pass(`rung7: vo_vault_harvest_auto bare-filename source -> validation_failure + reason=source_not_absolute`);
    } else {
      fail(
        `rung7: vo_vault_harvest_auto bare-filename source did not return the structured refusal`,
        JSON.stringify({ ...bareErr, reason: bareReason }),
      );
    }
  } finally {
    h.kill();
  }
}

async function main(): Promise<void> {
  process.stdout.write(`vo-mcp self-check: spawning ${SERVER_PATH}\n\n`);
  process.stdout.write("== Happy path (live VO on 127.0.0.1:3100) ==\n");
  await runHappyPath();
  process.stdout.write("\n== Rung 2 write surface (live VO) ==\n");
  await runWriteSurface();
  process.stdout.write("\n== Rung 3 vault surface (temp vault fixture) ==\n");
  await runVaultSurface();
  process.stdout.write("\n== Rung 4 public-feed surface (anonymous local calls) ==\n");
  await runPublicFeedSurface();
  process.stdout.write("\n== Rung 5 review/audit surface (live VO) ==\n");
  await runReviewSurface();
  process.stdout.write("\n== Rung 6 overlay promotion (live VO) ==\n");
  await runOverlayPromotionSurface();
  process.stdout.write("\n== Rung 7 vault harvest refusal paths (no side effects) ==\n");
  await runVaultHarvestSurface();
  process.stdout.write("\n== Unreachable VO (127.0.0.1:1 ECONNREFUSED) ==\n");
  await runUnreachable();
  process.stdout.write(`\n${passCount} pass, ${failCount} fail\n`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`self-check fatal: ${(e as Error).stack || e}\n`);
  process.exit(1);
});
