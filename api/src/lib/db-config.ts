/**
 * Compatibility re-export of `@verity-one/db-pool`.
 *
 * F5 (rung 5 of VO-FOUNDATION-HARDENING-LADDER-1) extracted the F3
 * deployment-profile validator + pool factories into the
 * `@verity-one/db-pool` workspace package so cross-workspace callers
 * under `scripts/`, `miners/`, and `api/scripts/` can import via the
 * package boundary instead of reaching into API-private source.
 *
 * This shim preserves the historical `api/src/lib/db-config` import
 * path for API-internal code so existing route/lib/seed callers keep
 * working without a wholesale refactor inside `api/src/`. New API code
 * may import directly from `@verity-one/db-pool`; cross-workspace code
 * MUST do so (the F5 drift surface enforces this).
 *
 * Re-exporting `*` preserves every named export including the F3 test
 * helper `__resetCachedDeploymentProfileForTests` so the deployment-
 * profile drift test surface keeps importing through this shim.
 */

export * from "@verity-one/db-pool";
