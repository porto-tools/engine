// Universal image converter — the flagship MANY-OUT image tool. The user drops
// ANY common raster image, ticks SEVERAL output formats at once (PNG / JPG /
// WEBP, with BMP as an optional fourth), and gets ALL of those encodings back
// together (per-file download + "Download all as .zip"). This is the product's
// north-star differentiator: neither FreeConvert nor iLoveIMG lets you pick
// multiple output formats in a single pass.
//
// Like the other Canvas tools (PNG↔JPG, image-resize, image-flip) it runs on the
// browser's built-in Canvas — `createImageBitmap` to decode, `canvas.toBlob` to
// encode each format — so there is no WASM to download and no `loadEngine`.
//
// One INPUT image is decoded ONCE and drawn to ONE canvas; each selected format
// is then a separate `canvas.toBlob(mime, qualityIfLossy)`. Quality (a percent,
// default 92) is applied ONLY to the lossy encoders (JPG/WEBP); PNG and BMP are
// lossless and ignore it. JPG has no alpha channel, so transparent source pixels
// are composited over a solid background colour (default white) before the JPG
// encode — otherwise transparent regions render as black.
//
// FORMAT PICKER: a single `toggle-group` control (id "formats") with one toggle
// per format. Each toggle fans out to a flat boolean key `formats<ID>`
// (options.formatsPNG / formatsJPG / formatsWEBP / formatsBMP) — the same
// fan-out the flip tool uses — so several formats can be on at once. We read
// those keys defensively (a key counts as "on" only when strictly true) because
// options arrive from the UI and must never be trusted.
//
// FUTURE (documented, not blocking): HEIC / AVIF / SVG *input* decoding isn't
// covered by createImageBitmap across browsers, so those input types are left to
// a later follow-up (HEIC already has its own /heic-to-jpg route). AVIF *output*
// is feature-detected at encode time and silently skipped where the browser's
// canvas can't produce it, so it can be added to FORMATS later without a UI gate.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionOutput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { applyDpiToBlob, clampDpi } from "./dpi-patch";

// The canvas-decodable raster inputs. createImageBitmap handles each of these
// across modern browsers. (HEIC/SVG/AVIF input are a documented follow-up — see
// the file header — so they are intentionally NOT here.)
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"] as const;

// Quality control bounds (percent). Maps to canvas.toBlob's [0.1–1.0] scale via
// quality/100, mirroring image-resize / compress-image. Only consulted for lossy
// outputs (JPG/WEBP); PNG and BMP ignore it.
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

// The output formats this tool can emit. Each entry is one toggle in the picker
// AND one possible ConversionOutput. `id` is the toggle id (so its flat option
// key is `formats<id>`); `mime`/`ext` drive canvas.toBlob + the filename; `lossy`
// decides whether the quality slider applies. PNG is ticked by default.
//
// BMP is included as a clean lossless fourth: canvas.toBlob("image/bmp") is
// supported in Chromium/WebKit and feature-detected at encode time, so a browser
// that can't produce it simply skips that one output rather than failing the run.
interface OutputFormat {
  id: string; // toggle id → flat option key `formats<id>`
  label: string; // visible toggle label
  mime: string; // canvas.toBlob mime
  ext: string; // output file extension
  lossy: boolean; // quality slider applies?
}

export const OUTPUT_FORMATS: OutputFormat[] = [
  { id: "PNG", label: "PNG", mime: "image/png", ext: "png", lossy: false },
  { id: "JPG", label: "JPG", mime: "image/jpeg", ext: "jpg", lossy: true },
  { id: "WEBP", label: "WEBP", mime: "image/webp", ext: "webp", lossy: true },
  { id: "BMP", label: "BMP", mime: "image/bmp", ext: "bmp", lossy: false },
];

// MIME types that have no alpha channel and therefore need a solid background
// fill before encoding (otherwise transparent source pixels become black). Only
// JPG today; kept as a set so adding another opaque format is a one-line change.
const OPAQUE_MIMES = new Set(["image/jpeg"]);

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a PNG, JPG, WebP, GIF, or BMP image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

