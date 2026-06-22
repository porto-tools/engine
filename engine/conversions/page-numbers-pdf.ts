// Add Page Numbers — stamp a page number onto every page of a PDF using pdf-lib
// (pure JS, no WASM, no loadEngine). The number's position, text format, starting
// value, and font size are user options. Everything runs in the browser.

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

type PositionKey =
  | "bottom-center"
  | "bottom-right"
  | "bottom-left"
  | "top-center"
  | "top-right"
  | "top-left";
type FormatKey = "number" | "n-of-total" | "page-n";

const POSITIONS: readonly PositionKey[] = [
  "bottom-center",
  "bottom-right",
  "bottom-left",
  "top-center",
  "top-right",
  "top-left",
];
const FORMATS: readonly FormatKey[] = ["number", "n-of-total", "page-n"];

const MARGIN = 36; // 0.5in from the page edge

function readChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readBool(value: unknown): boolean {
  return value === true || value === "true";
}

// Build the stamped label for one page. `pageNumber` is the already-offset value
// (start + index); `lastNumber` is the highest number stamped (start + count - 1),
// used by the "n of total" format. Pure + exported for unit testing.
export function formatPageNumber(pageNumber: number, lastNumber: number, format: FormatKey): string {
  if (format === "page-n") return `Page ${pageNumber}`;
  if (format === "n-of-total") return `${pageNumber} of ${lastNumber}`;
  return `${pageNumber}`;
}

// The numeric context one page contributes to a custom template:
//   absolute      — the {n} value (start + page index), same as the preset path
//   absoluteTotal — the {p} value (highest absolute number stamped)
//   relative      — the {r} value: position WITHIN the numbered range (see
//                   relativeNumber), independent of the absolute numbering
//   relativeTotal — the {rf} value: how many pages are numbered in total
export interface TokenContext {
  absolute: number;
  absoluteTotal: number;
  relative: number;
  relativeTotal: number;
}

// Substitute the supported tokens in a custom template. Absolute tokens {n}/{p}
// mirror the preset formats; range-relative {r}/{rf} count from a chosen start
// page within the numbered range so e.g. front-matter can carry its own sequence.
// Every occurrence is replaced; unknown braces are left verbatim. Pure + testable.
export function substituteTokens(template: string, ctx: TokenContext): string {
  return template
    .replace(/\{rf\}/g, String(ctx.relativeTotal))
    .replace(/\{r\}/g, String(ctx.relative))
    .replace(/\{n\}/g, String(ctx.absolute))
    .replace(/\{p\}/g, String(ctx.absoluteTotal));
}

// In facing-pages (book/print) mode the horizontal side mirrors by page parity so
// the number always lands in the OUTER corner: odd (recto) pages keep the chosen
// side, even (verso) pages flip left<->right. center and the vertical band are
// untouched. `pageIndex` is 0-based (index 0 = page 1 = recto). When `facing` is
// false this is the identity, so the default output is unchanged. Pure + testable.
export function facingPosition(position: PositionKey, pageIndex: number, facing: boolean): PositionKey {
  if (!facing) return position;
  const isVerso = pageIndex % 2 === 1; // 0-based: index 1 = page 2 = verso (even)
  if (!isVerso) return position;
  if (position.endsWith("right")) return position.replace("right", "left") as PositionKey;
  if (position.endsWith("left")) return position.replace("left", "right") as PositionKey;
  return position; // center is symmetric — nothing to mirror
}

