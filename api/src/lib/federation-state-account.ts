/**
 * Federation account + link state machines —
 * VO-PLUS-FEDERATION-STATE-MACHINES-PR-1.
 *
 * Typed source-of-truth for the two account-level state
 * surfaces the VO+ federation pipeline tracks:
 *
 *   - `hosted_accounts.status`: the account identity is
 *     `active` or `suspended`. Suspension is a break-glass
 *     for compromised / abuse-flagged accounts.
 *
 *   - `account_tenant_links.status`: the bond between an
 *     account and a tenant is `active`, `pending_confirmation`
 *     (awaiting operator approval), or `unlinked` (archived).
 *
 * Both enums mirror their SQL CHECK constraint exactly; a
 * companion drift test reads the SQL and fails CI on any
 * divergence. Any migration that broadens a state set has
 * to update this module first.
 *
 * Transitions express the operator's control-plane model,
 * not every theoretical SQL UPDATE. A state pair not listed
 * in the transition table is a bug: either the table is
 * wrong or the handler is doing something the model does
 * not capture.
 */

/**
 * Mirror of the `CHECK (status IN (...))` constraint on
 * `hosted_accounts.status`.
 */
export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Valid account status transitions. An entry `{from, to}`
 * says "the control plane may move the account from `from`
 * to `to`." No implicit self-loops; no implicit terminal
 * gates beyond what the table encodes.
 */
export const ACCOUNT_STATUS_TRANSITIONS: ReadonlyArray<{
  from: AccountStatus;
  to: AccountStatus;
  reason: string;
}> = [
  {
    from: "active",
    to: "suspended",
    reason: "break-glass suspension on compromise / abuse",
  },
  {
    from: "suspended",
    to: "active",
    reason: "explicit operator unsuspend after remediation",
  },
];

/**
 * Mirror of the `CHECK (status IN (...))` constraint on
 * `account_tenant_links.status`.
 */
export const LINK_STATUSES = [
  "active",
  "pending_confirmation",
  "unlinked",
] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/**
 * Terminal link statuses — reaching these means the row is
 * archived and any future link uses a fresh row. `unlinked`
 * is terminal by design; we never resurrect it in place.
 */
export const TERMINAL_LINK_STATUSES: ReadonlyArray<LinkStatus> = ["unlinked"];

/**
 * Valid link status transitions.
 *
 * First-link flow: a link row is inserted either directly
 * as `active` (self-service additional node bind, same
 * account) or as `pending_confirmation` (first time an
 * account claims a tenant). The operator-approval
 * endpoint moves `pending_confirmation` → `active`.
 * Unlink moves `active` → `unlinked`; further unlinks from
 * `pending_confirmation` or re-unlinks from `unlinked` are
 * not modeled here — they would indicate a handler bug.
 */
export const LINK_STATUS_TRANSITIONS: ReadonlyArray<{
  from: LinkStatus;
  to: LinkStatus;
  reason: string;
}> = [
  {
    from: "pending_confirmation",
    to: "active",
    reason: "operator approves link via POST /account/link/approve",
  },
  {
    from: "pending_confirmation",
    to: "unlinked",
    reason: "operator rejects or cancels pending link",
  },
  {
    from: "active",
    to: "unlinked",
    reason: "POST /account/unlink archives the link row",
  },
];

/**
 * Return true if the candidate transition is valid per
 * this module's transition table. Handlers can use this
 * as a pre-UPDATE guard to refuse illegal moves.
 */
export function isValidAccountStatusTransition(
  from: AccountStatus,
  to: AccountStatus,
): boolean {
  return ACCOUNT_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function isValidLinkStatusTransition(
  from: LinkStatus,
  to: LinkStatus,
): boolean {
  return LINK_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
