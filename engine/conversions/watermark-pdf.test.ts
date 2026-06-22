// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// for real in Node (no skip-guard needed). The test PDF is generated in-process
// with pdf-lib rather than read from a binary fixture, which keeps the watermark
// test fully self-contained. We do not assert that the output is smaller than the
// input: stamping a watermark adds content, so the output is expected to grow.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  watermarkPdfDescriptor,
  centeredOrigin,
  tileStep,
  tileStepImage,
  tilePlacements,
  opacityAlpha,
  scaledLogoSize,
} from "./watermark-pdf";

// Build a small, valid multi-page PDF in memory so the test needs no fixture file.
// `size` defaults to US Letter; tests that exercise vertical tile density pass a
// tall page so the mosaic spans many rows.
async function makePdfFile(
  name = "doc.pdf",
  pages = 2,
  size: [number, number] = [612, 792],
): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage(size);
  }
  const bytes = await doc.save();
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

// A real, minimal 1×1 opaque-red PNG (8-bit RGBA). pdf-lib's embedPng decodes
// this with no canvas/DOM, so the image-watermark path runs for real in Node.
// Bytes are the standard signature + IHDR + IDAT + IEND chunks with valid CRCs.
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1 height=1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // bitdepth/colortype/... + CRC
  0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, // IDAT length + type
  0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, // zlib stream
  0x00, 0x05, 0x05, 0x02, 0x00,
  0xa6, 0xa1, 0x67, 0xa1, // IDAT CRC
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82,
]);

function makePngFile(name = "logo.png"): File {
  return new File([PNG_1X1], name, { type: "image/png" });
}

