/**
 * Canonical per-agent LLM override write path
 * (VO-REMOTE-COMMAND-PROVIDER-AGENT-OVERRIDE-PR-1).
 *
 * Single source of truth for writes to `agent_profiles.metadata.llm_overrides`.
 * Reused by:
 *   - POST /providers/agent-override           (direct operator route)
 *   - POST /dashboard/providers/agent-override (local dashboard bridge)
 *   - remote-command-dispatch `set_agent_override` (hosted-queued)
 *
 * Combines the strongest parts of the previously-duplicated surfaces:
 *   - explicit tenant ownership check via VERITY_AGENT_TENANTS
 *     (the direct route was missing this — any operator token could edit
 *     any tenant's agent)
 *   - targeted `jsonb_set` on `{llm_overrides, <task>}` so sibling
 *     metadata keys (policy, etc.) are never clobbered
 *   - `journalGovernance` nudge so the machine_settings snapshot
 *     re-exports and hosted `/my/providers` shows the new override
 *     state on next sync (the dashboard bridge was missing this)
 *
 * This helper ALWAYS requires explicit tenantId. Callers must not infer
 * tenant from operator auth alone — they must pass the tenant the agent
 * should belong to.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface AgentOverrideParams {
  tenantId: string;
  agentId: string;
  task: string;
  provider: string;
  model: string;
}

export type AgentOverrideResult =
  | {
      ok: true;
      agent_id: string;
      task: string;
      provider: string;
      model: string;
      previous: { provider: string; model: string } | null;
    }
  | { ok: false; reason: "invalid_input"; detail: string }
  | { ok: false; reason: "not_in_tenant" }
  | { ok: false; reason: "agent_not_found" };

function parseAgentTenantPair(pair: string): { agentId: string; tenantId: string } | null {
  const sep = pair.lastIndexOf(":");
  if (sep <= 0) return null;
  const agentId = pair.slice(0, sep).trim();
  const tenantId = pair.slice(sep + 1).trim();
  return agentId && tenantId ? { agentId, tenantId } : null;
}

/**
 * Check whether an agent is bound to a tenant per VERITY_AGENT_TENANTS.
 * Exported so routes can short-circuit with the right error code before
 * hitting the DB (e.g. 403 vs 404).
 */
export function agentBelongsToTenant(agentId: string, tenantId: string): boolean {
  if (!agentId || !tenantId) return false;
  const raw = process.env.VERITY_AGENT_TENANTS || "";
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = parseAgentTenantPair(pair);
    if (parsed?.agentId === agentId && parsed.tenantId === tenantId) return true;
  }
  return false;
}

/**
 * All agent_ids currently bound to `tenantId` via VERITY_AGENT_TENANTS,
 * in env-declaration order. Exported so the sync-exporter + hosted UI
 * + any future surface share one parsing rule.
 */
export function listTenantAgentIds(tenantId: string): string[] {
  if (!tenantId) return [];
  const raw = process.env.VERITY_AGENT_TENANTS || "";
  const ids: string[] = [];
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = parseAgentTenantPair(pair);
    if (parsed?.tenantId === tenantId) ids.push(parsed.agentId);
  }
  return ids;
}

/**
 * Tenant-bound agents for hosted mirror export. CRITICAL: backfills
 * entries for agent_ids mapped in VERITY_AGENT_TENANTS but without an
 * `agent_profiles` row — those are still real tenant bindings and the
 * hosted UI must see them. The local dashboard already backfills here
 * (dashboard.ts /providers-status); the sync-exporter used to drop
 * them silently, causing hosted to claim "No agents bound" while
 * local showed them.
 *
 * Output order follows VERITY_AGENT_TENANTS declaration order so
 * rendered UI order is stable across snapshots.
 */
