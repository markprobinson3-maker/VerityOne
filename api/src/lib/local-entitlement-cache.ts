import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfigPath } from "./runtime-profile";
import {
  EFFECTIVE_CAPABILITIES,
  type EffectiveCapability,
  type EffectiveEntitlement,
  type EntitlementSource,
  type EffectiveEntitlementTier,
} from "./subscription-entitlements";
import type { SecurityMode } from "./tenant-security";

const CACHE_TTL_MS = 10 * 60 * 1000;
const VO_PLUS_GRACE_MS = 48 * 60 * 60 * 1000;

export interface LocalEntitlementCache {
  tenant_id: string | null;
  node_id: string | null;
  account_id: string | null;
  source: EntitlementSource;
  tier: EffectiveEntitlementTier;
  capabilities: EffectiveCapability[];
  vo_plus_active: boolean;
  manage_url: string;
  fetched_at: string;
  expires_at: string;
  grace_expires_at: string | null;
  hosted_base_url: string | null;
  tenant_security_tier: SecurityMode;
}

export interface PausedEntitlementRow {
  seq: number;
  item_type: string;
  op: string;
  item_key: string;
  addr: string | null;
  from_addr: string | null;
  to_addr: string | null;
  edge_type: string | null;
  governance_key: string | null;
  space_id: string | null;
  project_addr: string | null;
  payload_json?: Record<string, unknown> | null;
  reason: "vo_plus_required" | "entitlement_grace_expired" | "entitlement_unknown";
  recorded_at: string;
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

function cachePath(): string {
  return path.join(configDir(), "hosted-entitlement-cache.json");
}

function replayPath(): string {
  return path.join(configDir(), "entitlement-paused-replay.json");
}

function atomicWrite0600(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

function validCapabilities(value: unknown): EffectiveCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is EffectiveCapability =>
    typeof v === "string" && (EFFECTIVE_CAPABILITIES as readonly string[]).includes(v));
}

function validSource(value: unknown): EntitlementSource {
  if (value === "admin_override" || value === "stripe_subscription" || value === "manual_vo_plus") {
    return value;
  }
  return "free_google";
}

function validTier(value: unknown): EffectiveEntitlementTier {
  if (
    value === "plus" ||
    value === "vo_plus_admin" ||
    value === "vo_plus_beta" ||
    value === "vo_plus_internal"
  ) {
    return value;
  }
  return "free";
}

function validSecurityMode(value: unknown): SecurityMode {
  if (value === "customer_managed" || value === "content_opaque") return value;
  return "service_managed";
}

export function readLocalEntitlementCache(input?: {
  tenantId?: string | null;
  nodeId?: string | null;
  hostedBaseUrl?: string | null;
}): LocalEntitlementCache | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  } catch {
    return null;
  }
  const cache: LocalEntitlementCache = {
    tenant_id: typeof raw?.tenant_id === "string" ? raw.tenant_id : null,
    node_id: typeof raw?.node_id === "string" ? raw.node_id : null,
    account_id: typeof raw?.account_id === "string" ? raw.account_id : null,
    source: validSource(raw?.source),
    tier: validTier(raw?.tier),
    capabilities: validCapabilities(raw?.capabilities),
    vo_plus_active: raw?.vo_plus_active === true,
    manage_url: typeof raw?.manage_url === "string" ? raw.manage_url : "https://verityone.app/my/account#vo-plus",
    fetched_at: typeof raw?.fetched_at === "string" ? raw.fetched_at : "",
    expires_at: typeof raw?.expires_at === "string" ? raw.expires_at : "",
    grace_expires_at: typeof raw?.grace_expires_at === "string" ? raw.grace_expires_at : null,
    hosted_base_url: typeof raw?.hosted_base_url === "string" ? raw.hosted_base_url : null,
    tenant_security_tier: validSecurityMode(raw?.tenant_security_tier),
  };
  if (input?.tenantId && cache.tenant_id && cache.tenant_id !== input.tenantId) return null;
  if (input?.nodeId && cache.node_id && cache.node_id !== input.nodeId) return null;
  if (input?.hostedBaseUrl && cache.hosted_base_url && cache.hosted_base_url !== input.hostedBaseUrl) return null;
  return cache;
}

export function writeLocalEntitlementCache(input: {
  tenantId: string | null;
  nodeId: string | null;
  accountId: string | null;
  hostedBaseUrl: string | null;
  entitlement: EffectiveEntitlement;
  tenantSecurityTier?: SecurityMode | null;
  now?: Date;
}): LocalEntitlementCache {
  const now = input.now ?? new Date();
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString();
  const graceExpiresAt = input.entitlement.vo_plus_active
    ? new Date(now.getTime() + VO_PLUS_GRACE_MS).toISOString()
    : null;
  const cache: LocalEntitlementCache = {
    tenant_id: input.tenantId,
    node_id: input.nodeId,
    account_id: input.accountId,
    source: input.entitlement.source,
    tier: input.entitlement.tier,
    capabilities: input.entitlement.capabilities,
    vo_plus_active: input.entitlement.vo_plus_active,
    manage_url: input.entitlement.manage_url,
    fetched_at: fetchedAt,
    expires_at: expiresAt,
    grace_expires_at: graceExpiresAt,
    hosted_base_url: input.hostedBaseUrl,
    tenant_security_tier: validSecurityMode(input.tenantSecurityTier),
  };
  const existing = readLocalEntitlementCache();
  if (JSON.stringify(existing) !== JSON.stringify(cache)) {
    atomicWrite0600(cachePath(), JSON.stringify(cache, null, 2));
  }
  return cache;
}

