/**
 * Zero-dependency registry of resource identifiers.
 *
 * Mirrors the pattern of `tools/names.ts`: this module must NEVER
 * import zod or anything from the individual resource modules.
 * Doctor and other zero-dep consumers import from here without
 * pulling the full resource tree.
 *
 * Drift guard lives in `resources/index.test.ts` and pins these
 * constants equal to `DERIVED_*` values computed at runtime from
 * the actual `RESOURCES` array.
 */

export const RESOURCE_STATIC_URIS = [
  "vo://server/status",
  "vo://memory/review/pending",
] as const;

export const RESOURCE_TEMPLATE_URIS = [
  "vo://memory/{addr}",
  "vo://memory/{addr}/audit",
] as const;

export const RESOURCE_NAMES = [
  // static
  "server_status",
  "memory_review_pending",
  // template
  "memory_detail",
  "memory_audit",
] as const;
