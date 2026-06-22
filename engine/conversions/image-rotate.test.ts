// Tests for image-rotate. Happy path is guarded by canvasAvailable.
// UNSUPPORTED_INPUT, CANCELLED, and parseRotateAngle are tested unconditionally.
//
// TODO(test-env): remove the skipIf guard once a browser/canvas environment is
// available in CI.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { imageRotateDescriptor, parseRotateAngle, rotatedBounds } from "./image-rotate";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageRotateDescriptor", () => {
  it("declares the parameterized descriptor fields", () => {
    expect(imageRotateDescriptor.id).toBe("image-rotate");
    expect(imageRotateDescriptor.accept).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(imageRotateDescriptor.controls).toHaveLength(1);
    const ctrl = imageRotateDescriptor.controls![0];
    expect(ctrl.type).toBe("angle");
    expect(ctrl.id).toBe("angle");
    expect(imageRotateDescriptor.loadEngine).toBeUndefined();
  });

  // TODO(test-env): run in browser/canvas env.
  it.skipIf(!canvasAvailable)("rotates by an angle and produces a fresh file", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageRotateDescriptor.convert({
      file,
      options: { angle: 90 },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageRotateDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageRotateDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("parseRotateAngle", () => {
  it("passes through angles already in [0, 360)", () => {
    expect(parseRotateAngle(0)).toBe(0);
    expect(parseRotateAngle(45)).toBe(45);
    expect(parseRotateAngle(90)).toBe(90);
    expect(parseRotateAngle(270)).toBe(270);
    expect(parseRotateAngle(359)).toBe(359);
  });

  it("coerces numeric strings", () => {
    expect(parseRotateAngle("90")).toBe(90);
    expect(parseRotateAngle("180")).toBe(180);
    expect(parseRotateAngle("12.5")).toBe(12.5);
  });

  it("normalizes out-of-range angles via ((n % 360) + 360) % 360", () => {
    expect(parseRotateAngle(360)).toBe(0);
    expect(parseRotateAngle(450)).toBe(90);
    expect(parseRotateAngle(720)).toBe(0);
    expect(parseRotateAngle(-90)).toBe(270);
    expect(parseRotateAngle(-360)).toBe(0);
    expect(parseRotateAngle(-450)).toBe(270);
  });

  it("defaults to 0 for non-numeric / missing values", () => {
    expect(parseRotateAngle(undefined)).toBe(0);
    expect(parseRotateAngle(null)).toBe(0);
    expect(parseRotateAngle("abc")).toBe(0);
    expect(parseRotateAngle(NaN)).toBe(0);
    expect(parseRotateAngle(Infinity)).toBe(0);
  });
});

describe("rotatedBounds", () => {
  it("leaves the box unchanged at 0° (no rotation)", () => {
    expect(rotatedBounds(200, 100, 0)).toEqual({ width: 200, height: 100 });
  });

  it("transposes the box at 90° and 270° (byte-identical right-angle steps)", () => {
    expect(rotatedBounds(200, 100, 90)).toEqual({ width: 100, height: 200 });
    expect(rotatedBounds(200, 100, 270)).toEqual({ width: 100, height: 200 });
  });

  it("keeps the box unchanged at 180° (a half turn fits the same rectangle)", () => {
    expect(rotatedBounds(200, 100, 180)).toEqual({ width: 200, height: 100 });
  });

  it("expands to the bounding box at 45°", () => {
    // A square rotated 45° needs a canvas of side s·√2. 100·√2 ≈ 141.42 → 141.
    expect(rotatedBounds(100, 100, 45)).toEqual({ width: 141, height: 141 });
    // A non-square: |200·cos45 + 100·sin45| = 300/√2 ≈ 212.13 → 212 on both axes.
    expect(rotatedBounds(200, 100, 45)).toEqual({ width: 212, height: 212 });
  });

  it("grows the canvas for an arbitrary angle (no corner clipped)", () => {
    // 30°: w' = 200·cos30 + 100·sin30 = 173.205 + 50 = 223.205 → 223
    //      h' = 200·sin30 + 100·cos30 = 100 + 86.603 = 186.603 → 187
    expect(rotatedBounds(200, 100, 30)).toEqual({ width: 223, height: 187 });
    // Both axes are always at least the larger original dimension.
    const b = rotatedBounds(200, 100, 17);
    expect(b.width).toBeGreaterThanOrEqual(200);
    expect(b.height).toBeGreaterThanOrEqual(100);
  });

  it("floors at 1px so a degenerate input never yields a zero-sized canvas", () => {
    expect(rotatedBounds(0, 0, 45)).toEqual({ width: 1, height: 1 });
  });

  it("matches the bounding box for normalized negative / over-range angles", () => {
    // parseRotateAngle(-90) → 270, which transposes exactly like +90.
    expect(rotatedBounds(200, 100, parseRotateAngle(-90))).toEqual({ width: 100, height: 200 });
    expect(rotatedBounds(200, 100, parseRotateAngle(360))).toEqual({ width: 200, height: 100 });
  });
});
