/**
 * World Ingestor V2 — Stage 2: EXTRACT
 * Flash Lite extraction + KNOWLEDGE/SKILL classification.
 * Handles text splitting, atom validation, post-split dedup, model fallback.
 */

import { loadParams, TEMPORAL_BIAS, type ExtractedAtom } from "./config";
import { callFlashLite } from "../lib/llm";
import { emitWI } from "./events";

type ExtractionSeed = {
  label: string;
  kind: string;
  rationale: string;
};

const DEPTH_PSYCHOLOGY_SOURCE_KEYWORDS = [
  "jung",
  "jungian",
  "analytical psychology",
  "depth psychology",
  "collective unconscious",
  "individuation",
  "persona",
  "shadow",
  "anima",
  "animus",
  "synchronicity",
  "archetype",
  "archetypes",
  "dream analysis",
  "transference",
  "complexes",
  "unconscious",
  "alchemy",
];
const LOW_VALUE_DEPTH_PSYCH_LABELS = new Set([
  "psychology",
  "unconscious",
  "consciousness",
  "dreams",
  "alchemy",
  "psychotherapy",
  "symbolism",
  "transformation",
  "depths",
  "in psychotherapy",
  "in dreams and fairytales",
  "in alchemy",
  "in jungian psychology",
  "in jungian analytical psychology",
]);
const SCHOLARLY_SOURCE_TYPES = new Set(["pdf", "arxiv", "doi"]);

// ============================================================
// EXTRACTION PROMPT
// ============================================================

function buildSeedGuidanceBlock(seeds: ExtractionSeed[]): string {
  if (seeds.length === 0) return "";
  const lines = seeds
    .slice(0, 6)
    .map((seed) => `- ${seed.label} (${seed.kind}): ${seed.rationale}`);
  return `
Core source anchors:
${lines.join("\n")}

Extraction guidance:
- Prefer atoms that define one of these anchors, explain a relation between anchors, or capture a method/doctrine that organizes them.
- Favor fewer deep relational nuggets over many shallow sibling facts.
- If a segment does not materially connect to the listed anchors, extract only clearly central truths rather than filler.
`;
}

function countKeywordHits(text: string, keywords: string[]): number {
  let hits = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) hits += 1;
  }
  return hits;
}

function isDepthPsychologyContext(sourceType: string | undefined, title: string | undefined, atomsOrText: Array<ExtractedAtom> | string): boolean {
  if (!sourceType || !["web", "pdf", "arxiv", "doi"].includes(sourceType)) return false;
  const sourceSignal = [title || ""]
    .concat(typeof atomsOrText === "string" ? atomsOrText : atomsOrText.map((atom) => atom.content))
    .join(" ")
    .toLowerCase();
  return countKeywordHits(sourceSignal, DEPTH_PSYCHOLOGY_SOURCE_KEYWORDS) >= 2;
}

function isScholarlyContext(
  sourceType: string | undefined,
  title: string | undefined,
  atomsOrText: Array<ExtractedAtom> | string,
): boolean {
  if (!sourceType) return false;
  if (SCHOLARLY_SOURCE_TYPES.has(sourceType)) return true;
  if (sourceType !== "web") return false;

  const sourceSignal = [title || ""]
    .concat(typeof atomsOrText === "string" ? atomsOrText : atomsOrText.map((atom) => atom.content))
    .join(" ")
    .toLowerCase();

  return (
    sourceSignal.includes("project gutenberg")
    || sourceSignal.includes("abstract")
    || sourceSignal.includes("doi")
    || sourceSignal.includes("arxiv")
    || /chapter|dialogue|treatise|critique|paper|study|experiment|benchmark|method/i.test(sourceSignal)
  );
}

function buildScholarlyGuidanceBlock(
  sourceType: string | undefined,
  title: string | undefined,
  atomsOrText: Array<ExtractedAtom> | string,
): string {
  if (!isScholarlyContext(sourceType, title, atomsOrText)) return "";
  return `
Scholarly-source guidance:
- Prefer named methods, mechanisms, doctrines, benchmarks, failure modes, architectures, and recurring problem frames over broad survey recap.
- Keep what helps a visiting AI orient, reason, or act; discard paper/book-summary prose that only says a source explores, discusses, or addresses something.
- Avoid bibliographic framing, chapter recap, generic field labels, and top-level overview claims unless they are genuinely canonical anchors.
`;
}

