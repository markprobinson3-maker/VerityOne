/**
 * v3 Seed Script — Heuristic + Schema nodes for Context Compiler architecture
 *
 * Creates:
 * - HEURISTIC pyramid with 10 heuristic nodes (H-001 to H-010)
 * - SCHEMA pyramid (uses FUNCTION) with 5 schema nodes (S-001 to S-005)
 * - Embeddings for all nodes via embedQuery()
 * - Sets maturity_stage on all existing nodes
 * - Reframes anti-pattern nodes to positive framing
 *
 * Run: bun run api/src/seeds/v3-heuristics.ts
 */

import { embedTextForInsert, embeddingTextForNode, EMBED_MODEL } from "../lib/embed";
import { createDirectSql } from "../lib/db-config";
import { coalesceMaturityStage } from "@verity-one/graph-shape";

// Seed script — laptop/CI only. `max: 5` is the seed-script ceiling
// (lower than the long-lived `createDirectSql()` default of 40).
const sql = createDirectSql({ max: 5 });

interface HeuristicNode {
  addr: string;
  label: string;
  heuristic_text: string;
  elaboration: string;
  source_eps: string[];
}

interface SchemaNode {
  addr: string;
  label: string;
  schema_purpose: string;
  when_active: string;
  stages: string[];
}

const HEURISTICS: HeuristicNode[] = [
  {
    addr: "HE.0.2.1",
    label: "H-001: Verify Against the Destination",
    heuristic_text: "Verify against the destination system, not your own output.",
    elaboration: "The source of truth is always the external system you are writing to. Your internal state is a draft — confirm the write landed by reading it back from where it lives.",
    source_eps: ["EP-001"],
  },
  {
    addr: "HE.0.2.2",
    label: "H-002: Confirm at Every Boundary",
    heuristic_text: "At every chain boundary, confirm the previous step succeeded.",
    elaboration: "Multi-step workflows fail silently at handoff points. Insert a verification check between each step — the cost of one check is far less than the cost of propagating a silent failure.",
    source_eps: ["EP-002", "EP-009"],
  },
  {
    addr: "HE.0.2.3",
    label: "H-003: Persist to File",
    heuristic_text: "Write it down. If it is not in a file, it does not persist.",
    elaboration: "Context windows expire, sessions end, memory fades. The only durable state is what has been written to disk, committed to a database, or pushed to a repository.",
    source_eps: ["EP-003", "EP-010", "EP-029"],
  },
  {
    addr: "HE.0.2.4",
    label: "H-004: Fewer Options, Better Decisions",
    heuristic_text: "Fewer options produce better decisions. Show only what is relevant.",
    elaboration: "Choice overload degrades decision quality. Curate aggressively — present the 3-7 most relevant items rather than everything available. Context compression is a feature, not a limitation.",
    source_eps: ["EP-011", "EP-013", "EP-014"],
  },
  {
    addr: "HE.0.2.5",
    label: "H-005: Plan Small, Then Execute",
    heuristic_text: "Plan the smallest thing that satisfies the goal. Then execute.",
    elaboration: "Over-planning wastes energy on branches that may never be reached. Find the minimum viable plan, execute it, observe the result, then plan the next increment.",
    source_eps: ["EP-023", "EP-024"],
  },
  {
    addr: "HE.0.2.6",
    label: "H-006: Measure by Rework Needed",
    heuristic_text: "Measure quality by how little rework the output needs.",
    elaboration: "First-pass quality is the strongest signal of competence. An output that needs three rounds of revision consumed more total resources than one that landed correctly the first time.",
    source_eps: ["EP-018", "EP-022", "EP-026"],
  },
  {
    addr: "HE.0.2.7",
    label: "H-007: Describe the Positive Target",
    heuristic_text: "Describe what good looks like. Let constraints live at the edges.",
    elaboration: "Positive specifications are easier to verify and harder to misinterpret. Define the desired state explicitly; only add constraints where boundary conditions genuinely need guarding.",
    source_eps: ["EP-034", "EP-035"],
  },
  {
    addr: "HE.0.2.8",
    label: "H-008: Encode Proven Paths",
    heuristic_text: "Once a path is proven, encode it deterministically. Stop re-reasoning.",
    elaboration: "Re-deriving known answers wastes compute and introduces variance. When a workflow has been validated multiple times, freeze it into a deterministic script or template.",
    source_eps: ["EP-036", "EP-037", "EP-038"],
  },
  {
    addr: "HE.0.2.9",
    label: "H-009: Name Risks Before Acting",
    heuristic_text: "Name the top 3 risks before starting any significant action.",
    elaboration: "Explicit risk enumeration forces honest assessment. If you cannot name three things that could go wrong, you do not understand the action well enough to take it.",
    source_eps: ["EP-025"],
  },
  {
    addr: "HE.0.2.10",
    label: "H-010: Seven in Context Beats Seven Hundred Available",
    heuristic_text: "The right 7 things in context beat 700 things available.",
    elaboration: "Relevance scales inversely with volume. A small, curated context window outperforms a large, unfocused one every time. The bottleneck is selection quality, not knowledge quantity.",
    source_eps: ["EP-032", "EP-033"],
  },
];

