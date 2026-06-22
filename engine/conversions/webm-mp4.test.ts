import { describe, it, expect } from "vitest";
import { webmMp4Descriptor, buildWebmToMp4Args } from "./webm-mp4";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The WEBM→MP4 conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
//   1. spawns a Web Worker (new Worker(new URL("./worker.js", import.meta.url)))
//   2. loads the multi-threaded core via blob: URLs built with @ffmpeg/util's toBlobURL
//   3. uses fetch() of same-origin /ffmpeg-mt/* assets + URL.createObjectURL
//   4. additionally requires crossOriginIsolated (SharedArrayBuffer for pthreads)
// None of Worker / blob: URL fetch / a served public/ / cross-origin isolation
// exist in plain Node.
//
// TODO(test-env): wire up a browser test environment (e.g. vitest browser mode)
// that serves public/ with COOP/COEP headers and supports Worker + blob: URLs so
// the happy path can run in CI. Until then the happy path is skipped via it.skipIf.
// UNSUPPORTED_INPUT and CANCELLED both throw BEFORE any FFmpeg/Worker call, so
// they run for real. The pure helper (buildWebmToMp4Args) is DOM-free and runs in Node.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function" &&
  typeof globalThis.crossOriginIsolated !== "undefined" &&
  globalThis.crossOriginIsolated === true;

// A fixed bitrate so the regression test asserts an exact, stable arg array
// (the real pipeline passes recommendedVideoBitrate; the value is just String()'d).
const BITRATE = 2_000_000;

// The exact args the original one-click tool emitted (H.264 + AAC, no rotate,
// default audio). The defaults MUST reproduce this byte-for-byte.
const ORIGINAL_DEFAULT_ARGS = [
  "-i", "input.webm",
  "-c:v", "libopenh264",
  "-b:v", String(BITRATE),
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-c:a", "aac",
  "output.mp4",
];

