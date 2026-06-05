/**
 * Vault Rung-6 soft-tombstone pass (VO-VAULT-DELETION-SEMANTICS / plan Q4=A).
 *
 * Walks the local vault: for each node holding an ACTIVE `vault_file`
 * source_ref, if the on-disk dossier is GONE, soft-tombstone that ref
 * (status:"deleted" + deleted_at). The node always STAYS — Rung 6 never
 * retracts a node, it only marks the lost anchor (audit trail preserved).
 *
 * Filesystem-only → lives in miners and runs inside the local supercron
 * worker. Reuses the Rung-3 primitives: verifyDossierHash (existence/missing
 * detection) + the source-refs helpers. Layered safety so a moved/unmounted
 * vault root can never mass-tombstone a whole tenant:
 *   1. enabled gate (graph_state vault_tombstone_pass_enabled, read upstream)
 *   2. readVaultEnabled() — vault turned off must not read every ref as missing
 *   3. inspectVaultRoot().ok — an unreadable root aborts the whole pass
 *   4. mass-tombstone safety valve — an implausibly high missing-fraction
 *      aborts with zero writes (likely the root moved/emptied or a race)
 *   5. per-ref re-verify under FOR UPDATE — only a still-missing ref flips
 * Tombstone ONLY on reason==="missing"; a "mismatch" is a human edit
 * (Rung-3 conflict territory), never a deletion.
 */

import type postgres from "postgres";
import {
  resolveConfiguredVaultRoot,
  inspectVaultRoot,
  readVaultEnabled,
} from "../../api/src/lib/vault-control";
import { verifyDossierHash, VaultWriteError } from "../../api/src/lib/vault-write";
import {
  findActiveVaultFileRefs,
  tombstoneVaultFileSourceRef,
  type SourceRef,
} from "../../api/src/lib/source-refs";
import { parseJsonField } from "../../api/src/lib/utils";
import { auditMutationFromWorker } from "../../api/src/lib/audit";

type SqlClient = ReturnType<typeof postgres>;

/**
 * Mass-tombstone safety valve. If the vault root passes inspection but an
 * implausibly large fraction of the active refs checked are "missing", treat
 * it as a transient/misconfig (dossiers/ emptied, root swap, race) and
 * tombstone NOTHING this cycle. The next pass re-evaluates against a settled
 * filesystem. Only engages once enough refs are sampled to be meaningful.
 */
export const MASS_TOMBSTONE_MIN_CHECKED = 5;
export const MASS_TOMBSTONE_MAX_MISSING_FRACTION = 0.5;

export type VaultTombstoneSkipReason =
  | "disabled"
  | "local_vault_off"
  | "no_vault"
  | "vault_unreadable"
  | "serverless"
  | "mass_tombstone_guard";

export interface VaultTombstoneResult {
  tombstoned: number;
  nodesScanned: number;
  refsChecked: number;
  missingFiles: number;
  disabled: boolean;
  skippedReason?: VaultTombstoneSkipReason;
  dryRun: boolean;
}

function result(partial: Partial<VaultTombstoneResult>): VaultTombstoneResult {
  return {
    tombstoned: 0,
    nodesScanned: 0,
    refsChecked: 0,
    missingFiles: 0,
    disabled: false,
    dryRun: false,
    ...partial,
  };
}

