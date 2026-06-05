/**
 * Canonical edge mutation helper — single source of truth for runtime
 * edge writes. F12 (rung 12 of VO-FOUNDATION-HARDENING-LADDER-1)
 * introduces this helper as the migration target for inline
 * `INSERT INTO edges` / `UPDATE edges` / `DELETE FROM edges` sites so:
 *
 *   - edge_type is canonicalized via `canonicalizeEdgeType()` from
 *     @verity-one/graph-shape (single alias map, no per-caller drift)
 *   - self-loops are rejected before the SQL hits Postgres (matches the
 *     `edges_no_self_loop` CHECK)
 *   - edge_type is non-blank, and labels are either caller-supplied or
 *     delegated to the canonical `edge_label_fill` trigger (matches the
 *     `edges_nonblank_label` / `edges_nonblank_type` CHECKs)
 *   - source_context and provenance are JSON objects (matches the
 *     `edges_provenance_object` / `edges_source_context_object` CHECKs)
 *   - space_id is set deliberately, never accepting the implicit 'global'
 *     default by accident
 *   - sync journal best-effort append happens inside the same transaction
 *     via `tryJournalEdgeInTx`
 *   - destructive updates and deletes journal the OLD tuple before the
 *     mutation, so sync consumers see what changed
 *   - callers have a shared redaction helper before audit metadata is
 *     passed to `auditMutation`, so raw bodies, tokens, embeddings, and PII
 *     never reach `hosted_audit_log.event_data`
 *
 * Edge hash construction stays out of scope (see F12 plan Q6 / non-goals).
 * The helper preserves the caller-provided hash; if the caller doesn't
 * supply one, the helper computes a deterministic md5 from the canonical
 * tuple parts (existing legacy behavior in supercron / memory routes).
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  canonicalizeEdgeType,
  type KnownEdgeType,
} from "@verity-one/graph-shape";
import { tryJournalEdgeInTx } from "./sync-journal-port";

type SqlTag = ReturnType<typeof postgres>;

// ── Audit redaction ────────────────────────────────────────────────
// Whitelist of fields that may flow into hosted_audit_log.event_data.
// Anything else (raw bodies, tokens, embeddings, source text, PII) is
// dropped silently before audit emit. F12 Q14.
const AUDIT_EVENT_DATA_ALLOWED_KEYS = new Set<string>([
  "edge_type",
  "from_addr",
  "to_addr",
  "space_id",
  "edge_count",
  "removed_count",
  "added_count",
  "label_length",
  "operation",
  "reason",
  "source",
  "rationale",
]);

export function redactAuditEventData(
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!AUDIT_EVENT_DATA_ALLOWED_KEYS.has(k)) continue;
    // Cap any string field at 200 chars to prevent accidental dumps.
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Errors ─────────────────────────────────────────────────────────

export class InvalidEdgeError extends Error {
  constructor(message: string, public readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "InvalidEdgeError";
  }
}

// ── Canonical INSERT ───────────────────────────────────────────────

export interface EdgeWriteParams {
  fromAddr: string;
  toAddr: string;
  edgeType: string;
  label?: string | null;
  layer?: number;
  confidence?: number;
  weight?: number;
  bidirectional?: boolean;
  hash?: string;
  provenance?: Record<string, unknown>;
  sourceContext?: Record<string, unknown>;
  spaceId?: string;
  fromSpaceId?: string;
  toSpaceId?: string;
}

export interface EdgeMutationOpts {
  /** Hono context for F9 audit row + correlation_id. Optional. */
  c?: any;
  /** Existing transaction handle. If omitted, the helper opens its own. */
  tx?: SqlTag;
  /** Reason string for audit metadata (already filtered/redacted). */
  reason?: string;
  /** Skip journal append — only legitimate for backfills. Drift-pinned. */
  journalExempt?: boolean;
}

export type EdgeConflictUpdateMode = "replaceMetadata" | "mergeRoles";

