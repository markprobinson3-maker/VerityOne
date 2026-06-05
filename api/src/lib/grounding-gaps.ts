import type { AccessContext } from "./access";
import type { RetrievalIntent } from "./retrieval-intent";
import { GLOBAL_SPACE_ID, tenantSpaceId } from "./spaces";

type SqlTag = any;
const GAP_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const GAP_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "into", "from", "your", "their", "what", "when", "where",
  "how", "why", "design", "build", "create", "task", "goal", "agent", "workflow", "using",
]);

export type GroundingGapType =
  | "missing_world_grounding"
  | "missing_functional_path"
  | "missing_reviewed_skill"
  | "low_corroboration"
  | "bridge_gap"
  | "low_confidence";

export type GroundingGapSignal = {
  gapKey: string;
  gapType: GroundingGapType;
  title: string;
  description: string;
  severity: "info" | "warn" | "critical";
  targetPyramidId: string | null;
  targetBranchAddr: string | null;
  scopeKind: "global" | "tenant" | "mixed";
  canonicalFocus: string;
  eventPayload: Record<string, unknown>;
};

export type GroundingGapInput = {
  goal: string;
  access: AccessContext;
  agentId?: string | null;
  intent: RetrievalIntent;
  intentMode: "act" | "understand" | "evaluate" | "coordinate" | "discover";
  truths: Array<{
    grounding_kind?: string | null;
    addr?: string | null;
    label?: string | null;
    pyramid_id?: string | null;
    truth_posture?: string | null;
  }>;
  functionalPath: Array<{
    addr?: string | null;
    label?: string | null;
    pyramid_id?: string | null;
  }>;
  skills: Array<{ id?: number | null; content?: string | null }>;
  confidence: { level: "high" | "medium" | "low"; note: string };
  ontology: {
    cross_domain?: Array<{ addr?: string | null; label?: string | null; pyramid_id?: string | null }>;
    next_steps?: Array<{ addr?: string | null; label?: string | null; pyramid_id?: string | null }>;
  };
};

function normalizeTerms(input: string): string[] {
  return Array.from(new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !GAP_STOP_WORDS.has(term)),
  )).slice(0, 6);
}

function canonicalFocus(goal: string): string {
  const terms = normalizeTerms(goal);
  return terms.length > 0 ? terms.join(" ") : goal.trim().toLowerCase().slice(0, 80);
}

function canonicalFocusKey(goal: string): string {
  const terms = normalizeTerms(goal);
  if (terms.length === 0) return "unfocused";
  return terms.join("-").slice(0, 64);
}

function goalHash(goal: string): string {
  return Bun.hash(goal.trim().toLowerCase()).toString(16);
}

function actorKey(access: AccessContext, explicitAgentId?: string | null): string {
  const agentId = explicitAgentId || access.agentId || null;
  if (agentId) return `agent:${Bun.hash(`agent:${agentId}`).toString(16)}`;
  if (access.token) return `token:${Bun.hash(`token:${access.token}`).toString(16)}`;
  return `scope:${access.scope}:${access.tenantId || GLOBAL_SPACE_ID}`;
}

function primarySpaceId(access: AccessContext): string {
  if (access.tenantId) return tenantSpaceId(access.tenantId);
  return GLOBAL_SPACE_ID;
}

function dedupeBucketKey(now = Date.now()): string {
  return String(Math.floor(now / GAP_DEDUPE_WINDOW_MS));
}

function scopeKind(access: AccessContext): "global" | "tenant" | "mixed" {
  const spaces = access.spaceIds || [];
  if (spaces.length === 0 || (spaces.length === 1 && spaces[0] === "global")) return "global";
  if (spaces.length === 1 && spaces[0] !== "global") return "tenant";
  return "mixed";
}

function targetBranch(input: GroundingGapInput): { pyramidId: string | null; branchAddr: string | null; label: string } {
  const worldTruth = input.truths.find((row) => row.pyramid_id === "WORLD");
  const functionPath = input.functionalPath[0];
  const firstBridge = input.ontology.cross_domain?.[0] || input.ontology.next_steps?.[0] || null;
  if (worldTruth?.addr) {
    return { pyramidId: "WORLD", branchAddr: worldTruth.addr, label: worldTruth.label || worldTruth.addr };
  }
  if (firstBridge?.addr) {
    return {
      pyramidId: firstBridge.pyramid_id || input.intent.targetPyramidId || null,
      branchAddr: firstBridge.addr || null,
      label: firstBridge.label || firstBridge.addr || input.intent.targetParentAddr || input.intent.targetPyramidId || "goal branch",
    };
  }
  if (functionPath?.addr) {
    return { pyramidId: functionPath.pyramid_id || "FUNCTION", branchAddr: functionPath.addr || null, label: functionPath.label || functionPath.addr || "functional path" };
  }
  return {
    pyramidId: input.intent.targetPyramidId || null,
    branchAddr: input.intent.targetParentAddr || null,
    label: input.intent.targetParentAddr || input.intent.targetPyramidId || "goal branch",
  };
}

