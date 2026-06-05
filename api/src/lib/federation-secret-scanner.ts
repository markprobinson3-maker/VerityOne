/**
 * Federation secret / local-path exclusion scanner —
 * VO-HOSTED-MIRROR-HARDENING-PR-1 (rung 4).
 *
 * Scans sync batch items for content that should never
 * reach the hosted mirror: provider API keys, bearer tokens,
 * AWS credentials, Google API keys, Stripe keys, and
 * operator-machine absolute filesystem paths.
 *
 * Applies to schema_version 1 plaintext items, and to
 * schema_version 2 governance / vault_drive_file metadata.
 * schema_version 2 content items are content-opaque (encrypted
 * client-side), so the hosted side cannot see their payload —
 * the client is responsible for its own scanning before encryption.
 * Governance and Drive metadata remain plaintext under schema_version 2
 * and must still be scanned here.
 *
 * Policy: any scan hit rejects the item at ingest (HTTP
 * 400 from /sync/push) with a specific reason string. The
 * sync batch fails atomically; the local client learns
 * from the error and either strips the item or declines to
 * sync it.
 *
 * False-positive posture: tight patterns over broad ones.
 * This scanner only flags patterns that are unambiguously
 * secrets (length + prefix anchors). Generic-looking
 * tokens that could be legitimate content (UUIDs, hex
 * hashes, base64 short strings) are NOT flagged. A miss
 * is a lesser failure than a false-positive rejection of
 * legitimate sync content.
 */

/**
 * Pattern descriptors + the SECRET_PATTERNS / LOCAL_PATH_PATTERNS arrays now
 * live in ./federation-redaction-patterns (dependency-free, public) so the
 * open-core node can redact activity output without importing this VO+ scanner.
 * Imported here for the scan functions below and re-exported so existing
 * importers (hosted-connector-redaction, sync-exporter, the sync route) keep
 * importing them from this module unchanged.
 */
import {
  type SecretPattern,
  SECRET_PATTERNS,
  LOCAL_PATH_PATTERNS,
} from "./federation-redaction-patterns";
export { type SecretPattern, SECRET_PATTERNS, LOCAL_PATH_PATTERNS };

export interface ScanResult {
  allow: boolean;
  reasons: string[];
}

/**
 * Scan a single string for secrets + local paths. Returns
 * every matching pattern name. Returns empty array if
 * nothing matched.
 */
export function scanString(value: string): string[] {
  const hits: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(value)) hits.push(`secret:${name}`);
  }
  for (const { name, regex } of LOCAL_PATH_PATTERNS) {
    if (regex.test(value)) hits.push(`local_path:${name}`);
  }
  return hits;
}

/**
 * Recursively walk an arbitrary JSON-ish value and scan
 * every string it contains. Returns a `ScanResult` with
 * `allow: false` if any string matched, along with the
 * list of unique pattern names that fired.
 *
 * Cycles and exotic types (functions, symbols) are not
 * expected in sync-batch items (they are parsed from JSON).
 * The walker is defensive anyway — it only descends into
 * plain objects and arrays, and treats anything else that
 * is not a string as a no-op.
 */
export function scanValue(value: unknown): ScanResult {
  const hits = new Set<string>();
  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      for (const hit of scanString(current)) hits.add(hit);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);
    if (Array.isArray(current)) {
      for (const entry of current) stack.push(entry);
    } else {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        stack.push(key, entry);
      }
    }
  }
  return {
    allow: hits.size === 0,
    reasons: Array.from(hits).sort(),
  };
}

/**
 * Scan a sync batch item. schema_version 2 content items are allowed without
 * inspecting encrypted payloads. Governance remains plaintext in content-
 * opaque mode. vault_drive_file is still scanned as defense in depth even
 * though R8 rejects it for content_opaque tenants before hosted metadata write.
 */
export function scanSyncItem(
  item: Record<string, unknown>,
  schemaVersion: number,
): ScanResult {
  if (schemaVersion === 2 && item.type !== "governance" && item.type !== "vault_drive_file") {
    return { allow: true, reasons: [] };
  }
  // For schema_version 1, scan the whole item object. This
  // covers `substance`, `data`, and any route-specific
  // metadata fields the client might attach.
  return scanValue(item);
}
