/**
 * Browser-safe canonical pyramid taxonomy + pure graph-shape helpers.
 *
 * F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) extracted this surface
 * from `api/src/lib/graph-shape.ts` so frontend (`scope/`), API
 * (`api/`), miners (`miners/`), and operator scripts (`scripts/`,
 * `api/scripts/`) all import the same canonical pyramid registry,
 * legacy-prefix policy, semantic pyramid sets, mining rotation, and
 * pure address/edge helpers from one place.
 *
 * F5 amendments to the original `graph-shape.ts` source:
 *
 *   1. `PYRAMID_PREFIX_BY_ID` adds `TEMPORAL: "TMP"` (TEMPORAL is a
 *      live registry pyramid carrying day nodes at TMP.YYYY.DOY) and
 *      removes `SCHEMA: "SC"` (SCHEMA is dead source drift; live
 *      schema nodes live under FUNCTION as SC.* legacy addresses).
 *
 *   2. `LEGACY_PREFIXES_BY_PYRAMID` replaces the old single
 *      `LEGACY_FUNCTION_PREFIXES` set so the policy can be expressed
 *      per pyramid. FUNCTION still accepts the four migrated
 *      lineages (OC, CC, CX, SC). `pyramidAcceptsPrefix` is rebuilt
 *      on top of this map.
 *
 *   3. New auto-derived `CORE_PYRAMID_IDS` exports the canonical
 *      registry pyramid id list. `MINING_CROSS_MODE` and
 *      `MINING_ROTATION` capture the supercron rotation
 *      (PROJECTS → FUNCTION → WORLD → META → CROSS) where CROSS is a
 *      mining mode, NOT a registry pyramid.
 *
 *   4. New canonical semantic-pyramid sets (`MOON_PYRAMIDS`,
 *      `TRUTH_PYRAMIDS`, `ANSWER_CAPABLE_PYRAMIDS`,
 *      `DURABLE_ANSWER_PYRAMIDS`,
 *      `TREND_WIRING_TARGET_PYRAMIDS`,
 *      `INTERNAL_SYSTEM_PYRAMIDS`,
 *      `DURABLE_ALIGNMENT_REFRESH_PYRAMIDS`,
 *      `WORLD_ALIGNMENT_PYRAMIDS`,
 *      `ONTOLOGY_BRIDGE_PYRAMIDS`, `ARCHIVED_PYRAMIDS`,
 *      `ALIGNMENT_SKIP_PYRAMIDS`, `DEPTH_GUARDED_PYRAMIDS`,
 *      `SPHERE_PLANET_EXCLUDED_PYRAMIDS`,
 *      `NON_ACTIONABLE_PYRAMIDS`) replace duplicated literals
 *      previously scattered across the codebase.
 *
 * Browser-safety constraint: this package MUST NOT import `postgres`,
 * Bun internals, env, or any server-only module. The drift-guard
 * surface in `api/src/lib/foundation-state-drift.test.ts` enforces
 * this so `scope/` can keep depending on `@verity-one/graph-shape`
 * without pulling DB code into the browser bundle.
 */

export const PYRAMID_PREFIX_BY_ID = {
  WORLD: "WD",
  FUNCTION: "FN",
  OPENCLAW: "OC",
  CLAUDECODE: "CC",
  CODEX: "CX",
  META: "META",
  PROJECTS: "PJ",
  TN: "TN",
  HEURISTIC: "HE",
  TEMPORAL: "TMP",
} as const;

export const PREFIX_TO_PYRAMID_ID = Object.fromEntries(
  Object.entries(PYRAMID_PREFIX_BY_ID).map(([pyramidId, prefix]) => [prefix, pyramidId]),
) as Record<string, keyof typeof PYRAMID_PREFIX_BY_ID>;

export const VALID_NODE_TYPES = [
  "tool",
  "skill",
  "concept",
  "workflow",
  "procedure",
  "protocol",
  "anti-pattern",
  "project",
  "reference",
  "trend",
] as const;

