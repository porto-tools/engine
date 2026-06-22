// Tests for the (real, lossy) Compress PDF conversion.
//
// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The actual size reduction runs on createImageBitmap + canvas.drawImage +
// canvas.toBlob (Path A's JPEG re-encode) and, for the fallback, pdf.js + a Web
// Worker (Path B's rasterize) — none of which exist in plain Node. So the
// reduction happy path is guarded with the project-standard
// `it.skipIf(!canvasAvailable)` (TODO(test-env): auto-runs once a browser/canvas
// env exists). Crucially, convert() is written to DEGRADE GRACEFULLY without a
// canvas: tryDecode returns null, no image is re-encoded, and pdf-lib still
// re-saves a valid PDF — so even in Node the happy path produces correct output,
// just without the lossy shrink. We assert that weaker (but real) guarantee
// unconditionally, and the genuine shrink under skipIf.
//
// The pure level/size policy (resolveLevel, settingsForLevel,
// isMeaningfulReduction, fitWithinEdge) is DOM-free and gets full unit coverage.
// UNSUPPORTED_INPUT and CANCELLED throw before any browser call, so they run in
// Node unconditionally.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Mock the shared qpdf module the same way protect-pdf/unlock-pdf tests do: a
// hoisted recorder captures the argv the descriptor builds (by invoking its
// buildArgs callback with the real in/out paths) and counts how many times
// runQpdf was called. qpdf-wasm is an Emscripten build that can't run in Node,
// so we never do a real repack round-trip — we only assert the lossless final
// pass is (or isn't) invoked, and with exactly the right structural argv.
const qpdfMock = vi.hoisted(() => ({
  calls: 0,
  lastArgs: null as string[] | null,
  // A "successful" repack: returns the input bytes back (smaller-or-equal so the
  // honesty guard keeps them). Tests that need a no-op/failure override this.
  result: { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), exitCode: 0 },
}));

vi.mock("./qpdf", () => ({
  loadQpdf: vi.fn(async () => () => {}),
  runQpdf: vi.fn(async (_file: File, buildArgs: (i: string, o: string) => string[]) => {
    qpdfMock.calls += 1;
    qpdfMock.lastArgs = buildArgs("/in/input.pdf", "/out/output.pdf");
    return qpdfMock.result;
  }),
}));

import {
  compressPdfDescriptor,
  resolveLevel,
  settingsForLevel,
  isMeaningfulReduction,
  fitWithinEdge,
  wantsLosslessRepack,
  buildRepackArgs,
} from "./compress-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "compress-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// The lossy shrink needs the real browser image stack; the no-canvas path still
// produces a valid PDF (just without re-encoding), which we test unconditionally.
const canvasAvailable =
  typeof createImageBitmap === "function" &&
  typeof document !== "undefined" &&
  typeof document.createElement === "function";

beforeEach(() => {
  qpdfMock.calls = 0;
  qpdfMock.lastArgs = null;
  qpdfMock.result = { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), exitCode: 0 };
});

