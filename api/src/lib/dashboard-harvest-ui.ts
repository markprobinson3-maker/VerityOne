/**
 * Dashboard-side presenter for `AutoOutcome` — VO-LOCAL-DASHBOARD-HARVEST-PR-1.
 *
 * Pure render helper that turns a structured harvest outcome from
 * `api/src/lib/vault-harvest.ts` into an HTML fragment for the local
 * Vault tab's result region. Matches the CLI's guided-copy contract
 * shape — "what succeeded / what did not happen / exact next step" —
 * but uses dashboard card/badge grammar instead of terminal text.
 *
 * Contract:
 *   - pure function, no DOM access, no side effects
 *   - never renders a success-shaped card for a stop outcome
 *   - success card names capture / dossier / graph-write / doc-link /
 *     "open dossier in Obsidian"
 *   - stop-missing-key points at `vo onboard` (local setup, not
 *     hosted/onboarding queued-intent language)
 *   - stop_vo_unavailable (4 subReasons) differentiates wording:
 *     unreachable / missing_tenant_auth / all_writes_failed / unknown
 *   - stop_finalize_conflict clearly preserves the human-edited
 *     canonical dossier and names the .conflicts/ path
 *   - stop_unknown surfaces the real stage + message (no pretense)
 *   - local-authoritative wording throughout — never uses hosted
 *     queued-intent language for local-file actions
 *
 * Every path escapes user content via `esc()` — vault paths can
 * contain tenant-written strings.
 */

import type { AutoOutcome } from "./vault-harvest";

/**
 * Marker string embedded in every rendered card (`data-presenter`) so
 * the Vault tab tests can assert at the DOM level that the presenter
 * was actually used, not just that the constant exists. Any future
 * edit that inlines its own markup for a harvest card will miss this
 * attribute and fail the presence check.
 */
export const DASHBOARD_HARVEST_SEAM_MARKER = "vo-dashboard-harvest-ui-v1";

/**
 * VO-LOCAL-DASHBOARD-HARVEST-PR-1B — retry/resume polish.
 *
 * The client-side Vault shell watches the result region for clicks on
 * `[data-harvest-retry]` and routes them back into the existing
 * `harvestSubmit()` seam (one submit path, one route). The presenter
 * renders a retry control on retryable stop kinds only; success and
 * `stop_finalize_conflict` deliberately do NOT emit one.
 *
 * Retryability:
 *   - `success`: no retry (nothing to retry)
 *   - `stop_finalize_conflict`: no retry — the generated dossier
 *     differed from a human-edited canonical dossier and routed to
 *     `.conflicts/`; resolving is a manual merge, not a re-run
 *   - `stop_missing_key`: retry allowed, but copy stays honest that
 *     `vo onboard` is the prerequisite; pressing retry without doing
 *     onboard will just hit the same stop
 *   - `stop_vo_unavailable`: retry allowed
 *   - `stop_unknown`: retry allowed
 *
 * The retry control reuses the existing harvest seam — it does not
 * introduce a new route or a new submit function. The client delegate
 * reads the `data-harvest-retry` attribute and calls `harvestSubmit()`
 * against whatever `#vault-harvest-source` currently holds, with the
 * Vault shell already restoring the last-attempted source from the
 * tenant+root-gated cache before this click can fire.
 */
const RETRYABLE_STOP_KINDS = new Set<string>([
  "stop_missing_key",
  "stop_vo_unavailable",
  "stop_unknown",
]);

/** Is this outcome kind retryable via the existing harvest seam? */
export function isOutcomeRetryable(kind: string): boolean {
  return RETRYABLE_STOP_KINDS.has(kind);
}

