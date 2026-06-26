/**
 * /connect — The onboarding endpoint
 * 
 * First thing a new agent calls. Returns everything needed to understand
 * VO and start getting value immediately. Creates agent profile automatically.
 * The "holy shit" moment for new agents.
 *
 * GET /connect
 * GET /connect?agent=art-1&capabilities=coding,research&platform=custom
 */

import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { allowedRegistryAccessLevels, assertAgentSelfOrOperator, getAccessContext, hasBetaAccess, isSafeAgentId, looksLikeVoSecret, resolveAgentTenant, visibleSpaceIds } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { ARCHIVED_PYRAMIDS } from "../lib/visible-graph";

const connect = new Hono();

const MAX_CAPABILITIES = 10;
const MAX_CAPABILITY_LENGTH = 50;

function sanitizeCapabilities(raw: string[]): string[] {
  return raw.slice(0, MAX_CAPABILITIES).map(s => s.slice(0, MAX_CAPABILITY_LENGTH));
}

connect.get("/", async (c) => {
  const access = getAccessContext(c);
  const spaceIds = visibleSpaceIds(access) || [GLOBAL_SPACE_ID];
  const accessLevels = allowedRegistryAccessLevels(c);
  const agentId = c.req.query("agent");
  const capabilitiesStr = c.req.query("capabilities");
  const platform = c.req.query("platform");

  // Reject empty agent param (present but empty string)
  if (agentId !== undefined && !agentId) {
    return errorJson(c, "invalid_request", { message: "agent parameter must not be empty" });
  }
  // Validate agent-id shape BEFORE the auth gate so a malformed/oversized or
  // token-looking id is rejected identically whether or not the caller holds a
  // valid beta token (no token-validity oracle) and BEFORE any DB read/write.
  // Mirrors the portal/account credential-mint controls.
  if (agentId !== undefined) {
    if (!isSafeAgentId(agentId)) {
      return errorJson(c, "invalid_request", {
        message: "agent must be 1-80 chars: letters, numbers, underscore, dot, colon, or hyphen",
      });
    }
    if (looksLikeVoSecret(agentId)) {
      return errorJson(c, "invalid_request", { message: "agent must not contain a token-looking value" });
    }
  }

  let agentBlock: any = undefined;
  let isFirstTime = false;
  let isReturning = false;

  // Handle agent identity
  if (agentId) {
    if (!hasBetaAccess(c)) {
      return errorJson(c, "unauthorized");
    }
    if (access.agentId && !assertAgentSelfOrOperator(c, agentId)) {
      return errorJson(c, "forbidden");
    }
    // Only the agent itself (a mapped agent credential) or an operator may read
    // an existing agent's private stats or mutate its profile. An unmapped beta
    // token (no agent identity) may still register a brand-new agent_id during
    // onboarding, but must not act as — or disclose — an existing foreign agent.
    const canActAsAgent = assertAgentSelfOrOperator(c, agentId);
    const agentTenant = resolveAgentTenant(c, agentId);
    // A plain shared beta token (no mapped tenant AND no mapped agent identity)
    // resolves to the "system" sentinel tenant. Such a caller must not be able to
    // spray unbounded rows into agent_profiles. Only persist a new profile when the
    // caller maps to a real tenant or can act as the agent (operator / mapped agent
    // credential). Unmapped shared-token callers still receive the full onboarding
    // payload below — we simply do not write a row for them.
    const mayPersistProfile = canActAsAgent || agentTenant !== "system";

    // Check if agent exists (in the caller's tenant)
    const [existing] = await sql`SELECT * FROM agent_profiles WHERE tenant_id = ${agentTenant} AND agent_id = ${agentId}`;

    if (!existing) {
      // First time — create profile
      const capabilities = capabilitiesStr ? sanitizeCapabilities(capabilitiesStr.split(",").map(s => s.trim()).filter(Boolean)) : [];
      const metadata: any = {};
      if (platform) metadata.platform = platform;
      metadata.connected_at = new Date().toISOString();

      if (mayPersistProfile) {
        await sql`
          INSERT INTO agent_profiles (tenant_id, agent_id, capabilities, metadata)
          VALUES (${agentTenant}, ${agentId}, ${capabilities}, ${sql.json(metadata)})
          ON CONFLICT (tenant_id, agent_id) DO NOTHING`;
      }

      isFirstTime = true;
      agentBlock = {
        first_time: true,
        your_profile: {
          agent_id: agentId,
          capabilities,
          tip: `Add ?agent=${agentId} to your /context and /agenda calls. The graph will learn your interests and personalize recommendations.`,
        },
      };
    } else if (canActAsAgent) {
      // Returning agent
      isReturning = true;
      await sql`UPDATE agent_profiles SET last_seen = now() WHERE tenant_id = ${agentTenant} AND agent_id = ${agentId}`;

      // What happened since last visit?
      const [newStimuli] = await sql`
        SELECT COUNT(*)::int as n
        FROM stimuli
        WHERE created_at > ${existing.last_seen}
          ${access.scope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}`;
      const [mutations] = await sql`
        SELECT COUNT(*)::int as n
        FROM graph_mutations
        WHERE created_at > ${existing.last_seen}
          ${access.scope === "operator" ? sql`` : sql`AND space_id = ANY(${spaceIds}::text[])`}`;

      const total = existing.success_count + existing.failure_count;
      agentBlock = {
        welcome_back: true,
        since_last_visit: {
          new_stimuli: newStimuli.n,
          graph_mutations: mutations.n,
          your_stats: {
            queries: existing.query_count,
            signals: existing.signal_count,
            success_rate: total > 0 ? parseFloat((existing.success_count / total).toFixed(2)) : null,
          },
        },
      };

      // Update capabilities if provided
      if (capabilitiesStr) {
        const capabilities = sanitizeCapabilities(capabilitiesStr.split(",").map(s => s.trim()).filter(Boolean));
        await sql`UPDATE agent_profiles SET capabilities = ${capabilities} WHERE tenant_id = ${agentTenant} AND agent_id = ${agentId}`;
      }
    } else {
      // Caller holds a beta token with no mapped identity for this existing
      // agent: do not disclose its stats or mutate it. Neutral acknowledgement.
      isReturning = true;
      agentBlock = { welcome_back: true };
    }
  }

  // Live world state
  const [heated] = access.scope === "operator"
    ? await sql`SELECT COUNT(*)::int as n FROM nodes WHERE stimulus_heat > 0 AND visibility <> 'deleted'`
    : await sql`
        SELECT COUNT(*)::int as n
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.stimulus_heat > 0
          AND n.visibility <> 'deleted'
          AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
      `;
  const [activeStimuli] = access.scope === "operator"
    ? await sql`
        SELECT COUNT(*)::int as n
        FROM stimuli
        WHERE processed = true
          AND created_at > now() - interval '24 hours'
      `
    : await sql`
        SELECT COUNT(*)::int as n
        FROM stimuli s
        LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE s.processed = true
          AND s.created_at > now() - interval '24 hours'
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            s.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              n.addr IS NOT NULL
              AND n.space_id = ${GLOBAL_SPACE_ID}
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
      `;
  // MT14: a beta caller sees only their own tenant's agent population; operators see all.
  const [agentCount] = access.scope === "operator"
    ? await sql`SELECT COUNT(*)::int as n FROM agent_profiles`
    : await sql`SELECT COUNT(*)::int as n FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)}`;
  const [lastEvent] = access.scope === "operator"
    ? await sql`
        SELECT content, source, created_at
        FROM stimuli
        WHERE source != 'agent'
        ORDER BY created_at DESC
        LIMIT 1
      `
    : await sql`
        SELECT s.content, s.source, s.created_at
        FROM stimuli s
        LEFT JOIN nodes n ON n.addr = s.node_addr
        LEFT JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE s.source != 'agent'
          AND s.space_id = ANY(${spaceIds}::text[])
          AND (
            s.space_id <> ${GLOBAL_SPACE_ID}
            OR (
              n.addr IS NOT NULL
              AND n.space_id = ${GLOBAL_SPACE_ID}
              AND n.visibility = 'public'
              AND r.access_level = ANY(${accessLevels}::text[])
            )
          )
        ORDER BY s.created_at DESC
        LIMIT 1
      `;
  const [nodeCount] = access.scope === "operator"
    ? await sql`SELECT COUNT(*)::int as n FROM nodes WHERE visibility <> 'deleted'`
    : await sql`
        SELECT COUNT(*)::int as n
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.space_id = ANY(${spaceIds}::text[])
          AND n.visibility <> 'deleted'
          AND n.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )
      `;
  const [edgeCount] = access.scope === "operator"
    ? await sql`
        SELECT COUNT(*)::int as n
        FROM edges e
        JOIN nodes nf ON nf.addr = e.from_addr
        JOIN nodes nt ON nt.addr = e.to_addr
        WHERE nf.visibility <> 'deleted'
          AND nt.visibility <> 'deleted'
      `
    : await sql`
        SELECT COUNT(*)::int as n
        FROM edges e
        JOIN nodes nf ON nf.addr = e.from_addr
        JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
        JOIN nodes nt ON nt.addr = e.to_addr
        JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
        WHERE e.space_id = ANY(${spaceIds}::text[])
          AND nf.space_id = ANY(${spaceIds}::text[])
          AND nt.space_id = ANY(${spaceIds}::text[])
          AND nf.visibility <> 'deleted'
          AND nt.visibility <> 'deleted'
          AND (
            nf.space_id <> ${GLOBAL_SPACE_ID}
            OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
          )
          AND (
            nt.space_id <> ${GLOBAL_SPACE_ID}
            OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
          )
      `;

  // Trending domains: top parent categories from heated nodes
  const trendingRaw = await sql`
    SELECT p.label AS domain, COUNT(*)::int AS n
    FROM nodes n
    JOIN nodes p ON p.addr = n.parent_addr
    JOIN registry rn ON rn.pyramid_id = n.pyramid_id
    JOIN registry rp ON rp.pyramid_id = p.pyramid_id
    WHERE n.stimulus_heat > 0
      AND n.visibility <> 'deleted'
      AND p.visibility <> 'deleted'
      ${access.scope === "operator"
        ? sql``
        : sql`
          AND n.space_id = ANY(${spaceIds}::text[])
          AND p.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND rn.access_level = ANY(${accessLevels}::text[]))
          )
          AND (
            p.space_id <> ${GLOBAL_SPACE_ID}
            OR (p.visibility = 'public' AND rp.access_level = ANY(${accessLevels}::text[]))
          )
        `}
    GROUP BY p.label
    ORDER BY n DESC
    LIMIT 3`;
  const trendingDomains = trendingRaw.map((r: any) => r.domain);

  // Read tenant settings to decide whether public-discovery guidance is
  // included in the system prompt. When public_resonance is off, we omit
  // the EXPLORE section so newly connecting agents do not learn to call
  // /search and /context (those routes return empty results anyway).
  const { resolveTenantSettings } = await import("../lib/runtime-profile");
  const tenantSettings = resolveTenantSettings();

  // Determine whether public-discovery endpoints should be surfaced.
  // Two gates can suppress them:
  //   1. Machine-level: public_resonance=off
  //   2. Agent-level: recall_scope=tenant_private (for this specific agent)
  let publicDiscoveryAvailable = tenantSettings.public_resonance !== "off";
  if (publicDiscoveryAvailable && access.scope === "beta" && access.agentId) {
    // Check per-agent recall_scope. This mirrors the runtime gate
    // in enforceRecallScope() — if the agent's effective recall_scope
    // is tenant_private, public-discovery guidance is omitted from
    // the system prompt so the agent doesn't learn to call routes
    // that will return empty results.
    const { resolveAgentPolicy } = await import("../lib/agent-policy");
    let agentMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") {
        agentMetadata = row.metadata as Record<string, unknown>;
      }
    } catch { /* DB error → keep public discovery available */ }
    const effective = resolveAgentPolicy(access.agentId, agentMetadata, tenantSettings);
    if (effective.recall_scope === "tenant_private") {
      publicDiscoveryAvailable = false;
    }
  }

  // The "see the light" system prompt — inject this and any AI becomes VO-aware
  const exploreSection = publicDiscoveryAvailable
    ? `\nEXPLORE: For broader knowledge beyond memory:
  GET /context?q=<your+task>&depth=deep${agentId ? `&agent=${agentId}` : ''} — ranked knowledge with world-event awareness.
  GET /search?q=concept — semantic + keyword hybrid search.\n`
    : "";

  const systemPrompt = `You have access to Verity One, a local-first knowledge graph and memory system at ${c.req.url.split('/connect')[0]}. Your local node holds your authoritative memory across sessions; the hosted surface is an optional, derived mirror — keep durable truth in your local node.

RECALL FIRST: When your task depends on prior decisions, preferences, or corrections:
  POST /memory/recall {"query":"what was decided about X"} — get scored tenant memories with conflict detection.
${exploreSection}
ACT: When you need a concrete next step:
  GET /ground?goal=<your+goal>${agentId ? `&agent=${agentId}` : ''} — grounded action path with memory constraints.
  GET /run/<addr> — prerequisites checked, commands ready, confidence scored.

REMEMBER: When you learn something durable (on your local node this writes through immediately; on this hosted mirror it is a queued intent your local node applies on next sync):
  POST /memory/write {"kind":"decision","assertion":"what you learned","source":"agent_inferred"} — record a durable memory.
  POST /memory/retract {"addr":"PJ.0.3.X","reason":"why"} — mark a memory as no longer valid.

DAILY: GET /agenda${agentId ? `?agent=${agentId}` : ''} — what matters today, personalized to your history.
SIGNAL: POST /signal/agent {"type":"success|failure","context":"what happened"${agentId ? `,"agent":"${agentId}"` : ''}} — your feedback improves the graph.
WATCH: POST /watch {"agent":"${agentId || 'your-id'}","filter":"domain:security"} then GET /watch/${agentId || 'your-id'} for digests.
TIPS: Use technology nouns, not problem descriptions. Add &compact=true for 90% smaller responses.

Memory is the highest-value surface — prior decisions, corrections, and preferences that the model alone would not know. Durable writes belong in your local node (authoritative); on the hosted mirror, writes are queued intents the local node later applies.`;

  const response: any = {
    ok: true,
    system_prompt: systemPrompt,
    verity_one: {
      what: `Verity One is local-first: your own node holds your authoritative knowledge + memory. This public surface is an optional mirror — a living knowledge graph that reacts to the world (${nodeCount.n} nodes, ${edgeCount.n} edges). Discover here; keep your durable truth in your local node.`,
      why: "You get smarter. Your queries improve the graph. The graph improves your next query.",
      loop: "World events → heat nodes → you query heated knowledge → your signals improve it → better for everyone.",
      endpoints: {
        // Discovery — understand the graph
        schema: { method: "GET", path: "/schema", what: "Full ontology: node types, edge types, properties, confidence semantics, and example queries." },
        // Public-discovery endpoints are omitted when resonance is off or
        // the agent's recall_scope is tenant_private (same gate as system
        // prompt EXPLORE section and quick_start).
        ...(publicDiscoveryAvailable ? {
          context: { method: "GET", path: "/context?q=your+question&depth=shallow|deep|full&agent=id", what: "Ask anything. Get ranked knowledge with real-time world-event awareness." },
          search: { method: "GET", path: "/search?q=concept", what: "Semantic + keyword hybrid search across all visible nodes." },
        } : {}),
        capabilities: { method: "GET", path: "/capabilities?domain=optional", what: "Paginated capability directory filterable by domain." },
        // Memory — recall and write tenant-local memory
        memory_recall: { method: "POST", path: "/memory/recall", body: '{"query":"what was decided about X"}', what: "Recall scored tenant memories with conflict detection and freshness ranking.", auth: "tenant" },
        memory_write: { method: "POST", path: "/memory/write", body: '{"kind":"decision","assertion":"what you learned","source":"agent_inferred"}', what: "Save a durable memory to tenant space.", auth: "tenant" },
        memory_read: { method: "GET", path: "/memory/:addr", what: "Read a specific memory with full lifecycle state.", auth: "tenant" },
        memory_retract: { method: "POST", path: "/memory/retract", body: '{"addr":"PJ.0.3.X","reason":"why"}', what: "Mark a memory as no longer valid.", auth: "tenant" },
        // Action — do things
        ground: { method: "GET", path: "/ground?goal=task", what: "Authenticated compact truth/action packet with memory constraints for high-confidence execution.", auth: "beta" },
        run: { method: "GET", path: "/run/:addr", what: "Authenticated action-ready guide with prerequisites, commands, and readiness checks.", auth: "beta" },
        // Intelligence — synthesize
        insight: { method: "GET", path: "/insight?q=question&depth=deep", what: "Authenticated multi-angle AI synthesis with [ADDR] citations.", auth: "beta" },
        trends: { method: "GET", path: "/trends", what: "First-class trend dashboard: emerging, active, graduating, recent deaths." },
        briefing: { method: "GET", path: "/briefing", what: "Intelligence briefing. What changed, what's hot, system health." },
        agenda: { method: "GET", path: "/agenda?agent=id&capabilities=a,b", what: "Authenticated priority items, trends, stale areas.", auth: "beta" },
        // Feedback — improve the graph
        signal: { method: "POST", path: "/signal/agent", body: '{"type":"success|failure|query","context":"what happened","nodes":["addr"],"agent":"id"}', what: "Tell the graph what worked. It learns from you — and other agents benefit.", auth: "beta" },
        watch: { method: "POST", path: "/watch", body: '{"agent":"id","filter":"domain:security"}', what: "Subscribe to topics. Check /watch/:id for updates since last check.", auth: "beta" },
        // Identity
        profile: { method: "GET", path: "/agent/:id", what: "Authenticated profile view. See how the graph sees you.", auth: "beta" },
      },
    },
    right_now: {
      heated_nodes: heated.n,
      active_stimuli_24h: activeStimuli.n,
      trending_domains: trendingDomains.length > 0 ? trendingDomains : ["general"],
      connected_agents: agentCount.n,
      last_world_event: lastEvent
        ? `${lastEvent.source}: ${lastEvent.content.slice(0, 100)} — ${timeSince(lastEvent.created_at)}`
        : "No recent events",
    },
    query_tips: {
      what_works: "Technology names and noun-heavy queries. 'Twilio SMS webhook' outperforms 'how do I send a text message'.",
      what_fails: "Natural language questions and problem descriptions. 'vercel deploy failing' gives noise; 'vercel next.js deploy' gives results.",
      use_compact: "Add &compact=true to /context calls — 90% smaller responses, same actionability. Drill into /nodes/:addr for full detail.",
      best_pattern: "GET /context?q=technology+noun+noun&depth=deep&compact=true",
      failures: "GET /failures — browse all known failure patterns by domain, without needing to know the topic first.",
    },
    quick_start: publicDiscoveryAvailable
      ? [
          `GET /schema — understand node types, edge types, and confidence semantics`,
          `GET /context?q=your+task+here&depth=deep&compact=true${agentId ? `&agent=${agentId}` : ''} — discover knowledge for your task`,
          `GET /failures — browse known failure patterns and anti-patterns`,
          `GET /trends — see what the world is heating right now`,
          `GET /agenda${agentId ? `?agent=${agentId}` : ''} — priorities, trends, and maintenance signals`,
          `POST /signal/agent {"type":"query","context":"exploring the graph"${agentId ? `,"agent":"${agentId}"` : ''}} — let the graph feel you`,
        ]
      : [
          `POST /memory/recall {"query":"what was decided about X"} — recall tenant memories`,
          `POST /memory/write {"kind":"decision","assertion":"...","source":"agent_inferred"} — write a durable memory`,
          `GET /agenda${agentId ? `?agent=${agentId}` : ''} — priorities and maintenance signals`,
        ],
    // Active machine-level tenant settings (TENANT-CONTROL-SURFACE-DESIGN-PR-1)
    tenant_settings: {
      vo_enabled: tenantSettings.vo_enabled,
      public_resonance: tenantSettings.public_resonance,
    },
  };

  // Surface effective agent policy when the request has a resolved agentId
  // (from token mapping in access.ts, NOT from the ?agent= query param).
  // The ?agent= param is for personalization; policy binds to the token identity.
  if (access.scope === "beta" && access.agentId) {
    const { resolveAgentPolicy } = await import("../lib/agent-policy");
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`
        SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}
      `;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch { /* DB error → skip policy block, don't break /connect */ }

    const effective = resolveAgentPolicy(access.agentId, storedMetadata, tenantSettings);
    (response as any).agent_policy = {
      agent_id: access.agentId,
      write_permission: effective.write_permission,
      recall_scope: effective.recall_scope,
      recall_scope_note: "enforced on /search and /context",
      sources: effective.sources,
    };
  }

  if (agentBlock) {
    Object.assign(response, agentBlock);
  }

  return c.json(response);
});

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default connect;
