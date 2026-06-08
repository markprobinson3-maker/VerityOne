# VO MCP — Agent Usage Kit

> **Originating PR:** `VO-MCP-AGENT-USAGE-SKILL-PR-1` introduced this
> markdown guide. A matching repo-local Skill-format artifact ships
> separately in `VO-MCP-SKILL-PACKAGING-PR-1` at
> [`mcp/skills/verity-one-mcp/SKILL.md`](../mcp/skills/verity-one-mcp/SKILL.md)
> and points back here for depth. The `-SKILL-` fragment in the
> originating PR tag refers to the guide's intent, not to a Skill
> artifact shipped in that PR.
> **Audience:** LLM agents (Claude, Codex, any other MCP client) that will
> consume the local vo-mcp stdio server after `vo mcp install` or
> `vo-mcp install`.
> **Scope:** how to use the shipped surface *well*. This doc adds zero
> runtime capability; it teaches the mental model that matches
> `docs/VO-MCP-SERVER-CONTRACT.md`.

## 30-second orientation

VO MCP is a **local stdio** server that adapts the local VO HTTP node
on `127.0.0.1:3100` into the MCP protocol. It ships **25 tools,
2 static resources, 2 template resources, and 3 prompts**. It is a
thin transport adapter — no ranking, no routing, no storage.

**You can use it via any MCP client that speaks stdio.** Two tested
install paths exist today — both accept the same supported targets:

- `vo mcp install --client claude-desktop|codex|generic` (preferred,
  through the main `vo` CLI)
- `vo-mcp install --client claude-desktop|codex|generic` (standalone
  binary)

Both call the same library functions — picking one path vs. the
other is a convenience choice, not a capability choice. `codex`
emits a pasteable `[mcp_servers.verity-one]` TOML block for
`~/.codex/config.toml` to stdout — the installer does NOT write
that file itself. **The human operator must paste that block into
`~/.codex/config.toml` manually; the agent must not edit that
file.** `cursor` and `zed` are refused honestly; when `--client
generic` is used, the installer prints a JSON block **for the
operator to paste** into the client's MCP config by hand — again,
a human step, not an agent step.

For proof, the tenant-facing command is `vo mcp-proof --local`. It runs the
real local stdio MCP protocol through the shared interop runner, writes the
rollup artifact under `agent-lab/proof/vo-local-mcp/`, and summarizes existing
Claude Desktop / Codex runtime acceptance without recording GUI acceptance on
the operator's behalf.

**What VO MCP is not:**

- Not a generic remote MCP transport. `mcp.verityone.app` does
  not exist today.
- Not a direct-mutation web MCP. The shipped web connector
  lives at `POST /mcp` and exposes mirrored read/status/review tools
  including read-only command polling (`vo_commands_get`), plus
  public queue-lifecycle write tools (`vo_write_intent` and
  `vo_commands_cancel`). The OAuth scope is named `vo.write.intent`;
  that dotted scope string is not the public tool name shown by
  `tools/list`.
- Not the same thing as `/hosted-mcp/*`. The `/hosted-mcp/*`
  routes are **hosted portable-agent REST** — authenticated with
  `vop_*` credentials, serving mirrored reads plus queue-only write
  intent from the hosted account. They are not MCP transport. They
  are a separate surface; they are not remote MCP and they are
  separate from the connector `vo_write_intent` queue tool.
- MCP connection setup and VO Skill activation are separate controls. MCP
  install does not install, invoke, or enable the Skill.
- Descriptor-backed local dashboard actions are the only automated config
  mutation path agents may point operators at; otherwise config writes stay
  operator-owned commands or manual paste steps.

If you are writing tooling that treats any of the four bullets above
as currently-shipped, stop. The shipped MCP surfaces are the local
stdio server and the web connector with mirrored read/status/review
tools, read-only queued-command polling, and two public queue-lifecycle
write tools.

## Session flow — recall first, write last

Every session that touches tenant memory should run the same loop:

1. **Ground.** Recall prior context before acting.
2. **Act.** Do the work the user asked for, with memory as a
   constraint.
3. **Remember.** Write memory for durable conclusions only — never
   for transient chat or incomplete decisions.

Skipping step 1 is the single most common agent failure mode. The
prompts in section "Prompt selection" below encode this discipline;
prefer invoking them over hand-rolling recall logic.

## Tool selection — a small decision tree