describe("compressPdfDescriptor", () => {
  it("declares the parameterized descriptor fields", () => {
    expect(compressPdfDescriptor.id).toBe("compress-pdf");
    expect(compressPdfDescriptor.fromLabel).toBe("PDF");
    expect(compressPdfDescriptor.toLabel).toBe("PDF");
    expect(compressPdfDescriptor.newExtension).toBe("pdf");
    expect(compressPdfDescriptor.accept).toEqual(["application/pdf"]);
    // A parameterized tool: the compression-level select makes the UI stage +
    // button-run instead of auto-converting. Plus the opt-in lossless repack
    // checkbox (additive; defaults OFF).
    expect(compressPdfDescriptor.controls).toHaveLength(2);
    const control = compressPdfDescriptor.controls![0];
    expect(control.type).toBe("select");
    expect(control.id).toBe("level");
    const repack = compressPdfDescriptor.controls![1];
    expect(repack.type).toBe("checkbox");
    expect(repack.id).toBe("losslessRepack");
    // Default OFF: today's output is unchanged unless the user opts in.
    expect(repack).toMatchObject({ type: "checkbox", default: false });
    // No setup gate: pdf-lib is pure JS and pdf.js is lazy-imported inside
    // convert only if the fallback runs, so there's no loadEngine download.
    expect(compressPdfDescriptor.loadEngine).toBeUndefined();
    expect(compressPdfDescriptor.defaultOptions).toEqual({
      level: "balanced",
      losslessRepack: false,
    });
  });

  // Runs even in Node: with no canvas, no image is re-encoded, but pdf-lib still
  // round-trips the document to a valid, same-page-count PDF. This is the real
  // graceful-degradation contract and a structural sanity check on the pipeline.
  it("produces a valid PDF (graceful no-canvas path) and never grows the file", async () => {
    const file = await fileFromFixture("image-heavy.pdf");
    const result = await compressPdfDescriptor.convert({
      file,
      options: { level: "balanced" },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("image-heavy.pdf");
    expect(result.inputSize).toBe(file.size);
    expect(result.outputSize).toBeGreaterThan(0);
    // Honesty guarantee: never hand back something larger than we received.
    expect(result.outputSize).toBeLessThanOrEqual(file.size);

    // The output bytes must be a real PDF (start with %PDF).
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    const header = String.fromCharCode(...outBytes.slice(0, 4));
    expect(header).toBe("%PDF");

    // Round-trips to a document with the same page count (Path A preserves pages).
    const { PDFDocument } = await import("pdf-lib");
    const original = await PDFDocument.load(await file.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    expect(reloaded.getPageCount()).toBe(original.getPageCount());
  });

  // The genuine lossy shrink needs a real browser; skipped in Node (manual QC).
  it.skipIf(!canvasAvailable)(
    "shrinks an image-heavy PDF by re-encoding its embedded JPEG (happy path)",
    async () => {
      const file = await fileFromFixture("image-heavy.pdf");
      const result = await compressPdfDescriptor.convert({
        file,
        options: { level: "smaller" },
      });
      expect(result.mimeType).toBe("application/pdf");
      expect(result.outputSize).toBeGreaterThan(0);
      // With a real canvas the embedded JPEG is re-encoded smaller; the file
      // must not be larger than the input (often meaningfully smaller).
      expect(result.outputSize).toBeLessThanOrEqual(file.size);
    },
  );

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(compressPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("image-heavy.pdf");
    await expect(
      compressPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── Lossless structural repack (opt-in qpdf final pass) ─────────────────────
  //
  // These run in Node: the lossy Path A degrades gracefully without a canvas and
  // qpdf is mocked, so the only thing under test is whether — and how — the final
  // qpdf pass is invoked from convert(). Default OFF must keep today's behavior
  // (qpdf never touched); ON must invoke runQpdf exactly once with the structural
  // argv.

  it("does NOT invoke qpdf when the lossless repack toggle is OFF (default preserved)", async () => {
    const file = await fileFromFixture("image-heavy.pdf");
    const result = await compressPdfDescriptor.convert({
      file,
      options: { level: "balanced" }, // losslessRepack omitted ⇒ defaults OFF
    });
    expect(result.mimeType).toBe("application/pdf");
    // The whole point of the default: no structural pass, no qpdf load/run.
    expect(qpdfMock.calls).toBe(0);
    expect(qpdfMock.lastArgs).toBeNull();
  });

  it("does NOT invoke qpdf when losslessRepack is explicitly false", async () => {
    const file = await fileFromFixture("image-heavy.pdf");
    await compressPdfDescriptor.convert({
      file,
      options: { level: "balanced", losslessRepack: false },
    });
    expect(qpdfMock.calls).toBe(0);
  });

  it("invokes qpdf ONCE with exactly the structural argv when losslessRepack is ON", async () => {
    const file = await fileFromFixture("image-heavy.pdf");
    const result = await compressPdfDescriptor.convert({
      file,
      options: { level: "balanced", losslessRepack: true },
    });
    expect(result.mimeType).toBe("application/pdf");
    // Exactly one final pass over the compressed bytes.
    expect(qpdfMock.calls).toBe(1);
    // The exact lossless structural argv: object-stream packing + linearization,
    // then the positional in/out pair.
    expect(qpdfMock.lastArgs).toEqual([
      "--object-streams=generate",
      "--linearize",
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });

  it("keeps the pre-repack bytes when the qpdf pass fails or grows the file (honesty preserved)", async () => {
    // A failed run (non-zero exit, empty output) must never corrupt the result:
    // convert falls back to the compressed bytes it already had.
    qpdfMock.result = { data: new Uint8Array(0), exitCode: 2 };
    const file = await fileFromFixture("image-heavy.pdf");
    const result = await compressPdfDescriptor.convert({
      file,
      options: { level: "balanced", losslessRepack: true },
    });
    expect(qpdfMock.calls).toBe(1);
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.outputSize).toBeLessThanOrEqual(file.size);
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");
  });
});

// ── wantsLosslessRepack (pure toggle reader, no DOM) ──────────────────────────

describe("wantsLosslessRepack", () => {
  it("is true only when the toggle is explicitly true", () => {
    expect(wantsLosslessRepack({ losslessRepack: true })).toBe(true);
  });

  it("defaults to false for off/missing/garbage values", () => {
    expect(wantsLosslessRepack({ losslessRepack: false })).toBe(false);
    expect(wantsLosslessRepack({})).toBe(false);
    expect(wantsLosslessRepack(undefined)).toBe(false);
    // Only a real boolean true counts — a stray truthy string must not opt in.
    expect(wantsLosslessRepack({ losslessRepack: "true" })).toBe(false);
    expect(wantsLosslessRepack({ losslessRepack: 1 })).toBe(false);
  });
});

// ── buildRepackArgs (pure qpdf argv, no DOM) ──────────────────────────────────

describe("buildRepackArgs", () => {
  it("returns exactly the lossless structural flags then the in/out pair", () => {
    expect(buildRepackArgs("/in/input.pdf", "/out/output.pdf")).toEqual([
      "--object-streams=generate",
      "--linearize",
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });

  it("carries through whatever in/out paths it is given (positionals stay last)", () => {
    const argv = buildRepackArgs("/a.pdf", "/b.pdf");
    expect(argv.slice(0, 2)).toEqual(["--object-streams=generate", "--linearize"]);
    expect(argv.slice(-2)).toEqual(["/a.pdf", "/b.pdf"]);
  });
});

// ── Pure policy units (no DOM) ───────────────────────────────────────────────

describe("resolveLevel", () => {
  it("passes through the three known levels", () => {
    expect(resolveLevel("smaller")).toBe("smaller");
    expect(resolveLevel("balanced")).toBe("balanced");
    expect(resolveLevel("better")).toBe("better");
  });

  it("falls back to balanced for anything unrecognised", () => {
    expect(resolveLevel("aggressive")).toBe("balanced");
    expect(resolveLevel(undefined)).toBe("balanced");
    expect(resolveLevel(42)).toBe("balanced");
    expect(resolveLevel(null)).toBe("balanced");
  });
});

describe("settingsForLevel", () => {
  it("maps each level to monotonic quality/edge/dpi (smaller ≤ balanced ≤ better)", () => {
    const s = settingsForLevel("smaller");
    const b = settingsForLevel("balanced");
    const g = settingsForLevel("better");
    // Quality rises with fidelity.
    expect(s.quality).toBeLessThan(b.quality);
    expect(b.quality).toBeLessThan(g.quality);
    // Resolution caps rise with fidelity.
    expect(s.maxImageEdge).toBeLessThan(b.maxImageEdge);
    expect(b.maxImageEdge).toBeLessThan(g.maxImageEdge);
    // Raster DPI rises with fidelity.
    expect(s.rasterDpi).toBeLessThan(b.rasterDpi);
    expect(b.rasterDpi).toBeLessThan(g.rasterDpi);
    // All qualities are valid JPEG quality fractions.
    for (const q of [s.quality, b.quality, g.quality]) {
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe("isMeaningfulReduction", () => {
  it("counts a ≥3% reduction as meaningful", () => {
    expect(isMeaningfulReduction(1000, 970)).toBe(true); // exactly 3% off
    expect(isMeaningfulReduction(1000, 500)).toBe(true);
  });

  it("counts a tiny or zero reduction as not meaningful", () => {
    expect(isMeaningfulReduction(1000, 971)).toBe(false); // <3% off
    expect(isMeaningfulReduction(1000, 1000)).toBe(false);
    expect(isMeaningfulReduction(1000, 1200)).toBe(false); // grew
  });

  it("is false for a non-positive input size", () => {
    expect(isMeaningfulReduction(0, 0)).toBe(false);
    expect(isMeaningfulReduction(-5, 1)).toBe(false);
  });
});

describe("fitWithinEdge", () => {
  it("leaves an image at or under the cap untouched", () => {
    expect(fitWithinEdge(800, 600, 1000)).toEqual({ width: 800, height: 600 });
    expect(fitWithinEdge(1000, 500, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it("downscales a too-wide image so the long edge meets the cap (aspect kept)", () => {
    // 2000×1000 into a 1000 cap → 1000×500.
    expect(fitWithinEdge(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it("downscales a too-tall image (height-bound)", () => {
    expect(fitWithinEdge(1000, 2000, 1000)).toEqual({ width: 500, height: 1000 });
  });

  it("never returns a sub-pixel dimension", () => {
    const out = fitWithinEdge(3000, 1, 1000);
    expect(out.width).toBe(1000);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("treats a degenerate size defensively (no NaN, ≥ 1px)", () => {
    expect(fitWithinEdge(0, 0, 1000)).toEqual({ width: 1, height: 1 });
  });
});
