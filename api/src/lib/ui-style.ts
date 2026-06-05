/**
 * Shared dashboard style system — VO-DASHBOARD-STYLE-SYSTEM-PR-1
 *
 * One product language, two palette priorities:
 *   - local  (dark-first, density-first, operator-hours)
 *   - hosted (light-first, calmer, audit-first)
 *
 * This module is the single source of truth for:
 *   - design tokens (palette, typography, spacing, radius)
 *   - shared CSS fragment (component grammar)
 *   - shared render helpers (badges, summary rows, section headers)
 *   - canonical AuthorityBadge (separate from command-status badges)
 *
 * Consumers:
 *   - api/src/routes/dashboard.ts → DASHBOARD_HTML inline <style> block
 *   - api/src/routes/portal-web.ts → layout(), signInPage(), browserDecryptPage()
 *
 * The seam is a CSS-fragment builder and helper functions, NOT a server-page
 * wrapper. The local dashboard remains a single client-rendered shell with
 * tab-switching; this module just gives it the same tokens and grammar as
 * the hosted shells.
 *
 * IMPORTANT — preserved pinned semantics:
 *   - command-status badges (badge / badge-warn / badge-err) are unchanged
 *   - canceled rows still render plain neutral `badge` (no badge-warn)
 *   - rejected/failed still render `badge-err`
 *   - queued/claimed still render `badge-warn`
 *   - AuthorityBadge is additive and uses its own class scheme (auth-badge)
 */

// ─── Palette priorities ──────────────────────────────────────────────────

/**
 * Local palette: dark-first, density-first.
 * Operator-hours tool. Background calm, accent scarce, mono for data.
 */
export const LOCAL_TOKENS = {
  // Surface — vintage-codex: dark British-racing-green depth ladder.
  bg: "#021008",
  bgRaised: "#0b2012",
  bgSecondary: "#06170c",
  border: "#3a3526",
  borderStrong: "#5f5a4a",
  // Text — parchment cream scale.
  text: "#e8dcc0",
  textSecondary: "#b8ad94",
  textMuted: "#8a836f",
  // Accent — amber lamplight (the gold star). accentFg = dark text on amber.
  accent: "#d4a857",
  accentSoft: "rgba(212,168,87,0.13)",
  accentFg: "#1c1408",
  // Semantic
  green: "#8bd49c",
  amber: "#ffb454",
  red: "#d97757",
  highlight: "#9bbf9f",
  // Type / radius — crisp, near-engraving.
  fontSans: "'Inter', system-ui, -apple-system, sans-serif",
  fontMono: "'JetBrains Mono', 'Geist Mono', 'Fira Code', ui-monospace, monospace",
  radius: "3px",
  radiusSm: "2px",
} as const;

/**
 * Hosted palette: light-first, calmer, audit-first.
 * Mirror/control surface. Same component grammar, different palette.
 */
export const HOSTED_TOKENS = {
  // Surface — vintage-codex (intentionally identical to LOCAL now so the
  // portal/dashboard match the marketing brand; the density difference lives
  // in component CSS/extras, not the palette).
  bg: "#021008",
  bgRaised: "#0b2012",
  bgSecondary: "#06170c",
  border: "#3a3526",
  borderStrong: "#5f5a4a",
  // Text — parchment cream scale.
  text: "#e8dcc0",
  textSecondary: "#b8ad94",
  textMuted: "#8a836f",
  // Accent — amber lamplight. accentFg = dark text on amber.
  accent: "#d4a857",
  accentSoft: "rgba(212,168,87,0.13)",
  accentFg: "#1c1408",
  // Semantic
  green: "#8bd49c",
  amber: "#ffb454",
  red: "#d97757",
  highlight: "#9bbf9f",
  // Type / radius — crisp, near-engraving.
  fontSans: "'Inter', system-ui, -apple-system, sans-serif",
  fontMono: "'JetBrains Mono', 'Geist Mono', 'Fira Code', ui-monospace, monospace",
  radius: "3px",
  radiusSm: "2px",
} as const;

export type PalettePriority = "local" | "hosted";
export type TokenSet = typeof LOCAL_TOKENS | typeof HOSTED_TOKENS;

// ─── Token CSS builder ──────────────────────────────────────────────────

/**
 * Build the `:root { --token: value; ... }` CSS block for a palette.
 * Token names are stable across local and hosted so component CSS reads
 * the same variables — palette differs, component grammar does not.
 */
