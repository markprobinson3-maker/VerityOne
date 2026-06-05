/**
 * Resource: vo://server/status
 *
 * Read-only JSON snapshot of this MCP server's runtime identity.
 * Deliberately minimal — enough for an agent to confirm it is
 * talking to vo-mcp and which local VO it adapts over, without
 * exposing any bearer value.
 */
import {
  jsonResource,
  type ResourceResult,
  type StaticResourceDefinition,
  type ResourceHandlerContext,
} from "./types.js";

export const serverStatusResource: StaticResourceDefinition = {
  kind: "static",
  name: "server_status",
  uri: "vo://server/status",
  title: "vo-mcp server status",
  description:
    "Read-only JSON snapshot of this MCP server: package version, local VO base URL, auth source class, and counts of registered tools, resources, and prompts. Never exposes VO_TOKEN or any bearer value.",
  mimeType: "application/json",
  async handler(ctx: ResourceHandlerContext, uri: URL): Promise<ResourceResult> {
    const { status } = ctx;
    // Hard contract: every field here is inspectable + shippable.
    // The client's config file may carry a VO_TOKEN; `authSource`
    // is the CLASS of that source (e.g. "config_file"), never the
    // token itself.
    return jsonResource(uri, {
      server: {
        name: "vo-mcp",
        version: status.packageVersion,
      },
      vo: {
        base_url: status.baseUrl,
        auth_source: status.authSource,
      },
      counts: status.counts,
      note:
        "Read-only status snapshot. VO_TOKEN is never included in this resource.",
    });
  },
};
