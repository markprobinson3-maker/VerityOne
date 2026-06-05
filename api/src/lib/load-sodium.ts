// @ts-ignore - .cjs shim has no type declarations
import sodiumModule from "./sodium-cjs.cjs";

/**
 * libsodium-wrappers-sumo's ESM build relative-imports a sibling it never ships, so
 * `import("libsodium-wrappers-sumo")` fails inside bun's module graph. The CJS build
 * works; we reach it through ./sodium-cjs.cjs (a `require` shim). The shim ALSO lets bun
 * bundle libsodium (+ its libsodium-sumo wasm dep) straight into the serverless artifact,
 * so the hosted Drive token seal does not depend on node_modules being shipped to the
 * Vercel function (bun's symlinked .bun store is not). Cached so sodium initializes once.
 */
let cached: any = null;

export async function loadSodium(): Promise<any> {
  if (!cached) {
    cached = (sodiumModule as any)?.default ?? sodiumModule;
  }
  await cached.ready;
  return cached;
}
