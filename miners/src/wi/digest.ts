/**
 * World Ingestor V2 — Daily Digest + Alert System.
 * - formatDailyDigest() — aggregate 24h stats, format Discord message
 * - checkAlerts() — failure rate >30%, avg >30s, queue >50, stale reviewer
 */

import { sql } from "./config";

// ============================================================
// DISCORD WEBHOOK
// ============================================================

async function getDiscordWebhook(): Promise<string | null> {
  try {
    const [row] = await sql`SELECT value FROM graph_state WHERE key = 'wi_discord_webhook'`;
    return row?.value || null;
  } catch {
    return null;
  }
}

async function postDiscord(message: string): Promise<void> {
  const webhook = await getDiscordWebhook();
  if (!webhook) {
    console.log("[WI Digest] No Discord webhook configured — printing to stdout");
    console.log(message);
    return;
  }
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (err: any) {
    console.error(`[WI Digest] Discord post failed: ${err.message}`);
  }
}

// ============================================================
// DAILY DIGEST
// ============================================================

export async function formatDailyDigest(): Promise<string> {
  const [stats] = await sql`
    SELECT
      COUNT(*) AS total_runs,
      COUNT(*) FILTER (WHERE status = 'done') AS succeeded,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COALESCE(SUM(atoms_extracted), 0) AS atoms,
      COALESCE(SUM(atoms_new_node), 0) AS new_nodes,
      COALESCE(SUM(atoms_heat), 0) AS heat,
      COALESCE(SUM(atoms_skill), 0) AS skills_proposed,
      COALESCE(SUM(atoms_drop), 0) AS drops,
      COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost,
      COALESCE(AVG(elapsed_ms), 0)::int AS avg_ms,
      MIN(created_at) AS earliest,
      MAX(created_at) AS latest
    FROM wi_runs
    WHERE created_at > now() - interval '24 hours'
  `;

  const [skillStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active') AS active_skills,
      COUNT(*) FILTER (WHERE status = 'proposed' OR status = 'needs_human') AS pending_review,
      COUNT(*) FILTER (WHERE status = 'rejected' AND reviewed_at > now() - interval '24 hours') AS rejected_today,
      COUNT(*) FILTER (WHERE status = 'retired' AND retired_at > now() - interval '24 hours') AS retired_today
    FROM wi_skill_proposals
  `;

  const [queueStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM wi_queue
  `;

  // Source type breakdown
  const sourceBreakdown = await sql`
    SELECT source_type, COUNT(*) AS count
    FROM wi_runs
    WHERE created_at > now() - interval '24 hours'
    GROUP BY source_type
    ORDER BY count DESC
  `;

  const sourceStr = sourceBreakdown.map(s => `${s.source_type}: ${s.count}`).join(" | ") || "none";

  const successRate = parseInt(stats.total_runs) > 0
    ? (parseInt(stats.succeeded) / parseInt(stats.total_runs) * 100).toFixed(0)
    : "N/A";

  // Enrichment pool stats
  let poolStr = "";
  try {
    const [pool] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'enriched') AS enriched,
        COUNT(*) FILTER (WHERE status = 'routed') AS routed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM wi_atom_pool
      WHERE created_at > now() - interval '24 hours'
    `;
    poolStr = `\n**Pool (24h):** ${pool.pending} pending, ${pool.enriched} enriched, ${pool.routed} routed, ${pool.failed} failed`;
  } catch { /* table may not exist */ }

  const digest = `📊 **World Ingestor — Daily Digest**

**Runs:** ${stats.total_runs} (${stats.succeeded} ok, ${stats.failed} failed — ${successRate}% success)
**Atoms:** ${stats.atoms} extracted → ${stats.new_nodes} new nodes, ${stats.heat} heat, ${stats.skills_proposed} skill proposals, ${stats.drops} drops
**Cost:** $${stats.cost} | **Avg speed:** ${stats.avg_ms}ms/run
**Sources:** ${sourceStr}

**Skills:** ${skillStats.active_skills} active, ${skillStats.pending_review} pending review, ${skillStats.rejected_today} rejected today, ${skillStats.retired_today} retired today
**Queue:** ${queueStats.pending} pending, ${queueStats.failed} failed${poolStr}`;

  return digest;
}

export async function sendDailyDigest(): Promise<void> {
  const digest = await formatDailyDigest();
  await postDiscord(digest);
}

// ============================================================
// ALERTS — check every 10 min
// ============================================================

export async function checkAlerts(): Promise<string[]> {
  const alerts: string[] = [];

  // 1. Failure rate > 30% in last hour
  const [hourlyStats] = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM wi_runs
    WHERE created_at > now() - interval '1 hour'
  `;
  const total = parseInt(hourlyStats.total);
  const failed = parseInt(hourlyStats.failed);
  if (total >= 3 && (failed / total) > 0.3) {
    alerts.push(`🔴 **High failure rate:** ${failed}/${total} runs failed in the last hour (${(failed/total*100).toFixed(0)}%)`);
  }

  // 2. Flash Lite avg > 30s
  const [avgLatency] = await sql`
    SELECT COALESCE(AVG(elapsed_ms), 0)::int AS avg_ms
    FROM wi_runs
    WHERE created_at > now() - interval '1 hour' AND status = 'done'
  `;
  if (parseInt(avgLatency.avg_ms) > 30_000) {
    alerts.push(`🟡 **Slow pipeline:** Avg run time ${avgLatency.avg_ms}ms in last hour (threshold: 30s)`);
  }

  // 3. Queue depth > 50
  const [qDepth] = await sql`
    SELECT COUNT(*) AS pending FROM wi_queue WHERE status = 'pending'
  `;
  if (parseInt(qDepth.pending) > 50) {
    alerts.push(`🟠 **Queue backlog:** ${qDepth.pending} pending items`);
  }

  // 4. Enrichment pool backlog
  try {
    const [poolDepth] = await sql`
      SELECT COUNT(*) AS pending FROM wi_atom_pool WHERE status = 'pending'
    `;
    if (parseInt(poolDepth.pending) > 500) {
      alerts.push(`🟠 **Pool backlog:** ${poolDepth.pending} atoms pending enrichment`);
    }
  } catch { /* table may not exist */ }

  // 5. Skill auto-reviewer stale > 2h (proposed skills not picked up)
  const [staleReview] = await sql`
    SELECT COUNT(*) AS stale FROM wi_skill_proposals
    WHERE status = 'proposed' AND created_at < now() - interval '2 hours'
  `;
  if (parseInt(staleReview.stale) > 0) {
    alerts.push(`🟡 **Skill reviewer stale:** ${staleReview.stale} proposals pending > 2 hours`);
  }

  // Post alerts to Discord
  if (alerts.length > 0) {
    await postDiscord("⚠️ **WI Alerts**\n\n" + alerts.join("\n"));
  }

  return alerts;
}
