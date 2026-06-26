/**
 * /run/:addr — Action-ready execution endpoint
 * 
 * The bridge from "I know about this tool" to "I'm using this tool NOW."
 * Combines readiness check + quick_start commands + confidence + context
 * into a single response an agent can act on immediately.
 *
 * GET /run/OC.0.2.49
 * → Prerequisites checked, commands ready, confidence scored, GO or BLOCKED
 *
 * This is what makes VO actionable, not just informational.
 */

import { Hono } from "hono";
import { NON_ACTIONABLE_PYRAMIDS, coalesceMaturityStage } from "@verity-one/graph-shape";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { assertAgentSelfOrOperator, getAccessContext, isOperator, resolveAgentTenant } from "../lib/access";
import { classifyExecutionSurface, classifyNodeExecution } from "../lib/agentic-routing";
import { getDeploymentProfile } from "../lib/db-config";
import { parseJsonField } from "../lib/utils";
import { withResolvedKinds, type SourceRef } from "../lib/source-refs";

function logRunPathEvent(agentId: string, addr: string, status: string, actionability: string, latencyMs: number) {
  (async () => {
    try {
      const runId = agentId.match(/^run-([^:]+):/)?.[1] || null;
      const outcome = actionability === "executable" ? "actionable" : actionability === "dead-end" ? "dead_end" : actionability === "drilldown" ? "useful" : "noise";
      await sql`
        INSERT INTO agent_path_events
          (run_id, agent_id, endpoint, addr_selected, latency_ms, actionability, outcome)
        VALUES
          (${runId}, ${agentId}, ${"/run"}, ${addr}, ${latencyMs}, ${actionability}, ${outcome})`;
    } catch (_) {}
  })();
}

import { ontologyGuidanceSummary } from "../lib/ontology-guidance";
import { classifyGraphEdgeRole, formatOntologyBridgePayload, selectOntologyBridgeContext } from "../lib/ontology-bridges";
import { isNodeReadableForScope } from "../lib/public-graph";
import { checkGuardsSync } from "../lib/guards";

const run = new Hono();

const CHECK_TIMEOUT_MS = 5000;

