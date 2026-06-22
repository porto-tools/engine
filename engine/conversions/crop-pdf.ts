// Crop PDF — trim the visible area of every page by a margin percentage on each
// side, via pdf-lib's crop box (pure JS, no WASM, no loadEngine). Cropping is
// non-destructive: content outside the box is hidden, not deleted, exactly as a
// PDF crop box is meant to work. Everything runs in the browser.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadPdfDocument } from "./pdf-lib-load";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

function readPct(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(45, Math.max(0, Math.round(n)));
}

// Which pages to crop. "all" (DEFAULT) crops every page exactly as before;
// "current" crops only the single page named by `currentPage`. Read defensively:
// anything other than the exact string "current" → "all", so the default path
// stays byte-identical to the original all-pages behavior.
function readPageScope(value: unknown): "all" | "current" {
  return value === "current" ? "current" : "all";
}

// The 1-based page index to crop when scope is "current". Defaults to 1 and is
// clamped into range by the caller against the actual page count.
function readCurrentPage(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Inset a page box (origin x/y, size w/h, pdf-lib bottom-left coords) by margin
// PERCENTAGES on each side. Guards against a degenerate (<=1pt) result by backing
// off symmetric insets. Pure + exported for unit testing.
export function cropRect(x: number, y: number, w: number, h: number, m: CropMargins): CropRect {
  const left = (w * m.left) / 100;
  const right = (w * m.right) / 100;
  const top = (h * m.top) / 100;
  const bottom = (h * m.bottom) / 100;

  const width = w - left - right;
  const height = h - top - bottom;
  // Never produce a zero/negative box; fall back to the full box on over-crop.
  if (!(width > 1)) {
    return { x, y, width: w, height: h };
  }
  if (!(height > 1)) {
    return { x, y, width: w, height: h };
  }
  return { x: x + left, y: y + bottom, width, height };
}

async function convertCropPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const margins: CropMargins = {
    top: readPct(options?.marginTop),
    right: readPct(options?.marginRight),
    bottom: readPct(options?.marginBottom),
    left: readPct(options?.marginLeft),
  };

  // Page scope: "all" (default) crops every page; "current" crops only the page
  // named by currentPage (1-based). targetIndex is 0-based for the loop check.
  const pageScope = readPageScope(options?.pageScope);
  const targetIndex = readCurrentPage(options?.currentPage) - 1;

  const { PDFDocument } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Cropping page ${i + 1}`, ratio: i / pages.length });

    // When scope is "current", crop only the single target page; otherwise crop
    // every page exactly as before. (Default scope="all" path is unchanged.)
    if (pageScope === "current" && i !== targetIndex) continue;

    const page = pages[i];
    // Crop relative to the current media box (its origin may be non-zero).
    const box = page.getMediaBox();
    const r = cropRect(box.x, box.y, box.width, box.height, margins);
    page.setCropBox(r.x, r.y, r.width, r.height);
  }

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving", ratio: 1 });

  const saved = await doc.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const cropPdfDescriptor: ConversionDescriptor = {
  id: "crop-pdf",
  fromLabel: "PDF",
  toLabel: "Cropped PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  defaultOptions: { marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 },
  controls: [
    {
      type: "range",
      id: "marginTop",
      label: "Crop top",
      default: 0,
      min: 0,
      max: 45,
      step: 1,
      unit: "%",
    },
    {
      type: "range",
      id: "marginRight",
      label: "Crop right",
      default: 0,
      min: 0,
      max: 45,
      step: 1,
      unit: "%",
    },
    {
      type: "range",
      id: "marginBottom",
      label: "Crop bottom",
      default: 0,
      min: 0,
      max: 45,
      step: 1,
      unit: "%",
    },
    {
      type: "range",
      id: "marginLeft",
      label: "Crop left",
      help: "Each slider trims that percentage off the matching edge of every page.",
      default: 0,
      min: 0,
      max: 45,
      step: 1,
      unit: "%",
    },
  ],
  convert: convertCropPdf,
};
