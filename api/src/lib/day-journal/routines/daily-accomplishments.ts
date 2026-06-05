import { sql as defaultSql } from "../../../db";
import type { DayJournalRoutineContext, DayJournalRoutineDefinition } from "../routine-registry";
import type { DayJournalRoutineResult, DayJournalRoutineStatus } from "../validate";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

export interface DailyAccomplishmentsDeps {
  sql?: SqlTag;
}

interface TemporalIntakeRow {
  id?: number | string;
  content?: unknown;
  projects?: unknown;
  people?: unknown;
  tags?: unknown;
  energy?: unknown;
  status?: unknown;
  created_at?: unknown;
}

interface ProjectEdgeRow {
  addr?: unknown;
  label?: unknown;
  weight?: unknown;
  confidence?: unknown;
}

interface EvidenceItem {
  source: "temporal_intake" | "day_node_intake";
  id?: string;
  text: string;
  projects: string[];
  people: string[];
  tags: string[];
  energy?: number;
  status?: string;
  captured_at?: string;
}

interface ProjectSummary {
  addr?: string;
  label: string;
  mentions: number;
  score: number;
  confidence?: number;
  sources: string[];
}

const ROUTINE_ID = "summary.daily_accomplishments";
const TARGET_PATH = "journal.summaries.daily_accomplishments";
const SCHEMA_ID = "daily_accomplishments_summary_v1";
const SOURCE_ID = "local_day_journal_v1";
const MAX_DAY_INTAKE_ROWS = 40;
const MAX_TEMPORAL_INTAKE_ROWS = 40;
const MAX_PROJECT_ROWS = 12;
const MAX_TEXT_CHARS = 320;
const MAX_LABEL_CHARS = 160;
const MAX_ACCOMPLISHMENTS = 10;
const MAX_FOLLOW_UPS = 8;
const MAX_TOP_PROJECTS = 8;
const INVISIBLE_MARKER = "\uE000";
const INVISIBLE_TEXT_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const INVISIBLE_MARKER_RE = /\uE000/g;
// The VO-token alternative enumerates real token prefixes only (vop_REDACTED,
// voc_, vocr_, voca_, vobc_, vodg_, vons_, vos_, voa_) and requires a
// body of at least 6 chars. Command-only prefixes like voj_, vor_,
// vow_, vol_ are deliberately excluded so short slug tags such as
// `voj_smoke` or `voc_test` (4-char body) do not false-positive while
// still catching every real leaked token (production tokens carry
// 20-40+ char random bodies).
const SECRET_TEXT_RE =
  /\bBearer(?:\s|\uE000)+\S+|\bsk-[A-Za-z0-9\uE000][A-Za-z0-9_\-\uE000]*|\bsk_(?:test|live)_[A-Za-z0-9_\uE000]+\b|\bAuthorization:(?:\s|\uE000)*\S+(?:(?:\s|\uE000)+\S+)?|\b[A-Za-z0-9_-]*(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|pwd)s?\b(?:\s|\uE000)*[:=](?:\s|\uE000)*\S+|\b(?:vocr|voca|vobc|vodg|vons|voc|vos|voa|vop)_[A-Za-z0-9\uE000][A-Za-z0-9_\-\uE000]{5,}\b|\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9_\uE000]+\b|\bgithub_pat_[A-Za-z0-9_\uE000]+\b|\bxox[a-z]-[A-Za-z0-9\-\uE000]+\b|\b(?:AKIA|ASIA)(?:\uE000*[0-9A-Z]){16}\uE000*\b|\beyJ[A-Za-z0-9_\-\uE000]+\.[A-Za-z0-9_\-\uE000]+\.[A-Za-z0-9_\-\uE000]+\b|\b(?:postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\b/gi;
const FOLLOW_UP_RE =
  /(?:^|\s)(?:(?:TODO|FIXME)(?::|\s+)|(?:FOLLOW[-\s]?UP|ACTION(?:\s+ITEM)?|BLOCKED|WAITING(?:\s+ON)?|NEXT(?:\s+STEP)?):)\s*\S/;
const FOLLOW_UP_TAG_RE = /^(todo|follow[-_]?up|blocked|next|waiting)$/i;

function truncateCodePoints(value: string, maxChars: number): string {
  let out = "";
  let count = 0;
  for (const char of value) {
    if (count >= maxChars) break;
    out += char;
    count += 1;
  }
  return out;
}

function cleanText(value: unknown, maxChars = MAX_TEXT_CHARS): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFC")
    .replace(INVISIBLE_TEXT_RE, INVISIBLE_MARKER)
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = normalized
    .replace(SECRET_TEXT_RE, "[credential removed]")
    .replace(INVISIBLE_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return null;
  return truncateCodePoints(redacted, maxChars);
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const cleaned = cleanText(item, MAX_LABEL_CHARS);
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return undefined;
}

function evidenceKey(text: string): string {
  return text.toLocaleLowerCase("en-US");
}

function temporalEvidence(row: TemporalIntakeRow): EvidenceItem | null {
  const text = cleanText(row.content);
  if (!text) return null;
  const energy = finiteNumber(row.energy);
  const status = cleanText(row.status, 40);
  return {
    source: "temporal_intake",
    ...(row.id !== undefined ? { id: String(row.id) } : {}),
    text,
    projects: stringArray(row.projects, 10),
    people: stringArray(row.people, 10),
    tags: stringArray(row.tags, 20),
    ...(energy !== undefined ? { energy: Math.max(0, Math.min(1, energy)) } : {}),
    ...(status ? { status } : {}),
    ...(isoTimestamp(row.created_at) ? { captured_at: isoTimestamp(row.created_at) } : {}),
  };
}

function dayNodeEvidence(content: unknown): EvidenceItem | null {
  const text = cleanText(content);
  if (!text) return null;
  return {
    source: "day_node_intake",
    text,
    projects: [],
    people: [],
    tags: [],
  };
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = evidenceKey(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function addProject(projects: Map<string, ProjectSummary>, input: ProjectSummary): void {
  const key = input.addr || input.label.toLocaleLowerCase("en-US");
  const existing = projects.get(key);
  if (!existing) {
    projects.set(key, input);
    return;
  }
  existing.mentions += input.mentions;
  existing.score += input.score;
  if (input.confidence !== undefined) {
    existing.confidence = existing.confidence === undefined
      ? input.confidence
      : Math.max(existing.confidence, input.confidence);
  }
  for (const source of input.sources) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
  }
}

function topProjects(projectRows: ProjectEdgeRow[], evidence: EvidenceItem[]): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();
  for (const row of projectRows) {
    const addr = cleanText(row.addr, 80);
    const label = cleanText(row.label, MAX_LABEL_CHARS) || addr;
    if (!label) continue;
    addProject(projects, {
      ...(addr ? { addr } : {}),
      label,
      mentions: 1,
      score: finiteNumber(row.weight) ?? 1,
      ...(finiteNumber(row.confidence) !== undefined ? { confidence: finiteNumber(row.confidence) } : {}),
      sources: ["active_on"],
    });
  }

  for (const item of evidence) {
    for (const project of item.projects) {
      addProject(projects, {
        label: project,
        mentions: 1,
        score: 1,
        sources: ["temporal_intake"],
      });
    }
  }

  return [...projects.values()]
    .sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.label.localeCompare(b.label, "en-US"))
    .slice(0, MAX_TOP_PROJECTS);
}

