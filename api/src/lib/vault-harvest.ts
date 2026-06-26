/**
 * Local vault harvest engine — VO-LOCAL-HARVEST-SEAM-PR-1.
 *
 * Library-safe extraction of the vault harvest pipeline out of
 * `agent-lab/scripts/vo-cli.ts`. Before this PR the pipeline lived
 * entirely in the CLI script; dashboard and MCP surfaces could not
 * consume it without importing the CLI or shelling out. This module
 * owns the engine so every future local consumer — CLI, dashboard,
 * MCP, desktop wrapper — talks to the same seam.
 *
 * Contract:
 *   - every exported run* function takes required structured args
 *   - never calls `process.exit`
 *   - never reads `process.argv` or CLI-specific globals
 *   - never emits user-facing output directly; the stage helpers do
 *     write stage-transcript lines via `console.log`, but each public
 *     function wraps its body in `withSilencedConsole(!args.verbose)`
 *     so library consumers get no stdout by default
 *   - always throws `VaultStageError` on stop points (no dual-mode
 *     programmatic-vs-CLI `vaultFail`)
 *
 * Surface:
 *   - runVaultInit / runVaultHarvest / runVaultConfirm / runVaultFinalize
 *   - runVaultHarvestAuto — orchestrator; catches stage errors and
 *     returns a classified AutoOutcome
 *   - AutoOutcome taxonomy + classifyStopFromError + helpers (moved
 *     here from `agent-lab/scripts/lib/vault-auto-report.ts`; the
 *     CLI-side formatter (`formatOutcome`) stays there and imports
 *     these types back)
 *
 * Preserved from the CLI engine:
 *   - stage boundaries (CAPTURE / ATOMIZE / CURATE / CONFIRM /
 *     GRAPH_WRITE / FINALIZE / LOG)
 *   - vault zone semantics (captures immutable, dossiers
 *     editable/generated per contract)
 *   - overwrite safety and conflict routing
 *   - clipper detection + normalization
 *   - URL fetch with AbortSignal + binary-type rejection
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { VAULT_ZONES } from "./vault-zones";

// ─── Error + engine types ───────────────────────────────────────────────

export class VaultTenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultTenantMismatchError";
  }
}

export class VaultStageError extends Error {
  stage: string;
  resumeHint: string;
  constructor(stage: string, message: string, resumeHint: string) {
    super(message);
    this.name = "VaultStageError";
    this.stage = stage;
    this.resumeHint = resumeHint;
  }
}

/**
 * Always-throw failure helper. The pre-extraction version had a dual
 * programmatic-vs-CLI mode that called `process.exit`; that behavior
 * is deliberately removed — library consumers catch the structured
 * error, the CLI wrapper maps it to an exit code at its top level.
 */
function vaultFail(stage: string, message: string, resumeHint: string): never {
  throw new VaultStageError(stage, message, resumeHint);
}

export interface VaultAtom {
  assertion: string;
  type: string;
  confidence: string;
  source_section: string;
}

export interface ClipperMetadata {
  title: string;
  source_url: string;
  source_domain?: string;
  source_site?: string;
  source_author?: string;
  source_published?: string;
  clipped_at?: string;
}

export interface HarvestResult {
  hash8: string;
  vaultRoot: string;
}

export interface ConfirmWrite {
  addr: string;
  assertion: string;
  type: string;
  confidence: string;
  source_section: string;
  deduplicated: boolean;
  existing_addr?: string;
}

export interface ConfirmResult {
  capture_hash: string;
  source_capture: string;
  title: string;
  doc_addr: string | null;
  doc_link_status: "linked" | "skipped_no_operator_auth" | "skipped_no_project" | "failed";
  atoms_proposed: number;
  atoms_written: number;
  atoms_deduped: number;
  writes: ConfirmWrite[];
}

export interface FinalizeResult {
  writeAction: "created" | "overwritten" | "conflict";
  finalFilename: string;
  conflictFilename?: string;
}

// ─── Auto-outcome taxonomy (moved here from vault-auto-report.ts) ───────

export type GraphWriteStatus = "fresh" | "deduped" | "mixed" | "unavailable";

export type DocLinkStatus =
  | "linked"
  | "skipped_no_operator_auth"
  | "skipped_no_project"
  | "failed"
  | "unavailable";

export type AutoStopReason =
  | "missing_key"
  | "vo_unavailable"
  | "missing_tenant_auth"
  | "finalize_conflict"
  | "unknown";

export type AutoOutcome =
  | {
      kind: "success";
      capturePath: string;
      dossierPath: string;
      graphWrite: GraphWriteStatus;
      atomsWritten: number;
      atomsDeduped: number;
      docLink: DocLinkStatus;
      /**
       * Rung 3: the freshly-written node addrs (non-deduped) this harvest
       * landed in the graph. The machine-vault route stamps the dossier as a
       * `vault_file` source_ref onto each so every harvested node carries a
       * verifiable on-disk source. Deduped atoms reference pre-existing nodes
       * and are excluded. Optional on the type for backward compatibility
       * with stubbed outcomes; the real engine always populates it.
       */
      nodeAddrs?: string[];
    }
  | {
      kind: "stop_missing_key";
      capturePath: string | null;
      envVarName: string;
      providerLabel: string;
    }
  | {
      kind: "stop_vo_unavailable";
      draftPath: string | null;
      hash8: string | null;
      root: string;
      /**
       * Distinguishes the three real VO-unavailable shapes the engine
       * surfaces:
       *   - unreachable         — network-level failure contacting VO
       *   - missing_tenant_auth — VO is reachable but no usable
       *                           tenant token
       *   - all_writes_failed   — VO accepted the request but every
       *                           `/memory/write` returned a non-ok
       *                           response (e.g. 500, 401, rate-limit).
       *                           The confirm stage downgraded each
       *                           atom to `addr: ""`, so zero atoms
       *                           landed in the graph. Finalize may
       *                           still have produced a dossier on
       *                           disk, but the harvest intent
       *                           (knowledge into the graph) was not
       *                           met — this is not `success`.
       *   - unknown             — other VO stage errors not matched
       *                           by the classifier above
       */
      subReason: "unreachable" | "missing_tenant_auth" | "all_writes_failed" | "unknown";
      /**
       * For `all_writes_failed`: the finalized dossier path that was
       * still written to disk even though no atoms landed. Null for
       * the other subReasons where finalize never ran.
       */
      dossierPath?: string | null;
      /**
       * For `all_writes_failed`: total atoms the draft proposed, for
       * the CLI/dashboard to render "0 of N landed in the graph".
       */
      atomsProposed?: number;
    }
  | {
      kind: "stop_finalize_conflict";
      conflictPath: string;
      preservedDossierPath: string;
      hash8: string;
      root: string;
      graphWrite: GraphWriteStatus;
      atomsWritten: number;
      atomsDeduped: number;
      docLink: DocLinkStatus;
    }
  | {
      kind: "stop_unknown";
      stage: string;
      message: string;
      resumeHint: string;
      root: string | null;
    };

export interface StageErrorLike {
  name?: string;
  stage?: string;
  message: string;
  resumeHint?: string;
}

/**
 * Per-call log sink for the shared engine. Used by the CLI to route
 * stage transcripts to `console.log`, and by library consumers
 * (dashboard, MCP, desktop wrapper) to route them to their own
 * structured log pipeline — or to discard them entirely.
 *
 * This replaces the earlier process-global `withSilencedConsole`
 * swap, which was not safe when the engine runs inside a long-lived
 * concurrent server (it would suppress unrelated `console.log` calls
 * from other requests while a harvest was in flight).
 */
export type HarvestLogSink = (line: string) => void;

/**
 * Resolve the log sink for one run. Precedence: explicit `onLog`
 * wins; otherwise `verbose` routes to `console.log`; otherwise
 * silent no-op.
 *
 * The returned sink is isolated from the engine's control flow: any
 * exception thrown by a caller-provided `onLog` is caught here and
 * silently dropped. Logging is observational — it must not be able
 * to alter stage execution, write results, or outcome classification.
 * A buggy dashboard/MCP callback cannot cause a partially initialized
 * vault or flip a "success" harvest to "stop_unknown".
 */
function resolveLog(args: { verbose?: boolean; onLog?: HarvestLogSink }): HarvestLogSink {
  const sink: HarvestLogSink = args.onLog
    ? args.onLog
    : args.verbose
      ? (line: string) => { console.log(line); }
      : () => {};
  return (line: string) => {
    try { sink(line); } catch { /* sink exceptions never alter engine flow */ }
  };
}

/**
 * Resolve the err sink for one run. Errors that the engine surfaces
 * during a successful-overall run (e.g. per-atom /memory/write
 * failures that are also recorded in `writes[]`) are informational —
 * they do NOT end the pipeline. The CLI routes these to
 * `console.error`; library consumers can silence or capture them.
 * Full stop-point errors still throw `VaultStageError` regardless of
 * this sink.
 *
 * Same isolation contract as `resolveLog`: sink exceptions are
 * swallowed so a buggy caller callback cannot alter engine control
 * flow.
 */
function resolveErr(args: { verbose?: boolean; onErr?: HarvestLogSink }): HarvestLogSink {
  const sink: HarvestLogSink = args.onErr
    ? args.onErr
    : args.verbose
      ? (line: string) => { console.error(line); }
      : () => {};
  return (line: string) => {
    try { sink(line); } catch { /* sink exceptions never alter engine flow */ }
  };
}

/**
 * @deprecated retained for backward compatibility with existing
 * callers of `vault-auto-report.ts` that use the global swap pattern.
 * The shared engine no longer uses it — stage transcripts are routed
 * through per-call `HarvestLogSink` instead. New code should NOT
 * depend on this helper; its global side effect is not safe inside
 * a long-lived concurrent server.
 */
export async function withSilencedConsole<T>(
  silence: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!silence) return fn();
  const origLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

/**
 * Translate a VaultStageError into a classified AutoOutcome.
 * Parses the error's resumeHint to recover capture/draft paths when
 * the caller didn't have time to pre-compute them.
 */
