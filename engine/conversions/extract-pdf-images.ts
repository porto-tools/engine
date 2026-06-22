// Extract Images from PDF. Unlike PDF→JPG/PNG (which RASTERISES whole pages),
// this tool pulls the EMBEDDED raster images out of a PDF and returns each as a
// standalone PNG. We never render the page; instead we read its operator list
// and resolve the image XObjects it references.
//
// How pdf.js exposes embedded images: `page.getOperatorList()` parses the page
// and, as a side effect, schedules every image XObject the page draws to be
// decoded into `page.objs` (page-local) or `page.commonObjs` (shared, ids that
// start with "g_"). We scan the returned op list for paint-image ops, collect
// the referenced object ids, then resolve each via the async callback form
// `objs.get(id, cb)` (or read it synchronously when `objs.has(id)` is already
// true). Each resolved image is either an ImageBitmap (`{ bitmap }`) or a raw
// pixel buffer `{ width, height, kind, data }` where ImageKind 1 = GRAYSCALE_1BPP
// (packed 1-bit), 2 = RGB_24BPP (3 bytes/px), 3 = RGBA_32BPP (4 bytes/px). We
// expand whichever form we get to an RGBA ImageData, paint it onto a canvas, and
// encode a PNG.
//
// DEDUPE by object id across pages: a logo repeated on every page resolves to
// the SAME id, so it yields exactly ONE output. Images we can't decode (unknown
// kind, JPXDecode/JPEG2000 that pdf.js leaves as a bitmap-less blob, image masks,
// or any per-image error) are SKIPPED, never fatal — one bad image must not sink
// the whole extraction. If a PDF yields no extractable images at all, we throw a
// RECOVERABLE UNSUPPORTED_INPUT so the UI nudges the user rather than crashing.
//
// pdf.js internals vary across versions, so every per-image step is wrapped in
// try/catch and the op-list shape is read defensively. pdf.js (`pdfjs-dist`) is
// multi-MB and lazy-loaded inside loadEngine via the shared loadPdfjs (it lands
// only in this route chunk). Reuses the exact guarded doc/page teardown from
// pdf-image.ts.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionOutput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
// Shared pdf.js loader + the structural doc/task types. We extend the page type
// locally below with the operator-list / objs surface this tool needs (the
// shared PdfPage only models the render path used by PDF→image).
import { loadPdfjs, type PdfDocument, type PdfLoadingTask } from "./pdfjs";

// ImageKind values pdf.js tags decoded raster buffers with. Mirrors pdfjs-dist's
// ImageKind enum; inlined so we don't depend on the runtime export.
const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

// Module-level singleton: the dynamically imported pdf.js module, set once by
// loadEngine and reused across conversions. Mirrors pdf-image.ts.
let pdfjs: Awaited<ReturnType<typeof loadPdfjs>> | null = null;

// ── Local structural types for the operator-list / objs surface ──────────────
//
// pdf.js's shipped .d.ts model these loosely; we encode only the slice we touch,
// kept permissive so a version drift can't turn a guarded read into a type error.

// A resolved image object, in either of the two shapes pdf.js produces.
interface PdfImageObject {
  width?: number;
  height?: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray | ArrayLike<number>;
  // JPXDecode / some image masks resolve as an ImageBitmap instead of raw bytes.
  bitmap?: ImageBitmap | CanvasImageSource;
}

// page.objs / page.commonObjs: the async resolver store. The callback form
// resolves once the worker has decoded the object; the sync form throws if the
// object isn't ready, so we always guard it behind has().
interface PdfObjects {
  get(objId: string, callback: (data: unknown) => void): unknown;
  get(objId: string): unknown;
  has(objId: string): boolean;
}

interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

// The page surface this tool uses, on top of the shared render path.
interface PdfImagePage {
  objs: PdfObjects;
  commonObjs: PdfObjects;
  getOperatorList(params?: Record<string, unknown>): Promise<PdfOperatorList>;
  cleanup?: () => void;
}

