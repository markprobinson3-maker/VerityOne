import {
  ONTOLOGY_CHILD_BRANCHES,
  suggestDurableOntologyTarget,
  type DurableOntologyInput,
} from "./ontology";

export interface FunctionalAlignmentCandidate {
  addr: string;
  pyramid_id: string;
  label: string;
  node_type?: string | null;
  description?: string | null;
  parent_addr?: string | null;
}

export interface FunctionalAlignmentPlan {
  targetAddr: string;
  edgeType: "operationalizes" | "specializes" | "informs";
  label: string;
  reason: string;
}

const ACTIONABLE_NODE_TYPES = new Set([
  "tool",
  "skill",
  "workflow",
  "procedure",
  "protocol",
]);

const OVERRIDES: Record<string, { targetAddr: string; reason: string }> = {
  "OC.0.1.1": { targetAddr: "FN.0.2.26", reason: "OpenClaw gateway is primarily a service/API surface." },
  "OC.0.1.2": { targetAddr: "FN.0.2.23", reason: "Channel systems are primarily messaging and collaboration surfaces." },
  "OC.0.1.3": { targetAddr: "FN.0.2.24", reason: "Agent systems are primarily agent-interface and prompt-control surfaces." },
  "OC.0.1.4": { targetAddr: "FN.0.1.7", reason: "Skills & tools is the local specialization of tools and integrations." },
  "OC.0.1.5": { targetAddr: "FN.0.2.18", reason: "Models & auth are anchored by identity, access, and trust boundaries." },
  "OC.0.1.6": { targetAddr: "FN.0.2.13", reason: "Workspace concerns are environment and provisioning concerns." },
  "OC.0.1.7": { targetAddr: "FN.0.1.7", reason: "Tool surfaces map directly to the tools and integrations function." },
  "CC.0.1.1": { targetAddr: "FN.0.2.7", reason: "Agent loops are best treated as workflow coordination primitives." },
  "CC.0.1.2": { targetAddr: "FN.0.1.7", reason: "Claude Code tools are a specialization of tools and integrations." },
  "CC.0.1.3": { targetAddr: "FN.0.2.26", reason: "Surfaces are the service and interface boundary for Claude Code." },
  "CC.0.1.4": { targetAddr: "FN.0.2.28", reason: "Extensibility maps to connectors, plugins, and automation." },
  "CC.0.1.5": { targetAddr: "FN.0.1.5", reason: "Permissions & safety are verification and security concerns." },
  "CC.0.1.6": { targetAddr: "FN.0.2.13", reason: "Model and config control is environment and provisioning work." },
  "CX.0.1.1": { targetAddr: "FN.0.1.3", reason: "Task execution is a direct build/change execution pathway." },
  "CX.0.1.3": { targetAddr: "FN.0.2.28", reason: "Integration concerns belong to connectors and automation." },
  "CX.0.1.4": { targetAddr: "FN.0.1.5", reason: "Safety and verification map to trust and correctness enforcement." },
};

