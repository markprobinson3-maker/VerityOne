import type { Sql } from "postgres";

export const RECALL_OUTCOME_EVENT_TYPES = [
  "recalled",
  "used",
  "ignored",
  "supported_action",
  "confused",
  "contradicted",
  "wasted_context",
  "user_corrected",
  "missing_memory",
] as const;

export type RecallOutcomeEventType = typeof RECALL_OUTCOME_EVENT_TYPES[number];

export const RECALL_OUTCOME_SCORE: Record<RecallOutcomeEventType, number> = {
  recalled: 0,
  used: 0.4,
  ignored: -0.2,
  supported_action: 1,
  confused: -0.7,
  contradicted: -0.9,
  wasted_context: -0.5,
  user_corrected: -1,
  missing_memory: -0.8,
};

export interface RecallOutcomeEventInput {
  recallId: string;
  tenantId: string;
  spaceId: string;
  agentId?: string | null;
  query?: string | null;
  eventType: RecallOutcomeEventType;
  memoryAddrs?: string[];
  topAddr?: string | null;
  actionContext?: string | null;
  evidence?: Record<string, unknown>;
  source?: string;
  correlationId?: string | null;
}

export interface RecallOutcomeSummary {
  recalled_events_24h: number;
  positive_outcomes_24h: number;
  negative_outcomes_24h: number;
  supported_actions_24h: number;
  corrections_24h: number;
  missing_memory_reports_24h: number;
  useful_memory_addrs_24h: string[];
  problem_memory_addrs_24h: string[];
}

export interface RecallExposurePacket {
  recall_id: string;
  tenant_id: string;
  space_id: string;
  agent_id: string | null;
  query: string | null;
  memory_addrs: string[];
}

export function createRecallId(): string {
  return crypto.randomUUID();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function normalizeRecallOutcomeEventType(value: string): RecallOutcomeEventType | null {
  return (RECALL_OUTCOME_EVENT_TYPES as readonly string[]).includes(value)
    ? value as RecallOutcomeEventType
    : null;
}

function cleanMemoryAddrs(addrs: string[] | undefined): string[] {
  return [...new Set((addrs || [])
    .map((addr) => String(addr || "").trim())
    .filter(Boolean))]
    .slice(0, 50);
}

export async function recordRecallOutcomeEvent(sql: Sql, input: RecallOutcomeEventInput): Promise<void> {
  const memoryAddrs = cleanMemoryAddrs(input.memoryAddrs);
  await sql`
    INSERT INTO recall_outcome_events (
      recall_id, tenant_id, space_id, agent_id, query, event_type,
      memory_addrs, top_addr, outcome_score, action_context, evidence,
      source, correlation_id
    )
    VALUES (
      ${input.recallId}::uuid,
      ${input.tenantId},
      ${input.spaceId},
      ${input.agentId || null},
      ${input.query || null},
      ${input.eventType},
      ${memoryAddrs}::text[],
      ${input.topAddr || memoryAddrs[0] || null},
      ${RECALL_OUTCOME_SCORE[input.eventType]},
      ${input.actionContext || null},
      ${sql.json((input.evidence || {}) as any)},
      ${input.source || "recall_compiler"},
      ${input.correlationId || null}
    )
    ON CONFLICT (recall_id) WHERE event_type = 'recalled' DO NOTHING`;
}

export async function selectRecallExposurePacket(sql: Sql, recallId: string): Promise<RecallExposurePacket | null> {
  if (!isUuid(recallId) || recallId === "00000000-0000-0000-0000-000000000000") return null;

  const [packet] = await sql`
    SELECT recall_id::text AS recall_id, tenant_id, space_id, agent_id, query, memory_addrs
    FROM recall_outcome_events
    WHERE recall_id = ${recallId}::uuid
      AND event_type = 'recalled'
    ORDER BY created_at ASC
    LIMIT 1`;
  if (!packet) return null;
  return {
    recall_id: packet.recall_id,
    tenant_id: packet.tenant_id,
    space_id: packet.space_id,
    agent_id: packet.agent_id || null,
    query: packet.query || null,
    memory_addrs: Array.isArray(packet.memory_addrs) ? packet.memory_addrs : [],
  };
}

export async function selectRecallOutcomeSummary(sql: Sql, tenantId: string): Promise<RecallOutcomeSummary> {
  const [summary] = await sql`
    WITH recent AS (
      SELECT *
      FROM recall_outcome_events
      WHERE tenant_id = ${tenantId}
        AND created_at > now() - interval '24 hours'
    ),
    expanded AS (
      SELECT addr, SUM(outcome_score) AS net_score
      FROM (
        SELECT outcome_score, unnest(memory_addrs) AS addr
        FROM recent
        WHERE event_type <> 'recalled'
      ) expanded_rows
      WHERE addr IS NOT NULL
      GROUP BY addr
    ),
    useful AS (
      SELECT addr, net_score
      FROM expanded
      WHERE net_score > 0
      ORDER BY net_score DESC, addr
      LIMIT 10
    ),
    problem AS (
      SELECT addr, net_score
      FROM expanded
      WHERE net_score < 0
      ORDER BY net_score ASC, addr
      LIMIT 10
    )
    SELECT
      (SELECT COUNT(*)::int FROM recent WHERE event_type = 'recalled') AS recalled_events_24h,
      (SELECT COUNT(*)::int FROM recent WHERE event_type <> 'recalled' AND COALESCE(outcome_score, 0) > 0) AS positive_outcomes_24h,
      (SELECT COUNT(*)::int FROM recent WHERE event_type <> 'recalled' AND COALESCE(outcome_score, 0) < 0) AS negative_outcomes_24h,
      (SELECT COUNT(*)::int FROM recent WHERE event_type = 'supported_action') AS supported_actions_24h,
      (SELECT COUNT(*)::int FROM recent WHERE event_type = 'user_corrected') AS corrections_24h,
      (SELECT COUNT(*)::int FROM recent WHERE event_type = 'missing_memory') AS missing_memory_reports_24h,
      COALESCE((SELECT array_agg(addr ORDER BY net_score DESC, addr) FROM useful), '{}'::text[]) AS useful_memory_addrs_24h,
      COALESCE((SELECT array_agg(addr ORDER BY net_score ASC, addr) FROM problem), '{}'::text[]) AS problem_memory_addrs_24h`;

  return {
    recalled_events_24h: Number(summary?.recalled_events_24h ?? 0),
    positive_outcomes_24h: Number(summary?.positive_outcomes_24h ?? 0),
    negative_outcomes_24h: Number(summary?.negative_outcomes_24h ?? 0),
    supported_actions_24h: Number(summary?.supported_actions_24h ?? 0),
    corrections_24h: Number(summary?.corrections_24h ?? 0),
    missing_memory_reports_24h: Number(summary?.missing_memory_reports_24h ?? 0),
    useful_memory_addrs_24h: Array.isArray(summary?.useful_memory_addrs_24h) ? summary.useful_memory_addrs_24h : [],
    problem_memory_addrs_24h: Array.isArray(summary?.problem_memory_addrs_24h) ? summary.problem_memory_addrs_24h : [],
  };
}
