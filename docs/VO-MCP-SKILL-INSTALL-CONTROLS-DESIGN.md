# VO MCP — Skill + Install Controls Design

> **Scope:** living contract for the tenant-facing control model.
> The **original** `VO-MCP-SKILL-INSTALL-CONTROLS-DESIGN-PR-1`
> shipped this doc as a design-only artifact — no runtime, no
> routes, no dashboard buttons. Subsequent implementation PRs
> extend the shipped surface in narrow slices, each pinned by
> its own drift tests. See the "Dashboard controls
> (implementation state)" table below for what has landed.
>
> Shipped so far (each referenced by PR id):
>   - `VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1` — pure read-only
>     Codex Skill target-path resolver + validator at
>     `api/src/lib/mcp-skill-target-path.ts`.
>   - `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1` — the three Codex
>     Skill dashboard actions `skill_install_codex` /
>     `skill_disable_codex` / `skill_rollback_codex` (plus
>     their buttons, preview / confirm / execute flow, TOCTOU
>     hardening, and rollback-candidate eligibility filter).
>   - `VO-MCP-CODEX-INSTALL-ACTION-PR-1` — the three Codex
>     MCP config dashboard actions `mcp_onboard_codex` /
>     `mcp_onboard_codex_force` / `mcp_rollback_codex`
>     (parser-backed TOML merge / force-repair / rollback for
>     `~/.codex/config.toml`, distinct from the Codex Skill
>     actions).
>   - `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1` — pure read-only
>     Claude Desktop Skill target-path resolver + validator at
>     `api/src/lib/mcp-claude-desktop-skill-target-path.ts`.
>     The pinned path
>     (`~/Library/Application Support/Claude/AgentSkills/
>     verity-one-mcp/SKILL.md`, darwin only) is a
>     **VO-PROVISIONAL pin** — NOT Anthropic-authoritative.
	>   - `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` — the three
	>     Claude Desktop Skill dashboard actions
>     `skill_install_claude_desktop` /
>     `skill_disable_claude_desktop` /
>     `skill_rollback_claude_desktop` (plus their buttons under
>     `#mcp-claude-skill-actions`, preview / confirm / execute
>     flow, and the same TOCTOU hardening + rollback-candidate
>     eligibility filter the Codex Skill actions ship). Consume
>     the VO-provisional target-path validator from the previous
>     PR. Byte-for-byte mirrors of the Codex Skill strategies.
>   - `MCP-SKILL-CHECKER-IMPL-PR-1` — read-only
>     `skill_doctor_codex` / `skill_doctor_claude_desktop`
>     descriptors plus the shared `api/src/lib/mcp-skill-checker.ts`
>     helper. Dashboard status rows now promote VO Skill
>     filesystem states (`installed`, `disabled`, `stale`,
>     `not_installed`, `error`, `manual_required`) from checker
>     output; `enabled` remains Skill-attestation-gated.
>
> This document remains the **authoritative contract** for the
> separation principle + status-state model + dashboard / local
> boundary. Future implementation PRs reference it for shape; if
> they drift, the drift guards fail. Generic Skill support stays
> permanently `unsupported`; Skill-specific operator attestation
> stays a future PR.
>
> Also referenced by
> `agent-lab/scripts/lib/mcp-standardization-proof-ladder.test.ts`;
> the separation-principle phrase is load-bearing for the MCP
> standardization ladder.

## Why this design exists

Today a tenant reaches the shipped VO MCP surface through two
separate controls, each with CLI and dashboard entry points:

- **MCP connection** — the client (Claude Desktop, Codex, any
  generic MCP client) spawns the local stdio server. The CLI
  `vo mcp install` / `vo-mcp install` writes Claude Desktop
  config and prints Codex / generic config for terminal/manual
  workflows; the dashboard also ships descriptor-backed Claude
  Desktop and Codex MCP install / repair / rollback actions.
  `vo-mcp doctor` validates the installed config.
- **VO Skill** — client-side behavior guidance that lives repo-
  local at `mcp/skills/verity-one-mcp/SKILL.md`. It is an
  AgentSkills-format brief: install shapes, session loop, write
  safety, citation, outcome semantics. **It is never installed
  by default; Codex Skill install / disable / rollback require
  their own explicit dashboard action. The Skill is not invoked
  or called by the MCP server. MCP works fully without it.**

These two controls are **not the same thing**:

- Installing MCP changes CONNECTIVITY. The client can now reach
  the local VO server. The agent still behaves however the
  upstream client behaves.
- Installing the Skill changes BEHAVIOR. The agent now has an
  opinionated brief telling it when to recall, when to write,
  how to cite, and what NOT to claim. An agent that has never
  seen the Skill will call tools correctly but may misuse the
  write surface or overclaim hosted / remote MCP transports.

A tenant who wants MCP connectivity without the Skill should be
able to say so. A tenant who wants the Skill loaded into their
client should be able to opt in explicitly. The two controls
must never be collapsed into a single button.

## Separation principle (binding)

**MCP connection and VO Skill activation are separate tenant
controls. The default `vo mcp install --client <client>` installs
MCP connectivity only; it does NOT activate, install, or
otherwise change the behavior of the VO Skill. Skill activation
requires its own explicit opt-in.**

This is the contract for the shipped dashboard actions and every
future implementation slice. Drift from it fails the guard test in
`agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`.

## Current truth (re-pin, so the design is honest)

- VO MCP's Skill install/control surface is **local stdio only**.
  Hosted/serverless `POST /mcp` is the separate web connector for MCP, but it
  does not install, disable, or roll back Skills. `mcp.verityone.app`
  is not shipped.
- `/hosted-mcp/*` is **hosted portable-agent REST**, not MCP
  transport and not a Skill install/control write surface.
- The Skill at `mcp/skills/verity-one-mcp/SKILL.md` is **repo-
  local, not auto-installed, not invoked by the MCP server**.
  MCP works without the Skill.
- Runtime client acceptance is **operator-observed**, not
  automated. The recorder at
  `agent-lab/scripts/record-mcp-client-acceptance.ts` produces a
  gitignored artifact that
  `agent-lab/scripts/run-mcp-interop-proof.ts` reads.
