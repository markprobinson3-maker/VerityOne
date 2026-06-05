import {
  ALIGNMENT_SKIP_PYRAMIDS,
  DURABLE_ALIGNMENT_REFRESH_PYRAMIDS,
  ONTOLOGY_BRIDGE_PYRAMIDS,
  type KnownPyramidId,
} from "@verity-one/graph-shape";
import { findOntologyBranchByAddr, suggestDurableOntologyTarget } from "./ontology";
import { planFunctionalAlignment, type FunctionalAlignmentCandidate } from "./functional-alignment";
import { planWorldAlignment, type WorldAlignmentCandidate } from "./world-alignment";
import { deleteEdgesByIds, upsertEdge } from "./edge-mutations";

type SqlTag = any;

const ALIGNMENT_DELETE_VERSIONS = [
  "functional-align-v1",
  "world-align-v1",
  "functional-align-v2",
  "world-align-v2",
  "durable-resonance-v1",
] as const;
const ALIGNMENT_VERSION_BY_AXIS = {
  function: "functional-align-v2",
  world: "world-align-v2",
} as const;
const GLOBAL_SPACE_ID = "global";
const ACTIONABLE_NODE_TYPES = new Set(["tool", "skill", "workflow", "procedure", "protocol"]);
const FUNCTIONAL_NODE_HINTS = new Set(["tool", "skill", "workflow", "procedure", "protocol", "anti-pattern"]);
const RESONANCE_VERSION = "durable-resonance-v1";
const RESONANCE_STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "into", "through", "their", "there", "about", "have",
  "what", "when", "where", "which", "while", "being", "under", "using", "used", "than", "then", "were",
  "been", "will", "would", "shall", "should", "does", "did", "across", "between", "within", "into",
  "after", "before", "each", "such", "more", "most", "less", "some", "many", "over", "also", "only",
  "because", "these", "those", "them", "they", "your", "ours", "ourselves", "concept", "model", "theory",
]);

export interface DurableAlignmentCandidate {
  addr: string;
  pyramid_id: string;
  depth?: number | null;
  label: string;
  node_type?: string | null;
  description?: string | null;
  parent_addr?: string | null;
  space_id?: string | null;
}

export interface DurableAlignmentResult {
  deleted: number;
  inserted: number;
  applied: Array<{
    version: typeof ALIGNMENT_DELETE_VERSIONS[number];
    axis: "function" | "world";
    role: "primary_anchor" | "resonance";
    targetAddr: string;
    edgeType: string;
    label: string;
    reason: string;
  }>;
}

function alignmentHash(fromAddr: string, toAddr: string, edgeType: string, version: string): string {
  return Bun.hash(`${fromAddr}|${toAddr}|${edgeType}|${version}`).toString(16);
}

function compactText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => `${part || ""}`.trim())
    .filter(Boolean)
    .join("\n");
}

function inferActionability(candidate: DurableAlignmentCandidate): number {
  const nodeType = (candidate.node_type || "").toLowerCase();
  if (ACTIONABLE_NODE_TYPES.has(nodeType)) return 5;
  if (nodeType === "anti-pattern") return 4;
  return 2;
}

function renderAlignmentLabel(
  sourceLabel: string,
  targetLabel: string,
  edgeType: string,
  role: "primary_anchor" | "resonance",
): string {
  if (role === "primary_anchor") {
    return `${sourceLabel} ${edgeType} ${targetLabel} as its primary ontology anchor.`;
  }
  return `${sourceLabel} ${edgeType} ${targetLabel} as a resonant parallel meaning.`;
}

function tokenizeMeaningText(text: string): string[] {
  const terms = Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 4 && !RESONANCE_STOP_WORDS.has(term)),
  ));
  return terms.slice(0, 10);
}

function meaningOverlapScore(sourceTerms: string[], target: string): number {
  const lower = target.toLowerCase();
  let score = 0;
  for (const term of sourceTerms) {
    if (lower.includes(term)) score += term.length >= 8 ? 1.25 : 1;
  }
  return score;
}

