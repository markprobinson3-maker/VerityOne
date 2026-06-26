/**
 * QC Sentinel — Persistent Gemini QC gatekeeper
 *
 * Watches the staging queue and reviews one proposal at a time:
 * validate -> approve/reject/revise -> commit.
 *
 * Roles:
 *   - QC review for staging_nodes, staging_edges, and staging_updates
 *   - Proposal promotion / resonance maintenance
 *   - Lightweight queue and staging integrity audits
 *
 * Usage:
 *   bun run miners/src/qc-sentinel.ts              # run forever
 *   bun run miners/src/qc-sentinel.ts --once       # process one item and exit
 *   bun run miners/src/qc-sentinel.ts --batch 5    # process up to 5 items and exit
 *   bun run miners/src/qc-sentinel.ts --dry-run    # validate but don't commit
 */

import { hostname } from "node:os";
import postgres from "postgres";
import { callFlashLite, callPro, getModelId } from "./lib/llm";
import { startWorkerHeartbeat, type WorkerHeartbeatHandle } from "./lib/worker-heartbeat";
import { loadDurableAlignmentCandidate, refreshDurableNodeAlignments } from "../../api/src/lib/durable-alignment";
import { evaluatePublicGrounding, refreshPublicNodeGrounding } from "../../api/src/lib/public-grounding";
import { deriveSourceRefs } from "../../api/src/lib/source-refs";
import { writeEdge } from "../../api/src/lib/edge-mutations";
import { transitionMemoryLifecycleInTx, dismissRetiredEndpointConflicts } from "../../api/src/lib/memory-lifecycle";
import { makeWorkerSpendRecorder } from "../../api/src/lib/worker-llm-spend";
import { getDeploymentProfile } from "@verity-one/db-pool";
import { embedTextForInsert, embeddingTextForNode, type EmbedForInsert } from "@verity-one/embed";
import { canonicalizeEdgeType } from "@verity-one/graph-shape";
import { applyApprovedRegistryReconciliationProposals } from "./lib/registry-reconciliation";
import { applyApprovedProjectAssociationProposals } from "./lib/project-association-apply";
import {
  MAX_CONFIDENCE,
  PREFIX_TO_PYRAMID,
  QCDecision,
  ShapeResult,
  StagingEdge,
  StagingItem,
  StagingNode,
  StagingUpdate,
  SUPPORTED_UPDATE_FIELDS,
  parseJsonField,
  parseQcDecisionResponseWithRepair,
  sanitizeRevisionPatch,
  validateEdgeShape,
  validateNodeShape,
  validateUpdateShape,
  normalizeApprovedUpdateValue,
} from "./qc-sentinel-core";

// F3: qc-sentinel is a long-lived workload by design. Refuse to
// boot a serverless cron with this entrypoint. Exit BEFORE
// constructing any postgres clients so a misconfigured Vercel cron
// does not open a pool.
if (getDeploymentProfile() !== "long-lived") {
  console.log(
    "[qc-sentinel] serverless profile — exiting (sentinel is long-lived only)",
  );
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL || "postgresql://localhost:5432/verity";
const sql = postgres(dbUrl, {
  onnotice: () => {},
});
const listenSql = postgres(dbUrl, {
  onnotice: () => {},
});

const SENTINEL_AGENT = "qc-sentinel";
// Item 5: best-effort per-call LLM spend accounting. qc-sentinel is a system gatekeeper (not
// tenant-scoped work), so spend is recorded untenanted under the worker name; a throw here can
// never break a review (the spend hook is swallowed inside the LLM client).
const qcSpendRecorder = makeWorkerSpendRecorder(sql as any, { worker: SENTINEL_AGENT });
const SENTINEL_INSTANCE = `${hostname()}:${process.pid}`;
const MAX_REVISION_ATTEMPTS = 3;
const CLAIM_TIMEOUT_MS = Number(process.env.QC_SENTINEL_CLAIM_TIMEOUT_MS || 15 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.QC_SENTINEL_POLL_MS || 5_000);
const MAINTENANCE_INTERVAL_MS = Number(process.env.QC_SENTINEL_MAINTENANCE_MS || 45_000);
const DRAIN_DELAY_MS = Number(process.env.QC_SENTINEL_DRAIN_DELAY_MS || 100);
const REVISE_COOLDOWN_MS = Number(process.env.QC_SENTINEL_REVISE_COOLDOWN_MS || 15_000);
const MODEL_TIMEOUT_MS = Number(process.env.QC_SENTINEL_MODEL_TIMEOUT_MS || 20_000);
const MODEL_RETRIES = Number(process.env.QC_SENTINEL_MODEL_RETRIES || 2);
const RETRYABLE_QC_DELAY_MS = Number(process.env.QC_SENTINEL_RETRYABLE_QC_DELAY_MS || 30_000);
const FORMAT_RECOVERY_TIMEOUT_MS = Number(process.env.QC_SENTINEL_FORMAT_RECOVERY_TIMEOUT_MS || 8_000);
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const VALID_NODE_PYRAMIDS = new Set(Object.values(PREFIX_TO_PYRAMID));
const VALID_UPDATE_FIELDS = new Set<string>(SUPPORTED_UPDATE_FIELDS);

type StagingTable = "staging_nodes" | "staging_edges" | "staging_updates";
type PreparedUpdateEmbedding =
  | {
      field: "label";
      value: string;
      substanceSnapshot: unknown;
      embed: EmbedForInsert;
    }
  | {
      field: "substance";
      value: Record<string, unknown>;
      labelSnapshot: string;
      embed: EmbedForInsert;
    }
  | null;

let processedCount = 0;
let approvedCount = 0;
let rejectedCount = 0;
let revisedCount = 0;
let maintenanceRuns = 0;
let approvedSinceMaintenance = 0;
let lastAttemptedAt: string | null = null;
let lastProcessedAt: string | null = null;
let lastItemType: StagingItem["type"] | null = null;
let lastItemSummary: string | null = null;
let sentinelBlockingError: string | null = null;
const startTime = Date.now();
let lastHeartbeatAt = 0;
let drainRequested = false;
let drainInFlight: Promise<void> | null = null;
let maintenanceInFlight = false;
let sentinelHeartbeat: WorkerHeartbeatHandle | null = null;
let sentinelBlockedUntil = 0;

class RetryableQcError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs = RETRYABLE_QC_DELAY_MS) {
    super(message);
    this.name = "RetryableQcError";
    this.retryAfterMs = retryAfterMs;
  }
}

const QC_SYSTEM = `You are the QC Sentinel for Verity One, a knowledge pyramid truth map.
You validate exactly one staging item at a time.

Return exactly one JSON object with this shape:
{"decision":"approve"|"reject"|"revise","reason":"short reason","patch":{"field":"value"}}

Rules:
- Be precise and strict.
- Substance must be self-sufficient and written in natural language.
- No raw code in substance.
- Node labels must stay atomic.
- Edge labels must explain WHY the connection exists, not THAT it exists.
- Confidence must be <= ${MAX_CONFIDENCE} for new staging nodes and edges.
- Do not invent or modify identifiers, endpoints, addresses, run ids, pyramid ids, parents, or edge types.
- Non-durable VI items do not belong in staging. Reject them.
- Trend nodes are only valid when source_context.trend.graduation_review is true.

Allowed revise patches only:
- node: patch may contain label, substance, visibility
- edge: patch may contain label
- update: patch may contain new_value, reason

Never emit SQL. Never emit markdown. JSON only.`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tableForItem(staging: StagingItem): StagingTable {
  if (staging.type === "node") return "staging_nodes";
  if (staging.type === "edge") return "staging_edges";
  return "staging_updates";
}

function itemDescription(staging: StagingItem): string {
  if (staging.type === "node") return `[${staging.item.addr}] ${staging.item.label}`;
  if (staging.type === "edge") return `${staging.item.from_addr} -> ${staging.item.to_addr} [${staging.item.edge_type}]`;
  return `[${staging.item.addr}] ${staging.item.field}`;
}

function comparableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function heartbeatMetadata(): Record<string, unknown> {
  return {
    model: getModelId("pro"),
    poll_interval_ms: POLL_INTERVAL_MS,
    maintenance_interval_ms: MAINTENANCE_INTERVAL_MS,
    processed: processedCount,
    approved: approvedCount,
    rejected: rejectedCount,
    revised: revisedCount,
    maintenance_runs: maintenanceRuns,
    last_attempted_at: lastAttemptedAt,
    last_processed_at: lastProcessedAt,
    last_item_type: lastItemType,
    last_item_summary: lastItemSummary,
    blocked_reason: sentinelBlockingError,
    blocked_until: sentinelBlockedUntil > Date.now() ? new Date(sentinelBlockedUntil).toISOString() : null,
  };
}

