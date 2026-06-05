#!/bin/sh
# https://verityone.app/install.sh
#
# Beta install path. Clones the repo and runs the local bootstrap.
#
# What this does:
#   1. Verifies git + a writable install dir.
#   2. Clones https://github.com/markprobinson3-maker/VerityOne.git
#      to $VO_INSTALL_DIR (default ~/verity-one), or fast-forwards an
#      existing checkout.
#   3. Pins the checkout to the manifest's stable.source_ref so what
#      gets installed is exactly the published commit, not whatever
#      HEAD happens to be at clone time.
#   4. Execs scripts/bootstrap-local.sh, which installs Postgres,
#      runs migrations, registers the tenant, writes config files,
#      and prints the API start command.
#
# This is the SOURCE-INSTALL beta path. The original signed-binary
# install.sh under download-site/install.sh remains the design for
# the public stable channel once vo-cli tarballs are republished —
# kept there for reference until that path is re-enabled.
#
# Usage:
#   curl -fsSL https://verityone.app/install.sh | sh
#   curl -fsSL https://verityone.app/install.sh | sh -s -- --help
#
# Environment overrides:
#   VO_INSTALL_DIR   default: $HOME/verity-one
#   VO_MANIFEST_URL  default: https://verityone.app/releases/stable.json
#   VO_GIT_REF       override the manifest's source_ref (advanced)
#   VO_CHANNEL       'stable' (default) | 'nightly'

set -eu

REPO_URL="https://github.com/markprobinson3-maker/VerityOne.git"
INSTALL_DIR="${VO_INSTALL_DIR:-$HOME/verity-one}"
CHANNEL="${VO_CHANNEL:-stable}"
MANIFEST_URL="${VO_MANIFEST_URL:-https://verityone.app/releases/${CHANNEL}.json}"

say() { printf '%s\n' "$*"; }
err() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Verity One beta installer

Usage:
  curl -fsSL https://verityone.app/install.sh | sh
  curl -fsSL https://verityone.app/install.sh | sh -s -- --help

What it does:
  - Clones $REPO_URL to \$VO_INSTALL_DIR (default ~/verity-one).
  - Pins to the SHA recorded in \$VO_MANIFEST_URL (default the
    'stable' channel manifest at $MANIFEST_URL).
  - Execs scripts/bootstrap-local.sh, which installs Postgres,
    runs migrations, registers the tenant, and writes config.

Environment overrides:
  VO_INSTALL_DIR    where to clone (default: \$HOME/verity-one)
  VO_MANIFEST_URL   manifest to read source_ref from
                    (default: $MANIFEST_URL)
  VO_GIT_REF        skip manifest fetch and pin to this ref directly
  VO_CHANNEL        'stable' (default) or 'nightly'

For the bleeding-edge tip of main:
  VO_GIT_REF=main curl -fsSL https://verityone.app/install.sh | sh
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

# Prereqs
command -v git  >/dev/null 2>&1 || err "git is required first (try: brew install git)"
command -v curl >/dev/null 2>&1 || err "curl is required"

# Resolve target SHA / ref
if [ -n "${VO_GIT_REF:-}" ]; then
  TARGET_REF="$VO_GIT_REF"
  say "Pinning to VO_GIT_REF override: $TARGET_REF"
else
  say "Fetching manifest: $MANIFEST_URL"
  MANIFEST_JSON=$(curl -fsSL "$MANIFEST_URL") || err "could not fetch $MANIFEST_URL"
  # Tiny JSON pick — no jq dependency. Pulls install.source_ref.
  TARGET_REF=$(printf '%s' "$MANIFEST_JSON" \
    | tr -d '\n' \
    | sed -n 's/.*"install"[[:space:]]*:[[:space:]]*{[^}]*"source_ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$TARGET_REF" ] || err "manifest did not contain install.source_ref"
  say "Manifest source_ref: $TARGET_REF"
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin --tags --quiet
  git -C "$INSTALL_DIR" checkout --quiet "$TARGET_REF"
else
  say "Cloning $REPO_URL to $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" checkout --quiet "$TARGET_REF"
fi

# Hand off to the local bootstrap
BOOTSTRAP="$INSTALL_DIR/scripts/bootstrap-local.sh"
[ -x "$BOOTSTRAP" ] || err "bootstrap-local.sh missing or not executable at $BOOTSTRAP"

say ""
say "Running $BOOTSTRAP"
say "  (installs Postgres + pgvector + bun via Homebrew, runs migrations,"
say "   writes .env.local + ~/.vo/config.json with fresh tokens)"
say ""
exec "$BOOTSTRAP"
