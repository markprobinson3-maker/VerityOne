import { buildAddr, PYRAMID_PREFIX_BY_ID, type KnownPyramidId } from "./graph-shape";

type SqlTag = any;

export interface DurableOntologyInput {
  content: string;
  sourceType?: string | null;
  sourceTitle?: string | null;
  sourceId?: string | null;
  sourceExcerpt?: string | null;
  nodeType?: string | null;
  atomType?: string | null;
  atomSubtype?: string | null;
  domains?: string[] | null;
  actionability?: number | null;
  includeLocalPyramids?: boolean | null;
}

export interface OntologyBranchDefinition {
  addr: string;
  label: string;
  description: string;
  keywords: string[];
}

export interface DurableOntologySuggestion {
  pyramidId: KnownPyramidId;
  parentAddr: string | null;
  parentLabel: string | null;
  selectionReason: string;
  keywordScore: number;
}

// F5 typed this as Partial<Record<KnownPyramidId, ...>> after TEMPORAL
// joined CORE_PYRAMID_IDS without ontology metadata. The previous
// Record<KnownPyramidId, ...> claim was already false for HEURISTIC and
// would silently widen with each new canonical pyramid. The bridge-list
// (subset of pyramids that participate in cross-pyramid alignment) lives
// in @verity-one/graph-shape as ONTOLOGY_BRIDGE_PYRAMIDS to avoid name
// collision with this metadata map.
export const ONTOLOGY_PYRAMIDS: Partial<Record<
  KnownPyramidId,
  { label: string; description: string; access: "public" | "shared" | "private" }
>> = {
  WORLD: {
    label: "World Model",
    description:
      "Grounding knowledge about reality, science, institutions, and the human world. It exists to anchor truth and context for agents.",
    access: "public",
  },
  FUNCTION: {
    label: "Functional Knowledge",
    description:
      "Action-oriented knowledge: methods, tools, workflows, operational constraints, and execution pathways an agent can use directly.",
    access: "public",
  },
  OPENCLAW: {
    label: "OpenClaw (archived → FUNCTION)",
    description:
      "Dissolved into FUNCTION as of 2026-03-20. OC.* addresses remain valid under FUNCTION.",
    access: "public",
  },
  CLAUDECODE: {
    label: "Claude Code (archived → FUNCTION)",
    description: "Dissolved into FUNCTION as of 2026-03-20. CC.* addresses remain valid under FUNCTION.",
    access: "public",
  },
  CODEX: {
    label: "Codex (archived → FUNCTION)",
    description: "Dissolved into FUNCTION as of 2026-03-20. CX.* addresses remain valid under FUNCTION.",
    access: "public",
  },
  META: {
    label: "Pyramid System Meta",
    description:
      "Pyramid system self-knowledge: ontology, runtime, governance, and architecture of the truth layer itself.",
    access: "shared",
  },
  PROJECTS: {
    label: "Projects",
    description: "Local project knowledge and implementations that do not belong in the shared world ontology.",
    access: "private",
  },
  TN: {
    label: "Trends",
    description: "Transient trend intelligence born from orphan convergence.",
    access: "public",
  },
};

export const ONTOLOGY_BRANCHES: Partial<Record<KnownPyramidId, OntologyBranchDefinition[]>> = {
  WORLD: [
    {
      addr: "WD.0.1.1",
      label: "Formal Systems",
      description: "Math, logic, statistics, proofs, and abstract formal structures.",
      keywords: ["math", "mathematics", "logic", "proof", "theorem", "statistics", "probability", "formal"],
    },
    {
      addr: "WD.0.1.2",
      label: "Physical World",
      description: "Physics, chemistry, energy, climate, materials, and the natural universe.",
      keywords: ["physics", "chemistry", "energy", "climate", "material", "astronomy", "space", "earth"],
    },
    {
      addr: "WD.0.1.3",
      label: "Life & Health",
      description: "Biology, medicine, health, genetics, and living systems.",
      keywords: ["biology", "medical", "medicine", "health", "disease", "genetic", "cell", "protein"],
    },
    {
      addr: "WD.0.1.4",
      label: "Minds & Society",
      description: "Consciousness, cognition, language, behavior, identity, and social systems.",
      keywords: ["mind", "consciousness", "awareness", "cognition", "attention", "memory", "emotion", "identity", "language", "behavior", "social", "society", "community"],
    },
    {
      addr: "WD.0.1.5",
      label: "Institutions & Economy",
      description: "Law, policy, governance, finance, markets, and organizational power structures.",
      keywords: ["law", "policy", "government", "regulation", "economy", "finance", "market", "business", "dao", "protocol governance", "legal wrapper", "governance token"],
    },
    {
      addr: "WD.0.1.6",
      label: "Engineering & Infrastructure",
      description: "Built systems, physical infrastructure, manufacturing, and applied engineering.",
      keywords: ["engineering", "infrastructure", "network", "manufacturing", "robot", "electrical", "civil", "mechanical"],
    },
    {
      addr: "WD.0.1.7",
      label: "Computing & Intelligence",
      description: "Software, machine learning, AI systems, computation, and information processing.",
      keywords: [
        "software",
        "compute",
        "computing",
        "machine learning",
        "artificial intelligence",
        "ai",
        "model",
        "transformer",
        "attention",
        "compiler",
        "neural",
        "blockchain",
        "distributed ledger",
        "smart contract",
        "validator",
        "staking",
        "consensus",
      ],
    },
    {
      addr: "WD.0.1.8",
      label: "Culture & History",
      description: "History, philosophy, art, literature, religion, and long-form civilizational memory.",
      keywords: ["history", "philosophy", "culture", "art", "literature", "religion", "media", "civilization"],
    },
  ],
  FUNCTION: [
    {
      addr: "FN.0.1.1",
      label: "Discovery & Diagnosis",
      description: "Observe, inspect, debug, analyze, and diagnose.",
      keywords: ["discover", "inspect", "debug", "analyze", "diagnose", "trace", "observe", "investigate"],
    },
    {
      addr: "FN.0.1.2",
      label: "Planning & Coordination",
      description: "Plan, coordinate, prioritize, and sequence work.",
      keywords: ["plan", "roadmap", "strategy", "coordinate", "prioritize", "schedule", "organize"],
    },
    {
      addr: "FN.0.1.3",
      label: "Build & Change",
      description: "Implement, modify, create, and ship changes.",
      keywords: ["build", "implement", "create", "develop", "modify", "change", "code", "write"],
    },
    {
      addr: "FN.0.1.4",
      label: "Operate & Maintain",
      description: "Run, deploy, provision, monitor, and maintain systems.",
      keywords: ["operate", "deploy", "monitor", "maintain", "provision", "run", "admin", "service"],
    },
    {
      addr: "FN.0.1.5",
      label: "Verify & Secure",
      description: "Test, validate, secure, and enforce trust boundaries.",
      keywords: ["test", "verify", "validate", "secure", "security", "audit", "auth", "permission", "compliance"],
    },
    {
      addr: "FN.0.1.6",
      label: "Communicate & Interface",
      description: "Present, explain, message, prompt, and interact with users and systems.",
      keywords: ["communicate", "message", "interface", "ui", "ux", "prompt", "present", "explain", "api"],
    },
    {
      addr: "FN.0.1.7",
      label: "Tools & Integrations",
      description: "Tools, CLIs, APIs, SDKs, connectors, and integrations.",
      keywords: ["tool", "cli", "api", "sdk", "library", "connector", "integration", "plugin", "package"],
    },
    {
      addr: "FN.0.1.8",
      label: "Recovery & Optimization",
      description: "Fallbacks, rollback, repair, performance tuning, and resilience.",
      keywords: ["recover", "rollback", "repair", "optimize", "tune", "fallback", "resilience", "performance"],
    },
  ],
  OPENCLAW: [
    { addr: "OC.0.1.1", label: "Gateway", description: "OpenClaw gateway and ingress surfaces.", keywords: ["gateway", "ingress", "session", "remote", "pairing"] },
    { addr: "OC.0.1.2", label: "Channels", description: "OpenClaw channels and message surfaces.", keywords: ["channel", "discord", "telegram", "signal", "imessage", "sms", "voice"] },
    { addr: "OC.0.1.3", label: "Agent System", description: "Agent loop, multi-agent behavior, and orchestration.", keywords: ["agent", "subagent", "loop", "multi-agent", "orchestr"] },
    { addr: "OC.0.1.4", label: "Skills & Tools", description: "OpenClaw skills and internal tools.", keywords: ["skill", "tool", "plugin", "exec", "browser"] },
    { addr: "OC.0.1.5", label: "Models & Auth", description: "Model providers, auth, and identity.", keywords: ["model", "provider", "auth", "token", "apikey", "credential"] },
    { addr: "OC.0.1.6", label: "Workspace", description: "Workspace and environment behavior.", keywords: ["workspace", "sandbox", "filesystem", "context", "session state"] },
    { addr: "OC.0.1.7", label: "Tools", description: "Additional OpenClaw tool surfaces.", keywords: ["tool", "integration", "adapter", "connector"] },
  ],
  META: [
    { addr: "META.0.1.1", label: "Structure", description: "Ontology shape, storage, addressing, and topology.", keywords: ["ontology", "structure", "address", "registry", "schema", "graph"] },
    { addr: "META.0.1.2", label: "Engine", description: "Runtime, workers, ingest, QC, reactor, and truth maintenance.", keywords: ["reactor", "sentinel", "runtime", "worker", "ingest", "trend", "heartbeat"] },
    { addr: "META.0.1.3", label: "Economy", description: "Governance, incentives, and system-wide coordination.", keywords: ["governance", "economy", "incentive", "dao", "ownership"] },
  ],
};

