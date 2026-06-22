import { describe, it, expect } from "vitest";
import { gifMp4Descriptor } from "./gif-mp4";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The GIF→MP4 conversion pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("gifMp4Descriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(gifMp4Descriptor.id).toBe("gif-to-mp4");
    expect(gifMp4Descriptor.fromLabel).toBe("GIF");
    expect(gifMp4Descriptor.toLabel).toBe("MP4");
    expect(gifMp4Descriptor.newExtension).toBe("mp4");
    expect(gifMp4Descriptor.accept).toContain("image/gif");
    // loadEngine is required for the WASM-backed MT conversion.
    expect(typeof gifMp4Descriptor.loadEngine).toBe("function");
    expect(typeof gifMp4Descriptor.setupSizeLabel).toBe("string");
    // The MT core is shared with the other video routes.
    expect(gifMp4Descriptor.setupSizeLabel).toMatch(/26/);
  });

  it("rejects a non-GIF file as UNSUPPORTED_INPUT", async () => {
    // An MP4 file with video/mp4 MIME — clearly not a GIF.
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(gifMp4Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-GIF extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(gifMp4Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .gif extension past the MIME gate", async () => {
    // A file with a .gif extension and empty MIME should pass the MIME gate
    // and fail at the engine load (no runtime in Node), not at UNSUPPORTED_INPUT.
    const ctrl = new AbortController();
    ctrl.abort(); // abort before engine load so we get CANCELLED, not ENGINE_LOAD_FAILED
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "anim.gif", {
      type: "",
    });
    await expect(
      gifMp4Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Use image/gif MIME so it passes the MIME gate, then hits the abort check.
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "anim.gif", {
      type: "image/gif",
    });
    await expect(
      gifMp4Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (libopenh264 H.264 encode) against
  // a real GIF fixture when a browser env is wired up.
  // NOTE: this is the FIRST use of libopenh264 ENCODE — verify in browser that:
  //   1. libopenh264 is available in the MT WASM build
  //   2. yuv420p conversion from palette-indexed GIF succeeds
  //   3. output MP4 plays in Chrome/Firefox/Safari
  it.skipIf(!ffmpegRuntimeAvailable)(
    "converts a real GIF to MP4 (happy path)",
    async () => {
      // Load the MT core first — the one-time setup moment.
      await gifMp4Descriptor.loadEngine!();

      // GIF89a header bytes: GIF89a signature
      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const file = new File([gifBytes], "anim.gif", { type: "image/gif" });

      const result = await gifMp4Descriptor.convert({ file });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("anim.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("video/mp4");
    },
  );
});
