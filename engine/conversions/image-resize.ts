// Image resize — the proof tool for the interactive-controls foundation. It is
// the first PARAMETERIZED conversion: instead of auto-running on drop, the UI
// stages the file, renders a dimensions control (width / height / lock aspect),
// and runs this `convert` on a Convert click with the control values passed as
// options.
//
// Like PNG↔JPG and SVG→PNG it runs on the browser's built-in Canvas — no WASM,
// so no `loadEngine`. By default (format "same") it re-encodes to the INPUT's
// own format (a resize, not a format change): JPG in → JPG out, PNG in → PNG
// out, WebP in → WebP out. An optional output-format choice (png/jpg/webp) plus
// a quality slider let the resize ALSO change format; "same" reproduces the
// original byte-for-byte behaviour and never touches quality.
//
// The dimensions control fans out to three flat option keys (see
// DimensionsControl in ../types): `sizeWidth`, `sizeHeight`, `sizeKeepAspect`.
// We read them defensively (clamping to [1, 16384]) because options arrive from
// the UI and must never be trusted to be in range.
//
// Item #14 adds two iLoveIMG-style options on top of the dimensions path, read
// just as defensively: a `resizeBy` mode ("dimensions" | "percentage") with a
// `percentage` slider (scales BOTH axes off the SOURCE size), and a `noEnlarge`
// guard that never lets the result exceed the source on either axis. With the
// defaults (resizeBy "dimensions", noEnlarge false) the output is unchanged.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { clampQuality } from "./numbers";
import { applyDpiToBlob, clampDpi } from "./dpi-patch";
import { RASTER_IMAGE_ACCEPT as ACCEPT, RASTER_MIME_TO_EXTENSION as MIME_TO_EXTENSION } from "./mime";

// Defaults used when an option is missing or unusable. They're placeholders —
// the UI always seeds real numbers from the control — but a defensive convert
// must still have something sane to fall back to.
const DEFAULT_DIMENSION = 1024;

// Hard pixel cap per axis. A canvas of 16384² is already ~1 GB of RGBA; going
// higher risks allocation failures across browsers. The UI clamps too, but the
// engine is the authority.
const MAX_DIMENSION = 16384;
const MIN_DIMENSION = 1;

// Quality control bounds (percent). Maps to canvas.toBlob quality [0.1–1.0] via
// quality/100, mirroring compress-image's convention. Only consulted for lossy
// outputs (jpg/webp); png ignores it.
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

// Resize-by mode. "dimensions" is today's behaviour exactly (the dimensions
// control drives the output); "percentage" scales both axes off the source size.
// Read defensively against this list — anything unknown falls back to dimensions.
const RESIZE_BY = ["dimensions", "percentage"] as const;
type ResizeBy = (typeof RESIZE_BY)[number];

// Percentage slider bounds (percent of the source, per axis). The discrete stops
// include the 25/50/75 quick steps iLoveIMG offers plus shrink/grow extremes.
const PERCENT_STOPS = [10, 25, 50, 75, 100, 150, 200] as const;
const DEFAULT_PERCENT = 100;
const MIN_PERCENT = PERCENT_STOPS[0]; // 10
const MAX_PERCENT = PERCENT_STOPS[PERCENT_STOPS.length - 1]; // 200

// Output-format choices. "same" keeps the input's format/extension exactly as
// before; the others force a specific encode. Read defensively against this list.
const FORMATS = ["same", "png", "jpg", "webp"] as const;
type Format = (typeof FORMATS)[number];

// The explicit format choices → their output MIME and extension.
const FORMAT_TO_MIME: Record<Exclude<Format, "same">, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
const FORMAT_TO_EXTENSION: Record<Exclude<Format, "same">, string> = {
  png: "png",
  jpg: "jpg",
  webp: "webp",
};

// MIME types we apply quality to. PNG is lossless, so quality is ignored there.
const LOSSY_MIMES = new Set(["image/jpeg", "image/webp"]);

// Accepted raster inputs and the extension each maps to are shared via ./mime
// (RASTER_IMAGE_ACCEPT / RASTER_MIME_TO_EXTENSION, imported above). WebP is
// included so the resize is lossless-of-format for the three common web rasters;
// JPEG re-encodes as .jpg.

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a JPG, PNG, or WebP image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
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

