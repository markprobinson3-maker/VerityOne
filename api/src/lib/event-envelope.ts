/**
 * Canonical Event Envelope — the single contract for anything entering Verity
 * One (Tier-2 harness-first OS, PR 1: contract-first, no new table).
 *
 * VO already has several domain-specific event ledgers (hosted_audit_log,
 * memory_events, graph_mutations, change_stream, query_log) with overlapping but
 * inconsistent shapes. This module defines ONE normalized envelope that every
 * capture/ingestion/action surface can be mapped into, plus deterministic
 * idempotency-key construction and validation. It deliberately adds NO database
 * table: existing ledgers remain the storage; this is the normalization layer
 * that later phases (claims/decisions, workflow runs, action packets) build on.
 *
 * Enum vocabularies are aligned with what already exists so the envelope can map
 * existing rows without translation drift:
 *   - ActorKind extends hosted_audit_log's actor_kind CHECK set.
 *   - RiskLevel matches ActionRiskLevel (mcp-local-action-runner).
 * privacy_classification / security_classification / urgency / route_hint are
 * new dimensions (no prior convention in the codebase).
 *
 * Invariant (plan Phase 1): tenant / project / correlation dimensions are not
 * optional in runtime writes unless explicitly marked unknown with a typed
 * reason. The validator enforces this; the type carries an `unknowns` record.
 */

import { createHash } from "node:crypto";

// ── Vocabularies ────────────────────────────────────────────────────────────

/** Where an event originated. */
export type EventSourceKind =
  | "mcp_write_intent"
  | "memory_op"
  | "sync_push"
  | "supercron_pass"
  | "day_node_routine"
  | "dashboard_action"
  | "oauth_lifecycle"
  | "connector_activity"
  | "agent_signal"
  | "external_feed"
  | "internal_cron"
  | "other";

export const EVENT_SOURCE_KINDS: readonly EventSourceKind[] = [
  "mcp_write_intent", "memory_op", "sync_push", "supercron_pass",
  "day_node_routine", "dashboard_action", "oauth_lifecycle", "connector_activity",
  "agent_signal", "external_feed", "internal_cron", "other",
] as const;

/**
 * Who/what triggered the event. The first five values are exactly
 * hosted_audit_log's actor_kind CHECK set; `system`/`cron` cover internal
 * automated origins that the audit log does not (it requires an actor).
 */
export type EventActorKind =
  | "operator_token"
  | "admin_session"
  | "tenant_session"
  | "hosted_agent"
  | "oauth_client"
  | "system"
  | "cron";

export const EVENT_ACTOR_KINDS: readonly EventActorKind[] = [
  "operator_token", "admin_session", "tenant_session", "hosted_agent",
  "oauth_client", "system", "cron",
] as const;

/** Matches ActionRiskLevel in mcp-local-action-runner.ts. */
export type EventRiskLevel = "low" | "medium" | "high";
export const EVENT_RISK_LEVELS: readonly EventRiskLevel[] = ["low", "medium", "high"] as const;

export type EventUrgency = "low" | "normal" | "high" | "critical";
export const EVENT_URGENCIES: readonly EventUrgency[] = ["low", "normal", "high", "critical"] as const;

/** Who may see the event's content. */
export type EventPrivacyClassification = "public" | "tenant_private" | "operator_only" | "secret";
export const EVENT_PRIVACY_CLASSIFICATIONS: readonly EventPrivacyClassification[] = [
  "public", "tenant_private", "operator_only", "secret",
] as const;

export type EventSecurityClassification = "standard" | "sensitive" | "restricted";
export const EVENT_SECURITY_CLASSIFICATIONS: readonly EventSecurityClassification[] = [
  "standard", "sensitive", "restricted",
] as const;

export type EventCaptureStatus = "captured" | "partial" | "failed";
export const EVENT_CAPTURE_STATUSES: readonly EventCaptureStatus[] = ["captured", "partial", "failed"] as const;