const LABEL_RULES: Array<{
  pattern: RegExp;
  targetAddr: string;
  reason: string;
}> = [
  { pattern: /^CLAUDE\.md Memory$/i, targetAddr: "FN.0.2.24", reason: "Instruction memory is part of prompt and agent interface design." },
  { pattern: /^Skills System$/i, targetAddr: "FN.0.2.28", reason: "A skills system is an extension and automation surface." },
  { pattern: /^Bundled Skills$/i, targetAddr: "FN.0.2.28", reason: "Bundled skills are packaged extension capabilities." },
  { pattern: /^Memory Management$/i, targetAddr: "FN.0.2.24", reason: "Agent memory systems shape prompt and agent interfaces over time." },
  { pattern: /^ClawHub Skill Registry$/i, targetAddr: "FN.0.2.28", reason: "A skill registry is an extension and automation ecosystem surface." },
  { pattern: /^GitHub Actions$/i, targetAddr: "FN.0.2.14", reason: "GitHub Actions is a deployment and orchestration surface." },
  { pattern: /^Cloud Sessions$/i, targetAddr: "FN.0.2.13", reason: "Cloud sessions are environment and provisioning concerns." },
  { pattern: /^Checkpointing$/i, targetAddr: "FN.0.2.32", reason: "Checkpointing primarily improves resilience and hardening." },
  { pattern: /^Parallel Execution$/i, targetAddr: "FN.0.2.7", reason: "Parallel execution is a workflow coordination concern." },
  { pattern: /^Strict Config Validation(?: Spec)?$/i, targetAddr: "FN.0.2.17", reason: "Validation specs belong to testing and validation." },
  { pattern: /^Communication Skills$/i, targetAddr: "FN.0.2.23", reason: "Communication skills map to messaging and collaboration." },
  { pattern: /^Development Skills$/i, targetAddr: "FN.0.2.9", reason: "Development skills map to implementation and authoring." },
  { pattern: /^Knowledge Skills$/i, targetAddr: "FN.0.2.4", reason: "Knowledge skills map to research and evaluation work." },
  { pattern: /^Infrastructure Skills$/i, targetAddr: "FN.0.2.14", reason: "Infrastructure skills map to deployment and orchestration." },
  { pattern: /^Smart Home & IoT Skills$/i, targetAddr: "FN.0.2.28", reason: "IoT skills are connector and automation capabilities." },
  { pattern: /^Remote Access$/i, targetAddr: "FN.0.2.18", reason: "Remote access is governed by authentication and access control." },
  { pattern: /^Session Management & Scoping$/i, targetAddr: "FN.0.2.18", reason: "Session boundaries are an access-control concern." },
  { pattern: /^Operational Gotchas$/i, targetAddr: "FN.0.2.32", reason: "Operational gotchas belong to reliability and hardening knowledge." },
  { pattern: /^Graph Mutation Tracking$/i, targetAddr: "FN.0.2.19", reason: "Tracking graph mutations is an audit and governance concern." },
  { pattern: /^Model Usage Tracker$/i, targetAddr: "FN.0.2.3", reason: "Usage tracking is observability and telemetry." },
  { pattern: /^Verity Pyramid Query$/i, targetAddr: "FN.0.2.1", reason: "Query surfaces map to inspection and enumeration." },
  { pattern: /^Canvas Display$/i, targetAddr: "FN.0.2.22", reason: "Display surfaces map to user interaction and experience." },
  { pattern: /^Blogwatcher$/i, targetAddr: "FN.0.2.1", reason: "Watchers primarily inspect and enumerate changing sources." },
  { pattern: /^notion$/i, targetAddr: "FN.0.2.28", reason: "Notion is most useful to agents as a connector and automation surface." },
  { pattern: /^Canvas System$/i, targetAddr: "FN.0.2.22", reason: "A canvas system is a user interaction surface for rendering and control." },
  { pattern: /^9 Typed Fact Extraction$/i, targetAddr: "FN.0.2.1", reason: "Typed fact extraction is an inspection and enumeration surface over code and data." },
  { pattern: /^Priority Lens$/i, targetAddr: "FN.0.2.6", reason: "Priority lenses are scheduling and prioritization structures for agents." },
  { pattern: /^Reconstruction-Grade Insight$/i, targetAddr: "FN.0.2.21", reason: "Reconstruction-grade insight is most useful as documentation and explanation guidance." },
  { pattern: /^Cross-Pyramid Edge Counting$/i, targetAddr: "FN.0.2.1", reason: "Edge-count integrity is primarily an inspection and enumeration concern." },
  { pattern: /^Control curl output verbosity$/i, targetAddr: "FN.0.2.25", reason: "curl verbosity control is CLI and local tooling behavior." },
  { pattern: /^Ingest-Context-Connect-Act-Evolve$/i, targetAddr: "FN.0.2.7", reason: "This is a workflow coordination loop for agent action." },
  { pattern: /^Model Failover$/i, targetAddr: "FN.0.2.31", reason: "Model failover is a graceful degradation and continuity mechanism." },
  { pattern: /^Verity Scope$/i, targetAddr: "FN.0.2.22", reason: "Scope is a user interaction surface for graph navigation and operations." },
  { pattern: /^Pairing & Trust$/i, targetAddr: "FN.0.2.18", reason: "Pairing and trust are fundamentally authentication and access-control concerns." },
  { pattern: /^Operational Lessons$/i, targetAddr: "FN.0.2.32", reason: "Operational lessons are most actionable as reliability and hardening knowledge." },
  { pattern: /^Staging Safety Gate$/i, targetAddr: "FN.0.2.20", reason: "A staging safety gate is a safety and threat-defense control." },
  { pattern: /^Intelligence & Content Pipeline$/i, targetAddr: "FN.0.2.7", reason: "Content pipelines are workflow coordination structures." },
  { pattern: /^Streaming & Chunking$/i, targetAddr: "FN.0.2.30", reason: "Streaming and chunking are performance and efficiency concerns." },
  { pattern: /^Usage Tracking$/i, targetAddr: "FN.0.2.3", reason: "Usage tracking is observability and telemetry." },
  { pattern: /^Sandboxing$/i, targetAddr: "FN.0.2.20", reason: "Sandboxing is a safety and threat-defense boundary." },
  { pattern: /^Compaction$/i, targetAddr: "FN.0.2.24", reason: "Conversation compaction primarily shapes prompt and agent-interface behavior." },
  { pattern: /^Merkle Security$/i, targetAddr: "FN.0.2.20", reason: "Merkle security is a hard trust-boundary and defense mechanism." },
  { pattern: /^Rate Limits & Bottleneck$/i, targetAddr: "FN.0.2.30", reason: "Rate limits and bottlenecks are performance and efficiency constraints." },
  { pattern: /^Anti-Pattern: Storing Stale Computed Values$/i, targetAddr: "FN.0.2.16", reason: "Stale computed values are a data and state operations anti-pattern." },
  { pattern: /^github$/i, targetAddr: "FN.0.2.28", reason: "GitHub is most useful here as an integration and automation surface for external development workflows." },
  { pattern: /^Capability Directory$/i, targetAddr: "FN.0.2.1", reason: "A capability directory is primarily an inspection and enumeration surface for agents." },
  { pattern: /^Session Management$/i, targetAddr: "FN.0.2.18", reason: "Session management is fundamentally about identity boundaries, scope, and access control." },
  { pattern: /^Known Failure Modes$/i, targetAddr: "FN.0.2.2", reason: "Failure-mode libraries are most actionable as debugging and root-cause aids." },
  { pattern: /^Complete Development Pipeline$/i, targetAddr: "FN.0.2.7", reason: "A development pipeline is best treated as a workflow coordination structure." },
  { pattern: /^Verity One Architecture$/i, targetAddr: "FN.0.2.21", reason: "Architecture overviews are most useful to agents as explanation and orientation surfaces." },
  { pattern: /(?:^| )(Converter|Editor|CLI|Terminal|Shell)(?:$| )/i, targetAddr: "FN.0.2.25", reason: "Local tooling cues map to CLIs and local tooling." },
  { pattern: /(?:^| )(Viewer|Display|Visualizer|UI)(?:$| )/i, targetAddr: "FN.0.2.22", reason: "Display and interface cues map to user interaction surfaces." },
  { pattern: /(?:^| )(Query|Search|Inspector|Watcher|Crawler|Scraper)(?:$| )/i, targetAddr: "FN.0.2.1", reason: "Inspection cues map to inspection and enumeration." },
  { pattern: /(?:^| )(Tracker|Telemetry|Metrics|Logs)(?:$| )/i, targetAddr: "FN.0.2.3", reason: "Tracking and metrics cues map to observability." },
];