// Decode the file to a bitmap. `autoOrient` controls whether an EXIF orientation
// tag is honoured: "from-image" rotates/flips the pixels to upright (the consumer
// default), "none" keeps the stored pixel orientation (the historical behaviour).
async function decode(file: File, autoOrient: boolean): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, {
      imageOrientation: autoOrient ? "from-image" : "none",
    });
  } catch (err) {
    throw new ConversionError("We couldn't read this image — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

// Promisified canvas.toBlob. `quality` is undefined for lossless formats (PNG/
// BMP), so toBlob is called with NO quality argument; for lossy formats it is a
// [0.1–1.0] number. A null blob (encoder refused) is recoverable — usually a
// transient memory pinch or, for BMP/AVIF, an unsupported codec — so the caller
// decides whether to surface a retry or (for optional formats) skip it.
function encode(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (quality === undefined) canvas.toBlob((blob) => resolve(blob), mimeType);
    else canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

// Clamp the quality option (percent) into [MIN_QUALITY, MAX_QUALITY]. Non-numeric
// or missing values fall back to DEFAULT_QUALITY. Pure — unit-tested via convert.
export function clampQuality(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(n)));
}

// Resolve which output formats are ticked, reading each format's flat toggle key
// (`formats<id>`) defensively: a value counts as ON only when it is STRICTLY the
// boolean true (mirrors parseFlipAxes), so undefined / "false" / 0 are off. Pure,
// no DOM — unit-tested. The returned list preserves OUTPUT_FORMATS order so the
// outputs come back PNG, JPG, WEBP, BMP regardless of click order.
export function selectedFormats(options: Record<string, unknown> | undefined): OutputFormat[] {
  return OUTPUT_FORMATS.filter((f) => options?.[`formats${f.id}`] === true);
}

// Read the background-fill colour for opaque (JPG) output. The UI offers a small
// fixed set; we validate against it and fall back to white. Any unknown value →
// white, so a bad option can never inject an arbitrary CSS string onto the canvas.
const BACKGROUNDS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
};
const DEFAULT_BACKGROUND = "white";
export function readBackground(value: unknown): string {
  const key = typeof value === "string" ? value : DEFAULT_BACKGROUND;
  return BACKGROUNDS[key] ?? BACKGROUNDS[DEFAULT_BACKGROUND];
}

async function convertImageConverter(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  // Which formats did the user tick? Zero is a recoverable nudge, not a crash —
  // the user just needs to pick at least one before converting.
  const formats = selectedFormats(options);
  if (formats.length === 0) {
    throw new ConversionError("Pick at least one output format.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: "No format toggle was on (every options.formats<ID> was falsy).",
    });
  }

  const quality = clampQuality(options?.quality) / 100;
  const background = readBackground(options?.background);
  // autoOrient defaults to TRUE (upright phone photos is the correct consumer
  // default). Read defensively: only a literal `false` disables it.
  const autoOrient = options?.autoOrient !== false;
  // dpi 0 = leave the resolution unchanged (byte-identical default).
  const dpi = clampDpi(options?.dpi);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file, autoOrient);
  throwIfAborted(signal, () => bitmap.close());

  // Decode ONCE, draw ONCE: a single source canvas every opaque-safe format reads
  // from. (JPG needs a background fill, so it re-draws onto its own canvas below —
  // we can't mutate this shared one without corrupting the transparent formats.)
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = bitmap.width;
  sourceCanvas.height = bitmap.height;
  const sourceCtx = sourceCanvas.getContext("2d");
  if (!sourceCtx) {
    bitmap.close();
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  sourceCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
  throwIfAborted(signal);

  // A reusable opaque canvas (background fill + image) for formats without alpha
  // (JPG). Built lazily the first time an opaque format is encoded, then reused.
  let opaqueCanvas: HTMLCanvasElement | null = null;
  function getOpaqueCanvas(): HTMLCanvasElement {
    if (opaqueCanvas) return opaqueCanvas;
    const c = document.createElement("canvas");
    c.width = sourceCanvas.width;
    c.height = sourceCanvas.height;
    const ctx = c.getContext("2d");
    if (!ctx) {
      throw new ConversionError("Your browser couldn't open a drawing canvas.", {
        code: "CANVAS_UNAVAILABLE",
        recoverable: false,
        technical: "HTMLCanvasElement.getContext('2d') returned null for the opaque canvas.",
      });
    }
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(sourceCanvas, 0, 0);
    opaqueCanvas = c;
    return c;
  }

  const outputs: ConversionOutput[] = [];
  const total = formats.length;
  for (let i = 0; i < total; i++) {
    const fmt = formats[i];
    throwIfAborted(signal);
    onProgress?.({ stage: `Encoding ${fmt.label}`, ratio: i / total });

    const canvas = OPAQUE_MIMES.has(fmt.mime) ? getOpaqueCanvas() : sourceCanvas;
    const encoded = await encode(canvas, fmt.mime, fmt.lossy ? quality : undefined);

    // A null blob means the browser's canvas can't produce this MIME. PNG/JPG/
    // WEBP are universally supported, so a null there is a real encode failure
    // worth surfacing (recoverable). BMP/AVIF are best-effort — if unsupported we
    // silently skip that one output rather than failing the whole run.
    if (!encoded) {
      if (fmt.id === "BMP" || fmt.id === "AVIF") continue;
      throw new ConversionError(`We couldn't encode the ${fmt.label} output.`, {
        code: "ENCODE_FAILED",
        recoverable: true,
        technical: `canvas.toBlob returned null for ${fmt.mime}.`,
      });
    }

    // Stamp the requested DPI into the container (JPG→JFIF, PNG→pHYs; WebP/BMP
    // unchanged). A dpi of 0 returns the blob untouched, so the default is
    // byte-identical to before.
    const blob = await applyDpiToBlob(encoded, fmt.mime, dpi);

    outputs.push({
      blob,
      // Each output differs only by extension, so filenames never collide inside
      // the zip (which keys by filename). replaceExtension swaps the input's
      // extension for this format's — no suffix, no site name, no counter.
      filename: replaceExtension(file.name, fmt.ext),
      mimeType: fmt.mime,
      size: blob.size,
    });
  }

  throwIfAborted(signal);

  // Every selected format was optional-and-unsupported (e.g. BMP-only on a
  // browser without BMP encoding). Treat it as a recoverable nudge to pick a
  // format this browser can produce, rather than returning an empty result that
  // would crash outputs[0] below.
  if (outputs.length === 0) {
    throw new ConversionError(
      "Your browser couldn't produce any of the selected formats. Try PNG, JPG, or WebP.",
      {
        code: "ENCODE_FAILED",
        recoverable: true,
        technical: "All selected formats returned a null blob (unsupported codecs).",
      },
    );
  }

  onProgress?.({ stage: "Done", ratio: 1 });

  const outputSize = outputs.reduce((sum, o) => sum + o.size, 0);
  // The representative single fields point at the first output so any
  // single-output consumer still sees a valid result; `outputs` drives the
  // many-out MultiResultCard. Mirrors pdf-image.ts.
  const first = outputs[0];
  return {
    blob: first.blob,
    filename: first.filename,
    mimeType: first.mimeType,
    inputSize: file.size,
    outputSize,
    outputs,
  };
}