function canonicalEdgeHash(fromAddr: string, edgeType: string, toAddr: string): string {
  return createHash("md5").update(`${fromAddr}|${edgeType}|${toAddr}`).digest("hex");
}

function ensureCanonicalEdgeType(rawType: string): KnownEdgeType {
  const canonical = canonicalizeEdgeType(rawType);
  if (!canonical) {
    throw new InvalidEdgeError(
      `edge_type "${rawType}" is not canonical and has no alias mapping. ` +
      `See VALID_EDGE_TYPES + EDGE_TYPE_ALIASES in @verity-one/graph-shape.`,
      { edge_type: rawType },
    );
  }
  return canonical;
}

function ensureValidParams(p: EdgeWriteParams): void {
  if (!p.fromAddr || !p.toAddr) {
    throw new InvalidEdgeError("fromAddr and toAddr are required (non-empty)");
  }
  if (p.fromAddr === p.toAddr) {
    throw new InvalidEdgeError("self-loop edge rejected: fromAddr === toAddr", {
      from_addr: p.fromAddr,
      to_addr: p.toAddr,
    });
  }
  if (!p.edgeType || p.edgeType.trim() === "") {
    throw new InvalidEdgeError("edge_type must be non-blank");
  }
  if (p.confidence != null && (p.confidence < 0 || p.confidence > 1)) {
    throw new InvalidEdgeError("confidence out of [0,1] range", {
      confidence: p.confidence,
    });
  }
  if (p.weight != null && p.weight <= 0) {
    throw new InvalidEdgeError("weight must be > 0", { weight: p.weight });
  }
}

type NormalizedEdgeWrite = {
  canonicalType: KnownEdgeType;
  layer: number;
  confidence: number;
  weight: number;
  bidirectional: boolean;
  hash: string;
  label: string | null;
  provenance: Record<string, unknown>;
  sourceContext: Record<string, unknown>;
  spaceId: string;
  fromSpaceId: string;
  toSpaceId: string;
};

function normalizeEdgeWriteParams(params: EdgeWriteParams): NormalizedEdgeWrite {
  ensureValidParams(params);
  const canonicalType = ensureCanonicalEdgeType(params.edgeType);
  const spaceId = params.spaceId ?? "global";
  return {
    canonicalType,
    layer: params.layer ?? 0,
    confidence: params.confidence ?? 0.5,
    weight: params.weight ?? 1.0,
    bidirectional: params.bidirectional ?? false,
    hash: params.hash ?? canonicalEdgeHash(params.fromAddr, canonicalType, params.toAddr),
    label: params.label && params.label.trim() !== "" ? params.label.trim() : null,
    provenance: params.provenance ?? {},
    sourceContext: params.sourceContext ?? {},
    spaceId,
    fromSpaceId: params.fromSpaceId ?? spaceId,
    toSpaceId: params.toSpaceId ?? spaceId,
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Insert an edge with canonical edge_type, validation, and best-effort
 * sync journal append inside the same transaction. Returns the canonical
 * edge_type that was actually written.
 *
 * On UNIQUE conflict (same (from_addr, to_addr, edge_type) tuple), the
 * helper does ON CONFLICT DO NOTHING and still journals the upsert.
 */
export async function writeEdge(
  sql: SqlTag,
  params: EdgeWriteParams,
  opts: EdgeMutationOpts = {},
): Promise<{ edgeType: KnownEdgeType; inserted: boolean }> {
  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => writeEdge(sql, params, { ...opts, tx: tx as any }));
    }
    return writeEdge(sql, params, { ...opts, tx: sql as any });
  }

  const tx = opts.tx;
  const normalized = normalizeEdgeWriteParams(params);

  const inserted = await tx`
    INSERT INTO edges (
      from_addr, to_addr, edge_type, layer, label,
      confidence, weight, bidirectional, hash,
      provenance, source_context,
      space_id, from_space_id, to_space_id
    )
    VALUES (
      ${params.fromAddr}, ${params.toAddr}, ${normalized.canonicalType}, ${normalized.layer}, ${normalized.label},
      ${normalized.confidence}, ${normalized.weight}, ${normalized.bidirectional}, ${normalized.hash},
      ${tx.json(normalized.provenance as any)}, ${tx.json(normalized.sourceContext as any)},
      ${normalized.spaceId}, ${normalized.fromSpaceId}, ${normalized.toSpaceId}
    )
    ON CONFLICT (from_addr, to_addr, edge_type) DO NOTHING
    RETURNING 1
  `;

  if (inserted.length > 0 && !opts.journalExempt) {
    await tryJournalEdgeInTx(
      tx,
      "upsert",
      params.fromAddr,
      normalized.canonicalType,
      params.toAddr,
      normalized.spaceId,
      "[edge-mutations:write]",
    );
  }

  return { edgeType: normalized.canonicalType, inserted: inserted.length > 0 };
}

