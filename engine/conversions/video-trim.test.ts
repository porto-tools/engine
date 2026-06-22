import { describe, it, expect } from "vitest";
import { videoTrimDescriptor } from "./video-trim";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The video-trim pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("videoTrimDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(videoTrimDescriptor.id).toBe("video-trim");
    expect(videoTrimDescriptor.fromLabel).toBe("MP4");
    expect(videoTrimDescriptor.toLabel).toBe("Trimmed MP4");
    expect(videoTrimDescriptor.newExtension).toBe("mp4");
    expect(videoTrimDescriptor.accept).toContain("video/mp4");
    // loadEngine is required for the WASM-backed MT conversion.
    expect(typeof videoTrimDescriptor.loadEngine).toBe("function");
    expect(typeof videoTrimDescriptor.setupSizeLabel).toBe("string");
    expect(videoTrimDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("declares one time-range control whose id fans out to trimStart/trimEnd", () => {
    expect(videoTrimDescriptor.controls).toHaveLength(1);
    const [trim] = videoTrimDescriptor.controls!;
    expect(trim.type).toBe("time-range");
    // The control id is "trim"; the seconds option keys are `${id}Start`/`${id}End`.
    expect(trim.id).toBe("trim");
    expect(`${trim.id}Start`).toBe("trimStart");
    expect(`${trim.id}End`).toBe("trimEnd");
  });

  it("defaults trimStart/trimEnd to numeric-seconds 0", () => {
    expect(videoTrimDescriptor.defaultOptions).toMatchObject({ trimStart: 0, trimEnd: 0 });
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(videoTrimDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(videoTrimDescriptor.convert({ file })).rejects.toMatchObject({
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
      videoTrimDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      videoTrimDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (-ss/-to/-c copy) against a real
  // MP4 fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "trims a real MP4 (happy path)",
    async () => {
      await videoTrimDescriptor.loadEngine!();

      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await videoTrimDescriptor.convert({
        file,
        options: { trimStart: 0, trimEnd: 5 },
      });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("clip.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});
