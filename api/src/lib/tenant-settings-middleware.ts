/**
 * Hono middleware for tenant-settings policy gates.
 *
 * Reads resolved tenant settings once per request (from config file via
 * the shared resolver) and provides two middleware functions:
 *
 *   requireVoEnabled()     — returns 503 `vo_disabled` when vo_enabled=false
 *   requirePublicResonance() — returns empty results when public_resonance=off
 *                              (operator-scoped calls bypass the gate)
 *
 * Settings are re-read from the config file on every request (the resolver
 * is cheap — one fs.readFileSync + JSON.parse). This means config changes
 * take effect on the next request without api restart.
 *
 * The middleware does NOT cache settings across requests. That is intentional:
 * an operator editing the config file during a live session should see the
 * change immediately, without a restart cycle.
 */

import type { Context, Next } from "hono";
import { resolveTenantSettings } from "./runtime-profile";
import { getAccessContext, resolveAgentTenant } from "./access";
import { resolveAgentPolicy } from "./agent-policy";
import { sql } from "../db";
import { GLOBAL_SPACE_ID } from "./spaces";
import { errorJson } from "./error-envelope";

/**
 * Middleware: block memory/bootstrap operations when vo_enabled=false.
 *
 * Returns a structured `vo_disabled` envelope so agents get a clear signal
 * that VO is paused, not broken. MCP tools inherit this behavior because
 * they call the same HTTP routes.
 *
 * Apply to: /memory/*, /remember, /bootstrap/*
 * Do NOT apply to: /health, /ops/*, /connect, /search, /context, /federation/*
 */
export function requireVoEnabled() {
  return async (c: Context, next: Next) => {
    const settings = resolveTenantSettings();
    if (!settings.vo_enabled) {
      return errorJson(c, "vo_disabled", {
        details: { error_class: "vo_disabled" },
        hint:
          "Memory, bootstrap, and recall operations are paused. " +
          "Set vo_enabled: true or run `vo settings set vo_enabled true` to re-enable.",
      });
    }
    await next();
  };
}

/**
 * Middleware: gate public-graph reads when public_resonance=off.
 *
 * When the machine setting says public_resonance: "off", non-operator
 * requests to /search and /context get empty result sets. This is a
 * machine-wide ceiling — MCP rung-4 tools inherit it because they call
 * the same routes.
 *
 * Operator-scoped calls bypass the gate so operators can still query the
 * public graph for maintenance purposes.
 *
 * Apply to: /search, /context
 * Do NOT apply to: /memory/recall (tenant-private, not public-graph)
 */
export function gatePublicResonance() {
  return async (c: Context, next: Next) => {
    const settings = resolveTenantSettings();
    if (settings.public_resonance === "off") {
      const access = getAccessContext(c);
      // Operator bypass: operators can still query the public graph.
      if (access.scope === "operator") {
        await next();
        return;
      }
      // Non-operator: return empty results matching the real route shape
      // so clients reusing the normal schema don't break. MCP rung-4
      // passes these bodies through directly, so the shapes must match
      // what the real routes return.
      const urlPath = new URL(c.req.url).pathname;
      if (urlPath === "/search" || urlPath.startsWith("/search")) {
        // Match /search contract: query, count, mode, results, model
        const q = c.req.query("q") || "";
        return c.json({
          query: q,
          count: 0,
          mode: "semantic",
          results: [],
          public_resonance: "off",
        });
      }
      // /context — match real /context contract shape
      const q = c.req.query("q") || "";
      const depth = c.req.query("depth") || "shallow";
      return c.json({
        ok: true,
        query: q,
        depth,
        node_count: 0,
        confidence_grade: null,
        coverage_honest: "public resonance is off — no public knowledge included",
        sections: { nodes: [], edges: [], interconnections: [], bridges: {}, ontology: {}, skills: [], drill: {} },
        applicable_schemas: [],
        layer_distribution: {},
        ontology: null,
        regrounding: null,
        ms: 0,
        public_resonance: "off",
      });
    }
    await next();
  };
}

/**
 * Middleware: enforce per-agent recall_scope on public-read routes.
 *
 * Runs AFTER gatePublicResonance() in the middleware stack. If the machine
 * gate already fired (public_resonance=off), the request never reaches
 * this gate. This gate only narrows within the machine ceiling — it
 * restricts specific agents whose recall_scope=tenant_private from seeing
 * public-graph results even when the machine allows resonance=assist.
 *
 * IMPORTANT: this gate does NOT short-circuit with empty responses.
 * Instead, it narrows the access context's `spaceIds` to exclude
 * GLOBAL_SPACE_ID, so the downstream route handlers still run and
 * return real tenant-private results — only the public overlay portion
 * is excluded at the SQL level. This preserves tenant-private
 * search/context behavior while suppressing only the public portion.
 *
 * Precedence:
 *   1. Machine public_resonance=off → gatePublicResonance fires, this gate is never reached
 *   2. Operator scope → bypass (operators are not subject to agent policy)
 *   3. No agentId → no agent-level narrowing (anonymous/plain-beta proceed normally)
 *   4. Agent recall_scope=tenant_private → narrow spaceIds to exclude public
 *   5. Default/agent recall_scope=tenant_and_public → proceed normally
 *
 * Apply to: /search, /context (same routes as gatePublicResonance)
 * Do NOT apply to: /memory/recall (tenant-private, not public-graph)
 */
