/** Shared API utilities — eliminate repeated inline patterns */

/** Round a numeric value to 3 decimal places, handling stringified numbers */
export const roundFloat = (v: any): number =>
  parseFloat(parseFloat(v).toFixed(3));

/** Clamp an integer query param between min and max with a default */
export const clampInt = (raw: string | undefined, def: number, min: number, max: number): number => {
  const parsed = raw != null ? parseInt(raw) : NaN;
  const value = Number.isFinite(parsed) ? parsed : def;
  return Math.max(min, Math.min(value, max));
};

/** Clamp a float query/body value between min and max with a default */
export const clampFloat = (raw: unknown, def: number, min: number, max: number): number => {
  const parsed = raw != null ? parseFloat(String(raw)) : NaN;
  const value = Number.isFinite(parsed) ? parsed : def;
  return Math.max(min, Math.min(value, max));
};

/** Parse a JSONB field that Postgres may return as string or object */
export const parseJsonField = <T = any>(v: unknown): T | null => {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v as T;
};

/** Split a comma-separated query param into a filtered string array */
export const splitQuery = (v: string | undefined): string[] =>
  v?.split(",").filter(Boolean) || [];
