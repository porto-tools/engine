// PNG → SVG — raster-to-vector tracing via vectortracer (vtracer/WASM).
//
// Unlike the canvas-based conversions, tracing needs a WASM module. We
// lazy-load it inside `loadEngine` / `convert` with a dynamic `import()` so the
// ~130 KB WASM asset lands only in the /png-to-svg route chunk and never in the
// homepage/shared entry. `/check-bundle` enforces this as a release gate.
//
// Tracing runs an iterative `BinaryImageConverter.tick()` loop. Each tick
// returns `true` while work remains and `false` when the trace is complete.
// We relay the library's own `converter.progress()` ratio (0–1) through
// `onProgress` so the ConversionStatus component can show a real progress bar
// for larger or complex images.
//
// IMPORTANT LIMITATION — monochrome output. vectortracer@0.1.2 ships ONLY a
// `BinaryImageConverter`: internally it thresholds the image to one bit (by the
// RED channel) and fills every traced path with a single ink colour. There is no
// colour converter in this package (the README lists it as unimplemented), so the
// output is a clean single-colour vector silhouette, NOT a faithful colour trace.
// That is exactly right for logos, icons, and line art and we say so in the page
// copy. To make a colour PNG trace its shapes correctly rather than keying off
// red alone, we first convert the pixels to perceptual-luminance grayscale below
// (extractGrayscaleImageData) so the one-bit threshold sees real brightness.
// See the closeout note: real multi-colour tracing needs a different/forked dep.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";

// ---------------------------------------------------------------------------
// Trace-option policy
// ---------------------------------------------------------------------------
// Extracted as a pure function so the mapping is unit-testable without a DOM
// or WASM runtime. Mirrors svg-png's `computeRenderSize` pattern.
//
// Defaults tuned for the tool's real use case — logos / icons / line art:
//   - spline mode: smooth Bézier curves, far cleaner edges on letterforms and
//     rounded shapes than the faceted polygon mode the converter shipped with.
//   - filterSpeckle 4: drops sub-4px clusters so JPEG/PNG compression noise and
//     stray anti-aliasing pixels don't become hundreds of junk paths.
//   - detail-preserving thresholds: a tighter lengthThreshold keeps small
//     features, while corner/splice stay at vtracer's well-tested defaults.

export interface TraceOptions {
  /** vtracer curve-fitting mode */
  mode: "polygon" | "spline" | "none";
  /** Minimum cluster area (pixels); speckles below this size are dropped */
  filterSpeckle: number;
  /** Corner-detection threshold in degrees */
  cornerThreshold: number;
  /** Minimum path segment length in pixels */
  lengthThreshold: number;
  /** Curve-fitting max iterations */
  maxIterations: number;
  /** Path splice threshold */
  spliceThreshold: number;
  /** SVG coordinate decimal precision */
  pathPrecision: number;
}

/** Derive `BinaryImageConverter` parameters from our option layer. */
export function buildTraceOptions(opts?: Record<string, unknown>): TraceOptions {
  return {
    mode:
      typeof opts?.mode === "string" &&
      (opts.mode === "polygon" || opts.mode === "spline" || opts.mode === "none")
        ? opts.mode
        : "spline",
    filterSpeckle:
      typeof opts?.filterSpeckle === "number" && opts.filterSpeckle >= 0
        ? opts.filterSpeckle
        : 4,
    cornerThreshold:
      typeof opts?.cornerThreshold === "number" && opts.cornerThreshold >= 0
        ? opts.cornerThreshold
        : 60,
    lengthThreshold:
      typeof opts?.lengthThreshold === "number" && opts.lengthThreshold > 0
        ? opts.lengthThreshold
        : 4,
    maxIterations:
      typeof opts?.maxIterations === "number" && opts.maxIterations > 0
        ? opts.maxIterations
        : 10,
    spliceThreshold:
      typeof opts?.spliceThreshold === "number" && opts.spliceThreshold >= 0
        ? opts.spliceThreshold
        : 45,
    pathPrecision:
      typeof opts?.pathPrecision === "number" && opts.pathPrecision >= 0
        ? opts.pathPrecision
        : 8,
  };
}

// ---------------------------------------------------------------------------
// Luminance pre-pass
// ---------------------------------------------------------------------------
// The WASM converter thresholds the image to one bit using the RED channel only
// (`x.r < 128`). For a colour logo that means a pure-blue or pure-green mark on
// white traces as near-empty or solid garbage, because red carries none of the
// shape. We sidestep that by rewriting each pixel to its Rec. 601 perceptual
// luminance (with alpha composited over white, since the source PNG's alpha
// would otherwise be ignored by the converter). After this pass r == g == b ==
// brightness, so the converter's red-channel threshold becomes a proper
// brightness threshold and coloured artwork traces by its real shapes.
//
// Pure over its input array (mutates a copy's pixels in place is fine — the
// caller owns the ImageData), so it's unit-testable without WASM. Exported for
// the test suite.
export function toLuminanceGrayscale(imageData: ImageData): ImageData {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    // Composite the (possibly translucent) pixel over white so transparent
    // regions read as background (bright) rather than black, matching how the
    // PNG looks on a page and keeping cut-out logos from inverting.
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    // Rec. 601 luma — the standard perceptual weighting.
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
    data[i + 3] = 255;
  }
  return imageData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSupported(file: File): void {
  if (file.type !== "image/png") {
    throw new ConversionError("This doesn't look like a PNG file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected image/png, received "${file.type || "unknown type"}".`,
    });
  }
}

