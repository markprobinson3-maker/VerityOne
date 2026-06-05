/**
 * Tool: vo_vault_list
 *
 * Direct filesystem read under <vault_root>/dossiers/. Enumerates finalized
 * dossiers and optionally drafts, parses per-row frontmatter for title /
 * generated_at / vo_nodes, and returns the shape locked in
 * docs/VO-MCP-SERVER-CONTRACT.md (Rung 3 → Tool: vo_vault_list).
 *
 * Filename-derived fields (hash, slug, filename, relative_path, source)
 * come from the filename — NOT from frontmatter. Frontmatter is parsed
 * ONLY to extract title, generated_at, and vo_nodes_count. Nothing
 * beyond the frontmatter YAML block is scanned. No body parsing, no
 * atom extraction, no content hashing, no full-text search.
 *
 * Malformed frontmatter on a single row degrades that row's fields to
 * null — the row itself stays in the result. One bad dossier does not
 * fail the whole list call.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { resolveVaultRoot } from "../vault-root.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const listInputShape = {
  vault_root: z
    .string()
    .optional()
    .describe(
      "Absolute path to the vault root. If omitted, resolved via VERITY_VAULT_ROOT env or ~/.vo/config.json#vault_root.",
    ),
  include_drafts: z
    .boolean()
    .optional()
    .describe("If true, also include *.dossier.draft.md files. Defaults to false."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum number of dossiers to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
};

interface FilenameParse {
  hash: string;
  slug: string;
  source: "finalized" | "draft";
}

/** Parse `{hash8}-{slug}.dossier.md` or `{hash8}-{slug}.dossier.draft.md`. */
function parseDossierFilename(filename: string): FilenameParse | null {
  const draftMatch = filename.match(/^([a-f0-9]{8})-(.+)\.dossier\.draft\.md$/);
  if (draftMatch) return { hash: draftMatch[1], slug: draftMatch[2], source: "draft" };
  const finalMatch = filename.match(/^([a-f0-9]{8})-(.+)\.dossier\.md$/);
  if (finalMatch) return { hash: finalMatch[1], slug: finalMatch[2], source: "finalized" };
  return null;
}

/** Extract the leading YAML frontmatter block text, or null if none. */
function extractFrontmatterBlock(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) return null;
  return rest.slice(0, endIdx);
}

/**
 * Minimal vault-frontmatter field extractors. Mirrors the regex approach
 * already used by vaultFinalize/vaultConfirm in agent-lab/scripts/vo-cli.ts
 * so behavior is identical between CLI and MCP reads. Targets the exact
 * field shapes emitted by the harvest pipeline; not a general YAML parser.
 */
function extractScalar(fmBlock: string, field: string): string | null {
  const rx = new RegExp(`^${field}:\\s*"([^"]*)"\\s*$`, "m");
  const m = fmBlock.match(rx);
  return m ? m[1] : null;
}

function extractVoNodesCount(fmBlock: string): number | null {
  // Check for `vo_nodes: []`
  if (/^vo_nodes:\s*\[\s*\]\s*$/m.test(fmBlock)) return 0;
  // Check for the YAML list form
  const blockMatch = fmBlock.match(/^vo_nodes:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!blockMatch) return null;
  const list = blockMatch[1] || "";
  const items = list.match(/^\s+-\s+/gm) || [];
  return items.length;
}

interface DossierRow {
  hash: string;
  slug: string;
  filename: string;
  relative_path: string;
  source: "finalized" | "draft";
  title: string | null;
  generated_at: string | null;
  vo_nodes_count: number | null;
}

function buildRow(vaultRoot: string, filename: string, parsed: FilenameParse): DossierRow {
  const filePath = path.join(vaultRoot, "dossiers", filename);
  const row: DossierRow = {
    hash: parsed.hash,
    slug: parsed.slug,
    filename,
    relative_path: `dossiers/${filename}`,
    source: parsed.source,
    title: null,
    generated_at: null,
    vo_nodes_count: null,
  };

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    // File unreadable — keep the row with null frontmatter-derived fields.
    return row;
  }

  const fmBlock = extractFrontmatterBlock(content);
  if (!fmBlock) return row; // no frontmatter — leave null

  row.title = extractScalar(fmBlock, "title");
  row.generated_at = extractScalar(fmBlock, "generated_at");
  row.vo_nodes_count = extractVoNodesCount(fmBlock);
  return row;
}

export const vaultListTool: ToolDefinition<typeof listInputShape> = {
  name: "vo_vault_list",
  description:
    "List finalized (and optionally draft) dossiers in the tenant's vault. " +
      "Returns filename-anchored metadata plus frontmatter-derived title, generated_at, and vo_nodes_count. " +
      "vo_nodes_count=0 means the dossier exists but has no corresponding memories; null means the field is absent (typically drafts). " +
      "Vault artifacts are downstream of the local VO memory authority — existence of a dossier does not prove graph-backed memory existence.",
  inputShape: listInputShape,
  async handler(_client, args) {
    const argVaultRoot = typeof args.vault_root === "string" ? args.vault_root : undefined;
    const resolved = resolveVaultRoot(argVaultRoot);
    if (!resolved.ok) return errorEnvelope(resolved.envelope);

    const { vaultRoot, tenantId } = resolved;
    const dossiersDir = path.join(vaultRoot, "dossiers");

    if (!fs.existsSync(dossiersDir)) {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "vault has no dossiers directory",
          `expected ${dossiersDir}`,
        ),
      );
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dossiersDir);
    } catch (e) {
      return errorEnvelope(
        buildErrorEnvelope(
          "upstream_error",
          "failed to read dossiers directory",
          (e as Error).message,
        ),
      );
    }

    const includeDrafts = args.include_drafts === true;
    const limit = typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT;

    const rows: DossierRow[] = [];
    for (const entry of entries) {
      const parsed = parseDossierFilename(entry);
      if (!parsed) continue; // not a dossier (.conflicts dir, README, etc.)
      if (parsed.source === "draft" && !includeDrafts) continue;
      rows.push(buildRow(vaultRoot, entry, parsed));
      if (rows.length >= limit) break;
    }

    // Stable ordering: finalized before drafts, then alphabetical by hash.
    rows.sort((a, b) => {
      if (a.source !== b.source) return a.source === "finalized" ? -1 : 1;
      return a.hash.localeCompare(b.hash);
    });

    return okEnvelope({
      ok: true,
      vault_root: vaultRoot,
      tenant_id: tenantId,
      count: rows.length,
      dossiers: rows,
    });
  },
};
