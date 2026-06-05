/**
 * SuperCron — Unified Graph Maintenance Engine
 *
 * One script, one advisory lock, 14 rotating passes, deterministic core with optional LLM.
 * Absorbs logic from: dialectic-scanner, synthesizer, distiller, distiller-phase1,
 * lifecycle, archetype-miner, reactor (analytics/supersession).
 *
 * Tiers:
 *   T1 (deterministic, pure SQL)  — Heat, Tensions, Memory Lifecycle (+tenant), Node Health, Edge Integrity
 *   T2 (bounded, SQL + vector)    — Truth Refresh, Distiller Simple, Supersession, Source Analytics
 *   T3 (LLM-optional)             — Synthesis, Archetypes, Essence, Fusion
 *   T4 (reporting)                — Digest + State
 *
 * Usage:
 *   bun run miners/src/supercron.ts                         # full run
 *   bun run miners/src/supercron.ts --dry-run               # all passes, no writes
 *   bun run miners/src/supercron.ts --tier 1                # tier isolation
 *   bun run miners/src/supercron.ts --tier 1,2              # multiple tiers
 *   bun run miners/src/supercron.ts --pyramid FUNCTION      # override rotation
 *   bun run miners/src/supercron.ts --watch                 # loop forever
 *   bun run miners/src/supercron.ts --stats                 # read-only stats
 *   bun run miners/src/supercron.ts --inspect-receipt 12345 # inspect node-GC receipt
 *   bun run miners/src/supercron.ts --only trend_maintenance --once
 *   bun run miners/src/supercron.ts --only node_gc_candidates --once
 *   bun run miners/src/supercron.ts --only node_gc_apply --once
 *   bun run miners/src/supercron.ts --only project_association_doctor --once
 *   bun run miners/src/supercron.ts --help
 */

import { randomUUID } from "node:crypto";
import { createDirectSql } from "@verity-one/db-pool";
import {
  CORE_PYRAMID_IDS,
  MINING_ROTATION,
  MINING_CROSS_MODE,
  TRUTH_PYRAMIDS,
  ANSWER_CAPABLE_PYRAMIDS,
  TREND_WIRING_TARGET_PYRAMIDS,
} from "@verity-one/graph-shape";

// Materialize the canonical sets as plain string[] for postgres.js
// `= ANY(${...}::text[])` and `<> ALL(${...}::text[])` array binding.
const TRUTH_PYRAMID_LIST: string[] = [...TRUTH_PYRAMIDS];
const ANSWER_PYRAMID_LIST: string[] = [...ANSWER_CAPABLE_PYRAMIDS];
const TREND_WIRING_TARGET_LIST: string[] = [...TREND_WIRING_TARGET_PYRAMIDS];
const CORE_PYRAMID_ID_SET = new Set<string>(CORE_PYRAMID_IDS);
import { startWorkerHeartbeat, type WorkerHeartbeatHandle } from "./lib/worker-heartbeat";
import { callFlashLiteWithModel, callLLMWithModel, getGoogleApiKey, type LLMResult } from "./lib/llm";
import { auditMutationFromWorker } from "../../api/src/lib/audit";
import {
  EMBED_MODEL,
  embedQuery,
  toVectorStr,
  embedTextForInsert,
  embedTextForInsertFromCache,
  embeddingTextForNode,
  embeddingMetadataForVectorWrite,
} from "@verity-one/embed";
import {
  deleteEdgesByIds,
  rewriteEdgeTypeByIds,
  upsertEdge,
  writeEdge,
} from "../../api/src/lib/edge-mutations";
import {
  formatSupercronUsage,
  parseSupercronCli,
  type SupercronCliOptions,
} from "./supercron-cli";
import {
  collectMemoryHealthSnapshot,
  computeMemoryHealthDeltas,
  evaluateQualityReport,
  type MemoryHealthSnapshot,
  type QualityReport,
} from "./supercron-health";
import { countActiveRegistryDormantNodes } from "./supercron-lifecycle-drift";
import { sweepTenantMemoryGarbage } from "./supercron-memory-garbage";
import {
  cascadeDeleteNode,
  evaluateNodeGcApplyPredicate,
  observedText,
  type NodeGcCascadeDeleteCount,
  type NodeGcApplyPredicateRow,
} from "./supercron-node-gc-delete";
import {
  runDistillerPass,
  SEMANTIC_AUDIT_PACKET_TYPES,
  type DistillerRunResult,
} from "./distiller-phase1";
import {
  AUTOMATED_DORMANCY_PROTECTED_KIND_LIST,
  AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST,
  getActiveConflicts,
} from "../../api/src/lib/memory-lifecycle";
import { isRoutineSuppressed } from "../../api/src/lib/routine-suppression";
import { compileRecall } from "../../api/src/lib/recall-compiler";
// LW4: persist #65 review packets into the review_proposals ledger (proposal-only).
import { lifecycleAtomicityReport } from "../../api/src/lib/lifecycle-atomicity";
import { listReviewableMemories } from "../../api/src/lib/memory-audit";
import { selectReviewQueue } from "../../api/src/lib/review-queue";
import { persistReviewQueue } from "../../api/src/lib/review-proposal-persist";
import { readTenantPolicyProfile } from "../../api/src/lib/tenant-settings";
import { resolvePolicyProfile } from "../../api/src/lib/policy-profile";
import {
  readTenantCadence,
  shouldRunPass,
  shouldRunTier3,
} from "./supercron-budget";
import {
  BudgetSpendRejectedError,
  BudgetStateCache,
  LLM_ESTIMATE_DISTILLER_FUSION_PASS_MICRO,
  LLM_ESTIMATE_FLASH_LITE_MICRO,
  LLM_ESTIMATE_FLASH_MICRO,
  LLM_ESTIMATE_GOLDEN_CASE_MICRO,
  LLM_MODEL_COST_MICRO_PER_TOKEN,
  MANUAL_RUN_DAILY_CAP_MICRO,
  MANUAL_RUN_REQUEST_CAP_MICRO,
  ManualRunAlreadyOpenError,
  createManualRunRecord,
  estimateEmbeddingCostMicro,
  recordEmbeddingSpendIfBilled,
  shouldRecordEmbeddingFailureSpend,
  type TenantBudgetState,
} from "./supercron-budget-policy";
import {
  filterPyramidsByFocus,
  getResolvedTenantPolicy,
  type ResolvedTenantPolicy,
} from "./supercron-policy";
import {
  ARCHETYPE_DEDUP_EMBEDDING_TASK_TYPE,
  ARCHETYPE_DEDUP_PURPOSE,
  PROPOSAL_EMBEDDING_BACKFILL_LOCK_ID,
  PROPOSAL_EMBEDDING_BACKFILL_LOCK_NAMESPACE,
  archetypeCanonicalText,
  archetypeSourcePayloadHash,
  archetypeStablePayload,
  modelAwareArchetypeBackfillMarkerKey,
  pyramidJaccard,
  sha256Hex,
  shouldInvalidateArchetypeBackfillMarkerAfterFallback,
  type ArchetypeBackfillMarkerInvalidationMode,
} from "./archetype-dedup";
import { loadArchetypeDedupCalibration } from "./archetype-dedup-calibration";

// ============================================================
// Types
// ============================================================

export interface PassResult {
  name: string;
  actions: number;
  skipped: boolean;
  ms: number;
  llm_tokens_in?: number | null;
  llm_tokens_out?: number | null;
  llm_cost_usd_micro?: number | null;
  proposals_created?: number | null;
  proposals_applied?: number | null;
  details: Record<string, unknown>;
  goldenQueryRuns?: GoldenQueryRunRecord[];
}

export interface SupercronConfig {
  dryRun: boolean;
  tiers: number[];
  pyramidFocus: string;
  cycleNumber: number;
  onlyPass: string | null;
  force: boolean;
  cycleTenantId: string;
  policy: Readonly<ResolvedTenantPolicy>;
  budgetCache: BudgetStateCache;
  budgetStateAtCycleStart: TenantBudgetState;
  manualRun: { id: number; budgetMicro: number } | null;
  pyramidOverrideViolatesPolicy: boolean;
  cooldownOverrides: string[];
  controllerErrors: PassResult[];
}

interface TimeBudget {
  elapsed: () => number;
  remaining: () => number;
  tierBudget: (tier: number) => number;
  exceeded: () => boolean;
  shouldSkipTier: (tier: number) => boolean;
  tierStart: (tier: number) => void;
  tierElapsed: (tier: number) => number;
}

interface CycleExecution {
  results: PassResult[];
  tierMs: Record<number, number>;
  qualityReport: QualityReport;
  status: "completed" | "degraded";
  degradedReason: string | null;
  startedAt: Date;
  skipRunInsert?: boolean;
  skipRunInsertReason?: "outside_active_hours" | "dry_run";
}

interface PassInvocation {
  name: string;
  run: () => Promise<PassResult>;
}

interface ForceRunRequest {
  tenantId: string;
  requestedAt: string;
  payload: Record<string, unknown>;
}

type ManualRunStatus = "running" | "completed" | "failed" | "rejected";
type NodeGcApplyAction = "tombstone" | "delete";

class ForceRunTenantMismatchError extends Error {
  constructor(public readonly requestedTenant: string, public readonly instanceOwner: string) {
    super(`force_run_tenant_mismatch:${requestedTenant}:instance_owner:${instanceOwner}`);
    this.name = "ForceRunTenantMismatchError";
  }
}

