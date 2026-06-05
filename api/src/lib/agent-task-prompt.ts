export type AgentTaskModeHint = "default" | "action" | "debug" | "governance" | "gap";

export type DistilledAgentTaskPrompt = {
  original: string;
  retrievalQuery: string;
  coreTopic: string;
  wrapperDetected: boolean;
  changed: boolean;
  sourceHint: string | null;
  modeHint: AgentTaskModeHint;
};

const BRAND_NEW_AGENT_PREFIX = /^You are a brand-new agent using Verity One for the first time\.\s*/i;
const QUOTED_TOPIC_PATTERN = /^A (current technical item|current platform change|current infrastructure topic|current security or edge-infrastructure item|recent research topic) is "([^"]+)"\.\s*/i;
const USE_VO_INSTRUCTION_PATTERN = /^Use VO[^.?!]*[.?!]\s*/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimSentence(text: string): string {
  return normalizeWhitespace(text).replace(/[.?!]+$/g, "").trim();
}

function sourceHintFor(sourceLabel: string | null): string | null {
  const normalized = (sourceLabel || "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("technical item")) return "operational engineering guidance";
  if (normalized.includes("platform change")) return "platform implementation follow-up";
  if (normalized.includes("infrastructure topic")) return "runtime deployment guidance";
  if (normalized.includes("security or edge-infrastructure item")) return "security operations incident response";
  if (normalized.includes("research topic")) return "research grounding actionable implications";
  return null;
}

function classifyModeHint(text: string): { modeHint: AgentTaskModeHint; retrievalHint: string | null } {
  if (/focus on the fastest useful next step/i.test(text)) {
    return { modeHint: "action", retrievalHint: "fastest useful next step implementation runbook" };
  }
  if (/treat this as a debugging problem/i.test(text)) {
    return { modeHint: "debug", retrievalHint: "debugging failure modes auth mismatches runtime bottlenecks" };
  }
  if (/treat this as a governance and safety question/i.test(text)) {
    return { modeHint: "governance", retrievalHint: "governance provenance review policy publication risks" };
  }
  if (/your job is to test vo's limits/i.test(text)) {
    return { modeHint: "gap", retrievalHint: "coverage gaps missing knowledge low confidence" };
  }
  return { modeHint: "default", retrievalHint: null };
}

export function distillAgentTaskPrompt(prompt: string): DistilledAgentTaskPrompt {
  const original = normalizeWhitespace(prompt || "");
  if (!original) {
    return {
      original: "",
      retrievalQuery: "",
      coreTopic: "",
      wrapperDetected: false,
      changed: false,
      sourceHint: null,
      modeHint: "default",
    };
  }

  let remainder = original;
  let wrapperDetected = false;
  let sourceLabel: string | null = null;
  let topic: string | null = null;

  if (BRAND_NEW_AGENT_PREFIX.test(remainder)) {
    wrapperDetected = true;
    remainder = remainder.replace(BRAND_NEW_AGENT_PREFIX, "");
  }

  const topicMatch = remainder.match(QUOTED_TOPIC_PATTERN);
  if (topicMatch) {
    wrapperDetected = true;
    sourceLabel = topicMatch[1] || null;
    topic = topicMatch[2] || null;
    remainder = remainder.slice(topicMatch[0].length);
  }

  if (topic) {
    remainder = remainder.replace(USE_VO_INSTRUCTION_PATTERN, "");
  }

  const coreTopic = trimSentence(topic || remainder || original) || original;
  const sourceHint = sourceHintFor(sourceLabel);
  const { modeHint, retrievalHint } = classifyModeHint(original);
  const parts = [coreTopic];
  if (topic && sourceHint) parts.push(sourceHint);
  if (retrievalHint) parts.push(retrievalHint);
  const retrievalQuery = parts.map(trimSentence).filter(Boolean).join(". ") || original;

  return {
    original,
    retrievalQuery,
    coreTopic,
    wrapperDetected,
    changed: retrievalQuery !== original,
    sourceHint,
    modeHint,
  };
}
