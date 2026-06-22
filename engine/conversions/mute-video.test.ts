import { describe, it, expect } from "vitest";
import { muteVideoDescriptor } from "./mute-video";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The mute-video pipeline requires the @ffmpeg/ffmpeg MT runtime, which:
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

describe("muteVideoDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(muteVideoDescriptor.id).toBe("mute-video");
    expect(muteVideoDescriptor.fromLabel).toBe("MP4");
    expect(muteVideoDescriptor.toLabel).toBe("Muted MP4");
    expect(muteVideoDescriptor.newExtension).toBe("mp4");
    expect(muteVideoDescriptor.accept).toContain("video/mp4");
    expect(typeof muteVideoDescriptor.loadEngine).toBe("function");
    expect(typeof muteVideoDescriptor.setupSizeLabel).toBe("string");
    // MT core.
    expect(muteVideoDescriptor.setupSizeLabel).toMatch(/26/);
    // No controls — auto-on-drop behavior.
    expect(muteVideoDescriptor.controls).toBeUndefined();
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(muteVideoDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(muteVideoDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .mp4 extension past the MIME gate", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      muteVideoDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      muteVideoDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in Node test env.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "mutes a real MP4 (happy path)",
    async () => {
      await muteVideoDescriptor.loadEngine!();
      const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });
      const result = await muteVideoDescriptor.convert({ file });
      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("clip.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("video/mp4");
    },
  );
});
