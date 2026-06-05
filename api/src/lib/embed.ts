/**
 * Compatibility re-export of `@verity-one/embed`.
 *
 * F7 (rung 7 of VO-FOUNDATION-HARDENING-LADDER-1) extracted the
 * canonical embedding helper + DB-backed cache + write-safety contract
 * into the `@verity-one/embed` workspace package so cross-workspace
 * callers under `scripts/`, `miners/`, and `api/scripts/` can import
 * via the package boundary instead of reaching into API-private
 * source. This shim preserves the historical `api/src/lib/embed`
 * import path so internal API code does not need to be touched in
 * lockstep.
 *
 * New API code may import directly from `@verity-one/embed`; older
 * API call-sites will keep working through this re-export. Cross-
 * workspace files MUST import from `@verity-one/embed` (the F7 drift
 * surface enforces this).
 */

export * from "@verity-one/embed";
