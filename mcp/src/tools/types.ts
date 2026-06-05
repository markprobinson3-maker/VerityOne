/**
 * Shared types for the rung-1 read-only tool modules.
 *
 * Each tool module exports a ToolDefinition. tools/index.ts aggregates them
 * into a TOOLS array consumed by server.ts.
 */

import type { ZodRawShape, ZodTypeAny } from "zod";
import type { VoClient } from "../vo-client.js";

export interface ToolContentText {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContentText[];
  isError: boolean;
  // Index signature required so the MCP SDK's generic tool-result constraint
  // accepts this shape without forcing us to import its internal types.
  [key: string]: unknown;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  /** Wire name registered with the MCP SDK. Must be snake_case per contract. */
  name: string;
  /** Human-readable description shown to agents in tools/list. */
  description: string;
  /** Zod raw shape used by most tools. SDK wraps it into the inputSchema. */
  inputShape: Shape;
  /** Optional object-level schema for tools that need cross-field validation. */
  inputSchema?: ZodTypeAny;
  /** Optional post-SDK validation hook for structured MCP error envelopes. */
  validateArgs?: (args: Record<string, unknown>) => ToolResult | null;
  /** Thin handler: validated args in, ToolResult out. */
  handler(client: VoClient, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Convenience: JSON-stringify a payload into the standard single-content-block envelope. */
export function okEnvelope(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

/** Convenience: build the error envelope shape per the contract. */
export function errorEnvelope(body: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: true,
  };
}
