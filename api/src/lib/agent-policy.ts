/**
 * Agent policy resolver — per-agent restrictions under the machine-level ceiling.
 *
 * Storage authority: `agent_profiles.metadata.policy` (JSONB).
 * Mutation authority: `POST /agent/:id/policy` (operator-only in first cut).
 * Identity binding: `access.agentId` from token resolution in access.ts.
 *
 * First-cut controls:
 *   write_permission: "allowed" | "denied"   (enforced on write routes)
 *   recall_scope: "tenant_private" | "tenant_and_public"  (persisted, not enforced yet)
 *
 * Precedence: Operator > Machine settings > Agent policy > Default
 * Machine-level vo_enabled and public_resonance fire BEFORE agent policy
 * is ever consulted (in the Hono middleware stack).
 */

import type postgres from "postgres";
import { resolveTenantSettings, type TenantSettings } from "./runtime-profile";
import { agentBelongsToTenant } from "./agent-override";

// ── Types ──────────────────────────────────────────────────────────────

export type WritePermission = "allowed" | "denied";
export type RecallScope = "tenant_private" | "tenant_and_public";

export interface AgentPolicy {
  write_permission: WritePermission;
  recall_scope: RecallScope;
  /** Project addrs this agent can see. null = all (default). */
  visible_projects: string[] | null;
}

export interface EffectiveAgentPolicy extends AgentPolicy {
  agent_id: string;
  /** Which fields came from the stored policy vs defaults. */
  sources: Record<keyof AgentPolicy, "stored" | "default" | "machine_ceiling">;
}

export const VALID_WRITE_PERMISSIONS: readonly WritePermission[] = ["allowed", "denied"];
export const VALID_RECALL_SCOPES: readonly RecallScope[] = ["tenant_private", "tenant_and_public"];

export const WRITABLE_POLICY_KEYS = ["write_permission", "recall_scope", "visible_projects"] as const;
export type WritablePolicyKey = (typeof WRITABLE_POLICY_KEYS)[number];

// ── Defaults ───────────────────────────────────────────────────────────

function defaultRecallScope(machineSettings: TenantSettings): RecallScope {
  return machineSettings.public_resonance === "off" ? "tenant_private" : "tenant_and_public";
}

// ── Resolver ───────────────────────────────────────────────────────────

/**
 * Parse and validate raw policy from `agent_profiles.metadata.policy`.
 * Returns only the valid fields; invalid values are silently dropped
 * (the effective policy will show "default" for those fields).
 */
function parseStoredPolicy(raw: unknown): Partial<AgentPolicy> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const data = raw as Record<string, unknown>;
  const result: Partial<AgentPolicy> = {};

  if (typeof data.write_permission === "string" &&
    (VALID_WRITE_PERMISSIONS as readonly string[]).includes(data.write_permission)) {
    result.write_permission = data.write_permission as WritePermission;
  }
  if (typeof data.recall_scope === "string" &&
    (VALID_RECALL_SCOPES as readonly string[]).includes(data.recall_scope)) {
    result.recall_scope = data.recall_scope as RecallScope;
  }

  // visible_projects: string array of addrs, or null (= all)
  if ("visible_projects" in data) {
    if (data.visible_projects === null) {
      result.visible_projects = null;
    } else if (Array.isArray(data.visible_projects)) {
      // VO-DASHBOARD-HOSTED-VISIBLE-PROJECTS-PR-1 audit fix:
      //   Align read-side normalization with the write-side validator.
      //   `validatePolicyUpdate` already normalizes an empty/malformed
      //   array to `null` (= all projects) before the jsonb_set write,
      //   but legacy rows predating that rule (or any write path that
      //   bypassed it) may still contain `[]` or `[7, null]`. A
      //   filtered-empty result carries no operator-intended selection
      //   and MUST surface as `null` so downstream enforcement
      //   (resolveAgentPolicy + hosted render) treat it as "all
      //   projects" instead of "nothing visible" or a bogus editable
      //   empty state.
      const kept = data.visible_projects.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      result.visible_projects = kept.length === 0 ? null : kept;
    }
  }

  return result;
}

/**
 * Resolve effective agent policy for a given agentId.
 *
 * @param agentId - The agent's identity (from access.agentId).
 * @param storedMetadata - The full `metadata` JSONB from the agent_profiles row (or null if no row).
 * @param machineSettings - The resolved machine-level tenant settings.
 * @returns The effective policy with sources for each field.
 */
