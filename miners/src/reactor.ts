/**
 * Resonance Reactor — Process stimuli into node heat contributions
 *
 * Takes pending stimuli, finds which nodes they match via embedding similarity,
 * creates heat contributions, detects conflicts and supersessions.
 *
 * Usage:
 *   bun run miners/src/reactor.ts --process-pending
 *   bun run miners/src/reactor.ts --process-pending --dry-run
 *   bun run miners/src/reactor.ts --process-one 42 [--skip-maintain]
 *   bun run miners/src/reactor.ts --refresh-heat
 *   bun run miners/src/reactor.ts --watch
 *   bun run miners/src/reactor.ts --stats
 */

import postgres from "postgres";
import { toVectorStr } from "@verity-one/embed";
import { startWorkerHeartbeat, type WorkerHeartbeatHandle } from "./lib/worker-heartbeat";
import { closeTrendService, getTrendContributionOverrides, getTrendHeatBudget, runTrendMaintenance } from "./trends/service";

const sql = postgres(process.env.DATABASE_URL || "postgresql://localhost:5432/verity");
const DRY_RUN = process.argv.includes("--dry-run");
let configLoaded = false;
const REACTOR_LOCK_ID = 43;
let reactorLockAcquired = false;
let shouldStop = false;
let reactorHeartbeat: WorkerHeartbeatHandle | null = null;

// ============================================================
// Startup cache
// ============================================================

let totalNodeCount = 0;
let relevanceFloor = 0.55;
let reactorPolicy = {
  sourceBurstWindowMinutes: 60,
  sourceBurstSoftCap: 6,
  sourceBurstFloor: 0.35,
  sameSourceNodeWindowHours: 12,
  sameSourceNodeSoftCap: 2,
  sameSourceNodeFloor: 0.40,
  noveltyWindowHours: 24,
  noveltyNewSourceBoost: 1.10,
  noveltyRepeatSourcePenalty: 0.85,
};

async function loadConfig() {
  const [countRow] = await sql`SELECT COUNT(*)::int as n FROM nodes WHERE visibility = 'public'`;
  totalNodeCount = countRow.n;

  const configRows = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key = ANY(${[
      "relevance_floor",
      "reactor_source_burst_window_minutes",
      "reactor_source_burst_soft_cap",
      "reactor_source_burst_floor",
      "reactor_same_source_node_window_hours",
      "reactor_same_source_node_soft_cap",
      "reactor_same_source_node_floor",
      "reactor_novelty_window_hours",
      "reactor_novelty_new_source_boost",
      "reactor_novelty_repeat_source_penalty",
    ]}::text[])
  `;
  const configMap = new Map<string, string>(configRows.map((row: any) => [row.key, row.value]));
  const floorRaw = configMap.get("relevance_floor");
  if (floorRaw) relevanceFloor = parseFloat(floorRaw);
  reactorPolicy = {
    sourceBurstWindowMinutes: parseFloat(configMap.get("reactor_source_burst_window_minutes") || String(reactorPolicy.sourceBurstWindowMinutes)),
    sourceBurstSoftCap: parseFloat(configMap.get("reactor_source_burst_soft_cap") || String(reactorPolicy.sourceBurstSoftCap)),
    sourceBurstFloor: parseFloat(configMap.get("reactor_source_burst_floor") || String(reactorPolicy.sourceBurstFloor)),
    sameSourceNodeWindowHours: parseFloat(configMap.get("reactor_same_source_node_window_hours") || String(reactorPolicy.sameSourceNodeWindowHours)),
    sameSourceNodeSoftCap: parseFloat(configMap.get("reactor_same_source_node_soft_cap") || String(reactorPolicy.sameSourceNodeSoftCap)),
    sameSourceNodeFloor: parseFloat(configMap.get("reactor_same_source_node_floor") || String(reactorPolicy.sameSourceNodeFloor)),
    noveltyWindowHours: parseFloat(configMap.get("reactor_novelty_window_hours") || String(reactorPolicy.noveltyWindowHours)),
    noveltyNewSourceBoost: parseFloat(configMap.get("reactor_novelty_new_source_boost") || String(reactorPolicy.noveltyNewSourceBoost)),
    noveltyRepeatSourcePenalty: parseFloat(configMap.get("reactor_novelty_repeat_source_penalty") || String(reactorPolicy.noveltyRepeatSourcePenalty)),
  };

  console.log(`[REACTOR] Config: ${totalNodeCount} public nodes, relevance floor=${relevanceFloor}`);
  configLoaded = true;
}

async function ensureConfigLoaded() {
  if (!configLoaded) {
    await loadConfig();
  }
}

async function tryAcquireReactorLock(): Promise<boolean> {
  const [result] = await sql`SELECT pg_try_advisory_lock(${REACTOR_LOCK_ID}) as acquired`;
  reactorLockAcquired = Boolean(result?.acquired);
  return reactorLockAcquired;
}

async function releaseReactorLock(): Promise<void> {
  if (!reactorLockAcquired) return;
  await sql`SELECT pg_advisory_unlock(${REACTOR_LOCK_ID})`;
  reactorLockAcquired = false;
}

function readIntFlag(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const raw = parseInt(process.argv[idx + 1] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWorkCounts(): Promise<{ pendingStimuli: number; protoClusters: number; liveTrends: number }> {
  const [row] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM stimuli WHERE processed = false) as pending_stimuli,
      (SELECT COUNT(*)::int FROM wi_proto_clusters) as proto_clusters,
      (SELECT COUNT(*)::int FROM nodes WHERE node_type = 'trend') as live_trends
  `;
  return {
    pendingStimuli: row.pending_stimuli,
    protoClusters: row.proto_clusters,
    liveTrends: row.live_trends,
  };
}

function registerShutdownSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shouldStop = true;
      console.log(`[REACTOR] Received ${signal}, shutting down after current cycle...`);
    });
  }
}

// ============================================================
// Channel mapping
// ============================================================

const CHANNEL_MAP: Record<string, string> = {
  security_alert: "confidence",
  research_paper: "confidence",
  agent_success: "confidence",
  agent_failure: "confidence",
  news_article: "relevance",
  tool_release: "relevance",
  market_move: "interest",
  agent_query: "interest",
};

// ============================================================
// Core: processStimulus
// ============================================================

export async function processStimulus(stimulusId: number): Promise<void> {
  await ensureConfigLoaded();
  // 1. Load stimulus. F11: read correlation_id so we can copy it into every
  // contribution row written for this stimulus.
  const [stim] = await sql`
    SELECT id, content, embedding, source, origin_key, stimulus_type, urgency,
           decay_halflife_hours, peak_delay_hours, correlation_id, space_id
    FROM stimuli WHERE id = ${stimulusId}
  `;
  if (!stim) {
    console.error(`[REACTOR] Stimulus #${stimulusId} not found`);
    return;
  }
  if (!stim.embedding) {
    console.error(`[REACTOR] Stimulus #${stimulusId} has no embedding, skipping`);
    await sql`UPDATE stimuli SET processed = true, processed_at = now() WHERE id = ${stimulusId}`;
    return;
  }

  const preview = stim.content.slice(0, 60).replace(/\n/g, " ");
  const matchLimit = Math.min(20, Math.ceil(Math.sqrt(totalNodeCount)));
  const originIdentity = stim.origin_key || stim.source;
  const stimulusSpaceId = stim.space_id || "global";

  // 2. Match nodes by vector similarity
  const vectorStr = stim.embedding; // already stored as halfvec string
  const matches = await sql`
    SELECT addr, label, node_type, source_context,
      substance->>'description' as description,
      COALESCE((substance->'domains'->>0), 'general') as domain,
      COALESCE((substance->>'connectivity')::numeric, 0) as connectivity,
      1 - (embedding_hv <=> ${vectorStr}::halfvec) as similarity
    FROM nodes
    WHERE embedding_hv IS NOT NULL
      AND visibility = 'public'
      AND COALESCE(space_id, 'global') = ${stimulusSpaceId}
    ORDER BY embedding_hv <=> ${vectorStr}::halfvec
    LIMIT ${matchLimit}
  `;

  // 3. Filter by relevance floor
  const aboveFloor = matches.filter((m: any) => parseFloat(m.similarity) >= relevanceFloor);

  if (DRY_RUN) {
    console.log(`[REACTOR] DRY #${stimulusId} "${preview}..." → ${matches.length} candidates, ${aboveFloor.length} above floor`);
    for (const m of aboveFloor) {
      console.log(`  ${m.addr} ${m.label} sim=${parseFloat(m.similarity).toFixed(3)} domain=${m.domain}`);
    }
    return;
  }

  // 4-6. Compute and insert contributions
  let contributionCount = 0;
  const touchedNodes: string[] = [];
  const uniqueDomains = [...new Set(aboveFloor.map((m: any) => String(m.domain)))];
  const matchAddrs = [...new Set(aboveFloor.map((m: any) => String(m.addr)))];
  const authorityRows = uniqueDomains.length > 0
    ? await sql`
        SELECT domain, authority
        FROM source_domain_authority
        WHERE source = ${stim.source}
          AND domain = ANY(${uniqueDomains}::text[])
      `
    : [];
  const authorityByDomain = new Map<string, number>(
    authorityRows.map((row: any) => [String(row.domain), parseFloat(row.authority)]),
  );
  const [sourceBurstRow] = await sql`
    SELECT COUNT(*)::int as n
    FROM stimuli
    WHERE COALESCE(origin_key, source) = ${originIdentity}
      AND COALESCE(space_id, 'global') = ${stimulusSpaceId}
      AND id != ${stimulusId}
      AND created_at > now() - (${reactorPolicy.sourceBurstWindowMinutes} * interval '1 minute')
  `;
  const recentSourceStimulusCount = parseInt(sourceBurstRow?.n || 0);
  const sourceBurstFactor = recentSourceStimulusCount + 1 <= reactorPolicy.sourceBurstSoftCap
    ? 1
    : Math.max(reactorPolicy.sourceBurstFloor, reactorPolicy.sourceBurstSoftCap / (recentSourceStimulusCount + 1));
  const trendOverridesByAddr = new Map<string, { halflifeHours: number; peakDelayHours: number } | null>();
  const trendMatches = aboveFloor.filter((m: any) => m.node_type === "trend");
  const trendHeatBudget = trendMatches.length > 0 ? await getTrendHeatBudget() : null;
  for (const match of trendMatches) {
    if (!trendOverridesByAddr.has(match.addr)) {
      trendOverridesByAddr.set(match.addr, await getTrendContributionOverrides(match.addr));
    }
  }

  if (aboveFloor.length > 0) {
    await sql.begin(async (tx: any) => {
      // F11: one heat-lock critical section per stimulus. A per-row lock lets
      // refresh_stimulus_heat() snapshot a partially processed stimulus between
      // contribution inserts; holding the xact lock for this phase keeps the
      // writer side coherent while refresh callers skip on lock miss.
      await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;

      const heatRows = matchAddrs.length > 0
        ? await tx`
            SELECT node_addr, COALESCE(SUM(contribution), 0) as current_heat
            FROM stimulus_contributions
            WHERE node_addr = ANY(${matchAddrs}::text[])
              AND contribution > 0.001
            GROUP BY node_addr
          `
        : [];
      const currentHeatByAddr = new Map<string, number>(
        heatRows.map((row: any) => [String(row.node_addr), parseFloat(row.current_heat)]),
      );
      const recentSignalRows = matchAddrs.length > 0
        ? await tx`
            SELECT
              sc.node_addr,
              COUNT(DISTINCT sc.stimulus_id) FILTER (
                WHERE COALESCE(s.origin_key, s.source) = ${originIdentity}
                  AND sc.created_at > now() - (${reactorPolicy.sameSourceNodeWindowHours} * interval '1 hour')
              )::int as same_source_hits,
              COUNT(DISTINCT COALESCE(s.origin_key, s.source)) FILTER (
                WHERE sc.created_at > now() - (${reactorPolicy.noveltyWindowHours} * interval '1 hour')
              )::int as distinct_sources
            FROM stimulus_contributions sc
            JOIN stimuli s ON s.id = sc.stimulus_id
            WHERE sc.node_addr = ANY(${matchAddrs}::text[])
            GROUP BY sc.node_addr
          `
        : [];
      const recentSignalByAddr = new Map<string, { sameSourceHits: number; distinctSources: number }>(
        recentSignalRows.map((row: any) => [
          String(row.node_addr),
          {
            sameSourceHits: parseInt(row.same_source_hits || 0),
            distinctSources: parseInt(row.distinct_sources || 0),
          },
        ]),
      );

      for (const match of aboveFloor) {
        const similarity = parseFloat(match.similarity);
        const domain = match.domain;
        const isTrend = match.node_type === "trend";

        // Look up authority
        const authority = authorityByDomain.get(String(domain)) ?? 0.5;

        const signalState = recentSignalByAddr.get(match.addr) || { sameSourceHits: 0, distinctSources: 0 };
        const sameSourceFactor = signalState.sameSourceHits + 1 <= reactorPolicy.sameSourceNodeSoftCap
          ? 1
          : Math.max(
              reactorPolicy.sameSourceNodeFloor,
              reactorPolicy.sameSourceNodeSoftCap / (signalState.sameSourceHits + 1),
            );
        const noveltyFactor = signalState.sameSourceHits === 0 && signalState.distinctSources > 0
          ? reactorPolicy.noveltyNewSourceBoost
          : signalState.sameSourceHits > 0
            ? reactorPolicy.noveltyRepeatSourcePenalty
            : 1;
        const relevanceScore = similarity
          * authority
          * parseFloat(stim.urgency)
          * sourceBurstFactor
          * sameSourceFactor
          * noveltyFactor;
        const channel = CHANNEL_MAP[stim.stimulus_type] || "relevance";

        // 5. Budget check — cap contribution to available budget
        // Get node's connectivity to determine budget
        const connectivity = parseFloat(match.connectivity || 0);
        let budget = connectivity > 0.8 ? 0.05 : 0.10;
        if (isTrend) {
          budget = trendHeatBudget ?? budget;
        }

        const trendOverrides = isTrend
          ? (trendOverridesByAddr.get(match.addr) ?? null)
          : null;

        // Get current heat total for this node
        const currentHeat = currentHeatByAddr.get(match.addr) ?? 0;
        const remainingBudget = budget - currentHeat;

        if (remainingBudget <= 0.001) {
          // Node at budget — try displacement inside the heat critical section.
          const [displaced] = await tx`SELECT displace_lowest_priority(${match.addr}, ${relevanceScore}) as displaced_id`;
          if (displaced.displaced_id != null) {
            // Recalculate remaining after displacement
            const [newHeat] = await tx`
              SELECT COALESCE(SUM(contribution), 0) as h FROM stimulus_contributions WHERE node_addr = ${match.addr} AND contribution > 0.001
            `;
            const newRemaining = budget - parseFloat(newHeat.h);
            if (newRemaining <= 0.001) continue; // still no room, skip
            const cappedContribution = Math.min(relevanceScore, newRemaining);
            await tx`
              INSERT INTO stimulus_contributions (
                stimulus_id, node_addr, channel, contribution, base_contribution, relevance, urgency,
                decay_halflife_hours_override, peak_delay_hours_override, correlation_id
              )
              VALUES (
                ${stimulusId}, ${match.addr}, ${channel}, ${cappedContribution}, ${cappedContribution}, ${similarity}, ${stim.urgency},
                ${trendOverrides?.halflifeHours ?? null}, ${trendOverrides?.peakDelayHours ?? null},
                ${stim.correlation_id ?? null}
              )
              ON CONFLICT (stimulus_id, node_addr) DO NOTHING
            `;
            currentHeatByAddr.set(match.addr, parseFloat(newHeat.h) + cappedContribution);
            console.log(`  [DISPLACE] Node ${match.addr}: displaced #${displaced.displaced_id}, capped contribution ${cappedContribution.toFixed(4)}`);
            contributionCount++;
            touchedNodes.push(match.addr);
          } else {
            continue; // can't displace (all higher priority), skip this node
          }
        } else {
          // Under budget — cap to remaining
          const cappedContribution = Math.min(relevanceScore, remainingBudget);

          // 6. Insert contribution. F11: heat advisory lock + correlation_id copy.
          await tx`
            INSERT INTO stimulus_contributions (
              stimulus_id, node_addr, channel, contribution, base_contribution, relevance, urgency,
              decay_halflife_hours_override, peak_delay_hours_override, correlation_id
            )
            VALUES (
              ${stimulusId}, ${match.addr}, ${channel}, ${cappedContribution}, ${cappedContribution}, ${similarity}, ${stim.urgency},
              ${trendOverrides?.halflifeHours ?? null}, ${trendOverrides?.peakDelayHours ?? null},
              ${stim.correlation_id ?? null}
            )
            ON CONFLICT (stimulus_id, node_addr) DO NOTHING
          `;
          currentHeatByAddr.set(match.addr, currentHeat + cappedContribution);
          contributionCount++;
          touchedNodes.push(match.addr);
        }
      }
    });
  }

  // 7. Conflict detection — only flag agent_failure/agent_success pairs, or high urgency gap
  // Normal: multiple HN/arXiv stories touching same node = expected, not a conflict
  // Conflict: agent_failure after agent_success on same node, or urgency gap > 0.4 (same source)
  const isFailureType = stim.stimulus_type === 'agent_failure';
  const isSuccessType = stim.stimulus_type === 'agent_success';
  
  if (isFailureType || isSuccessType) {
    const oppositeType = isFailureType ? 'agent_success' : 'agent_failure';
    for (const nodeAddr of touchedNodes) {
      const conflicts = await sql`
        SELECT sc.stimulus_id FROM stimulus_contributions sc
        JOIN stimuli s ON s.id = sc.stimulus_id
        WHERE sc.node_addr = ${nodeAddr} AND sc.stimulus_id != ${stimulusId}
          AND s.stimulus_type = ${oppositeType}
          AND sc.created_at > now() - interval '24 hours'
      `;
      for (const c of conflicts) {
        await sql`
          INSERT INTO stimulus_conflicts (node_addr, stimulus_a, stimulus_b, conflict_type)
          VALUES (${nodeAddr}, ${c.stimulus_id}, ${stimulusId}, 'same_source_divergence')
          ON CONFLICT DO NOTHING
        `;
      }
    }
  }

  // 8. Supersession detection
  const similar = await sql`
    SELECT id, content, 1 - (embedding <=> ${vectorStr}::vector) as sim
    FROM stimuli
    WHERE id != ${stimulusId} AND processed = true
      AND COALESCE(space_id, 'global') = ${stimulusSpaceId}
      AND created_at > now() - interval '7 days'
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT 5
  `;

  for (const s of similar) {
    const sim = parseFloat(s.sim);
    if (sim <= 0.85) continue;

    // Count overlapping node matches
    const [overlapRow] = await sql`
      SELECT COUNT(*)::int as cnt FROM stimulus_contributions
      WHERE stimulus_id = ${s.id} AND node_addr = ANY(${touchedNodes})
    `;
    const overlapCount = overlapRow.cnt;

    // Get total nodes the older stimulus touched
    const [olderTotal] = await sql`
      SELECT COUNT(*)::int as cnt FROM stimulus_contributions WHERE stimulus_id = ${s.id}
    `;
    const overlapPct = olderTotal.cnt > 0 ? overlapCount / olderTotal.cnt : 0;

    if (overlapPct <= 0.6) continue;

    // Determine detection method
    const hasExplicitMarker = /(patch|fix|supersed|correct|retract|update[ds]?)\b/i.test(stim.content) && sim > 0.80;
    let detectionMethod: string;

    if (hasExplicitMarker) {
      detectionMethod = "explicit_marker";
    } else if (stim.source === s.source) {
      detectionMethod = "same_source_update";
    } else {
      detectionMethod = "embedding_similarity";
    }

    // Insert supersession candidate
    await sql`
      INSERT INTO supersession_candidates (newer_stimulus_id, older_stimulus_id, similarity, node_overlap_pct, detection_method, status, resolved_by)
      VALUES (
        ${stimulusId}, ${s.id}, ${sim}, ${overlapPct}, ${detectionMethod},
        ${hasExplicitMarker ? "confirmed" : "pending"},
        ${hasExplicitMarker ? "auto" : null}
      )
    `;

    // Auto-confirm: zero out older stimulus contributions. This mutates the
    // same heat source table refresh_stimulus_heat() snapshots, so hold the
    // F11 heat writer lock for the update.
    if (hasExplicitMarker) {
      await sql.begin(async (tx: any) => {
        await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
        await tx`UPDATE stimulus_contributions SET contribution = 0 WHERE stimulus_id = ${s.id}`;
      });
      console.log(`  [SUPERSEDE] Stimulus #${s.id} auto-superseded by #${stimulusId} (${detectionMethod})`);
    } else {
      console.log(`  [SUPERSEDE?] Candidate: #${stimulusId} may supersede #${s.id} (${detectionMethod}, sim=${sim.toFixed(3)}, overlap=${(overlapPct * 100).toFixed(0)}%)`);
    }
  }

  // 9. Mark processed
  await sql`UPDATE stimuli SET processed = true, processed_at = now() WHERE id = ${stimulusId}`;
  await sql`UPDATE graph_state SET value = (value::int + 1)::text WHERE key = 'total_stimuli_processed'`;

  console.log(`[REACTOR] Processed #${stimulusId} "${preview}..." → matched ${matches.length} nodes (${aboveFloor.length} above floor), created ${contributionCount} contributions`);
}

