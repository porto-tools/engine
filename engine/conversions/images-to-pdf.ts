// Images to PDF — combine one or more JPG or PNG images into a single PDF
// document. Each image becomes one page, sized exactly to the image's natural
// pixel dimensions (72 DPI). The merge runs entirely via pdf-lib (pure JS, no
// WASM), so no `loadEngine` is needed. `inputMode: "multi"` stages the files
// before converting; like pdf-merge, `file` is files[0] and the full list is
// `files`.

import type { ConversionDescriptor, ConversionInput, ConversionOutput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";

// pdf-lib's PDFDocument instance type, named once so helpers can be typed without
// repeating the Awaited<ReturnType<…>> dance (mirrors pdf-split.ts's PDFDoc).
type PDFDoc = Awaited<ReturnType<typeof import("pdf-lib").PDFDocument.create>>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Return `name` if unseen, else append "-2", "-3", … before the extension until
// unique. Mutates `used` with the chosen name. Used by the per-image path so two
// images that map to the same .pdf filename don't collide in the output list.
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const ACCEPT = ["image/jpeg", "image/png"] as const;

// Standard page sizes in PostScript points (1pt = 1/72 inch), portrait. ISO A
// sizes are the mm dimensions converted at 1mm = 72/25.4 pt; US sizes are inch
// dimensions × 72.
const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55], // 297 × 420 mm
  a4: [595.28, 841.89], // 210 × 297 mm
  a5: [419.53, 595.28], // 148 × 210 mm
  letter: [612, 792], // 8.5 × 11 in
  legal: [612, 1008], // 8.5 × 14 in
};
// Margin presets in points: none / ~0.25in / ~0.75in.
const MARGINS: Record<string, number> = { none: 0, small: 18, big: 54 };

type PageSizeKey = "fit" | "a4" | "letter" | "legal" | "a3" | "a5";
type OrientationKey = "auto" | "portrait" | "landscape";
type MarginKey = "none" | "small" | "big";
type OutputKey = "merged" | "per-image";

const PAGE_SIZE_KEYS = ["fit", "a4", "letter", "legal", "a3", "a5"] as const;

function readChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export interface PageLayout {
  pageW: number;
  pageH: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
}

// Pure layout math (DOM-free, unit-tested). Given an image's pixel size (1px =
// 1pt at 72 DPI) and the chosen page settings, return the PDF page size and where
// to draw the image. "fit" sizes the page to the image plus the margin border;
// a4/letter scale the image to fit inside the margins and centre it. Defaults
// (fit + auto + none) reproduce the original "one page exactly the image" output.
export function layoutImage(
  imgW: number,
  imgH: number,
  pageSize: PageSizeKey,
  orientation: OrientationKey,
  marginPt: number,
): PageLayout {
  const w = imgW > 0 ? imgW : 1;
  const h = imgH > 0 ? imgH : 1;

  if (pageSize === "fit") {
    return { pageW: w + 2 * marginPt, pageH: h + 2 * marginPt, drawX: marginPt, drawY: marginPt, drawW: w, drawH: h };
  }

  let [pw, ph] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4;
  const landscape = orientation === "landscape" || (orientation === "auto" && w > h);
  if (landscape) [pw, ph] = [ph, pw];

  const availW = Math.max(1, pw - 2 * marginPt);
  const availH = Math.max(1, ph - 2 * marginPt);
  const scale = Math.min(availW / w, availH / h);
  const drawW = w * scale;
  const drawH = h * scale;
  return { pageW: pw, pageH: ph, drawX: (pw - drawW) / 2, drawY: (ph - drawH) / 2, drawW, drawH };
}

