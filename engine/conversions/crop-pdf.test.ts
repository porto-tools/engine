// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// for real in Node (no skip-guard needed). cropRect is a pure helper, so its
// units run synchronously. We reuse the flatten-pdf fixture (any valid PDF) for
// the descriptor round-trip, since cropping only sets crop boxes.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cropPdfDescriptor, cropRect } from "./crop-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  join(HERE, "__fixtures__", "flatten-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// Build a fresh N-page PDF in memory (each page 600x800) and wrap it as a File,
// so the page-scope tests can assert exactly which pages' crop boxes changed.
async function multiPageFile(pages: number, name = "multi.pdf"): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([600, 800]);
  }
  const bytes = await doc.save();
  // Copy into a fresh ArrayBuffer-backed view so the File() BlobPart type is
  // ArrayBuffer (not the ArrayBufferLike pdf-lib's save() returns).
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

describe("cropRect", () => {
  it("returns the full box unchanged with zero margins", () => {
    const r = cropRect(0, 0, 1000, 800, { top: 0, right: 0, bottom: 0, left: 0 });
    expect(r).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it("insets x by 100 and width by 200 for left:10/right:10 on a 1000-wide box", () => {
    const r = cropRect(0, 0, 1000, 800, { top: 0, right: 10, bottom: 0, left: 10 });
    expect(r.x).toBe(100);
    expect(r.width).toBe(800);
    // Vertical untouched.
    expect(r.y).toBe(0);
    expect(r.height).toBe(800);
  });

  it("falls back to the full box on an over-crop (left:50/right:50)", () => {
    const r = cropRect(0, 0, 1000, 800, { top: 0, right: 50, bottom: 0, left: 50 });
    expect(r).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });
});

describe("cropPdfDescriptor", () => {
  it("crops a PDF and produces a valid PDF output", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await cropPdfDescriptor.convert({
      file,
      options: { marginTop: 5, marginRight: 5, marginBottom: 5, marginLeft: 5 },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("tiny.pdf");
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
    await expect(cropPdfDescriptor.convert({ file })).rejects.toMatchObject({
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
    await expect(cropPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.pdf");
    await expect(
      cropPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it('crops EVERY page by default (pageScope omitted) — unchanged behavior', async () => {
    const file = await multiPageFile(3);
    const result = await cropPdfDescriptor.convert({
      file,
      options: { marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10 },
    });

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(await result.blob.arrayBuffer());
    const pages = reloaded.getPages();
    expect(pages).toHaveLength(3);
    // With a 10% inset on every side of a 600x800 page, each page's crop box
    // shrinks to 480x640. Every page must be cropped.
    for (const page of pages) {
      const c = page.getCropBox();
      expect(c.width).toBeCloseTo(480, 5);
      expect(c.height).toBeCloseTo(640, 5);
    }
  });

  it('with pageScope="current" crops ONLY the selected page, leaving the rest full', async () => {
    const file = await multiPageFile(3);
    const result = await cropPdfDescriptor.convert({
      file,
      options: {
        marginTop: 10,
        marginRight: 10,
        marginBottom: 10,
        marginLeft: 10,
        pageScope: "current",
        currentPage: 2,
      },
    });

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(await result.blob.arrayBuffer());
    const pages = reloaded.getPages();
    expect(pages).toHaveLength(3);

    // Page 1 and 3 keep their full 600x800 box; page 2 is cropped to 480x640.
    const p1 = pages[0].getCropBox();
    expect(p1.width).toBeCloseTo(600, 5);
    expect(p1.height).toBeCloseTo(800, 5);

    const p2 = pages[1].getCropBox();
    expect(p2.width).toBeCloseTo(480, 5);
    expect(p2.height).toBeCloseTo(640, 5);

    const p3 = pages[2].getCropBox();
    expect(p3.width).toBeCloseTo(600, 5);
    expect(p3.height).toBeCloseTo(800, 5);
  });

  it('with pageScope="current" defaults to page 1 when currentPage is omitted', async () => {
    const file = await multiPageFile(3);
    const result = await cropPdfDescriptor.convert({
      file,
      options: {
        marginTop: 10,
        marginRight: 10,
        marginBottom: 10,
        marginLeft: 10,
        pageScope: "current",
      },
    });

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(await result.blob.arrayBuffer());
    const pages = reloaded.getPages();
    expect(pages[0].getCropBox().width).toBeCloseTo(480, 5);
    expect(pages[1].getCropBox().width).toBeCloseTo(600, 5);
    expect(pages[2].getCropBox().width).toBeCloseTo(600, 5);
  });

  it('treats an unknown pageScope as "all" (defensive)', async () => {
    const file = await multiPageFile(3);
    const result = await cropPdfDescriptor.convert({
      file,
      options: {
        marginTop: 10,
        marginRight: 10,
        marginBottom: 10,
        marginLeft: 10,
        pageScope: "nonsense",
      },
    });

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(await result.blob.arrayBuffer());
    for (const page of reloaded.getPages()) {
      expect(page.getCropBox().width).toBeCloseTo(480, 5);
    }
  });
});
