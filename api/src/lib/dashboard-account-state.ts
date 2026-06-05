/**
 * Dashboard Account state projection —
 * VO-LOCAL-DASHBOARD-GOOGLE-LINK-PR-1 (rung 1 UI).
 *
 * Pure mapping from backend rows to the 5-state projection
 * the rung-1 design pins:
 *
 *   - unconfigured — handler returned 403 (no tenant context)
 *   - unlinked     — no account_tenant_links row for this tenant
 *   - pending      — status='pending_confirmation'
 *   - linked       — status='active'
 *   - mismatched   — linked/pending row exists but the stored
 *                    node_public_key disagrees with what the
 *                    local node presents. Only detected when
 *                    the operator is viewing the local node's
 *                    own tenant; cross-tenant views skip the
 *                    mismatch check because the local side has
 *                    no way to know the other node's key.
 *
 * This module does not touch the database directly — it takes
 * already-resolved inputs and returns the projection. The
 * /dashboard/account handler owns DB reads + auth; this helper
 * owns the mapping. Keeps the state machine unit-testable
 * without a live Postgres.
 *
 * Rung 3 extends the context with a sync-health projection
 * using the shared vocabulary from federation-sync-health.ts.
 * The `sync_health` field is always populated (even for
 * unconfigured / unlinked states) so the dashboard can render
 * a consistent badge across the 5 link states.
 */

import {
  computeLocalSyncHealth,
  type LocalSyncHealthInput,
  type SyncHealthState,
} from "./federation-sync-health";

export type AccountDashboardState =
  | "unconfigured"
  | "unlinked"
  | "pending"
  | "linked"
  | "mismatched";

/**
 * Read-only sibling-node visibility (rung-2 Q3=A+).
 * Populated from hosted_nodes rows for the tenant other
 * than the local device's row. Action buttons still
 * target ONLY the local device — this list is purely
 * read-visibility so operators can see remote devices
 * without committing to the full cross-device write model.
 */
export interface SiblingNode {
  node_id: string;
  status: string;
  last_sync_at: string | null;
  sync_token_claimed: boolean;
}

export interface AccountDashboardContext {
  tenant_id: string | null;
  account_email: string | null;
  account_display_name: string | null;
  link_status: "active" | "pending_confirmation" | "unlinked" | null;
  node_id: string | null;
  sync_token_claimed: boolean | null;
  last_sync_at: string | null;
  /** Set when state === "mismatched"; names the specific
   *  disagreement so the UI can render a useful recovery
   *  message. */
  mismatch_reason: string | null;
  /** Tenant-wide node visibility (read-only). Non-local
   *  rows only; local is in node_id etc. above. Rung 2
   *  Q3=A+. */
  sibling_nodes: ReadonlyArray<SiblingNode>;
  /** Rung 3 sync-health projection — shared 5-state
   *  vocabulary from federation-sync-health.ts. Always
   *  populated so the badge is consistent across link
   *  states; unconfigured / unlinked views default to
   *  "disabled" since there is no sync target yet. */
  sync_health: SyncHealthState;
  /** Age of hosted_nodes.last_sync_at in seconds, relative
   *  to the projection time. Null when hosted has no
   *  timestamp (fresh is structurally unreachable). */
  sync_health_age_seconds: number | null;
  /** Count of local journal items past the current cursor
   *  — work queued locally but not yet pushed. Rung 3 reads
   *  this from getSyncStatus().journal_pending. */
  pending_journal_count: number;
  /** Local sync cursor value (most recently pushed seq).
   *  Null when no cursor file exists yet. */
  local_cursor: number | null;
}

export interface AccountDashboardAction {
  /** Stable machine-readable ID. UI renders buttons keyed on
   *  this; proof runner asserts on this. */
  id:
    | "submit_link_code"
    | "open_hosted_portal"
    | "refresh"
    | "cancel_pending"
    | "claim_sync_token"
    | "rotate_sync_token"
    | "unlink_tenant"
    | "relink"
    | "abandon_mismatch"
    | "revoke_this_node"
    | "rotate_local_node_key";
  /** Operator-readable label for the button text. */
  label: string;
  /** HTTP verb + path the UI POSTs/GETs. `null` for pure
   *  instructional actions. */
  method: "GET" | "POST" | null;
  path: string | null;
  /** Short explanation shown under the button. Empty string
   *  for self-explanatory actions. */
  hint: string;
}