/**
 * Insert-or-update an edge when the producer's conflict semantics carry
 * information. Use `replaceMetadata` for authoritative rewrites and
 * `mergeRoles` for temporal/preliminary edges that accumulate source roles.
 */
export async function upsertEdge(
  sql: SqlTag,
  params: EdgeWriteParams,
  opts: EdgeMutationOpts & { conflictUpdate?: EdgeConflictUpdateMode } = {},
): Promise<{ edgeType: KnownEdgeType }> {
  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => upsertEdge(sql, params, { ...opts, tx: tx as any }));
    }
    return upsertEdge(sql, params, { ...opts, tx: sql as any });
  }

  const tx = opts.tx;
  const normalized = normalizeEdgeWriteParams(params);
  const conflictUpdate = opts.conflictUpdate ?? "replaceMetadata";

  if (conflictUpdate === "mergeRoles") {
    await tx`
      INSERT INTO edges (
        from_addr, to_addr, edge_type, layer, label,
        confidence, weight, bidirectional, hash,
        provenance, source_context,
        space_id, from_space_id, to_space_id
      )
      VALUES (
        ${params.fromAddr}, ${params.toAddr}, ${normalized.canonicalType}, ${normalized.layer}, ${normalized.label},
        ${normalized.confidence}, ${normalized.weight}, ${normalized.bidirectional}, ${normalized.hash},
        ${tx.json(normalized.provenance as any)}, ${tx.json(normalized.sourceContext as any)},
        ${normalized.spaceId}, ${normalized.fromSpaceId}, ${normalized.toSpaceId}
      )
      ON CONFLICT (from_addr, to_addr, edge_type) DO UPDATE SET
        confidence = GREATEST(edges.confidence, EXCLUDED.confidence),
        weight = GREATEST(edges.weight, EXCLUDED.weight),
        source_context = jsonb_set(edges.source_context, '{roles}',
          (SELECT jsonb_agg(DISTINCT val) FROM (
            SELECT jsonb_array_elements_text(COALESCE(edges.source_context->'roles', '[]'::jsonb)) AS val
            UNION SELECT jsonb_array_elements_text(COALESCE(EXCLUDED.source_context->'roles', '[]'::jsonb)) AS val
          ) combined)),
        updated_at = now()
    `;
  } else {
    await tx`
      INSERT INTO edges (
        from_addr, to_addr, edge_type, layer, label,
        confidence, weight, bidirectional, hash,
        provenance, source_context,
        space_id, from_space_id, to_space_id
      )
      VALUES (
        ${params.fromAddr}, ${params.toAddr}, ${normalized.canonicalType}, ${normalized.layer}, ${normalized.label},
        ${normalized.confidence}, ${normalized.weight}, ${normalized.bidirectional}, ${normalized.hash},
        ${tx.json(normalized.provenance as any)}, ${tx.json(normalized.sourceContext as any)},
        ${normalized.spaceId}, ${normalized.fromSpaceId}, ${normalized.toSpaceId}
      )
      ON CONFLICT (from_addr, to_addr, edge_type) DO UPDATE SET
        confidence = GREATEST(edges.confidence, EXCLUDED.confidence),
        weight = GREATEST(edges.weight, EXCLUDED.weight),
        label = COALESCE(EXCLUDED.label, edges.label),
        provenance = EXCLUDED.provenance,
        source_context = EXCLUDED.source_context,
        space_id = EXCLUDED.space_id,
        from_space_id = EXCLUDED.from_space_id,
        to_space_id = EXCLUDED.to_space_id,
        updated_at = now()
    `;
  }

  if (!opts.journalExempt) {
    await tryJournalEdgeInTx(
      tx,
      "upsert",
      params.fromAddr,
      normalized.canonicalType,
      params.toAddr,
      normalized.spaceId,
      "[edge-mutations:upsert]",
    );
  }

  return { edgeType: normalized.canonicalType };
}

