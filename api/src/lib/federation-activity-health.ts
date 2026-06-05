/**
 * Federation activity-telemetry vocabulary —
 * VO-FEDERATION-ACTIVITY-TELEMETRY-DESIGN-PR-1 (rung 6).
 *
 * Shared contract pinning the vocabulary rung 7's dashboard
 * (`VO-FEDERATION-ACTIVITY-DASHBOARD-PR-1`) will consume on
 * new local `/dashboard/sessions` and hosted `/my/sessions`
 * pages. Those routes are deliberately distinct from the
 * existing `/dashboard/activity` + `/my/activity` memory-
 * activity surfaces — rung 7 ships a new page, not a replacement.
 * Rung 6 is a DESIGN-PR — this module ships the vocabulary +
 * derivation + redaction; rung 7 ships the writers + readers
 * + renders.
 *
 * Four non-negotiables from the ladder (rung 6 scope, doc
 * lines 170–189):
 *
 *   1. Active agent sessions visible individually when evidence
 *      exists. Rung 6 shipped four session types; rung 11b adds
 *      `hosted-mcp-connector` for web MCP connector calls.
 *   2. No bearer tokens, raw MCP payloads, local config, or
 *      unnecessary filesystem paths in activity rows —
 *      enforced by `redactActivityEventMetadata` + typed
 *      event schema.
 *   3. Local + hosted dashboards render comparable summaries
 *      (shared enum + shared derivation fn).
 *   4. Activity is evidence-scoped — no row without proof;
 *      rung 7's writers piggyback existing hosted signals
 *      only (audit INSERT sites, sync push, remote-commands
 *      apply). Local pulse capture defers to a follow-on.
 *
 * Design-decision provenance (locked at plan-mode):
 *
 *   Q1=A  new `federation_activity` table (not audit-log)
 *   Q2=A  hybrid session UUID + synthetic operator label
 *   Q3=A  runtime scrubber + typed event schema
 *   Q4=A  hosted-side aggregation first; local pulses defer
 */

import { LOCAL_PATH_PATTERNS, SECRET_PATTERNS } from "./federation-redaction-patterns";
import type { McpConnectorTool } from "./mcp-tool-registry";
import type { CommandStatus } from "./remote-command-types";

type ActivityCommandId = string;
type ActivityAgentId = string;
type ActivityHttpMethod = "HEAD" | "GET" | "DELETE" | "PATCH" | "PUT";

// ── Event taxonomy ──────────────────────────────────────────
//
// Six event types cover every hosted signal source rung 7
// will aggregate from. Every type maps to at least one
// existing write site — no speculative events.

