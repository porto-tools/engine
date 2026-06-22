// Watermark PDF — stamp a text OR image/logo watermark across pages using pdf-lib
// (pure JS, no WASM, no loadEngine). Controls: a watermark-type switch (text |
// image), and for text the text, placement (centered or tiled mosaic), angle,
// opacity, font size, and an optional page range. In image mode the user picks a
// PNG/JPG logo (a "file" control whose File reaches us under options.logoFile)
// and it is stamped with the SAME placement / rotation / opacity / page-range
// logic the text path uses. Everything runs in the browser.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { parsePageRange } from "../page-range";
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

type PlacementKey = "center" | "tile";
// The iLovePDF rotation preset set. 45° diagonal is the classic watermark angle.
type RotationKey = "0" | "45" | "90" | "180" | "270";

const PLACEMENTS: readonly PlacementKey[] = ["center", "tile"];
const ROTATIONS: readonly RotationKey[] = ["0", "45", "90", "180", "270"];

function readChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Origin (bottom-left of the unrotated text) that places the text's MIDPOINT at
// the page centre after rotating by `deg` about that origin. Pure + testable —
// the rotation pivot math is the only tricky part of a centred watermark.
export function centeredOrigin(
  pageW: number,
  pageH: number,
  textW: number,
  textH: number,
  deg: number,
): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Midpoint of the text in its own (pre-rotation) frame, rotated into the page.
  const mx = cos * (textW / 2) - sin * (textH / 2);
  const my = sin * (textW / 2) + cos * (textH / 2);
  return { x: pageW / 2 - mx, y: pageH / 2 - my };
}

// Tile spacing derived from the text footprint. The mosaic repeats the watermark
// on a grid wide enough that even at the largest size the stamps do not collide;
// the diagonal look comes from the rotation applied at draw time. Pure so the
// spacing rule can be asserted without a PDF.
export function tileStep(textW: number, fontSize: number): { stepX: number; stepY: number } {
  return { stepX: Math.max(textW, 120) + 80, stepY: fontSize + 120 };
}

// Tile spacing for the IMAGE mosaic, derived from the DRAWN stamp size. The text
// tileStep treats its 2nd arg as a font size (stepY = fontSize + 120), but the
// logo's drawn HEIGHT is far larger than a font size — routing drawH through it
// inflates stepY to ~350pt on A4, so the mosaic tiles only 1-2 rows vertically.
// Stepping on the real drawn footprint instead gives the logo mosaic the same
// vertical density as the text one. Pure so the spacing rule can be asserted
// without a PDF.
export function tileStepImage(drawW: number, drawH: number): { stepX: number; stepY: number } {
  return { stepX: Math.max(drawW, 120) + 80, stepY: drawH + 120 };
}

// Bottom-left origins for a mosaic of the text across one page, given the page
// size and the per-axis step. Walks from the origin to just past each edge so the
// grid fully covers the page (the +step upper bound guarantees the far edge is
// reached). Pure + DOM-free: the test asserts the exact coordinate list for a
// known page/step instead of round-tripping through pdf-lib.
export function tilePlacements(
  pageW: number,
  pageH: number,
  stepX: number,
  stepY: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  // Guard against a non-advancing step (would loop forever); callers pass > 0.
  if (!(stepX > 0) || !(stepY > 0)) return out;
  for (let y = 0; y < pageH + stepY; y += stepY) {
    for (let x = 0; x < pageW + stepX; x += stepX) {
      out.push({ x, y });
    }
  }
  return out;
}

// Map an opacity percentage (5..100) to the 0..1 alpha pdf-lib's drawText takes.
// Graded opacity is just this division; isolated so the mapping is unit-tested.
export function opacityAlpha(percent: number): number {
  return percent / 100;
}

// Scale a logo so its longest side is a sensible fraction of the page's shortest
// side — big enough to read as a watermark, small enough to leave margins. Pure +
// DOM-free so the sizing rule is unit-testable without a PDF. Returns the drawn
// width/height in points (1px = 1pt at 72 DPI), preserving the logo's aspect
// ratio; degenerate inputs fall back to a 1×1 box so callers never divide by 0.
export function scaledLogoSize(
  logoW: number,
  logoH: number,
  pageW: number,
  pageH: number,
): { width: number; height: number } {
  const w = logoW > 0 ? logoW : 1;
  const h = logoH > 0 ? logoH : 1;
  // Target the logo's longest edge at ~40% of the page's shortest edge.
  const target = Math.max(1, Math.min(pageW, pageH) * 0.4);
  const longest = Math.max(w, h);
  const scale = target / longest;
  return { width: w * scale, height: h * scale };
}

