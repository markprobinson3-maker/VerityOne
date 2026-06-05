/**
 * Vault dossier write path — plan Rung 3 (VO-VAULT-OBSIDIAN-WRITE-PATH).
 *
 * Turns a graph node into a verifiable on-disk source artifact: a markdown
 * dossier at `<vaultRoot>/dossiers/<addr>.md`, sha256-stamped back onto the
 * node's `source_refs` as a `kind:"vault_file"` ref (PR#47 helpers). This is
 * the unfaked-trust primitive — "every memory has a source file you can open
 * in Obsidian and verify byte-for-byte."
 *
 * HARD CONSTRAINT — local profile only. Every filesystem-touching export
 * calls assertLocalProfile() first, which refuses on the serverless profile
 * or any Vercel runtime signal. This is defense-in-depth ON TOP of the
 * route-level gates (the long-lived launcher / api/index.ts prefix regex):
 * the module itself can never write to a hosted filesystem even if a future
 * caller forgets to gate. Mirrors the serverless detection in access.ts.
 *
 * Two distinct sha256 values — never conflate them:
 *   1. `content_hash` IN the frontmatter = sha256 of the BODY ONLY. Drives
 *      the human-edit conflict-detection protocol (reuses the harvest
 *      pipeline's `.conflicts/` semantics).
 *   2. the `vault_file` source_ref `sha256` = sha256 of the ENTIRE on-disk
 *      file bytes (frontmatter + body), re-read AFTER write. This is the
 *      value stamped onto the node and the one verifyDossierHash checks. 64
 *      lowercase hex, satisfying buildVaultFileSourceRef's /^[0-9a-f]{64}$/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type postgres from "postgres";
import { addVaultFileSourceRef, type SourceRef } from "./source-refs";
import { parseJsonField } from "./utils";

type SqlTag = ReturnType<typeof postgres>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Stop classification for callers that map errors to envelopes. */
export class VaultWriteError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = "VaultWriteError";
  }
}

type EnvLike = Record<string, string | undefined>;

/**
 * Refuse any filesystem write/read on the serverless profile. Mirrors the
 * serverless detection in access.ts (VERITY_DEPLOYMENT_PROFILE==='serverless'
 * OR a Vercel runtime signal). Called at the top of every fs-touching export.
 */
