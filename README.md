# Verity One

Verity One is a graph-native knowledge and signal system with two lanes:

- a durable knowledge graph of `nodes` and `edges`
- a transient stimulus lane where fresh signals become `stimuli`, heat, and `TN.*` trend nodes

It is designed to let agents explore, act, and update knowledge without confusing durable truth with fast-moving world signals.

This repository is the **open core** of Verity One: the local, self-hostable node — the graph engine, the knowledge miners, and a local MCP server. Hosted / multi-tenant features ("VO+") are a separate, optional layer and are not part of this repository.

## Ontology Shape

- `WORLD` is the grounding layer: science, institutions, history, and the human world
- `FUNCTION` is the primary actionable layer: methods, tools, workflows, constraints, and execution pathways
- `META` is Verity One's self-knowledge
- `OPENCLAW`, `CLAUDECODE`, `CODEX`, and `PROJECTS` are local or platform-specific sub-domains, not the default sink for global knowledge

## Architecture

- **PostgreSQL 17 + pgvector** for graph storage, semantic retrieval, and stimulus/trend state
- **Bun + Hono** for the API and local surfaces
- **VI pipeline** for ingest: atomize, classify, route, and deliver durable vs transient material
- **Reactor** for stimulus processing, heat maintenance, orphan convergence, trend birth, archive, and recurrence
- **QC Sentinel** for deterministic staging validation and durable-graph review
- **MCP server** (`mcp/`) — a local stdio Model Context Protocol server so MCP-capable agents can query and write the graph

## Runtime Model

- `nodes` / `edges`: durable graph knowledge
- `stimuli`: transient signals and orphan substrate
- `wi_proto_clusters`: orphan convergence before trend birth
- `trend_archive`: dead trend memory and recurrence surface

Trend birth is automatic. Orphaned transient stimuli do not wait for a separate agent review path.

## Quick Start

Requires **Bun** and **PostgreSQL 17 with the `pgvector` extension available**.

```bash
bun install
createdb verity
bun run db:setup          # applies db/schema.sql to the `verity` database

cp .env.example .env      # set GOOGLE_API_KEY for real embeddings (optional for a dry run)

cd api && bun run dev      # API on http://localhost:3100
```

`db:setup` applies `db/schema.sql` — the full, consolidated schema — to the
database named by `PSQL_TARGET`, then `DATABASE_URL`, then
`postgresql://localhost:5432/verity`. It is intended for a fresh database.

Verify the node is up:

```bash
curl -s http://localhost:3100/ | head
curl -s "http://localhost:3100/search?q=knowledge+graph"
```

The graph starts empty — populate it through the API (e.g. `/remember`) or the
ingest workers below.

## MCP Server

`mcp/` is a local stdio MCP server — a thin transport adapter over the API at
`127.0.0.1:3100`. Build it, then point any MCP-capable client at the binary:

```bash
cd mcp
bun install
bun run build
node dist/cli.js serve     # stdio MCP server
node dist/cli.js doctor    # check connectivity to the local API
```

## Workers (optional)

The graph runs on the API alone. For continuous ingest and trend processing,
run the miners:

```bash
bun run miners/src/reactor.ts --watch --interval-seconds 30
bun run miners/src/qc-sentinel.ts
```

## Environment

See `.env.example`. Key variables:

- `DATABASE_URL` — Postgres connection (default `postgresql://localhost:5432/verity`)
- `VERITY_API_PORT` — API port (default `3100`)
- `GOOGLE_API_KEY` — Google embeddings. Without a key, set
  `VERITY_CI=1 VERITY_CI_FAKE_EMBEDDINGS=1` for deterministic local runs.
- `ANTHROPIC_API_KEY` / `INCEPTION_API_KEY` — optional, only for the miner
  ingest and validation passes.

## Repo Layout

```text
api/       HTTP API and agent-facing routes
db/        consolidated database schema (db/schema.sql)
miners/    ingest, Reactor, Sentinel, mining workers
mcp/       local stdio MCP server
packages/  shared libraries (embeddings, db pool, graph shape, hashing, vault)
```

## Security and Privacy

Verity One is **local-first by default**. Knowledge lives on the machine running
the node. This open-core repository contains the local node only; the hosted
mirror, account linking, and outbound sync ("VO+") are a separate, optional layer
and are **not** part of this repository.

When the hosted VO+ layer is used, it employs server-managed encryption at rest
(AES-256-GCM with per-tenant keys). It is **not** zero-knowledge — the hosted
service can decrypt tenant data during active portal and MCP reads. The local
node always remains the authority; any hosted mirror is a derived, stale-capable
copy.

## License

[MIT](LICENSE) © Mark Robinson
