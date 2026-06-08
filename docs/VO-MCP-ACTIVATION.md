# VO MCP — Activation Wayfinding

> **Scope:** one practical doc for operators (and for agents
> running under operator supervision) that answers "what do I
> run, in what order, and what does each proof mean?" to take
> the shipped VO MCP from installed to confirmed-live.
>
> **Non-scope:** architecture, per-rung contract, decision tree,
> tool/resource/prompt selection. Those live elsewhere (see the
> links at the bottom).

## Current truth (pin these before you act)

- **VO MCP's local action surface is local stdio only.** The
  separate web connector lives at `POST /mcp`, uses OAuth as the
  primary auth path with `vop_*` bearer fallback, and exposes nine
  read/status/review tools, including read-only `vo_commands_get`
  polling, plus public queue-lifecycle write tools (`vo_write_intent`
  and `vo_commands_cancel`; OAuth scope `vo.write.intent`).
- **`mcp.verityone.app` is not shipped.** There is no generic
  network-reachable VO MCP host.
- **`/hosted-mcp/*` is hosted portable-agent REST (hosted portable-agent HTTP), not MCP.**
  It includes read routes plus queue-only write intent. It is not the
  web MCP connector and it does not apply local mutations directly.
- **The repo-local Skill (`mcp/skills/verity-one-mcp/SKILL.md`)
  is guidance content, not an MCP runtime component.** The
  dashboard ships explicit opt-in install / disable / rollback
  buttons for Codex and Claude Desktop, but `vo mcp install`,
  `vo mcp onboard`, and the MCP server itself do NOT silently
  install, invoke, or call the Skill. MCP works without the
  Skill; the Skill is a short-form brief an agent can read when
  it has access to the repo.
- **MCP connection controls and VO Skill controls are separate.**
  MCP install does not install, invoke, or enable the Skill; Skill
  activation requires its own explicit opt-in.
- **Agents must not write, edit, or paste into
  `~/.codex/config.toml`, Claude Desktop's config, or
  anything under `~/.vo`.** Those writes are the installer's
  job (for `claude-desktop`) or the human operator's job (for
  `codex` and `generic`).

## Shortest path — `vo mcp onboard`

If you just want the memorable one-liner, this is it:

```sh
vo mcp onboard --client claude-desktop   # or codex / generic
```

The CLI `vo mcp onboard` path runs build → install → (config
doctor, where honest) → live doctor in sequence, then prints the
remaining operator-owned steps — the Codex TOML paste for CLI
workflows, the Claude Desktop restart, the acceptance recorder
command, and the interop-proof command — as plain text that the
operator runs. It is deliberately narrow:

- **Does not** write `~/.codex/config.toml` itself — the CLI
  Codex path still prints TOML for the operator to paste. The
  separate local dashboard action `mcp_onboard_codex` owns the
  parser-backed automated merge.
- **Does not** auto-run the acceptance recorder; acceptance is
  GUI work and the operator owns it.
- **Does not** claim "fully activated" — Claude Desktop still
  needs an operator-driven restart; CLI Codex / generic flows
  still require operator-owned config paste unless the operator
  uses the separate Codex dashboard action. The command surfaces
  those as remaining operator-scoped steps.
- Exit 0 when the checkable steps pass, including `manual_required`
  tails for Codex / generic. Exit 1 only if build, install, or
  live-doctor hard-fails.

### Rerun / repair flags

- **Default rebuilds every run.** Onboard runs `bun install --cwd
  mcp && bun run --cwd mcp build` unconditionally so a
  managed checkout that just ran `vo update` or switched
  branches never copies stale `mcp/dist` into `~/.vo/mcp`.
  Existence of `mcp/dist/server.js` is not treated as a
  freshness signal.
- **`--skip-build`** opts out of the rebuild. Use it only when
  you know the current build is fresh (e.g. you just ran the
  `bun` commands by hand and want to re-exercise install +
  doctor without the ~30s rebuild round trip).
- **`--force`** passes through to the install step. Required
  when Claude Desktop already has an `mcpServers.verity-one`
  entry and you want onboard to overwrite it. The install
  library refuses a silent overwrite; if it does, onboard
  reprints the retry command in the onboard shape:
  ```sh
  vo mcp onboard --client claude-desktop --force
  ```
  `--force` is a no-op for Codex and generic (those print
  TOML/JSON and never touch existing client config).

`vo mcp onboard` is additive. The 8-step flow below still runs
each stage by hand when you want that — onboard wraps the first
few, and the remaining steps remain exactly the same.

## Activation flow — 8 steps

Run these in order. Each step is cheap and idempotent unless
called out.

### 1. Install

Either path works; both call the same library functions.

