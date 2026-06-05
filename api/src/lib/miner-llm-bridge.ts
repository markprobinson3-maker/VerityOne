import { getDeploymentProfile } from "./db-config";

type MinerLlmOptions = {
  systemPrompt?: string;
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

type MinerLlmModule = {
  callFlash: (prompt: string, options: MinerLlmOptions) => Promise<string>;
  callFlashLite: (prompt: string, options: MinerLlmOptions) => Promise<string>;
};

async function loadMinerLlm(): Promise<MinerLlmModule | null> {
  if (getDeploymentProfile() === "serverless") return null;
  try {
    return await import("../../../miners/src/lib/llm") as MinerLlmModule;
  } catch {
    return null;
  }
}

export async function callOptionalMinerFlash(
  prompt: string,
  options: MinerLlmOptions,
): Promise<string | null> {
  const llm = await loadMinerLlm();
  if (!llm) return null;
  try {
    return await llm.callFlash(prompt, options);
  } catch {
    return null;
  }
}

export async function callOptionalMinerFlashLite(
  prompt: string,
  options: MinerLlmOptions,
): Promise<string | null> {
  const llm = await loadMinerLlm();
  if (!llm) return null;
  try {
    return await llm.callFlashLite(prompt, options);
  } catch {
    return null;
  }
}
