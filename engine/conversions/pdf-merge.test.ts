// pdf-lib runs in Node, so the full happy-path merge test runs for real —
// no skip-guard needed. UNSUPPORTED_INPUT, DECODE_FAILED, and CANCELLED
// also run unconditionally because pdf-lib is a pure-JS library with no
// DOM/browser dependencies.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfMergeDescriptor, sortFilesByName, thumbnailDimensions } from "./pdf-merge";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-merge", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

describe("pdfMergeDescriptor", () => {
  it("merges two PDFs and the result has the combined page count", async () => {
    const onePage = await fileFromFixture("one-page.pdf");   // 1 page
    const twoPage = await fileFromFixture("two-page.pdf");   // 2 pages
    const files = [onePage, twoPage];

    const result = await pdfMergeDescriptor.convert({
      file: files[0],
      files,
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("merged.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(onePage.size + twoPage.size);

    // Verify the merged PDF actually has 3 pages.
    const { PDFDocument } = await import("pdf-lib");
    const bytes = await result.blob.arrayBuffer();
    const merged = await PDFDocument.load(bytes);
    expect(merged.getPageCount()).toBe(3);
  });

  it("rejects a non-PDF file in the set as UNSUPPORTED_INPUT", async () => {
    const notPdf = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    const onePage = await fileFromFixture("one-page.pdf");
    const files = [notPdf, onePage];

    await expect(
      pdfMergeDescriptor.convert({ file: files[0], files }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects a corrupt PDF as DECODE_FAILED", async () => {
    const corrupt = new File(
      [new TextEncoder().encode("%PDF-1.4 this is not a real pdf")],
      "corrupt.pdf",
      { type: "application/pdf" },
    );
    const onePage = await fileFromFixture("one-page.pdf");
    const files = [corrupt, onePage];

    await expect(
      pdfMergeDescriptor.convert({ file: files[0], files }),
    ).rejects.toMatchObject({ code: "DECODE_FAILED", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const onePage = await fileFromFixture("one-page.pdf");
    const twoPage = await fileFromFixture("two-page.pdf");
    const files = [onePage, twoPage];

    await expect(
      pdfMergeDescriptor.convert({ file: files[0], files, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// The pure "Sort A→Z" helper that backs the staging control. No DOM/pdf-lib
// needed — it operates on { name } objects, so we test it with plain stand-ins.
describe("sortFilesByName", () => {
  const names = (items: { name: string }[]) => items.map((i) => i.name);

  it("orders ascending by filename (A→Z)", () => {
    const input = [{ name: "charlie.pdf" }, { name: "alpha.pdf" }, { name: "bravo.pdf" }];
    expect(names(sortFilesByName(input))).toEqual(["alpha.pdf", "bravo.pdf", "charlie.pdf"]);
  });

  it("is case-insensitive (capital letters don't rank before all lowercase)", () => {
    // Raw ASCII ordering would put "Banana.pdf" (B=66) before "apple.pdf" (a=97).
    // Case-insensitive ordering must put apple before banana regardless of case.
    const input = [{ name: "Banana.pdf" }, { name: "apple.pdf" }, { name: "Cherry.pdf" }];
    expect(names(sortFilesByName(input))).toEqual(["apple.pdf", "Banana.pdf", "Cherry.pdf"]);
  });

  it("compares embedded numbers numerically, not lexically", () => {
    const input = [
      { name: "file10.pdf" },
      { name: "file2.pdf" },
      { name: "file1.pdf" },
      { name: "file20.pdf" },
    ];
    expect(names(sortFilesByName(input))).toEqual([
      "file1.pdf",
      "file2.pdf",
      "file10.pdf",
      "file20.pdf",
    ]);
  });

  it("is stable: equal-by-name items keep their original relative order", () => {
    // Two files with the same name keep their input order; tag them to observe it.
    const a = { name: "dup.pdf", tag: "first" };
    const b = { name: "dup.pdf", tag: "second" };
    const c = { name: "aaa.pdf", tag: "early" };
    const sorted = sortFilesByName([a, b, c]);
    expect(sorted.map((i) => i.tag)).toEqual(["early", "first", "second"]);
  });

  it("does not mutate the input array", () => {
    const input = [{ name: "b.pdf" }, { name: "a.pdf" }];
    const out = sortFilesByName(input);
    expect(input.map((i) => i.name)).toEqual(["b.pdf", "a.pdf"]); // untouched
    expect(out).not.toBe(input);
  });
});

// The pure sizing math behind the cover thumbnails. Mirrors computePageScale's
// contract but at thumbnail scale: fit the long edge to the target, cap both
// axes, never upscale, always return integer dimensions ≥ 1.
describe("thumbnailDimensions", () => {
  it("scales a large landscape page down so the long edge hits the target", () => {
    const { scale, width, height } = thumbnailDimensions(1000, 500);
    // Long edge 1000 → 96px target ⇒ scale 0.096.
    expect(scale).toBeCloseTo(96 / 1000, 5);
    expect(width).toBe(96);
    expect(height).toBe(48);
  });

  it("does not upscale a page already smaller than the target", () => {
    const { scale, width, height } = thumbnailDimensions(40, 30);
    expect(scale).toBe(1);
    expect(width).toBe(40);
    expect(height).toBe(30);
  });

  it("returns a valid 1×1 canvas for a degenerate (zero/negative) viewport", () => {
    expect(thumbnailDimensions(0, 0)).toEqual({ scale: 1, width: 1, height: 1 });
    expect(thumbnailDimensions(-10, 50)).toEqual({ scale: 1, width: 1, height: 1 });
  });

  it("rounds to integer dimensions and never drops below 1px", () => {
    const { width, height } = thumbnailDimensions(1000, 3);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(width).toBe(96);
    expect(height).toBeGreaterThanOrEqual(1); // 3 * 0.096 ≈ 0.29 → clamps to 1
  });
});