describe("watermarkPdfDescriptor", () => {
  it("stamps a watermark and produces a valid PDF output", async () => {
    const file = await makePdfFile("doc.pdf", 2);
    const result = await watermarkPdfDescriptor.convert({
      file,
      options: { text: "CONFIDENTIAL", placement: "center", rotation: "45", opacity: 30, fontSize: 48 },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("doc.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    // The output bytes must be a real PDF (start with %PDF).
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    const header = String.fromCharCode(...outBytes.slice(0, 4));
    expect(header).toBe("%PDF");

    // Round-trip: same page count as the original.
    const { PDFDocument } = await import("pdf-lib");
    const original = await PDFDocument.load(await file.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    expect(reloaded.getPageCount()).toBe(original.getPageCount());
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(watermarkPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects corrupt PDF bytes as DECODE_FAILED", async () => {
    const file = new File(
      [new TextEncoder().encode("this is not a pdf at all")],
      "broken.pdf",
      { type: "application/pdf" },
    );
    await expect(watermarkPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await makePdfFile("doc.pdf", 1);
    await expect(
      watermarkPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// Spy on every drawText call the converter makes by patching PDFPage.prototype.
// pdf-lib is the same module instance the converter dynamically imports, so the
// spy captures the real draw calls without a DOM or a fixture.
async function spyOnDrawText(): Promise<ReturnType<typeof vi.spyOn>> {
  const { PDFPage } = await import("pdf-lib");
  return vi.spyOn(PDFPage.prototype, "drawText");
}

// The image-path counterpart: spy on drawImage so the image-watermark tests can
// assert the logo is stamped (and only on the selected pages) without rendering.
async function spyOnDrawImage(): Promise<ReturnType<typeof vi.spyOn>> {
  const { PDFPage } = await import("pdf-lib");
  return vi.spyOn(PDFPage.prototype, "drawImage");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("watermark depth: mosaic, rotation, opacity, page range", () => {
  it("tiled placement draws many watermarks per page, centered draws one", async () => {
    const spyCenter = await spyOnDrawText();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { text: "DRAFT", placement: "center" },
    });
    expect(spyCenter).toHaveBeenCalledTimes(1); // one centred stamp on the single page
    vi.restoreAllMocks();

    const spyTile = await spyOnDrawText();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { text: "DRAFT", placement: "tile" },
    });
    // The mosaic stamps a full grid, so far more than one drawText per page.
    expect(spyTile.mock.calls.length).toBeGreaterThan(1);
  });

  it("threads the selected rotation through to each drawText call", async () => {
    const { degrees } = await import("pdf-lib");
    const spy = await spyOnDrawText();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { text: "DRAFT", placement: "center", rotation: "90" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][1] as { rotate?: unknown };
    // pdf-lib's degrees(90) is what the converter must pass for a 90° watermark.
    expect(opts.rotate).toEqual(degrees(90));
  });

  it("maps the opacity percentage to the 0..1 alpha drawText receives", async () => {
    const spy = await spyOnDrawText();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { text: "DRAFT", placement: "center", opacity: 75 },
    });
    const opts = spy.mock.calls[0][1] as { opacity?: number };
    expect(opts.opacity).toBeCloseTo(0.75, 10);
  });

  it("only watermarks the pages named in the page range", async () => {
    const spy = await spyOnDrawText();
    // A 4-page doc; range "2,4" must produce exactly two centred stamps total.
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 4),
      options: { text: "DRAFT", placement: "center", pages: "2,4" },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("watermarks every page when the page range is blank (default)", async () => {
    const spy = await spyOnDrawText();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 3),
      options: { text: "DRAFT", placement: "center", pages: "" },
    });
    expect(spy).toHaveBeenCalledTimes(3); // one centred stamp on each of the 3 pages
  });
});

describe("image / logo watermark", () => {
  it("embeds the logo and stamps it once (centered) on a valid PDF", async () => {
    const spy = await spyOnDrawImage();
    const result = await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { watermarkType: "image", logoFile: makePngFile(), placement: "center" },
    });

    // The logo is drawn exactly once on the single page.
    expect(spy).toHaveBeenCalledTimes(1);

    // The output is a real, page-count-preserving PDF.
    expect(result.mimeType).toBe("application/pdf");
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(outBytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("tiled image placement stamps the logo many times per page", async () => {
    const spy = await spyOnDrawImage();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { watermarkType: "image", logoFile: makePngFile(), placement: "tile" },
    });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it("tiles the image mosaic across MULTIPLE rows on a tall page (dense vertical tiling)", async () => {
    const spy = await spyOnDrawImage();
    // A deliberately tall page (300 wide × 2400 tall). The image mosaic must step
    // on the drawn logo footprint (tileStepImage), not the text tileStep, so the
    // logo repeats down the whole page — many rows, not the 1-2 rows the old
    // height-as-fontSize step produced. We count DISTINCT y placements: more than
    // one means the mosaic genuinely tiled vertically.
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("tall.pdf", 1, [300, 2400]),
      options: { watermarkType: "image", logoFile: makePngFile(), placement: "tile" },
    });

    const yValues = spy.mock.calls.map((call: unknown[]) => (call[1] as { y: number }).y);
    const distinctRows = new Set(yValues);
    // Vertical density: clearly more than a single row of stamps.
    expect(distinctRows.size).toBeGreaterThan(2);

    // Cross-check against the pure helper: the same step the converter uses gives
    // the expected number of rows for this page, confirming we stepped on the logo
    // footprint rather than collapsing to 1-2 rows.
    const { width: drawW, height: drawH } = scaledLogoSize(1, 1, 300, 2400);
    const { stepY } = tileStepImage(drawW, drawH);
    const expectedRows = tilePlacements(300, 2400, tileStepImage(drawW, drawH).stepX, stepY)
      .reduce((rows, p) => rows.add(p.y), new Set<number>()).size;
    expect(distinctRows.size).toBe(expectedRows);
    expect(expectedRows).toBeGreaterThan(2);
  });

  it("threads rotation and opacity through to each drawImage call", async () => {
    const { degrees } = await import("pdf-lib");
    const spy = await spyOnDrawImage();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: {
        watermarkType: "image",
        logoFile: makePngFile(),
        placement: "center",
        rotation: "90",
        opacity: 75,
      },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][1] as { rotate?: unknown; opacity?: number };
    expect(opts.rotate).toEqual(degrees(90));
    expect(opts.opacity).toBeCloseTo(0.75, 10);
  });

  it("honours the page range in image mode", async () => {
    const spy = await spyOnDrawImage();
    // 4-page doc, range "2,4" → exactly two centered logo stamps total.
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 4),
      options: { watermarkType: "image", logoFile: makePngFile(), placement: "center", pages: "2,4" },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rejects image mode with no logo as a recoverable error", async () => {
    await expect(
      watermarkPdfDescriptor.convert({
        file: await makePdfFile("doc.pdf", 1),
        options: { watermarkType: "image" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects a non-image logo file as a recoverable error", async () => {
    const notAnImage = new File([new TextEncoder().encode("nope")], "logo.txt", { type: "text/plain" });
    await expect(
      watermarkPdfDescriptor.convert({
        file: await makePdfFile("doc.pdf", 1),
        options: { watermarkType: "image", logoFile: notAnImage },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("does NOT draw any text in image mode", async () => {
    const textSpy = await spyOnDrawText();
    const imageSpy = await spyOnDrawImage();
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { watermarkType: "image", logoFile: makePngFile(), placement: "center" },
    });
    expect(textSpy).not.toHaveBeenCalled();
    expect(imageSpy).toHaveBeenCalledTimes(1);
  });

  it("text mode is unchanged: defaulting watermarkType still draws text, not images", async () => {
    const textSpy = await spyOnDrawText();
    const imageSpy = await spyOnDrawImage();
    // No watermarkType → defaults to "text"; a stray logoFile must be ignored.
    await watermarkPdfDescriptor.convert({
      file: await makePdfFile("doc.pdf", 1),
      options: { text: "DRAFT", placement: "center", logoFile: makePngFile() },
    });
    expect(textSpy).toHaveBeenCalledTimes(1);
    expect(imageSpy).not.toHaveBeenCalled();
  });
});

describe("scaledLogoSize", () => {
  it("scales the logo's longest edge to ~40% of the page's shortest edge, keeping aspect", () => {
    // 100×50 logo on a 600×800 page: shortest page edge 600, target 240, longest
    // logo edge 100 → scale 2.4 → 240×120 (aspect 2:1 preserved).
    const { width, height } = scaledLogoSize(100, 50, 600, 800);
    expect(width).toBeCloseTo(240, 6);
    expect(height).toBeCloseTo(120, 6);
    expect(width / height).toBeCloseTo(2, 10);
  });

  it("falls back to a 1×1 box for degenerate input instead of dividing by zero", () => {
    const { width, height } = scaledLogoSize(0, 0, 600, 800);
    expect(Number.isFinite(width)).toBe(true);
    expect(Number.isFinite(height)).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe("tilePlacements / tileStep / opacityAlpha (pure helpers)", () => {
  it("returns the expected mosaic coordinate grid for a page size and step", () => {
    // A 200×100 page stepped by 120×60 covers x at {0,120,240} and y at {0,60,120}
    // (the loop runs while the cursor is below page + step, reaching the far edge).
    const coords = tilePlacements(200, 100, 120, 60);
    expect(coords).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 240, y: 0 },
      { x: 0, y: 60 },
      { x: 120, y: 60 },
      { x: 240, y: 60 },
      { x: 0, y: 120 },
      { x: 120, y: 120 },
      { x: 240, y: 120 },
    ]);
  });

  it("never loops on a non-advancing step", () => {
    expect(tilePlacements(200, 100, 0, 60)).toEqual([]);
    expect(tilePlacements(200, 100, 120, 0)).toEqual([]);
  });

  it("derives tile spacing from the text footprint with a sane floor", () => {
    // Below the 120 floor, stepX uses the floor; above it, the text width drives it.
    expect(tileStep(40, 48)).toEqual({ stepX: 120 + 80, stepY: 48 + 120 });
    expect(tileStep(300, 48)).toEqual({ stepX: 300 + 80, stepY: 48 + 120 });
  });

  it("derives IMAGE tile spacing from the drawn stamp size (stepY tracks the logo height)", () => {
    // tileStepImage steps on the real drawn footprint so the logo mosaic tiles
    // densely down the page. stepX keeps the 120 floor; stepY follows drawH (NOT a
    // font size), so a tall stamp still yields many rows on a tall page.
    expect(tileStepImage(40, 60)).toEqual({ stepX: 120 + 80, stepY: 60 + 120 });
    expect(tileStepImage(300, 200)).toEqual({ stepX: 300 + 80, stepY: 200 + 120 });
  });

  it("maps opacity presets to the right alpha", () => {
    expect(opacityAlpha(25)).toBeCloseTo(0.25, 10);
    expect(opacityAlpha(50)).toBeCloseTo(0.5, 10);
    expect(opacityAlpha(75)).toBeCloseTo(0.75, 10);
    expect(opacityAlpha(100)).toBeCloseTo(1, 10);
  });
});

describe("centeredOrigin", () => {
  it("places an unrotated text exactly at the page centre", () => {
    const pageW = 612;
    const pageH = 792;
    const textW = 240;
    const textH = 48;
    const { x, y } = centeredOrigin(pageW, pageH, textW, textH, 0);
    // deg=0 → cos=1, sin=0, so the origin is simply the bottom-left of a centred box.
    expect(x).toBeCloseTo((pageW - textW) / 2, 10);
    expect(y).toBeCloseTo((pageH - textH) / 2, 10);
  });

  it("keeps a 90°-rotated text near the page centre with finite coordinates", () => {
    const pageW = 612;
    const pageH = 792;
    const textW = 240;
    const textH = 48;
    const deg = 90;
    const { x, y } = centeredOrigin(pageW, pageH, textW, textH, deg);

    // Compute the expected origin with the same cos/sin pivot math the helper uses.
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const mx = cos * (textW / 2) - sin * (textH / 2);
    const my = sin * (textW / 2) + cos * (textH / 2);
    const expectedX = pageW / 2 - mx;
    const expectedY = pageH / 2 - my;

    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(x).toBeCloseTo(expectedX, 10);
    expect(y).toBeCloseTo(expectedY, 10);

    // The rotated midpoint must land back on the page centre, confirming the text
    // stays centred regardless of the rotation pivot.
    const midX = x + mx;
    const midY = y + my;
    expect(midX).toBeCloseTo(pageW / 2, 10);
    expect(midY).toBeCloseTo(pageH / 2, 10);
  });
});
