// Redact PDF — TRUE redaction. The user draws black boxes over page regions; on
// convert we RASTERISE every page (render it to a Canvas with pdf.js) with the
// chosen boxes painted opaque black, then rebuild the document as an image-only
// PDF. Because each page becomes a flat raster, the underlying text/vector
// content — both under the boxes AND everywhere else — is genuinely gone: there
// is no hidden text layer left to copy, search, or recover. This is the honest
// trade-off of real redaction: the output is image-only, so it is no longer
// selectable/searchable text.
//
// Contrast with "draw a black rectangle in a PDF editor": that only OVERLAYS an
// opaque shape on top of the original text, which still sits underneath and is
// trivially recovered (select-all, copy, or strip the overlay). We do not do
// that. We throw the original content away by flattening to pixels.
//
// pdf.js (`pdfjs-dist`, multi-MB) is the same engine pdf-image.ts uses to render
// pages; we reuse the shared loadPdfjs loader so it code-splits into this route
// chunk only. pdf-lib (pure JS) rebuilds the output from the rendered PNGs, the
// same embedPng + addPage + drawImage path images-to-pdf.ts uses.
//
// REDACTIONS option: options.redactions is a JSON-serialisable array of
//   { page: number (1-based), rects: { x, y, w, h }[] }
// where each rect's coordinates are FRACTIONS of the page (0..1, origin
// top-left). Fractions keep the boxes resolution-independent: the UI draws them
// over a preview at one scale, and they map cleanly onto the render canvas at
// 150 DPI here regardless of the page's real point size.
//
// SEARCH / AUTO-DETECT (additive): on top of the manual boxes the user can ask
// us to FIND text and redact it automatically:
//   • options.searchText  — a literal string to match (case-insensitive).
//   • options.detectEmail / detectPhone / detectCreditCard / detectSSN — booleans
//     enabling the corresponding PII regex preset.
// For each page we read pdf.js' getTextContent(), run the active patterns over
// every text item's string, and turn each match into a fractional rect via the
// pure findTextRects helper below (its geometry math is the main quality lever
// and is unit-tested with synthetic items). Those auto rects are MERGED with the
// page's manual rects and fed into the SAME rasterise-redact path — so a matched
// region is flattened to opaque black exactly like a hand-drawn box, with the
// underlying text genuinely gone. The manual-box flow is unchanged; this is
// purely additive.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadPdfjs, type PdfjsModule, type PdfDocument, type PdfPage } from "./pdfjs";

// Render resolution. PDF user-space is 72 DPI at scale 1, so 150 DPI = scale
// 150/72 ≈ 2.083 — sharp enough that flattened text stays readable, modest
// enough to keep canvases and the output PDF reasonable. Mirrors the DPI math in
// pdf-image.ts (computePageScaleAtDpi) but fixed, since redaction has no quality
// knob — it always rasterises at this one resolution.
const RENDER_DPI = 150;
// Hard cap on either rendered dimension, so a poster-sized page can't demand a
// canvas of tens of millions of pixels per side and exhaust memory. Same cap as
// pdf-image.ts's MAX_DIMENSION.
const MAX_DIMENSION = 4000;

// A single redaction rectangle in FRACTIONAL page coordinates (0..1, origin
// top-left). Resolution-independent by construction.
export interface RedactionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// All redaction boxes for one 1-based page.
export interface PageRedactions {
  page: number;
  rects: RedactionRect[];
}

// ── Search / PII auto-detection ──────────────────────────────────────────────
//
// A minimal structural view of ONE item from pdf.js' page.getTextContent().items.
// We depend on exactly four fields. `transform` is the item's 2×3 affine matrix
// [a, b, c, d, e, f] in PDF user space (origin BOTTOM-left): (e, f) is the text
// baseline's lower-left corner, and the glyph run extends `width` to the right.
// `height` is the run's height in the same user space. We keep this type LOCAL
// (rather than widen pdfjs.ts) because pdfjs.ts is not ours to touch here and the
// text-content slice is only needed by this converter.
export interface TextContentItem {
  str: string;
  // [a, b, c, d, e, f]; (e, f) = baseline lower-left in PDF points (bottom-left origin).
  transform: number[];
  width: number; // run width in PDF points
  height: number; // run height in PDF points (≈ font size)
}

