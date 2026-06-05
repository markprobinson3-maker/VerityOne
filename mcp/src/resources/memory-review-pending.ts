/**
 * Resource: vo://memory/review/pending
 *
 * Wraps `GET /memory/review?limit=20`. Returns the pending
 * agent_inferred review queue as JSON. Read-only; never mutates.
 *
 * Error handling — explicit to keep the interop matrix honest:
 *   - `local_vo_unreachable` → ResourceReadError (not route-unavailable)
 *     The operator's local VO is down; proof runner classifies as fail.
 *   - `not_found` + body message/error "memory not found" →
 *     ResourceReadError with routeUnavailable=true. This is the
 *     signature the `/memory/:addr` catch-all produces when
 *     `/memory/review` is not mounted on an older running API.
 *     Proof runner classifies as `unproven` (same semantics as the
 *     `vo_memory_review` tool's stale-API branch).
 *   - any other failure → ResourceReadError (non-route-unavailable).
 *     Proof classifies as fail.
 *
 * Under no circumstance does this handler return partial or
 * silently-blank data. Either JSON with `ok: true` flows through,
 * or the handler throws.
 */
import {
  jsonResource,
  ResourceReadError,
  type ResourceHandlerContext,
  type ResourceResult,
  type StaticResourceDefinition,
} from "./types.js";

export const memoryReviewPendingResource: StaticResourceDefinition = {
  kind: "static",
  name: "memory_review_pending",
  uri: "vo://memory/review/pending",
  title: "Memory review queue (pending)",
  description:
    "Read-only JSON list of pending agent_inferred tenant memories awaiting human review. Wraps GET /memory/review?limit=20 on the local VO. Does not promote or approve memories — read-only surface.",
  mimeType: "application/json",
  async handler(
    ctx: ResourceHandlerContext,
    uri: URL,
  ): Promise<ResourceResult> {
    const result = await ctx.client.get<unknown>("/memory/review?limit=20");
    if (!result.ok) {
      const bodyMessage = result.body && typeof result.body === "object"
        ? String(
          (result.body as { error?: unknown; message?: unknown }).error ??
            (result.body as { error?: unknown; message?: unknown }).message ??
            "",
        )
        : "";
      const routeUnavailable =
        result.errorClass === "not_found" &&
        /memory not found/i.test(
          bodyMessage || result.message || result.detail || "",
        );
      throw new ResourceReadError(
        routeUnavailable
          ? `route_unavailable: /memory/review is not mounted on the running VO (got ${result.errorClass}: ${result.message}). This resource needs an API restart against current code to become available.`
          : `${result.errorClass}: ${result.message} (${result.detail})`,
        routeUnavailable,
      );
    }
    return jsonResource(uri, result.body);
  },
};
