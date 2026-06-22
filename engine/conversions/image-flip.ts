// Image flip — parameterized Canvas tool. Two INDEPENDENT axis toggles
// (horizontal / vertical): either, both, or neither. Each active axis is applied
// with the standard translate + scale(-1) trick on a 2D canvas context —
// horizontal mirrors left↔right (scaleX(-1)), vertical mirrors top↔bottom
// (scaleY(-1)) — re-encoding to the source mime. With both on the image is
// rotated 180° (mirrored on both axes); with neither on the output equals the
// input but is still re-encoded so the tool always produces a fresh file.

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

// The two independent flip axes, read from the toggle-group's fan-out keys
// (options.flipHorizontal / options.flipVertical). A value counts as "on" only
// when it is strictly the boolean true — anything else (undefined, "false",
// 0…) is off. Pure, no DOM — unit-tested.
export interface FlipAxes {
  horizontal: boolean;
  vertical: boolean;
}

export function parseFlipAxes(options: Record<string, unknown> | undefined): FlipAxes {
  return {
    horizontal: options?.flipHorizontal === true,
    vertical: options?.flipVertical === true,
  };
}

async function convertImageFlip(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const outputMime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  const extension = MIME_TO_EXTENSION[outputMime] ?? "png";
  const { horizontal, vertical } = parseFlipAxes(options);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Flipping" });
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

  // Apply each active axis. Horizontal: translate to the right edge, scaleX(-1).
  // Vertical: translate to the bottom edge, scaleY(-1). With neither set the
  // transform is identity and the draw is a faithful copy (still re-encoded).
  const sx = horizontal ? -1 : 1;
  const sy = vertical ? -1 : 1;
  ctx.translate(horizontal ? bitmap.width : 0, vertical ? bitmap.height : 0);
  ctx.scale(sx, sy);
  ctx.drawImage(bitmap, 0, 0);
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

export const imageFlipDescriptor: ConversionDescriptor = {
  id: "image-flip",
  fromLabel: "Image",
  toLabel: "Flipped",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png", // overridden per-input; source format is preserved
  defaultOptions: { flipHorizontal: false, flipVertical: false },
  // ONE toggle-group control with two INDEPENDENT axes. Each fans out to a flat
  // boolean key (options.flipHorizontal / options.flipVertical) seeded off; both
  // can be on at once. previewTransform "flip" composes the active axes live —
  // horizontal → scaleX(-1), vertical → scaleY(-1), both → scaleX(-1) scaleY(-1).
  controls: [
    {
      type: "toggle-group",
      id: "flip",
      label: "Flip",
      help: "Mirror left-to-right, top-to-bottom, or both. The preview updates live.",
      previewTransform: "flip",
      toggles: [
        { id: "Horizontal", label: "Horizontal", icon: "flip-horizontal" },
        { id: "Vertical", label: "Vertical", icon: "flip-vertical" },
      ],
    },
  ],
  convert: convertImageFlip,
};