function assertLocalProfile(env: EnvLike = process.env): void {
  const profile = (env.VERITY_DEPLOYMENT_PROFILE ?? "").trim();
  const vercel =
    (env.VERCEL ?? "").trim() === "1" ||
    Boolean((env.VERCEL_ENV ?? "").trim()) ||
    Boolean((env.VERCEL_URL ?? "").trim());
  if (profile === "serverless" || vercel) {
    throw new VaultWriteError(
      "serverless_filesystem_forbidden",
      "Vault dossier writes are local-profile only; refused on serverless/Vercel runtime.",
    );
  }
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** A dossier `addr` is also a filename segment — it must not escape dossiers/. */
function assertSafeAddr(addr: string): void {
  if (!addr || addr.includes("/") || addr.includes("\\") || addr.includes("..") || addr.includes("\0")) {
    throw new VaultWriteError("invalid_addr", `unsafe dossier addr: ${JSON.stringify(addr)}`);
  }
}

/**
 * A vault-relative path must stay inside the vault root: no absolute path, no
 * `..` traversal, no null byte. Defense-in-depth — every fs-touching export
 * that takes a caller-supplied relative path validates it here, independent of
 * route-level checks (the module must be safe even if a future caller forgets
 * to validate).
 */
function assertSafeRelPath(relPath: string): void {
  if (
    typeof relPath !== "string" ||
    !relPath ||
    path.isAbsolute(relPath) ||
    relPath.includes("..") ||
    relPath.includes("\0")
  ) {
    throw new VaultWriteError("dossier_path_unsafe", `unsafe vault-relative path: ${JSON.stringify(relPath)}`);
  }
}

/** Double-quoted YAML scalar with backslash + quote escaping. */
function yamlScalar(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface DossierContent {
  /** Node address; also the dossier filename stem (dossiers/<addr>.md). */
  addr: string;
  title: string;
  /** Markdown body (without frontmatter). content_hash is computed over this. */
  body: string;
  /** Provenance tag, e.g. "remember/v1" or "harvest/v1". */
  generatedBy: string;
  tags?: string[];
  confidence?: number;
  /** Extra frontmatter scalars (string → quoted; number/bool → bare). */
  extraFrontmatter?: Record<string, string | number | boolean>;
}

/**
 * Render a dossier file body. Returns the full file text (frontmatter + body)
 * and the bodyHash (sha256 of the body only). The frontmatter ends with the
 * fence `---\n`; extractBody() below is the exact inverse so a round-trip
 * re-hash of the body matches bodyHash (the conflict-detection invariant).
 */
export function renderDossier(content: DossierContent): { full: string; bodyHash: string } {
  assertSafeAddr(content.addr);
  const bodyHash = sha256Hex(content.body);
  const lines: string[] = ["---"];
  lines.push(`vo_addr: ${yamlScalar(content.addr)}`);
  lines.push(`vo_type: "dossier"`);
  lines.push(`vo_managed: true`);
  lines.push(`content_hash: "sha256:${bodyHash}"`);
  lines.push(`generated_by: ${yamlScalar(content.generatedBy)}`);
  lines.push(`title: ${yamlScalar(content.title)}`);
  if (typeof content.confidence === "number" && Number.isFinite(content.confidence)) {
    lines.push(`confidence: ${content.confidence}`);
  }
  lines.push(`tags: [${(content.tags ?? []).map(yamlScalar).join(", ")}]`);
  for (const [key, value] of Object.entries(content.extraFrontmatter ?? {})) {
    lines.push(`${key}: ${typeof value === "string" ? yamlScalar(value) : value}`);
  }
  lines.push("---", "");
  // join inserts "\n" between every element → frontmatter ends with "...\n---\n".
  const full = lines.join("\n") + content.body;
  return { full, bodyHash };
}

/** Parse simple `key: value` frontmatter scalars from a dossier file. */
function parseFrontmatter(fileText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fm = fileText.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return out;
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = v;
  }
  return out;
}

/** The `content_hash: "sha256:<hex>"` body-hash stored in frontmatter, or null. */
function parseStoredBodyHash(fileText: string): string | null {
  const m = fileText.match(/^content_hash:\s*"?sha256:([0-9a-f]{64})"?/m);
  return m ? m[1] : null;
}

/** Everything after the frontmatter fence — exact inverse of renderDossier. */
function extractBody(fileText: string): string {
  const fm = fileText.match(/^---\n[\s\S]*?\n---\n/);
  return fm ? fileText.slice(fm[0].length) : fileText;
}

/** Atomic write via temp-file + rename (no partial files on crash). */
function atomicWrite(absPath: string, content: string): void {
  const tmp = `${absPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, absPath);
}

export function buildObsidianOpenUrl(vaultName: string, dossierRelPath: string): string {
  // The 'obsidian://open?vault=&file=' scheme+action is load-bearing and pinned
  // by value in the drift suite — never the path-style action verb.
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(dossierRelPath)}`;
}

async function stampVaultFileRefs(
  sql: SqlTag,
  addrs: string[],
  dossierRelPath: string,
  sha256: string,
  openedVia?: "obsidian" | "system",
  vaultId?: string,
): Promise<string[]> {
  if (!SHA256_HEX.test(sha256)) throw new VaultWriteError("bad_sha256", `not 64-hex: ${sha256}`);
  const stamped: string[] = [];
  await sql.begin(async (tx: any) => {
    for (const addr of addrs) {
      const [row] = await tx`SELECT source_refs FROM nodes WHERE addr = ${addr} FOR UPDATE`;
      if (!row) continue;
      const existing = (parseJsonField(row.source_refs) as SourceRef[]) ?? [];
      // addVaultFileSourceRef supersedes by path → re-stamping the same
      // dossier path is idempotent (latest sha256 wins).
      const next = addVaultFileSourceRef(existing, {
        path: dossierRelPath,
        sha256,
        opened_via: openedVia,
        vault_id: vaultId,
      });
      await tx`UPDATE nodes SET source_refs = ${tx.json(next)} WHERE addr = ${addr}`;
      stamped.push(addr);
    }
  });
  return stamped;
}

export interface WriteNodeDossierInput {
  /** Absolute vault root (from resolveConfiguredVaultRoot + inspectVaultRoot). */
  vaultRoot: string;
  content: DossierContent;
  openedVia?: "obsidian" | "system";
  vaultId?: string;
  /** Node addrs to stamp the ref onto. Defaults to [content.addr]. */
  stampAddrs?: string[];
}

export interface WriteNodeDossierResult {
  writeAction: "created" | "overwritten" | "conflict";
  dossierRelPath: string;
  conflictRelPath?: string;
  /** File sha256 stamped onto the node, or null on conflict (not stamped). */
  sha256: string | null;
  obsidianUri: string;
  stampedAddrs: string[];
}

/**
 * Write `dossiers/<addr>.md`, sha256-verify, and stamp the vault_file ref onto
 * the node(s). On a human-edited canonical file, divert the VO-generated
 * version to `dossiers/.conflicts/` and DO NOT overwrite or re-stamp (the
 * prior ref stays valid; the conflict is surfaced for human resolution).
 */
export async function writeNodeDossier(
  sql: SqlTag,
  input: WriteNodeDossierInput,
): Promise<WriteNodeDossierResult> {
  assertLocalProfile();
  const { vaultRoot, content } = input;
  if (!path.isAbsolute(vaultRoot)) throw new VaultWriteError("vault_root_not_absolute", vaultRoot);
  assertSafeAddr(content.addr);

  const dossierRelPath = `dossiers/${content.addr}.md`;
  const finalPath = path.join(vaultRoot, "dossiers", `${content.addr}.md`);
  const { full } = renderDossier(content);
  const vaultName = path.basename(vaultRoot);

  let writeAction: "created" | "overwritten" | "conflict" = "created";
  let conflictRelPath: string | undefined;

  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath, "utf-8");
    const storedHash = parseStoredBodyHash(existing);
    const existingBodyHash = sha256Hex(extractBody(existing));
    if (storedHash && storedHash === existingBodyHash) {
      // File unchanged since VO last wrote it → safe to overwrite in place.
      writeAction = "overwritten";
    } else {
      // Human edited the canonical dossier → preserve it, divert VO's version.
      writeAction = "conflict";
      const conflictDir = path.join(vaultRoot, "dossiers", ".conflicts");
      fs.mkdirSync(conflictDir, { recursive: true });
      atomicWrite(path.join(conflictDir, `${content.addr}.dossier.conflict.md`), full);
      conflictRelPath = `dossiers/.conflicts/${content.addr}.dossier.conflict.md`;
    }
  }

  if (writeAction === "conflict") {
    // Ref NOT re-stamped: the canonical on-disk body no longer matches the
    // graph, so the prior ref (if any) stays authoritative until resolved.
    return {
      writeAction,
      dossierRelPath,
      conflictRelPath,
      sha256: null,
      obsidianUri: buildObsidianOpenUrl(vaultName, dossierRelPath),
      stampedAddrs: [],
    };
  }

  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  atomicWrite(finalPath, full);
  // sha256 over the ACTUAL on-disk bytes, re-read after write.
  const sha256 = sha256Hex(fs.readFileSync(finalPath));
  const stampedAddrs = await stampVaultFileRefs(
    sql,
    input.stampAddrs ?? [content.addr],
    dossierRelPath,
    sha256,
    input.openedVia,
    input.vaultId,
  );

  return {
    writeAction,
    dossierRelPath,
    sha256,
    obsidianUri: buildObsidianOpenUrl(vaultName, dossierRelPath),
    stampedAddrs,
  };
}

