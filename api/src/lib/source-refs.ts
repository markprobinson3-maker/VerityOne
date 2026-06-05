import { parseJsonField } from "./utils";

// VO-VAULT-NODE-SOURCE-LINK (plan Q1=A / Rung 2): the closed `kind` discriminator
// vocabulary for source_refs. Pinned by a drift guard. A new kind requires a
// ladder update — readers branch on this set and must never see an unknown kind.
export const SOURCE_REF_KINDS = ["url", "doc", "vault_file"] as const;
export type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];

export type SourceRef = {
  type: string;
  /** Closed discriminator (plan Q1=A). Optional on the wire for backward
   *  compatibility; legacy refs without it resolve via resolveSourceRefKind. */
  kind?: SourceRefKind;
  path?: string;
  url?: string;
  lines?: string;
  title?: string;
  // Vault-file pointer fields (kind === "vault_file"):
  /** sha256 of the on-disk dossier, for verify-on-open (64 lowercase hex). */
  sha256?: string;
  /** Opaque vault identifier when a tenant runs multiple vaults. */
  vault_id?: string;
  /** Preferred opener for the dashboard "Open in Obsidian"/"Open file" link. */
  opened_via?: "obsidian" | "system";
  /** Q4=A soft-tombstone lifecycle (Rung 6 sets "deleted"; default "active"). */
  status?: "active" | "deleted";
  /** ISO timestamp when a vault_file ref was soft-tombstoned (Rung 6). */
  deleted_at?: string;
};

/** The canonical shape of a vault-file source pointer. A SourceRef with this
 *  discriminator MUST carry path + sha256; the helpers enforce that. */
export interface VaultFileSourceRef extends SourceRef {
  kind: "vault_file";
  path: string;
  sha256: string;
}

export type SourceGroundingSummary = {
  refCount: number;
  originCount: number;
  corroborated: boolean;
  origins: string[];
};

type DeriveSourceRefsInput = {
  existing?: unknown;
  sourceContext?: unknown;
  sourceSnapshot?: unknown;
  provenanceSources?: unknown;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeLines(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .map((entry) => asTrimmedString(entry) ?? (typeof entry === "number" ? String(entry) : null))
      .filter((entry): entry is string => !!entry);
    return cleaned.length ? cleaned.join(",") : undefined;
  }
  return undefined;
}

function inferRefType(path: string | null, url: string | null, explicitType: string | null): string {
  if (explicitType) return explicitType;
  if (url) return "url";
  if (path?.endsWith(".md")) return "md";
  if (path?.endsWith(".ts")) return "ts";
  if (path?.endsWith(".sql")) return "sql";
  if (path?.endsWith(".json")) return "json";
  if (path) return "file";
  return "source";
}

