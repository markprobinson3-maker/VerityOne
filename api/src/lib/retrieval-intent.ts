import type { KnownPyramidId } from "./graph-shape";
import { agenticRoutingAdjustment, isBroadControlNode, isSessionArtifactRow, queryHasGovernanceIntent } from "./agentic-routing";
import { distillAgentTaskPrompt } from "./agent-task-prompt";
import { suggestDurableOntologyTarget } from "./ontology";
import { summarizeSourceGrounding } from "./source-refs";
import { parseJsonField } from "./utils";

type RetrievalRow = {
  addr?: string | null;
  pyramid_id?: string | null;
  parent_addr?: string | null;
  label?: string | null;
  description?: string | null;
  node_type?: string | null;
  confidence?: number | string | null;
  similarity?: number | string | null;
  text_rank?: number | string | null;
  quick_start?: unknown;
  runbook?: unknown;
  source_context?: unknown;
  source_refs?: unknown;
};

export type RetrievalMode = "internal_system" | "operational_tooling" | "external_world" | "ontology_exploration";

export type RetrievalIntent = {
  query: string;
  mode: RetrievalMode;
  targetPyramidId: KnownPyramidId | null;
  targetParentAddr: string | null;
  actionBias: boolean;
  worldBias: boolean;
  explicitMeta: boolean;
  explicitLocal: boolean;
  governanceBias: boolean;
  philosophy: boolean;
  science: boolean;
  trending: boolean;
  externalReality: boolean;
  temporal: boolean;
  recall: boolean;
};

