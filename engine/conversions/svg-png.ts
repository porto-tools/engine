// SVG → PNG. Unlike PNG↔JPG, the input here is a vector document, not a raster
// the browser can hand us as an ImageBitmap directly. The trick: point an
// <img> at a blob: URL of the SVG and let the browser's *own* SVG renderer
// rasterise it, then draw that <img> onto a canvas. The result matches how the
// SVG looks on a webpage — which is the fidelity users expect. No WASM, so no
// `loadEngine`; everything used here (Image, canvas, blob URLs) is built in.
//
// We deliberately do NOT use createImageBitmap(svgFile): its SVG support is
// patchy across browsers, whereas <img src=blobURL> is the universally-correct
// path for SVG decoding.
//
// QUALITY: an SVG declares its size in CSS pixels, which for an icon is often
// tiny (e.g. 24×24). Rasterising at that intrinsic size produces a postage-stamp
// PNG. We instead render at a higher *device scale* and enforce a minimum long
// edge, so the output is crisp and usable. The `scale` option lets the user pick
// 1×–4×; on top of that, a too-small render is floored up to MIN_LONG_EDGE.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";

// Render size for an SVG with no intrinsic size (no viewBox and no width/height
// attributes). The browser reports 0×0 for such files; 1024² is a sensible
// neutral raster default before the scale multiplier is applied.
const FALLBACK_SIZE = 1024;

// Floor for the longest rendered edge. Even at 1× an icon-sized SVG should come
// out at a usable resolution rather than a literal 24×24 thumbnail, so any
// computed long edge below this is scaled up to meet it (aspect ratio kept).
const MIN_LONG_EDGE = 1024;

// Hard cap on the longest rendered edge. An SVG can declare an enormous
// intrinsic size (or a huge viewBox), and the scale multiplier compounds it;
// rasterising verbatim would allocate a canvas of millions of pixels per side
// and exhaust memory. Cap the long edge and scale the short edge proportionally
// so aspect ratio is preserved. Applied LAST, after scale and the min-edge floor.
const MAX_DIMENSION = 4096;

// Default device scale. 2× matches how the SVG would look on a retina display
// and is a safe crisp default for the common icon/logo case without exploding
// the canvas. The control lets the user pick 1×–4×.
const DEFAULT_SCALE = 2;

// Default background. SVGs are alpha-capable and PNG keeps alpha, so transparent
// is the faithful default — a logo stays cut-out. The control offers an opaque
// white fill for users who need a flat backdrop (e.g. for placing on dark UIs).
const DEFAULT_BACKGROUND = "transparent";

// Reject the wrong format up front with a non-recoverable error. We require the
// exact SVG MIME type. A `.svg` file mislabelled as text/xml (or with no type)
// is common in the wild, but auto-correcting on extension is a v1 non-goal —
// UNSUPPORTED_INPUT is the honest answer, and the UI points the user elsewhere.
// (Documented as a known edge case in the decision/closeout notes.)
function assertSupported(file: File): void {
  if (file.type !== "image/svg+xml") {
    throw new ConversionError("This doesn't look like an SVG file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected image/svg+xml, received "${file.type || "unknown type"}".`,
    });
  }
}

// Normalise the requested scale to a sane multiplier. The Resolution control is
// a <select>, so values arrive as strings ("2") — we accept those as well as
// raw numbers. Falls back to DEFAULT_SCALE for anything missing/unparseable/≤0,
// and clamps to [1, 4] so a stray value can't request a 100× canvas. Pure, so
// it's unit-tested alongside the size math.
export function normalizeScale(scale: unknown): number {
  const n = typeof scale === "string" ? Number(scale) : scale;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_SCALE;
  }
  return Math.min(4, Math.max(1, n));
}