async function beatSentinel(status: "running" | "idle" | "error" = "running"): Promise<void> {
  await sentinelHeartbeat?.beat({
    status,
    metadata: heartbeatMetadata(),
    error: sentinelBlockingError,
  });
}

function blockRemainingMs(now = Date.now()): number {
  if (sentinelBlockedUntil <= now) {
    sentinelBlockedUntil = 0;
    return 0;
  }
  return sentinelBlockedUntil - now;
}

function setSentinelBlocked(message: string, retryAfterMs: number): void {
  const now = Date.now();
  sentinelBlockedUntil = Math.max(sentinelBlockedUntil, now + Math.max(retryAfterMs, RETRYABLE_QC_DELAY_MS));
  const untilIso = new Date(sentinelBlockedUntil).toISOString();
  sentinelBlockingError = `${message} [pro_backoff_until=${untilIso}]`;
}

function clearSentinelBlocked(): void {
  sentinelBlockedUntil = 0;
  sentinelBlockingError = null;
}

async function autoRejectExhaustedRevisions(): Promise<void> {
  const tables: StagingTable[] = ["staging_nodes", "staging_edges", "staging_updates"];
  for (const table of tables) {
    await sql`
      UPDATE ${sql(table)}
      SET qc_status = 'rejected',
          qc_agent = ${SENTINEL_AGENT},
          qc_notes = ${`Exceeded max revision attempts (${MAX_REVISION_ATTEMPTS})`},
          qc_timestamp = NOW(),
          claimed_at = NULL,
          claimed_by = NULL
      WHERE qc_status = 'revised'
        AND COALESCE(revision_count, 0) >= ${MAX_REVISION_ATTEMPTS}`;
  }
}

async function claimFromTable<T>(table: StagingTable): Promise<T | null> {
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const [row] = await sql<T[]>`
    WITH candidate AS (
      SELECT id
      FROM ${sql(table)}
      WHERE qc_status IN ('pending', 'revised')
        AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
        AND (retry_after IS NULL OR retry_after <= NOW())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${sql(table)} AS item
    SET claimed_at = NOW(),
        claimed_by = ${SENTINEL_INSTANCE},
        last_error = NULL
    FROM candidate
    WHERE item.id = candidate.id
    RETURNING item.*`;

  return row || null;
}

async function claimNextPending(): Promise<StagingItem | null> {
  await autoRejectExhaustedRevisions();

  const node = await claimFromTable<StagingNode>("staging_nodes");
  if (node) return { type: "node", item: node };

  const update = await claimFromTable<StagingUpdate>("staging_updates");
  if (update) return { type: "update", item: update };

  const edge = await claimFromTable<StagingEdge>("staging_edges");
  if (edge) return { type: "edge", item: edge };

  return null;
}

async function markStaging(
  table: StagingTable,
  id: number,
  status: string,
  agent: string,
  notes: string,
  opts: { incrementRevision?: boolean; lastError?: string | null } = {},
  tx: any = sql,
): Promise<void> {
  const retryAfter = opts.incrementRevision ? new Date(Date.now() + REVISE_COOLDOWN_MS) : null;
  await tx`
    UPDATE ${tx(table)}
    SET qc_status = ${status},
        qc_agent = ${agent},
        qc_notes = ${notes},
        qc_timestamp = NOW(),
        revision_count = CASE
          WHEN ${opts.incrementRevision === true} THEN COALESCE(revision_count, 0) + 1
          ELSE COALESCE(revision_count, 0)
        END,
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = ${retryAfter},
        last_error = ${opts.lastError ?? null}
    WHERE id = ${id}`;
}

async function releaseClaim(staging: StagingItem, lastError?: string, retryAfterMs = 0): Promise<void> {
  const table = tableForItem(staging);
  const retryAfter = retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs) : null;
  await sql`
    UPDATE ${sql(table)}
    SET claimed_at = NULL,
        claimed_by = NULL,
        retry_after = ${retryAfter},
        last_error = ${lastError ?? null}
    WHERE id = ${staging.item.id}`;
}

function buildProvenance(runId: string, sourceFiles: any[] = []) {
  return {
    agent: SENTINEL_AGENT,
    model: getModelId("pro"),
    run_id: runId,
    sources: sourceFiles,
    created: new Date().toISOString(),
  };
}

async function buildNodeContext(node: StagingNode): Promise<string> {
  const [existing] = await sql`SELECT addr, label FROM nodes WHERE addr = ${node.addr}`;
  const [parent] = node.parent_addr
    ? await sql`SELECT addr, label, substance->>'description' as description FROM nodes WHERE addr = ${node.parent_addr}`
    : [null];
  const dupes = await sql`
    SELECT addr, label
    FROM nodes
    WHERE pyramid_id = ${node.pyramid_id}
      AND label ILIKE ${node.label}
      AND addr != ${node.addr}
    LIMIT 3`;
  const stagingDupes = await sql`
    SELECT id, addr, label
    FROM staging_nodes
    WHERE pyramid_id = ${node.pyramid_id}
      AND label ILIKE ${node.label}
      AND id != ${node.id}
      AND qc_status IN ('pending', 'revised')
    LIMIT 3`;

  return `
ITEM_TYPE: node
PROPOSED_NODE:
  id: ${node.id}
  addr: ${node.addr}
  pyramid_id: ${node.pyramid_id}
  layer: ${node.layer}
  depth: ${node.depth}
  position: ${node.position}
  label: ${node.label}
  confidence: ${node.confidence}
  parent_addr: ${node.parent_addr || "none"}
  visibility: ${node.visibility}
  source_context: ${JSON.stringify(node.source_context || {})}
  substance: ${JSON.stringify(node.substance)}

CONTEXT:
  addr_exists: ${existing ? `YES [${existing.addr}] ${existing.label}` : "no"}
  parent_exists: ${parent ? `YES [${parent.addr}] ${parent.label}: ${String((parent as any).description || "").slice(0, 200)}` : node.parent_addr ? "NO" : "n/a"}
  duplicate_labels: ${dupes.length > 0 ? dupes.map((d: any) => `[${d.addr}] ${d.label}`).join(", ") : "none"}
  duplicate_staging: ${stagingDupes.length > 0 ? stagingDupes.map((d: any) => `[id=${d.id}] ${d.label}`).join(", ") : "none"}
`.trim();
}

async function buildEdgeContext(edge: StagingEdge): Promise<string> {
  const [fromNode] = await sql`SELECT addr, label FROM nodes WHERE addr = ${edge.from_addr}`;
  const [toNode] = await sql`SELECT addr, label FROM nodes WHERE addr = ${edge.to_addr}`;
  const [existingEdge] = await sql`
    SELECT from_addr, to_addr, edge_type, label
    FROM edges
    WHERE from_addr = ${edge.from_addr}
      AND to_addr = ${edge.to_addr}
      AND edge_type = ${edge.edge_type}`;

  return `
ITEM_TYPE: edge
PROPOSED_EDGE:
  id: ${edge.id}
  from_addr: ${edge.from_addr}
  to_addr: ${edge.to_addr}
  edge_type: ${edge.edge_type}
  layer: ${edge.layer}
  label: ${edge.label}
  confidence: ${edge.confidence}
  source_context: ${JSON.stringify(edge.source_context || {})}

CONTEXT:
  from_exists: ${fromNode ? `YES [${fromNode.addr}] ${fromNode.label}` : "NO"}
  to_exists: ${toNode ? `YES [${toNode.addr}] ${toNode.label}` : "NO"}
  duplicate_edge: ${existingEdge ? `YES ${existingEdge.label}` : "no"}
`.trim();
}

async function buildUpdateContext(update: StagingUpdate): Promise<string> {
  const [node] = await sql`
    SELECT addr, label, to_jsonb(nodes) as node_json
    FROM nodes
    WHERE addr = ${update.addr}`;
  const currentValue = node?.node_json?.[update.field];

  return `
ITEM_TYPE: update
PROPOSED_UPDATE:
  id: ${update.id}
  addr: ${update.addr}
  field: ${update.field}
  current_value: ${JSON.stringify(currentValue)}
  proposed_value: ${JSON.stringify(update.new_value)}
  old_value: ${JSON.stringify(update.old_value)}
  reason: ${update.reason}

CONTEXT:
  node_exists: ${node ? `YES [${node.addr}] ${node.label}` : "NO"}
  field_supported: ${VALID_UPDATE_FIELDS.has(update.field) ? "yes" : "no"}
`.trim();
}