// The size of the page in PDF points (a viewport at scale 1). getTextContent's
// transforms are in this same unbScaled user space, so widths/positions divide
// cleanly into fractions of these.
export interface PageSize {
  width: number;
  height: number;
}

// A compiled PII preset: a key matching the option flag, plus its regex. The
// regex is applied with the global flag so we can walk EVERY match in an item.
export interface PiiPreset {
  key: PiiPresetKey;
  build: () => RegExp; // fresh RegExp per call — global regexes carry mutable lastIndex
}

export type PiiPresetKey = "email" | "phone" | "creditCard" | "ssn";

// PII regexes. Each is deliberately LINEAR-TIME and free of nested/overlapping
// quantifiers so it cannot catastrophically backtrack on adversarial input
// (e.g. a long run of digits/letters). The guard in every case: no quantifier
// sits inside another quantifier over an overlapping character class, and the
// pieces are anchored by literal separators or fixed-length blocks.
//
// EMAIL — local-part of one-or-more non-space/non-@ chars, an @, then a dotted
// domain of letter/digit/hyphen labels ending in a 2+ letter TLD. The local and
// domain classes are disjoint around the literal "@" and "." separators, so
// there is no ambiguous overlap to backtrack across.
function emailRegex(): RegExp {
  return /[^\s@]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
}

// PHONE (North-American-style) — optional +1 / 1 country prefix, then three
// blocks of digits (3-3-4) separated by an OPTIONAL single space / dot / hyphen,
// with an optional parenthesised area code. Each separator is a fixed optional
// single character (no repetition), and every digit block is a FIXED length, so
// the pattern is strictly linear with no backtracking surface. A leading/trailing
// boundary keeps it from biting into a longer digit run.
function phoneRegex(): RegExp {
  return /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
}

// CREDIT-CARD — 13 to 16 digits in groups separated by an optional single space
// or hyphen. Modelled as a first digit then 12-15 "optional-separator + digit"
// units; because each unit consumes exactly one digit (the separator is a single
// optional char, not a repeat), the {12,15} bound is a hard linear cap — no
// nested repetition, so no backtracking blow-up. Boundaries stop it matching
// inside a longer number. (Length only — Luhn validation is out of scope for v1;
// over-matching a non-card 16-digit run is a SAFE error for redaction.)
function creditCardRegex(): RegExp {
  return /(?<!\d)\d(?:[\s-]?\d){12,15}(?!\d)/g;
}

// SSN (US, ###-##-####) — three fixed-length digit blocks joined by an optional
// single space or hyphen. All blocks are fixed length and the separators are
// single optional chars, so the pattern is linear. Boundaries prevent it from
// matching inside a longer digit run.
function ssnRegex(): RegExp {
  return /(?<!\d)\d{3}[\s-]?\d{2}[\s-]?\d{4}(?!\d)/g;
}

// The preset registry. Keys mirror the option flags so the engine can map a set
// of enabled flags to the regexes to run.
export const PII_PRESETS: PiiPreset[] = [
  { key: "email", build: emailRegex },
  { key: "phone", build: phoneRegex },
  { key: "creditCard", build: creditCardRegex },
  { key: "ssn", build: ssnRegex },
];

