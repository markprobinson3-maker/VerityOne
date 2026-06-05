/**
 * /freshness — Surface stale knowledge before it misleads agents
 * 
 * Uses existing temporal fields: verified_at, updated_at, query_hits, confidence, decay_rate
 */

import { Hono } from "hono";
import { sql } from "../db";
import { clampInt } from "../lib/utils";

const freshness = new Hono();

freshness.get("/", async (c) => {
  const namespace = c.req.query("namespace") || null;
  const days = clampInt(c.req.query("stale_days"), 30, 1, 3650);

  // Stale nodes: not updated in N days, public, with meaningful content
  const staleNodes = namespace
    ? await sql`
        SELECT addr, label, node_type, confidence, 
          updated_at, verified_at, query_hits,
          EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS days_since_update,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(verified_at, updated_at))) / 86400 AS days_since_verified
        FROM nodes
        WHERE visibility = 'public' AND pyramid_id = ${namespace}
          AND updated_at < NOW() - (${days} * interval '1 day')
        ORDER BY updated_at ASC LIMIT 25`
    : await sql`
        SELECT addr, label, node_type, confidence, pyramid_id,
          updated_at, verified_at, query_hits,
          EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS days_since_update,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(verified_at, updated_at))) / 86400 AS days_since_verified
        FROM nodes
        WHERE visibility = 'public'
          AND updated_at < NOW() - (${days} * interval '1 day')
        ORDER BY updated_at ASC LIMIT 25`;

  // High-value stale: nodes with many query_hits but old verified_at
  const highValueStale = await sql`
    SELECT addr, label, node_type, confidence, query_hits,
      updated_at, verified_at,
      ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(verified_at, updated_at))) / 86400) AS days_stale
    FROM nodes
    WHERE visibility = 'public' AND query_hits > 3
      AND COALESCE(verified_at, updated_at) < NOW() - INTERVAL '14 days'
    ORDER BY query_hits DESC, verified_at ASC
    LIMIT 10`;

  // Never-queried: public nodes that no agent has ever searched for
  const [neverQueried] = await sql`
    SELECT COUNT(*) AS count FROM nodes 
    WHERE visibility = 'public' AND query_hits = 0`;

  // Summary stats
  const [stats] = await sql`
    SELECT
      ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)) AS avg_age_days,
      ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(verified_at, updated_at))) / 86400)) AS avg_verified_age_days,
      COUNT(*) FILTER (WHERE updated_at < NOW() - INTERVAL '30 days') AS stale_30d,
      COUNT(*) FILTER (WHERE updated_at < NOW() - INTERVAL '90 days') AS stale_90d
    FROM nodes WHERE visibility = 'public'`;

  // Evidence quality: source_ref coverage (the metric both auditors flagged as missing)
  const [evidence] = await sql`
    SELECT
      COUNT(*) AS total_public,
      COUNT(*) FILTER (WHERE source_refs IS NOT NULL AND source_refs != '[]'::jsonb) AS has_source_refs,
      COUNT(*) FILTER (WHERE provenance IS NOT NULL AND provenance->>'basis' = 'observed') AS basis_observed,
      COUNT(*) FILTER (WHERE provenance IS NOT NULL AND provenance->>'basis' = 'consensus') AS basis_consensus,
      COUNT(*) FILTER (WHERE provenance IS NOT NULL AND provenance->>'basis' = 'inferred') AS basis_inferred,
      COUNT(*) FILTER (WHERE provenance IS NULL OR provenance->>'basis' = 'asserted') AS basis_asserted_or_none
    FROM nodes WHERE visibility = 'public'`;

  const totalPub = parseInt(evidence.total_public);
  const hasRefs = parseInt(evidence.has_source_refs);

  return c.json({
    summary: {
      avg_age_days: parseInt(stats.avg_age_days),
      avg_verified_age_days: parseInt(stats.avg_verified_age_days),
      stale_30d: parseInt(stats.stale_30d),
      stale_90d: parseInt(stats.stale_90d),
      never_queried: parseInt(neverQueried.count),
    },
    evidence_quality: {
      source_ref_coverage: `${hasRefs}/${totalPub} (${(100 * hasRefs / totalPub).toFixed(1)}%)`,
      has_source_refs: hasRefs,
      total_public: totalPub,
      provenance_breakdown: {
        observed: parseInt(evidence.basis_observed),
        consensus: parseInt(evidence.basis_consensus),
        inferred: parseInt(evidence.basis_inferred),
        asserted_or_none: parseInt(evidence.basis_asserted_or_none),
      },
      note: "source_ref_coverage measures how many public nodes link back to actual files (skills, memory, code). provenance_breakdown shows the evidence basis distribution. A truth engine needs high observed+consensus and high source_ref coverage.",
    },
    stale_nodes: staleNodes.map((n: any) => ({
      addr: n.addr,
      label: n.label,
      type: n.node_type,
      pyramid: n.pyramid_id,
      confidence: parseFloat(n.confidence),
      query_hits: n.query_hits,
      days_since_update: Math.round(parseFloat(n.days_since_update)),
      days_since_verified: Math.round(parseFloat(n.days_since_verified)),
      action: parseFloat(n.days_since_update) > 90 
        ? "re-verify or deprecate" 
        : "re-verify",
    })),
    high_value_stale: highValueStale.map((n: any) => ({
      addr: n.addr,
      label: n.label,
      query_hits: n.query_hits,
      days_stale: parseInt(n.days_stale),
      note: "Frequently queried but not recently verified — high risk of misleading agents",
    })),
  });
});

export default freshness;
