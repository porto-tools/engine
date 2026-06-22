// Shared pdf.js (`pdfjs-dist`) loader — INTERNAL engine helper.
//
// Both pdf-image.ts (PDF→JPG/PNG) and compress-pdf.ts (Path B rasterize
// fallback) need the same multi-MB pdf.js library, loaded the same way: a
// dynamic import so it code-splits into the route chunk (verified by
// /check-bundle), plus a one-time GlobalWorkerOptions.workerSrc wiring that lets
// the bundler fingerprint and emit the worker as a static asset alongside the
// chunk (no next.config change, no public/ copy). They previously each declared
// their own `interface PdfjsModule` and loaded the module via
// `(await import("pdfjs-dist")) as unknown as PdfjsModule` — the same loader,
// the same cast, duplicated. This file coalesces all of that into ONE
// `loadPdfjs()` and owns the SINGLE unavoidable cast.
//
// Why the local structural types (not pdfjs-dist's shipped `.d.ts`): the version
// of pdfjs-dist we ship at runtime does NOT match its own bundled type
// definitions in the ways we depend on. The shipped `RenderParameters` makes
// `canvas` a required field and deprecates the `canvasContext`-only call we
// actually make; and the shipped PDFDocumentProxy types `destroy()`/page
// `cleanup()` as always-present, whereas the running build may expose only one
// of them (the "doc.destroy is not a function" crash the guarded teardown in
// convertPdfToImages exists to prevent). The minimal structural types below
// encode that hard-won runtime reality — they are intentionally MORE permissive
// (optional teardown methods, `canvasContext`-only render) than the upstream
// `.d.ts`. So we keep our own types and localise the one cast here.
//
// This is NOT a ConversionDescriptor — it must NOT be exported from
// engine/index.ts.

import { ConversionError } from "../types";

// ── Structural types: the slice of the pdf.js API the engine uses ────────────

export interface PdfPageViewport {
  width: number;
  height: number;
}

export interface PdfPage {
  getViewport(params: { scale: number }): PdfPageViewport;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfPageViewport;
  }): { promise: Promise<void> };
  // pdf.js' text-layer API: each item is one positioned text run. We read only
  // `str` (the run's text); the rest (transform/width/height/dir/fontName) are
  // present at runtime but irrelevant to plain extraction, so they're omitted
  // from this slice. Declared here (not via pdfjs-dist's shipped `.d.ts`, which we
  // deliberately don't depend on — see the file header) so the text-extraction
  // converter stays typed. Adds NO runtime behavior; it only widens the type.
  getTextContent(): Promise<{ items: { str?: string }[] }>;
  // pdf.js exposes page-level cleanup; declared optional so a build that narrows
  // the page API can't make a guarded call a type error.
  cleanup?: () => void;
}

// A bookmark/outline node as pdf.js' getOutline() returns it. We use only
// `title`, `dest`, and `items`; the rest (bold/italic/color/url/…) are present at
// runtime but irrelevant to splitting, so they're omitted from this slice. `dest`
// is either a NAMED destination (a string to resolve via getDestination) or an
// explicit destination ARRAY whose first element is the page reference.
export interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

// An opaque page reference, as it appears as the first element of a destination
// array (or the resolved value of a named destination). getPageIndex() turns it
// into a 0-based page index. Its internals are pdf.js-private, so it's unknown.
export type PdfRef = unknown;

// The document handle. BOTH teardown methods are optional on purpose: across
// pdfjs-dist versions a PDFDocumentProxy may expose `cleanup()` (release page
// resources), `destroy()` (tear down the worker transport), or — in the version
// we ship — only one of them. Calling a method that doesn't exist is exactly the
// "doc.destroy is not a function" crash the guarded teardown prevents.
//
// getOutline/getDestination/getPageIndex are the outline-reading slice the
// pdf-split "bookmarks" mode needs; they're always present on PDFDocumentProxy in
// the version we ship, but typed here (not via pdfjs-dist's shipped `.d.ts`, which
// we deliberately don't depend on — see the file header) so callers stay typed.
// This adds NO runtime behavior: it only widens the structural type.
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  // The PDF outline tree (bookmarks), or null/[] when the document has none.
  getOutline(): Promise<PdfOutlineNode[] | null>;
  // Resolve a NAMED destination to its raw destination array (first element is
  // the page ref), or null when the name isn't present.
  getDestination(id: string): Promise<unknown[] | null>;
  // Turn a page reference into its 0-based page index.
  getPageIndex(ref: PdfRef): Promise<number>;
  cleanup?: () => void;
  destroy?: () => Promise<void> | void;
}

// The loading task `getDocument` returns. Its own `destroy()` is the
// version-safe way to release the document + worker; callers keep a reference to
// it so teardown can fall back to it.
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy?: () => Promise<void> | void;
}

export interface PdfjsModule {
  getDocument(params: { data: Uint8Array }): PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
}

// ── Coalesced loader ─────────────────────────────────────────────────────────

// Module-level singleton promise: the dynamically imported, worker-wired pdf.js
// module. Cached so the import + worker setup cost is paid ONCE and concurrent
// callers coalesce onto the same promise. A failed import is not cached (the
// promise rejects and `cached` is left null), so a later call can retry.
let cached: Promise<PdfjsModule> | null = null;

// Load pdf.js once and wire up its Web Worker. Idempotent: repeated calls (and
// concurrent ones) share a single import + worker-setup. Throws a canonical
// ConversionError with code ENGINE_LOAD_FAILED if the dynamic import fails
// (e.g. in a non-browser environment) so callers get a recoverable, well-typed
// failure rather than a raw module error.
export function loadPdfjs(): Promise<PdfjsModule> {
  if (cached) return cached;
  const load = (async (): Promise<PdfjsModule> => {
    let mod: PdfjsModule;
    try {
      // Dynamic import → code-split into the route chunk (verified by
      // /check-bundle). The default build is correct for the browser; the Node
      // "legacy" warning does not apply in the bundled browser environment. This
      // is the ONE localised cast: the shipped types don't match our runtime
      // usage (see file header), so we assert our own structural shape.
      mod = (await import("pdfjs-dist")) as unknown as PdfjsModule;
    } catch (err) {
      throw new ConversionError("Failed to load the PDF engine.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      });
    }
    // Point pdf.js at its Web Worker. `new URL(..., import.meta.url)` lets the
    // bundler fingerprint and emit the worker as a static asset alongside the
    // route chunk — no next.config change, no manual public/ copy.
    mod.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return mod;
  })();
  // Don't cache a rejected load: clear the singleton on failure so a retry can
  // attempt the import again, while a success stays memoised.
  cached = load.catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
