import { createHash } from "crypto";
import { Hono, type Context } from "hono";
import {
  embedTextForInsert,
  embeddingTextForNode,
  EmbedApiError,
  EmbedDimensionMismatchError,
} from "@verity-one/embed";
import { sql } from "../db";
import { allocateChildSlotInTx } from "../lib/ontology";
import { loadDurableAlignmentCandidate, refreshDurableNodeAlignments } from "../lib/durable-alignment";
import { buildPublicationPlan, publicationEdgeTypeForTarget } from "../lib/publication";
import { assessPublicationGrounding, evaluatePublicGrounding } from "../lib/public-grounding";
import { deriveSourceRefs } from "../lib/source-refs";
import { clampInt } from "../lib/utils";
import { getAccessContext } from "../lib/access";
import { DEFAULT_TENANT_ID, GLOBAL_SPACE_ID, tenantSpaceId } from "../lib/spaces";
import { ApiError, errorJson } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { upsertEdge } from "../lib/edge-mutations";

const publish = new Hono();
const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type PublishBody = {
  source_addr: string;
  source_space_id?: string | null;
  space_id?: string | null;
  tenant_id?: string | null;
  target_pyramid?: string | null;
  target_parent_addr?: string | null;
  public_label?: string | null;
  public_description?: string | null;
  public_node_type?: string | null;
  public_visibility?: string | null;
  provides?: string[] | null;
  quick_start?: unknown;
  references?: unknown;
  derivation_note?: string | null;
  publication_kind?: "mirror" | "promotion" | "derivation" | null;
  published_by?: string | null;
  dry_run?: boolean;
  allow_provisional?: boolean;
};

function hashPayload(...parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex");
}

function publicationSourceContext(publicationId: number | null, kind: string, note: string | null) {
  return {
    publication: {
      publication_id: publicationId,
      kind,
      derived_from: "private-overlay",
      note,
    },
  };
}

function publicationProvenance(publicationId: number | null, publishedBy: string | null) {
  return {
    basis: "observed",
    source: "private-overlay-publication",
    publication_id: publicationId,
    published_by: publishedBy || "operator",
  };
}

function resolveCandidateSpaceId(c: Context): { spaceId: string | null; error: string | null } {
  const explicitSpaceId = (c.req.query("space_id") || "").trim();
  if (explicitSpaceId) return resolveTenantSpaceId(explicitSpaceId, "space_id");
  const tenantId = (c.req.query("tenant_id") || DEFAULT_TENANT_ID || "").trim();
  return resolveTenantIdToSpaceId(tenantId);
}

function resolveSourceSpaceId(
  c: Context,
  body?: Partial<PublishBody> | null,
  opts: { allowGlobal?: boolean } = {},
): { spaceId: string | null; error: string | null } {
  const explicitSpaceId = (
    (typeof body?.source_space_id === "string" ? body.source_space_id : "")
    || (typeof body?.space_id === "string" ? body.space_id : "")
    || c.req.query("source_space_id")
    || c.req.query("space_id")
    || ""
  ).trim();
  if (explicitSpaceId === GLOBAL_SPACE_ID && opts.allowGlobal) {
    return { spaceId: GLOBAL_SPACE_ID, error: null };
  }
  if (explicitSpaceId) return resolveTenantSpaceId(explicitSpaceId, "space_id");
  const tenantId = (
    (typeof body?.tenant_id === "string" ? body.tenant_id : "")
    || c.req.query("tenant_id")
    || DEFAULT_TENANT_ID
    || ""
  ).trim();
  return resolveTenantIdToSpaceId(tenantId);
}

function resolveTenantSpaceId(spaceId: string, fieldName: string): { spaceId: string | null; error: string | null } {
  const tenantId = spaceId.startsWith("tenant:") ? spaceId.slice("tenant:".length) : "";
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return {
      spaceId: null,
      error: `${fieldName} must be tenant:<bare-lowercase-tenant-id>`,
    };
  }
  return { spaceId, error: null };
}

