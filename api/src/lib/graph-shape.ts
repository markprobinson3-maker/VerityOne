/**
 * Compatibility re-export of `@verity-one/graph-shape`.
 *
 * F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) extracted the
 * canonical pyramid taxonomy + pure graph-shape helpers into the
 * `@verity-one/graph-shape` workspace package so frontend (`scope/`),
 * miners (`miners/`), and operator scripts (`scripts/`) can import the
 * same source without reaching into API-private files. This shim
 * preserves the historical `api/src/lib/graph-shape` import path so
 * internal API code does not need to be touched in lockstep.
 *
 * New API code may import directly from `@verity-one/graph-shape`;
 * older API call-sites will keep working through this re-export.
 */

export * from "@verity-one/graph-shape";
