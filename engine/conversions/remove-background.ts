// Background removal — on-device AI portrait matting. Unlike every other tool in
// this engine, this one runs a neural network: MODNet (a trimap-free portrait
// matting model) exported to ONNX, executed with onnxruntime-web's WASM backend.
// It produces an alpha matte that we composite onto the original image, yielding
// a transparent-background PNG cutout.
//
// PRIVACY / SELF-HOSTING (decision 0010):
//   - The ONNX runtime (ort.env.wasm.wasmPaths = "/ort/") and the model
//     (/models/modnet.onnx) are BOTH served from our own origin — never a CDN.
//     scripts/copy-ort-runtime.mjs and scripts/fetch-bg-model.mjs put them under
//     public/ at build time (SHA-256-pinned model). The image never leaves the
//     device; inference happens entirely in the browser.
//   - SINGLE-THREADED: ort.env.wasm.numThreads = 1, no proxy, no threads. That
//     means no SharedArrayBuffer, so this route needs NO COOP/COEP headers and
//     stays ad-compatible (same stance as audio in decision 0009 §3). Do NOT add
//     /remove-background to public/_headers.
//
// MODEL I/O (Xenova/modnet onnx/model.onnx, Apache-2.0):
//   input  "input"  : Float32 NCHW [1, 3, H, W], normalized to [-1, 1]
//                     ((pixel/255) - 0.5) / 0.5, where H/W are multiples of 32.
//   output "output" : Float32      [1, 1, H, W], the alpha matte in [0, 1].
//   We run at a fixed 512×512 (MODNet's canonical size, a multiple of 32). To keep
//   the subject's true proportions, the source is LETTERBOXED (contain + centered
//   on a neutral fill) into that square rather than squash-stretched; the matte is
//   then cropped back through the SAME letterbox transform and bilinearly upscaled
//   to the original dimensions for compositing.
//
// Engine firewall: this file imports ONLY onnxruntime-web (node_modules) and the
// sibling types/filename modules. It never reaches into app/components/lib.

import type { InferenceSession, Tensor } from "onnxruntime-web";
import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { decode } from "./canvas";
import { RASTER_IMAGE_ACCEPT as ACCEPT } from "./mime";

// MODNet expects a square-ish input whose dimensions are multiples of 32. 512 is
// the canonical size used by the reference implementation and balances quality
// against the single-threaded WASM cost.
const MODEL_SIDE = 512;

// Where the build scripts place the self-hosted runtime + model.
const ORT_WASM_PATH = "/ort/";
const MODEL_URL = "/models/modnet.onnx";

// The model's graph I/O names (confirmed from the ONNX graph).
const INPUT_NAME = "input";
const OUTPUT_NAME = "output";

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a JPG, PNG, or WebP image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else
        reject(
          new ConversionError("We couldn't finish encoding the cutout.", {
            code: "ENCODE_FAILED",
            recoverable: true,
            technical: "canvas.toBlob returned null for image/png.",
          }),
        );
    }, "image/png");
  });
}

// ── Model singleton ─────────────────────────────────────────────────────────
//
// One InferenceSession, created at most once, shared by every conversion. The
// promise-ref pattern (mirroring loadFFmpeg in ffmpeg-core.ts) coalesces
// concurrent first-loads onto a single session creation; a failed load clears
// the cached promise so a later retry starts fresh.

let session: InferenceSession | null = null;
let sessionPromise: Promise<InferenceSession> | null = null;

async function createSession(): Promise<InferenceSession> {
  // Lazy import so onnxruntime-web lands only in the /remove-background route
  // chunk, never the homepage/shared bundle. Use the WASM-only entry point.
  const ort = await import("onnxruntime-web/wasm");

  // Self-host + single-thread. wasmPaths points at the files copied into
  // public/ort/; numThreads=1 keeps us off SharedArrayBuffer (no COOP/COEP).
  ort.env.wasm.wasmPaths = ORT_WASM_PATH;
  ort.env.wasm.numThreads = 1;
  // Belt-and-braces: never spin up the proxy worker (would pull a worker file
  // and, for threads, SharedArrayBuffer).
  ort.env.wasm.proxy = false;

  return ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
}

/**
 * Load (or reuse) the cached MODNet inference session.
 * - First call creates the session and caches the promise.
 * - Concurrent callers share that in-flight promise (no double-load).
 * - On failure the cached promise is cleared and a recoverable
 *   ENGINE_LOAD_FAILED ConversionError is thrown.
 */
