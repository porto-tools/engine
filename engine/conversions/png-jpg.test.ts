import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pngToJpgDescriptor, jpgToPngDescriptor, readBackground } from "./png-jpg";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// The happy path exercises createImageBitmap + canvas.toBlob, which exist only
// in a browser/DOM runtime. This repo's vitest runs in the default Node
// environment where those globals are undefined, so the real-conversion
// assertions are gated to run only when a canvas is present (mirrors the
// webp-jpg / image-converter suites). The error-path tests below need no
// canvas: UNSUPPORTED and CANCELLED short-circuit before decoding.
const CANVAS_AVAILABLE =
  typeof document !== "undefined" && typeof createImageBitmap !== "undefined";

describe("pngToJpgDescriptor", () => {
  it.runIf(CANVAS_AVAILABLE)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await pngToJpgDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(pngToJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt bytes as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.png", {
      type: "image/png",
    });
    await expect(pngToJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      pngToJpgDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("exposes a 10–100% quality slider defaulting to 92", () => {
    expect(pngToJpgDescriptor.controls?.find((c) => c.id === "quality")).toMatchObject({
      type: "range",
      min: 10,
      max: 100,
      default: 92,
      unit: "%",
    });
  });

  // The →JPG direction flattens transparency, so it offers a background picker.
  it("declares a background select (white default) for the JPG flatten", () => {
    const bg = pngToJpgDescriptor.controls?.find((c) => c.id === "background");
    expect(bg?.type).toBe("select");
    if (bg?.type === "select") {
      expect(bg.default).toBe("white");
      expect(bg.options.map((o) => o.value)).toEqual(["white", "black"]);
    }
    // Default seeds white so the out-of-the-box JPG fill is unchanged.
    expect(pngToJpgDescriptor.defaultOptions?.background).toBe("white");
  });
});

describe("jpgToPngDescriptor", () => {
  it.runIf(CANVAS_AVAILABLE)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.jpg", "image/jpeg");
    const result = await jpgToPngDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // PNG keeps alpha, so this direction must NOT flatten — it exposes no
  // background control and declares no controls at all.
  it("offers no background control because PNG output preserves transparency", () => {
    const bg = jpgToPngDescriptor.controls?.find((c) => c.id === "background");
    expect(bg).toBeUndefined();
    expect(jpgToPngDescriptor.defaultOptions?.background).toBeUndefined();
  });
});

// readBackground is pure (no DOM), so it gets full unit coverage independent of
// a canvas. It validates the chosen KEY → hex and falls back to white, which is
// what keeps an untrusted option from injecting an arbitrary CSS fill string.
describe("readBackground (png-jpg)", () => {
  it("maps the known keys to their hex colours", () => {
    expect(readBackground("white")).toBe("#ffffff");
    expect(readBackground("black")).toBe("#000000");
  });

  it("defaults to white (the previous hardcoded fill) for missing values", () => {
    expect(readBackground(undefined)).toBe("#ffffff");
  });

  it("falls back to white for unknown or non-string values (no arbitrary CSS injection)", () => {
    expect(readBackground("rebeccapurple")).toBe("#ffffff");
    expect(readBackground("javascript:alert(1)")).toBe("#ffffff");
    expect(readBackground(42)).toBe("#ffffff");
    expect(readBackground(null)).toBe("#ffffff");
  });
});