async function convertImagesToPdf(input: ConversionInput): Promise<ConversionResult> {
  const { files, options, signal, onProgress } = input;
  const allFiles = files ?? [input.file];

  // Layout settings (default = the original "page exactly the image" behaviour).
  const pageSize = readChoice<PageSizeKey>(options?.pageSize, PAGE_SIZE_KEYS, "fit");
  const orientation = readChoice<OrientationKey>(options?.orientation, ["auto", "portrait", "landscape"], "auto");
  const marginKey = readChoice<MarginKey>(options?.margin, ["none", "small", "big"], "none");
  const marginPt = MARGINS[marginKey];
  // "merged" (default) keeps the original single-PDF path byte-for-byte;
  // "per-image" emits one PDF per image as outputs[].
  const output = readChoice<OutputKey>(options?.output, ["merged", "per-image"], "merged");

  throwIfAborted(signal);

  if (allFiles.length < 1) {
    throw new ConversionError("Select at least one image to convert.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: "Got 0 files; images-to-pdf requires at least 1.",
    });
  }

  // Validate every file is a supported image type before doing any work.
  for (const f of allFiles) {
    if (!ACCEPT.includes(f.type as (typeof ACCEPT)[number])) {
      throw new ConversionError("Only JPG and PNG images are supported.", {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Expected image/jpeg or image/png, received "${f.type || "unknown type"}" for "${f.name}".`,
      });
    }
  }

  // Lazy-load pdf-lib so it stays in the /images-to-pdf route chunk only.
  const { PDFDocument } = await import("pdf-lib");

  throwIfAborted(signal);

  const inputSize = allFiles.reduce((sum, f) => sum + f.size, 0);

  // Read one image's bytes, with a uniform DECODE_FAILED on read failure.
  async function readImageBytes(f: File): Promise<ArrayBuffer> {
    try {
      return await f.arrayBuffer();
    } catch (err) {
      throw new ConversionError(`We couldn't read "${f.name}" — the file may be damaged.`, {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Embed one image into `doc` as a single page, laid out per the chosen page
  // size / orientation / margin. Shared by both the merged and per-image paths so
  // the page geometry is identical between them; only document-grouping differs.
  async function embedImagePage(doc: PDFDoc, f: File, bytes: ArrayBuffer): Promise<void> {
    try {
      let img;
      if (f.type === "image/jpeg") {
        img = await doc.embedJpg(new Uint8Array(bytes));
      } else {
        // image/png
        img = await doc.embedPng(new Uint8Array(bytes));
      }

      // Place the image per the chosen page size / orientation / margin.
      const layout = layoutImage(img.width, img.height, pageSize, orientation, marginPt);
      const page = doc.addPage([layout.pageW, layout.pageH]);
      page.drawImage(img, { x: layout.drawX, y: layout.drawY, width: layout.drawW, height: layout.drawH });
    } catch (err) {
      if (err instanceof ConversionError) throw err;
      throw new ConversionError(
        `"${f.name}" could not be embedded — the file may be corrupt or unsupported.`,
        {
          code: "DECODE_FAILED",
          recoverable: false,
          technical: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // ── Per-image: one PDF per image, returned as outputs[] (MultiResultCard). ──
  if (output === "per-image") {
    onProgress?.({ stage: "Creating PDFs", ratio: 0 });

    const outputs: ConversionOutput[] = [];
    // Disambiguate duplicate output names: two images whose names map to the same
    // .pdf (e.g. "a.jpg" and "a.png", or two "a.jpg") get -2, -3, … suffixes so
    // every output filename is unique within the batch.
    const usedNames = new Set<string>();

    for (let i = 0; i < allFiles.length; i++) {
      throwIfAborted(signal);

      const f = allFiles[i];
      onProgress?.({ stage: `Converting image ${i + 1} of ${allFiles.length}`, ratio: i / allFiles.length });

      const bytes = await readImageBytes(f);
      throwIfAborted(signal);

      const doc = await PDFDocument.create();
      await embedImagePage(doc, f, bytes);

      const saved = await doc.save();
      // Copy into a fresh Uint8Array so the underlying buffer is a plain
      // ArrayBuffer (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob requires
      // ArrayBuffer).
      const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });
      outputs.push({
        blob,
        filename: uniqueName(replaceExtension(f.name, "pdf"), usedNames),
        mimeType: "application/pdf",
        size: blob.size,
      });

      onProgress?.({ stage: `Converting image ${i + 1} of ${allFiles.length}`, ratio: (i + 1) / allFiles.length });
    }

    onProgress?.({ stage: "Done", ratio: 1 });

    // result.blob / filename mirror the first output as a representative single-
    // file entry (matches pdf-split.ts), for any code still reading top-level.
    const first = outputs[0];
    return {
      blob: first.blob,
      filename: first.filename,
      mimeType: "application/pdf",
      inputSize,
      outputSize: outputs.reduce((sum, o) => sum + o.size, 0),
      outputs,
    };
  }

  // ── Merged (default): one PDF, every image a page. Byte-identical to the
  // original single-output path — no outputs[], so the UI renders the normal
  // ResultCard with a preview. ──
  onProgress?.({ stage: "Creating PDF", ratio: 0 });

  const out = await PDFDocument.create();

  for (let i = 0; i < allFiles.length; i++) {
    throwIfAborted(signal);

    const f = allFiles[i];
    onProgress?.({ stage: `Embedding image ${i + 1} of ${allFiles.length}`, ratio: i / allFiles.length });

    const bytes = await readImageBytes(f);
    throwIfAborted(signal);

    await embedImagePage(out, f, bytes);

    onProgress?.({ stage: `Embedding image ${i + 1} of ${allFiles.length}`, ratio: (i + 1) / allFiles.length });
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  const saved = await out.save();
  // Copy into a fresh Uint8Array so the underlying buffer is a plain ArrayBuffer
  // (pdf-lib returns Uint8Array<ArrayBufferLike>; Blob requires ArrayBuffer).
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  return {
    blob,
    filename: "images.pdf",
    mimeType: "application/pdf",
    inputSize,
    outputSize: blob.size,
  };
}

export const imagesToPdfDescriptor: ConversionDescriptor = {
  id: "images-to-pdf",
  fromLabel: "Images",
  toLabel: "PDF",
  accept: ["image/jpeg", "image/png"],
  newExtension: "pdf",
  inputMode: "multi",
  // A single image is a valid one-page PDF (the engine only errors below 1), so
  // opt the staging flow down from the default 2. PDF Merge omits this and keeps
  // the ≥2 default.
  minInputs: 1,
  // Defaults reproduce the original output: one page exactly the size of each
  // image, no margin. The controls let the user fit images onto standard pages.
  defaultOptions: { pageSize: "fit", orientation: "auto", margin: "none", output: "merged" },
  controls: [
    {
      type: "select",
      id: "output",
      label: "Output",
      help: "One PDF combines every image into a single document. One PDF per image gives you a separate PDF per file, downloadable together as a zip.",
      default: "merged",
      options: [
        { value: "merged", label: "One PDF" },
        { value: "per-image", label: "One PDF per image" },
      ],
    },
    {
      type: "select",
      id: "pageSize",
      label: "Page size",
      help: "Fit makes each page exactly the image size. A standard size places every image on that page, centred.",
      default: "fit",
      options: [
        { value: "fit", label: "Fit to image" },
        { value: "a4", label: "A4" },
        { value: "letter", label: "US Letter" },
        { value: "legal", label: "US Legal" },
        { value: "a3", label: "A3" },
        { value: "a5", label: "A5" },
      ],
    },
    {
      type: "select",
      id: "orientation",
      label: "Orientation",
      help: "Auto matches each image (landscape images get a landscape page). Ignored when page size is Fit to image.",
      default: "auto",
      options: [
        { value: "auto", label: "Auto" },
        { value: "portrait", label: "Portrait" },
        { value: "landscape", label: "Landscape" },
      ],
    },
    {
      type: "select",
      id: "margin",
      label: "Margin",
      help: "White space around each image.",
      default: "none",
      options: [
        { value: "none", label: "None" },
        { value: "small", label: "Small" },
        { value: "big", label: "Big" },
      ],
    },
  ],
  convert: convertImagesToPdf,
};