function isNodeGcApplyAction(value: unknown): value is NodeGcApplyAction {
  return value === "tombstone" || value === "delete";
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function resolveNodeGcReceiptApplyAction(
  eligibility: unknown,
  fallbackAction: NodeGcApplyAction,
): NodeGcApplyAction {
  const rawIntendedApplyAction = readJsonObject(eligibility).intended_apply_action;
  const intended_apply_action = isNodeGcApplyAction(rawIntendedApplyAction) ? rawIntendedApplyAction : null;
  return intended_apply_action ?? fallbackAction;
}

function nodeGcApplyPredicateOptions(nodeGc: ResolvedTenantPolicy["nodeGc"]) {
  return {
    now: new Date(),
    dormantDays: nodeGc.dormantDays,
    lastQueriedGraceDays: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
    safeLifecycleStates: GC_SAFE_LIFECYCLE_STATES,
    protectedMaturityStages: AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST,
    protectedKinds: AUTOMATED_DORMANCY_PROTECTED_KIND_LIST,
  };
}

async function readNodeGcApplyPredicateRow(
  tx: any,
  tenantId: string,
  tenantSpaceId: string,
  addr: string,
  options: { lockForApply?: boolean } = {},
): Promise<NodeGcApplyPredicateRow | null> {
  const lockForApply = options.lockForApply ?? true;
  const nodeLockClause = lockForApply ? tx`FOR UPDATE OF n` : tx``;
  const registryLockClause = lockForApply ? tx`FOR UPDATE` : tx``;
  const [nodeRow] = await tx`
    SELECT
      n.dormant_at,
      n.query_hits,
      n.last_queried,
      n.node_type,
      n.visibility,
      COALESCE(n.pinned, false) AS pinned,
      COALESCE(n.substance->>'maturity_stage', '') AS maturity_stage,
      (
        SELECT count(*)::int
        FROM edges e
        WHERE e.from_addr = n.addr OR e.to_addr = n.addr
      ) AS edge_count
    FROM nodes n
    WHERE n.addr = ${addr}
      AND n.space_id = ${tenantSpaceId}
    LIMIT 1
    ${nodeLockClause}
  `;
  if (!nodeRow) return null;

  const [registryRow] = await tx`
    SELECT
      mr.kind AS registry_kind,
      mr.status AS registry_status,
      COALESCE(mr.accepted_by_user, false) AS accepted_by_user,
      COALESCE(mr.source_kind, '') AS source_kind
    FROM memory_registry mr
    WHERE mr.addr = ${addr}
      AND mr.tenant_id = ${tenantId}
    LIMIT 1
    ${registryLockClause}
  `;
  return {
    ...nodeRow,
    registry_kind: registryRow?.registry_kind ?? null,
    registry_status: registryRow?.registry_status ?? null,
    accepted_by_user: registryRow?.accepted_by_user ?? false,
    source_kind: registryRow?.source_kind ?? "",
  } as NodeGcApplyPredicateRow;
}

// ============================================================
// Constants
// ============================================================

const LOCK_ID = 44;
const TOTAL_BUDGET_MS = 60_000;
const DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP = 0.89;
const DISTILLER_SIMPLE_PROMOTION_BOOST = 0.05;
const DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS = 3;
const DISTILLER_SIMPLE_TRUST_THRESHOLD = 0.80;
const DISTILLER_SIMPLE_STALE_QUERY_HIT_DAYS = 90;
const RECALL_OUTCOME_PROMOTION_LOOKBACK_DAYS = 30;
const DISTILLER_FUSION_NODE_SCAN_LIMIT = 20;
const DISTILLER_FUSION_EDGE_SCAN_LIMIT = 40;
const DISTILLER_FUSION_CURATOR_BUDGET = 4;
const DISTILLER_FUSION_JUDGMENT_BUDGET = 1;
const DISTILLER_FUSION_QUEUE_CAP = 50;
const GOLDEN_QUERY_CASE_LIMIT = 50;
const GOLDEN_QUERY_CASE_MIN_BUDGET_MS = 500;
const GOLDEN_QUERY_RECALL_TIMEOUT_MS = 2_000;
const EDGE_USEFULNESS_SCORING_INTERVAL_HOURS = 24;
const EDGE_USEFULNESS_SCORING_BATCH_LIMIT = 5_000;
const EDGE_USEFULNESS_DEFAULT_WINDOW_DAYS = 90;
const EDGE_USEFULNESS_MIN_WINDOW_DAYS = 1;
const EDGE_USEFULNESS_MAX_WINDOW_DAYS = 365;
const EDGE_USEFULNESS_DEFAULT_PROTECTION_FLOOR = 0.7;
const EDGE_USEFULNESS_DEFAULT_FLAG_CEILING = 0.2;
const EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE = 200;
const EDGE_USEFULNESS_MAX_PROPOSALS_PER_CYCLE = 5_000;
// MINING_ROTATION is canonical in @verity-one/graph-shape. CROSS is a
// scheduler mode (MINING_CROSS_MODE), NOT a registry pyramid id.
const ROTATION = MINING_ROTATION;

export function buildDistillerFusionPassOptions(shouldContinue: () => boolean) {
  return {
    dryRun: false,
    mode: "once" as const,
    workerInstance: "supercron-distiller-fusion",
    nodeScanLimit: DISTILLER_FUSION_NODE_SCAN_LIMIT,
    edgeScanLimit: DISTILLER_FUSION_EDGE_SCAN_LIMIT,
    curatorBudget: DISTILLER_FUSION_CURATOR_BUDGET,
    fusionBudget: DISTILLER_FUSION_JUDGMENT_BUDGET,
    requireFusionJudgmentForHandoff: true,
    applyDeterministicEdgeCleanup: false,
    shouldContinue,
    metadata: {
      caller: "supercron-pass12",
      semantic_audit_packets: true,
    },
  };
}

export function formatDistillerFusionPassResult(result: Pick<
  DistillerRunResult,
  | "workItemsDetected"
  | "clustersBuilt"
  | "proposalsEmitted"
  | "fusionJudgments"
  | "fusionDeferred"
  | "fusionBlocked"
  | "handoffsSubmitted"
  | "proposalsResolved"
  | "proposalsByPacketType"
>): {
  actions: number;
  details: Record<string, unknown>;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_cost_usd_micro: number | null;
  proposals_created: number;
  proposals_applied: number;
} {
  return {
    actions: result.fusionJudgments,
    llm_tokens_in: null,
    llm_tokens_out: null,
    llm_cost_usd_micro: null,
    proposals_created: result.proposalsEmitted,
    proposals_applied: result.proposalsResolved,
    details: {
      semantic_audit_packet_types: SEMANTIC_AUDIT_PACKET_TYPES,
      node_scan_limit: DISTILLER_FUSION_NODE_SCAN_LIMIT,
      edge_scan_limit: DISTILLER_FUSION_EDGE_SCAN_LIMIT,
      curator_budget: DISTILLER_FUSION_CURATOR_BUDGET,
      fusion_budget: DISTILLER_FUSION_JUDGMENT_BUDGET,
      work_items_detected: result.workItemsDetected,
      clusters_built: result.clustersBuilt,
      proposals_emitted: result.proposalsEmitted,
      fusion_judgments: result.fusionJudgments,
      fusion_deferred: result.fusionDeferred,
      fusion_blocked: result.fusionBlocked,
      handoffs_submitted: result.handoffsSubmitted,
      proposals_resolved: result.proposalsResolved,
      backlog_resolved: result.proposalsResolved,
      proposals_by_packet_type: result.proposalsByPacketType,
      lifecycle_actions: result.proposalsEmitted + result.handoffsSubmitted + result.proposalsResolved,
    },
  };
}
const WATCH_INTERVAL_MS = 240_000; // 4 minutes
const FORCE_RUN_GRAPH_STATE_PREFIX = "supercron.force_run";
const FORCE_RUN_GRAPH_STATE_REQUESTED_AT_SUFFIX = "requested_at";
const FORCE_RUN_GRAPH_STATE_TENANT_SUFFIX = "tenant_id";
const FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX = "payload";
const FORCE_RUN_GRAPH_STATE_REQUESTED_AT_RE =
  /^supercron\.force_run\.([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.requested_at$/;
const FORCE_RUN_REQUEST_MAX_AGE_MS = 5 * 60_000;
const FORCE_RUN_SLEEP_POLL_MS = 15_000;
// Intentionally module-level, not tenant-tunable in this candidate rung:
// receipts snapshot the value used at mark time for future apply checks.
export const SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS = 60;
const SUPERCRON_NODE_GC_PREDICATE_VERSION = 2;
// Canonical terminal memory-registry lifecycle states. `expired` is included
// because api/src/lib/memory-expiry.ts transitions registry rows to it.
export const GC_SAFE_LIFECYCLE_STATES = ["superseded", "retracted", "archived", "expired"] as const;
// Pinned to docs/foundation/archetype-dedup-calibration.json. Semantic
// archetype dedup still requires the strict calibration loader to accept the
// artifact before these thresholds are used.
export const ARCHETYPE_DEDUP_COSINE_THRESHOLD = 0.963;
export const ARCHETYPE_DEDUP_PYRAMID_JACCARD_MIN = 0.67;
const ARCHETYPE_DEDUP_THRESHOLD_EPSILON = 1e-9;
const ARCHETYPE_DEDUP_SUPPRESSION_STATUSES = ["pending", "approved"] as const;

function nodeGcEligibilityTelemetry(): Record<string, unknown> {
  return {
    predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
    eligibility_predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
    eligibility_lifecycle_states: GC_SAFE_LIFECYCLE_STATES,
  };
}

export interface DistillerSimplePromotionResult {
  changed: number;
  details: Record<string, unknown>;
}

export type DirectSql = ReturnType<typeof createDirectSql>;
type SqlExecutor = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export interface GoldenQueryRunRecord {
  case_id: number;
  expectation_revision: number;
  precision_at_k: number | null;
  recall_at_k: number | null;
  mrr: number | null;
  forbidden_leaks: number;
  status: "pass" | "fail" | "error" | "skipped";
  error_reason: string | null;
}

interface GoldenQueryCase {
  id: number;
  slug: string;
  tenant_id: string;
  space_id: string;
  agent_id: string | null;
  query: string;
  k: number;
  revision: number;
  expectation_revision: number;
  expectations: GoldenQueryExpectation[];
}

interface GoldenQueryCaseFetch {
  cases: GoldenQueryCase[];
  total: number;
}

interface GoldenQueryExpectation {
  expectation_type: "expected" | "forbidden";
  addr: string;
  match_mode: "exact" | "supersession_descendant";
  expectation_rank: number;
}

let sqlClient: DirectSql | null = null;

function getSql(): DirectSql {
  if (!sqlClient) sqlClient = createDirectSql();
  return sqlClient;
}

async function closeSql(): Promise<void> {
  if (!sqlClient) return;
  const client = sqlClient;
  sqlClient = null;
  await client.end();
}

const sql = new Proxy(function sqlProxy() {}, {
  apply(_target, _thisArg, argArray) {
    return (getSql() as any)(...argArray);
  },
  get(_target, prop) {
    const client = getSql() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as DirectSql;

// ============================================================
// Shutdown handling
// ============================================================

let shouldStop = false;
let heartbeat: WorkerHeartbeatHandle | null = null;

function registerShutdown(): void {
  const handler = () => {
    if (shouldStop) process.exit(1);
    shouldStop = true;
    console.log("\n[SUPERCRON] Shutdown requested, finishing current pass...");
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

// ============================================================
// Time Budget
// ============================================================

function createTimeBudget(totalMs: number): TimeBudget {
  const start = Date.now();
  const tierStarts: Record<number, number> = {};
  // T1=10s, T2=15s, T3=remaining-5s, T4=5s
  const budgets: Record<number, number> = { 1: 10_000, 2: 15_000, 3: totalMs - 30_000, 4: 5_000 };

  return {
    elapsed: () => Date.now() - start,
    remaining: () => Math.max(0, totalMs - (Date.now() - start)),
    tierBudget: (tier) => budgets[tier] ?? 5_000,
    exceeded: () => Date.now() - start >= totalMs,
    shouldSkipTier: (tier) => {
      if (tier <= 2) return false;
      return Date.now() - start >= totalMs - budgets[4];
    },
    tierStart: (tier) => { tierStarts[tier] = Date.now(); },
    tierElapsed: (tier) => tierStarts[tier] ? Date.now() - tierStarts[tier] : 0,
  };
}

// ============================================================
// Config Loading
// ============================================================

export function buildSupercronConfig(
  cli: SupercronCliOptions,
  currentCycleNumber: number,
  lastPyramid: string,
  policy: Readonly<ResolvedTenantPolicy>,
  budgetCache: BudgetStateCache,
  manualRun: { id: number; budgetMicro: number } | null = null,
): SupercronConfig {
  const cycleNumber = cli.onlyPass ? currentCycleNumber : currentCycleNumber + 1;
  if (policy.tierList.length === 0) {
    console.warn(
      `[SUPERCRON] Tenant policy for ${policy.tenantId} resolved no runnable tiers; cycle will run reporting only.`,
    );
  }
  let pyramidOverrideViolatesPolicy = false;
  let pyramidFocus: string;
  if (cli.pyramidOverride) {
    const override = cli.pyramidOverride.toUpperCase();
    if (override !== MINING_CROSS_MODE && !CORE_PYRAMID_ID_SET.has(override)) {
      throw new Error(`invalid_pyramid_override:${cli.pyramidOverride}`);
    }
    pyramidFocus = override;
    pyramidOverrideViolatesPolicy =
      override !== MINING_CROSS_MODE
      && policy.pyramidFocus.length > 0
      && !policy.pyramidFocus.includes(override);
    if (pyramidOverrideViolatesPolicy) {
      console.warn(
        `[SUPERCRON] Operator pyramid override ${override} is outside tenant focus [${policy.pyramidFocus.join(",")}].`,
      );
    }
  } else {
    const focusedRotation = filterPyramidsByFocus(ROTATION, policy.pyramidFocus);
    const rotation = focusedRotation.length > 0 ? focusedRotation : [...ROTATION];
    const lastIdx = rotation.indexOf(lastPyramid);
    const nextIdx = lastIdx < 0 ? 0 : (lastIdx + 1) % rotation.length;
    pyramidFocus = rotation[nextIdx];
    if (lastPyramid && lastIdx < 0) {
      console.warn(
        `[SUPERCRON] Last pyramid ${lastPyramid} is not in current tenant focus; restarting rotation at ${pyramidFocus}.`,
      );
    }
  }

  return {
    dryRun: cli.dryRun,
    tiers: [...new Set([...policy.tierList, 4])],
    pyramidFocus,
    cycleNumber,
    onlyPass: cli.onlyPass,
    force: cli.force || Boolean(manualRun),
    cycleTenantId: policy.tenantId,
    policy,
    budgetCache,
    budgetStateAtCycleStart: budgetCache.currentState(),
    manualRun,
    pyramidOverrideViolatesPolicy,
    cooldownOverrides: [],
    controllerErrors: [],
  };
}

let cachedInstanceTenantId: string | null = null;

async function assertActiveTenantGraphSpace(tenantId: string): Promise<void> {
  const [space] = await sql`
    SELECT 1
    FROM tenants t
    JOIN graph_spaces gs
      ON gs.space_id = 'tenant:' || t.tenant_id
      AND gs.tenant_id = t.tenant_id
      AND gs.kind = 'tenant'
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'active'
    LIMIT 1
  `;
  if (!space) throw new Error(`tenant_space_missing:${tenantId}`);
}

async function resolveInstanceTenantId(): Promise<string> {
  if (cachedInstanceTenantId) {
    await assertActiveTenantGraphSpace(cachedInstanceTenantId);
    return cachedInstanceTenantId;
  }
  const envTenantId = (process.env.VERITY_INSTANCE_TENANT_ID || "").trim();
  if (envTenantId) {
    await assertActiveTenantGraphSpace(envTenantId);
    cachedInstanceTenantId = envTenantId;
    return cachedInstanceTenantId;
  }

  const tenants = await sql`
    SELECT t.tenant_id
    FROM tenants t
    JOIN graph_spaces gs
      ON gs.space_id = 'tenant:' || t.tenant_id
      AND gs.tenant_id = t.tenant_id
      AND gs.kind = 'tenant'
    WHERE t.status = 'active'
    ORDER BY t.created_at ASC, t.tenant_id ASC
    LIMIT 2
  `;
  if (tenants.length > 1) {
    throw new Error("instance_tenant_required_multiple_active_tenants");
  }
  if (!tenants[0]?.tenant_id) throw new Error("tenant_space_missing:no_active_instance_tenant");
  cachedInstanceTenantId = String(tenants[0].tenant_id);
  return cachedInstanceTenantId;
}

function manualBudgetMicroFromPayload(payload: Record<string, unknown>): number {
  const value = payload.llm_budget_usd;
  if (value == null || value === "") return MANUAL_RUN_REQUEST_CAP_MICRO;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.max(0, Math.min(MANUAL_RUN_REQUEST_CAP_MICRO, Math.round(parsed * 1_000_000)));
}

async function loadConfig(cli: SupercronCliOptions, forceRunRequest: ForceRunRequest | null = null): Promise<SupercronConfig> {
  const [cycleRow] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_cycle_number'`;
  const [lastPyramidRow] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_last_pyramid'`;

  const currentCycleNumber = parseInt(cycleRow?.value || "0");
  const lastPyramid = lastPyramidRow?.value || "PROJECTS";
  const cycleTenantId = await resolveInstanceTenantId();
  if (forceRunRequest && forceRunRequest.tenantId !== cycleTenantId) {
    throw new ForceRunTenantMismatchError(forceRunRequest.tenantId, cycleTenantId);
  }
  await reconcileOpenManualRuns(cycleTenantId);
  const now = new Date();
  const policy = await getResolvedTenantPolicy(sql, cycleTenantId, { now, operatorTiers: cli.tiers });
  if (cli.tiers.length > 0 && policy.tierList.length === 0) {
    console.warn(`[SUPERCRON] Operator tier filter [${cli.tiers.join(",")}] has no overlap with tenant intensity "${policy.intensity}"`);
  }
  const budgetCache = await BudgetStateCache.load(sql, cycleTenantId, now);
  const manualRun = forceRunRequest
    ? await createManualRunRecord(sql, {
      tenantId: cycleTenantId,
      requestedBy: String(forceRunRequest.payload.requested_by || "operator"),
      budgetMicro: manualBudgetMicroFromPayload(forceRunRequest.payload),
      requestedAt: new Date(forceRunRequest.requestedAt),
    }).then((row) => ({ id: row.id, budgetMicro: row.budgetMicro }))
    : null;
  return buildSupercronConfig(cli, currentCycleNumber, lastPyramid, policy, budgetCache, manualRun);
}

// ============================================================
// Pass helpers
// ============================================================

function skip(reason: string): PassResult {
  return { name: "", actions: 0, skipped: true, ms: 0, details: { reason } };
}

function skipPass(name: string, reason: string): PassResult {
  return { ...skip(reason), name };
}

function controllerErrorPassResult(failedCheck: string, targetPass: string, error: unknown): PassResult {
  return {
    name: "controller_error",
    actions: 0,
    skipped: true,
    ms: 0,
    details: {
      reason: "controller_error",
      error: "controller_error",
      failed_check: failedCheck,
      target_pass: targetPass,
      error_message: String((error as any)?.message || error).slice(0, 500),
    },
  };
}

function recordControllerError(config: SupercronConfig, failedCheck: string, targetPass: string, error: unknown): void {
  config.controllerErrors.push(controllerErrorPassResult(failedCheck, targetPass, error));
}

function drainControllerErrors(config: SupercronConfig, results: PassResult[]): void {
  if (config.controllerErrors.length === 0) return;
  results.push(...config.controllerErrors);
  config.controllerErrors = [];
}

async function runControlledPass(config: SupercronConfig, pass: PassInvocation): Promise<PassResult> {
  try {
    const allowed = await shouldRunPass(sql, pass.name, config.policy.thresholds.cooldown_ratio_min);
    if (!allowed) {
      if (config.force) {
        config.cooldownOverrides.push(`cooldown_triggered:${pass.name}`);
      } else {
        return skipPass(pass.name, "cooldown_triggered");
      }
    }
  } catch (error: any) {
    recordControllerError(config, "shouldRunPass", pass.name, error);
    console.warn(`[supercron-controller] shouldRunPass failed for ${pass.name}; running pass: ${String(error?.message || error).slice(0, 500)}`);
  }
  // OA6: operator routine suppression — skip a pass an operator has transiently muted. FAIL-OPEN:
  // a suppression-check failure must never halt the cron, so on error we log and run the pass.
  try {
    if (await isRoutineSuppressed(sql, { routineName: pass.name, tenantId: config.cycleTenantId })) {
      return skipPass(pass.name, "operator_suppressed");
    }
  } catch (error: any) {
    recordControllerError(config, "isRoutineSuppressed", pass.name, error);
    console.warn(`[supercron-controller] isRoutineSuppressed failed for ${pass.name}; running pass: ${String(error?.message || error).slice(0, 500)}`);
  }
  return pass.run();
}

async function shouldRunTier3Controlled(config: SupercronConfig): Promise<boolean> {
  try {
    const allowed = await shouldRunTier3(sql, config.policy.thresholds.golden_pass_rate_min);
    if (!allowed && config.force) {
      config.cooldownOverrides.push("tier3_controller_skip");
      return true;
    }
    return allowed;
  } catch (error: any) {
    recordControllerError(config, "shouldRunTier3", "tier3", error);
    console.warn(`[supercron-controller] shouldRunTier3 failed; running Tier 3: ${String(error?.message || error).slice(0, 500)}`);
    return true;
  }
}

async function runPass(
  name: string,
  fn: () => Promise<{
    actions: number;
    skipped?: boolean;
    details: Record<string, unknown>;
    goldenQueryRuns?: GoldenQueryRunRecord[];
    llm_tokens_in?: number | null;
    llm_tokens_out?: number | null;
    llm_cost_usd_micro?: number | null;
    proposals_created?: number | null;
    proposals_applied?: number | null;
  }>,
): Promise<PassResult> {
  const t0 = Date.now();
  try {
    const {
      actions,
      skipped,
      details,
      goldenQueryRuns,
      llm_tokens_in,
      llm_tokens_out,
      llm_cost_usd_micro,
      proposals_created,
      proposals_applied,
    } = await fn();
    return {
      name,
      actions,
      skipped: Boolean(skipped),
      ms: Date.now() - t0,
      details,
      goldenQueryRuns,
      llm_tokens_in,
      llm_tokens_out,
      llm_cost_usd_micro,
      proposals_created,
      proposals_applied,
    };
  } catch (err: any) {
    const msg = err?.name === "ModelCooldownError" ? "model_cooldown" : err?.message?.slice(0, 120) || "unknown";
    console.error(`  [${name}] Error: ${msg}`);
    return { name, actions: 0, skipped: true, ms: Date.now() - t0, details: { error: msg } };
  }
}

function llmBudgetOptions(config: SupercronConfig): {
  manualRunBudgetMicro?: number;
  manualRunId?: number;
} {
  return config.manualRun
    ? { manualRunBudgetMicro: config.manualRun.budgetMicro, manualRunId: config.manualRun.id }
    : {};
}

function rejectIfLlmBudgetExceeded(config: SupercronConfig, estimatedMicro: number): PassResult | null {
  const check = config.budgetCache.evaluateBudgetCheck(estimatedMicro, llmBudgetOptions(config));
  return check.allowed ? null : skipPass("budget", check.reason);
}

async function forceRecordBudgetAccounting(config: SupercronConfig, actualMicro: number): Promise<void> {
  const micro = Math.max(0, Math.trunc(Number(actualMicro)));
  if (micro === 0) return;
  if (config.manualRun) {
    const [row] = await sql`
      WITH selected AS (
        SELECT
          smr.id,
          smr.budget_micro,
          COALESCE(smr.actual_spend_micro, 0)::bigint AS prior_actual_spend_micro,
          b.tenant_id,
          b.manual_spend_today_micro::bigint AS prior_manual_spend_today_micro
        FROM supercron_manual_runs smr
        JOIN supercron_tenant_budget_state b
          ON b.tenant_id = smr.tenant_id
        WHERE smr.id = ${config.manualRun.id}
          AND smr.tenant_id = ${config.cycleTenantId}
        FOR UPDATE OF smr, b
      ),
      updated_run AS (
        UPDATE supercron_manual_runs smr
        SET actual_spend_micro = LEAST(s.budget_micro, s.prior_actual_spend_micro + ${micro})
        FROM selected s
        WHERE smr.id = s.id
        RETURNING
          smr.actual_spend_micro,
          s.budget_micro,
          s.prior_actual_spend_micro + ${micro} > s.budget_micro AS run_budget_was_capped
      ),
      updated_budget AS (
        UPDATE supercron_tenant_budget_state b
        SET manual_spend_today_micro = LEAST(${MANUAL_RUN_DAILY_CAP_MICRO}, s.prior_manual_spend_today_micro + ${micro}),
            updated_at = now()
        FROM selected s
        WHERE b.tenant_id = s.tenant_id
        RETURNING
          b.manual_spend_today_micro,
          s.prior_manual_spend_today_micro + ${micro} > ${MANUAL_RUN_DAILY_CAP_MICRO} AS manual_daily_budget_was_capped
      )
      SELECT ur.actual_spend_micro, ur.budget_micro, ur.run_budget_was_capped,
             ub.manual_spend_today_micro, ub.manual_daily_budget_was_capped
      FROM updated_run ur
      CROSS JOIN updated_budget ub
      LIMIT 1
    `;
    if (!row) {
      console.warn(
        `[SUPERCRON] Manual-run LLM spend accounting fallback could not find run ${config.manualRun.id} for tenant ${config.cycleTenantId}.`,
      );
      return;
    }
    if (row.run_budget_was_capped || row.manual_daily_budget_was_capped) {
      console.warn(
        `[SUPERCRON] Manual-run LLM spend exceeded declared budget constraints; accounting capped at run=${row.actual_spend_micro}/${row.budget_micro} daily=${row.manual_spend_today_micro}/${MANUAL_RUN_DAILY_CAP_MICRO} micro.`,
      );
    }
  } else {
    const stateBefore = config.budgetCache.currentState();
    const capBefore = stateBefore.dailyCapMicro + stateBefore.carryoverBalanceMicro;
    const [row] = await sql`
      UPDATE supercron_tenant_budget_state
      SET spend_today_micro = spend_today_micro + ${micro},
          updated_at = now()
      WHERE tenant_id = ${config.cycleTenantId}
      RETURNING spend_today_micro
    `;
    if (!row) {
      console.warn(
        `[SUPERCRON] Daily LLM spend accounting fallback could not find budget state for tenant ${config.cycleTenantId}.`,
      );
      return;
    }
    const spendTodayMicro = Number(row.spend_today_micro || 0);
    if (spendTodayMicro > capBefore) {
      console.warn(
        `[SUPERCRON] Daily LLM spend accounting fallback exceeded cap: spend=${spendTodayMicro} cap=${capBefore} tenant=${config.cycleTenantId}.`,
      );
    }
  }
  await config.budgetCache.reload(new Date());
}

async function recordBudgetedLlmSpend(config: SupercronConfig, actualMicro: number): Promise<void> {
  try {
    await config.budgetCache.recordLlmSpend(actualMicro, {
      isManualRun: Boolean(config.manualRun),
      manualRunId: config.manualRun?.id ?? null,
    });
  } catch (err) {
    if (!isBudgetSpendRejected(err)) throw err;
    console.warn(
      `[SUPERCRON] LLM spend accounting hit ${err.reason} after the provider call; recording spend best-effort.`,
    );
    await forceRecordBudgetAccounting(config, actualMicro);
  }
}

async function recordEstimatedLlmSpendAfterFailure(
  config: SupercronConfig,
  estimatedMicro: number,
  context: string,
): Promise<void> {
  console.warn(
    `[SUPERCRON] ${context} failed after budget admission; recording estimated LLM spend ${estimatedMicro} micro.`,
  );
  await recordBudgetedLlmSpend(config, estimatedMicro);
}

function budgetDeltaSummary(config: SupercronConfig, afterState = config.budgetCache.currentState()): {
  cycleSpendMicro: number;
  cycleRemainingMicro: number;
  cycleDailySpendMicro: number;
  cycleManualSpendMicro: number;
} {
  const before = config.budgetStateAtCycleStart;
  const cycleDailySpendMicro = Math.max(0, afterState.spendTodayMicro - before.spendTodayMicro);
  const cycleManualSpendMicro = Math.max(0, afterState.manualSpendTodayMicro - before.manualSpendTodayMicro);
  const remainingCheck = config.budgetCache.evaluateBudgetCheck(0, llmBudgetOptions(config));
  return {
    cycleSpendMicro: cycleDailySpendMicro + cycleManualSpendMicro,
    cycleRemainingMicro: remainingCheck.remainingMicro,
    cycleDailySpendMicro,
    cycleManualSpendMicro,
  };
}

function budgetRejectedDetails(rejection: PassResult): Record<string, unknown> {
  return {
    reason: rejection.details.reason || "budget_would_exceed",
    budget_rejected: true,
  };
}

function budgetRejectedPassDetails(reason: string): Record<string, unknown> {
  return {
    reason,
    budget_rejected: true,
  };
}

function isBudgetSpendRejected(error: unknown): error is BudgetSpendRejectedError {
  return error instanceof BudgetSpendRejectedError
    || (error as any)?.name === "BudgetSpendRejectedError";
}

function isManualRunAlreadyOpen(error: unknown): error is ManualRunAlreadyOpenError {
  return error instanceof ManualRunAlreadyOpenError
    || (error as any)?.name === "ManualRunAlreadyOpenError";
}

function llmCostBucket(modelId: string): keyof typeof LLM_MODEL_COST_MICRO_PER_TOKEN {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("embedding") || normalized.includes("embed")) return "embedding";
  if (normalized.includes("lite")) return "flash_lite";
  if (normalized.includes("pro")) return "pro";
  return "flash";
}

function llmActualCostMicro(result: LLMResult, fallbackMicro: number): number {
  if (
    result.inputTokens == null
    || result.outputTokens == null
    || !Number.isFinite(Number(result.inputTokens))
    || !Number.isFinite(Number(result.outputTokens))
  ) {
    return fallbackMicro;
  }
  const rates = LLM_MODEL_COST_MICRO_PER_TOKEN[llmCostBucket(result.modelId)];
  const input = Math.max(0, Number(result.inputTokens || 0));
  const output = Math.max(0, Number(result.outputTokens || 0));
  return Math.max(1, Math.ceil(input * rates.input + output * rates.output));
}

async function auditManualRunLifecycle(
  manualRunId: number,
  status: ManualRunStatus,
  row: { tenant_id: unknown; supercron_run_id?: unknown; rejection_reason?: unknown },
): Promise<void> {
  await auditMutationFromWorker(sql as any, {
    kind: "admin_action",
    tenantId: String(row.tenant_id),
    actor: "supercron_daemon:manual_run",
    actorKind: "operator_token",
    operation: `supercron_manual_run_${status}`,
    eventData: {
      manual_run_id: manualRunId,
      supercron_run_id: row.supercron_run_id == null ? null : Number(row.supercron_run_id),
      rejection_reason: row.rejection_reason == null ? null : String(row.rejection_reason),
    },
  }, { durability: "best_effort" });
}

async function markManualRunStatus(
  manualRunId: number | null | undefined,
  status: ManualRunStatus,
  options: { supercronRunId?: number | null; rejectionReason?: string | null } = {},
): Promise<void> {
  if (!manualRunId) return;
  const [row] = await sql`
    UPDATE supercron_manual_runs
    SET status = ${status},
        supercron_run_id = COALESCE(${options.supercronRunId ?? null}, supercron_run_id),
        rejection_reason = COALESCE(${options.rejectionReason ?? null}, rejection_reason)
    WHERE id = ${manualRunId}
    RETURNING tenant_id, supercron_run_id, rejection_reason
  `;
  if (!row) return;
  await auditManualRunLifecycle(manualRunId, status, row);
}

async function linkManualRunToSupercronRun(
  manualRunId: number | null | undefined,
  supercronRunId: number | null | undefined,
): Promise<void> {
  if (!manualRunId || !supercronRunId) return;
  await sql`
    UPDATE supercron_manual_runs
    SET supercron_run_id = ${supercronRunId}
    WHERE id = ${manualRunId}
  `;
}

async function reconcileOpenManualRuns(tenantId: string): Promise<void> {
  const rows = await sql`
    UPDATE supercron_manual_runs
    SET status = 'failed',
        rejection_reason = COALESCE(rejection_reason, 'daemon_restart_reconciliation')
    WHERE tenant_id = ${tenantId}
      AND status IN ('pending', 'running')
      AND requested_at < now() - interval '1 hour'
    RETURNING id, tenant_id, supercron_run_id, rejection_reason
  `;
  for (const row of rows) {
    await auditManualRunLifecycle(Number(row.id), "failed", row);
  }
}

async function countAppliedLifecycleProposalsSinceLastPass(
  passName: string,
  action: string,
  discoveredBy: string,
): Promise<number> {
  const [row] = await sql`
    WITH last_pass AS (
      SELECT COALESCE(
        (SELECT max(created_at) FROM supercron_pass_telemetry WHERE pass_name = ${passName}),
        now() - interval '7 days'
      ) AS since
    )
    SELECT count(*)::int AS cnt
    FROM proposals, last_pass
    WHERE proposal_type = 'node_edit'
      AND status = 'applied'
      AND payload->>'action' = ${action}
      AND discovered_by = ${discoveredBy}
      AND applied_at > last_pass.since
  `;
  return Number(row?.cnt ?? 0);
}

let closeLoadedTrendService: (() => Promise<void>) | null = null;

async function closeLoadedTrendServiceIfNeeded(): Promise<void> {
  if (!closeLoadedTrendService) return;
  const close = closeLoadedTrendService;
  closeLoadedTrendService = null;
  await close();
}

async function closeLoadedTrendServiceSafely(): Promise<void> {
  try {
    await closeLoadedTrendServiceIfNeeded();
  } catch (err: any) {
    console.error("[SUPERCRON] closeTrendService failed:", err?.message || err);
  }
}

function pyramidFilter(config: SupercronConfig): string {
  if (config.pyramidFocus === MINING_CROSS_MODE) return "";
  if (!CORE_PYRAMID_ID_SET.has(config.pyramidFocus)) {
    throw new Error(`invalid_pyramid_focus:${config.pyramidFocus}`);
  }
  return config.pyramidFocus;
}

// ============================================================
// TIER 1 — DETERMINISTIC PASSES (pure SQL)
// ============================================================

// Pass 1: Heat Refresh
async function pass1HeatRefresh(config: SupercronConfig): Promise<PassResult> {
  return runPass("heat_refresh", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };
    await sql`SELECT refresh_stimulus_heat()`;
    const [cleaned] = await sql`SELECT cleanup_expired_stimuli() AS cnt`;
    const expired = parseInt(cleaned?.cnt || "0");
    return { actions: expired > 0 ? expired + 1 : 1, details: { expired_stimuli: expired } };
  });
}

// Pass 2: Tension Scan (ported from dialectic-scanner.ts, bugs fixed)
async function pass2TensionScan(config: SupercronConfig): Promise<PassResult> {
  return runPass("tension_scan", async () => {
    const pf = pyramidFilter(config);

    // 2a: Tensions via scanner_rules
    const rules = await sql`SELECT * FROM scanner_rules WHERE enabled = true`;
    if (rules.length === 0) return { actions: 0, details: { rules: 0 } };

    // Pyramid-scoped edge fetch
    const edges = pf
      ? await sql`
          SELECT e.from_addr, e.to_addr, e.edge_type, e.confidence AS edge_conf,
            n1.label AS from_label, n1.confidence AS from_conf, n1.pyramid_id AS from_pyramid,
            n1.visibility AS from_vis, n1.node_type AS from_type, n1.substance AS from_sub,
            n2.label AS to_label, n2.confidence AS to_conf, n2.pyramid_id AS to_pyramid,
            n2.visibility AS to_vis, n2.node_type AS to_type, n2.substance AS to_sub
          FROM edges e
          JOIN nodes n1 ON n1.addr = e.from_addr
          JOIN nodes n2 ON n2.addr = e.to_addr
          WHERE n1.visibility = 'public' AND n2.visibility = 'public'
            AND (n1.pyramid_id = ${pf} OR n2.pyramid_id = ${pf})`
      : await sql`
          SELECT e.from_addr, e.to_addr, e.edge_type, e.confidence AS edge_conf,
            n1.label AS from_label, n1.confidence AS from_conf, n1.pyramid_id AS from_pyramid,
            n1.visibility AS from_vis, n1.node_type AS from_type, n1.substance AS from_sub,
            n2.label AS to_label, n2.confidence AS to_conf, n2.pyramid_id AS to_pyramid,
            n2.visibility AS to_vis, n2.node_type AS to_type, n2.substance AS to_sub
          FROM edges e
          JOIN nodes n1 ON n1.addr = e.from_addr
          JOIN nodes n2 ON n2.addr = e.to_addr
          WHERE n1.visibility = 'public' AND n2.visibility = 'public'`;

    let tensionsFound = 0;
    let tensionsCreated = 0;

    for (const edge of edges) {
      for (const rule of rules) {
        // FIX: node_type filter — skip only if NEITHER endpoint matches (was AND→OR bug at scanner:105)
        if (rule.node_types && (rule.node_types as string[]).length > 0) {
          if (!(rule.node_types as string[]).includes(edge.from_type) &&
              !(rule.node_types as string[]).includes(edge.to_type)) continue;
        }
        if (rule.same_pyramid_only && edge.from_pyramid !== edge.to_pyramid) continue;

        let tensionDetected = false;
        let evidence: Record<string, unknown> = {};

        switch (rule.comparison) {
          case "exact_match": {
            const val1 = edge.from_sub?.[rule.field_path];
            const val2 = edge.to_sub?.[rule.field_path];
            if (val1 && val2 && val1 === val2 && edge.from_addr !== edge.to_addr) {
              tensionDetected = true;
              evidence = { field: rule.field_path, value: val1, rule: rule.name };
            }
            break;
          }
          case "array_overlap": {
            const arr1 = edge.from_sub?.[rule.field_path];
            const arr2 = edge.to_sub?.[rule.field_path];
            if (Array.isArray(arr1) && Array.isArray(arr2)) {
              const overlap = arr1.filter((v: string) => arr2.includes(v));
              const ratio = overlap.length / Math.max(arr1.length, arr2.length);
              if (overlap.length > 0 && (!rule.threshold || ratio >= rule.threshold)) {
                tensionDetected = true;
                evidence = { field: rule.field_path, overlap, ratio, rule: rule.name };
              }
            }
            break;
          }
          case "confidence_gap": {
            const gap = Math.abs(edge.from_conf - edge.to_conf);
            if (gap >= (rule.threshold || 0.3)) {
              tensionDetected = true;
              evidence = { field: "confidence", gap: parseFloat(gap.toFixed(3)), rule: rule.name };
            }
            break;
          }
        }

        if (!tensionDetected) continue;
        tensionsFound++;

        // FIX: dedup via SQL WHERE NOT EXISTS instead of loading full tables
        if (!config.dryRun) {
          const [existingTension] = await sql`
            SELECT 1 FROM edge_tensions
            WHERE from_addr = ${edge.from_addr} AND to_addr = ${edge.to_addr}
              AND tension_type = ${rule.produces_tension_type} LIMIT 1`;
          if (existingTension) continue;

          const [existingProposal] = await sql`
            SELECT 1 FROM proposals
            WHERE proposal_type = 'tension' AND from_addr = ${edge.from_addr}
              AND to_addr = ${edge.to_addr} AND status = 'pending' LIMIT 1`;
          if (existingProposal) continue;

          const visibility = (edge.from_vis === "private" || edge.to_vis === "private") ? "private" : "public";
          await sql`
            INSERT INTO proposals (proposal_type, from_addr, to_addr, payload, confidence, discovered_by, evidence)
            VALUES ('tension', ${edge.from_addr}, ${edge.to_addr},
              ${sql.json({
                tension_type: rule.produces_tension_type,
                tension: rule.default_tension,
                visibility,
                from_label: edge.from_label,
                to_label: edge.to_label,
              })},
              ${rule.default_tension}, 'supercron',
              ${sql.json([{ type: "scanner_rule", ...evidence, timestamp: new Date().toISOString() }])})`;
          tensionsCreated++;
        }
      }
    }

    // 2b: Inferences via composition_rules (2-hop)
    const compRules = await sql`
      SELECT edge_type_1, edge_type_2, produces_type, min_confidence
      FROM edge_composition_rules WHERE enabled = true`;
    let inferencesCreated = 0;

    if (compRules.length > 0) {
      const type1s = [...new Set(compRules.map((r: any) => r.edge_type_1))];
      const type2s = [...new Set(compRules.map((r: any) => r.edge_type_2))];
      const ruleMap = new Map<string, any>();
      for (const r of compRules) ruleMap.set(`${r.edge_type_1}|${r.edge_type_2}`, r);

      const pyramidClause = pf
        ? sql`AND (n1.pyramid_id = ${pf} OR n3.pyramid_id = ${pf})`
        : sql``;

      const candidates = await sql`
        SELECT e1.from_addr AS a_addr, e1.to_addr AS b_addr, e2.to_addr AS c_addr,
          e1.edge_type AS type_1, e2.edge_type AS type_2,
          e1.confidence AS conf_1, e2.confidence AS conf_2,
          n1.label AS a_label, n3.label AS c_label
        FROM edges e1
        JOIN edges e2 ON e2.from_addr = e1.to_addr
        JOIN nodes n1 ON n1.addr = e1.from_addr
        JOIN nodes n2 ON n2.addr = e1.to_addr
        JOIN nodes n3 ON n3.addr = e2.to_addr
        WHERE e1.from_addr != e2.to_addr
          AND e1.edge_type = ANY(${type1s}) AND e2.edge_type = ANY(${type2s})
          AND n1.visibility <> 'deleted'
          AND n2.visibility <> 'deleted'
          AND n3.visibility <> 'deleted'
          ${pyramidClause}
        LIMIT 500`;

      for (const c of candidates) {
        const rule = ruleMap.get(`${c.type_1}|${c.type_2}`);
        if (!rule) continue;
        if (c.conf_1 < rule.min_confidence || c.conf_2 < rule.min_confidence) continue;

        if (!config.dryRun) {
          const [existingEdge] = await sql`
            SELECT 1 FROM edges WHERE from_addr = ${c.a_addr} AND to_addr = ${c.c_addr} LIMIT 1`;
          if (existingEdge) continue;

          const [existingProp] = await sql`
            SELECT 1 FROM proposals WHERE proposal_type = 'inference'
              AND from_addr = ${c.a_addr} AND to_addr = ${c.c_addr} AND status = 'pending' LIMIT 1`;
          if (existingProp) continue;

          await sql`
            INSERT INTO proposals (proposal_type, from_addr, to_addr, payload, confidence, discovered_by, evidence)
            VALUES ('inference', ${c.a_addr}, ${c.c_addr},
              ${sql.json({ edge_type: rule.produces_type, from_label: c.a_label, to_label: c.c_label })},
              ${Math.min(c.conf_1, c.conf_2)}, 'supercron',
              ${sql.json([{ type: "transitive_chain", produces: rule.produces_type, timestamp: new Date().toISOString() }])})`;
          inferencesCreated++;
        }
      }
    }

    // 2c: Consistency check
    let consistencyFlagged = 0;
    if (!config.dryRun) {
      const unchecked = await sql`
        SELECT id, from_addr, to_addr, tension_type FROM edge_tensions
        WHERE consistency_status = 'unchecked' AND synthesis IS NOT NULL LIMIT 50`;

      for (const t of unchecked) {
        const related = await sql`
          SELECT tension_type FROM edge_tensions
          WHERE (from_addr = ${t.from_addr} OR to_addr = ${t.from_addr}
            OR from_addr = ${t.to_addr} OR to_addr = ${t.to_addr})
            AND id != ${t.id} AND synthesis IS NOT NULL AND resolved_at IS NULL`;

        let consistent = true;
        for (const r of related) {
          if ((t.tension_type === "contradiction" && r.tension_type === "complement") ||
              (t.tension_type === "complement" && r.tension_type === "contradiction")) {
            consistent = false;
            break;
          }
        }

        await sql`
          UPDATE edge_tensions SET consistency_status = ${consistent ? "consistent" : "flagged"},
            consistency_checked_at = now() WHERE id = ${t.id}`;
        if (!consistent) consistencyFlagged++;
      }
    }

    return {
      actions: tensionsCreated + inferencesCreated + consistencyFlagged,
      details: {
        tensions_found: tensionsFound,
        tensions_created: tensionsCreated,
        inferences_created: inferencesCreated,
        consistency_flagged: consistencyFlagged,
      },
    };
  });
}

// Pass 3: Memory Lifecycle (NEW)
async function pass3MemoryLifecycle(config: SupercronConfig): Promise<PassResult> {
  return runPass("memory_lifecycle", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // 3a: Promote memories to `consolidated`. F12: route through the
    // canonical `advanceMaturity()` helper (api/src/lib/maturity.ts) so
    // the state-machine + audit semantics match maturity-cycle.ts.
    // Thresholds (consolidated_min_age_days, consolidated_min_query_hits)
    // are loaded from graph_state with documented defaults.
    // Changelogs excluded — they are temporal receipts, not promotable knowledge.
    const { advanceMaturity, loadMaturityThresholds } = await import(
      "../../api/src/lib/maturity"
    );
    const thresholds = await loadMaturityThresholds(sql as any);
    const promotionCandidates = await sql`
      SELECT addr FROM nodes
      WHERE node_type = 'memory' AND visibility = 'public'
        AND COALESCE(substance->>'maturity_stage', 'encoded') = 'encoded'
        AND COALESCE(substance->>'memory_type', '') <> 'changelog'
        AND query_hits >= ${thresholds.consolidated_min_query_hits}
        AND created_at < now() - (${thresholds.consolidated_min_age_days}::text || ' days')::interval
    `;
    let promotedCount = 0;
    for (const row of promotionCandidates) {
      try {
        const r = await advanceMaturity(sql as any, String(row.addr), "consolidated", {
          reason: "supercron: memory consolidation",
        });
        if (r.changed) promotedCount++;
      } catch (e: any) {
        console.error(`[supercron] consolidation failed for ${row.addr}:`, e?.message);
      }
    }
    const promoted = { cnt: promotedCount };

    // 3b: Decay: query_hits = 0, age > 30d → confidence -= 0.02 (floor 0.10)
    const [decayed] = await sql`
      WITH decayed AS (
        UPDATE nodes SET confidence = GREATEST(0.10, confidence - 0.02)
        WHERE node_type = 'memory' AND visibility = 'public'
          AND query_hits = 0 AND created_at < now() - interval '30 days'
          AND confidence > 0.10
        RETURNING addr
      ) SELECT count(*) AS cnt FROM decayed`;

    // 3c: Demote: query_hits = 0, age > 60d, not pinned → dormant.
    // Tenant memory is EXCLUDED (mirrors 3d below): direct dormancy with no registry
    // transition / memory_events row trips the false-dormancy invariant breach documented
    // in VO node PJ.0.3.5070. Tenant-memory dormancy goes ONLY through the audited
    // memory-lifecycle helpers (3f's proposal flow); this generic sweep touches operator
    // (non-tenant) public memory only.
    const [demoted] = await sql`
      WITH demoted AS (
        UPDATE nodes SET dormant_at = now(), visibility = 'dormant'
        WHERE node_type = 'memory' AND visibility = 'public'
          AND space_id NOT LIKE 'tenant:%'
          AND query_hits = 0 AND created_at < now() - interval '60 days'
          AND pinned = false AND dormant_at IS NULL
        RETURNING addr
      ) SELECT count(*) AS cnt FROM demoted`;

    // 3c2: Changelog absorption — changelogs whose day node has a summary are redundant.
    // Their temporal signal is captured in the active_on edge; the content is in the day summary.
    // Dormant after 7 days (not 60) if the day node summary exists.
    const [absorbedChangelogs] = await sql`
      WITH absorbed AS (
        UPDATE nodes SET dormant_at = now(), visibility = 'dormant'
        WHERE node_type = 'changelog' AND visibility NOT IN ('dormant', 'deleted')
          AND dormant_at IS NULL AND pinned = false
          AND created_at < now() - interval '7 days'
          AND query_hits = 0
          AND EXISTS (
            SELECT 1 FROM edges e
            JOIN nodes day ON e.to_addr = day.addr
            WHERE e.from_addr = nodes.addr
              AND e.edge_type = 'active_on'
              AND day.node_type = 'day'
              AND day.substance->>'summary' IS NOT NULL
              AND day.substance->>'summary' <> ''
          )
        RETURNING addr
      ) SELECT count(*) AS cnt FROM absorbed`;

    // 3d: Memory supersession: new correction/decision sim > 0.80 to older → old.dormant_at
    // Tenant memories are EXCLUDED here — 3f's proposal flow handles tenant supersession.
    // Direct dormancy without registry transition caused the false-dormancy invariant breach
    // documented in VO node PJ.0.3.5070; this filter prevents recurrence.
    const [superseded] = await sql`
      WITH pairs AS (
        SELECT newer.addr AS newer_addr, older.addr AS older_addr,
          1 - (newer.embedding_hv::vector <=> older.embedding_hv::vector) AS sim
        FROM nodes newer
        JOIN nodes older ON older.node_type = 'memory'
          AND older.addr != newer.addr
          AND older.created_at < newer.created_at
          AND older.visibility = 'public'
          AND older.dormant_at IS NULL
          AND older.space_id NOT LIKE 'tenant:%'
        WHERE newer.node_type = 'memory'
          AND newer.visibility = 'public'
          AND newer.space_id NOT LIKE 'tenant:%'
          AND newer.embedding_hv IS NOT NULL AND older.embedding_hv IS NOT NULL
          AND COALESCE(newer.substance->>'memory_type', '') IN ('correction', 'decision')
          AND newer.created_at > now() - interval '7 days'
          AND 1 - (newer.embedding_hv::vector <=> older.embedding_hv::vector) > 0.80
          AND (newer.embedding_hv::vector <=> older.embedding_hv::vector) <> 'NaN'::float
        LIMIT 20
      ),
      updated AS (
        UPDATE nodes SET dormant_at = now(), visibility = 'dormant'
        FROM pairs WHERE nodes.addr = pairs.older_addr
        RETURNING nodes.addr
      ) SELECT count(*) AS cnt FROM updated`;

    // 3e: Tenant garbage collection — AUDITED (Memory-Health PR 1). Replaces the
    // former silent `DELETE FROM nodes` of tenant memory. Proven injection/fuzz
    // garbage is purged WITH a durable audit event; too-short (unproven) memory is
    // ARCHIVED via the canonical forgetMemory helper (recoverable), never silently
    // hard-deleted. The whole routine lives in supercron-memory-garbage.ts so the
    // foundation-drift guard can assert supercron.ts holds no raw memory DELETE.
    const tenantGarbageSweep = await sweepTenantMemoryGarbage(sql);

    // 3f: Tenant supersession — proposal-only. Tenant memories are never
    // dormanted directly from vector similarity; protected and recently
    // rolled-back memories are skipped before proposal creation.
    const tenantSupersessionThreshold = 0.80;
    const tenantSupersessionConfidenceCap = 0.95;
    const [tenantSupersession] = await sql`
      WITH raw_pairs AS (
        SELECT
          newer.addr AS newer_addr,
          older.addr AS older_addr,
          newer.created_at AS newer_created_at,
          older.created_at AS older_created_at,
          older.space_id AS older_space_id,
          older.pinned AS older_pinned,
          older.substance AS older_substance,
          mr.addr AS older_registry_addr,
          mr.status AS older_status,
          mr.kind AS older_kind,
          mr.source_kind AS older_source_kind,
          mr.accepted_by_user AS older_accepted_by_user,
          substring(older.space_id from 8) AS tenant_id,
          1 - (newer.embedding_hv::vector <=> older.embedding_hv::vector) AS sim
        FROM nodes newer
        JOIN nodes older ON older.node_type = 'memory'
          AND older.addr != newer.addr
          AND older.created_at < newer.created_at
          AND older.space_id = newer.space_id
          AND older.dormant_at IS NULL
        LEFT JOIN memory_registry mr
          ON mr.addr = older.addr
          AND mr.tenant_id = substring(older.space_id from 8)
        WHERE newer.node_type = 'memory'
          AND newer.space_id LIKE 'tenant:%'
          AND newer.dormant_at IS NULL
          AND newer.embedding_hv IS NOT NULL AND older.embedding_hv IS NOT NULL
          AND COALESCE(newer.substance->>'memory_type', '') IN ('correction', 'decision')
          AND newer.created_at > now() - interval '7 days'
          AND 1 - (newer.embedding_hv::vector <=> older.embedding_hv::vector) > ${tenantSupersessionThreshold}::double precision
          AND (newer.embedding_hv::vector <=> older.embedding_hv::vector) <> 'NaN'::float
      ),
      classified AS (
        SELECT
          raw_pairs.*,
          older_registry_addr IS NULL AS missing_registry,
          (
            COALESCE(older_status <> 'active', false)
            OR COALESCE(older_accepted_by_user, false) = true
            OR COALESCE(older_source_kind = 'user_accepted', false)
            OR COALESCE(older_kind = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[]), false)
            OR COALESCE(older_pinned, false) = true
            OR COALESCE(older_substance->>'maturity_stage' = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[]), false)
          ) AS protected,
          EXISTS (
            SELECT 1
            FROM memory_events me
            WHERE me.addr = raw_pairs.older_addr
              AND me.tenant_id = raw_pairs.tenant_id
              AND me.correlation_id LIKE 'supercron-%-rollback'
              AND me.created_at > now() - interval '30 days'
          ) OR EXISTS (
            SELECT 1
            FROM proposals p
            WHERE p.proposal_type = 'node_edit'
              AND p.status = 'rejected'
              AND p.from_addr = raw_pairs.newer_addr
              AND p.to_addr = raw_pairs.older_addr
              AND p.target_addr = raw_pairs.older_addr
              AND p.payload->>'action' = 'tenant_memory_supersession'
              AND COALESCE(p.reviewed_at, p.created_at) > now() - interval '30 days'
          ) AS rollback_suppressed,
          EXISTS (
            SELECT 1
            FROM proposals p
            WHERE p.proposal_type = 'node_edit'
              AND p.status IN ('pending', 'approved')
              AND p.from_addr = raw_pairs.newer_addr
              AND p.to_addr = raw_pairs.older_addr
              AND (
                (
                  p.target_addr = raw_pairs.older_addr
                  AND p.payload->>'action' = 'tenant_memory_supersession'
                )
                OR (
                  p.target_addr = raw_pairs.newer_addr
                  AND p.payload->>'action' = 'memory_merge'
                )
              )
          ) AS duplicate_pending
        FROM raw_pairs
      ),
      eligible AS (
        SELECT *
        FROM classified
        WHERE missing_registry = false
          AND protected = false
          AND rollback_suppressed = false
          AND duplicate_pending = false
        ORDER BY sim DESC, newer_created_at DESC, older_created_at ASC
        LIMIT 20
      ),
      inserted AS (
        INSERT INTO proposals (
          proposal_type,
          from_addr,
          to_addr,
          target_addr,
          payload,
          confidence,
          discovered_by,
          evidence,
          status
        )
        SELECT
          'node_edit',
          newer_addr,
          older_addr,
          older_addr,
          jsonb_build_object(
            'action', 'tenant_memory_supersession',
            'older_addr', older_addr,
            'newer_addr', newer_addr,
            'similarity', sim,
            'threshold', ${tenantSupersessionThreshold}::double precision,
            'confidence_cap', ${tenantSupersessionConfidenceCap}::double precision,
            'mode', 'proposal_only',
            'would_set_dormant_at', true,
            'would_set_registry_status', 'superseded',
            'requires_review', true
          ),
          LEAST(sim, ${tenantSupersessionConfidenceCap}::double precision),
          'supercron',
          jsonb_build_array(jsonb_build_object(
            'type', 'embedding_similarity',
            'cycle_number', ${config.cycleNumber}::int,
            'timestamp', now()
          )),
          'pending'
        FROM eligible
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*)::int FROM raw_pairs) AS candidates,
        (SELECT COUNT(*)::int FROM classified WHERE missing_registry = true) AS missing_registry,
        (SELECT COUNT(*)::int FROM classified WHERE missing_registry = false AND protected = true) AS protected_skipped,
        (SELECT COUNT(*)::int FROM classified WHERE missing_registry = false AND protected = false AND rollback_suppressed = true) AS rollback_suppressed,
        (SELECT COUNT(*)::int FROM classified WHERE missing_registry = false AND protected = false AND rollback_suppressed = false AND duplicate_pending = true) AS duplicate_pending,
        (SELECT COUNT(*)::int FROM inserted) AS proposed`;

    // 3g: Tenant decay — only context/changelog types (not correction/preference/decision — those are assertions)
    const [tenantDecayed] = await sql`
      WITH decayed AS (
        UPDATE nodes SET confidence = GREATEST(0.10, confidence - 0.02)
        WHERE node_type = 'memory' AND space_id LIKE 'tenant:%'
          AND dormant_at IS NULL
          AND query_hits = 0 AND created_at < now() - interval '30 days'
          AND confidence > 0.10
          AND COALESCE(substance->>'memory_type', 'context') IN ('context', 'changelog')
        RETURNING addr
      ) SELECT count(*) AS cnt FROM decayed`;

    const tGarbagePurged = tenantGarbageSweep.purged;
    const tGarbageArchived = tenantGarbageSweep.archived;
    const tGarbage = tGarbagePurged + tGarbageArchived;
    const tSupersessionCandidates = parseInt(tenantSupersession.candidates);
    const tSupersessionProposed = parseInt(tenantSupersession.proposed);
    const tSupersessionMissingRegistrySkipped = parseInt(tenantSupersession.missing_registry);
    const tSupersessionProtectedSkipped = parseInt(tenantSupersession.protected_skipped);
    const tSupersessionRollbackSuppressed = parseInt(tenantSupersession.rollback_suppressed);
    const tSupersessionBlockedAuto = parseInt(tenantSupersession.duplicate_pending);
    const tSupersessionApplied = await countAppliedLifecycleProposalsSinceLastPass(
      "memory_lifecycle",
      "tenant_memory_supersession",
      "supercron",
    );
    const tDecayed = parseInt(tenantDecayed.cnt);

    const absorbedCount = Number(absorbedChangelogs.cnt);
    const total = Number(promoted.cnt) + Number(decayed.cnt) + Number(demoted.cnt) + Number(superseded.cnt)
      + tGarbage + tSupersessionProposed + tDecayed + absorbedCount;
    return {
      actions: total,
      proposals_created: tSupersessionProposed,
      proposals_applied: tSupersessionApplied,
      details: {
        promoted: Number(promoted.cnt),
        decayed: Number(decayed.cnt),
        demoted: Number(demoted.cnt),
        superseded: Number(superseded.cnt),
        tenant_garbage: tGarbage,
        tenant_garbage_purged: tGarbagePurged,
        tenant_garbage_archived: tGarbageArchived,
        tenant_supersession_candidates: tSupersessionCandidates,
        tenant_supersession_proposed: tSupersessionProposed,
        tenant_supersession_applied_since_previous_cycle: tSupersessionApplied,
        tenant_supersession_missing_registry_skipped: tSupersessionMissingRegistrySkipped,
        tenant_supersession_protected_skipped: tSupersessionProtectedSkipped,
        tenant_supersession_rollback_suppressed: tSupersessionRollbackSuppressed,
        tenant_supersession_blocked_auto: tSupersessionBlockedAuto,
        tenant_decayed: tDecayed,
      },
    };
  });
}

// Pass 3b: Registry Lifecycle Reconciliation
// Detects active-registry-but-dormant-node mismatches and creates proposals
// for human/qc-sentinel review. Proposal-only; no direct mutation.
async function pass3bRegistryRepair(config: SupercronConfig): Promise<PassResult> {
  return runPass("registry_lifecycle_reconciliation", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    const [created] = await sql`
      WITH mismatches AS (
        SELECT
          mr.addr,
          mr.tenant_id,
          mr.kind AS registry_kind,
          mr.status AS registry_status,
          n.visibility AS node_visibility,
          n.dormant_at AS node_dormant_at,
          terminal_event.memory_event_id,
          terminal_event.last_terminal_event,
          terminal_event.event_type AS suggested_terminal_status
        FROM memory_registry mr
        JOIN nodes n
          ON n.addr = mr.addr
          AND substring(n.space_id from 8) = mr.tenant_id
        LEFT JOIN LATERAL (
          SELECT
            me.id AS memory_event_id,
            me.event_type,
            jsonb_build_object('id', me.id, 'event_type', me.event_type, 'created_at', me.created_at) AS last_terminal_event
          FROM memory_events me
          WHERE me.addr = mr.addr
            AND me.tenant_id = mr.tenant_id
            AND me.event_type IN ('superseded', 'retracted', 'archived', 'expired')
          ORDER BY me.created_at DESC
          LIMIT 1
        ) terminal_event ON true
        WHERE mr.status = 'active'
          AND mr.tenant_id IS NOT NULL
          AND length(mr.tenant_id) > 0
          AND n.node_type = 'memory'
          AND n.visibility IN ('dormant', 'merged')
          AND NOT EXISTS (
            SELECT 1
            FROM proposals existing
            WHERE existing.target_addr = mr.addr
              AND existing.payload->>'action' = 'registry_lifecycle_reconciliation'
              AND existing.payload->>'tenant_id' = mr.tenant_id
              AND existing.status IN ('pending', 'approved')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM memory_events rollback
            WHERE rollback.addr = mr.addr
              AND rollback.tenant_id = mr.tenant_id
              AND rollback.correlation_id LIKE 'supercron-%-registry-reconcile-rollback'
              AND rollback.created_at > now() - interval '30 days'
          )
        LIMIT 20
      ),
      inserted AS (
        INSERT INTO proposals (
          proposal_type, target_addr, payload, confidence, discovered_by, evidence, status
        )
        SELECT
          'node_edit',
          addr,
          jsonb_build_object(
            'action', 'registry_lifecycle_reconciliation',
            'reason', 'active_registry_but_node_dormant',
            'tenant_id', tenant_id,
            'registry_kind', registry_kind,
            'registry_status', registry_status,
            'node_visibility', node_visibility,
            'node_dormant_at', node_dormant_at,
            'node_dormant_at_missing', node_dormant_at IS NULL,
            'last_terminal_event', last_terminal_event,
            'suggested_terminal_status', suggested_terminal_status,
            'suggestion_source', CASE
              WHEN suggested_terminal_status IS NULL THEN 'manual_review_required'
              ELSE 'memory_events'
            END,
            'manual_review_note', CASE
              WHEN suggested_terminal_status IS NULL THEN 'no_terminal_memory_event_found'
              ELSE NULL
            END,
            'requires_review', true,
            'mode', 'proposal_only'
          ),
          0.85,
          'supercron-registry-repair',
          jsonb_build_array(jsonb_build_object(
            'type', 'registry_node_visibility_drift',
            'cycle_number', ${config.cycleNumber ?? -1}::int,
            'source_memory_event_id', memory_event_id,
            'detected_at', now()
          )),
          'pending'
        FROM mismatches
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM mismatches) AS mismatches_detected,
        (SELECT count(*)::int FROM inserted) AS proposals_created`;

    const mismatchesDetected = Number(created.mismatches_detected ?? 0);
    const proposalsCreated = Number(created.proposals_created ?? 0);
    const proposalsApplied = await countAppliedLifecycleProposalsSinceLastPass(
      "registry_lifecycle_reconciliation",
      "registry_lifecycle_reconciliation",
      "supercron-registry-repair",
    );

    return {
      actions: proposalsCreated,
      proposals_created: proposalsCreated,
      proposals_applied: proposalsApplied,
      details: {
        mismatches_detected: mismatchesDetected,
        proposals_created: proposalsCreated,
        proposals_applied_since_previous_cycle: proposalsApplied,
        mode: "proposal_only",
      },
    };
  });
}

// Pass 3c: Project Association Doctor
// Detects active tenant memories that lack both `substance.project_addr` and a
// `part_of` edge to a project root, classifies them via keyword rules against
// project roots in `PJ.0.1.*`, and creates proposals for human/qc-sentinel
// review. Multi-tenant; proposal-only; no direct mutation. Slice A only:
// detection + proposal generation. The apply path (project_addr + part_of
// edge mutation under operator approval) is handled in a separate slice that
// follows the codex registry-reconciliation.ts pattern.
async function pass3cProjectAssociationDoctor(config: SupercronConfig): Promise<PassResult> {
  return runPass("project_association_doctor", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    const [created] = await sql`
      WITH orphans AS (
        SELECT
          n.addr,
          mr.tenant_id,
          n.label,
          COALESCE(n.substance->>'assertion', n.substance->>'description', '') AS body
        FROM memory_registry mr
        JOIN nodes n
          ON n.addr = mr.addr
          AND substring(n.space_id from 8) = mr.tenant_id
        WHERE mr.status = 'active'
          AND mr.tenant_id IS NOT NULL
          AND length(mr.tenant_id) > 0
          AND n.node_type = 'memory'
          AND n.dormant_at IS NULL
          AND n.visibility <> 'deleted'
          AND NOT (n.substance ? 'project_addr')
          AND NOT EXISTS (
            SELECT 1 FROM edges e
            WHERE e.from_addr = n.addr AND e.edge_type = 'part_of'
          )
      ),
      classified AS (
        SELECT addr, tenant_id, label,
          CASE
            WHEN (label || ' ' || body) ~* '\msupercron\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\m(example project|example project)\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mlgl\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mexample project\M|\mexample\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mproject-c\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mproject-g\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\moura\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mproject-d\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mproject-e\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mproject-f\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\mopenclaw\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\m(vo beta|verity beta|verity-one beta)\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\m(tenant|memory_registry|memory_events|supercron|qc.sentinel|/remember|/context|verity-ingest|miners/src|api/src|distiller|reactor|truth_refresh|edge_integrity|heat_refresh|stimulus|space_id|memory.lifecycle)\M' THEN 'PJ.0.1.X'
            WHEN (label || ' ' || body) ~* '\m(verity one|verity-one)\M' THEN 'PJ.0.1.X'
            ELSE NULL
          END AS proposed_project_addr,
          CASE
            WHEN (label || ' ' || body) ~* '\msupercron\M|\mexample project\M|\mexample\M|\mopenclaw\M|\m(vo beta|verity beta|verity-one beta)\M' THEN 'keyword_explicit'
            WHEN (label || ' ' || body) ~* '\m(tenant|memory_registry|memory_events|supercron|qc.sentinel|/remember|/context|verity-ingest|miners/src|api/src|distiller|reactor|truth_refresh|edge_integrity|heat_refresh|stimulus|space_id|memory.lifecycle)\M|\m(verity one|verity-one)\M' THEN 'keyword_inferred'
            ELSE NULL
          END AS classifier_rule
        FROM orphans
      ),
      candidates AS (
        SELECT c.addr, c.tenant_id, c.proposed_project_addr, c.classifier_rule,
               p.label AS proposed_project_label
        FROM classified c
        JOIN nodes p ON p.addr = c.proposed_project_addr AND p.dormant_at IS NULL
        WHERE c.proposed_project_addr IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM proposals existing
            WHERE existing.target_addr = c.addr
              AND existing.payload->>'action' = 'project_association'
              AND existing.payload->>'tenant_id' = c.tenant_id
              AND existing.status IN ('pending', 'approved')
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_events rollback
            WHERE rollback.addr = c.addr
              AND rollback.tenant_id = c.tenant_id
              AND rollback.correlation_id LIKE 'supercron-%-project-association-rollback'
              AND rollback.created_at > now() - interval '30 days'
          )
        LIMIT 20
      ),
      inserted AS (
        INSERT INTO proposals (
          proposal_type, target_addr, payload, confidence, discovered_by, evidence, status
        )
        SELECT
          'node_edit',
          addr,
          jsonb_build_object(
            'action', 'project_association',
            'reason', 'active_tenant_memory_without_project_association',
            'tenant_id', tenant_id,
            'proposed_project_addr', proposed_project_addr,
            'proposed_project_label', proposed_project_label,
            'classifier_rule', classifier_rule,
            'requires_review', true,
            'mode', 'proposal_only'
          ),
          CASE WHEN classifier_rule = 'keyword_explicit' THEN 0.9 ELSE 0.7 END,
          'supercron-project-association-doctor',
          jsonb_build_array(jsonb_build_object(
            'type', 'project_association_debt',
            'cycle_number', ${config.cycleNumber ?? -1}::int,
            'classifier_rule', classifier_rule,
            'detected_at', now()
          )),
          'pending'
        FROM candidates
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM classified WHERE proposed_project_addr IS NOT NULL) AS classified_count,
        (SELECT count(*)::int FROM candidates) AS candidates_count,
        (SELECT count(*)::int FROM inserted) AS proposals_created,
        (SELECT count(*)::int FROM orphans) AS orphans_total`;

    const orphansTotal = Number(created.orphans_total ?? 0);
    const classifiedCount = Number(created.classified_count ?? 0);
    const candidatesCount = Number(created.candidates_count ?? 0);
    const proposalsCreated = Number(created.proposals_created ?? 0);

    return {
      actions: proposalsCreated,
      proposals_created: proposalsCreated,
      details: {
        orphans_total: orphansTotal,
        classified_count: classifiedCount,
        candidates_after_dedup: candidatesCount,
        proposals_created: proposalsCreated,
        unclassified_remainder: Math.max(orphansTotal - classifiedCount, 0),
        mode: "proposal_only",
      },
    };
  });
}

// Pass 4: Node Health
async function pass4NodeHealth(config: SupercronConfig): Promise<PassResult> {
  return runPass("node_health", async () => {
    const pf = pyramidFilter(config);

    // 4a: Orphan detection (no edges, layer > 0, age > 72h)
    // TEMPORAL pyramid excluded — day nodes managed by temporal super cron, not orphan detection
    const pyramidWhere = pf ? sql`AND n.pyramid_id = ${pf}` : sql``;
    const orphans = await sql`
      SELECT n.addr, n.label FROM nodes n
      LEFT JOIN edges e ON e.from_addr = n.addr OR e.to_addr = n.addr
      WHERE e.id IS NULL AND n.layer > 0 AND n.visibility = 'public'
        AND n.created_at < now() - interval '72 hours'
        AND n.pyramid_id <> 'TEMPORAL'
        ${pyramidWhere}
      LIMIT 100`;

    // 4b: Unembedded detection (report only)
    const unembedded = await sql`
      SELECT count(*) AS cnt FROM nodes
      WHERE embedding_hv IS NULL AND visibility = 'public'
        ${pf ? sql`AND pyramid_id = ${pf}` : sql``}`;

    // 4c: Mark dormant via SQL function
    let dormantMarked = 0;
    if (!config.dryRun) {
      const [result] = await sql`SELECT mark_dormant_nodes() AS marked`;
      dormantMarked = parseInt(result?.marked || "0");
    }

    // 4d: Clean stale heartbeat rows (keep only last 24h of stopped entries)
    let heartbeatsCleaned = 0;
    if (!config.dryRun) {
      const cleaned = await sql`DELETE FROM worker_heartbeats WHERE status = 'stopped' AND last_heartbeat < now() - interval '24 hours'`;
      heartbeatsCleaned = cleaned.count;
    }

    return {
      actions: dormantMarked + heartbeatsCleaned,
      details: {
        orphans_found: orphans.length,
        unembedded: parseInt(unembedded[0]?.cnt || "0"),
        dormant_marked: dormantMarked,
        heartbeats_cleaned: heartbeatsCleaned,
        orphan_addrs: orphans.slice(0, 10).map((o: any) => o.addr),
      },
    };
  });
}

// Pass 5: Edge Integrity + Truth Injection
async function pass5EdgeIntegrity(config: SupercronConfig): Promise<PassResult> {
  return runPass("edge_integrity", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };
    const pf = pyramidFilter(config);

    // 5a: Delete self-loops (may be zero if DB has check constraint preventing them)
    let selfLoopCount = 0;
    try {
      const selfLoops = await sql`SELECT id FROM edges WHERE from_addr = to_addr`;
      const deleted = await deleteEdgesByIds(sql as any, selfLoops.map((row: any) => row.id));
      selfLoopCount = deleted.deleted;
    } catch { /* check constraint may prevent self-loops entirely */ }

    // 5b: Delete edges to dormant/merged/absorbed nodes. Tombstoned nodes
    // deliberately stay edge-connected until a later irreversible delete.
    const deadEdgeRows = await sql`
      SELECT e.id
      FROM edges e
      JOIN nodes n ON e.from_addr = n.addr OR e.to_addr = n.addr
      WHERE n.visibility IN ('dormant', 'merged')`;
    const deadEdgeProtection = await filterEdgeIdsBelowUsefulnessProtection(deadEdgeRows.map((row: any) => row.id));
    const deadEdges = await deleteEdgesByIds(sql as any, deadEdgeProtection.edgeIds);

    // 5c: Deduplicate edges (same from/to/type, keep lowest id)
    const dupeRows = await sql`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY from_addr, to_addr, edge_type ORDER BY id
        ) AS rn FROM edges
      )
      SELECT id FROM ranked WHERE rn > 1`;
    const dupeProtection = await filterEdgeIdsBelowUsefulnessProtection(dupeRows.map((row: any) => row.id));
    const dupes = await deleteEdgesByIds(sql as any, dupeProtection.edgeIds);

    // 5d: Wire orphan memories → nearest 3 functional nodes
    const pyramidMemWhere = pf ? sql`AND m.pyramid_id = ${pf}` : sql``;
    const orphanMemories = await sql`
      SELECT m.addr, m.substance->>'memory_type' AS memory_type, m.embedding_hv
      FROM nodes m
      LEFT JOIN edges e ON e.from_addr = m.addr OR e.to_addr = m.addr
      WHERE m.node_type = 'memory' AND m.visibility = 'public'
        AND m.embedding_hv IS NOT NULL AND e.id IS NULL
        ${pyramidMemWhere}
      LIMIT 30`;

    let memoryEdgesWired = 0;
    for (const mem of orphanMemories) {
      const edgeType = mem.memory_type === "correction" ? "constrains"
        : mem.memory_type === "decision" ? "grounds" : "guides";

      const nearest = await sql`
        SELECT addr FROM nodes
        WHERE node_type != 'memory' AND visibility = 'public'
          AND embedding_hv IS NOT NULL AND addr != ${mem.addr}
        ORDER BY embedding_hv::vector <=> ${mem.embedding_hv}::vector
        LIMIT 3`;

      for (const target of nearest) {
        if (target.addr === mem.addr) continue; // prevent self-loops
        const sim = await sql`
          SELECT 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) AS sim
          FROM nodes a, nodes b WHERE a.addr = ${mem.addr} AND b.addr = ${target.addr}`;
        const simValue = parseFloat(sim[0]?.sim || "0");
        if (!Number.isFinite(simValue) || simValue < 0.55) continue;

        const inserted = await writeEdge(sql as any, {
          fromAddr: String(mem.addr),
          toAddr: String(target.addr),
          edgeType,
          confidence: 0.60,
          layer: 1,
          provenance: { discovered_by: "supercron", created: new Date().toISOString() },
        });
        if (inserted.inserted) memoryEdgesWired++;
      }
    }

    // 5e: Truth injection — non-memory public nodes with zero WORLD/HEURISTIC grounds edges
    // PJ.0.3.907: memories anchor to function, function to truth — no truth edges on memories
    // 5e: Truth injection — skip nodes already audited by Opus (/truth skill)
    const pyramidTruthWhere = pf ? sql`AND n.pyramid_id = ${pf}` : sql``;
    const truthless = await sql`
      SELECT n.addr, n.embedding_hv
      FROM nodes n
      LEFT JOIN edges e ON (e.to_addr = n.addr OR e.from_addr = n.addr)
        AND e.edge_type IN ('grounds', 'frames')
        AND (
          EXISTS (SELECT 1 FROM nodes src WHERE src.addr = e.from_addr AND src.pyramid_id = ANY(${TRUTH_PYRAMID_LIST}::text[]))
          OR EXISTS (SELECT 1 FROM nodes src WHERE src.addr = e.to_addr AND src.pyramid_id = ANY(${TRUTH_PYRAMID_LIST}::text[]))
        )
      WHERE n.visibility = 'public' AND n.node_type NOT IN ('memory', 'structure')
        AND n.pyramid_id <> ALL(${TRUTH_PYRAMID_LIST}::text[])
        AND n.embedding_hv IS NOT NULL AND e.id IS NULL
        -- Skip leaf tool/skill nodes (depth >= 3) — truth edges on specific CLI
        -- commands and API details are noise; these derive meaning from their
        -- parent category, not from philosophical grounding.
        AND NOT (n.depth >= 3 AND n.node_type IN ('tool', 'skill', 'workflow'))
        -- Skip nodes already audited by Opus (truth_audited stamp or any
        -- Opus-provenance edge in either direction). When Opus deliberately
        -- deletes all truth edges, the stamp prevents supercron re-wiring.
        AND COALESCE(n.source_context->>'truth_audited', '') = ''
        AND NOT EXISTS (
          SELECT 1 FROM edges opus_e
          WHERE (opus_e.to_addr = n.addr OR opus_e.from_addr = n.addr)
            AND opus_e.provenance->>'agent' IN ('vo-truth-opus', 'vo-resonance-opus', 'vo-harvester-opus-qc', 'vo-resonance-opus-qc')
        )
        ${pyramidTruthWhere}
      LIMIT 50`;

    let truthEdgesWired = 0;
    for (const node of truthless) {
      const truthNodes = await sql`
        SELECT addr, 1 - (embedding_hv::vector <=> ${node.embedding_hv}::vector) AS sim
        FROM nodes
        WHERE pyramid_id = ANY(${TRUTH_PYRAMID_LIST}::text[]) AND visibility = 'public'
          AND embedding_hv IS NOT NULL
        ORDER BY embedding_hv::vector <=> ${node.embedding_hv}::vector
        LIMIT 2`;

      for (const truth of truthNodes) {
        if (truth.addr === node.addr) continue; // prevent self-loops
        if (parseFloat(truth.sim) < 0.72) continue;
        await upsertEdge(sql as any, {
          fromAddr: String(truth.addr),
          toAddr: String(node.addr),
          edgeType: "grounds",
          confidence: parseFloat(truth.sim),
          layer: 1,
          provenance: { discovered_by: "supercron", created: new Date().toISOString() },
        }, { conflictUpdate: "replaceMetadata" });
        truthEdgesWired++;
      }
    }

    // 5f-inline: Normalize pre-F12 redundant edge types. The F12
    // edges_edge_type_check prevents new relates_to / related_concept
    // rows, but this remains harmless for older tenants before migration.
    const redundantEdgeRows = await sql`
      SELECT id FROM edges
      WHERE edge_type IN ('relates_to', 'related_concept')`;
    const edgeNormalized = await rewriteEdgeTypeByIds(
      sql as any,
      redundantEdgeRows.map((row: any) => row.id),
      "related_to",
      { reason: "supercron_edge_type_normalization" },
    );
    const edgesNormalized = edgeNormalized.rewritten;

    // 5g-inline: Cap mega-hub outbound informs edges (>150) — prune lowest-confidence edges
    // Hubs with 150+ informs edges drown out signal for AI visitors
    const megaHubs = await sql`
      SELECT from_addr, count(*) AS cnt FROM edges
      WHERE edge_type = 'informs'
      GROUP BY from_addr HAVING count(*) > 150
      ORDER BY count(*) DESC`;

    let hubEdgesPruned = 0;
    let hubEdgesProtected = 0;
    for (const hub of megaHubs) {
      // Keep top 150 by confidence, prune the rest
      const prunedRows = await sql`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY confidence DESC, id ASC) AS rn
          FROM edges WHERE from_addr = ${hub.from_addr} AND edge_type = 'informs'
        )
        SELECT id FROM ranked WHERE rn > 150`;
      const prunedProtection = await filterEdgeIdsBelowUsefulnessProtection(prunedRows.map((row: any) => row.id));
      hubEdgesProtected += prunedProtection.protectedCount;
      const pruned = await deleteEdgesByIds(sql as any, prunedProtection.edgeIds);
      hubEdgesPruned += pruned.deleted;
    }

    // 5h-inline: Reclassify legacy grounds edges on memory nodes → informs (PJ.0.3.907)
    // Memories anchor to function, function anchors to truth — no direct memory→truth grounds
    const memoryGroundRows = await sql`
      SELECT id FROM edges
      WHERE edge_type = 'grounds'
        AND (from_addr IN (SELECT addr FROM nodes WHERE node_type = 'memory')
          OR to_addr IN (SELECT addr FROM nodes WHERE node_type = 'memory'))`;
    const memoryGrounds = await rewriteEdgeTypeByIds(
      sql as any,
      memoryGroundRows.map((row: any) => row.id),
      "informs",
      { reason: "supercron_memory_grounds_reclassification" },
    );
    const memoryGroundsFixed = memoryGrounds.rewritten;

    // 5g: Wire orphan trend nodes → nearest FUNCTION/META node (makes trends discoverable)
    const orphanTrends = await sql`
      SELECT t.addr, t.embedding_hv
      FROM nodes t
      LEFT JOIN edges e ON e.from_addr = t.addr OR e.to_addr = t.addr
      WHERE t.node_type = 'trend' AND t.visibility = 'public'
        AND t.embedding_hv IS NOT NULL AND e.id IS NULL
      LIMIT 20`;

    let trendEdgesWired = 0;
    for (const trend of orphanTrends) {
      const [nearest] = await sql`
        SELECT addr, 1 - (embedding_hv::vector <=> ${trend.embedding_hv}::vector) AS sim
        FROM nodes
        WHERE pyramid_id = ANY(${TREND_WIRING_TARGET_LIST}::text[]) AND visibility = 'public'
          AND embedding_hv IS NOT NULL AND addr != ${trend.addr}
        ORDER BY embedding_hv::vector <=> ${trend.embedding_hv}::vector
        LIMIT 1`;
      if (!nearest || parseFloat(nearest.sim) < 0.45) continue;
      const inserted = await writeEdge(sql as any, {
        fromAddr: String(trend.addr),
        toAddr: String(nearest.addr),
        edgeType: "related_to",
        confidence: parseFloat(nearest.sim),
        layer: 1,
        provenance: { discovered_by: "supercron", created: new Date().toISOString() },
      });
      if (inserted.inserted) trendEdgesWired++;
    }

    const total = selfLoopCount + deadEdges.deleted + dupes.deleted
      + memoryEdgesWired + truthEdgesWired + memoryGroundsFixed + trendEdgesWired
      + edgesNormalized + hubEdgesPruned;
    return {
      actions: total,
      details: {
        self_loops_removed: selfLoopCount,
        dead_edges_removed: deadEdges.deleted,
        dupes_removed: dupes.deleted,
        edge_usefulness_protected_from_cleanup: deadEdgeProtection.protectedCount
          + dupeProtection.protectedCount
          + hubEdgesProtected,
        memory_edges_wired: memoryEdgesWired,
        truth_edges_wired: truthEdgesWired,
        memory_grounds_reclassified: memoryGroundsFixed,
        trend_edges_wired: trendEdgesWired,
        edge_types_normalized: edgesNormalized,
        hub_edges_pruned: hubEdgesPruned,
      },
    };
  });
}

