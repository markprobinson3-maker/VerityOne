/**
 * Resource template: vo://memory/{addr}
 *
 * Wraps `GET /memory/:addr`. Requires a concrete, already-known
 * addr — no search / ranking / routing inside the resource layer.
 * Use the tool `vo_memory_search` to discover addrs, then read a
 * specific memory via this resource.
 *
 * Discoverable via `resources/templates/list` (not `resources/list`).
 *
 * Error handling:
 *   - malformed addr (must match `PJ.\d+.\d+.\d+`) → ResourceReadError
 *   - local VO reachable but route returns 4xx/5xx → ResourceReadError
 *   - local VO unreachable → ResourceReadError
 * Never returns partial data.
 */
import {
  jsonResource,
  ResourceReadError,
  type ResourceHandlerContext,
  type ResourceResult,
  type TemplateResourceDefinition,
} from "./types.js";

const ADDR_RE = /^PJ\.\d+\.\d+\.\d+$/;

export const memoryDetailResource: TemplateResourceDefinition = {
  kind: "template",
  name: "memory_detail",
  uriTemplate: "vo://memory/{addr}",
  title: "Memory detail by addr",
  description:
    "Read-only JSON snapshot of a tenant memory addressed by its PJ.x.y.z addr. Wraps GET /memory/:addr on the local VO. Requires a concrete addr — no search / ranking inside the resource layer.",
  mimeType: "application/json",
  async handler(
    ctx: ResourceHandlerContext,
    uri: URL,
    variables: Record<string, string | string[]>,
  ): Promise<ResourceResult> {
    const rawAddr = variables.addr;
    const addr = Array.isArray(rawAddr) ? rawAddr[0] : rawAddr;
    if (typeof addr !== "string" || !ADDR_RE.test(addr)) {
      throw new ResourceReadError(
        `validation_failure: addr must match PJ.\\d+.\\d+.\\d+; got ${JSON.stringify(addr)}`,
      );
    }
    const result = await ctx.client.get<unknown>(
      `/memory/${encodeURIComponent(addr)}`,
    );
    if (!result.ok) {
      throw new ResourceReadError(
        `${result.errorClass}: ${result.message} (${result.detail})`,
      );
    }
    return jsonResource(uri, result.body);
  },
};
