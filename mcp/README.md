# vo-mcp

Local-first stdio MCP server for Verity One.

This package is a **thin transport adapter** over the local VO HTTP node on
`127.0.0.1:3100`. It exposes a stable stdio MCP surface to any agent client
that speaks MCP, while keeping the local HTTP core as the single authority
for tenant-private memory.

The binding design contract for this package is
[`docs/VO-MCP-SERVER-CONTRACT.md`](../docs/VO-MCP-SERVER-CONTRACT.md). When
the code and the contract disagree, the contract wins.

**If you are an agent (Claude, Codex, or any other MCP client) about to
consume this server, start at
[`docs/VO-MCP-AGENT-USAGE.md`](../docs/VO-MCP-AGENT-USAGE.md).** It is the
short, rung-8-aware usage kit: tool selection decision tree, prompt +
resource consumption patterns, write safety, citation rules, and honest
handling of `unproven` / `manual` cells. For an even shorter
operational brief packaged as a repo-local Skill, see
[`mcp/skills/verity-one-mcp/SKILL.md`](./skills/verity-one-mcp/SKILL.md).
This package README stays operator-facing; the agent-usage kit and
the Skill stay agent-facing.

**If you are an operator setting MCP up for the first time, follow the
activation wayfinding guide at
[`docs/VO-MCP-ACTIVATION.md`](../docs/VO-MCP-ACTIVATION.md).** It
sequences install → client-config doctor → live stdio doctor → restart →
confirm → record runtime acceptance → rerun the interop proof, and
calls out which step proves which thing.

**Dashboard controls live today and keep growing. Read
[`docs/VO-MCP-SKILL-INSTALL-CONTROLS-DESIGN.md`](../docs/VO-MCP-SKILL-INSTALL-CONTROLS-DESIGN.md)
before adding, changing, or reviewing any control.** Current
shipped buttons: read-only doctors (live MCP + per-client config),
Claude Desktop MCP install / repair / rollback, Codex MCP config
install / repair / rollback, acceptance recorders for Claude
Desktop + Codex, Codex VO Skill install / disable / rollback,
and Claude Desktop VO Skill install / disable / rollback (under a
VO-provisional darwin pin — NOT Anthropic-authoritative).
Shipped Skill checkers promote `vo_skill` rows to filesystem states;
Rung 11's Skill-specific acceptance fields can promote installed
Skill rows to `enabled` after operator attestation. Rung 12 ships
the operator-local automated Skill lifecycle proof script as
gitignored evidence. Out of scope permanently: generic-host Skill
install and silent Skill activation.
The design doc pins the
separation between MCP-connection controls and Skill-activation
controls, the status-state model, the dashboard vs local-machine
mutation boundary, and safe install / uninstall semantics. No
dashboard button should bypass that contract.

## Boundary pins

- Local MCP is local stdio only: agent clients spawn the installed Node
  server over stdin/stdout.
- `/hosted-mcp/*` is hosted portable-agent REST, not MCP transport and not
  the local action runner.
- `POST /mcp` is the web connector for MCP, not the local stdio MCP server and
  not the local action runner.
- `mcp.verityone.app` is not shipped.
- Agents must not directly edit client config. They should point operators to
  operator-owned commands or descriptor-backed local dashboard actions with
  preview / confirm / execute.
- MCP connection controls and VO Skill controls remain separate; MCP install
  does not install, invoke, or enable the Skill.
- Runtime acceptance is operator-observed. Record it with
  `agent-lab/scripts/record-mcp-client-acceptance.ts`; repo commands do not
  fabricate GUI acceptance, and GUI acceptance cannot be automated from the
  repo.
- The tenant-facing local proof command is `vo mcp-proof --local`.

## Scope

Rungs 1–8 plus the local day-journal PR10 surface are live — the MCP ladder is feature-complete for the local-first
product shape. **25 tools / 2 static + 2 template resources / 3 prompts**, all
thin adapters over the local HTTP core, the local vault filesystem, or the
local node's anonymous public-graph routes.

Rung 1 (read-only, memory):

- `vo_bootstrap_project` → `POST /bootstrap/project`
- `vo_memory_recall` → `POST /memory/recall`
- `vo_memory_recall_routed` → `POST /memory/recall/routed`
- `vo_memory_get` → `GET /memory/:addr`
- `vo_memory_search` → thin alias for `POST /memory/recall`

Rung 2 (memory writes + composed grounding):