function buildDomainGuidanceBlock(sourceType: string | undefined, title: string | undefined, atomsOrText: Array<ExtractedAtom> | string): string {
  const blocks: string[] = [];

  if (isDepthPsychologyContext(sourceType, title, atomsOrText)) {
    blocks.push(`
Depth-psychology guidance:
- Prefer applied interpretive lenses, recurring psychological patterns, and methods an AI could use for grounded human sensemaking.
- Keep concepts scoped as Jungian or analytical-psychology frames when they are contested or interpretive, not settled empirical fact.
- Favor anchors like individuation, transference, dream amplification, archetypal symbolism, persona, shadow, anima/animus, and collective unconscious over author or volume summaries.
- Avoid bibliographic framing, chapter recap, generic abstractions like "psychology" or "unconscious", and claims that only restate that Carl Jung wrote or developed something.
`);
  }

  const scholarlyGuidance = buildScholarlyGuidanceBlock(sourceType, title, atomsOrText);
  if (scholarlyGuidance) blocks.push(scholarlyGuidance.trim());

  return blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : "";
}

function buildExtractionPrompt(text: string, maxAtoms: number, sourceType?: string, seeds: ExtractionSeed[] = []): string {
  const bias = sourceType ? TEMPORAL_BIAS[sourceType] || "MIXED" : "MIXED";
  const temporalContext = sourceType
    ? `\nSource type: ${sourceType}\nTemporal bias: This source tends toward ${bias} content. Override per-atom if the content clearly differs.\n`
    : "";
  const seedGuidance = buildSeedGuidanceBlock(seeds);
  const domainGuidance = buildDomainGuidanceBlock(sourceType, undefined, text);

  return `You are a knowledge extraction engine for an AI agent knowledge graph.

Analyze this content and extract up to ${maxAtoms} atomic knowledge units. Each unit is either:

1. **KNOWLEDGE** — A factual claim, concept, or insight worth remembering
2. **SKILL** — A technique, workflow, tool usage pattern, or procedure that an AI agent could execute. Skills are ACTIONABLE — they describe HOW to do something, not just WHAT something is.

For each unit provide:
- content: Self-contained description (must make sense without the source)
- type: KNOWLEDGE or SKILL
- subtype: For KNOWLEDGE: claim | framework | signal. For SKILL: technique | workflow | tool | integration
- domains: Array of 1-3 relevant domains (e.g., ["ai-agents", "content-creation"], ["devops", "security"])
- importance: 1-5 (5 = fundamental/reusable, 1 = trivial/niche)
- actionability: 1-5 (5 = an AI agent could execute this right now with the info provided, 1 = purely informational)
- temporality: DURABLE | CURRENT | EPHEMERAL
  - DURABLE: Techniques, frameworks, documentation, architectural patterns. Still true in 6 months.
  - CURRENT: News, releases, announcements, market moves. True today, stale in weeks.
  - EPHEMERAL: Hype cycles, drama, rumors, hot takes, price reactions. True for hours.

Rules:
- Self-contained: reader has NO context about the source
- For SKILL types: include enough detail that an agent could act on it (tool names, API endpoints, key parameters)
- Quality over quantity — ${maxAtoms} max, fewer is fine
- Discard: filler, promotion, opinions without evidence, duplicates of common knowledge
${seedGuidance ? `\n${seedGuidance}` : ""}
${domainGuidance ? `\n${domainGuidance}` : ""}

Return JSON array only.
${temporalContext}
CONTENT:
${text}`;
}