function resolveTenantIdToSpaceId(tenantId: string): { spaceId: string | null; error: string | null } {
  if (!tenantId) {
    return {
      spaceId: null,
      error: "space_id or tenant_id is required when VERITY_DEFAULT_TENANT_ID is unset",
    };
  }
  if (tenantId.startsWith("tenant:") || !TENANT_ID_RE.test(tenantId)) {
    return {
      spaceId: null,
      error: "tenant_id must be a bare lowercase tenant id; use space_id for tenant:<id>",
    };
  }
  return { spaceId: tenantSpaceId(tenantId), error: null };
}

async function loadSourceNode(addr: string, spaceId: string) {
  const [node] = await sql`
    SELECT addr, space_id, pyramid_id, label, node_type, visibility, substance, source_context, source_refs, updated_at
    FROM nodes
    WHERE addr = ${addr}
      AND space_id = ${spaceId}
      AND visibility <> 'deleted'
    LIMIT 1
  `;
  return node || null;
}

async function loadRewardBasisByPublicationId(publicationId: number | null) {
  if (!publicationId) return null;
  const [row] = await sql`
    SELECT publication_id, target_addr, provisional_reward_score, score_components, reward_posture
    FROM v_publication_reward_basis
    WHERE publication_id = ${publicationId}
    LIMIT 1
  `;
  return row || null;
}

function driftStatusFor(sourceNode: any, publication: any): {
  status: "unpublished" | "published_current" | "source_changed" | "target_missing";
  source_changed: boolean;
  target_missing: boolean;
} {
  const hasPublication =
    !!publication
    && (
      publication.id != null
      || publication.target_addr != null
      || publication.published_at != null
      || publication.updated_at != null
      || publication.source_snapshot != null
    );

  if (!hasPublication) {
    return { status: "unpublished", source_changed: false, target_missing: false };
  }

  const sourceDescription = sourceNode?.substance?.description ?? null;
  const snapshot = publication.source_snapshot && typeof publication.source_snapshot === "object"
    ? publication.source_snapshot
    : {};
  const snapshotDescription = snapshot?.description ?? null;
  const snapshotLabel = snapshot?.label ?? null;
  const snapshotNodeType = snapshot?.node_type ?? null;
  const targetMissing = !!publication.target_addr && !publication.target_exists;
  const publishedAt = publication.updated_at || publication.published_at || null;
  const sourceChanged = targetMissing
    || (sourceNode?.updated_at && publishedAt && new Date(sourceNode.updated_at).getTime() > new Date(publishedAt).getTime())
    || snapshotLabel !== sourceNode?.label
    || snapshotDescription !== sourceDescription
    || (snapshotNodeType ?? null) !== (sourceNode?.node_type ?? null);

  if (targetMissing) {
    return { status: "target_missing", source_changed: true, target_missing: true };
  }
  if (sourceChanged) {
    return { status: "source_changed", source_changed: true, target_missing: false };
  }
  return { status: "published_current", source_changed: false, target_missing: false };
}

