/**
 * Safe, structured descriptor of a sync-apply failure for observability.
 *
 * Surfaces schema-level metadata (Postgres SQLSTATE, constraint, table, routine)
 * that makes a wedged batch diagnosable — WITHOUT leaking row contents. The raw
 * Postgres `detail`/`message` carry the failing row (tenant payloads, encrypted
 * envelopes), so they are deliberately NOT included. This is returned in the
 * /sync/push 500 response so the exporter records it in last_error instead of a
 * bare "Batch apply failed" (which silently wedged a tenant's sync for ~6 days).
 */
export function safeApplyErrorClass(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e && typeof e === "object") {
    const r = e as Record<string, unknown>;
    const pgCode = typeof r.code === "string" ? r.code : undefined;
    if (pgCode) {
      out.kind = "postgres";
      out.pg_code = pgCode;
      if (typeof r.constraint_name === "string") out.constraint = r.constraint_name;
      if (typeof r.table_name === "string") out.table = r.table_name;
      if (typeof r.routine === "string") out.routine = r.routine;
    } else if (typeof r.name === "string") {
      out.kind = r.name;
    }
  }
  if (!out.kind) out.kind = "error";
  return out;
}

/** The only fields permitted to survive into a client-visible error string. */
const SAFE_ERROR_CLASS_FIELDS = ["kind", "pg_code", "constraint", "table", "routine"] as const;

/**
 * Whitelist an error_class descriptor down to the known-safe schema fields.
 *
 * Defense-in-depth: the exporter receives `error_class` from the hosted server's
 * JSON response. Even though the server builds it via safeApplyErrorClass, a
 * compromised / MITM'd / buggy server could send back extra fields carrying row
 * data (Postgres detail, encrypted envelopes, tenant secrets). Re-filtering on
 * receipt guarantees only schema metadata can ever reach last_error, no matter
 * what the far side sends.
 */
export function sanitizeErrorClass(cls: unknown): Record<string, string> {
  const safe: Record<string, string> = {};
  if (cls && typeof cls === "object") {
    const r = cls as Record<string, unknown>;
    for (const k of SAFE_ERROR_CLASS_FIELDS) {
      if (typeof r[k] === "string") safe[k] = r[k] as string;
    }
  }
  return safe;
}

/**
 * Render an error_class descriptor as a compact ` [k=v k=v]` suffix for a
 * human-readable last_error string. Empty descriptor → empty string.
 */
export function formatErrorClassSuffix(errorClass: unknown): string {
  if (!errorClass || typeof errorClass !== "object") return "";
  const entries = Object.entries(errorClass as Record<string, unknown>);
  if (entries.length === 0) return "";
  return " [" + entries.map(([k, v]) => `${k}=${String(v)}`).join(" ") + "]";
}