const KEYWORD_RULES: Array<{ targetAddr: string; reason: string; keywords: string[] }> = [
  { targetAddr: "FN.0.2.18", reason: "Identity, auth, and trust-boundary cues map to access control.", keywords: ["oauth", "auth", "authentication", "authorization", "token", "permission", "access control", "identity", "credential", "secret"] },
  { targetAddr: "FN.0.2.26", reason: "Endpoint and protocol cues map to APIs and service surfaces.", keywords: ["endpoint", "api", "webhook", "gateway", "protocol", "rpc", "service surface"] },
  { targetAddr: "FN.0.2.23", reason: "Messaging and channel cues map to collaboration surfaces.", keywords: ["message", "messaging", "sms", "email", "discord", "slack", "telegram", "channel", "voice", "chat", "imessage", "whatsapp"] },
  { targetAddr: "FN.0.2.25", reason: "CLI and shell cues map to local tooling.", keywords: ["cli", "command line", "shell", "terminal", "tmux", "jq", "tooling"] },
  { targetAddr: "FN.0.2.14", reason: "Deployment and orchestration cues map to runtime operations.", keywords: ["deploy", "deployment", "cron", "orchestration", "runtime", "scheduler", "queue", "service restart", "supervisor"] },
  { targetAddr: "FN.0.2.15", reason: "Monitoring and health cues map to incident response.", keywords: ["monitor", "monitoring", "healthcheck", "health check", "alert", "incident", "telemetry", "trace", "log search"] },
  { targetAddr: "FN.0.2.16", reason: "Database and state cues map to state operations.", keywords: ["postgres", "database", "backup", "restore", "stateful", "vault", "queue state", "storage"] },
  { targetAddr: "FN.0.2.18", reason: "Session and scope cues map to access control.", keywords: ["session", "session scope", "scope boundary", "scoped access"] },
  { targetAddr: "FN.0.2.1", reason: "Directory and inventory cues map to inspection and enumeration.", keywords: ["directory", "catalog", "inventory", "capability list"] },
  { targetAddr: "FN.0.2.28", reason: "GitHub and repository coordination cues map to integrations and automation.", keywords: ["github", "repository automation", "repo sync"] },
  { targetAddr: "FN.0.2.24", reason: "Prompt and agent-interface cues map to agent interaction surfaces.", keywords: ["prompt", "subagent", "agent", "agentic", "tool call", "command resolution", "instruction"] },
  { targetAddr: "FN.0.2.28", reason: "Plugin and integration cues map to connectors and automation.", keywords: ["plugin", "integration", "connector", "adapter", "mcp", "extension", "hook"] },
  { targetAddr: "FN.0.2.21", reason: "Documentation and guide cues map to explanation surfaces.", keywords: ["documentation", "guide", "readme", "spec", "manual", "setup guide"] },
  { targetAddr: "FN.0.2.17", reason: "Testing and review cues map to validation.", keywords: ["test", "testing", "review", "validation", "verify", "quality"] },
  { targetAddr: "FN.0.2.29", reason: "Rollback and repair cues map to remediation.", keywords: ["rollback", "repair", "recover", "restore", "fix", "remediate"] },
  { targetAddr: "FN.0.2.30", reason: "Performance cues map to efficiency.", keywords: ["performance", "latency", "throughput", "optimize", "speed", "efficient"] },
  { targetAddr: "FN.0.2.32", reason: "Reliability and hardening cues map to resilience.", keywords: ["reliability", "resilience", "hardening", "fault", "durability", "self-healing"] },
  { targetAddr: "FN.0.2.9", reason: "Implementation and code cues map to authoring.", keywords: ["code", "coding", "build", "implementation", "authoring", "generator", "creator"] },
  { targetAddr: "FN.0.2.22", reason: "Interface and browser cues map to user interaction.", keywords: ["ui", "ux", "browser", "surface", "screen", "visualizer", "interface"] },
  { targetAddr: "FN.0.2.31", reason: "Failover and fallback cues map to graceful degradation.", keywords: ["failover", "fallback chain", "degraded mode", "graceful degradation"] },
  { targetAddr: "FN.0.2.20", reason: "Sandbox and trust-boundary cues map to safety and defense.", keywords: ["sandbox", "sandboxing", "isolation boundary", "trust boundary"] },
  { targetAddr: "FN.0.2.16", reason: "Freshness and stale-state cues map to data and state operations.", keywords: ["stale", "freshness", "computed value", "state drift", "cache invalidation"] },
];

