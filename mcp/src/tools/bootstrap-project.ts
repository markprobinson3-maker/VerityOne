/**
 * Tool: vo_bootstrap_project → POST /bootstrap/project
 *
 * Thin passthrough. The raw backend payload becomes the content block. No
 * reshaping. Authoritative shape: api/src/routes/bootstrap.ts.
 */

import { z } from "zod";
import { buildErrorEnvelope } from "../errors.js";
import { errorEnvelope, okEnvelope, type ToolDefinition } from "./types.js";

const inputShape = {
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to the tenant's current workspace. Defaults to the MCP server's own cwd."),
  goal: z
    .string()
    .max(2000)
    .optional()
    .describe("Freeform description of the agent's task. Guides project inference and recall."),
  workspace_name: z
    .string()
    .optional()
    .describe("Optional workspace label (monorepo subproject name, etc)."),
  repo_slug: z
    .string()
    .optional()
    .describe("Optional repository slug for project inference."),
  explicit_project_addr: z
    .string()
    .regex(/^PJ\.\d+\.\d+\.\d+$/)
    .optional()
    .describe("Optional override: bypass inference by naming the project addr directly."),
};

export const bootstrapProjectTool: ToolDefinition<typeof inputShape> = {
  name: "vo_bootstrap_project",
  description:
    "Bootstrap the current tenant workspace. Returns inferred project, bootstrap posture, workspace-routing safety flag, and project/tenant memory. Call this first at session start.",
  inputShape,
  async handler(client, args) {
    const body: Record<string, unknown> = {
      cwd: typeof args.cwd === "string" ? args.cwd : process.cwd(),
      goal: typeof args.goal === "string" ? args.goal : "mcp bootstrap",
    };
    if (typeof args.workspace_name === "string") body.workspace_name = args.workspace_name;
    if (typeof args.repo_slug === "string") body.repo_slug = args.repo_slug;
    if (typeof args.explicit_project_addr === "string") {
      body.explicit_project_addr = args.explicit_project_addr;
    }

    const result = await client.post<unknown>("/bootstrap/project", body);
    if (!result.ok) {
      return errorEnvelope(buildErrorEnvelope(result.errorClass, result.message, result.detail));
    }
    return okEnvelope(result.body);
  },
};
