/**
 * Canonical agent-policy mutation helper.
 *
 * VO-DASHBOARD-HOSTED-AGENT-POLICY-PR-1.
 *
 * Single source of truth for every surface that writes
 * `agent_profiles.metadata.policy`:
 *   - POST /agent/:id/policy              (operator route)
 *   - POST /dashboard/settings/agent/:id/policy (dashboard bridge)
 *   - remote dispatch `settings / agent_policy` (hosted queue)
 *
 * Contract:
 *   - Validates tenant ownership via VERITY_AGENT_TENANTS
 *   - Validates agent_profiles row exists (does NOT auto-create)
 *   - Validates patch via `validatePolicyUpdate` (canonical rules)
 *   - Rejects empty / no-valid-fields patches
 *   - Targeted jsonb_set on metadata.policy only (preserves siblings
 *     like `llm_overrides`)
 *   - Journals governance + nudges sync scheduler via journalGovernance
 *   - Re-reads fresh metadata and returns BOTH stored policy AND
 *     resolved effective policy (under the machine-level ceiling)
 *   - Returns a discriminated result type — callers map the reason
 *     to HTTP codes / redirect errors / structured dispatch result
 */

import type postgres from "postgres";
import {
  resolveAgentPolicy,
  validatePolicyUpdate,
  type EffectiveAgentPolicy,
  type PolicyValidationError,
} from "./agent-policy";
import { agentBelongsToTenant } from "./agent-override";
import { journalGovernance } from "./sync-journal-port";
import { resolveTenantSettings } from "./runtime-profile";

type SqlTag = ReturnType<typeof postgres>;

export interface ApplyAgentPolicyPatchParams {
  tenantId: string;
  agentId: string;
  /** Untrusted patch — shape validated inside via validatePolicyUpdate. */
  patch: unknown;
}

export type ApplyAgentPolicyPatchResult =
  | {
      ok: true;
      agent_id: string;
      /** Raw merged policy object as persisted to metadata.policy. */
      stored_policy: Record<string, unknown>;
      /** Effective policy under the machine-level ceiling. */
      effective_policy: EffectiveAgentPolicy;
      /** The subset of `valid` keys that actually changed (new !== previous). */
      changed_fields: string[];
      /** Previous values for the `changed_fields` keys, by key. */
      previous: Record<string, unknown>;
      /** New values for the `changed_fields` keys, by key. */
      next: Record<string, unknown>;
    }
  | { ok: false; reason: "invalid_input"; detail: string }
  | { ok: false; reason: "not_in_tenant"; agent_id: string }
  | { ok: false; reason: "agent_not_found"; agent_id: string }
  | { ok: false; reason: "invalid_patch"; errors: PolicyValidationError[] }
  | { ok: false; reason: "empty_patch" };

/**
 * Apply a validated policy patch to one agent's metadata.policy.
 * Every hosted/local/dashboard policy-write path funnels through this.
 */
export async function applyAgentPolicyPatch(
  sql: SqlTag,
  params: ApplyAgentPolicyPatchParams,
): Promise<ApplyAgentPolicyPatchResult> {
  const tenantId = (params.tenantId || "").trim();
  const agentId = (params.agentId || "").trim();
  if (!tenantId || !agentId) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: "tenantId and agentId are required (non-empty strings)",
    };
  }

  // Tenant ownership — per VERITY_AGENT_TENANTS. Do not leak
  // cross-tenant agent existence information.
  if (!agentBelongsToTenant(agentId, tenantId)) {
    return { ok: false, reason: "not_in_tenant", agent_id: agentId };
  }

  // Shared validator — same canonical rules the direct route uses.
  // Returns `{valid: Partial<AgentPolicy>, errors: []}`.
  const { valid, errors } = validatePolicyUpdate(params.patch);
  if (errors.length > 0) {
    return { ok: false, reason: "invalid_patch", errors };
  }
  if (Object.keys(valid).length === 0) {
    return { ok: false, reason: "empty_patch" };
  }

  // Agent profile row MUST exist. The canonical helper never
  // auto-creates profile rows — that was the old remote-dispatch
  // footgun (blind INSERT on `agent_profiles` when the row was
  // missing). Agents come into existence via /connect; policy
  // writes target existing rows only.
  const [current] = await sql`
    SELECT metadata FROM agent_profiles WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;
  if (!current) {
    return { ok: false, reason: "agent_not_found", agent_id: agentId };
  }
  const currentMetadata = (current.metadata && typeof current.metadata === "object")
    ? current.metadata as Record<string, unknown>
    : {};
  const currentPolicy = (currentMetadata.policy && typeof currentMetadata.policy === "object")
    ? currentMetadata.policy as Record<string, unknown>
    : {};

  // Compute `previous` / `next` / `changed_fields` against the valid
  // patch (not the raw input) so reported previous values match what
  // the canonical validator accepted. null is a meaningful value here
  // (visible_projects: null = all), so we do NOT normalize undefined
  // and null together — `in` is the check.
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const k of Object.keys(valid)) {
    const prev = (k in currentPolicy) ? currentPolicy[k] : undefined;
    const nxt = (valid as Record<string, unknown>)[k];
    previous[k] = prev;
    next[k] = nxt;
    if (JSON.stringify(prev) !== JSON.stringify(nxt)) changed.push(k);
  }

  // Targeted jsonb_set — only touches metadata.policy, sibling
  // metadata keys (llm_overrides, etc.) are preserved. Same pattern
  // as POST /agent/:id/policy so the three surfaces converge on the
  // exact same persisted mutation.
  await sql`
    UPDATE agent_profiles
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{policy}',
      COALESCE(metadata->'policy', '{}'::jsonb) || ${sql.json(valid)}
    ),
    updated_at = now()
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `;

  // Governance journal + sync nudge. `journalGovernance` internally
  // calls `nudgeSyncScheduler`, so one call covers both. Best-effort
  // post-mutation under F11's awaitable contract.
  journalGovernance(sql, `agent_policy:${agentId}`, `tenant:${tenantId}`).catch((e: any) =>
    console.error("[agent-policy-write] journalGovernance failed:", e?.message),
  );

  // Re-read after the atomic update so the response reflects the
  // actual persisted state, not the stale pre-read.
  const [freshRow] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}`;
  const freshMetadata = (freshRow?.metadata && typeof freshRow.metadata === "object")
    ? freshRow.metadata as Record<string, unknown>
    : null;
  const storedPolicy = (freshMetadata?.policy && typeof freshMetadata.policy === "object")
    ? freshMetadata.policy as Record<string, unknown>
    : {};

  const effective = resolveAgentPolicy(
    agentId,
    freshMetadata,
    resolveTenantSettings(),
  );

  return {
    ok: true,
    agent_id: agentId,
    stored_policy: storedPolicy,
    effective_policy: effective,
    changed_fields: changed,
    previous,
    next,
  };
}
