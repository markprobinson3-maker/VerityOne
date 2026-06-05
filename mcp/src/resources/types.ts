/**
 * Shared types for MCP resource handlers —
 * VO-MCP-RESOURCES-PROMPTS-PR-1.
 *
 * Resources are a read-only view into already-existing local VO
 * state. Thin adapter per docs/VO-MCP-SERVER-CONTRACT.md:
 *   - no ranking / routing / storage / validation logic
 *   - no writes (resources are read-only by contract)
 *   - no fallback to public endpoints
 *   - no VO_TOKEN or bearer values in resource contents
 *   - on any backend failure → throw; SDK maps to JSON-RPC error
 *     and caller sees a real resource-read failure, not silent
 *     partial data
 */

import type { VoClient } from "../vo-client.js";

/** One content block in a ReadResourceResult. */
export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/** MCP ReadResourceResult. Index signature placates the SDK's
 *  generic constraint without importing its internal types. */
export interface ResourceResult {
  contents: ResourceContent[];
  [key: string]: unknown;
}

/** Runtime values the server-status resource needs. The server
 *  passes these in at registration time because they are computed
 *  from the actual registered counts. */
export interface ServerStatusInputs {
  packageVersion: string;
  baseUrl: string;
  authSource: string;
  counts: {
    tools: number;
    static_resources: number;
    resource_templates: number;
    prompts: number;
  };
}

/** Static URI resource — fixed URI, single read. */
export interface StaticResourceDefinition {
  kind: "static";
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  handler(ctx: ResourceHandlerContext, uri: URL): Promise<ResourceResult>;
}

/** Template URI resource — discovered via `resources/templates/list`.
 *  The SDK expands URI-template variables into `variables` for the
 *  handler. */
export interface TemplateResourceDefinition {
  kind: "template";
  name: string;
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  handler(
    ctx: ResourceHandlerContext,
    uri: URL,
    variables: Record<string, string | string[]>,
  ): Promise<ResourceResult>;
}

export type ResourceDefinition =
  | StaticResourceDefinition
  | TemplateResourceDefinition;

/** Everything a resource handler might need from the server. No
 *  state mutation: the server passes values in by value / by
 *  reference but handlers treat them as read-only. */
export interface ResourceHandlerContext {
  client: VoClient;
  status: ServerStatusInputs;
}

/** Small helper: wrap a JSON-serializable payload into the standard
 *  single-content-block envelope the SDK expects. */
export function jsonResource(uri: URL, payload: unknown): ResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Thin wrapper for the "local VO returned an unexpected shape"
 * case. Thrown errors propagate through the SDK as JSON-RPC error
 * responses, which MCP clients (and our raw stdio proof client)
 * observe as read failures. We deliberately surface the route path
 * in the message so diagnostics are concrete.
 */
export class ResourceReadError extends Error {
  constructor(
    message: string,
    /** Indicates the resource is structurally unreachable on the
     *  currently-running API (e.g., route not mounted). Callers
     *  classify this as "unproven" in the interop matrix rather
     *  than "fail". */
    public routeUnavailable: boolean = false,
  ) {
    super(message);
    this.name = "ResourceReadError";
  }
}
