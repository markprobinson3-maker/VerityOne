export const DEFAULT_LOCAL_VO_URL = "http://127.0.0.1:3100";
export const CAPTURE_TOKEN_PREFIX = "vobc_";
export const MAX_CAPTURE_TEXT_LENGTH = 100000;

export function isLoopbackLocalVoUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(url.hostname)
      && !!url.port;
  } catch {
    return false;
  }
}

export function normalizeLocalVoUrl(raw) {
  const value = String(raw || "").trim() || DEFAULT_LOCAL_VO_URL;
  if (!isLoopbackLocalVoUrl(value)) {
    throw new Error("Local VO URL must be an http loopback URL with a port.");
  }
  return value.replace(/\/+$/, "");
}

export function normalizeCaptureToken(raw) {
  const value = String(raw || "").trim();
  if (!value.startsWith(CAPTURE_TOKEN_PREFIX)) {
    throw new Error("Capture token must start with vobc_.");
  }
  return value;
}

export function validateCaptureSettings(settings) {
  return {
    localVoUrl: normalizeLocalVoUrl(settings?.localVoUrl),
    token: normalizeCaptureToken(settings?.token),
  };
}

export function normalizeExtractedText(raw) {
  return String(raw || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_CAPTURE_TEXT_LENGTH);
}

export function extractReadablePageText(doc = globalThis.document) {
  const source = doc?.body?.innerText || doc?.documentElement?.innerText || "";
  return normalizeExtractedText(source);
}

export function buildIntakePayload(tab, extracted, now = new Date()) {
  const url = String(tab?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) tabs can be captured.");
  }
  const title = String(extracted?.title || tab?.title || url).trim().slice(0, 300);
  return {
    url,
    title,
    text: normalizeExtractedText(extracted?.text || ""),
    captured_at: now.toISOString(),
  };
}

export function intakeUrl(localVoUrl) {
  return `${normalizeLocalVoUrl(localVoUrl)}/browser-capture/intake`;
}
