/**
 * MCP vault-root adapter.
 *
 * Delegates path precedence and tenant-marker readiness to the shared
 * R7 package, then maps non-ready states into the MCP validation_failure
 * envelope. This file stays isolated from api/src and CLI internals.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectVaultRoot } from "@verity-one/vault-root";
import { buildErrorEnvelope, type VoErrorEnvelope } from "./errors.js";

const CONFIG_PATH = path.join(os.homedir(), ".vo", "config.json");

export interface VaultRootOk {
  ok: true;
  vaultRoot: string;
  tenantId: string | null;
  voUrl: string | null;
}

export interface VaultRootErr {
  ok: false;
  envelope: VoErrorEnvelope;
}

export type VaultRootResult = VaultRootOk | VaultRootErr;

function readConfigFile(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readTenantIdFromConfigFile(): string | null {
  const parsed = readConfigFile();
  const value = parsed.tenant_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Resolve a vault root for MCP tools and return MCP-shaped errors. */
export function resolveVaultRoot(argVaultRoot?: string): VaultRootResult {
  const tenantId = readTenantIdFromConfigFile();
  const inspection = inspectVaultRoot({
    tenantId,
    explicitRoot: argVaultRoot,
    env: process.env,
    configPath: CONFIG_PATH,
    vaultEnabled: true,
  });

  if (inspection.status === "no_tenant") {
    return {
      ok: false,
      envelope: buildErrorEnvelope(
        "validation_failure",
        "tenant_id not configured",
        "add tenant_id to ~/.vo/config.json before using vault tools",
      ),
    };
  }

  if (!inspection.ok) {
    return {
      ok: false,
      envelope: buildErrorEnvelope(
        "validation_failure",
        inspection.status,
        inspection.error || `vault root is not ready: ${inspection.status}`,
      ),
    };
  }

  return {
    ok: true,
    vaultRoot: path.resolve(inspection.root),
    tenantId: inspection.vault_tenant_id,
    voUrl: typeof inspection.marker?.vo_url === "string" ? inspection.marker.vo_url : null,
  };
}