/**
 * Delete an edge by tuple. Snapshots and journals the old (from, type, to)
 * before the DELETE so sync consumers see the tombstone.
 */
export async function deleteEdge(
  sql: SqlTag,
  fromAddr: string,
  toAddr: string,
  edgeType: string,
  opts: EdgeMutationOpts & { spaceId?: string } = {},
): Promise<{ deleted: boolean }> {
  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => deleteEdge(sql, fromAddr, toAddr, edgeType, { ...opts, tx: tx as any }));
    }
    return deleteEdge(sql, fromAddr, toAddr, edgeType, { ...opts, tx: sql as any });
  }

  const canonicalType = ensureCanonicalEdgeType(edgeType);
  const tx = opts.tx;

  // Pre-read for journal tombstone.
  const [existing] = await tx`
    SELECT space_id FROM edges
    WHERE from_addr = ${fromAddr} AND to_addr = ${toAddr} AND edge_type = ${canonicalType}
    LIMIT 1
  `;
  if (!existing) {
    return { deleted: false };
  }

  await tx`
    DELETE FROM edges
    WHERE from_addr = ${fromAddr} AND to_addr = ${toAddr} AND edge_type = ${canonicalType}
  `;

  if (!opts.journalExempt) {
    await tryJournalEdgeInTx(
      tx,
      "delete",
      fromAddr,
      canonicalType,
      toAddr,
      String(existing.space_id ?? opts.spaceId ?? "global"),
      "[edge-mutations:delete]",
    );
  }

  return { deleted: true };
}

/**
 * Delete a bounded set of edge rows by id while journaling each old tuple.
 * Use this for cleanup queries that first identify a set with custom SQL.
 */
export async function deleteEdgesByIds(
  sql: SqlTag,
  edgeIds: Array<number | string>,
  opts: EdgeMutationOpts = {},
): Promise<{ deleted: number }> {
  const ids = [...new Set(edgeIds.map((id) => String(id)).filter(Boolean))];
  if (ids.length === 0) return { deleted: 0 };

  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => deleteEdgesByIds(sql, ids, { ...opts, tx: tx as any }));
    }
    return deleteEdgesByIds(sql, ids, { ...opts, tx: sql as any });
  }

  const tx = opts.tx;
  const rows = await tx`
    SELECT id, from_addr, to_addr, edge_type, space_id
    FROM edges
    WHERE id = ANY(${ids}::bigint[])
  `;
  if (rows.length === 0) return { deleted: 0 };

  await tx`
    DELETE FROM edges
    WHERE id = ANY(${rows.map((row: any) => String(row.id))}::bigint[])
  `;

  if (!opts.journalExempt) {
    for (const row of rows) {
      await tryJournalEdgeInTx(
        tx,
        "delete",
        String(row.from_addr),
        String(row.edge_type),
        String(row.to_addr),
        String(row.space_id ?? "global"),
        "[edge-mutations:delete-by-id]",
      );
    }
  }

  return { deleted: rows.length };
}

/**
 * Rewrite a bounded set of edge rows to a canonical edge_type. This replaces
 * direct `UPDATE edges SET edge_type = ...` repair jobs with delete + upsert
 * so sync consumers receive the old tombstone and the new canonical tuple.
 * Existing target tuple conflicts are merged with `replaceMetadata` semantics
 * instead of raising halfway through a maintenance pass.
 */
