/**
 * Federation agent-credential state machine —
 * VO-PLUS-FEDERATION-STATE-MACHINES-PR-1.
 *
 * Typed source-of-truth for `hosted_agent_credentials.status`.
 * Hosted agent credentials (the `vop_*` bearer tokens used
 * by hosted MCP) are either `active` or `revoked`. There
 * is intentionally no `suspended` middle state on a
 * credential — rung 8's policy layer expresses per-session
 * access decisions, and an operator who wants to temporarily
 * block a credential should revoke it and mint a new one.
 */

/**
 * Mirror of the `CHECK (status IN (...))` constraint on
 * `hosted_agent_credentials.status`.
 */
export const AGENT_CREDENTIAL_STATUSES = ["active", "revoked"] as const;
export type AgentCredentialStatus = (typeof AGENT_CREDENTIAL_STATUSES)[number];

/**
 * `revoked` is terminal per-credential. The operator
 * control plane does not un-revoke; a compromised
 * credential stays revoked and a new row is issued.
 */
export const TERMINAL_AGENT_CREDENTIAL_STATUSES: ReadonlyArray<AgentCredentialStatus> = [
  "revoked",
];

export const AGENT_CREDENTIAL_TRANSITIONS: ReadonlyArray<{
  from: AgentCredentialStatus;
  to: AgentCredentialStatus;
  reason: string;
}> = [
  {
    from: "active",
    to: "revoked",
    reason: "operator revokes credential via POST /account/agents/:id/revoke",
  },
];

export function isValidAgentCredentialTransition(
  from: AgentCredentialStatus,
  to: AgentCredentialStatus,
): boolean {
  return AGENT_CREDENTIAL_TRANSITIONS.some(
    (t) => t.from === from && t.to === to,
  );
}
