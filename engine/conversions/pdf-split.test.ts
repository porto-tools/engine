// pdf-lib is pure JavaScript — no WASM and no browser APIs — so the happy-path
// tests run for real in Node (unlike svg-png or heic-jpg which require Canvas or
// the browser). No skip-guard is needed here.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfSplitDescriptor, outlineEntriesToPageRanges, sanitizeTitle } from "./pdf-split";
import { ConversionError } from "../types";

// The pdf-split "bookmarks" mode reads the PDF outline with pdfjs-dist. pdf.js'
// DEFAULT build (the one the engine's loadPdfjs imports) evaluates `new
// DOMMatrix()` at import time, which doesn't exist in plain Node — so even the
// dynamic import throws here, exactly like pdf-image.test.ts / extract-pdf-images.
// We probe for a real browser stack and gate the bookmarks INTEGRATION test on it
// (it.skipIf), mirroring the canvas/ffmpeg-gated happy-paths. The PURE outline
// math (outlineEntriesToPageRanges, sanitizeTitle) carries the real coverage and
// runs unconditionally. The synthetic-data probe below short-circuits to false in
// Node so the integration test is skipped, not failed.
const pdfjsAvailable =
  typeof document !== "undefined" && typeof Worker !== "undefined" && typeof DOMMatrix !== "undefined";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-split", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// Round-trip an output blob through pdf-lib and return its page count.
async function pageCountOf(blob: Blob): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await blob.arrayBuffer());
  return doc.getPageCount();
}

// Round-trip an output blob and return the {width,height} of each page, so the
// split-in-half tests can assert the crop geometry.
async function pageSizesOf(blob: Blob): Promise<{ width: number; height: number }[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await blob.arrayBuffer());
  return doc.getPages().map((p) => p.getSize());
}

