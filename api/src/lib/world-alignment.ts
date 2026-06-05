import {
  ONTOLOGY_BRANCHES,
  ONTOLOGY_CHILD_BRANCHES,
  type OntologyBranchDefinition,
} from "./ontology";

export interface WorldAlignmentCandidate {
  addr: string;
  pyramid_id: string;
  label: string;
  node_type?: string | null;
  description?: string | null;
  parent_addr?: string | null;
}

export interface WorldAlignmentPlan {
  targetAddr: string;
  edgeType: "frames" | "governs" | "informs";
  label: string;
  reason: string;
}

const STRUCTURAL_NODE_TYPES = new Set([
  "structure",
  "concept",
  "mechanism",
  "anti-pattern",
]);

const DEEPLY_FUNCTIONAL_NODE_TYPES = new Set([
  "tool",
  "skill",
  "workflow",
  "procedure",
  "protocol",
]);

const OVERRIDES: Record<string, { targetAddr: string; edgeType: WorldAlignmentPlan["edgeType"]; reason: string }> = {
  "CX.0.1.2": {
    targetAddr: "WD.0.2.35",
    edgeType: "frames",
    reason: "A foundation model node belongs in AI architectures and reasoning, not only in a local product tree.",
  },
  "CX.0.2.6": {
    targetAddr: "WD.0.2.35",
    edgeType: "frames",
    reason: "RL-trained coding describes an AI reasoning and model-training approach.",
  },
  "META.0.2.7": {
    targetAddr: "WD.0.2.44",
    edgeType: "governs",
    reason: "DAO governance belongs to decentralized collective coordination rather than generic governance alone.",
  },
  "META.0.2.8": {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "Token-shaped incentive structures belong to governance capture and voting design.",
  },
  "META.0.2.9": {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "A tokenized map economy belongs to governance incentives and capture dynamics.",
  },
  "META.0.2.24": {
    targetAddr: "WD.0.2.28",
    edgeType: "frames",
    reason: "Network topology is a direct model of communications infrastructure.",
  },
  "META.0.2.4": {
    targetAddr: "WD.0.2.34",
    edgeType: "frames",
    reason: "Diffusion models belong to machine learning and statistical modeling.",
  },
  "META.0.2.22": {
    targetAddr: "WD.0.2.35",
    edgeType: "frames",
    reason: "Model allocation belongs to AI architecture and reasoning strategy.",
  },
  "META.0.2.26": {
    targetAddr: "WD.0.2.18",
    edgeType: "frames",
    reason: "Memory architecture belongs to memory and learning as a world-level concept.",
  },
  "META.0.1.8": {
    targetAddr: "WD.0.2.20",
    edgeType: "informs",
    reason: "People and relationships belong to social cognition and identity.",
  },
  "META.0.3.3": {
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Meaning is best grounded in philosophy and epistemology for agents.",
  },
  "META.0.3.4": {
    targetAddr: "WD.0.2.3",
    edgeType: "frames",
    reason: "PCM methodology is a systems and cybernetics framing of the graph.",
  },
  "META.0.3.10": {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "A token model belongs to incentive and market design.",
  },
  "META.0.3.59": {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "Dual-token governance systems belong to token governance and incentive capture.",
  },
  "META.0.3.61": {
    targetAddr: "WD.0.2.46",
    edgeType: "governs",
    reason: "A DAO LLC belongs to compliance and legal wrapper structures around decentralized governance.",
  },
  "META.0.3.60": {
    targetAddr: "WD.0.2.46",
    edgeType: "governs",
    reason: "Treasury control through multisig governance belongs to DAO compliance and legal coordination structures.",
  },
  "META.0.3.90": {
    targetAddr: "WD.0.2.21",
    edgeType: "governs",
    reason: "Node ownership is a governance and power-allocation concept inside the graph.",
  },
  "META.0.3.58": {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "Contribution scoring for token weight belongs to incentive capture and token-governance design.",
  },
  "OC.0.2.132": {
    targetAddr: "WD.0.2.4",
    edgeType: "frames",
    reason: "The Fibonacci Dialectic Framework is a systems-theory model for growth and emergence.",
  },
  "OC.0.2.133": {
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Pyramid Vision is a philosophical and epistemic framing of knowledge organization.",
  },
  "OC.0.2.208": {
    targetAddr: "WD.0.2.3",
    edgeType: "frames",
    reason: "The resonance model is a world-level systems and information model.",
  },
};