interface EdgeUsefulnessCleanupPolicy {
  protectionFloor: number;
  flagCeiling: number;
  maxProposalsPerCycle: number;
}

function clampEdgeUsefulnessThreshold(value: unknown, fallback: number, key: string): number {
  if (value == null) return fallback;
  if (typeof value === "boolean") {
    console.warn(`[supercron-edge-usefulness] policy ${key} boolean value ${value} is invalid; defaulting to ${fallback}`);
    return fallback;
  }
  const raw = String(value).trim();
  if (!raw) {
    console.warn(`[supercron-edge-usefulness] policy ${key} is empty; defaulting to ${fallback}`);
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[supercron-edge-usefulness] policy ${key} value ${JSON.stringify(value)} is not numeric; defaulting to ${fallback}`);
    return fallback;
  }
  if (parsed < 0 || parsed > 1) {
    const clamped = Math.max(0, Math.min(1, parsed));
    console.warn(`[supercron-edge-usefulness] policy ${key} value ${parsed} out of range [0, 1]; clamping to ${clamped}`);
    return clamped;
  }
  return Math.max(0, Math.min(1, parsed));
}

function clampEdgeUsefulnessProposalCap(value: unknown): number {
  if (value == null) return EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE;
  if (typeof value === "boolean") {
    console.warn(`[supercron-edge-usefulness] policy edge_usefulness.max_proposals_per_cycle boolean value ${value} is invalid; defaulting to ${EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE}`);
    return EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE;
  }
  const raw = String(value).trim();
  if (!raw) {
    console.warn(`[supercron-edge-usefulness] policy edge_usefulness.max_proposals_per_cycle is empty; defaulting to ${EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE}`);
    return EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    console.warn(`[supercron-edge-usefulness] policy edge_usefulness.max_proposals_per_cycle value ${JSON.stringify(value)} is not an integer; defaulting to ${EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE}`);
    return EDGE_USEFULNESS_DEFAULT_MAX_PROPOSALS_PER_CYCLE;
  }
  if (parsed < 1 || parsed > EDGE_USEFULNESS_MAX_PROPOSALS_PER_CYCLE) {
    const clamped = Math.max(1, Math.min(parsed, EDGE_USEFULNESS_MAX_PROPOSALS_PER_CYCLE));
    console.warn(`[supercron-edge-usefulness] policy edge_usefulness.max_proposals_per_cycle value ${parsed} out of range [1, ${EDGE_USEFULNESS_MAX_PROPOSALS_PER_CYCLE}]; clamping to ${clamped}`);
    return clamped;
  }
  return Math.max(1, Math.min(parsed, EDGE_USEFULNESS_MAX_PROPOSALS_PER_CYCLE));
}

async function readEdgeUsefulnessCleanupPolicy(): Promise<EdgeUsefulnessCleanupPolicy> {
  const rows = await sql`
    SELECT key, value
    FROM graph_state
    WHERE key = ANY(${[
      "edge_usefulness.protection_floor",
      "edge_usefulness.flag_ceiling",
      "edge_usefulness.max_proposals_per_cycle",
    ]}::text[])`;
  const values = new Map(rows.map((row: any) => [String(row.key), row.value]));
  const protectionFloor = clampEdgeUsefulnessThreshold(
    values.get("edge_usefulness.protection_floor"),
    EDGE_USEFULNESS_DEFAULT_PROTECTION_FLOOR,
    "edge_usefulness.protection_floor",
  );
  const rawFlagCeiling = clampEdgeUsefulnessThreshold(
    values.get("edge_usefulness.flag_ceiling"),
    EDGE_USEFULNESS_DEFAULT_FLAG_CEILING,
    "edge_usefulness.flag_ceiling",
  );
  const flagCeiling = Math.min(rawFlagCeiling, protectionFloor);
  if (rawFlagCeiling > protectionFloor) {
    console.warn(`[supercron-edge-usefulness] policy edge_usefulness.flag_ceiling value ${rawFlagCeiling} exceeds protection floor ${protectionFloor}; clamping to ${flagCeiling}`);
  }
  return {
    protectionFloor,
    flagCeiling,
    maxProposalsPerCycle: clampEdgeUsefulnessProposalCap(values.get("edge_usefulness.max_proposals_per_cycle")),
  };
}

async function filterEdgeIdsBelowUsefulnessProtection(
  edgeIds: Array<number | string>,
): Promise<{ edgeIds: string[]; protectedCount: number }> {
  const ids = [...new Set(edgeIds.map((id) => String(id)).filter(Boolean))];
  if (ids.length === 0) return { edgeIds: [], protectedCount: 0 };

  const [installed] = await sql`
    SELECT to_regclass('edge_usefulness_scores') IS NOT NULL AS installed`;
  if (!installed?.installed) return { edgeIds: ids, protectedCount: 0 };

  const policy = await readEdgeUsefulnessCleanupPolicy();
  const rows = await sql`
    WITH requested AS (
      SELECT unnest(${ids}::bigint[]) AS id
    )
    SELECT
      requested.id::text AS id,
      (eus.score IS NOT NULL AND eus.score >= ${policy.protectionFloor}::numeric) AS protected
    FROM requested
    LEFT JOIN edge_usefulness_scores eus ON eus.edge_id = requested.id`;
  const protectedIds = new Set(
    rows
      .filter((row: any) => Boolean(row.protected))
      .map((row: any) => String(row.id)),
  );
  return {
    edgeIds: ids.filter((id) => !protectedIds.has(id)),
    protectedCount: protectedIds.size,
  };
}

async function proposeLowUsefulnessEdgeCleanup(config: SupercronConfig): Promise<number> {
  const [installed] = await sql`
    SELECT to_regclass('edge_usefulness_scores') IS NOT NULL AS installed`;
  if (!installed?.installed) return 0;

  const policy = await readEdgeUsefulnessCleanupPolicy();
  const pf = pyramidFilter(config);
  const pyramidWhere = pf
    ? sql`AND EXISTS (
        SELECT 1
        FROM nodes endpoint
        WHERE endpoint.pyramid_id = ${pf}
          AND endpoint.addr IN (e.from_addr, e.to_addr)
      )`
    : sql``;
  const [row] = await sql`
    WITH candidates AS (
      SELECT
        e.id,
        e.from_addr,
        e.to_addr,
        e.edge_type,
        e.space_id,
        eus.score,
        LEAST(0.99::real, (1.0 - eus.score)::real) AS cleanup_confidence,
        eus.components,
        eus.last_computed_at
      FROM edges e
      JOIN edge_usefulness_scores eus ON eus.edge_id = e.id
      WHERE eus.score IS NOT NULL
        AND eus.score < ${policy.flagCeiling}::numeric
        ${pyramidWhere}
        AND NOT EXISTS (
          SELECT 1
          FROM proposals existing
          WHERE existing.proposal_type = 'edge'
            AND existing.status IN ('pending', 'approved')
            AND existing.payload->>'action' = 'edge_usefulness_cleanup'
            AND existing.payload->>'edge_id' = e.id::text
        )
      ORDER BY eus.score ASC, eus.last_computed_at DESC, e.id ASC
      LIMIT ${policy.maxProposalsPerCycle}
    ),
    inserted AS (
      INSERT INTO proposals (
        proposal_type,
        from_addr,
        to_addr,
        target_addr,
        payload,
        confidence,
        discovered_by,
        evidence,
        status
      )
      SELECT
        'edge',
        from_addr,
        to_addr,
        NULL,
        jsonb_build_object(
          'action', 'edge_usefulness_cleanup',
          'mode', 'proposal_only',
          'edge_id', id,
          'from_addr', from_addr,
          'to_addr', to_addr,
          'edge_type', edge_type,
          'space_id', space_id,
          'score', score,
          'confidence', cleanup_confidence,
          'flag_ceiling', ${policy.flagCeiling}::numeric,
          'protection_floor', ${policy.protectionFloor}::numeric,
          'max_proposals_per_cycle', ${policy.maxProposalsPerCycle}::int,
          'requires_review', true,
          'evidence', jsonb_build_object(
            'source', 'edge_usefulness_scores',
            'score', score,
            'components', components,
            'last_computed_at', last_computed_at
          )
        ),
        cleanup_confidence,
        'supercron-edge-usefulness',
        jsonb_build_array(jsonb_build_object(
          'type', 'edge_usefulness_score',
          'source', 'edge_usefulness_scores',
          'score', score,
          'flag_ceiling', ${policy.flagCeiling}::numeric,
          'protection_floor', ${policy.protectionFloor}::numeric,
          'components', components,
          'cycle_number', ${config.cycleNumber ?? -1}::int,
          'timestamp', now()
        )),
        'pending'
      FROM candidates
      ON CONFLICT ((payload->>'edge_id'))
        WHERE proposal_type = 'edge'
          AND (payload->>'action') = 'edge_usefulness_cleanup'
          AND status IN ('pending', 'approved')
        DO NOTHING
      RETURNING id
    )
    SELECT count(*)::int AS proposed
    FROM inserted`;
  return Math.max(0, Number(row?.proposed || 0));
}

async function passEdgeUsefulnessCleanup(config: SupercronConfig): Promise<PassResult> {
  return runPass("edge_usefulness_cleanup", async () => {
    const [installed] = await sql`
      SELECT to_regclass('edge_usefulness_scores') IS NOT NULL AS installed`;
    if (!installed?.installed) {
      return {
        actions: 0,
        skipped: true,
        llm_tokens_in: null,
        llm_tokens_out: null,
        llm_cost_usd_micro: null,
        proposals_created: 0,
        proposals_applied: 0,
        details: { reason: "edge_usefulness_schema_missing" },
      };
    }

    if (config.dryRun) {
      return {
        actions: 0,
        llm_tokens_in: null,
        llm_tokens_out: null,
        llm_cost_usd_micro: null,
        proposals_created: 0,
        proposals_applied: 0,
        details: { dry_run: true },
      };
    }

    const proposed = await proposeLowUsefulnessEdgeCleanup(config);
    return {
      actions: proposed,
      llm_tokens_in: null,
      llm_tokens_out: null,
      llm_cost_usd_micro: null,
      proposals_created: 0,
      proposals_applied: 0,
      details: {
        edge_usefulness_cleanup_proposals: proposed,
        proposals_created_not_counted_for_cooldown: true,
        source: "edge_usefulness_scores",
      },
    };
  });
}

// ============================================================
// TIER 2 — BOUNDED PASSES (SQL + vector, max 50 items)
// ============================================================

// Pass PR13-A: deterministic edge usefulness scoring sidecar.
function edgeUsefulnessTelemetryFields(): Pick<
  PassResult,
  "llm_tokens_in" | "llm_tokens_out" | "llm_cost_usd_micro" | "proposals_created" | "proposals_applied"
> {
  return {
    llm_tokens_in: null,
    llm_tokens_out: null,
    llm_cost_usd_micro: null,
    proposals_created: 0,
    proposals_applied: 0,
  };
}

function clampEdgeUsefulnessWindowDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return EDGE_USEFULNESS_DEFAULT_WINDOW_DAYS;
  return Math.max(EDGE_USEFULNESS_MIN_WINDOW_DAYS, Math.min(parsed, EDGE_USEFULNESS_MAX_WINDOW_DAYS));
}

async function readEdgeUsefulnessWindowDays(): Promise<number> {
  const [row] = await sql`
    SELECT value
    FROM graph_state
    WHERE key = 'supercron.edge_usefulness_window_days'`;
  return clampEdgeUsefulnessWindowDays(row?.value);
}

async function shouldRunEdgeUsefulnessScoring(): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM edges e
      WHERE NOT EXISTS (
        SELECT 1
        FROM edge_usefulness_scores s
        WHERE s.edge_id = e.id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM edge_usefulness_scores s
      WHERE s.last_computed_at < now() - ${EDGE_USEFULNESS_SCORING_INTERVAL_HOURS} * interval '1 hour'
    ) AS due`;
  return Boolean(row?.due);
}

async function passEdgeUsefulnessScoring(config: SupercronConfig): Promise<PassResult> {
  return runPass("edge_usefulness_scoring", async () => {
    const [installed] = await sql`
      SELECT
        to_regclass('edge_usefulness_scores') IS NOT NULL
        AND to_regprocedure('recompute_edge_usefulness_scores(integer,interval)') IS NOT NULL AS installed`;
    if (!installed?.installed) {
      return {
        actions: 0,
        skipped: true,
        ...edgeUsefulnessTelemetryFields(),
        details: { reason: "edge_usefulness_schema_missing" },
      };
    }

    if (!(await shouldRunEdgeUsefulnessScoring())) {
      return {
        actions: 0,
        skipped: true,
        ...edgeUsefulnessTelemetryFields(),
        details: { reason: "not_due" },
      };
    }

    if (config.dryRun) {
      return {
        actions: 0,
        ...edgeUsefulnessTelemetryFields(),
        details: { dry_run: true },
      };
    }

    const windowDays = await readEdgeUsefulnessWindowDays();
    const [row] = await sql`
      SELECT recompute_edge_usefulness_scores(${EDGE_USEFULNESS_SCORING_BATCH_LIMIT}, ${windowDays} * interval '1 day')::int AS scored`;
    const scored = Math.max(0, Number(row?.scored || 0));
    return {
      actions: scored,
      ...edgeUsefulnessTelemetryFields(),
      details: {
        scored_edges: scored,
        batch_limit: EDGE_USEFULNESS_SCORING_BATCH_LIMIT,
        window_days: windowDays,
        source: "edge_usefulness_scores",
      },
    };
  });
}

// Pass 5f: Truth Edge Refresh (every 5th cycle)
async function pass5fTruthRefresh(config: SupercronConfig): Promise<PassResult> {
  if (config.cycleNumber % 5 !== 0) return { ...skip("not_due"), name: "truth_refresh" };

  return runPass("truth_refresh", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };
    const pf = pyramidFilter(config);

    // For nodes with existing truth edges: check if a better match exists
    // Skip nodes already audited by Opus (/truth skill)
    const pyramidWhere = pf ? sql`AND n.pyramid_id = ${pf}` : sql``;
    const existing = await sql`
      SELECT e.id AS edge_id, e.from_addr AS truth_addr, e.to_addr AS target_addr,
        e.confidence AS current_conf, n.embedding_hv AS target_emb
      FROM edges e
      JOIN nodes n ON n.addr = e.to_addr
      WHERE e.edge_type = 'grounds' AND e.provenance->>'discovered_by' = 'supercron'
        AND n.embedding_hv IS NOT NULL
        AND n.pyramid_id <> ALL(${TRUTH_PYRAMID_LIST}::text[])
        AND COALESCE(n.source_context->>'truth_audited', '') = ''
        AND NOT EXISTS (
          SELECT 1 FROM edges opus_e
          WHERE (opus_e.to_addr = e.to_addr OR opus_e.from_addr = e.to_addr)
            AND opus_e.provenance->>'agent' IN ('vo-truth-opus', 'vo-resonance-opus', 'vo-harvester-opus-qc', 'vo-resonance-opus-qc')
        )
        ${pyramidWhere}
      LIMIT 100`;

    let replaced = 0;
    for (const row of existing) {
      const [best] = await sql`
        SELECT addr, 1 - (embedding_hv::vector <=> ${row.target_emb}::vector) AS sim
        FROM nodes
        WHERE pyramid_id = ANY(${TRUTH_PYRAMID_LIST}::text[]) AND visibility = 'public'
          AND embedding_hv IS NOT NULL AND addr != ${row.truth_addr}
        ORDER BY embedding_hv::vector <=> ${row.target_emb}::vector
        LIMIT 1`;

      if (!best || parseFloat(best.sim) < parseFloat(row.current_conf) + 0.10) continue;

      const [edge] = await sql`
        SELECT edge_type, layer, label, weight, bidirectional, provenance, source_context,
          space_id, from_space_id, to_space_id
        FROM edges
        WHERE id = ${row.edge_id}`;
      if (!edge) continue;
      await deleteEdgesByIds(sql as any, [row.edge_id]);
      await writeEdge(sql as any, {
        fromAddr: String(best.addr),
        toAddr: String(row.target_addr),
        edgeType: String(edge.edge_type),
        layer: Number(edge.layer ?? 1),
        label: edge.label == null ? null : String(edge.label),
        confidence: parseFloat(best.sim),
        weight: Number(edge.weight ?? 1),
        bidirectional: Boolean(edge.bidirectional),
        provenance: typeof edge.provenance === "object" && edge.provenance ? edge.provenance as Record<string, unknown> : {},
        sourceContext: typeof edge.source_context === "object" && edge.source_context ? edge.source_context as Record<string, unknown> : {},
        spaceId: String(edge.space_id || "global"),
        fromSpaceId: String(edge.from_space_id || edge.space_id || "global"),
        toSpaceId: String(edge.to_space_id || edge.space_id || "global"),
      });
      replaced++;
    }

    return { actions: replaced, details: { checked: existing.length, replaced } };
  });
}

// Pass 5h: Stimulus Energy Decay — apply half-life decay to all stimuli and
// dissolve orphans whose energy has dropped below threshold.
async function pass5hStimulusDecay(config: SupercronConfig): Promise<PassResult> {
  return runPass("stimulus_decay", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // 1. Apply energy decay across all stimuli
    const [decayResult] = await sql`SELECT decay_wi_stimulus_energy() AS cleaned`;
    const cleaned = parseInt(decayResult.cleaned) || 0;

    // 2. Dissolve throbbing orphans whose energy has decayed below promotion threshold
    const [dissolved] = await sql`
      WITH dissolved AS (
        UPDATE stimuli
        SET orphan_status = 'dissolved', is_orphan = false
        WHERE is_orphan = true AND orphan_status = 'throbbing'
          AND energy < 0.01
        RETURNING id
      ) SELECT count(*) AS cnt FROM dissolved`;
    const dissolvedCount = parseInt(dissolved.cnt) || 0;

    // 3. Dissolve ephemeral orphans past TTL (8h default)
    const [ephemeralTtl] = await sql`SELECT value FROM graph_state WHERE key = 'trend_orphan_ttl_ephemeral_hours'`;
    const ephTtlHours = parseFloat(ephemeralTtl?.value || "8");
    const [ephDissolved] = await sql`
      WITH dissolved AS (
        UPDATE stimuli
        SET orphan_status = 'dissolved', is_orphan = false
        WHERE is_orphan = true AND orphan_status = 'throbbing'
          AND temporality = 'EPHEMERAL'
          AND created_at < NOW() - (${ephTtlHours} || ' hours')::INTERVAL
        RETURNING id
      ) SELECT count(*) AS cnt FROM dissolved`;
    const ephDissolvedCount = parseInt(ephDissolved.cnt) || 0;

    const total = cleaned + dissolvedCount + ephDissolvedCount;
    return {
      actions: total,
      details: { spent_deleted: cleaned, orphans_dissolved: dissolvedCount, ephemeral_dissolved: ephDissolvedCount },
    };
  });
}