async function buildContext(staging: StagingItem): Promise<string> {
  if (staging.type === "node") return buildNodeContext(staging.item);
  if (staging.type === "edge") return buildEdgeContext(staging.item);
  return buildUpdateContext(staging.item);
}

async function callQcModel(prompt: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MODEL_RETRIES; attempt++) {
    try {
      return await callPro(prompt, {
        temperature: 0.05,
        maxTokens: 2048,
        jsonMode: true,
        timeoutMs: MODEL_TIMEOUT_MS,
        spend: qcSpendRecorder,
      });
    } catch (error) {
      lastError = error;
      const retryAfterMs = retryDelayForQcError(error);
      if (attempt >= MODEL_RETRIES || retryAfterMs > 0) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unknown QC model error");
}

function truncateForPrompt(value: string, limit = 1200): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}...`;
}

async function repairQcResponse(
  raw: string,
  type: StagingItem["type"],
  error: Error,
): Promise<string | null> {
  if (!raw.trim()) return null;

  const prompt = `A QC model returned malformed output for a ${type} review.
Repair it into exactly one JSON object with this shape:
{"decision":"approve"|"reject"|"revise","reason":"short reason","patch":{"field":"value"}}

Rules:
- Preserve the original intent of the QC output.
- If the intent is unclear, return reject with a concise reason.
- Only include patch fields that are safe for the item type.
- No markdown. No explanation. JSON only.

Parse error:
${truncateForPrompt(error.message, 240)}

