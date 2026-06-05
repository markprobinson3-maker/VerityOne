/**
 * Local vault history reader — VO-LINKED-SOURCES-HISTORY-PR-1.
 *
 * Powers the Vault tab's "Linked Sources" dashboard region with a
 * recency-ordered list of finalized dossiers and their honest
 * graph-link status. NOT a sync-export helper — the sync-export
 * contract at `vault-metadata.ts#listFinalizedDossierMetadata`
 * stays frozen; this file is a separate local-history reader with
 * a different row shape and a different sort order.
 *
 * Row shape for the dashboard:
 *
 *   - hash (from filename)
 *   - title (from frontmatter)
 *   - generated_at (from frontmatter)
 *   - dossier_path (relative: dossiers/{filename})
 *   - source_capture (from frontmatter)
 *   - source_url (from frontmatter, optional)
 *   - capture_hash (from frontmatter)
 *   - vo_addr (from frontmatter — "none" or a PJ addr)
 *   - vo_nodes_count (from frontmatter)
 *   - link_status (derived honestly; see below)
 *
 * Link status taxonomy (FIVE values — two axes, four real states
 * plus an honest "don't know"):
 *
 *   - "graph_linked"           — vo_addr !== "none" AND
 *                                vo_nodes_count > 0. Dossier has a
 *                                doc node AND graph-backed memories.
 *   - "doc_linked_no_memories" — vo_addr !== "none" AND
 *                                vo_nodes_count === 0. /ops/link-doc
 *                                ran and the dossier is a doc node in
 *                                the graph, but zero derived memories
 *                                were written (for example, all
 *                                proposed atoms deduped away). A
 *                                doc-node-only dossier IS graph-
 *                                backed for the source-tracking
 *                                question — distinct from local-only.
 *   - "memories_only"          — vo_addr "none" / missing AND
 *                                vo_nodes_count > 0. /memory/write
 *                                succeeded but /ops/link-doc was
 *                                skipped or failed.
 *   - "local_only"             — vo_addr "none" / missing AND
 *                                vo_nodes_count === 0. Truly no
 *                                graph linkage at all.
 *   - "unknown_metadata"       — frontmatter absent or unparseable,
 *                                OR vo_nodes_count field missing.
 *                                Surfaces as "Metadata unavailable".
 *
 * Data source discipline:
 *   - reads only `{vault_root}/dossiers/*.dossier.md` (finalized).
 *   - does NOT read drafts (.dossier.draft.md).
 *   - does NOT parse index.md or log.md.
 *   - does NOT read body text — frontmatter + filename only.
 *   - does NOT fall back to captures/.manifest.jsonl.
 *
 * Error posture:
 *   - one bad dossier degrades that row to link_status:
 *     "unknown_metadata" — the whole list does NOT fail.
 *   - missing `dossiers/` directory returns an empty array.
 *   - unreadable vault root returns an empty array.
 *
 * Sort order: newest `generated_at` first. Rows with no
 * `generated_at` sort after rows that have one. Ties fall back to
 * hash (stable).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type LinkStatus =
  | "graph_linked"
  | "doc_linked_no_memories"
  | "memories_only"
  | "local_only"
  | "unknown_metadata";

export interface VaultHistoryRow {
  hash: string;
  title: string | null;
  generated_at: string | null;
  dossier_path: string;
  source_capture: string | null;
  source_url: string | null;
  capture_hash: string | null;
  vo_addr: string | null;
  vo_nodes_count: number | null;
  link_status: LinkStatus;
}

// ─── Frontmatter parsing ───────────────────────────────────────────────
// Targets the restricted YAML shape vault-finalize emits. NOT a general
// YAML parser. Mirrors the extractors in vault-metadata.ts and
// mcp/src/tools/vault-list.ts so behavior stays identical across
// read surfaces.

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---");
  return endIdx >= 0 ? rest.slice(0, endIdx) : null;
}

/**
 * Extract a YAML double-quoted scalar for the named field. Handles
 * escaped quotes (`\"`) and escaped backslashes (`\\`) inside the
 * value — vault-finalize writes titles as YAML-escaped strings, so
 * titles that contain quotes (e.g. `title: "He said \"Hi\""`) must
 * round-trip correctly. Returns the unescaped value, or `null` if
 * the field isn't present.
 *
 * Regex body: `(?:[^"\\]|\\.)*` — any char that is NOT a bare quote
 * or bare backslash, OR a backslash followed by any char. That
 * treats `\"` and `\\` as part of the value, never as terminators.
 *
 * Unescape step: `\X` → `X` for every backslash-escape in the
 * captured text. For the finalize pipeline's minimal escape set
 * (\" and \\), that is correct; for other escapes it degrades to
 * "drop the backslash" which is fine because finalize does not
 * emit them today.
 */
