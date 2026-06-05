/**
 * Verity Ingest — Webhook Endpoint
 *
 * POST /vi/ingest — accepts external service webhooks (Apify, Zapier, etc.)
 * Auth via Bearer token (VI_WEBHOOK_KEY env var).
 */

import { Hono } from "hono";
import { sql } from "../db";
import { getAdapter } from "../../../miners/src/vi/adapters/registry";
import { runPipeline } from "../../../miners/src/vi/pipeline";
import { errorJson, ApiError } from "../lib/error-envelope";
import { auditMutation } from "../lib/audit";

const VI_WEBHOOK_KEY = process.env.VI_WEBHOOK_KEY || "change-me-in-production";

const app = new Hono();

app.post("/", async (c) => {
  // Auth check
  const authHeader = c.req.header("Authorization");
  if (authHeader !== `Bearer ${VI_WEBHOOK_KEY}`) {
    return errorJson(c, "unauthorized", { message: "Unauthorized" });
  }

  const body = await c.req.json();
  const { adapter_name, source, config, payload } = body;

  if (!adapter_name) return errorJson(c, "invalid_request", { message: "adapter_name required" });

  const adapter = getAdapter(adapter_name);
  if (!adapter) return errorJson(c, "invalid_request", { message: `Unknown adapter: ${adapter_name}` });
  if (!adapter.webhook_enabled) return errorJson(c, "invalid_request", { message: `Adapter ${adapter_name} does not accept webhooks` });

  try {
    const result = await runPipeline({
      adapter,
      source: source || "",
      config: config || {},
      webhook_payload: payload,
    });

    await auditMutation(c, sql, {
      kind: "admin_action",
      tenantId: process.env.VERITY_DEFAULT_TENANT_ID || "system",
      actor: "webhook",
      actorKind: "operator_token",
      operation: "vi_webhook_ingest",
      eventData: {
        adapter_name,
        batch_id: result.batch_id,
        atoms: result.total_atoms,
        queued: result.queued_count,
      },
    });

    return c.json({
      batch_id: result.batch_id,
      atoms: result.total_atoms,
      auto_on: result.auto_on_count,
      auto_in: result.auto_in_count,
      queued: result.queued_count,
      cost_usd: result.cost_usd,
    });
  } catch (err: any) {
    console.error("[vi-webhook] receive failed:", err);
    return errorJson(c, "internal_error", { message: "Webhook processing failed" });
  }
});

export default app;
