---
name: verity-one-mcp
description: Repo-local Skill-format brief for LLM agents (Claude, Codex, any MCP client) that will consume the VO MCP local stdio server. Loads the mental model — install shapes, session loop, tool / resource / prompt selection, write safety, citation, outcome semantics, proof reminders — without duplicating the full docs.
when_to_use: About to call tools on a VO MCP server, about to read a vo:// resource, about to invoke a vo_ prompt, or about to record memory via vo_memory_write. Read the linked docs in full before changing MCP runtime behavior or the shipped surface.
authority: docs/VO-MCP-AGENT-USAGE.md is the canonical agent-behavior guide; docs/VO-MCP-SERVER-CONTRACT.md is the binding per-rung contract; docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md is the evidence matrix. This Skill is a pointer + operational brief, not a replacement.
repo_local: true
---

# VO MCP — Skill brief

VO MCP ships one MCP transport today: a **local stdio server** that
adapts the local VO HTTP node at `127.0.0.1:3100` into the MCP
protocol. The shipped surface is **25 tools, 2 static resources,
2 template resources, and 3 prompts**. It is a thin transport
adapter — no ranking, no routing, no storage.

**Load-bearing negative facts** (pin these before you act):

- `mcp.verityone.app` is not shipped. The shipped web connector for MCP
  is same-origin at `https://verityone.app/mcp`, separate from this
  local stdio Skill surface.
- The `/hosted-mcp/*` HTTP routes are **hosted portable-agent REST**:
  mirrored reads plus queue-only write intent through
  `/hosted-mcp/write` and `/hosted-mcp/commands/:id`. They are NOT
  MCP transport and not the web `/mcp` connector. `POST /mcp` is
  the web MCP connector; that connector has public queue-lifecycle tools
  (`vo_commands_get`, plus `vo_write_intent` and `vo_commands_cancel`
  gated by OAuth scope `vo.write.intent`), never direct mutation.
- Client runtime acceptance (Claude Desktop / Codex actually loading
  the installed config and calling a tool) is operator-observed,
  not automated by the proof runner.
- MCP connection controls and VO Skill controls are separate. MCP install
  does not install, invoke, or enable the Skill.

## Install shapes (both accept the same targets)

```sh
vo mcp install --client claude-desktop|codex|generic   # through the main vo CLI
vo-mcp install --client claude-desktop|codex|generic   # standalone binary
```

Both call the same library functions; picking one path over the
other is convenience only. For `codex`, the installer emits a
pasteable `[mcp_servers.verity-one]` TOML block for
`~/.codex/config.toml` to stdout — the installer does NOT write
that file itself. **The human operator must paste that block into
`~/.codex/config.toml` manually; the agent must not edit that
file.** `cursor` / `zed` are refused honestly; when `--client
generic` is used, the installer prints a JSON block **for the
operator to paste** into the client's MCP config by hand — again,
a human step, not an agent step.

**Hard boundary for you, the agent:** never write, edit, or
`cat`-append into `~/.codex/config.toml`, Claude Desktop's
config file, or anything under `~/.vo`. If an operator asks
"install MCP for me", surface the install commands above or a
descriptor-backed local dashboard action with preview / confirm /
execute, then tell the operator to run or confirm it — do not
run it yourself, and do not paste the emitted block into the
config file on their behalf. Config-file writes are the
installer's job (for `claude-desktop`), the operator's job (for
`codex` / `generic`), or a descriptor-backed local dashboard
action; they are never the agent's direct-edit job.

## Session loop — recall first, write last

1. **Ground.** Recall prior context before acting. When a project
   addr is known, invoke `vo_pretask_ground` (captures a
   `bootstrap_context` that downstream writes can ride on); when
   not, invoke `vo_memory_recall_routed` or the
   `vo_recall_context` prompt.
2. **Act.** Do the work the user asked for, with memory as a
   constraint.
3. **Remember.** Write memory for durable conclusions only, via
   `vo_memory_write`. Transient chat / status / guesses do NOT
   belong in memory.

## Tool / resource / prompt selection — a compact map

