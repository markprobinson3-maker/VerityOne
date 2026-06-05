/**
 * Tool: vo_vault_lookup
 *
 * Direct filesystem read of a single dossier by its 8-char hash prefix.
 * `ls dossiers/{hash8}-*` per docs/VO-VAULT-DESIGN-CONTRACT.md §3 lookup
 * rule. Multiple matches → ambiguous hash → validation_failure.
 *
 * Prefers finalized (`.dossier.md`) over draft (`.dossier.draft.md`)
 * unless the caller passes `prefer_draft: true`.
 *
 * Returns the raw file content (capped at 256 KB) plus a parsed
 * frontmatter object. The frontmatter parser targets the restricted YAML
 * shape that vault finalize/confirm actually emits — it is NOT a general
 * YAML parser. Malformed frontmatter degrades to `frontmatter: null`
 * (best-effort); file-unreadable is a hard failure.
 *
 * Vault provenance is vault-origin. This tool NEVER invents memory
 * fields (addr, kind, federation) on the vault result. If the
 * frontmatter literally carries a `vo_addr` or `vo_nodes` list, they
 * pass through verbatim inside the frontmatter object — they are not
 * lifted to the top level as memory-shaped provenance.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { resolveVaultRoot } from "../vault-root.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const MAX_CONTENT_BYTES = 256 * 1024;

const lookupInputShape = {
  vault_root: z
    .string()
    .optional()
    .describe(
      "Absolute path to the vault root. If omitted, resolved via VERITY_VAULT_ROOT env or ~/.vo/config.json#vault_root.",
    ),
  hash: z
    .string()
    .regex(/^[a-f0-9]{8}$/)
    .describe(
      "8-char content hash prefix. Matches the leading hex of the sha256 capture hash per VO-VAULT-DESIGN-CONTRACT §3.",
    ),
  prefer_draft: z
    .boolean()
    .optional()
    .describe("If true and a draft exists for this hash, return the draft. Defaults to false (finalized preferred)."),
};

interface Match {
  filename: string;
  source: "finalized" | "draft";
  slug: string;
}

function extractFrontmatterBlock(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) return null;
  return rest.slice(0, endIdx);
}

/**
 * Parse the restricted vault frontmatter YAML subset. Handles:
 *   - scalar:  key: "value"
 *   - null:    key: null
 *   - bool:    key: true / key: false
 *   - empty:   key: []
 *   - list:    key:\n  - "item1"\n  - "item2"
 *
 * Returns null when the YAML block is structurally unparseable — either
 * zero recognized key:value lines or a hard exception. This matches the
 * contract: malformed frontmatter degrades to `frontmatter: null`, not to
 * an empty object that would look like a successful parse with no fields.
 * Partial parses (some valid lines mixed with junk) return the partial
 * object — that is the honest best-effort behavior.
 */
function parseVaultFrontmatter(fmBlock: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};
    let recognizedKeys = 0;
    const lines = fmBlock.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const scalarMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (!scalarMatch) {
        // Not a recognized top-level line — skip conservatively, but do
        // not count it as a successfully parsed key.
        i++;
        continue;
      }
      const key = scalarMatch[1];
      const rawValue = scalarMatch[2];

      // List continuation
      if (rawValue.trim() === "") {
        const items: string[] = [];
        let j = i + 1;
        while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
          const itemMatch = lines[j].match(/^\s+-\s+"?([^"]*)"?\s*$/);
          if (itemMatch) items.push(itemMatch[1]);
          j++;
        }
        result[key] = items;
        recognizedKeys++;
        i = j;
        continue;
      }

      const trimmed = rawValue.trim();
      if (trimmed === "null") result[key] = null;
      else if (trimmed === "true") result[key] = true;
      else if (trimmed === "false") result[key] = false;
      else if (trimmed === "[]") result[key] = [];
      else if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        result[key] = trimmed.slice(1, -1).replace(/\\"/g, '"');
      } else {
        // Bareword, number, or something unusual — keep as string.
        result[key] = trimmed;
      }
      recognizedKeys++;
      i++;
    }
    // Contract: malformed frontmatter degrades to null, not {}. An empty
    // object would give agents a false signal of a successful parse with
    // zero fields. Require at least one recognized key:value line.
    if (recognizedKeys === 0) return null;
    return result;
  } catch {
    return null;
  }
}