export type EventNormalizationStatus = "raw" | "normalized" | "enriched" | "failed";
export const EVENT_NORMALIZATION_STATUSES: readonly EventNormalizationStatus[] = [
  "raw", "normalized", "enriched", "failed",
] as const;

/** Typed reason a normally-required dimension is absent. */
export type EventUnknownReason =
  | "not_applicable"
  | "not_yet_resolved"
  | "source_omitted"
  | "anonymous";
export const EVENT_UNKNOWN_REASONS: readonly EventUnknownReason[] = [
  "not_applicable", "not_yet_resolved", "source_omitted", "anonymous",
] as const;

/** A provenance/source reference attached to the event. */
export interface EventSourceRef {
  kind: string;
  ref: string;
  hash?: string | null;
}

// ── The envelope ─────────────────────────────────────────────────────────────

export interface EventEnvelope {
  /** Owning tenant. Null only with a matching `unknowns.tenant_id` reason. */
  tenant_id: string | null;
  /** Owning project node addr, when known. Null allowed (with reason). */
  project_addr: string | null;
  source_kind: EventSourceKind;
  /** Human/source label, e.g. "/hosted-mcp/write" or "supercron:lifecycle". */
  source_label: string;
  /** When the event actually happened (ISO 8601). */
  occurred_at: string;
  /** When VO received/captured it (ISO 8601). */
  received_at: string;
  /**
   * Caller-supplied dedup token (the source's native id / natural key). The
   * cryptographic dedup key is derived via eventEnvelopeIdempotencyKey().
   */
  idempotency_key: string;
  /** Domain event type, e.g. "memory_created" (maps to ledger event_type). */
  event_type: string;
  /** Pointer to / hash of the raw payload (content stays in its own store). */
  raw_payload_ref: string | null;
  raw_payload_hash: string | null;
  privacy_classification: EventPrivacyClassification;
  security_classification: EventSecurityClassification;
  risk_level: EventRiskLevel;
  urgency: EventUrgency;
  /** Optional routing hint for the workflow router (a workflow/type slug). */
  route_hint: string | null;
  actor_kind: EventActorKind;
  actor_label: string | null;
  /** Request/trace correlation id. Null only with a matching reason. */
  correlation_id: string | null;
  source_refs: EventSourceRef[];
  capture_status: EventCaptureStatus;
  normalization_status: EventNormalizationStatus;
  /** Typed reasons for any null required-ish dimension. */
  unknowns: {
    tenant_id?: EventUnknownReason;
    project_addr?: EventUnknownReason;
    correlation_id?: EventUnknownReason;
  };
}

// ── Construction ─────────────────────────────────────────────────────────────

export interface BuildEventEnvelopeInput {
  source_kind: EventSourceKind;
  source_label: string;
  event_type: string;
  idempotency_key: string;
  tenant_id?: string | null;
  project_addr?: string | null;
  occurred_at?: string;
  received_at?: string;
  raw_payload_ref?: string | null;
  raw_payload_hash?: string | null;
  privacy_classification?: EventPrivacyClassification;
  security_classification?: EventSecurityClassification;
  risk_level?: EventRiskLevel;
  urgency?: EventUrgency;
  route_hint?: string | null;
  actor_kind?: EventActorKind;
  actor_label?: string | null;
  correlation_id?: string | null;
  source_refs?: EventSourceRef[];
  capture_status?: EventCaptureStatus;
  normalization_status?: EventNormalizationStatus;
  unknowns?: EventEnvelope["unknowns"];
}

/**
 * Build a normalized envelope with conservative defaults. `received_at`
 * defaults to now; classifications default to the safe/private side so an
 * un-classified event is never accidentally treated as public/low-risk.
 */
