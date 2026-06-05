/**
 * Verity Ingest — Adapter Registry
 *
 * Auto-discovers *.adapter.ts files in this directory.
 */

import type { ViAdapter } from "./types";

const adapters = new Map<string, ViAdapter>();

export function registerAdapter(adapter: ViAdapter) {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): ViAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): ViAdapter[] {
  return Array.from(adapters.values());
}

/** Auto-discover: import all *.adapter.ts files in this directory */
export async function loadAdapters() {
  const glob = new Bun.Glob("*.adapter.ts");
  for await (const file of glob.scan({ cwd: import.meta.dir })) {
    const mod = await import(`./${file}`);
    if (mod.adapter) registerAdapter(mod.adapter);
  }
}
