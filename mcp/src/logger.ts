/**
 * Structured stderr logger per docs/VO-MCP-SERVER-CONTRACT.md.
 *
 * stdin/stdout are reserved for MCP JSON-RPC traffic. All logs go to stderr,
 * one JSON object per line. Required fields: ts, level, event.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  tool?: string;
  ms?: number;
  /** Either an HTTP status code or a short outcome label ("ok" | "error"). */
  status?: number | string;
  error?: string;
  error_class?: string;
  request_id?: string;
  protocolVersion?: string;
  [key: string]: unknown;
}

/** Write one JSON-per-line event to stderr. */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  try {
    process.stderr.write(JSON.stringify(entry) + "\n");
  } catch {
    // last resort — never throw from the logger
    process.stderr.write(`{"ts":"${new Date().toISOString()}","level":"error","event":"log_write_failed"}\n`);
  }
}