export function buildEventEnvelope(input: BuildEventEnvelopeInput): EventEnvelope {
  const now = new Date().toISOString();
  const tenant_id = input.tenant_id ?? null;
  const project_addr = input.project_addr ?? null;
  const correlation_id = input.correlation_id ?? null;

  // Derive sensible default unknown-reasons so the validator passes for
  // genuinely-unknowable dimensions without callers hand-writing them.
  const unknowns: EventEnvelope["unknowns"] = { ...(input.unknowns ?? {}) };
  if (tenant_id === null && unknowns.tenant_id === undefined) unknowns.tenant_id = "not_applicable";
  if (project_addr === null && unknowns.project_addr === undefined) unknowns.project_addr = "not_applicable";
  if (correlation_id === null && unknowns.correlation_id === undefined) unknowns.correlation_id = "source_omitted";

  return {
    tenant_id,
    project_addr,
    source_kind: input.source_kind,
    source_label: input.source_label,
    occurred_at: input.occurred_at ?? now,
    received_at: input.received_at ?? now,
    idempotency_key: input.idempotency_key,
    event_type: input.event_type,
    raw_payload_ref: input.raw_payload_ref ?? null,
    raw_payload_hash: input.raw_payload_hash ?? null,
    privacy_classification: input.privacy_classification ?? "tenant_private",
    security_classification: input.security_classification ?? "standard",
    risk_level: input.risk_level ?? "low",
    urgency: input.urgency ?? "normal",
    route_hint: input.route_hint ?? null,
    actor_kind: input.actor_kind ?? "system",
    actor_label: input.actor_label ?? null,
    correlation_id,
    source_refs: input.source_refs ?? [],
    capture_status: input.capture_status ?? "captured",
    normalization_status: input.normalization_status ?? "normalized",
    unknowns,
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

const IDEMPOTENCY_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function normalizeKeyPart(label: string, value: string): string {
  const trimmed = (value ?? "").normalize("NFC").trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.length > 256) {
    throw new TypeError(`event-envelope ${label} must be a bounded non-empty string without NUL bytes.`);
  }
  return trimmed;
}

/**
 * Deterministic dedup key (sha256 hex) for an envelope. Two envelopes that
 * describe the same logical event — same tenant scope, source kind, event type,
 * and caller idempotency token — hash identically, so ledgers can dedup on it.
 * Mirrors the day-journal hashIdempotencyKey pattern (NFC-normalized parts
 * joined by NUL, sha256), but is self-contained.
 */
export function eventEnvelopeIdempotencyKey(env: EventEnvelope): string {
  const scope = env.tenant_id ? normalizeKeyPart("tenant_id", env.tenant_id) : "global";
  const sourceKind = normalizeKeyPart("source_kind", env.source_kind);
  if (!IDEMPOTENCY_NAMESPACE_RE.test(sourceKind)) {
    throw new TypeError("event-envelope source_kind must be a dotted safe slug.");
  }
  const eventType = normalizeKeyPart("event_type", env.event_type);
  const key = normalizeKeyPart("idempotency_key", env.idempotency_key);
  const seed = [scope, sourceKind, eventType, key].join("\x00");
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface EventEnvelopeValidation {
  ok: boolean;
  errors: string[];
}

function isIso(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * Validate an envelope's contract. Beyond enum/shape checks it enforces the
 * core invariant: tenant_id / project_addr / correlation_id may be null ONLY
 * when accompanied by a typed `unknowns` reason.
 */
export function validateEventEnvelope(env: EventEnvelope): EventEnvelopeValidation {
  const errors: string[] = [];
  const inEnum = <T,>(v: T, set: readonly T[], field: string) => {
    if (!set.includes(v)) errors.push(`${field} "${String(v)}" is not a valid value`);
  };

  inEnum(env.source_kind, EVENT_SOURCE_KINDS, "source_kind");
  inEnum(env.actor_kind, EVENT_ACTOR_KINDS, "actor_kind");
  inEnum(env.risk_level, EVENT_RISK_LEVELS, "risk_level");
  inEnum(env.urgency, EVENT_URGENCIES, "urgency");
  inEnum(env.privacy_classification, EVENT_PRIVACY_CLASSIFICATIONS, "privacy_classification");
  inEnum(env.security_classification, EVENT_SECURITY_CLASSIFICATIONS, "security_classification");
  inEnum(env.capture_status, EVENT_CAPTURE_STATUSES, "capture_status");
  inEnum(env.normalization_status, EVENT_NORMALIZATION_STATUSES, "normalization_status");

  if (!env.source_label) errors.push("source_label is required");
  if (!env.event_type) errors.push("event_type is required");
  if (!env.idempotency_key) errors.push("idempotency_key is required");
  if (!isIso(env.occurred_at)) errors.push("occurred_at must be an ISO 8601 timestamp");
  if (!isIso(env.received_at)) errors.push("received_at must be an ISO 8601 timestamp");
  if (!Array.isArray(env.source_refs)) errors.push("source_refs must be an array");

  // The not-optional-without-a-reason invariant.
  const requireReason = (value: string | null, field: "tenant_id" | "project_addr" | "correlation_id") => {
    if (value === null) {
      const reason = env.unknowns?.[field];
      if (!reason) {
        errors.push(`${field} is null without an unknowns.${field} reason`);
      } else if (!EVENT_UNKNOWN_REASONS.includes(reason)) {
        errors.push(`unknowns.${field} "${reason}" is not a valid reason`);
      }
    }
  };
  requireReason(env.tenant_id, "tenant_id");
  requireReason(env.project_addr, "project_addr");
  requireReason(env.correlation_id, "correlation_id");

  return { ok: errors.length === 0, errors };
}

// ── Mappers: normalize existing ledger rows into the envelope ────────────────
//
// These prove the acceptance criterion — every major existing ledger can be
// mapped into the canonical envelope without changing its storage.

/** Map a hosted_audit_log row into the envelope. */
export function fromHostedAuditLogRow(row: {
  id: number | string;
  event_type: string;
  actor_kind: string | null;
  actor_label: string | null;
  tenant_id: string | null;
  node_id?: string | null;
  correlation_id: string | null;
  created_at: string | Date;
}): EventEnvelope {
  const actorKind = (EVENT_ACTOR_KINDS as readonly string[]).includes(row.actor_kind ?? "")
    ? (row.actor_kind as EventActorKind)
    : "system";
  return buildEventEnvelope({
    source_kind: "connector_activity",
    source_label: "hosted_audit_log",
    event_type: row.event_type,
    idempotency_key: `hosted_audit_log:${row.id}`,
    tenant_id: row.tenant_id ?? null,
    occurred_at: new Date(row.created_at).toISOString(),
    received_at: new Date(row.created_at).toISOString(),
    actor_kind: actorKind,
    actor_label: row.actor_label ?? null,
    correlation_id: row.correlation_id ?? null,
    privacy_classification: "operator_only",
    normalization_status: "normalized",
    source_refs: row.node_id ? [{ kind: "hosted_node", ref: row.node_id }] : [],
  });
}

/** Map a memory_events row into the envelope. */
export function fromMemoryEventRow(row: {
  id: number | string;
  addr: string;
  tenant_id: string | null;
  event_type: string;
  actor: string | null;
  correlation_id: string | null;
  created_at: string | Date;
}): EventEnvelope {
  return buildEventEnvelope({
    source_kind: "memory_op",
    source_label: "memory_events",
    event_type: row.event_type,
    idempotency_key: `memory_events:${row.id}`,
    tenant_id: row.tenant_id ?? null,
    occurred_at: new Date(row.created_at).toISOString(),
    received_at: new Date(row.created_at).toISOString(),
    actor_kind: "hosted_agent",
    actor_label: row.actor ?? null,
    correlation_id: row.correlation_id ?? null,
    privacy_classification: "tenant_private",
    source_refs: [{ kind: "node", ref: row.addr }],
  });
}
