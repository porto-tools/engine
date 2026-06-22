import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { svgPngDescriptor, computeRenderSize, normalizeScale } from "./svg-png";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// SVG → PNG rasterises through `new Image()` + `URL.createObjectURL` +
// `canvas.toBlob`, none of which exist (or render SVG to real pixels) in Node —
// jsdom/happy-dom only stub them. So the two tests that drive the real render
// pipeline (the happy path, and the <img> onerror → DECODE_FAILED path) are
// guarded with the project-standard `it.skipIf(!canvasAvailable)`: they skip in
// Node and auto-run unchanged once a browser/canvas test env exists. The
// conversion's only non-trivial *logic* (size math: native size scaled to the
// device scale, the 1024² sizeless fallback, the 1024 min-edge floor, the 4096
// cap, and scale normalisation) is extracted into the pure `computeRenderSize` /
// `normalizeScale` and unit-tested below, so those branches keep real coverage
// with zero new dependency. UNSUPPORTED_INPUT and CANCELLED run in Node
// unconditionally — both throw before any Canvas/DOM call.
const canvasAvailable = typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("svgPngDescriptor", () => {
  // Needs a real browser to rasterise the SVG; otherwise skipped (manual QC).
  it.skipIf(!canvasAvailable)("converts the happy path", async () => {
    const file = await fileFromFixture("tiny.svg", "image/svg+xml");
    const result = await svgPngDescriptor.convert({ file });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(svgPngDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // Reaching DECODE_FAILED requires the browser's <img> decoder to reject the
  // payload (onerror), which Node can't do; otherwise skipped (manual QC).
  it.skipIf(!canvasAvailable)("rejects malformed SVG as DECODE_FAILED", async () => {
    const file = new File(
      [new TextEncoder().encode("<not really an svg>")],
      "broken.svg",
      { type: "image/svg+xml" },
    );
    await expect(svgPngDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.svg", "image/svg+xml");
    await expect(
      svgPngDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("declares scale + background controls and matching defaults", () => {
    // The tool is button-driven (Resolution + Background selects). Guard the
    // wiring: the control ids must match the option keys convert() reads, and
    // the descriptor defaults must agree with the control defaults.
    const ids = (svgPngDescriptor.controls ?? []).map((c) => c.id);
    expect(ids).toEqual(["scale", "background"]);
    expect(svgPngDescriptor.defaultOptions).toMatchObject({
      scale: 2,
      background: "transparent",
    });
  });
});

// The scale normaliser turns the <select>'s string value (and any stray input)
// into a clamped multiplier. Pure (no DOM), so it gets full unit coverage.
describe("normalizeScale", () => {
  it("defaults to 2× when missing or unparseable", () => {
    expect(normalizeScale(undefined)).toBe(2);
    expect(normalizeScale(null)).toBe(2);
    expect(normalizeScale("abc")).toBe(2);
    expect(normalizeScale(NaN)).toBe(2);
  });

  it("accepts the select's string values", () => {
    expect(normalizeScale("1")).toBe(1);
    expect(normalizeScale("3")).toBe(3);
    expect(normalizeScale("4")).toBe(4);
  });

  it("accepts raw numbers", () => {
    expect(normalizeScale(1)).toBe(1);
    expect(normalizeScale(2.5)).toBe(2.5);
  });

  it("clamps out-of-range values to [1, 4]", () => {
    expect(normalizeScale(0)).toBe(2); // ≤0 → default, not clamp
    expect(normalizeScale(0.5)).toBe(1);
    expect(normalizeScale(99)).toBe(4);
  });
});

// The size policy is the only branch-heavy logic in this conversion, and it is
// pure (no DOM), so it gets full unit coverage here. Note every native size is
// now multiplied by the device scale (default 2×) and floored to a 1024 long
// edge, so a small icon no longer rasterises at its postage-stamp intrinsic size.
describe("computeRenderSize", () => {
  it("scales the native size by the default 2× when the result fits the bounds", () => {
    // 800×600 → ×2 = 1600×1200, long edge 1600 is between the 1024 floor and 4096 cap.
    expect(computeRenderSize(800, 600)).toEqual({ width: 1600, height: 1200 });
  });

  it("honours an explicit scale multiplier", () => {
    expect(computeRenderSize(800, 600, 3)).toEqual({ width: 2400, height: 1800 });
    // At 1× this 800-long-edge SVG is below the 1024 floor, so it is raised:
    // 800×600 → ×(1024/800) = 1024×768. The "does not floor" case below uses a
    // natively-large SVG to exercise the unscaled passthrough.
    expect(computeRenderSize(800, 600, 1)).toEqual({ width: 1024, height: 768 });
  });

  it("floors a tiny icon up to a 1024 long edge, preserving ratio", () => {
    // 24×24 → ×2 = 48×48, well under 1024 → scaled up to 1024×1024.
    expect(computeRenderSize(24, 24)).toEqual({ width: 1024, height: 1024 });
  });

  it("floors a tiny non-square icon up to a 1024 long edge", () => {
    // 40×20 → ×2 = 80×40, long edge 80 → ×(1024/80) = 1024×512.
    expect(computeRenderSize(40, 20)).toEqual({ width: 1024, height: 512 });
  });

  it("does not floor when the native render already clears 1024 at 1×", () => {
    expect(computeRenderSize(2000, 1000, 1)).toEqual({ width: 2000, height: 1000 });
  });

  it("falls back to 1024² (×scale) for a sizeless SVG reported as 0×0", () => {
    // base 1024² × 2 = 2048², under the cap.
    expect(computeRenderSize(0, 0)).toEqual({ width: 2048, height: 2048 });
  });

  it("falls back when only one axis is zero (unusable canvas)", () => {
    expect(computeRenderSize(300, 0)).toEqual({ width: 2048, height: 2048 });
  });

  it("falls back for NaN dimensions", () => {
    expect(computeRenderSize(NaN, NaN)).toEqual({ width: 2048, height: 2048 });
  });

  it("caps a wide oversized render at a 4096 long edge, preserving ratio", () => {
    // 4000×2000 × 2 = 8000×4000, long edge 8000 → capped to 4096×2048.
    expect(computeRenderSize(4000, 2000)).toEqual({ width: 4096, height: 2048 });
  });

  it("caps a tall oversized render at a 4096 long edge, preserving ratio", () => {
    expect(computeRenderSize(2000, 4000)).toEqual({ width: 2048, height: 4096 });
  });

  it("caps an oversized square render at 4096×4096", () => {
    expect(computeRenderSize(5000, 5000)).toEqual({ width: 4096, height: 4096 });
  });

  it("treats an unparseable scale as the default 2×", () => {
    // Mirrors what convert() passes when normalizeScale already ran; computeRenderSize
    // also defends itself so it's safe to call directly with a bad scale.
    expect(computeRenderSize(800, 600, NaN)).toEqual({ width: 1600, height: 1200 });
  });
});
