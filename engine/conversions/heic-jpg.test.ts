import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { heicJpgDescriptor } from "./heic-jpg";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "heic-jpg", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The HEIC conversion pipeline requires:
//   1. libheif-js WASM (runs in Node but needs canvas for pixel rendering)
//   2. document.createElement("canvas") — not available in plain Node
//   3. canvas.getContext("2d").createImageData — not available in plain Node
//
// TODO(test-env): wire up a browser/canvas test environment (e.g. vitest's
// browser mode or happy-dom + node-canvas) so the happy path can run in CI.
// Until then, the happy path is skipped via it.skipIf. UNSUPPORTED_INPUT and
// CANCELLED both throw before any WASM/Canvas call, so they run unconditionally.
const canvasAvailable =
  typeof document !== "undefined" &&
  typeof document.createElement === "function" &&
  (() => {
    try {
      return document.createElement("canvas").getContext("2d") !== null;
    } catch {
      return false;
    }
  })();

// The descriptor declares `loadEngine`, so loadEngine must run before
// converting. In a browser environment we call it in the happy-path test.

describe("heicJpgDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(heicJpgDescriptor.id).toBe("heic-to-jpg");
    expect(heicJpgDescriptor.fromLabel).toBe("HEIC");
    expect(heicJpgDescriptor.toLabel).toBe("JPG");
    expect(heicJpgDescriptor.newExtension).toBe("jpg");
    expect(heicJpgDescriptor.accept).toContain("image/heic");
    expect(heicJpgDescriptor.accept).toContain("image/heif");
    // loadEngine is required for WASM-backed conversions
    expect(typeof heicJpgDescriptor.loadEngine).toBe("function");
  });

  // TODO(test-env): needs real Canvas + WASM; skipped in the Node test env.
  it.skipIf(!canvasAvailable)("converts a real HEIC to JPG (happy path)", async () => {
    // Load the WASM engine first — this is the one-time setup moment.
    await heicJpgDescriptor.loadEngine!();

    const file = await fileFromFixture("rainbow.heic", "image/heic");
    const result = await heicJpgDescriptor.convert({ file });

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("rainbow.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);
    // The HEIC is a real colour image — the JPG output should be substantial.
    expect(result.blob.size).toBeGreaterThan(1000);
  });

  it("rejects a non-HEIC file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(heicJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-HEIC extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(heicJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // The core bug fix: non-Apple browsers report a real .heic photo with an empty
  // or generic MIME type. Each of these must pass the type gate (and then fail
  // only because loadEngine hasn't run / the bytes are stubs), NEVER as
  // UNSUPPORTED_INPUT. We assert .not UNSUPPORTED_INPUT so the test is robust to
  // whether it lands on ENGINE_LOAD_FAILED or DECODE_FAILED next.
  const unknownMimeHeicNames: Array<[string, string, string]> = [
    ["empty MIME (Chrome/Firefox drop)", "photo.heic", ""],
    ["generic octet-stream MIME", "IMG_4021.HEIC", "application/octet-stream"],
    ["empty MIME .heif extension", "render.heif", ""],
  ];
  for (const [label, name, mime] of unknownMimeHeicNames) {
    it(`accepts a HEIC by extension when the browser is unsure of the type — ${label}`, async () => {
      const file = new File([new Uint8Array([0, 0, 0, 0])], name, { type: mime });
      await expect(heicJpgDescriptor.convert({ file })).rejects.not.toMatchObject({
        code: "UNSUPPORTED_INPUT",
      });
    });
  }

  it("accepts the standard HEIC sequence MIME type", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "burst.heic", {
      type: "image/heic-sequence",
    });
    await expect(heicJpgDescriptor.convert({ file })).rejects.not.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    });
  });

  it("rejects a file the browser positively identified as PNG even if named .heic", async () => {
    // A real PNG the user renamed to .heic: the browser DID identify it, so we
    // trust the MIME over the misleading extension and reject up front rather
    // than handing libheif bytes it cannot decode.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "actually.heic", {
      type: "image/png",
    });
    await expect(heicJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // TODO(test-env): requires WASM + Canvas to reach the DECODE_FAILED path.
  // The decoder returns [] for corrupt bytes (not a throw), so the DECODE_FAILED
  // branch fires only after arrayBuffer() + decoder.decode(), which needs WASM.
  it.skipIf(!canvasAvailable)("rejects corrupt HEIC bytes as DECODE_FAILED", async () => {
    await heicJpgDescriptor.loadEngine!();
    // Bytes that look like a HEIC container header but are truncated/corrupt.
    const corrupt = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    ]);
    const file = new File([corrupt], "corrupt.heic", { type: "image/heic" });
    await expect(heicJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0, 0, 0, 0])], "photo.heic", {
      type: "image/heic",
    });
    await expect(
      heicJpgDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
