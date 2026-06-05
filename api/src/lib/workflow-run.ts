/**
 * Canonical Workflow Run — the single contract for "what happened" across VO's
 * many routed-action and agent/tool run ledgers (Tier-2 harness-first OS, PR 5:
 * contract-first, NO new table).
 *
 * VO already records runs in a dozen domain-specific ledgers with divergent
 * shapes — remote_commands (routed actions + approvals), wi_runs (work-intake /
 * tool runs), agent_swarm_runs (agent runs), supercron_runs (scheduled routine
 * runs), and more. Per the Tier-2 rule ("classify/normalize OVER existing
 * structures; do NOT add redundant tables") this module defines ONE normalized
 * WorkflowRun envelope plus pure mappers that fold any of those rows into it,
 * so a human (or the Today/Needs-Attention surface) can inspect routed actions,
 * agent/tool outcomes, approvals, artifacts, and state transitions without
 * reading chat logs or learning each ledger's private schema. Existing ledgers
 * remain the storage; this is the read-side normalization layer.
 *
 * It composes the canonical Event Envelope (#60): actor and unknown-reason
 * vocabularies are reused so a run and the events around it speak the same
 * dimensions.
 */

import { createHash } from "node:crypto";
import {
  EVENT_ACTOR_KINDS,
  EVENT_UNKNOWN_REASONS,
  type EventActorKind,
  type EventUnknownReason,
} from "./event-envelope";

// ── Vocabularies ────────────────────────────────────────────────────────────

/** Which existing ledger a run was normalized from. */
export type WorkflowRunSourceLedger =
  | "remote_commands"
  | "wi_runs"
  | "agent_swarm_runs"
  | "supercron_runs"
  | "other";

export const WORKFLOW_RUN_SOURCE_LEDGERS: readonly WorkflowRunSourceLedger[] = [
  "remote_commands", "wi_runs", "agent_swarm_runs", "supercron_runs", "other",
] as const;

/** Normalized lifecycle state, covering every source ledger's status set. */
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "expired";

export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "queued", "running", "succeeded", "failed", "rejected", "cancelled", "expired",
] as const;

const WORKFLOW_RUN_TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "succeeded", "failed", "rejected", "cancelled", "expired",
]);

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return WORKFLOW_RUN_TERMINAL_STATUSES.has(status);
}

/** Outcome classification, independent of the lifecycle state. */
export type WorkflowRunOutcomeClass =
  | "success"
  | "partial"
  | "failure"
  | "rejected"
  | "pending"
  | "unknown";

export const WORKFLOW_RUN_OUTCOME_CLASSES: readonly WorkflowRunOutcomeClass[] = [
  "success", "partial", "failure", "rejected", "pending", "unknown",
] as const;

/** Approval posture of a routed run. */
export type WorkflowRunApprovalState = "not_required" | "pending" | "approved" | "rejected";

export const WORKFLOW_RUN_APPROVAL_STATES: readonly WorkflowRunApprovalState[] = [
  "not_required", "pending", "approved", "rejected",
] as const;

export interface WorkflowRunTransition {
  status: WorkflowRunStatus;
  at: string;
}

export interface WorkflowRunArtifact {
  kind: string;
  ref: string;
}

export interface WorkflowRunOutcome {
  class: WorkflowRunOutcomeClass;
  summary: string | null;
  error: string | null;
}

// ── The envelope ─────────────────────────────────────────────────────────────

