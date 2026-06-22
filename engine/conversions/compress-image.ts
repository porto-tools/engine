// Compress Image — lossy quality/size reduction via Canvas toBlob.
//
// Input: JPEG, PNG, or WebP. Output format (default path):
//   JPEG in → JPEG out (re-encoded at user quality)
//   PNG in  → WebP out (lossy WebP is better ratio than lossy PNG)
//   WebP in → WebP out (re-encoded at user quality)
//
// No WASM, no loadEngine — runs on browser Canvas APIs only by default.
//
// Two modes:
//   "quality" (default) — the quality control is a range [10–100] mapping to
//     canvas.toBlob quality [0.1–1.0] (quality/100). Lower = smaller file, more
//     visible artefacts. Encodes ONCE.
//   "target" — binary-search the toBlob quality in [0.1, 1.0] to find the
//     LARGEST quality whose encoded blob is <= targetKb*1024 bytes. Best effort:
//     if even quality 0.1 overshoots, the 0.1 result is returned (no error).
//
// The compress runs on createImageBitmap → drawImage → canvas.toBlob — the
// same pipeline as image-resize. The quality option is read defensively and
// clamped to [10, 100] before use.
//
// Three optional capability groups extend the default path (all off by default,
// so the default behaviour is byte-identical to before):
//   A3 — PNG colour-quantization: PNG in + pngQuantize → a palette PNG of at
//        most pngColors colours, encoded with @pdf-lib/upng (pure JS, lazy).
//   A2 — grayscale: pure-Canvas Rec.601 desaturation applied to every output
//        format before encoding.
//   A2 — progressive / 4:4:4 chroma: JPEG-only flags Canvas can't express; for
//        these the MozJPEG encoder (@jsquash/jpeg, lazy wasm) is engaged instead
//        of toBlob. Otherwise the instant-start toBlob path is used.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { buildMozjpegOptions, encodeJpegMozjpeg } from "./mozjpeg";
import { applyDpiToBlob, clampDpi } from "./dpi-patch";
import { RASTER_IMAGE_ACCEPT as ACCEPT, RASTER_MIME_TO_EXTENSION as MIME_TO_EXTENSION } from "./mime";

const DEFAULT_QUALITY = 80;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

const DEFAULT_MODE = "quality";
const DEFAULT_TARGET_KB = 200;
const MIN_TARGET_KB = 10;
const MAX_TARGET_KB = 20000;

// A3 palette-size bounds (UPNG colour count).
const DEFAULT_COLORS = 256;
const MIN_COLORS = 2;
const MAX_COLORS = 256;

// A2 chroma subsampling default (matches the canvas/MozJPEG common default).
const DEFAULT_CHROMA = "4:2:0";

// Binary-search bounds (canvas.toBlob quality is a 0..1 float) and iteration
// count. 7 iterations narrow [0.1, 1.0] to a window of ~0.007 — fine enough.
const SEARCH_MIN_QUALITY = 0.1;
const SEARCH_MAX_QUALITY = 1.0;
const SEARCH_ITERATIONS = 7;

// Accepted input types (ACCEPT) and the MIME→extension map (MIME_TO_EXTENSION)
// are shared via ./mime, imported above.

// Output MIME for each input type (PNG → WebP for best lossy compression ratio)
const INPUT_TO_OUTPUT_MIME: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/webp",
  "image/webp": "image/webp",
};

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a JPG, PNG, or WebP image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

function clampQuality(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(n)));
}

function clampTargetKb(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TARGET_KB;
  return Math.min(MAX_TARGET_KB, Math.max(MIN_TARGET_KB, Math.round(n)));
}

// Clamp the palette colour count to an integer in [2, 256]; garbage → 256.
function clampColours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_COLORS;
  return Math.min(MAX_COLORS, Math.max(MIN_COLORS, Math.round(n)));
}

// Read the mode defensively — only the two known values are honoured, anything
// else falls back to "quality" so the default path is never accidentally lost.
function readMode(value: unknown): "quality" | "target" {
  return value === "target" ? "target" : DEFAULT_MODE;
}

// Read a boolean flag defensively — only a literal `true` enables it, anything
// else (undefined, "false", 0, garbage) falls back to off.
function readBool(value: unknown): boolean {
  return value === true;
}

// Allow-list the chroma choice — only the two known values are honoured,
// anything else falls back to the 4:2:0 default.
function readChroma(value: unknown): "4:2:0" | "4:4:4" {
  return value === "4:4:4" ? "4:4:4" : DEFAULT_CHROMA;
}

