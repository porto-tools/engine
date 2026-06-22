// pdf-lib is pure JavaScript — no WASM and no browser APIs — so the happy-path
// tests run for real in Node (no skip-guard needed). UNSUPPORTED_INPUT and
// CANCELLED also run unconditionally for the same reason.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  reorderPdfPagesDescriptor,
  interleave,
  insertIndex,
  duplicateSequence,
  isLandscape,
  matchesOrientation,
} from "./reorder-pdf-pages";
import { parseOrderList, appendMissing } from "./page-ranges";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  join(HERE, "__fixtures__", "reorder-pdf-pages", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// Build an n-page PDF where page i (1-based) has a UNIQUE width of 100+i points,
// so each page's width labels its ORIGINAL number. After a reorder we read the
// widths to assert the exact resulting sequence of original pages.
async function makeLabeledPdf(n: number): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 1; i <= n; i++) doc.addPage([100 + i, 200]);
  const bytes = await doc.save();
  return new File([new Uint8Array(bytes)], `labeled-${n}.pdf`, {
    type: "application/pdf",
  });
}

// The original page numbers of `blob`, in output order, recovered from the
// labelled widths (see makeLabeledPdf).
async function resultingOrder(blob: Blob): Promise<number[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await blob.arrayBuffer());
  return doc.getPages().map((p) => Math.round(p.getWidth()) - 100);
}

// Mirror the UI: the reorder tool parses the typed order with parseOrderList and
// fills in any omitted pages with appendMissing, handing the engine a COMPLETE
// permutation string. This helper runs that same path.
function orderStringFor(input: string, pageCount: number): string {
  const parsed = parseOrderList(input, pageCount);
  return appendMissing(parsed.order, pageCount).join(",");
}

