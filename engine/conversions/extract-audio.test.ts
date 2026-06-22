import { describe, it, expect } from "vitest";
import { extractAudioDescriptor, buildExtractAudioArgs } from "./extract-audio";
import type { AudioCodec } from "./audio-settings";

// The per-format codec descriptors extract-audio passes to the shared builder.
const MP3: AudioCodec = { lossy: true, ffmpegArgs: ["-c:a", "libmp3lame"], vbrEncoder: "libmp3lame" };
const AAC: AudioCodec = { lossy: true, ffmpegArgs: ["-c:a", "aac"], vbrEncoder: "aac" };
const WAV: AudioCodec = { lossy: false, ffmpegArgs: ["-c:a", "pcm_s16le"] };

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The extract-audio pipeline requires the @ffmpeg/ffmpeg ST runtime, which:
//   1. spawns a Web Worker (new Worker(new URL("./worker.js", import.meta.url)))
//   2. loads the core via blob: URLs built with @ffmpeg/util's toBlobURL
//   3. uses fetch() of same-origin /ffmpeg-st/* assets + URL.createObjectURL
// None of Worker / blob: URL fetch / a served public/ exist in plain Node.
//
// TODO(test-env): wire up a browser test environment (e.g. vitest browser mode)
// that serves public/ and supports Worker + blob: URLs so the happy path can run
// in CI. Until then the happy path is skipped via it.skipIf. UNSUPPORTED_INPUT
// and CANCELLED both throw BEFORE any FFmpeg/Worker call, so they run for real.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

