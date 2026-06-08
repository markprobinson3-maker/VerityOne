# VO MCP Server Contract

Date: 2026-04-09

Concrete read-only design contract for the first MCP code rung. Everything
below is binding input for `MCP-LOCAL-READ-ONLY-PR-1`. Anything not specified
here is out of scope for rung 1.

## Purpose

Expose local VO to agents through one stable, tenant-local stdio MCP surface,
while keeping the local HTTP node on `127.0.0.1:3100` as the authority.

## Authority Model

The MCP server is:

- a tenant-local process
- a stdio JSON-RPC adapter
- a client of the local VO HTTP node on `127.0.0.1:3100`
- the default agent integration surface

The MCP server is not:

- a second memory authority
- a new storage layer
- a replacement for the local HTTP routes
- a hosted/public transport surface

The local HTTP core remains first-class and is not deprecated by this
contract. Any script, serverless function, or non-MCP agent continues to call
`/memory/*`, `/bootstrap/*`, and `/remember` directly over HTTP.

## Default Transport

Rung 1 transport is:

- local stdio only
- tenant-local process only
- outbound/local-node calls only
- newline-delimited JSON-RPC 2.0 framing (no Content-Length framing)

Rung 1 is explicitly not:

- remote MCP
- HTTP/SSE MCP transport
- inbound cloud reachability
- broker/tunnel architecture

## Runtime Decision

The MCP server runs on **Node** (>= 20 LTS), not Bun, even though the rest of
VO runs on Bun.

Rationale:

1. Every MCP client (Claude Desktop, Codex, Cursor, Zed, generic tooling) can
   already spawn `node` and resolves it reliably. Bun is not guaranteed.
2. The reference MCP SDK (`@modelcontextprotocol/sdk`) is officially supported
   on Node.
3. `MCP-R0-PR-1` proved a dependency-free raw-JSON-RPC Node harness works
   end-to-end against the canonical rung-1 routes. The runtime is already
   exercised.
4. The pre-existing Claude Desktop VO MCP server at
   `~/.claude/mcp-servers/vo-server/index.js` is Node-based and has been
   stable since March.
5. Keeping Node for MCP isolates a single bun → node boundary at the package
   edge, rather than leaking Bun requirements into every tenant's MCP client
   config.

This does not change how the VO HTTP node itself runs. `api/src/index.ts`
continues to run under Bun. The `mcp/` package is Node-only.

## Package Boundary

The MCP server lives in a new top-level package:

- `mcp/` at the repo root
- sibling of `api/`, `agent-lab/`, `miners/`
- its own `package.json`, its own `node_modules`, its own `tsconfig.json`
- the only cross-package import permitted is **type-only** import of wire
  types from `api/src/lib/memory-contract.ts` (e.g., `MemoryKind`,
  `SourceKind`). No runtime code import.

The MCP server must not:

- add routes to `api/src/index.ts`
- add handlers to `api/src/routes/*`
- add cases to `agent-lab/scripts/vo-cli.ts`
- reimplement ranking, routing, validation, or storage logic
- introduce its own database connection
- cache memory results across calls

If the `mcp/` package grows past ~500 lines of real logic in rung 1, or
reimplements anything already present in `api/src/lib/recall-compiler.ts`,
`api/src/lib/domain-router.ts`, or `api/src/lib/memory-contract.ts`, the rung
is off course and the PR is rejected.

## Authentication

### Resolution order

The MCP server resolves the tenant bearer token in this exact order:

1. **`~/.vo/config.json`** — parsed once at process start. Prefer
   `agent_token`; fall back to `access_token`. This is the same precedence
   the existing CLI (`agent-lab/scripts/vo-cli.ts`) uses. `base_url` is also
   read here; `localhost` is normalized to `127.0.0.1` to match `api/src/lib/access.ts`
   allowlisting.
2. **`VO_TOKEN` environment variable** — used only if `~/.vo/config.json` is
   missing or contains no usable token. This is the *fallback*, not the
   default.
3. **Explicit structured error** — if neither source yields a token, the MCP
   server exits with a non-zero code and emits one structured error line to
   stderr before exiting. It does not continue unauthenticated.

### No tokens in client JSON (documented path)

The install posture must not put the tenant bearer token into any MCP client's
configuration file (e.g., `claude_desktop_config.json`). The documented path
is `~/.vo/config.json`; the env var fallback exists for diagnostic and CI
scenarios only.

The `vo-mcp install` command (see below) must never write `VO_TOKEN` into a
client config file by default.

### No new tokens, no new auth flows

The MCP server must not:

- issue new tokens
- perform OAuth, SSO, JWKS, or CF Access handshakes
- call `/federation/register` or `/federation/refresh`
- inject broker trust headers
- invent any credential the CLI does not already produce

## Install Posture

### Binary name

The `mcp/` package publishes a single standalone CLI binary named **`vo-mcp`**.
It is a separate executable from the existing `vo` CLI (`agent-lab/scripts/vo-cli.ts`).
The two executables never merge. `vo-mcp` remains the standalone binary that
owns MCP install/doctor/serve semantics; `vo mcp install` and `vo mcp doctor`
are **thin library-wrapper subcommands** that call the SAME `install()` /
`doctor()` / `doctorClient()` functions via lazy dynamic import and must not
re-implement any MCP behavior (no new config layout, no shell-out to `vo-mcp`,
no separate auth resolution). Either tenant path produces an identical
`~/.vo/mcp/` layout and an identical client-config entry. `vo doctor --mcp`
stays an unrecognized command — MCP doctor lives only under the `mcp`
subcommand namespace. If `vo-cli.ts` ever grows its own install/doctor
implementation, the rung is off course. See non-negotiable #12 for the
binding wording.

- `vo-mcp install --client <name>` — install MCP wiring into an agent client
- `vo-mcp doctor` — verify the installed MCP server end-to-end
- `vo-mcp serve` — **manual/debug entrypoint only**, used for local smoke
  tests and the `vo-mcp doctor` handshake. It is **not** the install contract:
  agent clients never spawn `vo-mcp serve` as a child and nothing that
  `vo-mcp install` writes references it.

Package shape:

```json
{
  "name": "vo-mcp",
  "bin": { "vo-mcp": "./bin/vo-mcp" },
  "main": "./dist/server.js"
}
```

The `bin` field points at a shell-script launcher in `mcp/bin/vo-mcp` rather
than at the raw `dist/cli.js`, so the npm-bin convention works cleanly on
POSIX without forcing every Node installation into the shebang line. The
launcher resolves its own package root via `readlink`, so it is safe to
symlink into a PATH directory.

The installed client-spawn contract is the direct form specified in the
*Absolute-path requirement* section below: agent clients spawn
`node ~/.vo/mcp/dist/server.js` directly. This avoids any `vo-mcp`-on-PATH
resolution concerns inside MCP clients and removes one process hop per tool
call. `vo-mcp serve` exists solely so the tenant and the doctor harness have
a named way to run the server by hand.

The existing `vo` CLI remains the tenant's daily-driver command for
non-MCP flows (`vo doctor`, `vo init`, `vo pretask-ground`, `vo recall`, etc.).
MCP-specific concerns live behind `vo-mcp` only. This resolves the otherwise
unresolvable tension between "MCP lives in its own package" and "tenants need
a command to install it" — the command lives in the new package, and the
existing `vo` CLI is not touched.

### Absolute-path requirement

Every MCP client config entry the `vo-mcp install` command writes must use
**absolute** paths for both the interpreter and the server entrypoint. PATH
inheritance across stdio child-process boundaries is fragile and
`MCP-R0-PR-1` hit exactly this failure during the hand proof. The absolute
path requirement is a hard rule.

Example shape of what `vo-mcp install --client claude-desktop` writes into
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "verity-one": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/<tenant>/.vo/mcp/dist/server.js"],
      "env": {
        "VO_URL": "http://127.0.0.1:3100"
      }
    }
  }
}
```

Notes on the shape:

- `command` is absolute (not `node`)
- `args[0]` is absolute (not a relative path, not a shell expansion)
- `env` contains only `VO_URL`. No `VO_TOKEN`. The server reads the token
  from `~/.vo/config.json`.
- The server entrypoint lives under `~/.vo/mcp/dist/server.js` after
  `vo-mcp install`, independent of the repo checkout location. Agent clients
  spawn `node ~/.vo/mcp/dist/server.js` **directly** — they do not go through
  the `vo-mcp` CLI wrapper at spawn time, to avoid a second process hop and
  any `vo-mcp`-on-PATH resolution concerns inside MCP clients.
- `vo-mcp install` also writes an executable launcher to
  `~/.vo/mcp/bin/vo-mcp` so the tenant has a stable `vo-mcp` entrypoint for
  post-install use (`vo-mcp doctor`, `vo-mcp install --client ...`) after the
  repo checkout is deleted or moved. Tenants put `vo-mcp` on PATH by
  symlinking `~/.vo/mcp/bin/vo-mcp` into a directory that is already on
  PATH (e.g. `~/.local/bin`). The install command **must not** modify the
  tenant's shell profile or write to system PATH directories.
- `vo-mcp install` **must** prune build-time dev dependencies (e.g.
  `typescript`, `@types/*`) from `~/.vo/mcp/node_modules` so the tenant
  install footprint reflects runtime needs only.
- `vo-mcp install` **must** be safe to re-run from the installed location
  (self-update). When the source and destination resolve to the same path,
  the install skips the filesystem copy and only refreshes the client config
  and launcher.

### `vo-mcp install --client <name>` (shipped)

The installer is shipped in the `mcp/` package under the `vo-mcp`
binary. Requirements, binding as written:

- accepts `--client claude-desktop|codex|generic` (supported) and
  refuses `--client cursor|zed` with an honest error until a later
  rung implements them
- locates the target client's config file by documented path
- for `claude-desktop`: merges a `mcpServers.verity-one` entry with
  absolute paths into
  `~/Library/Application Support/Claude/claude_desktop_config.json`
- for `codex`: prints a pasteable `[mcp_servers.verity-one]` TOML
  block for `~/.codex/config.toml` to stdout. The installer does
  NOT write `~/.codex/config.toml` itself. The local dashboard's
  `mcp_onboard_codex` / `mcp_onboard_codex_force` actions own the
  parser-backed automated merge; the CLI remains a terminal/manual
  workflow that prints the block
- for `generic`: prints the JSON block the operator pastes into
  their client's MCP config
- refuses to overwrite an existing `verity-one` entry without `--force`
- exits with a clear message explaining which file it wrote (if
  any) and that the client must be restarted
- never modifies any file outside the target client's config file

The `mcp/` package is still the authority for install semantics:
`install()` lives in `mcp/src/install.ts` and is re-exported for
tenant-facing wrappers. The main `vo` CLI now ships `vo mcp
install` and `vo mcp doctor` as thin wrappers that call the SAME
library functions (`install()` / `doctor()` / `doctorClient()`)
via lazy dynamic import — they do not shell out to `vo-mcp`,
re-implement install semantics, or write any new config layout.
Both tenant paths (`vo-mcp install --client …` and
`vo mcp install --client …`) produce an identical `~/.vo/mcp/`
layout and an identical client-config entry. See
`VO-MCP-TENANT-DEFAULT-FIRST-RUN-PR-2` for the wrapper contract.

### Restart requirement

Every supported MCP client reads its config only at launch. Tenants must quit
and relaunch the client after `vo-mcp install`. The command must print this
instruction on success.

## Logging and Diagnostics

### stderr convention

stdin and stdout are reserved for MCP JSON-RPC traffic. All logging goes to
stderr.

The MCP server writes **one JSON object per line to stderr** for every
significant event:

```
{"ts":"2026-04-09T16:23:01.412Z","level":"info","event":"init","protocolVersion":"2024-11-05"}
{"ts":"2026-04-09T16:23:01.488Z","level":"info","event":"tool_call","tool":"vo_memory_recall","ms":73,"status":200}
{"ts":"2026-04-09T16:23:02.019Z","level":"warn","event":"tool_call","tool":"vo_memory_get","ms":4,"status":"error","error_class":"not_found"}
```

Required log fields:

- `ts` — ISO-8601 UTC timestamp
- `level` — `debug` | `info` | `warn` | `error`
- `event` — short string identifier

Optional per-event fields: `tool`, `ms`, `status`, `error`, `request_id`,
`protocolVersion`.

No free-form prose. No multi-line stack traces on the happy path. Stack
traces on fatal startup errors only.

### `vo-mcp doctor` contract

The first code rung (`MCP-LOCAL-READ-ONLY-PR-1`) must also ship a doctor
subcommand under the `vo-mcp` binary — **inside the `mcp/` package**, not
inside `vo-cli.ts` — that:

1. Spawns the installed MCP server as a child process
2. Runs the four-step MCP handshake: `initialize`, `notifications/initialized`,
   `tools/list`, `tools/call` with `vo_memory_recall` using the query
   `"doctor check"`
3. Captures stderr separately from stdout
4. Verifies:
   - `initialize` returns a valid result with matching `protocolVersion`
   - `tools/list` returns exactly the registered `TOOL_NAMES` surface
   - `vo_memory_recall` returns HTTP status 200 and `body.ok === true`
   - process exits cleanly on SIGTERM
5. Prints a single-line summary: `vo-mcp doctor: OK (N tools, recall ok, XXms)`
   or a structured failure with the first stderr error line
6. Exits 0 on pass, 1 on fail

This is the tenant's only debugging surface. The `MCP-R0-PR-1` rung-0
disposable driver at `/tmp/vo-mcp-r0-driver.mjs` is the structural blueprint.

## Error Envelope

### Error classes

Every tool call that fails must return one of these error classes in the
MCP result envelope. The MCP server must distinguish between them honestly.

| Class                  | Trigger                                                                      |
|------------------------|------------------------------------------------------------------------------|
| `local_vo_unreachable` | HTTP connection to `127.0.0.1:3100` fails (ECONNREFUSED, ETIMEDOUT, DNS)    |
| `tenant_auth_failure`  | HTTP response from local VO is `401` or `403`                                |
| `not_found`            | Tool-specific missing resource response where the requested object is absent |
| `validation_failure`   | HTTP response from local VO is `400` with a validation error body            |
| `upstream_error`       | HTTP response is `>= 500`, or unexpected shape, or body not JSON             |

An error class is not optional. Every failure path maps to exactly one class.

### Error envelope shape

When a tool call fails, the MCP `tools/call` response returns
`isError: true` and a structured content block:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error_class\":\"local_vo_unreachable\",\"message\":\"local VO unreachable at http://127.0.0.1:3100\",\"detail\":\"connect ECONNREFUSED 127.0.0.1:3100\",\"hint\":\"run: vo doctor; ensure the local VO node is running\"}"
    }
  ],
  "isError": true
}
```

The `text` field is a JSON-encoded string with these exact fields:

- `error_class` — one of the classes above
- `message` — short human-readable summary
- `detail` — optional technical detail (e.g., errno, HTTP status)
- `hint` — actionable next step for the agent or the tenant

### Local-VO-unreachable behavior

When the MCP server cannot reach `127.0.0.1:3100`:

1. It **must not** fall back to any public VO endpoint, cloud broker, or
   hosted surface. Not even as a read. Not even with a warning.
2. It must return `local_vo_unreachable` with `hint: "run: vo doctor; ensure
   the local VO node is running"`.
3. It must log the failure to stderr with `event: "local_unreachable"`.
4. It must continue serving subsequent requests (one unreachable call does
   not kill the server). The next `tools/call` will retry fresh.

### Validation-failure pass-through

When the local VO HTTP core returns `400` with a validation error (e.g., a
query field missing, an addr malformed), the MCP server must pass the
validation error through unmodified in `detail`. It must not reinterpret,
rewrite, or soften validation errors. The HTTP core is the validation
authority.

## Rung 1 Tool Surface

Five tools, all read-only.

### Tool name convention

MCP tool names on the wire use **underscored snake_case**, not dotted names,
for compatibility with every known MCP client's tool-name validator.
Documentation and logical references may use dotted names.

| Logical name              | Wire name (MCP `tool.name`)    |
|---------------------------|--------------------------------|
| `vo.bootstrap.project`    | `vo_bootstrap_project`         |
| `vo.memory.recall`        | `vo_memory_recall`             |
| `vo.memory.recall.routed` | `vo_memory_recall_routed`      |
| `vo.memory.get`           | `vo_memory_get`                |
| `vo.memory.search`        | `vo_memory_search`             |

Everywhere below, names use the wire form.

### Shared response-envelope rule

Every tool's successful result is a single MCP content block:

```json
{
  "content": [{ "type": "text", "text": "<JSON-encoded result payload>" }],
  "isError": false
}
```

The `text` field is the **JSON-stringified** payload shape documented under
each tool. Agents that parse tool output should `JSON.parse(content[0].text)`.

This convention matches the rung-0 hand-proof shape and is what the
reference MCP SDK produces when the server returns a `content: [{type:"text", ...}]` block.

### Shared `inputSchema` conventions

All `inputSchema` values are JSON Schema draft 2020-12. All tools use
`"additionalProperties": false` to make agent misuse loud rather than silent.
All enum values match the canonical memory contract in
`api/src/lib/memory-contract.ts`.

---

### Tool 1: `vo_bootstrap_project`

**Purpose.** Bootstrap the current tenant workspace. Returns inferred project,
bootstrap posture, workspace-routing safety flag, tenant memory, and
project-scoped memory when routing is safe. This is the first call an agent
should make at session start.

**Backend route.** `POST /bootstrap/project`

**Backend source.** `api/src/routes/bootstrap.ts`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Absolute path to the tenant's current workspace. Defaults to the MCP server's own cwd if omitted."
    },
    "goal": {
      "type": "string",
      "maxLength": 2000,
      "description": "Freeform description of the agent's task. Guides project inference and recall."
    },
    "workspace_name": {
      "type": "string",
      "description": "Optional workspace label (e.g. monorepo subproject name)."
    },
    "repo_slug": {
      "type": "string",
      "description": "Optional repository slug for project inference."
    },
    "explicit_project_addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Optional override: bypass inference by naming the project addr directly."
    }
  }
}
```

**Output payload** (JSON-stringified into the content block).

```json
{
  "ok": true,
  "inferred_project": { "addr": "PJ.0.1.123", "label": "VO Beta Rollout", "confidence": "high", "source": "cwd_match" },
  "candidates": [],
  "project_memory": {
    "used": true,
    "project_addr": "PJ.0.1.123",
    "project_label": "VO Beta Rollout",
    "primary_memories": [ /* RecalledMemory[] */ ],
    "supporting_memories": [ /* RecalledMemory[] */ ]
  },
  "tenant_memory": {
    "used": true,
    "primary_memories": [ /* RecalledMemory[] */ ]
  },
  "bootstrap_posture": {
    "status": "project_backed",
    "note": "..."
  },
  "safe_for_workspace_routing": true,
  "workspace_routing_reason": "...",
  "recommended_write_shape": { "project_addr": "PJ.0.1.123", "scope": "project" },
  "bootstrap_context": {
    "project_addr": "PJ.0.1.123",
    "project_label": "VO Beta Rollout",
    "confidence": "high",
    "source": "cwd_match",
    "tenant_id": "acme",
    "issued_at": "2026-04-09T16:23:01.412Z"
  },
  "ms": 87
}
```

The MCP server does not reshape this payload. It is the raw `/bootstrap/project`
response body. Any drift in the payload shape is a backend change in
`api/src/routes/bootstrap.ts` and is authoritative.

**Failure cases.**

| Cause                                         | Error class            |
|-----------------------------------------------|------------------------|
| `127.0.0.1:3100` refuses connection           | `local_vo_unreachable` |
| HTTP 401/403 from local VO                    | `tenant_auth_failure`  |
| HTTP 400 (invalid `explicit_project_addr`)    | `validation_failure`   |
| HTTP 5xx from local VO                        | `upstream_error`       |

---

### Tool 2: `vo_memory_recall`

**Purpose.** Recall tenant memories matching a natural-language query. Uses
the canonical recall compiler with scoring by relevance, freshness,
provenance, and conflict-freeness. This is the default recall path.

**Backend route.** `POST /memory/recall`

**Backend source.** `api/src/routes/memory.ts`, `api/src/lib/recall-compiler.ts`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000,
      "description": "Natural language recall query."
    },
    "kinds": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["decision", "preference", "correction", "context", "pattern", "vision", "changelog", "digest"]
      },
      "description": "Optional filter on memory kinds."
    },
    "project_addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Optional filter to memories associated with a tenant project root."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "description": "Maximum number of primary memories to return (default backend-determined)."
    },
    "include_inactive": {
      "type": "boolean",
      "description": "If true, include superseded/retracted memories."
    }
  }
}
```

