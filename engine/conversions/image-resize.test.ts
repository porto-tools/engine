import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { imageResizeDescriptor, computeResizeDimensions, clampPercent } from "./image-resize";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The resize pipeline runs on createImageBitmap + canvas.drawImage +
// canvas.toBlob, none of which exist in Node, so the happy path is guarded with
// the project-standard `it.skipIf(!canvasAvailable)` (TODO(test-env): auto-runs
// once a browser/canvas env exists). The conversion's real LOGIC — the
// dimensions/contain-fit/clamp math — is extracted into the pure
// `computeResizeDimensions` and unit-tested below with full coverage and zero
// new dependency. UNSUPPORTED_INPUT and CANCELLED throw before any Canvas call,
// so they run in Node unconditionally.
const canvasAvailable = typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageResizeDescriptor", () => {
  it("declares the parameterized descriptor fields", () => {
    expect(imageResizeDescriptor.id).toBe("image-resize");
    expect(imageResizeDescriptor.accept).toEqual(["image/jpeg", "image/png", "image/webp"]);
    // A parameterized tool: it carries a controls schema (resize-by mode +
    // dimensions + percentage + no-enlarge + format + quality + the A5
    // auto-orient + dpi controls), so the UI stages + button-runs instead of
    // auto-converting.
    expect(imageResizeDescriptor.controls).toHaveLength(8);
    const dimensions = imageResizeDescriptor.controls!.find((c) => c.id === "size");
    expect(dimensions?.type).toBe("dimensions");
    // Canvas tool: no WASM to download.
    expect(imageResizeDescriptor.loadEngine).toBeUndefined();
  });

  it("declares an output-format select with same/png/jpg/webp choices", () => {
    const format = imageResizeDescriptor.controls!.find((c) => c.id === "format");
    expect(format?.type).toBe("select");
    if (format?.type === "select") {
      expect(format.default).toBe("same");
      expect(format.options.map((o) => o.value)).toEqual(["same", "png", "jpg", "webp"]);
    }
  });

  it("declares a quality range control (10–100, default 92)", () => {
    const quality = imageResizeDescriptor.controls!.find((c) => c.id === "quality");
    expect(quality?.type).toBe("range");
    if (quality?.type === "range") {
      expect(quality.min).toBe(10);
      expect(quality.max).toBe(100);
      expect(quality.default).toBe(92);
    }
  });

  it("declares a resize-by select with dimensions/percentage, defaulting to dimensions", () => {
    const resizeBy = imageResizeDescriptor.controls!.find((c) => c.id === "resizeBy");
    expect(resizeBy?.type).toBe("select");
    if (resizeBy?.type === "select") {
      expect(resizeBy.default).toBe("dimensions");
      expect(resizeBy.options.map((o) => o.value)).toEqual(["dimensions", "percentage"]);
    }
  });

  it("declares a percentage slider over the discrete stops (default 100)", () => {
    const percentage = imageResizeDescriptor.controls!.find((c) => c.id === "percentage");
    expect(percentage?.type).toBe("slider");
    if (percentage?.type === "slider") {
      expect(percentage.default).toBe(100);
      expect(percentage.stops).toEqual([10, 25, 50, 75, 100, 150, 200]);
    }
  });

  it("declares a do-not-enlarge checkbox defaulting to false", () => {
    const noEnlarge = imageResizeDescriptor.controls!.find((c) => c.id === "noEnlarge");
    expect(noEnlarge?.type).toBe("checkbox");
    if (noEnlarge?.type === "checkbox") {
      expect(noEnlarge.default).toBe(false);
    }
  });

  // The additive options must not change the default descriptor options: resizeBy
  // defaults to "dimensions", percentage to 100, noEnlarge to false — reproducing
  // today's behaviour exactly.
  it("defaults the additive options so behaviour is unchanged", () => {
    expect(imageResizeDescriptor.defaultOptions?.resizeBy).toBe("dimensions");
    expect(imageResizeDescriptor.defaultOptions?.percentage).toBe(100);
    expect(imageResizeDescriptor.defaultOptions?.noEnlarge).toBe(false);
  });

  // format "same" must reproduce today's behaviour: the input's own format is
  // preserved (PNG in → PNG out, same .png extension).
  it("declares format defaulting to \"same\" so the input format is preserved", () => {
    expect(imageResizeDescriptor.defaultOptions?.format).toBe("same");
  });

  // Needs a real browser to decode + redraw; otherwise skipped (manual QC).
  it.skipIf(!canvasAvailable)("resizes the happy path, preserving the input format", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageResizeDescriptor.convert({
      file,
      options: { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // With an explicit format choice the output switches format + extension: a
  // JPEG resized with format="png" comes out as image/png with a .png name.
  it.skipIf(!canvasAvailable)("changes format + extension when an output format is chosen", async () => {
    const file = await fileFromFixture("tiny.jpg", "image/jpeg");
    const result = await imageResizeDescriptor.convert({
      file,
      options: { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true, format: "png" },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageResizeDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageResizeDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── A5: auto-orient + DPI controls + defaults ────────────────────────────
  it("declares an autoOrient checkbox defaulting to true", () => {
    const autoOrient = imageResizeDescriptor.controls!.find((c) => c.id === "autoOrient");
    expect(autoOrient?.type).toBe("checkbox");
    if (autoOrient?.type === "checkbox") expect(autoOrient.default).toBe(true);
    expect(imageResizeDescriptor.defaultOptions?.autoOrient).toBe(true);
  });

  it("declares a dpi number control (0–1200, default 0 = unchanged)", () => {
    const dpi = imageResizeDescriptor.controls!.find((c) => c.id === "dpi");
    expect(dpi?.type).toBe("number");
    if (dpi?.type === "number") {
      expect(dpi.default).toBe(0);
      expect(dpi.min).toBe(0);
      expect(dpi.max).toBe(1200);
      expect(dpi.unit).toBe("DPI");
    }
    expect(imageResizeDescriptor.defaultOptions?.dpi).toBe(0);
  });

  // A5 happy auto-orient: resize a PNG with auto-orient on (default).
  it.skipIf(!canvasAvailable)("resizes with auto-orient on and preserves the format", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageResizeDescriptor.convert({
      file,
      options: { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true, autoOrient: true },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // A5 DPI applied: a PNG output carries a pHYs chunk with the converted ppu.
  it.skipIf(!canvasAvailable)("stamps the DPI into a pHYs chunk on the PNG output", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageResizeDescriptor.convert({
      file,
      options: { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true, dpi: 300 },
    });
    expect(result.mimeType).toBe("image/png");
    const out = new Uint8Array(await result.blob.arrayBuffer());
    // The output must now contain the "pHYs" chunk-type bytes somewhere.
    const hasPhys = containsBytes(out, [0x70, 0x48, 0x59, 0x73]);
    expect(hasPhys).toBe(true);
  });

  // A5 DPI applied via an explicit JPG output: the JFIF density bytes carry it.
  it.skipIf(!canvasAvailable)("stamps the DPI into the JFIF APP0 when output format is jpg", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageResizeDescriptor.convert({
      file,
      options: { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true, format: "jpg", dpi: 300 },
    });
    expect(result.mimeType).toBe("image/jpeg");
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(out[13]).toBe(1);
    expect((out[14] << 8) | out[15]).toBe(300);
    expect((out[16] << 8) | out[17]).toBe(300);
  });

  // A5 DPI=0 no-op: the default output is byte-identical to a no-dpi-option run.
  it.skipIf(!canvasAvailable)("leaves the PNG bytes unchanged when dpi is 0 (byte-identical default)", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const opts = { sizeWidth: 8, sizeHeight: 8, sizeKeepAspect: true };
    const withZero = await imageResizeDescriptor.convert({ file, options: { ...opts, dpi: 0 } });
    const withoutOption = await imageResizeDescriptor.convert({ file, options: opts });
    const a = new Uint8Array(await withZero.blob.arrayBuffer());
    const b = new Uint8Array(await withoutOption.blob.arrayBuffer());
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// Tiny helper: does `haystack` contain the contiguous byte sequence `needle`?
function containsBytes(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// The dimensions policy is the branch-heavy logic and is pure (no DOM), so it
// gets full unit coverage here.
describe("computeResizeDimensions", () => {
  it("contain-fits inside the requested box when aspect is locked (wide source)", () => {
    // 200×100 source into a 100×100 box → fit the long edge: 100×50.
    expect(computeResizeDimensions({ sizeWidth: 100, sizeHeight: 100, sizeKeepAspect: true }, 200, 100)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it("contain-fits a tall source (height-bound)", () => {
    expect(computeResizeDimensions({ sizeWidth: 100, sizeHeight: 100, sizeKeepAspect: true }, 100, 200)).toEqual({
      width: 50,
      height: 100,
    });
  });

  it("uses requested dimensions verbatim when aspect is unlocked (stretch)", () => {
    expect(computeResizeDimensions({ sizeWidth: 300, sizeHeight: 80, sizeKeepAspect: false }, 200, 100)).toEqual({
      width: 300,
      height: 80,
    });
  });

  it("defaults keepAspect to true when the flag is absent", () => {
    expect(computeResizeDimensions({ sizeWidth: 100, sizeHeight: 100 }, 200, 100)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it("clamps below the minimum up to 1px", () => {
    expect(computeResizeDimensions({ sizeWidth: 0, sizeHeight: -5, sizeKeepAspect: false }, 200, 100)).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("clamps above the 16384 maximum", () => {
    expect(computeResizeDimensions({ sizeWidth: 999999, sizeHeight: 999999, sizeKeepAspect: false }, 200, 100)).toEqual({
      width: 16384,
      height: 16384,
    });
  });

  it("falls back to defaults for non-numeric option values", () => {
    // Both axes unparseable (NaN) → DEFAULT_DIMENSION (1024) each; unlocked →
    // verbatim. `undefined` is used rather than null because Number(null) === 0.
    expect(computeResizeDimensions({ sizeWidth: "abc", sizeHeight: undefined, sizeKeepAspect: false }, 200, 100)).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  it("falls back to defaults when options are entirely absent", () => {
    // No options object → both axes default to 1024, keepAspect defaults true,
    // so the 2:1 source contain-fits the 1024² box → 1024×512.
    expect(computeResizeDimensions(undefined, 200, 100)).toEqual({ width: 1024, height: 512 });
  });

  it("rounds fractional results to whole pixels", () => {
    // 3:1 source into a 100×100 box → 100×33.33 → 33.
    expect(computeResizeDimensions({ sizeWidth: 100, sizeHeight: 100, sizeKeepAspect: true }, 300, 100)).toEqual({
      width: 100,
      height: 33,
    });
  });

  // ── Percentage mode (resizeBy "percentage") ───────────────────────────────
  // Scales BOTH axes off the SOURCE size by `percentage`%, ignoring the
  // width/height box entirely (it is inherently proportional / keep-aspect).
  it("scales both axes off the source in percentage mode (50% of 1000×800 → 500×400)", () => {
    expect(
      computeResizeDimensions({ resizeBy: "percentage", percentage: 50 }, 1000, 800),
    ).toEqual({ width: 500, height: 400 });
  });

  it("keeps the source ratio in percentage mode regardless of the dimensions box", () => {
    // The dimensions box is present but ignored: a 16:9-ish 1920×1080 at 25%.
    expect(
      computeResizeDimensions(
        { resizeBy: "percentage", percentage: 25, sizeWidth: 9999, sizeHeight: 1 },
        1920,
        1080,
      ),
    ).toEqual({ width: 480, height: 270 });
  });

  it("grows the image in percentage mode when above 100% and noEnlarge is off", () => {
    expect(
      computeResizeDimensions({ resizeBy: "percentage", percentage: 150 }, 1000, 800),
    ).toEqual({ width: 1500, height: 1200 });
  });

  it("rounds percentage results to whole pixels", () => {
    // 75% of 101×101 → 75.75 → 76.
    expect(
      computeResizeDimensions({ resizeBy: "percentage", percentage: 75 }, 101, 101),
    ).toEqual({ width: 76, height: 76 });
  });

  it("falls back to 100% (unchanged) for a non-numeric percentage", () => {
    expect(
      computeResizeDimensions({ resizeBy: "percentage", percentage: "abc" }, 640, 480),
    ).toEqual({ width: 640, height: 480 });
  });

  // ── do-not-enlarge guard (noEnlarge) ──────────────────────────────────────
  // Caps the output so it never exceeds the SOURCE on either axis.
  it("caps percentage mode at the source when noEnlarge is on (150% stays ≤ source)", () => {
    expect(
      computeResizeDimensions(
        { resizeBy: "percentage", percentage: 150, noEnlarge: true },
        1000,
        800,
      ),
    ).toEqual({ width: 1000, height: 800 });
  });

  it("still shrinks under noEnlarge when the percentage is below 100", () => {
    expect(
      computeResizeDimensions(
        { resizeBy: "percentage", percentage: 50, noEnlarge: true },
        1000,
        800,
      ),
    ).toEqual({ width: 500, height: 400 });
  });

  it("caps dimensions mode at the source when noEnlarge is on (unlocked stretch)", () => {
    // Requested 4000×4000 but source is 1000×800; noEnlarge holds each axis ≤ source.
    expect(
      computeResizeDimensions(
        { resizeBy: "dimensions", sizeWidth: 4000, sizeHeight: 4000, sizeKeepAspect: false, noEnlarge: true },
        1000,
        800,
      ),
    ).toEqual({ width: 1000, height: 800 });
  });

  it("leaves dimensions mode untouched under noEnlarge when already within the source", () => {
    expect(
      computeResizeDimensions(
        { resizeBy: "dimensions", sizeWidth: 500, sizeHeight: 500, sizeKeepAspect: false, noEnlarge: true },
        1000,
        800,
      ),
    ).toEqual({ width: 500, height: 500 });
  });

  it("treats an unknown resizeBy value as dimensions (default path unchanged)", () => {
    expect(
      computeResizeDimensions({ resizeBy: "bogus", sizeWidth: 100, sizeHeight: 100, sizeKeepAspect: true }, 200, 100),
    ).toEqual({ width: 100, height: 50 });
  });
});

// clampPercent is the percentage-option reader: it bounds the value into the
// [10, 200] stop range and falls back to 100 for unusable input. Pure.
describe("clampPercent", () => {
  it("returns the value verbatim when inside the bounds", () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(150)).toBe(150);
  });

  it("clamps below the minimum up to 10", () => {
    expect(clampPercent(5)).toBe(10);
    expect(clampPercent(-100)).toBe(10);
  });

  it("clamps above the maximum down to 200", () => {
    expect(clampPercent(500)).toBe(200);
  });

  it("falls back to 100 for non-numeric or missing input", () => {
    expect(clampPercent("abc")).toBe(100);
    expect(clampPercent(undefined)).toBe(100);
    expect(clampPercent(NaN)).toBe(100);
  });

  it("parses a numeric string", () => {
    expect(clampPercent("75")).toBe(75);
  });
});
