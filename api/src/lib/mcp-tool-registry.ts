/**
 * MCP tool catalog for web MCP connectors —
 * VO-WEB-AGENT-CONNECTORS-DESIGN-PR-1.
 *
 * Runtime contract module. Rung 11b's `POST /mcp` adapter
 * imports this catalog to advertise and dispatch each MCP `tool` call to
 * the matching `/hosted-mcp/*` REST handler-core via the
 * Q1=A in-process adapter pattern.
 *
 * Each entry carries:
 *   - The MCP-spec annotations web MCP clients surface in their
 *     tool pickers (title, description, hints, input_schema).
 *   - The adapter-mapping fields (rest_method, rest_path,
 *     policy_gates) the drift guard pins.
 *
 * `policy_gates` mirrors the gate set declared by the
 * matching entry in `HOSTED_MCP_POLICY_MATRIX`
 * (`hosted-mcp-policy-matrix.ts`). The drift guard cross-
 * checks both surfaces so dropping a gate from either the
 * hosted REST route or the `/mcp` connector wrapper without
 * updating the catalog fails CI — the Q1=A load-bearing
 * invariant.
 */

import {
  MEMORY_LIFECYCLE_TYPES,
  STRUCTURE_TYPES,
  WRITE_INTENT_CATEGORIES,
  WRITE_INTENT_ROUTINE_TYPES,
} from "./remote-command-types";

export const MCP_CONNECTOR_TOOLS = [
  "vo.status",
  "vo.policy_matrix",
  "vo.memories.list",
  "vo.memories.get",
  "vo.day_journal.day_get",
  "vo.day_journal.search",
  "vo.projects.list",
  "vo.vault.dossiers",
  "vo.commands.get",
  "vo.commands.cancel",
  "vo.write.intent",
] as const;

export type McpConnectorTool = (typeof MCP_CONNECTOR_TOOLS)[number];

/** Alias retained so the rung-11b dispatch surface
 *  (mcp-server.ts, mcp-remote.ts) reads `CONNECTOR_TOOL_NAMES`
 *  rather than `MCP_CONNECTOR_TOOLS`. Pointing the alias at the
 *  same `as const` tuple — instead of duplicating the literals —
 *  guarantees the two surfaces cannot drift. The drift guard
 *  pins this alias relationship explicitly. */
export const CONNECTOR_TOOL_NAMES = MCP_CONNECTOR_TOOLS;

export const MCP_CONNECTOR_PUBLIC_TOOL_NAMES = [
  "vo_status",
  "vo_policy_matrix",
  "vo_memories_list",
  "vo_memories_get",
  "vo_day_journal_day_get",
  "vo_day_journal_search",
  "vo_projects_list",
  "vo_vault_dossiers",
  "vo_commands_get",
  "vo_commands_cancel",
  "vo_write_intent",
] as const;

export type McpConnectorPublicTool = (typeof MCP_CONNECTOR_PUBLIC_TOOL_NAMES)[number];

const DAY_JOURNAL_DAY_ADDR_PATTERN = "^TMP\\.([0-9]{4})\\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$";
const DAY_JOURNAL_ROUTINE_ID_PATTERN = "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$";
const DAY_JOURNAL_TAG_PATTERN = "^[a-z0-9_-]{1,64}$";
const WRITE_INTENT_COMMAND_TYPES = [
  ...MEMORY_LIFECYCLE_TYPES,
  ...STRUCTURE_TYPES,
  ...WRITE_INTENT_ROUTINE_TYPES,
] as const;

const PUBLIC_TOOL_NAME_BY_CANONICAL: Record<McpConnectorTool, McpConnectorPublicTool> = {
  "vo.status": "vo_status",
  "vo.policy_matrix": "vo_policy_matrix",
  "vo.memories.list": "vo_memories_list",
  "vo.memories.get": "vo_memories_get",
  "vo.day_journal.day_get": "vo_day_journal_day_get",
  "vo.day_journal.search": "vo_day_journal_search",
  "vo.projects.list": "vo_projects_list",
  "vo.vault.dossiers": "vo_vault_dossiers",
  "vo.commands.get": "vo_commands_get",
  "vo.commands.cancel": "vo_commands_cancel",
  "vo.write.intent": "vo_write_intent",
};

/** Each descriptor carries the MCP-spec metadata web MCP clients
 *  surface in their tool pickers AND the adapter-mapping
 *  fields the drift guard pins. */
