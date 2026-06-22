// PNG ↔ JPG — the reference conversion pair. Both directions run on the
// browser's built-in Canvas (no WASM), so neither descriptor declares a
// `loadEngine`: there is nothing to download. The two functions are nearly
// identical; the differences are the accepted input type, whether we flatten
// transparency onto a background (JPG has no alpha), and the output codec.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { assertSupported, decode, drawToCanvas, encode } from "./canvas";
import { clampQuality } from "./numbers";

// JPEG quality as a PERCENT (10–100), mapped to canvas.toBlob's 0–1 scale as
// quality/100 — the same convention as compress-image, so the UI shows a "%"
// slider. 92% keeps artefacts invisible at typical viewing while still shrinking
// most PNG screenshots/photos substantially. (92/100 = the previous 0.92 default,
// so the out-of-the-box output is unchanged.)
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

// The flatten background the user can pick for JPG output. JPG has no alpha, so
// transparent PNG pixels are composited over this solid colour before encoding
// (otherwise they'd render black). We map a small fixed set of KEYS to hex —
// never trusting a raw option string onto the canvas — and default to white,
// which reproduces the previous hardcoded "#ffffff" fill byte-for-byte. Mirrors
// image-converter.ts's readBackground; kept local so this file stays
// self-contained for the eventual @porto-tools/engine extraction.
const BACKGROUNDS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
};
const DEFAULT_BACKGROUND = "white";

// Resolve the JPG flatten background option (a KEY like "white"/"black") to its
// hex colour. Any unknown or non-string value falls back to white, so a bad
// option can never inject an arbitrary CSS string onto the canvas. Pure, no DOM
// — unit-tested directly.
export function readBackground(value: unknown): string {
  const key = typeof value === "string" ? value : DEFAULT_BACKGROUND;
  return BACKGROUNDS[key] ?? BACKGROUNDS[DEFAULT_BACKGROUND];
}

async function convertPngToJpg(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file, ["image/png"], "PNG");

  const quality = clampQuality(options?.quality);
  const background = readBackground(options?.background);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Encoding" });
  const canvas = drawToCanvas(bitmap, background);
  const blob = await encode(canvas, "image/jpeg", quality / 100);
  bitmap.close();
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, "jpg"),
    mimeType: "image/jpeg",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

async function convertJpgToPng(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);
  // Some platforms label JPEGs as the non-standard "image/jpg"; accept both.
  assertSupported(file, ["image/jpeg", "image/jpg"], "JPG");

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  // PNG is lossless and alpha-capable — no background fill, no quality option.
  onProgress?.({ stage: "Encoding" });
  const canvas = drawToCanvas(bitmap);
  const blob = await encode(canvas, "image/png");
  bitmap.close();
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, "png"),
    mimeType: "image/png",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const pngToJpgDescriptor: ConversionDescriptor = {
  id: "png-to-jpg",
  fromLabel: "PNG",
  toLabel: "JPG",
  accept: ["image/png"],
  newExtension: "jpg",
  defaultOptions: { quality: DEFAULT_QUALITY, background: DEFAULT_BACKGROUND },
  controls: [
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
      // A plain `select` (the same control kind image-converter uses for its JPG
      // background) — not a new control KIND. White is the default, reproducing
      // the previous hardcoded fill exactly.
      type: "select",
      id: "background",
      label: "Background (for JPG)",
      help: "JPG has no transparency. Transparent areas of the PNG are filled with this colour in the JPG output.",
      default: DEFAULT_BACKGROUND,
      options: [
        { value: "white", label: "White" },
        { value: "black", label: "Black" },
      ],
    },
  ],
  convert: convertPngToJpg,
};

export const jpgToPngDescriptor: ConversionDescriptor = {
  id: "jpg-to-png",
  fromLabel: "JPG",
  toLabel: "PNG",
  accept: ["image/jpeg", "image/jpg"],
  newExtension: "png",
  convert: convertJpgToPng,
};