export function tokenCssBlock(p: PalettePriority): string {
  const t = p === "local" ? LOCAL_TOKENS : HOSTED_TOKENS;
  // The legacy aliases below (--card, --card2, --dim, --muted, --err, --warn, --bg-card)
  // are intentional. Existing renderer markup in dashboard.ts and portal-web.ts
  // still references these names from the pre-shared-seam world (e.g. card meta
  // labels, cancel buttons, decrypt error states). Dropping them would silently
  // break their intended colors. Keep these aliases as long as any inline
  // markup in dashboard.ts / portal-web.ts uses them — sweep them out only
  // when every var(--dim|muted|card|card2|err|warn|bg-card) consumer is gone.
  return `:root {
  --bg: ${t.bg};
  --bg-raised: ${t.bgRaised};
  --bg-secondary: ${t.bgSecondary};
  --border: ${t.border};
  --border-strong: ${t.borderStrong};
  --text: ${t.text};
  --text-secondary: ${t.textSecondary};
  --text-muted: ${t.textMuted};
  --accent: ${t.accent};
  --accent-soft: ${t.accentSoft};
  --accent-fg: ${t.accentFg};
  --green: ${t.green};
  --amber: ${t.amber};
  --red: ${t.red};
  --highlight: ${t.highlight};
  --radius: ${t.radius};
  --radius-sm: ${t.radiusSm};
  --font-sans: ${t.fontSans};
  --font-mono: ${t.fontMono};

  /* ── Legacy aliases (preserve existing renderer markup) ── */
  /* Old surface names */
  --card: ${t.bgRaised};
  --bg-card: ${t.bgRaised};
  --card2: ${t.bgSecondary};
  /* Old text names */
  --dim: ${t.textSecondary};
  --muted: ${t.textMuted};
  /* Old semantic names */
  --err: ${t.red};
  --warn: ${t.amber};
}`;
}

// ─── Shared component CSS fragment ──────────────────────────────────────

/**
 * Component grammar shared by local and hosted. Reads `var(--*)` so both
 * palettes work without changing the rules. Returns a CSS fragment that
 * each shell embeds into its own <style> block.
 *
 * Grammar covers: typography, buttons, badges, alerts, section headers,
 * summary rows, tables/lists, form controls, empty states, and the
 * canonical authority badge.
 *
 * Includes legacy aliases (.bg-card → --bg-raised, .dim → --text-secondary)
 * so existing per-renderer markup keeps working without a sweeping rewrite.
 */
