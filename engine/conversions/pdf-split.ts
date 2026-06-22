// PDF Split — split a multi-page PDF into one or more PDFs, iLovePDF-style.
//
// This is a "many-out" conversion: it returns `outputs[]` so the UI renders the
// MultiResultCard with per-file download links and a "Download all (.zip)"
// action — even when a mode yields a single file (the UI still zips on demand).
//
// Modes, dispatched on `options.mode` (the custom PdfSplitTool always sends one).
// They mirror iLovePDF's Split panel:
//   - "range": options.ranges = [{from,to}, …] (1-based inclusive). With
//     options.mergeRanges true → ONE PDF with every range in order; else one PDF
//     per range. This is always "custom ranges" (no fixed-N mode).
//   - "pages": options.pageRange = a print-style string ("5-10, 13, 15-17")
//     parsed via parsePageRange against the real page count. options.mergePages
//     true → ONE PDF of the selected pages; else one PDF per selected page.
//   - "size": options.maxMb (number) → greedily pack pages into chunks, each kept
//     under maxMb best-effort. Multiple outputs; onProgress between chunks.
//   - "fixed": options.everyN (positive integer) → divide the document into
//     consecutive uniform chunks of everyN pages each (last chunk may be smaller),
//     e.g. a 10-page PDF with everyN=3 → 1-3, 4-6, 7-9, 10. onProgress per chunk.
//   - "oddeven": options.which = "odd" | "even" | "both". One PDF of all odd pages
//     and/or one PDF of all even pages (1-based: page 1 is odd). "both" yields two
//     outputs (odd then even); "odd"/"even" yield one. onProgress between outputs.
//   - "half": options.direction = "vertical" (left/right) | "horizontal"
//     (top/bottom). Each source page is duplicated and cropped to two halves via
//     its MediaBox/CropBox, doubling the page count in ONE output. onProgress per
//     source page.
// With no `mode` (or an unknown one) we fall back to the original behavior — one
// single-page PDF per page — so the descriptor stays robust if called bare.
//
//   - "bookmarks": split by the PDF's outline/bookmark tree. pdf-lib can't read
//     the outline, so this is the ONE mode that reaches for pdfjs-dist (already a
//     project dependency, decision 0007) via the shared loadPdfjs() loader. Each
//     TOP-LEVEL bookmark becomes a chapter: the chapter runs from its target page
//     up to the page just before the next chapter (the last runs to the end). A
//     PDF with no bookmarks is a recoverable UNSUPPORTED_INPUT nudge. NOTE: unlike
//     the pdf-lib-only modes this cold-loads the multi-MB pdf.js library mid-
//     convert with no labelled setup state — acceptable for this niche mode.
//
// pdf-lib is pure JS (no WASM step), so there is no `loadEngine`; the library is
// lazy-loaded inside `convert` via dynamic import so it stays out of the homepage
// chunk and only lands in the /pdf-split route bundle. The bookmarks mode
// additionally lazy-loads pdfjs-dist through the shared loadPdfjs() helper.