async function runCmd(test: string): Promise<{ passed: boolean; output?: string; error?: string }> {
  try {
    const proc = Bun.spawn(["bash", "-c", test], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const timeout = setTimeout(() => proc.kill(), CHECK_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    const stdout = await new Response(proc.stdout).text();
    return { passed: exitCode === 0, output: stdout.trim().slice(0, 200) };
  } catch (e) {
    console.error("[run] readiness check failed:", e);
    return { passed: false, error: "execution failed" };
  }
}

function plannedChecks(readiness: any): any[] {
  if (!readiness?.checks?.length) return [];
  return readiness.checks.map((chk: any) => ({
    type: chk.type,
    test: chk.test || chk.var || null,
    tier: chk.tier || "yellow",
    passed: null,
    live_checked: false,
    detail: chk.fix || chk.obtain || "Verification required on an operator host",
    fix: chk.fix,
    obtain: chk.obtain,
  }));
}

run.get("/:addr", async (c) => {
  const addr = c.req.param("addr");
  const agentId = c.req.query("agent");
  const startMs = Date.now();
  const access = getAccessContext(c);
  // F3: live `Bun.spawn(...)` only runs from the long-lived launcher.
  // Serverless operators still see the planned-checks payload, just
  // without executing host commands.
  const liveChecksAllowed = isOperator(c) && getDeploymentProfile() === "long-lived";
  if (agentId && !assertAgentSelfOrOperator(c, agentId)) {
    return errorJson(c, "forbidden");
  }

  // Fetch node with full substance
  const [node] = await sql`
    SELECT n.addr, n.label, n.node_type, n.pyramid_id, n.confidence, n.stimulus_heat, n.resonance,
      n.visibility, n.space_id, n.source_context, r.access_level,
      n.substance->'readiness' as readiness,
      n.substance->'quick_start' as quick_start,
      n.substance->'runbook' as runbook,
      n.substance->'provides' as provides,
      n.substance->'requires' as requires,
      n.substance->>'description' as description,
      n.substance->>'slug' as slug,
      n.substance->'domains' as domains,
      n.substance->>'maturity_stage' as maturity_stage,
      n.query_hits,
      n.source_refs
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
  `;

  if (!node) return errorJson(c, "node_not_found");
  if (!isNodeReadableForScope(access, node)) {
    return errorJson(c, "node_not_found");
  }

  // Source-file pointers (plan Q1=A / Rung 2): kind-typed source_refs so an
  // agent/dashboard can open the backing dossier (e.g. "Open in Obsidian").
  // Surfaced on BOTH the actionable response and the knowledge-node redirect.
  const runSourceRefs = withResolvedKinds((parseJsonField(node.source_refs) as SourceRef[]) ?? []);

  // WORLD/HEURISTIC/TRUTH/TN nodes are knowledge sources, not action targets.
  // Return a helpful redirect instead of attempting to run them.
  // NON_ACTIONABLE_PYRAMIDS is canonical in @verity-one/graph-shape and
  // intentionally includes the legacy non-registry "TRUTH" sentinel so
  // any historical row still tagged that way is also rejected here.
  if (NON_ACTIONABLE_PYRAMIDS.has(node.pyramid_id)) {
    const latencyMs = Date.now() - startMs;
    if (agentId) logRunPathEvent(agentId, addr, "dead-end", "dead-end", latencyMs);
    return c.json({
      ok: true,
      addr,
      label: node.label,
      pyramid_id: node.pyramid_id,
      status: "dead-end",
      actionability: "dead-end",
      reason: `${node.pyramid_id} nodes are knowledge sources, not action targets. Use /search or /context to find an actionable FUNCTION or META node instead.`,
      suggestion: "Use /search?q=<your goal> to find operational nodes, or /ground?goal=<your goal> for a full action plan.",
      ...(runSourceRefs.length > 0 ? { source_refs: runSourceRefs } : {}),
    });
  }

  // 1. Run readiness checks
  const readiness = node.readiness as any;
  const checks: any[] = [];
  let allPassed = liveChecksAllowed;
  let blockers: string[] = [];
  let fixable: string[] = [];

  if (readiness?.checks?.length) {
    if (!liveChecksAllowed) {
      checks.push(...plannedChecks(readiness));
      for (const chk of readiness.checks) {
        const action = chk.fix || chk.obtain || chk.test || chk.var || "Verify prerequisite";
        if (chk.tier === "red") blockers.push(action);
        else fixable.push(action);
      }
    } else {
    for (const chk of readiness.checks) {
      let passed = false;
      let detail = "";

      switch (chk.type) {
        case "command":
        case "service": {
          const result = await runCmd(chk.test);
          passed = result.passed;
          detail = passed ? (result.output || "✓") : (result.error || chk.fix || "failed");
          break;
        }
        case "env": {
          passed = !!process.env[chk.var] && process.env[chk.var]!.length > 0;
          detail = passed ? "set" : `Missing: ${chk.fix || `Set ${chk.var}`}`;
          break;
        }
        case "platform": {
          const requires = chk.requires || [];
          passed = requires.every((r: string) =>
            r === "darwin" ? process.platform === "darwin" :
            r === "linux" ? process.platform === "linux" : true
          );
          detail = passed ? process.platform : `Requires ${requires.join(", ")}`;
          break;
        }
        default:
          detail = `Unknown check type: ${chk.type}`;
      }

      checks.push({ type: chk.type, test: chk.test || chk.var, passed, detail, tier: chk.tier });

      if (!passed) {
        allPassed = false;
        if (chk.tier === "red") blockers.push(chk.fix || chk.test || chk.var);
        else fixable.push(chk.fix || chk.obtain || chk.test || chk.var);
      }
    }
    }
  }

  // 2. Build action-ready quick_start
  const quickStart = node.quick_start as any;
  const runbook = node.runbook as any;
  let commands: any = null;
  const quickStartSurface = classifyExecutionSurface(quickStart);
  const runbookSurface = classifyExecutionSurface(runbook);
  const executionSurface = quickStartSurface.kind === "executable"
    ? quickStartSurface
    : runbookSurface.kind === "executable"
      ? runbookSurface
      : quickStartSurface.kind !== "none"
        ? quickStartSurface
        : runbookSurface;
  const commandSource = quickStartSurface.kind === "executable"
    ? quickStart
    : runbookSurface.kind === "executable"
      ? runbook
      : quickStartSurface.kind !== "none"
        ? quickStart
        : runbook;
  const executableCommands = executionSurface.kind === "executable";
  const referenceCommands = executionSurface.kind === "reference";

  if (commandSource) {
    if (typeof commandSource === "string") {
      commands = { default: commandSource };
    } else if (typeof commandSource === "object") {
      commands = commandSource;
    }
  }

  // 3. Compute action confidence
  // Factors: node confidence, readiness pass rate, heat (world relevance), resonance
  const readinessScore = liveChecksAllowed && checks.length > 0
    ? checks.filter(c => c.passed).length / checks.length
    : checks.length > 0 ? 0.35 : 0.5; // beta guidance without live verification should stay conservative

  const actionConfidence = parseFloat((
    (parseFloat(node.confidence) || 0.5) * 0.4 +
    readinessScore * 0.4 +
    Math.min(parseFloat(node.stimulus_heat) || 0, 0.1) * 1.0 +  // heat bonus (0-0.1)
    Math.min(parseFloat(node.resonance) || 0, 0.1) * 1.0          // resonance bonus (0-0.1)
  ).toFixed(3));

  // 4. Determine status
  const status = liveChecksAllowed
    ? blockers.length > 0 ? "blocked" :
      !allPassed ? "fixable" :
      executableCommands ? "ready" : "info-only"
    : checks.length > 0 ? "verification-required" :
      executableCommands ? "guided" : "info-only";

  // 5. Get related nodes (edges) for context
  let related = await sql`
    SELECT e.to_addr as addr, n.label, e.edge_type, e.label as edge_label,
      n.visibility, n.source_context, n.node_type, n.space_id, r.access_level,
      n.substance->>'description' as description,
      n.substance->'quick_start' as quick_start,
      n.substance->'runbook' as runbook,
      n.substance->'provides' as provides
    FROM edges e
    JOIN nodes n ON n.addr = e.to_addr
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE e.from_addr = ${addr}
      AND n.visibility <> 'deleted'
    ORDER BY e.weight DESC LIMIT 10` as any[];
  if (!liveChecksAllowed) {
    related = related
      .filter((row: any) => isNodeReadableForScope(access, row))
      .slice(0, 5);
  } else {
    related = related.slice(0, 5);
  }
  const bridgeContext = await selectOntologyBridgeContext([addr], access, {
    anchorLimit: 2,
    bridgeLimit: 4,
  });

  const relatedExecutable = related.filter((row: any) => {
    const hasCommands = classifyNodeExecution(row).kind === "executable";
    const actionableType = ["tool", "skill", "workflow", "procedure", "protocol"].includes(`${row.node_type || ""}`.toLowerCase());
    return hasCommands || actionableType;
  });

  const nextExecutable = relatedExecutable.slice(0, 3).map((row: any) => ({
    addr: row.addr,
    label: row.label,
    relationship: row.edge_type,
    run_url: `/run/${row.addr}`,
    reason: classifyNodeExecution(row).preview
      ? "Nearby node exposes an execution surface."
      : "Nearby node is more operational than the current information node.",
  }));

  // 6. Build response
  const response: any = {
    ok: true,
    status,
    verification_mode: liveChecksAllowed ? "live" : "declarative",
    addr,
    label: node.label,
    description: node.description || ontologyGuidanceSummary(addr)?.description || null,
    action_confidence: actionConfidence,
  };

  response.actionability = status === "ready"
    ? "executable"
    : status === "guided" || status === "verification-required" || status === "fixable"
      ? "drilldown"
      : status === "blocked"
        ? "dead-end"
        : referenceCommands || nextExecutable.length > 0
          ? "drilldown"
          : "info-only";

  if (status === "ready") {
    response.message = `Ready to use. All ${checks.length} prerequisites passed.`;
    response.commands = commands;
  } else if (status === "verification-required") {
    response.message = "Prerequisites are documented, but live host checks are restricted to operator mode.";
    response.commands = commands || undefined;
    response.blockers = blockers.length > 0 ? blockers : undefined;
    response.fixable = fixable.length > 0 ? fixable : undefined;
    // Resolution paths: tell agents HOW to unblock, not just WHAT is blocked
    const resolutionSteps: string[] = [];
    for (const b of blockers) {
      const bl = `${b}`.toLowerCase();
      if (bl.includes("token") || bl.includes("api_key") || bl.includes("secret"))
        resolutionSteps.push(`Set the missing credential: export ${b.toString().match(/[A-Z_]{3,}/)?.[0] || "MISSING_KEY"}=<value> or add to .env`);
      else if (bl.includes("install") || bl.includes("cli") || bl.includes("brew"))
        resolutionSteps.push(`Install missing tool: ${b}`);
      else if (bl.includes("operator") || bl.includes("access"))
        resolutionSteps.push(`Request operator access or run with elevated permissions`);
      else
        resolutionSteps.push(`Resolve: ${b}`);
    }
    for (const f of fixable) {
      resolutionSteps.push(`Fix: ${f}`);
    }
    if (resolutionSteps.length > 0) response.resolution_path = resolutionSteps;
  } else if (status === "guided") {
    response.message = "No live verification was run. Review the quick start and prerequisites before acting.";
    response.commands = commands;
  } else if (status === "fixable") {
    response.message = `${fixable.length} issue${fixable.length > 1 ? 's' : ''} to fix before use.`;
    response.fix_these_first = fixable;
    response.commands = commands; // still show commands so agent knows what it's working toward
  } else if (status === "blocked") {
    response.message = `Blocked by ${blockers.length} critical prerequisite${blockers.length > 1 ? 's' : ''}.`;
    response.blockers = blockers;
    response.fixable = fixable.length > 0 ? fixable : undefined;
  } else {
    response.message = referenceCommands
      ? "Reference node. The commands below help inspect or drill into more specific nodes, but this node is not directly executable."
      : nextExecutable.length > 0
        ? "Information node. No executable commands defined here, but nearby nodes provide actionable follow-through."
        : "Information node. No executable commands defined.";
    if (referenceCommands && commands) response.commands = commands;
    if (node.provides) response.provides = node.provides;
    if (nextExecutable.length > 0) response.next_executable = nextExecutable;
  }

  if (checks.length > 0) {
    response.prerequisites = {
      total: checks.length,
      passed: liveChecksAllowed ? checks.filter(c => c.passed).length : null,
      details: checks,
    };
  }

  if (related.length > 0) {
    response.related = related.map((r: any) => ({
      addr: r.addr,
      label: r.label,
      relationship: r.edge_type,
      role: classifyGraphEdgeRole(r.edge_type),
      run_url: `/run/${r.addr}`,
    }));
  }

  if (bridgeContext.bridges.length > 0) {
    response.ontology = formatOntologyBridgePayload(bridgeContext);
    response.ontology_bridges = bridgeContext.bridges.map((row) => ({
      via_addr: row.via_addr,
      via_label: row.via_label,
      addr: row.addr,
      label: row.label,
      pyramid_id: row.pyramid_id,
      relationship: row.edge_type,
      description: row.description,
    }));
  } else {
    response.ontology = formatOntologyBridgePayload(bridgeContext);
  }

  if (node.domains) response.domains = node.domains;
  if (runSourceRefs.length > 0) response.source_refs = runSourceRefs;

  // --- v3: Maturity stage awareness ---
  // F12: canonical-or-default coalescer.
  const maturityStage = coalesceMaturityStage(node.maturity_stage);
  response.maturity_stage = maturityStage;

  // Graduation progress: how close is this node to the next maturity stage?
  const queryHits = parseInt(node.query_hits) || 0;
  const hasQuickStart = !!node.quick_start;
  const graduationProgress: any = { current_stage: maturityStage };

  if (maturityStage === "encoded") {
    graduationProgress.next_stage = "enriched";
    graduationProgress.requirements = ["Add quick_start commands"];
    graduationProgress.progress = hasQuickStart ? 1.0 : 0.0;
  } else if (maturityStage === "enriched") {
    graduationProgress.next_stage = "proven";
    graduationProgress.requirements = ["Accumulate 20+ query hits", "Receive success signals"];
    graduationProgress.progress = Math.min(1.0, queryHits / 20);
  } else if (maturityStage === "proven") {
    graduationProgress.next_stage = "graduated";
    graduationProgress.requirements = ["Path is deterministic", "No LLM reasoning needed"];
    graduationProgress.progress = 0.5; // manual promotion for now
  } else if (maturityStage === "graduated") {
    graduationProgress.note = "Fully deterministic. Zero LLM cost.";
    graduationProgress.progress = 1.0;
  }
  response.graduation_progress = graduationProgress;

  // Maturity-aware response behavior adjustments
  if (maturityStage === "encoded" && !commands) {
    response.maturity_note = "This node is at discovery stage. Description only — explore further before acting.";
  } else if (maturityStage === "graduated" && commands) {
    response.maturity_note = "Graduated node. This path is deterministic and proven — execute with high confidence.";
  } else if (maturityStage === "repair") {
    response.maturity_note = "This node is in repair state — a recent failure signal was received. Verify before acting.";
  }

  // --- v3: Guards ---
  const guardWarnings = checkGuardsSync({
    nodes: [{ addr, similarity: 1.0, confidence: parseFloat(node.confidence) || 0.5 }],
    topSimilarity: 1.0,
    totalResults: 1,
  });
  if (guardWarnings.length > 0) {
    response.warnings = guardWarnings;
  }

  // Signal usage
  (async () => {
    try {
      await sql`SELECT increment_query_hits(${[addr]}::text[])`;
      if (agentId) {
        await sql`SELECT touch_agent(${resolveAgentTenant(c, agentId)}, ${agentId})`;
      }
      // Taste feedback: /run = intent to act
      await sql`UPDATE atom_feedback SET action_hits = action_hits + 1 WHERE node_addr = ${addr}`;
    } catch (_) {}
  })();

  response.ms = Date.now() - startMs;

  // Helpful next step
  if (status === "ready") {
    response.next = `Run the command above, then POST /signal/agent {"type":"success","context":"used ${node.label}","nodes":["${addr}"]${agentId ? `,"agent":"${agentId}"` : ''}} to let the graph know it worked.`;
  } else if (status === "verification-required") {
    response.next = `Use the documented prerequisites above and rerun this endpoint with operator access if you need live host verification.`;
  } else if (status === "fixable") {
    response.next = `Fix the issues above, then retry GET /run/${addr} to confirm readiness.`;
  } else if (referenceCommands && response.actionability === "drilldown") {
    response.next = `Use the reference commands above to inspect narrower nodes, then retry GET /run/<addr> on the chosen operational node.`;
  }

  if (agentId) logRunPathEvent(agentId, addr, status, response.actionability || "unknown", Date.now() - startMs);

  return c.json(response);
});

export default run;
