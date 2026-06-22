// Rotate PDF Pages — rotate selected pages of a PDF by a quarter turn.
//
// The tool is parameterized with two controls:
//   - angle (select): the rotation to APPLY, in degrees clockwise. The UI's
//     rotate tool accumulates ±90° quick-turns into this value, so it can arrive
//     as 0 (a no-op), 90, 180, 270, or an un-normalised multiple of 90 such as
//     -90 or 360. readAngle folds any of those into [0, 360).
//   - pages (page-range): which pages to rotate (empty = all pages)
//
// The rotation is additive: it accumulates onto whatever rotation the page
// already carries, so rotating a page that is already 90° by 90° more yields
// 180°. Rotations are normalised to [0, 360) before saving.
//
// HARD pdf-lib CONSTRAINT: PDFPage.setRotation throws unless the angle is a
// multiple of 90. Both the value we apply AND the page's existing rotation are
// therefore snapped to the nearest quarter turn before they are combined, so a
// document carrying a malformed/odd rotation can never make setRotation throw.
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

// Snap any angle to a non-negative multiple of 90 in [0, 360). Rounds to the
// nearest quarter turn first (defensive: a page in the wild may carry a
// non-multiple rotation, which pdf-lib's setRotation would reject), then wraps
// negatives and full turns. NaN / non-finite → 0. Examples: -90 → 270,
// 360 → 0, 450 → 90, 47 → 90, NaN → 0.
function normalizeQuarter(value: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value / 90) * 90;
  const wrapped = ((snapped % 360) + 360) % 360;
  return wrapped as 0 | 90 | 180 | 270;
}

// Read the angle option defensively. Accepts the SelectControl strings ("0",
// "90", "180", "270") and any numeric multiple of 90 the rotate tool's
// accumulating buttons may produce. Anything unparseable falls back to 0 (a
// no-op), so a missing option never rotates unexpectedly.
function readAngle(value: unknown): 0 | 90 | 180 | 270 {
  return normalizeQuarter(Number(value));
}

async function convertRotatePdfPages(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }

  // Lazy-load pdf-lib so it stays in the /rotate-pdf-pages route chunk only.
  const { PDFDocument, degrees } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  const doc = await loadPdfDocument(PDFDocument, file, "We couldn't read this PDF — the file may be damaged.");

  throwIfAborted(signal);

  const angle = readAngle(options?.angle);
  const pageCount = doc.getPageCount();

  // Parse the page-range control value. Empty string = all pages (allowAll).
  const pagesStr = typeof options?.pages === "string" ? options.pages : "";
  const pageNumbers = parsePageRange(pagesStr, pageCount); // 1-based

  onProgress?.({ stage: "Rotating" });

  // A zero angle is a genuine no-op: every selected page keeps its rotation
  // (still snapped below, so an odd existing rotation is healed). Iterating is
  // cheap and keeps the saved output consistent.
  for (const pageNum of pageNumbers) {
    throwIfAborted(signal);
    const page = doc.getPage(pageNum - 1); // getPage is 0-based
    // Snap the EXISTING rotation too: combining two quarter turns stays a
    // quarter turn, so setRotation (which rejects non-multiples of 90) is safe.
    const current = normalizeQuarter(page.getRotation().angle);
    page.setRotation(degrees(normalizeQuarter(current + angle)));
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const saved = await doc.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  // Build an output filename that reflects the operation.
  const dot = file.name.lastIndexOf(".");
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;

  return {
    blob,
    filename: `${base}-rotated.pdf`,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const rotatePdfPagesDescriptor: ConversionDescriptor = {
  id: "rotate-pdf-pages",
  fromLabel: "PDF",
  toLabel: "Rotated",
  accept: ["application/pdf"],
  newExtension: "pdf",
  defaultOptions: { angle: "90", pages: "" },
  controls: [
    {
      type: "select",
      id: "angle",
      label: "Rotation",
      help: "Degrees clockwise to rotate the selected pages.",
      default: "90",
      options: [
        { value: "90", label: "90° clockwise" },
        { value: "180", label: "180°" },
        { value: "270", label: "270° clockwise (90° counter-clockwise)" },
      ],
    },
    {
      type: "page-range",
      id: "pages",
      label: "Pages",
      help: "Which pages to rotate. Leave blank to rotate all pages.",
      default: "",
      allowAll: true,
    },
  ],
  convert: convertRotatePdfPages,
};
