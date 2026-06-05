/**
 * MCP Streamable HTTP server — pure protocol layer.
 * VO-WEB-AGENT-CONNECTOR-MCP-PR-1 (rung 11b).
 *
 * This module is deliberately HTTP-agnostic. It implements every
 * Streamable HTTP MCP requirement that does NOT need access to
 * the request body, the SQL connection, or the OAuth resolver:
 *
 *   - Single-message JSON-RPC 2.0 envelope parsing (batches
 *     rejected per the 2025-06-18 transport spec).
 *   - Transport-header validation (Origin, Content-Type,
 *     Accept, MCP-Protocol-Version).
 *   - Protocol version negotiation across Streamable HTTP-era versions.
 *   - Initialize result builder pinning `tools: {}` capability.
 *   - tools/list projection over MCP_CONNECTOR_TOOL_CATALOG.
 *   - Tool result wrapper carrying BOTH `structuredContent` and
 *     `content[].text` (Q1 lock).
 *   - tools/call params validator (`parseToolCallParams`) that
 *     distinguishes JSON-RPC `invalid_params` (missing/wrong-shape
 *     name + arguments) from the valid-shape `tool_not_found`
 *     envelope.
 *   - JSON-RPC error helpers with canonical codes.
 *
 * The route shell `routes/mcp-remote.ts` wires:
 *   - OAuth bearer resolution (rung-11a resolver),
 *   - DB-bound handler-core dispatch (`hosted-mcp-handler-cores.ts`),
 *   - audit/activity emit with `session_type='hosted-mcp-connector'`
 *     and `tool_name`,
 *   - HTTP response (always `application/json` in 11b — no SSE).
 */

import {
  MCP_CONNECTOR_TOOL_CATALOG,
  lookupConnectorToolByName,
  publicConnectorToolName,
  type McpToolDescriptor,
} from "./mcp-tool-registry";
import { DEFAULT_MCP_ALLOWED_ORIGINS, mcpAllowedOrigins } from "./mcp-origin";

export { DEFAULT_MCP_ALLOWED_ORIGINS };

// ── JSON-RPC 2.0 envelope types ─────────────────────────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Canonical JSON-RPC 2.0 error codes ──────────────────────

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function parseError(message = "Parse error", data?: unknown): JsonRpcError {
  return { code: JSON_RPC_ERROR_CODES.parseError, message, ...(data !== undefined ? { data } : {}) };
}

export function invalidRequest(message = "Invalid Request", data?: unknown): JsonRpcError {
  return {
    code: JSON_RPC_ERROR_CODES.invalidRequest,
    message,
    ...(data !== undefined ? { data } : {}),
  };
}

export function methodNotFound(method: string): JsonRpcError {
  return {
    code: JSON_RPC_ERROR_CODES.methodNotFound,
    message: `Method not found: ${method}`,
    data: { method },
  };
}

export function invalidParams(message = "Invalid params", data?: unknown): JsonRpcError {
  return {
    code: JSON_RPC_ERROR_CODES.invalidParams,
    message,
    ...(data !== undefined ? { data } : {}),
  };
}

export function internalError(message = "Internal error", data?: unknown): JsonRpcError {
  return {
    code: JSON_RPC_ERROR_CODES.internalError,
    message,
    ...(data !== undefined ? { data } : {}),
  };
}

// ── Envelope parser ─────────────────────────────────────────

export type ParsedMcpMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response"; message: JsonRpcResponse };

/** Parses a single JSON-RPC 2.0 message from a raw POST body. Rejects
 *  batches because the MCP Streamable HTTP transport spec says the
 *  body MUST be a single message (not an array). */
export function parseMcpRequest(
  rawBody: string,
): { ok: true; parsed: ParsedMcpMessage } | { ok: false; error: JsonRpcError } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (e) {
    return {
      ok: false,
      error: parseError("Parse error", { reason: (e as Error).message }),
    };
  }

  if (Array.isArray(json)) {
    return {
      ok: false,
      error: invalidRequest("JSON-RPC batch is not allowed by the MCP Streamable HTTP transport."),
    };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, error: invalidRequest("Body must be a JSON object.") };
  }

  const obj = json as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    return { ok: false, error: invalidRequest('jsonrpc field must be "2.0".') };
  }

  const hasId = Object.prototype.hasOwnProperty.call(obj, "id");
  const hasMethod = typeof obj.method === "string";
  const hasResult = Object.prototype.hasOwnProperty.call(obj, "result");
  const hasError = Object.prototype.hasOwnProperty.call(obj, "error");

  if (hasMethod && hasId) {
    if (hasResult || hasError) {
      return {
        ok: false,
        error: invalidRequest("Request object must not include result or error fields."),
      };
    }
    if (obj.id !== null && typeof obj.id !== "string" && typeof obj.id !== "number") {
      return {
        ok: false,
        error: invalidRequest("Request id must be a string, number, or null."),
      };
    }
    return {
      ok: true,
      parsed: { kind: "request", message: obj as unknown as JsonRpcRequest },
    };
  }
  if (hasMethod && !hasId) {
    if (hasResult || hasError) {
      return {
        ok: false,
        error: invalidRequest("Notification object must not include result or error fields."),
      };
    }
    return {
      ok: true,
      parsed: { kind: "notification", message: obj as unknown as JsonRpcNotification },
    };
  }
  if (hasId && (hasResult || hasError)) {
    if (hasResult && hasError) {
      return {
        ok: false,
        error: invalidRequest("Response object must not include both result and error fields."),
      };
    }
    if (obj.id !== null && typeof obj.id !== "string" && typeof obj.id !== "number") {
      return {
        ok: false,
        error: invalidRequest("Response id must be a string, number, or null."),
      };
    }
    return {
      ok: true,
      parsed: { kind: "response", message: obj as unknown as JsonRpcResponse },
    };
  }
  return { ok: false, error: invalidRequest("Body is not a valid JSON-RPC request, notification, or response.") };
}