// Decide the canvas dimensions from the browser-reported intrinsic size and the
// chosen device scale. Extracted as a pure function so the size logic — the only
// non-trivial part of this conversion — is unit-testable without a DOM. Order:
//   1. sizeless SVG (either axis ≤ 0 or non-finite, reported as 0×0) → FALLBACK_SIZE²
//   2. multiply by `scale` (device-scale upscale for crispness)
//   3. if the long edge is still below MIN_LONG_EDGE, scale up to meet it
//   4. if the long edge now exceeds MAX_DIMENSION, scale down to the cap
// Steps 3 and 4 are mutually exclusive (the floor is well under the cap), and
// every step preserves aspect ratio. The result is rounded to whole pixels.
export function computeRenderSize(
  naturalWidth: number,
  naturalHeight: number,
  scale: number = DEFAULT_SCALE,
): { width: number; height: number } {
  const rawW = Number.isFinite(naturalWidth) ? naturalWidth : 0;
  const rawH = Number.isFinite(naturalHeight) ? naturalHeight : 0;
  const s = normalizeScale(scale);

  // A zero (or NaN) on *either* axis means there is no usable intrinsic size —
  // you can't draw into a zero-area canvas — so start from the square default.
  const baseW = rawW > 0 && rawH > 0 ? rawW : FALLBACK_SIZE;
  const baseH = rawW > 0 && rawH > 0 ? rawH : FALLBACK_SIZE;

  // Apply the device scale, then derive an extra factor that lifts a too-small
  // render up to the floor OR pulls a too-large render down to the cap. Both are
  // expressed against the *scaled* long edge so they compose cleanly.
  let w = baseW * s;
  let h = baseH * s;
  const longest = Math.max(w, h);

  let factor = 1;
  if (longest < MIN_LONG_EDGE) {
    factor = MIN_LONG_EDGE / longest;
  } else if (longest > MAX_DIMENSION) {
    factor = MAX_DIMENSION / longest;
  }
  w *= factor;
  h *= factor;

  // Guard the rounding so neither axis can collapse to 0 on an extreme ratio.
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

// Load the SVG through the browser's native renderer via an <img>. Resolves
// with the decoded element (carrying naturalWidth/naturalHeight) or rejects
// with DECODE_FAILED if the bytes aren't a renderable SVG — not recoverable by
// retry, the file is malformed or mislabelled.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(
        new ConversionError("We couldn't read this SVG — the file may be damaged.", {
          code: "DECODE_FAILED",
          recoverable: false,
          technical: "The browser's <img> decoder rejected the SVG payload.",
        }),
      );
    img.src = src;
  });
}

// Promisified canvas.toBlob. A null blob (encoder refused) is recoverable —
// usually a transient memory pinch — so the UI offers a retry. Mirrors png-jpg.
function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else
        reject(
          new ConversionError("We couldn't finish encoding this image.", {
            code: "ENCODE_FAILED",
            recoverable: true,
            technical: "canvas.toBlob returned null for image/png.",
          }),
        );
    }, "image/png");
  });
}

async function convertSvgToPng(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const scale = normalizeScale(options?.scale);
  // "white" flattens transparency onto an opaque white fill; anything else
  // (the default) keeps the alpha channel so a logo stays cut-out.
  const background =
    typeof options?.background === "string" ? options.background : DEFAULT_BACKGROUND;
  const opaque = background !== "transparent";

  // File extends Blob, so the SVG bytes are already a Blob. A blob: URL lets the
  // <img> decode it through the browser's SVG renderer. Revoked in `finally`,
  // including on the abort path (throwIfAborted throws → finally still runs).
  const blobUrl = URL.createObjectURL(file);
  try {
    throwIfAborted(signal);

    onProgress?.({ stage: "Rendering" });
    const img = await loadImage(blobUrl);
    throwIfAborted(signal);

    const { width, height } = computeRenderSize(img.naturalWidth, img.naturalHeight, scale);

    onProgress?.({ stage: "Encoding" });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new ConversionError("Your browser couldn't open a drawing canvas.", {
        code: "CANVAS_UNAVAILABLE",
        recoverable: false,
        technical: "HTMLCanvasElement.getContext('2d') returned null.",
      });
    }
    // High-quality downscale/upscale: the browser resamples the vector render
    // smoothly to fit the canvas rather than nearest-neighbour blocking.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Opaque white backdrop only when requested; otherwise the canvas stays
    // transparent and PNG preserves the alpha channel faithfully.
    if (opaque) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    // Draw at the chosen size; the browser scales the vector render to fit.
    ctx.drawImage(img, 0, 0, width, height);
    throwIfAborted(signal);

    const blob = await encode(canvas);
    return {
      blob,
      filename: replaceExtension(file.name, "png"),
      mimeType: "image/png",
      inputSize: file.size,
      outputSize: blob.size,
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export const svgPngDescriptor: ConversionDescriptor = {
  id: "svg-to-png",
  fromLabel: "SVG",
  toLabel: "PNG",
  accept: ["image/svg+xml"],
  newExtension: "png",
  defaultOptions: { scale: DEFAULT_SCALE, background: DEFAULT_BACKGROUND },
  controls: [
    {
      type: "select",
      id: "scale",
      label: "Resolution",
      help: "Higher values render the SVG at more pixels for a sharper PNG. A too-small result is raised to at least 1024 px on its long edge.",
      default: String(DEFAULT_SCALE),
      options: [
        { value: "1", label: "1× (native size)" },
        { value: "2", label: "2× (sharper)" },
        { value: "3", label: "3×" },
        { value: "4", label: "4× (largest)" },
      ],
    },
    {
      type: "select",
      id: "background",
      label: "Background",
      help: "Transparent keeps the SVG's alpha channel. White flattens it onto a solid backdrop.",
      default: DEFAULT_BACKGROUND,
      options: [
        { value: "transparent", label: "Transparent" },
        { value: "#ffffff", label: "White" },
      ],
    },
  ],
  convert: convertSvgToPng,
};