- `vo_memory_write` → `POST /memory/write` (agents: default `source: "agent_inferred"`; include `source_refs` for decision/correction/pattern when a real source exists — never fabricate)
- `vo_memory_update` → `POST /memory/update` (patches only; prefer retract + new write for material changes)
- `vo_memory_retract` → `POST /memory/retract` (prefer over forget whenever there is a reason)
- `vo_memory_forget` → `POST /memory/forget` (archive, no reason)
- `vo_pretask_ground` → composed: `POST /bootstrap/project` then `POST /memory/recall/routed`, returns a verbatim `bootstrap_context` the agent can thread into subsequent writes

Rung 3 (read-only, vault — direct filesystem reads, no HTTP):

- `vo_vault_list` → enumerates finalized (and optionally draft) dossiers in `<vault_root>/dossiers/`, returns per-row filename metadata + frontmatter-derived `title`, `generated_at`, `vo_nodes_count`
- `vo_vault_lookup` → reads one dossier by 8-char hash prefix, returns parsed frontmatter + full markdown content (capped at 256 KB), prefers finalized over draft unless `prefer_draft: true`

Vault tools resolve the vault root via this 4-step chain: tool arg
`vault_root` → `VERITY_VAULT_ROOT` env → `~/.vo/config.json#vault_root` →
structured `validation_failure`. Vault artifacts are **downstream** of the
local VO memory authority: a dossier can exist with an empty `vo_nodes`
list (dossier present but no graph-backed memories). Agents should check
`vo_nodes_count` (or `frontmatter.vo_nodes`) to know whether a dossier is
graph-backed.

Rung 4 (read-only, public overlay — anonymous local calls, no token):

- `vo_public_search` → anonymous `GET /search?q=...` against the local VO node. Returns the public-graph results array under both `results` (verbatim backend field) and `nodes` (contract field name). Result envelope carries top-level `authority: "public_overlay"`.
- `vo_public_context` → anonymous `GET /context?q=...&depth=...` against the local VO node. Returns the raw context body under `sections` plus the rich top-level fields the backend already provides (`depth`, `node_count`, `confidence_grade`, `coverage_honest`, `regrounding`, `applicable_schemas`, `layer_distribution`, `ontology`, `ms`). Result envelope carries top-level `authority: "public_overlay"`.

Rung 4 tools call **only** `127.0.0.1:3100` and **never** send an
`Authorization` header. The access layer in `api/src/lib/access.ts`
resolves anonymous requests to `scope: "anonymous"` with
`spaceIds: [GLOBAL_SPACE_ID]`, structurally restricting results to the
public graph at the SQL layer. Tenant-private memories cannot leak into
rung-4 results because the backend never sees a request that would return
one. The `tenant_auth_failure` error class is structurally impossible from
rung-4 calls; if it ever appears, the implementation has drifted.

Rung 5 (read-only, review/audit — tenant-auth local calls):

- `vo_memory_review` → `GET /memory/review` — lists active `agent_inferred` tenant memories pending human review. Optional `limit` arg (default 20, max 100). Items include `overlay_origin` visibility where applicable.
- `vo_memory_inspect` → `GET /memory/:addr/audit` — compact audit snapshot for a single memory: trust state, provenance, promotion linkage, approval metadata, and recent lifecycle events. Optional `event_limit` (default 10, max 50).

Rung 5 tools are read-only. Approval requires human operator authority and is intentionally CLI-only (`vo memory approve`).

Rung 6 (overlay promotion — tenant-auth local write):

- `vo_overlay_promote` → `POST /memory/promote-overlay` — explicitly promote an imported public overlay into a new tenant-local memory. Required `overlay_addr` arg, optional `reason` (max 500 chars). Promoted memory is always `agent_inferred` — this is NOT approval. Idempotent: already-promoted overlays return `already_promoted: true` with the existing memory address.

Rung 6 promotion creates `agent_inferred` trust state only. Human trust upgrade requires the separate `vo memory approve <addr>` CLI path.

Rung 7 (local vault harvest — narrow write exception):

