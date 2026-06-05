/**
 * WI Adapter — GitHub content extraction.
 * Routes: /repo → README, /blob/path → raw file, /pull/N or /issues/N → API.
 * 30s timeout for PRs/issues.
 */

import { extractGitHubFile, extractGitHubIssueOrPr, extractGitHubRepositoryScan, parseGitHubTarget } from "../../lib/github-repo-extract";

export async function extract(url: string): Promise<{ text: string; title: string; metadata?: Record<string, any>; textParts?: string[] }> {
  const parsed = parseGitHubTarget(url);
  const { owner, repo } = parsed;

  switch (parsed.kind) {
    case "repo":
    case "subtree": {
      const scan = await extractGitHubRepositoryScan(url);
      return {
        text: scan.textParts.join("\n\n==== REPOSITORY CHUNK ====\n\n"),
        title: scan.title,
        textParts: scan.textParts,
        metadata: scan.metadata,
      };
    }

    case "file":
      return extractGitHubFile(owner, repo, parsed.ref, parsed.path);

    case "pr":
      return extractGitHubIssueOrPr(owner, repo, "pr", parsed.number);

    case "issue":
      return extractGitHubIssueOrPr(owner, repo, "issue", parsed.number);
  }
}
