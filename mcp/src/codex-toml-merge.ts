/**
 * Codex MCP config TOML merge — shipped implementation of the
 * contract pinned in `docs/VO-MCP-CODEX-TOML-MERGE-DESIGN.md`.
 *
 * What this module does:
 *
 *   - Validates the input config parses as TOML (defense in depth).
 *   - Refuses duplicate `[mcp_servers.verity-one]` sections.
 *   - Merges the block from `buildCodexTomlBlock()` into the input
 *     with byte-level preservation of every line outside the
 *     `[mcp_servers.verity-one]` section's source range:
 *       - first-time install (no section) → append the block at EOF,
 *         ensuring a separating blank line;
 *       - `force` over an existing section → replace ONLY that
 *         section's source range;
 *       - non-force over an existing section → refuse (the runner
 *         surfaces this as `existing_section_no_force`; the operator
 *         must use `mcp_onboard_codex_force`).
 *   - Validates the produced output parses as TOML AND contains
 *     exactly one `[mcp_servers.verity-one]` section whose body
 *     matches the input block byte-for-byte.
 *
 * What this module does NOT do:
 *
 *   - Construct the TOML block itself. The block comes from
 *     `buildCodexTomlBlock()` in `mcp/src/install.ts`; this module
 *     treats it as an opaque byte sequence.
 *   - Touch the filesystem. The runner handles backup + write +
 *     rollback; merge is pure string → string.
 *   - Re-serialize unrelated sections. Comments, blank lines,
 *     original key order, and even idiosyncratic whitespace are
 *     preserved because we never round-trip the unrelated content
 *     through the parser.
 */

import { parse as parseToml } from "smol-toml";

/**
 * A fresh-install merge (`install`) appends the block at EOF.
 * A repair merge (`force`) replaces the existing section in place.
 */
export type MergeMode = "install" | "force";

export interface MergeOk {
  ok: true;
  /** Merged TOML output. Byte-identical to the input outside the
   *  `[mcp_servers.verity-one]` section's source range. */
  output: string;
  /** Byte range in `output` that contains the verity-one section
   *  after the merge. Useful for preview-level diff display + for
   *  post-write section-only byte verification. */
  section_range: { start: number; end: number };
  /** True when the input had no `[mcp_servers.verity-one]` section
   *  before the merge (i.e. this is a first-time section install,
   *  even if the input file itself was present and had other
   *  sections). */
  first_time_section: boolean;
}

export type MergeRefusalCode =
  | "invalid_input_toml"
  | "invalid_output_toml"
  | "duplicate_section"
  | "existing_section_no_force"
  | "no_section_for_force"
  | "ambiguous_target_header"
  | "block_header_missing"
  | "block_body_mismatch_after_merge";

export interface MergeRefusal {
  ok: false;
  reason: string;
  code: MergeRefusalCode;
}

export type MergeResult = MergeOk | MergeRefusal;

/**
 * Literal regex for `[mcp_servers.verity-one]` header lines.
 * Anchored per-line via the /m flag. Tolerates surrounding
 * whitespace on the header line AND a trailing line-comment
 * (TOML v1.0.0 allows `[mcp_servers.verity-one] # installed by
 * hand`). A narrower `$` anchor would classify the commented
 * shape as "no verity-one section" — non-force install would
 * APPEND a second section body (duplicate-define on parse) and
 * force-repair would refuse with `no_section_for_force`. Paired
 * fixtures in `codex-toml-merge.test.ts` (reviewer P2).
 */
const VERITY_ONE_HEADER_RE =
  /^\s*\[mcp_servers\.verity-one\]\s*(?:#.*)?$/gm;

/**
 * Any top-level table header line — either a single-bracket
 * `[table]` or an array-of-tables `[[table]]`. Tolerates a trailing
 * comment on the header line (TOML v1.0.0 allows `[profiles.
 * default] # comment` and `[[profiles]] # comment`) because we
 * need to detect those headers as section boundaries. Used to
 * find the end of the verity-one section (= start of the next
 * header OR EOF) — EXCEPT for descendant tables of
 * `[mcp_servers.verity-one]`, which the merge treats as part of
 * that section (see `isVerityOneDescendantHeader` below).
 *
 * Reviewer P2: a previous narrower regex
 * (`/^\s*\[[^\]]+\]\s*$/gm`) missed `[[...]]` array-of-tables AND
 * missed single-bracket headers with trailing comments — so a
 * force-merge against a config with `[mcp_servers.verity-one]`
 * followed by `[[profiles]]` OR `[profiles.default] # keep`
 * scanned past those valid sections to EOF, replaced everything
 * after verity-one, and silently destroyed the operator's
 * unrelated config. The broadened matcher below catches both
 * cases; paired fixtures live in `codex-toml-merge.test.ts`.
 */
const ANY_HEADER_RE = /^\s*(?:\[\[[^\]]+\]\]|\[[^\]]+\])\s*(?:#.*)?$/gm;

/**
 * True when the matched header line is a dotted child table of
 * `[mcp_servers.verity-one]` (e.g. `[mcp_servers.verity-one.env]`).
 * These are part of the verity-one section — a force merge that
 * stopped at a descendant header would leave dangling bytes that
 * double-define `env` / other keys against the new inline block.
 * Tolerates surrounding whitespace inside the brackets and a
 * trailing line-comment (TOML allows `[mcp_servers.verity-one.env]
 * # comment` even on child table headers). Array-of-tables form
 * (`[[mcp_servers.verity-one.<x>]]`) is NOT a legal child of a
 * table, but we still accept it here so the regex doesn't split
 * the section boundary for an operator who wrote something weird
 * — smol-toml's validate-after step would have caught an actual
 * semantic violation first.
 */
function isVerityOneDescendantHeader(headerLine: string): boolean {
  return /^\s*\[\[?\s*mcp_servers\.verity-one\.[^\]]+\]\]?\s*(?:#.*)?$/.test(
    headerLine,
  );
}