// F12: 47 canonical edge types. Five first-class semantic types added
// (active_on, constrains, frames, grounds, guides) to absorb heavy-use
// memory + agent-activity edge writes that had drifted outside the canonical
// list. The DB-level CHECK constraint (edges_edge_type_check) and this
// list MUST stay in sync — drift guard pins it.
//
// F13: +1 → 48. `trend_affects` added as the canonical trend-engine edge
// type. miners/src/trends/service.ts inserts these (lines 2143, 2190);
// readers in api/src/routes/ops.ts, miners/src/reactor.ts, and seed/smoke
// scripts expect them. Pre-F13 the F12 CHECK rejected this edge_type, so
// `bun run db:reset` produced a database that the trends miner could not
// write into. F13 closes the producer/CHECK mismatch.
export const VALID_EDGE_TYPES = [
  "active_on",
  "alternative_to",
  "attack_surface_for",
  "causes",
  "child_of",
  "complements",
  "composes_with",
  "conflicts_with",
  "constrains",
  "contains",
  "contrasts",
  "depends_on",
  "enables",
  "executes",
  "extends",
  "feeds_into",
  "frames",
  "generates",
  "governed_by",
  "governs",
  "grounds",
  "guides",
  "implements",
  "informs",
  "integrates",
  "mirrors",
  "operationalizes",
  "parent_of",
  "part_of",
  "pattern_mirror",
  "precursor_to",
  "produces",
  "provides",
  "related",
  "related_to",
  "replaces",
  "requires",
  "routes_to",
  "self_references",
  "specializes",
  "specifies",
  "supports",
  "transitively_composes",
  "transitively_requires",
  "trend_affects",
  "unifies",
  "uses",
  "validates",
] as const;

// F12: long-tail aliases normalized to canonical types. Used by
// canonicalizeEdgeType() at the runtime write boundary AND mirrored by the
// db/foundation-rung-f12-edge-type-canonical.sql migration that backfills
// existing rows. Keep both in sync.
const EDGE_TYPE_ALIASES: Record<string, (typeof VALID_EDGE_TYPES)[number]> = {
  // F5 hyphen-form aliases
  "attack-surface-for": "attack_surface_for",
  "child-of": "child_of",
  "governed-by": "governed_by",
  "integrates-with": "integrates",
  "precursor-to": "precursor_to",
  "related-to": "related_to",
  "routes-to": "routes_to",
  "self-references": "self_references",
  // F12 long-tail typo/synonym normalization
  "integrates_with": "integrates",
  "implements_pattern": "implements",
  "implements-pattern-similar-to": "implements",
  "implements_pattern_similar_to": "implements",
  "mirrors_pattern": "mirrors",
  "parallels": "mirrors",
  "mitigates": "constrains",
  "mitigates_failures_in": "constrains",
  "modifies": "constrains",
  "manages": "governs",
  "tracks": "governs",
  "configures": "governs",
  "coordinates": "governs",
  "solves": "enables",
  "improves": "enables",
  "enhances": "enables",
  "provides_environment_for": "enables",
  "recommends": "guides",
  "references": "related_to",
  "inspired_by": "related_to",
  "interacts_via": "related_to",
  "precedes": "precursor_to",
  "derived_from": "child_of",
  "creates": "produces",
  "provides_content_for": "provides",
  "classifies": "specializes",
  "evaluates": "validates",
};

// F12: canonical 9-stage knowledge maturity lifecycle.
// Single source of truth for `nodes.substance->>'maturity_stage'`. The
// `nodes_maturity_stage_check` constraint mirrors this list. The stage
// progression `discovery -> encoded -> enriched -> proven -> graduated`
// is the documented promotion path; `consolidated` is a memory-side
// terminal-with-side-effect; `archived` and `permanent` are operator-only;
// `repair` is a failure flag that any other stage can transition into.
export const VALID_MATURITY_STAGES = [
  "discovery",
  "encoded",
  "enriched",
  "proven",
  "graduated",
  "consolidated",
  "archived",
  "permanent",
  "repair",
] as const;

export type KnownMaturityStage = (typeof VALID_MATURITY_STAGES)[number];

export function isValidMaturityStage(value: unknown): value is KnownMaturityStage {
  return typeof value === "string"
    && (VALID_MATURITY_STAGES as readonly string[]).includes(value);
}

// F12: read-side coalescer. Canonical-or-default. Returns the canonical
// stage if `value` is one of the 9 enum values; otherwise returns
// `'encoded'`. Never throws — write-boundary validation belongs in
// `advanceMaturity()` / write helpers, not in read coalescing.
export function coalesceMaturityStage(value: unknown): KnownMaturityStage {
  if (isValidMaturityStage(value)) return value;
  return "encoded";
}

