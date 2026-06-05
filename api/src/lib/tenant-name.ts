export type TenantDisplayNameSource = "google_profile" | "google_email" | "manual" | "admin_seed";

export interface TenantSlugSuggestion {
  suggested_slug: string;
  source: Extract<TenantDisplayNameSource, "google_profile" | "google_email">;
}

export type TenantSlugValidation =
  | { ok: true; slug: string }
  | { ok: false; code: "required" | "invalid_format" | "reserved"; message: string };

export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const RESERVED_TENANT_SLUGS = new Set([
  "admin",
  "api",
  "default",
  "dev",
  "global",
  "google",
  "local",
  "private",
  "prod",
  "public",
  "root",
  "staging",
  "support",
  "sync",
  "system",
  "test",
  "verity",
  "verityone",
  "vo",
]);

function asciiSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function normalizeTenantDisplayName(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return normalized || "Verity One Tenant";
}

export function deriveTenantSlugFromGoogleProfile(input: {
  email?: string | null;
  displayName?: string | null;
}): TenantSlugSuggestion {
  const displayName = normalizeTenantDisplayName(input.displayName ?? "");
  const hasProfileName = displayName !== "Verity One Tenant";
  const emailLocal = String(input.email ?? "").split("@")[0] || "tenant";
  const source: TenantSlugSuggestion["source"] = hasProfileName ? "google_profile" : "google_email";
  let slug = asciiSlugBase(hasProfileName ? displayName : emailLocal);

  if (!slug || !/^[a-z]/.test(slug)) slug = `t${slug}`;
  if (slug.length < 3) slug = `${slug}vo`.slice(0, 3);
  slug = slug.slice(0, 32);
  if (RESERVED_TENANT_SLUGS.has(slug)) slug = `${slug}vo`.slice(0, 32);

  return { suggested_slug: slug, source };
}

export function validateTenantSlug(value: unknown): TenantSlugValidation {
  const slug = String(value ?? "").trim();
  if (!slug) {
    return { ok: false, code: "required", message: "Tenant name is required." };
  }
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      code: "invalid_format",
      message: "Use 1-64 lowercase letters, numbers, and internal hyphens.",
    };
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return { ok: false, code: "reserved", message: "This tenant name is reserved." };
  }
  return { ok: true, slug };
}