const LABEL_RULES: Array<{
  pattern: RegExp;
  targetAddr: string;
  edgeType: WorldAlignmentPlan["edgeType"];
  reason: string;
}> = [
  {
    pattern: /\b(?:Reasoning|Transformer|Neural|Inference|Foundation Model|Agentic)\b/i,
    targetAddr: "WD.0.2.35",
    edgeType: "frames",
    reason: "Model and reasoning cues belong to AI architectures and reasoning.",
  },
  {
    pattern: /\b(?:Memory|Learning)\b/i,
    targetAddr: "WD.0.2.18",
    edgeType: "frames",
    reason: "Memory and learning cues belong to the world model of cognition.",
  },
  {
    pattern: /\b(?:Blockchain|Distributed Ledger|Smart Contract|Validator|Staking|Consensus)\b/i,
    targetAddr: "WD.0.2.47",
    edgeType: "frames",
    reason: "Blockchain substrate cues belong to distributed ledgers and smart contracts.",
  },
  {
    pattern: /\b(?:Protocol Governance|Meta-Governance|Self-Amending|Referendum)\b/i,
    targetAddr: "WD.0.2.42",
    edgeType: "governs",
    reason: "Protocol amendment and meta-governance cues belong to protocol governance.",
  },
  {
    pattern: /\b(?:On-Chain Governance|Off-Chain Governance|Hard Fork|Soft Fork|BIP|EIP)\b/i,
    targetAddr: "WD.0.2.43",
    edgeType: "governs",
    reason: "Blockchain change-process cues belong to on-chain and off-chain governance.",
  },
  {
    pattern: /\b(?:DAO|Decentralized Autonomous Organization|Liquid Democracy|Futarchy)\b/i,
    targetAddr: "WD.0.2.44",
    edgeType: "governs",
    reason: "DAO structures and governance styles belong to decentralized collective coordination.",
  },
  {
    pattern: /\b(?:Token Voting|Token-Based Voting|Governance Token|Quorum|Plutocracy|Governance Attack|Flash Loan)\b/i,
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "Token voting and capture cues belong to governance incentives and attack surfaces.",
  },
  {
    pattern: /\b(?:DAO Compliance|Legal Wrapper|DAO LLC|Financial Reporting|Accounting Standards|Payment Authorization|Multi-Signature|Multisig)\b/i,
    targetAddr: "WD.0.2.46",
    edgeType: "governs",
    reason: "DAO legal and reporting cues belong to compliance and legal wrappers.",
  },
  {
    pattern: /\b(?:Governance|Policy|Regulation|Rights)\b/i,
    targetAddr: "WD.0.2.21",
    edgeType: "governs",
    reason: "Governance and policy cues belong to world institutions and power.",
  },
  {
    pattern: /\b(?:Economy|Economic|Market|Incentive)\b/i,
    targetAddr: "WD.0.2.23",
    edgeType: "governs",
    reason: "Economic and incentive cues belong to markets and finance.",
  },
  {
    pattern: /\b(?:Network Topology|Network|Communications)\b/i,
    targetAddr: "WD.0.2.28",
    edgeType: "frames",
    reason: "Network cues belong to communications infrastructure.",
  },
  {
    pattern: /\b(?:Knowledge Architecture|Data Model|Topology|Simulation|Systems Theory|Cybernetic|Resonance)\b/i,
    targetAddr: "WD.0.2.4",
    edgeType: "frames",
    reason: "Systems-theory and simulation cues belong to cybernetics and formal modeling.",
  },
  {
    pattern: /\b(?:Diffusion|Dialectic|Epistemology|Meaning|Philosophy)\b/i,
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Epistemic and philosophical cues belong to philosophy and epistemology.",
  },
  {
    pattern: /^Questions > Answers$/i,
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Questions-over-answers is an epistemic stance about how knowledge should be explored.",
  },
  {
    pattern: /^Trust Through Verifiability$/i,
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Verifiability is a philosophical and epistemic grounding principle, not just a local workflow preference.",
  },
  {
    pattern: /^13 Core Invariants$/i,
    targetAddr: "WD.0.2.1",
    edgeType: "frames",
    reason: "Core invariants are formal logic constraints over graph behavior.",
  },
  {
    pattern: /\b(?:History|Media|Civilization|Narrative|Myth|Symbol)\b/i,
    targetAddr: "WD.0.2.41",
    edgeType: "informs",
    reason: "Historical and symbolic cues belong to world cultural memory.",
  },
  {
    pattern: /\b(?:Dialogue|Language|Identity|Social Cognition)\b/i,
    targetAddr: "WD.0.2.20",
    edgeType: "informs",
    reason: "Dialogue and identity cues belong to language and social cognition.",
  },
  {
    pattern: /\b(?:Consciousness|Subjective Experience|Attention|Emotion|Agency)\b/i,
    targetAddr: "WD.0.2.16",
    edgeType: "informs",
    reason: "Inner-world cognition cues belong to consciousness and subjective experience.",
  },
];