export function classifyStopFromError(
  err: StageErrorLike,
  ctx: {
    root: string;
    hash8?: string | null;
    capturePath?: string | null;
    draftPath?: string | null;
  },
): AutoOutcome {
  const stage = err.stage || "";
  const msg = err.message || "";
  const hint = err.resumeHint || "";

  const hintCapture = hint.match(/capture is safe at:\s*(\S+)/i)?.[1] || null;
  const hintDraft = hint.match(/(?:Draft ready at|draft is safe at):\s*(\S+)/i)?.[1] || null;
  const resolvedCapturePath = ctx.capturePath || hintCapture;
  const resolvedDraftPath = ctx.draftPath || hintDraft;

  // Missing LLM API key — narrow to explicit "API key not configured" phrase so
  // real runtime LLM failures fall through to stop_unknown with the real message.
  if (stage === "atomize" && /API key not configured/i.test(msg)) {
    return {
      kind: "stop_missing_key",
      capturePath: resolvedCapturePath,
      envVarName: "GOOGLE_API_KEY",
      providerLabel: "Google AI (Gemini)",
    };
  }

  if (stage === "graph_write") {
    const isTenantAuth = /tenant auth/i.test(msg) || /no tenant/i.test(msg);
    const isUnreachable = /unreachable/i.test(msg) || /ECONN/i.test(msg) || /fetch/i.test(msg);
    if (isTenantAuth) {
      return {
        kind: "stop_vo_unavailable",
        draftPath: resolvedDraftPath,
        hash8: ctx.hash8 || null,
        root: ctx.root,
        subReason: "missing_tenant_auth",
      };
    }
    if (isUnreachable) {
      return {
        kind: "stop_vo_unavailable",
        draftPath: resolvedDraftPath,
        hash8: ctx.hash8 || null,
        root: ctx.root,
        subReason: "unreachable",
      };
    }
    return {
      kind: "stop_vo_unavailable",
      draftPath: resolvedDraftPath,
      hash8: ctx.hash8 || null,
      root: ctx.root,
      subReason: "unknown",
    };
  }

  return {
    kind: "stop_unknown",
    stage,
    message: msg,
    resumeHint: hint,
    root: ctx.root || null,
  };
}

export function graphWriteStatusFromCounts(written: number, deduped: number): GraphWriteStatus {
  if (written === 0 && deduped === 0) return "unavailable";
  if (deduped === 0) return "fresh";
  if (written === 0) return "deduped";
  return "mixed";
}