publish.get("/candidates", async (c) => {
  const resolvedSpace = resolveCandidateSpaceId(c);
  if (!resolvedSpace.spaceId) {
    return errorJson(c, "invalid_request", { message: resolvedSpace.error ?? "Invalid publication space." });
  }
  const spaceId = resolvedSpace.spaceId;
  const limit = clampInt(c.req.query("limit"), 25, 1, 100);

  const candidateRows = await sql`
    SELECT
      n.addr,
      n.space_id,
      n.pyramid_id,
      n.label,
      n.node_type,
      n.updated_at,
      n.substance->>'description' AS description,
      n.source_refs,
      n.source_context,
      p.id AS publication_id,
      p.target_addr,
      p.target_pyramid_id,
      p.status AS publication_status,
      p.published_at,
      p.updated_at AS publication_updated_at,
      p.source_snapshot,
      t.addr IS NOT NULL AS target_exists
    FROM nodes n
    LEFT JOIN node_publications p
      ON p.source_space_id = n.space_id
     AND p.source_addr = n.addr
     AND p.target_space_id = ${GLOBAL_SPACE_ID}
     AND p.publication_kind = 'mirror'
     AND p.status IN ('published', 'updated')
    LEFT JOIN nodes t
      ON t.addr = p.target_addr
     AND t.visibility <> 'deleted'
    WHERE n.space_id = ${spaceId}
      AND n.visibility = 'private'
    ORDER BY (p.id IS NULL) DESC, n.updated_at DESC
    LIMIT ${limit}
  `;

  const candidates = candidateRows.map((row: any) => {
    const grounding = assessPublicationGrounding({
      sourceRefs: row.source_refs,
      sourceContext: row.source_context,
    });
    const drift = driftStatusFor({
      ...row,
      substance: { description: row.description },
    }, {
      id: row.publication_id,
      target_addr: row.target_addr,
      target_exists: row.target_exists,
      published_at: row.published_at,
      updated_at: row.publication_updated_at,
      source_snapshot: row.source_snapshot,
    });
    return {
      ...row,
      publication_updated_at: row.publication_updated_at,
      drift,
      review_status: drift.status === "unpublished"
        ? grounding.reviewStatus
        : drift.status === "published_current"
          ? "current"
          : "needs_review",
      grounding,
    };
  });

  const publicationIds = candidates
    .map((row: any) => row.publication_id)
    .filter((value: any) => value != null);
  let rewardByPublication = new Map<number, any>();
  if (publicationIds.length > 0) {
    const rewardRows = await sql`
      SELECT publication_id, provisional_reward_score, score_components, reward_posture
      FROM v_publication_reward_basis
      WHERE publication_id = ANY(${publicationIds}::bigint[])
    `;
    rewardByPublication = new Map(rewardRows.map((row: any) => [Number(row.publication_id), row]));
  }

  return c.json({
    ok: true,
    space_id: spaceId,
    candidates: candidates.map((row: any) => ({
      ...row,
      reward_basis: row.publication_id != null ? rewardByPublication.get(Number(row.publication_id)) || null : null,
    })),
    count: candidates.length,
  });
});

publish.get("/source/:addr", async (c) => {
  const sourceAddr = c.req.param("addr");
  const resolvedSpace = resolveSourceSpaceId(c);
  if (!resolvedSpace.spaceId) {
    return errorJson(c, "invalid_request", { message: resolvedSpace.error ?? "Invalid source space." });
  }
  const sourceNode = await loadSourceNode(sourceAddr, resolvedSpace.spaceId);
  if (!sourceNode) return errorJson(c, "node_not_found", { message: "Source node not found in tenant space" });

  const publicationRows = await sql`
    SELECT p.*, n.label AS target_label, n.visibility AS target_visibility, n.addr IS NOT NULL AS target_exists
    FROM node_publications p
    LEFT JOIN nodes n ON n.addr = p.target_addr AND n.visibility <> 'deleted'
    WHERE p.source_addr = ${sourceAddr}
    ORDER BY p.published_at DESC
  `;

  const publications = publicationRows.map((row: any) => ({
    ...row,
    drift: driftStatusFor(sourceNode, row),
  }));
  const publicationIds = publications.map((row: any) => row.id).filter((value: any) => value != null);
  let rewardByPublication = new Map<number, any>();
  if (publicationIds.length > 0) {
    const rewardRows = await sql`
      SELECT publication_id, provisional_reward_score, score_components, reward_posture
      FROM v_publication_reward_basis
      WHERE publication_id = ANY(${publicationIds}::bigint[])
    `;
    rewardByPublication = new Map(rewardRows.map((row: any) => [Number(row.publication_id), row]));
  }

  return c.json({
    ok: true,
    source: sourceNode,
    publications: publications.map((row: any) => ({
      ...row,
      reward_basis: row.id != null ? rewardByPublication.get(Number(row.id)) || null : null,
    })),
  });
});

