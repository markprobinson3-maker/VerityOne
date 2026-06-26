/**
 * Memory write — atomic creation of a new tenant-local memory.
 *
 * Advisory lock + address allocation + node insert + source_refs +
 * supersession + registry insert + created event are all atomic
 * via sql.begin(). Sync journal is best-effort outside the transaction,
 * matching approveMemory(), retractMemory(), forgetMemory(), updateMemory().
 *
 * Pre-processing (validation, project resolution, embedding, dedup)
 * is the caller's responsibility — this helper only owns the
 * transactional write and its lifecycle side effects.
 */

import type postgres from "postgres";
import type { MemoryKind, SourceRef } from "./memory-contract";
import type { SourceKind } from "./memory-contract";
import { allocateChildSlotInTx } from "./ontology";
import type { EmbedForInsert } from "@verity-one/embed";

type SqlTag = ReturnType<typeof postgres>;

const REMEMBER_LOCK_ID = 900_001;

export interface WriteMemoryParams {
  tenantId: string;
  spaceId: string;
  label: string;
  substance: Record<string, unknown>;
  confidence: number;
  /**
   * F7: stored document embedding for the new memory node. Must come
   * from `embedTextForInsert(embeddingTextForNode(label, substance))`,
   * NOT from `embedQuery` (which produces a query-task embedding for
   * retrieval, not storage). The four marker columns
   * (embedding_hv / embedding_at / embedding_model / embedding_task_type)
   * are populated from this object inside the transaction.
   */
  embed: EmbedForInsert;
  kind: MemoryKind;
  source: SourceKind;
  sourceRefs?: SourceRef[];
  supersedes?: string;
  actor: string;
  agentId: string | null;
  effectiveAt?: string;
  expiresAt?: string;
  isRemoteWrite?: boolean;
  remoteOrigin?: string;
  remoteClientClass?: string;
  remoteRequestId?: string;
  /** F9: per-request correlation id; threaded into memory_events. */
  correlationId?: string | null;
  /**
   * dedup-lock: optional in-lock dedup re-check. When provided, writeMemory runs
   * this dedup query INSIDE the advisory lock and, if a duplicate already exists,
   * returns { deduplicated: true, addr: <existing> } WITHOUT inserting — closing
   * the race where two concurrent identical writes both pass the caller's
   * pre-lock dedup before either inserts. Omit when the caller does not dedupe.
   */
  dedupGuard?: {
    queryVecStr: string;
    threshold: number;
    projectAddr: string;
  };
}

export interface WriteResult {
  ok: boolean;
  addr: string;
  /** dedup-lock: set when the in-lock recheck collapsed onto an existing node. */
  deduplicated?: boolean;
  existingLabel?: string | null;
  similarity?: number;
}