function renderResonanceLabel(sourceLabel: string, targetLabel: string, edgeType: string, reason: string): string {
  switch (edgeType) {
    case "mirrors":
      return `${sourceLabel} mirrors ${targetLabel} through ${reason}.`;
    case "grounds":
      return `${sourceLabel} grounds ${targetLabel} through ${reason}.`;
    case "frames":
      return `${sourceLabel} frames ${targetLabel} through ${reason}.`;
    case "operationalizes":
      return `${sourceLabel} operationalizes ${targetLabel} through ${reason}.`;
    case "constrains":
      return `${sourceLabel} constrains ${targetLabel} through ${reason}.`;
    default:
      return `${sourceLabel} informs ${targetLabel} through ${reason}.`;
  }
}

function choosePrimaryAxis(
  candidate: DurableAlignmentCandidate,
  plans: Array<{ axis: "function" | "world"; targetAddr: string }>,
): "function" | "world" | null {
  if (plans.length === 0) return null;
  if (plans.length === 1) return plans[0].axis;

  const suggestion = suggestDurableOntologyTarget({
    content: compactText([candidate.label, candidate.description]),
    nodeType: candidate.node_type || "concept",
    actionability: inferActionability(candidate),
    includeLocalPyramids: false,
  });

  if (suggestion.parentAddr) {
    const exact = plans.find((plan) => plan.targetAddr === suggestion.parentAddr);
    if (exact) return exact.axis;
  }

  if (suggestion.pyramidId === "FUNCTION" && plans.some((plan) => plan.axis === "function")) {
    return "function";
  }
  if (suggestion.pyramidId === "WORLD" && plans.some((plan) => plan.axis === "world")) {
    return "world";
  }

  const nodeType = (candidate.node_type || "").toLowerCase();
  if (FUNCTIONAL_NODE_HINTS.has(nodeType) && plans.some((plan) => plan.axis === "function")) {
    return "function";
  }
  if (plans.some((plan) => plan.axis === "world")) {
    return "world";
  }
  return plans[0].axis;
}

function shouldSkipAlignmentCandidate(candidate: DurableAlignmentCandidate): boolean {
  const pyramidId = (candidate.pyramid_id || "").toUpperCase();
  if (ALIGNMENT_SKIP_PYRAMIDS.has(pyramidId as KnownPyramidId)) return true;
  if (pyramidId === "WORLD" || pyramidId === "FUNCTION") {
    const ontologyBranch = findOntologyBranchByAddr(candidate.addr);
    if (ontologyBranch && Number(candidate.depth || 0) <= 2) return true;
  }
  return false;
}

function buildPlans(candidate: DurableAlignmentCandidate): Array<{
  version: typeof ALIGNMENT_DELETE_VERSIONS[number];
  axis: "function" | "world";
  role: "primary_anchor" | "resonance";
  targetAddr: string;
  edgeType: string;
  label: string;
  reason: string;
}> {
  const plans: Array<{
    version: typeof ALIGNMENT_DELETE_VERSIONS[number];
    axis: "function" | "world";
    targetAddr: string;
    edgeType: string;
    label: string;
    reason: string;
  }> = [];
  const sourcePyramid = (candidate.pyramid_id || "").toUpperCase();
  const sourceNodeType = (candidate.node_type || "").toLowerCase();
  const sourceIsActionable = ACTIONABLE_NODE_TYPES.has(sourceNodeType) || sourceNodeType === "anti-pattern";

  const functionalPlan = sourcePyramid === "WORLD" && !sourceIsActionable
    ? null
    : planFunctionalAlignment(candidate as FunctionalAlignmentCandidate);
  if (functionalPlan) {
    plans.push({
      version: ALIGNMENT_VERSION_BY_AXIS.function,
      axis: "function",
      targetAddr: functionalPlan.targetAddr,
      edgeType: functionalPlan.edgeType,
      label: functionalPlan.label,
      reason: functionalPlan.reason,
    });
  }

  const worldPlan = sourcePyramid === "FUNCTION" && sourceIsActionable
    ? null
    : planWorldAlignment(candidate as WorldAlignmentCandidate);
  if (worldPlan) {
    plans.push({
      version: ALIGNMENT_VERSION_BY_AXIS.world,
      axis: "world",
      targetAddr: worldPlan.targetAddr,
      edgeType: worldPlan.edgeType,
      label: worldPlan.label,
      reason: worldPlan.reason,
    });
  }

  const primaryAxis = choosePrimaryAxis(candidate, plans);
  return plans
    .map((plan) => ({
      ...plan,
      role: plan.axis === primaryAxis ? "primary_anchor" as const : "resonance" as const,
    }))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "primary_anchor" ? -1 : 1;
      return a.axis.localeCompare(b.axis);
    });
}

