/**
 * Public homepage — VO-WEBSITE-HOMEPAGE-PR-1
 *
 * Seam for the content-negotiated root:
 *   GET / with Accept containing text/html (and not application/json)
 *     → renderHomepage()
 *   everything else (wildcard, empty, missing, application/json)
 *     → the existing machine-facing discovery JSON in api/src/index.ts
 *
 * This module only exports pure functions — no Hono app, no side effects —
 * so tests and the root dispatcher can both consume it cleanly:
 *   - prefersHtml(accept)  → content-negotiation predicate
 *   - renderHomepage()     → the full HTML document as a string
 *
 * Visual language:
 *   - Reuses HOSTED_TOKENS + tokenCssBlock("hosted") + SHARED_SEAM_MARKER
 *     from ui-style.ts so typography, spacing, and palette stay in sync
 *     with the hosted portal.
 *   - Does NOT import SHARED_COMPONENT_CSS or authorityBadge / fullHeader /
 *     compactHeader — those are dashboard grammar. The public homepage
 *     defines its own layout vocabulary (site-hero, site-section,
 *     site-path, site-usecase, site-system, site-authority, site-footer)
 *     so the explainer surface does not drift toward dashboard chrome.
 */

import { tokenCssBlock, SHARED_SEAM_MARKER } from "../lib/ui-style";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { errorJson } from "../lib/error-envelope";

// ─── Content negotiation ────────────────────────────────────────────────

/**
 * Strict rule for serving HTML at `/`:
 *   - Missing / empty Accept → JSON (caller made no claim — default is
 *     machine-readable discovery)
 *   - `*` / `*​/*` wildcard → JSON (curl default, generic HTTP client)
 *   - Any `application/json` in the Accept list → JSON (machine caller)
 *   - Only when the caller names `text/html` AND has not also named
 *     `application/json` → HTML
 *
 * This preserves the existing JSON contract for every machine caller and
 * every default-Accept test in scripts/smoke-test.sh and
 * api/src/routes/smoke.test.ts. Browsers — which send
 * `text/html,application/xhtml+xml,application/xml;q=0.9,image/...,*​/*;q=0.8`
 * — receive HTML.
 */
export function prefersHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const a = accept.toLowerCase().trim();
  if (a === "" || a === "*/*") return false;
  if (a.includes("application/json")) return false;
  return a.includes("text/html");
}

/**
 * Merge a new Vary dimension into any existing Vary header value without
 * overwriting what an upstream middleware already set. betaCors sets
 * `Vary: Origin` in its before-phase for cross-origin callers; the root
 * handler adds `Vary: Accept` for the HTML-vs-JSON split — both
 * dimensions matter, and overwriting one for the other breaks either
 * CORS cache correctness or the content-negotiation cache correctness.
 *
 * Returns a single comma-separated header value (preferred over multiple
 * Vary headers). De-duplicates case-insensitively.
 */
export function mergeVary(existing: string | null | undefined, addition: string): string {
  const target = addition.trim();
  if (!existing || !existing.trim()) return target;
  const tokens = existing.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.some((t) => t.toLowerCase() === target.toLowerCase())) return existing;
  return `${existing}, ${target}`;
}

// ─── Copy constants ─────────────────────────────────────────────────────
//
// The canonical hero headline, 40-word-budget subhead, quick-start intro,
// trust/authority summary, and per-use-case blocks live here so they can
// be changed in one place and so tests can assert them directly against
// this module if needed.
//
// Word-budget audit (hero subhead ≤ 40, quick-start intro ≤ 30,
// use cases ≤ 50 each, trust summary ≤ 100). These limits and
// audited counts are enforced by api/src/routes/site.test.ts:
//   - HERO_SUBHEAD: 33 words ✓ (budget ≤ 40)
//   - QUICKSTART_INTRO: 28 words ✓ (budget ≤ 30)
//   - USECASE_RESEARCH_BODY: 36 words ✓ (budget ≤ 50)
//   - USECASE_CODING_BODY: 44 words ✓ (budget ≤ 50)
//   - USECASE_OPS_BODY: 35 words ✓ (budget ≤ 50)
//   - TRUST_SUMMARY: 49 words ✓ (budget ≤ 100)

const HERO_HEADLINE = "A reviewable knowledge graph for AI agents — local by default.";

const HERO_SUBHEAD =
  "Verity One runs on your machine and stores what agents learn as an inspectable graph. " +
  "Desktop and terminal agents connect over local MCP; web agents connect at verityone.app/mcp. " +
  "Your local node stays authoritative.";

const QUICKSTART_INTRO =
  "You can be running Verity One locally in about five minutes. " +
  "Start here to try it yourself. " +
  "If you are wiring an agent, skip to the MCP path.";

const TRUST_SUMMARY =
  "Your local node is the only source of truth. " +
  "Hosted state, web-MCP writes, and any change made remotely become queued intent that local then applies, rejects, or lets expire. " +
  "Only local MCP writes are authoritative in real time. " +
  "When hosted cannot reach local it says so rather than pretending.";

const USECASE_RESEARCH_BODY =
  "Save decisions, references, and working notes as a graph your agent can query back. " +
  "Every entry has provenance, a confidence score, and edges you can walk. " +
  "Hosted gives you audit from any device; local keeps authority.";

const USECASE_CODING_BODY =
  "Your coding agent reads and writes Verity One over local MCP: what the repo is, which patterns you have approved, what you have deferred. " +
  "Local MCP writes are authoritative, so the agent memory and your ground truth stay in sync without a hosted round-trip.";

const USECASE_OPS_BODY =
  "Encode runbooks, provider configs, and recurring decisions as a reviewable graph. " +
  "Team on-machine agents read via local MCP, and web agents use verityone.app/mcp. " +
  "Remote edits arrive as queued intent the authoritative node reviews before applying.";

// ─── Site-specific CSS (not dashboard grammar) ──────────────────────────
//
// Exported so sibling public-HTML renderers (api/src/routes/site-start.ts)
// can reuse the same site-* vocabulary — header/nav/section/prose/footer —
// without duplicating the rules and drifting out of sync with the homepage.
// Dashboard chrome (SHARED_COMPONENT_CSS) is deliberately not in the shared
// public set; that separation is load-bearing for the public visual language.