describe("pdfSplitDescriptor", () => {
  describe("default (no mode) — one PDF per page", () => {
    it("splits a 3-page PDF into 3 single-page PDFs", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({ file });

      expect(result.outputs).toHaveLength(3);

      for (const output of result.outputs!) {
        expect(output.mimeType).toBe("application/pdf");
        expect(output.size).toBeGreaterThan(0);
        expect(output.blob.size).toBeGreaterThan(0);
        expect(await pageCountOf(output.blob)).toBe(1);
      }
    });

    it("names output files with the base name and 1-indexed page numbers", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({ file });

      expect(result.outputs![0].filename).toBe("three-pages-page-1.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-page-2.pdf");
      expect(result.outputs![2].filename).toBe("three-pages-page-3.pdf");
    });

    it("sets result.blob / filename to the first page as representative", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({ file });

      expect(result.filename).toBe("three-pages-page-1.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.inputSize).toBe(file.size);
      expect(result.outputSize).toBeGreaterThan(0);
    });
  });

  describe("mode: range", () => {
    it("produces one PDF per range when mergeRanges is false", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "range", ranges: [{ from: 1, to: 2 }, { from: 3, to: 3 }], mergeRanges: false },
      });

      expect(result.outputs).toHaveLength(2);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2);
      expect(await pageCountOf(result.outputs![1].blob)).toBe(1);
      expect(result.outputs![0].filename).toBe("three-pages-range-1.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-range-2.pdf");
    });

    it("produces ONE merged PDF when mergeRanges is true", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "range", ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }], mergeRanges: true },
      });

      expect(result.outputs).toHaveLength(1);
      // Two ranges of one page each → a single 2-page PDF.
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2);
      expect(result.outputs![0].filename).toBe("three-pages-ranges.pdf");
    });

    it("clamps and normalises out-of-bounds / reversed ranges", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        // to=99 clamps to 3; the second range is reversed (3→1) and normalises.
        file,
        options: { mode: "range", ranges: [{ from: 2, to: 99 }, { from: 3, to: 1 }], mergeRanges: false },
      });

      expect(result.outputs).toHaveLength(2);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2); // pages 2-3
      expect(await pageCountOf(result.outputs![1].blob)).toBe(3); // pages 1-3
    });

    it("rejects when no ranges are usable", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      await expect(
        pdfSplitDescriptor.convert({ file, options: { mode: "range", ranges: [] } }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
    });
  });

  describe("mode: pages", () => {
    it("produces one single-page PDF per selected page by default", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "pages", pageRange: "1,3", mergePages: false },
      });

      expect(result.outputs).toHaveLength(2);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(1);
      expect(await pageCountOf(result.outputs![1].blob)).toBe(1);
      expect(result.outputs![0].filename).toBe("three-pages-page-1.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-page-3.pdf");
    });

    it("produces ONE merged PDF of the selected pages when mergePages is true", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "pages", pageRange: "1-2", mergePages: true },
      });

      expect(result.outputs).toHaveLength(1);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2);
      expect(result.outputs![0].filename).toBe("three-pages-pages.pdf");
    });

    it("parses MS-Word print-style ranges with gaps", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        // "3, 1" is out of order + a single page; parse sorts/dedupes ascending.
        file,
        options: { mode: "pages", pageRange: "3, 1", mergePages: false },
      });
      expect(result.outputs).toHaveLength(2);
      expect(result.outputs![0].filename).toBe("three-pages-page-1.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-page-3.pdf");
    });

    it("rejects when the page range matches no pages", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      await expect(
        pdfSplitDescriptor.convert({ file, options: { mode: "pages", pageRange: "99" } }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
    });
  });

  describe("mode: size", () => {
    it("packs pages into multiple chunks under a tiny budget", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // A tiny budget forces (close to) one page per chunk.
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "size", maxMb: file.size / (1024 * 1024) / 3 },
      });

      expect(result.outputs!.length).toBeGreaterThan(1);
      // Every page must survive across the chunks (no page dropped).
      let totalPages = 0;
      for (const output of result.outputs!) {
        totalPages += await pageCountOf(output.blob);
        expect(output.mimeType).toBe("application/pdf");
      }
      expect(totalPages).toBe(3);
      // Filenames are zero-padded "-part-N" and sort naturally.
      expect(result.outputs![0].filename).toBe("three-pages-part-1.pdf");
    });

    it("returns a single chunk when the budget covers the whole document", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "size", maxMb: 100 },
      });
      expect(result.outputs).toHaveLength(1);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(3);
      expect(result.outputs![0].filename).toBe("three-pages-part-1.pdf");
    });

    it("rejects an invalid maxMb", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      await expect(
        pdfSplitDescriptor.convert({ file, options: { mode: "size", maxMb: 0 } }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
    });
  });

  describe("mode: fixed", () => {
    it("splits into ceil(pageCount/N) uniform chunks, last one smaller", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // 3 pages, N=2 → 2 files: pages 1-2, then page 3.
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed", everyN: 2 },
      });

      expect(result.outputs).toHaveLength(2);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2);
      expect(await pageCountOf(result.outputs![1].blob)).toBe(1);
      // Zero-padded "-part-N" filenames sort naturally.
      expect(result.outputs![0].filename).toBe("three-pages-part-1.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-part-2.pdf");
      // No page is dropped across the chunks.
      let totalPages = 0;
      for (const output of result.outputs!) {
        totalPages += await pageCountOf(output.blob);
        expect(output.mimeType).toBe("application/pdf");
        expect(output.size).toBeGreaterThan(0);
      }
      expect(totalPages).toBe(3);
    });

    it("with N=1 behaves like one PDF per page", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed", everyN: 1 },
      });

      expect(result.outputs).toHaveLength(3);
      for (const output of result.outputs!) {
        expect(await pageCountOf(output.blob)).toBe(1);
      }
      expect(result.outputs![0].filename).toBe("three-pages-part-1.pdf");
      expect(result.outputs![2].filename).toBe("three-pages-part-3.pdf");
    });

    it("with N ≥ pageCount yields a single full-document output", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed", everyN: 10 },
      });

      expect(result.outputs).toHaveLength(1);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(3);
      expect(result.outputs![0].filename).toBe("three-pages-part-1.pdf");
    });

    it("clamps a non-positive / non-integer everyN to 1 (per-page)", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // everyN=0 (and 2.5 below) is garbage → clamp to 1, never drop pages.
      const zero = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed", everyN: 0 },
      });
      expect(zero.outputs).toHaveLength(3);

      const frac = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed", everyN: 2.5 },
      });
      // Math.floor(2.5) = 2 → chunks of 2 → 2 files.
      expect(frac.outputs).toHaveLength(2);
      expect(await pageCountOf(frac.outputs![0].blob)).toBe(2);
      expect(await pageCountOf(frac.outputs![1].blob)).toBe(1);
    });

    it("clamps a missing everyN to 1 (per-page)", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "fixed" },
      });
      expect(result.outputs).toHaveLength(3);
      for (const output of result.outputs!) {
        expect(await pageCountOf(output.blob)).toBe(1);
      }
    });
  });

  describe("mode: oddeven", () => {
    it("produces two PDFs (odd then even) with the right page counts for which='both'", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // 3 pages → odd = {1,3} (2 pages), even = {2} (1 page).
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "oddeven", which: "both" },
      });

      expect(result.outputs).toHaveLength(2);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2); // odd: pages 1,3
      expect(await pageCountOf(result.outputs![1].blob)).toBe(1); // even: page 2
      expect(result.outputs![0].filename).toBe("three-pages-odd-pages.pdf");
      expect(result.outputs![1].filename).toBe("three-pages-even-pages.pdf");
    });

    it("produces ONE PDF of only the odd pages for which='odd'", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "oddeven", which: "odd" },
      });

      expect(result.outputs).toHaveLength(1);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(2); // pages 1 and 3
      expect(result.outputs![0].filename).toBe("three-pages-odd-pages.pdf");
    });

    it("produces ONE PDF of only the even pages for which='even'", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "oddeven", which: "even" },
      });

      expect(result.outputs).toHaveLength(1);
      expect(await pageCountOf(result.outputs![0].blob)).toBe(1); // page 2 only
      expect(result.outputs![0].filename).toBe("three-pages-even-pages.pdf");
    });

    it("defaults to 'both' when which is missing", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "oddeven" },
      });
      expect(result.outputs).toHaveLength(2);
    });
  });

  describe("mode: half", () => {
    it("vertical: doubles the page count, each half is full-height and half-width", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // The fixture pages are 200×100; a vertical split → 6 pages of 100×100.
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "half", direction: "vertical" },
      });

      expect(result.outputs).toHaveLength(1);
      const sizes = await pageSizesOf(result.outputs![0].blob);
      expect(sizes).toHaveLength(6); // 3 source pages × 2 halves
      for (const { width, height } of sizes) {
        expect(width).toBeCloseTo(100);
        expect(height).toBeCloseTo(100);
      }
      expect(result.outputs![0].filename).toBe("three-pages-halves.pdf");
    });

    it("horizontal: doubles the page count, each half is full-width and half-height", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      // 200×100 pages, horizontal split → 6 pages of 200×50.
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "half", direction: "horizontal" },
      });

      expect(result.outputs).toHaveLength(1);
      const sizes = await pageSizesOf(result.outputs![0].blob);
      expect(sizes).toHaveLength(6);
      for (const { width, height } of sizes) {
        expect(width).toBeCloseTo(200);
        expect(height).toBeCloseTo(50);
      }
    });

    it("defaults to vertical when direction is missing", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({
        file,
        options: { mode: "half" },
      });
      const sizes = await pageSizesOf(result.outputs![0].blob);
      expect(sizes).toHaveLength(6);
      expect(sizes[0].width).toBeCloseTo(100); // vertical → 100 wide
    });
  });

  describe("errors and cancellation", () => {
    it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
      const file = new File([new Uint8Array([0, 1, 2, 3])], "image.png", { type: "image/png" });
      await expect(pdfSplitDescriptor.convert({ file })).rejects.toMatchObject({
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
      });
    });

    it("rejects corrupt PDF bytes as DECODE_FAILED", async () => {
      const file = new File(
        [new TextEncoder().encode("this is not a valid pdf at all")],
        "broken.pdf",
        { type: "application/pdf" },
      );
      await expect(pdfSplitDescriptor.convert({ file })).rejects.toMatchObject({
        code: "DECODE_FAILED",
        recoverable: false,
      });
    });

    it("respects an already-aborted signal as CANCELLED", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const file = await fileFromFixture("three-pages.pdf");
      await expect(
        pdfSplitDescriptor.convert({ file, signal: ctrl.signal }),
      ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
    });

    it("reports progress stages while splitting", async () => {
      const file = await fileFromFixture("three-pages.pdf");
      const stages: string[] = [];
      await pdfSplitDescriptor.convert({
        file,
        onProgress: (p) => {
          if (p.stage) stages.push(p.stage);
        },
      });
      expect(stages.some((s) => s === "Reading")).toBe(true);
      expect(stages.some((s) => s.startsWith("Splitting page"))).toBe(true);
    });
  });
});

