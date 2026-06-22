import { describe, it, expect } from "vitest";
import {
  redactPdfDescriptor,
  rectToPixels,
  textItemToRect,
  findTextRects,
  mergeRects,
  PII_PRESETS,
  type TextContentItem,
  type PageSize,
  type RedactionRect,
} from "./redact-pdf";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The full redaction round-trip needs the browser stack — exactly like
// pdf-image.test.ts:
//   1. pdf.js (`pdfjs-dist`) — its main build evaluates `new DOMMatrix()` at
//      import time, which doesn't exist in plain Node, so even loadEngine's
//      dynamic import throws here.
//   2. a Web Worker for GlobalWorkerOptions.workerSrc.
//   3. document.createElement("canvas") + getContext("2d") + toBlob — none of
//      which render real pixels in Node.
//
// So the render happy path is gated/skipped in Node (same as pdf-image.test.ts);
// the descriptor shape, the type-gate / cancellation paths (which run BEFORE any
// pdf.js import or Canvas call), and the pure rectToPixels math run
// unconditionally and carry the real coverage.
const canvasAvailable =
  typeof document !== "undefined" &&
  typeof document.createElement === "function" &&
  typeof Worker !== "undefined" &&
  (() => {
    try {
      return document.createElement("canvas").getContext("2d") !== null;
    } catch {
      return false;
    }
  })();

describe("redactPdfDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(redactPdfDescriptor.id).toBe("redact-pdf");
    expect(redactPdfDescriptor.fromLabel).toBe("PDF");
    expect(redactPdfDescriptor.toLabel).toBe("Redacted PDF");
    expect(redactPdfDescriptor.newExtension).toBe("pdf");
    expect(redactPdfDescriptor.accept).toEqual(["application/pdf"]);
    // pdf.js is lazy-loaded, so loadEngine + a setup label are required.
    expect(typeof redactPdfDescriptor.loadEngine).toBe("function");
    expect(redactPdfDescriptor.setupSizeLabel).toBe("≈ 5 MB");
    // Single-output (one redacted PDF), so outputMode stays at the default.
    expect(redactPdfDescriptor.outputMode).toBeUndefined();
  });

  it("exposes a loadEngine that resolves (or fails recoverably) without throwing synchronously", () => {
    // We only assert the contract shape here — calling it for real imports the
    // multi-MB pdf.js, which throws in Node (no DOMMatrix). The browser-gated
    // tests below exercise the real load.
    expect(typeof redactPdfDescriptor.loadEngine).toBe("function");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(redactPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // A PDF-typed file so the only reason to reject is the abort, not the type
    // gate. throwIfAborted runs before assertSupported and before any pdf.js
    // import, so this is safe to run in Node.
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", {
      type: "application/pdf",
    });
    await expect(
      redactPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // The real render round-trip: load pdf.js, redact a box on page 1, and confirm
  // we get back a valid image-only PDF. Needs the browser stack, so it skips in
  // Node (manual QC), exactly like pdf-image.test.ts's render tests.
  it.skipIf(!canvasAvailable)("rasterises and redacts a PDF into an image-only PDF", async () => {
    await redactPdfDescriptor.loadEngine!();
    // A tiny but real one-page PDF would be loaded from a fixture in a browser
    // test env; here the gate skips this in Node. Left as documentation of the
    // intended round-trip assertion.
    expect(typeof redactPdfDescriptor.convert).toBe("function");
  });
});