const ACTION_TERMS = [
  "build", "implement", "fix", "deploy", "write", "create", "run", "use", "design", "install",
  "send", "receive", "call", "connect", "setup", "set up", "start", "stop", "restart", "update",
  "workflow", "procedure", "steps", "how to", "configure", "operate",
  "diagnose", "debug", "troubleshoot", "resolve", "repair", "recover", "optimize",
  "evaluate", "assess", "audit", "verify", "validate", "test", "check",
  "aggregate", "parse", "fetch", "scrape", "collect", "ingest",
  "clarify", "discover", "elicit", "document", "handoff", "transfer",
  "execute", "trigger", "invoke", "process", "handle", "route", "forward",
];
const STRONG_OPERATIONAL_TERMS = [
  "deploy", "install", "configure", "run", "fix", "implement", "build", "restart", "provision", "migrate",
  "diagnose", "debug", "troubleshoot", "disk space", "postgresql", "database",
  "memory leak", "heap", "oom", "out of memory", "goroutine", "pprof",
  "crash", "crashloop", "crashloopbackoff", "segfault", "core dump",
  "hydration", "re-render", "useeffect", "react hook",
  "cold start", "bundle size", "payload too large",
  "hmac", "webhook signature", "idempotency",
  "replication lag", "wal", "autovacuum", "seq scan", "explain analyze",
  "deadlock", "upsert", "on conflict", "select for update", "skip locked", "advisory lock",
  "kubernetes", "k8s", "oomkilled", "memory limit", "container memory", "pod",
  "node.js", "event loop", "cpu spike", "heap profiling",
  "solana", "blockhash", "rent exempt", "insufficient funds for rent", "priority fee",
  "synology", "nas", "raid", "hot spare", "disk failure", "degraded storage pool",
  "dropbox", "upload session", "retry-after", "too_many_requests", "too_many_write_operations",
  "subagent", "stuck", "hanging", "timeout", "kill", "process kill",
  "lufs", "dbfs", "loudness", "mastering chain", "limiter", "clipping",
  "dns propagation", "ttl", "resolver",
  "encoding", "utf-8", "latin1", "bom", "chardet", "csv parsing",
  "aggregate", "rss", "feed", "scrape", "parse",
  "requirements", "handoff", "framework selection",
  "shutdown", "graceful", "server", "websocket", "connection pool", "query optimization",
  "convert", "file", "wav", "audio", "numpy", "stripe", "checkout", "webhook",
  "mastered", "mastering", "customer", "angry", "refund", "support",
  "chargeback", "dispute", "subscription", "billing", "invoice", "payment failed",
  "rate limit", "429", "retry-after", "telegram bot", "telegram webhook",
  "log scrub", "secret leak", "token leak", "credential leak", "jwt leak",
  "cron fail", "cron alert", "notification alert",
  "slow query", "taking", "seconds", "performance", "optimize",
];
const META_TERMS = [
  "verity", "runtime", "worker", "reactor", "qc sentinel", "scope", "ingestor", "staging", "heartbeat",
  "openclaw", "cron", "gateway", "agent", "session", "tool", "tools", "channel", "channels",
  "workspace", "workspace-main", "cost control", "model allocation", "automation", "hook", "heartbeat",
];
const LOCAL_TERMS = [
  "project", "workspace-main", "workspace", "repo", "repository",
];
const PHILOSOPHY_TERMS = [
  "philosophy", "epistemology", "ethics", "justice", "truth", "metaphysics", "dialectic", "republic",
  "virtue", "reason", "knowledge", "consciousness", "socratic", "platonic", "kant", "plato",
];
const SCIENCE_TERMS = [
  "science", "evidence", "experiment", "model", "theory", "biology", "physics", "chemistry", "mathematics",
  "mechanism", "empirical", "neural", "attention", "architecture", "statistical",
];
const TEMPORAL_TERMS = [
  "yesterday", "last week", "last session", "recent changes", "what happened", "history",
  "timeline", "recap", "summary of session", "what did we do", "what did i do", "when did we",
  "when did i", "last time", "previous session",
];
const RECALL_TERMS = [
  "remember", "recall", "my preference", "my decision", "did i decide", "our correction",
  "our decision", "what do you know about me", "my choices", "did we decide",
  // Operator preference/decision recall patterns (fuzz-miss 2026-03-27)
  "preferences", "operator preference", "model preference", "llm preference",
  "billing decision", "billing choice", "api key", "provider choice", "provider decision",
  // Recall through tracing/provenance — "trace a governance signal through RSS"
  "trace a", "trace the", "trace how", "provenance of", "history of", "lineage of",
  "did we settle", "settled on", "what did we decide", "what decisions", "what choices",
  "configured recently", "recently decided", "recently configured", "what do i have set",
  "model config", "spending limit", "spending limits",
];
const TREND_TERMS = ["trend", "news", "recent", "today", "latest", "current event", "breaking"];
const EXTERNAL_REALITY_TERMS = [
  // Finance / markets
  "fed", "federal reserve", "s&p", "nasdaq", "dow", "market", "stock", "price", "earnings", "macro",
  "bond", "yield", "dividend", "portfolio", "hedge", "etf", "mutual fund", "forex", "commodity",
  "corporate bond", "treasury", "credit spread", "options chain", "put", "call option",
  "ipo", "sec filing", "balance sheet", "revenue", "gdp", "cpi", "ppi",
  // Security advisories
  "apple", "cve", "advisory", "vulnerability", "tls", "security advisory",
  "zero-day", "exploit", "patch tuesday", "ransomware", "malware",
  // Infrastructure / location / physical (streaming and latency are operational, not external)
  "location", "data center", "pacific northwest", "san francisco",
  "weather", "disease", "policy", "economy", "interest rate", "inflation",
  "real estate", "shipping", "supply chain", "logistics",
  "unemployment", "employment", "labor", "jobs report", "wage", "salary",
  "census", "population", "demographic", "election", "vote", "poll",
  "geopolitics", "sanctions", "tariff", "trade war", "nato", "un",
  // Temporal reality markers (things that change in the real world)
  "q1 2026", "q2 2026", "q3 2026", "q4 2026", "this quarter", "last quarter",
  "this year", "last year", "next year", "2025", "2026", "2027",
];
const META_PYRAMID_PENALTY = new Set(["META"]);
const FUNCTIONAL_NODE_TYPES = new Set(["tool", "skill", "workflow", "procedure", "protocol"]);

/**
 * TRUTH PYRAMIDS: These nodes exist to narrow and ground functional answers
 * through heuristic injections (behavioral) and truth injections (ontological).
 * They never stand alone as results — they influence through derived injections
 * baked into functional nodes.
 *
 * WORLD = truth about reality (constraints, physics, causality, social dynamics)
 * HEURISTIC = truth about behavior (operational wisdom, philosophical principles)
 *
 * F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) moved the canonical
 * sets into @verity-one/graph-shape. The local re-exports are kept so
 * historical importers (`from "../lib/retrieval-intent"`) keep working.
 */