```sh
vo mcp install --client claude-desktop|codex|generic   # through the main vo CLI
vo-mcp install --client claude-desktop|codex|generic   # standalone binary
```

- `--client claude-desktop` — the installer merges a
  `mcpServers.verity-one` entry into the tenant's Claude
  Desktop config file. This is the only client where the
  installer writes config automatically.
- `--client codex` — the installer prints a pasteable
  `[mcp_servers.verity-one]` TOML block to stdout. **The
  CLI installer does NOT write that file.** The operator either
  pastes that block into `~/.codex/config.toml` manually or uses
  the local dashboard's `mcp_onboard_codex` action for the
  preview-confirmed automated merge.
- `--client generic` — the installer prints a JSON block for
  the operator to paste into any other MCP client's config
  by hand.
- `cursor` and `zed` are refused honestly; use `--client
  generic` until a later rung adds them.

### 2. For CLI Codex / generic: operator pastes config

For CLI/manual flows, the operator (not the agent) copies the
emitted block into the target client's config file. Codex also
has a shipped local dashboard action (`mcp_onboard_codex`) for
the automated merge; generic hosts stay manual. An agent asked
"install MCP for me" should surface the install command or
dashboard action, then keep the final write under operator
confirmation.

### 3. Run the client-config doctor

Read-only validation of what is currently on disk. No
subprocess spawn; no MCP handshake. Just "does the config
file exist, does it carry a `verity-one` entry, are the paths
absolute and real, is `VO_URL` set, is `VO_TOKEN` correctly
absent".

```sh
vo-mcp doctor --client claude-desktop
vo-mcp doctor --client codex
```

Exits 0 if the client config is shaped correctly. Never
mutates the file.

### 4. Run the live MCP doctor

Spawns the installed `~/.vo/mcp/dist/server.js` under Node and
runs the 4-step handshake (`initialize`, `notifications/
initialized`, `tools/list`, `tools/call vo_memory_recall`).

```sh
vo-mcp doctor
```

Exits 0 if the stdio MCP protocol works end-to-end against
the local VO HTTP node at `127.0.0.1:3100`.

### 5. Restart the client

Every MCP client reads its config at launch. Quit and
relaunch Claude Desktop (or restart Codex) so the new config
takes effect.

### 6. Confirm the server appears

In the real client's UI:

- Confirm a `verity-one` (or equivalent) MCP server is
  listed / connected.
- Call one VO tool (`vo_memory_recall`) OR read one VO
  resource (`vo://server/status`) OR invoke one VO prompt
  (`vo_recall_context`). Any one success is enough.

This step is GUI / TUI-only. No repo command can automate
it; that is what step 7 records.

### 7. Record runtime acceptance

The operator writes a small, gitignored artifact describing
what they just observed.

```sh
bun run agent-lab/scripts/record-mcp-client-acceptance.ts \
  --client claude-desktop \
  --status pass \
  --observed vo_memory_recall \
  --summary 'restarted Claude Desktop, vo-mcp server appeared, called recall' \
  --result  'returned 2 memories, addrs cited verbatim' \
  --config-doctor-ran \
  --live-doctor-ran
```

Repeat with `--client codex` if both clients are in scope.
The recorder refuses bearer-shaped inputs, never mutates any
client config, and writes only under
`agent-lab/proof/vo-mcp-client-acceptance/` (gitignored).

### 8. Rerun the interop proof

The interop runner reads the acceptance artifact from step 7
and rolls it into the cross-client matrix.

```sh
bun run agent-lab/scripts/run-mcp-interop-proof.ts
```

`vo mcp-proof --local` reads the same acceptance artifact and includes a
Claude Desktop / Codex acceptance summary in its local proof artifact. It does
not write the acceptance artifact or run this recorder; missing GUI acceptance
therefore remains `manual`, not `fail`.

The two client runtime-acceptance cells flip from `manual`
to `pass` (or `fail`) based on what was recorded.

## What each proof actually proves

Four distinct evidence types live in this activation flow.
They are not interchangeable.

| Step | Command                                           | What it proves                                                               |
|------|---------------------------------------------------|------------------------------------------------------------------------------|
| 3    | `vo-mcp doctor --client <name>`                   | **On-disk config preconditions.** File present, entry present, paths absolute and existing, `VO_URL` set, `VO_TOKEN` absent. No subprocess spawned. |
| 4    | `vo-mcp doctor`                                   | **MCP server handshake.** The installed `server.js` spawns under Node, speaks stdio JSON-RPC, runs `tools/list`, and round-trips a `tools/call vo_memory_recall`. |
| 7    | `record-mcp-client-acceptance.ts`                 | **Operator-observed client runtime acceptance.** A human restarted the real client, saw the VO MCP server appear, and called one tool/resource/prompt. Cannot be automated from the repo. |
| 8    | `run-mcp-interop-proof.ts`                        | **Cross-client matrix rollup.** Combines install config shape (Axis A), stdio protocol (Axis B), hosted portable-agent HTTP (Axis C), the step-7 artifact (Axis D), and the scratch-HOME Skill lifecycle proof (Axis E) into one evidence matrix at `agent-lab/proof/vo-mcp-interop/result.{json,md}`. |