// Convert ONE text item into the fractional bounding rect (0..1, origin
// top-left) it occupies on a page of `pageSize` points. APPROXIMATION (v1): we
// use the item's FULL bounding box derived from its transform — (e, f) is the
// baseline lower-left, `width` the run width, `height` the run height — rather
// than the tight box of a substring. The PDF y axis is bottom-left, so we flip:
//   top    = pageH - (f + height)   (baseline + ascent, in points from the top)
//   bottom = pageH - f
// then divide by pageW/pageH to get fractions. When `frac` (matchStart/matchEnd
// as a 0..1 share of the item string) is given, we narrow the x-span
// PROPORTIONALLY to that substring — a good approximation for the typical
// roughly-monospaced run pdf.js emits, and a strict superset is acceptable for
// redaction (redacting a hair extra is safe; redacting too little is not). The
// result is clamped to the page so a slightly-off transform can't escape it.
export function textItemToRect(
  item: TextContentItem,
  pageSize: PageSize,
  frac?: { start: number; end: number },
): RedactionRect | null {
  const pageW = pageSize.width;
  const pageH = pageSize.height;
  if (!(pageW > 0) || !(pageH > 0)) return null;
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6) return null;
  const e = t[4];
  const f = t[5];
  const w = item.width;
  const h = item.height;
  if (![e, f, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  // A zero/negative height run (e.g. a marked-content artefact) has no paintable
  // box — skip rather than emit a degenerate rect.
  if (!(h > 0) || !(w > 0)) return null;

  // Proportional substring narrowing along x. start/end are 0..1 shares of the
  // item string; full item when omitted. Clamp so a bad share can't invert.
  let x0 = e;
  let x1 = e + w;
  if (frac) {
    const s = clamp01(Math.min(frac.start, frac.end));
    const en = clamp01(Math.max(frac.start, frac.end));
    x0 = e + w * s;
    x1 = e + w * en;
  }

  // PDF (bottom-left) → fractional top-left.
  const fx0 = clamp01(x0 / pageW);
  const fx1 = clamp01(x1 / pageW);
  const fyTop = clamp01((pageH - (f + h)) / pageH);
  const fyBot = clamp01((pageH - f) / pageH);

  const rx = Math.min(fx0, fx1);
  const ry = Math.min(fyTop, fyBot);
  const rw = Math.abs(fx1 - fx0);
  const rh = Math.abs(fyBot - fyTop);
  if (!(rw > 0) || !(rh > 0)) return null;
  return { x: rx, y: ry, w: rw, h: rh };
}

// Pure, DOM-free matcher (the headline quality lever — unit-tested with synthetic
// items). Given a page's text items, the page size in points, the active PII
// preset keys, and an optional literal search term, return the fractional rects
// to redact. Logic:
//   • For each item, run every active regex preset over item.str. Each match
//     yields a rect narrowed to the matched substring's proportional x-span.
//   • If a non-empty search term is given, find EVERY case-insensitive
//     occurrence of it in item.str and redact each (also substring-narrowed).
// A search term and presets compose (both contribute rects). Items with no match
// contribute nothing. The term is matched literally (escaped), not as a regex,
// so user input like "a.b" matches the literal text, never a wildcard.
export function findTextRects(
  items: TextContentItem[],
  pageSize: PageSize,
  activePresetKeys: PiiPresetKey[],
  searchTerm?: string,
): RedactionRect[] {
  const rects: RedactionRect[] = [];
  if (!Array.isArray(items) || items.length === 0) return rects;

  const presets = PII_PRESETS.filter((p) => activePresetKeys.includes(p.key));
  const term = typeof searchTerm === "string" ? searchTerm.trim() : "";
  const termRegex = term ? new RegExp(escapeRegExp(term), "gi") : null;

  for (const item of items) {
    const str = item?.str;
    if (typeof str !== "string" || str.length === 0) continue;

    // PII presets.
    for (const preset of presets) {
      collectMatches(preset.build(), str, item, pageSize, rects);
    }
    // Literal search term.
    if (termRegex) {
      termRegex.lastIndex = 0;
      collectMatches(termRegex, str, item, pageSize, rects);
    }
  }
  return rects;
}

// Walk every match of a GLOBAL regex over `str`, turning each into a
// substring-narrowed rect appended to `out`. Guards against a zero-width match
// (which would otherwise spin lastIndex forever) by advancing past it.
function collectMatches(
  re: RegExp,
  str: string,
  item: TextContentItem,
  pageSize: PageSize,
  out: RedactionRect[],
): void {
  const len = str.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const matched = m[0];
    if (matched.length === 0) {
      // Zero-width match — advance manually so exec can't loop forever.
      re.lastIndex += 1;
      continue;
    }
    const start = m.index;
    const end = start + matched.length;
    const rect = textItemToRect(item, pageSize, {
      start: start / len,
      end: end / len,
    });
    if (rect) out.push(rect);
  }
}