export const ONTOLOGY_CHILD_BRANCHES: Partial<Record<string, OntologyBranchDefinition[]>> = {
  "WD.0.1.1": [
    { addr: "WD.0.2.1", label: "Logic & Inference", description: "Deduction, induction, validity, proofs, and formal reasoning rules.", keywords: ["logic", "inference", "deduction", "induction", "proof", "reasoning", "validity"] },
    { addr: "WD.0.2.2", label: "Probability & Uncertainty", description: "Chance, uncertainty, Bayesian reasoning, and statistical confidence.", keywords: ["probability", "uncertainty", "bayesian", "likelihood", "prior", "posterior", "stochastic"] },
    { addr: "WD.0.2.3", label: "Information & Complexity", description: "Information theory, entropy, compression, complexity, and signal structure.", keywords: ["information theory", "entropy", "compression", "complexity", "kolmogorov", "signal", "noise"] },
    { addr: "WD.0.2.4", label: "Systems Theory & Cybernetics", description: "Feedback, control, adaptation, emergence, and system-level behavior.", keywords: ["systems theory", "cybernetics", "feedback", "control", "emergence", "adaptation", "system dynamics"] },
    { addr: "WD.0.2.5", label: "Formal Modeling & Simulation", description: "Models, simulations, abstractions, and formal scenario exploration.", keywords: ["model", "simulation", "formal model", "scenario", "abstraction", "state space", "simulation"] },
  ],
  "WD.0.1.2": [
    { addr: "WD.0.2.6", label: "Matter, Energy & Dynamics", description: "Matter, forces, motion, energy transfer, and physical change.", keywords: ["matter", "energy", "dynamics", "force", "motion", "thermodynamics", "mechanics"] },
    { addr: "WD.0.2.7", label: "Earth, Climate & Environment", description: "Planetary systems, ecology, climate, geology, and environmental change.", keywords: ["earth", "climate", "environment", "ecology", "geology", "weather", "planetary"] },
    { addr: "WD.0.2.8", label: "Space, Time & Cosmology", description: "Space, time, relativity, cosmology, and the large-scale universe.", keywords: ["space", "time", "cosmology", "relativity", "universe", "astrophysics", "cosmos"] },
    { addr: "WD.0.2.9", label: "Chemistry & Molecular Systems", description: "Atoms, molecules, reactions, and molecular-scale interactions.", keywords: ["chemistry", "molecule", "reaction", "chemical", "atomic", "bond", "compound"] },
    { addr: "WD.0.2.10", label: "Measurement & Physical Instrumentation", description: "Measurement, sensing, calibration, and empirical instrumentation.", keywords: ["measurement", "instrumentation", "sensor", "calibration", "metrology", "observe", "measurement error"] },
  ],
  "WD.0.1.3": [
    { addr: "WD.0.2.11", label: "Cells, Genes & Evolution", description: "Cells, genetics, heredity, mutation, and evolutionary change.", keywords: ["cell", "gene", "genetic", "evolution", "dna", "mutation", "selection"] },
    { addr: "WD.0.2.12", label: "Organisms & Physiology", description: "Bodies, organs, systems, physiology, and living function.", keywords: ["organism", "physiology", "organ", "metabolism", "body", "homeostasis", "anatomy"] },
    { addr: "WD.0.2.13", label: "Brains & Nervous Systems", description: "Neural systems, cognition substrates, and biological information processing.", keywords: ["brain", "nervous system", "neural", "neuron", "cortex", "cognitive neuroscience", "synapse"] },
    { addr: "WD.0.2.14", label: "Disease & Pathology", description: "Disease mechanisms, pathology, dysfunction, and biological failure modes.", keywords: ["disease", "pathology", "infection", "disorder", "syndrome", "pathogen", "injury"] },
    { addr: "WD.0.2.15", label: "Medicine, Intervention & Longevity", description: "Diagnosis, treatment, intervention, prevention, and lifespan extension.", keywords: ["medicine", "treatment", "therapy", "intervention", "prevention", "clinical", "longevity"] },
  ],
  "WD.0.1.4": [
    { addr: "WD.0.2.16", label: "Consciousness & Subjective Experience", description: "Awareness, subjectivity, qualia, and first-person experience.", keywords: ["consciousness", "subjective", "experience", "qualia", "awareness", "self-awareness", "phenomenology", "phenomenal", "hard problem", "easy problems", "psychophysical", "philosophy-of-mind", "structural coherence", "organizational invariance"] },
    { addr: "WD.0.2.17", label: "Perception & Attention", description: "Sensation, attention, salience, framing, and perceptual selection.", keywords: ["perception", "attention", "salience", "focus", "sensory", "frame", "notice"] },
    { addr: "WD.0.2.18", label: "Memory & Learning", description: "Learning, recall, generalization, memory systems, and adaptation.", keywords: ["memory", "learning", "recall", "generalization", "adapt", "habit", "retention"] },
    { addr: "WD.0.2.19", label: "Emotion, Motivation & Agency", description: "Emotion, drive, motivation, goals, intent, and human agency.", keywords: ["emotion", "motivation", "agency", "intent", "goal", "desire", "drive"] },
    { addr: "WD.0.2.20", label: "Language, Identity & Social Cognition", description: "Language, self-models, identity, communication, and understanding others.", keywords: ["language", "identity", "social cognition", "communication", "self-model", "theory of mind", "meaning"] },
  ],
  "WD.0.1.5": [
    { addr: "WD.0.2.21", label: "Governance & Power", description: "Authority, governance, power, legitimacy, and institutional control.", keywords: ["governance", "power", "authority", "state", "institution", "legitimacy", "rule"] },
    { addr: "WD.0.2.22", label: "Law, Rights & Regulation", description: "Law, rights, contracts, regulation, and formal constraints.", keywords: ["law", "rights", "regulation", "contract", "legal", "compliance", "statute"] },
    { addr: "WD.0.2.23", label: "Markets, Finance & Incentives", description: "Markets, pricing, capital, exchange, incentives, and finance.", keywords: ["market", "finance", "capital", "pricing", "incentive", "investment", "trade"] },
    { addr: "WD.0.2.24", label: "Organizations & Coordination", description: "Organizations, institutions, bureaucracy, teams, and coordinated action.", keywords: ["organization", "coordination", "bureaucracy", "team", "firm", "management", "collective action"] },
    { addr: "WD.0.2.25", label: "Policy, Public Systems & Collective Risk", description: "Public systems, policy design, systemic risk, and large-scale coordination failures.", keywords: ["policy", "public system", "collective risk", "systemic risk", "public goods", "governance failure", "policy design"] },
    { addr: "WD.0.2.42", label: "Protocol Governance & Meta-Governance", description: "How blockchain protocols amend themselves, set upgrade authority, and govern governance itself.", keywords: ["protocol governance", "blockchain governance", "meta-governance", "protocol upgrade", "constitutional layer", "self-amending", "governance process", "referendum"] },
    { addr: "WD.0.2.43", label: "On-Chain & Off-Chain Governance", description: "Formal on-chain voting and informal off-chain coordination for blockchain network change.", keywords: ["on-chain governance", "off-chain governance", "protocol voting", "hard fork", "soft fork", "governance proposal", "bip", "eip"] },
    { addr: "WD.0.2.44", label: "DAOs & Collective Coordination", description: "Decentralized autonomous organizations, delegate structures, community participation, and collective coordination.", keywords: ["dao", "dao governance", "decentralized autonomous organization", "liquid democracy", "futarchy", "delegate", "delegation", "community governance", "collective coordination"] },
    { addr: "WD.0.2.45", label: "Token Governance & Incentive Capture", description: "Token-based voting, quorum, delegation, plutocracy, and governance capture or attack dynamics.", keywords: ["token voting", "token-based voting", "governance token", "quorum", "voter apathy", "plutocracy", "governance attack", "flash loan"] },
    { addr: "WD.0.2.46", label: "DAO Compliance & Legal Wrappers", description: "Legal wrappers, accounting, reporting, payment authorization, multisig controls, and DAO compliance obligations.", keywords: ["dao compliance", "legal wrapper", "dao llc", "financial reporting", "accounting standards", "payment authorization", "multi-signature", "multisig"] },
  ],
  "WD.0.1.6": [
    { addr: "WD.0.2.26", label: "Energy & Utilities", description: "Power generation, utilities, grids, and resource delivery systems.", keywords: ["energy", "utility", "power grid", "electricity", "water", "resource delivery", "grid"] },
    { addr: "WD.0.2.27", label: "Transport & Mobility", description: "Movement of people, goods, and vehicles across physical systems.", keywords: ["transport", "mobility", "vehicle", "traffic", "logistics", "shipping", "transit"] },
    { addr: "WD.0.2.28", label: "Networks & Communications Infrastructure", description: "Telecom, network infrastructure, bandwidth, routing, and communication systems.", keywords: ["network", "communications", "telecom", "routing", "bandwidth", "internet infrastructure", "signal network"] },
    { addr: "WD.0.2.29", label: "Manufacturing & Supply Chains", description: "Production systems, supply chains, fabrication, and industrial throughput.", keywords: ["manufacturing", "supply chain", "production", "factory", "fabrication", "industrial", "logistics"] },
    { addr: "WD.0.2.30", label: "Built Environment, Robotics & Control", description: "Buildings, automation, robotics, sensors, control loops, and physical actuation.", keywords: ["built environment", "robotics", "control", "automation", "actuator", "building system", "physical control"] },
  ],
  "WD.0.1.7": [
    { addr: "WD.0.2.31", label: "Algorithms & Computation", description: "Algorithms, complexity, optimization, and computational procedure.", keywords: ["algorithm", "computation", "optimize", "complexity", "program", "runtime", "search algorithm"] },
    { addr: "WD.0.2.32", label: "Software & Distributed Systems", description: "Software architecture, distributed systems, services, and runtime coordination.", keywords: ["software", "distributed system", "service", "runtime", "concurrency", "architecture", "protocol"] },
    { addr: "WD.0.2.33", label: "Data, Knowledge & Information Systems", description: "Databases, knowledge graphs, retrieval, indexing, and information organization.", keywords: ["data", "database", "knowledge graph", "retrieval", "index", "information system", "search"] },
    { addr: "WD.0.2.34", label: "Machine Learning & Statistical Models", description: "Learning systems, statistical modeling, estimation, and predictive inference.", keywords: ["machine learning", "statistical model", "regression", "classification", "training", "prediction", "estimation"] },
    { addr: "WD.0.2.35", label: "AI Architectures & Reasoning", description: "AI architectures, reasoning systems, model structure, and agent cognition.", keywords: ["ai architecture", "reasoning", "transformer", "attention", "agent", "model architecture", "inference engine"] },
    { addr: "WD.0.2.36", label: "Human-Computer Interaction", description: "Interfaces between humans and computing systems, including usability and cognition-aware interaction.", keywords: ["human-computer interaction", "hci", "usability", "interaction design", "interface", "human factors", "user cognition"] },
    { addr: "WD.0.2.47", label: "Distributed Ledgers & Smart Contracts", description: "Blockchains, distributed ledgers, validators, smart contracts, staking, and consensus-bearing protocol state.", keywords: ["blockchain", "distributed ledger", "smart contract", "validator", "staking", "consensus", "ledger"] },
  ],
  "WD.0.1.8": [
    { addr: "WD.0.2.37", label: "Philosophy & Epistemology", description: "Knowledge, truth, reasoning, reality, and philosophical frameworks.", keywords: ["philosophy", "epistemology", "truth", "metaphysics", "knowledge", "ethics", "moral philosophy", "practical reason", "practical principles", "moral law", "categorical imperative", "transcendental freedom", "ontology", "a priori", "a posteriori", "pure reason", "synthetic judgment", "judgment", "semantic conception of truth", "convention t", "liar paradox", "antinomy"] },
    { addr: "WD.0.2.68", label: "Ethics, Justice & Political Philosophy", description: "Normative philosophy about duty, virtue, justice, lawfulness, political order, and the good life.", keywords: ["ethics", "moral law", "duty", "virtue", "justice", "practical reason", "pure practical reason", "categorical imperative", "good will", "autonomy of the will", "humanity as an end", "benevolence", "conscience", "perpetual peace", "political moralist", "moral politician", "republic", "dialectic", "form of the good", "philosopher king", "socratic", "soul"] },
    { addr: "WD.0.2.38", label: "Religion, Spirituality & Worldviews", description: "Religious systems, spirituality, worldview formation, and sacred meaning structures.", keywords: ["religion", "spirituality", "worldview", "sacred", "belief system", "theology", "ritual"] },
    { addr: "WD.0.2.39", label: "Narrative, Myth & Symbol", description: "Stories, symbols, myths, archetypes, and shared frames for human meaning.", keywords: ["narrative", "myth", "symbol", "archetype", "story", "meaning-making", "frame"] },
    { addr: "WD.0.2.40", label: "Art, Aesthetics & Expression", description: "Art, aesthetics, taste, expression, and the shaping of felt experience.", keywords: ["art", "aesthetics", "expression", "taste", "beauty", "style", "creative"] },
    { addr: "WD.0.2.41", label: "History, Media & Civilizational Change", description: "Historical change, media systems, civilizational memory, and long-run cultural drift.", keywords: ["history", "media", "civilization", "historical change", "memory", "journalism", "cultural drift"] },
  ],
  "FN.0.1.1": [
    { addr: "FN.0.2.1", label: "Inspection & Enumeration", description: "List, inspect, inventory, and probe live state or available surfaces.", keywords: ["inspect", "enumerate", "inventory", "list", "scan", "probe", "introspect", "surface"] },
    { addr: "FN.0.2.2", label: "Debugging & Root Cause", description: "Reproduce failures, debug issues, and isolate underlying causes.", keywords: ["debug", "bug", "root cause", "failure", "error", "stack trace", "reproduce", "fault"] },
    { addr: "FN.0.2.3", label: "Observability & Telemetry", description: "Logs, metrics, traces, instrumentation, and runtime visibility.", keywords: ["observability", "telemetry", "metric", "metrics", "logs", "trace", "profiling", "instrumentation"] },
    { addr: "FN.0.2.4", label: "Research & Evaluation", description: "Compare options, benchmark outcomes, and evaluate alternatives.", keywords: ["research", "evaluate", "benchmark", "compare", "assess", "investigate", "experiment"] },
  ],
  "FN.0.1.2": [
    { addr: "FN.0.2.5", label: "Goal Decomposition", description: "Break goals into tasks, dependencies, and workable execution units.", keywords: ["decompose", "breakdown", "task", "tasks", "milestone", "dependency", "outline"] },
    { addr: "FN.0.2.6", label: "Scheduling & Prioritization", description: "Sequence work over time and decide what matters first.", keywords: ["schedule", "timeline", "deadline", "prioritize", "priority", "backlog", "queue"] },
    { addr: "FN.0.2.7", label: "Workflow Coordination", description: "Coordinate handoffs, orchestration, and multi-step execution.", keywords: ["coordinate", "coordination", "handoff", "orchestrate", "workflow", "sync", "assign"] },
    { addr: "FN.0.2.8", label: "Strategy & Decision Framing", description: "Frame choices, tradeoffs, and plans at the right level.", keywords: ["strategy", "decision", "tradeoff", "risk", "option", "heuristic", "roadmap"] },
  ],
  "FN.0.1.3": [
    { addr: "FN.0.2.9", label: "Implementation & Authoring", description: "Create code, documents, artifacts, and concrete changes.", keywords: ["implement", "implementation", "write", "author", "create", "draft", "build feature"] },
    { addr: "FN.0.2.10", label: "Refactoring & Restructuring", description: "Reorganize, simplify, and improve internal structure.", keywords: ["refactor", "restructure", "cleanup", "simplify", "modularize", "reorganize"] },
    { addr: "FN.0.2.11", label: "Migration & Transformation", description: "Port, convert, upgrade, or transform systems and data.", keywords: ["migrate", "migration", "transform", "convert", "upgrade", "port", "rewrite"] },
    { addr: "FN.0.2.12", label: "Release & Delivery", description: "Package, publish, ship, and deliver completed changes.", keywords: ["release", "ship", "publish", "package", "artifact", "delivery", "rollout"] },
  ],
  "FN.0.1.4": [
    { addr: "FN.0.2.13", label: "Environment & Provisioning", description: "Prepare environments, bootstrap systems, and configure dependencies.", keywords: ["provision", "bootstrap", "configure", "setup", "install", "environment", "secret"] },
    { addr: "FN.0.2.14", label: "Deployment & Orchestration", description: "Run deployments, schedulers, services, and runtime orchestration.", keywords: ["deploy", "deployment", "orchestration", "cron", "scheduler", "service", "container", "supervisor"] },
    { addr: "FN.0.2.15", label: "Monitoring & Incident Response", description: "Track health, alert on issues, and respond to incidents.", keywords: ["monitor", "alert", "incident", "on-call", "outage", "respond", "health check"] },
    { addr: "FN.0.2.16", label: "Data & State Operations", description: "Operate databases, queues, backups, restores, and stateful systems.", keywords: ["database", "queue", "backup", "restore", "replication", "stateful", "storage", "schema"] },
  ],
  "FN.0.1.5": [
    { addr: "FN.0.2.17", label: "Testing & Validation", description: "Assert correctness with tests, checks, and formal validation.", keywords: ["test", "testing", "validate", "validation", "smoke", "assert", "regression"] },
    { addr: "FN.0.2.18", label: "Authentication & Access Control", description: "Identity, permissions, authorization, and trust boundaries.", keywords: ["auth", "authentication", "authorization", "permission", "access control", "token", "identity"] },
    { addr: "FN.0.2.19", label: "Audit & Compliance", description: "Audit trails, policy checks, governance, and compliance workflows.", keywords: ["audit", "compliance", "policy", "governance", "review", "attest", "control"] },
    { addr: "FN.0.2.20", label: "Safety & Threat Defense", description: "Threat modeling, hardening, abuse resistance, and safety constraints.", keywords: ["threat", "vulnerability", "sandbox", "hardening", "exploit", "abuse", "defense", "safety"] },
  ],
  "FN.0.1.6": [
    { addr: "FN.0.2.21", label: "Documentation & Explanation", description: "Explain systems clearly with guides, references, and narrative context.", keywords: ["document", "documentation", "explain", "guide", "readme", "tutorial", "reference"] },
    { addr: "FN.0.2.22", label: "User Interaction & Experience", description: "Design and improve user-facing flows, interfaces, and usability.", keywords: ["ui", "ux", "screen", "interaction", "usability", "navigation", "interface design"] },
    { addr: "FN.0.2.23", label: "Messaging & Collaboration", description: "Share updates, coordinate through messages, and support collaborative work.", keywords: ["message", "notify", "email", "chat", "collaborate", "handoff", "status update"] },
    { addr: "FN.0.2.24", label: "Prompts & Agent Interfaces", description: "Shape instructions, schemas, and interfaces for AI and machine workflows.", keywords: ["prompt", "prompting", "system prompt", "tool call", "schema", "agent interface", "instruction"] },
  ],
  "FN.0.1.7": [
    { addr: "FN.0.2.25", label: "CLIs & Local Tooling", description: "Command-line tools, scripts, and local automation surfaces.", keywords: ["cli", "command line", "terminal", "shell", "script", "utility", "binary"] },
    { addr: "FN.0.2.26", label: "APIs & Service Surfaces", description: "HTTP, RPC, webhooks, and other live service interfaces.", keywords: ["api", "endpoint", "rest", "graphql", "rpc", "webhook", "service"] },
    { addr: "FN.0.2.27", label: "SDKs & Libraries", description: "Reusable packages, libraries, frameworks, and client code.", keywords: ["sdk", "library", "package", "module", "framework", "dependency", "client library"] },
    { addr: "FN.0.2.28", label: "Connectors & Automation", description: "Integrations, adapters, plugins, and automated cross-system glue.", keywords: ["connector", "adapter", "integration", "plugin", "extension", "automation", "sync"] },
  ],
  "FN.0.1.8": [
    { addr: "FN.0.2.29", label: "Rollback & Repair", description: "Undo, remediate, and restore when changes go wrong.", keywords: ["rollback", "revert", "repair", "restore", "undo", "remediate", "hotfix"] },
    { addr: "FN.0.2.30", label: "Performance & Efficiency", description: "Improve latency, throughput, memory, and resource efficiency.", keywords: ["performance", "latency", "throughput", "memory", "cpu", "optimize", "cache"] },
    { addr: "FN.0.2.31", label: "Fallbacks & Graceful Degradation", description: "Keep systems functioning safely when ideal paths fail.", keywords: ["fallback", "degrade", "graceful", "retry", "timeout", "circuit breaker"] },
    { addr: "FN.0.2.32", label: "Reliability & Hardening", description: "Increase durability, fault tolerance, and long-term resilience.", keywords: ["reliability", "durability", "fault tolerance", "hardening", "redundancy", "resilience"] },
  ],
};