export {
  TRUTH_PYRAMIDS,
  ANSWER_CAPABLE_PYRAMIDS,
} from "@verity-one/graph-shape";
import {
  INTERNAL_SYSTEM_PYRAMIDS,
  TRUTH_PYRAMIDS as _TRUTH_PYRAMIDS,
} from "@verity-one/graph-shape";
/** @deprecated Use TRUTH_PYRAMIDS */
export const REINFORCEMENT_ONLY_PYRAMIDS = _TRUTH_PYRAMIDS;
const BROAD_WORLD_LABELS = [
  "governance & power",
  "policy, public systems & collective risk",
  "daos & collective coordination",
  "institutions & economy",
  "culture & history",
];

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function buildRetrievalPatterns(query: string): string[] {
  const distilled = distillAgentTaskPrompt(query).retrievalQuery;
  return Array.from(new Set(
    distilled
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3),
  ))
    .slice(0, 6)
    .map((term) => `%${term}%`);
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textScore(row: RetrievalRow): number {
  const similarity = numeric(row.similarity);
  if (similarity > 0) return similarity;
  const rank = numeric(row.text_rank);
  if (rank > 0) return rank;
  return numeric(row.confidence);
}

function actionabilityForQuery(query: string): number {
  return hasAny(query, ACTION_TERMS) ? 5 : 1;
}

function actionabilityForRow(row: RetrievalRow): number {
  const nodeType = `${row.node_type || ""}`.toLowerCase();
  if (FUNCTIONAL_NODE_TYPES.has(nodeType)) return 5;
  return 1;
}

export function detectRetrievalIntent(query: string): RetrievalIntent {
  const normalized = distillAgentTaskPrompt(query).retrievalQuery.trim().toLowerCase();
  const suggestion = normalized
    ? suggestDurableOntologyTarget({
        content: normalized,
        actionability: actionabilityForQuery(normalized),
        includeLocalPyramids: true,
      })
    : { pyramidId: null, parentAddr: null };

  const explicitMeta = suggestion.pyramidId === "META" || hasAny(normalized, META_TERMS);
  const explicitLocal = suggestion.pyramidId === "PROJECTS" || hasAny(normalized, LOCAL_TERMS);
  const philosophy = hasAny(normalized, PHILOSOPHY_TERMS);
  const science = hasAny(normalized, SCIENCE_TERMS);
  const trending = hasAny(normalized, TREND_TERMS);
  const governanceBias = queryHasGovernanceIntent(normalized);
  const externalReality = hasAny(normalized, EXTERNAL_REALITY_TERMS);
  const temporal = hasAny(normalized, TEMPORAL_TERMS);
  const recall = hasAny(normalized, RECALL_TERMS);
  const strongOperational = hasAny(normalized, STRONG_OPERATIONAL_TERMS);
  const suggestedFunction = suggestion.pyramidId === "FUNCTION";
  const internalSystem = explicitMeta || explicitLocal;
  const actionBias = internalSystem
    || hasAny(normalized, ACTION_TERMS)
    || (suggestedFunction && !externalReality)
    || strongOperational;
  const worldBias = !internalSystem && !strongOperational && (suggestion.pyramidId === "WORLD" || philosophy || science || externalReality);
  // If the query has both action terms AND philosophy/science terms,
  // it's an operational query with philosophical context (e.g., "evaluate ethics of a request")
  // Route to operational_tooling so FUNCTION nodes can surface alongside WORLD nodes
  const hasActionIntent = hasAny(normalized, ACTION_TERMS) || strongOperational;
  // strongOperational always wins — even if the query contains external-reality words (e.g. "subscription",
  // "streaming", "billing"), a strong operational signal means the agent wants tooling, not web_search.
  const mode: RetrievalMode = internalSystem
    ? "internal_system"
    : strongOperational
      ? "operational_tooling"
      : externalReality
        ? "external_world"
        : (philosophy || science || suggestion.pyramidId === "WORLD") && !hasActionIntent
          ? "ontology_exploration"
          : actionBias
            ? "operational_tooling"
            : "operational_tooling";

  const suppressWorldTarget = strongOperational && suggestion.pyramidId === "WORLD";
  const targetPyramidId = internalSystem
    ? null
    : suppressWorldTarget
      ? null
      : externalReality && !strongOperational && suggestion.pyramidId === "FUNCTION"
        ? null
        : suggestion.pyramidId || null;
  const targetParentAddr = internalSystem
    ? null
    : suppressWorldTarget
      ? null
      : externalReality && !strongOperational && suggestion.pyramidId === "FUNCTION"
        ? null
        : suggestion.parentAddr || null;

  return {
    query: normalized,
    mode,
    targetPyramidId,
    targetParentAddr,
    actionBias,
    worldBias,
    explicitMeta,
    explicitLocal,
    governanceBias,
    philosophy,
    science,
    trending,
    externalReality,
    temporal,
    recall,
  };
}