// Escape a literal string for safe embedding in a RegExp, so a search term with
// regex metacharacters ("(", ".", "$"…) matches those characters literally.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// pdf.js' getTextContent() returns { items: (TextItem | TextMarkedContent)[] }.
// Marked-content entries have no `str`/`transform`, so we narrow to the text
// items we can place. This structural type stays LOCAL (pdfjs.ts is not editable
// here) and is intentionally permissive — it's cast onto the page object below.
interface PageWithTextContent {
  getTextContent?: () => Promise<{ items: unknown[] }>;
}

// Read a page's text items into the structural slice findTextRects consumes.
// Best-effort: a page without getTextContent (or that throws) yields []
// — auto-detect simply finds nothing on it, and the page still rasterises (which
// is itself a safe redaction outcome). Marked-content entries (no str/transform)
// are filtered out.
async function readTextItems(page: PdfPage): Promise<TextContentItem[]> {
  const withText = page as PageWithTextContent;
  if (typeof withText.getTextContent !== "function") return [];
  let content: { items: unknown[] };
  try {
    content = await withText.getTextContent();
  } catch {
    return [];
  }
  const items: TextContentItem[] = [];
  for (const raw of content.items ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (
      typeof o.str === "string" &&
      Array.isArray(o.transform) &&
      typeof o.width === "number" &&
      typeof o.height === "number"
    ) {
      items.push({
        str: o.str,
        transform: o.transform as number[],
        width: o.width,
        height: o.height,
      });
    }
  }
  return items;
}

// Module-level pdf.js singleton, set once by loadEngine via the shared loader and
// reused across conversions. Same pattern as pdf-image.ts.
let pdfjs: PdfjsModule | null = null;

// Throw the canonical CANCELLED error if the caller aborted. Called at each async
// boundary AND between pages so a multi-page redaction stops promptly mid-run.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Reject a non-PDF up front with a non-recoverable error — retrying the same file
// can't help. We require the exact PDF MIME type (browsers report it reliably).
function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// Pure helper (DOM-free, unit-tested): convert a FRACTIONAL rect (0..1, origin
// top-left) to integer CANVAS PIXEL coordinates for a canvas of canvasW × canvasH.
// Clamps to the canvas so a slightly-out-of-range box (rounding, a drag past the
// edge) still paints inside the page rather than off it, and never emits a
// negative width/height. A fully out-of-bounds or zero-area rect yields a zero-
// area pixel rect (the caller can skip it; fillRect of 0 area is a harmless no-op).
export function rectToPixels(
  rect: RedactionRect,
  canvasW: number,
  canvasH: number,
): { x: number; y: number; w: number; h: number } {
  const W = canvasW > 0 ? canvasW : 0;
  const H = canvasH > 0 ? canvasH : 0;
  // Normalise so a rect given with negative width/height (drawn right-to-left or
  // bottom-to-top) is treated as its absolute span.
  const fx1 = Math.min(rect.x, rect.x + rect.w);
  const fy1 = Math.min(rect.y, rect.y + rect.h);
  const fx2 = Math.max(rect.x, rect.x + rect.w);
  const fy2 = Math.max(rect.y, rect.y + rect.h);
  // Fraction → pixels, clamped to the canvas on both corners.
  const px1 = Math.round(clamp01(fx1) * W);
  const py1 = Math.round(clamp01(fy1) * H);
  const px2 = Math.round(clamp01(fx2) * W);
  const py2 = Math.round(clamp01(fy2) * H);
  return { x: px1, y: py1, w: Math.max(0, px2 - px1), h: Math.max(0, py2 - py1) };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Render scale for an explicit DPI, clamped so neither axis exceeds MAX_DIMENSION
// (preserving aspect ratio). Same shape as pdf-image.ts's computePageScaleAtDpi
// but inlined here since redaction's resolution is fixed.
function scaleForPage(naturalWidth: number, naturalHeight: number): { scale: number; width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { scale: 1, width: 1, height: 1 };
  }
  let scale = RENDER_DPI / 72;
  const longest = Math.max(naturalWidth, naturalHeight);
  const cappedScale = MAX_DIMENSION / longest;
  if (scale > cappedScale) scale = cappedScale;
  if (!(scale > 0)) scale = 1;
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  return { scale, width, height };
}