Malformed output:
${truncateForPrompt(raw, 4000)}`;

  return callFlashLite(prompt, {
    temperature: 0,
    maxTokens: 512,
    jsonMode: true,
    timeoutMs: FORMAT_RECOVERY_TIMEOUT_MS,
    spend: qcSpendRecorder,
  });
}

function retryDelayForQcError(error: any): number {
  if (typeof error?.retryAfterMs === "number" && error.retryAfterMs > 0) {
    return error.retryAfterMs;
  }

  const status = Number(error?.status || 0);
  if (status === 404 || status === 429 || status === 500 || status === 503) {
    return RETRYABLE_QC_DELAY_MS;
  }

  if (error?.name === "AbortError") {
    return RETRYABLE_QC_DELAY_MS;
  }

  return 0;
}

async function validateItem(staging: StagingItem): Promise<QCDecision> {
  const context = await buildContext(staging);
  const prompt = `${QC_SYSTEM}\n\n${context}`;
  const raw = await callQcModel(prompt);

  try {
    const decision = await parseQcDecisionResponseWithRepair(
      raw,
      staging.type,
      (malformedRaw, parseError) => repairQcResponse(malformedRaw, staging.type, parseError),
    );
    if (decision.decision === "revise" && !decision.patch) {
      return {
        decision: "reject",
        reason: "QC revise decision omitted a safe patch",
      };
    }
    return decision;
  } catch (error: any) {
    throw new RetryableQcError(
      `Malformed QC response after repair: ${error.message.slice(0, 180)}`,
      RETRYABLE_QC_DELAY_MS,
    );
  }
}

async function extractAgentFromRunId(runId: string): Promise<string> {
  try {
    const [run] = await sql`
      SELECT mode
      FROM mining_runs
      WHERE run_number::text = ${runId}
         OR mode || '-' || run_number::text = ${runId}`;
    return run?.mode || "unknown";
  } catch {
    return "unknown";
  }
}

async function prepareApprovedUpdateEmbedding(update: StagingUpdate): Promise<PreparedUpdateEmbedding> {
  const normalizedValue = normalizeApprovedUpdateValue(update.field, update.new_value);
  if (update.field === "label") {
    const [row] = await sql`SELECT substance FROM nodes WHERE addr = ${update.addr}`;
    if (!row) throw new Error(`Cannot approve update for missing node ${update.addr}`);
    const newLabel = normalizedValue as string;
    return {
      field: "label",
      value: newLabel,
      substanceSnapshot: row.substance,
      embed: await embedTextForInsert(embeddingTextForNode(newLabel, row.substance)),
    };
  }
  if (update.field === "substance") {
    const [row] = await sql`SELECT label FROM nodes WHERE addr = ${update.addr}`;
    if (!row) throw new Error(`Cannot approve update for missing node ${update.addr}`);
    const substance = normalizedValue as Record<string, unknown>;
    const labelSnapshot = row.label || "";
    return {
      field: "substance",
      value: substance,
      labelSnapshot,
      embed: await embedTextForInsert(embeddingTextForNode(labelSnapshot, substance)),
    };
  }
  return null;
}

async function applyApprovedUpdate(
  update: StagingUpdate,
  tx: any,
  preparedEmbedding: PreparedUpdateEmbedding,
): Promise<void> {
  const normalizedValue = normalizeApprovedUpdateValue(update.field, update.new_value);
  const [existing] = await tx`SELECT addr, node_type, visibility FROM nodes WHERE addr = ${update.addr}`;
  if (!existing) throw new Error(`Cannot approve update for missing node ${update.addr}`);

  switch (update.field) {
    case "label": {
      if (!preparedEmbedding || preparedEmbedding.field !== "label") {
        throw new Error(`Missing precomputed embedding for label update ${update.addr}`);
      }
      const newLabel = normalizedValue as string;
      const refreshed = preparedEmbedding.embed;
      const updatedRows = await tx`
        UPDATE nodes
        SET label = ${newLabel},
            embedding_hv = ${refreshed.vecStr}::halfvec(3072),
            embedding_at = ${refreshed.embeddedAt},
            embedding_model = ${refreshed.model},
            embedding_task_type = ${refreshed.taskType},
            updated_at = NOW()
        WHERE addr = ${update.addr}
          AND substance IS NOT DISTINCT FROM ${tx.json(preparedEmbedding.substanceSnapshot ?? null)}::jsonb
        RETURNING addr`;
      if (updatedRows.length === 0) {
        throw new Error(`Node changed while label update embedding was being computed: ${update.addr}`);
      }
      if (existing.visibility === "public") await refreshPublicNodeGrounding(tx, update.addr);
      return;
    }
    case "confidence":
      await tx`
        UPDATE nodes
        SET confidence = ${normalizedValue as number},
            updated_at = NOW()
        WHERE addr = ${update.addr}`;
      if (existing.visibility === "public") await refreshPublicNodeGrounding(tx, update.addr);
      return;
    case "visibility":
      await tx`
        UPDATE nodes
        SET visibility = ${normalizedValue as string},
            updated_at = NOW()
        WHERE addr = ${update.addr}`;
      if ((normalizedValue as string) === "public" || existing.visibility === "public") {
        await refreshPublicNodeGrounding(tx, update.addr);
      }
      return;
    case "substance": {
      if (!preparedEmbedding || preparedEmbedding.field !== "substance") {
        throw new Error(`Missing precomputed embedding for substance update ${update.addr}`);
      }
      const substance = normalizedValue as Record<string, unknown>;
      const refreshed = preparedEmbedding.embed;
      const updatedRows = await tx`
        UPDATE nodes
        SET substance = ${tx.json(substance)},
            node_type = ${String(substance.node_type || existing.node_type || "") || null},
            embedding_hv = ${refreshed.vecStr}::halfvec(3072),
            embedding_at = ${refreshed.embeddedAt},
            embedding_model = ${refreshed.model},
            embedding_task_type = ${refreshed.taskType},
            updated_at = NOW()
        WHERE addr = ${update.addr}
          AND label IS NOT DISTINCT FROM ${preparedEmbedding.labelSnapshot}
        RETURNING addr`;
      if (updatedRows.length === 0) {
        throw new Error(`Node changed while substance update embedding was being computed: ${update.addr}`);
      }
      if (existing.visibility === "public") await refreshPublicNodeGrounding(tx, update.addr);
      return;
    }
    default:
      throw new Error(`Unsupported update field: ${update.field}`);
  }
}

async function applyRevisionPatch(staging: StagingItem, patch: Record<string, unknown>, tx: any): Promise<void> {
  const sanitized = sanitizeRevisionPatch(staging.type, patch);
  if (!sanitized) throw new Error("Revision patch did not include any safe fields");

  if (staging.type === "node") {
    if (sanitized.label !== undefined) {
      await tx`UPDATE staging_nodes SET label = ${sanitized.label as string} WHERE id = ${staging.item.id}`;
    }
    if (sanitized.substance !== undefined) {
      const normalizedSubstance = parseJsonField<Record<string, unknown>>(sanitized.substance) || sanitized.substance;
      if (!normalizedSubstance || typeof normalizedSubstance !== "object" || Array.isArray(normalizedSubstance)) {
        throw new Error("Revision substance patch must resolve to an object payload");
      }
      await tx`
        UPDATE staging_nodes
        SET substance = ${tx.json(normalizedSubstance)}
        WHERE id = ${staging.item.id}`;
    }
    if (sanitized.visibility !== undefined) {
      await tx`
        UPDATE staging_nodes
        SET visibility = ${sanitized.visibility as string}
        WHERE id = ${staging.item.id}`;
    }
    return;
  }

  if (staging.type === "edge") {
    await tx`
      UPDATE staging_edges
      SET label = ${sanitized.label as string}
      WHERE id = ${staging.item.id}`;
    return;
  }

  if (sanitized.new_value !== undefined) {
    await tx`
      UPDATE staging_updates
      SET new_value = ${tx.json(sanitized.new_value)}
      WHERE id = ${staging.item.id}`;
  }
  if (sanitized.reason !== undefined) {
    await tx`
      UPDATE staging_updates
      SET reason = ${sanitized.reason as string}
      WHERE id = ${staging.item.id}`;
  }
}

async function applyDecision(staging: StagingItem, decision: QCDecision): Promise<void> {
  const table = tableForItem(staging);
  const runId = staging.item.run_id;
  const sourceAgent = await extractAgentFromRunId(runId);
  const promotionEmbed =
    decision.decision === "approve" && staging.type === "node"
      ? await embedTextForInsert(
          embeddingTextForNode(staging.item.label, staging.item.substance),
        )
      : null;
  const preparedUpdateEmbedding =
    decision.decision === "approve" && staging.type === "update"
      ? await prepareApprovedUpdateEmbedding(staging.item)
      : null;

  await sql.begin(async (tx) => {
    if (decision.decision === "approve") {
      if (staging.type === "node") {
        const node = staging.item;
        if (!promotionEmbed) throw new Error(`Missing precomputed embedding for node promotion ${node.addr}`);
        let sourceFiles: any[] = [];
        const sourceCtx = parseJsonField<Record<string, unknown>>(node.source_context) || {};
        try {
          const [run] = await tx`
            SELECT source_files
            FROM mining_runs
            WHERE run_number::text = ${runId}
               OR mode || '-' || run_number::text = ${runId}`;
          if (run?.source_files) sourceFiles = run.source_files;
        } catch {
          sourceFiles = [];
        }

        const [effConf] = await tx`
          SELECT effective_confidence(${node.confidence}::real, ${sourceAgent})`;
        const finalConfidence = parseFloat(effConf.effective_confidence);
        const groundedNode = evaluatePublicGrounding({
          spaceId: "global",
          visibility: node.visibility,
          confidence: finalConfidence,
          sourceRefs: deriveSourceRefs({
            sourceContext: sourceCtx,
            provenanceSources: sourceFiles,
          }),
          sourceContext: sourceCtx,
        });

        const insertedNode = await tx`
          INSERT INTO nodes (
            addr, pyramid_id, layer, depth, position, label, substance, confidence, hash,
            provenance, parent_addr, visibility, node_type, source_context, source_refs,
            embedding_hv, embedding_at, embedding_model, embedding_task_type
          )
          VALUES (
            ${node.addr}, ${node.pyramid_id}, ${node.layer}, ${node.depth}, ${node.position},
            ${node.label}, ${tx.json(node.substance)}, ${groundedNode.confidence}, 'pending',
            ${tx.json(buildProvenance(runId, sourceFiles))},
            ${node.parent_addr}, ${node.visibility}, ${(node.substance as any)?.node_type || null},
            ${tx.json(groundedNode.sourceContext)},
            ${tx.json(groundedNode.sourceRefs)},
            ${promotionEmbed.vecStr}::halfvec(3072),
            ${promotionEmbed.embeddedAt},
            ${promotionEmbed.model},
            ${promotionEmbed.taskType}
          )
          ON CONFLICT (addr) DO NOTHING
          RETURNING addr`;

        if (insertedNode.length === 0) {
          console.log(`  ⚠ Node ${node.addr} already exists — marking staging as duplicate`);
          await markStaging(table, staging.item.id, "rejected", SENTINEL_AGENT, "Duplicate: node addr already exists in production graph", {}, tx);
          return;
        }

        const viBatchId = (sourceCtx as any)?.vi_batch_id || node.run_id;
        await tx`
          UPDATE atom_feedback
          SET node_addr = ${node.addr}
          WHERE ingest_batch_id = ${viBatchId}
            AND node_addr IS NULL
            AND classification = 'AUTO_ON'`;

        const alignmentCandidate = await loadDurableAlignmentCandidate(tx, node.addr);
        if (alignmentCandidate) {
          await refreshDurableNodeAlignments(tx, alignmentCandidate);
        }
      } else if (staging.type === "edge") {
        const edge = staging.item;
        const canonicalEdgeType = canonicalizeEdgeType(edge.edge_type);
        if (!canonicalEdgeType) {
          console.log(`  ✗ Edge ${edge.from_addr}→${edge.to_addr} has non-canonical edge_type ${edge.edge_type}`);
          await markStaging(table, staging.item.id, "rejected", SENTINEL_AGENT, `Invalid edge_type: ${edge.edge_type}`, {}, tx);
          return;
        }
        const [effConf] = await tx`
          SELECT effective_confidence(${edge.confidence}::real, ${sourceAgent})`;
        const finalConfidence = parseFloat(effConf.effective_confidence);
        const insertedEdge = await writeEdge(sql as any, {
          fromAddr: edge.from_addr,
          toAddr: edge.to_addr,
          edgeType: canonicalEdgeType,
          layer: edge.layer,
          label: edge.label,
          confidence: finalConfidence,
          // Omit hash so normalizeEdgeWriteParams fills the canonical
          // md5(from|type|to); passing "pending" left a never-recomputed
          // placeholder (foundation audit 2026-06-10 — the live 3,832 pending
          // edge hashes trace to this + the trend engine + seed files).
          provenance: buildProvenance(runId),
          sourceContext: parseJsonField(edge.source_context) || {},
        }, { tx: tx as any });

        if (!insertedEdge.inserted) {
          console.log(`  ⚠ Edge ${edge.from_addr}→${edge.to_addr} already exists — marking staging as duplicate`);
          await markStaging(table, staging.item.id, "rejected", SENTINEL_AGENT, "Duplicate: edge already exists in production graph", {}, tx);
          return;
        }
      } else {
        await applyApprovedUpdate(staging.item, tx, preparedUpdateEmbedding);
        if (staging.item.field === "label" || staging.item.field === "substance") {
          const alignmentCandidate = await loadDurableAlignmentCandidate(tx, staging.item.addr);
          if (alignmentCandidate) {
            await refreshDurableNodeAlignments(tx, alignmentCandidate);
          }
        }
      }

      await markStaging(table, staging.item.id, "approved", SENTINEL_AGENT, decision.reason, {}, tx);
      if (sourceAgent !== "unknown") {
        await tx`SELECT update_source_trust(${sourceAgent}, 'approved')`;
      }
      approvedCount++;
      approvedSinceMaintenance++;
      return;
    }

    if (decision.decision === "reject") {
      await markStaging(table, staging.item.id, "rejected", SENTINEL_AGENT, decision.reason, {}, tx);
      if (sourceAgent !== "unknown") {
        await tx`SELECT update_source_trust(${sourceAgent}, 'rejected')`;
      }
      rejectedCount++;
      return;
    }

    await applyRevisionPatch(staging, decision.patch || {}, tx);
    await markStaging(
      table,
      staging.item.id,
      "revised",
      SENTINEL_AGENT,
      decision.reason,
      { incrementRevision: true },
      tx,
    );
    if (sourceAgent !== "unknown") {
      await tx`SELECT update_source_trust(${sourceAgent}, 'revised')`;
    }
    revisedCount++;
  });
}

function jsonObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function jsonArray(value: unknown): any[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function tenantSupersessionCorrelationId(proposal: { id: number; evidence: unknown }, suffix: "apply" | "rollback"): string {
  const evidence = jsonArray(proposal.evidence);
  const cycleNumber = evidence.find((entry) => entry && typeof entry === "object" && entry.cycle_number != null)?.cycle_number;
  const stableId = cycleNumber == null ? `proposal-${proposal.id}` : String(cycleNumber);
  return `supercron-${stableId}-${suffix}`;
}

function memoryMergeCorrelationId(proposal: { id: number; evidence: unknown }, suffix: "rollback"): string {
  const evidence = jsonArray(proposal.evidence);
  const cycleNumber = evidence.find((entry) => entry && typeof entry === "object" && entry.cycle_number != null)?.cycle_number;
  const stableId = cycleNumber == null ? `proposal-${proposal.id}` : String(cycleNumber);
  return `supercron-${stableId}-memory-merge-${suffix}`;
}

async function applyApprovedTenantSupersessionProposals(): Promise<number> {
  let applied = 0;
  const proposals = await sql`
    SELECT id, from_addr, to_addr, target_addr, payload, evidence
    FROM proposals
    WHERE proposal_type = 'node_edit'
      AND status = 'approved'
      AND payload->>'action' = 'tenant_memory_supersession'
    ORDER BY reviewed_at ASC NULLS LAST, created_at ASC
    LIMIT 50`;

  for (const proposal of proposals) {
    try {
      await sql.begin(async (tx: any) => {
        const [locked] = await tx`
          SELECT id, from_addr, to_addr, target_addr, payload, evidence
          FROM proposals
          WHERE id = ${proposal.id}
            AND proposal_type = 'node_edit'
            AND status = 'approved'
            AND payload->>'action' = 'tenant_memory_supersession'
          FOR UPDATE`;
        if (!locked) return;

        const payload = jsonObject(locked.payload);
        const olderAddr = String(payload.older_addr || locked.target_addr || locked.to_addr || "");
        const newerAddr = String(payload.newer_addr || locked.from_addr || "");
        const [pair] = await tx`
          SELECT
            older.addr AS older_addr,
            newer.addr AS newer_addr,
            substring(older.space_id from 8) AS tenant_id
          FROM nodes older
          JOIN nodes newer
            ON newer.addr = ${newerAddr}
            AND newer.space_id = older.space_id
            AND newer.node_type = 'memory'
          WHERE older.addr = ${olderAddr}
            AND older.node_type = 'memory'
            AND older.space_id LIKE 'tenant:%'`;

        if (!pair) {
          await tx`
            UPDATE proposals
            SET status = 'rejected', reviewed_by = COALESCE(reviewed_by, ${SENTINEL_AGENT}), reviewed_at = COALESCE(reviewed_at, NOW())
            WHERE id = ${locked.id}`;
          return;
        }

        const result = await transitionMemoryLifecycleInTx(tx, {
          addr: pair.older_addr,
          tenantId: pair.tenant_id,
          status: "superseded",
          actor: SENTINEL_AGENT,
          reason: "Approved tenant memory supersession proposal",
          supersededByAddr: pair.newer_addr,
          correlationId: tenantSupersessionCorrelationId({ id: locked.id, evidence: locked.evidence }, "apply"),
          enforceProtectedGuard: true,
          proposalId: locked.id,
          eventData: {
            action: "tenant_memory_supersession",
            superseded_by_addr: pair.newer_addr,
          },
        });
        if (!result.ok) {
          await tx`
            UPDATE proposals
            SET status = 'rejected', reviewed_by = COALESCE(reviewed_by, ${SENTINEL_AGENT}), reviewed_at = COALESCE(reviewed_at, NOW())
            WHERE id = ${locked.id}`;
          return;
        }

        await tx`
          UPDATE proposals
          SET status = 'applied', applied_at = NOW()
          WHERE id = ${locked.id}`;
        applied++;
      });
    } catch (error) {
      console.warn(`[qc-sentinel] failed to apply tenant supersession proposal ${proposal.id}:`, (error as Error).message);
    }
  }

  return applied;
}

async function recordProposalRollbackEvents(): Promise<number> {
  let recorded = 0;
  const proposals = await sql`
    SELECT
      p.id,
      p.target_addr,
      p.to_addr,
      p.payload,
      p.evidence,
      substring(n.space_id from 8) AS tenant_id
    FROM proposals p
    JOIN nodes n
      ON n.addr = COALESCE(p.target_addr, p.to_addr)
      AND n.node_type = 'memory'
      AND n.space_id LIKE 'tenant:%'
    WHERE p.proposal_type = 'node_edit'
      AND p.status = 'rejected'
      AND p.payload->>'action' = 'tenant_memory_supersession'
      AND COALESCE(p.reviewed_at, p.created_at) > now() - interval '30 days'
    ORDER BY COALESCE(p.reviewed_at, p.created_at) DESC
    LIMIT 100`;

  for (const proposal of proposals) {
    const addr = String(proposal.target_addr || proposal.to_addr || "");
    const correlationId = tenantSupersessionCorrelationId(proposal, "rollback");
    const [existing] = await sql`
      SELECT 1
      FROM memory_events
      WHERE addr = ${addr}
        AND tenant_id = ${proposal.tenant_id}
        AND correlation_id = ${correlationId}
      LIMIT 1`;
    if (existing) continue;

    await sql`
      INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id)
      VALUES (
        ${addr},
        ${proposal.tenant_id},
        'supercron_rollback',
        ${sql.json({
          proposal_id: proposal.id,
          action: "tenant_memory_supersession",
          older_addr: addr,
          newer_addr: jsonObject(proposal.payload).newer_addr || null,
        })},
        ${SENTINEL_AGENT},
        ${correlationId}
      )`;
    recorded++;
  }

  const memoryMergeProposals = await sql`
    SELECT
      p.id,
      p.from_addr,
      p.to_addr,
      p.target_addr,
      p.payload,
      p.evidence,
      substring(n.space_id from 8) AS tenant_id
    FROM proposals p
    JOIN nodes n
      ON n.addr = COALESCE(p.target_addr, p.from_addr, p.to_addr)
      AND n.node_type = 'memory'
      AND n.space_id LIKE 'tenant:%'
    WHERE p.proposal_type = 'node_edit'
      AND p.status = 'rejected'
      AND p.payload->>'action' = 'memory_merge'
      AND COALESCE(p.reviewed_at, p.created_at) > now() - interval '30 days'
    ORDER BY COALESCE(p.reviewed_at, p.created_at) DESC
    LIMIT 100`;

  for (const proposal of memoryMergeProposals) {
    const payload = jsonObject(proposal.payload);
    const survivorAddr = String(payload.survivor?.addr || payload.winner?.addr || proposal.target_addr || proposal.from_addr || "");
    const loserAddr = String(payload.loser?.addr || proposal.to_addr || "");
    const addrs = [...new Set([survivorAddr, loserAddr].filter(Boolean))];
    const correlationId = memoryMergeCorrelationId(proposal, "rollback");

    for (const addr of addrs) {
      const [existing] = await sql`
        SELECT 1
        FROM memory_events
        WHERE addr = ${addr}
          AND tenant_id = ${proposal.tenant_id}
          AND correlation_id = ${correlationId}
        LIMIT 1`;
      if (existing) continue;

      await sql`
        INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id)
        VALUES (
          ${addr},
          ${proposal.tenant_id},
          'supercron_rollback',
          ${sql.json({
            proposal_id: proposal.id,
            action: "memory_merge",
            survivor_addr: survivorAddr || null,
            loser_addr: loserAddr || null,
          })},
          ${SENTINEL_AGENT},
          ${correlationId}
        )`;
      recorded++;
    }
  }

  return recorded;
}

async function promoteProposals(): Promise<{ tensions: number; inferences: number; tenantSupersessions: number; registryReconciliations: number; projectAssociations: number; projectAssociationsRejected: number; conflictsDismissed: number; proposalRollbacks: number }> {
  let tensionsPromoted = 0;
  let inferencesPromoted = 0;

  const pendingTensions = await sql`
    SELECT id, from_addr, to_addr, payload, confidence, evidence, discovered_by
    FROM proposals
    WHERE proposal_type = 'tension' AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 50`;

  for (const proposal of pendingTensions) {
    try {
      const payload = typeof proposal.payload === "string" ? JSON.parse(proposal.payload) : proposal.payload;
      const discoveredBy = String((proposal as any).discovered_by || "");
      const normalizedDiscoveredBy = discoveredBy.startsWith("distiller") ? "dialectic" : discoveredBy || "scanner";
      const [fromExists] = await sql`SELECT addr FROM nodes WHERE addr = ${proposal.from_addr}`;
      const [toExists] = await sql`SELECT addr FROM nodes WHERE addr = ${proposal.to_addr}`;
      if (!fromExists || !toExists) {
        await sql`
          UPDATE proposals
          SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
          WHERE id = ${proposal.id}`;
        continue;
      }

      await sql`
        INSERT INTO edge_tensions (
          from_addr,
          to_addr,
          tension,
          tension_type,
          synthesis,
          synthesis_confidence,
          discovered_by,
          evidence,
          visibility
        )
        VALUES (
          ${proposal.from_addr},
          ${proposal.to_addr},
          ${payload.tension || 0.5},
          ${payload.tension_type || "complement"},
          ${payload.synthesis || null},
          ${payload.synthesis_confidence ?? proposal.confidence ?? null},
          ${normalizedDiscoveredBy},
          ${sql.json(proposal.evidence || [])},
          ${payload.visibility || "public"}
        )
        ON CONFLICT (from_addr, to_addr, tension_type) DO NOTHING`;

      await sql`
        UPDATE proposals
        SET status = 'approved', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW(), applied_at = NOW()
        WHERE id = ${proposal.id}`;
      tensionsPromoted++;
    } catch {
      await sql`
        UPDATE proposals
        SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
        WHERE id = ${proposal.id}`;
    }
  }

  const pendingInferences = await sql`
    SELECT id, from_addr, to_addr, payload, confidence, evidence
    FROM proposals
    WHERE proposal_type = 'inference' AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 50`;

  for (const proposal of pendingInferences) {
    try {
      const payload = typeof proposal.payload === "string" ? JSON.parse(proposal.payload) : proposal.payload;
      const [fromExists] = await sql`SELECT addr FROM nodes WHERE addr = ${proposal.from_addr}`;
      const [toExists] = await sql`SELECT addr FROM nodes WHERE addr = ${proposal.to_addr}`;
      if (!fromExists || !toExists) {
        await sql`
          UPDATE proposals
          SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
          WHERE id = ${proposal.id}`;
        continue;
      }

      const edgeType = canonicalizeEdgeType(payload.edge_type || "composes_with");
      if (!edgeType) {
        await sql`
          UPDATE proposals
          SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
          WHERE id = ${proposal.id}`;
        continue;
      }
      const [existing] = await sql`
        SELECT 1
        FROM edges
        WHERE from_addr = ${proposal.from_addr}
          AND to_addr = ${proposal.to_addr}
          AND edge_type = ${edgeType}`;
      if (existing) {
        await sql`
          UPDATE proposals
          SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
          WHERE id = ${proposal.id}`;
        continue;
      }

      const insertedEdge = await writeEdge(sql as any, {
        fromAddr: proposal.from_addr,
        toAddr: proposal.to_addr,
        edgeType,
        label: `Inferred via ${payload.via_label || "transitive composition"}`,
        layer: 0,
        confidence: proposal.confidence || 0.5,
        hash: "inference",
        provenance: { agent: SENTINEL_AGENT, source: "dialectic-scanner", via: payload.via_node },
      });
      if (!insertedEdge.inserted) {
        await sql`
          UPDATE proposals
          SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
          WHERE id = ${proposal.id}`;
        continue;
      }

      await sql`
        UPDATE proposals
        SET status = 'approved', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW(), applied_at = NOW()
        WHERE id = ${proposal.id}`;
      inferencesPromoted++;
    } catch {
      await sql`
        UPDATE proposals
        SET status = 'rejected', reviewed_by = ${SENTINEL_AGENT}, reviewed_at = NOW()
        WHERE id = ${proposal.id}`;
    }
  }

  const tenantSupersessions = await applyApprovedTenantSupersessionProposals();
  const registryReconciliations = await applyApprovedRegistryReconciliationProposals(sql, SENTINEL_AGENT);
  // Memory-Health PR 3: apply approved, HIGH-CONFIDENCE project-association proposals
  // (sets substance.project_addr + a part_of edge, audited + reversible). Only
  // confidence >= PROJECT_ASSOCIATION_MIN_APPLY_CONFIDENCE and human-reviewed apply.
  const projectAssociations = await applyApprovedProjectAssociationProposals(sql, { actor: SENTINEL_AGENT });
  // Memory-Health PR 4: dismiss detected conflicts whose other endpoint is retired/
  // gone, so the queue + recall conflict warnings stay focused on ACTIVE-ACTIVE pairs.
  const conflictsDismissed = await dismissRetiredEndpointConflicts(sql);
  const proposalRollbacks = await recordProposalRollbackEvents();

  return {
    tensions: tensionsPromoted,
    inferences: inferencesPromoted,
    tenantSupersessions,
    registryReconciliations,
    projectAssociations: projectAssociations.applied,
    projectAssociationsRejected: projectAssociations.rejected,
    conflictsDismissed,
    proposalRollbacks,
  };
}

async function postCommitMaintenance(): Promise<void> {
  console.log("  Running post-commit maintenance...");
  await sql`SELECT refresh_registry_counts()`;
  const { tensions, inferences, tenantSupersessions, registryReconciliations, projectAssociations, projectAssociationsRejected, conflictsDismissed, proposalRollbacks } = await promoteProposals();
  if (tensions > 0 || inferences > 0 || tenantSupersessions > 0 || registryReconciliations > 0 || projectAssociations > 0 || projectAssociationsRejected > 0 || conflictsDismissed > 0 || proposalRollbacks > 0) {
    console.log(
      `  Promoted: ${tensions} tensions, ${inferences} inferred edges, ` +
      `${tenantSupersessions} tenant supersessions, ${registryReconciliations} registry reconciliations, ` +
      `${projectAssociations} project associations (${projectAssociationsRejected} rejected), ` +
      `${conflictsDismissed} retired-endpoint conflicts dismissed; ` +
      `proposal rollback events: ${proposalRollbacks}`,
    );
  }
  // F11: refresh_resonance_if_stale() owns recompute. Calling apply_resonance()
  // immediately afterwards is redundant — the helper already delegates to it
  // when stale, and apply_resonance() now serializes via advisory lock so
  // double-call here would just queue and run twice. Drop the second call.
  await sql`SELECT refresh_resonance_if_stale()`;
  await sql`SELECT update_token_weights_from_resonance()`;
  approvedSinceMaintenance = 0;
}

async function bulkRejectNodeDebt(): Promise<string[]> {
  const actions: string[] = [];

  const nondurable = await sql`
    UPDATE staging_nodes
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: non-durable staging nodes belong in stimuli, not QC',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND COALESCE(source_context->>'vi_temporality', source_context->>'wi_temporality', source_context->>'temporality', 'DURABLE') != 'DURABLE'
    RETURNING id`;
  if (nondurable.length > 0) actions.push(`nondurable_nodes=${nondurable.length}`);

  const rawTrends = await sql`
    UPDATE staging_nodes
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: trend nodes require graduation_review=true',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND substance->>'node_type' = 'trend'
      AND COALESCE(source_context->'trend'->>'graduation_review', 'false') != 'true'
    RETURNING id`;
  if (rawTrends.length > 0) actions.push(`raw_trend_nodes=${rawTrends.length}`);

  return actions;
}

async function bulkRejectEdgeDebt(): Promise<string[]> {
  const actions: string[] = [];

  const selfLoops = await sql`
    UPDATE staging_edges
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: self-loop edges are invalid',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND from_addr = to_addr
    RETURNING id`;
  if (selfLoops.length > 0) actions.push(`self_loop_edges=${selfLoops.length}`);

  const duplicateProduction = await sql`
    UPDATE staging_edges AS e
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: edge already exists in production',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    FROM edges prod
    WHERE e.qc_status IN ('pending', 'revised')
      AND prod.from_addr = e.from_addr
      AND prod.to_addr = e.to_addr
      AND prod.edge_type = e.edge_type
    RETURNING e.id`;
  if (duplicateProduction.length > 0) actions.push(`duplicate_prod_edges=${duplicateProduction.length}`);

  const duplicateStaging = await sql`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY from_addr, to_addr, edge_type
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM staging_edges
      WHERE qc_status IN ('pending', 'revised')
    )
    UPDATE staging_edges AS e
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: duplicate staging edge superseded by oldest pending row',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    FROM ranked
    WHERE e.id = ranked.id
      AND ranked.rn > 1
    RETURNING e.id`;
  if (duplicateStaging.length > 0) actions.push(`duplicate_staging_edges=${duplicateStaging.length}`);

  const brokenEdges = await sql`
    UPDATE staging_edges AS e
    SET qc_status = 'rejected',
        qc_agent = ${SENTINEL_AGENT},
        qc_notes = 'Rejected during maintenance: edge endpoints are no longer resolvable',
        qc_timestamp = NOW(),
        claimed_at = NULL,
        claimed_by = NULL,
        retry_after = NULL
    WHERE e.qc_status IN ('pending', 'revised')
      AND (
        (
          NOT EXISTS (SELECT 1 FROM nodes n WHERE n.addr = e.from_addr)
          AND NOT EXISTS (
            SELECT 1
            FROM staging_nodes s
            WHERE s.addr = e.from_addr
              AND s.qc_status IN ('pending', 'revised')
          )
        )
        OR
        (
          NOT EXISTS (SELECT 1 FROM nodes n WHERE n.addr = e.to_addr)
          AND NOT EXISTS (
            SELECT 1
            FROM staging_nodes s
            WHERE s.addr = e.to_addr
              AND s.qc_status IN ('pending', 'revised')
          )
        )
      )
    RETURNING e.id`;
  if (brokenEdges.length > 0) actions.push(`broken_edges=${brokenEdges.length}`);

  return actions;
}

async function releaseStaleClaims(): Promise<string[]> {
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const actions: string[] = [];

  const staleNodeClaims = await sql`
    UPDATE staging_nodes
    SET claimed_at = NULL,
        claimed_by = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND claimed_at IS NOT NULL
      AND claimed_at < ${staleBefore}
    RETURNING id`;
  if (staleNodeClaims.length > 0) actions.push(`released_node_claims=${staleNodeClaims.length}`);

  const staleEdgeClaims = await sql`
    UPDATE staging_edges
    SET claimed_at = NULL,
        claimed_by = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND claimed_at IS NOT NULL
      AND claimed_at < ${staleBefore}
    RETURNING id`;
  if (staleEdgeClaims.length > 0) actions.push(`released_edge_claims=${staleEdgeClaims.length}`);

  const staleUpdateClaims = await sql`
    UPDATE staging_updates
    SET claimed_at = NULL,
        claimed_by = NULL
    WHERE qc_status IN ('pending', 'revised')
      AND claimed_at IS NOT NULL
      AND claimed_at < ${staleBefore}
    RETURNING id`;
  if (staleUpdateClaims.length > 0) actions.push(`released_update_claims=${staleUpdateClaims.length}`);

  return actions;
}

async function runDeterministicQueueCleanup(): Promise<void> {
  const actions = [
    ...(await releaseStaleClaims()),
    ...(await bulkRejectNodeDebt()),
    ...(await bulkRejectEdgeDebt()),
  ];

  if (actions.length > 0) {
    console.log(`  Queue cleanup: ${actions.join(" | ")}`);
  }
}

async function runAuditChecks(): Promise<void> {
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const [audit] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM staging_nodes WHERE qc_status IN ('pending', 'revised')) AS queued_nodes,
      (SELECT COUNT(*)::int FROM staging_edges WHERE qc_status IN ('pending', 'revised')) AS queued_edges,
      (SELECT COUNT(*)::int FROM staging_updates WHERE qc_status IN ('pending', 'revised')) AS queued_updates,
      (SELECT COUNT(*)::int FROM staging_nodes WHERE claimed_at IS NOT NULL AND claimed_at < ${staleBefore}) AS stale_node_claims,
      (SELECT COUNT(*)::int FROM staging_edges WHERE claimed_at IS NOT NULL AND claimed_at < ${staleBefore}) AS stale_edge_claims,
      (SELECT COUNT(*)::int FROM staging_updates WHERE claimed_at IS NOT NULL AND claimed_at < ${staleBefore}) AS stale_update_claims,
      (SELECT COUNT(*)::int FROM staging_nodes
         WHERE qc_status IN ('pending', 'revised')
           AND COALESCE(source_context->>'vi_temporality', source_context->>'wi_temporality', source_context->>'temporality', 'DURABLE') != 'DURABLE') AS nondurable_nodes,
      (SELECT COUNT(*)::int FROM staging_edges
         WHERE qc_status IN ('pending', 'revised')
           AND COALESCE(source_context->>'vi_temporality', source_context->>'wi_temporality', source_context->>'temporality', 'DURABLE') != 'DURABLE') AS nondurable_edges,
      (SELECT COUNT(*)::int FROM staging_nodes
         WHERE qc_status IN ('pending', 'revised')
           AND substance->>'node_type' = 'trend'
           AND COALESCE(source_context->'trend'->>'graduation_review', 'false') != 'true') AS raw_trend_nodes,
      (SELECT COUNT(*)::int FROM staging_edges e
         WHERE qc_status IN ('pending', 'revised')
           AND (
             (
               NOT EXISTS (SELECT 1 FROM nodes n WHERE n.addr = e.from_addr)
               AND NOT EXISTS (
                 SELECT 1 FROM staging_nodes s
                 WHERE s.addr = e.from_addr
                   AND s.qc_status IN ('pending', 'revised')
               )
             )
             OR (
               NOT EXISTS (SELECT 1 FROM nodes n WHERE n.addr = e.to_addr)
               AND NOT EXISTS (
                 SELECT 1 FROM staging_nodes s
                 WHERE s.addr = e.to_addr
                   AND s.qc_status IN ('pending', 'revised')
               )
             )
           )) AS broken_edges`;

  const alerts: string[] = [];
  const queueSummary = `queue n=${audit.queued_nodes} e=${audit.queued_edges} u=${audit.queued_updates}`;
  if (audit.stale_node_claims || audit.stale_edge_claims || audit.stale_update_claims) {
    alerts.push(`stale_claims n=${audit.stale_node_claims} e=${audit.stale_edge_claims} u=${audit.stale_update_claims}`);
  }
  if (audit.nondurable_nodes || audit.nondurable_edges) {
    alerts.push(`nondurable_staging n=${audit.nondurable_nodes} e=${audit.nondurable_edges}`);
  }
  if (audit.raw_trend_nodes) alerts.push(`raw_trend_nodes=${audit.raw_trend_nodes}`);
  if (audit.broken_edges) alerts.push(`broken_edges=${audit.broken_edges}`);

  if (alerts.length > 0) {
    console.warn(`  Audit warnings: ${queueSummary} | ${alerts.join(" | ")}`);
  } else if (audit.queued_nodes || audit.queued_edges || audit.queued_updates) {
    console.log(`  Audit: ${queueSummary}`);
  }
}