import type { ConversionDescriptor, ConversionInput, ConversionOutput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { parsePageRange } from "../page-range";
import { loadPdfjs, type PdfDocument } from "./pdfjs";

// pdf-lib's PDFDocument instance type, named once so helpers can be typed without
// repeating the Awaited<ReturnType<…>> dance.
type PDFDoc = Awaited<ReturnType<typeof import("pdf-lib").PDFDocument.load>>;

// cleanup param omitted: PDF split holds no native resources to release on abort.
// Throw the canonical CANCELLED error if the caller aborted. Called between
// outputs so a long split can be interrupted mid-flight.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Strip the final extension and return the basename so we can build per-file
// filenames. E.g. "report.pdf" → "report", "my.report.pdf" → "my.report".
function basename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

// Zero-pad a 1-based index for natural sort against the largest expected count.
function pad(n: number, total: number): string {
  return String(n).padStart(String(Math.max(total, 1)).length, "0");
}

// ── Bookmark helpers (pure, DOM-free, exported for unit tests) ───────────────

// Turn a flat list of top-level outline entries (each a {title, pageIndex} with a
// 0-based target page) into contiguous, non-overlapping chapter ranges over a
// `pageCount`-page document. Each chapter runs from its own start page up to the
// page just before the NEXT chapter's start; the last chapter runs to the final
// page (pageCount-1). Entries are sorted by pageIndex ascending first; multiple
// entries that land on the SAME page collapse to one (first title wins) so a page
// is never the start of two chapters. Out-of-range pageIndexes are clamped into
// [0, pageCount-1]. Empty input → [] (the caller treats that as "no bookmarks").
export function outlineEntriesToPageRanges(
  entries: { title: string; pageIndex: number }[],
  pageCount: number,
): { start: number; end: number; title: string }[] {
  if (entries.length === 0 || pageCount <= 0) return [];

  // Clamp each target into the document, then sort by page ascending. A stable
  // sort keeps the original order among same-page entries, so the FIRST one in
  // the input wins the dedupe below.
  const clamped = entries.map((e) => ({
    title: e.title,
    pageIndex: Math.min(Math.max(0, Math.floor(e.pageIndex)), pageCount - 1),
  }));
  const sorted = [...clamped].sort((a, b) => a.pageIndex - b.pageIndex);

  // Dedupe consecutive same-page starts (first wins) so each chapter has a unique
  // start page.
  const starts: { title: string; pageIndex: number }[] = [];
  for (const entry of sorted) {
    const last = starts[starts.length - 1];
    if (last && last.pageIndex === entry.pageIndex) continue;
    starts.push(entry);
  }

  // Each chapter ends one page before the next chapter starts; the last runs to
  // the end of the document.
  const ranges: { start: number; end: number; title: string }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].pageIndex;
    const end = i + 1 < starts.length ? starts[i + 1].pageIndex - 1 : pageCount - 1;
    ranges.push({ start, end, title: starts[i].title });
  }
  return ranges;
}

// Turn a bookmark title into a filesystem-safe filename stem: strip characters
// that are unsafe in filenames (path separators, control chars, the Windows
// reserved set), collapse runs of whitespace to single spaces, trim, and cap the
// length so a long heading doesn't produce an unwieldy name. An empty result
// (title was blank or all-unsafe) falls back to "part-N" using the 1-based index.
export function sanitizeTitle(title: string, index: number): string {
  const cleaned = String(title ?? "")
    // Replace filename-unsafe characters — path separators, the Windows reserved
    // set (/ \ : * ? " < > |) and ASCII control chars (\x00-\x1f) — with a space
    // so adjacent words don't fuse; the whitespace collapse below tidies it.
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned.length > 0 ? cleaned : `part-${index}`;
}

// Build one ConversionOutput by copying the given 0-based page indices (in the
// order supplied) from `src` into a fresh PDF and saving it.
async function buildOutput(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageIndices: number[],
  filename: string,
): Promise<ConversionOutput> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIndices);
  for (const page of copied) out.addPage(page);
  const bytes = await out.save();
  // Copy into a fresh Uint8Array so the underlying buffer is a plain ArrayBuffer
  // (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob requires ArrayBuffer).
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  return { blob, filename, mimeType: "application/pdf", size: bytes.length };
}