publish.post("/node", async (c) => {
  const access = getAccessContext(c);
  let body: PublishBody;
  try {
    body = await c.req.json<PublishBody>();
  } catch {
    return errorJson(c, "invalid_request", { message: "JSON body required" });
  }

  if (!body.source_addr) {
    return errorJson(c, "invalid_request", { message: "source_addr is required" });
  }

  const resolvedSpace = resolveSourceSpaceId(c, body, { allowGlobal: true });
  if (!resolvedSpace.spaceId) {
    return errorJson(c, "invalid_request", { message: resolvedSpace.error ?? "Invalid source space." });
  }
  const sourceNode = await loadSourceNode(body.source_addr, resolvedSpace.spaceId);
  if (!sourceNode) return errorJson(c, "node_not_found", { message: "Source node not found in tenant space" });
  if (sourceNode.space_id === GLOBAL_SPACE_ID) {
    return errorJson(c, "conflict", { message: "Source node is already in the global graph" });
  }
  // Surface the PROJECTS-target rejection with a controlled, actionable message
  // up front rather than letting buildPublicationPlan throw into the generic
  // "Unable to build publication plan" catch below (which would otherwise mask
  // this deliberate validation rule). buildPublicationPlan still enforces the
  // same rule for any derived target; this is the explicit-request fast path.
  if (body.target_pyramid === "PROJECTS") {
    return errorJson(c, "invalid_request", {
      message: "Public publications cannot target PROJECTS",
    });
  }

  let plan;
  try {
    plan = await buildPublicationPlan(sql, sourceNode as any, {
      targetPyramidId: body.target_pyramid,
      targetParentAddr: body.target_parent_addr,
      publicLabel: body.public_label,
      publicDescription: body.public_description,
      publicNodeType: body.public_node_type,
      publicVisibility: body.public_visibility,
      provides: body.provides,
      quickStart: body.quick_start,
      references: body.references,
      derivationNote: body.derivation_note,
      publicationKind: body.publication_kind || "mirror",
    });
  } catch (error: any) {
    console.error("[publish/node] plan build failed:", error);
    return errorJson(c, "invalid_request", {
      message: "Unable to build publication plan",
    });
  }

  if (!plan.targetParentAddr) {
    return errorJson(c, "invalid_request", { message: "No target parent branch could be resolved" });
  }

  const [parent] = await sql`
    SELECT addr, pyramid_id, depth
    FROM nodes
    WHERE addr = ${plan.targetParentAddr}
      AND pyramid_id = ${plan.targetPyramidId}
      AND depth IN (1, 2)
      AND space_id = ${GLOBAL_SPACE_ID}
      AND visibility <> 'deleted'
    LIMIT 1
  `;
  if (!parent) {
    return errorJson(c, "not_found", { message: `Target parent branch not found: ${plan.targetParentAddr}` });
  }

  const [existingPublication] = await sql`
    SELECT *
    FROM node_publications
    WHERE source_space_id = ${sourceNode.space_id}
      AND source_addr = ${sourceNode.addr}
      AND target_space_id = ${GLOBAL_SPACE_ID}
      AND publication_kind = ${plan.publicationKind}
    LIMIT 1
  `;

  const publicationGrounding = assessPublicationGrounding({
    sourceRefs: sourceNode.source_refs,
    sourceContext: sourceNode.source_context,
  });

  if (body.dry_run) {
    const dryRunExisting = existingPublication
      ? { ...existingPublication, drift: driftStatusFor(sourceNode, existingPublication) }
      : null;
    return c.json({
      ok: true,
      dry_run: true,
      source: {
        addr: sourceNode.addr,
        space_id: sourceNode.space_id,
        label: sourceNode.label,
        node_type: sourceNode.node_type,
      },
      existing_publication: dryRunExisting,
      plan,
      grounding: publicationGrounding,
    });
  }

  if (!body.allow_provisional && !publicationGrounding.publishableWithoutOverride) {
    return errorJson(c, "publish_blocked", {
      message: "Publication candidate needs grounding before entering the public graph",
      details: { grounding: publicationGrounding },
    });
  }

  const publishedBy = body.published_by || "operator";
  const edgeType = publicationEdgeTypeForTarget(plan.targetPyramidId, plan.publicNodeType);
  // F7: publication creates or updates a public node's semantic text, so
  // compute the document embedding before opening the transaction. The
  // transaction still writes the semantic fields and marker columns in
  // one statement, but does not hold a DB connection across the network
  // embedding call.
  const publicationEmbed = await embedTextForInsert(
    embeddingTextForNode(plan.publicLabel, plan.publishedSubstance),
  );

  const result = await sql.begin(async (tx) => {
    const q = tx as any;
    const [currentPublication] = await q`
      SELECT *
      FROM node_publications
      WHERE source_space_id = ${sourceNode.space_id}
        AND source_addr = ${sourceNode.addr}
        AND target_space_id = ${GLOBAL_SPACE_ID}
        AND publication_kind = ${plan.publicationKind}
      LIMIT 1
    `;

    let targetAddr: string;
    let publicationId: number;
    let status: "published" | "updated";
    const publishedSourceRefs = deriveSourceRefs({
      existing: sourceNode.source_refs,
      sourceContext: sourceNode.source_context,
      sourceSnapshot: plan.sourceSnapshot,
    });
    const groundedPublic = evaluatePublicGrounding({
      spaceId: GLOBAL_SPACE_ID,
      visibility: plan.publicVisibility,
      confidence: 0.82,
      sourceRefs: publishedSourceRefs,
      sourceContext: publicationSourceContext(currentPublication?.id ?? null, plan.publicationKind, plan.derivationNote),
    });

    if (currentPublication?.target_addr) {
      const existingTargetPyramid = currentPublication.target_pyramid_id;
      if (existingTargetPyramid !== plan.targetPyramidId) {
        throw new Error(`Existing publication already targets ${existingTargetPyramid}; use the same public ontology target when updating`);
      }

      targetAddr = currentPublication.target_addr;
      await q`
        UPDATE nodes
        SET label = ${plan.publicLabel},
            substance = ${q.json(plan.publishedSubstance)},
            node_type = ${plan.publicNodeType},
            visibility = ${plan.publicVisibility},
            parent_addr = ${plan.targetParentAddr},
            confidence = ${groundedPublic.confidence},
            source_refs = ${q.json(groundedPublic.sourceRefs)},
            provenance = ${q.json(publicationProvenance(currentPublication.id, publishedBy))},
            source_context = ${q.json(groundedPublic.sourceContext)},
            hash = ${hashPayload(targetAddr, plan.publicLabel, plan.publicDescription, publishedBy)},
            embedding_hv = ${publicationEmbed.vecStr}::halfvec(3072),
            embedding_at = ${publicationEmbed.embeddedAt},
            embedding_model = ${publicationEmbed.model},
            embedding_task_type = ${publicationEmbed.taskType},
            dormant_at = NULL,
            updated_at = now()
        WHERE addr = ${targetAddr}
      `;

      const [updatedPublication] = await q`
        UPDATE node_publications
        SET target_parent_addr = ${plan.targetParentAddr},
            target_pyramid_id = ${plan.targetPyramidId},
            status = 'updated',
            public_label = ${plan.publicLabel},
            public_description = ${plan.publicDescription},
            public_node_type = ${plan.publicNodeType},
            public_visibility = ${plan.publicVisibility},
            derivation_note = ${plan.derivationNote},
            source_snapshot = ${q.json(plan.sourceSnapshot)},
            published_substance = ${q.json(plan.publishedSubstance)},
            published_by = ${publishedBy},
            updated_at = now()
        WHERE id = ${currentPublication.id}
        RETURNING id
      `;
      publicationId = Number(updatedPublication.id);
      status = "updated";
    } else {
      const slot = await allocateChildSlotInTx(tx, plan.targetPyramidId as any, plan.targetParentAddr);
      targetAddr = slot.addr;

      const [createdNode] = await q`
        INSERT INTO nodes (
          addr, pyramid_id, layer, depth, position, label, substance, confidence,
          hash, provenance, parent_addr, visibility, node_type, source_context, source_refs, space_id,
          embedding_hv, embedding_at, embedding_model, embedding_task_type
        )
        VALUES (
          ${targetAddr},
          ${plan.targetPyramidId},
          0,
          ${slot.depth},
          ${slot.position},
          ${plan.publicLabel},
          ${q.json(plan.publishedSubstance)},
          ${groundedPublic.confidence},
          ${hashPayload(targetAddr, plan.publicLabel, plan.publicDescription, publishedBy)},
          ${q.json(publicationProvenance(null, publishedBy))},
          ${plan.targetParentAddr},
          ${plan.publicVisibility},
          ${plan.publicNodeType},
          ${q.json(groundedPublic.sourceContext)},
          ${q.json(groundedPublic.sourceRefs)},
          ${GLOBAL_SPACE_ID},
          ${publicationEmbed.vecStr}::halfvec(3072),
          ${publicationEmbed.embeddedAt},
          ${publicationEmbed.model},
          ${publicationEmbed.taskType}
        )
        RETURNING addr
      `;

      const [createdPublication] = await q`
        INSERT INTO node_publications (
          source_space_id, source_addr, target_space_id, target_addr, target_pyramid_id,
          target_parent_addr, publication_kind, status, public_label, public_description,
          public_node_type, public_visibility, derivation_note, source_snapshot,
          published_substance, published_by
        )
        VALUES (
          ${sourceNode.space_id},
          ${sourceNode.addr},
          ${GLOBAL_SPACE_ID},
          ${createdNode.addr},
          ${plan.targetPyramidId},
          ${plan.targetParentAddr},
          ${plan.publicationKind},
          'published',
          ${plan.publicLabel},
          ${plan.publicDescription},
          ${plan.publicNodeType},
          ${plan.publicVisibility},
          ${plan.derivationNote},
          ${q.json(plan.sourceSnapshot)},
          ${q.json(plan.publishedSubstance)},
          ${publishedBy}
        )
        RETURNING id
      `;
      publicationId = Number(createdPublication.id);
      await q`
        UPDATE nodes
        SET provenance = ${q.json(publicationProvenance(publicationId, publishedBy))},
            source_context = ${q.json(publicationSourceContext(publicationId, plan.publicationKind, plan.derivationNote))}
        WHERE addr = ${createdNode.addr}
      `;
      status = "published";
    }

    const alignmentCandidate = await loadDurableAlignmentCandidate(q, targetAddr);
    if (alignmentCandidate) {
      await refreshDurableNodeAlignments(q, alignmentCandidate);
    }

    await upsertEdge(sql, {
      fromAddr: sourceNode.addr,
      toAddr: targetAddr,
      edgeType,
      layer: 1,
      label: `Private source ${status === "published" ? "published into" : "updated in"} public truth layer`,
      confidence: 0.88,
      weight: 1.0,
      bidirectional: false,
      hash: hashPayload(sourceNode.addr, targetAddr, edgeType, String(publicationId)),
      provenance: { basis: "observed", source: "node_publications", publication_id: publicationId },
      sourceContext: { publication_id: publicationId, publication_kind: plan.publicationKind },
      spaceId: sourceNode.space_id,
      fromSpaceId: sourceNode.space_id,
      toSpaceId: GLOBAL_SPACE_ID,
    }, { tx: q, conflictUpdate: "replaceMetadata" });

    await q`
      INSERT INTO change_stream (action, target_addr, details, agent_tier, space_id)
      VALUES (
        ${status === "published" ? "node_created" : "node_updated"},
        ${targetAddr},
        ${q.json({
          publication_id: publicationId,
          source_addr: sourceNode.addr,
          source_space_id: sourceNode.space_id,
          target_pyramid_id: plan.targetPyramidId,
          publication_kind: plan.publicationKind,
          publication_status: status,
        })},
        'human',
        ${GLOBAL_SPACE_ID}
      )
    `;

    await q`
      INSERT INTO graph_mutations (mutation_type, target_addr, target_label, new_value, source)
      VALUES (
        ${status === "published" ? "publication_created" : "publication_updated"},
        ${targetAddr},
        ${plan.publicLabel},
        ${q.json({
          publication_id: publicationId,
          source_addr: sourceNode.addr,
          source_space_id: sourceNode.space_id,
          target_addr: targetAddr,
          target_pyramid_id: plan.targetPyramidId,
          public_label: plan.publicLabel,
        })},
        'publish-route'
      )
    `;

    await q`
      INSERT INTO public_contribution_events (
        publication_id, source_space_id, source_addr, target_addr, event_type, actor, event_payload
      )
      VALUES (
        ${publicationId},
        ${sourceNode.space_id},
        ${sourceNode.addr},
        ${targetAddr},
        ${status === "published" ? "publication_created" : "publication_updated"},
        ${publishedBy},
        ${q.json({
          target_pyramid_id: plan.targetPyramidId,
          publication_kind: plan.publicationKind,
          selection_reason: plan.selectionReason,
          provisional_reward_score: null,
          reward_posture: null,
          score_components: null,
        })}
      )
    `;

    await q`SELECT refresh_registry_counts(${plan.targetPyramidId})`;
    await q`SELECT refresh_space_pyramid_counts(${GLOBAL_SPACE_ID}, ${plan.targetPyramidId})`;
    await q`SELECT refresh_space_pyramid_counts(${sourceNode.space_id}, ${sourceNode.pyramid_id})`;

    return {
      publication_id: publicationId,
      status,
      target_addr: targetAddr,
      target_pyramid_id: plan.targetPyramidId,
      target_parent_addr: plan.targetParentAddr,
      edge_type: edgeType,
      publication_kind: plan.publicationKind,
    };
  });

  const rewardBasis = await loadRewardBasisByPublicationId(result.publication_id);

  await auditMutation(c, sql, {
    kind: "node_published",
    tenantId: access.tenantId ?? "operator",
    actor: "operator",
    actorKind: "operator_token",
    addr: (result as any).target_addr ?? sourceNode.addr,
    eventData: {
      source_addr: sourceNode.addr,
      publication_id: (result as any).publication_id ?? null,
      publication_kind: plan.publicationKind,
      target_pyramid: plan.targetPyramidId,
    },
  });

  return c.json({
    ok: true,
    source_addr: sourceNode.addr,
    source_space_id: sourceNode.space_id,
    ...result,
    selection_reason: plan.selectionReason,
    reward_basis: rewardBasis,
  });
});

