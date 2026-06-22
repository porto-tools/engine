import { describe, it, expect } from "vitest";
import { mp3M4aDescriptor, buildMp3M4aArgs } from "./mp3-m4a";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The MP3→M4A conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("buildMp3M4aArgs", () => {
  // The exact arg array the route shipped before the audio drawer existed (the
  // -c:a aac codec was always explicit, so this is byte-identical).
  const DEFAULT_ARGS = ["-i", "input.mp3", "-c:a", "aac", "-b:a", "192k", "output.m4a"];

  it("default opts reproduce the original -c:a aac (no bitrate without it set)", () => {
    expect(buildMp3M4aArgs()).toEqual(["-i", "input.mp3", "-c:a", "aac", "output.m4a"]);
    expect(buildMp3M4aArgs({})).toEqual(["-i", "input.mp3", "-c:a", "aac", "output.m4a"]);
  });

  it("the descriptor's defaultOptions reproduce the original 192k args (no-op preserved)", () => {
    expect(buildMp3M4aArgs(mp3M4aDescriptor.defaultOptions)).toEqual(DEFAULT_ARGS);
  });

  it("always keeps the -c:a aac codec flag and emits the chosen bitrate", () => {
    expect(buildMp3M4aArgs({ bitrate: "256k" })).toEqual([
      "-i", "input.mp3", "-c:a", "aac", "-b:a", "256k", "output.m4a",
    ]);
  });

  it("omits -b:a when bitrate is Auto but keeps the codec", () => {
    expect(buildMp3M4aArgs({ bitrate: "auto" })).toEqual([
      "-i", "input.mp3", "-c:a", "aac", "output.m4a",
    ]);
  });

  it("VBR on maps the bitrate to a native-aac -q:a quality instead of -b:a", () => {
    expect(buildMp3M4aArgs({ bitrate: "320k", vbr: true })).toEqual([
      "-i", "input.mp3", "-c:a", "aac", "-q:a", "2", "output.m4a",
    ]);
  });

  it("folds reverse + volume into ONE -filter:a chain, after the codec and before -b:a", () => {
    expect(buildMp3M4aArgs({ bitrate: "192k", reverse: true, volume: 50 })).toEqual([
      "-i", "input.mp3", "-c:a", "aac", "-filter:a", "areverse,volume=0.5", "-b:a", "192k", "output.m4a",
    ]);
  });

  it("emits trim (as leading atrim) and fade in ONE filter chain, alongside codec and bitrate", () => {
    // Trim leads the chain so the fade-out reverse trick fades the TRIMMED end.
    expect(buildMp3M4aArgs({ bitrate: "192k", trimStart: "5", fadeOut: 2 })).toEqual([
      "-i", "input.mp3", "-c:a", "aac",
      "-filter:a", "atrim=start=5,asetpts=N/SR/TB,areverse,afade=t=in:st=0:d=2,areverse",
      "-b:a", "192k", "output.m4a",
    ]);
  });

  it("emits -ar and -ac for non-Auto sample rate / channels", () => {
    expect(buildMp3M4aArgs({ bitrate: "192k", sampleRate: "48000", channels: "2" })).toEqual([
      "-i", "input.mp3", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "output.m4a",
    ]);
  });
});

describe("mp3M4aDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(mp3M4aDescriptor.id).toBe("mp3-to-m4a");
    expect(mp3M4aDescriptor.fromLabel).toBe("MP3");
    expect(mp3M4aDescriptor.toLabel).toBe("M4A");
    expect(mp3M4aDescriptor.newExtension).toBe("m4a");
    expect(mp3M4aDescriptor.accept).toContain("audio/mpeg");
    expect(mp3M4aDescriptor.accept).toContain("audio/mp3");
    // loadEngine is required for the WASM-backed conversion.
    expect(typeof mp3M4aDescriptor.loadEngine).toBe("function");
    expect(typeof mp3M4aDescriptor.setupSizeLabel).toBe("string");
  });

  it("exposes the audio settings controls with a 192k default bitrate + VBR/trim/fade", () => {
    const byId = Object.fromEntries(
      (mp3M4aDescriptor.controls ?? []).map((c) => [c.id, c]),
    );
    const bitrate = byId.bitrate;
    expect(bitrate?.type).toBe("select");
    if (bitrate?.type === "select") {
      expect(bitrate.default).toBe("192k"); // preserves the original -b:a 192k
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

  it("rejects a non-MP3 file as UNSUPPORTED_INPUT", async () => {
    // A PNG signature with image/png MIME — clearly not audio.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(mp3M4aDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP3 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(mp3M4aDescriptor.convert({ file })).rejects.toMatchObject({
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
      mp3M4aDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env. Runs the full write → exec →
  // read pipeline against a real MP3 fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real MP3 to M4A (happy path)",
    async () => {
      await mp3M4aDescriptor.loadEngine!();

      // A minimal silent MP3 frame is enough to exercise decode → AAC encode.
      const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const file = new File([mp3Frame], "song.mp3", { type: "audio/mpeg" });

      const result = await mp3M4aDescriptor.convert({ file });

      expect(result.mimeType).toBe("audio/mp4");
      expect(result.filename).toBe("song.m4a");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("audio/mp4");
    },
  );
});
