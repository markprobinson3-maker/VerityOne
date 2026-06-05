/**
 * Tool: vo_pretask_ground — composed convenience tool
 *
 * Ground an agent session in one call. This is a LITERAL 2-call composition
 * per the binding contract:
 *
 *   1. POST /bootstrap/project
 *   2. POST /memory/recall/routed
 *
 * Composition rules (binding, from docs/VO-MCP-SERVER-CONTRACT.md):
 *   - MUST be implemented as literal sequential calls
 *   - MUST NOT embed any classification, ranking, routing, or recall logic
 *   - always calls /memory/recall/routed (never plain /memory/recall)
 *   - threads project_addr into recall ONLY when safe_for_workspace_routing === true
 *   - no partial-success mode (fail whichever call fails first)
 *   - no caching
 *
 * Reference composition pattern: agent-lab/scripts/vo-cli.ts#pretaskGround.
 * This tool must match that step order exactly; it is the MCP analogue of
 * `vo pretask-ground` and exists solely so agents get both grounding steps
 * in one round trip.
 *
 * The top-level `bootstrap_context` field in the result is a verbatim copy
 * of `bootstrap.bootstrap_context` from the backend response. MCP does not
 * synthesize, rewrite, or refresh it.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const pretaskInputShape = {
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to the tenant's current workspace. Defaults to the MCP server's own cwd."),
  goal: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Freeform description of the agent's task. Used as the bootstrap goal and as the recall query fallback.",
    ),
  query: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Optional recall query override. If omitted, derived from goal, or from the inferred project label — matches vo pretask-ground CLI behavior.",
    ),
  workspace_name: z.string().optional(),
  repo_slug: z.string().optional(),
  explicit_project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional(),
};

interface BootstrapResponse {
  ok: boolean;
  inferred_project?: {
    addr?: string;
    label?: string;
    confidence?: string;
    source?: string;
  } | null;
  safe_for_workspace_routing?: boolean;
  bootstrap_context?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export const pretaskGroundTool: ToolDefinition<typeof pretaskInputShape> = {
  name: "vo_pretask_ground",
  description:
    "Ground an agent session in one call: runs vo_bootstrap_project then vo_memory_recall_routed and returns both results plus a ready-to-use bootstrap_context. Use at session start to capture a bootstrap_context the agent can thread through subsequent vo_memory_write calls. " +
      "This is a LITERAL 2-call composition — it does not embed its own ranking, routing, or recall logic.",
  inputShape: pretaskInputShape,
  async handler(client, args) {
    const started = Date.now();

    // Step 1: bootstrap
    const bootstrapBody: Record<string, unknown> = {
      cwd: typeof args.cwd === "string" ? args.cwd : process.cwd(),
      goal: typeof args.goal === "string" ? args.goal : "pre-task grounding",
    };
    if (typeof args.workspace_name === "string") bootstrapBody.workspace_name = args.workspace_name;
    if (typeof args.repo_slug === "string") bootstrapBody.repo_slug = args.repo_slug;
    if (typeof args.explicit_project_addr === "string") {
      bootstrapBody.explicit_project_addr = args.explicit_project_addr;
    }

    const bsResult = await client.post<BootstrapResponse>("/bootstrap/project", bootstrapBody);
    if (!bsResult.ok) {
      // First sub-call failed — return its error envelope unchanged.
      return errorEnvelope(
        buildErrorEnvelope(bsResult.errorClass, bsResult.message, bsResult.detail),
      );
    }

    const bootstrap = bsResult.body;
    const inferred = bootstrap.inferred_project ?? null;
    const safeForRouting = bootstrap.safe_for_workspace_routing === true;

    // Step 2: routed recall — thread project_addr only when workspace routing is safe.
    // Query fallback matches vo pretask-ground CLI (agent-lab/scripts/vo-cli.ts) exactly.
    const recallQuery =
      (typeof args.query === "string" && args.query) ||
      (typeof args.goal === "string" && args.goal) ||
      `context and prior decisions for ${inferred?.label || "current workspace"}`;

    const recallBody: Record<string, unknown> = { query: recallQuery };
    if (safeForRouting && typeof inferred?.addr === "string") {
      recallBody.project_addr = inferred.addr;
    }

    const rcResult = await client.post<unknown>("/memory/recall/routed", recallBody);
    if (!rcResult.ok) {
      // Second sub-call failed after the first succeeded. Same error class,
      // but prefix the detail so the agent can tell which call actually
      // failed without consuming a new error class.
      return errorEnvelope(
        buildErrorEnvelope(
          rcResult.errorClass,
          rcResult.message,
          `recall after successful bootstrap: ${rcResult.detail}`,
        ),
      );
    }

    // Compose the output. bootstrap_context is a VERBATIM lift from the
    // bootstrap response — MCP does not construct a new object with
    // different field ordering, different timestamps, or any rewrite.
    return okEnvelope({
      ok: true,
      bootstrap,
      recall: rcResult.body,
      bootstrap_context: bootstrap.bootstrap_context ?? null,
      safe_for_workspace_routing: safeForRouting,
      ms: Date.now() - started,
    });
  },
};
