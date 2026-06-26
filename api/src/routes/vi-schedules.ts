/**
 * Verity Ingest — Schedule Management API
 *
 * CRUD for vi_schedules + manual trigger + adapter listing
 */

import { Hono } from "hono";
import crypto from "node:crypto";
import { sql } from "../db";
import { listAdapters } from "../../../miners/src/vi/adapters/registry";
import { runScheduleById } from "../../../miners/src/vi/scheduler";
import { normalizeRssFeedUrl } from "../../../miners/src/vi/rss-url";
import { errorJson } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";
import { getAccessContext } from "../lib/access";

const app = new Hono();
const VI_SCHEDULE_AUDIT_TENANT_HEADER = "X-Vi-Schedule-Operator-Tenant";
const VI_SCHEDULE_AUDIT_TENANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VI_SCHEDULE_REQUEST_MAX_BODY_BYTES = 128 * 1024;

function viScheduleAuditTenantHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tenant = value.trim();
  if (
    !tenant
    || tenant.length > 128
    || /[^\x20-\x7E]/.test(tenant)
    || /[\s,;]/.test(tenant)
    || !VI_SCHEDULE_AUDIT_TENANT_RE.test(tenant)
  ) {
    return undefined;
  }
  return tenant;
}

export function resolveViScheduleAuditTenant(c: any): string {
  return viScheduleAuditTenantHeaderValue(c.req?.header?.(VI_SCHEDULE_AUDIT_TENANT_HEADER))
    || process.env.VERITY_DEFAULT_TENANT_ID
    || "system";
}

function viAuditActorLabel(c: any): string {
  const token = getAccessContext(c).token;
  if (!token) return "operator_token:unknown";
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
  return `operator_token:${hash}`;
}

function viScheduleIdParam(c: any): number | Response {
  const raw = String(c.req.param("id") || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    return errorJson(c, "invalid_request", { message: "Schedule id must be a positive integer." });
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    return errorJson(c, "invalid_request", { message: "Schedule id is too large." });
  }
  return id;
}

function viScheduleUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function viScheduleDeclaredContentLength(value: string | undefined): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function readViScheduleBoundedRequestText(
  c: any,
): Promise<{ ok: true; raw: string } | { ok: false; reason: "too_large" | "invalid" }> {
  const body = c.req?.raw?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > VI_SCHEDULE_REQUEST_MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The request is already rejected; cancel is only best-effort cleanup.
          }
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, raw: new TextDecoder().decode(bytes) };
  }

  try {
    const raw = await c.req.text();
    if (viScheduleUtf8ByteLength(raw) > VI_SCHEDULE_REQUEST_MAX_BODY_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    return { ok: true, raw };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

async function readViScheduleJsonObject(c: any): Promise<{ ok: true; body: Record<string, any> } | { ok: false; response: Response }> {
  const mediaType = (c.req.header("content-type") || "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      response: errorJson(c, "unsupported_media_type", { message: "Content-Type must be application/json" }),
    };
  }

  const declaredContentLength = viScheduleDeclaredContentLength(c.req.header("content-length"));
  if (declaredContentLength === "invalid") {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Content-Length must be a non-negative integer." }),
    };
  }
  if (declaredContentLength !== undefined && declaredContentLength > VI_SCHEDULE_REQUEST_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: "Schedule request body is too large.",
        details: { max_bytes: VI_SCHEDULE_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }

  const read = await readViScheduleBoundedRequestText(c);
  if (!read.ok && read.reason === "too_large") {
    return {
      ok: false,
      response: errorJson(c, "payload_too_large", {
        message: "Schedule request body is too large.",
        details: { max_bytes: VI_SCHEDULE_REQUEST_MAX_BODY_BYTES },
      }),
    };
  }
  if (!read.ok) {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }

  let body: unknown;
  try {
    body = read.raw === "" ? null : JSON.parse(read.raw);
  } catch {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: errorJson(c, "invalid_request", { message: "Request body must be a valid JSON object." }),
    };
  }
  return { ok: true, body: body as Record<string, any> };
}

