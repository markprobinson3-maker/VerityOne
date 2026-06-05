/**
 * Resource template: vo://memory/{addr}/audit
 *
 * Wraps `GET /memory/:addr/audit`. Audit snapshot for a known
 * memory: trust state, provenance, approval metadata, recent
 * events. Read-only — does not advance state.
 *
 * Discoverable via `resources/templates/list`. Same addr format
 * + error semantics as `vo://memory/{addr}`.
 */
import {
  jsonResource,
  ResourceReadError,
  type ResourceHandlerContext,
  type ResourceResult,
  type TemplateResourceDefinition,
} from "./types.js";

const ADDR_RE = /^PJ\.\d+\.\d+\.\d+$/;

export const memoryAuditResource: TemplateResourceDefinition = {
  kind: "template",
  name: "memory_audit",
  uriTemplate: "vo://memory/{addr}/audit",
  title: "Memory audit snapshot by addr",
  description:
    "Read-only audit snapshot of a tenant memory (trust state, provenance, promotion linkage, approval metadata, recent events). Wraps GET /memory/:addr/audit. Requires a concrete addr.",
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
      `/memory/${encodeURIComponent(addr)}/audit`,
    );
    if (!result.ok) {
      throw new ResourceReadError(
        `${result.errorClass}: ${result.message} (${result.detail})`,
      );
    }
    return jsonResource(uri, result.body);
  },
};