export interface AccountDashboardProjection {
  state: AccountDashboardState;
  context: AccountDashboardContext;
  actions: ReadonlyArray<AccountDashboardAction>;
}

/**
 * Input shape the handler passes to project().
 *
 * `hasTenantContext`: false when the tenant resolver returned
 * null (handler answers 403 separately; this helper returns
 * unconfigured so the state machine is testable end-to-end).
 *
 * `link`: the single row for (tenant_id, status IN ('active',
 * 'pending_confirmation')) if any. null = unlinked.
 *
 * `node`: the hosted_nodes row for (account_id, tenant_id,
 * linked_by_node_id). Same shape, null = no row (only possible
 * mid-flow or after revoke).
 *
 * `localNodeKeyPem`: the local node's public key PEM, if the
 * operator is viewing the local tenant AND the key is
 * readable. null skips mismatch detection cleanly.
 */
export interface ProjectInput {
  hasTenantContext: boolean;
  tenantId: string | null;
  accountEmail: string | null;
  accountDisplayName: string | null;
  link: {
    status: "active" | "pending_confirmation" | "unlinked";
    linked_by_node_id: string | null;
  } | null;
  node: {
    node_id: string | null;
    status: string;
    node_public_key: string | null;
    sync_token_claimed: boolean;
    last_sync_at: string | null;
  } | null;
  localNodeKeyPem: string | null;
  /** Rung 2 Q3=A+: non-local tenant devices for read-
   *  visibility. Projected verbatim into
   *  context.sibling_nodes. Default [] when the handler
   *  hasn't loaded them. */
  siblingNodes?: ReadonlyArray<SiblingNode>;
  /** Rung 2: true when the dashboard viewer is operator-
   *  token scoped. Gates operator-only actions like
   *  rotate_local_node_key (force-rotate). Default
   *  false — tenant-token views never see operator-only
   *  actions. */
  viewerIsOperator?: boolean;
  /** Rung 3: sync-health derivation input. Optional for
   *  backwards-compat with tests that don't care about the
   *  health surface — absent means syncConfigured=false +
   *  no timestamps, which projects to sync_health='disabled'
   *  (the correct default when the handler has no data). */
  syncHealthInput?: LocalSyncHealthInput;
  /** Rung 3: count from getSyncStatus().journal_pending.
   *  Default 0 when handler has not queried yet. */
  pendingJournalCount?: number;
  /** Rung 3: local sync cursor (seq of last pushed item).
   *  Default null when no cursor file exists. */
  localCursor?: number | null;
  /** Rung 3: reference time for sync_health_age_seconds.
   *  Optional — defaults to now. Tests can pass a fixed
   *  value for deterministic age assertions. */
  nowMs?: number;
}

const EMPTY_CONTEXT: AccountDashboardContext = {
  tenant_id: null,
  account_email: null,
  account_display_name: null,
  link_status: null,
  node_id: null,
  sync_token_claimed: null,
  last_sync_at: null,
  mismatch_reason: null,
  sibling_nodes: [],
  sync_health: "disabled",
  sync_health_age_seconds: null,
  pending_journal_count: 0,
  local_cursor: null,
};

const DISABLED_SYNC_INPUT: LocalSyncHealthInput = {
  syncConfigured: false,
  lastAttemptAt: null,
  lastResult: null,
  hostedLastSyncAt: null,
};

/** Computes the sync-health fields for a given projection
 *  input. Centralizes the fresh-requires-hosted-timestamp
 *  invariant; callers should not hand-roll these values. */
function deriveSyncHealthContext(
  input: ProjectInput,
): Pick<
  AccountDashboardContext,
  "sync_health" | "sync_health_age_seconds" | "pending_journal_count" | "local_cursor"
> {
  const syncInput = input.syncHealthInput ?? DISABLED_SYNC_INPUT;
  const now = input.nowMs ?? Date.now();
  const sync_health = computeLocalSyncHealth({
    ...syncInput,
    nowMs: input.nowMs ?? syncInput.nowMs,
  });
  const ts = syncInput.hostedLastSyncAt
    ? new Date(syncInput.hostedLastSyncAt).getTime()
    : null;
  const sync_health_age_seconds =
    ts !== null && Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 1000)) : null;
  return {
    sync_health,
    sync_health_age_seconds,
    pending_journal_count: input.pendingJournalCount ?? 0,
    local_cursor: input.localCursor ?? null,
  };
}

