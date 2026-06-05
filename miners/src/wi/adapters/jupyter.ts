/**
 * WI Adapter — Jupyter Notebook (.ipynb).
 * Parses .ipynb JSON. Markdown cells as-is, code in fences, skip outputs.
 * Supports GitHub URLs (raw conversion) and local files.
 */

import { existsSync } from "fs";

interface NotebookCell {
  cell_type: "markdown" | "code" | "raw";
  source: string | string[];
  metadata?: Record<string, any>;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: { display_name?: string; language?: string };
    language_info?: { name?: string };
  };
}

function getSource(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) return cell.source.join("");
  return cell.source;
}

function convertGitHubToRaw(url: string): string {
  // https://github.com/user/repo/blob/branch/path.ipynb
  // → https://raw.githubusercontent.com/user/repo/branch/path.ipynb
  const u = new URL(url);
  if (u.hostname === "github.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "blob") {
      const owner = parts[0];
      const repo = parts[1];
      const rest = parts.slice(3).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
  }
  return url;
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  let json: string;

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const rawUrl = convertGitHubToRaw(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "WorldIngestor/2.0" },
      });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      json = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } else {
    // Local file
    const resolved = url.startsWith("~") ? url.replace("~", process.env.HOME || "") : url;
    if (!existsSync(resolved)) throw new Error(`Notebook not found: ${resolved}`);
    json = await Bun.file(resolved).text();
  }

  let notebook: Notebook;
  try {
    notebook = JSON.parse(json);
  } catch {
    throw new Error("Invalid notebook JSON");
  }

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new Error("No cells found in notebook");
  }

  const language = notebook.metadata?.kernelspec?.language
    || notebook.metadata?.language_info?.name
    || "python";

  const parts: string[] = [];
  let title = url.split("/").pop()?.replace(".ipynb", "") || "Untitled Notebook";

  for (const cell of notebook.cells) {
    const source = getSource(cell).trim();
    if (!source) continue;

    if (cell.cell_type === "markdown") {
      parts.push(source);
      // Use first markdown heading as title
      if (title === url.split("/").pop()?.replace(".ipynb", "")) {
        const heading = source.match(/^#\s+(.+)/m);
        if (heading) title = heading[1].trim();
      }
    } else if (cell.cell_type === "code") {
      parts.push("```" + language + "\n" + source + "\n```");
    }
    // Skip raw cells and outputs
  }

  const text = parts.join("\n\n");
  if (text.length < 50) throw new Error("Notebook content too short (< 50 chars)");

  return { text, title };
}