export interface McpToolDescriptor {
  name: McpConnectorTool;
  /** MCP-spec annotations (visible to web MCP users). */
  title: string;
  description: string;
  read_only: boolean;
  /** Spec annotations recognized by MCP client tool pickers. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  /** Input schema in JSON Schema (draft-07). MUST be an
   *  object schema even for parameterless tools — empty
   *  `{}` is rejected. The `additionalProperties: false`
   *  invariant prevents MCP clients from passing through
   *  arbitrary tool args we don't model. */
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    additionalProperties: false;
    required?: ReadonlyArray<string>;
    allOf?: ReadonlyArray<unknown>;
  };
  /** Method + path the in-process adapter dispatches to. */
  rest_method: "GET" | "POST";
  rest_path: string;
  /** Policy gates enforced before the mapped handler-core runs.
   *  Most come from the hosted REST route; connector-only gates
   *  such as `connector_write_scope` are enforced by `/mcp`
   *  before it dispatches to the same core. Drift guard
   *  cross-checks this against `HOSTED_MCP_POLICY_MATRIX`
   *  so dropping a gate without updating the catalog fails CI. */
  policy_gates: ReadonlyArray<string>;
}

/** O(1) lookup helper used by `mcp-server.ts`'s `dispatchToolCall`.
 *  Case-sensitive. Accepts both the internal dotted name and the
 *  web-client-safe public wire name so existing local clients keep
 *  working while hosted tools/list avoids no-dot tool-name validators. */
export function lookupConnectorToolByName(
  name: string,
): McpToolDescriptor | null {
  const found = MCP_CONNECTOR_TOOL_CATALOG.find(
    (entry) => entry.name === name || publicConnectorToolName(entry.name) === name,
  );
  return found ?? null;
}

export function publicConnectorToolName(name: McpConnectorTool): McpConnectorPublicTool {
  const publicName = PUBLIC_TOOL_NAME_BY_CANONICAL[name];
  if (!publicName) throw new Error(`No public MCP tool name for ${name}`);
  return publicName;
}