export interface StampExistingDossierResult {
  dossierRelPath: string;
  sha256: string;
  obsidianUri: string;
  stampedAddrs: string[];
}

/**
 * Stamp an ALREADY-WRITTEN dossier (e.g. the harvest pipeline's
 * `dossiers/<hash8>-<slug>.dossier.md`) onto the node(s) it produced. Re-reads
 * the file, computes the on-disk sha256, and adds the vault_file ref. Many
 * nodes from one capture legitimately share one source dossier.
 */
export async function stampExistingDossier(
  sql: SqlTag,
  input: { vaultRoot: string; dossierRelPath: string; addrs: string[]; openedVia?: "obsidian" | "system"; vaultId?: string },
): Promise<StampExistingDossierResult> {
  assertLocalProfile();
  const { vaultRoot, dossierRelPath, addrs } = input;
  if (!path.isAbsolute(vaultRoot)) throw new VaultWriteError("vault_root_not_absolute", vaultRoot);
  assertSafeRelPath(dossierRelPath);
  const abs = path.join(vaultRoot, dossierRelPath);
  if (!fs.existsSync(abs)) throw new VaultWriteError("dossier_missing", abs);
  const sha256 = sha256Hex(fs.readFileSync(abs));
  const stampedAddrs = await stampVaultFileRefs(sql, addrs, dossierRelPath, sha256, input.openedVia, input.vaultId);
  return {
    dossierRelPath,
    sha256,
    obsidianUri: buildObsidianOpenUrl(path.basename(vaultRoot), dossierRelPath),
    stampedAddrs,
  };
}

