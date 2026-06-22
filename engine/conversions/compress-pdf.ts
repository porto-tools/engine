// Compress PDF — the REAL, lossy size reducer.
//
// The existing /pdf-compress tool is honest-basic: it only re-packs the PDF's
// object structure losslessly (useObjectStreams), which barely touches image-
// heavy files. THIS tool actually shrinks photo/scan-heavy PDFs by re-encoding
// their embedded images lossily at a chosen quality level.
//
// It runs entirely in the browser. There is no `loadEngine` setup gate: pdf-lib
// is pure JS (lazy-imported below), and the only heavy dependency — pdf.js
// (`pdfjs-dist`, used solely for the rasterize fallback) — is dynamically
// imported INSIDE convert so it lands in this route chunk and is fetched only if
// the fallback is actually reached, never up front.
//
// ── Two real reduction paths, by honesty ─────────────────────────────────────
//
// PATH A — in-place JPEG re-encode (the primary, text-preserving method):
//   Enumerate the document's image XObjects via pdf-lib's low-level context.
//   For each EMBEDDED JPEG (a /DCTDecode image stream — the format that carries
//   the overwhelming majority of weight in photo and scanned PDFs), the stream
//   bytes ARE a JPEG file: we decode them on a Canvas, optionally downscale past
//   the level's pixel cap, and re-encode at the level's lower quality. If (and
//   only if) the result is smaller, we swap the stream in place with
//   `context.assign`, so every page's resource reference stays valid and all
//   text / vectors are reproduced EXACTLY. We then save with object streams for
//   the structural win on top. Nothing is rasterized; selectable text survives.
//
//   Limit (honest): non-JPEG image streams (FlateDecode rasters, indexed
//   palettes, CMYK/exotic colorspaces, 1-bit CCITT/JBIG2 scans), and JPEGs the
//   browser can't cleanly decode (some CMYK/Adobe-marker ones), are LEFT
//   UNTOUCHED rather than risk corrupting them — reconstructing those safely in
//   the browser without extra dependencies isn't reliable. A PDF whose weight is
//   entirely in such images therefore sees little or no Path-A reduction, which
//   is exactly when Path B steps in.
//
// PATH B — page rasterize (the fallback, with a real tradeoff):
//   When Path A cannot meaningfully shrink the file (no re-encodable images, or
//   the result is essentially the same size), the only remaining real reduction
//   is to render each page to a raster with pdf.js at the level's DPI and
//   rebuild a PDF of those compressed page-images. This DOES shrink a stubborn
//   image-heavy scan — but it FLATTENS the page: selectable text and vector
//   sharpness become a picture. That tradeoff is real, so Path B is used only
//   as a last resort, and the page copy states it plainly.
//
// We always return the SMALLER of the input and whichever path produced bytes,
// and never claim a reduction we didn't achieve — if nothing helped, the output
// equals the (object-stream-optimised) input and the before/after is shown as-is.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
// Shared pdf.js loader + structural types for Path B's rasterize fallback (one
// coalesced dynamic import + worker setup; the single `pdfjs-dist` cast lives in
// that helper). See pdfjs.ts.
import { loadPdfjs, type PdfDocument } from "./pdfjs";

// ── Level policy (pure, unit-tested) ─────────────────────────────────────────
//
// Each level maps to three numbers: the JPEG quality for re-encoded images, the
// pixel cap on an image's long edge (downscale anything bigger — most file
// weight is in oversized embedded photos), and the DPI used by the rasterize
// fallback. "Balanced" is the default: a visible reduction with quality most
// people won't notice on screen.

export type CompressLevel = "smaller" | "balanced" | "better";

export interface LevelSettings {
  /** JPEG quality (0..1) for re-encoded embedded images. */
  quality: number;
  /** Downscale an image whose longest edge exceeds this many pixels. */
  maxImageEdge: number;
  /** DPI for the rasterize fallback (Path B). */
  rasterDpi: number;
}

const LEVELS: Record<CompressLevel, LevelSettings> = {
  // Smallest file: aggressive quality + a tight pixel cap. Visible softening on
  // close inspection, but big savings on photo-heavy documents.
  smaller: { quality: 0.5, maxImageEdge: 1000, rasterDpi: 96 },
  // The sensible default: a clear reduction that looks clean on screen.
  balanced: { quality: 0.72, maxImageEdge: 1600, rasterDpi: 120 },
  // Gentlest: prioritise fidelity, take a smaller (but still real) reduction.
  better: { quality: 0.85, maxImageEdge: 2200, rasterDpi: 150 },
};

const DEFAULT_LEVEL: CompressLevel = "balanced";

// Resolve the `level` option defensively — the UI seeds it, but options arrive
// untyped and must never be trusted. Anything unrecognised falls to "balanced".
export function resolveLevel(value: unknown): CompressLevel {
  if (value === "smaller" || value === "balanced" || value === "better") return value;
  return DEFAULT_LEVEL;
}

