// HTML to PDF — render a single HTML file to a PDF, 100% on-device.
//
// HONEST LABELING: the output is a RASTERIZED SNAPSHOT of the rendered HTML, not
// selectable/searchable text. We render the HTML into an off-screen DOM node,
// snapshot it to a canvas with html2canvas, then embed that PNG as a single page
// in a new pdf-lib PDF. Complex CSS, fonts, and remote resources may not
// render faithfully — this is a picture of the page, not a print-CSS render.
//
// Engine firewall: this file imports ONLY sibling engine modules (../types,
// ../filename, ./abort) and node_modules (pdf-lib, and html2canvas via dynamic
// import). It never reaches into app/components/lib.
//
// html2canvas is heavy, so it is DYNAMIC-imported inside `convert` — it must land
// in the /html-to-pdf route chunk, never the shared chunk (Headmaster condition).

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";

const ACCEPT = ["text/html"] as const;

// Accept text/html by MIME, and also .html/.htm by extension when the browser
// reports an empty MIME (common for local files dragged in). We deliberately do
// NOT execute the HTML: innerHTML assignment never runs <script> tags, and we
// rely on that — no eval, no script injection.
function isHtmlInput(file: File): boolean {
  if (ACCEPT.includes(file.type as (typeof ACCEPT)[number])) return true;
  if (file.type === "") {
    const lower = file.name.toLowerCase();
    return lower.endsWith(".html") || lower.endsWith(".htm");
  }
  return false;
}

// Width of the off-screen render container, in CSS pixels. The PDF page is sized
// to fit this width to A4 width; height follows the content (single page).
const RENDER_WIDTH = 800;
// A4 width in PostScript points (210mm at 72/25.4 pt per mm). The embedded image
// is scaled to this width; page height follows the image's aspect ratio.
const A4_WIDTH_PT = 595.28;

async function convertHtmlToPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isHtmlInput(file)) {
    throw new ConversionError("Only HTML files are supported.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected text/html (or a .html/.htm file), received "${file.type || "unknown type"}" for "${file.name}".`,
    });
  }

  // Read the HTML text. A read failure means the file is damaged/unreadable.
  let html: string;
  try {
    html = await file.text();
  } catch (err) {
    throw new ConversionError(`We couldn't read "${file.name}" — the file may be damaged.`, {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  // Lazy-load the heavy libraries. A failure here is an engine-load problem, not
  // a problem with the user's file. html2canvas is dynamic-imported so it stays
  // in the /html-to-pdf route chunk (never the shared chunk).
  let html2canvas: typeof import("html2canvas").default;
  let PDFDocument: typeof import("pdf-lib").PDFDocument;
  try {
    html2canvas = (await import("html2canvas")).default;
    ({ PDFDocument } = await import("pdf-lib"));
  } catch (err) {
    throw new ConversionError("We couldn't load the HTML renderer. Please try again.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Rendering HTML" });

  // Render the HTML into an off-screen but REAL (layout-able) container, snapshot
  // it to a canvas, then always remove the container. Assigning innerHTML does
  // NOT run <script> tags; we keep it that way (no eval/script execution).
  let canvas: HTMLCanvasElement;
  const container = document.createElement("div");
  container.style.cssText = "position:fixed; left:-10000px; top:0; width:800px; background:#fff";
  try {
    container.innerHTML = html;
    document.body.appendChild(container);

    // Wait a tick so the browser lays out the new DOM (and starts any image
    // loads) before we snapshot it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    throwIfAborted(signal);

    canvas = await html2canvas(container, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      width: RENDER_WIDTH,
    });
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError("We couldn't render this HTML. Some pages use features we can't snapshot.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  } finally {
    container.remove();
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Creating PDF" });

  // Embed the snapshot PNG into a new single-page PDF. The page is scaled to A4
  // width; its height follows the image aspect ratio. v1 keeps it to ONE page —
  // very tall HTML produces one very tall page, which is acceptable for v1.
  let blob: Blob;
  try {
    const pngBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) b.arrayBuffer().then(resolve, reject);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });

    const doc = await PDFDocument.create();
    const png = await doc.embedPng(new Uint8Array(pngBytes));
    const scale = A4_WIDTH_PT / png.width;
    const pageW = A4_WIDTH_PT;
    const pageH = png.height * scale;
    const page = doc.addPage([pageW, pageH]);
    page.drawImage(png, { x: 0, y: 0, width: pageW, height: pageH });

    const saved = await doc.save();
    // Copy into a fresh Uint8Array so the underlying buffer is a plain
    // ArrayBuffer (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob wants
    // ArrayBuffer).
    blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });
  } catch (err) {
    throw new ConversionError("We couldn't build the PDF from the rendered HTML.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  onProgress?.({ stage: "Done", ratio: 1 });

  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const htmlToPdfDescriptor: ConversionDescriptor = {
  id: "html-to-pdf",
  fromLabel: "HTML",
  toLabel: "PDF",
  accept: ["text/html"],
  newExtension: "pdf",
  convert: convertHtmlToPdf,
};
