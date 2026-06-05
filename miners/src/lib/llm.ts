/**
 * Shared Gemini client — single source of truth for runtime model selection,
 * API key resolution, fallbacks, and response extraction.
 */

export function getGoogleApiKey(): string {
  return process.env.OPENCLAW_GOOGLE_API_KEY
    || process.env.GOOGLE_API_KEY
    || "";
}

function parseCandidateList(raw: string | undefined, defaults: string[]): string[] {
  const values = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : defaults;
}

const MODEL_CANDIDATES = {
  flash: parseCandidateList(process.env.OPENCLAW_GEMINI_FLASH_MODEL, [
    "gemini-2.5-flash",
  ]),
  pro: parseCandidateList(process.env.OPENCLAW_GEMINI_PRO_MODEL, [
    "gemini-2.5-pro",
    "gemini-3-pro-preview",
  ]),
  "flash-lite": parseCandidateList(process.env.OPENCLAW_GEMINI_FLASH_LITE_MODEL, [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
  ]),
  "flash-3": parseCandidateList(process.env.OPENCLAW_GEMINI_FLASH_FALLBACK_MODEL, [
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
  ]),
} as const;

type ModelName = keyof typeof MODEL_CANDIDATES;

type CooldownEntry = {
  until: number;
  reason: string;
};

type CandidateAvailability = {
  available: string[];
  retryAfterMs: number;
};

interface LLMConfig {
  model?: ModelName;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  jsonMode?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Optional spend hook (item 5). When set, it is invoked BEST-EFFORT with the call result after
   * a successful LLM call so the worker's spend can be recorded (e.g. makeWorkerSpendRecorder from
   * api/src/lib/worker-llm-spend). A throw from the hook is swallowed — it never breaks the call.
   */
  spend?: (result: { modelId: string; inputTokens: number | null; outputTokens: number | null }) => void | Promise<void>;
}

export interface LLMResult {
  text: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function modelUrl(modelId: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
}

function extractText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("");
}

function isRetryableModelFailure(status: number): boolean {
  return status === 404 || status === 429 || status === 500 || status === 503;
}

function cooldownMsForStatus(status: number): number {
  if (status === 404) return 6 * 60 * 60 * 1000;
  if (status === 429) return 3 * 60 * 1000;
  if (status === 500 || status === 503) return 2 * 60 * 1000;
  return 0;
}

const modelCooldowns = new Map<string, CooldownEntry>();

function getCandidateAvailability(model: ModelName): CandidateAvailability {
  const now = Date.now();
  const all = MODEL_CANDIDATES[model];
  let retryAfterMs = 0;
  const available = all.filter((candidate) => {
    const cooldown = modelCooldowns.get(candidate);
    if (!cooldown) return true;
    if (cooldown.until <= now) {
      modelCooldowns.delete(candidate);
      return true;
    }
    retryAfterMs = retryAfterMs > 0
      ? Math.min(retryAfterMs, cooldown.until - now)
      : (cooldown.until - now);
    return false;
  });
  return { available, retryAfterMs };
}

function noteModelFailure(modelId: string, status: number): void {
  const cooldownMs = cooldownMsForStatus(status);
  if (cooldownMs <= 0) return;
  modelCooldowns.set(modelId, {
    until: Date.now() + cooldownMs,
    reason: `HTTP ${status}`,
  });
}