| I want to …                                  | Use                                                                        |
|---|---|
| Ground a new task with a project addr        | tool `vo_pretask_ground { goal, explicit_project_addr }`                   |
| Ground a new task without a project addr     | tool `vo_memory_recall_routed { query }` or prompt `vo_recall_context`     |
| Answer "what do we know about X"             | prompt `vo_what_do_we_know_about { subject }`                              |
| Look up one memory by known addr             | tool `vo_memory_get { addr }` OR resource `vo://memory/{addr}`             |
| See provenance / trust history of one memory | tool `vo_memory_inspect { addr }` OR resource `vo://memory/{addr}/audit`   |
| See the pending `agent_inferred` review queue | tool `vo_memory_review` OR resource `vo://memory/review/pending`          |
| Record a durable decision                    | tool `vo_memory_write` (see Write safety); or prompt `vo_remember_decision`|
| Retract a wrong memory                       | tool `vo_memory_retract { addr, reason }` (preferred over `vo_memory_forget`)|
| Patch a memory that is still directionally right | tool `vo_memory_update { addr, patch }`                                 |
| Read a vault dossier                         | tools `vo_vault_list` / `vo_vault_lookup` (filesystem — downstream of memory)|
| Run the local harvest engine on a source     | tool `vo_vault_harvest_auto { source }` (absolute path or http(s) URL only)|
| Create or dry-run a manual journal entry     | tool `vo_day_journal_entry_create { command_text: "VOJ: ...", idempotency_key, dry_run? }`; omit `idempotency_key` only with `dry_run: true` |
| Retract a manual journal entry               | tool `vo_day_journal_entry_retract { entry_key, idempotency_key, reason? }` |
| Read one local journal day                   | tool `vo_day_journal_day_get { day_addr }`                              |
| Search local journal entries                 | tool `vo_day_journal_search { start_date?, end_date?, routine_id?, domain?, tag?, sensitivity?, q? }` |
| List local journal routines/settings         | tool `vo_day_journal_routines_list`                                      |
| Preview a routine run                        | tool `vo_day_journal_routine_dry_run { routine_id, target_date?, day_addr?, config?, permission_grants? }`; runs routine code, may call external services, updates the dry-run marker, and may require operator scope |
| Run an enabled routine now                   | tool `vo_day_journal_routine_run { routine_id, idempotency_key }` or `{ routine_id, generate_idempotency_key: true }`; use routine ids from `vo_day_journal_routines_list`; non-standard sensitivity or extra-permission routines require operator scope |
| Hit the public overlay anonymously           | tools `vo_public_search` / `vo_public_context`                             |
| Promote an imported public overlay           | tool `vo_overlay_promote { overlay_addr, reason? }`                        |
| Confirm the server's own identity + counts   | resource `vo://server/status` (never exposes `VO_TOKEN`)                   |

`resources/list` advertises the static resources; use
`resources/templates/list` to discover the template ones
(`vo://memory/{addr}`, `vo://memory/{addr}/audit`). A client that
only walks `resources/list` misses the templates.

## Write safety — hard rules for `vo_memory_write`

- **Default `source: "agent_inferred"`.** An agent-authored write
  should stay agent-inferred until a human operator promotes it
  via the `vo memory approve <addr>` CLI. MCP has no approval
  tool.
- **Use `source: "user_accepted"` only when the user in the
  current turn explicitly said "save that", "remember this",
  "record this", or equivalent.** Prior-turn intent, inferred
  intent, and "the user would probably want this saved" are all
  `agent_inferred`.
- **Never call MCP with `source: "system_generated"`.** That
  value is reserved for server-side writers and will be refused.
- **Never fabricate `source_refs`.** If there is no real source
  to cite, omit the field. Plausible-looking addrs are not
  sources.
- **Never synthesize `bootstrap_context`.** Only pass through
  the value returned by a recent `vo_pretask_ground` call.
  Passing a stale or made-up context is worse than passing none.
- **Respect `supersedes` semantics.** Use it for revisions of
  live memories. Do not reuse a retracted memory's addr as
  `supersedes` — the backend rejects that.
- **Cap writes per session.** A useful agent session writes ≤ 3
  memories. More than that is journaling, not remembering.