// Pass 5i: Federation Activity Retention (rung 7b)
// Deletes federation_activity rows older than the install-wide retention
// window (default 30d, clamped to [30, 180] per rung-6 policy).
// Feature-flagged via VERITY_FEDERATION_ACTIVITY_RETENTION=off.
async function pass5iFederationActivityRetention(config: SupercronConfig): Promise<PassResult> {
  return runPass("federation_activity_retention", async () => {
    const { runFederationActivityRetention } = await import(
      "../../api/src/lib/federation-activity-retention"
    );
    const result = await runFederationActivityRetention(sql as any, {
      dryRun: config.dryRun,
    });
    return {
      actions: result.deleted,
      details: {
        deleted: result.deleted,
        retention_days: result.retention_days,
        dry_run: result.dry_run,
        disabled: result.disabled,
      },
    };
  });
}

// Rung-6 vault soft-tombstone pass. Walks the local vault and tombstones
// (status:"deleted") vault_file source_refs whose dossier file is gone — the
// node STAYS. Install-wide gated by graph_state `vault_tombstone_pass_enabled`
// (default TRUE / opt-out, unlike the node-GC default-off booleans). T1:
// deterministic, filesystem-only, no LLM budget.
const VAULT_TOMBSTONE_PASS_ENABLED_KEY = "vault_tombstone_pass_enabled";

async function readVaultTombstonePassEnabled(sqlTag: typeof sql): Promise<boolean> {
  try {
    const [row] = await sqlTag`
      SELECT value FROM graph_state WHERE key = ${VAULT_TOMBSTONE_PASS_ENABLED_KEY}
    `;
    if (!row || row.value == null) return true; // key absent → default true (Rung-6 spec)
    const v = String(row.value).trim().toLowerCase();
    return v !== "false" && v !== "0" && v !== "off"; // only an explicit falsey value disables
  } catch (err: any) {
    if (err?.code === "42P01") return true; // fresh install, no graph_state table yet
    throw err; // a real connectivity/permission error must not silently default
  }
}

async function passVaultTombstone(config: SupercronConfig): Promise<PassResult> {
  return runPass("vault_tombstone", async () => {
    const enabled = await readVaultTombstonePassEnabled(sql);
    if (!enabled) {
      return { actions: 0, details: { disabled: true, reason: "vault_tombstone_pass_enabled=false" } };
    }
    const { runVaultTombstonePass } = await import("./vault-tombstone-pass");
    const r = await runVaultTombstonePass(sql as any, config.cycleTenantId, {
      dryRun: config.dryRun,
      enabled: true,
    });
    return {
      actions: r.tombstoned,
      details: {
        tombstoned: r.tombstoned,
        nodes_scanned: r.nodesScanned,
        refs_checked: r.refsChecked,
        missing_files: r.missingFiles,
        disabled: r.disabled,
        skipped_reason: r.skippedReason ?? null,
        dry_run: r.dryRun,
      },
    };
  });
}

// Rung-11a: connector OAuth grant retention. Mirrors the
// rung-7b federation-activity-retention shape. Status-flips
// expired/inactive grants (NEVER deletes — historical rows
// remain in the audit/export trail) + prunes consumed/expired
// authorization-request rows older than 24h. T1 placement is
// correct because the pass is deterministic SQL and TTLs are
// day-scale; per-request 1h access-token expiry is enforced
// synchronously by the resolver, not by supercron.
async function pass5jConnectorGrantRetention(config: SupercronConfig): Promise<PassResult> {
  return runPass("connector_grant_retention", async () => {
    if (process.env.VERITY_OAUTH_GRANT_RETENTION === "off") {
      return { actions: 0, details: { disabled: true } };
    }
    const { runConnectorGrantRetention } = await import(
      "../../api/src/lib/oauth-grant"
    );
    const result = await runConnectorGrantRetention(sql as any, {
      dryRun: config.dryRun,
    });
    return {
      actions: result.expired_grants,
      details: {
        oauth_grants_expired: result.expired_grants,
        expired_grants: result.expired_grants,
        pruned_authorization_requests: result.pruned_authorization_requests,
        families_touched: result.families_touched,
        revoked_grants_seen: result.revoked_grants_seen,
        active_grants_seen: result.active_grants_seen,
        dry_run: config.dryRun,
      },
    };
  });
}

// Connector OAuth DCR client retention. Status-flips public registration rows
// through their lifecycle (active -> dormant after OAUTH_CLIENT_DORMANT_AFTER_DAYS
// unused with no active grants -> archived after OAUTH_CLIENT_ARCHIVE_AFTER_DAYS
// dormant) and NEVER deletes them, so the forensic registration record survives.
// Runs AFTER grant retention (5j) so freshly-expired grants are visible to the
// no-active-grant guard.
async function pass5kOauthClientRetention(config: SupercronConfig): Promise<PassResult> {
  return runPass("oauth_client_retention", async () => {
    const { runOauthClientRetention } = await import(
      "../../api/src/lib/oauth-client-retention"
    );
    const result = await runOauthClientRetention(sql as any, {
      dryRun: config.dryRun,
    });
    return {
      actions: result.dormant_clients + result.archived_clients,
      details: {
        oauth_clients_dormant: result.dormant_clients,
        oauth_clients_archived: result.archived_clients,
        dormant_after_days: result.dormant_after_days,
        archive_after_days: result.archive_after_days,
        batch_size: result.batch_size,
        dry_run: result.dry_run,
        disabled: result.disabled,
      },
    };
  });
}

// Marks long-dormant, edge-free tenant memories as operator-reviewable GC
// candidates. This rung is intentionally non-destructive: no node deletes.
async function passNodeGcCandidates(config: SupercronConfig): Promise<PassResult> {
  return runPass("node_gc_candidates", async () => {
    const tenantSpaceId = `tenant:${config.cycleTenantId}`;
    const batchId = randomUUID();
    const nodeGc = config.policy.nodeGc;
    const dormantDays = nodeGc.dormantDays;
    const perCycleCap = nodeGc.perCycleCap;
    const maxActive = nodeGc.maxActiveCandidates;

    const assertTenantSpaceKind = async (tx: any) => {
      const [tenantSpaceRow] = await tx`
        SELECT kind, tenant_id FROM graph_spaces
        WHERE space_id = ${tenantSpaceId}
        LIMIT 1
      `;
      const foundKind = tenantSpaceRow?.kind == null ? null : String(tenantSpaceRow.kind);
      const foundTenantId = tenantSpaceRow?.tenant_id == null ? null : String(tenantSpaceRow.tenant_id);
      const tenantSpaceMismatch = foundKind !== "tenant"
        ? foundKind ?? "missing"
        : foundTenantId === config.cycleTenantId
          ? null
          : "tenant_id_mismatch";
      if (tenantSpaceMismatch) {
        throw new Error(
          `tenant_space_kind_mismatch:${config.cycleTenantId}:${tenantSpaceMismatch}`,
        );
      }
    };

    const readActiveCount = async (tx: any): Promise<number> => {
      const [activeRow] = await tx`
        SELECT count(*)::int AS active_count
        FROM supercron_node_gc_receipts
        WHERE tenant_id = ${config.cycleTenantId}
          AND status IN ('candidate', 'approved')
          AND predicate_version >= ${SUPERCRON_NODE_GC_PREDICATE_VERSION}
      `;
      return Number(activeRow?.active_count || 0);
    };

    const readStaleActivePredicateReceiptCount = async (tx: any): Promise<number> => {
      const [staleRow] = await tx`
        SELECT count(*)::int AS stale_count
        FROM supercron_node_gc_receipts
        WHERE tenant_id = ${config.cycleTenantId}
          AND status IN ('candidate', 'approved')
          AND predicate_version < ${SUPERCRON_NODE_GC_PREDICATE_VERSION}
      `;
      return Number(staleRow?.stale_count || 0);
    };

    const expireStaleActivePredicateReceipts = async (tx: any): Promise<number> => {
      const expiredRows = await tx`
        UPDATE supercron_node_gc_receipts
        SET
          status = 'expired',
          expires_at = COALESCE(expires_at, now()),
          rejection_reason = COALESCE(rejection_reason, 'predicate_version_superseded'),
          updated_at = now(),
          eligibility = COALESCE(eligibility, '{}'::jsonb) || jsonb_build_object(
            'expired_reason', 'predicate_version_superseded',
            'superseded_by_predicate_version', ${SUPERCRON_NODE_GC_PREDICATE_VERSION}::int
          )
        WHERE tenant_id = ${config.cycleTenantId}
          AND status IN ('candidate', 'approved')
          AND predicate_version < ${SUPERCRON_NODE_GC_PREDICATE_VERSION}
        RETURNING addr
      `;
      return expiredRows.length;
    };

    const countEligibleCandidates = async (tx: any, nodeGc: ResolvedTenantPolicy["nodeGc"]): Promise<number> => {
      const [eligibleRow] = await tx`
        SELECT count(*)::int AS eligible_count
        FROM nodes n
        JOIN memory_registry mr
          ON mr.addr = n.addr
          AND mr.tenant_id = ${config.cycleTenantId}
        WHERE n.node_type = 'memory'
          AND n.space_id = ${tenantSpaceId}
          AND n.visibility <> 'deleted'
          AND n.dormant_at IS NOT NULL
          AND n.dormant_at < now() - (${nodeGc.dormantDays}::text || ' days')::interval
          AND (n.query_hits IS NULL OR n.query_hits = 0)
          AND (
            n.last_queried IS NULL
            OR n.last_queried < now() - (${SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS}::text || ' days')::interval
          )
          AND COALESCE(n.pinned, false) = false
          AND COALESCE(n.substance->>'maturity_stage', '') <> ALL(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[])
          -- Missing or NULL registry lifecycle is unknown, not garbage.
          -- Active-registry dormant drift is repaired by lifecycle health work, not GC.
          AND mr.status = ANY(${GC_SAFE_LIFECYCLE_STATES}::text[])
          AND COALESCE(mr.accepted_by_user, false) = false
          AND COALESCE(mr.source_kind, '') <> 'user_accepted'
          AND COALESCE(mr.kind, '') <> ALL(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM edges e
            WHERE e.from_addr = n.addr OR e.to_addr = n.addr
          )
          AND NOT EXISTS (
            SELECT 1
            FROM supercron_node_gc_receipts r
            WHERE r.tenant_id = ${config.cycleTenantId}
              AND r.addr = n.addr
              AND (
                (r.status IN ('candidate', 'approved') AND r.predicate_version >= ${SUPERCRON_NODE_GC_PREDICATE_VERSION})
                OR (r.status = 'rejected' AND r.expires_at IS NOT NULL AND r.expires_at > now())
              )
          )
      `;
      return Number(eligibleRow?.eligible_count || 0);
    };

    const auditNodeGc = async (tx: any, operation: string, eventData: Record<string, unknown>) => {
      await auditMutationFromWorker(tx as any, {
        kind: "admin_action",
        tenantId: config.cycleTenantId,
        actor: "supercron_daemon:node_gc_candidates",
        actorKind: "operator_token",
        operation,
        eventData: {
          ...eventData,
          ...nodeGcEligibilityTelemetry(),
          predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
        },
      }, { durability: "required" });
    };

    if (config.dryRun) {
      await assertTenantSpaceKind(sql);
      const activeCount = await readActiveCount(sql);
      const staleActivePredicateReceipts = await readStaleActivePredicateReceiptCount(sql);
      const activeRegistryDormantDriftCount = await countActiveRegistryDormantNodes(
        sql,
        config.cycleTenantId,
        tenantSpaceId,
      );
      const remainingCap = activeCount >= maxActive
        ? 0
        : Math.min(perCycleCap, maxActive - activeCount);
      const eligibleCount = await countEligibleCandidates(sql, nodeGc);

      return {
        actions: 0,
        details: {
          dry_run: true,
          enabled: nodeGc.candidateEnabled,
          disabled: !nodeGc.candidateEnabled,
          paused: activeCount >= maxActive,
          ...(activeCount >= maxActive ? { reason: "max_active_candidates_reached" } : {}),
          active_count_before: activeCount,
          active_registry_dormant_drift_count: activeRegistryDormantDriftCount,
          stale_active_predicate_receipts: staleActivePredicateReceipts,
          eligible_count: eligibleCount,
          would_mark_this_run: Math.min(eligibleCount, remainingCap),
          remaining_cap: remainingCap,
          dormant_days_threshold: dormantDays,
          last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
          per_cycle_cap: perCycleCap,
          max_active_candidates: maxActive,
          ...nodeGcEligibilityTelemetry(),
          destructive_actions: 0,
        },
      };
    }

    const marked = await sql.begin(async (tx: any) => {
      // Advisory lock namespace 0x564f4609 is shared with reset-managed
      // migrations. Runtime node GC uses the second slot as the tenant hash;
      // fixed IDs currently include 0x50524f50 ('PROP') and 0x4e474331 ('NGC1').
      await tx`SELECT pg_advisory_xact_lock(0x564f4609, hashtext(${"node_gc:" + config.cycleTenantId}))`;

      await assertTenantSpaceKind(tx);
      const expiredStaleReceipts = await expireStaleActivePredicateReceipts(tx);
      const activeRegistryDormantDriftCount = await countActiveRegistryDormantNodes(
        tx,
        config.cycleTenantId,
        tenantSpaceId,
      );
      if (expiredStaleReceipts > 0) {
        await auditNodeGc(tx, "supercron_node_gc_candidates_stale_predicate_expired", {
          reason: "predicate_version_superseded",
          expired_stale_receipts: expiredStaleReceipts,
          superseded_by_predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
        });
      }
      if (activeRegistryDormantDriftCount > 0) {
        await auditNodeGc(tx, "supercron_node_gc_lifecycle_drift_observed", {
          reason: "active_registry_dormant_nodes_are_lifecycle_repair_work",
          active_registry_dormant_count: activeRegistryDormantDriftCount,
          tenant_id: config.cycleTenantId,
          predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
        });
      }

      if (!nodeGc.candidateEnabled) {
        return {
          disabled: true,
          nodeGc,
          paused: false,
          reason: "disabled",
          activeCount: 0,
          remainingCap: 0,
          eligibleCount: 0,
          expiredStaleReceipts,
          activeRegistryDormantDriftCount,
          selectedCount: 0,
          insertedCount: 0,
          markedAddrs: [] as string[],
        };
      }

      const activeCount = await readActiveCount(tx);
      if (activeCount >= maxActive) {
        await auditNodeGc(tx, "supercron_node_gc_candidates_paused", {
          reason: "max_active_candidates_reached",
          active_count: activeCount,
          active_count_before: activeCount,
          per_cycle_cap: perCycleCap,
          max_active_candidates: maxActive,
          remaining_cap: 0,
        });
        return {
          disabled: false,
          nodeGc,
          paused: true,
          reason: "max_active_candidates_reached",
          activeCount,
          remainingCap: 0,
          eligibleCount: 0,
          expiredStaleReceipts,
          activeRegistryDormantDriftCount,
          markedAddrs: [] as string[],
        };
      }

      const remainingCap = Math.min(perCycleCap, maxActive - activeCount);
      const eligibleCount = await countEligibleCandidates(tx, nodeGc);

      const candidates = await tx`
        SELECT
          n.addr,
          n.dormant_at,
          n.query_hits,
          n.last_queried,
          n.node_type,
          n.visibility,
          COALESCE(n.substance->>'maturity_stage', '') AS maturity_stage,
          mr.kind AS registry_kind,
          mr.source_kind AS registry_source_kind,
          mr.accepted_by_user AS registry_accepted_by_user,
          mr.status AS registry_status
        FROM nodes n
        JOIN memory_registry mr
          ON mr.addr = n.addr
          AND mr.tenant_id = ${config.cycleTenantId}
        WHERE n.node_type = 'memory'
          AND n.space_id = ${tenantSpaceId}
          AND n.visibility <> 'deleted'
          AND n.dormant_at IS NOT NULL
          AND n.dormant_at < now() - (${dormantDays}::text || ' days')::interval
          AND (n.query_hits IS NULL OR n.query_hits = 0)
          AND (
            n.last_queried IS NULL
            OR n.last_queried < now() - (${SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS}::text || ' days')::interval
          )
          AND COALESCE(n.pinned, false) = false
          AND COALESCE(n.substance->>'maturity_stage', '') <> ALL(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[])
          -- Missing or NULL registry lifecycle is unknown, not garbage.
          -- Active-registry dormant drift is repaired by lifecycle health work, not GC.
          AND mr.status = ANY(${GC_SAFE_LIFECYCLE_STATES}::text[])
          AND COALESCE(mr.accepted_by_user, false) = false
          AND COALESCE(mr.source_kind, '') <> 'user_accepted'
          AND COALESCE(mr.kind, '') <> ALL(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM edges e
            WHERE e.from_addr = n.addr OR e.to_addr = n.addr
          )
          AND NOT EXISTS (
            SELECT 1
            FROM supercron_node_gc_receipts r
            WHERE r.tenant_id = ${config.cycleTenantId}
              AND r.addr = n.addr
              AND (
                (r.status IN ('candidate', 'approved') AND r.predicate_version >= ${SUPERCRON_NODE_GC_PREDICATE_VERSION})
                OR (r.status = 'rejected' AND r.expires_at IS NOT NULL AND r.expires_at > now())
              )
          )
        ORDER BY n.dormant_at ASC
        LIMIT ${remainingCap}
        FOR UPDATE OF n SKIP LOCKED
      `;

      if (candidates.length === 0) {
        await auditNodeGc(tx, "supercron_node_gc_candidates_no_eligible", {
          reason: "no_eligible_candidates",
          active_count: activeCount,
          active_count_before: activeCount,
          dormant_days: dormantDays,
          per_cycle_cap: perCycleCap,
          remaining_cap: remainingCap,
          candidates_eligible: eligibleCount,
          candidates_selected: 0,
          candidates_inserted: 0,
          stale_active_predicate_receipts_expired: expiredStaleReceipts,
        });
        return {
          disabled: false,
          nodeGc,
          paused: false,
          reason: "no_eligible_candidates",
          activeCount,
          remainingCap,
          eligibleCount,
          expiredStaleReceipts,
          activeRegistryDormantDriftCount,
          selectedCount: 0,
          insertedCount: 0,
          markedAddrs: [] as string[],
        };
      }

      const receiptRows = (candidates as any[]).map((candidate) => ({
        batch_id: batchId,
        tenant_id: config.cycleTenantId,
        tenant_space_id: tenantSpaceId,
        addr: String(candidate.addr),
        predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
        eligibility: {
          predicate_version: SUPERCRON_NODE_GC_PREDICATE_VERSION,
          ...nodeGcEligibilityTelemetry(),
          dormant_days_threshold: dormantDays,
          last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
          per_cycle_cap: perCycleCap,
          remaining_cap_at_mark: remainingCap,
          max_active_candidates: maxActive,
          active_count_before: activeCount,
          rejection_cooldown_days: nodeGc.rejectionCooldownDays,
          dormant_at: candidate.dormant_at,
          query_hits: candidate.query_hits == null ? null : Number(candidate.query_hits),
          last_queried: candidate.last_queried ?? null,
          maturity_stage: candidate.maturity_stage || null,
          registry_kind: candidate.registry_kind || null,
          registry_source_kind: candidate.registry_source_kind || null,
          registry_accepted_by_user: candidate.registry_accepted_by_user ?? null,
          registry_status: candidate.registry_status || null,
        },
      }));

      const inserted = await tx`
        INSERT INTO supercron_node_gc_receipts (
          batch_id,
          tenant_id,
          tenant_space_id,
          addr,
          predicate_version,
          eligibility
        )
        SELECT
          r.batch_id::uuid,
          r.tenant_id,
          r.tenant_space_id,
          r.addr,
          r.predicate_version::int,
          r.eligibility::jsonb
        FROM jsonb_to_recordset(${tx.json(receiptRows)}::jsonb)
          AS r(
            batch_id text,
            tenant_id text,
            tenant_space_id text,
            addr text,
            predicate_version int,
            eligibility jsonb
          )
        ON CONFLICT DO NOTHING
        RETURNING addr
      `;

      await auditNodeGc(tx, "supercron_node_gc_candidates_marked", {
        batch_id: batchId,
        candidates_eligible: eligibleCount,
        candidates_selected: candidates.length,
        candidates_inserted: inserted.length,
        dormant_days: dormantDays,
        per_cycle_cap: perCycleCap,
        remaining_cap: remainingCap,
        active_count_before: activeCount,
        stale_active_predicate_receipts_expired: expiredStaleReceipts,
      });

      return {
        disabled: false,
        nodeGc,
        paused: false,
        reason: null as string | null,
        activeCount,
        remainingCap,
        eligibleCount,
        expiredStaleReceipts,
        activeRegistryDormantDriftCount,
        selectedCount: candidates.length,
        insertedCount: inserted.length,
        markedAddrs: (inserted as Array<{ addr: unknown }>).map((row) => String(row.addr)),
      };
    });

    if (marked.disabled) {
      return {
        actions: 0,
        details: {
          disabled: true,
          dormant_days_threshold: marked.nodeGc.dormantDays,
          last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
          per_cycle_cap: marked.nodeGc.perCycleCap,
          max_active_candidates: marked.nodeGc.maxActiveCandidates,
          active_registry_dormant_drift_count: marked.activeRegistryDormantDriftCount,
          stale_active_predicate_receipts_expired: marked.expiredStaleReceipts,
          ...nodeGcEligibilityTelemetry(),
          destructive_actions: 0,
        },
      };
    }

    if (marked.paused) {
      return {
        actions: 0,
        details: {
          paused: true,
          reason: marked.reason,
          active_count: marked.activeCount,
          active_count_before: marked.activeCount,
          active_registry_dormant_drift_count: marked.activeRegistryDormantDriftCount,
          dormant_days_threshold: marked.nodeGc.dormantDays,
          last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
          per_cycle_cap: marked.nodeGc.perCycleCap,
          max_active_candidates: marked.nodeGc.maxActiveCandidates,
          remaining_cap: marked.remainingCap,
          stale_active_predicate_receipts_expired: marked.expiredStaleReceipts,
          ...nodeGcEligibilityTelemetry(),
          destructive_actions: 0,
        },
      };
    }

    return {
      actions: marked.markedAddrs.length,
      details: {
        batch_id: batchId,
        marked_count: marked.markedAddrs.length,
        eligible_count: marked.eligibleCount,
        selected_count: marked.selectedCount,
        inserted_count: marked.insertedCount,
        remaining_cap: marked.remainingCap,
        ...(marked.reason ? { reason: marked.reason } : {}),
        dormant_days_threshold: marked.nodeGc.dormantDays,
        last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
        per_cycle_cap: marked.nodeGc.perCycleCap,
        max_active_candidates: marked.nodeGc.maxActiveCandidates,
        active_count_before: marked.activeCount,
        active_registry_dormant_drift_count: marked.activeRegistryDormantDriftCount,
        stale_active_predicate_receipts_expired: marked.expiredStaleReceipts,
        ...nodeGcEligibilityTelemetry(),
        destructive_actions: 0,
      },
    };
  });
}

// Applies operator-approved node-GC receipts by replaying the current
// eligibility predicate, then tombstoning or deleting only rows that still pass.
async function passNodeGcApply(config: SupercronConfig): Promise<PassResult> {
  return runPass("node_gc_apply", async () => {
    const tenantSpaceId = `tenant:${config.cycleTenantId}`;
    const nodeGc = config.policy.nodeGc;
    const settings = {
      supercron_node_gc_apply_enabled: nodeGc.applyEnabled,
      supercron_node_gc_apply_action: nodeGc.applyAction,
      supercron_node_gc_apply_per_cycle_cap: nodeGc.applyPerCycleCap,
    };
    const action = settings.supercron_node_gc_apply_action;
    const perCycleCap = settings.supercron_node_gc_apply_per_cycle_cap;

    const resolveReceiptApplyAction = (receipt: { eligibility: unknown }): NodeGcApplyAction => {
      return resolveNodeGcReceiptApplyAction(receipt.eligibility, settings.supercron_node_gc_apply_action);
    };

    const assertTenantSpaceKind = async (tx: any) => {
      const [tenantSpaceRow] = await tx`
        SELECT kind, tenant_id FROM graph_spaces
        WHERE space_id = ${tenantSpaceId}
        LIMIT 1
      `;
      const foundKind = tenantSpaceRow?.kind == null ? null : String(tenantSpaceRow.kind);
      const foundTenantId = tenantSpaceRow?.tenant_id == null ? null : String(tenantSpaceRow.tenant_id);
      const tenantSpaceMismatch = foundKind !== "tenant"
        ? foundKind ?? "missing"
        : foundTenantId === config.cycleTenantId
          ? null
          : "tenant_id_mismatch";
      if (tenantSpaceMismatch) {
        throw new Error(
          `tenant_space_kind_mismatch:${config.cycleTenantId}:${tenantSpaceMismatch}`,
        );
      }
    };

    const readApprovedCount = async (tx: any): Promise<number> => {
      const [row] = await tx`
        SELECT count(*)::int AS approved_count
        FROM supercron_node_gc_receipts
        WHERE tenant_id = ${config.cycleTenantId}
          AND status = 'approved'
          AND predicate_version = ${SUPERCRON_NODE_GC_PREDICATE_VERSION}
      `;
      return Number(row?.approved_count || 0);
    };

    type ApplyReceiptRow = {
      id: unknown;
      batch_id: unknown;
      addr: unknown;
      eligibility: unknown;
      predicate_version: unknown;
      reviewed_by: unknown;
      reviewed_at: unknown;
    };

    const readApprovedReceiptsForApply = async (tx: any, lockForApply: boolean): Promise<ApplyReceiptRow[]> => {
      const lockClause = lockForApply ? tx`FOR UPDATE OF supercron_node_gc_receipts SKIP LOCKED` : tx``;
      const receipts = await tx`
        SELECT
          id,
          batch_id,
          addr,
          eligibility,
          predicate_version,
          reviewed_by,
          reviewed_at
        FROM supercron_node_gc_receipts
        WHERE tenant_id = ${config.cycleTenantId}
          AND status = 'approved'
          AND predicate_version = ${SUPERCRON_NODE_GC_PREDICATE_VERSION}
        ORDER BY reviewed_at ASC NULLS LAST, marked_at ASC, id ASC
        LIMIT ${perCycleCap}
        ${lockClause}
      `;
      return receipts as ApplyReceiptRow[];
    };

    const auditNodeGcApply = async (tx: any, operation: string, eventData: Record<string, unknown>) => {
      const eventPredicateVersion = Number(eventData.predicate_version);
      const predicateVersion = Number.isFinite(eventPredicateVersion)
        ? eventPredicateVersion
        : SUPERCRON_NODE_GC_PREDICATE_VERSION;
      const eventApplyAction = isNodeGcApplyAction(eventData.apply_action)
        ? eventData.apply_action
        : settings.supercron_node_gc_apply_action;
      await auditMutationFromWorker(tx as any, {
        kind: "admin_action",
        tenantId: config.cycleTenantId,
        actor: "supercron_daemon:node_gc_apply",
        actorKind: "operator_token",
        operation,
        eventData: {
          ...eventData,
          ...nodeGcEligibilityTelemetry(),
          apply_action: eventApplyAction,
          apply_per_cycle_cap: perCycleCap,
          predicate_version: predicateVersion,
        },
      }, { durability: "required" });
    };

    const readCurrentPredicateRow = async (
      tx: any,
      addr: string,
      options: { lockForApply?: boolean } = {},
    ): Promise<NodeGcApplyPredicateRow | null> => {
      return readNodeGcApplyPredicateRow(tx, config.cycleTenantId, tenantSpaceId, addr, options);
    };

    const readApplyPreview = async (tx: any): Promise<Record<string, unknown>> => {
      await assertTenantSpaceKind(tx);
      const approvedCount = await readApprovedCount(tx);
      const receipts = await readApprovedReceiptsForApply(tx, false);
      let wouldApply = 0;
      let wouldExpire = 0;
      const wouldExpireAddrs: string[] = [];
      const wouldApplyByAction: Record<NodeGcApplyAction, number> = { tombstone: 0, delete: 0 };
      for (const receipt of receipts) {
        const addr = String(receipt.addr);
        const receiptAction = resolveReceiptApplyAction(receipt);
        const predicateRow = await readCurrentPredicateRow(tx, addr, { lockForApply: false });
        const predicate = evaluateNodeGcApplyPredicate(predicateRow, nodeGcApplyPredicateOptions(nodeGc));
        if (predicate.holds) {
          wouldApply += 1;
          wouldApplyByAction[receiptAction] += 1;
        } else {
          wouldExpire += 1;
          wouldExpireAddrs.push(addr);
        }
      }
      return {
        enabled: nodeGc.applyEnabled,
        disabled: !settings.supercron_node_gc_apply_enabled,
        approved_count: approvedCount,
        total_processed: receipts.length,
        would_apply: wouldApply,
        would_expire: wouldExpire,
        would_apply_by_action: wouldApplyByAction,
        predicate_drift_addrs_sample: wouldExpireAddrs.slice(0, 50),
        apply_action: action,
        per_cycle_cap: perCycleCap,
        destructive_actions: 0,
      };
    };

    if (config.dryRun) {
      const preview = await readApplyPreview(sql);
      return {
        actions: 0,
        details: {
          dry_run: true,
          ...preview,
        },
      };
    }

    if (!settings.supercron_node_gc_apply_enabled) {
      const preview = await readApplyPreview(sql);
      return {
        actions: 0,
        details: preview,
      };
    }

    const applied = await sql.begin(async (tx: any) => {
      await tx`SELECT pg_advisory_xact_lock(0x564f4609, hashtext(${"node_gc_apply:" + config.cycleTenantId}))`;
      await assertTenantSpaceKind(tx);

      const receipts = await readApprovedReceiptsForApply(tx, true);
      if (receipts.length === 0) {
        await auditNodeGcApply(tx, "supercron_node_gc_apply_no_approved", {
          approved_count: 0,
          selected: 0,
        });
        return {
          selected: 0,
          tombstoned: 0,
          deleted: 0,
          expired: 0,
          appliedByAction: { tombstone: 0, delete: 0 },
          appliedAddrs: [],
          predicateDriftAddrs: [],
          deleteCountsByAddr: {},
        };
      }

      let tombstoned = 0;
      let deleted = 0;
      let expired = 0;
      const appliedAddrs: string[] = [];
      const predicateDriftAddrs: string[] = [];
      const deleteCountsByAddr: Record<string, unknown> = {};

      for (const receipt of receipts) {
        const receiptId = receipt.id;
        const addr = String(receipt.addr);
        const batchId = String(receipt.batch_id);
        const action = resolveReceiptApplyAction(receipt);
        const receiptPredicateVersion = Number(receipt.predicate_version);
        const reviewedBy = receipt.reviewed_by == null ? null : String(receipt.reviewed_by);
        const reviewedAt = receipt.reviewed_at == null ? null : observedText(receipt.reviewed_at);
        const predicateRow = await readCurrentPredicateRow(tx, addr);
        const predicate = evaluateNodeGcApplyPredicate(predicateRow, nodeGcApplyPredicateOptions(nodeGc));
        const driftObserved = predicate.observed == null ? null : observedText(predicate.observed);

        if (!predicate.holds) {
          expired += 1;
          predicateDriftAddrs.push(addr);
          await tx`
            UPDATE supercron_node_gc_receipts
            SET
              status = 'expired',
              expires_at = now(),
              rejection_reason = ${predicate.rejectionReason},
              applied_action = NULL,
              applied_at = NULL,
              updated_at = now(),
              eligibility = COALESCE(eligibility, '{}'::jsonb) || jsonb_build_object(
                'apply_predicate_snapshot', ${tx.json(predicate.snapshot)}::jsonb,
                'apply_predicate_drift_field', ${predicate.field},
                'apply_predicate_drift_observed', ${driftObserved},
                'apply_action', ${action}
              )
            WHERE id = ${receiptId}
          `;
          await auditNodeGcApply(tx, "supercron_node_gc_expired_predicate_drift", {
            addr,
            batch_id: batchId,
            reviewed_by: reviewedBy,
            reviewed_at: reviewedAt,
            apply_action: action,
            reason: predicate.rejectionReason,
            drift_field: predicate.field,
            drift_observed: driftObserved,
            predicate_snapshot: predicate.snapshot,
            predicate_version: receiptPredicateVersion,
          });
          continue;
        }

        let deleteCounts: NodeGcCascadeDeleteCount[] | null = null;
        if (action === "tombstone") {
          const tombstoneRows = await tx`
            UPDATE nodes SET visibility = 'deleted', updated_at = now()
            WHERE addr = ${addr}
              AND space_id = ${tenantSpaceId}
              AND visibility <> 'deleted'
            RETURNING addr
          `;
          if (tombstoneRows.length !== 1) {
            throw new Error(`node_gc_apply_action_failed:tombstone:${addr}`);
          }
          tombstoned += 1;
        } else if (action === "delete") {
          deleteCounts = await cascadeDeleteNode(tx, addr, tenantSpaceId);
          const nodeDeleteRows = deleteCounts.find((entry) => entry.table === "nodes")?.rows ?? 0;
          if (nodeDeleteRows !== 1) {
            throw new Error(`node_gc_apply_action_failed:delete:${addr}`);
          }
          deleteCountsByAddr[addr] = deleteCounts;
          deleted += 1;
        } else {
          throw new Error(`node_gc_apply_action_unsupported:${String(action)}`);
        }

        const applyEligibilityExtension: Record<string, unknown> = {
          apply_predicate_snapshot: predicate.snapshot,
          apply_predicate_drift_field: null,
          apply_predicate_drift_observed: null,
          apply_action: action,
        };
        if (deleteCounts != null) {
          applyEligibilityExtension.apply_delete_counts = deleteCounts;
        }

        await tx`
          UPDATE supercron_node_gc_receipts
          SET
            status = 'applied',
            applied_action = ${action},
            applied_at = clock_timestamp(),
            expires_at = NULL,
            rejection_reason = NULL,
            updated_at = clock_timestamp(),
            eligibility = COALESCE(eligibility, '{}'::jsonb) || ${tx.json(applyEligibilityExtension)}::jsonb
          WHERE id = ${receiptId}
        `;

        const auditOperation = action === "tombstone"
          ? "supercron_node_gc_applied_tombstone"
          : "supercron_node_gc_applied_delete";
        await auditNodeGcApply(tx, auditOperation, {
          addr,
          batch_id: batchId,
          reviewed_by: reviewedBy,
          reviewed_at: reviewedAt,
          apply_action: action,
          previous_visibility: predicate.snapshot.visibility,
          predicate_snapshot: predicate.snapshot,
          predicate_version: receiptPredicateVersion,
          ...(deleteCounts ? { delete_counts: deleteCounts } : {}),
        });
        appliedAddrs.push(addr);
      }

      if (tombstoned + deleted + expired !== receipts.length) {
        throw new Error(
          `node_gc_apply_accounting_error:expected=${receipts.length}:got=${tombstoned}+${deleted}+${expired}`,
        );
      }

      return {
        selected: receipts.length,
        tombstoned,
        deleted,
        expired,
        appliedByAction: { tombstone: tombstoned, delete: deleted },
        appliedAddrs,
        predicateDriftAddrs,
        deleteCountsByAddr,
      };
    });
    const passWarnings = applied.expired > 0
      ? [`predicate_drift_expired:${applied.expired}_of_${applied.selected}`]
      : [];
    const processedActions = applied.tombstoned + applied.deleted + applied.expired;

    return {
      actions: processedActions,
      details: {
        selected: applied.selected,
        tombstoned: applied.tombstoned,
        deleted: applied.deleted,
        expired: applied.expired,
        processed_actions: processedActions,
        apply_action: action,
        configured_apply_action: action,
        applied_by_action: applied.appliedByAction,
        per_cycle_cap: perCycleCap,
        predicate_drift_addrs_sample: applied.predicateDriftAddrs.slice(0, 50),
        applied_addrs_sample: applied.appliedAddrs.slice(0, 50),
        ...(applied.deleted > 0 ? { delete_counts_by_addr_sample: Object.fromEntries(Object.entries(applied.deleteCountsByAddr).slice(0, 10)) } : {}),
        ...(passWarnings.length > 0 ? { warnings: passWarnings } : {}),
        destructive_actions: applied.tombstoned + applied.deleted,
      },
    };
  });
}