async function callCandidate(prompt: string, modelId: string, config: Omit<LLMConfig, "model">): Promise<LLMResult> {
  const {
    temperature = 0.3,
    maxTokens = 4096,
    systemPrompt,
    jsonMode = false,
    signal,
    timeoutMs,
  } = config;

  const apiKey = getGoogleApiKey();
  const url = `${modelUrl(modelId)}?key=${apiKey}`;
  const contents: any[] = [];
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    const abortHandler = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abortHandler, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", abortHandler));
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    cleanup.push(() => clearTimeout(timeout));
  }

  if (systemPrompt) {
    contents.push({ role: "user", parts: [{ text: systemPrompt }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const generationConfig: any = { temperature, maxOutputTokens: maxTokens };
  if (jsonMode) generationConfig.responseMimeType = "application/json";
  if (modelId.includes("flash")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, generationConfig }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      const error: any = new Error(`LLM error ${res.status} (${modelId}): ${errText.slice(0, 300)}`);
      error.status = res.status;
      error.modelId = modelId;
      error.body = errText;
      throw error;
    }

    const data = (await res.json()) as any;
    const usage = data?.usageMetadata || {};
    const inputTokens = Number.isFinite(Number(usage.promptTokenCount)) ? Number(usage.promptTokenCount) : null;
    const outputTokens = Number.isFinite(Number(usage.candidatesTokenCount)) ? Number(usage.candidatesTokenCount) : null;
    const totalTokens = Number.isFinite(Number(usage.totalTokenCount)) ? Number(usage.totalTokenCount) : null;
    return {
      text: extractText(data),
      modelId,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  } finally {
    for (const fn of cleanup) fn();
  }
}

export async function callLLMWithModel(prompt: string, config: LLMConfig = {}): Promise<LLMResult> {
  if (!getGoogleApiKey()) throw new Error("OPENCLAW_GOOGLE_API_KEY / GOOGLE_API_KEY not set");

  const {
    model = "flash",
    ...rest
  } = config;
  const { available: candidates, retryAfterMs } = getCandidateAvailability(model);
  if (candidates.length === 0) {
    const error: any = new Error(
      `All ${model} model candidates are cooling down; retry in ${Math.max(1, Math.round(retryAfterMs / 1000))}s`,
    );
    error.name = "ModelCooldownError";
    error.retryAfterMs = retryAfterMs || cooldownMsForStatus(429);
    error.model = model;
    error.candidates = [...MODEL_CANDIDATES[model]];
    throw error;
  }
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await callCandidate(prompt, candidate, rest);
      // Best-effort spend accounting (item 5) — a throw here must never break the LLM call.
      if (config.spend) {
        try {
          await config.spend(result);
        } catch (spendErr: any) {
          console.warn(`[LLM] spend hook failed (ignored): ${spendErr?.message || spendErr}`);
        }
      }
      return result;
    } catch (error: any) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (isRetryableModelFailure(status)) {
        noteModelFailure(candidate, status);
      }
      if (!isRetryableModelFailure(status) || i === candidates.length - 1) {
        break;
      }
      console.warn(`[LLM] ${model} fallback ${candidate} failed (${error?.status || "?"}); trying ${candidates[i + 1]}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`LLM call failed for ${model}`);
}

export async function callLLM(prompt: string, config: LLMConfig = {}): Promise<string> {
  return (await callLLMWithModel(prompt, config)).text;
}

// Convenience aliases
export const callFlash = (prompt: string, config: Omit<LLMConfig, "model"> = {}) =>
  callLLM(prompt, { ...config, model: "flash" });

export const callPro = (prompt: string, config: Omit<LLMConfig, "model"> = {}) =>
  callLLM(prompt, { ...config, model: "pro" });

export const getModelId = (model: ModelName): string => {
  const { available } = getCandidateAvailability(model);
  return available[0] || MODEL_CANDIDATES[model][0];
};
export const getModelCandidates = (model: ModelName): string[] => [...MODEL_CANDIDATES[model]];
export const __testing = {
  noteModelFailure,
  clearModelCooldowns: () => modelCooldowns.clear(),
  getCandidateAvailability,
};

/**
 * Call Flash Lite (WI primary model) with automatic fallback to Gemini 2.5 Flash.
 * 15s timeout. Falls back on: HTTP error, timeout, JSON parse failure, 429.
 */
export async function callFlashLite(
  prompt: string,
  config: Omit<LLMConfig, "model"> = {},
  useFallback = false,
): Promise<string> {
  return (await callFlashLiteWithModel(prompt, config, useFallback)).text;
}

export async function callFlashLiteWithModel(
  prompt: string,
  config: Omit<LLMConfig, "model"> = {},
  useFallback = false,
): Promise<LLMResult> {
  const model: ModelName = useFallback ? "flash-3" : "flash-lite";
  return callLLMWithModel(prompt, { ...config, model, timeoutMs: config.timeoutMs ?? 15_000 });
}