export interface WorkflowRun {
  /** The source ledger's run id / natural key. */
  run_id: string;
  source_ledger: WorkflowRunSourceLedger;
  /** What kind of work this was (command_type / source_type / domain / slug). */
  kind: string;
  /** Human label for the run. */
  label: string;
  status: WorkflowRunStatus;
  /** Owning tenant. Null only with a matching `unknowns.tenant_id` reason. */
  tenant_id: string | null;
  actor_kind: EventActorKind;
  actor_label: string | null;
  started_at: string;
  /** Null while the run is still active. */
  ended_at: string | null;
  /** Derived from started_at/ended_at when not supplied (ms). */
  duration_ms: number | null;
  /** State changes in order, as far as the source row records them. */
  state_transitions: WorkflowRunTransition[];
  input_summary: string | null;
  artifacts: WorkflowRunArtifact[];
  approval_state: WorkflowRunApprovalState;
  outcome: WorkflowRunOutcome;
  /** Request/trace correlation id. Null only with a matching reason. */
  correlation_id: string | null;
  /** The source's native dedup token; cryptographic key via workflowRunIdempotencyKey(). */
  idempotency_key: string;
  unknowns: {
    tenant_id?: EventUnknownReason;
    correlation_id?: EventUnknownReason;
  };
}

// ── Construction ─────────────────────────────────────────────────────────────

export interface BuildWorkflowRunInput {
  run_id: string;
  source_ledger: WorkflowRunSourceLedger;
  kind: string;
  label?: string;
  status: WorkflowRunStatus;
  tenant_id?: string | null;
  actor_kind?: EventActorKind;
  actor_label?: string | null;
  started_at: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  state_transitions?: WorkflowRunTransition[];
  input_summary?: string | null;
  artifacts?: WorkflowRunArtifact[];
  approval_state?: WorkflowRunApprovalState;
  outcome?: Partial<WorkflowRunOutcome>;
  correlation_id?: string | null;
  idempotency_key?: string;
  unknowns?: WorkflowRun["unknowns"];
}

