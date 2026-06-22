import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webpPngDescriptor, pngWebpDescriptor } from "./webp-png";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// The happy-path cases exercise real Canvas APIs (createImageBitmap +
// canvas.toBlob), which only exist in a browser-like environment. vitest runs
// under Node here (see vitest.config.ts), where those globals are undefined, so
// these two cases skip locally and run for real once a browser/canvas test
// environment is in place. The fixtures are committed and validated regardless,
// and the rejection/cancellation cases below run in Node unconditionally.
const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("webpPngDescriptor", () => {
  it.skipIf(!canvasAvailable)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.webp", "image/webp");
    const result = await webpPngDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(webpPngDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt bytes as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.webp", {
      type: "image/webp",
    });
    await expect(webpPngDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.webp", "image/webp");
    await expect(
      webpPngDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("pngWebpDescriptor", () => {
  it.skipIf(!canvasAvailable)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await pngWebpDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("tiny.webp");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(pngWebpDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt bytes as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.png", {
      type: "image/png",
    });
    await expect(pngWebpDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      pngWebpDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("exposes a 10–100% quality slider defaulting to 92", () => {
    expect(pngWebpDescriptor.controls?.find((c) => c.id === "quality")).toMatchObject({
      type: "range",
      min: 10,
      max: 100,
      default: 92,
      unit: "%",
    });
  });
});