// Origin (bottom-left of the unrotated image) that places the image's MIDPOINT at
// the page centre after rotating by `deg` about that origin. Same pivot math as
// centeredOrigin (which is text-specific in its naming) but kept separate so the
// image path reads clearly; pure + testable.
export function centeredImageOrigin(
  pageW: number,
  pageH: number,
  drawW: number,
  drawH: number,
  deg: number,
): { x: number; y: number } {
  return centeredOrigin(pageW, pageH, drawW, drawH, deg);
}

type WatermarkTypeKey = "text" | "image";
const WATERMARK_TYPES: readonly WatermarkTypeKey[] = ["text", "image"];

async function convertWatermarkPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  // The top-level switch. Defaults to "text" by absence, so every existing call
  // (and the descriptor's defaultOptions) runs the unchanged text path.
  const watermarkType = readChoice<WatermarkTypeKey>(options?.watermarkType, WATERMARK_TYPES, "text");

  // Shared placement / rotation / opacity / page-range reads — identical for both
  // the text and image paths so a logo watermark honours the same controls.
  const placement = readChoice<PlacementKey>(options?.placement, PLACEMENTS, "center");
  const rotationKey = readChoice<RotationKey>(options?.rotation, ROTATIONS, "45");
  const deg = Number(rotationKey);
  const opacity = opacityAlpha(readInt(options?.opacity, 30, 5, 100));

  if (watermarkType === "image") {
    return convertImageWatermark(input, { placement, deg, opacity });
  }

  const rawText = typeof options?.text === "string" ? options.text : "";
  const text = (rawText.trim() || "CONFIDENTIAL").slice(0, 120);
  const fontSize = readInt(options?.fontSize, 48, 12, 120);

  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  // Parse the page-range control. Empty string = all pages (allowAll), which is
  // the default, so the out-of-the-box output watermarks every page as before.
  const pagesStr = typeof options?.pages === "string" ? options.pages : "";
  const selected = new Set(parsePageRange(pagesStr, pages.length)); // 1-based page numbers

  const ink = rgb(0.5, 0.5, 0.5);
  const textW = font.widthOfTextAtSize(text, fontSize);
  const rot = degrees(deg);
  const { stepX, stepY } = tileStep(textW, fontSize);

  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    if (!selected.has(i + 1)) continue; // honour the page range (1-based)
    onProgress?.({ stage: `Watermarking page ${i + 1}`, ratio: i / pages.length });

    const page = pages[i];
    const { width, height } = page.getSize();

    if (placement === "tile") {
      // A mosaic of the text across the page; the rotation gives the diagonal look.
      for (const { x, y } of tilePlacements(width, height, stepX, stepY)) {
        page.drawText(text, { x, y, size: fontSize, font, color: ink, opacity, rotate: rot });
      }
    } else {
      const { x, y } = centeredOrigin(width, height, textW, fontSize, deg);
      page.drawText(text, { x, y, size: fontSize, font, color: ink, opacity, rotate: rot });
    }
  }

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