export async function runDistillerSimpleConfidencePromotion(
  db: DirectSql,
  pf: string | null,
  useRecallOutcomes = true,
): Promise<DistillerSimplePromotionResult> {
  // Capture this after 6a merges so audit matching covers only confidence
  // promotions. Moving it above the merge loop would mix merge-triggered node
  // updates into the verification window.
  const [{ run_started_at: promotionRunStartedAt }] = await db`SELECT now() AS run_started_at`;
  const promotionScope = pf ? db`AND n.pyramid_id = ${pf}` : db``;
  const [recallOutcomeTable] = await db`SELECT to_regclass('recall_outcome_events') IS NOT NULL AS installed`;
  const recallOutcomeSignalsInstalled = useRecallOutcomes && Boolean(recallOutcomeTable?.installed);
  const recallOutcomeScores = recallOutcomeSignalsInstalled
    ? db`
      SELECT
        recalled_addr AS addr,
        SUM(COALESCE(outcome_score, 0))::double precision AS recall_outcome_score,
        COUNT(*) FILTER (WHERE outcome_score > 0)::int AS positive_recall_outcomes,
        COUNT(*) FILTER (WHERE outcome_score < 0)::int AS negative_recall_outcomes
      FROM (
        SELECT DISTINCT event_id, recalled_addr, outcome_score
        FROM (
          SELECT id AS event_id, unnest(memory_addrs) AS recalled_addr, outcome_score
          FROM recall_outcome_events
          WHERE event_type <> 'recalled'
            AND created_at > now() - (${RECALL_OUTCOME_PROMOTION_LOOKBACK_DAYS}::text || ' days')::interval
        ) expanded_recall_rows
      ) recall_rows
      WHERE recalled_addr IS NOT NULL
      GROUP BY recalled_addr`
    : db`
      SELECT
        NULL::text AS addr,
        0::double precision AS recall_outcome_score,
        0::int AS positive_recall_outcomes,
        0::int AS negative_recall_outcomes
      WHERE false`;
  const [promotion] = await db`
    WITH recall_outcome_scores AS (${recallOutcomeScores}),
    promotion_candidates AS (
      SELECT
        n.addr,
        n.node_type,
        n.query_hits,
        n.confidence::double precision AS old_confidence,
        LEAST(
          ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision,
          (n.confidence + ${DISTILLER_SIMPLE_PROMOTION_BOOST})::double precision
        ) AS proposed_confidence,
        n.pinned,
        n.last_queried,
        COALESCE((
          SELECT count(*)::int
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(n.source_refs) = 'array' THEN n.source_refs
              ELSE '[]'::jsonb
            END
          ) AS source_ref(ref)
          WHERE btrim(COALESCE(source_ref.ref->>'url', '')) <> ''
             OR btrim(COALESCE(source_ref.ref->>'path', '')) <> ''
             OR btrim(COALESCE(source_ref.ref->>'kind', '')) <> ''
             OR btrim(COALESCE(source_ref.ref->>'source', '')) <> ''
        ), 0) AS source_ref_count,
        (
          COALESCE(n.provenance, '{}'::jsonb) = '{}'::jsonb
          OR (
            btrim(COALESCE(n.provenance->>'agent', '')) = ''
            AND btrim(COALESCE(n.provenance->>'source', '')) = ''
            AND btrim(COALESCE(n.provenance->>'basis', '')) = ''
            AND COALESCE(jsonb_array_length(
              CASE
                WHEN jsonb_typeof(n.provenance->'evidence_refs') = 'array' THEN n.provenance->'evidence_refs'
                ELSE '[]'::jsonb
              END
            ), 0) = 0
          )
        ) AS missing_provenance,
        mr.status AS memory_status,
        mr.accepted_by_user AS memory_accepted_by_user,
        mr.source_kind AS memory_source_kind,
        mr.kind AS memory_kind,
        COALESCE(n.substance->>'maturity_stage', '') AS maturity_stage,
        COALESCE(n.substance->>'source_kind', '') AS substance_source_kind,
        COALESCE(n.substance @> '{"accepted_by_user": true}'::jsonb, false) AS substance_accepted_by_user,
        COALESCE(ros.recall_outcome_score, 0)::double precision AS recall_outcome_score,
        COALESCE(ros.positive_recall_outcomes, 0)::int AS positive_recall_outcomes,
        COALESCE(ros.negative_recall_outcomes, 0)::int AS negative_recall_outcomes
      FROM nodes n
      LEFT JOIN memory_registry mr ON mr.addr = n.addr
      LEFT JOIN recall_outcome_scores ros ON ros.addr = n.addr
      WHERE (
          n.query_hits >= ${DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS}
          OR COALESCE(ros.positive_recall_outcomes, 0) > 0
        )
        AND n.visibility = 'public'
        AND n.confidence IS NOT NULL
        ${promotionScope}
    ),
    classified AS (
      SELECT
        *,
        old_confidence >= ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision AS already_threshold,
        old_confidence + ${DISTILLER_SIMPLE_PROMOTION_BOOST} > ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision
          AND proposed_confidence = ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision AS would_clip,
        proposed_confidence = ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision AS landed_at_cap,
        (
          pinned = true
          OR (
            COALESCE(node_type, '') = 'memory'
            AND (
              COALESCE(memory_status, 'active') <> 'active'
              OR COALESCE(memory_accepted_by_user, false) = true
              OR substance_accepted_by_user = true
              OR COALESCE(memory_source_kind, '') = 'user_accepted'
              OR substance_source_kind = 'user_accepted'
              OR COALESCE(memory_kind, '') = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[])
              OR COALESCE(maturity_stage, '') = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[])
            )
          )
        ) AS protected_guardrail,
        (
          old_confidence < ${DISTILLER_SIMPLE_TRUST_THRESHOLD}::double precision
          AND proposed_confidence >= ${DISTILLER_SIMPLE_TRUST_THRESHOLD}::double precision
          AND (source_ref_count = 0 OR missing_provenance = true)
        ) AS provenance_guardrail,
        (
          positive_recall_outcomes = 0
          AND (
            last_queried IS NULL
            OR last_queried < now() - (${DISTILLER_SIMPLE_STALE_QUERY_HIT_DAYS}::text || ' days')::interval
          )
        ) AS stale_query_guardrail,
        (
          recall_outcome_score < 0
          OR negative_recall_outcomes > positive_recall_outcomes
        ) AS negative_recall_guardrail
      FROM promotion_candidates
    ),
    eligible AS (
      SELECT *
      FROM classified
      WHERE already_threshold = false
        AND protected_guardrail = false
        AND provenance_guardrail = false
        AND stale_query_guardrail = false
        AND negative_recall_guardrail = false
        AND proposed_confidence > old_confidence
    ),
    promoted AS (
      UPDATE nodes n
      SET confidence = e.proposed_confidence
      FROM eligible e
      WHERE n.addr = e.addr
        AND n.confidence = e.old_confidence
        AND e.proposed_confidence::real <> n.confidence::real
      RETURNING
        n.addr,
        e.query_hits,
        e.old_confidence,
        n.confidence AS new_confidence,
        e.source_ref_count,
        e.recall_outcome_score,
        e.positive_recall_outcomes,
        e.negative_recall_outcomes,
        e.would_clip,
        e.landed_at_cap
    )
    SELECT
      (SELECT count(*)::int FROM promotion_candidates) AS promotion_candidates,
      (SELECT count(*)::int FROM eligible) AS promotion_attempted,
      (SELECT count(*)::int FROM promoted) AS promotion_changed,
      (SELECT count(*)::int FROM classified WHERE already_threshold = true) AS promotion_already_threshold,
      (SELECT count(*)::int FROM promoted WHERE would_clip = true) AS promotion_capped,
      (SELECT count(*)::int FROM promoted WHERE landed_at_cap = true) AS promotion_landed_at_cap,
      (SELECT count(*)::int FROM eligible WHERE positive_recall_outcomes > 0) AS promotion_recall_positive_candidates,
      (SELECT count(*)::int FROM eligible WHERE query_hits >= ${DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS} AND positive_recall_outcomes > 0) AS promotion_recall_combined_candidates,
      (SELECT count(*)::int FROM eligible WHERE query_hits < ${DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS} AND positive_recall_outcomes > 0) AS promotion_recall_only_candidates,
      (SELECT count(*)::int FROM classified WHERE already_threshold = false AND protected_guardrail = true) AS promotion_skipped_protected,
      (SELECT count(*)::int FROM classified WHERE already_threshold = false AND provenance_guardrail = true) AS promotion_skipped_ungrounded,
      (SELECT count(*)::int FROM classified WHERE already_threshold = false AND stale_query_guardrail = true) AS promotion_skipped_stale_query,
      (SELECT count(*)::int FROM classified WHERE already_threshold = false AND negative_recall_guardrail = true) AS promotion_skipped_negative_recall,
      (SELECT count(*)::int FROM classified WHERE already_threshold = false AND (protected_guardrail OR provenance_guardrail OR stale_query_guardrail OR negative_recall_guardrail)) AS promotion_skipped_guardrail,
      (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'addr', addr,
              'query_hits', query_hits,
              'old_confidence', old_confidence,
              'new_confidence', new_confidence,
              'source_ref_count', source_ref_count,
              'recall_outcome_score', recall_outcome_score,
              'positive_recall_outcomes', positive_recall_outcomes,
              'negative_recall_outcomes', negative_recall_outcomes,
              'promotion_recall_only', positive_recall_outcomes > 0
                AND query_hits < ${DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS}
            )
            ORDER BY new_confidence DESC, addr ASC
          ),
          '[]'::jsonb
        )
        FROM promoted
      ) AS promotion_rows`;

  const [trigger] = await db`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'trg_log_node_mutation'
        AND tgrelid = 'nodes'::regclass
        AND NOT tgisinternal
    ) AS installed`;
  const auditInstalled = Boolean(trigger?.installed);

  let promotionAuditVerified = 0;
  const promotionChanged = parseInt(promotion.promotion_changed || "0");
  if (auditInstalled && promotionChanged > 0) {
    const [audit] = await db`
      SELECT count(DISTINCT gm.target_addr)::int AS cnt
      FROM graph_mutations gm
      JOIN nodes n ON n.addr = gm.target_addr
      WHERE gm.mutation_type = 'node_update'
        ${pf ? db`AND n.pyramid_id = ${pf}` : db``}
        AND gm.created_at >= ${promotionRunStartedAt}
        AND gm.old_value->>'confidence' IS NOT NULL
        AND gm.new_value->>'confidence' IS NOT NULL
        AND abs(
          (gm.new_value->>'confidence')::double precision
          - LEAST(
            ${DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP}::double precision,
            ((gm.old_value->>'confidence')::double precision + ${DISTILLER_SIMPLE_PROMOTION_BOOST}::double precision)
          )
        ) < 0.000001`;
    promotionAuditVerified = parseInt(audit?.cnt || "0");
  }

  const promotionAuditWarning = auditInstalled
    ? promotionAuditVerified !== promotionChanged
    : promotionChanged > 0;
  if (!auditInstalled && promotionChanged > 0) {
    console.warn(
      "  [PROMOTE] graph_mutations trigger not installed; audit verification disabled. Run db/foundation-rung-f12-reset-parity.sql to enable.",
    );
  } else if (promotionAuditWarning) {
    console.warn(
      `  [PROMOTE] graph_mutations confidence audit mismatch: changed=${promotionChanged} audit=${promotionAuditVerified}`,
    );
  }

  let promotionAuditPacketsQueued = 0;
  if (promotionChanged > 0) {
    const promotionRowsRaw = promotion.promotion_rows;
    const promotedRows = (
      Array.isArray(promotionRowsRaw)
        ? promotionRowsRaw
        : typeof promotionRowsRaw === "string"
          ? JSON.parse(promotionRowsRaw)
          : []
    ).filter((row: any) => Number(row.new_confidence || 0) >= 0.85 && Number(row.old_confidence || 0) < 0.85).slice(0, 4);
    for (const row of promotedRows) {
      await db`
        INSERT INTO distill_work_items (
          scope_kind,
          seed_ref,
          pressure_type,
          pressure_score,
          status,
          metadata,
          last_distilled_at,
          attempt_count
        ) VALUES (
          'node',
          ${String(row.addr)},
          'confidence_promotion_pressure',
          ${Math.max(0, Number(row.new_confidence || 0) - Number(row.old_confidence || 0))},
          'open',
          ${db.json({
            old_confidence: Number(row.old_confidence || 0),
            new_confidence: Number(row.new_confidence || 0),
            source_ref_count: Number(row.source_ref_count || 0),
            recall_outcome_score: Number(row.recall_outcome_score || 0),
            positive_recall_outcomes: Number(row.positive_recall_outcomes || 0),
            negative_recall_outcomes: Number(row.negative_recall_outcomes || 0),
            promotion_recall_only: Number(row.positive_recall_outcomes || 0) > 0
              && Number(row.query_hits || 0) < DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS,
            promotion_audit_verified: promotionAuditVerified,
            promotion_changed: promotionChanged,
            promotion_audit_warning: promotionAuditWarning,
            source: promotionAuditWarning ? "distiller_simple_audit_warning" : "distiller_simple_high_band_promotion",
          })},
          now(),
          1
        )
        ON CONFLICT (scope_kind, seed_ref, pressure_type) DO UPDATE SET
          pressure_score = EXCLUDED.pressure_score,
          status = CASE
            WHEN distill_work_items.status = 'invalid' THEN distill_work_items.status
            ELSE 'open'
          END,
          metadata = CASE
            WHEN distill_work_items.status = 'invalid' THEN distill_work_items.metadata
            ELSE distill_work_items.metadata || EXCLUDED.metadata
          END,
          last_seen_at = now(),
          last_distilled_at = CASE
            WHEN distill_work_items.status = 'invalid' THEN distill_work_items.last_distilled_at
            ELSE now()
          END,
          attempt_count = CASE
            WHEN distill_work_items.status = 'invalid' THEN distill_work_items.attempt_count
            ELSE distill_work_items.attempt_count + 1
          END,
          resolved_at = CASE
            WHEN distill_work_items.status = 'invalid' THEN distill_work_items.resolved_at
            ELSE NULL
          END
      `;
      promotionAuditPacketsQueued += 1;
    }
  }

  return {
    changed: promotionChanged,
    details: {
      promoted: promotionChanged,
      promotion_candidates: parseInt(promotion.promotion_candidates || "0"),
      promotion_attempted: parseInt(promotion.promotion_attempted || "0"),
      promotion_changed: promotionChanged,
      promotion_already_threshold: parseInt(promotion.promotion_already_threshold || "0"),
      promotion_capped: parseInt(promotion.promotion_capped || "0"),
      promotion_landed_at_cap: parseInt(promotion.promotion_landed_at_cap || "0"),
      promotion_recall_outcome_signals_installed: recallOutcomeSignalsInstalled,
      promotion_recall_positive_candidates: parseInt(promotion.promotion_recall_positive_candidates || "0"),
      promotion_recall_combined_candidates: parseInt(promotion.promotion_recall_combined_candidates || "0"),
      promotion_recall_only_candidates: parseInt(promotion.promotion_recall_only_candidates || "0"),
      promotion_skipped_protected: parseInt(promotion.promotion_skipped_protected || "0"),
      promotion_skipped_ungrounded: parseInt(promotion.promotion_skipped_ungrounded || "0"),
      promotion_skipped_stale_query: parseInt(promotion.promotion_skipped_stale_query || "0"),
      promotion_skipped_negative_recall: parseInt(promotion.promotion_skipped_negative_recall || "0"),
      promotion_skipped_guardrail: parseInt(promotion.promotion_skipped_guardrail || "0"),
      promotion_audit_verified: promotionAuditVerified,
      promotion_audit_installed: auditInstalled,
      promotion_audit_warning: promotionAuditWarning,
      promotion_audit_packets_queued: promotionAuditPacketsQueued,
      promotion_confidence_cap: DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP,
    },
  };
}

// Pass 6: Distiller Simple
async function pass6DistillerSimple(config: SupercronConfig): Promise<PassResult> {
  return runPass("distiller_simple", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };
    const pf = pyramidFilter(config);

    // 6a: Merge near-dupes (sim > 0.94, LIMIT 5) — conservative, no LLM validation in Tier 2
    // Tightened from 0.92/10 after initial backlog clear to preserve nuance for AI visitors
    const pyramidMergeWhere = pf ? sql`AND a.pyramid_id = ${pf}` : sql``;
    const pairs = await sql`
      SELECT a.addr AS addr_a, a.label AS label_a, a.confidence AS conf_a,
        a.query_hits AS hits_a,
        (SELECT count(*)::int FROM edges WHERE from_addr = a.addr OR to_addr = a.addr) AS edges_a,
        b.addr AS addr_b, b.label AS label_b, b.confidence AS conf_b,
        b.query_hits AS hits_b,
        (SELECT count(*)::int FROM edges WHERE from_addr = b.addr OR to_addr = b.addr) AS edges_b,
        1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) AS similarity
      FROM nodes a, nodes b
      WHERE a.addr < b.addr
        AND a.embedding_hv IS NOT NULL AND b.embedding_hv IS NOT NULL
        AND a.visibility = 'public' AND b.visibility = 'public'
        AND a.pyramid_id = b.pyramid_id
        -- Tenant memory is NEVER merged by this unaudited operator-knowledge distiller.
        -- It has no protection gate (accepted_by_user / protected-kind / pinned) and
        -- emits no lifecycle event — it could silently merge away a freshly-saved,
        -- user-accepted memory. Tenant-memory consolidation belongs exclusively to the
        -- audited, proposal-only memory_merge pass (pass14). Excludes by both node_type
        -- (memory rows) and space (any tenant:* node).
        AND a.node_type IS DISTINCT FROM 'memory' AND b.node_type IS DISTINCT FROM 'memory'
        AND a.space_id NOT LIKE 'tenant:%' AND b.space_id NOT LIKE 'tenant:%'
        AND 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) > 0.94
        AND (a.embedding_hv::vector <=> b.embedding_hv::vector) <> 'NaN'::float
        ${pyramidMergeWhere}
      ORDER BY 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) DESC
      LIMIT 5`;

    let merged = 0;
    // Each addr participates in at most one merge per cycle (mirrors pass14's
    // memory_merge). The pairs are snapshotted once; without this, a 3+ node
    // near-dup cluster (A,B,C all >0.94) would process (B,C) against the already-
    // tombstoned B after B→A merged, producing a broken chain C→B→A and a
    // non-idempotent, non-converging result. Skipped pairs are reconsidered next cycle.
    const consumed = new Set<string>();
    for (const p of pairs) {
      if (consumed.has(String(p.addr_a)) || consumed.has(String(p.addr_b))) continue;
      const scoreA = (Number(p.conf_a) * 10) + Number(p.hits_a) + Number(p.edges_a);
      const scoreB = (Number(p.conf_b) * 10) + Number(p.hits_b) + Number(p.edges_b);
      const winner = scoreA >= scoreB ? p.addr_a : p.addr_b;
      const loser = scoreA >= scoreB ? p.addr_b : p.addr_a;

      const { rewireEdgesForNodeMerge } = await import("../../api/src/lib/edge-mutations");
      await sql.begin(async (tx) => {
        await rewireEdgesForNodeMerge(sql as any, String(loser), String(winner), { tx: tx as any });
        // Mark loser as merged (store merge target in substance)
        await tx`UPDATE nodes SET visibility = 'merged',
          substance = jsonb_set(COALESCE(substance, '{}'), '{merged_into}', ${tx.json(winner)})
          WHERE addr = ${loser}`;
      });
      consumed.add(String(winner));
      consumed.add(String(loser));
      merged++;
      console.log(`  [MERGE] ${loser} → ${winner} (sim=${Number(p.similarity).toFixed(3)})`);
    }

    // 6b: Promote popular nodes, but keep machine-only promotion below
    // human/multi-agent trust bands and report actual changed rows.
    const promotion = config.policy.features.confidencePromotionEnabled
      ? await runDistillerSimpleConfidencePromotion(sql, pf, config.policy.features.recallOutcomesEnabled)
      : {
        changed: 0,
        details: {
          promotion_disabled_for_tenant: true,
          promoted: 0,
          promotion_candidates: 0,
          promotion_attempted: 0,
          promotion_changed: 0,
          promotion_already_threshold: 0,
          promotion_capped: 0,
          promotion_landed_at_cap: 0,
          promotion_recall_outcome_signals_installed: false,
          promotion_recall_positive_candidates: 0,
          promotion_recall_combined_candidates: 0,
          promotion_recall_only_candidates: 0,
          promotion_skipped_protected: 0,
          promotion_skipped_ungrounded: 0,
          promotion_skipped_stale_query: 0,
          promotion_skipped_negative_recall: 0,
          promotion_skipped_guardrail: 0,
          promotion_audit_verified: 0,
          promotion_audit_installed: false,
          promotion_audit_warning: false,
          promotion_audit_packets_queued: 0,
          promotion_confidence_cap: DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP,
        },
      };
    const promotionChanged = promotion.changed;

    // 6c: Flag stale (age > 30d, conf < 0.40 → report only)
    const stale = await sql`
      SELECT count(*) AS cnt FROM nodes
      WHERE created_at < now() - interval '30 days' AND confidence < 0.40
        AND visibility = 'public'
        ${pf ? sql`AND pyramid_id = ${pf}` : sql``}`;

    return {
      actions: merged + promotionChanged,
      proposals_applied: promotionChanged,
      details: {
        merged,
        ...promotion.details,
        stale_flagged: parseInt(stale[0]?.cnt || "0"),
      },
    };
  });
}

// Pass 7: Supersession
async function pass7Supersession(config: SupercronConfig): Promise<PassResult> {
  return runPass("supersession", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // 7a: Stimulus supersession (sim > 0.85, node overlap > 60%)
    // Find processed stimuli from last 7 days that haven't been checked for supersession
    const recentStimuli = await sql`
      SELECT s.id, s.content, s.source, s.embedding::text AS embedding
      FROM stimuli s
      LEFT JOIN supersession_candidates sc ON sc.newer_stimulus_id = s.id
      WHERE s.processed = true AND s.created_at > now() - interval '7 days'
        AND s.embedding IS NOT NULL AND sc.id IS NULL
      ORDER BY s.created_at DESC LIMIT 50`;

    let stimulusSuperseded = 0;
    for (const stim of recentStimuli) {
      const similar = await sql`
        SELECT id, content, source, 1 - (embedding <=> ${stim.embedding}::vector) AS sim
        FROM stimuli
        WHERE id != ${stim.id} AND processed = true
          AND created_at > now() - interval '7 days'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${stim.embedding}::vector
        LIMIT 5`;

      for (const s of similar) {
        if (parseFloat(s.sim) <= 0.85) continue;

        const [touchedByNewer] = await sql`
          SELECT array_agg(DISTINCT node_addr) AS addrs FROM stimulus_contributions WHERE stimulus_id = ${stim.id}`;
        const touchedNodes = touchedByNewer?.addrs || [];
        if (touchedNodes.length === 0) continue;

        const [overlapRow] = await sql`
          SELECT count(*)::int AS cnt FROM stimulus_contributions
          WHERE stimulus_id = ${s.id} AND node_addr = ANY(${touchedNodes})`;
        const [olderTotal] = await sql`
          SELECT count(*)::int AS cnt FROM stimulus_contributions WHERE stimulus_id = ${s.id}`;
        const overlapPct = olderTotal.cnt > 0 ? overlapRow.cnt / olderTotal.cnt : 0;
        if (overlapPct <= 0.6) continue;

        // 7c: Auto-confirm explicit markers
        const hasExplicitMarker = /(patch|fix|supersed|correct|retract|update[ds]?)\b/i.test(stim.content) && parseFloat(s.sim) > 0.80;
        const detectionMethod = hasExplicitMarker ? "explicit_marker"
          : stim.source === s.source ? "same_source_update" : "embedding_similarity";

        await sql`
          INSERT INTO supersession_candidates (newer_stimulus_id, older_stimulus_id, similarity, node_overlap_pct, detection_method, status, resolved_by)
          VALUES (${stim.id}, ${s.id}, ${parseFloat(s.sim)}, ${overlapPct}, ${detectionMethod},
            ${hasExplicitMarker ? "confirmed" : "pending"}, ${hasExplicitMarker ? "auto" : null})
          ON CONFLICT DO NOTHING`;

        if (hasExplicitMarker) {
          await sql.begin(async (tx: any) => {
            await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
            await tx`UPDATE stimulus_contributions SET contribution = 0 WHERE stimulus_id = ${s.id}`;
          });
        }
        stimulusSuperseded++;
      }
    }

    // 7b: Memory supersession (handled in pass 3d, report count here)

    return {
      actions: stimulusSuperseded,
      details: { stimulus_superseded: stimulusSuperseded },
    };
  });
}

// Pass: Review-packet intake (LW4) — persist #65 semantic review packets into the
// review_proposals ledger so LW5 can feed them into the Today/attention surface.
// READ-ONLY against the candidate sources + WRITE-ONLY into review_proposals;
// proposal-only (records "review this", never applies a change). The tenant's #10
// policy profile (LW3) drives the bounded review-queue knobs. Idempotent: re-detected
// reviews collapse onto their row via ON CONFLICT (idempotency_key) DO NOTHING.
async function passReviewPacketIntake(config: SupercronConfig): Promise<PassResult> {
  return runPass("review_packet_intake", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    const tenantId = config.cycleTenantId;
    const generatedAt = new Date().toISOString();

    // LW3: the tenant's policy posture drives the review-queue budget/caps/floor.
    const profile = await readTenantPolicyProfile(sql, tenantId);
    const policy = resolvePolicyProfile(profile);

    // Bounded candidate samples VO already computes — read-only, no live recall.
    // Cost note: listReviewableMemories' DB scan scales with the tenant's
    // agent_inferred memory count (internal fetchLimit 1000–2000, not the caller's 20);
    // acceptable for a periodic T2 pass, but the dominant read cost here.
    const conflicts = await getActiveConflicts(sql, tenantId, 10);
    const atomicity = await lifecycleAtomicityReport(sql, { tenantId, sampleLimit: 8 });
    const reviewable = await listReviewableMemories(sql, tenantId, 20);

    const queue = selectReviewQueue(
      {
        tenantId,
        conflicts: conflicts.map((c) => ({
          addr_a: c.addr_a,
          addr_b: c.addr_b,
          conflict_type: c.conflict_type,
          description: c.description,
        })),
        atomicity: atomicity.classes,
        reviewable: reviewable.map((r) => ({
          addr: r.addr,
          review_category: r.review_category,
          review_quality_reasons: r.review_quality_reasons,
        })),
      },
      { generatedAt, ...policy.review_queue },
    );

    const persisted = await persistReviewQueue(sql, queue);

    return {
      actions: persisted.inserted,
      proposals_created: persisted.inserted,
      details: {
        profile,
        candidates: {
          conflicts: conflicts.length,
          atomicity_classes: atomicity.classes.length,
          reviewable: reviewable.length,
        },
        admitted: queue.packets.length,
        inserted: persisted.inserted,
        skipped: persisted.skipped,
        failed: persisted.failed,
        dropped: queue.dropped,
      },
    };
  });
}

// Pass 8: Source Analytics
async function pass8SourceAnalytics(config: SupercronConfig): Promise<PassResult> {
  return runPass("source_analytics", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // Cluster detection: 3+ stimuli in 24h on same node
    const clusters = await sql`
      SELECT sc.node_addr, count(DISTINCT sc.stimulus_id)::int AS stimulus_count,
        array_agg(DISTINCT s.source) AS sources
      FROM stimulus_contributions sc
      JOIN stimuli s ON s.id = sc.stimulus_id
      WHERE sc.created_at > now() - interval '24 hours' AND sc.base_contribution > 0.001
      GROUP BY sc.node_addr
      HAVING count(DISTINCT sc.stimulus_id) >= 3
      ORDER BY count(DISTINCT sc.stimulus_id) DESC LIMIT 10`;

    // Atom feedback sync (from reactor.ts:467-508 — fills query_hits from query_log)
    const [lastSync] = await sql`SELECT value FROM graph_state WHERE key = 'atom_feedback_last_sync'`;
    const since = lastSync?.value ?? "2026-01-01T00:00:00Z";
    const recentQueries = await sql`
      SELECT returned_addrs, created_at FROM query_log
      WHERE created_at > ${since}::timestamptz AND returned_addrs IS NOT NULL`;

    let feedbackUpdated = 0;
    if (recentQueries.length > 0) {
      const addrHits = new Map<string, number>();
      for (const q of recentQueries) {
        const raw = q.returned_addrs;
        const addrs: string[] = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
        for (let idx = 0; idx < addrs.length; idx++) {
          const weight = idx < 3 ? 2 : 1;
          addrHits.set(addrs[idx], (addrHits.get(addrs[idx]) || 0) + weight);
        }
      }
      for (const [addr, hits] of addrHits) {
        await sql`UPDATE atom_feedback SET query_hits = query_hits + ${hits} WHERE node_addr = ${addr}`;
      }
      const maxTime = recentQueries.reduce((max, q) => {
        const ts = q.created_at instanceof Date ? q.created_at.toISOString() : String(q.created_at);
        return ts > max ? ts : max;
      }, since);
      await sql`
        INSERT INTO graph_state (key, value) VALUES ('atom_feedback_last_sync', ${maxTime})
        ON CONFLICT (key) DO UPDATE SET value = ${maxTime}`;
      feedbackUpdated = addrHits.size;
    }

    // Source match rates (7d)
    const sourceStats = await sql`
      SELECT s.source,
        count(*)::int AS total,
        count(CASE WHEN sc.stimulus_id IS NOT NULL THEN 1 END)::int AS matched
      FROM stimuli s
      LEFT JOIN stimulus_contributions sc ON sc.stimulus_id = s.id AND sc.base_contribution > 0.001
      WHERE s.processed = true AND s.created_at > now() - interval '7 days'
      GROUP BY s.source`;

    for (const stat of sourceStats) {
      const matchRate = stat.total > 0 ? (stat.matched / stat.total).toFixed(3) : "0";
      await sql`
        INSERT INTO graph_state (key, value) VALUES (${"source_match_rate_" + stat.source}, ${matchRate})
        ON CONFLICT (key) DO UPDATE SET value = ${matchRate}`;
    }

    // Source taste (30d)
    const sourceTaste = await sql`
      SELECT source_type,
        AVG(CASE WHEN query_hits > 0 THEN 1.0 ELSE 0.0 END) AS hit_rate,
        count(*) AS sample_size
      FROM atom_feedback
      WHERE created_at > now() - interval '30 days' AND node_addr IS NOT NULL
      GROUP BY source_type HAVING count(*) >= 5`;

    for (const st of sourceTaste) {
      const rate = parseFloat(st.hit_rate).toFixed(3);
      await sql`
        INSERT INTO graph_state (key, value) VALUES (${"source_taste_" + st.source_type}, ${rate})
        ON CONFLICT (key) DO UPDATE SET value = ${rate}`;
    }

    const [recallOutcomeTable] = config.policy.features.recallOutcomesEnabled
      ? await sql`SELECT to_regclass('recall_outcome_events') IS NOT NULL AS installed`
      : [{ installed: false }];
    let recallOutcomeSignalWrites = 0;
    let recallOutcomeSignals: Record<string, number | boolean> = {
      installed: Boolean(recallOutcomeTable?.installed),
      recalled_events_24h: 0,
      positive_outcomes_24h: 0,
      negative_outcomes_24h: 0,
      supported_actions_24h: 0,
      missing_memory_reports_24h: 0,
      useful_memory_addr_count_24h: 0,
      problem_memory_addr_count_24h: 0,
    };
    if (config.policy.features.recallOutcomesEnabled && recallOutcomeTable?.installed) {
      const [recallStats] = await sql`
        WITH recent AS (
          SELECT *
          FROM recall_outcome_events
          WHERE created_at > now() - interval '24 hours'
        ),
        per_addr AS (
          SELECT recalled_addr AS addr, SUM(COALESCE(outcome_score, 0))::double precision AS net_score
          FROM (
            SELECT DISTINCT event_id, recalled_addr, outcome_score
            FROM (
              SELECT id AS event_id, unnest(memory_addrs) AS recalled_addr, outcome_score
              FROM recent
              WHERE event_type <> 'recalled'
            ) expanded_recent
          ) rows
          WHERE recalled_addr IS NOT NULL
          GROUP BY recalled_addr
        )
        SELECT
          (SELECT count(*)::int FROM recent WHERE event_type = 'recalled') AS recalled_events_24h,
          (SELECT count(*)::int FROM recent WHERE event_type <> 'recalled' AND outcome_score > 0) AS positive_outcomes_24h,
          (SELECT count(*)::int FROM recent WHERE event_type <> 'recalled' AND outcome_score < 0) AS negative_outcomes_24h,
          (SELECT count(*)::int FROM recent WHERE event_type = 'supported_action') AS supported_actions_24h,
          (SELECT count(*)::int FROM recent WHERE event_type = 'missing_memory') AS missing_memory_reports_24h,
          (SELECT count(*)::int FROM per_addr WHERE net_score > 0) AS useful_memory_addr_count_24h,
          (SELECT count(*)::int FROM per_addr WHERE net_score < 0) AS problem_memory_addr_count_24h`;
      recallOutcomeSignals = {
        installed: true,
        recalled_events_24h: Number(recallStats?.recalled_events_24h ?? 0),
        positive_outcomes_24h: Number(recallStats?.positive_outcomes_24h ?? 0),
        negative_outcomes_24h: Number(recallStats?.negative_outcomes_24h ?? 0),
        supported_actions_24h: Number(recallStats?.supported_actions_24h ?? 0),
        missing_memory_reports_24h: Number(recallStats?.missing_memory_reports_24h ?? 0),
        useful_memory_addr_count_24h: Number(recallStats?.useful_memory_addr_count_24h ?? 0),
        problem_memory_addr_count_24h: Number(recallStats?.problem_memory_addr_count_24h ?? 0),
      };
      await sql.begin(async (tx) => {
        for (const [key, value] of Object.entries(recallOutcomeSignals)) {
          if (key === "installed") continue;
          await tx`
            INSERT INTO graph_state (key, value, updated_at) VALUES (${`supercron_recall_${key}`}, ${String(value)}, now())
            ON CONFLICT (key) DO UPDATE SET value = ${String(value)}, updated_at = now()`;
          recallOutcomeSignalWrites += 1;
        }
      });
    }

    return {
      actions: sourceStats.length + sourceTaste.length + feedbackUpdated,
      details: {
        hot_clusters: clusters.length,
        source_stats: sourceStats.length,
        taste_entries: sourceTaste.length,
        feedback_updated: feedbackUpdated,
        recall_outcomes: recallOutcomeSignals,
        recall_outcome_signal_writes: recallOutcomeSignalWrites,
      },
    };
  });
}

// ============================================================
// TIER 3 — LLM-OPTIONAL PASSES
// ============================================================

function llmGuard(): PassResult | null {
  if (!getGoogleApiKey()) return { name: "", actions: 0, skipped: true, ms: 0, details: { reason: "no_api_key" } };
  return null;
}

// Pass 9: Tension Synthesis (from synthesizer.ts, bugs fixed)
async function pass9TensionSynthesis(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  const guard = llmGuard();
  if (guard) return { ...guard, name: "tension_synthesis" };
  if (budget.shouldSkipTier(3)) return { ...skip("time_exceeded"), name: "tension_synthesis" };

  return runPass("tension_synthesis", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // FIX: Single query fetches both nodes (not redundant like synthesizer.ts:120-121)
    const tensions = await sql`
      SELECT t.id, t.from_addr, t.to_addr, t.tension_type, t.tension, t.evidence,
        n1.label AS from_label, n1.substance->>'description' AS from_desc,
        n1.node_type AS from_type, n1.confidence AS from_conf,
        n2.label AS to_label, n2.substance->>'description' AS to_desc,
        n2.node_type AS to_type, n2.confidence AS to_conf
      FROM edge_tensions t
      JOIN nodes n1 ON n1.addr = t.from_addr
      JOIN nodes n2 ON n2.addr = t.to_addr
      WHERE t.synthesis IS NULL AND t.resolved_at IS NULL
        AND n1.visibility <> 'deleted'
        AND n2.visibility <> 'deleted'
      ORDER BY t.tension DESC, t.created_at ASC
      LIMIT 5`;

    let synthesized = 0;
    let attempted = 0;
    let budgetRejectedReason: string | null = null;
    for (const t of tensions) {
      if (shouldStop || budget.exceeded()) break;

      const prompt = `You are a knowledge synthesis engine. Two nodes in a knowledge graph are in "${t.tension_type}" tension (score: ${t.tension}).

NODE A: [${t.from_addr}] "${t.from_label}"
${t.from_desc || "No description"}

NODE B: [${t.to_addr}] "${t.to_label}"
${t.to_desc || "No description"}

Tension type: ${t.tension_type}
${t.evidence ? `Evidence: ${JSON.stringify(t.evidence).slice(0, 300)}` : ""}

Generate the SYNTHESIS - the insight that emerges from holding both sides at once. 1-3 sentences maximum. Be specific. Respond with ONLY the synthesis text.`;

      const budgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_FLASH_MICRO);
      if (budgetRejection) {
        budgetRejectedReason = String(budgetRejection.details.reason || "budget_would_exceed");
        break;
      }
      attempted++;

      let llmSpendRecorded = false;
      try {
        const llmResult = await callLLMWithModel(prompt, { model: "flash", temperature: 0.3, maxTokens: 1024 });
        await recordBudgetedLlmSpend(config, llmActualCostMicro(llmResult, LLM_ESTIMATE_FLASH_MICRO));
        llmSpendRecorded = true;
        const text = llmResult.text;

        // FIX: Check length before UPDATE (synthesizer.ts:88 silent failure)
        if (!text || text.length < 10) {
          console.log(`  [SYNTH] Empty for tension #${t.id}, skipping`);
          continue;
        }

        const baseConf = t.tension_type === "complement" ? 0.7 : t.tension_type === "constraint" ? 0.6 : 0.5;
        const confidence = Math.min(0.9, baseConf + (t.from_conf + t.to_conf) / 10);

        await sql`
          UPDATE edge_tensions SET synthesis = ${text}, synthesis_confidence = ${confidence}
          WHERE id = ${t.id}`;
        synthesized++;
      } catch (err: any) {
        if (isBudgetSpendRejected(err)) {
          budgetRejectedReason = err.reason;
          break;
        }
        if (err?.name === "ModelCooldownError") break;
        if (!llmSpendRecorded) {
          await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_FLASH_MICRO, "tension_synthesis");
        }
        console.log(`  [SYNTH] Error on #${t.id}: ${err?.message?.slice(0, 80)}`);
      }
    }

    return {
      actions: synthesized,
      llm_tokens_in: null,
      llm_tokens_out: null,
      llm_cost_usd_micro: null,
      details: {
        tensions_found: tensions.length,
        attempted,
        synthesized,
        ...(budgetRejectedReason ? { budget_rejected_remaining: Math.max(0, tensions.length - attempted) } : {}),
        ...(budgetRejectedReason ? budgetRejectedPassDetails(budgetRejectedReason) : {}),
      },
    };
  });
}