export const imageConverterDescriptor: ConversionDescriptor = {
  id: "image-converter",
  fromLabel: "Image",
  toLabel: "Image",
  accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"],
  // Representative extension for the single-result fallback; convert() emits one
  // ConversionOutput per ticked format, each with its own extension.
  newExtension: "png",
  outputMode: "multi",
  // PNG ticked by default so a Convert click always produces at least one file.
  // The quality + background defaults seed the lossy encoders.
  defaultOptions: {
    formatsPNG: true,
    formatsJPG: false,
    formatsWEBP: false,
    formatsBMP: false,
    quality: DEFAULT_QUALITY,
    background: DEFAULT_BACKGROUND,
    // Auto-orient ON by default (upright phone photos); DPI 0 = unchanged.
    autoOrient: true,
    dpi: 0,
  },
  controls: [
    // ONE toggle-group with one INDEPENDENT toggle per output format — several can
    // be on at once. Each fans out to a flat boolean key `formats<id>`
    // (options.formatsPNG / formatsJPG / formatsWEBP / formatsBMP), read by
    // selectedFormats above. No previewTransform: the picture isn't transformed,
    // only re-encoded, so the panel shows plain toggle buttons.
    {
      type: "toggle-group",
      id: "formats",
      label: "Convert to",
      help: "Tick every format you want — they're all produced at once. PNG and BMP are lossless; JPG and WebP use the quality slider.",
      toggles: OUTPUT_FORMATS.map((f) => ({ id: f.id, label: f.label })),
    },
    {
      type: "range",
      id: "quality",
      label: "Quality",
      help: "Only used for JPG and WebP output. Lower quality means a smaller file with more visible artefacts.",
      default: DEFAULT_QUALITY,
      min: MIN_QUALITY,
      max: MAX_QUALITY,
      step: 1,
      unit: "%",
    },
    {
      type: "select",
      id: "background",
      label: "Background (for JPG)",
      help: "JPG has no transparency. Transparent areas of the source are filled with this colour in the JPG output.",
      default: DEFAULT_BACKGROUND,
      options: [
        { value: "white", label: "White" },
        { value: "black", label: "Black" },
      ],
    },
    {
      type: "checkbox",
      id: "autoOrient",
      label: "Auto-orient",
      help: "Rotate photos upright using the camera's orientation tag (EXIF). On by default — turn off to keep the stored pixel orientation.",
      default: true,
    },
    {
      type: "number",
      id: "dpi",
      label: "Print resolution (DPI)",
      help: "Stamp a print resolution into the output. Leave at 0 to keep the file unchanged. Applies to JPG and PNG only; WebP has no DPI field.",
      default: 0,
      min: 0,
      max: 1200,
      step: 1,
      unit: "DPI",
    },
  ],
  convert: convertImageConverter,
};
