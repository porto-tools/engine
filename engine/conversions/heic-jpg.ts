// HEIC → JPG. Unlike PNG↔JPG (Canvas-native), HEIC images are HEVC-compressed
// frames wrapped in an ISOBMFF container — a format browsers do not natively
// decode. We lean on libheif-js (an Emscripten build of libheif) to decompress
// the HEVC payload into raw RGBA pixel data, then paint that data onto a Canvas
// and re-encode as JPEG at quality 0.92.
//
// The ~1.5 MB wasm-bundle (JS wrapper + inlined WASM) is lazy-loaded once via
// `loadEngine`; the shared ConversionTool renders "Setting up the converter…"
// while this runs and keeps the dropzone disabled. Return visits skip the load
// (browser cache).
//
// MIME note: only Apple platforms (Safari) report a HEIC photo as "image/heic".
// Chrome, Firefox and most Windows/Android browsers don't recognise the format
// and hand us an EMPTY ("") or GENERIC ("application/octet-stream") type, so a
// strict MIME gate wrongly rejects valid files. We accept the standard HEIC MIME
// values AND fall back to the .heic/.heif extension whenever the browser is
// unsure of the type — see isHeicFile() for the exact rule.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";

// libheif-js ships three entry points. `wasm-bundle` inlines the WASM as a
// base64 data URI inside the JS bundle, making it the easiest path for browser
// bundlers — no separate .wasm fetch or CORS configuration needed.
// The import is a factory that returns the module synchronously (the WASM is
// already decoded from the embedded base64 string).
// We declare a minimal local type here so TypeScript is satisfied without
// adding `@types/libheif-js` (which does not exist) to package.json.
type LibheifModule = {
  HeifDecoder: new () => {
    decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
  };
};

type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  // Fills `imageData` with RGBA pixels and calls `cb` with the same object
  // (or null on failure). libheif defers the decode+paint inside a
  // setTimeout(…, 0), so the callback fires ASYNCHRONOUSLY on a later tick —
  // which is exactly why convert() wraps this in a Promise rather than reading
  // imageData straight after the call.
  display(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    cb: (displayData: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void;
  // Explicit WASM-heap deallocation. libheif allocates HEVC frame buffers on
  // the Emscripten heap; calling free() releases them deterministically.
  // Without this, each decoded image leaks its pixel data into the WASM heap
  // until the GC eventually collects the JS wrapper — for large Apple photos
  // this can exhaust the 4 GB addressable WASM memory. We call free() in
  // `finally` so the release happens on both the success path and the abort /
  // error paths.
  free(): void;
};

const DEFAULT_QUALITY = 0.92;
const DEFAULT_BACKGROUND = "#ffffff";

// Module-level singleton so repeated conversions reuse the same WASM instance.
let heifLib: LibheifModule | null = null;

// Throw the canonical CANCELLED error when the caller aborts. `cleanup` runs
// first so an abort mid-flight doesn't leave WASM-heap allocations behind.
function throwIfAborted(signal: AbortSignal | undefined, cleanup?: () => void): void {
  if (signal?.aborted) {
    cleanup?.();
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// The standard MIME types a browser MIGHT report for HEIC/HEIF, including the
// "-sequence" variants used for multi-frame Live Photos / bursts.
const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

// MIME types that are NOT HEIC and must never be coaxed in by extension — if a
// browser positively identified the file as one of these, trust it over a
// possibly-misleading extension. (We only fall back to the extension when the
// browser is UNSURE, i.e. an empty or generic type.)
const NON_HEIC_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "image/avif",
]);

function hasHeicExtension(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "heic" || ext === "heif";
}

// Whether to treat a dropped file as HEIC. The real-world problem: only Apple
// platforms (Safari) report a HEIC photo as "image/heic". Chrome, Firefox, and
// most Windows/Android browsers don't recognise the format and hand us either an
// EMPTY type ("") or a GENERIC one ("application/octet-stream") — so a strict
// `type === "image/heic"` gate rejects perfectly valid .heic files the user knows
// are fine. We therefore accept on any of:
//   1. a known HEIC MIME type (Safari, or a browser that does map it), OR
//   2. a .heic/.heif extension WHEN the browser is unsure of the type — empty,
//      or a generic non-image type — and has NOT positively called it some other
//      image format. This keeps a real .png (which the browser DOES identify)
//      from sneaking in just because someone renamed it .heic.
function isHeicFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (HEIC_MIME_TYPES.has(type)) return true;
  if (NON_HEIC_IMAGE_TYPES.has(type)) return false;
  // Empty or generic/unknown type: defer to the extension.
  return hasHeicExtension(file.name);
}

