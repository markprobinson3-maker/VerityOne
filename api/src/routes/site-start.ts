/**
 * Public human onboarding page — VO-WEB-MCP-HOMEPAGE-ONBOARDING-PR-1
 *
 * Seam for the new dedicated human onboarding route:
 *   GET /start → renderStartPage()
 *
 * /start is unconditionally HTML — it is the canonical human onboarding
 * surface. Machine callers keep going to /connect (JSON) and /schema
 * (JSON); those contracts are not touched by this module and are not
 * proxied through /start. The homepage (/ content-negotiated) is the
 * entry point; /start is where a human clicks from there.
 *
 * Pure function only. No Hono app, no side effects. index.ts mounts a
 * thin GET /start handler that just returns c.html(renderStartPage()).
 *
 * Visual language:
 *   - Reuses tokenCssBlock("hosted") + SHARED_SEAM_MARKER + the
 *     SITE_CSS vocabulary from site.ts so the onboarding page feels
 *     like the next page after the homepage, not a second product.
 *   - Does NOT import SHARED_COMPONENT_CSS (dashboard grammar) or
 *     authorityBadge helpers — the public site surface has its own
 *     layout vocabulary (site-*), which is load-bearing.
 *
 * Information architecture (spec order):
 *   1. Start here / choose your path      #choose
 *   2. Shortest safe path (canonical)     #shortest
 *   3. Dashboard-first path                #dashboard-first
 *   4. MCP-first — desktop/terminal        #mcp-desktop
 *   5. MCP-first — web agent               #mcp-web
 *   6. Trust and authority                 #trust
 *   7. Real next links / references        #next
 *
 * VO-TENANT-DEFAULT-QUICKSTART-PR-1: /start is the long-form
 * authority for the tenant-default first-run sequence. Every shorter
 * surface (installer next_steps, cli help novice-first block,
 * /download next-step ladder, portal-web MCP card, mcp/README
 * Preferred-path block, docs/VO-ONE-COMMAND-TENANT-QUICKSTART.md)
 * must teach the SAME phase ordering and the SAME optional/required
 * boundaries as the #shortest block here. Drift guards live in
 * `site-start.test.ts`.
 */

import { tokenCssBlock, SHARED_SEAM_MARKER } from "../lib/ui-style";
import { SITE_CSS } from "./site";

// ─── Copy constants ─────────────────────────────────────────────────────
//
// Kept at module top so word budgets are auditable in one place.
//
// Word-budget audit (intro ≤ 30, trust summary ≤ 100):
//   - START_INTRO: 27 words ✓
//   - START_TRUST: 49 words ✓ (mirrors site.ts TRUST_SUMMARY)

const START_INTRO =
  "Pick a path by who is connecting: a human at the local dashboard, " +
  "a desktop or terminal agent over local MCP, or a web agent on verityone.app.";

const START_TRUST =
  "Your local node is the only source of truth. " +
  "Hosted state, web-MCP writes, and any change made remotely become queued intent that local then applies, rejects, or lets expire. " +
  "Only local MCP writes are authoritative in real time. " +
  "When hosted cannot reach local it says so rather than pretending.";

// ─── /start-specific CSS extras ─────────────────────────────────────────
//
// Reuses SITE_CSS wholesale (site-header, site-nav, site-section,
// site-prose, site-paths, site-path, site-steps, site-authority,
// site-links, site-footer, kicker/lead rhythm, responsive breakpoints).
// This block only adds vocabulary specific to the onboarding page:
//
//   - .start-tabs — the "Start here" tri-card quick chooser at the top
//   - .start-path-body — the full step-by-step section per path
//   - .start-inline-refs — a structured key/value reference strip
//   - .start-path-kind — the small "HTML", "JSON", "local origin" tags
//     that make representation honest inside prose (so human/machine
//     links are not visually ambiguous)

const START_SHORTEST_INTRO =
  "The shortest safe tenant-default first-run path, in phase order. " +
  "Every other surface in the product summarizes this same sequence — " +
  "the three paths below pick a subset depending on whether you want " +
  "the dashboard, an on-machine MCP agent, or both.";

