/**
 * Prod tenant-residue detector (TA1 #2).
 *
 * Acceptance/test code that runs against the production `verity` DB can leave
 * orphaned tenants behind — a suite whose DATABASE_URL points at prod, or an
 * acceptance script that lacks fail-closed teardown (the hosted-connector GA
 * suite left 14 empty tenants this way; rung12a-iso + r1-connect suites left
 * orphan account links + hosted identities behind whose `tenants` row was torn).
 * This module classifies every candidate tenant in a target DB as one of:
 *
 *   - "allow"   — a versioned, intentional tenant (a `db/tenants/<id>/bootstrap.sql`
 *                 exists, e.g. the founder tenant + the smoke-test tenant). NEVER
 *                 residue, even if link-less or empty.
 *   - "residue" — strong evidence it should not exist in prod (see signals below).
 *   - "review"  — a single weak signal or no signal; surfaced for a human rather
 *                 than asserted deletable. A bare test-name match or a lone orphan
 *                 lands here so a real customer slug that merely *resembles* a test
 *                 id is never auto-classified as deletable.
 *
 * Signal model (the detector is read-only + never deletes, but its verdict guides
 * an operator, so "residue" must be conservative):
 *   STRONG (each conclusive ALONE — a real tenant exhibits neither):
 *     - sentinel : linked to a test-domain account (@example.test / .invalid / …).
 *     - empty    : 0 nodes AND 0 account links. The self-serve onboarding path is
 *                  atomic (a default-project node + an active link are created in one
 *                  transaction), so a real tenant is never 0+0; the rare hand-
 *                  provisioned one must be allowlisted via a db/tenants/<id>/bootstrap.sql.
 *   WEAK (need >=2 to assert residue; 1 alone => review):
 *     - pattern  : tenant id matches a known test-id pattern (prefix collisions with
 *                  real slugs are possible, so this alone is not conclusive).
 *     - orphan   : referenced by links/identities/nodes but has no `tenants` row.
 *
 * The pure `classifyTenant` is unit-tested; `enumerateTenants` does the DB read.
 * Detection only — cleanup is a separate, proposal-first action (never auto-delete).
 */

export type TenantClass = "allow" | "residue" | "review";

export interface TenantFacts {
  tenantId: string;
  /** has a row in the `tenants` table (false => orphan: torn/leftover state) */
  inTenants: boolean;
  nodeCount: number;
  /** account_tenant_links rows (any status) */
  linkCount: number;
  /** emails of accounts linked to this tenant (via account_tenant_links) */
  ownerEmails: string[];
  /** a db/tenants/<id>/bootstrap.sql exists — the tenant is versioned + intentional */
  bootstrapped: boolean;
}

export interface TenantVerdict {
  tenantId: string;
  class: TenantClass;
  reason: string;
}

/**
 * Test tenant-id patterns observed across the suite. EXTEND this as new test
 * suites introduce new tenant ids. NOTE: a pattern match is a WEAK signal (it
 * needs corroboration to assert residue), precisely because a prefix can collide
 * with a real customer slug — so an over-broad entry here degrades to "review",
 * never to a false "residue".
 */
export const TEST_TENANT_PATTERNS: RegExp[] = [
  /^producta$/, /^productb$/,
  /^ta1acc(-[a-z0-9]+)?$/,
  /^rung12aiso[ab]/, /^rung7[a-z]?-/,
  /^r11onboard/, /^r11-/, /^mt11onb/,
  /^r1connecttest/, /^r1-hosted-connect/,
  /^mh(base|garb|hs|upd|pa|pg|cf)/,
  /^iso(p|la|rd)/,
  /^oa[0-9]+(test|rt|lr)/, /^oa3-test/,
  /^crw(other)?(tenant|rt)/,
  /^lw[0-9]+test$/,
  /^vaultpr[0-9]+test$/, /^driveworkertesttenant$/,
  /^dashboardrung[0-9]+test/, /^hostedmcpwritet/,
  /^portalweb/, /^opsdrivetest$/,
  /^syncautht/,
];

/**
 * Test sentinel account email domains. A tenant linked to one of these accounts
 * was provisioned by test/acceptance code, not a real user — this is a STRONG
 * signal (a real customer never authenticates with one of these domains).
 */
export const SENTINEL_EMAIL_PATTERNS: RegExp[] = [
  /@example\.test$/i,
  /@example\.invalid$/i,
  /@r11-onboarding\.example\.test$/i,
  /@verity\.invalid$/i, // e.g. ta1-acceptance@verity.invalid
  /@test\.com$/i, // portal-web tests
];

/**
 * Classify a single tenant. Allowlist is checked FIRST so a versioned tenant
 * (the founder tenant has 0 account links + thousands of nodes) is never mistaken
 * for residue.
 */
