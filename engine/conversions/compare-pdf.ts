// Compare PDF — show the TEXTUAL differences between two PDFs, 100% on-device.
//
// HONEST SCOPE: this compares the EXTRACTED TEXT layer of two PDFs (which lines
// of text were added vs removed), NOT their visual layout, fonts, colours, or
// images. A scanned / image-only PDF has no text layer to extract, so there is
// nothing for this tool to compare on such a file — it is a text diff, not OCR.
//
// HOW: PDF A is the primary input; a "file" control ("Second PDF") supplies PDF
// B (the same `"file"` control kind watermark-pdf uses for its logo — the picked
// File reaches `convert` under `options.fileB`). We extract each PDF's text layer
// with pdf.js (the shared loadPdfjs loader, code-split into this route chunk),
// joining every page's text items the way a PDF→text extractor would, then run a
// line diff (jsdiff's diffLines, dynamically imported inside convert) and render
// a self-contained, colour-coded HTML report. The extracted PDF text is UNTRUSTED
// input, so every character embedded in the HTML is escaped (see buildDiffHtml).
//
// Firewall: imports ONLY ../types, ../filename, ./abort, ./pdfjs (+ a dynamic
// import of `diff` inside convert). See types.ts for the engine firewall rule.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { loadPdfjs, type PdfjsModule, type PdfDocument, type PdfPage } from "./pdfjs";