function extractScalar(fm: string, field: string): string | null {
  const rx = new RegExp(`^${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m");
  const m = fm.match(rx);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, (_: string, ch: string) => ch);
}

function extractVoNodesCount(fm: string): number | null {
  if (/^vo_nodes:\s*\[\s*\]\s*$/m.test(fm)) return 0;
  const blockMatch = fm.match(/^vo_nodes:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!blockMatch) return null;
  return (blockMatch[1] || "").match(/^\s+-\s+/gm)?.length ?? 0;
}

/**
 * Derive link_status from vo_addr + vo_nodes_count.
 *
 * Two independent axes — doc-node linkage (vo_addr) and memory-node
 * linkage (vo_nodes_count) — give four real states plus an honest
 * "don't know" when the frontmatter doesn't carry vo_nodes_count.
 * Treating `vo_addr` as meaningful when present (even with zero
 * derived memories) matters because `/ops/link-doc` explicitly
 * accepts an empty derived-memory list — a dossier can be a graph
 * doc node while having no memories.
 */
export function deriveLinkStatus(
  voAddr: string | null,
  voNodesCount: number | null,
): LinkStatus {
  // Honest "don't know" — frontmatter missing the vo_nodes field.
  if (voNodesCount === null) return "unknown_metadata";
  const hasDocAddr = voAddr !== null && voAddr !== "" && voAddr !== "none";
  const hasMemories = voNodesCount > 0;
  if (hasDocAddr && hasMemories) return "graph_linked";
  if (hasDocAddr && !hasMemories) return "doc_linked_no_memories";
  if (!hasDocAddr && hasMemories) return "memories_only";
  return "local_only";
}

/**
 * Parse one finalized dossier file. Returns a row or `null` if the
 * filename doesn't match the finalized pattern (drafts, conflicts,
 * non-dossier files). Malformed frontmatter → row with
 * link_status: "unknown_metadata", NOT null — the row still surfaces
 * so operators can see the broken file.
 */
export function parseFinalizedDossier(
  filename: string,
  fileContent: string,
): VaultHistoryRow | null {
  const match = filename.match(/^([a-f0-9]{8})-(.+)\.dossier\.md$/);
  if (!match) return null;
  if (filename.includes(".draft.")) return null;
  const hash = match[1];
  const dossierPath = `dossiers/${filename}`;

  const fm = extractFrontmatter(fileContent);
  if (!fm) {
    return {
      hash,
      title: null,
      generated_at: null,
      dossier_path: dossierPath,
      source_capture: null,
      source_url: null,
      capture_hash: null,
      vo_addr: null,
      vo_nodes_count: null,
      link_status: "unknown_metadata",
    };
  }

  const title = extractScalar(fm, "title");
  const generatedAt = extractScalar(fm, "generated_at");
  const sourceCapture = extractScalar(fm, "source_capture");
  const sourceUrl = extractScalar(fm, "source_url");
  const captureHash = extractScalar(fm, "capture_hash");
  const voAddr = extractScalar(fm, "vo_addr");
  const voNodesCount = extractVoNodesCount(fm);

  return {
    hash,
    title,
    generated_at: generatedAt,
    dossier_path: dossierPath,
    source_capture: sourceCapture,
    source_url: sourceUrl,
    capture_hash: captureHash,
    vo_addr: voAddr,
    vo_nodes_count: voNodesCount,
    link_status: deriveLinkStatus(voAddr, voNodesCount),
  };
}

/**
 * List finalized-dossier history rows from the local vault. Recency-
 * first ordered, honest link_status per row, malformed-row tolerant.
 *
 * `vaultRoot` MUST already be validated as a ready vault by the
 * caller — this helper does not run the dashboard readiness gate.
 * That split is intentional: readiness is a route concern (lives in
 * `readVaultDashboardState(...)` via `vault-control.ts`) and this
 * helper is a pure filesystem reader that the route invokes after
 * gating.
 */
export function listVaultHistoryRows(vaultRoot: string): VaultHistoryRow[] {
  const dossiersDir = path.join(vaultRoot, "dossiers");
  if (!fs.existsSync(dossiersDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dossiersDir);
  } catch {
    return [];
  }

  const rows: VaultHistoryRow[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".dossier.md") || entry.includes(".draft.")) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dossiersDir, entry), "utf-8");
    } catch {
      // Unreadable file: record a row with unknown_metadata so the
      // operator sees it without losing the rest of the list.
      const match = entry.match(/^([a-f0-9]{8})-/);
      if (!match) continue;
      rows.push({
        hash: match[1],
        title: null,
        generated_at: null,
        dossier_path: `dossiers/${entry}`,
        source_capture: null,
        source_url: null,
        capture_hash: null,
        vo_addr: null,
        vo_nodes_count: null,
        link_status: "unknown_metadata",
      });
      continue;
    }

    try {
      const row = parseFinalizedDossier(entry, content);
      if (row) rows.push(row);
    } catch {
      // Defensive: any unexpected parser failure also degrades to
      // a single unknown_metadata row, never throws up and kills
      // the list.
      const match = entry.match(/^([a-f0-9]{8})-/);
      if (!match) continue;
      rows.push({
        hash: match[1],
        title: null,
        generated_at: null,
        dossier_path: `dossiers/${entry}`,
        source_capture: null,
        source_url: null,
        capture_hash: null,
        vo_addr: null,
        vo_nodes_count: null,
        link_status: "unknown_metadata",
      });
    }
  }

  // Recency-first: newest generated_at first. Rows without a
  // generated_at sort to the end. Stable tie-break on hash.
  rows.sort((a, b) => {
    if (a.generated_at && b.generated_at) {
      if (a.generated_at > b.generated_at) return -1;
      if (a.generated_at < b.generated_at) return 1;
      return a.hash.localeCompare(b.hash);
    }
    if (a.generated_at && !b.generated_at) return -1;
    if (!a.generated_at && b.generated_at) return 1;
    return a.hash.localeCompare(b.hash);
  });

  return rows;
}