function buildThesisAnchorPrompt(title: string, atoms: ExtractedAtom[], sourceType?: string): string {
  const listedAtoms = atoms
    .slice(0, 8)
    .map((atom, i) => `[${
      i + 1
    }] ${atom.type}/${atom.subtype} importance=${atom.importance} actionability=${atom.actionability}: ${atom.content}`)
    .join("\n");

  return `You are synthesizing thesis anchors for an AI truth layer.

Given the document title and its already-extracted atoms, produce up to 2 canonical durable knowledge anchors that capture the document's central thesis or organizing frame.

Requirements:
- Return only the highest-value thesis anchors, not a restatement of every detail.
- Each anchor must be KNOWLEDGE, not SKILL.
- Prefer claim or framework subtypes.
- These anchors should help downstream graph routing understand the document's center of gravity.
- Do not repeat existing atoms unless you are clearly consolidating them into a stronger canonical statement.
- Keep them self-contained and durable.

Return JSON array only. Each item must include:
- content
- subtype
- domains
- importance
- actionability

Set type to KNOWLEDGE and temporality to DURABLE implicitly.

Source type: ${sourceType || "unknown"}
Title: ${title}

Existing atoms:
${listedAtoms}`;
}

function buildLargeSourceCanopyPrompt(
  title: string | undefined,
  atoms: ExtractedAtom[],
  sourceType: string | undefined,
  maxAtoms: number,
  seeds: ExtractionSeed[] = [],
): string {
  const listedAtoms = atoms
    .slice(0, 120)
    .map((atom, i) => `[${
      i + 1
    }] ${atom.type}/${atom.subtype} importance=${atom.importance} actionability=${atom.actionability} temporality=${atom.temporality}: ${atom.content}`)
    .join("\n");

  const domainGuidance = buildDomainGuidanceBlock(sourceType, title, atoms);
  return `You are consolidating extracted atoms from a very large source into a bounded canopy for an AI truth layer.

Given many candidate atoms from different source segments, return up to ${maxAtoms} canonical atoms that preserve the source's distinct high-value meaning structure.

Requirements:
- Favor distinct doctrines, methods, themes, periods, or frameworks over repeated paraphrases.
- Preserve breadth across the source instead of overfitting to one section.
- Prefer canonical concept anchors that a visiting AI can use to orient quickly.
- Keep claims factual and self-contained.
- Only emit SKILL when the source truly teaches a reusable method or procedure.
- Avoid source-title metadata, editorial framing, or bibliographic trivia unless conceptually central.
- Do not hallucinate; stay within the supplied atoms.
${domainGuidance ? `\n${domainGuidance}` : ""}
${seeds.length > 0 ? `

Core source anchors to preserve:
${seeds.slice(0, 6).map((seed) => `- ${seed.label} (${seed.kind}): ${seed.rationale}`).join("\n")}
` : ""}

Return JSON array only. Each item must include:
- content
- type
- subtype
- domains
- importance
- actionability
- temporality

Source type: ${sourceType || "unknown"}
Title: ${title || "unknown"}

Candidate atoms:
${listedAtoms}`;
}

function normalizeAtomClassification(
  rawType: unknown,
  rawSubtype: unknown,
  content: string,
  actionability: number,
): { type: "KNOWLEDGE" | "SKILL"; subtype: string | null | undefined } {
  const rawNormalizedType = rawType === "SKILL" ? "SKILL" : "KNOWLEDGE";
  const subtype = typeof rawSubtype === "string" ? rawSubtype : undefined;

  const imperativePattern = /^(Implement|Apply|Use|Build|Create|Set|Configure|Deploy|Run|Call|Pass|Send|Generate|Extract|Review|Audit|Route|Integrate|Connect|Query|Update|Write|Install|Start|Stop|Restart)\b/i;
  const declarativePattern = /^(The |This |These |[A-Z][A-Za-z0-9-]*(?:-[A-Za-z0-9]+)*\s+(introduces|is|are|uses|transforms|offers|provides|achieves|enables|represents|describes|generalizes|shows|demonstrates)\b)/i;
  const proceduralKnowledgePattern = /^(To\s+\w+|Construct(?:ing)?\s+\w+|Develop(?:ing)?\s+\w+|When\s+analyzing\b)/i;

  if (rawNormalizedType !== "SKILL") {
    if (proceduralKnowledgePattern.test(content) && actionability >= 2) {
      return { type: "SKILL", subtype: "workflow" };
    }
    return { type: rawNormalizedType, subtype };
  }

  if (!imperativePattern.test(content) && (declarativePattern.test(content) || actionability <= 3)) {
    return { type: "KNOWLEDGE", subtype: "claim" };
  }

  return { type: rawNormalizedType, subtype };
}

