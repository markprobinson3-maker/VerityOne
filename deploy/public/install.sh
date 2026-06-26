#!/bin/sh
# https://verityone.app/install.sh
#
# Beta install path. Clones the repo and runs the local bootstrap.
#
# What this does:
#   1. Verifies git + a writable install dir.
#   2. Fetches the stable manifest AND its detached Ed25519 signature, and
#      VERIFIES the signature against the pinned release trust root BEFORE
#      trusting anything in the manifest. Fails closed on a bad/missing
#      signature or an untrusted key id.
#   3. Clones https://github.com/markprobinson3-maker/VerityOne.git
#      to $VO_INSTALL_DIR (default ~/verity-one), or fast-forwards an
#      existing checkout.
#   4. Pins the checkout to the (signature-verified) manifest's
#      install.source_ref so what gets installed is exactly the published
#      commit, not whatever HEAD happens to be at clone time.
#   5. Execs scripts/bootstrap-local.sh, which installs Postgres,
#      runs migrations, registers the tenant, writes config files,
#      and prints the API start command.
#
# This is the SOURCE-INSTALL beta path. (A signed-binary packaged channel is a
# future addition; it is not live yet.)
#
# Usage:
#   curl -fsSL https://verityone.app/install.sh | bash
#   curl -fsSL https://verityone.app/install.sh | bash -s -- --help
#
# Environment overrides:
#   VO_INSTALL_DIR    default: $HOME/verity-one
#   VO_MANIFEST_URL   default: https://verityone.app/releases/stable.json
#                     (its detached signature is fetched from <url>.sig)
#   VO_GIT_REF        pin to this ref directly, skipping the manifest entirely
#                     (advanced: you are vouching for the ref yourself)
#   VO_CHANNEL        'stable' (default) | 'nightly'
#   VO_SKIP_BOOTSTRAP '1' = fetch/verify/clone/checkout, then stop before the
#                     heavy local bootstrap (used by CI smoke; not a user path)

set -eu

REPO_URL="https://github.com/markprobinson3-maker/VerityOne.git"
INSTALL_DIR="${VO_INSTALL_DIR:-$HOME/verity-one}"
CHANNEL="${VO_CHANNEL:-stable}"
MANIFEST_URL="${VO_MANIFEST_URL:-https://verityone.app/releases/${CHANNEL}.json}"

# Release manifest trust root (Ed25519). The detached signature over the manifest
# MUST verify against this key before we trust install.source_ref. Mirrors
# CURRENT_RELEASE_SIGNING_KEY_ID + its public_key_hex in
# desktop/src/manifest-trust-roots.ts — drift-guarded by
# deploy/scripts/release/installer-signature-guard.test.ts.
VO_TRUSTED_KEY_ID="vo-release-ed25519-2026-06-A"
# Ed25519 SubjectPublicKeyInfo (DER prefix 302a300506032b6570032100 + the 32-byte
# raw public key), base64-encoded:
VO_TRUSTED_PUBKEY_SPKI_B64="MCowBQYDK2VwAyEA85NzaSBZDJwvwzLH1J/vJoPyyzO6exg/h3h8fmMlzLg="

say() { printf '%s\n' "$*"; }
err() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Verity One beta installer

Usage:
  curl -fsSL https://verityone.app/install.sh | bash
  curl -fsSL https://verityone.app/install.sh | bash -s -- --help

What it does:
  - Fetches the stable manifest + its detached Ed25519 signature and verifies
    the signature against the pinned release key before trusting it.
  - Clones $REPO_URL to \$VO_INSTALL_DIR (default ~/verity-one).
  - Pins to the verified manifest's source_ref.
  - Execs scripts/bootstrap-local.sh, which installs Postgres, runs
    migrations, registers the tenant, and writes config.

Environment overrides:
  VO_INSTALL_DIR    where to clone (default: \$HOME/verity-one)
  VO_MANIFEST_URL   manifest to read source_ref from (default: $MANIFEST_URL);
                    its signature is fetched from <url>.sig
  VO_GIT_REF        skip the manifest and pin to this ref directly (advanced)
  VO_CHANNEL        'stable' (default) or 'nightly'
  VO_SKIP_BOOTSTRAP '1' = clone+checkout then stop (CI smoke; skips bootstrap)

For the bleeding-edge tip of main:
  VO_GIT_REF=main curl -fsSL https://verityone.app/install.sh | bash
EOF
}

