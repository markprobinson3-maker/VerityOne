/**
 * Public resonance enrichment for the `active` tier.
 *
 * When machine `public_resonance=active` and the agent's effective
 * recall_scope allows public content, this helper queries the public
 * graph for nodes semantically related to the recall query and returns
 * an advisory block that the recall route attaches alongside (never
 * inside) the tenant-private recall result.
 *
 * Every item carries `authority: "public_overlay"` so agents cannot
 * mistake it for tenant-private memory. No writes, no persistence.
 *
 * Per PUBLIC-RESONANCE-ACTIVE-DESIGN-PR-1:
 *   - cap at 5 items
 *   - minimum relevance 0.5
 *   - only public global nodes (space_id=global, visibility=public)
 *   - reuses the embedding the recall compiler already computed
 */

import type { Sql } from "postgres";
import { toVectorStr } from "./embed";
import { GLOBAL_SPACE_ID } from "./spaces";

export interface PublicResonanceItem {
  addr: string;
  label: string;
  pyramid: string;
  node_type: string;
  relevance: number;
  authority: "public_overlay";
  hint: string;
}

export interface PublicResonanceBlock {
  enabled: true;
  items: PublicResonanceItem[];
  count: number;
  note: string;
}

const MAX_ITEMS = 5;
const MIN_RELEVANCE = 0.5;

/**
 * Query public global nodes by vector similarity to the recall embedding.
 * Joins `registry` and filters by `access_level` to match the same
 * visibility model that `/search` and `/context` use — a public node
 * is only readable if its pyramid's registry entry has an access_level
 * the caller is allowed to see.
 *
 * @param accessLevels - allowed registry access levels for the caller
 *   (from `allowedRegistryAccessLevels(c)`). For beta scope: ["public","shared"].
 */
export async function enrichWithPublicResonance(
  sql: Sql,
  embedding: number[],
  accessLevels: string[],
): Promise<PublicResonanceBlock | null> {
  const vecStr = toVectorStr(embedding);

  const rows = await sql`
    SELECT
      n.addr,
      n.label,
      n.pyramid_id,
      n.node_type,
      1 - (n.embedding_hv <=> ${vecStr}::halfvec) as similarity
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.space_id = ${GLOBAL_SPACE_ID}
      AND n.visibility = 'public'
      AND r.access_level = ANY(${accessLevels}::text[])
      AND n.embedding_hv IS NOT NULL
      AND n.dormant_at IS NULL
    ORDER BY n.embedding_hv <=> ${vecStr}::halfvec
    LIMIT ${MAX_ITEMS}
  `;

  const items: PublicResonanceItem[] = [];
  for (const row of rows) {
    const relevance = parseFloat(row.similarity);
    if (relevance < MIN_RELEVANCE) continue;
    items.push({
      addr: row.addr,
      label: row.label,
      pyramid: row.pyramid_id,
      node_type: row.node_type || "concept",
      relevance: Math.round(relevance * 100) / 100,
      authority: "public_overlay",
      hint: "Related public knowledge — not a tenant memory",
    });
  }

  if (items.length === 0) return null;

  return {
    enabled: true,
    items,
    count: items.length,
    note: "Public graph nodes related to this recall query. Advisory only — not tenant memory.",
  };
}
