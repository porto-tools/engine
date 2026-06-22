import { describe, it, expect } from "vitest";
import {
  parsePageList,
  parseOrderList,
  appendMissing,
  toRanges,
  formatRanges,
} from "./page-ranges";

describe("parsePageList", () => {
  it("treats an empty string as valid with no pages (caller decides meaning)", () => {
    const r = parsePageList("");
    expect(r.valid).toBe(true);
    expect(r.pages).toEqual([]);
    expect(r.message).toBeUndefined();
  });

  it("treats a whitespace-only string as an empty selection", () => {
    expect(parsePageList("   ")).toEqual({ pages: [], valid: true });
  });

  it("parses a single page", () => {
    expect(parsePageList("5").pages).toEqual([5]);
  });

  it("parses a mixed list into a SORTED, UNIQUE array", () => {
    const r = parsePageList("1,3,6-8");
    expect(r.valid).toBe(true);
    expect(r.pages).toEqual([1, 3, 6, 7, 8]);
  });

  it("expands an inclusive range", () => {
    expect(parsePageList("5-10").pages).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("sorts and de-dupes out-of-order, overlapping parts", () => {
    expect(parsePageList("8,3-5,4,1").pages).toEqual([1, 3, 4, 5, 8]);
  });

  it("tolerates stray whitespace and empty segments", () => {
    expect(parsePageList(" 1 , , 3 - 4 ").pages).toEqual([1, 3, 4]);
  });

  it("accepts a descending range as the same SET (output is sorted)", () => {
    expect(parsePageList("8-5").pages).toEqual([5, 6, 7, 8]);
  });

  it("checks bounds when the page count is known", () => {
    const r = parsePageList("3,9", 8);
    expect(r.valid).toBe(false);
    expect(r.pages).toEqual([]);
    expect(r.message).toContain("8 pages");
  });

  it("checks the high end of a range against the page count", () => {
    const r = parsePageList("1-12", 10);
    expect(r.valid).toBe(false);
    expect(r.message).toContain("out of range");
  });

  it("only checks shape, not bounds, when the page count is unknown", () => {
    const r = parsePageList("999");
    expect(r.valid).toBe(true);
    expect(r.pages).toEqual([999]);
  });

  it("rejects a non-numeric part with a calm one-line message", () => {
    const r = parsePageList("1,abc,3");
    expect(r.valid).toBe(false);
    expect(r.message).toBe('"abc" isn\'t a valid page number.');
  });

  it("rejects page zero (1-based)", () => {
    expect(parsePageList("0").valid).toBe(false);
  });

  it("rejects a malformed range", () => {
    const r = parsePageList("1-");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("valid page range");
  });

  it("reports the FIRST problem encountered", () => {
    const r = parsePageList("2,bad,99", 10);
    expect(r.message).toBe('"bad" isn\'t a valid page number.');
  });
});

describe("parseOrderList", () => {
  it("treats an empty string as valid with no order", () => {
    expect(parseOrderList("")).toEqual({ order: [], valid: true });
  });

  it("preserves the typed order", () => {
    expect(parseOrderList("3,1,2").order).toEqual([3, 1, 2]);
  });

  it("keeps the first mention and drops a later repeat", () => {
    expect(parseOrderList("2,1,2,3").order).toEqual([2, 1, 3]);
  });

  it("expands an ascending range in order", () => {
    expect(parseOrderList("3-5,1").order).toEqual([3, 4, 5, 1]);
  });

  it("expands a descending range as a reverse run", () => {
    expect(parseOrderList("3-1,5").order).toEqual([3, 2, 1, 5]);
  });

  it("de-dupes across a range and a later single", () => {
    expect(parseOrderList("1-3,2").order).toEqual([1, 2, 3]);
  });

  it("validates bounds like parsePageList", () => {
    const r = parseOrderList("1,9", 8);
    expect(r.valid).toBe(false);
    expect(r.order).toEqual([]);
    expect(r.message).toContain("8 pages");
  });
});

describe("appendMissing", () => {
  it("appends omitted pages in ascending original order", () => {
    expect(appendMissing([3, 1], 5)).toEqual([3, 1, 2, 4, 5]);
  });

  it("returns the order unchanged when it already covers every page", () => {
    expect(appendMissing([2, 1, 3], 3)).toEqual([2, 1, 3]);
  });

  it("covers every page exactly once when starting from empty", () => {
    expect(appendMissing([], 4)).toEqual([1, 2, 3, 4]);
  });

  it("de-dupes a dirty input order before appending", () => {
    expect(appendMissing([2, 2, 1], 3)).toEqual([2, 1, 3]);
  });

  it("appends nothing for a non-positive or non-finite page count", () => {
    expect(appendMissing([2, 1], 0)).toEqual([2, 1]);
    expect(appendMissing([2, 1], Number.NaN)).toEqual([2, 1]);
  });

  it("passes through an out-of-range entry without appending it again", () => {
    // Entry 9 is beyond pageCount 3; it is carried through, and 1..3 minus the
    // ones already present are appended.
    expect(appendMissing([9, 2], 3)).toEqual([9, 2, 1, 3]);
  });
});

describe("toRanges", () => {
  it("returns an empty array for no pages", () => {
    expect(toRanges([])).toEqual([]);
  });

  it("collapses contiguous runs and keeps singletons", () => {
    expect(toRanges([1, 2, 3, 4, 6, 8, 9, 10])).toEqual([
      { start: 1, end: 4 },
      { start: 6, end: 6 },
      { start: 8, end: 10 },
    ]);
  });

  it("sorts and de-dupes unsorted input first", () => {
    expect(toRanges([3, 1, 2, 2])).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("formatRanges", () => {
  it("returns an empty string for no pages", () => {
    expect(formatRanges([])).toBe("");
  });

  it("renders a single page", () => {
    expect(formatRanges([5])).toBe("5");
  });

  it("renders a run of three or more as start-end", () => {
    expect(formatRanges([1, 2, 3, 4])).toBe("1-4");
  });

  it("renders a two-page run as a comma pair, not a dash", () => {
    expect(formatRanges([1, 2])).toBe("1, 2");
  });

  it("renders a mixed set compactly", () => {
    expect(formatRanges([1, 2, 3, 4, 6, 8, 9, 10])).toBe("1-4, 6, 8-10");
  });

  // The AUTO-SPLIT contract: deselecting one page from a run splits the range.
  it("splits a range when an interior page is deselected (1-10 minus 5)", () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const remaining = all.filter((p) => p !== 5);
    expect(formatRanges(remaining)).toBe("1-4, 6-10");
  });

  it("round-trips through parsePageList for the split case", () => {
    const remaining = [1, 2, 3, 4, 6, 7, 8, 9, 10];
    const compact = formatRanges(remaining); // "1-4, 6-10"
    expect(parsePageList(compact).pages).toEqual(remaining);
  });
});