# Find an OpenSSL 3.x — needed for Ed25519 `pkeyutl -rawin`. macOS's system
# openssl is LibreSSL and may lack it, so prefer a Homebrew openssl@3 when the
# default on PATH is not a capable OpenSSL 3.x build.
find_openssl() {
  for c in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl; do
    if command -v "$c" >/dev/null 2>&1 && "$c" version 2>/dev/null | grep -q '^OpenSSL 3'; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# json_str_pick KEY < file — tiny no-jq extractor for a flat "KEY":"value".
json_str_pick() { tr -d '\n' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"; }

# verify_manifest_sig MANIFEST_FILE SIG_FILE — fail closed unless the detached
# Ed25519 signature verifies against the trusted release key over the EXACT
# manifest bytes.
verify_manifest_sig() {
  _mf="$1"
  _sf="$2"
  _ossl=$(find_openssl) || err "manifest signature verification needs OpenSSL 3.x (Ed25519). Install it (e.g. 'brew install openssl@3') and retry, or pin a ref you trust directly with VO_GIT_REF=<sha>."
  _keyid=$(json_str_pick key_id < "$_sf")
  [ "$_keyid" = "$VO_TRUSTED_KEY_ID" ] || err "manifest signature key_id '${_keyid:-<none>}' is not the trusted release key '$VO_TRUSTED_KEY_ID' — refusing to install (tampering or a retired key)."
  _sigb64=$(json_str_pick signature < "$_sf")
  [ -n "$_sigb64" ] || err "manifest signature is missing — refusing to install."
  _vtmp=$(mktemp -d) || err "could not create a temp dir for signature verification"
  {
    printf '%s\n' "-----BEGIN PUBLIC KEY-----"
    printf '%s\n' "$VO_TRUSTED_PUBKEY_SPKI_B64"
    printf '%s\n' "-----END PUBLIC KEY-----"
  } > "$_vtmp/pub.pem"
  # -A: treat the signature as a single base64 line (no PEM line-wrapping).
  printf '%s' "$_sigb64" | "$_ossl" base64 -d -A > "$_vtmp/sig.bin" 2>/dev/null || { rm -rf "$_vtmp"; err "manifest signature is not valid base64 — refusing to install."; }
  [ -s "$_vtmp/sig.bin" ] || { rm -rf "$_vtmp"; err "manifest signature decoded to empty bytes — refusing to install."; }
  if "$_ossl" pkeyutl -verify -pubin -inkey "$_vtmp/pub.pem" -rawin -in "$_mf" -sigfile "$_vtmp/sig.bin" >/dev/null 2>&1; then
    rm -rf "$_vtmp"
    say "Manifest signature verified ($VO_TRUSTED_KEY_ID)."
  else
    rm -rf "$_vtmp"
    err "manifest signature verification FAILED — the manifest may be tampered or served by an impostor. Refusing to install."
  fi
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

# Platform guard — fail EARLY and honestly. bootstrap-local.sh is macOS-only
# today (Homebrew-driven Postgres/bun install); without this check a Linux or
# WSL user clones successfully and then dies deep inside bootstrap with an
# unrelated-looking error. VO_FORCE_PLATFORM=1 skips the guard for people
# intentionally doing a manual setup on another OS. VO_SKIP_BOOTSTRAP=1 also
# skips it: that path only fetches/verifies/clones/checks-out and stops BEFORE
# bootstrap, which is platform-agnostic — and it is exactly the CI smoke path
# (the guard otherwise dark-failed public-install-smoke on Linux since #314).
if [ "$(uname -s)" != "Darwin" ] && [ "${VO_FORCE_PLATFORM:-}" != "1" ] && [ "${VO_SKIP_BOOTSTRAP:-}" != "1" ]; then
  err "Verity One's automated installer supports macOS only today (Linux/Windows: manual setup — see https://verityone.app/start). Set VO_FORCE_PLATFORM=1 to continue anyway at your own risk."
fi

# Prereqs
command -v git  >/dev/null 2>&1 || err "git is required first (try: brew install git)"
command -v curl >/dev/null 2>&1 || err "curl is required"

# Resolve target SHA / ref
if [ -n "${VO_GIT_REF:-}" ]; then
  TARGET_REF="$VO_GIT_REF"
  say "Pinning to VO_GIT_REF override: $TARGET_REF (explicit ref — manifest signature not checked)"
else
  say "Fetching manifest: $MANIFEST_URL"
  MTMP=$(mktemp -d) || err "could not create a temp dir"
  curl -fsSL "$MANIFEST_URL" -o "$MTMP/manifest.json" || { rm -rf "$MTMP"; err "could not fetch $MANIFEST_URL"; }
  curl -fsSL "${MANIFEST_URL}.sig" -o "$MTMP/manifest.json.sig" || { rm -rf "$MTMP"; err "could not fetch ${MANIFEST_URL}.sig — refusing to install from an unsigned manifest."; }
  # Verify the signature BEFORE reading anything we act on.
  verify_manifest_sig "$MTMP/manifest.json" "$MTMP/manifest.json.sig"
  # Now it is safe to pull install.source_ref + install.repo_url (no-jq nested
  # picks). The signed manifest's repo_url is the AUTHORITATIVE clone target: a
  # repo move re-signs the manifest with the new repo_url, and real installs must
  # follow it instead of cloning the hardcoded fallback forever (otherwise a move
  # keeps CI + manifest-integrity green while every `curl | bash` clones the old URL).
  TARGET_REF=$(tr -d '\n' < "$MTMP/manifest.json" \
    | sed -n 's/.*"install"[[:space:]]*:[[:space:]]*{[^}]*"source_ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  MANIFEST_REPO_URL=$(tr -d '\n' < "$MTMP/manifest.json" \
    | sed -n 's/.*"install"[[:space:]]*:[[:space:]]*{[^}]*"repo_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  rm -rf "$MTMP"
  [ -n "$TARGET_REF" ] || err "manifest did not contain install.source_ref"
  # Honor the manifest's repo_url, but FAIL CLOSED to a github.com/<owner>/<repo>
  # allowlist: even a validly-signed manifest must not be able to redirect the
  # clone to a non-GitHub host (defends against a fat-fingered or key-compromise
  # manifest). If VO ever moves off github.com, widen this allowlist in lockstep.
  # An ABSENT repo_url falls back to the embedded REPO_URL (back-compat with
  # older manifests that predate the field).
  if [ -n "$MANIFEST_REPO_URL" ]; then
    printf '%s' "$MANIFEST_REPO_URL" \
      | grep -Eq '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' \
      || err "manifest install.repo_url '$MANIFEST_REPO_URL' is not an allowed https://github.com/<owner>/<repo> URL — refusing to install (possible tampering or misconfiguration)."
    REPO_URL="$MANIFEST_REPO_URL"
    say "Manifest repo_url: $REPO_URL (signature-verified, allowlisted)"
  fi
  say "Manifest source_ref: $TARGET_REF (signature-verified)"
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  # A moved repo (manifest repo_url changed) must re-point an existing clone before
  # fetching, or the fetch below would silently pull from the stale origin and the
  # checkout would resolve against the OLD repo's refs. Reconcile origin to the
  # resolved REPO_URL first.
  CUR_ORIGIN=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || printf '')
  if [ "$CUR_ORIGIN" != "$REPO_URL" ]; then
    say "Re-pointing origin: ${CUR_ORIGIN:-<none>} -> $REPO_URL"
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" 2>/dev/null \
      || git -C "$INSTALL_DIR" remote add origin "$REPO_URL"
  fi
  git -C "$INSTALL_DIR" fetch origin --tags --quiet \
    || err "could not fetch from $REPO_URL (network or auth issue) — check your connection and re-run."
  # Resolve the ref to a concrete commit and detach onto it (batch-32 VO-INST-3/4):
  # a re-run with VO_GIT_REF=main on an EXISTING checkout would otherwise
  # `checkout main` and keep the STALE local branch tip, silently installing old
  # code. Peel to ^{commit} (branch/tag/SHA); --verify --quiet avoids the
  # rev-parse-echoes-the-literal-ref footgun on a miss.
  if RESOLVED=$(git -C "$INSTALL_DIR" rev-parse --verify --quiet "origin/$TARGET_REF^{commit}"); then :;
  else RESOLVED=$(git -C "$INSTALL_DIR" rev-parse --verify --quiet "$TARGET_REF^{commit}" || printf ''); fi
  [ -n "$RESOLVED" ] || err "could not resolve ref '$TARGET_REF' in $INSTALL_DIR — check VO_GIT_REF, or re-clone into a fresh VO_INSTALL_DIR."
  git -C "$INSTALL_DIR" checkout --quiet --detach "$RESOLVED" \
    || err "could not check out $TARGET_REF in $INSTALL_DIR (local edits or divergent history?). Stash/discard changes (git -C \"$INSTALL_DIR\" stash) or re-clone into a fresh VO_INSTALL_DIR, then re-run."
else
  say "Cloning $REPO_URL to $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR" \
    || err "could not clone $REPO_URL into $INSTALL_DIR — check your connection / the repo URL and re-run."
  git -C "$INSTALL_DIR" checkout --quiet "$TARGET_REF" \
    || err "could not check out $TARGET_REF after clone — check VO_GIT_REF."
fi

# Hand off to the local bootstrap
BOOTSTRAP="$INSTALL_DIR/scripts/bootstrap-local.sh"
[ -x "$BOOTSTRAP" ] || err "bootstrap-local.sh missing or not executable at $BOOTSTRAP"

# CI / smoke escape hatch: prove fetch+verify+clone+checkout WITHOUT running the
# heavy local bootstrap (Homebrew, Postgres, migrations). Not a user path. Kept
# AFTER the bootstrap-existence check so the smoke still covers that guard.
if [ "${VO_SKIP_BOOTSTRAP:-}" = "1" ]; then
  say "VO_SKIP_BOOTSTRAP=1 — clone/checkout complete at $(git -C "$INSTALL_DIR" rev-parse HEAD); skipping $BOOTSTRAP"
  exit 0
fi

say ""
say "Running $BOOTSTRAP"
say "  (installs Postgres + pgvector + bun via Homebrew, runs migrations,"
say "   writes .env + ~/.vo/config.json with fresh tokens)"
say ""
exec "$BOOTSTRAP"
