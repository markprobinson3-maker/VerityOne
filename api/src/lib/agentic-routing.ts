import { parseJsonField } from "./utils";

export type AgenticRoutingRow = {
  addr?: string | null;
  pyramid_id?: string | null;
  parent_addr?: string | null;
  label?: string | null;
  description?: string | null;
  node_type?: string | null;
  quick_start?: unknown;
  runbook?: unknown;
  similarity?: number | string | null;
  confidence?: number | string | null;
};

export type AgenticRoutingIntent = {
  actionBias?: boolean;
  explicitMeta?: boolean;
  explicitLocal?: boolean;
  temporal?: boolean;
  recall?: boolean;
  governanceBias?: boolean;
  worldBias?: boolean;
};

export type ExecutionSurfaceKind = "none" | "reference" | "executable";

const SESSION_LABEL_PATTERN = /\b(session|fuzz(?:\s+team|\s+run)?|audit)\b/i;
const CONTROL_LABEL_PATTERNS = [
  /^QC Sentinel$/i,
  /^Verity Pyramid Query$/i,
  /^Verity Pyramid Operations$/i,
  /^Verity One API Routes$/i,
];
const GOVERNANCE_TERMS = [
  "governance", "policy", "provenance", "review", "risk", "compliance", "publish", "publication",
  "staging", "validation", "approve", "approval", "guardrail", "attest", "qc", "sentinel",
];
const GRAPH_INSPECTION_TERMS = [
  "context", "query", "search", "graph", "node", "nodes", "traverse", "inspect", "browse", "what exists",
  "discover", "enumerate", "lookup", "find in verity",
];
const API_ROUTE_TERMS = [
  "api", "route", "routes", "endpoint", "endpoints", "hono", "http", "websocket", "server", "3100",
  "regrounding", "signal", "beta token",
];
const PYRAMID_OPERATION_TERMS = [
  "pyramid", "ontology", "branch", "publish", "publication", "overlay", "provenance", "staging",
];
const REFERENCE_PATTERNS = [
  /\breference node\b/i,
  /\/context\?/i,
  /\/nodes\//i,
  /\/traverse\?/i,
  /\/search\?/i,
  /\bdiscover what exists\b/i,
  /\bquery\b.+\bgraph\b/i,
  /\binspect\b.+\bnode\b/i,
];
const EXECUTABLE_COMMAND_PATTERN = /(^|\n|\s)(bun|npm|npx|pnpm|yarn|openclaw|docker|kubectl|ssh|kill|git|psql|curl|export|cd|systemctl|brew)\b/i;

function normalize(text: string | null | undefined): string {
  return `${text || ""}`.trim().toLowerCase();
}

function exactTextHit(query: string, row: AgenticRoutingRow): boolean {
  const normalized = normalize(query);
  const label = normalize(row.label);
  const description = normalize(row.description);
  return !!normalized && (label.includes(normalized) || description.includes(normalized));
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function collectCommandStrings(raw: unknown, out: string[]): void {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value) out.push(value);
    return;
  }
  const parsed = parseJsonField<any>(raw);
  if (parsed == null) return;
  if (typeof parsed === "string") {
    const value = parsed.trim();
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const value of parsed) collectCommandStrings(value, out);
    return;
  }
  if (typeof parsed === "object") {
    for (const value of Object.values(parsed)) collectCommandStrings(value, out);
  }
}

