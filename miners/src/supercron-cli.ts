import { CORE_PYRAMID_IDS, MINING_CROSS_MODE } from "@verity-one/graph-shape";

export const SUPERCRON_ONLY_PASS_NAMES = new Set(["trend_maintenance", "node_gc_candidates", "node_gc_apply", "project_association_doctor"]);

export interface SupercronCliOptions {
  dryRun: boolean;
  watch: boolean;
  stats: boolean;
  once: boolean;
  force: boolean;
  tiers: number[];
  pyramidOverride: string | null;
  onlyPass: string | null;
  inspectReceiptId: string | null;
}

export type SupercronCliParseResult =
  | { mode: "help" }
  | { mode: "error"; error: string }
  | { mode: "run"; options: SupercronCliOptions };

const BOOLEAN_FLAGS = new Set(["--dry-run", "--watch", "--stats", "--once", "--force"]);
const VALUE_FLAGS = new Set(["--tier", "--pyramid", "--only", "--pass", "--inspect-receipt"]);
const KNOWN_PYRAMIDS = new Set<string>([...CORE_PYRAMID_IDS, MINING_CROSS_MODE]);

type SingleValueResult =
  | { kind: "value"; value: string | null }
  | { kind: "error"; message: string };

function isFlag(value: string | undefined): boolean {
  return Boolean(value && value.startsWith("-"));
}

function parseTierList(raw: string): number[] | string {
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return "--tier accepts comma-separated integers 1-4 with no empty parts";
  }

  if (parts.some((part) => !/^\d+$/.test(part))) {
    return "--tier accepts only comma-separated integers 1-4";
  }

  const tiers = parts.map((part) => Number(part));
  if (tiers.some((tier) => !Number.isInteger(tier) || tier < 1 || tier > 4)) {
    return "--tier accepts only comma-separated integers 1-4";
  }
  return tiers;
}

function parsePositiveBigIntId(raw: string, flag: string): string | null {
  return /^[1-9]\d*$/.test(raw) ? raw : `${flag} requires a positive integer receipt id`;
}

function singleValue(values: string[], flag: string): SingleValueResult {
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    return { kind: "error", message: `${flag} was provided with conflicting values: ${unique.join(", ")}` };
  }
  return { kind: "value", value: unique[0] || null };
}