function findMatches(dossiersDir: string, hash: string): { matches: Match[]; err: Error | null } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dossiersDir);
  } catch (e) {
    return { matches: [], err: e as Error };
  }
  const matches: Match[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${hash}-`)) continue;
    const draftRx = new RegExp(`^${hash}-(.+)\\.dossier\\.draft\\.md$`);
    const finalRx = new RegExp(`^${hash}-(.+)\\.dossier\\.md$`);
    const draftM = entry.match(draftRx);
    if (draftM) {
      matches.push({ filename: entry, source: "draft", slug: draftM[1] });
      continue;
    }
    const finalM = entry.match(finalRx);
    if (finalM) {
      matches.push({ filename: entry, source: "finalized", slug: finalM[1] });
    }
  }
  return { matches, err: null };
}

export const vaultLookupTool: ToolDefinition<typeof lookupInputShape> = {
  name: "vo_vault_lookup",
  description:
    "Fetch a single dossier's full markdown content by its 8-char content hash prefix. " +
      "Prefers finalized over draft unless prefer_draft=true. " +
      "Returns frontmatter (parsed verbatim; best-effort on malformed YAML) plus content capped at 256 KB. " +
      "Vault artifacts are downstream of the local VO memory authority — if the frontmatter vo_nodes list is empty or absent, the dossier is NOT graph-backed.",
  inputShape: lookupInputShape,
  async handler(_client, args) {
    const argVaultRoot = typeof args.vault_root === "string" ? args.vault_root : undefined;
    const resolved = resolveVaultRoot(argVaultRoot);
    if (!resolved.ok) return errorEnvelope(resolved.envelope);

    const { vaultRoot } = resolved;
    const hash = String(args.hash);
    const preferDraft = args.prefer_draft === true;

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

    const { matches, err: readErr } = findMatches(dossiersDir, hash);
    if (readErr) {
      return errorEnvelope(
        buildErrorEnvelope(
          "upstream_error",
          "failed to read dossiers directory",
          readErr.message,
        ),
      );
    }

    if (matches.length === 0) {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "dossier not found",
          `no dossier with hash prefix ${hash} under ${dossiersDir}`,
        ),
      );
    }

    // Check for ambiguous hash: more than one finalized or more than one draft
    const finalized = matches.filter((m) => m.source === "finalized");
    const drafts = matches.filter((m) => m.source === "draft");
    if (finalized.length > 1 || drafts.length > 1) {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "ambiguous hash",
          `multiple dossiers match prefix ${hash}: ${matches.map((m) => m.filename).join(", ")}`,
        ),
      );
    }

    // Pick the right variant per prefer_draft
    let chosen: Match | null = null;
    if (preferDraft && drafts.length > 0) chosen = drafts[0];
    else if (finalized.length > 0) chosen = finalized[0];
    else if (drafts.length > 0) chosen = drafts[0];

    if (!chosen) {
      // Should not happen given the checks above, but defensive.
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "dossier not found",
          `no dossier variant matched prefer_draft=${preferDraft}`,
        ),
      );
    }

    const filePath = path.join(dossiersDir, chosen.filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return errorEnvelope(
        buildErrorEnvelope(
          "upstream_error",
          "failed to stat dossier",
          (e as Error).message,
        ),
      );
    }

    if (stat.size > MAX_CONTENT_BYTES) {
      return errorEnvelope(
        buildErrorEnvelope(
          "validation_failure",
          "dossier exceeds 256 KB",
          `${chosen.filename} is ${stat.size} bytes; read from filesystem directly`,
        ),
      );
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      return errorEnvelope(
        buildErrorEnvelope(
          "upstream_error",
          "failed to read dossier",
          (e as Error).message,
        ),
      );
    }

    const fmBlock = extractFrontmatterBlock(content);
    const frontmatter = fmBlock ? parseVaultFrontmatter(fmBlock) : null;

    return okEnvelope({
      ok: true,
      vault_root: vaultRoot,
      hash,
      slug: chosen.slug,
      filename: chosen.filename,
      relative_path: `dossiers/${chosen.filename}`,
      source: chosen.source,
      frontmatter,
      content,
    });
  },
};