function validatePyramidRegistration(node: StagingNode): Promise<ShapeResult> {
  return (async () => {
    if (!VALID_NODE_PYRAMIDS.has(node.pyramid_id)) {
      return { valid: false, reason: `Unknown pyramid_id: ${node.pyramid_id}` };
    }
    const [registryRow] = await sql`SELECT pyramid_id FROM registry WHERE pyramid_id = ${node.pyramid_id}`;
    if (!registryRow) return { valid: false, reason: `Unregistered pyramid_id: ${node.pyramid_id}` };
    return { valid: true };
  })();
}

async function validateShapeWithDbChecks(staging: StagingItem): Promise<ShapeResult> {
  if (staging.type === "node") {
    const node = staging.item;
    const basicCheck = validateNodeShape(node);
    if (!basicCheck.valid) return basicCheck;

    const pyramidCheck = await validatePyramidRegistration(node);
    if (!pyramidCheck.valid) return pyramidCheck;

    const [existing] = await sql`SELECT addr FROM nodes WHERE addr = ${node.addr}`;
    if (existing) return { valid: false, reason: `Address collision: ${node.addr} already exists in production` };

    if (node.parent_addr) {
      const [parent] = await sql`
        SELECT addr, pyramid_id, depth
        FROM nodes
        WHERE addr = ${node.parent_addr}`;
      if (!parent) return { valid: false, reason: `Parent addr ${node.parent_addr} does not exist` };
      if (parent.pyramid_id !== node.pyramid_id) {
        return { valid: false, reason: `Parent pyramid mismatch: ${node.parent_addr} belongs to ${parent.pyramid_id}` };
      }
      if (parent.depth !== node.depth - 1) {
        return { valid: false, reason: `Parent depth mismatch: ${node.parent_addr} depth=${parent.depth}, expected ${node.depth - 1}` };
      }
    }

    return { valid: true };
  }

  if (staging.type === "edge") {
    const edge = staging.item;
    const basicCheck = validateEdgeShape(edge);
    if (!basicCheck.valid) return basicCheck;

    const [fromExists] = await sql`SELECT addr FROM nodes WHERE addr = ${edge.from_addr}`;
    const [toExists] = await sql`SELECT addr FROM nodes WHERE addr = ${edge.to_addr}`;
    if (!fromExists) return { valid: false, reason: `From endpoint missing: ${edge.from_addr}` };
    if (!toExists) return { valid: false, reason: `To endpoint missing: ${edge.to_addr}` };

    const [dup] = await sql`
      SELECT 1
      FROM edges
      WHERE from_addr = ${edge.from_addr}
        AND to_addr = ${edge.to_addr}
        AND edge_type = ${edge.edge_type}`;
    if (dup) return { valid: false, reason: `Duplicate edge: ${edge.from_addr} -> ${edge.to_addr} [${edge.edge_type}]` };

    return { valid: true };
  }

  const update = staging.item;
  const basicCheck = validateUpdateShape(update);
  if (!basicCheck.valid) return basicCheck;

  const [node] = await sql`
    SELECT addr, to_jsonb(nodes) as node_json
    FROM nodes
    WHERE addr = ${update.addr}`;
  if (!node) return { valid: false, reason: `Update target missing: ${update.addr}` };

  if (!VALID_UPDATE_FIELDS.has(update.field)) {
    return { valid: false, reason: `Unsupported update field: ${update.field}` };
  }

  const currentValue = node.node_json?.[update.field];
  let normalized: unknown;
  try {
    normalized = normalizeApprovedUpdateValue(update.field, update.new_value);
  } catch (error: any) {
    return { valid: false, reason: error.message };
  }

  if (comparableJson(currentValue) === comparableJson(normalized)) {
    return { valid: false, reason: `Update does not change ${update.field}` };
  }

  return { valid: true };
}

