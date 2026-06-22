import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractPdfImagesDescriptor } from "./extract-pdf-images";

// Reuse the pdf-image fixtures (a real, parseable PDF) so the cancellation path
// rejects for the abort reason, not the type gate.
const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-image", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The actual image EXTRACTION needs the full browser stack, exactly like
// pdf-image.test.ts:
//   1. pdf.js (`pdfjs-dist`) — its main build evaluates `new DOMMatrix()` at
//      import time, which does not exist in plain Node, so even loadEngine's
//      dynamic import throws here.
//   2. a Web Worker for GlobalWorkerOptions.workerSrc + getOperatorList.
//   3. document.createElement("canvas") + getContext("2d") + putImageData +
//      toBlob — none of which produce real pixels in Node.
//
// TODO(test-env): wire up a browser/canvas test environment so the extraction
// happy path can run in CI. Until then the engine-dependent assertions are
// gated with it.skipIf and skip in Node (verified by manual QC). The descriptor
// fields, the type-gate (UNSUPPORTED_INPUT), and the cancellation path — all of
// which run BEFORE any pdf.js import or Canvas call — run unconditionally and
// keep real coverage.
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

describe("extractPdfImagesDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(extractPdfImagesDescriptor.id).toBe("extract-pdf-images");
    expect(extractPdfImagesDescriptor.fromLabel).toBe("PDF");
    expect(extractPdfImagesDescriptor.toLabel).toBe("Images");
    expect(extractPdfImagesDescriptor.newExtension).toBe("png");
    expect(extractPdfImagesDescriptor.accept).toEqual(["application/pdf"]);
    expect(extractPdfImagesDescriptor.outputMode).toBe("multi");
    expect(extractPdfImagesDescriptor.setupSizeLabel).toBe("≈ 5 MB");
    // loadEngine is required for the multi-MB pdf.js library.
    expect(typeof extractPdfImagesDescriptor.loadEngine).toBe("function");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT (before any engine load)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(extractPdfImagesDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
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
      extractPdfImagesDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // The extraction itself needs the real browser stack (pdf.js + worker +
  // Canvas) to parse the page, resolve image objects, and encode PNGs; skipped in
  // the Node test env (manual QC). A two-page text PDF carries no embedded raster
  // images, so the result is the recoverable UNSUPPORTED_INPUT "no images" nudge.
  it.skipIf(!canvasAvailable)(
    "reports UNSUPPORTED_INPUT when a PDF has no extractable images",
    async () => {
      await extractPdfImagesDescriptor.loadEngine!();
      const file = await fileFromFixture("two-page.pdf", "application/pdf");
      await expect(extractPdfImagesDescriptor.convert({ file })).rejects.toMatchObject({
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
      });
    },
  );
});
