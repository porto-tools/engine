import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfToTextDescriptor } from "./pdf-to-text";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the committed text-bearing fixture from the PDF→image tests: a tiny
// 2-page PDF whose pages contain the literal text "Page 1" and "Page 2" (drawn
// as a real text layer, see pdf-image/gen-fixture.mjs). It is exactly what a
// text-extraction happy path needs, so we don't add a redundant fixture.
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-image", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// porto-tools' vitest.config.ts uses the default Node environment. The shared
// loadPdfjs() imports pdfjs-dist's DEFAULT (browser) build, which evaluates
// `new DOMMatrix()` at import time — undefined in plain Node — so loadEngine
// throws here exactly like the PDF→image tests. Text extraction itself needs no
// Canvas, but the import gate is the same. So the engine-dependent paths are
// guarded with it.skipIf and skip in Node (verified by manual QC); the type-gate
// and cancellation paths, which run BEFORE any pdf.js import, run unconditionally
// and keep real coverage. We probe availability ONCE by attempting the load.
const pdfjsAvailable = await (async () => {
  try {
    await pdfToTextDescriptor.loadEngine!();
    return true;
  } catch {
    return false;
  }
})();

describe("pdfToTextDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(pdfToTextDescriptor.id).toBe("pdf-to-text");
    expect(pdfToTextDescriptor.fromLabel).toBe("PDF");
    expect(pdfToTextDescriptor.toLabel).toBe("Text");
    expect(pdfToTextDescriptor.newExtension).toBe("txt");
    expect(pdfToTextDescriptor.accept).toEqual(["application/pdf"]);
    // loadEngine is required for the multi-MB pdf.js library.
    expect(typeof pdfToTextDescriptor.loadEngine).toBe("function");
  });

  it("defaults the format control to plain text", () => {
    const control = pdfToTextDescriptor.controls?.find((c) => c.id === "format");
    expect(control).toBeDefined();
    expect(control!.type).toBe("select");
    // The default option key is "text" — the descriptor's defaultOptions agree.
    expect((control as { default: string }).default).toBe("text");
    expect(pdfToTextDescriptor.defaultOptions).toMatchObject({ format: "text" });
  });

  // Happy path: the 2-page fixture's text layer ("Page 1" / "Page 2") is
  // extracted, pages joined by a blank line, into a single .txt file. Needs the
  // pdf.js import (gated in Node).
  it.skipIf(!pdfjsAvailable)("extracts the text layer of a 2-page PDF to plain text", async () => {
    await pdfToTextDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToTextDescriptor.convert({ file });

    expect(result.mimeType).toBe("text/plain");
    expect(result.filename).toBe("two-page.txt");
    expect(result.inputSize).toBe(file.size);
    expect(result.outputSize).toBeGreaterThan(0);

    const text = await result.blob.text();
    expect(text).toContain("Page 1");
    expect(text).toContain("Page 2");
    // Pages are separated by a blank line in plain-text mode.
    expect(text).toContain("Page 1\n\nPage 2");
  });

  // When no `format` option is passed, the converter defaults to plain text
  // (.txt / text/plain), matching the control default.
  it.skipIf(!pdfjsAvailable)("produces plain text when no format option is given", async () => {
    await pdfToTextDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToTextDescriptor.convert({ file, options: {} });

    expect(result.mimeType).toBe("text/plain");
    expect(result.filename).toBe("two-page.txt");
  });

  // Markdown format: same text, but a horizontal-rule separator between pages,
  // and a .md / text/markdown output.
  it.skipIf(!pdfjsAvailable)("produces Markdown with a page separator when format is markdown", async () => {
    await pdfToTextDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await pdfToTextDescriptor.convert({
      file,
      options: { format: "markdown" },
    });

    expect(result.mimeType).toBe("text/markdown");
    expect(result.filename).toBe("two-page.md");

    const text = await result.blob.text();
    expect(text).toContain("Page 1");
    expect(text).toContain("Page 2");
    // The best-effort Markdown separator marks the page break.
    expect(text).toContain("\n\n---\n\n");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(pdfToTextDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  // Reaching DECODE_FAILED requires pdf.js to actually parse the bytes, which
  // needs the import (gated in Node). Garbage bytes claiming the PDF MIME make
  // getDocument reject → DECODE_FAILED.
  it.skipIf(!pdfjsAvailable)("rejects corrupt PDF bytes as DECODE_FAILED", async () => {
    await pdfToTextDescriptor.loadEngine!();
    const file = new File([new TextEncoder().encode("%PDF-1.4 not a real pdf")], "broken.pdf", {
      type: "application/pdf",
    });
    await expect(pdfToTextDescriptor.convert({ file })).rejects.toMatchObject({
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
      pdfToTextDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
