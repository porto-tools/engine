import { describe, it, expect } from "vitest";
import { mp4GifDescriptor, buildGifFilter } from "./mp4-gif";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The MP4→GIF conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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
// they run for real.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function" &&
  typeof globalThis.crossOriginIsolated !== "undefined" &&
  globalThis.crossOriginIsolated === true;

describe("buildGifFilter", () => {
  // The exact filter the route shipped before quality controls existed, extended
  // only with the new defaults: palettegen=max_colors=128 and paletteuse=dither=bayer.
  const DEFAULT_FILTER =
    "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];" +
    "[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer";

  it("default opts reproduce the original filter (plus max_colors/dither defaults)", () => {
    expect(buildGifFilter()).toBe(DEFAULT_FILTER);
    expect(buildGifFilter({})).toBe(DEFAULT_FILTER);
  });

  it("the default filter equals the original fixed graph with only max_colors/dither added", () => {
    // The pre-change fixed graph, kept verbatim here as the regression anchor.
    const ORIGINAL =
      "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse";
    const reconstructedOriginal = DEFAULT_FILTER.replace(
      "palettegen=max_colors=128",
      "palettegen",
    ).replace("paletteuse=dither=bayer", "paletteuse");
    expect(reconstructedOriginal).toBe(ORIGINAL);
  });

  it("builds the expected string from custom opts", () => {
    expect(
      buildGifFilter({ fps: 24, width: "640", colors: 256, dither: "sierra2_4a" }),
    ).toBe(
      "fps=24,scale=640:-1:flags=lanczos,split[s0][s1];" +
        "[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a",
    );
  });

  it("maps dither \"none\" to dither=none (not an empty value)", () => {
    expect(buildGifFilter({ dither: "none" })).toContain("paletteuse=dither=none");
  });

  it("clamps fps and colors to their ranges and rounds to integers", () => {
    expect(buildGifFilter({ fps: 1 })).toContain("fps=5,"); // below FPS_MIN
    expect(buildGifFilter({ fps: 999 })).toContain("fps=30,"); // above FPS_MAX
    expect(buildGifFilter({ fps: 17.6 })).toContain("fps=18,"); // rounded
    expect(buildGifFilter({ colors: 1 })).toContain("max_colors=32"); // below min
    expect(buildGifFilter({ colors: 9999 })).toContain("max_colors=256"); // above max
  });

  it("falls back to defaults for invalid / out-of-list values", () => {
    expect(buildGifFilter({ fps: "not-a-number", colors: NaN })).toBe(DEFAULT_FILTER);
    expect(buildGifFilter({ width: "1080", dither: "floyd_steinberg" })).toBe(DEFAULT_FILTER);
  });

  it("accepts numeric values supplied as strings (from control inputs)", () => {
    // Range controls may hand the option through as a string; readClampedInt coerces.
    expect(buildGifFilter({ fps: "20", colors: "64" })).toBe(
      "fps=20,scale=480:-1:flags=lanczos,split[s0][s1];" +
        "[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer",
    );
  });

  // ── height (A26) ──────────────────────────────────────────────────────────
  // height defaults to "auto", which keeps the width-driven scale=<width>:-1
  // graph byte-identical to the pre-A26 output (the regression anchor above
  // still passes because no `height` key means "auto").

  it("height \"auto\" leaves the width-driven scale unchanged (regression anchor)", () => {
    // Explicit auto must produce the exact same string as the default filter.
    expect(buildGifFilter({ height: "auto" })).toBe(DEFAULT_FILTER);
  });

  it("an explicit height switches the scale to -2:<height> (width becomes auto)", () => {
    expect(buildGifFilter({ height: "360" })).toBe(
      "fps=12,scale=-2:360:flags=lanczos,split[s0][s1];" +
        "[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
    );
    // The chosen height drives the scale; the width option is ignored when a
    // height is set (the two are mutually exclusive sizing modes).
    expect(buildGifFilter({ width: "640", height: "720" })).toContain(
      "scale=-2:720:flags=lanczos",
    );
  });

  it("an invalid height falls back to auto (width-driven scale)", () => {
    expect(buildGifFilter({ height: "1080" })).toBe(DEFAULT_FILTER);
    expect(buildGifFilter({ height: 360 })).toBe(DEFAULT_FILTER); // number, not in the string list
    expect(buildGifFilter({ height: "tall" })).toBe(DEFAULT_FILTER);
  });
});

