# Connect Verity One — beta tester journey

This is the four-step path a new tenant follows to go from zero to a fully synced VO + VO+ + phone-agent stack.

```
  1. Local up           — scripts/bootstrap-local.sh
       └── working VO on your Mac (Postgres + API + tenant token)
  2. Ingest your stuff  — docs/INGEST-FOR-AGENTS.md
       └── your MD files + journals become VO nodes
  3. Sync to VO+        — manual dashboard pairing (VO+ manual beta)
       └── pair via the dashboard, then deltas push to verityone.app
  4. Phone agent        — add https://verityone.app/mcp connector (no trailing slash)
       └── your mobile agent reads your VO from anywhere
```

Pick up each step's doc below.

---

## Step 1 — local up

One Mac, one command. The signed installer fetches the stable manifest, **verifies
its Ed25519 signature**, then clones the pinned commit (from the manifest's
`install.repo_url` + `source_ref`) and runs the local bootstrap:

```bash
curl -fsSL https://verityone.app/install.sh | bash
```

It installs Postgres + pgvector + bun via Homebrew (only if missing), creates the
`verity` database, runs all migrations, registers your tenant row, and writes `.env`
+ `~/.vo/config.json` with fresh tokens (default install dir `~/verity-one`). It is
idempotent and does **not** start the API — that's the last command it prints.

<details>
<summary>Advanced: manual clone (skips signature verification — you vouch for the ref)</summary>

The signed installer is preferred. The manual path below clones directly with **no
manifest signature check**, so only use it if you are pinning a ref you trust yourself:

```bash
git clone https://github.com/markprobinson3-maker/VerityOne.git ~/verity-one
cd ~/verity-one
./scripts/bootstrap-local.sh
```
</details>

After it finishes, start the API:

```bash
cd ~/verity-one
nohup bun run api/src/index.ts > /tmp/vo-api.log 2>&1 &
curl -s http://localhost:3100/health    # should return {"ok":true,...}
```

---

## Step 2 — ingest your existing content

Hand `docs/INGEST-FOR-AGENTS.md` to your coding agent (Claude Code, Codex, Cursor, etc.) and tell it which directory to walk. The agent classifies each Markdown file as a **project memory** or **day memory**, atomizes it into individual thoughts, and writes them to your local VO via `/remember`.

The same agent-driven path scales to whole codebases + docs trees: point the
agent at the repo root and let it walk the tree, writing through `/remember` and
(for memories that carry source provenance or project scope) `/memory/write`.

> A one-command `vo ingest --repo …` exists in the full operator `vo` CLI, which
> is **not** part of the OSS source install — use the agent-driven path above.

---

## Step 3 — sync to VO+ (web)

After your local VO has real content, opt into hosted sync. This is a **three-part handshake**, not a single command — the local node has to be paired with your hosted account on `verityone.app` before sync can flow.

### 3a — Provision your hosted account + tenant

1. Visit `https://verityone.app` and sign in with Google.
2. Complete the onboarding form (picks your tenant id; this should match the `VO_TENANT_ID` you used in bootstrap-local.sh if you want them to align).
3. Visit `https://verityone.app/my/setup`. The "Readiness" card should show **signed-in ✓**, **tenant-provisioned ✓**, and **sync-token-claimed: Not claimed**.

### 3b — Pair your local node with the hosted side

Today this step is **manual and not yet wrapped by the `vo` CLI** — D8 in the bootstrap audit. Run `vo sync claim-token` *before* the node is paired and you get `node_not_found` because the hosted `hosted_nodes` table has no entry for your local node id. The pairing is the `/account/connect/redeem` endpoint; until a `vo sync pair` command exists, paste from the dashboard UI flow.

The minimum-viable manual path while we ship `vo sync pair`:

1. Look up your local node id: `cat ~/.vo/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("node_id"))'`
2. On `https://verityone.app/my/sync`, follow the "Connect this device" flow. It will generate a connect grant and walk you through pasting the public key + a code into the local node.
3. After the redeem succeeds, the dashboard "sync-token-claimed" gate flips green.

### 3c — Enable outbound sync + restart

```bash
# edit ~/.vo/config.json and set "hosted_sync": "outbound"
nohup bun run api/src/index.ts > /tmp/vo-api.log 2>&1 &
```

The in-process scheduler pushes a delta to `https://verityone.app` every 60 seconds. Bootstrap (the initial full export) runs once on first activation. Check status:

```bash
cat ~/.vo/sync-state.json | python3 -m json.tool | head -10
# or:
vo sync status
```

If `sync_token` is `MISSING` and `Sync configured: no`, you have not completed step 3b yet — that's the most common cause of `claim-token` failing.

---

## Step 4 — connect a phone (or any cloud) agent via web MCP

Any RFC-7591/8252-compliant MCP client (Claude.ai mobile, Codex web, Cursor, etc.) can add VO as a custom connector:

- **URL:** `https://verityone.app/mcp` (no trailing slash)
- **Auth:** OAuth (the client handles DCR + PKCE)
- **Scope:** `vo.read` (read-only) or `vo.read vo.write.intent` (queue-only writes)