export type KnownPyramidId = keyof typeof PYRAMID_PREFIX_BY_ID;
export type KnownNodeType = (typeof VALID_NODE_TYPES)[number];
export type KnownEdgeType = (typeof VALID_EDGE_TYPES)[number];

export const CORE_PYRAMID_IDS: readonly KnownPyramidId[] = Object.keys(
  PYRAMID_PREFIX_BY_ID,
) as KnownPyramidId[];

export function canonicalizePyramidId(value: string | null | undefined): KnownPyramidId | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized in PYRAMID_PREFIX_BY_ID) return normalized as KnownPyramidId;
  return (PREFIX_TO_PYRAMID_ID as Record<string, KnownPyramidId | undefined>)[normalized] || null;
}

// F6 emptied this map. Pre-F6, FUNCTION accepted OC/CC/CX/SC because
// example-tenant carried legacy addresses from the 2026-03-20 OpenClaw/Claude
// Code/Codex dissolution and from early SCHEMA-pyramid lineage. The
// F6 canonicalization migration rewrote those 944 nodes to native FN.*
// addrs; future tenants never produce legacy prefixes. The map is kept
// in source as `{}` so adding a new universal exception later is cheap
// without re-introducing a per-tenant carve-out.
export const LEGACY_PREFIXES_BY_PYRAMID: Partial<Record<KnownPyramidId, ReadonlySet<string>>> = {};

// LEGACY_FUNCTION_PREFIXES export removed in F6 — every FUNCTION node
// now uses the FN.* native prefix and the back-compat alias has no live
// callers.

export function pyramidAcceptsPrefix(pyramidId: string, prefix: string): boolean {
  const canonical = canonicalizePyramidId(pyramidId);
  if (!canonical) return false;
  const nativePrefix = PYRAMID_PREFIX_BY_ID[canonical];
  if (nativePrefix === prefix) return true;
  const legacy = LEGACY_PREFIXES_BY_PYRAMID[canonical];
  if (legacy && legacy.has(prefix)) return true;
  return false;
}

export function prefixForPyramidId(value: string): string | null {
  const pyramidId = canonicalizePyramidId(value);
  return pyramidId ? PYRAMID_PREFIX_BY_ID[pyramidId] : null;
}

export function buildAddr(pyramidId: string, layer: number, depth: number, position: number): string {
  const prefix = prefixForPyramidId(pyramidId);
  if (!prefix) throw new Error(`Unknown pyramid_id: ${pyramidId}`);
  return `${prefix}.${layer}.${depth}.${position}`;
}

// ── Address shape contract (F6) ────────────────────────────────────
// Three documented canonical address shapes. Every node addr matches
// exactly one. These are universal across all tenants — there are no
// per-tenant exceptions.
export const ADDR_SHAPE_STANDARD = /^[A-Z]{2,5}\.\d+\.\d+\.\d+$/;     // <PREFIX>.<L>.<D>.<P>
export const ADDR_SHAPE_DAY      = /^TMP\.\d{4}\.\d{1,3}$/;            // TMP.YYYY.DOY
export const ADDR_SHAPE_APEX     = /^AO\.0\.0\.0$/;                    // universal META apex
const MAX_ADDR_INT = 2147483647;                                       // Postgres int4 upper bound

function isAddrInt(text: string): boolean {
  if (!/^\d+$/.test(text)) return false;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= MAX_ADDR_INT;
}

export function isStandardAddr(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4 || !ADDR_SHAPE_STANDARD.test(addr)) return false;
  const [prefix, layer, depth, position] = parts;
  if (!prefix || layer == null || depth == null || position == null) return false;
  // AO is a reserved singleton prefix. AO.0.0.0 is valid only via
  // isApexAddr(); AO.0.0.1 and other AO content-shaped addrs are invalid.
  return prefix !== "AO" && isAddrInt(layer) && isAddrInt(depth) && isAddrInt(position);
}

export function isDayAddr(addr: string): boolean {
  const match = /^TMP\.(\d{4})\.(\d{1,3})$/.exec(addr);
  if (!match) return false;
  const [, yearText, doyText] = match;
  const year = Number(yearText);
  const doy = Number(doyText);
  return Number.isInteger(year) && year >= 1970 && year <= 9999
    && Number.isInteger(doy) && doy >= 1 && doy <= 366;
}

export function isApexAddr(addr: string): boolean {
  return ADDR_SHAPE_APEX.test(addr);
}

