/**
 * SSRF guard for server-side URL fetches.
 *
 * Rejects http(s) URLs whose host is — or DNS-resolves to — a private,
 * loopback, link-local, CGNAT, or cloud-metadata address. Mirrors the guard
 * originally inlined in api/src/routes/vi-webhook.ts (#203); extracted here so
 * other server-side fetchers (source materialization, vault harvest) share one
 * audited implementation instead of duplicating the ranges.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
}

const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x7f000000, 0xff000000], // 127.0.0.0/8   loopback
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16  link-local + cloud metadata
  [0x64400000, 0xffc00000], // 100.64.0.0/10  CGNAT
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_V4.some(([net, mask]) => (n & mask) >>> 0 === net);
}

function isPrivateV6(raw: string): boolean {
  const h = raw.toLowerCase();
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateV4(mapped[1]); // IPv4-mapped IPv6
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  return false;
}

export function isPrivateHost(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return isPrivateV4(host);
  if (kind === 6) return isPrivateV6(host);
  return false;
}

export const SSRF_REASON =
  "source targets a private/loopback/internal address; only public remote sources are permitted";

/**
 * Returns a rejection reason if the http(s) `raw` URL targets a private/internal
 * address, else null. Non-URL or non-http(s) inputs return null (they cannot
 * drive a fetch to a private IP; the caller validates protocol separately).
 * Resolves hostnames via DNS and rejects if ANY resolved address is private
 * (catches `localhost` and DNS names pointing at internal IPs).
 */
export async function findSsrfUrlReason(raw: string): Promise<string | null> {
  const s = raw.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isPrivateHost(host)) return SSRF_REASON;
  if (isIP(host) === 0) {
    let addrs: Array<{ address: string }>;
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      return null; // unresolvable host can't reach a private IP
    }
    if (addrs.some((a) => isPrivateHost(a.address))) return SSRF_REASON;
  }
  return null;
}

const MAX_GUARDED_REDIRECT_HOPS = 5;

/**
 * fetch() with the SSRF guard applied to the initial URL AND to every redirect
 * hop. `redirect: "follow"` would connect to a redirect target before the
 * caller could inspect it, so redirects are followed manually here with
 * findSsrfUrlReason re-checked per hop. Throws on a guarded URL, on too many
 * hops, or on a redirect with no Location; otherwise returns the final
 * Response exactly as fetch() would.
 */
export async function ssrfGuardedFetch(
  raw: string,
  init: Omit<RequestInit, "redirect"> = {},
): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_GUARDED_REDIRECT_HOPS; hop++) {
    const reason = await findSsrfUrlReason(current);
    if (reason) throw new Error(reason);
    const resp = await fetch(current, { ...init, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    // Drain the redirect body so the connection can be reused/closed cleanly.
    await resp.arrayBuffer().catch(() => undefined);
    if (!location) throw new Error(`redirect (HTTP ${resp.status}) without a Location header`);
    current = new URL(location, current).toString();
  }
  throw new Error(`too many redirects (more than ${MAX_GUARDED_REDIRECT_HOPS})`);
}
