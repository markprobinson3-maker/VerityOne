/**
 * WI Adapter — Podcast transcription.
 * RSS feed → find <enclosure> MP3 URL → download to /tmp → Whisper transcription.
 * Supports: direct audio URLs (.mp3, .m4a, .wav, .ogg), RSS feeds.
 * 200MB max download, configurable timeout. Whisper `medium` model.
 * Cleanup temp files after extraction.
 */

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB

async function findAudioUrl(url: string): Promise<{ audioUrl: string; title: string }> {
  // Direct audio file
  if (/\.(mp3|m4a|wav|ogg)$/i.test(url)) {
    const title = url.split("/").pop()?.replace(/\.(mp3|m4a|wav|ogg)$/i, "") || "Podcast";
    return { audioUrl: url, title };
  }

  // RSS feed — parse XML to find enclosure
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "WorldIngestor/2.0" },
    });
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml = await res.text();

    // Find first <enclosure> with audio type
    const enclosureMatch = xml.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="audio[^"]*"[^>]*>/i)
      || xml.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/i);

    if (!enclosureMatch) throw new Error("No audio enclosure found in RSS feed");

    const audioUrl = enclosureMatch[1].replace(/&amp;/g, "&");

    // Try to get episode title
    const titleMatch = xml.match(/<item[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : "Podcast Episode";

    return { audioUrl, title };
  } finally {
    clearTimeout(timer);
  }
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  // Check Whisper is installed
  const whichProc = Bun.spawn(["which", "whisper"], { stdout: "pipe", stderr: "pipe" });
  const whichResult = (await new Response(whichProc.stdout).text()).trim();
  await whichProc.exited;
  if (!whichResult) {
    throw new Error("[SKIP] Whisper not installed — run 'pip install openai-whisper'");
  }

  // Find audio URL
  const { audioUrl, title } = await findAudioUrl(url);

  // Download audio to temp
  const tmpId = `wi-podcast-${Date.now()}`;
  const ext = audioUrl.match(/\.(mp3|m4a|wav|ogg)/i)?.[1] || "mp3";
  const tmpFile = `/tmp/${tmpId}.${ext}`;
  const tmpDir = `/tmp/${tmpId}`;

  try {
    // Download with size limit
    const controller = new AbortController();
    const downloadTimeout = setTimeout(() => controller.abort(), 600_000); // 10 min
    try {
      const res = await fetch(audioUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "WorldIngestor/2.0" },
      });
      if (!res.ok) throw new Error(`Audio download failed: ${res.status}`);

      const contentLength = parseInt(res.headers.get("content-length") || "0");
      if (contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Audio too large: ${(contentLength / 1024 / 1024).toFixed(0)}MB (max 200MB)`);
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Audio too large: ${(buf.byteLength / 1024 / 1024).toFixed(0)}MB (max 200MB)`);
      }

      await Bun.write(tmpFile, buf);
    } finally {
      clearTimeout(downloadTimeout);
    }

    // Run Whisper
    await Bun.spawn(["mkdir", "-p", tmpDir]).exited;

    const whisperProc = Bun.spawn([
      "whisper",
      "--model", "medium",
      "--language", "en",
      "--output_format", "txt",
      "--output_dir", tmpDir,
      tmpFile,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Timeout: generous because transcription is slow
    const whisperTimeout = setTimeout(() => whisperProc.kill(), 30 * 60 * 1000); // 30 min
    const exitCode = await whisperProc.exited;
    clearTimeout(whisperTimeout);

    if (exitCode !== 0) {
      const stderr = await new Response(whisperProc.stderr).text();
      if (stderr.includes("not English") || stderr.includes("language")) {
        throw new Error(`[SKIP] Non-English audio detected for ${url}`);
      }
      throw new Error(`Whisper failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }

    // Find output .txt file
    const findProc = Bun.spawn(["find", tmpDir, "-name", "*.txt"], { stdout: "pipe" });
    const txtFiles = (await new Response(findProc.stdout).text()).trim().split("\n").filter(Boolean);

    if (txtFiles.length === 0) throw new Error("Whisper produced no output");

    const text = await Bun.file(txtFiles[0]).text();

    if (text.trim().length < 50) throw new Error("Transcript too short (< 50 chars)");

    return { text: text.trim(), title };
  } finally {
    // Cleanup temp files
    Bun.spawn(["rm", "-rf", tmpFile, tmpDir]);
  }
}