describe("webmMp4Descriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(webmMp4Descriptor.id).toBe("webm-to-mp4");
    expect(webmMp4Descriptor.fromLabel).toBe("WEBM");
    expect(webmMp4Descriptor.toLabel).toBe("MP4");
    expect(webmMp4Descriptor.newExtension).toBe("mp4");
    expect(webmMp4Descriptor.accept).toContain("video/webm");
    // loadEngine is required for the WASM-backed MT conversion.
    expect(typeof webmMp4Descriptor.loadEngine).toBe("function");
    expect(typeof webmMp4Descriptor.setupSizeLabel).toBe("string");
    // The MT core is shared with the other video routes.
    expect(webmMp4Descriptor.setupSizeLabel).toMatch(/26/);
  });

  it("exposes the converter control set: rotate + audio, NO codec/crf/preset", () => {
    const controls = webmMp4Descriptor.controls ?? [];
    const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(
      ["bitrate", "fadeIn", "fadeOut", "rotate", "sampleRate", "volume"].sort(),
    );

    // libopenh264 offers no video codec / crf / preset knobs — none must exist.
    expect(byId.videoCodec).toBeUndefined();
    expect(byId.crf).toBeUndefined();
    expect(byId.preset).toBeUndefined();
    // AAC-only: no audio codec selector either.
    expect(byId.audioCodec).toBeUndefined();

    // Rotate none (default) / 90 / 180 / 270.
    const rotate = byId.rotate;
    expect(rotate.type).toBe("select");
    if (rotate.type === "select") {
      expect(rotate.default).toBe("none");
      expect(rotate.options.map((o) => o.value)).toEqual(["none", "90", "180", "270"]);
    }
  });

  it("declares defaultOptions matching the control defaults (byte-identical guard)", () => {
    expect(webmMp4Descriptor.defaultOptions).toMatchObject({
      rotate: "none",
      sampleRate: "auto",
      bitrate: "auto",
      volume: 100,
      fadeIn: 0,
      fadeOut: 0,
    });
  });

  it("rejects a non-WEBM file as UNSUPPORTED_INPUT", async () => {
    // An MP4 file with video/mp4 MIME — clearly not WEBM.
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(webmMp4Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-WEBM extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(webmMp4Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .webm extension past the MIME gate", async () => {
    // A file with a .webm extension and empty MIME should pass the MIME gate
    // and fail at the engine load (no runtime in Node), not at UNSUPPORTED_INPUT.
    const ctrl = new AbortController();
    ctrl.abort(); // abort before engine load so we get CANCELLED, not ENGINE_LOAD_FAILED
    const file = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "video.webm", {
      type: "",
    });
    await expect(
      webmMp4Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Use video/webm MIME so it passes the MIME gate, then hits the abort check.
    const file = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "video.webm", {
      type: "video/webm",
    });
    await expect(
      webmMp4Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (libopenh264 + AAC encode) against
  // a real WEBM fixture when a browser env is wired up.
  // NOTE: libopenh264 is the same encoder as GIF→MP4 — verify in browser that:
  //   1. VP8/VP9 decode from WEBM source succeeds
  //   2. libopenh264 + yuv420p produces a valid H.264 stream
  //   3. native AAC encoder handles Vorbis/Opus source audio
  //   4. the rotate -vf (transpose/hflip,vflip) plus an -af audio chain co-exist
  //   5. output MP4 plays in Chrome/Firefox/Safari/iOS
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real WEBM to MP4 (happy path)",
    async () => {
      // Load the MT core first — the one-time setup moment.
      await webmMp4Descriptor.loadEngine!();

      // EBML header bytes: the WEBM/MKV container starts with these 4 bytes
      const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
      const file = new File([webmBytes], "video.webm", { type: "video/webm" });

      const result = await webmMp4Descriptor.convert({ file });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("video.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("video/mp4");
    },
  );
});

// ── Pure helper: buildWebmToMp4Args ───────────────────────────────────────────
// Runs for real in Node — no DOM, no Worker, no ffmpeg.
describe("buildWebmToMp4Args", () => {
  it("reproduces the original H.264/AAC default args BYTE-FOR-BYTE", () => {
    // No options at all.
    expect(buildWebmToMp4Args({}, BITRATE)).toEqual(ORIGINAL_DEFAULT_ARGS);
    // And explicitly with the descriptor's own default options.
    expect(
      buildWebmToMp4Args(
        { rotate: "none", sampleRate: "auto", bitrate: "auto", volume: 100, fadeIn: 0, fadeOut: 0 },
        BITRATE,
      ),
    ).toEqual(ORIGINAL_DEFAULT_ARGS);
    // No -vf and no -af on the default path; pix_fmt + faststart always present.
    expect(buildWebmToMp4Args({}, BITRATE)).not.toContain("-vf");
    expect(buildWebmToMp4Args({}, BITRATE)).not.toContain("-af");
    expect(buildWebmToMp4Args({}, BITRATE)).toContain("yuv420p");
    expect(buildWebmToMp4Args({}, BITRATE)).toContain("+faststart");
    // No video-codec/crf/preset flags are ever introduced (openh264 has none).
    expect(buildWebmToMp4Args({}, BITRATE)).not.toContain("-crf");
    expect(buildWebmToMp4Args({}, BITRATE)).not.toContain("-deadline");
  });

  it("composes rotate (-vf) and volume + fades (-af) as SEPARATE flags", () => {
    const args = buildWebmToMp4Args(
      { rotate: "270", volume: 80, fadeIn: 1, fadeOut: 4 },
      BITRATE,
    );
    expect(args).toEqual([
      "-i", "input.webm",
      "-vf", "transpose=2",
      "-c:v", "libopenh264",
      "-b:v", String(BITRATE),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-af", "volume=0.8,afade=t=in:st=0:d=1,areverse,afade=t=in:st=0:d=4,areverse",
      "-c:a", "aac",
      "output.mp4",
    ]);
    // -vf sits right after -i; -vf and -af are distinct flags.
    expect(args.indexOf("-vf")).toBe(args.indexOf("-i") + 2);
    expect(args.indexOf("-af")).toBeGreaterThan(args.indexOf("-vf"));
  });

  it("maps each rotation to the right transpose/flip filter", () => {
    // args[2] is "-vf"; args[3] is the filter value.
    expect(buildWebmToMp4Args({ rotate: "90" }, BITRATE)[3]).toBe("transpose=1");
    expect(buildWebmToMp4Args({ rotate: "180" }, BITRATE)[3]).toBe("hflip,vflip");
    expect(buildWebmToMp4Args({ rotate: "270" }, BITRATE)[3]).toBe("transpose=2");
  });

  it("emits AAC with the chosen bitrate and sample rate (codec is always aac)", () => {
    const args = buildWebmToMp4Args({ bitrate: "192k", sampleRate: "44100" }, BITRATE);
    expect(args.slice(-7)).toEqual([
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "output.mp4",
    ]);
  });

  it("falls back to the defaults for garbage option values", () => {
    expect(
      buildWebmToMp4Args({ rotate: "45", bitrate: "999k", sampleRate: "11025", volume: "loud" }, BITRATE),
    ).toEqual(ORIGINAL_DEFAULT_ARGS);
  });
});