// pdf.js OPS codes for the paint-image operators (stable in pdfjs-dist 6.x).
// paintImageXObject / paintImageXObjectRepeat reference an image by OBJECT ID
// (args[0] is the id string) — these are the ones we can dedupe and extract.
// paintInlineImageXObject embeds the image inline (args[0] is the imgData object
// itself, no id), so it can't be deduped; we extract it too when the data is
// straightforward, keyed by a positional id so repeats within a run still dedupe.
const OPS_PAINT_IMAGE_XOBJECT = 85;
const OPS_PAINT_INLINE_IMAGE_XOBJECT = 86;
const OPS_PAINT_IMAGE_XOBJECT_REPEAT = 88;

// Throw the canonical CANCELLED error if the caller aborted. `cleanup` releases
// any pdf.js resources in flight so an abort doesn't leak. Mirrors pdf-image.ts.
function throwIfAborted(signal: AbortSignal | undefined, cleanup?: () => void): void {
  if (signal?.aborted) {
    cleanup?.();
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Reject the wrong format up front (non-recoverable: a different file is needed).
function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// loadEngine runs once before the first conversion (the labelled setup moment).
// Delegates to the shared loadPdfjs (single dynamic import + worker wiring).
async function loadEngine(): Promise<void> {
  if (pdfjs) return;
  pdfjs = await loadPdfjs();
}

// Promisified canvas.toBlob for PNG. A null blob (encoder refused) is treated as
// a per-image failure by the caller (it catches + skips), so we reject here.
function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null for image/png."));
    }, "image/png");
  });
}