const SKIP_LABEL_RULES: RegExp[] = [
  /^Permissions & Safety$/i,
  /^Skills System$/i,
  /^Hooks System$/i,
  /^Plugin System$/i,
  /^Checkpointing$/i,
  /^Cloud Sandbox$/i,
  /^Safety & Verification$/i,
  /^Cron Orchestration$/i,
  /^Intake Pipeline$/i,
  /^Triage Agent$/i,
  /^Project Status$/i,
  /^Models & Config$/i,
  /^MCP \(Model Context Protocol\)$/i,
  /^Structure$/i,
  /^Engine$/i,
  /^Layers$/i,
  /^Infrastructure$/i,
  /^The Fusion$/i,
  /^governance-role$/i,
  /^Enterprise Features$/i,
  /^Cloud Sessions$/i,
  /^Sandboxed Bash$/i,
  /^GitHub Actions$/i,
];

const KEYWORD_RULES: Array<{
  targetAddr: string;
  edgeType: WorldAlignmentPlan["edgeType"];
  reason: string;
  keywords: string[];
}> = [
  {
    targetAddr: "WD.0.2.47",
    edgeType: "frames",
    reason: "Blockchain substrate cues belong to distributed ledgers and smart contracts.",
    keywords: ["blockchain", "distributed ledger", "smart contract", "validator", "staking", "consensus", "ledger"],
  },
  {
    targetAddr: "WD.0.2.42",
    edgeType: "governs",
    reason: "Protocol amendment cues belong to protocol governance and meta-governance.",
    keywords: ["protocol governance", "meta-governance", "protocol upgrade", "self-amending", "constitutional layer", "referendum"],
  },
  {
    targetAddr: "WD.0.2.43",
    edgeType: "governs",
    reason: "On-chain and off-chain process cues belong to blockchain governance mechanics.",
    keywords: ["on-chain governance", "off-chain governance", "hard fork", "soft fork", "bip", "eip", "governance proposal"],
  },
  {
    targetAddr: "WD.0.2.44",
    edgeType: "governs",
    reason: "DAO coordination cues belong to decentralized collective governance.",
    keywords: ["dao", "decentralized autonomous organization", "liquid democracy", "futarchy", "delegate", "community governance"],
  },
  {
    targetAddr: "WD.0.2.45",
    edgeType: "governs",
    reason: "Token voting and attack cues belong to token governance dynamics.",
    keywords: ["token voting", "token-based voting", "governance token", "quorum", "voter apathy", "plutocracy", "governance attack", "flash loan"],
  },
  {
    targetAddr: "WD.0.2.46",
    edgeType: "governs",
    reason: "DAO legal-wrapper and reporting cues belong to compliance structures.",
    keywords: ["dao compliance", "legal wrapper", "dao llc", "financial reporting", "accounting", "payment authorization", "multi-signature", "multisig"],
  },
  {
    targetAddr: "WD.0.2.35",
    edgeType: "frames",
    reason: "AI architecture cues belong to world-level intelligence structures.",
    keywords: ["agentic", "reasoning", "transformer", "neural", "attention", "inference", "foundation model", "model architecture", "rl-trained", "reinforcement learning"],
  },
  {
    targetAddr: "WD.0.2.33",
    edgeType: "frames",
    reason: "Knowledge and information cues belong to data and knowledge systems.",
    keywords: ["knowledge graph", "knowledge", "graph", "embedding", "information system", "registry", "addressing", "taxonomy"],
  },
  {
    targetAddr: "WD.0.2.4",
    edgeType: "frames",
    reason: "Systems and cybernetics cues belong to world-level systems thinking.",
    keywords: ["cybernetic", "feedback", "resonance", "simulation", "triad", "systems theory", "self-organizing", "emergence"],
  },
  {
    targetAddr: "WD.0.2.18",
    edgeType: "frames",
    reason: "Memory and learning cues belong to world-level cognition.",
    keywords: ["memory", "learning", "context retention", "persistent context", "recall"],
  },
  {
    targetAddr: "WD.0.2.20",
    edgeType: "informs",
    reason: "Language and identity cues belong to social cognition.",
    keywords: ["dialogue", "language", "identity", "persona", "conversation", "social cognition", "social"],
  },
  {
    targetAddr: "WD.0.2.16",
    edgeType: "informs",
    reason: "Consciousness and subjective cues belong to inner-world cognition.",
    keywords: ["consciousness", "awareness", "subjective", "attention", "emotion", "agency"],
  },
  {
    targetAddr: "WD.0.2.21",
    edgeType: "governs",
    reason: "Governance cues belong to institutions and power.",
    keywords: ["governance", "dao", "policy", "rights", "regulation", "govern"],
  },
  {
    targetAddr: "WD.0.2.23",
    edgeType: "governs",
    reason: "Economic cues belong to markets and incentives.",
    keywords: ["economy", "economic", "token", "market", "finance", "incentive", "reward"],
  },
  {
    targetAddr: "WD.0.2.28",
    edgeType: "frames",
    reason: "Network and topology cues belong to communications infrastructure.",
    keywords: ["network topology", "topology", "network", "communications", "mesh", "routing"],
  },
  {
    targetAddr: "WD.0.2.37",
    edgeType: "informs",
    reason: "Philosophical and epistemic cues belong to philosophy and epistemology.",
    keywords: ["epistemology", "meaning", "philosophy", "truth", "belief", "dialectic", "ontology"],
  },
  {
    targetAddr: "WD.0.2.41",
    edgeType: "informs",
    reason: "Historical and media cues belong to civilizational memory.",
    keywords: ["history", "historical", "media", "narrative", "story", "symbol", "civilization"],
  },
];

