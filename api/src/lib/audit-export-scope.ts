/**
 * Scope resolver for `GET /audit/export` —
 * VO-FEDERATION-AUDIT-EXPORT-PR-1 (rung 12c).
 *
 * One endpoint with two auth flows per Q3=A:
 *
 *   1. **Operator cross-tenant audit** — `Authorization: Bearer
 *      <operator-token>` (same tokens as `/account/link/approve`)
 *      plus a mandatory `?tenant_id=...` filter. Used for
 *      incident response where an operator needs the full audit
 *      history of one named tenant. Never broadcasts all
 *      tenants — the operator must name exactly one tenant per
 *      call.
 *   2. **Tenant self-serve** — the caller's hosted session
 *      cookie resolves to one active tenant. The caller can
 *      omit `?tenant_id`, or pass their own tenant id; passing
 *      a different tenant id is a hard reject.
 *
 * The resolver returns a discriminated `ExportScope` that the
 * handler uses to build exactly one `WHERE tenant_id = ...` SQL
 * filter. Never "no filter" — the resolver fails closed when no
 * auth produces a usable tenant scope.
 *
 * Pure function. Takes an opaque `ExportAuth` sum and the raw
 * query-string tenant id; returns scope or an error. The HTTP
 * handler is responsible for turning `ExportAuth` into one of
 * the variants via whatever auth resolution it prefers.
 */

/** The auth the handler resolved for this call. The handler
 *  populates exactly one variant based on what it could verify.
 *  Keep this a discriminated union so new auth paths (e.g. the
 *  future web-agent connector in rung 11) surface as an
 *  exhaustive `switch` miss, not a silent fall-through. */
export type ExportAuth =
  | { kind: "operator" }
  | { kind: "tenant_session"; tenant_id: string }
  | { kind: "tenant_session_unlinked" }
  | { kind: "unauthenticated" };

/** The scope the SQL filter will honor. Exactly one
 *  `tenant_id` string ever lands in the `WHERE` clause; the
 *  discriminant is informational for audit + dashboard labeling. */
export type ExportScope =
  | { mode: "operator"; tenant_filter: string }
  | { mode: "tenant_self"; tenant_id: string };

export type ExportScopeResult =
  | { ok: true; scope: ExportScope }
  | { ok: false; status: number; error: string };

/** A tenant id can only be an opaque identifier. Rejecting
 *  empty / whitespace strings prevents an operator typo from
 *  silently producing `WHERE tenant_id = ''` (which matches
 *  nothing, but which is also not what the operator asked
 *  for). */
function normalizeTenantId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

function containsControlChar(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

/**
 * Resolve the export scope for one `GET /audit/export` call.
 * See the module header for the decision rules.
 *
 * - `auth.kind === "operator"` + query tenant id → operator
 *   mode, scope is the query tenant id.
 * - `auth.kind === "operator"` + no query tenant id → 400
 *   (operator must name exactly one tenant).
 * - `auth.kind === "tenant_session"` → tenant-self mode. The
 *   query tenant id is allowed ONLY if it matches the session
 *   tenant (clients may always pass it for clarity); any
 *   mismatch is a 403.
 * - `auth.kind === "unauthenticated"` → 401.
 */
export function resolveExportScope(
  auth: ExportAuth,
  rawQueryTenantId: string | null,
): ExportScopeResult {
  const rawTenantId = typeof rawQueryTenantId === "string" ? rawQueryTenantId : "";
  const queryTenantId = normalizeTenantId(rawQueryTenantId);
  if (queryTenantId && containsControlChar(rawTenantId)) {
    return {
      ok: false,
      status: 400,
      error: "tenant_id contains invalid control characters.",
    };
  }

  if (auth.kind === "unauthenticated") {
    return {
      ok: false,
      status: 401,
      error:
        "Export requires an operator bearer token or a hosted session cookie.",
    };
  }

  if (auth.kind === "tenant_session_unlinked") {
    return {
      ok: false,
      status: 404,
      error:
        "No active tenant link found for this hosted session. Link a tenant before requesting tenant self-serve audit export.",
    };
  }

  if (auth.kind === "operator") {
    if (!queryTenantId) {
      return {
        ok: false,
        status: 400,
        error:
          "Operator audit export requires ?tenant_id=<id>. Cross-tenant broadcast is not supported; issue one call per tenant.",
      };
    }
    return { ok: true, scope: { mode: "operator", tenant_filter: queryTenantId } };
  }

  if (containsControlChar(auth.tenant_id)) {
    return {
      ok: false,
      status: 500,
      error: "Resolved tenant_id contains invalid control characters.",
    };
  }

  // tenant_session — scope is always the session's tenant id.
  // A query param that disagrees with the session tenant is a
  // cross-tenant attempt and hard-rejects.
  if (queryTenantId && queryTenantId !== auth.tenant_id) {
    return {
      ok: false,
      status: 403,
      error:
        "Tenant self-serve export is scoped to your own tenant. Cross-tenant audit requires operator auth.",
    };
  }

  return {
    ok: true,
    scope: { mode: "tenant_self", tenant_id: auth.tenant_id },
  };
}

/** Helper for the handler: derive the single `tenant_id` string
 *  the SQL filter will use, regardless of which mode resolved.
 *  Lets the handler do `WHERE tenant_id = ${tenantFilterFor(scope)}`
 *  without branching. */
export function tenantFilterFor(scope: ExportScope): string {
  return scope.mode === "operator" ? scope.tenant_filter : scope.tenant_id;
}