// Parse options.redactions into a Map of 1-based page → list of fractional rects.
// Tolerant: a malformed entry (missing page, non-array rects, non-finite coords)
// is skipped rather than throwing — a redaction that can't be understood simply
// isn't applied, and the page still rasterises (which is itself a safe outcome,
// since rasterising already removes any selectable text). Returns an empty Map
// when the option is absent/garbage; the conversion then flattens every page with
// no boxes, which is a valid (if box-less) redaction request.
function parseRedactions(options: Record<string, unknown> | undefined): Map<number, RedactionRect[]> {
  const map = new Map<number, RedactionRect[]>();
  const raw = options?.redactions;
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const page = (entry as { page?: unknown }).page;
    const rects = (entry as { rects?: unknown }).rects;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) continue;
    if (!Array.isArray(rects)) continue;
    const clean: RedactionRect[] = [];
    for (const r of rects) {
      if (!r || typeof r !== "object") continue;
      const { x, y, w, h } = r as Record<string, unknown>;
      if (
        typeof x === "number" && typeof y === "number" &&
        typeof w === "number" && typeof h === "number" &&
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
      ) {
        clean.push({ x, y, w, h });
      }
    }
    if (clean.length === 0) continue;
    const existing = map.get(page);
    if (existing) existing.push(...clean);
    else map.set(page, clean);
  }
  return map;
}

// The parsed search/auto-detect request: the literal term (trimmed; "" when
// none) and the set of enabled PII preset keys. Derived from options so the
// convert loop knows whether to bother reading text content at all.
interface SearchRequest {
  term: string;
  presetKeys: PiiPresetKey[];
}

// Map each PII preset to the boolean option flag that enables it. The UI writes
// these flat booleans (one checkbox each); absent/false means the preset is off.
const PRESET_OPTION_FLAGS: Record<PiiPresetKey, string> = {
  email: "detectEmail",
  phone: "detectPhone",
  creditCard: "detectCreditCard",
  ssn: "detectSSN",
};

// Read the search term + enabled presets out of options. Tolerant: a missing /
// wrong-typed flag is treated as off, and a non-string searchText as empty.
function parseSearchRequest(options: Record<string, unknown> | undefined): SearchRequest {
  const rawTerm = options?.searchText;
  const term = typeof rawTerm === "string" ? rawTerm.trim() : "";
  const presetKeys: PiiPresetKey[] = [];
  for (const preset of PII_PRESETS) {
    if (options?.[PRESET_OPTION_FLAGS[preset.key]] === true) presetKeys.push(preset.key);
  }
  return { term, presetKeys };
}

// True when no search term and no presets are active — the convert loop can then
// skip getTextContent entirely (a pure manual-box redaction, unchanged).
function searchRequestIsEmpty(req: SearchRequest): boolean {
  return req.term.length === 0 && req.presetKeys.length === 0;
}

