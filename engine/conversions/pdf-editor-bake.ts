// PDF Editor (bake) — flatten a set of visual annotation objects (free text and
// shapes) into a PDF's page content using pdf-lib (pure JS, no WASM, no
// loadEngine). The component layer builds the annotations interactively over a
// page preview and hands this engine a PLAIN, JSON-serialisable payload; this
// module walks that payload and emits the corresponding pdf-lib draw calls.
//
// Phase 1 supports four object kinds: free text, rectangle, ellipse, and line.
// Phase 2 adds two more: a placed raster image and a freehand pencil stroke.
// Phase 3 adds two MORE: text-markup (highlight / underline / strikeout) and a
// URI hyperlink. Unlike the P1/P2 kinds — which are STAMPED into the page content
// (an honest "draw the overlay onto the page" operation) — these two are emitted
// as spec-conformant interactive PDF /Annot dictionaries: a /Highlight, /Underline
// or /StrikeOut text-markup annotation, and a /Link annotation with a /URI action.
// They are real, selectable/clickable PDF annotations, not baked page content.
//
// ── COORDINATE MODEL (see docs/decisions/0019) ───────────────────────────────
// Every object's geometry is stored as FRACTIONS of the page (0..1) with a
// TOP-LEFT origin and y growing downward — the natural coordinate space of the
// HTML preview (getBoundingClientRect). PDF user space has a BOTTOM-LEFT origin
// with y growing upward, so each object is converted per page of width W and
// height H (in PDF points) as:
//
//     pdfX = fx * W
//     pdfY = (1 - fy - fh) * H        // flip + account for the box's own height
//     pdfW = fw * W
//     pdfH = fh * H
//
// pdfX/pdfY is the BOTTOM-LEFT corner of the box in PDF space, which is what
// drawRectangle takes. Text is drawn from its baseline; we place the baseline a
// little above the box's bottom edge (see drawTextObject). Font sizes are stored
// in CSS px (the preview's unit) and converted to PDF points with `* 72 / 96`.
//
// ── ENGINE FIREWALL ──────────────────────────────────────────────────────────
// This file imports ONLY pdf-lib, ../types, and ../filename. It touches no DOM,
// no React, no refs — it consumes a plain AnnotObject[] payload. That keeps it
// extractable into @porto-tools/engine unchanged. See ARCHITECTURE.md.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadPdfDocument } from "./pdf-lib-load";

// CSS px → PDF points. The preview renders at the browser's 96 DPI; PDF user
// space is 72 points/inch. A 16px font becomes 12pt.
const PX_TO_PT = 72 / 96;

// ── The JSON-serialisable annotation model (see docs/decisions/0020) ──────────
//
// A discriminated union over `type`. Geometry is fractional (0..1, top-left
// origin) so it is resolution-independent: the same object renders identically
// over a small preview and onto the full-size PDF page. z-order is the array
// index within a page's AnnotObject[] (later = on top); this module draws in
// array order so the topmost object is painted last.

// An sRGB colour as three 0..1 channels — the shape pdf-lib's rgb() takes.
export interface AnnotColor {
  r: number;
  g: number;
  b: number;
}

interface AnnotBase {
  // Fractional bounding box (0..1), top-left origin, y down. For a line this is
  // the bounding box of its two endpoints (see x1/y1/x2/y2 below for direction).
  x: number;
  y: number;
  w: number;
  h: number;
  // 0..1 fill/stroke opacity applied to the whole object.
  opacity: number;
}

export interface TextAnnot extends AnnotBase {
  type: "text";
  text: string;
  fontSize: number; // CSS px
  color: AnnotColor;
  bold: boolean;
  italic: boolean;
}

export interface RectAnnot extends AnnotBase {
  type: "rect";
  fillColor: AnnotColor | null; // null = no fill (outline only)
  borderColor: AnnotColor;
  borderWidth: number; // CSS px
}

export interface EllipseAnnot extends AnnotBase {
  type: "ellipse";
  fillColor: AnnotColor | null;
  borderColor: AnnotColor;
  borderWidth: number; // CSS px
}

export interface LineAnnot extends AnnotBase {
  type: "line";
  // Endpoints as fractions (0..1, top-left origin). The bounding box (x,y,w,h)
  // is derived from these; storing both keeps the direction (which corner is the
  // start) that a bounding box alone would lose.
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: AnnotColor;
  borderWidth: number; // CSS px
}

