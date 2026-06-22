import { describe, it, expect } from "vitest";
import { wavMp3Descriptor, buildWavMp3Args } from "./wav-mp3";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The WAV→MP3 conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("buildWavMp3Args", () => {
  // The arg array the route produces out of the box. The shared builder now emits
  // an explicit `-c:a libmp3lame` (the .mp3 muxer's default encoder either way —
  // output is byte-identical to the old implicit form) plus the route's historic
  // -b:a 192k.
  const DEFAULT_ARGS = ["-i", "input.wav", "-c:a", "libmp3lame", "-b:a", "192k", "output.mp3"];

  it("default opts reproduce the route's -b:a 192k encode", () => {
    expect(buildWavMp3Args()).toEqual(["-i", "input.wav", "-c:a", "libmp3lame", "output.mp3"]);
    expect(buildWavMp3Args({})).toEqual(["-i", "input.wav", "-c:a", "libmp3lame", "output.mp3"]);
  });

  it("the descriptor's defaultOptions reproduce the 192k encode (no-op preserved)", () => {
    expect(buildWavMp3Args(wavMp3Descriptor.defaultOptions)).toEqual(DEFAULT_ARGS);
  });

  it("emits the chosen bitrate as -b:a <n>k", () => {
    expect(buildWavMp3Args({ bitrate: "128k" })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame", "-b:a", "128k", "output.mp3",
    ]);
  });

  it("omits -b:a entirely when bitrate is Auto", () => {
    expect(buildWavMp3Args({ bitrate: "auto" })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame", "output.mp3",
    ]);
  });

  it("VBR on maps the bitrate to a libmp3lame -q:a level instead of -b:a", () => {
    expect(buildWavMp3Args({ bitrate: "320k", vbr: true })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame", "-q:a", "0", "output.mp3",
    ]);
  });

  it("emits -ar and -ac for non-Auto sample rate / channels", () => {
    expect(buildWavMp3Args({ bitrate: "192k", sampleRate: "44100", channels: "1" })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1", "output.mp3",
    ]);
  });

  it("folds reverse + volume into ONE -filter:a chain, before -b:a", () => {
    expect(buildWavMp3Args({ bitrate: "192k", reverse: true, volume: 150 })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame",
      "-filter:a", "areverse,volume=1.5", "-b:a", "192k", "output.mp3",
    ]);
  });

  it("does NOT emit a filter for 100% volume + reverse off", () => {
    expect(buildWavMp3Args({ bitrate: "192k", volume: 100, reverse: false })).toEqual(DEFAULT_ARGS);
  });

  it("falls back to no bitrate (auto) on an invalid bitrate value", () => {
    expect(buildWavMp3Args({ bitrate: "999k" })).toEqual([
      "-i", "input.wav", "-c:a", "libmp3lame", "output.mp3",
    ]);
  });
});

describe("wavMp3Descriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(wavMp3Descriptor.id).toBe("wav-to-mp3");
    expect(wavMp3Descriptor.fromLabel).toBe("WAV");
    expect(wavMp3Descriptor.toLabel).toBe("MP3");
    expect(wavMp3Descriptor.newExtension).toBe("mp3");
    expect(wavMp3Descriptor.accept).toContain("audio/wav");
    expect(wavMp3Descriptor.accept).toContain("audio/x-wav");
    expect(wavMp3Descriptor.accept).toContain("audio/wave");
    expect(wavMp3Descriptor.accept).toContain("audio/vnd.wave");
    // loadEngine is required for the WASM-backed conversion.
    expect(typeof wavMp3Descriptor.loadEngine).toBe("function");
    expect(typeof wavMp3Descriptor.setupSizeLabel).toBe("string");
  });

  it("exposes the audio settings controls with a 192k default bitrate + VBR/trim/fade", () => {
    const byId = Object.fromEntries(
      (wavMp3Descriptor.controls ?? []).map((c) => [c.id, c]),
    );
    const bitrate = byId.bitrate;
    expect(bitrate?.type).toBe("select");
    if (bitrate?.type === "select") {
      expect(bitrate.default).toBe("192k"); // preserves the original -b:a 192k
      expect(bitrate.options.map((o) => o.value)).toContain("320k");
      expect(bitrate.options.map((o) => o.value)).toContain("auto");
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

  it("rejects a non-WAV file as UNSUPPORTED_INPUT", async () => {
    // A PNG signature with image/png MIME — clearly not audio.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(wavMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-WAV extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(wavMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // A valid WAV MIME so it passes the MIME gate and reaches the abort check.
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "sound.wav", {
      type: "audio/wav",
    });
    await expect(
      wavMp3Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env. Runs the full write → exec →
  // read pipeline against a real WAV fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real WAV to MP3 (happy path)",
    async () => {
      await wavMp3Descriptor.loadEngine!();

      // Minimal RIFF/WAV header + empty data chunk — enough to exercise the
      // WAV demuxer and MP3 encoder path.
      const wavHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0x24, 0x00, 0x00, 0x00, // chunk size
        0x57, 0x41, 0x56, 0x45, // "WAVE"
        0x66, 0x6d, 0x74, 0x20, // "fmt "
        0x10, 0x00, 0x00, 0x00, // subchunk size 16
        0x01, 0x00,             // PCM
        0x01, 0x00,             // 1 channel
        0x44, 0xac, 0x00, 0x00, // 44100 Hz
        0x88, 0x58, 0x01, 0x00, // byte rate
        0x02, 0x00,             // block align
        0x10, 0x00,             // bits per sample 16
        0x64, 0x61, 0x74, 0x61, // "data"
        0x00, 0x00, 0x00, 0x00, // data size 0
      ]);
      const file = new File([wavHeader], "sound.wav", { type: "audio/wav" });

      const result = await wavMp3Descriptor.convert({ file });

      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.filename).toBe("sound.mp3");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("audio/mpeg");
    },
  );
});
