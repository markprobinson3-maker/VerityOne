/**
 * Memory update — patch content fields of an active memory.
 *
 * Updates substance fields (assertion, subject, why_it_matters, evidence,
 * tags, confidence, expires_at) without changing source provenance.
 * Node mutation + audit event are atomic (sql.begin). If expires_at is
 * patched, memory_registry.expires_at is updated in the same transaction.
 * Embedding is computed outside the transaction (external service call).
 * Sync journal is best-effort outside the transaction, matching
 * approveMemory(), retractMemory(), and forgetMemory().
 *
 * /memory/update does NOT upgrade source_kind, accepted_by_user,
 * promoted_from, or approval. Those are approval-path only.
 */

import type postgres from "postgres";
import type { MemoryUpdateRequest, MemoryKind, SourceKind } from "./memory-contract";
import { classifyMemoryWriteQuality, lexicalOverlapStats } from "./memory-quality";
import { AUTOMATED_DORMANCY_PROTECTED_KINDS } from "./memory-lifecycle";
import { embedTextForInsert, embeddingTextForNode, type EmbedForInsert } from "./embed";

type SqlTag = ReturnType<typeof postgres>;

/** Lexical overlap below which an assertion edit counts as a SUBSTANTIAL rewrite
 *  (vs a typo/minor edit) for the protected/user-accepted approval gate. */
const SUBSTANTIAL_REWRITE_MAX_JACCARD = 0.5;

export interface UpdateResult {
  ok: boolean;
  addr: string;
  updated_fields?: string[];
  error?: string;
  status?: number;
  /** Error code for a gate block (Memory-Health PR 2) — drives the HTTP status. */
  code?: GateCode;
  /** Machine-readable gate reasons when an update is blocked (Memory-Health PR 2). */
  reasons?: string[];
}

/** Error codes a gate can emit; each maps to an HTTP status via httpStatusFor():
 *  validation_failed → 400 (poor-quality content), approval_required → 403. */
export type GateCode = "validation_failed" | "approval_required";

export interface UpdateGateBlock {
  code: GateCode;
  error: string;
  reasons: string[];
}

/**
 * Pure write-quality / trust gate for /memory/update (Memory-Health PR 2). DB-free
 * and deterministic so it can be unit-tested and drift-pinned. `existing` is the
 * loaded node row. Returns a blocking result, or null when the update is permitted.
 *
 * Three gates (all skipped for tag-only / expiry-only / typo-level edits):
 *   1. write-quality — a material content change must clear classifyMemoryWriteQuality
 *      (the create-path gate). Only bites agent_inferred memories, so a human
 *      correcting their own memory is never blocked here.
 *   2. confidence increase — an agent cannot raise confidence without explicit approval.
 *   3. protected rewrite — a SUBSTANTIAL assertion rewrite of a user-accepted or
 *      protected-kind memory needs explicit approval (prefer supersession).
 */
export function checkUpdateGates(
  existing: { label?: string | null; confidence?: unknown; substance?: unknown },
  req: MemoryUpdateRequest,
  approved: boolean,
): UpdateGateBlock | null {
  const sub = (existing.substance && typeof existing.substance === "object" && !Array.isArray(existing.substance)
    ? existing.substance : {}) as Record<string, any>;
  const memKind = (typeof sub.memory_type === "string" ? sub.memory_type : "context") as MemoryKind;
  const memSource = (typeof sub.source_kind === "string" ? sub.source_kind : "agent_inferred") as SourceKind;
  const acceptedByUser = sub.accepted_by_user === true || sub.accepted_by_user === "true";
  const currentConfidence = existing.confidence == null ? null : Number(existing.confidence);
  const currentAssertion = typeof sub.description === "string" ? sub.description : "";
  const currentSubject = typeof sub.subject === "string" ? sub.subject : (existing.label ?? "");

  const changesAssertion = req.assertion !== undefined && req.assertion !== currentAssertion;
  const materialChange =
    changesAssertion ||
    (req.subject !== undefined && req.subject !== currentSubject) ||
    (req.why_it_matters !== undefined && req.why_it_matters !== (typeof sub.why_it_matters === "string" ? sub.why_it_matters : "")) ||
    (req.evidence !== undefined && req.evidence !== (typeof sub.evidence === "string" ? sub.evidence : ""));

  // Gate 1 — write-quality on material content (reuse the create-path classifier).
  if (materialChange) {
    const quality = classifyMemoryWriteQuality({
      kind: memKind,
      source: memSource,
      subject: (req.subject ?? currentSubject) || undefined,
      assertion: req.assertion ?? currentAssertion,
      whyItMatters: req.why_it_matters ?? (typeof sub.why_it_matters === "string" ? sub.why_it_matters : undefined),
      evidence: req.evidence ?? (typeof sub.evidence === "string" ? sub.evidence : undefined),
      tags: req.tags ?? (Array.isArray(sub.tags) ? sub.tags : undefined),
      sourceRefs: Array.isArray(sub.source_refs) ? sub.source_refs : undefined,
    });
    if (quality.verdict === "reject") {
      return {
        code: "validation_failed",
        error: `Update would degrade memory quality: ${quality.reasons.join(", ")}`,
        reasons: quality.reasons,
      };
    }
  }

  // Gate 2 — agent-initiated confidence INCREASE requires explicit approval.
  // Treat a NULL current confidence as the floor 0 so an agent cannot self-boost
  // from "unknown" to any value without approval (the column is nullable).
  const confidenceFloor = currentConfidence ?? 0;
  if (req.confidence !== undefined && req.confidence > confidenceFloor && !approved) {
    return {
      code: "approval_required",
      error: "Confidence increase requires explicit approval (approve_material_change); agents cannot self-boost trust.",
      reasons: ["confidence_increase_requires_approval"],
    };
  }

  // Gate 3 — a SUBSTANTIAL assertion rewrite of a user-accepted / protected memory.
  // Anchor the comparison to a STABLE baseline (the text at create / last approval),
  // not the current value, so an agent cannot salami-slice a protected memory to a
  // full semantic inversion via many small under-threshold edits. assertion_baseline
  // is re-anchored only on an approved change (see updateMemory).
  if (changesAssertion && (acceptedByUser || AUTOMATED_DORMANCY_PROTECTED_KINDS.has(memKind)) && !approved) {
    const baseline = (typeof sub.assertion_baseline === "string" && sub.assertion_baseline.trim())
      ? sub.assertion_baseline
      : currentAssertion;
    const overlap = lexicalOverlapStats(baseline, req.assertion as string);
    // Empty-baseline guard: filling in a genuinely-empty assertion is not a
    // "rewrite". Relies on an active protected memory never having an empty
    // description (create requires assertion length >= 1).
    const substantialRewrite = baseline.trim().length > 0 && overlap.jaccard < SUBSTANTIAL_REWRITE_MAX_JACCARD;
    if (substantialRewrite) {
      return {
        code: "approval_required",
        error: "Material rewrite of a user-accepted or protected memory requires supersession, retraction+replacement, or explicit approval (approve_material_change).",
        reasons: ["protected_material_rewrite_requires_approval"],
      };
    }
  }

  return null;
}

