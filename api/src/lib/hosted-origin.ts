import { errorJson } from "./error-envelope";

type HostedOriginResult =
  | { ok: true }
  | { ok: false; response: Response };

function sameOrigin(requestUrl: string, origin: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function wantsHtml(c: any): boolean {
  const contentType = c.req.header("Content-Type") || "";
  const accept = c.req.header("Accept") || "";
  return contentType.includes("application/x-www-form-urlencoded") || accept.includes("text/html");
}

function redirectWithError(c: any, error: string): Response {
  const referer = c.req.header("Referer") || "/my/account";
  let url: URL;
  try {
    url = new URL(referer, new URL(c.req.url).origin);
    if (url.origin !== new URL(c.req.url).origin) {
      url = new URL("/my/account", new URL(c.req.url).origin);
    }
  } catch {
    url = new URL("/my/account", new URL(c.req.url).origin);
  }
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  url.searchParams.set("error", error);
  return c.redirect(url.pathname + url.search, 303);
}

export function assertHostedMutationOrigin(c: any): HostedOriginResult {
  const origin = c.req.header("Origin");
  if (!origin || sameOrigin(c.req.url, origin)) return { ok: true };

  if (wantsHtml(c)) {
    return { ok: false, response: redirectWithError(c, "origin_not_allowed") };
  }

  return {
    ok: false,
    response: errorJson(c, "forbidden", { message: "Origin not allowed." }),
  };
}
