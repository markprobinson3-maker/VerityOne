/**
 * `bun test` preload — refuses to run the test suite against a database that holds
 * real data (FU1, see bunfig.toml `[test] preload`). This is the PREVENTION half of
 * closing the test-pollution-on-prod hole; api/scripts/detect-tenant-residue.ts is
 * the detection backstop.
 *
 * Runs once per test process, before any test. The decision logic lives in the pure,
 * unit-tested api/src/lib/test-db-guard.ts. This file does only the I/O, and FAILS OPEN
 * on any connection/query error or timeout — it must never break a legitimate test run
 * (e.g. a pure no-DB suite, or CI before its postgres service is reachable) by its own
 * failure. The only way it aborts a run is a SUCCESSFUL count that exceeds the threshold.
 *
 * `bun run` (the TA1 acceptance harness, which intentionally targets prod) does NOT
 * trigger test preloads, so this guard does not touch that path.
 */
import { createDirectSql } from "@verity-one/db-pool";
import { evaluateTestDbGuard, ALLOW_ENV } from "./src/lib/test-db-guard";

// Deliberately shorter than db-pool's 10s connect_timeout: a hung/slow connection
// loses this race → maxNodes=null → fail-open (availability over a stricter refuse;
// the residue detector backstops anything that slips). It never causes a false refuse.
const PROBE_TIMEOUT_MS = 3000;

async function largestRealDataSpaceCount(): Promise<number> {
  const sql = createDirectSql({ max: 1 });
  try {
    // Largest single real-data space: any tenant graph OR the public `global` graph.
    // Real prod has thousands in both (a founder tenant AND the harvested public graph);
    // every test DB has ~0 tenant nodes and only a tiny meta-seed in `global` (~34) — so
    // this catches a fresh prod (global-seeded, no tenant yet) too, while staying far
    // under the threshold for CI/verity_test.
    const [row] = await sql`
      SELECT COALESCE(max(c), 0)::int AS n
      FROM (
        SELECT count(*) AS c FROM nodes
        WHERE space_id LIKE 'tenant:%' OR space_id = 'global'
        GROUP BY space_id
      ) s
    `;
    return Number(row?.n ?? 0);
  } finally {
    await sql.end?.({ timeout: 2 });
  }
}

const allowOverride = process.env[ALLOW_ENV] === "1";

// Bound the probe: a timeout resolves to null (fail-open) so a hung connection can
// never hang the test process. unref() so the timer never keeps the process alive.
let maxNodes: number | null = null;
try {
  maxNodes = await Promise.race([
    largestRealDataSpaceCount(),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
} catch {
  maxNodes = null; // fail-open on connection/query error
}

if (maxNodes !== null) {
  const verdict = evaluateTestDbGuard({ maxSpaceNodeCount: maxNodes, allowOverride });
  if (verdict.refuse) {
    throw new Error(
      `\n\n🛑 REFUSING to run tests: ${verdict.reason}.\n` +
        `   A 'bun test' run here would pollute or corrupt production data.\n` +
        `   Point DATABASE_URL at a disposable DB (e.g. verity_test), or set ${ALLOW_ENV}=1 to override.\n`,
    );
  }
}
