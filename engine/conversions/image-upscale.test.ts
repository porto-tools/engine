import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { imageUpscaleDescriptor, clampScale, resolveOutputMime } from "./image-upscale";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// The happy path exercises createImageBitmap + canvas.toBlob, which exist only
// in a browser/DOM runtime. This repo's vitest runs in the default Node
// environment (see vitest.config.ts) where those globals are undefined, so the
// real-conversion assertions are gated to run only when a DOM is present (e.g.
// vitest browser mode). The error-path tests below need no canvas: UNSUPPORTED
// and CANCELLED short-circuit before decoding.
const CANVAS_AVAILABLE =
  typeof document !== "undefined" && typeof createImageBitmap !== "undefined";

describe("imageUpscaleDescriptor", () => {
  it.runIf(CANVAS_AVAILABLE)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageUpscaleDescriptor.convert({ file, options: { scale: "2" } });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageUpscaleDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageUpscaleDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("exposes a scale select defaulting to 2x", () => {
    expect(imageUpscaleDescriptor.controls?.find((c) => c.id === "scale")).toMatchObject({
      type: "select",
      default: "2",
    });
  });

  it("exposes a sharpen checkbox defaulting to false", () => {
    expect(imageUpscaleDescriptor.controls?.find((c) => c.id === "sharpen")).toMatchObject({
      type: "checkbox",
      default: false,
    });
  });

  it("exposes a format select defaulting to same", () => {
    expect(imageUpscaleDescriptor.controls?.find((c) => c.id === "format")).toMatchObject({
      type: "select",
      default: "same",
    });
  });
});

describe("clampScale", () => {
  it("accepts the allowed 0.5-step factors", () => {
    expect(clampScale("1.5")).toBe(1.5);
    expect(clampScale("2")).toBe(2);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale("3")).toBe(3);
    expect(clampScale(3.5)).toBe(3.5);
    expect(clampScale(4)).toBe(4);
  });

  it("snaps near-misses to the nearest allowed half-step", () => {
    expect(clampScale(2.4)).toBe(2.5);
    expect(clampScale(2.6)).toBe(2.5);
    expect(clampScale("3.2")).toBe(3);
  });

  it("falls back to 2 for missing, non-numeric, or out-of-range values", () => {
    expect(clampScale(undefined)).toBe(2);
    expect(clampScale("nope")).toBe(2);
    expect(clampScale(1)).toBe(2);
    expect(clampScale(5)).toBe(2);
  });
});

describe("resolveOutputMime", () => {
  it('keeps the input codec for "same" (and unknown choices)', () => {
    expect(resolveOutputMime("same", "image/png")).toEqual({ mimeType: "image/png", extension: "png" });
    expect(resolveOutputMime("same", "image/jpeg")).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
    expect(resolveOutputMime("same", "image/webp")).toEqual({ mimeType: "image/webp", extension: "webp" });
    expect(resolveOutputMime(undefined, "image/webp")).toEqual({ mimeType: "image/webp", extension: "webp" });
  });

  it("normalises the non-standard image/jpg input MIME", () => {
    expect(resolveOutputMime("same", "image/jpg")).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
  });

  it("forces the chosen codec when not same", () => {
    expect(resolveOutputMime("png", "image/jpeg")).toEqual({ mimeType: "image/png", extension: "png" });
    expect(resolveOutputMime("jpg", "image/png")).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
    expect(resolveOutputMime("webp", "image/png")).toEqual({ mimeType: "image/webp", extension: "webp" });
  });
});