export async function runVaultTombstonePass(
  sql: SqlClient,
  tenantId: string,
  opts: { dryRun?: boolean; enabled?: boolean } = {},
): Promise<VaultTombstoneResult> {
  const dryRun = opts.dryRun === true;

  // 1. Install-wide enable flag (read by the supercron wrapper, passed down).
  if (opts.enabled === false) return result({ disabled: true, skippedReason: "disabled", dryRun });

  // 2. Local vault must be ON — otherwise every ref would look "missing".
  if (!readVaultEnabled()) return result({ skippedReason: "local_vault_off", dryRun });

  // 3. Resolve + validate the vault root. An unreadable/unmounted root aborts
  //    the entire pass — never read "the whole root is gone" as "every file
  //    deleted".
  const resolution = resolveConfiguredVaultRoot(tenantId);
  if (!resolution.root) return result({ skippedReason: "no_vault", dryRun });
  const inspection = inspectVaultRoot(resolution.root, resolution.tenant_id ?? tenantId, true);
  if (!inspection.ok) return result({ skippedReason: "vault_unreadable", dryRun });
  const vaultRoot = resolution.root;
  const space = `tenant:${tenantId}`;

  // ── Scan phase: collect every active vault_file ref whose file is missing ──
  // GIN @> containment (idx_nodes_source_refs) narrows to nodes that hold a
  // vault_file ref; findActiveVaultFileRefs in JS excludes already-tombstoned
  // refs (status:"deleted") and treats status-absent as active.
  const rows = (await sql`
    SELECT addr, source_refs
    FROM nodes
    WHERE space_id = ${space}
      AND visibility <> 'deleted'
      AND source_refs @> '[{"kind":"vault_file"}]'::jsonb
    ORDER BY addr
  `) as unknown as Array<{ addr: string; source_refs: unknown }>;

  const missingByNode = new Map<string, Array<{ sha256: string; path: string }>>();
  let nodesScanned = 0;
  let refsChecked = 0;
  let missingFiles = 0;

  for (const row of rows) {
    const refs = (parseJsonField(row.source_refs) as SourceRef[]) ?? [];
    const active = findActiveVaultFileRefs(refs);
    if (active.length === 0) continue;
    nodesScanned++;
    for (const ref of active) {
      refsChecked++;
      let verdict;
      try {
        verdict = verifyDossierHash(vaultRoot, ref.path, ref.sha256);
      } catch (e) {
        // assertLocalProfile fires on serverless — abort the whole pass.
        if (e instanceof VaultWriteError && e.code === "serverless_filesystem_forbidden") {
          return result({ skippedReason: "serverless", dryRun });
        }
        // A malformed/legacy path (traversal/absolute) throws — skip it; never
        // tombstone on a path error.
        continue;
      }
      // Tombstone ONLY when the file is gone. "mismatch" = human edit (Rung-3
      // conflict territory); "bad_expected" = malformed ref. Neither deletes.
      if (!verdict.ok && verdict.reason === "missing") {
        missingFiles++;
        const list = missingByNode.get(row.addr) ?? [];
        list.push({ sha256: ref.sha256, path: ref.path });
        missingByNode.set(row.addr, list);
      }
    }
  }

  // ── Guard phase: mass-tombstone safety valve ──
  if (
    refsChecked >= MASS_TOMBSTONE_MIN_CHECKED &&
    missingFiles / refsChecked > MASS_TOMBSTONE_MAX_MISSING_FRACTION
  ) {
    console.error(
      `[vault-tombstone] mass-tombstone guard tripped: ${missingFiles}/${refsChecked} refs missing ` +
        `(> ${MASS_TOMBSTONE_MAX_MISSING_FRACTION}); root likely moved/emptied — tombstoning nothing this cycle.`,
    );
    return result({ nodesScanned, refsChecked, missingFiles, skippedReason: "mass_tombstone_guard", dryRun });
  }

  if (dryRun || missingFiles === 0) {
    return { tombstoned: 0, nodesScanned, refsChecked, missingFiles, disabled: false, dryRun };
  }

  // ── Apply phase: flip refs (node STAYS) + audit, atomically, per node ──
  const nowIso = new Date().toISOString();
  let tombstoned = 0;
  for (const [addr, missing] of missingByNode) {
    let flipped: Array<{ sha256: string; path: string }> = [];
    try {
      flipped = await sql.begin(async (tx: any) => {
        // Re-read under lock to avoid clobbering a concurrent Rung-3 re-stamp.
        const [current] = await tx`
          SELECT source_refs FROM nodes WHERE addr = ${addr} AND space_id = ${space} FOR UPDATE
        `;
        if (!current) return [] as Array<{ sha256: string; path: string }>;
        let refs = (parseJsonField(current.source_refs) as SourceRef[]) ?? [];
        const activeShas = new Set(findActiveVaultFileRefs(refs).map((r) => r.sha256));
        // Only flip refs that are STILL active by sha256 AND whose file is STILL
        // missing under lock (closes the delete→recreate-identical race).
        const toFlip = missing.filter((m) => {
          if (!activeShas.has(m.sha256)) return false;
          try {
            return verifyDossierHash(vaultRoot, m.path, m.sha256).reason === "missing";
          } catch {
            return false;
          }
        });
        if (toFlip.length === 0) return [];
        for (const m of toFlip) refs = tombstoneVaultFileSourceRef(refs, m.sha256, nowIso);
        await tx`
          UPDATE nodes SET source_refs = ${tx.json(refs)}, updated_at = now()
          WHERE addr = ${addr} AND space_id = ${space}
        `;
        // Audit ATOMICALLY with the tombstone (durability:"required", same tx):
        // the acceptance promises tombstones are visible in the audit log, so a
        // node mutation must carry a durable audit row. If the audit fails the
        // whole tx rolls back and the next cycle retries — never a silent
        // tombstone, never an orphan audit. One row per tombstoned ref.
        for (const m of toFlip) {
          await auditMutationFromWorker(
            tx,
            {
              kind: "vault_file_tombstoned",
              tenantId,
              actor: "supercron_daemon:vault_tombstone",
              actorKind: "operator_token",
              addr,
              path: m.path,
              sha256: m.sha256,
            },
            { durability: "required" },
          );
        }
        return toFlip;
      });
    } catch (e) {
      // One node's tombstone+audit failing must not abort the whole pass; the
      // tombstone rolled back atomically, so the next cycle re-evaluates it.
      console.error(
        `[vault-tombstone] tombstone+audit tx failed for ${addr} (rolled back; retry next cycle): ${(e as Error)?.message}`,
      );
      continue;
    }
    tombstoned += flipped.length;
  }

  return { tombstoned, nodesScanned, refsChecked, missingFiles, disabled: false, dryRun: false };
}