**Output payload.** The raw `/memory/recall` response body, shaped by the
`RecallResult` type in `api/src/lib/recall-compiler.ts`:

```json
{
  "ok": true,
  "query": "vo local-first architecture",
  "primary_memories": [ /* RecalledMemory[] */ ],
  "supporting_memories": [ /* RecalledMemory[] */ ],
  "changes_since": [],
  "conflicts": [],
  "stale": [],
  "fresh_research_needed": null,
  "confidence": { "relevance": "high", "freshness": "high", "provenance": "medium", "conflict_free": "high", "summary": "..." },
  "next_move": null,
  "error_recovered": false,
  "recovery_reason": null,
  "explanation": {
    "candidates_scored": 18,
    "excluded_count": 2,
    "excluded_reasons": ["retracted", "low-relevance"],
    "posture": "memory_backed",
    "posture_note": "...",
    "routing_method": "none",
    "routed_family": null
  },
  "ms": 11
}
```

Every `RecalledMemory` item includes `addr`, `label`, `kind`, `source`,
`assertion`, `why_it_matters`, `relevance`, `freshness`, `provenance_score`,
`conflict_free`, `composite_score`, `created_at`, `effective_at`,
`superseded_by`, `status`, `federation`, `project_addr`, `project_label`,
and `explanation`. The canonical definition lives in
`api/src/lib/recall-compiler.ts#RecalledMemory`. The MCP server does not
reshape it.

**Failure cases.**

| Cause                              | Error class            |
|------------------------------------|------------------------|
| Unreachable                        | `local_vo_unreachable` |
| 401/403                            | `tenant_auth_failure`  |
| 400 (empty query, too long, bad kinds) | `validation_failure` |
| 5xx                                | `upstream_error`       |

---

### Tool 3: `vo_memory_recall_routed`

**Purpose.** Domain-aware recall. Classifies query intent
(ops/rollout/workspace/mixed), selects a first-pass domain, widens if
results are weak, and returns a `routing` trace in addition to the
`RecallResult` shape. Use when the agent wants domain-scoped recall and
visible routing behavior.

**Backend route.** `POST /memory/recall/routed`

**Backend source.** `api/src/routes/memory.ts`, `api/src/lib/domain-router.ts`

**Input schema.** Identical to `vo_memory_recall` input schema (same fields,
same validation). Backend accepts the same body on both endpoints.

**Output payload.** The raw `/memory/recall/routed` response body — identical
to `vo_memory_recall` output, **plus** two additive fields:

```json
{
  /* ... all vo_memory_recall fields ... */

  "routing": {
    "query": "...",
    "classified_intent": "workspace",
    "intent_scores": { "ops": 0, "rollout": 0, "workspace": 3 },
    "first_pass_domain": "VO Beta Rollout",
    "first_pass_project_addr": "PJ.0.1.123",
    "first_pass_result_count": 5,
    "first_pass_avg_relevance": 0.78,
    "widened": false,
    "widen_sequence": [],
    "final_primary_domains": ["VO Beta Rollout"],
    "final_confidence": "high",
    "missing_bootstrap_context": false,
    "mixed_query": false,
    "warnings": []
  },

  "split_results": {
    "mixed_split": true,
    "ops":     { "domain": "VO Tenant Operations", "memories": [], "result_count": 0 },
    "rollout": { "domain": "VO Beta Rollout",       "memories": [], "result_count": 0 }
  }
}
```

`split_results` is present only for mixed-intent queries. The shape is
authoritative in `api/src/lib/domain-router.ts#RoutedRecallResult`.

**Failure cases.** Identical to `vo_memory_recall`.

---

### Tool 4: `vo_memory_get`

**Purpose.** Fetch a single tenant memory by its canonical address.

**Backend route.** `GET /memory/:addr`

**Backend source.** `api/src/routes/memory.ts`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["addr"],
  "properties": {
    "addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Canonical memory address, e.g. PJ.0.3.512."
    }
  }
}
```

**Output payload.** The raw `GET /memory/:addr` response body:

```json
{
  "ok": true,
  "addr": "PJ.0.3.512",
  "label": "...",
  "kind": "decision",
  "source": "user_accepted",
  "status": "active",
  "assertion": "...",
  "why_it_matters": "...",
  "evidence": null,
  "scope": "tenant",
  "confidence": 0.85,
  "effective_at": "2026-04-01T00:00:00Z",
  "expires_at": null,
  "supersedes": null,
  "superseded_by": null,
  "tags": [],
  "retracted_reason": null,
  "project_addr": "PJ.0.1.123",
  "project_label": "VO Beta Rollout",
  "created_at": "2026-04-01T00:00:00Z",
  "updated_at": "2026-04-01T00:00:00Z",
  "federation": { /* ResolvedFederatedMemoryMetadata */ }
}
```

**Failure cases.**

| Cause                                | Error class            |
|--------------------------------------|------------------------|
| Unreachable                          | `local_vo_unreachable` |
| 401/403                              | `tenant_auth_failure`  |
| 400 (malformed addr)                 | `validation_failure`   |
| 404 (not found in tenant space)      | `not_found`            |
| 5xx                                  | `upstream_error`       |

Note: `404` maps to `not_found` with route-specific detail such as
`"memory not found"`, not to `upstream_error`. "Not found in my tenant
space" is a caller-resolvable condition, not a local-VO outage.

---

### Tool 5: `vo_memory_search`

**Purpose.** Free-text search across tenant memories. Returns ranked primary
memories for the query.

**Backend route.** `POST /memory/recall` (same endpoint as `vo_memory_recall`).

**Decision: thin alias for `/memory/recall`.**

There are two candidate backends for a "search" tool:

1. `POST /memory/recall` — the canonical recall compiler with explainable
   scoring (relevance, freshness, provenance, conflict-freeness) and
   full `RecallResult` shape.
2. `GET /remember?q=...` — a legacy hybrid semantic+keyword adapter in
   `api/src/routes/remember.ts` that returns a lighter-weight list shape.

The contract locks option 1. Rationale:

- One ranking path for all MCP read surfaces. An agent that gets good results
  from `vo_memory_recall` should get the same ranking from `vo_memory_search`.
- The `RecallResult` envelope carries confidence, explanations, and lifecycle
  metadata that the `/remember` list shape does not.
- The `/remember` endpoint remains first-class on the HTTP surface for
  scripts and backward compatibility, but MCP does not expose two ranking
  paths.

`vo_memory_search` is therefore a **thin alias with a different input
shape**: a single `query` string, no kinds/project/limit/include_inactive.
The backend call is still `POST /memory/recall` with a one-field body.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000,
      "description": "Natural language search query."
    }
  }
}
```

**Output payload.** Identical to `vo_memory_recall` output. Same `RecallResult`
shape.

**Why keep it separate from `vo_memory_recall` at all?** Discoverability.
Agents scanning a tools list for the word "search" will pick
`vo_memory_search`. The tool description makes the alias honest. If a future
rung decides there is no value in the duplication, the tool is trivial to
remove — no storage or ranking code depends on it.

**Failure cases.** Identical to `vo_memory_recall`.

## Rung 2 Write Tool Surface

Deferred from rung 1. This section is binding input for
`MCP-LOCAL-WRITE-PR-2`. Everything below is docs-only; no code has been
written for these tools yet.

The rung-1 read-only tool surface above is the precedent: each write tool is
a thin passthrough over an existing local HTTP route. **Write-side
governance — validation, source-link status, dedup, supersession,
contradiction detection, lifecycle events — lives in `api/src/routes/memory.ts`
and `api/src/lib/memory-contract.ts`. The MCP server must not reimplement,
soften, or duplicate any of it.**

### Rung 2 Scope

Five tools added in rung 2:

| Logical                     | Wire                          | Backend                     |
|-----------------------------|-------------------------------|-----------------------------|
| `vo.memory.write`           | `vo_memory_write`             | `POST /memory/write`        |
| `vo.memory.update`          | `vo_memory_update`            | `POST /memory/update`       |
| `vo.memory.retract`         | `vo_memory_retract`           | `POST /memory/retract`      |
| `vo.memory.forget`          | `vo_memory_forget`            | `POST /memory/forget`       |
| `vo.pretask_ground`         | `vo_pretask_ground`           | composed (see below)        |

Not in rung 2: vault tools, public-feed tools, bulk operations, any tool
that writes more than one memory per call, any tool that infers `supersedes`
automatically, any tool that writes to `/remember` directly (the canonical
path is `/memory/write`; `/remember` stays a first-class HTTP compatibility
shim but is not exposed through MCP).

### Write-Safety Posture

This subsection is the core of rung 2. It defines what the MCP write layer
is allowed to do, what it must encourage, and what it must refuse — above
and beyond whatever the HTTP core already enforces. The HTTP core is the
authority; MCP adds agent-facing discipline on top.

#### The fabrication rule (hard, binding)

The MCP write layer **must never fabricate** any of the following:

1. **`source_refs`.** If the agent did not actually read a file or fetch a
   URL it can point to, the field is omitted. The MCP server never auto-fills
   `source_refs` from the assertion text, from nearby files, from git
   history, or from any other inference. The existing contract rule from
   the backend is binding: *never fabricate — omit entirely if no real
   source exists*.
2. **`bootstrap_context`.** The MCP server never synthesizes a
   `bootstrap_context` object. The only legitimate source is a fresh
   `vo_bootstrap_project` or `vo_pretask_ground` result copied through by
   the caller.
3. **`project_addr`.** The MCP server never infers a project from the
   caller's `cwd`, `goal`, or assertion text at write time. The project
   must come from an explicit user action or from a valid
   `bootstrap_context`.
4. **`why_it_matters`.** The MCP server never rewrites or invents the
   rationale. If the agent has nothing honest to say, the field is omitted.
5. **`source` (kind).** See the next subsection — the MCP server must never
   upgrade `agent_inferred` to `user_accepted` without explicit user intent
   captured in the turn.
6. **`supersedes`.** The MCP server never computes supersession targets by
   similarity. The `supersedes` addr must be supplied by the caller.

These are refusal rules, not validation rules — the HTTP core will happily
accept any well-typed payload. The refusal is at the MCP-tool-description
layer: the tool description must tell the agent not to invent these, and the
implementation must not wrap the agent's inputs in any post-processing that
would effectively invent them.

#### Source-kind integrity

The `source` field in `MemoryWriteRequest` (see
`api/src/lib/memory-contract.ts#SOURCE_KINDS`) has four values:

- `user_accepted` — the user explicitly told the agent to save this fact
- `agent_corrected` — the user corrected the agent, and the agent is
  writing the corrected version of the fact
- `agent_inferred` — the agent wrote this without explicit user
  acknowledgment (default for routine agent work)
- `system_generated` — system-generated (digests, compaction); **not a
  legal value from MCP**, reserved for server-side writers

MCP agent-caller rules:

- **Default to `agent_inferred`.** If the tool description does not specify
  otherwise, and the agent is not sure, `agent_inferred` is always the safe
  choice.
- **`user_accepted` requires explicit user intent in the same turn.** The
  user must have said something like "remember this", "save that",
  "preference: X", or equivalent. The agent must not upgrade its own
  inference to `user_accepted` because it thinks the user would agree.
- **`agent_corrected` requires an actual correction** — the user told the
  agent it was wrong about something, and this write captures the corrected
  version. Silent revisions do not qualify.
- **`system_generated` is refused at the MCP layer.** If a caller passes
  `system_generated`, the MCP tool returns `validation_failure` with
  `detail: "system_generated is reserved for server-side writers"`. This is
  the one place MCP adds client-side validation, because the backend
  currently accepts the value but MCP's contract refuses it on behalf of
  agent callers.

#### Source-refs discipline

Per `api/src/lib/memory-contract.ts#SOURCE_OPTIONAL_KINDS`:

- **Source-expected kinds** (MCP tool description recommends `source_refs`):
  `decision`, `correction`, `pattern`
- **Source-optional kinds** (MCP tool description does NOT recommend
  `source_refs`): `preference`, `context`, `vision`, `changelog`, `digest`