// ── POST /publish/node/:id/archive ────────────────────────────────────
// Archive a publication. Sets status to 'archived' and emits a
// publication_archived event so the federation overlay feed can
// produce a tombstone item.

publish.post("/node/:id/archive", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) return errorJson(c, "tenant_required", { message: "Tenant auth required." });

  const publicationId = parseInt(c.req.param("id"), 10);
  if (!publicationId || isNaN(publicationId)) {
    return errorJson(c, "invalid_request", { message: "Valid publication id required." });
  }

  const body = await c.req.json().catch(() => null);
  const reason = (body?.reason || "operator_archived").toString().slice(0, 500);

  // Verify publication exists and belongs to this tenant's space
  const [pub] = await sql`
    SELECT id, source_space_id, source_addr, target_addr, target_pyramid_id,
           publication_kind, status
    FROM node_publications
    WHERE id = ${publicationId}
      AND source_space_id = ${"tenant:" + access.tenantId}
  `;
  if (!pub) {
    return errorJson(c, "not_found", { message: "Publication not found or does not belong to this tenant." });
  }
  if (pub.status === "archived") {
    return c.json({ ok: true, already_archived: true, publication_id: publicationId });
  }

  const previousStatus = pub.status;

  // Archive the publication
  await sql`
    UPDATE node_publications
    SET status = 'archived', updated_at = now()
    WHERE id = ${publicationId}
  `;

  // Mark the target node as dormant so it stops appearing in public queries
  if (pub.target_addr) {
    await sql`
      UPDATE nodes SET dormant_at = now(), updated_at = now()
      WHERE addr = ${pub.target_addr} AND space_id = 'global'
    `;
  }

  // Emit lifecycle event
  await sql`
    INSERT INTO public_contribution_events
      (publication_id, source_space_id, source_addr, target_addr, event_type, actor, event_payload)
    VALUES (
      ${publicationId},
      ${pub.source_space_id},
      ${pub.source_addr},
      ${pub.target_addr},
      'publication_archived',
      ${access.agentId || access.tenantId || "operator"},
      ${sql.json({ reason, previous_status: previousStatus })}
    )
  `;

  await auditMutation(c, sql, {
    kind: "node_unpublished",
    tenantId: access.tenantId,
    actor: access.agentId || "operator",
    actorKind: "tenant_session",
    addr: pub.target_addr,
    eventData: { publication_id: publicationId, reason, previous_status: previousStatus },
  });

  return c.json({
    ok: true,
    publication_id: publicationId,
    status: "archived",
    previous_status: previousStatus,
    reason,
    note: "Publication archived. Federation overlay feed will emit a tombstone for this item.",
  });
});

