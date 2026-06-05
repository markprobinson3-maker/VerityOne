/**
 * /memory — Canonical memory API for Verity One.
 *
 * Routes:
 *   POST /memory/write    — create a new memory
 *   POST /memory/recall   — recall memories (stub, PR-4)
 *   POST /memory/update   — update an existing memory
 *   POST /memory/retract  — retract a memory (mark invalid)
 *   POST /memory/forget   — archive a memory (hide from recall)
 *   GET  /memory/:addr    — read a single memory by address
 */

import { Hono } from "hono";
import { sql } from "../db";
import { embedQuery, toVectorStr, embedTextForInsert, embeddingTextForNode } from "../lib/embed";
import { getAccessContext, allowedRegistryAccessLevels, resolveAgentTenant } from "../lib/access";
import {
  validateWriteRequest,
  validateUpdateRequest,
  type MemoryWriteRequest,
  type MemoryKind,
  type SourceRef,
  MEMORY_KINDS,
  computeSourceLinkStatus,
} from "../lib/memory-contract";
import { resolveFederationMetadata } from "../lib/federated-memory";
import { detectConflict, insertRegistry, isProtectedMemoryForAutomatedDormancy, logEvent, updateRegistryStatus } from "../lib/memory-lifecycle";
import { compileRecall } from "../lib/recall-compiler";
import { routedRecall } from "../lib/domain-router";
import { readRemoteProvenanceHeaders } from "../lib/remote-provenance";
import { resolveAgentPolicy } from "../lib/agent-policy";
import { resolveTenantSettings } from "../lib/runtime-profile";
import { enrichWithPublicResonance, type PublicResonanceBlock } from "../lib/public-resonance";
import { errorJson } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { writeEdge } from "../lib/edge-mutations";
import { classifyMemoryWriteQuality, lexicalOverlapStats } from "../lib/memory-quality";
// F12: route maturity_stage origin through the canonical helper so a future
// change to the canonical default propagates without per-call-site edits.
import { coalesceMaturityStage } from "@verity-one/graph-shape";

const memory = new Hono();

// ── Helpers ──

const BOOTSTRAP_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;

function edgeTypeForKind(kind: MemoryKind): string {
  switch (kind) {
    case "correction": return "constrains";
    case "decision": return "grounds";
    case "preference": return "guides";
    default: return "informs";
  }
}

async function autoWireMemory(addr: string, vecStr: string, edgeType: string, agentId: string | null) {
  try {
    const candidates = await sql`
    SELECT
      n.addr,
      round((1 - (n.embedding_hv <=> ${vecStr}::halfvec))::numeric, 3)::float AS weight
    FROM nodes n
    WHERE n.node_type != 'memory'
      AND n.embedding_hv IS NOT NULL
      AND n.visibility = 'public'
      AND (1 - (n.embedding_hv <=> ${vecStr}::halfvec)) > 0.55
    ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
    LIMIT 3
  `;

    if (candidates.length === 0) return;
    await sql.begin(async (tx) => {
      for (const candidate of candidates) {
        await writeEdge(sql, {
          fromAddr: addr,
          toAddr: String(candidate.addr),
          edgeType,
          layer: 0,
          confidence: 0.75,
          weight: Number(candidate.weight),
          bidirectional: false,
          provenance: { agent: agentId || "memory-api", auto_wired: true },
        }, { tx: tx as any });
      }
    });
  } catch (e: any) {
    console.error("[memory/auto-wire] edge insert failed:", e?.message);
  }
}

// ── POST /memory/write ──

