// Reorder PDF Pages — rearrange pages in a PDF according to a user-supplied
// order string like "3,1,2". The conversion creates a new PDFDocument, copies
// pages from the source in the requested order, and saves.
//
// The `order` control is a free-text field. The converter accepts 1-based page
// numbers separated by commas (whitespace is ignored). Validation enforces:
//   - Every referenced page must be in range [1, pageCount].
//   - Every page must appear exactly once (no duplicates, no omissions).
//
// A17 adds three sibling operations behind an `operation` switch (default
// "reorder", so the existing path is byte-identical):
//   - "insert-blank" — drop a blank page at a chosen position (size copied from a
//     neighbour page, or a standard size like A4 / Letter).
//   - "duplicate"    — insert a copy of a chosen page right after it.
//   - "mix"          — interleave the current PDF with a SECOND user-supplied PDF
//     (A1,B1,A2,B2,…) for recombining a duplex scan. The 2nd PDF arrives as a
//     File under options.secondPdf via the shared "file" control.
// The pure index math behind each (interleave / insert / duplicate / orientation)
// is extracted as DOM-free helpers so it is unit-testable without a real PDF.
//
// pdf-lib is pure JS — no WASM, no browser APIs — so no `loadEngine` is needed.
// The library is lazy-loaded inside `convert` so it stays in the /reorder-pdf-pages
// route chunk only.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// ── A17 pure helpers (no pdf-lib, no DOM) ───────────────────────────────────

// One step in an interleave sequence: which source ("a" = current PDF, "b" =
// the second) and the 0-based page index within it.
export interface InterleaveStep {
  src: "a" | "b";
  index: number;
}

// The duplex-scan recombine sequence: A1,B1,A2,B2,… then the longer source's
// remaining tail. With aCount === bCount it perfectly alternates; otherwise the
// surplus pages of whichever side is longer follow in order. Pure index math so
// it can be asserted without loading any PDF.
export function interleave(aCount: number, bCount: number): InterleaveStep[] {
  const steps: InterleaveStep[] = [];
  const max = Math.max(aCount, bCount);
  for (let i = 0; i < max; i++) {
    if (i < aCount) steps.push({ src: "a", index: i });
    if (i < bCount) steps.push({ src: "b", index: i });
  }
  return steps;
}

// Resolve a 1-based "insert before page N" target into a clamped 0-based slot in
// [0, pageCount]. A target below 1 inserts at the front; past the end (or
// non-finite) appends. pdf-lib's insertPage takes exactly this 0-based slot.
export function insertIndex(target: number, pageCount: number): number {
  if (!Number.isFinite(target)) return pageCount;
  const slot = Math.round(target) - 1; // 1-based "before page N" → 0-based slot
  if (slot < 0) return 0;
  if (slot > pageCount) return pageCount;
  return slot;
}

// The 0-based copy-order that reproduces every page once AND inserts a second
// copy of `dupPage` (1-based) directly after it. An out-of-range dupPage yields
// the untouched natural sequence (the caller validates separately). Drives a
// single copyPages call, so duplicating is just "the natural order with one
// index repeated".
export function duplicateSequence(pageCount: number, dupPage: number): number[] {
  const out: number[] = [];
  const dup = Math.round(dupPage) - 1; // 1-based → 0-based
  for (let i = 0; i < pageCount; i++) {
    out.push(i);
    if (i === dup) out.push(i); // the copy follows its original
  }
  return out;
}

// Orientation of a page from its dimensions. Landscape ⇔ width strictly greater
// than height; a square (or portrait) counts as portrait. Pure predicate so the
// orientation filter can be reasoned about (and combined with rotate/reorder in
// a sibling tool) without a PDF.
export function isLandscape(width: number, height: number): boolean {
  return width > height;
}

export type Orientation = "portrait" | "landscape" | "any";

