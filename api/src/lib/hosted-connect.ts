// Open-core stub. The VO+ implementation ships separately.
import crypto from "node:crypto";

/**
 * Compute a hex SHA-256 fingerprint of an arbitrary string.
 *
 * This is a pure, non-secret hashing helper used by the open-core node to
 * derive stable lookup keys (e.g. one-time code hashes). It carries no
 * keying material and is safe to reproduce in the public tree.
 */
export function hashSecret(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Compute a hex SHA-256 fingerprint of a node public key (PEM).
 *
 * Pure, non-secret: the input is a public key and the output is a public
 * fingerprint. No private keying material is involved.
 */
export function publicKeyHash(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem).digest("hex");
}