export async function writeMemory(
  sql: SqlTag,
  params: WriteMemoryParams,
): Promise<WriteResult> {
  const {
    tenantId, spaceId, label, substance, confidence, embed,
    kind, sourceRefs, supersedes, actor, agentId,
    effectiveAt, expiresAt,
    isRemoteWrite, remoteOrigin, remoteClientClass, remoteRequestId,
    correlationId, dedupGuard,
  } = params;

  // Trust-authority chokepoint (defense-in-depth): /memory/write already
  // clamps agent-supplied user_accepted, but writeMemory() is the single
  // transactional write path — enforce the invariant HERE too so no future
  // caller can reintroduce the self-grant. Agents never mint user_accepted;
  // the caller-built substance must agree with the clamped source.
  const { effectiveAgentWriteSource } = await import("./memory-authority");
  const source = effectiveAgentWriteSource(params.source, agentId);
  if (source !== params.source) {
    substance.source_kind = source;
    substance.accepted_by_user = false;
  }

  const { insertRegistry, logEvent, transitionMemoryLifecycleInTx } = await import("./memory-lifecycle");

  // Atomic: advisory lock + addr allocation + node insert + source_refs +
  //         supersession + registry insert + created event.
  //         All must succeed or none commit.
  const [result] = (await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(${REMEMBER_LOCK_ID})`;

    // dedup-lock: optional in-lock dedup re-check (see WriteMemoryParams.dedupGuard).
    // The caller's pre-lock dedup is optimistic; under concurrency two identical
    // writes can both pass it before either inserts, then serialize here. Re-check
    // inside the lock — where an earlier writer's insert is already committed and
    // visible (READ COMMITTED) — and collapse this write instead of double-inserting.
    if (dedupGuard) {
      const [lockedDup] = await tx`
        SELECT addr, label, 1 - (embedding_hv <=> ${dedupGuard.queryVecStr}::halfvec) as similarity
        FROM nodes
        WHERE space_id = ${spaceId} AND node_type = 'memory'
          AND embedding_hv IS NOT NULL
          AND dormant_at IS NULL
          AND visibility <> 'deleted'
          AND COALESCE(substance->>'project_addr', '') = ${dedupGuard.projectAddr}
        ORDER BY embedding_hv <=> ${dedupGuard.queryVecStr}::halfvec
        LIMIT 1
      `;
      if (lockedDup && parseFloat(lockedDup.similarity) > dedupGuard.threshold) {
        return [{
          addr: lockedDup.addr,
          deduplicated: true,
          existingLabel: lockedDup.label,
          similarity: parseFloat(parseFloat(lockedDup.similarity).toFixed(3)),
        }];
      }
    }

    const slot = await allocateChildSlotInTx(tx, "PROJECTS", null, { defaultDepth: 3 });
    const addr = slot.addr;

    // Node insert. F7: embed.* writes the four embedding marker
    // columns atomically with the row. Caller is required to have
    // computed `embed` via `embedTextForInsert(embeddingTextForNode(...))`
    // (document task type), not `embedQuery`.
    await tx`
      INSERT INTO nodes (
        addr, pyramid_id, layer, depth, position, label, substance, confidence, hash, provenance,
        visibility, space_id, node_type,
        embedding_hv, embedding_at, embedding_model, embedding_task_type
      )
      VALUES (
        ${addr}, 'PROJECTS', 0, ${slot.depth}, ${slot.position},
        ${label.slice(0, 120)},
        ${tx.json(substance)},
        ${confidence},
        md5(${addr + "-" + label.toLowerCase().replace(/\s+/g, "-")}),
        ${tx.json({
          agent: actor,
          date: new Date().toISOString().slice(0, 10),
          source,
          ...(isRemoteWrite ? {
            remote_origin: remoteOrigin,
            remote_client_class: remoteClientClass,
            remote_request_id: remoteRequestId,
          } : {}),
        })},
        'private',
        ${spaceId},
        'memory',
        ${embed.vecStr}::halfvec(3072),
        ${embed.embeddedAt},
        ${embed.model},
        ${embed.taskType}
      )
    `;

    // Source refs — atomic with insert
    if (sourceRefs && sourceRefs.length > 0) {
      await tx`UPDATE nodes SET source_refs = ${tx.json(sourceRefs)} WHERE addr = ${addr}`;
    }

    // Registry insert — must succeed with the node insert
    await insertRegistry(tx as any, {
      addr,
      tenantId,
      kind,
      sourceKind: source,
      sourceRef: agentId || undefined,
      acceptedByUser: source === "user_accepted",
      effectiveAt,
      expiresAt,
      supersedesAddr: supersedes,
    });

    // Supersession — atomic with insert and routed through the lifecycle
    // helper so the old memory's node, registry, event log, and journal are
    // updated together. writeMemory can be called by remote/agent surfaces, so
    // protected memories require a dedicated operator/review path instead of
    // being superseded through this generic write helper. Invalid stale
    // supersedes targets roll back the new write rather than creating a memory
    // with a dead supersession link.
    if (supersedes) {
      const transition = await transitionMemoryLifecycleInTx(tx as any, {
        tenantId,
        addr: supersedes,
        status: "superseded",
        actor,
        reason: "memory-write supersession",
        supersededByAddr: addr,
        correlationId: correlationId ?? null,
        enforceProtectedGuard: true,
        eventData: {
          source: "memory-write",
          new_memory_addr: addr,
        },
      });
      if (!transition.ok) {
        throw new Error(`Failed to supersede ${supersedes}: ${transition.error || "unknown error"}`);
      }
    }

    // Created event — must succeed with the node insert. F9: correlation
    // id flows into memory_events via the new column; this is the only
    // canonical lifecycle row for the create — routes MUST NOT add a
    // second `memory_events` row from an audit wrapper after writeMemory
    // returns. The operator-facing `hosted_audit_log` row IS distinct
    // and is written by the route via `auditMutation(c, sql, ...)`.
    await logEvent(
      tx as any,
      addr,
      tenantId,
      "created",
      actor,
      {
        kind,
        source,
        supersedes: supersedes || null,
        ...(isRemoteWrite ? {
          remote_origin: remoteOrigin,
          remote_client_class: remoteClientClass,
          remote_request_id: remoteRequestId,
        } : {}),
      },
      { correlationId: correlationId ?? null },
    );

    // F11: sync journal append inside the transaction so the journal row
    // commits with the parent mutation. Best-effort: a journal failure is
    // logged but does NOT roll back the write — the journal is for sync
    // ordering, not local write correctness.
    const { tryJournalMemoryInTx } = await import("./sync-journal-port");
    await tryJournalMemoryInTx(
      tx as any,
      "upsert",
      addr,
      spaceId,
      substance.project_addr as string | undefined,
      "[memory-write]",
    );

    return [{ addr }];
  })) as any[];

  // dedup-lock: the in-lock recheck collapsed onto an existing node — surface it
  // so the caller can return its deduplicated response instead of a fresh addr.
  if (result.deduplicated) {
    return {
      ok: true,
      addr: result.addr,
      deduplicated: true,
      existingLabel: result.existingLabel ?? null,
      similarity: result.similarity,
    };
  }

  return { ok: true, addr: result.addr };
}