export function clearLocalEntitlementCache(): void {
  try { fs.unlinkSync(cachePath()); } catch { /* already gone */ }
  clearEntitlementPausedReplay();
}

export function classifyEntitlementHealth(
  cache: LocalEntitlementCache | null,
  now = new Date(),
): "available" | "grace_active" | "paused_vo_plus_required" | "hosted_unreachable" | "unknown" {
  if (!cache) return "unknown";
  const freshTs = cache.expires_at ? new Date(cache.expires_at).getTime() : NaN;
  if (cache.vo_plus_active && Number.isFinite(freshTs) && freshTs > now.getTime()) {
    return "available";
  }
  const graceTs = cache.grace_expires_at ? new Date(cache.grace_expires_at).getTime() : NaN;
  if (Number.isFinite(graceTs) && graceTs > now.getTime()) return "grace_active";
  return "paused_vo_plus_required";
}

export function isHeavySyncAllowedFromCache(cache: LocalEntitlementCache | null, now = new Date()): boolean {
  if (!cache) return false;
  const freshTs = cache.expires_at ? new Date(cache.expires_at).getTime() : NaN;
  if (cache.vo_plus_active && Number.isFinite(freshTs) && freshTs > now.getTime()) return true;
  const graceTs = cache.grace_expires_at ? new Date(cache.grace_expires_at).getTime() : NaN;
  return Number.isFinite(graceTs) && graceTs > now.getTime();
}

export async function refreshLocalEntitlementCache(input: {
  hostedBaseUrl: string;
  syncToken: string;
  tenantId: string;
  nodeId: string | null;
  timeoutMs?: number;
}): Promise<{ ok: true; cache: LocalEntitlementCache } | { ok: false; code: string; message: string; cache: LocalEntitlementCache | null }> {
  try {
    const res = await fetch(`${input.hostedBaseUrl.replace(/\/$/, "")}/account/entitlement?tenant_id=${encodeURIComponent(input.tenantId)}`, {
      headers: { Authorization: `Bearer ${input.syncToken}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
    });
    const payload = await res.json().catch(() => null) as any;
    if (!res.ok || !payload?.ok || !payload.entitlement) {
      return {
        ok: false,
        code: payload?.code || payload?.error || `http_${res.status}`,
        message: "Hosted entitlement is unavailable.",
        cache: readLocalEntitlementCache({ tenantId: input.tenantId, nodeId: input.nodeId, hostedBaseUrl: input.hostedBaseUrl }),
      };
    }
    const cache = writeLocalEntitlementCache({
      tenantId: payload.tenant_id ?? input.tenantId,
      nodeId: input.nodeId,
      accountId: payload.account_id ?? null,
      hostedBaseUrl: input.hostedBaseUrl,
      entitlement: payload.entitlement,
      tenantSecurityTier: payload.tenant_security_tier,
    });
    return { ok: true, cache };
  } catch {
    return {
      ok: false,
      code: "hosted_unreachable",
      message: "Hosted entitlement is unreachable.",
      cache: readLocalEntitlementCache({ tenantId: input.tenantId, nodeId: input.nodeId, hostedBaseUrl: input.hostedBaseUrl }),
    };
  }
}

export function readEntitlementPausedReplay(): PausedEntitlementRow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(replayPath(), "utf8"));
    if (!Array.isArray(raw?.rows)) {
      clearEntitlementPausedReplay();
      return [];
    }
    const filtered = raw.rows.filter((r: any) => typeof r?.seq === "number" && typeof r?.item_key === "string");
    if (filtered.length !== raw.rows.length) writeEntitlementPausedReplay(filtered);
    return filtered;
  } catch {
    clearEntitlementPausedReplay();
    return [];
  }
}

export function writeEntitlementPausedReplay(rows: PausedEntitlementRow[]): void {
  atomicWrite0600(replayPath(), JSON.stringify({ rows }, null, 2));
}

export function appendEntitlementPausedReplay(rows: PausedEntitlementRow[]): void {
  if (rows.length === 0) return;
  const existing = readEntitlementPausedReplay();
  const byKey = new Map<string, PausedEntitlementRow>();
  for (const row of existing) byKey.set(`${row.seq}:${row.item_key}`, row);
  for (const row of rows) byKey.set(`${row.seq}:${row.item_key}`, row);
  writeEntitlementPausedReplay([...byKey.values()].sort((a, b) => a.seq - b.seq));
}

export function clearEntitlementPausedReplay(): void {
  try { fs.unlinkSync(replayPath()); } catch { /* already gone */ }
}
