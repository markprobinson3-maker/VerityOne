/**
 * Typed `fetch` mock helper for tests.
 *
 * Bun's `typeof fetch` requires a `preconnect` method, so the common test
 * idiom `globalThis.fetch = (async (input, init) => {...}) as typeof fetch`
 * trips TS2352 ("conversion may be a mistake") at every call site. This
 * helper localizes that to ONE contained cast and attaches a no-op
 * `preconnect`, so tests get a properly-typed mock with no per-site cast:
 *
 *   globalThis.fetch = mockFetch(async (input, init) => Response.json({ ok: true }));
 */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function mockFetch(impl: FetchImpl): typeof fetch {
  const fn = impl as unknown as typeof fetch;
  // Tests never exercise preconnect; provide a no-op so the value structurally
  // satisfies `typeof fetch`.
  (fn as { preconnect: typeof fetch.preconnect }).preconnect = (async () => {}) as typeof fetch.preconnect;
  return fn;
}