// A placed raster image (PNG or JPEG). dataUrl carries the bytes (a
// `data:image/...;base64,...` string), mimeType selects embedPng vs embedJpg,
// and the fractional box (x,y,w,h) positions/sizes it like every other object.
export interface ImageAnnot extends AnnotBase {
  type: "image";
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg";
}

// A freehand pencil stroke: an ordered list of fractional points (0..1,
// top-left origin). The base box (x,y,w,h) is the points' bounding box (kept so
// the preview/selection can size an overlay), but the stroke is baked from the
// points themselves, not the box.
export interface PencilAnnot extends AnnotBase {
  type: "pencil";
  points: { x: number; y: number }[];
  strokeColor: AnnotColor;
  strokeWidth: number; // CSS px
}

// A text-markup annotation (highlight / underline / strikeout) over a fractional
// rectangle. Unlike the baked shapes, this is emitted as a real PDF /Annot dict
// with /Subtype /Highlight | /Underline | /StrikeOut and /QuadPoints. The
// fractional box (x,y,w,h) defines the single quad the markup covers.
export interface MarkupAnnot extends AnnotBase {
  type: "highlight" | "underline" | "strikeout";
  color: AnnotColor;
}

// A URI hyperlink over a fractional rectangle. Emitted as a real PDF /Annot dict
// with /Subtype /Link and a /URI action; clicking the rect opens `href`. The
// border is invisible by default (PDF link annots conventionally show no box).
export interface LinkAnnot extends AnnotBase {
  type: "link";
  href: string;
}

export type AnnotObject =
  | TextAnnot
  | RectAnnot
  | EllipseAnnot
  | LineAnnot
  | ImageAnnot
  | PencilAnnot
  | MarkupAnnot
  | LinkAnnot;

// The per-page payload the engine consumes: 1-based page number → its objects in
// z-order (index 0 drawn first / at the bottom). Plain JSON, no class instances.
export interface PageAnnots {
  page: number; // 1-based
  objects: AnnotObject[];
}

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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Pure coordinate maths (exported for unit tests) ───────────────────────────

// Map a fractional, top-left-origin box to a PDF-space, bottom-left-origin box.
// pdfX/pdfY is the BOTTOM-LEFT corner — the origin drawRectangle/drawEllipse-box
// expect. The y-flip subtracts BOTH the top offset and the box's own height so
// the box sits where the preview drew it.
export function fractionToPdfBox(
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  pageW: number,
  pageH: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: fx * pageW,
    y: (1 - fy - fh) * pageH,
    width: fw * pageW,
    height: fh * pageH,
  };
}

// Map a single fractional point (top-left origin, y down) to PDF space
// (bottom-left origin, y up). Used for line endpoints.
export function fractionPointToPdf(
  fx: number,
  fy: number,
  pageW: number,
  pageH: number,
): { x: number; y: number } {
  return { x: fx * pageW, y: (1 - fy) * pageH };
}

// CSS px → PDF points.
export function pxToPt(px: number): number {
  return px * PX_TO_PT;
}

