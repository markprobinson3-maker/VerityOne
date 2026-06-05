/**
 * Node-as-Agent: Generate a persona prompt from node substance.
 * Turns static knowledge into a living agent identity.
 */

import { sql } from "../db";

export interface NodePersona {
  addr: string;
  label: string;
  systemPrompt: string;
  personality: string;
  bias: string;
}

export async function generatePersona(addr: string): Promise<NodePersona | null> {
  const [node] = await sql`
    SELECT addr, label, node_type, confidence,
      substance->>'description' AS description,
      substance->'provides' AS provides,
      substance->'quick_start' AS quick_start,
      substance->'readiness' AS readiness,
      substance->'known_failures' AS known_failures,
      source_refs,
      provenance->>'basis' AS basis
    FROM nodes
    WHERE addr = ${addr}
      AND visibility <> 'deleted'`;
  
  if (!node) return null;

  const provides = node.provides ? JSON.parse(JSON.stringify(node.provides)) : [];
  const quickStart = node.quick_start ? JSON.stringify(node.quick_start) : null;
  const knownFailures = node.known_failures ? JSON.stringify(node.known_failures) : null;

  // Derive personality from node type and confidence
  const confidencePersonality = node.confidence > 0.85 
    ? "You speak with authority — your knowledge is well-verified."
    : node.confidence > 0.65 
    ? "You're reasonably confident but open to correction."
    : "You're uncertain about some of your knowledge. Flag what you're unsure about.";

  const typePersonality: Record<string, string> = {
    tool: "You are pragmatic and concrete. You care about commands that work, readiness checks, and real-world gotchas.",
    skill: "You are procedural and careful. You care about the right order of operations and edge cases people miss.",
    workflow: "You think in sequences and dependencies. You care about what breaks when steps are skipped.",
    concept: "You think abstractly but ground your ideas in the nodes you connect to.",
    "anti-pattern": "You are a warning voice. You exist because something went wrong. You are paranoid about recurrence.",
  };

  const personality = typePersonality[node.node_type] || "You contribute your knowledge directly and concisely.";
  
  // Derive operational bias from substance
  const biases: string[] = [];
  if (knownFailures) biases.push("You always warn about known failure modes before recommending action.");
  if (node.basis === "observed") biases.push("Your knowledge comes from direct observation — you trust empirical evidence over theory.");
  if (node.basis === "asserted") biases.push("Your knowledge is asserted but not yet verified — you acknowledge this limitation.");
  if (provides.length > 3) biases.push("You're a generalist with broad capabilities — you connect dots across domains.");
  const bias = biases.join(" ") || "You focus on your area of expertise and defer to others outside it.";

  const systemPrompt = `You are [${node.addr}] ${node.label}, a node-agent in the Verity One knowledge pyramid.

IDENTITY: ${node.description || node.label}
TYPE: ${node.node_type || "concept"} | CONFIDENCE: ${node.confidence} | BASIS: ${node.basis || "unknown"}

${personality}
${confidencePersonality}
${bias}

${provides.length ? `CAPABILITIES: ${provides.join(", ")}` : ""}
${quickStart ? `QUICK START: ${quickStart}` : ""}
${knownFailures ? `⚠ KNOWN FAILURES: ${knownFailures}` : ""}

RULES:
- Speak from YOUR perspective as this specific node. You are not a general assistant.
- If another agent contradicts you, defend your position with evidence from your substance.
- If you genuinely don't know something, say so — don't hallucinate beyond your node's knowledge.
- When you discover a dependency or conflict with another node, name it explicitly as a proposed edge.
- Keep responses to 2-4 sentences per turn. Be direct.`;

  return { addr: node.addr, label: node.label, systemPrompt, personality, bias };
}

/**
 * Batch-generate personas for multiple nodes
 */
export async function generatePersonas(addrs: string[]): Promise<NodePersona[]> {
  const personas: NodePersona[] = [];
  for (const addr of addrs) {
    const p = await generatePersona(addr);
    if (p) personas.push(p);
  }
  return personas;
}