const LOCAL_PYRAMID_KEYWORDS: Array<{ pyramidId: KnownPyramidId; keywords: string[] }> = [
  {
    pyramidId: "META",
    keywords: [
      "verity one",
      "truth layer",
      "reactor",
      "qc sentinel",
      "trend sidecar",
      "trend policy",
      "registry",
      "pyramid system",
      "scope",
      "world ingestor",
      "verity ingestor",
    ],
  },
  {
    pyramidId: "FUNCTION",
    keywords: ["openclaw", "docs.openclaw.ai", "gateway", "pairing", "openclaw.ai"],
  },
  {
    pyramidId: "FUNCTION",
    keywords: ["claude code", "anthropic", "sonnet", "opus", "claude"],
  },
  {
    pyramidId: "FUNCTION",
    keywords: ["codex", "chatgpt", "openai api", "codex cli", "codex cloud"],
  },
  {
    pyramidId: "PROJECTS",
    keywords: ["project", "initiative", "workstream", "deliverable"],
  },
];

const FUNCTION_SOURCE_TYPES = new Set(["github", "stackoverflow", "jupyter"]);
const WORLD_SOURCE_TYPES = new Set(["arxiv", "pdf", "doi"]);
const FUNCTION_NODE_TYPES = new Set(["tool", "skill", "workflow", "procedure", "protocol"]);
const FUNCTION_ATOM_TYPES = new Set(["ACTION"]);
const FUNCTION_SUBTYPES = new Set(["technique", "workflow", "tool", "integration"]);
const BLOCKCHAIN_WORLD_KEYWORDS = [
  "blockchain governance",
  "protocol governance",
  "meta-governance",
  "on-chain governance",
  "off-chain governance",
  "governance token",
  "distributed ledger",
  "smart contract",
  "dao",
  "decentralized autonomous organization",
  "legal wrapper",
  "dao llc",
  "multisig",
  "validator",
  "staking",
];
const PHILOSOPHY_WORLD_KEYWORDS = [
  "a priori",
  "synthetic a priori",
  "a posteriori",
  "pure reason",
  "speculative reason",
  "practical reason",
  "pure practical reason",
  "practical principle",
  "practical principles",
  "moral law",
  "categorical imperative",
  "transcendental freedom",
  "ratio cognoscendi",
  "good will",
  "virtue",
  "justice",
  "humanity as an end",
  "autonomy of the will",
  "perpetual peace",
  "political moralist",
  "moral politician",
  "dialectic",
  "transcendental",
  "categories",
  "thing in itself",
  "noumenon",
  "phenomenon",
  "pure intuition",
  "pure mathematics",
  "pure natural science",
  "possibility of experience",
  "possibility of metaphysics",
  "prolegomena",
  "form of the good",
  "philosopher king",
  "socratic",
  "analytic judgment",
  "analytical judgment",
  "synthetic judgment",
  "synthetical judgment",
  "metaphysics",
  "epistemology",
  "semantic conception of truth",
  "convention t",
  "liar paradox",
  "antinomy",
];
const ETHICS_POLITICAL_PHILOSOPHY_KEYWORDS = [
  "practical reason",
  "pure practical reason",
  "moral law",
  "moral permissibility",
  "duty",
  "virtue",
  "justice",
  "maxim",
  "universalizability",
  "universal law",
  "good will",
  "autonomy of the will",
  "humanity as an end",
  "humanity as end in itself",
  "kingdom of ends",
  "benevolence",
  "conscience",
  "right",
  "rights",
  "lawfulness",
  "ethical duties",
  "supreme principle of ethics",
  "state origin",
  "perpetual peace",
  "republican constitution",
  "political moralist",
  "moral politician",
  "republic",
  "federation of free states",
  "cosmopolitan right",
  "hospitality",
  "preliminary articles",
  "definitive articles",
  "dialectic",
  "form of the good",
  "philosopher king",
  "socratic",
  "city and soul",
];
const DEPTH_PSYCHOLOGY_WORLD_KEYWORDS = [
  "jung",
  "jungian",
  "analytical psychology",
  "depth psychology",
  "psyche",
  "psychic",
  "unconscious",
  "collective unconscious",
  "individuation",
  "persona",
  "shadow",
  "anima",
  "animus",
  "complex",
  "complexes",
  "feeling-toned complex",
  "dream analysis",
  "dream interpretation",
  "dream",
  "dreams",
  "active imagination",
  "symbolic",
  "archetype",
  "archetypes",
  "transference",
  "synchronicity",
  "libido as psychic energy",
];
const DEPTH_PSYCHOLOGY_SYMBOLIC_BRANCH_ADDRS = [
  "WD.0.2.16",
  "WD.0.2.38",
  "WD.0.2.39",
  "WD.0.2.40",
];
const BLOCKCHAIN_WORLD_BRANCH_ADDRS = [
  "WD.0.2.42",
  "WD.0.2.43",
  "WD.0.2.44",
  "WD.0.2.45",
  "WD.0.2.46",
  "WD.0.2.47",
];

