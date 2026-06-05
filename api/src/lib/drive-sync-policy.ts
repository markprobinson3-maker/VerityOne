/**
 * Two-way Drive sync path policy (PR-V2, spec §5.3).
 *
 * Pure rules for which vault paths participate in sync and where conflict
 * snapshots land. Both sync legs (push + pull) import `shouldSkipSyncPath` so the
 * skip-list lives in exactly one place — otherwise `.conflicts/` snapshots could
 * themselves get mirrored to Drive and spawn fresh conflicts, or Obsidian's
 * workspace state could thrash the mirror.
 */

/** Conflict snapshots are LOCAL-ONLY — never synced to Drive (and skipped here). */
export const CONFLICTS_DIR = ".conflicts";

/**
 * True if a vault-relative path must NOT be synced in either direction.
 *
 * Skips every dot-segment path (covers `.conflicts/`, `.git/`, `.obsidian/`,
 * `.vo-vault.json`, `.DS_Store`, and any other dot-dir/dotfile) plus `*.tmp`
 * scratch files. Content zones (web/ documents/ … ) never start with a dot, so
 * real content is never skipped.
 */
export function shouldSkipSyncPath(relPath: string): boolean {
  if (typeof relPath !== "string") return true;
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm === "." || norm === "..") return true;
  const segments = norm.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return true;
  // Any dot-prefixed segment (dot-dir anywhere in the path, or a dotfile leaf).
  if (segments.some((s) => s.startsWith("."))) return true;
  // Path traversal must never be synced.
  if (segments.some((s) => s === "..")) return true;
  const base = segments[segments.length - 1];
  if (base.toLowerCase().endsWith(".tmp")) return true;
  return false;
}

/**
 * Where to snapshot the Drive-side version when local wins a conflict (§5.3).
 * Lands under `.conflicts/` (which `shouldSkipSyncPath` excludes, so the snapshot
 * is never itself mirrored), preserves the original relative path for traceability,
 * and stamps a compact timestamp + `.drive` marker to avoid collisions. The
 * timestamp is passed in so this stays pure/testable.
 */
export function conflictSnapshotPath(relPath: string, timestampIso: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const compact = timestampIso.replace(/[^0-9A-Za-z]/g, "").slice(0, 15) || "unknown";
  return `${CONFLICTS_DIR}/${norm}.${compact}.drive`;
}