// Pass 10: Archetype Detection (from archetype-miner.ts, bug fixed)
interface ArchetypeDetectionCandidate {
  name: string;
  description: string;
  pyramids: string[];
  confidence: number;
}

function normalizeArchetypeDetectionCandidate(raw: unknown): ArchetypeDetectionCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const pyramids = Array.isArray(record.pyramids)
    ? record.pyramids.map((pyramid) => String(pyramid).trim()).filter(Boolean)
    : [];
  const confidenceValue = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? record.confidence
    : 0.7;
  if (!name) return null;
  return {
    name,
    description,
    pyramids,
    confidence: Math.max(0, Math.min(1, confidenceValue)),
  };
}

async function pass10ArchetypeDetection(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  const guard = llmGuard();
  if (guard) return { ...guard, name: "archetype_detection" };
  if (budget.shouldSkipTier(3)) return { ...skip("time_exceeded"), name: "archetype_detection" };

  return runPass("archetype_detection", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // Strategy 1: Capability clusters
    const capClusters = await sql`
      WITH provides AS (
        SELECT n.addr, n.label, n.pyramid_id,
          jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(n.substance->'provides') = 'array'
            THEN n.substance->'provides' ELSE '[]'::jsonb END
          ) AS capability
        FROM nodes n WHERE n.substance ? 'provides' AND n.visibility = 'public'
      )
      SELECT capability, count(DISTINCT pyramid_id)::int AS pyramid_count,
        array_agg(DISTINCT pyramid_id) AS pyramids
      FROM provides GROUP BY capability
      HAVING count(DISTINCT pyramid_id) >= 2
      ORDER BY pyramid_count DESC LIMIT 15`;

    // Strategy 2: Type distributions
    const typeDist = await sql`
      WITH type_pcts AS (
        SELECT pyramid_id, node_type, count(*)::int AS cnt,
          round(count(*)::numeric / sum(count(*)) OVER (PARTITION BY pyramid_id) * 100, 1) AS pct
        FROM nodes WHERE visibility = 'public'
        GROUP BY pyramid_id, node_type
      )
      SELECT * FROM type_pcts WHERE pct >= 15`;

    // Strategy 3: Cross-pyramid edges
    const bridges = await sql`
      SELECT e.edge_type, n1.pyramid_id AS from_pyramid, n2.pyramid_id AS to_pyramid,
        count(*)::int AS cnt
      FROM edges e
      JOIN nodes n1 ON n1.addr = e.from_addr
      JOIN nodes n2 ON n2.addr = e.to_addr
      WHERE n1.pyramid_id != n2.pyramid_id
        AND n1.visibility <> 'deleted'
        AND n2.visibility <> 'deleted'
      GROUP BY e.edge_type, n1.pyramid_id, n2.pyramid_id
      HAVING count(*) >= 3 ORDER BY cnt DESC LIMIT 15`;

    const patternCount = capClusters.length + typeDist.length + bridges.length;
    if (patternCount === 0) return { actions: 0, details: { patterns: 0 } };

    const summary = [
      ...capClusters.map((c: any) => `Capability "${c.capability}" in ${(c.pyramids as string[]).join(", ")}`),
      ...typeDist.map((t: any) => `Type "${t.node_type}" at ${t.pct}% in ${t.pyramid_id}`),
      ...bridges.map((b: any) => `${b.cnt}x "${b.edge_type}" bridges ${b.from_pyramid}→${b.to_pyramid}`),
    ].slice(0, 30).map((s, i) => `${i + 1}. ${s}`).join("\n");

    // FIX: Query registry for pyramid list instead of hardcoding (archetype-miner:176)
    const pyramidRows = await sql`SELECT DISTINCT pyramid_id FROM nodes WHERE visibility = 'public' ORDER BY pyramid_id`;
    const pyramidList = pyramidRows.map((r: any) => r.pyramid_id).join(", ");

    const prompt = `You are analyzing a knowledge graph with pyramids: ${pyramidList}.

Here are ${Math.min(30, patternCount)} detected cross-pyramid patterns:

${summary}

Identify 3-7 DEEP ARCHETYPES - recurring structural/conceptual patterns that transcend any single pyramid.
Return ONLY a JSON array: [{"name": "3-5 words", "description": "2-3 sentences", "pyramids": ["P1","P2"], "confidence": 0.7}]`;

    const budgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_FLASH_MICRO);
    if (budgetRejection) {
      return {
        actions: 0,
        llm_tokens_in: null,
        llm_tokens_out: null,
        llm_cost_usd_micro: null,
        details: { patterns: patternCount, ...budgetRejectedDetails(budgetRejection) },
      };
    }

    let llmSpendRecorded = false;
    try {
      const llmResult = await callLLMWithModel(prompt, { model: "flash", temperature: 0.2, maxTokens: 2048 });
      await recordBudgetedLlmSpend(config, llmActualCostMicro(llmResult, LLM_ESTIMATE_FLASH_MICRO));
      llmSpendRecorded = true;
      const raw = llmResult.text;
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return {
          actions: 0,
          llm_tokens_in: null,
          llm_tokens_out: null,
          llm_cost_usd_micro: null,
          details: { patterns: patternCount, parse_failed: true },
        };
      }

      const archetypes = JSON.parse(jsonMatch[0].replace(/,\s*]/g, "]").replace(/,\s*}/g, "}"));
      const llmRawArchetypeCount = Array.isArray(archetypes) ? archetypes.length : 0;
      const candidates = Array.isArray(archetypes)
        ? archetypes.map(normalizeArchetypeDetectionCandidate).filter((candidate): candidate is ArchetypeDetectionCandidate => Boolean(candidate))
        : [];
      let staged = 0;
      let duplicatesSuppressed = 0;
      let embeddedCandidates = 0;
      let fallbackNameDeduped = 0;
      let preEmbedExactNameSuppressed = 0;
      let semanticPathExactNameSuppressed = 0;
      let semanticDedupSuppressed = 0;
      let skippedEmptyText = 0;
      let embedCacheHits = 0;
      let embedSpendRecordedMicro = 0;
      let backfillMarkerInvalidated = false;
      const passWarnings: string[] = [];

      const expectedModel = EMBED_MODEL;
      const expectedTaskType = ARCHETYPE_DEDUP_EMBEDDING_TASK_TYPE;
      const markerKey = modelAwareArchetypeBackfillMarkerKey(expectedModel, expectedTaskType);
      const [marker] = await sql`
        SELECT value FROM graph_state
        WHERE key = ${markerKey}
        LIMIT 1
      `;

      let semanticDedupAvailable = Boolean(marker);
      if (!marker) {
        semanticDedupAvailable = false;
        passWarnings.push(`semantic_dedup_unavailable:missing_backfill_marker:${markerKey}`);
      } else {
        try {
          const calibration = loadArchetypeDedupCalibration();
          const cosineThresholdMatches = Math.abs(calibration.chosen_cosine_threshold - ARCHETYPE_DEDUP_COSINE_THRESHOLD)
            < ARCHETYPE_DEDUP_THRESHOLD_EPSILON;
          const pyramidJaccardMatches = Math.abs(calibration.chosen_pyramid_jaccard_min - ARCHETYPE_DEDUP_PYRAMID_JACCARD_MIN)
            < ARCHETYPE_DEDUP_THRESHOLD_EPSILON;
          if (!cosineThresholdMatches || !pyramidJaccardMatches) {
            semanticDedupAvailable = false;
            passWarnings.push("semantic_dedup_unavailable:calibration_constant_mismatch");
          }
        } catch (err: any) {
          semanticDedupAvailable = false;
          passWarnings.push(`semantic_dedup_unavailable:${err?.message?.slice(0, 180) || "invalid_calibration"}`);
        }
      }

      const withBackfillMarkerLock = async <T>(callback: (tx: any) => Promise<T>): Promise<T> => {
        return await sql.begin(async (tx: any) => {
          await tx`
            SELECT pg_advisory_xact_lock(${PROPOSAL_EMBEDDING_BACKFILL_LOCK_NAMESPACE}, ${PROPOSAL_EMBEDDING_BACKFILL_LOCK_ID})
          `;
          return await callback(tx);
        });
      };

      const auditBackfillMarkerInvalidated = async (tx: any, reason: string): Promise<void> => {
        // Required durability intentionally couples marker invalidation to audit
        // success: if the audit write fails, the marker DELETE rolls back too.
        await auditMutationFromWorker(tx as any, {
          kind: "admin_action",
          tenantId: config.cycleTenantId,
          actor: "supercron_daemon:archetype_detection",
          actorKind: "operator_token",
          operation: "supercron_archetype_backfill_marker_invalidated_on_fallback",
          eventData: {
            marker_key: markerKey,
            reason,
          },
        }, { durability: "required" });
      };

      const deleteBackfillMarkerInTx = async (tx: any, reason: string): Promise<boolean> => {
        const deletedMarkers = await tx`
          DELETE FROM graph_state
          WHERE key = ${markerKey}
          RETURNING key
        `;
        const deleted = deletedMarkers.length > 0;
        if (deleted) await auditBackfillMarkerInvalidated(tx, reason);
        return deleted;
      };

      const insertFallbackArchetypeProposal = async (
        proposalPayload: { name: string; description: string; pyramids: string[] },
        confidence: number,
        markerInvalidationReason: string,
        markerInvalidationMode: ArchetypeBackfillMarkerInvalidationMode = "when_inserted",
      ): Promise<{ inserted: boolean; markerInvalidated: boolean }> => {
        return await withBackfillMarkerLock(async (tx: any) => {
          const [existing] = await tx`
            SELECT id FROM proposals
            WHERE proposal_type = 'archetype'
              AND payload->>'name' = ${proposalPayload.name}
              AND status = ANY(${ARCHETYPE_DEDUP_SUPPRESSION_STATUSES}::text[])
            LIMIT 1
          `;
          let inserted = false;
          if (!existing) {
            await tx`
              INSERT INTO proposals (proposal_type, payload, confidence, discovered_by)
              VALUES ('archetype', ${tx.json(proposalPayload)}, ${confidence}, 'supercron')
            `;
            inserted = true;
          }
          const markerInvalidated = shouldInvalidateArchetypeBackfillMarkerAfterFallback({
            inserted,
            mode: markerInvalidationMode,
          })
            ? await deleteBackfillMarkerInTx(tx, markerInvalidationReason)
            : false;
          return { inserted, markerInvalidated };
        });
      };

      const readArchetypeDedupOrphanedPendingCount = async (): Promise<number> => {
        const [row] = await sql`
          SELECT count(*)::int AS orphaned_pending_count
          FROM proposals p
          WHERE p.proposal_type = 'archetype'
            AND p.status = ANY(${ARCHETYPE_DEDUP_SUPPRESSION_STATUSES}::text[])
            AND NOT EXISTS (
              SELECT 1
              FROM proposal_embeddings pe
              WHERE pe.proposal_id = p.id
                AND pe.purpose = ${ARCHETYPE_DEDUP_PURPOSE}
                AND pe.embedding_model = ${expectedModel}
                AND pe.embedding_task_type = ${expectedTaskType}
            )
        `;
        return Number(row?.orphaned_pending_count || 0);
      };

      for (const candidate of candidates) {
        const proposalPayload = archetypeStablePayload({
          name: candidate.name,
          description: candidate.description,
          pyramids: candidate.pyramids,
        });
        const canonicalText = archetypeCanonicalText(proposalPayload);
        if (!canonicalText) {
          skippedEmptyText++;
          continue;
        }

        if (!semanticDedupAvailable) {
          const fallback = await insertFallbackArchetypeProposal(
            proposalPayload,
            candidate.confidence,
            "semantic_dedup_fallback_inserted_without_embedding",
          );
          if (fallback.inserted) staged++;
          else {
            duplicatesSuppressed++;
            fallbackNameDeduped++;
          }
          if (fallback.markerInvalidated) {
            backfillMarkerInvalidated = true;
            semanticDedupAvailable = false;
          }
          continue;
        }

        const [preEmbedExactNameExisting] = await sql`
          SELECT id FROM proposals
          WHERE proposal_type = 'archetype'
            AND payload->>'name' = ${proposalPayload.name}
            AND status = ANY(${ARCHETYPE_DEDUP_SUPPRESSION_STATUSES}::text[])
          LIMIT 1
        `;
        if (preEmbedExactNameExisting) {
          duplicatesSuppressed++;
          preEmbedExactNameSuppressed++;
          continue;
        }

        let result: Awaited<ReturnType<typeof embedTextForInsert>>;
        const cachedEmbedResult = await embedTextForInsertFromCache(canonicalText);
        if (cachedEmbedResult) {
          if (!cachedEmbedResult.cacheHit) {
            throw new Error("embedTextForInsertFromCache returned cacheHit:false");
          }
          result = cachedEmbedResult;
          embedCacheHits++;
        } else {
          const estimateMicro = estimateEmbeddingCostMicro(canonicalText);
          const embeddingBudgetRejection = rejectIfLlmBudgetExceeded(config, estimateMicro);
          if (embeddingBudgetRejection) {
            passWarnings.push(`semantic_dedup_unavailable:budget:${embeddingBudgetRejection.details.reason || "budget_would_exceed"}`);
            const fallback = await insertFallbackArchetypeProposal(
              proposalPayload,
              candidate.confidence,
              "semantic_dedup_budget_fallback_inserted_without_embedding",
            );
            if (fallback.inserted) staged++;
            else {
              duplicatesSuppressed++;
              fallbackNameDeduped++;
            }
            if (fallback.markerInvalidated) {
              backfillMarkerInvalidated = true;
              semanticDedupAvailable = false;
            }
            continue;
          }

          try {
            result = await embedTextForInsert(canonicalText);
          } catch (err) {
            if (shouldRecordEmbeddingFailureSpend(err)) {
              try {
                await recordBudgetedLlmSpend(config, estimateMicro);
                embedSpendRecordedMicro += estimateMicro;
              } catch {
                // Failure-spend accounting is best-effort; preserve the embed error.
              }
            }
            throw err;
          }
          if (!result.cacheHit) {
            embedSpendRecordedMicro += await recordEmbeddingSpendIfBilled({
              cacheHit: result.cacheHit,
              estimateMicro,
              recordSpend: async (actualMicro) => {
                await recordBudgetedLlmSpend(config, actualMicro);
              },
            });
          } else {
            embedCacheHits++;
          }
        }
        if (result.model !== expectedModel || result.taskType !== expectedTaskType) {
          passWarnings.push(`semantic_dedup_unavailable:embed_runtime_mismatch:${result.model}:${result.taskType}`);
          semanticDedupAvailable = false;
          const fallback = await insertFallbackArchetypeProposal(
            proposalPayload,
            candidate.confidence,
            "embed_runtime_mismatch",
            "always",
          );
          if (fallback.inserted) staged++;
          else {
            duplicatesSuppressed++;
            fallbackNameDeduped++;
          }
          if (fallback.markerInvalidated) {
            backfillMarkerInvalidated = true;
            semanticDedupAvailable = false;
          }
          continue;
        }
        embeddedCandidates++;

        const insertResult = await sql.begin(async (tx: any): Promise<"inserted" | "exact_name_duplicate" | "semantic_duplicate"> => {
          const [exactNameExisting] = await tx`
            SELECT id FROM proposals
            WHERE proposal_type = 'archetype'
              AND payload->>'name' = ${proposalPayload.name}
              AND status = ANY(${ARCHETYPE_DEDUP_SUPPRESSION_STATUSES}::text[])
            LIMIT 1
          `;
          if (exactNameExisting) return "exact_name_duplicate";

          await tx`SET LOCAL hnsw.ef_search = 500`;
          const nearRows = await tx`
            SELECT
              p.id,
              p.payload,
              1 - (pe.embedding_hv <=> ${result.vecStr}::halfvec(3072)) AS cosine_similarity
            FROM proposal_embeddings pe
            JOIN proposals p ON p.id = pe.proposal_id
            WHERE pe.purpose = ${ARCHETYPE_DEDUP_PURPOSE}
              AND pe.embedding_model = ${expectedModel}
              AND pe.embedding_task_type = ${expectedTaskType}
              AND p.proposal_type = 'archetype'
              AND p.status = ANY(${ARCHETYPE_DEDUP_SUPPRESSION_STATUSES}::text[])
              AND (pe.embedding_hv <=> ${result.vecStr}::halfvec(3072)) <> 'NaN'::float8
              AND 1 - (pe.embedding_hv <=> ${result.vecStr}::halfvec(3072)) >= ${ARCHETYPE_DEDUP_COSINE_THRESHOLD}
            ORDER BY pe.embedding_hv <=> ${result.vecStr}::halfvec(3072)
            LIMIT 500
          `;
          const semanticDuplicate = (nearRows as any[]).some((row) => {
            const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
            const existingPyramids = Array.isArray((payload as any).pyramids)
              ? (payload as any).pyramids.map((pyramid: unknown) => String(pyramid))
              : [];
            const cosineSimilarity = Number(row.cosine_similarity || 0);
            return cosineSimilarity >= ARCHETYPE_DEDUP_COSINE_THRESHOLD
              && pyramidJaccard(proposalPayload.pyramids, existingPyramids) >= ARCHETYPE_DEDUP_PYRAMID_JACCARD_MIN;
          });
          if (semanticDuplicate) return "semantic_duplicate";

          const [insertedProposal] = await tx`
            INSERT INTO proposals (proposal_type, payload, confidence, discovered_by)
            VALUES ('archetype', ${tx.json(proposalPayload)}, ${candidate.confidence}, 'supercron')
            RETURNING id
          `;
          await tx`
            INSERT INTO proposal_embeddings (
              proposal_id,
              embedding_hv,
              embedding_model,
              embedding_task_type,
              embedded_text_hash,
              source_payload_hash,
              purpose,
              embedded_at
            )
            VALUES (
              ${insertedProposal.id},
              ${result.vecStr}::halfvec(3072),
              ${result.model},
              ${result.taskType},
              ${sha256Hex(canonicalText)},
              ${archetypeSourcePayloadHash(proposalPayload)},
              ${ARCHETYPE_DEDUP_PURPOSE},
              ${result.embeddedAt}
            )
          `;
          return "inserted";
        });
        if (insertResult === "inserted") staged++;
        else {
          duplicatesSuppressed++;
          if (insertResult === "exact_name_duplicate") semanticPathExactNameSuppressed++;
          else semanticDedupSuppressed++;
        }
      }

      const orphanedPendingEmbeddingCount = await readArchetypeDedupOrphanedPendingCount();
      if (orphanedPendingEmbeddingCount > 0) {
        passWarnings.push(`semantic_dedup_orphaned_pending:${orphanedPendingEmbeddingCount}`);
      }

      if (skippedEmptyText > 0) {
        passWarnings.push(`archetype_empty_descriptions:${skippedEmptyText}_skipped`);
      }

      return {
        actions: staged,
        llm_tokens_in: null,
        llm_tokens_out: null,
        llm_cost_usd_micro: null,
        details: {
          patterns: patternCount,
          llm_raw_count: llmRawArchetypeCount,
          archetypes: candidates.length,
          staged,
          duplicates_suppressed: duplicatesSuppressed,
          semantic_dedup_enabled: semanticDedupAvailable,
          semantic_dedup_marker_present: Boolean(marker),
          semantic_dedup_backfill_marker_invalidated: backfillMarkerInvalidated,
          semantic_dedup_orphaned_pending: orphanedPendingEmbeddingCount,
          embedded_candidates: embeddedCandidates,
          embed_cache_hits: embedCacheHits,
          embed_spend_recorded_micro: embedSpendRecordedMicro,
          fallback_name_deduped: fallbackNameDeduped,
          pre_embed_exact_name_suppressed: preEmbedExactNameSuppressed,
          semantic_path_exact_name_suppressed: semanticPathExactNameSuppressed,
          semantic_dedup_suppressed: semanticDedupSuppressed,
          skipped_empty_text: skippedEmptyText,
          ...(passWarnings.length > 0 ? { warnings: passWarnings } : {}),
        },
      };
    } catch (err: any) {
      if (isBudgetSpendRejected(err)) {
        return {
          actions: 0,
          llm_tokens_in: null,
          llm_tokens_out: null,
          llm_cost_usd_micro: null,
          details: { patterns: patternCount, ...budgetRejectedPassDetails(err.reason) },
        };
      }
      if (err?.name === "ModelCooldownError") {
        return {
          actions: 0,
          llm_tokens_in: null,
          llm_tokens_out: null,
          llm_cost_usd_micro: null,
          details: { model_cooldown: true },
        };
      }
      if (!llmSpendRecorded) {
        await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_FLASH_MICRO, "archetype_detection");
      }
      return {
        actions: 0,
        llm_tokens_in: null,
        llm_tokens_out: null,
        llm_cost_usd_micro: null,
        details: { error: err?.message?.slice(0, 100) },
      };
    }
  });
}

// Pass 11: Essence Compression (from lifecycle.ts, bugs fixed)
async function pass11EssenceCompression(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  const guard = llmGuard();
  if (guard) return { ...guard, name: "essence_compression" };
  if (budget.shouldSkipTier(3)) return { ...skip("time_exceeded"), name: "essence_compression" };

  return runPass("essence_compression", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    const [param] = await sql`SELECT value FROM graph_state WHERE key = 'lifecycle_absorption_dormant_days'`;
    const dormantDays = parseInt(param?.value || "180");

    const candidates = await sql`
      SELECT addr, label, substance, embedding_hv::text, parent_addr
      FROM nodes
      WHERE visibility = 'dormant' AND pinned = false
        AND node_type <> 'memory'
        AND dormant_at < now() - ${dormantDays + " days"}::INTERVAL
      LIMIT 3`;

    let absorbed = 0;
    let attempted = 0;
    let budgetRejectedReason: string | null = null;
    for (const node of candidates) {
      if (shouldStop || budget.exceeded()) break;
      if (!node.parent_addr) continue;

      // FIX: Validate parent exists AND is not dormant (lifecycle:85-90)
      const [parent] = await sql`
        SELECT addr, label, substance, embedding_hv::text FROM nodes
        WHERE addr = ${node.parent_addr} AND visibility NOT IN ('dormant', 'deleted', 'merged')`;
      if (!parent) {
        console.log(`  [ESSENCE] Parent ${node.parent_addr} not found/dormant for ${node.addr}, skipping`);
        continue;
      }

      const substance = typeof node.substance === "string" ? JSON.parse(node.substance) : (node.substance || {});
      const description = substance?.description || node.label;
      const domains = Array.isArray(substance?.domains) ? substance.domains.join(", ") : "general";

      let essence: string;
      let llmSpendRecorded = false;
      try {
        const budgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_FLASH_LITE_MICRO);
        if (budgetRejection) {
          budgetRejectedReason = String(budgetRejection.details.reason || "budget_would_exceed");
          break;
        }
        attempted++;
        const llmResult = await callFlashLiteWithModel(
          `This knowledge node is being retired from a knowledge graph.
Compress its core insight into a single sentence.
Node: ${node.label}  Description: ${description}  Domains: ${domains}
Return JSON: { "essence": "one sentence" }`,
          { jsonMode: true, temperature: 0.1, maxTokens: 256 },
        );
        await recordBudgetedLlmSpend(config, llmActualCostMicro(llmResult, LLM_ESTIMATE_FLASH_LITE_MICRO));
        llmSpendRecorded = true;
        const raw = llmResult.text;
        const parsed = JSON.parse(raw.trim());
        essence = parsed.essence || description.slice(0, 200);
      } catch (err: any) {
        if (isBudgetSpendRejected(err)) {
          budgetRejectedReason = err.reason;
          break;
        }
        if (!llmSpendRecorded) {
          await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_FLASH_LITE_MICRO, "essence_compression");
        }
        // FIX: Log embedding nudge failures (lifecycle:108-114)
        console.warn(`  [ESSENCE] Compression failed for ${node.addr}: ${err?.message?.slice(0, 80)}`);
        essence = description.slice(0, 200);
      }

      const parentSubstance = typeof parent.substance === "string" ? JSON.parse(parent.substance) : (parent.substance || {});
      const echoes = Array.isArray(parentSubstance.absorbed_echoes) ? parentSubstance.absorbed_echoes : [];
      echoes.push({ essence, original_addr: node.addr, absorbed_at: new Date().toISOString().split("T")[0] });
      parentSubstance.absorbed_echoes = echoes;
      const fallbackParentEmbed = await embedTextForInsert(
        embeddingTextForNode(parent.label || node.parent_addr, parentSubstance),
      );

      // Wrap in transaction for atomicity
      await sql.begin(async (tx) => {

        // F7: derived-vector nudge. The arithmetic blend (95% parent +
        // 5% child) is not a fresh text embed, so it gets the
        // DERIVED_NUDGE task type via embeddingMetadataForVectorWrite.
        // The substance update + embedding update + marker columns all
        // land in one statement (atomic per F7 contract). If the nudge
        // can't compute (missing/mismatched parent embedding), fall
        // back to a fresh document embedding computed before this
        // transaction.
        let embeddingUpdated = false;
        if (parent.embedding_hv && node.embedding_hv) {
          try {
            const parentEmb = parseEmbeddingStr(parent.embedding_hv);
            const childEmb = parseEmbeddingStr(node.embedding_hv);
            if (parentEmb.length === childEmb.length && parentEmb.length > 0) {
              const nudged = parentEmb.map((v, i) => v * 0.95 + childEmb[i] * 0.05);
              const nudgedStr = `[${nudged.join(",")}]`;
              const nudgeMeta = embeddingMetadataForVectorWrite("DERIVED_NUDGE");
              await tx`
                UPDATE nodes SET
                  substance = ${tx.json(parentSubstance)},
                  embedding_hv = ${nudgedStr}::halfvec(3072),
                  embedding_at = ${nudgeMeta.embeddedAt},
                  embedding_model = ${nudgeMeta.model},
                  embedding_task_type = ${nudgeMeta.taskType}
                WHERE addr = ${node.parent_addr}`;
              embeddingUpdated = true;
            } else {
              console.log(`  [ESSENCE] Embedding dimension mismatch for ${node.addr} (${parentEmb.length} vs ${childEmb.length})`);
            }
          } catch (err: any) {
            console.log(`  [ESSENCE] Embedding nudge failed for ${node.addr}: ${err?.message?.slice(0, 60)}`);
          }
        }

        if (!embeddingUpdated) {
          await tx`
            UPDATE nodes SET
              substance = ${tx.json(parentSubstance)},
              embedding_hv = ${fallbackParentEmbed.vecStr}::halfvec(3072),
              embedding_at = ${fallbackParentEmbed.embeddedAt},
              embedding_model = ${fallbackParentEmbed.model},
              embedding_task_type = ${fallbackParentEmbed.taskType}
            WHERE addr = ${node.parent_addr}`;
        }

        await tx`
          INSERT INTO absorbed_echoes (parent_addr, original_addr, original_label, essence)
          VALUES (${node.parent_addr}, ${node.addr}, ${node.label}, ${essence})`;

        // Cleanup
        const edgeRows = await tx`SELECT id FROM edges WHERE from_addr = ${node.addr} OR to_addr = ${node.addr}`;
        await deleteEdgesByIds(sql as any, edgeRows.map((row: any) => row.id), { tx: tx as any });
        await tx`SELECT pg_advisory_xact_lock(1448301577, 1213744177)`;
        await tx`DELETE FROM stimulus_contributions WHERE node_addr = ${node.addr}`;
        await tx`DELETE FROM nodes WHERE addr = ${node.addr}`;
      });

      absorbed++;
      console.log(`  [ESSENCE] Absorbed ${node.addr} "${node.label}" → ${node.parent_addr}`);
    }

    return {
      actions: absorbed,
      llm_tokens_in: null,
      llm_tokens_out: null,
      llm_cost_usd_micro: null,
      details: {
        candidates: candidates.length,
        attempted,
        absorbed,
        ...(budgetRejectedReason ? { budget_rejected_remaining: Math.max(0, candidates.length - attempted) } : {}),
        ...(budgetRejectedReason ? budgetRejectedPassDetails(budgetRejectedReason) : {}),
      },
    };
  });
}

// Pass 12: Distiller Fusion (bounded semantic audit packets from distiller-phase1.ts)
// Only runs on CROSS cycles — fusion is not pyramid-scoped and callPro is expensive (~14s/call)
async function pass12DistillerFusion(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  if (config.pyramidFocus !== MINING_CROSS_MODE) return { ...skip("cross_only"), name: "distiller_fusion" };
  const guard = llmGuard();
  if (guard) return { ...guard, name: "distiller_fusion" };
  if (budget.shouldSkipTier(3)) return { ...skip("time_exceeded"), name: "distiller_fusion" };

  return runPass("distiller_fusion", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    const [queueRow] = await sql`
      SELECT count(*)::int AS cnt
      FROM distill_proposals
      WHERE status IN ('open', 'deferred')
        AND handoff_status <> 'submitted'
        AND fusion_status IN ('none', 'pending', 'deferred', 'blocked')
    `;
    const queuedPackets = Number(queueRow?.cnt || 0);
    if (queuedPackets >= DISTILLER_FUSION_QUEUE_CAP) {
      return {
        actions: 0,
        details: {
          skipped: "queue_cap",
          queued_packets: queuedPackets,
          queue_cap: DISTILLER_FUSION_QUEUE_CAP,
        },
      };
    }

    const budgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_DISTILLER_FUSION_PASS_MICRO);
    if (budgetRejection) {
      return {
        actions: 0,
        details: budgetRejectedDetails(budgetRejection),
      };
    }

    let result: DistillerRunResult;
    try {
      result = await runDistillerPass(
        sql,
        buildDistillerFusionPassOptions(() => !shouldStop && !budget.exceeded()),
      );
    } catch (err: any) {
      if (err?.name !== "ModelCooldownError") {
        await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_DISTILLER_FUSION_PASS_MICRO, "distiller_fusion");
      }
      throw err;
    }
    if (result.fusionJudgments > 0) {
      await recordBudgetedLlmSpend(config, LLM_ESTIMATE_DISTILLER_FUSION_PASS_MICRO);
    }

    return formatDistillerFusionPassResult(result);
  });
}