const SCHEMAS: SchemaNode[] = [
  {
    addr: "SC.0.2.1",
    label: "S-001: Internal vs External",
    schema_purpose: "Determine whether a query falls inside Verity One's knowledge or requires external sources.",
    when_active: "Every query",
    stages: ["classify_query", "check_coverage", "route_or_redirect"],
  },
  {
    addr: "SC.0.2.2",
    label: "S-002: Retrieve, Transform, Act",
    schema_purpose: "Classify the operation type: is the agent retrieving information, transforming data, or executing an action?",
    when_active: "Every task",
    stages: ["retrieve", "transform", "act"],
  },
  {
    addr: "SC.0.2.3",
    label: "S-003: Spec, Plan, Verify, Ship",
    schema_purpose: "Operator loop for build tasks. Ensures specification precedes planning, verification precedes shipping.",
    when_active: "Build and create tasks",
    stages: ["spec", "plan", "verify", "ship"],
  },
  {
    addr: "SC.0.2.4",
    label: "S-004: Gate Sequence",
    schema_purpose: "Checkpoint framework for multi-step work. Each gate must pass before proceeding to the next stage.",
    when_active: "Multi-step workflows",
    stages: ["gate_1_requirements", "gate_2_design", "gate_3_implementation", "gate_4_verification", "gate_5_deployment", "gate_6_monitoring"],
  },
  {
    addr: "SC.0.2.5",
    label: "S-005: Knowledge Lifecycle",
    schema_purpose: "Assess where a piece of knowledge sits in its lifecycle: discovery through graduation to deterministic execution.",
    when_active: "Maturity evaluation",
    stages: ["discovery", "encoded", "enriched", "proven", "graduated"],
  },
];

