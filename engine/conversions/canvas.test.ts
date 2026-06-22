import { describe, it, expect } from "vitest";
import { assertSupported, decode, drawToCanvas, encode, getContext2D } from "./canvas";

// assertSupported is pure (no DOM): it guards the input MIME type and throws the
// canonical UNSUPPORTED_INPUT error, so it gets full Node coverage. The other
// primitives (decode/encode/drawToCanvas/getContext2D) touch createImageBitmap,
// canvas.toBlob, and getContext, which exist only in a browser/DOM runtime. This
// repo's vitest runs in the default Node environment where those globals are
// undefined, so those assertions are gated on a real canvas being present —
// mirroring png-jpg.test.ts's CANVAS_AVAILABLE gating.
const CANVAS_AVAILABLE =
  typeof document !== "undefined" && typeof createImageBitmap !== "undefined";

describe("assertSupported", () => {
  it("passes through when the file type is in the accept list", () => {
    const file = new File([new Uint8Array([0])], "ok.png", { type: "image/png" });
    expect(() => assertSupported(file, ["image/png"], "PNG")).not.toThrow();
  });

  it("accepts any of several allowed types", () => {
    const file = new File([new Uint8Array([0])], "ok.jpg", { type: "image/jpeg" });
    expect(() => assertSupported(file, ["image/jpeg", "image/jpg"], "JPG")).not.toThrow();
  });

  it("throws UNSUPPORTED_INPUT (non-recoverable) on the wrong type", () => {
    const file = new File([new Uint8Array([0])], "fake.bin", {
      type: "application/octet-stream",
    });
    expect(() => assertSupported(file, ["image/png"], "PNG")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_INPUT", recoverable: false }),
    );
  });

  it("includes the friendly label in the message", () => {
    const file = new File([new Uint8Array([0])], "fake.bin", { type: "" });
    expect(() => assertSupported(file, ["image/png"], "PNG")).toThrowError(
      /doesn't look like a PNG file/,
    );
  });
});

describe("decode", () => {
  it("rejects corrupt bytes as DECODE_FAILED (non-recoverable)", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "corrupt.png", {
      type: "image/png",
    });
    await expect(decode(file)).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });
});

describe("getContext2D / drawToCanvas (require a DOM canvas)", () => {
  it.runIf(CANVAS_AVAILABLE)("returns a 2D context for a fresh canvas", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    expect(getContext2D(canvas)).toBeTruthy();
  });

  it.runIf(CANVAS_AVAILABLE)("draws a bitmap onto a sized canvas", async () => {
    const src = document.createElement("canvas");
    src.width = 2;
    src.height = 3;
    const bitmap = await createImageBitmap(src);
    const out = drawToCanvas(bitmap);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    bitmap.close();
  });

  it.runIf(CANVAS_AVAILABLE)("encodes a canvas to a Blob", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const blob = await encode(canvas, "image/png");
    expect(blob.size).toBeGreaterThan(0);
  });
});
