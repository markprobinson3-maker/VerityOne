import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./runtime-profile";

export const BROWSER_CAPTURE_TOKEN_PREFIX = "vobc_";
export const BROWSER_CAPTURE_TOKEN_SCOPE = "browser_capture:intake";

export type BrowserCaptureTokenStatus = "active" | "revoked";

export interface BrowserCaptureTokenRecord {
  token_id: string;
  tenant_id: string;
  label: string | null;
  scope: typeof BROWSER_CAPTURE_TOKEN_SCOPE;
  token_hash: string;
  token_prefix: string;
  status: BrowserCaptureTokenStatus;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface BrowserCaptureTokenPublic {
  token_id: string;
  tenant_id: string;
  label: string | null;
  scope: typeof BROWSER_CAPTURE_TOKEN_SCOPE;
  token_prefix: string;
  status: BrowserCaptureTokenStatus;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface BrowserCaptureTokenIssueResult {
  token: string;
  record: BrowserCaptureTokenPublic;
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

export function browserCaptureTokenStorePath(): string {
  return path.join(configDir(), "browser-capture-tokens.json");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readRecords(): BrowserCaptureTokenRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(browserCaptureTokenStorePath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is BrowserCaptureTokenRecord => {
      const r = record as Partial<BrowserCaptureTokenRecord>;
      return typeof r.token_id === "string"
        && typeof r.tenant_id === "string"
        && r.scope === BROWSER_CAPTURE_TOKEN_SCOPE
        && typeof r.token_hash === "string"
        && /^[a-f0-9]{64}$/.test(r.token_hash)
        && typeof r.token_prefix === "string"
        && (r.status === "active" || r.status === "revoked")
        && typeof r.created_at === "string";
    });
  } catch {
    return [];
  }
}

// SINGLE-WRITER INVARIANT (batch-21 P2): the read-mutate-write mutators in this module
// (mint / revoke / resolve's last_used_at touch) are not mutually locked, so a concurrent
// revoke + capture could last-writer-win and resurrect a stale "active" record. This is
// safe ONLY because the browser-capture token store is owned by the SINGLE long-lived
// local node process — the local-control routes that touch it are 503'd on serverless
// (api/index.ts LONG_LIVED_PREFIX_RE), and these mutators run synchronously within that
// one process, so there is never a second concurrent writer. If that ever changes (a
// worker thread / second process), add an advisory file lock or move the store to the DB
// before relying on it for revocation.
function writeRecords(records: BrowserCaptureTokenRecord[]): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = browserCaptureTokenStorePath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

function publicRecord(record: BrowserCaptureTokenRecord): BrowserCaptureTokenPublic {
  return {
    token_id: record.token_id,
    tenant_id: record.tenant_id,
    label: record.label,
    scope: record.scope,
    token_prefix: record.token_prefix,
    status: record.status,
    created_at: record.created_at,
    revoked_at: record.revoked_at,
    last_used_at: record.last_used_at,
  };
}

export function issueBrowserCaptureToken(input: {
  tenantId: string;
  label?: string | null;
  now?: Date;
}): BrowserCaptureTokenIssueResult {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("tenantId is required");
  const token = `${BROWSER_CAPTURE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const nowIso = (input.now ?? new Date()).toISOString();
  const label = typeof input.label === "string" && input.label.trim()
    ? input.label.trim().slice(0, 120)
    : null;
  const record: BrowserCaptureTokenRecord = {
    token_id: crypto.randomUUID(),
    tenant_id: tenantId,
    label,
    scope: BROWSER_CAPTURE_TOKEN_SCOPE,
    token_hash: hashToken(token),
    token_prefix: token.slice(0, 12),
    status: "active",
    created_at: nowIso,
    revoked_at: null,
    last_used_at: null,
  };
  writeRecords([...readRecords(), record]);
  return { token, record: publicRecord(record) };
}

export function listBrowserCaptureTokens(tenantId: string): BrowserCaptureTokenPublic[] {
  return readRecords()
    .filter((record) => record.tenant_id === tenantId)
    .map(publicRecord)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function revokeBrowserCaptureToken(input: {
  tenantId: string;
  tokenId: string;
  now?: Date;
}): BrowserCaptureTokenPublic | null {
  const records = readRecords();
  const idx = records.findIndex((record) => record.tenant_id === input.tenantId && record.token_id === input.tokenId);
  if (idx === -1) return null;
  const current = records[idx];
  const next: BrowserCaptureTokenRecord = {
    ...current,
    status: "revoked",
    revoked_at: current.revoked_at ?? (input.now ?? new Date()).toISOString(),
  };
  records[idx] = next;
  writeRecords(records);
  return publicRecord(next);
}

export function resolveBrowserCaptureToken(rawToken: string): BrowserCaptureTokenPublic | null {
  const token = rawToken.trim();
  if (!token.startsWith(BROWSER_CAPTURE_TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  const records = readRecords();
  const idx = records.findIndex((record) =>
    record.status === "active"
      && record.scope === BROWSER_CAPTURE_TOKEN_SCOPE
      && timingSafeHexEqual(record.token_hash, tokenHash)
  );
  if (idx === -1) return null;
  const next: BrowserCaptureTokenRecord = {
    ...records[idx],
    last_used_at: new Date().toISOString(),
  };
  records[idx] = next;
  writeRecords(records);
  return publicRecord(next);
}