## The Skill — how to use it

The file `mcp/skills/verity-one-mcp/SKILL.md` is a short-form
brief for LLM agents that will consume the VO MCP surface. It
teaches install shapes, session loop, tool / resource /
prompt selection, write safety, citation, and outcome
semantics — all in about 200 lines.

**Hard truths about the Skill:**

- It is repo-local. Reading it requires repo access.
- It is NOT auto-installed into Codex, Claude Desktop, or
  any other AgentSkills-aware client. No PR has shipped a
  Skill-marketplace publisher. The shipped dashboard buttons
  are explicit operator-confirmed install / disable / rollback
  actions, not silent auto-install.
- It is NOT invoked or called by the MCP server. The MCP
  server emits tools, resources, and prompts; Skills are
  a separate concept the MCP server does not know about.
- MCP works fully without the Skill.

**How an agent should use it:**

- When working in this repo, read the Skill at session start
  (especially before memory writes).
- When working outside this repo, fall back to the full
  `docs/VO-MCP-AGENT-USAGE.md` if available, or the MCP
  prompt `vo_recall_context` for in-protocol guidance.

## If you forget everything, run this

```sh
# 1. Verify what's on disk
vo-mcp doctor --client claude-desktop     # or --client codex

# 2. Verify stdio protocol works
vo-mcp doctor

# 3. Open the real client and confirm one tool call succeeds
#    (manual; no repo command)

# 4. Record what you saw
bun run agent-lab/scripts/record-mcp-client-acceptance.ts \
  --client <claude-desktop|codex> --status pass ...

# 5. Roll it up
bun run agent-lab/scripts/run-mcp-interop-proof.ts
```

If step 1 fails, re-run the install. If step 2 fails, check
`~/.vo/config.json` and rebuild `mcp/`. If step 3 fails in
the client UI, the recorder at step 4 should report `fail`,
not `pass`.

## Boundaries this flow preserves

- **No background jobs.** Nothing in this flow schedules,
  polls, or fires work on a timer. Every command is
  invoked explicitly by the operator.
- **No acceptance artifact without the recorder.** The
  gitignored artifact under
  `agent-lab/proof/vo-mcp-client-acceptance/` only exists
  when the operator ran the recorder. An absent artifact
  keeps the Axis D cells `manual` by design.
- **No config mutation except the documented installer
  behavior.** The Claude Desktop installer merges a
  `mcpServers.verity-one` entry into the tenant's Claude
  Desktop config; that is the one place this flow writes
  client config. Codex and generic never see an automatic
  write.
- **Agents never paste into `~/.codex`, Claude config, or
  `~/.vo`.** Every paste/edit step is scoped to a human
  operator, either in this doc or in the Skill's "Hard
  boundary" section. If an agent is asked to install, it
  surfaces the commands, the operator-owned command path, or the
  descriptor-backed local dashboard action with preview / confirm
  / execute, then leaves the final write under operator
  confirmation.

## Related docs

- **`docs/VO-MCP-STANDARDIZATION-PROOF-PR-LADDER.md`** —
  cross-document proof ladder for keeping MCP status language,
  action-runner authority, Skill/MCP separation, local-vs-hosted
  transport wording, and vault boundaries consistent. This ladder
  does not replace `vo mcp-proof --local`; it standardizes the
  surrounding operator story without adding remote/web MCP claims
  or new local mutation authority.
- **`docs/VO-HOSTED-WEB-MCP-BOUNDARY-PROOF-PR-LADDER.md`** —
  follow-on proof ladder for the hosted/web MCP boundary debt left
  explicit by standardization closure: `/hosted-mcp/*` as hosted
  portable-agent REST, hosted/serverless `POST /mcp` as the web MCP
  connector, `mcp.verityone.app` as not shipped, `/my` outside local
  action-runner authority, and vault authority unchanged.
- **`docs/VO-HOSTED-WEB-MCP-IMPLEMENTATION-READINESS-PR-LADDER.md`** —
  follow-on implementation-readiness ladder for the future hosted/web MCP
  shipping path. It does not ship `mcp.verityone.app`; it pins the DNS, TLS,
  protected-resource metadata, OAuth audience, connector runtime,
  queue-only write-intent, local-action negative, vault negative, redaction,
  and sibling-ladder gates. Until those gates pass, no hosted/web MCP
  availability claim is shipped.