When a caller writes a source-expected kind without `source_refs`, the
backend sets `source_link_status: "missing"` automatically. This is a signal,
not a failure — the memory is still written. The MCP tool description must
explain:

> If this is a `decision`, `correction`, or `pattern`, include
> `source_refs` for every real file you read or URL you fetched that backs
> this assertion. **Never fabricate a source.** If no real source exists,
> omit `source_refs` entirely — the write will succeed with
> `source_link_status: "missing"`, which is honest.

A `SourceRef` is `{ type: string, path?: string, url?: string }`. The agent
must provide exactly one of `path` or `url`, and `type` is a short tag like
`"doc"`, `"pr"`, `"issue"`, `"url"`.

#### Bootstrap-context discipline

`bootstrap_context` is the mechanism by which a project-scoped recall and a
project-scoped write stay consistent across turns. Backend validation
(`api/src/routes/memory.ts:96-116`):

- `bootstrap_context.tenant_id` must match the authenticated tenant
- `bootstrap_context.confidence === "high"`
- `bootstrap_context.issued_at` must be within 12 hours of now
- `bootstrap_context.project_addr` is copied into `req.project_addr` when
  valid (source tag: `"bootstrap_context"`)

MCP rules:

- **Agents should always include a fresh `bootstrap_context` when writing
  project-scoped memories** unless the user explicitly pointed at a
  different project.
- **`vo_pretask_ground` is the blessed source of `bootstrap_context`** for a
  write sequence. The agent calls `vo_pretask_ground` at the start of the
  session, captures the `bootstrap_context` from its output, and passes it
  into every subsequent `vo_memory_write` in that session.
- **The MCP server must pass `bootstrap_context` through verbatim.** It
  must not rewrite fields, it must not refresh `issued_at`, and it must not
  drop the field silently. If the caller wants a fresh context, they call
  `vo_pretask_ground` again.
- **Stale `bootstrap_context` (older than 12h) returns
  `validation_failure` from the backend.** MCP passes that error through
  with the original backend detail. The hint nudges the agent to re-ground.

#### Project-addr discipline

`project_addr` may be set three ways:

1. **Explicit** — the caller passed `project_addr: "PJ.x.x.x"` directly
2. **From `bootstrap_context`** — resolved by the backend from a valid
   bootstrap_context (see above)
3. **None** — the memory is tenant-wide, not project-scoped

MCP rules:

- **Do not derive `project_addr` from `cwd` at write time.** Project
  inference belongs in `/bootstrap/project`, not in the write tool.
- **Do not guess between two candidate projects.** If the agent is unsure,
  the write is tenant-wide.
- **Explicit `project_addr` wins over `bootstrap_context`.** The backend
  already enforces this order; MCP inherits it.

#### Update vs retract vs forget

These three tools look similar. The write-safety posture differentiates
them strictly so agents do not pick the wrong one:

| Tool                | Intent                                                            | Reversibility                                              | Leaves trace?                |
|---------------------|-------------------------------------------------------------------|------------------------------------------------------------|------------------------------|
| `vo_memory_update`  | "this fact evolved — patch fields in place"                       | Lossy (old field values are not versioned in place)        | Yes (updated_fields event)   |
| `vo_memory_retract` | "this fact was wrong — mark it invalid, keep it for audit"        | One-way (the memory is dormant until an operator revives)  | Yes (with `retracted_reason`)|
| `vo_memory_forget`  | "this fact is no longer relevant — archive it quietly"            | One-way (dormant)                                          | Yes (no reason)              |

Agent guidance the MCP tool descriptions must convey:

- **Prefer retract over update when the original assertion was wrong.**
  Update is for patches to still-true memories (tags, expiry, added
  evidence). Retract is for "I was wrong". Silently updating an assertion
  that was wrong destroys audit trail.
- **Prefer retract over forget when there is a reason to record.** Retract
  carries `retracted_reason` forward for future recall and contradiction
  surfaces. Forget is for cleanup when nothing was wrong — the memory is
  just no longer relevant (e.g. a changelog entry that's now historical).
- **Do not update `confidence` on memories the agent itself wrote.**
  Confidence should reflect empirical certainty, not agent preference. The
  MCP tool description explicitly discourages self-confidence boosting.
- **Do not update `expires_at` on memories the agent itself wrote** unless
  the user asked. Same rationale — avoid agents extending their own writes
  indefinitely.
- **Prefer retract + new write over in-place assertion rewrite.** For a
  meaningful correction to the assertion content, a retract-plus-write
  sequence preserves the audit trail and gives the new write a proper
  `supersedes` link. In-place assertion updates should be reserved for
  typo-level fixes.

#### Supersession

The backend supports `supersedes: "PJ.x.x.x"` on `vo_memory_write`. When
set, the backend marks the superseded memory dormant and writes
`substance.superseded_by` on the old node.

MCP rules:

- **`supersedes` must be caller-supplied.** The MCP server never computes
  supersession targets by embedding similarity or any other heuristic.
- **The `supersedes` addr must be a real memory in the caller's tenant
  space.** The backend will 404 if not — MCP passes that through as
  `validation_failure`.
- **Supersession is preferred over in-place update for material fact
  changes.** See the *Update vs retract vs forget* table.

### Tool: `vo_memory_write`

**Purpose.** Write a new tenant memory via the canonical write path. Thin
passthrough to `POST /memory/write`. The backend handles embedding, dedup,
contradiction detection, source-link status, auto-wiring, lifecycle events,
and supersession.

**Backend route.** `POST /memory/write`

**Backend source.** `api/src/routes/memory.ts`,
`api/src/lib/memory-contract.ts`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind", "assertion", "source"],
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["decision", "preference", "correction", "context", "pattern", "vision", "changelog", "digest"]
    },
    "assertion": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "description": "The core fact being remembered. No fabrication, no filler."
    },
    "source": {
      "type": "string",
      "enum": ["user_accepted", "agent_corrected", "agent_inferred"],
      "description": "How this memory was created. Default to agent_inferred unless the user explicitly told you to save. Never pick user_accepted without explicit user intent in this turn. system_generated is reserved for server-side writers and is rejected at the MCP layer."
    },
    "subject": {
      "type": "string",
      "maxLength": 120,
      "description": "Short subject line. Optional; the backend derives one from the assertion if omitted."
    },
    "why_it_matters": {
      "type": "string",
      "description": "Why this memory will matter to future work. Optional. Never fabricate — omit if nothing honest to say."
    },
    "evidence": {
      "type": "string",
      "description": "Optional supporting context."
    },
    "scope": {
      "type": "string",
      "enum": ["session", "project", "tenant", "global"]
    },
    "effective_at": { "type": "string", "format": "date-time" },
    "expires_at": { "type": "string", "format": "date-time" },
    "supersedes": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Addr of a memory this one supersedes. MUST be caller-supplied; never inferred by similarity."
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" }
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Default 0.80 at the backend. Set deliberately, not as a self-boost."
    },
    "project_addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Tenant project root this memory belongs to. Prefer bootstrap_context unless the user named a different project explicitly."
    },
    "source_refs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type"],
        "properties": {
          "type": {
            "type": "string",
            "minLength": 1,
            "description": "Short tag for the source kind, e.g. \"doc\", \"pr\", \"issue\", \"url\"."
          },
          "path": {
            "type": "string",
            "description": "Relative path to a file in the project, e.g. \"docs/VO-CURRENT-STATE.md\"."
          },
          "url":  {
            "type": "string",
            "description": "URL of the source document."
          }
        },
        "anyOf": [
          { "required": ["path"] },
          { "required": ["url"] }
        ],
        "description": "Each source_ref MUST include `type` AND at least one of `path` or `url`. The backend validator in api/src/lib/memory-contract.ts#validateWriteRequest rejects any source_ref that has neither path nor url with a 400; MCP encodes the same rule here so tool callers see the requirement at schema level."
      },
      "description": "Real files or URLs that back this assertion. NEVER fabricate. Omit the array entirely if no real source exists — do not emit empty or fake entries."
    },
    "bootstrap_context": {
      "type": "object",
      "description": "Opaque object passed through verbatim from a recent vo_bootstrap_project or vo_pretask_ground call. MCP MUST NOT synthesize or rewrite this.",
      "properties": {
        "project_addr": { "type": "string" },
        "project_label": { "type": "string" },
        "confidence": { "type": "string" },
        "source": { "type": "string" },
        "tenant_id": { "type": "string" },
        "issued_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}
```

**Output payload.** Raw `POST /memory/write` response body — fields vary by
write path (dedup merge vs fresh insert):

```json
{
  "ok": true,
  "addr": "PJ.0.3.1781",
  "label": "Decision: ...",
  "kind": "decision",
  "source": "user_accepted",
  "space_id": "tenant:acme",
  "edges_wired": "grounds",
  "source_link_status": "linked",
  "source_refs_count": 2,
  "project_addr": "PJ.0.1.123",
  "project_label": "VO Beta Rollout",
  "project_source": "bootstrap_context",
  "federation": { "authority": "tenant_local" }
}
```

Dedup merge variant:

```json
{
  "ok": true,
  "deduplicated": true,
  "existing_addr": "PJ.0.3.1423",
  "existing_label": "...",
  "similarity": 0.91,
  "message": "Skipped — semantically similar memory already exists",
  "source_refs_merged": 1
}
```

The MCP server does not reshape either variant. The `deduplicated: true`
case is a successful result (`isError: false`), not a failure.

**Failure cases.**

| Cause                                                         | Error class            |
|---------------------------------------------------------------|------------------------|
| Unreachable                                                   | `local_vo_unreachable` |
| 401/403                                                       | `tenant_auth_failure`  |
| 400 (missing required fields, bad kind, bad source, etc.)     | `validation_failure`   |
| 400 (invalid project_addr — not an active PROJECTS root)      | `validation_failure`   |
| 400 (bootstrap_context stale or tenant_id mismatch)           | `validation_failure`   |
| `source === "system_generated"` from MCP caller               | `validation_failure` (refused at MCP layer) |
| 5xx                                                           | `upstream_error`       |

**Write-safety notes** (surfaced to the agent through the tool description):

- Default `source: "agent_inferred"` unless the user explicitly said to save
- Include `source_refs` for `decision`, `correction`, `pattern` when a real
  source exists — never fabricate
- Pass `bootstrap_context` from the most recent `vo_pretask_ground` when
  writing project-scoped memory
- Use `supersedes` explicitly for material revisions; never compute it by
  similarity

### Tool: `vo_memory_update`

**Purpose.** Patch a specific existing memory in place. Use for minor
corrections (typos, added tags, extended expiry for legitimate reason).
Prefer `vo_memory_retract` + new `vo_memory_write` for material assertion
changes.

**Backend route.** `POST /memory/update`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["addr"],
  "properties": {
    "addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$"
    },
    "assertion": {
      "type": "string",
      "maxLength": 4000,
      "description": "Only for typo-level fixes. Material assertion changes should use retract + new write."
    },
    "subject": {
      "type": "string",
      "maxLength": 120
    },
    "why_it_matters": { "type": "string" },
    "evidence": { "type": "string" },
    "tags": {
      "type": "array",
      "items": { "type": "string" }
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Agents should NOT update confidence on memories they themselves wrote. Reserved for user-driven corrections."
    },
    "expires_at": {
      "type": ["string", "null"],
      "format": "date-time",
      "description": "Agents should NOT extend expiry on their own memories without user intent."
    }
  }
}
```

At least one of `assertion | subject | why_it_matters | evidence | tags | confidence | expires_at` must be present. The backend enforces this.

**Output payload.**

```json
{ "ok": true, "addr": "PJ.0.3.1781", "updated_fields": ["subject", "tags"] }
```

**Failure cases.**

| Cause                                           | Error class            |
|-------------------------------------------------|------------------------|
| Unreachable                                     | `local_vo_unreachable` |
| 401/403                                         | `tenant_auth_failure`  |
| 400 (no updatable fields supplied)              | `validation_failure`   |
| 400 (bad addr or field type)                    | `validation_failure`   |
| 404 ("Memory not found or not accessible")      | `validation_failure`   |
| 5xx                                             | `upstream_error`       |

**Write-safety notes.**

- This tool is for **patches**, not rewrites. If the assertion was wrong,
  use `vo_memory_retract` and then `vo_memory_write` a corrected version
- Do not self-boost `confidence`
- Do not self-extend `expires_at`
- The backend re-embeds the memory if `assertion` changes; this is
  expected and transparent to MCP

### Tool: `vo_memory_retract`

**Purpose.** Mark a memory as wrong and exclude it from default recall
while preserving it for audit. Use when the original assertion was
incorrect, misleading, or obsoleted by a correction.

**Backend route.** `POST /memory/retract`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["addr"],
  "properties": {
    "addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$"
    },
    "reason": {
      "type": "string",
      "description": "Short explanation of why this memory is wrong. Strongly encouraged — the reason flows into the event log and future contradiction surfaces."
    }
  }
}
```

**Output payload.**

```json
{ "ok": true, "addr": "PJ.0.3.1781", "status": "retracted" }
```

**Failure cases.**

| Cause                                                   | Error class            |
|---------------------------------------------------------|------------------------|
| Unreachable                                             | `local_vo_unreachable` |
| 401/403                                                 | `tenant_auth_failure`  |
| 400 (missing addr)                                      | `validation_failure`   |
| 404 ("Memory not found or already retracted")           | `validation_failure`   |
| 5xx                                                     | `upstream_error`       |

**Write-safety notes.**

- **Always provide a `reason`** when retracting. The MCP tool description
  strongly encourages this; the backend allows empty but records `null`.
- Retracting a memory is a one-way action at the MCP layer. Recovery
  requires operator intervention.
- Retracting a memory the agent itself wrote is legitimate and expected
  when the agent learns the original write was wrong.

### Tool: `vo_memory_forget`

**Purpose.** Archive a memory that is no longer relevant but was not
incorrect. Distinguish from retract: forget has no `reason` because there
is nothing wrong to explain.

**Backend route.** `POST /memory/forget`

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["addr"],
  "properties": {
    "addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$"
    }
  }
}
```

**Output payload.**

```json
{ "ok": true, "addr": "PJ.0.3.1781", "status": "archived" }
```

**Failure cases.**

| Cause                                 | Error class            |
|---------------------------------------|------------------------|
| Unreachable                           | `local_vo_unreachable` |
| 401/403                               | `tenant_auth_failure`  |
| 400 (missing addr)                    | `validation_failure`   |
| 404 ("Memory not found")              | `validation_failure`   |
| 5xx                                   | `upstream_error`       |

**Write-safety notes.**

- **Use retract, not forget, whenever there is a reason.** Retract carries
  `retracted_reason` into the event log and future contradiction surfaces;
  forget does not.
- Forget is the right tool only when the memory was accurate at write time
  and is now simply no longer useful (e.g. stale changelog entries, session
  context past its TTL).

### Tool: `vo_pretask_ground` (composed)

**Purpose.** Ground an agent session in one call: infer project, run
routed recall, return a ready-to-use `bootstrap_context` that later
`vo_memory_write` calls can thread through.

**This is a composed convenience tool, not a new backend route.** It
exists to make the "bootstrap → recall → save result for future writes"
sequence a single round trip for the agent, matching the existing
`vo pretask-ground` CLI command in `agent-lab/scripts/vo-cli.ts`.

**Composition rules (binding):**

1. **`vo_pretask_ground` MUST be implemented as literal sequential calls
   to `POST /bootstrap/project` and `POST /memory/recall/routed`.** No
   other backend routes.
2. **`vo_pretask_ground` MUST NOT embed any classification, ranking,
   routing, or recall logic of its own.** Every piece of scoring and
   widening happens in `api/src/lib/recall-compiler.ts` and
   `api/src/lib/domain-router.ts`. The composed tool is purely an
   ergonomic wrapper.
3. **`vo_pretask_ground` always calls `/memory/recall/routed`** (never the
   plain `/memory/recall`), because the point of the composition is
   one-step domain-aware grounding.
4. **Project-addr threading rule.** If the bootstrap response returns
   `safe_for_workspace_routing: true`, the recall call is made with
   `project_addr` set to `inferred_project.addr`. Otherwise the recall
   call is tenant-wide (no `project_addr`). This matches the existing
   `vo pretask-ground` CLI exactly.
