/**
 * Persist #65 review packets into the review_proposals ledger (Tier-2 Harness-OS
 * live wiring, LW4).
 *
 * The pure selectReviewQueue (#65) produces a bounded ReviewQueue of ReviewPackets;
 * this module records each admitted packet as a durable review_proposals row so a
 * supercron pass can write them and LW5 can read them into the Today/attention
 * surface. proposal-only: a row is a "review this" note — it never applies a change.
 *
 * Two halves: a PURE packet→row mapping (reviewPacketToProposalRow — unit-testable
 * DB-free) and an idempotent writer (persistReviewQueue — INSERT ... ON CONFLICT
 * (idempotency_key) DO NOTHING, so a re-detected review collapses onto its row rather
 * than duplicating). No LLM, no apply, no read of memory content (packets are
 * identifier-only by the #65 contract).
 */

import type { Sql } from "postgres";

import {
  reviewPacketIdempotencyKey,
  type ReviewPacket,
  type ReviewQueue,
} from "./review-queue";

/** A review_proposals row, ready to INSERT. payload carries the full packet. */
export interface ReviewProposalRow {
  tenant_id: string | null;
  review_kind: ReviewPacket["review_kind"];
  candidate_source: ReviewPacket["candidate_source"];
  severity: ReviewPacket["severity"];
  /** packet.reason — identifier-only operator-readable selection reason. */
  summary: string;
  /** The full ReviewPacket (scope/budget/output_schema/verification/unknowns). */
  payload: ReviewPacket;
  /** sha256 dedup key (reviewPacketIdempotencyKey), NOT the packet's natural token. */
  idempotency_key: string;
}

/**
 * Map a ReviewPacket to its review_proposals row. PURE — no DB, no clock. The
 * idempotency_key column is the cryptographic reviewPacketIdempotencyKey() (the unique
 * index dedups on it), distinct from packet.idempotency_key (the natural token folded
 * into that hash). tenant_id comes from the packet's bounded scope.
 */
export function reviewPacketToProposalRow(packet: ReviewPacket): ReviewProposalRow {
  return {
    tenant_id: packet.scope.tenant_id,
    review_kind: packet.review_kind,
    candidate_source: packet.candidate_source,
    severity: packet.severity,
    summary: packet.reason,
    payload: packet,
    idempotency_key: reviewPacketIdempotencyKey(packet),
  };
}

export interface PersistReviewQueueResult {
  /** Packets considered (queue.packets.length). */
  total: number;
  /** Rows newly inserted. */
  inserted: number;
  /** Packets whose review already existed (idempotency_key collision). */
  skipped: number;
  /** Packets that errored during mapping/insert (malformed addr, NUL in payload, …).
   *  Tallied, never silent — one bad row never sinks the rest. */
  failed: number;
}

/**
 * Persist every packet in a ReviewQueue, idempotently. Each row is inserted with
 * ON CONFLICT (idempotency_key) DO NOTHING, so re-running a pass over the same live
 * state inserts nothing new. Write-only into review_proposals; reads nothing.
 *
 * Per-packet error isolation: reviewPacketIdempotencyKey throws on a malformed addr
 * (NUL/blank/over-long), and jsonb rejects NUL in a string — neither selectReviewQueue
 * nor this writer pre-validates. A single bad DB-sourced packet must not sink the rest,
 * so each iteration is isolated and counted in `failed` (logged + tallied, never
 * silent). inserted + skipped + failed === total.
 */
export async function persistReviewQueue(
  sql: Sql,
  queue: ReviewQueue,
): Promise<PersistReviewQueueResult> {
  let inserted = 0;
  let failed = 0;
  for (const packet of queue.packets) {
    try {
      const row = reviewPacketToProposalRow(packet);
      const result = await sql`
        INSERT INTO review_proposals
          (tenant_id, review_kind, candidate_source, severity, summary, payload, idempotency_key)
        VALUES (
          ${row.tenant_id}, ${row.review_kind}, ${row.candidate_source}, ${row.severity},
          ${row.summary}, ${sql.json(row.payload as unknown as Parameters<typeof sql.json>[0])}, ${row.idempotency_key}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted++;
    } catch (e) {
      failed++;
      console.error(
        "[review-proposal-persist] skipped a malformed packet:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const total = queue.packets.length;
  // skipped = idempotent no-ops (ON CONFLICT DO NOTHING returned 0 rows, no error).
  return { total, inserted, skipped: total - inserted - failed, failed };
}