// ── POST /publish/node/:id/supersede ──────────────────────────────────
// Supersede a publication with a successor. Sets status to 'superseded'
// and emits a publication_superseded event with successor linkage.

publish.post("/node/:id/supersede", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) return errorJson(c, "tenant_required", { message: "Tenant auth required." });

  const publicationId = parseInt(c.req.param("id"), 10);
  if (!publicationId || isNaN(publicationId)) {
    return errorJson(c, "invalid_request", { message: "Valid publication id required." });
  }

  const body = await c.req.json().catch(() => null);
  const successorPublicationId = body?.successor_publication_id ? parseInt(body.successor_publication_id, 10) : null;
  const reason = (body?.reason || "replaced_by_successor").toString().slice(0, 500);

  // Verify old publication exists and belongs to this tenant
  const [pub] = await sql`
    SELECT id, source_space_id, source_addr, target_addr, target_pyramid_id,
           publication_kind, status
    FROM node_publications
    WHERE id = ${publicationId}
      AND source_space_id = ${"tenant:" + access.tenantId}
  `;
  if (!pub) {
    return errorJson(c, "not_found", { message: "Publication not found or does not belong to this tenant." });
  }
  if (pub.status === "superseded") {
    return c.json({ ok: true, already_superseded: true, publication_id: publicationId });
  }

  // If successor is specified, verify it exists and is compatible
  let successorTargetAddr: string | null = null;
  if (successorPublicationId) {
    // Reject self-supersession
    if (successorPublicationId === publicationId) {
      return errorJson(c, "invalid_request", { message: "A publication cannot supersede itself." });
    }
    const [successor] = await sql`
      SELECT id, target_addr, target_pyramid_id, publication_kind FROM node_publications
      WHERE id = ${successorPublicationId}
        AND source_space_id = ${"tenant:" + access.tenantId}
        AND status IN ('published', 'updated')
    `;
    if (!successor) {
      return errorJson(c, "not_found", { message: "Successor publication not found or not active." });
    }
    // Require compatible publication kind and ontology target
    if (successor.publication_kind !== pub.publication_kind) {
      return errorJson(c, "invalid_request", { message: `Successor publication_kind "${successor.publication_kind}" does not match original "${pub.publication_kind}".` });
    }
    if (successor.target_pyramid_id !== pub.target_pyramid_id) {
      return errorJson(c, "invalid_request", { message: `Successor target_pyramid_id "${successor.target_pyramid_id}" does not match original "${pub.target_pyramid_id}".` });
    }
    successorTargetAddr = successor.target_addr;
  }

  const previousStatus = pub.status;

  // Supersede the publication
  await sql`
    UPDATE node_publications
    SET status = 'superseded', updated_at = now()
    WHERE id = ${publicationId}
  `;

  // Mark the old target node as dormant
  if (pub.target_addr) {
    await sql`
      UPDATE nodes SET dormant_at = now(), updated_at = now()
      WHERE addr = ${pub.target_addr} AND space_id = 'global'
    `;
  }

  // Emit lifecycle event with successor linkage
  await sql`
    INSERT INTO public_contribution_events
      (publication_id, source_space_id, source_addr, target_addr, event_type, actor, event_payload)
    VALUES (
      ${publicationId},
      ${pub.source_space_id},
      ${pub.source_addr},
      ${pub.target_addr},
      'publication_superseded',
      ${access.agentId || access.tenantId || "operator"},
      ${sql.json({
        reason,
        previous_status: previousStatus,
        successor_publication_id: successorPublicationId,
        successor_overlay_id: successorPublicationId ? `pub:${successorPublicationId}` : null,
        successor_target_addr: successorTargetAddr,
      })}
    )
  `;

  return c.json({
    ok: true,
    publication_id: publicationId,
    status: "superseded",
    previous_status: previousStatus,
    reason,
    successor_publication_id: successorPublicationId,
    successor_overlay_id: successorPublicationId ? `pub:${successorPublicationId}` : null,
    note: "Publication superseded. Federation overlay feed will emit a tombstone with successor linkage.",
  });
});

export default publish;
