import crypto from "node:crypto";
import path from "node:path";
import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export const VAULT_DRIVE_FILE_STATUSES = [
  "pending",
  "uploaded",
  "failed",
  "deleted_local",
  "deleted_drive",
  "obsolete",
] as const;

export const VAULT_DRIVE_FILE_KINDS = [
  "vault_dossier",
  "raw_capture_file",
  // Reserved for a future vault-index metadata rung. R8's worker does not
  // produce this kind.
  "other_vault_file",
] as const;

export type VaultDriveFileStatus = typeof VAULT_DRIVE_FILE_STATUSES[number];
export type VaultDriveFileKind = typeof VAULT_DRIVE_FILE_KINDS[number];
export type VaultDriveFileOp = "upsert" | "trash" | "move";

export interface VaultDriveFilePayload {
  relative_path: string;
  drive_file_id: string;
  drive_web_url: string;
  file_kind: VaultDriveFileKind;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  status: VaultDriveFileStatus;
  project_addr?: string | null;
  local_modified_at?: string | null;
  drive_modified_at?: string | null;
  old_relative_path?: string | null;
  new_relative_path?: string | null;
}

const FORBIDDEN_VAULT_DRIVE_FIELDS = [
  "body",
  "content",
  "markdown",
  "text",
  "bytes",
  "base64",
  "blob",
  "local_path",
  "absolute_path",
  "file_path",
  "refresh_token",
  "access_token",
  "id_token",
  "token",
  "code",
  "state",
  "nonce",
  "verifier",
] as const;

export function vaultDriveFileItemKey(relativePath: string): string {
  const normalized = normalizeVaultRelativePath(relativePath);
  return `vault_drive_file:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

export function normalizeVaultRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("relative_path must be a string");
  const raw = value.trim();
  if (!raw || raw.length > 1024) throw new Error("relative_path must be 1-1024 chars");
  if (raw.includes("\0")) throw new Error("relative_path must not contain NUL bytes");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) {
    throw new Error("relative_path must be vault-relative");
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("relative_path must not traverse outside the vault");
  }
  if (normalized.startsWith("/")) throw new Error("relative_path must be vault-relative");
  return normalized;
}

function assertString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${name} is invalid`);
  return trimmed;
}

function assertIsoDateOrNull(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be an ISO timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

function optionalProjectAddr(item: any): string | null {
  const raw = typeof item?.project_addr === "string"
    ? item.project_addr
    : typeof item?.plaintext_metadata?.project_addr === "string"
      ? item.plaintext_metadata.project_addr
      : null;
  const addr = raw?.trim() || null;
  if (addr === null) return null;
  if (!/^PJ\.[0-9]+(?:\.[0-9]+)*$/.test(addr)) throw new Error("project_addr must be a PJ address string");
  return addr;
}

export function validateVaultDriveFilePayload(item: any): VaultDriveFilePayload {
  for (const field of FORBIDDEN_VAULT_DRIVE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item ?? {}, field)) {
      throw new Error(`vault_drive_file must not include ${field}`);
    }
  }
  const relative_path = normalizeVaultRelativePath(item?.relative_path ?? item?.path);
  const drive_file_id = assertString(item?.drive_file_id, "drive_file_id", 512);
  const drive_web_url = assertString(item?.drive_web_url, "drive_web_url", 2048);
  if (!/^https:\/\/(?:drive|docs)\.google\.com\//.test(drive_web_url)) {
    throw new Error("drive_web_url must be a Google Drive or Docs URL");
  }
  const file_kind = assertString(item?.file_kind, "file_kind", 64) as VaultDriveFileKind;
  if (!(VAULT_DRIVE_FILE_KINDS as readonly string[]).includes(file_kind)) {
    throw new Error("file_kind is invalid");
  }
  const mime_type = assertString(item?.mime_type, "mime_type", 200);
  if (!mime_type.includes("/")) throw new Error("mime_type is invalid");
  const sha256 = assertString(item?.sha256, "sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 lowercase hex chars");
  const size_bytes = Number(item?.size_bytes);
  if (!Number.isInteger(size_bytes) || size_bytes < 0 || size_bytes > 10 * 1024 * 1024 * 1024) {
    throw new Error("size_bytes is invalid");
  }
  const status = assertString(item?.status ?? "uploaded", "status", 32) as VaultDriveFileStatus;
  if (!(VAULT_DRIVE_FILE_STATUSES as readonly string[]).includes(status)) {
    throw new Error("status is invalid");
  }
  const payload: VaultDriveFilePayload = {
    relative_path,
    drive_file_id,
    drive_web_url,
    file_kind,
    mime_type,
    sha256,
    size_bytes,
    status,
    project_addr: optionalProjectAddr(item),
    local_modified_at: assertIsoDateOrNull(item?.local_modified_at, "local_modified_at"),
    drive_modified_at: assertIsoDateOrNull(item?.drive_modified_at, "drive_modified_at"),
  };
  if (item?.old_relative_path != null) payload.old_relative_path = normalizeVaultRelativePath(item.old_relative_path);
  if (item?.new_relative_path != null) payload.new_relative_path = normalizeVaultRelativePath(item.new_relative_path);
  return payload;
}

