/**
 * SuperCron Integration Test Suite
 *
 * Validates that supercron produces correct outputs by:
 * 1. Snapshotting graph state before a run
 * 2. Running supercron (dry or live)
 * 3. Comparing expected vs actual outcomes
 *
 * Usage:
 *   bun run miners/src/supercron-test.ts                 # full test suite
 *   bun run miners/src/supercron-test.ts --live           # live run (writes to DB)
 *   bun run miners/src/supercron-test.ts --test pass1     # single pass test
 */

import postgres from "postgres";
import { TRUTH_PYRAMIDS } from "@verity-one/graph-shape";
import {
  buildDistillerFusionPassOptions,
  buildSupercronConfig,
  formatDistillerFusionPassResult,
  runDistillerSimpleConfidencePromotion,
} from "./supercron";
import {
  computeMemoryHealthDeltas,
  evaluateQualityReport,
  collectMemoryHealthSnapshot,
  type MemoryHealthSnapshot,
} from "./supercron-health";
import { applyApprovedRegistryReconciliationProposals } from "./lib/registry-reconciliation";

const TRUTH_LIST: string[] = [...TRUTH_PYRAMIDS];

const sql = postgres(process.env.DATABASE_URL || "postgresql://localhost:5432/verity");
const LIVE = process.argv.includes("--live");
const SINGLE_PASS = process.argv.includes("--test")
  ? process.argv[process.argv.indexOf("--test") + 1]
  : null;

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  ms: number;
}

const results: TestResult[] = [];
const CWD = ".";
const ZERO_HALFVEC = `[${Array(3072).fill(0).join(",")}]`;

function test(name: string, passed: boolean, details: string, ms: number) {
  results.push({ name, passed, details, ms });
  const icon = passed ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${name} (${ms}ms) — ${details}`);
}

async function runSupercron(args: string[]): Promise<{ output: string; exitCode: number }> {
  const tmpFile = `/tmp/supercron-test-${Date.now()}.log`;
  const instanceTenantId = process.env.VERITY_INSTANCE_TENANT_ID || "example-tenant";
  const cmd = `cd ${CWD} && VERITY_INSTANCE_TENANT_ID=${instanceTenantId} bun run miners/src/supercron.ts ${args.join(" ")} > ${tmpFile} 2>&1; echo "EXIT:$?" >> ${tmpFile}`;
  const proc = Bun.spawn(["bash", "-c", cmd]);
  await proc.exited;
  const output = await Bun.file(tmpFile).text();
  const exitMatch = output.match(/EXIT:(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1;
  try { await Bun.write(tmpFile, ""); } catch {}
  return { output, exitCode };
}

// ============================================================
// Snapshot helpers
// ============================================================

async function snapshot() {
  const [nodes] = await sql`SELECT count(*)::int AS cnt FROM nodes WHERE visibility = 'public'`;
  const [edges] = await sql`SELECT count(*)::int AS cnt FROM edges`;
  const [mergedNodes] = await sql`SELECT count(*)::int AS cnt FROM nodes WHERE visibility = 'merged'`;
  const [dormantNodes] = await sql`SELECT count(*)::int AS cnt FROM nodes WHERE visibility = 'dormant'`;
  const [tensions] = await sql`SELECT count(*)::int AS cnt FROM edge_tensions`;
  const [proposals] = await sql`SELECT count(*)::int AS cnt FROM proposals WHERE status = 'pending'`;
  const [selfLoops] = await sql`SELECT count(*)::int AS cnt FROM edges WHERE from_addr = to_addr`;
  const [dupeEdges] = await sql`
    SELECT count(*)::int AS cnt FROM (
      SELECT from_addr, to_addr, edge_type, count(*) AS n
      FROM edges GROUP BY from_addr, to_addr, edge_type HAVING count(*) > 1
    ) dupes`;
  const [orphanNodes] = await sql`
    SELECT count(*)::int AS cnt FROM nodes n
    LEFT JOIN edges e ON e.from_addr = n.addr OR e.to_addr = n.addr
    WHERE e.id IS NULL AND n.layer > 0 AND n.visibility = 'public'`;
  const [truthless] = await sql`
    SELECT count(*)::int AS cnt FROM nodes n
    LEFT JOIN edges e ON (e.to_addr = n.addr OR e.from_addr = n.addr) AND e.edge_type = 'grounds'
      AND (EXISTS (SELECT 1 FROM nodes src WHERE src.addr = e.from_addr AND src.pyramid_id = ANY(${TRUTH_LIST}::text[]))
        OR EXISTS (SELECT 1 FROM nodes src WHERE src.addr = e.to_addr AND src.pyramid_id = ANY(${TRUTH_LIST}::text[])))
    WHERE n.visibility = 'public' AND n.node_type != 'memory' AND n.embedding_hv IS NOT NULL AND e.id IS NULL`;
  const [supercronState] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_cycle_number'`;
  const [lastRun] = await sql`SELECT * FROM supercron_runs ORDER BY id DESC LIMIT 1`;
  const [feedbackSync] = await sql`SELECT value FROM graph_state WHERE key = 'atom_feedback_last_sync'`;

  return {
    publicNodes: nodes.cnt,
    edges: edges.cnt,
    mergedNodes: mergedNodes.cnt,
    dormantNodes: dormantNodes.cnt,
    tensions: tensions.cnt,
    pendingProposals: proposals.cnt,
    selfLoops: selfLoops.cnt,
    dupeEdges: dupeEdges.cnt,
    orphanNodes: orphanNodes.cnt,
    truthlessNodes: truthless.cnt,
    cycleNumber: parseInt(supercronState?.value || "0"),
    lastRun,
    feedbackSync: feedbackSync?.value || null,
  };
}

// ============================================================
// Test: Schema exists
// ============================================================