5. **No partial-success.** If either sub-call fails, the composed tool
   returns the underlying error envelope. There is no "bootstrap succeeded
   but recall failed — return partial" mode. Tenants who want partial
   results call `vo_bootstrap_project` and `vo_memory_recall_routed`
   separately.
6. **No caching.** Each `vo_pretask_ground` call is a fresh pair of
   backend calls. There is no client-side cache of bootstrap context
   between invocations.

**Backend routes.** `POST /bootstrap/project`, then
`POST /memory/recall/routed`.

**Backend source for the composition pattern.**
`agent-lab/scripts/vo-cli.ts` function `pretaskGround` (around line 4009)
is the existing CLI implementation; the MCP composed tool must match its
step order exactly.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Absolute path to the tenant's current workspace. Defaults to the MCP server's own cwd."
    },
    "goal": {
      "type": "string",
      "maxLength": 2000,
      "description": "Freeform description of the agent's task. Used both as the bootstrap goal and as the recall query when no explicit query is supplied."
    },
    "query": {
      "type": "string",
      "maxLength": 2000,
      "description": "Optional recall query. If omitted, derived from goal (or from the inferred project label — matches vo pretask-ground CLI behavior)."
    },
    "workspace_name": { "type": "string" },
    "repo_slug": { "type": "string" },
    "explicit_project_addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$"
    }
  }
}
```

**Output payload.** The two raw backend responses, plus two convenience
fields lifted from the bootstrap payload for direct reuse by subsequent
`vo_memory_write` calls:

```json
{
  "ok": true,
  "bootstrap": { /* raw POST /bootstrap/project response */ },
  "recall": { /* raw POST /memory/recall/routed response */ },
  "bootstrap_context": {
    "project_addr": "PJ.0.1.123",
    "project_label": "VO Beta Rollout",
    "confidence": "high",
    "source": "cwd_match",
    "tenant_id": "acme",
    "issued_at": "2026-04-09T21:12:00.000Z"
  },
  "safe_for_workspace_routing": true,
  "ms": 142
}
```

The `bootstrap_context` top-level field is a **verbatim copy** of
`bootstrap.bootstrap_context` from the backend response. It is only present
(non-null) when `safe_for_workspace_routing === true`, matching the
backend's own contract. The MCP server does not synthesize it, does not
refresh its `issued_at`, and does not rewrite any fields.

**Failure cases.**

| Cause                                                                       | Error class            |
|-----------------------------------------------------------------------------|------------------------|
| Either sub-call unreachable                                                 | `local_vo_unreachable` |
| Either sub-call 401/403                                                     | `tenant_auth_failure`  |
| Either sub-call 400                                                         | `validation_failure`   |
| Either sub-call 5xx                                                         | `upstream_error`       |

When the **first** sub-call fails, the composed tool returns that error.
When the **second** sub-call fails, the composed tool returns that error
with `detail` prefixed `"recall after successful bootstrap: ..."` so the
agent can tell which call actually failed without consuming a new error
class.

**Write-safety notes.**

- Call `vo_pretask_ground` at the start of a real work session, once per
  workspace change. Capture the returned `bootstrap_context`.
- Pass that `bootstrap_context` verbatim to every subsequent
  `vo_memory_write` in the session. Do not edit it.
- Re-call `vo_pretask_ground` when the issued_at timestamp is older than
  ~11 hours (just inside the backend's 12-hour TTL) or when you switch
  workspaces.
- The composed tool is NOT a recall tool on its own — it is a grounding
  tool. For ongoing recall mid-session, use `vo_memory_recall_routed`
  directly.

### Write Error Model (unchanged from rung 1)

The existing four error classes cover every rung-2 failure mode. **No new
error class is added.**

| Class                  | Trigger                                                                      |
|------------------------|------------------------------------------------------------------------------|
| `local_vo_unreachable` | HTTP connection to `127.0.0.1:3100` fails                                    |
| `tenant_auth_failure`  | HTTP response is 401 or 403                                                  |
| `validation_failure`   | HTTP 400, HTTP 404 on update/retract/forget/get, MCP-layer refusal of `system_generated` |
| `upstream_error`       | HTTP ≥ 500, or response shape unexpected, or body not JSON                   |

The only write-specific refinements to the existing mapping:

1. **404 from update/retract/forget** → `validation_failure` (consistent
   with rung 1's rule for `vo_memory_get`). The backend messages ("Memory
   not found or not accessible", "Memory not found or already retracted",
   "Memory not found") are passed through in `detail` unchanged.
2. **MCP-layer refusal of `source: "system_generated"`** → `validation_failure`
   with `detail: "system_generated is reserved for server-side writers"`
   and no backend call made. This is the **one** place in rung 2 where
   MCP adds client-side validation.
3. **Dedup merge is a success, not a failure.** When the backend returns
   `{ ok: true, deduplicated: true, ... }`, MCP returns the envelope with
   `isError: false` and the raw payload in the content block. Agents read
   the `deduplicated` field to decide whether the write was a fresh insert
   or a merge into an existing memory.

## Rung 3 Vault Tool Surface

Deferred from rungs 1 and 2. This section is binding input for
`MCP-LOCAL-VAULT-PR-3`. Everything below is docs-only; no code has been
written for these tools yet.

Rung 3 exposes **read-only** vault tools to agents. Writes to the vault
(harvest, confirm, finalize, clipper sync) remain the `vo vault` CLI's
responsibility. The vault-write surface is NOT in MCP in rung 3 or any
currently-planned rung.

Vault authority upstream of rung 3 is already defined in
`docs/VO-VAULT-DESIGN-CONTRACT.md`. MCP rung 3 adapts it for agent
consumption without changing any of it. When this document and the vault
design contract disagree, the vault design contract wins for anything
touching vault layout, frontmatter, or lifecycle stages.

### Backend Shape Decision

Rung 3 uses **direct filesystem reads from the `mcp/` process**, not a new
`/vault/*` HTTP surface on the local VO node.

Rationale (binding):

1. **Narrower net surface.** Adding filesystem reads to `mcp/` adds nothing
   to `api/src/`. Adding `/vault/*` HTTP routes would teach the api node
   about vault layout for the first time, creating new coupling across
   subsystems. The api is currently zero-aware of the vault and that is
   the right posture.
2. **Same capability class `mcp/` already has.** `mcp/` already reads
   `~/.vo/config.json` and `~/.vo/secrets.env` from disk at startup.
   Reading `~/knowledge/dossiers/a1b2c3d4-*.dossier.md` is the same
   category of operation — local filesystem, same user, same process
   privilege, strictly read-only.
3. **Vault layout is stable and simple enough to embed safely.** Per
   `docs/VO-VAULT-DESIGN-CONTRACT.md` §3, finalized dossiers live at
   `<root>/dossiers/{hash8}-{slug}.dossier.md` and drafts at
   `<root>/dossiers/{hash8}-{slug}.dossier.draft.md`. Lookup is
   `ls dossiers/{hash8}-*` — deterministic, hash-anchored, no slug
   reconstruction. The tiny amount of layout knowledge rung 3 embeds in
   `mcp/` is worth the avoided api/ coupling.
4. **Tenant privacy is preserved.** Vault reads happen in the tenant's
   own user process, over the tenant's own filesystem. Nothing leaves
   the machine. No auth handshake, no token, no HTTP trip. This matches
   the local-first authority model exactly.
5. **Zero changes to `api/src/`.** Rung 3 is purely additive to `mcp/`.
   The Hono app does not need a new route, env var, or bootstrap step.
   `vo-cli.ts` also stays untouched — it already owns vault writes and
   continues to be the single owner of the vault lifecycle.

Trade-off accepted:

- If the vault filesystem layout ever changes, `mcp/` needs to update in
  parallel with `vo-cli.ts`. Mitigation: **the vault layout knowledge in
  `mcp/` stays tiny** — only two operations (list dossiers, read one
  dossier by hash prefix). Content parsing beyond "read the file" is
  OUT of scope. If the layout moves, the fix is a handful of lines.

Options rejected:

- **`/vault/*` HTTP routes on the local VO node.** Rejected because it
  teaches `api/src/` about the vault filesystem, adds a new configuration
  surface (VERITY_VAULT_ROOT or equivalent), and creates a second place
  where vault layout knowledge has to stay consistent. The rationale for
  rung 1 was "api remains zero-aware of MCP"; the rationale for rung 3
  is symmetric: "api remains zero-aware of vault".
- **Hybrid** (reads direct, writes via HTTP). Rejected because rung 3 has
  no write surface at all. There is no hybrid to split.
- **Read the vault through a new `vo vault lookup` subprocess spawn.**
  Rejected because spawning Bun subprocesses from the Node MCP server
  for every tool call is slow, fragile, and introduces a runtime-boundary
  crossing we do not need.

### Vault Root Discovery Order

The vault root is currently **never auto-discovered** — every `vo vault`
CLI command takes `--root <path>` explicitly, and `~/.vo/config.json`
does not store a `vault_root` field. Rung 3 introduces a resolution chain
that lets MCP vault tools find the vault without requiring the agent to
pass the path on every call.

Binding order (strict, checked left to right):

1. **`vault_root` argument on the MCP tool call** — if the caller passed
   an absolute path, use it.
2. **`VERITY_VAULT_ROOT` environment variable** — if set and absolute,
   use it. This is the path intended for `vo-mcp install` to write into
   the client env block when the tenant opts into vault tools.
3. **`vault_root` field in `~/.vo/config.json`** — if present and
   absolute, use it. This is a **new, optional** field. It is not written
   by existing `vo init` or `vo vault init` commands. Adding it requires
   either a manual edit by the tenant or a future small CLI helper
   (`vo vault register --root <path>`) — neither of which is in scope
   for rung 3.
4. **Otherwise** — return `validation_failure` with:
   - `message: "vault_root not configured"`
   - `hint: "pass vault_root as an argument, set VERITY_VAULT_ROOT, or add vault_root to ~/.vo/config.json"`

The resolved path must point to a directory containing a readable
`.vo-vault.json`. Any other path is treated as "not a vault" and maps to
`validation_failure` with `detail: "no .vo-vault.json at <path>"`.

### Authority Boundary

The conceptual core of rung 3. These rules keep the vault from being
mistaken for a second memory authority.

#### What lives where

| VO memory (rungs 1-2 tools)                                              | Vault artifacts (rung 3 tools)                                |
|--------------------------------------------------------------------------|---------------------------------------------------------------|
| decisions, preferences, corrections, context, patterns, visions,        | finalized dossiers (`dossiers/*.dossier.md`),                 |
| changelogs, digests                                                      | draft dossiers (`dossiers/*.dossier.draft.md`),               |
|                                                                          | captures (`captures/*.md` — immutable),                       |
| tenant project roots, lifecycle state (active/superseded/retracted/      | human notes (`notes/*.md` — human-owned),                     |
| archived), source_refs, federation metadata                              | harvest log (`log.md`), generated index (`index.md`),         |
|                                                                          | clipper inbox (`inbox/web-clips/*`)                           |
| Queried via `vo_memory_recall`, `vo_memory_recall_routed`,               | Queried via `vo_vault_list` and `vo_vault_lookup`             |
| `vo_memory_get`, `vo_memory_search`                                      |                                                                |
| Written via `vo_memory_write`, `vo_memory_update`,                       | Written via `vo vault harvest/confirm/finalize` CLI           |
| `vo_memory_retract`, `vo_memory_forget`                                  | **(not via MCP in any current rung)**                         |

#### When to call which

- "What did this tenant decide / prefer / learn as a pattern / correct?"
  → **memory tools** (`vo_memory_recall` or `vo_memory_recall_routed`).
- "Show me the human-readable dossier the tenant wrote about topic X."
  → **vault tools** (`vo_vault_list` to enumerate, then `vo_vault_lookup`
  by hash).
- "What is the source this fact was extracted from?"
  → First call `vo_memory_get` on the addr to read the memory's
  `source_refs`. Harvested memories today carry a single source_ref of
  the shape `{ path: "captures/{hash8}-{slug}.{ext}", type: "capture" }`
  — the path points at the capture file, **not** at the dossier. To
  open the corresponding dossier, extract the 8-char hash prefix from
  that capture path (`^captures/([a-f0-9]{8})-`) and call
  `vo_vault_lookup` with it. The vault design contract §3 locks both
  the capture path and the dossier path to the same hash-anchored
  identity, so the prefix round-trips cleanly.
- "Save a new decision."
  → `vo_memory_write`. **Never** `vo_vault_*` — the vault is not a
  write surface in rung 3.
- "Harvest this URL/file into the vault."
  → **Rung 7: `vo_vault_harvest_auto`** (local MCP write — narrow exception
  to the rung-3 read-only posture). Runs the full harvest pipeline
  against the same shared engine the CLI and dashboard use. See
  **Rung 7 — Local Vault Harvest Operator** below. Non-harvest vault
  writes (granular confirm, finalize, delete) remain CLI-only.

#### Provenance language

Results from `vo_memory_*` tools carry memory provenance fields: `addr`
(canonical `PJ.x.x.x` address), `kind`, `source` (`user_accepted` /
`agent_inferred` / etc), `federation.authority`.

Results from `vo_vault_*` tools carry vault provenance fields: `hash`
(8-char content hash), `slug`, `filename`, `source` (`"finalized"` |
`"draft"`), `relative_path` (relative to the vault root). **No `addr`,
no `kind`, no `federation`** — a vault artifact is not a memory.

Agents must not conflate the two surfaces in user-facing output:

- When quoting **memory** content, cite the addr: `"[PJ.0.3.1423] ..."`.
- When quoting **vault** content, label it as vault content:
  `"from your vault (dossiers/a1b2c3d4-karpathy-llm.dossier.md): ..."`.
- When a fact has **both** a memory and a backing dossier, the agent may
  surface both, but must keep the labeling distinct.

#### Five authority rules (binding)

1. **Vault is downstream of memory, but dossier existence does not prove
   memory existence.** Memories can exist without vault dossiers. Vault
   dossiers are produced by `vo vault harvest` → `vo vault confirm` →
   `vo vault finalize`. The confirm step attempts to write memories via
   `/memory/write`, but per-dossier `atoms_written` may be zero (for
   example when every proposed atom deduplicates into an existing
   memory, or when the confirm step runs in a partial mode). A finalized
   dossier can therefore carry an **empty `vo_nodes` list** in its
   frontmatter and still land at `dossiers/{hash8}-{slug}.dossier.md`.
   MCP vault tools must not treat the existence of a dossier as proof
   that graph-backed memories exist for it. Agents that need to know
   whether a dossier is graph-backed must inspect the `vo_nodes` list
   returned by `vo_vault_lookup` (non-empty = graph-backed, empty =
   dossier exists but has no corresponding memories in the tenant
   space). MCP vault tools read files; they never synthesize memories
   from vault content.
2. **Vault is read-only in rung 3.** No `vo_vault_write`, no
   `vo_vault_delete`. Vault confirm, finalize, and delete remain the CLI's
   responsibility. Only the `harvest-auto` full-pipeline operation has
   been justified as a write exception — see **Rung 7 — Local Vault
   Harvest Operator** for the one narrow write tool
   (`vo_vault_harvest_auto`). Rung 7 is the design pass this earlier
   wording left room for. Every other vault write operation
   (granular confirm, granular finalize, dossier delete, clipper
   sync) remains explicitly out of scope.
3. **Vault reads do not promote vault to a second authority.** The memory
   graph on `127.0.0.1:3100` remains the single authority for tenant-
   private truth. Vault artifacts are human-readable companion content.
4. **Vault provenance is vault-origin.** MCP must not wrap vault content
   in a "memory" envelope or return vault results as if they were recall
   results. The `vo_vault_*` result shape is distinct from the
   `vo_memory_*` result shape.
5. **Vault content is never auto-written back into memory.** If an agent
   reads a dossier and decides a fact is worth saving, it must call
   `vo_memory_write` explicitly with its own payload. Reading a dossier
   does not trigger, suggest, or queue a memory write. MCP never
   round-trips vault content through `/memory/write` on the agent's
   behalf.

### Shared Input Conventions

Every rung-3 tool accepts an optional `vault_root` argument. When
omitted, the discovery order above is used. All other inputs are per-tool.

### Tool: `vo_vault_list`

**Purpose.** Enumerate finalized (and optionally draft) dossiers in the
tenant's vault. Returns enough metadata for an agent to pick a target
and call `vo_vault_lookup` for the full markdown.

**Backend.** Direct filesystem read under `<vault_root>/dossiers/`.
Reads `.vo-vault.json` to confirm tenant identity. Lists files matching
`*.dossier.md` and (if `include_drafts` is true) `*.dossier.draft.md`.

**Per-row field sources** (these fields come from DIFFERENT places — the
contract is explicit so implementers do not have to guess):

| Field            | Source                                                                              |
|------------------|-------------------------------------------------------------------------------------|
| `hash`           | **Filename** — the leading 8 hex chars of `{hash8}-{slug}.dossier[.draft].md`       |
| `slug`           | **Filename** — everything between `{hash8}-` and `.dossier[.draft].md`              |
| `filename`       | **Filename** — the basename itself                                                  |
| `relative_path`  | **Filesystem layout** — `dossiers/{filename}`                                       |
| `source`         | **Filename suffix** — `"draft"` if `.dossier.draft.md`, `"finalized"` otherwise     |
| `title`          | **Frontmatter** — `title` field (present in both draft and finalized dossiers)      |
| `generated_at`   | **Frontmatter** — `generated_at` field (the actual field name in both draft and finalized dossier frontmatter; not `updated_at`) |
| `vo_nodes_count` | **Frontmatter** — the length of the `vo_nodes` YAML list. `0` means the dossier has no graph-backed memories (see authority rule #1). `null` only when the field is absent (draft dossiers may omit it). |
| `tenant_id`      | **`.vo-vault.json`** — read once per list call, not per-row                         |

Only `title`, `generated_at`, and `vo_nodes_count` come from frontmatter.
Everything else is derived from the filesystem. **Nothing beyond the
frontmatter YAML block is parsed** — no body scanning, no atom
extraction, no content hashing. If a frontmatter field is missing or
unparseable, that row's field is returned as `null` and the row is
still included in the result.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "vault_root": {
      "type": "string",
      "description": "Absolute path to the vault root. If omitted, resolved via VERITY_VAULT_ROOT or ~/.vo/config.json#vault_root."
    },
    "include_drafts": {
      "type": "boolean",
      "description": "If true, also list .dossier.draft.md files. Defaults to false."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "description": "Maximum number of dossiers to return (default 100)."
    }
  }
}
```

**Output payload.**

```json
{
  "ok": true,
  "vault_root": "/Users/tenant/knowledge",
  "tenant_id": "acme",
  "count": 42,
  "dossiers": [
    {
      "hash": "a1b2c3d4",
      "slug": "karpathy-llm-wiki",
      "filename": "a1b2c3d4-karpathy-llm-wiki.dossier.md",
      "relative_path": "dossiers/a1b2c3d4-karpathy-llm-wiki.dossier.md",
      "source": "finalized",
      "title": "Karpathy LLM Wiki - Dossier",
      "generated_at": "2026-04-02T10:14:00Z",
      "vo_nodes_count": 3
    },
    {
      "hash": "b5e6f7a8",
      "slug": "empty-draft",
      "filename": "b5e6f7a8-empty-draft.dossier.draft.md",
      "relative_path": "dossiers/b5e6f7a8-empty-draft.dossier.draft.md",
      "source": "draft",
      "title": "Empty Draft",
      "generated_at": "2026-04-09T11:00:00Z",
      "vo_nodes_count": null
    }
  ]
}
```

`count` is the number of items actually returned (post-limit, post-filter).
A vault with drafts will have `source: "draft"` on draft rows only when
`include_drafts: true` was passed. `vo_nodes_count: 0` is distinct from
`vo_nodes_count: null` — the former means the frontmatter carries an
empty `vo_nodes: []` list (finalized dossier that wrote no graph-backed
memories), the latter means the field is absent (typically drafts).

**Failure cases.**

| Cause                                          | Error class            |
|------------------------------------------------|------------------------|
| `vault_root` unresolved                        | `validation_failure`   |
| `vault_root` does not exist on disk            | `validation_failure`   |
| `.vo-vault.json` missing or not parseable      | `validation_failure`   |
| `<vault_root>/dossiers/` missing               | `validation_failure`   |
| Permission denied / OS error reading directory | `upstream_error`       |
| Unexpected I/O error                           | `upstream_error`       |

`local_vo_unreachable` and `tenant_auth_failure` **do not apply** to
vault tools — the tools never contact `127.0.0.1:3100` and never present
a tenant token.

**Write-safety notes.** Vault listing is read-only. The tool opens no
write handles, creates no temporary files, and does not mutate
`index.md`, `log.md`, or any dossier frontmatter.

### Tool: `vo_vault_lookup`

**Purpose.** Read a single dossier's full markdown content by its 8-char
content hash. Returns the raw markdown body plus parsed frontmatter.
Prefers the finalized dossier (`*.dossier.md`) over the draft
(`*.dossier.draft.md`) when both exist, unless the caller asks for the
draft explicitly.

**Backend.** Direct filesystem read of
`<vault_root>/dossiers/{hash8}-*.dossier.md` (or `.dossier.draft.md`).
`ls dossiers/{hash8}-*` per the vault design contract § 3 lookup rule.
Multiple matches with the same hash prefix are a failure (ambiguous hash).

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["hash"],
  "properties": {
    "vault_root": {
      "type": "string",
      "description": "Absolute path to the vault root. If omitted, resolved via discovery chain."
    },
    "hash": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}$",
      "description": "8-char content hash prefix. Matches the leading hex of the sha256 content hash, per vault design contract §3."
    },
    "prefer_draft": {
      "type": "boolean",
      "description": "If true and a draft exists, return the draft instead of the finalized dossier. Defaults to false."
    }
  }
}
```

**Output payload.**

```json
{
  "ok": true,
  "vault_root": "/Users/tenant/knowledge",
  "hash": "a1b2c3d4",
  "slug": "karpathy-llm-wiki",
  "filename": "a1b2c3d4-karpathy-llm-wiki.dossier.md",
  "relative_path": "dossiers/a1b2c3d4-karpathy-llm-wiki.dossier.md",
  "source": "finalized",
  "frontmatter": {
    "vo_addr": "PJ.0.3.1423",
    "vo_type": "dossier",
    "vo_managed": true,
    "capture_hash": "a1b2c3d4e5f6...",
    "source_capture": "captures/a1b2c3d4-karpathy-llm-wiki.md",
    "source_url": "https://example.com/karpathy-llm",
    "content_hash": "sha256:...",
    "source_hash": "a1b2c3d4e5f6...",
    "generated_at": "2026-04-02T10:14:00Z",
    "generated_by": "harvest/v1",
    "vo_nodes": ["PJ.0.3.1423", "PJ.0.3.1424"],
    "title": "Karpathy LLM Wiki - Dossier",
    "confidence": "high",
    "tags": []
  },
  "content": "---\nvo_addr: \"PJ.0.3.1423\"\n...---\n\n# Karpathy LLM Wiki\n\n..."
}
```

- `frontmatter` is the parsed YAML block verbatim — MCP does not rewrite,
  normalize, or add fields. The exact field set is defined by the
  harvest-finalize stage in `agent-lab/scripts/vo-cli.ts#vaultFinalize`
  and the vault design contract §4. Key fields:
  - `vo_nodes` — **list of memory addrs** written during confirm. An
    empty list means the dossier exists but no graph-backed memories
    were written for it (see authority rule #1). Draft dossiers
    (`.dossier.draft.md`) typically omit `vo_nodes` entirely.
  - `generated_at` — ISO-8601 timestamp from harvest/finalize. This is
    the real field name; there is no `updated_at` field in current
    vault frontmatter.
  - `source_capture` — relative path to the immutable capture file,
    always hash-anchored as `captures/{hash8}-{slug}.{ext}`.
  - `vo_addr` — the "primary" memory addr for single-atom dossiers.
    Prefer `vo_nodes` when checking graph-backing.
- `content` is the full markdown file contents (including the
  frontmatter delimiters), capped at 256 KB. Dossiers larger than the
  cap return `validation_failure` with hint "dossier exceeds 256 KB;
  read from filesystem directly".
- `source` is `"finalized"` or `"draft"`, matching which file was read.

**Failure cases.**

| Cause                                           | Error class            |
|-------------------------------------------------|------------------------|
| `vault_root` unresolved                         | `validation_failure`   |
| `vault_root` does not exist / no `.vo-vault.json` | `validation_failure` |
| No dossier matches `{hash8}-*` prefix           | `validation_failure`   |
| Multiple dossiers match same hash prefix        | `validation_failure` (`"ambiguous hash"`) |
| Dossier file larger than 256 KB                 | `validation_failure`   |
| Permission denied / OS error reading file       | `upstream_error`       |
| Frontmatter parse error                         | `upstream_error` (non-fatal — content still returned with `frontmatter: null` on a best-effort parse; outright failure only when the file itself is unreadable) |

**Write-safety notes.** Strictly read-only. Never opens a write handle,
never modifies frontmatter, never writes to `log.md`, never touches
`index.md`. If the caller wants to save something from the dossier into
memory, they must call `vo_memory_write` with an explicit payload and
their own `source_refs` pointing at the capture path.

### No Composed Helper in Rung 3

The rung-2 `vo_pretask_ground` composed tool was justified by an
existing CLI composition (`vo pretask-ground`) and a real session-start
ergonomic win. Rung 3 has no equivalent existing composition and no
clear ergonomic win from combining list+lookup. Agents that need
"find the dossier about X" can:

1. Call `vo_memory_search` or `vo_memory_recall` to find the relevant
   memory first. Today's harvest pipeline writes a single `source_ref`
   of the form `{ path: "captures/{hash8}-{slug}.{ext}", type:
   "capture" }`. Extract the 8-char hash prefix from that capture path
   with `^captures/([a-f0-9]{8})-`.
2. Call `vo_vault_lookup` with the extracted hash.

Note: this is a **capture-path-driven** discovery path, not a
"dossier hash stored in source_refs" path. The harvest pipeline does
not currently record a dossier-specific hash or dossier-specific path
inside memory `source_refs` — it records the capture path, and the
capture and dossier share the same hash anchor per vault design
contract §3. A future harvest change that records a distinct dossier
reference would be a separate design pass.

Or, for coarse browsing:

1. Call `vo_vault_list` with optional `include_drafts`, pick a hash,
2. Call `vo_vault_lookup` with the hash.

Adding a composed `vo_vault_find` tool is **explicitly deferred** to a
later rung if and only if real agent usage shows the two-call sequence
is painful. For rung 3, the two primitives are enough.

### Rung 3 Error Model (same 4 classes)

The existing four error classes still cover every rung-3 failure mode.
**No new error class is added.** The only rung-3 refinements:

1. **`local_vo_unreachable` and `tenant_auth_failure` do not apply.**
   Vault tools never contact `127.0.0.1:3100` and never present a token.
   If an implementation ever finds itself needing to return those classes
   from a vault tool, the implementation has drifted from the design —
   the rung is off course.
2. **Vault not found / hash not matched / vault_root not configured**
   → `validation_failure`. The `detail` field carries the specific cause.
3. **Permission-denied / OS error / I/O error** → `upstream_error`. The
   `detail` field carries the underlying error message.
4. **Frontmatter parse failures in `vo_vault_lookup`** are best-effort —
   the tool still returns the dossier content with `frontmatter: null`
   if the YAML block is malformed but the file itself is readable. A
   best-effort parse failure is NOT an error envelope.

## Rung 4 Public Feed Tool Surface

Deferred from rungs 1, 2, and 3. This section is binding input for
`MCP-PUBLIC-FEED-PR-4`. Everything below is docs-only; no code has been
written for these tools yet.

Rung 4 exposes **read-only** public-overlay tools to agents. The tools
let an agent ask the local VO node for public-graph context, search
results, and trends without ever mixing in tenant-private memory.
Public-feed writes are NOT in MCP at any current rung — public-graph
authoring is the operator-only `vo publish` CLI path.

### Backend Shape Decision

Rung 4 tools call the **local VO node at `127.0.0.1:3100` anonymously**
(no `Authorization` header). They never reach a remote public service
directly.

Rationale (binding):

1. **The local VO node already exposes `/search` and `/context`
   anonymously with structural public-only scoping.** `api/src/index.ts`
   does not gate either route with `requireBetaAccess()`. An anonymous
   request passes through the access middleware with
   `scope: "anonymous"` and `spaceIds: [GLOBAL_SPACE_ID]`, and both
   routes plumb that access context into their SQL queries — tenant
   spaces are excluded at the SQL layer, with no MCP-side filtering
   required. **`/trends` is also anonymously reachable but is NOT
   structurally access-scoped today** (see *Why no `vo_public_trends`*
   below); rung 4 only ships the two structurally-safe primitives.
2. **Outbound-only posture is preserved trivially.** localhost is the
   most local any call can be. There is no inbound reachability
   assumption, no tunnel, no hosted broker, no second auth surface.
3. **No new auth ceremony.** The MCP server already reads the tenant's
   `agent_token` from `~/.vo/config.json`. Rung 4 simply omits the
   `Authorization` header on its calls. There is no separate beta
   token to provision and no env var to add.
4. **Provenance is structurally clean.** Anonymous = public-only at the
   access layer, by definition. The MCP server cannot accidentally
   surface a tenant-private memory through a `vo_public_*` tool because
   the backend never sees a request that would return one.
5. **`api/src/` gains zero rung-4 awareness.** No new routes, no new
   query parameters, no new middleware. Rung 4 is purely additive to
   `mcp/`, exactly like rungs 1, 2, and 3.
6. **If the local VO node ever needs to fetch from a federated public
   source, it does so on its own authority.** The MCP server stays on
   localhost. The optional public VO node and any cross-tenant
   federation work belong to the local node's outbound-sync loop, not
   to the MCP layer. This keeps "MCP is a thin transport adapter" true.

Options rejected:

- **Calling a remote public VO node directly from `mcp/`.** Rejected
  because it reintroduces network/auth concerns inside the MCP package,
  creates a second authority surface for the agent to reason about, and
  re-opens broker-era thinking. The local node already federates public
  content; reaching around it is exactly the regression the local-first
  rules forbid.
- **Hybrid (some tools localhost, some remote).** Rejected because it
  has no clear value over Option A and adds complexity. There is no
  rung-4 tool that genuinely requires reaching a remote public service.
- **Sending the agent token but post-filtering MCP-side to drop
  tenant-prefixed results.** Rejected because it duplicates filtering
  logic the access layer already enforces, violates the "thin transport
  adapter" rule, and creates a brittle filter that has to track
  changes to the tenant space-id format.
- **Adding a `public_only=1` query parameter to `/search`, `/context`,
  and `/trends`.** Rejected because it requires touching `api/src/` for
  a property the access layer already enforces structurally via
  anonymous scope. Unnecessary.

Implementation hint (informative, not binding): the existing
`mcp/src/vo-client.ts` always sends `Authorization: Bearer ${token}`.
The implementation rung will add a small variant — `getAnonymous<T>()`
or equivalent — that does not set the header. This is a one-method
addition to the client; no rewrites of existing methods.

### Rung 4 Scope

Two tools added in rung 4:

| Logical             | Wire                  | Backend (anonymous)              |
|---------------------|-----------------------|----------------------------------|
| `vo.public.search`  | `vo_public_search`    | `GET /search?q=...`              |
| `vo.public.context` | `vo_public_context`   | `GET /context?q=...&depth=...`   |

Not in rung 4: `vo_public_trends` (route is not structurally
access-scoped — see below), `vo_public_ground`, `vo_public_insight`,
`vo_public_regrounding`, `vo_public_check`, any composed helper, any
tool that writes to the public graph, any tool that reaches a remote
public VO node directly. See *Why no `vo_public_trends`* and *Why no
`vo_public_ground`* below.

### Authority and Provenance Boundary

The conceptual core of rung 4. These rules keep public-overlay results
from being mistaken for tenant-private memories and keep the local VO
memory authority structurally distinct from public-graph context.

#### What is authoritative for what

| Local VO memory (rungs 1-2)             | Vault (rung 3)                  | Public overlay (rung 4)               |
|------------------------------------------|----------------------------------|---------------------------------------|
| **authoritative** for tenant-private    | **downstream** of memory; human  | **additive** context from the         |
| truth (decisions, preferences,          | -readable companion content;     | public knowledge graph; **never**     |
| corrections, patterns, context)         | read-only in MCP                 | authoritative for tenant-private      |
|                                          |                                  | truth; never mixed silently into      |
|                                          |                                  | tenant memory                         |
| Tenant token required                    | Filesystem read; tenant token   | Anonymous call to local node;         |
|                                          | not required                    | tenant token deliberately omitted     |
| Result fields: `addr` (`PJ.x.x.x`),     | Result fields: `hash`, `slug`,  | Result envelope: top-level            |
| `kind`, `source`, `federation.authority` | `filename`, `source`             | `authority: "public_overlay"`         |

#### The single explicit provenance label

Every rung-4 tool's success result MUST carry a top-level field:

```json
{
  "ok": true,
  "authority": "public_overlay",
  ...
}
```

The `"public_overlay"` literal matches the existing
`api/src/lib/federated-memory.ts#FEDERATED_MEMORY_AUTHORITIES` enum
(`tenant_local | tenant_shared | public_overlay`). Reusing that literal
makes the contract internally consistent: a memory recalled via
`vo_memory_recall` carries `federation.authority` somewhere in its
result, and a public-graph node returned via `vo_public_search` carries
`authority` at the envelope level. Both use the same vocabulary.

Rules for the `authority` field:

1. **The MCP tool inserts the field at the envelope level.** It does
   not come from the backend response. This is the **one** place rung 4
   enriches the response with an MCP-added label. The label is not
   semantic invention — it restates the tool's identity. `vo_public_*`
   tools always return `authority: "public_overlay"`; no other tool
   ever sets this top-level field.
2. **Memory tool results never carry the top-level `authority` field.**
   Memory results carry `addr`, `kind`, `source`, and (per recall
   compiler) a per-memory `federation.authority`. There is no
   envelope-level `authority` on rungs 1-2.
3. **Vault tool results never carry the top-level `authority` field.**
   Vault results carry `hash`, `slug`, `filename`, `source`
   (`finalized` | `draft`). There is no envelope-level `authority` on
   rung 3.
4. **An agent can determine the result's authority bucket by inspecting
   the field shape alone.** Three structurally distinct envelope shapes,
   one per surface. No conflation possible without active malice on
   the agent's part.

#### Per-row provenance is implicit, not duplicated

The contract does NOT require each row inside `nodes` or `sections` to
carry its own per-row `provenance` field. The envelope-level
`authority: "public_overlay"` covers the entire result. Per-row
duplication would inflate the response without adding information.

If a future tool ever returns a MIXED envelope (some local, some
public — which rung 4 explicitly does NOT do), that tool would need
per-row provenance. Rung 4 has no such tool.

#### Tool description requirements (binding)

Every rung-4 tool's description MUST include language like:

> Returns results from the public knowledge graph. These are NOT
> tenant-private memories. When surfacing to the user, label as
> "from the public knowledge graph" or equivalent — never as
> "from your memory".

Without this language, agents can mis-quote public content as if it
were the tenant's own decisions. The description is the only
LLM-facing affordance MCP has, so it must carry the labeling rule.

#### Five authority rules (binding)

1. **Local VO memory remains authoritative for tenant-private truth.**
   Public-overlay results are additive; they never replace, override,
   or shadow a memory recall.
2. **Public-feed tools never call memory write routes.** Reading a
   public node never triggers, suggests, or queues a `/memory/write`
   call. If an agent wants to save something from the public graph,
   it must call `vo_memory_write` explicitly with its own payload and
   set `source_refs` to point at the public addr if applicable.
3. **No silent mixing.** A `vo_public_*` tool's result must be
   structurally distinct from a `vo_memory_*` result, even if both
   surfaces happen to return overlapping content. The envelope-level
   `authority` field is the structural divider.
4. **Public reads are anonymous from the MCP server's perspective.**
   The MCP server deliberately omits the `Authorization` header for
   rung-4 calls. If an implementation ever finds itself sending the
   tenant token to a rung-4 backend call, the implementation has
   drifted from the design — the rung is off course.
5. **Public-feed writes are out of scope indefinitely.** Public-graph
   authoring is the operator-only `vo publish` CLI path. There is no
   `vo_public_write`, `vo_public_publish`, or equivalent — not now,
   not in any planned rung.

### Shared Input Conventions

Every rung-4 tool accepts a small set of inputs corresponding directly
to the underlying anonymous local route's query parameters. None of
the tools accept a `tenant_token`, `vault_root`, or any other
tenant-coupled input — by design.

### Tool: `vo_public_search`

**Purpose.** Search the public knowledge graph for nodes matching a
keyword query. Thin passthrough to anonymous `GET /search`. Returns
public nodes with explicit `authority: "public_overlay"` envelope
labeling.

**Backend.** `GET /search?q=<query>&limit=<limit>` with **no
Authorization header**.

**Backend source.** `api/src/routes/search.ts`, `api/src/lib/access.ts`
(anonymous-scope filtering by `spaceIds: [GLOBAL_SPACE_ID]`).

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500,
      "description": "Keyword query against the public knowledge graph."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "description": "Maximum number of nodes to return (default backend-determined)."
    }
  }
}
```

**Output payload.**

```json
{
  "ok": true,
  "authority": "public_overlay",
  "query": "send sms notification",
  "count": 7,
  "nodes": [ /* raw GET /search response items */ ]
}
```

The `nodes` array is the raw backend response items. The MCP server
does not reshape per-row content. The only added field is the
envelope-level `authority: "public_overlay"`.

**Failure cases.**

| Cause                                            | Error class            |
|--------------------------------------------------|------------------------|
| Local node unreachable                           | `local_vo_unreachable` |
| HTTP 400 (empty query, too long)                 | `validation_failure`   |
| HTTP 429 (rate-limited; `/search` cap is 90/60s) | `upstream_error` (with `status: 429`; agents should back off) |
| HTTP ≥ 500 / non-JSON                            | `upstream_error`       |

`tenant_auth_failure` is **structurally impossible** because the tool
never sends a tenant token. If the implementation ever returns
`tenant_auth_failure` from a rung-4 tool, the rung is off course.

**Write-safety / authority notes** (surfaced to the agent):

- Results are from the public knowledge graph, not tenant-private
  memory
- When surfacing results to the user, label as "from the public
  knowledge graph"
- To save a fact you discovered through this tool into tenant memory,
  call `vo_memory_write` explicitly with your own payload — never
  expect a public read to silently produce a memory write

### Tool: `vo_public_context`

**Purpose.** Get task-relevant public-graph context for a natural
language goal. Thin passthrough to anonymous `GET /context`. The
canonical "what should I know about X from the shared graph?"
discovery primitive.

**Backend.** `GET /context?q=<query>&depth=<depth>` with **no
Authorization header**.

**Backend source.** `api/src/routes/context.ts`, anonymous-scope
filtering at the access layer.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000,
      "description": "Task or question to ground in the public knowledge graph."
    },
    "depth": {
      "type": "string",
      "enum": ["shallow", "deep"],
      "description": "Depth of context retrieval. Defaults to backend default."
    }
  }
}
```

