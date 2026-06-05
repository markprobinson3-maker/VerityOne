/**
 * Long-lived-only Hono route registration (rung F3).
 *
 * Mounts the miner-backed and local-ops route surfaces:
 *   /dashboard, /machine/vault, /browser-capture, /day-journal, /providers, /browser-session, /federation,
 *   /mining, /vi/schedules, /vi/ingest, /wi, /trends, /ops,
 *   /vi/adapters, /vi/stimuli/live.
 *
 * Some of these route modules import directly from `../../miners/**`,
 * which opens local-Postgres clients at module load. Others read or
 * write local machine config. They are NOT safe to import from
 * `api/index.ts` (the Vercel function entrypoint) — the Vercel function
 * returns 503 for these path prefixes instead.
 *
 * /dashboard, /machine/vault, /providers, /browser-session, and
 * /federation are in this module too because they import local action
 * runners, local provider secrets, local decrypt material, or local
 * node/overlay signing keys. They are local-control surfaces, not
 * hosted/serverless surfaces.
 *
 * Imported only by `api/src/index.ts` (the long-lived launcher), and
 * called once after the deployment profile has been validated as
 * `long-lived`. The function is async so module evaluation order is
 * deterministic for test surfaces and the imports happen lazily.
 */

import type { Hono } from "hono";

export async function registerLongLivedRoutes(app: Hono): Promise<void> {
  const [
    { default: dashboardRoute },
    { default: machineVaultRoute },
    { default: browserCaptureRoute },
    { default: dayJournalRoute },
    { default: providersRoute },
    { default: federationRoutes },
    { default: mining },
    { default: viSchedules },
    { default: viWebhook },
    { default: wiApi },
    { default: wiMonitor },
    { default: trends },
    { default: supercron },
    { rejectHostedSessionCookieOnDashboard },
    { requireBetaAccess, rateLimit },
    { requireVoEnabled },
  ] = await Promise.all([
    import("./routes/dashboard"),
    import("./routes/machine-vault"),
    import("./routes/browser-capture"),
    import("./routes/day-journal-routines"),
    import("./routes/providers"),
    import("./routes/federation"),
    import("./routes/mining"),
    import("./routes/vi-schedules"),
    import("./routes/vi-webhook"),
    import("./routes/wi-api"),
    import("./routes/wi-monitor"),
    import("./routes/trends"),
    import("./routes/supercron"),
    import("./lib/dashboard-cookie-guard"),
    import("./lib/access"),
    import("./lib/tenant-settings-middleware"),
  ]);

  // Hosted-cookie rejection middleware MUST register BEFORE the
  // /dashboard/* route mount so every dashboard handler sees it.
  // Rung 1 non-negotiable (federation ladder boundary):
  // vo_session cookies never authenticate /dashboard/* requests.
  app.use("/dashboard/*", rejectHostedSessionCookieOnDashboard);
  app.route("/dashboard", dashboardRoute);
  app.route("/machine/vault", machineVaultRoute);
  app.route("/browser-capture", browserCaptureRoute);
  app.use("/day-journal", requireVoEnabled(), requireBetaAccess(), rateLimit({ key: "day-journal", max: 60, windowMs: 60_000 }));
  app.use("/day-journal/*", requireVoEnabled(), requireBetaAccess(), rateLimit({ key: "day-journal", max: 60, windowMs: 60_000 }));
  app.route("/day-journal", dayJournalRoute);
  app.route("/providers", providersRoute);
  app.route("/federation", federationRoutes);
  app.route("/mining", mining);
  app.route("/vi/schedules", viSchedules);
  app.route("/vi/ingest", viWebhook);
  // Both wi-api and wi-monitor mount at /wi (matches the pre-F3 shape).
  app.route("/wi", wiApi);
  app.route("/wi", wiMonitor);
  app.route("/trends", trends);
  app.route("/supercron", supercron);

  // Verity Ingest adapter listing — separate from schedules for clean URLs.
  // Pulls from the miner-side adapter registry.
  const { listAdapters } = await import("../../miners/src/vi/adapters/registry");
  app.get("/vi/adapters", async (c) => {
    const adapters = listAdapters().map((a) => ({
      name: a.name,
      source_type: a.source_type,
      description: a.description,
      default_schedule: a.default_schedule,
      webhook_enabled: a.webhook_enabled,
      auth_required: a.auth?.required ?? false,
      auth_key_env: a.auth?.key_env,
    }));
    return c.json({ adapters, count: adapters.length });
  });

  // /vi/stimuli/live — Active stimulus moons for Scope visualization.
  // Reads the miner-managed stimuli table directly via the long-lived pool.
  const { sql } = await import("./db");
  app.get("/vi/stimuli/live", async (c) => {
    const sinceRaw = c.req.query("since") || "";
    const parsedSince = sinceRaw
      ? (/^\d+$/.test(sinceRaw)
          ? new Date(Number.parseInt(sinceRaw, 10))
          : new Date(sinceRaw))
      : null;
    const since =
      parsedSince && Number.isFinite(parsedSince.getTime())
        ? parsedSince.toISOString()
        : null;
    const rawStimuli = await sql`
      SELECT
        s.id, s.parent_stimulus_id, s.node_addr, s.similarity, s.energy,
        s.is_orphan, s.orphan_status, s.decay_halflife_hours, s.stimulus_type,
        s.created_at, s.source, s.temporality,
        left(s.content, 100) as content_preview, s.ingest_batch_id
      FROM stimuli s
      WHERE s.ingest_batch_id IS NOT NULL
        AND (${since}::timestamptz IS NULL OR s.created_at >= ${since}::timestamptz)
      ORDER BY s.created_at DESC LIMIT 1500`;

    const now = Date.now();
    const stimuli = rawStimuli
      .map((stimulus: any) => {
        const energy = Math.max(0, Number(stimulus.energy) || 0);
        const halfLifeHours = Math.max(
          0.25,
          Number(stimulus.decay_halflife_hours) || 24,
        );
        const createdAt = new Date(stimulus.created_at).getTime();
        const ageHours = Number.isFinite(createdAt)
          ? Math.max(0, (now - createdAt) / 3_600_000)
          : 0;
        const decayFactor = Math.pow(0.5, Math.min(ageHours / halfLifeHours, 64));
        const currentOpacity = Math.max(0, Math.min(1, energy * decayFactor));
        const liveEnergy = Math.max(0, energy * decayFactor);
        const visualState = stimulus.is_orphan
          ? stimulus.orphan_status === "throbbing"
            ? "trend_candidate"
            : "resolved"
          : currentOpacity <= 0.08
            ? "dissolving"
            : "orbiting_heat";
        return {
          ...stimulus,
          age_hours: ageHours,
          decay_factor: decayFactor,
          live_energy: liveEnergy,
          current_opacity: currentOpacity,
          visual_state: visualState,
        };
      })
      .filter((stimulus: any) => {
        return (
          stimulus.current_opacity > 0.01 ||
          (stimulus.is_orphan === true && stimulus.orphan_status === "throbbing")
        );
      })
      .slice(0, 500);

    const byNode: Record<string, any[]> = {};
    const orphans: any[] = [];
    for (const s of stimuli) {
      if (s.is_orphan) {
        orphans.push(s);
      } else if (s.node_addr) {
        if (!byNode[s.node_addr]) byNode[s.node_addr] = [];
        byNode[s.node_addr].push(s);
      }
    }
    return c.json({
      total: stimuli.length,
      orbiting: stimuli.length - orphans.length,
      orphans: orphans.length,
      by_node: byNode,
      orphan_list: orphans,
      since,
      timestamp: new Date().toISOString(),
    });
  });
}
