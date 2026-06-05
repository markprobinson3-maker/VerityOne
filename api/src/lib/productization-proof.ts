/**
 * Multi-tenant productization proof (MT4) — the consolidated isolation matrix.
 *
 * PURE and DB-free (imports only the pure operating-loop). The command
 * (api/scripts/multi-tenant-proof.ts) gathers each tenant's REAL surfaces from the
 * live graph (its MT1 operating template + projects, seeded via the MT3 fixture)
 * and hands them here; this module:
 *   1. runs each tenant's operating-loop proof (MT2 buildLoopProofInputForTenant +
 *      runLoopProof) — proving the Tenant-Zero loop WIRES for every tenant, and
 *   2. builds the cross-tenant isolation MATRIX: for every (observer, subject)
 *      tenant pair and every surface the observer exposes (its template, projects,
 *      and its own loop proof), it asserts NONE of the subject's distinct markers
 *      appear. A single leaked marker fails the proof.
 *
 * The whole thing is a single releasable verdict (`ok`): every tenant's template
 * is valid, every loop is green+wired, and every isolation cell is clean. Same
 * inputs always yield the same proof (the caller supplies `generatedAt`).
 *
 * SCOPE: the matrix is surface-agnostic — the COMMAND (api/scripts/multi-tenant-
 * proof.ts) gathers the DB-backed surfaces (operating template, project list,
 * dashboard overview, ranked attention, ground recall, action packet, and the
 * tenant's agent_profiles — MT14, now tenant-scoped) and this lib additionally
 * COMPUTES each tenant's loop proof in-process and folds it in as a surface. Every
 * surface joins the matrix. Deeper tenant-scoped surfaces a productized tenant
 * accumulates (raw memories, review proposals, golden cases) are NOT yet checked
 * here — a leak in one of those would not be caught. Adding a gathered surface is
 * purely a command-side change; the proof logic does not change.
 */

import { buildLoopProofInputForTenant, runLoopProof } from "./operating-loop";

/** Recursively collect every scalar leaf of `value` as a string (exact-match leak detection). */
function collectScalarLeaves(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectScalarLeaves(v, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectScalarLeaves(v, out);
  }
}

/**
 * Markers of `markers` that appear as an EXACT scalar leaf of `body` (empty =
 * clean). Identifiers (tenant_id, space_id, addrs, agent_id, slug, idempotency
 * key) are always discrete fields, so a real leak is a whole-value match — a
 * free-text label that merely contains a marker substring does NOT false-positive.
 *
 * CONSTRAINT: markers must be whole-value, pairwise-disjoint identifiers (this is
 * what productTenantMarkers() produces). Because matching is exact-leaf, a marker
 * that is only a SUBSTRING of a field value (e.g. a marker "prd" inside the value
 * "prd-acme") is NOT detected — so never use overlapping/prefix markers. Empty
 * string is filtered out to avoid spurious matches.
 */
export function findLeakedMarkers(body: unknown, markers: string[]): string[] {
  const leaves = new Set<string>();
  collectScalarLeaves(body, leaves);
  return markers.filter((m) => m.length > 0 && leaves.has(m));
}

export interface ProductizationTenantInput {
  tenant_id: string;
  /** The tenant's distinct identifiers (e.g. productTenantMarkers(fixture)). */
  markers: string[];
  /** MT1 template validation outcome, computed by the caller against the live DB. */
  template: { ok: boolean; errors: string[] };
  /** Serializable surfaces an agent/operator observes for this tenant (template, projects, …). */
  surfaces: Record<string, unknown>;
}

export interface ProductizationProofInput {
  tenants: ProductizationTenantInput[];
}

export interface ProductizationTenantResult {
  tenant_id: string;
  template_ok: boolean;
  template_errors: string[];
  loop_ok: boolean;
  loop_wired: boolean;
}

/** One observer×subject×surface isolation check. */
export interface IsolationCell {
  surface: string;
  /** The tenant whose surface was inspected. */
  observer: string;
  /** The tenant whose markers must NOT appear in the observer's surface. */
  subject: string;
  leaked: string[];
  ok: boolean;
}

