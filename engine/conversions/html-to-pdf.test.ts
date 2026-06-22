import { describe, it, expect } from "vitest";
import { htmlToPdfDescriptor } from "./html-to-pdf";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The actual HTML→PDF render needs the full browser stack:
//   1. document.createElement + document.body to host an off-screen container.
//   2. html2canvas, which walks the live DOM and paints onto a real <canvas>.
//   3. canvas.toBlob to extract the PNG pixels.
// None of these render real pixels in Node, so the happy path is guarded with
// it.skipIf and skipped here (verified by manual QC). Everything that runs BEFORE
// any browser API — input validation, cancellation, the descriptor shape, and the
// filename rule — runs unconditionally and keeps real coverage.
const browserAvailable =
  typeof document !== "undefined" &&
  typeof document.createElement === "function" &&
  (() => {
    try {
      return typeof document.createElement("canvas").toBlob === "function";
    } catch {
      return false;
    }
  })();

function htmlFile(content: string, name = "page.html", type = "text/html"): File {
  return new File([new TextEncoder().encode(content)], name, { type });
}

describe("htmlToPdfDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(htmlToPdfDescriptor.id).toBe("html-to-pdf");
    expect(htmlToPdfDescriptor.fromLabel).toBe("HTML");
    expect(htmlToPdfDescriptor.toLabel).toBe("PDF");
    expect(htmlToPdfDescriptor.newExtension).toBe("pdf");
    expect(htmlToPdfDescriptor.accept).toEqual(["text/html"]);
    // html2canvas is dynamic-imported inside convert, so there is no loadEngine
    // download step (no WASM); the descriptor omits it.
    expect(htmlToPdfDescriptor.loadEngine).toBeUndefined();
    expect(typeof htmlToPdfDescriptor.convert).toBe("function");
  });

  it("rejects a non-HTML file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(htmlToPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts a .html file with an empty MIME type (by extension)", async () => {
    // Empty MIME is common for local files; we accept .html/.htm by extension.
    // It must NOT be rejected at the type gate — so an already-aborted signal is
    // the only reason this rejects, proving it passed validation.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = htmlFile("<p>hi</p>", "report.HTML", "");
    await expect(
      htmlToPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("rejects an empty-MIME file with a non-HTML extension as UNSUPPORTED_INPUT", async () => {
    const file = htmlFile("<p>hi</p>", "notes.txt", "");
    await expect(htmlToPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // A valid HTML file so the only reason to reject is the abort, not the type
    // gate. throwIfAborted runs before the html2canvas import, so this is safe in
    // Node.
    const file = htmlFile("<h1>Hello</h1>");
    await expect(
      htmlToPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // Needs the real browser stack (DOM + html2canvas + canvas.toBlob) to render
  // pixels; skipped in the Node test env. Asserts a single-page application/pdf
  // output whose filename is derived from the HTML filename.
  it.skipIf(!browserAvailable)("renders an HTML file to a single-page PDF", async () => {
    const file = htmlFile("<h1>Hello</h1><p>world</p>", "report.html");
    const result = await htmlToPdfDescriptor.convert({ file });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("report.pdf");
    expect(result.inputSize).toBe(file.size);
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.blob.type).toBe("application/pdf");
    expect(result.outputs).toBeUndefined();
  });
});