memory.post("/write", async (c) => {
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("application/json")) {
    return errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" });
  }

  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const { remoteOrigin, remoteClientClass, remoteRequestId, isRemoteWrite } =
    readRemoteProvenanceHeaders(c.req);

  const body = await c.req.json().catch(() => null);
  const validation = validateWriteRequest(body);
  if (!validation.valid) {
    return errorJson(c, "validation_failed", { details: { errors: validation.errors } });
  }

  const req = validation.data;
  const spaceId = `tenant:${access.tenantId}`;
  const label = req.subject || req.assertion.slice(0, 80);
  const federation = resolveFederationMetadata(req.federation);
  const sourceRefs: SourceRef[] | undefined =
    Array.isArray(req.source_refs) && req.source_refs.length > 0
      ? (req.source_refs as SourceRef[])
      : undefined;

  const quality = classifyMemoryWriteQuality({
    kind: req.kind,
    source: req.source,
    subject: req.subject,
    assertion: req.assertion,
    whyItMatters: req.why_it_matters,
    evidence: req.evidence,
    tags: req.tags,
    sourceRefs,
  });
  if (quality.verdict === "reject") {
    return errorJson(c, "validation_failed", {
      message: "Memory rejected by quality gate. Rewrite it as durable, specific product knowledge or mark it user_accepted after human review.",
      details: {
        errors: quality.reasons.map((reason) => ({ field: "assertion", message: reason })),
        memory_quality: quality,
      },
    });
  }

  // Resolve project_addr: explicit > bootstrap_context > none
  let projectSource: "explicit" | "bootstrap_context" | null = null;
  const rawBody = body as Record<string, unknown>;
  if (!req.project_addr && rawBody.bootstrap_context && typeof rawBody.bootstrap_context === "object") {
    const ctx = rawBody.bootstrap_context as Record<string, unknown>;
    const issuedAt = typeof ctx.issued_at === "string" ? Date.parse(ctx.issued_at) : NaN;
    const issuedAtValid = Number.isFinite(issuedAt);
    const issuedAtFresh = issuedAtValid && (Date.now() - issuedAt) <= BOOTSTRAP_CONTEXT_TTL_MS;
    if (
      typeof ctx.project_addr === "string" &&
      typeof ctx.tenant_id === "string" &&
      ctx.tenant_id === access.tenantId &&
      ctx.confidence === "high" &&
      issuedAtFresh
    ) {
      req.project_addr = ctx.project_addr as string;
      projectSource = "bootstrap_context";
    }
  }
  if (req.project_addr && !projectSource) {
    projectSource = "explicit";
  }

  // Validate project_addr if provided (regardless of source)
  let projectLabel: string | null = null;
  if (req.project_addr) {
    const [projectNode] = await sql`
      SELECT addr, label, pyramid_id, depth, space_id
      FROM nodes
      WHERE addr = ${req.project_addr}
        AND space_id = ${spaceId}
        AND pyramid_id = 'PROJECTS'
        AND depth = 1
        AND dormant_at IS NULL
        AND visibility <> 'deleted'
    `;
    if (!projectNode) {
      return errorJson(c, "invalid_request", {
        message: "Invalid project_addr: must be an active PROJECTS depth-1 root node in the same tenant space.",
      });
    }
    projectLabel = projectNode.label;
  }

  // Build substance (preserves backward compatibility with existing memory consumers)
  const substance: Record<string, unknown> = {
    description: req.assertion,
    memory_type: req.kind,
    maturity_stage: coalesceMaturityStage(undefined),
    created_at: new Date().toISOString(),
  };
  if (req.why_it_matters) substance.why_it_matters = req.why_it_matters;
  if (req.evidence) substance.evidence = req.evidence;
  if (req.scope) substance.scope = req.scope;
  if (req.tags && req.tags.length > 0) substance.tags = req.tags;
  if (req.project_addr) substance.project_addr = req.project_addr;
  if (req.effective_at) substance.effective_at = req.effective_at;
  if (req.expires_at) substance.expires_at = req.expires_at;
  if (req.supersedes) substance.supersedes = req.supersedes;
  substance.federation = federation;

  // Mark source provenance
  substance.source_kind = req.source;
  substance.accepted_by_user = req.source === "user_accepted";
  substance.memory_quality = {
    review_category: quality.review_category,
    review_priority: quality.review_priority,
    reasons: quality.reasons,
  };

  // Compute source_link_status at write time — honest about whether a source exists
  const sourceLinkStatus = computeSourceLinkStatus(req.kind, sourceRefs);
  substance.source_link_status = sourceLinkStatus;

  // F7 query/document split:
  //   - embedQuery on the assertion produces a query-task vector,
  //     used only for the duplicate-search comparison below.
  //   - embedTextForInsert on the canonical node text produces a
  //     document-task vector, used only as the stored embedding_hv.
  const queryVec = await embedQuery(req.assertion);
  const queryVecStr = toVectorStr(queryVec);
  const storedEmbed = await embedTextForInsert(
    embeddingTextForNode(label.slice(0, 120), substance),
  );

  // Dedup check uses the query-task vector against the document-task
  // vectors stored in nodes (Gemini's task-aware embeddings align
  // query↔document for retrieval). Project-aware: only collapse against an
  // existing memory in the SAME project scope (or both tenant-wide), so an
  // identical assertion in a DIFFERENT project is not silently suppressed —
  // different project context is different memory.
  const [dupCheck] = await sql`
    SELECT addr, label, 1 - (embedding_hv <=> ${queryVecStr}::halfvec) as similarity
    FROM nodes
    WHERE space_id = ${spaceId} AND node_type = 'memory'
      AND embedding_hv IS NOT NULL
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
      AND COALESCE(substance->>'project_addr', '') = ${req.project_addr ?? ''}
    ORDER BY embedding_hv <=> ${queryVecStr}::halfvec
    LIMIT 1
  `;
  if (dupCheck && parseFloat(dupCheck.similarity) > 0.85) {
    // Merge any new source_refs into the existing memory rather than discarding them.
    // This preserves traceability when the same fact is cited from a new source.
    let sourceRefsMerged = 0;
    if (sourceRefs && sourceRefs.length > 0) {
      const [existingNode] = await sql`
        SELECT source_refs, substance->>'memory_type' as kind,
               substance->>'source_link_status' as existing_source_link_status
        FROM nodes
        WHERE addr = ${dupCheck.addr}
          AND visibility <> 'deleted'
      `;
      const existingRefs: SourceRef[] = Array.isArray(existingNode?.source_refs)
        ? (existingNode.source_refs as SourceRef[])
        : [];
      const existingPaths = new Set(existingRefs.filter((r) => r.path).map((r) => r.path));
      const existingUrls = new Set(existingRefs.filter((r) => r.url).map((r) => r.url));
      const toAdd = sourceRefs.filter((r) => {
        if (r.path && existingPaths.has(r.path)) return false;
        if (r.url && existingUrls.has(r.url)) return false;
        return true;
      });
      if (toAdd.length > 0) {
        const merged = [...existingRefs, ...toAdd];
        const existingKind = (existingNode?.kind || req.kind) as MemoryKind;
        const newStatus = computeSourceLinkStatus(existingKind, merged);
        await sql`
          UPDATE nodes SET
            source_refs = ${sql.json(merged)},
            substance = substance || ${sql.json({ source_link_status: newStatus })}::jsonb,
            updated_at = now()
          WHERE addr = ${dupCheck.addr}
            AND visibility <> 'deleted'
        `;
        sourceRefsMerged = toAdd.length;
      }
    }
    return c.json({
      ok: true,
      deduplicated: true,
      existing_addr: dupCheck.addr,
      existing_label: dupCheck.label,
      similarity: parseFloat(parseFloat(dupCheck.similarity).toFixed(3)),
      message: "Skipped — semantically similar memory already exists",
      ...(sourceRefsMerged > 0 ? { source_refs_merged: sourceRefsMerged } : {}),
    });
  }

  if (req.supersedes) {
    const [target] = await sql`
      SELECT
        n.addr,
        n.dormant_at,
        n.pinned,
        n.substance,
        mr.status,
        mr.kind,
        mr.source_kind,
        mr.accepted_by_user
      FROM nodes n
      LEFT JOIN memory_registry mr
        ON mr.addr = n.addr
        AND mr.tenant_id = ${access.tenantId}
      WHERE n.addr = ${req.supersedes}
        AND n.space_id = ${spaceId}
        AND n.node_type = 'memory'
        AND n.visibility <> 'deleted'
      LIMIT 1
    `;
    if (!target) {
      return errorJson(c, "invalid_request", { message: "supersedes target was not found for this tenant." });
    }
    if (target.dormant_at || target.status !== "active") {
      return errorJson(c, "invalid_request", { message: "supersedes target must be an active memory." });
    }
    if (isProtectedMemoryForAutomatedDormancy({
      kind: target.kind,
      source_kind: target.source_kind,
      accepted_by_user: target.accepted_by_user,
      pinned: target.pinned,
      substance: target.substance,
    })) {
      return errorJson(c, "invalid_request", { message: "supersedes target is protected and requires the review path." });
    }
  }

  // Atomic write: node + source_refs + supersession + registry + created event
  const correlationId = ((c as any).get("correlation_id") as string | undefined) ?? null;
  const { writeMemory } = await import("../lib/memory-write");
  const result = await writeMemory(sql, {
    tenantId: access.tenantId,
    spaceId,
    label: label.slice(0, 120),
    substance,
    confidence: req.confidence ?? 0.80,
    embed: storedEmbed,
    kind: req.kind,
    source: req.source,
    sourceRefs,
    supersedes: req.supersedes,
    actor: access.agentId || "memory-api",
    agentId: access.agentId || null,
    effectiveAt: req.effective_at,
    expiresAt: req.expires_at ?? undefined,
    isRemoteWrite,
    remoteOrigin: remoteOrigin ?? undefined,
    remoteClientClass: remoteClientClass ?? undefined,
    remoteRequestId: remoteRequestId ?? undefined,
    correlationId,
  });

  // F9: operator-facing audit row (the lifecycle row in memory_events
  // is written transactionally by writeMemory itself).
  await auditMutation(c, sql, {
    kind: "memory_created",
    tenantId: access.tenantId,
    actor: access.agentId || "memory-api",
    actorKind: "tenant_session",
    addr: result.addr,
    eventData: { source: req.source, kind: req.kind },
  });

  // Auto-wire edges
  const edgeType = edgeTypeForKind(req.kind);
  // autoWireMemory walks similarity against existing nodes — query-task
  // vector is the right shape for that comparison.
  autoWireMemory(result.addr, queryVecStr, edgeType, access.agentId);

  // Project association edge
  if (req.project_addr) {
    void writeEdge(sql, {
      fromAddr: result.addr,
      toAddr: req.project_addr,
      edgeType: "part_of",
      layer: 0,
      confidence: 0.95,
      weight: 1.0,
      bidirectional: false,
      provenance: { agent: access.agentId || "memory-api", project_association: true },
      spaceId,
    }).catch((e) => console.error("[memory/project-edge] failed:", e?.message));
  }

  // Contradiction detection: check for semantically similar but divergent memories in same kind
  let contradictions_detected = 0;
  (async () => {
    try {
      const similar = await sql`
        SELECT addr, label,
          substance->>'description' as assertion,
          substance->>'memory_type' as kind,
          substance->'federation' as federation,
          1 - (embedding_hv <=> ${queryVecStr}::halfvec) as similarity
        FROM nodes
        WHERE space_id = ${spaceId}
          AND node_type = 'memory'
          AND addr != ${result.addr}
          AND dormant_at IS NULL
          AND visibility <> 'deleted'
          AND substance->>'memory_type' = ${req.kind}
          AND embedding_hv IS NOT NULL
        ORDER BY embedding_hv <=> ${queryVecStr}::halfvec
        LIMIT 3
      `;
      for (const row of similar) {
        const sim = parseFloat(row.similarity);
        if (sim < 0.7) continue; // Not similar enough to be a contradiction
        const lexical = lexicalOverlapStats(
          `${label} ${req.assertion}`,
          `${row.label || ""} ${row.assertion || ""}`,
        );
        // High similarity alone is not enough: require a shared lexical/entity
        // anchor before surfacing a contradiction. Otherwise unrelated memories
        // in nearby embedding neighborhoods create noisy conflict warnings.
        if (lexical.has_anchor && lexical.jaccard < 0.7) {
          // Memory-Health PR 4: route through detectConflict (the single canonical
          // writer) so the pair order is normalized and reverse-order duplicates are
          // impossible — no raw memory_conflicts INSERT here.
          await detectConflict(
            sql,
            access.tenantId!, // handler guards `!access.tenantId` at entry; narrowing is lost in this nested scope
            result.addr,
            row.addr,
            "contradiction",
            "New memory '" + label.slice(0, 60) + "' may contradict existing '" + (row.label || "").slice(0, 60) + "' (similarity=" + sim.toFixed(2) + ", jaccard=" + lexical.jaccard.toFixed(2) + ", shared_terms=" + lexical.shared_terms.slice(0, 5).join("|") + ", shared_entities=" + lexical.shared_entities.slice(0, 5).join("|") + ")",
          );
          contradictions_detected++;
        }
      }
    } catch (e: any) {
      console.error("[memory/contradiction] detection failed:", e?.message);
    }
  })();

  return c.json({
    ok: true,
    addr: result.addr,
    label: label.slice(0, 120),
    kind: req.kind,
    source: req.source,
    space_id: spaceId,
    edges_wired: edgeType,
    source_link_status: sourceLinkStatus,
    ...(sourceRefs ? { source_refs_count: sourceRefs.length } : {}),
    ...(req.project_addr ? { project_addr: req.project_addr, project_label: projectLabel, project_source: projectSource } : {}),
    federation,
    ...(isRemoteWrite ? { remote_origin: remoteOrigin, remote_client_class: remoteClientClass } : {}),
  });
});

