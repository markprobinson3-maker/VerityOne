#!/usr/bin/env bash
# scripts/bootstrap-local.sh — turn a fresh Mac into a working local
# Verity One instance.
#
# Idempotent. Each step checks before doing; safe to re-run after a
# partial failure or after pulling new migrations.
#
# What this does:
#
#   1. Verifies Homebrew is present.
#   2. Installs `bun`, `postgresql@17`, and `pgvector` (only if missing).
#   3. Starts `postgresql@17` as a brew service.
#   4. Creates the `verity` database + `vector` extension.
#   5. Runs `scripts/run-migrations.ts` (idempotent migrations runner).
#   6. Inserts a tenant row in the `tenants` table.
#   7. Writes `.env` at the repo root with the operator + agent
#      token bindings the API reads on startup.
#   8. Writes `~/.vo/config.json` so the `vo` CLI knows how to reach
#      the local API as that tenant.
#
# What this does NOT do:
#
#   - Does not start the API server. The last step prints the exact
#     command to start it. Service management is your call.
#   - Does not install LLM provider keys. Run `vo onboard` after this
#     if you want LLM-assisted ingestion.
#   - Does not configure VO+ hosted sync. Set that up later via the
#     three-part handshake (sign in at verityone.app, pair THIS node via
#     /my/sync, then enable sync) — see step 5 in the notes this script
#     prints when it finishes. `vo sync claim-token` fails with
#     `node_not_found` until the pairing step is done, so it is not the
#     first command to run.
#
# Mac-only today (uses Homebrew + brew services).
#
# Overrideable via env:
#
#   VO_TENANT_ID         default: $(whoami)
#   VO_TENANT_TOKEN      default: vo-beta-<random>
#   VO_OPERATOR_TOKEN    default: vo-op-<random>
#   VO_AGENT_ID          default: ${VO_TENANT_ID}-agent
#   VO_PG_PREFIX         default: /opt/homebrew/opt/postgresql@17/bin
#   VO_REPO_DIR          default: repo root (derived from this script's location)
#   VO_DB_NAME           default: verity (override for parallel installs)
#   VO_ENV_FILE          default: $VO_REPO_DIR/.env
#   VO_VO_DIR            default: $HOME/.vo (override for parallel installs)

set -euo pipefail

REPO_DIR="${VO_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
TENANT_ID="${VO_TENANT_ID:-$(whoami)}"
AGENT_ID="${VO_AGENT_ID:-${TENANT_ID}-agent}"
DB_NAME="${VO_DB_NAME:-verity}"
PG_PREFIX="${VO_PG_PREFIX:-/opt/homebrew/opt/postgresql@17/bin}"
ENV_FILE="${VO_ENV_FILE:-$REPO_DIR/.env}"
VO_DIR="${VO_VO_DIR:-$HOME/.vo}"