describe("buildExtractAudioArgs", () => {
  // The exact arg array the route shipped before the audio drawer existed, for
  // the default MP3 (libmp3lame) format: -vn strips video, -c:a sets the codec,
  // and bitrate "Auto" emits NO -b:a so the codec default is preserved.
  const DEFAULT_MP3_ARGS = [
    "-i", "input.mp4", "-vn", "-c:a", "libmp3lame", "output.mp3",
  ];

  it("default opts reproduce the original -vn -c:a <codec> args (no -b:a)", () => {
    expect(buildExtractAudioArgs("input.mp4", "output.mp3", MP3)).toEqual(
      DEFAULT_MP3_ARGS,
    );
    expect(buildExtractAudioArgs("input.mp4", "output.mp3", MP3, {})).toEqual(
      DEFAULT_MP3_ARGS,
    );
  });

  it("keeps -vn and the codec while emitting the chosen bitrate", () => {
    expect(
      buildExtractAudioArgs("input.mp4", "output.mp3", MP3, { bitrate: "128k" }),
    ).toEqual(["-i", "input.mp4", "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "output.mp3"]);
  });

  it("works for the WAV/PCM codec; bitrate stays a no-op even if set (lossless)", () => {
    // PCM is lossless — the builder never emits a bitrate flag for it.
    expect(buildExtractAudioArgs("input.mp4", "output.wav", WAV)).toEqual([
      "-i", "input.mp4", "-vn", "-c:a", "pcm_s16le", "output.wav",
    ]);
    expect(buildExtractAudioArgs("input.mp4", "output.wav", WAV, { bitrate: "320k" })).toEqual([
      "-i", "input.mp4", "-vn", "-c:a", "pcm_s16le", "output.wav",
    ]);
  });

  it("folds reverse + volume into ONE -filter:a chain after the codec", () => {
    expect(
      buildExtractAudioArgs("input.mp4", "output.m4a", AAC, { reverse: true, volume: 150 }),
    ).toEqual([
      "-i", "input.mp4", "-vn", "-c:a", "aac",
      "-filter:a", "areverse,volume=1.5", "output.m4a",
    ]);
  });

  it("emits -ar and -ac for non-Auto sample rate / channels", () => {
    expect(
      buildExtractAudioArgs("input.mp4", "output.mp3", MP3, {
        sampleRate: "44100",
        channels: "1",
      }),
    ).toEqual([
      "-i", "input.mp4", "-vn", "-c:a", "libmp3lame", "-ar", "44100", "-ac", "1", "output.mp3",
    ]);
  });

  it("emits trim (as leading atrim) and fade in ONE filter chain, alongside -vn and the codec", () => {
    expect(
      buildExtractAudioArgs("input.mp4", "output.mp3", MP3, {
        bitrate: "192k",
        trimStart: "0:10",
        fadeIn: 2,
      }),
    ).toEqual([
      "-i", "input.mp4", "-vn", "-c:a", "libmp3lame",
      "-filter:a", "atrim=start=10,asetpts=N/SR/TB,afade=t=in:st=0:d=2",
      "-b:a", "192k", "output.mp3",
    ]);
  });

  it("the descriptor's defaultOptions reproduce the original MP3 args (no-op preserved)", () => {
    expect(
      buildExtractAudioArgs(
        "input.mp4",
        "output.mp3",
        MP3,
        extractAudioDescriptor.defaultOptions,
      ),
    ).toEqual(DEFAULT_MP3_ARGS);
  });
});

describe("extractAudioDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(extractAudioDescriptor.id).toBe("extract-audio");
    expect(extractAudioDescriptor.fromLabel).toBe("MP4");
    expect(extractAudioDescriptor.toLabel).toBe("Audio");
    expect(extractAudioDescriptor.newExtension).toBe("mp3");
    expect(extractAudioDescriptor.accept).toContain("video/mp4");
    expect(typeof extractAudioDescriptor.loadEngine).toBe("function");
    expect(typeof extractAudioDescriptor.setupSizeLabel).toBe("string");
    // ST core (audio-only output, no COOP/COEP needed).
    expect(extractAudioDescriptor.setupSizeLabel).toMatch(/24/);
  });

  it("has a select control for output format with mp3/wav/m4a options", () => {
    const controls = extractAudioDescriptor.controls ?? [];
    // The format select is the FIRST control; advanced settings follow it.
    const ctrl = controls[0];
    expect(ctrl.type).toBe("select");
    expect(ctrl.id).toBe("format");
    if (ctrl.type === "select") {
      const values = ctrl.options.map((o) => o.value);
      expect(values).toContain("mp3");
      expect(values).toContain("wav");
      expect(values).toContain("m4a");
      expect(ctrl.default).toBe("mp3");
    }
  });

  it("adds the advanced audio settings alongside the format select", () => {
    const byId = Object.fromEntries(
      (extractAudioDescriptor.controls ?? []).map((c) => [c.id, c]),
    );
    expect(byId.format?.type).toBe("select"); // existing control preserved
    const bitrate = byId.bitrate;
    expect(bitrate?.type).toBe("select");
    if (bitrate?.type === "select") {
      // Extract-audio's bitrate defaults to "auto" so the original codec-default
      // command (no -b:a) is reproduced out of the box.
      expect(bitrate.default).toBe("auto");
    }
    expect(byId.vbr?.type).toBe("checkbox");
    expect(byId.sampleRate?.type).toBe("select");
    expect(byId.channels?.type).toBe("select");
    expect(byId.volume?.type).toBe("range");
    expect(byId.reverse?.type).toBe("checkbox");
    expect(byId.trimStart?.type).toBe("text");
    expect(byId.trimEnd?.type).toBe("text");
    expect(byId.fadeIn?.type).toBe("number");
    expect(byId.fadeOut?.type).toBe("number");
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(extractAudioDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(extractAudioDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .mp4 extension past the MIME gate", async () => {
    // Should pass the MIME gate; abort before engine load to get CANCELLED.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      extractAudioDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      extractAudioDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg ST runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "extracts audio from a real MP4 to MP3 (happy path)",
    async () => {
      await extractAudioDescriptor.loadEngine!();
      const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });
      const result = await extractAudioDescriptor.convert({ file, options: { format: "mp3" } });
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.filename).toBe("clip.mp3");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});
