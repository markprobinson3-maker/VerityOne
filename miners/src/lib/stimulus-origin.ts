export interface StimulusOriginInput {
  sourceType?: string | null;
  sourceId?: string | null;
  sourceTitle?: string | null;
  url?: string | null;
  chunkMetadata?: Record<string, any> | null;
  content?: string | null;
  sourceExcerpt?: string | null;
}

export interface StimulusOrigin {
  originKey: string;
  originKind: string;
  originLabel: string;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function safeUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function extractUrlsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return matches.map((value) => value.replace(/[.,;:!?]+$/, ""));
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseRepo(sourceId: string | null | undefined): string | null {
  if (!sourceId) return null;
  const githubMatch = sourceId.match(/^github:([^:]+\/[^:]+)(?::|$)/i);
  if (githubMatch) return githubMatch[1].toLowerCase();
  const url = safeUrl(sourceId);
  if (!url) return null;
  if (!normalizeHost(url.hostname).includes("github.com")) return null;
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

function parseArxivId(input: StimulusOriginInput): string | null {
  const candidate = firstString(
    input.chunkMetadata?.arxiv_id,
    input.url,
    input.sourceId,
    input.content,
    input.sourceExcerpt,
  );
  if (!candidate) return null;
  const match = candidate.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i);
  return match?.[1]?.toLowerCase() || null;
}

function parseYouTubeVideoId(input: StimulusOriginInput): string | null {
  const url = safeUrl(firstString(input.url, input.sourceId));
  if (!url) return null;
  const host = normalizeHost(url.hostname);
  if (host === "youtu.be") return url.pathname.replace(/^\//, "") || null;
  if (!host.includes("youtube.com")) return null;
  return url.searchParams.get("v") || null;
}

function parseSubreddit(input: StimulusOriginInput): string | null {
  const direct = firstString(input.chunkMetadata?.subreddit);
  if (direct) return direct.replace(/^r\//i, "").toLowerCase();
  const sourceId = input.sourceId || "";
  const sourceMatch = sourceId.match(/^reddit:([^:]+):/i);
  if (sourceMatch) return sourceMatch[1].toLowerCase();
  const urlCandidates = [
    firstString(input.chunkMetadata?.permalink, input.url),
    ...extractUrlsFromText(input.content),
    ...extractUrlsFromText(input.sourceExcerpt),
  ];
  for (const raw of urlCandidates) {
    const url = safeUrl(raw);
    if (!url) continue;
    if (!normalizeHost(url.hostname).includes("reddit.com")) continue;
    const pathMatch = url.pathname.match(/\/r\/([^/]+)/i);
    if (pathMatch) return pathMatch[1].toLowerCase();
  }
  return null;
}

function parseHostOrigin(input: StimulusOriginInput): StimulusOrigin | null {
  const urlCandidates = [
    firstString(
      input.chunkMetadata?.url,
      input.chunkMetadata?.link,
      input.chunkMetadata?.canonical_url,
      input.url,
      input.sourceId,
    ),
    ...extractUrlsFromText(input.content),
    ...extractUrlsFromText(input.sourceExcerpt),
  ].filter(Boolean) as string[];

  for (const raw of urlCandidates) {
    const url = safeUrl(raw);
    if (!url) continue;
    if (url.protocol === "file:") {
      return {
        originKey: `file:${url.pathname}`,
        originKind: "file",
        originLabel: url.pathname,
      };
    }
    const host = normalizeHost(url.hostname);
    if (!host) continue;
    return {
      originKey: `host:${host}`,
      originKind: "host",
      originLabel: host,
    };
  }
  return null;
}

export function deriveStimulusOrigin(input: StimulusOriginInput): StimulusOrigin {
  const sourceType = (input.sourceType || "unknown").toLowerCase();

  if (sourceType === "github") {
    const repo = parseRepo(input.sourceId);
    if (repo) {
      return {
        originKey: `github:repo:${repo}`,
        originKind: "github_repo",
        originLabel: repo,
      };
    }
  }

  if (sourceType === "arxiv") {
    const arxivId = parseArxivId(input);
    if (arxivId) {
      return {
        originKey: `arxiv:${arxivId}`,
        originKind: "arxiv_paper",
        originLabel: arxivId,
      };
    }
  }

  if (sourceType === "youtube") {
    const videoId = parseYouTubeVideoId(input);
    if (videoId) {
      return {
        originKey: `youtube:video:${videoId}`,
        originKind: "youtube_video",
        originLabel: videoId,
      };
    }
  }

  if (sourceType === "reddit") {
    const hostOrigin = parseHostOrigin(input);
    if (hostOrigin && !["host:reddit.com", "host:old.reddit.com"].includes(hostOrigin.originKey)) {
      return hostOrigin;
    }
    const subreddit = parseSubreddit(input);
    if (subreddit) {
      return {
        originKey: `reddit:subreddit:${subreddit}`,
        originKind: "reddit_subreddit",
        originLabel: `r/${subreddit}`,
      };
    }
  }

  if (sourceType === "hn") {
    const hostOrigin = parseHostOrigin(input);
    if (hostOrigin && hostOrigin.originKey !== "host:news.ycombinator.com") {
      return hostOrigin;
    }
    return {
      originKey: "hn:news.ycombinator.com",
      originKind: "community",
      originLabel: "Hacker News",
    };
  }

  if (sourceType === "market_api") {
    const provider = firstString(input.chunkMetadata?.provider)
      || (input.sourceId || "").split(":")[1]
      || "provider";
    return {
      originKey: `market:${provider.toLowerCase()}`,
      originKind: "market_provider",
      originLabel: provider,
    };
  }

  const hostOrigin = parseHostOrigin(input);
  if (hostOrigin) return hostOrigin;

  if (sourceType === "audio" || sourceType === "pdf") {
    const sourceId = firstString(input.sourceId, input.url) || `${sourceType}:unknown`;
    return {
      originKey: sourceId.toLowerCase(),
      originKind: "file",
      originLabel: sourceId,
    };
  }

  return {
    originKey: `source_type:${sourceType}`,
    originKind: "source_type",
    originLabel: input.sourceTitle || sourceType,
  };
}