```
You are about to start a task
 └─> do you already have a project addr (PJ.x.y.z)?
      ├─ yes → vo_pretask_ground { goal, explicit_project_addr }
      │        (capture the returned bootstrap_context for later writes)
      └─ no  → vo_memory_recall_routed { query }
               (use vo_memory_search if you need a literal-string hit)

You need to look up one specific memory by its addr
 └─> vo_memory_get { addr }  OR  read resource vo://memory/{addr}

You need the trust/provenance/audit history of one memory
 └─> vo_memory_inspect { addr }  OR  read resource vo://memory/{addr}/audit

You need to see the pending agent-inferred review queue
 └─> vo_memory_review            OR  read resource vo://memory/review/pending
     (the /memory/review HTTP route may not be mounted on older running
      APIs; treat the `unproven` outcome honestly — see "Handling
      honest-failure outcomes" below)

You reached a durable decision / preference / correction / context /
 pattern that future you would regret losing
 └─> vo_memory_write { kind, assertion, source, why_it_matters, ... }
     (read "Write safety" before you call this)

You wrote a memory earlier this session and it turned out wrong
 └─> vo_memory_retract { addr, reason }   (preferred — preserves audit)
     vo_memory_forget  { addr }           (archive without reason, rare)

You patched / corrected a memory that is still directionally right
 └─> vo_memory_update { addr, patch }    (small field edits only; for
                                            material changes, retract +
                                            write a new memory)

You want VAULT dossiers (filesystem, not graph authority)
 └─> vo_vault_list / vo_vault_lookup
     (dossiers are downstream of the memory authority — a dossier can
      exist with an empty vo_nodes list; check vo_nodes_count)

You want PUBLIC-graph results (anonymous, no tenant token)
 └─> vo_public_search / vo_public_context
     (envelope carries top-level authority: "public_overlay" —
      never silently mix into tenant memory)

You want to promote an imported public overlay to a tenant memory
 └─> vo_overlay_promote { overlay_addr, reason? }
     (result is agent_inferred; human trust upgrade is the separate
      `vo memory approve` CLI path, not part of MCP)

You want to run the local harvest engine on a source file or URL
 └─> vo_vault_harvest_auto { source }
     (absolute path or http(s) URL only — relative paths are refused)

You want to create or dry-run today's manual journal entry
 └─> vo_day_journal_entry_create { command_text: "VOJ: ...", idempotency_key?, dry_run? }
     (local stdio only; explicit VOJ required; non-dry-run requires idempotency_key)

You want to retract a manual VOJ journal entry
 └─> vo_day_journal_entry_retract { entry_key, idempotency_key, reason? }
     (local stdio only; preserves audit metadata and syncs a tombstone)

You want to read or search the local day journal
 └─> vo_day_journal_day_get { day_addr }
     vo_day_journal_search { start_date?, end_date?, routine_id?, tag?, q? }
     (local authority; hosted/web agents use mirrored journal reads)

You want to inspect or run local day-journal routines
 └─> vo_day_journal_routines_list {}
     vo_day_journal_routine_dry_run { routine_id, target_date?, permission_grants? }
     vo_day_journal_routine_run { routine_id, idempotency_key | generate_idempotency_key }
     (backend enforces enablement, permission, and idempotency rules)

Day-journal market routine entries, including `market.spy_qqq_close`,
are `routine_class: "context_only"`. Treat them as historical context,
not trading instructions; they must never be the sole basis for a
buy/sell/hold, allocation, or similar financial action.
```

## Resource selection

Resources let an MCP client pull VO state as **context** without making
a tool call. Every resource handler is read-only.

### Static resources (`resources/list`)

- **`vo://server/status`** — pure-local snapshot: package version,
  local VO base URL, `auth_source` class (never a token value), and
  counts of registered tools, resources, and prompts. Use this to
  confirm you are talking to the right vo-mcp before doing anything
  side-effecting.
- **`vo://memory/review/pending`** — wraps
  `GET /memory/review?limit=20`. Gives you the pending
  `agent_inferred` review queue as context. If the handler raises a
  `route_unavailable` error, the running API has not mounted
  `/memory/review` — classify that honestly as unproven, not as
  "empty queue".

### Template resources (`resources/templates/list`)

These require a concrete `PJ.x.y.z` addr. Agents discover addrs via
`vo_memory_search`, `vo_memory_recall_routed`, or the
`vo://memory/review/pending` static resource — the resource layer
itself never ranks or searches.

- **`vo://memory/{addr}`** — wraps `GET /memory/:addr`. Equivalent
  to `vo_memory_get` as context.
- **`vo://memory/{addr}/audit`** — wraps `GET /memory/:addr/audit`.
  Provenance, trust state, promotion linkage, recent lifecycle
  events. Equivalent to `vo_memory_inspect` as context.