/**
 * Compute the assertion_baseline to persist on a material assertion change so the
 * salami-slice guard in Gate 3 stays anchored. Pure. Returns the value to store, or
 * null to leave the existing baseline untouched.
 *   - approved change  → re-anchor to the new assertion;
 *   - first unapproved change with no baseline yet → anchor to the PRE-edit text;
 *   - otherwise        → keep the existing baseline (drift accumulates against it).
 */
export function nextAssertionBaseline(
  currentSubstance: Record<string, unknown>,
  req: MemoryUpdateRequest,
  approved: boolean,
): string | null {
  const currentAssertion = typeof currentSubstance.description === "string" ? currentSubstance.description : "";
  if (req.assertion === undefined || req.assertion === currentAssertion) return null;
  if (approved) return req.assertion;
  const existingBaseline = currentSubstance.assertion_baseline;
  if (typeof existingBaseline === "string" && existingBaseline.trim()) return null;
  return currentAssertion;
}

export async function updateMemory(
  sql: SqlTag,
  tenantId: string,
  addr: string,
  req: MemoryUpdateRequest,
  actor: string,
  opts: { correlationId?: string | null; approveMaterialChange?: boolean } = {},
): Promise<UpdateResult> {
  const tenantSpaceId = `tenant:${tenantId}`;

  // 1. Verify memory exists and is active (non-dormant)
  const [existing] = await sql`
    SELECT addr, label, substance, confidence FROM nodes
    WHERE addr = ${addr} AND space_id = ${tenantSpaceId} AND node_type = 'memory' AND dormant_at IS NULL
      AND visibility <> 'deleted'
  `;
  if (!existing) {
    return { ok: false, addr, error: "Memory not found or not accessible" };
  }

  // 1b. Memory-Health PR 2: gate /memory/update like a memory write. Material
  //     content changes must clear the same write-quality posture as a new write;
  //     an agent cannot self-boost confidence or silently rewrite a user-accepted /
  //     protected memory. Tag-only, expiry-only, and typo-level edits stay
  //     low-friction (no gate). `approveMaterialChange` is the explicit
  //     user/operator approval contract that opts past the protected/confidence gates.
  const approveMaterialChange = opts.approveMaterialChange === true;
  const gate = checkUpdateGates(existing, req, approveMaterialChange);
  if (gate) return { ok: false, addr, code: gate.code, error: gate.error, reasons: gate.reasons };

  // 2. Build substance patch
  const updates: Record<string, unknown> = {};
  if (req.assertion !== undefined) updates.description = req.assertion;
  if (req.subject !== undefined) updates.subject = req.subject;
  if (req.why_it_matters !== undefined) updates.why_it_matters = req.why_it_matters;
  if (req.evidence !== undefined) updates.evidence = req.evidence;
  if (req.tags !== undefined) updates.tags = req.tags;
  if (req.expires_at !== undefined) updates.expires_at = req.expires_at;
  // Persist/refresh the protected-rewrite baseline (salami-slice guard anchor).
  const existingSubForBaseline =
    existing.substance && typeof existing.substance === "object" && !Array.isArray(existing.substance)
      ? (existing.substance as Record<string, unknown>) : {};
  const baselineToStore = nextAssertionBaseline(existingSubForBaseline, req, approveMaterialChange);
  if (baselineToStore !== null) updates.assertion_baseline = baselineToStore;
  updates.updated_at = new Date().toISOString();

  const updatedFields = Object.keys(updates).filter((k) => k !== "updated_at" && k !== "assertion_baseline");

  // 3. Compute embedding OUTSIDE transaction (external service call).
  // Only text-bearing fields refresh the document embedding; lifecycle
  // metadata like expires_at does not participate in embeddingTextForNode.
  const currentSubstance =
    existing.substance && typeof existing.substance === "object" && !Array.isArray(existing.substance)
      ? existing.substance as Record<string, unknown>
      : {};
  const nextSubstance = { ...currentSubstance, ...updates };
  const nextLabel = typeof req.subject === "string" && req.subject.trim()
    ? req.subject.trim()
    : existing.label || "";
  const refreshEmbedding = ["description", "subject", "why_it_matters", "evidence", "tags"]
    .some((key) => Object.prototype.hasOwnProperty.call(updates, key));
  const refreshedEmbed: EmbedForInsert | null = refreshEmbedding
    ? await embedTextForInsert(embeddingTextForNode(nextLabel, nextSubstance))
    : null;

  // 4. Atomic: node update + event + optional registry expires_at.
  //    All writes must succeed or none commit.
  const { logEvent } = await import("./memory-lifecycle");

  try {
    await sql.begin(async (tx: any) => {
      // Node mutation — with or without embedding update
      if (refreshedEmbed) {
        const updatedRows = await tx`
          UPDATE nodes SET
            substance = substance || ${tx.json(updates)}::jsonb,
            label = COALESCE(${req.subject || null}, label),
            confidence = COALESCE(${req.confidence ?? null}, confidence),
            embedding_hv = ${refreshedEmbed.vecStr}::halfvec(3072),
            embedding_at = ${refreshedEmbed.embeddedAt},
            embedding_model = ${refreshedEmbed.model},
            embedding_task_type = ${refreshedEmbed.taskType},
            updated_at = now()
          WHERE addr = ${addr}
            AND space_id = ${tenantSpaceId}
            AND node_type = 'memory'
            AND dormant_at IS NULL
            AND visibility <> 'deleted'
            AND label IS NOT DISTINCT FROM ${existing.label}
            AND substance IS NOT DISTINCT FROM ${tx.json(existing.substance ?? null)}::jsonb
          RETURNING addr
        `;
        if (updatedRows.length === 0) {
          throw new Error("STALE_MEMORY_EMBED_SOURCE");
        }
      } else {
        const updatedRows = await tx`
          UPDATE nodes SET
            substance = substance || ${tx.json(updates)}::jsonb,
            confidence = COALESCE(${req.confidence ?? null}, confidence),
            updated_at = now()
          WHERE addr = ${addr} AND space_id = ${tenantSpaceId}
            AND node_type = 'memory'
            AND dormant_at IS NULL
            AND visibility <> 'deleted'
          RETURNING addr
        `;
        if (updatedRows.length === 0) {
          throw new Error("STALE_MEMORY_UPDATE_TARGET");
        }
      }

      // Registry expires_at sync (only if expires_at was actually patched)
      if (req.expires_at !== undefined) {
        await tx`
          UPDATE memory_registry SET
            expires_at = ${req.expires_at || null},
            updated_at = now()
          WHERE addr = ${addr} AND tenant_id = ${tenantId}
        `;
      }

      // Audit event — must succeed for the transaction to commit. Record the
      // self-approval flag in the DURABLE, atomic ledger (not only the best-effort
      // post-tx audit row) so a gated bypass is tamper-evidently attributable.
      await logEvent(tx, addr, tenantId, "updated", actor, { updated_fields: updatedFields, approved: approveMaterialChange }, { correlationId: opts.correlationId ?? null });

      // F11: sync journal append inside the transaction so the journal row
      // commits with the update. Best-effort error handling preserves the
      // pre-F11 semantic that journal failures don't block the parent write.
      const { tryJournalMemoryInTx } = await import("./sync-journal-port");
      const existingProjectAddr = existing.substance?.project_addr as string | undefined;
      await tryJournalMemoryInTx(tx as any, "upsert", addr, tenantSpaceId, existingProjectAddr, "[memory-update]");
    });
  } catch (error) {
    if ((error as Error).message === "STALE_MEMORY_EMBED_SOURCE") {
      return {
        ok: false,
        addr,
        status: 409,
        error: "Memory changed while update embedding was being computed. Retry the update.",
      };
    }
    if ((error as Error).message === "STALE_MEMORY_UPDATE_TARGET") {
      return {
        ok: false,
        addr,
        status: 409,
        error: "Memory changed while update was being applied. Retry the update.",
      };
    }
    throw error;
  }

  return { ok: true, addr, updated_fields: updatedFields };
}
