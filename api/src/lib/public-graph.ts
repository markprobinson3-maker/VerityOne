import { canReadSpaceId, type AccessContext, type AccessScope } from "./access";
import { ontologyGuidanceSummary } from "./ontology-guidance";
import { GLOBAL_SPACE_ID } from "./spaces";
import { parseJsonField } from "./utils";

const SYNTHETIC_TEXT_RE = /^(ingest-e2e-|cache-test-|test-|fixture-)/i;
const SYNTHETIC_BATCH_RE = /^(itest:|test:|fixture:)/i;

type MaybeRecord = Record<string, unknown> | null;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function descriptionOf(row: any): string | null {
  if (typeof row?.description === "string") return row.description;
  const substance = parseJsonField<any>(row?.substance) || row?.substance;
  return stringValue(substance?.description)
    || stringValue(ontologyGuidanceSummary(stringValue(row?.addr) || "")?.description)
    || null;
}

function trendContextOf(row: any): MaybeRecord {
  const sourceContext = parseJsonField<any>(row?.source_context) || row?.source_context || {};
  const trend = sourceContext?.trend;
  return trend && typeof trend === "object" && !Array.isArray(trend) ? trend : null;
}

function canReadAccessLevel(scope: AccessScope, accessLevel: string | null | undefined): boolean {
  if (scope === "operator") return true;
  if (scope === "beta") return accessLevel === "public" || accessLevel === "shared";
  return accessLevel === "public";
}

function resolveAccess(access: AccessScope | AccessContext): AccessContext {
  if (typeof access !== "string") return access;
  return {
    scope: access,
    token: null,
    agentId: null,
    tenantId: null,
    spaceIds: access === "operator" ? null : [GLOBAL_SPACE_ID],
  };
}

export function isSyntheticText(value: string | null | undefined): boolean {
  if (!value) return false;
  return SYNTHETIC_TEXT_RE.test(value.trim());
}

export function isSyntheticBatchId(value: string | null | undefined): boolean {
  if (!value) return false;
  return SYNTHETIC_BATCH_RE.test(value.trim());
}

export function hasUsableDescription(row: any): boolean {
  const description = descriptionOf(row);
  return !!description && description.trim().length > 0;
}

export function isEmergingTrend(row: any): boolean {
  if (row?.node_type !== "trend") return false;
  return (trendContextOf(row)?.lifecycle || "emerging") === "emerging";
}

export function isPublicNodeReadable(row: any): boolean {
  return isNodeReadableForScope("anonymous", row);
}

export function isNodeReadableForScope(accessInput: AccessScope | AccessContext, row: any): boolean {
  if (!row) return false;
  const access = resolveAccess(accessInput);
  if (row.visibility === "deleted") return false;
  const rowSpaceId = stringValue(row.space_id) || GLOBAL_SPACE_ID;
  if (!canReadSpaceId(access, rowSpaceId)) return false;
  const isTenantOwnedReadable = access.scope !== "anonymous"
    && rowSpaceId !== GLOBAL_SPACE_ID
    && (access.spaceIds || []).includes(rowSpaceId);
  if (!isTenantOwnedReadable) {
    if (access.scope !== "operator" && row.visibility !== "public") return false;
    if (!canReadAccessLevel(access.scope, row.access_level || "public")) return false;
  }
  if (isSyntheticText(stringValue(row.label))) return false;
  const description = descriptionOf(row);
  if (description && isSyntheticText(description)) return false;
  if (row.node_type === "trend" && isEmergingTrend(row)) return false;
  return hasUsableDescription(row);
}

export function filterPublicNodes<T extends Record<string, any>>(rows: T[]): T[] {
  return filterReadableNodes(rows, "anonymous");
}

export function filterReadableNodes<T extends Record<string, any>>(
  rows: T[],
  access: AccessScope | AccessContext,
): T[] {
  return rows.filter((row) => isNodeReadableForScope(access, row));
}

export function isBetaVisiblePyramid(accessLevel: string | null | undefined): boolean {
  return accessLevel === "public" || accessLevel === "shared";
}

export function filterVisiblePyramids<T extends Record<string, any>>(rows: T[], scope: AccessScope): T[] {
  return rows.filter((row) => canReadAccessLevel(scope, row.access_level));
}

export function isSyntheticStimulus(row: any): boolean {
  return isSyntheticBatchId(stringValue(row?.ingest_batch_id))
    || isSyntheticText(stringValue(row?.content))
    || isSyntheticText(stringValue(row?.content_preview));
}

export function isSyntheticGraphMutation(row: any): boolean {
  return isSyntheticText(stringValue(row?.addr))
    || isSyntheticText(stringValue(row?.label));
}

export function isSyntheticTrendEvent(row: any): boolean {
  const payload = parseJsonField<any>(row?.payload) || row?.payload || {};
  return isSyntheticBatchId(stringValue(row?.ingest_batch_id))
    || isSyntheticText(stringValue(row?.trend_addr))
    || isSyntheticText(stringValue(payload?.label))
    || isSyntheticText(stringValue(payload?.sample_content))
    || isSyntheticText(stringValue(payload?.description));
}
