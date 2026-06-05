/**
 * World Ingestor V2 — CLI entry point.
 *
 * Usage:
 *   bun run miners/src/wi/wi-cli.ts <url>              — ingest single source
 *   bun run miners/src/wi/wi-cli.ts --dry-run <url>    — extract + route, no DB writes
 *   bun run miners/src/wi/wi-cli.ts --force <url>      — bypass URL dedup
 *   bun run miners/src/wi/wi-cli.ts --refresh 7 <url>  — re-ingest if older than 7 days
 *   bun run miners/src/wi/wi-cli.ts --batch <file>     — one URL per line
 *   bun run miners/src/wi/wi-cli.ts --stats            — run summary
 *   bun run miners/src/wi/wi-cli.ts --health           — system health report
 *   bun run miners/src/wi/wi-cli.ts --rollback <id>    — undo a run
 *   bun run miners/src/wi/wi-cli.ts --rollback-source <url> — undo all runs for URL
 *   bun run miners/src/wi/wi-cli.ts --queue <url>      — add to queue
 *   bun run miners/src/wi/wi-cli.ts --queue-status     — queue depth
 *   bun run miners/src/wi/wi-cli.ts --queue-cancel <id> — cancel queued item
 *   bun run miners/src/wi/wi-cli.ts --queue-flush      — cancel all pending
 *   bun run miners/src/wi/wi-cli.ts --review-skills    — show skill proposals
 *   bun run miners/src/wi/wi-cli.ts --approve <id>     — approve a skill
 *   bun run miners/src/wi/wi-cli.ts --reject <id>      — reject a skill
 *   bun run miners/src/wi/wi-cli.ts --retire <id>      — retire a skill
 *   bun run miners/src/wi/wi-cli.ts --skill-stats      — skill lifecycle stats
 *   bun run miners/src/wi/wi-cli.ts --pin <addr>       — pin node (never dormant/absorbed)
 *   bun run miners/src/wi/wi-cli.ts --unpin <addr>     — unpin node (normal lifecycle)
 *   bun run miners/src/wi/wi-cli.ts --enrich-pool      — run one enrichment cycle
 *   bun run miners/src/wi/wi-cli.ts --pool-status      — enrichment pool depth
 *   bun run miners/src/wi/wi-cli.ts --pool-clean       — drop stale atoms
 */

import { receive } from "./receive";
import { extract } from "./extract";
import { route } from "./route";
import { sql, loadParams } from "./config";
import { emitWI } from "./events";
import { rollbackRun, rollbackSource, printRollbackSummary } from "./rollback";
import { autoReviewSkills, installSkill, rejectSkill, retireSkill } from "./skills";
import { runHealthCheck, printHealthReport } from "./health";
import { enqueue, queueStatus, cancelQueueItem, flushQueue } from "./queue";
import { runConvergenceScan, promoteConvergence, dismissConvergence } from "./convergence";
import { enrichInline, poolAtoms, processPool, cleanStaleAtoms, poolStatus } from "./enrich";
import { markWISourceHistoryFailed } from "./source-history";
import type { WIRunResult } from "./config";

// ============================================================
// ARGUMENT PARSING
// ============================================================