export interface ProductizationProof {
  generated_at: string;
  tenants: ProductizationTenantResult[];
  isolation_matrix: IsolationCell[];
  /** Every template valid + every loop green+wired + every isolation cell clean. */
  ok: boolean;
}

/**
 * Compose the productization proof. For each tenant it runs the pure loop proof
 * (so the loop's OWN output is also isolation-checked), then walks every ordered
 * tenant pair × every observer surface and flags any leaked subject marker.
 */
export function evaluateProductizationProof(
  input: ProductizationProofInput,
  opts: { generatedAt: string; profile?: string },
): ProductizationProof {
  // A "cross-tenant" isolation proof is only meaningful with >= 2 tenants. With 0
  // or 1, the matrix loop never produces a cell and `every([])` would VACUOUSLY
  // report ok=true — silently claiming isolation that was never checked. Refuse it.
  if (input.tenants.length < 2) {
    throw new Error(
      `productization proof requires >= 2 tenants to prove cross-tenant isolation (got ${input.tenants.length})`,
    );
  }

  // 1. Per-tenant: validate template + run the loop proof; the loop proof becomes
  //    an additional isolation surface.
  const surfacesByTenant = new Map<string, Record<string, unknown>>();
  const markersByTenant = new Map<string, string[]>();
  const tenantResults: ProductizationTenantResult[] = input.tenants.map((t) => {
    const loop = runLoopProof(buildLoopProofInputForTenant(t.tenant_id), {
      generatedAt: opts.generatedAt,
      profile: opts.profile,
    });
    surfacesByTenant.set(t.tenant_id, { ...t.surfaces, loop_proof: loop });
    markersByTenant.set(t.tenant_id, t.markers);
    return {
      tenant_id: t.tenant_id,
      template_ok: t.template.ok,
      template_errors: t.template.errors,
      loop_ok: loop.ok,
      loop_wired: loop.wired,
    };
  });

  // 2. Isolation matrix: every (observer, subject) ordered pair × every surface.
  const matrix: IsolationCell[] = [];
  for (const observer of input.tenants) {
    const observerSurfaces = surfacesByTenant.get(observer.tenant_id) ?? {};
    for (const subject of input.tenants) {
      if (subject.tenant_id === observer.tenant_id) continue;
      const subjectMarkers = markersByTenant.get(subject.tenant_id) ?? [];
      for (const [surface, body] of Object.entries(observerSurfaces)) {
        const leaked = findLeakedMarkers(body, subjectMarkers);
        matrix.push({
          surface,
          observer: observer.tenant_id,
          subject: subject.tenant_id,
          leaked,
          ok: leaked.length === 0,
        });
      }
    }
  }

  const ok =
    tenantResults.every((t) => t.template_ok && t.loop_ok && t.loop_wired) &&
    matrix.every((c) => c.ok);

  return {
    generated_at: opts.generatedAt,
    tenants: tenantResults,
    isolation_matrix: matrix,
    ok,
  };
}

/** Human-readable one-screen summary of a productization proof (for the CLI). */
export function formatProductizationProof(proof: ProductizationProof): string {
  const lines: string[] = [];
  lines.push(`multi-tenant productization proof — ${proof.ok ? "GREEN" : "RED"} @ ${proof.generated_at}`);
  for (const t of proof.tenants) {
    const mark = t.template_ok && t.loop_ok && t.loop_wired ? "ok  " : "FAIL";
    lines.push(
      `  ${mark}  ${t.tenant_id}: template=${t.template_ok ? "valid" : `INVALID(${t.template_errors.join("; ")})`}` +
        ` loop=${t.loop_ok ? "green" : "RED"} wired=${t.loop_wired}`,
    );
  }
  const leaks = proof.isolation_matrix.filter((c) => !c.ok);
  lines.push(`  isolation matrix: ${proof.isolation_matrix.length} cells, ${leaks.length} leak(s)`);
  for (const c of leaks) {
    lines.push(`    LEAK  ${c.observer}.${c.surface} exposed ${c.subject}: ${c.leaked.join(", ")}`);
  }
  return lines.join("\n");
}
