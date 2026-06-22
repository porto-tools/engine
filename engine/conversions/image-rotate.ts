// Image rotate — parameterized Canvas tool. A single angle control: rotate by
// ANY number of degrees (clockwise), with two 90° quick-rotate buttons and a
// numeric stepper in the UI. The output canvas grows to the rotated bounding box
// so no corner is ever clipped: outW = round(|w·cos| + |h·sin|),
// outH = round(|w·sin| + |h·cos|). The rotate is the standard
// translate(outW/2,outH/2) → rotate(rad) → drawImage(bitmap, -w/2, -h/2) pattern
// on a 2D canvas, re-encoding to the source mime (JPG→JPG, PNG→PNG, WebP→WebP).
// PNG/WebP keep their transparency in the triangular gaps the rotation opens up;
// JPEG (no alpha) fills those gaps with white instead of black.

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

// Parse the angle option into a degree in [0, 360). Non-numeric / non-finite
// values default to 0 (no rotation). Any real number is normalized the same way
// the UI shows it: ((n % 360) + 360) % 360, so -90 → 270, 450 → 90, 360 → 0.
// Pure, no DOM — unit-tested.
export function parseRotateAngle(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

// The output canvas size for an arbitrary rotation: the axis-aligned bounding box
// of the source rotated by `deg` degrees, so no corner is ever clipped. The width
// each rotated edge projects onto the X axis is |w·cos| + |h·sin|; onto Y it is
// |w·sin| + |h·cos|. Rounded to whole pixels and floored at 1 so a degenerate
// input never yields a zero-sized canvas. At 0°/180° this is exactly w×h and at
// 90°/270° it transposes to h×w — so the right-angle steps stay byte-identical to
// the un-expanded output. Pure, no DOM — unit-tested across 0/45/90/180/270 and
// arbitrary angles.
export function rotatedBounds(
  w: number,
  h: number,
  deg: number,
): { width: number; height: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    width: Math.max(1, Math.round(w * cos + h * sin)),
    height: Math.max(1, Math.round(w * sin + h * cos)),
  };
}

async function convertImageRotate(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const outputMime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  const extension = MIME_TO_EXTENSION[outputMime] ?? "png";
  const angle = parseRotateAngle(options?.angle);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  const w = bitmap.width;
  const h = bitmap.height;

  // Expanded bounding box for an arbitrary angle so no corner is clipped. At 0
  // (and 180) this is exactly w×h; at 90/270 it transposes; in between it grows.
  // The math is the pure, DOM-free `rotatedBounds` helper (unit-tested); `rad`
  // is still needed below to drive ctx.rotate.
  const rad = (angle * Math.PI) / 180;
  const { width: outW, height: outH } = rotatedBounds(w, h, angle);

  onProgress?.({ stage: "Rotating" });
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }

  // JPEG has no alpha channel: the triangular gaps a rotation opens would encode
  // as black. Paint a white ground first so they read as white instead. PNG/WebP
  // keep their transparency, so they're left untouched.
  if (outputMime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
  }

  // Standard rotate pattern over the EXPANDED canvas: move the origin to the new
  // canvas centre, rotate, then draw the bitmap centred on that origin.
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(bitmap, -w / 2, -h / 2);
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

export const imageRotateDescriptor: ConversionDescriptor = {
  id: "image-rotate",
  fromLabel: "Image",
  toLabel: "Rotated",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png", // overridden per-input; source format is preserved
  defaultOptions: { angle: 0 },
  // ONE angle control: two circular-arrow quick-rotate buttons (left −90 /
  // right +90, each accumulating) plus a numeric stepper the user can type into,
  // with a LIVE preview of the staged image rotated by the current value. The
  // option key is `angle` (a number, degrees) — convertImageRotate normalizes it
  // and rotates with an expanded bounding box so no corner is ever clipped.
  controls: [
    {
      type: "angle",
      id: "angle",
      label: "Rotation",
      help: "Rotate left or right in 90° steps, or type any angle. The preview updates live.",
      default: 0,
      step: 1,
      unit: "°",
    },
  ],
  convert: convertImageRotate,
};
