export function normalizeRssFeedUrl(input: string): string {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = normalizedPath === "" ? "/" : normalizedPath;
    const params = new URLSearchParams(url.search);
    const sorted = new URLSearchParams();
    Array.from(params.entries())
      .sort(([aKey, aValue], [bKey, bValue]) =>
        aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey))
      .forEach(([key, value]) => {
        if (/^utm_/i.test(key) || key.toLowerCase() === "fbclid") return;
        sorted.append(key, value);
      });
    url.search = sorted.toString() ? `?${sorted.toString()}` : "";
    return url.toString();
  } catch {
    return trimmed;
  }
}
