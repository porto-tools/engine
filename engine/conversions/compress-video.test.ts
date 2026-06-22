import { describe, it, expect } from "vitest";
import {
  compressVideoDescriptor,
  buildCompressArgs,
  resolveVideoBitrate,
  targetSizeVideoBitrate,
} from "./compress-video";

// The exact args the original one-click tool emitted (mode=level, level=Balanced,
// resolution=keep). The defaults MUST reproduce this byte-for-byte.
const ORIGINAL_DEFAULT_ARGS = [
  "-i", "input.mp4",
  "-c:v", "libopenh264",
  "-b:v", "1500k",
  "-c:a", "aac",
  "-b:a", "128k",
  "output.mp4",
];

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The compress-video pipeline requires the @ffmpeg/ffmpeg runtime, which:
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
// they run for real. The pure helpers (buildCompressArgs / resolveVideoBitrate /
// targetSizeVideoBitrate) are DOM-free and run for real in Node.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function" &&
  typeof globalThis.crossOriginIsolated !== "undefined" &&
  globalThis.crossOriginIsolated === true;

describe("compressVideoDescriptor", () => {
  it("has the correct top-level descriptor fields", () => {
    expect(compressVideoDescriptor.id).toBe("compress-video");
    expect(compressVideoDescriptor.fromLabel).toBe("MP4");
    expect(compressVideoDescriptor.toLabel).toBe("Compressed");
    expect(compressVideoDescriptor.newExtension).toBe("mp4");
    expect(compressVideoDescriptor.accept).toContain("video/mp4");
    // Many files at once, each with its own settings.
    expect(compressVideoDescriptor.inputMode).toBe("multi-compress");
    // loadEngine required for the WASM-backed MT conversion.
    expect(typeof compressVideoDescriptor.loadEngine).toBe("function");
    expect(typeof compressVideoDescriptor.setupSizeLabel).toBe("string");
    expect(compressVideoDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("defaults reproduce the original one-click output (mode=level, Balanced, keep)", () => {
    // The descriptor's defaultOptions must keep the args byte-for-byte identical to
    // the pre-multi-mode tool, so a one-click user sees no behavioural change.
    expect(compressVideoDescriptor.defaultOptions).toEqual({
      mode: "level",
      level: "Balanced",
      bitrate: "1500k",
      resolution: "keep",
      targetMb: 10,
    });
  });

  it("exposes the multi-mode control set with the right ids, types and defaults", () => {
    const controls = compressVideoDescriptor.controls ?? [];
    // mode + level + bitrate + targetMb + resolution.
    expect(controls).toHaveLength(5);

    const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(
      ["bitrate", "level", "mode", "resolution", "targetMb"].sort(),
    );

    // Mode selector — chooses how the target bitrate is derived.
    const mode = byId.mode;
    expect(mode.type).toBe("select");
    if (mode.type === "select") {
      expect(mode.default).toBe("level");
      expect(mode.options.map((o) => o.value)).toEqual(["level", "custom", "size"]);
    }

    // Level preset selector (the original three presets).
    const level = byId.level;
    expect(level.type).toBe("select");
    if (level.type === "select") {
      expect(level.default).toBe("Balanced");
      expect(level.options.map((o) => o.value)).toEqual(["Smaller", "Balanced", "Better"]);
    }

    // Custom explicit bitrate selector.
    const bitrate = byId.bitrate;
    expect(bitrate.type).toBe("select");
    if (bitrate.type === "select") {
      expect(bitrate.default).toBe("1500k");
      expect(bitrate.options.map((o) => o.value)).toEqual([
        "400k", "600k", "800k", "1200k", "1500k", "2000k", "3000k", "5000k",
      ]);
    }

    // Target-size (MB) number control with its clamp bounds.
    const targetMb = byId.targetMb;
    expect(targetMb.type).toBe("number");
    if (targetMb.type === "number") {
      expect(targetMb.default).toBe(10);
      expect(targetMb.min).toBe(1);
      expect(targetMb.max).toBe(2000);
      expect(targetMb.unit).toBe("MB");
    }

    // Resolution-downscale selector — "keep" must be first/default (no -vf).
    const resolution = byId.resolution;
    expect(resolution.type).toBe("select");
    if (resolution.type === "select") {
      expect(resolution.default).toBe("keep");
      expect(resolution.options.map((o) => o.value)).toEqual(["keep", "1080", "720", "480"]);
    }
  });

  it("keeps the word 'bitrate' out of every user-facing option label (UI-copy policy)", () => {
    // The original policy banned "bitrate" from the level option labels. With the
    // expanded control set we keep the spirit and verify NO select option label in
    // ANY control surfaces the jargon word "bitrate" — the mode control says
    // "Custom rate", the rate control lists plain "<n>k" values, etc.
    const controls = compressVideoDescriptor.controls ?? [];
    for (const control of controls) {
      if (control.type !== "select") continue;
      for (const opt of control.options) {
        expect(opt.label.toLowerCase()).not.toContain("bitrate");
      }
    }
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      "image.png",
      { type: "image/png" },
    );
    await expect(compressVideoDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(compressVideoDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .mp4 extension past the MIME gate", async () => {
    // A .mp4 extension + empty MIME passes the gate; CANCELLED fires before engine load.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      compressVideoDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      compressVideoDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full libopenh264 + AAC re-encode pipeline against a real MP4 fixture
  // when a browser env is wired up.
  // NOTE: verify in browser that libopenh264 + AAC at 128k produce a playable MP4
  // at each level (Smaller/Balanced/Better), and that output sizes decrease from
  // Better → Balanced → Smaller relative to the source.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "compresses a real MP4 (happy path)",
    async () => {
      await compressVideoDescriptor.loadEngine!();

      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await compressVideoDescriptor.convert({
        file,
        options: { level: "Balanced" },
      });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("clip.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("video/mp4");
    },
  );
});

// ── Pure helper: resolveVideoBitrate ─────────────────────────────────────────
// These run for real in Node — no DOM, no Worker, no ffmpeg.
describe("resolveVideoBitrate", () => {
  it("maps each level preset to its bitrate in level mode", () => {
    expect(resolveVideoBitrate({ mode: "level", level: "Smaller" })).toBe("800k");
    expect(resolveVideoBitrate({ mode: "level", level: "Balanced" })).toBe("1500k");
    expect(resolveVideoBitrate({ mode: "level", level: "Better" })).toBe("3000k");
  });

  it("defaults to Balanced (1500k) when mode/level are absent or invalid", () => {
    expect(resolveVideoBitrate({})).toBe("1500k");
    expect(resolveVideoBitrate({ mode: "level", level: "Nonsense" })).toBe("1500k");
    expect(resolveVideoBitrate({ mode: "bogus" })).toBe("1500k");
  });

  it("returns the explicit bitrate in custom mode, clamping unknown values to the default", () => {
    expect(resolveVideoBitrate({ mode: "custom", bitrate: "5000k" })).toBe("5000k");
    expect(resolveVideoBitrate({ mode: "custom", bitrate: "400k" })).toBe("400k");
    // An off-list value falls back to the Balanced-matching default (1500k).
    expect(resolveVideoBitrate({ mode: "custom", bitrate: "999k" })).toBe("1500k");
    expect(resolveVideoBitrate({ mode: "custom" })).toBe("1500k");
  });

  it("derives the bitrate from target size + duration in size mode", () => {
    // 10 MB over 60s: (10*8*1024*1024 - 128000*60)/60 ≈ 1,270,101 bps → "1270k".
    expect(resolveVideoBitrate({ mode: "size", targetMb: 10 }, { duration: 60 })).toBe("1270k");
    // No duration available → degrade to the Balanced bitrate, never a nonsense rate.
    expect(resolveVideoBitrate({ mode: "size", targetMb: 10 }, { duration: 0 })).toBe("1500k");
    expect(resolveVideoBitrate({ mode: "size", targetMb: 10 })).toBe("1500k");
  });
});

// ── Pure helper: targetSizeVideoBitrate ──────────────────────────────────────
describe("targetSizeVideoBitrate", () => {
  it("computes the kbit rate from the MB budget minus the audio reservation", () => {
    // budget=10MB=83,886,080 bits; audio=128k*60=7,680,000; video/s≈1,270,101 → 1270k.
    expect(targetSizeVideoBitrate(10, 60)).toBe("1270k");
    // A bigger budget over the same clip yields a proportionally higher rate.
    // 50MB: (50*8*1024*1024 - 7,680,000)/60 ≈ 6,862,507 bps → round(6862.507)k → "6863k".
    expect(targetSizeVideoBitrate(50, 60)).toBe("6863k");
  });

  it("falls back to the Balanced bitrate when duration is unknown or non-positive", () => {
    expect(targetSizeVideoBitrate(10, 0)).toBe("1500k");
    expect(targetSizeVideoBitrate(10, -5)).toBe("1500k");
    expect(targetSizeVideoBitrate(10, NaN)).toBe("1500k");
    expect(targetSizeVideoBitrate(10, Infinity)).toBe("1500k");
  });

  it("clamps to the 150k floor when a tiny budget on a long clip would underflow", () => {
    // 1MB across 600s: budget is smaller than the audio reservation → negative,
    // clamped up to the 150,000 bps floor → "150k".
    expect(targetSizeVideoBitrate(1, 600)).toBe("150k");
  });

  it("clamps to the 50,000k (50 Mbps) ceiling for an absurdly large budget", () => {
    // 100,000MB over 1s would ask for ~800 Gbps → clamped down to the 50 Mbps ceiling.
    expect(targetSizeVideoBitrate(100000, 1)).toBe("50000k");
  });
});

// ── Pure helper: buildCompressArgs ───────────────────────────────────────────
describe("buildCompressArgs", () => {
  it("reproduces the original default args BYTE-FOR-BYTE with no options", () => {
    expect(buildCompressArgs()).toEqual(ORIGINAL_DEFAULT_ARGS);
    // And explicitly with the descriptor's own default options.
    expect(buildCompressArgs({ mode: "level", level: "Balanced", resolution: "keep" })).toEqual(
      ORIGINAL_DEFAULT_ARGS,
    );
  });

  it("emits NO -vf for keep, and emits scale=-2:<h> right after -i for a downscale", () => {
    const kept = buildCompressArgs({ resolution: "keep" });
    expect(kept).not.toContain("-vf");

    const scaled = buildCompressArgs({ resolution: "720" });
    expect(scaled).toEqual([
      "-i", "input.mp4",
      "-vf", "scale=-2:720",
      "-c:v", "libopenh264",
      "-b:v", "1500k",
      "-c:a", "aac",
      "-b:a", "128k",
      "output.mp4",
    ]);
    // The -vf must sit immediately after the input so the encoder sees scaled frames.
    expect(scaled.indexOf("-vf")).toBe(scaled.indexOf("-i") + 2);
    expect(scaled.indexOf("-vf")).toBeLessThan(scaled.indexOf("-c:v"));
  });

  it("uses the level bitrate in level mode (Smaller)", () => {
    expect(buildCompressArgs({ mode: "level", level: "Smaller" })).toEqual([
      "-i", "input.mp4",
      "-c:v", "libopenh264",
      "-b:v", "800k",
      "-c:a", "aac",
      "-b:a", "128k",
      "output.mp4",
    ]);
  });

  it("uses the explicit bitrate in custom mode and combines it with a downscale", () => {
    expect(buildCompressArgs({ mode: "custom", bitrate: "3000k", resolution: "480" })).toEqual([
      "-i", "input.mp4",
      "-vf", "scale=-2:480",
      "-c:v", "libopenh264",
      "-b:v", "3000k",
      "-c:a", "aac",
      "-b:a", "128k",
      "output.mp4",
    ]);
  });

  it("uses the duration-derived bitrate in size mode", () => {
    const args = buildCompressArgs({ mode: "size", targetMb: 10 }, { duration: 60 });
    expect(args).toEqual([
      "-i", "input.mp4",
      "-c:v", "libopenh264",
      "-b:v", "1270k",
      "-c:a", "aac",
      "-b:a", "128k",
      "output.mp4",
    ]);
    // Audio is always AAC at 128k regardless of mode, and output is last.
    expect(args.slice(-5)).toEqual(["-c:a", "aac", "-b:a", "128k", "output.mp4"]);
  });
});