const THESIS_ANCHOR_SOURCE_TYPES = new Set(["pdf", "arxiv", "doi"]);

function normalizeContentKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isLowValueDepthPsychologyAtom(content: string): boolean {
  const normalized = normalizeContentKey(content);
  if (LOW_VALUE_DEPTH_PSYCH_LABELS.has(normalized)) return true;
  if (/collected works|editorial preface|table of contents|general bibliography|translated by|bollingen/i.test(content)) return true;
  if (/^carl jung(?:'s)?\b/i.test(content)) return true;
  if (/^analytical psychology, developed by carl jung\b/i.test(content)) return true;
  if (/^carl jung proposed that\b/i.test(content)) return true;
  if (/^in carl jung'?s\b/i.test(content)) return true;
  if (/^this (claim|framework)\b/i.test(content)) return true;
  if (/\bcollected works\b|\bvol(?:ume)?\.?\s*\d+\b/i.test(content)) return true;
  return false;
}

function isLowValueScholarlyAtom(content: string): boolean {
  if (/^(This|The)\s+(paper|article|book|chapter|study|work)\b/i.test(content)) return true;
  if (/^To address challenges in\b/i.test(content)) return true;
  if (/^Current benchmarks\b/i.test(content)) return true;
  if (/^[A-Z][A-Za-z.'’_-]+(?:\s+[A-Z][A-Za-z.'’_-]+){0,3}'s\s+['"][^'"]+['"]\s+(explores|examines|discusses|presents|argues|delves into)\b/i.test(content)) return true;
  return false;
}

function filterLargeSourceAtoms(title: string | undefined, sourceType: string | undefined, atoms: ExtractedAtom[]): ExtractedAtom[] {
  const depthPsych = isDepthPsychologyContext(sourceType, title, atoms);
  const scholarly = isScholarlyContext(sourceType, title, atoms);
  if (!depthPsych && !scholarly) return atoms;
  const filtered = atoms.filter((atom) => {
    if (atom.type !== "KNOWLEDGE") return true;
    if (depthPsych && isLowValueDepthPsychologyAtom(atom.content)) return false;
    if (scholarly && isLowValueScholarlyAtom(atom.content)) return false;
    return true;
  });
  return filtered.length >= Math.max(2, Math.ceil(atoms.length / 2)) ? filtered : atoms;
}

function shouldGenerateThesisAnchors(sourceType: string | undefined, atoms: ExtractedAtom[], title?: string): boolean {
  if (!sourceType) return false;
  const durableKnowledgeAtoms = atoms.filter((atom) => atom.type === "KNOWLEDGE" && atom.temporality === "DURABLE");
  if (THESIS_ANCHOR_SOURCE_TYPES.has(sourceType)) {
    return durableKnowledgeAtoms.length >= 4;
  }

  if (sourceType === "web") {
    const lowerTitle = (title || "").toLowerCase();
    const philosophySignal =
      lowerTitle.includes("project gutenberg")
      || durableKnowledgeAtoms.some((atom) =>
        /(philosophy|epistem|metaphys|consciousness|reason|truth|a priori|a posteriori|semantic conception|liar)/i.test(atom.content)
      );
    const allDurable = atoms.every((atom) => atom.temporality === "DURABLE");
    return philosophySignal && allDurable && durableKnowledgeAtoms.length >= 5;
  }

  return false;
}

function shouldGenerateEntitySeeds(sourceType: string | undefined, partCount: number, title?: string): boolean {
  if (!sourceType) return false;
  if (sourceType === "github") return partCount >= 3;
  if (["pdf", "arxiv", "doi"].includes(sourceType)) return partCount >= 4;
  if (sourceType === "web") {
    const lowerTitle = (title || "").toLowerCase();
    return partCount >= 4 || lowerTitle.includes("project gutenberg");
  }
  return false;
}

function shouldGenerateLargeSourceCanopy(sourceType: string | undefined, partCount: number, atoms: ExtractedAtom[]): boolean {
  if (!sourceType) return false;
  if (partCount < 8) return false;
  if (!["pdf", "arxiv", "doi", "web", "github"].includes(sourceType)) return false;
  return atoms.length >= 12;
}

function resolveEffectiveMaxAtoms(baseMaxAtoms: number, sourceType: string | undefined, partCount: number): number {
  if (!sourceType || partCount < 8) return baseMaxAtoms;
  if (!["pdf", "arxiv", "doi", "web", "github"].includes(sourceType)) return baseMaxAtoms;
  const expansion = Math.min(12, Math.ceil(Math.log2(partCount)) * 2);
  return Math.min(24, Math.max(baseMaxAtoms, baseMaxAtoms + expansion));
}

function validateThesisAnchor(raw: any): ExtractedAtom | null {
  const atom = validateAtom({
    ...raw,
    type: "KNOWLEDGE",
    temporality: "DURABLE",
  });
  if (!atom) return null;

  if (/^(To\s+\w+|Developing\s+\w+|Using\s+\w+|Construct(?:ing)?\s+\w+)/i.test(atom.content)) {
    return null;
  }

  return {
    ...atom,
    type: "KNOWLEDGE",
    subtype: atom.subtype === "signal" ? "claim" : atom.subtype,
    temporality: "DURABLE",
    importance: Math.max(5, atom.importance),
    actionability: Math.min(atom.actionability, 2),
  };
}

async function extractThesisAnchors(
  title: string | undefined,
  atoms: ExtractedAtom[],
  runId: string,
  sourceType?: string,
  useFallback = false,
): Promise<ExtractedAtom[]> {
  if (!title || !shouldGenerateThesisAnchors(sourceType, atoms, title)) return [];

  const prompt = buildThesisAnchorPrompt(title, atoms, sourceType);

  let raw: string;
  try {
    raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 1024 }, useFallback);
  } catch (err: any) {
    if (!useFallback && (err.message?.includes("429") || err.message?.includes("timeout") || err.message?.includes("LLM error"))) {
      console.warn(`[WI] Thesis anchor extraction failed, retrying with fallback model: ${err.message}`);
      return extractThesisAnchors(title, atoms, runId, sourceType, true);
    }
    throw err;
  }

  let parsed: any[];
  try {
    const cleaned = raw.trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [parsed];
  } catch {
    if (!useFallback) {
      console.warn("[WI] Thesis anchor JSON parse failed, retrying with fallback model");
      return extractThesisAnchors(title, atoms, runId, sourceType, true);
    }
    throw new Error(`Failed to parse thesis anchor response as JSON: ${raw.slice(0, 200)}`);
  }

  const anchors: ExtractedAtom[] = [];
  for (const item of parsed.slice(0, 2)) {
    const anchor = validateThesisAnchor(item);
    if (anchor) anchors.push(anchor);
  }

  return anchors;
}

async function consolidateLargeSourceAtoms(
  title: string | undefined,
  atoms: ExtractedAtom[],
  sourceType: string | undefined,
  maxAtoms: number,
  seeds: ExtractionSeed[] = [],
  useFallback = false,
): Promise<ExtractedAtom[]> {
  if (!title || atoms.length === 0) return atoms;

  const prompt = buildLargeSourceCanopyPrompt(title, atoms, sourceType, maxAtoms, seeds);
  let raw: string;
  try {
    raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.15, maxTokens: 3072 }, useFallback);
  } catch (err: any) {
    if (!useFallback && (err.message?.includes("429") || err.message?.includes("timeout") || err.message?.includes("LLM error"))) {
      console.warn(`[WI] Large-source canopy pass failed, retrying with fallback model: ${err.message}`);
      return consolidateLargeSourceAtoms(title, atoms, sourceType, maxAtoms, seeds, true);
    }
    throw err;
  }

  let parsed: any[];
  try {
    const cleaned = raw.trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [parsed];
  } catch {
    if (!useFallback) {
      console.warn("[WI] Large-source canopy JSON parse failed, retrying with fallback model");
      return consolidateLargeSourceAtoms(title, atoms, sourceType, maxAtoms, seeds, true);
    }
    throw new Error(`Failed to parse large-source canopy response as JSON: ${raw.slice(0, 200)}`);
  }

  const condensed: ExtractedAtom[] = [];
  for (const item of parsed.slice(0, maxAtoms)) {
    const atom = validateAtom(item);
    if (atom) condensed.push(atom);
  }

  if (condensed.length < Math.min(4, Math.ceil(maxAtoms / 3))) {
    throw new Error(`Large-source canopy returned too few valid atoms: ${condensed.length}`);
  }

  return condensed;
}