function compactText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => `${part || ""}`.trim())
    .filter(Boolean)
    .join("\n");
}

function scoreBranch(text: string, label: string, keywords: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of [label, ...keywords]) {
    const keyword = term.toLowerCase();
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += keyword.includes(" ") ? 3 : 2;
  }
  return score;
}

function inferredActionability(nodeType: string | null | undefined, candidate: FunctionalAlignmentCandidate): number {
  const normalized = (nodeType || "").toLowerCase();
  if (ACTIONABLE_NODE_TYPES.has(normalized)) return 5;
  if (normalized === "anti-pattern") return 4;
  if ((candidate.addr || "").match(/^[OCXCM]+\./) && (candidate.parent_addr || "").endsWith(".1.4")) return 4;
  return 3;
}

function humanPyramidLabel(pyramidId: string): string {
  switch ((pyramidId || "").toUpperCase()) {
    case "OPENCLAW": return "FUNCTION (ex-OpenClaw)";
    case "CLAUDECODE": return "FUNCTION (ex-Claude Code)";
    case "CODEX": return "FUNCTION (ex-Codex)";
    case "FUNCTION": return "Functional Knowledge";
    case "META": return "Pyramid System";
    default: return pyramidId || "the local system";
  }
}

export function planFunctionalAlignment(candidate: FunctionalAlignmentCandidate): FunctionalAlignmentPlan | null {
  const override = OVERRIDES[candidate.addr];
  const nodeType = (candidate.node_type || "").toLowerCase();
  const pyramidId = (candidate.pyramid_id || "").toUpperCase();
  const text = compactText([candidate.label, candidate.description]);
  const labelText = (candidate.label || "").toLowerCase();
  const isActionable = ACTIONABLE_NODE_TYPES.has(nodeType) || nodeType === "anti-pattern";

  // Canonical WORLD concepts should bridge into FUNCTION through stronger resonance edges,
  // not get hard-wired functional anchors from ambiguous words like "state".
  if (pyramidId === "WORLD" && !isActionable) {
    return null;
  }

  let targetAddr: string | null = null;
  let reason = "";

  if (override) {
    targetAddr = override.targetAddr;
    reason = override.reason;
  } else {
    const labelRule = LABEL_RULES.find((rule) => rule.pattern.test(candidate.label || ""));
    if (labelRule) {
      targetAddr = labelRule.targetAddr;
      reason = labelRule.reason;
    }
  }

  if (!targetAddr) {
    const keywordRule = KEYWORD_RULES.find((rule) =>
      rule.keywords.some((keyword) => labelText.includes(keyword.toLowerCase())),
    );
    if (keywordRule) {
      targetAddr = keywordRule.targetAddr;
      reason = keywordRule.reason;
    }
  }

  if (!targetAddr) {
    const input: DurableOntologyInput = {
      content: text,
      nodeType: candidate.node_type || "concept",
      actionability: inferredActionability(candidate.node_type, candidate),
      includeLocalPyramids: false,
    };
    const suggestion = suggestDurableOntologyTarget(input);
    if (suggestion.pyramidId !== "FUNCTION" || !suggestion.parentAddr) return null;
    targetAddr = suggestion.parentAddr;
    reason = suggestion.selectionReason;

    const childBranches = ONTOLOGY_CHILD_BRANCHES[suggestion.parentAddr] || [];
    let bestChild: { addr: string; label: string; score: number } | null = null;
    for (const branch of childBranches) {
      const score = scoreBranch(text, branch.label, branch.keywords);
      if (!bestChild || score > bestChild.score) {
        bestChild = { addr: branch.addr, label: branch.label, score };
      }
    }
    const childThreshold = ACTIONABLE_NODE_TYPES.has(nodeType) ? 2 : 3;
    if (bestChild && bestChild.score >= childThreshold) {
      targetAddr = bestChild.addr;
      reason = `${suggestion.selectionReason}; refined to functional sub-branch ${bestChild.label}`;
    }
  }

  if (!targetAddr) return null;

  const isDepthOneTarget = /^FN\.0\.1\./.test(targetAddr);
  const isExplicitTopLevel = Boolean(override) && isDepthOneTarget;
  if (isDepthOneTarget && !isExplicitTopLevel) return null;

  let edgeType: FunctionalAlignmentPlan["edgeType"] = "informs";
  if (ACTIONABLE_NODE_TYPES.has(nodeType)) edgeType = "operationalizes";
  else if (nodeType === "structure" || (candidate.addr.match(/\.[01]\./) && !nodeType)) edgeType = "specializes";

  const relationVerb = edgeType === "operationalizes"
    ? "operationalizes"
    : edgeType === "specializes"
      ? "specializes"
      : "informs";

  return {
    targetAddr,
    edgeType,
    reason,
    label: `${candidate.label} ${relationVerb} ${targetAddr} for ${humanPyramidLabel(pyramidId)} capabilities.`,
  };
}
