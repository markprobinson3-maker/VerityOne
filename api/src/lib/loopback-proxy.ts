/**
 * Loopback-proxy normalisation helpers.
 *
 * Shared by dashboard.ts (internal API proxy) and
 * canonical-schedule-proxy.ts (internal loopback fetch) so that both
 * callers produce valid loopback URLs when VERITY_API_BIND is set to a
 * wildcard address (0.0.0.0, ::, [::]).
 */

/**
 * Map a configured bind address to a concrete loopback host that can be
 * used in an HTTP URL.
 *
 * Rules:
 *   - Empty / unset          → 127.0.0.1
 *   - 0.0.0.0                → 127.0.0.1
 *   - :: / [::]              → 127.0.0.1
 *   - localhost               → localhost  (passed through)
 *   - 127.x.x.x              → 127.x.x.x  (loopback, passed through)
 *   - ::1                    → [::1]       (bracket-quoted for URLs)
 *   - anything else          → throws (non-loopback bind not permitted)
 */
export function normalizeLoopbackBind(configuredBind: string): string {
  const bind = configuredBind.trim() || "127.0.0.1";
  const unbracketed = bind.startsWith("[") && bind.endsWith("]") ? bind.slice(1, -1) : bind;
  const normalized = unbracketed.toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") return "127.0.0.1";
  if (normalized === "localhost") return "localhost";
  const ipv4Parts = normalized.split(".");
  if (
    ipv4Parts.length === 4
    && ipv4Parts[0] === "127"
    && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  ) {
    return normalized;
  }
  if (normalized === "::1") return "[::1]";
  throw new Error("local API bind must be loopback for dashboard proxying");
}
