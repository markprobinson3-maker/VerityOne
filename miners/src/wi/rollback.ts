/**
 * World Ingestor V2 — Rollback.
 * Undo ingestion by run_id or source URL.
 */

import { sql, normalizeUrl } from "./config";
import { existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

const SKILLS_DIR = join(process.env.HOME || "", ".openclaw/workspace-main/skills");
const ROLLED_BACK_DIR = join(SKILLS_DIR, "_rolled_back");

interface RollbackResult {
  runId: string;
  stagingNodesDeleted: number;
  stimuliDeleted: number;
  skillProposalsDeleted: number;
  atomHashesDeleted: number;
  sourceLinksDeleted: number;
  poolAtomsDeleted: number;
  skillsMoved: string[];
}

// ============================================================
// ROLLBACK BY RUN ID
// ============================================================

export async function rollbackRun(runId: string): Promise<RollbackResult> {
  const result: RollbackResult = {
    runId,
    stagingNodesDeleted: 0,
    stimuliDeleted: 0,
    skillProposalsDeleted: 0,
    atomHashesDeleted: 0,
    sourceLinksDeleted: 0,
    poolAtomsDeleted: 0,
    skillsMoved: [],
  };

  // Verify run exists
  const [run] = await sql`SELECT run_id, source_url, status FROM wi_runs WHERE run_id = ${runId}`;
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "rolled_back") throw new Error(`Run already rolled back: ${runId}`);

  // Single transaction for all deletes
  await sql.begin(async (tx: any) => {
    // 1. DELETE staging_nodes
    const stagingResult = await tx`
      DELETE FROM staging_nodes
      WHERE source_context->>'wi_run_id' = ${runId}
    `;
    result.stagingNodesDeleted = stagingResult.count;

    // 2. DELETE stimuli
    const stimuliResult = await tx`
      DELETE FROM stimuli
      WHERE ingest_batch_id = ${runId}
    `;
    result.stimuliDeleted = stimuliResult.count;

    // 3. Handle skill proposals — check for installed skills first.
    // Scope by run_id (exact) so rolling back an OLDER run cannot delete skill
    // proposals created by a NEWER run of the same source_url. (The previous
    // `source_url + created_at >=` predicate deleted every later run's
    // proposals for that URL — data-loss.)
    const skills = await tx`
      SELECT id, skill_path, status FROM wi_skill_proposals
      WHERE run_id = ${runId}
    `;

    for (const skill of skills) {
      // If skill was auto-approved/active, move SKILL.md to _rolled_back/
      if (skill.skill_path && (skill.status === 'active' || skill.status === 'auto_approved')) {
        const fullPath = join(SKILLS_DIR, "..", skill.skill_path);
        if (existsSync(fullPath)) {
          const name = skill.skill_path.split("/")[1] || `skill-${skill.id}`;
          const rolledBackPath = join(ROLLED_BACK_DIR, name);
          mkdirSync(ROLLED_BACK_DIR, { recursive: true });
          try {
            renameSync(dirname(fullPath), rolledBackPath);
            result.skillsMoved.push(skill.skill_path);
          } catch {
            // Move failed — continue
          }
        }
      }
    }

    const skillResult = await tx`
      DELETE FROM wi_skill_proposals
      WHERE run_id = ${runId}
    `;
    result.skillProposalsDeleted = skillResult.count;

    // 4. DELETE atom hashes
    const hashResult = await tx`
      DELETE FROM wi_atom_hashes WHERE run_id = ${runId}
    `;
    result.atomHashesDeleted = hashResult.count;

    // 4b. DELETE pool atoms (may be pending/enriched/routed)
    const poolResult = await tx`
      DELETE FROM wi_atom_pool WHERE run_id = ${runId}
    `.catch(() => ({ count: 0 }));
    result.poolAtomsDeleted = poolResult.count;

    // 5. DELETE source links
    const linkResult = await tx`
      DELETE FROM wi_source_links
      WHERE source_hash IN (
        SELECT source_hash FROM source_history WHERE ingest_batch_id = ${runId}
      )
    `;
    result.sourceLinksDeleted = linkResult.count;

    // 6. UPDATE source_history
    await tx`
      UPDATE source_history SET status = 'rolled_back', updated_at = now()
      WHERE ingest_batch_id = ${runId}
    `;

    // 7. UPDATE wi_runs
    await tx`
      UPDATE wi_runs SET status = 'rolled_back' WHERE run_id = ${runId}
    `;
  });

  return result;
}

// ============================================================
// ROLLBACK BY SOURCE URL
// ============================================================

export async function rollbackSource(url: string): Promise<RollbackResult[]> {
  const normalized = normalizeUrl(url);

  const runs = await sql`
    SELECT run_id FROM wi_runs
    WHERE source_url = ${url} AND status != 'rolled_back'
    ORDER BY created_at ASC
  `;

  if (runs.length === 0) {
    // Try normalized URL
    const byNormalized = await sql`
      SELECT DISTINCT wr.run_id FROM wi_runs wr
      JOIN source_history sh ON sh.ingest_batch_id = wr.run_id
      WHERE sh.normalized_url = ${normalized} AND wr.status != 'rolled_back'
      ORDER BY wr.run_id
    `;
    if (byNormalized.length === 0) throw new Error(`No runs found for URL: ${url}`);
    return Promise.all(byNormalized.map(r => rollbackRun(r.run_id)));
  }

  return Promise.all(runs.map(r => rollbackRun(r.run_id)));
}

// ============================================================
// PRINT SUMMARY
// ============================================================

export function printRollbackSummary(results: RollbackResult[]): void {
  for (const r of results) {
    console.log(`\n  Run: ${r.runId}`);
    console.log(`    Staging nodes deleted: ${r.stagingNodesDeleted}`);
    console.log(`    Stimuli deleted:       ${r.stimuliDeleted}`);
    console.log(`    Skill proposals:       ${r.skillProposalsDeleted}`);
    console.log(`    Atom hashes:           ${r.atomHashesDeleted}`);
    console.log(`    Pool atoms:            ${r.poolAtomsDeleted}`);
    console.log(`    Source links:          ${r.sourceLinksDeleted}`);
    if (r.skillsMoved.length > 0) {
      console.log(`    Skills moved to _rolled_back/: ${r.skillsMoved.join(", ")}`);
    }
  }
}