export const ACTIVITY_EVENT_TYPES = [
  "session_initialized",  // first observed presence of a session
  "read",                 // hosted mirror read (subsumes decrypt_access)
  "write_intent",         // remote_commands INSERT (queued)
  "sync_push",            // hosted_sync_batches row written
  "command_apply",        // remote_commands status → applied/rejected/failed
  "error",                // handler error raised while processing
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

// ── Session identity types ──────────────────────────────────
//
// Five actor classes after rung 11b. Rung 6 shipped four
// (local-mcp-client + 3 hosted classes); rung 11b adds the
// fifth (`hosted-mcp-connector`) for tool calls coming
// through the web MCP connector adapter.
//
// The TS vocabulary lists all five so the rung-7 dashboard
// can render every session class. The DB CHECK in
// db/federation-rung11b-activity-session-types-migration.sql
// permits four (excludes 'local-mcp-client') — that single
// TS-minus-SQL asymmetry is structural per the rung-6
// "hosted never invents local process presence"
// non-negotiable.

export const ACTIVITY_SESSION_TYPES = [
  "local-mcp-client",       // MCP client on the operator's machine
  "hosted-browser-session", // /my/* browser session-cookie calls
  "hosted-mcp-agent",       // /hosted-mcp/* REST authenticated agent calls
  "sync-node",              // /sync/push authenticated node
  "hosted-mcp-connector",   // /mcp web MCP connector calls (rung 11b)
] as const;

export type ActivitySessionType = (typeof ACTIVITY_SESSION_TYPES)[number];

// ── Freshness states ────────────────────────────────────────
//
// Three-state freshness for "when was this session last seen?"
// Kept deliberately narrower than the rung-3 SYNC_HEALTH_STATES
// — sync-health mixes operational errors (disabled/error) with
// freshness; activity freshness is time-since-last-event only.
// Dashboard can combine the two to display per-session status.

export const ACTIVITY_FRESHNESS_STATES = [
  "active",  // last event within ACTIVITY_ACTIVE_THRESHOLD_SECONDS
  "recent",  // within ACTIVITY_STALE_THRESHOLD_SECONDS
  "stale",   // older than stale threshold
] as const;

export type ActivityFreshnessState = (typeof ACTIVITY_FRESHNESS_STATES)[number];

/** Default active threshold — 60s. A session that has emitted
 *  any event in the last minute is rendered as "active" (green
 *  dot). Matches typical MCP roundtrip + browser page-activity
 *  cadence. */
export const ACTIVITY_ACTIVE_THRESHOLD_SECONDS = 60;

/** Default stale threshold — 900s (15 min). Mirrors
 *  SYNC_HEALTH_STALE_THRESHOLD_SECONDS so operators do not
 *  carry two different timescales in their head. A session
 *  with no events in 15 minutes is stale regardless of type. */
export const ACTIVITY_STALE_THRESHOLD_SECONDS = 900;

// ── Typed event metadata ────────────────────────────────────
//
// Discriminated union — `event_data` JSONB must conform to
// one of these shapes. Adding a new field requires editing
// this union; the drift guard enforces the source-code pin.
// This is the compile-time half of the Q3=A redaction model.

export type ActivityEventData =
  | {
      type: "session_initialized";
      session_type: ActivitySessionType;
    }
  | {
      // Shape matches DecryptAuditEvent in hosted-decrypt-audit.ts so
      // rung 7 can piggyback `logDecryptAccess` sites mechanically.
      // `resource_kind` enum mirrors the existing writer's values
      // verbatim; `result_count` (list reads) and `item_addr` (single-
      // item reads) are both optional — governance_status reads emit
      // neither, memory_detail reads emit item_addr, list reads emit
      // result_count.
      // `tool_name` is populated only for rung-11b hosted-mcp-connector
      // reads so the dashboard can group connector tool calls by name.
      // Literal union — never accept free-form strings here.
      type: "read";
      resource_kind:
        | "memories"
        | "projects"
        | "governance_status"
        | "day_journal_entries"
        | "vault_dossiers"
        | "memory_detail";
      result_count?: number;
      item_addr?: string;
      tool_name?: McpConnectorTool;
    }
  | {
      type: "write_intent";
      command_id: ActivityCommandId;
      category: string;
      command_type: string;
      source?: "hosted-mcp-rest" | "hosted-mcp-connector";
      target_node_id?: string;
      target_node_id_source?: "body" | "payload_compat";
      "remote_queue.target_node_id_compat_normalized"?: true;
    }
  | {
      type: "sync_push";
      item_count: number;
      outcome: "applied" | "rejected";
      reason?: "category_filtered_unsafe";
      rejected_count?: number;
      replay?: boolean;
    }
  | {
      type: "command_apply";
      command_id: ActivityCommandId; // remote_commands.id (UUID)
      outcome: "applied" | "rejected" | "failed";
      // Hosted-agent origin attribution, spread in by remote.ts when the
      // applied command originated from a hosted MCP agent. Declared here so the
      // typed-union excess-property check covers these deliberate fields rather
      // than the conditional spread silently bypassing it.
      origin_session_type?: "hosted-mcp-agent";
      origin_session_id?: string;
      origin_credential_id?: string;
      origin_actor_label?: string;
    }
  | {
      type: "error";
      route: string;
      status: number; // HTTP status the handler returned
      method?: ActivityHttpMethod;
      client_id?: string;
      origin?: string;
      user_agent?: string;
      mcp_protocol_version?: string;
      // Rung 12b sub-category. Literal-only to stay under the
      // rung-6 free-form-type cap; widen the union when a new
      // error class needs dashboard grouping.
      error_category?: "rate_limit" | "remote_cancel" | "wrong_method";
      command_id?: ActivityCommandId;
      agent_id?: ActivityAgentId;
      outcome?:
        | "invalid_command_id"
        | "write_permission_denied"
        | "governance_pending"
        | "governance_key_unavailable"
        | "write_scope_required"
        | "not_found"
        | "not_cancelable";
      current_status?: CommandStatus;
    };

// ── Freshness derivation ────────────────────────────────────

export interface ActivityFreshnessInput {
  /** ISO timestamp of the session's most recent activity row.
   *  null when the session has never appeared in the activity
   *  table. */
  lastEventAt: string | null;
  /** Optional test clock. Defaults to `Date.now()`. */
  nowMs?: number;
}

export function computeActivityFreshness(
  input: ActivityFreshnessInput,
): ActivityFreshnessState {
  if (!input.lastEventAt) return "stale";
  const ts = new Date(input.lastEventAt).getTime();
  if (!Number.isFinite(ts)) return "stale";
  const now = input.nowMs ?? Date.now();
  const ageSeconds = (now - ts) / 1000;
  if (ageSeconds <= ACTIVITY_ACTIVE_THRESHOLD_SECONDS) return "active";
  if (ageSeconds <= ACTIVITY_STALE_THRESHOLD_SECONDS) return "recent";
  return "stale";
}

// ── Redaction scrubber ──────────────────────────────────────
//
// Q3=A runtime half of the redaction model. Typed event union
// gates deliberate field additions at compile time; this
// scrubber catches stray secrets in the free-form JSONB
// `event_data` blob at write time.
//
// Behavior: walk every string value in the object (including
// nested arrays / objects) and replace any substring matched
// by SECRET_PATTERNS or LOCAL_PATH_PATTERNS with a bracketed
// redaction marker naming the pattern that fired. Operators
// can still debug — the pattern name is preserved — but the
// raw secret never lands on disk.
//
// The scrubber returns a NEW object; inputs are not mutated.

function redactString(value: string): string {
  let out = value;
  for (const { name, regex } of SECRET_PATTERNS) {
    // Fresh /g variant so global-replace works regardless of
    // the pattern's original flags.
    const g = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    out = out.replace(g, `[REDACTED:secret:${name}]`);
  }
  for (const { name, regex } of LOCAL_PATH_PATTERNS) {
    const g = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    out = out.replace(g, `[REDACTED:local_path:${name}]`);
  }
  return out;
}

export function redactActivityEventMetadata(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return walk(raw) as Record<string, unknown>;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // Drop any key that looks like a raw auth credential
      // even before scanning its value — belt-and-braces.
      if (isForbiddenKey(k)) {
        out[k] = "[REDACTED:forbidden_key]";
        continue;
      }
      // Scan the key itself for secrets + local paths. A caller
      // accidentally passing `{ "/Users/alice/project": 1 }` or
      // `{ "sk-ant-...": true }` must not survive the scrubber
      // with the sensitive string intact in the key position.
      // We rewrite such entries under a generic marker key +
      // preserve the original value (still walked).
      const redactedKey = redactString(k);
      if (redactedKey !== k) {
        out[redactedKey] = walk(val);
        continue;
      }
      out[k] = walk(val);
    }
    return out;
  }
  return v;
}

const FORBIDDEN_KEY_PATTERN =
  /^(authorization|bearer|token|access_token|refresh_token|id_token|api_key|apikey|secret|client_secret|private_key|password|passwd|cookie|session_token|x-vo-link-code|oauth_code|verifier)$/i;

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERN.test(key);
}
