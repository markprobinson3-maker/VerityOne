import fs from "node:fs";
import path from "node:path";

import { resolveConfigPath } from "./runtime-profile";
import { type LocalSyncCredentialStatus, writeLocalSyncCredential } from "./local-credential-store";

export interface LocalSyncTokenMetadata {
  tenantId: string;
  nodeId: string;
  accountId?: string | null;
  accountEmail?: string | null;
  hostedBaseUrl?: string | null;
}

export function resolveLocalSyncTokenPath(): string {
  return path.join(path.dirname(resolveConfigPath()), "sync-token");
}

export interface LocalSyncTokenWriteResult {
  path: string;
  status: LocalSyncCredentialStatus | null;
}

export function writeLocalSyncTokenWithStatus(rawToken: string, metadata?: LocalSyncTokenMetadata): LocalSyncTokenWriteResult {
  if (!metadata?.tenantId || !metadata?.nodeId) {
    throw new Error("writeLocalSyncToken requires tenantId and nodeId metadata; legacy plaintext token writes are explicit-only");
  }

  const status = writeLocalSyncCredential({
    tenantId: metadata.tenantId,
    nodeId: metadata.nodeId,
    rawToken,
    accountId: metadata.accountId ?? null,
    accountEmail: metadata.accountEmail ?? null,
    hostedBaseUrl: metadata.hostedBaseUrl ?? null,
  });
  return { path: resolveLocalSyncTokenPath(), status };
}

export function writeLegacySyncTokenInsecure(rawToken: string): string {
  const target = resolveLocalSyncTokenPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${rawToken}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return target;
}

export function writeLocalSyncToken(rawToken: string, metadata?: LocalSyncTokenMetadata): string {
  return writeLocalSyncTokenWithStatus(rawToken, metadata).path;
}
