/**
 * Vault content-type zones (PR-V1).
 *
 * `/VerityOne` is a VO-controlled, content-type layout that is identical for
 * every tenant. A source materialized into the vault is routed to exactly one
 * zone folder by its content kind. The set is intentionally small and may grow
 * as VO learns new source kinds (the operator chose "Let VO decide + evolve it").
 *
 * This module is the single source of truth for the zone names + the routing
 * rule. It is pure (no IO) so it can be unit-tested and reused by the harvest
 * pipeline, the Drive worker, and the web-MCP-connector ingestion path (PR-V5).
 */

export const VAULT_ZONES = [
  "web", // captured web pages / YouTube transcripts (summaries of links)
  "documents", // uploaded docs: pdf, doc(x), ppt(x), xls(x), txt, epub, csv
  "journal", // day-journal attachments that are document-like
  "notes", // human-authored markdown notes
  "media", // images, audio, video (binary attachments)
  "dossiers", // VO-finalized dossiers (*.dossier.md)
  "inbox", // unclassified / pending-triage drop zone (default)
] as const;

export type VaultZone = (typeof VAULT_ZONES)[number];

export const DEFAULT_ZONE: VaultZone = "inbox";

/** A source to be placed into the vault. All fields optional; more signal = better routing. */
export interface SourceDescriptor {
  /** A web link or YouTube URL (the dominant phone-ingest case). */
  url?: string;
  /** Original filename, used for extension-based routing. */
  filename?: string;
  /** Content-type / MIME, if known. */
  mime?: string;
  /**
   * Explicit kind hint that overrides heuristics. One of the zone names, or a
   * pipeline kind: "dossier" | "capture" | "journal" | "note" | "web".
   */
  kind?: string;
}

const MEDIA_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "tiff",
  "mp3", "wav", "m4a", "aac", "ogg", "flac",
  "mp4", "mov", "webm", "mkv", "avi", "m4v",
]);
const DOCUMENT_EXT = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "rtf", "odt", "epub", "pages",
]);
const NOTE_EXT = new Set(["md", "markdown", "mdx"]);

function extOf(filename: string | undefined): string {
  if (!filename) return "";
  const base = filename.split("/").pop() || filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function zoneForExt(ext: string): VaultZone | null {
  if (!ext) return null;
  if (MEDIA_EXT.has(ext)) return "media";
  if (DOCUMENT_EXT.has(ext)) return "documents";
  if (NOTE_EXT.has(ext)) return "notes";
  return null;
}

function zoneForMime(mime: string | undefined): VaultZone | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/")) return "media";
  if (m === "text/markdown") return "notes";
  if (m === "application/pdf") return "documents";
  if (m.startsWith("application/vnd.openxmlformats") || m.startsWith("application/msword") || m.startsWith("application/vnd.ms-")) return "documents";
  if (m === "text/csv" || m === "application/rtf" || m === "application/epub+zip") return "documents";
  return null;
}

/**
 * Route a source to its vault zone. Resolution order (highest-confidence first):
 * explicit kind → URL (→ web) → dossier filename → MIME → file extension →
 * DEFAULT_ZONE (inbox).
 */
export function classifySourceToZone(src: SourceDescriptor): VaultZone {
  // 1. Explicit kind hint wins.
  if (src.kind) {
    const k = src.kind.toLowerCase();
    if ((VAULT_ZONES as readonly string[]).includes(k)) return k as VaultZone;
    if (k === "dossier") return "dossiers";
    if (k === "capture") return "web";
    if (k === "note") return "notes";
  }

  // 2. A URL is a web link / YouTube — captured as a web summary.
  if (src.url && /^https?:\/\//i.test(src.url.trim())) return "web";

  // 3. A finalized dossier by filename convention.
  const fn = src.filename || "";
  if (fn.endsWith(".dossier.md")) return "dossiers";

  // 4. MIME, then extension.
  return zoneForMime(src.mime) ?? zoneForExt(extOf(fn)) ?? DEFAULT_ZONE;
}

/** True for a syntactically valid zone name. */
export function isVaultZone(name: string): name is VaultZone {
  return (VAULT_ZONES as readonly string[]).includes(name);
}