function compactText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => `${part || ""}`.trim())
    .filter(Boolean)
    .join("\n");
}

function scoreBranch(text: string, branch: OntologyBranchDefinition): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of [branch.label, ...branch.keywords]) {
    const keyword = term.toLowerCase();
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += keyword.includes(" ") ? 3 : 2;
  }
  return score;
}

function bestBranch(text: string, branches: OntologyBranchDefinition[]): { branch: OntologyBranchDefinition | null; score: number } {
  let best: OntologyBranchDefinition | null = null;
  let bestScore = 0;
  for (const branch of branches) {
    const score = scoreBranch(text, branch);
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return { branch: best, score: bestScore };
}

function normalizeNodeType(nodeType: string | null | undefined): string {
  return (nodeType || "").toLowerCase();
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

function worldLabelFor(addr: string): string {
  for (const branch of ONTOLOGY_BRANCHES.WORLD || []) {
    if (branch.addr === addr) return branch.label;
  }
  for (const branch of ONTOLOGY_BRANCHES.WORLD || []) {
    for (const child of ONTOLOGY_CHILD_BRANCHES[branch.addr] || []) {
      if (child.addr === addr) return child.label;
    }
  }
  return addr;
}

function inferEdgeType(text: string, fallback: WorldAlignmentPlan["edgeType"] = "informs"): WorldAlignmentPlan["edgeType"] {
  const lower = text.toLowerCase();
  if (/(govern|policy|regulation|rights|econom|market|finance|incentive|token|dao)/.test(lower)) return "governs";
  if (/(philosophy|epistemology|meaning|identity|culture|history|media|dialogue|language|consciousness|emotion|attention|agency)/.test(lower)) return "informs";
  if (/(model|architecture|simulation|framework|topology|system|systems|reasoning|memory architecture|knowledge architecture|diffusion)/.test(lower)) return "frames";
  return fallback;
}

function shouldSkip(candidate: WorldAlignmentCandidate, worldScore: number, functionScore: number): boolean {
  const nodeType = normalizeNodeType(candidate.node_type);
  const label = `${candidate.label || ""}`.toLowerCase();

  if (DEEPLY_FUNCTIONAL_NODE_TYPES.has(nodeType) && worldScore < 6) return true;
  if (/(?:\bcli\b|\bapi\b|\bplugin\b|\bhook\b|\bactions\b|\bsandboxed bash\b|\bexec\b|\bprocess\b)/i.test(label) && worldScore < 7) {
    return true;
  }
  if (functionScore >= worldScore + 3 && worldScore < 7) return true;
  return worldScore < (STRUCTURAL_NODE_TYPES.has(nodeType) ? 4 : 5);
}

export function planWorldAlignment(candidate: WorldAlignmentCandidate): WorldAlignmentPlan | null {
  const override = OVERRIDES[candidate.addr];
  const text = compactText([candidate.label, candidate.description]);
  const labelText = `${candidate.label || ""}`.toLowerCase();

  if (SKIP_LABEL_RULES.some((pattern) => pattern.test(candidate.label || ""))) return null;

  if (override) {
    return {
      targetAddr: override.targetAddr,
      edgeType: override.edgeType,
      reason: override.reason,
      label: `${candidate.label} ${override.edgeType} ${worldLabelFor(override.targetAddr)} for ${humanPyramidLabel(candidate.pyramid_id)} world grounding.`,
    };
  }

  const labelRule = LABEL_RULES.find((rule) => rule.pattern.test(candidate.label || ""));
  if (labelRule) {
    return {
      targetAddr: labelRule.targetAddr,
      edgeType: labelRule.edgeType,
      reason: labelRule.reason,
      label: `${candidate.label} ${labelRule.edgeType} ${worldLabelFor(labelRule.targetAddr)} for ${humanPyramidLabel(candidate.pyramid_id)} world grounding.`,
    };
  }

  const keywordRule = KEYWORD_RULES.find((rule) =>
    rule.keywords.some((keyword) => labelText.includes(keyword.toLowerCase())),
  );
  if (keywordRule) {
    return {
      targetAddr: keywordRule.targetAddr,
      edgeType: keywordRule.edgeType,
      reason: keywordRule.reason,
      label: `${candidate.label} ${keywordRule.edgeType} ${worldLabelFor(keywordRule.targetAddr)} for ${humanPyramidLabel(candidate.pyramid_id)} world grounding.`,
    };
  }

  const worldParents = ONTOLOGY_BRANCHES.WORLD || [];
  const worldParent = bestBranch(text, worldParents);
  if (!worldParent.branch) return null;

  const worldChildren = ONTOLOGY_CHILD_BRANCHES[worldParent.branch.addr] || [];
  const worldChild = bestBranch(text, worldChildren);
  const functionParents = ONTOLOGY_BRANCHES.FUNCTION || [];
  const functionParent = bestBranch(text, functionParents);
  const functionChildren = functionParent.branch ? (ONTOLOGY_CHILD_BRANCHES[functionParent.branch.addr] || []) : [];
  const functionChild = bestBranch(text, functionChildren);
  const bestWorldScore = Math.max(worldParent.score, worldChild.score);
  const bestFunctionScore = Math.max(functionParent.score, functionChild.score);

  if (shouldSkip(candidate, bestWorldScore, bestFunctionScore)) return null;
  if (!worldChild.branch || worldChild.score < Math.max(5, worldParent.score)) return null;

  const target = worldChild.branch;
  const edgeType = inferEdgeType(text);

  return {
    targetAddr: target.addr,
    edgeType,
    reason: `World branch keywords aligned best with ${target.label}`,
    label: `${candidate.label} ${edgeType} ${target.label} for ${humanPyramidLabel(candidate.pyramid_id)} world grounding.`,
  };
}