// ── POST /memory/recall (stub — full implementation in PR-4) ──

memory.post("/recall", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const body = await c.req.json().catch(() => null);
  const query = (body?.query || "").trim();
  if (!query) {
    return errorJson(c, "invalid_request", { message: "query field required" });
  }
  if (query.length > 2000) {
    return errorJson(c, "invalid_request", { message: "query too long (max 2000 chars)" });
  }

  const spaceId = `tenant:${access.tenantId}`;
  const kinds = Array.isArray(body?.kinds)
    ? body.kinds.filter((k: string) => MEMORY_KINDS.includes(k as MemoryKind))
    : undefined;

  const startMs = Date.now();
  const projectAddr = typeof body?.project_addr === "string" ? body.project_addr.trim() : undefined;

  // Resolve agent-policy visible_projects for this request.
  // Operators bypass; requests without agentId use no filtering.
  let visibleProjectAddrs: string[] | null = null;
  if (access.scope !== "operator" && access.agentId) {
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch { /* DB error → no filtering */ }
    const machineSettings = resolveTenantSettings();
    const effective = resolveAgentPolicy(access.agentId, storedMetadata, machineSettings);
    visibleProjectAddrs = effective.visible_projects;
  }

  const machineSettings = resolveTenantSettings();
  // Resolve effective recall_scope for active resonance decision
  let effectiveRecallScope: string = "tenant_and_public";
  if (access.agentId) {
    let storedMeta: Record<string, unknown> | null = null;
    try {
      // Reuse the metadata already fetched above for visible_projects if it exists
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") storedMeta = row.metadata as Record<string, unknown>;
    } catch { /* */ }
    effectiveRecallScope = resolveAgentPolicy(access.agentId, storedMeta, machineSettings).recall_scope;
  }

  const result = await compileRecall(sql, {
    query,
    tenantId: access.tenantId,
    spaceId,
    kinds,
    projectAddr,
    visibleProjectAddrs,
    agentId: access.agentId,
    limit: body?.limit,
    includeInactive: body?.include_inactive === true,
    suppressOverlays: effectiveRecallScope === "tenant_private",
  });

  // Active public resonance enrichment (per PUBLIC-RESONANCE-ACTIVE-DESIGN-PR-1):
  // Attach advisory public-graph block only when:
  //   1. machine public_resonance=active
  //   2. agent recall_scope allows public content
  //   3. NOT a scoped-empty visible_projects denial (no-widen contract)
  let publicResonance: PublicResonanceBlock | null = null;
  const scopedEmptyDenial = visibleProjectAddrs && projectAddr &&
    !visibleProjectAddrs.includes(projectAddr);
  if (
    machineSettings.public_resonance === "active" &&
    effectiveRecallScope !== "tenant_private" &&
    !scopedEmptyDenial &&
    result._embedding
  ) {
    try {
      publicResonance = await enrichWithPublicResonance(sql, result._embedding, allowedRegistryAccessLevels(c));
    } catch { /* non-fatal — skip enrichment */ }
  }

  // Strip internal _embedding from the response
  const { _embedding, ...responseResult } = result;

  return c.json({
    ok: true,
    query,
    ...responseResult,
    ...(visibleProjectAddrs ? { visible_projects_enforced: true } : {}),
    ...(publicResonance ? { public_resonance: publicResonance } : {}),
    ms: Date.now() - startMs,
  });
});

