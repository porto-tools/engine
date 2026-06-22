// PDF → JPG and PDF → PNG. A PDF is a vector/page document, not a raster the
// browser can hand us directly, so we render each page with pdf.js (the same
// engine Firefox uses for its built-in PDF viewer) onto a Canvas, then encode
// that canvas to JPEG or PNG. This is a MANY-OUT conversion: one image per page.
// The page list becomes `result.outputs[]`, which the shared MultiResultCard
// renders as per-file downloads plus a "Download all (.zip)".
//
// PAGE SELECTION: by default EVERY page is rendered. An optional `pages` option
// (a human page-range string like "1-3,5,8-10", emitted by the UI's
// PdfPageSelector) narrows it so ONLY those pages render to images — the rest
// are never rasterised. An empty/absent option means all pages (parsePageRange's
// "" → 1..N). Output filenames keep the ORIGINAL 1-based page number, so a
// selection of pages 5 and 9 yields "<name>-page-5" and "<name>-page-9".
//
// pdf.js (`pdfjs-dist`) is multi-MB, so it is lazy-loaded inside `loadEngine`
// via a dynamic import — it lands in these two route chunks only, never the
// homepage/shared entry (verified by /check-bundle). The shared ConversionTool
// renders the labelled one-time setup state while `loadEngine` runs and keeps
// the dropzone disabled; return visits hit the browser cache and skip it.
//
// Worker: pdf.js offloads parsing to a Web Worker. We point GlobalWorkerOptions
// at the worker file shipped inside pdfjs-dist and let the bundler resolve +
// emit it via `new URL(..., import.meta.url)` — no shared-config change, no
// public/ asset copy. See loadEngine.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionOutput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { parsePageRange } from "../page-range";
// Shared pdf.js loader + structural types (one coalesced dynamic import + worker
// setup; the single `pdfjs-dist` cast lives in that helper). See pdfjs.ts for
// why we keep our own structural types over pdfjs-dist's shipped `.d.ts`.
import { loadPdfjs, type PdfjsModule, type PdfDocument } from "./pdfjs";

// pdf.js renders at PDF "user-space" units (72 per inch) at scale 1. We scale so
// the page's LONG edge lands near this target — sharp enough to read, small
// enough to keep canvases and output files reasonable. A 595×842 pt A4 page at
// these settings renders ~1684 px tall.
const TARGET_LONG_EDGE = 1684;
// Hard cap on either rendered dimension. A poster-sized PDF page could otherwise
// demand a canvas of tens of millions of pixels per side and exhaust memory; cap
// the scale so neither axis exceeds this, preserving aspect ratio.
const MAX_DIMENSION = 4000;
// Default JPEG quality as a PERCENT (10–100), mapped to canvas.toBlob's 0–1
// scale as quality/100. 92% keeps compression artefacts invisible at normal
// viewing while still shrinking the raster substantially versus PNG.
const DEFAULT_JPEG_QUALITY_PCT = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;
// Optional resolution (DPI). PDF user-space is 72 DPI at scale 1, so the render
// scale for an explicit DPI is dpi/72 (still clamped by MAX_DIMENSION). When no
// dpi is given we keep the long-edge "fit to screen" default (computePageScale).
const MIN_DPI = 36;
const MAX_DPI = 600;

// Module-level singleton: the dynamically imported pdf.js module. Set once by
// loadEngine (via the shared loadPdfjs) and reused across conversions so the
// worker/setup cost is paid once. The structural types (PdfjsModule,
// PdfDocument, …) live in ./pdfjs.
let pdfjs: PdfjsModule | null = null;

// Throw the canonical CANCELLED error if the caller aborted. Called at each
// async boundary AND between pages (a multi-page PDF should stop promptly mid
// run). `cleanup` releases any pdf.js resources already in flight so an abort
// doesn't leak native/worker memory. Mirrors the pattern in png-jpg.ts.
function throwIfAborted(signal: AbortSignal | undefined, cleanup?: () => void): void {
  if (signal?.aborted) {
    cleanup?.();
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Reject the wrong format up front with a non-recoverable error — retrying the
// same file can't help; the user needs a different file. We require the exact
// PDF MIME type (the browser reports it reliably for .pdf files).
function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// Pure size math, extracted so it's unit-testable without a DOM. Given a page's
// natural (scale-1) size in points, choose a render scale that lands the long
// edge near TARGET_LONG_EDGE, then clamp so neither dimension exceeds
// MAX_DIMENSION. Returns the scale plus the resulting integer canvas size.
export function computePageScale(
  naturalWidth: number,
  naturalHeight: number,
): { scale: number; width: number; height: number } {
  // Degenerate/garbage viewport → render at 1:1 to a tiny but valid canvas.
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { scale: 1, width: 1, height: 1 };
  }
  const longest = Math.max(naturalWidth, naturalHeight);
  let scale = TARGET_LONG_EDGE / longest;
  // Never let either axis exceed the cap. The binding axis is the longer one.
  const cappedScale = MAX_DIMENSION / longest;
  if (scale > cappedScale) scale = cappedScale;

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  return { scale, width, height };
}

// DPI-driven variant: render scale is exactly dpi/72 (1pt = 1/72 inch), clamped
// so neither axis exceeds MAX_DIMENSION. Used when the user picks an explicit
// resolution; otherwise computePageScale's screen-fit default applies.
export function computePageScaleAtDpi(
  naturalWidth: number,
  naturalHeight: number,
  dpi: number,
): { scale: number; width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { scale: 1, width: 1, height: 1 };
  }
  let scale = dpi / 72;
  const longest = Math.max(naturalWidth, naturalHeight);
  const cappedScale = MAX_DIMENSION / longest;
  if (scale > cappedScale) scale = cappedScale;
  if (!(scale > 0)) scale = 1;

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  return { scale, width, height };
}

