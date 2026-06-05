/**
 * Verity Ingest — Stage 2: ATOMIZE
 *
 * Budget gate → Flash extraction → validation → provenance → embed → batch dedup → ceiling
 */

import { sql, EXIT, type IngestContext, type RawAtom, type ValidatedAtom, type AtomType, type Temporality } from "./config";
import { callFlash } from "../lib/llm";
import { embedBatch, toVectorStr } from "@verity-one/embed";
import { deriveStimulusOrigin } from "../lib/stimulus-origin";

const COST_PER_CHUNK = 0.003;
const PROVENANCE_THRESHOLD = 0.60;
const BATCH_DEDUP_THRESHOLD = 0.95;

const EXTRACTION_PROMPT = `You are a precision knowledge extractor for an AI agent infrastructure team.

Extract atomic claims from the text. An atomic claim is the smallest unit
of meaning that can independently be true or false.

Types:
- CLAIM: Factual assertion ("PostgreSQL 18 introduces incremental backup")
- FRAMEWORK: Named methodology ("The 3-layer memory architecture")
- ACTION: Concrete technique ("Use printf not echo for env vars")
- SIGNAL: Trend/movement ("Solana TVL up 40% this week")

For each atom provide:
- content: Self-contained claim (must make sense without surrounding text)
- atom_type: CLAIM | FRAMEWORK | ACTION | SIGNAL
- source_excerpt: EXACT verbatim quote (10-50 words) supporting this atom
- temporality: EPHEMERAL (hours-days) | CURRENT (weeks-months) | DURABLE (years+)

Calibration anchors:
- "PostgreSQL 17 is the current stable release" → CLAIM, CURRENT
- "Use HNSW indexes for nearest neighbor in pgvector" → ACTION, DURABLE
- "Bitcoin dropped 5% today on ETF outflows" → SIGNAL, EPHEMERAL
- "The OODA loop is a decision framework" → FRAMEWORK, DURABLE

Rules:
- Each atom MUST be self-contained
- source_excerpt MUST be verbatim from input
- Prefer specific over general
- Discard: filler, repetition, opinions without evidence, promotion
- Max 15 atoms per chunk. Empty array is valid.

Return JSON array only.`;

const VALID_ATOM_TYPES = new Set(["CLAIM", "FRAMEWORK", "ACTION", "SIGNAL"]);
const VALID_TEMPORALITIES = new Set(["EPHEMERAL", "CURRENT", "DURABLE"]);

/**
 * ATOMIZE: Extract atomic claims from chunks, validate, embed, dedup
 */
