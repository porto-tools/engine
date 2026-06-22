import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webpJpgDescriptor, jpgWebpDescriptor, readBackground } from "./webp-jpg";

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
// and CANCELLED short-circuit before decoding, and DECODE_FAILED is reached
// either way (corrupt bytes in a browser, the missing decoder in Node).
const CANVAS_AVAILABLE =
  typeof document !== "undefined" && typeof createImageBitmap !== "undefined";

describe("webpJpgDescriptor", () => {
  it.runIf(CANVAS_AVAILABLE)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.webp", "image/webp");
    const result = await webpJpgDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(webpJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt bytes as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.webp", {
      type: "image/webp",
    });
    await expect(webpJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.webp", "image/webp");
    await expect(
      webpJpgDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("exposes a 10–100% quality slider defaulting to 92", () => {
    expect(webpJpgDescriptor.controls?.find((c) => c.id === "quality")).toMatchObject({
      type: "range",
      min: 10,
      max: 100,
      default: 92,
      unit: "%",
    });
  });

  // The →JPG direction flattens transparency, so it offers a background picker.
  it("declares a background select (white default) for the JPG flatten", () => {
    const bg = webpJpgDescriptor.controls?.find((c) => c.id === "background");
    expect(bg?.type).toBe("select");
    if (bg?.type === "select") {
      expect(bg.default).toBe("white");
      expect(bg.options.map((o) => o.value)).toEqual(["white", "black"]);
    }
    // Default seeds white so the out-of-the-box JPG fill is unchanged.
    expect(webpJpgDescriptor.defaultOptions?.background).toBe("white");
  });
});

describe("jpgWebpDescriptor", () => {
  it.runIf(CANVAS_AVAILABLE)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.jpg", "image/jpeg");
    const result = await jpgWebpDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("tiny.webp");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(jpgWebpDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt bytes as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.jpg", {
      type: "image/jpeg",
    });
    await expect(jpgWebpDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.jpg", "image/jpeg");
    await expect(
      jpgWebpDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("exposes a 10–100% quality slider defaulting to 92", () => {
    expect(jpgWebpDescriptor.controls?.find((c) => c.id === "quality")).toMatchObject({
      type: "range",
      min: 10,
      max: 100,
      default: 92,
      unit: "%",
    });
  });

  // WEBP keeps alpha, so this direction must NOT flatten — no background control.
  it("offers no background control because WEBP output preserves transparency", () => {
    const bg = jpgWebpDescriptor.controls?.find((c) => c.id === "background");
    expect(bg).toBeUndefined();
    expect(jpgWebpDescriptor.defaultOptions?.background).toBeUndefined();
  });
});

// readBackground is pure (no DOM), so it gets full unit coverage independent of
// a canvas. It validates the chosen KEY → hex and falls back to white, which is
// what keeps an untrusted option from injecting an arbitrary CSS fill string.
describe("readBackground (webp-jpg)", () => {
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