// Read the optional `dpi` option, clamped to [36, 600]. Missing/non-positive →
// null, meaning "use the screen-fit default" (computePageScale).
function readDpi(options: Record<string, unknown> | undefined): number | null {
  const raw = options?.dpi;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(n)));
}

// Read the optional JPEG `quality` option (percent), clamped to [10, 100].
// Missing/non-numeric → the default.
function clampJpegQuality(options: Record<string, unknown> | undefined): number {
  const raw = options?.quality;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_JPEG_QUALITY_PCT;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(n)));
}

// Promisified canvas.toBlob. A null blob (encoder refused) is recoverable —
// usually a transient memory pinch — so the UI offers a retry. Mirrors png-jpg.
function encode(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else
          reject(
            new ConversionError("We couldn't finish encoding a page.", {
              code: "ENCODE_FAILED",
              recoverable: true,
              technical: `canvas.toBlob returned null for ${mimeType}.`,
            }),
          );
      },
      mimeType,
      quality,
    );
  });
}

// loadEngine runs once before the first conversion (the labelled one-time setup
// moment). It delegates to the shared loadPdfjs, which dynamically imports pdf.js
// so the multi-MB library lands only in these route chunks and wires up the
// worker (both done exactly once). Idempotent: a second call is a no-op once
// `pdfjs` is set, and loadPdfjs itself coalesces concurrent loads.
async function loadEngine(): Promise<void> {
  if (pdfjs) return;
  pdfjs = await loadPdfjs();
}

// Read the optional `pages` option — a human page-range string ("1-3,5,8-10")
// the UI's page selector emits — into a sorted, de-duped, in-bounds list of
// 1-based page numbers. An ABSENT or empty option means "every page" (the
// default-converts-all contract), which parsePageRange already returns for "".
// A non-string is treated as absent. The returned list is what we actually
// render, so only the chosen pages ever touch a canvas.
function selectedPages(options: Record<string, unknown> | undefined, numPages: number): number[] {
  const raw = options?.pages;
  const str = typeof raw === "string" ? raw : "";
  return parsePageRange(str, numPages);
}

