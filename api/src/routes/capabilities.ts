/**
 * /capabilities — The scalable replacement for browsing /toc
 * 
 * Instead of dumping all 482+ nodes, an agent asks:
 *   "What can this system do?" → GET /capabilities
 *   "Who provides speech-to-text?" → GET /capabilities/speech-to-text
 *   "What's available for communication?" → GET /capabilities?domain=communication
 * 
 * This scales to 100K+ nodes because it's indexed on capabilities,
 * not on nodes. The directory is a materialized view, refreshed
 * on graph changes.
 */

import { Hono } from "hono";
import { sql } from "../db";
import { allowedRegistryAccessLevels, getAccessContext, visibleSpaceIds } from "../lib/access";
import { GLOBAL_SPACE_ID } from "../lib/spaces";
import { clampInt } from "../lib/utils";
import { errorJson } from "../lib/error-envelope";

const capabilities = new Hono();

// GET /capabilities — Full capability taxonomy
// Optional filters: ?domain=communication&type=tool&q=sms
capabilities.get("/", async (c) => {
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(getAccessContext(c));
  // Non-operator callers only see nodes in their visible spaces; operators
  // (spaceIds === null) get no space filter. Mirrors /context and /search.
  const nodeScope = spaceIds
    ? sql`AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )`
    : sql``;
  const domain = c.req.query("domain");
  const type = c.req.query("type"); // tool, skill, workflow
  const q = c.req.query("q"); // text filter on capability name
  const limit = clampInt(c.req.query("limit"), 100, 1, 500);
  const offset = clampInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // Build WHERE clause pieces — domain filter needs different qualifiers per query
  const whereQ = q ? sql`cap ILIKE ${'%' + q + '%'}` : sql`true`;
  const domainJsonb = domain ? sql`${sql.json([domain])}` : null;
  const whereDomainVisible = domainJsonb ? sql`visible.domains @> ${domainJsonb}` : sql`true`;
  const whereAll = sql`${whereQ} AND ${whereDomainVisible}`;

  const results = await sql`
    SELECT
      d.cap,
      visible.provider_count,
      visible.domains,
      (visible.providers->0->>'label') AS top_provider,
      (visible.providers->0->>'addr') AS top_addr,
      (visible.providers->0->>'cost') AS cost
    FROM v_capability_directory d
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(jsonb_agg(vp.provider ORDER BY vp.ord), '[]'::jsonb) AS providers,
        COUNT(*)::int AS provider_count,
        COALESCE((
          SELECT jsonb_agg(DISTINCT domain)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(n.substance->'domains', '[]'::jsonb)) AS domain
            FROM jsonb_array_elements(d.providers) WITH ORDINALITY AS p(provider, ord)
            JOIN nodes n ON n.addr = p.provider->>'addr'
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE r.access_level = ANY(${accessLevels}::text[])
              AND n.visibility = 'public'
              ${nodeScope}
          ) visible_domains
        ), '[]'::jsonb) AS domains
      FROM (
        SELECT p.provider, p.ord
        FROM jsonb_array_elements(d.providers) WITH ORDINALITY AS p(provider, ord)
        JOIN nodes n ON n.addr = p.provider->>'addr'
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE r.access_level = ANY(${accessLevels}::text[])
          AND n.visibility = 'public'
          ${nodeScope}
      ) vp
    ) visible
    WHERE ${whereAll}
      AND visible.provider_count > 0
    ORDER BY visible.provider_count DESC, d.cap
    LIMIT ${limit} OFFSET ${offset}`;

  // Filtered count matches the query, not the whole table
  const whereDomainCount = domainJsonb ? sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(d.providers) p
    JOIN nodes n ON n.addr = p->>'addr'
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.substance->'domains' @> ${domainJsonb}
      AND n.visibility = 'public'
      AND r.access_level = ANY(${accessLevels}::text[])
      ${nodeScope}
  )` : sql`true`;
  const [filtered] = await sql`
    SELECT COUNT(*) AS cnt
    FROM v_capability_directory d
    WHERE ${whereQ} AND ${whereDomainCount}
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(d.providers) provider
        JOIN nodes n ON n.addr = provider->>'addr'
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE r.access_level = ANY(${accessLevels}::text[])
          AND n.visibility = 'public'
          ${nodeScope}
      )`;
  const filteredTotal = parseInt(filtered.cnt);

  const [globalStats] = await sql`
    SELECT 
      COUNT(*) AS total_capabilities,
      (
        SELECT COUNT(*)
        FROM nodes n
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE n.visibility='public'
          AND n.node_type IN ('tool','skill','workflow')
          AND r.access_level = ANY(${accessLevels}::text[])
          ${nodeScope}
      ) AS total_providers,
      (
        SELECT jsonb_agg(DISTINCT d)
        FROM (
          SELECT jsonb_array_elements_text(v.domains) AS d
          FROM v_capability_directory v
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v.providers) provider
            JOIN nodes n ON n.addr = provider->>'addr'
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE r.access_level = ANY(${accessLevels}::text[])
              AND n.visibility = 'public'
              ${nodeScope}
          )
        ) domain_values
      ) AS all_domains
    FROM v_capability_directory v
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v.providers) provider
      JOIN nodes n ON n.addr = provider->>'addr'
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE r.access_level = ANY(${accessLevels}::text[])
        AND n.visibility = 'public'
        ${nodeScope}
    )`;

  return c.json({
    total: filteredTotal,
    total_all: parseInt(globalStats.total_capabilities),
    providers: parseInt(globalStats.total_providers),
    domains: globalStats.all_domains,
    capabilities: results,
    pagination: {
      limit,
      offset,
      returned: results.length,
      filtered_total: filteredTotal,
      has_more: offset + results.length < filteredTotal,
      next: offset + results.length < filteredTotal
        ? `/capabilities?${domain ? `domain=${domain}&` : ''}${q ? `q=${q}&` : ''}limit=${limit}&offset=${offset + limit}`
        : null,
    },
    drill: {
      by_capability: "GET /capabilities/<name> — all providers for a capability",
      by_domain: "GET /capabilities?domain=<domain> — all capabilities in a domain",
      by_text: "GET /capabilities?q=<search> — text search on capability names",
      semantic: "GET /context?q=<natural language>&depth=deep — embedding-based search",
    },
  });
});

// GET /capabilities/:name — All providers for a specific capability
capabilities.get("/:name", async (c) => {
  const accessLevels = allowedRegistryAccessLevels(c);
  const spaceIds = visibleSpaceIds(getAccessContext(c));
  // Non-operator callers only see nodes in their visible spaces; operators
  // (spaceIds === null) get no space filter. Mirrors /context and /search.
  const nodeScope = spaceIds
    ? sql`AND n.space_id = ANY(${spaceIds}::text[])
          AND (
            n.space_id <> ${GLOBAL_SPACE_ID}
            OR (n.visibility = 'public' AND r.access_level = ANY(${accessLevels}::text[]))
          )`
    : sql``;
  const name = c.req.param("name");

  let [result] = await sql`
    SELECT
      v.cap,
      visible.providers,
      visible.provider_count,
      visible.domains
    FROM v_capability_directory v
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(jsonb_agg(vp.provider ORDER BY vp.ord), '[]'::jsonb) AS providers,
        COUNT(*)::int AS provider_count,
        COALESCE((
          SELECT jsonb_agg(DISTINCT domain)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(n.substance->'domains', '[]'::jsonb)) AS domain
            FROM jsonb_array_elements(v.providers) WITH ORDINALITY AS p(provider, ord)
            JOIN nodes n ON n.addr = p.provider->>'addr'
            JOIN registry r ON r.pyramid_id = n.pyramid_id
            WHERE r.access_level = ANY(${accessLevels}::text[])
              AND n.visibility = 'public'
              ${nodeScope}
          ) visible_domains
        ), '[]'::jsonb) AS domains
      FROM (
        SELECT p.provider, p.ord
        FROM jsonb_array_elements(v.providers) WITH ORDINALITY AS p(provider, ord)
        JOIN nodes n ON n.addr = p.provider->>'addr'
        JOIN registry r ON r.pyramid_id = n.pyramid_id
        WHERE r.access_level = ANY(${accessLevels}::text[])
          AND n.visibility = 'public'
          ${nodeScope}
      ) vp
    ) visible
    WHERE cap = ${name}
      AND visible.provider_count > 0`;

  if (!result) {
    const liveProviders = await sql`
      SELECT
        n.addr,
        n.label,
        n.node_type,
        n.confidence,
        ROUND(n.resonance::numeric, 3) AS resonance,
        (n.substance -> 'readiness' ->> 'cost') AS cost,
        n.substance->'domains' AS domains
      FROM nodes n
      JOIN registry r ON r.pyramid_id = n.pyramid_id
      WHERE n.visibility = 'public'
        AND r.access_level = ANY(${accessLevels}::text[])
        AND (n.substance -> 'provides') ? ${name}
        ${nodeScope}
      ORDER BY n.confidence DESC, n.resonance DESC, n.addr
    `;

    if (liveProviders.length > 0) {
      const domains = [...new Set(
        liveProviders.flatMap((row: any) => Array.isArray(row.domains) ? row.domains : [])
      )];
      result = {
        cap: name,
        provider_count: liveProviders.length,
        domains,
        providers: liveProviders.map((row: any) => ({
          addr: row.addr,
          label: row.label,
          type: row.node_type,
          confidence: row.confidence,
          resonance: row.resonance,
          cost: row.cost,
        })),
      };
    }
  }

  if (!result) {
    // Fuzzy match
    const fuzzy = await sql`
      SELECT cap, provider_count
      FROM v_capability_directory v
      WHERE cap ILIKE ${'%' + name + '%'}
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v.providers) provider
          JOIN nodes n ON n.addr = provider->>'addr'
          JOIN registry r ON r.pyramid_id = n.pyramid_id
          WHERE r.access_level = ANY(${accessLevels}::text[])
            AND n.visibility = 'public'
            ${nodeScope}
        )
      ORDER BY provider_count DESC
      LIMIT 5`;
    
    return errorJson(c, "not_found", {
      message: `No exact match for "${name}"`,
      details: { did_you_mean: fuzzy.map((f: any) => f.cap) },
    });
  }

  // Get conflict edges between providers. Both endpoints are bounded to
  // providerAddrs, which is already space-scoped by the nodeScope filter on the
  // providers query above — so an edge can only appear when BOTH endpoints are
  // caller-readable. No extra node join / space predicate is needed (and adding
  // one would be a redundant unguarded JOIN nodes).
  const providerAddrs = (result.providers as any[]).map((p: any) => p.addr);
  const conflicts = providerAddrs.length > 1
    ? await sql`
        SELECT from_addr, to_addr, label
        FROM edges
        WHERE edge_type = 'conflicts_with'
          AND from_addr = ANY(${providerAddrs})
          AND to_addr = ANY(${providerAddrs})`
    : [];

  return c.json({
    capability: result.cap,
    provider_count: result.provider_count,
    domains: result.domains,
    providers: result.providers,
    conflicts,
    check: `GET /check/<addr> — verify readiness before using a provider`,
  });
});

export { capabilities };
