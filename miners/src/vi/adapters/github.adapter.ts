import type { ViAdapter } from "./types";
import { extractGitHubFile, extractGitHubIssueOrPr, extractGitHubRepositoryScan, parseGitHubTarget } from "../../lib/github-repo-extract";

export const adapter: ViAdapter = {
  name: "github",
  source_type: "github",
  description: "GitHub repository and thread extractor with structured repository scans",
  default_schedule: "0 */12 * * *",
  webhook_enabled: true,
  auth: { type: "bearer", key_env: "GITHUB_TOKEN", required: false },

  async extract(input) {
    const rawSource = input.source || input.config?.repo || "";
    const mode = input.config?.mode || "repo";

    if (mode === "trending") {
      const language = input.config?.language || "";
      const since = input.config?.since || "daily";
      const resp = await fetch(`https://github.com/trending/${language}?since=${since}`);
      const html = await resp.text();
      const repos = [...html.matchAll(/href="\/([^"]+)"[^>]*class="[^"]*Link[^"]*"/g)]
        .map((m) => m[1]).filter((r) => r.includes("/") && !r.includes("/trending"));
      const text = `GitHub Trending (${language || "all"}, ${since}):\n\n` + repos.slice(0, 25).map((r) => `- ${r}`).join("\n");
      return {
        title: `GitHub Trending ${language || "all"} (${since})`,
        source_id: `github:trending:${language || "all"}:${new Date().toISOString().slice(0, 10)}`,
        chunks: [{ content: text, chunk_index: 0, chunk_total: 1, metadata: { section: "trending" } }],
      };
    }

    if (mode === "search") {
      const query = input.config?.search_query || "AI agent framework";
      const resp = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=10`, {
        headers: { "User-Agent": "VerityIngest/1.0", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
      });
      const data: any = await resp.json();
      const text = data.items?.map((r: any) => `${r.stargazers_count} stars | ${r.full_name}\n${r.description || ""}\n${r.html_url}`).join("\n\n") || "";
      return {
        title: `GitHub Search: ${query}`,
        source_id: `github:search:${query}:${new Date().toISOString().slice(0, 10)}`,
        chunks: [{ content: text, chunk_index: 0, chunk_total: 1, metadata: { section: "search" } }],
      };
    }

    const target = parseGitHubTarget(rawSource);

    if (target.kind === "repo" || target.kind === "subtree") {
      const scan = await extractGitHubRepositoryScan(rawSource);
      return {
        title: scan.title,
        source_id: scan.sourceId,
        chunks: scan.chunks.map((chunk, index) => ({
          content: chunk.content,
          chunk_index: index,
          chunk_total: scan.chunks.length,
          metadata: {
            section: chunk.section,
            ...(chunk.metadata || {}),
          },
        })),
      };
    }

    if (target.kind === "file") {
      const file = await extractGitHubFile(target.owner, target.repo, target.ref, target.path);
      return {
        title: file.title,
        source_id: `github:${target.owner}/${target.repo}:${target.ref}:${target.path}`,
        chunks: [{ content: file.text, chunk_index: 0, chunk_total: 1, metadata: { section: "file", path: target.path } }],
      };
    }

    if (target.kind === "pr" || target.kind === "issue") {
      const thread = await extractGitHubIssueOrPr(target.owner, target.repo, target.kind, target.number);
      return {
        title: thread.title,
        source_id: `github:${target.owner}/${target.repo}:${target.kind}:${target.number}`,
        chunks: [{ content: thread.text, chunk_index: 0, chunk_total: 1, metadata: { section: target.kind, number: target.number } }],
      };
    }

    return { title: "GitHub", source_id: `github:${Date.now()}`, chunks: [] };
  },
};
