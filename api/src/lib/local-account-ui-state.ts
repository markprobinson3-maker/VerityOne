import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./runtime-profile";

export const HOSTED_ACCOUNT_ERROR_TTL_MS = 10 * 60 * 1000;

export interface LocalHostedAccountError {
  code: string;
  message: string;
  recorded_at: string;
}

export interface LocalAccountUiState {
  show_google_email?: boolean;
  hosted_error?: LocalHostedAccountError | null;
}

function statePath(): string {
  return path.join(path.dirname(resolveConfigPath()), "account-ui-state.json");
}

function writeState(state: LocalAccountUiState): void {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

function isFresh(error: LocalHostedAccountError | null | undefined): boolean {
  if (!error?.recorded_at) return false;
  const ts = new Date(error.recorded_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= HOSTED_ACCOUNT_ERROR_TTL_MS;
}

export function readLocalAccountUiState(): LocalAccountUiState {
  let parsed: LocalAccountUiState = {};
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
  return {
    show_google_email: parsed.show_google_email === false ? false : parsed.show_google_email === true ? true : undefined,
    hosted_error: isFresh(parsed.hosted_error) ? parsed.hosted_error! : null,
  };
}

export function writeLocalAccountUiPreferenceCache(input: { show_google_email: boolean }): LocalAccountUiState {
  const current = readLocalAccountUiState();
  if (current.show_google_email === input.show_google_email) return current;
  const next: LocalAccountUiState = {
    ...current,
    show_google_email: input.show_google_email,
  };
  writeState(next);
  return next;
}

export function recordHostedAccountError(input: { code: string; message: string }): LocalAccountUiState {
  const current = readLocalAccountUiState();
  const code = String(input.code || "hosted_unreachable");
  const message = String(input.message || "Hosted account state is unavailable.");
  if (current.hosted_error?.code === code && current.hosted_error.message === message) {
    return current;
  }
  const next: LocalAccountUiState = {
    ...current,
    hosted_error: {
      code,
      message,
      recorded_at: new Date().toISOString(),
    },
  };
  writeState(next);
  return next;
}

export function clearHostedAccountError(): LocalAccountUiState {
  const current = readLocalAccountUiState();
  if (!current.hosted_error) return current;
  const next: LocalAccountUiState = {
    ...current,
    hosted_error: null,
  };
  writeState(next);
  return next;
}
