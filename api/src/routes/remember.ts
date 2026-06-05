/**
 * POST /remember — Backward-compatible memory write adapter.
 *
 * Maps old { description, label?, memory_type?, context? } payloads
 * into the canonical memory contract and delegates to /memory/write logic.
 *
 * GET /remember — List or search tenant memories (unchanged).
 */

import { Hono } from "hono";
import { sql } from "../db";
import { embedQuery, toVectorStr, embedTextForInsert, embeddingTextForNode } from "../lib/embed";
import { getAccessContext } from "../lib/access";
import { clampInt } from "../lib/utils";
import {
  adaptRememberPayload,
  type MemoryKind,
} from "../lib/memory-contract";
import { allocateChildSlotInTx } from "../lib/ontology";
import { tryJournalMemoryInTx } from "../lib/sync-journal-port";
import { errorJson } from "../lib/error-envelope";
import { validateRequest } from "../lib/zod-helpers";
import { RememberRequestSchema } from "../schemas/remember.schema";
import { auditMutation } from "../lib/audit";
import { writeEdge } from "../lib/edge-mutations";
import { insertRegistry, logEvent } from "../lib/memory-lifecycle";
import { classifyMemoryWriteQuality } from "../lib/memory-quality";
// F12: canonical maturity_stage origin.
import { coalesceMaturityStage } from "@verity-one/graph-shape";

const remember = new Hono();

const REMEMBER_LOCK_ID = 900_001;

function edgeTypeForKind(kind: MemoryKind): string {
  switch (kind) {
    case "correction": return "constrains";
    case "decision": return "grounds";
    case "preference": return "guides";
    default: return "informs";
  }
}