function sampleSeedParts(textParts: string[], maxParts = 6, maxCharsPerPart = 3000): string[] {
  if (textParts.length <= maxParts) {
    return textParts
      .map((part) => part.slice(0, maxCharsPerPart).trim())
      .filter(Boolean);
  }

  const picks = new Set<number>([0, textParts.length - 1]);
  const slots = maxParts - picks.size;
  for (let i = 1; i <= slots; i++) {
    const ratio = i / (slots + 1);
    picks.add(Math.min(textParts.length - 1, Math.max(0, Math.floor(ratio * (textParts.length - 1)))));
  }

  return [...picks]
    .sort((a, b) => a - b)
    .map((index) => textParts[index]?.slice(0, maxCharsPerPart).trim())
    .filter(Boolean) as string[];
}

function buildEntitySeedPrompt(
  title: string | undefined,
  sourceType: string | undefined,
  sampledParts: string[],
): string {
  const partsBlock = sampledParts
    .map((part, index) => `## Source segment ${index + 1}\n${part}`)
    .join("\n\n");

  return `You are identifying the core organizing anchors of a large source before detailed knowledge extraction.

Return up to 6 source anchors that should guide extraction. Prefer:
- major entities, concepts, doctrines, subsystems, methods, or recurring problem frames
- anchors that will help extract relationships, not just topics
- stable, reusable names rather than sentence fragments

For each anchor return JSON with:
- label
- kind
- rationale

Rules:
- Keep labels atomic and concise.
- Avoid generic labels like "Overview", "Introduction", "Repository", "Philosophy".
- For code repositories, prefer subsystems/interfaces/workflows over file names.
- For long philosophical/scientific works, prefer doctrines/problems/methods/figures over chapter titles.
- Return JSON array only.

Source type: ${sourceType || "unknown"}
Title: ${title || "unknown"}

Representative source segments:
${partsBlock}`;
}