export const SHARED_COMPONENT_CSS = `
/* ── Reset ── */
* { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Body / type ── */
body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: var(--font-mono); font-size: .82rem;
  color: var(--highlight); background: var(--bg-secondary);
  padding: .12rem .35rem; border-radius: var(--radius-sm);
}

/* ── Headings ── */
h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -.01em; margin-bottom: .75rem; }
h2 { font-size: .98rem; font-weight: 600; margin-bottom: .6rem; }
h3 { font-size: .9rem; font-weight: 600; margin-bottom: .35rem; }

/* ── Page rhythm: kicker + title + lead ── */
.page-kicker {
  font-size: .68rem; font-weight: 600; letter-spacing: .12em;
  text-transform: uppercase; color: var(--text-muted);
  margin-bottom: .35rem;
}
.page-title-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 1rem; margin-bottom: .5rem;
}
.page-lead {
  font-size: .92rem; color: var(--text-secondary);
  max-width: 60ch; margin-bottom: 1rem;
}
.page-state-row {
  display: flex; flex-wrap: wrap; gap: .75rem; align-items: center;
  padding: .55rem .75rem; background: var(--bg-secondary);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  margin-bottom: 1rem; font-size: .82rem; color: var(--text-secondary);
}
.page-actions {
  display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;
  margin-bottom: 1rem;
}

/* Compact rhythm: dense view, no lead paragraph by default */
.rhythm-compact .page-title-row { margin-bottom: .35rem; }
.rhythm-compact .page-actions { margin-bottom: .75rem; }

/* Full rhythm: explanatory, audit/onboarding-style */
.rhythm-full .page-title-row { margin-bottom: .5rem; }

/* ── Cards ── */
.card {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.1rem 1.15rem;
  margin-bottom: .85rem;
}
.card-title {
  font-size: .72rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: .07em; color: var(--text-muted); margin-bottom: .65rem;
}

/* Section header inside a card */
.section-header {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: .5rem;
}
.section-header .section-title {
  font-size: .82rem; font-weight: 600; color: var(--text);
}
.section-header .section-meta {
  font-size: .72rem; color: var(--text-muted);
  font-family: var(--font-mono);
}

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: .5rem .9rem; font-size: .82rem; font-weight: 600;
  border-radius: var(--radius-sm); border: 1px solid transparent;
  cursor: pointer; white-space: nowrap; transition: opacity .12s, border-color .12s;
  text-decoration: none;
}
.btn-primary { background: var(--accent); color: var(--accent-fg); }
.btn-primary:hover { opacity: .9; text-decoration: none; }
.btn-ghost {
  background: transparent; color: var(--text-secondary);
  border-color: var(--border-strong);
}
.btn-ghost:hover { color: var(--text); border-color: var(--text-secondary); text-decoration: none; }
.btn-danger { background: var(--red); color: var(--accent-fg); }
.btn-danger:hover { opacity: .9; text-decoration: none; }
.btn:disabled { opacity: .4; cursor: default; }
.btn-sm { padding: .35rem .7rem; font-size: .75rem; }

/* ── Badges (command-status grammar — DO NOT collapse with auth-badge) ── */
.badge {
  display: inline-block; font-size: .68rem; font-weight: 500;
  padding: .14rem .45rem; border-radius: var(--radius-sm);
  background: var(--border); color: var(--text-secondary);
  vertical-align: middle;
}
.badge-ok { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); }
.badge-warn { background: color-mix(in srgb, var(--amber) 18%, transparent); color: var(--amber); }
.badge-err { background: color-mix(in srgb, var(--red) 18%, transparent); color: var(--red); }

/* ── Authority badge (canonical, separate from command-status badges) ── */
.auth-badge {
  display: inline-flex; align-items: center; gap: .35rem;
  font-size: .7rem; font-weight: 600;
  padding: .2rem .55rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-secondary); color: var(--text-secondary);
  font-family: var(--font-sans);
}
.auth-badge .auth-icon {
  font-family: var(--font-mono); font-size: .8rem; line-height: 1;
  opacity: .85;
}
.auth-badge[data-state="local-authoritative"] {
  border-color: color-mix(in srgb, var(--green) 35%, var(--border-strong));
  color: var(--green);
}
.auth-badge[data-state="mirrored"] {
  border-color: var(--border-strong);
  color: var(--text-secondary);
}
.auth-badge[data-state="stale"] {
  border-color: color-mix(in srgb, var(--amber) 40%, var(--border-strong));
  color: var(--amber);
}
.auth-badge[data-state="queued-intent"] {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border-strong));
  color: var(--accent);
}
.auth-badge[data-state="applied"] {
  border-color: color-mix(in srgb, var(--green) 35%, var(--border-strong));
  color: var(--green);
}
.auth-badge[data-state="rejected"] {
  border-color: color-mix(in srgb, var(--red) 40%, var(--border-strong));
  color: var(--red);
}
.auth-badge[data-state="expired"] {
  border-color: var(--border-strong);
  color: var(--text-muted);
}
.auth-badge[data-state="disconnected"] {
  border-color: color-mix(in srgb, var(--red) 35%, var(--border-strong));
  color: var(--red);
}
.auth-badge[data-state="unavailable-on-snapshot"] {
  border-color: var(--border-strong);
  color: var(--text-muted);
}
.auth-freshness {
  font-size: .7rem; color: var(--text-muted);
  font-family: var(--font-mono); margin-left: .4rem;
}

/* ── Alerts ── */
.alert {
  display: flex; align-items: center; gap: .55rem;
  padding: .55rem .8rem; border-radius: var(--radius-sm);
  font-size: .85rem; margin-bottom: .5rem;
  border: 1px solid var(--border);
}
.alert-icon { font-size: .95rem; line-height: 1; flex-shrink: 0; }
.alert.red, .alert-err {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  border-color: color-mix(in srgb, var(--red) 25%, var(--border));
  color: var(--red);
}
.alert.amber, .alert-warn {
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  border-color: color-mix(in srgb, var(--amber) 22%, var(--border));
  color: var(--amber);
}
.alert.green, .alert-ok {
  background: color-mix(in srgb, var(--green) 8%, transparent);
  border-color: color-mix(in srgb, var(--green) 25%, var(--border));
  color: var(--green);
}

/* ── Summary row ── */
.summary-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: .35rem 0; font-size: .85rem;
}
.summary-label { color: var(--text-secondary); }
.summary-value { font-family: var(--font-mono); color: var(--text); font-weight: 500; }

/* ── Stats ── */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .65rem; }
.stat { text-align: center; }
.stat-value, .stat .n {
  font-size: 1.45rem; font-weight: 700;
  color: var(--text); font-family: var(--font-mono);
}
.stat-label, .stat .label {
  font-size: .68rem; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .05em;
  margin-top: .1rem; display: block;
}

/* ── Tables / lists ── */
.list {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
}
.list-row {
  display: flex; gap: .75rem; padding: .55rem .85rem;
  border-bottom: 1px solid var(--border); font-size: .83rem;
  align-items: center;
}
.list-row:last-child { border-bottom: none; }
.list-row:hover { background: var(--bg-secondary); }

/* ── Form controls ── */
.input, .input-sm {
  padding: .45rem .65rem; font-size: .82rem;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  outline: none; font-family: var(--font-sans);
}
.input:focus, .input-sm:focus { border-color: var(--accent); }
.input-sm { padding: .4rem .6rem; min-width: 120px; }

/* ── States ── */
.empty {
  color: var(--text-muted); font-size: .82rem;
  font-style: italic; padding: .5rem 0;
}
.state-msg {
  text-align: center; padding: 2.5rem 1rem;
  color: var(--text-muted); font-size: .9rem;
}
.state-disconnected {
  background: color-mix(in srgb, var(--red) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 25%, var(--border));
  border-radius: var(--radius-sm);
  padding: .65rem .8rem; font-size: .82rem;
  color: var(--text-secondary);
}
.state-unavailable {
  font-size: .78rem; color: var(--text-muted);
  font-style: italic;
}

/* ── Section grid ── */
.section-cols {
  display: grid; grid-template-columns: 1fr 1fr; gap: .85rem;
}
@media (max-width: 768px) {
  .section-cols { grid-template-columns: 1fr; }
}

/* ── Legacy aliases (preserve existing renderer markup) ── */
.bg-card { background: var(--bg-raised); }
.dim { color: var(--text-secondary); }
.muted { color: var(--text-muted); }
`;