// Reject anything that isn't a real PDF up front with a non-recoverable error —
// retrying the same wrong file can't help. We require the exact PDF MIME type
// (browsers report it reliably for .pdf files). `label` names which input failed
// so the message can point the user at A vs B.
function assertPdf(file: File | null, label: string): asserts file is File {
  if (!file || file.type !== "application/pdf") {
    throw new ConversionError(`${label} doesn't look like a PDF file.`, {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf for ${label}, received "${file?.type || "no file"}".`,
    });
  }
}

// pdf.js' getTextContent() returns { items: (TextItem | TextMarkedContent)[] }.
// Marked-content entries carry no `str`, so we narrow to the text items. We keep
// this structural type LOCAL (rather than widen the shared pdfjs.ts surface) —
// the same pattern redact-pdf uses — since the text-content slice is only needed
// by the pdf consumers that read text, and it's cast onto the page object below.
interface PageWithTextContent {
  getTextContent?: () => Promise<{ items: unknown[] }>;
}

// Read one page's text items into a single string. pdf.js emits text as a list of
// runs; we join them with spaces and treat each item's `hasEOL` as a line break,
// mirroring how a PDF→text extractor reconstructs readable lines. Best-effort: a
// page without getTextContent (or that throws) contributes an empty string rather
// than failing the whole compare.
async function extractPageText(page: PdfPage): Promise<string> {
  const withText = page as PageWithTextContent;
  if (typeof withText.getTextContent !== "function") return "";
  let content: { items: unknown[] };
  try {
    content = await withText.getTextContent();
  } catch {
    return "";
  }
  let out = "";
  for (const raw of content.items ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.str !== "string") continue;
    out += o.str;
    // pdf.js sets hasEOL on the item that ends a visual line; honour it so the
    // line diff aligns on the document's own line boundaries.
    if (o.hasEOL === true) out += "\n";
    else out += " ";
  }
  return out;
}

// Extract the full text layer of a PDF File via pdf.js: open the document, walk
// every page, and join the per-page text with blank lines between pages. Throws
// the canonical DECODE_FAILED if pdf.js can't parse the bytes (damaged / empty /
// not really a PDF) so the failure is honest rather than a silent empty diff.
// Tears down the document + worker on every exit path (the guarded teardown
// pattern from pdf-image.ts — a narrowed build may expose only one of the APIs).
async function extractPdfText(
  lib: PdfjsModule,
  file: File,
  label: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  const task = lib.getDocument({ data });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new ConversionError(`We couldn't read ${label} — the file may be damaged or empty.`, {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const numPages = doc.numPages;
    if (numPages < 1) {
      throw new ConversionError(`${label} has no pages to compare.`, {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: `pdf.js reported numPages < 1 for ${label}.`,
      });
    }
    const pages: string[] = [];
    for (let n = 1; n <= numPages; n++) {
      throwIfAborted(signal);
      const page = await doc.getPage(n);
      try {
        pages.push(await extractPageText(page));
      } finally {
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }
    // Join pages with a blank line so a page boundary reads as a paragraph break
    // in the diff, and normalise trailing whitespace per line.
    return pages.join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
  } finally {
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

// Escape the five characters that are unsafe to embed in HTML text/attribute
// context. The extracted PDF text is UNTRUSTED input — a PDF can contain literal
// "<script>" or "&" in its text layer — so EVERY character we embed in the report
// goes through this first. Never inject extracted text into the HTML raw.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// One change chunk as jsdiff's diffLines returns it: the chunk text plus flags
// marking it as added/removed (both absent ⇒ unchanged). Declared locally so
// buildDiffHtml can stay PURE — the test injects a real `diffLines` and convert
// injects the dynamically-imported one, so the module never top-level imports
// `diff`.
export type DiffPart = { value: string; added?: boolean; removed?: boolean };
export type DiffLinesFn = (a: string, b: string) => DiffPart[];

export interface BuildDiffHtmlOptions {
  // The line-diff function (jsdiff's diffLines). Injected so this helper is pure
  // and synchronously testable, and so `diff` is only ever dynamically imported
  // (inside convert), never at module load. When omitted, the two texts are
  // treated as a single unchanged/added/removed block via a trivial fallback that
  // needs no dependency — enough for the "identical" and escaping cases.
  diffLines?: DiffLinesFn;
  // Display labels for the two documents, shown in the report header. Both are
  // escaped before embedding. Default to "PDF A" / "PDF B".
  labelA?: string;
  labelB?: string;
}

// A dependency-free line diff used only when no diffLines is injected: identical
// texts ⇒ one unchanged block; otherwise the whole of A is "removed" and the
// whole of B is "added". Keeps buildDiffHtml callable with no `diff` import (e.g.
// the escaping/identical unit tests) while convert always injects the real jsdiff.
function fallbackDiffLines(a: string, b: string): DiffPart[] {
  if (a === b) return [{ value: a }];
  const parts: DiffPart[] = [];
  if (a.length > 0) parts.push({ value: a, removed: true });
  if (b.length > 0) parts.push({ value: b, added: true });
  return parts;
}

// Build a SELF-CONTAINED HTML diff report (PURE + testable, no DOM, no pdf.js).
// Runs the injected diffLines over the two extracted texts and renders a
// colour-coded document: added lines green, removed lines red, unchanged lines
// muted, with a small header summarising +added / −removed line counts. The
// output is a complete HTML document with an INLINE <style> and NO external
// references and NO JavaScript, so it opens and renders offline anywhere.
//
// SECURITY: all dynamic text — the diff content AND the labels — is HTML-escaped
// via escapeHtml before embedding. The PDF text is untrusted, so it must never
// reach the output raw.
export function buildDiffHtml(textA: string, textB: string, opts?: BuildDiffHtmlOptions): string {
  const labelA = escapeHtml(opts?.labelA ?? "PDF A");
  const labelB = escapeHtml(opts?.labelB ?? "PDF B");

  const diff = opts?.diffLines ?? fallbackDiffLines;
  const parts = diff(textA, textB);

  let addedLines = 0;
  let removedLines = 0;
  const rows: string[] = [];

  for (const part of parts) {
    // Split the chunk into its constituent lines. diffLines keeps trailing
    // newlines on each chunk; drop a single trailing empty line so we don't emit
    // a blank row per chunk boundary.
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    const marker = part.added ? "+" : part.removed ? "−" : " ";
    for (const line of lines) {
      if (part.added) addedLines++;
      else if (part.removed) removedLines++;
      // Escape EVERY line — untrusted PDF text. An empty line still renders a row
      // (with a non-breaking space) so blank lines in the source are visible.
      const safe = line.length > 0 ? escapeHtml(line) : " ";
      rows.push(`<div class="row ${kind}"><span class="marker">${marker}</span><span class="text">${safe}</span></div>`);
    }
  }

  const noDiff = addedLines === 0 && removedLines === 0;
  const body = noDiff
    ? `<p class="empty">No differences — the extracted text of the two PDFs is identical.</p>`
    : rows.join("\n");

  // A complete, offline HTML document. Inline style only; no scripts, no external
  // links. Colours are literal (this file is downloaded and opened outside the
  // app, so it can't rely on the site's design tokens).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF text comparison</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; color: #1a1a1a; background: #ffffff; }
  header { padding: 16px 20px; border-bottom: 1px solid #e2e2e2; }
  h1 { margin: 0 0 6px; font-size: 16px; }
  .meta { font-size: 13px; color: #555; }
  .summary { margin-top: 8px; font-size: 13px; }
  .summary .add { color: #15803d; font-weight: 600; }
  .summary .del { color: #b91c1c; font-weight: 600; }
  .legend { font-size: 12px; color: #777; margin-top: 4px; }
  main { padding: 8px 0; }
  .row { display: flex; padding: 0 20px; white-space: pre-wrap; word-break: break-word; }
  .row .marker { width: 1.5em; flex: 0 0 auto; user-select: none; opacity: 0.7; }
  .row .text { flex: 1 1 auto; }
  .row.added { background: #e7f6ec; color: #14532d; }
  .row.removed { background: #fcebec; color: #7f1d1d; }
  .row.same { color: #555; }
  .empty { padding: 24px 20px; color: #555; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #161616; }
    header { border-bottom-color: #333; }
    .meta, .summary, .row.same { color: #b3b3b3; }
    .row.added { background: #0f2a1a; color: #86efac; }
    .row.removed { background: #2a1314; color: #fca5a5; }
  }
</style>
</head>
<body>
<header>
  <h1>PDF text comparison</h1>
  <div class="meta">${labelA} &rarr; ${labelB}</div>
  <div class="summary"><span class="add">+${addedLines} added</span> &middot; <span class="del">−${removedLines} removed</span> (lines of text)</div>
  <div class="legend">Compares the extracted text only — not layout, fonts, or images. Scanned/image-only PDFs have no text to compare.</div>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

// Module-level pdf.js singleton, set once by loadEngine via the shared loader and
// reused across runs. Same pattern as pdf-image.ts / redact-pdf.ts.
let pdfjs: PdfjsModule | null = null;

// loadEngine runs once before the first compare (the labelled one-time setup
// moment). Delegates to the shared loadPdfjs, which dynamically imports pdf.js and
// wires its worker exactly once. Idempotent.
async function loadEngine(): Promise<void> {
  if (pdfjs) return;
  pdfjs = await loadPdfjs();
}

async function convertComparePdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);

  // PDF A is the primary input; PDF B arrives under options.fileB (the "file"
  // control, mirroring watermark-pdf's logoFile). Validate BOTH up front so a
  // missing/wrong B is an honest UNSUPPORTED_INPUT, not a crash mid-extract.
  assertPdf(file, "The first PDF");
  const fileB = options?.fileB instanceof File ? options.fileB : null;
  assertPdf(fileB, "The second PDF");

  if (!pdfjs) {
    // loadEngine should have run first (the UI calls it); guard defensively so a
    // direct caller gets a clear path rather than a crash.
    await loadEngine();
  }
  const lib = pdfjs!;

  onProgress?.({ stage: "Reading the first PDF", ratio: 0 });
  const textA = await extractPdfText(lib, file, "the first PDF", signal);
  throwIfAborted(signal);

  onProgress?.({ stage: "Reading the second PDF", ratio: 0.5 });
  const textB = await extractPdfText(lib, fileB, "the second PDF", signal);
  throwIfAborted(signal);

  onProgress?.({ stage: "Comparing", ratio: 0.9 });
  // Dynamic-import jsdiff INSIDE convert so it code-splits into this route chunk
  // (verified by /check-bundle), never the homepage/shared entry.
  const { diffLines } = await import("diff");
  const html = buildDiffHtml(textA, textB, {
    diffLines,
    labelA: file.name,
    labelB: fileB.name,
  });
  throwIfAborted(signal);

  onProgress?.({ stage: "Done", ratio: 1 });

  const blob = new Blob([html], { type: "text/html" });
  // Derive the output name from PDF A's basename: "report.pdf" → "report.html".
  const filename = replaceExtension(file.name, "html");

  return {
    blob,
    filename,
    mimeType: "text/html",
    inputSize: file.size + fileB.size,
    outputSize: blob.size,
  };
}

export const comparePdfDescriptor: ConversionDescriptor = {
  id: "compare-pdf",
  fromLabel: "PDF",
  toLabel: "Comparison (HTML)",
  accept: ["application/pdf"],
  newExtension: "html",
  defaultOptions: {},
  controls: [
    {
      type: "file",
      id: "fileB",
      label: "Second PDF",
      help: "The other PDF to compare against. We diff the extracted text of the two files — not layout, fonts, or images.",
      accept: ["application/pdf"],
    },
  ],
  loadEngine,
  // pdf.js (pdfjs-dist) is the multi-MB one-time download shown in the setup
  // state while loadEngine runs.
  setupSizeLabel: "≈ 5 MB",
  convert: convertComparePdf,
};
