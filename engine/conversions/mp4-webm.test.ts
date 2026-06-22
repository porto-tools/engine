import { describe, it, expect } from "vitest";
import { mp4WebmDescriptor, buildMp4ToWebmArgs } from "./mp4-webm";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The MP4→WEBM conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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
// they run for real. The pure helper (buildMp4ToWebmArgs) is DOM-free and runs in Node.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function" &&
  typeof globalThis.crossOriginIsolated !== "undefined" &&
  globalThis.crossOriginIsolated === true;

// A fixed bitrate so the regression test asserts an exact, stable arg array
// (the real pipeline passes recommendedVideoBitrate; the value is just String()'d).
const BITRATE = 2_000_000;

// The exact args the original one-click tool emitted (VP8 + Opus, realtime, no
// rotate, default audio). The defaults MUST reproduce this byte-for-byte.
const ORIGINAL_DEFAULT_ARGS = [
  "-i", "input.mp4",
  "-c:v", "libvpx",
  "-b:v", String(BITRATE),
  "-deadline", "realtime",
  "-cpu-used", "8",
  "-threads", "0",
  "-c:a", "libopus",
  "output.webm",
];

describe("mp4WebmDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(mp4WebmDescriptor.id).toBe("mp4-to-webm");
    expect(mp4WebmDescriptor.fromLabel).toBe("MP4");
    expect(mp4WebmDescriptor.toLabel).toBe("WEBM");
    expect(mp4WebmDescriptor.newExtension).toBe("webm");
    expect(mp4WebmDescriptor.accept).toContain("video/mp4");
    // loadEngine is required for the WASM-backed MT conversion.
    expect(typeof mp4WebmDescriptor.loadEngine).toBe("function");
    expect(typeof mp4WebmDescriptor.setupSizeLabel).toBe("string");
    // The MT core is shared with the other video routes.
    expect(mp4WebmDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("exposes the converter control set with the right ids, types and defaults", () => {
    const controls = mp4WebmDescriptor.controls ?? [];
    const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(
      ["audioCodec", "bitrate", "crf", "fadeIn", "fadeOut", "preset", "rotate", "sampleRate", "videoCodec", "volume"].sort(),
    );

    // VP8 must be first/default — the byte-identical original behaviour.
    const videoCodec = byId.videoCodec;
    expect(videoCodec.type).toBe("select");
    if (videoCodec.type === "select") {
      expect(videoCodec.default).toBe("vp8");
      expect(videoCodec.options.map((o) => o.value)).toEqual(["vp8", "vp9"]);
    }

    // CRF range 10..63, default 33 (VP9-only).
    const crf = byId.crf;
    expect(crf.type).toBe("range");
    if (crf.type === "range") {
      expect(crf.default).toBe(33);
      expect(crf.min).toBe(10);
      expect(crf.max).toBe(63);
    }

    // Preset realtime (default) / good / best.
    const preset = byId.preset;
    expect(preset.type).toBe("select");
    if (preset.type === "select") {
      expect(preset.default).toBe("realtime");
      expect(preset.options.map((o) => o.value)).toEqual(["realtime", "good", "best"]);
    }

    // Rotate none (default) / 90 / 180 / 270.
    const rotate = byId.rotate;
    expect(rotate.type).toBe("select");
    if (rotate.type === "select") {
      expect(rotate.default).toBe("none");
      expect(rotate.options.map((o) => o.value)).toEqual(["none", "90", "180", "270"]);
    }

    // Audio codec libopus (default) / libvorbis.
    const audioCodec = byId.audioCodec;
    expect(audioCodec.type).toBe("select");
    if (audioCodec.type === "select") {
      expect(audioCodec.default).toBe("libopus");
      expect(audioCodec.options.map((o) => o.value)).toEqual(["libopus", "libvorbis"]);
    }
  });

  it("declares defaultOptions matching the control defaults (byte-identical guard)", () => {
    expect(mp4WebmDescriptor.defaultOptions).toMatchObject({
      videoCodec: "vp8",
      preset: "realtime",
      audioCodec: "libopus",
      rotate: "none",
      sampleRate: "auto",
      bitrate: "auto",
      volume: 100,
      fadeIn: 0,
      fadeOut: 0,
    });
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    // A PNG signature with image/png MIME — clearly not video.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(mp4WebmDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(mp4WebmDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .mp4 extension past the MIME gate", async () => {
    // A file with an .mp4 extension and empty MIME should pass the MIME gate
    // and fail at the engine load (no runtime in Node), not at UNSUPPORTED_INPUT.
    const ctrl = new AbortController();
    ctrl.abort(); // abort before engine load so we get CANCELLED, not ENGINE_LOAD_FAILED
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      mp4WebmDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Use video/mp4 MIME so it passes the MIME gate, then hits the abort check.
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      mp4WebmDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (libvpx + libopus encode) against
  // a real MP4 fixture when a browser env is wired up.
  // NOTE: the DEFAULT VP8/Opus path is the production behaviour. The OPTIONAL VP9
  // path (libvpx-vp9 -b:v 0 -crf <n>) is NOT yet confirmed in this WASM build —
  // verify in browser that:
  //   1. libvpx-vp9 is actually present in the MT WASM build (VP8 is known-good)
  //   2. -b:v 0 -crf 33 -deadline realtime/good/best produce a valid WebM at speed
  //   3. libopus AND libvorbis both produce valid audio tracks
  //   4. output WEBM plays in Chrome/Firefox (Safari VP9 support from macOS 12)
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real MP4 to WEBM (happy path)",
    async () => {
      // Load the MT core first — the one-time setup moment.
      await mp4WebmDescriptor.loadEngine!();

      // A minimal MP4 fixture: ftyp box header bytes
      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await mp4WebmDescriptor.convert({ file });

      expect(result.mimeType).toBe("video/webm");
      expect(result.filename).toBe("clip.webm");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("video/webm");
    },
  );
});

// ── Pure helper: buildMp4ToWebmArgs ───────────────────────────────────────────
// Runs for real in Node — no DOM, no Worker, no ffmpeg.
describe("buildMp4ToWebmArgs", () => {
  it("reproduces the original VP8/Opus default args BYTE-FOR-BYTE", () => {
    // No options at all.
    expect(buildMp4ToWebmArgs({}, BITRATE)).toEqual(ORIGINAL_DEFAULT_ARGS);
    // And explicitly with the descriptor's own default options.
    expect(
      buildMp4ToWebmArgs(
        {
          videoCodec: "vp8",
          preset: "realtime",
          audioCodec: "libopus",
          rotate: "none",
          sampleRate: "auto",
          bitrate: "auto",
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
        },
        BITRATE,
      ),
    ).toEqual(ORIGINAL_DEFAULT_ARGS);
    // No -vf and no -af on the default path.
    expect(buildMp4ToWebmArgs({}, BITRATE)).not.toContain("-vf");
    expect(buildMp4ToWebmArgs({}, BITRATE)).not.toContain("-af");
    // CRF must NOT appear for VP8 (bitrate-only).
    expect(buildMp4ToWebmArgs({}, BITRATE)).not.toContain("-crf");
  });

  it("uses libvpx-vp9 + -b:v 0 + -crf in VP9 mode and maps the preset to cpu-used", () => {
    expect(buildMp4ToWebmArgs({ videoCodec: "vp9", crf: 28, preset: "good" }, BITRATE)).toEqual([
      "-i", "input.mp4",
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", "28",
      "-deadline", "good",
      "-cpu-used", "5",
      "-threads", "0",
      "-c:a", "libopus",
      "output.webm",
    ]);
    // Best preset → deadline best, cpu-used 0. The source bitrate is NOT used in VP9.
    const best = buildMp4ToWebmArgs({ videoCodec: "vp9", preset: "best" }, BITRATE);
    expect(best).toContain("best");
    expect(best.slice(best.indexOf("-cpu-used"), best.indexOf("-cpu-used") + 2)).toEqual([
      "-cpu-used", "0",
    ]);
    expect(best).not.toContain(String(BITRATE));
  });

  it("clamps an out-of-range CRF into 10..63", () => {
    expect(buildMp4ToWebmArgs({ videoCodec: "vp9", crf: 200 }, BITRATE)).toContain("63");
    expect(buildMp4ToWebmArgs({ videoCodec: "vp9", crf: 1 }, BITRATE)).toContain("10");
  });

  it("composes rotate (-vf) and volume + fades (-af) as SEPARATE flags", () => {
    const args = buildMp4ToWebmArgs(
      { rotate: "90", volume: 150, fadeIn: 2, fadeOut: 3 },
      BITRATE,
    );
    expect(args).toEqual([
      "-i", "input.mp4",
      "-vf", "transpose=1",
      "-c:v", "libvpx",
      "-b:v", String(BITRATE),
      "-deadline", "realtime",
      "-cpu-used", "8",
      "-threads", "0",
      "-af", "volume=1.5,afade=t=in:st=0:d=2,areverse,afade=t=in:st=0:d=3,areverse",
      "-c:a", "libopus",
      "output.webm",
    ]);
    // -vf sits right after -i; -vf and -af are distinct flags.
    expect(args.indexOf("-vf")).toBe(args.indexOf("-i") + 2);
    expect(args.indexOf("-af")).toBeGreaterThan(args.indexOf("-vf"));
  });

  it("maps each rotation to the right transpose/flip filter", () => {
    // args[2] is "-vf"; args[3] is the filter value.
    expect(buildMp4ToWebmArgs({ rotate: "90" }, BITRATE)[3]).toBe("transpose=1");
    expect(buildMp4ToWebmArgs({ rotate: "180" }, BITRATE)[3]).toBe("hflip,vflip");
    expect(buildMp4ToWebmArgs({ rotate: "270" }, BITRATE)[3]).toBe("transpose=2");
  });

  it("emits the chosen audio codec, bitrate and sample rate", () => {
    const args = buildMp4ToWebmArgs(
      { audioCodec: "libvorbis", bitrate: "128k", sampleRate: "48000" },
      BITRATE,
    );
    // Codec then bitrate then sample rate, in that order, before the output.
    expect(args.slice(-7)).toEqual([
      "-c:a", "libvorbis",
      "-b:a", "128k",
      "-ar", "48000",
      "output.webm",
    ]);
  });

  it("falls back to the defaults for garbage option values", () => {
    expect(
      buildMp4ToWebmArgs(
        { videoCodec: "h265", preset: "ludicrous", audioCodec: "mp3", rotate: "45", bitrate: "999k", sampleRate: "11025" },
        BITRATE,
      ),
    ).toEqual(ORIGINAL_DEFAULT_ARGS);
  });
});
