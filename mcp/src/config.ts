/**
 * Config and auth resolution for vo-mcp.
 *
 * Binding resolution order per docs/VO-MCP-SERVER-CONTRACT.md:
 *   1. ~/.vo/config.json — prefer agent_token, fall back to access_token
 *   2. VO_TOKEN environment variable
 *   3. structured error + non-zero exit
 *
 * localhost → 127.0.0.1 normalization per contract.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = path.join(os.homedir(), ".vo", "config.json");
const SECRETS_PATH = path.join(os.homedir(), ".vo", "secrets.env");
const DEFAULT_BASE_URL = "http://127.0.0.1:3100";

export interface VoConfig {
  baseUrl: string;
  token: string;
  tenantId: string | null;
  source: "config_file" | "env_fallback";
}

export class ConfigError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function loadSecretsEnv(): void {
  if (!fs.existsSync(SECRETS_PATH)) return;
  const content = fs.readFileSync(SECRETS_PATH, "utf-8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function normalizeBaseUrl(raw: string | undefined | null): string {
  const url = (raw || DEFAULT_BASE_URL).trim();
  // localhost → 127.0.0.1 per contract + api/src/lib/access.ts allowlist expectations
  return url.replace("://localhost", "://127.0.0.1");
}

/**
 * Resolve VO config per the binding contract.
 *
 * Token resolution order (strict):
 *   1. ~/.vo/config.json → agent_token or access_token
 *   2. VO_TOKEN env var (fallback only)
 *   3. ConfigError
 *
 * URL resolution:
 *   - VO_URL env var takes precedence when set. The install command writes
 *     VO_URL into client env blocks exactly so the server honors it.
 *   - otherwise fall back to ~/.vo/config.json#base_url
 *   - otherwise default http://127.0.0.1:3100
 *
 * localhost → 127.0.0.1 normalization is applied to whichever URL is chosen.
 */
export function loadConfig(): VoConfig {
  loadSecretsEnv();

  let configToken: string | null = null;
  let configBaseUrl: string | undefined;
  let configTenantId: string | null = null;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      configToken =
        (typeof parsed.agent_token === "string" && parsed.agent_token) ||
        (typeof parsed.access_token === "string" && parsed.access_token) ||
        null;
      if (typeof parsed.base_url === "string") configBaseUrl = parsed.base_url;
      if (typeof parsed.tenant_id === "string") configTenantId = parsed.tenant_id;
    } catch (e) {
      throw new ConfigError(
        "config_parse_error",
        `failed to parse ${CONFIG_PATH}: ${(e as Error).message}`,
      );
    }
  }

  // VO_URL env always wins when set. This is what `vo-mcp install` writes.
  const envUrl = (process.env.VO_URL || "").trim();
  const baseUrl = normalizeBaseUrl(envUrl || configBaseUrl || undefined);

  // Token: config first, then VO_TOKEN fallback.
  if (configToken) {
    return { baseUrl, token: configToken, tenantId: configTenantId, source: "config_file" };
  }

  const envToken = (process.env.VO_TOKEN || "").trim();
  if (envToken) {
    return { baseUrl, token: envToken, tenantId: null, source: "env_fallback" };
  }

  throw new ConfigError(
    "no_token",
    `no tenant token: neither ${CONFIG_PATH} nor VO_TOKEN provided a usable token`,
  );
}
