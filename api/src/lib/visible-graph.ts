import { sql } from "../db";
import type { AccessScope } from "./access";
import { GLOBAL_SPACE_ID } from "./spaces";
import { ARCHIVED_PYRAMIDS as CANONICAL_ARCHIVED_PYRAMIDS } from "@verity-one/graph-shape";

// Pyramids archived during structural migration (2026-03-20). They
// still exist in registry/space_pyramids for FK integrity but should
// not appear in public-facing API surfaces.
//
// F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) hoisted the canonical
// list into @verity-one/graph-shape. This module re-exports a mutable
// `string[]` view so the existing postgres.js `${ARCHIVED_PYRAMIDS}::text[]`
// templates and the `routes/{schema,connect}` importers compile without
// shape changes.
export const ARCHIVED_PYRAMIDS: string[] = [...CANONICAL_ARCHIVED_PYRAMIDS];

type VisibleGraphArgs = {
  scope: AccessScope;
  accessLevels: string[];
  spaceIds: string[];
};

export async function selectVisibleGraphCounts(args: VisibleGraphArgs) {
  const { scope, accessLevels, spaceIds } = args;
  const [row] = scope === "operator"
    ? await sql`
        SELECT
          (SELECT COUNT(*)::int FROM nodes WHERE visibility <> 'deleted') AS total_nodes,
          (
            SELECT COUNT(*)::int
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN nodes nt ON nt.addr = e.to_addr
            WHERE nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
          ) AS total_edges,
          (
            SELECT COUNT(*)::int
            FROM nodes n
            WHERE n.node_type IN ('tool','skill','workflow')
              AND n.visibility <> 'deleted'
          ) AS actionable_nodes
      `
    : await sql`
        SELECT
          (
            SELECT COUNT(*)::int
            FROM nodes n
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE n.space_id = ANY(${spaceIds}::text[])
              AND n.visibility <> 'deleted'
              AND n.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS total_nodes,
          (
            SELECT COUNT(*)::int
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = e.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE e.space_id = ANY(${spaceIds}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND nf.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND nt.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS total_edges,
          (
            SELECT COUNT(*)::int
            FROM nodes n
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE n.node_type IN ('tool','skill','workflow')
              AND n.space_id = ANY(${spaceIds}::text[])
              AND n.visibility <> 'deleted'
              AND n.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          ) AS actionable_nodes
      `;
  return row;
}

export async function selectVisiblePyramidSummaries(args: VisibleGraphArgs) {
  const { scope, accessLevels, spaceIds } = args;
  return scope === "operator"
    ? await sql`
        SELECT pyramid_id, label, description, node_count, edge_count,
               saturated, hot_regions, apex_hash, access_level,
               created_at, updated_at
        FROM registry
        WHERE pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
        ORDER BY pyramid_id
      `
    : await sql`
        SELECT
          r.pyramid_id,
          r.label,
          r.description,
          COALESCE((
            SELECT COUNT(*)
            FROM nodes n
            WHERE n.pyramid_id = r.pyramid_id
              AND n.space_id = ANY(${spaceIds}::text[])
              AND n.visibility <> 'deleted'
              AND (
                n.space_id <> ${GLOBAL_SPACE_ID}
                OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
              )
          ), 0)::int AS node_count,
          COALESCE((
            SELECT COUNT(*)
            FROM edges e
            JOIN nodes nf ON nf.addr = e.from_addr
            JOIN registry rf ON rf.pyramid_id = nf.pyramid_id
            JOIN nodes nt ON nt.addr = e.to_addr
            JOIN registry rt ON rt.pyramid_id = nt.pyramid_id
            WHERE e.space_id = ANY(${spaceIds}::text[])
              AND nf.space_id = ANY(${spaceIds}::text[])
              AND nt.space_id = ANY(${spaceIds}::text[])
              AND (nf.pyramid_id = r.pyramid_id OR nt.pyramid_id = r.pyramid_id)
              AND nf.visibility <> 'deleted'
              AND nt.visibility <> 'deleted'
              AND (
                nf.space_id <> ${GLOBAL_SPACE_ID}
                OR (nf.visibility = 'public' AND rf.access_level = ANY(${accessLevels}::text[]))
              )
              AND (
                nt.space_id <> ${GLOBAL_SPACE_ID}
                OR (nt.visibility = 'public' AND rt.access_level = ANY(${accessLevels}::text[]))
              )
          ), 0)::int AS edge_count,
          r.saturated,
          r.hot_regions,
          r.apex_hash,
          r.access_level,
          r.created_at,
          r.updated_at
        FROM registry r
        WHERE r.pyramid_id != ALL(${ARCHIVED_PYRAMIDS}::text[])
          AND (
            r.access_level = ANY(${accessLevels}::text[])
            OR EXISTS (
              SELECT 1
              FROM nodes n
              WHERE n.pyramid_id = r.pyramid_id
                AND n.space_id = ANY(${spaceIds}::text[])
                AND n.visibility <> 'deleted'
                AND n.space_id <> ${GLOBAL_SPACE_ID}
            )
          )
        ORDER BY r.pyramid_id
      `;
}
