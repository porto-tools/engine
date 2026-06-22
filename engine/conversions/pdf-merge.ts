// PDF Merge — combine several PDFs into one ordered document. The merge runs
// entirely in Node/browser via pdf-lib (no WASM, pure JS); no `loadEngine` is
// needed. The descriptor declares `inputMode: "multi"` so the shared
// ConversionTool stages files before converting, rather than auto-converting
// each drop immediately. `toLabel: "Merge"` drives the staging button copy.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { loadPdfjs, type PdfLoadingTask } from "./pdfjs";

// ── Staging helpers (pure; used by the /pdf-merge UI) ─────────────────────────
//
// These are part of the merge tool's contract but touch no native resources and
// no DOM, so they live here next to the descriptor and are unit-tested directly.
// They do NOT change the merge output — the UI calls sortFilesByName to reorder
// the STAGED list before handing it to convert(); convert() itself is untouched.

// Compare two filenames the way a person scanning a folder would: case-folded so
// "Apple.pdf" and "apple.pdf" don't split, and with embedded numbers compared as
// numbers ("file2" before "file10") rather than lexically ("file10" before
// "file2"). Built on Intl.Collator with numeric collation, which is exactly this
// behaviour and is available in every environment we ship to (browser + Node).
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base", // case- and accent-insensitive ordering
});

// Return a NEW array of the given files sorted ascending by filename (A→Z),
// case-insensitively and with numbers-in-names compared numerically. The sort is
// STABLE: files whose names compare equal keep their original relative order, so
// re-sorting an already-sorted list is a no-op and same-named files don't jump.
// The input array is never mutated. This is the one-shot "Sort A→Z" action — the
// user can still manually reorder afterwards.
export function sortFilesByName<T extends { name: string }>(files: readonly T[]): T[] {
  // Decorate with the original index so ties resolve to original order even on
  // engines whose Array.prototype.sort isn't guaranteed stable. (Modern V8 is
  // stable, but the decorate-sort-undecorate keeps this correct everywhere and
  // makes the stability contract explicit.)
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const byName = nameCollator.compare(a.file.name, b.file.name);
      return byName !== 0 ? byName : a.index - b.index;
    })
    .map((entry) => entry.file);
}

// The longest edge (px) a cover thumbnail is rendered at, and the hard pixel cap
// either axis may reach. Small on purpose: a staging-row preview, not a page
// render. Kept here so the pure sizing math below is testable without a DOM.
const THUMBNAIL_LONG_EDGE = 96;
const THUMBNAIL_MAX_DIMENSION = 160;

// Pure size math for a cover thumbnail, extracted so it's unit-testable without a
// canvas. Given a page's natural (scale-1) size in points, choose a render scale
// that lands the long edge near THUMBNAIL_LONG_EDGE, clamped so neither axis
// exceeds THUMBNAIL_MAX_DIMENSION, and never UPSCALES a page that is already
// smaller than the target (scale capped at 1). Returns the scale plus the integer
// canvas size. Mirrors computePageScale in pdf-image.ts but at thumbnail scale.
export function thumbnailDimensions(
  naturalWidth: number,
  naturalHeight: number,
): { scale: number; width: number; height: number } {
  // Degenerate/garbage viewport → a tiny but valid 1×1 canvas at 1:1.
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { scale: 1, width: 1, height: 1 };
  }
  const longest = Math.max(naturalWidth, naturalHeight);
  let scale = THUMBNAIL_LONG_EDGE / longest;
  // Don't upscale a page that's already smaller than the target thumbnail.
  if (scale > 1) scale = 1;
  // Never let either axis exceed the cap (binds on the longer axis).
  const cappedScale = THUMBNAIL_MAX_DIMENSION / longest;
  if (scale > cappedScale) scale = cappedScale;

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  return { scale, width, height };
}

