/**
 * Canonical memory contract — the stable write/read interface for VO memory.
 *
 * F8: zod-first. The schemas below are the source of truth; legacy
 * `validateWriteRequest` / `validateUpdateRequest` are thin wrappers that
 * preserve the existing `{ valid, data } | { valid, errors }` shape so
 * pre-F8 callers keep working. New callers should use the schemas directly
 * via `validateRequest(c, MemoryWriteRequestSchema)` from
 * `api/src/lib/zod-helpers.ts`.
 */

import { z } from "zod";
import type { FederatedMemoryMetadata, ResolvedFederatedMemoryMetadata } from "./federated-memory";
import { validateFederationMetadata } from "./federated-memory";

// ── Memory kinds ──

export const MEMORY_KINDS = [
  "decision",
  "preference",
  "correction",
  "context",
  "pattern",
  "vision",
  "changelog",
  "digest",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MemoryKindSchema = z.enum(MEMORY_KINDS);

// ── Source refs ──

export const SourceRefSchema = z
  .object({
    /** Relative path to a file in the project (e.g. "docs/VO-CURRENT-STATE.md") */
    path: z.string().optional(),
    /** URL of the source document */
    url: z.string().optional(),
    /** Source type descriptor (e.g. "doc", "pr", "issue", "url") */
    type: z.string().min(1, { message: "Each source_ref must have a non-empty type string (e.g. \"doc\", \"url\", \"pr\")" }),
  })
  .refine((r) => r.path !== undefined || r.url !== undefined, {
    message: "Each source_ref must have at least one of: path, url",
  });

export type SourceRef = z.infer<typeof SourceRefSchema>;

// ── Source-link status ──

export type SourceLinkStatus = "linked" | "missing" | "optional";

/**
 * Kinds for which a source_ref is optional — these memories are honest without one.
 * Kinds NOT in this list (decision, correction, pattern) are expected to have a source.
 */
export const SOURCE_OPTIONAL_KINDS: MemoryKind[] = [
  "preference",
  "context",
  "vision",
  "changelog",
  "digest",
];

/**
 * Compute source_link_status at write time.
 *   linked   — at least one source_ref was provided
 *   missing  — no source_refs and the kind expects one (decision, correction, pattern)
 *   optional — no source_refs but the kind does not require one
 */
export function computeSourceLinkStatus(
  kind: MemoryKind,
  sourceRefs: SourceRef[] | undefined | null,
): SourceLinkStatus {
  if (sourceRefs && sourceRefs.length > 0) return "linked";
  if (SOURCE_OPTIONAL_KINDS.includes(kind)) return "optional";
  return "missing";
}

// ── Source kinds ──

export const SOURCE_KINDS = [
  "user_accepted",    // user explicitly accepted or authored
  "agent_inferred",   // agent saved without explicit user acceptance
  "agent_corrected",  // agent saved after user correction
  "system_generated", // auto-generated (digests, compaction, etc.)
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceKindSchema = z.enum(SOURCE_KINDS);

// ── Memory status ──

export const MEMORY_STATUSES = [
  "active",
  "superseded",
  "retracted",
  "archived",
  "expired",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);

// ── Scope ──

export const ScopeSchema = z.enum(["session", "project", "tenant", "global"]);

// ── Write request ──

/**
 * Canonical write-request schema. Note: federation is validated through the
 * legacy `validateFederationMetadata(...)` helper for back-compat (its
 * implementation lives in `federated-memory.ts` and produces the same
 * field-level error shape) — the schema accepts the structural shape and
 * the wrapper layer adds federation-specific checks on top.
 */
export const MemoryWriteRequestSchema = z.object({
  kind: MemoryKindSchema,
  subject: z.string().max(120, { message: "Must be a string, max 120 chars" }).optional(),
  assertion: z
    .string()
    .min(1, { message: "Required. The core memory content (max 4000 chars)" })
    .max(4000, { message: "Max 4000 characters" }),
  why_it_matters: z.string().optional(),
  scope: ScopeSchema.optional(),
  source: SourceKindSchema,
  evidence: z.string().optional(),
  effective_at: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  supersedes: z.string().optional(),
  tags: z.array(z.string(), { message: "Must be an array of strings" }).optional(),
  confidence: z
    .number()
    .min(0, { message: "Must be a number between 0 and 1" })
    .max(1, { message: "Must be a number between 0 and 1" })
    .optional(),
  privacy: z.enum(["private", "shared"]).optional(),
  project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/, { message: "Must be a valid PJ.x.x.x address" })
    .optional(),
  federation: z.unknown().optional(),
  source_refs: z.array(SourceRefSchema).optional(),
});

export type MemoryWriteRequest = {
  kind: MemoryKind;
  subject?: string;
  assertion: string;
  why_it_matters?: string;
  scope?: "session" | "project" | "tenant" | "global";
  source: SourceKind;
  evidence?: string;
  effective_at?: string;
  expires_at?: string | null;
  supersedes?: string;
  tags?: string[];
  confidence?: number;
  privacy?: "private" | "shared";
  project_addr?: string;
  federation?: FederatedMemoryMetadata;
  source_refs?: SourceRef[];
};

// ── Write response ──

export interface MemoryWriteResponse {
  ok: true;
  addr: string;
  label: string;
  kind: MemoryKind;
  source: SourceKind;
  space_id: string;
  edges_wired: string;
  deduplicated?: boolean;
  existing_addr?: string;
  similarity?: number;
  federation?: ResolvedFederatedMemoryMetadata;
  source_link_status?: SourceLinkStatus;
}

// ── Read response ──

export interface MemoryReadResponse {
  ok: true;
  addr: string;
  label: string;
  kind: MemoryKind;
  source: SourceKind;
  status: MemoryStatus;
  assertion: string;
  why_it_matters: string | null;
  evidence: string | null;
  scope: string;
  confidence: number;
  effective_at: string;
  expires_at: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  federation: ResolvedFederatedMemoryMetadata;
}

// ── Recall request ──

export const MemoryRecallRequestSchema = z.object({
  query: z.string(),
  kinds: z.array(MemoryKindSchema).optional(),
  project_addr: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  include_inactive: z.boolean().optional(),
});

export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;

// ── Update request ──

export const MemoryUpdateRequestSchema = z
  .object({
    assertion: z
      .string()
      .max(4000, { message: "Must be a string, max 4000 chars" })
      .optional(),
    subject: z
      .string()
      .max(120, { message: "Must be a string, max 120 chars" })
      .optional(),
    why_it_matters: z.string().optional(),
    evidence: z.string().optional(),
    tags: z.array(z.string()).optional(),
    confidence: z
      .number()
      .min(0, { message: "Must be between 0 and 1" })
      .max(1, { message: "Must be between 0 and 1" })
      .optional(),
    expires_at: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      v.assertion !== undefined ||
      v.subject !== undefined ||
      v.why_it_matters !== undefined ||
      v.evidence !== undefined ||
      v.tags !== undefined ||
      v.confidence !== undefined ||
      v.expires_at !== undefined,
    { message: "At least one field to update is required" },
  );

export type MemoryUpdateRequest = {
  assertion?: string;
  subject?: string;
  why_it_matters?: string;
  evidence?: string;
  tags?: string[];
  confidence?: number;
  expires_at?: string | null;
};

// ── Validation ──

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Translate a zod issue list into the legacy `{ field, message }` shape.
 * Federation errors flow through `validateFederationMetadata` and appended
 * here to preserve the pre-F8 error contract.
 */
function zodIssuesToLegacyErrors(issues: readonly z.core.$ZodIssue[]): ValidationError[] {
  return issues.map((issue) => {
    const path = issue.path ?? [];
    const field = path.length === 0 ? "body" : path.map((p) => String(p)).join(".");
    // Top-level path means the body itself failed (e.g. refine on the whole object).
    return { field: field === "" ? "body" : field, message: issue.message };
  });
}

export function validateWriteRequest(
  body: unknown,
): { valid: true; data: MemoryWriteRequest } | { valid: false; errors: ValidationError[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }
  const parsed = MemoryWriteRequestSchema.safeParse(body);
  const errors: ValidationError[] = parsed.success
    ? []
    : zodIssuesToLegacyErrors(parsed.error.issues);
  errors.push(...validateFederationMetadata((body as Record<string, unknown>).federation));
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: parsed.data as MemoryWriteRequest };
}

export function validateUpdateRequest(
  body: unknown,
): { valid: true; data: MemoryUpdateRequest } | { valid: false; errors: ValidationError[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }
  const parsed = MemoryUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { valid: false, errors: zodIssuesToLegacyErrors(parsed.error.issues) };
  }
  return { valid: true, data: parsed.data as MemoryUpdateRequest };
}

/** Map old /remember payload to canonical MemoryWriteRequest */
export function adaptRememberPayload(body: Record<string, unknown>): MemoryWriteRequest {
  const description = String(body.description || "").trim().slice(0, 4000);
  const memoryType = MEMORY_KINDS.includes(body.memory_type as MemoryKind)
    ? (body.memory_type as MemoryKind)
    : "context";

  return {
    kind: memoryType,
    subject: typeof body.label === "string" ? body.label.slice(0, 120) : generateSubject(description),
    assertion: description,
    why_it_matters: typeof body.context === "string" ? body.context : undefined,
    source: "agent_inferred",
    scope: "tenant",
    confidence: 0.80,
    privacy: "private",
  };
}

function generateSubject(assertion: string): string {
  const firstSentence = assertion.split(/[.!?]/)[0].trim();
  if (firstSentence.length <= 80) return firstSentence;
  return firstSentence.slice(0, 77) + "...";
}