export const MCP_CONNECTOR_TOOL_CATALOG: ReadonlyArray<McpToolDescriptor> = [
  {
    name: "vo.status",
    title: "VO Status",
    description:
      "Mirror health snapshot: agent identity, tenant_id, policy snapshot (visible_projects, managed_project_addrs), and machine_settings. Safe to call first.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/status",
    policy_gates: ["vo_enabled"],
  },
  {
    name: "vo.policy_matrix",
    title: "VO Policy Matrix",
    description:
      "Self-describing enumeration of every hosted-mcp route, capability class, policy gates, and freshness guarantees. Use to discover the surface in one request.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/policy-matrix",
    policy_gates: ["authenticated"],
  },
  {
    name: "vo.memories.list",
    title: "VO Memories — List",
    description:
      "List mirrored memories for the bound tenant. Tenant-scoped memories remain visible; project-backed memories are scoped by visible_projects + managed_project_addrs. Carries last_sync_at freshness in every response.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
        project_addr: {
          type: "string",
          description: "Optional project address filter. Returns only memories with this project_addr.",
        },
        updated_since: {
          type: "string",
          format: "date-time",
          description: "Optional ISO timestamp filter over mirrored updated_at.",
        },
        memory_type: {
          type: "string",
          description: "Optional decrypted-payload memory_type filter. Requires content-decrypt mode.",
        },
        min_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Optional decrypted-payload confidence lower bound. Requires content-decrypt mode.",
        },
      },
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/memories",
    policy_gates: [
      "vo_enabled",
      "visible_projects",
      "security_mode=content_opaque",
    ],
  },
  {
    name: "vo.memories.get",
    title: "VO Memories — Get One",
    description:
      "Fetch one mirrored memory by addr. Malformed addrs return invalid_addr; well-formed addrs outside visible_projects or not synced return 404 without leaking existence.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        addr: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
      required: ["addr"],
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/memories/:addr",
    policy_gates: [
      "vo_enabled",
      "visible_projects",
      "security_mode=content_opaque",
    ],
  },
  {
    name: "vo.day_journal.day_get",
    title: "VO Day Journal — Get Day",
    description:
      "Read one mirrored day-journal day by TMP day address. Entries are filtered by day-journal read scope and project policy; content-opaque tenants receive metadata-only entries.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        day_addr: {
          type: "string",
          pattern: DAY_JOURNAL_DAY_ADDR_PATTERN,
          description: "TMP.YYYY.DDD day address.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
      required: ["day_addr"],
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/day-journal/day/:addr",
    policy_gates: [
      "vo_enabled",
      "day_journal_read_scope",
      "visible_projects",
      "managed_project_addrs",
      "security_mode=content_opaque",
    ],
  },
  {
    name: "vo.day_journal.search",
    title: "VO Day Journal — Search",
    description:
      "Search mirrored day-journal entry projections by date range, routine, tag, sensitivity, or preview text. Results are filtered by day-journal read scope and project policy; text and tag search require hosted-decrypt content visibility.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        start_date: { type: "string", format: "date" },
        end_date: { type: "string", format: "date" },
        routine_id: { type: "string", pattern: DAY_JOURNAL_ROUTINE_ID_PATTERN },
        tag: { type: "string", pattern: DAY_JOURNAL_TAG_PATTERN, maxLength: 64 },
        sensitivity: {
          type: "string",
          enum: ["standard", "personal", "health", "financial", "calendar", "email"],
        },
        q: { type: "string", maxLength: 1000, pattern: "^[^\\u0000]*$" },
      },
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/day-journal/search",
    policy_gates: [
      "vo_enabled",
      "day_journal_read_scope",
      "visible_projects",
      "managed_project_addrs",
      "security_mode=content_opaque",
    ],
  },
  {
    name: "vo.projects.list",
    title: "VO Projects — List",
    description:
      "List mirrored projects for the bound tenant, narrowed by the agent's visible_projects + managed_project_addrs.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/projects",
    policy_gates: [
      "vo_enabled",
      "visible_projects",
      "managed_project_addrs",
    ],
  },
  {
    name: "vo.vault.dossiers",
    title: "VO Vault — List Dossiers",
    description:
      "List vault dossier metadata for the bound tenant. Metadata-only by default; vault_sync gate may downgrade content even further.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/vault/dossiers",
    policy_gates: ["vo_enabled", "vault_sync", "visible_projects"],
  },
  {
    name: "vo.commands.get",
    title: "VO Commands — Get Status",
    description:
      "Poll a hosted write-intent command by id. Returns queue status, terminal outcome, claim timing, rejection reason, and created or affected address/id when safe.",
    read_only: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 36, maxLength: 36 },
      },
      additionalProperties: false,
      required: ["command_id"],
    },
    rest_method: "GET",
    rest_path: "/hosted-mcp/commands/:id",
    policy_gates: ["origin_agent_scope"],
  },
  {
    name: "vo.commands.cancel",
    title: "VO Commands — Cancel Queued",
    description:
      "Withdraw a queued hosted write-intent command before the local VO node claims it. Only the hosted agent that queued the command can cancel it.",
    read_only: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 36, maxLength: 36 },
      },
      additionalProperties: false,
      required: ["command_id"],
    },
    rest_method: "POST",
    rest_path: "/hosted-mcp/commands/:id/cancel",
    policy_gates: ["write_permission", "connector_write_scope", "origin_agent_scope"],
  },
  {
    name: "vo.write.intent",
    title: "VO Write Intent",
    description:
      "Queue a reviewed VO write intent for the selected hosted agent. Returns a command id, queue status, queue health, and REST poll URL; local VO applies or rejects later. idempotency_key is required for non-dry-run calls. Payload keys are validated per command type at queue time.",
    read_only: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    input_schema: {
      type: "object",
      properties: {
        category: { enum: [...WRITE_INTENT_CATEGORIES] },
        command_type: {
          enum: [...WRITE_INTENT_COMMAND_TYPES],
        },
        payload: { type: "object", additionalProperties: true },
        idempotency_key: {
          type: "string",
          minLength: 8,
          maxLength: 200,
          description: "Required unless dry_run is true.",
        },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
      required: ["category", "command_type", "payload"],
      allOf: [
        {
          if: {
            properties: { category: { const: "memory_lifecycle" } },
            required: ["category"],
          },
          then: {
            properties: {
              command_type: { enum: [...MEMORY_LIFECYCLE_TYPES] },
            },
          },
        },
        {
          if: {
            properties: { category: { const: "structure" } },
            required: ["category"],
          },
          then: {
            properties: {
              command_type: { enum: [...STRUCTURE_TYPES] },
            },
          },
        },
        {
          if: {
            properties: { category: { const: "routines" } },
            required: ["category"],
          },
          then: {
            properties: {
              command_type: { enum: [...WRITE_INTENT_ROUTINE_TYPES] },
            },
          },
        },
        {
          if: {
            properties: { dry_run: { const: true } },
            required: ["dry_run"],
          },
          then: {},
          else: { required: ["idempotency_key"] },
        },
      ],
    },
    rest_method: "POST",
    rest_path: "/mcp vo.write.intent",
    // Gate names align with the matrix POST /hosted-mcp/write entry. The
    // connector-only OAuth scope gate is `connector_write_scope` (same name the
    // matrix + vo.commands.cancel use) — NOT a bespoke per-tool literal.
    policy_gates: [
      "connector_write_scope",
      "write_permission",
      "hosted_agent_writable_scope",
    ],
  },
];