async function loadModel(): Promise<InferenceSession> {
  if (session) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = createSession()
    .then((s) => {
      session = s;
      return s;
    })
    .catch((err) => {
      sessionPromise = null;
      throw new ConversionError("Failed to load the background-removal model.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      });
    });

  return sessionPromise;
}

// ── Letterbox geometry ───────────────────────────────────────────────────────
//
// Where the original image lands inside the square MODEL_SIDE canvas once it's
// drawn "contain" (whole subject visible, aspect ratio preserved) and centered.
// The leftover margin on the short axis is neutral padding the model sees but the
// composite step crops back off. `drawW`/`drawH` are the scaled image size in
// model pixels; `offsetX`/`offsetY` are the top-left of that drawn region.
interface Letterbox {
  drawW: number;
  drawH: number;
  offsetX: number;
  offsetY: number;
}

// Fit (ow×oh) inside MODEL_SIDE×MODEL_SIDE with "contain", centered. floor() keeps
// the drawn box inside the canvas; the result is reused VERBATIM by both the
// pre-processing draw and the matte crop so the two transforms stay in lockstep.
// Exported for unit tests (pure, DOM-free): this geometry is what makes the
// non-square quality fix correct, so its contain-fit math is worth pinning down.
export function computeLetterbox(ow: number, oh: number): Letterbox {
  const scale = Math.min(MODEL_SIDE / ow, MODEL_SIDE / oh);
  const drawW = Math.max(1, Math.floor(ow * scale));
  const drawH = Math.max(1, Math.floor(oh * scale));
  const offsetX = Math.floor((MODEL_SIDE - drawW) / 2);
  const offsetY = Math.floor((MODEL_SIDE - drawH) / 2);
  return { drawW, drawH, offsetX, offsetY };
}

// Draw the bitmap LETTERBOXED into a square MODEL_SIDE canvas and read back RGBA
// pixels. The image is contained (aspect ratio preserved) and centered on a
// neutral mid-grey fill; squash-stretching a non-square photo to the square would
// distort the subject and badly hurt the matte. The neutral fill is what the model
// sees in the padding bands — the composite step crops those bands away via the
// same `box`, so they never reach the output.
function rgbaForModel(bitmap: ImageBitmap, box: Letterbox): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_SIDE;
  canvas.height = MODEL_SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  // Neutral mid-grey ground under the contained image, so the padding bands are a
  // flat, subject-free region rather than transparent black (which can bias the
  // matte at the image edges). High-quality scaling for the contain draw.
  ctx.fillStyle = "rgb(128, 128, 128)";
  ctx.fillRect(0, 0, MODEL_SIDE, MODEL_SIDE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, box.offsetX, box.offsetY, box.drawW, box.drawH);
  return ctx.getImageData(0, 0, MODEL_SIDE, MODEL_SIDE).data;
}

// Build the normalized NCHW Float32 tensor from MODEL_SIDE×MODEL_SIDE RGBA data.
// Normalization: ((pixel/255) - 0.5) / 0.5  ==  pixel/127.5 - 1  →  range [-1, 1].
async function buildInputTensor(rgba: Uint8ClampedArray, ort: typeof import("onnxruntime-web")): Promise<Tensor> {
  const side = MODEL_SIDE;
  const area = side * side;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    // NCHW: all R, then all G, then all B (channel-planar).
    data[i] = r / 127.5 - 1;
    data[area + i] = g / 127.5 - 1;
    data[2 * area + i] = b / 127.5 - 1;
  }
  return new ort.Tensor("float32", data, [1, 3, side, side]);
}

