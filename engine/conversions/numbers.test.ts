import { describe, it, expect } from "vitest";
import { clampInt, clampQuality } from "./numbers";

// numbers is fully pure and Node-testable. clampInt is the general integer
// clamp (the folded home of audio-settings' readClampedInt); clampQuality is a
// thin wrapper fixing the JPEG quality bounds/default — its behavior must stay
// byte-identical to png-jpg's old inline clampQuality.

describe("clampInt", () => {
  it("returns an in-range value unchanged", () => {
    expect(clampInt(50, 0, 100, 10)).toBe(50);
  });

  it("clamps below min and above max to the bounds", () => {
    expect(clampInt(-5, 0, 100, 10)).toBe(0);
    expect(clampInt(250, 0, 100, 10)).toBe(100);
  });

  it("rounds to the nearest integer", () => {
    expect(clampInt(73.6, 0, 100, 10)).toBe(74);
    expect(clampInt(73.4, 0, 100, 10)).toBe(73);
  });

  it("coerces numeric strings", () => {
    expect(clampInt("42", 0, 100, 10)).toBe(42);
    expect(clampInt("150.7", 0, 100, 10)).toBe(100); // coerced then clamped
  });

  it("falls back on non-finite / non-numeric input", () => {
    expect(clampInt("abc", 0, 100, 10)).toBe(10);
    expect(clampInt(undefined, 0, 100, 10)).toBe(10);
    expect(clampInt(NaN, 0, 100, 10)).toBe(10);
  });

  it("coerces null via Number() to 0 then clamps (NOT a fallback) — matches the lifted behavior", () => {
    // Number(null) === 0, which is finite, so it is clamped into range rather
    // than triggering the fallback. This documents the verbatim-lifted behavior.
    expect(clampInt(null, 0, 100, 10)).toBe(0);
    expect(clampInt(null, 50, 100, 10)).toBe(50);
  });
});

// These mirror image-converter.test.ts's clampQuality cases exactly, asserting
// the folded clampQuality keeps the same [10,100] bounds, rounding, and 92
// default it had inline in png-jpg.
describe("clampQuality", () => {
  it("returns an in-range value unchanged", () => {
    expect(clampQuality(80)).toBe(80);
  });

  it("clamps to [10, 100]", () => {
    expect(clampQuality(0)).toBe(10);
    expect(clampQuality(250)).toBe(100);
  });

  it("rounds a numeric string", () => {
    expect(clampQuality("73.6")).toBe(74);
  });

  it("falls back to the 92 default on bad input", () => {
    expect(clampQuality("abc")).toBe(92);
    expect(clampQuality(undefined)).toBe(92);
    expect(clampQuality(NaN)).toBe(92);
  });
});