export async function rewriteEdgeTypeByIds(
  sql: SqlTag,
  edgeIds: Array<number | string>,
  nextEdgeType: string,
  opts: EdgeMutationOpts = {},
): Promise<{ rewritten: number; skipped: number }> {
  const ids = [...new Set(edgeIds.map((id) => String(id)).filter(Boolean))];
  if (ids.length === 0) return { rewritten: 0, skipped: 0 };

  const canonicalType = ensureCanonicalEdgeType(nextEdgeType);

  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => rewriteEdgeTypeByIds(sql, ids, canonicalType, { ...opts, tx: tx as any }));
    }
    return rewriteEdgeTypeByIds(sql, ids, canonicalType, { ...opts, tx: sql as any });
  }

  const tx = opts.tx;
  const rows = await tx`
    SELECT id, from_addr, to_addr, edge_type, layer, label,
           confidence, weight, bidirectional, hash,
           provenance, source_context,
           space_id, from_space_id, to_space_id
    FROM edges
    WHERE id = ANY(${ids}::bigint[])
  `;

  let rewritten = 0;
  let skipped = 0;
  for (const row of rows) {
    if (String(row.edge_type) === canonicalType) {
      skipped++;
      continue;
    }

    await deleteEdgesByIds(sql, [row.id], { ...opts, tx });
    await upsertEdge(sql, {
      fromAddr: String(row.from_addr),
      toAddr: String(row.to_addr),
      edgeType: canonicalType,
      layer: Number(row.layer ?? 0),
      label: row.label == null ? null : String(row.label),
      confidence: Number(row.confidence ?? 0.5),
      weight: Number(row.weight ?? 1),
      bidirectional: Boolean(row.bidirectional),
      hash: row.hash == null
        ? canonicalEdgeHash(String(row.from_addr), canonicalType, String(row.to_addr))
        : String(row.hash),
      provenance: asJsonObject(row.provenance),
      sourceContext: asJsonObject(row.source_context),
      spaceId: String(row.space_id ?? "global"),
      fromSpaceId: String(row.from_space_id ?? row.space_id ?? "global"),
      toSpaceId: String(row.to_space_id ?? row.space_id ?? "global"),
    }, { ...opts, tx, conflictUpdate: "replaceMetadata" });
    rewritten++;
  }

  skipped += ids.length - rows.length;
  return { rewritten, skipped };
}

/**
 * Snapshot affected edges before a destructive node delete so the journal
 * sees individual edge tombstones rather than silent FK cascade. Caller is
 * responsible for the actual `DELETE FROM nodes`. Returns the count of
 * tombstones journaled.
 */
export async function journalAffectedEdgesForNodeDelete(
  sql: SqlTag,
  nodeAddr: string,
  opts: EdgeMutationOpts = {},
): Promise<{ tombstoned: number }> {
  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => journalAffectedEdgesForNodeDelete(sql, nodeAddr, { ...opts, tx: tx as any }));
    }
    return journalAffectedEdgesForNodeDelete(sql, nodeAddr, { ...opts, tx: sql as any });
  }

  const tx = opts.tx;
  const rows = await tx`
    SELECT from_addr, to_addr, edge_type, space_id
    FROM edges
    WHERE from_addr = ${nodeAddr} OR to_addr = ${nodeAddr}
  `;
  for (const r of rows) {
    await tryJournalEdgeInTx(
      tx,
      "delete",
      String(r.from_addr),
      String(r.edge_type),
      String(r.to_addr),
      String(r.space_id ?? "global"),
      "[edge-mutations:cascade]",
    );
  }
  return { tombstoned: rows.length };
}

/**
 * Rewire all edges that reference `loserAddr` so they reference `winnerAddr`.
 * The helper journals old tuples as deletes and surviving mapped tuples as
 * upserts. It also removes conflicts/self-loops before the UPDATE so the
 * `(from_addr, to_addr, edge_type)` UNIQUE constraint is not violated.
 */
