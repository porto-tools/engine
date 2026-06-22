// WEBP ↔ JPG — both directions run on the browser's built-in Canvas (no WASM),
// so neither descriptor declares a `loadEngine`: there is nothing to download.
// The pattern mirrors png-jpg.ts (the reference pair); the differences are the
// accepted input type, whether we flatten transparency onto a background (JPG
// has no alpha), and the output codec. The Canvas helpers are duplicated from
// png-jpg.ts rather than shared — each conversion file stays self-contained so
// the eventual @porto-tools/engine extraction is mechanical.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { assertSupported, decode, drawToCanvas, encode } from "./canvas";
import { clampQuality } from "./numbers";

// Encoder quality as a PERCENT (10–100), mapped to canvas.toBlob's 0–1 scale as
// quality/100 — the same convention as compress-image, so the UI shows a "%"
// slider. 92% keeps artefacts invisible at typical viewing while still shrinking
// most images substantially. (92/100 = the previous 0.92 default, so the
// out-of-the-box output is unchanged.) Used by both directions.
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

// The flatten background the user can pick for JPG output. JPG has no alpha, so
// transparent WEBP pixels are composited over this solid colour before encoding
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

async function convertWebpToJpg(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file, ["image/webp"], "WEBP");

  const quality = clampQuality(options?.quality);
  const background = readBackground(options?.background);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  // JPG has no alpha — flatten any transparency in the WEBP onto the background.
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

async function convertJpgToWebp(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  // Some platforms label JPEGs as the non-standard "image/jpg"; accept both.
  assertSupported(file, ["image/jpeg", "image/jpg"], "JPG");

  const quality = clampQuality(options?.quality);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  // WEBP supports alpha, so no background fill is needed. The output is lossy
  // WEBP at `quality` — typically smaller than the source JPG at like quality.
  onProgress?.({ stage: "Encoding" });
  const canvas = drawToCanvas(bitmap);
  const blob = await encode(canvas, "image/webp", quality / 100);
  bitmap.close();
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, "webp"),
    mimeType: "image/webp",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Both directions are lossy, so each exposes the same "%" quality slider.
const QUALITY_CONTROL = {
  type: "range" as const,
  id: "quality",
  label: "Quality",
  help: "Lower quality means a smaller file with more visible artefacts. Higher quality keeps more detail at the cost of size.",
  default: DEFAULT_QUALITY,
  min: MIN_QUALITY,
  max: MAX_QUALITY,
  step: 1,
  unit: "%",
};

// Only the →JPG direction needs this: a plain `select` (the same control kind
// image-converter uses for its JPG background) — not a new control KIND. White
// is the default, reproducing the previous hardcoded fill exactly. JPG→WEBP
// keeps alpha, so it does NOT get this control.
const BACKGROUND_CONTROL = {
  type: "select" as const,
  id: "background",
  label: "Background (for JPG)",
  help: "JPG has no transparency. Transparent areas of the WebP are filled with this colour in the JPG output.",
  default: DEFAULT_BACKGROUND,
  options: [
    { value: "white", label: "White" },
    { value: "black", label: "Black" },
  ],
};

export const webpJpgDescriptor: ConversionDescriptor = {
  id: "webp-to-jpg",
  fromLabel: "WEBP",
  toLabel: "JPG",
  accept: ["image/webp"],
  newExtension: "jpg",
  defaultOptions: { quality: DEFAULT_QUALITY, background: DEFAULT_BACKGROUND },
  controls: [QUALITY_CONTROL, BACKGROUND_CONTROL],
  convert: convertWebpToJpg,
};

export const jpgWebpDescriptor: ConversionDescriptor = {
  id: "jpg-to-webp",
  fromLabel: "JPG",
  toLabel: "WEBP",
  accept: ["image/jpeg", "image/jpg"],
  newExtension: "webp",
  defaultOptions: { quality: DEFAULT_QUALITY },
  controls: [QUALITY_CONTROL],
  convert: convertJpgToWebp,
};