function validateEntitySeed(raw: any): ExtractionSeed | null {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (label.length < 3 || label.length > 120) return null;
  if (rationale.length < 12 || rationale.length > 240) return null;
  if (/^(overview|introduction|repository|project|chapter|section)$/i.test(label)) return null;
  return {
    label,
    kind: kind || "concept",
    rationale,
  };
}

async function extractEntitySeeds(
  textParts: string[],
  title: string | undefined,
  sourceType: string | undefined,
  useFallback = false,
): Promise<ExtractionSeed[]> {
  const sampledParts = sampleSeedParts(textParts);
  if (sampledParts.length === 0) return [];

  const prompt = buildEntitySeedPrompt(title, sourceType, sampledParts);
  let raw: string;
  try {
    raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.1, maxTokens: 1024 }, useFallback);
  } catch (err: any) {
    if (!useFallback && (err.message?.includes("429") || err.message?.includes("timeout") || err.message?.includes("LLM error"))) {
      console.warn(`[WI] Entity seed pass failed, retrying with fallback model: ${err.message}`);
      return extractEntitySeeds(textParts, title, sourceType, true);
    }
    throw err;
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(raw.trim());
    if (!Array.isArray(parsed)) parsed = [parsed];
  } catch {
    if (!useFallback) {
      console.warn("[WI] Entity seed JSON parse failed, retrying with fallback model");
      return extractEntitySeeds(textParts, title, sourceType, true);
    }
    throw new Error(`Failed to parse entity seed response as JSON: ${raw.slice(0, 200)}`);
  }

  const seeds: ExtractionSeed[] = [];
  const seen = new Set<string>();
  for (const item of parsed.slice(0, 8)) {
    const seed = validateEntitySeed(item);
    if (!seed) continue;
    const key = normalizeContentKey(seed.label);
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push(seed);
  }
  return seeds.slice(0, 6);
}

