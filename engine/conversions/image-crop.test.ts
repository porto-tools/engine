// Tests for image-crop. The happy path exercises createImageBitmap +
// canvas.drawImage + canvas.toBlob, none of which exist in the default Node
// test environment (vitest runs in Node by default). Those tests are gated with
// canvasAvailable. The error-path tests (UNSUPPORTED_INPUT, CANCELLED) short-
// circuit before any Canvas call and run unconditionally. The parseCropParams
// logic is pure and is fully unit-tested here.
//
// TODO(test-env): remove the skipIf guard once a browser/canvas environment is
// available in CI.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  imageCropDescriptor,
  parseCropParams,
  aspectRatioFromPreset,
  constrainRectToAspect,
} from "./image-crop";
import { ConversionError } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageCropDescriptor", () => {
  it("declares the parameterized descriptor fields", () => {
    expect(imageCropDescriptor.id).toBe("image-crop");
    expect(imageCropDescriptor.accept).toEqual(["image/jpeg", "image/png", "image/webp"]);
    // One visual crop control that fans out to cropX/cropY/cropW/cropH.
    expect(imageCropDescriptor.controls).toHaveLength(1);
    const control = imageCropDescriptor.controls![0];
    expect(control.type).toBe("crop");
    expect(control.id).toBe("crop");
    // Canvas tool: no WASM.
    expect(imageCropDescriptor.loadEngine).toBeUndefined();
  });

  // TODO(test-env): run in browser/canvas env.
  it.skipIf(!canvasAvailable)("crops the happy path, preserving the input format", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageCropDescriptor.convert({
      file,
      options: { cropX: 0, cropY: 0, cropW: 4, cropH: 4 },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageCropDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageCropDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("parseCropParams", () => {
  it("returns the explicit options when they fit inside the source", () => {
    expect(parseCropParams({ cropX: 10, cropY: 5, cropW: 80, cropH: 40 }, 100, 50)).toEqual({
      x: 10,
      y: 5,
      w: 80,
      h: 40,
    });
  });

  it("defaults missing coords to 0 and missing dimensions to source size", () => {
    expect(parseCropParams(undefined, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("clamps negative coords to 0", () => {
    const result = parseCropParams({ cropX: -10, cropY: -20, cropW: 50, cropH: 50 }, 100, 100);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("throws UNSUPPORTED_INPUT when x + w exceeds source width", () => {
    expect(() =>
      parseCropParams({ cropX: 50, cropY: 0, cropW: 60, cropH: 50 }, 100, 100),
    ).toThrow(ConversionError);
    expect(() =>
      parseCropParams({ cropX: 50, cropY: 0, cropW: 60, cropH: 50 }, 100, 100),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_INPUT" }));
  });

  it("throws UNSUPPORTED_INPUT when y + h exceeds source height", () => {
    expect(() =>
      parseCropParams({ cropX: 0, cropY: 50, cropW: 50, cropH: 60 }, 100, 100),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_INPUT" }));
  });

  it("treats a non-positive width/height as the full source size", () => {
    // The crop control seeds W/H to 0 until the image loads; a 0 (or missing)
    // dimension means "use the whole image" rather than failing the min check.
    expect(parseCropParams({ cropX: 0, cropY: 0, cropW: 0, cropH: 0 }, 100, 80)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    });
    // A missing dimension behaves identically to a 0 one (both → full size).
    expect(parseCropParams({ cropX: 0, cropY: 0, cropH: 0 }, 120, 90)).toEqual({
      x: 0,
      y: 0,
      w: 120,
      h: 90,
    });
  });

  it("rounds fractional coordinates to whole pixels", () => {
    const result = parseCropParams({ cropX: 1.7, cropY: 2.4, cropW: 10, cropH: 10 }, 100, 100);
    expect(result.x).toBe(2);
    expect(result.y).toBe(2);
  });

  it("accepts exact-boundary crop (x + w == sourceWidth)", () => {
    expect(() =>
      parseCropParams({ cropX: 0, cropY: 0, cropW: 100, cropH: 100 }, 100, 100),
    ).not.toThrow();
  });
});

describe("aspectRatioFromPreset", () => {
  it("maps the named presets to width/height ratios", () => {
    expect(aspectRatioFromPreset("1:1")).toBe(1);
    expect(aspectRatioFromPreset("4:3")).toBeCloseTo(4 / 3, 10);
    expect(aspectRatioFromPreset("16:9")).toBeCloseTo(16 / 9, 10);
    expect(aspectRatioFromPreset("3:2")).toBeCloseTo(3 / 2, 10);
  });

  it("returns null for Free / empty / unknown (no constraint = default behavior)", () => {
    expect(aspectRatioFromPreset("free")).toBeNull();
    expect(aspectRatioFromPreset("")).toBeNull();
    expect(aspectRatioFromPreset(undefined)).toBeNull();
    expect(aspectRatioFromPreset("nonsense")).toBeNull();
  });
});

describe("constrainRectToAspect", () => {
  const bounds = { width: 1000, height: 1000 };

  it("returns the rect rounded but unchanged when ratio is null (Free = default)", () => {
    expect(constrainRectToAspect({ x: 10.4, y: 5.6, w: 80.2, h: 41.9 }, null, bounds)).toEqual({
      x: 10,
      y: 6,
      w: 80,
      h: 42,
    });
  });

  it("shrinks the long axis (width) to honor a square ratio", () => {
    // 200×100 box, ratio 1 → width comes down to the height (100).
    expect(constrainRectToAspect({ x: 0, y: 0, w: 200, h: 100 }, 1, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
  });

  it("shrinks the long axis (height) to honor a wide ratio", () => {
    // 160×160 box, ratio 16:9 → height derived from width: 160 / (16/9) = 90.
    expect(constrainRectToAspect({ x: 0, y: 0, w: 160, h: 160 }, 16 / 9, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    });
  });

  it("produces a box whose width/height equals the target ratio", () => {
    const r = constrainRectToAspect({ x: 12, y: 34, w: 300, h: 220 }, 4 / 3, bounds);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 2);
  });

  it("slides the box back inside the image when it would spill past an edge", () => {
    // A square box anchored near the right edge: keep its size, push x in so
    // x + w never exceeds the bound.
    const r = constrainRectToAspect({ x: 950, y: 0, w: 100, h: 100 }, 1, { width: 1000, height: 1000 });
    expect(r.w).toBe(100);
    expect(r.h).toBe(100);
    expect(r.x + r.w).toBeLessThanOrEqual(1000);
    expect(r.x).toBe(900);
  });

  it("scales a ratio'd box down to fit when it is larger than the image", () => {
    // Want 16:9 but the image is only 200×200 → fit width 200, height 200/(16/9)=112.
    const r = constrainRectToAspect({ x: 0, y: 0, w: 400, h: 400 }, 16 / 9, { width: 200, height: 200 });
    expect(r.w).toBeLessThanOrEqual(200);
    expect(r.h).toBeLessThanOrEqual(200);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
  });
});
