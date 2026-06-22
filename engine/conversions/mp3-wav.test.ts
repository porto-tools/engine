import { describe, it, expect } from "vitest";
import { mp3WavDescriptor, buildMp3WavArgs } from "./mp3-wav";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The MP3→WAV conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("buildMp3WavArgs", () => {
  // The exact arg array the route shipped before the audio drawer existed. WAV
  // is uncompressed PCM, so there is no bitrate flag here.
  const DEFAULT_ARGS = ["-i", "input.mp3", "output.wav"];

  it("default opts reproduce the original args", () => {
    expect(buildMp3WavArgs()).toEqual(DEFAULT_ARGS);
    expect(buildMp3WavArgs({})).toEqual(DEFAULT_ARGS);
  });

  it("the descriptor's defaultOptions reproduce the original args (no-op preserved)", () => {
    expect(buildMp3WavArgs(mp3WavDescriptor.defaultOptions)).toEqual(DEFAULT_ARGS);
  });

  it("emits -ar for a non-Auto sample rate", () => {
    expect(buildMp3WavArgs({ sampleRate: "44100" })).toEqual([
      "-i", "input.mp3", "-ar", "44100", "output.wav",
    ]);
  });

  it("emits -ac 1 for mono", () => {
    expect(buildMp3WavArgs({ channels: "1" })).toEqual([
      "-i", "input.mp3", "-ac", "1", "output.wav",
    ]);
  });

  it("emits a volume filter for a non-100% gain (factor = pct/100)", () => {
    expect(buildMp3WavArgs({ volume: 150 })).toEqual([
      "-i", "input.mp3", "-filter:a", "volume=1.5", "output.wav",
    ]);
  });

  it("does NOT emit a filter for 100% volume", () => {
    expect(buildMp3WavArgs({ volume: 100 })).toEqual(DEFAULT_ARGS);
  });

  it("folds reverse + volume into ONE -filter:a chain (areverse first)", () => {
    expect(buildMp3WavArgs({ reverse: true, volume: 200 })).toEqual([
      "-i", "input.mp3", "-filter:a", "areverse,volume=2", "output.wav",
    ]);
  });

  it("orders filters before -ar then -ac, output last", () => {
    expect(
      buildMp3WavArgs({ sampleRate: "48000", channels: "2", volume: 50 }),
    ).toEqual([
      "-i", "input.mp3", "-filter:a", "volume=0.5", "-ar", "48000", "-ac", "2", "output.wav",
    ]);
  });

  it("clamps volume to its range and falls back on invalid enums", () => {
    expect(buildMp3WavArgs({ volume: 9999 })).toEqual([
      "-i", "input.mp3", "-filter:a", "volume=2", "output.wav",
    ]); // clamped to VOLUME_MAX 200 → factor 2
    // Bogus sample rate / channels values fall back to "auto" (no flag emitted).
    expect(buildMp3WavArgs({ sampleRate: "99999", channels: "7" })).toEqual(DEFAULT_ARGS);
  });

  it("emits trim as atrim+asetpts inside the filter chain (not -ss/-to)", () => {
    expect(buildMp3WavArgs({ trimStart: "0:15", trimEnd: "1:30" })).toEqual([
      "-i", "input.mp3", "-filter:a", "atrim=start=15:end=90,asetpts=N/SR/TB", "output.wav",
    ]);
  });

  it("emits the fade-out reverse-trick chain and fade-in", () => {
    expect(buildMp3WavArgs({ fadeIn: 2, fadeOut: 3 })).toEqual([
      "-i", "input.mp3",
      "-filter:a", "afade=t=in:st=0:d=2,areverse,afade=t=in:st=0:d=3,areverse",
      "output.wav",
    ]);
  });

  it("NEVER emits a bitrate flag — WAV is lossless even if bitrate is passed", () => {
    expect(buildMp3WavArgs({ bitrate: "320k", vbr: true })).toEqual(DEFAULT_ARGS);
  });
});

describe("mp3WavDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(mp3WavDescriptor.id).toBe("mp3-to-wav");
    expect(mp3WavDescriptor.fromLabel).toBe("MP3");
    expect(mp3WavDescriptor.toLabel).toBe("WAV");
    expect(mp3WavDescriptor.newExtension).toBe("wav");
    expect(mp3WavDescriptor.accept).toContain("audio/mpeg");
    // loadEngine is required for the WASM-backed conversion.
    expect(typeof mp3WavDescriptor.loadEngine).toBe("function");
    expect(typeof mp3WavDescriptor.setupSizeLabel).toBe("string");
  });

  it("exposes the audio settings controls (no bitrate/VBR — WAV is uncompressed)", () => {
    const byId = Object.fromEntries(
      (mp3WavDescriptor.controls ?? []).map((c) => [c.id, c]),
    );
    // WAV output: sample rate / channels / volume / reverse + trim + fade, but
    // NO bitrate or VBR.
    expect(byId.bitrate).toBeUndefined();
    expect(byId.vbr).toBeUndefined();
    expect(byId.sampleRate?.type).toBe("select");
    expect(byId.channels?.type).toBe("select");
    expect(byId.volume?.type).toBe("range");
    expect(byId.reverse?.type).toBe("checkbox");
    expect(byId.trimStart?.type).toBe("text");
    expect(byId.trimEnd?.type).toBe("text");
    expect(byId.fadeIn?.type).toBe("number");
    expect(byId.fadeOut?.type).toBe("number");
  });

  it("rejects a non-MP3 file as UNSUPPORTED_INPUT", async () => {
    // A PNG signature with image/png MIME — clearly not audio.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(mp3WavDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP3 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(mp3WavDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], "song.mp3", {
      type: "audio/mpeg",
    });
    await expect(
      mp3WavDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env. Runs the full write → exec →
  // read pipeline against a real MP3 fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real MP3 to WAV (happy path)",
    async () => {
      // Load the ST core first — the one-time setup moment.
      await mp3WavDescriptor.loadEngine!();

      // A minimal silent MP3 frame is enough to exercise decode → WAV mux.
      // (In the browser env this fixture would be read from __fixtures__.)
      const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const file = new File([mp3Frame], "song.mp3", { type: "audio/mpeg" });

      const result = await mp3WavDescriptor.convert({ file });

      expect(result.mimeType).toBe("audio/wav");
      expect(result.filename).toBe("song.wav");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("audio/wav");
    },
  );
});