// ── Transport-header validation ─────────────────────────────

export interface TransportValidationResult {
  ok: boolean;
  status?: 403 | 406 | 415 | 400;
  error?: string;
}

interface TransportHeaders {
  origin?: string | null;
  contentType?: string | null;
  accept?: string | null;
  mcpProtocolVersion?: string | null;
}

/** Validate the transport headers a POST /mcp request carries.
 *  - `Origin`: absent or in the MCP Origin allow-list allowed;
 *    anything else → 403. Defaults include Claude and OpenAI web
 *    clients; `VERITY_MCP_ALLOWED_ORIGINS` can override for other
 *    spec-compliant browser clients without code changes.
 *  - `Content-Type`: must include `application/json` (parameters
 *    such as `; charset=utf-8` allowed) → 415 otherwise.
 *  - `Accept`: must signal both `application/json` AND
 *    `text/event-stream` (or `*\/*`) per the spec → 406 otherwise.
 *  - `MCP-Protocol-Version`: ignored on `initialize` (the version
 *    is negotiated in-band); on every other request, an unsupported
 *    value returns 400. Absent header passes (defaults to 2025-03-26
 *    per the spec).
 */
export function validateMcpTransportHeaders(
  headers: TransportHeaders,
  opts: { isInitialize: boolean },
): TransportValidationResult {
  if (headers.origin) {
    if (!mcpAllowedOrigins().has(headers.origin)) {
      return { ok: false, status: 403, error: `Origin "${headers.origin}" not allowed.` };
    }
  }

  if (!headers.contentType) {
    return { ok: false, status: 415, error: "Content-Type required." };
  }
  const ctMain = headers.contentType.split(";")[0].trim().toLowerCase();
  if (ctMain !== "application/json") {
    return {
      ok: false,
      status: 415,
      error: `Content-Type "${headers.contentType}" not supported; expected application/json.`,
    };
  }

  if (!headers.accept) {
    return { ok: false, status: 406, error: "Accept header required." };
  }
  if (!acceptIncludesJsonAndSse(headers.accept)) {
    return {
      ok: false,
      status: 406,
      error: 'Accept must include both "application/json" and "text/event-stream".',
    };
  }

  if (!opts.isInitialize && headers.mcpProtocolVersion) {
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(headers.mcpProtocolVersion as ProtocolVersion)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported MCP-Protocol-Version "${headers.mcpProtocolVersion}".`,
      };
    }
  }

  return { ok: true };
}

function acceptIncludesJsonAndSse(accept: string): boolean {
  const tokens = accept
    .split(",")
    .map((t) => t.split(";")[0].trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.includes("*/*")) return true;
  const hasJson = tokens.some((t) => t === "application/json" || t === "application/*");
  const hasSse = tokens.some((t) => t === "text/event-stream" || t === "text/*");
  return hasJson && hasSse;
}

// ── Protocol version negotiation ────────────────────────────

/** Streamable HTTP-era protocol versions in chronological order —
 *  newest last. The MCP spec instructs servers to reply with the
 *  highest mutually supported version; on an unknown client version
 *  the server defaults to the newest spec it understands. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const LATEST_PROTOCOL_VERSION: ProtocolVersion = "2025-06-18";
/** Default for transport-header inference when an MCP-Protocol-Version
 *  header is absent on a non-initialize request (per the 2025-06-18
 *  transport spec). */
export const DEFAULT_TRANSPORT_PROTOCOL_VERSION: ProtocolVersion = "2025-03-26";

export function negotiateProtocolVersion(clientVersion: unknown): ProtocolVersion {
  if (typeof clientVersion === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)) {
    return clientVersion as ProtocolVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

// ── initialize result builder ───────────────────────────────

export interface ServerInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  capabilities: { tools: Record<string, never> };
  serverInfo: ServerInfo;
}

/** Builds the result for an `initialize` request. Declares ONLY the
 *  `tools` capability — no `resources`, `prompts`, `logging`, or
 *  `completion`. Matches Q4=A (read-only tools first). */
export function buildInitializeResult(input: {
  protocolVersion: ProtocolVersion;
  serverInfo: ServerInfo;
}): InitializeResult {
  return {
    protocolVersion: input.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: input.serverInfo,
  };
}

// ── tools/list result builder ───────────────────────────────

export interface McpToolListEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: McpToolDescriptor["input_schema"];
  annotations: McpToolDescriptor["annotations"];
}

export interface ToolsListResult {
  tools: McpToolListEntry[];
}

export function buildToolsListResult(): ToolsListResult {
  return {
    tools: MCP_CONNECTOR_TOOL_CATALOG.map((entry) => ({
      name: publicConnectorToolName(entry.name),
      title: entry.title,
      description: entry.description,
      inputSchema: entry.input_schema,
      annotations: entry.annotations,
    })),
  };
}

// ── tools/call result wrapper ───────────────────────────────

export interface ToolCallContent {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolCallContent[];
  structuredContent: unknown;
  isError: boolean;
}

/** Wraps a core's result body as an MCP tool/call result.
 *  Q1=A: returns BOTH `structuredContent` (typed JSON for
 *  spec-2025-06-18 clients) AND `content[0].text` (the same
 *  JSON stringified, for older clients that don't parse
 *  structuredContent). */
export function wrapToolResult(rawCoreBody: unknown, ok: boolean): ToolCallResult {
  // A core body should always be plain JSON, but guard the stringify so a
  // pathological value (BigInt, circular ref, throwing toJSON) degrades to a
  // deterministic error wrapper instead of throwing past dispatch into the
  // route-shell's opaque 500 (which would lose structuredContent entirely).
  let text: string;
  try {
    text = JSON.stringify(rawCoreBody, null, 2);
  } catch {
    const fallback = { ok: false, error: "unserializable_result" };
    return {
      content: [{ type: "text", text: JSON.stringify(fallback, null, 2) }],
      structuredContent: fallback,
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: rawCoreBody,
    isError: !ok,
  };
}

// ── tools/call params validator ─────────────────────────────

export type ParsedToolCall =
  | { ok: true; name: string; arguments: Record<string, unknown> }
  | { ok: false; error: JsonRpcError };

/** Validates the protocol shape of a `tools/call` request's `params`
 *  before dispatch. Returns canonical JSON-RPC `invalid_params` for:
 *    - missing `params`,
 *    - non-object `params`,
 *    - missing `params.name`,
 *    - non-string `params.name`,
 *    - non-object `params.arguments`.
 *
 *  This is the protocol-vs-tool-error distinction the MCP spec
 *  requires — a valid-shape call against an unknown tool name lives
 *  inside `tools/call` `isError: true` `tool_not_found`, not as a
 *  JSON-RPC error. */
export function parseToolCallParams(params: unknown): ParsedToolCall {
  if (params === undefined || params === null) {
    return { ok: false, error: invalidParams("tools/call requires params.") };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: invalidParams("tools/call params must be an object.") };
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return {
      ok: false,
      error: invalidParams("tools/call params.name must be a non-empty string."),
    };
  }
  if (obj.arguments !== undefined && obj.arguments !== null) {
    if (typeof obj.arguments !== "object" || Array.isArray(obj.arguments)) {
      return {
        ok: false,
        error: invalidParams("tools/call params.arguments must be an object when provided."),
      };
    }
  }
  return {
    ok: true,
    name: obj.name,
    arguments: (obj.arguments as Record<string, unknown>) ?? {},
  };
}

// ── tools/call dispatcher ───────────────────────────────────

export type ToolExecutor = (
  entry: McpToolDescriptor,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; body: unknown }>;

/** Looks up the catalog entry by name; if unknown, returns a
 *  `tool_not_found` envelope wrapped via `wrapToolResult` (NOT a
 *  JSON-RPC error). For valid names, calls `executor` and wraps
 *  the result. The catalog drift guard pins this dispatch surface
 *  so a typoed tool name on either side fails CI. */
export async function dispatchToolCall(
  parsed: { name: string; arguments: Record<string, unknown> },
  executor: ToolExecutor,
): Promise<ToolCallResult> {
  const entry = lookupConnectorToolByName(parsed.name);
  if (!entry) {
    return wrapToolResult(
      { ok: false, error: "tool_not_found", tool_name: parsed.name },
      false,
    );
  }
  const result = await executor(entry, parsed.arguments);
  return wrapToolResult(result.body, result.ok);
}
