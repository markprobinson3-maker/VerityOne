/**
 * Local Project Inference — infer tenant project from local workspace context.
 *
 * Inference belongs to the LOCAL VO node, not the public layer.
 * Raw workspace data never leaves the local node by default.
 *
 * Cascade order:
 *   1. Explicit override (caller specifies project_addr)
 *   2. Exact local mapping (persisted addr for this workspace)
 *   3. High-confidence name/slug match against tenant project roots
 *   4. Weak heuristic suggestion
 *   5. No inference
 */

import type { Sql } from "postgres";
import fs from "node:fs";
import path from "node:path";

// ── Types ──

export interface InferenceInput {
  /** Explicit project addr override — skips all inference */
  explicit_project_addr?: string;
  /** Current working directory */
  cwd?: string;
  /** Workspace or directory name */
  workspace_name?: string;
  /** Git remote URL or slug (e.g., "my-app" or "github.com/user/my-app") */
  repo_slug?: string;
  /** Optional task goal for context */
  goal?: string;
}

export interface InferredProject {
  addr: string;
  label: string;
  confidence: "high" | "medium" | "low";
  source: string;
  note: string;
}

export interface InferenceResult {
  inferred: InferredProject | null;
  candidates: Array<{ addr: string; label: string; score: number; source: string }>;
}

// ── Normalization ──

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(name: string): string {
  return normalize(name).replace(/\s+/g, "");
}

function expandKnownAbbreviations(name: string): string[] {
  const norm = normalize(name);
  const expanded = new Set([norm]);
  if (/\bvo\b/.test(norm)) {
    expanded.add(norm.replace(/\bvo\b/g, "verity one"));
  }
  if (/\bverity one\b/.test(norm)) {
    expanded.add(norm.replace(/\bverity one\b/g, "vo"));
  }
  return [...expanded];
}

function addPackageNames(cwd: string, names: string[]) {
  try {
    const packageJsonPath = path.join(cwd, "package.json");
    if (!fs.existsSync(packageJsonPath)) return;
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.name === "string") names.push(normalize(parsed.name));
    if (typeof parsed.description === "string") names.push(normalize(parsed.description));
  } catch {
    // Local workspace metadata is advisory only.
  }
}

function addGitRemoteNames(cwd: string, names: string[]) {
  try {
    const gitConfigPath = path.join(cwd, ".git", "config");
    if (!fs.existsSync(gitConfigPath)) return;
    const config = fs.readFileSync(gitConfigPath, "utf8");
    const urls = [...config.matchAll(/url\s*=\s*(.+)/g)].map((m) => m[1].trim());
    for (const url of urls) {
      const slug = url.replace(/\.git$/, "").split(/[/:]/).pop();
      if (slug) names.push(normalize(slug));
    }
  } catch {
    // Local git metadata is advisory only.
  }
}

