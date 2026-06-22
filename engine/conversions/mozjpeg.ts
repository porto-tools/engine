// Self-hosted MozJPEG encoder loader (decision 0015). Lazy + memoised: only
// loaded when compress-image needs progressive / 4:4:4 chroma on a JPEG output.
// Keeping it out of the default Canvas path preserves /compress-image's
// instant-start (no wasm download) for the common case.
import { ConversionError } from "../types";

// The wasm is self-hosted into public/mozjpeg/ by scripts/copy-mozjpeg-runtime.mjs
// (wired into prebuild/predev). The loader fetches it and hands the compiled
// Module to @jsquash/jpeg's init(), bypassing the Emscripten glue's CDN auto-locate.
const MOZJPEG_WASM_URL = "/mozjpeg/mozjpeg_enc.wasm";

// MozJpegColorSpace: GRAYSCALE = 1, RGB = 2, YCbCr = 3 (from the codec types).
export interface MozjpegEncodeOptions {
  quality: number;
  baseline: boolean;
  progressive: boolean;
  auto_subsample: boolean;
  chroma_subsample: number;
  color_space: number;
}

// PURE function — unit-tested without the wasm (this is the CI coverage for the
// runtime args, which are otherwise browser-only). Mirrors the buildAudioArgs
// pattern used for ffmpeg.
export function buildMozjpegOptions(
  quality: number,
  opts: { progressive: boolean; chroma: "4:2:0" | "4:4:4"; grayscale: boolean },
): MozjpegEncodeOptions {
  return {
    quality,
    baseline: false,
    progressive: opts.progressive,
    auto_subsample: false,
    chroma_subsample: opts.chroma === "4:4:4" ? 1 : 2,
    color_space: opts.grayscale ? 1 /* GRAYSCALE */ : 3 /* YCbCr */,
  };
}

let encodePromise: Promise<(data: ImageData, options: MozjpegEncodeOptions) => Promise<ArrayBuffer>> | null = null;

async function loadEncoder() {
  const mod = await import("@jsquash/jpeg/encode"); // { default: encode, init }
  const resp = await fetch(MOZJPEG_WASM_URL);
  if (!resp.ok) throw new Error(`fetch ${MOZJPEG_WASM_URL} -> ${resp.status}`);
  const wasmModule = await WebAssembly.compile(await resp.arrayBuffer());
  // The runtime init(module, …) accepts a pre-compiled WebAssembly.Module as its
  // first arg (Squoosh's self-host pattern — see encode.js: it branches on
  // `module instanceof WebAssembly.Module`), but the shipped .d.ts only types the
  // single-arg moduleOptionOverrides form. Pass the compiled module so nothing is
  // fetched from a CDN; cast to bypass the narrower published signature.
  await (mod.init as (module: WebAssembly.Module) => Promise<void>)(wasmModule);
  return mod.default as (data: ImageData, options: MozjpegEncodeOptions) => Promise<ArrayBuffer>;
}

export async function encodeJpegMozjpeg(
  imageData: ImageData,
  options: MozjpegEncodeOptions,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  if (!encodePromise) encodePromise = loadEncoder();
  let encode: (data: ImageData, options: MozjpegEncodeOptions) => Promise<ArrayBuffer>;
  try {
    encode = await encodePromise;
  } catch (err) {
    encodePromise = null; // allow retry on a later run
    throw new ConversionError("Failed to load the JPEG encoder.", {
      code: "ENGINE_LOAD_FAILED", // same code heic-jpg.ts uses for a failed engine load
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
  if (signal?.aborted) throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  const buf = await encode(imageData, options);
  return new Blob([buf], { type: "image/jpeg" });
}