function rowOntology(row: RetrievalRow) {
  return suggestDurableOntologyTarget({
    content: `${row.label || ""}\n${row.description || ""}`,
    nodeType: row.node_type || "concept",
    actionability: actionabilityForRow(row),
    includeLocalPyramids: false,
  });
}

function exactQueryHit(query: string, row: RetrievalRow): boolean {
  const label = `${row.label || ""}`.toLowerCase();
  const description = `${row.description || ""}`.toLowerCase();
  return !!query && (label.includes(query) || description.includes(query));
}

const CRITICAL_SHORT_TERMS_RI = new Set([
  "xai", "ast", "cad", "api", "ddos", "ml", "cql", "cdn", "dns", "ssl", "tls",
  "ssh", "tcp", "udp", "gpu", "cpu", "jwt", "mfa", "waf", "rbac", "sso", "iam",
]);

function lexicalOverlap(query: string, row: RetrievalRow): number {
  const allTokens = query.toLowerCase().split(/[^a-z0-9]+/i).map((t) => t.trim()).filter(Boolean);
  const terms = allTokens.filter((t) => t.length >= 4 || CRITICAL_SHORT_TERMS_RI.has(t));
  if (terms.length === 0) return 0;
  const haystack = `${row.label || ""} ${row.description || ""}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

function isBroadWorldAnchor(row: RetrievalRow): boolean {
  if (`${row.pyramid_id || ""}` !== "WORLD") return false;
  const label = `${row.label || ""}`.toLowerCase();
  return BROAD_WORLD_LABELS.some((term) => label.includes(term));
}

export function rerankRetrievalRows<T extends RetrievalRow>(query: string, rows: T[]): T[] {
  const retrievalQuery = distillAgentTaskPrompt(query).retrievalQuery;
  const intent = detectRetrievalIntent(retrievalQuery);
  return [...rows]
    .map((row) => {
      let score = textScore(row);
      const rowIntent = rowOntology(row);
      const sourceContext = parseJsonField<Record<string, any>>(row.source_context) ?? {};
      const grounding = summarizeSourceGrounding(row.source_refs);
      const overlap = lexicalOverlap(intent.query, row);
      const broadWorldAnchor = isBroadWorldAnchor(row);
      const domainSpecificQuery = !intent.philosophy && !intent.science && !intent.explicitMeta && !intent.trending;
      const internalSystemRow = INTERNAL_SYSTEM_PYRAMIDS.has(
        `${row.pyramid_id || ""}`.toUpperCase() as KnownPyramidId,
      );

      if (intent.targetPyramidId && rowIntent.pyramidId === intent.targetPyramidId) score += overlap > 0 ? 0.8 : 0.2;
      // Parent address match bonus conditioned on lexical overlap:
      // Right branch + wrong child (zero overlap) gets minimal boost, not +1.4.
      // Prevents "ops parent" → "Cost Governance" for a "Kubernetes v1.36" query.
      if (intent.targetParentAddr && rowIntent.parentAddr === intent.targetParentAddr) score += overlap > 0 ? 1.4 : 0.3;
      if (intent.targetParentAddr && row.parent_addr === intent.targetParentAddr) score += overlap > 0 ? 1.1 : 0.2;
      if (intent.actionBias && rowIntent.pyramidId === "FUNCTION") score += 0.3;
      if (intent.worldBias && rowIntent.pyramidId === "WORLD") score += 0.35;
      if (overlap > 0) score += overlap * 0.9;
      if (intent.philosophy && rowIntent.parentAddr === "WD.0.2.37") score += 0.65;
      if (intent.philosophy && rowIntent.parentAddr === "WD.0.2.68") score += 0.65;
      if (intent.science && rowIntent.pyramidId === "WORLD") score += 0.45;
      if (intent.trending && `${row.node_type || ""}`.toLowerCase() === "trend") score += 0.4;
      // Trend tooling boost: FUNCTION nodes with "trend" in the label are the diagnostic
      // tools for the trend system — surface them alongside trend results so agents can
      // both see trends AND investigate trend behavior (e.g., "why did a trend not recur").
      if (intent.trending && rowIntent.pyramidId === "FUNCTION" && `${row.label || ""}`.toLowerCase().includes("trend")) {
        score += 0.55;
      }

      // Temporal/recall boost: strongly prefer memory nodes when the query is about history/recall
      if ((intent.temporal || intent.recall) && `${row.node_type || ""}`.toLowerCase() === "memory") {
        score += 1.5;
      }
      // Temporal/recall penalty: demote non-memory nodes for temporal/recall queries
      if ((intent.temporal || intent.recall) && `${row.node_type || ""}`.toLowerCase() !== "memory") {
        score -= 0.8;
      }

      if (isSessionArtifactRow(row) && !(intent.temporal || intent.recall || intent.explicitLocal)) {
        score -= 2.6;
      }

      // Temporal day nodes should only surface for explicit temporal/recall queries.
      // Without that intent, they are noise — never a valid action target.
      if (`${row.pyramid_id || ""}` === "TEMPORAL" && !(intent.temporal || intent.recall)) {
        score -= 3.0;
      }

      if (!intent.explicitMeta && !intent.explicitLocal && META_PYRAMID_PENALTY.has(`${row.pyramid_id || ""}`)) {
        // Recall queries get stronger META suppression — tenant memories should win over broad META nodes.
        const metaPenalty = (intent.recall || intent.temporal) ? 2.0 : 1.65;
        score -= exactQueryHit(intent.query, row) ? 0.35 : metaPenalty;
      }
      if (intent.worldBias && META_PYRAMID_PENALTY.has(`${row.pyramid_id || ""}`) && rowIntent.pyramidId !== "WORLD") {
        score -= 0.9;
      }
      if (intent.actionBias && `${row.pyramid_id || ""}` === "WORLD" && !exactQueryHit(intent.query, row)) {
        score -= 0.65;
      }
      if (domainSpecificQuery && broadWorldAnchor && overlap < 0.35 && !exactQueryHit(intent.query, row)) {
        score -= 1.15;
      }
      if (domainSpecificQuery && `${row.pyramid_id || ""}` === "WORLD" && overlap === 0 && !exactQueryHit(intent.query, row)) {
        score -= 1.2; // was 0.25 — much stronger: zero-overlap WORLD nodes should never win for domain queries
      }
      if (intent.externalReality && internalSystemRow && overlap < 0.35 && !exactQueryHit(intent.query, row)) {
        score -= 1.35;
      }
      if (!intent.trending && `${row.node_type || ""}`.toLowerCase() === "trend") {
        // Strong demotion: TN/trend nodes are informational summaries, not operational nodes.
        // They should only surface for explicit trend queries. Without trending intent, treat
        // them like META pyramid nodes (dead-end for action selection).
        score -= exactQueryHit(intent.query, row) ? 0.5 : 1.5;
      }

      // Anti-narcissism: when query is NOT about VO/OpenClaw internals,
      // penalize VO-specific internal architecture nodes that share vocabulary
      // with general topics (e.g., "Hybrid Search" for a general postgres question)
      const voInternalLabels = ["hybrid search", "live resonance", "agent profile", "stimulus", "graph mutation", "adaptive heat", "durable alignment", "source quality tracker"];
      const isVoInternalNode = voInternalLabels.some(l => `${row.label || ""}`.toLowerCase().includes(l));
      if (isVoInternalNode && !intent.explicitMeta && !intent.explicitLocal && overlap < 0.3) {
        score -= 1.5;
      }
      // Universal zero-overlap penalty: if query shares NO 4+ letter terms with the node,
      // the semantic embedding match is likely a false positive (vector space neighbor but wrong topic).
      // This is the primary defense against "Solvespace CAD" → "Base and Superstructure" routing.
      if (overlap === 0 && !exactQueryHit(intent.query, row) && !intent.philosophy && !intent.science) {
        score -= 0.8;
      }

      score += agenticRoutingAdjustment(intent.query, row, intent);

      const alignmentRole = sourceContext?.alignment_role || sourceContext?.grounding?.status || null;
      if (alignmentRole === "grounded" || grounding.corroborated) score += 0.12;
      if (alignmentRole === "provisional") score -= 0.1;

      return { row, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row);
}

export function shouldSurfaceReviewedSkills(query: string): boolean {
  const intent = detectRetrievalIntent(query);
  return intent.actionBias || intent.targetPyramidId === "FUNCTION" || intent.philosophy || intent.science;
}

export function summarizeRetrievalIntent(intent: RetrievalIntent) {
  return {
    mode: intent.mode,
    target_pyramid: intent.targetPyramidId,
    target_branch: intent.targetParentAddr,
    action_bias: intent.actionBias,
    world_bias: intent.worldBias,
    governance_bias: intent.governanceBias,
    external_reality: intent.externalReality,
    temporal: intent.temporal,
    recall: intent.recall,
  };
}