export function settingsForLevel(level: CompressLevel): LevelSettings {
  return LEVELS[level];
}

// Decide whether Path A "meaningfully" shrank the file. We require at least a
// 3% reduction to count it a win worth keeping without falling through to the
// rasterize path; below that the in-place re-encode effectively did nothing
// (e.g. all images were unsupported formats) and rasterizing is the only real
// lever left. Pure so it's unit-testable.
const MEANINGFUL_RATIO = 0.97;
export function isMeaningfulReduction(inputSize: number, outputSize: number): boolean {
  if (!(inputSize > 0)) return false;
  return outputSize <= inputSize * MEANINGFUL_RATIO;
}

// Given a source image's pixel size and the level's edge cap, compute the draw
// size: scale down so the longest edge meets the cap, never scale up. Pure.
export function fitWithinEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > 0) || !(maxEdge > 0) || longest <= maxEdge) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ── Lossless structural repack (opt-in qpdf final pass) ──────────────────────
//
// An opt-in toggle that, after the lossy compression above, runs qpdf over the
// result with two PURELY LOSSLESS structural optimizations:
//   --object-streams=generate  pack indirect objects into compressed object
//                              streams (shrinks per-object overhead)
//   --linearize                rewrite the file "web-optimized" (also normalises
//                              and drops dead/unreferenced structure)
// Neither touches image quality, text, or vectors — they only re-pack the PDF's
// container, so a file is byte-for-byte equivalent in content. The toggle is OFF
// by default: when off we never load or run qpdf, and the output is byte-identical
// to today. (DEFER: a "convert to grayscale" option is NOT here — qpdf has no
// colourspace conversion; true grayscale needs lossy rasterization or per-image
// colorspace rewriting, a separate product decision. See the report.)

// Read the toggle defensively: options arrive untyped, so only an explicit
// boolean `true` opts in. Anything else (missing, false, a truthy string) leaves
// the repack OFF, preserving today's default. Pure → unit-testable.
export function wantsLosslessRepack(options: ConversionInput["options"]): boolean {
  return options?.losslessRepack === true;
}

// The exact qpdf argv for the lossless structural pass: the two optimization
// flags, then qpdf's positional in/out file pair. Pure so the argv is locked by a
// unit test independent of the wasm engine.
export function buildRepackArgs(inPath: string, outPath: string): string[] {
  return ["--object-streams=generate", "--linearize", inPath, outPath];
}

// ── Engine guards ────────────────────────────────────────────────────────────

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

// Promisified canvas.toBlob → bytes. A null blob (encoder refused) is a
// transient memory pinch; callers treat a failure as "skip this image" rather
// than aborting the whole compression.
function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          () => resolve(null),
        );
      },
      "image/jpeg",
      quality,
    );
  });
}

// Decode arbitrary image bytes (a complete JPEG/PNG file) to an ImageBitmap.
// Returns null on any failure so the caller can simply skip that image and
// leave the original untouched — never corrupt a stream we couldn't read.
async function tryDecode(bytes: Uint8Array, mime: string): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    // Copy into a fresh ArrayBuffer-backed Blob (some bytes are subarray views).
    const blob = new Blob([bytes.slice()], { type: mime });
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

// Re-encode one decoded bitmap as a JPEG at the level's quality, downscaling to
// the edge cap. Returns the new JPEG bytes plus the (possibly reduced) pixel
// size, or null if the browser couldn't draw/encode. The bitmap is always
// closed. White-fills the canvas first so any transparency flattens to white
// (JPEG has no alpha) instead of going black.
async function reencodeBitmap(
  bitmap: ImageBitmap,
  settings: LevelSettings,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    const { width, height } = fitWithinEdge(bitmap.width, bitmap.height, settings.maxImageEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const bytes = await canvasToJpegBytes(canvas, settings.quality);
    if (!bytes) return null;
    return { bytes, width, height };
  } finally {
    bitmap.close();
  }
}

// ── pdf-lib low-level types (minimal, local) ─────────────────────────────────
// Only the slice of pdf-lib we use, declared structurally so we don't depend on
// importing the concrete classes as values where a shape suffices.

interface PdfNameLike {
  toString(): string;
}
interface PdfDictLike {
  get(key: unknown): unknown;
}
interface PdfRawStreamLike {
  dict: PdfDictLike;
  contents: Uint8Array;
}

// ── Path A: in-place image XObject re-encode ─────────────────────────────────
//
// Returns the re-encoded PDF bytes. When no JPEG was re-encodable the bytes are
// just the object-stream-optimised original (≈ same size), which the caller
// detects and answers with the rasterize fallback.

