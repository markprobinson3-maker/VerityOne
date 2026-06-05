type GitHubHeaders = Record<string, string>;
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, resolve } from "path";

export type ParsedGitHubTarget =
  | { owner: string; repo: string; kind: "repo"; ref?: string; path?: string }
  | { owner: string; repo: string; kind: "subtree"; ref: string; path: string }
  | { owner: string; repo: string; kind: "file"; ref: string; path: string }
  | { owner: string; repo: string; kind: "pr"; number: number }
  | { owner: string; repo: string; kind: "issue"; number: number };

type RepoInfo = {
  full_name: string;
  description: string | null;
  default_branch: string;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics?: string[];
  language?: string | null;
};

type TreeEntry = {
  path: string;
  type: "blob" | "tree";
  size?: number;
};

type RepositoryScanChunk = {
  title: string;
  content: string;
  section: string;
  path?: string;
  metadata?: Record<string, any>;
};

type RepositoryScanResult = {
  title: string;
  sourceId: string;
  textParts: string[];
  chunks: RepositoryScanChunk[];
  metadata: Record<string, any>;
};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const API_HEADERS: GitHubHeaders = {
  "User-Agent": "VerityIngest/1.0",
  "Accept": "application/vnd.github+json",
};
if (GITHUB_TOKEN) API_HEADERS.Authorization = `Bearer ${GITHUB_TOKEN}`;

const ROOT_PRIORITY_FILES = new Set([
  "README.md", "README", "CHANGELOG.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "DESIGN.md",
  "SECURITY.md", "package.json", "bunfig.toml", "tsconfig.json", "pyproject.toml", "requirements.txt",
  "Cargo.toml", "go.mod", "go.sum", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Makefile", ".github/workflows/ci.yml", ".github/workflows/test.yml",
]);

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml",
  ".toml", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".sh", ".zsh", ".sql", ".proto",
  ".graphql", ".gql", ".html", ".css", ".scss", ".env.example",
]);

const SKIP_SEGMENTS = new Set([
  "node_modules", "dist", "build", "coverage", "vendor", ".git", ".next", "target", "__pycache__", ".venv",
]);

async function ghFetchJson(url: string, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: API_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isGitHubApiLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /GitHub API 403|GitHub API 429|rate limit/i.test(message);
}