// Shared renderer for both directions. Renders the SELECTED pages (all by
// default) each to its own raster and returns a ConversionOutput per rendered
// page. `mimeType`/`quality`/`newExtension` pick the codec. Releases pdf.js page
// + document handles in `finally` on every exit path, and checks the abort
// signal between pages.
async function convertPdfToImages(
  input: ConversionInput,
  mimeType: "image/jpeg" | "image/png",
  newExtension: "jpg" | "png",
  quality: number | undefined,
): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  if (!pdfjs) {
    // loadEngine should have run first (the UI calls it); guard defensively so a
    // direct caller gets a clear, recoverable error rather than a crash.
    await loadEngine();
  }
  const lib = pdfjs!;

  onProgress?.({ stage: "Reading PDF" });
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Keep the loading TASK, not just its document, so teardown has a version-safe
  // handle to fall back to (its destroy() tears down the worker transport).
  const task = lib.getDocument({ data });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    // A parse failure means the bytes are damaged, empty, or not really a PDF —
    // not recoverable by retry.
    throw new ConversionError("We couldn't read this PDF — the file may be damaged or empty.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const numPages = doc.numPages;
    if (numPages < 1) {
      throw new ConversionError("This PDF has no pages to convert.", {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: "pdf.js reported numPages < 1.",
      });
    }

    // Which pages to render: the selection (all by default). If a selection was
    // passed but resolves to nothing in range (e.g. a stale range against a
    // shorter document), there's nothing to convert — a recoverable nudge to
    // pick valid pages rather than a crash on outputs[0] below.
    const pages = selectedPages(options, numPages);
    if (pages.length < 1) {
      throw new ConversionError("No pages selected to convert.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Page selection "${String(options?.pages ?? "")}" matched no pages in a ${numPages}-page document.`,
      });
    }

    const base = replaceExtension(file.name, "").replace(/\.$/, "");
    const outputs: ConversionOutput[] = [];
    const total = pages.length;
    // Resolution is constant for the run: an explicit DPI, or null = screen-fit.
    const dpi = readDpi(options);

    for (let i = 0; i < total; i++) {
      const n = pages[i];
      throwIfAborted(signal);
      onProgress?.({ stage: `Rendering page ${n}`, ratio: i / total });

      const page = await doc.getPage(n);
      try {
        const natural = page.getViewport({ scale: 1 });
        const { scale, width, height } =
          dpi === null
            ? computePageScale(natural.width, natural.height)
            : computePageScaleAtDpi(natural.width, natural.height, dpi);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new ConversionError("Your browser couldn't open a drawing canvas.", {
            code: "CANVAS_UNAVAILABLE",
            recoverable: false,
            technical: "HTMLCanvasElement.getContext('2d') returned null.",
          });
        }
        // PDF pages can be transparent; for JPG (no alpha) a white fill prevents
        // transparent regions rendering as black. Harmless for PNG too, but we
        // only fill for JPG to keep PNG output faithful to the source.
        if (mimeType === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
        }

        await page.render({ canvasContext: ctx, viewport }).promise;
        throwIfAborted(signal);

        const blob = await encode(canvas, mimeType, quality);
        outputs.push({
          blob,
          filename: `${base}-page-${n}.${newExtension}`,
          mimeType,
          size: blob.size,
        });
      } finally {
        // Release this page's pdf.js resources before moving to the next.
        // Guarded: a narrowed build may not expose page-level cleanup.
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }

    onProgress?.({ stage: "Done", ratio: 1 });

    const outputSize = outputs.reduce((sum, o) => sum + o.size, 0);
    // The representative single fields point at the first page so existing
    // single-output consumers still see a valid result; `outputs` drives the
    // many-out UI.
    const first = outputs[0];
    return {
      blob: first.blob,
      filename: first.filename,
      mimeType,
      inputSize: file.size,
      outputSize,
      outputs,
    };
  } finally {
    // Tear down the document + worker transport on every exit path, using
    // whichever pdf.js cleanup API this version actually exposes. The previous
    // code called `doc.destroy()` unconditionally, but the PDFDocumentProxy in
    // the version we ship has no `destroy` method — that bare call threw
    // "TypeError: doc.destroy is not a function" and aborted every conversion.
    // We now release page resources via `doc.cleanup()` when present, then tear
    // down the worker via `doc.destroy()` OR the loading task's `destroy()`,
    // each guarded by a typeof check and wrapped so a teardown hiccup never
    // masks the real result/error. Mirrors the guarded teardown in
    // hooks/usePdfThumbnails.
    try {
      if (typeof doc.cleanup === "function") doc.cleanup();
    } catch {
      /* best-effort */
    }
    try {
      if (typeof doc.destroy === "function") await doc.destroy();
      else if (typeof task.destroy === "function") await task.destroy();
    } catch {
      /* best-effort */
    }
  }
}

async function convertPdfToJpg(input: ConversionInput): Promise<ConversionResult> {
  // quality is a percent option (default 92%); canvas.toBlob wants 0–1.
  return convertPdfToImages(input, "image/jpeg", "jpg", clampJpegQuality(input.options) / 100);
}

async function convertPdfToPng(input: ConversionInput): Promise<ConversionResult> {
  return convertPdfToImages(input, "image/png", "png", undefined);
}

export const pdfToJpgDescriptor: ConversionDescriptor = {
  id: "pdf-to-jpg",
  fromLabel: "PDF",
  toLabel: "JPG",
  accept: ["application/pdf"],
  newExtension: "jpg",
  outputMode: "multi",
  loadEngine,
  // pdf.js (pdfjs-dist) is the multi-MB one-time download shown in the setup
  // state while loadEngine runs.
  setupSizeLabel: "≈ 5 MB",
  convert: convertPdfToJpg,
};

export const pdfToPngDescriptor: ConversionDescriptor = {
  id: "pdf-to-png",
  fromLabel: "PDF",
  toLabel: "PNG",
  accept: ["application/pdf"],
  newExtension: "png",
  outputMode: "multi",
  loadEngine,
  // Same pdf.js engine as pdf-to-jpg → same one-time download.
  setupSizeLabel: "≈ 5 MB",
  convert: convertPdfToPng,
};

// reverse: OMITTED. There is no image→PDF route in this build, so there is no
// inverse tool to deep-link a wrongly-dropped file to.
// TODO(reverse): wire a `reverse` hint to /jpg-to-pdf (or /png-to-pdf) once an
// image→PDF conversion ships.