step() { printf "\n==> %s\n" "$*"; }
ok()   { printf "    ✓ %s\n" "$*"; }
warn() { printf "    ! %s\n" "$*" >&2; }
err()  { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

# 1. macOS-only
[ "$(uname -s)" = "Darwin" ] || err "bootstrap-local.sh supports macOS only today. (Linux + Windows pending.)"

# 2. Homebrew
command -v brew >/dev/null || err "Homebrew is required first. Install from https://brew.sh"
ok "brew $(brew --version | head -1 | awk '{print $2}')"

# 3. bun
if ! command -v bun >/dev/null; then
  step "Installing bun via Homebrew"
  brew install oven-sh/bun/bun
fi
ok "bun $(bun --version)"

# 4. postgresql@17 + pgvector
if [ ! -x "$PG_PREFIX/psql" ]; then
  step "Installing postgresql@17 + pgvector via Homebrew"
  brew install postgresql@17 pgvector
fi
export PATH="$PG_PREFIX:$PATH"
ok "$(psql --version)"

# 5. Start postgres
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  step "Starting postgresql@17"
  brew services start postgresql@17
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
    sleep 1
  done
fi
pg_isready -h localhost -p 5432 >/dev/null 2>&1 || err "postgres did not become ready on :5432"
ok "postgres listening on localhost:5432"

# 6. Create DB
if ! psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  step "Creating database '$DB_NAME'"
  createdb "$DB_NAME"
fi
ok "database '$DB_NAME' present"

# 7. pgvector extension
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
ok "pgvector extension installed"

# 8. JS deps
step "Installing JS dependencies (bun install)"
cd "$REPO_DIR"
bun install --silent
ok "dependencies installed"

# 9. Database schema.
#    Full source tree (private): the migration manifest is present → run the
#    idempotent migration runner. Source/OSS distribution (public repo): the
#    manifest is not shipped (it references private tenant seeds), so apply the
#    consolidated db/schema.sql via `db:setup`. Auto-detect so ONE bootstrap
#    works in both trees.
if [ -f "$REPO_DIR/db/migration-manifest.json" ]; then
  step "Running migrations"
  DATABASE_URL="postgresql://localhost:5432/$DB_NAME" \
    bun run scripts/run-migrations.ts || err "migrations failed — see output above"
  ok "migrations applied"
else
  step "Applying consolidated schema (db/schema.sql)"
  DATABASE_URL="postgresql://localhost:5432/$DB_NAME" \
    bun run db:setup || err "db:setup failed — see output above"
  ok "consolidated schema applied"
fi

# 10. Tenant row + graph_spaces overlay
step "Registering tenant '$TENANT_ID'"
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO tenants (tenant_id, label)
VALUES ('$TENANT_ID', '$TENANT_ID')
ON CONFLICT (tenant_id) DO UPDATE SET label = EXCLUDED.label;

-- Every node write under this tenant uses space_id = 'tenant:<id>' and
-- nodes.space_id has a FK to graph_spaces.space_id. Without this row,
-- the first /remember or /memory/write returns a 500.
INSERT INTO graph_spaces (
  space_id, tenant_id, kind, label, description,
  overlay_parent_space_id, storage_backend, network_scope,
  sync_mode, metadata
)
VALUES (
  'tenant:$TENANT_ID', '$TENANT_ID', 'tenant',
  'Tenant $TENANT_ID overlay',
  'Private tenant overlay for $TENANT_ID — local bootstrap.',
  'global', 'server', 'wan', 'eager',
  '{"role": "private-overlay"}'::jsonb
)
ON CONFLICT (space_id) DO NOTHING;
SQL
ok "tenant row + graph_spaces overlay present"

# 11. Tokens + .env file
if [ -f "$ENV_FILE" ] && grep -q '^VERITY_AGENT_TOKENS=' "$ENV_FILE" 2>/dev/null; then
  step "$ENV_FILE already has VERITY_AGENT_TOKENS — leaving it untouched"
  warn "If a fresh tenant token is needed, delete the file and re-run."
  # Read tokens back from the existing env file for the summary + config heal.
  # The value is `agentId:token` (colon-separated; api/src/lib/access.ts maps the
  # substring AFTER the last colon to the agentId on its left). The MCP bearer is
  # that TOKEN alone — NOT the whole `agentId:token` pair. The earlier reader split
  # on '=' (never present) and captured the full pair, so a rerun wrote
  # `agentId:token` as the bearer and every request 401'd. Parse with the colon.
  EXISTING_PAIR=$(grep -m1 '^VERITY_AGENT_TOKENS=' "$ENV_FILE")
  EXISTING_PAIR=${EXISTING_PAIR#VERITY_AGENT_TOKENS=}   # agentId:token[,more]
  EXISTING_PAIR=${EXISTING_PAIR%%,*}                     # first agent's pair only
  TENANT_TOKEN=${EXISTING_PAIR##*:}                      # bearer = after last colon
  case "$EXISTING_PAIR" in *:*) AGENT_ID=${EXISTING_PAIR%:*} ;; esac  # recover agentId
  EXISTING_OP_TOKEN=$(awk -F'=' '/^VERITY_OPERATOR_TOKENS=/ {sub(/^VERITY_OPERATOR_TOKENS=/,""); print; exit}' "$ENV_FILE")
  OPERATOR_TOKEN="${EXISTING_OP_TOKEN:-unknown}"
else
  TENANT_TOKEN="${VO_TENANT_TOKEN:-vo-beta-$(openssl rand -hex 16)}"
  OPERATOR_TOKEN="${VO_OPERATOR_TOKEN:-vo-op-$(openssl rand -hex 16)}"
  step "Writing $ENV_FILE"
  # This file holds operator + agent bearer tokens. Create it owner-only (umask
  # 077 → mode 0600) so there is no world/group-readable window; .gitignore
  # prevents commit, NOT local read by other users on the machine.
  ( umask 077
    {
      echo "# Generated by scripts/bootstrap-local.sh — safe to edit. Holds secret tokens: keep mode 0600."
      echo "DATABASE_URL=postgresql://localhost:5432/$DB_NAME"
      echo "VERITY_OPERATOR_TOKENS=$OPERATOR_TOKEN"
      # api/src/lib/access.ts parses these as agentId:token / agentId:tenantId
      # (colon separator, agentId on the left). Earlier revisions wrote
      # token=agent which read back as zero parsed pairs and every
      # authenticated request returned 401.
      echo "VERITY_AGENT_TOKENS=$AGENT_ID:$TENANT_TOKEN"
      echo "VERITY_AGENT_TENANTS=$AGENT_ID:$TENANT_ID"
      echo "VERITY_INSTANCE_TENANT_ID=$TENANT_ID"
    } > "$ENV_FILE"
  )
  # Belt-and-suspenders in case the file pre-existed with looser permissions.
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok "$ENV_FILE written (mode 0600)"
fi

# 12. $VO_DIR/config.json + $VO_DIR/agent-token for the vo CLI + the stdio MCP server.
# config.json MUST carry agent_token AND base_url: the stdio MCP server
# (mcp/src/config.ts) reads ~/.vo/config.json#agent_token (or access_token, or
# VO_TOKEN) for its bearer, and #base_url for the node URL. Without agent_token a
# connected agent gets `no_token`; a custom URL under the wrong key is ignored.
# config.json holds a bearer token, so write it owner-only (umask 077 / chmod 600).
mkdir -p "$VO_DIR"
VO_CONFIG="$VO_DIR/config.json"
if [ ! -f "$VO_CONFIG" ]; then
  step "Writing $VO_CONFIG"
  ( umask 077
  cat > "$VO_CONFIG" <<EOF
{
  "version": 1,
  "tenant_id": "$TENANT_ID",
  "agent_id": "$AGENT_ID",
  "agent_token": "$TENANT_TOKEN",
  "base_url": "http://localhost:3100",
  "base": "http://localhost:3100",
  "hosted_sync": "off",
  "profile": "tenant-default"
}
EOF
  )
  chmod 600 "$VO_CONFIG" 2>/dev/null || true
  ok "$VO_CONFIG written (mode 0600, carries agent_token + base_url for stdio MCP)"
else
  # Self-heal: an existing config.json from an older installer may LACK
  # agent_token (→ MCP returns no_token) or base_url (→ MCP ignores a custom
  # base). Inject only the missing keys without disturbing the rest, then re-lock.
  # Uses bun (already installed above) for a safe JSON merge.
  step "$VO_CONFIG exists — ensuring it carries agent_token + base_url"
  if VO_HEAL_TOKEN="$TENANT_TOKEN" bun -e '
      const fs = require("fs"); const p = process.argv[1];
      let c; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch { console.log("unparseable"); process.exit(1); }
      if (c === null || typeof c !== "object") { console.log("unparseable"); process.exit(1); }
      let ch = false;
      if (!c.agent_token && process.env.VO_HEAL_TOKEN) { c.agent_token = process.env.VO_HEAL_TOKEN; ch = true; }
      const url = c.base_url || c.base || "http://localhost:3100";
      if (!c.base_url) { c.base_url = url; ch = true; }
      if (!c.base) { c.base = url; ch = true; }
      if (ch) fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
      console.log(ch ? "healed" : "complete");
    ' "$VO_CONFIG" >/dev/null 2>&1; then
    chmod 600 "$VO_CONFIG" 2>/dev/null || true
    ok "$VO_CONFIG checked (agent_token + base_url present, mode 0600)"
  else
    warn "could not parse/patch $VO_CONFIG — confirm it has \"agent_token\" and \"base_url\""
  fi
fi
if [ ! -f "$VO_DIR/agent-token" ]; then
  printf '%s' "$TENANT_TOKEN" > "$VO_DIR/agent-token"
  chmod 600 "$VO_DIR/agent-token"
  ok "$VO_DIR/agent-token written (mode 0600)"
fi

# 13. CLI shims at ~/.local/bin.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
VO_BIN_LINKED=""

# 13a. `vo-mcp` launcher — the stdio MCP server is the PUBLIC connect path every
# install gets (the command the website shows: `vo-mcp install --client codex`).
# mcp/bin/vo-mcp is a self-locating, symlink-safe launcher (it follows symlinks to
# find its own package root, then runs dist/cli.js), so symlinking it into PATH is
# safe and makes the advertised bare `vo-mcp ...` command resolve. It prints a
# "run build" hint until mcp/ is built — that build is a separate documented step
# (see /start), so the symlink is created now and starts working once mcp/ builds.
if [ -f "$REPO_DIR/mcp/bin/vo-mcp" ]; then
  VO_MCP_LINK="$BIN_DIR/vo-mcp"
  if [ -e "$VO_MCP_LINK" ] && [ ! -L "$VO_MCP_LINK" ]; then
    # A real (non-symlink) file already lives here — do NOT clobber a user's
    # unrelated `vo-mcp`. ln -sf would silently delete it.
    warn "$VO_MCP_LINK already exists and is not a symlink — leaving it. Remove it and re-run to let bootstrap link the vo-mcp launcher, or run mcp/bin/vo-mcp by full path."
  else
    # Safe to (re)create: nothing there, or it is already a symlink we manage.
    ln -sf "$REPO_DIR/mcp/bin/vo-mcp" "$VO_MCP_LINK"
    ok "vo-mcp launcher linked ($VO_MCP_LINK -> mcp/bin/vo-mcp; works after you build mcp/)"
    VO_BIN_LINKED="yes"
  fi
fi

# 13b. `vo` CLI shim. The full `vo` CLI lives in agent-lab/ which is NOT in the
# public source tree, so only shim `vo` when that file is actually present
# (private/full checkouts). This avoids a `vo` launcher that points at a file the
# public install does not have.
if [ -f "$REPO_DIR/agent-lab/scripts/vo-cli.ts" ]; then
  step "Installing vo CLI shim at $BIN_DIR/vo"
  cat > "$BIN_DIR/vo" <<EOF
#!/usr/bin/env bash
# Generated by scripts/bootstrap-local.sh — launches the repo-local Verity One CLI.
exec bun run "$REPO_DIR/agent-lab/scripts/vo-cli.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/vo"
  ok "vo shim written ($BIN_DIR/vo)"
  VO_BIN_LINKED="yes"
  VO_SHIM_NOTE="vo CLI:        $BIN_DIR/vo  ·  vo-mcp: $BIN_DIR/vo-mcp"
else
  ok "public source tree — no full 'vo' CLI (agent-lab is private). Connect agents with the stdio MCP server: build mcp/ then 'vo-mcp install --client <claude-desktop|codex|generic>'."
  VO_SHIM_NOTE="agent MCP:     build mcp/ then '$BIN_DIR/vo-mcp install --client codex' (no 'vo' CLI in public installs)"
fi
VO_ON_PATH=""
case ":$PATH:" in *":$BIN_DIR:"*) VO_ON_PATH="yes" ;; esac

# 14. Summary + next steps
cat <<EOF

============================================================
  Verity One local bootstrap complete.
============================================================

  tenant_id:     $TENANT_ID
  agent_id:      $AGENT_ID
  database:      postgresql://localhost:5432/$DB_NAME
  env file:      $ENV_FILE  (mode 0600 — holds secret tokens)
  cli config:    $VO_DIR/config.json  (mode 0600, carries agent_token)
  agent token:   $VO_DIR/agent-token  (mode 0600)
  $VO_SHIM_NOTE
EOF
if [ -n "${VO_BIN_LINKED:-}" ] && [ -z "$VO_ON_PATH" ]; then
  cat <<EOF
                 ^ $BIN_DIR is NOT on your PATH yet — add it so \`vo-mcp\` (and \`vo\`) resolve:
                     echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc && export PATH="\$HOME/.local/bin:\$PATH"
EOF
fi
cat <<EOF

Next steps:

  1. Start the API server:
       cd $REPO_DIR
       bun run api/src/index.ts                  # foreground

     Or in the background:
       nohup bun run api/src/index.ts > /tmp/vo-api.log 2>&1 &

  2. In a new shell, sanity-check:
       curl -s http://localhost:3100/health

  3. Verify your tenant token works (reads the token from its 0600 file so it
     is never printed to your terminal/scrollback):
       curl -s -H "Authorization: Bearer \$(cat $VO_DIR/agent-token)" \\
         "http://localhost:3100/context?q=hello&depth=deep" | head -40

  4. Ingest your first content — see docs/INGEST-FOR-AGENTS.md.

  5. Activate VO+ hosted sync (later, optional, THREE-PART handshake):
       a) Sign in at https://verityone.app and complete tenant onboarding
       b) Pair THIS local node with your hosted account via
          https://verityone.app/my/sync ("Connect this device" flow).
          Until this step lands, 'vo sync claim-token' will fail with
          'node_not_found' — the hosted side has no record of this
          local node yet. See docs/CONNECT.md Step 3 for details.
       c) Once paired:
            edit $VO_DIR/config.json and set "hosted_sync": "outbound"
            restart the API

============================================================
EOF