- The agent **must not imperatively write, edit, or paste into**
  `~/.codex/config.toml`, Claude Desktop's config, or anything
  under `~/.vo` outside an allowlisted local action runner
  strategy. Those writes belong to either the installer, a human
  operator, or a descriptor-backed dashboard action with preview /
  confirm / TOCTOU-guarded execute. Current allowlisted local
  write exceptions are:
  - Claude Desktop MCP install / repair / rollback
    (`mcp_onboard_claude_desktop`,
    `mcp_onboard_claude_desktop_force`,
    `mcp_rollback_claude_desktop`).
  - Codex MCP install / repair / rollback
    (`mcp_onboard_codex`, `mcp_onboard_codex_force`,
    `mcp_rollback_codex`) for `~/.codex/config.toml` plus the
    bundled `~/.vo/mcp/` staging tree.
  - Codex VO Skill install / disable / rollback
    (`skill_install_codex`, `skill_disable_codex`,
    `skill_rollback_codex`) for the single Skill file under
    `~/.codex/skills/verity-one-mcp/` plus timestamped backup
    siblings.
  Claude Desktop Skill writes now also ship as dashboard
  actions in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`
  (`skill_install_claude_desktop` / `skill_disable_claude_desktop`
  / `skill_rollback_claude_desktop`) targeting the VO-provisional
  darwin path; generic Skill writes remain fully operator-owned
  (no dashboard action ships today).

## Supported-client matrix (current implementation state)

The two controls have different client support because MCP
config paths and Skill-install paths differ per client.

| Client           | MCP install (connectivity)                           | Skill install (behavior)                                                |
|------------------|-------------------------------------------------------|-------------------------------------------------------------------------|
| `claude-desktop` | **Supported — existing installer writes config.**     | **Dashboard-shipped in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` (VO-provisional, darwin only).** The target-path prerequisite shipped in `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1` (pinning `~/Library/Application Support/Claude/AgentSkills/verity-one-mcp/SKILL.md`, NOT Anthropic-authoritative); the actions PR then ships the three allowlisted descriptors (`skill_install_claude_desktop`, `skill_disable_claude_desktop`, `skill_rollback_claude_desktop`) via the preview-confirmed local action runner. Byte-for-byte mirrors of the Codex Skill strategy posture. Rung 10 ships `skill_doctor_claude_desktop`, so status now reflects filesystem states; `enabled` remains Skill-attestation-gated. |
| `codex`          | **Dashboard-shipped for MCP config.** `mcp_onboard_codex` / `mcp_onboard_codex_force` / `mcp_rollback_codex` merge / force-repair / roll back `~/.codex/config.toml` via the preview-confirmed local action runner. The CLI installer still prints TOML for terminal/manual workflows. | **Dashboard-shipped in `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`.** The three allowlisted actions (`skill_install_codex`, `skill_disable_codex`, `skill_rollback_codex`) copy / rename-to-disabled / restore the repo-local Skill under `~/.codex/skills/verity-one-mcp/` via the preview-confirmed local action runner. Rung 10 ships `skill_doctor_codex`, so status now reflects filesystem states; `enabled` remains Skill-attestation-gated. |
| `generic`        | **Instructions only.** Installer prints the JSON block; operator pastes. | **Documentation only.** Permanently `unsupported` — no writable Skills directory can be inferred for an unknown host; the guide instead says "here is the file; read it yourself". |

`cursor` and `zed` remain refused for MCP install until a later
rung adds them, and they carry no Skill-install claim either.

## Status states (per client, per control)

Every concrete status (`not_installed`, `installed`, `enabled`,
`disabled`) MUST map to evidence from a command or artifact
that SHIPS TODAY. If no such source exists for a given
(client, control) pair, the only permitted states for that
pair are `unsupported`, `unknown`, or `manual_required`.
Future automation can promote a pair from manual-only to
concrete, but only in the same PR that ships the proving
command or artifact.

The status model is therefore split into two tables so the
distinction is impossible to miss:

- **Table A — concrete provable states (today).** Every row
  names a command, artifact, or read-only checker that exists in
  this repo now and can be consulted without inventing evidence.
- **Table B — manual-only today.** (Client, control) pairs
  that still have no shipping proving source. After
  `MCP-SKILL-CHECKER-IMPL-PR-1`, VO Skill / `codex` and VO
  Skill / `claude-desktop` are no longer Table B rows for
  filesystem states: `skill_doctor_codex` and
  `skill_doctor_claude_desktop` are the proving checkers.
  They still do NOT prove `enabled`.

A future dashboard that reports a concrete state for a pair
currently in Table B is lying about what can be proved. The
drift guard in
`agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`
fails if any row in Table A backs a concrete state with
placeholder language ("future", "operator-observed only",
"client-specific", "mostly future").

### Table A — concrete provable states (today)

| State             | Applies to                       | What it means                                                                  | Proving evidence (SHIPPING TODAY)                                          |
|-------------------|----------------------------------|---------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `unsupported`     | any (client, control) pair       | Control does not apply to this client today.                                   | Static — the supported-client matrix above.                                 |
| `unknown`         | any (client, control) pair       | Evidence has not been collected yet.                                           | Default when no command / artifact has been consulted.                      |
| `not_installed`   | MCP / `claude-desktop`, `codex` | No `verity-one` entry in the client's MCP config.                              | `vo-mcp doctor --client claude-desktop` / `vo-mcp doctor --client codex` fails on the "entry present" check. |
| `not_installed`   | Skill / `claude-desktop`, `codex` | No `SKILL.md` at the target and no eligible `.disabled.<UTC-stamp>` sibling. | `skill_doctor_claude_desktop` / `skill_doctor_codex` returns `state: "not_installed"`. |
| `installed`       | MCP / `claude-desktop`, `codex` | Config bytes are on disk in the expected shape.                                | `vo-mcp doctor --client <name>` passes on-disk checks (absolute paths exist, `VO_URL` set, `VO_TOKEN` absent). |
| `installed`       | Skill / `claude-desktop`, `codex` | Target `SKILL.md` exists and byte-hash matches the repo source.               | `skill_doctor_claude_desktop` / `skill_doctor_codex` returns `state: "installed"` from fd-bound no-follow reads. |
| `enabled`         | MCP / `claude-desktop`, `codex` | The client is loading the config and the live stdio path works.                | `vo-mcp doctor` live handshake passes AND a fresh cell for that client exists in the operator-acceptance artifact from `record-mcp-client-acceptance.ts` (artifact schema supports `claude-desktop` + `codex` only). |
| `disabled`        | Skill / `claude-desktop`, `codex` | No live target `SKILL.md`; latest eligible disabled sibling exists.            | `skill_doctor_claude_desktop` / `skill_doctor_codex` returns `state: "disabled"` after strict stamp + regular-file filtering. |
| `stale`           | any artifact-backed pair         | A dependent artifact is older than 72h.                                        | Artifact `run_finished_at` / cell `accepted_at` vs. now.                   |
| `stale`           | Skill / `claude-desktop`, `codex` | Target `SKILL.md` exists but bytes differ from the repo source.               | `skill_doctor_claude_desktop` / `skill_doctor_codex` returns `state: "outdated"`; dashboard maps that to `stale`. |
| `error`           | any                              | Doctor / recorder reported a genuine failure.                                  | The command's non-zero exit + `error_class` / stderr detail.               |
| `error`           | Skill / `claude-desktop`, `codex` | Skill path-safety, platform, source, or read checks refused.                  | `skill_doctor_claude_desktop` / `skill_doctor_codex` returns `state: "error"` (non-darwin Claude Desktop maps to `unsupported`). |
| `manual_required` | any (client, control) pair       | Only a human can produce the evidence; no repo command automates it.           | The step itself (GUI-side confirmation, Skill-into-client-dir copy).       |

Every cell in the "Proving evidence" column names a command,
artifact, or read-only checker that exists in this repo today.

### Table B — manual-only today (dashboard MUST NOT claim as concrete)

These (client, control) pairs still have no shipping proving
source for the concrete state named in the row. Note: "no
proving source" is NARROWER than "no automation at all"; a
write action may ship while a specific status remains
unprovable. After rung 10, Skill / `codex` and Skill /
`claude-desktop` filesystem states reach Table A. After rung
11, `vo_skill` rows also reach `enabled` when paired with the
Skill-specific acceptance discriminator (`skill_observed:
true` + non-empty `skill_observed_note` in a fresh same-
client cell). Ordinary MCP-connection acceptance (status=pass
+ both doctors true, without the Skill fields) does NOT
promote `vo_skill` to `enabled` — the rung-9 reviewer P2 #1
separation principle is preserved. Therefore Skill /
`claude-desktop` and Skill / `codex` are no longer Table B
rows; their checker-backed filesystem states and Skill-
specific `enabled` promotion are Table-A-capable today. Rung
12 additionally ships the operator-local Skill-lifecycle proof
script that drives install → doctor → disable → doctor →
rollback → doctor in a scratch HOME and writes gitignored
evidence.

A dashboard observing these rows today MUST use one of
`unsupported`, `unknown`, or `manual_required` and never
`installed` / `enabled` / `disabled` / `not_installed`. Moving
a row into Table A is a breaking-change-worthy event for the
status-model contract: the PR that does so updates this doc
AND the drift test in lockstep with the new checker.

