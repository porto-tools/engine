// WEBP ↔ PNG — the transparency-preserving image pair. Both directions run on
// the browser's built-in Canvas (no WASM), so neither descriptor declares a
// `loadEngine`: there is nothing to download. Unlike PNG ↔ JPG, neither
// direction flattens onto a background — PNG and WEBP both carry an alpha
// channel, so transparency passes straight through. The differences between the
// two functions are the accepted input type, the output codec, and whether a
// quality option applies (lossless PNG has none; lossy WEBP defaults to 0.92).

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { assertSupported, decode, drawToCanvas, encode } from "./canvas";
import { clampQuality } from "./numbers";

// WEBP quality as a PERCENT (10–100), mapped to canvas.toBlob's 0–1 scale as
// quality/100 — the same convention as compress-image, so the UI shows a "%"
// slider. Lossless WEBP exists but is typically larger than users expect; lossy
// at 92% keeps artefacts invisible while still shrinking most PNGs substantially.
// Alpha is preserved by the encoder at any quality. (92/100 = the previous 0.92
// default, so the out-of-the-box output is unchanged.)
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

async function convertWebpToPng(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file, ["image/webp"], "WEBP");

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

async function convertPngToWebp(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file, ["image/png"], "PNG");

  const quality = clampQuality(options?.quality);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  // WEBP carries alpha, so the PNG's transparency passes through unflattened.
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

export const webpPngDescriptor: ConversionDescriptor = {
  id: "webp-to-png",
  fromLabel: "WEBP",
  toLabel: "PNG",
  accept: ["image/webp"],
  newExtension: "png",
  convert: convertWebpToPng,
};

export const pngWebpDescriptor: ConversionDescriptor = {
  id: "png-to-webp",
  fromLabel: "PNG",
  toLabel: "WEBP",
  accept: ["image/png"],
  newExtension: "webp",
  defaultOptions: { quality: DEFAULT_QUALITY },
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
  ],
  convert: convertPngToWebp,
};