export function validateVaultDriveFileMovePayload(item: any): VaultDriveFilePayload {
  const payload = validateVaultDriveFilePayload(item);
  if (!payload.old_relative_path || !payload.new_relative_path) {
    throw new Error("move requires old_relative_path and new_relative_path");
  }
  return payload;
}

export async function applyHostedVaultDriveFile(
  tx: SqlTag,
  input: {
    tenantId: string;
    nodeId: string;
    op: VaultDriveFileOp;
    item: any;
  },
): Promise<void> {
  const payload = input.op === "move"
    ? validateVaultDriveFileMovePayload(input.item)
    : validateVaultDriveFilePayload(input.item);
  if (input.op === "move") {
    const oldPath = payload.old_relative_path!;
    const newPath = payload.new_relative_path!;
    const deletedOldPath = await tx`
      DELETE FROM hosted_drive_files
      WHERE tenant_id = ${input.tenantId}
        AND relative_path = ${oldPath}
        AND COALESCE(${payload.drive_modified_at || null}::timestamptz, ${payload.local_modified_at || null}::timestamptz, '-infinity'::timestamptz)
          >= COALESCE(drive_modified_at, local_modified_at, updated_at)
      RETURNING 1
    `;
    if (deletedOldPath.length === 0) {
      const [stillExists] = await tx`
        SELECT 1
        FROM hosted_drive_files
        WHERE tenant_id = ${input.tenantId}
          AND relative_path = ${oldPath}
        LIMIT 1
      `;
      if (stillExists) return;
    }
    await upsertHostedVaultDriveFile(tx, input.tenantId, input.nodeId, {
      ...payload,
      relative_path: newPath,
      status: "uploaded",
    });
    return;
  }
  if (input.op === "trash") {
    const trashStatus = payload.status === "deleted_drive" ? "deleted_drive" : "deleted_local";
    await upsertHostedVaultDriveFile(tx, input.tenantId, input.nodeId, {
      ...payload,
      status: trashStatus,
    });
    return;
  }
  await upsertHostedVaultDriveFile(tx, input.tenantId, input.nodeId, payload);
}

async function upsertHostedVaultDriveFile(
  tx: SqlTag,
  tenantId: string,
  nodeId: string,
  payload: VaultDriveFilePayload,
): Promise<void> {
  const [existingSameFile] = await tx`
    SELECT relative_path, drive_modified_at, updated_at
    FROM hosted_drive_files
    WHERE tenant_id = ${tenantId}
      AND drive_file_id = ${payload.drive_file_id}
      AND relative_path <> ${payload.relative_path}
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (existingSameFile) {
    const existingMs = Date.parse(String(existingSameFile.drive_modified_at || existingSameFile.updated_at || ""));
    const incomingMs = Date.parse(String(payload.drive_modified_at || payload.local_modified_at || ""));
    if (Number.isFinite(existingMs) && Number.isFinite(incomingMs) && existingMs > incomingMs) {
      return;
    }
    await tx`
      DELETE FROM hosted_drive_files
      WHERE tenant_id = ${tenantId}
        AND drive_file_id = ${payload.drive_file_id}
        AND relative_path <> ${payload.relative_path}
    `;
  }
  await tx`
    INSERT INTO hosted_drive_files (
      tenant_id, relative_path, drive_file_id, drive_web_url, project_addr, file_kind,
      mime_type, sha256, size_bytes, status, local_modified_at,
      drive_modified_at, sync_source_node_id
    )
    VALUES (
      ${tenantId}, ${payload.relative_path}, ${payload.drive_file_id},
      ${payload.drive_web_url}, ${payload.project_addr || null}, ${payload.file_kind}, ${payload.mime_type},
      ${payload.sha256}, ${payload.size_bytes}, ${payload.status},
      ${payload.local_modified_at || null}, ${payload.drive_modified_at || null},
      ${nodeId}
    )
    ON CONFLICT (tenant_id, relative_path)
    DO UPDATE SET
      drive_file_id = EXCLUDED.drive_file_id,
      drive_web_url = EXCLUDED.drive_web_url,
      project_addr = EXCLUDED.project_addr,
      file_kind = EXCLUDED.file_kind,
      mime_type = EXCLUDED.mime_type,
      sha256 = EXCLUDED.sha256,
      size_bytes = EXCLUDED.size_bytes,
      status = EXCLUDED.status,
      local_modified_at = EXCLUDED.local_modified_at,
      drive_modified_at = EXCLUDED.drive_modified_at,
      sync_source_node_id = EXCLUDED.sync_source_node_id,
      synced_at = now(),
      updated_at = now()
    WHERE
      COALESCE(EXCLUDED.drive_modified_at, EXCLUDED.local_modified_at, '-infinity'::timestamptz)
        >= COALESCE(hosted_drive_files.drive_modified_at, hosted_drive_files.local_modified_at, hosted_drive_files.updated_at)
  `;
}

export async function isDriveMirrorPrimary(
  sql: SqlTag,
  input: { tenantId: string; nodeId: string },
): Promise<boolean> {
  const [row] = await sql`
    SELECT 1
    FROM hosted_nodes
    WHERE tenant_id = ${input.tenantId}
      AND node_id = ${input.nodeId}
      AND status = 'active'
      AND drive_mirror_primary_at IS NOT NULL
    LIMIT 1
  `;
  return Boolean(row);
}