async function compressImagesInPlace(
  arrayBuffer: ArrayBuffer,
  settings: LevelSettings,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<Uint8Array> {
  const pdfLib = await import("pdf-lib");
  const { PDFDocument, PDFName, PDFRawStream } = pdfLib;
  throwIfAborted(signal);

  let doc;
  try {
    doc = await PDFDocument.load(arrayBuffer);
  } catch (err) {
    throw new ConversionError("We couldn't read this PDF — the file may be damaged or encrypted.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
  throwIfAborted(signal);

  const ctx = doc.context;

  // Collect every image XObject up front so we can report progress over them.
  const imageEntries: { ref: unknown; stream: PdfRawStreamLike }[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const dict = obj.dict as unknown as PdfDictLike;
      const subtype = dict.get(PDFName.of("Subtype")) as PdfNameLike | undefined;
      if (subtype && subtype.toString() === "/Image") {
        imageEntries.push({ ref, stream: obj as unknown as PdfRawStreamLike });
      }
    }
  }

  for (let i = 0; i < imageEntries.length; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: "Re-encoding images", ratio: imageEntries.length ? i / imageEntries.length : 0 });

    const { ref, stream } = imageEntries[i];
    const dict = stream.dict;

    const filter = dict.get(PDFName.of("Filter")) as PdfNameLike | undefined;
    const filterName = filter ? filter.toString() : "";
    const smask = dict.get(PDFName.of("SMask"));
    const mask = dict.get(PDFName.of("Mask"));
    // Transparency can't survive a JPEG round-trip — skip masked images to avoid
    // turning their alpha into a white halo.
    if (smask || mask) continue;

    // A Decode array remaps sample values (e.g. an inverted image); the browser
    // decode won't apply it, so re-encoding would change the look. Skip to stay
    // faithful.
    if (dict.get(PDFName.of("Decode"))) continue;

    // Only re-encode embedded JPEGs: the stream contents are then a complete
    // JPEG file the browser can decode directly, with no raw-sample
    // reconstruction (which would need a deflate dependency we don't carry).
    // Everything else is left untouched here and handled by the rasterize
    // fallback when it dominates the file — see the file header.
    if (filterName !== "/DCTDecode") continue;

    // CMYK/Adobe-marker JPEGs that the browser mis-decodes simply fail → skipped.
    const bitmap = await tryDecode(stream.contents, "image/jpeg");
    if (!bitmap) continue;
    throwIfAborted(signal);

    const reencoded = await reencodeBitmap(bitmap, settings);
    if (!reencoded) continue;

    // Only swap if we actually saved bytes on THIS image; never grow a stream.
    if (reencoded.bytes.length >= stream.contents.length) continue;

    const newStream = ctx.stream(reencoded.bytes, {
      Type: "XObject",
      Subtype: "Image",
      Width: reencoded.width,
      Height: reencoded.height,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "DCTDecode",
    });
    ctx.assign(ref as Parameters<typeof ctx.assign>[0], newStream);
  }

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving" });
  // Object streams give a lossless structural win on top of the image savings.
  return doc.save({ useObjectStreams: true });
}

// ── Path B: rasterize each page via pdf.js, rebuild a PDF of page-images ──────
//
// The text-flattening fallback. Renders every page at the level's DPI and packs
// the JPEGs into a fresh PDF (one image per page, sized to the page). Used only
// when Path A couldn't meaningfully shrink the file. The pdf.js structural types
// (PdfDocument, …) and loader live in ./pdfjs.