## Citation behavior

- **Cite addrs verbatim.** `PJ.0.3.4751`, not "the memory I just
  read". Never paraphrase an addr.
- **Quote `assertion` text verbatim** when summarising a memory.
- **Distinguish the four authorities**:
  - **Tenant memory** — the graph at the local VO node. Addrs are
    `PJ.x.y.z`. Authoritative for tenant-private truth.
  - **Vault dossiers** — local markdown files under the vault
    root. Downstream of memory; use `vo_nodes_count` / frontmatter
    to know whether a dossier is graph-backed.
  - **Public overlay** — anonymous reads from `/search` /
    `/context`. Result envelope carries `authority:
    "public_overlay"`. Never mix into tenant memory without an
    explicit `vo_overlay_promote` + (later) human approval.
  - **Hosted mirror** — `/hosted-mcp/*` reads from the hosted
    portal. Read-only HTTP, NOT MCP, not a write surface.

## Outcome semantics — do not collapse into pass

Agents reading tool/resource outputs should recognise five
outcome labels, matching the interop proof matrix:

- **`pass`** — surface worked; use the result.
- **`fail`** — real failure. Read the `error_class` and decide.
- **`unsupported`** — the capability is not implemented today
  (e.g. direct web `/mcp` connector mutation). Do NOT propose a
  workaround that pretends otherwise. The web `/mcp` connector write
  surface is public queue-lifecycle write tooling (`vo_write_intent`
  and `vo_commands_cancel`; OAuth scope `vo.write.intent`); read-only
  queued-command status is `vo_commands_get`. Hosted-agent REST write
  intent is separate queue-only HTTP. Valid `vop_REDACTED*` credentials may
  authenticate either surface, but both still queue intent rather than
  applying local mutations directly.
- **`manual`** — operator-acceptance step that cannot be
  automated from this environment (GUI/TUI launch + config
  acceptance). Surface it; do not claim it happened.
- **`vo mcp-proof --local`** — local stdio proof. It reads the
  existing client-acceptance artifact and reports Claude Desktop /
  Codex GUI acceptance as `pass`, `fail`, or `manual`; it never
  records that acceptance on the operator's behalf.
- **`unproven`** — MCP protocol path works but the running API
  is older than the route under test (classic case:
  `/memory/review` returning the `/memory/:addr` catch-all
  shape). The remediation is "restart the API against current
  code", NOT "retry the MCP call". Do NOT collapse `unproven`
  into `pass`.

## Proof-command reminders

These commands are for an operator or an operator-supervised
session. None of them run in the background; none of them
mutate client config.

- **`bun run agent-lab/scripts/record-mcp-client-acceptance.ts
  --client <claude-desktop|codex> --status pass|fail …`** —
  records operator-observed client runtime acceptance into a
  gitignored artifact under
  `agent-lab/proof/vo-mcp-client-acceptance/`. The interop
  runner reads that artifact.
- **`bun run agent-lab/scripts/run-mcp-interop-proof.ts`** —
  produces the cross-client interop matrix
  (`agent-lab/proof/vo-mcp-interop/result.{json,md}`).
- **`bun run agent-lab/scripts/run-hosted-proof.ts`** — produces
  the hosted portable-agent positive-read proof. Needs
  only when the credentials are present.

## Where to read more

- **`docs/VO-MCP-ACTIVATION.md`** — operator-facing activation
  flow: install → doctor → restart → confirm → record acceptance
  → rerun the interop proof. Read this when the operator is
  setting VO MCP up for the first time.
- **`docs/VO-MCP-AGENT-USAGE.md`** — full agent usage kit (decision
  tree, handling semantics, per-client setup deltas).
- **`docs/VO-MCP-SERVER-CONTRACT.md`** — binding per-rung contract.
  When the code and the contract disagree, the contract wins.
- **`docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md`** — evidence matrix,
  artifact contracts for hosted + client-acceptance proofs, the
  five outcome labels.
- **`mcp/README.md`** — operator-facing package overview.

This Skill is a brief, not a manual. If it ever contradicts the
contract or the usage kit, the contract and the kit win.