// ── POST /memory/recall/routed ──
// Domain-aware recall routing. Same contract as /memory/recall plus a `routing` trace field.
// Does NOT modify /memory/recall behavior — this is an additive endpoint.

memory.post("/recall/routed", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const body = await c.req.json().catch(() => null);
  const query = (body?.query || "").trim();
  if (!query) {
    return errorJson(c, "invalid_request", { message: "query field required" });
  }
  if (query.length > 2000) {
    return errorJson(c, "invalid_request", { message: "query too long (max 2000 chars)" });
  }

  const spaceId = `tenant:${access.tenantId}`;
  const kinds = Array.isArray(body?.kinds)
    ? body.kinds.filter((k: string) => MEMORY_KINDS.includes(k as MemoryKind))
    : undefined;
  // Optional project_addr: used for workspace intent routing (from bootstrap context)
  const projectAddr = typeof body?.project_addr === "string" ? body.project_addr.trim() : undefined;

  // Resolve agent-policy visible_projects (same pattern as /memory/recall)
  let visibleProjectAddrs: string[] | null = null;
  if (access.scope !== "operator" && access.agentId) {
    let storedMetadata: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") {
        storedMetadata = row.metadata as Record<string, unknown>;
      }
    } catch { /* DB error → no filtering */ }
    const machineSettings = resolveTenantSettings();
    const effective = resolveAgentPolicy(access.agentId, storedMetadata, machineSettings);
    visibleProjectAddrs = effective.visible_projects;
  }

  const machineSettingsRouted = resolveTenantSettings();
  let effectiveRecallScopeRouted: string = "tenant_and_public";
  if (access.agentId) {
    let storedMeta: Record<string, unknown> | null = null;
    try {
      const [row] = await sql`SELECT metadata FROM agent_profiles WHERE tenant_id = ${resolveAgentTenant(c, access.agentId)} AND agent_id = ${access.agentId}`;
      if (row?.metadata && typeof row.metadata === "object") storedMeta = row.metadata as Record<string, unknown>;
    } catch { /* */ }
    effectiveRecallScopeRouted = resolveAgentPolicy(access.agentId, storedMeta, machineSettingsRouted).recall_scope;
  }

  const startMs = Date.now();
  const result = await routedRecall(sql, query, {
    tenantId: access.tenantId,
    spaceId,
    kinds,
    projectAddr,
    visibleProjectAddrs,
    agentId: access.agentId,
    limit: body?.limit,
    includeInactive: body?.include_inactive === true,
    suppressOverlays: effectiveRecallScopeRouted === "tenant_private",
  });

  // Active public resonance on routed recall (same contract as /memory/recall)
  let publicResonanceRouted: PublicResonanceBlock | null = null;
  const scopedEmptyRouted = result.routing?.warnings?.some(
    (w: string) => w.includes("visible_projects") || w.includes("scoped empty"),
  );
  if (
    machineSettingsRouted.public_resonance === "active" &&
    effectiveRecallScopeRouted !== "tenant_private" &&
    !scopedEmptyRouted &&
    result._embedding
  ) {
    try {
      publicResonanceRouted = await enrichWithPublicResonance(sql, result._embedding, allowedRegistryAccessLevels(c));
    } catch { /* non-fatal */ }
  }

  const { _embedding: _embRouted, ...routedResponseResult } = result;

  return c.json({
    ok: true,
    query,
    ...routedResponseResult,
    ...(publicResonanceRouted ? { public_resonance: publicResonanceRouted } : {}),
    ms: Date.now() - startMs,
  });
});