// Map a fractional, top-left-origin box to a PDF /Rect: the 4-number array
// [llx, lly, urx, ury] (lower-left then upper-right corner, in PDF points,
// bottom-left origin). Reuses the same y-flip the box maths uses. Exported for
// tests (the link annotation's /Rect).
export function fractionToPdfRect(
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  pageW: number,
  pageH: number,
): [number, number, number, number] {
  const box = fractionToPdfBox(fx, fy, fw, fh, pageW, pageH);
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

// Map a fractional, top-left-origin box to PDF /QuadPoints: the 8-number array
// for a single quad in the spec's corner order — x1 y1 x2 y2 x3 y3 x4 y4 =
// upper-left, upper-right, lower-left, lower-right (the order Acrobat/most
// viewers expect for text markup). All in PDF points, bottom-left origin.
// Exported for tests (the markup annotation's /QuadPoints).
export function fractionToQuadPoints(
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  pageW: number,
  pageH: number,
): [number, number, number, number, number, number, number, number] {
  const [llx, lly, urx, ury] = fractionToPdfRect(fx, fy, fw, fh, pageW, pageH);
  // UL, UR, LL, LR.
  return [llx, ury, urx, ury, llx, lly, urx, lly];
}

// Decode the base64 payload of a `data:image/...;base64,...` dataURL into bytes.
// Uses atob in the browser and Buffer in Node, so the engine works in both the
// app and the Node test env without a DOM. (Same helper shape as sign-pdf.)
export function dataUrlToBytes(dataUrl: string): Uint8Array {
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

// Encode fractional pencil points into an SVG path string in PDF POINTS, using a
// TOP-LEFT origin with y growing DOWN (SVG's own convention). drawSvgPath is
// invoked with { x: 0, y: pageH } so its internal translate+scale(1,-1) flips
// this into PDF user space — i.e. a path point (px, py) lands at PDF
// (px, pageH - py), the same y-flip the box maths uses.
//
// The path is `M x0,y0 L x1,y1 …` straight segments. Freehand strokes are dense
// enough that line segments read as smooth; quadratic smoothing is deferred (no
// new dep — perfect-freehand explicitly out of scope). Returns "" for <2 points
// so the caller can skip drawing.
export function pointsToSvgPath(
  points: { x: number; y: number }[],
  pageW: number,
  pageH: number,
): string {
  if (points.length < 2) return "";
  const seg = (p: { x: number; y: number }) => `${p.x * pageW},${p.y * pageH}`;
  let d = `M ${seg(points[0])}`;
  for (let i = 1; i < points.length; i++) d += ` L ${seg(points[i])}`;
  return d;
}

// ── pdf-lib draw helpers ──────────────────────────────────────────────────────
// Each takes the already-imported pdf-lib helpers so the module loads pdf-lib
// exactly once (in convert) and these stay pure-ish wrappers around draw calls.

type PdfLib = typeof import("pdf-lib");
type PdfPage = ReturnType<Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>["getPages"]>[number];
type PdfFont = Awaited<ReturnType<Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>["embedFont"]>>;

interface Fonts {
  regular: PdfFont;
  bold: PdfFont;
  italic: PdfFont;
  boldItalic: PdfFont;
}

function pickFont(fonts: Fonts, bold: boolean, italic: boolean): PdfFont {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

function drawTextObject(page: PdfPage, lib: PdfLib, fonts: Fonts, o: TextAnnot): void {
  const { width: W, height: H } = page.getSize();
  const box = fractionToPdfBox(o.x, o.y, o.w, o.h, W, H);
  const size = pxToPt(o.fontSize);
  const font = pickFont(fonts, o.bold, o.italic);
  // Place the baseline near the bottom of the box. pdf-lib draws text from its
  // baseline; descender ≈ 0.2·size, so lifting the baseline by that keeps the
  // glyphs visually inside the box the user drew.
  const baselineY = box.y + size * 0.2;
  page.drawText(o.text, {
    x: box.x,
    y: baselineY,
    size,
    font,
    color: lib.rgb(o.color.r, o.color.g, o.color.b),
    opacity: o.opacity,
  });
}

function drawRectObject(page: PdfPage, lib: PdfLib, o: RectAnnot): void {
  const { width: W, height: H } = page.getSize();
  const box = fractionToPdfBox(o.x, o.y, o.w, o.h, W, H);
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: o.fillColor ? lib.rgb(o.fillColor.r, o.fillColor.g, o.fillColor.b) : undefined,
    opacity: o.fillColor ? o.opacity : undefined,
    borderColor: lib.rgb(o.borderColor.r, o.borderColor.g, o.borderColor.b),
    borderWidth: pxToPt(o.borderWidth),
    borderOpacity: o.opacity,
  });
}

function drawEllipseObject(page: PdfPage, lib: PdfLib, o: EllipseAnnot): void {
  const { width: W, height: H } = page.getSize();
  const box = fractionToPdfBox(o.x, o.y, o.w, o.h, W, H);
  // pdf-lib's drawEllipse takes a CENTRE (x,y) and radii (xScale,yScale).
  page.drawEllipse({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    xScale: box.width / 2,
    yScale: box.height / 2,
    color: o.fillColor ? lib.rgb(o.fillColor.r, o.fillColor.g, o.fillColor.b) : undefined,
    opacity: o.fillColor ? o.opacity : undefined,
    borderColor: lib.rgb(o.borderColor.r, o.borderColor.g, o.borderColor.b),
    borderWidth: pxToPt(o.borderWidth),
    borderOpacity: o.opacity,
  });
}

function drawLineObject(page: PdfPage, lib: PdfLib, o: LineAnnot): void {
  const { width: W, height: H } = page.getSize();
  const start = fractionPointToPdf(o.x1, o.y1, W, H);
  const end = fractionPointToPdf(o.x2, o.y2, W, H);
  page.drawLine({
    start,
    end,
    thickness: pxToPt(o.borderWidth),
    color: lib.rgb(o.color.r, o.color.g, o.color.b),
    opacity: o.opacity,
  });
}

type PdfDoc = Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>;

// Embed + draw a placed image. The image fills the object's fractional box (the
// same y-flipped box every shape uses); opacity applies to the whole image. PNG
// vs JPEG is chosen by mimeType. Async because embedPng/embedJpg parse bytes.
async function drawImageObject(
  doc: PdfDoc,
  page: PdfPage,
  o: ImageAnnot,
): Promise<void> {
  const { width: W, height: H } = page.getSize();
  const box = fractionToPdfBox(o.x, o.y, o.w, o.h, W, H);
  const bytes = dataUrlToBytes(o.dataUrl);
  const img = o.mimeType === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  page.drawImage(img, {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    opacity: o.opacity,
  });
}

// Bake a freehand pencil stroke. The points are encoded into an SVG path in PDF
// points (top-left/ y-down); drawSvgPath at { x: 0, y: H } flips it into PDF
// space. Stroke-only (no fill): pass borderColor + borderWidth, never `color`.
function drawPencilObject(page: PdfPage, lib: PdfLib, o: PencilAnnot): void {
  const { width: W, height: H } = page.getSize();
  const path = pointsToSvgPath(o.points, W, H);
  if (!path) return; // <2 points — nothing to draw
  page.drawSvgPath(path, {
    x: 0,
    y: H,
    borderColor: lib.rgb(o.strokeColor.r, o.strokeColor.g, o.strokeColor.b),
    borderWidth: pxToPt(o.strokeWidth),
    borderOpacity: o.opacity,
  });
}

// The PDF /Subtype name for each markup kind.
const MARKUP_SUBTYPE: Record<MarkupAnnot["type"], string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
};