**Output payload.**

```json
{
  "ok": true,
  "authority": "public_overlay",
  "query": "...",
  "sections": { /* raw GET /context response body */ }
}
```

The `sections` object is the raw backend response shape. The MCP
server does not reshape per-section content. The only added field is
the envelope-level `authority: "public_overlay"`.

**Failure cases.** Same mapping as `vo_public_search`. `/context` is
rate-limited at 60/60s — 429 maps to `upstream_error` with
`status: 429`.

**Write-safety / authority notes.**

- Results are from the public knowledge graph; treat them as
  background reference, not as tenant decisions
- For tenant-private context (decisions, preferences, prior
  corrections), use `vo_pretask_ground` or `vo_memory_recall_routed`,
  not this tool
- Public context can suggest patterns the tenant has not adopted —
  do not silently propose them as tenant policy

### Why No `vo_public_trends` in Rung 4

`/trends` is anonymously reachable on the local node (no
`requireBetaAccess()` middleware), so on the surface it looks like a
clean third primitive next to `/search` and `/context`. It is **not**
included in rung 4 because the route is not structurally
access-scoped.

Concretely:

1. The route handler in `api/src/routes/trends.ts` calls
   `getTrendDashboard(agent)` directly. The handler never reads the
   request access context and never plumbs `spaceIds` into the
   downstream query.
