// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// in Node without skip-guards.
//
// TODO(test-env): page deletion is a pure pdf-lib operation with no browser deps;
// all tests here are expected to pass without a browser environment.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deletePdfPagesDescriptor } from "./delete-pdf-pages";
import { parsePageList } from "./page-ranges";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-split", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// Build an n-page PDF where page i (1-based) has a UNIQUE width of 100+i points.
// The width then acts as a label, so after a deletion we can read each surviving
// page's width and assert EXACTLY which original pages remain, and in what order.
async function makeLabeledPdf(n: number): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 1; i <= n; i++) doc.addPage([100 + i, 200]);
  const bytes = await doc.save();
  return new File([new Uint8Array(bytes)], `labeled-${n}.pdf`, {
    type: "application/pdf",
  });
}

// The 1-based original page numbers surviving in `blob`, in document order,
// recovered from each page's labelled width (see makeLabeledPdf).
async function survivingPages(blob: Blob): Promise<number[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await blob.arrayBuffer());
  return doc.getPages().map((p) => Math.round(p.getWidth()) - 100);
}

// Mirror the UI: the delete tool parses the typed range with parsePageList and
// hands the engine a compact range string of that exact set. This helper runs the
// same path so the tests cover what the field actually produces.
function rangeStringFor(input: string, pageCount: number): string {
  const parsed = parsePageList(input, pageCount);
  return parsed.pages.join(",");
}

describe("deletePdfPagesDescriptor", () => {
  it("deletes a single page from a 3-page PDF and produces a 2-page PDF", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await deletePdfPagesDescriptor.convert({
      file,
      options: { pages: "2" },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("three-pages-pages-deleted.pdf");
    expect(result.outputSize).toBeGreaterThan(0);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(2);
  });

  it("deletes a range of pages leaving the correct remainder", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await deletePdfPagesDescriptor.convert({
      file,
      options: { pages: "1-2" },
    });

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(1);
  });

  it("returns the unmodified PDF when the page range is empty", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await deletePdfPagesDescriptor.convert({
      file,
      options: { pages: "" },
    });

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(3);
  });

  it("rejects deleting all pages as UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      deletePdfPagesDescriptor.convert({ file, options: { pages: "1-3" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "image.png", {
      type: "image/png",
    });
    await expect(
      deletePdfPagesDescriptor.convert({ file, options: { pages: "1" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      deletePdfPagesDescriptor.convert({ file, options: { pages: "1" }, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── Print-style range field: delete EXACTLY the parsed set ─────────────────
  // These mirror the new PageRangeField path in DeletePdfPagesTool, where the
  // typed string is parsed by parsePageList and the engine deletes that exact set.

  it("deletes a contiguous typed range '5-10' leaving exactly the rest in order", async () => {
    const file = await makeLabeledPdf(12);
    const pages = rangeStringFor("5-10", 12); // → "5,6,7,8,9,10"
    const result = await deletePdfPagesDescriptor.convert({ file, options: { pages } });
    expect(await survivingPages(result.blob)).toEqual([1, 2, 3, 4, 11, 12]);
  });

  it("deletes a mixed list '1,3,6-8' as exactly {1,3,6,7,8}", async () => {
    const file = await makeLabeledPdf(10);
    const pages = rangeStringFor("1,3,6-8", 10); // → "1,3,6,7,8"
    const result = await deletePdfPagesDescriptor.convert({ file, options: { pages } });
    // Remaining originals, in their original relative order.
    expect(await survivingPages(result.blob)).toEqual([2, 4, 5, 9, 10]);
  });

  it("deletes a non-contiguous set '2,4' without disturbing the others' order", async () => {
    const file = await makeLabeledPdf(5);
    const result = await deletePdfPagesDescriptor.convert({ file, options: { pages: "2,4" } });
    expect(await survivingPages(result.blob)).toEqual([1, 3, 5]);
  });

  it("treats a reversed/duplicated typed range the same as its sorted set", async () => {
    const file = await makeLabeledPdf(6);
    // parsePageList sorts + de-dupes "4-2, 2, 3" → {2,3,4}.
    const pages = rangeStringFor("4-2, 2, 3", 6);
    expect(pages).toBe("2,3,4");
    const result = await deletePdfPagesDescriptor.convert({ file, options: { pages } });
    expect(await survivingPages(result.blob)).toEqual([1, 5, 6]);
  });

  it("rejects deleting every page via the full parsed set as UNSUPPORTED_INPUT", async () => {
    const file = await makeLabeledPdf(4);
    const pages = rangeStringFor("1-4", 4); // → "1,2,3,4"
    await expect(
      deletePdfPagesDescriptor.convert({ file, options: { pages } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });
});
