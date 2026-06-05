/**
 * World Ingestor V2 — Stage 3: ROUTE
 * Embed, vector search, parallel dedup, routing LLM, per-atom writes.
 */

import { sql, loadParams, SOURCE_REGISTRY, type ExtractedAtom, type EnrichedAtom, type RoutedAtom, type WIRunResult, type WIParams, type SourceProfile } from "./config";
import { embedBatch, toVectorStr } from "@verity-one/embed";
import { nodeTypeForWiAtom, slugifyLabel } from "@verity-one/graph-shape";
import {
  resolveDurableOntologyTarget,
  withAllocatedChildSlot,
  suggestDurableOntologyTarget,
  type DurableOntologySuggestion,
} from "../../../api/src/lib/ontology";
import { evaluatePublicGrounding } from "../../../api/src/lib/public-grounding";
import { deriveSourceRefs } from "../../../api/src/lib/source-refs";
import { callFlashLite } from "../lib/llm";
import { deduplicateAtoms } from "./extract";
import { emitWI } from "./events";
import { finalizeWISourceHistory } from "./source-history";
import { autoReviewSkills } from "./skills";
import { attachOrphanToTrendPool } from "../trends/service";

// ============================================================
// ROUTING PROMPT
// ============================================================

function buildRoutingPrompt(atomsWithNeighbors: string): string {
  return `You are routing knowledge atoms into a graph. For each atom, given its nearest existing nodes, decide:

- **NEW_NODE** — Novel enough to become a new node in the knowledge graph
- **HEAT** — Reinforces/updates an existing node (apply as stimulus)
- **SKILL_PROPOSAL** — Describes an actionable skill an AI agent should learn (goes to skill review queue)
- **DROP** — Too generic, already well-covered, or low value

Atoms:
${atomsWithNeighbors}

For each atom return: { index, route, reason (one sentence), target_node (if HEAT) }
Return JSON array only.`;
}

// ============================================================
// SKILL DRAFT PROMPT
// ============================================================

function buildSkillDraftPrompt(atomContent: string, sourceUrl: string): string {
  return `Convert this skill description into an AgentSkill SKILL.md file.
Include: name, description, step-by-step instructions, tool names, key parameters, and example usage.
Keep it under 100 lines. Be specific and actionable.

SKILL: ${atomContent}
SOURCE: ${sourceUrl}`;
}

// ============================================================
// COSINE SIMILARITY
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
// TEMPORAL HALFLIFE
// ============================================================

function getTemporalHalflife(atom: RoutedAtom, params: WIParams, profile: SourceProfile): number {
  switch (atom.temporality) {
    case "EPHEMERAL": return params.halflifeEphemeralHours;
    case "CURRENT":   return params.halflifeCurrentHours;
    case "DURABLE":   return params.halflifeDurableHours;
    default:          return profile.default_halflife_hours;
  }
}

interface NeighborCandidate {
  addr: string;
  label: string;
  similarity: number;
  pyramidId: string | null;
  parentAddr: string | null;
  locality: "global" | "ontology";
}

async function reinforceDurableHeatTarget(targetAddr: string, opts: RouteOptions): Promise<void> {
  const [targetNode] = await sql`
    SELECT addr, visibility, confidence, source_refs, source_context
    FROM nodes
    WHERE addr = ${targetAddr}
    LIMIT 1
  `;
  if (!targetNode) return;

  const mergedSourceRefs = deriveSourceRefs({
    existing: targetNode.source_refs,
    sourceContext: targetNode.source_context,
    provenanceSources: [
      {
        type: opts.sourceType || "url",
        url: opts.sourceUrl,
        title: opts.title || undefined,
      },
    ],
  });

  if (targetNode.visibility === "public") {
    const grounded = evaluatePublicGrounding({
      spaceId: "global",
      visibility: "public",
      confidence: targetNode.confidence,
      sourceRefs: mergedSourceRefs,
      sourceContext: targetNode.source_context,
    });
    await sql`
      UPDATE nodes
      SET source_refs = ${sql.json(grounded.sourceRefs)},
          source_context = ${sql.json(grounded.sourceContext)},
          confidence = ${grounded.confidence},
          updated_at = NOW()
      WHERE addr = ${targetAddr}
    `;
    return;
  }

  await sql`
    UPDATE nodes
    SET source_refs = ${sql.json(mergedSourceRefs)},
        updated_at = NOW()
    WHERE addr = ${targetAddr}
  `;
}

