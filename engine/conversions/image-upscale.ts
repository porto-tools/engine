// Image upscale — enlarge an image with high-quality Canvas resampling.
//
// This is HONEST high-quality resampling, NOT AI super-resolution: it draws the
// source onto a larger canvas with the browser's high-quality bilinear/bicubic
// smoothing (imageSmoothingQuality = "high"), optionally followed by ONE mild
// 3x3 sharpen convolution to recover a little crispness. No invented detail, no
// model, no WASM — so there is no `loadEngine`.
//
// Like image-resize it runs on the browser's built-in Canvas. The output format
// is chosen by the user: "same" keeps the input's own codec; png/jpg/webp force
// that codec instead. Options arrive from the UI and are read defensively.
//
// Guard: each output axis is capped at MAX_OUTPUT_DIMENSION (8000px). A canvas of
// 8000x8000 RGBA is already ~256 MB; allowing the requested scale to exceed that
// risks allocation failures across browsers, so we reject it up front with a
// recoverable UNSUPPORTED_INPUT that explains the limit.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { decode, encode } from "./canvas";
import { RASTER_IMAGE_ACCEPT as ACCEPT, RASTER_MIME_TO_EXTENSION as MIME_TO_EXTENSION } from "./mime";

// Allowed scale factors (stepping by 0.5) and the default. Read from a select
// whose values are the strings "1.5" / "2" / … / "4"; clampScale below snaps
// whatever arrives to the nearest 0.5 step and validates it against this list.
const SCALES = [1.5, 2, 2.5, 3, 3.5, 4] as const;
const DEFAULT_SCALE = 2;

// Hard cap on either output axis (see header).
const MAX_OUTPUT_DIMENSION = 8000;

// Accepted raster inputs (ACCEPT) are shared via ./mime, imported above.

// Output format choices. "same" keeps the input codec; the others force a codec.
const FORMAT_VALUES = ["same", "png", "jpg", "webp"] as const;
const DEFAULT_FORMAT = "same";

// The input-MIME→extension map (MIME_TO_EXTENSION), used when format is "same",
// is shared via ./mime, imported above.

// Map a forced format choice to its MIME + extension.
const FORMAT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
const FORMAT_TO_EXTENSION: Record<string, string> = {
  png: "png",
  jpg: "jpg",
  webp: "webp",
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

// Read the scale option defensively, snapping to the nearest allowed 0.5 step.
// Missing, non-numeric, or out-of-range values fall back to the default. Pure —
// unit-tested.
export function clampScale(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  // Snap to the nearest half-step so e.g. 2.4 -> 2.5; the /2 then *2 keeps the
  // result on the 0.5 grid without floating-point drift for these magnitudes.
  const snapped = Math.round(n * 2) / 2;
  return (SCALES as readonly number[]).includes(snapped) ? snapped : DEFAULT_SCALE;
}

// Resolve the output MIME type and extension from the chosen format and the
// input's own MIME. "same" (or any unrecognised value) keeps the input codec.
// Pure — unit-tested.
export function resolveOutputMime(
  format: unknown,
  inputMime: string,
): { mimeType: string; extension: string } {
  const normalisedInput = inputMime === "image/jpg" ? "image/jpeg" : inputMime;
  const choice = typeof format === "string" ? format : DEFAULT_FORMAT;
  if (choice !== DEFAULT_FORMAT && choice in FORMAT_TO_MIME) {
    return { mimeType: FORMAT_TO_MIME[choice], extension: FORMAT_TO_EXTENSION[choice] };
  }
  return {
    mimeType: normalisedInput,
    extension: MIME_TO_EXTENSION[normalisedInput] ?? "png",
  };
}

// Apply ONE mild 3x3 sharpen convolution in place on the upscaled canvas. The
// kernel is the classic unsharp-ish stencil [0,-1,0; -1,5,-1; 0,-1,0] (sum = 1,
// so already normalised — no division needed). Each output RGB channel is clamped
// to [0, 255]; alpha is copied through untouched so edges keep their transparency.
// Edge pixels read their own value where a neighbour would fall outside the image.
function sharpenCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const src = ctx.getImageData(0, 0, width, height);
  const srcData = src.data;
  const out = ctx.createImageData(width, height);
  const outData = out.data;

  const at = (x: number, y: number) => (y * width + x) * 4;
  const clampCoord = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      // Orthogonal neighbours (clamped at the borders).
      const up = at(x, clampCoord(y - 1, height - 1));
      const down = at(x, clampCoord(y + 1, height - 1));
      const left = at(clampCoord(x - 1, width - 1), y);
      const right = at(clampCoord(x + 1, width - 1), y);

      for (let c = 0; c < 3; c++) {
        const value =
          5 * srcData[i + c] -
          srcData[up + c] -
          srcData[down + c] -
          srcData[left + c] -
          srcData[right + c];
        outData[i + c] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
      // Alpha passes through unchanged.
      outData[i + 3] = srcData[i + 3];
    }
  }

  ctx.putImageData(out, 0, 0);
}

async function convertImageUpscale(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const scale = clampScale(options?.scale);
  const sharpen = options?.sharpen === true;
  const { mimeType: outputMime, extension } = resolveOutputMime(options?.format, file.type);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  const width = bitmap.width * scale;
  const height = bitmap.height * scale;

  // Guard the output size BEFORE allocating the canvas.
  if (width > MAX_OUTPUT_DIMENSION || height > MAX_OUTPUT_DIMENSION) {
    bitmap.close();
    throw new ConversionError(
      `Upscaling by ${scale}x would make this image too large (the limit is ${MAX_OUTPUT_DIMENSION}px on each side). Try a smaller scale or a smaller image.`,
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: `Requested output ${width}x${height}px exceeds the ${MAX_OUTPUT_DIMENSION}px per-axis cap.`,
      },
    );
  }

  onProgress?.({ stage: "Upscaling" });
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
  // High-quality resampling on the enlarge.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  throwIfAborted(signal);

  if (sharpen) {
    onProgress?.({ stage: "Sharpening" });
    sharpenCanvas(ctx, width, height);
    throwIfAborted(signal);
  }

  onProgress?.({ stage: "Encoding" });
  const blob = await encode(canvas, outputMime);
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, extension),
    mimeType: outputMime,
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const imageUpscaleDescriptor: ConversionDescriptor = {
  id: "image-upscale",
  fromLabel: "Image",
  toLabel: "Upscaled",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png", // overridden per-input by convert; the chosen format wins
  defaultOptions: { scale: String(DEFAULT_SCALE), sharpen: false, format: DEFAULT_FORMAT },
  controls: [
    {
      type: "select",
      id: "scale",
      label: "Scale",
      help: "How much larger to make the image. Higher factors enlarge more but cannot add detail that was never captured.",
      default: String(DEFAULT_SCALE),
      options: SCALES.map((s) => ({ value: String(s), label: `${s}x` })),
    },
    {
      type: "checkbox",
      id: "sharpen",
      label: "Sharpen edges",
      help: "Apply one mild sharpening pass after enlarging to recover a little crispness. Leave off for the softest result.",
      default: false,
    },
    {
      type: "select",
      id: "format",
      label: "Output format",
      help: "Keep the original format, or save as PNG, JPG, or WebP instead.",
      default: DEFAULT_FORMAT,
      options: [
        { value: "same", label: "Same as input" },
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG" },
        { value: "webp", label: "WebP" },
      ],
    },
  ],
  convert: convertImageUpscale,
};

// Exported for the descriptor and tests to share the same source of truth.
export const IMAGE_UPSCALE_FORMAT_VALUES = FORMAT_VALUES;