const ANTI_PATTERN_REFRAMES: Record<string, { label: string; description: string }> = {
  "OC.0.2.210": {
    label: "Use Structured Env Var Access",
    description: "Access environment variables through structured configuration objects or validated wrappers, not raw echo commands. This prevents accidental exposure and provides clear error messages for missing values.",
  },
  "OC.0.2.211": {
    label: "Use Cost-Appropriate Models for Automation",
    description: "Match model selection to task complexity. Scheduled and automated tasks should use the most cost-effective model that meets quality requirements, reserving expensive models for complex reasoning.",
  },
  "OC.0.2.212": {
    label: "Complete Node Insertion with All Required Fields",
    description: "When inserting nodes, include all required fields (embedding, hash, provenance, substance). Partial insertions create orphaned or invisible nodes that degrade graph quality.",
  },
  "OC.0.2.213": {
    label: "Use Portable Path References",
    description: "Reference paths relative to project roots or well-known environment variables. Hardcoded workspace-specific paths break when configuration changes or when other agents access the same knowledge.",
  },
  "OC.0.2.214": {
    label: "Use Precise Capability Names",
    description: "Name capabilities with enough specificity to distinguish them from adjacent concepts. Ambiguous names cause misrouting and force agents to inspect node substance to determine relevance.",
  },
  "OC.0.2.440": {
    label: "Preserve Structural Purity in Factor Graphs",
    description: "Maintain clean semantic boundaries between factor nodes. Semantic corruption occurs when a node's meaning drifts to cover adjacent but distinct concepts, degrading retrieval precision.",
  },
  "OC.0.2.441": {
    label: "Distribute Load Across Nodes",
    description: "Prevent any single node from becoming an over-connected hub. When a node accumulates too many edges, split its responsibilities into specialized sub-nodes to maintain graph navigability.",
  },
  "OC.0.2.442": {
    label: "Preserve Data Through Supersession",
    description: "When superseding a node or edge, archive the previous version before replacing it. Destructive supersession loses historical context that may be needed for audit, rollback, or provenance tracking.",
  },
  "OC.0.2.448": {
    label: "Restart Next.js Server After Build",
    description: "After running next build, always restart the Next.js server process. The old server continues serving stale compiled output until the process is replaced.",
  },
  "OC.0.2.449": {
    label: "Persist Context Across Sessions",
    description: "Save work products, decisions, and intermediate state to durable storage before session boundaries. Context loss between sessions causes duplicate work and inconsistent outcomes.",
  },
  "OC.0.2.450": {
    label: "Use Dedicated Routing Configuration",
    description: "Route agent traffic through dedicated routing tables, not by modifying guild configuration. Guild config changes have broad side effects that extend beyond the intended routing change.",
  },
  "OC.0.2.451": {
    label: "Fix Root Causes Systemically",
    description: "When a problem recurs, invest in the systemic fix rather than patching the symptoms each time. Reactive firefighting accumulates technical debt faster than it resolves incidents.",
  },
  "OC.0.2.452": {
    label: "Compute at Query Time",
    description: "For values that depend on changing inputs, compute them fresh at query time rather than storing stale snapshots. Cached computed values silently drift from reality as their inputs change.",
  },
  "OC.0.2.453": {
    label: "Use Multi-Dimensional Confidence",
    description: "Represent confidence as a multi-dimensional signal (per-domain, per-source, per-recency) rather than a single scalar. Single-scalar confidence hides important distinctions between types of certainty.",
  },
  "FN.0.2.76": {
    label: "Use Client Components for React Hooks",
    description: "React hooks (useState, useEffect, etc.) require client components. Mark components that use hooks with 'use client' directive. Server components provide data; client components provide interactivity.",
  },
  "OC.0.2.500": {
    label: "Authenticate Next.js API Routes",
    description: "All Next.js API routes that modify state or return sensitive data must include authentication middleware. Unauthenticated routes are the most common vector for unauthorized access.",
  },
  "OC.0.2.501": {
    label: "Separate Server and Client Component Concerns",
    description: "Keep data fetching in server components and interactivity in client components. Mixing these concerns causes hydration errors and prevents server-side rendering optimizations.",
  },
};