function viScheduleFieldValidationError(c: any, body: Record<string, any>): Response | undefined {
  const sourceInput = body.source_input;
  if (sourceInput !== undefined && sourceInput !== null && typeof sourceInput !== "string") {
    return errorJson(c, "invalid_request", { message: "source_input must be a string." });
  }

  const scheduleCron = body.schedule_cron;
  if (scheduleCron !== undefined && scheduleCron !== null && typeof scheduleCron !== "string") {
    return errorJson(c, "invalid_request", { message: "schedule_cron must be a string." });
  }

  const enabled = body.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return errorJson(c, "invalid_request", { message: "enabled must be a boolean." });
  }

  const intervalSeconds = body.interval_seconds;
  if (
    intervalSeconds !== undefined
    && intervalSeconds !== null
    && (typeof intervalSeconds !== "number" || !Number.isInteger(intervalSeconds) || intervalSeconds < 0)
  ) {
    return errorJson(c, "invalid_request", { message: "interval_seconds must be a non-negative integer." });
  }

  const adapterConfig = body.adapter_config;
  if (adapterConfig !== undefined && adapterConfig !== null && (typeof adapterConfig !== "object" || Array.isArray(adapterConfig))) {
    return errorJson(c, "invalid_request", { message: "adapter_config must be an object." });
  }

  return undefined;
}

