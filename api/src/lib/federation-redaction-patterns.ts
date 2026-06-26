/**
 * Federation redaction patterns — shared, dependency-free secret/local-path
 * detection regexes.
 *
 * These are detection PATTERNS (not secrets) used in two places: the VO+ sync
 * secret-scanner (federation-secret-scanner.ts, which rejects sync items that
 * carry secrets before they reach the hosted mirror) and the local activity-
 * health redactor (federation-activity-health.ts). They were extracted here so
 * the public open-core node (which redacts activity output) does not have to
 * import the VO+ secret-scanner module. Keep this file dependency-free.
 *
 * Pattern descriptors. Each has a human-readable name (for error messages +
 * test assertions) and a regular expression that MUST uniquely identify the
 * secret shape.
 *
 * Ordering matters: longer / more-specific patterns come first so that a match
 * reports the most useful name (e.g. `sk-ant-*` vs generic `sk-*`).
 */
export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: "anthropic_api_key",
    // Anthropic keys are `sk-ant-` + 90+ urlsafe chars.
    regex: /sk-ant-[A-Za-z0-9_-]{50,}/,
  },
  {
    name: "openai_api_key",
    // OpenAI project keys are `sk-proj-` + 80+ chars.
    // Legacy keys are `sk-` + 48+ chars. Match both with
    // a lower bound that rules out short false positives.
    // Negative lookahead excludes `sk-ant-` so Anthropic
    // keys map to their own pattern rather than both.
    regex: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/,
  },
  {
    name: "github_classic_pat",
    regex: /ghp_[A-Za-z0-9]{36}/,
  },
  {
    name: "github_server_token",
    regex: /ghs_[A-Za-z0-9]{36}/,
  },
  {
    name: "github_fine_grained_pat",
    regex: /github_pat_[A-Za-z0-9_]{82}/,
  },
  {
    name: "aws_access_key",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: "google_api_key",
    regex: /AIza[A-Za-z0-9_-]{35}/,
  },
  {
    name: "slack_token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "stripe_live_secret",
    regex: /sk_live_[A-Za-z0-9]{24,}/,
  },
  {
    name: "stripe_live_restricted",
    regex: /rk_live_[A-Za-z0-9]{24,}/,
  },
  {
    name: "pem_private_key",
    // PEM-armored private key blocks for RSA, EC, OpenSSH, DSA, or
    // generic PKCS#8. A sync batch containing one of these is
    // unambiguously leaking signing material. Matched with a single-
    // line lookahead so CR/LF variations do not defeat the regex.
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: "huggingface_token",
    // HuggingFace personal access tokens are `hf_` + 30+ chars.
    // Short enough that a dedicated prefix guard matters.
    regex: /\bhf_[A-Za-z0-9]{30,}/,
  },
  // ── VO-issued bearer tokens (rung 12e) ───────────────────
  // Each VO token format is `<prefix>_<url-safe body>`. The
  // body is at least 32 random bytes encoded — well above any
  // ambient false-positive length. A dedicated pattern per
  // prefix keeps the redaction audit row's `pattern_name`
  // attribution informative (e.g., "you leaked a sync token"
  // vs "you leaked a session cookie").
  {
    name: "vo_agent_credential",
    // vop_ = hosted agent credential. Minted at
    // POST /account/agent-keys; crypto.randomBytes(32)
    // → 43 chars of base64url. Lower bound 40 rules out
    // short test fixtures like `vop_abc_<run-id>`.
    regex: /\bvop_[A-Za-z0-9_-]{40,}/,
  },
  {
    name: "vo_sync_token",
    // vons_ = node sync token. issueSyncToken uses 32 bytes
    // base64url; but some test fixtures are shorter. Lower
    // bound 20 covers live tokens while still catching
    // realistic leak shapes.
    regex: /\bvons_[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "vo_session_token",
    // vos_ = hosted browser session cookie value. New sessions
    // are issued with this prefix as of rung 12e; legacy
    // unprefixed sessions remain accepted until expiry but are
    // intentionally not matched by a broad base64url heuristic.
    regex: /\bvos_[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "vo_admin_session_token",
    // voa_ = operator admin browser session cookie value.
    // The admin session is a bearer cookie too; prefix it so
    // accidental leaks are scanner-visible without matching
    // arbitrary base64url strings.
    regex: /\bvoa_[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "vo_decrypt_grant",
    // vodg_ = browser decrypt grant. The grant contains two
    // base64url segments (payload.hmac); match the whole value
    // so historical redaction does not leave the HMAC segment
    // behind.
    regex: /\bvodg_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  },
  // ── Rung 11a: connector OAuth tokens (public-client only;
  // no `vocs_*` because confidential-client is out of scope).
  {
    name: "vo_connector_access",
    // voc_ = connector access token. crypto.randomBytes(32)
    // base64url → 43 chars. Lower bound 40 rules out short
    // test fixtures.
    regex: /\bvoc_[A-Za-z0-9_-]{40,}/,
  },
  {
    name: "vo_connector_refresh",
    // vocr_ = connector refresh token. Same body length as
    // access; replay-revoke makes leakage especially painful.
    regex: /\bvocr_[A-Za-z0-9_-]{40,}/,
  },
  {
    name: "vo_connector_auth_code",
    // voca_ = OAuth authorization code. Single-use + 5-min
    // TTL, but a leaked code mid-window is still a foothold.
    regex: /\bvoca_[A-Za-z0-9_-]{40,}/,
  },
];

/**
 * Local-path patterns. Unlike secret tokens, these reject
 * at the directory level rather than at the first path
 * character — we do not want to reject every string that
 * starts with `/` (e.g. URLs or CSS selectors).
 *
 * The posture: a sync item carrying a macOS user home
 * directory or Linux user home directory is almost
 * certainly leaking operator context. Reject with a
 * specific reason.
 */
export const LOCAL_PATH_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: "macos_user_home_path",
    regex: /\/Users\/[^\/\s"']+\//,
  },
  {
    name: "linux_user_home_path",
    regex: /\/home\/[^\/\s"']+\//,
  },
];
