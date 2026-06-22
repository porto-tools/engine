// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// for real in Node (no skip-guard needed). We do not assert that the output is
// smaller than the input: a PDF with no form fields re-saves at a similar size,
// which is correct and intentional behaviour.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flattenPdfDescriptor } from "./flatten-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  join(HERE, "__fixtures__", "flatten-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

describe("flattenPdfDescriptor", () => {
  it("flattens (or re-saves) a PDF and produces a valid PDF output", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await flattenPdfDescriptor.convert({ file });

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
    await expect(flattenPdfDescriptor.convert({ file })).rejects.toMatchObject({
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
    await expect(flattenPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.pdf");
    await expect(
      flattenPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