2. `getTrendDashboard()` in `miners/src/trends/service.ts` runs
   `SELECT addr, label, substance, source_context, stimulus_heat, created_at FROM nodes WHERE node_type = 'trend' ORDER BY created_at DESC` —
   no `space_id` filter, no `visibility` filter, no access-context
   parameter.
3. Trend rows are currently inserted with `visibility = 'public'` by
   the miners pipeline, so today's behavior is compatible with the
   intended public-only shape, but that safety is a **writer-side
   convention**, not a **reader-side structural restriction**.

Rung 4's authority story is "anonymous access at the local node is
structurally restricted to the public graph by the access layer". A
single tool whose safety actually depends on a writer convention
weakens that story for the whole rung. A future code change that
inserted a tenant-private trend row would silently leak through
`vo_public_trends` with the `authority: "public_overlay"` envelope
label attached to it — exactly the conflation rung 4 forbids, and
exactly the failure mode that would be hardest for an agent to
detect.

**Two paths forward, both deferred to a follow-up:**

- **Preferred:** add real access scoping to `/trends` (plumb the
  request access context through `getTrendDashboard()` and add a
  `space_id`/`visibility` filter at the SQL layer, the same way
  `/search` and `/context` already do). When that lands,
  `vo_public_trends` can be added in a `MCP-PUBLIC-TRENDS-AMENDMENT-PR`
  with no additional design pass needed — the tool spec is already
  drafted in this PR's history and trivial to restore.
- **Acceptable:** if `/trends` is locked to public-only by stronger
  invariants (e.g. a check constraint on the `nodes` table or a
  `WHERE visibility = 'public'` filter inside `getTrendDashboard()`
  that does not depend on writer behavior), the same amendment can
  ship without any access-context plumbing.

Until one of those lands, rung 4 ships only the two structurally-safe
primitives. This matches the contract's overall "narrow, durable
surface" bias and avoids importing a convention-dependent safety
model into a rung that otherwise enforces structural safety.

### Why No `vo_public_ground` in Rung 4

The earlier deferred section in this contract listed `vo.public.ground`
as a candidate. Rung 4 explicitly does NOT include it. Reasoning:

1. **`/ground` requires beta auth.** `api/src/index.ts` line 89:
   `app.use("/ground", requireBetaAccess())`. An anonymous call to
   `/ground` returns `401 Unauthorized` — the structural-restriction
   approach that works for `/search` and `/context` fails here at the
   middleware layer instead of at the access-scope-filter layer.
2. **Sending the agent token to `/ground` returns mixed results.** The
   agent token has `scope: "beta"` and `tenantId: <tenant>`, so the
   access layer returns public + tenant-shared results — the exact
   conflation rung 4 forbids.
3. **No clean middle ground without touching `api/src/`.** Options
   considered: a separate beta-only token (new auth ceremony), a
   `public_only=1` query parameter on `/ground` (touches api/), or
   MCP-side filtering of mixed results (violates thin-adapter rule).
   None are justified by demand for rung 4.
4. **Grounding is a tenant-authoritative operation in the current
   architecture.** `vo_memory_recall_routed` already handles "ground
   me on this query" with proper tenant context. Adding a strictly-
   public ground tool duplicates that surface for marginal value.

If real agent usage in rung 4 surfaces a clear demand for public-only
grounding, a future `MCP-PUBLIC-GROUND-DESIGN-PR-1` can revisit. For
now, the contract is explicit: no `vo_public_ground`, no
`vo_public_insight`, no `vo_public_regrounding`, no `vo_public_check`.

### Rung 4 Error Model (same 4 classes)

The existing four error classes still cover every rung-4 failure mode.
**No new error class is added.** Rung-4 refinements:

1. **`tenant_auth_failure` is structurally impossible** in rung 4
   because the tools never send a tenant token. If a rung-4 tool
   returns this class, the implementation has drifted (probably by
   accidentally inheriting the auth-attaching client method instead
   of the anonymous variant).
2. **HTTP 429 (rate-limited)** maps to `upstream_error` with the
   numeric `status: 429` preserved in the envelope. Agents should
   honor `Retry-After` semantics if present and back off. The local
   node's anonymous rate-limit bucket is shared across all anonymous
   localhost callers (effectively "this MCP server"), so a runaway
   agent loop will throttle itself before affecting any other process.
3. **HTTP 401 from `/ground` or other beta-required routes** would
   map to `tenant_auth_failure` per the existing rule. Since rung 4
   does NOT call any beta-required route, this case should never
   arise in practice. If it does, treat it as drift.
4. **Result body shape unexpected** (e.g. `/trends` returning HTML
   from a misconfigured proxy) → `upstream_error` with `detail`
   carrying the first 400 characters of the body, per the existing
   `extractBodyMessage` helper.

### Observability Note (informative)

Anonymous localhost calls share the local node's `"local"`
rate-limit bucket because `clientKey()` in `api/src/lib/access.ts`
falls back to `"local"` when `x-forwarded-for` and `x-real-ip` are
both absent. For a single tenant machine running one MCP server
this is fine — there is exactly one anonymous-localhost caller. If
future operator visibility ever wants to distinguish MCP-anonymous
traffic from other anonymous local traffic, the implementation rung
may set a `User-Agent: vo-mcp/<version> (public-feed)` header on
rung-4 calls. This is **optional** and is NOT a contract requirement
in rung 4 — operators wanting to bucket MCP traffic separately would
need to add User-Agent-aware rate limiting in `api/src/lib/access.ts`,
which is out of scope here.

## Deferred Surface

Not in rungs 1, 2, 3, or 4. Listed here so there is no ambiguity about scope:

- **Vault write tools.** Creating, harvesting, finalizing, deleting, or
  otherwise mutating vault artifacts from MCP. **Indefinitely out of
  scope.** Vault writes remain the `vo vault harvest/confirm/finalize`
  CLI path and there is no current MCP rung that adds them. This is not
  a "deferred to later rung" — it is a structural decision.
- **Public-graph write tools.** `vo.public.write`, `vo.public.publish`,
  or any equivalent public-graph authoring surface. **Indefinitely out
  of scope.** Public-graph authoring is the operator-only `vo publish`
  CLI path; no current or planned MCP rung exposes it.
- **Public-graph beta-required reads.** `vo.public.ground`,
  `vo.public.insight`, `vo.public.regrounding`, `vo.public.check`. Not
  in rung 4 because the underlying routes require beta auth and there
  is no clean way to get strictly-public results without touching
  `api/src/` or filtering MCP-side. See *Why no `vo_public_ground` in
  Rung 4* in the rung-4 section above.
- **`vo.public.trends`.** Not in rung 4 because `/trends` is not
  structurally access-scoped at the SQL layer — its current public-only
  behavior depends on a writer-side convention rather than a reader-side
  filter. Deferred to a follow-up amendment after `/trends` plumbs the
  request access context through `getTrendDashboard()` (preferred) or
  adds an unconditional `visibility = 'public'` filter inside the
  service. See *Why no `vo_public_trends` in Rung 4* in the rung-4
  section above.
- **Remote MCP transports.** HTTP/SSE/WebSocket transport. Deferred
  indefinitely — outbound stdio only matches the local-first architecture.
- **MCP elicitation, tasks, and apps.** Not in any current rung.
- **Cross-device sync.** Not an MCP concern. Belongs to an eventual optional
  public feed.
- **Bulk write tools.** Any tool that writes more than one memory per call.
  Not in rung 2.
- **Heuristic-driven writes.** Any tool that synthesizes memories from
  session transcripts or conversation history without explicit user intent.
  Not in any current rung.

## Non-Negotiables

1. MCP lives in its own top-level `mcp/` package from line 1.
2. The local HTTP core on `127.0.0.1:3100` remains first-class and is not
   deprecated.
3. Rung 1 is read-only. No write, update, retract, or forget tools.
4. stdio is the only MCP transport in rung 1.
5. Node (>= 20 LTS) is the runtime. Bun is not the MCP runtime.
6. Tool wire names are underscored snake_case.
7. The tenant bearer token is never written into an MCP client's config file
   as the documented install path.
8. Every install entry uses absolute paths for both command and args.
9. The MCP server fails honestly: no silent fallback to public VO, ever.
10. The MCP server is a thin transport adapter. If it starts re-implementing
    ranking, routing, validation, or storage, the rung is off course.
