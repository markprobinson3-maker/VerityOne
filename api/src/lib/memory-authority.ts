/**
 * Trust authority for memory writes — shared between the API route layer
 * (routes/memory.ts) and the writeMemory() chokepoint (lib/memory-write.ts).
 *
 * `user_accepted` is the human-vouched trust tier: it carries the
 * accepted_by_user authority, recall provenance weight 1.0, dormancy
 * protection, AND the quality-gate bypass. Agents never mint it — on any
 * surface. Promotion to user_accepted is human/operator-only via
 * approveMemory() (CLI `vo memory approve`, dashboard review, operator API).
 */
import type { SourceKind } from "./memory-contract";

/**
 * The effective source_kind for a write, given the caller. Agent/API callers
 * (agentId set) cannot self-declare user_accepted — coerce to honest
 * agent_inferred. Operator/server callers (agentId null) pass through.
 */
export function effectiveAgentWriteSource(
  source: SourceKind,
  agentId: string | null,
): SourceKind {
  if (agentId && source === "user_accepted") return "agent_inferred";
  return source;
}