// ── POST /memory/update ──

memory.post("/update", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const body = await c.req.json().catch(() => null);
  const addr = (body?.addr || "").trim();
  if (!addr) {
    return errorJson(c, "invalid_request", { message: "addr field required" });
  }

  const validation = validateUpdateRequest(body);
  if (!validation.valid) {
    return errorJson(c, "validation_failed", { details: { errors: validation.errors } });
  }

  const correlationId = ((c as any).get("correlation_id") as string | undefined) ?? null;
  // Memory-Health PR 2: explicit user/operator approval contract. Absent => the
  // protected-rewrite + confidence-increase gates apply (agents cannot silently
  // rewrite a user-accepted memory or self-boost confidence).
  const approveMaterialChange = body?.approve_material_change === true;
  const { updateMemory } = await import("../lib/memory-update");
  const result = await updateMemory(
    sql,
    access.tenantId,
    addr,
    validation.data,
    access.agentId || "memory-api",
    { correlationId, approveMaterialChange },
  );

  if (!result.ok) {
    // Gate blocks carry their own error code (validation_failed → HTTP 400,
    // approval_required → HTTP 403, via httpStatusFor). 409 = optimistic-concurrency.
    const code = result.code ?? (result.status === 409 ? "state_mismatch" : "memory_not_found");
    return errorJson(c, code, {
      message: result.error,
      ...(result.reasons ? { details: { reasons: result.reasons } } : {}),
    });
  }

  await auditMutation(c, sql, {
    kind: "memory_updated",
    tenantId: access.tenantId,
    actor: access.agentId || "memory-api",
    actorKind: "tenant_session",
    addr: result.addr || addr,
    eventData: { updated_fields: result.updated_fields ?? [], approved: approveMaterialChange },
  });

  return c.json({ ok: true, addr: result.addr, updated_fields: result.updated_fields });
});