const SITE_START_CSS = `
/* ── ${SHARED_SEAM_MARKER} :: /start onboarding page extras ── */

/* Active nav state for the onboarding page */
.site-nav a[aria-current="page"] {
  color: var(--text);
  background: var(--bg-secondary);
}

/* Tri-card chooser at top of #choose */
.start-tabs {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
  margin-top: 1rem;
}
.start-tab {
  display: flex; flex-direction: column; gap: .45rem;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.15rem 1.2rem;
  color: var(--text); text-decoration: none;
}
.start-tab:hover {
  border-color: var(--text-secondary); text-decoration: none;
}
.start-tab h3 {
  font-size: 1rem; font-weight: 600; color: var(--text); margin: 0;
}
.start-tab p {
  font-size: .88rem; color: var(--text-secondary); line-height: 1.55; margin: 0;
}
.start-tab-kind {
  font-size: .68rem; font-weight: 600; letter-spacing: .1em;
  text-transform: uppercase; color: var(--text-muted);
}

/* Canonical-sequence phase block (#shortest) */
.start-phase {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.15rem;
  margin: 0.65rem 0;
}
.start-phase h3 {
  font-size: .98rem; font-weight: 600; color: var(--text);
  margin: 0 0 .3rem; display: flex; align-items: baseline; gap: .55rem;
}
.start-phase h3 .start-phase-id {
  font-size: .7rem; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
  color: var(--accent);
}
.start-phase p.start-phase-why {
  font-size: .86rem; color: var(--text-secondary);
  margin: 0 0 .45rem; line-height: 1.5;
}
.start-phase ol, .start-phase ul {
  padding-left: 1.2rem; margin: .2rem 0; max-width: 70ch;
}
.start-phase li {
  font-size: .9rem; color: var(--text-secondary); line-height: 1.6;
  margin-bottom: .15rem;
}
.start-phase code {
  font-size: .84rem;
}
.start-phase-optional {
  border-style: dashed;
}

/* Per-path body section */
.start-path-body h3 {
  font-size: 1.02rem; font-weight: 600; color: var(--text);
  margin: 1.25rem 0 .35rem;
}
.start-path-body p, .start-path-body li {
  font-size: .95rem; color: var(--text-secondary); line-height: 1.65;
}
.start-path-body ol, .start-path-body ul {
  padding-left: 1.25rem; margin-bottom: 1rem; max-width: 70ch;
}
.start-path-body li { margin-bottom: .2rem; }
.start-path-body .site-prose p {
  color: var(--text-secondary);
}

/* Inline reference strip (label + link) */
.start-inline-refs {
  display: grid; grid-template-columns: minmax(170px, auto) 1fr;
  gap: .4rem 1rem; margin: 1rem 0 .25rem;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1rem 1.1rem;
  font-size: .9rem;
}
.start-inline-refs dt {
  font-weight: 600; color: var(--text);
}
.start-inline-refs dd {
  color: var(--text-secondary);
}

/* Representation-honesty tag after a link label */
.start-kind {
  display: inline-block;
  margin-left: .35rem;
  font-size: .68rem; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase;
  padding: .08rem .45rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  background: var(--bg-secondary);
  font-family: var(--font-mono);
}

/* Responsive */
@media (max-width: 880px) {
  .start-tabs { grid-template-columns: 1fr; }
  .start-inline-refs { grid-template-columns: 1fr; }
}
`;

// ─── HTML render ────────────────────────────────────────────────────────