// ─── Internal vault primitives ──────────────────────────────────────────

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function readVaultConfig(vaultRoot: string): { tenant_id: string; vo_url: string } {
  const configPath = path.join(vaultRoot, ".vo-vault.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`No vault at ${vaultRoot} — run "vo vault init" first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

export function loadManifest(
  vaultRoot: string,
): Array<{ content_hash: string; path: string; source_url: string | null; captured_at: string }> {
  const manifestPath = path.join(vaultRoot, "captures", ".manifest.jsonl");
  if (!fs.existsSync(manifestPath)) return [];
  const lines = fs.readFileSync(manifestPath, "utf-8").split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function appendManifest(
  vaultRoot: string,
  entry: { content_hash: string; path: string; source_url: string | null; captured_at: string },
) {
  const manifestPath = path.join(vaultRoot, "captures", ".manifest.jsonl");
  fs.appendFileSync(manifestPath, JSON.stringify(entry) + "\n", "utf-8");
}

async function atomizeWithLLM(content: string, sourceFilename: string): Promise<VaultAtom[]> {
  const { callFlash } = await import("../../../miners/src/lib/llm");

  const prompt = `You are a knowledge extraction assistant. Read the following source document and extract the most important factual assertions from it.

For each assertion, provide:
- assertion: a single clear factual statement (one sentence)
- type: one of "concept", "entity", "decision", "technique", "fact"
- confidence: "high", "medium", or "low" based on how clearly the source supports it
- source_section: the heading or section of the document where this fact appears (use the markdown heading text if available, otherwise describe the location)

Extract 3-10 assertions. Focus on the most important, specific, and durable facts. Avoid generic or obvious statements.

Return ONLY valid JSON — an array of objects with the fields above. No other text.

Source filename: ${sourceFilename}

--- BEGIN SOURCE ---
${content.slice(0, 60000)}
--- END SOURCE ---`;

  const raw = await callFlash(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 4096 });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error(`LLM returned unparseable response: ${raw.slice(0, 200)}`);
  }

  const atoms: VaultAtom[] = (Array.isArray(parsed) ? parsed : [])
    .map((a: any) => ({
      assertion: String(a.assertion || "").trim(),
      type: String(a.type || "fact").trim(),
      confidence: String(a.confidence || "medium").trim(),
      source_section: String(a.source_section || "").trim(),
    }))
    .filter((a: VaultAtom) => a.assertion.length > 0);

  if (atoms.length === 0) throw new Error("ATOMIZE produced 0 atoms — source may be too short or unclear");
  return atoms;
}

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

export async function fetchUrlContent(url: string): Promise<{ content: string; title: string; sourceFilename: string }> {
  const { extractRemoteDocument } = await import("../../../miners/src/lib/web-html");

  // SSRF guard at the fetcher itself (not only source-materialize's
  // pre-check) so every caller — including direct harvest paths with
  // agent-supplied URLs — is covered, with each redirect hop re-checked.
  const { ssrfGuardedFetch } = await import("./ssrf-guard");
  const resp = await ssrfGuardedFetch(url, {
    headers: {
      "User-Agent": "Verity-Vault/1.0 (knowledge-graph)",
      Accept: "text/html, text/plain, */*",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  // Bound the response size so a hostile/huge URL can't exhaust memory. Reject
  // early on a too-large Content-Length, then re-check the actual decoded bytes
  // (the header can be absent or lie).
  const MAX_FETCH_BYTES = 4 * 1024 * 1024; // 4 MB
  const declaredLen = Number(resp.headers.get("content-length") || "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_FETCH_BYTES) {
    throw new Error(`Fetched page too large: ${declaredLen} bytes exceeds ${MAX_FETCH_BYTES}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  const isBinary = /image|audio|video|octet-stream|pdf|zip|gzip|tar/i.test(contentType);
  if (isBinary) {
    throw new Error(`Unsupported content type: ${contentType}. This PR supports HTML and plain text pages only.`);
  }

  const body = await resp.text();
  if (Buffer.byteLength(body, "utf8") > MAX_FETCH_BYTES) {
    throw new Error(`Fetched page too large: exceeds ${MAX_FETCH_BYTES} bytes`);
  }
  if (body.trim().length === 0) {
    throw new Error("Fetched page is empty");
  }

  const extracted = extractRemoteDocument(url, body, { contentType });
  if (extracted.text.trim().length < 50) {
    throw new Error("Extracted text too short (< 50 chars) — page may require JavaScript to render");
  }

  let slug: string;
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.replace(/\/$/, "").split("/").pop() || parsed.hostname;
    slug = pathPart.replace(/\.[^.]+$/, "");
  } catch {
    slug = "web-page";
  }

  return {
    content: extracted.text,
    title: extracted.title || slug,
    sourceFilename: slug + ".md",
  };
}

// ─── Clipper recognition + normalization ────────────────────────────────

function parseClipperFrontmatter(raw: string): Record<string, string> | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*"?(.+?)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

function hasClipperMarkers(fm: Record<string, string>): boolean {
  return fm.source === "web" || fm.vo_intake === "clipper" || fm.source_tool === "obsidian-web-clipper";
}

function hasClipperUrl(fm: Record<string, string>): boolean {
  return !!(fm.url || fm.source_url);
}

export function classifyClipperNote(content: string): "clipper" | "malformed_clipper" | false {
  const fm = parseClipperFrontmatter(content);
  if (!fm) return false;
  if (!hasClipperMarkers(fm)) return false;
  if (!hasClipperUrl(fm)) return "malformed_clipper";
  return "clipper";
}

export function isClipperNote(content: string): boolean {
  return classifyClipperNote(content) === "clipper";
}

export function normalizeClipperNote(
  content: string,
  filename: string,
): { content: string; metadata: ClipperMetadata } {
  const fm = parseClipperFrontmatter(content);
  if (!fm) throw new Error("Clipper note has no frontmatter");

  const sourceUrl = fm.url || fm.source_url || "";
  if (!sourceUrl) {
    throw new Error("Clipper note has clipper markers but no source URL (url or source_url field required)");
  }

  const metadata: ClipperMetadata = {
    title: fm.title || filename.replace(/\.md$/, ""),
    source_url: sourceUrl,
    source_domain: fm.domain || fm.source_domain,
    source_site: fm.site || fm.source_site,
    source_author: fm.author || fm.source_author,
    source_published: fm.published || fm.source_published || fm.date,
    clipped_at: fm.clipped || fm.clipped_at || fm.created,
  };

  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const parts: string[] = [];
  parts.push(`# ${metadata.title}`);
  if (metadata.source_author) parts.push(`Author: ${metadata.source_author}`);
  if (metadata.source_published) parts.push(`Published: ${metadata.source_published}`);
  parts.push("");
  parts.push(body);

  return {
    content: parts.join("\n"),
    metadata,
  };
}

export type ClipSyncStatus = "new" | "partial" | "complete" | "malformed" | "ignored";

export interface ClipSyncResult {
  filename: string;
  status: ClipSyncStatus;
  detail: string;
  hash8?: string;
}

type ClipPipelineStatus = "new" | "capture_only" | "drafted" | "confirmed" | "complete";

function classifyClipStatus(vaultRoot: string, normalizedContent: string): { status: ClipPipelineStatus; hash8: string } {
  const fullHash = crypto.createHash("sha256").update(normalizedContent).digest("hex");
  const hash8 = fullHash.slice(0, 8);

  const manifest = loadManifest(vaultRoot);
  const hasCapture = manifest.some((entry) => entry.content_hash === `sha256:${fullHash}`);
  if (!hasCapture) return { status: "new", hash8 };

  const dossierDir = path.join(vaultRoot, "dossiers");
  if (fs.existsSync(dossierDir)) {
    const dossierFiles = fs.readdirSync(dossierDir);
    const finalized = dossierFiles.some(
      (file) => file.startsWith(hash8) && file.endsWith(".dossier.md"),
    );
    if (finalized) return { status: "complete", hash8 };
    if (dossierFiles.some((file) => file.startsWith(hash8) && file.endsWith(".confirm.json"))) {
      return { status: "confirmed", hash8 };
    }
    if (dossierFiles.some((file) => file.startsWith(hash8) && file.endsWith(".dossier.draft.md"))) {
      return { status: "drafted", hash8 };
    }
  }

  return { status: "capture_only", hash8 };
}

function clipperAutoOutcomeStatus(outcome: AutoOutcome): { status: ClipSyncStatus; detail: string } {
  if (outcome.kind === "success") {
    return { status: "complete", detail: "harvested + confirmed + finalized" };
  }
  if (outcome.kind === "stop_finalize_conflict") {
    return { status: "partial", detail: `finalize conflict: ${outcome.conflictPath}` };
  }
  return { status: "partial", detail: outcome.kind };
}

export interface RunVaultClipperSyncArgs {
  root: string;
  auto?: boolean;
  tenantToken?: string;
  operatorToken?: string | null;
  skipAtomize?: boolean;
  fixtureAtoms?: VaultAtom[];
  verbose?: boolean;
  onLog?: HarvestLogSink;
  onErr?: HarvestLogSink;
}

/**
 * Library-safe clipper inbox sync. Mirrors `vo vault clipper-sync`
 * semantics without reading argv, printing summaries, or shelling out.
 * It never deletes inbox notes; failures are returned as per-file
 * `partial` rows so callers can preserve the intake artifact and retry.
 */
export async function runVaultClipperSync(args: RunVaultClipperSyncArgs): Promise<ClipSyncResult[]> {
  const vaultRoot = path.resolve(args.root);
  readVaultConfig(vaultRoot);

  const inboxDir = path.join(vaultRoot, "inbox", "web-clips");
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs.readdirSync(inboxDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const results: ClipSyncResult[] = [];

  for (const filename of files) {
    const filePath = path.join(inboxDir, filename);
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const clipperClass = classifyClipperNote(rawContent);

    if (clipperClass === false) {
      results.push({ filename, status: "ignored", detail: "not a clipper note" });
      continue;
    }
    if (clipperClass === "malformed_clipper") {
      results.push({ filename, status: "malformed", detail: "clipper markers but no source URL" });
      continue;
    }

    let normalized: { content: string; metadata: ClipperMetadata };
    try {
      normalized = normalizeClipperNote(rawContent, filename);
    } catch (err) {
      results.push({ filename, status: "malformed", detail: (err as Error).message || "normalization error" });
      continue;
    }

    const clipStatus = classifyClipStatus(vaultRoot, normalized.content);
    if (clipStatus.status === "complete") {
      results.push({ filename, status: "complete", detail: "already finalized", hash8: clipStatus.hash8 });
      continue;
    }

    if (!args.auto) {
      if (clipStatus.status === "new") {
        try {
          await runVaultHarvest({
            root: vaultRoot,
            source: filePath,
            skipAtomize: args.skipAtomize,
            fixtureAtoms: args.fixtureAtoms,
            verbose: args.verbose,
            onLog: args.onLog,
            onErr: args.onErr,
          });
          results.push({
            filename,
            status: "partial",
            detail: "captured + drafted — run confirm + finalize",
            hash8: clipStatus.hash8,
          });
        } catch (err) {
          const message = err instanceof VaultStageError
            ? `stage ${err.stage}: ${err.message}${err.resumeHint ? ` (${err.resumeHint})` : ""}`
            : (err as Error)?.message || "unknown";
          results.push({ filename, status: "partial", detail: message, hash8: clipStatus.hash8 });
        }
        continue;
      }
      const detail = clipStatus.status === "capture_only" ? "captured but no draft - re-run harvest to regenerate"
        : clipStatus.status === "drafted" ? "drafted - run confirm + finalize"
        : "confirmed - run finalize";
      results.push({ filename, status: "partial", detail, hash8: clipStatus.hash8 });
      continue;
    }

    if (!args.tenantToken) {
      results.push({ filename, status: "partial", detail: "tenant bearer missing", hash8: clipStatus.hash8 });
      continue;
    }

    if (clipStatus.status === "confirmed") {
      try {
        await runVaultFinalize({
          root: vaultRoot,
          hash: clipStatus.hash8,
          verbose: args.verbose,
          onLog: args.onLog,
          onErr: args.onErr,
        });
        results.push({ filename, status: "complete", detail: "resumed: finalized", hash8: clipStatus.hash8 });
      } catch (err) {
        const message = err instanceof VaultStageError ? `stage ${err.stage}: ${err.message}` : (err as Error)?.message || "unknown";
        results.push({ filename, status: "partial", detail: `finalize failed: ${message}`, hash8: clipStatus.hash8 });
      }
      continue;
    }

    if (clipStatus.status === "drafted") {
      try {
        await runVaultConfirm({
          root: vaultRoot,
          hash: clipStatus.hash8,
          tenantToken: args.tenantToken,
          operatorToken: args.operatorToken,
          verbose: args.verbose,
          onLog: args.onLog,
          onErr: args.onErr,
        });
        await runVaultFinalize({
          root: vaultRoot,
          hash: clipStatus.hash8,
          verbose: args.verbose,
          onLog: args.onLog,
          onErr: args.onErr,
        });
        results.push({ filename, status: "complete", detail: "resumed: confirmed + finalized", hash8: clipStatus.hash8 });
      } catch (err) {
        const message = err instanceof VaultStageError ? `stage ${err.stage}: ${err.message}` : (err as Error)?.message || "unknown";
        results.push({ filename, status: "partial", detail: `resume failed: ${message}`, hash8: clipStatus.hash8 });
      }
      continue;
    }

    const outcome = await runVaultHarvestAuto({
      root: vaultRoot,
      source: filePath,
      tenantToken: args.tenantToken,
      operatorToken: args.operatorToken,
      skipAtomize: args.skipAtomize,
      fixtureAtoms: args.fixtureAtoms,
      verbose: args.verbose,
      onLog: args.onLog,
      onErr: args.onErr,
    });
    const status = clipperAutoOutcomeStatus(outcome);
    results.push({ filename, status: status.status, detail: status.detail, hash8: clipStatus.hash8 });
  }

  return results;
}

// ─── Draft / confirm artifact helpers ───────────────────────────────────

function findDraftByHash(vaultRoot: string, hash8: string): { path: string; filename: string } | null {
  const dossierDir = path.join(vaultRoot, "dossiers");
  if (!fs.existsSync(dossierDir)) return null;
  const matches = fs.readdirSync(dossierDir).filter(
    (f) => f.startsWith(hash8) && f.endsWith(".dossier.draft.md"),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`Multiple drafts match hash prefix "${hash8}": ${matches.join(", ")}`);
  return { path: path.join(dossierDir, matches[0]), filename: matches[0] };
}

export function parseDraftFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("Draft has no YAML frontmatter");
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w_]*)\s*:\s*"?(.+?)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

export function parseDraftAtoms(content: string): VaultAtom[] {
  const blockMatch = content.match(/```yaml\natoms:\n([\s\S]*?)```/);
  if (!blockMatch) throw new Error("Draft has no fenced yaml atom block");
  const raw = blockMatch[1];
  const atoms: VaultAtom[] = [];
  let current: Partial<VaultAtom> | null = null;
  for (const line of raw.split("\n")) {
    const itemMatch = line.match(/^\s+-\s+assertion:\s*"(.+)"$/);
    if (itemMatch) {
      if (current && current.assertion) atoms.push(current as VaultAtom);
      current = { assertion: itemMatch[1].replace(/\\"/g, '"') };
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
    if (fieldMatch) {
      const [, key, val] = fieldMatch;
      if (key === "type") current.type = val;
      else if (key === "confidence") current.confidence = val;
      else if (key === "source_section") current.source_section = val.replace(/\\"/g, '"');
    }
  }
  if (current && current.assertion) atoms.push(current as VaultAtom);
  return atoms;
}

function findConfirmByHash(
  vaultRoot: string,
  hash8: string,
): { path: string; filename: string; slug: string } | null {
  const dossierDir = path.join(vaultRoot, "dossiers");
  if (!fs.existsSync(dossierDir)) return null;
  const matches = fs.readdirSync(dossierDir).filter(
    (f) => f.startsWith(hash8) && f.endsWith(".confirm.json"),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`Multiple confirm artifacts match hash prefix "${hash8}": ${matches.join(", ")}`);
  const slug = matches[0].replace(/\.confirm\.json$/, "");
  return { path: path.join(dossierDir, matches[0]), filename: matches[0], slug };
}

function extractBodyContent(md: string): string {
  const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : md;
}

function extractExistingTags(md: string): string[] {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const tagsMatch = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
  if (tagsMatch) {
    return tagsMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  const lines = fmMatch[1].split("\n");
  const tagsIdx = lines.findIndex((l) => l.match(/^tags:\s*$/));
  if (tagsIdx < 0) return [];
  const tags: string[] = [];
  for (let i = tagsIdx + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    tags.push(item[1].trim().replace(/^["']|["']$/g, ""));
  }
  return tags;
}

/**
 * Find the single vault-relative path for the file matching a hash
 * prefix in `<subdir>` of the vault. Used by the auto orchestrator
 * so stop-point outcomes can always name the concrete vault file.
 */
export function resolveVaultRelative(
  vaultRoot: string,
  subdir: string,
  hash8: string,
  suffix?: string,
): string | null {
  const dir = path.join(vaultRoot, subdir);
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir).filter((f) => {
    if (!f.startsWith(hash8)) return false;
    if (suffix) return f.endsWith(suffix);
    return !f.startsWith(".") && !f.includes(".draft.") && !f.includes(".confirm.") && !f.includes(".conflict");
  });
  if (matches.length === 0) return null;
  return `${subdir}/${matches[0]}`;
}

// ─── Public engine functions ────────────────────────────────────────────

export interface RunVaultInitArgs {
  root: string;
  tenant: string;
  verbose?: boolean;
  /** Per-call log sink. Overrides `verbose`. See `HarvestLogSink`. */
  onLog?: HarvestLogSink;
  /** Per-call err sink for informational non-fatal lines. */
  onErr?: HarvestLogSink;
}

export async function runVaultInit(args: RunVaultInitArgs): Promise<void> {
  const log = resolveLog(args);
  const err = resolveErr(args);
  const root = args.root;
  const tenant = args.tenant;

  const vaultRoot = path.resolve(root);
  const now = new Date().toISOString();

  const dirs = [
    vaultRoot,
    // PR-V1 content-type zones (VO-controlled, evolvable — single source of truth
    // in vault-zones.ts). classifySourceToZone routes materialized sources here.
    // Adding a zone to VAULT_ZONES auto-scaffolds it on the next init. This set
    // includes notes/ dossiers/ inbox/ — already-present zones — so the explicit
    // lines below are the pipeline directories + sub-structure not covered by a zone.
    ...VAULT_ZONES.map((zone) => path.join(vaultRoot, zone)),
    path.join(vaultRoot, "captures"), // immutable raw-source store (harvest pipeline; not a content zone)
    path.join(vaultRoot, "dossiers", ".conflicts"), // local-wins conflict snapshots
    path.join(vaultRoot, "inbox", "web-clips"), // Obsidian Web Clipper intake
    path.join(vaultRoot, "docs"), // the vault's own usage guide (distinct from the documents/ zone)
    path.join(vaultRoot, ".obsidian"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function writeIfChanged(filePath: string, content: string): "created" | "unchanged" | "updated" {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(vaultRoot, filePath);
    if (fs.existsSync(abs)) {
      const existing = fs.readFileSync(abs, "utf-8");
      if (existing === content) return "unchanged";
      fs.writeFileSync(abs, content, "utf-8");
      return "updated";
    }
    fs.writeFileSync(abs, content, "utf-8");
    return "created";
  }

  const vaultConfigPath = path.join(vaultRoot, ".vo-vault.json");
  let vaultConfigAction: string;
  if (fs.existsSync(vaultConfigPath)) {
    // Corrupted `.vo-vault.json` must be rejected, not silently
    // accepted. The pre-round-2 behavior was: catch any parse failure,
    // ignore it, report the config as "unchanged" — which left the
    // broken file in place and made the next `readVaultConfig()` /
    // `runVaultHarvest()` crash with a raw SyntaxError, hiding the
    // real cause behind a false-success init. Now: throw a structured
    // `VaultStageError` so the CLI can emit a clean message, the
    // auto orchestrator classifies it as `stop_unknown`, and the
    // corrupted file is preserved untouched for the tenant to inspect.
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(fs.readFileSync(vaultConfigPath, "utf-8"));
    } catch (parseErr: any) {
      throw new VaultStageError(
        "init",
        `vault at ${vaultRoot} has a corrupted .vo-vault.json: ${parseErr?.message || parseErr}`,
        `Inspect or rename ${vaultConfigPath} and re-run \`vo vault init\`.`,
      );
    }
    // Reject parseable-but-unbound configs. A `.vo-vault.json` that
    // parses cleanly but carries no string `tenant_id` (missing,
    // empty string, or non-string type) is functionally identical to
    // a corrupted file — the vault has no tenant binding. Pre-round-4
    // behavior silently accepted these, so `runVaultInit(tenant-a)`
    // followed by `runVaultInit(tenant-b)` on the same broken vault
    // both returned success with no mismatch error. Round-4 fix:
    // throw a structured `VaultStageError` with `stage: "init"` so
    // the CLI emits a clean message and the auto orchestrator
    // classifies via `stop_unknown`. The broken file is preserved
    // byte-for-byte for the tenant to inspect — same posture as the
    // round-3 corrupted-JSON fix, no silent auto-repair.
    const rawTenantId = (existing as { tenant_id?: unknown }).tenant_id;
    const existingTenant = typeof rawTenantId === "string" ? rawTenantId.trim() : "";
    if (!existingTenant) {
      throw new VaultStageError(
        "init",
        `vault at ${vaultRoot} has .vo-vault.json but no tenant binding (missing, empty, or non-string tenant_id)`,
        `Inspect or rename ${vaultConfigPath} and re-run \`vo vault init\`.`,
      );
    }
    if (existingTenant !== tenant) {
      throw new VaultTenantMismatchError(
        `vault at ${vaultRoot} is bound to tenant "${existingTenant}", but --tenant "${tenant}" was requested.`,
      );
    }
    vaultConfigAction = "unchanged";
  } else {
    const vaultConfig =
      JSON.stringify(
        {
          tenant_id: tenant,
          vo_url: "http://localhost:3100",
          schema_version: 1,
          vo_version: "0.1.0",
          vault_version: "1.0.0",
          created_at: now,
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(vaultConfigPath, vaultConfig, "utf-8");
    vaultConfigAction = "created";
  }

  const agentsMd = `# VO Vault — Agent Contract

This vault is a companion layer to a Verity One knowledge graph.
Read .vo-vault.json for the VO API URL and tenant identity.

## Vault Zones

### captures/ — IMMUTABLE
You must NEVER modify, delete, or rename files in captures/.
These are source documents. They are append-only.

### dossiers/*.dossier.draft.md — EDITABLE (curation surface)
You may edit the fenced yaml atom block in draft dossiers to improve accuracy.
You may adjust confidence levels and source_section references.
You must not change the frontmatter fields: capture_hash, source_capture, vo_type.

### dossiers/*.dossier.md — READ-ONLY (generated)
You must not edit finalized dossiers. They are managed by the harvest pipeline.
If you need to annotate a dossier, create a note in notes/ instead.

### notes/ — HUMAN-OWNED
You may read notes for context. You must never create, modify, or delete notes
unless the human explicitly asks you to.

### index.md, log.md — MANAGED
You must not edit these directly. They are regenerated by the harvest pipeline.

### inbox/web-clips/ — INTAKE (clipper drop zone)
The Obsidian Web Clipper saves pages here. These are intake artifacts, not captures.
You may read them for context. Harvest them with vo vault harvest to ingest into VO.
You must not modify or delete clipper notes — the human manages this folder.

### docs/ — REFERENCE
You may read docs/ for vault usage guidance. You must not modify these files.

## Authority
The VO graph (accessed via the VO API at the URL in .vo-vault.json) is the
canonical source of truth for all assertions. Dossiers are curated summaries.
If a dossier contradicts the graph, the graph wins.

## Source Refs
When writing to the VO graph, source_refs must point to files in captures/
using the paths recorded in dossier frontmatter. Never fabricate source paths.

## File Identity
Generated filenames use the pattern {hash8}-{slug}.{ext} where hash8 is the
first 8 hex characters of the capture file's sha256 hash. The slug is cosmetic.
Use the hash prefix for lookup, not the slug.
`;

  const claudeMd = `# VO Vault

All vault rules, zone permissions, and authority model are defined in AGENTS.md
in this directory. Read AGENTS.md before taking any action in this vault.

See docs/vault-guide.md for human-facing setup and usage documentation.
`;

  const gitignore = `# Obsidian workspace (changes per machine)
.obsidian/workspace.json
.obsidian/workspace-mobile.json

# OS
.DS_Store

# Large binaries (add patterns as needed)
# raw/images/*.psd
# raw/data/*.csv
`;

  const indexMd = `# Vault Index

| Dossier | Date | Atoms | Source |
|---------|------|-------|--------|

*0 sources captured. 0 assertions in VO.*
`;

  const logMd = `# Operation Log

## [${now}] init | Vault initialized
- **Tenant:** ${tenant}
- **Root:** ${vaultRoot}
- **Created:** AGENTS.md, CLAUDE.md, .vo-vault.json, .gitignore, index.md, log.md, docs/vault-guide.md
- **Content zones (VO-routed):** web/, documents/, journal/, notes/, media/, dossiers/, inbox/
- **Pipeline directories:** captures/ (immutable source store), dossiers/.conflicts/, inbox/web-clips/ (clipper intake), docs/ (this guide), .obsidian/
`;

  const vaultGuide = `# VO Vault Guide

## Getting Started

### Prerequisites
- Verity One running at the URL in \`.vo-vault.json\` (default: http://localhost:3100)
- Obsidian installed (https://obsidian.md)
- LLM provider configured — set an AI provider key (e.g. \`GOOGLE_API_KEY\`) in your
  environment or \`~/.vo/secrets.env\` (operators with the full \`vo\` CLI can run \`vo onboard\`)

### Setup
\`\`\`bash
bun run agent-lab/scripts/vo-cli.ts vault init --root ~/knowledge --tenant <your-tenant-id>
\`\`\`

### Open in Obsidian
1. Open Obsidian
2. Click "Open folder as vault"
3. Select the vault root directory (e.g. ~/knowledge)
4. Trust the vault when prompted

### First harvest
\`\`\`bash
# From a local file:
bun run agent-lab/scripts/vo-cli.ts vault harvest --root ~/knowledge path/to/article.md

# From a web URL:
bun run agent-lab/scripts/vo-cli.ts vault harvest --root ~/knowledge https://example.com/article
\`\`\`
This captures the source, extracts key assertions, and creates a draft dossier.
You will find:
- a capture in \`captures/\` (immutable copy of the source text)
- a draft dossier in \`dossiers/\` (editable summary with proposed atoms)

**Supported sources:**
- Local files: .md, .txt, .text
- Web URLs: normal http/https pages (HTML and plain text)
- Obsidian Web Clipper notes: save to \`inbox/web-clips/\`, then harvest
- Not yet supported: YouTube, PDFs, JS-heavy pages, binary downloads

### Harvesting web clips from Chrome
1. Install the [Obsidian Web Clipper](https://obsidian.md/clipper) browser extension
2. Configure it to save to your vault's \`inbox/web-clips/\` folder
3. Clip a web page from Chrome
4. Harvest it:
\`\`\`bash
bun run agent-lab/scripts/vo-cli.ts vault harvest --auto --root ~/knowledge inbox/web-clips/my-clip.md
\`\`\`
VO detects clipper notes automatically, extracts the source URL and metadata,
and runs the full harvest pipeline. The clipper note stays in \`inbox/\` as an
intake artifact — the canonical capture goes to \`captures/\`.

### Batch process web clips
If you have multiple clips in \`inbox/web-clips/\`, process them all at once:
\`\`\`bash
bun run agent-lab/scripts/vo-cli.ts vault clipper-sync --auto --root ~/knowledge
\`\`\`
This scans the inbox, skips already-processed clips, and runs the full pipeline
on new ones. Malformed clips are reported clearly. Your inbox files are never modified.

### Confirm a draft
After reviewing a draft dossier, confirm it to write atoms to the VO graph:
\`\`\`bash
bun run agent-lab/scripts/vo-cli.ts vault confirm --root ~/knowledge <hash8>
\`\`\`
The \`hash8\` is the first 8 characters of the capture filename (e.g. \`a1b2c3d4\`).
This writes the proposed atoms to VO via \`/memory/write\` and links the capture
as a canonical doc node via \`/ops/link-doc\`. A \`.confirm.json\` manifest is
created with the resulting VO addrs for finalization.

**This is the first step that requires VO.** If VO is unavailable, the command
fails with a clear message and your draft remains safe on disk. Rerun when VO is back.

**Safe to rerun:** VO deduplicates atoms automatically. Rerunning confirm on the
same draft produces dedup results, not duplicate writes.

### Finalize a confirmed dossier
After confirming, finalize to produce the permanent dossier:
\`\`\`bash
bun run agent-lab/scripts/vo-cli.ts vault finalize --root ~/knowledge <hash8>
\`\`\`
This:
- writes the finalized dossier at \`dossiers/{hash8}-{slug}.dossier.md\`
- appends a structured audit entry to \`log.md\`
- regenerates \`index.md\` with all finalized dossiers
- removes the draft and confirm artifact (they are ephemeral)

**Overwrite safety:** If you edited a finalized dossier, finalize will not
overwrite your edits. Instead, it writes the new version to \`dossiers/.conflicts/\`
and preserves your original.

### Full workflow — one command (recommended)
\`\`\`bash
vo vault harvest --auto --root ~/knowledge path/to/article.md
\`\`\`
This runs all 7 stages in one pass: capture, atomize, draft, confirm, graph write,
finalize, and log. If any stage fails, it stops and tells you exactly what succeeded
and how to resume manually.

### Full workflow — manual (step by step)
\`\`\`bash
# 1. Capture + atomize + draft (no VO needed)
vo vault harvest --root ~/knowledge path/to/article.md

# 2. Confirm draft + write to VO (requires VO)
vo vault confirm --root ~/knowledge <hash8>

# 3. Finalize dossier + log + index (no VO needed)
vo vault finalize --root ~/knowledge <hash8>
\`\`\`
Use the manual steps when you want to review and edit the draft before confirming.

After harvest, open Obsidian to browse your dossier, check the index, or read the log.

## Harvest Lifecycle

The harvest pipeline has 7 stages:

| Stage | Name | VO required? |
|-------|------|-------------|
| 1 | CAPTURE — download/copy source to captures/ | No |
| 2 | ATOMIZE — extract assertions from source | No |
| 3 | CURATE — write draft dossier with proposed atoms | No |
| 4 | CONFIRM — review and confirm draft | No |
| 5 | GRAPH_WRITE — write atoms to VO graph | **Yes** |
| 6 | FINALIZE — stamp dossier with VO addrs | No |
| 7 | LOG — append audit entry to log.md | No |

**Commands:**
- \`vo vault harvest --auto --root <path> <file>\` — all 7 stages in one pass (recommended)
- \`vo vault harvest --root <path> <file>\` — stages 1-3 only (capture + draft)
- \`vo vault confirm --root <path> <hash8>\` — stages 4-5 (confirm + graph write, requires VO)
- \`vo vault finalize --root <path> <hash8>\` — stages 6-7 (finalize + log)

**Offline use:** \`harvest\` (without --auto) runs stages 1-3 without VO.
Stockpile drafts offline, then run \`confirm\` and \`finalize\` when VO is reachable.

**Error recovery:** All stages are idempotent. Re-run the same command to retry.

## Vault Rules

### What's what
- **captures/** = what came in (immutable source files)
- **dossiers/** = what VO understood (AI-curated summaries)
- **notes/** = what you think (your private annotations)

### Editability

| Zone | You may edit? | System may overwrite? |
|------|--------------|----------------------|
| captures/ | No (immutable) | Never |
| dossiers/*.dossier.draft.md | Yes (curation surface) | Always (ephemeral) |
| dossiers/*.dossier.md | No | Yes, if body is unmodified |
| notes/ | Yes (fully yours) | Never |
| index.md, log.md | No | Managed by harvest |

### Authority model
The VO graph is always the canonical source of truth for assertions.
Dossiers are curated summaries. If a dossier contradicts the graph, the graph wins.
Notes are your private space — VO never reads them.

### Overwrite safety
If you edit a finalized dossier, the next harvest detects the change (via content hash)
and writes its new version to \`dossiers/.conflicts/\` instead of overwriting yours.

## Using with AI Agents

### Agent contract
Both Claude Code and Codex read the vault rules automatically:
- Claude Code reads \`CLAUDE.md\` → points to \`AGENTS.md\`
- Codex reads \`AGENTS.md\` directly

Both get the same zone rules and authority model.

### Running the full pipeline from an agent session
\`\`\`bash
# One command (recommended):
bun run agent-lab/scripts/vo-cli.ts vault harvest --auto --root ~/knowledge path/to/source.md

# Or step by step if you want to review the draft:
bun run agent-lab/scripts/vo-cli.ts vault harvest --root ~/knowledge path/to/source.md
bun run agent-lab/scripts/vo-cli.ts vault confirm --root ~/knowledge <hash8>
bun run agent-lab/scripts/vo-cli.ts vault finalize --root ~/knowledge <hash8>
\`\`\`

### Editing drafts
When draft dossiers exist, agents may edit the fenced \`yaml\` atom block to correct
assertions, adjust confidence, or fix source section references.
Do not change frontmatter identity fields.

### Verifying traceability
Check any dossier's VO nodes:
\`\`\`bash
# Read vo_nodes from dossier frontmatter, then:
curl -s http://localhost:3100/nodes/<addr> | python3 -m json.tool
\`\`\`
`;

  const results: Record<string, string> = {};
  results[".vo-vault.json"] = vaultConfigAction;
  results["AGENTS.md"] = writeIfChanged("AGENTS.md", agentsMd);
  results["CLAUDE.md"] = writeIfChanged("CLAUDE.md", claudeMd);
  results[".gitignore"] = writeIfChanged(".gitignore", gitignore);
  results["index.md"] = writeIfChanged("index.md", indexMd);
  results["docs/vault-guide.md"] = writeIfChanged("docs/vault-guide.md", vaultGuide);

  const logPath = path.join(vaultRoot, "log.md");
  if (fs.existsSync(logPath)) {
    results["log.md"] = "unchanged";
  } else {
    fs.writeFileSync(logPath, logMd, "utf-8");
    results["log.md"] = "created";
  }

  const manifestPath = path.join(vaultRoot, "captures", ".manifest.jsonl");
  if (fs.existsSync(manifestPath)) {
    results["captures/.manifest.jsonl"] = "unchanged";
  } else {
    fs.writeFileSync(manifestPath, "", "utf-8");
    results["captures/.manifest.jsonl"] = "created";
  }

  const created = Object.values(results).filter((v) => v === "created").length;
  const unchanged = Object.values(results).filter((v) => v === "unchanged").length;
  const updated = Object.values(results).filter((v) => v === "updated").length;

  log(`vault init: ${vaultRoot}`);
  log(`  tenant: ${tenant}`);
  log("");
  for (const [file, action] of Object.entries(results)) {
    const icon = action === "created" ? "+" : action === "updated" ? "~" : "=";
    log(`  ${icon} ${file} (${action})`);
  }
  log("");
  log(`  ${created} created, ${updated} updated, ${unchanged} unchanged`);
}

export interface RunVaultHarvestArgs {
  root: string;
  source: string;
  skipAtomize?: boolean;
  fixtureAtoms?: VaultAtom[];
  verbose?: boolean;
  onLog?: HarvestLogSink;
  onErr?: HarvestLogSink;
}

export async function runVaultHarvest(args: RunVaultHarvestArgs): Promise<HarvestResult> {
  const log = resolveLog(args);
  const err = resolveErr(args);
  const sourceArg = args.source;
  const vaultRoot = path.resolve(args.root);
  readVaultConfig(vaultRoot);

  let content: string;
  let sourceFilename: string;
  let sourceUrl: string | null = null;
  let clipperMeta: ClipperMetadata | null = null;

  if (isUrl(sourceArg)) {
    sourceUrl = sourceArg;
    try {
      const fetched = await fetchUrlContent(sourceArg);
      content = fetched.content;
      sourceFilename = fetched.sourceFilename;
    } catch (err: any) {
      vaultFail("capture", `URL fetch failed: ${err?.message || err}`, `URL: ${sourceArg}`);
    }
  } else {
    const sourcePath = path.resolve(sourceArg);
    if (!fs.existsSync(sourcePath)) {
      vaultFail("harvest", `source file not found: ${sourcePath}`, "");
    }

    const ext = path.extname(sourcePath).toLowerCase();
    const supportedExts = [".md", ".txt", ".text"];
    if (!supportedExts.includes(ext)) {
      vaultFail("harvest", `unsupported file type "${ext}". Supported: ${supportedExts.join(", ")}`, "");
    }

    const rawContent = fs.readFileSync(sourcePath, "utf-8");
    sourceFilename = path.basename(sourcePath);

    if (ext === ".md") {
      const clipperClass = classifyClipperNote(rawContent);
      if (clipperClass === "malformed_clipper") {
        vaultFail(
          "harvest",
          "File has clipper/web-intake markers but no source URL (url or source_url field required). Fix the clipper note or remove the intake markers.",
          `File: ${sourcePath}`,
        );
      } else if (clipperClass === "clipper") {
        try {
          const normalized = normalizeClipperNote(rawContent, sourceFilename);
          content = normalized.content;
          sourceUrl = normalized.metadata.source_url;
          sourceFilename = slugify(normalized.metadata.title) + ".md";
          clipperMeta = normalized.metadata;
          log(`  clipper note detected: ${normalized.metadata.title}`);
          log(`  source url: ${sourceUrl}`);
        } catch (err: any) {
          vaultFail("harvest", `Clipper note error: ${err?.message || err}`, `File: ${sourcePath}`);
        }
      } else {
        content = rawContent;
      }
    } else {
      content = rawContent;
    }
  }

  if (content!.trim().length === 0) {
    vaultFail("harvest", "source content is empty", "");
  }

  const now = new Date().toISOString();

  log("stage 1: CAPTURE");

  const fullHash = crypto.createHash("sha256").update(content!).digest("hex");
  const hash8 = fullHash.slice(0, 8);

  const manifest = loadManifest(vaultRoot);
  const existing = manifest.find((e) => e.content_hash === `sha256:${fullHash}`);

  let captureRelative: string;
  let captureFilename: string;

  if (existing) {
    captureRelative = existing.path;
    captureFilename = path.basename(captureRelative);
    sourceUrl = existing.source_url;
    log(`  = already captured: ${existing.path} (hash match)`);
  } else {
    const slug = slugify(sourceFilename!);
    const captureExt = sourceUrl ? ".md" : path.extname(sourceFilename!).toLowerCase() || ".md";
    captureFilename = `${hash8}-${slug}${captureExt}`;
    captureRelative = `captures/${captureFilename}`;
    const capturePath = path.join(vaultRoot, "captures", captureFilename);
    fs.writeFileSync(capturePath, content!, "utf-8");
    appendManifest(vaultRoot, {
      content_hash: `sha256:${fullHash}`,
      path: captureRelative,
      source_url: sourceUrl,
      captured_at: now,
    });
    log(`  + ${captureRelative}`);
    if (sourceUrl) log(`  url: ${sourceUrl}`);
  }

  const dossierSlug = captureFilename.replace(/\.[^.]+$/, "");

  log("stage 2: ATOMIZE");

  let atoms: VaultAtom[];
  if (args.skipAtomize && args.fixtureAtoms) {
    atoms = args.fixtureAtoms;
    log(`  ${atoms.length} atoms (fixture)`);
  } else {
    const { getGoogleApiKey } = await import("../../../miners/src/lib/llm");
    if (!getGoogleApiKey()) {
      vaultFail(
        "atomize",
        "Gemini API key not configured. Set GOOGLE_API_KEY or OPENCLAW_GOOGLE_API_KEY and rerun harvest.",
        `Your capture is safe at: ${captureRelative}\nRun: vo onboard`,
      );
    }
    try {
      atoms = await atomizeWithLLM(content!, sourceFilename!);
    } catch (err: any) {
      vaultFail(
        "atomize",
        `Atomization failed: ${err?.message || err}`,
        `Your capture is safe at: ${captureRelative}`,
      );
    }
    log(`  ${atoms!.length} atoms extracted`);
  }

  log("stage 3: CURATE");

  const draftFilename = `${dossierSlug}.dossier.draft.md`;
  const draftPath = path.join(vaultRoot, "dossiers", draftFilename);

  const title =
    clipperMeta?.title ||
    content!.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    sourceFilename!.replace(/\.[^.]+$/, "");

  const takeaways = atoms!
    .slice(0, 3)
    .map((a, i) => `${i + 1}. ${a.assertion}`)
    .join("\n");

  const atomYaml = atoms!
    .map(
      (a) =>
        `  - assertion: "${a.assertion.replace(/"/g, '\\"')}"\n    type: ${a.type}\n    confidence: ${a.confidence}\n    source_section: "${a.source_section.replace(/"/g, '\\"')}"`,
    )
    .join("\n");

  const sourceUrlYaml = sourceUrl ? `"${sourceUrl}"` : "null";
  const frontmatter = `---
vo_type: "dossier-draft"
vo_managed: true
capture_hash: "sha256:${fullHash}"
source_capture: "${captureRelative}"
source_url: ${sourceUrlYaml}
pipeline_stage: "curate"
generated_at: "${now}"
generated_by: "harvest/v1"
title: "${title.replace(/"/g, '\\"')} - Draft Dossier"
tags: []
---`;

  const summaryLines = content!
    .split("\n")
    .filter((l) => !l.startsWith("#") && l.trim().length > 0)
    .slice(0, 10)
    .join("\n")
    .slice(0, 500);

  const draftBody = `${frontmatter}

# ${title} — Draft Dossier

**Source:** [${sourceFilename}](../${captureRelative})
**Captured:** ${now.split("T")[0]}
**URL:** ${sourceUrl || "local file"}${clipperMeta?.source_author ? `\n**Author:** ${clipperMeta.source_author}` : ""}${clipperMeta?.source_published ? `\n**Published:** ${clipperMeta.source_published}` : ""}${clipperMeta?.source_site ? `\n**Site:** ${clipperMeta.source_site}` : ""}

## Key Takeaways

${takeaways}

## Proposed Atoms

> These atoms will be written to the VO graph on confirmation.
> Edit this block to correct assertions, adjust confidence, or fix source references.

\`\`\`yaml
atoms:
${atomYaml}
\`\`\`

## Detailed Notes

${summaryLines}

## Source Links

- Capture: [${captureFilename}](../${captureRelative})
- Original: ${sourceUrl || `local file (${sourceFilename})`}
`;

  fs.writeFileSync(draftPath, draftBody, "utf-8");
  log(`  + dossiers/${draftFilename}`);

  log("");
  log(`Captured and drafted. Review at dossiers/${draftFilename}`);

  return { hash8, vaultRoot };
}

export interface RunVaultConfirmArgs {
  root: string;
  hash: string;
  /** Tenant bearer token for /memory/write. The CLI wrapper resolves this from ~/.vo/config.json or env. */
  tenantToken: string;
  /** Operator token for /ops/link-doc. Optional — doc-link is skipped honestly when absent. */
  operatorToken?: string | null;
  verbose?: boolean;
  onLog?: HarvestLogSink;
  onErr?: HarvestLogSink;
}

export async function runVaultConfirm(args: RunVaultConfirmArgs): Promise<ConfirmResult> {
  const log = resolveLog(args);
  const err = resolveErr(args);
  const vaultRoot = path.resolve(args.root);
  const vaultConfig = readVaultConfig(vaultRoot);
  const hash8 = args.hash.slice(0, 8);

  log("stage 4: CONFIRM");

  const draft = findDraftByHash(vaultRoot, hash8);
  if (!draft) {
    vaultFail(
      "confirm",
      `no draft dossier found matching hash prefix "${hash8}"`,
      "Check dossiers/ for *.dossier.draft.md files.",
    );
  }
  log(`  draft: dossiers/${draft.filename}`);

  const draftContent = fs.readFileSync(draft.path, "utf-8");
  const fm = parseDraftFrontmatter(draftContent);
  const atoms = parseDraftAtoms(draftContent);

  if (atoms.length === 0) {
    vaultFail("confirm", "draft has no atoms to confirm", "");
  }

  const captureHash = fm.capture_hash || "";
  const sourceCapture = fm.source_capture || "";
  const title = (fm.title || "").replace(/ - Draft Dossier$/, "");

  log(`  capture: ${sourceCapture}`);
  log(`  atoms: ${atoms.length} confirmed`);

  log("stage 5: GRAPH_WRITE");

  const voUrl = vaultConfig.vo_url || "http://localhost:3100";
  const tenantToken = args.tenantToken;
  const operatorToken = args.operatorToken || "";

  if (!tenantToken) {
    vaultFail(
      "graph_write",
      "no tenant auth token configured",
      `Your draft is safe at: dossiers/${draft.filename}\nRun: vo init --tenant <id>`,
    );
  }

  try {
    const ping = await fetch(`${voUrl}/`, { signal: AbortSignal.timeout(5000) });
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch {
    vaultFail(
      "graph_write",
      `VO unreachable at ${voUrl}`,
      `Draft ready at: dossiers/${draft.filename}\nRun: vo vault confirm --root ${args.root} ${hash8}`,
    );
  }

  const tenantHeaders = { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" };
  const operatorHeaders = { Authorization: `Bearer ${operatorToken}`, "Content-Type": "application/json" };
  const writes: ConfirmWrite[] = [];
  let deduped = 0;

  const kindMap: Record<string, string> = {
    concept: "context",
    entity: "context",
    decision: "decision",
    technique: "pattern",
    fact: "context",
  };

  const confMap: Record<string, number> = { high: 0.85, medium: 0.70, low: 0.55 };

  for (const atom of atoms) {
    const kind = kindMap[atom.type] || "context";
    const confidence = confMap[atom.confidence] || 0.70;

    const payload = {
      kind,
      assertion: atom.assertion,
      subject: atom.assertion.slice(0, 120),
      source: "system_generated" as const,
      evidence: atom.source_section ? `Source section: ${atom.source_section}` : undefined,
      confidence,
      tags: ["vault-harvest"],
      source_refs: sourceCapture ? [{ path: sourceCapture, type: "capture" }] : undefined,
    };

    try {
      const res = await fetch(`${voUrl}/memory/write`, {
        method: "POST",
        headers: tenantHeaders,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        err(`  ! write failed: "${atom.assertion.slice(0, 60)}..." — HTTP ${res.status}: ${errText.slice(0, 200)}`);
        writes.push({
          addr: "",
          assertion: atom.assertion,
          type: atom.type,
          confidence: atom.confidence,
          source_section: atom.source_section,
          deduplicated: false,
        });
        continue;
      }

      const result = (await res.json()) as any;
      if (result.deduplicated) {
        deduped++;
        log(`  = deduped: "${atom.assertion.slice(0, 60)}..." → ${result.existing_addr}`);
        writes.push({
          addr: result.existing_addr,
          assertion: atom.assertion,
          type: atom.type,
          confidence: atom.confidence,
          source_section: atom.source_section,
          deduplicated: true,
          existing_addr: result.existing_addr,
        });
      } else {
        log(`  + ${result.addr}: "${atom.assertion.slice(0, 60)}..."`);
        writes.push({
          addr: result.addr,
          assertion: atom.assertion,
          type: atom.type,
          confidence: atom.confidence,
          source_section: atom.source_section,
          deduplicated: false,
        });
      }
    } catch (caught: any) {
      // Round-3 audit fix: catch variable renamed from `err` so it
      // doesn't shadow the outer `err` log sink. Before the rename a
      // network failure from /memory/write reached this block, `err`
      // pointed at the caught exception, and `err(...)` called the
      // exception as a function — turning recoverable per-atom
      // failures into uncaught `TypeError: err is not a function`
      // crashes that then classified as `stop_unknown` under the
      // auto orchestrator.
      err(`  ! write error: "${atom.assertion.slice(0, 60)}..." — ${caught?.message}`);
      writes.push({
        addr: "",
        assertion: atom.assertion,
        type: atom.type,
        confidence: atom.confidence,
        source_section: atom.source_section,
        deduplicated: false,
      });
    }
  }

  const written = writes.filter((w) => w.addr && !w.deduplicated).length;
  const writtenAddrs = writes.filter((w) => w.addr).map((w) => w.addr);

  let docAddr: string | null = null;
  let docLinkStatus: ConfirmResult["doc_link_status"] = "skipped_no_operator_auth";

  if (!operatorToken) {
    docLinkStatus = "skipped_no_operator_auth";
    log(`  doc: skipped (VERITY_OPERATOR_TOKENS not set — doc node deferred)`);
  }

  let projectAddr: string | null = null;
  if (operatorToken) {
    try {
      const bsRes = await fetch(`${voUrl}/bootstrap/project`, {
        method: "POST",
        headers: tenantHeaders,
        body: JSON.stringify({ cwd: vaultRoot, goal: "vault doc-link" }),
      });
      if (bsRes.ok) {
        const bsData = (await bsRes.json()) as any;
        if (bsData.project_addr && bsData.confidence === "high") {
          projectAddr = bsData.project_addr;
        }
      }
    } catch {
      /* bootstrap unavailable — skip doc-link */
    }
  }

  if (operatorToken && !projectAddr) {
    docLinkStatus = "skipped_no_project";
    log(`  doc: skipped (no tenant project resolved — doc node deferred)`);
  } else if (operatorToken && projectAddr) {
    const captureFullPath = path.join(vaultRoot, sourceCapture);
    let captureContentHash = captureHash;
    if (fs.existsSync(captureFullPath)) {
      const captureContent = fs.readFileSync(captureFullPath, "utf-8");
      captureContentHash = `sha256:${crypto.createHash("sha256").update(captureContent).digest("hex")}`;
    }

    const docLinkPayload = {
      path: sourceCapture,
      title: title.slice(0, 120),
      doc_class: "hot_linked",
      domain: "tenant_ops",
      project_addr: projectAddr,
      content_hash: captureContentHash.replace(/^sha256:/, ""),
      hash_algorithm: "sha256",
      derived_memory_addrs: writtenAddrs,
    };

    try {
      const docRes = await fetch(`${voUrl}/ops/link-doc`, {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify(docLinkPayload),
      });

      if (docRes.ok) {
        const docResult = (await docRes.json()) as any;
        docAddr = docResult.addr || null;
        docLinkStatus = "linked";
        log(`  doc: ${docAddr} (${docResult.action || "linked"})`);
      } else if (docRes.status === 401 || docRes.status === 403) {
        docLinkStatus = "skipped_no_operator_auth";
        log(`  doc: skipped (operator auth not available — doc node deferred)`);
      } else {
        docLinkStatus = "failed";
        const errText = await docRes.text().catch(() => "");
        err(`  ! doc-link failed: HTTP ${docRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (caught: any) {
      // Round-3 audit fix: catch variable renamed from `err` so it
      // doesn't shadow the outer `err` log sink. Same shadowing bug
      // as the /memory/write catch above — a doc-link timeout would
      // crash with `TypeError: err is not a function` instead of
      // honestly recording `doc_link_status: "failed"` and continuing.
      docLinkStatus = "failed";
      err(`  ! doc-link error: ${caught?.message}`);
    }
  }

  const confirmResult: ConfirmResult = {
    capture_hash: captureHash,
    source_capture: sourceCapture,
    title,
    doc_addr: docAddr,
    doc_link_status: docLinkStatus,
    atoms_proposed: atoms.length,
    atoms_written: written,
    atoms_deduped: deduped,
    writes,
  };

  const dossierSlug = draft.filename.replace(/\.dossier\.draft\.md$/, "");
  const confirmPath = path.join(vaultRoot, "dossiers", `${dossierSlug}.confirm.json`);
  fs.writeFileSync(confirmPath, JSON.stringify(confirmResult, null, 2) + "\n", "utf-8");
  log(`  → dossiers/${dossierSlug}.confirm.json`);

  log("");
  log(`${written} written, ${deduped} deduped, ${atoms.length - written - deduped} failed.`);
  if (docAddr) log(`Doc node: ${docAddr}`);
  log(`Confirm manifest at dossiers/${dossierSlug}.confirm.json`);
  log(`Next: vo vault finalize --root ${args.root} ${hash8}`);

  return confirmResult;
}

export interface RunVaultFinalizeArgs {
  root: string;
  hash: string;
  verbose?: boolean;
  onLog?: HarvestLogSink;
  onErr?: HarvestLogSink;
}

export async function runVaultFinalize(args: RunVaultFinalizeArgs): Promise<FinalizeResult> {
  const log = resolveLog(args);
  const err = resolveErr(args);
  const vaultRoot = path.resolve(args.root);
  readVaultConfig(vaultRoot);
  const hash8 = args.hash.slice(0, 8);
  const now = new Date().toISOString();

  log("stage 6: FINALIZE");

  const confirm = findConfirmByHash(vaultRoot, hash8);
  if (!confirm) {
    vaultFail(
      "finalize",
      `no confirm artifact found matching hash prefix "${hash8}"`,
      `Run: vo vault confirm --root ${args.root} ${hash8}`,
    );
  }
  // Round-6 audit fix: the confirm artifact may be corrupted (disk
  // truncation, manual edit, partial write from a previous crash).
  // Wrap JSON.parse in try/catch and throw a structured
  // VaultStageError("finalize", ...) so library consumers never see
  // a raw SyntaxError leak from the shared seam.
  let confirmData: ConfirmResult;
  try {
    confirmData = JSON.parse(fs.readFileSync(confirm.path, "utf-8"));
  } catch (parseErr: any) {
    vaultFail(
      "finalize",
      `confirm artifact is corrupted: ${parseErr?.message || parseErr}`,
      `Inspect or delete ${confirm.path} and re-run \`vo vault confirm --root ${args.root} ${hash8}\`.`,
    );
  }
  log(`  confirm: dossiers/${confirm.filename}`);

  const draft = findDraftByHash(vaultRoot, hash8);
  let detailedNotes = "";
  if (draft) {
    const draftContent = fs.readFileSync(draft.path, "utf-8");
    const notesMatch = draftContent.match(/## Detailed Notes\n\n([\s\S]*?)(?=\n## |\n$)/);
    if (notesMatch) detailedNotes = notesMatch[1].trim();
  }

  const title = confirmData.title || "Untitled";
  const captureFilename = path.basename(confirmData.source_capture);
  const captureRelative = confirmData.source_capture;
  const voAddr = confirmData.doc_addr || "none";
  const voNodes = confirmData.writes.filter((w) => w.addr).map((w) => w.addr);

  const takeaways = confirmData.writes
    .filter((w) => w.addr)
    .slice(0, 3)
    .map((w, i) => `${i + 1}. ${w.assertion}`)
    .join("\n");

  const assertionRows = confirmData.writes
    .filter((w) => w.addr)
    .map((w, i) => `| ${i + 1} | ${w.assertion} | \`${w.addr}\` | ${w.type} | ${w.confidence} |`)
    .join("\n");

  const manifest = loadManifest(vaultRoot);
  const manifestEntry = manifest.find((e) => e.content_hash === confirmData.capture_hash);
  const finalSourceUrl = manifestEntry?.source_url || null;
  const capturedDate = manifestEntry?.captured_at ? manifestEntry.captured_at.split("T")[0] : "—";

  const voNodesYaml = voNodes.length > 0 ? voNodes.map((a) => `  - "${a}"`).join("\n") : "  []";

  const confCounts: Record<string, number> = {};
  for (const w of confirmData.writes) {
    confCounts[w.confidence] = (confCounts[w.confidence] || 0) + 1;
  }
  const majorityConf = Object.entries(confCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "medium";

  const finalBody = `
# ${title} — Dossier

**Source:** [${captureFilename}](../${captureRelative})
**VO Doc Node:** \`${voAddr}\`
**Captured:** ${capturedDate} | **Finalized:** ${now.split("T")[0]}
**URL:** ${finalSourceUrl || "local file"}

## Key Takeaways

${takeaways || "1. (no assertions)"}

## Assertions Written to VO

| # | Assertion | VO Addr | Type | Confidence |
|---|-----------|---------|------|------------|
${assertionRows || "| — | No assertions written | — | — | — |"}

## Detailed Notes

${detailedNotes || "(see capture for full source)"}

## Source Links

- Capture: [${captureFilename}](../${captureRelative})${voAddr !== "none" ? `\n- VO Doc Node: \`${voAddr}\` — \`curl localhost:3100/nodes/${voAddr}\`` : ""}
- Original: ${finalSourceUrl || "local file"}
`;

  const bodyHash = crypto.createHash("sha256").update(finalBody).digest("hex");

  const finalFrontmatter = `---
vo_addr: "${voAddr}"
vo_type: "dossier"
vo_managed: true
capture_hash: "${confirmData.capture_hash}"
source_capture: "${captureRelative}"
source_url: ${finalSourceUrl ? `"${finalSourceUrl}"` : "null"}
content_hash: "sha256:${bodyHash}"
source_hash: "${confirmData.capture_hash}"
generated_at: "${now}"
generated_by: "harvest/v1"
vo_nodes:
${voNodesYaml}
title: "${title.replace(/"/g, '\\"')} - Dossier"
confidence: "${majorityConf}"
tags: []
---`;

  const finalContent = finalFrontmatter + "\n" + finalBody;
  const finalFilename = `${confirm.slug}.dossier.md`;
  const finalPath = path.join(vaultRoot, "dossiers", finalFilename);

  let writeAction: "created" | "overwritten" | "conflict" = "created";
  let conflictFilename: string | undefined;
  let existingTags: string[] = [];

  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath, "utf-8");
    existingTags = extractExistingTags(existing);

    const fmMatch = existing.match(/content_hash:\s*"sha256:([a-f0-9]+)"/);
    if (fmMatch) {
      const storedHash = fmMatch[1];
      const existingBody = extractBodyContent(existing);
      const computedHash = crypto.createHash("sha256").update(existingBody).digest("hex");

      if (computedHash !== storedHash) {
        const conflictDir = path.join(vaultRoot, "dossiers", ".conflicts");
        fs.mkdirSync(conflictDir, { recursive: true });
        const conflictPath = path.join(conflictDir, finalFilename.replace(".dossier.md", ".dossier.conflict.md"));
        fs.writeFileSync(conflictPath, finalContent, "utf-8");
        writeAction = "conflict";
        conflictFilename = path.basename(conflictPath);
        log(`  ⚠ existing dossier was edited — new version at .conflicts/${conflictFilename}`);
      } else {
        writeAction = "overwritten";
      }
    } else {
      writeAction = "overwritten";
    }
  }

  if (writeAction !== "conflict") {
    if (existingTags.length > 0) {
      const mergedContent = finalContent.replace(
        /^tags: \[\]$/m,
        `tags: [${existingTags.map((t) => `"${t}"`).join(", ")}]`,
      );
      fs.writeFileSync(finalPath, mergedContent, "utf-8");
    } else {
      fs.writeFileSync(finalPath, finalContent, "utf-8");
    }
    log(`  ${writeAction === "created" ? "+" : "~"} dossiers/${finalFilename} (${writeAction})`);
  }

  log("stage 7: LOG");

  const logPath = path.join(vaultRoot, "log.md");
  const atomSummary = confirmData.writes
    .filter((w) => w.addr)
    .map((w, i) => `  ${i + 1}. \`${w.type}\` (${w.confidence}): ${w.assertion}`)
    .join("\n");
  const voNodeList = voNodes.join(", ") || "none";

  let dossierLogLine: string;
  if (writeAction === "conflict") {
    const conflictFilenameAgain = finalFilename.replace(".dossier.md", ".dossier.conflict.md");
    dossierLogLine = `- **Dossier:** dossiers/.conflicts/${conflictFilenameAgain} (conflict — human-edited original preserved at dossiers/${finalFilename})`;
  } else {
    dossierLogLine = `- **Dossier:** dossiers/${finalFilename}`;
  }

  const logEntry = `
## [${now}] harvest | "${title}"
- **Source:** ${captureRelative}
- **Source URL:** local file
- **Capture hash:** ${confirmData.capture_hash}
- **Mode:** confirm
- **Atoms proposed:** ${confirmData.atoms_proposed}
- **Atoms written:** ${confirmData.atoms_written} (${confirmData.atoms_deduped} deduped)
- **VO nodes:** ${voNodeList}
${dossierLogLine}
- **Proposed atoms at confirm time:**
${atomSummary}
`;
  fs.appendFileSync(logPath, logEntry, "utf-8");
  log(`  + log.md (entry appended)`);

  const dossierDir = path.join(vaultRoot, "dossiers");
  const allFinalFilenames = fs.readdirSync(dossierDir).filter((f) => f.endsWith(".dossier.md") && !f.includes(".conflict"));

  interface IndexEntry {
    filename: string;
    title: string;
    date: string;
    dateRaw: string;
    atomCount: number;
    sourceCapture: string;
  }
  const entries: IndexEntry[] = [];
  let totalAtoms = 0;
  for (const f of allFinalFilenames) {
    const contentRead = fs.readFileSync(path.join(dossierDir, f), "utf-8");
    const titleMatch = contentRead.match(/^title:\s*"(.+?)"/m);
    const t = titleMatch ? titleMatch[1].replace(/ - Dossier$/, "") : f;
    const dateMatch = contentRead.match(/generated_at:\s*"([^"]+)"/);
    const dateRaw = dateMatch ? dateMatch[1] : "";
    const d = dateRaw ? dateRaw.split("T")[0] : "—";
    const nodesMatch = contentRead.match(/^vo_nodes:\n((?:\s+-\s+"[^"]+"\n)*)/m);
    let atomCount = 0;
    if (nodesMatch) {
      atomCount = (nodesMatch[1].match(/- "/g) || []).length;
    }
    totalAtoms += atomCount;
    const scMatch = contentRead.match(/source_capture:\s*"([^"]+)"/);
    const sc = scMatch ? scMatch[1] : "";
    entries.push({ filename: f, title: t, date: d, dateRaw, atomCount, sourceCapture: sc });
  }

  entries.sort((a, b) => {
    if (!a.dateRaw && !b.dateRaw) return 0;
    if (!a.dateRaw) return 1;
    if (!b.dateRaw) return -1;
    return b.dateRaw.localeCompare(a.dateRaw);
  });

  const indexRows = entries.map(
    (e) => `| [${e.title}](dossiers/${e.filename}) | ${e.date} | ${e.atomCount} | [capture](${e.sourceCapture}) |`,
  );

  const indexContent = `# Vault Index

| Dossier | Date | Atoms | Source |
|---------|------|-------|--------|
${indexRows.join("\n")}

*${entries.length} sources captured. ${totalAtoms} assertions in VO.*
`;
  fs.writeFileSync(path.join(vaultRoot, "index.md"), indexContent, "utf-8");
  log(`  ~ index.md (${entries.length} dossiers, ${totalAtoms} atoms)`);

  if (draft) {
    fs.unlinkSync(draft.path);
    log(`  - dossiers/${draft.filename} (draft removed)`);
  }
  fs.unlinkSync(confirm.path);
  log(`  - dossiers/${confirm.filename} (confirm artifact removed)`);

  log("");
  log(`Finalized: dossiers/${finalFilename}`);

  return { writeAction, finalFilename, conflictFilename };
}

// ─── Auto orchestrator ─────────────────────────────────────────────────

export interface RunVaultHarvestAutoArgs {
  root: string;
  source: string;
  skipAtomize?: boolean;
  fixtureAtoms?: VaultAtom[];
  tenantToken: string;
  operatorToken?: string | null;
  verbose?: boolean;
  onLog?: HarvestLogSink;
  onErr?: HarvestLogSink;
}

/**
 * Full stages-1-7 orchestrator. Never throws — catches every failure
 * internally and returns a classified AutoOutcome. Library callers
 * consume the structured outcome; CLI callers additionally render it
 * through `formatOutcome` (defined in vault-auto-report.ts).
 *
 * Quiet by default. When `verbose === true` (and no `onLog`/`onErr`
 * override), the underlying stage transcripts pass through to
 * `console.log` / `console.error`. Library consumers should pass
 * `onLog` / `onErr` to capture stage output structurally.
 *
 * Return-only contract: every path — stage failure, non-stage
 * failure (e.g. malformed vault config, unexpected runtime), even a
 * throw from a misbehaving caller-provided sink — yields an
 * AutoOutcome. Non-VaultStageError exceptions are normalized into
 * `stop_unknown` so the structured outcome union is the single signal
 * channel for dashboard and MCP consumers.
 */
export async function runVaultHarvestAuto(args: RunVaultHarvestAutoArgs): Promise<AutoOutcome> {
  const vaultRoot = path.resolve(args.root);

  let capturePath: string | null = null;
  let draftPath: string | null = null;
  let hash8: string | null = null;

  // Pass-through log sinks so library consumers can capture stage
  // transcripts without touching process-global console.
  const passLog = args.onLog;
  const passErr = args.onErr;

  try {
    const harvestResult = await runVaultHarvest({
      root: vaultRoot,
      source: isUrl(args.source) ? args.source : path.resolve(args.source),
      skipAtomize: args.skipAtomize,
      fixtureAtoms: args.fixtureAtoms,
      verbose: args.verbose,
      onLog: passLog,
      onErr: passErr,
    });

    hash8 = harvestResult.hash8;
    capturePath = resolveVaultRelative(vaultRoot, "captures", hash8);
    draftPath = resolveVaultRelative(vaultRoot, "dossiers", hash8, ".draft.md");

    const confirmResult = await runVaultConfirm({
      root: vaultRoot,
      hash: hash8,
      tenantToken: args.tenantToken,
      operatorToken: args.operatorToken,
      verbose: args.verbose,
      onLog: passLog,
      onErr: passErr,
    });

    const finalizeResult = await runVaultFinalize({
      root: vaultRoot,
      hash: hash8,
      verbose: args.verbose,
      onLog: passLog,
      onErr: passErr,
    });

    const graphWrite = graphWriteStatusFromCounts(confirmResult.atoms_written, confirmResult.atoms_deduped);
    const docLink = confirmResult.doc_link_status as DocLinkStatus;

    if (finalizeResult.writeAction === "conflict") {
      return {
        kind: "stop_finalize_conflict",
        conflictPath: `dossiers/.conflicts/${finalizeResult.conflictFilename}`,
        preservedDossierPath: `dossiers/${finalizeResult.finalFilename}`,
        hash8: hash8!,
        root: args.root,
        graphWrite,
        atomsWritten: confirmResult.atoms_written,
        atomsDeduped: confirmResult.atoms_deduped,
        docLink,
      };
    }

    // Round-6 audit fix: reject the false-success path where every
    // `/memory/write` failed. `runVaultConfirm` downgrades per-atom
    // HTTP errors to rows with `addr: ""` and keeps going, so the
    // pipeline flowed to finalize even though zero atoms landed in
    // the graph. A tenant expects `success` to mean "knowledge is in
    // VO" — a dossier with an empty assertions table doesn't meet
    // that bar. Classify as `stop_vo_unavailable(all_writes_failed)`
    // so the CLI emits an honest stop summary and the dashboard/MCP
    // consumer can render the right guided recovery.
    if (
      confirmResult.atoms_proposed > 0 &&
      confirmResult.atoms_written === 0 &&
      confirmResult.atoms_deduped === 0
    ) {
      return {
        kind: "stop_vo_unavailable",
        draftPath,
        hash8: hash8!,
        root: args.root,
        subReason: "all_writes_failed",
        dossierPath: `dossiers/${finalizeResult.finalFilename}`,
        atomsProposed: confirmResult.atoms_proposed,
      };
    }

    return {
      kind: "success",
      capturePath: capturePath || `captures/${hash8}-…`,
      dossierPath: `dossiers/${finalizeResult.finalFilename}`,
      graphWrite,
      atomsWritten: confirmResult.atoms_written,
      atomsDeduped: confirmResult.atoms_deduped,
      docLink,
      nodeAddrs: confirmResult.writes
        .filter((w) => w.addr && !w.deduplicated)
        .map((w) => w.addr),
    };
  } catch (err: any) {
    // Stage failures classify normally.
    if (err instanceof VaultStageError) {
      return classifyStopFromError(err, {
        root: args.root,
        hash8,
        capturePath,
        draftPath,
      });
    }
    // Non-stage failures (malformed vault config, unexpected runtime
    // failures, misbehaving caller sinks) are normalized into
    // stop_unknown so every return path yields an AutoOutcome.
    // Dashboard and MCP consumers never need a second error-handling
    // path — the discriminated union is the single signal channel.
    return {
      kind: "stop_unknown",
      stage: "unknown",
      message: err?.message ? String(err.message) : String(err),
      resumeHint: "",
      root: args.root || null,
    };
  }
}

// ─── Seam marker ───────────────────────────────────────────────────────

export const VAULT_HARVEST_SEAM_MARKER = "vo-vault-harvest-v1";