// Decode the file to a bitmap. `autoOrient` controls whether an EXIF orientation
// tag is honoured: "from-image" rotates/flips the pixels to upright (the consumer
// default), "none" keeps the stored pixel orientation (the historical behaviour).
async function decode(file: File, autoOrient: boolean): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, {
      imageOrientation: autoOrient ? "from-image" : "none",
    });
  } catch (err) {
    throw new ConversionError("We couldn't read this image — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

// Low-level encode: `qualityFraction` is the raw canvas.toBlob quality in [0, 1].
function encodeAtFraction(
  canvas: HTMLCanvasElement,
  mimeType: string,
  qualityFraction: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else
          reject(
            new ConversionError("We couldn't finish encoding this image.", {
              code: "ENCODE_FAILED",
              recoverable: true,
              technical: `canvas.toBlob returned null for ${mimeType}.`,
            }),
          );
      },
      mimeType,
      qualityFraction,
    );
  });
}

// Desaturate the canvas in place via Rec.601 luma. Done on the pixel buffer (not
// ctx.filter, which is inconsistent across engines) so the result is identical
// everywhere. Applies to ALL output formats before encoding.
function applyGrayscale(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = y;
  }
  ctx.putImageData(imageData, 0, 0);
}

// A3: encode the canvas as a palette PNG via @pdf-lib/upng (pure JS, dynamically
// imported so it lands only in this route's chunk, never the shared entry).
async function encodePalettePng(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  colours: number,
): Promise<Blob> {
  const upngModule = await import("@pdf-lib/upng");
  // Quirk: this package default-exports the UPNG object at runtime, but its .d.ts
  // declares NAMED exports (and models no `default`). Normalise across both interop
  // shapes; cast through `unknown` because the shipped types don't model the default.
  const UPNG =
    (upngModule as unknown as { default?: typeof upngModule }).default ?? upngModule;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out: ArrayBuffer = UPNG.encode([imageData.data.buffer], canvas.width, canvas.height, colours);
  return new Blob([out], { type: "image/png" });
}

// Binary-search the quality in [0.1, 1.0] for the LARGEST quality whose encoded
// blob is <= targetBytes. Best effort: returns the smallest-quality (0.1) result
// when nothing fits. Encoder-agnostic — `encodeAt(fraction)` dispatches to the
// Canvas or MozJPEG encoder per iteration. Respects abort between iterations.
async function searchToTarget(
  encodeAt: (qualityFraction: number) => Promise<Blob>,
  targetBytes: number,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  let lo = SEARCH_MIN_QUALITY;
  let hi = SEARCH_MAX_QUALITY;

  // Lower bound (0.1) is the best-effort fallback when even it overshoots.
  let bestUnderTarget: Blob | null = null;
  const floorBlob = await encodeAt(lo);
  if (floorBlob.size <= targetBytes) bestUnderTarget = floorBlob;
  let fallback = floorBlob;

  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    throwIfAborted(signal);
    const mid = (lo + hi) / 2;
    const blob = await encodeAt(mid);
    if (blob.size <= targetBytes) {
      // Fits — remember it and try for higher quality (a larger file).
      bestUnderTarget = blob;
      lo = mid;
    } else {
      // Overshoots — keep it only as a fallback and search lower quality.
      fallback = blob;
      hi = mid;
    }
  }

  return bestUnderTarget ?? fallback;
}