// True when a page of the given size matches the requested orientation. "any"
// matches everything — the neutral default that leaves every page targeted.
export function matchesOrientation(
  width: number,
  height: number,
  orientation: Orientation,
): boolean {
  if (orientation === "any") return true;
  return orientation === "landscape" ? isLandscape(width, height) : !isLandscape(width, height);
}

// Parse a comma-separated order string into a 0-based index array.
// Returns null if the string is syntactically invalid.
function parseOrder(raw: string): number[] | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) return null;
  const indices: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) return null;
    indices.push(n - 1); // convert to 0-based
  }
  return indices;
}

// Validate the parsed 0-based indices against the actual page count.
// Every page must appear exactly once and be in range.
function validateOrder(indices: number[], pageCount: number): string | null {
  if (indices.length !== pageCount) {
    return `The order must reference all ${pageCount} page(s) exactly once — got ${indices.length} entr${indices.length === 1 ? "y" : "ies"}.`;
  }
  const seen = new Set<number>();
  for (const idx of indices) {
    if (idx < 0 || idx >= pageCount) {
      return `Page ${idx + 1} is out of range — this document has ${pageCount} page(s).`;
    }
    if (seen.has(idx)) {
      return `Page ${idx + 1} appears more than once in the order.`;
    }
    seen.add(idx);
  }
  return null;
}

type OperationKey = "reorder" | "insert-blank" | "duplicate" | "mix";
const OPERATIONS: readonly OperationKey[] = ["reorder", "insert-blank", "duplicate", "mix"];