function normalizeSourceRef(value: unknown): SourceRef | null {
  const parsed = parseJsonField<any>(value) ?? value;

  if (typeof parsed === "string") {
    const normalized = asTrimmedString(parsed);
    if (!normalized) return null;
    if (/^https?:\/\//i.test(normalized)) {
      return { type: "url", url: normalized };
    }
    return { type: inferRefType(normalized, null, null), path: normalized };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const ref = parsed as Record<string, unknown>;
  const path = asTrimmedString(ref.path)
    || asTrimmedString(ref.file)
    || asTrimmedString(ref.file_path)
    || asTrimmedString(ref.source_path);
  const url = asTrimmedString(ref.url)
    || asTrimmedString(ref.href)
    || asTrimmedString(ref.source_url);

  if (!path && !url) return null;

  const normalized: SourceRef = {
    type: inferRefType(path, url, asTrimmedString(ref.type)),
  };
  if (path) normalized.path = path;
  if (url) normalized.url = url;
  const lines = normalizeLines(ref.lines ?? ref.line ?? ref.loc);
  if (lines) normalized.lines = lines;
  const title = asTrimmedString(ref.title) || asTrimmedString(ref.label);
  if (title) normalized.title = title;
  // Vault-file discriminator + fields (plan Q1=A). Preserve only valid values.
  const rawKind = asTrimmedString(ref.kind);
  if (rawKind && (SOURCE_REF_KINDS as readonly string[]).includes(rawKind)) {
    normalized.kind = rawKind as SourceRefKind;
  }
  const sha256 = asTrimmedString(ref.sha256);
  if (sha256 && /^[0-9a-f]{64}$/.test(sha256)) normalized.sha256 = sha256;
  const vaultId = asTrimmedString(ref.vault_id);
  if (vaultId) normalized.vault_id = vaultId;
  const openedVia = asTrimmedString(ref.opened_via);
  if (openedVia === "obsidian" || openedVia === "system") normalized.opened_via = openedVia;
  const status = asTrimmedString(ref.status);
  if (status === "active" || status === "deleted") normalized.status = status as "active" | "deleted";
  const deletedAt = asTrimmedString(ref.deleted_at);
  if (deletedAt) normalized.deleted_at = deletedAt;
  return normalized;
}

function flattenSourceRefCandidates(value: unknown): SourceRef[] {
  const parsed = parseJsonField<any>(value) ?? value;
  if (parsed == null) return [];
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => flattenSourceRefCandidates(entry));
  }
  if (typeof parsed === "object" && parsed !== null) {
    const ref = parsed as Record<string, unknown>;
    const nested = [
      ...(Array.isArray(ref.source_refs) ? flattenSourceRefCandidates(ref.source_refs) : []),
      ...(Array.isArray(ref.references) ? flattenSourceRefCandidates(ref.references) : []),
      ...(Array.isArray(ref.files) ? flattenSourceRefCandidates(ref.files) : []),
    ];
    const normalized = normalizeSourceRef(ref);
    return normalized ? [normalized, ...nested] : nested;
  }
  const normalized = normalizeSourceRef(parsed);
  return normalized ? [normalized] : [];
}

export function dedupeSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const deduped: SourceRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.kind || ref.type || "",
      ref.path || "",
      ref.url || "",
      ref.lines || "",
      ref.title || "",
      ref.sha256 || "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

export function deriveSourceRefs(input: DeriveSourceRefsInput): SourceRef[] {
  return dedupeSourceRefs([
    ...flattenSourceRefCandidates(input.existing),
    ...flattenSourceRefCandidates(input.sourceContext),
    ...flattenSourceRefCandidates(input.sourceSnapshot),
    ...flattenSourceRefCandidates(input.provenanceSources),
  ]);
}

// ── Vault-file source-ref helpers (plan Q1=A / Rung 2) ──────────────

/** Resolve a ref's closed kind: the explicit discriminator if valid, else
 *  derived from shape. Every ref resolves to a member of SOURCE_REF_KINDS, so
 *  readers ( /context, /run, /search, dashboard ) never face an absent/unknown
 *  kind. Derivation is more precise than a blanket "url": a file path resolves
 *  to "doc", a vault-file shape to "vault_file". */
export function resolveSourceRefKind(ref: SourceRef): SourceRefKind {
  if (ref.kind && (SOURCE_REF_KINDS as readonly string[]).includes(ref.kind)) return ref.kind;
  if (ref.type === "vault_file" && ref.path && /^[0-9a-f]{64}$/.test(ref.sha256 || "")) return "vault_file";
  if (ref.url) return "url";
  if (ref.path) return "doc";
  return "url";
}

export function isVaultFileSourceRef(ref: SourceRef): ref is VaultFileSourceRef {
  return (
    resolveSourceRefKind(ref) === "vault_file"
    && typeof ref.path === "string"
    && ref.path.length > 0
    && /^[0-9a-f]{64}$/.test(ref.sha256 || "")
  );
}

/** Stamp the resolved kind onto every ref (idempotent). Read routes call this
 *  so surfaced source_refs always carry a closed `kind` field. */
export function withResolvedKinds(refs: SourceRef[]): SourceRef[] {
  return refs.map((ref) => ({ ...ref, kind: resolveSourceRefKind(ref) }));
}

export interface VaultFileSourceRefInput {
  path: string;
  sha256: string;
  vault_id?: string;
  opened_via?: "obsidian" | "system";
  title?: string;
}