async function processOneFromClaim(staging: StagingItem, dryRun: boolean): Promise<boolean> {
  process.stdout.write(`  QC ${staging.type}: ${itemDescription(staging)} ... `);
  lastAttemptedAt = new Date().toISOString();
  lastItemType = staging.type;
  lastItemSummary = itemDescription(staging);

  try {
    // Normalize double-encoded substance before validation
    if (staging.type === "node" && typeof staging.item.substance === "string") {
      try {
        staging.item.substance = JSON.parse(staging.item.substance);
        await sql`UPDATE staging_nodes SET substance = ${sql.json(staging.item.substance)} WHERE id = ${staging.item.id}`;
      } catch { /* leave as-is, shape validation will reject */ }
    }

    const shape = await validateShapeWithDbChecks(staging);
    if (!shape.valid) {
      console.log(`shape-reject: ${shape.reason}`);
      if (dryRun) {
        await releaseClaim(staging);
      } else {
        await markStaging(tableForItem(staging), staging.item.id, "rejected", "shape-validator", shape.reason || "Invalid shape");
        rejectedCount++;
      }
      processedCount++;
      lastProcessedAt = new Date().toISOString();
      clearSentinelBlocked();
      await beatSentinel("running");
      return true;
    }

    const decision = await validateItem(staging);
    const statusLabel = decision.decision.toUpperCase();
    console.log(`${statusLabel}${decision.reason ? `: ${decision.reason.slice(0, 120)}` : ""}`);

    if (dryRun) {
      await releaseClaim(staging);
    } else {
      await applyDecision(staging, decision);
    }

    processedCount++;
    lastProcessedAt = new Date().toISOString();
    clearSentinelBlocked();
    await beatSentinel("running");
    return true;
  } catch (error: any) {
    const message = error?.message?.slice(0, 180) || "Unknown QC error";
    const retryAfterMs = retryDelayForQcError(error);
    console.log(`error: ${message}${retryAfterMs > 0 ? ` (retry in ${Math.round(retryAfterMs / 1000)}s)` : ""}`);
    await releaseClaim(staging, message, retryAfterMs);
    if (retryAfterMs > 0) {
      setSentinelBlocked(message, retryAfterMs);
      await beatSentinel("error");
      return false;
    }
    sentinelBlockingError = message;
    await beatSentinel("error");
    return true;
  }
}