describe("mp4GifDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(mp4GifDescriptor.id).toBe("mp4-to-gif");
    expect(mp4GifDescriptor.fromLabel).toBe("MP4");
    expect(mp4GifDescriptor.toLabel).toBe("GIF");
    expect(mp4GifDescriptor.newExtension).toBe("gif");
    expect(mp4GifDescriptor.accept).toContain("video/mp4");
    // loadEngine is required for the WASM-backed MT conversion.
    expect(typeof mp4GifDescriptor.loadEngine).toBe("function");
    expect(typeof mp4GifDescriptor.setupSizeLabel).toBe("string");
    // The MT core is larger than the ST core.
    expect(mp4GifDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("exposes the four quality controls with defaults matching the original filter", () => {
    const byId = Object.fromEntries(
      (mp4GifDescriptor.controls ?? []).map((c) => [c.id, c]),
    );

    const fps = byId.fps;
    expect(fps.type).toBe("range");
    if (fps.type === "range") {
      expect(fps.default).toBe(12);
      expect(fps.min).toBe(5);
      expect(fps.max).toBe(30);
      expect(fps.step).toBe(1);
    }

    const width = byId.width;
    expect(width.type).toBe("select");
    if (width.type === "select") {
      expect(width.default).toBe("480");
      expect(width.options.map((o) => o.value).sort()).toEqual(
        ["240", "320", "480", "640"].sort(),
      );
    }

    const colors = byId.colors;
    expect(colors.type).toBe("range");
    if (colors.type === "range") {
      expect(colors.default).toBe(128);
      expect(colors.min).toBe(32);
      expect(colors.max).toBe(256);
      expect(colors.step).toBe(32);
    }

    const dither = byId.dither;
    expect(dither.type).toBe("select");
    if (dither.type === "select") {
      expect(dither.default).toBe("bayer");
      expect(dither.options.map((o) => o.value)).toEqual(["bayer", "sierra2_4a", "none"]);
    }
  });

  // ── trim + loop + height controls (A26) ─────────────────────────────────────
  it("exposes the new trim, loop and height controls (A26)", () => {
    const byId = Object.fromEntries(
      (mp4GifDescriptor.controls ?? []).map((c) => [c.id, c]),
    );

    // TRIM: a visual time-range control (same kind video-trim.ts uses).
    const trim = byId.trim;
    expect(trim).toBeDefined();
    expect(trim.type).toBe("time-range");

    // LOOP: a select, default infinite ("0").
    const loop = byId.loop;
    expect(loop).toBeDefined();
    expect(loop.type).toBe("select");
    if (loop.type === "select") {
      expect(loop.default).toBe("0");
      expect(loop.options.map((o) => o.value)).toEqual(["0", "1", "3", "5"]);
    }

    // HEIGHT: a select, default "auto".
    const height = byId.height;
    expect(height).toBeDefined();
    expect(height.type).toBe("select");
    if (height.type === "select") {
      expect(height.default).toBe("auto");
      expect(height.options.map((o) => o.value).sort()).toEqual(
        ["240", "360", "480", "720", "auto"].sort(),
      );
    }
  });

  it("defaultOptions match the control defaults (so no-op options reproduce the original)", () => {
    // Backward-compatible defaults: the four shipped keys are byte-identical to
    // before, and the three new keys (trimStart/trimEnd, loop, height) default to
    // no-ops (trim 0/0 = whole clip, loop 0 = infinite GIF default, height auto =
    // width-driven scale).
    expect(mp4GifDescriptor.defaultOptions).toEqual({
      fps: 12,
      width: "480",
      colors: 128,
      dither: "bayer",
      trimStart: 0,
      trimEnd: 0,
      loop: "0",
      height: "auto",
    });
    expect(buildGifFilter(mp4GifDescriptor.defaultOptions)).toBe(
      "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];" +
        "[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
    );
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    // A PNG signature with image/png MIME — clearly not video.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(mp4GifDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(mp4GifDescriptor.convert({ file })).rejects.toMatchObject({
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
      mp4GifDescriptor.convert({ file, signal: ctrl.signal }),
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
      mp4GifDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED even with the new A26 options present", async () => {
    // Same as above but exercises the trim/loop/height option-reading path: the
    // converter must read these defensively before any FFmpeg call, so an
    // already-aborted signal still surfaces as CANCELLED.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      mp4GifDescriptor.convert({
        file,
        signal: ctrl.signal,
        options: { trimStart: 2, trimEnd: 8, loop: "3", height: "360" },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (palettegen/paletteuse filtergraph)
  // against a real MP4 fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real MP4 to GIF (happy path)",
    async () => {
      // Load the MT core first — the one-time setup moment.
      await mp4GifDescriptor.loadEngine!();

      // A minimal MP4 fixture (from __fixtures__) is enough to exercise the
      // decode → palettegen/paletteuse → GIF mux pipeline.
      // (In the browser env this fixture would be read from __fixtures__/clip.mp4.)
      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await mp4GifDescriptor.convert({ file });

      expect(result.mimeType).toBe("image/gif");
      expect(result.filename).toBe("clip.gif");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("image/gif");
    },
  );
});
