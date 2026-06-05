/**
 * Verity Ingest — Adapter Interface
 *
 * Every data source implements ViAdapter. One file, one export.
 * The scheduler auto-discovers *.adapter.ts files on startup.
 */

export interface ViAdapter {
  /** Unique adapter name (e.g. "openweather", "apify-reddit-ml") */
  name: string;

  /** Source type — maps to source registry profile for scoring/halflife/budget */
  source_type: string;

  /** Human-readable description for UI */
  description: string;

  /** Default cron schedule (null = manual/webhook only) */
  default_schedule: string | null;

  /** Can accept webhook POST pushes? */
  webhook_enabled: boolean;

  /** Auth config — which env var holds the API key */
  auth?: {
    type: "api_key" | "bearer" | "oauth" | "none";
    key_env?: string;
    required: boolean;
  };

  /**
   * The only method you implement.
   * Receives the trigger input (URL, config object, webhook payload)
   * Returns extracted text chunks ready for atomization.
   */
  extract(input: AdapterInput): Promise<AdapterOutput>;
}

export interface AdapterInput {
  /** URL, file path, or raw content depending on trigger */
  source: string;
  /** Adapter-specific config from schedule registry */
  config?: Record<string, any>;
  /** Webhook payload if triggered via POST */
  webhook_payload?: any;
}

export interface AdapterOutput {
  /** Human-readable title for source_history */
  title: string;
  /** Unique source ID for dedup (usually URL or content hash) */
  source_id: string;
  /** Extracted text chunks */
  chunks: Array<{
    content: string;
    chunk_index: number;
    chunk_total: number;
    metadata?: Record<string, any>;
  }>;
}