function mergeThesisAnchors(existingAtoms: ExtractedAtom[], anchors: ExtractedAtom[]): ExtractedAtom[] {
  if (anchors.length === 0) return existingAtoms;
  const seen = new Set(existingAtoms.map((atom) => normalizeContentKey(atom.content)));
  const merged = [...existingAtoms];
  for (const anchor of anchors) {
    const key = normalizeContentKey(anchor.content);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(anchor);
  }
  return merged;
}

// ============================================================
// ATOM VALIDATION (B5)
// ============================================================

function validateAtom(raw: any): ExtractedAtom | null {
  if (!raw || typeof raw !== "object") return null;

  const content = typeof raw.content === "string" ? raw.content.trim() : null;
  if (!content || content.length < 20 || content.length > 500) return null;

  const actionability = Math.round(Math.max(1, Math.min(5, Number(raw.actionability) || 1)));
  const normalized = normalizeAtomClassification(raw.type, raw.subtype, content, actionability);
  const type = normalized.type;
  if (type !== "KNOWLEDGE" && type !== "SKILL") return null;

  const validSubtypes = type === "KNOWLEDGE"
    ? ["claim", "framework", "signal"]
    : ["technique", "workflow", "tool", "integration"];
  const subtype = validSubtypes.includes(normalized.subtype || "") ? normalized.subtype : validSubtypes[0];

  const importance = Math.round(Math.max(1, Math.min(5, Number(raw.importance) || 3)));

  const domains = Array.isArray(raw.domains) ? raw.domains.filter((d: any) => typeof d === "string").slice(0, 3) : [];

  const validTemporalities = ["DURABLE", "CURRENT", "EPHEMERAL"];
  const temporality = validTemporalities.includes(raw.temporality) ? raw.temporality : "DURABLE";

  return { content, type: type as any, subtype: subtype as any, domains, importance, actionability, temporality };
}

// ============================================================
// COSINE SIMILARITY (for post-split dedup)
// ============================================================

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// EXTRACT — call Flash Lite, validate, dedup
// ============================================================

async function extractFromText(
  text: string,
  maxAtoms: number,
  runId: string,
  sourceType?: string,
  seeds: ExtractionSeed[] = [],
  useFallback = false,
): Promise<ExtractedAtom[]> {
  const prompt = buildExtractionPrompt(text, maxAtoms, sourceType, seeds);

  let raw: string;
  try {
    raw = await callFlashLite(prompt, { jsonMode: true, temperature: 0.2, maxTokens: 4096 }, useFallback);
  } catch (err: any) {
    // A7: fallback on HTTP error, timeout, rate limit
    if (!useFallback && (err.message?.includes("429") || err.message?.includes("timeout") || err.message?.includes("LLM error"))) {
      console.warn(`[WI] Flash Lite failed, retrying with fallback model: ${err.message}`);
      return extractFromText(text, maxAtoms, runId, sourceType, seeds, true);
    }
    throw err;
  }

  // Parse JSON
  let parsed: any[];
  try {
    const cleaned = raw.trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [parsed];
  } catch {
    // JSON parse failure → retry with fallback
    if (!useFallback) {
      console.warn("[WI] JSON parse failed, retrying with fallback model");
      return extractFromText(text, maxAtoms, runId, sourceType, seeds, true);
    }
    throw new Error(`Failed to parse extraction response as JSON: ${raw.slice(0, 200)}`);
  }

  // Validate atoms
  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    const atom = validateAtom(item);
    if (atom) atoms.push(atom);
  }

  // B5: If >50% fail validation, retry with fallback
  if (atoms.length < parsed.length * 0.5 && parsed.length > 0 && !useFallback) {
    console.warn(`[WI] ${atoms.length}/${parsed.length} atoms valid — retrying with fallback`);
    return extractFromText(text, maxAtoms, runId, sourceType, seeds, true);
  }

  return atoms;
}