- **`docs/VO-HOSTED-WEB-MCP-SHIPPING-PR-LADDER.md`** —
  implementation ladder that begins the actual hosted/web MCP shipping track.
  Slice 10 closure attestation landed: the tenant-facing rollup reports `pass`
  across all twelve Shipped Claim Gate cells and the live-protocol cell reports
  `protocol_status: "passed_with_acceptance"` against an operator-recorded
  `claude-ai-web` run on `https://verityone.app/mcp`.
  It ships no `mcp.verityone.app` availability claim or continuous-availability
  claim, direct hosted mutation, local action authority, or vault authority, and
  remains Partial Coverage because `mcp.verityone.app` is not shipped and
  `availability_claim` remains `not_claimed`.
- **`docs/VO-MCP-SKILL-INSTALL-CONTROLS-DESIGN.md`** — binding
  design for separating MCP-connection controls from VO Skill
  controls, status-state model, dashboard / local boundary,
  and safe install / uninstall semantics. Current per-client
  state of the tenant-facing buttons:
    - **MCP-connection** — read-only doctors, Claude Desktop
      install / force / rollback, and the two acceptance
      recorders ship today.
    - **Codex VO Skill** — install / disable / rollback ship
      today under `control_scope: "vo_skill"` via
      `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`; rung 10 also ships
      `skill_doctor_codex`, so the row can show filesystem
      states. `enabled` remains gated on Skill-specific
      operator attestation.
    - **Claude Desktop VO Skill** — target-path SHIPPED under
      a VO-provisional darwin pin in
      `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`; actions SHIPPED
      in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`
      (`skill_install_claude_desktop` /
      `skill_disable_claude_desktop` /
      `skill_rollback_claude_desktop` — byte-for-byte
      mirrors of the Codex Skill strategy posture).
    - **Generic VO Skill** — permanently `unsupported`.
  Read this design before any future PR adds a new dashboard
  control, changes the shipped Skill checker, or moves the
  status model.
- **`docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md`** — authoritative
  contract for the local `/dashboard` action runner. **Runtime
  runner exists today** (read-only doctors; Claude Desktop MCP
  file_mutation install / force / rollback; Codex MCP
  file_mutation install / force / rollback under
  `control_scope: "mcp_connection"` via
  `VO-MCP-CODEX-INSTALL-ACTION-PR-1` — merges
  `[mcp_servers.verity-one]` into `~/.codex/config.toml`; Codex
  VO Skill file_mutation install / disable / rollback under
  `control_scope: "vo_skill"` via
  `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`; Claude Desktop VO Skill
  file_mutation install / disable / rollback under
  `control_scope: "vo_skill"` via
  `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` (VO-provisional
  darwin pin — NOT Anthropic-authoritative); and two
  artifact_write acceptance recorders); that doc's
  Implementation-status table carries what has shipped and
  what remains deferred.
  Covers the threat model, action-category taxonomy, descriptor
  schema, preview / confirm / execute lifecycle,
  backup-before-write, path-safety fence, secret redaction, and
  mutation-lock semantics every future runner PR must honor.
- **`docs/VO-MCP-CODEX-TOML-MERGE-DESIGN.md`** — binding
  contract for the Codex MCP config auto-merge dashboard
  action. The three action IDs (`mcp_onboard_codex`,
  `mcp_onboard_codex_force`, `mcp_rollback_codex`)
  **SHIPPED in `VO-MCP-CODEX-INSTALL-ACTION-PR-1`** and
  render as dashboard buttons in the dedicated
  `#mcp-codex-install-actions` section; the CLI's
  `vo mcp install --client codex` continues to print the
  TOML block for operators who prefer a terminal workflow,
  but the dashboard path is now the primary one. These
  Codex MCP actions are DISTINCT from the shipped Codex
  VO Skill actions (`skill_install_codex` etc.) — different
  files (`config.toml` vs `SKILL.md`), different locks
  (`mcp_connection` vs `vo_skill`), different control
  scopes.
- **`docs/VO-MCP-AGENT-USAGE.md`** — full agent usage kit:
  decision tree, handling semantics, per-client setup
  deltas.
- **`docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md`** — proof
  runner contract, per-axis evidence model, artifact
  schemas.
- **`docs/VO-MCP-SERVER-CONTRACT.md`** — binding per-rung
  contract.
- **`mcp/README.md`** — package overview.
- **`mcp/skills/verity-one-mcp/SKILL.md`** — short-form
  repo-local Skill brief.