| Pair                                           | Allowed states today                                                                  | Future / remaining gate                                                                             |
|------------------------------------------------|----------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Skill / `generic`                              | `unsupported` (no client-agnostic Skill install path exists).                         | None by definition; `generic` is documentation-only.                                                 |
| MCP `disabled` (any client)                    | `manual_required`.                                                                     | Requires a reversible disable/uninstall path (comment-out + backup + rollback) that does not ship. Until it does, "disabled" is NOT a concrete state the dashboard may claim. |
| MCP `enabled` without a fresh acceptance artifact | `manual_required`.                                                                 | Already covered by Table A IF a fresh acceptance artifact exists. Without the artifact, a green doctor alone does NOT prove `enabled` — render `manual_required` with exact instructions. |
| MCP / `generic` (`installed` / `enabled` / `not_installed`) | `unknown` or `manual_required`.                                          | `vo-mcp doctor --client` supports only `claude-desktop` + `codex`, and the acceptance-artifact schema's `CLIENT_ACCEPTANCE_CLIENTS` tuple is `["claude-desktop", "codex"]` — no generic-client checker or artifact ships today. A later PR may add a generic-client doctor branch + extend the artifact schema; that PR moves this row into Table A. Until then, rendering `installed` / `enabled` / `not_installed` for a `generic` client is an overclaim. |

### Concrete doctor invocations per client

For the status-state sources above, the exact shipped doctor
sources are:

- `vo-mcp doctor --client claude-desktop` — client-config
  precondition check for Claude Desktop; mirrored by the
  `mcp_client_doctor_claude_desktop` dashboard descriptor.
- `vo-mcp doctor --client codex` — client-config precondition
  check for Codex (the `[mcp_servers.verity-one]` section of
  `~/.codex/config.toml`); mirrored by the
  `mcp_client_doctor_codex` dashboard descriptor.
- `vo-mcp doctor` — live stdio handshake against the installed
  server, independent of any client; mirrored by the
  `mcp_live_doctor` dashboard descriptor.

### Why not more states?

`stale` and `error` could be collapsed into a single "problem"
state, but keeping them separate makes remediation obvious.
`manual_required` and `unknown` could be collapsed similarly —
we keep them separate because the action is different (run the
recorder vs. run the doctor).

## Dashboard / local boundary (critical)

A tenant dashboard can observe status and suggest actions. It
**cannot** silently mutate local filesystem or client config.

- **Read-only from the dashboard:** status per client per
  control, last doctor result, last runtime-acceptance artifact
  age, the exact commands that would advance the status.
- **Mutations run on the tenant's local machine with explicit
  operator consent.** The dashboard either:
  - runs an ALLOWLISTED local helper through the preview /
    confirm / execute flow that ships in the local action
    runner (`api/src/lib/mcp-local-action-runner.ts` +
    `POST /dashboard/mcp-actions/preview` + `POST
    /dashboard/mcp-actions/execute`). The allowlist today
    covers Claude Desktop MCP install / repair / rollback,
    Codex MCP install / repair / rollback (shipped in
    `VO-MCP-CODEX-INSTALL-ACTION-PR-1` — `mcp_onboard_codex`
    / `mcp_onboard_codex_force` / `mcp_rollback_codex`),
    Codex VO Skill install / disable / rollback, the
    read-only doctors, and the two acceptance recorders
    (`acceptance_record_claude_desktop` +
    `acceptance_record_codex`). Each action surfaces an
    explicit confirmation card BEFORE any write, re-runs
    path safety immediately before every filesystem
    mutation, and emits a redacted audit summary. Silent
    mutation is forbidden at the route layer (preview mints
    a single-use confirmation token; execute consumes it). OR
  - displays the exact command for the operator to copy-paste
    into their terminal — for actions that do NOT ship a
    local helper yet (generic host writes, cross-client
    interop proof). Claude Desktop VO Skill install / disable
    / rollback now SHIP as dashboard actions under a
    VO-provisional darwin target path
    (`VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`); generic VO
    Skill support stays permanently unsupported.
- **If a safe local mutation is unavailable, the dashboard MUST
  show commands / instructions.** It MUST NOT fake a successful
  action or record a mutation that did not happen.

Current per-surface implementation state:

- **Claude Desktop MCP install:** can be executed by a local
  helper that shells out to `vo-mcp install --client
  claude-desktop`. The dashboard should NOT write Claude
  Desktop config directly.
- **Codex MCP install:** ships as three descriptor-backed
  dashboard actions: `mcp_onboard_codex` (normal merge),
  `mcp_onboard_codex_force` (replace the existing
  `[mcp_servers.verity-one]` section), and `mcp_rollback_codex`
  (restore latest eligible backup). These actions use the
  parser-backed TOML merger from
  `mcp/src/codex-toml-merge.ts`, preserve unrelated sections
  byte-for-byte, refresh the bundled `~/.vo/mcp/` staging tree
  for install / force, and run through the same preview /
  confirm / execute route pair as the Claude Desktop actions.
  The CLI `vo mcp install --client codex` path still prints a
  TOML block for operators who prefer manual terminal workflow.
- **Generic MCP install:** shows the JSON block and instructs
  the operator to paste into their client's MCP config.
- **VO Skill install:** **per-client state. No client-agnostic
  path exists and the dashboard must not pretend otherwise.**
    - Codex: the dashboard ships three allowlisted Skill
      actions — `skill_install_codex` (copy repo
      `mcp/skills/verity-one-mcp/SKILL.md` to
      `~/.codex/skills/verity-one-mcp/SKILL.md` with backup-
      before-overwrite), `skill_disable_codex` (rename-to-
      `SKILL.md.disabled.<UTC-stamp>`), and
      `skill_rollback_codex` (restore the latest eligible
      sibling). Each goes through preview → confirm →
      TOCTOU-guarded execute. Status re-read runs
      `skill_doctor_codex` and may show a filesystem state;
      `enabled` remains gated on Skill-specific operator
      attestation.
    - Claude Desktop: actions SHIPPED (VO-provisional).
      `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1` merged the pure
      read-only resolver / validator at
      `api/src/lib/mcp-claude-desktop-skill-target-path.ts`
      pinning `~/Library/Application Support/Claude/
      AgentSkills/verity-one-mcp/SKILL.md` (darwin only,
      VO-provisional — NOT Anthropic-authoritative).
      `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` then shipped
      three allowlisted actions — `skill_install_claude_desktop`
      (copy repo `mcp/skills/verity-one-mcp/SKILL.md` to the
      pinned target with backup-before-overwrite),
      `skill_disable_claude_desktop` (rename-to-
      `SKILL.md.disabled.<UTC-stamp>`), and
      `skill_rollback_claude_desktop` (restore the latest
      eligible sibling) — byte-for-byte mirrors of the Codex
      Skill strategy posture. Status re-read runs
      `skill_doctor_claude_desktop` and may show a filesystem
      state; `enabled` remains gated on Skill-specific operator
      attestation.
    - Generic: permanently `unsupported`. No writable
      Skills directory can be inferred for an unknown
      host; the dashboard shows the repo-local path and
      says "read this in context or copy it yourself".
  Silent or default Skill activation via any path is a
  DESIGN VIOLATION — the dashboard actions require explicit
  operator confirmation; `vo mcp install` still does NOT
  install the Skill.

## Dashboard controls (implementation state)

The conceptual control set below has partially shipped via
the local action runner. Rows marked SHIPPED are live
today; rows marked DEFERRED still await their own PR.
Naming was non-binding at design time; the separation
(MCP connection vs. VO Skill, per-client scope) is binding.