export function enforceRecallScope() {
  return async (c: Context, next: Next) => {
    const access = getAccessContext(c);

    // Operators bypass agent policy.
    if (access.scope === "operator") {
      await next();
      return;
    }

    // No agentId → no per-agent narrowing. Anonymous and plain-beta
    // requests are governed only by the machine-level gate above.
    if (!access.agentId) {
      await next();
      return;
    }

    // Look up agent policy.
    const machineSettings = resolveTenantSettings();
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`
        SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}
      `;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch {
      // DELIBERATE fail-open, scoped to READS only. The narrowing this middleware applies
      // merely EXCLUDES the public overlay (GLOBAL_SPACE_ID) for tenant_private agents — so a
      // failed lookup here can at most over-expose PUBLIC graph data (not secret tenant data)
      // to a tenant_private agent. Failing closed (narrowing for everyone) would instead break
      // legitimate public reads for the common tenant_and_public agents on a transient DB blip.
      // The authority-bearing path — WRITES — fails CLOSED (see enforceWritePermission below).
      await next();
      return;
    }

    const effective = resolveAgentPolicy(access.agentId, storedMetadata, machineSettings);

    if (effective.recall_scope === "tenant_private") {
      // Narrow spaceIds to exclude GLOBAL_SPACE_ID. The route handlers
      // use `access.spaceIds` in their SQL queries to scope results.
      // Removing the global space means public-overlay nodes are excluded
      // at the query level, while tenant-private results flow normally.
      if (access.spaceIds) {
        const narrowed = access.spaceIds.filter((s) => s !== GLOBAL_SPACE_ID);
        if (narrowed.length > 0) {
          // Replace the cached access context with the narrowed spaceIds.
          c.set("access", { ...access, spaceIds: narrowed });
        }
        // If narrowed is empty (no tenant space — edge case for a beta
        // token with agentId but no tenantId), don't narrow to [] because
        // that would cause SQL errors. Fall through to default behavior.
      }
    }

    await next();
  };
}

/**
 * Middleware: enforce per-agent write_permission policy.
 *
 * Runs AFTER requireVoEnabled() in the middleware stack, so machine-level
 * vo_enabled=false fires first. Only consulted when the request has a
 * non-null agentId (from token resolution in access.ts). Operators are
 * not subject to agent policy.
 *
 * Apply to local write/effect routes: /memory/write, /memory/update,
 * /remember, manual day-journal writes/retracts, and routine run/dry-run.
 * Do NOT apply to reads such as /memory/retract, /memory/forget,
 * /memory/recall, or day-journal search/export.
 */
export function enforceWritePermission(db: typeof sql = sql) {
  return async (c: Context, next: Next) => {
    const access = getAccessContext(c);

    // Operators bypass agent policy.
    if (access.scope === "operator") {
      await next();
      return;
    }

    // No agentId → no per-agent policy to enforce. Defaults apply
    // (write_permission=allowed), so the request proceeds.
    if (!access.agentId) {
      await next();
      return;
    }

    // Look up the agent's stored policy.
    const machineSettings = resolveTenantSettings();
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await db`
        SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}
      `;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch {
      // SECURITY: fail CLOSED. A failed agent_profiles lookup means we cannot verify the
      // agent's write_permission — and an explicitly write-DENIED agent must not be able to
      // write just because the policy DB hiccupped (the old fail-open allowed exactly that).
      // This matches the stricter hosted write-policy posture. 503 (not 403) signals a
      // transient condition so a legitimate caller can retry.
      return errorJson(c, "service_unavailable", {
        details: { error_class: "agent_policy_unavailable", agent_id: access.agentId },
        hint: "Agent write policy is temporarily unavailable; the write was not applied. Please retry.",
      });
    }

    const effective = resolveAgentPolicy(access.agentId, storedMetadata, machineSettings);

    if (effective.write_permission === "denied") {
      return errorJson(c, "agent_write_denied", {
        details: { error_class: "agent_write_denied", agent_id: access.agentId },
        hint:
          `Local write and effect operations are blocked by agent policy. ` +
          `An operator can change this with: vo agent-policy set ${access.agentId} write_permission allowed`,
      });
    }

    await next();
  };
}