// Choose the primary frame, tolerating libheif-js's is_primary() throwing under
// strict-mode bundles (see the long note at the call site). Any throw — or no
// frame reporting itself primary — falls back to the first decoded image.
function pickPrimary(images: HeifImage[]): HeifImage {
  for (const img of images) {
    try {
      if (img.is_primary()) return img;
    } catch {
      // is_primary() unavailable in this environment — stop probing and use the
      // first frame, which is the primary for virtually all real-world files.
      break;
    }
  }
  return images[0];
}

// Promisified canvas.toBlob. A null result (encoder refused) is recoverable —
// usually a transient memory pressure event — so the UI offers a retry.
function encode(canvas: HTMLCanvasElement, quality: number = DEFAULT_QUALITY): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else
          reject(
            new ConversionError("We couldn't finish encoding this image.", {
              code: "ENCODE_FAILED",
              recoverable: true,
              technical: "canvas.toBlob returned null for image/jpeg.",
            }),
          );
      },
      "image/jpeg",
      quality,
    );
  });
}

async function convertHeicToJpg(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isHeicFile(file)) {
    throw new ConversionError("This doesn't look like a HEIC or HEIF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected image/heic or image/heif, received "${file.type || "unknown type"}".`,
    });
  }

  const quality =
    typeof options?.quality === "number" ? options.quality : DEFAULT_QUALITY;
  const background =
    typeof options?.background === "string" ? options.background : DEFAULT_BACKGROUND;

  if (!heifLib) {
    throw new ConversionError("The HEIC decoder is not ready yet.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: "loadEngine must be called before convert.",
    });
  }

  onProgress?.({ stage: "Decoding" });

  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);

  let images: HeifImage[] = [];
  try {
    const decoder = new heifLib.HeifDecoder();
    images = decoder.decode(new Uint8Array(arrayBuffer));
  } catch (err) {
    throw new ConversionError(
      "We couldn't read this image — the file may be damaged or not a valid HEIC file.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (!images || images.length === 0) {
    throw new ConversionError(
      "We couldn't read this image — the file may be damaged or not a valid HEIC file.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: "libheif returned no images from the file.",
      },
    );
  }

  throwIfAborted(signal, () => {
    // Release all decoded image handles before throwing so we don't leak
    // WASM-heap allocations on cancellation mid-flight.
    for (const img of images) {
      try { img.free(); } catch { /* ignore */ }
    }
  });

  // Pick the primary image (the one marked is_primary, or fall back to the
  // first). HEIC bursts and portrait-mode files can embed multiple frames.
  //
  // IMPORTANT: libheif-js's HeifImage.is_primary() calls an UNQUALIFIED global
  // `heif_image_handle_is_primary_image(...)` (a packaging slip — every sibling
  // method uses the module-qualified form). That bare reference only resolves in
  // a non-strict CommonJS context; under a strict-mode bundle (the app's
  // webpack/turbopack output, and ESM generally) it throws a ReferenceError,
  // which would otherwise blow up the whole conversion before a single pixel is
  // decoded. We therefore call is_primary() defensively and simply fall back to
  // the first frame when it is unavailable — the first top-level image is the
  // primary for the overwhelming majority of real Apple photos.
  const primaryImage = pickPrimary(images);
  const otherImages = images.filter((img) => img !== primaryImage);

  const width = primaryImage.get_width();
  const height = primaryImage.get_height();

  onProgress?.({ stage: "Rendering" });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    // Free handles before throwing — canvas failure is non-recoverable here.
    for (const img of images) {
      try { img.free(); } catch { /* ignore */ }
    }
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }

  // Fill the background before painting the HEIC pixels. JPG has no alpha
  // channel; any transparent regions in the HEIC would otherwise appear as
  // black (the Canvas default). White matches the libheif-js browser example.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // libheif writes RGBA pixels into the ImageData buffer synchronously.
  // We wrap the callback in a Promise so the rest of the pipeline can be async.
  const imageData = ctx.createImageData(width, height);
  await new Promise<void>((resolve, reject) => {
    primaryImage.display(imageData, (displayData) => {
      if (!displayData) {
        reject(
          new ConversionError(
            "We couldn't decode the pixel data from this HEIC file.",
            {
              code: "DECODE_FAILED",
              recoverable: false,
              technical: "libheif display() returned null displayData.",
            },
          ),
        );
      } else {
        resolve();
      }
    });
  }).finally(() => {
    // Release the primary image handle as soon as pixel data has been
    // extracted — or immediately on failure. libheif allocates HEVC frame
    // buffers on the Emscripten heap; explicit free() prevents heap exhaustion
    // when processing batches of large Apple photos.
    try { primaryImage.free(); } catch { /* ignore */ }
    // Release non-primary images that we decoded but didn't use.
    for (const img of otherImages) {
      try { img.free(); } catch { /* ignore */ }
    }
  });

  ctx.putImageData(imageData, 0, 0);

  throwIfAborted(signal);

  onProgress?.({ stage: "Encoding" });
  const blob = await encode(canvas, quality);

  return {
    blob,
    filename: replaceExtension(file.name, "jpg"),
    mimeType: "image/jpeg",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Pick the object that actually carries HeifDecoder out of whatever shape the
// dynamic import returned. Order matters: the raw namespace first (bundlers that
// hoist named exports), then `.default` (Node/webpack synthetic default for a
// CJS module), then a doubly-wrapped `.default.default` seen with some interop
// layers. Throws a clear error if none expose the binding so a future libheif-js
// packaging change surfaces as ENGINE_LOAD_FAILED rather than a vague
// "HeifDecoder is not a constructor" deep in convert().
function resolveLibheif(mod: unknown): LibheifModule {
  const candidates: unknown[] = [
    mod,
    (mod as { default?: unknown })?.default,
    (mod as { default?: { default?: unknown } })?.default?.default,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof (candidate as { HeifDecoder?: unknown }).HeifDecoder === "function"
    ) {
      return candidate as LibheifModule;
    }
  }
  throw new Error("libheif-js loaded but no HeifDecoder constructor was found on the module.");
}

