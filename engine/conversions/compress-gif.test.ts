import { describe, it, expect } from "vitest";
import { compressGifDescriptor } from "./compress-gif";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The compress-gif pipeline requires the @ffmpeg/ffmpeg runtime, which:
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

describe("compressGifDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(compressGifDescriptor.id).toBe("compress-gif");
    expect(compressGifDescriptor.fromLabel).toBe("GIF");
    expect(compressGifDescriptor.toLabel).toBe("Compressed");
    expect(compressGifDescriptor.newExtension).toBe("gif");
    expect(compressGifDescriptor.accept).toContain("image/gif");
    // loadEngine required for the WASM-backed MT conversion.
    expect(typeof compressGifDescriptor.loadEngine).toBe("function");
    expect(typeof compressGifDescriptor.setupSizeLabel).toBe("string");
    expect(compressGifDescriptor.setupSizeLabel).toMatch(/26/);
    // Parameterized: carries a level select control.
    expect(compressGifDescriptor.controls).toHaveLength(1);
    const control = compressGifDescriptor.controls![0];
    expect(control.type).toBe("select");
    expect(control.id).toBe("level");
    if (control.type === "select") {
      expect(control.options.map((o) => o.value)).toEqual(["Smaller", "Balanced", "Better"]);
      expect(control.default).toBe("Balanced");
    }
  });

  it("rejects a non-GIF file as UNSUPPORTED_INPUT", async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      "image.png",
      { type: "image/png" },
    );
    await expect(compressGifDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-GIF extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(compressGifDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME file with .gif extension past the MIME gate", async () => {
    // A .gif extension + empty MIME passes the gate; CANCELLED fires before engine load.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "anim.gif", {
      type: "",
    });
    await expect(
      compressGifDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "anim.gif", {
      type: "image/gif",
    });
    await expect(
      compressGifDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full palettegen/paletteuse compression pipeline against a real GIF
  // fixture when a browser env is wired up.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "compresses a real GIF (happy path)",
    async () => {
      await compressGifDescriptor.loadEngine!();

      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const file = new File([gifBytes], "anim.gif", { type: "image/gif" });

      const result = await compressGifDescriptor.convert({
        file,
        options: { level: "Balanced" },
      });

      expect(result.mimeType).toBe("image/gif");
      expect(result.filename).toBe("anim.gif");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
      expect(result.blob.type).toBe("image/gif");
    },
  );
});
