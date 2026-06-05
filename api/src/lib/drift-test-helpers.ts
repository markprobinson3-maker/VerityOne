/**
 * Drift-test source-slicing helpers — VO-DRIFT-TEST-HELPER-HARDENING-PR-1.
 *
 * The federation/foundation drift guards pin invariants by slicing a region of
 * a source file and asserting on its text. The historical idioms were fragile
 * in two ways that this module fixes:
 *
 *   1. FIXED-WINDOW function slices — `src.slice(idx, idx + 9500)`. Adding lines
 *      anywhere above the target silently pushes content out of the window, so
 *      the guard either fails confusingly or (worse) stops covering the thing
 *      it was meant to pin. `extractFunctionSource` brace-matches the actual
 *      function body, so it is immune to line additions.
 *
 *   2. VACUOUS slices — `const idx = src.indexOf(MARKER); src.slice(idx, …)`
 *      with no `idx !== -1` check. If MARKER is renamed/moved, `idx` is -1 and
 *      the slice silently reads garbage from the END of the string, so the
 *      assertion can pass against the wrong region (a guard that has quietly
 *      stopped guarding). Every helper here is FAIL-LOUD: a missing anchor
 *      THROWS with a clear message instead of returning a -1/empty slice.
 *
 * These throw plain Errors (no bun:test coupling); a throw inside a test is a
 * loud, clearly-attributed failure. This module is test-support only — it is
 * imported solely by *.test.ts and is never reachable from the runtime
 * (api/src/app.ts) import graph, so it is not in the serverless bundle.
 */

/** Find `marker` in `src`, throwing a clear error if it is absent. The
 *  anti-vacuous primitive: callers can never accidentally slice from -1. */
export function requireIndex(
  src: string,
  marker: string,
  label = "marker",
  fromIndex = 0,
): number {
  const idx = src.indexOf(marker, fromIndex);
  if (idx < 0) {
    throw new Error(
      `drift-test-helpers.requireIndex: ${label} not found: ${JSON.stringify(
        marker.length > 80 ? marker.slice(0, 80) + "…" : marker,
      )}`,
    );
  }
  return idx;
}

/**
 * Return the source between `startMarker` and `endMarker` (end searched AFTER
 * the start). Both anchors are required; a missing or misordered anchor throws.
 * The returned slice runs from the start of `startMarker` up to (excluding)
 * `endMarker`.
 */
export function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const startIdx = requireIndex(src, startMarker, "start marker");
  const endIdx = requireIndex(src, endMarker, "end marker", startIdx + startMarker.length);
  return src.slice(startIdx, endIdx);
}

/**
 * Extract the full source of a function (or method) given a fragment of its
 * signature (e.g. `"export async function queueHostedMcpWriteIntent"`). Finds
 * the signature, walks to the body's opening brace — skipping braces inside the
 * parameter list `(...)` and inside a generic return type `<...>` — then
 * balanced-matches to the closing brace. String/template/comment aware, so
 * braces inside strings or comments do not skew the depth count.
 *
 * Immune to line additions anywhere in the file (unlike a fixed-width window).
 * Throws if the signature is absent or the braces never balance.
 *
 * LIMITATION: a function whose RETURN TYPE is an inline object literal written
 * WITHOUT generic brackets (e.g. `function f(): { x: number } {`) would anchor
 * on the return-type brace. None of the current call sites do this; such a
 * function should be pinned with `sliceBetween` instead.
 */
export function extractFunctionSource(src: string, signature: string): string {
  const sigIdx = requireIndex(src, signature, "function signature");

  // Phase 1: from the signature, find the body's opening brace. Skip braces
  // that live inside the parameter parens or a generic return type.
  let cursor = sigIdx;
  let parenDepth = 0;
  let angleDepth = 0;
  let sawParams = false;
  let bodyStart = -1;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (; cursor < src.length; cursor++) {
    const ch = src[cursor] ?? "";
    const next = src[cursor + 1] ?? "";
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        cursor++;
      }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; cursor++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; cursor++; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }

    if (ch === "(") { parenDepth++; sawParams = true; continue; }
    if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (parenDepth > 0) continue; // inside the parameter list — ignore everything

    if (ch === "<") { angleDepth++; continue; }
    if (ch === ">") { angleDepth = Math.max(0, angleDepth - 1); continue; }
    if (angleDepth > 0) continue; // inside a generic return type — ignore braces

    if (ch === "{") {
      // The body brace: the first `{` at paren/angle depth 0 once the
      // parameter list has been seen and closed.
      if (sawParams) { bodyStart = cursor; break; }
    }
  }

  if (bodyStart < 0) {
    throw new Error(
      `drift-test-helpers.extractFunctionSource: could not find a body brace for ${JSON.stringify(signature)}`,
    );
  }

  // Phase 2: balanced-match the body braces (string/comment aware).
  let depth = 0;
  quote = null;
  escaped = false;
  lineComment = false;
  blockComment = false;
  for (cursor = bodyStart; cursor < src.length; cursor++) {
    const ch = src[cursor] ?? "";
    const next = src[cursor + 1] ?? "";
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; cursor++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; cursor++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; cursor++; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(sigIdx, cursor + 1);
    }
  }

  throw new Error(
    `drift-test-helpers.extractFunctionSource: unbalanced braces for ${JSON.stringify(signature)}`,
  );
}