11. Broker/Vercel/tunnel assumptions do not return through the MCP side door.
12. The `mcp/` package ships its own standalone CLI binary named **`vo-mcp`**,
    and the main `vo` CLI ships thin wrappers `vo mcp install` / `vo mcp doctor`
    that call the SAME library functions (`install()` / `doctor()` /
    `doctorClient()`) via lazy dynamic import. The wrappers do not shell out
    to `vo-mcp`, do not re-implement install or doctor semantics, and do not
    introduce a second config layout. `vo doctor --mcp` is still NOT a
    recognized command — the MCP doctor lives under the `mcp` subcommand
    namespace only. The two binaries remain library-level equivalents: either
    path produces an identical `~/.vo/mcp/` layout and an identical client
    config entry. Under no circumstance does `vo-cli.ts` gain its own
    implementation of install / doctor; if it drifts from thin-wrapper
    posture, the rung is off course.
13. **Rung 2 write tools do not fabricate provenance.** The MCP write
    layer must never auto-fill `source_refs`, `bootstrap_context`,
    `project_addr`, `why_it_matters`, `supersedes`, or upgrade `source`
    kind from `agent_inferred` to `user_accepted` without explicit user
    intent in the same turn. This is a refusal rule at the tool-description
    and implementation layer, not a validation rule at the backend.
14. **`vo_pretask_ground` is a literal composition of
    `/bootstrap/project` + `/memory/recall/routed`.** It never embeds its
    own classification, ranking, routing, or recall logic. If it starts
    doing that, the rung is off course and the PR is rejected.
15. **Rung 3 vault tools are read-only and strictly downstream of the
    memory authority.** MCP vault tools must never promote vault
    artifacts to a second memory authority, never auto-write vault
    content back into memory, never embed vault-write surface, and
    never return vault content in a memory-shaped envelope. Vault
    results carry `hash` / `slug` / `filename` / `source` fields —
    **never** `addr` / `kind` / `federation` — so agent output stays
    un-conflated. The memory graph on `127.0.0.1:3100` remains the
    single authority for tenant-private truth.
16. **Rung 3 vault reads do not touch `api/src/` or add HTTP surface.**
    Vault *read* tools (`vo_vault_list`, `vo_vault_lookup`) are direct
    filesystem operations from the `mcp/` process against
    `<vault_root>/dossiers/` under the resolved vault root.
    `api/src/` remains zero-aware of the vault filesystem layout for
    rung-3 reads. A revision to this rule was consciously justified by
    **Rung 7 — Local Vault Harvest Operator** for one narrow write
    exception (`vo_vault_harvest_auto` → `POST /machine/vault/harvest-auto`,
    which is a facade over capabilities `api/` already owns via
    `api/src/lib/vault-harvest.ts`; the Rung-7 rationale explains why
    the direct-fs posture does not apply to harvest specifically).
    For every other vault write operation (granular confirm, finalize,
    delete, clipper sync), `vo-cli.ts` remains the single owner of
    the vault write lifecycle. Any further HTTP vault surface beyond
    Rung 7 requires another explicit design pass and another
    non-negotiable revision — not a quiet drift from direct-fs to HTTP.
17. **Rung 4 public-feed tools call the local VO node anonymously.**
    The `mcp/` package never reaches a remote public service for rung-4
    tools. It calls `127.0.0.1:3100` with **no `Authorization` header**
    so the access layer's anonymous-scope filter naturally restricts
    results to the public graph (`spaceIds: [GLOBAL_SPACE_ID]`). If a
    rung-4 implementation ever sends the tenant token to a public-feed
    backend call, the rung is off course and the PR is rejected. The
    `tenant_auth_failure` error class is structurally impossible in
    rung 4 and its appearance is a drift signal.
18. **Rung 4 public-feed results are envelope-labeled
    `authority: "public_overlay"` and never silently mix into memory.**
    Every rung-4 success result carries a top-level
    `authority: "public_overlay"` field added by the MCP tool itself.
    No other surface (memory, vault) sets this top-level field. Public
    reads never trigger memory writes — if an agent wants to save
    something from the public graph into tenant memory, it must call
    `vo_memory_write` explicitly. Public-graph authoring stays the
    operator-only `vo publish` CLI path and is not exposed through
    MCP at any rung.

## Rung 5 Review/Audit Read Surface

Two read-only tools added in rung 5. These are thin adapters over
already-shipped HTTP routes. They expose no write semantics, no approval
path, and no overlay promotion through MCP.

| Logical                     | Wire                          | Backend                          |
|-----------------------------|-------------------------------|----------------------------------|
| `vo.memory.review`          | `vo_memory_review`            | `GET /memory/review`             |
| `vo.memory.inspect`         | `vo_memory_inspect`           | `GET /memory/:addr/audit`        |

Not in rung 5: `vo_memory_approve` (approval requires human operator authority
and is intentionally CLI-only in v1), `vo_memory_history` (the audit snapshot
from `vo_memory_inspect` already includes recent events), overlay promotion.

### `vo_memory_review`

List active tenant-local memories pending human review. Read-only discovery
surface — does not change any memory state.

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "minimum": 1,
      "maximum": 100,
      "description": "Maximum items to return (default 20)."
    }
  }
}
```

**Output payload.** The JSON-encoded body of `GET /memory/review`:

```json
{
  "ok": true,
  "items": [
    {
      "addr": "PJ.0.3.42",
      "label": "Architecture uses event sourcing",
      "kind": "decision",
      "source": "agent_inferred",
      "accepted_by_user": false,
      "overlay_origin": true,
      "promoted_from": { "overlay_id": "pub:123", "overlay_addr": "OVL.0.0.abc" }
    }
  ],
  "count": 1,
  "note": "Active agent_inferred tenant memories pending human review. ..."
}
```

**Failure cases.** `tenant_auth_failure` if no tenant token. No other
tool-specific failure — the route always returns 200 with an items array
(possibly empty).

### `vo_memory_inspect`

Compact read-only audit snapshot for a single memory: identity, trust state,
provenance, promotion linkage, approval metadata, and recent lifecycle events.

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "addr": {
      "type": "string",
      "pattern": "^PJ\\.\\d+\\.\\d+\\.\\d+$",
      "description": "Canonical memory address, e.g. PJ.0.3.512"
    },
    "event_limit": {
      "type": "number",
      "minimum": 1,
      "maximum": 50,
      "description": "Maximum recent events to include (default 10)."
    }
  },
  "required": ["addr"]
}
```

**Output payload.** The JSON-encoded body of `GET /memory/:addr/audit`:

```json
{
  "ok": true,
  "addr": "PJ.0.3.42",
  "label": "Architecture uses event sourcing",
  "kind": "decision",
  "source": "agent_inferred",
  "accepted_by_user": false,
  "status": "active",
  "trust_state": "agent_inferred",
  "overlay_origin": true,
  "promoted_from": { "overlay_id": "pub:123" },
  "approval": null,
  "recent_events": [],
  "created_at": "2026-04-10T12:00:00Z",
  "updated_at": "2026-04-10T12:00:00Z"
}
```

**Failure cases.** `not_found` if memory is not found (404). Same shared
error model as all other tools.

## Rung 6 Overlay Promotion Tool Surface

One write tool added in rung 6. This is a thin adapter over the
already-shipped promotion API route. Promotion through MCP always
produces `agent_inferred` trust state — it is NOT approval.

| Logical                     | Wire                          | Backend                          |
|-----------------------------|-------------------------------|----------------------------------|
| `vo.overlay.promote`        | `vo_overlay_promote`          | `POST /memory/promote-overlay`   |

Not in rung 6: `vo_memory_approve` (approval requires human operator
authority and is intentionally CLI-only in v1), any tool that changes
the original overlay row, any tool that infers `user_accepted` trust.

### `vo_overlay_promote`

Explicitly promote an imported public overlay into a new tenant-local
memory. The original overlay row stays unchanged. The promoted memory
is always `agent_inferred` when created through MCP — approval is a
separate human path via `vo memory approve`.

