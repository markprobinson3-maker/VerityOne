/**
 * Ed25519 node keypair management for VO+ proof-of-control.
 *
 * The private key stays local at `~/.vo/node.key`. The public key
 * is registered with both the local federation and (later) the hosted
 * service so the hosted side can verify signed link challenges without
 * needing a callback to the local machine.
 *
 * Uses Node.js/Bun crypto.sign / crypto.verify with Ed25519.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./runtime-profile";

const KEY_FILENAME = "node.key";
const PUBKEY_FILENAME = "node.pub";

function keyDir(): string {
  return path.dirname(resolveConfigPath());
}

function privateKeyPath(): string {
  return path.join(keyDir(), KEY_FILENAME);
}

function publicKeyPath(): string {
  return path.join(keyDir(), PUBKEY_FILENAME);
}

export interface NodeKeypair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyPem: string;
}

export interface LocalNodeIdentity {
  nodeId: string;
  publicKeyPem: string;
}

/**
 * Load or generate the Ed25519 node keypair.
 * Idempotent: if keys exist on disk, they are reused.
 * If only one key file exists, both are regenerated (corrupt state).
 */
export function ensureNodeKeypair(): NodeKeypair {
  const privPath = privateKeyPath();
  const pubPath = publicKeyPath();

  // Try to load existing keypair
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    try {
      const privPem = fs.readFileSync(privPath, "utf-8");
      const pubPem = fs.readFileSync(pubPath, "utf-8");
      const privateKey = crypto.createPrivateKey(privPem);
      const publicKey = crypto.createPublicKey(pubPem);
      return { privateKey, publicKey, publicKeyPem: pubPem };
    } catch {
      // Corrupt key files — regenerate below
    }
  }

  // Generate new Ed25519 keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  // Write with restrictive permissions
  fs.mkdirSync(keyDir(), { recursive: true });
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });

  return { privateKey, publicKey, publicKeyPem: pubPem };
}

/**
 * Load the public key PEM from disk (for registration).
 * Returns null if no key exists yet.
 */