function buildGapKey(
  kind: "global" | "tenant" | "mixed",
  type: GroundingGapType,
  intentMode: string,
  branchAddr: string | null,
  focusKey: string,
): string {
  const branchPart = (branchAddr || "unscoped").replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 64);
  return `${kind}:${type}:${intentMode}:${branchPart}:${focusKey || "unfocused"}`;
}

function buildSignal(
  input: GroundingGapInput,
  type: GroundingGapType,
  severity: "info" | "warn" | "critical",
  title: string,
  description: string,
): GroundingGapSignal {
  const kind = scopeKind(input.access);
  const focus = canonicalFocus(input.goal);
  const focusKey = canonicalFocusKey(input.goal);
  const target = targetBranch(input);
  return {
    gapKey: buildGapKey(kind, type, input.intentMode || "discover", target.branchAddr, focusKey),
    gapType: type,
    title,
    description,
    severity,
    targetPyramidId: target.pyramidId,
    targetBranchAddr: target.branchAddr,
    scopeKind: kind,
    canonicalFocus: focus,
    eventPayload: {
      goal: input.goal,
      goal_hash: goalHash(input.goal),
      confidence_level: input.confidence.level,
      confidence_note: input.confidence.note,
      truth_count: input.truths.length,
      functional_path_count: input.functionalPath.length,
      skill_count: input.skills.length,
      bridge_count: input.ontology.cross_domain?.length || 0,
      next_steps: input.ontology.next_steps || [],
    },
  };
}

export function detectGroundingGapSignals(input: GroundingGapInput): GroundingGapSignal[] {
  const signals: GroundingGapSignal[] = [];
  const directWorldTruths = input.truths.filter((row) => row.grounding_kind === "node" && row.pyramid_id === "WORLD");
  const hasNodeLevelWorldGrounding = directWorldTruths.some((row) =>
    row.truth_posture === "grounded" || row.truth_posture === "partially_grounded",
  );
  const hasOntologyOnlyWorldGrounding = input.truths.some((row) => row.grounding_kind === "ontology_anchor");
  const hasFunctionalPath = input.functionalPath.length > 0;
  const hasSkills = input.skills.length > 0;
  const hasCrossDomainBridge = (input.ontology.cross_domain?.length || 0) > 0;

  if (!hasNodeLevelWorldGrounding) {
    const severity = (input.intent.worldBias || input.intent.philosophy || input.intent.science || input.confidence.level === "low")
      ? "warn"
      : "info";
    signals.push(buildSignal(
      input,
      "missing_world_grounding",
      severity,
      "Uncharted territory: missing world grounding",
      "The goal is reaching action without a strong node-level world truth anchor. This territory needs grounded concepts or evidence-bearing nodes.",
    ));
  }

  if (!hasFunctionalPath) {
    signals.push(buildSignal(
      input,
      "missing_functional_path",
      input.intent.actionBias ? "critical" : "warn",
      "Uncharted territory: missing functional path",
      "The goal has no strong functional branch or execution path. This territory needs actionable methods, runbooks, or tool-aligned nodes.",
    ));
  }

  if (input.intent.actionBias && !hasSkills) {
    signals.push(buildSignal(
      input,
      "missing_reviewed_skill",
      hasFunctionalPath ? "info" : "warn",
      "Uncharted territory: missing reviewed skill",
      "The goal surfaces a direction, but not a reviewed reusable skill. This territory needs actionable, trustworthy skill guidance.",
    ));
  }

  if (
    input.truths.length === 0
    || input.truths.every((row) => row.truth_posture !== "grounded" && row.truth_posture !== "partially_grounded")
    || hasOntologyOnlyWorldGrounding
  ) {
    signals.push(buildSignal(
      input,
      "low_corroboration",
      input.confidence.level === "low" ? "warn" : "info",
      "Uncharted territory: low corroboration",
      "The current grounding relies on provisional or ontology-level support. This territory needs corroborated evidence and stronger source-backed nodes.",
    ));
  }

  if (input.intent.actionBias && (input.intent.worldBias || input.intent.philosophy || input.intent.science) && !hasCrossDomainBridge) {
    signals.push(buildSignal(
      input,
      "bridge_gap",
      "warn",
      "Uncharted territory: missing world-function bridge",
      "The goal spans both truth and action, but the graph did not produce a strong bridge. This territory needs typed relations between world constraints and functional execution.",
    ));
  }

  if (input.confidence.level === "low") {
    signals.push(buildSignal(
      input,
      "low_confidence",
      hasNodeLevelWorldGrounding && hasFunctionalPath ? "info" : "warn",
      "Uncharted territory: low confidence packet",
      "The graph returned useful structure, but not enough trustworthy support for decisive action. This territory needs stronger retrieval quality and denser meaning support.",
    ));
  }

  return signals;
}

