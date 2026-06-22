import { describe, it, expect } from "vitest";
import { videoCropDescriptor, resolveCropGeometry } from "./video-crop";

const MAX_CROP_PX = 8192;

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The video-crop pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("videoCropDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(videoCropDescriptor.id).toBe("video-crop");
    expect(videoCropDescriptor.fromLabel).toBe("MP4");
    expect(videoCropDescriptor.toLabel).toBe("Cropped MP4");
    expect(videoCropDescriptor.newExtension).toBe("mp4");
    expect(videoCropDescriptor.accept).toContain("video/mp4");
    expect(typeof videoCropDescriptor.loadEngine).toBe("function");
    expect(typeof videoCropDescriptor.setupSizeLabel).toBe("string");
    expect(videoCropDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("declares no descriptor controls — the custom crop box drives the options", () => {
    // The crop-video page renders a visual CropBox that emits cropX/cropY/cropW/
    // cropH as options, so the descriptor exposes no generic controls. The
    // crop defaults stay on defaultOptions as the engine-side fallback.
    expect(videoCropDescriptor.controls).toBeUndefined();
    expect(videoCropDescriptor.defaultOptions).toMatchObject({
      cropW: 640,
      cropH: 480,
      cropX: 0,
      cropY: 0,
    });
  });

  describe("resolveCropGeometry — upper clamp", () => {
    it("falls back to the defaults when options are missing", () => {
      expect(resolveCropGeometry()).toEqual({ w: 640, h: 480, x: 0, y: 0 });
    });

    it("clamps an oversized width/height down to MAX_CROP_PX", () => {
      const { w, h } = resolveCropGeometry({ cropW: 999_999, cropH: 50_000 });
      expect(w).toBe(MAX_CROP_PX);
      expect(h).toBe(MAX_CROP_PX);
    });

    it("clamps oversized x/y offsets and keeps x+w / y+h inside the frame cap", () => {
      const { w, h, x, y } = resolveCropGeometry({
        cropW: 999_999,
        cropH: 999_999,
        cropX: 999_999,
        cropY: 999_999,
      });
      // Each axis caps at MAX_CROP_PX, and the offset is pulled in so the crop
      // rectangle never extends past the cap.
      expect(w).toBe(MAX_CROP_PX);
      expect(h).toBe(MAX_CROP_PX);
      expect(x + w).toBeLessThanOrEqual(MAX_CROP_PX);
      expect(y + h).toBeLessThanOrEqual(MAX_CROP_PX);
    });

    it("leaves sane in-range geometry untouched (beyond the even-flooring rule)", () => {
      expect(resolveCropGeometry({ cropW: 320, cropH: 240, cropX: 10, cropY: 20 })).toEqual({
        w: 320,
        h: 240,
        x: 10,
        y: 20,
      });
      // Odd dimensions floor to the nearest even (existing toEven behaviour).
      expect(resolveCropGeometry({ cropW: 321, cropH: 241 })).toMatchObject({ w: 320, h: 240 });
    });
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(videoCropDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(videoCropDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME .mp4 file past the MIME gate (abort before engine load → CANCELLED)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      videoCropDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      videoCropDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (crop filter + H.264 re-encode) against
  // a real MP4 fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "crops a real MP4 (happy path)",
    async () => {
      await videoCropDescriptor.loadEngine!();

      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await videoCropDescriptor.convert({
        file,
        options: { cropW: 320, cropH: 240, cropX: 0, cropY: 0 },
      });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("clip.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});