// Register a spec-conformant text-markup /Annot dict (/Highlight, /Underline or
// /StrikeOut) on the page and attach it via page.node.addAnnot. The markup spans
// one quad derived from the fractional box; /C carries the colour and /CA the
// opacity. This is a REAL interactive annotation, not baked page content.
function addMarkupAnnot(doc: PdfDoc, page: PdfPage, lib: PdfLib, o: MarkupAnnot): void {
  const { width: W, height: H } = page.getSize();
  const rect = fractionToPdfRect(o.x, o.y, o.w, o.h, W, H);
  const quad = fractionToQuadPoints(o.x, o.y, o.w, o.h, W, H);
  const { PDFName, PDFArray, PDFNumber, context } = annotContext(lib, doc);

  const rectArr = PDFArray.withContext(context);
  for (const n of rect) rectArr.push(PDFNumber.of(n));
  const quadArr = PDFArray.withContext(context);
  for (const n of quad) quadArr.push(PDFNumber.of(n));
  const colorArr = PDFArray.withContext(context);
  for (const c of [o.color.r, o.color.g, o.color.b]) colorArr.push(PDFNumber.of(c));

  const dict = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of(MARKUP_SUBTYPE[o.type]),
    Rect: rectArr,
    QuadPoints: quadArr,
    C: colorArr,
    CA: PDFNumber.of(o.opacity),
  });
  const ref = context.register(dict);
  page.node.addAnnot(ref);
}

