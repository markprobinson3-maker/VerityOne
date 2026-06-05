import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "audio",
  source_type: "audio",
  description: "Audio/video transcription via Whisper (local, free). Supports mp3, wav, m4a, mp4, mov, flac, aif",
  default_schedule: null,
  webhook_enabled: false,
  auth: { type: "none", required: false },

  async extract(input) {
    const filePath = input.source;
    const model = input.config?.model || "base";
    const language = input.config?.language || "en";

    const proc = Bun.spawn(["whisper", filePath, "--model", model, "--language", language, "--output_format", "txt", "--output_dir", "/tmp/vi-whisper"], {
      stdout: "pipe", stderr: "pipe",
    });
    await proc.exited;

    const txtPath = `/tmp/vi-whisper/${filePath.split("/").pop()?.replace(/\.[^.]+$/, ".txt")}`;
    const transcript = await Bun.file(txtPath).text();

    const words = transcript.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += 1000) {
      const chunk = words.slice(i, i + 1000).join(" ");
      chunks.push({
        content: chunk,
        chunk_index: chunks.length,
        chunk_total: Math.ceil(words.length / 1000),
        metadata: { model, language, word_offset: i },
      });
    }

    const filename = filePath.split("/").pop() || "audio";
    return {
      title: `Transcript: ${filename}`,
      source_id: `audio:${filename}:${Date.now()}`,
      chunks,
    };
  },
};