type ResonanceRow = {
  addr: string;
  label: string;
  pyramid_id: string;
  node_type?: string | null;
  parent_addr?: string | null;
  space_id?: string | null;
  confidence?: number | null;
  description?: string | null;
  shared_parent?: number | boolean | null;
  shared_pyramid?: number | boolean | null;
  shared_alignment?: number | boolean | null;
};

function selectResonanceEdgeType(
  source: DurableAlignmentCandidate,
  target: ResonanceRow,
  primaryAxis: "function" | "world" | null,
): { edgeType: string; reason: string } {
  const sourceText = compactText([source.label, source.description]);
  const targetText = compactText([target.label, target.description]);
  const sourceOntology = suggestDurableOntologyTarget({
    content: sourceText,
    nodeType: source.node_type || "concept",
    actionability: inferActionability(source),
    includeLocalPyramids: false,
  });
  const targetOntology = suggestDurableOntologyTarget({
    content: targetText,
    nodeType: target.node_type || "concept",
    actionability: ACTIONABLE_NODE_TYPES.has(`${target.node_type || ""}`.toLowerCase()) ? 5 : 1,
    includeLocalPyramids: false,
  });

  if (sourceOntology.parentAddr && sourceOntology.parentAddr === targetOntology.parentAddr) {
    const branch = findOntologyBranchByAddr(sourceOntology.parentAddr)?.label || "a shared ontology branch";
    return { edgeType: "mirrors", reason: branch };
  }
  if (sourceOntology.pyramidId === "WORLD" && targetOntology.pyramidId === "FUNCTION") {
    return { edgeType: "informs", reason: "a grounded concept-to-action bridge" };
  }
  if (sourceOntology.pyramidId === "FUNCTION" && targetOntology.pyramidId === "WORLD") {
    return { edgeType: "operationalizes", reason: "a concrete action path for a world constraint or concept" };
  }
  if (
    sourceOntology.parentAddr === "WD.0.2.37"
    || sourceOntology.parentAddr === "WD.0.2.68"
    || sourceOntology.parentAddr === "WD.0.2.16"
  ) {
    return {
      edgeType: targetOntology.pyramidId === "WORLD" ? "grounds" : "frames",
      reason: "a shared philosophical or meaning-bearing frame",
    };
  }
  if (primaryAxis === "world") {
    return { edgeType: "frames", reason: "a neighboring world-model pathway" };
  }
  if (primaryAxis === "function") {
    return { edgeType: "informs", reason: "a nearby operational pathway" };
  }
  return { edgeType: "mirrors", reason: "shared semantic resonance" };
}