export const SITE_CSS = `
/* ── ${SHARED_SEAM_MARKER} :: public homepage (site) extras ── */
* { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

code {
  font-family: var(--font-mono);
  font-size: .88em;
  background: var(--bg-secondary);
  padding: .1em .35em;
  border-radius: var(--radius-sm);
  color: var(--text);
}

.site-wrap { max-width: 1040px; margin: 0 auto; padding: 0 1.5rem; }

/* ── Header ── */
.site-header {
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
  padding: .95rem 0;
  position: sticky;
  top: 0;
  z-index: 10;
}
.site-header-inner {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
}
.site-brand {
  font-weight: 700; font-size: 1.05rem; letter-spacing: -.01em;
  color: var(--text);
}
.site-brand:hover { text-decoration: none; }
.site-brand-mark {
  font-family: var(--font-mono); font-size: .65rem;
  color: var(--text-muted); margin-left: .4rem;
  text-transform: uppercase; letter-spacing: .12em;
}
.site-nav { display: flex; gap: .1rem; flex-wrap: wrap; }
.site-nav a {
  padding: .4rem .72rem; font-size: .88rem;
  color: var(--text-secondary); border-radius: var(--radius-sm);
}
.site-nav a:hover {
  color: var(--text); background: var(--bg-secondary);
  text-decoration: none;
}

/* ── Kicker (label above section titles) ── */
.site-kicker {
  font-size: .72rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em;
  color: var(--text-muted); margin-bottom: .45rem;
}

/* ── Hero ── */
.site-hero {
  padding: 3.5rem 0 3rem;
  border-bottom: 1px solid var(--border);
}
.site-hero-grid {
  display: grid; grid-template-columns: 1.2fr 1fr;
  gap: 2.25rem; align-items: center;
}
.site-hero-headline {
  font-size: 2.3rem; font-weight: 700; line-height: 1.15;
  letter-spacing: -.015em; margin: .5rem 0 1.1rem;
  color: var(--text); max-width: 22ch;
}
.site-hero-subhead {
  font-size: 1.05rem; color: var(--text-secondary);
  max-width: 58ch; margin-bottom: 1.6rem; line-height: 1.55;
}
.site-cta-row { display: flex; gap: .7rem; flex-wrap: wrap; }
.site-cta {
  display: inline-flex; align-items: center; justify-content: center;
  padding: .7rem 1.15rem; font-size: .92rem; font-weight: 600;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition: opacity .14s, background .14s, border-color .14s;
}
.site-cta-primary { background: var(--accent); color: #ffffff; }
.site-cta-primary:hover { opacity: .9; text-decoration: none; }
.site-cta-ghost {
  background: transparent; color: var(--text);
  border-color: var(--border-strong);
}
.site-cta-ghost:hover {
  background: var(--bg-secondary); border-color: var(--text-secondary);
  text-decoration: none;
}
.site-hero-visual {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.2rem;
}
.site-hero-visual svg { width: 100%; height: auto; display: block; }

/* ── Section rhythm ── */
.site-section {
  padding: 3.25rem 0;
  border-bottom: 1px solid var(--border);
}
.site-section-soft { background: var(--bg-secondary); }
.site-section h2 {
  font-size: 1.55rem; font-weight: 700; letter-spacing: -.01em;
  margin-bottom: 1rem; color: var(--text);
}
.site-lead {
  font-size: 1rem; color: var(--text-secondary);
  max-width: 60ch; margin-bottom: 1.6rem;
}

/* ── Prose ── */
.site-prose p {
  margin-bottom: 1rem; max-width: 70ch;
  color: var(--text-secondary);
}
.site-prose p:last-child { margin-bottom: 0; }
.site-prose strong { color: var(--text); font-weight: 600; }

/* ── Getting-started paths ── */
.site-paths {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
  margin-top: .5rem;
}
.site-path {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.3rem 1.4rem;
  display: flex; flex-direction: column; gap: .55rem;
}
.site-path h3 { font-size: 1rem; font-weight: 600; color: var(--text); }
.site-path-caption {
  font-size: .88rem; color: var(--text-secondary);
  margin-bottom: .4rem; line-height: 1.55;
}
.site-steps {
  list-style: decimal; padding-left: 1.25rem;
  font-size: .9rem; color: var(--text-secondary); line-height: 1.7;
}
.site-steps li { margin-bottom: .08rem; }
.site-path-link { margin-top: auto; font-size: .88rem; }

/* ── Use cases ── */
.site-usecases {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
}
.site-usecase {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.3rem 1.4rem;
}
.site-usecase h3 {
  font-size: 1rem; font-weight: 600; color: var(--text);
  margin-bottom: .25rem;
}
.site-usecase-tag {
  font-size: .7rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em;
  color: var(--text-muted); margin-bottom: .75rem;
}
.site-usecase p {
  font-size: .93rem; color: var(--text-secondary);
  line-height: 1.55;
}

/* ── System diagram layout ── */
.site-system {
  display: grid; grid-template-columns: 1.2fr 1fr;
  gap: 1.75rem; align-items: start;
}
.site-system-diagram {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem;
  overflow-x: auto;
}
.site-system-diagram svg {
  width: 100%; height: auto; display: block; min-width: 540px;
}

/* ── Trust + authority ── */
.site-trust {
  font-size: 1rem; color: var(--text);
  max-width: 72ch; margin-bottom: 1.75rem; line-height: 1.6;
}
.site-authority {
  display: grid; grid-template-columns: minmax(190px, 1fr) 2fr;
  gap: .65rem 1.25rem;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.4rem;
}
.site-authority dt {
  font-size: .92rem; font-weight: 600; color: var(--text);
}
.site-authority dd {
  font-size: .9rem; color: var(--text-secondary);
  line-height: 1.55;
}

/* ── Deeper links ── */
.site-links {
  list-style: none; padding: 0;
  display: grid; gap: .4rem;
}
.site-links li { font-size: .95rem; }
.site-links a { color: var(--accent); }

/* ── Footer ── */
.site-footer {
  padding: 1.85rem 0;
  background: var(--bg-raised);
  border-top: 1px solid var(--border);
  color: var(--text-muted); font-size: .85rem;
}
.site-footer p { margin-bottom: .25rem; }
.site-footer-meta {
  font-family: var(--font-mono); font-size: .72rem;
  color: var(--text-muted); opacity: .75;
}

/* ── Responsive ── */
@media (max-width: 880px) {
  .site-hero { padding: 2.5rem 0 2.25rem; }
  .site-hero-grid { grid-template-columns: 1fr; gap: 1.5rem; }
  .site-paths { grid-template-columns: 1fr; }
  .site-usecases { grid-template-columns: 1fr; }
  .site-system { grid-template-columns: 1fr; }
  .site-hero-headline { font-size: 1.8rem; }
  .site-nav { justify-content: flex-start; }
}
`;