function msBetween(start: string, end: string | null): number | null {
  if (!end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * Build a normalized WorkflowRun with conservative defaults: actor defaults to
 * `system`, approval to `not_required`, outcome to a pending/unknown shape, and
 * duration is derived from the timestamps when not supplied. Null tenant /
 * correlation get a default typed reason so the validator passes for genuinely
 * unknowable dimensions.
 */
export function buildWorkflowRun(input: BuildWorkflowRunInput): WorkflowRun {
  const tenant_id = input.tenant_id ?? null;
  const correlation_id = input.correlation_id ?? null;
  const ended_at = input.ended_at ?? null;

  const unknowns: WorkflowRun["unknowns"] = { ...(input.unknowns ?? {}) };
  if (tenant_id === null && unknowns.tenant_id === undefined) unknowns.tenant_id = "not_applicable";
  if (correlation_id === null && unknowns.correlation_id === undefined) unknowns.correlation_id = "source_omitted";

  const outcome: WorkflowRunOutcome = {
    class: input.outcome?.class ?? "unknown",
    summary: input.outcome?.summary ?? null,
    error: input.outcome?.error ?? null,
  };

  return {
    run_id: input.run_id,
    source_ledger: input.source_ledger,
    kind: input.kind,
    label: input.label ?? `${input.source_ledger}:${input.kind}`,
    status: input.status,
    tenant_id,
    actor_kind: input.actor_kind ?? "system",
    actor_label: input.actor_label ?? null,
    started_at: input.started_at,
    ended_at,
    duration_ms: input.duration_ms ?? msBetween(input.started_at, ended_at),
    state_transitions: input.state_transitions ?? [],
    input_summary: input.input_summary ?? null,
    artifacts: input.artifacts ?? [],
    approval_state: input.approval_state ?? "not_required",
    outcome,
    correlation_id,
    idempotency_key: input.idempotency_key ?? `${input.source_ledger}:${input.run_id}`,
    unknowns,
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

function normalizeKeyPart(label: string, value: string): string {
  const trimmed = (value ?? "").normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError(`workflow-run ${label} must be a bounded non-empty string without NUL bytes.`);
  }
  return trimmed;
}

/**
 * Deterministic dedup key (sha256 hex) for a run. Two WorkflowRuns describing
 * the same logical run — same tenant scope, source ledger, and idempotency token
 * — hash identically. Mirrors eventEnvelopeIdempotencyKey.
 */
export function workflowRunIdempotencyKey(run: WorkflowRun): string {
  const scope = run.tenant_id ? normalizeKeyPart("tenant_id", run.tenant_id) : "global";
  const ledger = normalizeKeyPart("source_ledger", run.source_ledger);
  const key = normalizeKeyPart("idempotency_key", run.idempotency_key);
  const seed = [scope, ledger, key].join("\x00");
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface WorkflowRunValidation {
  ok: boolean;
  errors: string[];
}

function isIso(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Validate a WorkflowRun's contract: enum/shape checks, timestamp validity,
 * terminal-status-needs-ended_at, and the core invariant that tenant_id /
 * correlation_id may be null ONLY with a typed `unknowns` reason.
 */
export function validateWorkflowRun(run: WorkflowRun): WorkflowRunValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  inEnum(run.source_ledger, WORKFLOW_RUN_SOURCE_LEDGERS, "source_ledger");
  inEnum(run.status, WORKFLOW_RUN_STATUSES, "status");
  inEnum(run.actor_kind, EVENT_ACTOR_KINDS, "actor_kind");
  inEnum(run.approval_state, WORKFLOW_RUN_APPROVAL_STATES, "approval_state");
  inEnum(run.outcome.class, WORKFLOW_RUN_OUTCOME_CLASSES, "outcome.class");

  if (!run.run_id) errors.push("run_id is required");
  if (!run.kind) errors.push("kind is required");
  if (!isIso(run.started_at)) errors.push("started_at must be an ISO 8601 timestamp");
  if (run.ended_at !== null && !isIso(run.ended_at)) errors.push("ended_at must be null or an ISO 8601 timestamp");
  if (!Array.isArray(run.artifacts)) errors.push("artifacts must be an array");
  if (!Array.isArray(run.state_transitions)) errors.push("state_transitions must be an array");

  // A terminal run must record when it ended.
  if (isTerminalWorkflowRunStatus(run.status) && run.ended_at === null) {
    errors.push(`status "${run.status}" is terminal but ended_at is null`);
  }
  if (typeof run.duration_ms === "number" && run.duration_ms < 0) {
    errors.push("duration_ms must be >= 0");
  }

  const requireReason = (value: string | null, field: "tenant_id" | "correlation_id") => {
    if (value === null) {
      const reason = run.unknowns?.[field];
      if (!reason) errors.push(`${field} is null without an unknowns.${field} reason`);
      else if (!EVENT_UNKNOWN_REASONS.includes(reason)) errors.push(`unknowns.${field} "${reason}" is not a valid reason`);
    }
  };
  requireReason(run.tenant_id, "tenant_id");
  requireReason(run.correlation_id, "correlation_id");

  return { ok: errors.length === 0, errors };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tenantFromSpace(spaceId: string | null | undefined): string | null {
  if (typeof spaceId === "string" && spaceId.startsWith("tenant:")) return spaceId.slice("tenant:".length);
  return null;
}

function iso(value: string | Date): string {
  // Degrade gracefully on a malformed timestamp (return it as-is so
  // validateWorkflowRun flags it) rather than throwing mid-map.
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : typeof value === "string" ? value : "invalid-date";
}

// ── Mappers: normalize existing ledger rows into the WorkflowRun ──────────────
//
// These prove the acceptance criterion — every routed-action / agent-tool run
// ledger maps into one canonical shape a human can inspect, without changing
// its storage.

const REMOTE_COMMAND_STATUS: Record<string, { status: WorkflowRunStatus; outcome: WorkflowRunOutcomeClass; approval: WorkflowRunApprovalState }> = {
  queued: { status: "queued", outcome: "pending", approval: "pending" },
  claimed: { status: "running", outcome: "pending", approval: "approved" },
  applied: { status: "succeeded", outcome: "success", approval: "approved" },
  rejected: { status: "rejected", outcome: "rejected", approval: "rejected" },
  failed: { status: "failed", outcome: "failure", approval: "approved" },
  canceled: { status: "cancelled", outcome: "unknown", approval: "not_required" },
  expired: { status: "expired", outcome: "unknown", approval: "not_required" },
};

/** Map a remote_commands row (routed action + approval lifecycle). */
export function fromRemoteCommandRow(row: {
  id: string;
  tenant_id: string;
  category: string;
  command_type: string;
  status: string;
  claimed_at?: string | Date | null;
  claimed_by?: string | null;
  result?: Record<string, unknown> | null;
  idempotency_key?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  target_node_id?: string | null;
  origin_actor_label?: string | null;
  origin_session_type?: string | null;
}): WorkflowRun {
  const map = REMOTE_COMMAND_STATUS[row.status] ?? { status: "running" as WorkflowRunStatus, outcome: "unknown" as WorkflowRunOutcomeClass, approval: "pending" as WorkflowRunApprovalState };
  const startedAt = iso(row.created_at);
  const endedAt = isTerminalWorkflowRunStatus(map.status) ? iso(row.updated_at) : null;

  const transitions: WorkflowRunTransition[] = [{ status: "queued", at: startedAt }];
  if (row.claimed_at) transitions.push({ status: "running", at: iso(row.claimed_at) });
  if (endedAt) transitions.push({ status: map.status, at: endedAt });

  const error = map.outcome === "failure" || map.outcome === "rejected"
    ? (typeof row.result?.error === "string" ? row.result.error : null)
    : null;

  return buildWorkflowRun({
    run_id: String(row.id),
    source_ledger: "remote_commands",
    kind: row.command_type,
    label: `${row.category}/${row.command_type}`,
    status: map.status,
    tenant_id: row.tenant_id,
    actor_kind: row.origin_session_type === "hosted-mcp-agent" ? "hosted_agent" : "tenant_session",
    actor_label: row.origin_actor_label ?? row.claimed_by ?? null,
    started_at: startedAt,
    ended_at: endedAt,
    state_transitions: transitions,
    input_summary: `${row.category}/${row.command_type}`,
    artifacts: row.target_node_id ? [{ kind: "node", ref: row.target_node_id }] : [],
    approval_state: map.approval,
    outcome: { class: map.outcome, summary: null, error },
    idempotency_key: row.idempotency_key ?? `remote_commands:${row.id}`,
  });
}

/** Map a wi_runs row (work-intake / tool harvest run). */
export function fromWiRunRow(row: {
  run_id: string;
  source_url: string;
  source_type: string;
  title?: string | null;
  atoms_extracted?: number | null;
  cost_usd?: number | string | null;
  elapsed_ms?: number | null;
  status?: string | null;
  error?: string | null;
  created_at?: string | Date | null;
  space_id?: string | null;
}): WorkflowRun {
  const startedAt = iso(row.created_at ?? new Date(0));
  const elapsed = typeof row.elapsed_ms === "number" ? row.elapsed_ms : null;
  const endedAt = elapsed != null ? new Date(Date.parse(startedAt) + elapsed).toISOString() : startedAt;
  // A rolled_back run had its extracted atoms REVERTED — it is the inverse of a
  // success and must never read green. Map it to a cancelled/partial run.
  const rolledBack = row.status === "rolled_back";
  const failed = !rolledBack && (Boolean(row.error) || row.status === "error" || row.status === "failed");
  const atoms = row.atoms_extracted ?? 0;

  return buildWorkflowRun({
    run_id: row.run_id,
    source_ledger: "wi_runs",
    kind: row.source_type,
    label: row.title ?? `wi:${row.source_type}`,
    status: rolledBack ? "cancelled" : failed ? "failed" : "succeeded",
    tenant_id: tenantFromSpace(row.space_id),
    actor_kind: "system",
    actor_label: "work-intake",
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: elapsed,
    input_summary: row.source_url,
    artifacts: [{ kind: "source_url", ref: row.source_url }],
    approval_state: "not_required",
    outcome: {
      class: rolledBack ? "partial" : failed ? "failure" : "success",
      summary: rolledBack ? `rolled back — ${atoms} atoms reverted` : `${atoms} atoms, $${row.cost_usd ?? 0}`,
      error: row.error ?? null,
    },
  });
}

/** Map an agent_swarm_runs row (agent run + outcome). */
export function fromAgentSwarmRunRow(row: {
  run_id: string;
  agent_id: string;
  domain?: string | null;
  task?: string | null;
  started_at: string | Date;
  finished_at?: string | Date | null;
  duration_ms?: number | null;
  quest_resolved?: boolean | null;
  final_confidence?: string | null;
  final_action_kind?: string | null;
  nodes_touched?: string[] | null;
}): WorkflowRun {
  const startedAt = iso(row.started_at);
  const endedAt = row.finished_at ? iso(row.finished_at) : null;
  const status: WorkflowRunStatus = endedAt == null ? "running" : (row.quest_resolved ? "succeeded" : "failed");
  const outcomeClass: WorkflowRunOutcomeClass = endedAt == null
    ? "pending"
    : (row.quest_resolved ? "success" : "failure");

  return buildWorkflowRun({
    run_id: row.run_id,
    source_ledger: "agent_swarm_runs",
    kind: row.domain ?? "agent",
    label: row.task ? `agent:${row.agent_id}:${row.task.slice(0, 60)}` : `agent:${row.agent_id}`,
    status,
    actor_kind: "hosted_agent",
    actor_label: row.agent_id,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: typeof row.duration_ms === "number" ? row.duration_ms : msBetween(startedAt, endedAt),
    input_summary: row.task ?? null,
    artifacts: (row.nodes_touched ?? []).map((ref) => ({ kind: "node", ref })),
    approval_state: "not_required",
    outcome: {
      class: outcomeClass,
      summary: row.final_action_kind ? `${row.final_action_kind} (${row.final_confidence ?? "?"})` : null,
      error: null,
    },
  });
}

const SUPERCRON_STATUS: Record<string, { status: WorkflowRunStatus; outcome: WorkflowRunOutcomeClass }> = {
  running: { status: "running", outcome: "pending" },
  completed: { status: "succeeded", outcome: "success" },
  degraded: { status: "succeeded", outcome: "partial" },
  failed: { status: "failed", outcome: "failure" },
  error: { status: "failed", outcome: "failure" },
  timeout: { status: "failed", outcome: "failure" },
};

/** Map a supercron_runs row (scheduled maintenance routine run). */
export function fromSupercronRunRow(row: {
  run_id: string;
  started_at: string | Date;
  finished_at?: string | Date | null;
  pyramid_focus?: string | null;
  total_actions?: number | null;
  status: string;
  degraded_reason?: string | null;
}): WorkflowRun {
  const startedAt = iso(row.started_at);
  const endedAt = row.finished_at ? iso(row.finished_at) : null;
  // Unknown status: derive from whether the run finished — a finished unknown is
  // a failure, an unfinished one is still running. Never show a finished run as
  // perpetually "running".
  const map = SUPERCRON_STATUS[row.status]
    ?? (endedAt != null
      ? { status: "failed" as WorkflowRunStatus, outcome: "failure" as WorkflowRunOutcomeClass }
      : { status: "running" as WorkflowRunStatus, outcome: "pending" as WorkflowRunOutcomeClass });
  const status = isTerminalWorkflowRunStatus(map.status) && endedAt == null ? "running" : map.status;

  return buildWorkflowRun({
    run_id: row.run_id,
    source_ledger: "supercron_runs",
    kind: row.pyramid_focus ?? "supercron",
    label: `supercron:${row.pyramid_focus ?? "all"}`,
    status,
    actor_kind: "cron",
    actor_label: "supercron",
    started_at: startedAt,
    ended_at: endedAt,
    input_summary: row.pyramid_focus ?? null,
    artifacts: [],
    approval_state: "not_required",
    outcome: {
      class: endedAt == null ? "pending" : map.outcome,
      summary: `${row.total_actions ?? 0} actions`,
      error: row.degraded_reason ?? null,
    },
  });
}