async function refreshDurableResonanceEdges(
  sql: SqlTag,
  candidate: DurableAlignmentCandidate,
  appliedPlans: Array<{
    axis: "function" | "world";
    role: "primary_anchor" | "resonance";
    targetAddr: string;
  }>,
): Promise<number> {
  const sourceText = compactText([candidate.label, candidate.description]);
  const sourceTerms = tokenizeMeaningText(sourceText);
  if (sourceTerms.length === 0) return 0;

  const sourcePyramid = (candidate.pyramid_id || "").toUpperCase();
  const sourceIsOntologyNode = sourcePyramid === "WORLD" || sourcePyramid === "FUNCTION";
  const targetSpaceIds = Array.from(new Set([GLOBAL_SPACE_ID, candidate.space_id || GLOBAL_SPACE_ID]));
  const targetAlignments = Array.from(new Set(appliedPlans.map((plan) => plan.targetAddr)));
  const primaryAxis = appliedPlans.find((plan) => plan.role === "primary_anchor")?.axis || null;
  const likePatterns = sourceTerms.slice(0, 6).map((term) => `%${term}%`);
  const ontologyTargetPyramids: string[] = [...ONTOLOGY_BRIDGE_PYRAMIDS];

  const rows = await sql`
    WITH aligned_nodes AS (
      SELECT
        e.from_addr AS node_addr,
        e.to_addr AS ontology_addr
      FROM edges e
      WHERE COALESCE(e.source_context->>'alignment_version', '') <> ''
    )
    SELECT DISTINCT
      n.addr,
      n.label,
      n.pyramid_id,
      n.node_type,
      n.parent_addr,
      n.space_id,
      n.confidence,
      n.substance->>'description' AS description,
      CASE WHEN ${candidate.parent_addr ? sql`n.parent_addr = ${candidate.parent_addr}` : sql`FALSE`} THEN 1 ELSE 0 END AS shared_parent,
      CASE WHEN n.pyramid_id = ${candidate.pyramid_id} THEN 1 ELSE 0 END AS shared_pyramid,
      CASE WHEN EXISTS (
        SELECT 1
        FROM aligned_nodes a
        WHERE a.node_addr = n.addr
          AND a.ontology_addr = ANY(${targetAlignments}::text[])
      ) THEN 1 ELSE 0 END AS shared_alignment
    FROM nodes n
    WHERE n.addr <> ${candidate.addr}
      AND n.space_id = ANY(${targetSpaceIds}::text[])
      AND n.visibility NOT IN ('dormant', 'deleted')
      AND n.pyramid_id <> 'TN'
      AND ${sourceIsOntologyNode ? sql`n.pyramid_id = ANY(${ontologyTargetPyramids}::text[])` : sql`TRUE`}
      AND n.depth >= 2
      AND (
        (cardinality(${likePatterns}::text[]) > 0 AND (
          n.label ILIKE ANY(${likePatterns}::text[])
          OR n.substance::text ILIKE ANY(${likePatterns}::text[])
        ))
        OR EXISTS (
          SELECT 1
          FROM aligned_nodes a
          WHERE a.node_addr = n.addr
            AND a.ontology_addr = ANY(${targetAlignments}::text[])
        )
      )
    LIMIT 80
  ` as ResonanceRow[];

  const scored = rows
    .map((row) => {
      const overlap = meaningOverlapScore(sourceTerms, compactText([row.label, row.description]));
      let score = overlap;
      if (row.shared_alignment) score += 3.0;
      if (row.shared_parent) score += 2.0;
      if (row.shared_pyramid) score += 0.6;
      if (row.pyramid_id === "META" && primaryAxis !== null) score -= 1.4;
      if (findOntologyBranchByAddr(row.addr)) score -= 0.35;
      score += Math.min(Number(row.confidence || 0), 1) * 0.5;
      return { row, score, overlap };
    })
    .filter(({ row, score, overlap }) => {
      if (row.addr === candidate.parent_addr) return false;
      if (score < 2.5) return false;
      if (`${row.label || ""}`.trim().toLowerCase() === candidate.label.trim().toLowerCase()) return false;
      if (sourceIsOntologyNode && row.pyramid_id !== sourcePyramid && !row.shared_alignment && overlap < 3.25) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  let inserted = 0;
  for (const { row, score } of scored) {
    const { edgeType, reason } = selectResonanceEdgeType(candidate, row, primaryAxis);
    const renderedLabel = renderResonanceLabel(candidate.label, row.label, edgeType, reason);
    const confidence = Math.max(0.68, Math.min(0.88, 0.62 + score * 0.04));
    await upsertEdge(sql, {
      fromAddr: candidate.addr,
      toAddr: row.addr,
      edgeType,
      layer: 0,
      label: renderedLabel,
      confidence,
      weight: 0.95,
      bidirectional: false,
      hash: alignmentHash(candidate.addr, row.addr, edgeType, RESONANCE_VERSION),
      provenance: { agent: "durable-alignment", source: "refreshDurableResonanceEdges" },
      sourceContext: {
        alignment_version: RESONANCE_VERSION,
        alignment_axis: "meaning",
        alignment_role: "resonance",
        resonance_score: Number(score.toFixed(3)),
        resonance_reason: reason,
        resonance_target: row.addr,
        resonance_label: renderedLabel,
        resonance_primary_axis: primaryAxis,
      },
      spaceId: GLOBAL_SPACE_ID,
      fromSpaceId: candidate.space_id || GLOBAL_SPACE_ID,
      toSpaceId: row.space_id || GLOBAL_SPACE_ID,
    }, { conflictUpdate: "replaceMetadata" });
    inserted++;
  }

  return inserted;
}

export async function loadDurableAlignmentCandidate(
  sql: SqlTag,
  addr: string,
): Promise<DurableAlignmentCandidate | null> {
  const [row] = await sql`
    SELECT
      n.addr,
      n.pyramid_id,
      n.depth,
      n.label,
      n.node_type,
      n.parent_addr,
      n.space_id,
      COALESCE(
        n.substance->>'description',
        n.substance->>'summary',
        n.substance->>'essence',
        ''
      ) AS description
    FROM nodes n
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
    LIMIT 1
  `;
  return row || null;
}

export async function refreshDurableNodeAlignments(
  sql: SqlTag,
  candidate: DurableAlignmentCandidate,
  options: { refreshCounts?: boolean } = {},
): Promise<DurableAlignmentResult> {
  const pyramidId = (candidate.pyramid_id || "").toUpperCase();
  const spaceId = candidate.space_id || GLOBAL_SPACE_ID;
  const refreshCounts = options.refreshCounts !== false;

  const staleAlignmentRows = await sql`
    SELECT id
    FROM edges
    WHERE from_addr = ${candidate.addr}
      AND (
        source_context->>'alignment_version' = ${ALIGNMENT_DELETE_VERSIONS[0]}
        OR source_context->>'alignment_version' = ${ALIGNMENT_DELETE_VERSIONS[1]}
        OR source_context->>'alignment_version' = ${ALIGNMENT_DELETE_VERSIONS[2]}
        OR source_context->>'alignment_version' = ${ALIGNMENT_DELETE_VERSIONS[3]}
        OR source_context->>'alignment_version' = ${ALIGNMENT_DELETE_VERSIONS[4]}
      )
  `;
  const { deleted } = await deleteEdgesByIds(sql, staleAlignmentRows.map((row: any) => row.id));

  if (spaceId !== GLOBAL_SPACE_ID || shouldSkipAlignmentCandidate(candidate)) {
    return { deleted, inserted: 0, applied: [] };
  }

  const applied = buildPlans(candidate);
  const targetLabels = new Map<string, string>();
  if (applied.length > 0) {
    const rows = await sql`
      SELECT addr, label
      FROM nodes
      WHERE addr = ANY(${applied.map((plan) => plan.targetAddr)}::text[])
        AND visibility <> 'deleted'
    `;
    for (const row of rows) {
      targetLabels.set(row.addr, row.label);
    }
  }
  let inserted = 0;

  for (const plan of applied) {
    const targetLabel = targetLabels.get(plan.targetAddr) || plan.targetAddr;
    const renderedLabel = renderAlignmentLabel(candidate.label, targetLabel, plan.edgeType, plan.role);
    const confidence = plan.role === "primary_anchor" ? 0.84 : 0.72;
    await upsertEdge(sql, {
      fromAddr: candidate.addr,
      toAddr: plan.targetAddr,
      edgeType: plan.edgeType,
      layer: 0,
      label: renderedLabel,
      confidence,
      weight: 1.0,
      bidirectional: false,
      hash: alignmentHash(candidate.addr, plan.targetAddr, plan.edgeType, plan.version),
      provenance: { agent: "durable-alignment", source: "refreshDurableNodeAlignments" },
      sourceContext: {
        alignment_version: plan.version,
        alignment_axis: plan.axis,
        alignment_role: plan.role,
        alignment_rank: plan.role === "primary_anchor" ? 1 : 2,
        alignment_target: plan.targetAddr,
        alignment_label: renderedLabel,
        alignment_reason: plan.reason,
      },
      spaceId: GLOBAL_SPACE_ID,
      fromSpaceId: spaceId,
      toSpaceId: GLOBAL_SPACE_ID,
    }, { conflictUpdate: "replaceMetadata" });
    inserted++;
  }

  inserted += await refreshDurableResonanceEdges(sql, candidate, applied);

  const refreshPyramids = [...new Set([pyramidId, ...DURABLE_ALIGNMENT_REFRESH_PYRAMIDS])];
  if (refreshCounts) {
    for (const refreshPyramid of refreshPyramids) {
      await sql`SELECT refresh_registry_counts(${refreshPyramid})`;
      await sql`SELECT refresh_space_pyramid_counts(${GLOBAL_SPACE_ID}, ${refreshPyramid})`;
    }
  }

  return { deleted, inserted, applied };
}