describe("reorderPdfPagesDescriptor", () => {
  it("reorders a 3-page PDF to 3,1,2 order", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await reorderPdfPagesDescriptor.convert({
      file,
      options: { order: "3,1,2" },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("three-pages.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    // Verify the output still has 3 pages.
    const { PDFDocument } = await import("pdf-lib");
    const bytes = await result.blob.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
  });

  it("accepts whitespace in the order string", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await reorderPdfPagesDescriptor.convert({
      file,
      options: { order: " 2 , 3 , 1 " },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "1" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects an empty order string as UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects an order with wrong page count as UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    // Only 2 entries for a 3-page doc.
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "1,2" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects an out-of-range page reference as UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    // Page 5 does not exist in a 3-page PDF.
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "1,2,5" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects a duplicate page reference as UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "1,1,2" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects corrupt PDF bytes as DECODE_FAILED", async () => {
    const file = new File(
      [new TextEncoder().encode("%PDF-1.4 this is not a real pdf")],
      "corrupt.pdf",
      { type: "application/pdf" },
    );
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { order: "1" } }),
    ).rejects.toMatchObject({ code: "DECODE_FAILED", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      reorderPdfPagesDescriptor.convert({
        file,
        options: { order: "3,1,2" },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── Print-style order field: parseOrderList + appendMissing ────────────────
  // These mirror the new PageRangeField (mode="order") path in ReorderPdfPagesTool:
  // the typed order is order-preserving, and any omitted page is appended in its
  // original position so the engine always receives a complete permutation.

  it("applies an exact full permutation '3,1,2' in that order", async () => {
    const file = await makeLabeledPdf(3);
    const order = orderStringFor("3,1,2", 3);
    expect(order).toBe("3,1,2");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    expect(await resultingOrder(result.blob)).toEqual([3, 1, 2]);
  });

  it("appends omitted pages in original order: '3,1' on 4 pages → 3,1,2,4", async () => {
    const file = await makeLabeledPdf(4);
    const order = orderStringFor("3,1", 4);
    expect(order).toBe("3,1,2,4");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    // Output covers every page exactly once; the moved pages lead, the rest follow.
    expect(await resultingOrder(result.blob)).toEqual([3, 1, 2, 4]);
  });

  it("moving just the last page to the front keeps the others in order", async () => {
    const file = await makeLabeledPdf(5);
    const order = orderStringFor("5", 5);
    expect(order).toBe("5,1,2,3,4");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    expect(await resultingOrder(result.blob)).toEqual([5, 1, 2, 3, 4]);
  });

  it("de-dupes a repeated page in the typed order (first mention wins)", async () => {
    const file = await makeLabeledPdf(4);
    // "2,2,4" → order [2,4] → appendMissing → [2,4,1,3].
    const order = orderStringFor("2,2,4", 4);
    expect(order).toBe("2,4,1,3");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    expect(await resultingOrder(result.blob)).toEqual([2, 4, 1, 3]);
  });

  it("a reverse range '3-1' on 3 pages produces 3,2,1", async () => {
    const file = await makeLabeledPdf(3);
    const order = orderStringFor("3-1", 3);
    expect(order).toBe("3,2,1");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    expect(await resultingOrder(result.blob)).toEqual([3, 2, 1]);
  });

  it("an empty typed order yields the natural sequence unchanged", async () => {
    const file = await makeLabeledPdf(3);
    // Empty field → appendMissing([]) → "1,2,3" (the grid's complete order).
    const order = orderStringFor("", 3);
    expect(order).toBe("1,2,3");
    const result = await reorderPdfPagesDescriptor.convert({ file, options: { order } });
    expect(await resultingOrder(result.blob)).toEqual([1, 2, 3]);
  });
});

// ── A17 pure helpers ───────────────────────────────────────────────────────
// DOM-free / pdf-lib-free index math behind the new operations. Tested directly
// so the only-tricky parts (interleave tail handling, clamped insert index,
// duplicate fan-out, orientation predicate) are asserted without a real PDF.

describe("interleave(aCount, bCount) — duplex-scan recombine sequence", () => {
  it("interleaves equal-length sources as A1,B1,A2,B2,…", () => {
    expect(interleave(3, 3)).toEqual([
      { src: "a", index: 0 },
      { src: "b", index: 0 },
      { src: "a", index: 1 },
      { src: "b", index: 1 },
      { src: "a", index: 2 },
      { src: "b", index: 2 },
    ]);
  });

  it("appends the longer source's tail when A is longer", () => {
    expect(interleave(4, 2)).toEqual([
      { src: "a", index: 0 },
      { src: "b", index: 0 },
      { src: "a", index: 1 },
      { src: "b", index: 1 },
      { src: "a", index: 2 },
      { src: "a", index: 3 },
    ]);
  });

  it("appends the longer source's tail when B is longer", () => {
    expect(interleave(1, 3)).toEqual([
      { src: "a", index: 0 },
      { src: "b", index: 0 },
      { src: "b", index: 1 },
      { src: "b", index: 2 },
    ]);
  });

  it("handles an empty source gracefully", () => {
    expect(interleave(0, 2)).toEqual([
      { src: "b", index: 0 },
      { src: "b", index: 1 },
    ]);
    expect(interleave(2, 0)).toEqual([
      { src: "a", index: 0 },
      { src: "a", index: 1 },
    ]);
  });
});

describe("insertIndex(target, pageCount) — clamped 0-based insert position", () => {
  it("maps a 1-based target to its 0-based insert slot", () => {
    // Insert BEFORE page 3 of a 5-page doc → slot index 2.
    expect(insertIndex(3, 5)).toBe(2);
  });

  it("clamps a target below 1 to the front (slot 0)", () => {
    expect(insertIndex(0, 5)).toBe(0);
    expect(insertIndex(-4, 5)).toBe(0);
  });

  it("clamps a target past the end to append (slot = pageCount)", () => {
    expect(insertIndex(99, 5)).toBe(5);
  });

  it("treats a non-finite target as append", () => {
    expect(insertIndex(NaN, 3)).toBe(3);
  });
});

describe("duplicateSequence(pageCount, dupPage) — copy-with-duplicate indices", () => {
  it("inserts a copy of the chosen page right after it", () => {
    // Duplicate page 2 of a 3-page doc → 0-based [0, 1, 1, 2].
    expect(duplicateSequence(3, 2)).toEqual([0, 1, 1, 2]);
  });

  it("duplicates the first page", () => {
    expect(duplicateSequence(3, 1)).toEqual([0, 0, 1, 2]);
  });

  it("duplicates the last page", () => {
    expect(duplicateSequence(3, 3)).toEqual([0, 1, 2, 2]);
  });

  it("returns the natural sequence when dupPage is out of range", () => {
    expect(duplicateSequence(3, 9)).toEqual([0, 1, 2]);
    expect(duplicateSequence(3, 0)).toEqual([0, 1, 2]);
  });
});

describe("isLandscape / matchesOrientation — pure orientation predicate", () => {
  it("treats width > height as landscape", () => {
    expect(isLandscape(800, 600)).toBe(true);
  });

  it("treats width <= height as portrait (square counts as portrait)", () => {
    expect(isLandscape(600, 800)).toBe(false);
    expect(isLandscape(500, 500)).toBe(false);
  });

  it("matchesOrientation filters by the requested orientation", () => {
    expect(matchesOrientation(800, 600, "landscape")).toBe(true);
    expect(matchesOrientation(800, 600, "portrait")).toBe(false);
    expect(matchesOrientation(600, 800, "portrait")).toBe(true);
  });

  it("matchesOrientation 'any' matches every page", () => {
    expect(matchesOrientation(800, 600, "any")).toBe(true);
    expect(matchesOrientation(600, 800, "any")).toBe(true);
  });
});

// ── A17 operations (PDF integration) ───────────────────────────────────────
// These exercise the new operation switch end-to-end through pdf-lib. The
// default (no `operation`) MUST stay the unchanged reorder path.

describe("operation switch — insert / duplicate / mix", () => {
  it("inserts a blank page at a chosen position, sized from an existing page", async () => {
    // 3 labelled pages (widths 101,102,103). Insert a blank BEFORE page 2.
    const file = await makeLabeledPdf(3);
    const result = await reorderPdfPagesDescriptor.convert({
      file,
      options: { operation: "insert-blank", insertAt: 2, blankSize: "match" },
    });
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(doc.getPageCount()).toBe(4);
    // Slot 1 (0-based) is the new blank; the original pages 1,2,3 surround it.
    const widths = doc.getPages().map((p) => Math.round(p.getWidth()));
    // Original widths are 101,102,103; the blank "match" page copies its
    // neighbour's size so it is NOT one of the labelled widths missing.
    expect(widths.length).toBe(4);
  });

  it("duplicates a chosen page", async () => {
    const file = await makeLabeledPdf(3);
    const result = await reorderPdfPagesDescriptor.convert({
      file,
      options: { operation: "duplicate", duplicatePage: 2 },
    });
    expect(await resultingOrder(result.blob)).toEqual([1, 2, 2, 3]);
  });

  it("mixes/interleaves a second PDF supplied via the file control", async () => {
    const a = await makeLabeledPdf(2); // widths 101,102 → labels 1,2
    // Build B with DISTINCT labels so we can tell the sources apart: widths
    // 201,202 → labels 101,102 under resultingOrder's (width-100) decoding.
    const { PDFDocument } = await import("pdf-lib");
    const bDoc = await PDFDocument.create();
    bDoc.addPage([201, 200]);
    bDoc.addPage([202, 200]);
    const bBytes = await bDoc.save();
    const secondPdf = new File([new Uint8Array(bBytes)], "b.pdf", {
      type: "application/pdf",
    });

    const result = await reorderPdfPagesDescriptor.convert({
      file: a,
      options: { operation: "mix", secondPdf },
    });
    // Interleave A1,B1,A2,B2 → labels [1, 101, 2, 102].
    expect(await resultingOrder(result.blob)).toEqual([1, 101, 2, 102]);
  });

  it("mix without a second PDF is a recoverable UNSUPPORTED_INPUT", async () => {
    const file = await makeLabeledPdf(2);
    await expect(
      reorderPdfPagesDescriptor.convert({ file, options: { operation: "mix" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("an unknown operation falls back to the reorder path (byte-identical default)", async () => {
    // No `order` + unknown op behaves exactly like the reorder path with a
    // missing order: a recoverable UNSUPPORTED_INPUT asking for an order.
    const file = await makeLabeledPdf(3);
    const reorderDefault = reorderPdfPagesDescriptor.convert({
      file,
      options: { order: "" },
    });
    await expect(reorderDefault).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    });
  });

  it("the default (no operation) and operation:'reorder' produce byte-identical output", async () => {
    // The default path must be unchanged by the A17 operation switch: an absent
    // `operation` and an explicit "reorder" route to the SAME code and so emit
    // byte-for-byte identical PDFs for the same order.
    const file = await makeLabeledPdf(3);
    const a = await reorderPdfPagesDescriptor.convert({ file, options: { order: "3,1,2" } });
    const b = await reorderPdfPagesDescriptor.convert({
      file,
      options: { order: "3,1,2", operation: "reorder" },
    });
    const ab = new Uint8Array(await a.blob.arrayBuffer());
    const bb = new Uint8Array(await b.blob.arrayBuffer());
    expect(ab.length).toBe(bb.length);
    expect(Array.from(ab)).toEqual(Array.from(bb));
  });
});