export function resolveAgentPolicy(
  agentId: string,
  storedMetadata: Record<string, unknown> | null,
  machineSettings: TenantSettings,
): EffectiveAgentPolicy {
  const stored = parseStoredPolicy(storedMetadata?.policy);
  const sources: Record<keyof AgentPolicy, "stored" | "default" | "machine_ceiling"> = {
    write_permission: "default",
    recall_scope: "default",
    visible_projects: "default",
  };

  // write_permission: stored value or default "allowed"
  let writePermission: WritePermission = "allowed";
  if (stored.write_permission !== undefined) {
    writePermission = stored.write_permission;
    sources.write_permission = "stored";
  }

  // recall_scope: stored value, but capped by machine ceiling
  const defaultScope = defaultRecallScope(machineSettings);
  let recallScope: RecallScope = defaultScope;
  if (stored.recall_scope !== undefined) {
    // Machine ceiling: if public_resonance=off, recall_scope can't be
    // tenant_and_public regardless of what the stored policy says.
    if (machineSettings.public_resonance === "off" && stored.recall_scope === "tenant_and_public") {
      recallScope = "tenant_private";
      sources.recall_scope = "machine_ceiling";
    } else {
      recallScope = stored.recall_scope;
      sources.recall_scope = "stored";
    }
  }

  // visible_projects: stored value or null (= all)
  let visibleProjects: string[] | null = null;
  if (stored.visible_projects !== undefined) {
    visibleProjects = stored.visible_projects;
    sources.visible_projects = "stored";
  }

  return {
    agent_id: agentId,
    write_permission: writePermission,
    recall_scope: recallScope,
    visible_projects: visibleProjects,
    sources,
  };
}

type SqlTag = ReturnType<typeof postgres>;

export interface HostedAgentApplyPolicyResult {
  allowed: boolean;
  reason?: "agent_not_in_tenant" | "policy_not_stored" | "write_permission_denied" | "policy_unreadable";
  effective?: EffectiveAgentPolicy;
}

/**
 * Local apply-time gate for hosted-MCP-origin commands. This is stricter
 * than resolveAgentPolicy()'s general default because hosted-agent remote
 * writes require an explicit local stored allow; the default "allowed"
 * value is valid for local first-party routes, not for delegated hosted
 * apply authority.
 */
export async function resolveHostedAgentApplyPolicy(
  sql: SqlTag,
  tenantId: string,
  agentId: string,
): Promise<HostedAgentApplyPolicyResult> {
  try {
    if (!agentBelongsToTenant(agentId, tenantId)) {
      return { allowed: false, reason: "agent_not_in_tenant" };
    }
    const [row] = await sql`
      SELECT metadata
      FROM agent_profiles
      WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
    `;
    const storedMetadata =
      row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : null;
    const effective = resolveAgentPolicy(agentId, storedMetadata, resolveTenantSettings());
    if (effective.sources.write_permission !== "stored") {
      return { allowed: false, reason: "policy_not_stored", effective };
    }
    if (effective.write_permission !== "allowed") {
      return { allowed: false, reason: "write_permission_denied", effective };
    }
    return { allowed: true, effective };
  } catch {
    return { allowed: false, reason: "policy_unreadable" };
  }
}

// ── Validation for writes ──────────────────────────────────────────────

export interface PolicyValidationError {
  field: string;
  message: string;
}

/**
 * Validate a policy update payload. Returns errors for unknown keys or
 * invalid values. Used by the `POST /agent/:id/policy` route.
 */
export function validatePolicyUpdate(body: unknown): {
  valid: Partial<AgentPolicy>;
  errors: PolicyValidationError[];
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: {}, errors: [{ field: "body", message: "Must be a JSON object" }] };
  }

  const data = body as Record<string, unknown>;
  const valid: Partial<AgentPolicy> = {};
  const errors: PolicyValidationError[] = [];

  for (const key of Object.keys(data)) {
    if (!(WRITABLE_POLICY_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: `Unknown policy key. Valid keys: ${WRITABLE_POLICY_KEYS.join(", ")}` });
      continue;
    }
  }

  if ("write_permission" in data) {
    const v = data.write_permission;
    if (typeof v === "string" && (VALID_WRITE_PERMISSIONS as readonly string[]).includes(v)) {
      valid.write_permission = v as WritePermission;
    } else {
      errors.push({
        field: "write_permission",
        message: `Must be one of: ${VALID_WRITE_PERMISSIONS.join(", ")}. Got: ${JSON.stringify(v)}`,
      });
    }
  }

  if ("recall_scope" in data) {
    const v = data.recall_scope;
    if (typeof v === "string" && (VALID_RECALL_SCOPES as readonly string[]).includes(v)) {
      valid.recall_scope = v as RecallScope;
    } else {
      errors.push({
        field: "recall_scope",
        message: `Must be one of: ${VALID_RECALL_SCOPES.join(", ")}. Got: ${JSON.stringify(v)}`,
      });
    }
  }

  if ("visible_projects" in data) {
    const v = data.visible_projects;
    if (v === null) {
      valid.visible_projects = null;
    } else if (Array.isArray(v)) {
      const addrs = v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (addrs.length === 0) {
        // Empty array → normalize to null (= "all"). The contract is:
        // null = all projects visible (default), non-empty array = explicit
        // narrowed selection. An empty array has no defined meaning and
        // would fall through the read path silently.
        valid.visible_projects = null;
      } else {
        valid.visible_projects = addrs;
      }
    } else {
      errors.push({
        field: "visible_projects",
        message: `Must be a string array of project addrs, or null. Got: ${JSON.stringify(v)}`,
      });
    }
  }

  return { valid, errors };
}