// ── POST /memory/retract ──

memory.post("/retract", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const body = await c.req.json().catch(() => null);
  const addr = (body?.addr || "").trim();
  const reason = (body?.reason || "").trim();
  if (!addr) {
    return errorJson(c, "invalid_request", { message: "addr field required" });
  }

  const correlationIdRetract = ((c as any).get("correlation_id") as string | undefined) ?? null;
  const { retractMemory } = await import("../lib/memory-retract");
  const result = await retractMemory(
    sql,
    access.tenantId,
    addr,
    access.agentId || "memory-api",
    reason || undefined,
    { correlationId: correlationIdRetract },
  );

  if (!result.ok) {
    return errorJson(c, "memory_not_found", { message: result.error });
  }

  await auditMutation(c, sql, {
    kind: "memory_retracted",
    tenantId: access.tenantId,
    actor: access.agentId || "memory-api",
    actorKind: "tenant_session",
    addr: result.addr || addr,
    eventData: reason ? { reason } : undefined,
  });

  return c.json({ ok: true, addr: result.addr, status: result.status });
});

// ── POST /memory/forget ──

memory.post("/forget", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const body = await c.req.json().catch(() => null);
  const addr = (body?.addr || "").trim();
  if (!addr) {
    return errorJson(c, "invalid_request", { message: "addr field required" });
  }

  const correlationIdForget = ((c as any).get("correlation_id") as string | undefined) ?? null;
  const { forgetMemory } = await import("../lib/memory-forget");
  const result = await forgetMemory(
    sql,
    access.tenantId,
    addr,
    access.agentId || "memory-api",
    { correlationId: correlationIdForget },
  );

  if (!result.ok) {
    return errorJson(c, "memory_not_found", { message: result.error });
  }

  await auditMutation(c, sql, {
    kind: "memory_forgotten",
    tenantId: access.tenantId,
    actor: access.agentId || "memory-api",
    actorKind: "tenant_session",
    addr: result.addr || addr,
  });

  return c.json({ ok: true, addr: result.addr, status: result.status });
});

// ── GET /memory/_capabilities ─────────────────────────────────────────
// Diagnostic "which memory routes does this running API know about"
// endpoint — VO-MCP-REVIEW-API-AVAILABILITY-PR-1.
//
// The interop-proof runner probes this BEFORE it classifies the
// MCP `review`/`audit` cells so the older catch-all shape
// (`/memory/:addr` returning `memory_not_found` for an unknown
// sub-path like `review` or `:addr/audit`) can be disambiguated
// from a genuine missing memory.
//
// This endpoint is diagnostic ONLY:
//   - It lists the routes THIS running API has registered.
//   - It does NOT prove the MCP tool/resource call succeeds —
//     the proof cell still requires the actual call to return
//     a usable response before marking `pass`.
//   - It does NOT expose any tenant data and does NOT touch
//     the database.
//
// Auth posture: same as every other `/memory/*` route — tenant
// context required. Follows existing middleware; no new public
// inventory surface.
//
// Must be registered BEFORE `/:addr` so the `:addr` catch-all
// does NOT swallow `_capabilities`.