export async function rewireEdgesForNodeMerge(
  sql: SqlTag,
  loserAddr: string,
  winnerAddr: string,
  opts: EdgeMutationOpts = {},
): Promise<{ oldTuples: number; newTuples: number }> {
  if (!opts.tx) {
    const begin = (sql as any).begin;
    if (typeof begin === "function") {
      return begin.call(sql, (tx: SqlTag) => rewireEdgesForNodeMerge(sql, loserAddr, winnerAddr, { ...opts, tx: tx as any }));
    }
    return rewireEdgesForNodeMerge(sql, loserAddr, winnerAddr, { ...opts, tx: sql as any });
  }

  if (!loserAddr || !winnerAddr) {
    throw new InvalidEdgeError("loserAddr and winnerAddr are required (non-empty)");
  }
  if (loserAddr === winnerAddr) {
    throw new InvalidEdgeError("node merge rewire rejected: loserAddr === winnerAddr", {
      loser_addr: loserAddr,
      winner_addr: winnerAddr,
    });
  }

  const tx = opts.tx;
  const rows = await tx`
    SELECT from_addr, to_addr, edge_type, space_id
    FROM edges
    WHERE from_addr = ${loserAddr} OR to_addr = ${loserAddr}
  `;

  const mapped = new Map<string, { fromAddr: string; toAddr: string; edgeType: string; spaceId: string }>();
  for (const r of rows) {
    const oldFrom = String(r.from_addr);
    const oldTo = String(r.to_addr);
    const edgeType = String(r.edge_type);
    const spaceId = String(r.space_id ?? "global");

    if (!opts.journalExempt) {
      await tryJournalEdgeInTx(
        tx,
        "delete",
        oldFrom,
        edgeType,
        oldTo,
        spaceId,
        "[edge-mutations:rewire:old]",
      );
    }

    const fromAddr = oldFrom === loserAddr ? winnerAddr : oldFrom;
    const toAddr = oldTo === loserAddr ? winnerAddr : oldTo;
    if (fromAddr === toAddr) continue;
    mapped.set(`${fromAddr}\u0000${edgeType}\u0000${toAddr}`, { fromAddr, toAddr, edgeType, spaceId });
  }

  await tx`
    DELETE FROM edges e
    WHERE e.from_addr = ${loserAddr}
      AND (
        e.to_addr = ${winnerAddr}
        OR EXISTS (
          SELECT 1 FROM edges existing
          WHERE existing.from_addr = ${winnerAddr}
            AND existing.to_addr = e.to_addr
            AND existing.edge_type = e.edge_type
        )
      )
  `;

  await tx`
    DELETE FROM edges e
    WHERE e.to_addr = ${loserAddr}
      AND (
        e.from_addr = ${winnerAddr}
        OR EXISTS (
          SELECT 1 FROM edges existing
          WHERE existing.to_addr = ${winnerAddr}
            AND existing.from_addr = e.from_addr
            AND existing.edge_type = e.edge_type
        )
      )
  `;

  await tx`
    UPDATE edges
    SET from_addr = ${winnerAddr}, updated_at = now()
    WHERE from_addr = ${loserAddr}
      AND to_addr <> ${winnerAddr}
  `;

  await tx`
    UPDATE edges
    SET to_addr = ${winnerAddr}, updated_at = now()
    WHERE to_addr = ${loserAddr}
      AND from_addr <> ${winnerAddr}
  `;

  await tx`DELETE FROM edges WHERE from_addr = to_addr`;
  await tx`
    DELETE FROM edges a USING edges b
    WHERE a.id > b.id
      AND a.from_addr = b.from_addr
      AND a.to_addr = b.to_addr
      AND a.edge_type = b.edge_type
  `;

  if (!opts.journalExempt) {
    for (const next of mapped.values()) {
      await tryJournalEdgeInTx(
        tx,
        "upsert",
        next.fromAddr,
        next.edgeType,
        next.toAddr,
        next.spaceId,
        "[edge-mutations:rewire:new]",
      );
    }
  }

  return { oldTuples: rows.length, newTuples: mapped.size };
}
