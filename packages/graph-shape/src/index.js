// packages/graph-shape/src/index.ts
var PYRAMID_PREFIX_BY_ID = {
  WORLD: "WD",
  FUNCTION: "FN",
  OPENCLAW: "OC",
  CLAUDECODE: "CC",
  CODEX: "CX",
  META: "META",
  PROJECTS: "PJ",
  TN: "TN",
  HEURISTIC: "HE",
  TEMPORAL: "TMP"
};
var PREFIX_TO_PYRAMID_ID = Object.fromEntries(Object.entries(PYRAMID_PREFIX_BY_ID).map(([pyramidId, prefix]) => [prefix, pyramidId]));
var VALID_NODE_TYPES = [
  "tool",
  "skill",
  "concept",
  "workflow",
  "procedure",
  "protocol",
  "anti-pattern",
  "project",
  "reference",
  "trend"
];
var VALID_EDGE_TYPES = [
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
  "validates"
];
var EDGE_TYPE_ALIASES = {
  "attack-surface-for": "attack_surface_for",
  "child-of": "child_of",
  "governed-by": "governed_by",
  "integrates-with": "integrates",
  "precursor-to": "precursor_to",
  "related-to": "related_to",
  "routes-to": "routes_to",
  "self-references": "self_references",
  integrates_with: "integrates",
  implements_pattern: "implements",
  "implements-pattern-similar-to": "implements",
  implements_pattern_similar_to: "implements",
  mirrors_pattern: "mirrors",
  parallels: "mirrors",
  mitigates: "constrains",
  mitigates_failures_in: "constrains",
  modifies: "constrains",
  manages: "governs",
  tracks: "governs",
  configures: "governs",
  coordinates: "governs",
  solves: "enables",
  improves: "enables",
  enhances: "enables",
  provides_environment_for: "enables",
  recommends: "guides",
  references: "related_to",
  inspired_by: "related_to",
  interacts_via: "related_to",
  precedes: "precursor_to",
  derived_from: "child_of",
  creates: "produces",
  provides_content_for: "provides",
  classifies: "specializes",
  evaluates: "validates"
};
var VALID_MATURITY_STAGES = [
  "discovery",
  "encoded",
  "enriched",
  "proven",
  "graduated",
  "consolidated",
  "archived",
  "permanent",
  "repair"
];
function isValidMaturityStage(value) {
  return typeof value === "string" && VALID_MATURITY_STAGES.includes(value);
}
function coalesceMaturityStage(value) {
  if (isValidMaturityStage(value))
    return value;
  return "encoded";
}
var CORE_PYRAMID_IDS = Object.keys(PYRAMID_PREFIX_BY_ID);
function canonicalizePyramidId(value) {
  if (!value)
    return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized)
    return null;
  if (normalized in PYRAMID_PREFIX_BY_ID)
    return normalized;
  return PREFIX_TO_PYRAMID_ID[normalized] || null;
}
var LEGACY_PREFIXES_BY_PYRAMID = {};
function pyramidAcceptsPrefix(pyramidId, prefix) {
  const canonical = canonicalizePyramidId(pyramidId);
  if (!canonical)
    return false;
  const nativePrefix = PYRAMID_PREFIX_BY_ID[canonical];
  if (nativePrefix === prefix)
    return true;
  const legacy = LEGACY_PREFIXES_BY_PYRAMID[canonical];
  if (legacy && legacy.has(prefix))
    return true;
  return false;
}
function prefixForPyramidId(value) {
  const pyramidId = canonicalizePyramidId(value);
  return pyramidId ? PYRAMID_PREFIX_BY_ID[pyramidId] : null;
}
function buildAddr(pyramidId, layer, depth, position) {
  const prefix = prefixForPyramidId(pyramidId);
  if (!prefix)
    throw new Error(`Unknown pyramid_id: ${pyramidId}`);
  return `${prefix}.${layer}.${depth}.${position}`;
}
var ADDR_SHAPE_STANDARD = /^[A-Z]{2,5}\.\d+\.\d+\.\d+$/;
var ADDR_SHAPE_DAY = /^TMP\.\d{4}\.\d{1,3}$/;
var ADDR_SHAPE_APEX = /^AO\.0\.0\.0$/;
var MAX_ADDR_INT = 2147483647;
function isAddrInt(text) {
  if (!/^\d+$/.test(text))
    return false;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= MAX_ADDR_INT;
}
function isStandardAddr(addr) {
  const parts = addr.split(".");
  if (parts.length !== 4 || !ADDR_SHAPE_STANDARD.test(addr))
    return false;
  const [prefix, layer, depth, position] = parts;
  if (!prefix || layer == null || depth == null || position == null)
    return false;
  return prefix !== "AO" && isAddrInt(layer) && isAddrInt(depth) && isAddrInt(position);
}
function isDayAddr(addr) {
  const match = /^TMP\.(\d{4})\.(\d{1,3})$/.exec(addr);
  if (!match)
    return false;
  const [, yearText, doyText] = match;
  const year = Number(yearText);
  const doy = Number(doyText);
  return Number.isInteger(year) && year >= 1970 && year <= 9999 && Number.isInteger(doy) && doy >= 1 && doy <= 366;
}
function isApexAddr(addr) {
  return ADDR_SHAPE_APEX.test(addr);
}
function isValidAddr(addr) {
  return isApexAddr(addr) || isDayAddr(addr) || isStandardAddr(addr);
}
function buildDayAddr(year, doy) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new Error(`buildDayAddr: invalid year ${year}`);
  }
  if (!Number.isInteger(doy) || doy < 1 || doy > 366) {
    throw new Error(`buildDayAddr: invalid doy ${doy}`);
  }
  return `TMP.${year}.${String(doy).padStart(3, "0")}`;
}
function addrBelongsToPyramid(addr, pyramidId) {
  if (!isValidAddr(addr))
    return false;
  const canonical = canonicalizePyramidId(pyramidId);
  if (!canonical)
    return false;
  if (isApexAddr(addr))
    return canonical === "META";
  if (isDayAddr(addr))
    return canonical === "TEMPORAL";
  const prefix = addr.split(".")[0] || "";
  return pyramidAcceptsPrefix(canonical, prefix);
}
function slugifyLabel(value, maxLength = 40) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength);
  return slug || "node";
}
function nodeTypeForWiAtom(atomType, subtype) {
  if (atomType === "SKILL")
    return "skill";
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
function canonicalizeEdgeType(value) {
  if (!value)
    return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const direct = normalized in EDGE_TYPE_ALIASES ? EDGE_TYPE_ALIASES[normalized] : normalized;
  if (VALID_EDGE_TYPES.includes(direct))
    return direct;
  return null;
}
var MINING_CROSS_MODE = "CROSS";
var MINING_ROTATION = [
  "PROJECTS",
  "FUNCTION",
  "WORLD",
  "META",
  "HEURISTIC",
  MINING_CROSS_MODE
];
var MOON_PYRAMIDS = [
  "FUNCTION",
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX"
];
function isMoonPyramid(value) {
  if (!value)
    return false;
  const normalized = value.trim().toUpperCase();
  return MOON_PYRAMIDS.includes(normalized);
}
var TRUTH_PYRAMIDS = new Set([
  "WORLD",
  "HEURISTIC"
]);
function isTruthPyramid(value) {
  if (!value)
    return false;
  const normalized = value.trim().toUpperCase();
  return TRUTH_PYRAMIDS.has(normalized);
}
var ANSWER_CAPABLE_PYRAMIDS = new Set([
  "FUNCTION",
  "META",
  "PROJECTS",
  "TN"
]);
var DURABLE_ANSWER_PYRAMIDS = [
  "FUNCTION",
  "META",
  "PROJECTS"
];
var TREND_WIRING_TARGET_PYRAMIDS = [
  "FUNCTION",
  "META"
];
var INTERNAL_SYSTEM_PYRAMIDS = new Set([
  "OPENCLAW",
  "META",
  "FUNCTION",
  "HEURISTIC"
]);
var ONTOLOGY_BRIDGE_PYRAMIDS = [
  "WORLD",
  "FUNCTION"
];
var DURABLE_ALIGNMENT_REFRESH_PYRAMIDS = [
  "META",
  "FUNCTION",
  "WORLD"
];
var ARCHIVED_PYRAMIDS = [
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX"
];
var WORLD_ALIGNMENT_PYRAMIDS = [
  ...ARCHIVED_PYRAMIDS,
  "META"
];
var ALIGNMENT_SKIP_PYRAMIDS = new Set([
  "TN",
  "PROJECTS"
]);
var DEPTH_GUARDED_PYRAMIDS = [
  "FUNCTION",
  "WORLD",
  "META",
  "OPENCLAW",
  "CLAUDECODE",
  "CODEX"
];
var SPHERE_PLANET_EXCLUDED_PYRAMIDS = [
  ...MOON_PYRAMIDS,
  "TEMPORAL"
];
var NON_ACTIONABLE_PYRAMIDS = new Set([
  "WORLD",
  "HEURISTIC",
  "TRUTH",
  "TN"
]);
export {
  slugifyLabel,
  pyramidAcceptsPrefix,
  prefixForPyramidId,
  nodeTypeForWiAtom,
  isValidMaturityStage,
  isValidAddr,
  isTruthPyramid,
  isStandardAddr,
  isMoonPyramid,
  isDayAddr,
  isApexAddr,
  coalesceMaturityStage,
  canonicalizePyramidId,
  canonicalizeEdgeType,
  buildDayAddr,
  buildAddr,
  addrBelongsToPyramid,
  WORLD_ALIGNMENT_PYRAMIDS,
  VALID_NODE_TYPES,
  VALID_MATURITY_STAGES,
  VALID_EDGE_TYPES,
  TRUTH_PYRAMIDS,
  TREND_WIRING_TARGET_PYRAMIDS,
  SPHERE_PLANET_EXCLUDED_PYRAMIDS,
  PYRAMID_PREFIX_BY_ID,
  PREFIX_TO_PYRAMID_ID,
  ONTOLOGY_BRIDGE_PYRAMIDS,
  NON_ACTIONABLE_PYRAMIDS,
  MOON_PYRAMIDS,
  MINING_ROTATION,
  MINING_CROSS_MODE,
  LEGACY_PREFIXES_BY_PYRAMID,
  INTERNAL_SYSTEM_PYRAMIDS,
  DURABLE_ANSWER_PYRAMIDS,
  DURABLE_ALIGNMENT_REFRESH_PYRAMIDS,
  DEPTH_GUARDED_PYRAMIDS,
  CORE_PYRAMID_IDS,
  ARCHIVED_PYRAMIDS,
  ANSWER_CAPABLE_PYRAMIDS,
  ALIGNMENT_SKIP_PYRAMIDS,
  ADDR_SHAPE_STANDARD,
  ADDR_SHAPE_DAY,
  ADDR_SHAPE_APEX
};