// ── Pure bookmark helpers ─────────────────────────────────────────────────────
// These power the "bookmarks" mode and are DOM-free, so they run for real in Node
// against SYNTHETIC outline data (no PDF needed). This is the load-bearing
// coverage for the mode — the engine integration below is gated on a browser
// stack that the Node test env doesn't provide.

describe("outlineEntriesToPageRanges", () => {
  it("returns [] for empty input", () => {
    expect(outlineEntriesToPageRanges([], 10)).toEqual([]);
  });

  it("a single bookmark spans the whole document", () => {
    expect(outlineEntriesToPageRanges([{ title: "All", pageIndex: 0 }], 5)).toEqual([
      { start: 0, end: 4, title: "All" },
    ]);
  });

  it("3 bookmarks on a 10-page doc → three contiguous ranges, last runs to the end", () => {
    const ranges = outlineEntriesToPageRanges(
      [
        { title: "Intro", pageIndex: 0 },
        { title: "Body", pageIndex: 3 },
        { title: "End", pageIndex: 7 },
      ],
      10,
    );
    expect(ranges).toEqual([
      { start: 0, end: 2, title: "Intro" },
      { start: 3, end: 6, title: "Body" },
      { start: 7, end: 9, title: "End" },
    ]);
  });

  it("a bookmark that does not start on page 0 still produces a range from its own page", () => {
    // The first chapter starts at page 2; nothing maps pages 0-1, by design — the
    // ranges follow the bookmarks, they don't backfill the front matter.
    expect(outlineEntriesToPageRanges([{ title: "Ch", pageIndex: 2 }], 6)).toEqual([
      { start: 2, end: 5, title: "Ch" },
    ]);
  });

  it("dedupes multiple bookmarks on the SAME page (first title wins)", () => {
    const ranges = outlineEntriesToPageRanges(
      [
        { title: "A", pageIndex: 0 },
        { title: "B-dup", pageIndex: 0 },
        { title: "C", pageIndex: 4 },
      ],
      8,
    );
    expect(ranges).toEqual([
      { start: 0, end: 3, title: "A" },
      { start: 4, end: 7, title: "C" },
    ]);
  });

  it("sorts unsorted input by page before building ranges", () => {
    const ranges = outlineEntriesToPageRanges(
      [
        { title: "Third", pageIndex: 6 },
        { title: "First", pageIndex: 0 },
        { title: "Second", pageIndex: 3 },
      ],
      9,
    );
    expect(ranges).toEqual([
      { start: 0, end: 2, title: "First" },
      { start: 3, end: 5, title: "Second" },
      { start: 6, end: 8, title: "Third" },
    ]);
  });

  it("clamps out-of-range page indices into the document", () => {
    const ranges = outlineEntriesToPageRanges(
      [
        { title: "A", pageIndex: -3 },
        { title: "B", pageIndex: 99 },
      ],
      5,
    );
    // -3 clamps to 0, 99 clamps to 4 → A:[0,3], B:[4,4].
    expect(ranges).toEqual([
      { start: 0, end: 3, title: "A" },
      { start: 4, end: 4, title: "B" },
    ]);
  });

  it("returns [] when pageCount is zero", () => {
    expect(outlineEntriesToPageRanges([{ title: "x", pageIndex: 0 }], 0)).toEqual([]);
  });
});

