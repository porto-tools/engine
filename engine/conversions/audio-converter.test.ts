import { describe, it, expect } from "vitest";
import {
  audioConverterDescriptor,
  buildAudioConverterArgs,
  FORMAT_CONFIG,
} from "./audio-converter";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The audio-converter pipeline requires the @ffmpeg/ffmpeg ST runtime, which
// spawns a Web Worker and loads its core via blob: URLs — none of which exist in
// plain Node. So the happy path is skipped via it.skipIf, mirroring the sibling
// audio tests. UNSUPPORTED_INPUT and CANCELLED both throw BEFORE any FFmpeg call,
// so they run for real.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

describe("buildAudioConverterArgs", () => {
  // Pull the per-format codec descriptors straight from FORMAT_CONFIG so the
  // tests verify the SAME flags the convert() path emits.
  const codecOf = (fmt: keyof typeof FORMAT_CONFIG) => FORMAT_CONFIG[fmt].audioCodec;

  it("default opts reproduce a minimal -c:a <codec> command (no -b:a)", () => {
    // MP3 default: bitrate "auto" → no -b:a, just the codec select.
    expect(buildAudioConverterArgs("input.mp3", "output.mp3", codecOf("mp3"))).toEqual([
      "-i", "input.mp3", "-c:a", "libmp3lame", "output.mp3",
    ]);
    expect(buildAudioConverterArgs("input.mp3", "output.mp3", codecOf("mp3"), {})).toEqual([
      "-i", "input.mp3", "-c:a", "libmp3lame", "output.mp3",
    ]);
  });

  // ── Per-format codec flags ──────────────────────────────────────────────────
  it("emits -c:a libmp3lame for mp3", () => {
    expect(buildAudioConverterArgs("input.wav", "output.mp3", codecOf("mp3"))).toContain(
      "libmp3lame",
    );
    expect(FORMAT_CONFIG.mp3.audioCodec.ffmpegArgs).toEqual(["-c:a", "libmp3lame"]);
  });

  it("emits -c:a pcm_s16le for wav", () => {
    expect(buildAudioConverterArgs("input.mp3", "output.wav", codecOf("wav"))).toEqual([
      "-i", "input.mp3", "-c:a", "pcm_s16le", "output.wav",
    ]);
  });

  it("emits -c:a aac for m4a", () => {
    expect(FORMAT_CONFIG.m4a.audioCodec.ffmpegArgs).toEqual(["-c:a", "aac"]);
  });

  it("emits -c:a aac for aac (raw ADTS)", () => {
    expect(FORMAT_CONFIG.aac.audioCodec.ffmpegArgs).toEqual(["-c:a", "aac"]);
    expect(FORMAT_CONFIG.aac.ext).toBe("aac");
    expect(FORMAT_CONFIG.aac.mimeType).toBe("audio/aac");
  });

  it("emits -c:a flac for flac", () => {
    expect(buildAudioConverterArgs("input.mp3", "output.flac", codecOf("flac"))).toEqual([
      "-i", "input.mp3", "-c:a", "flac", "output.flac",
    ]);
  });

  it("emits -c:a libvorbis for ogg", () => {
    expect(buildAudioConverterArgs("input.mp3", "output.ogg", codecOf("ogg"))).toContain(
      "libvorbis",
    );
    expect(FORMAT_CONFIG.ogg.audioCodec.vbrEncoder).toBeUndefined();
  });

  it("emits -c:a libopus for opus", () => {
    expect(buildAudioConverterArgs("input.mp3", "output.opus", codecOf("opus"))).toContain(
      "libopus",
    );
    expect(FORMAT_CONFIG.opus.ext).toBe("opus");
    expect(FORMAT_CONFIG.opus.audioCodec.vbrEncoder).toBeUndefined();
  });

  it("emits -c:a pcm_s16be for aiff", () => {
    expect(buildAudioConverterArgs("input.mp3", "output.aiff", codecOf("aiff"))).toEqual([
      "-i", "input.mp3", "-c:a", "pcm_s16be", "output.aiff",
    ]);
  });

  // ── Lossless never emit a bitrate, even with one set ─────────────────────────
  it.each(["wav", "flac", "aiff"] as const)(
    "lossless %s emits NO -b:a even when a bitrate is set",
    (fmt) => {
      const args = buildAudioConverterArgs(
        "input.mp3",
        `output.${FORMAT_CONFIG[fmt].ext}`,
        codecOf(fmt),
        { bitrate: "320k" },
      );
      expect(args).not.toContain("-b:a");
      expect(FORMAT_CONFIG[fmt].audioCodec.lossy).toBe(false);
    },
  );

  // ── Lossy mp3 with a bitrate emits -b:a ──────────────────────────────────────
  it("lossy mp3 with bitrate 192k emits -b:a 192k", () => {
    expect(
      buildAudioConverterArgs("input.wav", "output.mp3", codecOf("mp3"), { bitrate: "192k" }),
    ).toEqual(["-i", "input.wav", "-c:a", "libmp3lame", "-b:a", "192k", "output.mp3"]);
  });

  it("lossy ogg/opus with a bitrate (vbr off) emit -b:a", () => {
    // ogg/opus have no vbrEncoder; with vbr off the chosen bitrate maps to -b:a.
    expect(
      buildAudioConverterArgs("input.mp3", "output.ogg", codecOf("ogg"), { bitrate: "128k" }),
    ).toEqual(["-i", "input.mp3", "-c:a", "libvorbis", "-b:a", "128k", "output.ogg"]);
    expect(
      buildAudioConverterArgs("input.mp3", "output.opus", codecOf("opus"), { bitrate: "96k" }),
    ).toEqual(["-i", "input.mp3", "-c:a", "libopus", "-b:a", "96k", "output.opus"]);
  });

  it("ogg with vbr ON is a harmless no-op (no vbrEncoder → encoder default, no -b:a)", () => {
    // The shared builder only emits a VBR -q:a when codec.vbrEncoder is set;
    // with vbr on and no encoder, it emits NOTHING — the encoder's own default
    // VBR is used. This is the documented ogg/opus behaviour.
    expect(
      buildAudioConverterArgs("input.mp3", "output.ogg", codecOf("ogg"), {
        bitrate: "128k",
        vbr: true,
      }),
    ).toEqual(["-i", "input.mp3", "-c:a", "libvorbis", "output.ogg"]);
  });

  it("the descriptor's defaultOptions reproduce the minimal MP3 command", () => {
    expect(
      buildAudioConverterArgs(
        "input.mp3",
        "output.mp3",
        codecOf("mp3"),
        audioConverterDescriptor.defaultOptions,
      ),
    ).toEqual(["-i", "input.mp3", "-c:a", "libmp3lame", "output.mp3"]);
  });
});