async function ghFetchContent(owner: string, repo: string, path: string, ref: string, timeoutMs = 20_000): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const payload = await ghFetchJson(url, timeoutMs);
    if (payload?.type !== "file" || !payload.content) {
      throw new Error(`GitHub content unavailable for ${owner}/${repo}/${path}`);
    }
    return Buffer.from(payload.content, "base64").toString("utf-8");
  } catch (error) {
    if (!isGitHubApiLimitError(error)) throw error;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rawUrl, {
        headers: { "User-Agent": "VerityIngest/1.0" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GitHub raw fetch ${res.status}: ${rawUrl}`);
      return res.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeRepoSpec(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GitHub repo spec: ${input}`);
  return { owner: parts[0], repo: parts[1] };
}

export function parseGitHubTarget(input: string): ParsedGitHubTarget {
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    const { owner, repo } = normalizeRepoSpec(input);
    return { owner, repo, kind: "repo" };
  }

  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GitHub URL: ${input}`);
  const owner = parts[0];
  const repo = parts[1];

  if (parts[2] === "pull" || parts[2] === "pulls") {
    return { owner, repo, kind: "pr", number: parseInt(parts[3] || "0", 10) };
  }
  if (parts[2] === "issues") {
    return { owner, repo, kind: "issue", number: parseInt(parts[3] || "0", 10) };
  }
  if (parts[2] === "blob") {
    return { owner, repo, kind: "file", ref: parts[3], path: parts.slice(4).join("/") };
  }
  if (parts[2] === "tree") {
    const ref = parts[3] || "HEAD";
    const path = parts.slice(4).join("/");
    return path ? { owner, repo, kind: "subtree", ref, path } : { owner, repo, kind: "repo", ref };
  }
  return { owner, repo, kind: "repo" };
}

function isTextCandidate(path: string, size = 0): boolean {
  if (!path || size > 120_000) return false;
  const segments = path.split("/");
  if (segments.some((segment) => SKIP_SEGMENTS.has(segment))) return false;
  const filename = segments[segments.length - 1];
  if (!filename) return false;
  if (filename.startsWith(".") && !filename.includes(".")) return false;
  if (/\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp4|mp3|ogg|wasm|lock)$/i.test(filename)) return false;
  if (ROOT_PRIORITY_FILES.has(path) || ROOT_PRIORITY_FILES.has(filename)) return true;
  const lower = filename.toLowerCase();
  for (const ext of TEXT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function fileScore(path: string, size = 0): number {
  const lower = path.toLowerCase();
  const depth = path.split("/").length;
  let score = 0;
  if (ROOT_PRIORITY_FILES.has(path) || ROOT_PRIORITY_FILES.has(path.split("/").pop() || "")) score += 1200;
  if (/^readme/i.test(path.split("/").pop() || "")) score += 1400;
  if (lower.startsWith("docs/") || lower.includes("/docs/")) score += 1000;
  if (lower.startsWith(".github/workflows/")) score += 820;
  if (/package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|makefile|bunfig\.toml|tsconfig\.json/i.test(lower)) score += 920;
  if (lower.startsWith("examples/") || lower.includes("/examples/")) score += 700;
  if (lower.startsWith("src/")) score += 520;
  if (/test|spec/.test(lower)) score -= 180;
  if (size > 50_000) score -= 120;
  score += Math.max(0, 10 - depth) * 14;
  return score;
}

export function selectRepositoryFilesForScan(entries: Array<{ path: string; size?: number }>, maxFiles = 18, maxBytes = 260_000): Array<{ path: string; size?: number }> {
  const ranked = entries
    .filter((entry) => isTextCandidate(entry.path, entry.size || 0))
    .sort((a, b) => fileScore(b.path, b.size || 0) - fileScore(a.path, a.size || 0) || (a.size || 0) - (b.size || 0));

  const selected: Array<{ path: string; size?: number }> = [];
  let bytes = 0;
  for (const entry of ranked) {
    const size = entry.size || 0;
    if (selected.some((item) => item.path === entry.path)) continue;
    if (selected.length >= maxFiles) break;
    if (bytes + size > maxBytes && selected.length >= 8) continue;
    selected.push(entry);
    bytes += size;
  }
  return selected;
}

function chunkLargeText(text: string, maxChars = 18_000): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + maxChars);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > cursor + maxChars * 0.6) end = boundary;
    }
    parts.push(text.slice(cursor, end).trim());
    cursor = end;
  }
  return parts.filter(Boolean);
}

function buildTreeInventoryChunks(fullName: string, tree: TreeEntry[], scopePath?: string): RepositoryScanChunk[] {
  const prefix = scopePath ? `${scopePath.replace(/\/+$/, "")}/` : "";
  const scoped = prefix ? tree.filter((entry) => entry.path.startsWith(prefix)) : tree;
  const lines = scoped
    .filter((entry) => entry.type === "blob")
    .map((entry) => `- ${entry.path}${entry.size ? ` (${entry.size} bytes)` : ""}`);
  if (!lines.length) return [];

  const joinedChunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > 18_000 && current) {
      joinedChunks.push(current.trim());
      current = line;
    } else {
      current += `${current ? "\n" : ""}${line}`;
    }
  }
  if (current) joinedChunks.push(current.trim());

  return joinedChunks.map((content, index) => ({
    title: `${fullName} file inventory ${index + 1}/${joinedChunks.length}`,
    section: "inventory",
    content: `# Repository file inventory\n\nRepository: ${fullName}${scopePath ? `\nScope: ${scopePath}` : ""}\n\n${content}`,
    metadata: { scope_path: scopePath || null, chunk_index: index },
  }));
}