// ─── Render helpers (server-side string builders) ───────────────────────

export type AuthorityState =
  | "local-authoritative"
  | "mirrored"
  | "stale"
  | "queued-intent"
  | "applied"
  | "rejected"
  | "expired"
  | "disconnected"
  | "unavailable-on-snapshot";

const AUTHORITY_LABELS: Record<AuthorityState, string> = {
  "local-authoritative": "Local authoritative",
  "mirrored": "Mirrored",
  "stale": "Stale",
  "queued-intent": "Queued intent",
  "applied": "Applied",
  "rejected": "Rejected",
  "expired": "Expired",
  "disconnected": "Disconnected",
  "unavailable-on-snapshot": "Unavailable on snapshot",
};

// Mono-glyph icons. Color is secondary; label carries the meaning.
const AUTHORITY_ICONS: Record<AuthorityState, string> = {
  "local-authoritative": "●",
  "mirrored": "◐",
  "stale": "◔",
  "queued-intent": "→",
  "applied": "✓",
  "rejected": "✕",
  "expired": "▽",
  "disconnected": "⚠",
  "unavailable-on-snapshot": "—",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Canonical authority badge. Use for state widgets, NOT for command-status
 * rows. Command-status rows continue to use the existing `badge` /
 * `badge-warn` / `badge-err` grammar (preserved verbatim by tests).
 *
 * @param state One of the canonical AuthorityState values.
 * @param freshness Optional ISO date string. When provided, renders a
 *                  `freshness` chip next to the badge for state widgets
 *                  that should surface lastSyncedAt near the badge.
 */
export function authorityBadge(state: AuthorityState, freshness?: string | null): string {
  const label = AUTHORITY_LABELS[state];
  const icon = AUTHORITY_ICONS[state];
  const freshnessHtml = freshness
    ? ` <span class="auth-freshness">${escapeHtml(freshness)}</span>`
    : "";
  return `<span class="auth-badge" data-state="${state}">` +
    `<span class="auth-icon" aria-hidden="true">${icon}</span>` +
    `<span class="auth-label">${escapeHtml(label)}</span>` +
    `</span>${freshnessHtml}`;
}

/**
 * Compact-rhythm page header (no lead paragraph by default).
 * Default for local density-first views.
 */
export function compactHeader(opts: {
  kicker?: string;
  title: string;
  authorityState?: AuthorityState;
  freshness?: string | null;
  meta?: string;
}): string {
  const kicker = opts.kicker ? `<div class="page-kicker">${escapeHtml(opts.kicker)}</div>` : "";
  const auth = opts.authorityState ? ` ${authorityBadge(opts.authorityState, opts.freshness)}` : "";
  const meta = opts.meta ? `<span class="section-meta">${escapeHtml(opts.meta)}</span>` : "";
  return `<div class="rhythm-compact">${kicker}` +
    `<div class="page-title-row"><h1>${escapeHtml(opts.title)}${auth}</h1>${meta}</div></div>`;
}

/**
 * Full-rhythm page header (kicker + title + lead + state).
 * Default for hosted audit/settings/onboarding views.
 */
export function fullHeader(opts: {
  kicker?: string;
  title: string;
  lead?: string;
  authorityState?: AuthorityState;
  freshness?: string | null;
  state?: string;
}): string {
  const kicker = opts.kicker ? `<div class="page-kicker">${escapeHtml(opts.kicker)}</div>` : "";
  const lead = opts.lead ? `<p class="page-lead">${escapeHtml(opts.lead)}</p>` : "";
  const auth = opts.authorityState
    ? `<div class="page-state-row">${authorityBadge(opts.authorityState, opts.freshness)}` +
      (opts.state ? ` <span>${escapeHtml(opts.state)}</span>` : "") +
      `</div>`
    : (opts.state ? `<div class="page-state-row">${escapeHtml(opts.state)}</div>` : "");
  return `<div class="rhythm-full">${kicker}` +
    `<div class="page-title-row"><h1>${escapeHtml(opts.title)}</h1></div>` +
    `${lead}${auth}</div>`;
}

/**
 * Summary row helper — `<label, value>` pair used in cards.
 */
export function summaryRow(label: string, value: string, opts?: { mono?: boolean }): string {
  const valueClass = opts?.mono === false ? "summary-value" : "summary-value";
  return `<div class="summary-row"><span class="summary-label">${escapeHtml(label)}</span>` +
    `<span class="${valueClass}">${escapeHtml(value)}</span></div>`;
}

/**
 * Section header inside a card.
 */
export function sectionHeader(title: string, meta?: string): string {
  const metaHtml = meta ? `<span class="section-meta">${escapeHtml(meta)}</span>` : "";
  return `<div class="section-header"><span class="section-title">${escapeHtml(title)}</span>${metaHtml}</div>`;
}

/**
 * Disconnected state block (hosted-only typical).
 */
export function disconnectedBlock(message?: string): string {
  const msg = message || "Hosted cannot currently confirm fresh state from local. Mirrored values shown may be stale. Queued actions remain auditable intent, not direct mutation.";
  return `<div class="state-disconnected">${authorityBadge("disconnected")} ${escapeHtml(msg)}</div>`;
}

/**
 * Unavailable-on-snapshot state (field-level, not connectivity-level).
 */
export function unavailableBlock(message?: string): string {
  const msg = message || "Hosted has a current snapshot, but this field is not present or not trustworthy in that snapshot.";
  return `<div class="state-disconnected">${authorityBadge("unavailable-on-snapshot")} ${escapeHtml(msg)}</div>`;
}

/**
 * Build the full <style> block for a shell. Bundles tokens + shared
 * components + any shell-specific extras. Pass `extraCss` for shell-only
 * rules (e.g. local sidebar, hosted top nav, browser-decrypt status).
 */
export function buildStyleBlock(palette: PalettePriority, extraCss = ""): string {
  return tokenCssBlock(palette) + "\n" + SHARED_COMPONENT_CSS + "\n" + extraCss;
}

// ─── Module marker (for tests) ──────────────────────────────────────────

/**
 * String marker each shell embeds so tests can verify the shared seam
 * is actually being used (vs some shell having drifted back to inline tokens).
 */
export const SHARED_SEAM_MARKER = "vo-ui-style-system-v1";