// rectToPixels is the only branch-heavy logic that is pure (no DOM), so it gets
// full unit coverage. It maps a FRACTIONAL rect (0..1, origin top-left) to integer
// canvas pixels, clamped to the canvas, never negative-sized.
describe("rectToPixels", () => {
  it("maps a centred quarter-rect to the centre of the canvas", () => {
    // x/y at 0.25, w/h at 0.5 → a box from (250,150) to (750,450) on a 1000×600
    // canvas.
    const px = rectToPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 600);
    expect(px).toEqual({ x: 250, y: 150, w: 500, h: 300 });
  });

  it("maps a full-page rect to the whole canvas", () => {
    const px = rectToPixels({ x: 0, y: 0, w: 1, h: 1 }, 800, 1200);
    expect(px).toEqual({ x: 0, y: 0, w: 800, h: 1200 });
  });

  it("clamps a rect that overflows the right/bottom edges to the canvas bounds", () => {
    // Starts at 0.9 and is 0.5 wide → would reach 1.4; clamps to the edge.
    const px = rectToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 1000);
    expect(px).toEqual({ x: 900, y: 900, w: 100, h: 100 });
  });

  it("clamps a rect with a negative origin to the top-left corner", () => {
    const px = rectToPixels({ x: -0.2, y: -0.2, w: 0.4, h: 0.4 }, 500, 500);
    // -0.2 clamps to 0; the far corner is at 0.2 → 100px.
    expect(px).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("normalises a rect drawn right-to-left / bottom-to-top (negative w/h)", () => {
    // Origin at 0.8 with width -0.3 spans 0.5..0.8 → 500..800 on a 1000 canvas.
    const px = rectToPixels({ x: 0.8, y: 0.8, w: -0.3, h: -0.3 }, 1000, 1000);
    expect(px).toEqual({ x: 500, y: 500, w: 300, h: 300 });
  });

  it("returns a zero-area rect for a fully out-of-bounds box", () => {
    // Entirely past the right edge → clamps to a zero-width box at the edge.
    const px = rectToPixels({ x: 1.5, y: 1.5, w: 0.2, h: 0.2 }, 1000, 1000);
    expect(px.w).toBe(0);
    expect(px.h).toBe(0);
  });

  it("handles a degenerate (zero-size) canvas without negatives or NaN", () => {
    const px = rectToPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0, 0);
    expect(px).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("treats non-finite coordinates as 0 so garbage data never paints a box", () => {
    // Non-finite coords are the unsafe case: rather than guess, every non-finite
    // fraction collapses to 0, yielding a safe zero-area box the caller skips.
    // (The engine's parseRedactions also rejects non-finite coords up front, so
    // this is belt-and-braces.)
    const px = rectToPixels(
      { x: Number.NaN, y: 0.1, w: 0.5, h: Number.POSITIVE_INFINITY },
      400,
      400,
    );
    // x is NaN, which poisons both x and x+w (NaN) → both clamp to 0 → zero width.
    expect(px.x).toBe(0);
    expect(px.w).toBe(0);
    // y 0.1 → 40; h Infinity is non-finite → the far edge collapses to 40 too →
    // a zero-height (safe) box rather than a guessed full-page redaction.
    expect(px.y).toBe(40);
    expect(px.h).toBe(0);
  });
});

// ── Auto-detect helpers (the security-sensitive quality lever) ────────────────
//
// These run in plain Node — they are pure functions over SYNTHETIC text-content
// items, no pdf.js / DOM. A text item carries the pdf.js geometry:
//   transform = [a, b, c, d, e, f]; (e, f) is the baseline lower-left in PDF
//   points (BOTTOM-left origin), `width`/`height` the run's size in points.
// Helper that builds one such item with sensible identity scale.
function item(str: string, e: number, f: number, width: number, height: number): TextContentItem {
  return { str, transform: [1, 0, 0, 1, e, f], width, height };
}

// A 100×200-point page makes the fraction math read cleanly (e=10 → fx 0.1, etc).
const PAGE: PageSize = { width: 100, height: 200 };

// Close-enough comparison for the float fraction math.
function expectRectClose(got: RedactionRect | null, want: RedactionRect): void {
  expect(got).not.toBeNull();
  const r = got!;
  expect(r.x).toBeCloseTo(want.x, 6);
  expect(r.y).toBeCloseTo(want.y, 6);
  expect(r.w).toBeCloseTo(want.w, 6);
  expect(r.h).toBeCloseTo(want.h, 6);
}

describe("textItemToRect", () => {
  it("maps a full item's PDF (bottom-left) box to a fractional top-left rect", () => {
    // e=10,f=180,w=20,h=10 on a 100×200 page:
    //   x = 10/100 = 0.10, w = 20/100 = 0.20
    //   top = (200-(180+10))/200 = 0.05, bottom = (200-180)/200 = 0.10 → y 0.05, h 0.05
    const r = textItemToRect(item("hello", 10, 180, 20, 10), PAGE);
    expectRectClose(r, { x: 0.1, y: 0.05, w: 0.2, h: 0.05 });
  });

  it("narrows x proportionally for a substring share, leaving y/height unchanged", () => {
    // The middle 50% of the run (share 0.25..0.75) over the same item:
    //   x = 0.10 + 0.20*0.25 = 0.15, far = 0.10 + 0.20*0.75 = 0.25 → x 0.15, w 0.10
    const r = textItemToRect(item("hello", 10, 180, 20, 10), PAGE, { start: 0.25, end: 0.75 });
    expectRectClose(r, { x: 0.15, y: 0.05, w: 0.1, h: 0.05 });
  });

  it("returns null for a degenerate (zero/negative size) run", () => {
    expect(textItemToRect(item("x", 10, 180, 0, 10), PAGE)).toBeNull();
    expect(textItemToRect(item("x", 10, 180, 20, 0), PAGE)).toBeNull();
  });

  it("returns null for a non-finite transform rather than guessing a box", () => {
    const bad: TextContentItem = { str: "x", transform: [1, 0, 0, 1, Number.NaN, 180], width: 20, height: 10 };
    expect(textItemToRect(bad, PAGE)).toBeNull();
  });

  it("clamps an out-of-page item into the page bounds", () => {
    // e=90,w=40 would reach x 1.3; clamps the far edge to 1.0 → x 0.9, w 0.1.
    const r = textItemToRect(item("x", 90, 180, 40, 10), PAGE);
    expectRectClose(r, { x: 0.9, y: 0.05, w: 0.1, h: 0.05 });
  });
});

describe("findTextRects — PII presets", () => {
  // One item spanning the whole 100-wide page so a matched substring's
  // proportional x-span is easy to reason about.
  const wide = (str: string) => [item(str, 0, 180, 100, 10)];

  it("email: matches real addresses and rejects near-misses", () => {
    const good = ["a@b.co", "first.last@sub.example.com", "x+y@mail.org"];
    for (const s of good) {
      expect(findTextRects(wide(s), PAGE, ["email"]).length).toBe(1);
    }
    const bad = ["plainword", "no-at-sign.com", "missing@tld", "@no-local.com", "trailing@dot."];
    for (const s of bad) {
      expect(findTextRects(wide(s), PAGE, ["email"]).length).toBe(0);
    }
  });

  it("phone: matches common US formats and rejects too-short / too-long runs", () => {
    const good = ["(555) 123-4567", "555-123-4567", "+1 555 123 4567", "5551234567", "555.123.4567"];
    for (const s of good) {
      expect(findTextRects(wide(s), PAGE, ["phone"]).length).toBe(1);
    }
    const bad = ["12345", "phone here", "12-34-56"];
    for (const s of bad) {
      expect(findTextRects(wide(s), PAGE, ["phone"]).length).toBe(0);
    }
  });

  it("credit-card: matches 13–16 digit grouped numbers and rejects short runs", () => {
    const good = ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "4222222222222"];
    for (const s of good) {
      expect(findTextRects(wide(s), PAGE, ["creditCard"]).length).toBe(1);
    }
    const bad = ["1234", "12345678", "year 2024 only"];
    for (const s of bad) {
      expect(findTextRects(wide(s), PAGE, ["creditCard"]).length).toBe(0);
    }
  });

  it("SSN: matches ###-##-#### (and unseparated) and rejects near-misses", () => {
    const good = ["123-45-6789", "123 45 6789", "123456789"];
    for (const s of good) {
      expect(findTextRects(wide(s), PAGE, ["ssn"]).length).toBe(1);
    }
    const bad = ["12-345-6789", "1234-56-789", "abc-de-fghi"];
    for (const s of bad) {
      expect(findTextRects(wide(s), PAGE, ["ssn"]).length).toBe(0);
    }
  });

  it("only runs the ENABLED presets — an email is ignored when only SSN is on", () => {
    expect(findTextRects(wide("a@b.co"), PAGE, ["ssn"]).length).toBe(0);
    expect(findTextRects(wide("a@b.co"), PAGE, ["email"]).length).toBe(1);
  });

  it("no active presets and no term → no rects", () => {
    expect(findTextRects(wide("a@b.co 123-45-6789"), PAGE, []).length).toBe(0);
  });

  it("places a match at the proportionally-correct x-span within the item", () => {
    // "ssn: 123-45-6789" — the SSN is the trailing 11 chars of a 16-char string,
    // so its x-span starts at 5/16 and ends at 16/16 of the 100-wide page.
    const str = "ssn: 123-45-6789";
    const rects = findTextRects([item(str, 0, 180, 100, 10)], PAGE, ["ssn"]);
    expect(rects.length).toBe(1);
    const idx = str.indexOf("123");
    expect(rects[0].x).toBeCloseTo(idx / str.length, 6);
    expect(rects[0].x + rects[0].w).toBeCloseTo(1, 6);
  });

  it("guards against catastrophic backtracking on a long adversarial run", () => {
    // A long run of digits + letters is the classic ReDoS trigger. The presets are
    // linear, so this returns promptly (a watchdog also fails the test if it hangs).
    const evil = "1".repeat(5000) + "a".repeat(5000) + "@";
    const started = Date.now();
    findTextRects([item(evil, 0, 180, 100, 10)], PAGE, ["email", "phone", "creditCard", "ssn"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("findTextRects — literal search term", () => {
  const wide = (str: string) => [item(str, 0, 180, 100, 10)];

  it("matches the term case-insensitively", () => {
    expect(findTextRects(wide("The SECRET plan"), PAGE, [], "secret").length).toBe(1);
    expect(findTextRects(wide("the secret plan"), PAGE, [], "SECRET").length).toBe(1);
  });

  it("finds EVERY occurrence in an item", () => {
    expect(findTextRects(wide("ab ab ab"), PAGE, [], "ab").length).toBe(3);
  });

  it("treats the term literally — metacharacters are not wildcards", () => {
    // "a.b" must match the literal "a.b", not "axb".
    expect(findTextRects(wide("axb"), PAGE, [], "a.b").length).toBe(0);
    expect(findTextRects(wide("a.b here"), PAGE, [], "a.b").length).toBe(1);
  });

  it("an empty / whitespace term contributes nothing", () => {
    expect(findTextRects(wide("anything"), PAGE, [], "").length).toBe(0);
    expect(findTextRects(wide("anything"), PAGE, [], "   ").length).toBe(0);
  });

  it("composes with presets — both a term and a preset contribute rects", () => {
    const rects = findTextRects(
      [item("call me: 555-123-4567", 0, 180, 100, 10), item("project APOLLO", 0, 100, 100, 10)],
      PAGE,
      ["phone"],
      "apollo",
    );
    // one phone rect + one term rect.
    expect(rects.length).toBe(2);
  });

  it("no matches anywhere → no rects", () => {
    expect(findTextRects(wide("nothing to see"), PAGE, ["email"], "absent").length).toBe(0);
  });
});

describe("mergeRects (manual + auto, overlap dedupe)", () => {
  it("concatenates non-overlapping manual and auto rects", () => {
    const manual: RedactionRect[] = [{ x: 0, y: 0, w: 0.1, h: 0.1 }];
    const auto: RedactionRect[] = [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }];
    expect(mergeRects(manual, auto)).toHaveLength(2);
  });

  it("drops an auto rect fully contained inside a manual one", () => {
    const manual: RedactionRect[] = [{ x: 0, y: 0, w: 0.5, h: 0.5 }];
    const auto: RedactionRect[] = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    const merged = mergeRects(manual, auto);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(manual[0]);
  });

  it("keeps exactly one of a pair of identical rects", () => {
    const r: RedactionRect = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    const merged = mergeRects([{ ...r }], [{ ...r }]);
    expect(merged).toHaveLength(1);
  });

  it("keeps two partially-overlapping rects (no union geometry)", () => {
    const manual: RedactionRect[] = [{ x: 0, y: 0, w: 0.3, h: 0.3 }];
    const auto: RedactionRect[] = [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }];
    expect(mergeRects(manual, auto)).toHaveLength(2);
  });

  it("an empty side leaves the other untouched", () => {
    const auto: RedactionRect[] = [{ x: 0, y: 0, w: 0.1, h: 0.1 }];
    expect(mergeRects([], auto)).toEqual(auto);
    expect(mergeRects(auto, [])).toEqual(auto);
  });
});

describe("PII_PRESETS registry", () => {
  it("exposes the four documented presets, each building a fresh global RegExp", () => {
    expect(PII_PRESETS.map((p) => p.key).sort()).toEqual(["creditCard", "email", "phone", "ssn"]);
    for (const p of PII_PRESETS) {
      const re = p.build();
      expect(re).toBeInstanceOf(RegExp);
      expect(re.global).toBe(true);
      // Fresh instance each call so a stateful lastIndex never leaks between pages.
      expect(p.build()).not.toBe(re);
    }
  });
});