/**
 * Merge the `[mcp_servers.verity-one]` TOML block into `input`.
 *
 * Pure string → string. Validates before + after via `smol-toml`.
 * Does not touch the filesystem.
 */
export function mergeVerityOneSection(
  input: string,
  block: string,
  opts: { mode: MergeMode },
): MergeResult {
  // 1. The block we were handed MUST start with the verity-one
  //    header — otherwise we have no way to byte-verify the merge.
  //    buildCodexTomlBlock() always emits this header; a caller
  //    that slices it in half is a bug we surface early. Tolerate
  //    a trailing line-comment so the block-shape check matches
  //    `VERITY_ONE_HEADER_RE` above (a future edit that added a
  //    comment to the emitted block would otherwise trip this
  //    check, not the real header-presence failure).
  if (!/^\s*\[mcp_servers\.verity-one\]\s*(?:#.*)?$/m.test(block)) {
    return {
      ok: false,
      code: "block_header_missing",
      reason:
        "merge block does not start with a `[mcp_servers.verity-one]` header",
    };
  }

  // 2. Count verity-one sections. Duplicate refusal is universal
  //    (neither install nor force can proceed against an
  //    ambiguous config — the doctor catches this too, but the
  //    merger surfaces it at preview time via the same code path).
  //    This runs BEFORE the TOML parse-validate because smol-toml
  //    itself treats duplicate table headers as a parse error, and
  //    we want to surface the narrower `duplicate_section` code to
  //    the caller instead of a generic invalid_input_toml.
  const headers = [...input.matchAll(VERITY_ONE_HEADER_RE)];
  if (headers.length > 1) {
    return {
      ok: false,
      code: "duplicate_section",
      reason: `existing config contains ${headers.length} `
        + "`[mcp_servers.verity-one]` sections — refuse to merge "
        + "an ambiguous config; remove duplicates first",
    };
  }

  // 3. Validate the input parses as TOML. Skip the parse for
  //    whitespace-only input (first-time install against a file the
  //    operator just `touch`-ed is fine).
  let parsed: unknown = null;
  if (input.trim().length > 0) {
    try {
      parsed = parseToml(input);
    } catch (e) {
      return {
        ok: false,
        code: "invalid_input_toml",
        reason: `existing config does not parse as TOML: ${(e as Error).message}`,
      };
    }
  }

  // 3a. Ambiguous-target-header check (reviewer P2). The regex
  //     locator only recognizes the CANONICAL bare shape
  //     `[mcp_servers.verity-one]` (with optional trailing
  //     comment). TOML v1.0.0 accepts equivalent NON-canonical
  //     shapes that our locator does not match:
  //       - quoted key: `[mcp_servers."verity-one"]`
  //       - whitespace around dotted-key separators:
  //         `[ mcp_servers . verity-one ]`
  //       - mixed: `[mcp_servers  .  "verity-one"]`
  //     smol-toml parses all of those to the same structural
  //     `mcp_servers["verity-one"]` table — so we can detect
  //     the mismatch precisely: if the PARSED object has the
  //     table but our regex matched zero header lines, the
  //     operator's config uses a non-canonical shape. Refuse
  //     with a dedicated code + a fix-the-header error message.
  //     Silently appending a second block would produce an
  //     `invalid_output_toml` duplicate-definition failure; a
  //     force-repair would refuse with `no_section_for_force`
  //     — both are operator-confusing. The explicit refusal
  //     tells the operator exactly what to do.
  if (headers.length === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const mcpServers = (parsed as Record<string, unknown>)["mcp_servers"];
    if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
      const verityOne = (mcpServers as Record<string, unknown>)["verity-one"];
      if (verityOne !== undefined) {
        return {
          ok: false,
          code: "ambiguous_target_header",
          reason:
            "existing config contains an `[mcp_servers.verity-one]` "
            + "table via a non-canonical TOML header shape (e.g. "
            + "quoted-key `[mcp_servers.\"verity-one\"]`, or "
            + "whitespace around dotted-key separators like `[ "
            + "mcp_servers . verity-one ]`). The merger only "
            + "recognizes the canonical bare shape `[mcp_servers."
            + "verity-one]` (optionally with a trailing line-"
            + "comment) — reformat the section's header line to "
            + "that canonical shape (no quoting, no internal "
            + "whitespace) and retry. smol-toml's parser sees "
            + "all three shapes as equivalent, but the byte-"
            + "preserving merger needs a predictable textual "
            + "locator.",
        };
      }
    }
  }

  let output: string;
  let sectionStart: number;
  let sectionEnd: number;
  let firstTimeSection: boolean;

  if (headers.length === 0) {
    // No existing section.
    if (opts.mode === "force") {
      return {
        ok: false,
        code: "no_section_for_force",
        reason:
          "force-merge requires an existing `[mcp_servers.verity-one]`"
          + " section to replace; use `mcp_onboard_codex` (non-force)"
          + " for first-time install",
      };
    }
    // `install` + no existing section → append at EOF with a
    // separating newline if the input does not already end in one.
    // Byte-preserve everything we didn't write.
    firstTimeSection = true;
    const needsLeadingNewline = input.length > 0 && !input.endsWith("\n");
    const sep = needsLeadingNewline ? "\n" : "";
    // Blank line before the new section if the previous byte is a
    // non-blank line — this keeps the merged file readable. Skip
    // when the input is entirely empty / whitespace-only.
    const leadingBlank = input.trim().length > 0 && !input.endsWith("\n\n")
      ? "\n"
      : "";
    sectionStart = input.length + sep.length + leadingBlank.length;
    const blockTrailing = block.endsWith("\n") ? block : block + "\n";
    output = input + sep + leadingBlank + blockTrailing;
    sectionEnd = output.length;
  } else {
    // Exactly one existing section.
    if (opts.mode === "install") {
      return {
        ok: false,
        code: "existing_section_no_force",
        reason:
          "existing config already has a `[mcp_servers.verity-one]`"
          + " section; re-run with `mcp_onboard_codex_force` to"
          + " overwrite it (a backup will be taken first)",
      };
    }
    // `force` + one existing section → find its byte range, replace
    // with block, preserve everything outside.
    firstTimeSection = false;
    const header = headers[0];
    const rangeStart = header.index ?? 0;
    // Walk from header-end looking for the NEXT `[...]` header
    // that is NOT a DESCENDANT table of `[mcp_servers.verity-one]`.
    // Dotted TOML child tables like
    // `[mcp_servers.verity-one.env]` belong inside the verity-one
    // section and MUST be replaced along with it; a force merge
    // that left a dangling child table would produce invalid TOML
    // (our block's inline `env = {...}` plus the stale child
    // `[mcp_servers.verity-one.env]` would double-define `env`).
    const nextHeaderRe = new RegExp(ANY_HEADER_RE.source, "gm");
    nextHeaderRe.lastIndex = rangeStart + header[0].length;
    let nextHeader: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = nextHeaderRe.exec(input)) !== null) {
      if (!isVerityOneDescendantHeader(m[0])) {
        nextHeader = m;
        break;
      }
    }
    const rangeEnd = nextHeader ? nextHeader.index : input.length;

    // Normalize the block's trailing newline so the replaced range
    // ends at a clean line boundary (matches the original section's
    // end-of-line position).
    const blockTrailing = block.endsWith("\n") ? block : block + "\n";

    // Replace [rangeStart, rangeEnd) with blockTrailing. If the
    // next section exists, we want exactly one blank line between
    // the new block and that next header — preserve by tracking
    // the blank-line count in the input.
    const tail = input.slice(rangeEnd);
    // If the original section already had a blank line before the
    // next header (common), preserve that shape. blockTrailing
    // already ends in one \n; add a second one if the original
    // tail starts a new section immediately (no leading blank).
    const needsExtraBlank = nextHeader && !tail.startsWith("\n");
    const replacement = blockTrailing + (needsExtraBlank ? "\n" : "");
    output = input.slice(0, rangeStart) + replacement + tail;
    sectionStart = rangeStart;
    sectionEnd = rangeStart + replacement.length;
  }

  // 4. Validate the output parses as TOML (defense in depth).
  try {
    parseToml(output);
  } catch (e) {
    return {
      ok: false,
      code: "invalid_output_toml",
      reason: `merge produced non-parseable TOML: ${(e as Error).message}`,
    };
  }

  // 5. Narrow-validate: exactly one verity-one section in the
  //    output, and its byte range contains the block we wrote.
  const outHeaders = [...output.matchAll(VERITY_ONE_HEADER_RE)];
  if (outHeaders.length !== 1) {
    return {
      ok: false,
      code: "invalid_output_toml",
      reason:
        `merge produced ${outHeaders.length} verity-one sections;`
        + " expected exactly 1",
    };
  }
  const outSection = output.slice(sectionStart, sectionEnd);
  if (!outSection.includes(block.trimEnd())) {
    return {
      ok: false,
      code: "block_body_mismatch_after_merge",
      reason:
        "merge output does not contain the verbatim verity-one block",
    };
  }

  return {
    ok: true,
    output,
    section_range: { start: sectionStart, end: sectionEnd },
    first_time_section: firstTimeSection,
  };
}