A client that only walks `resources/list` will miss the template
advertisements. Always walk both `resources/list` and
`resources/templates/list` at session start if you want the full
picture of what context this server can produce.

## Prompt selection

The server ships 3 prompts. Prompts are **pure string producers** —
they never call a tool on your behalf, never touch VO, never mutate
state. They emit one `role: "user"` message with guidance text that
keeps you on the rails the tools already defend.

- **`vo_recall_context { query, project_addr? }`** — at task start.
  Routes between `vo_pretask_ground` (when `project_addr` is set)
  and `vo_memory_recall_routed`. Enforces: cite addrs verbatim,
  never fabricate memory content, never write from the prompt
  itself.
- **`vo_what_do_we_know_about { subject }`** — subject/entity
  recall. Orchestrates `vo_memory_search` + `vo_memory_recall_routed`
  and de-duplicates by addr.
- **`vo_remember_decision { decision, rationale, subject?, project? }`**
  — write-safety guidance for `vo_memory_write`. Defaults
  `source: agent_inferred`, forbids fabricated `source_refs`, uses
  `supersedes` for revisions, threads a fresh `bootstrap_context`
  when `project` is set.

Prefer invoking a prompt over hand-rolling its workflow. The prompt
text is reviewed and kept in sync with the tool contract; a
hand-rolled version drifts.

## Write safety — when NOT to write memory

`vo_memory_write` has rules. Break any of them and the write is
lying. The `vo_remember_decision` prompt encodes these, but you
need them one level up too:

- **Only write durable conclusions.** Acceptable kinds: `decision`,
  `preference`, `correction`, `context`, `pattern`. Also:
  `vision`, `changelog`, `digest`. Inacceptable: transient chat
  state, speculative half-thoughts, status updates, re-statements
  of the current code.
- **Default `source: "agent_inferred"`.** Only use `"user_accepted"`
  when the user *in the current turn* explicitly said "save that"
  or equivalent. "Save that next time" is not explicit intent.
- **Never fabricate `source_refs`.** If there is no real source to
  cite, omit the field. Never pattern-match a plausible-looking
  addr; the backend rejects those.
- **Use `supersedes` for revisions, not for contradicting
  retracted memory.** If a memory is retracted and the new memory
  would contradict it, write a fresh memory — do not reuse the
  retracted addr as `supersedes`.
- **Never auto-derive `project_addr`, `bootstrap_context`,
  `why_it_matters`, or `subject` from thin context.** If you did
  not just call `vo_pretask_ground`, do NOT attach a stale
  `bootstrap_context`.
- **Never upgrade `source` kind without explicit user intent.** An
  `agent_inferred` memory stays `agent_inferred` until a human
  operator promotes it via the `vo memory approve` CLI — MCP has
  no approval tool for a reason.
- **Cap yourself.** A useful session writes ≤ 3 memories. If you
  catch yourself writing more, you are journaling, not
  remembering.

## Citing memory addrs

Every memory in VO has an addr of shape `PJ.<major>.<minor>.<patch>`
(e.g. `PJ.0.3.4751`). When you reference a memory in chat, in a
diff, or in another memory:

- **Quote the addr verbatim.** `PJ.0.3.4751`, not "the memory I
  read earlier" and not a paraphrased addr.
- **Quote the `assertion` field verbatim** when summarising a
  memory; do not rewrite it.
- **When two memories agree, cite both.** Do not merge their
  content into one paraphrase.
- **When a cited memory has been retracted, say so.** Read the
  audit resource (`vo://memory/{addr}/audit`) to confirm state
  before treating a memory as current.

## Handling honest-failure outcomes

The interop proof runner classifies every cell as `pass`, `fail`,
`unsupported`, `manual`, or `unproven`. The same honesty applies to
how you as an agent should read tool/resource outputs:

- **`pass`** — the tool succeeded. Use the result.
- **`fail`** — a real failure. Do not retry with identical input;
  read the error envelope and decide whether to retry, adjust, or
  stop. The four `error_class` values (`local_vo_unreachable`,
  `tenant_auth_failure`, `validation_failure`, `upstream_error`)
  tell you which one it is.
- **`unsupported`** — the capability structurally does not exist.
  Direct web MCP connector mutation is `unsupported`; the connector
  write surface is the public queue-lifecycle `vo_write_intent` and
  `vo_commands_cancel` tool pair. Queued-command status is read-only
  through `vo_commands_get`. Hosted-agent REST write intent exists
  through `/hosted-mcp/write`, queues a remote command, and must not be
  described as direct mutation.