// ── Mode: range ───────────────────────────────────────────────────────────────
// options.ranges = [{from,to}] (1-based inclusive). Each range is clamped to the
// document and normalised (reversed ranges are flipped). With mergeRanges, all
// ranges flow into ONE output in the order given; otherwise one output per range.
async function splitByRange(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  options: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const rawRanges = Array.isArray(options?.ranges) ? (options!.ranges as unknown[]) : [];

  // Normalise each {from,to} into a clamped, ascending list of 0-based indices.
  const ranges: number[][] = [];
  for (const raw of rawRanges) {
    if (typeof raw !== "object" || raw === null) continue;
    const from = Number((raw as { from?: unknown }).from);
    const to = Number((raw as { to?: unknown }).to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const lo = Math.max(1, Math.min(Math.floor(from), Math.floor(to)));
    const hi = Math.min(pageCount, Math.max(Math.floor(from), Math.floor(to)));
    if (hi < lo) continue;
    const indices: number[] = [];
    for (let n = lo; n <= hi; n++) indices.push(n - 1);
    if (indices.length > 0) ranges.push(indices);
  }

  if (ranges.length === 0) {
    throw new ConversionError("Add at least one valid page range to split.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `No usable ranges for a ${pageCount}-page document.`,
    });
  }

  const outputs: ConversionOutput[] = [];

  if (options?.mergeRanges) {
    onProgress?.({ stage: "Extracting ranges", ratio: 0 });
    const all = ranges.flat();
    outputs.push(await buildOutput(PDFDocument, src, all, `${base}-ranges.pdf`));
    onProgress?.({ stage: "Done", ratio: 1 });
    return outputs;
  }

  for (let i = 0; i < ranges.length; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Extracting range ${i + 1} of ${ranges.length}`, ratio: i / ranges.length });
    const n = pad(i + 1, ranges.length);
    outputs.push(await buildOutput(PDFDocument, src, ranges[i], `${base}-range-${n}.pdf`));
  }
  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

// ── Mode: pages ───────────────────────────────────────────────────────────────
// options.pageRange = print-style string parsed against the real page count.
// mergePages true → ONE PDF of the selected pages (in ascending order); else one
// single-page PDF per selected page.
async function splitByPages(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  options: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const pageRange = typeof options?.pageRange === "string" ? options.pageRange : "";
  // parsePageRange returns 1-based, sorted ascending, de-duped, clamped pages.
  // An empty string means "every page" (its allowAll default).
  const pages = parsePageRange(pageRange, pageCount);

  if (pages.length === 0) {
    throw new ConversionError("Select at least one page to extract.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Page range "${pageRange}" matched no pages in a ${pageCount}-page document.`,
    });
  }

  const outputs: ConversionOutput[] = [];

  if (options?.mergePages) {
    onProgress?.({ stage: "Extracting pages", ratio: 0 });
    const indices = pages.map((p) => p - 1);
    outputs.push(await buildOutput(PDFDocument, src, indices, `${base}-pages.pdf`));
    onProgress?.({ stage: "Done", ratio: 1 });
    return outputs;
  }

  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Extracting page ${i + 1} of ${pages.length}`, ratio: i / pages.length });
    const pageNum = pages[i];
    const n = pad(pageNum, pageCount);
    outputs.push(await buildOutput(PDFDocument, src, [pageNum - 1], `${base}-page-${n}.pdf`));
  }
  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

// ── Mode: size ────────────────────────────────────────────────────────────────
// options.maxMb → greedily pack consecutive pages into chunks, each kept under
// maxMb best-effort. We estimate per-page weight from the source file size and
// finalize a chunk with a single save() once the running estimate crosses the
// budget, then check the real saved size; ~10% slop is accepted. A single page
// that exceeds the budget on its own still becomes its own chunk (we never drop
// pages). onProgress fires between chunks.
async function splitBySize(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  inputSize: number,
  options: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const rawMb = Number(options?.maxMb);
  if (!Number.isFinite(rawMb) || rawMb <= 0) {
    throw new ConversionError("Enter a maximum size in MB to split by size.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `Invalid maxMb option: ${String(options?.maxMb)}.`,
    });
  }
  const budget = rawMb * 1024 * 1024; // bytes
  // Per-page estimate from the source size. Used only to decide WHEN to finalize
  // a chunk cheaply (one save per chunk, not one per page); the real saved size
  // is what we report. Guard a 0-byte estimate so the loop always makes progress.
  const perPageEstimate = Math.max(1, inputSize / Math.max(pageCount, 1));

  const outputs: ConversionOutput[] = [];
  let chunkStart = 0; // 0-based index of the first page in the current chunk
  let estimate = 0; // estimated bytes accumulated in the current chunk
  let chunkIndex = 0;

  async function finalizeChunk(endExclusive: number): Promise<void> {
    const indices: number[] = [];
    for (let p = chunkStart; p < endExclusive; p++) indices.push(p);
    if (indices.length === 0) return;
    chunkIndex++;
    // Provisional name; renumbered to a uniform width at the end once we know the
    // total chunk count, so all filenames sort naturally.
    const out = await buildOutput(PDFDocument, src, indices, `${base}-part-${chunkIndex}.pdf`);
    outputs.push(out);
  }

  for (let i = 0; i < pageCount; i++) {
    throwIfAborted(signal);
    const next = estimate + perPageEstimate;
    // If adding this page would cross the budget AND the chunk already has at
    // least one page, finalize the chunk before this page (greedy pack). A page
    // that alone exceeds the budget falls through and becomes its own chunk.
    if (next > budget && i > chunkStart) {
      onProgress?.({ stage: `Packing part ${chunkIndex + 1}`, ratio: i / pageCount });
      await finalizeChunk(i);
      chunkStart = i;
      estimate = 0;
    }
    estimate += perPageEstimate;
  }
  // Flush the trailing chunk.
  throwIfAborted(signal);
  onProgress?.({ stage: `Packing part ${chunkIndex + 1}`, ratio: 1 });
  await finalizeChunk(pageCount);

  // Renumber filenames to a uniform zero-padded width now that the count is known.
  const total = outputs.length;
  for (let i = 0; i < total; i++) {
    outputs[i].filename = `${base}-part-${pad(i + 1, total)}.pdf`;
  }

  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

// ── Mode: fixed ───────────────────────────────────────────────────────────────
// options.everyN → divide the document into consecutive uniform chunks of everyN
// pages each (the last chunk may be smaller). E.g. a 10-page PDF with everyN=3 →
// 1-3, 4-6, 7-9, 10. everyN is clamped to a positive integer (≥1, default 1).
// Filenames are zero-padded "-part-N" against the chunk count so they sort
// naturally; onProgress fires between chunks (mirrors splitBySize's style).
async function splitByFixed(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  everyN: number,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  // Clamp to a positive integer; fall back to 1 (per-page) for any garbage input
  // so a chunk is always emitted and the loop makes progress.
  const size = Number.isFinite(everyN) ? Math.max(1, Math.floor(everyN)) : 1;
  const chunkCount = Math.max(1, Math.ceil(pageCount / size));

  const outputs: ConversionOutput[] = [];
  let chunkIndex = 0;
  for (let start = 0; start < pageCount; start += size) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Splitting part ${chunkIndex + 1} of ${chunkCount}`, ratio: start / pageCount });
    const end = Math.min(start + size, pageCount);
    const indices: number[] = [];
    for (let p = start; p < end; p++) indices.push(p);
    const n = pad(chunkIndex + 1, chunkCount);
    outputs.push(await buildOutput(PDFDocument, src, indices, `${base}-part-${n}.pdf`));
    chunkIndex++;
  }
  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