// Image-watermark path: embed the user's PNG/JPG logo and stamp it with the SAME
// placement (center / tile) + rotation + opacity + page-range logic the text path
// uses. The logo File reaches us under `options.logoFile` (a "file" control whose
// File the ControlsInputTool merges into options). Kept in its own function so the
// text path above stays byte-for-byte identical when watermarkType === "text".
async function convertImageWatermark(
  input: ConversionInput,
  shared: { placement: PlacementKey; deg: number; opacity: number },
): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  const { placement, deg, opacity } = shared;

  // The picked logo arrives as a File under options.logoFile. A missing logo is a
  // recoverable user fixable state, not a hard failure — guide them to pick one.
  const logo = options?.logoFile instanceof File ? options.logoFile : null;
  if (!logo) {
    throw new ConversionError("Choose a PNG or JPG image to use as the watermark.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: "Image watermark selected but no logoFile was provided in options.",
    });
  }

  const isPng = logo.type === "image/png";
  const isJpg = logo.type === "image/jpeg";
  if (!isPng && !isJpg) {
    throw new ConversionError("The watermark image must be a PNG or JPG.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Expected image/png or image/jpeg, received "${logo.type || "unknown type"}".`,
    });
  }

  const { PDFDocument, degrees } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  // Embed the logo once (pdf-lib reuses one XObject across pages). Same embedPng /
  // embedJpg pattern as images-to-pdf.
  let image;
  try {
    const logoBytes = new Uint8Array(await logo.arrayBuffer());
    image = isPng ? await doc.embedPng(logoBytes) : await doc.embedJpg(logoBytes);
  } catch (err) {
    throw new ConversionError("We couldn't read the watermark image — it may be corrupt or unsupported.", {
      code: "DECODE_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  const pages = doc.getPages();
  const pagesStr = typeof options?.pages === "string" ? options.pages : "";
  const selected = new Set(parsePageRange(pagesStr, pages.length)); // 1-based page numbers
  const rot = degrees(deg);

  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    if (!selected.has(i + 1)) continue; // honour the page range (1-based)
    onProgress?.({ stage: `Watermarking page ${i + 1}`, ratio: i / pages.length });

    const page = pages[i];
    const { width, height } = page.getSize();
    const { width: drawW, height: drawH } = scaledLogoSize(image.width, image.height, width, height);

    if (placement === "tile") {
      // A mosaic of the logo across the page; the rotation gives the diagonal
      // look. Step on the drawn logo footprint (NOT the text tileStep, whose 2nd
      // arg is a font size) so the mosaic is as dense vertically as horizontally.
      const { stepX, stepY } = tileStepImage(drawW, drawH);
      for (const { x, y } of tilePlacements(width, height, stepX, stepY)) {
        page.drawImage(image, { x, y, width: drawW, height: drawH, opacity, rotate: rot });
      }
    } else {
      const { x, y } = centeredImageOrigin(width, height, drawW, drawH, deg);
      page.drawImage(image, { x, y, width: drawW, height: drawH, opacity, rotate: rot });
    }
  }

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

export const watermarkPdfDescriptor: ConversionDescriptor = {
  id: "watermark-pdf",
  fromLabel: "PDF",
  toLabel: "Watermarked PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  defaultOptions: { watermarkType: "text", text: "CONFIDENTIAL", placement: "center", rotation: "45", opacity: 30, fontSize: 48, pages: "" },
  controls: [
    {
      type: "select",
      id: "watermarkType",
      label: "Watermark type",
      help: "Text stamps the words you type; Image stamps a PNG or JPG logo you pick.",
      default: "text",
      options: [
        { value: "text", label: "Text" },
        { value: "image", label: "Image / logo" },
      ],
    },
    {
      type: "file",
      id: "logoFile",
      label: "Logo image",
      help: "PNG or JPG to stamp as the watermark. Used only when Watermark type is Image / logo.",
      accept: ["image/png", "image/jpeg"],
    },
    {
      type: "text",
      id: "text",
      label: "Watermark text",
      help: "The text stamped on every page.",
      default: "CONFIDENTIAL",
      placeholder: "CONFIDENTIAL",
      maxLength: 120,
    },
    {
      type: "select",
      id: "placement",
      label: "Placement",
      help: "Centered places one watermark per page; tiled repeats it as a mosaic across the whole page.",
      default: "center",
      options: [
        { value: "center", label: "Centered" },
        { value: "tile", label: "Tiled (mosaic)" },
      ],
    },
    {
      type: "select",
      id: "rotation",
      label: "Angle",
      default: "45",
      options: [
        { value: "0", label: "0°" },
        { value: "45", label: "45°" },
        { value: "90", label: "90°" },
        { value: "180", label: "180°" },
        { value: "270", label: "270°" },
      ],
    },
    {
      type: "range",
      id: "opacity",
      label: "Opacity",
      help: "Lower is more transparent.",
      default: 30,
      min: 5,
      max: 100,
      step: 5,
      unit: "%",
    },
    {
      type: "range",
      id: "fontSize",
      label: "Text size",
      default: 48,
      min: 12,
      max: 120,
      step: 1,
      unit: "pt",
    },
    {
      type: "page-range",
      id: "pages",
      label: "Pages",
      help: "Which pages to watermark, e.g. 1-3,5. Leave blank for every page.",
      default: "",
      allowAll: true,
    },
  ],
  convert: convertWatermarkPdf,
};
