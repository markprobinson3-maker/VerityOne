import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./runtime-profile";
import { hashSecret } from "./hosted-connect";
import {
  clearLocalSecret,
  readLocalSecret,
  writeLocalSecret,
  type LocalSecretStorage,
} from "./local-credential-store";

const CONNECT_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export type LocalConnectStatus =
  | "waiting"
  | "callback_received"
  | "redeeming"
  | "connected"
  | "expired"
  | "error";

export interface CreateLocalConnectAttemptInput {
  tenantId: string;
  nodeId: string;
  nodePublicKeyHash: string;
  localOrigin: string;
  redirectUri: string;
  hostedBaseUrl: string;
}

export interface LocalConnectAttempt {
  attempt_id: string;
  tenant_id: string;
  node_id: string;
  node_public_key_hash: string;
  local_origin: string;
  redirect_uri: string;
  hosted_base_url: string;
  state_hash: string;
  state_secret_ref: string;
  nonce_hash: string;
  nonce_secret_ref: string;
  pkce_verifier_secret_ref: string;
  secret_storage: LocalSecretStorage;
  pkce_challenge: string;
  created_at: string;
  expires_at: string;
  status: LocalConnectStatus;
  last_error_code: string | null;
  callback_code_hash?: string | null;
  callback_grant_id?: string | null;
}

export interface LocalConnectAttemptWithSecrets extends LocalConnectAttempt {
  state: string;
  nonce: string;
  pkce_verifier: string;
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

export function localConnectAttemptPath(): string {
  return path.join(configDir(), "connect-attempt.json");
}

function randomSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function writeAttempt(attempt: LocalConnectAttempt): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = localConnectAttemptPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

export function clearLocalConnectAttempt(): void {
  const attempt = readLocalConnectAttempt();
  if (attempt) {
    clearLocalSecret(attempt.state_secret_ref);
    clearLocalSecret(attempt.nonce_secret_ref);
    clearLocalSecret(attempt.pkce_verifier_secret_ref);
  }
  try {
    fs.unlinkSync(localConnectAttemptPath());
  } catch {
    // already gone
  }
}

export function readLocalConnectAttempt(): LocalConnectAttempt | null {
  try {
    const attempt = JSON.parse(fs.readFileSync(localConnectAttemptPath(), "utf8")) as LocalConnectAttempt;
    if (new Date(attempt.expires_at).getTime() <= Date.now() && attempt.status !== "connected") {
      return { ...attempt, status: "expired" };
    }
    return attempt;
  } catch {
    return null;
  }
}

export function readLocalConnectAttemptWithSecrets(): LocalConnectAttemptWithSecrets | null {
  const attempt = readLocalConnectAttempt();
  if (!attempt || attempt.status === "expired") return null;
  const state = readLocalSecret(attempt.state_secret_ref, attempt.secret_storage);
  const nonce = readLocalSecret(attempt.nonce_secret_ref, attempt.secret_storage);
  const verifier = readLocalSecret(attempt.pkce_verifier_secret_ref, attempt.secret_storage);
  if (!state || !nonce || !verifier) return null;
  return { ...attempt, state, nonce, pkce_verifier: verifier };
}

export function createLocalConnectAttempt(input: CreateLocalConnectAttemptInput): LocalConnectAttemptWithSecrets {
  clearLocalConnectAttempt();
  const attemptId = crypto.randomUUID();
  const state = randomSecret("vols");
  const nonce = randomSecret("voln");
  const verifier = randomSecret("volv");
  const stateRef = `connect:${attemptId}:state`;
  const nonceRef = `connect:${attemptId}:nonce`;
  const verifierRef = `connect:${attemptId}:pkce_verifier`;
  const stateStored = writeLocalSecret(stateRef, state);
  const nonceStored = writeLocalSecret(nonceRef, nonce);
  const verifierStored = writeLocalSecret(verifierRef, verifier);
  const createdAt = new Date();
  const attempt: LocalConnectAttempt = {
    attempt_id: attemptId,
    tenant_id: input.tenantId,
    node_id: input.nodeId,
    node_public_key_hash: input.nodePublicKeyHash,
    local_origin: input.localOrigin,
    redirect_uri: input.redirectUri,
    hosted_base_url: input.hostedBaseUrl,
    state_hash: hashSecret(state),
    state_secret_ref: stateStored.secret_ref,
    nonce_hash: hashSecret(nonce),
    nonce_secret_ref: nonceStored.secret_ref,
    pkce_verifier_secret_ref: verifierStored.secret_ref,
    secret_storage: stateStored.storage === "keychain" && nonceStored.storage === "keychain" && verifierStored.storage === "keychain"
      ? "keychain"
      : "file_fallback",
    pkce_challenge: pkceChallenge(verifier),
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + CONNECT_ATTEMPT_TTL_MS).toISOString(),
    status: "waiting",
    last_error_code: null,
  };
  writeAttempt(attempt);
  return { ...attempt, state, nonce, pkce_verifier: verifier };
}

export function validateLocalConnectState(attempt: LocalConnectAttempt, state: string): boolean {
  if (!state) return false;
  const receivedHash = hashSecret(state);
  if (attempt.state_hash.length !== receivedHash.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(attempt.state_hash, "hex"),
    Buffer.from(receivedHash, "hex"),
  );
}

export function updateLocalConnectAttempt(patch: Partial<LocalConnectAttempt>): LocalConnectAttempt | null {
  const current = readLocalConnectAttempt();
  if (!current) return null;
  const next = { ...current, ...patch };
  writeAttempt(next);
  return next;
}