export function isValidAddr(addr: string): boolean {
  return isApexAddr(addr) || isDayAddr(addr) || isStandardAddr(addr);
}

export function buildDayAddr(year: number, doy: number): string {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new Error(`buildDayAddr: invalid year ${year}`);
  }
  if (!Number.isInteger(doy) || doy < 1 || doy > 366) {
    throw new Error(`buildDayAddr: invalid doy ${doy}`);
  }
  return `TMP.${year}.${String(doy).padStart(3, "0")}`;
}

// addrBelongsToPyramid is the single helper that combines shape +
// pyramid membership. It owns the universal AO/TMP exception logic so
// callsites don't need to special-case the apex or day-node lanes.
export function addrBelongsToPyramid(addr: string, pyramidId: string): boolean {
  if (!isValidAddr(addr)) return false;
  const canonical = canonicalizePyramidId(pyramidId);
  if (!canonical) return false;
  if (isApexAddr(addr)) return canonical === "META";
  if (isDayAddr(addr)) return canonical === "TEMPORAL";
  const prefix = addr.split(".")[0] || "";
  return pyramidAcceptsPrefix(canonical, prefix);
}

export function slugifyLabel(value: string, maxLength = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return slug || "node";
}

export function nodeTypeForWiAtom(
  atomType: "KNOWLEDGE" | "SKILL",
  subtype: string | null | undefined,
): KnownNodeType {
  if (atomType === "SKILL") return "skill";

  switch ((subtype || "").toLowerCase()) {
    case "tool":
      return "tool";
    case "workflow":
      return "workflow";
    case "technique":
      return "procedure";
    case "integration":
      return "protocol";
    case "framework":
      return "concept";
    case "claim":
    case "signal":
    default:
      return "concept";
  }
}

export function canonicalizeEdgeType(value: string | null | undefined): KnownEdgeType | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const direct = (normalized in EDGE_TYPE_ALIASES
    ? EDGE_TYPE_ALIASES[normalized]
    : normalized) as KnownEdgeType;
  if (VALID_EDGE_TYPES.includes(direct)) return direct;
  return null;
}

// ── Mining rotation ────────────────────────────────────────────────
// CROSS is the supercron sentinel for "run cross-pyramid mining with no
// pyramid filter." It is a scheduler mode, NOT a registry pyramid id —
// it must never appear in CORE_PYRAMID_IDS or be returned by
// canonicalizePyramidId.
export const MINING_CROSS_MODE = "CROSS" as const;
export type MiningCrossMode = typeof MINING_CROSS_MODE;
export const MINING_ROTATION: readonly (KnownPyramidId | MiningCrossMode)[] = [
  "PROJECTS",
  "FUNCTION",
  "WORLD",
  "META",
  "HEURISTIC",
  MINING_CROSS_MODE,
] as const;

// ── Semantic pyramid sets ──────────────────────────────────────────
// MOON_PYRAMIDS — the action/operator pyramids that sit "around"
// FUNCTION after the OC/CC/CX dissolution. Used by sphere/planet
// scoring and frontend visualization to colour the moon ring.
export const MOON_PYRAMIDS: readonly KnownPyramidId[] = [
  "FUNCTION",
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX",
] as const;

export function isMoonPyramid(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toUpperCase();
  return (MOON_PYRAMIDS as readonly string[]).includes(normalized);
}

// TRUTH_PYRAMIDS — pyramids that anchor reinforcement/grounding rather
// than answer authoring. Stored as a Set because the predominant
// caller pattern is membership checks (`TRUTH_PYRAMIDS.has(id)`).
export const TRUTH_PYRAMIDS: ReadonlySet<KnownPyramidId> = new Set([
  "WORLD",
  "HEURISTIC",
] as const);

export function isTruthPyramid(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toUpperCase();
  return TRUTH_PYRAMIDS.has(normalized as KnownPyramidId);
}

// ANSWER_CAPABLE_PYRAMIDS — pyramids that can author actionable
// answers in retrieval surfaces (the inverse of TRUTH_PYRAMIDS for
// answer/grounding split logic).
export const ANSWER_CAPABLE_PYRAMIDS: ReadonlySet<KnownPyramidId> = new Set([
  "FUNCTION",
  "META",
  "PROJECTS",
  "TN",
] as const);

