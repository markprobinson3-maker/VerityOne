import type { ViAdapter } from "./types";
import { parseVtt, chunkText } from "./helpers";

export const adapter: ViAdapter = {
  name: "youtube",
  source_type: "youtube",
  description: "YouTube transcript extraction via yt-dlp auto-subtitles",
  default_schedule: null,
  webhook_enabled: true,
  auth: { type: "none", required: false },

  async extract(input) {
    const url = input.source;
    const tmpDir = `/tmp/vi-yt-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir]).exited;

    const proc = Bun.spawn([
      "yt-dlp",
      "--write-auto-sub",
      "--sub-lang", "en",
      "--skip-download",
      "--output", `${tmpDir}/%(id)s`,
      url,
    ], { stdout: "pipe", stderr: "pipe" });

    await proc.exited;

    const { stdout } = Bun.spawn(["find", tmpDir, "-name", "*.vtt"], { stdout: "pipe" });
    const vttFiles = (await new Response(stdout).text()).trim().split("\n").filter(Boolean);

    if (vttFiles.length === 0) {
      throw new Error(`No subtitle files found for ${url}`);
    }

    const vttContent = await Bun.file(vttFiles[0]).text();
    const text = parseVtt(vttContent);

    const titleProc = Bun.spawn(["yt-dlp", "--get-title", url], { stdout: "pipe" });
    const title = (await new Response(titleProc.stdout).text()).trim() || url;

    Bun.spawn(["rm", "-rf", tmpDir]);

    if (text.length < 50) throw new Error("YouTube transcript too short (< 50 chars)");

    const chunks = chunkText(text);
    return {
      title,
      source_id: url,
      chunks: chunks.map((c, i) => ({ content: c, chunk_index: i, chunk_total: chunks.length })),
    };
  },
};