export async function recordGroundingGapSignals(sql: SqlTag, input: GroundingGapInput): Promise<GroundingGapSignal[]> {
  const signals = detectGroundingGapSignals(input);
  if (signals.length === 0) return [];
  if (input.access.scope === "operator" && !input.agentId && !input.access.agentId) return signals;

  const currentSpaceId = primarySpaceId(input.access);
  const currentTenantId = input.access.tenantId || null;
  const accessScope = input.access.scope;
  const agentId = input.agentId || input.access.agentId || null;
  const goalText = input.goal.trim();
  const hashedGoal = goalHash(goalText);
  const currentActorKey = actorKey(input.access, agentId);
  const currentScopeSignature = {
    access_scope: accessScope,
    tenant_id: currentTenantId,
    primary_space_id: currentSpaceId,
    visible_space_ids: input.access.spaceIds || [GLOBAL_SPACE_ID],
  };
  const currentFocusKey = canonicalFocusKey(goalText);

  for (const signal of signals) {
    const currentDedupeKey = Bun.hash([
      signal.gapKey,
      signal.gapType,
      hashedGoal,
      currentActorKey,
      dedupeBucketKey(),
    ].join("|")).toString(16);

    await sql`
      INSERT INTO grounding_gap_profiles (
        gap_key,
        gap_type,
        title,
        description,
        target_pyramid_id,
        target_branch_addr,
        intent_mode,
        scope_kind,
        canonical_focus,
        canonical_focus_key,
        seen_count,
        last_seen_at,
        source_context,
        blockchain_context
      ) VALUES (
        ${signal.gapKey},
        ${signal.gapType},
        ${signal.title},
        ${signal.description},
        ${signal.targetPyramidId},
        ${signal.targetBranchAddr},
        ${input.intentMode},
        ${signal.scopeKind},
        ${signal.canonicalFocus},
        ${currentFocusKey},
        0,
        now(),
        ${sql.json({
          last_goal: goalText,
          last_goal_hash: hashedGoal,
          target_pyramid_id: signal.targetPyramidId,
          target_branch_addr: signal.targetBranchAddr,
          last_confidence_level: input.confidence.level,
          last_actor_key: currentActorKey,
          last_scope_signature: currentScopeSignature,
        })},
        ${sql.json({
          territory_kind: "uncharted_territory",
          reward_policy: "gap_fill_resonance_v1",
          claim_mode: "open",
          tokenization_ready: true,
        })}
      )
      ON CONFLICT (gap_key) DO UPDATE
      SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        target_pyramid_id = COALESCE(EXCLUDED.target_pyramid_id, grounding_gap_profiles.target_pyramid_id),
        target_branch_addr = COALESCE(EXCLUDED.target_branch_addr, grounding_gap_profiles.target_branch_addr),
        intent_mode = EXCLUDED.intent_mode,
        scope_kind = EXCLUDED.scope_kind,
        canonical_focus = COALESCE(grounding_gap_profiles.canonical_focus, EXCLUDED.canonical_focus),
        canonical_focus_key = COALESCE(grounding_gap_profiles.canonical_focus_key, EXCLUDED.canonical_focus_key),
        source_context = grounding_gap_profiles.source_context || EXCLUDED.source_context,
        blockchain_context = grounding_gap_profiles.blockchain_context || EXCLUDED.blockchain_context
    `;

    const inserted = await sql`
      INSERT INTO grounding_gap_events (
        gap_key,
        gap_type,
        goal,
        goal_hash,
        agent_id,
        actor_key,
        access_scope,
        space_id,
        tenant_id,
        target_pyramid_id,
        target_branch_addr,
        severity,
        confidence_level,
        event_payload,
        scope_signature,
        dedupe_key
      ) VALUES (
        ${signal.gapKey},
        ${signal.gapType},
        ${goalText},
        ${hashedGoal},
        ${agentId},
        ${currentActorKey},
        ${accessScope},
        ${currentSpaceId},
        ${currentTenantId},
        ${signal.targetPyramidId},
        ${signal.targetBranchAddr},
        ${signal.severity},
        ${input.confidence.level},
        ${sql.json(signal.eventPayload)},
        ${sql.json(currentScopeSignature)},
        ${currentDedupeKey}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    if ((inserted as any[]).length > 0) {
      await sql`
        UPDATE grounding_gap_profiles
        SET
          seen_count = grounding_gap_profiles.seen_count + 1,
          last_seen_at = now(),
          target_pyramid_id = COALESCE(${signal.targetPyramidId}, grounding_gap_profiles.target_pyramid_id),
          target_branch_addr = COALESCE(${signal.targetBranchAddr}, grounding_gap_profiles.target_branch_addr),
          source_context = grounding_gap_profiles.source_context || ${sql.json({
            last_goal: goalText,
            last_goal_hash: hashedGoal,
            last_confidence_level: input.confidence.level,
            last_actor_key: currentActorKey,
            last_scope_signature: currentScopeSignature,
          })}
        WHERE gap_key = ${signal.gapKey}
      `;
    } else {
      await sql`
        UPDATE grounding_gap_profiles
        SET
          last_seen_at = now(),
          source_context = grounding_gap_profiles.source_context || ${sql.json({
            last_goal: goalText,
            last_goal_hash: hashedGoal,
            last_actor_key: currentActorKey,
            last_scope_signature: currentScopeSignature,
            last_duplicate_window: dedupeBucketKey(),
          })}
        WHERE gap_key = ${signal.gapKey}
      `;
    }
  }

  return signals;
}
