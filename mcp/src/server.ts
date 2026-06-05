/**
 * vo-mcp stdio server entrypoint.
 *
 * This module is what MCP clients spawn as a child via absolute path:
 *   command: "/abs/path/to/node"
 *   args:    ["/abs/path/to/~/.vo/mcp/dist/server.js"]
 *
 * It is also what `vo-mcp doctor` spawns, and what `vo-mcp serve` runs when
 * invoked by hand. It MUST NOT print anything to stdout except JSON-RPC
 * protocol traffic — the MCP SDK handles that.
 *
 * Thin adapter rules (binding per docs/VO-MCP-SERVER-CONTRACT.md):
 *   - no ranking, routing, validation, or storage logic
 *   - no fallback to any public endpoint
 *   - every failure maps to exactly one ErrorClass value
 *   - all logs go to stderr as one-JSON-per-line
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { buildErrorEnvelope } from "./errors.js";
import { log } from "./logger.js";
import { PROMPTS, registerPrompts } from "./prompts/index.js";
import {
  DERIVED_STATIC_URIS,
  DERIVED_TEMPLATE_URIS,
  registerResources,
} from "./resources/index.js";
import { TOOLS } from "./tools/index.js";
import type { ToolResult } from "./tools/types.js";
import { VoClient } from "./vo-client.js";

/** vo-mcp package version — surfaced via the `vo://server/status`
 *  resource. Keeping it as a compile-time constant avoids an fs
 *  read on every module load; a drift test can pin it equal to
 *  `mcp/package.json#version` if needed. */
export const VO_MCP_VERSION = "0.1.0";
const TOOL_EXCEPTION_LOG_MAX_CHARS = 400;
const TOOL_EXCEPTION_ENVELOPE_DETAIL = "handler exception";

export async function runServer(): Promise<void> {
  let client: VoClient;
  try {
    client = new VoClient(loadConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      log("error", "config_error", { reason: e.reason, error: e.message });
    } else {
      log("error", "fatal", { error: (e as Error).message });
    }
    process.exit(1);
  }

  log("info", "init", {
    base_url: client.baseUrl,
    auth_source: client.source,
    tools: TOOLS.length,
    static_resources: DERIVED_STATIC_URIS.length,
    resource_templates: DERIVED_TEMPLATE_URIS.length,
    prompts: PROMPTS.length,
    protocolVersion: "2024-11-05",
  });

  const server = new McpServer({
    name: "vo-mcp",
    version: VO_MCP_VERSION,
  });

  // Register each tool as a thin wrapper around its handler. The SDK handles
  // JSON Schema generation from the Zod shapes, the content block envelope,
  // and the JSON-RPC framing. We add structured timing and error logging.
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: (tool.inputSchema ?? tool.inputShape) as any,
      },
      async (args: unknown): Promise<ToolResult> => {
        const started = Date.now();
        try {
          const validationError = tool.validateArgs?.((args ?? {}) as Record<string, unknown>);
          const result = validationError ?? await tool.handler(client, (args ?? {}) as Record<string, unknown>);
          const ms = Date.now() - started;
          // On error envelope, extract the error_class for structured logging.
          let errorClass: string | undefined;
          if (result.isError && result.content[0]?.text) {
            try {
              const parsed = JSON.parse(result.content[0].text) as { error_class?: string };
              errorClass = parsed.error_class;
            } catch {
              /* ignore */
            }
          }
          log(result.isError ? "warn" : "info", "tool_call", {
            tool: tool.name,
            ms,
            status: result.isError ? "error" : "ok",
            ...(errorClass ? { error_class: errorClass } : {}),
          });
          // Special log for local_unreachable per contract.
          if (errorClass === "local_vo_unreachable") {
            log("error", "local_unreachable", { tool: tool.name, base_url: client.baseUrl });
          }
          return result;
        } catch (e) {
          const ms = Date.now() - started;
          const message = toolExceptionLogMessage(e);
          log("error", "tool_call", {
            tool: tool.name,
            ms,
            status: "error",
            error_class: "upstream_error",
            error: message,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  buildErrorEnvelope(
                    "upstream_error",
                    "unexpected tool handler failure",
                    TOOL_EXCEPTION_ENVELOPE_DETAIL,
                  ),
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  registerResources(server, {
    client,
    status: {
      packageVersion: VO_MCP_VERSION,
      baseUrl: client.baseUrl,
      authSource: client.source,
      counts: {
        tools: TOOLS.length,
        static_resources: DERIVED_STATIC_URIS.length,
        resource_templates: DERIVED_TEMPLATE_URIS.length,
        prompts: PROMPTS.length,
      },
    },
  });
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle clean shutdown so stderr gets one final event and orphaned pipes
  // do not linger.
  const shutdown = (signal: string) => {
    log("info", "shutdown", { signal });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Top-level await when run directly as `node dist/server.js`.
// When imported from cli.ts `serve`, the caller invokes runServer() explicitly.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runServer().catch((e) => {
    log("error", "fatal", { error: (e as Error).message, stack: (e as Error).stack });
    process.exit(1);
  });
}

export function toolExceptionLogMessage(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err);
  const withoutControls = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  let out = "";
  let count = 0;
  for (const ch of withoutControls.replace(/\s+/g, " ").trim()) {
    if (count >= TOOL_EXCEPTION_LOG_MAX_CHARS) break;
    out += ch;
    count += 1;
  }
  return out || "unknown handler exception";
}