// Encode the canvas to a Blob. `quality` is undefined for the "same"-format path
// and for png, so canvas.toBlob is called with NO quality argument — preserving
// the original byte-for-byte default. For lossy formats it is a [0.1–1.0] number.
function encode(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const onBlob = (blob: Blob | null) => {
      if (blob) resolve(blob);
      else
        reject(
          new ConversionError("We couldn't finish encoding this image.", {
            code: "ENCODE_FAILED",
            recoverable: true,
            technical: `canvas.toBlob returned null for ${mimeType}.`,
          }),
        );
    };
    if (quality === undefined) canvas.toBlob(onBlob, mimeType);
    else canvas.toBlob(onBlob, mimeType, quality);
  });
}

// Read the output-format option defensively, validating against the allowed
// list. Anything unknown or missing falls back to "same" (preserve input format).
function readFormat(value: unknown): Format {
  return FORMATS.includes(value as Format) ? (value as Format) : "same";
}

// Read the resize-by mode defensively. Anything unknown or missing falls back to
// "dimensions" — today's behaviour — so a missing option reproduces the old path.
function readResizeBy(value: unknown): ResizeBy {
  return RESIZE_BY.includes(value as ResizeBy) ? (value as ResizeBy) : "dimensions";
}

// Clamp the percentage option into [MIN_PERCENT, MAX_PERCENT]. Non-numeric or
// missing values fall back to DEFAULT_PERCENT (100% = unchanged). Pure —
// unit-tested directly and via computeResizeDimensions.
export function clampPercent(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, n));
}

// Clamp a single option value to a usable integer dimension. Non-numeric,
// non-finite, or out-of-range values fall back into [MIN_DIMENSION,
// MAX_DIMENSION]; a missing value uses `fallback`. Pure — unit-tested.
function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(n)));
}

// Clamp a computed axis into the engine's hard [MIN_DIMENSION, MAX_DIMENSION]
// pixel range. Shared by both resize modes so the cap policy lives in one place.
function clampAxis(value: number): number {
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(value)));
}

// Compute the final draw size from the options, the source size, and the resize
// mode. Two modes:
//
//   "dimensions" (default) — today's behaviour exactly. With the aspect lock on
//   we CONTAIN-fit the requested box (the source scales to fit entirely inside
//   without distortion, long edge honoured, partner axis follows the ratio);
//   with the lock off the requested width/height are used verbatim (clamped).
//
//   "percentage" — scale BOTH axes off the SOURCE by `percentage`% (inherently
//   proportional). The dimensions box is ignored.
//
// A `noEnlarge` guard (off by default) then caps EACH output axis at the source
// size, so the result never exceeds the original on either axis. With the
// defaults (resizeBy "dimensions", noEnlarge false) this is byte-for-byte the
// old policy. Pure and DOM-free so the whole policy is unit-testable.
export function computeResizeDimensions(
  options: Record<string, unknown> | undefined,
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const resizeBy = readResizeBy(options?.resizeBy);
  const noEnlarge = options?.noEnlarge === true;

  let width: number;
  let height: number;

  if (resizeBy === "percentage") {
    // Scale both axes off the source by the clamped percentage.
    const factor = clampPercent(options?.percentage) / 100;
    const safeW = sourceWidth > 0 ? sourceWidth : DEFAULT_DIMENSION;
    const safeH = sourceHeight > 0 ? sourceHeight : DEFAULT_DIMENSION;
    width = clampAxis(safeW * factor);
    height = clampAxis(safeH * factor);
  } else {
    const reqW = clampDimension(options?.sizeWidth, DEFAULT_DIMENSION);
    const reqH = clampDimension(options?.sizeHeight, DEFAULT_DIMENSION);
    const keepAspect = options?.sizeKeepAspect !== false; // default true

    if (!keepAspect) {
      width = reqW;
      height = reqH;
    } else {
      // Contain-fit: pick the scale that fits the source inside the requested box.
      const safeW = sourceWidth > 0 ? sourceWidth : reqW;
      const safeH = sourceHeight > 0 ? sourceHeight : reqH;
      const scale = Math.min(reqW / safeW, reqH / safeH);
      width = clampAxis(safeW * scale);
      height = clampAxis(safeH * scale);
    }
  }

  // Do-not-enlarge: hold each axis at or below the source. Only meaningful when
  // the source size is known; a 0/unknown source leaves the value untouched.
  if (noEnlarge) {
    if (sourceWidth > 0) width = Math.min(width, sourceWidth);
    if (sourceHeight > 0) height = Math.min(height, sourceHeight);
  }

  return { width, height };
}