export function renderStartPage(): string {
  const tokens = tokenCssBlock("hosted");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Verity One onboarding for humans: pick the dashboard-first, local-MCP, or web-MCP path. Web agents connect at verityone.app/mcp; remote writes become queued intent for local to resolve. Local runs on your machine and stays authoritative.">
<title>Verity One — Getting started</title>
<style>${tokens}${SITE_CSS}${SITE_START_CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="site-wrap site-header-inner">
    <a class="site-brand" href="/">Verity One<span class="site-brand-mark">vo</span></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="/start" aria-current="page">Getting started</a>
      <a href="/#how">How it works</a>
      <a href="#trust">Trust</a>
      <a href="/my">Hosted</a>
      <a href="https://github.com/markprobinson3-maker/VerityOne" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>

<main>
  <section id="choose" class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">Get started</p>
      <h1>Choose your path</h1>
      <p class="site-lead">${START_INTRO}</p>
      <div class="start-tabs">
        <a class="start-tab" href="#dashboard-first">
          <span class="start-tab-kind">Human</span>
          <h3>Dashboard-first</h3>
          <p>Install Verity One on your machine and open the local dashboard.</p>
        </a>
        <a class="start-tab" href="#mcp-desktop">
          <span class="start-tab-kind">On-machine agent</span>
          <h3>Local MCP</h3>
          <p>Wire a desktop or terminal agent over local MCP. Authoritative in real time.</p>
        </a>
        <a class="start-tab" href="#mcp-web">
          <span class="start-tab-kind">Web agent &middot; hosted mirror</span>
          <h3>verityone.app</h3>
          <p>Connect remote MCP clients to <code>https://verityone.app/mcp</code> with no trailing slash. Hosted reads mirror local state; writes are queued intent.</p>
        </a>
      </div>
      <p class="site-prose" style="margin-top:1.25rem"><strong>If you prefer the command-list view</strong> of every step, skip to <a href="#shortest">the shortest safe path</a> below. Every shorter surface in the product (CLI help, installer next-steps, <code>/download</code>, the hosted connect card, the mcp/ README, the quickstart doc) summarizes that same sequence.</p>
    </div>
  </section>

  <section id="shortest" class="site-section site-section-soft">
    <div class="site-wrap start-path-body">
      <p class="site-kicker">Canonical &middot; phase order</p>
      <h2>Shortest safe path</h2>
      <div class="site-prose">
        <p>${START_SHORTEST_INTRO}</p>
        <p>Source-install today &mdash; no packaged installer, no self-update, no auto-update. Two things the install bootstrap deliberately does <em>not</em> do for you: run <code>bun run db:reset</code>, and build the <code>mcp/</code> package. Those are named as manual steps below rather than hidden.</p>
      </div>

      <div class="start-phase">
        <h3><span class="start-phase-id">Phase A</span> Ensure current bytes</h3>
        <p class="start-phase-why">Produce a <strong>managed install</strong> at <code>~/verity-one</code> &mdash; one that writes <code>.vo-install.json</code> and can later be updated in place by <code>vo install</code> / <code>vo update</code>. <code>vo</code> is a repo-local CLI (the repo does not yet ship a packaged binary on <code>$PATH</code>), so a brand-new tenant runs the managed installer from a disposable bootstrap clone exactly once; a returning tenant who already has <code>vo</code> wired just runs <code>vo install</code>.</p>

        <h4 style="font-size:.9rem;margin:.7rem 0 .3rem;color:var(--text)">First time on this machine (no <code>vo</code> yet)</h4>
        <p class="site-prose" style="font-size:.86rem;margin:.15rem 0 .5rem;color:var(--text-secondary)">This path is the managed ensure-current flow. It creates a real managed install at <code>~/verity-one</code> (with the <code>.vo-install.json</code> marker) that future <code>vo install</code> / <code>vo update</code> runs recognize. The bootstrap clone is <strong>disposable</strong> &mdash; it is only used to invoke the installer once, and can be deleted after step 3.</p>
        <ol>
          <li>Clone the repo into a disposable location. The bootstrap clone tracks current <code>main</code> &mdash; it is only used to run the installer once, and is deleted in step 4. The <em>installed</em> bytes at <code>~/verity-one</code> are pinned by the stable manifest (<code>install.source_ref</code>), not by this clone, so the bootstrap tool just needs a recent enough main to have <code>vo install</code>:
<pre><code>git clone https://github.com/markprobinson3-maker/VerityOne.git /tmp/vo-bootstrap
cd /tmp/vo-bootstrap
bun install</code></pre>
          </li>
          <li>Run the managed installer into <code>~/verity-one</code>. The ensure-current engine clones the manifest-pinned release, runs the manifest's bootstrap steps, and writes the managed-install marker (<code>.vo-install.json</code>) so the lifecycle can manage this directory from here on:
<pre><code>bun run /tmp/vo-bootstrap/agent-lab/scripts/vo-cli.ts install --install-root ~/verity-one</code></pre>
          </li>
          <li>Alias <code>vo</code> to the <em>managed install</em>'s <code>vo-cli.ts</code> (not the disposable bootstrap clone). Pick one:
<pre><code># Shell alias (survives this session; add to ~/.zshrc or ~/.bashrc to keep):
alias vo='bun run ~/verity-one/agent-lab/scripts/vo-cli.ts'

# OR: symlink a launcher onto ~/.local/bin (make sure that dir is on $PATH):
mkdir -p ~/.local/bin
cat &gt; ~/.local/bin/vo &lt;&lt;'EOF'
#!/usr/bin/env bash
exec bun run ~/verity-one/agent-lab/scripts/vo-cli.ts "$@"
EOF
chmod +x ~/.local/bin/vo</code></pre>
          </li>
          <li>Confirm the shim resolves, then delete the disposable bootstrap clone:
<pre><code>vo --help | head -3
rm -rf /tmp/vo-bootstrap</code></pre>
          </li>
        </ol>
        <p class="site-prose" style="font-size:.86rem;margin:.4rem 0 .7rem;color:var(--text-secondary)">If you would rather not alias, every <code>vo &lt;subcommand&gt;</code> in Phases B&ndash;E works verbatim as <code>bun run ~/verity-one/agent-lab/scripts/vo-cli.ts &lt;subcommand&gt;</code>.</p>

        <h4 style="font-size:.9rem;margin:.7rem 0 .3rem;color:var(--text)">Returning tenant (<code>vo</code> already works)</h4>
        <ol>
          <li><code>vo install --install-root ~/verity-one</code> &nbsp;<em>(or <code>vo update --install-root ~/verity-one</code> &mdash; same unified flow; the engine inspects the install root and decides install / update / already_current / refused from what it finds)</em></li>
        </ol>

        <h4 style="font-size:.9rem;margin:.7rem 0 .3rem;color:var(--text)">Developer escape hatch (plain checkout, NOT a managed install)</h4>
        <p class="site-prose" style="font-size:.86rem;margin:.15rem 0 0;color:var(--text-secondary)">If you are working on VO itself and want a writable clone rather than a managed install, <code>git clone</code> the repo wherever you like and run commands via <code>bun run &lt;clone&gt;/agent-lab/scripts/vo-cli.ts &lt;sub&gt;</code>. A plain checkout is <strong>not</strong> a managed install &mdash; it has no <code>.vo-install.json</code> marker, so <code>vo install --install-root &lt;that-clone&gt;</code> and <code>vo update --install-root &lt;that-clone&gt;</code> will refuse with <code>install_root_unmanaged_git</code>. This is intentional: the developer path opts out of the managed lifecycle. Use it for VO development, not tenant-default first-run.</p>
      </div>

      <div class="start-phase">
        <h3><span class="start-phase-id">Phase B</span> Initialize local tenant + verify health <em>(required for any VO use)</em></h3>
        <p class="start-phase-why">Bootstrap the local DB, register your tenant identity, then confirm the stack is healthy before layering MCP or LLM tasks on top.</p>
        <p class="start-phase-why" style="background:#fff7e6;border-left:3px solid #d97706;padding:.5rem .75rem;margin:.5rem 0;font-size:.85rem"><strong>Embedding-provider key required before <code>db:reset</code>.</strong> F7 makes <code>nodes.embedding_hv</code> <code>NOT NULL</code>. <code>db:reset</code> runs the F7 backfill against seed nodes via the Gemini embedding API. Export <code>OPENCLAW_GOOGLE_API_KEY</code> (or <code>GOOGLE_API_KEY</code>) before this step, or the backfill refuses to run and the NOT NULL migration aborts &mdash; there is no zero-vector fallback.</p>
        <ol>
          <li><code>export OPENCLAW_GOOGLE_API_KEY=...</code> &nbsp;<em>(required before <code>db:reset</code>; no placeholder fallback)</em></li>
          <li><code>cd ~/verity-one &amp;&amp; bun run db:reset</code> &nbsp;<em>(one-time &mdash; DB setup is intentionally separate from install)</em></li>
          <li><code>vo init --tenant &lt;your-id&gt; --token &lt;your-token&gt;</code> &nbsp;<em>(token from your VO operator)</em></li>
          <li><code>vo doctor</code> &nbsp;<em>(local node + auth health; must pass before continuing)</em></li>
        </ol>
      </div>

      <div class="start-phase start-phase-optional">
        <h3><span class="start-phase-id">Phase C</span> Optional: wire a local MCP agent</h3>
        <p class="start-phase-why">Skip if you only want the dashboard. Must run <strong>after</strong> <code>vo init</code> &mdash; the installed MCP server reads your tenant token from <code>~/.vo/config.json</code>, not env. Independent of <code>vo onboard</code> (MCP does not need an LLM key). The source-install bootstrap does NOT build <code>mcp/</code>, so the first two lines are manual today. Commands use the absolute install-root path (<code>~/verity-one/mcp</code>) so they work from any shell cwd.</p>
        <ol>
          <li><code>bun install --cwd ~/verity-one/mcp</code></li>
          <li><code>bun run --cwd ~/verity-one/mcp build</code></li>
          <li><code>vo mcp install --client &lt;claude-desktop|codex|generic&gt;</code> &nbsp;<em>(supported: claude-desktop, codex, generic &mdash; codex emits a pasteable <code>[mcp_servers.verity-one]</code> TOML block for <code>~/.codex/config.toml</code>; cursor/zed are refused honestly)</em></li>
          <li><code>vo mcp doctor</code> &nbsp;<em>(validates the installed <code>~/.vo/mcp/</code> copy; distinct from <code>vo doctor</code>)</em></li>
        </ol>
      </div>

      <div class="start-phase start-phase-optional">
        <h3><span class="start-phase-id">Phase D</span> Optional: enable LLM-backed tasks <em>(required before Phase E)</em></h3>
        <p class="start-phase-why">Skip if you only want basic tenant setup or MCP wiring. <strong>Required</strong> before <code>vo vault harvest --auto</code> runs &mdash; harvest calls into the configured LLM provider for its extraction stages. <code>vo onboard</code> is NOT a prerequisite for <code>vo init</code> or <code>vo mcp install</code>.</p>
        <ol>
          <li><code>vo onboard</code> &nbsp;<em>(stores your provider key locally, picks recommended models)</em></li>
          <li><code>vo onboard-status</code> &nbsp;<em>(confirm provider/models/secrets are set)</em></li>
        </ol>
      </div>

      <div class="start-phase start-phase-optional">
        <h3><span class="start-phase-id">Phase E</span> Optional: first vault + first harvest <em>(requires Phase D)</em></h3>
        <p class="start-phase-why">Create a VO vault on disk and run the end-to-end harvest pipeline on one source. Produces a capture, atomized assertions, a dossier, and a graph write &mdash; all local.</p>
        <ol>
          <li><code>vo vault init --root ~/knowledge --tenant &lt;your-id&gt;</code></li>
          <li><code>vo vault harvest --auto --root ~/knowledge path/to/source.md</code></li>
        </ol>
      </div>

      <dl class="start-inline-refs">
        <dt>Required for any VO use</dt>
        <dd>Phases A + B.</dd>
        <dt>Required to wire a desktop/terminal MCP agent</dt>
        <dd>Phases A + B + C.</dd>
        <dt>Required to run the first harvest</dt>
        <dd>Phases A + B + D + E. <strong>Phase D is mandatory</strong> before harvest &mdash; without an LLM provider configured, harvest stops at its extraction stages.</dd>
        <dt>Later-phase / optional follow-ups</dt>
        <dd><code>vo account link</code>, <code>vo sync push</code>, and the hosted portal at <a href="/my"><code>/my</code></a>. None of these are part of the shortest local-first path.</dd>
      </dl>
    </div>
  </section>

  <section id="dashboard-first" class="site-section">
    <div class="site-wrap start-path-body">
      <p class="site-kicker">Path 1 &middot; human</p>
      <h2>Dashboard-first: local install and local dashboard</h2>
      <div class="site-prose">
        <p>This is the path for a person who wants to try Verity One on their own machine. You install Verity One locally, initialize your tenant, and open the dashboard in your browser. The dashboard runs on your local VO install, not on <code>verityone.app</code>.</p>
        <p>Subset of the canonical ladder above: <strong>Phase A</strong> (ensure bytes) + <strong>Phase B</strong> (db reset + <code>vo init</code> + <code>vo doctor</code>), then open the dashboard. Phases C / D / E are optional additions you can layer on later.</p>
      </div>
      <h3>Steps</h3>
      <ol>
        <li>Ensure current source bytes: <code>vo install --install-root ~/verity-one</code> (or <code>vo update</code> &mdash; same unified flow). The GitHub <a href="https://github.com/markprobinson3-maker/VerityOne#readme" rel="noopener">README<span class="start-kind">Source ref</span></a> is the developer/package reference; it is no longer the canonical human onboarding brain.</li>
        <li>Export your embedding-provider key (F7 prerequisite): <code>export OPENCLAW_GOOGLE_API_KEY=...</code>. <code>db:reset</code> calls Gemini to embed seed nodes; without the key it stops before the NOT NULL migration.</li>
        <li>One-time database setup: <code>cd ~/verity-one &amp;&amp; bun run db:reset</code>. The install bootstrap intentionally leaves this to you.</li>
        <li>Initialize your tenant: <code>vo init --tenant &lt;your-id&gt; --token &lt;your-token&gt;</code>. Your token is provided by the VO operator.</li>
        <li>Verify local health: <code>vo doctor</code>. Must pass before the dashboard is useful.</li>
        <li>Open the local dashboard at <a href="http://127.0.0.1:3100/dashboard"><code>http://127.0.0.1:3100/dashboard</code><span class="start-kind">Local origin &middot; HTML</span></a>. This opens on your own machine &mdash; not on <code>verityone.app</code>.</li>
        <li>Create structure, save memories, and explore the graph.</li>
        <li>Optionally link a hosted mirror at <a href="/my"><code>/my</code><span class="start-kind">Hosted &middot; HTML</span></a> for audit from anywhere. <em>Not part of the shortest local-first path.</em></li>
      </ol>
      <dl class="start-inline-refs">
        <dt>Install reference</dt>
        <dd><code>vo install</code> / <code>vo update</code> (unified). GitHub <a href="https://github.com/markprobinson3-maker/VerityOne#readme" rel="noopener">README</a> stays the source-code reference, not the canonical human onboarding flow.</dd>
        <dt>Local dashboard</dt>
        <dd><a href="http://127.0.0.1:3100/dashboard"><code>http://127.0.0.1:3100/dashboard</code></a> &mdash; opens on your local VO install.</dd>
        <dt>Authority</dt>
        <dd>Local writes are authoritative. The dashboard speaks to your local node directly.</dd>
      </dl>
    </div>
  </section>

  <section id="mcp-desktop" class="site-section site-section-soft">
    <div class="site-wrap start-path-body">
      <p class="site-kicker">Path 2 &middot; on-machine agent</p>
      <h2>MCP-first: desktop or terminal agent over local MCP</h2>
      <div class="site-prose">
        <p>This is the path for wiring an on-machine agent &mdash; a coding agent in your terminal, a desktop assistant, any runtime that already lives on the same machine as your local VO install. The agent speaks to local MCP. <strong>Local MCP writes are authoritative in real time.</strong> There is no queued-intent round-trip; the graph updates immediately.</p>
        <p>Subset of the canonical ladder: <strong>Phases A + B + C</strong>. Phase D (<code>vo onboard</code>) is optional for MCP &mdash; the MCP server itself does not need an LLM key; individual agent tools that call out to an LLM do. If you will also harvest vault sources, continue into Phases D + E.</p>
      </div>
      <h3>Steps</h3>
      <ol>
        <li>Ensure current bytes: <code>vo install --install-root ~/verity-one</code> (or <code>vo update</code>).</li>
        <li>Export your embedding-provider key first (F7 prerequisite): <code>export OPENCLAW_GOOGLE_API_KEY=...</code>.</li>
        <li>One-time DB setup: <code>cd ~/verity-one &amp;&amp; bun run db:reset</code>.</li>
        <li>Initialize your tenant so the agent has an identity bound to your local node: <code>vo init --tenant &lt;your-id&gt; --token &lt;your-token&gt;</code>.</li>
        <li>Verify local VO health: <code>vo doctor</code>.</li>
        <li>Build the MCP package (manual today &mdash; the source installer does not yet build <code>mcp/</code>; the absolute install-root path makes this command self-contained regardless of your shell cwd): <code>bun install --cwd ~/verity-one/mcp &amp;&amp; bun run --cwd ~/verity-one/mcp build</code>.</li>
        <li>Install the MCP server into your client's config: <code>vo mcp install --client &lt;claude-desktop|codex|generic&gt;</code>. <em>Must follow <code>vo init</code>.</em> Supported clients: <code>claude-desktop</code>, <code>codex</code>, <code>generic</code>; <code>cursor</code> / <code>zed</code> are refused honestly &mdash; use <code>generic</code> and paste the printed JSON block. <code>codex</code> prints a pasteable <code>[mcp_servers.verity-one]</code> TOML block for <code>~/.codex/config.toml</code>; the CLI installer does not write that file itself. Use the local dashboard's Codex MCP action if you want the parser-backed automated merge.</li>
        <li>Verify the installed MCP stdio path: <code>vo mcp doctor</code>. Distinct from <code>vo doctor</code> &mdash; this spawns <code>~/.vo/mcp/dist/server.js</code> and runs the 4-step MCP handshake end-to-end.</li>
        <li>Machine callers can also introspect the local node directly at <a href="http://127.0.0.1:3100/connect"><code>GET /connect</code><span class="start-kind">Local endpoint &middot; JSON</span></a> (bootstrap) and <a href="http://127.0.0.1:3100/schema"><code>GET /schema</code><span class="start-kind">Local endpoint &middot; JSON</span></a> (ontology). Both return JSON &mdash; not human pages.</li>
        <li>Optionally connect a hosted mirror at <a href="/my"><code>/my</code><span class="start-kind">Hosted &middot; HTML</span></a> for audit from another device. <em>Not part of the shortest local-first path.</em></li>
      </ol>
      <dl class="start-inline-refs">
        <dt>MCP install reference</dt>
        <dd><code>vo mcp install</code> / <code>vo mcp doctor</code> are thin wrappers over the <code>mcp/</code> package. The standalone <code>vo-mcp</code> binary still works and produces the same <code>~/.vo/mcp/</code> layout.</dd>
        <dt>Agent onboarding endpoint</dt>
        <dd><a href="http://127.0.0.1:3100/connect"><code>GET /connect</code></a> on your local VO install &mdash; machine onboarding payload (JSON endpoint; not a human page).</dd>
        <dt>Graph ontology endpoint</dt>
        <dd><a href="http://127.0.0.1:3100/schema"><code>GET /schema</code></a> on your local VO install &mdash; node types, edge types, property meanings (JSON endpoint).</dd>
        <dt>Authority</dt>
        <dd>Authoritative in real time. The agent reads and writes the live local graph.</dd>
      </dl>
    </div>
  </section>

  <section id="mcp-web" class="site-section">
    <div class="site-wrap start-path-body">
      <p class="site-kicker">Path 3 &middot; web agent &middot; hosted mirror</p>
      <h2>MCP-first: web agent on verityone.app</h2>
      <div class="site-prose">
        <p>Use this path for remote MCP clients after local VO exists. Bind the hosted account to local by running <code>vo account link</code> from the local install, then remote MCP clients connect to the exact <code>https://verityone.app/mcp</code> URL with no trailing slash; the hosted mirror serves reads, and <strong>writes become queued intent</strong> that your local node applies, rejects, or lets expire.</p>
        <p>Local MCP remains the fastest authoritative path for on-machine agents. Hosted web MCP is for agents that run off your machine and need the mirrored cloud surface. Hosted is not a second source of truth.</p>
      </div>
      <h3>What to expect</h3>
      <ol>
        <li>Run <code>vo account link</code> on your local VO install and complete the hosted sign-in/link prompt; local remains authoritative.</li>
        <li>Confirm sync freshness before trusting hosted reads.</li>
        <li>Point an OAuth-aware MCP client at the exact <code>https://verityone.app/mcp</code> URL with no trailing slash; the client discovers <code>/oauth/authorize</code> for PKCE consent. Custom clients must send <code>Accept: application/json, text/event-stream</code>. Use a <code>vop_REDACTED*</code> bearer credential only as the explicit fallback for clients whose OAuth transport cannot complete reliably.</li>
        <li>In the client connector settings, review the tool approval policy. Client UI wording varies by vendor; Verity One cannot set that client-side default from the MCP server. Read-only tools, including <code>vo_commands_get</code>, can use lower-friction approval in a trusted client. Keep write-capable queue-lifecycle tools like <code>vo_write_intent</code> and <code>vo_commands_cancel</code> on per-call approval unless the tenant intentionally wants agents to queue or withdraw intents without another client-side prompt.</li>
        <li>Verify capability scope the same way you would for a local agent.</li>
        <li>Mirrored values may be marked <strong>stale</strong> or <strong>disconnected</strong> when hosted cannot confirm fresh state from local.</li>
      </ol>
      <dl class="start-inline-refs">
        <dt>Status today</dt>
        <dd><strong>Same-origin connector shipped.</strong> Use <code>https://verityone.app/mcp</code> with no trailing slash. The <code>mcp.verityone.app</code> alias is not shipped.</dd>
        <dt>Web MCP tool permissions</dt>
        <dd>The MCP client owns tool-approval UX and wording. Verity One advertises read-only tools, including command polling, separately from write-capable queue-lifecycle tools and enforces OAuth scope when OAuth is used, active credential status, tenant policy, and queue-only write intent.</dd>
        <dt>Write authority</dt>
        <dd>Web-MCP writes are <strong>queued intent</strong> &mdash; local applies, rejects, or lets them expire.</dd>
        <dt>Read authority</dt>
        <dd>Hosted reads are mirrored, with freshness labels. Hosted says so when it cannot reach local.</dd>
      </dl>
    </div>
  </section>

  <section id="trust" class="site-section">
    <div class="site-wrap">
      <p class="site-kicker">Trust model</p>
      <h2>Trust and authority</h2>
      <p class="site-trust">${START_TRUST}</p>
      <dl class="site-authority" aria-label="Authority states">
        <dt>Local authoritative</dt>
        <dd>A write on your machine via local MCP or the local dashboard. Takes effect immediately.</dd>
        <dt>Mirrored</dt>
        <dd>A value hosted received from local and is still fresh.</dd>
        <dt>Stale</dt>
        <dd>Hosted can still reach local, but the mirrored value is older than the freshness threshold.</dd>
        <dt>Queued intent</dt>
        <dd>A change made remotely &mdash; from hosted, from web MCP, from any non-local caller. Pending local resolution.</dd>
        <dt>Applied &middot; Rejected &middot; Expired</dt>
        <dd>Local resolved the queued intent.</dd>
        <dt>Disconnected</dt>
        <dd>Hosted cannot currently confirm fresh state from local. It says so rather than pretending.</dd>
      </dl>
    </div>
  </section>

  <section id="next" class="site-section site-section-soft">
    <div class="site-wrap">
      <p class="site-kicker">Deeper</p>
      <h2>Real next links</h2>
      <ul class="site-links">
        <li><a href="/">Homepage &mdash; product overview (HTML)</a></li>
        <li><a href="/my">Hosted portal on <code>verityone.app</code> &mdash; audit from anywhere (HTML)</a></li>
        <li><a href="http://127.0.0.1:3100/dashboard">Local dashboard &mdash; opens on your local VO install at <code>http://127.0.0.1:3100/dashboard</code> (HTML)</a></li>
        <li><a href="https://github.com/markprobinson3-maker/VerityOne" rel="noopener">GitHub repository &mdash; install instructions and source</a></li>
        <li><a href="http://127.0.0.1:3100/connect"><code>GET /connect</code> on your local VO install &mdash; agent onboarding endpoint (JSON)</a></li>
        <li><a href="http://127.0.0.1:3100/schema"><code>GET /schema</code> on your local VO install &mdash; graph ontology (JSON endpoint)</a></li>
        <li><a href="http://127.0.0.1:3100/.well-known/agent"><code>GET /.well-known/agent</code> on your local VO install &mdash; agent discovery (JSON endpoint)</a></li>
      </ul>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="site-wrap">
    <p>Verity One &middot; getting started &middot; local by default.</p>
    <p class="site-footer-meta">${SHARED_SEAM_MARKER} &middot; hosted palette &middot; /start</p>
  </div>
</footer>
</body>
</html>`;
}