async function fetchRepositoryOverview(owner: string, repo: string): Promise<{ repoInfo: RepoInfo; languages: Record<string, number> }> {
  const [repoInfo, languages] = await Promise.all([
    ghFetchJson(`https://api.github.com/repos/${owner}/${repo}`),
    ghFetchJson(`https://api.github.com/repos/${owner}/${repo}/languages`).catch(() => ({})),
  ]);
  return { repoInfo, languages };
}

async function fetchRepositoryTree(owner: string, repo: string, ref: string): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const payload = await ghFetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, 25_000);
  return {
    tree: Array.isArray(payload.tree) ? payload.tree : [],
    truncated: !!payload.truncated,
  };
}

async function fetchRepositoryReadme(owner: string, repo: string, ref: string): Promise<{ path: string; content: string } | null> {
  try {
    const payload = await ghFetchJson(`https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(ref)}`, 20_000);
    if (!payload?.content || !payload?.path) return null;
    return {
      path: payload.path,
      content: Buffer.from(payload.content, "base64").toString("utf-8"),
    };
  } catch {
    return null;
  }
}

async function detectDefaultBranchPublic(owner: string, repo: string): Promise<string> {
  const proc = Bun.spawn(["git", "ls-remote", "--symref", `https://github.com/${owner}/${repo}.git`, "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return "main";
  const refLine = stdout.split("\n").find((line) => line.startsWith("ref: "));
  const match = refLine?.match(/refs\/heads\/([^\s]+)\s+HEAD/);
  return match?.[1] || "main";
}

async function fetchRepositoryHtmlMetadata(owner: string, repo: string): Promise<Partial<RepoInfo>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://github.com/${owner}/${repo}`, {
      headers: { "User-Agent": "VerityIngest/1.0" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return {};
    const html = await res.text();
    const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"]+)["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"]+)["']/i)?.[1]
      || null;
    return {
      full_name: `${owner}/${repo}`,
      description,
      default_branch: "main",
      homepage: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      language: null,
      topics: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function listLocalTree(rootDir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const relativePath = relative(rootDir, absolute).replace(/\\/g, "/");
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "tree" });
        walk(absolute);
      } else {
        entries.push({ path: relativePath, type: "blob", size: stat.size });
      }
    }
  };
  walk(rootDir);
  return entries;
}

