// Delete PDF Pages — remove selected pages from a PDF.
//
// The tool has one control: `pages` (page-range) specifying which pages to
// delete. Pages are removed in DESCENDING index order so earlier index removals
// do not shift the positions of later ones. Attempting to delete all pages is
// rejected as an error (you cannot produce an empty PDF).
//
// pdf-lib is pure JS (no WASM), so no `loadEngine` is needed.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { parsePageRange } from "../page-range";
import { loadPdfDocument } from "./pdf-lib-load";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

async function convertDeletePdfPages(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }

  // Lazy-load pdf-lib so it stays in the /delete-pdf-pages route chunk only.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  const doc = await loadPdfDocument(PDFDocument, file, "We couldn't read this PDF — the file may be damaged.");

  throwIfAborted(signal);

  const pageCount = doc.getPageCount();

  // Parse page-range. For delete, an empty/blank string means "nothing to
  // delete" — we do NOT use the allowAll semantic here (that's for tools that
  // default to all pages). If nothing parses to a valid page we return the
  // original unchanged.
  const pagesStr = typeof options?.pages === "string" ? options.pages.trim() : "";

  if (pagesStr === "") {
    // Nothing selected — return the original unchanged.
    const bytes = await file.arrayBuffer();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const dot = file.name.lastIndexOf(".");
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    return {
      blob,
      filename: `${base}-pages-deleted.pdf`,
      mimeType: "application/pdf",
      inputSize: file.size,
      outputSize: blob.size,
    };
  }

  const pageNumbers = parsePageRange(pagesStr, pageCount); // 1-based, sorted ascending

  if (pageNumbers.length === 0) {
    // Syntactically invalid or fully out-of-range range — return unchanged.
    const bytes = await file.arrayBuffer();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const dot = file.name.lastIndexOf(".");
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    return {
      blob,
      filename: `${base}-pages-deleted.pdf`,
      mimeType: "application/pdf",
      inputSize: file.size,
      outputSize: blob.size,
    };
  }

  // Guard: refuse to delete every page (pdf-lib would produce a 0-page PDF).
  if (pageNumbers.length >= pageCount) {
    throw new ConversionError("You can't delete all pages — the result would be an empty PDF.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Attempted to delete ${pageNumbers.length} of ${pageCount} pages.`,
    });
  }

  onProgress?.({ stage: "Deleting pages" });

  // Remove in DESCENDING order so earlier removals don't shift later indices.
  const sortedDesc = [...pageNumbers].sort((a, b) => b - a);
  for (const pageNum of sortedDesc) {
    throwIfAborted(signal);
    doc.removePage(pageNum - 1); // removePage is 0-based
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const saved = await doc.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  const dot = file.name.lastIndexOf(".");
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;

  return {
    blob,
    filename: `${base}-pages-deleted.pdf`,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const deletePdfPagesDescriptor: ConversionDescriptor = {
  id: "delete-pdf-pages",
  fromLabel: "PDF",
  toLabel: "Trimmed",
  accept: ["application/pdf"],
  newExtension: "pdf",
  defaultOptions: { pages: "" },
  controls: [
    {
      type: "page-range",
      id: "pages",
      label: "Pages to delete",
      help: "Enter the pages to remove, e.g. 2-4,7. The remaining pages are saved.",
      default: "",
    },
  ],
  convert: convertDeletePdfPages,
};