async function testSchema() {
  const t0 = Date.now();
  const [table] = await sql`
    SELECT 1 FROM information_schema.tables WHERE table_name = 'supercron_runs'`;
  test("schema_exists", !!table, "supercron_runs table exists", Date.now() - t0);
  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'supercron_runs'
      AND column_name IN ('quality_report', 'degraded_reason')`;
  const columnsByName = new Map(columns.map((r) => [r.column_name, r]));
  const quality = columnsByName.get("quality_report");
  const degradedReason = columnsByName.get("degraded_reason");
  const qualityDefault = String(quality?.column_default || "");
  test("schema_quality_report_columns",
    quality?.data_type === "jsonb"
      && quality?.is_nullable === "NO"
      && (qualityDefault.includes("'{}'::jsonb") || qualityDefault.includes("\"warnings\""))
      && degradedReason?.data_type === "text",
    `quality=${quality?.data_type}/${quality?.is_nullable}/${quality?.column_default} degraded_reason=${degradedReason?.data_type}`,
    Date.now() - t0);

  const [gs1] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_cycle_number'`;
  const [gs2] = await sql`SELECT value FROM graph_state WHERE key = 'supercron_last_pyramid'`;
  test("graph_state_seeded", !!gs1 && !!gs2,
    `cycle=${gs1?.value} pyramid=${gs2?.value}`, Date.now() - t0);
}

// ============================================================
// Test: Dry run produces zero actions
// ============================================================

async function testDryRun() {
  const t0 = Date.now();
  const before = await snapshot();

  const { output } = await runSupercron(["--dry-run", "--force"]);

  const after = await snapshot();
  const noChanges = before.publicNodes === after.publicNodes
    && before.edges === after.edges
    && before.mergedNodes === after.mergedNodes
    && before.lastRun?.id === after.lastRun?.id;

  test("dry_run_no_writes", noChanges,
    `nodes: ${before.publicNodes}→${after.publicNodes}, edges: ${before.edges}→${after.edges}, run=${before.lastRun?.id || 0}→${after.lastRun?.id || 0}`,
    Date.now() - t0);

  const hasDefaultPolicyPasses = output.includes("heat_refresh") && output.includes("tension_scan")
    && output.includes("memory_lifecycle") && output.includes("node_health")
    && output.includes("edge_integrity") && output.includes("digest")
    && !output.includes("distiller_simple")
    && !output.includes("tension_synthesis");
  test("dry_run_default_light_policy", hasDefaultPolicyPasses,
    hasDefaultPolicyPasses ? "default light policy passes appear in output" : "default light policy output mismatch",
    Date.now() - t0);
}

function zeroHealth(overrides: Partial<MemoryHealthSnapshot> = {}): MemoryHealthSnapshot {
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
    ...overrides,
  };
}