- **`manual`** — acceptance lives outside this environment (e.g.
  Claude Desktop GUI accepting a config file). Surface the manual
  step; do not pretend it happened.
- **`unproven`** — the MCP path works, but the local running API
  is older than the code that added the route. The classic case
  is `/memory/review` returning `validation_failure` +
  `"memory not found"` from the `/memory/:addr` catch-all. **Do
  not report an `unproven` cell as `pass`.** The fix is "restart
  the API against current code", not "retry the MCP call".

If your agent framework reduces everything to pass/fail, map
`unproven` to a soft-fail that does NOT block the rest of the
session but also does NOT claim the surface worked.

## Activation wayfinding

If you (or the operator supervising you) still need to go from
"installed" to "confirmed live and recorded in the interop
matrix", follow
[`docs/VO-MCP-ACTIVATION.md`](./VO-MCP-ACTIVATION.md). It is
the short operator-facing flow: install → client-config doctor
→ live stdio doctor → restart → confirm one tool/resource →
record runtime acceptance with
`agent-lab/scripts/record-mcp-client-acceptance.ts` → rerun the
interop proof. Every operator paste / edit step in that flow is explicitly
scoped to a human operator, never to the agent. Runtime acceptance
is operator-observed and cannot be automated from the repo.

## Client-specific notes (only where they differ)

### Claude Desktop

- Install via `vo mcp install --client claude-desktop` (or the
  standalone `vo-mcp install --client claude-desktop`). The
  installer edits
  `~/Library/Application Support/Claude/claude_desktop_config.json`
  on macOS and the equivalent path on other OSes.
- Restart Claude Desktop after install. The config is read only at
  launch.
- Run `vo-mcp doctor --client claude-desktop` for a read-only
  check of the on-disk config (paths absolute, server file exists,
  `VO_URL` set, `VO_TOKEN` correctly absent). `vo mcp doctor
  --client claude-desktop` does the same thing via the wrapper.
- Claude Desktop reads its stderr silently; if a tool call fails
  mysteriously, run `vo-mcp doctor` in a terminal to see the
  structured log lines.

### Codex

- Install via `vo-mcp install --client codex` (or `vo mcp install
  --client codex`). The installer prints a pasteable
  `[mcp_servers.verity-one]` TOML block to stdout. **The human
  operator — not the agent — must copy that block into
  `~/.codex/config.toml` manually.** The installer does not
  write that file. If the operator wants the shipped automated
  path, direct them to the local dashboard's `mcp_onboard_codex`
  action, which performs the parser-backed merge behind an
  explicit preview / confirm / execute flow. The agent must
  never hand-edit `~/.codex/config.toml` on the operator's
  behalf. If an operator asks the agent to "install MCP for me",
  surface the CLI command or dashboard action and keep the final
  write under operator confirmation.
- After the operator pastes via the CLI workflow or confirms the
  dashboard merge, Codex must be restarted (also an operator step
  — the agent cannot restart Codex). Codex reads its config at
  launch.
- Run `vo-mcp doctor --client codex` for a read-only check of
  the `~/.codex/config.toml` `[mcp_servers.verity-one]`
  section. Same checks as the Claude Desktop variant.

### Any other MCP client (generic)

- Install via `vo-mcp install --client generic`. The installer
  prints the full JSON block the client's MCP config expects.
  **The operator pastes that block into the client's MCP
  config by hand; the agent must not edit the client's config
  file.** As with Codex, if asked to install, surface the
  command and the block and let the operator handle the paste
  plus the client restart.
- The server behaves identically regardless of client; any
  difference you observe is client-side stdio handling, not a VO
  MCP behavior delta.

## Explicitly not in this PR

The original documentation PR added agent-facing docs and drift guards.
It did not add runtime behavior. Current runtime behavior is described
above.

- `mcp.verityone.app` is not shipped; the only web connector is the
  `/mcp` adapter with mirrored read/status/review tools, read-only
  queued-command polling (`vo_commands_get`), and public queue-lifecycle
  write tools (`vo_write_intent` and `vo_commands_cancel`).
- MCP elicitation, tasks, triggers, or apps.
- A broad rewrite of `MEMORY-CLIENT-PATTERNS.md` or other legacy
  client docs. Those remain historical; this kit is the current
  authority for rung-8 agent usage.

For the per-rung contract, see
`docs/VO-MCP-SERVER-CONTRACT.md`. For the cross-client proof
matrix, see `docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md`. For the
package-level overview, see `mcp/README.md`.
