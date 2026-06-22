import { describe, it, expect } from "vitest";
import { buildMozjpegOptions } from "./mozjpeg";

// The MozJPEG wasm round-trip is browser-only (it fetches /mozjpeg/...), so it
// cannot run in the Node test env. These pure-function tests over the option
// mapping are therefore the ONLY CI coverage for the runtime args we hand the
// encoder — they assert exactly the contract decision 0015 documents. The real
// encode round-trip is left to the live dev server / Playwright pass.
describe("buildMozjpegOptions", () => {
  it("maps 4:2:0 chroma to auto_subsample:false, chroma_subsample:2", () => {
    const opts = buildMozjpegOptions(80, { progressive: false, chroma: "4:2:0", grayscale: false });
    expect(opts.auto_subsample).toBe(false);
    expect(opts.chroma_subsample).toBe(2);
  });

  it("maps 4:4:4 chroma to chroma_subsample:1", () => {
    const opts = buildMozjpegOptions(80, { progressive: false, chroma: "4:4:4", grayscale: false });
    expect(opts.auto_subsample).toBe(false);
    expect(opts.chroma_subsample).toBe(1);
  });

  it("maps progressive:true to progressive:true, baseline:false", () => {
    const opts = buildMozjpegOptions(80, { progressive: true, chroma: "4:2:0", grayscale: false });
    expect(opts.progressive).toBe(true);
    expect(opts.baseline).toBe(false);
  });

  it("maps progressive:false to progressive:false", () => {
    const opts = buildMozjpegOptions(80, { progressive: false, chroma: "4:2:0", grayscale: false });
    expect(opts.progressive).toBe(false);
    expect(opts.baseline).toBe(false);
  });

  it("maps grayscale:true to color_space:1 (GRAYSCALE)", () => {
    const opts = buildMozjpegOptions(80, { progressive: false, chroma: "4:2:0", grayscale: true });
    expect(opts.color_space).toBe(1);
  });

  it("maps grayscale:false to color_space:3 (YCbCr)", () => {
    const opts = buildMozjpegOptions(80, { progressive: false, chroma: "4:2:0", grayscale: false });
    expect(opts.color_space).toBe(3);
  });

  it("passes quality through unchanged", () => {
    const opts = buildMozjpegOptions(42, { progressive: false, chroma: "4:2:0", grayscale: false });
    expect(opts.quality).toBe(42);
  });
});
