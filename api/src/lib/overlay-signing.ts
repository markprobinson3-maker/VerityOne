/**
 * Overlay signing — Ed25519 keypair for signing public overlay feed items.
 *
 * The signing key is stable across process restarts, stored at:
 *   ~/.vo/overlay-sign.key  (private, mode 0600)
 *   ~/.vo/overlay-sign.pub  (public, mode 0644)
 *
 * The public key is the overlay verification key delivered to federation
 * nodes at registration and refresh time. Nodes use it to verify overlay
 * signatures before local import.
 *
 * Reuses the same Ed25519 / PEM pattern as node-keypair.ts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfigPath } from "./runtime-profile";

interface OverlaySigningKeypair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyPem: string;
}

let _cached: OverlaySigningKeypair | null = null;

function keyDir(): string {
  return path.dirname(resolveConfigPath());
}

function privateKeyPath(): string {
  return path.join(keyDir(), "overlay-sign.key");
}

function publicKeyPath(): string {
  return path.join(keyDir(), "overlay-sign.pub");
}

/**
 * Load or generate the overlay signing keypair. Idempotent.
 */
export function ensureOverlaySigningKeypair(): OverlaySigningKeypair {
  if (_cached) return _cached;

  const privPath = privateKeyPath();
  const pubPath = publicKeyPath();

  // Try to load existing keypair
  try {
    const privPem = fs.readFileSync(privPath, "utf-8");
    const pubPem = fs.readFileSync(pubPath, "utf-8");
    const privateKey = crypto.createPrivateKey(privPem);
    const publicKey = crypto.createPublicKey(pubPem);
    _cached = { privateKey, publicKey, publicKeyPem: pubPem };
    return _cached;
  } catch {
    // Generate new keypair
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  const dir = keyDir();
  fs.mkdirSync(dir, { recursive: true });

  const privTmp = `${privPath}.tmp-${process.pid}`;
  fs.writeFileSync(privTmp, privPem, { mode: 0o600 });
  fs.renameSync(privTmp, privPath);

  const pubTmp = `${pubPath}.tmp-${process.pid}`;
  fs.writeFileSync(pubTmp, pubPem, { mode: 0o644 });
  fs.renameSync(pubTmp, pubPath);

  _cached = { privateKey, publicKey, publicKeyPem: pubPem };
  return _cached;
}

/**
 * Load the overlay verification (public) key PEM without generating.
 * Returns null if not present.
 */
export function loadOverlayVerifyKeyPem(): string | null {
  try {
    return fs.readFileSync(publicKeyPath(), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Sign an overlay item payload. Returns base64url signature.
 * The payload is canonicalized (keys sorted) before signing.
 */
export function signOverlayItem(payload: Record<string, unknown>): string {
  const kp = ensureOverlaySigningKeypair();
  // Canonical JSON: keys sorted alphabetically
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const sig = crypto.sign(null, Buffer.from(canonical, "utf-8"), kp.privateKey);
  return sig.toString("base64url");
}

/**
 * Verify an overlay item signature. Returns true if valid.
 */
export function verifyOverlaySignature(
  payload: Record<string, unknown>,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const publicKey = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(canonical, "utf-8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
