/**
 * Test-database safety guard (FU1 — prevent test-pollution-on-prod).
 *
 * Root cause this closes: getDatabaseUrl() (packages/db-pool) DEFAULTS to the live
 * `verity` DB when DATABASE_URL is unset, so a stray `bun test` run silently seeds
 * (or corrupts) PRODUCTION. The residue detector (api/scripts/detect-tenant-residue.ts)
 * catches the aftermath; THIS guard prevents it — it runs as a `bun test` preload
 * (see bunfig.toml) and refuses to let the suite run against a DB that holds real data.
 *
 * Discriminator (verified): real prod has thousands of nodes in its largest real-data
 * space — a founder tenant (~6000+) AND the harvested public `global` graph (~1900) —
 * while every test DB (verity_test, CI's ephemeral verity) has ~0 tenant nodes and only a
 * tiny meta-seed in `global` (~34). So "the largest single real-data space exceeds a high
 * threshold" cleanly separates prod from a test DB with a huge margin, with no dependence
 * on the DB *name* (CI's DB is also named `verity`).
 *
 * The decision is a pure function so it is unit-tested; the preload does the I/O and
 * fails OPEN on any connection/query error or timeout (the detector is the backstop —
 * this guard must never break a legitimate test run by its own failure).
 */

/** Real prod's founder tenant has thousands of nodes; a test DB has ~0. 1000 is a wide moat. */
export const PROD_NODE_THRESHOLD = 1000;

/** Env flag an operator sets to intentionally run tests against a populated DB. */
export const ALLOW_ENV = "VERITY_ALLOW_PROD_TEST_DB";

export interface TestDbGuardInput {
  /** the node count of the largest single real-data space (a `tenant:*` graph or `global`) */
  maxSpaceNodeCount: number;
  /** VERITY_ALLOW_PROD_TEST_DB === "1" */
  allowOverride: boolean;
  threshold?: number;
}

export interface TestDbGuardVerdict {
  refuse: boolean;
  reason: string;
}

/**
 * Decide whether to refuse a test run against this DB. Pure + total.
 */
export function evaluateTestDbGuard(input: TestDbGuardInput): TestDbGuardVerdict {
  const threshold = input.threshold ?? PROD_NODE_THRESHOLD;
  if (input.allowOverride) {
    return { refuse: false, reason: `override set (${ALLOW_ENV}=1) — caller accepts a populated DB` };
  }
  if (input.maxSpaceNodeCount > threshold) {
    return {
      refuse: true,
      reason: `the target database has a space with ${input.maxSpaceNodeCount} nodes (> ${threshold}) — it looks like PRODUCTION`,
    };
  }
  return { refuse: false, reason: `no space exceeds ${threshold} nodes — a disposable test database` };
}