const args = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getFlagValue(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function getUrl(): string | null {
  // Last non-flag argument
  for (let i = args.length - 1; i >= 0; i--) {
    if (!args[i].startsWith("--") && (i === 0 || !args[i - 1].startsWith("--") || ["--dry-run", "--force"].includes(args[i - 1]))) {
      return args[i];
    }
  }
  return null;
}

// ============================================================
// PIPELINE — receive → extract → route
// ============================================================

async function runPipeline(url: string, opts: { dryRun?: boolean; force?: boolean; refreshDays?: number }): Promise<WIRunResult> {
  const params = await loadParams();

  const source = await receive(url, {
    dryRun: opts.dryRun,
    force: opts.force,
    refreshDays: opts.refreshDays,
  });

  console.log(`  ✓ RECEIVE  ${source.sourceType}  "${source.title}"  (${source.text.length} chars, ${source.textParts.length} part${source.textParts.length > 1 ? "s" : ""})`);

  const atoms = await extract(source.textParts, source.runId, source.sourceType, source.title);
  console.log(`  ✓ EXTRACT  ${atoms.length} atoms (${atoms.filter(a => a.type === "SKILL").length} skills)`);

  // Inline enrichment (single URL mode)
  let enrichedAtoms;
  if (params.enrichmentEnabled && atoms.length > 0) {
    enrichedAtoms = await enrichInline(atoms, source.runId, source.sourceUrl, source.sourceType);
    const enrichedCount = enrichedAtoms.filter(a => a.enrichment).length;
    console.log(`  ✓ ENRICH   ${enrichedCount}/${atoms.length} atoms enriched (inline)`);
  }

  const result = await route(atoms, source.runId, {
    dryRun: opts.dryRun,
    force: opts.force,
    sourceUrl: source.sourceUrl,
    sourceType: source.sourceType,
    sourceHash: source.sourceHash,
    title: source.title,
    enrichedAtoms,
  });

  console.log(`  ✓ ROUTE    ${result.atomsNewNode} new | ${result.atomsHeat} heat | ${result.atomsSkill} skill | ${result.atomsDrop} drop  (${result.elapsedMs}ms, $${result.costUsd.toFixed(4)})`);
  if (result.atomsDurable || result.atomsCurrent || result.atomsEphemeral) {
    console.log(`  ✓ TEMPORAL ${result.atomsDurable} durable | ${result.atomsCurrent} current | ${result.atomsEphemeral} ephemeral`);
  }

  return result;
}

// ============================================================
// COMMANDS
// ============================================================

async function cmdStats() {
  const [today] = await sql`
    SELECT
      COUNT(*) AS runs,
      COALESCE(SUM(atoms_extracted), 0) AS atoms,
      COALESCE(SUM(atoms_new_node), 0) AS new_nodes,
      COALESCE(SUM(atoms_heat), 0) AS heat,
      COALESCE(SUM(atoms_skill), 0) AS skills,
      COALESCE(SUM(atoms_drop), 0) AS drops,
      COALESCE(SUM(atoms_durable), 0) AS durable,
      COALESCE(SUM(atoms_current), 0) AS current,
      COALESCE(SUM(atoms_ephemeral), 0) AS ephemeral,
      COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM wi_runs
    WHERE created_at > now() - interval '24 hours'
  `;

  const [allTime] = await sql`
    SELECT
      COUNT(*) AS runs,
      COALESCE(SUM(atoms_extracted), 0) AS atoms,
      COALESCE(SUM(skills_detected), 0) AS skills,
      COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost
    FROM wi_runs
  `;

  const recent = await sql`
    SELECT run_id, source_type, title, atoms_extracted, status, elapsed_ms,
      cost_usd::numeric(10,4), created_at
    FROM wi_runs ORDER BY created_at DESC LIMIT 10
  `;

  console.log("\n📊 World Ingestor Stats\n");
  console.log("── Last 24h ──────────────────────────────");
  console.log(`  Runs: ${today.runs}  |  Atoms: ${today.atoms}  |  New: ${today.new_nodes}  |  Heat: ${today.heat}  |  Skills: ${today.skills}  |  Drops: ${today.drops}`);
  console.log(`  Temporal: ${today.durable} durable | ${today.current} current | ${today.ephemeral} ephemeral`);
  console.log(`  Cost: $${today.cost}  |  Failed: ${today.failed}`);
  console.log("\n── All Time ──────────────────────────────");
  console.log(`  Runs: ${allTime.runs}  |  Atoms: ${allTime.atoms}  |  Skills: ${allTime.skills}  |  Cost: $${allTime.cost}`);

  // Lifecycle stats
  const [dormant] = await sql`SELECT COUNT(*)::int AS n FROM nodes WHERE visibility = 'dormant'`;
  const [pinned] = await sql`SELECT COUNT(*)::int AS n FROM nodes WHERE pinned = true`;
  const [echoes] = await sql`SELECT COUNT(*)::int AS n FROM absorbed_echoes`;
  const [absorptionCandidates] = await sql`
    SELECT COUNT(*)::int AS n FROM nodes
    WHERE visibility = 'dormant' AND pinned = false
      AND dormant_at < now() - interval '180 days'
  `;

  console.log("\n── Lifecycle ─────────────────────────────");
  console.log(`  Dormant: ${dormant.n}  |  Pinned: ${pinned.n}  |  Absorbed echoes: ${echoes.n}  |  Absorption candidates: ${absorptionCandidates.n}`);

  // Enrichment pool stats
  try {
    const pool = await poolStatus();
    if (pool.total > 0) {
      console.log("\n── Enrichment Pool ───────────────────────");
      console.log(`  Pending: ${pool.pending}  |  Enriching: ${pool.enriching}  |  Enriched: ${pool.enriched}  |  Routed: ${pool.routed}  |  Failed: ${pool.failed}  |  Total: ${pool.total}`);
    }
  } catch { /* table may not exist yet */ }

  if (recent.length > 0) {
    console.log("\n── Recent Runs ───────────────────────────");
    for (const r of recent) {
      const status = r.status === "done" ? "✅" : r.status === "failed" ? "❌" : "🔄";
      console.log(`  ${status} ${r.source_type.padEnd(10)} ${(r.title || "").slice(0, 50).padEnd(52)} ${r.atoms_extracted} atoms  ${r.elapsed_ms}ms  $${r.cost_usd}`);
    }
  }

  console.log("");
}

async function cmdBatch(filePath: string, parallel: number) {
  const params = await loadParams();
  const file = Bun.file(filePath);
  if (!await file.exists()) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = await file.text();
  const urls = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));

  if (urls.length === 0) {
    console.log("No URLs found in file.");
    return;
  }

  // Pool mode: enrichment enabled AND urls >= inline threshold
  const usePool = params.enrichmentEnabled && urls.length >= params.enrichmentInlineThreshold;

  console.log(`\n📦 Batch ingest: ${urls.length} URLs (parallel: ${parallel})${usePool ? " [POOL MODE]" : ""}\n`);

  // Stale reaper (B7): reset stuck processing entries
  await sql`
    UPDATE source_history SET status = 'pending'
    WHERE status = 'processing' AND updated_at < now() - interval '15 minutes'
  `.catch(() => {});

  // Semaphore-based parallel processing
  let completed = 0;
  let failed = 0;
  let totalPooled = 0;
  const semaphore = { count: 0 };

  async function processUrl(url: string, index: number) {
    while (semaphore.count >= parallel) {
      await new Promise(r => setTimeout(r, 100));
    }
    semaphore.count++;

    try {
      console.log(`[${index + 1}/${urls.length}] ${url}`);

      if (usePool) {
        // Pool mode: receive → extract → pool (no route)
        const source = await receive(url, {
          dryRun: hasFlag("dry-run"),
          force: hasFlag("force"),
        });
        console.log(`  ✓ RECEIVE  ${source.sourceType}  "${source.title}"  (${source.text.length} chars)`);

        const atoms = await extract(source.textParts, source.runId, source.sourceType, source.title);
        console.log(`  ✓ EXTRACT  ${atoms.length} atoms`);

        if (!hasFlag("dry-run")) {
          const poolIds = await poolAtoms(atoms, source.runId, source.sourceUrl, source.sourceType);
          console.log(`  ✓ POOLED   ${poolIds.length} atoms (use --enrich-pool to process)`);
          totalPooled += poolIds.length;
        }
      } else {
        // Inline mode: normal pipeline (with inline enrichment)
        await runPipeline(url, { dryRun: hasFlag("dry-run"), force: hasFlag("force") });
      }
      completed++;
    } catch (err: any) {
      console.error(`  ✗ ${err.message}`);
      failed++;
    } finally {
      semaphore.count--;
    }

    // Progress log every 10
    if ((completed + failed) % 10 === 0 && (completed + failed) < urls.length) {
      console.log(`\n  ── Progress: ${completed + failed}/${urls.length} (${completed} ok, ${failed} failed) ──\n`);
    }
  }

  await Promise.all(urls.map((url, i) => processUrl(url, i)));

  console.log(`\n✅ Batch complete: ${completed} succeeded, ${failed} failed out of ${urls.length}`);
  if (usePool && totalPooled > 0) {
    console.log(`   ${totalPooled} atoms pooled — run --enrich-pool to enrich and route`);
  }
  console.log("");
}