// Reject anything that isn't a PDF — shared by every operation. Hoisted out of
// the reorder body so the new paths assert the same guard with the same message.
function assertPdf(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// Dispatch on the `operation` control. Default "reorder" (by absence or an
// unknown value) runs the unchanged reorder path, so existing calls — and the
// descriptor's defaultOptions { order: "" } — produce byte-identical output.
async function convertReorderPdfPages(input: ConversionInput): Promise<ConversionResult> {
  const opRaw = input.options?.operation;
  const operation: OperationKey =
    typeof opRaw === "string" && (OPERATIONS as readonly string[]).includes(opRaw)
      ? (opRaw as OperationKey)
      : "reorder";

  if (operation === "insert-blank") return convertInsertBlank(input);
  if (operation === "duplicate") return convertDuplicate(input);
  if (operation === "mix") return convertMix(input);
  return convertReorder(input);
}

async function convertReorder(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  assertPdf(file);

  // Read the order option defensively.
  const rawOrder =
    typeof options?.order === "string" ? (options.order as string).trim() : "";

  if (rawOrder === "") {
    throw new ConversionError("Enter a page order before converting — for example: 3,1,2.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: "options.order was empty or missing.",
    });
  }

  const parsedIndices = parseOrder(rawOrder);
  if (parsedIndices === null) {
    throw new ConversionError(
      "The page order must be comma-separated page numbers — for example: 3,1,2.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: `Could not parse order string: "${rawOrder}".`,
      },
    );
  }

  // Lazy-load pdf-lib so it stays in the /reorder-pdf-pages route chunk only.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  let src: Awaited<ReturnType<typeof PDFDocument.load>>;
  let pageCount: number;
  try {
    const bytes = await file.arrayBuffer();
    src = await PDFDocument.load(bytes);
    // getPageCount() accesses the page tree — a corrupt/malformed PDF may fail here.
    pageCount = src.getPageCount();
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError("We couldn't read this PDF — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  const validationError = validateOrder(parsedIndices, pageCount);
  if (validationError) {
    throw new ConversionError(validationError, {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Validation failed for order "${rawOrder}" against a ${pageCount}-page document.`,
    });
  }

  onProgress?.({ stage: "Reordering" });

  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, parsedIndices);
  for (const page of pages) {
    out.addPage(page);
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const saved = await out.save();
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  return {
    blob,
    filename: file.name,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Read a 1-based page option (insertAt / duplicatePage) defensively, defaulting
// when missing or unparseable. Bounds are NOT enforced here — the helpers clamp
// (insertIndex) or no-op (duplicateSequence) on out-of-range input.
function readPageOption(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// Load the source PDF, surfacing a damaged file as DECODE_FAILED. Shared by the
// new operations so they read the same failure shape as the reorder path.
async function loadSource(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PDFDocument: any,
  file: File,
): Promise<{ doc: Awaited<ReturnType<typeof import("pdf-lib").PDFDocument.load>>; pageCount: number }> {
  try {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    return { doc, pageCount: doc.getPageCount() };
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError("We couldn't read this PDF — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

function finish(file: File, saved: Uint8Array): ConversionResult {
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });
  return {
    blob,
    filename: file.name,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Insert a blank page at a chosen 1-based position. The blank's size is either
// copied from a neighbour page ("match" — the page that will sit just before it,
// or the first page when inserting at the front) or a standard size (A4 /
// Letter). The rest of the document is untouched.
async function convertInsertBlank(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertPdf(file);

  const { PDFDocument, PageSizes } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });
  const { doc, pageCount } = await loadSource(PDFDocument, file);
  throwIfAborted(signal);

  const slot = insertIndex(readPageOption(options?.insertAt, pageCount + 1), pageCount);
  const blankSize = typeof options?.blankSize === "string" ? options.blankSize : "match";

  onProgress?.({ stage: "Inserting blank page" });

  // Resolve the blank page's dimensions. "match" copies the neighbour that will
  // sit just before the new page (or the first page when inserting at the front);
  // a standard key picks that PageSizes entry; an empty doc falls back to A4.
  let size: [number, number];
  if (blankSize !== "match" && blankSize in PageSizes) {
    size = PageSizes[blankSize as keyof typeof PageSizes];
  } else if (pageCount > 0) {
    const neighbour = doc.getPage(Math.max(0, Math.min(slot, pageCount - 1)));
    const { width, height } = neighbour.getSize();
    size = [width, height];
  } else {
    size = PageSizes.A4;
  }

  doc.insertPage(slot, size);

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving" });
  return finish(file, await doc.save());
}

// Insert a copy of a chosen page right after it. Built as a single copyPages
// call over duplicateSequence(pageCount, dupPage) into a fresh document, so the
// "duplicate" is literally the natural order with one index repeated — the same
// copy-without-re-encode path the reorder operation uses.
async function convertDuplicate(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertPdf(file);

  const { PDFDocument } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });
  const { doc: src, pageCount } = await loadSource(PDFDocument, file);
  throwIfAborted(signal);

  const dupPage = readPageOption(options?.duplicatePage, 0);
  if (dupPage < 1 || dupPage > pageCount) {
    throw new ConversionError(
      `Choose a page between 1 and ${pageCount} to duplicate.`,
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: `duplicatePage ${dupPage} is out of range for a ${pageCount}-page document.`,
      },
    );
  }

  onProgress?.({ stage: "Duplicating page" });
  const indices = duplicateSequence(pageCount, dupPage);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  for (const page of pages) out.addPage(page);

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving" });
  return finish(file, await out.save());
}

// Mix / interleave the current PDF with a SECOND user-supplied PDF (a duplex-scan
// recombine: fronts in one file, backs in another). The 2nd PDF arrives as a File
// under options.secondPdf via the shared "file" control. Pages are copied in
// interleave() order (A1,B1,A2,B2,… then the longer source's tail) into a fresh
// document — no re-encoding.
async function convertMix(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertPdf(file);

  // The 2nd PDF rides through options.secondPdf as a File (the "file" control's
  // value is merged into options by the tool). A missing one is recoverable.
  const second = options?.secondPdf instanceof File ? options.secondPdf : null;
  if (!second) {
    throw new ConversionError("Choose a second PDF to interleave with this one.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: "Mix selected but no secondPdf File was provided in options.",
    });
  }
  if (second.type !== "application/pdf") {
    throw new ConversionError("The second file must be a PDF.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Expected application/pdf for secondPdf, received "${second.type || "unknown type"}".`,
    });
  }

  const { PDFDocument } = await import("pdf-lib");
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });
  const { doc: a, pageCount: aCount } = await loadSource(PDFDocument, file);
  throwIfAborted(signal);
  const { doc: b, pageCount: bCount } = await loadSource(PDFDocument, second);
  throwIfAborted(signal);

  onProgress?.({ stage: "Interleaving" });
  const steps = interleave(aCount, bCount);
  const out = await PDFDocument.create();
  // Copy each source's needed pages in one batch, then place them per the step
  // sequence (copyPages preserves the requested index order).
  const aIdx = steps.filter((s) => s.src === "a").map((s) => s.index);
  const bIdx = steps.filter((s) => s.src === "b").map((s) => s.index);
  const aPages = await out.copyPages(a, aIdx);
  const bPages = await out.copyPages(b, bIdx);
  let ai = 0;
  let bi = 0;
  for (const step of steps) {
    out.addPage(step.src === "a" ? aPages[ai++] : bPages[bi++]);
  }

  throwIfAborted(signal);
  onProgress?.({ stage: "Saving" });
  return finish(file, await out.save());
}

