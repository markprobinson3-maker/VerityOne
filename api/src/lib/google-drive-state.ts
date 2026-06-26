import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./runtime-profile";
import { clearLocalSecret, readLocalSecret, writeLocalSecret, type LocalSecretStorage } from "./local-credential-store";

export type DriveMirrorStatus =
  | "not_configured"
  | "consent_pending"
  | "idle"
  | "running"
  | "skipped"
  | "error"
  | "mirror_primary_on_other_node";

export interface LocalDriveConnectAttempt {
  grant_id: string;
  tenant_id: string;
  node_id: string;
  nonce: string;
  hosted_base_url: string;
  public_key: string;
  private_key_ref: string;
  private_key_storage: LocalSecretStorage;
  started_at: string;
  expires_at: string;
}

export interface LocalDriveMirrorState {
  tenant_id: string | null;
  node_id: string | null;
  status: DriveMirrorStatus;
  drive_root_folder_id: string | null;
  tenant_folder_id: string | null;
  folder_cache: Record<string, string>;
  files: Record<string, {
    sha256: string | null;
    size_bytes: number;
    drive_file_id: string | null;
    drive_web_url: string | null;
    file_kind: "vault_dossier" | "raw_capture_file" | "other_vault_file";
    status: "upload_pending" | "uploaded" | "deleted_local" | "deleted_drive" | "failed";
    uploaded_at?: string | null;
    journaled_at?: string | null;
    last_error_code?: string | null;
    // PR-V2 two-way sync: Drive headRevisionId at the last successful sync (push
    // or pull). The pull leg compares the live Drive rev against this to detect
    // remote changes; the push leg records the rev it produced so a just-pushed
    // file isn't mistaken for a remote change and re-pulled.
    drive_revision_id?: string | null;
    pulled_at?: string | null;
  }>;
  token_secret_ref: string | null;
  token_secret_storage: LocalSecretStorage | null;
  last_error_code: string | null;
  last_tick_at: string | null;
  updated_at: string;
  // PR-V2: the file kinds whose sync was active as of the last completed tick.
  // Used to detect a category being re-enabled, so the first reconcile after the
  // transition re-syncs (resurrect / re-push) instead of trashing files that were
  // deleted locally while the category was off. Undefined = never recorded.
  active_categories?: string[];
}