// Decode the PNG bytes into an ImageBitmap via the browser's built-in decoder.
// A decode failure means the bytes are damaged or mislabelled — not recoverable.
async function decodePng(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    throw new ConversionError("We couldn't read this image — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

// Paint the decoded bitmap into a canvas, extract the raw RGBA pixels as an
// `ImageData`, and run the luminance pre-pass so the converter's red-channel
// threshold sees perceptual brightness. `ImageData` is what
// `BinaryImageConverter` expects.
function extractGrayscaleImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return toLuminanceGrayscale(imageData);
}

// Release WASM memory without letting a poisoned/aborted instance throw on free.
function freeQuietly(converter: { free: () => void } | null): void {
  if (!converter) return;
  try {
    converter.free();
  } catch {
    /* the instance trapped mid-trace; nothing more we can safely release */
  }
}

// A calm, recoverable error for an image the tracer genuinely can't handle.
function traceFailed(err: unknown): ConversionError {
  return new ConversionError(
    "We couldn't trace this image. Tracing works best on logos, icons, and line art — try a simpler image, or a different file.",
    {
      code: "DECODE_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    },
  );
}

// Run one full trace pass for a given option set: create the converter, init, tick
// to completion (yielding so aborts/UI events are processed), return the SVG, and
// always release the converter. A WASM panic in init/tick/getResult propagates as a
// thrown (non-ConversionError) value the caller can fall back on.
async function runTrace(
  BinaryImageConverter: (typeof import("vectortracer"))["BinaryImageConverter"],
  imageData: ImageData,
  traceOpts: TraceOptions,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<string> {
  let converter: InstanceType<typeof BinaryImageConverter> | null = null;
  try {
    converter = new BinaryImageConverter(
      imageData,
      {
        debug: false,
        mode: traceOpts.mode,
        cornerThreshold: traceOpts.cornerThreshold,
        lengthThreshold: traceOpts.lengthThreshold,
        maxIterations: traceOpts.maxIterations,
        spliceThreshold: traceOpts.spliceThreshold,
        filterSpeckle: traceOpts.filterSpeckle,
        pathPrecision: traceOpts.pathPrecision,
      },
      { invert: false, pathFill: "#000000", backgroundColor: "transparent", attributes: undefined },
    );
    converter.init();
    throwIfAborted(signal, () => { freeQuietly(converter); converter = null; });

    let done = false;
    while (!done) {
      throwIfAborted(signal, () => { freeQuietly(converter); converter = null; });
      done = !converter.tick();
      onProgress?.({ stage: "Tracing", ratio: converter.progress() });
      // Yield to the event loop so abort signals and UI events are processed.
      await Promise.resolve();
    }
    throwIfAborted(signal, () => { freeQuietly(converter); converter = null; });
    return converter.getResult();
  } finally {
    freeQuietly(converter);
  }
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

async function convertPngToSvg(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  // Lazy-load WASM — this is what keeps vectortracer out of the shared chunk.
  // `loadEngine` pre-warms the import before any file is dropped, but the
  // dynamic import is cached by the module system after the first call.
  onProgress?.({ stage: "Loading tracer" });
  const { BinaryImageConverter } = await import("vectortracer").catch((err) => {
    throw new ConversionError("Failed to load the tracing engine.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  });
  throwIfAborted(signal);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decodePng(file);
  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Tracing" });
  const imageData = extractGrayscaleImageData(bitmap);
  bitmap.close();
  throwIfAborted(signal);

  const traceOpts = buildTraceOptions(options);

  // Trace, with a polygon-mode fallback. vectortracer's spline curve-fitting can
  // PANIC inside the WASM ("two lines are parallel!") on certain path geometries;
  // that surfaces here as a thrown non-ConversionError. Polygon mode skips the
  // curve-fitting math, so we retry there once before giving up with a calm note.
  // (The converter copies the pixels into WASM memory, so reusing imageData for the
  // retry is safe — the first attempt does not detach it.)
  let svgMarkup: string;
  try {
    svgMarkup = await runTrace(BinaryImageConverter, imageData, traceOpts, signal, onProgress);
  } catch (err) {
    if (err instanceof ConversionError) throw err; // cancellation / our own errors
    if (traceOpts.mode !== "polygon") {
      try {
        svgMarkup = await runTrace(
          BinaryImageConverter,
          imageData,
          { ...traceOpts, mode: "polygon" },
          signal,
          onProgress,
        );
      } catch (retryErr) {
        if (retryErr instanceof ConversionError) throw retryErr;
        throw traceFailed(retryErr);
      }
    } else {
      throw traceFailed(err);
    }
  }

  if (!svgMarkup || svgMarkup.trim().length === 0) {
    throw new ConversionError("The tracer produced no output — the image may be empty or corrupt.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: "BinaryImageConverter.getResult() returned an empty string.",
    });
  }

  const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
  return {
    blob,
    filename: replaceExtension(file.name, "svg"),
    mimeType: "image/svg+xml",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

export const pngSvgDescriptor: ConversionDescriptor = {
  id: "png-to-svg",
  fromLabel: "PNG",
  toLabel: "SVG",
  accept: ["image/png"],
  newExtension: "svg",
  loadEngine: async () => {
    // Pre-warm the WASM module before the user drops a file. The dynamic
    // import is cached after the first call; subsequent calls are instant.
    // A failure must throw so the setup state surfaces as a real error rather
    // than flickering setup → converting → error (mirrors pdf-image's pattern).
    await import("vectortracer").catch((err) => {
      throw new ConversionError("Failed to load the tracing engine.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      });
    });
  },
  // vectortracer's WASM is small (~130 KB) but still a one-time download; a
  // labelled setup line is more honest than a silent fetch inside "Converting…".
  setupSizeLabel: "≈ 130 KB",
  convert: convertPngToSvg,
};
