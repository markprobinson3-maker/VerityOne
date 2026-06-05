// CJS shim for libsodium-wrappers-sumo.
//
// The package's "exports" map routes `import` to a broken ESM build
// (dist/modules-sumo-esm/libsodium-wrappers.mjs, which relative-imports a sibling it
// never ships) and `require` to the WORKING CommonJS build. Reaching libsodium through
// this `require` shim (instead of an ESM import or a runtime createRequire) lets bun
// BUNDLE libsodium — and its libsodium-sumo wasm dependency — directly into the
// serverless artifact. That matters on Vercel: bun installs into a symlinked `.bun`
// store that is not shipped to the function, so a runtime node_modules lookup fails and
// the hosted Drive token seal throws ("oauth_callback_failed"). Bundling removes the
// runtime dependency entirely.
module.exports = require("libsodium-wrappers-sumo");