async function extractRepositoryArchive(owner: string, repo: string, ref: string): Promise<{ rootDir: string; cleanup: () => void }> {
  const tempRoot = mkdtempSync(join(tmpdir(), "verity-gh-"));
  const archivePath = join(tempRoot, `${repo}-${ref}.tar.gz`);
  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${encodeURIComponent(ref)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(archiveUrl, {
      headers: { "User-Agent": "VerityIngest/1.0" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`GitHub archive download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    await Bun.write(archivePath, buf);
  } finally {
    clearTimeout(timeout);
  }

  const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", tempRoot], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`GitHub archive extract failed: ${stderr.slice(0, 240)}`);
  }

  const extractedDir = readdirSync(tempRoot)
    .map((name) => join(tempRoot, name))
    .find((absolute) => absolute !== archivePath && statSync(absolute).isDirectory());
  if (!extractedDir) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`GitHub archive extraction produced no directory for ${owner}/${repo}`);
  }

  return {
    rootDir: extractedDir,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function buildOverviewChunk(repoInfo: RepoInfo, languages: Record<string, number>, tree: TreeEntry[], truncated: boolean, scopePath?: string): RepositoryScanChunk {
  const rootFiles = tree
    .filter((entry) => entry.type === "blob" && !entry.path.includes("/"))
    .slice(0, 30)
    .map((entry) => entry.path)
    .join(", ");
  const topDirs = tree
    .filter((entry) => entry.type === "tree" && !entry.path.includes("/"))
    .slice(0, 20)
    .map((entry) => entry.path)
    .join(", ");
  const languageSummary = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, bytes]) => `${name}: ${bytes}`)
    .join("\n");

  return {
    title: `${repoInfo.full_name} repository overview`,
    section: "overview",
    content: [
      `# Repository Overview: ${repoInfo.full_name}`,
      repoInfo.description ? `\n${repoInfo.description}` : "",
      `\nDefault branch: ${repoInfo.default_branch}`,
      `Stars: ${repoInfo.stargazers_count} · Forks: ${repoInfo.forks_count} · Open issues: ${repoInfo.open_issues_count}`,
      repoInfo.homepage ? `Homepage: ${repoInfo.homepage}` : "",
      repoInfo.topics?.length ? `Topics: ${repoInfo.topics.join(", ")}` : "",
      scopePath ? `Scope path: ${scopePath}` : "",
      languageSummary ? `\n## Languages\n${languageSummary}` : "",
      topDirs ? `\n## Top-level directories\n${topDirs}` : "",
      rootFiles ? `\n## Root files\n${rootFiles}` : "",
      `\n## Repository scan`,
      `Files enumerated: ${tree.filter((entry) => entry.type === "blob").length}${truncated ? " (truncated by GitHub tree API)" : ""}`,
    ].filter(Boolean).join("\n"),
    metadata: { truncated, scope_path: scopePath || null },
  };
}

function makeChunk(section: string, title: string, content: string, extra: Record<string, any> = {}): RepositoryScanChunk {
  return { section, title, content, metadata: extra, path: extra.path };
}

export async function extractGitHubRepositoryScan(input: string): Promise<RepositoryScanResult> {
  const target = parseGitHubTarget(input);
  if (target.kind !== "repo" && target.kind !== "subtree") {
    throw new Error("Repository scan only supports repo or subtree targets");
  }

  const { owner, repo } = target;
  const scopePath = target.kind === "subtree" ? target.path : target.path;

  const finalizeScan = async (
    repoInfo: RepoInfo,
    languages: Record<string, number>,
    ref: string,
    tree: TreeEntry[],
    truncated: boolean,
    readFile: (path: string) => Promise<string | null>,
    readmePath: string | null,
    readmeContent: string | null,
  ): Promise<RepositoryScanResult> => {
    const scopedEntries = scopePath
      ? tree.filter((entry) => entry.path === scopePath || entry.path.startsWith(`${scopePath.replace(/\/+$/, "")}/`))
      : tree;
    const blobEntries = scopedEntries.filter((entry) => entry.type === "blob");

    const chunks: RepositoryScanChunk[] = [];
    chunks.push(buildOverviewChunk(repoInfo, languages, scopedEntries, truncated, scopePath));
    chunks.push(...buildTreeInventoryChunks(repoInfo.full_name, tree, scopePath));

    const selectedFiles = selectRepositoryFilesForScan(blobEntries.map((entry) => ({ path: entry.path, size: entry.size })));
    if (readmePath && !selectedFiles.some((entry) => entry.path === readmePath)) {
      selectedFiles.unshift({ path: readmePath, size: readmeContent?.length });
    }

    const fetched = await Promise.all(selectedFiles.map(async (entry) => {
      try {
        const content = entry.path === readmePath && readmeContent != null
          ? readmeContent
          : await readFile(entry.path);
        return content ? { path: entry.path, content } : null;
      } catch {
        return null;
      }
    }));

    for (const file of fetched.filter(Boolean) as Array<{ path: string; content: string }>) {
      const parts = chunkLargeText(file.content, 18_000);
      for (let i = 0; i < parts.length; i++) {
        chunks.push(makeChunk(
          "file",
          `${repoInfo.full_name}:${file.path}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}`,
          `# File: ${file.path}\nRepository: ${repoInfo.full_name}\nBranch: ${ref}\n\n${parts[i]}`,
          { path: file.path, chunk_part: i + 1, chunk_total: parts.length },
        ));
      }
    }

    return {
      title: `GitHub: ${repoInfo.full_name}`,
      sourceId: `github:${repoInfo.full_name}:${ref}${scopePath ? `:${scopePath}` : ""}`,
      textParts: chunks.map((chunk) => chunk.content),
      chunks,
      metadata: {
        owner,
        repo,
        ref,
        scope_path: scopePath || null,
        selected_file_count: fetched.filter(Boolean).length,
        enumerated_file_count: blobEntries.length,
        truncated,
      },
    };
  };

  try {
    const { repoInfo, languages } = await fetchRepositoryOverview(owner, repo);
    const ref = target.kind === "subtree" ? target.ref : (target.ref || repoInfo.default_branch);
    const [{ tree, truncated }, readme] = await Promise.all([
      fetchRepositoryTree(owner, repo, ref),
      fetchRepositoryReadme(owner, repo, ref),
    ]);
    return finalizeScan(
      repoInfo,
      languages,
      ref,
      tree,
      truncated,
      async (path) => ghFetchContent(owner, repo, path, ref, 20_000),
      readme?.path || null,
      readme?.content || null,
    );
  } catch (error) {
    if (!isGitHubApiLimitError(error)) throw error;

    const htmlInfo = await fetchRepositoryHtmlMetadata(owner, repo);
    const ref = target.kind === "subtree" ? target.ref : (target.ref || await detectDefaultBranchPublic(owner, repo));
    const archive = await extractRepositoryArchive(owner, repo, ref);
    try {
      const repoRoot = resolve(archive.rootDir);
      const tree = listLocalTree(repoRoot);
      const readmeEntry = tree.find((entry) => entry.type === "blob" && /^readme/i.test(basename(entry.path)));
      const readmeContent = readmeEntry ? readFileSync(join(repoRoot, readmeEntry.path), "utf8") : null;
      const repoInfo: RepoInfo = {
        full_name: `${owner}/${repo}`,
        description: htmlInfo.description || null,
        default_branch: ref,
        homepage: htmlInfo.homepage || null,
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        topics: [],
        language: null,
      };

      return finalizeScan(
        repoInfo,
        {},
        ref,
        tree,
        false,
        async (path) => {
          const absolute = join(repoRoot, path);
          if (!resolve(absolute).startsWith(repoRoot)) return null;
          return readFileSync(absolute, "utf8");
        },
        readmeEntry?.path || null,
        readmeContent,
      );
    } finally {
      archive.cleanup();
    }
  }
}

export async function extractGitHubIssueOrPr(owner: string, repo: string, kind: "issue" | "pr", num: number): Promise<{ text: string; title: string }> {
  const isPR = kind === "pr";
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/${isPR ? "pulls" : "issues"}/${num}`;
  const item = await ghFetchJson(apiBase, 30_000);
  let text = `# ${item.title}\n\n${item.body || "(no description)"}\n\n`;
  const commentsUrl = isPR ? item.comments_url : `${apiBase}/comments`;
  try {
    const comments = await ghFetchJson(`${commentsUrl}?per_page=20`, 30_000);
    if (Array.isArray(comments)) {
      for (const c of comments) {
        text += `---\n**${c.user?.login || "unknown"}:**\n${c.body || ""}\n\n`;
      }
    }
  } catch {}
  return {
    text,
    title: `${isPR ? "PR" : "Issue"} #${num}: ${item.title}`,
  };
}

export async function extractGitHubFile(owner: string, repo: string, ref: string, path: string): Promise<{ text: string; title: string }> {
  const text = await ghFetchContent(owner, repo, path, ref);
  return { text, title: `${owner}/${repo}: ${path}` };
}
