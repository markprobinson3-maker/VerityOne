import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { clampInt, parseJsonField, roundFloat } from "../lib/utils";

const gaps = new Hono();

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTerritoryRow(row: any) {
  return {
    ...row,
    seen_count: toNumber(row.seen_count),
    event_count: toNumber(row.event_count),
    distinct_goal_count: toNumber(row.distinct_goal_count),
    distinct_agent_count: toNumber(row.distinct_agent_count),
    distinct_scope_count: toNumber(row.distinct_scope_count),
    critical_count: toNumber(row.critical_count),
    warn_count: toNumber(row.warn_count),
    world_gap_count: toNumber(row.world_gap_count),
    function_gap_count: toNumber(row.function_gap_count),
    skill_gap_count: toNumber(row.skill_gap_count),
    corroboration_gap_count: toNumber(row.corroboration_gap_count),
    bridge_gap_count: toNumber(row.bridge_gap_count),
    low_confidence_count: toNumber(row.low_confidence_count),
    claim_count: toNumber(row.claim_count),
    accepted_claim_count: toNumber(row.accepted_claim_count),
    rewarded_claim_count: toNumber(row.rewarded_claim_count),
    provisional_token_weight: roundFloat(row.provisional_token_weight),
    score_components: parseJsonField(row.score_components) || row.score_components,
    blockchain_context: parseJsonField(row.blockchain_context) || row.blockchain_context,
  };
}

gaps.get("/", async (c) => {
  const limit = clampInt(c.req.query("limit"), 25, 1, 100);
  const status = (c.req.query("status") || "open").trim();
  const scopeKind = (c.req.query("scope_kind") || "").trim();

  const rows = await sql`
    SELECT
      gap_key,
      gap_type,
      title,
      description,
      target_pyramid_id,
      target_branch_addr,
      intent_mode,
      scope_kind,
      canonical_focus,
      status,
      seen_count,
      first_seen_at,
      last_seen_at,
      event_count,
      distinct_goal_count,
      distinct_agent_count,
      distinct_scope_count,
      critical_count,
      warn_count,
      world_gap_count,
      function_gap_count,
      skill_gap_count,
      corroboration_gap_count,
      bridge_gap_count,
      low_confidence_count,
      claim_count,
      accepted_claim_count,
      rewarded_claim_count,
      provisional_token_weight,
      score_components,
      territory_posture,
      blockchain_context
    FROM v_grounding_gap_reward_basis
    WHERE (${status} = '' OR status = ${status})
      AND (${scopeKind} = '' OR scope_kind = ${scopeKind})
    ORDER BY provisional_token_weight DESC, last_seen_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    ok: true,
    territories: rows.map((row: any) => normalizeTerritoryRow(row)),
    count: rows.length,
  });
});

gaps.get("/:gapKey", async (c) => {
  const gapKey = decodeURIComponent(c.req.param("gapKey"));
  const [territory] = await sql`
    SELECT *
    FROM v_grounding_gap_reward_basis
    WHERE gap_key = ${gapKey}
    LIMIT 1
  `;
  if (!territory) return errorJson(c, "not_found", { message: "Gap territory not found" });

  const events = await sql`
    SELECT
      id,
      gap_type,
      goal,
      agent_id,
      access_scope,
      space_id,
      severity,
      confidence_level,
      event_payload,
      created_at
    FROM grounding_gap_events
    WHERE gap_key = ${gapKey}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const claims = await sql`
    SELECT
      id,
      claimant,
      claim_type,
      status,
      source_addr,
      publication_id,
      evidence,
      reward_payload,
      created_at,
      updated_at
    FROM grounding_gap_claims
    WHERE gap_key = ${gapKey}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return c.json({
    ok: true,
    territory: normalizeTerritoryRow(territory),
    recent_events: events.map((row: any) => ({
      ...row,
      event_payload: parseJsonField(row.event_payload) || row.event_payload,
    })),
    claims: claims.map((row: any) => ({
      ...row,
      evidence: parseJsonField(row.evidence) || row.evidence,
      reward_payload: parseJsonField(row.reward_payload) || row.reward_payload,
    })),
  });
});

export default gaps;
