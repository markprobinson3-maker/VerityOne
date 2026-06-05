/**
 * Local vault metadata reader for sync export.
 *
 * Reads finalized dossier metadata from the local vault for outbound
 * sync when `vault_sync = "metadata_only"`. Only extracts:
 *   - hash (from filename)
 *   - title (from frontmatter)
 *   - generated_at (from frontmatter)
 *   - content_hash (from frontmatter, if present)
 *   - vo_nodes_count (from frontmatter)
 *
 * Does NOT read:
 *   - markdown body text
 *   - source_capture / source_url / source_hash
 *   - vo_nodes array
 *   - vault root path / local filesystem layout
 *   - draft dossiers
 *   - notes / captures
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type postgres from "postgres";
import { inspectVaultRoot as inspectSharedVaultRoot } from "@verity-one/vault-root";
import { resolveConfigPath } from "./runtime-profile";

type SqlTag = ReturnType<typeof postgres>;

// ── Vault root discovery ─────────────────────────────────────────────
// Uses the shared R7 resolver so API, MCP, desktop, and CLI agree on
// env/config/default precedence and tenant-marker readiness.

function readConfigField(field: string): string | null {
  try {
    const cfgPath = resolveConfigPath();
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const val = parsed[field];
    return typeof val === "string" && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function readConfigTenantId(): string | null {
  return readConfigField("tenant_id");
}

export interface VaultDiscovery {
  ok: boolean;
  vaultRoot?: string;
  tenantId?: string;
  status?: string;
  reason?: string;
  error?: string;
}

export function discoverVault(tenantId?: string | null): VaultDiscovery {
  const inspection = inspectSharedVaultRoot({
    tenantId: tenantId ?? readConfigTenantId(),
    env: process.env,
    configPath: resolveConfigPath(),
    vaultEnabled: true,
  });
  if (!inspection.ok || inspection.status !== "ready") {
    return {
      ok: false,
      vaultRoot: inspection.root ?? undefined,
      tenantId: inspection.tenant_id ?? undefined,
      status: inspection.status,
      reason: "reason" in inspection ? inspection.reason : undefined,
      error: inspection.error ?? undefined,
    };
  }
  return { ok: true, vaultRoot: inspection.root, tenantId: inspection.vault_tenant_id, status: inspection.status };
}

// ── Dossier metadata extraction ──────────────────────────────────────

export interface DossierMetadata {
  hash: string;
  title: string | null;
  generated_at: string | null;
  content_hash: string | null;
  vo_nodes_count: number | null;
  vo_node_addrs: string[];   // memory addrs from frontmatter, for project derivation
}

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---");
  return endIdx >= 0 ? rest.slice(0, endIdx) : null;
}

function extractScalar(fm: string, field: string): string | null {
  const rx = new RegExp(`^${field}:\\s*"([^"]*)"\\s*$`, "m");
  const m = fm.match(rx);
  return m ? m[1] : null;
}

function extractVoNodesCount(fm: string): number | null {
  if (/^vo_nodes:\s*\[\s*\]\s*$/m.test(fm)) return 0;
  const blockMatch = fm.match(/^vo_nodes:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!blockMatch) return null;
  return (blockMatch[1] || "").match(/^\s+-\s+/gm)?.length ?? 0;
}

/** Extract vo_nodes addrs from frontmatter YAML list. */
function extractVoNodeAddrs(fm: string): string[] {
  if (/^vo_nodes:\s*\[\s*\]\s*$/m.test(fm)) return [];
  const blockMatch = fm.match(/^vo_nodes:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!blockMatch) return [];
  const items = (blockMatch[1] || "").match(/^\s+-\s+"?([^"\n]+)"?\s*$/gm) || [];
  return items.map((line) => line.replace(/^\s+-\s+"?/, "").replace(/"?\s*$/, "").trim()).filter(Boolean);
}

/**
 * List finalized dossier metadata from the local vault.
 * Returns only the narrow metadata contract — no body text, no paths.
 */
export function listFinalizedDossierMetadata(vaultRoot: string): DossierMetadata[] {
  const dossiersDir = path.join(vaultRoot, "dossiers");
  if (!fs.existsSync(dossiersDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dossiersDir);
  } catch {
    return [];
  }

  const results: DossierMetadata[] = [];
  for (const entry of entries) {
    // Only finalized: {hash8}-{slug}.dossier.md
    const match = entry.match(/^([a-f0-9]{8})-(.+)\.dossier\.md$/);
    if (!match) continue;
    // Exclude drafts
    if (entry.includes(".draft.")) continue;

    const hash = match[1];
    const filePath = path.join(dossiersDir, entry);

    let title: string | null = null;
    let generatedAt: string | null = null;
    let contentHash: string | null = null;
    let voNodesCount: number | null = null;
    let voNodeAddrs: string[] = [];

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const fm = extractFrontmatter(content);
      if (fm) {
        title = extractScalar(fm, "title");
        generatedAt = extractScalar(fm, "generated_at");
        contentHash = extractScalar(fm, "content_hash");
        voNodesCount = extractVoNodesCount(fm);
        voNodeAddrs = extractVoNodeAddrs(fm);
      }
    } catch {
      // Unreadable file — include with null metadata
    }

    results.push({ hash, title, generated_at: generatedAt, content_hash: contentHash, vo_nodes_count: voNodesCount, vo_node_addrs: voNodeAddrs });
  }

  return results;
}

/**
 * Resolve a dossier's project_addr from its vo_nodes. If all linked
 * memories belong to the same project, that project is the scope.
 * If projects are mixed, absent, or nodes have no project_addr, returns null.
 */
export async function resolveDossierProjectAddr(
  sql: SqlTag,
  voNodeAddrs: string[],
): Promise<string | null> {
  if (voNodeAddrs.length === 0) return null;

  try {
    // Query ALL referenced memories, including those with null project_addr.
    // A dossier is single-project ONLY if every referenced memory resolves
    // to the same non-null project_addr. Any unscoped memory forces null
    // (fail-closed for mixed scope).
    const rows = await sql`
      SELECT substance->>'project_addr' as project_addr
      FROM nodes
      WHERE addr = ANY(${voNodeAddrs})
        AND node_type = 'memory'
        AND visibility <> 'deleted'
    `;

    if (rows.length === 0) return null; // no memories found

    const projectSet = new Set<string | null>();
    for (const r of rows) {
      const pa = (r.project_addr as string) || null;
      projectSet.add(pa);
    }

    // If any memory is unscoped (null), the dossier is mixed-scope
    if (projectSet.has(null)) return null;
    // If exactly one non-null project, that's the scope
    if (projectSet.size === 1) return [...projectSet][0];
    // Multiple projects — fail closed
    return null;
  } catch {
    return null;
  }
}
