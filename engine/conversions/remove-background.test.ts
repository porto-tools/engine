import { describe, it, expect } from "vitest";
import { removeBackgroundDescriptor, computeLetterbox } from "./remove-background";

// MODNet's canonical input side. Kept private in the module; mirrored here so the
// letterbox geometry assertions read against a concrete square.
const MODEL_SIDE = 512;

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The background-removal pipeline requires:
//   1. onnxruntime-web's WASM backend (runs in browser; needs the self-hosted
//      /ort/ runtime + /models/modnet.onnx served over HTTP)
//   2. createImageBitmap — not available in plain Node
//   3. document.createElement("canvas") + getContext("2d") — not in plain Node
//
// TODO(test-env): wire up a browser/canvas test environment (e.g. vitest's
// browser mode) so the happy path (real inference + composite) can run in CI.
// Until then it is skipped via it.skipIf. UNSUPPORTED_INPUT and CANCELLED both
// throw BEFORE any WASM/Canvas/model call, so they run unconditionally.
const canvasAvailable =
  typeof document !== "undefined" &&
  typeof document.createElement === "function" &&
  typeof createImageBitmap === "function" &&
  (() => {
    try {
      return document.createElement("canvas").getContext("2d") !== null;
    } catch {
      return false;
    }
  })();

describe("removeBackgroundDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(removeBackgroundDescriptor.id).toBe("remove-background");
    expect(removeBackgroundDescriptor.fromLabel).toBe("Image");
    expect(removeBackgroundDescriptor.toLabel).toBe("Cutout PNG");
    expect(removeBackgroundDescriptor.newExtension).toBe("png");
    expect(removeBackgroundDescriptor.accept).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    // It is an AI/WASM tool, so it must declare loadEngine + a setup size label.
    expect(typeof removeBackgroundDescriptor.loadEngine).toBe("function");
    expect(typeof removeBackgroundDescriptor.setupSizeLabel).toBe("string");
    // Auto-on-drop: no controls, single input/output (defaults by absence).
    expect(removeBackgroundDescriptor.controls).toBeUndefined();
    expect(removeBackgroundDescriptor.inputMode).toBeUndefined();
    expect(removeBackgroundDescriptor.outputMode).toBeUndefined();
  });

  it("rejects an unsupported file type as UNSUPPORTED_INPUT", async () => {
    // A GIF is not in the accept list — must be rejected before any model load.
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "anim.gif", {
      type: "image/gif",
    });
    await expect(removeBackgroundDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "mystery.bin", { type: "" });
    await expect(removeBackgroundDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "photo.png", {
      type: "image/png",
    });
    await expect(
      removeBackgroundDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs a real browser (WASM backend + Canvas + the served
  // /ort/ runtime and /models/modnet.onnx). Skipped in the Node test env.
  it.skipIf(!canvasAvailable)(
    "removes the background and returns a transparent PNG (happy path)",
    async () => {
      await removeBackgroundDescriptor.loadEngine!();

      // A tiny solid-colour PNG suffices to exercise the full pipeline shape.
      const res = await fetch("/models/modnet.onnx"); // sanity: model is served
      expect(res.ok).toBe(true);

      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3366cc";
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), "image/png"),
      );
      const file = new File([blob], "portrait.png", { type: "image/png" });

      const result = await removeBackgroundDescriptor.convert({ file });
      expect(result.mimeType).toBe("image/png");
      expect(result.filename).toBe("portrait.png");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});

// The letterbox is the heart of the non-square quality fix: the source is drawn
// "contain" + centered into the square model canvas, and the matte is later
// cropped back through THIS SAME box. If the geometry drifts, the alpha no longer
// lines up with the original pixels — so the contain-fit math is pinned here.
describe("computeLetterbox", () => {
  it("fills the whole square for a square image (no padding)", () => {
    const box = computeLetterbox(1000, 1000);
    expect(box).toEqual({
      drawW: MODEL_SIDE,
      drawH: MODEL_SIDE,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("letterboxes a landscape image with vertical padding only", () => {
    // 2:1 landscape → width fills the square, height is half, centered vertically.
    const box = computeLetterbox(1000, 500);
    expect(box.drawW).toBe(MODEL_SIDE); // long edge fills the square
    expect(box.offsetX).toBe(0); // no horizontal padding
    expect(box.drawH).toBe(MODEL_SIDE / 2); // short edge is contain-scaled
    // Padding splits evenly top/bottom and stays inside the canvas.
    expect(box.offsetY).toBe((MODEL_SIDE - box.drawH) / 2);
    expect(box.offsetY * 2 + box.drawH).toBeLessThanOrEqual(MODEL_SIDE);
  });

  it("letterboxes a portrait image with horizontal padding only", () => {
    // 1:2 portrait → height fills the square, width is half, centered horizontally.
    const box = computeLetterbox(500, 1000);
    expect(box.drawH).toBe(MODEL_SIDE);
    expect(box.offsetY).toBe(0);
    expect(box.drawW).toBe(MODEL_SIDE / 2);
    expect(box.offsetX).toBe((MODEL_SIDE - box.drawW) / 2);
  });

  it("preserves the source aspect ratio within rounding", () => {
    // A non-integer ratio: the drawn box must keep ~3:2 and never exceed the canvas.
    const box = computeLetterbox(1200, 800);
    expect(box.drawW).toBeLessThanOrEqual(MODEL_SIDE);
    expect(box.drawH).toBeLessThanOrEqual(MODEL_SIDE);
    expect(box.offsetX + box.drawW).toBeLessThanOrEqual(MODEL_SIDE);
    expect(box.offsetY + box.drawH).toBeLessThanOrEqual(MODEL_SIDE);
    // 3:2 source → drawn ratio within one pixel of 1.5.
    expect(Math.abs(box.drawW / box.drawH - 1.5)).toBeLessThan(0.02);
  });

  it("keeps a tiny image inside the canvas (degenerate dimensions stay ≥ 1px)", () => {
    const box = computeLetterbox(1, 1);
    expect(box.drawW).toBeGreaterThanOrEqual(1);
    expect(box.drawH).toBeGreaterThanOrEqual(1);
    expect(box.offsetX + box.drawW).toBeLessThanOrEqual(MODEL_SIDE);
    expect(box.offsetY + box.drawH).toBeLessThanOrEqual(MODEL_SIDE);
  });
});