- `vo_vault_harvest_auto` → `POST /machine/vault/harvest-auto` (local JSON facade over the shared harvest engine in `api/src/lib/vault-harvest.ts`). One `source` arg — **absolute path or http(s) URL only**; relative paths are rejected (they would resolve against the API server's cwd). Runs all 7 stages end-to-end. Returns the engine's `AutoOutcome` verbatim (`success` or one of `stop_missing_key` / `stop_vo_unavailable` (four subReasons) / `stop_finalize_conflict` / `stop_unknown`). No `vault_root` arg — the server's configured root is authoritative. Doc-link is honest-optional: when the server has no operator token, `docLink: "skipped_no_operator_auth"` (one of the canonical engine values — `linked` / `skipped_no_operator_auth` / `skipped_no_project` / `failed`) rather than a fake `"linked"`. **Auth narrowing:** requires an agent-mapped tenant bearer (a token in `VERITY_AGENT_TOKENS` whose agent is mapped in `VERITY_AGENT_TENANTS`). Plain beta tokens and operator tokens — both of which resolve to `access.tenantId: null` — are rejected with `reason: "tenant_scoped_bearer_required"`. All other Rung 1–6 tools still accept beta bearers.

Rung 7 revises — deliberately — the earlier "vault writes are indefinitely out of scope" stance from Rung 3's authority section. It is a **narrow** exception: one tool, one route, one shared engine, no new storage or auth system. Dashboard operators and MCP agents now reach the same engine through different adapters. Rung 3 filesystem reads (`vo_vault_list`, `vo_vault_lookup`) are unchanged.

Day journal (local-only):

- `vo_day_journal_entry_create` → `POST /day-journal/entries` or `POST /day-journal/entries/dry-run` when `dry_run: true`. Requires explicit `VOJ` command text; ordinary prose and reserved starters are refused. Non-dry-run writes require `idempotency_key`.
- `vo_day_journal_entry_retract` → `POST /day-journal/entries/:entry_key/retract`. Retracts a manual VOJ entry by `entry_key` with required `idempotency_key` and optional audit reason.
- `vo_day_journal_day_get` → `GET /day-journal/day/:addr`. Reads one local day journal by TMP day address.
- `vo_day_journal_search` → `GET /day-journal/search`. Searches normalized local journal entries by date, routine, domain, tag, sensitivity, or preview text.
- `vo_day_journal_routines_list` → `GET /day-journal/routines`. Lists routine definitions plus tenant settings.
- `vo_day_journal_routine_dry_run` → `POST /day-journal/routines/:id/dry-run`. Executes a registered routine without writing the journal entry, but still runs routine code, may perform declared effects such as outbound network calls, and updates the dry-run marker used by enablement guardrails. Non-standard sensitivity or extra-permission routines require operator scope.
- `vo_day_journal_routine_run` → `POST /day-journal/routines/:id/run`. Runs an enabled registered routine now with either `idempotency_key` or `generate_idempotency_key=true`. Non-standard sensitivity or extra-permission routines require operator scope.

These tools are local stdio MCP only. Hosted/web MCP uses mirrored reads and queue-only command intent rather than direct local authority calls.

Rung 8 (read-only resources + pure prompts — MCP context surfaces):

Resources (consumable as first-class context by any MCP client that walks
`resources/list` + `resources/templates/list`):

- `vo://server/status` (static) → pure-local JSON snapshot: server
  name/version, local VO base URL, auth-source *class* (never the token
  value), and counts of registered tools, resources, and prompts.
- `vo://memory/review/pending` (static) → `GET /memory/review?limit=20`.
  On a stale API that hasn't mounted `/memory/review`, the handler throws
  `ResourceReadError(routeUnavailable: true)` so the interop runner
  classifies the cell as `unproven` rather than `fail`.
- `vo://memory/{addr}` (template, discoverable via
  `resources/templates/list`) → `GET /memory/:addr`. Requires a concrete
  `PJ.x.y.z` addr — the resource layer never searches or ranks.
- `vo://memory/{addr}/audit` (template) → `GET /memory/:addr/audit`.
  Same addr-shape validation + error semantics as
  `vo://memory/{addr}`.

Prompts (pure string-producing handlers — no I/O, no state mutation):

- `vo_recall_context` → guides the agent to ground a task via
  `vo_pretask_ground` (when `project_addr` is provided) or
  `vo_memory_recall_routed` (when not). Enforces: cite addrs verbatim,
  never fabricate memory content, never write from this prompt.
- `vo_what_do_we_know_about` → guides the agent to de-duplicate
  `vo_memory_search` + `vo_memory_recall_routed` by addr. Same
  citation / no-fabrication rules.
- `vo_remember_decision` → write-safety guidance for
  `vo_memory_write`. Defaults `source: agent_inferred`, never
  fabricates `source_refs`, uses `supersedes` for revisions, threads a
  `bootstrap_context` from a fresh `vo_pretask_ground` when the
  decision is project-scoped.

Resources + prompts never add a new error class, a new HTTP route, or
a new write path. They adapt state the local VO already owns.

Explicitly **not** in rungs 1–8: public-graph write tools (operator-only
`vo publish` CLI path), `vo_public_trends` (the `/trends` route is not
yet structurally access-scoped — see contract), `vo_public_ground` /
`vo_public_insight` (beta-required routes; no clean strictly-public path
without touching `api/src/`), bulk writes, HTTP/SSE transport, remote
MCP, any cloud broker, MCP elicitation / tasks / apps. Non-harvest
vault writes (confirm, finalize, delete) remain the CLI's responsibility.

The **one** place MCP adds client-side validation is the `vo_memory_write`
refusal of `source: "system_generated"`, which is reserved for server-side
writers. Everything else is backend-authoritative (or filesystem-honest in
the vault case, or anonymously-restricted in the public-feed case).

## Preferred path: `vo-mcp` (standalone)

This package ships a standalone launcher, **`vo-mcp`** (the bin at
`mcp/bin/vo-mcp`). It is the connect path every install gets — the public
source install does NOT include the full `vo` CLI (that lives in a private
tree). The source-install bootstrap symlinks `vo-mcp` into `~/.local/bin`,
so once this package is built the bare `vo-mcp …` command resolves.

The repo-root `bun install` does not build `mcp/` (the root workspaces
deliberately omit it), so build it once, then install + verify. Commands
use the absolute install-root path so they work from any shell cwd
(assuming the default `~/verity-one` install root — adjust if you
installed elsewhere):

```sh
bun install --cwd ~/verity-one/mcp
bun run --cwd ~/verity-one/mcp build
vo-mcp install --client claude-desktop
vo-mcp doctor
```

If `vo-mcp` is not yet on your `PATH`, call it by path —
`~/verity-one/mcp/bin/vo-mcp …` (or `./bin/vo-mcp …` from inside this
package); it is the same binary.

Run `vo-mcp install` **after** tenant init — the MCP server resolves
tenant auth from `~/.vo/config.json`, so sequencing matters. `vo-mcp
doctor` validates the *installed* copy under `~/.vo/mcp/`, so it stays
valid even if the repo's `mcp/dist` is later rebuilt, deleted, or moved.

> **If you have the full private `vo` CLI** (not part of the OSS
> distribution), `vo mcp install` / `vo mcp doctor` are equivalent thin
> wrappers over the same `install()` / `doctor()` functions this package
> exports — they hand the library a real Node binary so the contract holds
> even when `vo` runs under Bun. `vo mcp …` and `vo-mcp …` produce an
> identical `~/.vo/mcp/` layout and Claude Desktop config entry. Public
> source installs should use the standalone `vo-mcp`.

## Install direct (from inside the package)

From inside this package:

```sh
npm install
npm run build
./bin/vo-mcp install --client claude-desktop
```

Then restart Claude Desktop. The MCP server will be spawned by Claude Desktop
as a child process via an absolute path:

```
command: /abs/path/to/node
args:    [/abs/path/to/~/.vo/mcp/dist/server.js]
env:     { VO_URL: "http://127.0.0.1:3100" }
```

Note: no tenant token is written into the Claude Desktop config. The server
resolves the token from `~/.vo/config.json` at startup, matching the existing
`vo` CLI precedence.

## Install (Codex)

```sh
./bin/vo-mcp install --client codex
```

This prints a pasteable `[mcp_servers.verity-one]` TOML block for
`~/.codex/config.toml` plus the absolute-path `command` and `args[0]`
the server needs. The installer does **not** write `~/.codex/config.toml`
automatically; this CLI path stays paste-only. The dashboard's
`mcp_onboard_codex` / `mcp_onboard_codex_force` actions own the
parser-backed merge into a live Codex config. Paste the block into an
existing `[mcp_servers.*]` section (or add the section) and restart
Codex when using the CLI fallback. See
`docs/VO-MCP-SERVER-CONTRACT.md` for the shape contract.

## Install (any other MCP client)

```sh
./bin/vo-mcp install --client generic
```

This prints the JSON block you paste into your client's MCP config.
Supported install destinations today: `claude-desktop`, `codex`, and
`generic`. Cursor and Zed are not handled automatically — use
`--client generic` and paste the block by hand until a later rung
adds them.

## Doctor

```sh
vo-mcp doctor      # standalone — the public path
# or, from inside the package:
./bin/vo-mcp doctor
# (with the full private vo CLI, `vo mcp doctor` is equivalent)
```

Spawns the installed MCP server, runs the 4-step MCP handshake
(`initialize`, `notifications/initialized`, `tools/list`, `tools/call
vo_memory_recall`), verifies the registered tool surface, and prints a one-line
summary.

`vo-mcp doctor` and `vo mcp doctor` (private CLI) both invoke this
package's `doctor()` function — the `vo` wrapper passes an explicit Node
binary so the child process the doctor spawns is always Node ≥ 20 per
contract, never Bun.

### Client-aware doctor (read-only config check)

```sh
vo-mcp doctor --client claude-desktop
vo-mcp doctor --client codex
```

Read-only validation of the on-disk client config. Answers:

- Is the client's config file present where the installer expects it?
- Does it carry an `mcpServers.verity-one` entry (Claude Desktop) or an
  `[mcp_servers.verity-one]` section (Codex)?
- Are `command` and `args[0]` absolute paths that exist on disk?
- Is `VO_URL` set and `VO_TOKEN` correctly absent (server resolves
  tenant auth from `~/.vo/config.json`)?

Never mutates the config file. A green client-doctor pass plus a
green live-handshake doctor pass covers every precondition except GUI
acceptance. Restarting the client and confirming the tools appear is
the only manual step that remains.

## Manual run (debug only)

```sh
./bin/vo-mcp serve
```

`vo-mcp serve` is a manual/debug entrypoint only. Agent clients never spawn
`vo-mcp serve` — they spawn `node ~/.vo/mcp/dist/server.js` directly. This is
enforced by `vo-mcp install`, which always writes the direct-spawn shape.

## Self-check (registered surface proof)

```sh
npm run build
node dist/self-check.js
```

Verifies all 25 registered tools are advertised and exercises representative
live tool paths. Rung-1 and rung-2 assertions run against the live
local VO node on `127.0.0.1:3100` with the tenant token. Rung-3 vault
assertions run against a temporary vault fixture created under the OS temp
dir (with `.vo-vault.json`, a clean finalized dossier, an empty-vo_nodes
dossier, a draft dossier, a malformed-frontmatter dossier, two dossiers
with the same hash prefix for the ambiguous-lookup path, and a
finalized+draft pair for prefer_draft). Rung-4 public-feed assertions hit
the live local node anonymously and verify the `authority: "public_overlay"`
envelope, the absence of top-level memory-shaped fields, and the structural
impossibility of `tenant_auth_failure` from any rung-4 call. Rung-7 assertions exercise
`vo_vault_harvest_auto` client-side refusal paths (empty source,
relative path, bare filename) — **no real harvest runs during
self-check**, because harvest would write files and hit LLMs. The
self-check proves the tool is registered, the handler executes, and
the `validation_failure` envelope shape is intact. Negative cases
include `local_vo_unreachable` (via `VO_URL=http://127.0.0.1:1`), the
`system_generated` refusal, ambiguous vault hash, not-found vault hash,
malformed vault frontmatter, `vault_root not configured`, rung-4
`tenant_auth_failure` drift detection, and rung-7 source-shape refusal. Every temp memory is
retracted/forgotten and every temp vault is `fs.rm`'d in `try/finally` so
the live graph and the filesystem stay clean. Not shipped to tenants.

## Auth resolution order

Per the binding contract, exactly:

1. `~/.vo/config.json` — prefer `agent_token`, fall back to `access_token`
2. `VO_TOKEN` environment variable (fallback only)
3. Structured error to stderr and non-zero exit

The server never falls back to any public VO endpoint.

## Error classes

Every tool-call failure maps to exactly one of:

- `local_vo_unreachable` — connection to `127.0.0.1:3100` fails
- `tenant_auth_failure` — HTTP 401/403
- `validation_failure` — HTTP 400 or 404 (`vo_memory_get` memory-not-found)
- `upstream_error` — HTTP ≥ 500 or non-JSON or unexpected shape

Error envelope shape:

```json
{
  "error_class": "local_vo_unreachable",
  "message": "local VO unreachable at http://127.0.0.1:3100",
  "detail": "ECONNREFUSED: ...",
  "hint": "run: vo doctor; ensure the local VO node is running"
}
```

## Logging

All logs go to stderr, one JSON object per line. stdin/stdout are reserved
for MCP JSON-RPC traffic. Agent clients that don't surface stderr will see a
silent tool failure instead of a diagnostic — run `./bin/vo-mcp doctor`
separately in a terminal for visible diagnostics.

## Package boundary

This package never imports from `api/src/`, `agent-lab/scripts/`, or
`miners/`. It is a standalone Node package with its own `node_modules` and
its own build. The dependency direction is one-way: the main `vo` CLI
imports `install()` / `doctor()` from this package (for `vo mcp install`
/ `vo mcp doctor`), but this package imports nothing from the repo's
other directories.

Tenant-facing entrypoints:

- `vo-mcp install` / `vo-mcp doctor` / `vo-mcp serve` — the standalone
  binary; the default for the public source install
- `vo mcp install` / `vo mcp doctor` — equivalent wrappers, available only
  with the full private `vo` CLI (same library underneath)

If this package starts re-implementing ranking, routing, validation, or
storage logic, the rung is off course.