const MEMORY_API_CAPABILITIES_SCHEMA = "vo-memory-api-capabilities/v1" as const;

memory.get("/_capabilities", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }
  return c.json({
    ok: true,
    schema: MEMORY_API_CAPABILITIES_SCHEMA,
    routes: {
      "GET /memory/_capabilities": true,
      "GET /memory/review": true,
      "GET /memory/events/recent": true,
      "GET /memory/:addr": true,
      "GET /memory/:addr/events": true,
      "GET /memory/:addr/audit": true,
    },
    note:
      "Diagnostic route inventory for the running API. Presence here means THIS API has registered the route; it does NOT imply the MCP-facing surface for that route succeeds for a given input.",
  });
});

// ── GET /memory/review ──────────────────────────────────────────────
// Read-only review queue: active tenant memories pending human approval.
// Must be registered BEFORE /:addr to avoid wildcard matching "review".

memory.get("/review", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const rawLimit = parseInt(c.req.query("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const cursor = c.req.query("cursor") || null;

  const { listReviewableMemories } = await import("../lib/memory-audit");
  const page = await listReviewableMemories(sql, access.tenantId, limit, cursor);

  return c.json({
    ok: true,
    items: page.items,
    count: page.items.length,
    // total = the whole review backlog + a keyset cursor, so a large backlog is never
    // silently truncated and the operator always knows if more pages remain.
    total: page.total,
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    note: "Active agent_inferred tenant memories pending human review. Approve: POST /memory/approve or vo memory approve <addr>",
  });
});

// ── GET /memory/events/recent ─────────────────────────────────────────
// Tenant-wide recent lifecycle events for the dashboard activity feed.
// Must be registered BEFORE /:addr to avoid wildcard matching "events".

memory.get("/events/recent", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const rawLimit = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

  const { listRecentTenantEvents } = await import("../lib/memory-lifecycle");
  const items = await listRecentTenantEvents(sql as any, access.tenantId, limit);

  return c.json({
    ok: true,
    items,
    count: items.length,
  });
});

// ── GET /memory/:addr ──

memory.get("/:addr", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const addr = c.req.param("addr");
  const spaceId = `tenant:${access.tenantId}`;

  const [row] = await sql`
    SELECT addr, label, confidence, created_at, updated_at, dormant_at,
      substance->>'description' as assertion,
      substance->>'memory_type' as kind,
      substance->>'source_kind' as source,
      substance->>'why_it_matters' as why_it_matters,
      substance->>'evidence' as evidence,
      substance->>'scope' as scope,
      substance->>'effective_at' as effective_at,
      substance->>'expires_at' as expires_at,
      substance->>'supersedes' as supersedes,
      COALESCE(substance->>'superseded_by_addr', substance->>'superseded_by') as superseded_by,
      COALESCE(substance->>'lifecycle_status', substance->>'status') as status,
      substance->'tags' as tags,
      substance->'federation' as federation,
      substance->>'retracted_reason' as retracted_reason,
      substance->>'project_addr' as project_addr,
      substance->>'created_at' as memory_created_at,
      substance->>'accepted_by_user' as accepted_by_user,
      substance->'promoted_from' as promoted_from,
      substance->'approval' as approval
    FROM nodes
    WHERE addr = ${addr} AND space_id = ${spaceId} AND node_type = 'memory' AND visibility <> 'deleted'
  `;

  if (!row) {
    return errorJson(c, "memory_not_found");
  }

  const status = row.dormant_at
    ? (row.status || "archived")
    : row.superseded_by
      ? "superseded"
      : "active";

  // Resolve project label if associated
  let projectLabel: string | null = null;
  if (row.project_addr) {
    const [project] = await sql`SELECT label FROM nodes WHERE addr = ${row.project_addr} AND visibility <> 'deleted'`;
    if (project) projectLabel = project.label;
  }

  return c.json({
    ok: true,
    addr: row.addr,
    label: row.label,
    kind: row.kind || "context",
    source: row.source || "agent_inferred",
    status,
    assertion: row.assertion,
    why_it_matters: row.why_it_matters || null,
    evidence: row.evidence || null,
    scope: row.scope || "tenant",
    confidence: parseFloat(row.confidence),
    effective_at: row.effective_at || row.memory_created_at || row.created_at,
    expires_at: row.expires_at || null,
    supersedes: row.supersedes || null,
    superseded_by: row.superseded_by || null,
    tags: row.tags || [],
    retracted_reason: row.retracted_reason || null,
    project_addr: row.project_addr || null,
    project_label: projectLabel,
    created_at: row.created_at,
    updated_at: row.updated_at,
    federation: resolveFederationMetadata(row.federation),
    accepted_by_user: row.accepted_by_user === "true",
    promoted_from: row.promoted_from || null,
    approval: row.approval || null,
  });
});