Idempotent: if the overlay was already promoted, returns the existing
promoted memory address with `already_promoted: true`.

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "overlay_addr": {
      "type": "string",
      "description": "Address of the overlay node to promote, e.g. OVL.0.0.abc123def456"
    },
    "reason": {
      "type": "string",
      "maxLength": 500,
      "description": "Optional reason for promotion. Stored in promoted_from metadata."
    }
  },
  "required": ["overlay_addr"]
}
```

**Output payload.** The JSON-encoded body of `POST /memory/promote-overlay`:

```json
{
  "ok": true,
  "promoted": true,
  "already_promoted": false,
  "memory_addr": "PJ.0.3.42",
  "overlay_addr": "OVL.0.0.abc123def456",
  "overlay_id": "pub:123",
  "source_kind": "agent_inferred"
}
```

**Failure cases.**
- `validation_failure` if overlay not found, dormant, or missing source
  identity (400 from backend).
- `tenant_auth_failure` if no tenant token.
- Same shared ErrorClass model as all other tools.

**Trust semantics.** The promoted memory is always `source_kind:
"agent_inferred"` and `accepted_by_user: false` when created through
MCP. This is not a design gap — it is the intended boundary. Human
approval is a separate act via `vo memory approve <addr>`.

### Rung 6 Error Model (same 4 classes)

The existing four error classes still cover every rung-6 failure mode.
**No new error class is added.**

## Rung 7 Local Vault Harvest Operator

VO-LOCAL-MCP-HARVEST-OPERATOR-PR-1. Binding design pass that the Rung 3
authority section deliberately left room for ("Write tools are not
deferred to a later MCP rung — they are explicitly out of scope
indefinitely unless a later design pass justifies them").

Rung 7 adds **one** write-capable vault tool: `vo_vault_harvest_auto`.
Nothing else. Confirm, finalize, delete, clipper-sync, and every other
granular vault operation remain out of scope and stay CLI-only.

### Why this isn't the rejected `/vault/*` HTTP shape

Rung 3's Backend Shape Decision rejects `/vault/*` HTTP routes on the
local VO node with the rationale:

> "Rejected because it teaches `api/src/` about the vault filesystem,
>  adds a new configuration surface (VERITY_VAULT_ROOT or equivalent),
>  and creates a second place where vault layout knowledge has to stay
>  consistent."

That rationale does not apply to harvest. The harvest engine
(`api/src/lib/vault-harvest.ts`, ~1,850 lines) is **already** part of
`api/` and **already** owns the full vault filesystem contract end-to-
end: capture, atomize, draft dossier, confirm writes to `/memory/write`,
finalize emits the finalized dossier, and doc-link hits
`/ops/link-doc`. Vault-root resolution is **already** a first-class
`api/` capability (`resolveConfiguredVaultRoot` +
`readVaultDashboardState` in `api/src/lib/vault-control.ts`). Dashboard
operators call that exact surface via `POST /dashboard/vault/harvest`.

The Rung-7 route (`POST /machine/vault/harvest-auto`) is a **JSON
facade over capabilities `api/` already has** — not a new filesystem
responsibility handed to `api/`. It teaches `api/` nothing new. The
one-tool-for-harvest-only scope keeps the surface narrow enough that
the Rung-3 "read-only" framing continues to hold for every other vault
operation.

Rung 3 filesystem reads (`vo_vault_list`, `vo_vault_lookup`) are
**unchanged** — they still stay out of HTTP and read directly from the
tenant's own filesystem. Only the harvest write surface is routed
through `api/`, because only the harvest write surface needs the
engine that already lives there.

### Backend Shape

| Surface                          | Owner     | Path                                |
|----------------------------------|-----------|-------------------------------------|
| Shared harvest engine            | `api/`    | `api/src/lib/vault-harvest.ts`      |
| Dashboard HTML facade (humans)   | `api/`    | `POST /dashboard/vault/harvest`     |
| Machine JSON facade (MCP agents) | `api/`    | `POST /machine/vault/harvest-auto`  |
| CLI facade (terminal)            | CLI       | `vo vault harvest --auto`           |
| MCP tool                         | `mcp/`    | `vo_vault_harvest_auto`             |

All four facades call the same `runVaultHarvestAuto(...)` function.
None of them reimplements harvest. The engine owns the 7-stage
pipeline (CAPTURE → ATOMIZE → CURATE → CONFIRM → GRAPH_WRITE →
FINALIZE → LOG), the honest-stop taxonomy (`AutoOutcome`), the
doc-link degradation contract, and every filesystem layout decision.

### Authority Model

1. **MCP tenant bearer only — and agent-mapped, not plain beta.** Rung 7
   adds **no** second token channel on the MCP client side. No operator
   token in client JSON, no new env variable, no new credential flow
   through `mcp/`. But the harvest route additionally requires the
   presented bearer to resolve to a non-null `access.tenantId` on the
   server, because `/memory/write` requires that tenant binding. That
   means a bearer registered in `VERITY_AGENT_TOKENS` **and** mapped in
   `VERITY_AGENT_TENANTS`. A plain beta bearer (just in
   `VERITY_BETA_TOKENS`, no agent mapping) or an operator bearer (in
   `VERITY_OPERATOR_TOKENS`) resolves to `access.tenantId: null` and is
   rejected by `/machine/vault/harvest-auto` with:

   ```json
   {
     "ok": false,
     "error": "Harvest requires a bearer that resolves to a tenant (agent-mapped token). …",
     "reason": "tenant_scoped_bearer_required"
   }
   ```

   The MCP client-side auth contract (`~/.vo/config.json#agent_token` /
   `access_token` / `VO_TOKEN`) is unchanged — this narrowing only
   describes which of those bearers can actually succeed on the
   harvest surface. Beta bearers continue to work for every other
   Rung 1–6 MCP tool; Rung 7 is the one tool that requires an
   agent-mapped tenant bearer specifically.

2. **Server-side readiness gate is authoritative.** The machine route
   refuses to run the engine unless
   `readVaultDashboardState(null, tenantId).status_kind === "ready"` —
   the identical gate the dashboard UI uses. This covers
   `vault_enabled` intent, configured-root presence, root inspection,
   and tenant-binding match in one check. MCP's own vault-root
   discovery chain (`mcp/src/vault-root.ts`) stays a client-side
   sanity seam only; it does NOT authorize a harvest.

3. **No `vault_root` input on the tool or the route.** The server's
   configured vault root is authoritative. Accepting a client-supplied
   root would let the caller point the engine at an arbitrary
   filesystem path, trivially bypassing the readiness gate.

4. **Doc-link honesty.** `/ops/link-doc` requires operator auth. The
   machine route resolves an operator token from its own env (the
   first entry of `VERITY_OPERATOR_TOKENS`) if set; otherwise it
   passes `operatorToken: null` to the engine, and the engine honestly
   skips the doc-link stage. The resulting outcome's `docLink` field
   carries one of four canonical values defined in
   `api/src/lib/vault-harvest.ts#ConfirmResult.doc_link_status`:
   - `"linked"` — /ops/link-doc returned 2xx.
   - `"skipped_no_operator_auth"` — no usable operator token was
     resolved (typical when `VERITY_OPERATOR_TOKENS` is unset).
   - `"skipped_no_project"` — the confirm stage had no project addr
     to link against.
   - `"failed"` — /ops/link-doc was attempted but returned non-2xx.

   MCP surfaces the value verbatim on `outcome.docLink`. Agents branch
   on the enum, never parse prose.

### Tool: `vo_vault_harvest_auto`

**Purpose.** Trigger a full end-to-end harvest of a local file or URL
into the tenant's local vault, running against the shared engine.

**Backend.** `POST /machine/vault/harvest-auto` on the local VO node.
The route:

1. Requires a tenant bearer (`access.tenantId` non-null).
2. Calls `readVaultDashboardState(null, tenantId)`.
   - `status_kind !== "ready"` → **200**
     `{ ok: false, kind: "precondition", status_kind, reason, message }`
     (pre-engine gate refusal).
3. Resolves a server-side operator token from env (honest-optional).
4. Calls `runVaultHarvestAuto({ root: state.vault_root, source,
   tenantToken: <MCP bearer>, operatorToken: <env or null>,
   verbose: false })`.
5. Returns **200** `{ ok: true, outcome: AutoOutcome }`.

**Why 200 for gate refusals.** The MCP `VoClient` maps HTTP 400/404 to
`validation_failure`, 401/403 to `tenant_auth_failure`, and everything
else (including 409) to `upstream_error`. Flattening honest stops to
`upstream_error` would drop the precise `status_kind`. Rung 7 avoids
this by keeping both engine outcomes and gate refusals on 200, with
discrimination in the body (`ok: true/false`, `kind`). The tool maps
gate refusals to `validation_failure` with the exact `status_kind` in
the envelope's `detail`.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["source"],
  "properties": {
    "source": {
      "type": "string",
      "description": "Absolute file path OR http(s) URL to harvest. Relative paths are rejected — they would resolve against the API server's cwd, not the caller's. No vault_root argument is accepted — the server's configured vault root is authoritative."
    }
  }
}
```

Source-shape enforcement happens **twice**, intentionally:
- MCP tool handler refuses a relative path client-side with
  `validation_failure`, saving a round trip.
- Machine route re-validates server-side and returns 400 with
  `reason: "source_not_absolute"` if the tool check is ever bypassed
  (e.g. a different MCP implementation, a direct HTTP client).

**Output payload (engine completion).**

```json
{
  "ok": true,
  "outcome": {
    "kind": "success",
    "capturePath": "captures/a1b2c3d4-demo.md",
    "dossierPath": "dossiers/a1b2c3d4-demo.dossier.md",
    "graphWrite": "fresh",
    "atomsWritten": 5,
    "atomsDeduped": 0,
    "docLink": "linked"
  },
  "summary": "Harvest complete — 5 atom(s) written, 0 deduped. Local vault authoritative."
}
```

Stop outcomes carry their AutoOutcome taxonomy verbatim. Examples:

```json
{
  "ok": true,
  "outcome": {
    "kind": "stop_vo_unavailable",
    "subReason": "all_writes_failed",
    "hash8": "a1b2c3d4",
    "root": "/Users/tenant/knowledge",
    "dossierPath": "dossiers/a1b2c3d4-demo.dossier.md",
    "atomsProposed": 5,
    "draftPath": null
  },
  "summary": "Stopped — 0 of 5 atoms reached the VO graph. Local files preserved."
}
```

```json
{
  "ok": true,
  "outcome": {
    "kind": "stop_missing_key",
    "capturePath": "captures/a1b2c3d4-demo.md",
    "envVarName": "GOOGLE_API_KEY",
    "providerLabel": "Google AI (Gemini)"
  },
  "summary": "Stopped — AI model API key not configured. Run `vo onboard` locally."
}
```

`outcome.kind` is load-bearing. The additive `summary` is a short
human-readable status line; agents that want structured branching
should read `outcome.kind` (and, for `stop_vo_unavailable`,
`outcome.subReason`).

**Stop taxonomy.** Same as the shared engine. Five distinct `kind`s:

| `outcome.kind`           | Meaning                                                           |
|--------------------------|-------------------------------------------------------------------|
| `success`                | All 7 stages landed. Memories written, dossier finalized, doc-link ran. |
| `stop_missing_key`       | No LLM API key; capture preserved, no atomize/draft/graph-write.  |
| `stop_vo_unavailable`    | Four `subReason`s: `unreachable` / `missing_tenant_auth` / `all_writes_failed` / `unknown`. Engine recovered honestly at the stage where VO could not complete. |
| `stop_finalize_conflict` | Operator-edited dossier differed from the engine's generated version; the operator-edited file is preserved, the engine-generated version is routed to `.conflicts/`. |
| `stop_unknown`           | Uncategorized stage failure. Carries `stage` + `message` + `resumeHint`. |

**Failure cases (tool-level envelope).**

| Cause                                            | Error class (+ `reason`)           |
|--------------------------------------------------|------------------------------------|
| `source` missing / empty                         | `validation_failure` (`source_missing`) |
| `source` relative (not absolute, not URL)        | `validation_failure` (`source_not_absolute`) |
| Bearer missing / not agent-mapped to a tenant    | `tenant_auth_failure` (`tenant_scoped_bearer_required`) |
| Tenant bearer missing / rejected at HTTP layer   | `tenant_auth_failure`              |
| Vault state not `ready` (any `status_kind`)      | `validation_failure` (`reason` = the exact `status_kind`) |
| Local VO unreachable                             | `local_vo_unreachable`             |
| Engine completes with any `stop_*` outcome       | *not* a failure — succeeds with `outcome.kind: "stop_*"` |
| Unexpected non-JSON / shape drift                | `upstream_error`                   |

Every MCP refusal carries a stable structured `reason` code in the
error envelope alongside the free-form `message` and `detail`. Agents
should branch on `reason` (not prose). Client-side refusals (MCP
tool handler) and server-side refusals (machine route) share the
SAME reason codes where they describe the same problem — for
example, a relative `source` rejected at the MCP layer and rejected
at the HTTP layer both emit `source_not_absolute`. The reason
describes the condition, not which boundary caught it.

Engine outcomes — including every honest stop — travel as successful
tool calls (`isError: false`). An agent that wants to know whether the
harvest landed must read `outcome.kind`.

### Rung 7 Error Model (same 4 classes)

The existing four error classes still cover every rung-7 tool-envelope
failure. **No new error class is added.** Engine stops are first-class
*successful* outcomes carried on `outcome.kind`, not envelope-level
errors.

## Day Journal Local Tools

Rung 1 of the day-journal plan added two **local stdio MCP only** manual
writer tools. PR10 extends that local surface with read/search and routine
execution adapters. Every tool below calls the local HTTP authority on
`127.0.0.1:3100`; this section is intentionally not a hosted/web MCP
contract. Hosted agents use mirrored reads and queued write intent instead
of direct local authority calls.

Hosted/web MCP can queue explicit manual day-journal entry intents through
`vo.write.intent` with `category: "routines"` and command types
`day_journal.entry_create` or `day_journal.entry_retract`. The hosted queue
does not apply the write; the authoritative local VO node claims the command,
revalidates the VOJ payload, and applies it through the same day-journal writer
used by the local tools. Hosted MCP still cannot enable, disable, configure,
dry-run, or run routines directly.

| MCP tool                         | Backend route                                      | Scope      |
|----------------------------------|----------------------------------------------------|------------|
| `vo_day_journal_entry_create`    | `POST /day-journal/entries` or `/entries/dry-run` | local only |
| `vo_day_journal_entry_retract`   | `POST /day-journal/entries/:entry_key/retract`    | local only |
| `vo_day_journal_day_get`         | `GET /day-journal/day/:addr`                      | local only |
| `vo_day_journal_search`          | `GET /day-journal/search`                         | local only |
| `vo_day_journal_routines_list`   | `GET /day-journal/routines`                       | local only |
| `vo_day_journal_routine_dry_run` | `POST /day-journal/routines/:id/dry-run`          | local only |
| `vo_day_journal_routine_run`     | `POST /day-journal/routines/:id/run`              | local only |

### Tool: `vo_day_journal_entry_create`

**Purpose.** Create or dry-run a manual day-journal entry from explicit
`VOJ` command text.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["command_text"],
  "properties": {
    "command_text": { "type": "string", "description": "Explicit VOJ command text. Ordinary prose is refused." },
    "target_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "day_addr": { "type": "string", "pattern": "^TMP\\.[0-9]{4}\\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$" },
    "target_timezone": { "type": "string" },
    "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Required unless dry_run is true. Must be non-blank after trimming and must not contain NUL bytes." },
    "dry_run": { "type": "boolean" }
  }
}
```

Behavior:
- `dry_run: true` calls `POST /day-journal/entries/dry-run` and must not write.
- Non-dry-run calls `POST /day-journal/entries` and requires `idempotency_key`.
- The server-computed create `request_hash` includes the normalized
  `idempotency_key` when one is supplied, so whitespace-only key formatting
  does not drift but different keys remain different request identities.
- The local route rejects request bodies above 128 KiB with
  `payload_too_large` before JSON preparation.
- Ordinary prose returns `validation_failure` with reason `invalid_request`.
- Reserved starters (`VOR`, `VOW`, `VOP`, `VOL`) return
  `validation_failure` with reason `reserved_command`.
- `VOJ --date` conflicting with body `target_date` or `day_addr` returns
  `validation_failure` with reason `target_date_mismatch`.
- Oversized VOJ command text returns `validation_failure` with reason
  `payload_too_large` before any journal writer call.
- Reusing an idempotency key with a different canonical request returns
  `validation_failure` with reason `idempotency_conflict`; the error
  `detail` includes the server-computed `request_hash` for debugging
  canonicalization drift.

### Tool: `vo_day_journal_entry_retract`

**Purpose.** Retract a manual `VOJ` entry by entry key. Retraction is
idempotent at the route layer for an already-retracted owned entry and
returns a successful terminal `entry_state`.

**Input schema.**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["entry_key", "idempotency_key"],
  "properties": {
    "entry_key": { "type": "string", "pattern": "^entry_[0-9]{8}_[a-f0-9]{16}$" },
    "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Must be non-blank after trimming and must not contain NUL bytes." },
    "reason": { "type": "string", "description": "Optional audit-safe reason." }
  }
}
```

Failure cases use the shared MCP envelope classes. Day-journal HTTP 404
responses map to `not_found`; HTTP 400, 409, and 413 responses map to
`validation_failure`. The backend `code` is carried as the structured
`reason`.

### Tool: `vo_day_journal_day_get`

**Purpose.** Read one local day journal by `TMP.YYYY.DDD` address from the
local authority route.

Input: required `day_addr`; optional `tenant_id` for operator tokens. The
tool calls `GET /day-journal/day/:addr` and returns the backend body
verbatim in the normal MCP JSON envelope.

### Tool: `vo_day_journal_search`

**Purpose.** Search normalized local day-journal entries without scanning
day-node JSON in the client.

Input: optional `tenant_id`, `limit`, `offset`, `start_date`, `end_date`,
`routine_id`, `domain`, `tag`, `sensitivity`, and `q`. Client-side validation
mirrors the local route's bounds: `limit` is 1-100, `offset` is 0-10000,
dates are `YYYY-MM-DD`, tags are lowercase slugs, and `q` may not contain
control characters.

### Tool: `vo_day_journal_routines_list`

**Purpose.** List registered local day-journal routine definitions and this
tenant's settings snapshot through `GET /day-journal/routines`.

Input: optional `tenant_id` for operator tokens.

### Tool: `vo_day_journal_routine_dry_run`

**Purpose.** Execute a registered local routine in dry-run mode and update the
backend dry-run marker used by enablement guardrails. Dry-run does not write the
journal entry, but it does run the routine code and may perform declared
external effects such as network calls.

Input: required `routine_id`; optional `tenant_id`, `target_date`,
`day_addr`, `target_timezone`, `config`, and `permission_grants`. The backend
owns routine existence, permission, sensitivity, config-schema, and dry-run
marker validation. Routines with non-standard sensitivity or extra permissions
require operator scope even for dry-run.

### Tool: `vo_day_journal_routine_run`

**Purpose.** Run an enabled, registered local routine now through
`POST /day-journal/routines/:id/run`.

Input: required `routine_id`; optional `tenant_id`, `target_date`,
`day_addr`, `idempotency_key`, and `generate_idempotency_key`. Non-generated
non-dry-run requests require `idempotency_key`; callers must provide exactly
one idempotency mechanism (`idempotency_key` or
`generate_idempotency_key=true`). Conflicts and backend validation failures
use the same shared MCP error envelope as the manual VOJ tools.
Routines with non-standard sensitivity or permissions beyond `journal_write`
require operator scope for run-now calls.

## Rung 8 Resources and Prompts

Rung 8 adds first-class MCP **resources** and **prompts** to the local
stdio server so a MCP client (Claude Desktop, Codex, a bespoke agent)
can consume tenant VO memory as *context* — not only as tool calls.
Resources are read-only by contract; prompts are pure string-producing
guidance. Neither surface adds a new error class, a new HTTP route, or
a new write path.

### Rung 8 Scope

Added in this rung:

| Kind       | Wire URI / name                 | Backend call                   |
|------------|----------------------------------|--------------------------------|
| Static     | `vo://server/status`            | none (pure local)              |
| Static     | `vo://memory/review/pending`    | `GET /memory/review?limit=20`  |
| Template   | `vo://memory/{addr}`            | `GET /memory/:addr`            |
| Template   | `vo://memory/{addr}/audit`      | `GET /memory/:addr/audit`      |
| Prompt     | `vo_recall_context`             | — (pure string)                |
| Prompt     | `vo_what_do_we_know_about`      | — (pure string)                |
| Prompt     | `vo_remember_decision`          | — (pure string)                |

NOT in rung 8 (and not silently mutated through this surface):
tool-layer additions, remote MCP transport, hosted writes, vault
resources, public-graph resources, elicitation, tasks, apps.

### Resource Contract

1. **Read-only.** A resource handler never issues a POST. Template
   handlers never auto-derive an addr from a search — the addr comes
   from the URI template variable and nothing else.
2. **No fallback.** A resource handler that cannot talk to the local
   VO throws `ResourceReadError` and the SDK turns that into a
   JSON-RPC error. No partial-success, no silent empty payload, no
   fake "ok with message" envelope.
3. **Honest stale-API classification.** When the backend returns
   the `/memory/:addr` catch-all's `validation_failure +
   "memory not found"` signature for `/memory/review`, the handler
   throws `ResourceReadError(routeUnavailable: true)` so the
   interop proof can classify that cell as `unproven` rather than
   `fail`. Any other failure is a real failure.
4. **Templates are discovered via `resources/templates/list`.** The
   template URIs are NOT surfaced by `resources/list` and the
   template handlers declare `list: undefined` — memory addrs are
   not enumerable from the resource layer. Agents discover concrete
   addrs via `vo_memory_search`, `vo_memory_recall_routed`, or the
   `vo://memory/review/pending` resource.
5. **`vo://server/status` never exposes a bearer.** The resource
   emits `auth_source` as a *class* (e.g. `"config_file"`) and
   explicitly notes that `VO_TOKEN` is never included. The
   per-resource unit tests pin this at the handler level.

### Prompt Contract

1. **Pure.** Prompt handlers receive args, return a `PromptResult`.
   They never call `VoClient`, never touch the filesystem, never
   mutate state.
2. **Deterministic shape.** Every prompt emits a single
   `role: "user"` message with `content.type: "text"`. Agents (or
   bespoke clients) decide whether to consume the text directly or
   route it to their own template engine; the MCP-facing contract
   stays fixed.
3. **Write-safety is encoded in the prompt text, not in behavior.**
   `vo_remember_decision` instructs the agent to default
   `source=agent_inferred`, never fabricate `source_refs`, and use
   `supersedes` for revisions. The prompt cannot bypass these
   rules — the `vo_memory_write` tool enforces them when the write
   actually happens. The prompt exists to keep the agent inside
   the rails the tool already defends.
4. **Never invokes tools.** MCP prompts and tools are separate
   surfaces. A prompt that orchestrates tool calls does so by
   *asking the agent to call a tool* — it does not call the tool
   on the agent's behalf.

### Rung 8 Error Model (same 4 classes)

The existing four error classes still cover every rung-8 failure.
Resource-read errors propagate as JSON-RPC errors (not envelopes)
and include the originating `ErrorClass` in their message so the
interop proof can classify them. Prompt handlers cannot fail for
I/O reasons — only Zod validation errors on malformed args, which
the SDK returns before the handler runs.

## References

- `docs/VO-MCP-LOCAL-FIRST-ARCHITECTURE.md` — architectural center and rules
- `docs/VO-MCP-PR-LADDER.md` — rung ordering and acceptance bars
- `docs/VO-MCP-R0-READINESS.md` — footprint baseline and hand-proof result
- `docs/VO-CURRENT-STATE.md` — product posture
- `api/src/routes/bootstrap.ts` — backend for `vo_bootstrap_project`
- `api/src/routes/memory.ts` — backend for `vo_memory_recall`,
  `vo_memory_recall_routed`, `vo_memory_get`, `vo_memory_search`
- `api/src/lib/recall-compiler.ts` — authoritative `RecallResult` shape
- `api/src/lib/domain-router.ts` — authoritative `RoutingTrace` shape
- `api/src/lib/memory-contract.ts` — authoritative memory type definitions
- `api/src/lib/vault-harvest.ts` — shared harvest engine (CLI, dashboard, MCP all call this)
- `api/src/routes/machine-vault.ts` — `/machine/vault/harvest-auto` JSON facade (rung 7 backend)
- `api/src/lib/vault-control.ts` — `readVaultDashboardState` readiness gate