| Control                       | State      | Effect                                                        | Client scope                  |
|-------------------------------|------------|---------------------------------------------------------------|--------------------------------|
| Enable / Install VO MCP       | **SHIPPED (claude-desktop + codex)** | Claude Desktop runs the local installer via `mcp_onboard_claude_desktop`; Codex runs the parser-backed TOML merge via `mcp_onboard_codex` and refreshes the bundled `~/.vo/mcp/` staging tree. | `claude-desktop` + `codex` now; `generic` remains instruction-only. |
| Repair VO MCP (force)         | **SHIPPED (claude-desktop + codex)** | Claude Desktop overwrites existing `mcpServers.verity-one` via `mcp_onboard_claude_desktop_force`; Codex replaces only the existing `[mcp_servers.verity-one]` source range via `mcp_onboard_codex_force`; timestamped backup first. | `claude-desktop` + `codex`; `generic` instruction-only. |
| Roll back VO MCP              | **SHIPPED (claude-desktop + codex)** | Claude Desktop restores latest `.bak.<UTC-stamp>` via `mcp_rollback_claude_desktop`; Codex restores latest eligible `config.toml.bak.<UTC-stamp>` via `mcp_rollback_codex`; both safety-backup current state first. | `claude-desktop` + `codex`; `generic` has no dashboard rollback. |
| Disable VO MCP                | DEFERRED   | Removes / comments out the `verity-one` entry from the client's config (not shipped for any client yet; symmetric undo IS shipped as the Roll back row above). | Per client. |
| Install VO Skill              | **SHIPPED (codex + claude-desktop)** | Explicit opt-in to copy the Skill into the client's AgentSkills directory via `skill_install_codex` or `skill_install_claude_desktop`. Claude Desktop target-path is a VO-provisional darwin pin (NOT Anthropic-authoritative); generic stays unsupported. | `codex` + `claude-desktop` (darwin only, VO-provisional); `generic` permanently `unsupported`. |
| Disable VO Skill              | **SHIPPED (codex + claude-desktop)** | Explicit opt-out. Renames `SKILL.md` → `SKILL.md.disabled.<UTC-stamp>` via `skill_disable_codex` or `skill_disable_claude_desktop`; never deletes unrelated Skills. | `codex` + `claude-desktop` (darwin only, VO-provisional); `generic` permanently `unsupported`. |
| Roll back VO Skill            | **SHIPPED (codex + claude-desktop)** | Restores latest eligible `.bak.<UTC-stamp>` / `.disabled.<UTC-stamp>` sibling via `skill_rollback_codex` or `skill_rollback_claude_desktop`; safety-backup-before-restore. Eligibility does NOT prove runner provenance. | `codex` + `claude-desktop` (darwin only, VO-provisional); `generic` permanently `unsupported`. |
| Run client-config doctor      | **SHIPPED (read_only)** | Runs the `mcp_client_doctor_claude_desktop` / `mcp_client_doctor_codex` descriptors via the dashboard's preview / execute flow (same file as `vo-mcp doctor --client <client>` under the hood). | Per client (`claude-desktop`, `codex`). |
| Run live MCP doctor           | **SHIPPED (read_only)** | Runs the `mcp_live_doctor` descriptor via the dashboard (same live stdio handshake as `vo-mcp doctor`). | Not client-specific.           |
| Record runtime acceptance     | **SHIPPED (artifact_write)** | Runs `acceptance_record_claude_desktop` / `acceptance_record_codex` via the dashboard's recorder form. Preview-time semantic validation refuses `pass` unless both doctor flags are true + refuses secret-shaped free-text fields. Writes only under `agent-lab/proof/vo-mcp-client-acceptance/`. | Per client (`claude-desktop`, `codex`; no generic recorder). |
| Rerun interop proof           | COPY-ONLY (no dashboard action) | No allowlisted descriptor; the dashboard surfaces the command string (`bun run agent-lab/scripts/run-mcp-interop-proof.ts`) as a click-to-copy so the operator runs it in their own terminal. Not a dashboard-executed action. | Not client-specific. |

All actions are descriptor-backed local helper strategies behind
the preview / confirm / execute route pair. The browser never
sends shell strings or arbitrary write targets; config writes only
happen inside named strategies after path-safety checks and
confirmation.

## Safe install / uninstall semantics

### MCP install

- **Claude Desktop:** the installer already supports
  `--client claude-desktop` and merges a `mcpServers.verity-one`
  entry into the existing config. This PR does NOT change that.
  A future disable path should comment-out or remove the
  `verity-one` entry without touching other `mcpServers.*`
  entries — it must NOT delete the whole `mcpServers` object or
  the whole file.
- **Codex:** dashboard install / repair / rollback ship via
  `mcp_onboard_codex`, `mcp_onboard_codex_force`, and
  `mcp_rollback_codex`. The merge uses `smol-toml` for
  validate-before / validate-after and raw-text section
  replacement for byte preservation; backup-before-write applies
  when the config exists, first-time install writes no backup,
  and rollback refuses when no eligible backup exists. The CLI
  still prints the TOML block for manual terminal workflows.
- **Generic:** manual paste is the only supported install path.
  The dashboard and CLI show the JSON block; the operator pastes
  into their chosen client's config. No generic host write ships.

### MCP uninstall / disable

- Preferred: **disable over delete.** Comment-out or mark the
  entry as disabled rather than removing it — reversible and
  preserves tenant history.
- Must preserve every other entry in the file.
- Must print a diff of what changed and a one-command undo.

### Skill install (explicit opt-in)

Per-client state:
  - **Codex dashboard action — SHIPPED.** The dashboard
    action `skill_install_codex` (plus `skill_disable_codex`
    and `skill_rollback_codex`) is the shipped explicit
    opt-in. Full preview / confirm / execute flow; status
    re-read runs `skill_doctor_codex` and may show a
    filesystem state.
  - **Claude Desktop dashboard action — SHIPPED (VO-provisional).**
    `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` ships the three
    descriptors `skill_install_claude_desktop`,
    `skill_disable_claude_desktop`,
    `skill_rollback_claude_desktop` consuming
    `validateClaudeDesktopSkillTargetPath`. Byte-for-byte
    mirrors of the Codex Skill posture (same 8/4/8-stage
    TOCTOU pipeline, same stamp shape, same atomic write,
    same test-injection hook surface). Target-path pin is
    VO-provisional darwin only — NOT Anthropic-authoritative.
    Status re-read runs `skill_doctor_claude_desktop` and may
    show a filesystem state.
  - **CLI Skill install — still future.** The default `vo
    mcp install` / `vo mcp onboard` CLI flows never install
    the Skill, for ANY client. A future CLI may add an
    explicit opt-in shape (naming TBD; design pins the
    behavior, not the syntax):
    - `vo mcp install --client <client> --with-skill`
    - `vo mcp install-skill --client <client>`
    Whichever shape ships MUST emit a confirmation prompt
    the first time it runs, naming the exact file(s) it will
    create and where.

Binding rules that apply TO EVERY Skill-install shape, shipped
or future:
  - Never default. Never implicit in `vo mcp install` /
    `vo mcp onboard`. Every current install/onboard flow
    explicitly refuses to touch any Skill directory.
  - Silent Skill activation is a DESIGN VIOLATION regardless
    of whether the surface is a CLI flag or a dashboard
    button.

### Skill uninstall / disable

- Must be reversible: disable = mark as disabled, not delete.
- Must NEVER delete unrelated Skills from the client's
  AgentSkills directory. The uninstall target is specifically
  the `verity-one-mcp` Skill and nothing else.
- Must show the exact file paths it touched.

## Skill lifecycle under the local action runner (refresh)