function viScheduleIntervalSecondsForStorage(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

export type ParsedOpmlFeed = {
  title: string;
  source_input: string;
};

async function findExistingRssSchedule(sourceInputNormalized: string): Promise<any | null> {
  if (!sourceInputNormalized) return null;
  const [existing] = await sql`
    SELECT *
    FROM vi_schedules
    WHERE adapter_name = 'rss'
      AND (
        source_input_normalized = ${sourceInputNormalized}
        OR source_input = ${sourceInputNormalized}
      )
    ORDER BY id DESC
    LIMIT 1
  `;
  return existing || null;
}

function decodeXmlEntity(raw: string): string {
  return raw
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readXmlAttr(fragment: string, name: string): string {
  const match = fragment.match(new RegExp(`${name}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ? decodeXmlEntity(match[2]).trim() : "";
}

export function normalizeOpmlSourceUrl(input: string): string {
  const trimmed = String(input || "").trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const blobIndex = parts.indexOf("blob");
      if (blobIndex === 2 && parts.length > blobIndex + 2) {
        const [owner, repo] = parts;
        const branch = parts[blobIndex + 1];
        const rest = parts.slice(blobIndex + 2).join("/");
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest}`;
      }
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function parseOpmlFeeds(opml: string): ParsedOpmlFeed[] {
  const seen = new Set<string>();
  const feeds: ParsedOpmlFeed[] = [];
  const outlines = opml.match(/<outline\b[^>]*\bxmlUrl\s*=\s*['"][^'"]+['"][^>]*\/?>/gi) || [];
  for (const outline of outlines) {
    const sourceInput = readXmlAttr(outline, "xmlUrl");
    if (!/^https?:\/\//i.test(sourceInput) || seen.has(sourceInput)) continue;
    seen.add(sourceInput);
    const title = readXmlAttr(outline, "title") || readXmlAttr(outline, "text") || sourceInput;
    feeds.push({
      title: title || sourceInput,
      source_input: sourceInput,
    });
  }
  return feeds;
}

async function fetchTextDocument(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // SSRF-guarded: RSS/OPML source URLs are operator-suppliable; block
    // private/loopback/metadata targets and re-check every redirect hop.
    const { ssrfGuardedFetch } = await import("../lib/ssrf-guard");
    const resp = await ssrfGuardedFetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Fetch failed: ${resp.status}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRssFeedTitle(sourceInput: string): Promise<string | null> {
  try {
    const xml = await fetchTextDocument(sourceInput);
    const title = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    return title ? `RSS: ${title}` : null;
  } catch {
    return null;
  }
}

// List all schedules with status
app.get("/", async (c) => {
  const schedules = await sql`
    SELECT id, adapter_name, schedule_cron, source_input, adapter_config,
           enabled, last_run_at, last_status, last_error, last_atoms_count,
           next_run_at, total_runs, total_atoms, total_cost_usd,
           interval_seconds, created_at
    FROM vi_schedules
    ORDER BY enabled DESC, next_run_at ASC
  `;
  const enriched = await Promise.all(schedules.map(async (schedule: any) => {
    if (schedule.adapter_name !== "rss" || schedule.adapter_config?.feed_title || !schedule.source_input) {
      return schedule;
    }
    const [latestSource] = await sql`
      SELECT source_title
      FROM source_history
      WHERE source_id LIKE ${`rss:${schedule.source_input}:%`}
      ORDER BY ingested_at DESC
      LIMIT 1
    `;
    if (!latestSource?.source_title) return schedule;
    return {
      ...schedule,
      adapter_config: {
        ...(schedule.adapter_config || {}),
        feed_title: latestSource.source_title,
      },
    };
  }));
  return c.json({ schedules: enriched, count: enriched.length });
});

// List available adapters (for UI dropdown)
app.get("/adapters", async (c) => {
  const adapters = listAdapters().map(a => ({
    name: a.name,
    source_type: a.source_type,
    description: a.description,
    default_schedule: a.default_schedule,
    webhook_enabled: a.webhook_enabled,
    auth_required: a.auth?.required ?? false,
    auth_key_env: a.auth?.key_env,
  }));
  return c.json({ adapters, count: adapters.length });
});

// Create a new schedule
app.post("/", async (c) => {
  const read = await readViScheduleJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  if (body.adapter_name !== undefined && typeof body.adapter_name !== "string") {
    return errorJson(c, "invalid_request", { message: "adapter_name must be a string." });
  }
  const fieldError = viScheduleFieldValidationError(c, body);
  if (fieldError) return fieldError;
  const { adapter_name, schedule_cron, adapter_config, enabled, interval_seconds } = body;
  const intervalSeconds = viScheduleIntervalSecondsForStorage(interval_seconds);
  const source_input = adapter_name === "rss"
    ? normalizeRssFeedUrl(body?.source_input || "")
    : body?.source_input;

  const adapter = listAdapters().find(a => a.name === adapter_name);
  if (!adapter) return errorJson(c, "invalid_request", { message: "Unknown adapter" });
  const sourceInputNormalized = adapter_name === "rss" ? normalizeRssFeedUrl(source_input || "") : null;
  if (adapter_name === "rss" && sourceInputNormalized) {
    const existing = await findExistingRssSchedule(sourceInputNormalized);
    if (existing) {
      return c.json({ schedule: existing, duplicate: true }, 200);
    }
  }
  const nextAdapterConfig = { ...(adapter_config || {}) } as Record<string, any>;
  if (adapter_name === "rss" && source_input && !nextAdapterConfig.feed_title) {
    const feedTitle = await resolveRssFeedTitle(source_input);
    if (feedTitle) nextAdapterConfig.feed_title = feedTitle;
  }

  const [schedule] = await sql`
    INSERT INTO vi_schedules (adapter_name, schedule_cron, source_input, source_input_normalized, adapter_config, enabled, interval_seconds)
    VALUES (
      ${adapter_name},
      ${schedule_cron || adapter.default_schedule || "0 */4 * * *"},
      ${source_input || null},
      ${sourceInputNormalized},
      ${sql.json(nextAdapterConfig)},
      ${enabled ?? true},
      ${intervalSeconds}
    )
    RETURNING *
  `;
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveViScheduleAuditTenant(c),
    actor: viAuditActorLabel(c),
    actorKind: "operator_token",
    operation: "vi_schedule_create",
    eventData: { schedule_id: schedule.id, adapter_name, source_input: source_input || null, enabled: enabled ?? true },
  });
  return c.json({ schedule }, 201);
});

app.post("/import", async (c) => {
  const read = await readViScheduleJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const fieldError = viScheduleFieldValidationError(c, body);
  if (fieldError) return fieldError;
  const sourceInput = String(body?.source_input || "").trim();
  if (!/^https?:\/\//i.test(sourceInput)) {
    return errorJson(c, "invalid_request", { message: "Valid OPML http(s) URL required" });
  }

  const adapter = listAdapters().find((item) => item.name === "rss");
  if (!adapter) return errorJson(c, "internal_error", { message: "RSS adapter unavailable" });

  const opmlUrl = normalizeOpmlSourceUrl(sourceInput);
  let opml = "";
  try {
    opml = await fetchTextDocument(opmlUrl);
  } catch (error: any) {
    console.error("[vi-schedules/import] failed to fetch OPML:", error);
    return errorJson(c, "service_unavailable", { message: "Failed to fetch OPML" });
  }

  const feeds = parseOpmlFeeds(opml);
  if (feeds.length === 0) {
    return errorJson(c, "invalid_request", { message: "No RSS feeds found in OPML" });
  }

  const scheduleCron = body.schedule_cron !== undefined && body.schedule_cron !== null
    ? body.schedule_cron
    : (adapter.default_schedule || "0 */4 * * *");
  const intervalSeconds = viScheduleIntervalSecondsForStorage(body.interval_seconds);
  const enabled = body?.enabled ?? true;
  const baseAdapterConfig = { ...(body?.adapter_config || {}) } as Record<string, any>;

  const created: any[] = [];
  const skipped: any[] = [];

  for (const feed of feeds) {
    const normalizedSourceInput = normalizeRssFeedUrl(feed.source_input);
    const existing = await findExistingRssSchedule(normalizedSourceInput);

    if (existing) {
      if (!existing.adapter_config?.feed_title && feed.title) {
        await sql`
          UPDATE vi_schedules
          SET adapter_config = ${sql.json({
            ...(existing.adapter_config || {}),
            feed_title: feed.title,
          })},
          updated_at = now()
          WHERE id = ${existing.id}
        `;
      }
      skipped.push({
        id: existing.id,
        source_input: normalizedSourceInput,
        title: existing.adapter_config?.feed_title || feed.title,
        reason: "exists",
      });
      continue;
    }

    const adapterConfig = {
      ...baseAdapterConfig,
      feed_title: feed.title,
    };

    const [schedule] = await sql`
      INSERT INTO vi_schedules (adapter_name, schedule_cron, source_input, source_input_normalized, adapter_config, enabled, interval_seconds)
      VALUES (
        'rss',
        ${scheduleCron},
        ${normalizedSourceInput},
        ${normalizedSourceInput},
        ${sql.json(adapterConfig)},
        ${enabled},
        ${intervalSeconds}
      )
      RETURNING *
    `;
    created.push(schedule);
  }

  if (created.length > 0 || skipped.length > 0) {
    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: resolveViScheduleAuditTenant(c),
      actor: viAuditActorLabel(c),
      actorKind: "operator_token",
      operation: "vi_schedule_import",
      eventData: { source_input: opmlUrl, discovered: feeds.length, created_count: created.length, skipped_count: skipped.length },
    });
  }

  return c.json({
    imported_from: opmlUrl,
    discovered: feeds.length,
    created_count: created.length,
    skipped_count: skipped.length,
    created,
    skipped,
  }, 201);
});

// Update a schedule
app.patch("/:id", async (c) => {
  const id = viScheduleIdParam(c);
  if (typeof id !== "number") return id;
  const read = await readViScheduleJsonObject(c);
  if (!read.ok) return read.response;
  const body = read.body;
  const fieldError = viScheduleFieldValidationError(c, body);
  if (fieldError) return fieldError;

  // Fetch current, apply changes, write back
  const [current] = await sql`SELECT * FROM vi_schedules WHERE id = ${id}`;
  if (!current) return errorJson(c, "not_found", { message: "Not found" });

  const enabled = body.enabled !== undefined ? body.enabled : current.enabled;
  const schedule_cron = body.schedule_cron !== undefined && body.schedule_cron !== null
    ? body.schedule_cron
    : current.schedule_cron;
  const source_input = body.source_input !== undefined
    ? (current.adapter_name === "rss" ? normalizeRssFeedUrl(body.source_input || "") : body.source_input)
    : current.source_input;
  const adapter_config = body.adapter_config !== undefined
    ? { ...(current.adapter_config || {}), ...(body.adapter_config || {}) }
    : (current.adapter_config || {});
  const interval_seconds = body.interval_seconds !== undefined
    ? viScheduleIntervalSecondsForStorage(body.interval_seconds)
    : current.interval_seconds;
  const source_input_normalized = current.adapter_name === "rss"
    ? normalizeRssFeedUrl(source_input || "")
    : current.source_input_normalized;
  if (current.adapter_name === "rss" && body.source_input !== undefined) {
    const existing = await findExistingRssSchedule(source_input_normalized);
    if (existing && existing.id !== current.id) {
      return errorJson(c, "conflict", {
        message: "RSS feed already exists",
        details: { existing_schedule_id: existing.id },
      });
    }
  }
  if (current.adapter_name === "rss" && body.source_input !== undefined) {
    const feedTitle = source_input ? await resolveRssFeedTitle(source_input) : null;
    if (feedTitle) {
      adapter_config.feed_title = feedTitle;
    } else {
      delete adapter_config.feed_title;
    }
  }

  const [schedule] = await sql`
    UPDATE vi_schedules SET
      enabled = ${enabled},
      schedule_cron = ${schedule_cron},
      source_input = ${source_input},
      source_input_normalized = ${source_input_normalized},
      adapter_config = ${sql.json(adapter_config)},
      interval_seconds = ${interval_seconds},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveViScheduleAuditTenant(c),
    actor: viAuditActorLabel(c),
    actorKind: "operator_token",
    operation: "vi_schedule_update",
    eventData: { schedule_id: id, adapter_name: current.adapter_name },
  });
  return c.json({ schedule });
});

// Delete a schedule
app.delete("/:id", async (c) => {
  const id = viScheduleIdParam(c);
  if (typeof id !== "number") return id;
  const [deleted] = await sql`DELETE FROM vi_schedules WHERE id = ${id} RETURNING id, adapter_name`;
  if (!deleted) return errorJson(c, "not_found", { message: "Not found" });
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveViScheduleAuditTenant(c),
    actor: viAuditActorLabel(c),
    actorKind: "operator_token",
    operation: "vi_schedule_delete",
    eventData: { schedule_id: id, adapter_name: deleted.adapter_name },
  });
  return c.json({ deleted: true });
});

// Trigger a schedule manually
app.post("/:id/run", async (c) => {
  const id = viScheduleIdParam(c);
  if (typeof id !== "number") return id;
  const [schedule] = await sql`SELECT * FROM vi_schedules WHERE id = ${id}`;
  if (!schedule) return errorJson(c, "not_found", { message: "Not found" });

  // Run asynchronously — manual trigger via canonical HTTP route.
  runScheduleById(id, "manual").catch(err => console.error(`Manual run ${id} failed:`, err));
  await auditMutation(c, sql, {
    kind: "admin_action",
    tenantId: resolveViScheduleAuditTenant(c),
    actor: viAuditActorLabel(c),
    actorKind: "operator_token",
    operation: "vi_schedule_run",
    eventData: { schedule_id: id, adapter_name: schedule.adapter_name },
  });
  return c.json({ message: "Triggered", schedule_id: id });
});

export default app;