// ── Mode: oddeven ───────────────────────────────────────────────────────────────
// options.which = "odd" | "even" | "both". Build a PDF of every odd page and/or
// every even page (1-based, so page 1 is odd). "both" emits the odd PDF then the
// even PDF; "odd"/"even" emit just the one. A side with no matching pages (e.g.
// "even" on a 1-page doc) is skipped rather than producing an empty PDF; if that
// leaves nothing we reject (mirrors the other modes' "nothing to split" guard).
async function splitByOddEven(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  options: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const which = options?.which === "odd" || options?.which === "even" ? options.which : "both";

  // 0-based indices: even index = odd page number (page 1 → index 0).
  const oddIndices: number[] = [];
  const evenIndices: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    (i % 2 === 0 ? oddIndices : evenIndices).push(i);
  }

  // Which sides to emit, in odd-then-even order, dropping any empty side.
  const sides: { label: "odd" | "even"; indices: number[] }[] = [];
  if (which === "odd" || which === "both") sides.push({ label: "odd", indices: oddIndices });
  if (which === "even" || which === "both") sides.push({ label: "even", indices: evenIndices });
  const usable = sides.filter((s) => s.indices.length > 0);

  if (usable.length === 0) {
    throw new ConversionError("No matching pages to extract.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `which="${which}" matched no pages in a ${pageCount}-page document.`,
    });
  }

  const outputs: ConversionOutput[] = [];
  for (let i = 0; i < usable.length; i++) {
    throwIfAborted(signal);
    const side = usable[i];
    onProgress?.({ stage: `Extracting ${side.label} pages`, ratio: i / usable.length });
    outputs.push(await buildOutput(PDFDocument, src, side.indices, `${base}-${side.label}-pages.pdf`));
  }
  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