describe("FORMAT_CONFIG", () => {
  it("covers all eight output formats with codec/ext/mime", () => {
    expect(Object.keys(FORMAT_CONFIG).sort()).toEqual(
      ["aac", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav"].sort(),
    );
    expect(FORMAT_CONFIG.flac.mimeType).toBe("audio/flac");
    expect(FORMAT_CONFIG.opus.mimeType).toBe("audio/ogg");
    expect(FORMAT_CONFIG.aiff.mimeType).toBe("audio/aiff");
  });
});

describe("audioConverterDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(audioConverterDescriptor.id).toBe("audio-converter");
    expect(audioConverterDescriptor.fromLabel).toBe("Audio");
    expect(audioConverterDescriptor.toLabel).toBe("Any format");
    expect(audioConverterDescriptor.newExtension).toBe("mp3");
    expect(typeof audioConverterDescriptor.loadEngine).toBe("function");
    expect(audioConverterDescriptor.setupSizeLabel).toMatch(/24/);
    // Accepts a spread of audio MIME types.
    expect(audioConverterDescriptor.accept).toContain("audio/mpeg");
    expect(audioConverterDescriptor.accept).toContain("audio/flac");
    expect(audioConverterDescriptor.accept).toContain("audio/ogg");
  });

  it("has the format select FIRST with all eight options", () => {
    const ctrl = (audioConverterDescriptor.controls ?? [])[0];
    expect(ctrl.type).toBe("select");
    expect(ctrl.id).toBe("format");
    if (ctrl.type === "select") {
      const values = ctrl.options.map((o) => o.value);
      for (const f of ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"]) {
        expect(values).toContain(f);
      }
      expect(ctrl.default).toBe("mp3");
    }
  });

  it("includes the shared audio drawer controls", () => {
    const byId = Object.fromEntries(
      (audioConverterDescriptor.controls ?? []).map((c) => [c.id, c]),
    );
    expect(byId.bitrate?.type).toBe("select");
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

  it("rejects a non-audio file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.txt", {
      type: "text/plain",
    });
    await expect(audioConverterDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-audio extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", { type: "" });
    await expect(audioConverterDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with a known audio extension past the MIME gate", async () => {
    // Passes the MIME gate; aborts before engine load → CANCELLED proves it got past.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xfb])], "song.flac", { type: "" });
    await expect(
      audioConverterDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xfb])], "song.mp3", { type: "audio/mpeg" });
    await expect(
      audioConverterDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg ST runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env, mirroring the sibling audio tests.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real audio file to FLAC (happy path)",
    async () => {
      await audioConverterDescriptor.loadEngine!();
      const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      const file = new File([bytes], "song.mp3", { type: "audio/mpeg" });
      const result = await audioConverterDescriptor.convert({
        file,
        options: { format: "flac" },
      });
      expect(result.mimeType).toBe("audio/flac");
      expect(result.filename).toBe("song.flac");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});
