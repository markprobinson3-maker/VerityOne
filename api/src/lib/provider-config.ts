/**
 * Canonical provider configuration and secrets helper.
 *
 * Single authority for:
 * - Task routing: config.llm.tasks (matches vo onboard + VO-LLM-TASK-ROUTING-CONTRACT.md)
 * - Secret storage: ~/.vo/secrets.env (never config.json)
 * - Provider metadata: config.providers (non-secret only: configured_at, validation cache)
 *
 * Legacy shapes (config.model_defaults, config.providers.*.api_key) are read
 * for backward compatibility but never written. All writes use the canonical shape.
 *
 * Zero heavy API dependencies. Importable from both API code and vo-cli.
 * Supports VO_CONFIG_PATH-style test isolation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeLocalConfigAtomic0600 } from "./runtime-profile";

// ── Config path resolution (reuse runtime-profile convention) ────────

function resolveConfigDir(): string {
  const override = process.env.VO_CONFIG_PATH;
  if (override?.trim()) return path.dirname(override.trim());
  return path.join(os.homedir(), ".vo");
}

function resolveConfigPath(): string {
  const override = process.env.VO_CONFIG_PATH;
  if (override?.trim()) return override.trim();
  return path.join(os.homedir(), ".vo", "config.json");
}

function resolveSecretsPath(): string {
  return path.join(resolveConfigDir(), "secrets.env");
}

// ── Raw config read/write ────────────────────────────────────────────

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(resolveConfigPath(), "utf-8"));
  } catch { return {}; }
}

function writeConfig(config: Record<string, unknown>): void {
  // 0600 atomic writer (batch-25 #1) — config.json may carry tokens/keys, so it
  // must never be world-readable.
  writeLocalConfigAtomic0600(resolveConfigPath(), config);
}

// ── Secrets read/write (~/.vo/secrets.env) ───────────────────────────

function readSecrets(): Record<string, string> {
  const secretsPath = resolveSecretsPath();
  const result: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(secretsPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Tolerate a leading `export ` (batch-31; matches mcp/src/config.ts).
      const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
      const eqIdx = body.indexOf("=");
      if (eqIdx < 1) continue;
      result[body.slice(0, eqIdx).trim()] = body.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no secrets file yet */ }
  return result;
}

function writeSecretsFile(secretsPath: string, content: string): void {
  fs.writeFileSync(secretsPath, content, { mode: 0o600 });
  // Enforce 0600 even if the file already existed with broader permissions
  fs.chmodSync(secretsPath, 0o600);
}