// ── GET /memory/:addr/events ──────────────────────────────────────────
// Read lifecycle event history for a tenant memory. Read-only.

memory.get("/:addr/events", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const addr = c.req.param("addr");
  const spaceId = `tenant:${access.tenantId}`;
  const rawLimit = parseInt(c.req.query("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;

  // Verify the memory exists in this tenant's space
  const [exists] = await sql`
    SELECT 1 FROM nodes WHERE addr = ${addr} AND space_id = ${spaceId} AND node_type = 'memory' AND visibility <> 'deleted'
  `;
  if (!exists) {
    return errorJson(c, "memory_not_found");
  }

  const { getMemoryEvents } = await import("../lib/memory-lifecycle");
  const events = await getMemoryEvents(sql as any, addr, access.tenantId, limit);

  return c.json({
    ok: true,
    addr,
    events,
    count: events.length,
  });
});

// ── GET /memory/:addr/audit ───────────────────────────────────────────
// Compact read-only audit summary: identity + trust + provenance + events.

memory.get("/:addr/audit", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const addr = c.req.param("addr");
  const rawLimit = parseInt(c.req.query("limit") || "10", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;

  const { getMemoryAuditSnapshot } = await import("../lib/memory-audit");
  const snapshot = await getMemoryAuditSnapshot(sql, access.tenantId, addr, limit);

  if (!snapshot) {
    return errorJson(c, "memory_not_found");
  }

  return c.json({ ok: true, ...snapshot });
});

// ── POST /memory/promote-overlay ──────────────────────────────────────
// Explicitly promote an imported public overlay to tenant-local memory.

memory.post("/promote-overlay", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required for promotion." });
  }

  const body = await c.req.json().catch(() => null);
  const overlayAddr = (body?.overlay_addr || "").trim();
  if (!overlayAddr) {
    return errorJson(c, "invalid_request", { message: "overlay_addr is required." });
  }
  const reason = body?.reason ? String(body.reason).slice(0, 500) : undefined;

  // v1 API route: always agent_inferred. Under the current access model,
  // this route is only reachable by agent-token callers (they have tenantId).
  // Operator/beta tokens have tenantId=null and are rejected above.
  // Human user_accepted promotion is CLI-only in v1 (CLI calls the helper
  // directly with isHuman: true). A future tenant-scoped human auth path
  // would enable user_accepted via the API.
  const caller = { agentId: access.agentId, isHuman: false };

  const { promoteOverlay } = await import("../lib/overlay-import");
  const result = await promoteOverlay(sql, access.tenantId, overlayAddr, caller, reason, {
    correlationId: ((c as any).get("correlation_id") as string | undefined) ?? null,
  });

  if (!result.ok) {
    return errorJson(c, "invalid_request", {
      message: (result as { error?: string }).error,
      details: result,
    });
  }

  return c.json(result);
});

// ── POST /memory/approve ──────────────────────────────────────────────
// Explicit human trust-level upgrade for tenant-local memories.
// v1: rejects agent callers because tenant-scoped API auth only comes
// through agent tokens. CLI is the human approval path.

memory.post("/approve", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", { message: "Tenant auth required for approval." });
  }

  // v1: agent callers cannot approve. Tenant-scoped API callers always
  // have agentId set. Human approval is CLI-only until tenant-scoped
  // human API auth exists.
  if (access.agentId) {
    return errorJson(c, "forbidden", {
      message: "Approval requires human operator authority. Agent callers cannot approve memories in v1. Use CLI: vo memory approve <addr>",
    });
  }

  const body = await c.req.json().catch(() => null);
  const addr = (body?.addr || "").trim();
  if (!addr) {
    return errorJson(c, "invalid_request", { message: "addr is required." });
  }
  const reason = body?.reason ? String(body.reason).slice(0, 500) : undefined;

  const correlationIdApprove = ((c as any).get("correlation_id") as string | undefined) ?? null;
  const { approveMemory } = await import("../lib/memory-approve");
  const result = await approveMemory(
    sql,
    access.tenantId,
    addr,
    { actor: "operator", isHuman: true },
    reason,
    { correlationId: correlationIdApprove },
  );

  if (!result.ok) {
    return errorJson(c, "invalid_request", {
      message: (result as { error?: string }).error,
      details: result,
    });
  }

  await auditMutation(c, sql, {
    kind: "memory_approved",
    tenantId: access.tenantId,
    actor: "operator",
    actorKind: "operator_token",
    addr: result.addr || addr,
    eventData: reason ? { reason } : undefined,
  });

  return c.json(result);
});

export default memory;