const UNCONFIGURED_ACTIONS: ReadonlyArray<AccountDashboardAction> = [
  {
    id: "open_hosted_portal",
    label: "Documentation: link this node to a tenant",
    method: null,
    path: null,
    hint:
      "Set VERITY_TENANT_TOKEN in the local environment, or pass " +
      "?tenant_id=<id> with an operator token. See docs/federation.",
  },
];

const UNLINKED_ACTIONS: ReadonlyArray<AccountDashboardAction> = [
  {
    id: "submit_link_code",
    label: "Submit link code",
    method: "POST",
    path: "/dashboard/account/link-submit",
    hint: "Paste the code you generated at verityone.app/my/account.",
  },
  {
    id: "open_hosted_portal",
    label: "Open verityone.app/my/account",
    method: null,
    path: null,
    hint: "Generates a new link code in the hosted portal.",
  },
];

function pendingActions(
  tenantId: string,
  nodeId: string | null,
): ReadonlyArray<AccountDashboardAction> {
  const cancelPath = nodeId ? "/account/link/cancel" : null;
  return [
    {
      id: "refresh",
      label: "Refresh status",
      method: "GET",
      path: "/dashboard/account",
      hint: "Re-check whether the hosted operator has approved.",
    },
    {
      id: "cancel_pending",
      label: "Cancel link",
      method: "POST",
      path: cancelPath,
      hint:
        "Releases the pending claim on this tenant. The operator can " +
        "then generate a fresh code.",
    },
  ];
}

function linkedActions(
  syncTokenClaimed: boolean,
  nodeId: string | null,
): ReadonlyArray<AccountDashboardAction> {
  const actions: AccountDashboardAction[] = [];
  if (nodeId) {
    if (syncTokenClaimed) {
      actions.push({
        id: "rotate_sync_token",
        label: "Rotate sync token",
        method: "POST",
        path: "/dashboard/account/sync-token/rotate",
        hint:
          "Invalidates the existing sync token and writes a fresh one into " +
          "~/.vo/sync-token for this local node.",
      });
    } else {
      actions.push({
        id: "claim_sync_token",
        label: "Claim sync token",
        method: "POST",
        path: "/dashboard/account/sync-token/claim",
        hint: "Shown once — caches the issued token into ~/.vo/sync-token with 0600.",
      });
    }
    // Rung 2: per-device revoke (distinct from full
    // tenant unlink). Only shown when we have a local
    // node_id to target — the bridge resolves the local
    // identity server-side and rejects any browser-
    // supplied mismatch before calling revokeNode().
    actions.push({
      id: "revoke_this_node",
      label: "Revoke this node",
      method: "POST",
      path: "/dashboard/account/node/revoke",
      hint:
        "Revokes only this local device. The tenant link stays active for " +
        "other devices. Cross-device revoke stays on verityone.app/my/account.",
    });
  }
  actions.push({
    id: "unlink_tenant",
    label: "Unlink tenant",
    method: "POST",
    path: "/dashboard/account/unlink",
    hint:
      "Fully unlinks the tenant from its hosted account. Revokes every " +
      "associated node + sync token + agent credential.",
  });
  return actions;
}

function mismatchedActions(
  linkStatus: "active" | "pending_confirmation" | "unlinked",
  viewerIsOperator: boolean,
): ReadonlyArray<AccountDashboardAction> {
  const actions: AccountDashboardAction[] = [
    {
      id: "relink",
      label: "Relink with current local key",
      method: null,
      path: null,
      hint:
        "Guide through unlink -> relink with the current local key. " +
        "Operators can instead use 'Rotate local node key' below to " +
        "force-rotate the hosted key without losing the link.",
    },
    {
      id: "abandon_mismatch",
      label: "Abandon link",
      method: "POST",
      path: linkStatus === "active" ? "/dashboard/account/unlink" : "/account/link/cancel",
      hint:
        linkStatus === "active"
          ? "Fully unlinks this tenant from the hosted account so the local node can start clean."
          : "Clears the pending claim without reclaiming the tenant. Use if the local node key has been intentionally rotated.",
    },
  ];
  // Rung 2 Q1=C force-rotate escape hatch. Operator-
  // token views only: the force-rotate endpoint requires
  // access.scope === "operator" and the UI should not
  // even render the button for tenant-token callers who
  // cannot succeed with it.
  if (viewerIsOperator) {
    actions.push({
      id: "rotate_local_node_key",
      label: "Rotate local node key",
      method: "POST",
      path: "/dashboard/account/key/rotate",
      hint:
        "Force-rotate the hosted public key to match this local node's key. " +
        "Operator-token only; writes a node_key_force_rotated audit row.",
    });
  }
  return actions;
}

