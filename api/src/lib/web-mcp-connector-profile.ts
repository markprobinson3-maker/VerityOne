import { getDeploymentProfile } from "./db-config";

function flagEnabled(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return null;
}

export function isWebMcpConnectorEnabled(): boolean {
  const override = flagEnabled(process.env.VERITY_WEB_MCP_CONNECTOR_ENABLED);
  if (override !== null) return override;
  if (process.env.NODE_ENV === "test") return true;
  return getDeploymentProfile() === "serverless";
}