export const reorderPdfPagesDescriptor: ConversionDescriptor = {
  id: "reorder-pdf-pages",
  fromLabel: "PDF",
  toLabel: "Reordered",
  accept: ["application/pdf"],
  newExtension: "pdf",
  // The default operation is "reorder" with an empty order, so out-of-the-box
  // behaviour (and every existing call) is byte-identical to before A17.
  defaultOptions: { order: "", operation: "reorder", insertAt: 1, blankSize: "match", duplicatePage: 1 },
  controls: [
    // The bespoke ReorderPdfPagesTool screen renders its own visual editor (the
    // drag grid + per-operation panels) and builds `options` by hand, so it does
    // NOT consume these declarative controls. They are declared as the canonical
    // schema for the operation set — including the existing "file" control kind
    // for the second PDF — so the descriptor is self-describing for the generic
    // ControlPanel path and for the MCP / n8n surfaces.
    {
      type: "select",
      id: "operation",
      label: "Operation",
      help: "Reorder the pages, insert a blank page, duplicate a page, or interleave a second PDF.",
      default: "reorder",
      options: [
        { value: "reorder", label: "Reorder pages" },
        { value: "insert-blank", label: "Insert blank page" },
        { value: "duplicate", label: "Duplicate a page" },
        { value: "mix", label: "Mix / interleave a second PDF" },
      ],
    },
    {
      type: "text",
      id: "order",
      label: "Page order",
      help: "Enter 1-based page numbers separated by commas. Example: 3,1,2 puts the third page first.",
      placeholder: "e.g. 3,1,2",
      default: "",
    },
    {
      type: "number",
      id: "insertAt",
      label: "Insert before page",
      help: "1-based position for the new blank page. Past the end appends it.",
      default: 1,
      min: 1,
      step: 1,
    },
    {
      type: "select",
      id: "blankSize",
      label: "Blank page size",
      help: "Match the neighbouring page, or pick a standard size.",
      default: "match",
      options: [
        { value: "match", label: "Match neighbouring page" },
        { value: "A4", label: "A4" },
        { value: "Letter", label: "Letter" },
        { value: "Legal", label: "Legal" },
      ],
    },
    {
      type: "number",
      id: "duplicatePage",
      label: "Page to duplicate",
      help: "1-based page number; a copy is inserted right after it.",
      default: 1,
      min: 1,
      step: 1,
    },
    {
      type: "file",
      id: "secondPdf",
      label: "Second PDF",
      help: "The other half of a duplex scan to interleave (A1, B1, A2, B2, …). Used only by Mix / interleave.",
      accept: ["application/pdf"],
    },
  ],
  convert: convertReorderPdfPages,
};