The local `/dashboard` action runner exists today. Its contract
(categories, preview → confirm → execute, backup-before-write,
path-safety, redaction, status re-read) is pinned in
`docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md`. This section maps
the Skill lifecycle above onto that contract — the three
six shipped Skill actions — three Codex
(`skill_install_codex` / `skill_disable_codex` /
`skill_rollback_codex`) and three Claude Desktop
(`skill_install_claude_desktop` / `skill_disable_claude_desktop`
/ `skill_rollback_claude_desktop`) — honor this shape TODAY,
and any future Skill action PR (Skill auto-activate / uninstall
surface, or a checker that promotes the status row) MUST
continue to honor it.

### Scope boundary (binding)

- **Scope by PR in the Skill-lifecycle series.** The Skill-
  lifecycle work ships across a staged series. Each PR
  narrows its surface; the next relaxes only the narrowed
  piece:
  - **Design-refresh PR** (the PR that introduced this
    section) — ships the design doc + its drift guards +
    doc pointers only. Docs-only.
  - **Target-path PRs** (per client) — each ships ONE
    pure, read-only resolver helper module + unit tests.
    Both client-specific resolvers have now merged:
    - **Codex half** — `VO-MCP-CODEX-SKILL-TARGET-PATH-
      PR-1`: added `api/src/lib/mcp-skill-target-path.ts`
      exporting `resolveCodexSkillTargetPath` /
      `validateCodexSkillTargetPath` /
      `findSuspiciousAncestorSymlink` /
      `CODEX_SKILL_SOURCE_REL_PATH`.
    - **Claude Desktop half** — `VO-MCP-CLAUDE-SKILL-
      TARGET-PATH-PR-1`: added
      `api/src/lib/mcp-claude-desktop-skill-target-path.ts`
      exporting `resolveClaudeDesktopSkillTargetPath` /
      `validateClaudeDesktopSkillTargetPath` /
      `CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH`. Pinned path
      is **VO-provisional** (darwin only, NOT
      Anthropic-authoritative); non-darwin platforms
      refuse at the validator's platform gate. The
      resolver REUSES `findSuspiciousAncestorSymlink`
      from the Codex module — one ancestor-walk
      implementation, two callers.
    Both helpers are pure — `lstat` / `realpathSync`
    only, never writes — and the target-path PRs are
    intentional shipped surface, not scope creep.
  - **Actions PR** — two PRs shipped:
    - `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1` — Codex half.
      Ships the three Codex file_mutation descriptors
      (`skill_install_codex`, `skill_disable_codex`,
      `skill_rollback_codex`), their dashboard buttons, and
      the first Skill filesystem writes.
    - `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` — Claude
      Desktop half. Registers the three
      `skill_*_claude_desktop` rows, consumes
      `validateClaudeDesktopSkillTargetPath` at preview +
      execute time, inherits the same 8/4/8-stage TOCTOU
      hardening the Codex Skill strategies ship, and
      reuses the client-agnostic filename-based helpers
      (`codexSkillBackupPath`, `codexSkillDisabledPath`,
      `findLatestCodexSkillRestoreCandidate`) as-is.
      Target-path pin stays VO-provisional darwin.
    Generic Skill support stays permanently `unsupported`.
- **Hard invariant for every PR in the series without a
  landed target-path PR for a given client.** No PR in the
  series may register `skill_*_<client>` descriptors, add
  dashboard Skill buttons for that client, or perform
  filesystem writes under that client's Skills directory
  until the target-path PR for that client has merged.
  Both halves have now merged for Claude Desktop:
  `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1` pinned the
  VO-provisional darwin path, and
  `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` registered the
  three `skill_*_claude_desktop` descriptors + their dashboard
  buttons + the TOCTOU-guarded filesystem writes. The design-
  refresh PR and each target-path PR honored this invariant in
  their own scope before their follow-on actions PRs.
- **Skill actions are a separate tenant control.** The runner
  already has two controls: `mcp_connection` (MCP install /
  repair / doctor / acceptance recorder) and `vo_skill`. The
  Skill action ids below use `control_scope: vo_skill`. The
  separation principle above forbids a single `action_id` from
  crossing both controls.
- **MCP install/onboard never installs or activates the Skill.**
  The current `mcp_onboard_claude_desktop` /
  `mcp_onboard_claude_desktop_force` descriptors touch ONLY
  Claude Desktop's MCP config, while `mcp_onboard_codex` /
  `mcp_onboard_codex_force` touch ONLY Codex MCP config plus the
  shared `~/.vo/mcp/` staging tree. Their preview `extra_notes`
  disclose that Skill files are not touched. Every shipped or
  future Skill-install descriptor reciprocates with its own
  preview line: "MCP connection config is NOT touched."

### Authoritative paths

- **Source (this repo).** The Skill file to copy is
  `mcp/skills/verity-one-mcp/SKILL.md`. Any other path is not
  the repo Skill; any action that copies from anywhere else is
  out of scope.