/**
 * Project backend rows into the 5-state UI projection.
 */
export function projectAccountState(
  input: ProjectInput,
): AccountDashboardProjection {
  if (!input.hasTenantContext) {
    return {
      state: "unconfigured",
      context: EMPTY_CONTEXT,
      actions: UNCONFIGURED_ACTIONS,
    };
  }

  const siblingNodes = input.siblingNodes ?? [];
  const viewerIsOperator = input.viewerIsOperator === true;
  const syncHealth = deriveSyncHealthContext(input);
  const baseContext: AccountDashboardContext = {
    ...EMPTY_CONTEXT,
    tenant_id: input.tenantId,
    account_email: input.accountEmail,
    account_display_name: input.accountDisplayName,
    sibling_nodes: siblingNodes,
    ...syncHealth,
  };

  // No link row: operator has a tenant context but never linked.
  if (!input.link) {
    return {
      state: "unlinked",
      context: baseContext,
      actions: UNLINKED_ACTIONS,
    };
  }

  // Mismatch check — only meaningful when we have a local
  // node key to compare against. If the operator is viewing a
  // different node's tenant, input.localNodeKeyPem is null
  // and we skip the check (not "linked successfully" — we
  // just don't claim to have verified).
  const storedKey = input.node?.node_public_key ?? null;
  const resolvedNodeId =
    input.node?.node_id ??
    (input.link.status === "pending_confirmation"
      ? input.link.linked_by_node_id
      : null);
  const mismatchReason = detectMismatch(
    input.link.status,
    storedKey,
    input.localNodeKeyPem,
  );
  if (mismatchReason) {
    return {
      state: "mismatched",
      context: {
        ...baseContext,
        link_status: input.link.status,
        node_id: resolvedNodeId,
        sync_token_claimed: input.node?.sync_token_claimed ?? null,
        last_sync_at: input.node?.last_sync_at ?? null,
        mismatch_reason: mismatchReason,
      },
      actions: mismatchedActions(input.link.status, viewerIsOperator),
    };
  }

  const context: AccountDashboardContext = {
    ...baseContext,
    link_status: input.link.status,
    node_id: resolvedNodeId,
    sync_token_claimed: input.node?.sync_token_claimed ?? null,
    last_sync_at: input.node?.last_sync_at ?? null,
    // syncHealth already flowed through via baseContext
    // spread above; repeat is intentional defense-in-depth
    // if a future edit drops the spread — sync_health must
    // never be missing from a returned context.
  };

  if (input.link.status === "pending_confirmation") {
    return {
      state: "pending",
      context,
      actions: pendingActions(
        input.tenantId ?? "",
        input.link.linked_by_node_id,
      ),
    };
  }

  if (input.link.status === "active") {
    return {
      state: "linked",
      context,
      actions: linkedActions(
        input.node?.status === "active"
          ? (input.node?.sync_token_claimed ?? false)
          : false,
        input.node?.status === "active"
          ? (input.node?.node_id ?? null)
          : null,
      ),
    };
  }

  // status='unlinked' — the link row exists but has been
  // archived. Surface as `unlinked` (the operator sees the
  // same UI as if there had never been a row).
  return {
    state: "unlinked",
    context: baseContext,
    actions: UNLINKED_ACTIONS,
  };
}

/**
 * Return a short reason code if the stored node_public_key
 * disagrees with the local node's public key. Returns null
 * when mismatch detection cannot run (missing inputs) or the
 * keys agree — both cases are treated identically: "we have
 * not found a mismatch, carry on with the normal state."
 */
function detectMismatch(
  linkStatus: "active" | "pending_confirmation" | "unlinked",
  storedKeyPem: string | null,
  localKeyPem: string | null,
): string | null {
  if (linkStatus === "unlinked") return null;
  if (!storedKeyPem || !localKeyPem) return null;
  if (normalizePem(storedKeyPem) === normalizePem(localKeyPem)) return null;
  return "node_public_key_mismatch: hosted stored key differs from local node key";
}

/**
 * Normalize a PEM block for comparison: strip whitespace +
 * lowercase. PEMs are base64 inside armor; whitespace +
 * case do not affect semantic equality.
 */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "").toLowerCase();
}
