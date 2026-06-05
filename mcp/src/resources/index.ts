/**
 * Resource registry + SDK registration helper —
 * VO-MCP-RESOURCES-PROMPTS-PR-1.
 *
 * Matches the shape of `tools/index.ts`: handwritten array of
 * ResourceDefinition entries, plus `registerResources()` that wires
 * each into the SDK's McpServer.
 *
 * Every new resource MUST:
 *   1. have a corresponding section in docs/VO-MCP-SERVER-CONTRACT.md
 *      (Rung 8) first,
 *   2. land in the same commit as the handler + test, and
 *   3. be added to `resources/names.ts` so the drift guard pins it.
 */
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { memoryAuditResource } from "./memory-audit.js";
import { memoryDetailResource } from "./memory-detail.js";
import { memoryReviewPendingResource } from "./memory-review-pending.js";
import {
  RESOURCE_NAMES as NAMES_CONST,
  RESOURCE_STATIC_URIS as STATIC_URIS_CONST,
  RESOURCE_TEMPLATE_URIS as TEMPLATE_URIS_CONST,
} from "./names.js";
import { serverStatusResource } from "./server-status.js";
import type { ResourceDefinition, ServerStatusInputs } from "./types.js";
import type { VoClient } from "../vo-client.js";

/** Authoritative runtime list. Order matters ONLY for
 *  `resources/list` and `resources/templates/list` output, not
 *  behavior. */
export const RESOURCES: ResourceDefinition[] = [
  // static
  serverStatusResource,
  memoryReviewPendingResource,
  // template
  memoryDetailResource,
  memoryAuditResource,
];

// ── Drift-guard exports — paired with index.test.ts ─────────────────

export const RESOURCE_NAMES = NAMES_CONST;
export const RESOURCE_STATIC_URIS = STATIC_URIS_CONST;
export const RESOURCE_TEMPLATE_URIS = TEMPLATE_URIS_CONST;

export const DERIVED_RESOURCE_NAMES = RESOURCES.map((r) => r.name);
export const DERIVED_STATIC_URIS = RESOURCES.filter(
  (r): r is Extract<ResourceDefinition, { kind: "static" }> => r.kind === "static",
).map((r) => r.uri);
export const DERIVED_TEMPLATE_URIS = RESOURCES.filter(
  (r): r is Extract<ResourceDefinition, { kind: "template" }> => r.kind === "template",
).map((r) => r.uriTemplate);

// ── SDK registration ────────────────────────────────────────────────

export interface RegisterResourcesOptions {
  status: ServerStatusInputs;
  client: VoClient;
}

/**
 * Register every RESOURCES entry with the SDK's McpServer.
 *
 * Static resources use `registerResource(name, uri, config, cb)`.
 * Template resources use `registerResource(name, ResourceTemplate, config, cb)`
 * with `list: undefined` because addrs are not enumerable from the
 * resource layer (no ranking/search inside MCP per contract) —
 * they're discovered via the `vo_memory_search` tool or via the
 * `memory_review_pending` static resource.
 */
export function registerResources(
  server: McpServer,
  opts: RegisterResourcesOptions,
): void {
  const ctx = { client: opts.client, status: opts.status };
  for (const resource of RESOURCES) {
    if (resource.kind === "static") {
      server.registerResource(
        resource.name,
        resource.uri,
        {
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        async (uri) => resource.handler(ctx, uri),
      );
      continue;
    }
    // template
    const template = new ResourceTemplate(resource.uriTemplate, {
      list: undefined,
    });
    server.registerResource(
      resource.name,
      template,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri, variables) => resource.handler(ctx, uri, variables),
    );
  }
}