function referenceCommand(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function actionableNodeType(row: AgenticRoutingRow): boolean {
  const nodeType = normalize(row.node_type);
  return ["tool", "skill", "workflow", "procedure", "protocol"].includes(nodeType);
}

// Domain-critical short terms that must count for overlap despite being < 4 chars.
// Without this, "XAI", "CAD", "AST", "DDoS" queries always get overlap=0.
const CRITICAL_SHORT_TERMS = new Set([
  "xai", "ast", "cad", "api", "ddos", "ml", "cql", "cdn", "dns", "ssl", "tls",
  "ssh", "tcp", "udp", "gpu", "cpu", "ram", "nas", "ssd", "iot", "rpc", "grpc",
  "waf", "jwt", "mfa", "rbac", "saml", "idp", "sso", "iam", "vpc", "ecs", "eks",
  "gke", "aks", "acm", "kms", "sns", "sqs", "rds", "s3",
]);

export function lexicalOverlapRatio(query: string, row: AgenticRoutingRow): number {
  const normalizedQuery = normalize(query);
  const allTokens = normalizedQuery.split(/[^a-z0-9]+/i).map((t) => t.trim()).filter(Boolean);
  // Include 4+ char terms AND any critical short terms
  const terms = allTokens.filter((t) => t.length >= 4 || CRITICAL_SHORT_TERMS.has(t.toLowerCase()));
  if (terms.length === 0) return 0;
  const haystack = `${normalize(row.label)} ${normalize(row.description)}`;
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

export function queryHasGovernanceIntent(query: string): boolean {
  return hasAny(normalize(query), GOVERNANCE_TERMS);
}

export function queryHasGraphInspectionIntent(query: string): boolean {
  return hasAny(normalize(query), GRAPH_INSPECTION_TERMS);
}

export function isSessionArtifactRow(row: AgenticRoutingRow): boolean {
  const nodeType = normalize(row.node_type);
  if (nodeType === "memory" || nodeType === "changelog") return true;
  if (`${row.addr || ""}`.startsWith("PJ.")) return true;
  return SESSION_LABEL_PATTERN.test(`${row.label || ""}`);
}

export function isBroadControlNode(row: AgenticRoutingRow): boolean {
  const label = `${row.label || ""}`;
  if (CONTROL_LABEL_PATTERNS.some((pattern) => pattern.test(label))) return true;
  if (normalize(row.pyramid_id) === "world" && referenceCommand(`${row.quick_start || ""}`)) return true;
  return false;
}

// Generic meta/infrastructure nodes that shouldn't win for domain-specific queries
const GENERIC_META_PATTERNS = [
  /^Connect Endpoint$/i,
  /^github$/i,
  /^CLAUDE\.md/i,
  /hooks migration pattern/i,
  /^Team AI Adoption/i,
  /^Incremental Sub-Agent Architecture$/i,
  /^CRM Follow-Up Nurture Skill$/i,
  /^Agent Identity System$/i,
  /^Program\.md as Organizational Description$/i,
  // VO-internal reactive system nodes — only relevant for queries about the VO reactor itself
  /^Resonance Reactor$/i,
  /^Reactor Engine$/i,
  // Personal/local tool nodes — should only win for explicit personal-use requests
  /^WhatsApp CLI/i,
  /^Ted Code Review$/i,
  // Harvest/pipeline nodes that win on executable surface but have no topic relevance
  /^YouTube Channel Harvest Pipeline$/i,
  // VO Publication Workflow — valid for publication queries, but over-selected for everything else
  /^VO Node Publication Workflow$/i,
];

export function isGenericMetaNode(row: AgenticRoutingRow): boolean {
  const label = `${row.label || ""}`;
  return GENERIC_META_PATTERNS.some((pattern) => pattern.test(label));
}

export function queryHasMetaIntent(query: string): boolean {
  return hasAny(normalize(query), [
    "connect", "onboard", "register", "bootstrap", "github", "claude.md",
    "hooks", "migration pattern", "team adoption", "ai adoption",
    "agent identity", "agent profile", "agent registration",
    "crm", "nurture", "follow-up",
    // VO reactor internals — only allow Resonance Reactor for queries about these
    "resonance reactor", "reactor engine", "reactor tick", "reactor stimulus",
    // Personal tools — only allow for explicit personal-use requests
    "whatsapp", "wacli", "ted code review", "deepseek",
    // Harvest and publication — allow only for direct mentions
    "youtube", "harvest", "channel harvest",
    "publish", "publication", "overlay node",
  ]);
}

// Governance nodes that should only win for governance queries
const GOVERNANCE_NODE_PATTERNS = [
  /^Provenance Type Distinction$/i,
  /^Data Governance$/i,
  /^Cost Governance$/i,
];

// Security-incident nodes that should only win for actual security queries
const SECURITY_INCIDENT_PATTERNS = [
  /^Credential Leak Response$/i,
];
const SECURITY_TERMS = [
  "credential", "leak", "breach", "exposed", "secret", "compromise",
  "vulnerability", "incident", "attack", "exploit", "unauthorized",
];

export function isSecurityIncidentNode(row: AgenticRoutingRow): boolean {
  const label = `${row.label || ""}`;
  return SECURITY_INCIDENT_PATTERNS.some((pattern) => pattern.test(label));
}

export function queryHasSecurityIntent(query: string): boolean {
  return hasAny(normalize(query), SECURITY_TERMS);
}

export function isGovernanceNode(row: AgenticRoutingRow): boolean {
  const label = `${row.label || ""}`;
  return GOVERNANCE_NODE_PATTERNS.some((pattern) => pattern.test(label));
}

export function classifyExecutionSurface(raw: unknown): { kind: ExecutionSurfaceKind; preview: string | null; commands: string[] } {
  const commands: string[] = [];
  collectCommandStrings(raw, commands);
  if (commands.length === 0) return { kind: "none", preview: null, commands: [] };

  const referenceOnly = commands.every((command) => referenceCommand(command));
  if (referenceOnly) {
    return { kind: "reference", preview: commands[0] || null, commands };
  }

  const executable = commands.some((command) => EXECUTABLE_COMMAND_PATTERN.test(command));
  if (executable) {
    return { kind: "executable", preview: commands[0] || null, commands };
  }

  return { kind: "reference", preview: commands[0] || null, commands };
}

export function classifyNodeExecution(row: AgenticRoutingRow): { kind: ExecutionSurfaceKind; preview: string | null; commands: string[] } {
  const quickStart = classifyExecutionSurface(row.quick_start);
  if (quickStart.kind === "executable") return quickStart;
  const runbook = classifyExecutionSurface(row.runbook);
  if (runbook.kind === "executable") return runbook;
  if (quickStart.kind === "reference") return quickStart;
  return runbook.kind === "reference" ? runbook : quickStart;
}

export function shouldAllowBroadControlNode(query: string, row: AgenticRoutingRow, intent: AgenticRoutingIntent = {}): boolean {
  if (intent.explicitLocal) return true;
  const label = normalize(row.label);
  const normalizedQuery = normalize(query);
  const overlap = lexicalOverlapRatio(query, row);

  if (label === "qc sentinel") {
    return hasAny(normalizedQuery, ["publish", "publication", "staging", "validation", "approve", "revision", "qc", "sentinel"]);
  }
  if (label === "verity pyramid query") {
    return queryHasGraphInspectionIntent(query);
  }
  if (label === "verity one api routes") {
    return hasAny(normalizedQuery, API_ROUTE_TERMS);
  }
  if (label === "verity pyramid operations") {
    return hasAny(normalizedQuery, PYRAMID_OPERATION_TERMS);
  }
  return false;
}

export function agenticRoutingAdjustment(query: string, row: AgenticRoutingRow, intent: AgenticRoutingIntent = {}): number {
  const overlap = lexicalOverlapRatio(query, row);
  const exact = exactTextHit(query, row);
  const execution = classifyNodeExecution(row);
  let delta = 0;

  if (isSessionArtifactRow(row) && !(intent.temporal || intent.recall || intent.explicitLocal)) {
    delta -= 2.6;
  }

  if (isBroadControlNode(row) && !shouldAllowBroadControlNode(query, row, intent) && overlap < 0.55 && !exact) {
    delta -= 1.4;
  }

  // Demote generic meta/infra nodes (Connect Endpoint, GitHub, Team AI Adoption)
  // when the query isn't specifically about those topics
  if (isGenericMetaNode(row) && !queryHasMetaIntent(query) && overlap < 0.35 && !exact) {
    delta -= 1.2;
  }

  // Demote governance nodes for non-governance queries
  if (isGovernanceNode(row) && !queryHasGovernanceIntent(query) && overlap < 0.35 && !exact) {
    delta -= 1.0;
  }

  // Demote security-incident nodes for non-security queries
  // "auth mismatch" is a debugging problem, not a security incident
  if (isSecurityIncidentNode(row) && !queryHasSecurityIntent(query) && overlap < 0.35 && !exact) {
    delta -= 1.1;
  }

  if (execution.kind === "reference" && intent.actionBias && overlap < 0.45 && !exact) {
    delta -= 0.9;
  }

  if (normalize(row.pyramid_id) === "world" && execution.kind === "reference" && intent.actionBias && overlap < 0.4) {
    delta -= 0.8;
  }

  if (execution.kind === "executable" && overlap >= 0.18 && !isSessionArtifactRow(row)) {
    delta += 0.35;
  }

  // Universal zero-overlap penalty: false-positive embedding match.
  if (overlap === 0 && !exact && !(intent.explicitMeta || intent.explicitLocal)) {
    delta -= 1.2;
  }

  // Abstract/philosophy node penalty for non-philosophy queries.
  const abstractLabels = ["unmoved mover", "diffusion model", "categorical imperative",
    "easy problems", "hard problems", "consciousness", "base and superstructure",
    "provenance type distinction", "constitutional classif"];
  const labelLower = normalize(row.label);
  if (abstractLabels.some(a => labelLower.includes(a)) && overlap === 0 && !exact) {
    delta -= 1.5;
  }

  // Hard actionability gate: for action-biased queries, non-executable non-reference nodes
  // with low overlap should not compete. A node about "Ralph Loop: AFK Agent Execution"
  // with 0 overlap to "Create issues from Slack with Copilot" is not a valid action candidate.
  if (intent.actionBias && execution.kind === "none" && overlap < 0.2 && !exact) {
    delta -= 0.8;
  }

  // In-cluster boost: if a node has HIGH overlap (>= 0.4), it's in the right cluster.
  // Boost it to outcompete distant embedding-similar nodes.
  if (overlap >= 0.4 && !isSessionArtifactRow(row)) {
    delta += 0.6;
  }

  return delta;
}

export function scoreGroundActionCandidate(query: string, row: AgenticRoutingRow, intent: AgenticRoutingIntent = {}): number {
  const overlap = lexicalOverlapRatio(query, row);
  const similarity = Number(row.similarity || 0) || 0;
  const confidence = Number(row.confidence || 0) || 0;
  const execution = classifyNodeExecution(row);
  // Overlap is the primary signal for cluster landing. Weight it heavily.
  // High overlap (>= 0.3) gets quadratic boost to dominate distant embedding matches.
  const overlapScore = overlap >= 0.3 ? overlap * 2.2 : overlap * 1.4;
  let score = (similarity * 0.9) + (confidence * 0.35) + overlapScore;

  if (actionableNodeType(row)) score += 0.35;
  if (normalize(row.pyramid_id) === "function") score += 0.1;
  // Executable bonus is reduced for zero-overlap nodes to prevent arbitrary executable nodes
  // from dominating out-of-coverage queries purely on execution surface.
  if (execution.kind === "executable") score += (overlap >= 0.05 || exactTextHit(query, row)) ? 0.9 : 0.4;
  if (execution.kind === "reference") score -= 0.65;
  if (exactTextHit(query, row)) score += 0.4;
  if (isBroadControlNode(row) && shouldAllowBroadControlNode(query, row, intent) && overlap >= 0.18) score += 0.2;
  // Zero-overlap penalty: stronger for non-executable nodes, still applied to executable
  // because even an executable node is wrong if it shares no terms with the query.
  if (overlap === 0 && !exactTextHit(query, row)) {
    score -= execution.kind === "executable" ? 0.6 : 1.0;
  }

  score += agenticRoutingAdjustment(query, row, intent);
  return Number(score.toFixed(4));
}
