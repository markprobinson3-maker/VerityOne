/**
 * World Ingestor V2 — Health Check.
 * Checks: Flash Lite API, Whisper binary, Embedding API, PostgreSQL, queue, 24h stats.
 */

import { sql } from "./config";
import { callFlashLite } from "../lib/llm";
import { embedQuery } from "@verity-one/embed";

interface HealthCheck {
  name: string;
  ok: boolean;
  latency_ms?: number;
  detail?: string;
  error?: string;
}

export async function runHealthCheck(): Promise<{ checks: HealthCheck[]; allOk: boolean }> {
  const checks: HealthCheck[] = [];

  // 1. PostgreSQL
  const pgStart = Date.now();
  try {
    await sql`SELECT 1`;
    checks.push({ name: "PostgreSQL", ok: true, latency_ms: Date.now() - pgStart });
  } catch (err: any) {
    checks.push({ name: "PostgreSQL", ok: false, error: err.message });
  }

  // 2. Flash Lite API
  const llmStart = Date.now();
  try {
    await callFlashLite("Return the word: OK", { maxTokens: 10, temperature: 0 });
    const latency = Date.now() - llmStart;
    // Also check avg from recent runs
    const [avg] = await sql`
      SELECT COALESCE(AVG(elapsed_ms), 0)::int AS avg_ms
      FROM wi_runs WHERE created_at > now() - interval '24 hours'
    `;
    checks.push({
      name: "Flash Lite API",
      ok: true,
      latency_ms: latency,
      detail: `Avg run time (24h): ${avg.avg_ms}ms`,
    });
  } catch (err: any) {
    checks.push({ name: "Flash Lite API", ok: false, latency_ms: Date.now() - llmStart, error: err.message });
  }

  // 3. Whisper binary
  try {
    const proc = Bun.spawn(["which", "whisper"], { stdout: "pipe", stderr: "pipe" });
    const result = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (result) {
      // Check model
      const modelProc = Bun.spawn(["whisper", "--help"], { stdout: "pipe", stderr: "pipe" });
      await modelProc.exited;
      checks.push({ name: "Whisper", ok: true, detail: `Binary: ${result}` });
    } else {
      checks.push({ name: "Whisper", ok: false, error: "Not installed — run 'pip install openai-whisper'" });
    }
  } catch {
    checks.push({ name: "Whisper", ok: false, error: "Not installed" });
  }

  // 4. Embedding API
  const embedStart = Date.now();
  try {
    await embedQuery("health check test");
    checks.push({ name: "Embedding API", ok: true, latency_ms: Date.now() - embedStart });
  } catch (err: any) {
    checks.push({ name: "Embedding API", ok: false, error: err.message });
  }

  // 5. Queue status
  try {
    const [q] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing' AND started_at < now() - interval '15 minutes') AS stale
      FROM wi_queue
    `;
    const pending = parseInt(q.pending);
    const stale = parseInt(q.stale);
    checks.push({
      name: "Queue",
      ok: stale === 0,
      detail: `Pending: ${pending}, Stale: ${stale}`,
    });
  } catch (err: any) {
    checks.push({ name: "Queue", ok: false, error: err.message });
  }

  // 6. Last 24h stats
  try {
    const [stats] = await sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'done') AS succeeded,
        COALESCE(SUM(atoms_extracted), 0) AS atoms,
        COALESCE(SUM(skills_detected), 0) AS skills
      FROM wi_runs
      WHERE created_at > now() - interval '24 hours'
    `;
    checks.push({
      name: "24h Ingestion",
      ok: true,
      detail: `${stats.succeeded} succeeded, ${stats.failed} failed, ${stats.atoms} atoms, ${stats.skills} skills`,
    });
  } catch (err: any) {
    checks.push({ name: "24h Ingestion", ok: false, error: err.message });
  }

  // 7. Enrichment pool
  try {
    const [pool] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'enriching' AND created_at < now() - interval '10 minutes') AS stale_enriching,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM wi_atom_pool
    `;
    const pending = parseInt(pool.pending);
    const staleEnriching = parseInt(pool.stale_enriching);
    const poolFailed = parseInt(pool.failed);
    checks.push({
      name: "Enrichment Pool",
      ok: staleEnriching === 0 && pending < 500,
      detail: `Pending: ${pending}, Stale enriching: ${staleEnriching}, Failed: ${poolFailed}`,
    });
  } catch {
    // Table may not exist — skip
  }

  // 8. Recent errors
  try {
    const errors = await sql`
      SELECT run_id, source_url, error, created_at
      FROM wi_runs
      WHERE error IS NOT NULL AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 5
    `;
    if (errors.length > 0) {
      checks.push({
        name: "Recent Errors",
        ok: false,
        detail: errors.map(e => `${e.run_id}: ${(e.error || "").slice(0, 80)}`).join("\n    "),
      });
    } else {
      checks.push({ name: "Recent Errors", ok: true, detail: "None" });
    }
  } catch (err: any) {
    checks.push({ name: "Recent Errors", ok: false, error: err.message });
  }

  const allOk = checks.every(c => c.ok);
  return { checks, allOk };
}

export function printHealthReport(result: { checks: HealthCheck[]; allOk: boolean }): void {
  console.log(`\n🏥 World Ingestor Health Check\n`);

  for (const check of result.checks) {
    const icon = check.ok ? "✅" : "❌";
    let line = `  ${icon} ${check.name}`;
    if (check.latency_ms !== undefined) line += ` (${check.latency_ms}ms)`;
    console.log(line);
    if (check.detail) console.log(`     ${check.detail}`);
    if (check.error) console.log(`     Error: ${check.error}`);
  }

  console.log(`\n  Overall: ${result.allOk ? "✅ All OK" : "❌ Issues detected"}\n`);
}