function buildDurableOntologyHint(
  atom: ExtractedAtom,
  content: string,
  opts: RouteOptions,
): DurableOntologySuggestion | null {
  if (atom.temporality !== "DURABLE") return null;
  return suggestDurableOntologyTarget({
    content,
    sourceType: opts.sourceType,
    sourceTitle: opts.title,
    sourceId: opts.sourceUrl,
    nodeType: nodeTypeForWiAtom(atom.type, atom.subtype),
    atomSubtype: atom.subtype,
    domains: atom.domains,
    actionability: atom.actionability,
  });
}

function isDurableHeatTargetCompatible(
  candidate: NeighborCandidate | undefined,
  ontologyHint: DurableOntologySuggestion | null,
  params: WIParams,
): boolean {
  if (!candidate || !ontologyHint) return false;
  if (candidate.similarity < Math.max(params.similarityThreshold, 0.9)) return false;
  if (candidate.pyramidId !== ontologyHint.pyramidId) return false;
  if (!ontologyHint.parentAddr) return true;
  return candidate.addr === ontologyHint.parentAddr || candidate.parentAddr === ontologyHint.parentAddr;
}

function selectHeatTarget(
  atom: ExtractedAtom,
  neighbors: NeighborCandidate[],
  params: WIParams,
  ontologyHint: DurableOntologySuggestion | null,
  explicitTargetAddr?: string | null,
): NeighborCandidate | undefined {
  const explicitTarget = explicitTargetAddr
    ? neighbors.find((neighbor) => neighbor.addr === explicitTargetAddr)
    : undefined;

  if (atom.temporality === "DURABLE") {
    if (explicitTarget) {
      return isDurableHeatTargetCompatible(explicitTarget, ontologyHint, params) ? explicitTarget : undefined;
    }
    return neighbors.find((neighbor) => isDurableHeatTargetCompatible(neighbor, ontologyHint, params));
  }

  if (explicitTarget) {
    return explicitTarget.similarity > params.similarityThreshold ? explicitTarget : undefined;
  }

  return neighbors.find((neighbor) => neighbor.similarity > params.similarityThreshold);
}

function mergeNeighbors(branchNeighbors: NeighborCandidate[], globalNeighbors: NeighborCandidate[]): NeighborCandidate[] {
  const merged = new Map<string, NeighborCandidate>();
  for (const neighbor of [...branchNeighbors, ...globalNeighbors]) {
    if (!merged.has(neighbor.addr)) merged.set(neighbor.addr, neighbor);
  }
  return [...merged.values()]
    .sort((a, b) => {
      if (a.locality !== b.locality) return a.locality === "ontology" ? -1 : 1;
      return b.similarity - a.similarity;
    })
    .slice(0, 3);
}