function resolveAtomsPerPart(partCount: number, maxAtoms: number): number {
  if (partCount <= 1) return maxAtoms;
  const budget = Math.ceil((maxAtoms * 2) / partCount);
  return Math.max(2, Math.min(7, budget));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

// ============================================================
// PUBLIC API
// ============================================================

export async function extract(textParts: string[], runId: string, sourceType?: string, title?: string): Promise<ExtractedAtom[]> {
  const params = await loadParams();
  const effectiveMaxAtoms = resolveEffectiveMaxAtoms(params.maxAtoms, sourceType, textParts.length);
  const seeds = shouldGenerateEntitySeeds(sourceType, textParts.length, title)
    ? await extractEntitySeeds(textParts, title, sourceType).catch((err) => {
        console.warn(`[WI] Entity seed pass skipped: ${err.message}`);
        return [];
      })
    : [];

  let allAtoms: ExtractedAtom[];

  if (textParts.length === 1) {
    // Single text — request up to maxAtoms
    allAtoms = await extractFromText(textParts[0], effectiveMaxAtoms, runId, sourceType, seeds);
  } else {
    // Split text — keep part budgets small and bound concurrency for very large multipart sources.
    const atomsPerPart = resolveAtomsPerPart(textParts.length, effectiveMaxAtoms);
    const concurrency = textParts.length >= 12 ? 2 : textParts.length >= 6 ? 3 : 4;
    const results = await mapWithConcurrency(
      textParts,
      concurrency,
      (part) => extractFromText(part, atomsPerPart, runId, sourceType, seeds),
    );
    allAtoms = results.flat();
  }

  const thesisAnchors = await extractThesisAnchors(title, allAtoms, runId, sourceType).catch((err) => {
    console.warn(`[WI] Thesis anchor pass skipped: ${err.message}`);
    return [];
  });
  allAtoms = mergeThesisAnchors(allAtoms, thesisAnchors);

  if (shouldGenerateLargeSourceCanopy(sourceType, textParts.length, allAtoms)) {
    allAtoms = await consolidateLargeSourceAtoms(title, allAtoms, sourceType, effectiveMaxAtoms, seeds).catch((err) => {
      console.warn(`[WI] Large-source canopy pass skipped: ${err.message}`);
      return allAtoms;
    });
  }

  allAtoms = filterLargeSourceAtoms(title, sourceType, allAtoms);

  // Emit events for each atom
  for (let i = 0; i < allAtoms.length; i++) {
    const atom = allAtoms[i];
    emitWI("atom_extracted", runId, {
      index: i,
      content: atom.content,
      type: atom.type,
      subtype: atom.subtype,
      importance: atom.importance,
      actionability: atom.actionability,
      temporality: atom.temporality,
    });
  }

  // Cap at maxAtoms, sorted by importance descending
  allAtoms.sort((a, b) => b.importance - a.importance);
  if (allAtoms.length > effectiveMaxAtoms) {
    allAtoms = allAtoms.slice(0, effectiveMaxAtoms);
  }

  return allAtoms;
}

/**
 * Extract with post-split dedup using embeddings.
 * Called after embeddings are computed (in route.ts).
 */
export function deduplicateAtoms(atoms: ExtractedAtom[], maxAtoms: number): ExtractedAtom[] {
  if (atoms.length <= 1) return atoms;

  // Check each pair for cosine > 0.90, keep higher importance
  const keep = new Set(atoms.map((_, i) => i));

  for (let i = 0; i < atoms.length; i++) {
    if (!keep.has(i) || !atoms[i].embedding) continue;
    for (let j = i + 1; j < atoms.length; j++) {
      if (!keep.has(j) || !atoms[j].embedding) continue;
      const sim = cosine(atoms[i].embedding!, atoms[j].embedding!);
      if (sim > 0.90) {
        // Remove the lower-importance one
        if (atoms[i].importance >= atoms[j].importance) {
          keep.delete(j);
        } else {
          keep.delete(i);
          break;
        }
      }
    }
  }

  const result = atoms.filter((_, i) => keep.has(i));
  result.sort((a, b) => b.importance - a.importance);
  return result.slice(0, maxAtoms);
}

export const __testables = {
  resolveEffectiveMaxAtoms,
  shouldGenerateLargeSourceCanopy,
  shouldGenerateEntitySeeds,
  resolveAtomsPerPart,
  sampleSeedParts,
  normalizeAtomClassification,
  shouldGenerateThesisAnchors,
  mergeThesisAnchors,
  validateThesisAnchor,
  isDepthPsychologyContext,
  isScholarlyContext,
  filterLargeSourceAtoms,
};