export function parseSupercronCli(args: string[]): SupercronCliParseResult {
  let help = false;
  const options: SupercronCliOptions = {
    dryRun: false,
    watch: false,
    stats: false,
    once: false,
    force: false,
    tiers: [1, 2, 3, 4],
    pyramidOverride: null,
    onlyPass: null,
    inspectReceiptId: null,
  };

  const tierValues: string[] = [];
  const pyramidValues: string[] = [];
  const onlyValues: string[] = [];
  const inspectReceiptValues: string[] = [];

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--dry-run") options.dryRun = true;
      if (arg === "--watch") options.watch = true;
      if (arg === "--stats") options.stats = true;
      if (arg === "--once") options.once = true;
      if (arg === "--force") options.force = true;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = args[idx + 1];
      if (!value || isFlag(value)) {
        return { mode: "error", error: `${arg} requires a value` };
      }
      idx += 1;
      if (arg === "--tier") tierValues.push(value);
      if (arg === "--pyramid") pyramidValues.push(value);
      if (arg === "--only" || arg === "--pass") onlyValues.push(value);
      if (arg === "--inspect-receipt") inspectReceiptValues.push(value);
      continue;
    }

    if (arg.startsWith("-")) {
      return { mode: "error", error: `Unknown option: ${arg}` };
    }

    return { mode: "error", error: `Unexpected argument: ${arg}` };
  }

  if (options.once && options.watch) {
    return { mode: "error", error: "--once cannot be combined with --watch" };
  }
  if (options.watch && onlyValues.length > 0) {
    return { mode: "error", error: "--only/--pass cannot be combined with --watch; use --only <supported-pass> --once" };
  }

  const inspectReceipt = singleValue(inspectReceiptValues, "--inspect-receipt");
  if (inspectReceipt.kind === "error") return { mode: "error", error: inspectReceipt.message };
  if (inspectReceipt.value) {
    const parsedInspectId = parsePositiveBigIntId(inspectReceipt.value, "--inspect-receipt");
    if (parsedInspectId == null || parsedInspectId.startsWith("--inspect-receipt requires")) {
      return { mode: "error", error: parsedInspectId || "--inspect-receipt requires a positive integer receipt id" };
    }
    if (
      options.watch
      || options.stats
      || options.once
      || options.dryRun
      || options.force
      || onlyValues.length > 0
      || tierValues.length > 0
      || pyramidValues.length > 0
    ) {
      return { mode: "error", error: "--inspect-receipt is a standalone read-only mode" };
    }
    options.inspectReceiptId = parsedInspectId;
  }

  const tierRaw = singleValue(tierValues, "--tier");
  if (tierRaw.kind === "error") return { mode: "error", error: tierRaw.message };
  if (tierRaw.value) {
    const parsed = parseTierList(tierRaw.value);
    if (typeof parsed === "string") return { mode: "error", error: parsed };
    options.tiers = parsed;
  }

  const pyramid = singleValue(pyramidValues, "--pyramid");
  if (pyramid.kind === "error") return { mode: "error", error: pyramid.message };
  if (pyramid.value) {
    if (!KNOWN_PYRAMIDS.has(pyramid.value)) {
      return {
        mode: "error",
        error: `Unknown --pyramid "${pyramid.value}". Supported pyramids: ${[...KNOWN_PYRAMIDS].join(", ")}`,
      };
    }
    options.pyramidOverride = pyramid.value;
  }

  const onlyPass = singleValue(onlyValues, "--only/--pass");
  if (onlyPass.kind === "error") return { mode: "error", error: onlyPass.message };
  if (onlyPass.value) {
    if (!SUPERCRON_ONLY_PASS_NAMES.has(onlyPass.value)) {
      return {
        mode: "error",
        error: `Unknown --only pass "${onlyPass.value}". Supported passes: ${[...SUPERCRON_ONLY_PASS_NAMES].join(", ")}`,
      };
    }
    options.onlyPass = onlyPass.value;
  }

  if (help) return { mode: "help" };
  return { mode: "run", options };
}

export function formatSupercronUsage(): string {
  return [
    "Usage:",
    "  bun run miners/src/supercron.ts                         # full run",
    "  bun run miners/src/supercron.ts --dry-run               # all passes, no writes",
    "  bun run miners/src/supercron.ts --tier 1                # tier isolation",
    "  bun run miners/src/supercron.ts --tier 1,2              # multiple tiers",
    "  bun run miners/src/supercron.ts --pyramid FUNCTION      # override rotation",
    "  bun run miners/src/supercron.ts --watch                 # loop forever",
    "  bun run miners/src/supercron.ts --stats                 # read-only stats",
    "  bun run miners/src/supercron.ts --inspect-receipt 12345 # inspect node-GC receipt",
    "  bun run miners/src/supercron.ts --only trend_maintenance --once",
    "  bun run miners/src/supercron.ts --only node_gc_candidates --once",
    "  bun run miners/src/supercron.ts --only node_gc_apply --once",
    "  bun run miners/src/supercron.ts --only project_association_doctor --once",
    "  bun run miners/src/supercron.ts --help",
    "  bun run miners/src/supercron.ts -h",
    "",
    "Allowed flags:",
    "  --dry-run --watch --stats --once --force --help -h",
    "  --tier <1|2|3|4|comma-list>",
    "  --pyramid <known-pyramid|CROSS>",
    "  --inspect-receipt <positive-receipt-id>",
    `  --only ${[...SUPERCRON_ONLY_PASS_NAMES].join("|")}`,
    `  --pass ${[...SUPERCRON_ONLY_PASS_NAMES].join("|")}`,
    "",
    `Known pyramids: ${[...KNOWN_PYRAMIDS].join(", ")}`,
  ].join("\n");
}