remember.post("/", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required", {
      hint: "Authenticate with a tenant-scoped agent token.",
    });
  }

  const body = await validateRequest(c, RememberRequestSchema, "json", {
    requireJsonContentType: true,
  });

  // Adapt old payload to canonical contract
  const canonicalReq = adaptRememberPayload(body as Record<string, unknown>);

  const quality = classifyMemoryWriteQuality({
    kind: canonicalReq.kind,
    source: canonicalReq.source,
    subject: canonicalReq.subject,
    assertion: canonicalReq.assertion,
    whyItMatters: canonicalReq.why_it_matters,
    evidence: canonicalReq.evidence,
    tags: canonicalReq.tags,
    sourceRefs: Array.isArray(canonicalReq.source_refs) ? canonicalReq.source_refs : undefined,
  });
  if (quality.verdict === "reject") {
    return errorJson(c, "validation_failed", {
      message: "Memory rejected by quality gate. Rewrite it as durable, specific product knowledge or mark it user_accepted after human review.",
      details: {
        errors: quality.reasons.map((reason) => ({ field: "description", message: reason })),
        memory_quality: quality,
      },
    });
  }

  const spaceId = `tenant:${access.tenantId}`;
  const label = (canonicalReq.subject || canonicalReq.assertion.slice(0, 80)).slice(0, 120);

  // Build substance (preserves backward compatibility)
  const substance: Record<string, unknown> = {
    description: canonicalReq.assertion,
    memory_type: canonicalReq.kind,
    maturity_stage: coalesceMaturityStage(undefined),
    created_at: new Date().toISOString(),
    source_kind: canonicalReq.source,
    accepted_by_user: canonicalReq.source === "user_accepted",
  };
  if (canonicalReq.why_it_matters) substance.why_it_matters = canonicalReq.why_it_matters;

  // F7 query/document split: embedQuery on the assertion produces a
  // query-task vector for the duplicate-search comparison;
  // embedTextForInsert on the canonical node text produces the
  // document-task vector that becomes embedding_hv.
  const queryVec = await embedQuery(canonicalReq.assertion);
  const queryVecStr = toVectorStr(queryVec);
  const storedEmbed = await embedTextForInsert(
    embeddingTextForNode(label, substance),
  );

  // Dedup uses the query-task vector against existing document-task
  // vectors (Gemini's task-aware embeddings align query↔document for
  // retrieval).
  // F12 Q11: dedupe MUST ignore dormant/archived/merged rows. A dormant
  // memory is not "active competition" — the new write should land,
  // not be silently suppressed by something the operator already retired.
  // Project-aware dedup: /remember writes are tenant-wide (unscoped), so only
  // collapse against other tenant-wide memories — never suppress a tenant-wide
  // write because a project-scoped memory happens to be similar.
  const [dupCheck] = await sql`
    SELECT addr, label, 1 - (embedding_hv <=> ${queryVecStr}::halfvec) as similarity
    FROM nodes
    WHERE space_id = ${spaceId} AND node_type = 'memory'
      AND embedding_hv IS NOT NULL
      AND dormant_at IS NULL
      AND visibility <> 'deleted'
      AND COALESCE(substance->>'project_addr', '') = ''
    ORDER BY embedding_hv <=> ${queryVecStr}::halfvec
    LIMIT 1
  `;
  if (dupCheck && parseFloat(dupCheck.similarity) > 0.85) {
    return c.json({
      ok: true,
      deduplicated: true,
      existing_addr: dupCheck.addr,
      existing_label: dupCheck.label,
      similarity: parseFloat(parseFloat(dupCheck.similarity).toFixed(3)),
      message: "Skipped — semantically similar memory already exists",
    });
  }

  // Atomic insert
  const [result] = await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(${REMEMBER_LOCK_ID})`;
    const slot = await allocateChildSlotInTx(tx, "PROJECTS", null, { defaultDepth: 3 });
    await tx`
      INSERT INTO nodes (
        addr, pyramid_id, layer, depth, position, label, substance, confidence, hash, provenance,
        visibility, space_id, node_type,
        embedding_hv, embedding_at, embedding_model, embedding_task_type
      )
      VALUES (
        ${slot.addr}, 'PROJECTS', 0, ${slot.depth}, ${slot.position},
        ${label},
        ${tx.json(substance as any)},
        0.80,
        md5(${slot.addr + "-" + label.toLowerCase().replace(/\s+/g, "-")}),
        ${tx.json({ agent: access.agentId || "claude-code", date: new Date().toISOString().slice(0, 10), source: "remember_compat" })},
        'private',
        ${spaceId},
        'memory',
        ${storedEmbed.vecStr}::halfvec(3072),
        ${storedEmbed.embeddedAt},
        ${storedEmbed.model},
        ${storedEmbed.taskType}
      )`;

    // F11: sync journal append inside the transaction so the journal row
    // commits with the insert. Best-effort error handling.
    await tryJournalMemoryInTx(tx as any, "upsert", slot.addr, spaceId, null, "[remember]");

    // Register the memory in memory_registry so it participates in the
    // lifecycle state machine (supersession, dormancy, accept-by-user).
    // /remember is a user-authored write — source_kind reflects whether
    // the caller marked it user_accepted, and the registry row mirrors
    // that intent so memory_lifecycle protections fire correctly.
    await insertRegistry(tx as any, {
      addr: slot.addr,
      tenantId: access.tenantId!,
      kind: canonicalReq.kind,
      acceptedByUser: canonicalReq.source === "user_accepted",
      sourceKind: canonicalReq.source,
    });

    // Created event — the canonical lifecycle row for the create, written in the
    // SAME transaction as the node + registry so a /remember memory can never exist
    // without its creation event (the audit ledger stays replayable). This compat
    // path previously skipped it, leaving registry rows with no `created` event
    // (MQ2 / registry_without_created_event debt); mirrors writeMemory's create row.
    await logEvent(
      tx as any,
      slot.addr,
      access.tenantId!,
      "created",
      access.agentId || "claude-code",
      { kind: canonicalReq.kind, source: canonicalReq.source },
    );

    return [{ addr: slot.addr }];
  });

  // Rung 3: best-effort local dossier write. On a long-lived/local instance
  // with a ready vault, also persist a verifiable on-disk source artifact
  // (dossiers/<addr>.md) and stamp a vault_file source_ref onto the node, so
  // the memory is openable + hash-verifiable in Obsidian. NEVER on serverless
  // — /remember is also mounted on the hosted app, where there is no vault and
  // the graph write must still succeed. A failure here never fails the write.
  let dossier: { obsidian_uri: string; vault_file: string; sha256: string } | undefined;
  const serverlessProfile =
    (process.env.VERITY_DEPLOYMENT_PROFILE ?? "").trim() === "serverless" ||
    (process.env.VERCEL ?? "").trim() === "1" ||
    Boolean((process.env.VERCEL_ENV ?? "").trim()) ||
    Boolean((process.env.VERCEL_URL ?? "").trim());
  if (!serverlessProfile) {
    try {
      const { readVaultDashboardState } = await import("../lib/vault-control");
      const vaultState = readVaultDashboardState(null, access.tenantId);
      if (vaultState.status_kind === "ready" && vaultState.vault_root) {
        const { writeNodeDossier } = await import("../lib/vault-write");
        const bodyLines = [`# ${label}`, "", canonicalReq.assertion];
        if (canonicalReq.why_it_matters) {
          bodyLines.push("", "## Why it matters", "", canonicalReq.why_it_matters);
        }
        bodyLines.push(
          "",
          "---",
          "",
          `- **Memory type:** ${canonicalReq.kind}`,
          `- **Source:** ${canonicalReq.source}`,
          `- **Address:** ${result.addr}`,
          "",
        );
        const written = await writeNodeDossier(sql, {
          vaultRoot: vaultState.vault_root,
          content: {
            addr: result.addr,
            title: label,
            body: bodyLines.join("\n"),
            generatedBy: "remember/v1",
            confidence: 0.8,
            tags: Array.isArray(canonicalReq.tags) ? canonicalReq.tags : [],
          },
        });
        if (written.writeAction !== "conflict" && written.sha256) {
          dossier = {
            obsidian_uri: written.obsidianUri,
            vault_file: written.dossierRelPath,
            sha256: written.sha256,
          };
        }
      }
    } catch (e: any) {
      console.error(`[remember] dossier write skipped (non-fatal): ${e?.message}`);
    }
  }

  // Auto-wire edges
  const edgeType = edgeTypeForKind(canonicalReq.kind);
  (async () => {
    try {
      const candidates = await sql`
        SELECT
          n.addr,
          round((1 - (n.embedding_hv <=> ${queryVecStr}::halfvec))::numeric, 3)::float AS weight
        FROM nodes n
        WHERE n.node_type != 'memory'
          AND n.embedding_hv IS NOT NULL
          AND n.visibility = 'public'
          AND (1 - (n.embedding_hv <=> ${queryVecStr}::halfvec)) > 0.55
        ORDER BY n.embedding_hv <=> ${queryVecStr}::halfvec
        LIMIT 3
      `;

      if (candidates.length === 0) return;
      await sql.begin(async (tx) => {
        for (const candidate of candidates) {
          await writeEdge(sql, {
            fromAddr: result.addr,
            toAddr: String(candidate.addr),
            edgeType,
            layer: 0,
            confidence: 0.75,
            weight: Number(candidate.weight),
            bidirectional: false,
            provenance: { agent: access.agentId || "claude-code", auto_wired: true },
          }, { tx: tx as any });
        }
      });
    } catch (e: any) {
      console.error("[auto-wire] edge insert failed:", e?.message);
    }
  })();

  await auditMutation(c, sql, {
    kind: "memory_created",
    tenantId: access.tenantId,
    addr: result.addr,
    actor: access.agentId || "operator",
    eventData: {
      source: "remember_compat",
      memory_type: canonicalReq.kind,
      auto_wire_edge_type: edgeType,
    },
  });

  return c.json({
    ok: true,
    addr: result.addr,
    label,
    memory_type: canonicalReq.kind,
    space_id: spaceId,
    edges_wired: edgeType,
    ...(dossier ? { dossier } : {}),
  });
});