async function convertCompressImage(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const mode = readMode(options?.mode);
  const quality = clampQuality(options?.quality);
  const targetKb = clampTargetKb(options?.targetKb);
  const grayscale = readBool(options?.grayscale);
  const progressive = readBool(options?.progressive);
  const chroma = readChroma(options?.chroma);
  const pngQuantize = readBool(options?.pngQuantize);
  const pngColors = clampColours(options?.pngColors);
  // autoOrient defaults to TRUE (upright phone photos is the correct consumer
  // default). Read defensively: only a literal `false` disables it.
  const autoOrient = options?.autoOrient !== false;
  // dpi 0 = leave the resolution unchanged (byte-identical default).
  const dpi = clampDpi(options?.dpi);

  // A3: a PNG input with pngQuantize on overrides the default PNG → WebP mapping
  // and keeps a PNG output. For every other case the existing mapping stands.
  const usePalettePng = file.type === "image/png" && pngQuantize;
  const outputMime = usePalettePng ? "image/png" : INPUT_TO_OUTPUT_MIME[file.type] ?? "image/webp";
  const extension = MIME_TO_EXTENSION[outputMime] ?? "webp";

  // A2: progressive / 4:4:4 are JPEG-only and Canvas can't express them, so a
  // JPEG output with either flag routes through MozJPEG instead of toBlob. The
  // common case (default flags) stays on the instant-start Canvas path.
  const useMozjpeg = outputMime === "image/jpeg" && (progressive || chroma === "4:4:4");

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file, autoOrient);
  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Compressing" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  throwIfAborted(signal);

  // A2 grayscale: desaturate on-canvas before encoding, for every output format.
  if (grayscale) applyGrayscale(ctx, canvas);
  throwIfAborted(signal);

  onProgress?.({ stage: "Encoding" });

  // Per-quality encode step. In MozJPEG mode the 0–100 quality is rounded to an
  // integer (its scale); in Canvas mode it's the raw 0..1 toBlob fraction.
  const encodeAt = useMozjpeg
    ? (qualityFraction: number) =>
        encodeJpegMozjpeg(
          ctx.getImageData(0, 0, canvas.width, canvas.height),
          buildMozjpegOptions(Math.round(qualityFraction * 100), { progressive, chroma, grayscale }),
          signal,
        )
    : (qualityFraction: number) => encodeAtFraction(canvas, outputMime, qualityFraction);

  let blob: Blob;
  if (usePalettePng) {
    // A3: palette PNG is independent of quality/target mode — it always produces
    // a PNG reduced to `pngColors` colours.
    blob = await encodePalettePng(ctx, canvas, pngColors);
  } else if (mode === "target") {
    blob = await searchToTarget(encodeAt, targetKb * 1024, signal);
  } else {
    blob = await encodeAt(quality / 100);
  }
  throwIfAborted(signal);

  // Stamp the requested DPI into the container (JPEG→JFIF — including the MozJPEG
  // progressive output — and PNG→pHYs; WebP unchanged). dpi 0 returns the blob
  // untouched, so the default path is byte-identical to before.
  blob = await applyDpiToBlob(blob, outputMime, dpi);

  return {
    blob,
    filename: replaceExtension(file.name, extension),
    mimeType: outputMime,
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const compressImageDescriptor: ConversionDescriptor = {
  id: "compress-image",
  fromLabel: "Image",
  toLabel: "Compressed",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "webp",
  // Many files at once, each with its own quality, converted independently.
  inputMode: "multi-compress",
  defaultOptions: {
    mode: DEFAULT_MODE,
    quality: DEFAULT_QUALITY,
    targetKb: DEFAULT_TARGET_KB,
    grayscale: false,
    progressive: false,
    chroma: DEFAULT_CHROMA,
    pngQuantize: false,
    pngColors: DEFAULT_COLORS,
    // Auto-orient ON by default (upright phone photos); DPI 0 = unchanged.
    autoOrient: true,
    dpi: 0,
  },
  controls: [
    {
      type: "select",
      id: "mode",
      label: "Compress by",
      help: "“Quality” encodes once at the quality you pick. “Target file size” searches for the best quality that fits under your size budget.",
      default: DEFAULT_MODE,
      options: [
        { value: "quality", label: "Quality" },
        { value: "target", label: "Target file size" },
      ],
    },
    {
      type: "range",
      id: "quality",
      label: "Quality",
      help: "Lower quality means a smaller file with more visible artefacts. Higher quality keeps more detail at the cost of size.",
      default: DEFAULT_QUALITY,
      min: MIN_QUALITY,
      max: MAX_QUALITY,
      step: 1,
      unit: "%",
    },
    {
      type: "number",
      id: "targetKb",
      label: "Target file size",
      help: "Used only in “Target file size” mode. We search for the highest quality whose file stays at or under this size.",
      default: DEFAULT_TARGET_KB,
      min: MIN_TARGET_KB,
      max: MAX_TARGET_KB,
      step: 10,
      unit: "KB",
    },
    {
      type: "checkbox",
      id: "grayscale",
      label: "Convert to grayscale",
      help: "Discards colour and keeps luminance only — a smaller file. Applies to every output format.",
      default: false,
    },
    {
      type: "checkbox",
      id: "progressive",
      label: "Progressive JPEG",
      help: "JPEG output only. Encodes so the image loads as a sharpening preview; usually a touch smaller at the same quality.",
      default: false,
    },
    {
      type: "select",
      id: "chroma",
      label: "Chroma subsampling",
      help: "JPEG output only. 4:2:0 halves colour resolution for a smaller file (typical); 4:4:4 keeps full colour.",
      default: "4:2:0",
      options: [
        { value: "4:2:0", label: "4:2:0 (smaller)" },
        { value: "4:4:4", label: "4:4:4 (full colour)" },
      ],
    },
    {
      type: "checkbox",
      id: "pngQuantize",
      label: "Reduce colours (palette)",
      help: "PNG output only. Converts a full-colour PNG to a palette of at most N colours — great for logos, icons, and flat graphics, not photos.",
      default: false,
    },
    {
      type: "number",
      id: "pngColors",
      label: "Max colours",
      help: "Palette size when “Reduce colours” is on (2–256). Fewer colours means a smaller file.",
      default: DEFAULT_COLORS,
      min: MIN_COLORS,
      max: MAX_COLORS,
      step: 1,
      unit: "colours",
    },
    {
      type: "checkbox",
      id: "autoOrient",
      label: "Auto-orient",
      help: "Rotate photos upright using the camera's orientation tag (EXIF). On by default — turn off to keep the stored pixel orientation.",
      default: true,
    },
    {
      type: "number",
      id: "dpi",
      label: "Print resolution (DPI)",
      help: "Stamp a print resolution into the output. Leave at 0 to keep the file unchanged. Applies to JPG and PNG only; WebP has no DPI field.",
      default: 0,
      min: 0,
      max: 1200,
      step: 1,
      unit: "DPI",
    },
  ],
  convert: convertCompressImage,
};