/**
 * Render the retry affordance for a retryable stop kind. Emits an
 * `.vault-harvest-retry` button tagged with `data-harvest-retry=<kind>`
 * so the client delegate can tell which branch the operator acted on
 * (useful for future analytics; today the client treats all tags the
 * same — they all route back into `harvestSubmit()`).
 *
 * The one-line hint next to the button stays honest per kind. For
 * `stop_vo_unavailable` the presenter already distinguishes four
 * sub-reasons in the main card copy (unreachable /
 * missing_tenant_auth / all_writes_failed / unknown); the retry
 * hint keys off the same `subReason` so the operator is not sent
 * down a wrong recovery path — e.g. a `missing_tenant_auth` card
 * must not tell the operator to start local VO or restore the
 * network.
 *
 * `data-harvest-retry` is the delegation key. `type="button"` keeps
 * the control from accidentally submitting any ambient form.
 */
type VoUnavailableSubReason = "unreachable" | "missing_tenant_auth" | "all_writes_failed" | "unknown";

function retryHintFor(
  kind: "stop_missing_key" | "stop_vo_unavailable" | "stop_unknown",
  subReason?: VoUnavailableSubReason,
): string {
  if (kind === "stop_missing_key") {
    return "Set an AI provider key (e.g. <code>GOOGLE_API_KEY</code>) in your environment or <code>~/.vo/secrets.env</code>, then retry.";
  }
  if (kind === "stop_vo_unavailable") {
    switch (subReason) {
      case "missing_tenant_auth":
        return "Ensure <code>~/.vo/config.json</code> carries <code>agent_token</code> + <code>tenant_id</code> (the installer writes these), then retry.";
      case "all_writes_failed":
        return "Check local VO health (every atom failed to land), then retry.";
      case "unreachable":
        return "Start local VO or restore the network, then retry.";
      case "unknown":
      default:
        // "unknown" sub-reason is the honest catch-all — the
        // card names the stage but no specific recovery path.
        return "Once the blocker above is resolved, retry this harvest.";
    }
  }
  // kind === "stop_unknown"
  return "Once the blocker above is resolved, retry this harvest.";
}

function renderRetryControl(
  kind: "stop_missing_key" | "stop_vo_unavailable" | "stop_unknown",
  subReason?: VoUnavailableSubReason,
): string {
  const hint = retryHintFor(kind, subReason);
  return `
  <div class="harvest-retry-row" style="margin-top:.6rem">
    <button type="button" class="btn-sm btn-secondary vault-harvest-retry" data-harvest-retry="${kind}">Retry harvest</button>
    <span class="status-dim" style="margin-left:.6rem">${hint}</span>
  </div>`;
}

/**
 * VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
 * post-harvest local action slots.
 *
 * The presenter emits narrow marker elements next to the
 * relative artifact paths it already discloses (dossier, draft,
 * capture, preserved-dossier, conflict-file). The slot carries
 * the relative path in a data attribute; the client-side Vault
 * shell populates it with an actual Reveal button at runtime —
 * but ONLY when `window.voDesktop` is present. Browser-mode
 * operators see empty slots (no dead controls).
 *
 * Returning an empty string when path is null/empty keeps the
 * caller's markup clean (e.g. VO-unavailable without a
 * `draftPath`). The data attribute carries the raw relative
 * path; the path is validated strictly at click time by the
 * client's composeVaultArtifactPath helper, which refuses
 * absolute paths, `..` traversal, and anything outside the
 * allowed `captures/` / `dossiers/` prefixes.
 */
function renderHarvestRevealSlot(kind: string, path: string | null | undefined): string {
  if (typeof path !== "string" || !path) return "";
  return ` <span class="harvest-local-action" data-harvest-local-reveal="${esc(kind)}" data-harvest-local-path="${esc(path)}"></span>`;
}

/**
 * VO-LOCAL-DASHBOARD-HARVEST-RESULT-LOCAL-ACTIONS-PR-1 —
 * optional Obsidian handoff slot for success + finalize-conflict
 * cards. Always emitted (so cached-result restore also shows it
 * when the gate holds), but the client populator only paints a
 * real button when the SHARED truthful gate
 * shouldRenderObsidianQuickAction(live state, canWrite) is
 * satisfied. Click routes through the EXISTING
 * vaultAction('open-obsidian') seam.
 */