function normalizeText(input: DurableOntologyInput): string {
  return [
    input.content,
    input.sourceTitle,
    input.sourceId,
    input.sourceExcerpt,
    ...(input.domains || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreKeywordMatches(text: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (text.includes(keyword.toLowerCase())) score += keyword.includes(" ") ? 3 : 2;
  }
  return score;
}

function selectBestBranch(pyramidId: KnownPyramidId, text: string): {
  branch: OntologyBranchDefinition | null;
  score: number;
} {
  const branches = ONTOLOGY_BRANCHES[pyramidId] || [];
  let bestBranch: OntologyBranchDefinition | null = null;
  let bestScore = 0;
  for (const branch of branches) {
    const branchScore = scoreKeywordMatches(text, [branch.label, ...branch.keywords]);
    if (branchScore > bestScore) {
      bestScore = branchScore;
      bestBranch = branch;
    }
  }
  return { branch: bestBranch, score: bestScore };
}

function selectBestChildBranch(parentAddr: string, text: string): {
  branch: OntologyBranchDefinition | null;
  score: number;
} {
  const branches = ONTOLOGY_CHILD_BRANCHES[parentAddr] || [];
  let bestBranch: OntologyBranchDefinition | null = null;
  let bestScore = 0;
  for (const branch of branches) {
    const branchScore = scoreKeywordMatches(text, [branch.label, ...branch.keywords]);
    if (branchScore > bestScore) {
      bestScore = branchScore;
      bestBranch = branch;
    }
  }
  return { branch: bestBranch, score: bestScore };
}

function findChildBranchByAddr(addr: string): OntologyBranchDefinition | null {
  for (const children of Object.values(ONTOLOGY_CHILD_BRANCHES)) {
    for (const branch of children || []) {
      if (branch.addr === addr) return branch;
    }
  }
  return null;
}

export function findOntologyBranchByAddr(addr: string): OntologyBranchDefinition | null {
  for (const branches of Object.values(ONTOLOGY_BRANCHES)) {
    for (const branch of branches || []) {
      if (branch.addr === addr) return branch;
    }
  }
  return findChildBranchByAddr(addr);
}

function selectBestSpecificChildBranch(addrs: string[], text: string): {
  branch: OntologyBranchDefinition | null;
  score: number;
} {
  let bestBranch: OntologyBranchDefinition | null = null;
  let bestScore = 0;
  for (const addr of addrs) {
    const branch = findChildBranchByAddr(addr);
    if (!branch) continue;
    const branchScore = scoreKeywordMatches(text, [branch.label, ...branch.keywords]);
    if (branchScore > bestScore) {
      bestScore = branchScore;
      bestBranch = branch;
    }
  }
  return { branch: bestBranch, score: bestScore };
}

function chooseLocalPyramid(text: string): { pyramidId: KnownPyramidId; score: number } | null {
  let best: { pyramidId: KnownPyramidId; score: number } | null = null;
  for (const entry of LOCAL_PYRAMID_KEYWORDS) {
    const score = scoreKeywordMatches(text, entry.keywords);
    if (score > 0 && (!best || score > best.score)) {
      best = { pyramidId: entry.pyramidId, score };
    }
  }
  return best;
}

export function suggestDurableOntologyTarget(input: DurableOntologyInput): DurableOntologySuggestion {
  const sourceType = (input.sourceType || "").toLowerCase();
  const nodeType = (input.nodeType || "").toLowerCase();
  const atomType = (input.atomType || "").toUpperCase();
  const atomSubtype = (input.atomSubtype || "").toLowerCase();
  const actionability = Number(input.actionability || 0);
  const text = normalizeText(input);

  const localHit = input.includeLocalPyramids === false ? null : chooseLocalPyramid(text);
  if (localHit && localHit.score >= 3) {
    const { branch, score } = selectBestBranch(localHit.pyramidId, text);
    return {
      pyramidId: localHit.pyramidId,
      parentAddr: branch?.addr || null,
      parentLabel: branch?.label || null,
      selectionReason: `Matched local-system keywords for ${localHit.pyramidId}`,
      keywordScore: Math.max(localHit.score, score),
    };
  }

  let pyramidId: KnownPyramidId;
  let selectionReason: string;
  const blockchainWorldScore = scoreKeywordMatches(text, BLOCKCHAIN_WORLD_KEYWORDS);
  const blockchainSpecific = selectBestSpecificChildBranch(BLOCKCHAIN_WORLD_BRANCH_ADDRS, text);
  const philosophyWorldScore = scoreKeywordMatches(text, PHILOSOPHY_WORLD_KEYWORDS);
  const ethicsPoliticalWorldScore = scoreKeywordMatches(text, ETHICS_POLITICAL_PHILOSOPHY_KEYWORDS);
  const depthPsychologyWorldScore = scoreKeywordMatches(text, DEPTH_PSYCHOLOGY_WORLD_KEYWORDS);
  const depthPsychologySpecific = selectBestSpecificChildBranch(DEPTH_PSYCHOLOGY_SYMBOLIC_BRANCH_ADDRS, text);

  if (
    ethicsPoliticalWorldScore >= 4
    && !FUNCTION_NODE_TYPES.has(nodeType)
    && atomSubtype !== "tool"
    && atomSubtype !== "integration"
  ) {
    return {
      pyramidId: "WORLD",
      parentAddr: "WD.0.2.68",
      parentLabel: "Ethics, Justice & Political Philosophy",
      selectionReason: "Normative philosophy keywords matched the ethics and political philosophy branch",
      keywordScore: ethicsPoliticalWorldScore,
    };
  }

  if (
    philosophyWorldScore >= 4
    && !FUNCTION_NODE_TYPES.has(nodeType)
    && atomSubtype !== "tool"
    && atomSubtype !== "integration"
  ) {
    return {
      pyramidId: "WORLD",
      parentAddr: "WD.0.2.37",
      parentLabel: "Philosophy & Epistemology",
      selectionReason: "Philosophy and epistemology keywords matched a dedicated world branch",
      keywordScore: philosophyWorldScore,
    };
  }

  if (
    depthPsychologyWorldScore >= 4
    && !FUNCTION_NODE_TYPES.has(nodeType)
    && atomSubtype !== "tool"
    && atomSubtype !== "integration"
  ) {
    return {
      pyramidId: "WORLD",
      parentAddr: depthPsychologySpecific.branch?.addr || "WD.0.1.4",
      parentLabel: depthPsychologySpecific.branch?.label || "Minds & Society",
      selectionReason: depthPsychologySpecific.branch
        ? `Depth psychology and symbolic-meaning keywords matched ${depthPsychologySpecific.branch.label}`
        : "Depth psychology keywords matched the minds-and-society branch",
      keywordScore: Math.max(depthPsychologyWorldScore, depthPsychologySpecific.score),
    };
  }

  if (
    blockchainWorldScore >= 4
    && !FUNCTION_NODE_TYPES.has(nodeType)
    && !FUNCTION_SUBTYPES.has(atomSubtype)
    && !FUNCTION_ATOM_TYPES.has(atomType)
    && actionability < 4
  ) {
    return {
      pyramidId: "WORLD",
      parentAddr: blockchainSpecific.branch?.addr || "WD.0.1.5",
      parentLabel: blockchainSpecific.branch?.label || "Institutions & Economy",
      selectionReason: blockchainSpecific.branch
        ? `Blockchain governance and ledger concepts matched ${blockchainSpecific.branch.label}`
        : "Blockchain governance and ledger concepts belong to the World Model",
      keywordScore: Math.max(blockchainWorldScore, blockchainSpecific.score),
    };
  } else if (
    FUNCTION_NODE_TYPES.has(nodeType)
    || FUNCTION_SUBTYPES.has(atomSubtype)
    || FUNCTION_ATOM_TYPES.has(atomType)
    || actionability >= 4
  ) {
    pyramidId = "FUNCTION";
    selectionReason = "Actionable/tooling shape favors Functional Knowledge";
  } else if (WORLD_SOURCE_TYPES.has(sourceType)) {
    pyramidId = "WORLD";
    selectionReason = "Research/reference source defaults into World Model";
  } else if (FUNCTION_SOURCE_TYPES.has(sourceType)) {
    pyramidId = "FUNCTION";
    selectionReason = "Developer/tooling source defaults into Functional Knowledge";
  } else {
    const worldBranch = selectBestBranch("WORLD", text);
    const functionBranch = selectBestBranch("FUNCTION", text);
    if (functionBranch.score >= worldBranch.score + 2 || functionBranch.score >= 4) {
      pyramidId = "FUNCTION";
      selectionReason = "Functional branch keywords dominated content";
    } else {
      pyramidId = "WORLD";
      selectionReason = "World-model branch keywords dominated content";
    }
  }

  const { branch, score } = selectBestBranch(pyramidId, text);
  let finalBranch = branch;
  let finalScore = score;
  let finalReason = selectionReason;
  if ((pyramidId === "FUNCTION" || pyramidId === "WORLD") && branch) {
    const child = selectBestChildBranch(branch.addr, text);
    if (child.branch && child.score >= Math.max(4, score)) {
      finalBranch = child.branch;
      finalScore = child.score;
      finalReason = `${selectionReason}; matched ${pyramidId === "FUNCTION" ? "functional" : "world"} sub-branch ${child.branch.label}`;
    }
  }
  return {
    pyramidId,
    parentAddr: finalBranch?.addr || null,
    parentLabel: finalBranch?.label || null,
    selectionReason: finalReason,
    keywordScore: finalScore,
  };
}

async function firstDepthOneBranch(sql: SqlTag, pyramidId: KnownPyramidId): Promise<{ addr: string; label: string } | null> {
  const [row] = await sql`
    SELECT addr, label
    FROM nodes
    WHERE pyramid_id = ${pyramidId}
      AND depth = 1
      AND visibility <> 'deleted'
    ORDER BY position ASC
    LIMIT 1
  `;
  return row ? { addr: row.addr, label: row.label } : null;
}

export async function resolveDurableOntologyTarget(
  sql: SqlTag,
  input: DurableOntologyInput,
): Promise<DurableOntologySuggestion> {
  const suggestion = suggestDurableOntologyTarget(input);

  if (suggestion.parentAddr) {
    const [row] = await sql`
      SELECT addr, label
      FROM nodes
      WHERE addr = ${suggestion.parentAddr}
        AND pyramid_id = ${suggestion.pyramidId}
        AND visibility <> 'deleted'
      LIMIT 1
    `;
    if (row) {
      return {
        ...suggestion,
        parentAddr: row.addr,
        parentLabel: row.label,
      };
    }
  }

  const selectedFallback = await firstDepthOneBranch(sql, suggestion.pyramidId);
  if (selectedFallback) {
    return {
      ...suggestion,
      parentAddr: selectedFallback.addr,
      parentLabel: selectedFallback.label,
      selectionReason: `${suggestion.selectionReason}; fell back to first depth-1 branch in ${suggestion.pyramidId}`,
    };
  }

  const functionFallback = suggestion.pyramidId !== "FUNCTION"
    ? await firstDepthOneBranch(sql, "FUNCTION")
    : null;
  if (functionFallback) {
    return {
      pyramidId: "FUNCTION",
      parentAddr: functionFallback.addr,
      parentLabel: functionFallback.label,
      selectionReason: `${suggestion.selectionReason}; ${suggestion.pyramidId} is unseeded, fell back to FUNCTION`,
      keywordScore: suggestion.keywordScore,
    };
  }

  // OPENCLAW fallback removed — dissolved into FUNCTION as of 2026-03-20.
  // If we reach here, no depth-1 branches exist in any pyramid.
  throw new Error("No depth-1 ontology branch found. Seed WORLD or FUNCTION first.");
}

// F6 namespace for graph-address advisory locks. Two-arg
// pg_advisory_xact_lock(namespace, lockId) keeps VO's slot locks from
// colliding with other system advisory locks.
const ADDRESS_ALLOC_LOCK_NAMESPACE = 0x564f46; // "VOF"

/**
 * Stable 31-bit hash for the slot-allocation lock id. Two slot spaces
 * with different (prefix, layer, depth) coordinates do NOT serialize
 * against each other; same-coordinate concurrent allocations DO.
 */
function slotAllocationLockId(prefix: string, layer: number, depth: number): number {
  const s = `vo-slot:${prefix}:${layer}:${depth}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) & 0x7fffffff;
}

async function resolveAllocationDepth(
  sql: SqlTag,
  pyramidId: KnownPyramidId,
  parentAddr: string | null,
  defaultDepth: number,
): Promise<number> {
  if (!parentAddr) return defaultDepth;
  const [parent] = await sql`
    SELECT depth
    FROM nodes
    WHERE addr = ${parentAddr}
      AND pyramid_id = ${pyramidId}
      AND visibility <> 'deleted'
    LIMIT 1
  `;
  if (parent) {
    // A child sits one level below its parent. Use `??` (not `||`): a depth-0
    // parent (a pyramid ROOT, e.g. PJ.0.0.1) is a VALID depth — `|| 1` treated
    // it as missing and pushed root children to depth 2, where `listProjects`
    // (depth = 1) could never see them. So a tenant's onboarded default project
    // landed invisible. `?? 1` only substitutes a genuinely null/absent depth.
    const parentDepth = Number(parent.depth ?? 1);
    return Math.max(1, parentDepth + 1);
  }
  return defaultDepth;
}

/**
 * F6: race-safe slot allocator. MUST be called inside a `sql.begin(...)`
 * transaction. The caller's transaction takes a 2-arg
 * pg_advisory_xact_lock keyed on (prefix, layer, depth) so concurrent
 * allocations into the same slot space serialize end-to-end through the
 * caller's eventual INSERT. The lock auto-releases on COMMIT/ROLLBACK.
 *
 * For simple call sites that allocate-then-INSERT in a single
 * transaction, prefer `withAllocatedChildSlot` which wraps the
 * `sql.begin` + 3-attempt retry on PK collision (23505).
 */
export async function allocateChildSlotInTx(
  sql: SqlTag,
  pyramidId: KnownPyramidId,
  parentAddr: string | null,
  opts: { defaultDepth?: number } = {},
): Promise<{ addr: string; depth: number; position: number }> {
  const prefix = PYRAMID_PREFIX_BY_ID[pyramidId];
  const depth = await resolveAllocationDepth(sql, pyramidId, parentAddr, opts.defaultDepth ?? 2);

  const lockId = slotAllocationLockId(prefix, /*layer*/ 0, depth);
  await sql`SELECT pg_advisory_xact_lock(${ADDRESS_ALLOC_LOCK_NAMESPACE}, ${lockId})`;

  const [row] = await sql`
    SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
    FROM (
      SELECT position FROM nodes WHERE pyramid_id = ${pyramidId} AND layer = 0 AND depth = ${depth}
      UNION ALL
      SELECT position FROM staging_nodes
        WHERE pyramid_id = ${pyramidId} AND layer = 0 AND depth = ${depth}
          AND qc_status IN ('pending', 'revised', 'processing')
    ) candidates
  `;
  const position = Number(row?.next_pos || 1);
  return {
    addr: buildAddr(pyramidId, 0, depth, position),
    depth,
    position,
  };
}

/**
 * F6: high-level allocator that wraps `sql.begin(...)` + retry-on-PK-
 * collision. Use this from call sites that allocate then INSERT a
 * single node row in one transaction. The callback receives the tx
 * handle so the INSERT runs under the same advisory lock as the
 * allocation.
 */
export async function withAllocatedChildSlot<T>(
  sql: SqlTag,
  pyramidId: KnownPyramidId,
  parentAddr: string | null,
  callback: (tx: SqlTag, slot: { addr: string; depth: number; position: number }) => Promise<T>,
  opts: { defaultDepth?: number; maxAttempts?: number } = {},
): Promise<T> {
  const attempts = opts.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sql.begin(async (tx: SqlTag) => {
        const slot = await allocateChildSlotInTx(tx, pyramidId, parentAddr, opts);
        return callback(tx, slot);
      });
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "23505" || attempt === attempts) throw err;
    }
  }
  throw new Error(
    `slot_allocation_exhausted: ${attempts} attempts failed for pyramid ${pyramidId} parent ${parentAddr || "null"}: ${(lastErr as Error)?.message || lastErr}`,
  );
}

/**
 * F6 intentionally does not keep the pre-F6 `allocateChildSlot` or
 * `allocateDepthTwoSlot` exports. Returning an allocated addr without
 * forcing the caller's INSERT into the same transaction would release
 * the advisory lock before the write and reintroduce the allocation
 * race. Use `withAllocatedChildSlot(sql, pyramidId, parentAddr, ...)`
 * or `allocateChildSlotInTx(tx, pyramidId, parentAddr)` instead.
 */