export async function processOne(dryRun: boolean): Promise<boolean> {
  const blockedMs = blockRemainingMs();
  if (blockedMs > 0) {
    await beatSentinel("error");
    return false;
  }
  const staging = await claimNextPending();
  if (!staging) {
    await beatSentinel("idle");
    return false;
  }
  return processOneFromClaim(staging, dryRun);
}

async function drainQueue(dryRun: boolean, maxItems = Number.POSITIVE_INFINITY): Promise<number> {
  let processed = 0;
  while (processed < maxItems) {
    const hadWork = await processOne(dryRun);
    if (!hadWork) break;
    processed++;
    if (processed < maxItems && DRAIN_DELAY_MS > 0) await sleep(DRAIN_DELAY_MS);
  }
  return processed;
}

async function scheduleDrain(dryRun: boolean): Promise<void> {
  drainRequested = true;
  if (drainInFlight) return drainInFlight;

  drainInFlight = (async () => {
    try {
      do {
        drainRequested = false;
        await drainQueue(dryRun);
      } while (drainRequested);
    } finally {
      drainInFlight = null;
    }
  })();

  return drainInFlight;
}

function maybeHeartbeat(): void {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  const blockedMs = blockRemainingMs(now);
  void beatSentinel(blockedMs > 0 ? "error" : "running");
  const elapsedMinutes = Math.floor((now - startTime) / 60000);
  console.log(
    `  heartbeat ${elapsedMinutes}m | processed=${processedCount} approved=${approvedCount} rejected=${rejectedCount} revised=${revisedCount} maintenance=${maintenanceRuns}${blockedMs > 0 ? ` blocked_for=${Math.ceil(blockedMs / 1000)}s` : ""}`,
  );
}

