// Shared pdf-lib document loader — INTERNAL engine helper.
//
// Almost every pdf-lib-based tool (crop, rotate, delete/reorder pages, page
// numbers, watermark, sign, flatten, the pdf-editor bake…) opens its input the
// exact same way: read the File into bytes, hand them to `PDFDocument.load(...)`,
// and translate any parse failure into a `DECODE_FAILED` ConversionError. That
// `arrayBuffer()` → `load()` → try/catch boilerplate was copy-pasted into each
// tool. This file coalesces it into ONE `loadPdfDocument(...)`.
//
// Why `PDFDocument` is a PARAMETER (not imported here): each tool lazy-loads
// pdf-lib inside its own `convert` (`const { PDFDocument } = await
// import("pdf-lib")`) so the multi-hundred-KB library code-splits into that
// tool's route chunk only (verified by /check-bundle). Importing pdf-lib at this
// module's top level would pull it into every chunk that touches this helper. So
// the caller passes the already-loaded constructor in; the type-only
// `import("pdf-lib")` below is erased at compile time and adds NO runtime import.
//
// Why the user-facing MESSAGE is a PARAMETER: the tools deliberately throw
// DIFFERENT copy on a failed load — "…may be damaged.", "…damaged or
// password-protected.", "…damaged or encrypted." — tuned to what each tool can
// plausibly hit. Folding them into one message would be a user-facing
// regression, so the exact string stays the caller's to choose; this helper only
// owns the mechanism (read + load + wrap), never the wording.
//
// Tools whose load doesn't fit this shape keep their load local on purpose:
// pdf-merge (loads each input from pre-read bytes, in a loop, with a per-file
// message), pdf-split (reuses the same bytes for a second pdf.js parse),
// reorder-pdf-pages (calls getPageCount() inside the guarded block by design),
// and compress-pdf (loads from an ArrayBuffer it already holds, not a File).
// The encrypted/password tools (protect-pdf / unlock-pdf) are qpdf-based and
// have their own loader (qpdf.ts) — their semantics are intentionally separate.
//
// This is NOT a ConversionDescriptor — it must NOT be exported from
// engine/index.ts.

import { ConversionError } from "../types";

// The slice of pdf-lib's `PDFDocument` this helper calls: just the static
// `load`. Typed off pdf-lib's own shipped types via a type-only import (erased at
// build time → no runtime pdf-lib import here), so callers stay fully typed and
// the return type matches a direct `PDFDocument.load(...)` call.
type PdfLibPDFDocument = typeof import("pdf-lib")["PDFDocument"];

// Read `file` into bytes and parse it with the supplied (already lazy-loaded)
// pdf-lib `PDFDocument`. On any failure — a damaged, empty, or encrypted file —
// throws a ConversionError with code `DECODE_FAILED`, `recoverable: false`, and
// the raw error in `technical`, using the caller-supplied `message` verbatim so
// each tool keeps its own user-facing copy.
export async function loadPdfDocument(
  PDFDocument: PdfLibPDFDocument,
  file: File,
  message: string,
): Promise<Awaited<ReturnType<PdfLibPDFDocument["load"]>>> {
  try {
    return await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    throw new ConversionError(message, {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}