// ─── Hero schematic SVG ─────────────────────────────────────────────────
//
// Compact schematic required by the spec:
//   - Local VO + Hosted VO rendered with Local VO visibly larger
//   - local MCP as a port on Local VO; web MCP as a port on Hosted VO
//     (neither drawn as a standalone peer box)
//   - Desktop/terminal agent wired to local MCP
//   - Web agent wired to web MCP
//   - One non-happy-path state surfaced ("Queued intent · pending")
//
// Colors are hardcoded from HOSTED_TOKENS for self-containment — the SVG
// renders correctly even if CSS is stripped by a reader.

const HERO_SVG = `
<svg viewBox="0 0 460 290" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-labelledby="site-hero-svg-title site-hero-svg-desc">
  <title id="site-hero-svg-title">Verity One hero schematic</title>
  <desc id="site-hero-svg-desc">
    A desktop or terminal agent connects over local MCP to the larger Local
    VO node. A web agent connects over web MCP to the smaller Hosted VO
    satellite, whose mirrored state shows a queued-intent label pending
    local resolution.
  </desc>
  <defs>
    <marker id="site-hero-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 Z" fill="#7A8290"/>
    </marker>
  </defs>

  <!-- Desktop / terminal agent (top-left) -->
  <g>
    <rect x="38" y="14" width="120" height="42" rx="4"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.2"/>
    <text x="98" y="31" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="12" font-weight="600" fill="#15181D">Desktop / terminal</text>
    <text x="98" y="46" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" fill="#7A8290">agent</text>
  </g>

  <!-- Web agent (top-right) -->
  <g>
    <rect x="302" y="14" width="120" height="42" rx="4"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.2"/>
    <text x="362" y="31" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="12" font-weight="600" fill="#15181D">Web agent</text>
    <text x="362" y="46" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="10" font-family-mono="Geist Mono" fill="#7A8290">verityone.app</text>
  </g>

  <!-- Agent → MCP port arrows -->
  <path d="M98,60 L98,96" stroke="#7A8290" stroke-width="1.4" fill="none"
        marker-end="url(#site-hero-arrow)"/>
  <path d="M362,60 L362,96" stroke="#7A8290" stroke-width="1.4" fill="none"
        marker-end="url(#site-hero-arrow)"/>
  <text x="108" y="82" font-family="Inter, sans-serif" font-size="10" fill="#7A8290">scoped read/write</text>
  <text x="372" y="82" font-family="Inter, sans-serif" font-size="10" fill="#7A8290">read / queued intent</text>

  <!-- local MCP port (on Local VO) -->
  <g>
    <rect x="40" y="100" width="116" height="22" rx="3"
          fill="#EAEFFC" stroke="#3354D1" stroke-width="1.3"/>
    <text x="98" y="115" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#3354D1">local MCP</text>
  </g>

  <!-- web MCP port (on Hosted VO) -->
  <g>
    <rect x="304" y="100" width="116" height="22" rx="3"
          fill="#F1F3F6" stroke="#CDD2DA" stroke-width="1.3"/>
    <text x="362" y="115" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#15181D">web MCP</text>
  </g>

  <!-- Local VO (larger) -->
  <g>
    <rect x="22" y="122" width="172" height="120" rx="6"
          fill="#FFFFFF" stroke="#3354D1" stroke-width="1.8"/>
    <text x="108" y="144" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="13" font-weight="700" fill="#15181D">Local VO</text>
    <text x="108" y="160" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="10" fill="#127B45">source of truth</text>
    <text x="34" y="184" font-family="Geist Mono, monospace" font-size="10" fill="#4B5260">graph · memories</text>
    <text x="34" y="200" font-family="Geist Mono, monospace" font-size="10" fill="#4B5260">secrets · settings</text>
    <text x="34" y="216" font-family="Geist Mono, monospace" font-size="10" fill="#4B5260">authoritative state</text>
  </g>

  <!-- Hosted VO (smaller satellite) -->
  <g>
    <rect x="286" y="122" width="152" height="94" rx="6"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.3"/>
    <text x="362" y="144" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="13" font-weight="700" fill="#15181D">Hosted VO</text>
    <text x="362" y="160" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="10" fill="#7A8290">mirror · satellite</text>
    <text x="298" y="184" font-family="Geist Mono, monospace" font-size="10" fill="#4B5260">freshness</text>
    <text x="298" y="200" font-family="Geist Mono, monospace" font-size="10" fill="#4B5260">intent queue</text>
  </g>

  <!-- mirror arrow: local → hosted (top) -->
  <path d="M196,162 L284,162" stroke="#7A8290" stroke-width="1.4" fill="none"
        marker-end="url(#site-hero-arrow)"/>
  <text x="240" y="156" text-anchor="middle" font-family="Inter, sans-serif"
        font-size="10" fill="#4B5260">mirror</text>

  <!-- queued intent arrow: hosted → local (bottom) -->
  <path d="M284,196 L196,196" stroke="#7A8290" stroke-width="1.4" fill="none"
        marker-end="url(#site-hero-arrow)"/>
  <text x="240" y="190" text-anchor="middle" font-family="Inter, sans-serif"
        font-size="10" fill="#4B5260">queued intent</text>

  <!-- Authority state label attached to Hosted VO (non-happy-path) -->
  <g>
    <rect x="286" y="230" width="152" height="24" rx="3"
          fill="#FFF5E5" stroke="#A36500" stroke-width="1.2"/>
    <text x="362" y="246" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#A36500">Queued intent · pending</text>
  </g>

  <!-- Local authoritative label attached to Local VO -->
  <g>
    <rect x="22" y="256" width="172" height="22" rx="3"
          fill="#E6F5ED" stroke="#127B45" stroke-width="1.1"/>
    <text x="108" y="271" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#127B45">Local authoritative</text>
  </g>
</svg>
`;

// ─── System diagram SVG (How it works) ──────────────────────────────────
//
// Detailed diagram required by the spec:
//   - Local VO central and largest
//   - Hosted VO smaller, attached as satellite
//   - local MCP rendered as port/edge on Local VO
//   - web MCP rendered as port/edge on Hosted VO
//   - Labeled arrows: mirror / queued intent / local scoped read/write /
//     web read + queued intent
//   - Semantics rendered inside each box
//   - Both agent types drawn (desktop/terminal + web)
//   - No three equal columns, rosettes, or pillars