- **Targets (binding).** No Skill-install file_mutation action
  may ship for a client until a **target-path PR** for that
  client has landed. A target-path PR carries (a) the exact
  absolute target path resolver, (b) the accepted-parent scope
  (per OS + env-override semantics), (c) fallback behavior when
  the parent does not exist, and (d) its own drift guard
  pinning both. Only after such a PR merges may the next
  Skill-actions PR register a `skill_install_*` /
  `skill_disable_*` / `skill_rollback_*` descriptor for that
  client. Current per-client status:
  - `claude-desktop` — **TARGET PATH SHIPPED
    (VO-provisional, darwin) in
    `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`; ACTIONS SHIPPED
    in `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`.** The
    target-path module lives at
    `api/src/lib/mcp-claude-desktop-skill-target-path.ts`
    and exports `resolveClaudeDesktopSkillTargetPath` /
    `validateClaudeDesktopSkillTargetPath` /
    `CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH`. The pinned
    target is
    `~/Library/Application Support/Claude/AgentSkills/
    verity-one-mcp/SKILL.md` — a **VO-PROVISIONAL pin,
    NOT Anthropic-authoritative**. The validator refuses
    non-darwin platforms before any filesystem check (the
    provisional contract names only darwin); on darwin it
    applies the same refusal matrix as the Codex resolver
    (direct-symlink refusals at every level, suspicious-
    ancestor walk via the Codex module's shared
    `findSuspiciousAncestorSymlink`, kind checks on
    existing dirs/files, informational-only
    `realpathSync`). The three `skill_*_claude_desktop`
    action descriptors consume this validator at preview
    + execute time and inherit byte-for-byte the Codex
    Skill strategy posture (same 8/4/8-stage TOCTOU
    pipeline, same stamp shape, same atomic write).
    Client-agnostic filename-based helpers
    (`codexSkillBackupPath`, `codexSkillDisabledPath`,
    `findLatestCodexSkillRestoreCandidate`) are reused
    as-is. If Anthropic later publishes the
    authoritative writable Skills directory AND it differs
    from the provisional pin, this module updates in
    lockstep; the drift guard's "VO-provisional" marker
    survives until the authoritative path is consumed.
  - `codex` — **TARGET PATH SHIPPED in
    `VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1`. ACTIONS SHIPPED in
    `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`.** The three Codex
    Skill `file_mutation` descriptors
    (`skill_install_codex`, `skill_disable_codex`,
    `skill_rollback_codex`) are registered in the local
    action runner under `control_scope: "vo_skill"`; the
    target-path contract now lives at
    `api/src/lib/mcp-skill-target-path.ts` and is consumed
    by those descriptors:
    - **Resolver** — `resolveCodexSkillTargetPath({ home, env })`
      returns the four-piece breakdown
      `{ codexHome, skillsRoot, skillDir, skillFile }`. Platform-
      agnostic (Codex uses the same `.codex` layout across
      macOS / Linux / Windows; matches
      `mcp/src/client-config-check.ts::codexConfigPath`).
    - **Env precedence** — `CODEX_HOME` wins when set to a
      trimmed absolute path; otherwise `<home>/.codex`. Empty,
      whitespace-only, or relative `CODEX_HOME` falls back.
    - **Target file (single-file scope)** — resolves to
      `<skillsRoot>/verity-one-mcp/SKILL.md`. Default home
      becomes `~/.codex/skills/verity-one-mcp/SKILL.md`. The
      three shipped Codex Skill actions each operate on this
      single file only: `skill_install_codex` writes ONE file
      (backup-before-overwrite when present); `skill_disable_codex`
      renames that file to a timestamped `.disabled.<UTC-stamp>`
      sibling (atomic rename, never delete); `skill_rollback_codex`
      restores the latest eligible sibling. Unrelated Codex
      Skills are never touched.
    - **Source (authority)** —
      `CODEX_SKILL_SOURCE_REL_PATH = "mcp/skills/verity-one-mcp/
      SKILL.md"` exported from the same module. No other
      source is allowed.
    - **Path safety** —
      `validateCodexSkillTargetPath({ home, env })` refuses:
      missing `codexHome` (no auto-create), missing
      `skillsRoot` (no auto-create), symlinked `codexHome` /
      `skillsRoot` / `skillDir` / `skillFile`, non-directory
      at `codexHome` or `skillsRoot`, non-regular-file at
      `skillFile`, and **any symlinked ancestor of
      `skillsRoot`** — walked parent-by-parent up to the
      filesystem root via `findSuspiciousAncestorSymlink`,
      skipping a small allowlist of legitimate platform-level
      OS symlinks (`/var`, `/tmp`, `/etc` on macOS, so tmpdir-
      scoped operators aren't blocked). The first suspicious
      ancestor is named in the refusal reason so the operator
      knows which link to inline or remove. `lstat` alone on
      the literal `skillsRoot` does NOT catch this because
      intermediate symlinks are followed implicitly — the
      explicit ancestor walk is the fence. The validator is
      pure — it reads via `lstat` / `realpathSync` only and
      never writes; `realpathSync(skillsRoot)` is computed
      purely to surface `skillsRootRealpath` in the preview
      result, NOT used as a scope gate.
    - **Missing-parent posture** — refuses at preview time
      with a path-safety error. The action does NOT
      `mkdir -p ~/.codex/skills`; the operator creates the
      directory (or lets Codex create it on first run) before
      running the Skill install action.
    - **Drift guard** —
      `agent-lab/scripts/lib/mcp-skill-install-controls-
      design.test.ts` pins both sides: this design section
      names the resolver + source constants + path-safety
      refusals; the api module exports them with the same
      semantics.
  - `generic` — **always out of scope.** "Generic" is by
    definition an unknown host; a writable Skills directory
    cannot be inferred. Instruction-only forever unless a
    concrete client graduates from generic.

### Action categories (mapped)

Every Skill action — shipped today AND future — MUST be
classified as one of. Each row names the descriptor's
category / `control_scope` / `client_scope` / what it
mutates, plus the per-row State (**SHIPPED** → registered
in `api/src/lib/mcp-local-action-runner.ts` today;
**DEFERRED** → reserved for future expansion such as a
Skill checker or a generic-host Skill surface; see the
"Skill action IDs" section below for the full gate-state
+ PR-anchor table):

| Action | State | Category | `control_scope` | `client_scope` | Mutates |
|--------|-------|----------|-----------------|-----------------|---------|
| `skill_install_claude_desktop` | **SHIPPED** | `file_mutation` | `vo_skill` | `claude-desktop` | `<target>/SKILL.md` + timestamped backup if overwrite |
| `skill_disable_claude_desktop` | **SHIPPED** | `file_mutation` | `vo_skill` | `claude-desktop` | rename `SKILL.md` → `SKILL.md.disabled.<UTC-stamp>` |
| `skill_rollback_claude_desktop` | **SHIPPED** | `file_mutation` | `vo_skill` | `claude-desktop` | restore latest `.bak.<UTC-stamp>` sibling |
| `skill_install_codex` | **SHIPPED** | `file_mutation` | `vo_skill` | `codex` | `<target>/SKILL.md` + timestamped backup if overwrite |
| `skill_disable_codex` | **SHIPPED** | `file_mutation` | `vo_skill` | `codex` | rename `SKILL.md` → `SKILL.md.disabled.<UTC-stamp>` |
| `skill_rollback_codex` | **SHIPPED** | `file_mutation` | `vo_skill` | `codex` | restore latest `.bak.<UTC-stamp>` sibling |

Skill actions are `file_mutation`, **not** `read_only`. They
are NEVER `artifact_write` (that category covers gitignored
evidence artifacts; a Skill file lives under the operator's
host config tree).

### Preview requirements (binding)

Every Skill `file_mutation` preview — shipped AND future —
MUST disclose (the three shipped Codex Skill descriptors
honor this today; any future Claude Desktop Skill
descriptor, auto-activate surface, or true uninstall
descriptor MUST too):

1. **Exact source path** — `mcp/skills/verity-one-mcp/SKILL.md`
   (pinned; operators can inspect the source before confirming).
2. **Exact absolute target path** — resolved per OS + client.
3. **Current target state** — `absent`, `present` (with mtime +
   hash summary), or `present-and-different-from-source` so the
   operator sees what would be OVERWRITTEN before confirming.
4. **Backup plan** — if the target is `present`, name the
   `SKILL.md.bak.<UTC-stamp>` sibling the runner will write
   BEFORE any overwrite. Install against an `absent` target
   writes no backup (nothing to preserve), and the preview
   says so.
5. **Rollback action/command** — names the allowlisted
   `skill_rollback_<client>` descriptor AND the manual
   fallback (`cp <bak> SKILL.md`).
6. **Explicit "MCP connection not touched"** — every Skill
   preview MUST carry this negation in `extra_notes` so the
   operator never mistakes a Skill action for a client-config
   mutation.
7. **Path-safety refusal** (`path_safety: { ok: false, reason }`)
   surfaced to the UI when the target path is a symlink, lies
   outside the expected per-(OS, client) scope, or has a
   symlinked ancestor. Same fence shape the Claude Desktop
   MCP install already uses; the Skill variant narrows the
   expected-parent path.

### Execute contract (binding)

Every Skill `file_mutation` execute — shipped AND future —
MUST (the three shipped Codex Skill strategies in
`api/src/lib/mcp-local-action-runner.ts` honor this today;
any future Claude Desktop Skill strategy, auto-activate
surface, or true uninstall strategy MUST too):

- Require a fresh matching confirmation token (action id +
  args hash + tenant). Existing wire protocol unchanged.
- Acquire the per-(tenant, `vo_skill`) mutation lock. Skill
  mutations serialize AMONG THEMSELVES per tenant, but do
  NOT share the lock with `mcp_connection` mutations — a
  Claude Desktop MCP install can safely run concurrently
  with a Codex Skill install; they target unrelated files.
- **Per-action undo posture** — each Skill `file_mutation`
  preserves prior bytes, but the shape differs by action:
    - **Install.** Take a `SKILL.md.bak.<UTC-stamp>` sibling
      BEFORE any overwrite (install against present target).
      Atomic (tmp + rename). First-time install writes no
      backup (nothing to preserve) and the preview says so.
    - **Disable.** Atomic `fs.renameSync` of the current
      `SKILL.md` → `SKILL.md.disabled.<UTC-stamp>` in the
      same directory. The rename itself IS the preserved-
      bytes artifact; no separate `.bak.<UTC-stamp>` copy is
      written (a copy-then-delete shape would double the
      on-disk bytes and add a crash window where the
      original is gone but the backup is not yet durable).
      Refuses when no `SKILL.md` exists (nothing to disable).
    - **Rollback.** BEFORE restoring bytes from the latest
      valid `.bak.<UTC-stamp>` or `.disabled.<UTC-stamp>`
      sibling, take a `SKILL.md.bak.<UTC-stamp>` safety
      sibling of the CURRENT `SKILL.md` (if any) so the
      rollback is itself reversible. Atomic (tmp + rename)
      for both the safety backup and the restore write. If
      the current `SKILL.md` is absent (as it will be right
      after `disable`), no safety backup is needed and the
      rollback proceeds directly to the restore.
- Perform the single, fixed write — copy from the pinned
  repo source to the resolved target (install), rename
  target (disable), or restore from the latest valid
  backup/disabled sibling (rollback). No other files
  touched.
- Re-read status evidence after execute. The `vo_skill` row
  is refreshed through the rung-10 `skill_doctor_<client>`
  filesystem checker and may move to `installed`, `disabled`,
  `stale`, `not_installed`, `error`, or `manual_required`.
  It still MUST NOT move to `enabled`; the execute result
  therefore surfaces the operator-facing "what to do next"
  (restart client, confirm the Skill is available in the
  client UI) rather than claiming enabled.

### Destruction refusal (binding)

- **No action may delete unrelated Skills.** The uninstall /
  disable target is specifically `verity-one-mcp/SKILL.md`.
  Any shipped or future implementation that calls `fs.rmSync` with
  `recursive: true` on ANY parent directory is a design
  violation.
- **No action may wipe a Skills directory.** Disable is
  rename-to-disabled, not unlink. Rollback is copy-from-
  backup, not recreate-from-scratch.
- **No action may follow symlinks.** The path-safety fence
  refuses symlinked targets outright (same shape as Claude
  Desktop MCP install path safety).

### Status evidence (checker shipped; `enabled` remains gated)

- Skill / `claude-desktop` → filesystem states come from
  `skill_doctor_claude_desktop`. Both the target-path
  prerequisite and the actions PR have shipped under the
  VO-provisional darwin pin; the checker now proves
  `installed`, `disabled`, `stale` (checker `outdated`),
  `not_installed`, `error`, or `manual_required`.
- Skill / `codex` → filesystem states come from
  `skill_doctor_codex` using the Codex Skills target path.
- Skill / `generic` → permanently `unsupported`.

A Skill-install action does NOT by itself prove `enabled`. The
runner's `status_reread` after a successful Skill install /
disable / rollback invokes the rung-10 checker path and may
update the filesystem state, but the execute summary still tells
the operator to restart the client and confirm the Skill is
loaded in session.

The **Skill checker** is designed in `docs/VO-MCP-SKILL-CHECKER-
DESIGN.md` (rung 9, `MCP-SKILL-CHECKER-DESIGN-PR-1`) and
implemented in rung 10 (`MCP-SKILL-CHECKER-IMPL-PR-1`) as two
read-only descriptors: `skill_doctor_codex` and
`skill_doctor_claude_desktop`. The binding boundary the checker
draws:

- The checker promotes `vo_skill` rows to `installed` /
  `disabled` / `outdated` / `not_installed` based on
  filesystem evidence (lstat + sha256 hash-match against
  the pinned repo source).
- `enabled` requires the rung 11 Skill-lifecycle operator
  attestation discriminator: a fresh same-client `acceptance_record_<client>`
  cell with `skill_observed=true` and a non-empty
  `skill_observed_note`, paired with checker state
  `installed`. Ordinary MCP-connection acceptance fields by
  themselves MUST NOT promote a `vo_skill` row to `enabled`.
  The checker NEVER promotes a row to `enabled` on its own —
  filesystem evidence alone cannot prove the client actually
  loaded the Skill in session.
- Non-darwin `skill_doctor_claude_desktop` returns `error`
  with the VO-provisional platform-scope reason; the status
  row renders `unsupported` (matches the generic-MCP
  convention).
- Source-unreadable (repo root unresolvable) returns
  `manual_required` — explicit honesty about the checker's
  limits when it can't hash-compare.

Before rung 10 shipped, all Skill rows stayed in Table B
(`manual_required` / `unknown` / `unsupported`). Rung 10 now
promotes Codex + Claude Desktop Skill filesystem states via
the read-only `skill_doctor_<client>` helpers. Rung 11 now
adds the Skill-specific acceptance discriminator that can
promote an `installed` row to `enabled`. Rung 12 now ships
the automated Skill-lifecycle proof script as operator-local
evidence; it does not change status semantics.

### Skill action IDs — Codex SHIPPED, Claude Desktop SHIPPED (VO-provisional)

Every Skill `file_mutation` descriptor is gated by a per-
client sequence (target-path PR, then actions PR; see the
Targets section above). Both target-path PRs have merged; both
actions PRs have merged. No further Skill-action PR is gated
today. Rung 12 also ships the automated Skill lifecycle proof
script; remaining non-goals are generic-host Skill install,
silent auto-activation, and true uninstall.

- **Codex** — `VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1`
  (target-path) AND `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`
  (actions) both MERGED. The three `skill_*_codex`
  descriptors are registered in the runner today.
- **Claude Desktop** — `VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`
  (target-path) AND `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`
  (actions) both MERGED. The three `skill_*_claude_desktop`
  descriptors are registered in the runner today under the
  VO-provisional darwin pin (NOT Anthropic-authoritative).
- **Generic** — permanently `unsupported` (no writable
  Skills directory can be inferred for an unknown host).

| Candidate | Gated on | Notes |
|-----------|----------|-------|
| `skill_install_claude_desktop` | Claude Desktop target-path PR **MERGED** (`VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1`); actions PR **MERGED** (`VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`). | **SHIPPED.** Registered in `api/src/lib/mcp-local-action-runner.ts` with `category: "file_mutation"`, `control_scope: "vo_skill"`, `client_scope: "claude-desktop"`. Consumes `validateClaudeDesktopSkillTargetPath` / `CLAUDE_DESKTOP_SKILL_SOURCE_REL_PATH` from the target-path module. Byte-for-byte mirror of `skill_install_codex` in strategy posture. VO-provisional darwin pin (NOT Anthropic-authoritative). |
| `skill_disable_claude_desktop` | same as `skill_install_claude_desktop` | **SHIPPED.** Renames `SKILL.md` to `SKILL.md.disabled.<UTC-stamp>`. Atomic rename; never deletes. |
| `skill_rollback_claude_desktop` | same as `skill_install_claude_desktop` | **SHIPPED.** Restores the latest eligible `.bak.<UTC-stamp>` or `.disabled.<UTC-stamp>` sibling. Same eligibility filter as the Codex side (anchored stamp regex + real UTC + 5-min future-skew + regular file). |
| `skill_install_codex` | Codex target-path PR **MERGED** (`VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1`); actions PR **MERGED** (`VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`). | **SHIPPED.** Registered in `api/src/lib/mcp-local-action-runner.ts` with `category: "file_mutation"`, `control_scope: "vo_skill"`, `client_scope: "codex"`. Reuses `resolveCodexSkillTargetPath` / `validateCodexSkillTargetPath` / `CODEX_SKILL_SOURCE_REL_PATH` from the target-path module; does not duplicate resolver logic. Preview re-runs path safety; execute takes a `.bak.<UTC-stamp>` backup before any overwrite. |
| `skill_disable_codex` | same as `skill_install_codex` | **SHIPPED.** Renames `SKILL.md` to `SKILL.md.disabled.<UTC-stamp>`. Atomic rename; never deletes. Refuses if no SKILL.md exists at the target. Reversible via `skill_rollback_codex`. |
| `skill_rollback_codex` | same as `skill_install_codex` | **SHIPPED.** Restores the latest eligible `SKILL.md.bak.<UTC-stamp>` or `SKILL.md.disabled.<UTC-stamp>` sibling — eligibility = anchored stamp regex + real UTC stamp (rejects impossible calendar fields + future stamps beyond 5-min skew) + regular file (rejects symlinks / devices / directories / `.tmp` / prefix-only / malformed stamps). Eligibility does NOT prove runner provenance (no manifest ships today); a file hand-created at the same exact stamp shape is also eligible. Takes a safety `.bak` of the current `SKILL.md` (if any) first so the rollback itself is reversible. |

All six Skill rows SHIP today. The drift guard in
`agent-lab/scripts/lib/mcp-skill-install-controls-design.test.ts`
asserts:

- The design doc names every candidate above AND records the
  per-client state:
    - Claude Desktop — **SHIPPED (VO-provisional)**
      (`VO-MCP-CLAUDE-SKILL-TARGET-PATH-PR-1` shipped the
      target-path; `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`
      shipped the actions; pin is VO-provisional darwin
      only, NOT Anthropic-authoritative).
    - Codex — **SHIPPED** (target-path PR merged as
      `VO-MCP-CODEX-SKILL-TARGET-PATH-PR-1`; the three
      `skill_*_codex` descriptors registered by
      `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`).
- `api/src/lib/mcp-local-action-runner.ts` registers EXACTLY
  the three `skill_*_codex` + three `skill_*_claude_desktop`
  descriptors — no generic / auto-activate / client-unsuffixed
  Skill ids.
- `api/src/routes/dashboard.ts` renders EXACTLY six Skill
  buttons in two dedicated sections
  (`#mcp-codex-skill-actions` + `#mcp-claude-skill-actions`),
  each with an explicit "MCP connection config is NOT touched"
  disclaimer. No generic Skill button.

If Anthropic later publishes an authoritative writable Skills
directory for Claude Desktop that differs from the
VO-provisional pin, the target-path module + the drift guards
must be updated in lockstep — the "VO-provisional" marker
survives until the authoritative path is consumed.

## Audit + UX requirements for the dashboard

Any future dashboard surface built on this design MUST:

- Display the exact file path that any install / uninstall
  would change, BEFORE asking for confirmation.
- Display the exact undo command for every mutation it offers.
- Display the last doctor result (timestamp + exit) and the
  age of the last runtime-acceptance artifact.
- **Never display secrets or bearer tokens.** The client-config
  doctor already redacts `VO_TOKEN`; the dashboard should
  inherit that discipline and display neither raw tokens nor
  raw Authorization headers.
- Render `unknown` / `manual_required` states distinctly from
  `enabled` / `disabled`. Operators must see when evidence is
  missing, not assume good state.

## Non-goals (restated)

- **Skill UI is allowlisted per client, never generic or
  implicit.** Codex Skill buttons shipped in
  `VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`; Claude Desktop Skill
  buttons shipped in
  `VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1` under the
  VO-provisional darwin target pin (NOT Anthropic-
  authoritative). Both surfaces render install / disable /
  rollback buttons in dedicated Skill sections visually
  separated from MCP connection controls. NO generic Skill UI,
  NO auto-activate UI.
- **No new MCP tools, resources, prompts, or routes.**
- **No generic remote MCP host or Skill control path.**
  `mcp.verityone.app` still not shipped; the separate web `/mcp`
  connector has queue-only writes and is not a Skill control surface.
- **No hosted Skill write path.** `/hosted-mcp/*` is hosted
  portable-agent REST, including queue-only write intent, not a
  Skill install/control route.
- **No Skill auto-install.** Default `vo mcp install` installs
  MCP connectivity only. Explicit Skill opt-in ships for both
  Codex (`VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`:
  `skill_install_codex` / `skill_disable_codex` /
  `skill_rollback_codex`) and Claude Desktop
  (`VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`:
  `skill_install_claude_desktop` / `skill_disable_claude_desktop`
  / `skill_rollback_claude_desktop`) as the allowlisted
  dashboard actions — operator confirms each action through
  the preview / confirm flow, never silent. Generic Skill
  opt-in is permanently out of scope.
- **No Skill action mutates MCP client config.** The Claude
  Desktop MCP installer still merges `mcpServers.verity-one`;
  the Codex MCP dashboard actions merge `[mcp_servers.verity-one]`;
  the Codex CLI fallback and generic flows still print blocks
  for the operator to paste. Skill actions stay in the
  `vo_skill` control and do not touch MCP connection config.
- **Shipped surface** (summed across the design-refresh PR,
  the two target-path PRs, and the two actions PRs): this
  design doc, its drift guards, doc pointers, the pure read-
  only Codex resolver helper (`api/src/lib/mcp-skill-target-
  path.ts`) + unit tests, the pure read-only Claude Desktop
  resolver helper (`api/src/lib/mcp-claude-desktop-skill-
  target-path.ts`) + unit tests, six Skill descriptors in the
  local action runner (three `skill_*_codex` + three
  `skill_*_claude_desktop` — all `file_mutation` +
  `control_scope: vo_skill`), six Skill dashboard buttons in
  two dedicated sections (`#mcp-codex-skill-actions` +
  `#mcp-claude-skill-actions`), Codex + Claude Desktop Skill
  strategy implementations (backup-before-write, rename-to-
  disabled, strict-regex rollback, TOCTOU-guarded), and
  extended drift guards pinning both client halves. No
  generic Skill code, no auto-activate code. The Claude
  Desktop target-path pin remains VO-provisional darwin;
  if Anthropic later publishes an authoritative location,
  the module updates in lockstep.

## Related docs

- **`docs/VO-MCP-ACTIVATION.md`** — operator activation flow
  (install → doctor → restart → confirm → record → rerun proof).
- **`docs/VO-MCP-LOCAL-ACTION-RUNNER-DESIGN.md`** — authoritative
  contract for the local `/dashboard` action runner. **Runtime
  runner exists today** (read-only doctors, Claude Desktop
  file_mutation install / force / rollback, and two
  Codex MCP file_mutation install / force / rollback,
  Codex Skill file_mutation install / disable / rollback,
  Claude Desktop Skill file_mutation install / disable / rollback,
  and two artifact_write acceptance recorders); see its
  "Implementation status" table for which descriptors have
  shipped and which remain deferred. That doc carries the
  threat model, action-category taxonomy, preview / confirm /
  execute lifecycle, backup-before-write rule, path-safety
  fence, secret redactor, and mutation-lock semantics this
  Skill-install design refresh defers to. Codex Skill
  install / disable / rollback SHIP in the runner today
  (`VO-MCP-SKILL-INSTALL-ACTIONS-PR-1`); Claude Desktop Skill
  install / disable / rollback also SHIP in the runner today
  (`VO-MCP-CLAUDE-SKILL-INSTALL-ACTIONS-PR-1`, VO-provisional
  darwin pin, NOT Anthropic-authoritative) via a separate actions
  PR that consumes the already-shipped VO-provisional target-
  path validator; generic Skill support stays permanently
  `unsupported`;
  Skill auto-activate + Skill uninstall (as distinct from
  disable) remain explicit non-goals. See the "Skill lifecycle
  under the local action runner" section above for the per-
  client state.
- **`docs/VO-MCP-AGENT-USAGE.md`** — full agent usage kit.
- **`docs/VO-MCP-CROSS-CLIENT-INTEROP-PROOF.md`** — evidence
  matrix and artifact contracts.
- **`docs/VO-MCP-SERVER-CONTRACT.md`** — binding per-rung
  contract.
- **`mcp/skills/verity-one-mcp/SKILL.md`** — the repo-local
  Skill this design eventually governs.
- **`mcp/README.md`** — package overview.
