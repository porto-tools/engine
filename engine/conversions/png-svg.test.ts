import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pngSvgDescriptor, buildTraceOptions, toLuminanceGrayscale } from "./png-svg";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "png-svg", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest config uses the default Node environment (no browser).
// The happy-path test drives the full pipeline:
//   createImageBitmap (PNG decode) → canvas.getContext → BinaryImageConverter (WASM) → Blob
// None of those are available in Node without a browser harness. The WASM
// module also embeds a WASM binary that Node's vm won't execute in the same
// way. Guard these with TODO(test-env): add browser/canvas env to unlock.
//
// UNSUPPORTED_INPUT and CANCELLED both throw before any DOM or WASM call, so
// they run in Node unconditionally.
//
// DECODE_FAILED (corrupt bytes): createImageBitmap rejects in a browser on
// bad data; in Node the global is absent, so we guard it too.
const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("pngSvgDescriptor", () => {
  it("has the correct descriptor id", () => {
    expect(pngSvgDescriptor.id).toBe("png-to-svg");
  });

  // TODO(test-env): requires createImageBitmap + canvas + WASM (browser env)
  it.skipIf(!canvasAvailable)("happy path: converts tiny PNG to SVG", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await pngSvgDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/svg+xml");
    expect(result.filename).toBe("tiny.svg");
    expect(result.outputSize).toBeGreaterThan(0);
    // The SVG output must start with the standard XML declaration or <svg tag.
    const text = await result.blob.text();
    expect(text).toMatch(/<svg/i);
    // The cut-out should stay transparent, not bake the converter's white default.
    expect(text).toMatch(/background:\s*transparent/i);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.jpg", {
      type: "image/jpeg",
    });
    await expect(pngSvgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty file with the right MIME as UNSUPPORTED_INPUT (wrong type)", async () => {
    // A plain text file claiming to be octet-stream → UNSUPPORTED_INPUT.
    const file = new File([new Uint8Array(0)], "empty.bin", {
      type: "application/octet-stream",
    });
    await expect(pngSvgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // TODO(test-env): requires createImageBitmap to reject corrupt bytes (browser env)
  it.skipIf(!canvasAvailable)("rejects corrupt PNG bytes as DECODE_FAILED", async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00])], // PNG magic + garbage
      "corrupt.png",
      { type: "image/png" },
    );
    await expect(pngSvgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Use a real fixture file so the test doesn't fail on UNSUPPORTED_INPUT
    // before reaching the abort check. File loading is sync here; the abort
    // is checked synchronously at the top of `convertPngToSvg`.
    const file = new File([new Uint8Array([1, 2, 3, 4])], "any.png", {
      type: "image/png",
    });
    await expect(
      pngSvgDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// ---------------------------------------------------------------------------
// Pure helper — buildTraceOptions
// The option-mapping logic is the only non-trivial, branch-heavy code in this
// conversion. It is pure (no DOM/WASM), so it gets full unit coverage here.
// Defaults are tuned for logos/line art: spline curves + speckle filtering.
// ---------------------------------------------------------------------------
describe("buildTraceOptions", () => {
  it("returns logo-tuned defaults when called with no arguments", () => {
    const opts = buildTraceOptions();
    expect(opts.mode).toBe("spline");
    expect(opts.filterSpeckle).toBe(4);
    expect(opts.cornerThreshold).toBe(60);
    expect(opts.lengthThreshold).toBe(4);
    expect(opts.maxIterations).toBe(10);
    expect(opts.spliceThreshold).toBe(45);
    expect(opts.pathPrecision).toBe(8);
  });

  it("accepts valid mode values", () => {
    expect(buildTraceOptions({ mode: "spline" }).mode).toBe("spline");
    expect(buildTraceOptions({ mode: "none" }).mode).toBe("none");
    expect(buildTraceOptions({ mode: "polygon" }).mode).toBe("polygon");
  });

  it("falls back to spline for an unrecognised mode string", () => {
    expect(buildTraceOptions({ mode: "unknown" }).mode).toBe("spline");
  });

  it("falls back to spline when mode is a number", () => {
    expect(buildTraceOptions({ mode: 42 }).mode).toBe("spline");
  });

  it("accepts explicit numeric overrides for all numeric options", () => {
    const opts = buildTraceOptions({
      filterSpeckle: 8,
      cornerThreshold: 90,
      lengthThreshold: 2,
      maxIterations: 20,
      spliceThreshold: 30,
      pathPrecision: 4,
    });
    expect(opts.filterSpeckle).toBe(8);
    expect(opts.cornerThreshold).toBe(90);
    expect(opts.lengthThreshold).toBe(2);
    expect(opts.maxIterations).toBe(20);
    expect(opts.spliceThreshold).toBe(30);
    expect(opts.pathPrecision).toBe(4);
  });

  it("rejects out-of-range negatives by falling back to defaults", () => {
    const opts = buildTraceOptions({
      filterSpeckle: -1,
      cornerThreshold: -1,
      lengthThreshold: -1,
      maxIterations: -1,
      spliceThreshold: -1,
      pathPrecision: -1,
    });
    // filterSpeckle, cornerThreshold, spliceThreshold, pathPrecision allow 0 → default is 4/60/45/8
    // lengthThreshold and maxIterations require > 0 → default is 4/10
    expect(opts.filterSpeckle).toBe(4);
    expect(opts.cornerThreshold).toBe(60);
    expect(opts.lengthThreshold).toBe(4);
    expect(opts.maxIterations).toBe(10);
    expect(opts.spliceThreshold).toBe(45);
    expect(opts.pathPrecision).toBe(8);
  });

  it("accepts zero for filterSpeckle (no speckle suppression)", () => {
    expect(buildTraceOptions({ filterSpeckle: 0 }).filterSpeckle).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure helper — toLuminanceGrayscale
// The luminance pre-pass is what lets a COLOUR PNG trace by its real shapes
// despite the WASM converter keying off the red channel only. Pure over a plain
// {data,width,height} object, so it runs in Node with no canvas.
// ---------------------------------------------------------------------------
describe("toLuminanceGrayscale", () => {
  // A minimal ImageData stand-in: the helper only touches .data.
  function makeImageData(pixels: number[]): ImageData {
    return {
      data: new Uint8ClampedArray(pixels),
      width: pixels.length / 4,
      height: 1,
      colorSpace: "srgb",
    } as ImageData;
  }

  it("equalises r, g, b to a single luminance value and forces alpha opaque", () => {
    // Pure red, fully opaque → luma 0.299*255 ≈ 76.
    const out = toLuminanceGrayscale(makeImageData([255, 0, 0, 255]));
    expect(out.data[0]).toBe(76);
    expect(out.data[1]).toBe(76);
    expect(out.data[2]).toBe(76);
    expect(out.data[3]).toBe(255);
  });

  it("gives a pure-blue pixel a real (dark) brightness instead of near-zero red", () => {
    // This is the key fix: the WASM converter thresholds on red alone, so pure
    // blue would read as 'background'. After the pre-pass blue is dark (≈29),
    // i.e. BELOW the converter's 128 threshold → it becomes a traced shape.
    const out = toLuminanceGrayscale(makeImageData([0, 0, 255, 255]));
    expect(out.data[0]).toBe(29); // 0.114 * 255 ≈ 29
    expect(out.data[0]).toBeLessThan(128);
  });

  it("composites transparency over white (transparent reads as bright background)", () => {
    // Fully transparent black → composited over white → white → luma 255.
    const out = toLuminanceGrayscale(makeImageData([0, 0, 0, 0]));
    expect(out.data[0]).toBe(255);
    expect(out.data[3]).toBe(255);
  });

  it("keeps a white pixel white and a black pixel black", () => {
    const white = toLuminanceGrayscale(makeImageData([255, 255, 255, 255]));
    expect(white.data[0]).toBe(255);
    const black = toLuminanceGrayscale(makeImageData([0, 0, 0, 255]));
    expect(black.data[0]).toBe(0);
  });

  it("processes every pixel in a multi-pixel buffer", () => {
    const out = toLuminanceGrayscale(
      makeImageData([255, 255, 255, 255, 0, 0, 0, 255]),
    );
    expect(out.data[0]).toBe(255); // first pixel white
    expect(out.data[4]).toBe(0); // second pixel black
  });
});
