// PDF → Text / Markdown. This extracts the PDF's EXISTING TEXT LAYER — the
// characters the document actually stores — using pdf.js' getTextContent() per
// page. It is NOT OCR: a scanned or image-only PDF has no text layer, so it
// returns empty (or near-empty) output rather than reading pixels. We label this
// honestly in the UI copy.
//
// Output is a SINGLE file (one-out), unlike PDF→images. Two formats:
//   - "text"     → text/plain (.txt): each page's text, pages separated by a
//                  blank line.
//   - "markdown" → text/markdown (.md): the SAME extracted text with a
//                  `\n\n---\n\n` horizontal-rule separator between pages. This is
//                  a BEST-EFFORT, honest transform: pdf.js gives us positioned
//                  text runs with no reliable heading/list semantics, so we do
//                  NOT fake heading detection — we just emit clean text with page
//                  breaks marked. Labelled as best-effort in the UI.
//
// pdf.js (`pdfjs-dist`) is multi-MB, so it is lazy-loaded inside `loadEngine`/
// `convert` via the shared loadPdfjs() — it lands in this route chunk only, never
// the homepage/shared entry (verified by /check-bundle).
//
// Engine firewall: imports ONLY ../types, ../filename, ./abort, ./pdfjs (+
// node_modules). See types.ts.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
// Shared pdf.js loader + structural types (one coalesced dynamic import + worker
// setup). The PdfPage slice exposes getTextContent() for this converter.
import { loadPdfjs, type PdfjsModule, type PdfDocument } from "./pdfjs";

// Module-level singleton: the dynamically imported pdf.js module. Set once by
// loadEngine (via the shared loadPdfjs) and reused across conversions so the
// worker/setup cost is paid once. Mirrors pdf-image.ts.
let pdfjs: PdfjsModule | null = null;

// The two output formats this tool offers. Default is plain text.
type Format = "text" | "markdown";

// Reject the wrong format up front with a non-recoverable error — retrying the
// same file can't help; the user needs a different file. We require the exact
// PDF MIME type (the browser reports it reliably for .pdf files).
function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// Read the `format` option, defaulting to plain text. Anything other than the
// explicit "markdown" string is treated as the default — defensive, like the
// other converters read their option keys.
function readFormat(options: Record<string, unknown> | undefined): Format {
  return options?.format === "markdown" ? "markdown" : "text";
}

// Join one page's text runs into a single string. pdf.js gives positioned runs
// with no explicit line breaks, so we join them with spaces and collapse runs of
// whitespace — honest, readable text without pretending to reconstruct layout.
// A missing/empty `str` (some runs are layout markers) contributes nothing.
function pageText(items: { str?: string }[]): string {
  return items
    .map((it) => it.str ?? "")
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// loadEngine runs once before the first conversion (the labelled one-time setup
// moment). Delegates to the shared loadPdfjs (dynamic import + worker wiring,
// both done exactly once). Idempotent: a second call is a no-op once `pdfjs` is
// set, and loadPdfjs itself coalesces concurrent loads.
async function loadEngine(): Promise<void> {
  if (pdfjs) return;
  pdfjs = await loadPdfjs();
}

async function convert(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const format = readFormat(options);

  if (!pdfjs) {
    // loadEngine should have run first (the UI calls it); guard defensively so a
    // direct caller gets a clear error rather than a crash.
    await loadEngine();
  }
  const lib = pdfjs!;

  onProgress?.({ stage: "Reading PDF" });
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Keep the loading TASK, not just its document, so teardown has a version-safe
  // handle to fall back to (its destroy() tears down the worker transport).
  const task = lib.getDocument({ data });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    // A parse failure means the bytes are damaged, empty, or not really a PDF —
    // not recoverable by retry.
    throw new ConversionError("We couldn't read this PDF — the file may be damaged or empty.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const numPages = doc.numPages;
    if (numPages < 1) {
      throw new ConversionError("This PDF has no pages to read.", {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: "pdf.js reported numPages < 1.",
      });
    }

    const pageTexts: string[] = [];
    for (let n = 1; n <= numPages; n++) {
      // Stop promptly mid-run if the caller aborts (between every page).
      throwIfAborted(signal);
      onProgress?.({ stage: `Reading text from page ${n}`, ratio: (n - 1) / numPages });

      const page = await doc.getPage(n);
      try {
        const tc = await page.getTextContent();
        pageTexts.push(pageText(tc.items));
      } finally {
        // Release this page's pdf.js resources before moving to the next.
        // Guarded: a narrowed build may not expose page-level cleanup.
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }
    throwIfAborted(signal);

    // Plain text: pages joined by a blank line. Markdown: the SAME text with a
    // horizontal-rule page separator. We drop empty pages from the join so a
    // text-light document doesn't accumulate runs of blank separators.
    const sep = format === "markdown" ? "\n\n---\n\n" : "\n\n";
    const text = pageTexts.filter((t) => t.length > 0).join(sep);

    const mimeType = format === "markdown" ? "text/markdown" : "text/plain";
    const newExtension = format === "markdown" ? "md" : "txt";
    // A trailing newline is the conventional shape for a text/markdown file.
    const blob = new Blob([text.length > 0 ? `${text}\n` : ""], { type: mimeType });

    onProgress?.({ stage: "Done", ratio: 1 });

    return {
      blob,
      filename: replaceExtension(file.name, newExtension),
      mimeType,
      inputSize: file.size,
      outputSize: blob.size,
    };
  } finally {
    // Tear down the document + worker transport on every exit path, using
    // whichever pdf.js cleanup API this version exposes (each guarded by a typeof
    // check and wrapped so a teardown hiccup never masks the real result/error).
    // Mirrors the guarded teardown in pdf-image.ts.
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

export const pdfToTextDescriptor: ConversionDescriptor = {
  id: "pdf-to-text",
  fromLabel: "PDF",
  toLabel: "Text",
  accept: ["application/pdf"],
  newExtension: "txt",
  // A single select: plain text (default) or best-effort Markdown. Declaring
  // `controls` makes the tool button-driven (stage the file, pick a format,
  // click Convert) — the shared ControlsInputTool reads these.
  controls: [
    {
      type: "select",
      id: "format",
      label: "Output format",
      help: "Plain text, or Markdown with a divider between pages (best-effort).",
      default: "text",
      options: [
        { value: "text", label: "Plain text (.txt)" },
        { value: "markdown", label: "Markdown (.md)" },
      ],
    },
  ],
  defaultOptions: { format: "text" },
  loadEngine,
  // pdf.js (pdfjs-dist) is the multi-MB one-time download shown in the setup
  // state while loadEngine runs — the same engine the PDF→image tools use.
  setupSizeLabel: "≈ 5 MB",
  convert,
};
