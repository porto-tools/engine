// Sign PDF — stamp a hand-drawn signature image onto one page of a PDF using
// pdf-lib (pure JS, no WASM, no loadEngine). The signature arrives as a PNG
// dataURL the user drew on a <canvas>; the page, corner position, and width are
// user options. Everything runs in the browser.
//
// This is a VISIBLE stamped signature — the PNG is embedded as page content, the
// same as a scanned wet signature. It is NOT a cryptographic / certified
// e-signature and carries no digital identity or tamper-evidence.
//
// This descriptor intentionally declares NO `controls`: the /sign-pdf route
// renders its own editor (a SignaturePad plus page/position/size fields) and
// passes the values straight through as `options`.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadPdfDocument } from "./pdf-lib-load";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

type PositionKey = "bottom-right" | "bottom-left" | "bottom-center";

const POSITIONS: readonly PositionKey[] = ["bottom-right", "bottom-left", "bottom-center"];

const MARGIN = 36; // 0.5in from the page edge
const DEFAULT_SIZE = 160; // signature width in points
const MIN_SIZE = 80;
const MAX_SIZE = 300;

function readChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Where to place a signature image of size drawW × drawH on a page, given the
// position key. Returns the pdf-lib draw origin (bottom-left of the image) with a
// `margin` gap from the page edges. Pure + exported for unit testing.
export function placeSignature(
  position: PositionKey,
  pageW: number,
  pageH: number,
  drawW: number,
  drawH: number,
  margin: number,
): { x: number; y: number } {
  const y = margin; // all three positions sit at the bottom
  let x: number;
  if (position === "bottom-center") x = (pageW - drawW) / 2;
  else if (position === "bottom-left") x = margin;
  else x = pageW - margin - drawW; // bottom-right
  return { x, y };
}

// Decode the base64 payload of a `data:image/png;base64,...` dataURL into bytes.
// Uses atob in the browser and Buffer in Node, so the engine works in both the
// app and the Node test env without a DOM.
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node fallback (test env): Buffer is a Uint8Array.
  return new Uint8Array(Buffer.from(base64, "base64"));
}

async function convertSignPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const signature = typeof options?.signature === "string" ? options.signature : "";
  if (!signature) {
    throw new ConversionError("Draw a signature first.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: "options.signature was empty — expected a PNG dataURL.",
    });
  }

  const position = readChoice<PositionKey>(options?.position, POSITIONS, "bottom-right");
  const size = readInt(options?.size, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE);
  // page is 1-based; 0/absent means "last page". Read leniently, clamp later once
  // we know the real page count.
  const requestedPage = readInt(options?.page, 0, 0, 1_000_000);

  const { PDFDocument } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  const pages = doc.getPages();

  onProgress?.({ stage: "Embedding signature", ratio: 0.4 });
  let png;
  try {
    png = await doc.embedPng(dataUrlToBytes(signature));
  } catch (err) {
    throw new ConversionError("We couldn't read the signature image.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  // Clamp the target page to the document's range. Default (0) → the last page.
  const targetIndex =
    requestedPage <= 0 ? pages.length - 1 : Math.min(requestedPage, pages.length) - 1;
  const page = pages[targetIndex];

  const { width: pageW, height: pageH } = page.getSize();
  const drawW = size;
  const drawH = size * (png.height / png.width);
  const { x, y } = placeSignature(position, pageW, pageH, drawW, drawH, MARGIN);

  throwIfAborted(signal);
  onProgress?.({ stage: "Stamping", ratio: 0.7 });
  page.drawImage(png, { x, y, width: drawW, height: drawH });

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving", ratio: 1 });

  const saved = await doc.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const signPdfDescriptor: ConversionDescriptor = {
  id: "sign-pdf",
  fromLabel: "PDF",
  toLabel: "Signed PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  convert: convertSignPdf,
};
