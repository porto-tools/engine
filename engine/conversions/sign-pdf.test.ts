// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run for
// real in Node (no skip-guard needed). embedPng works in Node too, so the happy
// path uses a tiny real 2×1 PNG dataURL. We do not assert the output is smaller
// than the input: stamping a signature adds content, so the signed PDF is the
// same size or larger, which is correct and intentional behaviour.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signPdfDescriptor, placeSignature } from "./sign-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the shared tiny single-page PDF fixture (also used by flatten-pdf).
const fixturePath = (name: string) => join(HERE, "__fixtures__", "flatten-pdf", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// A tiny valid 2×1 PNG, base64-encoded as a dataURL. 2×1 (not 1×1) so the aspect
// ratio used to compute the stamped height is non-trivial in the happy path.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAVmwMtxNm1ywAAAABJRU5ErkJggg==";

describe("signPdfDescriptor", () => {
  it("has the expected descriptor fields", () => {
    expect(signPdfDescriptor.id).toBe("sign-pdf");
    expect(signPdfDescriptor.fromLabel).toBe("PDF");
    expect(signPdfDescriptor.toLabel).toBe("Signed PDF");
    expect(signPdfDescriptor.accept).toEqual(["application/pdf"]);
    expect(signPdfDescriptor.newExtension).toBe("pdf");
    // The page renders its own editor, so the descriptor declares no controls.
    expect(signPdfDescriptor.controls).toBeUndefined();
  });

  it("stamps the signature and produces a valid PDF output", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await signPdfDescriptor.convert({
      file,
      options: { signature: PNG_DATA_URL, position: "bottom-right", size: 160 },
    });

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
    await expect(
      signPdfDescriptor.convert({ file, options: { signature: PNG_DATA_URL } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects a missing signature as a recoverable UNSUPPORTED_INPUT", async () => {
    const file = await fileFromFixture("tiny.pdf");
    await expect(signPdfDescriptor.convert({ file, options: {} })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.pdf");
    await expect(
      signPdfDescriptor.convert({
        file,
        options: { signature: PNG_DATA_URL },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

// ── Pure helper: placeSignature ─────────────────────────────────────────────────
// Returns the pdf-lib draw origin (bottom-left of the signature image). All three
// positions sit at the bottom margin in y; x differs by corner.

describe("placeSignature", () => {
  const PAGE_W = 612; // US Letter width
  const PAGE_H = 792; // US Letter height
  const DRAW_W = 160;
  const DRAW_H = 80;
  const MARGIN = 36;

  it("bottom-right right-aligns x and sits y at the bottom margin", () => {
    const { x, y } = placeSignature("bottom-right", PAGE_W, PAGE_H, DRAW_W, DRAW_H, MARGIN);
    expect(x).toBe(PAGE_W - MARGIN - DRAW_W);
    expect(y).toBe(MARGIN);
  });

  it("bottom-left left-aligns x at the margin", () => {
    const { x, y } = placeSignature("bottom-left", PAGE_W, PAGE_H, DRAW_W, DRAW_H, MARGIN);
    expect(x).toBe(MARGIN);
    expect(y).toBe(MARGIN);
  });

  it("bottom-center centers x", () => {
    const { x, y } = placeSignature("bottom-center", PAGE_W, PAGE_H, DRAW_W, DRAW_H, MARGIN);
    expect(x).toBe((PAGE_W - DRAW_W) / 2);
    expect(y).toBe(MARGIN);
  });
});
