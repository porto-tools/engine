// pdf-lib is pure JavaScript — no WASM, no browser APIs — so all tests run for
// real in Node. These assert exactly what the tool actually does: it sets a
// title, embeds an sRGB output intent (subtype /GTS_PDFA1), injects PDF/A-1b
// identification XMP (pdfaid:part=1, pdfaid:conformance=B), and leaves the output
// unencrypted. We do NOT assert ISO-19005 conformance — the tool is best-effort
// preparation, not a validated/certified conversion.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfToPdfaDescriptor } from "./pdf-to-pdfa";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the committed single-page fixture from the flatten-pdf suite.
const fixturePath = (name: string) => join(HERE, "__fixtures__", "flatten-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

describe("pdfToPdfaDescriptor", () => {
  it("produces a valid, unencrypted PDF with PDF/A output intent + identification XMP", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await pdfToPdfaDescriptor.convert({ file });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("tiny-pdfa.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    // The output bytes must be a real PDF (start with %PDF).
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");

    const { PDFDocument, PDFName } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(outBytes);

    // Still parses, same page count, NOT encrypted.
    const original = await PDFDocument.load(await file.arrayBuffer());
    expect(reloaded.getPageCount()).toBe(original.getPageCount());
    expect(reloaded.isEncrypted).toBe(false);

    // A title was set (the tool fills one from the basename when absent).
    expect(reloaded.getTitle()).toBeTruthy();

    // The sRGB output intent is present in the catalog.
    expect(reloaded.catalog.get(PDFName.of("OutputIntents"))).toBeTruthy();

    // The PDF/A identification XMP is present and carries the part/conformance pair.
    const meta = reloaded.catalog.lookup(PDFName.of("Metadata"));
    expect(meta).toBeTruthy();
    const xmp = new TextDecoder().decode(
      (meta as unknown as { contents: Uint8Array }).contents,
    );
    expect(xmp).toContain("<pdfaid:part>1</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(pdfToPdfaDescriptor.convert({ file })).rejects.toMatchObject({
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
    await expect(pdfToPdfaDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.pdf");
    await expect(
      pdfToPdfaDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