function extractNames(input: InferenceInput): string[] {
  const names: string[] = [];

  if (input.workspace_name) {
    names.push(normalize(input.workspace_name));
  }

  if (input.cwd) {
    const basename = path.basename(input.cwd);
    if (basename && basename !== "/" && basename !== ".") {
      names.push(normalize(basename));
    }
    // Also try parent if cwd looks like a nested workspace
    const parent = path.basename(path.dirname(input.cwd));
    if (parent && parent !== "/" && parent !== "." && parent !== "Projects" && parent !== "Users") {
      names.push(normalize(parent));
    }
    addPackageNames(input.cwd, names);
    addGitRemoteNames(input.cwd, names);
  }

  if (input.repo_slug) {
    // Extract repo name from URL or slug
    const slug = input.repo_slug
      .replace(/\.git$/, "")
      .split("/")
      .pop() || "";
    if (slug) names.push(normalize(slug));
  }

  return [...new Set(names)].filter(Boolean);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

function projectAliases(project: any): string[] {
  const substance = project?.substance && typeof project.substance === "object"
    ? project.substance as Record<string, unknown>
    : {};
  const values = [
    project.label,
    substance.name,
    ...stringArray(substance.aliases),
    ...stringArray(substance.project_aliases),
    ...stringArray(substance.repo_slugs),
    ...stringArray(substance.workspace_names),
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  return [...new Set(values.flatMap((value) => expandKnownAbbreviations(value)))];
}

// ── Core inference ──

export async function inferProject(
  sql: Sql,
  tenantId: string,
  spaceId: string,
  input: InferenceInput,
): Promise<InferenceResult> {
  // 1. Explicit override
  if (input.explicit_project_addr) {
    const [project] = await sql`
      SELECT addr, label FROM nodes
      WHERE addr = ${input.explicit_project_addr}
        AND space_id = ${spaceId}
        AND pyramid_id = 'PROJECTS'
        AND depth = 1
        AND visibility <> 'deleted'
        AND dormant_at IS NULL
    `;
    if (project) {
      return {
        inferred: {
          addr: project.addr,
          label: project.label,
          confidence: "high",
          source: "explicit_override",
          note: "Project specified explicitly by caller.",
        },
        candidates: [{ addr: project.addr, label: project.label, score: 1.0, source: "explicit" }],
      };
    }
    return {
      inferred: null,
      candidates: [],
    };
  }

  // 2-4. Name-based matching against tenant project roots
  const localNames = extractNames(input);
  if (localNames.length === 0) {
    return { inferred: null, candidates: [] };
  }

  // Fetch all active project roots for this tenant
  const projectRoots = await sql`
    SELECT addr, label, substance FROM nodes
    WHERE space_id = ${spaceId}
      AND pyramid_id = 'PROJECTS'
      AND depth = 1
      AND visibility <> 'deleted'
      AND dormant_at IS NULL
    ORDER BY addr
  `;

  if (projectRoots.length === 0) {
    return { inferred: null, candidates: [] };
  }

  // Score each project against local names
  const scored: Array<{ addr: string; label: string; score: number; source: string }> = [];

  for (const project of projectRoots) {
    const candidateNames = projectAliases(project);
    let bestScore = 0;
    let bestSource = "";

    for (const name of localNames) {
      for (const projectNorm of candidateNames) {
        // Exact match
        if (projectNorm === name) {
          bestScore = Math.max(bestScore, 1.0);
          bestSource = "exact_name_match";
          continue;
        }

        if (compact(projectNorm) === compact(name)) {
          if (0.98 > bestScore) {
            bestScore = 0.98;
            bestSource = "exact_slug_alias_match";
          }
          continue;
        }

        // Contained match (project name in local name or vice versa)
        if (projectNorm.includes(name) || name.includes(projectNorm)) {
          const overlapRatio = Math.min(projectNorm.length, name.length) / Math.max(projectNorm.length, name.length);
          const containScore = projectNorm.startsWith(`${name} `) && name.length >= 6
            ? 0.9
            : 0.6 + overlapRatio * 0.3;
          if (containScore > bestScore) {
            bestScore = containScore;
            bestSource = "contained_name_match";
          }
          continue;
        }

        // Word overlap
        const projectWords = new Set(projectNorm.split(/\s+/));
        const nameWords = name.split(/\s+/);
        const overlap = nameWords.filter((w) => projectWords.has(w)).length;
        if (overlap > 0 && nameWords.length > 0) {
          const wordScore = 0.3 + (overlap / Math.max(projectWords.size, nameWords.length)) * 0.4;
          if (wordScore > bestScore) {
            bestScore = wordScore;
            bestSource = "word_overlap";
          }
        }
      }
    }

    if (bestScore > 0.2) {
      scored.push({ addr: project.addr, label: project.label, score: parseFloat(bestScore.toFixed(3)), source: bestSource });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { inferred: null, candidates: [] };
  }

  const top = scored[0];
  const second = scored[1];
  const ambiguousHighMatch = !!second &&
    top.score >= 0.85 &&
    top.score < 0.98 &&
    Math.abs(top.score - second.score) < 0.03;
  const confidence: InferredProject["confidence"] =
    ambiguousHighMatch ? "medium" :
    top.score >= 0.85 ? "high" :
    top.score >= 0.55 ? "medium" :
    "low";

  const sourceLabel =
    top.source === "exact_name_match" ? "cwd+name_match" :
    top.source === "exact_slug_alias_match" ? "cwd+repo_alias_match" :
    top.source === "contained_name_match" ? "cwd+partial_match" :
    "heuristic";

  const note =
    confidence === "high" ? `Matched local workspace to tenant project "${top.label}".` :
    ambiguousHighMatch ? `Multiple tenant projects matched this workspace similarly. Verify "${top.label}" or pass explicit_project_addr.` :
    confidence === "medium" ? `Partial match to "${top.label}". Verify before relying on project-scoped memory.` :
    `Weak match to "${top.label}". Using tenant-wide memory instead.`;

  return {
    inferred: confidence !== "low" ? {
      addr: top.addr,
      label: top.label,
      confidence,
      source: sourceLabel,
      note,
    } : null,
    candidates: scored.slice(0, 5),
  };
}
