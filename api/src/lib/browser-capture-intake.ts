import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 100_000;

const FORBIDDEN_INTAKE_FIELDS = [
  "tenant_id",
  "account_id",
  "credential_id",
  "agent_id",
  "authorization",
  "token",
  "cookie",
  "cookies",
  "headers",
  "localStorage",
  "sessionStorage",
  "dashboard_token",
  "sync_token",
  "hosted_cookie",
  "google_token",
  "mcp_token",
  "tdk",
  "ck",
  "html",
  "raw_html",
  "script",
  "scripts",
] as const;

const ALLOWED_INTAKE_FIELDS = ["url", "title", "text", "captured_at"] as const;

export interface BrowserCaptureIntakeInput {
  url: string;
  title: string;
  text?: string;
  captured_at?: string;
}

export type BrowserCaptureIntakeResult =
  | {
      ok: true;
      path: string;
      relative_path: string;
      source_url: string;
      source_domain: string;
      clipped_at: string;
    }
  | {
      ok: false;
      reason:
        | "body_invalid"
        | "forbidden_field"
        | "unexpected_field"
        | "url_invalid"
        | "title_invalid"
        | "text_invalid"
        | "captured_at_invalid"
        | "write_failed";
      message: string;
      field?: string;
    };

function readStringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" ? value.trim() : null;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "web-clip";
}

function stableTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function normalizeHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  if (!raw || raw.length > MAX_URL_LENGTH) {
    return { ok: false, message: "url must be a non-empty http(s) URL up to 2048 characters." };
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, message: "url must use http or https." };
    }
    parsed.hash = "";
    return { ok: true, url: parsed };
  } catch {
    return { ok: false, message: "url must be a valid http(s) URL." };
  }
}

function parseCapturedAt(raw: string | null): { ok: true; value: Date } | { ok: false; message: string } {
  if (!raw) return { ok: true, value: new Date() };
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    return { ok: false, message: "captured_at must be an ISO timestamp when provided." };
  }
  return { ok: true, value: parsed };
}

function uniquePath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

function renderMarkdown(input: {
  title: string;
  text: string;
  sourceUrl: string;
  sourceDomain: string;
  clippedAt: string;
  receivedAt: string;
}): string {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `source_url: ${yamlString(input.sourceUrl)}`,
    `source_domain: ${yamlString(input.sourceDomain)}`,
    `clipped_at: ${yamlString(input.clippedAt)}`,
    `received_at: ${yamlString(input.receivedAt)}`,
    `source_tool: "vo-browser-capture"`,
    `vo_intake: "clipper"`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.text.trim(),
    "",
  ].join("\n");
}

export function writeBrowserCaptureIntake(
  vaultRoot: string,
  body: unknown,
  now = new Date(),
): BrowserCaptureIntakeResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body_invalid", message: "Request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  for (const field of FORBIDDEN_INTAKE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      return {
        ok: false,
        reason: "forbidden_field",
        field,
        message: `${field} is not accepted on browser capture intake.`,
      };
    }
  }
  for (const field of Object.keys(record)) {
    if (!(ALLOWED_INTAKE_FIELDS as readonly string[]).includes(field)) {
      return {
        ok: false,
        reason: "unexpected_field",
        field,
        message: `${field} is not accepted on browser capture intake.`,
      };
    }
  }

  const urlRaw = readStringField(record, "url");
  const titleRaw = readStringField(record, "title");
  const hasText = Object.prototype.hasOwnProperty.call(record, "text");
  if (hasText && typeof record.text !== "string") {
    return {
      ok: false,
      reason: "text_invalid",
      message: "text must be a string when provided.",
      field: "text",
    };
  }
  const textRaw = readStringField(record, "text") ?? "";
  const capturedAtRaw = readStringField(record, "captured_at");
  const parsedUrl = normalizeHttpUrl(urlRaw ?? "");
  if (!parsedUrl.ok) return { ok: false, reason: "url_invalid", message: parsedUrl.message, field: "url" };
  if (!titleRaw || titleRaw.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      reason: "title_invalid",
      message: "title must be a non-empty string up to 300 characters.",
      field: "title",
    };
  }
  if (textRaw.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      reason: "text_invalid",
      message: "text must be a string up to 100000 characters.",
      field: "text",
    };
  }
  if (/<script\b|<\/script>/i.test(textRaw)) {
    return {
      ok: false,
      reason: "text_invalid",
      message: "text must be extracted article text, not raw script or HTML.",
      field: "text",
    };
  }
  const capturedAt = parseCapturedAt(capturedAtRaw);
  if (!capturedAt.ok) {
    return { ok: false, reason: "captured_at_invalid", message: capturedAt.message, field: "captured_at" };
  }

  const relativeDir = path.join("inbox", "web-clips");
  const targetDir = path.join(vaultRoot, relativeDir);
  const filename = `${stableTimestampForFilename(now)}-${slugify(titleRaw)}.md`;
  const basePath = path.join(targetDir, filename);

  const sourceUrl = parsedUrl.url.toString();
  const content = renderMarkdown({
    title: titleRaw,
    text: textRaw || "_No extracted article text was available. Add context here before harvesting if needed._",
    sourceUrl,
    sourceDomain: parsedUrl.url.hostname,
    clippedAt: capturedAt.value.toISOString(),
    receivedAt: now.toISOString(),
  });

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    // uniquePath() picks a free name, but a concurrent same-title capture can win the
    // gap before our exclusive (wx) write — yielding EEXIST. Retry with a freshly
    // recomputed unique path instead of failing (batch-23 D6); this also covers
    // uniquePath()'s previously-unchecked random fallback.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const targetPath = uniquePath(basePath);
      const relativePath = path.relative(vaultRoot, targetPath).split(path.sep).join("/");
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { ok: false, reason: "write_failed", message: "Resolved capture path escaped the vault root." };
      }
      try {
        fs.writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return {
          ok: true,
          path: targetPath,
          relative_path: relativePath,
          source_url: sourceUrl,
          source_domain: parsedUrl.url.hostname,
          clipped_at: capturedAt.value.toISOString(),
        };
      } catch (e) {
        lastErr = e as Error;
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // real error → outer catch
        // EEXIST: another capture took this exact path; recompute + retry.
      }
    }
    return { ok: false, reason: "write_failed", message: `Could not allocate a unique capture filename after retries: ${lastErr?.message ?? "EEXIST"}` };
  } catch (e) {
    return { ok: false, reason: "write_failed", message: (e as Error).message };
  }
}

export const __browserCaptureIntakeTestOnly = {
  FORBIDDEN_INTAKE_FIELDS,
  ALLOWED_INTAKE_FIELDS,
  MAX_TEXT_LENGTH,
};