// DURABLE_ANSWER_PYRAMIDS — answer-capable pyramids that participate in
// durable truth/resonance/grounding scripts. TN is intentionally excluded:
// trend nodes are transient and get trend-grounding via supercron.
export const DURABLE_ANSWER_PYRAMIDS: readonly KnownPyramidId[] = [
  "FUNCTION",
  "META",
  "PROJECTS",
] as const;

// TREND_WIRING_TARGET_PYRAMIDS — durable answer-side pyramids that
// orphan trend nodes may wire to during deterministic supercron edge
// repair. PROJECTS is intentionally excluded: trend discovery should
// attach to reusable knowledge/function structure, not tenant/project
// memory.
export const TREND_WIRING_TARGET_PYRAMIDS: readonly KnownPyramidId[] = [
  "FUNCTION",
  "META",
] as const;

// INTERNAL_SYSTEM_PYRAMIDS — pyramid ids whose rows should be treated as
// internal-system evidence during retrieval reranking. OPENCLAW remains
// here because legacy OC.* rows still carry operational/runtime context.
export const INTERNAL_SYSTEM_PYRAMIDS: ReadonlySet<KnownPyramidId> = new Set([
  "OPENCLAW",
  "META",
  "FUNCTION",
  "HEURISTIC",
] as const);

// ONTOLOGY_BRIDGE_PYRAMIDS — the two pyramids that the ontology-bridge
// helpers walk for cross-pyramid alignment. Public-only by design.
export const ONTOLOGY_BRIDGE_PYRAMIDS: readonly KnownPyramidId[] = [
  "WORLD",
  "FUNCTION",
] as const;

// DURABLE_ALIGNMENT_REFRESH_PYRAMIDS — registry/space count lanes that
// durable-alignment touches after writing ontology and resonance edges.
export const DURABLE_ALIGNMENT_REFRESH_PYRAMIDS: readonly KnownPyramidId[] = [
  "META",
  "FUNCTION",
  "WORLD",
] as const;

// ARCHIVED_PYRAMIDS — pyramids whose nodes/edges are excluded from
// public visibility surfaces after the OC/CC/CX dissolution. Their
// addresses still resolve under FUNCTION via LEGACY_PREFIXES_BY_PYRAMID,
// but the registry rows themselves are no longer surfaced.
export const ARCHIVED_PYRAMIDS: readonly KnownPyramidId[] = [
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX",
] as const;

// WORLD_ALIGNMENT_PYRAMIDS — archived FUNCTION-adjacent lineages plus
// META nodes that need world-grounding passes.
export const WORLD_ALIGNMENT_PYRAMIDS: readonly KnownPyramidId[] = [
  ...ARCHIVED_PYRAMIDS,
  "META",
] as const;

// ALIGNMENT_SKIP_PYRAMIDS — pyramids that durable-alignment refuses to
// align (transient trend membership and per-tenant project memory).
export const ALIGNMENT_SKIP_PYRAMIDS: ReadonlySet<KnownPyramidId> = new Set([
  "TN",
  "PROJECTS",
] as const);

// DEPTH_GUARDED_PYRAMIDS — pyramids where shallow-depth (depth ≤ 2)
// writes by non-operator submitters are rejected by qc-sentinel and
// VI delivery.
export const DEPTH_GUARDED_PYRAMIDS: readonly KnownPyramidId[] = [
  "FUNCTION",
  "WORLD",
  "META",
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX",
] as const;

// SPHERE_PLANET_EXCLUDED_PYRAMIDS — moon pyramids plus TEMPORAL.
// Sphere scoring counts a node's "planet" edges by excluding edges
// that terminate inside the moon ring (FUNCTION / OC / CC / CX) and
// edges that touch TEMPORAL day-node membership.
export const SPHERE_PLANET_EXCLUDED_PYRAMIDS: readonly KnownPyramidId[] = [
  ...MOON_PYRAMIDS,
  "TEMPORAL",
] as const;

// NON_ACTIONABLE_PYRAMIDS is typed separately because it includes the
// legacy non-registry sentinel "TRUTH" — older operator-facing flows
// (run/ground) defensively reject any node still tagged with the old
// TRUTH pyramid id even though it is no longer in PYRAMID_PREFIX_BY_ID.
export const NON_ACTIONABLE_PYRAMIDS: ReadonlySet<KnownPyramidId | "TRUTH"> = new Set([
  "WORLD",
  "HEURISTIC",
  "TRUTH",
  "TN",
] as const);
