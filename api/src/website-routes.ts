/**
 * registerWebsiteRoutes — OSS no-op seam.
 *
 * The verityone.app marketing site (homepage, /start, /plus, etc.) is NOT part
 * of core Verity One. The VO+ build wires the real renderers behind this seam;
 * the open-core build ships this no-op so the marketing routes 404 and the root
 * `/` serves the JSON discovery surface to every caller. The only public-facing
 * UI in core VO is the local dashboard.
 */
import type { Hono } from "hono";

export function registerWebsiteRoutes(_app: Hono): void {
  // OSS build: the verityone.app marketing site is not part of core VO.
}

export function renderMarketingHomepageHtml(): string | null {
  return null; // core node has no marketing homepage; root serves JSON discovery.
}