// Composite the alpha matte onto the original image at full resolution. The
// matte arrives as a MODEL_SIDE×MODEL_SIDE single-channel buffer in [0, 1], but
// the subject only occupies the LETTERBOXED region of that square (the rest is
// the neutral padding the model saw). We paint the full matte, then crop the
// `box` region back out and bilinearly upscale just that region to the original
// dimensions — the inverse of the pre-processing letterbox, so the padding bands
// never reach the output — and multiply the result into the original image's
// alpha channel. Returns a PNG blob.
async function compositeCutout(
  bitmap: ImageBitmap,
  matte: Float32Array,
  box: Letterbox,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  const ow = bitmap.width;
  const oh = bitmap.height;

  // 1) Paint the model-resolution matte into a grayscale canvas so the browser
  //    can bilinearly upscale it to the original dimensions for us.
  const matteCanvas = document.createElement("canvas");
  matteCanvas.width = MODEL_SIDE;
  matteCanvas.height = MODEL_SIDE;
  const mctx = matteCanvas.getContext("2d");
  if (!mctx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null (matte).",
    });
  }
  const matteImage = mctx.createImageData(MODEL_SIDE, MODEL_SIDE);
  for (let i = 0; i < MODEL_SIDE * MODEL_SIDE; i++) {
    // Clamp defensively — model output can drift slightly outside [0, 1].
    const a = Math.max(0, Math.min(1, matte[i]));
    const v = Math.round(a * 255);
    matteImage.data[i * 4] = v;
    matteImage.data[i * 4 + 1] = v;
    matteImage.data[i * 4 + 2] = v;
    matteImage.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(matteImage, 0, 0);

  throwIfAborted(signal);

  // 2) Crop the letterboxed region out of the square matte and upscale just
  //    that region to the original size — the inverse of the pre-processing
  //    letterbox. drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh): take the
  //    `box` rectangle (where the subject was drawn) from the matte canvas and
  //    map it onto the full output canvas, so the neutral padding bands are
  //    discarded and the matte lines up 1:1 with the original pixels.
  const upCanvas = document.createElement("canvas");
  upCanvas.width = ow;
  upCanvas.height = oh;
  const upctx = upCanvas.getContext("2d");
  if (!upctx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null (upscale).",
    });
  }
  upctx.imageSmoothingEnabled = true;
  upctx.imageSmoothingQuality = "high";
  upctx.drawImage(
    matteCanvas,
    box.offsetX,
    box.offsetY,
    box.drawW,
    box.drawH,
    0,
    0,
    ow,
    oh,
  );
  const upMatte = upctx.getImageData(0, 0, ow, oh).data;

  // 3) Paint the original image at full resolution and apply the matte alpha.
  const outCanvas = document.createElement("canvas");
  outCanvas.width = ow;
  outCanvas.height = oh;
  const octx = outCanvas.getContext("2d");
  if (!octx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null (output).",
    });
  }
  octx.drawImage(bitmap, 0, 0, ow, oh);
  const out = octx.getImageData(0, 0, ow, oh);
  const px = out.data;
  for (let i = 0; i < ow * oh; i++) {
    // Replace the alpha channel with the matte's red channel (grayscale).
    px[i * 4 + 3] = upMatte[i * 4];
  }
  octx.putImageData(out, 0, 0);

  throwIfAborted(signal);
  return encodePng(outCanvas);
}

async function convertRemoveBackground(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  onProgress?.({ stage: "Loading model" });
  const sess = await loadModel();
  throwIfAborted(signal);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  // Where the contained image lands inside the square model canvas. Computed
  // ONCE and reused VERBATIM by both the pre-processing draw (rgbaForModel) and
  // the matte crop (compositeCutout) so the forward letterbox and its inverse
  // stay in exact lockstep — the padding the model saw is cropped back off.
  const box = computeLetterbox(bitmap.width, bitmap.height);

  let matte: Float32Array;
  try {
    onProgress?.({ stage: "Preparing" });
    const rgba = rgbaForModel(bitmap, box);
    throwIfAborted(signal, () => bitmap.close());

    const ort = await import("onnxruntime-web/wasm");
    const inputTensor = await buildInputTensor(rgba, ort);

    onProgress?.({ stage: "Removing background" });
    const outputs = await sess.run({ [INPUT_NAME]: inputTensor });
    const matteTensor = outputs[OUTPUT_NAME];
    if (!matteTensor || !(matteTensor.data instanceof Float32Array)) {
      throw new ConversionError("The model returned an unexpected result.", {
        code: "INFERENCE_FAILED",
        recoverable: true,
        technical: `Missing or non-float32 "${OUTPUT_NAME}" output.`,
      });
    }
    matte = matteTensor.data;
  } catch (err) {
    bitmap.close();
    if (err instanceof ConversionError) throw err;
    throw new ConversionError("We couldn't process this image.", {
      code: "INFERENCE_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Compositing" });
  let blob: Blob;
  try {
    blob = await compositeCutout(bitmap, matte, box, signal);
  } finally {
    bitmap.close();
  }

  return {
    blob,
    filename: replaceExtension(file.name, "png"),
    mimeType: "image/png",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Warm the model so the shared ConversionTool shows the "Setting up the
// converter…" state during the one-time download instead of stalling on the
// first drop. Errors here surface as ENGINE_LOAD_FAILED (see loadModel).
async function loadEngine(): Promise<void> {
  await loadModel();
}

export const removeBackgroundDescriptor: ConversionDescriptor = {
  id: "remove-background",
  fromLabel: "Image",
  toLabel: "Cutout PNG",
  accept: ["image/jpeg", "image/png", "image/webp"],
  newExtension: "png",
  loadEngine,
  // The MODNet model (~25 MB) plus the ORT WASM runtime (~13 MB) are the
  // one-time download shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 38 MB",
  convert: convertRemoveBackground,
};