function renderHarvestObsidianHandoffSlot(): string {
  return `
  <div class="harvest-local-handoff-row" data-harvest-local-handoff="open-obsidian"></div>`;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * POSIX single-quote escape — safe for any file path or argv, including
 * paths that contain spaces, shell metacharacters, or embedded single
 * quotes. The result is intended to be dropped directly into a shell
 * command without further quoting.
 *
 *   /tmp/My Vault        → '/tmp/My Vault'
 *   /tmp/O'Brien         → '/tmp/O'\''Brien'
 *   plain                → 'plain'
 */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Success card. Five canonical fields, matching the CLI's five-line
 * summary, but rendered as summary-row pairs.
 */
function renderSuccess(o: Extract<AutoOutcome, { kind: "success" }>): string {
  const atomSummary = `${o.atomsWritten} written, ${o.atomsDeduped} deduped`;
  return `
<div class="card card-dither dashboard-harvest-result" data-outcome-kind="success" data-presenter="${DASHBOARD_HARVEST_SEAM_MARKER}">
  <div class="card-title">Harvest complete</div>
  <div class="alert alert-ok">
    <span class="alert-icon" aria-hidden="true">&#10003;</span>
    <span>Local harvest succeeded. Local vault is authoritative; the dossier is a local file.</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Capture</span>
    <span class="summary-value">${esc(o.capturePath)}</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Dossier</span>
    <span class="summary-value">${esc(o.dossierPath)}${renderHarvestRevealSlot("dossier", o.dossierPath)}</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Graph write</span>
    <span class="summary-value">${esc(o.graphWrite)} &middot; ${esc(atomSummary)}</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Doc link</span>
    <span class="summary-value">${esc(o.docLink)}</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Next</span>
    <span class="summary-value">open the dossier in Obsidian</span>
  </div>
  ${renderHarvestObsidianHandoffSlot()}
</div>`;
}

function renderMissingKey(o: Extract<AutoOutcome, { kind: "stop_missing_key" }>): string {
  const capturePreserved = o.capturePath
    ? `<div class="summary-row"><span class="summary-label">Capture preserved</span><span class="summary-value">${esc(o.capturePath)}${renderHarvestRevealSlot("capture", o.capturePath)}</span></div>`
    : `<div class="summary-row"><span class="summary-label">What succeeded</span><span class="summary-value">nothing yet</span></div>`;
  return `
<div class="card dashboard-harvest-result" data-outcome-kind="stop_missing_key" data-presenter="${DASHBOARD_HARVEST_SEAM_MARKER}">
  <div class="card-title">Stop &middot; AI model API key not configured</div>
  <div class="alert alert-warn">
    <span class="alert-icon" aria-hidden="true">!</span>
    <span>Atomize requires an LLM API key. No atomize, no draft, no graph write, no finalize.</span>
  </div>
  ${capturePreserved}
  <div class="summary-row">
    <span class="summary-label">Missing env var</span>
    <span class="summary-value">${esc(o.envVarName)} (${esc(o.providerLabel)})</span>
  </div>
  <div class="summary-row">
    <span class="summary-label">Next</span>
    <span class="summary-value">Set an AI provider key (e.g. <code>GOOGLE_API_KEY</code>) in <code>~/.vo/secrets.env</code> or your environment (local setup, not hosted), then retry.</span>
  </div>
  ${renderRetryControl("stop_missing_key")}
</div>`;
}

function renderVoUnavailable(o: Extract<AutoOutcome, { kind: "stop_vo_unavailable" }>): string {
  // Header copy per subReason.
  let headline: string;
  if (o.subReason === "missing_tenant_auth") {
    headline = "Stop &middot; VO tenant auth is missing";
  } else if (o.subReason === "unreachable") {
    headline = "Stop &middot; VO is unreachable";
  } else if (o.subReason === "all_writes_failed") {
    const total = o.atomsProposed ?? 0;
    headline = `Stop &middot; 0 of ${total} atoms reached the VO graph`;
  } else {
    headline = "Stop &middot; VO could not complete the graph write";
  }

  // "What succeeded / did not happen" rows + next-step line per subReason.
  let whatSucceeded: string;
  let whatDidNot: string;
  let nextStep: string;

  if (o.subReason === "all_writes_failed") {
    // Finalize still ran — dossier exists on disk with an empty
    // assertions table. Name it honestly, don't mimic success.
    whatSucceeded = "capture, atomize, curate, draft, finalize (dossier on disk)";
    whatDidNot = "any assertion landed in the VO graph";
    nextStep = "Check local VO health, then harvest this source again.";
  } else if (o.draftPath) {
    // Substitute the real vault root (shell-quoted so paths with
    // spaces / metacharacters remain copy-pasteable). AutoOutcome
    // does not carry tenant id, so `vo init --tenant <id>` keeps
    // the placeholder — the operator knows their own tenant id.
    whatSucceeded = "capture, atomize, curate, draft dossier";
    whatDidNot = "graph write, finalize, log/index update";
    const rootArg = esc(shellQuote(o.root));
    nextStep = o.subReason === "missing_tenant_auth"
      ? `Ensure <code>~/.vo/config.json</code> carries <code>agent_token</code> + <code>tenant_id</code> (the installer writes these), then re-run the harvest — the draft dossier under <code>${rootArg}</code> is reused.`
      : `Re-run the harvest when local VO is back — the draft dossier under <code>${rootArg}</code> is reused.`;
  } else {
    whatSucceeded = "capture only";
    whatDidNot = "atomize, draft, graph write, finalize";
    nextStep = "Start local VO, then harvest again.";
  }

  const draftRow = o.draftPath
    ? `<div class="summary-row"><span class="summary-label">Draft preserved</span><span class="summary-value">${esc(o.draftPath)}${renderHarvestRevealSlot("draft", o.draftPath)}</span></div>`
    : "";
  const dossierRow = o.subReason === "all_writes_failed" && o.dossierPath
    ? `<div class="summary-row"><span class="summary-label">Dossier (no assertions written)</span><span class="summary-value">${esc(o.dossierPath)}${renderHarvestRevealSlot("dossier", o.dossierPath)}</span></div>`
    : "";

  // VO-LOCAL-DASHBOARD-HARVEST-RECOVERY-OBSIDIAN-HANDOFF-PR-1 —
  // emit the existing Obsidian handoff slot for qualifying
  // recovery cards: when a draft was preserved (any subReason
  // with a draftPath) OR when the `all_writes_failed` branch
  // produced a dossier with zero landed assertions. Both are
  // cases where the operator's next local step is to review
  // the preserved artifact in Obsidian. The slot is a passive
  // data-attributed container; the already-shipped client
  // populator (populateHarvestLocalActions) decides at paint
  // time whether a real button appears based on wrapper
  // presence + shouldRenderObsidianQuickAction, and the click
  // delegate rechecks the same gate against live
  // currentVaultData before calling vaultAction('open-obsidian').
  // Browser mode and non-ready / unsupported / not-installed
  // states see no dead control.
  //
  // Deliberately NOT emitted for:
  //   - missing_tenant_auth without a draftPath (no preserved
  //     artifact to open; the card's `vo init` copy is the
  //     real recovery path)
  //   - unreachable without a draftPath (no preserved
  //     artifact)
  //   - unknown without a draftPath (no preserved artifact)
  const handoffSlot = (o.draftPath || (o.subReason === "all_writes_failed" && o.dossierPath))
    ? renderHarvestObsidianHandoffSlot()
    : "";

  return `
<div class="card dashboard-harvest-result" data-outcome-kind="stop_vo_unavailable" data-sub-reason="${esc(o.subReason)}" data-presenter="${DASHBOARD_HARVEST_SEAM_MARKER}">
  <div class="card-title">${headline}</div>
  <div class="alert alert-warn">
    <span class="alert-icon" aria-hidden="true">!</span>
    <span>Local harvest stopped honestly. Local vault is authoritative; preserved files are local-only.</span>
  </div>
  <div class="summary-row"><span class="summary-label">What succeeded</span><span class="summary-value">${esc(whatSucceeded)}</span></div>
  <div class="summary-row"><span class="summary-label">What did not happen</span><span class="summary-value">${esc(whatDidNot)}</span></div>
  ${draftRow}${dossierRow}
  <div class="summary-row"><span class="summary-label">Next</span><span class="summary-value">${nextStep}</span></div>
  ${renderRetryControl("stop_vo_unavailable", o.subReason)}
  ${handoffSlot}
</div>`;
}

function renderFinalizeConflict(o: Extract<AutoOutcome, { kind: "stop_finalize_conflict" }>): string {
  return `
<div class="card dashboard-harvest-result" data-outcome-kind="stop_finalize_conflict" data-presenter="${DASHBOARD_HARVEST_SEAM_MARKER}">
  <div class="card-title">Conflict &middot; generated dossier differed from your edited dossier</div>
  <div class="alert alert-warn">
    <span class="alert-icon" aria-hidden="true">!</span>
    <span>Your edited dossier was preserved. The newly generated version was routed to <code>.conflicts/</code> for manual review.</span>
  </div>
  <div class="summary-row"><span class="summary-label">Preserved dossier</span><span class="summary-value">${esc(o.preservedDossierPath)}${renderHarvestRevealSlot("preserved-dossier", o.preservedDossierPath)}</span></div>
  <div class="summary-row"><span class="summary-label">Conflict file</span><span class="summary-value">${esc(o.conflictPath)}${renderHarvestRevealSlot("conflict-file", o.conflictPath)}</span></div>
  <div class="summary-row"><span class="summary-label">Graph write</span><span class="summary-value">${esc(o.graphWrite)} &middot; ${esc(String(o.atomsWritten))} written, ${esc(String(o.atomsDeduped))} deduped</span></div>
  <div class="summary-row"><span class="summary-label">Doc link</span><span class="summary-value">${esc(o.docLink)}</span></div>
  <div class="summary-row"><span class="summary-label">Next</span><span class="summary-value">Compare both files in Obsidian and merge by hand when you are ready.</span></div>
  ${renderHarvestObsidianHandoffSlot()}
</div>`;
}

function renderUnknown(o: Extract<AutoOutcome, { kind: "stop_unknown" }>): string {
  const hintLines = (o.resumeHint || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<div class="summary-row"><span class="summary-label">&nbsp;</span><span class="summary-value">${esc(line)}</span></div>`)
    .join("");
  return `
<div class="card dashboard-harvest-result" data-outcome-kind="stop_unknown" data-presenter="${DASHBOARD_HARVEST_SEAM_MARKER}">
  <div class="card-title">Stop &middot; harvest failed at stage "${esc(o.stage)}"</div>
  <div class="alert alert-err">
    <span class="alert-icon" aria-hidden="true">!</span>
    <span>Local harvest stopped unexpectedly. Local files are preserved on disk.</span>
  </div>
  <div class="summary-row"><span class="summary-label">Stage</span><span class="summary-value">${esc(o.stage)}</span></div>
  <div class="summary-row"><span class="summary-label">Message</span><span class="summary-value">${esc(o.message)}</span></div>
  ${hintLines}
  ${renderRetryControl("stop_unknown")}
</div>`;
}

/**
 * Top-level dispatcher. Exhaustively handles every `AutoOutcome`
 * kind so a future additional variant in the shared engine produces
 * a compile error here until the presenter is updated.
 */
export function renderHarvestOutcomeHtml(outcome: AutoOutcome): string {
  switch (outcome.kind) {
    case "success":
      return renderSuccess(outcome);
    case "stop_missing_key":
      return renderMissingKey(outcome);
    case "stop_vo_unavailable":
      return renderVoUnavailable(outcome);
    case "stop_finalize_conflict":
      return renderFinalizeConflict(outcome);
    case "stop_unknown":
      return renderUnknown(outcome);
  }
}

