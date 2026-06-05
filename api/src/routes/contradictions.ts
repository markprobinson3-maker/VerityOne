/**
 * /contradictions — Surface where the graph disagrees with itself
 * 
 * Truth is derived from tension between related claims. Contradictions
 * are the most valuable signal in a truth system — not errors to fix,
 * but dialectic tension points to resolve.
 *
 * Scans for:
 * 1. Explicit conflicts_with edges
 * 2. Confidence divergence between connected nodes
 * 3. Stale nodes that contradict fresh nodes on the same topic
 * 4. Nodes with conflicting provides (same capability, different approaches)
 */

import { Hono } from "hono";
import { sql } from "../db";
import { clampFloat } from "../lib/utils";

const contradictions = new Hono();

contradictions.get("/", async (c) => {
  const minDivergence = clampFloat(c.req.query("min_divergence"), 0.3, 0, 1);
  const includeResolved = c.req.query("include_resolved") === "true";

  const tensions: any[] = [];

  // 1. Explicit conflicts_with edges
  const conflicts = await sql`
    SELECT e.from_addr, e.to_addr, e.label, e.confidence,
      n1.label AS from_label, n1.confidence AS from_confidence, n1.updated_at AS from_updated,
      n2.label AS to_label, n2.confidence AS to_confidence, n2.updated_at AS to_updated
    FROM edges e
    JOIN nodes n1 ON e.from_addr = n1.addr
    JOIN nodes n2 ON e.to_addr = n2.addr
    WHERE e.edge_type = 'conflicts_with'
      AND n1.visibility <> 'deleted'
      AND n2.visibility <> 'deleted'
    ORDER BY e.confidence DESC
  `;

  for (const c of conflicts) {
    tensions.push({
      type: "explicit_conflict",
      severity: "high",
      from: { addr: c.from_addr, label: c.from_label, confidence: parseFloat(c.from_confidence) },
      to: { addr: c.to_addr, label: c.to_label, confidence: parseFloat(c.to_confidence) },
      reason: c.label,
      resolution_hint: "These nodes are documented as conflicting. Check if both are still valid or if one has been superseded.",
    });
  }

  // 2. Confidence divergence: connected nodes with wildly different confidence
  const divergent = await sql`
    SELECT e.from_addr, e.to_addr, e.edge_type, e.label,
      n1.label AS from_label, n1.confidence AS from_conf,
      n2.label AS to_label, n2.confidence AS to_conf,
      ABS(n1.confidence - n2.confidence) AS divergence
    FROM edges e
    JOIN nodes n1 ON e.from_addr = n1.addr
    JOIN nodes n2 ON e.to_addr = n2.addr
    WHERE e.edge_type IN ('requires', 'uses', 'implements', 'extends')
      AND ABS(n1.confidence - n2.confidence) >= ${minDivergence}
      AND n1.visibility = 'public' AND n2.visibility = 'public'
    ORDER BY ABS(n1.confidence - n2.confidence) DESC
    LIMIT 20
  `;

  for (const d of divergent) {
    tensions.push({
      type: "confidence_divergence",
      severity: parseFloat(d.divergence) > 0.4 ? "high" : "medium",
      from: { addr: d.from_addr, label: d.from_label, confidence: parseFloat(d.from_conf) },
      to: { addr: d.to_addr, label: d.to_label, confidence: parseFloat(d.to_conf) },
      edge_type: d.edge_type,
      divergence: parseFloat(parseFloat(d.divergence).toFixed(3)),
      reason: `${d.from_label} (conf=${parseFloat(d.from_conf).toFixed(2)}) ${d.edge_type} ${d.to_label} (conf=${parseFloat(d.to_conf).toFixed(2)}) — ${parseFloat(d.divergence).toFixed(2)} confidence gap`,
      resolution_hint: "A high-confidence node depending on a low-confidence node is fragile. Verify the weaker node or reduce trust in the stronger one.",
    });
  }

  // 3. Staleness conflicts: nodes about same topic with very different freshness
  const stale = await sql`
    SELECT e.from_addr, e.to_addr, e.edge_type,
      n1.label AS from_label, n1.updated_at AS from_updated, n1.verified_at AS from_verified,
      n2.label AS to_label, n2.updated_at AS to_updated, n2.verified_at AS to_verified,
      EXTRACT(EPOCH FROM (n1.updated_at - n2.updated_at)) / 86400 AS age_diff_days
    FROM edges e
    JOIN nodes n1 ON e.from_addr = n1.addr
    JOIN nodes n2 ON e.to_addr = n2.addr
    WHERE e.edge_type IN ('requires', 'uses', 'implements')
      AND ABS(EXTRACT(EPOCH FROM (n1.updated_at - n2.updated_at))) > 86400 * 30
      AND n1.visibility = 'public' AND n2.visibility = 'public'
    ORDER BY ABS(EXTRACT(EPOCH FROM (n1.updated_at - n2.updated_at))) DESC
    LIMIT 10
  `;

  for (const s of stale) {
    const ageDiff = Math.abs(parseFloat(s.age_diff_days));
    tensions.push({
      type: "staleness_gap",
      severity: ageDiff > 60 ? "high" : "medium",
      from: { addr: s.from_addr, label: s.from_label, updated: s.from_updated },
      to: { addr: s.to_addr, label: s.to_label, updated: s.to_updated },
      age_gap_days: Math.round(ageDiff),
      reason: `${Math.round(ageDiff)} day freshness gap between connected nodes`,
      resolution_hint: "The older node may contain outdated information that the newer node depends on. Re-verify the stale node.",
    });
  }

  // 4. Capability conflicts: nodes providing the same capability with alternative_to edges
  const capConflicts = await sql`
    SELECT e.from_addr, e.to_addr, e.label,
      n1.label AS from_label, n1.confidence AS from_conf,
      n2.label AS to_label, n2.confidence AS to_conf,
      n1.substance->'provides' AS from_provides,
      n2.substance->'provides' AS to_provides
    FROM edges e
    JOIN nodes n1 ON e.from_addr = n1.addr
    JOIN nodes n2 ON e.to_addr = n2.addr
    WHERE e.edge_type = 'alternative_to'
      AND n1.visibility = 'public' AND n2.visibility = 'public'
    ORDER BY ABS(n1.confidence - n2.confidence) DESC
  `;

  for (const cc of capConflicts) {
    tensions.push({
      type: "capability_overlap",
      severity: "low",
      from: { addr: cc.from_addr, label: cc.from_label, confidence: parseFloat(cc.from_conf) },
      to: { addr: cc.to_addr, label: cc.to_label, confidence: parseFloat(cc.to_conf) },
      reason: cc.label || `${cc.from_label} and ${cc.to_label} provide overlapping capabilities`,
      resolution_hint: "Not necessarily a problem — alternatives are healthy. But if one is clearly superior, consider deprecating the other.",
    });
  }

  // 5. Active dialectic tensions (from edge_tensions table)
  const activeTensions = await sql`
    SELECT et.from_addr, et.to_addr, et.tension, et.tension_type,
      et.synthesis, et.synthesis_confidence, et.discovered_by,
      et.consistency_status, et.created_at,
      n1.label AS from_label, n2.label AS to_label
    FROM edge_tensions et
    JOIN nodes n1 ON n1.addr = et.from_addr
    JOIN nodes n2 ON n2.addr = et.to_addr
    WHERE et.resolved_at IS NULL
      AND n1.visibility <> 'deleted'
      AND n2.visibility <> 'deleted'
    ORDER BY et.tension DESC
    LIMIT 30`;

  for (const t of activeTensions) {
    tensions.push({
      type: "dialectic_tension",
      severity: t.tension > 0.6 ? "high" : t.tension > 0.3 ? "medium" : "low",
      tension_type: t.tension_type,
      tension_strength: parseFloat(parseFloat(t.tension).toFixed(3)),
      from: { addr: t.from_addr, label: t.from_label },
      to: { addr: t.to_addr, label: t.to_label },
      synthesis: t.synthesis || null,
      synthesis_confidence: t.synthesis_confidence ? parseFloat(parseFloat(t.synthesis_confidence).toFixed(3)) : null,
      discovered_by: t.discovered_by,
      consistency_status: t.consistency_status,
      reason: `${t.tension_type} tension: ${t.from_label} ↔ ${t.to_label}`,
      resolution_hint: t.tension_type === 'contradiction' 
        ? "One of these is likely wrong. Investigate and update or deprecate."
        : `This is productive ${t.tension_type} tension. The synthesis (if generated) captures what it reveals.`,
    });
  }

  const resolvedTensions = includeResolved
    ? await sql`
        SELECT et.from_addr, et.to_addr, et.tension, et.tension_type,
          et.synthesis, et.synthesis_confidence, et.discovered_by,
          et.consistency_status, et.created_at, et.resolved_at,
          n1.label AS from_label, n2.label AS to_label
        FROM edge_tensions et
        JOIN nodes n1 ON n1.addr = et.from_addr
        JOIN nodes n2 ON n2.addr = et.to_addr
        WHERE et.resolved_at IS NOT NULL
          AND n1.visibility <> 'deleted'
          AND n2.visibility <> 'deleted'
        ORDER BY et.resolved_at DESC
        LIMIT 20`
    : [];

  // 6. Pending proposals from dialectic scanner
  const pendingProposals = await sql`
    SELECT proposal_type, from_addr, to_addr, payload, confidence, discovered_by, created_at
    FROM proposals WHERE status = 'pending'
    ORDER BY created_at DESC LIMIT 20`;

  // Separate real contradictions from informational signals
  const contradictionTypes = new Set(["explicit_conflict", "confidence_divergence", "staleness_gap", "dialectic_tension"]);
  const realContradictions = tensions.filter(t => contradictionTypes.has(t.type));
  const alternatives = tensions.filter(t => t.type === "capability_overlap");

  // Sort each group by severity
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortBySeverity = (a: any, b: any) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
  realContradictions.sort(sortBySeverity);
  alternatives.sort(sortBySeverity);

  return c.json({
    contradictions_count: realContradictions.length,
    alternatives_count: alternatives.length,
    pending_proposals: pendingProposals.length,
    include_resolved: includeResolved,
    resolved_tensions_count: resolvedTensions.length,
    breakdown: {
      explicit_conflict: realContradictions.filter(t => t.type === "explicit_conflict").length,
      confidence_divergence: realContradictions.filter(t => t.type === "confidence_divergence").length,
      staleness_gap: realContradictions.filter(t => t.type === "staleness_gap").length,
      dialectic_tension: realContradictions.filter(t => t.type === "dialectic_tension").length,
    },
    thesis: "Truth is a process. Contradictions and tensions are the most valuable signals in a knowledge system — not errors, but dialectic pressure points where deeper meaning emerges. Resonance pulls knowledge together. Tension pulls it apart. Meaning lives in the space between.",
    contradictions: realContradictions,
    alternatives,
    resolved_tensions: resolvedTensions.map((t: any) => ({
      tension_type: t.tension_type,
      tension_strength: parseFloat(parseFloat(t.tension).toFixed(3)),
      from: { addr: t.from_addr, label: t.from_label },
      to: { addr: t.to_addr, label: t.to_label },
      synthesis: t.synthesis || null,
      synthesis_confidence: t.synthesis_confidence ? parseFloat(parseFloat(t.synthesis_confidence).toFixed(3)) : null,
      discovered_by: t.discovered_by,
      consistency_status: t.consistency_status,
      created_at: t.created_at,
      resolved_at: t.resolved_at,
    })),
    proposals: pendingProposals.map((p: any) => ({
      type: p.proposal_type,
      from: p.from_addr,
      to: p.to_addr,
      details: p.payload,
      confidence: parseFloat(p.confidence),
      discovered_by: p.discovered_by,
      created_at: p.created_at,
    })),
    resolve: "Use /insight?q=<describe the tension> to synthesize resolution candidates. Use POST /signal to record the outcome.",
  });
});

export default contradictions;