const SYSTEM_SVG = `
<svg viewBox="0 0 720 420" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-labelledby="site-system-svg-title site-system-svg-desc">
  <title id="site-system-svg-title">Verity One system model</title>
  <desc id="site-system-svg-desc">
    A large Local VO node holds the authoritative graph, memories, secrets,
    settings, and is the source of truth. Its top edge carries a local MCP
    port through which a desktop or terminal agent performs scoped reads and
    writes. A smaller Hosted VO satellite is linked to Local VO by two
    arrows: a mirror arrow going from Local VO to Hosted VO, and a queued
    intent arrow going from Hosted VO back to Local VO. Hosted VO carries a
    web MCP port through which a web agent performs scoped reads and queues
    write intent resolved against local.
  </desc>
  <defs>
    <marker id="site-system-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 Z" fill="#4B5260"/>
    </marker>
  </defs>

  <!-- Desktop / terminal agent -->
  <g>
    <rect x="60" y="20" width="180" height="60" rx="6"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.4"/>
    <text x="150" y="44" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="13" font-weight="700" fill="#15181D">Desktop / terminal agent</text>
    <text x="150" y="64" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" fill="#7A8290">CLI · IDE · on-machine tooling</text>
  </g>

  <!-- Web agent -->
  <g>
    <rect x="480" y="20" width="180" height="60" rx="6"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.4"/>
    <text x="570" y="44" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="13" font-weight="700" fill="#15181D">Web agent</text>
    <text x="570" y="64" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-family-mono="Geist Mono" fill="#7A8290">signs in on verityone.app</text>
  </g>

  <!-- Agent → MCP port arrows (top) -->
  <path d="M150,82 L150,136" stroke="#4B5260" stroke-width="1.6" fill="none"
        marker-end="url(#site-system-arrow)"/>
  <text x="160" y="108" font-family="Inter, sans-serif" font-size="11" fill="#4B5260">scoped read/write</text>

  <path d="M570,82 L570,172" stroke="#4B5260" stroke-width="1.6" fill="none"
        marker-end="url(#site-system-arrow)"/>
  <text x="580" y="122" font-family="Inter, sans-serif" font-size="11" fill="#4B5260">read / queued intent</text>

  <!-- local MCP port (attached to Local VO top edge) -->
  <g>
    <rect x="64" y="140" width="172" height="28" rx="4"
          fill="#EAEFFC" stroke="#3354D1" stroke-width="1.6"/>
    <text x="150" y="159" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="12" font-weight="700" fill="#3354D1">local MCP</text>
  </g>

  <!-- web MCP port (attached to Hosted VO top edge) -->
  <g>
    <rect x="484" y="176" width="172" height="28" rx="4"
          fill="#F1F3F6" stroke="#CDD2DA" stroke-width="1.6"/>
    <text x="570" y="195" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="12" font-weight="700" fill="#15181D">web MCP</text>
  </g>

  <!-- Local VO (central, largest) -->
  <g>
    <rect x="50" y="168" width="300" height="220" rx="8"
          fill="#FFFFFF" stroke="#3354D1" stroke-width="2"/>
    <text x="200" y="198" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="17" font-weight="700" fill="#15181D">Local VO</text>
    <text x="200" y="218" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="12" fill="#127B45">source of truth · runs on your machine</text>

    <line x1="80" y1="238" x2="320" y2="238" stroke="#E2E5EA" stroke-width="1"/>

    <text x="74" y="262" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">graph</text>
    <text x="74" y="282" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">memories</text>
    <text x="74" y="302" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">secrets</text>
    <text x="74" y="322" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">settings</text>
    <text x="74" y="342" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">authoritative state</text>

    <rect x="66" y="356" width="268" height="22" rx="3"
          fill="#E6F5ED" stroke="#127B45" stroke-width="1.1"/>
    <text x="200" y="371" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#127B45">Local authoritative — real-time writes</text>
  </g>

  <!-- Hosted VO (smaller satellite, attached to Local VO by edges) -->
  <g>
    <rect x="470" y="204" width="200" height="160" rx="8"
          fill="#FFFFFF" stroke="#CDD2DA" stroke-width="1.6"/>
    <text x="570" y="230" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="15" font-weight="700" fill="#15181D">Hosted VO</text>
    <text x="570" y="248" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" fill="#7A8290">satellite · never source of truth</text>

    <line x1="490" y1="262" x2="650" y2="262" stroke="#E2E5EA" stroke-width="1"/>

    <text x="486" y="286" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">mirror</text>
    <text x="486" y="306" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">freshness</text>
    <text x="486" y="326" font-family="Geist Mono, monospace" font-size="11" fill="#4B5260">intent queue</text>

    <rect x="480" y="336" width="180" height="22" rx="3"
          fill="#FFF5E5" stroke="#A36500" stroke-width="1.1"/>
    <text x="570" y="351" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="11" font-weight="600" fill="#A36500">Mirrored · queued intent</text>
  </g>

  <!-- mirror arrow: local → hosted (top connector) -->
  <path d="M350,250 C400,250 420,250 470,250" stroke="#4B5260"
        stroke-width="1.8" fill="none"
        marker-end="url(#site-system-arrow)"/>
  <rect x="378" y="232" width="68" height="18" rx="3" fill="#FFFFFF"
        stroke="#E2E5EA" stroke-width="1"/>
  <text x="412" y="245" text-anchor="middle" font-family="Inter, sans-serif"
        font-size="11" font-weight="600" fill="#15181D">mirror</text>

  <!-- queued intent arrow: hosted → local (bottom connector) -->
  <path d="M470,300 C420,300 400,300 350,300" stroke="#4B5260"
        stroke-width="1.8" fill="none"
        marker-end="url(#site-system-arrow)"/>
  <rect x="366" y="282" width="92" height="18" rx="3" fill="#FFFFFF"
        stroke="#E2E5EA" stroke-width="1"/>
  <text x="412" y="295" text-anchor="middle" font-family="Inter, sans-serif"
        font-size="11" font-weight="600" fill="#15181D">queued intent</text>
</svg>
`;

