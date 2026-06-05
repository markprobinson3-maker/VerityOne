/**
 * Tool: vo_public_search → GET /search?q=... (anonymous)
 *
 * Rung-4 public-feed tool. Calls the LOCAL VO node at 127.0.0.1:3100 with
 * NO Authorization header so the access layer resolves the request to
 * `scope: "anonymous"` with `spaceIds: [GLOBAL_SPACE_ID]`. Tenant-private
 * memories are excluded by space id at the SQL layer — no MCP-side
 * filtering required.
 *
 * Per the binding contract (docs/VO-MCP-SERVER-CONTRACT.md → Rung 4 →
 * Tool: vo_public_search):
 *   - Result envelope carries top-level `authority: "public_overlay"`
 *   - The `nodes` field exposes the array of public-graph results
 *   - Backend body is preserved verbatim (rich fields like
 *     prompt_distillation, mode, model, ontology, skills pass through)
 *   - tenant_auth_failure is structurally impossible because no token
 *     is sent
 *
 * NOTE on field naming: the live /search backend names its results array
 * `results`. The rung-4 contract example shows it as `nodes`. To honor
 * both literally without dropping any backend information, this tool
 * passes the entire backend body through verbatim (so `results` is
 * still present) AND aliases it under `nodes` (so the contract field
 * name resolves to data). This is the one tiny contract clarification
 * the implementation forces.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Keyword query against the public knowledge graph."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of nodes to return (default backend-determined)."),
};

interface SearchBackendBody {
  query?: string;
  results?: unknown[];
  count?: number;
  [key: string]: unknown;
}

export const publicSearchTool: ToolDefinition<typeof inputShape> = {
  name: "vo_public_search",
  description:
    "Keyword search against the PUBLIC knowledge graph on the local VO node. " +
      "Calls /search anonymously (no tenant token), so results are strictly public-overlay — NOT tenant-private memories. " +
      "When surfacing results to the user, label as 'from the public knowledge graph', never as 'from your memory'. " +
      "To save a fact discovered here into tenant memory, call vo_memory_write explicitly with your own payload.",
  inputShape,
  async handler(client, args) {
    const params = new URLSearchParams();
    params.set("q", String(args.query));
    if (typeof args.limit === "number") params.set("limit", String(args.limit));

    const result = await client.getAnonymous<SearchBackendBody>(`/search?${params.toString()}`);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }

    const body = result.body || {};
    // Preserve every backend field verbatim, then add the rung-4 envelope
    // labels. `nodes` is aliased from `results` so the contract field name
    // resolves to data without dropping the backend's actual `results` field.
    return okEnvelope({
      ok: true,
      authority: "public_overlay",
      ...body,
      nodes: Array.isArray(body.results) ? body.results : [],
    });
  },
};