function titleCaseLabel(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (/^[A-Z0-9-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(" ");
}

function deriveAtomicNodeLabel(content: string, atom: ExtractedAtom): string {
  const cleaned = content
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const possessiveTitledWork = cleaned.match(/^[A-Za-z][A-Za-z0-9\s.'-]{1,60}['’]s\s+["“']([^"'”]{3,80})["”']\s+(?:serves|is|functions)\b/i);
  if (possessiveTitledWork?.[1]) {
    return titleCaseLabel(possessiveTitledWork[1].trim());
  }

  const leadingConcept = cleaned.match(/^([A-Za-z][A-Za-z0-9'/-]*(?:\s+(?:[A-Za-z][A-Za-z0-9'/-]*|of|for|and|to|in|on|with|without|by|from|as)){0,6}),\s+(?:the|a|an|where|which)\b/i);
  if (leadingConcept?.[1]) {
    return titleCaseLabel(leadingConcept[1].trim());
  }

  const possibility = cleaned.match(/\b(?:the\s+)?possibility of ([A-Za-z][A-Za-z0-9\s'-]{4,80}?)(?:\s+as\s+[A-Za-z][A-Za-z0-9\s'-]{2,40})?(?:\b|,)/i);
  if (possibility?.[1]) {
    const tail = cleaned.match(/\bpossibility of [A-Za-z][A-Za-z0-9\s'-]{4,80}?(\s+as\s+[A-Za-z][A-Za-z0-9\s'-]{2,40})/i)?.[1] || "";
    return titleCaseLabel(`Possibility Of ${possibility[1].trim()}${tail}`.trim());
  }

  const centralProblem = cleaned.match(/^(?:The\s+)?central problem of ([A-Za-z][A-Za-z0-9\s'-]{3,80}?)(?:,| is\b)/i);
  if (centralProblem?.[1]) {
    return titleCaseLabel(`Central Problem Of ${centralProblem[1].trim()}`);
  }

  const possibleBecause = cleaned.match(/^([A-Za-z][A-Za-z0-9\s'-]{3,80}?)\s+is possible because\b/i);
  if (possibleBecause?.[1]) {
    return titleCaseLabel(possibleBecause[1].trim());
  }

  const quoted = cleaned.match(/^(?:The\s+)?["“']([^"'”]{4,80})["”'](?:\s+(of\s+[A-Za-z0-9\s-]{2,40}))?/);
  if (quoted?.[1]) {
    const suffix = quoted[2] ? ` ${quoted[2]}` : "";
    return titleCaseLabel(`${quoted[1]}${suffix}`.replace(/^[Tt]he\s+/, "").trim());
  }

  if (atom.type === "KNOWLEDGE" && atom.subtype === "framework") {
    const principle = cleaned.match(/(?:The\s+)?(Principle of [A-Za-z0-9\s-]{4,80}?)\s+(?:states|posits|proposes|suggests|holds)\b/i);
    if (principle?.[1]) return titleCaseLabel(principle[1].trim());
  }

  const subject = cleaned.match(
    /^(?:(?:The|A|An)\s+)?([A-Za-z][A-Za-z0-9'/-]*(?:\s+(?:[A-Za-z][A-Za-z0-9'/-]*|of|for|and|to|in|on|with|without|by|from|as|vs\.?|vs)){0,7})\s+(?:is|are|was|were|concerns|posits|states|suggests|proposes|describes|explains|refers|holds|functions|serves)\b/i
  );
  if (subject?.[1]) {
    return titleCaseLabel(subject[1].trim());
  }

  return cleaned.slice(0, 80).replace(/[.,;:!?]+$/, "").trim();
}

// ============================================================
// ROUTE — full Stage 3
// ============================================================

export interface RouteOptions {
  dryRun?: boolean;
  force?: boolean;
  sourceUrl: string;
  sourceType: string;
  sourceHash: string;
  title: string;
  enrichedAtoms?: EnrichedAtom[];
}

export async function route(atoms: ExtractedAtom[], runId: string, opts: RouteOptions): Promise<WIRunResult> {
  const startTime = Date.now();
  const params = await loadParams();
  const profile = SOURCE_REGISTRY[opts.sourceType] || SOURCE_REGISTRY.web;
  let costUsd = 0;

  const atomKey = (atom: Pick<ExtractedAtom, "content" | "type" | "subtype">) => `${atom.type}|${atom.subtype}|${atom.content}`;

  // Track routing outcomes
  let newNodeCount = 0, heatCount = 0, skillCount = 0, dropCount = 0;

  // Preserve enrichment across dedup by matching on atom signature instead of raw index.
  const enrichedByKey = new Map<string, EnrichedAtom>();
  if (opts.enrichedAtoms) {
    for (const enriched of opts.enrichedAtoms) {
      if (enriched?.enrichment) {
        enrichedByKey.set(atomKey(enriched), enriched);
      }
    }
  }

  // 1. Embed all atoms
  const atomTexts = atoms.map(a => a.content);
  const embeddings = await embedBatch(atomTexts);
  for (let i = 0; i < atoms.length; i++) {
    atoms[i].embedding = embeddings[i];
  }

  // Post-split dedup (B1) — if text was split, embeddings allow dedup
  atoms = deduplicateAtoms(atoms, Math.max(params.maxAtoms, atoms.length));

  const enrichmentMap = new Map<number, EnrichedAtom>();
  for (let i = 0; i < atoms.length; i++) {
    const enriched = enrichedByKey.get(atomKey(atoms[i]));
    if (enriched?.enrichment) enrichmentMap.set(i, enriched);
  }

  // 2. Write atom hashes to wi_atom_hashes (committed immediately for parallel dedup — B2)
  if (!opts.dryRun) {
    for (const atom of atoms) {
      const hash = await sha256(atom.content);
      await sql`
        INSERT INTO wi_atom_hashes (content_hash, embedding, run_id, created_at)
        VALUES (${hash}, ${toVectorStr(atom.embedding!)}::halfvec, ${runId}, now())
      `;
    }
  }

  // 3. Vector search top-3 nearest nodes per atom
  const nearestPerAtom: Array<NeighborCandidate[]> = [];
  const ontologyHintPerAtom: Array<DurableOntologySuggestion | null> = atoms.map((atom, i) => {
    const enrichment = enrichmentMap.get(i)?.enrichment;
    return buildDurableOntologyHint(atom, enrichment?.enrichedContent || atom.content, opts);
  });
  let coldStart = false;

  // Quick check: does the graph have nodes?
  const [nodeCount] = await sql`SELECT COUNT(*) AS n FROM nodes WHERE embedding_hv IS NOT NULL`;
  if (parseInt(nodeCount.n) === 0) {
    coldStart = true;
  }

  if (!coldStart) {
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i];
      const vecStr = toVectorStr(atom.embedding!);
      const globalNeighbors = await sql`
        SELECT addr, label, pyramid_id, parent_addr,
               1 - (embedding_hv <=> ${vecStr}::halfvec) AS similarity
        FROM nodes
        WHERE embedding_hv IS NOT NULL
        ORDER BY embedding_hv <=> ${vecStr}::halfvec
        LIMIT 3
      `;
      const ontologyHint = ontologyHintPerAtom[i];
      let branchNeighbors: NeighborCandidate[] = [];
      if (atom.temporality === "DURABLE" && ontologyHint?.parentAddr) {
        const branchRows = await sql`
          SELECT addr, label, pyramid_id, parent_addr,
                 1 - (embedding_hv <=> ${vecStr}::halfvec) AS similarity
          FROM nodes
          WHERE embedding_hv IS NOT NULL
            AND pyramid_id = ${ontologyHint.pyramidId}
            AND (addr = ${ontologyHint.parentAddr} OR parent_addr = ${ontologyHint.parentAddr})
          ORDER BY embedding_hv <=> ${vecStr}::halfvec
          LIMIT 3
        `;
        branchNeighbors = branchRows.map((r: any) => ({
          addr: r.addr,
          label: r.label,
          similarity: parseFloat(r.similarity),
          pyramidId: r.pyramid_id || null,
          parentAddr: r.parent_addr || null,
          locality: "ontology" as const,
        }));
      }
      const mappedGlobalNeighbors = globalNeighbors.map((r: any) => ({
        addr: r.addr,
        label: r.label,
        similarity: parseFloat(r.similarity),
        pyramidId: r.pyramid_id || null,
        parentAddr: r.parent_addr || null,
        locality: "global" as const,
      }));
      nearestPerAtom.push(mergeNeighbors(branchNeighbors, mappedGlobalNeighbors));
    }
  } else {
    for (const _ of atoms) nearestPerAtom.push([]);
  }

  // 4. Check parallel dedup (B2) — look for recent atom hashes with high cosine
  if (!opts.dryRun && !opts.force) {
    for (let i = atoms.length - 1; i >= 0; i--) {
      const vecStr = toVectorStr(atoms[i].embedding!);
      const [dup] = await sql`
        SELECT content_hash FROM wi_atom_hashes
        WHERE run_id != ${runId}
          AND created_at > now() - interval '300 seconds'
          AND 1 - (embedding <=> ${vecStr}::halfvec) > 0.90
        LIMIT 1
      `;
      if (dup) {
        atoms.splice(i, 1);
        nearestPerAtom.splice(i, 1);
      }
    }
  }

  if (atoms.length === 0) {
    // All atoms deduped — still a successful run, just nothing new
    return finishRun(runId, opts, 0, 0, 0, 0, 0, costUsd, Date.now() - startTime, "done", 0, 0, 0);
  }

  // 4c. Rediscovery — check absorbed_echoes for high-similarity matches
  const rediscoveryMap = new Map<number, { parent_addr: string; original_addr: string; essence: string; original_label: string }>();
  if (!coldStart) {
    for (let i = 0; i < atoms.length; i++) {
      if (!atoms[i].embedding) continue;
      const vecStr = toVectorStr(atoms[i].embedding!);
      const echoes = await sql`
        SELECT parent_addr, original_addr, essence, original_label,
          1 - (embedding <=> ${vecStr}::halfvec) AS similarity
        FROM absorbed_echoes WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vecStr}::halfvec LIMIT 1
      `;
      if (echoes.length > 0 && parseFloat(echoes[0].similarity) > 0.90) {
        rediscoveryMap.set(i, echoes[0]);
      }
    }
  }

  // 5. Routing: LLM or deterministic
  let routedAtoms: RoutedAtom[];

  if (coldStart) {
    // B9: cold start — everything is NEW_NODE
    routedAtoms = atoms.map(a => ({ ...a, route: "NEW_NODE" as const, reason: "Cold start — no nodes in graph" }));
  } else {
    // Build atoms + neighbors context for LLM

    const atomsContext = atoms.map((atom, i) => {
      const neighbors = nearestPerAtom[i];
      const enriched = enrichmentMap.get(i);
      const neighborStr = neighbors.length > 0
        ? neighbors.map((n) => {
          const tags = [n.pyramidId || "?", n.locality === "ontology" ? "ontology-local" : null]
            .filter(Boolean)
            .join(", ");
          return `  - ${n.addr} "${n.label}" [${tags}] (similarity: ${n.similarity.toFixed(3)})`;
        }).join("\n")
        : "  (no similar nodes found)";

      // Use enriched content if available
      const displayContent = enriched?.enrichment?.enrichedContent || atom.content;
      let ctx = `[${i}] ${atom.type} temporality=${atom.temporality || "DURABLE"} (importance=${atom.importance}, actionability=${atom.actionability}): "${displayContent}"\nNearest nodes:\n${neighborStr}`;

      // Add enrichment context if available
      if (enriched?.enrichment) {
        const e = enriched.enrichment;
        if (e.edgeSuggestions.length > 0) {
          ctx += `\nEdge suggestions:\n${e.edgeSuggestions.map(es => `  - → ${es.target_addr} (${es.edge_type}): ${es.reason}`).join("\n")}`;
        }
        if (e.heatSignature) {
          ctx += `\nHeat: domain=${e.heatSignature.primary_domain} intensity=${e.heatSignature.intensity} decay=${e.heatSignature.decay_class}`;
        }
      }

      const echo = rediscoveryMap.get(i);
      if (echo) {
        ctx += `\n⚠️ Similar to retired concept: "${echo.essence}" (was ${echo.original_addr}, absorbed into ${echo.parent_addr}). Consider NEW_NODE (resurfacing) or HEAT on parent.`;
      }
      return ctx;
    }).join("\n\n");

    let routingResult: any[];
    try {
      const raw = await callFlashLite(buildRoutingPrompt(atomsContext), { jsonMode: true, temperature: 0.1, maxTokens: 2048 });
      costUsd += 0.0001; // Approximate cost tracking
      routingResult = JSON.parse(raw.trim());
      if (!Array.isArray(routingResult)) routingResult = [routingResult];
    } catch (err: any) {
      console.warn(`[WI] Routing LLM failed, using deterministic fallback: ${err.message}`);
      routingResult = [];
    }

    // Build routing map from LLM response
    const routeMap = new Map<number, { route: string; reason: string; target_node?: string }>();
    for (const entry of routingResult) {
      if (typeof entry?.index === "number" && entry.route) {
        routeMap.set(entry.index, entry);
      }
    }

    // Apply routing with validation (B5)
    routedAtoms = atoms.map((atom, i) => {
      const llmRoute = routeMap.get(i);
      const neighbors = nearestPerAtom[i] || [];
      const ontologyHint = ontologyHintPerAtom[i];

      if (llmRoute) {
        const route = llmRoute.route;
        const validRoutes = ["NEW_NODE", "HEAT", "SKILL_PROPOSAL", "DROP"];
        if (validRoutes.includes(route)) {
          // HEAT must have valid target_node
          if (route === "HEAT") {
            const target = typeof llmRoute.target_node === "string" ? llmRoute.target_node : null;
            const selectedTarget = target && /^[A-Z]+\.\d/.test(target)
              ? selectHeatTarget(atom, neighbors, params, ontologyHint, target)
              : undefined;
            if (selectedTarget) {
              return { ...atom, route: "HEAT" as const, targetNode: selectedTarget.addr, reason: llmRoute.reason };
            }
            // Invalid target — use deterministic
          } else {
            return { ...atom, route: route as any, targetNode: llmRoute.target_node, reason: llmRoute.reason };
          }
        }
      }

      // Deterministic fallback
      const selectedTarget = selectHeatTarget(atom, neighbors, params, ontologyHint);
      if (selectedTarget) {
        const reason = atom.temporality === "DURABLE"
          ? "High similarity to existing node within the same ontology branch"
          : "High similarity to existing node";
        return { ...atom, route: "HEAT" as const, targetNode: selectedTarget.addr, reason };
      }
      if (atom.type === "SKILL" && atom.actionability >= params.skillActionabilityThreshold) {
        return { ...atom, route: "SKILL_PROPOSAL" as const, reason: "Actionable skill detected" };
      }
      return { ...atom, route: "NEW_NODE" as const, reason: "Novel content" };
    });
  }

  // 5b. Temporal routing constraints — CURRENT/EPHEMERAL cannot create NEW_NODE or SKILL_PROPOSAL
  for (let ai = 0; ai < routedAtoms.length; ai++) {
    const atom = routedAtoms[ai];
    if (atom.temporality === "CURRENT" || atom.temporality === "EPHEMERAL") {
      if (atom.route === "NEW_NODE" || atom.route === "SKILL_PROPOSAL") {
        const topSim = nearestPerAtom[ai]?.[0]?.similarity ?? 0;
        const topNode = nearestPerAtom[ai]?.[0]?.addr;
        if (topNode && topSim > 0.3) {
          atom.route = "HEAT";
          atom.targetNode = topNode;
          atom.reason = `Temporal ${atom.temporality} — downgraded to HEAT`;
        } else {
          atom.route = "HEAT";
          atom.targetNode = undefined;
          atom.reason = `Temporal ${atom.temporality} — orphan HEAT (no matching node)`;
        }
      }
    }
  }

  // 5c. Count temporal stats
  let durableCount = 0, currentCount = 0, ephemeralCount = 0;
  for (const atom of routedAtoms) {
    switch (atom.temporality) {
      case "DURABLE": durableCount++; break;
      case "CURRENT": currentCount++; break;
      case "EPHEMERAL": ephemeralCount++; break;
    }
  }

  // 6. Per-atom writes (B6) — each in its own mini-transaction
  for (let atomIdx = 0; atomIdx < routedAtoms.length; atomIdx++) {
    const atom = routedAtoms[atomIdx];
    const enriched = enrichmentMap.get(atomIdx);
    const enrichment = enriched?.enrichment;

    // Prefer enriched content for all writes
    const bestContent = enrichment?.enrichedContent || atom.content;

    if (opts.dryRun) {
      // Just count
      switch (atom.route) {
        case "NEW_NODE": newNodeCount++; break;
        case "HEAT": heatCount++; break;
        case "SKILL_PROPOSAL": skillCount++; break;
        case "DROP": dropCount++; break;
      }
      emitWI("atom_routed", runId, { index: atomIdx, route: atom.route, target_node: atom.targetNode, reason: atom.reason });
      continue;
    }

    try {
      switch (atom.route) {
        case "NEW_NODE": {
          const nodeType = nodeTypeForWiAtom(atom.type, atom.subtype);
          const proposedLabel = deriveAtomicNodeLabel(bestContent, atom);
          const ontologyTarget = await resolveDurableOntologyTarget(sql, {
            content: bestContent,
            sourceType: opts.sourceType,
            sourceTitle: opts.title,
            sourceId: opts.sourceUrl,
            nodeType,
            atomSubtype: atom.subtype,
            domains: atom.domains,
            actionability: atom.actionability,
          });
          // F6: allocation + INSERT under a single transaction-scoped
          // advisory lock with PK-collision retry.
          await withAllocatedChildSlot(
            sql,
            ontologyTarget.pyramidId,
            ontologyTarget.parentAddr,
            async (tx, slot) => {
              await tx`
                INSERT INTO staging_nodes (run_id, addr, pyramid_id, layer, depth, position, label, substance, confidence, parent_addr, visibility, qc_status, qc_agent, source_context)
                VALUES (
                  ${runId}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position},
                  ${proposedLabel},
                  ${tx.json({
                    description: bestContent,
                    slug: slugifyLabel(proposedLabel),
                    domains: atom.domains,
                    type: atom.type,
                    subtype: atom.subtype,
                    node_type: nodeType,
                  })},
                  ${profile.default_confidence},
                  ${ontologyTarget.parentAddr}, 'private', 'pending', 'world-ingestor',
                  ${tx.json({
                    wi_run_id: runId,
                    source_url: opts.sourceUrl,
                    source_type: opts.sourceType,
                    wi_temporality: atom.temporality || "DURABLE",
                    importance: atom.importance,
                    actionability: atom.actionability,
                    ...(enrichment ? {
                      enrichment_score: enrichment.enrichmentScore,
                      edge_suggestions: enrichment.edgeSuggestions,
                      heat_signature: enrichment.heatSignature,
                    } : {}),
                    ontology_target: {
                      pyramid_id: ontologyTarget.pyramidId,
                      parent_addr: ontologyTarget.parentAddr,
                      parent_label: ontologyTarget.parentLabel,
                      reason: ontologyTarget.selectionReason,
                      keyword_score: ontologyTarget.keywordScore,
                    },
                  })}
                )
              `;
            },
          );
          newNodeCount++;
          break;
        }

        case "HEAT": {
          const vecStr = atom.embedding ? toVectorStr(atom.embedding) : null;
          const halflife = getTemporalHalflife(atom, params, profile);
          const isOrphan = !atom.targetNode;
          const orphanStatus = isOrphan ? "throbbing" : null;
          // Use enrichment intensity for energy (default 1.0 when no enrichment)
          const energy = enrichment?.heatSignature?.intensity ?? 1.0;
          // F11: WI heat atoms — background ingest path, correlation_id NULL.
          const [inserted] = await sql`
            INSERT INTO stimuli (source, source_id, stimulus_type, content, url, embedding, decay_halflife_hours, node_addr, similarity, ingest_batch_id, is_orphan, orphan_status, energy, correlation_id, space_id)
            VALUES (
              ${"wi:" + opts.sourceType},
              ${runId + ":" + atomIdx},
              'research_paper',
              ${bestContent},
              ${opts.sourceUrl},
              ${vecStr ? sql`${vecStr}::halfvec` : null},
              ${halflife},
              ${atom.targetNode || null},
              ${null},
              ${runId},
              ${isOrphan},
              ${orphanStatus},
              ${energy},
              NULL,
              'global'
            )
            RETURNING id
          `;
          if (inserted?.id && isOrphan) {
            await sql`
              UPDATE stimuli
              SET temporality = ${atom.temporality || null}
              WHERE id = ${inserted.id}
            `;
            await attachOrphanToTrendPool(inserted.id);
          } else if (inserted?.id) {
            await sql`
              UPDATE stimuli
              SET temporality = ${atom.temporality || null}
              WHERE id = ${inserted.id}
            `;
          }
          // Revival — wake dormant nodes on HEAT
          if (atom.targetNode) {
            const [targetNode] = await sql`SELECT visibility, substance FROM nodes WHERE addr = ${atom.targetNode}`;
            if (targetNode?.visibility === "dormant") {
              const prevVis = targetNode.substance?.pre_dormant_visibility || "private";
              await sql`
                UPDATE nodes SET visibility = ${prevVis}, dormant_at = NULL,
                  confidence = LEAST(1.0, confidence + 0.05)
                WHERE addr = ${atom.targetNode}
              `;
              console.log(`  [REVIVAL] ${atom.targetNode} woke from dormancy`);
            }
            if (atom.temporality === "DURABLE") {
              await reinforceDurableHeatTarget(atom.targetNode, opts);
            }
          }

          heatCount++;
          break;
        }

        case "SKILL_PROPOSAL": {
          // Draft SKILL.md via Flash Lite — use enriched content for better drafts
          let draftMd: string | null = null;
          try {
            draftMd = await callFlashLite(buildSkillDraftPrompt(bestContent, opts.sourceUrl), { temperature: 0.3, maxTokens: 2048 });
            costUsd += 0.0001;
          } catch (err: any) {
            console.warn(`[WI] Skill draft failed: ${err.message}`);
          }

          await sql`
            INSERT INTO wi_skill_proposals (content, source_url, skill_type, draft_md, status)
            VALUES (${bestContent}, ${opts.sourceUrl}, ${atom.subtype}, ${draftMd}, 'proposed')
          `;
          skillCount++;
          break;
        }

        case "DROP": {
          dropCount++;
          break;
        }
      }

      // Source convergence — wi_source_links (V1)
      if (atom.route === "NEW_NODE" || atom.route === "HEAT") {
        const nodeAddr = atom.route === "HEAT" ? (atom.targetNode || "unknown") : "new";
        await sql`
          INSERT INTO wi_source_links (source_hash, node_addr, atom_count, created_at)
          VALUES (${opts.sourceHash}, ${nodeAddr}, 1, now())
        `;
      }
    } catch (err: any) {
      console.error(`[WI] Atom write failed: ${err.message}`);
      // Individual atom failure: log, skip, continue
    }

    emitWI("atom_routed", runId, { index: atomIdx, route: atom.route, target_node: atom.targetNode, reason: atom.reason });
  }

  // 7. Finalize
  const elapsedMs = Date.now() - startTime;
  const allFailed = (newNodeCount + heatCount + skillCount) === 0 && atoms.length > 0;
  const status = allFailed ? "failed" : "done";

  return finishRun(runId, opts, atoms.length, newNodeCount, heatCount, skillCount, dropCount, costUsd, elapsedMs, status, durableCount, currentCount, ephemeralCount);
}

// ============================================================
// FINISH RUN — update source_history, write wi_runs, emit, cleanup
// ============================================================

async function finishRun(
  runId: string, opts: RouteOptions,
  atomsExtracted: number, newNode: number, heat: number, skill: number, drop: number,
  costUsd: number, elapsedMs: number, status: "done" | "failed",
  durable: number = 0, current: number = 0, ephemeral: number = 0,
): Promise<WIRunResult> {
  if (!opts.dryRun) {
    // Update source_history
    await finalizeWISourceHistory({
      runId,
      status,
      atomsExtracted,
      newNode,
      heat,
      skill,
      costUsd,
    }).catch(() => {});

    // Write wi_runs
    await sql`
      INSERT INTO wi_runs (run_id, source_url, source_type, title, atoms_extracted, atoms_new_node, atoms_heat, atoms_skill, atoms_drop, skills_detected, cost_usd, elapsed_ms, status, atoms_durable, atoms_current, atoms_ephemeral)
      VALUES (${runId}, ${opts.sourceUrl}, ${opts.sourceType}, ${opts.title}, ${atomsExtracted}, ${newNode}, ${heat}, ${skill}, ${drop}, ${skill}, ${costUsd}, ${elapsedMs}, ${status}, ${durable}, ${current}, ${ephemeral})
    `.catch((err: any) => console.error(`[WI] Failed to write wi_runs: ${err.message}`));

    // Cleanup old atom hashes
    await sql`DELETE FROM wi_atom_hashes WHERE created_at < now() - interval '1 hour'`.catch(() => {});

    if (skill > 0) {
      void autoReviewSkills().catch((err: any) => {
        console.warn(`[WI] Skill auto-review trigger failed: ${err.message}`);
      });
    }
  }

  const result: WIRunResult = {
    runId,
    sourceUrl: opts.sourceUrl,
    sourceType: opts.sourceType,
    title: opts.title,
    atomsExtracted,
    atomsNewNode: newNode,
    atomsHeat: heat,
    atomsSkill: skill,
    atomsDrop: drop,
    atomsDurable: durable,
    atomsCurrent: current,
    atomsEphemeral: ephemeral,
    skillsDetected: skill,
    costUsd,
    elapsedMs,
    status,
  };

  emitWI("source_done", runId, {
    source_url: opts.sourceUrl,
    source_type: opts.sourceType,
    status,
  });

  emitWI("run_complete", runId, {
    atoms_total: atomsExtracted,
    new_nodes: newNode,
    heat,
    skills: skill,
    drops: drop,
    durable,
    current,
    ephemeral,
    elapsed_ms: elapsedMs,
    cost_usd: costUsd,
  });

  return result;
}

// ============================================================
// HELPERS
// ============================================================

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const __testables = {
  buildDurableOntologyHint,
  deriveAtomicNodeLabel,
  isDurableHeatTargetCompatible,
  selectHeatTarget,
  mergeNeighbors,
};

// ============================================================
// ROUTE ENRICHED ATOMS — convert pool rows to atoms, route per run_id
// ============================================================

export async function routeEnrichedAtoms(poolRows: any[]): Promise<void> {
  // Group by run_id
  const byRun = new Map<string, any[]>();
  for (const row of poolRows) {
    const runId = row.run_id;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId)!.push(row);
  }

  for (const [runId, rows] of byRun) {
    // Convert pool rows to ExtractedAtom[]
    const atoms: ExtractedAtom[] = rows.map((r: any) => ({
      content: r.enriched_content || r.content,
      type: r.type as "KNOWLEDGE" | "SKILL",
      subtype: r.subtype,
      domains: r.domains || [],
      importance: r.importance,
      actionability: r.actionability,
      temporality: r.temporality as "DURABLE" | "CURRENT" | "EPHEMERAL" | undefined,
    }));

    // Build EnrichedAtom[] for route context
    const enrichedAtoms: EnrichedAtom[] = rows.map((r: any) => ({
      content: r.content,
      type: r.type as "KNOWLEDGE" | "SKILL",
      subtype: r.subtype,
      domains: r.domains || [],
      importance: r.importance,
      actionability: r.actionability,
      temporality: r.temporality as "DURABLE" | "CURRENT" | "EPHEMERAL" | undefined,
      poolId: r.id,
      enrichment: r.enriched_content ? {
        enrichedContent: r.enriched_content,
        edgeSuggestions: r.edge_suggestions || [],
        batchRelationships: r.batch_relationships || [],
        heatSignature: r.heat_signature || { primary_domain: "general", intensity: 0.5, decay_class: "medium" as const },
        enrichmentScore: r.enrichment_score || 0.5,
        priority: r.priority || 0.5,
      } : undefined,
    }));

    // Get source info from first row
    const sourceUrl = rows[0].source_url;
    const sourceType = rows[0].source_type || "web";
    const sourceHash = await sha256(sourceUrl);

    // Look up title from wi_runs
    const [runInfo] = await sql`SELECT title FROM wi_runs WHERE run_id = ${runId}`.catch(() => [{ title: sourceUrl }]);

    await route(atoms, runId, {
      sourceUrl,
      sourceType,
      sourceHash,
      title: runInfo?.title || sourceUrl,
      enrichedAtoms,
    });
  }
}