async function testQualityReportUnits() {
  const t0 = Date.now();
  const before = zeroHealth({
    active_registry_dormant_nodes: 1,
    active_registry_dormant_without_events: 0,
    duplicate_edge_groups: 2,
  });
  const after = zeroHealth({
    active_registry_dormant_nodes: 3,
    active_registry_dormant_without_events: 2,
    duplicate_edge_groups: 1,
  });
  const delta = computeMemoryHealthDeltas(before, after);
  test("quality_report_delta_math",
    delta.active_registry_dormant_nodes === 2 && delta.duplicate_edge_groups === -1,
    `active_dormant=${delta.active_registry_dormant_nodes} duplicate_edges=${delta.duplicate_edge_groups}`,
    Date.now() - t0);

  const report = evaluateQualityReport({
    before,
    after,
    delta,
    pass_results: [{ name: "memory_lifecycle", details: { error: "boom" } }],
    audit_events_written: 0,
  });
  test("quality_report_degraded_on_invariant_or_pass_error",
    report.degraded === true
      && report.degraded_reason === "4 warnings; first: pass_error[memory_lifecycle]:boom"
      && report.warnings.some((w) => w.startsWith("active_dormant_without_lifecycle_event")),
    `degraded=${report.degraded} reason=${report.degraded_reason} warnings=${report.warnings.length}`,
    Date.now() - t0);

  const invariantOnly = evaluateQualityReport({
    before,
    after,
    delta,
    pass_results: [],
    audit_events_written: 0,
  });
  test("quality_report_flags_active_dormant_without_event",
    invariantOnly.degraded === true
      && invariantOnly.warnings.includes("active_dormant_without_lifecycle_event:2"),
    `degraded=${invariantOnly.degraded} reason=${invariantOnly.degraded_reason}`,
    Date.now() - t0);

  for (const key of [
    "active_registry_dormant_nodes",
    "inactive_registry_active_nodes",
    "lifecycle_mutations_without_events",
  ] as (keyof MemoryHealthSnapshot)[]) {
    const absoluteBefore = zeroHealth({ [key]: 7 });
    const absoluteAfter = zeroHealth({ [key]: 7 });
    const absoluteDelta = computeMemoryHealthDeltas(absoluteBefore, absoluteAfter);
    const absoluteReport = evaluateQualityReport({
      before: absoluteBefore,
      after: absoluteAfter,
      delta: absoluteDelta,
      pass_results: [],
      audit_events_written: 0,
    });
    test(`quality_report_absolute_invariant_breach_triggers_degraded_${key}`,
      absoluteReport.degraded === true
        && absoluteReport.degraded_reason === `absolute_invariant_breach:${key}:7`
        && absoluteReport.warnings.some((w) => w === `absolute_invariant_breach:${key}:7`),
      `degraded=${absoluteReport.degraded} reason=${absoluteReport.degraded_reason}`,
      Date.now() - t0);
  }

  const goldenLowPassRate = evaluateQualityReport({
    before: zeroHealth(),
    after: zeroHealth(),
    delta: computeMemoryHealthDeltas(zeroHealth(), zeroHealth()),
    pass_results: [{
      name: "golden_query",
      details: {
        golden_pass_rate: 0.5,
        golden_cases_run: 10,
        golden_cases_failed: 4,
        golden_cases_errored: 1,
        golden_cases_skipped: 0,
        golden_cases_total: 10,
        golden_cases_unscanned: 0,
        regressed_cases: ["stripe-decision"],
      },
    }],
    audit_events_written: 0,
  });
  test("quality_report_absolute_golden_pass_rate_breach_triggers_degraded",
    goldenLowPassRate.degraded === true
      && goldenLowPassRate.degraded_reason === "absolute_invariant_breach:golden_pass_rate:0.500"
      && goldenLowPassRate.golden_pass_rate === 0.5
      && goldenLowPassRate.golden_cases_run === 10
      && goldenLowPassRate.golden_cases_skipped === 0
      && goldenLowPassRate.golden_cases_total === 10
      && goldenLowPassRate.golden_cases_unscanned === 0
      && goldenLowPassRate.regressed_cases_total === 1
      && goldenLowPassRate.regressed_cases.includes("stripe-decision"),
    `degraded=${goldenLowPassRate.degraded} reason=${goldenLowPassRate.degraded_reason} pass_rate=${goldenLowPassRate.golden_pass_rate}`,
    Date.now() - t0);

  const goldenLowCoverage = evaluateQualityReport({
    before: zeroHealth(),
    after: zeroHealth(),
    delta: computeMemoryHealthDeltas(zeroHealth(), zeroHealth()),
    pass_results: [{
      name: "golden_query",
      details: {
        golden_pass_rate: 1,
        golden_cases_run: 2,
        golden_cases_failed: 0,
        golden_cases_errored: 0,
        golden_cases_skipped: 4,
        golden_cases_total: 6,
        golden_cases_unscanned: 0,
        regressed_cases_total: 0,
        regressed_cases: [],
      },
    }],
    audit_events_written: 0,
  });
  test("quality_report_golden_query_low_coverage_triggers_degraded",
    goldenLowCoverage.degraded === true
      && goldenLowCoverage.degraded_reason === "golden_query_low_coverage:4/6"
      && goldenLowCoverage.golden_cases_skipped === 4,
    `degraded=${goldenLowCoverage.degraded} reason=${goldenLowCoverage.degraded_reason} skipped=${goldenLowCoverage.golden_cases_skipped}`,
    Date.now() - t0);

  const existingBreach = zeroHealth({ active_registry_dormant_nodes: 7 });
  const cooldownWithExistingBreach = evaluateQualityReport({
    before: existingBreach,
    after: existingBreach,
    delta: computeMemoryHealthDeltas(existingBreach, existingBreach),
    pass_results: [{ name: "memory_merge", details: { error: "model_cooldown" } }],
    audit_events_written: 0,
  });
  test("quality_report_model_cooldown_does_not_mask_existing_invariant",
    cooldownWithExistingBreach.degraded === true
      && cooldownWithExistingBreach.degraded_reason === "absolute_invariant_breach:active_registry_dormant_nodes:7"
      && cooldownWithExistingBreach.pass_errors.length === 0
      && cooldownWithExistingBreach.cooldown_events.length === 1,
    `degraded=${cooldownWithExistingBreach.degraded} reason=${cooldownWithExistingBreach.degraded_reason} pass_errors=${cooldownWithExistingBreach.pass_errors.length} cooldowns=${cooldownWithExistingBreach.cooldown_events.length}`,
    Date.now() - t0);

  const clean = zeroHealth();
  const cleanCooldownOnly = evaluateQualityReport({
    before: clean,
    after: clean,
    delta: computeMemoryHealthDeltas(clean, clean),
    pass_results: [{ name: "memory_merge", details: { error: "model_cooldown" } }],
    audit_events_written: 0,
  });
  test("quality_report_model_cooldown_not_degraded",
    cleanCooldownOnly.degraded === false
      && cleanCooldownOnly.pass_errors.length === 0
      && cleanCooldownOnly.cooldown_events.length === 1
      && cleanCooldownOnly.snapshot_overhead_ms === 0
      && cleanCooldownOnly.snapshot_skipped === false,
    `degraded=${cleanCooldownOnly.degraded} pass_errors=${cleanCooldownOnly.pass_errors.length} cooldowns=${cleanCooldownOnly.cooldown_events.length} snapshot_ms=${cleanCooldownOnly.snapshot_overhead_ms}`,
    Date.now() - t0);

	  const cooldownOverrideOnly = evaluateQualityReport({
    before: clean,
    after: clean,
    delta: computeMemoryHealthDeltas(clean, clean),
    pass_results: [],
    audit_events_written: 0,
    cooldown_overrides: ["cooldown_triggered:memory_merge", "", "tier3_controller_skip"],
  });
  test("quality_report_cooldown_overrides_are_audit_only",
    cooldownOverrideOnly.degraded === false
      && cooldownOverrideOnly.cooldown_overrides.length === 2
      && cooldownOverrideOnly.cooldown_overrides[0] === "cooldown_triggered:memory_merge"
      && cooldownOverrideOnly.cooldown_overrides[1] === "tier3_controller_skip",
    `degraded=${cooldownOverrideOnly.degraded} overrides=${cooldownOverrideOnly.cooldown_overrides.join(",")}`,
    Date.now() - t0);

  const testPolicy = Object.freeze({
    tenantId: "example-tenant",
    cadenceMinutes: 240,
    dailyBudgetMicro: 170_000,
    activeHours: Object.freeze({ start: 0, end: 24 }),
    withinActiveHours: true,
    intensity: "light" as const,
    tierList: Object.freeze([1]),
    qualityPreset: "balanced" as const,
    thresholds: Object.freeze({ golden_pass_rate_min: 0.8, cooldown_ratio_min: 0.2, low_coverage_pct: 0.5 }),
    pyramidFocus: Object.freeze([]),
    features: Object.freeze({
      goldenQueryEnabled: true,
      recallOutcomesEnabled: true,
      confidencePromotionEnabled: true,
    }),
  });
  const testBudgetCache = {
    currentState: () => ({
      tenantId: testPolicy.tenantId,
      dailyCapMicro: 170_000,
      carryoverBalanceMicro: 0,
      spendTodayMicro: 0,
      manualSpendTodayMicro: 0,
      lastRolloverAt: new Date(0),
      updatedAt: new Date(0),
    }),
    evaluateBudgetCheck: () => ({ allowed: true, reason: "ok", remainingMicro: 170_000 }),
    recordLlmSpend: async () => undefined,
  };
	  const forcedConfig = buildSupercronConfig(
	    {
      dryRun: true,
      watch: false,
      once: true,
      stats: false,
      tiers: [1],
      pyramidOverride: null,
      onlyPass: null,
      force: true,
	    },
	    41,
	    "PROJECTS",
	    testPolicy,
	    testBudgetCache as any,
	  );
  test("supercron_config_preserves_force_flag",
    forcedConfig.force === true && forcedConfig.controllerErrors.length === 0,
    `force=${forcedConfig.force} controller_errors=${forcedConfig.controllerErrors.length}`,
    Date.now() - t0);

  const controllerErrorReport = evaluateQualityReport({
    before: clean,
    after: clean,
    delta: computeMemoryHealthDeltas(clean, clean),
    pass_results: [{
      name: "controller_error",
      details: {
        reason: "controller_error",
        error: "controller_error",
        failed_check: "shouldRunPass",
        target_pass: "memory_lifecycle",
      },
    }],
    audit_events_written: 0,
  });
  test("quality_report_surfaces_controller_error",
    controllerErrorReport.degraded === true
      && controllerErrorReport.pass_errors.some((err) => err.name === "controller_error" && err.error === "controller_error")
      && controllerErrorReport.warnings.some((warning) => warning === "pass_error[controller_error]:controller_error"),
    `degraded=${controllerErrorReport.degraded} pass_errors=${controllerErrorReport.pass_errors.length}`,
    Date.now() - t0);

  let malformedMessage = "";
  try {
    evaluateQualityReport({} as any);
  } catch (err: any) {
    malformedMessage = err?.message || "";
  }
  test("quality_report_rejects_malformed_input",
    malformedMessage.includes("before, after, and delta"),
    malformedMessage || "malformed input was accepted",
    Date.now() - t0);
}

