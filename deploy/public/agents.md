# Verity One — Agent Contract

Verity One is a local-first memory layer and knowledge graph for AI agents. This contract mirrors `/.well-known/agent` and `/schema`, states the authority invariant, and lists what an agent MUST NOT assume.

## Authority invariant

Your local node is the one source of truth. It is a local PostgreSQL-backed API on your own machine. There are two access paths to it, and only one is live authority:

- **On-machine agents** reach the local node over the local stdio MCP server `vo-mcp` and read and write LIVE.
- **Web agents** reach a synced mirror at `verityone.app/mcp`, where reads reflect the last sync and writes are QUEUED as intents — never applied live.

The hosted mirror is a mirror, not authority, and it is not zero-knowledge.

## The three surfaces

1. **Local stdio MCP (`vo-mcp`) — authority.** The stdio MCP server on your machine, with full read and write tools against the local node. This is the authoritative transport. The local node does NOT serve a web/HTTP MCP endpoint; `POST localhost:3100/mcp` returns 404 by design.
2. **`verityone.app/mcp` — MCP Streamable HTTP mirror.** An MCP connector over Streamable HTTP: JSON request/response, no SSE, sessionless, OAuth-bearer authenticated. It reads the last-synced mirror and accepts queued write intents. It is not the local node and not full MCP spec parity.
3. **`/hosted-mcp/*` — hosted REST, not MCP.** A hosted REST API authenticated with a `vop_REDACTED` bearer token. It is REST, not an MCP transport.

## Live entry points

All of these return 200 and may be relied on:

- `GET /` — discovery (content-negotiated JSON describing the system and routes).
- `/schema` — the ontology: node types, edge types, property and confidence semantics.
- `/.well-known/agent` — agent descriptor: protocol, version, capabilities, bootstrap.
- `/connect` — onboarding packet: system prompt and the routes a new agent needs.
- `/toc` — full node listing for the visible public knowledge graph.
- `/.well-known/oauth-authorization-server` — OAuth authorization-server metadata.
- `/.well-known/oauth-protected-resource` — the protected resource and its scopes.

## OAuth model

The local node is the authorization server. The protected resource is `verityone.app/mcp`. Authorization uses the authorization-code grant with S256 PKCE. Two scopes are defined:

- `vo.read` — read the synced mirror.
- `vo.write.intent` — queue a write intent (not a live write).

## MUST NOT

An agent (and anything describing Verity One) MUST NOT claim or imply:

1. **Zero-knowledge or end-to-end encryption** for the hosted mirror. The default is `service_managed` — encrypted at rest with a per-tenant key, but keys are server-managed and the service decrypts server-side while syncing. `content_opaque` exists only as an opt-in advanced mode, never the default.
2. **A packaged, signed, or notarized binary, or a Homebrew/npm install.** Install is source-only: the one-line script clones the repo at the pinned stable commit and builds a local node.
3. **Any `vo …` command before the source build completes.** The real connect verb is `vo mcp install --client claude-desktop|codex|generic`. There is no `vo onboard claude-code …` — `vo onboard` is the LLM-provider wizard and takes no agent positional.
4. **"Audit from anywhere" or the hosted portal as turnkey-live.** `/my` requires Google OAuth configured, `vo account link`, and `vo sync push` — all optional, later-phase steps. An unsynced mirror renders empty states.
5. **The local node serving a web/HTTP MCP endpoint.** `POST localhost:3100/mcp` returns 404 by design. The HTTP MCP connector is only at `https://verityone.app/mcp`.
6. **Two-way or bidirectional sync.** Sync is outbound-only: the local node pushes memory to the hosted mirror on demand. There is no inbound graph leg.
7. **A "verified" or "validated" memory badge, or source references as validated citations.** Verity One records whether a reference was provided (linked / missing / optional); it does not fetch or verify the source. `verified_at` is auto-stamped at write (equal to `created_at`), not a re-verification signal.
