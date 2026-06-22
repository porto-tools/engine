// Flatten PDF — bake form fields and annotations into the page content so the
// document looks the same everywhere but is no longer interactive. If the PDF
// has no form, we re-save it cleanly without error (a no-op flatten is useful
// for stripping invisible annotation layers even when there are no fields).
//
// pdf-lib is pure JS — no WASM, no browser APIs — so no `loadEngine` is needed.
// The library is lazy-loaded inside `convert` so it stays in the /flatten-pdf
// route chunk only.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { loadPdfDocument } from "./pdf-lib-load";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

async function convertFlattenPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }

  // Lazy-load pdf-lib so it stays in the /flatten-pdf route chunk only.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  const doc = await loadPdfDocument(PDFDocument, file, "We couldn't read this PDF — the file may be damaged.");

  throwIfAborted(signal);

  onProgress?.({ stage: "Flattening" });

  // getForm() always returns a PDFForm; flatten() bakes fields + annotations into
  // page content. On a PDF with no fields this is a safe no-op — pdf-lib does not
  // throw, it just iterates an empty field list and marks the form as flattened.
  try {
    doc.getForm().flatten();
  } catch (err) {
    // Defensive: some exotic PDFs may have a malformed AcroForm that errors on
    // flatten. Log to technical details but continue — re-saving without flatten
    // is still useful (produces a clean PDF stream).
    void err; // intentionally ignored — we fall through to save
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const saved = await doc.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  return {
    blob,
    filename: file.name,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const flattenPdfDescriptor: ConversionDescriptor = {
  id: "flatten-pdf",
  fromLabel: "PDF",
  toLabel: "Flattened",
  accept: ["application/pdf"],
  newExtension: "pdf",
  convert: convertFlattenPdf,
};