// Cheap overlap dedupe: drop any rect fully contained within another rect in the
// list (auto-detect can re-emit the same region across overlapping presets, e.g.
// a string that looks like both a phone and a card). O(n²) but n is the number of
// matches on ONE page — tiny in practice. We DON'T merge partial overlaps (that
// needs union geometry); a partial overlap just paints twice, which is harmless
// for opaque black boxes. Exported + pure so the merge contract is unit-testable.
export function mergeRects(manual: RedactionRect[], auto: RedactionRect[]): RedactionRect[] {
  const all = [...manual, ...auto];
  const kept: RedactionRect[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    let contained = false;
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue;
      const b = all[j];
      // a is contained in b when b covers a on both axes. On an exact-duplicate
      // tie, keep the LATER index only (i < j) so we don't drop both copies.
      if (contains(b, a) && (!contains(a, b) || i < j)) {
        contained = true;
        break;
      }
    }
    if (!contained) kept.push(a);
  }
  return kept;
}

// True when `outer` fully covers `inner` (inclusive), in fractional coords.
function contains(outer: RedactionRect, inner: RedactionRect): boolean {
  const ox2 = outer.x + outer.w;
  const oy2 = outer.y + outer.h;
  const ix2 = inner.x + inner.w;
  const iy2 = inner.y + inner.h;
  return outer.x <= inner.x && outer.y <= inner.y && ox2 >= ix2 && oy2 >= iy2;
}

// Promisified canvas.toBlob → PNG. A null blob (encoder refused, usually a
// transient memory pinch) is recoverable, so the UI offers a retry. PNG keeps the
// flattened page lossless, which matters for a redaction (no compression artefact
// near a redaction edge that could hint at what was under it).
function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else
          reject(
            new ConversionError("We couldn't finish encoding a page.", {
              code: "ENCODE_FAILED",
              recoverable: true,
              technical: "canvas.toBlob returned null for image/png.",
            }),
          );
      },
      "image/png",
    );
  });
}

// loadEngine runs once before the first conversion (the labelled one-time setup
// moment). Delegates to the shared loadPdfjs, which dynamically imports pdf.js and
// wires its worker exactly once. Idempotent.
async function loadEngine(): Promise<void> {
  if (pdfjs) return;
  pdfjs = await loadPdfjs();
}

