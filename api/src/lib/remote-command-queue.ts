/**
 * Remote command queue primitives.
 *
 * Core operations on the remote_commands table:
 * - queue: insert a new command (with idempotency + key encryption)
 * - listPending: fetch queued commands for a tenant
 * - claim: atomically claim a command for processing
 * - resolve: mark a command as applied/rejected/failed
 * - listHistory: browse recent commands for a tenant
 *
 * Sensitive commands have their payload encrypted at rest using
 * AES-256-GCM with a key derived from a server-side secret. Decryption
 * happens on pull. Runtime scrub policy clears sensitive payloads after
 * terminal command transitions and hosted-maintenance expiry.
 */

import type postgres from "postgres";
import crypto from "node:crypto";
import {
  isAccountScopedCommand,
  isNodeTargetedCommand,
  type CommandCategory,
  type RemoteCommandOriginSessionType,
  type CommandStatus,
  type CommandType,
  type RemoteCommandRow,
} from "./remote-command-types";
import { isSensitiveIntent } from "./federation-intent-sensitivity";
import { REMOTE_COMMAND_SCRUB_PAIR_KEYS } from "./remote-command-payload-policy";

type SqlTag = ReturnType<typeof postgres>;

// R9: single source of truth for the cancel actor kind. Used both as
// `result.canceled_by` (provenance written into remote_commands.result)
// and as `auditMutation` `actorKind` for the cancel audit row, so the
// two surfaces cannot drift in casing or copy.
export const REMOTE_COMMAND_CANCEL_ACTOR = "tenant_session";

// ── Payload encryption for sensitive commands ────────────────────────
// Uses AES-256-GCM with a key derived from VERITY_QUEUE_SECRET. New
// envelopes carry a version so operators can rotate by setting
// VERITY_QUEUE_SECRET_VERSION plus VERITY_QUEUE_SECRET_V<version> values
// and keeping old versions available until queued rows expire.

interface QueueEncryptionKeyring {
  currentVersion: string;
  keys: Map<string, Buffer>;
}

let _encryptionKeyring: { fingerprint: string; keyring: QueueEncryptionKeyring | null } | null = null;

function queueSecretFingerprint(): string {
  const versioned = Object.keys(process.env)
    .filter((key) => /^VERITY_QUEUE_SECRET_V[0-9][0-9A-Za-z_.-]*$/.test(key))
    .sort()
    .map((key) => `${key}=${process.env[key] ?? ""}`)
    .join("\n");
  return [
    `current=${process.env.VERITY_QUEUE_SECRET_VERSION ?? ""}`,
    `legacy=${process.env.VERITY_QUEUE_SECRET ?? ""}`,
    versioned,
  ].join("\n");
}

function hashQueueSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function getEncryptionKeyring(): QueueEncryptionKeyring | null {
  const fingerprint = queueSecretFingerprint();
  if (_encryptionKeyring?.fingerprint === fingerprint) {
    return _encryptionKeyring.keyring;
  }

  const currentVersion = (process.env.VERITY_QUEUE_SECRET_VERSION || "1").trim() || "1";
  const keys = new Map<string, Buffer>();
  for (const [name, value] of Object.entries(process.env)) {
    const match = name.match(/^VERITY_QUEUE_SECRET_V([0-9][0-9A-Za-z_.-]*)$/);
    if (match && value) {
      keys.set(match[1], hashQueueSecret(value));
    }
  }
  const currentSecret = process.env.VERITY_QUEUE_SECRET;
  if (currentSecret) {
    keys.set(currentVersion, hashQueueSecret(currentSecret));
    if (currentVersion === "1") {
      keys.set("1", hashQueueSecret(currentSecret));
    }
  }

  const keyring = keys.size > 0 ? { currentVersion, keys } : null;
  _encryptionKeyring = { fingerprint, keyring };
  return keyring;
}

function encryptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const keyring = getEncryptionKeyring();
  const key = keyring?.keys.get(keyring.currentVersion);
  if (!keyring || !key) {
    throw new Error("VERITY_QUEUE_SECRET is required for provider-key commands. Set it in the environment.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _encrypted: true,
    v: keyring.currentVersion,
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptPayload(envelope: Record<string, unknown>): Record<string, unknown> {
  if (!envelope._encrypted) return envelope;
  const version = typeof envelope.v === "string" && envelope.v.trim()
    ? envelope.v.trim()
    : "1";
  const keyring = getEncryptionKeyring();
  const key = keyring?.keys.get(version);
  if (!key) {
    throw new Error(`VERITY_QUEUE_SECRET_V${version} is required to decrypt queued command payloads.`);
  }
  const iv = Buffer.from(envelope.iv as string, "base64");
  const data = Buffer.from(envelope.data as string, "base64");
  const tag = Buffer.from(envelope.tag as string, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

export function decryptSensitivePayload(
  category: string,
  commandType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return isSensitiveCommand(category, commandType)
    ? decryptPayload(payload)
    : payload;
}

function isSensitiveCommand(category: string, commandType: string): boolean {
  return isSensitiveIntent(category, commandType);
}

// ── Queue a new command ──────────────────────────────────────────────

export interface QueueCommandParams {
  tenantId: string;
  accountId: string;
  category: CommandCategory;
  commandType: CommandType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  targetNodeId?: string | null;
  origin?: QueueCommandOrigin;
}

export type QueueCommandOrigin =
  | {
      sessionType?: "hosted-browser-session";
      sessionId?: string | null;
      credentialId?: null;
      actorLabel?: string | null;
    }
  | {
      sessionType: "hosted-mcp-agent";
      sessionId: string;
      credentialId: string;
      actorLabel: string;
    };

interface NormalizedQueueOrigin {
  sessionType: RemoteCommandOriginSessionType;
  sessionId: string | null;
  credentialId: string | null;
  actorLabel: string | null;
}

export type QueueCommandResult =
  | { ok: true; row: RemoteCommandRow; inserted: boolean }
  | { ok: false; code: "idempotency_account_mismatch" | "idempotency_command_mismatch" | "idempotency_origin_mismatch" | "queue_full" };

// ── Opt-in write-intent queue depth cap ──────────────────────────────
//
// OFF by default: with no env opt-in, queueCommand behaves exactly as before
// (zero extra queries, no rejections). When VERITY_WRITE_INTENT_QUEUE_ENFORCE
// is enabled, a NEW intent is rejected with `queue_full` once the per-
// (tenant,account) LIVE (queued+claimed, unexpired) depth is at/over the cap,
// so a flooded or offline-node queue cannot grow without bound. Replays of an
// existing idempotency_key are never capped (the row already exists). The
// default cap matches the operator classifier's hard cap
// (hosted-connector-loadshedding.WRITE_INTENT_QUEUE_HARD_CAP) — kept in lockstep
// by a drift guard rather than a cross-bundle import (this module is in the
// serverless bundle; the loadshedding classifier is operator-only).
export const WRITE_INTENT_QUEUE_ENFORCE_CAP_DEFAULT = 1000;

export function isWriteIntentQueueEnforcementEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.VERITY_WRITE_INTENT_QUEUE_ENFORCE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function writeIntentQueueCap(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.VERITY_WRITE_INTENT_QUEUE_HARD_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : WRITE_INTENT_QUEUE_ENFORCE_CAP_DEFAULT;
}

export class RemoteCommandTargetValidationError extends Error {
  constructor(
    public readonly reason:
      | "target_node_id_required"
      | "target_node_id_mismatch"
      | "target_node_id_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "RemoteCommandTargetValidationError";
  }
}

export class RemoteCommandIdempotencyMismatchError extends Error {
  constructor(message = "Command idempotency key cannot be reused for this request.") {
    super(message);
    this.name = "RemoteCommandIdempotencyMismatchError";
  }
}

function validateTargetNodeId(params: QueueCommandParams): string | null {
  const targetNodeId = params.targetNodeId?.trim() || null;
  const nodeTargeted = isNodeTargetedCommand(params.category, params.commandType);
  if (nodeTargeted && !targetNodeId) {
    throw new RemoteCommandTargetValidationError(
      "target_node_id_required",
      "target_node_id is required for node-targeted commands.",
    );
  }
  if (params.category === "account_sync" && params.commandType === "drive_revoke") {
    const payloadNodeId = typeof params.payload.node_id === "string" ? params.payload.node_id.trim() : "";
    if (targetNodeId !== payloadNodeId) {
      throw new RemoteCommandTargetValidationError(
        "target_node_id_mismatch",
        "target_node_id must match payload.node_id for drive_revoke.",
      );
    }
  }
  if (!nodeTargeted && targetNodeId && isAccountScopedCommand(params.category, params.commandType)) {
    throw new RemoteCommandTargetValidationError(
      "target_node_id_not_allowed",
      "target_node_id is only valid for node-targeted commands.",
    );
  }
  return targetNodeId;
}

function normalizeQueueOrigin(origin: QueueCommandOrigin | undefined): NormalizedQueueOrigin {
  if (origin?.sessionType === "hosted-mcp-agent") {
    const sessionId = origin.sessionId.trim();
    const credentialId = origin.credentialId.trim();
    const actorLabel = origin.actorLabel.trim();
    if (!sessionId || !credentialId || !actorLabel) {
      throw new Error("hosted-mcp-agent origin requires sessionId, credentialId, and actorLabel.");
    }
    return {
      sessionType: "hosted-mcp-agent",
      sessionId,
      credentialId,
      actorLabel,
    };
  }
  return {
    sessionType: "hosted-browser-session",
    sessionId: origin?.sessionId?.trim() || null,
    credentialId: null,
    actorLabel: origin?.actorLabel?.trim() || null,
  };
}

function sameQueueOrigin(existing: RemoteCommandRow, incoming: NormalizedQueueOrigin): boolean {
  if (incoming.sessionType === "hosted-browser-session") {
    return existing.origin_session_type === "hosted-browser-session";
  }
  return (
    existing.origin_session_type === "hosted-mcp-agent" &&
    existing.origin_session_id === incoming.sessionId
  );
}

function projectRemoteCommandRow(row: any): RemoteCommandRow {
  return row as unknown as RemoteCommandRow;
}

function canonicalPayloadJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalPayloadJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalPayloadJson(entryValue)}`)
    .join(",")}}`;
}

function sameCommandPayload(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  return canonicalPayloadJson(existing) === canonicalPayloadJson(incoming);
}

function decryptRowPayload(row: RemoteCommandRow): RemoteCommandRow {
  return {
    ...row,
    payload: isSensitiveCommand(row.category, row.command_type)
      ? decryptPayload(row.payload)
      : row.payload,
  };
}

export async function queueCommand(
  sql: SqlTag,
  params: QueueCommandParams,
): Promise<QueueCommandResult> {
  const { tenantId, accountId, category, commandType, payload, idempotencyKey } = params;
  const targetNodeId = validateTargetNodeId(params);
  const origin = normalizeQueueOrigin(params.origin);

  // Opt-in depth cap (default OFF — see WRITE_INTENT_QUEUE_ENFORCE_CAP_DEFAULT).
  // Reject NEW intents once the per-(tenant,account) live depth is at/over the
  // cap. A replay of an existing idempotency_key is exempt (the row exists).
  if (isWriteIntentQueueEnforcementEnabled()) {
    const isExistingKey = idempotencyKey
      ? (await sql`
          SELECT 1 FROM remote_commands
          WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
          LIMIT 1
        `).length > 0
      : false;
    if (!isExistingKey) {
      const [depth] = await sql`
        SELECT COUNT(*)::int AS n
        FROM remote_commands
        WHERE tenant_id = ${tenantId}
          AND account_id = ${accountId}::uuid
          AND status IN ('queued', 'claimed')
          AND expires_at > now()
      `;
      if (Number(depth?.n ?? 0) >= writeIntentQueueCap()) {
        return { ok: false, code: "queue_full" };
      }
    }
  }

  // Encrypt sensitive payloads at rest
  const storedPayload = isSensitiveCommand(category, commandType)
    ? encryptPayload(payload)
    : payload;

  // Atomic idempotency: INSERT ... ON CONFLICT returns nothing if dup,
  // then we query the existing row. This avoids the select-then-insert race.
  if (idempotencyKey) {
    const inserted = await sql`
      INSERT INTO remote_commands (
        tenant_id, account_id, category, command_type, target_node_id, payload,
        idempotency_key, origin_session_type, origin_session_id,
        origin_credential_id, origin_actor_label
      )
      VALUES (
        ${tenantId}, ${accountId}, ${category}, ${commandType}, ${targetNodeId},
        ${sql.json(storedPayload as any)}, ${idempotencyKey},
        ${origin.sessionType}, ${origin.sessionId}, ${origin.credentialId},
        ${origin.actorLabel}
      )
      ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
        status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
        origin_session_id, origin_credential_id, origin_actor_label, created_at,
        updated_at, expires_at
    `;
    if (inserted.length > 0) {
      return { ok: true, row: decryptRowPayload(projectRemoteCommandRow(inserted[0])), inserted: true };
    }

    // Conflict — return existing row
    const [existing] = await sql`
      SELECT id, tenant_id, account_id, category, command_type, target_node_id, payload,
        status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
        origin_session_id, origin_credential_id, origin_actor_label, created_at,
        updated_at, expires_at
      FROM remote_commands
      WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
    `;
    if (!existing) {
      return { ok: false, code: "idempotency_command_mismatch" };
    }
    if (existing && String(existing.account_id) !== accountId) {
      return { ok: false, code: "idempotency_account_mismatch" };
    }
    const existingRow = projectRemoteCommandRow(existing);
    if (
      existing &&
      (
        String(existing.category) !== category ||
        String(existing.command_type) !== commandType ||
        (existing.target_node_id ?? null) !== (targetNodeId ?? null)
      )
    ) {
      return { ok: false, code: "idempotency_command_mismatch" };
    }
    if (!sameQueueOrigin(existingRow, origin)) {
      return { ok: false, code: "idempotency_origin_mismatch" };
    }
    const existingWithPayload = decryptRowPayload(existingRow);
    if (!sameCommandPayload(existingWithPayload.payload, payload)) {
      return { ok: false, code: "idempotency_command_mismatch" };
    }
    return { ok: true, row: existingWithPayload, inserted: false };
  }

  const [row] = await sql`
    INSERT INTO remote_commands (
      tenant_id, account_id, category, command_type, target_node_id, payload,
      idempotency_key, origin_session_type, origin_session_id,
      origin_credential_id, origin_actor_label
    )
    VALUES (
      ${tenantId}, ${accountId}, ${category}, ${commandType}, ${targetNodeId},
      ${sql.json(storedPayload as any)}, ${null}, ${origin.sessionType},
      ${origin.sessionId}, ${origin.credentialId}, ${origin.actorLabel}
    )
    RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
  `;
  return { ok: true, row: decryptRowPayload(projectRemoteCommandRow(row)), inserted: true };
}

// ── List pending commands ────────────────────────────────────────────

/**
 * List commands eligible for processing: queued commands plus
 * stale-claimed commands past the lease timeout (for recovery).
 */
export async function listPending(
  sql: SqlTag,
  tenantId: string,
  limitParam: number = 50,
  options?: { nodeId?: string },
): Promise<RemoteCommandRow[]> {
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 200)
    : 50;
  const nodeFilter = options?.nodeId
    ? sql`AND (target_node_id IS NULL OR target_node_id = ${options.nodeId})`
    : sql``;
  const rows = await sql`
    SELECT id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
    FROM remote_commands
    WHERE tenant_id = ${tenantId}
      AND expires_at > now()
      AND (
        status = 'queued'
        OR (status = 'claimed' AND claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES}))
      )
      ${nodeFilter}
      AND (
        origin_session_type <> 'hosted-mcp-agent'
        OR EXISTS (
          SELECT 1
          FROM hosted_agent_credentials c
          JOIN accounts a ON a.account_id = c.account_id
          JOIN account_tenant_links atl
            ON atl.account_id = c.account_id
            AND atl.tenant_id = c.tenant_id
            AND atl.status = 'active'
          WHERE c.credential_id = remote_commands.origin_credential_id
            AND c.tenant_id = remote_commands.tenant_id
            AND c.account_id = remote_commands.account_id
            AND c.agent_id = remote_commands.origin_session_id
            AND c.status = 'active'
            AND a.status = 'active'
        )
      )
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  // Decrypt sensitive payloads on read
  return (rows as unknown as RemoteCommandRow[]).map(decryptRowPayload);
}

// ── Claim a command ──────────────────────────────────────────────────

/**
 * Claim lease timeout. If a command stays in 'claimed' for longer than
 * this without being resolved, it becomes re-claimable. This handles
 * transient failures where the worker claimed successfully but crashed
 * or lost connectivity before posting the result.
 *
 * Set conservatively high: all dispatches are local function calls
 * (sub-second), so 5 minutes means something went seriously wrong.
 */
export const CLAIM_LEASE_TIMEOUT_MINUTES = 5;

export interface HostedAgentOriginRejection {
  id: string;
  tenant_id: string;
  account_id: string;
  category: CommandCategory;
  command_type: CommandType;
  origin_session_id: string | null;
  origin_credential_id: string | null;
  origin_actor_label: string | null;
}

export type ClaimCommandWithOriginCheckResult =
  | { ok: true; row: RemoteCommandRow }
  | { ok: false; reason: "not_claimable" }
  | { ok: false; reason: "hosted_agent_revoked_mid_flight"; rejected: HostedAgentOriginRejection };

function projectHostedAgentOriginRejection(row: any): HostedAgentOriginRejection {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    account_id: String(row.account_id),
    category: row.category as CommandCategory,
    command_type: row.command_type as CommandType,
    origin_session_id: row.origin_session_id == null ? null : String(row.origin_session_id),
    origin_credential_id: row.origin_credential_id == null ? null : String(row.origin_credential_id),
    origin_actor_label: row.origin_actor_label == null ? null : String(row.origin_actor_label),
  };
}

async function hostedAgentOriginStillActive(
  sql: SqlTag,
  row: {
    tenant_id: string;
    account_id: string;
    origin_session_id: string | null;
    origin_credential_id: string | null;
  },
): Promise<boolean> {
  if (!row.origin_session_id || !row.origin_credential_id) return false;
  const [active] = await sql`
    SELECT 1
    FROM hosted_agent_credentials c
    JOIN accounts a ON a.account_id = c.account_id
    JOIN account_tenant_links atl
      ON atl.account_id = c.account_id
      AND atl.tenant_id = c.tenant_id
      AND atl.status = 'active'
    WHERE c.credential_id = ${row.origin_credential_id}::uuid
      AND c.tenant_id = ${row.tenant_id}
      AND c.account_id = ${row.account_id}::uuid
      AND c.agent_id = ${row.origin_session_id}
      AND c.status = 'active'
      AND a.status = 'active'
    LIMIT 1
  `;
  return !!active;
}

async function rejectHostedAgentOriginCommand(
  sql: SqlTag,
  commandId: string,
  tenantId: string,
): Promise<HostedAgentOriginRejection | null> {
  const [rejected] = await sql`
    UPDATE remote_commands SET
      status = 'rejected',
      result = ${sql.json({ error: "hosted_agent_revoked_mid_flight" })},
      updated_at = now()
    WHERE id = ${commandId}::uuid
      AND tenant_id = ${tenantId}
      AND origin_session_type = 'hosted-mcp-agent'
      AND expires_at > now()
      AND (
        status = 'queued'
        OR (status = 'claimed' AND claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES}))
      )
    RETURNING id, tenant_id, account_id, category, command_type,
      origin_session_id, origin_credential_id, origin_actor_label
  `;
  return rejected ? projectHostedAgentOriginRejection(rejected) : null;
}

/**
 * Atomically claim a queued command. Also reclaims commands that are
 * stuck in 'claimed' past the lease timeout.
 *
 * Returns the claimed row, or null if the command was already claimed
 * (within lease) or already resolved.
 */
export async function claimCommand(
  sql: SqlTag,
  commandId: string,
  nodeId: string,
  options?: { tenantId?: string },
): Promise<RemoteCommandRow | null> {
  const tenantFilter = options?.tenantId
    ? sql`AND tenant_id = ${options.tenantId}`
    : sql``;
  const targetNodeFilter = sql`AND (target_node_id IS NULL OR target_node_id = ${nodeId})`;

  const [row] = await sql`
    UPDATE remote_commands SET
      status = 'claimed',
      claimed_at = now(),
      claimed_by = ${nodeId},
      updated_at = now()
    WHERE id = ${commandId}
      AND expires_at > now()
      AND (
        status = 'queued'
        OR (
          status = 'claimed'
          AND (
            claimed_by = ${nodeId}
            OR claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES})
          )
        )
      )
      ${tenantFilter}
      ${targetNodeFilter}
    RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
  `;
  return row ? (row as unknown as RemoteCommandRow) : null;
}

/**
 * Claim with the hosted-MCP-origin credential gate in the same lock path.
 * Browser-session rows retain the existing claim semantics. Hosted-agent
 * rows are checked by credential_id/account/link/agent_id, never by a
 * raw vop_REDACTED* token, because /remote/claim is sync-token authenticated.
 */
export async function claimCommandWithOriginCheck(
  sql: SqlTag,
  commandId: string,
  nodeId: string,
  options: { tenantId: string },
): Promise<ClaimCommandWithOriginCheckResult> {
  return await sql.begin(async (tx: any) => {
    const [candidate] = await tx`
      SELECT id, tenant_id, account_id, category, command_type, target_node_id, payload,
        status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
        origin_session_id, origin_credential_id, origin_actor_label, created_at,
        updated_at, expires_at
      FROM remote_commands
      WHERE id = ${commandId}::uuid
        AND tenant_id = ${options.tenantId}
        AND expires_at > now()
        AND (target_node_id IS NULL OR target_node_id = ${nodeId})
        AND (
          status = 'queued'
          OR (
            status = 'claimed'
            AND (
              claimed_by = ${nodeId}
              OR claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES})
            )
          )
        )
      FOR UPDATE
    `;
    if (!candidate) return { ok: false, reason: "not_claimable" } as const;

    if (candidate.origin_session_type === "hosted-mcp-agent") {
      const active = await hostedAgentOriginStillActive(tx, {
        tenant_id: candidate.tenant_id,
        account_id: String(candidate.account_id),
        origin_session_id: candidate.origin_session_id,
        origin_credential_id: candidate.origin_credential_id,
      });
      if (!active) {
        const rejected = await rejectHostedAgentOriginCommand(tx, commandId, options.tenantId);
        return {
          ok: false,
          reason: "hosted_agent_revoked_mid_flight",
          rejected: rejected ?? projectHostedAgentOriginRejection(candidate),
        } as const;
      }
    }

    const [row] = await tx`
      UPDATE remote_commands SET
        status = 'claimed',
        claimed_at = now(),
        claimed_by = ${nodeId},
        updated_at = now()
      WHERE id = ${commandId}::uuid
        AND tenant_id = ${options.tenantId}
        AND (target_node_id IS NULL OR target_node_id = ${nodeId})
        AND (
          status = 'queued'
          OR (
            status = 'claimed'
            AND (
              claimed_by = ${nodeId}
              OR claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES})
            )
          )
        )
      RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
        status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
        origin_session_id, origin_credential_id, origin_actor_label, created_at,
        updated_at, expires_at
    `;
    if (!row) return { ok: false, reason: "not_claimable" } as const;
    return { ok: true, row: row as unknown as RemoteCommandRow } as const;
  });
}

/**
 * Sweep queued / stale-claimed hosted-MCP-origin commands whose original
 * credential, account, or tenant link is no longer active before
 * /remote/pending returns payloads to the local worker.
 */
export async function rejectRevokedHostedAgentOriginCommands(
  sql: SqlTag,
  tenantId: string,
  limitParam: number = 50,
): Promise<HostedAgentOriginRejection[]> {
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 200)
    : 50;
  const rejected = await sql.begin(async (tx: any) => {
    const candidates = await tx`
      SELECT rc.id, rc.tenant_id, rc.account_id, rc.category, rc.command_type,
        rc.origin_session_id, rc.origin_credential_id, rc.origin_actor_label
      FROM remote_commands rc
      LEFT JOIN hosted_agent_credentials c
        ON c.credential_id = rc.origin_credential_id
        AND c.tenant_id = rc.tenant_id
        AND c.account_id = rc.account_id
        AND c.agent_id = rc.origin_session_id
        AND c.status = 'active'
      LEFT JOIN accounts a
        ON a.account_id = rc.account_id
        AND a.status = 'active'
      LEFT JOIN account_tenant_links atl
        ON atl.account_id = rc.account_id
        AND atl.tenant_id = rc.tenant_id
        AND atl.status = 'active'
      WHERE rc.tenant_id = ${tenantId}
        AND rc.origin_session_type = 'hosted-mcp-agent'
        AND rc.expires_at > now()
        AND (
          rc.status = 'queued'
          OR (rc.status = 'claimed' AND rc.claimed_at < now() - make_interval(mins => ${CLAIM_LEASE_TIMEOUT_MINUTES}))
        )
        AND (c.credential_id IS NULL OR a.account_id IS NULL OR atl.account_id IS NULL)
      ORDER BY rc.created_at ASC
      LIMIT ${limit}
      FOR UPDATE OF rc
    `;
    const out: HostedAgentOriginRejection[] = [];
    for (const candidate of candidates) {
      const row = await rejectHostedAgentOriginCommand(tx, String(candidate.id), tenantId);
      if (row) out.push(row);
    }
    return out;
  });
  return rejected;
}

// ── Resolve a command ────────────────────────────────────────────────

export type ResolveStatus = "applied" | "rejected" | "failed";

/**
 * Mark a claimed command as applied, rejected, or failed.
 * Optionally clears sensitive payload data according to the caller's
 * scrub-policy decision.
 */
export async function resolveCommand(
  sql: SqlTag,
  commandId: string,
  status: ResolveStatus,
  result: Record<string, unknown>,
  options?: { clearPayload?: boolean; tenantId?: string; claimedBy?: string },
): Promise<RemoteCommandRow | null> {
  const payloadUpdate = options?.clearPayload
    ? sql`, payload = '{}'::jsonb`
    : sql``;
  const tenantFilter = options?.tenantId
    ? sql`AND tenant_id = ${options.tenantId}`
    : sql``;
  const claimedByFilter = options?.claimedBy
    ? sql`AND claimed_by = ${options.claimedBy}`
    : sql``;

  const [row] = await sql`
    UPDATE remote_commands SET
      status = ${status},
      result = ${sql.json(result as any)},
      updated_at = now()
      ${payloadUpdate}
    WHERE id = ${commandId}
      AND status = 'claimed'
      ${tenantFilter}
      ${claimedByFilter}
    RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
  `;
  return row ? (row as unknown as RemoteCommandRow) : null;
}

// ── Cancel a queued command (user-initiated, hosted session) ─────────
//
// Terminal transition: queued → canceled. Only the owning hosted account
// within the owning tenant may cancel. Cancel is a SINGLE atomic UPDATE
// that:
//   (a) flips status queued→canceled
//   (b) writes a structured result with canceled_by + account_id + reason
//   (c) blanks payload in the same statement when the command carries a
//       sensitive envelope — no read-then-update race.
//
// The WHERE clause pins tenant_id AND account_id AND status='queued', so
// a concurrent claim or a cross-account attempt cannot succeed. If zero
// rows come back, a best-effort diagnostic SELECT determines the reason:
//   - row missing / wrong owner  → "not_found" (uniform 404 model)
//   - row present but not queued → "not_queued" (409 with current status)

export interface CancelCommandParams {
  commandId: string;
  tenantId: string;
  accountId: string;
  /** Optional tag recorded inside the structured cancel result. */
  canceledBy?: typeof REMOTE_COMMAND_CANCEL_ACTOR;
  /** Optional free-form reason — kept short, not PII. */
  reason?: string;
}

export type CancelCommandResult =
  | { ok: true; row: RemoteCommandRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_queued"; status: CommandStatus };

/** Canonical UUID shape — matches version-agnostic 8-4-4-4-12 hex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function cancelQueuedCommand(
  sql: SqlTag,
  params: CancelCommandParams,
): Promise<CancelCommandResult> {
  const {
    commandId,
    tenantId,
    accountId,
    canceledBy = REMOTE_COMMAND_CANCEL_ACTOR,
    reason = "user_cancel",
  } = params;

  // Guard the UUID cast. Without this, a malformed id (e.g. "not-a-uuid"
  // sent to /remote/cancel or arriving via a stale /my/commands/:id URL)
  // would raise a Postgres cast error and bubble up as a 500 instead of
  // the honest client-error we want. Malformed IDs cannot possibly match
  // a real row, so they're indistinguishable from "not found" to the
  // caller — same 404 model.
  if (!UUID_RE.test(commandId)) {
    return { ok: false, reason: "not_found" };
  }

  const cancelResult = {
    canceled_by: canceledBy,
    account_id: accountId,
    reason,
  };

  // Single atomic UPDATE. CASE expression clears payload only for
  // sensitive commands, all in one statement. No read-then-update,
  // no second trip, no window for another process to claim the row
  // between status check and write.
  const [row] = await sql`
    UPDATE remote_commands SET
      status = 'canceled',
      result = ${sql.json(cancelResult)},
      payload = CASE
        WHEN category || ':' || command_type = ANY(${REMOTE_COMMAND_SCRUB_PAIR_KEYS}::text[]) THEN '{}'::jsonb
        ELSE payload
      END,
      updated_at = now()
    WHERE id = ${commandId}::uuid
      AND tenant_id = ${tenantId}
      AND account_id = ${accountId}::uuid
      AND status = 'queued'
    RETURNING id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
  `;
  if (row) {
    return { ok: true, row: row as unknown as RemoteCommandRow };
  }

  // Atomic update didn't match — diagnose why for the caller's error
  // response. This SELECT is informational only and owner-scoped; it
  // never reads across tenant/account boundaries.
  const [probe] = await sql`
    SELECT status
    FROM remote_commands
    WHERE id = ${commandId}::uuid
      AND tenant_id = ${tenantId}
      AND account_id = ${accountId}::uuid
    LIMIT 1
  `;
  if (!probe) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "not_queued", status: probe.status as CommandStatus };
}

// ── List command history ─────────────────────────────────────────────

export interface HistoryParams {
  accountId?: string;
  status?: CommandStatus;
  limit?: number;
  offset?: number;
}

export async function listCommandHistory(
  sql: SqlTag,
  tenantId: string,
  params: HistoryParams = {},
): Promise<RemoteCommandRow[]> {
  const rawLimit = typeof params.limit === "number" ? params.limit : 50;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 100)
    : 50;
  const rawOffset = typeof params.offset === "number" ? params.offset : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0
    ? rawOffset
    : 0;

  const accountFilter = params.accountId
    ? sql`AND account_id = ${params.accountId}::uuid`
    : sql``;
  const statusFilter = params.status
    ? sql`AND status = ${params.status}`
    : sql``;

  const rows = await sql`
    SELECT id, tenant_id, account_id, category, command_type, target_node_id, payload,
      status, claimed_at, claimed_by, result, idempotency_key, origin_session_type,
      origin_session_id, origin_credential_id, origin_actor_label, created_at,
      updated_at, expires_at
    FROM remote_commands
    WHERE tenant_id = ${tenantId}
      ${accountFilter}
      ${statusFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as unknown as RemoteCommandRow[];
}