// ── Mode: half ──────────────────────────────────────────────────────────────────
// options.direction = "vertical" (left/right) | "horizontal" (top/bottom). Each
// source page is copied TWICE into one output and each copy cropped to one half by
// resetting its MediaBox + CropBox, so the page count doubles. Crops are computed
// relative to the page's existing MediaBox origin (PDF user-space coords, which
// need not start at 0,0). Vertical splits at the horizontal midpoint into a left
// then a right page; horizontal splits at the vertical midpoint into a top then a
// bottom page (PDF y grows upward, so the top half is the upper y-range).
async function splitInHalf(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  options: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const direction = options?.direction === "horizontal" ? "horizontal" : "vertical";

  const out = await PDFDocument.create();
  // Two copies of every source page, interleaved so each page's two halves stay
  // adjacent: [p0a, p0b, p1a, p1b, …]. copyPages preserves the request order.
  const order: number[] = [];
  for (let i = 0; i < pageCount; i++) order.push(i, i);
  const copied = await out.copyPages(src, order);

  for (let i = 0; i < pageCount; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Splitting page ${i + 1} of ${pageCount}`, ratio: i / pageCount });
    const first = copied[i * 2];
    const second = copied[i * 2 + 1];
    // Crop relative to the page's real MediaBox origin, not a hard-coded 0,0.
    const { x, y, width, height } = first.getMediaBox();

    if (direction === "vertical") {
      const halfW = width / 2;
      // Left half, then right half.
      first.setMediaBox(x, y, halfW, height);
      first.setCropBox(x, y, halfW, height);
      second.setMediaBox(x + halfW, y, halfW, height);
      second.setCropBox(x + halfW, y, halfW, height);
    } else {
      const halfH = height / 2;
      // Top half (upper y-range), then bottom half.
      first.setMediaBox(x, y + halfH, width, halfH);
      first.setCropBox(x, y + halfH, width, halfH);
      second.setMediaBox(x, y, width, halfH);
      second.setCropBox(x, y, width, halfH);
    }
    out.addPage(first);
    out.addPage(second);
  }

  const bytes = await out.save();
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  onProgress?.({ stage: "Done", ratio: 1 });
  return [{ blob, filename: `${base}-halves.pdf`, mimeType: "application/pdf", size: bytes.length }];
}

// ── Mode: bookmarks ─────────────────────────────────────────────────────────────
// Split by the PDF's outline (bookmarks). pdf-lib can't read the outline tree, so
// this is the one mode that loads pdfjs-dist (via the shared loadPdfjs) and reads
// the document a SECOND time — from the SAME bytes pdf-lib already parsed — to get
// the outline. Each TOP-LEVEL bookmark becomes a chapter via
// outlineEntriesToPageRanges; the actual page copying still goes through pdf-lib's
// buildOutput so output bytes match every other mode. A document with no bookmarks
// is a recoverable nudge, not a hard error.
async function splitByBookmarks(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  bytes: ArrayBuffer,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  onProgress?.({ stage: "Reading bookmarks", ratio: 0 });

  const pdfjs = await loadPdfjs();
  throwIfAborted(signal);

  // Parse the SAME bytes pdf-lib read. getDocument copies into its own worker, so
  // pass a fresh Uint8Array view (the underlying buffer isn't transferred).
  // `doc` starts null so the finally can tell whether the parse ever produced a
  // document: if task.promise REJECTS, doc stays null and the teardown below must
  // not call doc.cleanup()/doc.destroy() (that bare call would throw a TypeError
  // and mask the real DECODE_FAILED error).
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  let doc: PdfDocument | null = null;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new ConversionError("We couldn't read this PDF's bookmarks — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const outline = await doc.getOutline();
    if (!outline || outline.length === 0) {
      throw new ConversionError("This PDF has no bookmarks to split by.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: "pdf.js getOutline() returned no top-level entries.",
      });
    }

    // Resolve each TOP-LEVEL bookmark's destination to a 0-based page index.
    // A dest is either a named-destination STRING (resolve via getDestination to
    // its array, whose [0] is the page ref) or an explicit destination ARRAY
    // (whose [0] is the page ref). Items we can't resolve (no dest, missing ref,
    // resolution error) are skipped rather than aborting the whole split.
    const entries: { title: string; pageIndex: number }[] = [];
    for (const node of outline) {
      throwIfAborted(signal);
      const ref = await resolveDestRef(doc, node.dest);
      if (ref === null) continue;
      let pageIndex: number;
      try {
        pageIndex = await doc.getPageIndex(ref);
      } catch {
        continue; // unresolvable ref → skip this bookmark
      }
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) continue;
      entries.push({ title: node.title, pageIndex });
    }

    const ranges = outlineEntriesToPageRanges(entries, pageCount);
    if (ranges.length === 0) {
      throw new ConversionError("This PDF has no bookmarks to split by.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: true,
        technical: "No top-level bookmark resolved to a page in the document.",
      });
    }

    const outputs: ConversionOutput[] = [];
    for (let i = 0; i < ranges.length; i++) {
      throwIfAborted(signal);
      const { start, end, title } = ranges[i];
      onProgress?.({ stage: `Extracting chapter ${i + 1} of ${ranges.length}`, ratio: i / ranges.length });
      const indices: number[] = [];
      for (let p = start; p <= end; p++) indices.push(p);
      const filename = `${base}-${sanitizeTitle(title, i + 1)}.pdf`;
      outputs.push(await buildOutput(PDFDocument, src, indices, filename));
    }
    onProgress?.({ stage: "Done", ratio: 1 });
    return outputs;
  } finally {
    // Tear down the pdf.js document + worker on every exit path, guarded per
    // method (the shipped PDFDocumentProxy may expose only one of cleanup/destroy)
    // and wrapped so a teardown hiccup never masks the real result/error. Mirrors
    // the guarded teardown in pdf-image.ts. `doc` is null only when task.promise
    // rejected (and we've already thrown DECODE_FAILED), in which case we fall back
    // to the loading task's own destroy() so the worker transport is still released.
    if (doc) {
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
    } else if (typeof task.destroy === "function") {
      try {
        await task.destroy();
      } catch {
        /* best-effort */
      }
    }
  }
}

// Resolve an outline node's `dest` to a page reference, or null when it can't be
// resolved. String dests are NAMED destinations resolved via getDestination;
// array dests carry the ref directly at [0]. Any resolution error → null so the
// caller skips that one bookmark instead of failing the whole split.
async function resolveDestRef(doc: PdfDocument, dest: string | unknown[] | null): Promise<unknown | null> {
  try {
    let arr: unknown[] | null;
    if (typeof dest === "string") {
      arr = await doc.getDestination(dest);
    } else if (Array.isArray(dest)) {
      arr = dest;
    } else {
      return null;
    }
    const ref = arr && arr.length > 0 ? arr[0] : null;
    return ref ?? null;
  } catch {
    return null;
  }
}

// ── Mode: per-page (legacy default) ─────────────────────────────────────────────
// One single-page PDF per page. Used when no `mode` is supplied so the descriptor
// stays robust when called bare.
async function splitEveryPage(
  PDFDocument: typeof import("pdf-lib").PDFDocument,
  src: PDFDoc,
  pageCount: number,
  base: string,
  signal: AbortSignal | undefined,
  onProgress: ConversionInput["onProgress"],
): Promise<ConversionOutput[]> {
  const outputs: ConversionOutput[] = [];
  for (let i = 0; i < pageCount; i++) {
    throwIfAborted(signal);
    onProgress?.({ stage: `Splitting page ${i + 1} of ${pageCount}`, ratio: i / pageCount });
    const n = pad(i + 1, pageCount);
    outputs.push(await buildOutput(PDFDocument, src, [i], `${base}-page-${n}.pdf`));
  }
  onProgress?.({ stage: "Done", ratio: 1 });
  return outputs;
}

async function convertPdfSplit(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  // Reject non-PDF up front — not recoverable, the user needs a different file.
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }

  // Lazy-load pdf-lib so it stays in the /pdf-split route chunk only.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  // Read the bytes ONCE: pdf-lib parses them below, and the bookmarks mode reuses
  // the SAME bytes for its second (pdfjs) parse rather than re-reading the File.
  let bytes: ArrayBuffer;
  let src: PDFDoc;
  try {
    bytes = await file.arrayBuffer();
    src = await PDFDocument.load(bytes);
  } catch (err) {
    throw new ConversionError("We couldn't read this PDF — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  const pageCount = src.getPageCount();
  const base = basename(file.name);
  const mode = typeof options?.mode === "string" ? options.mode : undefined;

  let outputs: ConversionOutput[];
  switch (mode) {
    case "range":
      outputs = await splitByRange(PDFDocument, src, pageCount, base, options, signal, onProgress);
      break;
    case "pages":
      outputs = await splitByPages(PDFDocument, src, pageCount, base, options, signal, onProgress);
      break;
    case "size":
      outputs = await splitBySize(PDFDocument, src, pageCount, base, file.size, options, signal, onProgress);
      break;
    case "fixed":
      outputs = await splitByFixed(PDFDocument, src, pageCount, base, Number(options?.everyN), signal, onProgress);
      break;
    case "oddeven":
      outputs = await splitByOddEven(PDFDocument, src, pageCount, base, options, signal, onProgress);
      break;
    case "half":
      outputs = await splitInHalf(PDFDocument, src, pageCount, base, options, signal, onProgress);
      break;
    case "bookmarks":
      outputs = await splitByBookmarks(PDFDocument, src, pageCount, base, bytes, signal, onProgress);
      break;
    default:
      // No mode (or unknown) → original one-PDF-per-page behavior.
      outputs = await splitEveryPage(PDFDocument, src, pageCount, base, signal, onProgress);
  }

  // result.blob / filename are the first output as a representative single-file
  // entry (used by any code that still reads the top-level fields).
  const first = outputs[0];
  return {
    blob: first.blob,
    filename: first.filename,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: outputs.reduce((sum, o) => sum + o.size, 0),
    outputs,
  };
}

export const pdfSplitDescriptor: ConversionDescriptor = {
  id: "pdf-split",
  fromLabel: "PDF",
  toLabel: "Pages",
  accept: ["application/pdf"],
  newExtension: "pdf",
  outputMode: "multi",
  convert: convertPdfSplit,
};
