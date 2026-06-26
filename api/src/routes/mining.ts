import { Hono } from "hono";
import { sql } from "../db";
import { auditMutation } from "../lib/audit";
import { clampInt } from "../lib/utils";

const mining = new Hono();

// GET /mining/status — Latest mining run stats
mining.get("/status", async (c) => {
  const [latest] = await sql`
    SELECT * FROM mining_runs ORDER BY started_at DESC LIMIT 1
  `;

  const stats = await sql`
    SELECT 
      COUNT(*) as total_runs,
      SUM(edges_found) as total_edges_found,
      SUM(implied_nodes) as total_implied_nodes,
      SUM(cost_usd) as total_cost,
      MAX(started_at) as last_run
    FROM mining_runs
  `;

  return c.json({
    latest: latest || null,
    aggregate: stats[0],
  });
});

// GET /mining/runs — Run history
mining.get("/runs", async (c) => {
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const runs = await sql`
    SELECT * FROM mining_runs ORDER BY started_at DESC LIMIT ${limit}
  `;
  return c.json({ runs });
});

// POST /mining/swarm-fill - Prepare the swarm-fill command (does NOT run it).
// Swarm-fill is a long-running multi-agent subprocess unsuitable for an HTTP
// request lifecycle, so this endpoint validates+audits the request and returns
// the exact command for the operator (or a scheduler such as
// scripts/swarm-fill-cron.sh) to execute. It is a command preview, not a runner.
mining.post("/swarm-fill", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pyramid = body.pyramid || null;
  const addr = body.addr || null;
  const agents = body.agents || 16;
  const dryRun = body.dryRun || false;

  // Build the swarm-fill subprocess command for the operator to run.
  const args = ["run", "../miners/src/swarm-fill.ts"];
  if (pyramid) args.push("--pyramid", pyramid);
  if (addr) args.push("--addr", addr);
  if (agents !== 16) args.push("--agents", String(agents));
  if (dryRun) args.push("--dry-run");

  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: process.env.VERITY_DEFAULT_TENANT_ID || "system",
    actor: "operator",
    actorKind: "operator_token",
    operation: "mining_swarm_fill_prepare",
    eventData: { pyramid, addr, agents, dry_run: dryRun },
  });

  return c.json({
    executed: false,
    message: "Swarm fill command prepared — not executed. Run it to start the fill.",
    command: `bun ${args.join(" ")}`,
    note: "Run from api/ directory (or via scripts/swarm-fill-cron.sh). Results go to staging tables for QC."
  });
});

export default mining;