// Register a spec-conformant /Link /Annot dict with a /URI action over the
// fractional rect, and attach it via page.node.addAnnot. The border is made
// invisible (/Border [0 0 0]) so the link shows no box — the convention for a
// hyperlink laid over existing content. A REAL interactive annotation.
function addLinkAnnot(doc: PdfDoc, page: PdfPage, lib: PdfLib, o: LinkAnnot): void {
  const { width: W, height: H } = page.getSize();
  const rect = fractionToPdfRect(o.x, o.y, o.w, o.h, W, H);
  const { PDFName, PDFArray, PDFNumber, PDFString, context } = annotContext(lib, doc);

  const rectArr = PDFArray.withContext(context);
  for (const n of rect) rectArr.push(PDFNumber.of(n));
  const borderArr = PDFArray.withContext(context);
  for (const n of [0, 0, 0]) borderArr.push(PDFNumber.of(n));

  const action = context.obj({
    Type: PDFName.of("Action"),
    S: PDFName.of("URI"),
    URI: PDFString.of(o.href),
  });
  const dict = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: rectArr,
    Border: borderArr,
    A: action,
  });
  const ref = context.register(dict);
  page.node.addAnnot(ref);
}

// Pull the low-level pdf-lib constructors + the document's PDFContext out once.
// pdf-lib 1.17.1 exposes PDFName/PDFArray/PDFNumber/PDFString and doc.context.
function annotContext(lib: PdfLib, doc: PdfDoc) {
  return {
    PDFName: lib.PDFName,
    PDFArray: lib.PDFArray,
    PDFNumber: lib.PDFNumber,
    PDFString: lib.PDFString,
    context: doc.context,
  };
}

// Bake every object of every page into the loaded document, in z-order. Exported
// (taking an already-loaded doc + embedded fonts) so the draw walk is unit-
// testable against a real pdf-lib document without going through file I/O.
export async function bakeAnnotations(
  doc: Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>,
  lib: PdfLib,
  pages: PageAnnots[],
  signal?: AbortSignal,
): Promise<void> {
  const docPages = doc.getPages();
  const fonts: Fonts = {
    regular: await doc.embedFont(lib.StandardFonts.Helvetica),
    bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    italic: await doc.embedFont(lib.StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(lib.StandardFonts.HelveticaBoldOblique),
  };

  for (const { page: pageNumber, objects } of pages) {
    throwIfAborted(signal);
    const page = docPages[pageNumber - 1];
    if (!page) continue; // out-of-range page number — skip defensively
    // Draw in array order so index 0 sits at the bottom and the last object is
    // painted on top (z-order = array index).
    for (const o of objects) {
      switch (o.type) {
        case "text":
          if (o.text.length > 0) drawTextObject(page, lib, fonts, o);
          break;
        case "rect":
          drawRectObject(page, lib, o);
          break;
        case "ellipse":
          drawEllipseObject(page, lib, o);
          break;
        case "line":
          drawLineObject(page, lib, o);
          break;
        case "image":
          if (o.dataUrl.length > 0) await drawImageObject(doc, page, o);
          break;
        case "pencil":
          drawPencilObject(page, lib, o);
          break;
        case "highlight":
        case "underline":
        case "strikeout":
          addMarkupAnnot(doc, page, lib, o);
          break;
        case "link":
          if (o.href.length > 0) addLinkAnnot(doc, page, lib, o);
          break;
      }
    }
  }
}

// Read the per-page annotations payload from options. The component passes a
// plain array under options.annotations. Anything malformed is ignored rather
// than throwing — an empty/absent payload simply re-saves the PDF unchanged.
function readAnnotations(options: Record<string, unknown> | undefined): PageAnnots[] {
  const raw = options?.annotations;
  if (!Array.isArray(raw)) return [];
  const out: PageAnnots[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as PageAnnots).page === "number" &&
      Array.isArray((entry as PageAnnots).objects)
    ) {
      out.push(entry as PageAnnots);
    }
  }
  return out;
}

async function convertPdfEditor(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const pages = readAnnotations(options);

  const lib = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading PDF", ratio: 0 });
  const doc = await loadPdfDocument(
    lib.PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or password-protected.",
  );

  onProgress?.({ stage: "Drawing", ratio: 0.4 });
  await bakeAnnotations(doc, lib, pages, signal);

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

export const pdfEditorDescriptor: ConversionDescriptor = {
  id: "pdf-editor",
  fromLabel: "PDF",
  toLabel: "Edited PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  convert: convertPdfEditor,
};

// `clamp01` is exported for the component layer to share one fraction-clamp rule.
export { clamp01 };