// loadEngine runs once before the first conversion. Dynamically importing
// libheif-js here (rather than at module load time) ensures the ~1 MB WASM
// bundle is NOT included in the homepage/shared chunk — it lands only in the
// /heic-to-jpg route chunk. /check-bundle verifies this at build time.
async function loadEngine(): Promise<void> {
  if (heifLib) return; // already loaded
  // `wasm-bundle` variant embeds the WASM as a base64 data URI so the browser
  // never needs to fetch a separate .wasm file — one round trip, works behind
  // any CDN with no CORS configuration needed.
  try {
    // @ts-expect-error — libheif-js/wasm-bundle ships no .d.ts; the module is
    // typed via the local ambient declaration in heic-jpg.d.ts (see the
    // brief's "minimal local type" instruction). The @ts-expect-error silences
    // the TypeScript "no declaration file" error without adding a package.json dep.
    const mod = await import("libheif-js/wasm-bundle");
    // libheif-js's entry is `module.exports = require('…')()` — it CALLS its
    // factory at import time and exports the already-initialised module (the one
    // carrying HeifDecoder). It is NOT a factory we call ourselves. How that
    // object surfaces depends on the bundler's CJS↔ESM interop: it may be the
    // namespace itself, or live under `.default` (Node/webpack synthetic default).
    // Probe the likely shapes and pick whichever actually exposes HeifDecoder, so
    // the same code works under Node's test interop and the app's bundler.
    heifLib = resolveLibheif(mod);
  } catch (err) {
    throw new ConversionError("Failed to load the HEIC decoder.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

export const heicJpgDescriptor: ConversionDescriptor = {
  id: "heic-to-jpg",
  fromLabel: "HEIC",
  toLabel: "JPG",
  // Standard MIME types for HEIC/HEIF. Browsers on non-Apple platforms often
  // report "" for these files; the isHeicFile() helper handles that case.
  accept: ["image/heic", "image/heif"],
  newExtension: "jpg",
  defaultOptions: { quality: DEFAULT_QUALITY, background: DEFAULT_BACKGROUND },
  loadEngine,
  // The libheif-js WASM (~1.5 MB) is the one-time download shown in the setup
  // state while loadEngine runs.
  setupSizeLabel: "≈ 1.5 MB",
  convert: convertHeicToJpg,
};
