/**
 * WI Adapter — YouTube subtitle extraction via yt-dlp.
 * Prefers human subs, falls back to auto-sub. 15s timeout.
 */

function parseVtt(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let prev = "";
  for (const line of lines) {
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && clean !== prev) {
      textLines.push(clean);
      prev = clean;
    }
  }
  return textLines.join(" ");
}

async function tryExtractSubs(url: string, tmpDir: string, autoSub: boolean): Promise<string | null> {
  const args = [
    "yt-dlp",
    autoSub ? "--write-auto-sub" : "--write-sub",
    "--sub-lang", "en",
    "--skip-download",
    "--output", `${tmpDir}/%(id)s`,
    url,
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  await proc.exited;
  clearTimeout(timer);

  // Find VTT files
  const findProc = Bun.spawn(["find", tmpDir, "-name", "*.vtt"], { stdout: "pipe" });
  const vttFiles = (await new Response(findProc.stdout).text()).trim().split("\n").filter(Boolean);

  if (vttFiles.length === 0) return null;

  const vttContent = await Bun.file(vttFiles[0]).text();
  return parseVtt(vttContent);
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const tmpDir = `/tmp/wi-yt-${Date.now()}`;
  await Bun.spawn(["mkdir", "-p", tmpDir]).exited;

  try {
    // Try human subs first
    let text = await tryExtractSubs(url, tmpDir, false);

    // Fallback to auto-subs
    if (!text || text.length < 50) {
      // Clean and retry
      await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
      text = await tryExtractSubs(url, tmpDir, true);
    }

    if (!text || text.length < 50) {
      throw new Error("No usable subtitles found for this video");
    }

    // Get title
    const titleProc = Bun.spawn(["yt-dlp", "--get-title", url], { stdout: "pipe", stderr: "pipe" });
    const titleTimer = setTimeout(() => titleProc.kill(), 10_000);
    const title = (await new Response(titleProc.stdout).text()).trim() || url;
    clearTimeout(titleTimer);

    return { text, title };
  } finally {
    Bun.spawn(["rm", "-rf", tmpDir]);
  }
}