// Render page 1 of a PDF file to a small cover-thumbnail Blob (PNG), for the
// staging-row preview. Lazy: pdf.js is loaded on demand via the shared loadPdfjs
// loader (same dynamic import the other PDF tools use, so it code-splits into the
// route chunk). Best-effort by design — every failure path returns null so the
// caller falls back to a generic PDF badge and the merge is NEVER blocked. The
// returned Blob is owned by the caller, which makes/revokes its object URL.
//
// This is NOT a ConversionDescriptor and is deliberately not part of the merge
// output path: convert() above is untouched and stays byte-identical.
export async function renderCoverThumbnail(file: File): Promise<Blob | null> {
  // Canvas is required; bail cleanly in a non-DOM environment (SSR/tests).
  if (typeof document === "undefined") return null;

  let task: PdfLoadingTask | null = null;
  try {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    task = lib.getDocument({ data });
    const doc = await task.promise;
    if (doc.numPages < 1) return null;

    const page = await doc.getPage(1);
    try {
      const natural = page.getViewport({ scale: 1 });
      const { scale, width, height } = thumbnailDimensions(natural.width, natural.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // PDF pages may be transparent; a white fill keeps the thumbnail readable.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    } finally {
      // Release this page's pdf.js resources; guarded for narrowed builds.
      if (typeof page.cleanup === "function") page.cleanup();
    }
  } catch {
    // Any failure (load, decode, render, encode) → fall back to the badge.
    return null;
  } finally {
    // Tear down the document/worker transport so a staged-then-removed file
    // doesn't leak a worker. Guarded + swallowed: teardown must never throw past
    // a best-effort thumbnail.
    try {
      if (typeof task?.destroy === "function") await task.destroy();
    } catch {
      /* ignore teardown failures */
    }
  }
}

// cleanup param omitted: PDF merge holds no native resources to release on abort.
// Throw the canonical CANCELLED error if the caller aborted. Called between
// each file merge step so a mid-flight abort is picked up promptly.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

async function convertPdfMerge(input: ConversionInput): Promise<ConversionResult> {
  const { files, signal, onProgress } = input;

  throwIfAborted(signal);

  // `files` is the staged list; `file` is files[0]. Guard: need ≥ 2.
  const allFiles = files ?? [input.file];

  if (allFiles.length < 2) {
    throw new ConversionError("Select at least two PDF files to merge.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Got ${allFiles.length} file(s); merge requires at least 2.`,
    });
  }

  // Validate every file is a PDF before doing any work.
  for (const f of allFiles) {
    if (f.type !== "application/pdf") {
      throw new ConversionError("This doesn't look like a PDF file.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Expected application/pdf, received "${f.type || "unknown type"}" for "${f.name}".`,
      });
    }
  }

  // Lazy-load pdf-lib inside convert so it lands only in the route chunk.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Merging", ratio: 0 });

  const out = await PDFDocument.create();
  const inputSize = allFiles.reduce((sum, f) => sum + f.size, 0);

  for (let i = 0; i < allFiles.length; i++) {
    throwIfAborted(signal);

    const f = allFiles[i];
    let bytes: ArrayBuffer;
    try {
      bytes = await f.arrayBuffer();
    } catch (err) {
      throw new ConversionError(`We couldn't read "${f.name}" — the file may be damaged.`, {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      });
    }

    throwIfAborted(signal);

    try {
      const src = await PDFDocument.load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } catch (err) {
      if (err instanceof ConversionError) throw err;
      throw new ConversionError(`"${f.name}" could not be parsed as a PDF — the file may be corrupt.`, {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      });
    }

    onProgress?.({ stage: "Merging", ratio: (i + 1) / allFiles.length });
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const merged = await out.save();
  // Copy into a fresh Uint8Array so the underlying buffer is a plain ArrayBuffer
  // (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob requires ArrayBuffer).
  const blob = new Blob([new Uint8Array(merged)], { type: "application/pdf" });

  return {
    blob,
    filename: "merged.pdf",
    mimeType: "application/pdf",
    inputSize,
    outputSize: blob.size,
  };
}

export const pdfMergeDescriptor: ConversionDescriptor = {
  id: "pdf-merge",
  fromLabel: "PDF",
  toLabel: "Merge",
  accept: ["application/pdf"],
  newExtension: "pdf",
  inputMode: "multi",
  convert: convertPdfMerge,
};
