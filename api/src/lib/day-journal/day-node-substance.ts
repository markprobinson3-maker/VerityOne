import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;
const MAX_DAY_NODE_INTAKE_CONTENT_CHARS = 8192;

export interface AppendDayNodeIntakeEntryParams {
  dayAddr: string;
  spaceId: string;
  content: string;
}

export type AppendDayNodeIntakeEntryResult =
  | { ok: true; day_addr: string }
  | { ok: false; reason: "day_node_missing"; day_addr: string }
  | { ok: false; reason: "content_invalid"; day_addr: string }
  | { ok: false; reason: "content_too_large"; day_addr: string; max_length: number };

/**
 * Append one temporal intake string through a targeted JSONB patch.
 *
 * The UPDATE is a single PostgreSQL row mutation, so concurrent appends to
 * `substance.intake` serialize on the day-node row without app-side
 * read/merge/rewrite races. Future journal writers should use the same
 * targeted-jsonb-set pattern for `substance.journal.*` instead of replacing
 * the whole `substance` blob.
 */
export async function appendDayNodeIntakeEntry(
  tx: SqlTag,
  params: AppendDayNodeIntakeEntryParams,
): Promise<AppendDayNodeIntakeEntryResult> {
  const content = params.content.normalize("NFC");
  if (!content.trim() || content.includes("\0")) {
    return { ok: false, reason: "content_invalid", day_addr: params.dayAddr };
  }
  if (hasMoreThanCodePoints(content, MAX_DAY_NODE_INTAKE_CONTENT_CHARS)) {
    return {
      ok: false,
      reason: "content_too_large",
      day_addr: params.dayAddr,
      max_length: MAX_DAY_NODE_INTAKE_CONTENT_CHARS,
    };
  }

  const rows = await tx`
    UPDATE nodes
    SET substance = jsonb_set(
          COALESCE(substance, '{}'::jsonb),
          '{intake}',
          COALESCE(
            CASE
              WHEN jsonb_typeof(COALESCE(substance, '{}'::jsonb)->'intake') = 'array'
              THEN COALESCE(substance, '{}'::jsonb)->'intake'
              ELSE '[]'::jsonb
            END,
            '[]'::jsonb
          ) || ${tx.json([content])}::jsonb,
          true
        ),
        updated_at = now()
    WHERE addr = ${params.dayAddr}
      AND space_id = ${params.spaceId}
      AND node_type = 'day'
      AND visibility <> 'deleted'
    RETURNING addr
  `;
  if (rows.length === 0) {
    return { ok: false, reason: "day_node_missing", day_addr: params.dayAddr };
  }
  return { ok: true, day_addr: String(rows[0].addr) };
}

function hasMoreThanCodePoints(value: string, maxChars: number): boolean {
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > maxChars) return true;
  }
  return false;
}