// ─── HTML render ────────────────────────────────────────────────────────
//
// Notes:
//   - The <style> block is a single concatenation of hosted tokens +
//     site-specific CSS. It deliberately does NOT pull in SHARED_COMPONENT_CSS,
//     so no dashboard chrome bleeds through.
//   - tokenCssBlock("hosted") is what wires the light-first palette
//     (`--bg: #F7F8FA`, `--text: #15181D`, `--accent: #3354D1`, etc).
//   - SHARED_SEAM_MARKER is embedded twice: once in the CSS comment header,
//     once visibly in the footer so the page self-identifies the style
//     seam to anyone inspecting the DOM (and tests can grep for it).

export function renderHomepage(): string {
  const tokens = tokenCssBlock("hosted");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Verity One is a reviewable knowledge graph for AI agents. It runs on your machine, exposes your graph to desktop and terminal agents over local MCP, serves web agents at verityone.app/mcp, and mirrors to hosted surfaces you can audit without giving up local authority.">
<title>Verity One — A reviewable knowledge graph for AI agents</title>
<style>${tokens}${SITE_CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="site-wrap site-header-inner">
    <a class="site-brand" href="/">Verity One<span class="site-brand-mark">vo</span></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="/start">Getting started</a>
      <a href="#how">How it works</a>
      <a href="#trust">Trust</a>
      <a href="/my">Hosted</a>
      <a href="https://github.com/markprobinson3-maker/VerityOne" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>

<main>
  <section id="hero" class="site-hero">
    <div class="site-wrap site-hero-grid">
      <div class="site-hero-copy">
        <p class="site-kicker">Verity One</p>
        <h1 class="site-hero-headline">${HERO_HEADLINE}</h1>
        <p class="site-hero-subhead">${HERO_SUBHEAD}</p>
        <div class="site-cta-row">
          <a class="site-cta site-cta-primary" href="/start">Get started</a>
          <a class="site-cta site-cta-ghost" href="#how">How it works</a>
        </div>
      </div>
      <div class="site-hero-visual">${HERO_SVG}</div>
    </div>
  </section>

  <section id="what" class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">What it is</p>
      <h2>What Verity One is</h2>
      <div class="site-prose">
        <p>Verity One is a local-first knowledge graph and memory layer for AI agents. It stores what agents learn as structured, inspectable knowledge — not opaque vectors, not scrollable transcripts — so what an agent remembers is something you can actually review, edit, and trust.</p>
        <p>It is not chat history, and it is not just embeddings. The graph has explicit structure and typed relationships. Every node carries a human-readable label, a confidence score, and provenance you can trace back to the thing that produced it.</p>
        <p>A hosted dashboard mirrors your local graph for remote visibility and control, but authority never moves off your machine. Hosted shows what is mirrored, queued, stale, or disconnected — and says so honestly when it cannot reach local.</p>
      </div>
    </div>
  </section>

  <section id="start" class="site-section site-section-soft">
    <div class="site-wrap">
      <p class="site-kicker">Quick start</p>
      <h2>Getting started</h2>
      <p class="site-lead">${QUICKSTART_INTRO}</p>
      <div class="site-paths">
        <article class="site-path">
          <h3>Dashboard-first</h3>
          <p class="site-path-caption">Install locally, then open the dashboard at <code>http://127.0.0.1:3100/dashboard</code> on your machine.</p>
          <ol class="site-steps">
            <li>Install local VO</li>
            <li>Initialize your tenant</li>
            <li>Open the local dashboard</li>
            <li>Create structure</li>
            <li>Connect hosted</li>
          </ol>
          <p class="site-path-link"><a href="/start#dashboard-first">Full onboarding: dashboard-first &rarr;</a></p>
        </article>
        <article class="site-path">
          <h3>MCP-first &mdash; desktop or terminal agent</h3>
          <p class="site-path-caption">Wire an on-machine agent over local MCP. Writes are authoritative.</p>
          <ol class="site-steps">
            <li>Install local VO</li>
            <li>Initialize your tenant</li>
            <li>Connect an agent over local MCP</li>
            <li>Verify capability scope</li>
            <li>Optionally connect hosted</li>
          </ol>
          <p class="site-path-link"><a href="http://127.0.0.1:3100/connect">Agent onboarding endpoint — local: <code>GET /connect</code> (JSON) &rarr;</a></p>
        </article>
        <article class="site-path">
          <h3>MCP-first &mdash; web agent</h3>
          <p class="site-path-caption">Connect OAuth-aware remote MCP clients to <code>https://verityone.app/mcp</code> (no trailing slash). Hosted reads mirror local state; writes are queued intent.</p>
          <ol class="site-steps">
            <li>Run <code>vo account link</code> locally to link the hosted tenant</li>
            <li>Confirm sync freshness</li>
            <li>Point a compliant MCP client at the exact <code>https://verityone.app/mcp</code> URL (no trailing slash); custom clients must send <code>Accept: application/json, text/event-stream</code></li>
            <li>Use OAuth consent, or the explicit <code>vop_REDACTED*</code> bearer fallback when OAuth transport cannot complete</li>
            <li>Review client tool permissions for write-capable queue-lifecycle tools</li>
            <li>Verify capability scope</li>
            <li>Expect stale or disconnected freshness labels when hosted cannot confirm local state</li>
            <li>Keep writes as queued intent for local to resolve</li>
          </ol>
          <p class="site-path-link"><a href="/start#mcp-web">Full onboarding: web agent &rarr;</a></p>
        </article>
      </div>
    </div>
  </section>

  <section id="use" class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">What it is good for</p>
      <h2>What you can do with it</h2>
      <div class="site-usecases">
        <article class="site-usecase">
          <h3>Research memory</h3>
          <p class="site-usecase-tag">Solo operator</p>
          <p>${USECASE_RESEARCH_BODY}</p>
        </article>
        <article class="site-usecase">
          <h3>Coding and project memory</h3>
          <p class="site-usecase-tag">Solo developer · local MCP</p>
          <p>${USECASE_CODING_BODY}</p>
        </article>
        <article class="site-usecase">
          <h3>Operations and runbook memory</h3>
          <p class="site-usecase-tag">Small operator team</p>
          <p>${USECASE_OPS_BODY}</p>
        </article>
      </div>
    </div>
  </section>

  <section id="how" class="site-section site-section-soft">
    <div class="site-wrap">
      <p class="site-kicker">System model</p>
      <h2>How it works</h2>
      <div class="site-system">
        <div class="site-system-diagram">${SYSTEM_SVG}</div>
        <div class="site-prose">
          <p><strong>Local VO</strong> runs on your machine and holds the authoritative graph, memories, secrets, and settings. Every write that arrives through the local dashboard or local MCP takes effect immediately.</p>
          <p><strong>Hosted VO</strong> is a satellite — never a source of truth. It mirrors your local graph for visibility from anywhere and queues any remote change as intent for local to resolve.</p>
          <p><strong>MCP</strong> is the protocol agents use. Local MCP writes are authoritative in real time &mdash; served on-machine for desktop and terminal agents. Web MCP runs at <code>https://verityone.app/mcp</code> with no trailing slash; web MCP writes become queued intent that local resolves, while local MCP stays authoritative.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="trust" class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">Trust model</p>
      <h2>Trust and authority</h2>
      <p class="site-trust">${TRUST_SUMMARY}</p>
      <dl class="site-authority" aria-label="Authority states">
        <dt>Local authoritative</dt>
        <dd>A write on your machine via local MCP or the local dashboard. Takes effect immediately.</dd>
        <dt>Mirrored</dt>
        <dd>A value hosted received from local and is still fresh.</dd>
        <dt>Stale</dt>
        <dd>Hosted can still reach local, but the mirrored value is older than the freshness threshold.</dd>
        <dt>Queued intent</dt>
        <dd>A change made remotely — from hosted, from web MCP, from any non-local caller. Pending local resolution.</dd>
        <dt>Applied · Rejected · Expired</dt>
        <dd>Local resolved the queued intent.</dd>
        <dt>Disconnected</dt>
        <dd>Hosted cannot currently confirm fresh state from local. It says so rather than pretending.</dd>
      </dl>
    </div>
  </section>

  <section id="more" class="site-section site-section-soft">
    <div class="site-wrap">
      <p class="site-kicker">Deeper</p>
      <h2>Explore further</h2>
      <ul class="site-links">
        <li><a href="/start">Getting started &mdash; full human onboarding guide (HTML)</a></li>
        <li><a href="/my">Hosted portal &mdash; audit from anywhere (HTML)</a></li>
        <li><a href="http://127.0.0.1:3100/dashboard">Local dashboard &mdash; opens on your local VO install (<code>http://127.0.0.1:3100/dashboard</code>, HTML)</a></li>
        <li><a href="https://github.com/markprobinson3-maker/VerityOne" rel="noopener">GitHub repository &mdash; install instructions and source</a></li>
        <li><a href="http://127.0.0.1:3100/connect"><code>GET /connect</code> &mdash; agent onboarding endpoint on your local VO install (JSON)</a></li>
        <li><a href="http://127.0.0.1:3100/schema"><code>GET /schema</code> &mdash; graph ontology on your local VO install: node types, edge types, property meanings (JSON)</a></li>
        <li><a href="http://127.0.0.1:3100/.well-known/agent"><code>GET /.well-known/agent</code> &mdash; agent discovery on your local VO install (JSON)</a></li>
      </ul>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="site-wrap">
    <p>Verity One &middot; a reviewable knowledge graph for AI agents &middot; local by default.</p>
    <p class="site-footer-meta">${SHARED_SEAM_MARKER} &middot; hosted palette</p>
  </div>
</footer>
</body>
</html>`;
}

// ─── Release channel (VO-VERCEL-RELEASE-CHANNEL-BOOTSTRAP-PR-1) ─────────
//
// One VO-controlled public release channel. The canonical source-of-
// truth files are checked in under deploy/public/ — Vercel serves
// them statically at verityone.app, AND the local API reads the
// SAME files and serves them on the same paths, so:
//
//   - the desktop VO app seam's eventual CHANNEL_LIVE flip lands on
//     real endpoints that match exactly what tests cover here
//   - local dogfooding + integration tests can exercise the same
//     contract without a network round-trip
//   - there is NO second hosted Hono app — Vercel is pure static
//     serving; the local Hono app is the only runtime renderer
//
// Both helpers read from disk at request time (tiny files, < 10KB
// combined) so a mis-edit to the canonical JSON or HTML is caught
// by the next test run rather than captured into a stale build
// artifact.

/**
 * Absolute path to the repo-root deploy/public directory where the
 * checked-in release-channel assets live. Resolved from this file's
 * own location so it keeps working whether the api package is run
 * from the monorepo root or from `api/` directly.
 */
export function resolveDeployPublicRoot(): string {
  // Vercel's @vercel/node wrapper may execute transpiled route modules as
  // CommonJS, so this helper must avoid Bun-only module-directory syntax.
  for (const root of [process.cwd(), join(process.cwd(), "..")]) {
    const candidate = join(root, "deploy", "public");
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "deploy", "public");
}

/**
 * Expected shape of the stable-channel release manifest. Kept
 * intentionally narrow — `channel` + `version` are the only
 * strictly-required fields; everything else is optional so future
 * bumps can add fields without breaking existing readers. Desktop's
 * future fetch will parse this shape (already pinned by
 * parseLatestVoVersionFromManifest in desktop/src/vo-app.ts, which
 * reads top-level `version`).
 *
 * `install` — source-install block, authoritative source-mode
 * target for ensure-current. Present today; unchanged.
 *
 * `packages` — VO-NATIVE-PACKAGING-DESIGN-PR-1 §7.2 extension.
 * List of prebuilt signed artifacts (one per platform per kind).
 * Optional; manifests without `packages[]` are source-only and
 * older readers ignore the field. This bootstrap does NOT ship
 * live packaged entries — the on-disk
 * `deploy/public/releases/stable.json` stays source-only until the
 * full signed-artifact release flow exists. The typed shape is here
 * so manifest parsing (engine side + any test fixtures) has one
 * source of truth.
 */
export interface StableReleaseManifestPackage {
  kind: "vo-cli" | "verity-one-app";
  /** Rust-style triple: `darwin-arm64`, `darwin-x64`, etc. */
  platform: string;
  /** Absolute http(s) URL to the signed artifact container. */
  artifact_url: string;
  /** Hex-encoded sha256 of the artifact container (the exact bytes
   *  served at `artifact_url`). Required — sha256 verification is
   *  non-negotiable per the design's §11.1 trust posture. */
  artifact_sha256: string;
  artifact_size_bytes?: number;
  signature: {
    kind: "apple-codesign-notarized";
    /** Informational / auditable only. The engine verifies the
     *  signer identity against a Team ID pinned in its own compiled
     *  source code, NOT against this field (which an unsigned
     *  manifest cannot be trusted to be the source of). */
    team_id?: string;
  };
}

export interface StableReleaseManifest {
  channel: string;
  version: string;
  published_at?: string;
  download_url?: string;
  notes_url?: string;
  artifacts?: Record<string, string>;
  install?: unknown;
  packages?: StableReleaseManifestPackage[];
}

export function readStableManifest(): StableReleaseManifest {
  const p = join(resolveDeployPublicRoot(), "releases", "stable.json");
  const raw = readFileSync(p, "utf-8");
  return JSON.parse(raw) as StableReleaseManifest;
}

export function readDownloadPageHtml(): string {
  const p = join(resolveDeployPublicRoot(), "download.html");
  return readFileSync(p, "utf-8");
}

// The public homepage is the hand-authored design at deploy/public/index.html
// (self-contained "vintage-codex" landing with inlined assets). Cached after the
// first read; falls back to the in-code landing generator if the file is missing
// (e.g. a fresh checkout before static assets land, or a unit-test environment).
let _homepageHtmlCache: string | null = null;
export function readHomepageHtml(): string {
  if (_homepageHtmlCache != null) return _homepageHtmlCache;
  try {
    _homepageHtmlCache = readFileSync(join(resolveDeployPublicRoot(), "index.html"), "utf-8");
  } catch {
    _homepageHtmlCache = renderHomepage();
  }
  return _homepageHtmlCache;
}

/**
 * Live authoritative stable-release manifest URL — hosted at the
 * branded download origin. The local node's `/releases/stable.json`
 * route proxies THIS file (not the embedded on-disk snapshot) so
 * the same path means the same thing in both origins:
 *
 *   hosted  → LIVE authoritative branded manifest
 *   local   → same LIVE authoritative manifest (proxied from hosted)
 *
 * The ensure-current engine also reads this URL via the
 * resolved-channel `apiUrl`. There is one authority, one URL.
 */
export const STABLE_MANIFEST_LIVE_URL = "https://download.verityone.app/releases/stable.json";

/**
 * Handler body for local `GET /releases/stable.json`.
 *
 * Fetches the live authoritative manifest from
 * `STABLE_MANIFEST_LIVE_URL` and returns those bytes. If the
 * fetch fails (network error, non-200 upstream), the route
 * returns a structured failure envelope with an explicit
 * `error_class` — it does NOT silently fall back to the embedded
 * on-disk snapshot. Inspection of the embedded snapshot lives at
 * `GET /releases/local-snapshot/stable.json`, a separately named
 * route with explicit snapshot semantics.
 *
 * The fetcher is injected so tests can exercise both the success
 * and failure paths without real network calls. Production
 * callers (api/src/index.ts) omit the dep bag and the default
 * `fetch` is used.
 */
export interface LiveManifestDeps {
  /** Replace with a fake in tests. Defaults to global fetch. */
  fetcher?: (url: string) => Promise<Response>;
  /** Override the URL in tests. Defaults to STABLE_MANIFEST_LIVE_URL. */
  liveUrl?: string;
}

/** Bound the upstream body we echo in failure envelopes so a
 *  megabyte of HTML from a misconfigured intermediary can't blow
 *  up the local response. 1 KiB is enough to diagnose upstream-
 *  error / HTML-error-page / JSON-parse failures without
 *  leaking a full body into the envelope. */
const UPSTREAM_BODY_SNIPPET_LIMIT = 1024;

const SNAPSHOT_ROUTE_HINT =
  "The local /releases/stable.json route proxies the live authoritative manifest and does NOT silently fall back to the on-disk snapshot. " +
  "If you need offline inspection, use GET /releases/local-snapshot/stable.json.";

function truncateForEnvelope(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `… [truncated; ${text.length - limit} more chars]`;
}

export async function serveLiveStableManifest(
  c: { header: (k: string, v: string) => void; json: (body: unknown, status?: number) => Response },
  deps: LiveManifestDeps = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? ((url: string) => fetch(url));
  const liveUrl = deps.liveUrl ?? STABLE_MANIFEST_LIVE_URL;
  c.header("Content-Type", "application/json; charset=utf-8");

  // Step 1: transport layer. A throw here is genuine transport
  // failure (DNS, ECONNREFUSED, TLS error, abort). Anything that
  // came back from the network, even a 5xx, does NOT throw here.
  let upstream: Response;
  try {
    upstream = await fetcher(liveUrl);
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "transport error fetching live manifest",
        authoritative_url: liveUrl,
      },
      hint: "Network / transport error fetching the live manifest. " + SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 2: read the upstream body ONCE as text. This means we
  // can echo it in failure envelopes (bounded) for diagnosis, AND
  // we never throw here on a non-JSON body — a later JSON.parse
  // decides whether the body looked like the manifest we expected.
  let rawBody: string;
  try {
    rawBody = await upstream.text();
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "upstream body read failed",
        upstream_status: upstream.status,
        authoritative_url: liveUrl,
      },
      hint: SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 3: upstream non-OK. Include the upstream body (bounded)
  // in the envelope so a curl consumer can see the real reason —
  // a Vercel 500 with a stack trace, a WAF 403 page, a 404 HTML
  // error page from an intermediary, etc. Collapsing this into
  // "upstream returned HTTP <n>" would throw away load-bearing
  // diagnostic info.
  if (!upstream.ok) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    const code = upstream.status === 500
      ? "internal_error"
      : upstream.status === 501
        ? "not_implemented"
        : upstream.status === 502
          ? "bad_gateway"
          : upstream.status >= 500
            ? "service_unavailable"
            : "bad_gateway";
    return errorJson(c as unknown as Context, code, {
      message: "live_manifest_unavailable",
      details: {
        detail: `upstream returned HTTP ${upstream.status}`,
        upstream_status: upstream.status,
        upstream_body: truncateForEnvelope(rawBody, UPSTREAM_BODY_SNIPPET_LIMIT),
        authoritative_url: liveUrl,
      },
      hint: SNAPSHOT_ROUTE_HINT,
    });
  }

  // Step 4: upstream 2xx. Parse the body as JSON. If it isn't
  // JSON (HTML error page returned with a 200 by an intermediary,
  // a proxy that rewrote the body, cache poisoning, whatever),
  // fail honestly with the parse error + a snippet of the body
  // — do NOT throw through to the transport-error path, which
  // would misclassify a content-type failure as a network
  // failure and lose the body entirely.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    c.header("X-Manifest-Source", "live-authoritative-failed");
    return errorJson(c as unknown as Context, "bad_gateway", {
      message: "live_manifest_unavailable",
      details: {
        detail: "upstream 2xx body was not valid JSON",
        upstream_status: upstream.status,
        upstream_body: truncateForEnvelope(rawBody, UPSTREAM_BODY_SNIPPET_LIMIT),
        authoritative_url: liveUrl,
      },
      hint:
        "The upstream returned a successful status but a body that didn't parse as JSON. " +
        "An intermediary, cache, or WAF may be rewriting the response. " +
        SNAPSHOT_ROUTE_HINT,
    });
  }

  c.header("X-Manifest-Source", "live-authoritative");
  c.header("X-Manifest-Authoritative-Url", liveUrl);
  return c.json(parsed);
}

/**
 * Handler body for local `GET /releases/local-snapshot/stable.json`.
 *
 * Returns the embedded `deploy/public/releases/stable.json` bytes
 * at the tenant's install sha. Distinct route, distinct semantics:
 * this is for dev / dogfood / offline inspection only. The route
 * is explicitly named `local-snapshot` so no URL consumer can
 * mistake it for the authority.
 *
 * Ships explicit honesty headers:
 *   X-Manifest-Source: local-snapshot
 *   X-Manifest-Authoritative-Url: <STABLE_MANIFEST_LIVE_URL>
 */
export function serveLocalSnapshotStableManifest(c: {
  header: (k: string, v: string) => void;
  json: (body: unknown) => Response;
}): Response {
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("X-Manifest-Source", "local-snapshot");
  c.header("X-Manifest-Authoritative-Url", STABLE_MANIFEST_LIVE_URL);
  return c.json(readStableManifest());
}

// ─── Hosted /my placeholder (VO-VERCEL-RELEASE-CHANNEL-BOOTSTRAP-PR-1) ──
//
// Both the homepage and the /start onboarding page link to `/my` as the
// hosted portal. On the local API that route is mounted (portal-web.ts)
// and signed-in users see the real portal; on verityone.app it is NOT
// deployed by this PR (no DB, no auth, no full runtime on Vercel).
//
// Rather than strip the links from the public site, we reserve the
// route with an honest static holding page generated by this function
// and written to `deploy/public/my/index.html` by
// `deploy/scripts/prerender.ts`. A visitor who follows a /my link from
// the homepage lands on an explicit explanation of the current state,
// not a 404 and not a fake sign-in.
//
// The page deliberately exposes no auth form, no Google sign-in button,
// no hosted dashboard chrome, no tenant picker — nothing that would
// imply the hosted portal is live. It names the deferred pieces by
// name (Google sign-in, tenant portal) so the copy cannot be read as
// "about to work, just loading."

export function renderMyPlaceholder(): string {
  const tokens = tokenCssBlock("hosted");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="The hosted portal at verityone.app/my is not live yet. Google sign-in and the tenant portal are later-phase work. Today, verityone.app serves the public site and the release channel; the interactive surface is the local dashboard on your own machine.">
<title>Verity One — Hosted portal (not live yet)</title>
<style>${tokens}${SITE_CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="site-wrap site-header-inner">
    <a class="site-brand" href="/">Verity One<span class="site-brand-mark">vo</span></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="/start">Getting started</a>
      <a href="/#how">How it works</a>
      <a href="/#trust">Trust</a>
      <a href="/my" aria-current="page">Hosted</a>
      <a href="https://github.com/markprobinson3-maker/VerityOne" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>

<main>
  <section class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">Hosted portal</p>
      <h1><code>/my</code> &mdash; not live yet</h1>
      <div class="site-prose">
        <p><strong>The hosted portal is not live yet.</strong> This URL
        is reserved so that homepage and <a href="/start"><code>/start</code></a>
        links resolve, but there is no sign-in here, no account, no
        hosted dashboard. Nothing on this page is a working feature.</p>
        <p>The pieces that will eventually live here &mdash; <strong>Google
        sign-in</strong>, the <strong>tenant portal</strong>, the hosted
        audit surface, and the queued-intent inbox &mdash; are explicitly
        later-phase work. They depend on the full Verity One runtime
        (database, auth, workers), which this bootstrap deploy does not
        expose and will not pretend to expose.</p>
      </div>
    </div>
  </section>

  <section class="site-section site-section-soft">
    <div class="site-wrap">
      <p class="site-kicker">What works today</p>
      <h2>Use these instead</h2>
      <dl class="site-authority" aria-label="What is live today on verityone.app">
        <dt>Local dashboard</dt>
        <dd>Runs on your own machine at
          <a href="http://127.0.0.1:3100/dashboard"><code>http://127.0.0.1:3100/dashboard</code></a>
          once you have installed Verity One. This is the interactive
          surface today &mdash; it is not on <code>verityone.app</code>,
          and your local node stays authoritative.</dd>
        <dt>Install &amp; update</dt>
        <dd><a href="https://download.verityone.app/">download.verityone.app</a>
          is the canonical install and update origin. The apex
          <a href="/download">/download</a> page remains a compatibility
          landing page, and the mirrored apex manifest is at
          <a href="/releases/stable.json"><code>/releases/stable.json</code></a>.</dd>
        <dt>Public site</dt>
        <dd><a href="/">verityone.app/</a> and
          <a href="/start">verityone.app/start</a> explain the product
          and the three onboarding paths. They are static pages; they
          do not require sign-in.</dd>
      </dl>
    </div>
  </section>

  <section class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">Why a placeholder</p>
      <h2>Honest route reservation</h2>
      <div class="site-prose">
        <p>Every link from the homepage and <code>/start</code> to
        <code>/my</code> is intentional &mdash; <code>/my</code> is where
        the hosted portal will live when it ships. For this bootstrap PR
        the route is reserved with this holding page so that:</p>
        <ul class="site-steps" style="list-style: disc;">
          <li>No public link 404s on <code>verityone.app</code>.</li>
          <li>Visitors see the state named honestly, not a mystery
            blank page or a fake sign-in.</li>
          <li>When the hosted portal PR lands, the route swap is a
            single file replacement &mdash; no copy on the homepage
            or <code>/start</code> has to change.</li>
        </ul>
      </div>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="site-wrap">
    <p>Verity One &middot; hosted portal &middot; later-phase work.</p>
    <p class="site-footer-meta">${SHARED_SEAM_MARKER} &middot; hosted palette &middot; /my (placeholder)</p>
  </div>
</footer>
</body>
</html>`;
}
