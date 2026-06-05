import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveConfigPath } from "./runtime-profile";

export type LocalSecretStorage = "keychain" | "file_fallback";

const SYNC_SERVICE = "Verity One Local Sync";
const SECRET_SERVICE = "Verity One Local Secrets";

export interface LocalSyncCredentialInput {
  tenantId: string;
  nodeId: string;
  rawToken: string;
  accountEmail?: string | null;
  accountId?: string | null;
  hostedBaseUrl?: string | null;
  issuedAt?: string | null;
}

export interface LocalSyncCredentialStatus {
  tenant_id: string;
  node_id: string;
  token_present: boolean;
  account_id: string | null;
  account_email: string | null;
  hosted_base_url: string | null;
  storage: LocalSecretStorage;
  keychain_attempted: boolean;
  issued_at: string | null;
  token_prefix: string | null;
}

interface LocalSyncCredentialMetadata {
  tenant_id: string;
  node_id: string;
  account_id: string | null;
  hosted_base_url: string | null;
  storage: LocalSecretStorage;
  keychain_attempted?: boolean;
  issued_at: string;
  token_prefix: string;
}

export interface LocalSecretRef {
  secret_ref: string;
  storage: LocalSecretStorage;
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

function metadataPath(): string {
  return path.join(configDir(), "hosted-connection.json");
}

function legacySyncTokenPath(): string {
  return path.join(configDir(), "sync-token");
}

function credentialKeysPath(): string {
  return path.join(configDir(), "hosted-credential-keys.json");
}

function fileSecretDir(): string {
  return path.join(configDir(), "secrets");
}

function secretFilePath(ref: string): string {
  const digest = crypto.createHash("sha256").update(ref).digest("hex");
  return path.join(fileSecretDir(), `${digest}.secret`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite0600(target: string, content: string): void {
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

function assertSecureSecretFile(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error("sync_token_file_insecure: refusing to read symlink");
  }
  if (!stat.isFile()) {
    throw new Error("sync_token_file_insecure: refusing to read non-file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("sync_token_file_insecure: file permissions must be 0600");
  }
}

function preferFileFallback(): boolean {
  return process.env.VERITY_LOCAL_SECRET_STORE === "file";
}

function canUseKeychain(): boolean {
  return process.platform === "darwin" && !preferFileFallback();
}

function keychainWrite(service: string, account: string, secret: string): boolean {
  if (!canUseKeychain()) return false;
  // The secret MUST be the value of -w. `security add-generic-password` does not read
  // the password from stdin (it prompts on a TTY), so the previous form — a bare `-w`
  // with the secret piped to stdin and `-U` immediately after — made `security` consume
  // the next token ("-U") as the password and store the literal string "-U" as EVERY
  // secret, silently corrupting keychain-backed credentials (e.g. the Drive ephemeral
  // private key, which then failed to decrypt the sealed token). -U (update if present)
  // must precede the `-w <secret>` pair.
  const res = spawnSync("security", [
    "add-generic-password",
    "-U",
    "-a", account,
    "-s", service,
    "-w", secret,
  ], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  return res.status === 0;
}

function keychainRead(service: string, account: string): string | null {
  if (!canUseKeychain()) return null;
  const res = spawnSync("security", [
    "find-generic-password",
    "-a", account,
    "-s", service,
    "-w",
  ], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const value = String(res.stdout || "").trim();
  return value || null;
}

function keychainDelete(service: string, account: string): void {
  if (!canUseKeychain()) return;
  spawnSync("security", [
    "delete-generic-password",
    "-a", account,
    "-s", service,
  ], { stdio: "ignore" });
}

function syncAccountKey(tenantId: string, nodeId: string): string {
  return `${tenantId}:${nodeId}`;
}

function syncAccountEmailRef(accountKey: string): string {
  return `sync-account-email:${accountKey}`;
}

function readCredentialKeyIndex(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialKeysPath(), "utf8"));
    return Array.isArray(raw?.keys) ? raw.keys.filter((key: unknown) => typeof key === "string" && key) : [];
  } catch {
    return [];
  }
}

function writeCredentialKeyIndex(keys: Iterable<string>): void {
  atomicWrite0600(credentialKeysPath(), JSON.stringify({ keys: [...new Set(keys)].sort() }, null, 2));
}

function rememberCredentialKey(accountKey: string): void {
  writeCredentialKeyIndex([...readCredentialKeyIndex(), accountKey]);
}

function forgetCredentialKey(accountKey: string): void {
  const next = readCredentialKeyIndex().filter((key) => key !== accountKey);
  if (next.length > 0) writeCredentialKeyIndex(next);
  else {
    try { fs.unlinkSync(credentialKeysPath()); } catch { /* already gone */ }
  }
}

function readMetadata(): LocalSyncCredentialMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(metadataPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeMetadata(meta: LocalSyncCredentialMetadata): void {
  atomicWrite0600(metadataPath(), JSON.stringify(meta, null, 2));
}

function writeFileSecret(ref: string, secret: string): void {
  atomicWrite0600(secretFilePath(ref), `${secret}\n`);
}

function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function readFileSecret(ref: string): string | null {
  const target = secretFilePath(ref);
  try {
    assertSecureSecretFile(target);
    const value = fs.readFileSync(target, "utf8").trim();
    return value || null;
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
    return null;
  }
}

function clearFileSecret(ref: string): void {
  try {
    fs.unlinkSync(secretFilePath(ref));
  } catch {
    // already gone
  }
}

export function sweepOrphanedLocalSecretFiles(activeRefs: Iterable<string>, olderThanMs = 10 * 60 * 1000): number {
  const activeSecretPaths = new Set(
    [...activeRefs]
      .filter(Boolean)
      .map((ref) => secretFilePath(ref)),
  );
  const dir = fileSecretDir();
  let cleared = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.endsWith(".secret")) continue;
    const target = path.join(dir, entry);
    if (activeSecretPaths.has(target)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (stat.mtimeMs > cutoff) continue;
      fs.unlinkSync(target);
      cleared++;
    } catch {
      // Concurrent cleanup or unreadable file: leave it alone.
    }
  }
  return cleared;
}

export function writeLocalSecret(ref: string, rawSecret: string): LocalSecretRef {
  if (!rawSecret) throw new Error("rawSecret is required");
  if (keychainWrite(SECRET_SERVICE, ref, rawSecret)) {
    clearFileSecret(ref);
    return { secret_ref: ref, storage: "keychain" };
  }
  writeFileSecret(ref, rawSecret);
  return { secret_ref: ref, storage: "file_fallback" };
}

export function readLocalSecret(ref: string, storage?: LocalSecretStorage): string | null {
  if (!ref) return null;
  if (storage !== "file_fallback") {
    const keychain = keychainRead(SECRET_SERVICE, ref);
    if (keychain) return keychain;
  }
  return readFileSecret(ref);
}

export function clearLocalSecret(ref: string): void {
  if (!ref) return;
  keychainDelete(SECRET_SERVICE, ref);
  clearFileSecret(ref);
}

export function writeLocalSyncCredential(input: LocalSyncCredentialInput): LocalSyncCredentialStatus {
  const tenantId = input.tenantId.trim();
  const nodeId = input.nodeId.trim();
  if (!tenantId || !nodeId) throw new Error("tenantId and nodeId are required");
  if (!input.rawToken.startsWith("vons_")) throw new Error("rawToken must be a vons_* token");

  const accountKey = syncAccountKey(tenantId, nodeId);
  rememberCredentialKey(accountKey);
  let storage: LocalSecretStorage = "file_fallback";
  const keychainAttempted = canUseKeychain();
  if (keychainWrite(SYNC_SERVICE, accountKey, input.rawToken)) {
    storage = "keychain";
    try { fs.unlinkSync(legacySyncTokenPath()); } catch { /* no legacy token */ }
  } else {
    atomicWrite0600(legacySyncTokenPath(), `${input.rawToken}\n`);
  }

  const meta: LocalSyncCredentialMetadata = {
    tenant_id: tenantId,
    node_id: nodeId,
    account_id: input.accountId ?? null,
    hosted_base_url: input.hostedBaseUrl ?? null,
    storage,
    keychain_attempted: keychainAttempted,
    issued_at: input.issuedAt ?? new Date().toISOString(),
    token_prefix: input.rawToken.slice(0, 12),
  };
  if (input.accountEmail?.trim()) writeLocalSecret(syncAccountEmailRef(accountKey), input.accountEmail.trim());
  else clearLocalSecret(syncAccountEmailRef(accountKey));
  writeMetadata(meta);
  return metadataToStatus(meta, true);
}

function metadataToStatus(meta: LocalSyncCredentialMetadata, tokenPresent: boolean): LocalSyncCredentialStatus {
  const accountKey = syncAccountKey(meta.tenant_id, meta.node_id);
  return {
    tenant_id: meta.tenant_id,
    node_id: meta.node_id,
    token_present: tokenPresent,
    account_id: meta.account_id,
    account_email: readLocalSecret(syncAccountEmailRef(accountKey)),
    hosted_base_url: meta.hosted_base_url,
    storage: meta.storage,
    keychain_attempted: Boolean(meta.keychain_attempted),
    issued_at: meta.issued_at,
    token_prefix: tokenPresent ? meta.token_prefix : null,
  };
}

export function readLocalSyncCredential(): LocalSyncCredentialStatus | null {
  const meta = readMetadata();
  if (!meta) {
    const legacy = readLegacySyncToken();
    return legacy
      ? {
          tenant_id: "",
          node_id: "",
          token_present: true,
          account_id: null,
          account_email: null,
          hosted_base_url: null,
          storage: "file_fallback",
          keychain_attempted: false,
          issued_at: null,
          token_prefix: legacy.slice(0, 12),
        }
      : null;
  }
  return metadataToStatus(meta, readRawLocalSyncToken() !== null);
}

function readLegacySyncToken(): string | null {
  const target = legacySyncTokenPath();
  try {
    assertSecureSecretFile(target);
    const token = fs.readFileSync(target, "utf8").trim();
    return token.startsWith("vons_") ? token : null;
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
    return null;
  }
}

export function readRawLocalSyncToken(): string | null {
  const meta = readMetadata();
  if (!meta) return readLegacySyncToken();
  const accountKey = syncAccountKey(meta.tenant_id, meta.node_id);
  if (meta.storage === "keychain") {
    const keychain = keychainRead(SYNC_SERVICE, accountKey);
    if (keychain?.startsWith("vons_")) return keychain;
    return null;
  }
  return readLegacySyncToken();
}

export function clearLocalSyncCredential(expectedTenantId?: string): boolean {
  const meta = readMetadata();
  if (!meta) {
    try {
      fs.unlinkSync(legacySyncTokenPath());
      return true;
    } catch {
      return false;
    }
  }
  if (expectedTenantId && meta.tenant_id !== expectedTenantId) return false;
  const accountKey = syncAccountKey(meta.tenant_id, meta.node_id);
  keychainDelete(SYNC_SERVICE, accountKey);
  clearLocalSecret(syncAccountEmailRef(accountKey));
  forgetCredentialKey(accountKey);
  try { fs.unlinkSync(metadataPath()); } catch { /* already gone */ }
  try { fs.unlinkSync(legacySyncTokenPath()); } catch { /* already gone */ }
  return true;
}

export function clearAllLocalSyncCredentials(): number {
  const meta = readMetadata();
  const keys = readCredentialKeyIndex();
  let cleared = 0;
  if (meta) {
    const accountKey = syncAccountKey(meta.tenant_id, meta.node_id);
    if (!keys.includes(accountKey)) keys.push(accountKey);
  }
  for (const accountKey of keys) {
    keychainDelete(SYNC_SERVICE, accountKey);
    clearLocalSecret(syncAccountEmailRef(accountKey));
    cleared += 1;
  }
  try { fs.unlinkSync(metadataPath()); } catch { /* already gone */ }
  try { fs.unlinkSync(legacySyncTokenPath()); } catch { /* already gone */ }
  try { fs.unlinkSync(credentialKeysPath()); } catch { /* already gone */ }
  return cleared;
}
