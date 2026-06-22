// Image crop — parameterized Canvas tool. The descriptor declares ONE visual
// crop control (a draggable box over the image); it fans out to four flat
// option keys cropX/cropY/cropW/cropH (image-pixel integers), which the convert
// reads defensively — the same keys the four number controls used to write, so
// the convert logic is unchanged. The crop runs on createImageBitmap +
// canvas.drawImage, re-encoding to the SOURCE mime so a JPG stays a JPG, PNG
// stays PNG, WebP stays WebP.
//
// Validation rule: x + w must not exceed the source width, y + h must not
// exceed the source height. Violations throw UNSUPPORTED_INPUT (non-recoverable
// because the coordinates are wrong, not the file) rather than silently
// clamping — silent clamping hides a user mistake.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { decode, encode } from "./canvas";
import { RASTER_IMAGE_ACCEPT as ACCEPT, RASTER_MIME_TO_EXTENSION as MIME_TO_EXTENSION } from "./mime";

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a JPG, PNG, or WebP image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

// Read a crop coordinate from options, clamping to a non-negative integer.
// Missing or non-numeric values fall back to `fallback`.
function readCoord(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

// Read a crop DIMENSION (width/height). Like readCoord but a non-positive value
// (missing, non-numeric, or the crop control's 0 "not sized yet" seed) means
// "the full source size" — so a crop box that never sized (e.g. the image
// failed to decode in the panel) still yields the whole image rather than
// failing the min-size check. An explicit positive value is honored as-is and
// still validated against the source bounds below.
function readDimension(value: unknown, sourceSize: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return sourceSize;
  return Math.round(n);
}

// Exported for unit tests (pure, DOM-free).
export function parseCropParams(
  options: Record<string, unknown> | undefined,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; w: number; h: number } {
  const x = readCoord(options?.cropX, 0);
  const y = readCoord(options?.cropY, 0);
  const w = readDimension(options?.cropW, sourceWidth);
  const h = readDimension(options?.cropH, sourceHeight);

  if (w < 1 || h < 1) {
    throw new ConversionError("Crop width and height must be at least 1 pixel.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `w=${w}, h=${h}`,
    });
  }

  if (x + w > sourceWidth || y + h > sourceHeight) {
    throw new ConversionError(
      "The crop region extends beyond the image boundaries.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Crop (x=${x}, y=${y}, w=${w}, h=${h}) vs source (${sourceWidth}×${sourceHeight}).`,
      },
    );
  }

  return { x, y, w, h };
}

// ── Aspect-ratio presets (UI-only) ───────────────────────────────────────────
// The crop ENGINE is ratio-agnostic: it crops exactly the cropX/Y/W/H rectangle
// it is handed. These two pure helpers back the website's aspect-ratio preset
// picker (Free / 1:1 / 4:3 / 16:9 / 3:2): the app component maps the chosen
// preset to a numeric ratio and, when it isn't Free, re-shapes the dragged crop
// box to that ratio before writing it to cropX/Y/W/H. Keeping the math here (pure,
// DOM-free) lets it be unit-tested and reused without touching the shared CropBox.
// "Free" returns null → the app leaves the box untouched, so the default path is
// byte-identical to the un-preset crop.

// Map an aspect-preset key to a width/height ratio. Free / unknown → null
// ("no constraint"). Accepts a couple of spellings so the option value the UI
// stores ("free", "1:1", …) is robust.
export function aspectRatioFromPreset(preset: unknown): number | null {
  switch (String(preset)) {
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "16:9":
      return 16 / 9;
    case "3:2":
      return 3 / 2;
    case "free":
    case "":
    default:
      return null;
  }
}

// Re-shape a crop rectangle to a target width/height `ratio`, keeping it inside
// the image bounds. The rectangle is shrunk (never grown past the box the user
// drew) on whichever axis is too long for the ratio, then nudged back inside the
// image if rounding pushed an edge out. Returns whole-pixel integers. A
// non-positive / non-finite ratio is treated as "no constraint" and the rect is
// returned rounded but otherwise unchanged. Pure, no DOM — unit-tested.
export function constrainRectToAspect(
  rect: { x: number; y: number; w: number; h: number },
  ratio: number | null,
  bounds: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const w0 = Math.max(1, Math.round(rect.w));
  const h0 = Math.max(1, Math.round(rect.h));

  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
    return { x: x0, y: y0, w: w0, h: h0 };
  }

  // Shrink the over-long axis so w/h == ratio. If the box is wider than the
  // ratio wants (w0/h0 > ratio) the width is the long side → derive w from h;
  // otherwise the height is long → derive h from w.
  let w = w0;
  let h = h0;
  if (w0 / h0 > ratio) {
    w = Math.round(h0 * ratio);
  } else {
    h = Math.round(w0 / ratio);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);

  // The ratio'd box must still fit the image. If either axis overflows the
  // bounds, scale the box down to the largest size of this ratio that fits.
  if (w > bounds.width || h > bounds.height) {
    const fitW = Math.min(w, bounds.width);
    const fitH = Math.min(h, bounds.height);
    if (fitW / fitH > ratio) {
      w = Math.max(1, Math.round(fitH * ratio));
      h = fitH;
    } else {
      w = fitW;
      h = Math.max(1, Math.round(fitW / ratio));
    }
  }

  // Keep the top-left anchor, but slide back inside the image if the resized box
  // now spills past the right / bottom edge.
  const x = Math.max(0, Math.min(x0, bounds.width - w));
  const y = Math.max(0, Math.min(y0, bounds.height - h));
  return { x, y, w, h };
}

async function convertImageCrop(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const outputMime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  const extension = MIME_TO_EXTENSION[outputMime] ?? "png";

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  const { x, y, w, h } = parseCropParams(options, bitmap.width, bitmap.height);

  onProgress?.({ stage: "Cropping" });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) — cut the region from
  // the source bitmap and place it at the origin of the output canvas.
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  bitmap.close();
  throwIfAborted(signal);

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

export const imageCropDescriptor: ConversionDescriptor = {
  id: "image-crop",
  fromLabel: "Image",
  toLabel: "Cropped",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png", // overridden per-input; source format is preserved
  // The crop control sets its real defaults (the full image, in image pixels)
  // once the image loads; these defaults are the safe fallback the convert reads
  // when the control hasn't run yet. Missing X/Y default to 0 and missing W/H to
  // the source size in parseCropParams, so the values here are only a backstop.
  defaultOptions: { cropX: 0, cropY: 0, cropW: 0, cropH: 0 },
  controls: [
    {
      type: "crop",
      id: "crop",
      label: "Crop area",
      help: "Drag the box to move it, or a corner to resize. Fine-tune with the precise values below.",
    },
  ],
  convert: convertImageCrop,
};