async function rasterizePages(
  arrayBuffer: ArrayBuffer,
  settings: LevelSettings,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  let pdfjs;
  try {
    // Shared loader: one coalesced dynamic import + worker setup. A failure
    // (e.g. non-browser environment) makes the fallback unavailable → caller
    // keeps Path A's result, exactly as before.
    pdfjs = await loadPdfjs();
  } catch {
    return null; // fallback unavailable → caller keeps Path A's result
  }

  const pdfLib = await import("pdf-lib");
  const { PDFDocument } = pdfLib;

  const data = new Uint8Array(arrayBuffer.slice(0));
  let doc: PdfDocument;
  try {
    doc = await pdfjs.getDocument({ data }).promise;
  } catch {
    return null;
  }

  // pdf.js renders at 72 user-units/inch at scale 1; scale to the target DPI.
  const scale = settings.rasterDpi / 72;
  try {
    const out = await PDFDocument.create();
    const numPages = doc.numPages;
    if (numPages < 1) return null;

    for (let n = 1; n <= numPages; n++) {
      throwIfAborted(signal);
      onProgress?.({ stage: `Rasterizing page ${n} of ${numPages}`, ratio: (n - 1) / numPages });

      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const pageCtx = canvas.getContext("2d");
        if (!pageCtx) return null;
        pageCtx.fillStyle = "#ffffff";
        pageCtx.fillRect(0, 0, width, height);
        await page.render({ canvasContext: pageCtx, viewport }).promise;
        throwIfAborted(signal);

        const jpegBytes = await canvasToJpegBytes(canvas, settings.quality);
        if (!jpegBytes) return null;

        const img = await out.embedJpg(jpegBytes);
        // Page in PDF points = pixels / (dpi/72) so the printed size is unchanged.
        const ptW = width / scale;
        const ptH = height / scale;
        const pdfPage = out.addPage([ptW, ptH]);
        pdfPage.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });
      } finally {
        // Release this page's pdf.js resources. Guarded: a narrowed build may
        // not expose page-level cleanup (the shared PdfPage types it optional).
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }

    onProgress?.({ stage: "Saving" });
    return await out.save({ useObjectStreams: true });
  } finally {
    // Tear down the document + worker transport. Guarded for the same
    // version-mismatch reason: PDFDocumentProxy may not expose `destroy()`.
    if (typeof doc.destroy === "function") await doc.destroy();
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function convertCompressPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const level = resolveLevel(options?.level);
  const settings = settingsForLevel(level);

  onProgress?.({ stage: "Reading" });
  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);

  // PATH A — in-place JPEG re-encode. Re-read the buffer per path since pdf.js
  // detaches/consumes the array; keep the original ArrayBuffer intact by slicing.
  const pathABytes = await compressImagesInPlace(arrayBuffer.slice(0), settings, signal, onProgress);
  throwIfAborted(signal);

  let best = pathABytes;

  // PATH B — rasterize fallback, only if Path A didn't meaningfully help. This
  // flattens text to an image, so it is a genuine last resort.
  if (!isMeaningfulReduction(file.size, pathABytes.length)) {
    const rasterized = await rasterizePages(arrayBuffer.slice(0), settings, signal, onProgress).catch(
      () => null,
    );
    throwIfAborted(signal);
    if (rasterized && rasterized.length < best.length) {
      best = rasterized;
    }
  }

  // Never hand back something larger than we received: if every path grew the
  // file (rare, already-optimised inputs), return the original bytes so the
  // before/after is honest and the user is never penalised for compressing.
  if (best.length >= file.size) {
    best = new Uint8Array(arrayBuffer);
  }

  // OPT-IN LOSSLESS REPACK — final structural pass. Only when the user toggled it
  // on: we never load or run qpdf otherwise, so the default output is byte-
  // identical to today. We import ./qpdf dynamically here (not at module top) so
  // the qpdf engine stays code-split and is fetched only when this branch runs.
  if (wantsLosslessRepack(options)) {
    onProgress?.({ stage: "Optimizing structure" });
    const { runQpdf } = await import("./qpdf");
    // Feed qpdf the COMPRESSED bytes, not the original, so the repack stacks on
    // top of the lossy reduction.
    const compressedFile = new File([new Uint8Array(best)], file.name, {
      type: "application/pdf",
    });
    const { data, exitCode } = await runQpdf(compressedFile, buildRepackArgs, signal);
    throwIfAborted(signal);
    // Keep the repacked bytes only if qpdf succeeded and didn't grow the file —
    // linearization can add a little overhead on already-tiny PDFs, and a failed
    // run yields empty output; in either case we keep the pre-repack bytes so the
    // result is never corrupted or larger than before.
    if (exitCode === 0 && data.length > 0 && data.length <= best.length) {
      best = data;
    }
  }

  const blob = new Blob([new Uint8Array(best)], { type: "application/pdf" });
  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const compressPdfDescriptor: ConversionDescriptor = {
  id: "compress-pdf",
  fromLabel: "PDF",
  toLabel: "PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  // Many files at once, each with its own level, converted independently.
  inputMode: "multi-compress",
  defaultOptions: { level: DEFAULT_LEVEL, losslessRepack: false },
  controls: [
    {
      type: "select",
      id: "level",
      label: "Compression level",
      help: "Smaller squeezes hardest; Better keeps the most quality. All re-encode embedded images in your browser.",
      default: DEFAULT_LEVEL,
      options: [
        { value: "smaller", label: "Smaller file" },
        { value: "balanced", label: "Balanced" },
        { value: "better", label: "Better quality" },
      ],
    },
    {
      // Opt-in, default OFF: a purely lossless structural pass (qpdf object-stream
      // packing + linearization) layered on top of the lossy result. Off ⇒ qpdf is
      // never loaded and the output is byte-identical to today.
      type: "checkbox",
      id: "losslessRepack",
      label: "Lossless structural repack",
      help: "Optional: also pack and linearize the PDF's structure (lossless). Trims container overhead without touching image quality.",
      default: false,
    },
  ],
  convert: convertCompressPdf,
};