A browser window opens for OAuth approval. After consent, the client sees the 9 read/status/review tools, including read-only command polling with `vo_commands_get` (plus public queue-lifecycle write tools `vo_write_intent` and `vo_commands_cancel` with the `vo.write.intent` scope). Confirm: *"Use the vo_status tool."*

If your client uses a non-standard OAuth callback URL, `https://...` callbacks are accepted for web clients. Loopback callbacks (`http://localhost:<any-port>/...`, `http://127.0.0.1:<any-port>/...`, or `http://[::1]:<any-port>/...`) are accepted only when the dynamic registration declares `application_type: "native"`.

---

## Alternative — local stdio MCP (no cloud trip)

If you'd rather connect a desktop MCP client straight to your local VO with full read+write (skipping the queue-only intent gate):

```bash
bun install --cwd mcp && bun run --cwd mcp build   # one-time build
vo-mcp install --client claude-desktop             # or: codex / generic
```

That installs the stdio MCP server config for the client (build it once first, as shown). Restart the client. To check health later: `vo-mcp doctor`.

---

## Verifying the whole stack

Same test from any connected agent:

> Using Verity One, list the 5 most recent nodes.

Working = real node data comes back. Broken = "I don't have access" or an MCP error.

---

## Pointers

- Local bootstrap details + recovery: `scripts/bootstrap-local.sh` (read the header comment)
- Ingestion playbook (paste into your agent): `docs/INGEST-FOR-AGENTS.md`
- Web MCP architecture, OAuth scopes, write-intent guarantees: `docs/VO-PLUS-CLAUDE-CONNECTOR-FIRST-USE.md`, `docs/VO-MCP-HOSTED-REMOTE-WEB-FOLLOWUP.md`
- Local stdio architecture, dashboard install controls, doctor flow: `docs/VO-MCP-ACTIVATION.md`, `docs/VO-MCP-LOCAL-FIRST-ARCHITECTURE.md`
- Agent-facing usage brief (tool decision tree, citation rules): `docs/VO-MCP-AGENT-USAGE.md`

---

## Reference — two-path summary

If you skipped the journey above and just want the MCP connector matrix:

| | **Web MCP** | **Local stdio MCP** |
|---|---|---|
| Where it runs | `https://verityone.app/mcp` (no trailing slash) | Your machine, `127.0.0.1:3100` |
| Setup on user's side | None — just OAuth in the browser | One CLI command |
| Capabilities | Read/status/review tools + queue-lifecycle intent/cancel with OAuth write grant | Full read + full write |
| Works for | Any RFC-7591/8252-compliant MCP client (Claude.ai, Codex, etc.) | Any stdio MCP client (Claude Desktop, Codex desktop, generic) |
| Best for | Adding VO to a hosted/cloud agent session | Direct local use with your own VO instance |

---

## Path A — Web MCP (zero-install)

1. In your MCP client (Claude.ai, Codex web, etc.), add a custom MCP connector:
   - **URL:** `https://verityone.app/mcp` (no trailing slash)
   - **Auth:** OAuth (the client handles this — Dynamic Client Registration + PKCE)
   - **Scope:** `vo.read` (or `vo.read vo.write.intent` if you want queue-only write/cancel tools)
2. A browser window opens. Sign in with the Google account linked to your VO+ tenant.
3. Approve the consent screen. Done.

Your client now sees the read/status/review tools, including read-only command polling with `vo_commands_get`. If you requested the `vo.write.intent` scope, it also sees public queue-only write intent and queued-command cancel tools (`vo_write_intent` and `vo_commands_cancel`). Confirm by asking it: *"Use the vo_status tool."*

If the client uses a non-standard OAuth callback URL, registration may fail with `invalid_redirect_uri`. `https://...` callbacks are accepted for web clients; loopback callbacks are accepted only for native-client registrations (`application_type: "native"`).

---

## Path B — Local stdio MCP (one command)

Requires you to have a local VO node running (`api/src/index.ts` on `127.0.0.1:3100`).

```bash
bun install --cwd mcp && bun run --cwd mcp build   # one-time build
vo-mcp install --client claude-desktop             # or: codex / generic
```

Build the MCP package once (first line), then `vo-mcp install` wires the stdio MCP server config for your chosen client. Restart the client and you're done.

To check setup health later: `vo-mcp doctor`. To re-run install: same command with `--force`.

---

## Verifying it worked

Same test for both paths — ask your agent:

> Using Verity One, list the 5 most recent nodes.

A working connection returns real node data. A broken one returns "I don't have access to that tool" or an MCP error.

---

## Pointers

- Web MCP architecture, OAuth scopes, write-intent guarantees: `docs/VO-PLUS-CLAUDE-CONNECTOR-FIRST-USE.md`, `docs/VO-MCP-HOSTED-REMOTE-WEB-FOLLOWUP.md`
- Local stdio architecture, dashboard install controls, doctor flow: `docs/VO-MCP-ACTIVATION.md`, `docs/VO-MCP-LOCAL-FIRST-ARCHITECTURE.md`
- Agent-facing usage brief (tool decision tree, citation rules): `docs/VO-MCP-AGENT-USAGE.md`
