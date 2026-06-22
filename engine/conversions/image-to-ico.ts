// Image to ICO — converts a raster image into a multi-resolution .ico file
// (the format used for Windows icons and classic /favicon.ico).
//
// An ICO is a CONTAINER: one file holding the SAME picture rendered at several
// pixel sizes, so the browser/OS can pick the crispest one for each context
// (16px in a browser tab, 32px on a taskbar, 256px for a large desktop icon).
// We render each requested size on its own canvas and embed it as a PNG payload.
//
// ICO byte layout (little-endian throughout):
//   ICONDIR (6 bytes):  reserved(2)=0 | type(2)=1 | count(2)
//   ICONDIRENTRY (16 bytes) × count:
//     width(1)      — 0 means 256
//     height(1)     — 0 means 256
//     colorCount(1) — 0 for PNG/true-colour payloads
//     reserved(1)   — 0
//     planes(2)     — 1
//     bitCount(2)   — 32 (RGBA, so transparency is preserved)
//     bytesInRes(4) — PNG payload byte length
//     imageOffset(4)— offset from the start of the file to the PNG data
//   PNG payloads, verbatim, in the same order as the entries.
//
// Embedding PNG payloads (rather than the legacy uncompressed BMP "DIB" form) is
// the modern approach: it keeps large entries (esp. 256×256) small and is the
// only way the spec carries 256px at all. It was formalised by Microsoft in
// Windows Vista and is understood by every current browser and OS.
//
// Quality notes vs. a naive converter:
//   • each size renders from the ORIGINAL bitmap (not downscaled-from-downscaled),
//     with high-quality smoothing, so small sizes stay sharp;
//   • non-square inputs are fit INTO the square icon box preserving aspect ratio
//     and centred on a transparent background — no stretching, no cropping.
//
// Sizes are chosen by the caller as a comma-separated list in `options.icoSizes`
// (the on-page tool renders size checkboxes). Only the standard icon sizes are
// allowed; anything else is filtered out, and an empty selection falls back to
// the common favicon set.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { decode } from "./canvas";

const ACCEPT = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const ICONDIR_SIZE = 6; // bytes
const ICONDIRENTRY_SIZE = 16; // bytes per entry

// The standard ICO icon sizes we offer. 24 is included for Windows shortcut
// icons; 256 is the largest the format addresses (encoded as 0 in the 1-byte
// dimension fields). Exported so the on-page tool renders exactly these choices.
export const SUPPORTED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

// The default selection: the classic favicon trio, which covers browser tabs,
// bookmarks, and most OS surfaces without bloating the file.
export const DEFAULT_ICO_SIZES = [16, 32, 48] as const;
const DEFAULT_ICO_SIZES_STRING = DEFAULT_ICO_SIZES.join(",");

const SUPPORTED_SET = new Set<number>(SUPPORTED_ICO_SIZES);

