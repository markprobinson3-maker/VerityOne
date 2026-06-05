/**
 * Guards — Layer 1 of the Context Compiler
 *
 * Deterministic rules. Zero LLM cost. Pure functions.
 * Unified reflex + threat detection in a single module.
 *
 * Each guard: (signal) → Guard | null
 * Called once per endpoint, before returning response.
 */

import { sql } from "../db";

export interface Guard {
  id: string;
  severity: "info" | "warning" | "halt";
  message: string;
  recommendation?: string;
}

interface QueryContext {
  query?: string;
  agentId?: string | null;
  sessionId?: string | null;
  endpoint: string;
}

interface ResultContext {
  nodes: Array<{
    addr: string;
    similarity?: number;
    confidence?: number;
    outbound_edges?: number;
    requires?: Array<string | { name?: string; key?: string }>;
  }>;
  topSimilarity: number;
  totalResults: number;
}

// --- G-001: Low similarity across all nodes ---
function checkLowSimilarity(results: ResultContext): Guard | null {
  if (results.totalResults === 0 || results.topSimilarity < 0.65) {
    return {
      id: "G-001",
      severity: "warning",
      message: "Query has weak similarity to all graph nodes.",
      recommendation: "This may be outside Verity One's knowledge. Consider web_search or external sources.",
    };
  }
  return null;
}

// --- G-002: Repeated query/action (requires session tracking) ---
// Checked via agent_path_events — same query 3x in recent history
async function checkRepetition(ctx: QueryContext): Promise<Guard | null> {
  if (!ctx.agentId || !ctx.query) return null;
  try {
    const [row] = await sql`
      SELECT COUNT(*)::int AS n
      FROM agent_path_events
      WHERE agent_id = ${ctx.agentId}
        AND query = ${ctx.query}
        AND created_at > now() - interval '10 minutes'`;
    if (row.n >= 3) {
      return {
        id: "G-002",
        severity: "halt",
        message: "Same query repeated 3+ times in this session.",
        recommendation: "Try a different approach or rephrase the query.",
      };
    }
  } catch {
    // Non-fatal — skip guard if DB check fails
  }
  return null;
}

// --- G-003: Missing credentials or prerequisites ---
// Fires when returned nodes reference known-missing env vars or tools in substance.requires.
const KNOWN_MISSING_PREREQS = new Set([
  "APIFY_TOKEN", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_SHOP",
  "OPENCLAW_DISCORD_TOKEN", "ffmpeg", "ffprobe",
]);

function checkMissingPrerequisites(results: ResultContext): Guard | null {
  const missing: string[] = [];
  for (const node of results.nodes) {
    const requires = (node as any).requires;
    if (!Array.isArray(requires)) continue;
    for (const req of requires) {
      const key = typeof req === "string" ? req : req?.name || req?.key;
      if (key && KNOWN_MISSING_PREREQS.has(key) && !missing.includes(key)) {
        missing.push(key);
      }
    }
  }
  if (missing.length === 0) return null;
  return {
    id: "G-003",
    severity: "warning",
    message: `Missing prerequisites: ${missing.join(", ")}`,
    recommendation: "These credentials or tools are not configured. Node functionality may be limited.",
  };
}

// --- G-004: Low confidence across all results ---
function checkLowConfidence(results: ResultContext): Guard | null {
  if (results.totalResults === 0) return null;
  const allLow = results.nodes.every((n) => (n.confidence ?? 0) < 0.5);
  if (allLow && results.totalResults > 0) {
    return {
      id: "G-004",
      severity: "warning",
      message: "All returned nodes have confidence below 0.5.",
      recommendation: "State uncertainty explicitly. Verify before acting on these results.",
    };
  }
  return null;
}

// --- G-005: Dead-end node (no outbound edges) ---
function checkDeadEnd(results: ResultContext): Guard | null {
  const deadEnds = results.nodes.filter((n) => n.outbound_edges === 0);
  if (deadEnds.length > 0 && deadEnds.length === results.nodes.length) {
    return {
      id: "G-005",
      severity: "info",
      message: `${deadEnds.length} node${deadEnds.length > 1 ? "s" : ""} reached with no outbound edges.`,
      recommendation: "Consider related nodes via /context or /search to find connected paths.",
    };
  }
  return null;
}

// --- G-006: Hub node hit repeatedly in session ---
async function checkHubOveruse(ctx: QueryContext, results: ResultContext): Promise<Guard | null> {
  if (!ctx.agentId || results.nodes.length === 0) return null;
  try {
    const topAddr = results.nodes[0].addr;
    const [row] = await sql`
      SELECT COUNT(*)::int AS n
      FROM agent_path_events
      WHERE agent_id = ${ctx.agentId}
        AND (addr_selected = ${topAddr} OR ${topAddr} = ANY(returned_addrs))
        AND created_at > now() - interval '30 minutes'`;
    if (row.n >= 5) {
      return {
        id: "G-006",
        severity: "warning",
        message: `Node ${topAddr} has been hit 5+ times in this session.`,
        recommendation: "Diversify. Try adjacent nodes or a different query angle.",
      };
    }
  } catch {
    // Non-fatal
  }
  return null;
}

// --- G-007: Token/cost budget exceeded ---
// This guard is informational — agents track their own budgets.
// We surface it as a reminder when results are large.
function checkBudgetHint(results: ResultContext): Guard | null {
  if (results.totalResults > 10) {
    return {
      id: "G-007",
      severity: "info",
      message: `${results.totalResults} nodes returned — consider whether your context budget can absorb this.`,
      recommendation: "Use depth=shallow or reduce limit to stay within token budgets.",
    };
  }
  return null;
}

// --- G-008: Validate response shape ---
// This is an internal consistency check — ensures results have expected fields.
function checkResponseShape(results: ResultContext): Guard | null {
  if (results.totalResults > 0 && results.nodes.length === 0) {
    return {
      id: "G-008",
      severity: "warning",
      message: "Results were found but no nodes were returned — possible filtering issue.",
      recommendation: "Retry with broader filters or check access permissions.",
    };
  }
  return null;
}

/**
 * Run all guards against the current request context and results.
 * Returns array of triggered guards (warnings/halts for the response).
 */
export async function checkGuards(
  ctx: QueryContext,
  results: ResultContext,
): Promise<Guard[]> {
  const guards: Guard[] = [];

  // Synchronous guards
  const syncChecks = [
    checkLowSimilarity(results),
    checkMissingPrerequisites(results),
    checkLowConfidence(results),
    checkDeadEnd(results),
    checkBudgetHint(results),
    checkResponseShape(results),
  ];
  for (const g of syncChecks) {
    if (g) guards.push(g);
  }

  // Async guards (DB lookups)
  const asyncChecks = await Promise.all([
    checkRepetition(ctx),
    checkHubOveruse(ctx, results),
  ]);
  for (const g of asyncChecks) {
    if (g) guards.push(g);
  }

  return guards;
}

/**
 * Quick guard check for endpoints that only need similarity + confidence guards.
 * No DB lookups — pure synchronous.
 */
export function checkGuardsSync(results: ResultContext): Guard[] {
  const guards: Guard[] = [];
  const checks = [
    checkLowSimilarity(results),
    checkMissingPrerequisites(results),
    checkLowConfidence(results),
    checkDeadEnd(results),
    checkResponseShape(results),
  ];
  for (const g of checks) {
    if (g) guards.push(g);
  }
  return guards;
}
