/**
 * Provider validation — lightweight real API check.
 *
 * First-cut support:
 * - google: real Gemini API call (models.list)
 * - others: "unsupported" — honest about what we can actually validate
 *
 * NEVER returns raw API keys. Caches result in config.providers metadata.
 */

import {
  readProviderKey,
  updateValidationCache,
  type ProviderMetadata,
} from "./provider-config";

export interface ValidationResult {
  provider: string;
  status: "ok" | "failed" | "unconfigured" | "unsupported";
  message: string;
  validated_at: string;
}

const SUPPORTED_VALIDATORS: Record<string, (key: string) => Promise<{ ok: boolean; error?: string }>> = {
  google: async (key: string) => {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) return { ok: true };
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      return { ok: false, error: body.error?.message || `HTTP ${res.status}` };
    } catch (e) {
      console.error("[provider-validate] google validation request failed:", e);
      return { ok: false, error: "Provider validation request failed." };
    }
  },
};

/**
 * Validate a provider's API key with a real lightweight check.
 * Caches the result in config.providers metadata.
 */
export async function validateProvider(provider: string): Promise<ValidationResult> {
  const now = new Date().toISOString();
  const key = readProviderKey(provider);

  if (!key) {
    // Cache the real semantic status so GET /providers/status reflects it accurately
    updateValidationCache(provider, "unconfigured", "No API key configured.");
    return { provider, status: "unconfigured", message: "No API key configured.", validated_at: now };
  }

  const validator = SUPPORTED_VALIDATORS[provider];
  if (!validator) {
    // Cache the real semantic status — "unsupported", not "failed"
    updateValidationCache(provider, "unsupported", `Validation not supported for "${provider}".`);
    return { provider, status: "unsupported", message: `Validation not supported for "${provider}". Key is configured but cannot be verified.`, validated_at: now };
  }

  const result = await validator(key);
  const status = result.ok ? "ok" : "failed";

  // Cache in non-secret metadata
  updateValidationCache(provider, status, result.error);

  return {
    provider,
    status,
    message: result.ok ? "API key validated successfully." : `Validation failed: ${result.error}`,
    validated_at: now,
  };
}