// Resolve an image object id against the page's object stores. Ids starting with
// "g_" live in commonObjs (shared across pages); the rest are page-local. We try
// the SYNCHRONOUS read first when the store says it's ready (has()), and fall
// back to the async callback form otherwise. getOperatorList has already
// scheduled decoding, so the callback resolves promptly; we still race a timeout
// so a never-arriving object can't hang the whole run.
function resolveImageObject(page: PdfImagePage, objId: string): Promise<PdfImageObject | null> {
  const store: PdfObjects = objId.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise<PdfImageObject | null>((resolve) => {
    try {
      if (store.has(objId)) {
        resolve((store.get(objId) as PdfImageObject) ?? null);
        return;
      }
    } catch {
      // has()/sync get() can throw on a not-yet-resolved object; fall through to
      // the async form below.
    }
    let settled = false;
    const done = (value: PdfImageObject | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Safety net: if the object never resolves (a malformed reference), don't
    // hang — give up on this one image after a short wait.
    const timer = setTimeout(() => done(null), 5000);
    try {
      store.get(objId, (data: unknown) => {
        clearTimeout(timer);
        done((data as PdfImageObject) ?? null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

// Convert a resolved pdf.js image object into an RGBA ImageData of width×height.
// Handles the three raw ImageKind layouts; returns null for anything we can't
// decode (unknown kind, wrong-sized buffer, missing data) so the caller skips it.
function toRgbaImageData(img: PdfImageObject): ImageData | null {
  const width = img.width ?? 0;
  const height = img.height ?? 0;
  if (!(width > 0) || !(height > 0)) return null;
  const src = img.data;
  if (!src) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);

  if (img.kind === IMAGE_KIND_RGBA_32BPP) {
    // Already RGBA — copy straight across (guard against a short buffer).
    if (src.length < width * height * 4) return null;
    for (let i = 0; i < rgba.length; i++) rgba[i] = src[i] as number;
  } else if (img.kind === IMAGE_KIND_RGB_24BPP) {
    // RGB → RGBA, alpha forced opaque.
    if (src.length < width * height * 3) return null;
    let s = 0;
    let d = 0;
    for (let p = 0; p < width * height; p++) {
      rgba[d++] = src[s++] as number;
      rgba[d++] = src[s++] as number;
      rgba[d++] = src[s++] as number;
      rgba[d++] = 255;
    }
  } else if (img.kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    // Packed 1-bit, MSB-first, row stride ceil(width/8) bytes. A SET bit is
    // white (matches pdf.js's putBinaryImageData), a clear bit is black.
    const rowBytes = (width + 7) >> 3;
    if (src.length < rowBytes * height) return null;
    let d = 0;
    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const byte = src[rowStart + (x >> 3)] as number;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        rgba[d++] = v;
        rgba[d++] = v;
        rgba[d++] = v;
        rgba[d++] = 255;
      }
    }
  } else {
    // Unknown / unsupported kind.
    return null;
  }

  return new ImageData(rgba, width, height);
}

// Paint a resolved image object onto a canvas and encode it as a PNG blob.
// Returns null if the image can't be decoded or encoded — never throws, so a
// single bad image degrades gracefully. Handles BOTH the raw-buffer form and the
// ImageBitmap form pdf.js may hand back (e.g. for some JPEG/JPX-decoded images).
async function imageObjectToPngBlob(img: PdfImageObject): Promise<Blob | null> {
  try {
    let width = img.width ?? 0;
    let height = img.height ?? 0;
    const canvas = document.createElement("canvas");

    if (img.bitmap) {
      // ImageBitmap / drawable source path: size from the bitmap when present.
      const bmp = img.bitmap as { width?: number; height?: number };
      if (bmp.width && bmp.height) {
        width = bmp.width;
        height = bmp.height;
      }
      if (!(width > 0) || !(height > 0)) return null;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      try {
        ctx.drawImage(img.bitmap as CanvasImageSource, 0, 0, width, height);
      } catch {
        return null;
      }
    } else {
      const imageData = toRgbaImageData(img);
      if (!imageData) return null;
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.putImageData(imageData, 0, 0);
    }

    return await encodePng(canvas);
  } catch {
    return null;
  }
}

// Walk a page's operator list and collect the OBJECT IDS of the image XObjects it
// paints (paintImageXObject / paintImageXObjectRepeat). Inline images carry their
// data inline rather than by id; we collect those imgData objects separately so
// they can still be extracted. Defensive against op-list shape drift.
function collectPageImages(opList: PdfOperatorList): {
  ids: string[];
  inline: PdfImageObject[];
} {
  const ids: string[] = [];
  const inline: PdfImageObject[] = [];
  const fnArray = Array.isArray(opList?.fnArray) ? opList.fnArray : [];
  const argsArray = Array.isArray(opList?.argsArray) ? opList.argsArray : [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | undefined;
    try {
      if (fn === OPS_PAINT_IMAGE_XOBJECT || fn === OPS_PAINT_IMAGE_XOBJECT_REPEAT) {
        const objId = Array.isArray(args) ? args[0] : undefined;
        if (typeof objId === "string" && objId.length > 0) ids.push(objId);
      } else if (fn === OPS_PAINT_INLINE_IMAGE_XOBJECT) {
        // Inline image: args[0] is the imgData object itself.
        const data = Array.isArray(args) ? args[0] : undefined;
        if (data && typeof data === "object") inline.push(data as PdfImageObject);
      }
    } catch {
      // Skip a malformed op entry.
    }
  }

  return { ids, inline };
}

async function convertExtractPdfImages(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  if (!pdfjs) {
    // loadEngine should have run first (the UI calls it); guard defensively.
    await loadEngine();
  }
  const lib = pdfjs!;

  onProgress?.({ stage: "Reading PDF" });
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Keep the loading TASK so teardown has a version-safe handle to fall back to.
  const task: PdfLoadingTask = lib.getDocument({ data });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new ConversionError("We couldn't read this PDF — the file may be damaged or empty.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const numPages = doc.numPages;
    if (numPages < 1) {
      throw new ConversionError("This PDF has no pages to read.", {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: "pdf.js reported numPages < 1.",
      });
    }

    const base = replaceExtension(file.name, "").replace(/\.$/, "");
    const outputs: ConversionOutput[] = [];
    // DEDUPE across pages: the same image object id (a repeated logo) is
    // extracted ONCE. Inline images get a synthetic key from their dimensions +
    // a running counter so identical-looking repeats also collapse where cheap.
    const seen = new Set<string>();

    for (let n = 1; n <= numPages; n++) {
      // Respect cancellation between pages.
      throwIfAborted(signal);
      onProgress?.({ stage: `Scanning page ${n}`, ratio: (n - 1) / numPages });

      // pdf.js page surface. getPage returns a PDFPageProxy; we read it through
      // our local image-page type (objs / commonObjs / getOperatorList).
      const page = (await doc.getPage(n)) as unknown as PdfImagePage;
      try {
        let opList: PdfOperatorList;
        try {
          // Populates page.objs / page.commonObjs as a side effect.
          opList = await page.getOperatorList();
        } catch {
          // A page we can't parse for images is skipped, not fatal.
          continue;
        }

        const { ids, inline } = collectPageImages(opList);

        // XObject images, resolved by id and deduped across the whole document.
        for (const objId of ids) {
          throwIfAborted(signal);
          if (seen.has(objId)) continue;
          seen.add(objId);
          try {
            const img = await resolveImageObject(page, objId);
            if (!img) continue;
            const blob = await imageObjectToPngBlob(img);
            if (!blob) continue;
            const index = outputs.length + 1;
            outputs.push({
              blob,
              filename: `${base}-image-${index}.png`,
              mimeType: "image/png",
              size: blob.size,
            });
          } catch {
            // One bad image must never sink the run.
          }
        }

        // Inline images (no object id). Keyed positionally so a repeat within the
        // same run doesn't duplicate; best-effort.
        for (const img of inline) {
          throwIfAborted(signal);
          const key = `inline:${img.width ?? 0}x${img.height ?? 0}:${img.kind ?? "?"}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const blob = await imageObjectToPngBlob(img);
            if (!blob) continue;
            const index = outputs.length + 1;
            outputs.push({
              blob,
              filename: `${base}-image-${index}.png`,
              mimeType: "image/png",
              size: blob.size,
            });
          } catch {
            // Skip.
          }
        }
      } finally {
        // Release this page's pdf.js resources before the next. Guarded: a
        // narrowed build may not expose page-level cleanup.
        try {
          if (typeof page.cleanup === "function") page.cleanup();
        } catch {
          /* best-effort */
        }
      }
    }

    if (outputs.length < 1) {
      // Nothing extractable: a recoverable nudge (some PDFs are pure vector text,
      // or use encodings we skip) rather than a crash on outputs[0] below.
      throw new ConversionError("No extractable images were found in this PDF.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: `Scanned ${numPages} page(s); found no decodable raster image XObjects.`,
      });
    }

    onProgress?.({ stage: "Done", ratio: 1 });

    const outputSize = outputs.reduce((sum, o) => sum + o.size, 0);
    const first = outputs[0];
    return {
      blob: first.blob,
      filename: first.filename,
      mimeType: "image/png",
      inputSize: file.size,
      outputSize,
      outputs,
    };
  } finally {
    // Guarded doc + worker teardown on every exit path — identical pattern to
    // pdf-image.ts (the version we ship may expose only one of cleanup/destroy).
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

export const extractPdfImagesDescriptor: ConversionDescriptor = {
  id: "extract-pdf-images",
  fromLabel: "PDF",
  toLabel: "Images",
  accept: ["application/pdf"],
  newExtension: "png",
  outputMode: "multi",
  loadEngine,
  // pdf.js (pdfjs-dist) is the multi-MB one-time download shown in the setup
  // state while loadEngine runs.
  setupSizeLabel: "≈ 5 MB",
  convert: convertExtractPdfImages,
};
