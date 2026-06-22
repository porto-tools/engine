// pdf-lib is pure JavaScript and embedJpg/embedPng work in Node, so the
// happy-path tests run for real — no skip-guard needed. UNSUPPORTED_INPUT
// and CANCELLED also run unconditionally.
//
// TODO(test-env): embedPng/embedJpg rely on pure-JS decoders in pdf-lib; all
// tests here are expected to pass without a browser environment.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { imagesToPdfDescriptor, layoutImage } from "./images-to-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, type: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type });
}

describe("imagesToPdfDescriptor", () => {
  it("converts a single JPG to a one-page PDF", async () => {
    const img = await fileFromFixture("tiny.jpg", "image/jpeg");
    const result = await imagesToPdfDescriptor.convert({ file: img, files: [img] });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("images.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(img.size);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(1);
  });

  it("converts a single PNG to a one-page PDF", async () => {
    const img = await fileFromFixture("tiny.png", "image/png");
    const result = await imagesToPdfDescriptor.convert({ file: img, files: [img] });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.outputSize).toBeGreaterThan(0);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(1);
  });

  // The multi-input staging flow used to hard-require ≥2 files even though the
  // engine accepts 1. minInputs lets the descriptor opt the UI guard down to 1.
  it("declares minInputs 1 so the staging flow accepts a single image", () => {
    expect(imagesToPdfDescriptor.minInputs).toBe(1);
  });

  it("converts a single image passed as `file` only (no files array) to a 1-page PDF", async () => {
    // The single-image case the UI now allows: one staged file, merged default.
    // Exercises `allFiles = files ?? [input.file]` with files absent.
    const img = await fileFromFixture("tiny.png", "image/png");
    const result = await imagesToPdfDescriptor.convert({ file: img });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.outputs).toBeUndefined(); // merged default → single ResultCard
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(img.size);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(1);
  });

  it("combines a JPG and a PNG into a two-page PDF", async () => {
    const jpg = await fileFromFixture("tiny.jpg", "image/jpeg");
    const png = await fileFromFixture("tiny.png", "image/png");
    const files = [jpg, png];

    const result = await imagesToPdfDescriptor.convert({ file: files[0], files });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.inputSize).toBe(jpg.size + png.size);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(2);
  });

  it("rejects unsupported file types as UNSUPPORTED_INPUT", async () => {
    const webp = await fileFromFixture("tiny.webp", "image/webp");
    await expect(
      imagesToPdfDescriptor.convert({ file: webp, files: [webp] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const img = await fileFromFixture("tiny.jpg", "image/jpeg");
    await expect(
      imagesToPdfDescriptor.convert({ file: img, files: [img], signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── output: "merged" (default) — single merged PDF, NO outputs[] ─────────────
  it("default output merges all images into one PDF with no outputs[] array", async () => {
    const jpg = await fileFromFixture("tiny.jpg", "image/jpeg");
    const png = await fileFromFixture("tiny.png", "image/png");
    const files = [jpg, png];

    const result = await imagesToPdfDescriptor.convert({ file: files[0], files });

    // Byte-compatible with the original single-output path: no outputs[], normal
    // single-file fields, and every image is one page in the one PDF.
    expect(result.outputs).toBeUndefined();
    expect(result.filename).toBe("images.pdf");

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(files.length);
  });

  it("explicit output:\"merged\" is identical to the default (no outputs[])", async () => {
    const jpg = await fileFromFixture("tiny.jpg", "image/jpeg");
    const png = await fileFromFixture("tiny.png", "image/png");
    const files = [jpg, png];

    const result = await imagesToPdfDescriptor.convert({
      file: files[0],
      files,
      options: { output: "merged" },
    });

    expect(result.outputs).toBeUndefined();
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(2);
  });

  // ── output: "per-image" — one PDF per image, returned as outputs[] ───────────
  it("per-image emits one 1-page PDF per image, named after each image", async () => {
    const jpg = await fileFromFixture("tiny.jpg", "image/jpeg");
    const png = await fileFromFixture("tiny.png", "image/png");
    const files = [jpg, png];

    const result = await imagesToPdfDescriptor.convert({
      file: files[0],
      files,
      options: { output: "per-image" },
    });

    // N images → N outputs, each named <image>.pdf, each a valid 1-page PDF.
    expect(result.outputs).toBeDefined();
    expect(result.outputs).toHaveLength(files.length);
    expect(result.outputs!.map((o) => o.filename)).toEqual(["tiny.pdf", "tiny-2.pdf"]);

    const { PDFDocument } = await import("pdf-lib");
    for (const output of result.outputs!) {
      expect(output.mimeType).toBe("application/pdf");
      expect(output.size).toBeGreaterThan(0);
      const doc = await PDFDocument.load(await output.blob.arrayBuffer());
      expect(doc.getPageCount()).toBe(1);
    }

    // Top-level blob/filename mirror the first output (representative entry),
    // matching how pdf-split returns multi-output.
    expect(result.filename).toBe(result.outputs![0].filename);
    expect(result.outputSize).toBe(result.outputs!.reduce((sum, o) => sum + o.size, 0));
  });

  it("per-image replaces the image extension with .pdf, preserving the stem", async () => {
    // Distinct stems should map cleanly to "<stem>.pdf" with no disambiguation.
    const bytesA = await readFile(fixturePath("tiny.jpg"));
    const bytesB = await readFile(fixturePath("tiny.png"));
    const a = new File([bytesA], "photo.jpg", { type: "image/jpeg" });
    const b = new File([bytesB], "scan.png", { type: "image/png" });

    const result = await imagesToPdfDescriptor.convert({
      file: a,
      files: [a, b],
      options: { output: "per-image" },
    });

    expect(result.outputs!.map((o) => o.filename)).toEqual(["photo.pdf", "scan.pdf"]);
  });

  it("per-image disambiguates images that map to the same PDF name", async () => {
    // "page.jpg" and "page.png" both reduce to "page.pdf"; the collision gets a
    // "-2" suffix. A third "page.jpg" collides again and gets "-3".
    const jpgBytes = await readFile(fixturePath("tiny.jpg"));
    const pngBytes = await readFile(fixturePath("tiny.png"));
    const a = new File([jpgBytes], "page.jpg", { type: "image/jpeg" });
    const b = new File([pngBytes], "page.png", { type: "image/png" });
    const c = new File([jpgBytes], "page.jpg", { type: "image/jpeg" });

    const result = await imagesToPdfDescriptor.convert({
      file: a,
      files: [a, b, c],
      options: { output: "per-image" },
    });

    expect(result.outputs).toHaveLength(3);
    expect(result.outputs!.map((o) => o.filename)).toEqual(["page.pdf", "page-2.pdf", "page-3.pdf"]);
  });

  it("per-image reports progress and respects an already-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const img = await fileFromFixture("tiny.jpg", "image/jpeg");
    await expect(
      imagesToPdfDescriptor.convert({
        file: img,
        files: [img],
        options: { output: "per-image" },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("layoutImage", () => {
  it("fit + no margin reproduces the original page-is-the-image layout", () => {
    expect(layoutImage(800, 600, "fit", "auto", 0)).toEqual({
      pageW: 800,
      pageH: 600,
      drawX: 0,
      drawY: 0,
      drawW: 800,
      drawH: 600,
    });
  });

  it("fit + margin pads the page by the margin on every side", () => {
    const l = layoutImage(800, 600, "fit", "auto", 18);
    expect(l).toEqual({ pageW: 836, pageH: 636, drawX: 18, drawY: 18, drawW: 800, drawH: 600 });
  });

  it("A4 auto gives a landscape page for a wide image and centres the fit", () => {
    const l = layoutImage(1000, 500, "a4", "auto", 0);
    // wide image → landscape A4 (841.89 × 595.28)
    expect(l.pageW).toBeCloseTo(841.89, 2);
    expect(l.pageH).toBeCloseTo(595.28, 2);
    // 2:1 image scaled to fit width → drawH < pageH, centred vertically
    expect(l.drawW).toBeCloseTo(841.89, 2);
    expect(l.drawH).toBeCloseTo(420.945, 2);
    expect(l.drawX).toBeCloseTo(0, 2);
    expect(l.drawY).toBeCloseTo((595.28 - 420.945) / 2, 2);
  });

  it("A4 portrait forced keeps a portrait page regardless of image shape", () => {
    const l = layoutImage(1000, 500, "a4", "portrait", 0);
    expect(l.pageW).toBeCloseTo(595.28, 2);
    expect(l.pageH).toBeCloseTo(841.89, 2);
  });

  it("margin shrinks the centred draw rect on a standard page", () => {
    const noMargin = layoutImage(400, 400, "a4", "portrait", 0);
    const withMargin = layoutImage(400, 400, "a4", "portrait", 18);
    // Same page size, but the available box (and so the drawn image) is smaller.
    expect(withMargin.pageW).toBeCloseTo(noMargin.pageW, 2);
    expect(withMargin.pageH).toBeCloseTo(noMargin.pageH, 2);
    expect(withMargin.drawW).toBeLessThan(noMargin.drawW);
    expect(withMargin.drawH).toBeLessThan(noMargin.drawH);
    // A square image is width-bound on portrait A4; the draw width equals the
    // page width minus both margins, and the rect stays centred.
    expect(withMargin.drawW).toBeCloseTo(595.28 - 2 * 18, 2);
    expect(withMargin.drawX).toBeCloseTo(18, 2);
  });

  it("Legal / A3 / A5 presets resolve to their PostScript-point sizes", () => {
    expect(layoutImage(100, 200, "legal", "portrait", 0)).toMatchObject({ pageW: 612, pageH: 1008 });
    const a3 = layoutImage(100, 200, "a3", "portrait", 0);
    expect(a3.pageW).toBeCloseTo(841.89, 2);
    expect(a3.pageH).toBeCloseTo(1190.55, 2);
    const a5 = layoutImage(100, 200, "a5", "portrait", 0);
    expect(a5.pageW).toBeCloseTo(419.53, 2);
    expect(a5.pageH).toBeCloseTo(595.28, 2);
  });

  it("Legal auto picks a landscape page for a wide image", () => {
    const l = layoutImage(1400, 400, "legal", "auto", 0);
    // wide image → swap to landscape Legal (1008 × 612)
    expect(l.pageW).toBeCloseTo(1008, 2);
    expect(l.pageH).toBeCloseTo(612, 2);
  });
});