export async function listTenantAgentsWithBackfill(
  sql: SqlTag,
  tenantId: string,
): Promise<Array<{ agent_id: string; last_seen: string | null }>> {
  const ids = listTenantAgentIds(tenantId);
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT agent_id, last_seen
    FROM agent_profiles
    WHERE tenant_id = ${tenantId} AND agent_id = ANY(${ids})
  `;
  const byId = new Map<string, { agent_id: string; last_seen: string | null }>();
  for (const r of rows) {
    byId.set(r.agent_id, { agent_id: r.agent_id, last_seen: r.last_seen || null });
  }
  for (const aid of ids) {
    if (!byId.has(aid)) byId.set(aid, { agent_id: aid, last_seen: null });
  }
  return ids.map((aid) => byId.get(aid)!);
}

/**
 * Write (or overwrite) one per-agent LLM override.
 * Returns a typed result — callers map reasons to HTTP codes:
 *   - invalid_input    → 400
 *   - not_in_tenant    → 403 (do not confirm existence across tenants)
 *   - agent_not_found  → 404
 */
export async function writeAgentOverride(
  sql: SqlTag,
  params: AgentOverrideParams,
): Promise<AgentOverrideResult> {
  const tenantId = (params.tenantId || "").trim();
  const agentId = (params.agentId || "").trim();
  const task = (params.task || "").trim();
  const provider = (params.provider || "").trim();
  const model = (params.model || "").trim();

  if (!tenantId || !agentId || !task || !provider || !model) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: "tenant_id, agent_id, task, provider, model all required (non-empty)",
    };
  }

  // Defense-in-depth: the validator already restricts `task` to
  // CANONICAL_TASKS at queue time, but the direct local HTTP routes
  // bypass the validator — enforce the same constraint here so ALL
  // three write sites (direct route, dashboard bridge, remote dispatch)
  // cannot persist non-canonical task keys that the hosted UI cannot
  // cleanly round-trip.
  const { CANONICAL_TASKS } = await import("./provider-config");
  if (!(CANONICAL_TASKS as readonly string[]).includes(task)) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: `task must be one of: ${(CANONICAL_TASKS as readonly string[]).join(", ")}`,
    };
  }

  if (!agentBelongsToTenant(agentId, tenantId)) {
    return { ok: false, reason: "not_in_tenant" };
  }

  // Read current overrides so we can return `previous` in the result and
  // so callers (including history rendering) have useful context.
  const [current] = await sql`
    SELECT metadata->'llm_overrides' AS overrides
    FROM agent_profiles
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;
  if (!current) return { ok: false, reason: "agent_not_found" };

  const cur = (current.overrides || {}) as Record<string, { provider?: unknown; model?: unknown }>;
  const previous =
    cur[task] && typeof cur[task].provider === "string" && typeof cur[task].model === "string"
      ? { provider: cur[task].provider as string, model: cur[task].model as string }
      : null;

  // Update strategy: single-level jsonb_set on the hardcoded
  // `{llm_overrides}` key. The new value is the EXISTING
  // `llm_overrides` object merged with `{task: value}` via the
  // jsonb `||` concat operator — preserves every sibling task and
  // overwrites the target task if it already exists. Sibling
  // metadata keys (policy, etc.) are untouched because we never
  // write the top-level `metadata` directly.
  //
  // Why NOT a two-level path `{llm_overrides, <task>}` with
  // create_missing=true: jsonb_set's create_missing flag creates
  // only the LAST path segment. If `llm_overrides` doesn't yet
  // exist, a two-level path silently returns the ORIGINAL row
  // unchanged — no error, no write. Verified in Postgres 17.
  //
  // Injection safety: `task` reaches SQL only as a bound parameter
  // to `jsonb_build_object`, which treats it as a literal key.
  // A crafted `foo,bar` becomes a single key `"foo,bar"`, never a
  // nested path segment. (The canonical-task check above already
  // rejects such inputs, but this is the structural guarantee.)
  await sql`
    UPDATE agent_profiles SET
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{llm_overrides}',
        COALESCE(metadata->'llm_overrides', '{}'::jsonb)
          || jsonb_build_object(${task}::text, ${sql.json({ provider, model })}::jsonb),
        true
      ),
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;

  // Nudge the machine_settings governance snapshot so the new override
  // reaches hosted /my/providers on the next sync. Uses the same
  // governance key that runtime-profile setting writes use — the
  // sync-exporter re-assembles the full snapshot (including our new
  // provider_agent_overrides field) whenever machine_settings is
  // journaled.
  //
  // Best-effort — wrap so a journal-append failure never blocks the
  // primary override write (which already succeeded above).
  try {
    const { journalGovernance } = await import("./sync-journal-port");
    await journalGovernance(sql, "machine_settings", `tenant:${tenantId}`);
  } catch (e: any) {
    console.error("[agent-override] journalGovernance failed:", e?.message);
  }

  return {
    ok: true,
    agent_id: agentId,
    task,
    provider,
    model,
    previous,
  };
}

// ── clearAgentOverride ───────────────────────────────────────────────
//
// VO-PROVIDER-AGENT-OVERRIDE-CLEAR-PR-1. Removes one
// `metadata.llm_overrides[task]` entry. Sibling tasks are preserved;
// `metadata.policy` is preserved; if `llm_overrides` becomes empty,
// the key is left as `{}` deliberately — that mirrors the
// no-override-yet representation and the existing exporter +
// hosted/local UI already treat `{}` as "no overrides".
//
// IDEMPOTENT: clearing a task that has no override returns
// `{ok:true, cleared:false}`, NOT an error. Hosted state is
// stale-by-design — a user clicking Clear from a stale mirror that
// shows an override the local node has already cleared would
// otherwise see a false failure for a perfectly normal race.

export interface ClearAgentOverrideParams {
  tenantId: string;
  agentId: string;
  task: string;
}

export type ClearAgentOverrideResult =
  | {
      ok: true;
      agent_id: string;
      task: string;
      cleared: boolean;
      previous: { provider: string; model: string } | null;
    }
  | { ok: false; reason: "invalid_input"; detail: string }
  | { ok: false; reason: "not_in_tenant" }
  | { ok: false; reason: "agent_not_found" };

export async function clearAgentOverride(
  sql: SqlTag,
  params: ClearAgentOverrideParams,
): Promise<ClearAgentOverrideResult> {
  const tenantId = (params.tenantId || "").trim();
  const agentId = (params.agentId || "").trim();
  const task = (params.task || "").trim();

  if (!tenantId || !agentId || !task) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: "tenant_id, agent_id, task all required (non-empty)",
    };
  }

  // Defense-in-depth: the validator already restricts task to
  // CANONICAL_TASKS, but the direct local routes bypass the
  // validator. Re-enforce so all three call sites agree.
  const { CANONICAL_TASKS } = await import("./provider-config");
  if (!(CANONICAL_TASKS as readonly string[]).includes(task)) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: `task must be one of: ${(CANONICAL_TASKS as readonly string[]).join(", ")}`,
    };
  }

  if (!agentBelongsToTenant(agentId, tenantId)) {
    return { ok: false, reason: "not_in_tenant" };
  }

  // Read current overrides for the `previous` field AND the
  // `cleared` flag. If the task isn't currently overridden we still
  // return success (idempotent), but with cleared:false so callers
  // can distinguish "I just removed it" from "it was already gone".
  const [current] = await sql`
    SELECT metadata->'llm_overrides' AS overrides
    FROM agent_profiles
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;
  if (!current) return { ok: false, reason: "agent_not_found" };

  const cur = (current.overrides || {}) as Record<string, { provider?: unknown; model?: unknown }>;
  const previous =
    cur[task] && typeof cur[task].provider === "string" && typeof cur[task].model === "string"
      ? { provider: cur[task].provider as string, model: cur[task].model as string }
      : null;

  if (!previous) {
    // Nothing to delete — idempotent success. Do not even fire the
    // governance journal; nothing changed locally so there's nothing
    // for the mirror to refresh to.
    return { ok: true, agent_id: agentId, task, cleared: false, previous: null };
  }

  // Surgical JSONB key delete on `llm_overrides`:
  //
  //   jsonb_set(metadata, '{llm_overrides}',
  //             COALESCE(metadata->'llm_overrides', '{}'::jsonb) - <task>,
  //             false)
  //
  // The `-` operator on a JSONB object removes one key by name (`task`
  // arrives as a bound parameter, treated as a literal — no path
  // injection). `jsonb_set` then writes JUST the `llm_overrides` value;
  // sibling top-level metadata keys (policy, etc.) are untouched.
  // create_missing=false because if `llm_overrides` doesn't exist we
  // already returned cleared:false above and never reach here.
  await sql`
    UPDATE agent_profiles SET
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{llm_overrides}',
        COALESCE(metadata->'llm_overrides', '{}'::jsonb) - ${task}::text,
        false
      ),
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;

  // Best-effort governance journal nudge so the mirror refreshes
  // — same pattern as writeAgentOverride.
  try {
    const { journalGovernance } = await import("./sync-journal-port");
    await journalGovernance(sql, "machine_settings", `tenant:${tenantId}`);
  } catch (e: any) {
    console.error("[agent-override] journalGovernance failed (clear):", e?.message);
  }

  return { ok: true, agent_id: agentId, task, cleared: true, previous };
}