// ============================================================
// Atom feedback accumulator — update query_hits from query_log
// ============================================================

async function updateAtomFeedback(): Promise<void> {
  const [lastRun] = await sql`
    SELECT value FROM graph_state WHERE key = 'atom_feedback_last_sync'`;
  const since = lastRun?.value ?? '2026-01-01T00:00:00Z';

  const recentQueries = await sql`
    SELECT returned_addrs, created_at FROM query_log
    WHERE created_at > ${since}::timestamptz AND returned_addrs IS NOT NULL`;

  if (recentQueries.length === 0) return;

  // Collect all queried addresses with hit counts (top-3 results count double)
  const addrHits: Map<string, number> = new Map();
  for (const q of recentQueries) {
    const raw = q.returned_addrs;
    const addrs: string[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
    for (let idx = 0; idx < addrs.length; idx++) {
      const addr = addrs[idx];
      const weight = idx < 3 ? 2 : 1;
      addrHits.set(addr, (addrHits.get(addr) || 0) + weight);
    }
  }

  // Batch update atom_feedback — increment query_hits
  for (const [addr, hits] of addrHits) {
    await sql`
      UPDATE atom_feedback
      SET query_hits = query_hits + ${hits}
      WHERE node_addr = ${addr}`;
  }

  // Update sync cursor (normalize Date objects to ISO strings for safe comparison)
  const maxTime = recentQueries.reduce((max, q) => {
    const ts = q.created_at instanceof Date ? q.created_at.toISOString() : String(q.created_at);
    return ts > max ? ts : max;
  }, since);
  await sql`
    INSERT INTO graph_state (key, value) VALUES ('atom_feedback_last_sync', ${maxTime})
    ON CONFLICT (key) DO UPDATE SET value = ${maxTime}`;

  console.log(`[FEEDBACK] Updated ${addrHits.size} atom feedback entries from ${recentQueries.length} queries`);
}

/**
 * F11: Promote stimulus orphans out of throbbing.
 *
 * Three transitions:
 *   - throbbing + age > 14d + parent stimulus has matched node → adopted
 *   - throbbing + age > 14d + no progress (no edges, no matched node) → dissolved
 *   - throbbing + age > 30d (catch-all) → dissolved
 *
 * The throbbing → promoted transition stays manual — promotion creates a new
 * node and that decision belongs to QC sentinel / operator review.
 *
 * Each transition class is capped to 100 rows per cycle to avoid lock
 * starvation.
 */
async function promoteOrphans(): Promise<{ adopted: number; dissolved: number }> {
  const PROMOTE_CAP = 100;

  const adopted = await sql`
    WITH adoptable AS (
      SELECT s.id, s.parent_stimulus_id, p.node_addr AS parent_node, s.correlation_id
      FROM stimuli s
      JOIN stimuli p ON p.id = s.parent_stimulus_id
      WHERE s.is_orphan = true
        AND s.orphan_status = 'throbbing'
        AND s.created_at < now() - interval '14 days'
        AND p.node_addr IS NOT NULL
      ORDER BY s.created_at ASC
      LIMIT ${PROMOTE_CAP}
    )
    UPDATE stimuli s
    SET orphan_status = 'adopted', node_addr = a.parent_node
    FROM adoptable a
    WHERE s.id = a.id
    RETURNING s.id, s.correlation_id
  `;

  const dissolved14 = await sql`
    WITH dissolvable AS (
      SELECT s.id, s.correlation_id
      FROM stimuli s
      WHERE s.is_orphan = true
        AND s.orphan_status = 'throbbing'
        AND s.created_at < now() - interval '14 days'
        AND s.parent_stimulus_id IS NULL
        AND s.node_addr IS NULL
      ORDER BY s.created_at ASC
      LIMIT ${PROMOTE_CAP}
    )
    UPDATE stimuli s
    SET orphan_status = 'dissolved'
    FROM dissolvable d
    WHERE s.id = d.id
    RETURNING s.id, s.correlation_id
  `;

  const dissolved30 = await sql`
    WITH dissolvable AS (
      SELECT s.id, s.correlation_id
      FROM stimuli s
      WHERE s.is_orphan = true
        AND s.orphan_status = 'throbbing'
        AND s.created_at < now() - interval '30 days'
      ORDER BY s.created_at ASC
      LIMIT ${PROMOTE_CAP}
    )
    UPDATE stimuli s
    SET orphan_status = 'dissolved'
    FROM dissolvable d
    WHERE s.id = d.id
    RETURNING s.id, s.correlation_id
  `;

  for (const row of adopted) {
    const cid = row.correlation_id ? ` correlation_id=${row.correlation_id}` : "";
    console.log(`[reactor:orphan] adopted stimulus #${row.id}${cid}`);
  }
  for (const row of dissolved14) {
    const cid = row.correlation_id ? ` correlation_id=${row.correlation_id}` : "";
    console.log(`[reactor:orphan] dissolved (14d, no progress) stimulus #${row.id}${cid}`);
  }
  for (const row of dissolved30) {
    const cid = row.correlation_id ? ` correlation_id=${row.correlation_id}` : "";
    console.log(`[reactor:orphan] dissolved (30d catch-all) stimulus #${row.id}${cid}`);
  }

  return {
    adopted: adopted.length,
    dissolved: dissolved14.length + dissolved30.length,
  };
}

async function runMaintenanceCycle(options: { includeAnalytics?: boolean } = {}): Promise<void> {
  if (DRY_RUN) {
    console.log("[REACTOR] Dry run maintenance skipped");
    return;
  }

  // Heat refresh, lifecycle, source analytics, and atom feedback
  // are now handled by supercron. Reactor only owns trend maintenance
  // and (F11) orphan promotion.

  const orphans = await promoteOrphans();
  if (orphans.adopted > 0 || orphans.dissolved > 0) {
    console.log(`[reactor:orphan] cycle: adopted=${orphans.adopted} dissolved=${orphans.dissolved}`);
  }

  const trendMaintenance = await runTrendMaintenance();
  if (
    trendMaintenance.expiredOrphans > 0
    || trendMaintenance.clusteredStandalones > 0
    || trendMaintenance.birthed > 0
    || trendMaintenance.adopted > 0
    || trendMaintenance.archived > 0
    || trendMaintenance.cleanedEdges > 0
    || trendMaintenance.duplicateCandidates > 0
  ) {
    console.log(
      `[TRENDS] expired=${trendMaintenance.expiredOrphans} clustered=${trendMaintenance.clusteredStandalones} birthed=${trendMaintenance.birthed} adopted=${trendMaintenance.adopted} archived=${trendMaintenance.archived} synced=${trendMaintenance.synced} cleaned_edges=${trendMaintenance.cleanedEdges} duplicate_candidates=${trendMaintenance.duplicateCandidates}`,
    );
  }
}

// ============================================================
// Process all pending stimuli
// ============================================================

async function fetchPendingStimulusIds(limit: number): Promise<number[]> {
  const rows = await sql`
    SELECT id
    FROM stimuli
    WHERE processed = false
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row: any) => row.id);
}

export async function processPending(options: {
  batchSize?: number;
  maxBatches?: number;
} = {}): Promise<{ processed: number; batches: number; remaining: number }> {
  await ensureConfigLoaded();
  const batchSize = Math.max(1, options.batchSize ?? readIntFlag("--batch-size", 100));
  const maxBatches = options.maxBatches;
  let processed = 0;
  let batches = 0;
  let batch = await fetchPendingStimulusIds(batchSize);

  if (batch.length === 0) {
    console.log("[REACTOR] No pending stimuli");
    return { processed: 0, batches: 0, remaining: 0 };
  }

  console.log(`[REACTOR] Processing pending stimuli in batches of ${batchSize}${maxBatches ? ` (max ${maxBatches} batches this run)` : ""}...`);

  while (batch.length > 0) {
    for (const stimulusId of batch) {
      await processStimulus(stimulusId);
      processed++;
    }
    batches++;

    const hitBatchLimit = maxBatches != null && batches >= maxBatches;
    const nextBatch = hitBatchLimit ? [] : await fetchPendingStimulusIds(batchSize);
    if (!DRY_RUN) {
      await runMaintenanceCycle({ includeAnalytics: !hitBatchLimit && nextBatch.length === 0 });
    }
    if (hitBatchLimit) break;
    batch = nextBatch;
  }

  const [remainingRow] = await sql`
    SELECT COUNT(*)::int as n
    FROM stimuli
    WHERE processed = false
  `;
  console.log(`[REACTOR] Pending processing complete: processed=${processed} batches=${batches} remaining=${remainingRow.n}`);
  return { processed, batches, remaining: remainingRow.n };
}

async function runWatchLoop(): Promise<void> {
  const intervalMs = readIntFlag("--interval-seconds", 30) * 1000;
  const batchSize = readIntFlag("--batch-size", 100);
  const maxBatchesPerCycle = readIntFlag("--max-batches-per-cycle", 5);
  reactorHeartbeat = startWorkerHeartbeat({
    sql,
    workerName: "reactor",
    role: "reactor",
    mode: "watch",
    heartbeatIntervalMs: Math.min(15_000, intervalMs),
    staleAfterMs: Math.max(intervalMs * 2, 60_000),
    metadata: {
      batch_size: batchSize,
      interval_seconds: intervalMs / 1000,
      max_batches_per_cycle: maxBatchesPerCycle,
    },
  });
  registerShutdownSignals();
  console.log(`[REACTOR] Watch mode started (interval=${intervalMs / 1000}s batch_size=${batchSize} max_batches_per_cycle=${maxBatchesPerCycle})`);

  while (!shouldStop) {
    const acquired = await tryAcquireReactorLock();
    if (!acquired) {
      console.log("[REACTOR] Another maintenance worker holds the lock. Waiting for next cycle.");
      await reactorHeartbeat.beat({
        status: "idle",
        metadata: {
          lock_wait: true,
          processed_in_cycle: 0,
          batches_in_cycle: 0,
          maintenance_cycle: false,
        },
      });
      await sleep(intervalMs);
      continue;
    }

    try {
      const work = await getWorkCounts();
      await reactorHeartbeat.beat({
        status: work.pendingStimuli > 0 || work.protoClusters > 0 || work.liveTrends > 0 ? "running" : "idle",
        metadata: {
          pending_stimuli: work.pendingStimuli,
          proto_clusters: work.protoClusters,
          live_trends: work.liveTrends,
          lock_wait: false,
          processed_in_cycle: 0,
          batches_in_cycle: 0,
          maintenance_cycle: false,
        },
      });
      if (work.pendingStimuli > 0) {
        console.log(`[REACTOR] Watch cycle: processing ${work.pendingStimuli} pending stimuli`);
        const result = await processPending({ batchSize, maxBatches: maxBatchesPerCycle });
        await reactorHeartbeat.beat({
          status: result.remaining > 0 ? "running" : "idle",
          metadata: {
            pending_stimuli: result.remaining,
            processed_in_cycle: result.processed,
            batches_in_cycle: result.batches,
            maintenance_cycle: false,
          },
        });
        if (result.remaining > 0) {
          console.log(`[REACTOR] Watch cycle paused with ${result.remaining} pending stimuli still queued`);
        }
      } else if (work.protoClusters > 0 || work.liveTrends > 0) {
        console.log(`[REACTOR] Watch cycle: maintenance for ${work.protoClusters} proto-clusters and ${work.liveTrends} live trends`);
        await runMaintenanceCycle();
        await reactorHeartbeat.beat({
          status: "idle",
          metadata: {
            pending_stimuli: 0,
            proto_clusters: work.protoClusters,
            live_trends: work.liveTrends,
            processed_in_cycle: 0,
            batches_in_cycle: 0,
            maintenance_cycle: true,
          },
        });
      }
    } catch (error) {
      console.error("[REACTOR] Watch cycle failed:", error);
      if (reactorHeartbeat) {
        await reactorHeartbeat.beat({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await releaseReactorLock();
    }

    await sleep(intervalMs);
  }

  console.log("[REACTOR] Watch mode stopped");
  if (reactorHeartbeat) {
    await reactorHeartbeat.stop({ status: "stopped", metadata: { shutdown: true } });
    reactorHeartbeat = null;
  }
}

// ============================================================
// Stats
// ============================================================

export async function showStats(): Promise<void> {
  await ensureConfigLoaded();
  const [active] = await sql`SELECT COUNT(*)::int as n FROM stimuli WHERE processed = true AND created_at > now() - interval '7 days'`;
  const [contribs] = await sql`
    SELECT COUNT(*)::int as n, COUNT(DISTINCT node_addr)::int as nodes
    FROM stimulus_contributions WHERE contribution > 0.001
  `;
  const [heated] = await sql`SELECT COUNT(*)::int as n FROM nodes WHERE stimulus_heat > 0`;
  const [hw] = await sql`SELECT heat_weight() as w`;
  const [superPending] = await sql`SELECT COUNT(*)::int as n FROM supersession_candidates WHERE status = 'pending'`;
  const [conflictsPending] = await sql`SELECT COUNT(*)::int as n FROM stimulus_conflicts WHERE resolved = false`;
  const [dormantNodes] = await sql`SELECT COUNT(*)::int as n FROM nodes WHERE visibility = 'dormant'`;
  const [pinnedNodes] = await sql`SELECT COUNT(*)::int as n FROM nodes WHERE pinned = true`;
  const [absorbedCount] = await sql`SELECT COUNT(*)::int as n FROM absorbed_echoes`;
  const [trendLive] = await sql`SELECT COUNT(*)::int as n FROM nodes WHERE node_type = 'trend'`;
  const [trendEmerging] = await sql`
    SELECT COUNT(*)::int as n
    FROM nodes
    WHERE node_type = 'trend'
      AND COALESCE(source_context->'trend'->>'lifecycle', 'emerging') = 'emerging'`;
  const [protoClusters] = await sql`SELECT COUNT(*)::int as n FROM wi_proto_clusters`;
  const [archivedTrends] = await sql`SELECT COUNT(*)::int as n FROM trend_archive`;
  const [danglingTrendEdges] = await sql`
    SELECT COUNT(*)::int as n
    FROM edges e
    LEFT JOIN nodes nf ON nf.addr = e.from_addr
    LEFT JOIN nodes nt ON nt.addr = e.to_addr
    WHERE e.edge_type = 'trend_affects'
      AND (nf.addr IS NULL OR nt.addr IS NULL)
  `;

  const top10 = await sql`
    SELECT addr, label, stimulus_heat
    FROM nodes WHERE stimulus_heat > 0
    ORDER BY stimulus_heat DESC LIMIT 10
  `;

  console.log("\n=== Resonance Reactor Stats ===");
  console.log(`  Active stimuli (7d): ${active.n}`);
  console.log(`  Total active contributions: ${contribs.n} (across ${contribs.nodes} nodes)`);
  console.log(`  Nodes with heat > 0: ${heated.n}`);
  console.log(`  Current heat_weight: ${parseFloat(hw.w).toFixed(4)}`);
  console.log(`  Supersession candidates pending: ${superPending.n}`);
  console.log(`  Conflicts pending: ${conflictsPending.n}`);
  console.log(`  Dormant nodes: ${dormantNodes.n}`);
  console.log(`  Pinned nodes: ${pinnedNodes.n}`);
  console.log(`  Absorbed echoes: ${absorbedCount.n}`);
  console.log(`  Live trends: ${trendLive.n} (${trendEmerging.n} emerging)`);
  console.log(`  Proto-clusters: ${protoClusters.n}`);
  console.log(`  Archived trends: ${archivedTrends.n}`);
  console.log(`  Dangling trend edges: ${danglingTrendEdges.n}`);

  if (top10.length > 0) {
    console.log("\n  Top 10 hottest nodes:");
    for (const n of top10) {
      console.log(`    ${n.addr}  ${n.label}  heat=${parseFloat(n.stimulus_heat).toFixed(4)}`);
    }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  await ensureConfigLoaded();

  if (process.argv.includes("--stats")) {
    await showStats();
    await sql.end();
    return;
  }

  if (process.argv.includes("--watch")) {
    try {
      await runWatchLoop();
    } finally {
      await sql.end();
      await closeTrendService();
    }
    return;
  }

  const requiresLock = process.argv.includes("--process-pending")
    || process.argv.includes("--refresh-heat")
    || process.argv.includes("--maintain");

  if (requiresLock) {
    const acquired = await tryAcquireReactorLock();
    if (!acquired) {
      console.log("[REACTOR] Another maintenance worker is already running. Exiting.");
      await sql.end();
      return;
    }
  }

  try {
    if (process.argv.includes("--refresh-heat")) {
      await sql`SELECT refresh_stimulus_heat()`;
      console.log("[REACTOR] Refreshed stimulus heat");
    } else if (process.argv.includes("--maintain")) {
      await runMaintenanceCycle();
    } else if (process.argv.includes("--process-one")) {
      const idx = process.argv.indexOf("--process-one");
      const id = parseInt(process.argv[idx + 1], 10);
      if (isNaN(id)) {
        console.error("Usage: --process-one <stimulus_id>");
        process.exit(1);
      }
      await processStimulus(id);
      if (!DRY_RUN && !process.argv.includes("--skip-maintain")) {
        await runMaintenanceCycle();
      }
    } else if (process.argv.includes("--process-pending")) {
      await processPending({ batchSize: readIntFlag("--batch-size", 100) });
    } else if (process.argv.includes("--lifecycle")) {
    const { runLifecycle } = await import("./lifecycle");
    const result = await runLifecycle();
    console.log(`[LIFECYCLE] Stimuli cleaned: ${result.stimuliCleaned}`);
    console.log(`[LIFECYCLE] Nodes marked dormant: ${result.dormantMarked}`);
    console.log(`[LIFECYCLE] Nodes absorbed: ${result.absorbed}`);
    } else {
      console.error("Usage: bun run miners/src/reactor.ts --process-pending [--batch-size N]|--process-one <id> [--skip-maintain]|--refresh-heat|--maintain|--watch [--interval-seconds N] [--batch-size N] [--max-batches-per-cycle N]|--lifecycle|--stats [--dry-run]");
      process.exit(1);
    }
  } finally {
    await releaseReactorLock();
    await sql.end();
    await closeTrendService();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