// Pass 14: Memory Merge — Tenant memory consolidation proposals (gated: once per 24h)
// Finds pairs of highly similar tenant memories and queues review proposals.
// Default mode is intentionally non-mutating until merge application is atomic.
async function pass14MemoryMerge(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  const guard = llmGuard();
  if (guard) return { ...guard, name: "memory_merge" };
  if (budget.shouldSkipTier(3)) return { ...skip("time_exceeded"), name: "memory_merge" };

  return runPass("memory_merge", async () => {
    if (config.dryRun) return { actions: 0, details: { dry_run: true } };

    // Gate: 24h since last merge
    const [lastMerge] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_last_memory_merge'`;
    const lastMergeAt = lastMerge?.value ? new Date(lastMerge.value) : new Date(0);
    const hoursSinceLastMerge = (Date.now() - lastMergeAt.getTime()) / 3600000;
    if (hoursSinceLastMerge < 24) {
      return { actions: 0, details: { reason: "gate_24h", hours_remaining: Math.round(24 - hoursSinceLastMerge) } };
    }

    // Adaptive threshold: more aggressive when memory count is high
    const [{ cnt: memCount }] = await sql`
      SELECT COUNT(*) AS cnt FROM nodes
      WHERE node_type = 'memory' AND space_id LIKE 'tenant:%' AND dormant_at IS NULL`;
    const activeCount = parseInt(memCount);
    // Higher threshold for large memory counts: cosine cosines easily fire
    // 0.72-0.83 on shared vocabulary (e.g. "Vercel", "Hermes", "the operator") even
    // when the underlying facts are distinct. Production QC of 1039-active-
    // memory runs showed ~80% noise below 0.85; require strong similarity
    // to make even same-type pairs candidates.
    const mergeThreshold = activeCount > 150 ? 0.85 : 0.78;

    // Step 1: Find similar pairs (not transitive clusters — direct pairs only)
    const pairs = await sql`
      SELECT a.addr AS a_addr, b.addr AS b_addr,
        CASE WHEN a.created_at > b.created_at THEN a.addr ELSE b.addr END AS survivor_addr,
        CASE WHEN a.created_at > b.created_at THEN b.addr ELSE a.addr END AS loser_addr,
        a.label AS a_label, b.label AS b_label,
        a.substance->>'description' AS a_desc,
        b.substance->>'description' AS b_desc,
        a.substance->>'memory_type' AS a_type,
        b.substance->>'memory_type' AS b_type,
        a.created_at AS a_created, b.created_at AS b_created,
        (
          COALESCE(a_mr.accepted_by_user, false) = true
          OR COALESCE(a_mr.source_kind = 'user_accepted', false)
          OR COALESCE(a_mr.kind = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[]), false)
          OR COALESCE(a.pinned, false) = true
          OR COALESCE(a.substance->>'maturity_stage' = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[]), false)
        ) AS a_protected,
        (
          COALESCE(b_mr.accepted_by_user, false) = true
          OR COALESCE(b_mr.source_kind = 'user_accepted', false)
          OR COALESCE(b_mr.kind = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[]), false)
          OR COALESCE(b.pinned, false) = true
          OR COALESCE(b.substance->>'maturity_stage' = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[]), false)
        ) AS b_protected,
        1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) AS sim
      FROM nodes a
      JOIN nodes b ON b.addr > a.addr
        AND b.node_type = 'memory'
        AND b.space_id = a.space_id
        AND b.dormant_at IS NULL
        AND b.embedding_hv IS NOT NULL
      LEFT JOIN memory_registry a_mr
        ON a_mr.addr = a.addr
        AND a_mr.tenant_id = substring(a.space_id from 8)
      LEFT JOIN memory_registry b_mr
        ON b_mr.addr = b.addr
        AND b_mr.tenant_id = substring(b.space_id from 8)
      WHERE a.node_type = 'memory'
        AND a.space_id LIKE 'tenant:%'
        AND a.dormant_at IS NULL
        AND a.embedding_hv IS NOT NULL
        AND COALESCE(a.substance->>'memory_type', '') NOT IN ('digest', 'changelog')
        AND COALESCE(b.substance->>'memory_type', '') NOT IN ('digest', 'changelog')
        AND COALESCE(a.substance->>'memory_type', '') = COALESCE(b.substance->>'memory_type', '')
        AND 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) > ${mergeThreshold}
        AND (a.embedding_hv::vector <=> b.embedding_hv::vector) <> 'NaN'::float
        AND NOT (
          (
            COALESCE(a_mr.accepted_by_user, false) = true
            OR COALESCE(a_mr.source_kind = 'user_accepted', false)
            OR COALESCE(a_mr.kind = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[]), false)
            OR COALESCE(a.pinned, false) = true
            OR COALESCE(a.substance->>'maturity_stage' = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[]), false)
          )
          AND (
            COALESCE(b_mr.accepted_by_user, false) = true
            OR COALESCE(b_mr.source_kind = 'user_accepted', false)
            OR COALESCE(b_mr.kind = ANY(${AUTOMATED_DORMANCY_PROTECTED_KIND_LIST}::text[]), false)
            OR COALESCE(b.pinned, false) = true
            OR COALESCE(b.substance->>'maturity_stage' = ANY(${AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST}::text[]), false)
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM proposals existing
          WHERE existing.proposal_type = 'node_edit'
            AND existing.status IN ('pending', 'approved')
            AND (
              (
                existing.from_addr = CASE WHEN a.created_at > b.created_at THEN a.addr ELSE b.addr END
                AND existing.to_addr = CASE WHEN a.created_at > b.created_at THEN b.addr ELSE a.addr END
              )
              OR (
                existing.from_addr = CASE WHEN a.created_at > b.created_at THEN b.addr ELSE a.addr END
                AND existing.to_addr = CASE WHEN a.created_at > b.created_at THEN a.addr ELSE b.addr END
              )
            )
            AND existing.payload->>'action' IN ('memory_merge', 'tenant_memory_supersession')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM memory_events me
          WHERE me.addr IN (a.addr, b.addr)
            AND me.tenant_id = substring(a.space_id from 8)
            AND me.correlation_id LIKE 'supercron-%-rollback'
            AND me.created_at > now() - interval '30 days'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM proposals rejected
          WHERE rejected.proposal_type = 'node_edit'
            AND rejected.status = 'rejected'
            AND COALESCE(rejected.reviewed_at, rejected.created_at) > now() - interval '30 days'
            AND (
              (
                rejected.from_addr = CASE WHEN a.created_at > b.created_at THEN a.addr ELSE b.addr END
                AND rejected.to_addr = CASE WHEN a.created_at > b.created_at THEN b.addr ELSE a.addr END
              )
              OR (
                rejected.from_addr = CASE WHEN a.created_at > b.created_at THEN b.addr ELSE a.addr END
                AND rejected.to_addr = CASE WHEN a.created_at > b.created_at THEN a.addr ELSE b.addr END
              )
            )
            AND rejected.payload->>'action' IN ('memory_merge', 'tenant_memory_supersession')
        )
      ORDER BY 1 - (a.embedding_hv::vector <=> b.embedding_hv::vector) DESC
      LIMIT 30`;

    if (pairs.length === 0) {
      await sql`INSERT INTO graph_state (key, value) VALUES ('supercron_last_memory_merge', ${new Date().toISOString()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      return { actions: 0, details: { active_memories: activeCount, threshold: mergeThreshold, pairs_found: 0 } };
    }

    // Step 2: propose pairs — each addr can only participate in one proposal per cycle.
    // Pairs are processed by similarity desc; skipped second-best pairs are reconsidered
    // on a later cycle after any approved merge changes the survivor text.
    // The default path is proposal-only: no survivor edits, loser dormancy,
    // maturity changes, or edge rewrites happen here.
    const consumed = new Set<string>();
    let attempted = 0;
    let completed = 0;
    let proposed = 0;
    let duplicateSkipped = 0;
    let protectedSkipped = 0;
    let skippedEmpty = 0;
    let skippedTopics = 0;
    let skippedShort = 0;
    let failed = 0;
    let cooldownHit = false;
    let budgetRejectedReason: string | null = null;
    let labelBudgetRejected = 0;
    const candidateAddrs = [...new Set(pairs.flatMap((p: any) => [String(p.a_addr), String(p.b_addr)]))];
    const involvedEdges = candidateAddrs.length > 0 ? await sql`
      SELECT from_addr, to_addr
      FROM edges
      WHERE from_addr = ANY(${candidateAddrs}::text[])
         OR to_addr = ANY(${candidateAddrs}::text[])` : [];

    for (const p of pairs) {
      if (shouldStop || budget.exceeded()) break;
      if (consumed.has(p.a_addr) || consumed.has(p.b_addr)) continue;

      // Determine survivor (newest) and loser (oldest)
      const aIsNewer = p.survivor_addr === p.a_addr;
      const survivor = {
        addr: aIsNewer ? p.a_addr : p.b_addr,
        label: aIsNewer ? p.a_label : p.b_label,
        desc: aIsNewer ? p.a_desc : p.b_desc,
        type: aIsNewer ? p.a_type : p.b_type,
        created_at: aIsNewer ? p.a_created : p.b_created,
        protected: Boolean(aIsNewer ? p.a_protected : p.b_protected),
      };
      const loser = {
        addr: aIsNewer ? p.b_addr : p.a_addr,
        label: aIsNewer ? p.b_label : p.a_label,
        desc: aIsNewer ? p.b_desc : p.a_desc,
        type: aIsNewer ? p.b_type : p.a_type,
        created_at: aIsNewer ? p.b_created : p.a_created,
        protected: Boolean(aIsNewer ? p.b_protected : p.a_protected),
      };
      if (survivor.protected && loser.protected) {
        protectedSkipped++;
        continue;
      }
      const [existingMemoryMergeProposal] = await sql`
        SELECT 1
        FROM proposals existing
        WHERE existing.proposal_type = 'node_edit'
          AND existing.status IN ('pending', 'approved')
          AND (
            (
              existing.from_addr = ${survivor.addr}
              AND existing.to_addr = ${loser.addr}
            )
            OR (
              existing.from_addr = ${loser.addr}
              AND existing.to_addr = ${survivor.addr}
            )
          )
          AND existing.payload->>'action' IN ('memory_merge', 'tenant_memory_supersession')
        LIMIT 1`;
      if (existingMemoryMergeProposal) {
        consumed.add(p.a_addr);
        consumed.add(p.b_addr);
        completed++;
        duplicateSkipped++;
        continue;
      }

      const similarity = Math.max(0, Math.min(1, Number(p.sim)));
      const similarityLabel = similarity.toFixed(3);
      const mergePrompt =
        `You are merging two overlapping memories from a knowledge graph into one canonical statement.\n\n` +
        `Default to SKIP when in doubt. Only merge when both memories describe the SAME specific subject, event, or fact — not merely the same topic.\n\n` +
        `Rules:\n` +
        `- Output SKIP if the memories describe different specific entities, even if they share topical vocabulary (e.g. both mention "Vercel" but one is about a personal account and the other is about a product deployment — that is SKIP)\n` +
        `- Output SKIP if either memory contains specific details (names, addresses, dates, IDs) absent from the other\n` +
        `- Output SKIP if the merged statement would have to be one source's content with the other source ignored\n` +
        `- Merge only when both memories assert the same fact and the merged statement preserves ALL specific details from BOTH\n` +
        `- If they agree on the same fact, combine into the most complete version under 250 characters\n` +
        `- If they contradict on the same fact, keep only the NEWEST version\n` +
        `- Output ONLY the merged statement, nothing else (no commentary, no preamble)\n\n` +
        `[${loser.created_at}] [${loser.type || "context"}]: ${(loser.desc || "").slice(0, 400)}\n` +
        `[${survivor.created_at}] [${survivor.type || "context"}]: ${(survivor.desc || "").slice(0, 400)}`;

      let mergeSpendRecorded = false;
      try {
        const mergeBudgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_FLASH_LITE_MICRO);
        if (mergeBudgetRejection) {
          budgetRejectedReason = String(mergeBudgetRejection.details.reason || "budget_would_exceed");
          break;
        }
        attempted++;
        const mergeResult = await callFlashLiteWithModel(mergePrompt, { temperature: 0.1, maxTokens: 300 });
        await recordBudgetedLlmSpend(config, llmActualCostMicro(mergeResult, LLM_ESTIMATE_FLASH_LITE_MICRO));
        mergeSpendRecorded = true;
        const mergeText = typeof mergeResult.text === "string" ? mergeResult.text : "";
        const trimmed = mergeText.trim().replace(/^["']|["']$/g, "");

        if (!trimmed || trimmed === "SKIP" || trimmed.length < 15) {
          if (!trimmed) skippedEmpty++;
          else if (trimmed === "SKIP") skippedTopics++;
          else skippedShort++;
          const skipReason = !trimmed ? "empty response" : trimmed === "SKIP" ? "topics differ" : "short response";
          console.log(`  [MERGE] Skip: ${p.a_addr} + ${p.b_addr} (sim=${similarityLabel}) — ${skipReason}`);
          consumed.add(p.a_addr);
          consumed.add(p.b_addr);
          completed++;
          continue;
        }

        // Post-merge balance check: a valid merge must contain meaningful
        // content from BOTH sources. If the merged text overlaps strongly
        // with one source description and weakly with the other, the LLM
        // ignored the second source — that is a "one-sided" merge that
        // discards information rather than canonicalizing it. Reject.
        const survivorOverlap = tokenJaccard(trimmed, survivor.desc || "");
        const loserOverlap = tokenJaccard(trimmed, loser.desc || "");
        const minOverlap = Math.min(survivorOverlap, loserOverlap);
        if (minOverlap < 0.18) {
          skippedTopics++;
          console.log(
            `  [MERGE] Skip: ${p.a_addr} + ${p.b_addr} (sim=${similarityLabel}) — one-sided merge ` +
              `(survivor=${survivorOverlap.toFixed(2)}, loser=${loserOverlap.toFixed(2)})`,
          );
          consumed.add(p.a_addr);
          consumed.add(p.b_addr);
          completed++;
          continue;
        }

        // Generate label
        let newLabel = `[${(survivor.type || "CONTEXT").toUpperCase()}] ${trimmed.slice(0, 80)}`;
        let labelSpendRecorded = false;
        try {
          const labelBudgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_FLASH_LITE_MICRO);
          if (labelBudgetRejection) {
            labelBudgetRejected++;
          } else {
            const labelResult = await callFlashLiteWithModel(
              `Write a concise label (max 70 chars) for this memory. Just the label, nothing else:\n\n"${trimmed}"`,
              { temperature: 0.1, maxTokens: 80 },
            );
            await recordBudgetedLlmSpend(config, llmActualCostMicro(labelResult, LLM_ESTIMATE_FLASH_LITE_MICRO));
            labelSpendRecorded = true;
            const cleanLabel = (labelResult.text || "").trim().replace(/^["']|["']$/g, "");
            if (cleanLabel && cleanLabel.length >= 10) {
              newLabel = `[${(survivor.type || "CONTEXT").toUpperCase()}] ${cleanLabel.slice(0, 80)}`;
            }
          }
        } catch (err: any) {
          if (isBudgetSpendRejected(err)) labelBudgetRejected++;
          else if (err?.name !== "ModelCooldownError" && !labelSpendRecorded) {
            await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_FLASH_LITE_MICRO, "memory_merge_label");
          }
          // label generation is best-effort
        }

        const typePrefix = `[${(survivor.type || "CONTEXT").toUpperCase()}] `;
        const mergedDesc = trimmed.startsWith("[") ? trimmed : typePrefix + trimmed;

        const involvedEdgesCount = involvedEdges.filter((edge: any) =>
          edge.from_addr === survivor.addr
          || edge.from_addr === loser.addr
          || edge.to_addr === survivor.addr
          || edge.to_addr === loser.addr
        ).length;

        const [proposal] = await sql`
          INSERT INTO proposals (
            proposal_type,
            from_addr,
            to_addr,
            target_addr,
            payload,
            confidence,
            discovered_by,
            evidence
          )
          SELECT
            'node_edit',
            ${survivor.addr},
            ${loser.addr},
            ${survivor.addr},
            ${sql.json({
              action: "memory_merge",
              mode: "proposal_only",
              survivor: {
                addr: survivor.addr,
                label: survivor.label,
                memory_type: survivor.type,
                description: survivor.desc,
                created_at: survivor.created_at,
              },
              loser: {
                addr: loser.addr,
                label: loser.label,
                memory_type: loser.type,
                description: loser.desc,
                created_at: loser.created_at,
              },
              similarity,
              threshold: mergeThreshold,
              merged_assertion: mergedDesc,
              proposed_label: newLabel.slice(0, 120),
              embedding_contract: {
                mode: "applier_reembed",
                source_text_field: "merged_assertion",
                embedding_model_at_proposal_time: EMBED_MODEL,
              },
              involved_edges_count: involvedEdgesCount,
              involved_edges_contract: {
                mode: "applier_requery",
                count_is_informational: true,
              },
              protected_status_flags: {
                survivor_protected: survivor.protected,
                loser_protected: loser.protected,
              },
              review_required: true,
            })}::jsonb,
            ${similarity},
            'supercron',
            jsonb_build_array(jsonb_build_object(
              'type', 'memory_merge_candidate',
              'cycle_number', ${config.cycleNumber}::int,
              'timestamp', now(),
              'similarity', ${similarity}::float8,
              'threshold', ${mergeThreshold}::float8,
              'survivor_addr', ${survivor.addr}::text,
              'loser_addr', ${loser.addr}::text,
              'involved_edges_count', ${involvedEdgesCount}::int,
              'llm_model', ${mergeResult.modelId}::text
            ))
          WHERE NOT EXISTS (
            SELECT 1
            FROM proposals existing
            WHERE existing.proposal_type = 'node_edit'
              AND existing.status IN ('pending', 'approved')
              AND (
                (
                  existing.from_addr = ${survivor.addr}
                  AND existing.to_addr = ${loser.addr}
                )
                OR (
                  existing.from_addr = ${loser.addr}
                  AND existing.to_addr = ${survivor.addr}
                )
              )
              AND existing.payload->>'action' IN ('memory_merge', 'tenant_memory_supersession')
          )
          RETURNING id`;

        consumed.add(p.a_addr);
        consumed.add(p.b_addr);
        completed++;
        if (proposal) {
          proposed++;
          console.log(`  [MERGE] proposed ${loser.addr} → ${survivor.addr} (sim=${similarityLabel}): ${trimmed.slice(0, 80)}`);
        } else {
          duplicateSkipped++;
          console.log(`  [MERGE] duplicate proposal skipped ${loser.addr} → ${survivor.addr}`);
        }
      } catch (err: any) {
        if (isBudgetSpendRejected(err)) {
          budgetRejectedReason = err.reason;
          break;
        }
        if (err?.name === "ModelCooldownError") {
          cooldownHit = true;
          break;
        }
        if (!mergeSpendRecorded) {
          await recordEstimatedLlmSpendAfterFailure(config, LLM_ESTIMATE_FLASH_LITE_MICRO, "memory_merge");
        }
        failed++;
        console.log(`  [MERGE] Error on ${p.a_addr}+${p.b_addr}: ${err?.message?.slice(0, 80)}`);
      }

      // Rate-limit Flash-Lite quota even after transient failures.
      await new Promise(r => setTimeout(r, 300));
    }

    // Update gate timestamp only after at least one pair completes. A
    // transient model/DB failure should not suppress the next retry for 24h.
    if (completed > 0) {
      await sql`INSERT INTO graph_state (key, value) VALUES ('supercron_last_memory_merge', ${new Date().toISOString()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }

    return {
      actions: proposed,
      // memory_merge proposals have no automatic applier yet, so they are
      // deliberately excluded from PR12 cooldown pressure until that signal exists.
      proposals_created: 0,
      proposals_applied: 0,
      details: {
        active_memories: activeCount,
        threshold: mergeThreshold,
        pairs_found: pairs.length,
        attempted,
        completed,
        proposed,
        merged: 0,
        failed,
        rolled_back: 0,
        duplicate_skipped: duplicateSkipped,
        protected_skipped: protectedSkipped,
        skipped_empty: skippedEmpty,
        skipped_topics: skippedTopics,
        skipped_short: skippedShort,
        cooldown_hit: cooldownHit,
        label_budget_rejected: labelBudgetRejected,
        ...(cooldownHit ? { cooldown_after_attempted: attempted } : {}),
        ...(budgetRejectedReason ? { budget_rejected_remaining: Math.max(0, pairs.length - attempted) } : {}),
        ...(budgetRejectedReason ? budgetRejectedPassDetails(budgetRejectedReason) : {}),
      },
    };
  });
}

// ============================================================
// TIER 4 — REPORTING
// ============================================================

// Pass 13: Digest + State
async function pass13Digest(config: SupercronConfig, results: PassResult[]): Promise<PassResult> {
  return runPass("digest", async () => {
    const totalActions = results.reduce((sum, r) => sum + r.actions, 0);
    const budgetDelta = budgetDeltaSummary(config);
    const summary = results
      .filter(r => !r.skipped || r.details.reason !== "time_exceeded")
      .map(r => `${r.name}: ${r.skipped ? "skipped" : `${r.actions} actions`} (${r.ms}ms)`)
      .join(", ");

    if (!config.dryRun) {
      // Write digest memory via /remember API if there were actions.
      //
      // F2: the bearer token is env-driven (no example-tenant literal).
      // Operator's local `.env` carries
      // `VERITY_SUPERCRON_API_TOKEN=<their tenant credential>`. When
      // unset, skip the /remember POST — graph_state still records
      // the cycle below, so the cron run is observable without it.
      const supercronApiToken = (process.env.VERITY_SUPERCRON_API_TOKEN || "").trim();
      if (totalActions > 0 && supercronApiToken) {
        try {
          const resp = await fetch("http://localhost:3100/remember", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${supercronApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              description: `SuperCron cycle #${config.cycleNumber} (${config.pyramidFocus}): ${totalActions} actions. ${summary}`,
              memory_type: "changelog",
              label: `SuperCron #${config.cycleNumber}`,
            }),
          });
          if (!resp.ok) console.log(`  [DIGEST] Remember API: ${resp.status}`);
        } catch {
          // Non-critical
        }
      } else if (totalActions > 0) {
        console.log("  [DIGEST] VERITY_SUPERCRON_API_TOKEN unset — skipping /remember POST");
      }

      // Update graph_state
      await sql`
        INSERT INTO graph_state (key, value) VALUES ('supercron_cycle_number', ${String(config.cycleNumber)})
        ON CONFLICT (key) DO UPDATE SET value = ${String(config.cycleNumber)}`;
      await sql`
        INSERT INTO graph_state (key, value) VALUES ('supercron_last_pyramid', ${config.pyramidFocus})
        ON CONFLICT (key) DO UPDATE SET value = ${config.pyramidFocus}`;
      await sql`
        INSERT INTO graph_state (key, value) VALUES ('supercron_last_run_at', ${new Date().toISOString()})
        ON CONFLICT (key) DO UPDATE SET value = ${new Date().toISOString()}`;
    }

    return {
      actions: totalActions > 0 ? 1 : 0,
      details: {
        total_actions: totalActions,
        summary,
        cycle_spend_micro: budgetDelta.cycleSpendMicro,
        cycle_remaining_micro: budgetDelta.cycleRemainingMicro,
        cycle_daily_spend_micro: budgetDelta.cycleDailySpendMicro,
        cycle_manual_spend_micro: budgetDelta.cycleManualSpendMicro,
        pyramid_override_violates_policy: config.pyramidOverrideViolatesPolicy,
      },
    };
  });
}

async function passTrendMaintenance(config: SupercronConfig): Promise<PassResult> {
  const t0 = Date.now();
  if (config.dryRun) {
    return { name: "trend_maintenance", actions: 0, skipped: true, ms: 0, details: { reason: "dry_run" } };
  }
  try {
    const trendService = await import("./trends/service");
    closeLoadedTrendService = trendService.closeTrendService;
    const result = await trendService.runTrendMaintenance({
      budget: {
        estimateFlashLiteMicro: LLM_ESTIMATE_FLASH_LITE_MICRO,
        evaluateBudgetCheck: (estimatedMicro: number) =>
          config.budgetCache.evaluateBudgetCheck(estimatedMicro, llmBudgetOptions(config)),
        recordLlmSpend: (actualMicro: number) => recordBudgetedLlmSpend(config, actualMicro),
        actualCostMicro: (result: LLMResult, fallbackMicro: number) => llmActualCostMicro(result, fallbackMicro),
      },
    });
    const actions =
      result.clusteredStandalones
      + result.birthed
      + result.adopted
      + result.archived
      + result.synced
      + result.cleanedEdges
      + result.duplicateCandidates;
    return { name: "trend_maintenance", actions, skipped: false, ms: Date.now() - t0, details: result as unknown as Record<string, unknown> };
  } catch (err: any) {
    const msg = err?.message?.slice(0, 120) || "unknown";
    if (msg.startsWith("trend_budget_")) {
      const reason = msg.slice("trend_budget_".length) || "budget_would_exceed";
      return {
        name: "trend_maintenance",
        actions: 0,
        skipped: true,
        ms: Date.now() - t0,
        details: budgetRejectedPassDetails(reason),
      };
    }
    console.error(`  [trend_maintenance] Error: ${msg}`);
    return { name: "trend_maintenance", actions: 0, skipped: true, ms: Date.now() - t0, details: { error: msg } };
  }
}

function roundGoldenMetric(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function uniqueAddrs(addrs: string[]): string[] {
  return [...new Set(addrs.map((addr) => String(addr || "").trim()).filter(Boolean))];
}

// Token-set Jaccard over alphanumeric tokens of length > 2.
// Used by pass14_memory_merge to detect "one-sided" merges where the LLM
// kept one source's content and ignored the other.
function tokenJaccard(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      (s || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    );
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

async function fetchGoldenQueryCases(db: DirectSql, tenantId?: string): Promise<GoldenQueryCaseFetch> {
  // MT9: scope the golden corpus to ONE tenant when tenantId is given, so a tenant's
  // SuperCron cycle grades ONLY its own golden cases (not every tenant's) and an
  // empty corpus is honestly empty FOR THAT TENANT. Unset = operator-wide (unchanged).
  const tid = tenantId ?? null;
  const rows = await db`
    SELECT
      c.id,
      c.slug,
      c.tenant_id,
      c.space_id,
      c.agent_id,
      c.query,
      c.k,
      c.revision,
      latest_expectations.expectation_revision,
      count(*) OVER()::int AS active_cases_total,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'expectation_type', e.expectation_type,
            'addr', e.addr,
            'match_mode', e.match_mode,
            'expectation_rank', e.expectation_rank
          )
          ORDER BY e.expectation_type, e.expectation_rank, e.addr
        ) FILTER (WHERE e.id IS NOT NULL),
        '[]'::jsonb
      ) AS expectations
    FROM golden_query_cases c
    LEFT JOIN LATERAL (
      SELECT max(expectation_revision)::int AS expectation_revision
      FROM golden_query_expectations
      WHERE case_id = c.id
    ) latest_expectations ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_graded_at
      FROM golden_query_runs r
      WHERE r.case_id = c.id
    ) lg ON true
    LEFT JOIN golden_query_expectations e
      ON e.case_id = c.id
      AND e.expectation_revision = (
        SELECT max(expectation_revision)
        FROM golden_query_expectations
        WHERE case_id = c.id
      )
    WHERE c.active = true
      AND (${tid}::text IS NULL OR c.tenant_id = ${tid})
    GROUP BY c.id, c.slug, c.tenant_id, c.space_id, c.agent_id, c.query, c.k, c.revision, latest_expectations.expectation_revision, lg.last_graded_at
    ORDER BY lg.last_graded_at NULLS FIRST, c.tenant_id, c.slug
    LIMIT ${GOLDEN_QUERY_CASE_LIMIT}`;

  return {
    total: Number(rows[0]?.active_cases_total || 0),
    cases: rows.map((row: any) => ({
      id: Number(row.id),
      slug: String(row.slug),
      tenant_id: String(row.tenant_id),
      space_id: String(row.space_id),
      agent_id: row.agent_id ? String(row.agent_id) : null,
      query: String(row.query),
      k: Math.max(1, Math.min(50, Number(row.k || 10))),
      revision: Math.max(1, Number(row.revision || 1)),
      expectation_revision: Math.max(1, Number(row.expectation_revision || row.revision || 1)),
      expectations: Array.isArray(row.expectations) ? row.expectations : [],
    })),
  };
}

async function fetchPreviousGoldenStatuses(db: DirectSql, cases: Pick<GoldenQueryCase, "id" | "expectation_revision">[]): Promise<Map<number, string>> {
  if (cases.length === 0) return new Map();
  const currentRevisions = cases.map((goldenCase) => ({
    case_id: goldenCase.id,
    expectation_revision: goldenCase.expectation_revision,
  }));
  const rows = await db`
    WITH current_revisions AS (
      SELECT case_id, expectation_revision
      FROM jsonb_to_recordset(${db.json(currentRevisions)}::jsonb)
        AS x(case_id bigint, expectation_revision int)
    )
    SELECT DISTINCT ON (gqr.case_id) gqr.case_id, gqr.status
    FROM golden_query_runs gqr
    JOIN current_revisions cr
      ON cr.case_id = gqr.case_id
     AND cr.expectation_revision = gqr.expectation_revision
    WHERE gqr.status IN ('pass', 'fail')
    ORDER BY gqr.case_id, gqr.created_at DESC, gqr.id DESC`;
  return new Map(rows.map((row: any) => [Number(row.case_id), String(row.status)]));
}

async function resolveGoldenQueryMatches(
  db: DirectSql,
  tenantId: string,
  expectations: GoldenQueryExpectation[],
): Promise<Map<string, Set<string>>> {
  if (expectations.length === 0) return new Map();
  const rows = await db`
    WITH RECURSIVE input_expectations AS (
      SELECT expectation_type, addr, match_mode
      FROM jsonb_to_recordset(${db.json(expectations)}::jsonb)
        AS x(expectation_type text, addr text, match_mode text)
    ),
    descendants AS (
      SELECT
        expectation_type,
        addr AS seed_addr,
        addr AS match_addr,
        match_mode,
        0 AS depth,
        ARRAY[addr]::text[] AS path
      FROM input_expectations
      UNION ALL
      SELECT
        d.expectation_type,
        d.seed_addr,
        next_match.next_addr AS match_addr,
        d.match_mode,
        d.depth + 1,
        d.path || next_match.next_addr
      FROM descendants d
      JOIN memory_events me
        ON me.tenant_id = ${tenantId}
       AND me.addr = d.match_addr
      CROSS JOIN LATERAL (
        SELECT btrim(COALESCE(me.event_data->>'superseded_by_addr', me.event_data->>'new_memory_addr', '')) AS next_addr
      ) next_match
      WHERE d.match_mode = 'supersession_descendant'
        AND d.depth < 10
        AND me.event_type = 'superseded'
        AND next_match.next_addr <> ''
        AND next_match.next_addr <> ALL(d.path)
    )
    SELECT DISTINCT seed_addr, match_addr
    FROM descendants
    WHERE btrim(match_addr) <> ''`;

  const matches = new Map<string, Set<string>>();
  for (const row of rows) {
    const seed = String(row.seed_addr || "");
    const match = String(row.match_addr || "");
    if (!seed || !match) continue;
    if (!matches.has(seed)) matches.set(seed, new Set());
    matches.get(seed)!.add(match);
  }
  return matches;
}

function expectationMatchesAny(
  addr: string,
  expectations: GoldenQueryExpectation[],
  matchSets: Map<string, Set<string>>,
): boolean {
  return expectations.some((expectation) => (matchSets.get(expectation.addr) || new Set([expectation.addr])).has(addr));
}

async function gradeGoldenQueryCase(db: DirectSql, goldenCase: GoldenQueryCase): Promise<GoldenQueryRunRecord> {
  const expected = goldenCase.expectations.filter((expectation) => expectation.expectation_type === "expected");
  const forbidden = goldenCase.expectations.filter((expectation) => expectation.expectation_type === "forbidden");
  if (expected.length === 0 && forbidden.length === 0) {
    return {
      case_id: goldenCase.id,
      expectation_revision: goldenCase.expectation_revision,
      precision_at_k: null,
      recall_at_k: null,
      mrr: null,
      forbidden_leaks: 0,
      status: "error",
      error_reason: "missing_expectations",
    };
  }

  try {
    const recall = await compileRecall(db as any, {
      query: goldenCase.query,
      tenantId: goldenCase.tenant_id,
      spaceId: goldenCase.space_id,
      agentId: goldenCase.agent_id,
      limit: goldenCase.k,
      timeoutMs: GOLDEN_QUERY_RECALL_TIMEOUT_MS,
      suppressExposureEvent: true,
      suppressTelemetry: true,
    });
    if (!recall.recall_telemetry_suppressed) {
      console.warn(`[golden_query] ${goldenCase.slug} error: telemetry_leak_detected`);
      return {
        case_id: goldenCase.id,
        expectation_revision: goldenCase.expectation_revision,
        precision_at_k: null,
        recall_at_k: null,
        mrr: null,
        forbidden_leaks: 0,
        status: "error",
        error_reason: "telemetry_leak_detected",
      };
    }
    if (recall.error_recovered === true) {
      const reason = String(recall.recovery_reason || "unknown").slice(0, 450);
      const msg = `recall_degraded:${reason}`;
      console.warn(`[golden_query] ${goldenCase.slug} error: ${msg}`);
      return {
        case_id: goldenCase.id,
        expectation_revision: goldenCase.expectation_revision,
        precision_at_k: null,
        recall_at_k: null,
        mrr: null,
        forbidden_leaks: 0,
        status: "error",
        error_reason: msg,
      };
    }
    const topAddrs = uniqueAddrs([
      ...recall.primary_memories.map((memory) => memory.addr),
      ...recall.supporting_memories.map((memory) => memory.addr),
    ]).slice(0, goldenCase.k);
    const matchSets = await resolveGoldenQueryMatches(db, goldenCase.tenant_id, goldenCase.expectations);
    const expectedMatched = expected.filter((expectation) => {
      const matches = matchSets.get(expectation.addr) || new Set([expectation.addr]);
      return topAddrs.some((addr) => matches.has(addr));
    }).length;
    const expectedResultMatches = topAddrs.filter((addr) => expectationMatchesAny(addr, expected, matchSets)).length;
    const forbiddenLeaks = topAddrs.filter((addr) => expectationMatchesAny(addr, forbidden, matchSets)).length;
    const firstExpectedRank = topAddrs.findIndex((addr) => expectationMatchesAny(addr, expected, matchSets));
    const recallAtK = expected.length > 0 ? roundGoldenMetric(expectedMatched / expected.length) : null;
    const precisionDenominator = Math.min(goldenCase.k, topAddrs.length);
    const precisionAtK = expected.length > 0 && precisionDenominator > 0
      ? roundGoldenMetric(expectedResultMatches / precisionDenominator)
      : null;
    const mrr = expected.length > 0 && firstExpectedRank >= 0 ? roundGoldenMetric(1 / (firstExpectedRank + 1)) : null;
    const expectedMissing = expected.length > 0 && expectedMatched !== expected.length;
    const status = forbiddenLeaks > 0 || expectedMissing ? "fail" : "pass";
    const errorReasons = [
      forbiddenLeaks > 0 ? "forbidden_leak" : null,
      expectedMissing ? "expected_missing" : null,
    ].filter(Boolean);
    return {
      case_id: goldenCase.id,
      expectation_revision: goldenCase.expectation_revision,
      precision_at_k: precisionAtK,
      recall_at_k: recallAtK,
      mrr,
      forbidden_leaks: forbiddenLeaks,
      status,
      error_reason: errorReasons.length > 0 ? errorReasons.join(",") : null,
    };
  } catch (error: any) {
    const msg = String(error?.message || "golden_query_error").slice(0, 500);
    console.warn(`[golden_query] ${goldenCase.slug} error: ${msg}`);
    return {
      case_id: goldenCase.id,
      expectation_revision: goldenCase.expectation_revision,
      precision_at_k: null,
      recall_at_k: null,
      mrr: null,
      forbidden_leaks: 0,
      status: "error",
      error_reason: msg,
    };
  }
}

async function passGoldenQueryEval(config: SupercronConfig, budget: TimeBudget): Promise<PassResult> {
  return runPass("golden_query", async () => {
    const baseDetails = {
      golden_query_installed: false,
      golden_pass_rate: null,
      golden_cases_run: 0,
      golden_cases_failed: 0,
      golden_cases_errored: 0,
      golden_cases_skipped: 0,
      golden_cases_total: 0,
      golden_cases_unscanned: 0,
      regressed_cases_total: 0,
      regressed_cases: [],
    };
    if (config.dryRun) return { actions: 0, details: { ...baseDetails, reason: "dry_run" } };
    if (budget.shouldSkipTier(3)) return { actions: 0, details: { ...baseDetails, reason: "tier_budget_exceeded" } };

    const [installed] = await sql`
      SELECT
        to_regclass('golden_query_cases') IS NOT NULL
        AND to_regclass('golden_query_expectations') IS NOT NULL
        AND to_regclass('golden_query_runs') IS NOT NULL AS installed`;
    if (!installed?.installed) return { actions: 0, details: { ...baseDetails, reason: "golden_query_schema_missing" } };

    const { cases, total: goldenCasesTotal } = await fetchGoldenQueryCases(sql, config.cycleTenantId);
    if (cases.length === 0) {
      return { actions: 0, details: { ...baseDetails, golden_query_installed: true, reason: "no_active_cases" } };
    }
    const goldenCasesUnscanned = Math.max(0, goldenCasesTotal - cases.length);
    if (goldenCasesUnscanned > 0) {
      console.warn(`[golden_query] corpus cap hit: scanned=${cases.length} total=${goldenCasesTotal} unscanned=${goldenCasesUnscanned}`);
    }

    const previousStatuses = await fetchPreviousGoldenStatuses(sql, cases);
    const goldenQueryRuns: GoldenQueryRunRecord[] = [];
    const regressedCases: string[] = [];
    let budgetRejectedReason: string | null = null;
    for (const [idx, goldenCase] of cases.entries()) {
      if (budget.remaining() < GOLDEN_QUERY_CASE_MIN_BUDGET_MS) {
        goldenQueryRuns.push({
          case_id: goldenCase.id,
          expectation_revision: goldenCase.expectation_revision,
          precision_at_k: null,
          recall_at_k: null,
          mrr: null,
          forbidden_leaks: 0,
          status: "skipped",
          error_reason: "tier_budget_exhausted",
        });
        continue;
      }
      const budgetRejection = rejectIfLlmBudgetExceeded(config, LLM_ESTIMATE_GOLDEN_CASE_MICRO);
      if (budgetRejection) {
        budgetRejectedReason = String(budgetRejection.details.reason || "budget_would_exceed");
        goldenQueryRuns.push({
          case_id: goldenCase.id,
          expectation_revision: goldenCase.expectation_revision,
          precision_at_k: null,
          recall_at_k: null,
          mrr: null,
          forbidden_leaks: 0,
          status: "skipped",
          error_reason: budgetRejectedReason,
        });
        break;
      }
      const row = await gradeGoldenQueryCase(sql, goldenCase);
      await recordBudgetedLlmSpend(config, LLM_ESTIMATE_GOLDEN_CASE_MICRO);
      console.log(`[golden_query] graded ${idx + 1}/${cases.length} slug=${goldenCase.slug} status=${row.status}`);
      goldenQueryRuns.push(row);
      if (previousStatuses.get(goldenCase.id) === "pass" && row.status !== "pass") {
        regressedCases.push(goldenCase.slug);
      }
    }

    const denominator = goldenQueryRuns.filter((row) => row.status !== "skipped").length;
    const passed = goldenQueryRuns.filter((row) => row.status === "pass").length;
    const failed = goldenQueryRuns.filter((row) => row.status === "fail").length;
    const errored = goldenQueryRuns.filter((row) => row.status === "error").length;
    return {
      actions: 0,
      llm_tokens_in: null,
      llm_tokens_out: null,
      llm_cost_usd_micro: null,
      details: {
        golden_query_installed: true,
        golden_pass_rate: denominator > 0 ? roundGoldenMetric(passed / denominator) : null,
        golden_cases_run: denominator,
        golden_cases_failed: failed,
        golden_cases_errored: errored,
        golden_cases_skipped: goldenQueryRuns.length - denominator,
        golden_cases_total: goldenCasesTotal,
        golden_cases_unscanned: goldenCasesUnscanned,
        regressed_cases_total: regressedCases.length,
        regressed_cases: regressedCases.slice(0, 25),
        ...(budgetRejectedReason ? budgetRejectedPassDetails(budgetRejectedReason) : {}),
      },
      goldenQueryRuns,
    };
  });
}

function serializablePassResults(results: PassResult[]): Omit<PassResult, "goldenQueryRuns">[] {
  return results.map((result) => ({
    name: result.name,
    actions: result.actions,
    skipped: result.skipped,
    ms: result.ms,
    llm_tokens_in: result.llm_tokens_in ?? null,
    llm_tokens_out: result.llm_tokens_out ?? null,
    llm_cost_usd_micro: result.llm_cost_usd_micro ?? null,
    proposals_created: result.proposals_created ?? null,
    proposals_applied: result.proposals_applied ?? null,
    details: result.details,
  }));
}

function nonNegativeIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function passTelemetryValue(result: PassResult, field: keyof PassResult): number | null {
  return nonNegativeIntOrNull(result[field]);
}

function passTelemetryCount(result: PassResult, field: "proposals_created" | "proposals_applied"): number {
  return nonNegativeIntOrNull(result[field]) ?? 0;
}

async function writeSupercronPassTelemetry(db: SqlExecutor, supercronRunId: number, results: PassResult[]): Promise<void> {
  for (const result of results) {
    if (!result.name) {
      console.warn("[supercron-telemetry] skipping write for unnamed pass result");
      continue;
    }
    await db`
      INSERT INTO supercron_pass_telemetry (
        supercron_run_id,
        pass_name,
        ms,
        actions,
        llm_tokens_in,
        llm_tokens_out,
        llm_cost_usd_micro,
        proposals_created,
        proposals_applied
      ) VALUES (
        ${supercronRunId},
        ${result.name},
        ${Math.max(0, Math.trunc(result.ms || 0))},
        ${Math.max(0, Math.trunc(result.actions || 0))},
        ${passTelemetryValue(result, "llm_tokens_in")},
        ${passTelemetryValue(result, "llm_tokens_out")},
        ${passTelemetryValue(result, "llm_cost_usd_micro")},
        ${passTelemetryCount(result, "proposals_created")},
        ${passTelemetryCount(result, "proposals_applied")}
      )`;
  }
}

async function writeGoldenQueryRuns(db: SqlExecutor, supercronRunId: number, results: PassResult[]): Promise<void> {
  const rows = results.flatMap((result) => result.goldenQueryRuns || []);
  if (rows.length === 0) return;
  for (const row of rows) {
    await db`
      INSERT INTO golden_query_runs (
        supercron_run_id,
        case_id,
        expectation_revision,
        precision_at_k,
        recall_at_k,
        mrr,
        forbidden_leaks,
        status,
        error_reason
      ) VALUES (
        ${supercronRunId},
        ${row.case_id},
        ${row.expectation_revision},
        ${row.precision_at_k},
        ${row.recall_at_k},
        ${row.mrr},
        ${row.forbidden_leaks},
        ${row.status},
        ${row.error_reason}
      )`;
  }
}

async function insertSupercronRunWithGoldenQueryRuns(
  db: DirectSql,
  runId: string,
  pyramidFocus: string,
  cycle: CycleExecution,
  totalActions: number,
): Promise<number> {
  return db.begin(async (tx) => {
    const { results, tierMs } = cycle;
    const [runRow] = await tx`
      INSERT INTO supercron_runs (run_id, started_at, finished_at, pyramid_focus,
        tier1_ms, tier2_ms, tier3_ms, tier4_ms, pass_results, total_actions,
        status, quality_report, degraded_reason)
      VALUES (${runId}, ${cycle.startedAt},
        now(), ${pyramidFocus},
        ${tierMs[1]}, ${tierMs[2]}, ${tierMs[3]}, ${tierMs[4]},
        ${tx.json(serializablePassResults(results))}, ${totalActions},
        ${cycle.status}, ${tx.json(cycle.qualityReport)}, ${cycle.degradedReason})
      RETURNING id`;
    const supercronRunId = Number(runRow.id);
    await writeSupercronPassTelemetry(tx, supercronRunId, results);
    await writeGoldenQueryRuns(tx, supercronRunId, results);
    return supercronRunId;
  });
}

// ============================================================
// Orchestrator
// ============================================================

async function runOnlyPass(config: SupercronConfig, budget: TimeBudget): Promise<{ results: PassResult[]; tierMs: Record<number, number> }> {
  const tierMs: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  if (config.onlyPass === "node_gc_candidates" || config.onlyPass === "node_gc_apply" || config.onlyPass === "project_association_doctor") {
    const passName = config.onlyPass;
    if (!config.tiers.includes(1)) {
      return {
        results: [skipPass(passName, "tier_disabled_for_tenant")],
        tierMs,
      };
    }
    budget.tierStart(1);
    const result = await runControlledPass(config, {
      name: passName,
      run: () => {
        if (passName === "node_gc_apply") return passNodeGcApply(config);
        if (passName === "project_association_doctor") return pass3cProjectAssociationDoctor(config);
        return passNodeGcCandidates(config);
      },
    });
    tierMs[1] = budget.tierElapsed(1);
    if (result.actions > 0 || !result.skipped) {
      console.log(`  [T1] ${result.name}: ${result.actions} actions (${result.ms}ms)`);
    }
    const results: PassResult[] = [];
    drainControllerErrors(config, results);
    results.push(result);
    return { results, tierMs };
  }
  if (config.onlyPass !== "trend_maintenance") {
    throw new Error(`Unsupported --only pass: ${config.onlyPass || "none"}`);
  }
  if (!config.tiers.includes(2)) {
    return {
      results: [skipPass("trend_maintenance", "tier_disabled_for_tenant")],
      tierMs,
    };
  }
  budget.tierStart(2);
  const result = await runControlledPass(config, {
    name: "trend_maintenance",
    run: () => passTrendMaintenance(config),
  });
  tierMs[2] = budget.tierElapsed(2);
  if (result.actions > 0 || !result.skipped) {
    console.log(`  [T2] ${result.name}: ${result.actions} actions (${result.ms}ms)`);
  }
  const results: PassResult[] = [];
  drainControllerErrors(config, results);
  results.push(result);
  return { results, tierMs };
}

async function runAllPasses(config: SupercronConfig): Promise<{ results: PassResult[]; tierMs: Record<number, number> }> {
  const budget = createTimeBudget(TOTAL_BUDGET_MS);
  const results: PassResult[] = [];
  const tierMs: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  console.log(`[SUPERCRON] Cycle #${config.cycleNumber} | pyramid=${config.pyramidFocus} | tiers=[${config.tiers.join(",")}] | only=${config.onlyPass || "none"} | dry=${config.dryRun} | force=${config.force}`);

  if (config.onlyPass) {
    return runOnlyPass(config, budget);
  }

  // Tier 1: Deterministic
  if (config.tiers.includes(1)) {
    budget.tierStart(1);
    const passes: PassInvocation[] = [
      { name: "heat_refresh", run: () => pass1HeatRefresh(config) },
      { name: "tension_scan", run: () => pass2TensionScan(config) },
      { name: "memory_lifecycle", run: () => pass3MemoryLifecycle(config) },
      { name: "registry_lifecycle_reconciliation", run: () => pass3bRegistryRepair(config) },
      { name: "project_association_doctor", run: () => pass3cProjectAssociationDoctor(config) },
      { name: "node_health", run: () => pass4NodeHealth(config) },
      { name: "edge_integrity", run: () => pass5EdgeIntegrity(config) },
      { name: "stimulus_decay", run: () => pass5hStimulusDecay(config) },
      { name: "federation_activity_retention", run: () => pass5iFederationActivityRetention(config) },
      { name: "connector_grant_retention", run: () => pass5jConnectorGrantRetention(config) },
      { name: "oauth_client_retention", run: () => pass5kOauthClientRetention(config) },
      { name: "node_gc_candidates", run: () => passNodeGcCandidates(config) },
      { name: "node_gc_apply", run: () => passNodeGcApply(config) },
      { name: "vault_tombstone", run: () => passVaultTombstone(config) },
    ];
    for (const pass of passes) {
      if (shouldStop) break;
      const r = await runControlledPass(config, pass);
      results.push(r);
      if (r.actions > 0 || !r.skipped) {
        console.log(`  [T1] ${r.name}: ${r.actions} actions (${r.ms}ms)`);
      }
    }
    tierMs[1] = budget.tierElapsed(1);
  }

  // Tier 2: Bounded
  if (config.tiers.includes(2) && !shouldStop) {
    budget.tierStart(2);
    const passes: PassInvocation[] = [
      { name: "truth_refresh", run: () => pass5fTruthRefresh(config) },
      { name: "distiller_simple", run: () => pass6DistillerSimple(config) },
      { name: "supersession", run: () => pass7Supersession(config) },
      { name: "source_analytics", run: () => pass8SourceAnalytics(config) },
      { name: "review_packet_intake", run: () => passReviewPacketIntake(config) },
      { name: "trend_maintenance", run: () => passTrendMaintenance(config) },
      { name: "edge_usefulness_scoring", run: () => passEdgeUsefulnessScoring(config) },
      { name: "edge_usefulness_cleanup", run: () => passEdgeUsefulnessCleanup(config) },
    ];
    for (const pass of passes) {
      if (shouldStop) break;
      const r = await runControlledPass(config, pass);
      results.push(r);
      if (r.actions > 0 || !r.skipped) {
        console.log(`  [T2] ${r.name}: ${r.actions} actions (${r.ms}ms)`);
      }
    }
    tierMs[2] = budget.tierElapsed(2);
  }

  // Tier 3: LLM-optional
  if (config.tiers.includes(3) && !shouldStop) {
    budget.tierStart(3);
    const passes: PassInvocation[] = [
      { name: "tension_synthesis", run: () => pass9TensionSynthesis(config, budget) },
      { name: "archetype_detection", run: () => pass10ArchetypeDetection(config, budget) },
      { name: "essence_compression", run: () => pass11EssenceCompression(config, budget) },
      { name: "distiller_fusion", run: () => pass12DistillerFusion(config, budget) },
      { name: "memory_merge", run: () => pass14MemoryMerge(config, budget) },
      {
        name: "golden_query",
        run: () => config.policy.features.goldenQueryEnabled
          ? passGoldenQueryEval(config, budget)
          : Promise.resolve(skipPass("golden_query", "feature_disabled_for_tenant")),
      },
    ];
    const tier3Allowed = await shouldRunTier3Controlled(config);
    if (!tier3Allowed) {
      for (const pass of passes) results.push(skipPass(pass.name, "tier3_controller_skip"));
    } else {
      for (const pass of passes) {
        if (shouldStop) break;
        const r = await runControlledPass(config, pass);
        results.push(r);
        if (r.actions > 0 || !r.skipped) {
          console.log(`  [T3] ${r.name}: ${r.actions} actions (${r.ms}ms)`);
        }
      }
    }
    tierMs[3] = budget.tierElapsed(3);
  }

  // Tier 4: Reporting
  if (config.tiers.includes(4) && !shouldStop) {
    budget.tierStart(4);
    drainControllerErrors(config, results);
    const r = await pass13Digest(config, results);
    results.push(r);
    tierMs[4] = budget.tierElapsed(4);
  }

  drainControllerErrors(config, results);
  return { results, tierMs };
}

function zeroMemoryHealthSnapshot(): MemoryHealthSnapshot {
  return {
    active_registry_dormant_nodes: 0,
    active_registry_dormant_without_events: 0,
    inactive_registry_active_nodes: 0,
    memory_nodes_without_registry: 0,
    registry_rows_without_node_rows: 0,
    duplicate_edge_groups: 0,
    self_loop_edges: 0,
    edges_touching_inactive_endpoints: 0,
    edges_missing_discovered_by: 0,
    active_duplicate_assertions: 0,
    active_memories_with_zero_edges: 0,
    pending_review_count: 0,
    lifecycle_mutations_without_events: 0,
    unresolved_conflicts: 0,
    stale_embedding_memories: 0,
  };
}

function emptyQualityReport(snapshotSkipped: boolean): QualityReport {
  const zero = zeroMemoryHealthSnapshot();
  return evaluateQualityReport({
    before: zero,
    after: zero,
    delta: zero,
    pass_results: [],
    audit_events_written: 0,
    snapshot_overhead_ms: 0,
    snapshot_skipped: snapshotSkipped,
    cooldown_overrides: [],
  });
}

function cycleExceptionQualityReport(message: string, fields: Record<string, unknown> = {}): QualityReport {
  return {
    ...emptyQualityReport(true),
    warnings: [`cycle_exception:${message}`],
    degraded: true,
    degraded_reason: `cycle_exception:${message}`,
    ...(Object.keys(fields).length > 0 ? { error_fields: fields } : {}),
  };
}

function structuredCycleErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof ForceRunTenantMismatchError) {
    return {
      error_name: error.name,
      requested_tenant: error.requestedTenant,
      instance_owner: error.instanceOwner,
    };
  }
  if (isManualRunAlreadyOpen(error)) {
    return {
      error_name: "ManualRunAlreadyOpenError",
      tenant_id: error.tenantId,
      reason: "manual_run_already_open",
    };
  }
  return {};
}

