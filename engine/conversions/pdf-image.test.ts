import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  pdfToJpgDescriptor,
  pdfToPngDescriptor,
  computePageScale,
  computePageScaleAtDpi,
} from "./pdf-image";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-image", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// PDF→image rendering needs the full browser stack:
//   1. pdf.js (`pdfjs-dist`) — its main build evaluates `new DOMMatrix()` at
//      import time, which does not exist in plain Node, so even the dynamic
//      import inside loadEngine throws here.
//   2. a Web Worker for GlobalWorkerOptions.workerSrc.
//   3. document.createElement("canvas") + getContext("2d") + toBlob — none of
//      which render real pixels in Node.
//
// TODO(test-env): wire up a browser/canvas test environment (e.g. vitest browser
// mode, or happy-dom + a worker + node-canvas) so the render happy path can run
// in CI. Until then the engine-dependent tests are guarded with it.skipIf and
// skip in Node (verified by manual QC). The pure size policy (`computePageScale`)
// and the type-gate / cancellation paths — which all run BEFORE any pdf.js
// import or Canvas call — run unconditionally and keep real coverage.
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

describe("pdfToJpgDescriptor / pdfToPngDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(pdfToJpgDescriptor.id).toBe("pdf-to-jpg");
    expect(pdfToJpgDescriptor.fromLabel).toBe("PDF");
    expect(pdfToJpgDescriptor.toLabel).toBe("JPG");
    expect(pdfToJpgDescriptor.newExtension).toBe("jpg");
    expect(pdfToJpgDescriptor.accept).toEqual(["application/pdf"]);
    expect(pdfToJpgDescriptor.outputMode).toBe("multi");
    // loadEngine is required for the multi-MB pdf.js library.
    expect(typeof pdfToJpgDescriptor.loadEngine).toBe("function");

    expect(pdfToPngDescriptor.id).toBe("pdf-to-png");
    expect(pdfToPngDescriptor.toLabel).toBe("PNG");
    expect(pdfToPngDescriptor.newExtension).toBe("png");
    expect(pdfToPngDescriptor.outputMode).toBe("multi");
    expect(typeof pdfToPngDescriptor.loadEngine).toBe("function");
    // No image→PDF route exists, so reverse is intentionally omitted (the page
    // passes no reverse hint either).
    expect(pdfToPngDescriptor.accept).toEqual(["application/pdf"]);
  });

  // Needs the real browser stack (pdf.js + worker + Canvas) to render pixels;
  // skipped in the Node test env. Asserts one output per page (2-page fixture).
  // This is ALSO the regression guard for the "doc.destroy is not a function"
  // crash: the conversion must run to completion and return outputs, which it
  // could not while the unconditional doc.destroy() in the finally threw. With
  // no `pages` option the DEFAULT is every page.
  it.skipIf(!canvasAvailable)("renders each page of a 2-page PDF to JPG (default = all pages)", async () => {
    await pdfToJpgDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToJpgDescriptor.convert({ file });

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.outputs).toBeDefined();
    expect(result.outputs!).toHaveLength(2);
    expect(result.outputs![0].filename).toBe("two-page-page-1.jpg");
    expect(result.outputs![1].filename).toBe("two-page-page-2.jpg");
    expect(result.outputs!.every((o) => o.size > 0)).toBe(true);
    // Representative single fields point at the first rendered page.
    expect(result.filename).toBe("two-page-page-1.jpg");
    expect(result.inputSize).toBe(file.size);
    expect(result.outputSize).toBe(result.outputs!.reduce((s, o) => s + o.size, 0));
  });

  it.skipIf(!canvasAvailable)("renders each page of a 2-page PDF to PNG (default = all pages)", async () => {
    await pdfToPngDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToPngDescriptor.convert({ file });

    expect(result.mimeType).toBe("image/png");
    expect(result.outputs!).toHaveLength(2);
    expect(result.outputs![0].filename).toBe("two-page-page-1.png");
    expect(result.outputs![1].mimeType).toBe("image/png");
  });

  // PAGE SELECTION: a `pages` option narrows the render to JUST those pages, and
  // the filenames keep the ORIGINAL 1-based page number — so selecting only
  // page 2 of the 2-page fixture yields exactly one output, "…-page-2.jpg".
  // Canvas-gated (needs a real render); the option-PARSING contract itself is
  // covered without a DOM by parsePageRange's own tests.
  it.skipIf(!canvasAvailable)("renders ONLY the selected pages when a `pages` option is given", async () => {
    await pdfToJpgDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToJpgDescriptor.convert({ file, options: { pages: "2" } });

    expect(result.outputs!).toHaveLength(1);
    expect(result.outputs![0].filename).toBe("two-page-page-2.jpg");
    // The representative single fields point at the first (only) rendered page.
    expect(result.filename).toBe("two-page-page-2.jpg");
  });

  // An empty / whitespace `pages` option means "all pages" (parsePageRange's
  // allowAll), so it behaves exactly like passing no option — every page renders.
  it.skipIf(!canvasAvailable)("treats an empty `pages` option as all pages", async () => {
    await pdfToPngDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToPngDescriptor.convert({ file, options: { pages: "" } });

    expect(result.outputs!).toHaveLength(2);
  });

  // A selection that matches no in-range page (a stale range against a shorter
  // document) is a clear, non-recoverable nudge — not a crash on outputs[0].
  it.skipIf(!canvasAvailable)("rejects a `pages` selection that matches no page as UNSUPPORTED_INPUT", async () => {
    await pdfToJpgDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    await expect(
      pdfToJpgDescriptor.convert({ file, options: { pages: "9" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT (both directions)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(pdfToJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
    await expect(pdfToPngDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // Reaching DECODE_FAILED requires pdf.js to actually parse the bytes, which
  // needs the browser stack; skipped in Node (manual QC). Empty/corrupt PDF
  // bytes make getDocument reject → DECODE_FAILED.
  it.skipIf(!canvasAvailable)("rejects corrupt PDF bytes as DECODE_FAILED", async () => {
    await pdfToJpgDescriptor.loadEngine!();
    const file = new File([new TextEncoder().encode("%PDF-1.4 not a real pdf")], "broken.pdf", {
      type: "application/pdf",
    });
    await expect(pdfToJpgDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // A real PDF fixture so the only reason to reject is the abort, not the type
    // gate. throwIfAborted runs before assertSupported and before any pdf.js
    // import, so this is safe to run in Node.
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    await expect(
      pdfToJpgDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
    await expect(
      pdfToPngDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// The render-scale policy is the only branch-heavy logic in this conversion and
// it is pure (no DOM), so it gets full unit coverage here.
describe("computePageScale", () => {
  it("scales a portrait A4 page (595×842 pt) so the long edge ≈ 1684 px", () => {
    const { width, height } = computePageScale(595, 842);
    expect(height).toBe(1684);
    // Aspect ratio preserved.
    expect(width).toBe(Math.round(595 * (1684 / 842)));
  });

  it("scales a landscape page so the long (width) edge ≈ 1684 px", () => {
    const { width } = computePageScale(842, 595);
    expect(width).toBe(1684);
  });

  it("scales a huge page down to the long-edge target, never exceeding the cap", () => {
    const { width, height } = computePageScale(20000, 10000);
    // The downscale to the 1684-px target always lands well under the 4000 cap,
    // so the long edge ends at the target and the cap is a pure safety net.
    expect(Math.max(width, height)).toBe(1684);
    expect(Math.max(width, height)).toBeLessThanOrEqual(4000);
    // Aspect ratio (2:1) preserved.
    expect(width).toBe(1684);
    expect(height).toBe(842);
  });

  it("renders a degenerate (zero) viewport to a tiny but valid 1×1 canvas", () => {
    expect(computePageScale(0, 0)).toEqual({ scale: 1, width: 1, height: 1 });
    expect(computePageScale(595, 0)).toEqual({ scale: 1, width: 1, height: 1 });
  });

  it("never returns a sub-pixel dimension for a tiny page", () => {
    const { width, height } = computePageScale(1, 1);
    expect(width).toBeGreaterThanOrEqual(1);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

describe("computePageScaleAtDpi", () => {
  it("renders 1:1 (one point = one pixel) at 72 DPI", () => {
    const { scale, width, height } = computePageScaleAtDpi(595, 842, 72);
    expect(scale).toBe(1);
    expect(width).toBe(595);
    expect(height).toBe(842);
  });

  it("scales an A4 page by dpi/72 at 150 DPI", () => {
    const { width, height } = computePageScaleAtDpi(595, 842, 150);
    expect(width).toBe(Math.round(595 * (150 / 72)));
    expect(height).toBe(Math.round(842 * (150 / 72)));
  });

  it("clamps so neither axis exceeds the 4000-px cap, preserving aspect ratio", () => {
    // 20000pt at 300 DPI would be 83333 px; the cap pins the long edge to 4000.
    const { width, height } = computePageScaleAtDpi(20000, 10000, 300);
    expect(Math.max(width, height)).toBe(4000);
    expect(width).toBe(4000);
    expect(height).toBe(2000);
  });

  it("renders a degenerate (zero) viewport to a tiny but valid 1×1 canvas", () => {
    expect(computePageScaleAtDpi(0, 0, 150)).toEqual({ scale: 1, width: 1, height: 1 });
  });
});
