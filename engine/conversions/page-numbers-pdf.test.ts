// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// for real in Node (no skip-guard needed). We do not assert that the output is
// smaller than the input: stamping page numbers adds content, so the numbered
// PDF is the same size or larger, which is correct and intentional behaviour.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  pageNumbersPdfDescriptor,
  formatPageNumber,
  placeLabel,
  substituteTokens,
  facingPosition,
  numberedPages,
  relativeNumber,
} from "./page-numbers-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the shared tiny single-page PDF fixture (also used by flatten-pdf).
const fixturePath = (name: string) =>
  join(HERE, "__fixtures__", "flatten-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

describe("pageNumbersPdfDescriptor", () => {
  it("stamps page numbers and produces a valid PDF output", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await pageNumbersPdfDescriptor.convert({ file });

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
    await expect(pageNumbersPdfDescriptor.convert({ file })).rejects.toMatchObject({
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
    await expect(pageNumbersPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.pdf");
    await expect(
      pageNumbersPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// ── Pure helpers: formatPageNumber ─────────────────────────────────────────────
// `pageNumber` is the already-offset value (start + index); `lastNumber` is the
// highest number stamped (start + count - 1), used by the "n of total" format.

describe("formatPageNumber", () => {
  it('"number" shows just the page number', () => {
    expect(formatPageNumber(3, 10, "number")).toBe("3");
  });

  it('"n-of-total" shows the number with the total', () => {
    expect(formatPageNumber(3, 10, "n-of-total")).toBe("3 of 10");
  });

  it('"page-n" prefixes the number with "Page"', () => {
    expect(formatPageNumber(3, 10, "page-n")).toBe("Page 3");
  });
});

// ── Pure helpers: placeLabel ───────────────────────────────────────────────────
// Returns the pdf-lib draw origin (bottom-left of the text). MARGIN is 36pt.

describe("placeLabel", () => {
  const PAGE_W = 612; // US Letter width
  const PAGE_H = 792; // US Letter height
  const TEXT_W = 20;
  const FONT_SIZE = 12;

  it("bottom-center centers x and sits y at the bottom margin (36)", () => {
    const { x, y } = placeLabel("bottom-center", PAGE_W, PAGE_H, TEXT_W, FONT_SIZE);
    expect(x).toBe((PAGE_W - TEXT_W) / 2);
    expect(y).toBe(36);
  });

  it("top-right right-aligns x and sits y near the top of the page", () => {
    const { x, y } = placeLabel("top-right", PAGE_W, PAGE_H, TEXT_W, FONT_SIZE);
    expect(x).toBe(PAGE_W - 36 - TEXT_W);
    expect(y).toBe(PAGE_H - 36 - FONT_SIZE);
    // The top label sits well above the vertical midpoint.
    expect(y).toBeGreaterThan(PAGE_H / 2);
  });
});

// ── Pure helpers: substituteTokens ─────────────────────────────────────────────
// A custom template substitutes {n} (absolute number), {p} (absolute total),
// {r} (range-relative number), {rf} (range-relative total). Pure + DOM-free.

describe("substituteTokens", () => {
  const ctx = { absolute: 7, absoluteTotal: 12, relative: 3, relativeTotal: 8 };

  it("substitutes the absolute number {n} and total {p}", () => {
    expect(substituteTokens("{n} / {p}", ctx)).toBe("7 / 12");
  });

  it("substitutes the range-relative number {r} and total {rf}", () => {
    expect(substituteTokens("{r} of {rf}", ctx)).toBe("3 of 8");
  });

  it("mixes absolute and relative tokens and keeps literal text", () => {
    expect(substituteTokens("Page {r} (sheet {n} of {p})", ctx)).toBe(
      "Page 3 (sheet 7 of 12)",
    );
  });

  it("leaves unknown braces untouched and substitutes every occurrence", () => {
    expect(substituteTokens("{n}-{n} {x}", ctx)).toBe("7-7 {x}");
  });
});

// ── Pure helpers: facingPosition ───────────────────────────────────────────────
// In facing-pages (book) mode the horizontal side mirrors by page parity so the
// number always sits in the OUTER corner: odd (recto) pages keep right-side
// placement, even (verso) pages flip to the left, and vice versa. center and the
// vertical band are untouched. pageIndex is 0-based. Off-mode is the identity.

describe("facingPosition", () => {
  it("is the identity when facing mode is off", () => {
    expect(facingPosition("bottom-right", 1, false)).toBe("bottom-right");
    expect(facingPosition("top-left", 2, false)).toBe("top-left");
  });

  it("keeps the chosen side on odd (recto) pages, index 0 / 2", () => {
    // index 0 = page 1 (odd/recto), index 2 = page 3 (odd/recto)
    expect(facingPosition("bottom-right", 0, true)).toBe("bottom-right");
    expect(facingPosition("bottom-right", 2, true)).toBe("bottom-right");
  });

  it("mirrors the side on even (verso) pages, index 1 / 3", () => {
    // index 1 = page 2 (even/verso), index 3 = page 4 (even/verso)
    expect(facingPosition("bottom-right", 1, true)).toBe("bottom-left");
    expect(facingPosition("bottom-left", 1, true)).toBe("bottom-right");
    expect(facingPosition("top-right", 3, true)).toBe("top-left");
  });

  it("never mirrors a centered position", () => {
    expect(facingPosition("bottom-center", 1, true)).toBe("bottom-center");
    expect(facingPosition("top-center", 0, true)).toBe("top-center");
  });
});

// ── Pure helpers: numberedPages ────────────────────────────────────────────────
// Which 0-based page indices get a number after skipping the first N and last N
// pages. Defaults (0,0) number every page. Over-large excludes collapse to none
// without going negative or overlapping.

describe("numberedPages", () => {
  it("numbers every page when nothing is excluded", () => {
    expect(numberedPages(5, 0, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it("skips the first N pages", () => {
    expect(numberedPages(5, 2, 0)).toEqual([2, 3, 4]);
  });

  it("skips the last N pages", () => {
    expect(numberedPages(5, 0, 2)).toEqual([0, 1, 2]);
  });

  it("skips both ends", () => {
    expect(numberedPages(6, 1, 2)).toEqual([1, 2, 3]);
  });

  it("returns nothing when the excludes meet or overlap", () => {
    expect(numberedPages(4, 2, 2)).toEqual([]);
    expect(numberedPages(3, 5, 5)).toEqual([]);
  });
});

// ── Pure helpers: relativeNumber ───────────────────────────────────────────────
// The range-relative value for a page: relativeStart for the FIRST numbered page,
// then +1 per subsequent numbered page (ordinal within the numbered set, offset by
// the chosen start). Independent of the absolute {n} numbering.

describe("relativeNumber", () => {
  it("starts at relativeStart for the first numbered page", () => {
    // ordinal 0 (first numbered page), relativeStart 1 → 1
    expect(relativeNumber(0, 1)).toBe(1);
  });

  it("increments by one per numbered page", () => {
    expect(relativeNumber(3, 1)).toBe(4);
  });

  it("honours a custom relative start", () => {
    // ordinal 0 with start 5 → 5; ordinal 2 → 7
    expect(relativeNumber(0, 5)).toBe(5);
    expect(relativeNumber(2, 5)).toBe(7);
  });
});