async function countMemoryAuditEventsBetween(db: DirectSql, startedAt: Date, endedAt: Date): Promise<number> {
  const [row] = await db`
    SELECT count(*)::int AS cnt
    FROM memory_events
    WHERE created_at >= ${startedAt}
      AND created_at <= ${endedAt}
      AND event_type IN ('superseded', 'retracted', 'archived', 'expired')`;
  return parseInt(row?.cnt || "0");
}

async function runCycleWithQuality(config: SupercronConfig): Promise<CycleExecution> {
  if (!config.policy.withinActiveHours && !config.force && !config.manualRun) {
    const startedAt = new Date();
    const result = skipPass("cycle", "outside_active_hours");
    if (heartbeat) {
      await heartbeat.beat({
        status: "idle_off_hours",
        metadata: {
          tenant_id: config.cycleTenantId,
          active_hours: config.policy.activeHours,
        },
      });
    }
    return {
      results: [result],
      tierMs: { 1: 0, 2: 0, 3: 0, 4: 0 },
      qualityReport: emptyQualityReport(true),
      status: "completed",
      degradedReason: null,
      startedAt,
      skipRunInsert: true,
      skipRunInsertReason: "outside_active_hours",
    };
  }

  if (config.dryRun) {
    const startedAt = new Date();
    const { results, tierMs } = await runAllPasses(config);
    if (config.manualRun) {
      await markManualRunStatus(config.manualRun.id, "rejected", { rejectionReason: "dry_run" });
    }
    return {
      results,
      tierMs,
      qualityReport: emptyQualityReport(true),
      status: "completed",
      degradedReason: null,
      startedAt,
      skipRunInsert: true,
      skipRunInsertReason: "dry_run",
    };
  }

  if (config.manualRun) await markManualRunStatus(config.manualRun.id, "running");
  const [{ run_started_at: startedAt }] = await sql`SELECT now() AS run_started_at`;
  try {
    // MT9: scope the memory-health snapshot to the cycle's tenant so a per-tenant
    // SuperCron cycle's QualityReport reflects ONLY that tenant's memory health, not
    // every tenant's (and not the global structural graph it doesn't maintain).
    const cycleSpaceId = `tenant:${config.cycleTenantId}`;
    const beforeSnapshotStarted = Date.now();
    const before = await collectMemoryHealthSnapshot(sql, cycleSpaceId);
    const beforeSnapshotMs = Date.now() - beforeSnapshotStarted;
    const { results, tierMs } = await runAllPasses(config);
    const [{ window_end: windowEnd }] = await sql`SELECT now() AS window_end`;
    const afterSnapshotStarted = Date.now();
    const after = await collectMemoryHealthSnapshot(sql, cycleSpaceId);
    const afterSnapshotMs = Date.now() - afterSnapshotStarted;
    const delta = computeMemoryHealthDeltas(before, after);
    const auditEventsWritten = await countMemoryAuditEventsBetween(sql, startedAt, windowEnd);
    const cycleBudget = budgetDeltaSummary(config);
    const qualityReport = evaluateQualityReport({
      before,
      after,
      delta,
      pass_results: results,
      audit_events_written: auditEventsWritten,
      snapshot_overhead_ms: beforeSnapshotMs + afterSnapshotMs,
      cooldown_overrides: config.cooldownOverrides,
      thresholds: config.policy.thresholds,
      cycle_spend_micro: cycleBudget.cycleSpendMicro,
      cycle_remaining_micro: cycleBudget.cycleRemainingMicro,
      cycle_daily_spend_micro: cycleBudget.cycleDailySpendMicro,
      cycle_manual_spend_micro: cycleBudget.cycleManualSpendMicro,
    });
    const status = qualityReport.degraded ? "degraded" : "completed";
    return {
      results,
      tierMs,
      qualityReport,
      status,
      degradedReason: qualityReport.degraded_reason,
      startedAt,
    };
  } catch (error) {
    if (config.manualRun) await markManualRunStatus(config.manualRun.id, "failed");
    throw error;
  }
}

// ============================================================
// Stats mode
// ============================================================

async function showStats(): Promise<void> {
  const runs = await sql`
    SELECT id, run_id, started_at, finished_at, pyramid_focus,
      tier1_ms, tier2_ms, tier3_ms, tier4_ms, total_actions, status,
      quality_report, degraded_reason
    FROM supercron_runs ORDER BY id DESC LIMIT 10`;

  if (runs.length === 0) {
    console.log("[SUPERCRON] No runs recorded yet.");
    return;
  }

  console.log("\n[SUPERCRON] Last 10 runs:");
  console.log("─".repeat(118));
  console.log("  ID  | Cycle | Pyramid  | T1     T2     T3     T4   | Actions | Status    | Warn | Duration");
  console.log("─".repeat(118));

  for (const r of runs) {
    const dur = r.finished_at && r.started_at
      ? `${((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
      : "running";
    const runNum = r.run_id?.split("-")[0] || "?";
    const warningCount = Array.isArray(r.quality_report?.warnings)
      ? r.quality_report.warnings.length
      : 0;
    console.log(
      `  ${String(r.id).padStart(3)} | ${runNum.padStart(5)} | ${(r.pyramid_focus || "?").padEnd(8)} | ` +
      `${String(r.tier1_ms || 0).padStart(5)}  ${String(r.tier2_ms || 0).padStart(5)}  ${String(r.tier3_ms || 0).padStart(5)}  ${String(r.tier4_ms || 0).padStart(4)} | ` +
      `${String(r.total_actions || 0).padStart(7)} | ${(r.status || "?").padEnd(9)} | ${String(warningCount).padStart(4)} | ${dur}`,
    );
    if (r.degraded_reason) {
      console.log(`      degraded_reason: ${r.degraded_reason}`);
    }
  }

  // Show current graph_state
  const state = await sql`
    SELECT key, value FROM graph_state
    WHERE key LIKE 'supercron_%' ORDER BY key`;
  if (state.length > 0) {
    console.log("\n[SUPERCRON] Current state:");
    for (const s of state) console.log(`  ${s.key} = ${s.value}`);
  }
}

// ============================================================
// Node-GC receipt inspect mode
// ============================================================

async function inspectNodeGcReceipt(receiptId: string): Promise<void> {
  const [receipt] = await sql`
    SELECT
      id::text AS id,
      batch_id::text AS batch_id,
      tenant_id,
      tenant_space_id,
      addr,
      marked_at,
      status,
      predicate_version,
      eligibility,
      reviewed_by,
      reviewed_at,
      rejection_reason,
      expires_at,
      applied_at,
      applied_action,
      updated_at
    FROM supercron_node_gc_receipts
    WHERE id = ${receiptId}::bigint
    LIMIT 1
  `;
  if (!receipt) {
    throw new Error(`node_gc_receipt_not_found:${receiptId}`);
  }

  const tenantId = String(receipt.tenant_id);
  const tenantSpaceId = String(receipt.tenant_space_id || `tenant:${tenantId}`);
  const addr = String(receipt.addr);
  const eligibility = readJsonObject(receipt.eligibility);
  const now = new Date();
  const policy = await getResolvedTenantPolicy(sql, tenantId, { now, operatorTiers: [1, 2, 3, 4] });
  const intendedApplyAction = isNodeGcApplyAction(eligibility.intended_apply_action)
    ? eligibility.intended_apply_action
    : null;
  const resolvedApplyAction = resolveNodeGcReceiptApplyAction(eligibility, policy.nodeGc.applyAction);
  const predicateRow = await readNodeGcApplyPredicateRow(sql, tenantId, tenantSpaceId, addr, { lockForApply: false });
  const predicate = evaluateNodeGcApplyPredicate(predicateRow, nodeGcApplyPredicateOptions(policy.nodeGc));
  const dormantDaysAtMark = eligibility.dormant_days_threshold == null
    ? null
    : Number(eligibility.dormant_days_threshold);
  const lastQueriedGraceDaysAtMark = eligibility.last_queried_grace_days == null
    ? null
    : Number(eligibility.last_queried_grace_days);

  const report = {
    receipt: {
      id: String(receipt.id),
      batch_id: receipt.batch_id == null ? null : String(receipt.batch_id),
      tenant_id: tenantId,
      tenant_space_id: tenantSpaceId,
      addr,
      status: String(receipt.status),
      predicate_version: Number(receipt.predicate_version),
      marked_at: receipt.marked_at ?? null,
      reviewed_by: receipt.reviewed_by ?? null,
      reviewed_at: receipt.reviewed_at ?? null,
      applied_action: receipt.applied_action ?? null,
      applied_at: receipt.applied_at ?? null,
      expires_at: receipt.expires_at ?? null,
      rejection_reason: receipt.rejection_reason ?? null,
      updated_at: receipt.updated_at ?? null,
    },
    apply_intent: {
      intended_apply_action: intendedApplyAction,
      current_tenant_apply_action: policy.nodeGc.applyAction,
      resolved_apply_action: resolvedApplyAction,
      source: intendedApplyAction ? "eligibility.intended_apply_action" : "current_tenant_setting",
      differs_from_current_setting: intendedApplyAction != null && intendedApplyAction !== policy.nodeGc.applyAction,
    },
    mark_time_settings: {
      eligibility_predicate_version: eligibility.eligibility_predicate_version ?? eligibility.predicate_version ?? null,
      dormant_days_threshold: dormantDaysAtMark,
      last_queried_grace_days: lastQueriedGraceDaysAtMark,
      per_cycle_cap: eligibility.per_cycle_cap ?? null,
      max_active_candidates: eligibility.max_active_candidates ?? null,
      rejection_cooldown_days: eligibility.rejection_cooldown_days ?? null,
    },
    current_settings: {
      apply_enabled: policy.nodeGc.applyEnabled,
      apply_action: policy.nodeGc.applyAction,
      dormant_days: policy.nodeGc.dormantDays,
      last_queried_grace_days: SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
      apply_per_cycle_cap: policy.nodeGc.applyPerCycleCap,
      safe_lifecycle_states: GC_SAFE_LIFECYCLE_STATES,
      protected_maturity_stages: AUTOMATED_DORMANCY_PROTECTED_MATURITY_STAGE_LIST,
      protected_kinds: AUTOMATED_DORMANCY_PROTECTED_KIND_LIST,
    },
    mark_vs_current_delta: {
      dormant_days_changed: dormantDaysAtMark != null && dormantDaysAtMark !== policy.nodeGc.dormantDays,
      last_queried_grace_days_changed: lastQueriedGraceDaysAtMark != null
        && lastQueriedGraceDaysAtMark !== SUPERCRON_NODE_GC_LAST_QUERIED_GRACE_DAYS,
    },
    current_predicate_replay: {
      holds: predicate.holds,
      drift_field: predicate.holds ? null : predicate.field,
      drift_observed: predicate.holds || predicate.observed == null ? null : observedText(predicate.observed),
      rejection_reason: predicate.holds ? null : predicate.rejectionReason,
      snapshot: predicate.snapshot,
    },
    receipt_apply_artifacts: {
      apply_action: eligibility.apply_action ?? null,
      apply_predicate_drift_field: eligibility.apply_predicate_drift_field ?? null,
      apply_predicate_drift_observed: eligibility.apply_predicate_drift_observed ?? null,
      apply_predicate_snapshot: eligibility.apply_predicate_snapshot ?? null,
      apply_delete_counts: eligibility.apply_delete_counts ?? null,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

// ============================================================
// Watch loop
// ============================================================

async function readWatchSleepMs(tenantId: string | null = null): Promise<number> {
  const cadenceMinutes = await readTenantCadence(sql, tenantId);
  return cadenceMinutes * 60_000;
}

async function readWatchLockWaitMs(): Promise<number> {
  const cadenceMs = await readWatchSleepMs(cachedInstanceTenantId);
  return Math.max(15_000, Math.min(WATCH_INTERVAL_MS, Math.floor(cadenceMs / 4)));
}

function parseForceRunTimestamp(row: { value?: unknown; updated_at?: unknown } | undefined): number | null {
  const raw = typeof row?.value === "string" && row.value.trim() ? row.value : row?.updated_at;
  if (raw instanceof Date) return raw.getTime();
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function forceRunGraphStateKey(tenantId: string, suffix: string): string {
  return `${FORCE_RUN_GRAPH_STATE_PREFIX}.${tenantId}.${suffix}`;
}

function parseForceRunPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function deleteForceRunRequestIfUnchanged(row: { key: string; value: unknown }): Promise<boolean> {
  const match = row.key.match(FORCE_RUN_GRAPH_STATE_REQUESTED_AT_RE);
  if (!match) return false;
  const tenantId = match[1];
  const [deleted] = await sql`
    WITH deleted_request AS (
      DELETE FROM graph_state
      WHERE key = ${row.key}
        AND value IS NOT DISTINCT FROM ${row.value as any}
      RETURNING 1
    ),
    deleted_observability AS (
      DELETE FROM graph_state
      WHERE EXISTS (SELECT 1 FROM deleted_request)
        AND key IN (
          ${forceRunGraphStateKey(tenantId, FORCE_RUN_GRAPH_STATE_TENANT_SUFFIX)},
          ${forceRunGraphStateKey(tenantId, FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX)}
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS request_deleted FROM deleted_request
  `;
  return Number(deleted?.request_deleted || 0) > 0;
}

async function consumeRecentForceRunRequest(tenantId: string): Promise<ForceRunRequest | null> {
  const requestedAtKey = forceRunGraphStateKey(tenantId, FORCE_RUN_GRAPH_STATE_REQUESTED_AT_SUFFIX);
  const [row] = await sql`
    SELECT key, value, updated_at FROM graph_state
    WHERE key = ${requestedAtKey}
    ORDER BY updated_at ASC, key ASC
    LIMIT 1
  `;
  if (!row?.key) return null;
  const match = String(row.key).match(FORCE_RUN_GRAPH_STATE_REQUESTED_AT_RE);
  if (!match) return null;
  const requestedTenantId = match[1];
  const requestedAtMs = parseForceRunTimestamp(row);
  if (requestedAtMs === null) {
    if (row?.key) await deleteForceRunRequestIfUnchanged(row as { key: string; value: unknown });
    return null;
  }
  const ageMs = Date.now() - requestedAtMs;
  if (ageMs < 0 || ageMs > FORCE_RUN_REQUEST_MAX_AGE_MS) {
    await deleteForceRunRequestIfUnchanged(row as { key: string; value: unknown });
    return null;
  }
  const [payloadRow] = await sql`
    SELECT value FROM graph_state
    WHERE key = ${forceRunGraphStateKey(requestedTenantId, FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX)}
    LIMIT 1
  `;
  const deleted = await deleteForceRunRequestIfUnchanged(row as { key: string; value: unknown });
  if (!deleted) return null;
  return {
    tenantId: requestedTenantId,
    requestedAt: typeof row.value === "string" ? row.value : new Date(requestedAtMs).toISOString(),
    payload: parseForceRunPayload(payloadRow?.value),
  };
}

async function requeueForceRunRequest(request: ForceRunRequest): Promise<void> {
  const requestedAtKey = forceRunGraphStateKey(request.tenantId, FORCE_RUN_GRAPH_STATE_REQUESTED_AT_SUFFIX);
  const tenantKey = forceRunGraphStateKey(request.tenantId, FORCE_RUN_GRAPH_STATE_TENANT_SUFFIX);
  const payloadKey = forceRunGraphStateKey(request.tenantId, FORCE_RUN_GRAPH_STATE_PAYLOAD_SUFFIX);
  const requeuedAt = new Date().toISOString();
  const payload = JSON.stringify({ ...request.payload, requested_at: requeuedAt });
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO graph_state (key, value) VALUES (${requestedAtKey}, ${requeuedAt})
      ON CONFLICT (key) DO UPDATE SET value = ${requeuedAt}, updated_at = now()`;
    await tx`
      INSERT INTO graph_state (key, value) VALUES (${tenantKey}, ${request.tenantId})
      ON CONFLICT (key) DO UPDATE SET value = ${request.tenantId}, updated_at = now()`;
    await tx`
      INSERT INTO graph_state (key, value) VALUES (${payloadKey}, ${payload})
      ON CONFLICT (key) DO UPDATE SET value = ${payload}, updated_at = now()`;
  });
}

async function sleepUntilCadenceOrForceRun(sleepMs: number, tenantId: string): Promise<{ reason: "cadence" | "force_run"; request: ForceRunRequest | null }> {
  const deadline = Date.now() + Math.max(0, sleepMs);
  while (!shouldStop) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { reason: "cadence", request: null };
    await new Promise(r => setTimeout(r, Math.min(FORCE_RUN_SLEEP_POLL_MS, remaining)));
    try {
      const request = await consumeRecentForceRunRequest(tenantId);
      if (request) return { reason: "force_run", request };
    } catch (err: any) {
      console.warn("[SUPERCRON] force-run request check failed:", err?.message || err);
    }
  }
  return { reason: "cadence", request: null };
}

async function runWatchLoop(cli: SupercronCliOptions): Promise<void> {
  heartbeat = startWorkerHeartbeat({
    sql,
    workerName: "supercron",
    role: "supercron",
    mode: "watch",
    heartbeatIntervalMs: 15_000,
    staleAfterMs: WATCH_INTERVAL_MS * 2,
  });

  console.log("[SUPERCRON] Watch mode started");
  let pendingForceRunRequest: ForceRunRequest | null = null;

  while (!shouldStop) {
    // Acquire advisory lock
    const [lockResult] = await sql`SELECT pg_try_advisory_lock(${LOCK_ID}) AS acquired`;
    if (!lockResult.acquired) {
      const lockWaitMs = await readWatchLockWaitMs();
      console.log("[SUPERCRON] Lock held by another process, waiting...");
      await heartbeat.beat({ status: "idle", metadata: { lock_wait: true, lock_wait_ms: lockWaitMs } });
      await new Promise(r => setTimeout(r, lockWaitMs));
      continue;
    }

    let config: SupercronConfig | null = null;
    let runId = "";
    let manualRunCompleted = false;
    let forceRunRequestForCycle: ForceRunRequest | null = null;
    const fallbackStartedAt = new Date();
    try {
      forceRunRequestForCycle = pendingForceRunRequest;
      pendingForceRunRequest = null;
      config = await loadConfig(cli, forceRunRequestForCycle);
      runId = `${config.cycleNumber}-${config.pyramidFocus}`;
      await heartbeat.beat({
        status: "running",
        metadata: {
          cycle: config.cycleNumber,
          pyramid: config.pyramidFocus,
          tenant_id: config.cycleTenantId,
          manual_run_id: config.manualRun?.id ?? null,
          pyramid_override_violates_policy: config.pyramidOverrideViolatesPolicy,
        },
      });

      const cycle = await runCycleWithQuality(config);
      const { results, tierMs } = cycle;
      const totalActions = results.reduce((sum, r) => sum + r.actions, 0);

      // Record run. F12 Q9: dry-run must be non-mutating. Skip the
      // supercron_runs INSERT under --dry-run; the in-memory pass results
      // are still printed/heartbeated.
      if (config.manualRun && !cycle.skipRunInsert) {
        await markManualRunStatus(config.manualRun.id, "completed");
        manualRunCompleted = true;
      }
      if (!config.dryRun && !cycle.skipRunInsert) {
        const supercronRunId = await insertSupercronRunWithGoldenQueryRuns(sql, runId, config.pyramidFocus, cycle, totalActions);
        if (config.manualRun) await linkManualRunToSupercronRun(config.manualRun.id, supercronRunId);
      } else if (cycle.skipRunInsert && !config.dryRun) {
        console.log(`[SUPERCRON] Cycle #${config.cycleNumber} skipped persistent run insert: ${cycle.skipRunInsertReason || "skipped"}`);
      }

      console.log(`[SUPERCRON] Cycle #${config.cycleNumber} ${cycle.status}: ${totalActions} actions | T1=${tierMs[1]}ms T2=${tierMs[2]}ms T3=${tierMs[3]}ms T4=${tierMs[4]}ms`);
      if (cycle.degradedReason) console.error(`[SUPERCRON] degraded_reason=${cycle.degradedReason}`);
      await heartbeat.beat({
        status: cycle.skipRunInsertReason === "outside_active_hours" ? "idle_off_hours" : "idle",
        metadata: {
          last_cycle: config.cycleNumber,
          tenant_id: config.cycleTenantId,
          last_actions: totalActions,
          last_status: cycle.skipRunInsertReason || cycle.status,
          pyramid_override_violates_policy: config.pyramidOverrideViolatesPolicy,
          ...(cycle.degradedReason ? { last_degraded_reason: cycle.degradedReason } : {}),
        },
      });
    } catch (err: any) {
      const msg = err?.message?.slice(0, 500) || "cycle_exception";
      const errorFields = structuredCycleErrorFields(err);
      console.error("[SUPERCRON] Cycle failed:", msg);
      if (manualRunCompleted) {
        console.error("[SUPERCRON] Manual run completed but failed to link supercron_runs row:", msg);
      } else if (config && !config.dryRun) {
        try {
          await sql`
            INSERT INTO supercron_runs (run_id, started_at, finished_at, pyramid_focus,
              tier1_ms, tier2_ms, tier3_ms, tier4_ms, pass_results, total_actions,
              status, quality_report, degraded_reason)
            VALUES (${runId || `${config.cycleNumber}-${config.pyramidFocus}`}, ${fallbackStartedAt},
              now(), ${config.pyramidFocus},
              0, 0, 0, 0,
              ${sql.json([])}, 0,
              'error', ${sql.json(cycleExceptionQualityReport(msg, errorFields))}, ${`cycle_exception:${msg}`})`;
          if (config.manualRun && !manualRunCompleted) await markManualRunStatus(config.manualRun.id, "failed");
        } catch (insertErr: any) {
          console.error("[SUPERCRON] Failed to record error run:", insertErr?.message);
        }
      } else if (forceRunRequestForCycle) {
        if (isManualRunAlreadyOpen(err)) {
          console.error(
            `[SUPERCRON] Force-run request for tenant ${forceRunRequestForCycle.tenantId} rejected because a manual run is already open; not retrying.`,
          );
        } else {
          pendingForceRunRequest = forceRunRequestForCycle;
          console.error(
            `[SUPERCRON] Force-run request for tenant ${forceRunRequestForCycle.tenantId} will retry after pre-run failure.`,
          );
        }
      }
      await heartbeat.beat({ status: "error", error: msg.slice(0, 200) });
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
    }

    if (pendingForceRunRequest) {
      console.log(`[SUPERCRON] Retrying pending force-run request for tenant ${pendingForceRunRequest.tenantId}`);
      continue;
    }

    const watchTenantId = config?.cycleTenantId ?? await resolveInstanceTenantId();
    const sleepMs = await readWatchSleepMs(watchTenantId);
    const wakeReason = await sleepUntilCadenceOrForceRun(sleepMs, watchTenantId);
    if (wakeReason.reason === "force_run") {
      pendingForceRunRequest = wakeReason.request;
      console.log(`[SUPERCRON] Force-run request consumed for tenant ${pendingForceRunRequest?.tenantId}; starting next cycle`);
    }
  }

  if (pendingForceRunRequest) {
    try {
      await requeueForceRunRequest(pendingForceRunRequest);
      console.log(`[SUPERCRON] Re-queued pending force-run for tenant ${pendingForceRunRequest.tenantId} during shutdown`);
    } catch (err: any) {
      console.error("[SUPERCRON] Failed to re-queue pending force-run during shutdown:", err?.message || err);
    }
  }
  console.log("[SUPERCRON] Watch mode stopped");
  await heartbeat.stop({ status: "stopped", metadata: { shutdown: true } });
}

// ============================================================
// Helpers
// ============================================================

function parseEmbeddingStr(str: string): number[] {
  const clean = str.replace(/^\[/, "").replace(/\]$/, "");
  if (!clean) return [];
  return clean.split(",").map(Number);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const cli = parseSupercronCli(process.argv.slice(2));
  if (cli.mode === "help") {
    console.log(formatSupercronUsage());
    return;
  }
  if (cli.mode === "error") {
    console.error(`[SUPERCRON] ${cli.error}`);
    console.error(formatSupercronUsage());
    process.exit(1);
  }

  registerShutdown();
  const options = cli.options;
  if (options.once && !options.onlyPass && !options.stats && !options.inspectReceiptId) {
    console.error("[SUPERCRON] --once is redundant outside --only; single-run mode already exits after one cycle.");
  }

  if (options.inspectReceiptId) {
    await inspectNodeGcReceipt(options.inspectReceiptId);
    await closeLoadedTrendServiceSafely();
    await closeSql();
    return;
  }

  if (options.stats) {
    await showStats();
    await closeLoadedTrendServiceSafely();
    await closeSql();
    return;
  }

  if (options.watch) {
    await runWatchLoop(options);
    await closeLoadedTrendServiceSafely();
    await closeSql();
    return;
  }

  // Single run
  const [lockResult] = await sql`SELECT pg_try_advisory_lock(${LOCK_ID}) AS acquired`;
  if (!lockResult.acquired) {
    console.error("[SUPERCRON] Lock held by another process. Use --stats to check status.");
    await closeLoadedTrendServiceSafely();
    await closeSql();
    process.exit(1);
  }

  let config: SupercronConfig | null = null;
  let runId = "";
  let manualRunCompleted = false;
  const fallbackStartedAt = new Date();
  try {
    config = await loadConfig(options);
    runId = `${config.cycleNumber}-${config.pyramidFocus}`;
    const cycle = await runCycleWithQuality(config);
    const { results, tierMs } = cycle;
    const totalActions = results.reduce((sum, r) => sum + r.actions, 0);

    // Record run
    if (config.manualRun && !cycle.skipRunInsert) {
      await markManualRunStatus(config.manualRun.id, "completed");
      manualRunCompleted = true;
    }
    if (!config.dryRun && !cycle.skipRunInsert) {
      const supercronRunId = await insertSupercronRunWithGoldenQueryRuns(sql, runId, config.pyramidFocus, cycle, totalActions);
      if (config.manualRun) await linkManualRunToSupercronRun(config.manualRun.id, supercronRunId);
    } else if (cycle.skipRunInsert && !config.dryRun) {
      console.log(`[SUPERCRON] Cycle #${config.cycleNumber} skipped persistent run insert: ${cycle.skipRunInsertReason || "skipped"}`);
    }

    console.log(`\n[SUPERCRON] Done (${cycle.status}): ${totalActions} actions | T1=${tierMs[1]}ms T2=${tierMs[2]}ms T3=${tierMs[3]}ms T4=${tierMs[4]}ms`);
    if (cycle.degradedReason) console.error(`[SUPERCRON] degraded_reason=${cycle.degradedReason}`);

    // Print pass summary
    for (const r of results) {
      const status = r.skipped ? `SKIP (${r.details.reason || "skipped"})` : `${r.actions} actions`;
      console.log(`  ${r.name.padEnd(22)} ${status.padEnd(20)} ${r.ms}ms`);
      if (config.dryRun && config.onlyPass && Object.keys(r.details).length > 0) {
        console.log(`    details: ${JSON.stringify(r.details)}`);
      }
    }
  } catch (err: any) {
    const msg = err?.message?.slice(0, 500) || "cycle_exception";
    const errorFields = structuredCycleErrorFields(err);
    if (manualRunCompleted) {
      console.error("[SUPERCRON] Manual run completed but failed to link supercron_runs row:", msg);
    } else if (config && !config.dryRun) {
      try {
        await sql`
          INSERT INTO supercron_runs (run_id, started_at, finished_at, pyramid_focus,
            tier1_ms, tier2_ms, tier3_ms, tier4_ms, pass_results, total_actions,
            status, quality_report, degraded_reason)
          VALUES (${runId || `${config.cycleNumber}-${config.pyramidFocus}`}, ${fallbackStartedAt},
            now(), ${config.pyramidFocus},
            0, 0, 0, 0,
            ${sql.json([])}, 0,
            'error', ${sql.json(cycleExceptionQualityReport(msg, errorFields))}, ${`cycle_exception:${msg}`})`;
        if (config.manualRun && !manualRunCompleted) await markManualRunStatus(config.manualRun.id, "failed");
      } catch (insertErr: any) {
        console.error("[SUPERCRON] Failed to record error run:", insertErr?.message);
      }
    }
    throw err;
  } finally {
    try {
      await closeLoadedTrendServiceSafely();
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
      await closeSql();
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[SUPERCRON] Fatal:", err);
    process.exit(1);
  });
}