export function loadPublicKeyPem(): string | null {
  const pubPath = publicKeyPath();
  if (!fs.existsSync(pubPath)) return null;
  try {
    return fs.readFileSync(pubPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Derive the stable node_id used by hosted link/sync flows from a
 * public key PEM.
 */
export function deriveNodeIdFromPublicKeyPem(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

/**
 * Load the local public key and its derived node_id without creating a
 * new keypair if none exists yet.
 */
export function loadLocalNodeIdentity(): LocalNodeIdentity | null {
  const publicKeyPem = loadPublicKeyPem();
  if (!publicKeyPem) return null;
  return {
    nodeId: deriveNodeIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
  };
}

/**
 * Sign a link challenge payload with the local node's private key.
 */
export function signLinkChallenge(payload: {
  tenant_id: string;
  node_id: string;
  exp: number;
}): string {
  const keypair = ensureNodeKeypair();
  const data = JSON.stringify({ ...payload, kind: "link" });
  const signature = crypto.sign(null, Buffer.from(data), keypair.privateKey);
  // Return as base64url: payload.signature
  const payloadB64 = Buffer.from(data).toString("base64url");
  const sigB64 = signature.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed link challenge against a known public key PEM.
 * Returns the decoded payload if valid, throws on failure.
 */
export function verifyLinkChallenge(
  signedChallenge: string,
  publicKeyPem: string,
): { tenant_id: string; node_id: string; exp: number; kind?: "link" } {
  const parts = signedChallenge.split(".");
  if (parts.length !== 2) throw new Error("Invalid challenge format");

  const [payloadB64, sigB64] = parts;
  const data = Buffer.from(payloadB64, "base64url");
  const signature = Buffer.from(sigB64, "base64url");
  const publicKey = crypto.createPublicKey(publicKeyPem);

  const valid = crypto.verify(null, data, publicKey, signature);
  if (!valid) throw new Error("Invalid challenge signature");

  const payload = JSON.parse(data.toString("utf-8"));
  if (payload.kind !== undefined && payload.kind !== "link") {
    throw new Error("Link challenge payload has invalid kind");
  }
  if (!payload.tenant_id || !payload.node_id || !payload.exp) {
    throw new Error("Challenge payload missing required fields");
  }
  if (Date.now() > payload.exp * 1000) {
    throw new Error("Challenge expired");
  }

  return payload;
}

export interface ConnectChallengePayload {
  kind: "hosted_local_connect";
  tenant_id: string;
  node_id: string;
  node_public_key_hash: string;
  grant_id: string;
  nonce: string;
  iat: number;
  exp: number;
}

export function signConnectChallenge(payload: ConnectChallengePayload): string {
  const keypair = ensureNodeKeypair();
  const data = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(data), keypair.privateKey);
  return `${Buffer.from(data).toString("base64url")}.${signature.toString("base64url")}`;
}

/**
 * Verify the hosted-local connect challenge. Unlike the legacy link
 * challenge, the connect challenge must carry an explicit kind so it
 * cannot be replayed into `/account/link` or any other node action.
 */
export function verifyConnectChallenge(
  signedChallenge: string,
  publicKeyPem: string,
): ConnectChallengePayload {
  const parts = signedChallenge.split(".");
  if (parts.length !== 2) throw new Error("Invalid connect challenge format");

  const [payloadB64, sigB64] = parts;
  const data = Buffer.from(payloadB64, "base64url");
  const signature = Buffer.from(sigB64, "base64url");
  const publicKey = crypto.createPublicKey(publicKeyPem);

  const valid = crypto.verify(null, data, publicKey, signature);
  if (!valid) throw new Error("Invalid connect challenge signature");

  const payload = JSON.parse(data.toString("utf-8"));
  if (payload.kind !== "hosted_local_connect") {
    throw new Error("Connect challenge payload missing kind='hosted_local_connect'");
  }
  if (
    !payload.tenant_id ||
    !payload.node_id ||
    !payload.node_public_key_hash ||
    !payload.grant_id ||
    !payload.nonce ||
    !payload.iat ||
    !payload.exp
  ) {
    throw new Error("Connect challenge payload missing required fields");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > payload.exp) {
    throw new Error("Connect challenge expired");
  }
  if (payload.iat > nowSeconds + 300) {
    throw new Error("Connect challenge issued too far in the future");
  }

  return payload as ConnectChallengePayload;
}

/**
 * Rotation-challenge envelope. Same shape as a link
 * challenge but carries `kind: "rotate"` so a stolen link
 * signature cannot be replayed as a rotation and vice
 * versa. Both the new-key possession proof and the old-
 * key authorization proof (when present) sign the same
 * canonical payload including kind + new-public-key
 * fingerprint, binding each signature to this specific
 * rotation.
 */
export interface RotateChallengePayload {
  tenant_id: string;
  node_id: string;
  kind: "rotate";
  new_public_key_fingerprint: string;
  exp: number;
}

/**
 * Sign a rotation challenge payload with the local node's private key.
 * The UI bridge uses this for current-key possession proof; hosted
 * verification uses verifyRotateChallenge below.
 */
export function signRotateChallenge(payload: RotateChallengePayload): string {
  const keypair = ensureNodeKeypair();
  const data = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(data), keypair.privateKey);
  const payloadB64 = Buffer.from(data).toString("base64url");
  const sigB64 = signature.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed rotation challenge against a public key
 * PEM. Returns the decoded payload on success; throws with
 * a specific reason on failure.
 */
export function verifyRotateChallenge(
  signedChallenge: string,
  publicKeyPem: string,
): RotateChallengePayload {
  const parts = signedChallenge.split(".");
  if (parts.length !== 2) throw new Error("Invalid rotate challenge format");

  const [payloadB64, sigB64] = parts;
  const data = Buffer.from(payloadB64, "base64url");
  const signature = Buffer.from(sigB64, "base64url");
  const publicKey = crypto.createPublicKey(publicKeyPem);

  const valid = crypto.verify(null, data, publicKey, signature);
  if (!valid) throw new Error("Invalid rotate challenge signature");

  const payload = JSON.parse(data.toString("utf-8"));
  if (payload.kind !== "rotate") {
    throw new Error("Rotate challenge payload missing kind='rotate'");
  }
  if (
    !payload.tenant_id ||
    !payload.node_id ||
    !payload.new_public_key_fingerprint ||
    !payload.exp
  ) {
    throw new Error("Rotate challenge payload missing required fields");
  }
  if (Date.now() > payload.exp * 1000) {
    throw new Error("Rotate challenge expired");
  }

  return payload as RotateChallengePayload;
}

/**
 * Canonical fingerprint of a public key PEM. Used in the
 * rotate-challenge payload to bind signatures to a
 * specific new-key value without sending the full key
 * twice. SHA-256 over the PEM bytes, hex, first 32 chars.
 */
export function fingerprintPublicKeyPem(publicKeyPem: string): string {
  return crypto
    .createHash("sha256")
    .update(publicKeyPem)
    .digest("hex")
    .slice(0, 32);
}