async function runMaintenancePass(dryRun: boolean, force = false): Promise<void> {
  if (maintenanceInFlight) return;
  maintenanceInFlight = true;
  try {
    await autoRejectExhaustedRevisions();
    if (!dryRun) {
      await runDeterministicQueueCleanup();
    }
    await runAuditChecks();
    if (!dryRun && (force || approvedSinceMaintenance > 0)) {
      await postCommitMaintenance();
    }
    maintenanceRuns++;
  } catch (error: any) {
    console.error(`  maintenance error: ${error.message}`);
  } finally {
    maintenanceInFlight = false;
  }
}

export async function endConnections(): Promise<void> {
  await sql.end();
  await listenSql.end();
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const batchIndex = args.indexOf("--batch");
  const batchSize = batchIndex >= 0 ? parseInt(args[batchIndex + 1] || "0", 10) : 0;
  const dryRun = args.includes("--dry-run");
  const mode = once ? "once" : batchSize > 0 ? `batch(${batchSize})` : "persistent";

  console.log(`QC Sentinel starting (mode: ${mode}${dryRun ? ", dry-run" : ""})`);
  console.log(`  instance=${SENTINEL_INSTANCE} model=${getModelId("pro")} poll=${POLL_INTERVAL_MS}ms maintenance=${MAINTENANCE_INTERVAL_MS}ms`);

  try {
    if (once) {
      const hadWork = await processOne(dryRun);
      if (!hadWork) console.log("  No pending items.");
      await runMaintenancePass(dryRun, true);
      return;
    }

    if (batchSize > 0) {
      const processed = await drainQueue(dryRun, batchSize);
      if (processed === 0) console.log("  Queue empty.");
      await runMaintenancePass(dryRun, true);
      return;
    }

    console.log("  Draining existing queue...");
    sentinelHeartbeat = startWorkerHeartbeat({
      sql,
      workerName: "qc-sentinel",
      role: "qc_gatekeeper",
      mode: "persistent",
      heartbeatIntervalMs: Math.min(POLL_INTERVAL_MS, 15_000),
      staleAfterMs: Math.max(MAINTENANCE_INTERVAL_MS * 2, 60_000),
      metadata: heartbeatMetadata(),
    });
    await scheduleDrain(dryRun);
    await runMaintenancePass(dryRun, true);
    console.log("  Queue drained. Listening for new proposals...");
    console.log("  Ctrl+C to stop.\n");

    await listenSql.listen("staging_new", async () => {
      void scheduleDrain(dryRun);
    });

    const pollInterval = setInterval(() => {
      maybeHeartbeat();
      void scheduleDrain(dryRun);
    }, POLL_INTERVAL_MS);

    const maintenanceInterval = setInterval(() => {
      void runMaintenancePass(dryRun);
    }, MAINTENANCE_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

    clearInterval(pollInterval);
    clearInterval(maintenanceInterval);
    await runMaintenancePass(dryRun, true);
    if (sentinelHeartbeat) {
      await sentinelHeartbeat.stop({
        status: "stopped",
        metadata: heartbeatMetadata(),
      });
      sentinelHeartbeat = null;
    }
  } finally {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\nQC Sentinel done (${elapsed}s) | processed=${processedCount} approved=${approvedCount} rejected=${rejectedCount} revised=${revisedCount} maintenance=${maintenanceRuns}`,
    );
    await endConnections();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}