export function getDriveMirrorStats(state: Pick<LocalDriveMirrorState, "files">): {
  file_count: number;
  uploaded_count: number;
  failed_count: number;
  pending_count: number;
  deleted_local_count: number;
  deleted_drive_count: number;
  total_size_bytes: number;
} {
  const rawFiles = state?.files && typeof state.files === "object" && !Array.isArray(state.files)
    ? Object.values(state.files)
    : [];
  const countStatus = (status: string) => rawFiles.filter((file) => file?.status === status).length;
  const driveBackedFiles = rawFiles.filter((file) => file?.status === "uploaded" && !!file.drive_file_id);
  return {
    file_count: rawFiles.length,
    uploaded_count: countStatus("uploaded"),
    failed_count: countStatus("failed"),
    pending_count: countStatus("upload_pending"),
    deleted_local_count: countStatus("deleted_local"),
    deleted_drive_count: countStatus("deleted_drive"),
    total_size_bytes: driveBackedFiles.reduce((sum, file) => sum + (typeof file?.size_bytes === "number" ? file.size_bytes : 0), 0),
  };
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

export function driveAttemptPath(): string {
  return path.join(configDir(), "drive-connect-attempt.json");
}

export function driveStatePath(): string {
  return path.join(configDir(), "drive-mirror-state.json");
}

function atomicWrite0600(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

export function readLocalDriveConnectAttempt(): LocalDriveConnectAttempt | null {
  try {
    const raw = JSON.parse(fs.readFileSync(driveAttemptPath(), "utf8"));
    if (!raw?.grant_id || !raw?.tenant_id || !raw?.node_id || !raw?.private_key_ref) return null;
    return raw as LocalDriveConnectAttempt;
  } catch {
    return null;
  }
}

export function writeLocalDriveConnectAttempt(input: Omit<LocalDriveConnectAttempt, "private_key_storage"> & { private_key: string }): LocalDriveConnectAttempt {
  const secret = writeLocalSecret(input.private_key_ref, input.private_key);
  const attempt: LocalDriveConnectAttempt = {
    grant_id: input.grant_id,
    tenant_id: input.tenant_id,
    node_id: input.node_id,
    nonce: input.nonce,
    hosted_base_url: input.hosted_base_url,
    public_key: input.public_key,
    private_key_ref: input.private_key_ref,
    private_key_storage: secret.storage,
    started_at: input.started_at,
    expires_at: input.expires_at,
  };
  atomicWrite0600(driveAttemptPath(), JSON.stringify(attempt, null, 2));
  return attempt;
}

export function readLocalDrivePrivateKey(attempt: LocalDriveConnectAttempt): string | null {
  return readLocalSecret(attempt.private_key_ref, attempt.private_key_storage);
}

export function clearLocalDriveConnectAttempt(): void {
  const attempt = readLocalDriveConnectAttempt();
  if (attempt) clearLocalSecret(attempt.private_key_ref);
  try { fs.unlinkSync(driveAttemptPath()); } catch { /* already gone */ }
}

export function readLocalDriveMirrorState(): LocalDriveMirrorState {
  try {
    const raw = JSON.parse(fs.readFileSync(driveStatePath(), "utf8"));
    return {
      tenant_id: typeof raw.tenant_id === "string" ? raw.tenant_id : null,
      node_id: typeof raw.node_id === "string" ? raw.node_id : null,
      status: typeof raw.status === "string" ? raw.status : "not_configured",
      drive_root_folder_id: typeof raw.drive_root_folder_id === "string" ? raw.drive_root_folder_id : null,
      tenant_folder_id: typeof raw.tenant_folder_id === "string" ? raw.tenant_folder_id : null,
      folder_cache: raw.folder_cache && typeof raw.folder_cache === "object" && !Array.isArray(raw.folder_cache) ? raw.folder_cache : {},
      files: raw.files && typeof raw.files === "object" && !Array.isArray(raw.files) ? raw.files : {},
      token_secret_ref: typeof raw.token_secret_ref === "string" ? raw.token_secret_ref : null,
      token_secret_storage: raw.token_secret_storage === "keychain" || raw.token_secret_storage === "file_fallback" ? raw.token_secret_storage : null,
      last_error_code: typeof raw.last_error_code === "string" ? raw.last_error_code : null,
      last_tick_at: typeof raw.last_tick_at === "string" ? raw.last_tick_at : null,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      active_categories: Array.isArray(raw.active_categories) ? raw.active_categories.filter((c: unknown) => typeof c === "string") : undefined,
    };
  } catch {
    return {
      tenant_id: null,
      node_id: null,
      status: "not_configured",
      drive_root_folder_id: null,
      tenant_folder_id: null,
      folder_cache: {},
      files: {},
      token_secret_ref: null,
      token_secret_storage: null,
      last_error_code: null,
      last_tick_at: null,
      updated_at: new Date().toISOString(),
    };
  }
}

export function writeLocalDriveMirrorState(patch: Partial<LocalDriveMirrorState>): LocalDriveMirrorState {
  const next: LocalDriveMirrorState = {
    ...readLocalDriveMirrorState(),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  atomicWrite0600(driveStatePath(), JSON.stringify(next, null, 2));
  return next;
}

export function writeLocalDriveToken(input: {
  tenantId: string;
  nodeId: string;
  tokenJson: string;
  /** A mid-tick token REFRESH (onTokens) persists the rotated token WITHOUT
   *  resetting the live status to "idle" or clearing last_error — only the
   *  initial / reauth write resets those. */
  preserveStatus?: boolean;
}): LocalDriveMirrorState {
  const ref = `drive:${input.tenantId}:${input.nodeId}`;
  const secret = writeLocalSecret(ref, input.tokenJson);
  const patch: Partial<LocalDriveMirrorState> = {
    tenant_id: input.tenantId,
    node_id: input.nodeId,
    token_secret_ref: ref,
    token_secret_storage: secret.storage,
  };
  if (!input.preserveStatus) {
    patch.status = "idle";
    patch.last_error_code = null;
  }
  return writeLocalDriveMirrorState(patch);
}

export function readLocalDriveTokenJson(state = readLocalDriveMirrorState()): string | null {
  if (!state.token_secret_ref || !state.token_secret_storage) return null;
  return readLocalSecret(state.token_secret_ref, state.token_secret_storage);
}

export function clearLocalDriveMirrorState(): void {
  const state = readLocalDriveMirrorState();
  if (state.token_secret_ref) clearLocalSecret(state.token_secret_ref);
  try { fs.unlinkSync(driveStatePath()); } catch { /* already gone */ }
  clearLocalDriveConnectAttempt();
}