export function classifyTenant(f: TenantFacts): TenantVerdict {
  const allow = (reason: string): TenantVerdict => ({ tenantId: f.tenantId, class: "allow", reason });
  const residue = (reason: string): TenantVerdict => ({ tenantId: f.tenantId, class: "residue", reason });
  const review = (reason: string): TenantVerdict => ({ tenantId: f.tenantId, class: "review", reason });

  // 0. Versioned/intentional tenants are never residue — even if link-less or empty.
  if (f.bootstrapped) return allow("versioned db/tenants/<id>/bootstrap.sql");

  const sentinelEmail = f.ownerEmails.find((e) => SENTINEL_EMAIL_PATTERNS.some((re) => re.test(e)));
  const pattern = TEST_TENANT_PATTERNS.find((re) => re.test(f.tenantId));
  const empty = f.nodeCount === 0 && f.linkCount === 0;
  const orphan = !f.inTenants;

  // 1. STRONG signals — each conclusive alone.
  if (sentinelEmail) return residue(`owned by a test sentinel account (${sentinelEmail})`);
  if (empty) {
    return residue(
      "empty: 0 nodes and 0 account links — abandoned/torn provisioning " +
        "(a real tenant is never 0+0; allowlist a hand-provisioned one via db/tenants/<id>/bootstrap.sql)",
    );
  }

  // 2. WEAK signals — require corroboration (>=2) to assert residue.
  const weak: string[] = [];
  if (pattern) weak.push(`test tenant-id pattern ${pattern.source}`);
  if (orphan) weak.push("orphan: referenced by links/identities/nodes but no tenants row");

  if (weak.length >= 2) return residue(weak.join(" + "));
  if (weak.length === 1) return review(`${weak[0]} (single weak signal — could be a real slug collision or mid-setup; review)`);
  return review("has data/links but no allowlist or residue signal — review manually");
}

/**
 * Read every CANDIDATE tenant from the target DB and classify it. Candidates are
 * the UNION of every place a tenant_id can appear — not just the `tenants` table —
 * so torn orphans (a leftover account link or hosted identity whose `tenants` row
 * was deleted) are surfaced, not silently missed. `bootstrappedIds` is the set of
 * tenant ids that have a `db/tenants/<id>/bootstrap.sql` (the allowlist), resolved
 * by the caller from the filesystem so this stays testable.
 */
export async function enumerateTenants(sql: any, bootstrappedIds: Set<string>): Promise<TenantVerdict[]> {
  const rows = await sql`
    WITH ids AS (
      -- Every place a LIVE tenant resource can survive after a torn teardown. Mirrors the
      -- set the TA1 teardown manages (agent-lab/scripts/ta1-acceptance/runner.ts
      -- TENANT_TABLES), so a tenant with residue in ONLY a credential / key-domain /
      -- journal / config row — and no tenants/links/identities/nodes row — is surfaced,
      -- not missed. Deliberately EXCLUDES append-only audit/event history
      -- (memory_events, hosted_audit_log): those intentionally RETAIN a legitimately-
      -- retired tenant's trail, so enumerating them would false-positive forever.
      SELECT tenant_id FROM tenants
      UNION SELECT tenant_id FROM account_tenant_links
      UNION SELECT tenant_id FROM hosted_tenant_identities
      UNION SELECT tenant_id FROM hosted_agent_credentials
      UNION SELECT tenant_id FROM hosted_nodes
      UNION SELECT tenant_id FROM hosted_mirror_items
      UNION SELECT tenant_id FROM remote_commands
      UNION SELECT tenant_id FROM tenant_day_journal_entries
      UNION SELECT tenant_id FROM golden_query_cases
      UNION SELECT tenant_id FROM review_proposals
      UNION SELECT tenant_id FROM agent_profiles
      UNION SELECT tenant_id FROM tenant_pyramids
      UNION SELECT tenant_id FROM tenant_key_domains
      UNION SELECT tenant_id FROM tenant_security_config
      UNION SELECT regexp_replace(space_id, '^tenant:', '') FROM nodes WHERE space_id LIKE 'tenant:%'
    )
    SELECT
      i.tenant_id,
      EXISTS (SELECT 1 FROM tenants t WHERE t.tenant_id = i.tenant_id) AS in_tenants,
      (SELECT count(*)::int FROM nodes n WHERE n.space_id = 'tenant:' || i.tenant_id) AS node_count,
      (SELECT count(*)::int FROM account_tenant_links l WHERE l.tenant_id = i.tenant_id) AS link_count,
      COALESCE((
        SELECT array_agg(a.email)
        FROM account_tenant_links l JOIN accounts a ON a.account_id = l.account_id
        WHERE l.tenant_id = i.tenant_id AND a.email IS NOT NULL
      ), ARRAY[]::text[]) AS owner_emails
    FROM ids i
    WHERE i.tenant_id IS NOT NULL AND i.tenant_id <> ''
    ORDER BY i.tenant_id
  `;
  return rows.map((r: any) =>
    classifyTenant({
      tenantId: r.tenant_id,
      inTenants: r.in_tenants === true,
      // node_count intentionally counts soft-deleted nodes (no visibility filter): a
      // tenant that EVER had a node is not empty-residue. Do NOT add visibility<>'deleted'
      // here or rule "empty" would flag real tenants whose nodes were soft-deleted.
      nodeCount: Number(r.node_count),
      linkCount: Number(r.link_count),
      ownerEmails: (r.owner_emails || []).filter(Boolean),
      bootstrapped: bootstrappedIds.has(r.tenant_id),
    }),
  );
}