function buildVaultFileSourceRef(input: VaultFileSourceRefInput): VaultFileSourceRef {
  const path = asTrimmedString(input.path);
  const sha256 = asTrimmedString(input.sha256);
  if (!path) throw new Error("vault_file source ref requires a path");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("vault_file source ref requires a 64-hex sha256");
  }
  const ref: VaultFileSourceRef = {
    type: "vault_file",
    kind: "vault_file",
    path,
    sha256,
    status: "active",
    opened_via: input.opened_via ?? "obsidian",
  };
  if (input.vault_id) ref.vault_id = input.vault_id;
  const title = asTrimmedString(input.title);
  if (title) ref.title = title;
  return ref;
}

/** Add (or supersede by path) a vault_file source ref. Returns a NEW array;
 *  a re-add for the same path replaces the prior ref (latest sha256 wins). */
export function addVaultFileSourceRef(refs: SourceRef[], input: VaultFileSourceRefInput): SourceRef[] {
  const ref = buildVaultFileSourceRef(input);
  const withoutSamePath = refs.filter(
    (r) => !(resolveSourceRefKind(r) === "vault_file" && r.path === ref.path),
  );
  return dedupeSourceRefs([...withoutSamePath, ref]);
}

export function findVaultFileRefs(refs: SourceRef[]): VaultFileSourceRef[] {
  return refs.filter(isVaultFileSourceRef);
}

/** Replace the vault_file ref whose sha256 matches oldSha256 with a fresh ref
 *  (e.g. after a dossier is rewritten). Appends if no match, so the result is
 *  guaranteed to contain the new ref. */
export function replaceVaultFileSourceRef(
  refs: SourceRef[],
  oldSha256: string,
  input: VaultFileSourceRefInput,
): SourceRef[] {
  const ref = buildVaultFileSourceRef(input);
  let replaced = false;
  const next = refs.map((r) => {
    if (!replaced && resolveSourceRefKind(r) === "vault_file" && r.sha256 === oldSha256) {
      replaced = true;
      return ref;
    }
    return r;
  });
  if (!replaced) next.push(ref);
  return dedupeSourceRefs(next);
}

/** Active (non-tombstoned) vault_file refs — the candidates the Rung-6
 *  tombstone pass checks on disk. `findVaultFileRefs` still returns ALL
 *  vault_file refs (active + tombstoned) for the Rung-3 read paths. */
export function findActiveVaultFileRefs(refs: SourceRef[]): VaultFileSourceRef[] {
  return findVaultFileRefs(refs).filter((ref) => ref.status !== "deleted");
}

/** Soft-tombstone (plan Q4=A / Rung 6) the FIRST active vault_file ref whose
 *  sha256 matches: flip status → "deleted" and stamp deleted_at, keeping the
 *  NODE and every other ref byte-for-byte. Keyed by sha256 (not path) so a
 *  node holding multiple vault_file refs only flips the one whose file is gone.
 *  Idempotent — an already-"deleted" ref is matched out, so a re-run never
 *  rewrites deleted_at. Returns a NEW array of the SAME length (the existing
 *  ref is flipped in place; no active+deleted duplicate is created), so the
 *  result must NOT be re-run through dedupeSourceRefs (whose key ignores
 *  status/deleted_at and would otherwise be a no-op here anyway). */
export function tombstoneVaultFileSourceRef(
  refs: SourceRef[],
  sha256: string,
  deletedAt: string = new Date().toISOString(),
): SourceRef[] {
  let flipped = false;
  return refs.map((ref) => {
    if (
      !flipped
      && resolveSourceRefKind(ref) === "vault_file"
      && ref.sha256 === sha256
      && ref.status !== "deleted"
    ) {
      flipped = true;
      return { ...ref, status: "deleted" as const, deleted_at: deletedAt };
    }
    return ref;
  });
}

export function summarizeSourceGrounding(value: unknown): SourceGroundingSummary {
  const refs = Array.isArray(value) ? dedupeSourceRefs(value as SourceRef[]) : deriveSourceRefs({ existing: value });
  const urlOrigins = Array.from(new Set(
    refs.map((ref) => ref.url || null).filter((origin): origin is string => !!origin),
  ));
  const pathOrigins = Array.from(new Set(
    refs.map((ref) => ref.path || null).filter((origin): origin is string => !!origin),
  ));
  const origins = urlOrigins.length > 0 ? urlOrigins : pathOrigins;
  return {
    refCount: refs.length,
    originCount: origins.length,
    corroborated: origins.length >= 2,
    origins,
  };
}