// GET /remember — list or search tenant memories
remember.get("/", async (c) => {
  const access = getAccessContext(c);
  if (!access.tenantId) {
    return errorJson(c, "tenant_required");
  }

  const spaceId = `tenant:${access.tenantId}`;
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const q = c.req.query("q") || "";
  const typeFilter = c.req.query("type") || null;

  if (!q) {
    const memories = await sql`
      SELECT addr, label,
        substance->>'memory_type' as memory_type,
        substring(substance->>'description' from 1 for 400) as description_preview,
        substance->>'created_at' as created_at
      FROM nodes
      WHERE space_id = ${spaceId} AND node_type = 'memory'
        AND visibility <> 'deleted'
        ${typeFilter ? sql`AND substance->>'memory_type' = ${typeFilter}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return c.json({ ok: true, count: memories.length, memories });
  }

  const embedding = await embedQuery(q);
  const vecStr = toVectorStr(embedding);
  const ilikePattern = `%${q}%`;

  const memories = await sql`
    WITH semantic AS (
      SELECT addr, label,
        substance->>'memory_type' as memory_type,
        substring(substance->>'description' from 1 for 400) as description_preview,
        substance->>'created_at' as created_at,
        1 - (embedding_hv <=> ${vecStr}::halfvec) as similarity,
        'semantic' as match_type
      FROM nodes
      WHERE space_id = ${spaceId} AND node_type = 'memory'
        AND embedding_hv IS NOT NULL
        AND visibility <> 'deleted'
        ${typeFilter ? sql`AND substance->>'memory_type' = ${typeFilter}` : sql``}
      ORDER BY embedding_hv <=> ${vecStr}::halfvec
      LIMIT ${limit}
    ),
    keyword AS (
      SELECT addr, label,
        substance->>'memory_type' as memory_type,
        substring(substance->>'description' from 1 for 400) as description_preview,
        substance->>'created_at' as created_at,
        0.75 as similarity,
        'keyword' as match_type
      FROM nodes
      WHERE space_id = ${spaceId} AND node_type = 'memory'
        AND visibility <> 'deleted'
        ${typeFilter ? sql`AND substance->>'memory_type' = ${typeFilter}` : sql``}
        AND (
          label ILIKE ${ilikePattern}
          OR substance::text ILIKE ${ilikePattern}
        )
      LIMIT ${limit}
    ),
    combined AS (
      SELECT * FROM semantic
      UNION ALL
      SELECT * FROM keyword
    )
    SELECT DISTINCT ON (addr) addr, label, memory_type, description_preview, created_at,
      MAX(similarity) as similarity, match_type
    FROM combined
    GROUP BY addr, label, memory_type, description_preview, created_at, match_type
    ORDER BY addr, similarity DESC
  `;

  const sorted = memories
    .sort((a: any, b: any) => parseFloat(b.similarity) - parseFloat(a.similarity))
    .slice(0, limit);

  return c.json({ ok: true, count: sorted.length, query: q, memories: sorted });
});

export default remember;