function assertSupported(file: File): void {
  if (!ACCEPT.includes(file.type as (typeof ACCEPT)[number])) {
    throw new ConversionError("This doesn't look like a JPG, PNG, WebP, or GIF image.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${ACCEPT.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

// Render the bitmap into a `size`×`size` PNG, preserving aspect ratio on a
// transparent background (letterboxed/pillarboxed, centred). Returns PNG bytes.
function renderToPng(bitmap: ImageBitmap, size: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(
        new ConversionError("Your browser couldn't open a drawing canvas.", {
          code: "CANVAS_UNAVAILABLE",
          recoverable: false,
          technical: "HTMLCanvasElement.getContext('2d') returned null.",
        }),
      );
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Fit the source inside the square box without distortion. A square source
    // fills the box exactly; a wide/tall source is centred with transparent bars,
    // so the icon keeps the image's true proportions and its alpha channel.
    const scale = Math.min(size / bitmap.width, size / bitmap.height);
    const drawW = Math.max(1, Math.round(bitmap.width * scale));
    const drawH = Math.max(1, Math.round(bitmap.height * scale));
    const dx = Math.round((size - drawW) / 2);
    const dy = Math.round((size - drawH) / 2);
    ctx.drawImage(bitmap, dx, dy, drawW, drawH);

    canvas.toBlob((blob) => {
      if (!blob) {
        reject(
          new ConversionError("We couldn't finish encoding this image.", {
            code: "ENCODE_FAILED",
            recoverable: true,
            technical: `canvas.toBlob returned null at size ${size}.`,
          }),
        );
        return;
      }
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, "image/png");
  });
}

// Exported for unit tests — pure, no DOM. Parses the comma-separated `icoSizes`
// option into a sorted, de-duplicated list restricted to SUPPORTED_ICO_SIZES.
// Falls back to the default favicon set when nothing valid is supplied.
export function parseSizes(value: unknown): number[] {
  const raw = typeof value === "string" ? value : DEFAULT_ICO_SIZES_STRING;
  const sizes = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && SUPPORTED_SET.has(n));
  if (sizes.length === 0) return [...DEFAULT_ICO_SIZES];
  return [...new Set(sizes)].sort((a, b) => a - b);
}

// Build the ICO binary from an array of { size, png } pairs.
// Layout: ICONDIR + N×ICONDIRENTRY + N×PNG_bytes (see the file header).
export function buildIco(frames: { size: number; png: Uint8Array }[]): Uint8Array {
  const count = frames.length;
  // Data section starts right after the directory.
  const dataOffset = ICONDIR_SIZE + count * ICONDIRENTRY_SIZE;

  // Compute each frame's offset within the file.
  const offsets: number[] = [];
  let cursor = dataOffset;
  for (const f of frames) {
    offsets.push(cursor);
    cursor += f.png.byteLength;
  }

  const totalSize = cursor;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // ── ICONDIR ──────────────────────────────────────────────────────────────
  view.setUint16(0, 0, true); // reserved = 0
  view.setUint16(2, 1, true); // type = 1 (icon, not cursor)
  view.setUint16(4, count, true); // count

  // ── ICONDIRENTRY × count ─────────────────────────────────────────────────
  for (let i = 0; i < count; i++) {
    const { size, png } = frames[i];
    const base = ICONDIR_SIZE + i * ICONDIRENTRY_SIZE;
    // width / height: 0 encodes 256; we only offer ≤256 so this is safe.
    bytes[base + 0] = size === 256 ? 0 : size;
    bytes[base + 1] = size === 256 ? 0 : size;
    bytes[base + 2] = 0; // colorCount — 0 for PNG
    bytes[base + 3] = 0; // reserved
    view.setUint16(base + 4, 1, true); // planes
    view.setUint16(base + 6, 32, true); // bitCount — 32 bpp RGBA (keeps alpha)
    view.setUint32(base + 8, png.byteLength, true); // bytesInRes
    view.setUint32(base + 12, offsets[i], true); // imageOffset
  }

  // ── PNG data ─────────────────────────────────────────────────────────────
  for (let i = 0; i < count; i++) {
    bytes.set(frames[i].png, offsets[i]);
  }

  return bytes;
}

async function convertImageToIco(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const sizes = parseSizes(options?.icoSizes);

  onProgress?.({ stage: "Decoding" });
  const bitmap = await decode(file);
  throwIfAborted(signal, () => bitmap.close());

  onProgress?.({ stage: "Rendering" });
  const frames: { size: number; png: Uint8Array }[] = [];
  for (const size of sizes) {
    throwIfAborted(signal, () => bitmap.close());
    const png = await renderToPng(bitmap, size);
    frames.push({ size, png });
    onProgress?.({ stage: `Rendering ${size}×${size}`, ratio: frames.length / sizes.length });
  }
  bitmap.close();
  throwIfAborted(signal);

  onProgress?.({ stage: "Building ICO" });
  const icoBytes = buildIco(frames);
  const blob = new Blob([icoBytes.buffer as ArrayBuffer], { type: "image/x-icon" });

  return {
    blob,
    filename: replaceExtension(file.name, "ico"),
    mimeType: "image/x-icon",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const imageToIcoDescriptor: ConversionDescriptor = {
  id: "image-to-ico",
  fromLabel: "Image",
  toLabel: "ICO",
  accept: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  newExtension: "ico",
  // The on-page tool (ImageToIcoTool) renders size checkboxes and passes the
  // chosen sizes here as `icoSizes`. No descriptor `controls` are declared: this
  // tool uses its own UI (live preview + multi-select) rather than the shared
  // ControlPanel, so it can show which sizes will be embedded as the user picks.
  defaultOptions: { icoSizes: DEFAULT_ICO_SIZES_STRING },
  convert: convertImageToIco,
};