// The 0-based page indices that get a number after skipping the first
// `excludeFirst` and last `excludeLast` pages. Defaults (0,0) number every page,
// keeping the out-of-the-box output identical. Over-large excludes collapse to an
// empty list without producing negative or overlapping ranges. Pure + testable.
export function numberedPages(total: number, excludeFirst: number, excludeLast: number): number[] {
  const start = Math.max(0, excludeFirst);
  const end = total - Math.max(0, excludeLast); // exclusive upper bound
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

// The range-relative value ({r}) for a numbered page: `relativeStart` for the
// first numbered page, then +1 per subsequent numbered page. `ordinal` is the
// page's 0-based position within the numbered set (NOT its page index), so the
// relative sequence is contiguous even when ends are excluded. Pure + testable.
export function relativeNumber(ordinal: number, relativeStart: number): number {
  return relativeStart + ordinal;
}

// Where to place a label of width `textW`/height `fontSize` on a page, given the
// position key. Returns the pdf-lib draw origin (bottom-left of the text).
export function placeLabel(
  position: PositionKey,
  pageW: number,
  pageH: number,
  textW: number,
  fontSize: number,
): { x: number; y: number } {
  const isTop = position.startsWith("top");
  const y = isTop ? pageH - MARGIN - fontSize : MARGIN;
  let x: number;
  if (position.endsWith("center")) x = (pageW - textW) / 2;
  else if (position.endsWith("right")) x = pageW - MARGIN - textW;
  else x = MARGIN; // left
  return { x, y };
}

async function convertAddPageNumbers(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const position = readChoice<PositionKey>(options?.position, POSITIONS, "bottom-center");
  const format = readChoice<FormatKey>(options?.format, FORMATS, "number");
  const start = readInt(options?.start, 1, 0, 100000);
  const fontSize = readInt(options?.fontSize, 12, 8, 32);

  // New (all additive, all neutral by default so the out-of-the-box output is
  // byte-identical): a custom token template, facing-pages mirroring, skipping
  // the first/last N pages, an optional background box, and the relative start.
  const rawTemplate = typeof options?.template === "string" ? options.template : "";
  const template = rawTemplate.trim().slice(0, 120);
  const facing = readBool(options?.facing);
  const excludeFirst = readInt(options?.excludeFirst, 0, 0, 100000);
  const excludeLast = readInt(options?.excludeLast, 0, 0, 100000);
  const relativeStart = readInt(options?.relativeStart, 1, 0, 100000);
  const box = readBool(options?.box);
  const boxOpacity = readInt(options?.boxOpacity, 80, 5, 100) / 100;

  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  // Which pages actually get a number (skip first/last N; defaults number all).
  // The absolute total {p} and the "n of total" preset both read the highest
  // absolute value stamped, derived from the last numbered index — which is
  // start + pages.length - 1 when nothing is excluded, exactly as before.
  const indices = numberedPages(pages.length, excludeFirst, excludeLast);
  const lastNumber = indices.length > 0 ? start + indices[indices.length - 1] : start;
  const relativeTotal = indices.length;
  const ink = rgb(0.2, 0.2, 0.2);
  const boxColor = rgb(1, 1, 1); // white plate behind the number for legibility
  const PAD = 3; // points of padding around the text inside the background box

  for (let ordinal = 0; ordinal < indices.length; ordinal++) {
    throwIfAborted(signal);
    const i = indices[ordinal];
    onProgress?.({ stage: `Numbering page ${i + 1}`, ratio: ordinal / indices.length });

    const page = pages[i];
    const { width, height } = page.getSize();

    // A non-empty custom template substitutes tokens (absolute {n}/{p} and
    // range-relative {r}/{rf}); an empty template (the default) keeps the exact
    // preset-format label, so the default output is unchanged.
    const absolute = start + i;
    const label =
      template.length > 0
        ? substituteTokens(template, {
            absolute,
            absoluteTotal: lastNumber,
            relative: relativeNumber(ordinal, relativeStart),
            relativeTotal,
          })
        : formatPageNumber(absolute, lastNumber, format);

    const textW = font.widthOfTextAtSize(label, fontSize);
    const drawPosition = facingPosition(position, i, facing);
    const { x, y } = placeLabel(drawPosition, width, height, textW, fontSize);

    // Optional filled plate behind the number so it stays legible over content.
    // Off by default ⇒ no rectangle is drawn ⇒ byte-identical default output.
    if (box) {
      page.drawRectangle({
        x: x - PAD,
        y: y - PAD,
        width: textW + PAD * 2,
        height: fontSize + PAD * 2,
        color: boxColor,
        opacity: boxOpacity,
      });
    }

    page.drawText(label, { x, y, size: fontSize, font, color: ink });
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

export const pageNumbersPdfDescriptor: ConversionDescriptor = {
  id: "add-page-numbers",
  fromLabel: "PDF",
  toLabel: "Numbered PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  defaultOptions: {
    position: "bottom-center",
    format: "number",
    start: 1,
    fontSize: 12,
    template: "",
    facing: false,
    excludeFirst: 0,
    excludeLast: 0,
    relativeStart: 1,
    box: false,
    boxOpacity: 80,
  },
  controls: [
    {
      type: "select",
      id: "position",
      label: "Position",
      help: "Where the page number sits on each page.",
      default: "bottom-center",
      options: [
        { value: "bottom-center", label: "Bottom center" },
        { value: "bottom-right", label: "Bottom right" },
        { value: "bottom-left", label: "Bottom left" },
        { value: "top-center", label: "Top center" },
        { value: "top-right", label: "Top right" },
        { value: "top-left", label: "Top left" },
      ],
    },
    {
      type: "checkbox",
      id: "facing",
      label: "Facing pages (book layout)",
      help: "Mirror left/right placement by page so the number always sits in the outer corner — for double-sided printing.",
      default: false,
    },
    {
      type: "select",
      id: "format",
      label: "Format",
      help: "How the number reads, e.g. 1, 1 of 10, or Page 1. Ignored when a custom format is set below.",
      default: "number",
      options: [
        { value: "number", label: "1" },
        { value: "n-of-total", label: "1 of 10" },
        { value: "page-n", label: "Page 1" },
      ],
    },
    {
      type: "text",
      id: "template",
      label: "Custom format (optional)",
      help: "Overrides Format when set. Tokens: {n} number, {p} total, {r} number from the relative start, {rf} count of numbered pages. e.g. {r} of {rf}.",
      default: "",
      placeholder: "{n} of {p}",
      maxLength: 120,
    },
    {
      type: "number",
      id: "start",
      label: "Start at",
      help: "The number shown on the first page (the {n} value).",
      default: 1,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      type: "number",
      id: "relativeStart",
      label: "Relative start",
      help: "The {r} value on the first numbered page. Useful with a custom format to give front matter its own sequence.",
      default: 1,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      type: "number",
      id: "excludeFirst",
      label: "Skip first pages",
      help: "Leave this many pages at the start unnumbered, e.g. 1 to skip a cover.",
      default: 0,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      type: "number",
      id: "excludeLast",
      label: "Skip last pages",
      help: "Leave this many pages at the end unnumbered, e.g. a back cover.",
      default: 0,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      type: "checkbox",
      id: "box",
      label: "Background box",
      help: "Draw a filled plate behind the number so it stays legible over content.",
      default: false,
    },
    {
      type: "range",
      id: "boxOpacity",
      label: "Box opacity",
      help: "How opaque the background box is. Only used when Background box is on.",
      default: 80,
      min: 5,
      max: 100,
      step: 5,
      unit: "%",
    },
    {
      type: "range",
      id: "fontSize",
      label: "Text size",
      help: "Font size of the page number, in points.",
      default: 12,
      min: 8,
      max: 32,
      step: 1,
      unit: "pt",
    },
  ],
  convert: convertAddPageNumbers,
};