// ============================================================
// TIER 2 COMMANDS
// ============================================================

async function cmdHealth() {
  console.log("\n🏥 World Ingestor — Health Check\n");
  const checks = await runHealthCheck();
  printHealthReport(checks);
}

async function cmdRollback(runId: string) {
  console.log(`\n🔄 Rolling back run: ${runId}\n`);
  try {
    const result = await rollbackRun(runId);
    printRollbackSummary([result]);
  } catch (err: any) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }
}

async function cmdRollbackSource(url: string) {
  console.log(`\n🔄 Rolling back all runs for: ${url}\n`);
  try {
    const results = await rollbackSource(url);
    if (results.length === 0) {
      console.log("  No runs found for this URL.");
      return;
    }
    printRollbackSummary(results);
    console.log(`\n  Total: ${results.length} run(s) rolled back\n`);
  } catch (err: any) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }
}

async function cmdQueueAdd(url: string) {
  const priority = parseInt(getFlagValue("priority") || "5");
  try {
    const id = await enqueue(url, { priority, submittedBy: "cli" });
    console.log(`\n✅ Queued: ${url}  (id=${id}, priority=${priority})\n`);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdQueueStatus() {
  const status = await queueStatus();
  console.log("\n📋 World Ingestor — Queue Status\n");
  console.log(`  Pending:    ${status.pending}`);
  console.log(`  Processing: ${status.processing}`);
  console.log(`  Done:       ${status.done}`);
  console.log(`  Failed:     ${status.failed}`);
  console.log(`  Cancelled:  ${status.cancelled}`);
  console.log(`  Total:      ${status.total}`);
  if (status.oldestPending) {
    console.log(`  Oldest:     ${status.oldestPending}`);
  }

  // Show active items
  const items = await sql`
    SELECT id, url, priority, status, submitted_by, submitted_at, error_message
    FROM wi_queue
    WHERE status IN ('pending', 'processing')
    ORDER BY priority ASC, submitted_at ASC
    LIMIT 20
  `;
  if (items.length > 0) {
    console.log("\n── Active Items ──────────────────────────");
    for (const item of items) {
      const icon = item.status === "processing" ? "⏳" : "📥";
      console.log(`  ${icon} [${item.priority}] ${item.url.slice(0, 60).padEnd(62)} ${item.status}  by:${item.submitted_by || "?"}`);
    }
  }
  console.log("");
}

async function cmdQueueCancel(id: string) {
  const ok = await cancelQueueItem(id);
  if (ok) {
    console.log(`\n✅ Cancelled queue item: ${id}\n`);
  } else {
    console.log(`\n⚠️  Item not found or not pending: ${id}\n`);
  }
}

async function cmdQueueFlush() {
  const count = await flushQueue();
  console.log(`\n✅ Flushed ${count} pending queue item(s)\n`);
}

async function cmdReviewSkills() {
  const status = getFlagValue("status") || undefined;
  const skills = await sql`
    SELECT id, content, source_url, skill_type, status,
      quality_scores, reviewed_by, created_at
    FROM wi_skill_proposals
    WHERE status = COALESCE(${status || null}, status)
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (skills.length === 0) {
    console.log("\n  No skill proposals found.\n");
    return;
  }

  console.log(`\n🧠 Skill Proposals (${skills.length})\n`);
  for (const s of skills) {
    const statusIcon =
      s.status === "active" ? "🟢" :
      s.status === "approved" || s.status === "auto_approved" ? "✅" :
      s.status === "needs_human" ? "🟡" :
      s.status === "rejected" ? "🔴" :
      s.status === "retired" ? "⚫" : "📝";

    console.log(`  ${statusIcon} [${s.id}] ${s.skill_type || "?"} — ${s.status}`);
    console.log(`     ${(s.content || "").slice(0, 100)}`);
    if (s.quality_scores) {
      const qs = typeof s.quality_scores === "string" ? JSON.parse(s.quality_scores) : s.quality_scores;
      console.log(`     Scores: clarity=${qs.clarity} action=${qs.actionability} unique=${qs.uniqueness} safety=${qs.safety} → ${qs.verdict}`);
    }
    console.log("");
  }
}

async function cmdApprove(id: number) {
  try {
    // Update status
    await sql`
      UPDATE wi_skill_proposals SET
        status = 'approved',
        reviewed_by = 'human:cli',
        reviewed_at = now()
      WHERE id = ${id} AND status IN ('needs_human', 'proposed', 'auto_review')
    `;
    const skillPath = await installSkill(id);
    console.log(`\n✅ Approved and installed skill #${id} → ${skillPath}\n`);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdReject(id: number) {
  const reason = getFlagValue("reason") || "Rejected by human reviewer via CLI";
  try {
    await rejectSkill(id, reason);
    console.log(`\n🔴 Rejected skill #${id}: ${reason}\n`);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdRetire(id: number) {
  const reason = getFlagValue("reason") || "Retired by human via CLI";
  try {
    await retireSkill(id, reason);
    console.log(`\n⚫ Retired skill #${id}: ${reason}\n`);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdSkillStats() {
  const [counts] = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'proposed') AS proposed,
      COUNT(*) FILTER (WHERE status = 'auto_review') AS auto_review,
      COUNT(*) FILTER (WHERE status = 'auto_approved') AS auto_approved,
      COUNT(*) FILTER (WHERE status = 'needs_human') AS needs_human,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
      COUNT(*) FILTER (WHERE status = 'active') AS active,
      COUNT(*) FILTER (WHERE status = 'retired') AS retired
    FROM wi_skill_proposals
  `;

  const [recent] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS proposed_24h,
      COUNT(*) FILTER (WHERE reviewed_at > now() - interval '24 hours' AND status = 'rejected') AS rejected_24h,
      COUNT(*) FILTER (WHERE reviewed_at > now() - interval '24 hours' AND status IN ('approved', 'auto_approved', 'active')) AS approved_24h
    FROM wi_skill_proposals
  `;

  const [rejected] = await sql`
    SELECT COUNT(*) AS patterns,
      COUNT(*) FILTER (WHERE permanent = true) AS permanent
    FROM wi_rejected_patterns
  `;

  console.log("\n🧠 World Ingestor — Skill Stats\n");
  console.log("── Lifecycle ─────────────────────────────");
  console.log(`  Proposed:      ${counts.proposed}`);
  console.log(`  Auto-review:   ${counts.auto_review}`);
  console.log(`  Auto-approved: ${counts.auto_approved}`);
  console.log(`  Needs human:   ${counts.needs_human}`);
  console.log(`  Approved:      ${counts.approved}`);
  console.log(`  Active:        ${counts.active}`);
  console.log(`  Rejected:      ${counts.rejected}`);
  console.log(`  Retired:       ${counts.retired}`);
  console.log(`  Total:         ${counts.total}`);
  console.log("\n── Last 24h ──────────────────────────────");
  console.log(`  Proposed: ${recent.proposed_24h}  |  Approved: ${recent.approved_24h}  |  Rejected: ${recent.rejected_24h}`);
  console.log("\n── Rejection Patterns ────────────────────");
  console.log(`  Total: ${rejected.patterns}  |  Permanent: ${rejected.permanent}`);
  console.log("");
}

async function cmdConvergence() {
  const status = getFlagValue("status") || undefined;

  const events = await sql`
    SELECT id, orphan_count, total_energy, source_types, sample_content,
      proposed_label, proposed_description, status, promoted_node_addr, created_at
    FROM wi_convergence_events
    WHERE status = COALESCE(${status || null}, status)
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (events.length === 0) {
    console.log("\n  No convergence events found.\n");
    return;
  }

  console.log(`\n🌊 Convergence Events (${events.length})\n`);
  for (const e of events) {
    const statusIcon =
      e.status === "promoted" ? "🟢" :
      e.status === "detected" ? "🔵" :
      e.status === "dismissed" ? "🟡" :
      e.status === "decayed" ? "⚫" : "📝";

    console.log(`  ${statusIcon} [${e.id}] "${e.proposed_label || "?"}" — ${e.status}`);
    console.log(`     ${e.orphan_count} orphans | energy: ${parseFloat(e.total_energy).toFixed(1)} | sources: ${(e.source_types || []).join(", ")}`);
    if (e.promoted_node_addr) {
      console.log(`     → promoted to ${e.promoted_node_addr}`);
    }
    if (e.proposed_description) {
      console.log(`     ${e.proposed_description}`);
    }
    console.log("");
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Load .env
  const { config } = await import("dotenv");
  const { resolve } = await import("path");
  config({ path: resolve(import.meta.dir, "../../../.env") });

  await loadParams();

  // ── Tier 1 commands ──

  if (hasFlag("stats")) {
    await cmdStats();
    process.exit(0);
  }

  if (hasFlag("batch")) {
    const filePath = getFlagValue("batch");
    if (!filePath) {
      console.error("Usage: --batch <file>");
      process.exit(1);
    }
    const parallel = parseInt(getFlagValue("parallel") || "3");
    await cmdBatch(filePath, parallel);
    process.exit(0);
  }

  // ── Tier 2 commands ──

  if (hasFlag("health")) {
    await cmdHealth();
    process.exit(0);
  }

  if (hasFlag("rollback-source")) {
    const sourceUrl = getFlagValue("rollback-source");
    if (!sourceUrl) { console.error("Usage: --rollback-source <url>"); process.exit(1); }
    await cmdRollbackSource(sourceUrl);
    process.exit(0);
  }

  if (hasFlag("rollback")) {
    const runId = getFlagValue("rollback");
    if (!runId) { console.error("Usage: --rollback <run_id>"); process.exit(1); }
    await cmdRollback(runId);
    process.exit(0);
  }

  if (hasFlag("queue-flush")) {
    await cmdQueueFlush();
    process.exit(0);
  }

  if (hasFlag("queue-cancel")) {
    const id = getFlagValue("queue-cancel");
    if (!id) { console.error("Usage: --queue-cancel <id>"); process.exit(1); }
    await cmdQueueCancel(id);
    process.exit(0);
  }

  if (hasFlag("queue-status")) {
    await cmdQueueStatus();
    process.exit(0);
  }

  if (hasFlag("queue")) {
    const queueUrl = getFlagValue("queue");
    if (!queueUrl) { console.error("Usage: --queue <url>"); process.exit(1); }
    await cmdQueueAdd(queueUrl);
    process.exit(0);
  }

  if (hasFlag("review-skills")) {
    await cmdReviewSkills();
    process.exit(0);
  }

  if (hasFlag("approve")) {
    const id = parseInt(getFlagValue("approve") || "");
    if (isNaN(id)) { console.error("Usage: --approve <id>"); process.exit(1); }
    await cmdApprove(id);
    process.exit(0);
  }

  if (hasFlag("reject")) {
    const id = parseInt(getFlagValue("reject") || "");
    if (isNaN(id)) { console.error("Usage: --reject <id> [--reason 'text']"); process.exit(1); }
    await cmdReject(id);
    process.exit(0);
  }

  if (hasFlag("retire")) {
    const id = parseInt(getFlagValue("retire") || "");
    if (isNaN(id)) { console.error("Usage: --retire <id> [--reason 'text']"); process.exit(1); }
    await cmdRetire(id);
    process.exit(0);
  }

  if (hasFlag("skill-stats")) {
    await cmdSkillStats();
    process.exit(0);
  }

  // ── Convergence commands ──

  if (hasFlag("convergence")) {
    await cmdConvergence();
    process.exit(0);
  }

  if (hasFlag("convergence-scan")) {
    console.log("\n🌊 Running convergence scan...\n");
    const result = await runConvergenceScan();
    console.log(`  Detected: ${result.detected}  |  Promoted: ${result.promoted}  |  Decayed: ${result.decayed}\n`);
    process.exit(0);
  }

  if (hasFlag("promote")) {
    const id = parseInt(getFlagValue("promote") || "");
    if (isNaN(id)) { console.error("Usage: --promote <convergence_event_id>"); process.exit(1); }
    try {
      const addr = await promoteConvergence(id);
      if (addr) {
        console.log(`\n🌊 Promoted convergence event #${id} → ${addr}\n`);
      } else {
        console.log(`\n⚠️  Event #${id} not found or not in detected state\n`);
      }
    } catch (err: any) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (hasFlag("dismiss")) {
    const id = parseInt(getFlagValue("dismiss") || "");
    if (isNaN(id)) { console.error("Usage: --dismiss <convergence_event_id>"); process.exit(1); }
    try {
      await dismissConvergence(id);
      console.log(`\n🌊 Dismissed convergence event #${id}\n`);
    } catch (err: any) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Lifecycle commands ──

  if (hasFlag("pin")) {
    const addr = getFlagValue("pin");
    if (!addr) { console.error("Usage: --pin <addr>"); process.exit(1); }
    const [result] = await sql`UPDATE nodes SET pinned = true WHERE addr = ${addr} RETURNING addr, label`;
    if (result) {
      console.log(`\n📌 Pinned ${result.addr} "${result.label}" — will never go dormant or be absorbed\n`);
    } else {
      console.log(`\n⚠️  Node ${addr} not found\n`);
    }
    process.exit(0);
  }

  if (hasFlag("unpin")) {
    const addr = getFlagValue("unpin");
    if (!addr) { console.error("Usage: --unpin <addr>"); process.exit(1); }
    const [result] = await sql`UPDATE nodes SET pinned = false WHERE addr = ${addr} RETURNING addr, label`;
    if (result) {
      console.log(`\n📌 Unpinned ${result.addr} "${result.label}" — normal lifecycle rules apply\n`);
    } else {
      console.log(`\n⚠️  Node ${addr} not found\n`);
    }
    process.exit(0);
  }

  // ── Enrichment Pool commands ──

  if (hasFlag("enrich-pool")) {
    console.log("\n🧪 Running enrichment pool cycle...\n");
    const result = await processPool();
    console.log(`  Enriched: ${result.enriched}  |  Routed: ${result.routed}  |  Cleaned: ${result.cleaned}\n`);
    process.exit(0);
  }

  if (hasFlag("pool-status")) {
    const pool = await poolStatus();
    console.log("\n🧪 Enrichment Pool Status\n");
    console.log(`  Pending:   ${pool.pending}`);
    console.log(`  Enriching: ${pool.enriching}`);
    console.log(`  Enriched:  ${pool.enriched}`);
    console.log(`  Routed:    ${pool.routed}`);
    console.log(`  Failed:    ${pool.failed}`);
    console.log(`  Total:     ${pool.total}`);
    console.log("");
    process.exit(0);
  }

  if (hasFlag("pool-clean")) {
    console.log("\n🧹 Cleaning stale pool atoms...\n");
    const cleaned = await cleanStaleAtoms();
    console.log(`  Cleaned: ${cleaned} stale atoms\n`);
    process.exit(0);
  }

  // ── Single URL mode ──
  const url = getUrl();
  if (!url) {
    console.log(`
World Ingestor V2 — CLI

Ingestion:
  wi <url>                       — ingest single source
  wi --dry-run <url>             — extract + route, no DB writes
  wi --force <url>               — bypass URL dedup
  wi --refresh 7 <url>           — re-ingest if older than 7 days
  wi --batch <file>              — one URL per line [--parallel N]
  wi --stats                     — run summary

Queue:
  wi --queue <url>               — add URL to queue [--priority 1-10]
  wi --queue-status              — queue depth + active items
  wi --queue-cancel <id>         — cancel a queued item
  wi --queue-flush               — cancel all pending items

Skills:
  wi --review-skills             — show skill proposals [--status proposed]
  wi --approve <id>              — approve and install a skill
  wi --reject <id>               — reject a skill [--reason 'text']
  wi --retire <id>               — retire an active skill [--reason 'text']
  wi --skill-stats               — skill lifecycle stats

Convergence:
  wi --convergence               — list convergence events [--status detected]
  wi --convergence-scan          — run convergence scan now
  wi --promote <id>              — promote a convergence event to node
  wi --dismiss <id>              — dismiss a convergence event

Lifecycle:
  wi --pin <addr>                — pin node (never dormant/absorbed)
  wi --unpin <addr>              — unpin node (normal lifecycle)

Enrichment Pool:
  wi --enrich-pool               — run one enrichment cycle (enrich + route)
  wi --pool-status               — pool depth by status
  wi --pool-clean                — drop stale EPHEMERAL/CURRENT atoms

Ops:
  wi --health                    — system health report
  wi --rollback <run_id>         — undo a specific run
  wi --rollback-source <url>     — undo all runs for a URL
    `);
    process.exit(0);
  }

  const dryRun = hasFlag("dry-run");
  const force = hasFlag("force");
  const refreshDays = getFlagValue("refresh") ? parseInt(getFlagValue("refresh")!) : undefined;

  console.log(`\n🌍 World Ingestor${dryRun ? " (DRY RUN)" : ""}\n`);
  console.log(`  URL: ${url}`);

  try {
    const result = await runPipeline(url, { dryRun, force, refreshDays });
    console.log(`\n  ✅ ${result.status.toUpperCase()}  run_id=${result.runId}\n`);
  } catch (err: any) {
    console.error(`\n  ❌ ${err.message}\n`);

    // Update source_history on failure
    if (!dryRun) {
      await markWISourceHistoryFailed({
        sourceId: url,
        lastError: err.message,
      }).catch(() => {});

      emitWI("error", "unknown", { message: err.message, stage: "pipeline" });
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