async function testRegistryReconciliationApplySmoke() {
  const t0 = Date.now();
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const addr = `PJ.0.3.${Date.now()}`;
  const tenantId = "testb";
  const rollback = Symbol("rollback");
  let baseline = 0;
  let afterSeed = 0;
  let afterApply = 0;
  let proposalCreated = false;
  let proposalApplied = false;
  let eventWritten = false;

  try {
    await sql.begin(async (tx: any) => {
      baseline = (await collectMemoryHealthSnapshot(tx)).active_registry_dormant_nodes;
      await tx`
        INSERT INTO nodes (
          addr, pyramid_id, layer, depth, position, label, substance, confidence,
          hash, provenance, visibility, node_type, pinned, space_id, dormant_at,
          source_refs, embedding_hv, embedding_at, embedding_model, embedding_task_type
        )
        VALUES (
          ${addr}, 'PROJECTS', 0, 0, 990001, 'PR9b registry repair smoke',
          ${tx.json({ description: "PR9b registry repair smoke", memory_type: "context" })},
          0.5, ${`pr9b-smoke-${runId}`}, ${tx.json({ agent: "supercron-test" })},
          'dormant', 'memory', false, ${`tenant:${tenantId}`}, now(),
          ${tx.json([{ path: "miners/src/supercron-test.ts" }])},
          ${ZERO_HALFVEC}::halfvec(3072), now(), 'gemini-embedding-001', 'RETRIEVAL_DOCUMENT'
        )`;
      await tx`
        INSERT INTO memory_registry (addr, tenant_id, kind, status, accepted_by_user, source_kind)
        VALUES (${addr}, ${tenantId}, 'context', 'active', false, 'agent_inferred')`;
      await tx`
        INSERT INTO memory_events (addr, tenant_id, event_type, event_data, actor, correlation_id)
        VALUES (${addr}, ${tenantId}, 'archived', ${tx.json({ reason: "seed terminal event" })}, 'supercron-test', ${`pr9b-smoke-${runId}-seed`})`;

      afterSeed = (await collectMemoryHealthSnapshot(tx)).active_registry_dormant_nodes;
      const [created] = await tx`
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
          WHERE mr.addr = ${addr}
            AND mr.status = 'active'
            AND mr.tenant_id IS NOT NULL
            AND length(mr.tenant_id) > 0
            AND n.node_type = 'memory'
            AND n.visibility IN ('dormant', 'merged')
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
              'suggestion_source', 'memory_events',
              'requires_review', true,
              'mode', 'proposal_only'
            ),
            0.85,
            'supercron-registry-repair',
            jsonb_build_array(jsonb_build_object('type', 'registry_node_visibility_drift', 'cycle_number', -1, 'source_memory_event_id', memory_event_id)),
            'pending'
          FROM mismatches
          RETURNING id, payload
        )
        SELECT id, payload FROM inserted`;
      proposalCreated = !!created?.id && created.payload?.suggested_terminal_status === "archived";
      await tx`
        UPDATE proposals
        SET status = 'approved', reviewed_by = 'operator:test', reviewed_at = now()
        WHERE id = ${created.id}`;
      const appliedCount = await applyApprovedRegistryReconciliationProposals(tx, "qc-sentinel");
      const [applied] = await tx`SELECT status, applied_at IS NOT NULL AS has_applied_at FROM proposals WHERE id = ${created.id}`;
      proposalApplied = appliedCount >= 1 && applied?.status === "applied" && applied?.has_applied_at === true;
      const [event] = await tx`
        SELECT 1
        FROM memory_events
        WHERE addr = ${addr}
          AND tenant_id = ${tenantId}
          AND correlation_id LIKE 'supercron-%-registry-reconcile-apply'
        LIMIT 1`;
      eventWritten = !!event;
      afterApply = (await collectMemoryHealthSnapshot(tx)).active_registry_dormant_nodes;
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }

  test("registry_reconciliation_smoke_apply_clears_active_dormant_invariant",
    proposalCreated
      && proposalApplied
      && eventWritten
      && afterSeed === baseline + 1
      && afterApply === baseline,
    `baseline=${baseline} after_seed=${afterSeed} after_apply=${afterApply} proposal=${proposalCreated} applied=${proposalApplied} event=${eventWritten}`,
    Date.now() - t0);
}

// ============================================================
// Test: Tier isolation
// ============================================================

async function testTierIsolation() {
  const t0 = Date.now();

  const { output } = await runSupercron(["--dry-run", "--force", "--tier", "1"]);

  const hasT1 = output.includes("heat_refresh") && output.includes("tension_scan");
  const noT2 = !output.includes("distiller_simple") && !output.includes("supersession");
  const noT3 = !output.includes("tension_synthesis") && !output.includes("archetype_detection");
  test("tier_isolation", hasT1 && noT2 && noT3,
    `T1=${hasT1} noT2=${noT2} noT3=${noT3}`, Date.now() - t0);
}

// ============================================================
// Test: Pyramid scoping
// ============================================================

async function testPyramidScoping() {
  const t0 = Date.now();

  const { output } = await runSupercron(["--dry-run", "--force", "--pyramid", "WORLD"]);

  const scopedCorrectly = output.includes("pyramid=WORLD");
  test("pyramid_scoping", scopedCorrectly,
    scopedCorrectly ? "WORLD pyramid correctly scoped" : "wrong pyramid in output",
    Date.now() - t0);
}

// ============================================================
// Test: Stats mode (read-only)
// ============================================================

async function testStatsMode() {
  const t0 = Date.now();
  const before = await snapshot();

  const { output } = await runSupercron(["--stats"]);

  const after = await snapshot();
  const noChanges = before.cycleNumber === after.cycleNumber;
  const hasOutput = output.includes("SUPERCRON") && (output.includes("Last 10 runs") || output.includes("No runs"));
  test("stats_read_only", noChanges && hasOutput,
    `no state change=${noChanges} output=${hasOutput}`, Date.now() - t0);
}

// ============================================================
// Test: Lock contention
// ============================================================

async function testLockContention() {
  const t0 = Date.now();

  // Use a separate connection to hold lock 44
  const lockSql = postgres(process.env.DATABASE_URL || "postgresql://localhost:5432/verity");
  try {
    await lockSql`SELECT pg_advisory_lock(44)`;

    const { output, exitCode } = await runSupercron(["--tier", "1"]);

    const lockedOut = exitCode !== 0 || output.includes("Lock held");
    test("lock_contention", lockedOut,
      lockedOut ? "correctly refused with lock held" : `unexpected: exit=${exitCode}`,
      Date.now() - t0);
  } finally {
    await lockSql`SELECT pg_advisory_unlock(44)`;
    await lockSql.end();
  }
}

// ============================================================
// Test: Only-pass policy gate
// ============================================================

async function testOnlyPassPolicyGate() {
  const t0 = Date.now();
  const { output, exitCode } = await runSupercron(["--dry-run", "--only", "trend_maintenance", "--once"]);
  const gated = exitCode === 0
    && output.includes("trend_maintenance")
    && output.includes("tier_disabled_for_tenant");
  test("only_pass_respects_tenant_intensity",
    gated,
    gated ? "--only trend_maintenance is skipped under default light policy" : output.slice(0, 200),
    Date.now() - t0);
}

// ============================================================
// Test: Live run (optional) — Pass 1 heat refresh
// ============================================================

async function testLivePass1() {
  const t0 = Date.now();

  const { output } = await runSupercron(["--tier", "1"]);

  // Heat refresh should produce at least 1 action (the function always does work)
  const heatLine = output.split("\n").find(l => l.includes("heat_refresh"));
  const hasActions = heatLine && !heatLine.includes("0 actions");
  test("live_pass1_heat", !!hasActions,
    heatLine?.trim() || "no heat_refresh line", Date.now() - t0);
}

// ============================================================
// Test: Live run — Pass 5 edge integrity
// ============================================================

async function testLivePass5() {
  const t0 = Date.now();
  const before = await snapshot();

  await runSupercron(["--tier", "1"]);

  const after = await snapshot();

  // Self-loops should be 0 or stay 0
  test("no_self_loops", after.selfLoops === 0,
    `self_loops: ${before.selfLoops}→${after.selfLoops}`, Date.now() - t0);

  // Dupe edges should decrease or stay at 0
  test("dupe_edges_decreasing", after.dupeEdges <= before.dupeEdges,
    `dupes: ${before.dupeEdges}→${after.dupeEdges}`, Date.now() - t0);
}

// ============================================================
// Test: Live run — Run record created
// ============================================================

async function testRunRecord() {
  const t0 = Date.now();
  const before = await snapshot();

  await runSupercron(["--tier", "1,4"]);

  const after = await snapshot();
  const newRun = after.cycleNumber > before.cycleNumber;
  test("run_record_created", newRun,
    `cycle: ${before.cycleNumber}→${after.cycleNumber}`, Date.now() - t0);

  // Verify pass_results JSONB is populated
  const [latest] = await sql`SELECT pass_results, quality_report, status, degraded_reason FROM supercron_runs ORDER BY id DESC LIMIT 1`;
  const hasPassResults = Array.isArray(latest?.pass_results) && latest.pass_results.length > 0;
  test("pass_results_populated", hasPassResults,
    `pass_results has ${latest?.pass_results?.length || 0} entries`, Date.now() - t0);
  const report = latest?.quality_report || {};
  const hasQualityReport = typeof report === "object"
    && report !== null
    && typeof report.before === "object"
    && typeof report.after === "object"
    && typeof report.delta === "object"
    && Array.isArray(report.warnings)
    && ["completed", "degraded"].includes(String(latest?.status));
  test("quality_report_populated", hasQualityReport,
    `status=${latest?.status || "?"} warnings=${Array.isArray(report.warnings) ? report.warnings.length : "?"} reason=${latest?.degraded_reason || "none"}`,
    Date.now() - t0);
}

// ============================================================
// Test: Atom feedback sync is wired
// ============================================================

async function testAtomFeedback() {
  const t0 = Date.now();

  // Check that atom_feedback_last_sync exists in graph_state after run
  const [sync] = await sql`SELECT value FROM graph_state WHERE key = 'atom_feedback_last_sync'`;
  test("atom_feedback_synced", !!sync,
    sync ? `last_sync=${sync.value}` : "no sync record", Date.now() - t0);
}

// ============================================================
// Test: Reactor still works after slimming
// ============================================================

async function testReactorSlim() {
  const t0 = Date.now();

  const tmpFile = `/tmp/reactor-test-${Date.now()}.log`;
  const proc = Bun.spawn(["bash", "-c", `cd ${CWD} && bun run miners/src/reactor.ts --stats > ${tmpFile} 2>&1; echo "EXIT:$?" >> ${tmpFile}`]);
  await proc.exited;
  const output = await Bun.file(tmpFile).text();
  const exitMatch = output.match(/EXIT:(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1;

  const ok = exitCode === 0 && output.includes("Resonance Reactor Stats");
  test("reactor_stats_ok", ok,
    ok ? "reactor --stats works" : `exit=${exitCode}`, Date.now() - t0);
}

// ============================================================
// Test: Supervisor config updated
// ============================================================

async function testSupervisorConfig() {
  const t0 = Date.now();

  const file = await Bun.file(`${CWD}/scripts/runtime-supervisor.ts`).text();
  const hasSupercron = file.includes('"supercron"') && file.includes("miners/src/supercron.ts");
  const noDistiller = !file.includes('"distiller"');
  test("supervisor_uses_supercron", hasSupercron && noDistiller,
    `supercron=${hasSupercron} no_distiller=${noDistiller}`, Date.now() - t0);
}

// ============================================================
// Test: Distiller simple confidence promotion contract
// ============================================================

async function testDistillerFusionWrapperContract() {
  const t0 = Date.now();
  let allowed = true;
  const options = buildDistillerFusionPassOptions(() => allowed);
  const formatted = formatDistillerFusionPassResult({
    workItemsDetected: 9,
    clustersBuilt: 3,
    proposalsEmitted: 4,
    fusionJudgments: 1,
    fusionDeferred: 2,
    fusionBlocked: 0,
    handoffsSubmitted: 1,
    proposalsResolved: 5,
    proposalsByPacketType: { confidence_promotion_review: 1 },
  });
  const continuesBeforeStop = options.shouldContinue();
  allowed = false;
  const continuesAfterStop = options.shouldContinue();
  const passed = options.nodeScanLimit === 20
    && options.edgeScanLimit === 40
    && options.curatorBudget === 4
    && options.fusionBudget === 1
    && options.requireFusionJudgmentForHandoff === true
    && options.applyDeterministicEdgeCleanup === false
    && options.workerInstance === "supercron-distiller-fusion"
    && options.metadata?.caller === "supercron-pass12"
    && options.metadata?.semantic_audit_packets === true
    && continuesBeforeStop === true
    && continuesAfterStop === false
    && formatted.actions === 1
    && formatted.details.backlog_resolved === 5
    && formatted.details.lifecycle_actions === 10
    && (formatted.details.proposals_by_packet_type as any)?.confidence_promotion_review === 1;

  test("distiller_fusion_wrapper_contract",
    passed,
    `node=${options.nodeScanLimit} edge=${options.edgeScanLimit} curator=${options.curatorBudget} fusion=${options.fusionBudget} actions=${formatted.actions}`,
    Date.now() - t0);
}

async function testDistillerSimplePromotionContract() {
  const t0 = Date.now();

  const file = await Bun.file(`${CWD}/miners/src/supercron.ts`).text();
  const passStart = file.indexOf("export async function runDistillerSimpleConfidencePromotion");
  const passEnd = file.indexOf("\n// Pass 7:", passStart);
  const block = passStart >= 0 && passEnd > passStart ? file.slice(passStart, passEnd) : "";

  const hasMachineCap = file.includes("DISTILLER_SIMPLE_MACHINE_CONFIDENCE_CAP = 0.89");
  const pinsPolicyConstants = [
    "DISTILLER_SIMPLE_PROMOTION_MIN_QUERY_HITS = 3",
    "DISTILLER_SIMPLE_TRUST_THRESHOLD = 0.80",
    "DISTILLER_SIMPLE_STALE_QUERY_HIT_DAYS = 90",
  ].every((token) => file.includes(token));
  const noHumanCapPromotion = !block.includes("LEAST(0.95, confidence + 0.05)");
  const hasAccounting = [
    "promotion_candidates",
    "promotion_attempted",
    "promotion_changed",
    "promotion_already_threshold",
    "promotion_capped",
    "promotion_landed_at_cap",
    "promotion_skipped_protected",
    "promotion_skipped_ungrounded",
    "promotion_skipped_stale_query",
    "promotion_skipped_negative_recall",
    "promotion_recall_positive_candidates",
    "promotion_recall_combined_candidates",
    "promotion_recall_only_candidates",
    "promotion_skipped_guardrail",
    "promotion_audit_verified",
    "promotion_audit_packets_queued",
  ].every((token) => block.includes(token));
  const hasGuardrails = block.includes("pinned = true")
    && !block.includes("utility_class")
    && block.includes("COALESCE(memory_source_kind, '') = 'user_accepted'")
    && block.includes("substance_source_kind = 'user_accepted'")
    && block.includes("substance @> '{\"accepted_by_user\": true}'::jsonb")
    && block.includes("source_ref_count = 0")
    && block.includes("OR missing_provenance = true")
    && block.includes("recall_outcome_events")
    && block.includes("RECALL_OUTCOME_PROMOTION_LOOKBACK_DAYS")
    && block.includes("negative_recall_guardrail")
    && block.includes("positive_recall_outcomes = 0")
    && block.includes("AND n.confidence IS NOT NULL")
    && block.includes("already_threshold = false AND (protected_guardrail OR provenance_guardrail OR stale_query_guardrail OR negative_recall_guardrail)")
    && block.includes("last_queried IS NULL")
    && block.includes("stale_query_guardrail");
  const auditsGraphMutations = block.includes("graph_mutations")
    && block.includes("count(DISTINCT gm.target_addr)")
    && block.includes("old_value->>'confidence'")
    && block.includes("new_value->>'confidence'")
    && block.includes("DISTILLER_SIMPLE_PROMOTION_BOOST")
    && block.includes("promotion_rows")
    && block.includes("confidence_promotion_pressure")
    && block.includes("trg_log_node_mutation");
  const actionsUseChangedRows = block.includes("actions: merged + promotionChanged");

  test("distiller_simple_promotion_contract",
    hasMachineCap && pinsPolicyConstants && noHumanCapPromotion && hasAccounting && hasGuardrails && auditsGraphMutations && actionsUseChangedRows,
    `cap=${hasMachineCap} constants=${pinsPolicyConstants} no_095=${noHumanCapPromotion} accounting=${hasAccounting} guardrails=${hasGuardrails} audit=${auditsGraphMutations} actions=${actionsUseChangedRows}`,
    Date.now() - t0);
}

async function testDistillerSimplePromotionBehavior() {
  const t0 = Date.now();
  const rollback = new Error("rollback distiller promotion behavior");
  const runId = `pr6_${Date.now()}`;
  const pyramidId = `PR6_${Date.now()}`;
  const addr = (suffix: string) => `PJ.PR6.${runId}.${suffix}`;
  let details: Record<string, any> | null = null;
  let recallAuditMetadata: Record<string, any> | null = null;
  let overCap = -1;
  let auditRows = -1;

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO registry (pyramid_id, label, description, access_level)
        VALUES (${pyramidId}, 'PR6 Distiller Test', 'rollback-scoped distiller promotion test', 'private')`;
      await tx`
        CREATE OR REPLACE FUNCTION log_node_mutation() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'UPDATE' THEN
            IF OLD.label IS DISTINCT FROM NEW.label
              OR OLD.confidence IS DISTINCT FROM NEW.confidence
              OR OLD.substance IS DISTINCT FROM NEW.substance
            THEN
              INSERT INTO graph_mutations (mutation_type, target_addr, target_label, old_value, new_value)
              VALUES (
                'node_update',
                NEW.addr,
                NEW.label,
                jsonb_build_object('confidence', OLD.confidence, 'label', OLD.label),
                jsonb_build_object('confidence', NEW.confidence, 'label', NEW.label)
              );
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`;
      await tx`DROP TRIGGER IF EXISTS trg_log_node_mutation ON nodes`;
      await tx`
        CREATE TRIGGER trg_log_node_mutation
        AFTER INSERT OR UPDATE ON nodes
        FOR EACH ROW EXECUTE FUNCTION log_node_mutation()`;
      await tx`
        CREATE TABLE IF NOT EXISTS recall_outcome_events (
          id bigserial PRIMARY KEY,
          recall_id uuid NOT NULL,
          tenant_id text NOT NULL,
          space_id text NOT NULL,
          agent_id text,
          query text,
          event_type text NOT NULL,
          memory_addrs text[] NOT NULL DEFAULT '{}'::text[],
          top_addr text,
          outcome_score numeric(5,3) NOT NULL DEFAULT 0,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          source text NOT NULL DEFAULT 'recall_compiler',
          created_at timestamptz NOT NULL DEFAULT now()
        )`;

      const rows = [
        { s: "good84", confidence: 0.84, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/a.md" }], prov: { agent: "test" } },
        { s: "clip88", confidence: 0.88, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/b.md" }], prov: { agent: "test" } },
        { s: "trust75", confidence: 0.75, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/c.md" }], prov: { agent: "test" } },
        { s: "already90", confidence: 0.90, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/d.md" }], prov: { agent: "test" } },
        { s: "already94", confidence: 0.94, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/e.md" }], prov: { agent: "test" } },
        { s: "already95", confidence: 0.95, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/f.md" }], prov: { agent: "test" } },
        { s: "pinned", confidence: 0.82, pinned: true, queryHits: 3, last: "now()", refs: [{ path: "docs/g.md" }], prov: { agent: "test" } },
        { s: "accepted", confidence: 0.82, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/g2.md" }], prov: { agent: "test" }, accepted: true },
        { s: "stale", confidence: 0.82, pinned: false, queryHits: 3, last: "now() - interval '120 days'", refs: [{ path: "docs/h.md" }], prov: { agent: "test" } },
        { s: "null_last", confidence: 0.82, pinned: false, queryHits: 3, last: "NULL", refs: [{ path: "docs/i.md" }], prov: { agent: "test" } },
        { s: "ungrounded", confidence: 0.78, pinned: false, queryHits: 3, last: "now()", refs: [], prov: {} },
        { s: "trivial", confidence: 0.78, pinned: false, queryHits: 3, last: "now()", refs: [{}], prov: { agent: "" } },
        { s: "recall_only", confidence: 0.84, pinned: false, queryHits: 0, last: "NULL", refs: [{ path: "docs/recall.md" }], prov: { agent: "test" } },
        { s: "negative_recall", confidence: 0.82, pinned: false, queryHits: 3, last: "now()", refs: [{ path: "docs/negative.md" }], prov: { agent: "test" } },
      ];

      for (const [i, row] of rows.entries()) {
        await tx`
          INSERT INTO nodes (
            addr, pyramid_id, layer, depth, position, label, substance, confidence,
            hash, provenance, visibility, node_type, pinned, space_id, query_hits,
            last_queried, source_refs, embedding_hv, embedding_at, embedding_model, embedding_task_type
          )
          VALUES (
            ${addr(row.s)}, ${pyramidId}, 0, 0, ${900000 + i}, ${`PR6 ${row.s}`},
            ${tx.json({
              description: row.s,
              memory_type: "context",
              source_kind: "agent_inferred",
              maturity_stage: "encoded",
              ...(row.accepted ? { accepted_by_user: true } : {}),
            })},
            ${row.confidence}, ${`hash-${runId}-${row.s}`}, ${tx.json(row.prov)}, 'public', 'memory',
            ${row.pinned}, 'global', ${row.queryHits}, ${tx.unsafe(row.last)}, ${tx.json(row.refs)}, ${ZERO_HALFVEC}::halfvec(3072),
            now(), 'gemini-embedding-001', 'RETRIEVAL_DOCUMENT'
          )`;
      }

      await tx`
        INSERT INTO recall_outcome_events (
          recall_id, tenant_id, space_id, agent_id, query, event_type,
          memory_addrs, top_addr, outcome_score, evidence, source
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          'test-tenant',
          'global',
          'supercron-test',
          'recall-only promotion',
          'used',
          ${[addr("recall_only"), addr("recall_only")]}::text[],
          ${addr("recall_only")},
          0.4,
          '{"test": "recall_only_promotion"}'::jsonb,
          'supercron-test'
        ), (
          ${crypto.randomUUID()}::uuid,
          'test-tenant',
          'global',
          'supercron-test',
          'negative recall guardrail',
          'confused',
          ${[addr("negative_recall"), addr("negative_recall")]}::text[],
          ${addr("negative_recall")},
          -0.7,
          '{"test": "negative_recall_guardrail"}'::jsonb,
          'supercron-test'
        )`;

      const promotion = await runDistillerSimpleConfidencePromotion(tx as any, pyramidId);
      details = promotion.details;
      const [recallAudit] = await tx`
        SELECT metadata
        FROM distill_work_items
        WHERE scope_kind = 'node'
          AND seed_ref = ${addr("recall_only")}
          AND pressure_type = 'confidence_promotion_pressure'
        LIMIT 1`;
      recallAuditMetadata = typeof recallAudit?.metadata === "string"
        ? JSON.parse(recallAudit.metadata)
        : recallAudit?.metadata || null;
      const [cap] = await tx`
        SELECT count(*)::int AS cnt
        FROM nodes
        WHERE addr = ANY(${[addr("good84"), addr("clip88"), addr("trust75")]}::text[])
          AND confidence > 0.89`;
      overCap = cap.cnt;
      const [audit] = await tx`
        SELECT count(DISTINCT target_addr)::int AS cnt
        FROM graph_mutations
        WHERE target_addr LIKE ${`PJ.PR6.${runId}.%`}
          AND mutation_type = 'node_update'
          AND old_value->>'confidence' IS NOT NULL
          AND new_value->>'confidence' IS NOT NULL
          AND old_value->>'confidence' != new_value->>'confidence'`;
      auditRows = audit.cnt;

      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }

  const passed = details?.promotion_changed === 4
    && details?.promotion_already_threshold === 3
    && details?.promotion_capped === 1
    && details?.promotion_recall_positive_candidates === 1
    && details?.promotion_recall_combined_candidates === 0
    && details?.promotion_recall_only_candidates === 1
    && details?.promotion_skipped_negative_recall === 1
    && details?.promotion_skipped_guardrail === 7
    && details?.promotion_audit_installed === true
    && details?.promotion_audit_verified === 4
    && details?.promotion_audit_warning === false
    && details?.promotion_audit_packets_queued === 2
    && recallAuditMetadata?.promotion_recall_only === true
    && Number(recallAuditMetadata?.recall_outcome_score || 0) === 0.4
    && Number(recallAuditMetadata?.positive_recall_outcomes || 0) === 1
    && Number(recallAuditMetadata?.negative_recall_outcomes || 0) === 0
    && overCap === 0
    && auditRows === 4;

  test("distiller_simple_promotion_behavior",
    passed,
    `changed=${details?.promotion_changed} already=${details?.promotion_already_threshold} clipped=${details?.promotion_capped} skipped=${details?.promotion_skipped_guardrail} audit=${details?.promotion_audit_verified}/${auditRows} packets=${details?.promotion_audit_packets_queued} over_cap=${overCap}`,
    Date.now() - t0);
}

// ============================================================
// Test: Graph invariants hold after supercron runs
// ============================================================

async function testGraphInvariants() {
  const t0 = Date.now();
  const snap = await snapshot();

  // No self-loops
  test("invariant_no_self_loops", snap.selfLoops === 0,
    `self_loops=${snap.selfLoops}`, Date.now() - t0);

  // No duplicate edges
  test("invariant_no_dupe_edges", snap.dupeEdges === 0,
    `dupe_edges=${snap.dupeEdges}`, Date.now() - t0);

  // No edges pointing to merged/dormant nodes
  const [deadEdges] = await sql`
    SELECT count(*)::int AS cnt FROM edges e
    JOIN nodes n ON n.addr = e.from_addr OR n.addr = e.to_addr
    WHERE n.visibility IN ('merged')`;
  test("invariant_no_dead_edges", deadEdges.cnt === 0,
    `edges_to_merged=${deadEdges.cnt}`, Date.now() - t0);

  // Memory nodes have no direct truth edges (PJ.0.3.907)
  const [memoryTruth] = await sql`
    SELECT count(*)::int AS cnt FROM edges e
    JOIN nodes n ON n.addr = e.to_addr
    WHERE e.edge_type = 'grounds' AND n.node_type = 'memory'
      AND EXISTS (SELECT 1 FROM nodes t WHERE t.addr = e.from_addr AND t.pyramid_id = ANY(${TRUTH_LIST}::text[]))`;
  test("invariant_no_memory_truth_edges", memoryTruth.cnt === 0,
    `memory_truth_edges=${memoryTruth.cnt}`, Date.now() - t0);
}

// ============================================================
// Run
// ============================================================

async function main() {
  console.log("\n=== SuperCron Integration Tests ===\n");
  console.log(`  Mode: ${LIVE ? "LIVE (writes to DB)" : "DRY + read-only"}`);
  console.log(`  Single pass: ${SINGLE_PASS || "all"}\n`);

  // Always run
  if (!SINGLE_PASS || SINGLE_PASS === "schema") await testSchema();
  if (!SINGLE_PASS || SINGLE_PASS === "dry") await testDryRun();
  if (!SINGLE_PASS || SINGLE_PASS === "tier") await testTierIsolation();
  if (!SINGLE_PASS || SINGLE_PASS === "pyramid") await testPyramidScoping();
  if (!SINGLE_PASS || SINGLE_PASS === "stats") await testStatsMode();
  if (!SINGLE_PASS || SINGLE_PASS === "lock") await testLockContention();
  if (!SINGLE_PASS || SINGLE_PASS === "only") await testOnlyPassPolicyGate();
  if (!SINGLE_PASS || SINGLE_PASS === "supervisor") await testSupervisorConfig();
  if (!SINGLE_PASS || SINGLE_PASS === "quality") await testQualityReportUnits();
  if (LIVE || SINGLE_PASS === "registry-repair") await testRegistryReconciliationApplySmoke();
  if (!SINGLE_PASS || SINGLE_PASS === "distiller") await testDistillerFusionWrapperContract();
  if (!SINGLE_PASS || SINGLE_PASS === "distiller") await testDistillerSimplePromotionContract();
  if (!SINGLE_PASS || SINGLE_PASS === "distiller") await testDistillerSimplePromotionBehavior();
  if (!SINGLE_PASS || SINGLE_PASS === "reactor") await testReactorSlim();

  // Live-only tests
  if (LIVE || SINGLE_PASS === "pass1") await testLivePass1();
  if (LIVE || SINGLE_PASS === "pass5") await testLivePass5();
  if (LIVE || SINGLE_PASS === "record") await testRunRecord();
  if (LIVE || SINGLE_PASS === "feedback") await testAtomFeedback();
  if (LIVE || SINGLE_PASS === "invariants") await testGraphInvariants();

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log("\n  Failures:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ${r.name}: ${r.details}`);
    }
  }
  console.log();

  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