async function convertImageResize(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  // Resolve the output format. "same" reproduces today's behaviour exactly
  // (input format/extension, no quality); the explicit choices force a format.
  const format = readFormat(options?.format);
  let outputMime: string;
  let extension: string;
  if (format === "same") {
    outputMime = file.type === "image/jpg" ? "image/jpeg" : file.type;
    extension = MIME_TO_EXTENSION[outputMime] ?? "png";
  } else {
    outputMime = FORMAT_TO_MIME[format];
    extension = FORMAT_TO_EXTENSION[format];
  }

  // Quality applies ONLY when an explicit lossy format (jpg/webp) was chosen.
  // The "same" path must reproduce today's output byte-for-byte, so it always
  // passes undefined (no quality argument to toBlob), and png is lossless.
  const quality =
    format !== "same" && LOSSY_MIMES.has(outputMime)
      ? clampQuality(options?.quality) / 100
      : undefined;

  // autoOrient defaults to TRUE (upright phone photos is the correct consumer
  // default). Read defensively: only a literal `false` disables it.
  const autoOrient = options?.autoOrient !== false;
  // dpi 0 = leave the resolution unchanged (byte-identical default).
  const dpi = clampDpi(options?.dpi);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file, autoOrient);
  throwIfAborted(signal, () => bitmap.close());

  const { width, height } = computeResizeDimensions(options, bitmap.width, bitmap.height);

  onProgress?.({ stage: "Resizing" });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  // High-quality downscale where the browser supports it.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  throwIfAborted(signal);

  onProgress?.({ stage: "Encoding" });
  const encoded = await encode(canvas, outputMime, quality);
  throwIfAborted(signal);

  // Stamp the requested DPI into the container (jpg→JFIF, png→pHYs; webp
  // unchanged). dpi 0 returns the blob untouched, so the default is byte-identical.
  const blob = await applyDpiToBlob(encoded, outputMime, dpi);

  return {
    blob,
    filename: replaceExtension(file.name, extension),
    mimeType: outputMime,
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const imageResizeDescriptor: ConversionDescriptor = {
  id: "image-resize",
  fromLabel: "Image",
  toLabel: "Resized",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png", // overridden per-input by convert; the input format is preserved by default
  defaultOptions: {
    resizeBy: "dimensions",
    sizeWidth: 1024,
    sizeHeight: 1024,
    sizeKeepAspect: true,
    percentage: DEFAULT_PERCENT,
    noEnlarge: false,
    format: "same",
    quality: DEFAULT_QUALITY,
    // Auto-orient ON by default (upright phone photos); DPI 0 = unchanged.
    autoOrient: true,
    dpi: 0,
  },
  controls: [
    {
      type: "select",
      id: "resizeBy",
      label: "Resize by",
      help: "Set exact pixel dimensions, or scale the image by a percentage of its current size.",
      default: "dimensions",
      options: [
        { value: "dimensions", label: "Dimensions" },
        { value: "percentage", label: "Percentage" },
      ],
    },
    {
      type: "dimensions",
      id: "size",
      label: "New size",
      help: "Lock aspect ratio to scale proportionally; unlock to stretch to exact dimensions. Used when resizing by dimensions.",
      default: { width: 1024, height: 1024, keepAspect: true },
      min: 1,
      max: 16384,
    },
    {
      type: "slider",
      id: "percentage",
      label: "Scale",
      help: "Percentage of the original size on each side. Used when resizing by percentage.",
      default: DEFAULT_PERCENT,
      stops: [...PERCENT_STOPS],
      anchor: DEFAULT_PERCENT,
      unit: "%",
    },
    {
      type: "checkbox",
      id: "noEnlarge",
      label: "Do not enlarge",
      help: "Never make the image bigger than the original — the result is capped at the source size on each side.",
      default: false,
    },
    {
      type: "select",
      id: "format",
      label: "Output format",
      help: "Keep the original format, or convert while resizing. PNG is lossless; JPG and WebP use the quality slider.",
      default: "same",
      options: [
        { value: "same", label: "Same as input" },
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG" },
        { value: "webp", label: "WebP" },
      ],
    },
    {
      type: "range",
      id: "quality",
      label: "Quality",
      help: "Only used for JPG and WebP output. Lower quality means a smaller file with more visible artefacts.",
      default: DEFAULT_QUALITY,
      min: MIN_QUALITY,
      max: MAX_QUALITY,
      step: 1,
      unit: "%",
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
  convert: convertImageResize,
};
