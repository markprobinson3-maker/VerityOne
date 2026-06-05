import { findOntologyBranchByAddr, ONTOLOGY_PYRAMIDS } from "./ontology";

type OntologyGuidance = {
  description: string;
  why_it_matters: string;
  ask_when: string[];
  action_hint: string;
  confidence_posture: string;
  hallucination_guard: string[];
  query_hints: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function trimmedKeywords(addr: string): string[] {
  const branch = findOntologyBranchByAddr(addr);
  return unique((branch?.keywords || []).slice(0, 6));
}

function describeOntologyBranch(addr: string, branchLabel: string, pyramidId: string, keywords: string[]): string {
  const hints = keywords.slice(0, 3);
  if (pyramidId === "FUNCTION") {
    const suffix = hints.length > 0 ? ` It is the action branch for ${hints.join(", ")}.` : " It is an action branch for reusable execution patterns.";
    return `${branchLabel} is a functional ontology branch that helps an agent choose and apply the right operational move.${suffix}`;
  }
  const suffix = hints.length > 0 ? ` It grounds claims about ${hints.join(", ")} before action is chosen.` : " It grounds claims about the world before action is chosen.";
  return `${branchLabel} is a world ontology branch that helps an agent anchor facts, constraints, and causal structure.${suffix}`;
}

const GUIDANCE_OVERRIDES: Record<string, Partial<OntologyGuidance>> = {
  "WD.0.2.42": {
    action_hint: "Use this to frame upgrade authority, amendment mechanics, and governance-process design before choosing workflow steps.",
  },
  "WD.0.2.43": {
    action_hint: "Use this when a task involves voting flow, proposal handling, forks, or social coordination around protocol change.",
  },
  "WD.0.2.44": {
    action_hint: "Use this to reason about delegation, collective decision flow, and multi-party coordination before execution planning.",
  },
  "WD.0.2.45": {
    action_hint: "Use this to evaluate capture risk, quorum, token-weight bias, and incentive failure before trusting governance output.",
  },
  "WD.0.2.46": {
    action_hint: "Use this to surface legal/reporting constraints before designing DAO operations, payout logic, or compliance workflows.",
  },
  "WD.0.2.47": {
    action_hint: "Use this to ground smart-contract state, validators, staking, and ledger execution before touching operational state flows.",
  },
  "FN.0.2.7": {
    action_hint: "Use this when you already understand the domain and need to coordinate handoffs, sequencing, delegates, or proposal execution.",
  },
  "FN.0.2.8": {
    action_hint: "Use this when the main need is choosing among tradeoffs, strategy branches, or governance alternatives.",
  },
  "FN.0.2.19": {
    action_hint: "Use this when the task involves auditability, governance controls, reporting, or policy-constrained execution.",
  },
  "FN.0.2.24": {
    action_hint: "Use this when shaping prompts, schemas, agent instructions, or AI-facing interfaces from grounded knowledge.",
  },
};

export function ontologyGuidanceFor(addr: string): OntologyGuidance | null {
  const branch = findOntologyBranchByAddr(addr);
  if (!branch) return null;
  const pyramidId = addr.startsWith("FN.") ? "FUNCTION" : addr.startsWith("WD.") ? "WORLD" : null;
  if (!pyramidId) return null;

  const keywords = trimmedKeywords(addr);
  const topKeywords = keywords.slice(0, 3);
  const base: OntologyGuidance = pyramidId === "FUNCTION"
    ? {
        description: describeOntologyBranch(addr, branch.label, pyramidId, keywords),
        why_it_matters: `${branch.label} helps an agent turn understanding into execution in a narrow, reusable way.`,
        ask_when: unique([
          `Use when the task is primarily about ${topKeywords.join(", ") || branch.label.toLowerCase()}.`,
          "Use when the outcome should be executable, procedural, or directly operational.",
        ]),
        action_hint: `Prefer this branch when the next step should become a tool choice, workflow, runbook, or concrete change.`,
        confidence_posture: "Prefer verified procedures, observable system state, and concrete constraints over broad abstraction.",
        hallucination_guard: [
          "Do not treat a functional branch as evidence that a real-world fact is true; verify the world claim separately.",
          "Do not infer tool availability, credentials, or runtime readiness unless the graph or host checks confirm it.",
        ],
        query_hints: keywords,
      }
    : {
        description: describeOntologyBranch(addr, branch.label, pyramidId, keywords),
        why_it_matters: `${branch.label} grounds what is true, constrained, or meaningfully real before action is chosen.`,
        ask_when: unique([
          `Use when the task depends on facts about ${topKeywords.join(", ") || branch.label.toLowerCase()}.`,
          "Use when the main problem is truth, causality, incentives, cognition, or external constraints.",
        ]),
        action_hint: "Use this to ground the situation first, then follow bridge edges into the matching functional branch.",
        confidence_posture: "Prefer cited, empirical, or historically grounded claims; treat abstractions as guidance, not proof.",
        hallucination_guard: [
          "Do not present unsettled world claims as settled fact without evidence.",
          "Do not jump from world description to operational recommendation without crossing into a FUNCTION branch.",
        ],
        query_hints: keywords,
      };

  return {
    ...base,
    ...GUIDANCE_OVERRIDES[addr],
    ask_when: unique([...(base.ask_when || []), ...((GUIDANCE_OVERRIDES[addr]?.ask_when as string[] | undefined) || [])]),
    hallucination_guard: unique([...(base.hallucination_guard || []), ...((GUIDANCE_OVERRIDES[addr]?.hallucination_guard as string[] | undefined) || [])]),
    query_hints: unique([...(base.query_hints || []), ...((GUIDANCE_OVERRIDES[addr]?.query_hints as string[] | undefined) || [])]),
  };
}

export function applyOntologyGuidanceToSubstance(addr: string, substance: Record<string, unknown> | null | undefined) {
  const guidance = ontologyGuidanceFor(addr);
  if (!guidance) return substance || {};
  return {
    ...(substance || {}),
    ...guidance,
  };
}

export function ontologyGuidanceSummary(addr: string) {
  const guidance = ontologyGuidanceFor(addr);
  if (!guidance) return null;
  return {
    description: guidance.description,
    why_it_matters: guidance.why_it_matters,
    action_hint: guidance.action_hint,
    confidence_posture: guidance.confidence_posture,
    ask_when: guidance.ask_when,
  };
}

export function ontologyPyramidSummary(pyramidId: keyof typeof ONTOLOGY_PYRAMIDS) {
  return ONTOLOGY_PYRAMIDS[pyramidId];
}
