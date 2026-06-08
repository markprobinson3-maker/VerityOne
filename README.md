# Verity One

Verity One is a **local-first memory system for AI agents**. A free, open-source
**local node** runs on your own machine and is the **source of truth** for
everything it remembers — projects, notes, decisions, sources, and the edges
between them — stored as a knowledge graph in **PostgreSQL + pgvector**.

On-machine agents (Claude Desktop, Codex, Claude Code) read and write the node
**live** over a **local stdio MCP server** (`vo-mcp`). Web agents reach a *synced
mirror* at `verityone.app/mcp`, where reads reflect the last sync and writes are
**queued intents** — never applied live. Your local node stays authoritative; the
hosted side (VO+) is an optional bridge, not a second source of truth, and is
**not** zero-knowledge.

## Install (source mode)

Verity One ships as a **source install** — no packaged binary, Homebrew, or npm
release yet. The one-line installer clones the repo at the signed stable commit
and bootstraps a local node:

```bash
curl -fsSL https://verityone.app/install.sh | bash
```

It installs PostgreSQL + pgvector + bun (via Homebrew on macOS), runs migrations,
registers your tenant, writes config, and prints the command to start the node on
`localhost:3100`. Full on-ramp: [verityone.app/start](https://verityone.app/start).

## What it is (and isn't)

- **Local-first.** The node runs on your machine; nothing leaves your desk unless
  you opt into VO+ sync (which is outbound-only).
- **A knowledge + memory graph.** `nodes` are facts/memories, `edges` are
  relationships; everything is searchable by semantic similarity (3072-dim HNSW)
  or keyword (BM25).
- **MCP-native.** Local stdio MCP is the authoritative read/write transport;
  `POST localhost:3100/mcp` returns 404 by design — the web connector lives only
  at `verityone.app/mcp`.
- **Honest about limits.** The hosted mirror is server-managed (not
  zero-knowledge); tenant memory is not auto-deleted; references are recorded
  (linked/missing/optional), not fetched or verified.

## Architecture

- **PostgreSQL 17 + pgvector** — graph storage + semantic retrieval.
- **Bun + Hono** — the API and the local operator/dashboard surfaces.
- **`vo-mcp`** — the local stdio MCP server your agents connect to (`mcp/`).
- **VO+ (optional)** — the hosted web bridge that mirrors local memory on demand.

A public capability graph (the `WORLD` / `FUNCTION` / `META` knowledge pyramids,
plus a world-event "signal" lane that surfaces trends) also runs on the hosted
surface; it is an optional public mirror, not your private local memory.

## Runtime Profiles

VO runs in one of two profiles. Selection lives in `~/.vo/config.json#profile`:

- **`tenant-default`** (the default) — one long-lived VO process (the api),
  Postgres, and an in-api 60-minute SQL-only maintenance cron. No
  runtime-supervisor, no continuous reactor / trend / qc-sentinel workers.
  Lean footprint suited to local-first tenant use.
- **`full`** — runtime-supervisor + reactor + qc-sentinel + trend-sidecar +
  trend-policy + supercron, all in continuous watch mode. The profile for
  developers and operators working on ingest / trend / maintenance
  subsystems.

**If you were running the full worker stack**, add `"profile": "full"` to
`~/.vo/config.json` before restarting. `vo init --profile full` writes this
field for you. The env var `VERITY_PROFILE` is a fallback only for installs
with no config `profile` field yet — it is ignored once the config file
carries a profile value. See `VO-RUNTIME-PROFILES` for the full
contract.

**Switching an existing install** between profiles is one coherent
operation via the `vo profile` command family:

```bash
# Show current config, launchd state, running processes, and alignment
vo profile

# Atomically rewrite ~/.vo/config.json#profile (NO launchctl, NO restart)
vo profile set tenant-default
vo profile set full

# Preview the launchd changes the config implies
vo profile apply --dry-run

# Execute the migration (unloads the legacy plist, installs + loads the
# profile-specific plist, reports the result)
vo profile apply --yes
```

`set` and `apply` are strictly separate: writing the config never touches
launchctl, and apply never overrides the persisted config. That keeps
migrations predictable and reversible.

## Access Tiers

- **Anonymous**: public discovery surfaces only
- **Beta**: authenticated product surface for friends/testers
- **Operator**: internal/admin access, including host-aware routes and maintenance surfaces

The API is now intended for friend beta with authenticated beta tokens, not anonymous public use.

## Quick Start

```bash
bun install
createdb verity
bun run db:reset

cp .env.example .env

cd api && bun run dev
cd scope && bun run dev
```

`db:reset` targets `PSQL_TARGET`, then `DATABASE_URL`, then
`postgresql://localhost:5432/verity`. It is destructive for the selected
database and applies every reset-managed schema file. Never point it at
production; use a disposable database for baseline regeneration or CI
smokes.

For real embedding backfills, set `OPENCLAW_GOOGLE_API_KEY` or
`GOOGLE_API_KEY`. CI and local deterministic smokes can use
`VERITY_CI=1 VERITY_CI_FAKE_EMBEDDINGS=1`; the F7 setup backfill fake
path also requires `--allow-setup-backfill`.

See `VO-FOUNDATION-RUNBOOK` for
the full reset, drift, allowlist, and schema-baseline operating contract.

### Tenant Init

Once the api is running, initialize your local VO config:

```bash
# First-run setup — your token is provided by the VO operator
bun run agent-lab/scripts/vo-cli.ts init --tenant <your-id> --token <your-token>

# Verify everything works
bun run agent-lab/scripts/vo-cli.ts doctor
```

The `--token` flag is the recommended way to provide your tenant token.
It is persisted in `~/.vo/config.json` so subsequent CLI commands,
MCP, and `vo doctor` can use it automatically. Env-var auth
(`VERITY_AGENT_TOKENS` / `VERITY_AGENT_TENANTS`) still works as a
fallback for advanced/CI use cases.

### Set up AI models

```bash
bun run agent-lab/scripts/vo-cli.ts onboard
```

Novice-first flow. Asks for your AI provider API key, stores it locally
in `~/.vo/secrets.env` (owner-only, never committed, never in
`config.json`), and seeds recommended models for the four canonical VO
tasks: **Fast source extraction**, **Fast ingest extraction**, **Draft
review and cleanup**, **Deep synthesis**.

```bash
# Check readiness (Provider · Tasks · Secrets · Next step; secrets are redacted)
bun run agent-lab/scripts/vo-cli.ts onboard-status

# Engineering proof — safe rerun, secret isolation, surgical override
bun run agent-lab/scripts/vo-cli.ts onboard-proof
```

Canonical command story for a first-time tenant:

1. `vo init` — register local node, persist credentials
2. `vo onboard` — set up AI models (API key + task routing)
3. `vo onboard-status` — confirm readiness
4. `vo doctor` — verify full stack is healthy

### First harvest — one command

```bash
bun run agent-lab/scripts/vo-cli.ts vault init --root ~/knowledge --tenant <your-id>
bun run agent-lab/scripts/vo-cli.ts vault harvest --auto --root ~/knowledge path/to/source.md
```

`--auto` runs the full capture → atomize → curate → confirm → graph
write → finalize → log pipeline and ends with a short guided summary:

```text
Capture:     captures/abcd1234-source.md
Dossier:     dossiers/abcd1234-source.dossier.md
Graph write: fresh
Doc link:    linked
Next:        open the dossier in Obsidian
```

If something stops mid-run, the command tells you exactly what
succeeded, what did not happen, and the next command to run. Add
`--verbose` for the full stage transcript.

## Managed Runtime

```bash
./scripts/verity-runtime.sh start
./scripts/verity-runtime.sh status
./scripts/verity-runtime.sh logs reactor
```

If you have been running workers manually during debugging, stop and restart once so the runtime wrapper can reclaim stale Verity worker processes cleanly:

```bash
./scripts/verity-runtime.sh stop
./scripts/verity-runtime.sh start
```

The managed runtime supervises:

- API
- Reactor
- QC Sentinel
- trend sidecar
- trend policy worker

Use the operator-only runtime health surface to inspect the live system:

```bash
curl -H "Authorization: Bearer $VERITY_OPERATOR_TOKEN" \
  http://127.0.0.1:3100/ops/runtime
```

## Manual Processes

```bash
bun run api/src/index.ts
bun run miners/src/reactor.ts --watch --interval-seconds 30
bun run miners/src/qc-sentinel.ts
bun run scripts/trend-sidecar.ts --watch --batch 10 --interval-seconds 30
bun run scripts/trend-policy.ts --watch --batch 10 --interval-seconds 30
```

## Runtime Observability

- `worker_heartbeats` records liveness, status, and per-worker metadata for all long-lived workers
- `/ops/runtime` summarizes worker health, queue depth, trend sidecar/policy state, and staging pressure
- `scripts/runtime-supervisor.ts` restarts crashed workers with backoff and maintains a unified supervisor session id
- `scripts/verity-runtime.sh` wraps start, stop, status, and log tailing for local operations

## CI Tiers

Two complementary CI tiers run on every PR + push to main.

**Pure-unit drift (fast, ~2 min, every PR)** — three workflows under
`.github/workflows/` all run without a Postgres service:

- `foundation-drift-guards.yml` — file-content drift checks for the
  foundation surface (`api/src/lib/foundation-state-drift.test.ts`).
- `federation-drift-guards.yml` — federation contract drift (TS enums vs
  SQL CHECK constraints, ladder doc parity).
- `mcp-drift-guards.yml` — mcp + agent-lab unit tests + typecheck.

**Live schema drift (heavier, every PR + nightly)** —
`.github/workflows/foundation-live-drift.yml` (added in F13, hardened in F10):

- Spins up a digest-pinned `pgvector/pgvector:pg17` service container.
- Runs `bun run db:reset` against the disposable DB. F7 backfill uses
  `VERITY_CI_FAKE_EMBEDDINGS=1` so CI does not depend on a Gemini API key.
- Asserts a runtime-object smoke (tables/columns/functions referenced by
  mounted routes/miners are all present in the fresh reset).
- Regenerates the F10 full-catalog schema snapshot and diffs it against
  `docs/foundation/survey-schema-f10-baseline.json`.
- Runs `foundation-state-drift.test.ts` (live-DB invariant tests RUN
  under `VERITY_LIVE_DRIFT_REQUIRED=1` instead of skipping),
  `federation-state-drift.test.ts`, `federation-ladder-drift.test.ts`,
  and `overlay-lifecycle.test.ts`.
- Regenerates the foundation allowlist JSONLs (chuckone, localhost,
  advisory-lock) into `/tmp/fnd-out` and `diff -u`s them against the
  committed `docs/foundation/*allowlist.jsonl` so a PR that adds a
  chuckone literal without updating the allowlist fails clearly.
- Triggers: PR + push to `main` + manual dispatch + 08:00 UTC nightly cron.

F10 preserves the original F0 survey baseline and adds explicit
post-ladder F10 baselines under `docs/foundation/`.

## Repo Layout

```text
api/      HTTP API and agent-facing routes
db/       schema, migrations, seeds
miners/   ingest, Reactor, Sentinel, mining workers
scope/    graph visualization UI
security/ provenance and integrity helpers
```

## Security and Privacy

Verity One is **local-first by default**. Tenant-private memory content
lives on the tenant's machine and does not leave unless VO+ outbound sync
is explicitly enabled. VO+ account linking sends identity/binding metadata
(tenant_id, node_id, public key) to the hosted service even without sync.

**VO+ hosted mirror** is opt-in. When enabled, selected tenant data is
pushed to a hosted account for web portal access and portable agent MCP.
The current hosted mirror uses **server-managed encryption at rest**
(AES-256-GCM with per-tenant keys). **It is NOT zero-knowledge** — the
hosted service can decrypt tenant data during active portal and MCP reads.

Local VO remains the authority. The hosted mirror is a derived, stale-capable
copy. See `VO-SECURITY-POSTURE` for
the full trust model, plaintext metadata exposure, auth-plane separation,
and the hardening roadmap toward stronger security tiers.
