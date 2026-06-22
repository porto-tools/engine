import { describe, it, expect } from "vitest";
import { parsePageRange } from "./page-range";

describe("parsePageRange", () => {
  it("expands a single page", () => {
    expect(parsePageRange("5", 10)).toEqual([5]);
  });

  it("expands an inclusive range", () => {
    expect(parsePageRange("2-4", 10)).toEqual([2, 3, 4]);
  });

  it("parses mixed singles and ranges", () => {
    expect(parsePageRange("1-3,5,8-10", 10)).toEqual([1, 2, 3, 5, 8, 9, 10]);
  });

  it("treats an empty string as all pages", () => {
    expect(parsePageRange("", 3)).toEqual([1, 2, 3]);
  });

  it("treats a whitespace-only string as all pages", () => {
    expect(parsePageRange("   ", 2)).toEqual([1, 2]);
  });

  it("ignores whitespace around parts", () => {
    expect(parsePageRange(" 1 , 3 - 4 ", 5)).toEqual([1, 3, 4]);
  });

  it("de-duplicates and sorts overlapping selections", () => {
    expect(parsePageRange("3,1,2,2-3", 5)).toEqual([1, 2, 3]);
  });

  it("normalises a reversed range", () => {
    expect(parsePageRange("4-2", 10)).toEqual([2, 3, 4]);
  });

  it("clamps pages above the page count", () => {
    expect(parsePageRange("8-12", 10)).toEqual([8, 9, 10]);
  });

  it("drops single pages beyond the page count", () => {
    expect(parsePageRange("5,99", 10)).toEqual([5]);
  });

  it("skips non-numeric parts", () => {
    expect(parsePageRange("abc,2", 10)).toEqual([2]);
  });

  it("returns an empty array when nothing is in range", () => {
    expect(parsePageRange("50-60", 10)).toEqual([]);
  });

  it("returns an empty array for a zero page count", () => {
    expect(parsePageRange("1-3", 0)).toEqual([]);
  });
});
