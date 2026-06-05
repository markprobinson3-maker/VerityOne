/**
 * Tool: vo_public_context → GET /context?q=...&depth=... (anonymous)
 *
 * Rung-4 public-feed tool. The "what should I know about X from the
 * shared graph?" discovery primitive. Calls the LOCAL VO node at
 * 127.0.0.1:3100 with NO Authorization header so the access layer
 * resolves the request to anonymous scope and structurally restricts
 * results to the public graph.
 *
 * Per the binding contract (docs/VO-MCP-SERVER-CONTRACT.md → Rung 4 →
 * Tool: vo_public_context):
 *   - Result envelope carries top-level `authority: "public_overlay"`
 *   - The `sections` field is the raw /context response body
 *   - tenant_auth_failure is structurally impossible because no token
 *     is sent
 *
 * NOTE: the /context backend already returns `ok: true` and a rich set
 * of top-level fields (depth, query, node_count, confidence_grade,
 * coverage_honest, regrounding, applicable_schemas, layer_distribution,
 * sections, ontology, ms). All of these pass through verbatim. The MCP
 * server only adds `authority: "public_overlay"` at the top — the one
 * place rung 4 enriches the response.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe("Task or question to ground in the public knowledge graph."),
  depth: z
    .enum(["shallow", "deep"])
    .optional()
    .describe("Depth of context retrieval. Defaults to backend default."),
};

interface ContextBackendBody {
  ok?: boolean;
  query?: string;
  sections?: unknown;
  [key: string]: unknown;
}

export const publicContextTool: ToolDefinition<typeof inputShape> = {
  name: "vo_public_context",
  description:
    "Get task-relevant PUBLIC knowledge graph context for a natural-language goal. " +
      "Calls /context anonymously (no tenant token), so results are strictly public-overlay — NOT tenant-private memories or decisions. " +
      "For tenant-private context (decisions, preferences, prior corrections), use vo_pretask_ground or vo_memory_recall_routed instead. " +
      "When surfacing results, label as 'from the public knowledge graph', never as 'from your memory'.",
  inputShape,
  async handler(client, args) {
    const params = new URLSearchParams();
    params.set("q", String(args.query));
    if (typeof args.depth === "string") params.set("depth", args.depth);

    const result = await client.getAnonymous<ContextBackendBody>(`/context?${params.toString()}`);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }

    const body = result.body || {};
    // Backend already returns `ok: true` plus rich fields. We pass them
    // through verbatim and add ONLY `authority: "public_overlay"`. The
    // explicit `ok: true` at the top guards against the rare case where
    // the backend body is missing it.
    return okEnvelope({
      ok: true,
      authority: "public_overlay",
      ...body,
    });
  },
};