async function hashSubstance(substance: any): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(substance));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function main() {
  console.log("=== v3 Seed: Heuristic + Schema nodes ===\n");

  // 1. Register HEURISTIC pyramid (if not exists)
  console.log("1. Registering pyramids...");
  await sql`
    INSERT INTO registry (pyramid_id, label, description, access_level)
    VALUES ('HEURISTIC', 'Heuristics', 'One-sentence reasoning truths that survive context rot. The core grounding layer of the context compiler.', 'public')
    ON CONFLICT (pyramid_id) DO UPDATE SET
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      access_level = EXCLUDED.access_level`;

  // SCHEMA nodes go in FUNCTION pyramid (they are operational routing frameworks)
  // No separate SCHEMA pyramid needed — schemas are discoverable nodes within FUNCTION
  console.log("   HEURISTIC pyramid registered");

  // 2. Generate embeddings for all nodes (F7 document task type via
  //    embedTextForInsert; each call writes the four embedding marker
  //    columns on INSERT/UPDATE).
  console.log("\n2. Generating embeddings...");
  const heuristicTexts = HEURISTICS.map(
    (h) => `${h.label}: ${h.heuristic_text} ${h.elaboration}`,
  );
  const schemaTexts = SCHEMAS.map(
    (s) => `${s.label}: ${s.schema_purpose} Active: ${s.when_active}. Stages: ${s.stages.join(", ")}`,
  );
  const heuristicEmbeds = await Promise.all(heuristicTexts.map((t) => embedTextForInsert(t)));
  const schemaEmbeds = await Promise.all(schemaTexts.map((t) => embedTextForInsert(t)));
  console.log(`   Got ${heuristicEmbeds.length + schemaEmbeds.length} embeddings (${EMBED_MODEL})`);

  // 3. Insert heuristic nodes
  console.log("\n3. Inserting heuristic nodes...");
  for (let i = 0; i < HEURISTICS.length; i++) {
    const h = HEURISTICS[i];
    const substance = {
      description: h.heuristic_text,
      heuristic_text: h.heuristic_text,
      elaboration: h.elaboration,
      source_eps: h.source_eps,
      maturity_stage: "proven",
    };
    const hash = await hashSubstance(substance);
    const embed = heuristicEmbeds[i];

    await sql`
      INSERT INTO nodes (
        addr, pyramid_id, layer, depth, position, label, substance, hash, provenance,
        visibility, confidence, space_id, node_type,
        embedding_hv, embedding_at, embedding_model, embedding_task_type
      )
      VALUES (
        ${h.addr}, 'HEURISTIC', 1, 2, ${i + 1}, ${h.label},
        ${sql.json(substance)}, ${hash},
        ${sql.json({ agent: "v3-seed", source: "verity-one-v3-spec" })},
        'public', 0.95, 'global', 'heuristic',
        ${embed.vecStr}::halfvec(3072),
        ${embed.embeddedAt},
        ${embed.model},
        ${embed.taskType}
      )
      ON CONFLICT (addr) DO UPDATE SET
        label = EXCLUDED.label,
        substance = EXCLUDED.substance,
        hash = EXCLUDED.hash,
        embedding_hv = EXCLUDED.embedding_hv,
        embedding_at = EXCLUDED.embedding_at,
        embedding_model = EXCLUDED.embedding_model,
        embedding_task_type = EXCLUDED.embedding_task_type,
        confidence = EXCLUDED.confidence,
        updated_at = now()`;
    console.log(`   ✓ ${h.addr}: ${h.label}`);
  }

  // 4. Insert schema nodes (into FUNCTION pyramid)
  console.log("\n4. Inserting schema nodes...");
  for (let i = 0; i < SCHEMAS.length; i++) {
    const s = SCHEMAS[i];
    const substance = {
      description: s.schema_purpose,
      schema_purpose: s.schema_purpose,
      when_active: s.when_active,
      stages: s.stages,
      maturity_stage: "proven",
    };
    const hash = await hashSubstance(substance);
    const embed = schemaEmbeds[i];

    await sql`
      INSERT INTO nodes (
        addr, pyramid_id, layer, depth, position, label, substance, hash, provenance,
        visibility, confidence, space_id, node_type,
        embedding_hv, embedding_at, embedding_model, embedding_task_type
      )
      VALUES (
        ${s.addr}, 'FUNCTION', 1, 2, ${554 + i}, ${s.label},
        ${sql.json(substance)}, ${hash},
        ${sql.json({ agent: "v3-seed", source: "verity-one-v3-spec" })},
        'public', 0.95, 'global', 'schema',
        ${embed.vecStr}::halfvec(3072),
        ${embed.embeddedAt},
        ${embed.model},
        ${embed.taskType}
      )
      ON CONFLICT (addr) DO UPDATE SET
        label = EXCLUDED.label,
        substance = EXCLUDED.substance,
        hash = EXCLUDED.hash,
        embedding_hv = EXCLUDED.embedding_hv,
        embedding_at = EXCLUDED.embedding_at,
        embedding_model = EXCLUDED.embedding_model,
        embedding_task_type = EXCLUDED.embedding_task_type,
        confidence = EXCLUDED.confidence,
        node_type = 'schema',
        updated_at = now()`;
    console.log(`   ✓ ${s.addr}: ${s.label}`);
  }

  // 5. Set maturity_stage on all existing nodes
  console.log("\n5. Setting maturity_stage on existing nodes...");

  // Default: encoded
  const encodedStage = coalesceMaturityStage(undefined);
  await sql`
    UPDATE nodes
    SET substance = substance || ${sql.json({ maturity_stage: encodedStage })}::jsonb
    WHERE substance->>'maturity_stage' IS NULL`;
  const [defaultCount] = await sql`
    SELECT COUNT(*)::int AS n FROM nodes
    WHERE substance->>'maturity_stage' = ${encodedStage}`;
  console.log(`   Default (encoded): ${defaultCount.n} nodes`);

  // Nodes with quick_start → enriched
  const enrichedStage = coalesceMaturityStage("enriched");
  await sql`
    UPDATE nodes
    SET substance = jsonb_set(substance, '{maturity_stage}', to_jsonb(${enrichedStage}::text))
    WHERE substance->'quick_start' IS NOT NULL
      AND substance->>'quick_start' != 'null'
      AND substance->>'maturity_stage' = ${encodedStage}`;
  const [enrichedCount] = await sql`
    SELECT COUNT(*)::int AS n FROM nodes
    WHERE substance->>'maturity_stage' = ${enrichedStage}`;
  console.log(`   Enriched (has quick_start): ${enrichedCount.n} nodes`);

  // High-traffic nodes with quick_start → proven
  await sql`
    UPDATE nodes
    SET substance = jsonb_set(substance, '{maturity_stage}', '"proven"')
    WHERE query_hits > 20
      AND substance->'quick_start' IS NOT NULL
      AND substance->>'quick_start' != 'null'
      AND substance->>'maturity_stage' IN ('encoded', 'enriched')`;
  const [provenCount] = await sql`
    SELECT COUNT(*)::int AS n FROM nodes
    WHERE substance->>'maturity_stage' = 'proven'`;
  console.log(`   Proven (high-traffic + quick_start): ${provenCount.n} nodes`);

  // 6. Reframe anti-pattern nodes
  console.log("\n6. Reframing anti-pattern nodes to positive framing...");
  for (const [addr, reframe] of Object.entries(ANTI_PATTERN_REFRAMES)) {
    const [existing] = await sql`SELECT addr FROM nodes WHERE addr = ${addr}`;
    if (!existing) {
      console.log(`   ⚠ ${addr} not found, skipping`);
      continue;
    }
    const reframeEmbed = await embedTextForInsert(
      embeddingTextForNode(reframe.label, { description: reframe.description }),
    );
    await sql`
      UPDATE nodes
      SET label = ${reframe.label},
          substance = jsonb_set(substance, '{description}', ${JSON.stringify(reframe.description)}::jsonb),
          embedding_hv = ${reframeEmbed.vecStr}::halfvec(3072),
          embedding_at = ${reframeEmbed.embeddedAt},
          embedding_model = ${reframeEmbed.model},
          embedding_task_type = ${reframeEmbed.taskType},
          updated_at = now()
      WHERE addr = ${addr}`;
    console.log(`   ✓ ${addr}: → ${reframe.label}`);
  }

  // 7. Update registry counts
  // F5: delegate to the canonical refresh_registry_counts() function
  // (db/foundation-rung-f5-pyramid-counts.sql) instead of carrying a
  // duplicate count query that only scanned from_addr and missed any
  // pyramid whose addr prefix differs from its registry id.
  console.log("\n7. Updating registry counts...");
  await sql`SELECT refresh_registry_counts()`;
  console.log("   ✓ Registry counts updated");

  // Summary
  const [summary] = await sql`
    SELECT
      (SELECT COUNT(*) FROM nodes WHERE pyramid_id = 'HEURISTIC') AS heuristic_count,
      (SELECT COUNT(*) FROM nodes WHERE node_type = 'schema') AS schema_count,
      (SELECT COUNT(*) FROM nodes WHERE substance->>'maturity_stage' IS NOT NULL) AS maturity_count`;
  console.log(`\n=== Done ===`);
  console.log(`Heuristic nodes: ${summary.heuristic_count}`);
  console.log(`Schema nodes: ${summary.schema_count}`);
  console.log(`Nodes with maturity_stage: ${summary.maturity_count}`);

  await sql.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
