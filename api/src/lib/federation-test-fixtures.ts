/**
 * Federation test fixtures — shared request-body builders
 * for VO+ federation rung tests.
 * VO-PLUS-FEDERATION-FIXTURES-PR-1.
 *
 * Rungs 1-5 each exercise a different surface of the
 * federation pipeline (link challenge → sync-token claim →
 * sync push → remote-intent queue → apply). Their tests
 * would otherwise each re-derive payload shapes from the
 * route handlers, drifting away from the real contract every
 * time a handler shifts.
 *
 * This module centralizes the well-formed payload shapes so
 * rung-level tests import them instead. Each builder returns
 * a body that the current route handler accepts; if a handler
 * tightens validation, we update the builder here once and
 * all rung tests pick it up.
 *
 * Not a live integration runner. A full runner needs a
 * seeded Postgres + credentials and belongs in agent-lab/
 * next to run-hosted-proof.ts. This module is the narrow,
 * in-process fixture layer that sits underneath such a
 * runner and underneath in-process Hono route tests.
 */

import crypto from "node:crypto";
import type { RotateChallengePayload } from "./node-keypair";

/**
 * An ephemeral ed25519 keypair generated for a single test.
 * Intentionally NOT persisted to disk — unlike the
 * production `ensureNodeKeypair()` in `node-keypair.ts`,
 * tests must not mutate the operator's real node key.
 */
export interface EphemeralNodeKeypair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyPem: string;
}

export function generateEphemeralNodeKeypair(): EphemeralNodeKeypair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  return { privateKey, publicKey, publicKeyPem };
}

/**
 * Sign a link-challenge payload with an ephemeral keypair.
 * Produces the same `base64url(json).base64url(sig)` envelope
 * that `signLinkChallenge` in `node-keypair.ts` produces, so
 * the hosted-side `verifyLinkChallenge` accepts it.
 *
 * Kept as a separate entry point (rather than calling the
 * production `signLinkChallenge`) so tests stay decoupled
 * from `~/.vo/node.key` and from `resolveConfigPath`.
 */
export function signLinkChallengeWithKeypair(
  keypair: EphemeralNodeKeypair,
  payload: { tenant_id: string; node_id: string; exp: number },
): string {
  const data = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(data), keypair.privateKey);
  const payloadB64 = Buffer.from(data).toString("base64url");
  const sigB64 = signature.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/**
 * Sign a rotation-challenge payload with an ephemeral keypair.
 * Mirrors `signRotateChallenge` without touching the operator's
 * persisted local node key.
 */
export function signRotateChallengeWithKeypair(
  keypair: EphemeralNodeKeypair,
  payload: RotateChallengePayload,
): string {
  const data = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(data), keypair.privateKey);
  const payloadB64 = Buffer.from(data).toString("base64url");
  const sigB64 = signature.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/**
 * Default challenge TTL for fixtures. 60 seconds is long
 * enough for any in-process test yet short enough that a
 * stale fixture in a long-running CI job surfaces as
 * "Challenge expired" instead of silently still working.
 */
export const FIXTURE_CHALLENGE_TTL_SECONDS = 60;

export function fixtureChallengeExp(
  ttlSeconds: number = FIXTURE_CHALLENGE_TTL_SECONDS,
): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

// ── sync batch builders ────────────────────────────────────

/**
 * Build a minimal valid `schema_version: 1` sync batch body
 * for `POST /sync/push`. Caller overrides `tenant_id`,
 * `node_id`, and items; defaults cover the scaffolding the
 * handler always requires.
 *
 * Keep this in sync with the validation block in
 * `api/src/routes/sync.ts` — item_count matches items.length,
 * cursor_to >= cursor_from, and items each have a valid
 * `type` + `op` pair.
 */
export interface SyncBatchInit {
  tenant_id: string;
  node_id: string;
  batch_id?: string;
  cursor_from?: number;
  cursor_to?: number;
  items?: Array<Record<string, unknown>>;
}

export function buildSyncBatch(init: SyncBatchInit): Record<string, unknown> {
  const items = init.items ?? [];
  return {
    schema_version: 1,
    tenant_id: init.tenant_id,
    node_id: init.node_id,
    batch_id: init.batch_id ?? `fixture-${crypto.randomUUID()}`,
    cursor_from: init.cursor_from ?? 0,
    cursor_to: init.cursor_to ?? items.length,
    item_count: items.length,
    items,
  };
}

/**
 * Build a well-formed `memory` sync item. Shape matches
 * `itemMetadata` in sync.ts — `addr`, `project_addr`, and
 * a `substance` object with `source_kind`.
 */
export function buildMemoryItem(init: {
  addr: string;
  project_addr?: string | null;
  source_kind?: string;
  op?: "upsert" | "tombstone" | "archive" | "delete";
  substance?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: "memory",
    op: init.op ?? "upsert",
    addr: init.addr,
    project_addr: init.project_addr ?? null,
    substance: {
      source_kind: init.source_kind ?? "note",
      ...init.substance,
    },
  };
}

// ── remote-intent command builders ─────────────────────────

/**
 * Build a well-formed `set_default_model` remote command
 * body for `POST /remote/queue`. Chosen as the default
 * fixture command because its validation rules (in
 * `remote-command-types.ts`) are stable across recent work
 * and its payload surface is a single string field.
 *
 * Callers that need other command types should add explicit
 * builders here rather than hand-rolling in tests, so the
 * validation rules have one source of truth per command.
 */
export interface SetDefaultModelInit {
  tenant_id: string;
  account_id: string;
  agent_id?: string;
  model: string;
  idempotency_key?: string | null;
}

export function buildSetDefaultModelCommand(
  init: SetDefaultModelInit,
): Record<string, unknown> {
  return {
    tenant_id: init.tenant_id,
    account_id: init.account_id,
    agent_id: init.agent_id ?? null,
    category: "settings",
    command_type: "set_default_model",
    payload: { model: init.model },
    idempotency_key: init.idempotency_key ?? `fixture-${crypto.randomUUID()}`,
  };
}

// ── account-link challenge builders ────────────────────────

export interface LinkChallengeInit {
  tenant_id: string;
  node_id: string;
  keypair: EphemeralNodeKeypair;
  ttlSeconds?: number;
}

/**
 * Build the body for `POST /account/link` when the hosted
 * side is expecting a node-challenge-presenting link request.
 * Returns both the request body and the plaintext payload so
 * tests can assert on the decoded values without re-parsing
 * the signed envelope.
 */
export function buildLinkChallengeBody(init: LinkChallengeInit): {
  body: Record<string, unknown>;
  payload: { tenant_id: string; node_id: string; exp: number };
  signedChallenge: string;
} {
  const payload = {
    tenant_id: init.tenant_id,
    node_id: init.node_id,
    exp: fixtureChallengeExp(init.ttlSeconds),
  };
  const signedChallenge = signLinkChallengeWithKeypair(init.keypair, payload);
  return {
    body: {
      tenant_id: init.tenant_id,
      node_id: init.node_id,
      node_public_key: init.keypair.publicKeyPem,
      signed_challenge: signedChallenge,
    },
    payload,
    signedChallenge,
  };
}