export interface ReadNodeDossierResult {
  exists: boolean;
  frontmatter: Record<string, string>;
  body: string;
  storedContentHash: string | null;
  fileSha256: string | null;
}

export function readNodeDossier(vaultRoot: string, dossierRelPath: string): ReadNodeDossierResult {
  assertLocalProfile();
  assertSafeRelPath(dossierRelPath);
  const abs = path.join(vaultRoot, dossierRelPath);
  if (!fs.existsSync(abs)) {
    return { exists: false, frontmatter: {}, body: "", storedContentHash: null, fileSha256: null };
  }
  const text = fs.readFileSync(abs, "utf-8");
  return {
    exists: true,
    frontmatter: parseFrontmatter(text),
    body: extractBody(text),
    storedContentHash: parseStoredBodyHash(text),
    fileSha256: sha256Hex(fs.readFileSync(abs)),
  };
}

export interface VerifyDossierHashResult {
  ok: boolean;
  reason?: "missing" | "mismatch" | "bad_expected";
  actualSha256: string | null;
}

/**
 * Verify-on-open guard: confirm the on-disk dossier still matches the sha256
 * stamped on the node's vault_file ref. The dashboard "Open in Obsidian"
 * handler calls this on click (not on paint) before handing off to Obsidian.
 */
export function verifyDossierHash(
  vaultRoot: string,
  dossierRelPath: string,
  expectedSha256: string,
): VerifyDossierHashResult {
  assertLocalProfile();
  assertSafeRelPath(dossierRelPath);
  if (!SHA256_HEX.test(expectedSha256)) return { ok: false, reason: "bad_expected", actualSha256: null };
  const abs = path.join(vaultRoot, dossierRelPath);
  if (!fs.existsSync(abs)) return { ok: false, reason: "missing", actualSha256: null };
  const actual = sha256Hex(fs.readFileSync(abs));
  return actual === expectedSha256
    ? { ok: true, actualSha256: actual }
    : { ok: false, reason: "mismatch", actualSha256: actual };
}