function followUpEvidenceItems(evidence: EvidenceItem[]): EvidenceItem[] {
  return evidence.filter((item) => FOLLOW_UP_RE.test(item.text) || item.tags.some((tag) => FOLLOW_UP_TAG_RE.test(tag)));
}

function unresolvedFollowUps(followUpEvidence: EvidenceItem[]): Array<Record<string, unknown>> {
  return followUpEvidence
    .slice(-MAX_FOLLOW_UPS)
    .map((item) => ({
      text: item.text,
      source: item.source,
      ...(item.id ? { id: item.id } : {}),
      ...(item.projects.length > 0 ? { projects: item.projects } : {}),
      ...(item.tags.length > 0 ? { tags: item.tags } : {}),
    }));
}

function evidencePreviewItems(evidence: EvidenceItem[]): EvidenceItem[] {
  return evidence.slice(-MAX_ACCOMPLISHMENTS);
}

function accomplishmentItems(evidence: EvidenceItem[]): Array<Record<string, unknown>> {
  return evidencePreviewItems(evidence).map((item) => ({
    text: item.text,
    source: item.source,
    ...(item.id ? { id: item.id } : {}),
    ...(item.captured_at ? { captured_at: item.captured_at } : {}),
    ...(item.projects.length > 0 ? { projects: item.projects } : {}),
    ...(item.people.length > 0 ? { people: item.people } : {}),
    ...(item.tags.length > 0 ? { tags: item.tags } : {}),
    ...(item.energy !== undefined ? { energy: item.energy } : {}),
  }));
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function summaryLine(
  status: DayJournalRoutineStatus,
  targetDate: string,
  evidenceCount: number,
  projectCount: number,
  followUpCount: number,
): string {
  if (status === "skipped") {
    return `Daily accomplishments skipped: no local intake or project activity for ${targetDate}.`;
  }
  const projectPhrase = projectCount > 0 ? `across ${plural(projectCount, "project")}` : "with no named projects";
  const followUpPhrase = followUpCount > 0
    ? `${plural(followUpCount, "follow-up")} flagged`
    : "no follow-ups flagged";
  if (evidenceCount > 0) {
    return `Daily accomplishments: ${plural(evidenceCount, "local intake item")} ${projectPhrase}; ${followUpPhrase}.`;
  }
  return `Daily accomplishments partial: project activity found ${projectPhrase}; ${followUpPhrase}.`;
}

function coverageNote(dayIntakeCount: number, temporalCount: number, projectCount: number, projectEdgesTruncated: boolean): string {
  const sources = [
    dayIntakeCount > 0 ? `${plural(dayIntakeCount, "day-node intake item")}` : null,
    temporalCount > 0 ? `${plural(temporalCount, "temporal intake row")}` : null,
    projectCount > 0
      ? `${projectEdgesTruncated ? "first " : ""}${plural(projectCount, "active project edge")}`
      : null,
  ].filter(Boolean);
  const basis = sources.length > 0 ? sources.join(", ") : "no local evidence";
  return `Deterministic extractive v1 based on ${basis}; commits, PRs, task trackers, and deployment markers are not included yet.`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("daily_accomplishments_aborted");
}

export async function runDailyAccomplishments(
  ctx: DayJournalRoutineContext,
  deps: DailyAccomplishmentsDeps = {},
): Promise<DayJournalRoutineResult> {
  const sql = deps.sql || (defaultSql as SqlTag);

  throwIfAborted(ctx.signal);
  const [dayNode] = await sql`
    SELECT substance->'intake' AS intake
    FROM nodes
    WHERE addr = ${ctx.dayAddr}
      AND space_id = ${ctx.spaceId}
      AND node_type = 'day'
      AND visibility <> 'deleted'
    LIMIT 1`;

  throwIfAborted(ctx.signal);
  const temporalRows = await sql`
    SELECT id, content, projects, people, tags, energy, status, created_at
    FROM (
      SELECT id, content, projects, people, tags, energy, status, created_at
      FROM temporal_intake
      WHERE target_day = ${ctx.dayAddr}
        AND space_id = ${ctx.spaceId}
        AND LOWER(BTRIM(COALESCE(status, 'pending'))) <> 'correction'
      ORDER BY created_at DESC, id DESC
      LIMIT ${MAX_TEMPORAL_INTAKE_ROWS}
    ) recent_temporal_intake
    ORDER BY created_at ASC, id ASC
  `;

  throwIfAborted(ctx.signal);
  const projectRows = await sql`
    SELECT n.addr, n.label, e.weight, e.confidence
    FROM edges e
    JOIN nodes n ON e.from_addr = n.addr
    WHERE e.to_addr = ${ctx.dayAddr}
      AND e.edge_type = 'active_on'
      AND (
        e.to_space_id = ${ctx.spaceId}
        OR e.space_id = ${ctx.spaceId}
      )
      AND e.from_space_id = ${ctx.spaceId}
      AND e.from_space_id = n.space_id
      AND n.space_id = ${ctx.spaceId}
      AND n.addr LIKE 'PJ.0.1.%'
      AND n.visibility NOT IN ('dormant', 'merged', 'deleted')
      AND NOT (COALESCE(e.source_context->'roles', '[]'::jsonb) ? 'predicted')
      AND NOT (COALESCE(e.source_context->'roles', '[]'::jsonb) ? 'predicted_missed')
    ORDER BY e.weight DESC NULLS LAST, e.confidence DESC NULLS LAST, n.addr ASC
    LIMIT ${MAX_PROJECT_ROWS + 1}`;

  throwIfAborted(ctx.signal);
  const projectRowsForSummary = projectRows.slice(0, MAX_PROJECT_ROWS);
  const truncatedProjectEdges = projectRows.length > MAX_PROJECT_ROWS;
  const dayIntake = Array.isArray(dayNode?.intake)
    ? dayNode.intake.slice(-MAX_DAY_INTAKE_ROWS)
    : [];
  const temporalEvidenceItems = temporalRows
    .map((row: TemporalIntakeRow) => temporalEvidence(row))
    .filter((item: EvidenceItem | null): item is EvidenceItem => item !== null);
  const dayEvidenceItems = dayIntake
    .map((item: unknown) => dayNodeEvidence(item))
    .filter((item: EvidenceItem | null): item is EvidenceItem => item !== null);
  const evidence = dedupeEvidence([...temporalEvidenceItems, ...dayEvidenceItems]);
  const projects = topProjects(projectRowsForSummary as ProjectEdgeRow[], evidence);
  const followUpEvidence = followUpEvidenceItems(evidence);
  const followUps = unresolvedFollowUps(followUpEvidence);
  const accomplishments = accomplishmentItems(evidence);
  const status: DayJournalRoutineStatus = evidence.length > 0
    ? "ok"
    : projects.length > 0
      ? "partial"
      : "skipped";

  const payload = {
    source: SOURCE_ID,
    routine_class: "context_only",
    context_only: true,
    historical_context_only: true,
    target_date: ctx.targetDate,
    target_day_addr: ctx.dayAddr,
    target_timezone: ctx.targetTimezone,
    summary: summaryLine(status, ctx.targetDate, evidence.length, projects.length, followUpEvidence.length),
    coverage_note: coverageNote(dayEvidenceItems.length, temporalEvidenceItems.length, projectRowsForSummary.length, truncatedProjectEdges),
    accomplishments,
    top_projects: projects,
    unresolved_follow_ups: followUps,
    evidence: evidencePreviewItems(evidence).map((item) => ({
      source: item.source,
      text: item.text,
      ...(item.id ? { id: item.id } : {}),
      ...(item.captured_at ? { captured_at: item.captured_at } : {}),
    })),
    data_quality: {
      status,
      day_node_intake_count: dayEvidenceItems.length,
      temporal_intake_count: temporalEvidenceItems.length,
      project_edge_count: projectRowsForSummary.length,
      deduped_evidence_count: evidence.length,
      truncated_evidence: evidence.length > MAX_ACCOMPLISHMENTS,
      truncated_follow_ups: followUpEvidence.length > MAX_FOLLOW_UPS,
      truncated_project_edges: truncatedProjectEdges,
      deterministic: true,
      llm_used: false,
    },
  };

  const sourceRefs = [
    dayEvidenceItems.length > 0 ? { type: "day_node", label: `Day node intake for ${ctx.dayAddr}` } : null,
    temporalEvidenceItems.length > 0 ? { type: "temporal_intake", label: `Temporal intake for ${ctx.dayAddr}` } : null,
    projectRowsForSummary.length > 0 ? { type: "project_activity", label: `Active project edges for ${ctx.dayAddr}` } : null,
  ].filter((item): item is { type: string; label: string } => item !== null);

  return {
    ok: true,
    routine_id: ROUTINE_ID,
    schema: SCHEMA_ID,
    target_path: TARGET_PATH,
    captured_at: ctx.now.toISOString(),
    session_date: ctx.targetDate,
    status,
    summary_line: payload.summary,
    tags: ["summary", "accomplishments"],
    payload,
    ...(sourceRefs.length > 0 ? { source_refs: sourceRefs } : {}),
  };
}

export const SUMMARY_DAILY_ACCOMPLISHMENTS: DayJournalRoutineDefinition = {
  id: ROUTINE_ID,
  label: "Daily Accomplishments",
  description: "Summarize the local day's accomplishments into a personal journal note.",
  domain: "summaries",
  sensitivity: "personal",
  routineClass: "context_only",
  defaultSchedule: "daily@23:30",
  defaultEnabled: false,
  payloadSizeLimitBytes: 65536,
  payloadPreviewLimitBytes: 4096,
  timeoutMs: 60_000,
  dryRunMode: "hosted_metadata_ok",
  permissions: ["journal_write"],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  run: runDailyAccomplishments,
};