export async function atomize(ctx: IngestContext): Promise<void> {
  const { chunks, profile, flags, stats } = ctx;

  // 1. Budget gate
  const estimatedCost = chunks.length * COST_PER_CHUNK;
  if (estimatedCost > profile.cost_ceiling_usd && !flags.force) {
    throw new Error(`Budget exceeded: $${estimatedCost.toFixed(3)} > $${profile.cost_ceiling_usd} ceiling. Use --force to override. (exit ${EXIT.BUDGET_EXCEEDED})`);
  }
  console.log(`[ATOMIZE] Estimated cost: $${estimatedCost.toFixed(3)} (ceiling: $${profile.cost_ceiling_usd})`);

  // 2. Flash extraction per chunk
  const allRawAtoms: { atom: RawAtom; chunk_index: number }[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[ATOMIZE] Processing chunk ${i + 1}/${chunks.length} (${chunk.split(/\s+/).length} words)...`);

    try {
      const prompt = `${EXTRACTION_PROMPT}\n\n---\n\nTEXT:\n${chunk}`;
      const raw = await callFlash(prompt, { temperature: 0.2, maxTokens: 8192, jsonMode: true });
      stats.flash_calls++;
      stats.cost_usd += COST_PER_CHUNK;

      const atoms = parseAtoms(raw);
      console.log(`[ATOMIZE]   → ${atoms.length} atoms extracted`);

      for (const atom of atoms) {
        allRawAtoms.push({ atom, chunk_index: i });
      }
      stats.atoms_extracted += atoms.length;
      stats.chunks_processed++;
    } catch (err: any) {
      console.error(`[ATOMIZE]   → Flash failed for chunk ${i}: ${err.message?.slice(0, 100)}`);

      // Save to vi_raw_queue for retry
      if (!flags.dry_run) {
        await sql`INSERT INTO vi_raw_queue (ingest_batch_id, source_id, source_type, content, chunk_index, status)
          VALUES (${ctx.batch_id}, ${ctx.source_id}, ${ctx.source_type}, ${chunk}, ${i}, 'pending')`;
        console.log(`[ATOMIZE]   → Saved chunk ${i} to vi_raw_queue for retry`);
      }
    }
  }

  if (allRawAtoms.length === 0) {
    throw new Error(`No atoms extracted from any chunk (exit ${EXIT.ATOMIZER_FAILURE})`);
  }

  ctx.raw_atoms = allRawAtoms.map(a => a.atom);

  // 3. Schema validation (already done in parseAtoms)
  // 4. Provenance check
  const validated: ValidatedAtom[] = [];
  for (const { atom, chunk_index } of allRawAtoms) {
    const chunk = chunks[chunk_index];
    const chunkMetadata = ctx.chunk_metadata?.[chunk_index] || null;
    const provenance = checkProvenance(atom.source_excerpt, chunk)
      ? "verified" as const
      : "unverified" as const;
    const origin = deriveStimulusOrigin({
      sourceType: ctx.source_type,
      sourceId: ctx.source_id,
      sourceTitle: ctx.source_title,
      url: ctx.source_id,
      chunkMetadata,
      content: atom.content,
      sourceExcerpt: atom.source_excerpt,
    });

    if (provenance === "unverified") {
      console.log(`[ATOMIZE]   ⚠ Unverified provenance: "${atom.content.slice(0, 60)}..."`);
    }

    validated.push({
      ...atom,
      provenance,
      embedding: [], // filled in step 5
      chunk_index,
      chunk_metadata: chunkMetadata,
      origin_key: origin.originKey,
      origin_kind: origin.originKind,
      origin_label: origin.originLabel,
    });
  }

  stats.atoms_validated = validated.length;

  // 5. Embed all atoms
  console.log(`[ATOMIZE] Embedding ${validated.length} atoms...`);
  const texts = validated.map(a => a.content);
  const embeddings = await embedBatch(texts);
  stats.embed_calls++;

  for (let i = 0; i < validated.length; i++) {
    validated[i].embedding = embeddings[i];
  }
  stats.atoms_embedded = validated.length;

  // 6. Batch dedup — cosine similarity within batch
  const kept = batchDedup(validated);
  stats.atoms_deduped = validated.length - kept.length;
  if (stats.atoms_deduped > 0) {
    console.log(`[ATOMIZE] Batch dedup removed ${stats.atoms_deduped} near-duplicates`);
  }

  // 7. Atom ceiling
  const ceiling = profile.absolute_atom_ceiling;
  if (kept.length > ceiling) {
    console.log(`[ATOMIZE] Capping at ${ceiling} atoms (${kept.length} extracted)`);
    ctx.validated_atoms = kept.slice(0, ceiling);
  } else {
    ctx.validated_atoms = kept;
  }

  console.log(`[ATOMIZE] Final: ${ctx.validated_atoms.length} validated atoms`);
}

// ============================================================
// HELPERS
// ============================================================

function parseAtoms(raw: string): RawAtom[] {
  let cleaned = raw.trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  let parsed: any[];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find array
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try { parsed = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)); } catch {
        // Truncated JSON — try to recover by closing the last complete object
        const truncated = cleaned.slice(firstBracket);
        const lastCloseBrace = truncated.lastIndexOf("}");
        if (lastCloseBrace > 0) {
          try { parsed = JSON.parse(truncated.slice(0, lastCloseBrace + 1) + "]"); } catch {
            return [];
          }
        } else {
          return [];
        }
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter((a: any) => {
    if (!a.content || typeof a.content !== "string") return false;
    if (!a.atom_type || !VALID_ATOM_TYPES.has(a.atom_type)) return false;
    if (!a.source_excerpt || typeof a.source_excerpt !== "string") return false;
    if (!a.temporality || !VALID_TEMPORALITIES.has(a.temporality)) return false;
    return true;
  }).map((a: any) => ({
    content: a.content,
    atom_type: a.atom_type as AtomType,
    source_excerpt: a.source_excerpt,
    temporality: a.temporality as Temporality,
  }));
}

function checkProvenance(excerpt: string, chunk: string): boolean {
  // Normalized fuzzy match — check if source_excerpt appears in chunk
  const normExcerpt = excerpt.toLowerCase().replace(/\s+/g, " ").trim();
  const normChunk = chunk.toLowerCase().replace(/\s+/g, " ").trim();

  // Exact substring check first
  if (normChunk.includes(normExcerpt)) return true;

  // Fuzzy: compute word overlap ratio
  const excerptWords = new Set(normExcerpt.split(" "));
  const chunkWords = new Set(normChunk.split(" "));
  let overlap = 0;
  for (const w of excerptWords) {
    if (chunkWords.has(w)) overlap++;
  }
  const similarity = overlap / excerptWords.size;
  return similarity >= PROVENANCE_THRESHOLD;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function batchDedup(atoms: ValidatedAtom[]): ValidatedAtom[] {
  if (atoms.length <= 1) return atoms;

  const removed = new Set<number>();

  for (let i = 0; i < atoms.length; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < atoms.length; j++) {
      if (removed.has(j)) continue;
      const sim = cosineSimilarity(atoms[i].embedding, atoms[j].embedding);
      if (sim > BATCH_DEDUP_THRESHOLD) {
        // Keep the one with verified provenance, else the first
        if (atoms[i].provenance === "verified" && atoms[j].provenance !== "verified") {
          removed.add(j);
        } else if (atoms[j].provenance === "verified" && atoms[i].provenance !== "verified") {
          removed.add(i);
          break;
        } else {
          removed.add(j);
        }
      }
    }
  }

  return atoms.filter((_, i) => !removed.has(i));
}
