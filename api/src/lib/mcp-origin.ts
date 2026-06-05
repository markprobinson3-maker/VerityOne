export const DEFAULT_MCP_ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://chatgpt.com",
  "https://verityone.app",
] as const;

export function mcpAllowedOrigins(): Set<string> {
  const raw = process.env.VERITY_MCP_ALLOWED_ORIGINS;
  const values = (raw && raw.trim().length > 0 ? raw : DEFAULT_MCP_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(values);
}