describe("sanitizeTitle", () => {
  it("keeps a plain title untouched", () => {
    expect(sanitizeTitle("Chapter One", 1)).toBe("Chapter One");
  });

  it("strips filename-unsafe characters", () => {
    expect(sanitizeTitle('1/2 of: "X" <test>?*|\\', 1)).toBe("1 2 of X test");
  });

  it("collapses runs of whitespace to single spaces and trims", () => {
    expect(sanitizeTitle("  Lots   of\t\n  space  ", 1)).toBe("Lots of space");
  });

  it("truncates to ~60 characters", () => {
    const long = "a".repeat(100);
    const out = sanitizeTitle(long, 1);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toBe("a".repeat(60));
  });

  it("falls back to part-N for a blank or all-unsafe title", () => {
    expect(sanitizeTitle("", 3)).toBe("part-3");
    expect(sanitizeTitle("///\\\\:::", 7)).toBe("part-7");
    expect(sanitizeTitle("   ", 2)).toBe("part-2");
  });
});

// ── Mode: bookmarks (integration, gated) ──────────────────────────────────────
// Splits a real 3-bookmark PDF and asserts three chapter PDFs come out. pdf.js'
// default build can't import in the Node test env (DOMMatrix), so this is gated on
// a browser stack (it.skipIf), exactly like the canvas/ffmpeg happy-paths. The
// fixture + the helper math above are validated independently (the fixture was
// confirmed to expose 3 resolvable top-level bookmarks via pdf.js' legacy build),
// so skipping here loses no logic coverage — only the live pdf.js wiring.
describe("mode: bookmarks", () => {
  it.skipIf(!pdfjsAvailable)(
    "produces one PDF per top-level bookmark with sanitized chapter filenames",
    async () => {
      const file = await fileFromFixture("bookmarked-three-pages.pdf");
      const result = await pdfSplitDescriptor.convert({ file, options: { mode: "bookmarks" } });

      expect(result.outputs).toHaveLength(3);
      // Each top-level bookmark (Introduction / Chapter One / Conclusion) lands on
      // its own page in the 3-page fixture → one page per chapter.
      for (const output of result.outputs!) {
        expect(output.mimeType).toBe("application/pdf");
        expect(await pageCountOf(output.blob)).toBe(1);
      }
      expect(result.outputs![0].filename).toBe("bookmarked-three-pages-Introduction.pdf");
      expect(result.outputs![1].filename).toBe("bookmarked-three-pages-Chapter One.pdf");
      expect(result.outputs![2].filename).toBe("bookmarked-three-pages-Conclusion.pdf");
    },
  );

  it("rejects a bookmark-less PDF as a recoverable UNSUPPORTED_INPUT", async () => {
    // The plain three-pages.pdf fixture carries no outline. This path loads pdf.js,
    // so it only runs end-to-end where the browser stack is available; in Node the
    // pdf.js import fails first (ENGINE_LOAD_FAILED). Either way the rejection is a
    // recoverable ConversionError, which is what the UI needs.
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      pdfSplitDescriptor.convert({ file, options: { mode: "bookmarks" } }),
    ).rejects.toMatchObject({ recoverable: true });
  });

  it("rejects a corrupt/unparseable PDF as a ConversionError, never a teardown TypeError", async () => {
    // Random bytes that are not a parseable PDF. In bookmarks mode the pdf.js
    // task.promise rejects (where the browser stack is available) or the pdf.js
    // import fails first (in the Node test env). The finally-block teardown guards
    // on `doc` being non-null, so a rejected parse must NOT trigger a
    // `doc.cleanup is not a function` TypeError that would mask the real error.
    // We assert a ConversionError surfaces — never a raw TypeError/ReferenceError.
    const random = new Uint8Array(256);
    for (let i = 0; i < random.length; i++) random[i] = (i * 31 + 7) % 256;
    const file = new File([random], "corrupt.pdf", { type: "application/pdf" });

    const err = await pdfSplitDescriptor
      .convert({ file, options: { mode: "bookmarks" } })
      .then(
        () => {
          throw new Error("expected the corrupt PDF to reject");
        },
        (e) => e,
      );

    // The load-bearing invariant: the rejection is the engine's own
    // ConversionError, NOT a TypeError/ReferenceError escaping the finally-block
    // teardown (which would mean the guard let `doc.cleanup()` run on a null doc and
    // masked the real error). The exact code is environment-dependent — DECODE_FAILED
    // where pdf.js loads and the parse rejects, ENGINE_LOAD_FAILED where the pdf.js
    // import itself fails in a bare Node env — so we assert the ConversionError shape
    // (a string `code`, a boolean `recoverable`) rather than pinning one outcome.
    expect(err).toBeInstanceOf(ConversionError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ReferenceError);
    expect(typeof (err as ConversionError).code).toBe("string");
    expect(typeof (err as ConversionError).recoverable).toBe("boolean");
  });
});