function writeSecret(key: string, value: string): void {
  const secretsPath = resolveSecretsPath();
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  const existing = readSecrets();
  existing[key] = value;
  writeSecretsFile(secretsPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function removeSecret(key: string): void {
  const secretsPath = resolveSecretsPath();
  const existing = readSecrets();
  delete existing[key];
  if (Object.keys(existing).length === 0) {
    try { fs.unlinkSync(secretsPath); } catch { /* already gone */ }
    return;
  }
  writeSecretsFile(secretsPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

// ── Provider key environment variable mapping ────────────────────────
//
// Exported so the CLI (vo-cli.ts) can source env-var names from this
// one seam instead of redefining its own PROVIDER_KEY_MAP.
// VO-NOVICE-ONBOARDING-PR-1.

export const PROVIDER_ENV_VAR: Record<string, string> = {
  google: "GOOGLE_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

// Internal alias kept for minimal churn in readProviderStatus /
// setProviderKey / removeProviderKey / readProviderKey below. New code
// should import PROVIDER_ENV_VAR.
const PROVIDER_KEY_MAP = PROVIDER_ENV_VAR;

/**
 * Human-facing provider labels for novice-first onboarding. Never used
 * as a lookup key — just for display. Missing entries fall back to the
 * internal name.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google AI (Gemini)",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
};

/**
 * The single novice-safe default provider. Other providers stay
 * supported via PROVIDER_ENV_VAR, but `vo onboard` promotes this one
 * as the path a low-technical tenant should pick without thinking.
 * Matches RECOMMENDED_DEFAULTS below (every canonical task ships with
 * provider=google).
 */
export const ONBOARDING_DEFAULT_PROVIDER = "google";

export function providerLabel(name: string): string {
  return PROVIDER_LABELS[name] || name;
}

// ── Task routing (canonical: config.llm.tasks) ───────────────────────

export interface TaskRoute {
  model: string;
  provider: string;
}

export const CANONICAL_TASKS = [
  "vault_atomize",
  "tenant_ingest_atomize",
  "draft_review",
  "deep_synthesis",
] as const;

/** Membership predicate for the canonical task list. Exported so
 *  routes/dispatch can pre-validate before calling `writeTaskRoute`
 *  and map rejection to honest user errors instead of 500s. */
export function isCanonicalTask(task: string): boolean {
  return (CANONICAL_TASKS as readonly string[]).includes(task);
}

/** Marker error class for non-canonical task-route writes
 *  (VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1). Routes/dispatch can
 *  `instanceof`-discriminate this from generic failures and map it
 *  to 400/rejected. The message is the canonical user-facing string
 *  used everywhere else: "task must be one of: ...". */
export class NonCanonicalTaskError extends Error {
  readonly task: string;
  constructor(task: string) {
    super(`task must be one of: ${CANONICAL_TASKS.join(", ")}`);
    this.name = "NonCanonicalTaskError";
    this.task = task;
  }
}

/** Throws `NonCanonicalTaskError` if `task` is not in CANONICAL_TASKS.
 *  No-op for canonical tasks. Use as a guard at the top of any
 *  function that mutates task-route config. */
export function assertCanonicalTask(task: string): void {
  if (!isCanonicalTask(task)) throw new NonCanonicalTaskError(task);
}

export const RECOMMENDED_DEFAULTS: Record<string, TaskRoute> = {
  vault_atomize:         { model: "gemini-2.5-flash", provider: "google" },
  tenant_ingest_atomize: { model: "gemini-2.5-flash", provider: "google" },
  draft_review:          { model: "gemini-2.5-pro",   provider: "google" },
  deep_synthesis:        { model: "gemini-2.5-pro",   provider: "google" },
};

/**
 * Friendly human-readable task labels for novice-first onboarding and
 * status surfaces. VO-NOVICE-ONBOARDING-PR-1 / VO-NOVICE-ONBOARDING-CONTRACT:
 *
 *   vault_atomize         → "Fast source extraction"
 *   tenant_ingest_atomize → "Fast ingest extraction"
 *   draft_review          → "Draft review and cleanup"
 *   deep_synthesis        → "Deep synthesis"
 *
 * The novice tenant should never see raw task IDs in the default flow.
 * Support / proof surfaces still show the ID alongside the label so a
 * support agent can cross-reference.
 */
export const TASK_LABELS: Record<string, string> = {
  vault_atomize:         "Fast source extraction",
  tenant_ingest_atomize: "Fast ingest extraction",
  draft_review:          "Draft review and cleanup",
  deep_synthesis:        "Deep synthesis",
};

export function taskLabel(task: string): string {
  return TASK_LABELS[task] || task;
}

/**
 * Read the effective task routing. Merges canonical (config.llm.tasks)
 * with legacy (config.model_defaults) on a per-task basis.
 * Canonical takes precedence per task. Legacy fills gaps.
 */
export function readTaskRouting(): Record<string, TaskRoute> {
  const config = readConfig();
  const result: Record<string, TaskRoute> = {};

  // Legacy first (lower priority): config.model_defaults
  const legacy = config.model_defaults as Record<string, { provider?: string; model?: string }> | undefined;
  if (legacy && typeof legacy === "object") {
    for (const [task, val] of Object.entries(legacy)) {
      if (val?.provider && val?.model) {
        result[task] = { provider: val.provider, model: val.model };
      }
    }
  }

  // Canonical second (higher priority, overwrites per-task): config.llm.tasks
  const llm = config.llm as { provider?: string; tasks?: Record<string, TaskRoute> } | undefined;
  if (llm?.tasks && typeof llm.tasks === "object") {
    for (const [task, val] of Object.entries(llm.tasks)) {
      if (val?.provider && val?.model) {
        result[task] = { provider: val.provider, model: val.model };
      }
    }
  }

  return result;
}

/**
 * Write a task routing override. Always writes to canonical config.llm.tasks.
 *
 * VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: rejects non-canonical
 * task names by throwing `NonCanonicalTaskError` BEFORE touching the
 * config file. The pre-flight guard ensures a rejected write is
 * provably side-effect-free (no partial config mutation, no disk
 * write). Callers must catch this error and map it to a 400/rejected
 * response — see /providers/defaults, /dashboard/providers/defaults,
 * and the providers/set_default_model dispatch case.
 *
 * Whitespace tolerance: trims `task` at the top so the helper agrees
 * with the validators' effective rule (validators all do
 * `CANONICAL_TASKS.includes(p.task.trim())`). Without this, a stale
 * queued row with `task_type: " draft_review "` would pass validation
 * but be rejected here as `NonCanonicalTaskError` — dead-on-arrival.
 * Mirrors the trim-at-top pattern in writeAgentOverride /
 * clearAgentOverride.
 */
export function writeTaskRoute(task: string, route: TaskRoute): { previous: TaskRoute | null; next: TaskRoute } {
  const trimmedTask = (task || "").trim();
  assertCanonicalTask(trimmedTask);
  const config = readConfig();
  const llm = (config.llm || {}) as Record<string, unknown>;
  const tasks = (llm.tasks || {}) as Record<string, TaskRoute>;
  const previous = tasks[trimmedTask] || null;
  tasks[trimmedTask] = route;
  llm.tasks = tasks;
  if (!llm.provider) llm.provider = route.provider; // set default provider if not set
  config.llm = llm;
  writeConfig(config);
  return { previous, next: route };
}

/**
 * Clear one task routing override (VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1).
 *
 * Surgical delete from BOTH the canonical (config.llm.tasks) AND the
 * legacy (config.model_defaults) storage paths so the next read of
 * `effective_routing` honestly falls back to the recommended default
 * — otherwise a legacy entry would silently shadow the cleared
 * canonical override.
 *
 * IDEMPOTENT: clearing a task that has no current override returns
 * `{cleared: false, previous: null}` and DOES NOT rewrite the config
 * file. That keeps disk activity proportional to actual changes.
 *
 * Sibling preservation:
 *   - other tasks under llm.tasks → untouched
 *   - llm.provider                → untouched (do not delete the
 *     default provider just because a task entry was removed)
 *   - llm.tasks itself            → kept even when emptied to {}
 *     (the readers already treat {} the same as "no overrides", so
 *     this avoids gratuitous structural churn)
 *   - config.providers metadata   → untouched
 *   - config.providers.<name>.*   → untouched (validation cache,
 *     last_error, etc., all preserved)
 */
export function clearTaskRoute(
  task: string,
  _actor: string = "operator",
): { cleared: boolean; previous: TaskRoute | null } {
  // Whitespace tolerance — same rule as writeTaskRoute / write+clear
  // agent-override helpers. Without this, a queued
  // clear_default_model row with `task_type: " draft_review "` would
  // pass the validator (which trims internally for the canonical
  // check) but find no matching key here and silently no-op as if
  // the override was already clear. Trimming at the top means
  // helper and validator agree.
  const trimmedTask = (task || "").trim();
  const config = readConfig();

  // Capture the explicit canonical override and any shadowing legacy
  // entry. Idempotent return when both are absent.
  const llm = (config.llm || {}) as Record<string, unknown>;
  const canonicalTasks = (llm.tasks || {}) as Record<string, TaskRoute>;
  const canonicalPrev = canonicalTasks[trimmedTask] || null;

  const legacy = (config.model_defaults || {}) as Record<string, { provider?: string; model?: string }>;
  const legacyEntry = legacy[trimmedTask];
  const legacyPrev =
    legacyEntry && typeof legacyEntry.provider === "string" && typeof legacyEntry.model === "string"
      ? { provider: legacyEntry.provider, model: legacyEntry.model }
      : null;

  if (!canonicalPrev && !legacyPrev) {
    // Nothing to remove — explicit no-op success. Skip the disk write.
    return { cleared: false, previous: null };
  }

  // Surgical canonical delete. Preserve every sibling key.
  if (canonicalPrev) {
    delete canonicalTasks[trimmedTask];
    llm.tasks = canonicalTasks;
    config.llm = llm;
  }

  // Surgical legacy delete so the read fallback no longer shadows
  // the cleared canonical override.
  if (legacyPrev) {
    delete legacy[trimmedTask];
    config.model_defaults = legacy;
  }

  writeConfig(config);

  // Canonical takes precedence in `previous` when both existed.
  return { cleared: true, previous: canonicalPrev || legacyPrev };
}

// ── Provider metadata (non-secret: config.providers) ─────────────────

export interface ProviderMetadata {
  configured: boolean;
  configured_at: string | null;
  configured_by: string | null;
  validation_status: "ok" | "failed" | "unconfigured" | "unsupported" | "unknown";
  last_validated_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

/**
 * Read provider metadata. Merges actual key presence from secrets with
 * non-secret metadata from config.providers.
 */
export function readProviderStatus(): Record<string, ProviderMetadata> {
  const config = readConfig();
  const secrets = readSecrets();
  const providersMeta = (config.providers || {}) as Record<string, Record<string, unknown>>;

  const result: Record<string, ProviderMetadata> = {};

  // Scan all known providers + any configured in metadata
  const allProviders = new Set([...Object.keys(PROVIDER_KEY_MAP), ...Object.keys(providersMeta)]);

  for (const name of allProviders) {
    const envVar = PROVIDER_KEY_MAP[name];
    const hasKey = envVar ? !!(secrets[envVar] || process.env[envVar]) : false;
    const meta = providersMeta[name] || {};

    // Legacy: config.providers.*.api_key (read but never write)
    const legacyKey = meta.api_key as string | undefined;
    const effectivelyConfigured = hasKey || !!legacyKey;

    result[name] = {
      configured: effectivelyConfigured,
      configured_at: (meta.configured_at as string) || null,
      configured_by: (meta.configured_by as string) || null,
      validation_status: effectivelyConfigured
        ? ((meta.validation_status as string) || "unknown") as ProviderMetadata["validation_status"]
        : "unconfigured",
      last_validated_at: (meta.last_validated_at as string) || null,
      last_success_at: (meta.last_success_at as string) || null,
      last_error: (meta.last_error as string) || null,
    };
  }

  return result;
}

/**
 * Redacted summary for API responses. NEVER includes API keys.
 *
 * VO-PROVIDER-TASK-ROUTE-CLEAR-PR-1: adds explicit `task_overrides`
 * — the set of tasks with a persisted explicit route override (from
 * either canonical config.llm.tasks or legacy config.model_defaults).
 * UIs MUST drive Clear affordances from `task_overrides`, NOT from
 * `effective_routing != recommended_defaults` — the latter happens to
 * match for tasks that were intentionally set to the same value as
 * the recommendation, which would render a false-negative Clear
 * button. Mirrored governance flow uses the same field naturally.
 */
export function readProviderSummary(): {
  providers: Record<string, ProviderMetadata>;
  task_routing: Record<string, TaskRoute>;
  task_overrides: Record<string, TaskRoute>;
  legacy_task_routes: Record<string, TaskRoute>;
  recommended_defaults: Record<string, TaskRoute>;
  effective_routing: Record<string, TaskRoute>;
} {
  const providers = readProviderStatus();
  const taskRouting = readTaskRouting();

  // Effective: explicit override > recommended default
  const effective: Record<string, TaskRoute> = {};
  for (const task of CANONICAL_TASKS) {
    effective[task] = taskRouting[task] || RECOMMENDED_DEFAULTS[task];
  }
  // Include any non-canonical tasks the tenant defined
  for (const [task, route] of Object.entries(taskRouting)) {
    if (!effective[task]) effective[task] = route;
  }

  // `task_overrides` is filtered to CANONICAL_TASKS membership.
  // Why: the existing set paths (writeTaskRoute, /providers/defaults,
  // /dashboard/providers/defaults, set_default_model dispatch) all
  // accept arbitrary task names, so non-canonical entries can already
  // exist in config. The clear path is canonical-only by contract, so
  // surfacing a non-canonical entry here would render a Clear button
  // (UIs gate on `task_overrides[task]`) that always errors on submit.
  // Filter at the source so both hosted and local UIs honestly hide
  // the affordance for tasks no clear command can target.
  // `task_routing` and `effective_routing` keep the unfiltered data
  // for back-compat readers — only this Clear-affordance contract is
  // narrowed.
  const canonicalOverrides: Record<string, TaskRoute> = {};
  const legacyRoutes: Record<string, TaskRoute> = {};
  for (const [task, route] of Object.entries(taskRouting)) {
    if (isCanonicalTask(task)) {
      canonicalOverrides[task] = route;
    } else {
      // Existing non-canonical persisted entries — surfaced separately
      // for honest read-only display. New writes are blocked at every
      // surface (writeTaskRoute throws), so this map only ever shrinks
      // (via direct config edit) — never grows.
      legacyRoutes[task] = route;
    }
  }

  return {
    providers,
    // Existing field, unchanged for back-compat. Includes any
    // non-canonical task entries that may live in legacy or canonical
    // config storage.
    task_routing: taskRouting,
    // Explicit-override contract for Clear UIs. Canonical-only —
    // Clear command rejects non-canonical task_type, so a Clear button
    // for a non-canonical entry would always error on submit.
    task_overrides: canonicalOverrides,
    // VO-PROVIDER-TASK-ROUTE-CANONICALIZE-PR-1: explicit read-only
    // surface for persisted non-canonical task routes. UIs render
    // these in a dedicated "Legacy Task Routes" card with no Edit
    // and no Clear — neither operation is supported for them.
    legacy_task_routes: legacyRoutes,
    recommended_defaults: RECOMMENDED_DEFAULTS,
    effective_routing: effective,
  };
}

// ── Provider key management (writes to secrets, metadata to config) ──

export function setProviderKey(
  provider: string,
  key: string,
  actor: string = "operator",
): { provider: string; configured: true } {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) {
    throw new Error(`Unknown provider: ${provider}. Supported: ${Object.keys(PROVIDER_KEY_MAP).join(", ")}`);
  }

  // Write key to secrets.env
  writeSecret(envVar, key);

  // Write non-secret metadata to config.providers
  const config = readConfig();
  const providers = (config.providers || {}) as Record<string, Record<string, unknown>>;
  const meta = providers[provider] || {};
  // Remove any legacy api_key from config.json
  delete meta.api_key;
  meta.configured_at = new Date().toISOString();
  meta.configured_by = actor;
  providers[provider] = meta;
  config.providers = providers;
  writeConfig(config);

  return { provider, configured: true };
}

export function removeProviderKey(
  provider: string,
  actor: string = "operator",
): { provider: string; removed: true } {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (envVar) {
    removeSecret(envVar);
  }

  // Update metadata
  const config = readConfig();
  const providers = (config.providers || {}) as Record<string, Record<string, unknown>>;
  const meta = providers[provider] || {};
  delete meta.api_key; // clean legacy
  meta.removed_at = new Date().toISOString();
  meta.removed_by = actor;
  meta.validation_status = "unconfigured";
  providers[provider] = meta;
  config.providers = providers;
  writeConfig(config);

  return { provider, removed: true };
}

// ── Validation cache (non-secret metadata in config.providers) ───────

export function updateValidationCache(
  provider: string,
  status: "ok" | "failed" | "unconfigured" | "unsupported",
  error?: string,
): void {
  const config = readConfig();
  const providers = (config.providers || {}) as Record<string, Record<string, unknown>>;
  const meta = providers[provider] || {};
  meta.validation_status = status;
  meta.last_validated_at = new Date().toISOString();
  if (status === "ok") {
    meta.last_success_at = new Date().toISOString();
    meta.last_error = null;
  } else {
    meta.last_error = error || null;
  }
  providers[provider] = meta;
  config.providers = providers;
  writeConfig(config);
}

/**
 * Read the raw API key for a provider. For validation only — NEVER return
 * this from an API response.
 */
export function readProviderKey(provider: string): string | null {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) return null;
  const secrets = readSecrets();
  return secrets[envVar] || process.env[envVar] || null;
}

// ── Per-agent LLM overrides ──────────────────────────────────────────

export interface AgentLlmOverride {
  [task: string]: TaskRoute;
}

/** Exported for test use and route use. */
export { resolveConfigPath, resolveSecretsPath };

// ─── Novice onboarding seam ─────────────────────────────────────────────
//
// VO-NOVICE-ONBOARDING-PR-1. Before this PR the CLI redefined its own
// recommended defaults, provider env-var map, config read/write, and
// secrets-file write logic — a full second onboarding system that could
// drift from this module silently. These exports turn vo onboard /
// vo onboard-status / vo onboard-proof into thin wrappers.

/**
 * Short masked view of an API key for status/summary output. Never
 * returns the full secret. 4 leading + 4 trailing chars when long
 * enough; "***" when shorter.
 */
export function redactKey(key: string | null | undefined): string {
  if (!key) return "***";
  if (key.length < 8) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

/**
 * Load `secrets.env` into `process.env` without overwriting already-set
 * vars. VO_CONFIG_PATH-aware: uses `resolveSecretsPath()` by default so
 * the bootstrap loader in vo-cli.ts agrees with onboarding writes and
 * with `vo onboard-proof` under an isolated config dir. The optional
 * `explicitPath` argument is for proof-style tests that run against a
 * temp dir.
 */
export function loadSecretsEnv(explicitPath?: string): void {
  const secretsPath = explicitPath || resolveSecretsPath();
  if (!fs.existsSync(secretsPath)) return;
  const lines = fs.readFileSync(secretsPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Tolerate a leading `export ` (batch-31; matches mcp/src/config.ts).
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const eqIdx = body.indexOf("=");
    if (eqIdx < 1) continue;
    const key = body.slice(0, eqIdx).trim();
    const val = body.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

/**
 * Overall onboarding readiness. Ordered most-to-least healthy — status
 * surfaces should pick the FIRST matching state to avoid "configured
 * but key missing" showing up as "partial" when a specific diagnosis
 * exists.
 *   not_started            — no provider metadata, no task routes
 *   partial                — provider configured but task routing
 *                            missing entries OR vice versa
 *   configured             — provider configured, all canonical task
 *                            routes present, key present
 *   configured_key_missing — provider + task routes present but the
 *                            provider's secret key is not loaded
 *   configured_task_missing— provider + secret present but at least one
 *                            canonical task has no route
 */
export type OnboardingOverallState =
  | "not_started"
  | "partial"
  | "configured"
  | "configured_key_missing"
  | "configured_task_missing";

export interface OnboardingTaskView {
  task: string;
  label: string;
  provider: string;
  providerLabel: string;
  model: string;
  keyLoaded: boolean;
  envVar: string | null;
  source: "override" | "default";
}

export interface OnboardingState {
  overallState: OnboardingOverallState;
  providerName: string | null;
  providerLabel: string | null;
  providerConfigured: boolean;
  keyLoaded: boolean;
  taskViews: OnboardingTaskView[];
  missingTasks: string[];
  missingKeys: string[];
  nextStep: string;
  configPath: string;
  secretsPath: string;
  /** Whether a secrets.env file exists at secretsPath. */
  secretsFileExists: boolean;
}

function inferProviderFromConfig(): string | null {
  const config = readConfig();
  const llm = config.llm as { provider?: string } | undefined;
  if (llm?.provider) return llm.provider;
  // Fallback — pick the first configured provider in metadata.
  const providers = readProviderStatus();
  for (const [name, meta] of Object.entries(providers)) {
    if (meta.configured) return name;
  }
  return null;
}

/**
 * Canonical readiness read for status / proof / support surfaces.
 * Pure (no writes). Never returns secrets.
 */
export function readOnboardingState(): OnboardingState {
  const configPath = resolveConfigPath();
  const secretsPath = resolveSecretsPath();
  const secretsFileExists = fs.existsSync(secretsPath);
  const secrets = readSecrets();
  const providerStatus = readProviderStatus();
  const taskRouting = readTaskRouting();

  const providerName = inferProviderFromConfig();
  const providerMeta = providerName ? providerStatus[providerName] : undefined;
  // "Provider configured" tracks the historical fact that onboarding
  // ran successfully for this provider (i.e. `config.providers.<name>.
  // configured_at` was set by setProviderKey). That axis is separate
  // from "key loaded right now" — which is what `providerMeta.configured`
  // happens to encode in readProviderStatus. Using `configured_at` here
  // is what makes `configured_key_missing` distinguishable from
  // `partial` after the tenant deletes their secrets.env.
  const providerConfigured = !!providerMeta?.configured_at;
  const envVar = providerName ? PROVIDER_ENV_VAR[providerName] : null;
  const keyLoaded = !!(envVar && (secrets[envVar] || process.env[envVar]));

  const missingTasks: string[] = [];
  const missingKeys = new Set<string>();
  const taskViews: OnboardingTaskView[] = [];

  for (const task of CANONICAL_TASKS) {
    // `persistedRoute` is the tenant's actual config.llm.tasks entry
    // for this canonical task (or the legacy config.model_defaults
    // shadow, if any). A canonical task with NO persisted route is
    // unconfigured even if the provider was historically configured —
    // onboarding may have been partial, the tenant may have hand-
    // edited the config, or a migration may have dropped a key. The
    // status surface must flag this honestly instead of silently
    // substituting RECOMMENDED_DEFAULTS and reporting "configured".
    const persistedRoute = taskRouting[task];
    const recommended = RECOMMENDED_DEFAULTS[task];
    const route = persistedRoute || recommended;
    const taskEnvVar = PROVIDER_ENV_VAR[route.provider] || null;
    const taskKeyLoaded = !!(taskEnvVar && (secrets[taskEnvVar] || process.env[taskEnvVar]));
    if (!persistedRoute) missingTasks.push(task);
    if (!taskKeyLoaded && taskEnvVar) missingKeys.add(taskEnvVar);
    // `source: "override"` means the persisted route deliberately
    // differs from the recommended default (model OR provider). A
    // persisted route that happens to match the recommendation is
    // reported as `default` so the UI's "(override)" marker is
    // meaningful instead of printed on every seeded row.
    const isOverride = !!persistedRoute && (
      persistedRoute.model !== recommended.model ||
      persistedRoute.provider !== recommended.provider
    );
    taskViews.push({
      task,
      label: taskLabel(task),
      provider: route.provider,
      providerLabel: providerLabel(route.provider),
      model: route.model,
      keyLoaded: taskKeyLoaded,
      envVar: taskEnvVar,
      source: isOverride ? "override" : "default",
    });
  }

  // `allTaskKeysLoaded` is the load-bearing "are we ready" signal for
  // the gradient. A tenant whose primary provider is google (key
  // loaded) can still be one override away from "ready" if they
  // pointed one task at a second provider whose env var is missing —
  // per-task keyLoaded must fold into the overall state so the
  // gradient can't silently report `configured` with a task row
  // showing `[✗ key missing]`.
  const allTaskKeysLoaded = taskViews.every((v) => v.keyLoaded);

  let overallState: OnboardingOverallState;
  let nextStep: string;
  if (!providerConfigured && !Object.keys(taskRouting).length) {
    overallState = "not_started";
    nextStep = "Run `vo onboard` to configure an AI provider and API key.";
  } else if (!providerConfigured || missingTasks.length === CANONICAL_TASKS.length) {
    overallState = "partial";
    nextStep = "Run `vo onboard` to finish provider + task setup.";
  } else if (missingTasks.length > 0) {
    overallState = "configured_task_missing";
    nextStep = `Run \`vo onboard\` to fill missing task routes: ${missingTasks.map(taskLabel).join(", ")}.`;
  } else if (!keyLoaded || !allTaskKeysLoaded) {
    overallState = "configured_key_missing";
    const missingEnvVars = Array.from(missingKeys);
    if (missingEnvVars.length > 0) {
      nextStep = `Run \`vo onboard\` to provide the missing API key(s): ${missingEnvVars.join(", ")}.`;
    } else {
      nextStep = `Run \`vo onboard\` to provide a ${providerLabel(providerName || "")} API key.`;
    }
  } else {
    overallState = "configured";
    nextStep = "Run `vo doctor` to confirm the full stack is healthy, then `vo vault init` when you are ready.";
  }

  return {
    overallState,
    providerName,
    providerLabel: providerName ? providerLabel(providerName) : null,
    providerConfigured,
    keyLoaded,
    taskViews,
    missingTasks,
    missingKeys: Array.from(missingKeys),
    nextStep,
    configPath,
    secretsPath,
    secretsFileExists,
  };
}

/**
 * Apply an onboarding setup: write provider key to secrets.env, seed
 * recommended task routes for any canonical task that does not already
 * have one, and apply explicit overrides on top. Surgical by design —
 * unchanged canonical tasks that already carry a persisted route are
 * NOT rewritten, which preserves the task-override checklist contract
 * ("the tenant may override one task without rewriting the others").
 *
 * On re-run with no overrides: only missing-route tasks get defaults
 * seeded; pre-existing routes are left alone.
 *
 * On re-run with one override: only that task is touched. All other
 * per-task configuration is preserved verbatim.
 */
export function writeOnboardingSetup(opts: {
  provider: string;
  apiKey: string;
  taskOverrides?: Record<string, string>;
  actor?: string;
}): {
  provider: string;
  tasksWritten: Array<{ task: string; model: string; source: "override" | "default_seed" }>;
  secretsPath: string;
  configPath: string;
} {
  const actor = opts.actor || "cli:onboard";
  setProviderKey(opts.provider, opts.apiKey, actor);

  const existing = readTaskRouting();
  const overrides = opts.taskOverrides || {};
  const written: Array<{ task: string; model: string; source: "override" | "default_seed" }> = [];

  for (const task of CANONICAL_TASKS) {
    const overrideModel = overrides[task];
    if (overrideModel) {
      writeTaskRoute(task, { model: overrideModel, provider: opts.provider });
      written.push({ task, model: overrideModel, source: "override" });
      continue;
    }
    if (!existing[task]) {
      const def = RECOMMENDED_DEFAULTS[task];
      writeTaskRoute(task, { model: def.model, provider: opts.provider });
      written.push({ task, model: def.model, source: "default_seed" });
    }
    // Task already has a route and no override — leave untouched.
  }

  return {
    provider: opts.provider,
    tasksWritten: written,
    secretsPath: resolveSecretsPath(),
    configPath: resolveConfigPath(),
  };
}