async function convertRedactPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  if (!pdfjs) {
    // loadEngine should have run first (the UI calls it); guard defensively so a
    // direct caller gets a clear path rather than a crash.
    await loadEngine();
  }
  const lib = pdfjs!;

  const redactions = parseRedactions(options);
  const search = parseSearchRequest(options);
  const autoDetect = !searchRequestIsEmpty(search);

  onProgress?.({ stage: "Reading PDF" });
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  const task = lib.getDocument({ data });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new ConversionError("We couldn't read this PDF — the file may be damaged or empty.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  // Lazy-load pdf-lib for the rebuild (stays in this route chunk).
  const { PDFDocument } = await import("pdf-lib");

  try {
    const numPages = doc.numPages;
    if (numPages < 1) {
      throw new ConversionError("This PDF has no pages to redact.", {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: "pdf.js reported numPages < 1.",
      });
    }

    const out = await PDFDocument.create();

    for (let n = 1; n <= numPages; n++) {
      throwIfAborted(signal);
      onProgress?.({ stage: `Redacting page ${n}`, ratio: (n - 1) / numPages });

      const page = await doc.getPage(n);
      let pngBytes: Uint8Array;
      let canvasW: number;
      let canvasH: number;
      try {
        const natural = page.getViewport({ scale: 1 });
        const { scale, width, height } = scaleForPage(natural.width, natural.height);
        canvasW = width;
        canvasH = height;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new ConversionError("Your browser couldn't open a drawing canvas.", {
            code: "CANVAS_UNAVAILABLE",
            recoverable: false,
            technical: "HTMLCanvasElement.getContext('2d') returned null.",
          });
        }
        // White backdrop: PDF pages can be transparent, and the output is opaque
        // (image-only), so a transparent region must render as white, not black —
        // black would look like an unintended redaction.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);

        // 1) Render the real page content.
        await page.render({ canvasContext: ctx, viewport }).promise;
        throwIfAborted(signal);

        // 1b) Auto-detect: when a search term or any PII preset is active, read the
        //     page's text layer and turn each match into a fractional rect. The
        //     text geometry is in PDF points (the scale-1 viewport), which is the
        //     space findTextRects expects. Skipped entirely for a pure manual-box
        //     redaction so we never pay the getTextContent cost we don't need.
        let autoRects: RedactionRect[] = [];
        if (autoDetect) {
          const items = await readTextItems(page);
          throwIfAborted(signal);
          autoRects = findTextRects(
            items,
            { width: natural.width, height: natural.height },
            search.presetKeys,
            search.term,
          );
        }

        // 2) Paint the redaction boxes for THIS page in solid opaque black, on top
        //    of the rendered content. After encoding, the pixels under each box are
        //    pure black with no recoverable layer beneath — the content is gone.
        //    Manual + auto rects are MERGED (overlaps deduped) and painted through
        //    the SAME rasterise path, so an auto-detected region is flattened
        //    exactly like a hand-drawn one.
        const manualRects = redactions.get(n) ?? [];
        const rects = autoDetect ? mergeRects(manualRects, autoRects) : manualRects;
        if (rects.length > 0) {
          ctx.fillStyle = "#000000";
          for (const r of rects) {
            const px = rectToPixels(r, width, height);
            if (px.w > 0 && px.h > 0) ctx.fillRect(px.x, px.y, px.w, px.h);
          }
        }

        const blob = await encodePng(canvas);
        pngBytes = new Uint8Array(await blob.arrayBuffer());
      } finally {
        if (typeof page.cleanup === "function") page.cleanup();
      }

      throwIfAborted(signal);

      // 3) Embed the flattened page as a full-page image; the new PDF page is
      //    sized exactly to the raster (1px = 1pt at 72 DPI in pdf-lib).
      const img = await out.embedPng(pngBytes);
      const pdfPage = out.addPage([canvasW, canvasH]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: canvasW, height: canvasH });
    }

    throwIfAborted(signal);
    onProgress?.({ stage: "Saving", ratio: 1 });

    const saved = await out.save();
    // Copy into a fresh Uint8Array so the underlying buffer is a plain ArrayBuffer
    // (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob requires ArrayBuffer).
    const outBlob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

    const base = replaceExtension(file.name, "").replace(/\.$/, "");
    return {
      blob: outBlob,
      filename: `${base}-redacted.pdf`,
      mimeType: "application/pdf",
      inputSize: file.size,
      outputSize: outBlob.size,
    };
  } finally {
    // Tear down the document + worker transport on every exit path, using
    // whichever pdf.js cleanup API this version exposes (see pdf-image.ts for why
    // both are guarded — the "doc.destroy is not a function" crash).
    try {
      if (typeof doc.cleanup === "function") doc.cleanup();
    } catch {
      /* best-effort */
    }
    try {
      if (typeof doc.destroy === "function") await doc.destroy();
      else if (typeof task.destroy === "function") await task.destroy();
    } catch {
      /* best-effort */
    }
  }
}

export const redactPdfDescriptor: ConversionDescriptor = {
  id: "redact-pdf",
  fromLabel: "PDF",
  toLabel: "Redacted PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  loadEngine,
  // pdf.js (pdfjs-dist) is the multi-MB one-time download shown in the setup
  // state while loadEngine runs.
  setupSizeLabel: "≈ 5 MB",
  convert: convertRedactPdf,
};
