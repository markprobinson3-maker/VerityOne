import { sql } from "../db";
import { shouldSurfaceReviewedSkills } from "./retrieval-intent";

export type RetrievedSkill = {
  id: number;
  content: string;
  source_url: string | null;
  skill_type: string | null;
  status: string;
  skill_path: string | null;
  reviewed_at: string | null;
  created_at: string | null;
  quality_scores: Record<string, unknown> | null;
  text_rank: number;
};

export async function selectRelevantSkills(
  query: string,
  options: { limit?: number; includeNeedsHuman?: boolean } = {},
): Promise<RetrievedSkill[]> {
  const normalized = query.trim();
  if (!normalized || !shouldSurfaceReviewedSkills(normalized)) return [];

  const statuses = options.includeNeedsHuman
    ? ["auto_approved", "approved", "active", "needs_human"]
    : ["auto_approved", "approved", "active"];

  const rows = await sql`
    SELECT
      id,
      content,
      source_url,
      skill_type,
      status,
      skill_path,
      reviewed_at,
      created_at,
      quality_scores,
      CASE
        WHEN lower(content) = lower(${normalized}) THEN 5
        WHEN content ILIKE ${normalized + "%"} THEN 4
        WHEN content ILIKE ${"%" + normalized + "%"} THEN 3
        WHEN draft_md ILIKE ${"%" + normalized + "%"} THEN 2
        ELSE 1
      END AS text_rank
    FROM wi_skill_proposals
    WHERE status = ANY(${statuses}::text[])
      AND (
        content ILIKE ${"%" + normalized + "%"}
        OR draft_md ILIKE ${"%" + normalized + "%"}
      )
    ORDER BY text_rank DESC, COALESCE(reviewed_at, created_at) DESC
    LIMIT ${Math.max(1, Math.min(options.limit || 3, 8))}
  `;

  return rows.map((row: any) => ({
    ...row,
    text_rank: Number(row.text_rank || 0),
    quality_scores: row.quality_scores && typeof row.quality_scores === "object"
      ? row.quality_scores
      : null,
  }));
}
